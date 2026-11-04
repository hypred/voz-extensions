import { defineExtension, type Context } from "voz";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { callCandidates, lines, MeetingDetector, parseSnapshot, snapshotIsFresh, SnapshotVerifier, type CallSession } from "./detection";

const recorder = join(import.meta.dir, "meeting-rec");
const vozBinary = "/Applications/voz.app/Contents/MacOS/voz";
const vozDatabase = join(homedir(), "Library/Application Support/Voz/history.sqlite");

type Recording = { pid: number; name: string; audio: string; started?: number };

const osascript = (script: string) => Bun.spawn(["/usr/bin/osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
const banner = (text: string) => osascript(`display notification ${JSON.stringify(text)} with title "Voz"`);

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Voz keeps its dictionary in its history database; boost those words in meetings too
function vocabulary(): string[] {
  try {
    const database = new Database(vozDatabase, { readonly: true });
    const words = database.query("select word from vocabulary").all().map((row: any) => String(row.word));
    database.close();
    return words;
  } catch {
    return [];
  }
}

export default defineExtension((voz) => {
  const settings = voz.settings({
    hotkey: { type: "string", title: "Hotkey", description: "Starts and stops a recording", default: "ctrl+opt+m" },
    folder: { type: "string", title: "Folder", description: "Where transcripts and recordings go", default: join(homedir(), "Documents/Voz Meetings") },
    clipboard: { type: "boolean", title: "Copy transcript to clipboard", default: true },
    suggest: { type: "boolean", title: "Suggest recording meetings", description: "Asks when a supported call app uses both microphone and audio output for 20 seconds", default: true },
    suggestBrowsers: { type: "boolean", title: "Include browser calls", description: "Requires microphone and audio output plus visible call controls. Uses Accessibility access", default: true },
    meetingSites: { type: "string", title: "Additional meeting sites", description: "Comma-separated hostnames for private meeting servers, such as meet.example.org", default: "" },
  });
  // Kept on disk so a running recording survives extension reloads
  const statePath = join(voz.paths.data, "recording.json");
  const detector = new MeetingDetector();
  const meetingSites = settings.meetingSites.split(/[,\s]+/).filter(Boolean);
  let verifier: SnapshotVerifier | undefined;
  let starting = false;
  let prompt: { session: CallSession; process: ReturnType<typeof osascript> } | undefined;

  function dismissSuggestion() {
    const current = prompt;
    prompt = undefined;
    current?.process.kill();
  }

  // Older Voz versions have no activities or transcripts, so every call to them is optional
  const showRecording = (recording: Recording) =>
    voz.showActivity?.({ title: "Recording meeting", since: recording.started, stop: "meeting" });

  async function start(notify: (text: string) => void) {
    if (starting || existsSync(statePath)) return;
    starting = true;
    verifier?.cancel();
    dismissSuggestion();
    detector.suppress();
    try {
      mkdirSync(settings.folder, { recursive: true });
      const name = new Date().toLocaleString("sv-SE").slice(0, 16).replace(" ", "-").replace(":", "");
      const audio = join(settings.folder, `${name}.m4a`);
      const child = Bun.spawn([recorder, audio], { stdout: "ignore", stderr: "pipe" });
      child.unref();
      await Bun.sleep(1000);
      if (child.exitCode !== null) {
        console.log(`Recorder failed: ${await new Response(child.stderr).text()}`);
        return notify("Meeting recording failed");
      }
      const recording = { pid: child.pid, name, audio, started: Date.now() };
      writeFileSync(statePath, JSON.stringify(recording));
      showRecording(recording);
      notify("Recording meeting");
    } finally {
      starting = false;
    }
  }

  async function stop(ctx: Context) {
    const recording: Recording = JSON.parse(readFileSync(statePath, "utf8"));
    rmSync(statePath);
    if (isRunning(recording.pid)) process.kill(recording.pid, "SIGTERM");
    ctx.notify("Transcribing meeting …");
    voz.showActivity?.({ title: "Transcribing meeting" });
    // The handler is over by the time transcription ends, so the result goes to a macOS banner
    transcribe(recording)
      .then((path) => banner(`${settings.clipboard ? "Copied and saved" : "Saved"} ${path.split("/").pop()}`))
      .catch((error) => {
        console.log(`Transcription failed: ${error}`);
        banner("Transcription failed, the recording is in the meeting folder");
      })
      .finally(() => voz.hideActivity?.());
  }

  async function transcribe(recording: Recording) {
    const stopped = Date.now();
    // The recorder mixes both tracks after it stops, which takes a few seconds for long meetings
    while (isRunning(recording.pid)) await Bun.sleep(250);
    if (!existsSync(recording.audio)) throw new Error("No recording");

    const words = vocabulary();
    const run = Bun.spawn([vozBinary, "--transcribe", recording.audio, ...(words.length ? ["--vocab", words.join(",")] : [])], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(run.stdout).text();
    if ((await run.exited) !== 0) throw new Error(await new Response(run.stderr).text());
    const text = output.split("\n").filter((line) => !/^engine .*, transcription [0-9.]+s$/.test(line)).join("\n").trim();

    const path = join(settings.folder, `${recording.name}.md`);
    writeFileSync(path, `# Meeting ${recording.name}\n\n${text}\n`);
    if (text) voz.addTranscript?.({ text, seconds: recording.started && (stopped - recording.started) / 1000 });
    if (settings.clipboard) await Bun.spawn(["/usr/bin/pbcopy"], { stdin: new Blob([text]), env: { LANG: "en_US.UTF-8" } }).exited;
    return path;
  }

  voz.registerAction({
    id: "meeting",
    name: "Record meeting",
    hotkey: settings.hotkey,
    run: (ctx) => (existsSync(statePath) ? stop(ctx) : start(ctx.notify)),
  });
  // Voz ends activities when it reloads extensions, the recording keeps running
  if (existsSync(statePath)) showRecording(JSON.parse(readFileSync(statePath, "utf8")));

  async function suggest(session: CallSession) {
    if (prompt || starting || existsSync(statePath)) return;
    const current = {
      session,
      process: osascript('display dialog "A meeting seems to have started. Record it?" with title "Voz" buttons {"Not now", "Record"} default button "Record" cancel button "Not now" giving up after 60'),
    };
    prompt = current;
    try {
      const answer = await new Response(current.process.stdout).text();
      if (prompt !== current || !detector.isActive(session) || !answer.includes("button returned:Record")) return;
      const verified = await verifier?.verify(session);
      if (prompt !== current || !detector.isActive(session)) return;
      if (!verified) {
        banner("Could not confirm the meeting. Use your meeting hotkey to record manually.");
        return;
      }
      prompt = undefined;
      await start(banner);
    } finally {
      if (prompt === current) prompt = undefined;
    }
  }
  async function watchCalls() {
    // Two flags make old helpers exit with usage instead of treating a new flag as an audio path.
    const watcher = Bun.spawn([recorder, "--watch", "--processes", ...(settings.suggestBrowsers ? [] : ["--no-browser-controls"])], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const errors = new Response(watcher.stderr).text();
    verifier = new SnapshotVerifier(async request => {
      watcher.stdin.write(JSON.stringify({ refresh: request }) + "\n");
      await watcher.stdin.flush();
    }, session => detector.isActive(session));
    let heartbeat: ReturnType<typeof setTimeout>;
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(heartbeat);
      verifier?.cancel();
      detector.reset();
      dismissSuggestion();
      watcher.kill();
    };
    const keepAlive = () => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(cleanup, 5000);
      heartbeat.unref();
    };
    process.once("exit", cleanup);
    keepAlive();
    try {
      for await (const line of lines(watcher.stdout)) {
        if (stopped) break;
        const snapshot = parseSnapshot(line);
        const fresh = snapshotIsFresh(snapshot);
        const apps = fresh ? snapshot.apps : [];
        const session = detector.update(callCandidates(apps, settings.suggestBrowsers, meetingSites), Date.now(), apps.filter(app => app.input).map(app => app.bundleID));
        if (fresh) keepAlive();
        if (prompt && !detector.isActive(prompt.session)) dismissSuggestion();
        verifier.update(snapshot);
        if (starting || existsSync(statePath)) detector.suppress();
        else if (session) suggest(session).catch(() => console.log("Meeting suggestion failed"));
      }
    } finally {
      process.off("exit", cleanup);
      cleanup();
      await watcher.exited;
      const error = await errors;
      if (error) console.log(`Meeting detection stopped: ${error}`);
    }
  }
  if (settings.suggest) watchCalls().catch(() => console.log("Meeting detection unavailable. Rebuild meeting-rec on macOS; manual recording still works."));
});
