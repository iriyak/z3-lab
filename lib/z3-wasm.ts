// z3-wasm.ts — backend 2: the npm `z3-solver` package (Z3 compiled to WASM, runs in-process).
// Same SMT-LIB scripts as the executable backend: Z3.eval_smtlib2_string runs a whole script and returns what
// `z3 -in` would have printed, so lib/smtlib.ts builds the script and reads the output for both.
// Needs `bun add z3-solver` (loaded lazily, so the executable backend works without it).
// Differences from z3.exe: no memory limit (memoryMb is ignored); the time limit is (set-option :timeout), with a
// watchdog that stops the worker threads if z3 does not honour it; call dispose() before the process ends.
import { buildScript, interpret } from "./smtlib";
import type { SolveOptions, SolveResult, Solver } from "./solver";

interface Loaded { api: any; Z3: any; em: any; Context: any }
let loaded: Promise<Loaded> | undefined;
let seq = 0;

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
    }
  }

  async dispose(): Promise<void> {
    if (!loaded) return;
    const p = loaded;
    loaded = undefined;
    try { const { api, em } = await p; await api.killThreads(em); } catch { /* nothing to stop */ }
  }
}
