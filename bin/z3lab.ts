#!/usr/bin/env bun
// z3lab — thin CLI over z3 (SMT-LIB 2). Runs on Windows, WSL2 and Linux (bun + z3).
//   z3lab version
//   z3lab solve [opts] [File.smt2|-]    # SMT-LIB text from the file, or stdin when "-" / omitted
//   z3lab session [--backend NAME] [--timeout SEC] [--memory MB]   # resident session over JSON lines (see below)
//   z3lab put   Name.smt2               # save stdin to work/ (for the MCP tool)
// solve options:
//   --json            print the structured result as JSON (status, model, unsatCore, stats, reasonUnknown)
//   --timeout SEC     wall-clock limit (default 30)
//   --memory MB       z3 memory limit
//   --stats           include z3 statistics
//   --backend NAME    exe (z3 executable, default) or wasm (npm z3-solver)
//   --dimacs          the input is DIMACS CNF (automatic for *.cnf files); prints "s SATISFIABLE" and "v ... 0" lines
//   --raw             run the script as is (no check-sat / get-model appended); z3's output in `output`
// session: one resident solver whose state (declarations, assertions, push/pop) lasts until it is closed.
//   Reads one JSON object per stdin line, answers with one JSON line on stdout:
//     first line out:  {"ready":true,"backend":"z3-exe","version":"..."}
//     {"script":"(declare-const x Int)(assert (> x 3))(check-sat)"}  ->  {"output":"sat\n","verdicts":["sat"],"errors":[],"elapsedMs":3}
//     {"script":"...","timeoutSec":10}   limit for this run only (default: --timeout)
//     {"close":true}  ->  {"closed":true}, then exit. End of stdin closes it too.
//   "closed":true in a reply means the session is gone (timeout kill, z3 exited); start a new one.
// env: Z3_EXE (path to z3), Z3_BACKEND (exe | wasm)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSolver, solveDimacs } from "../lib/index";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (msg: string): never => { console.error(`z3lab: ${msg}`); process.exit(2); };
// PowerShell pipes (and Notepad-saved files) may start with a UTF-8 BOM; z3 would read it as 3 stray characters
const stripBom = (s: string) => s.replace(/^\uFEFF/, "");
const readStdin = async () => { let s = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) s += c; return stripBom(s); };

const [cmd = "help", ...rest] = process.argv.slice(2);
// exit codes: 0 sat/ok, 10 unsat, 11 unknown, 12 timeout, 1 error, 2 usage

switch (cmd) {
  case "version": {
    const backend = rest[0] === "--backend" ? rest[1] : undefined;
    const solver = (() => { try { return makeSolver(backend); } catch (e) { return die((e as Error).message); } })();
    try { console.log(await solver.version()); } catch (e) { die(String((e as Error).message ?? e)); } finally { await solver.dispose?.(); }
    break;
  }
  case "session": {
    let backend: string | undefined, timeoutSec = 30, memoryMb: number | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--backend") backend = rest[++i];
      else if (a === "--timeout") timeoutSec = Number(rest[++i]);
      else if (a === "--memory") memoryMb = Number(rest[++i]);
      else die(`unknown option ${a}`);
    }
    if (!(timeoutSec > 0)) die("--timeout needs a positive number");
    const solver = (() => { try { return makeSolver(backend); } catch (e) { return die((e as Error).message); } })();
    const reply = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
    let session;
    try { session = await solver.openSession!({ timeoutSec, memoryMb }); reply({ ready: true, backend: solver.name, version: await solver.version() }); }
    catch (e) { reply({ ready: false, error: String((e as Error).message ?? e) }); await solver.dispose?.(); process.exit(1); }
    let buf = "";
    process.stdin.setEncoding("utf8");
    const lines: string[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    process.stdin.on("data", (d) => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, k)); buf = buf.slice(k + 1); } wake?.(); });
    process.stdin.on("end", () => { if (buf.trim()) lines.push(buf); ended = true; wake?.(); });
    for (;;) {
      while (!lines.length && !ended) await new Promise<void>((r) => { wake = r; });
      const line = lines.shift();
      if (line === undefined) break;
      if (!line.trim()) continue;
      let req: { script?: unknown; close?: unknown; timeoutSec?: unknown };
      try { req = JSON.parse(stripBom(line)); } catch (e) { reply({ errors: [`bad JSON line: ${(e as Error).message}`] }); continue; }
      if (req.close) break;
      if (typeof req.script !== "string") { reply({ errors: ['need {"script": "..."} or {"close": true}'] }); continue; }
      const limit = typeof req.timeoutSec === "number" && req.timeoutSec > 0 ? req.timeoutSec : undefined;
      reply(await session.run(req.script, { timeoutSec: limit }));
    }
    await session.close();
    reply({ closed: true });
    await solver.dispose?.();
    process.exit(0);
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
    let json = false, raw = false, stats = false, dimacs = false, backend: string | undefined, timeoutSec: number | undefined, memoryMb: number | undefined, file = "-";
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--json") json = true;
      else if (a === "--raw") raw = true;
      else if (a === "--stats") stats = true;
      else if (a === "--dimacs") dimacs = true;
      else if (a === "--backend") backend = rest[++i];
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
    const solver = (() => { try { return makeSolver(backend); } catch (e) { return die((e as Error).message); } })();
    if (file !== "-" && /\.cnf$/i.test(file)) dimacs = true;
    const r = dimacs ? await solveDimacs(solver, text, { timeoutSec, memoryMb, stats }) : await solver.solve(text, { timeoutSec, memoryMb, raw, stats });
    await solver.dispose?.(); // the WASM backend keeps worker threads alive
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (r.dimacs) {
      // SAT-solver style output: an "s" line, then the assignment in "v" lines
      console.log(`s ${({ sat: "SATISFIABLE", unsat: "UNSATISFIABLE", unknown: "UNKNOWN", timeout: "TIMEOUT", error: "ERROR" } as const)[r.status]}`);
      if (r.dimacs.assignment) {
        let line = "v";
        for (const l of [...r.dimacs.assignment, 0]) { if (line.length + String(l).length + 1 > 78) { console.log(line); line = "v"; } line += " " + l; }
        console.log(line);
      }
      if (r.reasonUnknown) console.log(`c reason unknown: ${r.reasonUnknown}`);
      for (const e of r.errors ?? []) console.error(`  error: ${e}`);
    } else {
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
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    const header = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))); // the leading comment block is the help text
    console.log(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    break;
  }
  default:
    die(`unknown command: ${cmd} (try: z3lab help)`);
}
