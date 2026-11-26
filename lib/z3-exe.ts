// z3-exe.ts — backend 1: the official z3 executable as a child process (`z3 -in`, SMT-LIB 2 on stdin).
// Lookup order: $Z3_EXE, lib/z3/bin/z3(.exe) (what scripts/get-z3.ps1 installs), lib/z3(.exe), then PATH.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScript, interpret } from "./smtlib";
import type { SolveOptions, SolveResult, Solver } from "./solver";
import { checkScript, readOutput, type Session, type SessionOptions, type SessionRunResult } from "./session";

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

// A resident `z3 -in`. Each run() writes the script and an (echo marker), then reads stdout up to the marker.
// Runs are serialized. If a run outlives its limit the process is killed: the session (and its state) is gone.
class Z3ExeSession implements Session {
  readonly name = "z3-exe";
  alive = true;
  private p: ChildProcessWithoutNullStreams;
  private buf = "";
  private err = "";
  private seq = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private wake: (() => void) | undefined;

  constructor(exe: string, private timeoutSec: number, memoryMb?: number) {
    const args = ["-in"];
    if (memoryMb) args.push(`-memory:${memoryMb}`);
    this.p = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.p.stdout.on("data", (d) => { this.buf += String(d).replace(/\r\n/g, "\n"); this.wake?.(); });
    this.p.stderr.on("data", (d) => { this.err += String(d).replace(/\r\n/g, "\n"); });
    const gone = (msg?: string) => { if (msg) this.err += msg; this.alive = false; this.wake?.(); };
    this.p.on("error", (e) => gone(`cannot run ${exe}: ${e.message}`));
    this.p.on("close", () => gone());
    this.p.stdin.on("error", () => {});
    this.p.stdin.write(`(set-option :timeout ${timeoutSec * 1000})\n`);
  }

  run(script: string, opts: { timeoutSec?: number } = {}): Promise<SessionRunResult> {
    const r = this.tail.then(() => this.runOne(script, opts.timeoutSec));
    this.tail = r.catch(() => {});
    return r;
  }

  private async runOne(script: string, limitSec?: number): Promise<SessionRunResult> {
    const t0 = Date.now();
    const res = (output: string, errors: string[], closed?: boolean): SessionRunResult =>
      ({ output, ...pick(readOutput(output), errors), elapsedMs: Date.now() - t0, ...(closed ? { closed: true } : {}) });
    if (!this.alive) return res("", ["the session is closed"], true);
    const bad = checkScript(script);
    if (bad) return res("", [bad]);

    const mark = `@@END${++this.seq}`;
    this.buf = "";
    const watchMs = ((limitSec ?? this.timeoutSec) + 5) * 1000;
    this.p.stdin.write(`${script}\n(echo "${mark}")\n`);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.p.kill("SIGKILL"); }, watchMs);
    try {
      while (!this.buf.includes(mark + "\n") && this.alive) await new Promise<void>((resolve) => { this.wake = resolve; });
    } finally { clearTimeout(timer); this.wake = undefined; }

    const at = this.buf.indexOf(mark + "\n");
    if (at >= 0) return res(this.buf.slice(0, at), []);
    this.alive = false;
    const why = timedOut ? `killed after ${watchMs / 1000}s: the session and its state are gone` : (this.err.trim() || "z3 exited: the session and its state are gone");
    return res(this.buf, [why], true);
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.p.stdin.end();
    const p = this.p;
    await new Promise<void>((resolve) => { const t = setTimeout(() => { p.kill("SIGKILL"); resolve(); }, 2000); p.on("close", () => { clearTimeout(t); resolve(); }); });
  }
}

const pick = (o: { verdicts: SessionRunResult["verdicts"]; errors: string[] }, extra: string[]) => ({ verdicts: o.verdicts, errors: [...extra, ...o.errors] });

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

  async openSession(opts: SessionOptions = {}): Promise<Session> {
    return new Z3ExeSession(this.exe, opts.timeoutSec ?? 30, opts.memoryMb);
  }
}
