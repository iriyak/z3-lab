// sexp.ts — minimal SMT-LIB 2 S-expression reader (enough for z3's responses).
// Atoms stay strings (string literals keep their double quotes; |quoted symbols| keep their bars).
export type Sexp = string | Sexp[];

export function parseSexps(text: string): Sexp[] {
  const out: Sexp[] = [];
  const stack: Sexp[][] = [];
  const push = (x: Sexp) => (stack.length ? stack[stack.length - 1].push(x) : out.push(x));
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ";") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "(") { stack.push([]); i++; continue; }
    if (c === ")") {
      const l = stack.pop();
      if (l) push(l); // a stray ")" is ignored
      i++;
      continue;
    }
    let j = i;
    if (c === '"') {
      j++;
      while (j < text.length) {
        if (text[j] === '"') { if (text[j + 1] === '"') j += 2; else { j++; break; } } else j++;
      }
    } else if (c === "|") {
      j++;
      while (j < text.length && text[j] !== "|") j++;
      j++;
    } else {
      while (j < text.length && !/[\s()]/.test(text[j])) j++;
    }
    push(text.slice(i, j));
    i = j;
  }
  while (stack.length) push(stack.pop()!); // unterminated list: keep what we have
  return out;
}

export const toSmt = (x: Sexp): string => (typeof x === "string" ? x : "(" + x.map(toSmt).join(" ") + ")");
export const unquoteString = (s: string): string => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
export const unquoteSymbol = (s: string): string => (s.startsWith("|") && s.endsWith("|") ? s.slice(1, -1) : s);
