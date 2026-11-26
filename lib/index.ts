// Backend selection: "exe" (z3 executable, the default) or "wasm" (npm z3-solver). Env: Z3_BACKEND.
import { Z3ExeSolver } from "./z3-exe";
import { Z3WasmSolver } from "./z3-wasm";
import type { Solver } from "./solver";
export type { Solver, SolveOptions, SolveResult, Status } from "./solver";
export type { Session, SessionOptions, SessionRunResult, Verdict } from "./session";
export { parseDimacs, dimacsToSmt, solveDimacs, DimacsError } from "./dimacs";

export const BACKENDS = ["exe", "wasm"] as const;

export function makeSolver(backend = process.env.Z3_BACKEND ?? "exe"): Solver {
  if (backend === "exe") return new Z3ExeSolver();
  if (backend === "wasm") return new Z3WasmSolver();
  throw new Error(`unknown backend: ${backend} (available: ${BACKENDS.join(", ")})`);
}
