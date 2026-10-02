import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The owner's rule (Cospire, 2026-09-26): at or below 7% remaining in the
// lowest window, stop and hand off. "Could not tell" is never "fine".
export const DEFAULT_HANDOFF_THRESHOLD = 7;

export type QuotaState = "ok" | "handoff" | "unknown";
export type QuotaReader = "claude" | "codex" | "none";

export interface QuotaWindow {
  name: string;
  remainingPercent: number;
  resetsAt?: string;
}

export interface QuotaReport {
  agent: string;
  state: QuotaState;
  windows: QuotaWindow[];
  lowest?: QuotaWindow;
  reason?: string;
  source: string;
  observedAt?: string;
  threshold: number;
}

// A usage snapshot only ever under-reports: usage rises until a window resets.
// So an old "exhausted until <reset>" stays true, but an old "plenty left" is a guess.
const FRESH_MINUTES = 15;
// A "credits depleted" report has no reset time; after this long it may have been refilled.
const DEPLETED_TRUST_MINUTES = 60;

function minutesSince(iso: string, now: number): number {
  return (now - Date.parse(iso)) / 60_000;
}

function epochToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : undefined;
}

/** Remaining percent for one window, treating a window whose reset has passed as full. */
function windowFrom(
  name: string,
  usedPercent: unknown,
  resetsAt: string | undefined,
  now: number,
): QuotaWindow | undefined {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  const reset = resetsAt !== undefined && Date.parse(resetsAt) <= now;
  return {
    name,
    remainingPercent: reset ? 100 : Math.round((100 - usedPercent) * 10) / 10,
    resetsAt,
  };
}

/** Apply the threshold rule to a snapshot of windows taken at observedAt. */
export function decideQuota(input: {
  agent: string;
  source: string;
  windows: QuotaWindow[];
  observedAt?: string;
  threshold?: number;
  now?: number;
}): QuotaReport {
  const threshold = input.threshold ?? DEFAULT_HANDOFF_THRESHOLD;
  const now = input.now ?? Date.now();
  const base = { agent: input.agent, source: input.source, observedAt: input.observedAt, threshold };
  if (input.windows.length === 0) {
    return { ...base, state: "unknown", windows: [], reason: "no usage windows were reported" };
  }
  const lowest = input.windows.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
  if (lowest.remainingPercent <= threshold) {
    return {
      ...base,
      state: "handoff",
      windows: input.windows,
      lowest,
      reason: `${lowest.name} window at ${lowest.remainingPercent}% remaining (threshold ${threshold}%)${lowest.resetsAt ? `, resets ${lowest.resetsAt}` : ""}`,
    };
  }
  if (input.observedAt && minutesSince(input.observedAt, now) > FRESH_MINUTES) {
    return {
      ...base,
      state: "unknown",
      windows: input.windows,
      lowest,
      reason: `last reading is ${Math.round(minutesSince(input.observedAt, now))} minutes old; usage may have risen since`,
    };
  }
  return { ...base, state: "ok", windows: input.windows, lowest };
}

// ---------------------------------------------------------------------------
// Codex: read the newest rate-limit event from its local session logs. No
// network and no credentials are involved.
// ---------------------------------------------------------------------------

function newestSessionFiles(root: string, limit: number): string[] {
  const files: Array<{ path: string; mtime: number }> = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 4 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name.endsWith(".jsonl")) files.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((file) => file.path);
}

export function readCodexQuota(options: {
  agent?: string;
  codexHome?: string;
  threshold?: number;
  now?: number;
} = {}): QuotaReport {
  const agent = options.agent ?? "codex";
  const threshold = options.threshold ?? DEFAULT_HANDOFF_THRESHOLD;
  const now = options.now ?? Date.now();
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = "Codex session logs";
  for (const file of newestSessionFiles(join(home, "sessions"), 20)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? "";
      if (!line.includes('"rate_limits"')) continue;
      let event: {
        timestamp?: string;
        payload?: { rate_limits?: Record<string, unknown> };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const limits = event.payload?.rate_limits;
      if (!limits) continue;
      const observedAt = event.timestamp;
      const reached = limits.rate_limit_reached_type;
      if (typeof reached === "string" && reached) {
        const recent = observedAt !== undefined && minutesSince(observedAt, now) <= DEPLETED_TRUST_MINUTES;
        return {
          agent,
          source,
          observedAt,
          threshold,
          windows: [],
          state: recent ? "handoff" : "unknown",
          reason: recent
            ? `Codex reported ${reached.replaceAll("_", " ")}`
            : `Codex last reported ${reached.replaceAll("_", " ")} at ${observedAt}; it may have been refilled since`,
        };
      }
      const windows = (["primary", "secondary"] as const)
        .map((key) => {
          const raw = limits[key] as
            | { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown }
            | null
            | undefined;
          if (!raw) return undefined;
          const name =
            raw.window_minutes === 300
              ? "five-hour"
              : raw.window_minutes === 10080
                ? "weekly"
                : `${String(raw.window_minutes)}-minute`;
          return windowFrom(name, raw.used_percent, epochToIso(raw.resets_at), now);
        })
        .filter((window): window is QuotaWindow => window !== undefined);
      if (windows.length > 0) {
        return decideQuota({ agent, source, windows, observedAt, threshold, now });
      }
    }
  }
  return {
    agent,
    source,
    threshold,
    windows: [],
    state: "unknown",
    reason: "no Codex rate-limit report found in its session logs",
  };
}

// ---------------------------------------------------------------------------
// Claude: a status-line snapshot (official, token-free) with an optional
// fallback to Anthropic's undocumented OAuth usage endpoint when it is stale.
// ---------------------------------------------------------------------------

export function claudeSnapshotPath(): string {
  return process.env.SHARELANE_CLAUDE_USAGE_FILE || join(homedir(), ".sharelane", "usage", "claude.json");
}

interface ClaudeSnapshot {
  capturedAt: string;
  source: "statusline" | "endpoint";
  five_hour?: { used_percentage?: number; resets_at?: number | string } | null;
  seven_day?: { used_percentage?: number; resets_at?: number | string } | null;
  endpointFailure?: { at: string; reason: string };
}

function readSnapshot(path: string): ClaudeSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaudeSnapshot;
  } catch {
    return undefined;
  }
}

export function writeClaudeSnapshot(snapshot: ClaudeSnapshot, path = claudeSnapshotPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function toIso(value: unknown): string | undefined {
  if (typeof value === "string") return Number.isNaN(Date.parse(value)) ? undefined : value;
  return epochToIso(value);
}

function claudeWindows(snapshot: ClaudeSnapshot, now: number): QuotaWindow[] {
  return [
    windowFrom("five-hour", snapshot.five_hour?.used_percentage, toIso(snapshot.five_hour?.resets_at), now),
    windowFrom("weekly", snapshot.seven_day?.used_percentage, toIso(snapshot.seven_day?.resets_at), now),
  ].filter((window): window is QuotaWindow => window !== undefined);
}

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
// The endpoint rate-limits itself (five calls in a minute returned 429), so
// never call it more often than this, successful or not.
const ENDPOINT_MIN_INTERVAL_MINUTES = 5;

/**
 * Ask Anthropic's undocumented usage endpoint. The OAuth token is read into
 * memory, sent only to Anthropic, and never printed, logged, or stored.
 */
async function fetchClaudeUsage(): Promise<
  { ok: true; snapshot: ClaudeSnapshot } | { ok: false; reason: string }
> {
  const credentialsPath = join(homedir(), ".claude", ".credentials.json");
  let token: unknown;
  try {
    token = JSON.parse(readFileSync(credentialsPath, "utf8"))?.claudeAiOauth?.accessToken;
  } catch {
    return { ok: false, reason: "could not read Claude's credentials file" };
  }
  if (typeof token !== "string" || !token) {
    return { ok: false, reason: "no Claude sign-in found; run claude once" };
  }
  try {
    const response = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "Claude's sign-in was refused; run claude once to refresh it" };
    }
    if (response.status === 429) return { ok: false, reason: "the usage endpoint is rate-limited" };
    if (!response.ok) return { ok: false, reason: `the usage endpoint answered ${response.status}` };
    const payload = (await response.json()) as Record<string, { utilization?: number; resets_at?: string } | null>;
    const window = (raw: { utilization?: number; resets_at?: string } | null | undefined) =>
      raw && typeof raw.utilization === "number"
        ? { used_percentage: raw.utilization, resets_at: raw.resets_at }
        : null;
    return {
      ok: true,
      snapshot: {
        capturedAt: new Date().toISOString(),
        source: "endpoint",
        five_hour: window(payload.five_hour),
        seven_day: window(payload.seven_day),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `the usage endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readClaudeQuota(options: {
  agent?: string;
  threshold?: number;
  now?: number;
  allowEndpoint?: boolean;
  snapshotPath?: string;
} = {}): Promise<QuotaReport> {
  const agent = options.agent ?? "claude";
  const threshold = options.threshold ?? DEFAULT_HANDOFF_THRESHOLD;
  const now = options.now ?? Date.now();
  const path = options.snapshotPath ?? claudeSnapshotPath();
  const allowEndpoint =
    options.allowEndpoint ?? process.env.SHARELANE_CLAUDE_USAGE_ENDPOINT !== "0";
  let snapshot = readSnapshot(path);
  const fresh = (value: ClaudeSnapshot | undefined) =>
    value !== undefined && minutesSince(value.capturedAt, now) <= FRESH_MINUTES;

  if (!fresh(snapshot) && allowEndpoint) {
    const lastFailure = snapshot?.endpointFailure?.at;
    const lastEndpoint = snapshot?.source === "endpoint" ? snapshot.capturedAt : undefined;
    const recentCall = [lastFailure, lastEndpoint].some(
      (at) => at !== undefined && minutesSince(at, now) < ENDPOINT_MIN_INTERVAL_MINUTES,
    );
    if (!recentCall) {
      const fetched = await fetchClaudeUsage();
      if (fetched.ok) {
        snapshot = fetched.snapshot;
      } else if (snapshot) {
        snapshot = { ...snapshot, endpointFailure: { at: new Date(now).toISOString(), reason: fetched.reason } };
      } else {
        snapshot = undefined;
        writeClaudeSnapshot(
          { capturedAt: new Date(0).toISOString(), source: "endpoint", endpointFailure: { at: new Date(now).toISOString(), reason: fetched.reason } },
          path,
        );
        return {
          agent,
          threshold,
          source: "Claude usage endpoint",
          windows: [],
          state: "unknown",
          reason: fetched.reason,
        };
      }
      writeClaudeSnapshot(snapshot, path);
    }
  }

  if (!snapshot) {
    return {
      agent,
      threshold,
      source: "Claude status line",
      windows: [],
      state: "unknown",
      reason: "no Claude usage snapshot yet; open an interactive Claude session in this project",
    };
  }
  const report = decideQuota({
    agent,
    source: snapshot.source === "endpoint" ? "Claude usage endpoint" : "Claude status line",
    windows: claudeWindows(snapshot, now),
    observedAt: snapshot.capturedAt,
    threshold,
    now,
  });
  if (report.state === "unknown" && snapshot.endpointFailure) {
    report.reason = `${report.reason}; endpoint fallback: ${snapshot.endpointFailure.reason}`;
  }
  return report;
}

/** Check an agent's remaining allowance with the reader its adapter names. */
export async function checkQuota(
  agent: string,
  reader: QuotaReader | undefined,
  threshold = DEFAULT_HANDOFF_THRESHOLD,
): Promise<QuotaReport> {
  if (reader === "codex") return readCodexQuota({ agent, threshold });
  if (reader === "claude") return readClaudeQuota({ agent, threshold });
  return {
    agent,
    threshold,
    source: "none",
    windows: [],
    state: "unknown",
    reason: `${agent} has no programmatic usage reader; ShareLane relies on detecting its limit errors`,
  };
}

export function describeQuota(report: QuotaReport): string {
  const windows = report.windows
    .map((window) => `${window.name} ${window.remainingPercent}% left`)
    .join(", ");
  const verdict =
    report.state === "ok"
      ? "keep working"
      : report.state === "handoff"
        ? "HAND OFF"
        : "could not tell (not the same as fine)";
  return [
    `${report.agent}: ${verdict}`,
    windows ? `(${windows})` : "",
    report.reason ? `— ${report.reason}` : "",
    `[source: ${report.source}${report.observedAt ? `, observed ${report.observedAt}` : ""}]`,
  ]
    .filter(Boolean)
    .join(" ");
}
