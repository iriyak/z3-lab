# バックエンド(exe と wasm)

CLI と MCP ツールは、`Solver` インターフェース(`lib/solver.ts`)の裏にある 2 つの実装のどちらかで解く。
どちらも同じ SMT-LIB スクリプトを受け取り、同じ形の結果(`SolveResult`)を返す。選び方は `--backend exe|wasm`、
環境変数 `Z3_BACKEND`、MCP ツールの `backend` 引数。

| | `exe`(既定) | `wasm` |
|---|---|---|
| 中身 | 公式の z3 実行ファイルを子プロセスで(`z3 -in`) | npm の `z3-solver`(Z3 を WASM にしたもの)をプロセス内で |
| 版(この環境) | 5.3.3(`scripts/get-z3.ps1` が取る公式版) | 5.4.1(npm の版) |
| 起動 | 呼び出しごとにプロセスを起こす(Windows で約 70〜90 ms) | 初回だけ読み込み(約 0.3〜1.0 秒)。以後はプロセス内 |
| 速さ | 大きい問題で速い | 小さい問題は速いが、大きい問題では数倍遅い |
| `--memory` | 効く(`-memory:`) | 効かない |
| 時間制限 | `-T:秒` + 5 秒後に kill | `(set-option :timeout ミリ秒)` + 5 秒後にワーカースレッドを止める |
| 導入 | `get-z3.ps1` | `bun add z3-solver`(読み込みは遅延。無くても exe は動く) |

## 共通の部分(`lib/smtlib.ts`)

- `buildScript()` が、入力に `(check-sat)` があるか `raw` でなければ、`(check-sat)` と
  `(echo "@@model")(get-model)`、`(echo "@@core")(get-unsat-core)`、`(echo "@@reason")(get-info :reason-unknown)`、
  `(echo "@@stats")(get-info :all-statistics)` を足す。
- `interpret()` が出力を `@@` の印で分け、S 式として読んで `status` / `model` / `unsatCore` / `reasonUnknown` / `stats` /
  `errors` にする。エラーの行番号は、足した前置きの行数だけ戻す。`unknown` で理由が `timeout` か `canceled` なら
  `status` は `timeout`。
- 入力にエラーがあれば `status` は `error`(`sat` と出ていても)。

## WASM 版の作り(`lib/z3-wasm.ts`)

- `init()` が `{ Z3, em, Context }` を返す。`Z3.eval_smtlib2_string(ctx.ptr, script)` は、スクリプトを丸ごと実行して
  `z3 -in` が出力するものを文字列で返す。この呼び出しは **Context に状態が残る**ので、そのまま常駐セッションの土台になる
  (詳しくは [sessions.md](sessions.md))。
- `solve()` は呼び出しごとに新しい Context を作り、終わったら `Z3.del_context` で捨てる(下の「メモリの罠」)。
- 止まらないときは `killThreads(em)`(`em` は `init()` が返したもの)でワーカースレッドを止める。これは WASM
  インスタンス全体を落とすので、次の呼び出しで作り直す。

### メモリの罠(11/26 に見つけて直した)

- **症状**: 同じプロセスで WASM の `solve` を約 80 回呼ぶと、`Aborted(Cannot enlarge memory arrays to size
  2163212288 bytes (OOM)...)` で落ち、`status: "error"` になる。`compare-backends` の 1 回だけ、
  `sudoku-unique.smt2` が error になったのが最初の手がかりだった(メッセージは取れていなかった)。
- **原因**: WASM のヒープは約 2 GB で固定(増やせない)。高水準 API の `Context` は、GC のファイナライザからしか
  `del_context` を呼ばないので、使い終わった Context が残り続けた。1 回あたり約 10 MB。
- **確かめ方**: 数独を繰り返し解くループで `process.memoryUsage().rss` を 20 回ごとに出した。メモリは右肩上がりで、約 80 回で
  落ちた。`Bun.gc(true)` を挟んでも増え方はほぼ変わらなかった(GC に任せても解放されない)。
- **直し方**: 呼び出しの終わりに `Z3.del_context(ctx.ptr)` を明示的に呼ぶ。直後は 100 回で約 270 MB のまま横ばい。
  300 回、GC を強制しても落ちなかった(あとから来るファイナライザの 2 回目の削除は、実際には無害だった)。

## 測った比較(Windows。`experiments/compare-backends.ts`、3 回の中央値、ミリ秒)

| 問題 | exe | wasm |
|---|---:|---:|
| `dimacs/pigeonhole-4-3.cnf`(unsat) | 81 | 23 |
| `nqueens4.smt2` | 93 | 42 |
| `unsat-core.smt2` | 79 | 12 |
| `sudoku/sudoku.smt2` | 140 | 326 |
| `sudoku/sudoku-unique.smt2` | 159 | 434 |
| 12 クイーン | 151 | 366 |
| 16 クイーン | 403 | 1590 |
| 24 クイーン | 404 | 1947 |
| ランダム 3-SAT n=150 | 111 | 69 |

- 小さい問題は WASM が速い(exe は大半が**プロセスを起こす時間**)。大きい探索では exe が数倍速い。
  WASM は初回の読み込み(1.0 秒前後)が別にかかる。
- 全 16 問で判定は一致した。版が違っても(5.3.3 と 5.4.1)答えは同じ。
- ランダム 3-SAT は、節と変数の比が約 4.26(解けるか解けないかの境目)で作ってある。n=150 はまだ軽い。
  SATLIB の uf20-91(1000 問)は wasm で全問 sat(28.2 秒)、uuf50-218(1000 問)は全問 unsat(33.0 秒)、uf100-430 は全問 sat(56.2 秒)、uuf100-430 は全問 unsat(49.6 秒。[dimacs.md](dimacs.md) 参照)。uf75〜uf250 と uuf75〜uuf250(各 100 問)は exe で全問一致、uuf200-860 のみ配布が 99 件(dimacs.md)。
