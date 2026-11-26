// probe-z3-solver.mjs — does the npm `z3-solver` (Z3 compiled to WASM) work here, under bun and under Node?
//   bun  experiments/probe-z3-solver.mjs
//   node experiments/probe-z3-solver.mjs
// Needs:  bun add z3-solver   (or: npm install z3-solver)
// Prints one line per check (OK / FAIL) and the time it took. Exit code 0 only if every check passed.
const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;
console.log(`runtime: ${runtime} on ${process.platform}/${process.arch}`);

let failed = 0;
const t0 = performance.now();
const check = async (name, fn) => {
  const t = performance.now();
  try {
    const detail = await fn();
    console.log(`OK    ${name}${detail === undefined ? "" : "  -> " + detail}  (${Math.round(performance.now() - t)} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  -> ${e && e.message ? e.message.split("\n")[0] : e}`);
  }
};

let z3api;
await check("import z3-solver", async () => {
  z3api = await import("z3-solver");
  return Object.keys(z3api).join(", ");
});
if (!z3api) { console.log("cannot continue without the package"); process.exit(1); }

let Z3, em, ctx;
await check("init (loads the WASM, starts workers)", async () => {
  const r = await z3api.init();
  Z3 = r.Z3;
  em = r.em;
  ctx = new r.Context("main");
  return "ok";
});

await check("version", async () => {
  const v = Z3.get_version ? Z3.get_version() : undefined;
  return v ? `${v.major}.${v.minor}.${v.build_number}` : "(no get_version)";
});

await check("high-level API: x + 2y = 7, x > 2, y < 10", async () => {
  const { Solver, Int } = ctx;
  const x = Int.const("x"), y = Int.const("y");
  const s = new Solver();
  s.add(x.gt(2), y.lt(10), x.add(y.mul(2)).eq(7));
  const r = await s.check();
  if (r !== "sat") throw new Error(`expected sat, got ${r}`);
  const m = s.model();
  const xv = Number(m.eval(x).toString()), yv = Number(m.eval(y).toString());
  if (!(xv > 2 && yv < 10 && xv + 2 * yv === 7)) throw new Error(`bad model x=${xv} y=${yv}`);
  return `x=${xv} y=${yv}`;
});

await check("SMT-LIB text via Solver.fromString (what a Solver backend needs)", async () => {
  const { Solver } = ctx;
  const s = new Solver();
  s.fromString("(declare-const a Int) (declare-const b Int) (assert (> a b)) (assert (< a 3)) (assert (> b 0))");
  const r = await s.check();
  if (r !== "sat") throw new Error(`expected sat, got ${r}`);
  const m = s.model();
  return m.decls().map((d) => `${d.name()}=${m.get(d)}`).sort().join(" ");
});

await check("unsat + unsat core (named assertions)", async () => {
  const { Solver, Bool } = ctx;
  const s = new Solver();
  const p = Bool.const("p");
  s.addAndTrack(p, "must-p");
  s.addAndTrack(ctx.Not(p), "must-not-p");
  const r = await s.check();
  if (r !== "unsat") throw new Error(`expected unsat, got ${r}`);
  const core = s.unsatCore(); // an AstVector, not an array
  const names = [];
  for (let i = 0; i < core.length(); i++) names.push(String(core.get(i)));
  return names.sort().join(",");
});

await check("timeout parameter (solver.set('timeout', ms))", async () => {
  const { Solver, Int } = ctx;
  const x = Int.const("x"), y = Int.const("y"), z = Int.const("z");
  const s = new Solver();
  s.set("timeout", 500);
  s.add(x.gt(1), y.gt(1), z.gt(1), x.mul(x).mul(x).add(y.mul(y).mul(y)).eq(z.mul(z).mul(z)));
  const t = performance.now();
  const r = await s.check();
  return `${r} after ${Math.round(performance.now() - t)} ms${r === "unknown" ? ` (reason: ${s.reasonUnknown()})` : ""}`;
});

await check("Optimize (maximize x subject to x + y <= 10, y >= 3)", async () => {
  if (!ctx.Optimize) throw new Error("ctx.Optimize is not exposed");
  const { Int } = ctx;
  const o = new ctx.Optimize();
  const x = Int.const("x"), y = Int.const("y");
  o.add(x.add(y).le(10), y.ge(3), x.ge(0));
  o.maximize(x);
  const r = await o.check();
  return `${r} x=${o.model().eval(x)}`;
});

await check("tactics (Tactic('simplify'), Tactic('sat'))", async () => {
  if (!ctx.Tactic) throw new Error("ctx.Tactic is not exposed");
  const names = ["simplify", "sat", "smt"];
  for (const n of names) new ctx.Tactic(n);
  return names.join(", ");
});

await check("pure SAT as Bool (pigeonhole 3 pigeons / 2 holes is unsat)", async () => {
  const { Solver, Bool, Or, Not } = ctx;
  const v = (p, h) => Bool.const(`p${p}h${h}`);
  const s = new Solver();
  for (let p = 0; p < 3; p++) s.add(Or(v(p, 0), v(p, 1)));
  for (let h = 0; h < 2; h++) for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) s.add(Or(Not(v(a, h)), Not(v(b, h))));
  const r = await s.check();
  if (r !== "unsat") throw new Error(`expected unsat, got ${r}`);
  return "unsat";
});

console.log(`total ${Math.round(performance.now() - t0)} ms, ${failed ? failed + " failed" : "all passed"}`);

// z3-solver keeps worker threads alive; end them explicitly (killThreads), then see whether the process exits by itself.
const exitTimer = setTimeout(() => { console.log("NOTE  process did not exit on its own; forcing exit"); process.exit(failed ? 1 : 0); }, 3000);
exitTimer.unref();
try { await z3api.killThreads(em); console.log("killThreads: ok"); } catch (e) { console.log(`killThreads: ${e.message}`); }
process.exitCode = failed ? 1 : 0;
