# サンプルと実験の一覧

## `examples/`

| ファイル | 内容 |
|---|---|
| `sat-basic.smt2` | 整数と Bool の制約(sat) |
| `unsat-core.smt2` | 名前付き表明で unsat core |
| `nqueens4.smt2` | 4 クイーン |
| `with-function.smt2` | 未解釈関数。model に `functions` が出る |
| `dimacs/small-sat.cnf` | 小さな DIMACS(sat) |
| `dimacs/pigeonhole-4-3.cnf` | 鳩の巣原理(鳩 4・巣 3、22 節。unsat) |
| `dimacs/random-3sat-20-91.cnf` | ランダム 3-SAT(20 変数・91 節、seed 1。sat。SATLIB のファイルではない) |
| `sudoku/sudoku.ts` | 数独を解いて盤面を表示し、解が唯一かも判定する bun スクリプト(自己完結)。`bun examples\sudoku\sudoku.ts [盤面ファイル \| -]`(引数なしは内蔵の例題)。盤面は 81 マス、空きは `.` `0` `_` `*`、空白や罫線は無視 |
| `sudoku/sudoku.ps1` | `sudoku.ts` の PowerShell ランチャーと使い方(パイプ入力に対応) |
| `sudoku/puzzle.txt` | `sudoku.ts` に渡す盤面のサンプル(罫線入りの見た目のまま書ける) |
| `sudoku/enumerate.ts` | 数独の解を全部数える bun スクリプト。常駐セッションに「この解は除く」を足しては解き直し、`unsat` で終わる。`bun examples\sudoku\enumerate.ts [盤面 \| -] [--max N] [--print] [--fresh]`(`--fresh` はセッションなしで毎回解き直す比較用) |
| `sudoku/enumerate.ps1` | `enumerate.ts` の PowerShell ランチャーと使い方 |
| `sudoku/puzzle-few.txt` | 解が 33 個ある盤面(`puzzle.txt` から手がかりを 8 つ消したもの)。`enumerate.ts` の既定 |
| `sudoku/sudoku.smt2` | 数独(Wikipedia の例題)を手で書いた SMT-LIB。解は `model` の `c<行><列>`。`distinct` だけで書ける |
| `sudoku/sudoku-unique.smt2` | 数独の解が唯一かの確認。解を 1 つ除外してもう一度解かせる(`sat`、`unsat` の順に出れば唯一)。自前の `check-sat` があるので raw で動く |

## `experiments/`

| ファイル | 内容 |
|---|---|
| `probe-z3-solver.mjs` | npm の `z3-solver` が bun / Node で動くかの 10 項目の確認(`bun` でも `node` でも実行できる) |
| `compare-backends.ts` | 2 つのバックエンドに同じ問題(`examples/` の全 `.smt2` / `.cnf` と、生成した N クイーンとランダム 3-SAT)を解かせ、判定が一致するか・時間を比べる。`bun experiments\compare-backends.ts [--repeat N] [--timeout 秒]`。結果の表は [backends.md](backends.md) |
| `satlib.ts` | フォルダ以下の `.cnf` を全部解いて、判定を確かめる。SATLIB の `uf...`(全部 sat)と `uuf...`(全部 unsat)はファイル名から期待値を決める(`--expect` でも指定できる)。`bun experiments\satlib.ts <フォルダ> [--expect sat\|unsat] [--backend exe\|wasm] [--limit N] [--timeout 秒]`。sat の答えは割り当てを全節で検査する。1000 ファイルなら `--backend wasm`(プロセスを起こさない)が向く。期待と違うものがあれば終了コード 1 |

## 動作確認

```powershell
bun run mcp/smoke-test.ts      # 1 バックエンドあたり 17 件(exe と wasm の両方)
```
MCP ツール(1 回完結の `z3`)、DIMACS、常駐セッション(CLI)、数独の数え上げを確かめる。
