// Backend selection. z3-solver (WASM) will be added here as a second backend.
import { Z3ExeSolver } from "./z3-exe";
import type { Solver } from "./solver";
export type { Solver, SolveOptions, SolveResult, Status } from "./solver";

export function makeSolver(backend = process.env.Z3_BACKEND ?? "exe"): Solver {
  if (backend === "exe") return new Z3ExeSolver();
  throw new Error(`unknown backend: ${backend} (available: exe)`);
}
