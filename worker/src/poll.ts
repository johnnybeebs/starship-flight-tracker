// Port of server/app/poll.py. The long-running asyncio loop becomes an hourly
// cron tick: near-launch polls every tick, idle polls only on the tick that
// matches POLL_IDLE_HOUR_LOCAL in POLL_IDLE_TZ (Workers run in UTC).

import { getMeta, listFlights, loadSeed, setMetaStmt } from "./db";
import { refreshCadence } from "./cadence/cache";
import { maybeProcessUnextracted } from "./extractor";
import { budgetRemaining, syncLl2ToDb } from "./ll2";
import { syncNewsToDb } from "./news";
import type { Env, Settings } from "./types";
import { getSettings } from "./types";

const HOLD_STATUS_HINTS = ["hold", "scrub", "stale", "to be determined", "tbd"];

function parseFlightDt(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

export async function nearLaunch(db: D1Database, settings: Settings): Promise<boolean> {
  // True when an upcoming flight is inside the launch/recycle watch window:
  // - NET within near_launch_horizon_h (before or after)
  // - Window/NET recently passed with no launch (same-day scrub/recycle)
  // - LL2 status already looks like Hold/Scrub/TBD
  const flights = await listFlights(db);
  const now = Date.now();
  const hotH = settings.postWindowHotH;
  const horizonH = settings.nearLaunchHorizonH;
  for (const f of flights) {
    if (f.launch_date || f.outcome) continue;
    const status = (f.ll2_status ?? "").toLowerCase();
    if (HOLD_STATUS_HINTS.some((h) => status.includes(h))) return true;
    const netT = parseFlightDt(f.net_date);
    if (netT === null) continue;
    const hours = Math.abs(netT - now) / 3_600_000;
    if (hours <= horizonH) return true;
    // Past attempt: stay hot so we pick up recycle NET / scrub articles
    if (now > netT && (now - netT) / 3_600_000 <= hotH) return true;
  }
  return false;
}

function localHour(instantMs: number, tz: string): number {
  const raw = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).format(new Date(instantMs));
  const h = Number(raw);
  // "24" can appear for midnight in some ICU versions
  return Number.isFinite(h) ? h % 24 : 0;
}

export function nextIdlePollAt(nowMs: number, settings: Settings): number {
  // Next top-of-hour UTC instant whose wall clock in poll_idle_tz is the idle hour.
  const hour = Math.min(23, Math.max(0, settings.pollIdleHourLocal));
  const tz = settings.pollIdleTz || "UTC";
  const hourMs = 3_600_000;
  const base = Math.floor(nowMs / hourMs) * hourMs;
  for (let i = 1; i <= 26; i++) {
    const candidate = base + i * hourMs;
    try {
      if (localHour(candidate, tz) === hour) return candidate;
    } catch {
      // Bad TZ name — fall back to UTC interpretation
      if (new Date(candidate).getUTCHours() === hour) return candidate;
    }
  }
  return base + 24 * hourMs;
}

export function computeNextPollAt(near: boolean, settings: Settings, nowMs?: number): number {
  const now = nowMs ?? Date.now();
  if (near) return now + settings.pollIntervalNearLaunchS * 1000;
  return nextIdlePollAt(now, settings);
}

export async function ensureSeeded(db: D1Database): Promise<boolean> {
  const seeded = await getMeta(db, "seed_loaded_at");
  if (seeded) return false;
  await loadSeed(db);
  return true;
}

export interface PollResult {
  ok: boolean;
  near_launch?: boolean;
  ll2?: Record<string, unknown>;
  news?: Record<string, unknown>;
  extract?: Record<string, unknown>;
  cadence?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function runPollCycle(
  env: Env,
  opts: { forceLl2?: boolean; forceExtract?: boolean; forceCadence?: boolean } = {}
): Promise<PollResult> {
  const settings = getSettings(env);
  const db = env.DB;
  // Manual refresh (force_ll2 or force_extract) implies a forced cadence rebuild
  const forceCadence = opts.forceCadence ?? Boolean(opts.forceLl2 || opts.forceExtract);
  const result: PollResult = { ok: true };

  await ensureSeeded(db);
  const near = await nearLaunch(db, settings);
  result.near_launch = near;
  const maxAge = near ? settings.pollIntervalNearLaunchS : settings.pollIntervalIdleS;

  try {
    result.ll2 = await syncLl2ToDb(db, settings, { force: opts.forceLl2, maxAgeS: maxAge });
  } catch (exc) {
    console.warn("LL2 poll error:", exc);
    result.ll2 = { error: String(exc) };
  }
  try {
    // Same max-age as LL2; news module also floors at SNAPI's max-age=600.
    result.news = await syncNewsToDb(db, settings, {
      force: Boolean(opts.forceLl2 || opts.forceExtract),
      maxAgeS: maxAge,
    });
  } catch (exc) {
    console.warn("News poll error:", exc);
    result.news = { error: String(exc) };
  }
  try {
    const extractInterval = near ? settings.pollIntervalNearLaunchS : settings.pollIntervalIdleS;
    result.extract = await maybeProcessUnextracted(db, settings, {
      force: opts.forceExtract,
      intervalS: extractInterval,
    });
  } catch (exc) {
    console.warn("Extract poll error:", exc);
    result.extract = { error: String(exc) };
  }
  try {
    // Fingerprint still skips recompute when nothing changed.
    result.cadence = (await refreshCadence(db, env.CACHE, settings, {
      force: forceCadence,
    })) as unknown as Record<string, unknown>;
  } catch (exc) {
    console.warn("Cadence refresh error:", exc);
    result.cadence = { error: String(exc) };
  }

  result["ll2_budget_remaining"] = await budgetRemaining(db);
  const intervalS = near ? settings.pollIntervalNearLaunchS : settings.pollIntervalIdleS;
  const refreshedAt = Date.now();
  const nextPollAt = computeNextPollAt(near, settings, refreshedAt);
  result["poll_interval_s"] = intervalS;
  result["poll_idle_hour_local"] = settings.pollIdleHourLocal;
  result["refreshed_at"] = new Date(refreshedAt).toISOString();
  result["next_poll_at"] = new Date(nextPollAt).toISOString();
  await db.batch([
    setMetaStmt(db, "poll_synced_at", result["refreshed_at"] as string),
    setMetaStmt(db, "next_poll_at", result["next_poll_at"] as string),
    setMetaStmt(db, "poll_interval_s", String(intervalS)),
    setMetaStmt(db, "near_launch", near ? "1" : "0"),
  ]);
  return result;
}

/** Cron gate: poll when near-launch, when the stored schedule says it's due, or never polled. */
export async function pollDue(db: D1Database, settings: Settings): Promise<boolean> {
  const near = await nearLaunch(db, settings);
  if (near) return true;
  const nextAt = await getMeta(db, "next_poll_at");
  if (!nextAt) return true;
  const t = Date.parse(nextAt);
  return Number.isNaN(t) || t <= Date.now();
}
