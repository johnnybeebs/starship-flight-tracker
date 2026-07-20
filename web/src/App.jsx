import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

const CadencePanel = lazy(() => import("./CadencePanel.jsx"));

function AboutInfo({ nSims }) {
  const dialogRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="info-btn"
        aria-label="About this project"
        title="About this project"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">i</span>
      </button>
      <dialog
        ref={dialogRef}
        className="info-dialog"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setOpen(false);
        }}
      >
        <div className="info-dialog-body">
          <div className="info-dialog-head">
            <h2>About Starship Flight Tracker</h2>
            <button type="button" className="info-dialog-close" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <p>
            An independent dashboard that tracks SpaceX Starship integrated flight tests and
            projects how the rest of the year may unfold.
          </p>
          <p>
            <strong>Live data.</strong> Flight NET dates and statuses come from{" "}
            <a href="https://ll.thespacedevs.com/" target="_blank" rel="noreferrer">
              Launch Library 2
            </a>
            . Related news is pulled from the{" "}
            <a href="https://api.spaceflightnewsapi.net/" target="_blank" rel="noreferrer">
              Spaceflight News API
            </a>
            , with signals (NET slips, FAA actions, scrubs, readiness) extracted from article
            titles and summaries.
          </p>
          <p>
            <strong>Per-flight status.</strong> Each flight is placed on a simple state machine
            (announced → testing → regulatory hold / go → flown → investigation → closed) using
            seed history, LL2, and those news signals.
          </p>
          <p>
            <strong>Cadence projection (Monte Carlo).</strong> The chart and “upcoming flight
            windows” are a probabilistic forecast through the end of the horizon year. The model
            runs about {nSims ?? 150} simulated timelines that blend:
          </p>
          <ul>
            <li>recent inter-flight gaps (with long mishap outliers capped)</li>
            <li>stated cadence goals and how often those goals have been met historically</li>
            <li>published NET anchors and slip velocity</li>
            <li>hardware / manufacturing readiness floors from the vehicle pipeline</li>
            <li>scrub / recycle delays and mishap → investigation holds</li>
          </ul>
          <p>
            For each future flight you’ll see median (P50) dates plus a P10–P90 band — not a
            single guaranteed date. The year-outlook card shows the most common simulated finish
            count for the calendar year. Projections refresh when upstream inputs change.
          </p>
        </div>
      </dialog>
    </>
  );
}

async function getJson(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function pipelineIndex(cadence) {
  const map = {};
  for (const p of cadence?.pipeline || []) {
    map[p.flight_number] = p;
  }
  for (const d of cadence?.flight_distributions || []) {
    const prev = map[d.flight_number] || { flight_number: d.flight_number };
    map[d.flight_number] = {
      ...prev,
      ...(d.hardware || {}),
      p_first_florida: d.p_first_florida,
    };
  }
  return map;
}

function monthOfFlight(flight, dist) {
  const iso = flight?.launch_date || flight?.net_date || dist?.date_p50;
  return iso ? String(iso).slice(0, 7) : null;
}

function formatSyncTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatPollInterval(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s < 3600) {
    const mins = Math.round(s / 60);
    return mins === 1 ? "every 1 min" : `every ${mins} min`;
  }
  const hours = Math.round(s / 3600);
  return hours === 1 ? "every 1 hour" : `every ${hours} hours`;
}

function formatIdlePollCadence(hourLocal) {
  const hour = Number(hourLocal);
  if (!Number.isFinite(hour)) return "daily";
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  return `daily ${h12} ${suffix}`;
}

function buildSyncNote(health, horizon) {
  const parts = [`Cadence through ${horizon || "2026-12-31"}`];

  const lastIso =
    health?.last_poll_at ||
    health?.cadence_synced_at ||
    health?.ll2_synced_at ||
    health?.news_synced_at;
  const lastLabel = formatSyncTime(lastIso);
  if (lastLabel) parts.push(`Updated ${lastLabel}`);

  const nextIso = health?.next_poll_at;
  const nextDate = nextIso ? new Date(nextIso) : null;
  const cadence = health?.near_launch
    ? formatPollInterval(health?.poll_interval_s)
    : health?.poll_idle_hour_local != null
      ? formatIdlePollCadence(health.poll_idle_hour_local)
      : formatPollInterval(health?.poll_interval_s);
  const mode = health?.near_launch ? "near-launch" : null;
  const extras = [cadence, mode].filter(Boolean).join(", ");
  if (nextDate && !Number.isNaN(nextDate.getTime())) {
    const overdue = nextDate.getTime() < Date.now() - 60_000;
    const nextLabel = overdue ? "due soon" : formatSyncTime(nextIso);
    parts.push(extras ? `Next ${nextLabel} (${extras})` : `Next ${nextLabel}`);
  } else if (cadence) {
    parts.push(`Polls ${cadence}`);
  }

  if (health && !health.has_anthropic) parts.push("heuristic mode");
  return parts.join(" · ");
}

export default function App() {
  const [flights, setFlights] = useState([]);
  const [cadence, setCadence] = useState(null);
  const [selected, setSelected] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  const hwByFlight = useMemo(() => pipelineIndex(cadence), [cadence]);
  const flightByNumber = useMemo(() => {
    const m = {};
    for (const f of flights) m[f.flight_number] = f;
    return m;
  }, [flights]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [f, c, h] = await Promise.all([
        getJson("/api/flights"),
        getJson("/api/cadence"),
        getJson("/api/health"),
      ]);
      setFlights(f.flights || []);
      setCadence(c);
      setHealth(h);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Drop stale detail immediately when the selection changes (not on cadence poll).
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
  }, [selected]);

  useEffect(() => {
    if (selected == null) return;
    let cancelled = false;
    getJson(`/api/flights/${selected}`)
      .then((d) => {
        if (cancelled) return;
        // Merge cadence projection dates onto projected stubs
        const dist = cadence?.flight_distributions?.find((x) => x.flight_number === selected);
        if (d.projected && dist && d.flight) {
          d = {
            ...d,
            flight: {
              ...d.flight,
              net_date: dist.date_p50 ? `${dist.date_p50}T12:00:00Z` : d.flight.net_date,
            },
          };
        }
        setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(e.message || String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, cadence]);

  function selectFlight(n) {
    setSelected(n);
    if (n == null) return;
    const flight = flightByNumber[n];
    const dist = cadence?.flight_distributions?.find((d) => d.flight_number === n);
    const month = monthOfFlight(flight, dist);
    if (month) setSelectedMonth(month);
  }

  function selectMonth(month) {
    setSelectedMonth(month);
    if (!month) return;

    const inMonth = [];
    for (const f of flights) {
      const iso = f.launch_date || f.net_date;
      if (iso && String(iso).slice(0, 7) === month) inMonth.push(f.flight_number);
    }
    for (const d of cadence?.flight_distributions || []) {
      if (String(d.date_p50).slice(0, 7) === month && !inMonth.includes(d.flight_number)) {
        inMonth.push(d.flight_number);
      }
    }
    inMonth.sort((a, b) => a - b);
    if (inMonth.length && !inMonth.includes(selected)) {
      setSelected(inMonth[0]);
    }
  }

  const syncNote = buildSyncNote(health, cadence?.horizon);

  return (
    <div className="app">
      <header className="top">
        <div className="top-bar">
          <h1>Starship Flight Tracker</h1>
          <AboutInfo nSims={cadence?.n_sims} />
        </div>
        <p className="top-sub">{syncNote}</p>
      </header>

      {error && <p className="error">Error: {error}</p>}

      <Suspense fallback={<p className="muted">Loading cadence…</p>}>
        <CadencePanel
          cadence={cadence}
          flights={flights}
          selectedFlight={selected}
          selectedMonth={selectedMonth}
          onSelectFlight={selectFlight}
          onSelectMonth={selectMonth}
          detail={detail}
          detailError={detailError}
          hardware={hwByFlight[selected]}
        />
      </Suspense>
    </div>
  );
}
