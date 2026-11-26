#!/usr/bin/env bun
// compare-backends — run the same problems on both backends (z3 executable vs npm z3-solver / WASM) and compare.
//   bun experiments/compare-backends.ts [--repeat N] [--timeout SEC]
// Problems: every examples/**/*.smt2 and *.cnf (DIMACS), plus N-queens and random 3-SAT generated for a few sizes.
// Times are the median of N runs (default 3) of solve(). For exe that includes starting the process (every call);
// for wasm it excludes the one-time load of the WASM (reported separately), since the module stays loaded.
// "same" compares the verdicts only: models may legitimately differ between the two builds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSolver, solveDimacs } from "../lib/index";
import type { SolveResult } from "../lib/index";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, dflt: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const repeat = arg("--repeat", 3), timeoutSec = arg("--timeout", 30);

function smtFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? smtFiles(p) : n.endsWith(".smt2") || n.endsWith(".cnf") ? [p] : [];
  });
}

// N-queens, one Int per column (row of its queen); the three distinct constraints say rows and both diagonals differ.
function queens(n: number): string {
  const q = (i: number) => `q${i}`, idx = Array.from({ length: n }, (_, i) => i + 1);
  return [
    ...idx.map((i) => `(declare-const ${q(i)} Int)`),
    ...idx.map((i) => `(assert (and (<= 1 ${q(i)}) (<= ${q(i)} ${n})))`),
    `(assert (distinct ${idx.map(q).join(" ")}))`,
    `(assert (distinct ${idx.map((i) => `(+ ${q(i)} ${i})`).join(" ")}))`,
    `(assert (distinct ${idx.map((i) => `(- ${q(i)} ${i})`).join(" ")}))`,
  ].join("\n");
}

// Random 3-SAT near the hard ratio 4.26 (about half of these are satisfiable), as DIMACS text. Fixed seeds, so every run sees the same problems.
function random3sat(n: number, seed: number): string {
  let x = seed >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32); // small LCG
  const m = Math.round(n * 4.26), out = [`p cnf ${n} ${m}`];
  for (let i = 0; i < m; i++) {
    const vs = new Set<number>();
    while (vs.size < 3) vs.add(1 + Math.floor(rnd() * n));
    out.push([...vs].map((v) => (rnd() < 0.5 ? v : -v)).join(" ") + " 0");
  }
  return out.join("\n") + "\n";
}

type Problem = { name: string; text: string; dimacs?: boolean };
const problems: Problem[] = [
  ...smtFiles(path.join(HERE, "examples")).map((p) => ({ name: path.relative(HERE, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8"), dimacs: p.endsWith(".cnf") })),
  ...[8, 12, 16, 24].map((n) => ({ name: `(generated) ${n}-queens`, text: queens(n) })),
  ...[50, 100, 150].map((n) => ({ name: `(generated) random 3-SAT n=${n}`, text: random3sat(n, n), dimacs: true })),
];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const exe = makeSolver("exe"), wasm = makeSolver("wasm");

// load the WASM once, and say how long that took
const t0 = performance.now();
const warm = await wasm.solve("(declare-const x Int)(assert (> x 0))", { timeoutSec });
const loadMs = Math.round(performance.now() - t0);
if (warm.status !== "sat") { console.error(`wasm backend not usable: ${warm.status} ${warm.errors?.join("; ") ?? ""}`); await wasm.dispose?.(); process.exit(1); }
console.log(`exe : ${await exe.version()}\nwasm: ${await wasm.version()}   (one-time load ${loadMs} ms)\nmedian of ${repeat} runs, timeout ${timeoutSec}s\n`);

async function measure(s: typeof exe, p: Problem) {
  const ms: number[] = []; let last!: SolveResult;
  for (let i = 0; i < repeat; i++) { last = p.dimacs ? await solveDimacs(s, p.text, { timeoutSec }) : await s.solve(p.text, { timeoutSec }); ms.push(last.elapsedMs); }
  return { status: last.status, ms: median(ms), errors: last.errors };
}

const rows: string[][] = [["problem", "exe", "ms", "wasm", "ms", "same"]];
let differ = 0;
const notes: string[] = []; // error messages, shown under the table
for (const p of problems) {
  const a = await measure(exe, p), b = await measure(wasm, p);
  const same = a.status === b.status;
  if (!same) differ++;
  for (const [who, x] of [["exe", a], ["wasm", b]] as const) if (x.errors?.length) notes.push(`${p.name} (${who}): ${x.errors.join("; ")}`);
  rows.push([p.name, a.status, String(a.ms), b.status, String(b.ms), same ? "yes" : "NO"]);
}
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
for (const [i, r] of rows.entries()) {
  console.log(r.map((x, c) => (c === 0 || c === 1 || c === 3 || c === 5 ? x.padEnd(w[c]) : x.padStart(w[c]))).join("  "));
  if (i === 0) console.log(w.map((n) => "-".repeat(n)).join("  "));
}
for (const n of notes) console.log(`note: ${n}`);
console.log(differ ? `\n${differ} problem(s) with different verdicts` : "\nall verdicts agree");
await wasm.dispose?.();
process.exitCode = differ ? 1 : 0;
