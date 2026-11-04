import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, ExtensionAPI } from "./voz.d";
import type { AudioApp, BrowserPage } from "./detection";

mock.module(join(import.meta.dir, "voz.d.ts"), () => ({ defineExtension: (extension: unknown) => extension }));
const { default: extension } = await import("./index");

function subprocess() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let resolveExit: (code: number) => void;
  const child = {
    stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    stdin: { write: mock((_text: string) => 0), flush: mock(() => 0) },
    stderr: new Blob([]).stream(),
    exited: new Promise<number>(resolve => { resolveExit = resolve; }),
    exitCode: null as number | null,
    pid: 123456,
    unref() {},
    write(text: string) { if (!closed) controller.enqueue(new TextEncoder().encode(text)); },
    end() {
      if (closed) return;
      closed = true;
      child.exitCode = 0;
      controller.close();
      resolveExit(0);
    },
    kill: mock(() => child.end()),
  };
  return child;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const zoom: AudioApp = { bundleID: "us.zoom.xos", input: true, output: true };
const page = (id = "a".repeat(64)): BrowserPage => ({ id, host: "meet.google.com", end: true, leave: false, microphone: true });
const browser = (pages: BrowserPage[] = []): AudioApp => ({ bundleID: "com.google.Chrome", input: true, output: true, pages });
let root: string;
let watcher: ReturnType<typeof subprocess>;
let prompts: ReturnType<typeof subprocess>[];
let recordings: ReturnType<typeof subprocess>[];
let action: Action;
let now: number;
let watcherArguments: string[];

function loadExtension(overrides: Record<string, unknown> = {}) {
  extension({
    paths: { data: root },
    settings(schema: Record<string, { default: unknown }>) {
      expect(schema.suggest!.default).toBe(true);
      expect(schema.suggestBrowsers!.default).toBe(true);
      return { ...Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, value.default])), folder: join(root, "audio"), ...overrides };
    },
    registerAction(value: Action) { action = value; },
  } as unknown as ExtensionAPI);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "voz-meeting-test-"));
  now = 0;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
  watcher = subprocess();
  prompts = [];
  recordings = [];
  spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
    if (args[1] === "--watch") {
      expect(args.slice(1, 3)).toEqual(["--watch", "--processes"]);
      watcherArguments = args.slice(1);
      return watcher;
    }
    const child = subprocess();
    if (args[0]!.endsWith("osascript")) {
      if (args[2]!.startsWith("display dialog")) prompts.push(child);
      else child.end();
    } else recordings.push(child);
    return child;
  }) as unknown as typeof Bun.spawn);
  loadExtension();
});

afterEach(async () => {
  watcher.end();
  for (const child of [...prompts, ...recordings]) child.end();
  await flush();
  mock.restore();
  rmSync(root, { recursive: true, force: true });
});

async function sample(apps: AudioApp[], at: number, request?: number, capturedAt = at) {
  now = at;
  watcher.write(JSON.stringify({ version: 2, capturedAt, apps, request }) + "\n");
  await flush();
}

function requestedRefresh(): number {
  const writes = watcher.stdin.write.mock.calls;
  return JSON.parse(writes.at(-1)![0]).refresh;
}

test("the extension ignores Voz dictation while a meeting app only plays audio", async () => {
  const apps = [{ ...zoom, input: false }, { bundleID: "com.joelheile.voz", input: true, output: true }];
  await sample(apps, 0);
  await sample(apps, 60_000);
  expect(prompts).toHaveLength(0);
  expect(action.hotkey).toBe("ctrl+opt+m");
});

test("browser hints are enabled but require call controls and close when those disappear", async () => {
  const idle = browser();
  expect(watcherArguments).toEqual(["--watch", "--processes"]);
  await sample([idle], 0);
  await sample([idle], 60_000);
  expect(prompts).toHaveLength(0);
  await sample([browser([page()])], 61_000);
  await sample([browser([page()])], 81_000);
  expect(prompts).toHaveLength(1);
  await sample([idle], 82_000);
  expect(prompts[0]!.kill).toHaveBeenCalledTimes(1);
  await sample([browser([page()])], 100_000);
  await sample([browser([page()])], 120_000);
  expect(prompts).toHaveLength(1);
  expect(recordings).toHaveLength(0);
});

test("disabling browser hints disables native UI scanning and rejects browser calls", async () => {
  watcher.end();
  await flush();
  watcher = subprocess();
  loadExtension({ suggestBrowsers: false });
  expect(watcherArguments).toEqual(["--watch", "--processes", "--no-browser-controls"]);
  await sample([browser([page()])], 0);
  await sample([browser([page()])], 60_000);
  expect(prompts).toHaveLength(0);
  await sample([zoom], 61_000);
  await sample([zoom], 81_000);
  expect(prompts).toHaveLength(1);
});

test("a qualifying call prompts once and accepting starts one recording", async () => {
  await sample([zoom], 0);
  await sample([zoom], 20_000);
  expect(prompts).toHaveLength(1);
  prompts[0]!.write("button returned:Record\n");
  prompts[0]!.end();
  await flush();
  expect(recordings).toHaveLength(0);
  await sample([zoom], 21_000, requestedRefresh());
  await sample([zoom], 60_000);
  expect(recordings).toHaveLength(1);
  expect(prompts).toHaveLength(1);
});

test("accepting a browser hint requires an acknowledged fresh snapshot of the same meeting page", async () => {
  const call = browser([page()]);
  await sample([call], 0);
  await sample([call], 20_000);
  prompts[0]!.write("button returned:Record\n");
  prompts[0]!.end();
  await flush();
  const request = requestedRefresh();
  await sample([call], 21_000);
  await sample([call], 21_100, request + 1);
  expect(recordings).toHaveLength(0);
  await sample([call], 21_200, request);
  expect(recordings).toHaveLength(1);
});

test("navigating to another meeting after clicking Record cannot record the new meeting", async () => {
  await sample([browser([page()])], 0);
  await sample([browser([page()])], 20_000);
  prompts[0]!.write("button returned:Record\n");
  prompts[0]!.end();
  await flush();
  await sample([browser([page("b".repeat(64))])], 21_000, requestedRefresh());
  expect(recordings).toHaveLength(0);
  await sample([browser([page("b".repeat(64))])], 41_000);
  expect(prompts).toHaveLength(2);
});

test("leaving a browser call during verification fails closed even if playback continues", async () => {
  await sample([browser([page()])], 0);
  await sample([browser([page()])], 20_000);
  prompts[0]!.write("button returned:Record\n");
  prompts[0]!.end();
  await flush();
  await sample([browser()], 21_000, requestedRefresh());
  expect(recordings).toHaveLength(0);
});

test("a stale refresh acknowledgment cannot start a recording", async () => {
  const call = browser([page()]);
  await sample([call], 0);
  await sample([call], 20_000);
  prompts[0]!.write("button returned:Record\n");
  prompts[0]!.end();
  await flush();
  await sample([call], 25_000, requestedRefresh(), 20_000);
  expect(recordings).toHaveLength(0);
});

test("manual recording cancels an accepted hint that is still waiting for verification", async () => {
  const call = browser([page()]);
  await sample([call], 0);
  await sample([call], 20_000);
  prompts[0]!.write("button returned:Record\n");
  prompts[0]!.end();
  await flush();
  const request = requestedRefresh();
  const context = { notify: mock(() => {}) } as unknown as Parameters<Action["run"]>[0];
  await action.run(context);
  await sample([call], 21_000, request);
  expect(recordings).toHaveLength(1);
});

test("queued old browser snapshots cannot prompt after a stalled host resumes", async () => {
  const call = browser([page()]);
  await sample([call], 0);
  await sample([call], 25_000, undefined, 19_000);
  expect(prompts).toHaveLength(0);
  await sample([call], 25_001);
  await sample([call], 45_001);
  expect(prompts).toHaveLength(1);
});

test("a private meeting host needs an explicit setting before it can prompt", async () => {
  const call = browser([{ ...page(), host: "meet.example.org" }]);
  await sample([call], 0);
  await sample([call], 20_000);
  expect(prompts).toHaveLength(0);
  watcher.end();
  await flush();
  watcher = subprocess();
  loadExtension({ meetingSites: "meet.example.org" });
  await sample([call], 21_000);
  await sample([call], 41_000);
  expect(prompts).toHaveLength(1);
});

test("watcher EOF dismisses a pending dialog", async () => {
  await sample([zoom], 0);
  await sample([zoom], 20_000);
  watcher.end();
  await flush();
  expect(prompts[0]!.kill).toHaveBeenCalledTimes(1);
  expect(recordings).toHaveLength(0);
});

test("a stalled watcher cancels its dialog and cannot use stale detection", async () => {
  await sample([zoom], 0);
  await sample([zoom], 20_000);
  const realTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    if (delay === 5000) expire = callback;
    return realTimeout(callback, delay);
  }) as typeof setTimeout);
  await sample([zoom], 21_000);
  expect(expire).toBeDefined();
  expire!();
  await flush();
  expect(watcher.kill).toHaveBeenCalledTimes(1);
  expect(prompts[0]!.kill).toHaveBeenCalledTimes(1);
  expect(recordings).toHaveLength(0);
});

test("a late dialog answer cannot start recording a later call", async () => {
  await sample([zoom], 0);
  await sample([zoom], 20_000);
  const old = prompts[0]!;
  // Simulate an already-delivered response racing cancellation.
  old.kill.mockImplementation(() => {});
  await sample([], 21_000);
  expect(old.kill).toHaveBeenCalledTimes(1);
  await sample([zoom], 31_000);
  old.write("button returned:Record\n");
  old.end();
  await flush();
  expect(recordings).toHaveLength(0);
  await sample([zoom], 51_000);
  expect(prompts).toHaveLength(2);
});

test("manual start dismisses the dialog and concurrent starts cannot duplicate recordings", async () => {
  await sample([zoom], 0);
  await sample([zoom], 20_000);
  let finish: (value: undefined) => void;
  spyOn(Bun, "sleep").mockReturnValue(new Promise(resolve => { finish = resolve; }) as never);
  const context = { notify: mock(() => {}) } as unknown as Parameters<Action["run"]>[0];
  const first = action.run(context);
  const second = action.run(context);
  expect(recordings).toHaveLength(1);
  expect(prompts[0]!.kill).toHaveBeenCalledTimes(1);
  finish!(undefined);
  await Promise.all([first, second]);
  expect(recordings).toHaveLength(1);
});

test("legacy unversioned watcher output fails closed and leaves the manual action available", async () => {
  watcher.write("1\n");
  await flush();
  expect(watcher.kill).toHaveBeenCalled();
  expect(prompts).toHaveLength(0);
  expect(recordings).toHaveLength(0);
  expect(typeof action.run).toBe("function");
});
