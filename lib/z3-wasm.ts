// z3-wasm.ts — backend 2: the npm `z3-solver` package (Z3 compiled to WASM, runs in-process).
// Same SMT-LIB scripts as the executable backend: Z3.eval_smtlib2_string runs a whole script and returns what
// `z3 -in` would have printed, so lib/smtlib.ts builds the script and reads the output for both.
// Needs `bun add z3-solver` (loaded lazily, so the executable backend works without it).
// Differences from z3.exe: no memory limit (memoryMb is ignored); the time limit is (set-option :timeout), with a
// watchdog that stops the worker threads if z3 does not honour it; call dispose() before the process ends.
import { buildScript, interpret } from "./smtlib";
import type { SolveOptions, SolveResult, Solver } from "./solver";
import { checkScript, readOutput, type Session, type SessionOptions, type SessionRunResult } from "./session";

interface Loaded { api: any; Z3: any; em: any; Context: any }
let loaded: Promise<Loaded> | undefined;
let seq = 0;
let generation = 0; // bumped each time the instance is torn down, so older sessions know they are dead

function load(): Promise<Loaded> {
  loaded ??= (async () => {
    let api: any;
    try { api = await import("z3-solver"); } catch { throw new Error("the npm package z3-solver is not installed (run: bun add z3-solver)"); }
    const { Z3, em, Context } = await api.init();
    return { api, Z3, em, Context };
  })();
  loaded.catch(() => { loaded = undefined; }); // a failed load can be retried
  return loaded;
}

// A resident Context: eval_smtlib2_string keeps declarations, assertions and push/pop levels in it between calls.
// Limit: if a run outlives its limit the only way to stop z3 is killThreads, which takes down the whole WASM instance,
// so every wasm session of this process is gone then (they report closed on their next run).
class Z3WasmSession implements Session {
  readonly name = "z3-wasm";
  private ctx: any;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private l: Loaded, private timeoutSec: number) {
    this.ctx = new l.Context(`s${++seq}`);
    this.first = l.Z3.eval_smtlib2_string(this.ctx.ptr, `(set-option :timeout ${timeoutSec * 1000})`) as Promise<string>;
  }
  private first: Promise<string>;
  get alive(): boolean { return !this.closed && loaded !== undefined && this.gen === generation; }
  private gen = generation;

  run(script: string, opts: { timeoutSec?: number } = {}): Promise<SessionRunResult> {
    const r = this.tail.then(() => this.runOne(script, opts.timeoutSec));
    this.tail = r.catch(() => {});
    return r;
  }

  private async runOne(script: string, limitSec?: number): Promise<SessionRunResult> {
    const t0 = Date.now();
    const res = (output: string, errors: string[], closed?: boolean): SessionRunResult => {
      const o = readOutput(output);
      return { output, verdicts: o.verdicts, errors: [...errors, ...o.errors], elapsedMs: Date.now() - t0, ...(closed ? { closed: true } : {}) };
    };
    if (!this.alive) return res("", ["the session is closed"], true);
    const bad = checkScript(script);
    if (bad) return res("", [bad]);
    await this.first;
    const watchMs = ((limitSec ?? this.timeoutSec) + 5) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<"stuck">((resolve) => { timer = setTimeout(() => resolve("stuck"), watchMs); });
    try {
      const out = await Promise.race([this.l.Z3.eval_smtlib2_string(this.ctx.ptr, script) as Promise<string>, watchdog]);
      if (out === "stuck") {
        await new Z3WasmSolver().dispose(); // stops the worker threads; every wasm session of this process is gone
        return res("", [`stopped after ${watchMs / 1000}s: the session and its state are gone (all wasm sessions of this process)`], true);
      }
      return res(out.replace(/\r\n/g, "\n"), []);
    } catch (e) {
      return res("", [(e as Error).message ?? String(e)]);
    } finally { clearTimeout(timer); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const was = this.alive;
    this.closed = true;
    if (was) { try { this.l.Z3.del_context(this.ctx.ptr); } catch { /* instance already gone */ } }
  }
}

export class Z3WasmSolver implements Solver {
  readonly name = "z3-wasm";

  async version(): Promise<string> {
    const { Z3 } = await load();
    const v = Z3.get_version();
    return `Z3 version ${v.major}.${v.minor}.${v.build_number} (npm z3-solver, WASM)`;
  }

  async solve(smtlib: string, opts: SolveOptions = {}): Promise<SolveResult> {
    const timeoutSec = opts.timeoutSec ?? 30;
    const script = buildScript(smtlib, opts, [`(set-option :timeout ${timeoutSec * 1000})`]);
    const fail = (status: SolveResult["status"], msg: string, elapsedMs: number): SolveResult =>
      ({ backend: this.name, mode: script.raw ? "raw" : "auto", status, errors: [msg], elapsedMs });

    let l: Loaded;
    try { l = await load(); } catch (e) { return fail("error", (e as Error).message, 0); }

    const t0 = Date.now();
    const ctx = new l.Context(`c${++seq}`); // a fresh context per call: no state carries over between problems
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<"stuck">((resolve) => { timer = setTimeout(() => resolve("stuck"), (timeoutSec + 5) * 1000); });
    try {
      const out = await Promise.race([l.Z3.eval_smtlib2_string(ctx.ptr, script.text) as Promise<string>, watchdog]);
      if (out === "stuck") {
        await this.dispose(); // the worker threads are the only way to stop it; the next call starts a fresh instance
        return fail("timeout", `stopped after ${timeoutSec + 5}s`, Date.now() - t0);
      }
      return interpret({ backend: this.name, script, stdout: out, elapsedMs: Date.now() - t0, opts });
    } catch (e) {
      return fail("error", (e as Error).message ?? String(e), Date.now() - t0);
    } finally {
      clearTimeout(timer);
      this.release(l, ctx);
    }
  }

  async openSession(opts: SessionOptions = {}): Promise<Session> {
    return new Z3WasmSession(await load(), opts.timeoutSec ?? 30);
  }

  // The high-level Context frees itself only from a GC finalizer, and the WASM heap is a fixed 2 GB, so ~80
  // calls in one process ran out of memory (Aborted(Cannot enlarge memory arrays ...)). Delete the context
  // now (300 calls with forced GC afterwards ran clean, so the finalizer's later delete is harmless).
  private release(l: Loaded, ctx: any): void {
    try { l.Z3.del_context(ctx.ptr); } catch { /* the instance may already be gone */ }
  }

  async dispose(): Promise<void> {
    if (!loaded) return;
    const p = loaded;
    loaded = undefined;
    generation++;
    try { const { api, em } = await p; await api.killThreads(em); } catch { /* nothing to stop */ }
  }
}
