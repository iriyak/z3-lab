// smtlib.ts — what every backend shares: how a script is wrapped before it goes to z3, and how z3's printed
// output is turned into a SolveResult. A backend only has to run the script and hand back the text.
import { parseSexps, toSmt, unquoteString, unquoteSymbol, type Sexp } from "./sexp";
import type { ModelValue, SolveOptions, SolveResult, Status } from "./solver";

// A script with its own (check-sat), or opts.raw, is run exactly as written.
export const isRaw = (smtlib: string, opts: SolveOptions) => !!opts.raw || /\(\s*check-sat/.test(smtlib);

const EPILOGUE = [
  "(check-sat)",
  '(echo "@@model")', "(get-model)",
  '(echo "@@core")', "(get-unsat-core)",
  '(echo "@@reason")', "(get-info :reason-unknown)",
  '(echo "@@stats")', "(get-info :all-statistics)",
  "",
].join("\n");

export interface Script { text: string; raw: boolean; preludeLines: number }

// extraOptions: backend-specific (set-option ...) lines, e.g. :timeout for the WASM backend.
export function buildScript(smtlib: string, opts: SolveOptions, extraOptions: string[] = []): Script {
  const raw = isRaw(smtlib, opts);
  const prelude = [...extraOptions, ...(raw ? [] : ["(set-option :produce-models true)", "(set-option :produce-unsat-cores true)"])];
  const head = prelude.length ? prelude.join("\n") + "\n" : "";
  return { text: head + smtlib + "\n" + (raw ? "" : EPILOGUE), raw, preludeLines: prelude.length };
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

// z3 counts lines from the top of what it was fed; shift them back so they match the user's text
const errorsOf = (items: Sexp[], shift: number): string[] =>
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

export interface Printed { backend: string; script: Script; stdout: string; stderr?: string; elapsedMs: number; opts: SolveOptions }

// stdout must already use "\n" line ends.
export function interpret(p: Printed): SolveResult {
  const { script, opts } = p;
  const res: SolveResult = { backend: p.backend, mode: script.raw ? "raw" : "auto", status: "error", elapsedMs: p.elapsedMs };

  const parts = p.stdout.split(/^@@(model|core|reason|stats)$/m); // [pre, name, body, name, body, ...]
  const sec: Record<string, Sexp[]> = {};
  for (let i = 1; i < parts.length; i += 2) sec[parts[i]] = parseSexps(parts[i + 1]);
  const pre = parseSexps(parts[0]);

  if (/^timeout$/m.test(parts[0])) { res.status = "timeout"; return res; } // z3.exe -T: prints "timeout" and stops
  const errs = errorsOf(pre, script.preludeLines);
  const status = verdict(pre);
  if (status) res.status = status;
  if (errs.length) { res.errors = errs; res.status = "error"; } // a script with errors never reports a plain sat
  else if (p.stderr?.trim() && !status) res.errors = [p.stderr.trim()];

  if (script.raw) { res.output = p.stdout.trim(); return res; }
  // keep only what the script itself printed (echo, get-info ...): not the verdict, not the errors listed above
  const out = parts[0].split("\n").filter((l) => l.trim() && !/^\(error /.test(l) && !["sat", "unsat", "unknown"].includes(l.trim())).join("\n");
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
    // the WASM backend stops by (set-option :timeout): unknown + "timeout". Report it like z3.exe does.
    if (res.reasonUnknown && /^(timeout|canceled)$/.test(res.reasonUnknown)) res.status = "timeout";
  }
  if (opts.stats) { const stats = parseStats(sec.stats ?? []); if (stats) res.stats = stats; }
  return res;
}
