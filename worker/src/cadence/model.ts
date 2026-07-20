// Simplified TypeScript port of server/app/cadence_model.py for the Workers
// free tier (10 ms CPU per invocation).
//
// Kept: recent-gap sampling with the 90-day outlier cap, goal-gap blend +
// attainment shrinkage, NET anchors + slip velocity, mishap branch with
// investigation delay + return-to-flight, hardware-readiness floors from
// pipeline_seed.json, pad turnaround/availability, scrub delay branch, and
// monthly/EOY percentile aggregation.
//
// Deliberately dropped (accepted degradation, payload keys stay null/zero):
// - Hurricane-season climatology (Aug–Oct Gulf delay draws)
// - weather_hazard news-signal holds
// - Florida-first sub-model (p_first_florida = 0, florida_first = null)
// - Per-sim regime multiplier (REGIME_SIGMA)
// - 20,000 sims → ~2,000 (P50 SE grows ~3x, still sub-week near-term)

import { clip, mean, quantile, quantileSorted, Rng, std } from "./rng";
import {
  investigationClosed,
  reopenAfterSeedClose,
  slipVelocityDaysPerWeek,
  sortedFaaSignals,
} from "../statusEngine";
import type { Flight, NetHistoryRow, Pipeline, Signal } from "../types";
import pipelineSeed from "../../seeds/pipeline_seed.json";

// --- Constants (verbatim from cadence_model.py) ---

const MAX_RECENT_GAP_DAYS = 90.0;
const RECENT_GAP_WINDOW = 5;
const DEFAULT_GOAL_GAP_DAYS = 30.0;
export const DEFAULT_GOAL_BLEND = 0.55;
const MIN_GAP_DAYS = 14.0;
const PAD_TURNAROUND_DAYS = 14.0;
const DUAL_PAD_TURNAROUND_DAYS = 10.0;
const BLOCK_TRANSITION_EXTRA_DAYS = 45.0;
const PAD_CHANGE_EXTRA_DAYS = 30.0;
const SITE_STARBASE = "starbase";
const SITE_FLORIDA = "florida";
const FLORIDA_FIRST_PAD = "LC-39A";
const DEFAULT_SCRUB_PROB = 0.3;
const DEFAULT_SCRUB_EXTRA_MEAN = 5.0;
const SCRUB_SHORT_MEAN_DAYS = 2.5;
const SCRUB_LONG_MEAN_DAYS = 12.0;
const SCRUB_P_LONG_PRIOR = 0.35;
const SCRUB_RETRY_PROB_BUMP = 0.12;
const SCRUB_DELAY_BOUNDS: [number, number] = [1.0, 21.0];
const GOAL_PRIOR_SIGMA = 0.22;
const GOAL_SIGNAL_HALF_LIFE_DAYS = 90.0;
const GOAL_GAP_BOUNDS: [number, number] = [18.0, 55.0];
const GOAL_MISS_PROB = 0.3;
const GOAL_ATTAINMENT_BOUNDS: [number, number] = [0.8, 4.0];
const GOAL_ATTAINMENT_PRIOR = 1.8;
const MISHAP_PRIOR = 0.28;
const MISHAP_RATE_BOUNDS: [number, number] = [0.1, 0.55];
const MISHAP_LOOKBACK = 10;
const BLOCK_MISHAP_PRIOR: Record<number, number> = { 1: 0.42, 2: 0.38, 3: 0.22 };
const FIRST_OF_KIND_MISHAP_BUMP = 0.08;
const DEFAULT_INV_DAYS = 50.0;
const FLEET_EXTEND_FLIGHTS = 12;
const SHIP_COMPLETE_READINESS = new Set([
  "ship_stacked",
  "cryo_complete",
  "static_fire_complete",
  "pad_ready",
  "flown",
]);
const MFR_RATE_BOUNDS: [number, number] = [0.35, 4.0];
const MFR_GAP_LOOKBACK = 4;
const CLEAN_GAP_FLOOR_DAYS = 7.0;
const HW_READY_SIGMA_DAYS = 4.0;
const HW_READY_SIGMA_BY_READINESS: Record<string, number> = {
  pad_ready: 2.0,
  static_fire_complete: 3.0,
  cryo_complete: 5.0,
  ship_stacked: 10.0,
  in_production: 20.0,
  announced: 25.0,
  projected: 25.0,
};
const PAD_AVAIL_SIGMA_DAYS = 21.0;
const PAD_AVAIL_MAX_SLIP_DAYS = 90.0;
const NET_DELAY_JITTER_MEAN = 2.0;
const NET_SLIP_MAX_DAYS = 60.0;
const RTF_PRIOR_MEAN = 18.0;
const RTF_BOUNDS: [number, number] = [5.0, 35.0];
const RTF_LOOKBACK = 8;
const RTF_NET_SKIP_DAYS = 21;
const HW_NET_SKIP_DAYS = 21;
const STALE_READY_RESIDUAL_BY_READINESS: Record<string, number> = {
  pad_ready: 0,
  static_fire_complete: 1,
  cryo_complete: 3,
  ship_stacked: 5,
  in_production: 10,
  announced: 14,
  projected: 10,
};
const EARLY_CLEAR_PROB = 0.3;
const HOLD_RESIDUAL_SIGMA_FRAC = 0.45;

// --- Date helpers (day ordinals = whole days since Unix epoch, UTC) ---

const DAY_MS = 86_400_000;

export function ordFromIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(String(value).length === 10 ? `${value}T00:00:00Z` : String(value));
  if (Number.isNaN(t)) {
    const t2 = Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(t2) ? null : Math.floor(t2 / DAY_MS);
  }
  return Math.floor(t / DAY_MS);
}

export function isoFromOrd(ord: number): string {
  return new Date(ord * DAY_MS).toISOString().slice(0, 10);
}

function monthOfOrd(ord: number): number {
  return new Date(ord * DAY_MS).getUTCMonth() + 1;
}

function yearOfOrd(ord: number): number {
  return new Date(ord * DAY_MS).getUTCFullYear();
}

function monthKeyOfOrd(ord: number): string {
  const d = new Date(ord * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// --- Gap extraction ---

type Gap = [fn: number, gapDays: number, block: number];

export function interFlightGaps(flights: Flight[]): Gap[] {
  const flown: Array<[number, number, number]> = [];
  for (const f of flights) {
    const d = ordFromIso(f.launch_date);
    if (d !== null) flown.push([f.flight_number, d, Number(f.block ?? 1)]);
  }
  flown.sort((a, b) => a[0] - b[0]);
  const gaps: Gap[] = [];
  for (let i = 1; i < flown.length; i++) {
    const [, prevD] = flown[i - 1];
    const [n, d, block] = flown[i];
    const gap = d - prevD;
    if (gap > 0) gaps.push([n, gap, block]);
  }
  return gaps;
}

export function recentOperationalGaps(
  gaps: Gap[],
  opts: { window?: number; maxGap?: number; block?: number | null } = {}
): number[] {
  const window = opts.window ?? RECENT_GAP_WINDOW;
  const maxGap = opts.maxGap ?? MAX_RECENT_GAP_DAYS;
  if (!gaps.length) return [];
  if (opts.block != null) {
    const same = gaps.filter((g) => g[2] === opts.block);
    if (same.length >= 2) {
      return same.map((g) => Math.min(g[1], maxGap)).slice(-window);
    }
  }
  return gaps.map((g) => Math.min(g[1], maxGap)).slice(-window);
}

function investigationDowntimeDays(prevFlight: Flight, prevOrd: number, nextOrd: number): number {
  const inv = prevFlight.investigation ?? null;
  if (!inv) return 0;
  const opened = ordFromIso(inv.opened ?? null);
  const closed = ordFromIso(inv.closed ?? null);
  if (opened !== null && closed !== null) {
    const start = Math.max(opened, prevOrd);
    const end = Math.min(closed, nextOrd);
    return Math.max(0, end - start);
  }
  if (inv.days) return Math.min(Number(inv.days), nextOrd - prevOrd);
  return 0;
}

export function cleanInterFlightGaps(flights: Flight[]): Gap[] {
  // Gaps with mishap-investigation downtime removed (the MC samples holds separately).
  const flown: Array<[Flight, number]> = [];
  for (const f of flights) {
    const d = ordFromIso(f.launch_date);
    if (d !== null) flown.push([f, d]);
  }
  flown.sort((a, b) => a[0].flight_number - b[0].flight_number);
  const gaps: Gap[] = [];
  for (let i = 1; i < flown.length; i++) {
    const [prevF, prevD] = flown[i - 1];
    const [f, d] = flown[i];
    const gap = d - prevD;
    if (gap <= 0) continue;
    const downtime = investigationDowntimeDays(prevF, prevD, d);
    const clean = Math.max(CLEAN_GAP_FLOOR_DAYS, gap - downtime);
    gaps.push([f.flight_number, clean, Number(f.block ?? 1)]);
  }
  return gaps;
}

function investigationDurations(flights: Flight[]): number[] {
  const days: number[] = [];
  for (const f of flights) {
    const inv = f.investigation;
    if (inv?.days) days.push(Number(inv.days));
  }
  return days;
}

function flightTriggeredInvestigation(f: Flight): boolean {
  if (f.investigation?.days) return true;
  const o = (f.outcome ?? "").toUpperCase();
  return o === "FAILURE" || o === "PARTIAL";
}

// --- Mishap params ---

export interface MishapParams {
  p_mishap: number;
  inv_days: number[];
  inv_mean: number;
  inv_std: number;
  n_lookback: number;
  n_mishaps: number;
  target_block: number;
  block_prior: number;
  regime: string;
  raw_rate?: number;
}

export function estimateMishapParams(flights: Flight[], nextBlock?: number | null): MishapParams {
  const flown = flights.filter((f) => f.launch_date).sort((a, b) => a.flight_number - b.flight_number);
  const lookback = flown.slice(-MISHAP_LOOKBACK);
  const targetBlock =
    nextBlock != null
      ? Math.trunc(nextBlock)
      : lookback.length && lookback[lookback.length - 1].block != null
        ? Number(lookback[lookback.length - 1].block)
        : 3;
  const blockPrior = BLOCK_MISHAP_PRIOR[targetBlock] ?? MISHAP_PRIOR;
  const priorStrength = 8.0;

  if (!lookback.length) {
    return {
      p_mishap: blockPrior,
      inv_days: [],
      inv_mean: DEFAULT_INV_DAYS,
      inv_std: 20.0,
      n_lookback: 0,
      n_mishaps: 0,
      target_block: targetBlock,
      block_prior: blockPrior,
      regime: "prior",
    };
  }

  let alpha = blockPrior * priorStrength;
  let beta = (1.0 - blockPrior) * priorStrength;
  let nM = 0;
  lookback.forEach((f, i) => {
    const recency = 0.35 + 0.65 * ((i + 1) / lookback.length);
    const same = f.block != null && Number(f.block) === targetBlock;
    const w = recency * (same ? 1.0 : 0.2);
    if (flightTriggeredInvestigation(f)) {
      const hit = f.investigation?.days ? 1.0 : 0.85;
      alpha += w * hit;
      nM += 1;
      beta += w * (1.0 - hit);
    } else {
      beta += w;
    }
  });

  const p = clip(alpha / (alpha + beta), MISHAP_RATE_BOUNDS[0], MISHAP_RATE_BOUNDS[1]);
  const invTriggers = lookback.filter((f) => f.investigation?.days);
  const raw = lookback.length ? invTriggers.length / lookback.length : blockPrior;

  const invDaysAll = investigationDurations(flights);
  const sameBlockFlights = lookback.filter((f) => f.block != null && Number(f.block) === targetBlock);
  let recentInv = investigationDurations(sameBlockFlights);
  if (!recentInv.length) recentInv = investigationDurations(lookback);
  if (!recentInv.length) recentInv = invDaysAll;
  const invMean = recentInv.length ? mean(recentInv) : DEFAULT_INV_DAYS;
  const invStd = recentInv.length > 1 ? std(recentInv) : Math.max(15.0, invMean * 0.35);
  return {
    p_mishap: p,
    raw_rate: raw,
    inv_days: recentInv,
    inv_mean: invMean,
    inv_std: invStd,
    n_lookback: lookback.length,
    n_mishaps: nM,
    target_block: targetBlock,
    block_prior: blockPrior,
    regime: "block_beta",
  };
}

export function mishapProbabilityForFlight(
  fn: number,
  baseP: number,
  pipelineIndex: Map<number, PipelineEntry>,
  flights: Flight[]
): number {
  const block = blockForFlight(fn, pipelineIndex, flights);
  const blockPrior = BLOCK_MISHAP_PRIOR[block] ?? MISHAP_PRIOR;
  let p = 0.75 * baseP + 0.25 * blockPrior;
  const entry = pipelineIndex.get(fn);
  let flags: string[] = [];
  const rawFlags = entry?.risk_flags;
  if (typeof rawFlags === "string") flags = [rawFlags];
  else if (Array.isArray(rawFlags)) flags = rawFlags.map(String);
  let firstKind = flags.some((x) =>
    ["first_catch", "first_of_block", "first_ship_catch", "new_pad"].includes(x.toLowerCase())
  );
  if (!firstKind && entry?.notes) {
    const note = String(entry.notes).toLowerCase();
    firstKind = note.includes("first") && (note.includes("catch") || note.includes("v3 catch"));
  }
  if (firstKind) p += FIRST_OF_KIND_MISHAP_BUMP;
  return clip(p, MISHAP_RATE_BOUNDS[0], MISHAP_RATE_BOUNDS[1]);
}

function sampleInvestigationDays(params: MishapParams, rng: Rng): number {
  const days = params.inv_days;
  if (days.length) {
    return Math.max(14.0, rng.choice(days) * rng.lognormal(0.0, 0.15));
  }
  return Math.max(14.0, rng.normal(params.inv_mean || DEFAULT_INV_DAYS, params.inv_std || 20.0));
}

// --- Return to flight ---

interface RtfParams {
  rtf_days: number[];
  rtf_mean: number;
  rtf_std: number;
  n: number;
  source: string;
}

export function estimateReturnToFlightParams(flights: Flight[]): RtfParams {
  const flown = flights.filter((f) => f.launch_date).sort((a, b) => a.flight_number - b.flight_number);
  const rtfs: number[] = [];
  for (let i = 0; i < flown.length - 1; i++) {
    const inv = flown[i].investigation ?? null;
    const closed = ordFromIso(inv?.closed ?? null);
    const nxt = ordFromIso(flown[i + 1].launch_date);
    if (closed === null || nxt === null) continue;
    const gap = nxt - closed;
    if (gap <= 0) continue;
    rtfs.push(Math.min(gap, RTF_BOUNDS[1]));
  }
  const recent = rtfs.slice(-RTF_LOOKBACK);
  if (!recent.length) {
    return { rtf_days: [], rtf_mean: RTF_PRIOR_MEAN, rtf_std: 10.0, n: 0, source: "prior" };
  }
  return {
    rtf_days: recent,
    rtf_mean: mean(recent),
    rtf_std: recent.length > 1 ? std(recent) : 8.0,
    n: recent.length,
    source: "history",
  };
}

function sampleReturnToFlightDays(params: RtfParams, rng: Rng): number {
  let raw: number;
  if (params.rtf_days.length) {
    raw = rng.choice(params.rtf_days) * rng.lognormal(0.0, 0.12);
  } else {
    raw = rng.normal(params.rtf_mean || RTF_PRIOR_MEAN, params.rtf_std || 10.0);
  }
  return clip(raw, RTF_BOUNDS[0], RTF_BOUNDS[1]);
}

function sampleOpenFaaHoldDays(
  residualMean: number,
  invMean: number,
  invStd: number,
  rng: Rng
): number {
  const base = Math.max(residualMean, invMean * 0.15);
  const sigma = Math.max(7.0, invStd * HOLD_RESIDUAL_SIGMA_FRAC, base * 0.35);
  let sampled = rng.normal(base, sigma);
  if (rng.random() < EARLY_CLEAR_PROB) {
    sampled *= rng.uniform(0.35, 0.9);
  }
  return Math.max(3.0, sampled);
}

// --- Pipeline / goal ---

export function loadPipeline(): Pipeline {
  return pipelineSeed as unknown as Pipeline;
}

function signalAgeDays(signal: Signal, today: number): number {
  for (const key of ["article_published_at", "published_at", "extracted_at"]) {
    const raw = signal[key];
    if (!raw || typeof raw !== "string") continue;
    const d = ordFromIso(raw);
    if (d !== null) return Math.max(0, today - d);
  }
  return 0;
}

function cadenceSignalWeight(signal: Signal, today: number): number {
  const conf = clip(Number(signal.confidence ?? 0.65), 0.05, 1.0);
  const age = signalAgeDays(signal, today);
  const decay = Math.exp((-Math.LN2 * age) / GOAL_SIGNAL_HALF_LIFE_DAYS);
  return conf * decay;
}

export interface Goal {
  target_gap_days: number;
  launches_per_month: number;
  statement: string | null;
  source: string;
  seed_target_gap_days: number;
  signal_count: number;
  manufacturing_rate_rockets_per_month: number;
}

export function resolveGoal(pipeline: Pipeline, signals: Signal[], today: number): Goal {
  const goal = (pipeline.goal ?? {}) as Record<string, unknown>;
  const seedTarget = Number(goal["target_gap_days"] ?? DEFAULT_GOAL_GAP_DAYS) || DEFAULT_GOAL_GAP_DAYS;
  const seedPerMonth = Number(goal["launches_per_month"] ?? 30.0 / seedTarget) || 30.0 / seedTarget;
  let statement = (goal["statement"] as string | null) ?? null;
  let source = "pipeline_seed";

  const cadenceSigs = signals.filter((s) => s.signal_type === "cadence_statement");
  const weighted: Array<[number, number, string | null]> = [];
  for (const s of cadenceSigs) {
    const payload = s.payload ?? {};
    const w = cadenceSignalWeight(s, today);
    if (w <= 1e-6) continue;
    let target: number | null = null;
    if (payload["target_gap_days"]) {
      target = Number(payload["target_gap_days"]);
    } else {
      const stmt = String(payload["statement"] ?? "").toLowerCase();
      if (
        stmt.includes("per month") ||
        stmt.includes("one a month") ||
        stmt.includes("monthly") ||
        stmt.includes("once a month")
      ) {
        target = 30.0;
      } else if (stmt.includes("two a month") || stmt.includes("twice a month") || stmt.includes("biweekly")) {
        target = 15.0;
      }
    }
    if (target === null) continue;
    weighted.push([w, target, (payload["statement"] as string) ?? null]);
  }

  let target: number;
  let perMonth: number;
  if (weighted.length) {
    const wsum = weighted.reduce((s, [w]) => s + w, 0);
    target = weighted.reduce((s, [w, t]) => s + w * t, 0) / wsum;
    // Blend signal consensus with seed so one quote can't fully override
    const seedW = 0.35;
    target = seedW * seedTarget + (1.0 - seedW) * target;
    perMonth = target ? 30.0 / target : seedPerMonth;
    const best = weighted.reduce((a, b) => (b[0] > a[0] ? b : a));
    statement = best[2] ?? statement;
    source = "signal_blend";
  } else {
    target = seedTarget;
    perMonth = seedPerMonth;
  }

  target = clip(target, GOAL_GAP_BOUNDS[0], GOAL_GAP_BOUNDS[1]);
  return {
    target_gap_days: target,
    launches_per_month: perMonth,
    statement,
    source,
    seed_target_gap_days: seedTarget,
    signal_count: weighted.length,
    manufacturing_rate_rockets_per_month:
      Number(goal["manufacturing_rate_rockets_per_month"] ?? perMonth ?? 1.0) || 1.0,
  };
}

function sampleGoalGap(resolvedGap: number, rng: Rng): number {
  const noisy = resolvedGap * rng.lognormal(0.0, GOAL_PRIOR_SIGMA);
  return clip(noisy, GOAL_GAP_BOUNDS[0], GOAL_GAP_BOUNDS[1]);
}

// --- Ship production rate ---

function parseShipSerial(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  if (s.startsWith("SHIP") && s.length > 4 && /^\d+$/.test(s.slice(4))) return `S${s.slice(4)}`;
  if (s.startsWith("S") && /^\d+$/.test(s.slice(1))) return s;
  if (/^\d+$/.test(s)) return `S${s}`;
  return s;
}

interface ShipCompletion {
  ship: string;
  completed: number; // ordinal
  block: number;
  source: string;
  flight_number: number | null;
  readiness: string;
}

function signalAsOfOrd(signal: Signal): number | null {
  for (const key of ["extracted_at", "article_published_at", "observed_at"]) {
    const raw = signal[key];
    if (!raw || typeof raw !== "string") continue;
    const d = ordFromIso(raw);
    if (d !== null) return d;
  }
  return null;
}

export function collectShipCompletions(
  flights: Flight[],
  pipeline: Pipeline,
  signals: Signal[],
  today: number
): ShipCompletion[] {
  const byShip = new Map<string, ShipCompletion>();

  const offer = (
    ship: string,
    completed: number,
    block: number,
    source: string,
    flightNumber: number | null,
    readiness: string
  ) => {
    // Ignore far-future placeholder ready dates — not observed production.
    if (completed > today + 45) return;
    const prev = byShip.get(ship);
    if (!prev || completed < prev.completed) {
      byShip.set(ship, { ship, completed, block, source, flight_number: flightNumber, readiness });
    }
  };

  for (const f of flights) {
    const ship = parseShipSerial(f.ship);
    const ld = ordFromIso(f.launch_date);
    if (ship && ld !== null) {
      offer(ship, ld, Number(f.block ?? 1), "launch", f.flight_number, "flown");
    }
  }

  for (const c of pipeline.ship_completions ?? []) {
    const ship = parseShipSerial(c["ship"]);
    const d = ordFromIso((c["completed"] as string) ?? (c["date"] as string));
    if (ship && d !== null) {
      offer(
        ship,
        d,
        Number(c["block"] ?? 3),
        "ship_completions",
        c["flight_number"] != null ? Number(c["flight_number"]) : null,
        String(c["milestone"] ?? c["readiness"] ?? "completed")
      );
    }
  }

  for (const v of pipeline.vehicles ?? []) {
    const ship = parseShipSerial(v.ship);
    const readiness = String(v.readiness ?? "");
    const er = ordFromIso(v.earliest_ready ?? null);
    if (ship && er !== null && SHIP_COMPLETE_READINESS.has(readiness)) {
      offer(ship, er, Number(v.block ?? 3), "pipeline", v.flight_number ?? null, readiness);
    }
  }

  // Only accept readiness signals for ships we already track.
  const knownShips = new Set<string>();
  for (const f of flights) {
    const s = parseShipSerial(f.ship);
    if (s) knownShips.add(s);
  }
  for (const v of pipeline.vehicles ?? []) {
    const s = parseShipSerial(v.ship);
    if (s) knownShips.add(s);
  }
  for (const c of pipeline.ship_completions ?? []) {
    const s = parseShipSerial(c["ship"]);
    if (s) knownShips.add(s);
  }

  const flownBlock = new Map<number, number>();
  for (const f of flights) {
    if (f.flight_number != null) flownBlock.set(f.flight_number, Number(f.block ?? 1));
  }
  const shipBlock = new Map<string, number>();
  for (const f of flights) {
    const s = parseShipSerial(f.ship);
    if (s) shipBlock.set(s, Number(f.block ?? 1));
  }
  for (const v of pipeline.vehicles ?? []) {
    const s = parseShipSerial(v.ship);
    if (s) shipBlock.set(s, Number(v.block ?? shipBlock.get(s) ?? 3));
  }

  const eventToReadiness: Record<string, string> = {
    stacking: "ship_stacked",
    cryo_test: "cryo_complete",
    static_fire: "static_fire_complete",
    rollout: "pad_ready",
  };
  for (const s of signals) {
    if (s.signal_type !== "vehicle_readiness") continue;
    const payload = s.payload ?? {};
    if (payload["vehicle"] === "booster") continue;
    const readiness = eventToReadiness[String(payload["event"] ?? "")];
    if (!readiness) continue;
    const ship = parseShipSerial(payload["serial"]);
    const d = signalAsOfOrd(s);
    if (!(ship && d !== null && ship.startsWith("S") && knownShips.has(ship))) continue;
    const fn = s.flight_number;
    let block = shipBlock.get(ship);
    if (block == null && fn != null) block = flownBlock.get(Number(fn));
    offer(ship, d, Number(block ?? 3), "signal", fn != null ? Number(fn) : null, readiness);
  }

  return [...byShip.values()].sort((a, b) => a.completed - b.completed || a.ship.localeCompare(b.ship));
}

export interface MfrEstimate {
  rate_per_month: number;
  gap_days: number;
  source: string;
  n_gaps: number;
  latest_ship: string | null;
  latest_completed: string | null;
  recent_gaps_days: number[];
  rate_trend: Array<Record<string, unknown>>;
  completions_n: number;
  stated_rate_per_month: number;
}

export function estimateShipProductionRate(
  flights: Flight[],
  pipeline: Pipeline,
  signals: Signal[],
  today: number,
  targetBlock: number | null,
  statedRate: number | null
): MfrEstimate {
  const stated = Number(statedRate ?? 1.0) || 1.0;
  const completions = collectShipCompletions(flights, pipeline, signals, today);

  // [gap, curBlock, prevBlock, prevShip, curShip]
  const rawGaps: Array<[number, number, number, string, string]> = [];
  for (let i = 1; i < completions.length; i++) {
    const prev = completions[i - 1];
    const cur = completions[i];
    const gap = cur.completed - prev.completed;
    if (gap <= 0) continue;
    rawGaps.push([gap, cur.block, prev.block, prev.ship, cur.ship]);
  }

  let usable = rawGaps;
  if (targetBlock != null) {
    const same = rawGaps.filter((g) => g[1] === targetBlock && g[2] === targetBlock);
    if (same.length) {
      usable = same;
    } else {
      const cross = rawGaps.filter((g) => g[1] === targetBlock);
      usable = cross.length ? cross : rawGaps;
    }
  }

  const byShip = new Map(completions.map((e) => [e.ship, e]));
  const rateTrend: Array<Record<string, unknown>> = [];
  for (const [gap, , , prevShip, curShip] of usable) {
    const cur = byShip.get(curShip);
    if (!cur) continue;
    const gapC = Math.min(gap, MAX_RECENT_GAP_DAYS);
    const pointRate = clip(30.0 / Math.max(MIN_GAP_DAYS, gapC), MFR_RATE_BOUNDS[0], MFR_RATE_BOUNDS[1]);
    rateTrend.push({
      date: isoFromOrd(cur.completed),
      ship: curShip,
      from_ship: prevShip,
      flight_number: cur.flight_number,
      gap_days: Math.round(gapC * 10) / 10,
      rate_per_month: Math.round(pointRate * 1000) / 1000,
    });
  }

  const recent = usable.slice(-MFR_GAP_LOOKBACK);
  const capped = recent.map((g) => Math.min(g[0], MAX_RECENT_GAP_DAYS));
  if (!capped.length) {
    const gapDays = Math.max(MIN_GAP_DAYS, 30.0 / Math.max(MFR_RATE_BOUNDS[0], stated));
    const rate = clip(30.0 / gapDays, MFR_RATE_BOUNDS[0], MFR_RATE_BOUNDS[1]);
    const latest = completions.length ? completions[completions.length - 1] : null;
    return {
      rate_per_month: rate,
      gap_days: gapDays,
      source: "stated_fallback",
      n_gaps: 0,
      latest_ship: latest?.ship ?? null,
      latest_completed: latest ? isoFromOrd(latest.completed) : null,
      recent_gaps_days: [],
      rate_trend: rateTrend,
      completions_n: completions.length,
      stated_rate_per_month: stated,
    };
  }

  // Exponential recency weights — latest completion gap dominates.
  const weights = capped.map((_, i) => 0.5 ** (capped.length - 1 - i));
  const wsum = weights.reduce((a, b) => a + b, 0);
  let gapDays = 0;
  for (let i = 0; i < capped.length; i++) gapDays += (weights[i] / wsum) * capped[i];
  gapDays = Math.max(MIN_GAP_DAYS, gapDays);
  const rate = clip(30.0 / gapDays, MFR_RATE_BOUNDS[0], MFR_RATE_BOUNDS[1]);
  const latest = completions[completions.length - 1];
  return {
    rate_per_month: rate,
    gap_days: gapDays,
    source: "ship_completions",
    n_gaps: capped.length,
    latest_ship: latest.ship,
    latest_completed: isoFromOrd(latest.completed),
    recent_gaps_days: capped,
    rate_trend: rateTrend,
    completions_n: completions.length,
    stated_rate_per_month: stated,
  };
}

// --- Pipeline index ---

export interface PipelineEntry {
  flight_number: number;
  booster?: string | null;
  ship?: string | null;
  block?: number | null;
  pad?: string | null;
  readiness?: string | null;
  earliest_ready?: number | null; // ordinal
  notes?: string | null;
  risk_flags?: string[] | string | null;
  source?: string;
  lead_days?: number;
}

function staleReadyResidualDays(readiness: string | null | undefined, lead: Record<string, number>): number {
  const key = readiness || "pad_ready";
  if (key in STALE_READY_RESIDUAL_BY_READINESS) return STALE_READY_RESIDUAL_BY_READINESS[key];
  const leadDays = Number(lead[key] ?? 3);
  return Math.trunc(Math.max(0, Math.min(14, leadDays * 0.25)));
}

export function flightHasTrackedVehicle(fn: number, pipelineIndex: Map<number, PipelineEntry>): boolean {
  const entry = pipelineIndex.get(fn);
  if (!entry) return false;
  if (entry.source === "manufacturing_extend") return false;
  return Boolean(entry.ship || entry.booster);
}

const READINESS_RANK: Record<string, number> = {
  announced: 0,
  in_production: 1,
  ship_stacked: 2,
  cryo_complete: 3,
  static_fire_complete: 4,
  pad_ready: 5,
  flown: 6,
  projected: 0,
};

const EVENT_MAP: Record<string, string> = {
  stacking: "ship_stacked",
  cryo_test: "cryo_complete",
  static_fire: "static_fire_complete",
  rollout: "pad_ready",
  engine_install: "in_production",
};

export function buildPipelineIndex(
  pipeline: Pipeline,
  signals: Signal[],
  flights: Flight[],
  opts: {
    today: number;
    goalGap?: number;
    manufacturingRate?: number;
    startFn?: number | null;
    netAnchors?: Map<number, number>;
  }
): Map<number, PipelineEntry> {
  const today = opts.today;
  const lead = { ...(pipeline.readiness_lead_days ?? {}) } as Record<string, number>;
  const netAnchors = opts.netAnchors ?? new Map<number, number>();
  const index = new Map<number, PipelineEntry>();

  for (const v of pipeline.vehicles ?? []) {
    const fn = Number(v.flight_number);
    index.set(fn, {
      flight_number: fn,
      booster: v.booster ?? null,
      ship: v.ship ?? null,
      block: v.block ?? null,
      pad: v.pad ?? null,
      readiness: v.readiness ?? "in_production",
      earliest_ready: ordFromIso(v.earliest_ready ?? null),
      notes: v.notes ?? null,
      risk_flags: [...(v.risk_flags ?? [])],
      source: "pipeline_seed",
    });
  }

  for (const f of flights) {
    const fn = f.flight_number;
    const hasVehicle = Boolean(f.booster || f.ship);
    if (hasVehicle || f.pad || f.block != null) {
      // Pad/block alone must not invent an "announced" readiness floor.
      let entry: PipelineEntry;
      if (hasVehicle || f.launch_date) {
        entry = index.get(fn) ?? { flight_number: fn, readiness: "announced", source: "flights" };
        index.set(fn, entry);
      } else if (index.has(fn)) {
        entry = index.get(fn)!;
      } else {
        entry = { flight_number: fn, readiness: "projected", source: "flights" };
        index.set(fn, entry);
      }
      entry.booster = entry.booster || f.booster;
      entry.ship = entry.ship || f.ship;
      entry.pad = entry.pad || f.pad;
      entry.block = entry.block ?? f.block;
      if (f.launch_date) {
        entry.readiness = "flown";
        entry.earliest_ready = ordFromIso(f.launch_date);
      }
    }
  }

  for (const s of signals) {
    if (s.signal_type !== "vehicle_readiness") continue;
    if (s.flight_number == null) continue;
    const fn = Number(s.flight_number);
    const payload = s.payload ?? {};
    const newR = EVENT_MAP[String(payload["event"] ?? "")];
    if (!newR) continue;
    let entry = index.get(fn);
    if (!entry) {
      entry = { flight_number: fn, readiness: "announced", source: "signal" };
      index.set(fn, entry);
    }
    const old = entry.readiness ?? "announced";
    if ((READINESS_RANK[newR] ?? 0) >= (READINESS_RANK[old] ?? 0)) {
      entry.readiness = newR;
      entry.source = "signal";
      if (payload["serial"]) {
        if (payload["vehicle"] === "booster") entry.booster = String(payload["serial"]);
        else if (payload["vehicle"] === "ship") entry.ship = String(payload["serial"]);
      }
      const extracted = ordFromIso(String(s.extracted_at ?? "").slice(0, 10)) ?? today;
      const leadDays = Number(lead[newR] ?? 21);
      const candidate = extracted + Math.trunc(leadDays);
      const prev = entry.earliest_ready;
      if (prev == null || candidate < prev) entry.earliest_ready = candidate;
    }
  }

  // Stale earliest_ready: bump with a small residual, clamp to published NET.
  for (const [fn, entry] of index) {
    if (entry.readiness === "flown") continue;
    if (entry.readiness === "projected" && !entry.booster && !entry.ship) {
      entry.lead_days = Number(lead["in_production"] ?? 45);
      continue;
    }
    const er = entry.earliest_ready;
    if (er == null) {
      const leadDays = Number(lead[entry.readiness ?? "in_production"] ?? 45);
      entry.earliest_ready = today + Math.trunc(leadDays);
    } else if (er < today) {
      const residual = staleReadyResidualDays(entry.readiness, lead);
      entry.earliest_ready = today + residual;
      entry.notes = `${entry.notes ?? ""} · earliest_ready refreshed from stale seed`.replace(/^ ·\s*/, "");
    }
    const net = netAnchors.get(fn);
    if (net != null && net >= today && entry.earliest_ready != null && entry.earliest_ready > net) {
      entry.earliest_ready = net;
      entry.notes = `${entry.notes ?? ""} · earliest_ready clamped to published NET`.replace(/^ ·\s*/, "");
    }
    entry.lead_days = Number(lead[entry.readiness ?? "in_production"] ?? 30);
  }

  // Auto-extend manufacturing placeholders beyond seed / known max
  const mfr = Math.max(0.35, Number(opts.manufacturingRate ?? 1.0) || 1.0);
  const mfrGap = Math.max(MIN_GAP_DAYS, 30.0 / mfr);
  const knownFns = [...index.keys()].sort((a, b) => a - b);
  const lastFn = knownFns.length ? knownFns[knownFns.length - 1] : (opts.startFn ?? 1) - 1;
  const extendFrom = Math.max(lastFn + 1, opts.startFn ?? lastFn + 1);

  const nonFlown = [...index.values()].filter(
    (e) => e.readiness !== "flown" && e.earliest_ready != null
  );
  let cursor: number;
  let cursorFn: number;
  if (nonFlown.length) {
    const anchor = nonFlown.reduce((a, b) => (b.flight_number > a.flight_number ? b : a));
    cursor = anchor.earliest_ready as number;
    cursorFn = anchor.flight_number;
  } else {
    cursor = today;
    cursorFn = lastFn;
  }

  let lastBlock = 3;
  let lastPad = "OLP-2";
  if (knownFns.length) {
    const lastEntry = index.get(knownFns[knownFns.length - 1])!;
    lastBlock = Number(lastEntry.block ?? 3);
    lastPad = lastEntry.pad ?? lastPad;
  }

  const extendTo = (opts.startFn ?? extendFrom) + FLEET_EXTEND_FLIGHTS;
  for (let fn = extendFrom; fn < extendTo; fn++) {
    if (index.has(fn)) continue;
    const steps = fn - cursorFn;
    const earliest = cursor + Math.round(Math.max(1, steps) * mfrGap);
    index.set(fn, {
      flight_number: fn,
      booster: null,
      ship: null,
      block: lastBlock,
      pad: lastPad,
      readiness: "in_production",
      earliest_ready: earliest,
      notes: `Auto-extended from manufacturing rate (~${mfr.toFixed(2)}/mo)`,
      source: "manufacturing_extend",
      lead_days: Number(lead["in_production"] ?? 45),
    });
  }

  return index;
}

// --- Gap sampling / attainment ---

function sampleBlendedGap(
  recentGaps: number[],
  goalGap: number,
  rng: Rng,
  blend: number,
  shrink: number
): number {
  // Mixture-sample stated cadence goal vs recent observed gaps.
  const b = clip(blend, 0.0, 1.0);
  const sampledRecent = recentGaps.length ? recentGaps[rng.integers(0, recentGaps.length)] : goalGap;
  const sampledGoal = goalGap * rng.lognormal(0.0, 0.12);
  const mixed = rng.random() < b ? sampledGoal : sampledRecent;
  const jitter = rng.lognormal(0.0, 0.1);
  return Math.max(MIN_GAP_DAYS, mixed * jitter * shrink);
}

interface AttainmentParams {
  ratios: number[];
  mean: number;
  n: number;
  stated_goal_days: number;
  source: string;
}

export function estimateGoalAttainment(flights: Flight[], statedGoalDays: number): AttainmentParams {
  const goal = Math.max(1.0, statedGoalDays || DEFAULT_GOAL_GAP_DAYS);
  const clean = cleanInterFlightGaps(flights);
  const ratios = clean
    .filter((g) => g[1] > 0)
    .map((g) => clip(g[1] / goal, GOAL_ATTAINMENT_BOUNDS[0], GOAL_ATTAINMENT_BOUNDS[1]));
  const recent = ratios.slice(-RECENT_GAP_WINDOW);
  let m: number;
  if (recent.length) {
    m = 0.65 * mean(recent) + 0.35 * GOAL_ATTAINMENT_PRIOR;
  } else {
    m = GOAL_ATTAINMENT_PRIOR;
  }
  m = clip(m, GOAL_ATTAINMENT_BOUNDS[0], GOAL_ATTAINMENT_BOUNDS[1]);
  return {
    ratios: recent.length ? recent : ratios,
    mean: m,
    n: recent.length,
    stated_goal_days: goal,
    source: recent.length ? "history" : "prior",
  };
}

function sampleGoalAttainment(params: AttainmentParams, rng: Rng): number {
  let raw: number;
  if (params.ratios.length) {
    raw = rng.choice(params.ratios) * rng.lognormal(0.0, 0.12);
  } else {
    raw = (params.mean || GOAL_ATTAINMENT_PRIOR) * rng.lognormal(0.0, 0.18);
  }
  return clip(raw, GOAL_ATTAINMENT_BOUNDS[0], GOAL_ATTAINMENT_BOUNDS[1]);
}

export function hardwareEarliest(
  fn: number,
  pipelineIndex: Map<number, PipelineEntry>,
  goalGap: number
): number | null {
  const entry = pipelineIndex.get(fn);
  if (entry?.earliest_ready != null) return entry.earliest_ready;
  const known = [...pipelineIndex.values()]
    .filter((e) => e.earliest_ready != null && e.readiness !== "flown")
    .sort((a, b) => a.flight_number - b.flight_number);
  if (known.length) {
    const last = known[known.length - 1];
    const steps = fn - last.flight_number;
    if (steps > 0 && last.earliest_ready != null) {
      return last.earliest_ready + Math.round(steps * goalGap);
    }
  }
  return null;
}

// --- Scrub estimation ---

function scrubClassFromText(...parts: Array<string | null | undefined>): string {
  const text = parts.map((p) => String(p ?? "")).join(" ").toLowerCase();
  if (
    ["engine", "ignite", "ignition", "startup", "start-up", "raptor", "failed to light"].some((w) =>
      text.includes(w)
    )
  ) {
    return "long";
  }
  if (
    [
      "ground equipment",
      "ground support",
      "gse",
      "ground system",
      "pad ",
      "deluge",
      "quick disconnect",
    ].some((w) => text.includes(w))
  ) {
    return "short";
  }
  return "unknown";
}

function netRecycleDays(prevNet: string | null | undefined, newNet: string | null | undefined): number | null {
  const prev = prevNet ? Date.parse(prevNet) : NaN;
  const nxt = newNet ? Date.parse(newNet) : NaN;
  if (Number.isNaN(prev) || Number.isNaN(nxt)) return null;
  const days = (nxt - prev) / DAY_MS;
  return days >= 0.5 ? days : null;
}

function largestForwardRecycle(netHistory: NetHistoryRow[], flightNumber: number): number | null {
  const points: Array<[number, number]> = [];
  for (const h of netHistory) {
    if (h.flight_number !== flightNumber) continue;
    const obs = Date.parse(h.observed_at);
    const net = Date.parse(h.net_date);
    if (!Number.isNaN(obs) && !Number.isNaN(net)) points.push([obs, net]);
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a[0] - b[0]);
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    const delta = (points[i][1] - points[i - 1][1]) / DAY_MS;
    if (delta > best) best = delta;
  }
  return best >= 0.5 ? best : null;
}

export function openScrubFlights(signals: Signal[], flights: Flight[]): Set<number> {
  const flown = new Set(
    flights.filter((f) => f.launch_date || f.outcome).map((f) => Number(f.flight_number))
  );
  const out = new Set<number>();
  for (const s of signals) {
    if (s.signal_type !== "launch_scrub") continue;
    if (s.flight_number == null) continue;
    const fn = Number(s.flight_number);
    if (!flown.has(fn)) out.add(fn);
  }
  return out;
}

export interface ScrubParams {
  scrub_prob: number;
  scrub_extra_mean: number;
  short_mean_days: number;
  long_mean_days: number;
  p_long: number;
  n_attempts: number;
  n_scrubs: number;
  n_signal_scrubs: number;
  n_seed_scrubs: number;
  n_net_slip_scrubs: number;
  raw_rate?: number;
  open_scrub_flights: number[];
  source: string;
}

export function estimateScrubParams(
  netHistory: NetHistoryRow[],
  signals: Signal[],
  flights: Flight[]
): ScrubParams {
  interface ScrubEvent {
    flight_number: number;
    delay_days: number;
    klass: string;
    source: string;
  }
  const scrubEvents: ScrubEvent[] = [];
  const seenKeys = new Set<string>();

  for (const s of signals) {
    if (s.signal_type !== "launch_scrub") continue;
    if (s.flight_number == null) continue;
    const fn = Number(s.flight_number);
    const day =
      String(s.extracted_at ?? (s.article_published_at as string | undefined) ?? "").slice(0, 10) || "na";
    const key = `${fn}:${day}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const payload = s.payload ?? {};
    let delay = netRecycleDays(
      payload["previous_net_date"] as string | null,
      payload["new_net_date"] as string | null
    );
    if (delay === null) delay = largestForwardRecycle(netHistory, fn);
    const klass = scrubClassFromText(
      payload["reason"] as string,
      s.quote,
      payload["description"] as string
    );
    if (delay === null) {
      delay =
        klass === "long"
          ? SCRUB_LONG_MEAN_DAYS
          : klass === "short"
            ? SCRUB_SHORT_MEAN_DAYS
            : DEFAULT_SCRUB_EXTRA_MEAN;
    }
    scrubEvents.push({
      flight_number: fn,
      delay_days: clip(delay, SCRUB_DELAY_BOUNDS[0], SCRUB_DELAY_BOUNDS[1]),
      klass,
      source: "launch_scrub",
    });
  }

  // Seed / historical scrub_details on flights (pre-news-window backfill)
  let seedScrubCount = 0;
  for (const f of flights) {
    const fn = Number(f.flight_number);
    const details = f.scrub_details;
    if (Array.isArray(details) && details.length) {
      for (const d of details) {
        if (typeof d !== "object" || d === null) continue;
        const day = String(d.date ?? "").slice(0, 10) || "na";
        const key = `${fn}:${day}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const klassRaw = String(d.klass ?? scrubClassFromText(d.reason));
        const klass = ["short", "long", "unknown"].includes(klassRaw) ? klassRaw : "unknown";
        let delay = d.delay_days != null ? Number(d.delay_days) : null;
        if (delay === null) {
          delay =
            klass === "long"
              ? SCRUB_LONG_MEAN_DAYS
              : klass === "short"
                ? SCRUB_SHORT_MEAN_DAYS
                : DEFAULT_SCRUB_EXTRA_MEAN;
        }
        scrubEvents.push({
          flight_number: fn,
          delay_days: clip(delay, SCRUB_DELAY_BOUNDS[0], SCRUB_DELAY_BOUNDS[1]),
          klass,
          source: "seed",
        });
        seedScrubCount += 1;
      }
    } else if (f.scrubs) {
      const nSeed = Number(f.scrubs);
      for (let i = 0; i < nSeed; i++) {
        const key = `${fn}:seed-${i}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        scrubEvents.push({
          flight_number: fn,
          delay_days: DEFAULT_SCRUB_EXTRA_MEAN,
          klass: "unknown",
          source: "seed",
        });
        seedScrubCount += 1;
      }
    }
  }

  // Secondary: NET forward slips not already covered by a scrub signal
  const scrubbedFns = new Set(scrubEvents.map((e) => e.flight_number));
  const byFlight = new Map<number, Array<[number, number]>>();
  for (const h of netHistory) {
    const obs = Date.parse(h.observed_at);
    const net = Date.parse(h.net_date);
    if (h.flight_number == null || Number.isNaN(obs) || Number.isNaN(net)) continue;
    const list = byFlight.get(Number(h.flight_number)) ?? [];
    list.push([obs, net]);
    byFlight.set(Number(h.flight_number), list);
  }

  let netSlipScrubs = 0;
  const netSlipDays: number[] = [];
  let netAttempts = 0;
  for (const [fn, points] of byFlight) {
    points.sort((a, b) => a[0] - b[0]);
    if (points.length < 2) continue;
    for (let i = 1; i < points.length; i++) {
      const [prevObs, prevNet] = points[i - 1];
      const [obs, net] = points[i];
      const delta = (net - prevNet) / DAY_MS;
      const gapObs = (obs - prevObs) / DAY_MS;
      if (gapObs <= 0) continue;
      netAttempts += 1;
      if (delta >= 1.0 && !scrubbedFns.has(fn)) {
        netSlipScrubs += 1;
        netSlipDays.push(clip(delta, SCRUB_DELAY_BOUNDS[0], SCRUB_DELAY_BOUNDS[1]));
      }
    }
  }

  const nSignalScrubs = scrubEvents.filter((e) => e.source === "launch_scrub").length;
  const nSeedScrubs = seedScrubCount;
  const nSuccesses = flights.filter((f) => f.launch_date).length;
  let seedExtraAttempts = 0;
  for (const f of flights) {
    const attempts = f.attempts;
    const scrubsN = Number(f.scrubs ?? 0);
    if (attempts != null) seedExtraAttempts += Math.max(0, Number(attempts) - 1 - scrubsN);
  }
  const nEventScrubs = scrubEvents.length;
  const nScrubs = nEventScrubs + netSlipScrubs;
  const nAttempts =
    nScrubs + nSuccesses + seedExtraAttempts + Math.floor(Math.max(0, netAttempts - netSlipScrubs) / 4);

  const openScrubs = [...openScrubFlights(signals, flights)].sort((a, b) => a - b);

  if (nAttempts < 2 && nScrubs === 0) {
    return {
      scrub_prob: DEFAULT_SCRUB_PROB,
      scrub_extra_mean: DEFAULT_SCRUB_EXTRA_MEAN,
      short_mean_days: SCRUB_SHORT_MEAN_DAYS,
      long_mean_days: SCRUB_LONG_MEAN_DAYS,
      p_long: SCRUB_P_LONG_PRIOR,
      n_attempts: nAttempts,
      n_scrubs: 0,
      n_signal_scrubs: 0,
      n_seed_scrubs: 0,
      n_net_slip_scrubs: 0,
      open_scrub_flights: openScrubs,
      source: "default",
    };
  }

  const priorStrength = 4.0;
  const scrubProb = clip(
    (nScrubs + DEFAULT_SCRUB_PROB * priorStrength) / (Math.max(nAttempts, 1) + priorStrength),
    0.1,
    0.6
  );

  const longDelays = scrubEvents.filter((e) => e.klass === "long").map((e) => e.delay_days);
  const shortDelays = scrubEvents.filter((e) => e.klass === "short").map((e) => e.delay_days);
  const unknownDelays = scrubEvents.filter((e) => e.klass === "unknown").map((e) => e.delay_days);
  for (const d of unknownDelays) (d >= 7.0 ? longDelays : shortDelays).push(d);
  for (const d of netSlipDays) (d >= 7.0 ? longDelays : shortDelays).push(d);

  const nLong = longDelays.length;
  const nShort = shortDelays.length;
  const pLong = clip((nLong + SCRUB_P_LONG_PRIOR * 3.0) / (nLong + nShort + 3.0), 0.15, 0.75);
  const shortMean = clip(
    shortDelays.length ? mean(shortDelays) : SCRUB_SHORT_MEAN_DAYS,
    SCRUB_DELAY_BOUNDS[0],
    SCRUB_DELAY_BOUNDS[1]
  );
  const longMean = clip(
    longDelays.length ? mean(longDelays) : SCRUB_LONG_MEAN_DAYS,
    SCRUB_DELAY_BOUNDS[0],
    SCRUB_DELAY_BOUNDS[1]
  );
  const mixtureMean = pLong * longMean + (1.0 - pLong) * shortMean;

  return {
    scrub_prob: scrubProb,
    scrub_extra_mean: mixtureMean,
    short_mean_days: shortMean,
    long_mean_days: longMean,
    p_long: pLong,
    n_attempts: nAttempts,
    n_scrubs: nScrubs,
    n_signal_scrubs: nSignalScrubs,
    n_seed_scrubs: nSeedScrubs,
    n_net_slip_scrubs: netSlipScrubs,
    raw_rate: nScrubs / Math.max(nAttempts, 1),
    open_scrub_flights: openScrubs,
    source:
      (nSignalScrubs || nSeedScrubs) && netSlipScrubs
        ? "launch_scrub+seed+net"
        : nSignalScrubs || nSeedScrubs
          ? "launch_scrub+seed"
          : "net_history",
  };
}

function sampleScrubExtraDays(params: ScrubParams, rng: Rng): number {
  const pLong = params.p_long || SCRUB_P_LONG_PRIOR;
  const meanDays =
    rng.random() < pLong
      ? params.long_mean_days || SCRUB_LONG_MEAN_DAYS
      : params.short_mean_days || SCRUB_SHORT_MEAN_DAYS;
  return clip(rng.exponential(Math.max(1.0, meanDays)), SCRUB_DELAY_BOUNDS[0], SCRUB_DELAY_BOUNDS[1]);
}

function scrubProbabilityForFlight(fn: number, baseP: number, openScrubs: Set<number>): number {
  let p = baseP;
  if (openScrubs.has(fn)) p = Math.min(0.65, p + SCRUB_RETRY_PROB_BUMP);
  return p;
}

// --- Anchors, slips, pads ---

export function netAnchorsByFlight(flights: Flight[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of flights) {
    if (f.launch_date) continue;
    const d = ordFromIso(f.net_date);
    if (d !== null) out.set(Number(f.flight_number), d);
  }
  return out;
}

export function slipByFlight(netHistory: NetHistoryRow[]): Map<number, number> {
  const byFn = new Map<number, NetHistoryRow[]>();
  for (const h of netHistory) {
    if (h.flight_number == null) continue;
    const list = byFn.get(Number(h.flight_number)) ?? [];
    list.push(h);
    byFn.set(Number(h.flight_number), list);
  }
  const out = new Map<number, number>();
  for (const [fn, hist] of byFn) out.set(fn, slipVelocityDaysPerWeek(hist));
  return out;
}

function padForFlight(fn: number, pipelineIndex: Map<number, PipelineEntry>, flights: Flight[]): string {
  const entry = pipelineIndex.get(fn);
  if (entry?.pad) return String(entry.pad);
  for (const f of flights) {
    if (Number(f.flight_number) === fn && f.pad) return String(f.pad);
  }
  const flownPads = flights.filter((f) => f.launch_date && f.pad).map((f) => String(f.pad));
  return flownPads.length ? flownPads[flownPads.length - 1] : "OLP-2";
}

export function blockForFlight(
  fn: number,
  pipelineIndex: Map<number, PipelineEntry>,
  flights: Flight[]
): number {
  const entry = pipelineIndex.get(fn);
  if (entry?.block != null) return Number(entry.block);
  for (const f of flights) {
    if (Number(f.flight_number) === fn && f.block != null) return Number(f.block);
  }
  return 3;
}

function padCatalog(pipeline: Pipeline): Record<string, Record<string, unknown>> {
  const raw = pipeline.pads ?? {};
  return typeof raw === "object" && raw !== null ? (raw as Record<string, Record<string, unknown>>) : {};
}

function padSite(pad: string, pipeline: Pipeline): string {
  const info = padCatalog(pipeline)[pad] ?? {};
  const site = String(info["site"] ?? "").trim().toLowerCase();
  if (site) return site;
  if (pad.toUpperCase().startsWith("OLP")) return SITE_STARBASE;
  if (pad.toUpperCase() === FLORIDA_FIRST_PAD || pad.toUpperCase().includes("39A")) return SITE_FLORIDA;
  return SITE_STARBASE;
}

function padAvailableFrom(pad: string, pipeline: Pipeline): number | null {
  const info = padCatalog(pipeline)[pad] ?? {};
  return ordFromIso((info["available_after"] as string) ?? null);
}

function samplePadAvailableAfter(pad: string, pipeline: Pipeline, rng: Rng, today: number): number | null {
  const base = padAvailableFrom(pad, pipeline);
  if (base === null) return null;
  if (base <= today) return base;
  // Lognormal right skew: median near 0 slip, long retrofit-delay tail
  let slip = rng.lognormal(0.0, 0.85) - 1.0;
  slip = clip(slip * PAD_AVAIL_SIGMA_DAYS, 0.0, PAD_AVAIL_MAX_SLIP_DAYS);
  return base + Math.round(slip);
}

function operationalPadCount(pipeline: Pipeline, asOf: number): number {
  const pads = padCatalog(pipeline);
  const names = Object.keys(pads);
  if (!names.length) return 1;
  let n = 0;
  for (const name of names) {
    if (padSite(name, pipeline) !== SITE_STARBASE) continue;
    const info = pads[name];
    const status = String(info["status"] ?? "operational").toLowerCase();
    if (["retrofit", "offline", "closed", "commissioning"].includes(status)) {
      const avail = ordFromIso((info["available_after"] as string) ?? null);
      if (avail === null || avail > asOf) continue;
    }
    n += 1;
  }
  return Math.max(1, n);
}

function turnaroundDaysFor(asOf: number, pipeline: Pipeline): number {
  return operationalPadCount(pipeline, asOf) >= 2 ? DUAL_PAD_TURNAROUND_DAYS : PAD_TURNAROUND_DAYS;
}

function hwReadySigmaDays(readiness: string | null | undefined): number {
  const key = readiness || "in_production";
  return HW_READY_SIGMA_BY_READINESS[key] ?? HW_READY_SIGMA_DAYS;
}

function netSlipAdjustmentDays(net: number, slipV: number, rng: Rng, today: number): number {
  // Scale slip velocity by weeks until NET (not a single-week cap).
  const v = Math.max(0.0, slipV);
  const weeksUntil = Math.max(0.0, (net - today) / 7.0);
  const raw = v * weeksUntil * rng.uniform(0.0, 1.0);
  return clip(raw, 0.0, NET_SLIP_MAX_DAYS);
}

// --- Main projection ---

export interface ProjectOptions {
  today?: number; // ordinal
  horizon?: number; // ordinal
  nSims?: number;
  seed?: number;
  pipeline?: Pipeline;
  goalBlend?: number;
  enableMishaps?: boolean;
}

export function projectCadence(
  flights: Flight[],
  signals: Signal[] = [],
  netHistoryRows: NetHistoryRow[] = [],
  opts: ProjectOptions = {}
): Record<string, unknown> {
  const today = opts.today ?? Math.floor(Date.now() / DAY_MS);
  const horizon = opts.horizon ?? (ordFromIso("2026-12-31") as number);
  const nSims = opts.nSims ?? 2000;
  const seed = opts.seed ?? 42;
  const goalBlend = opts.goalBlend ?? DEFAULT_GOAL_BLEND;
  const enableMishaps = opts.enableMishaps ?? true;
  const rng = new Rng(seed);

  const pipeline = opts.pipeline ?? loadPipeline();
  const goal = resolveGoal(pipeline, signals, today);
  const goalGap = goal.target_gap_days;
  const statedMfrRate = goal.manufacturing_rate_rockets_per_month || 1.0;

  const flown = flights.filter((f) => f.launch_date);
  const upcoming = flights.filter((f) => !f.launch_date && !f.outcome);
  const allGaps = cleanInterFlightGaps(flights);
  const rawGapCount = interFlightGaps(flights).length;

  let nextFlight: { flight_number: number; block?: number | null; pad?: string | null };
  if (upcoming.length) {
    nextFlight = upcoming.reduce((a, b) => (b.flight_number < a.flight_number ? b : a));
  } else if (flown.length) {
    const last = flown[flown.length - 1];
    nextFlight = {
      flight_number: Math.max(...flown.map((f) => f.flight_number)) + 1,
      block: last.block ?? 3,
      pad: last.pad,
    };
  } else {
    nextFlight = { flight_number: 1, block: 3, pad: "OLP-2" };
  }

  const startFn = Number(nextFlight.flight_number);
  let startBlock = upcoming.length
    ? blockForFlight(startFn, new Map(), flights)
    : Number(nextFlight.block ?? 3);
  const anchors = netAnchorsByFlight(flights);

  const mfrEst = estimateShipProductionRate(flights, pipeline, signals, today, startBlock, statedMfrRate);
  const mfrRate = mfrEst.rate_per_month;
  const mfrGapFloor = mfrEst.gap_days;

  const pipelineIndex = buildPipelineIndex(pipeline, signals, flights, {
    today,
    goalGap,
    manufacturingRate: mfrRate,
    startFn,
    netAnchors: anchors,
  });
  startBlock = blockForFlight(startFn, pipelineIndex, flights);

  const recentGaps = recentOperationalGaps(allGaps, { block: startBlock });
  const recentMean = recentGaps.length ? mean(recentGaps) : goalGap;
  const attainment = estimateGoalAttainment(flights, goalGap);

  const mishap = estimateMishapParams(flights, startBlock);
  const invMean = mishap.inv_mean;
  const invStd = mishap.inv_std;
  const basePMishap = mishap.p_mishap;

  // FAA open/close scan
  let openFaa = false;
  let faaJustClosed = false;
  let staticFireReady = false;
  let readinessEvents = 0;
  const flownByFn = new Map(flown.map((f) => [Number(f.flight_number), f]));
  const nowDt = new Date(today * DAY_MS);
  for (const s of sortedFaaSignals(signals)) {
    const payload = s.payload ?? {};
    const action = payload["action"];
    let fn = s.flight_number;
    if (fn == null && flownByFn.size) fn = Math.max(...flownByFn.keys());
    const target = fn != null ? flownByFn.get(Number(fn)) : undefined;
    const inv = target?.investigation ?? null;
    if (action === "investigation_opened" || action === "grounding") {
      if (target && investigationClosed(inv, nowDt) && !reopenAfterSeedClose(s, inv, nowDt)) {
        continue;
      }
      openFaa = true;
      faaJustClosed = false;
    }
    if (action === "investigation_closed" || action === "clearance") {
      faaJustClosed = true;
      openFaa = false;
    }
  }
  for (const s of signals) {
    if (s.signal_type === "vehicle_readiness") {
      readinessEvents += 1;
      if ((s.payload ?? {})["event"] === "static_fire") staticFireReady = true;
    }
  }

  let residualFaaDays = 0.0;
  let faaClosedDate: number | null = null;
  for (const f of flown) {
    const inv = f.investigation;
    if (!inv) continue;
    if (inv.closed == null && inv.opened == null) continue;
    const closed = ordFromIso(inv.closed ?? null);
    const opened = ordFromIso(inv.opened ?? null);
    if (closed !== null && closed <= today) {
      if (faaClosedDate === null || closed > faaClosedDate) faaClosedDate = closed;
      continue;
    }
    if (closed === null || closed > today) {
      openFaa = true;
      // Remaining hold: expected total − elapsed since open
      const total = Number(inv.days ?? invMean);
      const elapsed = opened !== null ? today - opened : 0;
      residualFaaDays = Math.max(residualFaaDays, Math.max(0.0, total - elapsed));
    }
  }
  if (faaJustClosed && faaClosedDate === null) faaClosedDate = today;

  let shrink = 1.0;
  if (staticFireReady || faaJustClosed) shrink = 0.9;
  if (readinessEvents >= 3) shrink *= 0.95;

  let effectiveBlend = goalBlend;
  if (!openFaa) effectiveBlend = Math.min(0.75, goalBlend + 0.08);

  const delayExtra = openFaa ? residualFaaDays : 0.0;

  const attainedGoal = goalGap * attainment.mean;
  const blendedMean = effectiveBlend * attainedGoal + (1.0 - effectiveBlend) * recentMean;

  const scrub = estimateScrubParams(netHistoryRows, signals, flights);
  const scrubProb = scrub.scrub_prob;
  const scrubExtraMean = scrub.scrub_extra_mean;
  const openScrubs = new Set(scrub.open_scrub_flights);
  const slips = slipByFlight(netHistoryRows);
  const rtf = estimateReturnToFlightParams(flights);

  // Initial pad occupancy from last flown launches
  const padLastInit = new Map<string, number>();
  for (const f of [...flown].sort((a, b) => a.flight_number - b.flight_number)) {
    const pad = f.pad;
    const ld = ordFromIso(f.launch_date);
    if (pad && ld !== null) padLastInit.set(String(pad), ld);
  }

  const flownDates = flown.map((f) => ordFromIso(f.launch_date)).filter((d): d is number => d !== null);
  const lastLaunch = flownDates.length ? Math.max(...flownDates) : today;
  const maxFuture = 24;

  // Month keys from today to horizon
  const months: string[] = [];
  {
    let y = yearOfOrd(today);
    let m = monthOfOrd(today);
    while (Date.UTC(y, m - 1, 1) <= horizon * DAY_MS) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  const allCounts = new Array<number>(nSims).fill(0);
  const mishapCounts = new Array<number>(nSims).fill(0);
  const perFlightDates = new Map<number, number[]>();
  for (let i = 0; i < maxFuture; i++) perFlightDates.set(startFn + i, []);
  const monthly = new Map<string, number[]>();
  for (const key of months) monthly.set(key, new Array<number>(nSims).fill(0));

  const calendarYear = yearOfOrd(today);
  const firstMonthKey = months.length ? months[0] : null;
  let yearBaseline = 0;
  for (const f of flown) {
    const ld = ordFromIso(f.launch_date);
    if (ld === null || yearOfOrd(ld) !== calendarYear) continue;
    const key = monthKeyOfOrd(ld);
    if (firstMonthKey && key < firstMonthKey) yearBaseline += 1;
  }

  const padNames = Object.keys(padCatalog(pipeline));
  const gapsByBlockCache = new Map<number, number[]>();
  const gapsForBlock = (block: number): number[] => {
    let cached = gapsByBlockCache.get(block);
    if (!cached) {
      cached = recentOperationalGaps(allGaps, { block });
      gapsByBlockCache.set(block, cached);
    }
    return cached;
  };

  // --- Per-flight precomputation ---
  // The Python model resolves pad/block/mishap/hardware per sim step by
  // rescanning flights + pipeline; at 2k sims x ~20 steps that dominates CPU.
  // All of it is sim-invariant, so hoist into idx = fn - startFn arrays.
  const FN_SPAN = maxFuture + 1;
  const padByFn = new Array<string>(FN_SPAN);
  const blockByFn = new Array<number>(FN_SPAN);
  const trackedByFn = new Array<boolean>(FN_SPAN);
  const pMishapByFn = new Array<number>(FN_SPAN);
  const readinessByFn = new Array<string | null>(FN_SPAN);
  const gapsByFn = new Array<number[]>(FN_SPAN);
  const hwBaseByFn = new Array<number | null>(FN_SPAN);
  const anchorByFn = new Array<number | null>(FN_SPAN);
  const slipVByFn = new Array<number>(FN_SPAN);
  const pScrubByFn = new Array<number>(FN_SPAN);
  for (let i = 0; i < FN_SPAN; i++) {
    const fn = startFn + i;
    padByFn[i] = padForFlight(fn, pipelineIndex, flights);
    blockByFn[i] = blockForFlight(fn, pipelineIndex, flights);
    trackedByFn[i] = flightHasTrackedVehicle(fn, pipelineIndex);
    pMishapByFn[i] = mishapProbabilityForFlight(fn, basePMishap, pipelineIndex, flights);
    readinessByFn[i] = pipelineIndex.get(fn)?.readiness ?? null;
    gapsByFn[i] = gapsForBlock(blockByFn[i]);
    hwBaseByFn[i] = pipelineIndex.get(fn)?.earliest_ready ?? null;
    anchorByFn[i] = anchors.get(fn) ?? null;
    slipVByFn[i] = Math.max(0.0, slips.get(fn) ?? 0.0);
    pScrubByFn[i] = scrubProbabilityForFlight(fn, scrubProb, openScrubs);
  }
  // Extrapolation anchor for flights beyond the pipeline index (goal-gap scaled).
  const knownHw = [...pipelineIndex.values()]
    .filter((e) => e.earliest_ready != null && e.readiness !== "flown")
    .sort((a, b) => a.flight_number - b.flight_number);
  const hwAnchorEntry = knownHw.length ? knownHw[knownHw.length - 1] : null;
  const hwEarliestFor = (idx: number, goalGapSim: number): number | null => {
    const base = hwBaseByFn[idx];
    if (base != null) return base;
    if (hwAnchorEntry?.earliest_ready != null) {
      const steps = startFn + idx - hwAnchorEntry.flight_number;
      if (steps > 0) return hwAnchorEntry.earliest_ready + Math.round(steps * goalGapSim);
    }
    return null;
  };
  // Transition class fn→fn+1: 0 none, 1 block, 2 pad, 3 both (draws stay per-sim).
  const transitionKindByFn = new Array<number>(FN_SPAN - 1);
  for (let i = 0; i < FN_SPAN - 1; i++) {
    const blockChange = blockByFn[i + 1] !== blockByFn[i];
    const padChange = padByFn[i + 1] !== padByFn[i];
    transitionKindByFn[i] = blockChange && padChange ? 3 : blockChange ? 1 : padChange ? 2 : 0;
  }
  const sampleTransition = (kind: number): number => {
    if (kind === 0) return 0.0;
    if (kind === 3) return 110.0 * rng.lognormal(0.0, 0.6); // gen + pad commissioning
    if (kind === 1) return BLOCK_TRANSITION_EXTRA_DAYS * rng.lognormal(0.0, 0.4);
    return PAD_CHANGE_EXTRA_DAYS * rng.lognormal(0.0, 0.35);
  };
  let firstTransitionKind = 0;
  if (flown.length) {
    const prevFn = Math.max(...flown.map((f) => Number(f.flight_number)));
    const blockChange = blockByFn[0] !== blockForFlight(prevFn, pipelineIndex, flights);
    const padChange = padByFn[0] !== padForFlight(prevFn, pipelineIndex, flights);
    firstTransitionKind = blockChange && padChange ? 3 : blockChange ? 1 : padChange ? 2 : 0;
  }
  // Month index by day ordinal (avoids Date construction per sim step).
  const monthIdxByOrd = new Int32Array(Math.max(1, horizon - today + 1)).fill(-1);
  {
    const keyToIdx = new Map(months.map((k, i) => [k, i]));
    for (let o = today; o <= horizon; o++) {
      monthIdxByOrd[o - today] = keyToIdx.get(monthKeyOfOrd(o)) ?? -1;
    }
  }
  const monthlyArrays = months.map((k) => monthly.get(k) as number[]);
  const perFlightArrs = Array.from(
    { length: maxFuture },
    (_, i) => perFlightDates.get(startFn + i) as number[]
  );
  // Integer pad ids + typed arrays: per-step string-keyed Map get/set is the
  // hot loop's dominant cost at 2k sims.
  const padIdOf = new Map<string, number>();
  const padId = (name: string): number => {
    let id = padIdOf.get(name);
    if (id == null) {
      id = padIdOf.size;
      padIdOf.set(name, id);
    }
    return id;
  };
  for (const name of padNames) padId(name);
  for (const name of padLastInit.keys()) padId(name);
  const padIdByFn = new Int32Array(FN_SPAN);
  for (let i = 0; i < FN_SPAN; i++) padIdByFn[i] = padId(padByFn[i]);
  const NPADS = padIdOf.size;
  const NEG = -1e9;
  const padLastInitArr = new Float64Array(NPADS).fill(NEG);
  for (const [name, d] of padLastInit) padLastInitArr[padId(name)] = d;
  // Constant availability floors (already-passed dates); sampled slips only
  // for future retrofit windows.
  const padAvailConstArr = new Float64Array(NPADS).fill(NEG);
  const padSampled: Array<[id: number, baseOrd: number]> = [];
  for (const name of padNames) {
    const base = padAvailableFrom(name, pipeline);
    if (base === null) continue;
    if (base <= today) padAvailConstArr[padId(name)] = base;
    else padSampled.push([padId(name), base]);
  }
  // Operational-pad-count transitions (Starbase only) for turnaround lookups.
  let padAlwaysOn = 0;
  const padGatedAvail: number[] = [];
  for (const name of padNames) {
    if (padSite(name, pipeline) !== SITE_STARBASE) continue;
    const info = padCatalog(pipeline)[name];
    const status = String(info["status"] ?? "operational").toLowerCase();
    if (["retrofit", "offline", "closed", "commissioning"].includes(status)) {
      const avail = ordFromIso((info["available_after"] as string) ?? null);
      if (avail !== null) padGatedAvail.push(avail);
    } else {
      padAlwaysOn += 1;
    }
  }
  const turnaroundAt = (asOf: number): number => {
    let n = padAlwaysOn;
    for (const a of padGatedAvail) if (a <= asOf) n += 1;
    return Math.max(1, n) >= 2 ? DUAL_PAD_TURNAROUND_DAYS : PAD_TURNAROUND_DAYS;
  };
  const applyPadTurnaroundFast = (
    candidate: number,
    pid: number,
    padLastArr: Float64Array,
    padAvailArr: Float64Array
  ): number => {
    let out = candidate;
    const avail = padAvailArr[pid];
    if (avail > NEG) out = Math.max(out, avail);
    const last = padLastArr[pid];
    if (last > NEG) out = Math.max(out, last + Math.trunc(turnaroundAt(out)));
    return out;
  };
  const applyNetAnchorFast = (candidate: number, idx: number): number => {
    const net = anchorByFn[idx];
    if (net == null) return candidate;
    const slipAdj = netSlipAdjustmentDays(net, slipVByFn[idx], rng, today);
    let anchored = net + Math.round(slipAdj);
    if (anchored < today) anchored = today + rng.integers(1, 7);
    anchored += Math.trunc(rng.exponential(NET_DELAY_JITTER_MEAN));
    if (rng.random() < pScrubByFn[idx]) {
      anchored += Math.trunc(sampleScrubExtraDays(scrub, rng));
    }
    return Math.max(candidate, anchored);
  };

  const jitterHw = (hwDate: number, readiness: string | null | undefined): number => {
    const sigma = hwReadySigmaDays(readiness);
    // Right-skew for fuzzy readiness (in_production); symmetric for pad_ready
    const jitter =
      sigma >= 10.0 ? (rng.lognormal(0.0, 0.55) - 1.0) * sigma : rng.normal(0.0, sigma);
    const jittered = hwDate + Math.round(jitter);
    return Math.max(jittered, today + 1);
  };

  const net0 = anchors.get(startFn) ?? null;
  const refForNet = faaClosedDate ?? today;
  const nearTermNet = net0 !== null && net0 >= today && net0 - refForNet <= RTF_NET_SKIP_DAYS;
  const nearTermNetHw = net0 !== null && net0 >= today && net0 - today <= HW_NET_SKIP_DAYS;

  // Reused per-sim buffers (avoid 2 allocations x nSims of GC pressure)
  const padLastArr = new Float64Array(NPADS);
  const padAvailArr = new Float64Array(NPADS);

  for (let sim = 0; sim < nSims; sim++) {
    // Goal-miss regime: this path runs at historical tempo only.
    const goalMiss = rng.random() < GOAL_MISS_PROB;
    const simBlend = goalMiss ? 0.0 : effectiveBlend;
    const att = goalMiss ? 1.0 : sampleGoalAttainment(attainment, rng);
    const simGoal = sampleGoalGap(goalGap * att, rng);
    // Regime multiplier dropped in the Workers port (accepted simplification).
    const simShrink = shrink;

    padLastArr.set(padLastInitArr);
    // Per-sim soft pad availability: lognormal right skew — median near 0
    // slip, long retrofit-delay tail (same math as samplePadAvailableAfter).
    padAvailArr.set(padAvailConstArr);
    for (const [pid, baseOrd] of padSampled) {
      const slip = clip(
        (rng.lognormal(0.0, 0.85) - 1.0) * PAD_AVAIL_SIGMA_DAYS,
        0.0,
        PAD_AVAIL_MAX_SLIP_DAYS
      );
      padAvailArr[pid] = baseOrd + Math.round(slip);
    }

    let holdUntil: number | null = null;
    if (openFaa && (delayExtra > 0 || invMean > 0)) {
      const holdDays = sampleOpenFaaHoldDays(delayExtra, invMean, invStd, rng);
      holdUntil = today + Math.trunc(holdDays);
      if (holdUntil < today) holdUntil = today + rng.integers(3, 14);
    }

    // First flight date
    let d0: number;
    if (net0 !== null && net0 >= today) {
      const slipAdj = netSlipAdjustmentDays(net0, slipVByFn[0], rng, today);
      d0 = net0 + Math.round(slipAdj);
      d0 += Math.trunc(rng.exponential(NET_DELAY_JITTER_MEAN));
      // Post-scrub NET already prices the recycle; only model a *second*
      // scrub on that attempt (elevated p, mixture delay).
      if (rng.random() < pScrubByFn[0]) {
        d0 += Math.trunc(sampleScrubExtraDays(scrub, rng));
      }
    } else {
      let gap = sampleBlendedGap(gapsByFn[0], simGoal, rng, simBlend, simShrink);
      gap += sampleTransition(firstTransitionKind);
      d0 = lastLaunch + Math.trunc(gap);
      if (d0 < today) d0 = today + rng.integers(3, 14);
    }

    // Post-mishap / post-clearance return-to-flight
    if (holdUntil !== null) {
      if (nearTermNet) {
        d0 = Math.max(d0, holdUntil);
      } else {
        const rtfDays = sampleReturnToFlightDays(rtf, rng);
        d0 = Math.max(d0, holdUntil + Math.trunc(rtfDays));
      }
    } else if (faaJustClosed && faaClosedDate !== null && !nearTermNet) {
      const rtfDays = sampleReturnToFlightDays(rtf, rng);
      d0 = Math.max(d0, faaClosedDate + Math.trunc(rtfDays));
    }

    // (weather_hazard hold dropped in the Workers port)

    // Firm near-term NET already encodes readiness; jitter/scrub handle slip.
    if (!nearTermNetHw) {
      let hw0 = hwEarliestFor(0, simGoal);
      if (hw0 !== null) {
        hw0 = jitterHw(hw0, readinessByFn[0]);
        if (d0 < hw0) d0 = hw0;
      }
    }

    d0 = applyPadTurnaroundFast(d0, padIdByFn[0], padLastArr, padAvailArr);
    // (hurricane-season climatology dropped in the Workers port)

    let cursor = d0;
    let idx = 0; // fn - startFn
    let count = 0;
    let simMishaps = 0;

    while (cursor <= horizon && idx < maxFuture) {
      perFlightArrs[idx].push(cursor);
      const mIdx = cursor >= today ? monthIdxByOrd[cursor - today] : -1;
      if (mIdx >= 0) monthlyArrays[mIdx][sim] += 1;
      count += 1;
      padLastArr[padIdByFn[idx]] = cursor;

      // Stochastic mishap → investigation hold + short return-to-flight
      let nextHold: number | null = null;
      if (enableMishaps && rng.random() < pMishapByFn[idx]) {
        const invD = sampleInvestigationDays(mishap, rng);
        const rtfDays = sampleReturnToFlightDays(rtf, rng);
        nextHold = cursor + Math.trunc(invD + rtfDays);
        simMishaps += 1;
      }

      let gap = sampleBlendedGap(gapsByFn[idx + 1], simGoal, rng, simBlend, simShrink);
      // Fleet / manufacturing floor only for untracked placeholders.
      if (!trackedByFn[idx + 1]) {
        gap = Math.max(gap, mfrGapFloor * rng.uniform(0.85, 1.05));
      }
      gap += sampleTransition(transitionKindByFn[idx]);
      let nextCursor = cursor + Math.trunc(Math.max(MIN_GAP_DAYS, gap));

      if (nextHold !== null && nextCursor < nextHold) nextCursor = nextHold;

      const netNext = anchorByFn[idx + 1];
      const nearTermNext = netNext !== null && netNext >= today && netNext - today <= HW_NET_SKIP_DAYS;
      if (!nearTermNext) {
        let hw = hwEarliestFor(idx + 1, simGoal);
        if (hw !== null) {
          hw = jitterHw(hw, readinessByFn[idx + 1]);
          if (nextCursor < hw) {
            if (rng.random() < 0.15) {
              nextCursor = Math.max(hw - rng.integers(0, 5), cursor + Math.trunc(MIN_GAP_DAYS));
            } else {
              nextCursor = Math.max(hw, cursor + Math.trunc(MIN_GAP_DAYS));
            }
          }
        }
      }

      nextCursor = applyPadTurnaroundFast(nextCursor, padIdByFn[idx + 1], padLastArr, padAvailArr);
      nextCursor = applyNetAnchorFast(nextCursor, idx + 1);

      cursor = nextCursor;
      idx += 1;
    }

    allCounts[sim] = count;
    mishapCounts[sim] = simMishaps;
  }

  const alreadyFlown = flown.length;
  const totalByEoy = allCounts.map((c) => alreadyFlown + c);

  const cumByMonth = new Map<string, number[]>();
  {
    let running = new Array<number>(nSims).fill(yearBaseline);
    for (const key of months) {
      const arr = monthly.get(key) as number[];
      running = running.map((v, i) => v + arr[i]);
      cumByMonth.set(key, running);
    }
  }
  const calendarYearByEoy = months.length
    ? (cumByMonth.get(months[months.length - 1]) as number[])
    : new Array<number>(nSims).fill(yearBaseline);

  const quantiles = (arr: number[]) => {
    const sorted = Float64Array.from(arr).sort();
    return {
      p10: quantileSorted(sorted, 0.1),
      p50: quantileSorted(sorted, 0.5),
      p75: quantileSorted(sorted, 0.75),
      p90: quantileSorted(sorted, 0.9),
      mean: mean(arr),
    };
  };

  const withMcSe = (arr: number[]) => {
    const q = quantiles(arr) as Record<string, number>;
    q["mc_se_mean"] = arr.length > 1 ? std(arr, 1) / Math.sqrt(arr.length) : 0.0;
    return q;
  };

  const withMode = (arr: number[]) => {
    const q = withMcSe(arr);
    if (!arr.length) {
      q["mode"] = 0.0;
      q["p_mode"] = 0.0;
      return q;
    }
    const counts = new Map<number, number>();
    for (const v of arr) {
      const k = Math.trunc(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let modeVal = 0;
    let modeCount = -1;
    for (const [k, c] of counts) {
      if (c > modeCount || (c === modeCount && k < modeVal)) {
        modeVal = k;
        modeCount = c;
      }
    }
    q["mode"] = modeVal;
    q["p_mode"] = modeCount / arr.length;
    return q;
  };

  const monthlyExpected = months.map((key) => {
    const arr = monthly.get(key) as number[];
    const cum = cumByMonth.get(key) as number[];
    const sortedArr = Float64Array.from(arr).sort();
    const sortedCum = Float64Array.from(cum).sort();
    return {
      month: key,
      expected: mean(arr),
      p10: quantileSorted(sortedArr, 0.1),
      p50: quantileSorted(sortedArr, 0.5),
      p75: quantileSorted(sortedArr, 0.75),
      p90: quantileSorted(sortedArr, 0.9),
      cum_p10: quantileSorted(sortedCum, 0.1),
      cum_p50: quantileSorted(sortedCum, 0.5),
      cum_p75: quantileSorted(sortedCum, 0.75),
      cum_p90: quantileSorted(sortedCum, 0.9),
      cum_expected: mean(cum),
    };
  });

  const flightDistributions: Array<Record<string, unknown>> = [];
  for (const [fn, datesList] of perFlightDates) {
    if (!datesList.length) continue;
    const pByEoy = datesList.length / nSims;
    const ords = Float64Array.from(datesList).sort();
    const q = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => quantileSorted(ords, p));
    const nHit = ords.length;
    const s = nHit > 1 ? std(ords, 1) : 0.0;
    // Asymptotic SE of the sample median (≈ 1.253 σ / √n for normal-ish)
    const p50Se = nHit > 1 ? (1.253 * s) / Math.sqrt(nHit) : 0.0;
    // Downsample for shape parity with the Python payload
    let sampleOrds: number[];
    if (nHit <= 256) {
      sampleOrds = Array.from(ords, (x) => Math.trunc(x));
    } else {
      sampleOrds = [];
      for (let i = 0; i < 256; i++) {
        const idx = Math.trunc((i * (nHit - 1)) / 255);
        sampleOrds.push(Math.trunc(ords[idx]));
      }
    }
    const hw = pipelineIndex.get(fn);
    flightDistributions.push({
      flight_number: fn,
      p_by_eoy: pByEoy,
      p_first_florida: 0.0, // Florida-first sub-model dropped in the Workers port
      date_p10: isoFromOrd(Math.trunc(q[0])),
      date_p25: isoFromOrd(Math.trunc(q[1])),
      date_p50: isoFromOrd(Math.trunc(q[2])),
      date_p75: isoFromOrd(Math.trunc(q[3])),
      date_p90: isoFromOrd(Math.trunc(q[4])),
      date_p50_se_days: Math.round(p50Se * 100) / 100,
      n_samples: nHit,
      sample_ordinals: sampleOrds,
      net_anchor: anchors.has(fn) ? isoFromOrd(anchors.get(fn) as number) : null,
      p_mishap: enableMishaps
        ? mishapProbabilityForFlight(fn, basePMishap, pipelineIndex, flights)
        : 0.0,
      hardware: hw
        ? {
            booster: hw.booster ?? null,
            ship: hw.ship ?? null,
            block: hw.block ?? null,
            pad: hw.pad ?? null,
            readiness: hw.readiness ?? null,
            earliest_ready: hw.earliest_ready != null ? isoFromOrd(hw.earliest_ready) : null,
            risk_flags: hw.risk_flags ?? [],
          }
        : null,
    });
  }
  flightDistributions.sort(
    (a, b) => Number(a["flight_number"]) - Number(b["flight_number"])
  );

  const pipelineSummary = [...pipelineIndex.values()]
    .sort((a, b) => a.flight_number - b.flight_number)
    .filter((e) => e.readiness !== "flown" && e.flight_number >= startFn)
    .slice(0, FLEET_EXTEND_FLIGHTS)
    .map((e) => ({
      flight_number: e.flight_number,
      booster: e.booster ?? null,
      ship: e.ship ?? null,
      block: e.block ?? null,
      pad: e.pad ?? null,
      readiness: e.readiness ?? null,
      earliest_ready: e.earliest_ready != null ? isoFromOrd(e.earliest_ready) : null,
      notes: e.notes ?? null,
      risk_flags: e.risk_flags ?? [],
      source: e.source ?? null,
    }));

  const padsState: Record<string, unknown> = {};
  for (const [name, info] of Object.entries(padCatalog(pipeline))) {
    padsState[name] = {
      status: info["status"] ?? null,
      available_after: info["available_after"] ?? null,
      site: padSite(name, pipeline),
      notes: info["notes"] ?? null,
    };
  }
  const operationalPads = operationalPadCount(pipeline, today);
  const slipRaw = slips.get(startFn) ?? 0.0;
  const slipApplied = Math.max(0.0, slipRaw);

  const netAnchorsOut: Record<string, string> = {};
  for (const [k, v] of [...anchors.entries()].sort((a, b) => a[0] - b[0])) {
    netAnchorsOut[String(k)] = isoFromOrd(v);
  }

  return {
    as_of: isoFromOrd(today),
    horizon: isoFromOrd(horizon),
    n_sims: nSims,
    seed,
    already_flown: alreadyFlown,
    year_baseline_flown: yearBaseline,
    future_flights: withMcSe(allCounts),
    total_flights_by_eoy: withMcSe(totalByEoy),
    calendar_year_flights: withMode(calendarYearByEoy),
    monthly: monthlyExpected,
    flight_distributions: flightDistributions,
    pipeline: pipelineSummary,
    goal,
    assumptions: {
      model: "gaps+goal+hardware+pad/fleet+mishaps+net_anchors (workers simplified)",
      florida_first: null, // dropped in the Workers port
      timeline_aligned_windows: false,
      goal_gap_days: goalGap,
      goal_blend: effectiveBlend,
      goal_blend_config: goalBlend,
      goal_blend_sampling: "mixture",
      goal_miss_prob: GOAL_MISS_PROB,
      goal_attainment_mean: attainment.mean,
      goal_attainment_n: attainment.n,
      goal_attainment_source: attainment.source,
      attained_goal_gap_days: attainedGoal,
      goal_prior_sigma: GOAL_PRIOR_SIGMA,
      blended_mean_gap_days: blendedMean,
      recent_gaps_days: recentGaps,
      recent_mean_gap_days: recentMean,
      recent_gaps_block: startBlock,
      all_historical_gaps: rawGapCount,
      gaps_investigation_adjusted: true,
      clean_gap_floor_days: CLEAN_GAP_FLOOR_DAYS,
      regime_sigma: 0.0, // regime multiplier dropped in the Workers port
      hw_ready_sigma_days: HW_READY_SIGMA_DAYS,
      hw_ready_sigma_by_readiness: { ...HW_READY_SIGMA_BY_READINESS },
      pad_avail_sigma_days: PAD_AVAIL_SIGMA_DAYS,
      net_delay_jitter_mean_days: NET_DELAY_JITTER_MEAN,
      net_slip_scales_with_horizon: true,
      net_slip_max_days: NET_SLIP_MAX_DAYS,
      hurricane_season_months: [], // climatology dropped in the Workers port
      hurricane_season_p_delay: {},
      max_recent_gap_cap_days: MAX_RECENT_GAP_DAYS,
      open_faa_investigation: openFaa,
      faa_just_closed: faaJustClosed,
      residual_faa_days: residualFaaDays,
      static_fire_ready: staticFireReady,
      readiness_signal_count: readinessEvents,
      shrink,
      delay_extra_days: delayExtra,
      soft_faa_hold: true,
      early_clear_prob: EARLY_CLEAR_PROB,
      rtf_mean_days: rtf.rtf_mean,
      rtf_n: rtf.n,
      rtf_source: rtf.source,
      rtf_net_skip_days: RTF_NET_SKIP_DAYS,
      rtf_skipped_for_near_term_net: Boolean(nearTermNet && (faaJustClosed || openFaa)),
      hw_net_skip_days: HW_NET_SKIP_DAYS,
      hw_skipped_for_near_term_net: nearTermNetHw,
      investigation_mean_days: invMean,
      p_mishap: enableMishaps ? basePMishap : 0.0,
      p_mishap_block_prior: mishap.block_prior,
      p_mishap_regime: mishap.regime,
      p_mishap_target_block: mishap.target_block,
      mishap_lookback: mishap.n_lookback,
      expected_mishaps_mean: mean(mishapCounts),
      enable_mishaps: enableMishaps,
      pad_turnaround_days: turnaroundDaysFor(today, pipeline),
      dual_pad_turnaround_days: DUAL_PAD_TURNAROUND_DAYS,
      operational_pads: operationalPads,
      pads: padsState,
      block_transition_extra_days: BLOCK_TRANSITION_EXTRA_DAYS,
      pad_change_extra_days: PAD_CHANGE_EXTRA_DAYS,
      manufacturing_rate_rockets_per_month: mfrRate,
      stated_manufacturing_rate_rockets_per_month: statedMfrRate,
      mfr_gap_floor_days: mfrGapFloor,
      mfr_rate_source: mfrEst.source,
      mfr_n_gaps: mfrEst.n_gaps,
      mfr_latest_ship: mfrEst.latest_ship,
      mfr_latest_completed: mfrEst.latest_completed,
      mfr_recent_gaps_days: mfrEst.recent_gaps_days,
      mfr_rate_trend: mfrEst.rate_trend,
      mfr_floor_applies_to: "placeholders_only",
      scrub_prob: scrubProb,
      scrub_extra_mean: scrubExtraMean,
      scrub_short_mean_days: scrub.short_mean_days,
      scrub_long_mean_days: scrub.long_mean_days,
      scrub_p_long: scrub.p_long,
      scrub_n_signal: scrub.n_signal_scrubs,
      scrub_n_seed: scrub.n_seed_scrubs,
      scrub_n_net_slip: scrub.n_net_slip_scrubs,
      scrub_retry_bump: SCRUB_RETRY_PROB_BUMP,
      open_scrub_flights: scrub.open_scrub_flights,
      scrub_source: scrub.source,
      net_anchors: netAnchorsOut,
      net_slip_days_per_week: slipApplied,
      net_slip_days_per_week_raw: slipRaw,
      official_net: anchors.has(startFn) ? isoFromOrd(anchors.get(startFn) as number) : null,
      next_flight_number: startFn,
      weather_hazard_active: false, // weather-hazard model dropped in the Workers port
      weather_hazard_hold_until: null,
      weather_hazard: null,
    },
  };
}
