// Port of server/app/extractor.py: Anthropic structured-signal extraction with
// heuristic fallback. The Anthropic SDK is replaced with a plain fetch to the
// Messages API (network I/O does not count against Workers CPU time).

import {
  clearArticleSignalsStmt,
  getMeta,
  insertSignalStmt,
  markExtractedStmt,
  recordNetStmt,
  setMetaStmt,
  unextractedArticles,
  upsertFlightStmt,
} from "./db";
import type { Settings } from "./types";

export const LLM_EXTRACT_META_KEY = "llm_extract_at";

const SIGNAL_TYPES = new Set([
  "net_slip",
  "faa_action",
  "anomaly",
  "vehicle_readiness",
  "cadence_statement",
  "weather_hazard",
  "launch_scrub",
]);

const EXTRACT_PROMPT = `You extract structured signals about SpaceX Starship flight tests from news.

Return ONLY valid JSON with this schema:
{
  "signals": [
    {
      "signal_type": "net_slip" | "faa_action" | "anomaly" | "vehicle_readiness" | "cadence_statement" | "weather_hazard" | "launch_scrub",
      "flight_number": <int or null>,
      "confidence": <0.0-1.0>,
      "quote": "<short supporting quote from the text>",
      "payload": { ... type-specific fields ... }
    }
  ]
}

Payload fields by type:
- net_slip: {"new_net_date": "YYYY-MM-DD or ISO datetime", "previous_net_date": null|string, "reason": string}
- launch_scrub: launch attempt called off / recycled (same-day scrub). {"reason": string, "new_net_date": null|string, "previous_net_date": null|string}
- faa_action: {"action": "investigation_opened"|"investigation_closed"|"license_mod"|"grounding"|"clearance", "subject": string}
- anomaly: {"vehicle": "booster"|"ship"|"pad"|"unknown", "phase": string, "severity": "low"|"medium"|"high", "description": string}
- vehicle_readiness: {"event": "static_fire"|"cryo_test"|"stacking"|"rollout"|"engine_install", "serial": string|null, "vehicle": "booster"|"ship"|null}
- cadence_statement: {"target_flights": int|null, "horizon": string|null, "statement": string}
- weather_hazard: extreme Starbase/Texas Gulf weather only (hurricane, tropical storm, major flood). Ignore ordinary launch-day weather scrubs and storms far from South Texas — those are launch_scrub, not weather_hazard.
  {"severity": "extreme"|"high"|"medium"|"low", "event": "hurricane"|"tropical_storm"|"flood"|"other", "region": "starbase"|"gulf"|"texas"|"other", "status": "active"|"cleared", "clear_after": "YYYY-MM-DD"|null, "description": string}
  Use status "cleared" when the article says the threat has passed / dissipated / all-clear for Starbase. Prefer severity "extreme" for hurricanes and "high" for tropical storms threatening the area.

If nothing relevant, return {"signals": []}.
Only use information present in the article title/summary.
For net_slip dates without a year, infer the year from the article publish context (prefer the upcoming occurrence within ~12 months of publication). Never invent a year in the past relative to publication unless the article clearly says so.`;

export interface ExtractedSignal {
  signal_type: string;
  flight_number: number | null;
  confidence: number;
  quote: string | null;
  payload: Record<string, unknown>;
}

export type LlmCall = (system: string, user: string) => Promise<string>;

function anthropicCall(settings: Settings): LlmCall {
  return async (system: string, user: string): Promise<string> => {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: settings.anthropicModel,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as { content?: Array<{ text?: string }> };
    return (data.content ?? [])
      .map((b) => b.text)
      .filter(Boolean)
      .join("\n");
  };
}

export function parseSignals(raw: string): ExtractedSignal[] {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const data = JSON.parse(text) as unknown;
  const signals = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown>)?.["signals"] as unknown[]);
  if (!Array.isArray(signals)) return [];
  const out: ExtractedSignal[] = [];
  for (const s of signals) {
    if (typeof s !== "object" || s === null) continue;
    const rec = s as Record<string, unknown>;
    const st = rec["signal_type"];
    if (typeof st !== "string" || !SIGNAL_TYPES.has(st)) continue;
    out.push({
      signal_type: st,
      flight_number: rec["flight_number"] == null ? null : Number(rec["flight_number"]),
      confidence: Number(rec["confidence"] ?? 0.5),
      quote: (rec["quote"] as string) ?? null,
      payload: (rec["payload"] as Record<string, unknown>) ?? {},
    });
  }
  return out;
}

export function netDatePlausible(newNet: string, publishedAt?: string | null): boolean {
  // Reject implausible NETs relative to article publish (or now).
  // Upcoming NETs may sit up to ~18 months ahead. Dates more than ~3 weeks in
  // the past are rejected (catches wrong-year extractions).
  const netT = Date.parse(String(newNet).slice(0, 10));
  if (Number.isNaN(netT)) return false;
  let anchorT = Date.now();
  if (publishedAt) {
    const pub = Date.parse(publishedAt);
    if (!Number.isNaN(pub)) anchorT = pub;
  }
  const netDay = Math.floor(netT / 86_400_000);
  const anchorDay = Math.floor(anchorT / 86_400_000);
  const deltaDays = netDay - anchorDay;
  if (deltaDays < -21) return false;
  if (deltaDays > 548) return false;
  return true;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function heuristicExtract(
  title: string,
  summary: string,
  publishedAt?: string | null
): ExtractedSignal[] {
  // Lightweight fallback when no API key / LLM failure.
  const text = `${title}\n${summary}`.toLowerCase();
  const signals: ExtractedSignal[] = [];
  let fn: number | null = null;
  const m = /flight\s*(\d+)/.exec(text);
  if (m) fn = parseInt(m[1], 10);

  if (text.includes("faa") && (text.includes("investigation") || text.includes("mishap"))) {
    const closed = ["closed", "cleared", "accepted", "green light"].some((w) => text.includes(w));
    signals.push({
      signal_type: "faa_action",
      flight_number: fn,
      confidence: 0.55,
      quote: title.slice(0, 160),
      payload: { action: closed ? "investigation_closed" : "investigation_opened", subject: "Starship" },
    });
  }
  if (text.includes("static fire")) {
    signals.push({
      signal_type: "vehicle_readiness",
      flight_number: fn,
      confidence: 0.5,
      quote: title.slice(0, 160),
      payload: { event: "static_fire", serial: null, vehicle: null },
    });
  }
  const scrubHit = [
    "scrub",
    "scrubbed",
    "called off",
    "stand down",
    "recycle",
    "recycled",
    "launch attempt off",
    "won't launch today",
    "will not launch today",
    "not launching today",
  ].some((w) => text.includes(w));
  if (scrubHit && fn !== null) {
    signals.push({
      signal_type: "launch_scrub",
      flight_number: fn,
      confidence: 0.6,
      quote: title.slice(0, 160),
      payload: { reason: "mentioned in article", new_net_date: null, previous_net_date: null },
    });
  }
  if (["targeting", "targets", "no earlier than", "net "].some((w) => text.includes(w))) {
    const dateM =
      /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/.exec(
        text
      );
    const isoM = /(20\d{2})-(\d{2})-(\d{2})/.exec(text);
    let newNet: string | null = null;
    if (isoM) {
      newNet = `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
    } else if (dateM) {
      const month = MONTHS[dateM[1]];
      const day = parseInt(dateM[2], 10);
      let year = new Date().getUTCFullYear();
      let pubDay: Date | null = null;
      if (publishedAt) {
        const pub = new Date(publishedAt);
        if (!Number.isNaN(pub.getTime())) {
          year = pub.getUTCFullYear();
          pubDay = pub;
        }
      }
      let candidate = new Date(Date.UTC(year, month - 1, Math.min(day, 28)));
      const exact = new Date(Date.UTC(year, month - 1, day));
      if (exact.getUTCMonth() === month - 1) candidate = exact;
      const anchor = pubDay ?? new Date(Date.UTC(year, 0, 1));
      // Prefer upcoming occurrence relative to publish year
      if (candidate.getTime() < anchor.getTime() - 30 * 86_400_000) {
        const bumped = new Date(Date.UTC(year + 1, month - 1, day));
        candidate =
          bumped.getUTCMonth() === month - 1
            ? bumped
            : new Date(Date.UTC(year + 1, month - 1, Math.min(day, 28)));
      }
      newNet = candidate.toISOString().slice(0, 10);
    }
    if (newNet && fn && netDatePlausible(newNet, publishedAt)) {
      signals.push({
        signal_type: "net_slip",
        flight_number: fn,
        confidence: 0.45,
        quote: title.slice(0, 160),
        payload: { new_net_date: newNet, previous_net_date: null, reason: "mentioned in article" },
      });
    }
  }
  const hazardHit = ["hurricane", "tropical storm", "tropical cyclone", "major hurricane"].some((w) =>
    text.includes(w)
  );
  const localHit = [
    "starbase",
    "boca chica",
    "brownsville",
    "south texas",
    "texas gulf",
    "gulf coast",
    "cameron county",
    "rio grande valley",
  ].some((w) => text.includes(w));
  if (hazardHit && localHit) {
    const cleared = [
      "dissipated",
      "all clear",
      "all-clear",
      "threat passed",
      "no longer a threat",
      "has passed",
      "moved away",
    ].some((w) => text.includes(w));
    const event = text.includes("hurricane") ? "hurricane" : "tropical_storm";
    signals.push({
      signal_type: "weather_hazard",
      flight_number: fn,
      confidence: 0.7,
      quote: title.slice(0, 160),
      payload: {
        severity: event === "hurricane" ? "extreme" : "high",
        event,
        region: text.includes("starbase") || text.includes("boca chica") ? "starbase" : "texas",
        status: cleared ? "cleared" : "active",
        clear_after: null,
        description: title.slice(0, 200),
      },
    });
  }
  if (
    ["per month", "once a month", "one a month", "monthly cadence", "one launch per month"].some((w) =>
      text.includes(w)
    )
  ) {
    signals.push({
      signal_type: "cadence_statement",
      flight_number: fn,
      confidence: 0.7,
      quote: title.slice(0, 160),
      payload: {
        target_flights: null,
        target_gap_days: 30,
        horizon: "end of 2026",
        statement: title.slice(0, 200),
      },
    });
  }
  return signals;
}

export async function extractSignalsWithMethod(
  title: string,
  summary: string,
  settings: Settings,
  opts: { llmCall?: LlmCall; publishedAt?: string | null } = {}
): Promise<[ExtractedSignal[], "llm" | "heuristic"]> {
  let user = `TITLE: ${title}\n\nSUMMARY: ${summary || ""}`;
  if (opts.publishedAt) user = `PUBLISHED_AT: ${opts.publishedAt}\n\n${user}`;

  let llmCall = opts.llmCall;
  if (!llmCall) {
    if (!settings.hasAnthropic) {
      return [heuristicExtract(title, summary, opts.publishedAt), "heuristic"];
    }
    llmCall = anthropicCall(settings);
  }

  try {
    const raw = await llmCall(EXTRACT_PROMPT, user);
    return [parseSignals(raw), "llm"];
  } catch (err) {
    console.warn("LLM extraction failed, using heuristics:", err);
    return [heuristicExtract(title, summary, opts.publishedAt), "heuristic"];
  }
}

export interface ExtractResult {
  articles?: number;
  signals?: number;
  llm_articles?: number;
  heuristic_articles?: number;
  model?: string;
  extracted_at?: string | null;
  skipped: boolean;
  forced?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export async function processUnextracted(
  db: D1Database,
  settings: Settings,
  opts: { limit?: number; llmCall?: LlmCall } = {}
): Promise<ExtractResult> {
  const limit = opts.limit ?? 10;
  // With an API key, upgrade articles that were only keyword-scanned earlier.
  const articles = await unextractedArticles(db, limit, {
    includeHeuristic: settings.hasAnthropic || opts.llmCall != null,
  });
  let signalCount = 0;
  let llmArticles = 0;
  let heuristicArticles = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const article of articles) {
    const priorVia = (article.extracted_via ?? "").toLowerCase();
    const [signals, via] = await extractSignalsWithMethod(
      article.title ?? "",
      article.summary ?? "",
      settings,
      { llmCall: opts.llmCall, publishedAt: article.published_at }
    );
    if (priorVia === "heuristic" && via === "llm") {
      stmts.push(clearArticleSignalsStmt(db, article.id));
    }
    for (const sig of signals) {
      stmts.push(
        insertSignalStmt(db, {
          article_id: article.id,
          article_url: article.url,
          signal_type: sig.signal_type,
          flight_number: sig.flight_number,
          payload: sig.payload,
          confidence: sig.confidence,
          quote: sig.quote,
        })
      );
      // Apply NET moves from net_slip / launch_scrub when the date is plausible
      if (sig.signal_type === "net_slip" || sig.signal_type === "launch_scrub") {
        const payload = sig.payload ?? {};
        let newNet = payload["new_net_date"] as string | null | undefined;
        const fn = sig.flight_number;
        if (newNet && fn && netDatePlausible(newNet, article.published_at)) {
          if (String(newNet).length === 10) newNet = `${newNet}T12:00:00Z`;
          stmts.push(recordNetStmt(db, fn, newNet, "signal"));
          stmts.push(upsertFlightStmt(db, { flight_number: fn, net_date: newNet }));
        }
      }
      signalCount += 1;
    }
    stmts.push(markExtractedStmt(db, article.id, via));
    if (via === "llm") llmArticles += 1;
    else heuristicArticles += 1;
  }

  const now = utcnowIso();
  if (articles.length) {
    stmts.push(setMetaStmt(db, LLM_EXTRACT_META_KEY, now));
  }
  if (stmts.length) await db.batch(stmts);

  return {
    articles: articles.length,
    signals: signalCount,
    llm_articles: llmArticles,
    heuristic_articles: heuristicArticles,
    model: settings.hasAnthropic ? settings.anthropicModel : "heuristic",
    extracted_at: articles.length ? now : await getMeta(db, LLM_EXTRACT_META_KEY),
    skipped: false,
  };
}

function utcnowIso(): string {
  return new Date().toISOString();
}

export async function maybeProcessUnextracted(
  db: D1Database,
  settings: Settings,
  opts: { force?: boolean; intervalS?: number; llmCall?: LlmCall } = {}
): Promise<ExtractResult> {
  // Run LLM extract at most once per interval unless force=true.
  const interval = opts.intervalS ?? 86_400;
  const last = await getMeta(db, LLM_EXTRACT_META_KEY);
  let due = true;
  if (last) {
    const lastT = Date.parse(last);
    if (!Number.isNaN(lastT)) {
      due = (Date.now() - lastT) / 1000 >= interval;
    }
  }
  if (!opts.force && !due) {
    return {
      skipped: true,
      reason: "llm_extract_interval",
      interval_s: interval,
      last_extract_at: last,
      model: settings.anthropicModel,
    };
  }
  const result = await processUnextracted(db, settings, {
    limit: settings.llmExtractBatchLimit,
    llmCall: opts.llmCall,
  });
  result.skipped = false;
  result.forced = Boolean(opts.force);
  return result;
}
