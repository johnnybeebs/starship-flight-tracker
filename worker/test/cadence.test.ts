// Sanity tests for the simplified cadence model:
// - payload-shape contract against the Python (20k-sim) output key sets
// - percentile monotonicity
// - NET anchoring (never project the anchored flight before its NET)
// - mishap-probability direction
// - determinism + CPU budget
import { describe, expect, it } from "vitest";
import { ordFromIso, projectCadence } from "../src/cadence/model";
import type { Flight } from "../src/types";
import flightsSeed from "../seeds/flights_seed.json";

// Key sets captured from the Python 20k-sim payload (server/data/cadence_cache.json).
const PY_TOP_KEYS = [
  "already_flown", "as_of", "assumptions", "calendar_year_flights", "flight_distributions",
  "future_flights", "goal", "horizon", "monthly", "n_sims", "pipeline", "seed",
  "total_flights_by_eoy", "year_baseline_flown",
]; // (computed_at / input_fingerprint are stamped by the cache layer)
const PY_MONTHLY_KEYS = [
  "cum_expected", "cum_p10", "cum_p50", "cum_p75", "cum_p90", "expected", "month",
  "p10", "p50", "p75", "p90",
];
const PY_DIST_KEYS = [
  "date_p10", "date_p25", "date_p50", "date_p50_se_days", "date_p75", "date_p90",
  "flight_number", "hardware", "n_samples", "net_anchor", "p_by_eoy", "p_first_florida",
  "p_mishap", "sample_ordinals",
];
const PY_GOAL_KEYS = [
  "launches_per_month", "manufacturing_rate_rockets_per_month", "seed_target_gap_days",
  "signal_count", "source", "statement", "target_gap_days",
];
const PY_PIPELINE_KEYS = [
  "block", "booster", "earliest_ready", "flight_number", "notes", "pad", "readiness",
  "risk_flags", "ship", "source",
];
const PY_ASSUMPTION_KEYS = [
  "all_historical_gaps", "attained_goal_gap_days", "blended_mean_gap_days",
  "block_transition_extra_days", "clean_gap_floor_days", "delay_extra_days",
  "dual_pad_turnaround_days", "early_clear_prob", "enable_mishaps", "expected_mishaps_mean",
  "faa_just_closed", "florida_first", "gaps_investigation_adjusted", "goal_attainment_mean",
  "goal_attainment_n", "goal_attainment_source", "goal_blend", "goal_blend_config",
  "goal_blend_sampling", "goal_gap_days", "goal_miss_prob", "goal_prior_sigma",
  "hurricane_season_months", "hurricane_season_p_delay", "hw_net_skip_days",
  "hw_ready_sigma_by_readiness", "hw_ready_sigma_days", "hw_skipped_for_near_term_net",
  "investigation_mean_days", "manufacturing_rate_rockets_per_month", "max_recent_gap_cap_days",
  "mfr_floor_applies_to", "mfr_gap_floor_days", "mfr_latest_completed", "mfr_latest_ship",
  "mfr_n_gaps", "mfr_rate_source", "mfr_rate_trend", "mfr_recent_gaps_days", "mishap_lookback",
  "model", "net_anchors", "net_delay_jitter_mean_days", "net_slip_days_per_week",
  "net_slip_days_per_week_raw", "net_slip_max_days", "net_slip_scales_with_horizon",
  "next_flight_number", "official_net", "open_faa_investigation", "open_scrub_flights",
  "operational_pads", "p_mishap", "p_mishap_block_prior", "p_mishap_regime",
  "p_mishap_target_block", "pad_avail_sigma_days", "pad_change_extra_days",
  "pad_turnaround_days", "pads", "readiness_signal_count", "recent_gaps_block",
  "recent_gaps_days", "recent_mean_gap_days", "regime_sigma", "residual_faa_days",
  "rtf_mean_days", "rtf_n", "rtf_net_skip_days", "rtf_skipped_for_near_term_net", "rtf_source",
  "scrub_extra_mean", "scrub_long_mean_days", "scrub_n_net_slip", "scrub_n_seed",
  "scrub_n_signal", "scrub_p_long", "scrub_prob", "scrub_retry_bump", "scrub_short_mean_days",
  "scrub_source", "shrink", "soft_faa_hold", "stated_manufacturing_rate_rockets_per_month",
  "static_fire_ready", "timeline_aligned_windows", "weather_hazard", "weather_hazard_active",
  "weather_hazard_hold_until",
];
const PY_QUANTILE_KEYS = ["mc_se_mean", "mean", "p10", "p50", "p75", "p90"];
const PY_MODE_KEYS = [...PY_QUANTILE_KEYS, "mode", "p_mode"];

function seedAsFlights(): Flight[] {
  const flights = (flightsSeed as { flights: Record<string, unknown>[] }).flights;
  return flights.map((f) => ({
    flight_number: Number(f["flight_number"]),
    name: (f["name"] as string) ?? null,
    launch_date: (f["launch_date"] as string) ?? null,
    net_date: (f["net_date"] as string) ?? (f["launch_date"] as string) ?? null,
    booster: (f["booster"] as string) ?? null,
    ship: (f["ship"] as string) ?? null,
    block: (f["block"] as number) ?? null,
    pad: (f["pad"] as string) ?? null,
    outcome: (f["outcome"] as string) ?? null,
    booster_outcome: (f["booster_outcome"] as string) ?? null,
    ship_outcome: (f["ship_outcome"] as string) ?? null,
    milestones: (f["milestones"] as unknown[]) ?? [],
    investigation: (f["investigation"] as Flight["investigation"]) ?? null,
    ll2_id: null,
    ll2_status: null,
    ll2_raw: null,
    status_hint: (f["status_hint"] as string) ?? null,
    updated_at: "2026-07-19T00:00:00Z",
    attempts: (f["attempts"] as number) ?? null,
    scrubs: (f["scrubs"] as number) ?? null,
    scrub_details: (f["scrub_details"] as Flight["scrub_details"]) ?? null,
  }));
}

const TODAY = ordFromIso("2026-07-19") as number;
const HORIZON = ordFromIso("2026-12-31") as number;

function run(opts: Record<string, unknown> = {}) {
  return projectCadence(seedAsFlights(), [], [], {
    today: TODAY,
    horizon: HORIZON,
    nSims: 150,
    seed: 42,
    ...opts,
  });
}

describe("payload shape contract", () => {
  const payload = run();

  it("matches Python top-level keys", () => {
    expect(Object.keys(payload).sort()).toEqual([...PY_TOP_KEYS].sort());
  });

  it("matches Python monthly / distribution / goal / pipeline / assumption keys", () => {
    const monthly = payload["monthly"] as Record<string, unknown>[];
    expect(monthly.length).toBeGreaterThan(0);
    expect(Object.keys(monthly[0]).sort()).toEqual([...PY_MONTHLY_KEYS].sort());

    const dists = payload["flight_distributions"] as Record<string, unknown>[];
    expect(dists.length).toBeGreaterThan(0);
    expect(Object.keys(dists[0]).sort()).toEqual([...PY_DIST_KEYS].sort());

    expect(Object.keys(payload["goal"] as object).sort()).toEqual([...PY_GOAL_KEYS].sort());

    const pipeline = payload["pipeline"] as Record<string, unknown>[];
    expect(pipeline.length).toBeGreaterThan(0);
    expect(Object.keys(pipeline[0]).sort()).toEqual([...PY_PIPELINE_KEYS].sort());

    expect(Object.keys(payload["assumptions"] as object).sort()).toEqual(
      [...PY_ASSUMPTION_KEYS].sort()
    );

    expect(Object.keys(payload["future_flights"] as object).sort()).toEqual(
      [...PY_QUANTILE_KEYS].sort()
    );
    expect(Object.keys(payload["calendar_year_flights"] as object).sort()).toEqual(
      [...PY_MODE_KEYS].sort()
    );
  });

  it("nulls the dropped sub-models the UI optional-chains on", () => {
    const assumptions = payload["assumptions"] as Record<string, unknown>;
    expect(assumptions["florida_first"]).toBeNull();
    expect(assumptions["weather_hazard"]).toBeNull();
    expect(assumptions["weather_hazard_active"]).toBe(false);
    const dists = payload["flight_distributions"] as Record<string, unknown>[];
    for (const d of dists) expect(d["p_first_florida"]).toBe(0);
  });
});

describe("percentile monotonicity", () => {
  const payload = run();

  it("monthly cumulative quantiles are ordered", () => {
    for (const m of payload["monthly"] as Record<string, number>[]) {
      expect(m["cum_p10"]).toBeLessThanOrEqual(m["cum_p50"]);
      expect(m["cum_p50"]).toBeLessThanOrEqual(m["cum_p75"]);
      expect(m["cum_p75"]).toBeLessThanOrEqual(m["cum_p90"]);
      expect(m["p10"]).toBeLessThanOrEqual(m["p50"]);
      expect(m["p50"]).toBeLessThanOrEqual(m["p90"]);
    }
  });

  it("cumulative P50 is non-decreasing across months", () => {
    const monthly = payload["monthly"] as Record<string, number>[];
    for (let i = 1; i < monthly.length; i++) {
      expect(monthly[i]["cum_p50"]).toBeGreaterThanOrEqual(monthly[i - 1]["cum_p50"]);
    }
  });

  it("per-flight date quantiles are ordered", () => {
    for (const d of payload["flight_distributions"] as Record<string, string>[]) {
      expect(d["date_p10"] <= d["date_p25"]).toBe(true);
      expect(d["date_p25"] <= d["date_p50"]).toBe(true);
      expect(d["date_p50"] <= d["date_p75"]).toBe(true);
      expect(d["date_p75"] <= d["date_p90"]).toBe(true);
    }
  });

  it("total quantiles are ordered", () => {
    const t = payload["total_flights_by_eoy"] as Record<string, number>;
    expect(t["p10"]).toBeLessThanOrEqual(t["p50"]);
    expect(t["p50"]).toBeLessThanOrEqual(t["p90"]);
  });
});

describe("NET anchoring", () => {
  it("never projects the anchored next flight before its published NET", () => {
    const payload = run();
    const dists = payload["flight_distributions"] as Record<string, unknown>[];
    const f13 = dists.find((d) => d["flight_number"] === 13);
    expect(f13).toBeDefined();
    expect(f13!["net_anchor"]).toBe("2026-07-16");
    // NET (2026-07-16) is in the past relative to neither today nor anchor logic;
    // the anchor path adds only non-negative slip/jitter/scrub delay.
    expect((f13!["date_p10"] as string) >= "2026-07-16").toBe(true);
  });
});

describe("mishap direction", () => {
  it("mishaps reduce expected flights and are counted", () => {
    const withMishaps = run({ enableMishaps: true });
    const withoutMishaps = run({ enableMishaps: false });
    const meanWith = (withMishaps["future_flights"] as Record<string, number>)["mean"];
    const meanWithout = (withoutMishaps["future_flights"] as Record<string, number>)["mean"];
    expect(meanWith).toBeLessThan(meanWithout);
    const assumptions = withMishaps["assumptions"] as Record<string, number>;
    expect(assumptions["expected_mishaps_mean"]).toBeGreaterThan(0);
    expect(
      (withoutMishaps["assumptions"] as Record<string, number>)["p_mishap"]
    ).toBe(0);
  });
});

describe("determinism + CPU budget", () => {
  it("same seed gives identical output", () => {
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("different seeds give different samples", () => {
    const a = run({ seed: 42 });
    const b = run({ seed: 43 });
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("150 sims complete in a few tens of ms in Node (Workers free cap is 10 ms CPU)", () => {
    run(); // warm up JIT
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      run();
      times.push(performance.now() - t0);
    }
    const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    // Node wall-clock is a proxy only — Workers free tier hard-caps at 10 ms
    // CPU. This suite flags order-of-magnitude regressions; production headroom
    // must be confirmed in the Cloudflare dashboard after deploy.
    console.log(
      `projectCadence(150 sims): median ${median.toFixed(1)} ms ` +
        `(runs: ${times.map((t) => t.toFixed(1)).join(", ")})`
    );
    expect(median).toBeLessThan(50);
  });
});
