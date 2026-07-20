// Port of server/app/db.py onto D1. Same upsert/COALESCE semantics.
// Writes during a poll cycle are collected as prepared statements and run
// through db.batch() to stay within the free-tier subrequest budget.

import type { Article, Flight, Investigation, NetHistoryRow, Signal } from "./types";
import flightsSeed from "../seeds/flights_seed.json";

export function utcnow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Row parsing

interface FlightRow {
  flight_number: number;
  milestones_json: string | null;
  investigation_json: string | null;
  ll2_raw_json: string | null;
  [key: string]: unknown;
}

function flightRow(row: FlightRow): Flight {
  const { milestones_json, investigation_json, ll2_raw_json, ...rest } = row;
  return {
    ...(rest as unknown as Flight),
    milestones: safeParse(milestones_json, []) as unknown[],
    investigation: (investigation_json ? safeParse(investigation_json, null) : null) as Investigation | null,
    ll2_raw: (ll2_raw_json ? safeParse(ll2_raw_json, null) : null) as Record<string, unknown> | null,
  };
}

function safeParse(raw: string | null | undefined, fallback: unknown): unknown {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Meta

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

export function setMetaStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value);
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await setMetaStmt(db, key, value).run();
}

// ---------------------------------------------------------------------------
// Flights

export interface FlightPatch {
  flight_number: number;
  name?: string | null;
  launch_date?: string | null;
  net_date?: string | null;
  booster?: string | null;
  ship?: string | null;
  block?: number | null;
  pad?: string | null;
  outcome?: string | null;
  booster_outcome?: string | null;
  ship_outcome?: string | null;
  milestones?: unknown[];
  investigation?: Investigation | null;
  ll2_id?: string | null;
  ll2_status?: string | null;
  ll2_raw?: Record<string, unknown> | null;
  status_hint?: string | null;
}

export function upsertFlightStmt(
  db: D1Database,
  flight: FlightPatch,
  opts: { preferExistingDates?: boolean } = {}
): D1PreparedStatement {
  // Only write milestones/investigation when the caller supplies them — LL2/news
  // patches must not clobber seed history with empty JSON arrays.
  const milestonesJson = "milestones" in flight ? JSON.stringify(flight.milestones ?? []) : null;
  const investigationJson =
    "investigation" in flight && flight.investigation != null ? JSON.stringify(flight.investigation) : null;

  // Seed reloads must not overwrite live LL2/signal NETs; LL2/signal patches prefer incoming.
  const netDateSql = opts.preferExistingDates
    ? "net_date=COALESCE(flights.net_date, excluded.net_date)"
    : "net_date=COALESCE(excluded.net_date, flights.net_date)";
  const launchDateSql = opts.preferExistingDates
    ? "launch_date=COALESCE(flights.launch_date, excluded.launch_date)"
    : "launch_date=COALESCE(excluded.launch_date, flights.launch_date)";

  return db
    .prepare(
      `INSERT INTO flights(
          flight_number, name, launch_date, net_date, booster, ship, block, pad,
          outcome, booster_outcome, ship_outcome, milestones_json, investigation_json,
          ll2_id, ll2_status, ll2_raw_json, status_hint, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flight_number) DO UPDATE SET
          name=COALESCE(excluded.name, flights.name),
          ${launchDateSql},
          ${netDateSql},
          booster=COALESCE(excluded.booster, flights.booster),
          ship=COALESCE(excluded.ship, flights.ship),
          block=COALESCE(excluded.block, flights.block),
          pad=COALESCE(excluded.pad, flights.pad),
          outcome=COALESCE(excluded.outcome, flights.outcome),
          booster_outcome=COALESCE(excluded.booster_outcome, flights.booster_outcome),
          ship_outcome=COALESCE(excluded.ship_outcome, flights.ship_outcome),
          milestones_json=COALESCE(excluded.milestones_json, flights.milestones_json),
          investigation_json=COALESCE(excluded.investigation_json, flights.investigation_json),
          ll2_id=COALESCE(excluded.ll2_id, flights.ll2_id),
          ll2_status=COALESCE(excluded.ll2_status, flights.ll2_status),
          ll2_raw_json=COALESCE(excluded.ll2_raw_json, flights.ll2_raw_json),
          status_hint=COALESCE(excluded.status_hint, flights.status_hint),
          updated_at=excluded.updated_at`
    )
    .bind(
      flight.flight_number,
      flight.name ?? null,
      flight.launch_date ?? null,
      flight.net_date ?? null,
      flight.booster ?? null,
      flight.ship ?? null,
      flight.block ?? null,
      flight.pad ?? null,
      flight.outcome ?? null,
      flight.booster_outcome ?? null,
      flight.ship_outcome ?? null,
      milestonesJson,
      investigationJson,
      flight.ll2_id ?? null,
      flight.ll2_status ?? null,
      flight.ll2_raw != null ? JSON.stringify(flight.ll2_raw) : null,
      flight.status_hint ?? null,
      utcnow()
    );
}

export function recordNetStmt(
  db: D1Database,
  flightNumber: number,
  netDate: string,
  source = "ll2"
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO net_history(flight_number, net_date, observed_at, source) VALUES (?, ?, ?, ?)"
    )
    .bind(flightNumber, netDate, utcnow(), source);
}

export async function listFlights(db: D1Database): Promise<Flight[]> {
  const res = await db.prepare("SELECT * FROM flights ORDER BY flight_number").all<FlightRow>();
  return (res.results ?? []).map(flightRow);
}

export async function getFlight(db: D1Database, flightNumber: number): Promise<Flight | null> {
  const row = await db
    .prepare("SELECT * FROM flights WHERE flight_number = ?")
    .bind(flightNumber)
    .first<FlightRow>();
  return row ? flightRow(row) : null;
}

// ---------------------------------------------------------------------------
// NET history

export async function netHistory(db: D1Database, flightNumber?: number | null): Promise<NetHistoryRow[]> {
  if (flightNumber == null) {
    const res = await db
      .prepare("SELECT * FROM net_history ORDER BY flight_number, observed_at")
      .all<NetHistoryRow>();
    return res.results ?? [];
  }
  const res = await db
    .prepare("SELECT * FROM net_history WHERE flight_number = ? ORDER BY observed_at")
    .bind(flightNumber)
    .all<NetHistoryRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// Articles

export interface ArticleInput {
  id: number;
  url: string;
  title?: string | null;
  summary?: string | null;
  news_site?: string | null;
  published_at?: string | null;
  image_url?: string | null;
}

export function upsertArticleStmt(db: D1Database, a: ArticleInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO articles(id, url, title, summary, news_site, published_at, image_url, fetched_at, extracted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(
      a.id,
      a.url,
      a.title ?? null,
      a.summary ?? null,
      a.news_site ?? null,
      a.published_at ?? null,
      a.image_url ?? null,
      utcnow()
    );
}

export async function listArticles(db: D1Database, limit = 50): Promise<Article[]> {
  const res = await db
    .prepare("SELECT * FROM articles ORDER BY published_at DESC LIMIT ?")
    .bind(limit)
    .all<Article>();
  return res.results ?? [];
}

export async function unextractedArticles(
  db: D1Database,
  limit = 20,
  opts: { includeHeuristic?: boolean } = {}
): Promise<Article[]> {
  const sql = opts.includeHeuristic
    ? `SELECT * FROM articles
       WHERE extracted = 0 OR extracted_via IS NULL OR extracted_via = '' OR extracted_via = 'heuristic'
       ORDER BY published_at DESC LIMIT ?`
    : "SELECT * FROM articles WHERE extracted = 0 ORDER BY published_at DESC LIMIT ?";
  const res = await db.prepare(sql).bind(limit).all<Article>();
  return res.results ?? [];
}

export function markExtractedStmt(db: D1Database, articleId: number, via = "llm"): D1PreparedStatement {
  return db.prepare("UPDATE articles SET extracted = 1, extracted_via = ? WHERE id = ?").bind(via, articleId);
}

export function clearArticleSignalsStmt(db: D1Database, articleId: number): D1PreparedStatement {
  return db.prepare("DELETE FROM signals WHERE article_id = ?").bind(articleId);
}

// ---------------------------------------------------------------------------
// Signals

export interface SignalInput {
  article_id?: number | null;
  article_url?: string | null;
  signal_type: string;
  flight_number?: number | null;
  payload?: Record<string, unknown>;
  confidence?: number | null;
  quote?: string | null;
}

export function insertSignalStmt(db: D1Database, s: SignalInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO signals(article_id, article_url, signal_type, flight_number, payload_json, confidence, quote, extracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      s.article_id ?? null,
      s.article_url ?? null,
      s.signal_type,
      s.flight_number ?? null,
      JSON.stringify(s.payload ?? {}),
      s.confidence ?? null,
      s.quote ?? null,
      utcnow()
    );
}

interface SignalRow {
  id: number;
  payload_json: string | null;
  [key: string]: unknown;
}

export async function listSignals(
  db: D1Database,
  opts: { since?: string | null; flightNumber?: number | null; limit?: number } = {}
): Promise<Signal[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    clauses.push("s.extracted_at >= ?");
    params.push(opts.since);
  }
  if (opts.flightNumber != null) {
    clauses.push("s.flight_number = ?");
    params.push(opts.flightNumber);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(opts.limit ?? 100);
  const res = await db
    .prepare(
      `SELECT s.*, a.published_at AS article_published_at
       FROM signals s
       LEFT JOIN articles a ON a.id = s.article_id
       ${where}
       ORDER BY s.extracted_at DESC LIMIT ?`
    )
    .bind(...params)
    .all<SignalRow>();
  return (res.results ?? []).map((r) => {
    const { payload_json, ...rest } = r;
    return { ...(rest as unknown as Signal), payload: safeParse(payload_json, {}) as Record<string, unknown> };
  });
}

// ---------------------------------------------------------------------------
// Seed loading (bundled flights_seed.json)

interface SeedFlight {
  flight_number: number;
  name?: string | null;
  launch_date?: string | null;
  net_date?: string | null;
  booster?: string | null;
  ship?: string | null;
  block?: number | null;
  pad?: string | null;
  outcome?: string | null;
  booster_outcome?: string | null;
  ship_outcome?: string | null;
  milestones?: unknown[];
  investigation?: Investigation | null;
  status_hint?: string | null;
  attempts?: number | null;
  scrubs?: number | null;
  scrub_details?: Record<string, unknown>[] | null;
  [key: string]: unknown;
}

export function seedFlights(): SeedFlight[] {
  return ((flightsSeed as { flights?: SeedFlight[] }).flights ?? []) as SeedFlight[];
}

/** Batch-load the bundled seed. Returns number of flights written. */
export async function loadSeed(db: D1Database, opts: { preferExistingDates?: boolean } = {}): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  const flights = seedFlights();
  for (const f of flights) {
    stmts.push(
      upsertFlightStmt(
        db,
        {
          flight_number: f.flight_number,
          name: f.name ?? null,
          launch_date: f.launch_date ?? null,
          net_date: f.net_date ?? f.launch_date ?? null,
          booster: f.booster ?? null,
          ship: f.ship ?? null,
          block: f.block ?? null,
          pad: f.pad ?? null,
          outcome: f.outcome ?? null,
          booster_outcome: f.booster_outcome ?? null,
          ship_outcome: f.ship_outcome ?? null,
          milestones: f.milestones ?? [],
          investigation: f.investigation ?? null,
          status_hint: f.status_hint ?? null,
        },
        opts
      )
    );
    const net = f.net_date ?? f.launch_date;
    if (net) stmts.push(recordNetStmt(db, f.flight_number, net, "seed"));
  }
  stmts.push(setMetaStmt(db, "seed_loaded_at", utcnow()));
  await db.batch(stmts);
  return flights.length;
}

/** Overlay attempts/scrubs/scrub_details from the bundled seed onto DB rows. */
export function mergeSeedAttemptFields(flights: Flight[]): Flight[] {
  const byFn = new Map<number, SeedFlight>();
  for (const f of seedFlights()) {
    if (f.flight_number != null) byFn.set(Number(f.flight_number), f);
  }
  return flights.map((f) => {
    const seed = byFn.get(Number(f.flight_number));
    if (!seed) return f;
    const row: Flight = { ...f };
    for (const key of ["attempts", "scrubs", "scrub_details"] as const) {
      if (key in seed && (row[key] == null || row[key] === undefined)) {
        (row as Record<string, unknown>)[key] = seed[key];
      }
    }
    return row;
  });
}
