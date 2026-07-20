function formatWhen(f) {
  if (f.launch_date) return `Launched ${new Date(f.launch_date).toLocaleString()}`;
  if (f.net_date) return `NET ${new Date(f.net_date).toLocaleString()}`;
  return "NET TBD";
}

function isHttp(url) {
  if (typeof url !== "string") return false;
  // Reject javascript:/data: and require http(s) — defense in depth for source links.
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isWikipediaUrl(url) {
  return isHttp(url) && /wikipedia\.org/i.test(url);
}

function ll2Href(flight) {
  const raw = flight?.ll2_raw;
  if (isHttp(raw?.url) && !isWikipediaUrl(raw.url)) return raw.url;
  if (flight?.ll2_id) return `https://ll.thespacedevs.com/2.3.0/launches/${flight.ll2_id}/`;
  return null;
}

/** Resolve evidence/signal source labels to a clickable URL when possible. */
function resolveSourceHref(source, flight) {
  if (isWikipediaUrl(source)) return null;
  if (isHttp(source)) return source;
  if (!source) return null;
  const s = String(source).toLowerCase();
  if (s === "ll2" || s === "seed/ll2") return ll2Href(flight);
  return null;
}

function shortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function signalHref(s) {
  return isHttp(s?.article_url) && !isWikipediaUrl(s.article_url) ? s.article_url : null;
}

function signalTime(s) {
  const raw = s?.article_published_at || s?.published_at || s?.extracted_at;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Ranked schedule inputs that actually move the Monte Carlo for this flight.
 * Drops narrative milestones, generic evidence dumps, and article lists.
 */
function buildScheduleDrivers(detail, hardware) {
  const f = detail?.flight || {};
  const hw = hardware || detail?.hardware || {};
  const signals = [...(detail?.signals || [])].sort((a, b) => signalTime(b) - signalTime(a));
  const history = detail?.net_history || [];
  const flown = !!(f.launch_date || f.outcome);
  const drivers = [];
  const seen = new Set();

  function add(driver) {
    if (!driver?.detail || seen.has(driver.key)) return;
    seen.add(driver.key);
    drivers.push(driver);
  }

  const inv = f.investigation;
  if (inv) {
    const open = inv.opened && !inv.closed;
    const href =
      signalHref(
        signals.find(
          (s) =>
            s.signal_type === "faa_action" &&
            (open
              ? (s.payload || {}).action === "investigation_opened"
              : ["investigation_closed", "clearance"].includes((s.payload || {}).action))
        )
      ) || null;
    add({
      key: "investigation",
      kind: "FAA",
      score: open ? 100 : 88,
      detail: open
        ? `Investigation open since ${shortDate(inv.opened)}${inv.trigger ? ` — ${inv.trigger}` : ""}`
        : `Mishap review closed ${shortDate(inv.closed)}${
            inv.days != null ? ` (${inv.days}d)` : ""
          }${inv.trigger ? ` — ${inv.trigger}` : ""}`,
      href,
    });
  }

  for (const s of signals) {
    const type = s.signal_type;
    const payload = s.payload || {};
    const href = signalHref(s);
    const quote = (s.quote || "").trim();

    if (type === "faa_action") {
      const action = payload.action || "action";
      // Untagged open/close almost always belongs to another mishap flight
      if (
        s.flight_number == null &&
        ["investigation_opened", "investigation_closed"].includes(action) &&
        !inv
      ) {
        continue;
      }
      if (inv && ["investigation_opened", "investigation_closed", "clearance"].includes(action)) {
        continue; // already covered by investigation row
      }
      const labels = {
        investigation_opened: "Investigation opened",
        investigation_closed: "Investigation closed",
        clearance: "FAA clearance",
        grounding: "Grounding",
        license_mod: "License modification",
      };
      const scores = {
        grounding: 96,
        investigation_opened: 96,
        investigation_closed: 84,
        clearance: 82,
        license_mod: 48,
      };
      add({
        key: `faa:${action}:${s.id || quote.slice(0, 40)}`,
        kind: "FAA",
        score: scores[action] ?? 70,
        detail: `${labels[action] || action}${quote ? ` — ${quote}` : ""}`,
        href,
      });
    } else if (type === "weather_hazard") {
      const status = String(payload.status || "active").toLowerCase();
      const sev = payload.severity || "weather";
      const event = (payload.event || "hazard").replace(/_/g, " ");
      const until = payload.clear_after ? ` until ${shortDate(payload.clear_after)}` : "";
      add({
        key: `weather:${status}:${event}`,
        kind: "Weather",
        score: status === "cleared" ? 70 : 94,
        detail:
          status === "cleared"
            ? `${event} cleared${quote ? ` — ${quote}` : ""}`
            : `${sev} ${event} hold${until}${quote ? ` — ${quote}` : ""}`,
        href,
      });
    } else if (type === "net_slip") {
      const newNet = payload.new_net_date || payload.net_date;
      add({
        key: `net:${newNet || quote.slice(0, 40)}`,
        kind: "NET",
        score: 80,
        detail: newNet
          ? `Window moved to ${shortDate(newNet)}${payload.reason ? ` — ${payload.reason}` : quote ? ` — ${quote}` : ""}`
          : quote || "NET update",
        href,
      });
    } else if (type === "launch_scrub") {
      const newNet = payload.new_net_date;
      const reason = payload.reason || quote || "Launch attempt scrubbed";
      add({
        key: `scrub:${s.id || reason.slice(0, 40)}`,
        kind: "Scrub",
        score: 92,
        detail: newNet
          ? `Attempt scrubbed · recycle NET ${shortDate(newNet)} — ${reason}`
          : reason,
        href,
      });
    } else if (type === "vehicle_readiness") {
      const event = payload.event || "readiness";
      const serial = payload.serial ? ` · ${payload.serial}` : "";
      const scores = {
        static_fire: 72,
        cryo_test: 64,
        stacking: 62,
        rollout: 68,
        engine_install: 58,
      };
      add({
        key: `ready:${event}:${payload.serial || ""}`,
        kind: "Hardware",
        score: scores[event] || 55,
        detail: `${String(event).replace(/_/g, " ")}${serial}${quote ? ` — ${quote}` : ""}`,
        href,
      });
    } else if (type === "cadence_statement" && !flown) {
      const gap = payload.target_gap_days;
      const flights = payload.target_flights;
      const stmt = payload.statement || quote;
      let detail = stmt || "Cadence goal update";
      if (gap) detail = `~${Math.round(Number(gap))}d between flights${stmt ? ` — ${stmt}` : ""}`;
      else if (flights) detail = `${flights} flights targeted${stmt ? ` — ${stmt}` : ""}`;
      add({
        key: `cadence:${s.id || detail.slice(0, 40)}`,
        kind: "Cadence",
        score: 50,
        detail,
        href,
      });
    }
  }

  // Published NET still anchors the sim even without a slip signal
  if (!flown && f.net_date && !seen.has(`net:${String(f.net_date).slice(0, 10)}`)) {
    add({
      key: `net-anchor:${String(f.net_date).slice(0, 10)}`,
      kind: "NET",
      score: 78,
      detail: `Published NET ${shortDate(f.net_date)}`,
      href: ll2Href(f),
    });
  }

  // LL2 hold/scrub status even before a structured signal lands
  const ll2Status = String(f.ll2_status || "").toLowerCase();
  if (
    !flown &&
    ll2Status &&
    (ll2Status.includes("hold") || ll2Status.includes("scrub") || ll2Status === "tbd" || ll2Status.includes("to be determined"))
  ) {
    add({
      key: `ll2-status:${ll2Status}`,
      kind: "Scrub",
      score: 90,
      detail: `LL2 status: ${f.ll2_status}`,
      href: ll2Href(f),
    });
  }

  // Latest NET history slip (scrub / delay prior)
  if (!flown && history.length >= 2) {
    const sorted = [...history].sort((a, b) =>
      String(b.observed_at || "").localeCompare(String(a.observed_at || ""))
    );
    const latest = sorted[0];
    const prev = sorted[1];
    if (latest?.net_date && prev?.net_date && latest.net_date !== prev.net_date) {
      add({
        key: `net-hist:${latest.net_date}`,
        kind: "NET",
        score: 76,
        detail: `NET slipped ${shortDate(prev.net_date)} → ${shortDate(latest.net_date)}`,
        href: null,
      });
    }
  }

  const earliest = hw.earliest_ready || f.pipeline_earliest_ready;
  const readiness = hw.readiness || f.pipeline_readiness;
  if (!flown && earliest) {
    const notes = hw.notes || f.pipeline_notes;
    add({
      key: `floor:${earliest}`,
      kind: "Hardware",
      score: 56,
      detail: `Earliest ready ${shortDate(earliest)}${readiness ? ` (${readiness})` : ""}${
        notes ? ` — ${notes}` : ""
      }`,
      href: null,
    });
  }

  // High-impact derived evidence only (skip narrative / duplicate kinds)
  const keepEvidence = new Set(["faa", "investigation", "readiness", "net_slip", "weather_hazard"]);
  for (const e of f.evidence || []) {
    if (!keepEvidence.has(e.kind)) continue;
    const href = resolveSourceHref(e.source, f);
    add({
      key: `ev:${e.kind}:${e.detail}`,
      kind: e.kind === "faa" || e.kind === "investigation" ? "FAA" : "Signal",
      score: 45,
      detail: e.detail,
      href,
    });
  }

  drivers.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
  return drivers.slice(0, 5);
}

/** Collapse flat drivers into kind groups (order = first appearance / highest score). */
function groupDriversByKind(drivers) {
  const groups = [];
  const index = new Map();
  for (const d of drivers || []) {
    const kind = d.kind || "Signal";
    let g = index.get(kind);
    if (!g) {
      g = { kind, score: d.score ?? 0, items: [] };
      index.set(kind, g);
      groups.push(g);
    }
    g.score = Math.max(g.score, d.score ?? 0);
    g.items.push(d);
  }
  return groups;
}

function summarizeFlight(f, hardware) {
  const bits = [];
  if (f.outcome) bits.push(`Outcome ${f.outcome}`);
  else if (f.status) bits.push(`Status ${f.status}`);
  if (f.booster_outcome || f.ship_outcome) {
    bits.push(`Booster ${f.booster_outcome || "—"} · Ship ${f.ship_outcome || "—"}`);
  }
  if (f.investigation?.days != null && f.investigation?.closed) {
    bits.push(`FAA review ${f.investigation.days}d`);
  } else if (f.investigation?.opened && !f.investigation?.closed) {
    bits.push("FAA investigation open");
  }
  if (!f.launch_date && hardware?.earliest_ready) {
    bits.push(`ready ≥ ${hardware.earliest_ready}`);
  }
  return bits.join(" · ") || "No summary yet.";
}

export default function FlightDetail({ detail, hardware, compact = false }) {
  if (!detail?.flight) {
    return (
      <div className="flight-detail-embed">
        <h3>Flight detail</h3>
        <p className="muted">Click a flight in the upcoming windows list to see details.</p>
      </div>
    );
  }

  const f = detail.flight;
  const hw = hardware || detail.hardware || {};
  const projected = !!detail.projected;
  const driverGroups = groupDriversByKind(buildScheduleDrivers(detail, hw));
  const pad = f.pad || hw.pad || null;
  const pFlorida = hw.p_first_florida ?? detail.p_first_florida;
  const floridaPct =
    pFlorida != null && Number.isFinite(Number(pFlorida)) && Number(pFlorida) >= 0.05
      ? Math.round(Number(pFlorida) * 100)
      : null;
  const padLabel =
    floridaPct != null && (!pad || String(pad).toUpperCase().includes("OLP"))
      ? `${pad || "Starbase"} · Cape candidate`
      : pad || "—";

  return (
    <div className={`flight-detail-embed${compact ? " flight-detail-compact" : ""}`}>
      <h3>
        {compact ? (
          <span className={`pill ${f.status}`}>{projected ? "PROJECTED" : f.status}</span>
        ) : (
          <>
            Flight {f.flight_number}{" "}
            <span className={`pill ${f.status}`}>{projected ? "PROJECTED" : f.status}</span>
          </>
        )}
      </h3>

      <p className="summary-lead">{summarizeFlight(f, hw)}</p>

      <dl className="kv">
        <dt>Vehicles</dt>
        <dd>
          {f.booster || hw.booster || "—"} / {f.ship || hw.ship || "—"}
          {f.block != null ? ` (Block ${f.block})` : ""}
        </dd>
        <dt>Pad</dt>
        <dd>{padLabel}</dd>
        {floridaPct != null ? (
          <>
            <dt>Florida</dt>
            <dd>First Cape launch (LC-39A) in {floridaPct}% of sims</dd>
          </>
        ) : null}
        <dt>{projected ? "Model P50" : "Launch / NET"}</dt>
        <dd>{formatWhen(f)}</dd>
        <dt>Outcome</dt>
        <dd>{f.outcome || (projected ? "Not flown" : "—")}</dd>
        <dt>Pipeline</dt>
        <dd>
          {hw.readiness || f.pipeline_readiness || (f.launch_date ? "flown" : "—")}
          {hw.earliest_ready || f.pipeline_earliest_ready
            ? ` · earliest ${hw.earliest_ready || f.pipeline_earliest_ready}`
            : ""}
        </dd>
        {!projected && (
          <>
            <dt>LL2</dt>
            <dd>
              {ll2Href(f) ? (
                <a href={ll2Href(f)} target="_blank" rel="noreferrer">
                  {f.ll2_status || "Launch Library 2"}
                </a>
              ) : (
                f.ll2_status || "—"
              )}
            </dd>
          </>
        )}
      </dl>

      <h4>Schedule drivers</h4>
      <p className="muted drivers-hint">Inputs that most move this flight&apos;s projection</p>
      {driverGroups.length > 0 ? (
        <ul className="drivers">
          {driverGroups.map((g) => (
            <li key={g.kind} className="driver-group">
              <span className="driver-kind">{g.kind}</span>
              <ul className="driver-items">
                {g.items.map((d) => (
                  <li key={d.key} className="driver-body">
                    {d.detail}
                    {d.href ? (
                      <>
                        {" "}
                        <a className="section-source" href={d.href} target="_blank" rel="noreferrer">
                          source
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted drivers-empty">No flight-specific drivers — projection uses cadence priors.</p>
      )}
    </div>
  );
}

export { summarizeFlight, formatWhen, buildScheduleDrivers, groupDriversByKind };
