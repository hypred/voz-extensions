import { join } from "node:path";
import { lines, parseSnapshot, snapshotIsFresh } from "./detection";

if (process.platform !== "darwin") {
  console.error("Run this check on an Apple Silicon Mac with the Command Line Tools installed.");
  process.exit(1);
}

const build = Bun.spawn([process.execPath, "run", "build"], { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) throw new Error("The native helper did not build.");

const child = Bun.spawn([join(import.meta.dir, "meeting-rec"), "--watch", "--processes"], {
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
});
let requested = false;
let verified = false;
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
try {
  for await (const line of lines(child.stdout)) {
    const snapshot = parseSnapshot(line);
    if (!snapshotIsFresh(snapshot)) throw new Error("The native helper emitted stale state.");
    if (!requested) {
      requested = true;
      child.stdin.write(JSON.stringify({ refresh: 1 }) + "\n");
      await child.stdin.flush();
    } else if (snapshot.request === 1 && !verified) {
      verified = true;
      child.stdin.end();
    }
  }
  const code = await child.exited;
  if (timedOut || !verified || code !== 0) throw new Error("Native refresh or EOF shutdown check failed.");
  console.log("Native build, timestamp freshness, requested recheck and EOF shutdown passed. No audio was recorded.");
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
  await child.exited;
}
