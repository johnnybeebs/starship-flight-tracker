// Port of server/app/ll2_client.py.
//
// Key change for the Workers free tier: fetch with mode=normal (the old
// mode=detailed payload was ~1 MB and JSON.parse alone could blow the 10 ms
// CPU budget). Only the fields the app uses survive into ll2_raw.
//
// The on-disk cache is replaced by D1 meta gating (ll2_synced_at + max-age);
// the request budget is a meta-persisted sliding window (15/hr free tier).

import {
  getMeta,
  getFlight,
  insertSignalStmt,
  listSignals,
  recordNetStmt,
  setMetaStmt,
  upsertFlightStmt,
  utcnow,
} from "./db";
import type { Settings } from "./types";

const FLIGHT_NUM_RE = /(?:(?:Integrated\s+)?Flight(?:\s+Test)?|IFT)\s*-?\s*(?:Test\s*)?#?\s*(\d+)/i;
// "Starship | Integrated Flight Test" with no number = Flight 1
const BARE_IFT_RE = /\bIntegrated\s+Flight\s+Test\b(?!\s*\d)/i;

const ORDINAL_MAP: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20,
  "twenty-first": 21, "twenty first": 21, "twenty-second": 22, "twenty second": 22,
  "twenty-third": 23, "twenty third": 23, "twenty-fourth": 24, "twenty fourth": 24,
  "twenty-fifth": 25, "twenty fifth": 25,
};

const ORDINAL_WORDS = Object.keys(ORDINAL_MAP)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[-\s]/g, "[- ]?"));
const ORDINAL_FLIGHT_RE = new RegExp(
  `\\b(${ORDINAL_WORDS.join("|")})\\b.*?\\bflight\\b|\\bflight\\b.*?\\b(${ORDINAL_WORDS.join("|")})\\b`,
  "i"
);

export function parseFlightNumber(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = FLIGHT_NUM_RE.exec(name);
  if (m) return parseInt(m[1], 10);
  if (BARE_IFT_RE.test(name)) return 1;
  const om = ORDINAL_FLIGHT_RE.exec(name);
  if (om) {
    const word = (om[1] || om[2] || "").toLowerCase().replace(/\s+/g, " ");
    const hit = ORDINAL_MAP[word] ?? ORDINAL_MAP[word.replace(" ", "-")];
    if (hit) return hit;
  }
  // Fallback: bare ordinal anywhere plus the word "flight"
  if (/flight/i.test(name)) {
    for (const key of Object.keys(ORDINAL_MAP).sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`\\b${key.replace(/[-\s]/g, "[- ]?")}\\b`, "i");
      if (re.test(name)) return ORDINAL_MAP[key];
    }
  }
  return null;
}

// Orbital Starship configs (exclude Prototype hops)
const STARSHIP_LAUNCHER_CONFIG_IDS = "464,527,522,528";
const LL2_BASE_URL = "https://ll.thespacedevs.com/2.3.0";

const HOLD_STATUS_HINTS = ["hold", "scrub", "stale", "to be determined", "tbd"];
const TERMINAL_STATUS_HINTS = ["success", "failure", "partial", "launch was a"];

function statusIsHold(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return HOLD_STATUS_HINTS.some((h) => s.includes(h));
}

function statusWasGo(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase().trim();
  if (!s) return false;
  if (TERMINAL_STATUS_HINTS.some((h) => s.includes(h))) return false;
  return s === "go" || s.includes("go for launch");
}

// Trimmed launch record persisted to ll2_raw_json (replaces mode=detailed blob).
export interface Ll2Launch {
  id: string | null;
  url: string | null;
  name: string | null;
  net: string | null;
  window_start: string | null;
  window_end: string | null;
  status: { name: string | null } | null;
  pad: { name: string | null } | null;
}

function trimLaunch(raw: Record<string, unknown>): Ll2Launch {
  const status = raw["status"] as Record<string, unknown> | null | undefined;
  const pad = raw["pad"] as Record<string, unknown> | null | undefined;
  return {
    id: (raw["id"] as string) ?? null,
    url: (raw["url"] as string) ?? null,
    name: (raw["name"] as string) ?? null,
    net: (raw["net"] as string) ?? null,
    window_start: (raw["window_start"] as string) ?? null,
    window_end: (raw["window_end"] as string) ?? null,
    status: status ? { name: (status["name"] as string) ?? null } : null,
    pad: pad ? { name: (pad["name"] as string) ?? null } : null,
  };
}

function isStarshipFlight(launch: Ll2Launch): boolean {
  // Keep numbered integrated flight tests; drop commercial TBD manifests without a flight number.
  const fn = parseFlightNumber(launch.name);
  if (fn === null) return false;
  if (fn > 50) return false;
  return true;
}

// --- Sliding-window request budget, persisted in meta (default 14/hr) ---

const BUDGET_LIMIT = 14;
const BUDGET_WINDOW_S = 3600;
const BUDGET_META_KEY = "ll2_fetch_log";

async function loadBudgetLog(db: D1Database): Promise<number[]> {
  const raw = await getMeta(db, BUDGET_META_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    const cutoff = Date.now() / 1000 - BUDGET_WINDOW_S;
    return (Array.isArray(arr) ? arr : []).filter((t: number) => t >= cutoff);
  } catch {
    return [];
  }
}

export async function budgetRemaining(db: D1Database): Promise<number> {
  const log = await loadBudgetLog(db);
  return Math.max(0, BUDGET_LIMIT - log.length);
}

export function normalizePad(pad: string | null): string | null {
  if (!pad) return null;
  const p = pad.toLowerCase();
  if (p.includes("pad 2") || p.includes("olp-2") || p.includes("olp\u20112")) return "OLP-2";
  if (p.includes("pad 1") || p.includes("olp-1") || p.includes("olp\u20111")) return "OLP-1";
  return pad;
}

async function fetchStarshipLaunches(db: D1Database, settings: Settings): Promise<Ll2Launch[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "starship-flight-tracker/1.0 (workers)",
  };
  if (settings.ll2ApiKey) headers["Authorization"] = `Token ${settings.ll2ApiKey}`;

  const params = new URLSearchParams({
    launcher_config__id: STARSHIP_LAUNCHER_CONFIG_IDS,
    limit: "50",
    mode: "normal",
    ordering: "-net",
  });
  const resp = await fetch(`${LL2_BASE_URL}/launches/?${params}`, { headers });
  if (!resp.ok) throw new Error(`LL2 HTTP ${resp.status}`);
  const payload = (await resp.json()) as { results?: Record<string, unknown>[] };
  const results = payload.results ?? [];
  return results.map(trimLaunch).filter(isStarshipFlight);
}

async function recentLaunchScrub(db: D1Database, flightNumber: number, hours = 18): Promise<boolean> {
  // True if we already recorded a launch_scrub for this flight recently.
  const signals = await listSignals(db, { flightNumber, limit: 40 });
  const now = Date.now();
  for (const s of signals) {
    if (s.signal_type !== "launch_scrub") continue;
    const raw = s.extracted_at;
    if (!raw) return true;
    const ts = Date.parse(String(raw));
    if (Number.isNaN(ts)) return true;
    if (now - ts <= hours * 3_600_000) return true;
  }
  return false;
}

export interface Ll2SyncResult {
  updated?: number;
  net_changes?: number;
  scrubs?: number;
  budget_remaining?: number;
  skipped?: boolean;
  error?: string;
  [key: string]: unknown;
}

export async function syncLl2ToDb(
  db: D1Database,
  settings: Settings,
  opts: { force?: boolean; maxAgeS?: number } = {}
): Promise<Ll2SyncResult> {
  const maxAge = opts.maxAgeS ?? settings.pollIntervalIdleS;

  // Freshness gate (replaces the on-disk cache): skip when the last successful
  // sync is newer than max-age. Force bypasses.
  const syncedAt = await getMeta(db, "ll2_synced_at");
  if (!opts.force && syncedAt) {
    const age = (Date.now() - Date.parse(syncedAt)) / 1000;
    if (Number.isFinite(age) && age < maxAge) {
      return { skipped: true, reason: "fresh", age_s: Math.round(age) };
    }
  }

  // Rate budget (free LL2 tier is 15 req/hr)
  const log = await loadBudgetLog(db);
  if (!opts.force && log.length >= BUDGET_LIMIT) {
    return { skipped: true, reason: "budget_exhausted", budget_remaining: 0 };
  }

  let launches: Ll2Launch[];
  try {
    launches = await fetchStarshipLaunches(db, settings);
  } finally {
    log.push(Date.now() / 1000);
    await setMetaStmt(db, BUDGET_META_KEY, JSON.stringify(log)).run();
  }

  const stmts: D1PreparedStatement[] = [];
  let updated = 0;
  let netChanges = 0;
  let scrubs = 0;
  const now = new Date();

  for (const launch of launches) {
    const fn = parseFlightNumber(launch.name);
    if (fn === null) continue;
    const prev = await getFlight(db, fn);
    const prevStatus = prev?.ll2_status ?? null;
    const prevNet = prev?.net_date ?? null;
    const net = launch.net ?? launch.window_start;
    const status = launch.status?.name ?? null;
    const pad = launch.pad?.name ?? null;

    const mapped: Record<string, unknown> = {
      flight_number: fn,
      name: launch.name,
      net_date: net,
      ll2_id: launch.id,
      ll2_status: status,
      ll2_raw: launch as unknown as Record<string, unknown>,
      pad: normalizePad(pad),
    };
    // If LL2 says launched / success / failure, set launch_date
    const statusL = (status ?? "").toLowerCase();
    if (net && TERMINAL_STATUS_HINTS.some((k) => statusL.includes(k))) {
      mapped["launch_date"] = net;
    }
    stmts.push(upsertFlightStmt(db, mapped as never));
    updated += 1;

    let netChanged = false;
    if (net) {
      // INSERT OR IGNORE — detect change by checking existing history entry
      const existing = await db
        .prepare("SELECT 1 AS x FROM net_history WHERE flight_number = ? AND net_date = ? AND source = 'll2'")
        .bind(fn, net)
        .first();
      if (!existing) {
        stmts.push(recordNetStmt(db, fn, net, "ll2"));
        netChanges += 1;
        netChanged = true;
      }
    }

    // Scrub / recycle detection for upcoming flights
    if (prev && !prev.launch_date && !mapped["launch_date"]) {
      const goToHold = statusWasGo(prevStatus) && statusIsHold(status);
      let recycled = false;
      if (netChanged && prevNet && net && prevNet !== net) {
        const prevT = Date.parse(prevNet);
        const newT = Date.parse(net);
        if (!Number.isNaN(prevT) && !Number.isNaN(newT)) {
          // NET moved later while still unflown → recycle / scrub
          recycled = newT > prevT && newT - prevT >= 3_600_000;
        }
      }
      // Silent scrub: still "Go" but the published window already ended
      const windowEnd = launch.window_end ?? net;
      let pastWindow = false;
      if (windowEnd && statusWasGo(status)) {
        const endT = Date.parse(windowEnd);
        if (!Number.isNaN(endT)) {
          pastWindow = now.getTime() > endT + 20 * 60_000;
        }
      }
      if (goToHold || recycled || pastWindow) {
        const reason = goToHold
          ? `LL2 status ${JSON.stringify(prevStatus)} → ${JSON.stringify(status)}`
          : recycled
            ? `LL2 NET recycled ${prevNet} → ${net}`
            : `LL2 window ended (${windowEnd}) without launch; status still ${JSON.stringify(status)}`;
        if (!(await recentLaunchScrub(db, fn))) {
          stmts.push(
            insertSignalStmt(db, {
              signal_type: "launch_scrub",
              flight_number: fn,
              confidence: 0.85,
              quote: reason,
              payload: {
                reason,
                source: "ll2",
                previous_status: prevStatus,
                status,
                new_net_date: net,
                previous_net_date: prevNet,
              },
            })
          );
          scrubs += 1;
        }
      }
    }
  }

  stmts.push(setMetaStmt(db, "ll2_synced_at", utcnow()));
  const remaining = Math.max(0, BUDGET_LIMIT - log.length);
  stmts.push(setMetaStmt(db, "ll2_budget_remaining", String(remaining)));
  if (stmts.length) await db.batch(stmts);

  return { updated, net_changes: netChanges, scrubs, budget_remaining: remaining };
}
