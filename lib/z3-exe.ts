// z3-exe.ts — backend 1: the official z3 executable as a child process (`z3 -in`, SMT-LIB 2 on stdin).
// Lookup order: $Z3_EXE, lib/z3/bin/z3(.exe) (what scripts/get-z3.ps1 installs), lib/z3(.exe), then PATH.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSexps, toSmt, unquoteString, unquoteSymbol, type Sexp } from "./sexp";
import type { ModelValue, SolveOptions, SolveResult, Solver, Status } from "./solver";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.platform === "win32" ? "z3.exe" : "z3";

export function findZ3(): string {
  if (process.env.Z3_EXE) return process.env.Z3_EXE;
  for (const p of [path.join(HERE, "lib", "z3", "bin", EXE), path.join(HERE, "lib", EXE)]) if (existsSync(p)) return p;
  return "z3";
}

const PRELUDE = "(set-option :produce-models true)\n(set-option :produce-unsat-cores true)\n";
const EPILOGUE = [
  "(check-sat)",
  '(echo "@@model")', "(get-model)",
  '(echo "@@core")', "(get-unsat-core)",
  '(echo "@@reason")', "(get-info :reason-unknown)",
  '(echo "@@stats")', "(get-info :all-statistics)",
  "",
].join("\n");

interface Run { code: number | null; stdout: string; stderr: string; killed: boolean }

function run(exe: string, args: string[], stdin: string, killMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; p.kill("SIGKILL"); }, killMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: 255, stdout, stderr: stderr + `cannot run ${exe}: ${e.message}`, killed }); });
    // Windows z3 prints CRLF; normalize once here so nothing downstream has to care
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.replace(/\r\n/g, "\n"), stderr: stderr.replace(/\r\n/g, "\n"), killed }); });
    p.stdin.on("error", () => {}); // z3 may exit before reading everything
    p.stdin.end(stdin);
  });
}

function value(x: Sexp): ModelValue {
  if (typeof x === "string") {
    if (x === "true") return true;
    if (x === "false") return false;
    if (/^-?\d+$/.test(x)) { const n = Number(x); return Number.isSafeInteger(n) ? n : x; }
    return x;
  }
  if (x.length === 2 && x[0] === "-" && typeof x[1] === "string" && /^\d+$/.test(x[1])) {
    const n = -Number(x[1]);
    return Number.isSafeInteger(n) ? n : "-" + x[1];
  }
  return toSmt(x);
}

const PRELUDE_LINES = PRELUDE.split("\n").length - 1;
// z3 counts lines from the top of what it was fed; shift them back so they match the user's text
const errorsOf = (items: Sexp[], shift = 0): string[] =>
  items.filter((x) => Array.isArray(x) && x[0] === "error").map((x) =>
    unquoteString(String((x as Sexp[])[1] ?? "")).replace(/^line (\d+)/, (_, n) => `line ${Math.max(1, Number(n) - shift)}`));

function parseModel(items: Sexp[], r: SolveResult) {
  let defs: Sexp[] = [];
  for (const it of items) {
    if (!Array.isArray(it) || it[0] === "error") continue;
    defs = it[0] === "model" ? it.slice(1) : it;
  }
  for (const d of defs) {
    if (!Array.isArray(d) || d[0] !== "define-fun") continue;
    const name = unquoteSymbol(String(d[1])), params = d[2] as Sexp, sort = toSmt(d[3]), body = d[4];
    if (Array.isArray(params) && params.length === 0) (r.model ??= {})[name] = value(body);
    else (r.functions ??= {})[name] = { params: toSmt(params), sort, body: toSmt(body) };
  }
  // z3 lists constants in an arbitrary order; sort by name (numbers inside names in numeric order) so models are readable
  if (r.model) r.model = Object.fromEntries(Object.entries(r.model).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
}

function parseStats(items: Sexp[]): Record<string, number | string> | undefined {
  const l = items.find((x) => Array.isArray(x) && typeof x[0] === "string" && x[0].startsWith(":")) as Sexp[] | undefined;
  if (!l) return undefined;
  const s: Record<string, number | string> = {};
  for (let i = 0; i + 1 < l.length; i += 2) {
    const k = String(l[i]).replace(/^:/, ""), v = l[i + 1];
    s[k] = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : toSmt(v);
  }
  return s;
}

const verdict = (items: Sexp[]): Status | undefined => {
  const v = items.filter((x) => x === "sat" || x === "unsat" || x === "unknown");
  return v.length ? (v[v.length - 1] as Status) : undefined;
};

export class Z3ExeSolver implements Solver {
  readonly name = "z3-exe";
  constructor(private exe = findZ3()) {}

  async version(): Promise<string> {
    const r = await run(this.exe, ["--version"], "", 15000);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${this.exe} exited with ${r.code}`);
    return r.stdout.trim();
  }

  async solve(smtlib: string, opts: SolveOptions = {}): Promise<SolveResult> {
    const timeoutSec = opts.timeoutSec ?? 30;
    const raw = opts.raw || /\(\s*check-sat/.test(smtlib); // a script with its own check-sat is run as is
    const args = ["-in", `-T:${timeoutSec}`];
    if (opts.memoryMb) args.push(`-memory:${opts.memoryMb}`);
    const t0 = Date.now();
    const r = await run(this.exe, args, raw ? smtlib + "\n" : PRELUDE + smtlib + "\n" + EPILOGUE, (timeoutSec + 5) * 1000);
    const res: SolveResult = { backend: this.name, mode: raw ? "raw" : "auto", status: "error", elapsedMs: Date.now() - t0 };

    if (r.killed) { res.status = "timeout"; res.errors = [`killed after ${timeoutSec + 5}s`]; return res; }
    if (r.code === 255 && /cannot run/.test(r.stderr)) { res.errors = [r.stderr.trim()]; return res; }

    const parts = r.stdout.split(/^@@(model|core|reason|stats)\r?$/m); // [pre, name, body, name, body, ...]
    const sec: Record<string, Sexp[]> = {};
    for (let i = 1; i < parts.length; i += 2) sec[parts[i]] = parseSexps(parts[i + 1]);
    const pre = parseSexps(parts[0]);

    const errs = errorsOf(pre, raw ? 0 : PRELUDE_LINES);
    const status = verdict(pre);
    if (/^timeout\r?$/m.test(parts[0])) { res.status = "timeout"; return res; } // z3 -T: prints "timeout" and stops
    if (status) res.status = status;
    if (errs.length) { res.errors = errs; res.status = "error"; } // a script with errors never reports a plain sat
    else if (r.stderr.trim() && !status) res.errors = [r.stderr.trim()];

    if (raw) { res.output = r.stdout.trim(); return res; }
    // keep only what the script itself printed (echo, get-info ...): not the verdict, not the errors listed above
    const out = parts[0].split(/\r?\n/).filter((l) => l.trim() && !/^\(error /.test(l) && !["sat", "unsat", "unknown"].includes(l.trim())).join("\n");
    if (out) res.output = out;
    if (res.status === "error") return res;
    if (res.status === "sat") parseModel(sec.model ?? [], res);
    if (res.status === "unsat") {
      const core = (sec.core ?? []).find((x) => Array.isArray(x) && x[0] !== "error") as Sexp[] | undefined;
      if (core) res.unsatCore = core.map((x) => unquoteSymbol(toSmt(x)));
    }
    if (res.status === "unknown") {
      const ru = (sec.reason ?? []).find((x) => Array.isArray(x) && x[0] === ":reason-unknown") as Sexp[] | undefined;
      if (ru) res.reasonUnknown = unquoteString(toSmt(ru[1]));
    }
    if (opts.stats) { const stats = parseStats(sec.stats ?? []); if (stats) res.stats = stats; }
    return res;
  }
}
