// Port of server/app/api.py routes. Same-origin in production (SPA served by
// the same Worker), so no CORS middleware. POST /api/refresh swaps the old
// localhost-only check for an X-Admin-Token header (ADMIN_TOKEN secret).

import { getCachedCadence } from "./cadence/cache";
import { loadPipeline } from "./cadence/model";
import {
  getFlight,
  getMeta,
  listArticles,
  listFlights,
  listSignals,
  netHistory,
} from "./db";
import { budgetRemaining } from "./ll2";
import { nearLaunch, runPollCycle } from "./poll";
import { buildFlightStatus, buildFlightStatuses } from "./statusEngine";
import type { Env, PipelineVehicle } from "./types";
import { getSettings } from "./types";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, detail: string): Response {
  return json({ detail }, status);
}

export function articleMentionsFlight(text: string, flightNumber: number): boolean {
  // Word-boundary match for Flight N / IFT-N — avoids '1' matching '13'.
  if (!text) return false;
  const n = Math.trunc(flightNumber);
  const re = new RegExp(
    `\\b(?:flight|ift)[\\s#-]*${n}\\b|\\b${n}\\b(?=\\s*(?:st|nd|rd|th)?\\s+starship)`,
    "i"
  );
  return re.test(text);
}

async function health(env: Env): Promise<Response> {
  const settings = getSettings(env);
  const db = env.DB;
  const near = await nearLaunch(db, settings);
  const intervalS = near ? settings.pollIntervalNearLaunchS : settings.pollIntervalIdleS;
  const storedInterval = await getMeta(db, "poll_interval_s");
  let storedIntervalS: number | null = null;
  if (storedInterval) {
    const n = Number(storedInterval);
    if (Number.isFinite(n)) storedIntervalS = Math.trunc(n);
  }
  return json({
    ok: true,
    ll2_budget_remaining: await budgetRemaining(db),
    ll2_synced_at: await getMeta(db, "ll2_synced_at"),
    news_synced_at: await getMeta(db, "news_synced_at"),
    llm_extract_at: await getMeta(db, "llm_extract_at"),
    cadence_synced_at: await getMeta(db, "cadence_synced_at"),
    last_poll_at: await getMeta(db, "poll_synced_at"),
    next_poll_at: await getMeta(db, "next_poll_at"),
    near_launch: near,
    poll_interval_s: storedIntervalS ?? intervalS,
    poll_interval_idle_s: settings.pollIntervalIdleS,
    poll_interval_near_launch_s: settings.pollIntervalNearLaunchS,
    poll_idle_hour_local: settings.pollIdleHourLocal,
    llm_extract_interval_s: settings.pollIntervalIdleS,
    anthropic_model: settings.anthropicModel,
    has_anthropic: settings.hasAnthropic,
    ll2_use_dev: false,
  });
}

async function flightsList(env: Env): Promise<Response> {
  const flights = await listFlights(env.DB);
  const signals = await listSignals(env.DB, { limit: 500 });
  const statuses = buildFlightStatuses(flights, signals);
  return json({ flights: statuses, count: statuses.length });
}

async function flightDetail(env: Env, flightNumber: number): Promise<Response> {
  const db = env.DB;
  const flight = await getFlight(db, flightNumber);
  const signals = await listSignals(db, { flightNumber, limit: 200 });
  const allSignals = await listSignals(db, { limit: 500 });
  const mergedSignals = [
    ...signals,
    ...allSignals.filter((s) => s.flight_number == null && s.signal_type === "faa_action"),
  ];
  const history = await netHistory(db, flightNumber);
  const articles = (await listArticles(db, 100)).filter((a) =>
    articleMentionsFlight(`${a.title ?? ""} ${a.summary ?? ""}`, flightNumber)
  );

  const allFlights = await listFlights(db);
  // Cap projected stubs so random huge IDs aren't inventable forever
  const knownMax = allFlights.length ? Math.max(...allFlights.map((f) => f.flight_number)) : 0;
  const pipeline = loadPipeline();
  const pipelineVehicles = (pipeline.vehicles ?? []) as PipelineVehicle[];
  const pipelineMax = pipelineVehicles.length
    ? Math.max(...pipelineVehicles.map((v) => Number(v.flight_number ?? 0)))
    : 0;
  if (!flight && flightNumber > Math.max(knownMax, pipelineMax) + 8) {
    return error(404, `Flight ${flightNumber} not found`);
  }

  if (flight) {
    // Fleet context for prior FAA holds; derive only this flight.
    const status = buildFlightStatus(flight, allFlights, allSignals);
    return json({
      flight: status ?? flight,
      net_history: history,
      signals: mergedSignals,
      related_articles: articles.slice(0, 20),
      projected: false,
    });
  }

  // Future / projected flight from hardware pipeline + cadence (not yet in DB)
  let vehicle = pipelineVehicles.find((v) => Number(v.flight_number ?? -1) === flightNumber) ?? null;
  if (!vehicle) {
    // Still allow bare projected stub so the UI can show cadence dates
    vehicle = {
      flight_number: flightNumber,
      booster: null,
      ship: null,
      block: 3,
      readiness: "projected",
      earliest_ready: null,
      notes: "Projected from cadence model; no hardware row in pipeline seed yet.",
    };
  }

  const readiness = (vehicle.readiness ?? "projected").toLowerCase();
  let stubStatus: string;
  if (readiness === "pad_ready" || readiness === "static_fire_complete") {
    stubStatus = "GO";
  } else if (["ship_stacked", "cryo_complete", "in_production"].includes(readiness)) {
    stubStatus = "TESTING";
  } else if (vehicle.booster || vehicle.ship) {
    stubStatus = "VEHICLE_ASSIGNED";
  } else {
    stubStatus = "ANNOUNCED";
  }

  const stub: Record<string, unknown> = {
    flight_number: flightNumber,
    name: `Starship Flight Test ${flightNumber}`,
    launch_date: null,
    net_date: null,
    booster: vehicle.booster ?? null,
    ship: vehicle.ship ?? null,
    block: vehicle.block ?? null,
    pad: vehicle.pad ?? null,
    outcome: null,
    booster_outcome: null,
    ship_outcome: null,
    milestones: vehicle.notes ? [vehicle.notes] : [],
    investigation: null,
    status: stubStatus,
    evidence: [
      {
        kind: "projected",
        detail: "Projected flight from cadence / manufacturing pipeline (not flown yet)",
        source: "pipeline",
      },
    ],
    pipeline_readiness: vehicle.readiness ?? null,
    pipeline_earliest_ready: vehicle.earliest_ready ?? null,
    pipeline_notes: vehicle.notes ?? null,
  };

  return json({
    flight: stub,
    net_history: [],
    signals: mergedSignals,
    related_articles: articles.slice(0, 20),
    projected: true,
    hardware: {
      booster: vehicle.booster ?? null,
      ship: vehicle.ship ?? null,
      pad: vehicle.pad ?? null,
      readiness: vehicle.readiness ?? null,
      earliest_ready: vehicle.earliest_ready ?? null,
      notes: vehicle.notes ?? null,
    },
  });
}

async function cadence(env: Env): Promise<Response> {
  // Serve the cached Monte Carlo projection (rebuilt on cron / admin refresh).
  const cached = await getCachedCadence(env.CACHE);
  if (cached === null) {
    return error(503, "Cadence projection not available yet (waiting for first poll)");
  }
  return json(cached);
}

async function signalsRoute(env: Env, url: URL): Promise<Response> {
  const since = url.searchParams.get("since");
  let limit = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isFinite(limit)) limit = 100;
  limit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = await listSignals(env.DB, { since, limit });
  const articles = await listArticles(env.DB, 30);
  return json({ signals: rows, recent_articles: articles });
}

async function refresh(env: Env, request: Request, url: URL): Promise<Response> {
  // Admin-token gated force poll (replaces the localhost-only check).
  const adminToken = (env.ADMIN_TOKEN ?? "").trim();
  if (!adminToken) {
    return error(503, "Refresh disabled: ADMIN_TOKEN secret is not configured");
  }
  const provided = request.headers.get("X-Admin-Token") ?? "";
  if (!timingSafeEqualStr(provided, adminToken)) {
    return error(403, "Invalid admin token");
  }
  const forceLl2 = url.searchParams.get("force_ll2") === "true";
  const forceExtractRaw = url.searchParams.get("force_extract");
  const forceExtract = forceExtractRaw === null ? true : forceExtractRaw === "true";
  const result = await runPollCycle(env, { forceLl2, forceExtract });
  return json(result);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "GET") {
      if (path === "/api/health") return await health(env);
      if (path === "/api/flights") return await flightsList(env);
      const detailMatch = /^\/api\/flights\/(\d+)$/.exec(path);
      if (detailMatch) return await flightDetail(env, parseInt(detailMatch[1], 10));
      if (path === "/api/cadence") return await cadence(env);
      if (path === "/api/signals") return await signalsRoute(env, url);
    }
    if (request.method === "POST" && path === "/api/refresh") {
      return await refresh(env, request, url);
    }
    return error(404, "Not found");
  } catch (exc) {
    console.error("API error:", exc);
    return error(500, `Internal error: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}
