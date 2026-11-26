# DIMACS CNF の取り込み

SAT ソルバの標準形式を、そのまま Z3 に解かせる。`z3lab solve problem.cnf`(拡張子 `.cnf` で判定)、
`z3lab solve --dimacs -`(標準入力)、MCP ツールの `dimacs` 引数(本文)と `spec`(lab 内の `.cnf`)。

```text
c コメント行
p cnf 3 3        ← 変数 3、節 3
1 2 0            ← (x1 ∨ x2)。0 で節が終わる
-1 3 0           ← (¬x1 ∨ x3)
-2 -3 0          ← (¬x2 ∨ ¬x3)
```

## 変換(`lib/dimacs.ts`)

- 変数 `N` は Bool 定数 `vN`(`(declare-const vN Bool)`)。節は `(assert (or ...))`。リテラル `-N` は `(not vN)`。
- 単位節は `(assert vN)`、空の節は `(assert false)`(これだけで unsat)。
- 読み方は厳格。`c` で始まる行はコメント、`p cnf V C` のヘッダが要る、`%` で読み終わる(SATLIB の流儀)、
  1 つの節が複数行にまたがってよい、BOM は除く。リテラルの範囲、ヘッダの節の数との一致、最後の節が `0` で終わっているかを検査し、
  誤りは `status: "error"` と、何が悪いかのメッセージで返す。

## 出力

- テキスト(CLI): `s SATISFIABLE` と、割り当ての `v 1 -2 3 0`(約 78 文字で折り返す)、または `s UNSATISFIABLE`。
- `--json` / MCP: 通常の結果に `dimacs: { variables, clauses, assignment }` が付く(`model` は付かない)。
  `assignment` は、変数 3 が真なら `3`、偽なら `-3`。節に出てこない変数は偽として載せる。
- **sat のときは、返す前に割り当てが全節を満たすかをこちらで検査する**。満たさなければ `error`
  (「internal check failed」)にする。ソルバの出力を信じ切らない、という置き方。
- unsat のときは、DIMACS の節に名前が無いので `unsatCore` は空(`[]`)。

## 終了コードの違い

z3lab の終了コードは 0 = sat、10 = unsat、11 = unknown、12 = timeout、1 = error、2 = 使い方の誤り。
SAT コンペの慣例は **10 = SAT、20 = UNSAT** で、数字の意味が逆になる箇所がある。DIMACS を使うときも z3lab の
コードのまま(コンペ用のスクリプトに繋ぐなら変換が要る)。

## 試したもの

- `examples/dimacs/`: `small-sat.cnf`、`pigeonhole-4-3.cnf`(鳩 4 羽・巣 3 つ、22 節、unsat)、
  `random-3sat-20-91.cnf`(20 変数・91 節、seed 1)。
- `compare-backends` で、ランダム 3-SAT(n=50 / 100 / 150、比 4.26、固定シード)を exe と wasm の両方で解き、判定が一致。
- 未確認: SATLIB の公開ベンチマーク(uf20 など)。小さい `.cnf` を置けばそのまま試せる。
