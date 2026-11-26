// solver.ts — the thin interface the CLI and the MCP tool know about. Backends live behind it.
export type Status = "sat" | "unsat" | "unknown" | "error" | "timeout";
export type ModelValue = string | number | boolean;

export interface SolveOptions {
  timeoutSec?: number;   // wall clock (z3 -T: plus a kill a few seconds later). default 30
  memoryMb?: number;     // z3 -memory: (z3 executable backend only)
  stats?: boolean;       // include z3 statistics in the result (off by default: they are long)
  raw?: boolean;         // run the script as is (no check-sat / get-model appended); output returned in `output`
}

export interface SolveResult {
  backend: string;
  mode: "auto" | "raw";  // auto: check-sat + get-model/-unsat-core/-info/-statistics were appended
  status: Status;
  model?: Record<string, ModelValue>;                                   // constants: name -> value
  functions?: Record<string, { params: string; sort: string; body: string }>; // define-fun with parameters
  unsatCore?: string[];
  reasonUnknown?: string;
  stats?: Record<string, number | string>;
  errors?: string[];
  dimacs?: { variables: number; clauses: number; assignment?: number[] }; // DIMACS input: sizes, and on sat the assignment (v1 true -> 1, false -> -1)
  output?: string;       // everything z3 printed before the appended epilogue (raw mode: all of it)
  elapsedMs: number;
}

export interface Solver {
  readonly name: string;
  version(): Promise<string>;
  solve(smtlib: string, opts?: SolveOptions): Promise<SolveResult>;
  dispose?(): Promise<void>; // release resources (the WASM backend's worker threads); call before the process ends
}
