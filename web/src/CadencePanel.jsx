import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  Scatter,
  XAxis,
  YAxis,
  Label,
  LabelList,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  ZAxis,
} from "recharts";
import FlightDetail from "./FlightDetail.jsx";

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function monthKeyFromIso(iso) {
  if (!iso) return null;
  return String(iso).slice(0, 7);
}

function yearFromHorizon(horizon) {
  if (!horizon) return new Date().getUTCFullYear();
  return Number(String(horizon).slice(0, 4));
}

function parseIsoDate(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Month-start UTC timestamp for a ``YYYY-MM`` key (tick + curve sample). */
function monthStartTs(monthKey) {
  if (!monthKey || monthKey.length < 7) return null;
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  if (!y || !m) return null;
  return Date.UTC(y, m - 1, 1, 12, 0, 0);
}

/** Interpolate cumulative P50 along the monthly curve at time ``t``. */
function cumP50AtTime(monthlyTimed, t) {
  if (!monthlyTimed?.length || t == null) return null;
  if (t <= monthlyTimed[0].t) return Number(monthlyTimed[0].cum_p50) || 0;
  for (let i = 1; i < monthlyTimed.length; i++) {
    const a = monthlyTimed[i - 1];
    const b = monthlyTimed[i];
    if (t <= b.t) {
      const span = Math.max(1, b.t - a.t);
      const u = (t - a.t) / span;
      const ya = Number(a.cum_p50) || 0;
      const yb = Number(b.cum_p50) || 0;
      return ya + u * (yb - ya);
    }
  }
  return Number(monthlyTimed[monthlyTimed.length - 1].cum_p50) || 0;
}

/**
 * Flight markers at the true P50 / launch date (not snapped to month ticks).
 * Y sits on the cumulative P50 curve so dots track the line.
 */
/** Prefer API ``mfr_rate_trend``; fall back to walking back from latest completion + gaps. */
function resolveMfrRateTrend(assumptions) {
  const direct = assumptions?.mfr_rate_trend;
  if (Array.isArray(direct) && direct.length) return direct;

  const gaps = assumptions?.mfr_recent_gaps_days;
  const latestIso = assumptions?.mfr_latest_completed;
  if (!Array.isArray(gaps) || !gaps.length || !latestIso) return [];
  let t = parseIsoDate(latestIso)?.getTime();
  if (t == null) return [];

  const out = [];
  for (let i = gaps.length - 1; i >= 0; i--) {
    const gap = Number(gaps[i]);
    if (!(gap > 0)) continue;
    const rate = 30 / gap;
    out.unshift({
      date: new Date(t).toISOString().slice(0, 10),
      gap_days: gap,
      rate_per_month: rate,
      ship: i === gaps.length - 1 ? assumptions.mfr_latest_ship : null,
    });
    t -= gap * 86400000;
  }
  return out;
}

/**
 * Implied ship production rate points for the secondary axis.
 * Carries the last pre-window rate into tMin and holds the latest rate to tMax.
 */
function buildRateTrendSeries(trend, tMin, tMax) {
  if (tMin == null || tMax == null) return [];
  const pts = (trend || [])
    .map((p) => {
      const d = parseIsoDate(p.date);
      if (!d) return null;
      const rate = Number(p.rate_per_month);
      if (!Number.isFinite(rate)) return null;
      return {
        t: d.getTime(),
        mfr_rate: rate,
        ship: p.ship,
        from_ship: p.from_ship,
        gap_days: p.gap_days,
        flight_number: p.flight_number,
        label: `${rate.toFixed(2)}/mo`,
        z: 1,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  if (!pts.length) return [];

  const before = pts.filter((p) => p.t < tMin);
  const inRange = pts.filter((p) => p.t >= tMin && p.t <= tMax);
  const out = [];
  if (before.length) {
    const last = before[before.length - 1];
    out.push({ ...last, t: tMin, label: null });
  }
  for (const p of inRange) {
    if (out.length && out[out.length - 1].t === p.t) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  if (!out.length) return [];
  if (out[out.length - 1].t < tMax) {
    const last = out[out.length - 1];
    out.push({ ...last, t: tMax, label: null });
  }
  return out;
}

/** Step-sample rate onto monthly rows + inject kink points (shared X with cumulative). */
function mergeRateIntoChartData(monthly, rateTrend) {
  if (!monthly?.length) return monthly || [];
  if (!rateTrend?.length) {
    return monthly.map((m) => ({ ...m, mfr_rate: null }));
  }

  const rateAt = (t) => {
    let r = null;
    for (const p of rateTrend) {
      if (p.t <= t) r = p.mfr_rate;
      else break;
    }
    return r;
  };

  const t0 = monthly[0].t;
  const t1 = monthly[monthly.length - 1].t;
  const monthTs = new Set(monthly.map((m) => m.t));
  const base = monthly.map((m) => ({ ...m, mfr_rate: rateAt(m.t) }));

  const extras = [];
  for (const p of rateTrend) {
    if (p.t <= t0 || p.t >= t1 || monthTs.has(p.t)) continue;
    // Only real completion kinks (skip carry/hold endpoints without labels)
    if (!p.label) continue;
    extras.push({
      t: p.t,
      mfr_rate: p.mfr_rate,
      cum_p10: cumP50AtTime(monthly, p.t), // placeholder; overwritten below
      cum_p50: cumP50AtTime(monthly, p.t),
      cum_p90: null,
      ship: p.ship,
      mfr_label: p.label,
    });
  }

  // Interpolate P10/P90 at kink times so the band stays continuous
  const interp = (key, t) => {
    if (!monthly.length) return null;
    if (t <= monthly[0].t) return Number(monthly[0][key]) || 0;
    for (let i = 1; i < monthly.length; i++) {
      const a = monthly[i - 1];
      const b = monthly[i];
      if (t <= b.t) {
        const span = Math.max(1, b.t - a.t);
        const u = (t - a.t) / span;
        return (Number(a[key]) || 0) + u * ((Number(b[key]) || 0) - (Number(a[key]) || 0));
      }
    }
    return Number(monthly[monthly.length - 1][key]) || 0;
  };
  for (const e of extras) {
    e.cum_p10 = interp("cum_p10", e.t);
    e.cum_p50 = interp("cum_p50", e.t);
    e.cum_p90 = interp("cum_p90", e.t);
  }

  return [...base, ...extras].sort((a, b) => a.t - b.t || 0);
}

function buildFlightMarkers(flights, medianDists, monthlyTimed) {
  if (!monthlyTimed?.length) return [];
  const tMin = monthlyTimed[0].t;
  // Include through the last calendar day of the final month
  const lastKey = monthlyTimed[monthlyTimed.length - 1].month;
  let tMax = monthlyTimed[monthlyTimed.length - 1].t;
  if (lastKey && lastKey.length >= 7) {
    const y = Number(lastKey.slice(0, 4));
    const m = Number(lastKey.slice(5, 7));
    tMax = Date.UTC(y, m, 0, 23, 59, 59);
  }
  const byFn = new Map();

  for (const f of flights || []) {
    if (!f.launch_date) continue;
    const d = parseIsoDate(f.launch_date);
    if (!d) continue;
    const t = d.getTime();
    if (t < tMin || t > tMax) continue;
    byFn.set(f.flight_number, {
      flight_number: f.flight_number,
      label: `F${f.flight_number}`,
      kind: "flown",
      t,
      iso: String(f.launch_date).slice(0, 10),
    });
  }

  for (const dist of medianDists || []) {
    const fn = dist.flight_number;
    if (byFn.has(fn)) continue; // already flown
    const d = parseIsoDate(dist.date_p50);
    if (!d) continue;
    const t = d.getTime();
    if (t < tMin || t > tMax) continue;
    byFn.set(fn, {
      flight_number: fn,
      label: `F${fn}`,
      kind: "projected",
      t,
      iso: String(dist.date_p50).slice(0, 10),
    });
  }

  return [...byFn.values()]
    .sort((a, b) => a.t - b.t || a.flight_number - b.flight_number)
    .map((m) => ({
      ...m,
      y: cumP50AtTime(monthlyTimed, m.t),
      // Constant z so Scatter doesn't size by an unbound field
      z: 1,
    }));
}

function formatShortDate(iso) {
  const d = parseIsoDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Compact P10–P90 range for projected flight windows. */
function formatWindowRange(isoP10, isoP90) {
  const a = parseIsoDate(isoP10);
  const b = parseIsoDate(isoP90);
  if (!a || !b) return "—";
  if (a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)) {
    return formatShortDate(isoP10);
  }
  const sameMonth =
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
  if (sameMonth) {
    const month = a.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
    return `${month} ${a.getUTCDate()}–${b.getUTCDate()}`;
  }
  return `${formatShortDate(isoP10)} – ${formatShortDate(isoP90)}`;
}

function buildMonthFlightMap(flights, dists) {
  const map = {};
  const add = (key, entry) => {
    if (!key) return;
    const list = map[key] || (map[key] = []);
    if (list.some((x) => x.flight_number === entry.flight_number)) return;
    list.push(entry);
    list.sort((a, b) => a.flight_number - b.flight_number);
  };

  for (const f of flights || []) {
    if (f.launch_date) {
      add(monthKeyFromIso(f.launch_date), {
        flight_number: f.flight_number,
        kind: "flown",
        label: `F${f.flight_number}`,
        status: f.status,
      });
    } else if (f.net_date) {
      add(monthKeyFromIso(f.net_date), {
        flight_number: f.flight_number,
        kind: "scheduled",
        label: `F${f.flight_number}`,
        status: f.status,
      });
    }
  }

  for (const d of dists || []) {
    add(monthKeyFromIso(d.date_p50), {
      flight_number: d.flight_number,
      kind: "projected",
      label: `F${d.flight_number}`,
      status: null,
    });
  }

  return map;
}

/** Flights already launched in `year` before the first chart month. */
function yearBaselineFlown(flights, year, firstMonthKey) {
  let n = 0;
  for (const f of flights || []) {
    if (!f.launch_date) continue;
    const key = monthKeyFromIso(f.launch_date);
    if (!key || !key.startsWith(String(year))) continue;
    if (!firstMonthKey || key < firstMonthKey) n += 1;
  }
  return n;
}

function withCumulative(monthlyRows, baseline) {
  let sumExp = 0;
  let sumP10 = 0;
  let sumP50 = 0;
  let sumP90 = 0;
  return monthlyRows.map((m) => {
    sumExp += Number(m.expected) || 0;
    sumP10 += Number(m.p10) || 0;
    sumP50 += Number(m.p50) || 0;
    sumP90 += Number(m.p90) || 0;
    const cum_p50 = m.cum_p50 != null ? Number(m.cum_p50) : baseline + sumP50;
    const cum_p10 = m.cum_p10 != null ? Number(m.cum_p10) : baseline + sumP10;
    const cum_p75 = m.cum_p75 != null ? Number(m.cum_p75) : null;
    const cum_p90 = m.cum_p90 != null ? Number(m.cum_p90) : baseline + sumP90;
    const cum_expected =
      m.cum_expected != null ? Number(m.cum_expected) : baseline + sumExp;
    return {
      ...m,
      cum_expected,
      cum_p10,
      cum_p50,
      cum_p75,
      cum_p90,
      // Stacked area: transparent base to P10, then visible band P10→P90
      cum_band: Math.max(0, cum_p90 - cum_p10),
    };
  });
}

function FlightDotLabel({ x, y, value, isNarrow }) {
  if (!value || x == null || y == null) return null;
  const fontSize = isNarrow ? 9 : 11;
  return (
    <text
      x={x + (isNarrow ? 5 : 7)}
      y={y}
      dy="0.35em"
      fill="#e8eef7"
      fontSize={fontSize}
      fontWeight={650}
      className="chart-flight-label"
    >
      {value}
    </text>
  );
}

/** LL2 / status strings that mean the published NET is not a firm schedule. */
const UNCERTAIN_NET_HINTS = ["hold", "scrub", "stale", "to be determined", "tbd"];

/**
 * Firm "Scheduled" only when a published NET is still trustworthy.
 * Open scrub / LL2 hold-scrub-TBD / regulatory hold → treat as projected.
 */
function isFirmScheduled(flight, openScrubSet) {
  if (!flight?.net_date || flight.launch_date) return false;
  const fn = Number(flight.flight_number);
  if (openScrubSet?.has(fn)) return false;
  const status = String(flight.status || "").toUpperCase();
  if (status === "REGULATORY_HOLD") return false;
  const ll2 = String(flight.ll2_status || "").toLowerCase();
  if (UNCERTAIN_NET_HINTS.some((h) => ll2.includes(h))) return false;
  return true;
}

function primaryDateIso(row) {
  if (row.kind === "scheduled" && row.net_date) return row.net_date;
  return row.date_p50;
}

function kindLabel(kind) {
  return kind === "scheduled" ? "Scheduled" : "Projected";
}

function projectedRangeNote(row) {
  const window = formatWindowRange(row.date_p10, row.date_p90);
  if (row.net_date) {
    return `NET ${formatShortDate(row.net_date)} · likely ${window}`;
  }
  return `Likely ${window}`;
}

function ExpandCue({ expanded }) {
  return (
    <span className={`timeline-expand-cue ${expanded ? "timeline-expand-cue-open" : ""}`}>
      <span className="timeline-expand-label">{expanded ? "Hide" : "Details"}</span>
      <span className="timeline-chevron" aria-hidden="true">
        {expanded ? "▾" : "▸"}
      </span>
    </span>
  );
}

function formatPadReadyMonth(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

function floridaCalloutText(ff) {
  if (!ff?.mode_flight) return null;
  const pct = Math.round((ff.p_mode || 0) * 100);
  const pad = ff.pad || "LC-39A";
  const ready = formatPadReadyMonth(ff.available_after_p50 || ff.available_after);
  const readyBit = ready ? ` · pad ready ~${ready}` : "";
  return `First Florida launch (${pad}): most likely F${ff.mode_flight} (${pct}%)${readyBit}`;
}

function FloridaChip({ p }) {
  if (p == null || p < 0.05) return null;
  const pct = Math.round(p * 100);
  return (
    <span className="chip-florida" title={`First Cape launch in ${pct}% of sims`}>
      Florida {pct}%
    </span>
  );
}

function flightRowAriaLabel(row) {
  const date = formatShortDate(primaryDateIso(row));
  const kind = kindLabel(row.kind);
  if (row.kind === "projected") {
    const pct = Math.round((row.p_by_eoy ?? 0) * 100);
    return `${row.label} ${kind}, ${date}, ${pct}%`;
  }
  return `${row.label} ${kind}, ${date}`;
}

function FlightTimeline({
  rows,
  selectedFlight,
  onSelectFlight,
  detail,
  detailError,
  hardware,
  rowRefs,
}) {
  if (!rows.length) {
    return <p className="muted timeline-empty">No median-path flights in range.</p>;
  }

  const [next, ...rest] = rows;

  function bindRowRef(flightNumber) {
    return (el) => {
      if (!rowRefs) return;
      if (el) rowRefs.current.set(flightNumber, el);
      else rowRefs.current.delete(flightNumber);
    };
  }

  function renderDetail(row) {
    const active = selectedFlight === row.flight_number;
    if (!active) return null;
    const detailReady = detail?.flight?.flight_number === row.flight_number;
    return (
      <div className="timeline-detail" id={`flight-detail-${row.flight_number}`}>
        {detailReady ? (
          <FlightDetail detail={detail} hardware={hardware} compact />
        ) : detailError ? (
          <p className="error timeline-detail-loading">Error: {detailError}</p>
        ) : (
          <p className="muted timeline-detail-loading">Loading flight details…</p>
        )}
      </div>
    );
  }

  function renderNext(row) {
    const active = selectedFlight === row.flight_number;
    const projected = row.kind === "projected";
    const pct = Math.round((row.p_by_eoy ?? 0) * 100);
    return (
      <div
        key={row.flight_number}
        className={`timeline-item timeline-next ${active ? "timeline-item-active" : ""}`}
        ref={bindRowRef(row.flight_number)}
      >
        <button
          type="button"
          className={`timeline-next-btn ${active ? "timeline-row-active" : ""}`}
          onClick={() => onSelectFlight?.(row.flight_number)}
          aria-expanded={active}
          aria-controls={`flight-detail-${row.flight_number}`}
          aria-label={flightRowAriaLabel(row)}
        >
          <span className="timeline-next-body">
            <span className="timeline-next-eyebrow">Next up</span>
            <span className="timeline-next-date">{formatShortDate(primaryDateIso(row))}</span>
            <span className="timeline-next-meta">
              <span className="timeline-next-flight">{row.label}</span>
              <span className="chip-kind">{kindLabel(row.kind)}</span>
              <FloridaChip p={row.p_first_florida} />
              {projected ? <span className="timeline-prob">{pct}%</span> : null}
            </span>
            {projected ? (
              <span className="timeline-range muted">{projectedRangeNote(row)}</span>
            ) : null}
          </span>
          <ExpandCue expanded={active} />
        </button>
        {renderDetail(row)}
      </div>
    );
  }

  function renderCompact(row) {
    const active = selectedFlight === row.flight_number;
    const projected = row.kind === "projected";
    const pct = Math.round((row.p_by_eoy ?? 0) * 100);
    return (
      <div
        key={row.flight_number}
        className={`timeline-item ${active ? "timeline-item-active" : ""}`}
        ref={bindRowRef(row.flight_number)}
      >
        <button
          type="button"
          className={`timeline-row ${active ? "timeline-row-active" : ""}`}
          onClick={() => onSelectFlight?.(row.flight_number)}
          aria-expanded={active}
          aria-controls={`flight-detail-${row.flight_number}`}
          aria-label={flightRowAriaLabel(row)}
        >
          <span className="timeline-dates">
            <strong>{formatShortDate(primaryDateIso(row))}</strong>
            {projected ? (
              <span className="timeline-range muted">{projectedRangeNote(row)}</span>
            ) : null}
          </span>
          <span className="timeline-label">
            <span className="timeline-flight">{row.label}</span>
            <span className="chip-kind">{kindLabel(row.kind)}</span>
            <FloridaChip p={row.p_first_florida} />
          </span>
          <span className="timeline-prob-cell">
            {projected ? <span className="timeline-prob">{pct}%</span> : null}
          </span>
          <ExpandCue expanded={active} />
        </button>
        {renderDetail(row)}
      </div>
    );
  }

  return (
    <div className="flight-timeline">
      <p className="timeline-hint muted">Tap a flight for details</p>
      {renderNext(next)}
      {rest.length > 0 ? (
        <div className="timeline-list">{rest.map(renderCompact)}</div>
      ) : null}
    </div>
  );
}

export default function CadencePanel({
  cadence,
  flights = [],
  selectedFlight,
  selectedMonth,
  onSelectFlight,
  onSelectMonth,
  detail,
  detailError,
  hardware,
}) {
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const isDesktop = useMediaQuery("(min-width: 960px)");
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const timelineRowRefs = useRef(new Map());
  const dists = useMemo(() => cadence?.flight_distributions || [], [cadence]);
  // Align timeline with the cumulative P50 story: only flights that
  // occur in at least half of sims by the horizon (median-path / better).
  const medianDists = useMemo(
    () => dists.filter((d) => (d.p_by_eoy ?? 0) >= 0.5),
    [dists]
  );
  const monthFlights = useMemo(
    () => buildMonthFlightMap(flights, medianDists),
    [flights, medianDists]
  );
  const year = yearFromHorizon(cadence?.horizon);

  function selectFlightAndReveal(n, { toggle = false } = {}) {
    if (toggle && selectedFlight === n) {
      onSelectFlight?.(null);
      return;
    }
    // Month highlighting is handled inside App.selectFlight — do not call
    // onSelectMonth here (it snaps to the month's first flight and can
    // overwrite the flight the user just clicked).
    onSelectFlight?.(n);
    requestAnimationFrame(() => {
      timelineRowRefs.current.get(n)?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "nearest",
      });
    });
  }

  const monthly = useMemo(() => {
    const rows = cadence?.monthly || [];
    const firstMonth = rows[0]?.month;
    const baseline = yearBaselineFlown(flights, year, firstMonth);
    const lastIdx = rows.length - 1;
    // End domain on the last calendar day of the final month so the final
    // tick/curve point sits on the chart's right edge (not inset).
    let tEnd = null;
    if (lastIdx >= 0) {
      const lastKey = rows[lastIdx].month;
      if (lastKey && lastKey.length >= 7) {
        const y = Number(lastKey.slice(0, 4));
        const m = Number(lastKey.slice(5, 7));
        tEnd = Date.UTC(y, m, 0, 12, 0, 0); // last day of month
      }
    }
    const enriched = rows.map((m, i) => {
      const list = monthFlights[m.month] || [];
      const t =
        i === lastIdx && tEnd != null ? tEnd : monthStartTs(m.month);
      return {
        ...m,
        t,
        flight_count: list.length,
        flight_labels: list.map((f) => f.label).join(" · "),
        selected: m.month === selectedMonth,
      };
    });
    return withCumulative(enriched, baseline);
  }, [cadence, monthFlights, selectedMonth, flights, year]);

  const yearBaseline = useMemo(() => {
    const firstMonth = (cadence?.monthly || [])[0]?.month;
    return yearBaselineFlown(flights, year, firstMonth);
  }, [cadence, flights, year]);

  const flightMarkers = useMemo(
    () => buildFlightMarkers(flights, medianDists, monthly),
    [flights, medianDists, monthly]
  );

  /** Domain matches first/last curve points so the final month tick is flush right. */
  const timeDomain = useMemo(() => {
    const ts = monthly.map((m) => m.t).filter((t) => t != null);
    if (!ts.length) return ["dataMin", "dataMax"];
    return [Math.min(...ts), Math.max(...ts)];
  }, [monthly]);

  const monthTicks = useMemo(
    () => monthly.map((m) => m.t).filter((t) => t != null),
    [monthly]
  );

  const rateTrend = useMemo(() => {
    const trend = resolveMfrRateTrend(cadence?.assumptions);
    if (!Array.isArray(timeDomain) || timeDomain.length < 2) return [];
    const [tMin, tMax] = timeDomain;
    if (typeof tMin !== "number" || typeof tMax !== "number") return [];
    return buildRateTrendSeries(trend, tMin, tMax);
  }, [cadence, timeDomain]);

  const chartData = useMemo(
    () => mergeRateIntoChartData(monthly, rateTrend),
    [monthly, rateTrend]
  );

  const rateMarkers = useMemo(
    () => rateTrend.filter((p) => p.label),
    [rateTrend]
  );

  const rateYMax = useMemo(() => {
    const rates = rateTrend.map((p) => Number(p.mfr_rate) || 0);
    const stated = Number(cadence?.assumptions?.stated_manufacturing_rate_rockets_per_month);
    if (stated > 0) rates.push(stated);
    const hi = rates.length ? Math.max(...rates) : 1;
    return Math.max(1, Math.ceil(hi * 2) / 2); // nice half-ship steps
  }, [rateTrend, cadence]);

  const yearTot = cadence?.calendar_year_flights || {};
  const yearP50Early = yearTot.p50;

  const openScrubSet = useMemo(() => {
    const list = cadence?.assumptions?.open_scrub_flights || [];
    return new Set(list.map((n) => Number(n)).filter((n) => Number.isFinite(n)));
  }, [cadence]);

  const timelineRows = useMemo(() => {
    // Cap count to calendar-year P50 so the list matches the fan chart endpoint.
    const p50Total =
      yearP50Early != null
        ? Math.round(Number(yearP50Early))
        : yearBaseline + medianDists.length;
    const maxFuture = Math.max(0, p50Total - yearBaseline);

    const rows = [];
    for (const d of medianDists) {
      const t50 = parseIsoDate(d.date_p50);
      if (!t50 || !d.date_p10 || !d.date_p90) continue;
      const flight = (flights || []).find((f) => f.flight_number === d.flight_number);
      const firm = isFirmScheduled(flight, openScrubSet);
      rows.push({
        flight_number: d.flight_number,
        label: `F${d.flight_number}`,
        kind: firm ? "scheduled" : "projected",
        net_date: flight?.net_date && !flight.launch_date ? flight.net_date : null,
        date_p10: d.date_p10,
        date_p50: d.date_p50,
        date_p90: d.date_p90,
        t50: t50.getTime(),
        p_by_eoy: d.p_by_eoy,
        p_first_florida: d.p_first_florida,
      });
    }
    rows.sort((a, b) => a.t50 - b.t50 || a.flight_number - b.flight_number);
    return rows.slice(0, maxFuture);
  }, [medianDists, flights, yearBaseline, yearP50Early, openScrubSet]);

  if (!cadence) {
    return (
      <section className="cadence-panel">
        <div className="panel">
          <h2>Cadence projection</h2>
          <p className="muted">Loading projection…</p>
        </div>
      </section>
    );
  }

  const endCum = monthly[monthly.length - 1];
  const yearP50 = yearTot.p50 ?? endCum?.cum_p50;
  const yearP90 = yearTot.p90 ?? endCum?.cum_p90;
  const yMax = Math.max(
    yearBaseline + 1,
    ...(monthly.map((m) => Number(m.cum_p90) || 0)),
    Number(yearP90) || 0
  );
  const outlookModeRaw = yearTot.mode ?? yearP50;
  const outlookMode =
    outlookModeRaw != null && Number.isFinite(Number(outlookModeRaw))
      ? Math.round(Number(outlookModeRaw))
      : null;
  const outlookProb =
    yearTot.p_mode != null && Number.isFinite(Number(yearTot.p_mode))
      ? Number(yearTot.p_mode)
      : null;
  const floridaNote = floridaCalloutText(cadence?.assumptions?.florida_first);

  return (
    <section className="cadence-panel">
      <div className="cadence-header">
        <h2>
          {year} flights · through {cadence.horizon}
        </h2>
        {floridaNote ? <p className="florida-callout">{floridaNote}</p> : null}
      </div>

      <div className="cadence-main">
        <div className="cadence-chart-col">
          <div className="panel cadence-col">
          <div className="chart-block">
            <div className="chart-block-label">
              Cumulative {year} flights
              <span className="muted">
                {" "}
                — band P10–P90 ·{" "}
                <span className="chart-legend-flights">P50 flights</span> ·{" "}
                <span className="chart-legend-mfr">ship build rate</span>
              </span>
            </div>
            <div className="chart-wrap chart-wrap-main">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={0}
                minHeight={isDesktop ? 360 : 200}
              >
                <ComposedChart
                  data={chartData}
                  margin={
                    isNarrow
                      ? { top: 14, right: 12, left: 2, bottom: 18 }
                      : isDesktop
                        ? { top: 20, right: 28, left: 12, bottom: 28 }
                        : { top: 16, right: 18, left: 8, bottom: 22 }
                  }
                  onClick={(state) => {
                    const payload = state?.activePayload?.[0]?.payload;
                    if (payload?.flight_number != null) {
                      selectFlightAndReveal(payload.flight_number);
                      return;
                    }
                    const m = payload?.month;
                    if (m && onSelectMonth) onSelectMonth(m);
                  }}
                >
                  <CartesianGrid stroke="#243247" strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="t"
                    stroke="#8fa3bf"
                    tick={{ fontSize: isNarrow ? 9 : 11, fill: "#8fa3bf" }}
                    domain={timeDomain}
                    ticks={monthTicks}
                    padding={{ left: 0, right: 0 }}
                    tickFormatter={(v) => {
                      const d = new Date(Number(v));
                      if (Number.isNaN(d.getTime())) return "";
                      // Last tick is month-end; still label by that month.
                      return isNarrow
                        ? String(d.getUTCMonth() + 1).padStart(2, "0")
                        : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
                    }}
                    allowDecimals={false}
                  >
                    <Label
                      value="Month"
                      position="insideBottom"
                      offset={isNarrow ? -2 : -4}
                      fill="#8fa3bf"
                      fontSize={isNarrow ? 10 : 11}
                    />
                  </XAxis>
                  <YAxis
                    yAxisId="flights"
                    stroke="#f0b429"
                    tick={{ fontSize: isNarrow ? 9 : 11, fill: "#f0b429" }}
                    width={isNarrow ? 36 : 44}
                    domain={[0, Math.max(1, Math.ceil(yMax))]}
                    allowDecimals={false}
                  >
                    <Label
                      value="Cumulative flights"
                      angle={-90}
                      position="insideLeft"
                      style={{ textAnchor: "middle", fill: "#f0b429" }}
                      fontSize={isNarrow ? 10 : 11}
                      offset={isNarrow ? 2 : 4}
                    />
                  </YAxis>
                  <YAxis
                    yAxisId="mfr"
                    orientation="right"
                    stroke="#3dcea8"
                    tick={{ fontSize: isNarrow ? 9 : 11, fill: "#3dcea8" }}
                    width={isNarrow ? 36 : 44}
                    domain={[0, rateYMax]}
                    tickFormatter={(v) => (Number(v) % 1 === 0 ? `${v}` : Number(v).toFixed(1))}
                    allowDecimals
                  >
                    <Label
                      value="Ship build rate (/mo)"
                      angle={90}
                      position="insideRight"
                      style={{ textAnchor: "middle", fill: "#3dcea8" }}
                      fontSize={isNarrow ? 10 : 11}
                      offset={isNarrow ? 2 : 4}
                    />
                  </YAxis>
                  <ZAxis type="number" dataKey="z" range={[60, 60]} />
                  {yearBaseline > 0 && (
                    <ReferenceLine
                      yAxisId="flights"
                      y={yearBaseline}
                      stroke="#f0b429"
                      strokeDasharray="4 4"
                      strokeOpacity={0.45}
                    />
                  )}
                  {Number(cadence?.assumptions?.stated_manufacturing_rate_rockets_per_month) > 0 && (
                    <ReferenceLine
                      yAxisId="mfr"
                      y={Number(cadence.assumptions.stated_manufacturing_rate_rockets_per_month)}
                      stroke="#3dcea8"
                      strokeDasharray="3 4"
                      strokeOpacity={0.45}
                    />
                  )}
                  <Area
                    yAxisId="flights"
                    type="monotone"
                    dataKey="cum_p90"
                    name="P90"
                    stroke="rgba(240, 180, 41, 0.45)"
                    fill="rgba(240, 180, 41, 0.22)"
                    isAnimationActive={false}
                  />
                  <Area
                    yAxisId="flights"
                    type="monotone"
                    dataKey="cum_p10"
                    name="P10"
                    stroke="none"
                    fill="#101826"
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="flights"
                    type="monotone"
                    dataKey="cum_p50"
                    name="P50"
                    stroke="#f0b429"
                    strokeWidth={isNarrow ? 2.25 : 2.75}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                  {rateTrend.length > 0 && (
                    <Line
                      yAxisId="mfr"
                      type="stepAfter"
                      dataKey="mfr_rate"
                      name="Ship build rate"
                      stroke="#3dcea8"
                      strokeWidth={isNarrow ? 1.75 : 2.1}
                      dot={false}
                      activeDot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  )}
                  {rateMarkers.length > 0 && (
                    <Scatter
                      yAxisId="mfr"
                      data={rateMarkers}
                      dataKey="mfr_rate"
                      name="Rate points"
                      fill="#3dcea8"
                      stroke="#101826"
                      strokeWidth={1}
                      isAnimationActive={false}
                      shape={(props) => {
                        const { cx, cy } = props;
                        if (cx == null || cy == null) return null;
                        const r = isNarrow ? 2.75 : 3.25;
                        return (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={r}
                            fill="#3dcea8"
                            stroke="#101826"
                            strokeWidth={1}
                          />
                        );
                      }}
                    >
                      <LabelList
                        dataKey="label"
                        content={(props) => {
                          const { x, y, value } = props;
                          if (x == null || y == null || !value) return null;
                          return (
                            <text
                              x={x}
                              y={y - (isNarrow ? 8 : 10)}
                              textAnchor="middle"
                              fill="#3dcea8"
                              fontSize={isNarrow ? 9 : 10}
                              fontWeight={600}
                            >
                              {value}
                            </text>
                          );
                        }}
                      />
                    </Scatter>
                  )}
                  <Scatter
                    yAxisId="flights"
                    data={flightMarkers}
                    dataKey="y"
                    name="Flights"
                    fill="#f0b429"
                    stroke="#101826"
                    strokeWidth={1}
                    isAnimationActive={false}
                    shape={(props) => {
                      const { cx, cy } = props;
                      if (cx == null || cy == null) return null;
                      const r = isNarrow ? 3.25 : 3.75;
                      return (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={r}
                          fill="#f0b429"
                          stroke="#101826"
                          strokeWidth={1}
                        />
                      );
                    }}
                  >
                    <LabelList
                      dataKey="label"
                      content={(props) => <FlightDotLabel {...props} isNarrow={isNarrow} />}
                    />
                  </Scatter>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {outlookMode != null && (
              <div className="year-outlook" aria-label={`${year} flight outlook`}>
                <div className="year-outlook-main">
                  <span className="year-outlook-label">
                    Most common {year} finish
                    {yearBaseline > 0 ? (
                      <span className="year-outlook-ytd">
                        {" "}
                        · {yearBaseline} already flown
                      </span>
                    ) : null}
                  </span>
                  <span className="year-outlook-value">
                    {outlookMode} {outlookMode === 1 ? "flight" : "flights"}
                  </span>
                </div>
                {outlookProb != null ? (
                  <p className="year-outlook-explain">
                    <strong>{Math.round(outlookProb * 100)}%</strong> of simulated years end at
                    exactly {outlookMode}
                  </p>
                ) : null}
              </div>
            )}
          </div>
          </div>

          <div className="panel cadence-col">
          <div className="chart-block">
            <div className="chart-block-label">
              Upcoming flight windows
              <span className="muted">
                {" "}
                — next flight first · median path (matches P50 total)
              </span>
            </div>
            <FlightTimeline
              rows={timelineRows}
              selectedFlight={selectedFlight}
              onSelectFlight={(n) => selectFlightAndReveal(n, { toggle: true })}
              detail={detail}
              detailError={detailError}
              hardware={hardware}
              rowRefs={timelineRowRefs}
            />
            {selectedFlight != null &&
              !timelineRows.some((r) => r.flight_number === selectedFlight) && (
                <div className="timeline-detail-fallback">
                  {detail?.flight?.flight_number === selectedFlight ? (
                    <FlightDetail detail={detail} hardware={hardware} />
                  ) : detailError ? (
                    <p className="error timeline-detail-loading">Error: {detailError}</p>
                  ) : (
                    <p className="muted timeline-detail-loading">Loading flight details…</p>
                  )}
                </div>
              )}
          </div>
          </div>
        </div>
      </div>
    </section>
  );
}
