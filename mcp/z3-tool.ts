// MCP tool `z3`: drives bin/z3lab (z3 via SMT-LIB 2).
// Drop-in for local-mcp-server:  import { registerZ3Tool } from "./z3-tool"; registerZ3Tool(server);
// Runs natively on Windows (set Z3_LAB to the lab folder; set Z3_EXE if z3 is not in lib/z3 or on PATH).
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const LAB = process.env.Z3_LAB ?? path.join(os.homedir(), "z3-lab");
const BUN = /bun/i.test(path.basename(process.execPath)) ? process.execPath : "bun";

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runZ3lab(args: string[], opts: { stdin?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(BUN, [path.join(LAB, "bin", "z3lab.ts"), ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, opts.timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: 255, stdout, stderr: stderr + `cannot run ${BUN}: ${e.message}`, timedOut }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    p.stdin.on("error", () => {});
    p.stdin.end(opts.stdin ?? "");
  });
}

export const z3Input = {
  action: z.enum(["version", "solve"]).describe("version: z3 version. solve: run SMT-LIB 2 text and return a JSON result."),
  source: z.string().optional().describe(
    "SMT-LIB 2 text (declare-const / assert ...). Do not add (check-sat): it is appended, followed by get-model and get-unsat-core. " +
    "Name assertions with (assert (! F :named n)) to get an unsat core. Alternative to `spec`."),
  spec: z.string().optional().describe("Existing .smt2 or .cnf path in the lab, e.g. examples/nqueens4.smt2 or examples/dimacs/small-sat.cnf (.cnf is read as DIMACS). Alternative to `source`."),
  dimacs: z.string().optional().describe("DIMACS CNF text (p cnf V C, clauses ending in 0). Solved as a pure SAT problem over Bool v1..vn; the result has dimacs.assignment (v3 true -> 3, false -> -3) instead of model. Alternative to `source` and `spec`."),
  backend: z.enum(["exe", "wasm"]).optional().describe("exe: the z3 executable (default). wasm: the npm z3-solver (WASM, in-process; no memoryMb)."),
  raw: z.boolean().optional().describe("Run the script exactly as given (use for scripts with their own check-sat / get-value / push / pop); z3's output comes back in `output`."),
  stats: z.boolean().optional().describe("Include z3 statistics in the result (long; off by default)."),
  timeoutSec: z.number().int().min(1).max(1800).optional().describe("Wall-clock limit (default 30)."),
  memoryMb: z.number().int().min(16).optional().describe("z3 memory limit in MB."),
};

export async function runZ3(a: z.infer<z.ZodObject<typeof z3Input>>) {
  const timeoutSec = a.timeoutSec ?? 30;
  const out = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
  if (a.action === "version") {
    const r = await runZ3lab(["version"], { timeoutMs: 20000 });
    return out((r.stdout || r.stderr).trim(), r.code !== 0);
  }
  const given = [a.source !== undefined, !!a.spec, a.dimacs !== undefined].filter(Boolean).length;
  if (given === 0) return out("Give one of `source`, `spec` or `dimacs`.", true);
  if (given > 1) return out("Give only one of `source`, `spec` and `dimacs`.", true);
  const args = ["solve", "--json", "--timeout", String(timeoutSec)];
  if (a.memoryMb) args.push("--memory", String(a.memoryMb));
  if (a.backend) args.push("--backend", a.backend);
  if (a.raw) args.push("--raw");
  if (a.stats) args.push("--stats");
  if (a.dimacs !== undefined) args.push("--dimacs");
  if (a.spec) args.push(path.isAbsolute(a.spec) ? a.spec : path.join(LAB, a.spec)); else args.push("-");
  const r = await runZ3lab(args, { stdin: a.dimacs ?? a.source, timeoutMs: (timeoutSec + 15) * 1000 });
  if (r.timedOut) return out(`z3lab timed out after ${timeoutSec + 15}s (killed).`, true);
  // exit 10 (unsat), 11 (unknown), 12 (timeout) are verdicts in the JSON, not tool failures
  const verdict = r.code === 0 || (r.code !== null && r.code >= 10 && r.code <= 12);
  return out(r.stdout.trim() || r.stderr.trim(), !verdict);
}

export function registerZ3Tool(server: McpServer) {
  server.registerTool(
    "z3",
    {
      title: "Z3 (SMT / SAT)",
      description:
        "Run the Z3 SMT solver from the local z3-lab on SMT-LIB 2 text (pure SAT problems are just Bool constants). " +
        "Returns JSON: status (sat, unsat, unknown, timeout, error), model (constants), functions, unsatCore (for named assertions), reasonUnknown, errors.",
      inputSchema: z3Input,
    },
    async (args) => runZ3(args),
  );
}
