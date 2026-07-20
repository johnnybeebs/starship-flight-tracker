/** Write a bootstrap cadence payload for KV seeding. Run: npx vitest run scripts/bootstrap_cadence.mts */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";
import { ordFromIso, projectCadence } from "../src/cadence/model";
import flightsSeed from "../seeds/flights_seed.json";

it("bootstrap cadence json", () => {
  const flights = (flightsSeed as { flights: Record<string, unknown>[] }).flights.map((f) => ({
    ...f,
    flight_number: Number(f["flight_number"]),
    net_date: (f["net_date"] as string) ?? (f["launch_date"] as string) ?? null,
    milestones: (f["milestones"] as unknown[]) ?? [],
    investigation: f["investigation"] ?? null,
    ll2_id: null,
    ll2_status: null,
    ll2_raw: null,
    status_hint: (f["status_hint"] as string) ?? null,
    updated_at: "bootstrap",
  }));
  const payload = projectCadence(flights as never[], [], [], {
    today: ordFromIso("2026-07-20")!,
    horizon: ordFromIso("2026-12-31")!,
    nSims: 150,
    seed: 42,
  });
  payload["computed_at"] = new Date().toISOString();
  payload["input_fingerprint"] = "bootstrap";
  const out = resolve(import.meta.dirname, "../../scripts/cadence_bootstrap.json");
  writeFileSync(out, JSON.stringify(payload));
  console.log("wrote", out, "bytes", JSON.stringify(payload).length);
});
