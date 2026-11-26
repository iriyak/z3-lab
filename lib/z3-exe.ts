// z3-exe.ts — backend 1: the official z3 executable as a child process (`z3 -in`, SMT-LIB 2 on stdin).
// Lookup order: $Z3_EXE, lib/z3/bin/z3(.exe) (what scripts/get-z3.ps1 installs), lib/z3(.exe), then PATH.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScript, interpret } from "./smtlib";
import type { SolveOptions, SolveResult, Solver } from "./solver";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.platform === "win32" ? "z3.exe" : "z3";

export function findZ3(): string {
  if (process.env.Z3_EXE) return process.env.Z3_EXE;
  for (const p of [path.join(HERE, "lib", "z3", "bin", EXE), path.join(HERE, "lib", EXE)]) if (existsSync(p)) return p;
  return "z3";
}

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
    const script = buildScript(smtlib, opts); // z3.exe stops by itself with -T:
    const args = ["-in", `-T:${timeoutSec}`];
    if (opts.memoryMb) args.push(`-memory:${opts.memoryMb}`);
    const t0 = Date.now();
    const r = await run(this.exe, args, script.text, (timeoutSec + 5) * 1000);
    const elapsedMs = Date.now() - t0;
    const fail = (status: SolveResult["status"], msg: string): SolveResult =>
      ({ backend: this.name, mode: script.raw ? "raw" : "auto", status, errors: [msg], elapsedMs });

    if (r.killed) return fail("timeout", `killed after ${timeoutSec + 5}s`);
    if (r.code === 255 && /cannot run/.test(r.stderr)) return fail("error", r.stderr.trim());
    return interpret({ backend: this.name, script, stdout: r.stdout, stderr: r.stderr, elapsedMs, opts });
  }
}
