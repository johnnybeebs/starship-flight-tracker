import { it } from "vitest";
import { ordFromIso, projectCadence } from "../src/cadence/model";
import * as M from "../src/cadence/model";
import flightsSeed from "../seeds/flights_seed.json";
const flights = (flightsSeed as any).flights.map((f: any) => ({
  ...f, net_date: f.net_date ?? f.launch_date ?? null, milestones: f.milestones ?? [],
  investigation: f.investigation ?? null, ll2_id: null, ll2_status: null, ll2_raw: null,
  status_hint: f.status_hint ?? null, updated_at: "x",
}));
const today = ordFromIso("2026-07-19")!;
it("profile estimators", () => {
  const pipeline = M.loadPipeline();
  const time = (label: string, fn: () => void, reps = 20) => {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    console.log(`${label}: ${((performance.now() - t0) / reps).toFixed(3)} ms`);
  };
  time("resolveGoal", () => M.resolveGoal(pipeline, [], today));
  time("estimateShipProductionRate", () => M.estimateShipProductionRate(flights, pipeline, [], today, 3, 1));
  time("buildPipelineIndex", () => M.buildPipelineIndex(pipeline, [], flights, { today }));
  time("estimateScrubParams", () => M.estimateScrubParams([], [], flights));
  time("estimateMishapParams", () => M.estimateMishapParams(flights, 3));
  time("estimateGoalAttainment", () => M.estimateGoalAttainment(flights, 30));
  time("full n=1", () => projectCadence(flights, [], [], { today, horizon: ordFromIso("2026-12-31")!, nSims: 1, seed: 42 }));
  time("full n=150", () => projectCadence(flights, [], [], { today, horizon: ordFromIso("2026-12-31")!, nSims: 150, seed: 42 }), 5);
});
