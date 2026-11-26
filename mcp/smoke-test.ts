// Spawns mcp/server.ts over stdio with the MCP SDK client and exercises the `z3` tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpDir = path.dirname(fileURLToPath(import.meta.url)); // not URL.pathname: that breaks on Windows ("/C:/...")
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(mcpDir, "server.ts")],
  env: { ...process.env, Z3_LAB: path.resolve(mcpDir, "..") } as Record<string, string>,
}));

const call = async (args: Record<string, unknown>) => {
  try {
    const r: any = await client.callTool({ name: "z3", arguments: args });
    return { isError: !!r.isError, text: r.content[0].text as string };
  } catch (e) {
    return { isError: true, text: String(e) }; // schema validation errors may surface as protocol errors
  }
};
let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
  if (!ok) failed++;
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

// The same checks run against each backend. wasm needs `bun add z3-solver`; it is skipped when the package is missing.
const hasWasm = await import("z3-solver").then(() => true, () => false);
for (const backend of hasWasm ? ["exe", "wasm"] : ["exe"]) {
  console.log(`\n-- backend: ${backend}`);
  const ask = (args: Record<string, unknown>) => call({ ...args, backend });
  let r = await ask({ action: "version" });
  expect("version", /Z3 version/i.test(r.text), r.text);

  r = await ask({ action: "solve", spec: "examples/sat-basic.smt2" });
  let j = JSON.parse(r.text);
  expect(`sat-basic: sat, x + 2y = 7 (backend ${j.backend})`, !r.isError && j.backend === `z3-${backend}` && j.status === "sat" && j.model.x + 2 * j.model.y === 7 && j.model.x > 2, r.text);

  r = await ask({ action: "solve", spec: "examples/unsat-core.smt2" });
  j = JSON.parse(r.text);
  expect("unsat-core: unsat is a verdict, not a tool error", !r.isError && j.status === "unsat" && j.unsatCore.sort().join() === "too-big,too-small", r.text);

  r = await ask({ action: "solve", source: "(declare-const p Bool)(declare-const q Bool)(assert (or p q))(assert (not p))" });
  j = JSON.parse(r.text);
  expect("inline SAT problem", j.status === "sat" && j.model.p === false && j.model.q === true, r.text);

  r = await ask({ action: "solve", source: "(declare-const x Int)(assert (> x 1))(check-sat)(push)(assert (< x 0))(check-sat)(pop)" });
  j = JSON.parse(r.text);
  expect("script with its own check-sat runs raw", j.mode === "raw" && j.output.split("\n").join(",") === "sat,unsat", r.text);

  r = await ask({ action: "solve", source: "(assert (> x 1))" });
  j = JSON.parse(r.text);
  expect("undeclared constant -> status error with message", j.status === "error" && /unknown constant x/.test(j.errors[0]) && /line 1\b/.test(j.errors[0]), r.text);

  r = await ask({ action: "solve", source: "(declare-const x Int)(declare-const y Int)(declare-const z Int)(assert (> x 1))(assert (> y 1))(assert (> z 1))(assert (= (+ (* x x x) (* y y y)) (* z z z)))", timeoutSec: 1 });
  j = JSON.parse(r.text);
  expect("timeout reported", !r.isError && j.status === "timeout", r.text);

  r = await ask({ action: "solve", dimacs: "c tiny\np cnf 3 2\n1 -3 0\n2 3 -1 0\n" });
  j = JSON.parse(r.text);
  const clauses = [[1, -3], [2, 3, -1]];
  expect("DIMACS inline: sat, assignment satisfies every clause, no model", !r.isError && j.status === "sat" && !j.model
    && j.dimacs.variables === 3 && clauses.every((c) => c.some((l: number) => j.dimacs.assignment.includes(l))), r.text);

  r = await ask({ action: "solve", spec: "examples/dimacs/pigeonhole-4-3.cnf" });
  j = JSON.parse(r.text);
  expect("DIMACS file (.cnf spec): pigeonhole 4 into 3 is unsat", !r.isError && j.status === "unsat" && j.dimacs.clauses === 22 && !("unsatCore" in j), r.text);

  r = await ask({ action: "solve", dimacs: "p cnf 2 3\n1 2 0\n-1 0\n" });
  j = JSON.parse(r.text);
  expect("DIMACS clause count mismatch -> error", j.status === "error" && /header says 3 clauses, found 2/.test(j.errors[0]), r.text);

  r = await ask({ action: "solve", source: "(assert true)", dimacs: "p cnf 0 0\n" });
  expect("source and dimacs together rejected", r.isError, r.text);

  r = await ask({ action: "solve" });
  expect("source or spec required", r.isError, r.text);

  // resident session (CLI `z3lab session`, JSON lines; the lab's own MCP tool is one-shot, local-mcp-server holds sessions)
  const lab = path.resolve(mcpDir, "..");
  const sess = (reqs: unknown[], env: Record<string, string> = {}) => {
    const p = spawnSync(process.execPath, [path.join(lab, "bin", "z3lab.ts"), "session", "--backend", backend, "--timeout", "10"],
      { input: reqs.map((q) => JSON.stringify(q)).join("\n") + "\n", encoding: "utf8", env: { ...process.env, ...env } as Record<string, string> });
    return (p.stdout ?? "").replace(/\r\n/g, "\n").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const L = sess([
    { script: "(declare-const x Int)(push)(assert (> x 3))(check-sat)" },
    { script: "(assert (< x 2))(check-sat)(pop)(check-sat)(get-value (x))" },
    { script: "(assert (bad" },
    { close: true },
  ]);
  expect("session: ready line", L[0]?.ready === true && L[0].backend === `z3-${backend}`, JSON.stringify(L[0]));
  expect("session: state survives between runs (push / pop)", L[1]?.verdicts?.join() === "sat" && L[2]?.verdicts?.join() === "unsat,sat" && /^\(\(x \d+\)\)$/m.test(L[2].output), JSON.stringify(L.slice(1, 3)));
  expect("session: unbalanced input refused, session still usable", L[3]?.errors?.length === 1 && !L[3].closed, JSON.stringify(L[3]));
  expect("session: close", L[4]?.closed === true, JSON.stringify(L[4]));

  const en = spawnSync(process.execPath, [path.join(lab, "examples", "sudoku", "enumerate.ts")], { encoding: "utf8", env: { ...process.env, Z3_BACKEND: backend } as Record<string, string> });
  expect("sudoku enumerate: 33 solutions with one session", /all 33 solutions/.test(en.stdout ?? ""), (en.stdout ?? "") + (en.stderr ?? ""));

}

await client.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
