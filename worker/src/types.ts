export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;

  // Vars
  ANTHROPIC_MODEL: string;
  POLL_IDLE_HOUR_LOCAL: string;
  POLL_IDLE_TZ: string;
  POLL_INTERVAL_IDLE_S: string;
  POLL_INTERVAL_NEAR_LAUNCH_S: string;
  NEAR_LAUNCH_HORIZON_H: string;
  POST_WINDOW_HOT_H: string;
  LLM_EXTRACT_BATCH_LIMIT: string;
  CADENCE_N_SIMS: string;
  CADENCE_SEED: string;
  CADENCE_HORIZON: string;

  // Secrets (optional at runtime)
  ANTHROPIC_API_KEY?: string;
  LL2_API_KEY?: string;
  ADMIN_TOKEN?: string;
}

export interface Settings {
  anthropicApiKey: string;
  anthropicModel: string;
  ll2ApiKey: string;
  pollIntervalIdleS: number;
  pollIntervalNearLaunchS: number;
  pollIdleHourLocal: number;
  pollIdleTz: string;
  nearLaunchHorizonH: number;
  postWindowHotH: number;
  llmExtractBatchLimit: number;
  cadenceNSims: number;
  cadenceSeed: number;
  cadenceHorizon: string;
  hasAnthropic: boolean;
}

export function getSettings(env: Env): Settings {
  const anthropicApiKey = (env.ANTHROPIC_API_KEY ?? "").trim();
  return {
    anthropicApiKey,
    anthropicModel: env.ANTHROPIC_MODEL || "claude-sonnet-5",
    ll2ApiKey: (env.LL2_API_KEY ?? "").trim(),
    pollIntervalIdleS: intVar(env.POLL_INTERVAL_IDLE_S, 86_400),
    pollIntervalNearLaunchS: intVar(env.POLL_INTERVAL_NEAR_LAUNCH_S, 3_600),
    pollIdleHourLocal: intVar(env.POLL_IDLE_HOUR_LOCAL, 8),
    pollIdleTz: env.POLL_IDLE_TZ || "America/Denver",
    nearLaunchHorizonH: intVar(env.NEAR_LAUNCH_HORIZON_H, 24),
    postWindowHotH: intVar(env.POST_WINDOW_HOT_H, 24),
    llmExtractBatchLimit: intVar(env.LLM_EXTRACT_BATCH_LIMIT, 20),
    cadenceNSims: intVar(env.CADENCE_N_SIMS, 150),
    cadenceSeed: intVar(env.CADENCE_SEED, 42),
    cadenceHorizon: env.CADENCE_HORIZON || "2026-12-31",
    hasAnthropic: anthropicApiKey.length > 0,
  };
}

function intVar(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ---------------------------------------------------------------------------
// Domain records (parsed row shapes; *_json columns already decoded)

export interface Flight {
  flight_number: number;
  name: string | null;
  launch_date: string | null;
  net_date: string | null;
  booster: string | null;
  ship: string | null;
  block: number | null;
  pad: string | null;
  outcome: string | null;
  booster_outcome: string | null;
  ship_outcome: string | null;
  milestones: unknown[];
  investigation: Investigation | null;
  ll2_id: string | null;
  ll2_status: string | null;
  ll2_raw: Record<string, unknown> | null;
  status_hint: string | null;
  updated_at: string;
  // Seed overlay fields (merge_seed_attempt_fields)
  attempts?: number | null;
  scrubs?: number | null;
  scrub_details?: ScrubDetail[] | null;
  [key: string]: unknown;
}

export interface Investigation {
  opened?: string | null;
  closed?: string | null;
  days?: number | null;
  trigger?: string | null;
  [key: string]: unknown;
}

export interface ScrubDetail {
  date?: string | null;
  reason?: string | null;
  klass?: string | null;
  delay_days?: number | null;
  [key: string]: unknown;
}

export interface Signal {
  id: number;
  article_id: number | null;
  article_url: string | null;
  signal_type: string;
  flight_number: number | null;
  payload: Record<string, unknown>;
  confidence: number | null;
  quote: string | null;
  extracted_at: string;
  article_published_at?: string | null;
  [key: string]: unknown;
}

export interface Article {
  id: number;
  url: string;
  title: string | null;
  summary: string | null;
  news_site: string | null;
  published_at: string | null;
  image_url: string | null;
  fetched_at: string;
  extracted: number;
  extracted_via: string | null;
}

export interface NetHistoryRow {
  id: number;
  flight_number: number;
  net_date: string;
  observed_at: string;
  source: string;
}

export interface PipelineVehicle {
  flight_number: number;
  booster?: string | null;
  ship?: string | null;
  block?: number | null;
  pad?: string | null;
  readiness?: string | null;
  earliest_ready?: string | null;
  risk_flags?: string[];
  notes?: string | null;
}

export interface Pipeline {
  updated?: string;
  sources?: string[];
  goal?: Record<string, unknown>;
  pads?: Record<string, Record<string, unknown>>;
  vehicles?: PipelineVehicle[];
  ship_completions?: Record<string, unknown>[];
  readiness_lead_days?: Record<string, number>;
  [key: string]: unknown;
}
