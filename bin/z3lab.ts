#!/usr/bin/env bun
// z3lab — thin CLI over z3 (SMT-LIB 2). Runs on Windows, WSL2 and Linux (bun + z3).
//   z3lab version
//   z3lab solve [opts] [File.smt2|-]    # SMT-LIB text from the file, or stdin when "-" / omitted
//   z3lab put   Name.smt2               # save stdin to work/ (for the MCP tool)
// solve options:
//   --json            print the structured result as JSON (status, model, unsatCore, stats, reasonUnknown)
//   --timeout SEC     wall-clock limit (default 30)
//   --memory MB       z3 memory limit
//   --stats           include z3 statistics
//   --raw             run the script as is (no check-sat / get-model appended); z3's output in `output`
// env: Z3_EXE (path to z3), Z3_BACKEND (exe)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSolver } from "../lib/index";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (msg: string): never => { console.error(`z3lab: ${msg}`); process.exit(2); };
// PowerShell pipes (and Notepad-saved files) may start with a UTF-8 BOM; z3 would read it as 3 stray characters
const stripBom = (s: string) => s.replace(/^\uFEFF/, "");
const readStdin = async () => { let s = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) s += c; return stripBom(s); };

const [cmd = "help", ...rest] = process.argv.slice(2);
// exit codes: 0 sat/ok, 10 unsat, 11 unknown, 12 timeout, 1 error, 2 usage

switch (cmd) {
  case "version": {
    try { console.log(await makeSolver().version()); } catch (e) { die(String((e as Error).message ?? e)); }
    break;
  }
  case "put": {
    if (rest.length !== 1) die("usage: z3lab put Name.smt2  (content on stdin)");
    if (!/^[A-Za-z][A-Za-z0-9_-]*\.smt2$/.test(rest[0])) die(`bad file name: ${rest[0]}`);
    const data = await readStdin();
    mkdirSync(path.join(HERE, "work"), { recursive: true });
    const dest = path.join(HERE, "work", rest[0]);
    writeFileSync(dest, data);
    console.log(dest);
    break;
  }
  case "solve": {
    let json = false, raw = false, stats = false, timeoutSec: number | undefined, memoryMb: number | undefined, file = "-";
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--json") json = true;
      else if (a === "--raw") raw = true;
      else if (a === "--stats") stats = true;
      else if (a === "--timeout") timeoutSec = Number(rest[++i]);
      else if (a === "--memory") memoryMb = Number(rest[++i]);
      else if (a !== "-" && a.startsWith("-")) die(`unknown option ${a}`);
      else file = a;
    }
    if (timeoutSec !== undefined && !(timeoutSec > 0)) die("--timeout needs a positive number");
    if (memoryMb !== undefined && !(memoryMb > 0)) die("--memory needs a positive number");
    let text: string;
    if (file === "-") text = await readStdin();
    else { if (!existsSync(file)) die(`no such file: ${file}`); text = stripBom(readFileSync(file, "utf8")); }
    const r = await makeSolver().solve(text, { timeoutSec, memoryMb, raw, stats });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      if (r.mode !== "raw") console.log(r.status); // raw: the verdicts are in z3's own output below
      for (const [k, v] of Object.entries(r.model ?? {})) console.log(`  ${k} = ${v}`);
      for (const [k, f] of Object.entries(r.functions ?? {})) console.log(`  ${k}${f.params} : ${f.sort} = ${f.body}`);
      if (r.unsatCore) console.log(`  unsat core: ${r.unsatCore.join(" ")}`);
      if (r.reasonUnknown) console.log(`  reason unknown: ${r.reasonUnknown}`);
      if (r.mode === "raw" && r.output) console.log(r.output);
      for (const e of r.errors ?? []) console.error(`  error: ${e}`);
    }
    process.exitCode = ({ sat: 0, unsat: 10, unknown: 11, timeout: 12, error: 1 } as const)[r.status];
    break;
  }
  case "help": case "-h": case "--help": {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14);
    console.log(src.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    break;
  }
  default:
    die(`unknown command: ${cmd} (try: z3lab help)`);
}
