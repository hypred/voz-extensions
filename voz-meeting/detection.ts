import configuration from "./detection-config.json";

export type BrowserPage = { id: string; host: string; end: boolean; leave: boolean; microphone: boolean };
export type AudioApp = { bundleID: string; input: boolean; output: boolean; inCall?: boolean; pages?: BrowserPage[] };
export type AudioSnapshot = { version: 2; capturedAt: number; apps: AudioApp[]; request?: number };

const callApps = new Set(Object.keys(configuration.nativeApps));
const browsers = new Set(Object.keys(configuration.browsers));
const controlRequired = new Set([...browsers, ...configuration.callControlApps]);

export function parseSnapshot(line: string): AudioSnapshot {
  const snapshot = JSON.parse(line);
  if (snapshot?.version !== 2 || !Array.isArray(snapshot.apps) || snapshot.apps.length > 256
    || !Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < 0
    || (snapshot.request !== undefined && (!Number.isSafeInteger(snapshot.request) || snapshot.request < 1))
    || !snapshot.apps.every((app: any) =>
    app && typeof app.bundleID === "string" && typeof app.input === "boolean" && typeof app.output === "boolean"
      && (app.inCall === undefined || typeof app.inCall === "boolean")
      && (app.pages === undefined || (Array.isArray(app.pages) && app.pages.length <= 64 && app.pages.every((page: any) =>
        page && typeof page.id === "string" && /^[a-f0-9]{64}$/.test(page.id) && typeof page.host === "string"
          && typeof page.end === "boolean" && typeof page.leave === "boolean" && typeof page.microphone === "boolean",
      ))),
  )) throw new Error("Unsupported meeting detector output. Rebuild meeting-rec on macOS.");
  return snapshot;
}

export function snapshotIsFresh(snapshot: AudioSnapshot, now = Date.now()): boolean {
  const age = now - snapshot.capturedAt;
  return age >= -1000 && age <= 4000;
}

function meetingHost(host: string): string | undefined {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized.length <= 253 && normalized.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? normalized : undefined;
}

export function browserPageIsCall(page: BrowserPage, customSites: string[] = []): boolean {
  const host = meetingHost(page.host);
  return !!host && page.microphone && (page.end || page.leave)
    && [...configuration.meetingSites, ...customSites].some(site => {
      const allowed = meetingHost(site.trim());
      return allowed && (host === allowed || host.endsWith(`.${allowed}`));
    });
}

export function callCandidates(apps: AudioApp[], includeBrowsers = true, customSites: string[] = []): string[] {
  const grouped = new Map<string, AudioApp>();
  for (const app of apps) {
    if (!callApps.has(app.bundleID) && !(includeBrowsers && browsers.has(app.bundleID))) continue;
    const previous = grouped.get(app.bundleID);
    grouped.set(app.bundleID, {
      bundleID: app.bundleID, input: app.input || !!previous?.input, output: app.output || !!previous?.output,
      inCall: app.inCall === true || previous?.inCall === true,
      pages: [...(previous?.pages ?? []), ...(app.pages ?? [])],
    });
  }
  return [...new Set([...grouped.values()].flatMap(app => {
    if (!app.input || !app.output) return [];
    if (browsers.has(app.bundleID)) return (app.pages ?? []).filter(page => browserPageIsCall(page, customSites))
      .map(page => `${app.bundleID}/${page.id}`);
    return !controlRequired.has(app.bundleID) || app.inCall ? [app.bundleID] : [];
  }))].sort();
}

// Pipe chunks need not align with lines, even when the writer emits one snapshot at a time.
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (line) yield line;
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield pending.trim();
}

export type CallSession = { id: string; app: string; since?: number; inactiveSince?: number; suggested: boolean };

export class MeetingDetector {
  private sessions = new Map<string, CallSession>();
  private current?: CallSession;

  update(candidates: string[], now = Date.now(), microphoneApps = candidates.map(id => id.split("/")[0]!)): CallSession | undefined {
    for (const [id, session] of this.sessions) {
      if (session.inactiveSince !== undefined && now - session.inactiveSince >= 10_000) {
        this.sessions.delete(id);
      } else if (!candidates.includes(id)) {
        // Keep declined tabs suppressed when switching tabs or hiding a call toolbar.
        if (microphoneApps.includes(session.app)) session.inactiveSince = undefined;
        else session.inactiveSince ??= now;
        session.since = undefined;
      }
    }
    for (const id of candidates) {
      let session = this.sessions.get(id);
      if (!session) {
        if (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!);
        session = { id, app: id.split("/")[0]!, since: now, suggested: false };
        this.sessions.set(id, session);
      }
      session.since ??= now;
      session.inactiveSince = undefined;
    }
    const id = candidates.find(id => id === this.current?.id) ?? candidates[0];
    this.current = id ? this.sessions.get(id) : undefined;
    const session = this.current;
    if (session && !session.suggested && now - session.since! >= 20_000) {
      session.suggested = true;
      return session;
    }
  }

  isActive(session: CallSession): boolean {
    return this.sessions.get(session.id) === session && session.since !== undefined;
  }

  suppress() {
    for (const session of this.sessions.values()) session.suggested = true;
  }

  reset() {
    this.sessions.clear();
    this.current = undefined;
  }
}

// Only a snapshot explicitly requested after acceptance may authorize a recording.
export class SnapshotVerifier {
  private sequence = 0;
  private pending?: { request: number; session: CallSession; finish: (valid: boolean) => void };

  constructor(private request: (id: number) => void | Promise<unknown>, private isActive: (session: CallSession) => boolean) {}

  verify(session: CallSession): Promise<boolean> {
    this.cancel();
    return new Promise(resolve => {
      const request = ++this.sequence;
      const timer = setTimeout(() => this.cancel(), 5000);
      const finish = (valid: boolean) => {
        clearTimeout(timer);
        this.pending = undefined;
        resolve(valid);
      };
      this.pending = { request, session, finish };
      try {
        Promise.resolve(this.request(request)).catch(() => {
          if (this.pending?.request === request) this.cancel();
        });
      } catch { this.cancel(); }
    });
  }

  update(snapshot: AudioSnapshot) {
    const pending = this.pending;
    if (pending && snapshot.request === pending.request) pending.finish(this.isActive(pending.session));
  }

  cancel() {
    this.pending?.finish(false);
  }
}
