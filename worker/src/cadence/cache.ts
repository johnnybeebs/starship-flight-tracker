// Port of server/app/cadence_cache.py: KV-backed cadence cache with an input
// fingerprint so unchanged inputs skip the Monte Carlo recompute.
// (Calibration outcome logging from the Python version is dropped.)

import { listFlights, listSignals, mergeSeedAttemptFields, netHistory, setMetaStmt } from "../db";
import type { Flight, NetHistoryRow, Pipeline, Settings, Signal } from "../types";
import { loadPipeline, ordFromIso, projectCadence } from "./model";

export const CADENCE_KV_KEY = "cadence";

function stableJson(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return out;
  }
  return obj;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cadenceInputFingerprint(
  flights: Flight[],
  signals: Signal[],
  history: NetHistoryRow[],
  settings: Settings,
  pipeline?: Pipeline
): Promise<string> {
  // Hash of all inputs that can change the Monte Carlo projection.
  const pl = pipeline ?? loadPipeline();
  const flightRows = [...flights]
    .sort((a, b) => Number(a.flight_number ?? 0) - Number(b.flight_number ?? 0))
    .map((f) => ({
      fn: f.flight_number,
      launch: f.launch_date,
      net: f.net_date,
      outcome: f.outcome,
      block: f.block,
      pad: f.pad,
      booster: f.booster,
      ship: f.ship,
      inv: f.investigation,
      attempts: f.attempts ?? null,
      scrubs: f.scrubs ?? null,
      scrub_details: f.scrub_details ?? null,
    }));
  const signalRows = signals.map((s) => ({
    id: s.id,
    type: s.signal_type,
    fn: s.flight_number,
    payload: s.payload,
    extracted_at: s.extracted_at,
    confidence: s.confidence,
  }));
  const histRows = history.map((h) => ({
    fn: h.flight_number,
    net: h.net_date,
    obs: h.observed_at,
    source: h.source,
  }));
  const blob = stableJson({
    flights: flightRows,
    signals: signalRows,
    net_history: histRows,
    pipeline: pl,
    n_sims: settings.cadenceNSims,
    seed: settings.cadenceSeed,
    horizon: settings.cadenceHorizon,
  });
  return (await sha256Hex(blob)).slice(0, 20);
}

export interface CadenceRefreshResult {
  ok: boolean;
  skipped: boolean;
  computed_at?: string | null;
  as_of?: string | null;
  n_sims?: number | null;
  input_fingerprint: string;
}

export async function refreshCadence(
  db: D1Database,
  kv: KVNamespace,
  settings: Settings,
  opts: { force?: boolean } = {}
): Promise<CadenceRefreshResult> {
  const flights = mergeSeedAttemptFields(await listFlights(db));
  const signals = await listSignals(db, { limit: 500 });
  const history = await netHistory(db);
  const pipeline = loadPipeline();
  const fingerprint = await cadenceInputFingerprint(flights, signals, history, settings, pipeline);

  const cachedRaw = await kv.get(CADENCE_KV_KEY);
  const cached = cachedRaw ? (JSON.parse(cachedRaw) as Record<string, unknown>) : null;

  if (
    !opts.force &&
    cached &&
    cached["input_fingerprint"] === fingerprint &&
    cached["n_sims"] === settings.cadenceNSims
  ) {
    return {
      ok: true,
      skipped: true,
      computed_at: (cached["computed_at"] as string) ?? null,
      as_of: (cached["as_of"] as string) ?? null,
      n_sims: (cached["n_sims"] as number) ?? null,
      input_fingerprint: fingerprint,
    };
  }

  const computedAt = new Date().toISOString();
  const horizon = ordFromIso(settings.cadenceHorizon);
  const payload = projectCadence(flights, signals, history, {
    horizon: horizon ?? undefined,
    nSims: settings.cadenceNSims,
    seed: settings.cadenceSeed,
    pipeline,
  });
  payload["computed_at"] = computedAt;
  payload["input_fingerprint"] = fingerprint;

  await kv.put(CADENCE_KV_KEY, JSON.stringify(payload));
  await db.batch([
    setMetaStmt(db, "cadence_synced_at", computedAt),
    setMetaStmt(db, "cadence_input_fingerprint", fingerprint),
  ]);

  return {
    ok: true,
    skipped: false,
    computed_at: computedAt,
    as_of: (payload["as_of"] as string) ?? null,
    n_sims: (payload["n_sims"] as number) ?? null,
    input_fingerprint: fingerprint,
  };
}

export async function getCachedCadence(kv: KVNamespace): Promise<Record<string, unknown> | null> {
  const raw = await kv.get(CADENCE_KV_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return data && typeof data === "object" && "as_of" in data ? data : null;
  } catch {
    return null;
  }
}
