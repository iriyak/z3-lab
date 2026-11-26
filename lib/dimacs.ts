// dimacs.ts — read a DIMACS CNF file and solve it with any backend (pure SAT as Bool constants v1..vn).
//   c a comment
//   p cnf 3 2        <- variables, clauses
//   1 -3 0           <- a clause: literals, "-" is negation, 0 ends it (a clause may span lines)
// The SATLIB files end with a "%" line (then a stray 0); everything from "%" on is ignored.
import type { SolveOptions, SolveResult, Solver } from "./solver";

export interface DimacsProblem { variables: number; clauses: number[][] }

export class DimacsError extends Error {}

export function parseDimacs(text: string): DimacsProblem {
  let variables = -1, declared = -1;
  const clauses: number[][] = [];
  let current: number[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (line === "" || line[0] === "c") continue;
    if (line[0] === "%") break;
    if (line[0] === "p") {
      const m = line.match(/^p\s+cnf\s+(\d+)\s+(\d+)\s*$/);
      if (!m) throw new DimacsError(`line ${n + 1}: bad header (expected "p cnf <variables> <clauses>")`);
      if (variables >= 0) throw new DimacsError(`line ${n + 1}: second "p" line`);
      variables = Number(m[1]); declared = Number(m[2]);
      continue;
    }
    if (variables < 0) throw new DimacsError(`line ${n + 1}: clause before the "p cnf" header`);
    for (const tok of line.split(/\s+/)) {
      if (!/^-?\d+$/.test(tok)) throw new DimacsError(`line ${n + 1}: unexpected token "${tok}"`);
      const lit = Number(tok);
      if (lit === 0) { clauses.push(current); current = []; continue; }
      if (Math.abs(lit) > variables) throw new DimacsError(`line ${n + 1}: literal ${lit} is outside 1..${variables}`);
      current.push(lit);
    }
  }
  if (variables < 0) throw new DimacsError('no "p cnf" header');
  if (current.length) throw new DimacsError("the last clause is not terminated by 0");
  if (clauses.length !== declared) throw new DimacsError(`header says ${declared} clauses, found ${clauses.length}`);
  return { variables, clauses };
}

export function dimacsToSmt(p: DimacsProblem): string {
  const lit = (l: number) => (l > 0 ? `v${l}` : `(not v${-l})`);
  const out: string[] = [];
  for (let i = 1; i <= p.variables; i++) out.push(`(declare-const v${i} Bool)`);
  for (const c of p.clauses) {
    out.push(c.length === 0 ? "(assert false)" : c.length === 1 ? `(assert ${lit(c[0])})` : `(assert (or ${c.map(lit).join(" ")}))`);
  }
  return out.join("\n") + "\n";
}

// Solve DIMACS text. On sat the result has `dimacs.assignment` (one signed integer per variable, as in a SAT solver's
// "v" line) and no `model`; there is never an `unsatCore`. The assignment is checked against every clause before it is reported.
export async function solveDimacs(solver: Solver, text: string, opts: SolveOptions = {}): Promise<SolveResult> {
  let p: DimacsProblem;
  try { p = parseDimacs(text); }
  catch (e) { return { backend: solver.name, mode: "auto", status: "error", errors: [(e as Error).message], elapsedMs: 0 }; }

  const r = await solver.solve(dimacsToSmt(p), { ...opts, raw: false, stats: opts.stats });
  r.dimacs = { variables: p.variables, clauses: p.clauses.length };
  delete r.unsatCore; // clauses have no names, so an unsat core is meaningless here (an empty one would read as "unsat on its own")
  if (r.status !== "sat" || !r.model) return r;

  // a variable the model does not mention is unconstrained: report it as false
  const assignment = Array.from({ length: p.variables }, (_, i) => (r.model![`v${i + 1}`] === true ? i + 1 : -(i + 1)));
  const value = new Set(assignment);
  const bad = p.clauses.findIndex((c) => !c.some((l) => value.has(l)));
  delete r.model;
  if (bad >= 0) { r.status = "error"; r.errors = [`internal check failed: clause ${bad + 1} is not satisfied by the reported assignment`]; return r; }
  r.dimacs.assignment = assignment;
  return r;
}
