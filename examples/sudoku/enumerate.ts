#!/usr/bin/env bun
// enumerate — count (and optionally print) every solution of a Sudoku, using one resident solver session.
//   bun examples/sudoku/enumerate.ts [puzzle.txt | -] [--max N] [--print] [--fresh]
// Loop: (check-sat), read the 81 cells, assert "not this solution", repeat until unsat. The session keeps the
// puzzle and every blocking clause, so each round only sends the new clause. --fresh does the same without a
// session (the whole script is sent and solved again each round) to show what the session saves.
// Puzzle format as in sudoku.ts. No argument: examples/sudoku/puzzle-few.txt (a puzzle with several solutions).
// --max N stops after N solutions (default 1000). Exit codes: 0 finished or stopped at --max, 2 bad input, 1 solver trouble.
// env: Z3_EXE, Z3_BACKEND (exe | wasm), as for z3lab.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSolver } from "../../lib/index";
import { parseSexps } from "../../lib/sexp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const die = (msg: string): never => { console.error(`enumerate: ${msg}`); process.exit(2); };
const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const name = (r: number, c: number) => `c${r}${c}`;
const ALL = nine.flatMap((r) => nine.map((c) => name(r, c)));

function parse(text: string): string {
  const cells = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => !/^[\s\-+=|]*$/.test(l) || /[\d.]/.test(l)).join("").replace(/[\s|]/g, "");
  if (cells.length !== 81) die(`need 81 cells, got ${cells.length}`);
  const bad = cells.match(/[^0-9._*]/);
  if (bad) die(`unexpected character: ${bad[0]}`);
  return cells.replace(/[0._*]/g, ".");
}

function problem(cells: string): string {
  const L = ALL.map((n) => `(declare-const ${n} Int)`);
  for (const n of ALL) L.push(`(assert (and (<= 1 ${n}) (<= ${n} 9)))`);
  const distinct = (ns: string[]) => L.push(`(assert (distinct ${ns.join(" ")}))`);
  for (const r of nine) distinct(nine.map((c) => name(r, c)));
  for (const c of nine) distinct(nine.map((r) => name(r, c)));
  for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++)
    distinct(nine.map((i) => name(br * 3 + Math.floor((i - 1) / 3) + 1, bc * 3 + ((i - 1) % 3) + 1)));
  cells.split("").forEach((ch, i) => { if (ch !== ".") L.push(`(assert (= ${name(Math.floor(i / 9) + 1, (i % 9) + 1)} ${ch}))`); });
  return L.join("\n") + "\n";
}

const grid = (v: string[]) => nine.map((r) => v.slice((r - 1) * 9, r * 9).join("").replace(/(...)(?=.)/g, "$1 ")).join("\n");

let file: string | undefined, max = 1000, print = false, fresh = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--max") max = Number(argv[++i]);
  else if (a === "--print") print = true;
  else if (a === "--fresh") fresh = true;
  else if (a !== "-" && a.startsWith("-")) die(`unknown option ${a}`);
  else file = a;
}
if (!(max > 0)) die("--max needs a positive number");
let text = "";
if (file === "-") { process.stdin.setEncoding("utf8"); for await (const c of process.stdin) text += c; }
else { const f = file ?? path.join(HERE, "puzzle-few.txt"); try { text = readFileSync(f, "utf8"); } catch (e) { die(`cannot read ${f}: ${(e as Error).message}`); } }

const base = problem(parse(text));
const solver = makeSolver();
const ask = `(check-sat)\n(get-value (${ALL.join(" ")}))\n`;
const session = fresh ? undefined : await solver.openSession!({ timeoutSec: 60 });
let blocks = "";
let count = 0, last = "";
const t0 = Date.now();

async function finish(code: number): Promise<never> { await session?.close(); await solver.dispose?.(); return process.exit(code); }

try {
  if (session) { const r = await session.run(base); if (r.errors.length) { console.error(r.errors.join("\n")); await finish(1); } }
  while (count < max) {
    let out: string, verdict: string | undefined, errors: string[];
    if (session) { const r = await session.run(ask); out = r.output; verdict = r.verdicts[0]; errors = r.errors; }
    else { const r = await solver.solve(base + blocks + ask, { raw: true }); out = r.output ?? ""; verdict = out.split("\n").find((l) => /^(sat|unsat|unknown)$/.test(l.trim()))?.trim(); errors = r.errors ?? []; }
    if (verdict === "unsat") break; // the get-value after an unsat check-sat reports "model is not available": expected
    if (errors.length) { console.error(errors.join("\n")); await finish(1); }
    if (verdict !== "sat") { console.error(`z3 says ${verdict ?? "nothing"} after ${count} solutions`); await finish(1); }
    const pairs = parseSexps(out.slice(out.indexOf("(")))[0] as string[][];
    const val = new Map(pairs.map(([k, v]) => [k, v]));
    const v = ALL.map((n) => val.get(n)!);
    count++;
    last = v.join("");
    if (print) console.log(`#${count}\n${grid(v)}\n`);
    const block = `(assert (not (and ${ALL.map((n, i) => `(= ${n} ${v[i]})`).join(" ")})))\n`;
    if (session) { const r = await session.run(block); if (r.errors.length) { console.error(r.errors.join("\n")); await finish(1); } }
    else blocks += block;
  }
  const ms = Date.now() - t0;
  const done = count < max;
  console.log(`${done ? "all" : "stopped at"} ${count} solution${count === 1 ? "" : "s"}${done ? "" : " (--max)"} in ${ms} ms (${fresh ? "fresh solve each round" : "one session"}, ${solver.name})`);
  await finish(0);
} catch (e) { console.error(`enumerate: ${(e as Error).message ?? e}`); await finish(1); }
