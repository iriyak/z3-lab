#!/usr/bin/env bun
// satlib — solve every .cnf under a folder (e.g. SATLIB's uf20-91) and check the verdicts.
//   bun experiments/satlib.ts <folder> [--expect sat|unsat] [--backend exe|wasm] [--limit N] [--timeout SEC]
// The folder is searched recursively. The expected verdict is taken from --expect, otherwise from the file name:
// SATLIB's "uf..." files are all satisfiable, "uuf..." files all unsatisfiable. Files that tell nothing are only counted.
// Every sat answer is also checked against all clauses by solveDimacs (a wrong assignment becomes status "error").
// Prints progress every 100 files and a summary; exit code 0 when everything matched, 1 otherwise, 2 for bad usage.
// Tip: --backend wasm avoids starting z3 for each file (about 20 ms per small file instead of about 80 ms).
// env: Z3_EXE, Z3_BACKEND, as for z3lab.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { makeSolver, solveDimacs } from "../lib/index";

const die = (msg: string): never => { console.error(`satlib: ${msg}`); process.exit(2); };
const argv = process.argv.slice(2);
let dir: string | undefined, expectArg: string | undefined, backend: string | undefined, limit = Infinity, timeoutSec = 30;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--expect") expectArg = argv[++i];
  else if (a === "--backend") backend = argv[++i];
  else if (a === "--limit") limit = Number(argv[++i]);
  else if (a === "--timeout") timeoutSec = Number(argv[++i]);
  else if (a.startsWith("-")) die(`unknown option ${a}`);
  else dir = a;
}
if (!dir) die("usage: bun experiments/satlib.ts <folder> [--expect sat|unsat] [--backend exe|wasm] [--limit N] [--timeout SEC]");
if (expectArg !== undefined && expectArg !== "sat" && expectArg !== "unsat") die("--expect is sat or unsat");
if (!(limit > 0) || !(timeoutSec > 0)) die("--limit and --timeout need positive numbers");

const walk = (d: string): string[] =>
  readdirSync(d).sort().flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.cnf$/i.test(n) ? [p] : []; });
let files: string[];
try { files = walk(dir); } catch (e) { files = die(`cannot read ${dir}: ${(e as Error).message}`); }
if (!files.length) die(`no .cnf files under ${dir}`);
files = files.slice(0, limit);

const expected = (f: string): "sat" | "unsat" | undefined =>
  expectArg ? (expectArg as "sat" | "unsat") : /^uuf/i.test(path.basename(f)) ? "unsat" : /^uf/i.test(path.basename(f)) ? "sat" : undefined;

const solver = makeSolver(backend);
const times: number[] = [];
const count: Record<string, number> = {};
const bad: string[] = [];
const wall0 = Date.now();
let checked = 0;
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const r = await solveDimacs(solver, readFileSync(f, "utf8"), { timeoutSec });
  times.push(r.elapsedMs);
  count[r.status] = (count[r.status] ?? 0) + 1;
  const want = expected(f);
  if (want) checked++;
  if (r.status === "error" || r.status === "timeout" || r.status === "unknown" || (want && r.status !== want))
    bad.push(`${path.relative(dir, f)}: ${r.status}${want ? ` (expected ${want})` : ""}${r.errors?.length ? " - " + r.errors.join("; ") : ""}`);
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1} / ${files.length} done, ${bad.length} problem(s) so far`);
}
await solver.dispose?.();

const sorted = [...times].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(`\nbackend ${solver.name}: ${files.length} file(s) in ${((Date.now() - wall0) / 1000).toFixed(1)} s`);
console.log(`verdicts: ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`per file (solve only): median ${median} ms, max ${sorted[sorted.length - 1]} ms`);
console.log(`expected verdict known for ${checked} file(s); ${bad.length} problem(s)`);
for (const b of bad.slice(0, 20)) console.log(`  ${b}`);
if (bad.length > 20) console.log(`  ... and ${bad.length - 20} more`);
process.exit(bad.length ? 1 : 0);
