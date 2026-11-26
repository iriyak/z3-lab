// Spawns mcp/server.ts over stdio with the MCP SDK client and exercises the `z3` tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

  r = await ask({ action: "solve" });
  expect("source or spec required", r.isError, r.text);

}

await client.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
