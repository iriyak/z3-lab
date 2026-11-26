#!/usr/bin/env bun
// sudoku — solve a Sudoku with Z3 and print the grid; also says whether the solution is unique.
//   bun examples/sudoku/sudoku.ts [puzzle.txt | -]      (PowerShell: examples\sudoku\sudoku.ps1)
// No argument: the built-in example (the Wikipedia puzzle). "-": read the puzzle from stdin.
// Puzzle format: 81 cells, row by row. Digits 1-9 are givens; "." "0" "_" "*" are blanks.
// Whitespace, "|" and lines made only of "-", "+", "=" are ignored, so a pretty-printed grid works too.
// Exit codes: 0 solved, 10 no solution, 2 bad input.  env: Z3_EXE (path to z3), as for z3lab.
import { readFileSync } from "node:fs";
import { makeSolver } from "../../lib/index"; // examples/sudoku/ -> lab root -> lib/

const EXAMPLE = `53..7....
6..195...
.98....6.
8...6...3
4..8.3..1
7...2...6
.6....28.
...419..5
....8..79`;

const die = (msg: string): never => { console.error(`sudoku: ${msg}`); process.exit(2); };

function parse(text: string): string {
  const cells = text.replace(/^﻿/, "").split(/\r?\n/)
    .filter((l) => !/^[\s\-+=|]*$/.test(l) || /[\d.]/.test(l)) // drop separator lines
    .join("").replace(/[\s|]/g, "");
  if (cells.length !== 81) die(`need 81 cells, got ${cells.length}`);
  const bad = cells.match(/[^0-9._*]/);
  if (bad) die(`unexpected character: ${bad[0]}`);
  return cells.replace(/[0._*]/g, ".");
}

const name = (r: number, c: number) => `c${r}${c}`; // r, c are 1-based

function smt(cells: string): string {
  const L: string[] = [];
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++) L.push(`(declare-const ${name(r, c)} Int)`);
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++) L.push(`(assert (and (<= 1 ${name(r, c)}) (<= ${name(r, c)} 9)))`);
  const distinct = (ns: string[]) => L.push(`(assert (distinct ${ns.join(" ")}))`);
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (const r of nine) distinct(nine.map((c) => name(r, c)));
  for (const c of nine) distinct(nine.map((r) => name(r, c)));
  for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++)
    distinct(nine.map((i) => name(br * 3 + Math.floor((i - 1) / 3) + 1, bc * 3 + ((i - 1) % 3) + 1)));
  cells.split("").forEach((ch, i) => { if (ch !== ".") L.push(`(assert (= ${name(Math.floor(i / 9) + 1, (i % 9) + 1)} ${ch}))`); });
  return L.join("\n") + "\n";
}

const grid = (m: Record<string, string | number | boolean>) =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => String(m[name(r, c)])).join("").replace(/(...)(?=.)/g, "$1 ")).join("\n");

const arg = process.argv[2];
let text = EXAMPLE;
if (arg === "-") { text = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) text += c; }
else if (arg) { try { text = readFileSync(arg, "utf8"); } catch (e) { die(`cannot read ${arg}: ${(e as Error).message}`); } }

const cells = parse(text);
const base = smt(cells);
const solver = makeSolver();

const first = await solver.solve(base);
if (first.status === "unsat") { console.log("no solution"); process.exit(10); }
if (first.status !== "sat" || !first.model) { console.error(`sudoku: z3 says ${first.status}${first.errors ? ": " + first.errors.join("; ") : ""}`); process.exit(1); }
console.log(grid(first.model));

// exclude the solution just found; if z3 can still solve it, the puzzle has more than one solution
const exclude = `(assert (not (and ${[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((r) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => `(= ${name(r, c)} ${first.model![name(r, c)]})`)).join(" ")})))\n`;
const second = await solver.solve(base + exclude);
if (second.status === "unsat") console.log("\nunique solution");
else if (second.status === "sat" && second.model) console.log("\nnot unique; another solution:\n" + grid(second.model));
else console.log(`\nuniqueness check: ${second.status}`);
