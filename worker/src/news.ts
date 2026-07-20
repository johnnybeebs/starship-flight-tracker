// Port of server/app/news_client.py (Spaceflight News API).
// The on-disk cache is replaced by a news_synced_at meta gate; SNAPI's own
// Cache-Control max-age=600 stays the floor. 429s retry with Retry-After.

import { getMeta, setMetaStmt, upsertArticleStmt, utcnow } from "./db";
import type { Settings } from "./types";

const SNAPI_URL = "https://api.spaceflightnewsapi.net/v4/articles/";
const SNAPI_MIN_CACHE_S = 600;
const USER_AGENT = "starship-flight-tracker/1.0 (workers)";
const MAX_429_RETRIES = 2;

function retryAfterSeconds(resp: Response, attempt: number): number {
  const raw = resp.headers.get("Retry-After");
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(1, n);
  }
  return Math.min(30, 2 ** (attempt + 1));
}

async function getWithRetries(params: URLSearchParams): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const resp = await fetch(`${SNAPI_URL}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    last = resp;
    if (resp.status !== 429) return resp;
    if (attempt >= MAX_429_RETRIES) break;
    const delay = retryAfterSeconds(resp, attempt);
    await new Promise((r) => setTimeout(r, delay * 1000));
  }
  return last as Response;
}

interface SnapiArticle {
  id: number;
  url: string;
  title?: string | null;
  summary?: string | null;
  news_site?: string | null;
  published_at?: string | null;
  image_url?: string | null;
}

export interface NewsSyncResult {
  fetched?: number;
  inserted?: number;
  ok?: boolean;
  skipped?: boolean;
  error?: string;
  [key: string]: unknown;
}

export async function syncNewsToDb(
  db: D1Database,
  settings: Settings,
  opts: { limit?: number; force?: boolean; maxAgeS?: number } = {}
): Promise<NewsSyncResult> {
  const limit = opts.limit ?? 40;
  const cacheMaxAge =
    opts.maxAgeS == null ? SNAPI_MIN_CACHE_S : Math.max(SNAPI_MIN_CACHE_S, Math.trunc(opts.maxAgeS));

  const syncedAt = await getMeta(db, "news_synced_at");
  if (!opts.force && syncedAt) {
    const age = (Date.now() - Date.parse(syncedAt)) / 1000;
    if (Number.isFinite(age) && age < cacheMaxAge) {
      return { skipped: true, reason: "fresh", age_s: Math.round(age), ok: true };
    }
  }

  let articles: SnapiArticle[] = [];
  try {
    const resp = await getWithRetries(
      new URLSearchParams({ search: "starship", limit: String(limit), ordering: "-published_at" })
    );
    if (!resp.ok) throw new Error(`SNAPI HTTP ${resp.status}`);
    const payload = (await resp.json()) as { results?: SnapiArticle[] };
    articles = payload.results ?? [];
  } catch (err) {
    return {
      fetched: 0,
      inserted: 0,
      ok: false,
      error: `SNAPI fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const stmts: D1PreparedStatement[] = [];
  for (const a of articles) {
    if (!a.id || !a.url) continue;
    stmts.push(upsertArticleStmt(db, a));
  }

  // Only advance the sync stamp when we have articles — an empty failure must
  // not look "healthy" in /api/health.
  if (articles.length) {
    stmts.push(setMetaStmt(db, "news_synced_at", utcnow()));
    const before = await db.prepare("SELECT COUNT(*) AS n FROM articles").first<{ n: number }>();
    await db.batch(stmts);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM articles").first<{ n: number }>();
    const inserted = Math.max(0, (after?.n ?? 0) - (before?.n ?? 0));
    return { fetched: articles.length, inserted, ok: true };
  }

  return {
    fetched: 0,
    inserted: 0,
    ok: false,
    error: "SNAPI returned no articles (rate-limited or unreachable)",
  };
}
