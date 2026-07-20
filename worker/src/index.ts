// Starship Flight Tracker — Cloudflare Worker entry point.
//
// fetch: /api/* JSON routes; everything else falls through to static assets
// (the React SPA build, configured with SPA not-found handling).
// scheduled: hourly cron tick — polls LL2/SNAPI/Anthropic and refreshes the
// cadence cache when due (idle: daily at POLL_IDLE_HOUR_LOCAL; near-launch:
// every tick).

import { handleApi } from "./api";
import { ensureSeeded, pollDue, runPollCycle } from "./poll";
import type { Env } from "./types";
import { getSettings } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    // Non-API paths normally never reach the Worker (assets serve them), but
    // keep a fallback for local dev edge cases.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const settings = getSettings(env);
    await ensureSeeded(env.DB);
    if (!(await pollDue(env.DB, settings))) {
      console.log("Cron tick: poll not due (idle)");
      return;
    }
    const result = await runPollCycle(env);
    console.log(
      "Poll cycle complete:",
      JSON.stringify({
        near_launch: result.near_launch,
        ll2: result.ll2,
        news: result.news,
        extract: {
          skipped: (result.extract as Record<string, unknown> | undefined)?.["skipped"],
          articles: (result.extract as Record<string, unknown> | undefined)?.["articles"],
          signals: (result.extract as Record<string, unknown> | undefined)?.["signals"],
        },
        cadence: result.cadence,
        next_poll_at: result["next_poll_at"],
      })
    );
  },
} satisfies ExportedHandler<Env>;
