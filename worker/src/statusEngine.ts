// Direct port of server/app/status_engine.py.
//
// Status state machine:
// ANNOUNCED -> VEHICLE_ASSIGNED -> TESTING -> REGULATORY_HOLD | GO
//   -> LAUNCHED -> SUCCESS | PARTIAL | FAILURE
//   -> MISHAP_INVESTIGATION (optional) -> CLOSED

import type { Flight, Investigation, NetHistoryRow, Signal } from "./types";

const TERMINAL_OUTCOMES = new Set(["SUCCESS", "PARTIAL", "FAILURE"]);

export function parseDt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function signalEventTime(signal: Signal): Date | null {
  // Prefer article publish time over extract time (re-extracts look 'new').
  for (const key of ["article_published_at", "published_at", "extracted_at"]) {
    const raw = signal[key];
    if (typeof raw !== "string") continue;
    const dt = parseDt(raw);
    if (dt) return dt;
  }
  return null;
}

export function sortedFaaSignals(signals: Signal[]): Signal[] {
  // Oldest-first so the chronologically latest action wins when applied in order.
  const faa = signals.filter((s) => s.signal_type === "faa_action");
  const epoch = 0;
  return [...faa].sort((a, b) => {
    const ta = signalEventTime(a)?.getTime() ?? epoch;
    const tb = signalEventTime(b)?.getTime() ?? epoch;
    return ta - tb;
  });
}

function closedDt(investigation: Investigation | null | undefined): Date | null {
  if (!investigation) return null;
  const closed = investigation.closed;
  if (!closed) return null;
  return parseDt(String(closed).includes("T") ? String(closed) : `${closed}T00:00:00Z`);
}

export function reopenAfterSeedClose(
  signal: Signal,
  investigation: Investigation | null | undefined,
  now: Date
): boolean {
  // Stale articles re-extracted today must not override a later seed close date.
  const closed = closedDt(investigation);
  if (!closed || closed > now) return true; // not seed-closed yet
  const conf = Number(signal.confidence ?? 0);
  if (conf < 0.75) return false;
  const event = signalEventTime(signal);
  // Only reopen if the reporting event itself is after the known close.
  return !!(event && event > closed);
}

export function investigationClosed(investigation: Investigation | null | undefined, now: Date): boolean {
  if (!investigation) return false;
  const closed = investigation.closed;
  if (!closed) return false;
  const dt = parseDt(String(closed).includes("T") ? String(closed) : `${closed}T00:00:00Z`);
  return !!(dt && dt <= now);
}

interface Evidence {
  kind: string;
  detail: string;
  source: string | null;
}

function pack(flight: Flight, status: string, evidence: Evidence[], signals: Signal[]): Flight {
  const out: Flight = { ...flight };
  delete (out as Record<string, unknown>)["_prior_investigation_open"];
  out["status"] = status;
  out["evidence"] = evidence;
  out["signal_count"] = signals.filter((s) => s.flight_number === flight.flight_number).length;
  return out;
}

export function deriveStatus(flight: Flight, signals: Signal[] = [], now?: Date): Flight {
  const nowDt = now ?? new Date();
  const evidence: Evidence[] = [];

  const outcome = (flight.outcome ?? "").toUpperCase() || null;
  const investigation = flight.investigation;
  const booster = flight.booster;
  const ship = flight.ship;
  const launchDate = parseDt(flight.launch_date);
  const netDate = parseDt(flight.net_date);
  const fn = flight.flight_number;

  // Only signals explicitly tagged to this flight (never broadcast untagged FAA to all rows)
  const tagged = signals.filter((s) => s.flight_number === fn);

  const addEvidence = (kind: string, detail: string, source: string | null = null) => {
    evidence.push({ kind, detail, source });
  };

  const invClosed = investigationClosed(investigation, nowDt);

  // --- Flown flights ---
  if ((outcome && TERMINAL_OUTCOMES.has(outcome)) || launchDate !== null) {
    let status = outcome && TERMINAL_OUTCOMES.has(outcome) ? outcome : "LAUNCHED";
    if (launchDate) addEvidence("launch_date", `Launched ${launchDate.toISOString()}`, "seed/ll2");
    if (outcome) addEvidence("outcome", `Outcome: ${outcome}`, "seed/ll2");

    if (investigation) {
      if (invClosed) {
        status = "CLOSED";
        addEvidence("investigation", `Mishap investigation closed (${investigation.days} days)`, "seed");
      } else {
        status = "MISHAP_INVESTIGATION";
        addEvidence("investigation", `Investigation open since ${investigation.opened}`, "seed");
      }
    } else if (outcome === "FAILURE") {
      status =
        launchDate && (nowDt.getTime() - launchDate.getTime()) / 86_400_000 > 90 ? "CLOSED" : outcome;
    } else if (outcome === "SUCCESS" || outcome === "PARTIAL") {
      status = "CLOSED";
    }

    // Tagged FAA signals may update investigation state; do not reopen a seed-closed
    // investigation from stale "opened" articles (common after LLM news re-extract).
    for (const s of tagged) {
      if (s.signal_type !== "faa_action") continue;
      const action = (s.payload ?? {})["action"];
      const conf = Number(s.confidence ?? 0);
      if (action === "investigation_opened" && (outcome === "FAILURE" || outcome === "PARTIAL")) {
        if (invClosed && !reopenAfterSeedClose(s, investigation, nowDt)) {
          addEvidence(
            "signal",
            `FAA investigation opened (conf=${conf}, stale vs seed close)`,
            s.article_url ?? null
          );
          continue;
        }
        status = "MISHAP_INVESTIGATION";
        addEvidence("signal", `FAA investigation opened (conf=${conf})`, s.article_url ?? null);
      }
      if (action === "investigation_closed" || action === "clearance") {
        status = "CLOSED";
        addEvidence("signal", "FAA investigation closed / clearance", s.article_url ?? null);
      }
    }

    // Surface other tagged signals (net slip, readiness, anomaly) with article links
    for (const s of tagged) {
      if (s.signal_type === "faa_action") continue;
      const st = s.signal_type || "signal";
      const quote = (s.quote ?? "").trim();
      const detail = quote || `${st}: ${JSON.stringify(s.payload)}`;
      addEvidence(st, detail.slice(0, 180), s.article_url ?? null);
    }

    return pack(flight, status, evidence, tagged);
  }

  // --- Upcoming flights ---
  let status = "ANNOUNCED";
  addEvidence("announced", "Flight announced / seeded", "seed");

  if (booster || ship) {
    status = "VEHICLE_ASSIGNED";
    addEvidence("vehicle", `Vehicles: ${booster || "?"} / ${ship || "?"}`, "seed");
  }

  const readinessEvents = tagged.filter((s) => s.signal_type === "vehicle_readiness");
  if (readinessEvents.length) {
    status = "TESTING";
    for (const s of readinessEvents) {
      const ev = (s.payload ?? {})["event"];
      addEvidence("readiness", `Readiness: ${ev}`, s.article_url ?? null);
    }
  }

  let faaHold = Boolean((flight as Record<string, unknown>)["_prior_investigation_open"]);
  if (faaHold) {
    addEvidence("faa", "Prior flight mishap investigation still open", "seed");
  }

  let faaClear = false;
  for (const s of tagged) {
    if (s.signal_type !== "faa_action") continue;
    const action = (s.payload ?? {})["action"];
    if (action === "investigation_opened" || action === "grounding") {
      faaHold = true;
      addEvidence("faa", `FAA ${action}`, s.article_url ?? null);
    }
    if (action === "investigation_closed" || action === "clearance") {
      faaClear = true;
      faaHold = false;
      addEvidence("faa", `FAA ${action}`, s.article_url ?? null);
    }
  }

  if (faaHold && !faaClear) {
    status = "REGULATORY_HOLD";
  } else if (["VEHICLE_ASSIGNED", "TESTING", "ANNOUNCED"].includes(status) && (booster || ship)) {
    const hasStatic = readinessEvents.some((s) => (s.payload ?? {})["event"] === "static_fire");
    let near = false;
    if (netDate) {
      near = Math.abs(netDate.getTime() - nowDt.getTime()) < 14 * 86_400_000;
    }
    const hint = (flight.status_hint ?? "").toUpperCase();
    const ll2 = (flight.ll2_status ?? "").toLowerCase();
    const ll2Go = ll2.includes("go");
    if (hasStatic || near || hint === "GO" || faaClear || ll2Go) {
      status = "GO";
      addEvidence("go", "Cleared / vehicles ready for launch window", "derived");
    }
  }

  const ll2 = (flight.ll2_status ?? "").toLowerCase();
  if (ll2.includes("hold") || ll2.includes("scrub")) {
    addEvidence("ll2", `LL2 status: ${flight.ll2_status}`, "ll2");
  } else if (ll2.includes("go")) {
    if (status !== "REGULATORY_HOLD") status = "GO";
    addEvidence("ll2", `LL2 status: ${flight.ll2_status}`, "ll2");
  }

  return pack(flight, status, evidence, tagged);
}

function openInvestigations(flights: Flight[], signals: Signal[], now: Date): Set<number> {
  // Flight numbers with an open mishap investigation (seed + live FAA signals).
  const open = new Set<number>();
  for (const f of flights) {
    const inv = f.investigation;
    if (!inv) continue;
    const closed = inv.closed;
    if (!closed) {
      open.add(f.flight_number);
      continue;
    }
    const dt = parseDt(String(closed).includes("T") ? String(closed) : `${closed}T00:00:00Z`);
    if (dt && dt > now) open.add(f.flight_number);
  }

  // Live FAA signals can mark investigation open/closed.
  // Apply oldest→newest so the chronologically latest action wins.
  // Seed-closed stays closed unless a high-confidence signal published after the close.
  for (const s of sortedFaaSignals(signals)) {
    let fn = s.flight_number;
    const action = (s.payload ?? {})["action"];
    if (fn == null) {
      // Untagged FAA actions only affect the most recent flown flight
      const flownNums = flights.filter((f) => f.launch_date || f.outcome).map((f) => f.flight_number);
      if (!flownNums.length) continue;
      fn = Math.max(...flownNums);
    }
    fn = Number(fn);
    if (action === "investigation_opened") {
      const seedFlight = flights.find((f) => f.flight_number === fn) ?? null;
      const inv = seedFlight?.investigation ?? null;
      if (seedFlight && investigationClosed(inv, now) && !reopenAfterSeedClose(s, inv, now)) {
        continue;
      }
      open.add(fn);
    }
    if (action === "investigation_closed" || action === "clearance") {
      open.delete(fn);
    }
  }
  return open;
}

export function buildFlightStatus(
  flight: Flight,
  flights: Flight[],
  signals: Signal[],
  now?: Date
): Flight {
  // Derive status for one flight (still needs fleet context for prior FAA holds).
  const nowDt = now ?? new Date();
  const open = openInvestigations(flights, signals, nowDt);
  const priorOpen = [...open].some((n) => n < flight.flight_number);
  const f2: Flight = { ...flight };
  (f2 as Record<string, unknown>)["_prior_investigation_open"] =
    priorOpen && !flight.launch_date && !flight.outcome;
  return deriveStatus(f2, signals, nowDt);
}

export function buildFlightStatuses(flights: Flight[], signals: Signal[], now?: Date): Flight[] {
  const nowDt = now ?? new Date();
  const open = openInvestigations(flights, signals, nowDt);
  const results: Flight[] = [];
  for (const f of [...flights].sort((a, b) => a.flight_number - b.flight_number)) {
    const priorOpen = [...open].some((n) => n < f.flight_number);
    const f2: Flight = { ...f };
    (f2 as Record<string, unknown>)["_prior_investigation_open"] =
      priorOpen && !f.launch_date && !f.outcome;
    results.push(deriveStatus(f2, signals, nowDt));
  }
  return results;
}

// ---------------------------------------------------------------------------
// NET slip velocity (used by the cadence model)

// Reject wrong-year / garbage NET points that explode slip velocity
// (e.g. 2025-07-16 recorded after 2026-07-16 → thousands of days/week).
const SLIP_NET_OUTLIER_DAYS = 120;
const SLIP_MIN_ELAPSED_WEEKS = 0.5;
const SLIP_VELOCITY_BOUNDS: [number, number] = [-7.0, 45.0];

function netHistoryPoints(history: NetHistoryRow[]): Array<[Date, Date]> {
  const points: Array<[Date, Date]> = [];
  for (const h of history) {
    const obs = parseDt(h.observed_at);
    const net = parseDt(h.net_date);
    if (obs && net) points.push([obs, net]);
  }
  points.sort((a, b) => a[0].getTime() - b[0].getTime());
  return points;
}

function filterSlipPoints(points: Array<[Date, Date]>): Array<[Date, Date]> {
  // Drop NET observations far from the median NET (wrong-year outliers).
  if (points.length < 2) return points;
  const nets = points.map((p) => p[1].getTime()).sort((a, b) => a - b);
  const median = nets[Math.floor(nets.length / 2)];
  const cleaned = points.filter(
    (p) => Math.abs(p[1].getTime() - median) / 86_400_000 <= SLIP_NET_OUTLIER_DAYS
  );
  return cleaned.length >= 2 ? cleaned : points;
}

export function slipVelocityDaysPerWeek(history: NetHistoryRow[]): number {
  if (history.length < 2) return 0.0;
  const points = filterSlipPoints(netHistoryPoints(history));
  if (points.length < 2) return 0.0;
  const [firstObs, firstNet] = points[0];
  const [lastObs, lastNet] = points[points.length - 1];
  const elapsedWeeks = (lastObs.getTime() - firstObs.getTime()) / (7 * 86_400_000);
  if (elapsedWeeks < SLIP_MIN_ELAPSED_WEEKS) return 0.0;
  const slipDays = (lastNet.getTime() - firstNet.getTime()) / 86_400_000;
  const velocity = slipDays / elapsedWeeks;
  const [lo, hi] = SLIP_VELOCITY_BOUNDS;
  return Math.max(lo, Math.min(hi, velocity));
}
