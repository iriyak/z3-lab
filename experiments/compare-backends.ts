#!/usr/bin/env bun
// compare-backends — run the same problems on both backends (z3 executable vs npm z3-solver / WASM) and compare.
//   bun experiments/compare-backends.ts [--repeat N] [--timeout SEC]
// Problems: every examples/**/*.smt2, plus N-queens generated for a few sizes.
// Times are the median of N runs (default 3) of solve(). For exe that includes starting the process (every call);
// for wasm it excludes the one-time load of the WASM (reported separately), since the module stays loaded.
// "same" compares the verdicts only: models may legitimately differ between the two builds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSolver } from "../lib/index";
import type { SolveResult } from "../lib/index";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, dflt: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const repeat = arg("--repeat", 3), timeoutSec = arg("--timeout", 30);

function smtFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? smtFiles(p) : n.endsWith(".smt2") ? [p] : [];
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

const problems: { name: string; text: string }[] = [
  ...smtFiles(path.join(HERE, "examples")).map((p) => ({ name: path.relative(HERE, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") })),
  ...[8, 12, 16, 24].map((n) => ({ name: `(generated) ${n}-queens`, text: queens(n) })),
];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const exe = makeSolver("exe"), wasm = makeSolver("wasm");

// load the WASM once, and say how long that took
const t0 = performance.now();
const warm = await wasm.solve("(declare-const x Int)(assert (> x 0))", { timeoutSec });
const loadMs = Math.round(performance.now() - t0);
if (warm.status !== "sat") { console.error(`wasm backend not usable: ${warm.status} ${warm.errors?.join("; ") ?? ""}`); await wasm.dispose?.(); process.exit(1); }
console.log(`exe : ${await exe.version()}\nwasm: ${await wasm.version()}   (one-time load ${loadMs} ms)\nmedian of ${repeat} runs, timeout ${timeoutSec}s\n`);

async function measure(s: typeof exe, text: string) {
  const ms: number[] = []; let last!: SolveResult;
  for (let i = 0; i < repeat; i++) { last = await s.solve(text, { timeoutSec }); ms.push(last.elapsedMs); }
  return { status: last.status, ms: median(ms) };
}

const rows: string[][] = [["problem", "exe", "ms", "wasm", "ms", "same"]];
let differ = 0;
for (const p of problems) {
  const a = await measure(exe, p.text), b = await measure(wasm, p.text);
  const same = a.status === b.status;
  if (!same) differ++;
  rows.push([p.name, a.status, String(a.ms), b.status, String(b.ms), same ? "yes" : "NO"]);
}
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
for (const [i, r] of rows.entries()) {
  console.log(r.map((x, c) => (c === 0 || c === 1 || c === 3 || c === 5 ? x.padEnd(w[c]) : x.padStart(w[c]))).join("  "));
  if (i === 0) console.log(w.map((n) => "-".repeat(n)).join("  "));
}
console.log(differ ? `\n${differ} problem(s) with different verdicts` : "\nall verdicts agree");
await wasm.dispose?.();
process.exitCode = differ ? 1 : 0;
