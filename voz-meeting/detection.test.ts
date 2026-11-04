import { describe, expect, test } from "bun:test";
import { browserPageIsCall, callCandidates, lines, MeetingDetector, parseSnapshot, snapshotIsFresh, SnapshotVerifier, type AudioApp, type BrowserPage } from "./detection";

const zoom = "us.zoom.xos";
const teams = "com.microsoft.teams2";
const chrome = "com.google.Chrome";
const app = (bundleID: string, input = true, output = true): AudioApp => ({ bundleID, input, output });
const page = (id = "a".repeat(64), values: Partial<BrowserPage> = {}): BrowserPage => ({ id, host: "meet.google.com", end: true, leave: false, microphone: true, ...values });
const browserID = `${chrome}/${page().id}`;

describe("call attribution", () => {
  test("long Voz dictation with another app playing audio is not a call", () => {
    expect(callCandidates([app("com.joelheile.voz"), app(zoom, false), app(chrome, false)])).toEqual([]);
  });

  test("microphone-only capture and output-only playback do not qualify", () => {
    expect(callCandidates([app(zoom, true, false)])).toEqual([]);
    expect(callCandidates([app(teams, false, true)])).toEqual([]);
    expect(callCandidates([app(zoom, true, false), app(teams, false, true)])).toEqual([]);
  });

  test("both directions must belong to the same supported application", () => {
    expect(callCandidates([app(zoom), app(teams)])).toEqual([teams, zoom]);
    expect(callCandidates([app("unknown.recorder")])).toEqual([]);
    expect(callCandidates([app("us.zoom.xos.unverified-helper")])).toEqual([]);
  });

  test("helpers resolved to the same application can provide separate directions", () => {
    expect(callCandidates([app(teams, true, false), app(teams, false, true)])).toEqual([teams]);
  });

  test("browser dictation and unrelated playback do not qualify without call controls", () => {
    expect(callCandidates([app(chrome)])).toEqual([]);
    expect(callCandidates([{ ...app(chrome), inCall: false }])).toEqual([]);
    expect(callCandidates([{ ...app(chrome), inCall: true }])).toEqual([]);
    expect(callCandidates([{ ...app(chrome), pages: [page()] }])).toEqual([browserID]);
  });

  test("call controls alone cannot replace attributable two-way audio", () => {
    expect(callCandidates([{ ...app(chrome, true, false), pages: [page()] }, app(zoom, false)])).toEqual([]);
    expect(callCandidates([{ ...app(chrome, false, true), pages: [page()] }])).toEqual([]);
    expect(callCandidates([{ ...app(chrome, true, false), pages: [page()] }, app("com.apple.Safari", false)])).toEqual([]);
    expect(callCandidates([{ ...app("unknown.browser"), pages: [page()] }])).toEqual([]);
  });

  test("browser detection can be disabled without affecting native calls", () => {
    expect(callCandidates([{ ...app(chrome), pages: [page()] }, app(zoom)], false)).toEqual([zoom]);
  });

  test("also recognizes calls in Signal, WhatsApp, Telegram, GoTo and RingCentral", () => {
    const ids = ["org.whispersystems.signal-desktop", "net.whatsapp.WhatsApp", "ru.keepcoder.Telegram", "com.tdesktop.Telegram", "org.telegram.desktop", "com.logmein.goto", "com.ringcentral.glip"];
    expect(callCandidates(ids.map(id => ({ ...app(id), inCall: true })))).toEqual([...ids].sort());
    expect(callCandidates(ids.map(id => app(id, true, false)))).toEqual([]);
  });

  test("messenger voice notes with playback do not qualify without a call control", () => {
    const ids = ["com.tinyspeck.slackmacgap", "com.hnc.Discord", "org.whispersystems.signal-desktop", "net.whatsapp.WhatsApp", "ru.keepcoder.Telegram", "com.tdesktop.Telegram", "org.telegram.desktop"];
    expect(callCandidates(ids.map(id => app(id)))).toEqual([]);
    expect(callCandidates(ids.map(id => ({ ...app(id), inCall: true })))).toEqual([...ids].sort());
  });

  test("covers the major browser engines and their separate release channels", () => {
    const ids = ["com.apple.Safari", "com.google.Chrome.beta", "com.microsoft.edgemac.Canary", "org.mozilla.firefoxdeveloperedition", "com.brave.Browser.nightly", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "com.kagi.kagimacOS", "company.thebrowser.Browser", "app.zen-browser.zen", "com.duckduckgo.macos.browser"];
    expect(callCandidates(ids.map(id => app(id)))).toEqual([]);
    expect(callCandidates(ids.map(id => ({ ...app(id), pages: [page()] })))).toEqual(ids.map(id => `${id}/${page().id}`).sort());
  });
});

describe("browser page evidence", () => {
  test("pre-join pages and an isolated leave button do not qualify", () => {
    expect(browserPageIsCall(page(undefined, { end: false }))).toBe(false);
    expect(browserPageIsCall(page(undefined, { microphone: false }))).toBe(false);
    expect(browserPageIsCall(page(undefined, { end: false, leave: true }))).toBe(true);
  });

  test("leave and microphone controls from different tabs cannot be pooled", () => {
    const pages = [page(undefined, { microphone: false }), page("b".repeat(64), { end: false })];
    expect(callCandidates([{ ...app(chrome), pages }])).toEqual([]);
  });

  test("an arbitrary site with call-like controls is not trusted automatically", () => {
    for (const host of ["example.org", "meet.google.com.evil.test", "notzoom.us", "zoom.us@evil.test", "zoom.us/path"]) {
      expect(browserPageIsCall(page(undefined, { host }))).toBe(false);
    }
    expect(browserPageIsCall(page(undefined, { host: "company.zoom.us" }))).toBe(true);
    expect(browserPageIsCall(page(undefined, { host: "MEET.GOOGLE.COM." }))).toBe(true);
  });

  test("private meeting hosts require explicit configuration and the same call evidence", () => {
    const privatePage = page(undefined, { host: "meet.example.org" });
    expect(browserPageIsCall(privatePage)).toBe(false);
    expect(browserPageIsCall(privatePage, [" meet.example.org "])).toBe(true);
    expect(browserPageIsCall({ ...privatePage, microphone: false }, ["meet.example.org"])).toBe(false);
    expect(browserPageIsCall(page(undefined, { host: "meet.example.org.evil.test" }), ["meet.example.org"])).toBe(false);
    expect(browserPageIsCall(privatePage, ["https://meet.example.org", "*"])).toBe(false);
  });
});

describe("suggestion sessions", () => {
  test("waits for twenty continuous seconds and asks only once", () => {
    const detector = new MeetingDetector();
    expect(detector.update([zoom], 0)).toBeUndefined();
    expect(detector.update([zoom], 19_999)).toBeUndefined();
    expect(detector.update([zoom], 20_000)?.app).toBe(zoom);
    expect(detector.update([zoom], 120_000)).toBeUndefined();
  });

  test("short microphone use does not accumulate into a call", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    detector.update([], 15_000);
    expect(detector.update([zoom], 16_000)).toBeUndefined();
    expect(detector.update([zoom], 35_999)).toBeUndefined();
    expect(detector.update([zoom], 36_000)?.app).toBe(zoom);
  });

  test("brief muting after a declined prompt does not ask again", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    detector.update([zoom], 20_000);
    detector.update([], 25_000);
    expect(detector.update([zoom], 30_000)).toBeUndefined();
    expect(detector.update([zoom], 100_000)).toBeUndefined();
  });

  test("a new call can ask after ten seconds without a qualifying call", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    const old = detector.update([zoom], 20_000)!;
    detector.update([], 25_000);
    detector.update([zoom], 35_000);
    const next = detector.update([zoom], 55_000)!;
    expect(next).not.toBe(old);
    expect(detector.isActive(old)).toBe(false);
    expect(detector.isActive(next)).toBe(true);
  });

  test("ending a call immediately invalidates its dialog answer", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    const session = detector.update([zoom], 20_000)!;
    detector.update([], 21_000);
    expect(detector.isActive(session)).toBe(false);
  });

  test("changing applications restarts the delay and invalidates old answers", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    const session = detector.update([zoom], 20_000)!;
    expect(detector.update([teams], 21_000)).toBeUndefined();
    expect(detector.isActive(session)).toBe(false);
    expect(detector.update([teams], 40_999)).toBeUndefined();
    expect(detector.update([teams], 41_000)?.app).toBe(teams);
  });

  test("a second qualifying application does not interrupt the current call", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    const session = detector.update([zoom], 20_000)!;
    expect(detector.update([teams, zoom], 21_000)).toBeUndefined();
    expect(detector.isActive(session)).toBe(true);
  });

  test("manual recording suppresses later prompts for the same call", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    detector.suppress();
    expect(detector.update([zoom], 20_000)).toBeUndefined();
  });

  test("watcher termination clears session identity", () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    const session = detector.update([zoom], 20_000)!;
    detector.reset();
    expect(detector.isActive(session)).toBe(false);
    expect(detector.update([zoom], 25_000)).toBeUndefined();
  });

  test("leaving a browser meeting invalidates the dialog even if browser audio continues", () => {
    const detector = new MeetingDetector();
    const browserCall = { ...app(chrome), pages: [page()] };
    detector.update(callCandidates([browserCall]), 0);
    const session = detector.update(callCandidates([browserCall]), 20_000)!;
    detector.update(callCandidates([app(chrome)]), 21_000);
    expect(detector.isActive(session)).toBe(false);
  });

  test("hidden call controls do not rearm hints while the same app keeps using the microphone", () => {
    const detector = new MeetingDetector();
    detector.update([chrome], 0);
    const session = detector.update([chrome], 20_000)!;
    detector.update([], 21_000, [chrome]);
    expect(detector.isActive(session)).toBe(false);
    detector.update([], 50_000, [chrome]);
    expect(detector.update([chrome], 60_000)).toBeUndefined();
    expect(detector.update([chrome], 80_000)).toBeUndefined();
    detector.update([], 81_000, []);
    detector.update([chrome], 91_000);
    const next = detector.update([chrome], 111_000);
    expect(next).toBeDefined();
    expect(next).not.toBe(session);
  });

  test("switching meeting pages invalidates old answers but remembers a declined tab", () => {
    const detector = new MeetingDetector();
    const first = browserID;
    const second = `${chrome}/${"b".repeat(64)}`;
    detector.update([first], 0);
    const original = detector.update([first], 20_000)!;
    detector.update([second], 21_000, [chrome]);
    expect(detector.isActive(original)).toBe(false);
    expect(detector.update([second], 41_000, [chrome])?.id).toBe(second);
    detector.update([first], 42_000, [chrome]);
    expect(detector.update([first], 62_000, [chrome])).toBeUndefined();
    expect(detector.isActive(original)).toBe(true);
  });
});

describe("fresh acceptance checks", () => {
  test("queued or unrelated snapshots cannot authorize a recording", async () => {
    const detector = new MeetingDetector();
    detector.update([browserID], 0);
    const session = detector.update([browserID], 20_000)!;
    let request = 0;
    const verifier = new SnapshotVerifier(id => { request = id; }, value => detector.isActive(value));
    let resolved = false;
    const answer = verifier.verify(session).then(value => { resolved = true; return value; });
    verifier.update({ version: 2, capturedAt: 0, apps: [] });
    verifier.update({ version: 2, capturedAt: 0, apps: [], request: request + 1 });
    await Promise.resolve();
    expect(resolved).toBe(false);
    verifier.update({ version: 2, capturedAt: 0, apps: [], request });
    expect(await answer).toBe(true);
  });

  test("a fresh snapshot of another page rejects the old acceptance", async () => {
    const detector = new MeetingDetector();
    detector.update([browserID], 0);
    const session = detector.update([browserID], 20_000)!;
    let request = 0;
    const verifier = new SnapshotVerifier(id => { request = id; }, value => detector.isActive(value));
    const answer = verifier.verify(session);
    detector.update([`${chrome}/${"b".repeat(64)}`], 21_000, [chrome]);
    verifier.update({ version: 2, capturedAt: 0, apps: [], request });
    expect(await answer).toBe(false);
  });

  test("manual start, watcher termination and request failures fail closed", async () => {
    const detector = new MeetingDetector();
    detector.update([zoom], 0);
    const session = detector.update([zoom], 20_000)!;
    const verifier = new SnapshotVerifier(() => {}, value => detector.isActive(value));
    const answer = verifier.verify(session);
    verifier.cancel();
    expect(await answer).toBe(false);
    const failed = new SnapshotVerifier(() => { throw new Error("closed pipe"); }, () => true);
    expect(await failed.verify(session)).toBe(false);
  });
});

describe("helper protocol", () => {
  test("rejects stale and implausibly future snapshots", () => {
    const snapshot = { version: 2 as const, capturedAt: 10_000, apps: [] };
    expect(snapshotIsFresh(snapshot, 10_001)).toBe(true);
    expect(snapshotIsFresh(snapshot, 14_001)).toBe(false);
    expect(snapshotIsFresh(snapshot, 8_999)).toBe(false);
  });

  test("requires versioned, typed application state", () => {
    expect(parseSnapshot(JSON.stringify({ version: 2, capturedAt: 0, apps: [app(zoom)] })).apps).toEqual([app(zoom)]);
    for (const line of ["1", "0", "null", '{"version":1,"apps":[]}', '{"version":2,"capturedAt":0,"apps":[{"bundleID":"us.zoom.xos","input":1,"output":true}]}', JSON.stringify({ version: 2, capturedAt: 0, apps: [{ ...app(chrome), inCall: "yes" }] }), JSON.stringify({ version: 2, capturedAt: 0, apps: [{ ...app(chrome), pages: [page("bad-token")] }] }), JSON.stringify({ version: 2, capturedAt: 0, request: 1.5, apps: [] })]) {
      expect(() => parseSnapshot(line)).toThrow();
    }
  });

  test("split and combined chunks preserve all start and stop records", async () => {
    const chunks = ['{"version":2,"capturedAt":0,"ap', 'ps":[]}\n{"version":2,"capturedAt":0,"apps":[', JSON.stringify(app(zoom)), ']}\n{"version":2,"capturedAt":0,"apps":[]}\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const snapshots: AudioApp[][] = [];
    for await (const line of lines(stream)) snapshots.push(parseSnapshot(line).apps);
    expect(snapshots).toEqual([[], [app(zoom)], []]);
  });
});
