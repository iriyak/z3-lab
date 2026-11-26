// session.ts — a resident solver session: state (declarations, assertions, push/pop levels) survives across run() calls.
// You send SMT-LIB text, you get back what z3 printed. Both backends implement it (openSession on the Solver).
export type Verdict = "sat" | "unsat" | "unknown";

export interface SessionOptions {
  timeoutSec?: number;   // per check-sat (z3's :timeout), and, plus 5 s, the wall-clock limit of one run(). default 30
  memoryMb?: number;     // z3 -memory: (z3 executable backend only)
}

export interface SessionRunResult {
  output: string;        // everything z3 printed for this run (LF line ends)
  verdicts: Verdict[];   // the answer of each (check-sat) in this run, in order
  errors: string[];      // z3 `(error "...")` lines, plus problems found before sending
  elapsedMs: number;
  closed?: boolean;      // true when the session no longer exists (timeout kill, process exit): its state is gone
}

export interface Session {
  readonly name: string;
  readonly alive: boolean;
  run(script: string, opts?: { timeoutSec?: number }): Promise<SessionRunResult>;
  close(): Promise<void>;
}

/** Parenthesis depth at the end of an SMT-LIB text (strings, |symbols| and ; comments are skipped); null if a ")" has no match. */
export function parenDepth(text: string): number | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ";") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === '"') { i++; while (i < text.length) { if (text[i] === '"') { if (text[i + 1] === '"') i += 2; else break; } else i++; } }
    else if (c === "|") { i++; while (i < text.length && text[i] !== "|") i++; }
    else if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth < 0) return null; }
  }
  return depth;
}

/** A script that is not balanced would swallow the end marker (exe) or leave z3 half-way through a command, so it is refused before sending. */
export function checkScript(script: string): string | undefined {
  const d = parenDepth(script);
  if (d === null) return "unbalanced parentheses: a \")\" has no matching \"(\"; nothing was sent";
  if (d > 0) return `unbalanced parentheses: ${d} \"(\" never closed; nothing was sent`;
  return undefined;
}

export function readOutput(output: string): { verdicts: Verdict[]; errors: string[] } {
  const verdicts: Verdict[] = [], errors: string[] = [];
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (t === "sat" || t === "unsat" || t === "unknown") verdicts.push(t);
    else if (/^\(error /.test(t)) errors.push(t);
  }
  return { verdicts, errors };
}
