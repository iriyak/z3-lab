# z3-lab

Z3(SMT ソルバ)を手軽に試すための足場。SAT 問題は Z3 の Bool だけで扱える。
`z3` の実行ファイルを CLI と MCP ツールの両方から同じ形で呼べるようにしたもの。bun + z3 だけで動き、
**Windows ネイティブ(Documents 配下など)を基本**にする(WSL2 は必要になるまで使わない)。
[tlaplus-lab](https://github.com/iriyak/tlaplus-lab) と同じ流儀。経緯と方針は連絡帳 #82(channel z3)。

## セットアップ(Windows / PowerShell)

必要なもの: bun。z3 は下のスクリプトで取得する。

```powershell
cd $HOME\Documents\z3-lab
bun install                            # MCP 用の依存(CLI だけなら不要)
.\scripts\get-z3.ps1                   # 公式 Windows 版 z3 を lib\z3 に展開(bin\z3.exe)
$env:Path += ";$PWD\bin"               # 恒久化するなら環境変数 Path に bin を追加
z3lab version
z3lab solve examples\sat-basic.smt2
```

z3 の場所は `Z3_EXE` > `lib\z3\bin\z3.exe` > `lib\z3.exe` > PATH の順で探す。
`z3lab.ps1` が「スクリプトの実行が無効」と拒否されたら、一度だけ
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行する。

## CLI: `bin/z3lab`(実体は `bin/z3lab.ts`。PowerShell は `z3lab.ps1`、WSL2/Linux は `z3lab`)

| コマンド | 内容 |
|---|---|
| `z3lab version` | z3 のバージョン |
| `z3lab solve [--json] [--timeout 秒] [--memory MB] [--stats] [--backend exe\|wasm] [--raw] [--dimacs] [File.smt2 \| File.cnf \| -]` | SMT-LIB 2 を解く。ファイル省略か `-` で標準入力。`.cnf` か `--dimacs` なら DIMACS CNF として読む |
| `z3lab session [--backend exe\|wasm] [--timeout 秒] [--memory MB]` | 常駐セッション。標準入力に 1 行 1 個の JSON を送ると、1 行の JSON で答える(下の節) |
| `z3lab put Name.smt2` | 標準入力を `work/` に保存 |

`solve` は入力に `(check-sat)` を **足す**(続けて `get-model` / `get-unsat-core` / `reason-unknown`)。
入力に自分の `(check-sat)` があるか `--raw` を付けると、スクリプトをそのまま実行して z3 の出力を `output` に返す
(`push` / `pop` や `get-value` を使う実験向き)。

`--json` の出力: `status`(`sat` / `unsat` / `unknown` / `timeout` / `error`)、`model`(定数 → 値)、
`functions`(引数付きの `define-fun`)、`unsatCore`(`(! F :named n)` で名前を付けた表明のみ)、
`reasonUnknown`、`errors`、`stats`(`--stats` のとき)、`elapsedMs`。
DIMACS 入力では `model` の代わりに `dimacs`(`variables`、`clauses`、`assignment`)が付く。
終了コード: 0 sat、10 unsat、11 unknown、12 timeout、1 error、2 使い方の誤り。

タイムアウトは z3 の `-T:` と、その 5 秒後のプロセス kill の二重。

### DIMACS CNF の取り込み

SAT ソルバの標準形式(`c` コメント、`p cnf <変数> <節>`、1 節が `0` で終わる整数列)をそのまま読める。
変数 `N` は Bool 定数 `vN` になり、節は `(assert (or ...))` に変換して解く(`lib/dimacs.ts`)。

```powershell
z3lab solve examples\dimacs\small-sat.cnf
Get-Content examples\dimacs\pigeonhole-4-3.cnf | z3lab solve --dimacs -
```

テキスト出力は SAT ソルバの流儀(`s SATISFIABLE` / `s UNSATISFIABLE`、割り当ては `v 1 -2 3 0`)。
`--json` では通常の結果に `dimacs.assignment` が付く。**終了コードは z3lab のまま**(sat 0、unsat 10)で、
SAT コンペ式の 10 = SAT、20 = UNSAT とは違うので注意。SATLIB の末尾 `%` にも対応。
形式の誤り(ヘッダなし、節の数の不一致、範囲外のリテラル、末尾の `0` 抜け)は `error` になる。
sat のときは、割り当てが全節を満たすかを検査してから出す。

### 常駐セッション(`z3lab session`)

`solve` は 1 回ごとに状態が消える。`session` は 1 つのソルバを起動したままにして、宣言・表明・`push` / `pop` の段を
呼び出しをまたいで保つ。標準入力の 1 行が 1 つの要求、標準出力の 1 行が 1 つの答え(JSON 行)。

```text
→ (起動) {"ready":true,"backend":"z3-exe","version":"..."}
← {"script":"(declare-const x Int)(push)(assert (> x 3))(check-sat)(get-value (x))"}
→ {"output":"sat\n((x 4))\n","verdicts":["sat"],"errors":[],"elapsedMs":8}
← {"script":"(assert (< x 2))(check-sat)(pop)(check-sat)","timeoutSec":10}   # この 1 回だけの上限
← {"close":true}                                                                # 標準入力を閉じても終わる
```

- `script` は **そのまま** z3 に渡す(何も足さない)。`(check-sat)` や `(get-value ...)` は自分で書く。`verdicts` は各 `check-sat` の答え。
- 括弧が閉じていない入力は送らずに断る(セッションは生きる)。z3 のエラーは `errors` に `(error "...")` で出る。
- `closed: true` が付いたらセッションは消えている(上限を過ぎて kill、z3 の異常終了)。状態は戻らないので、開き直す。
- exe は `z3 -in` を起動したままにして 1 要求ずつ流す。wasm は 1 つの Context を保つ(上限で止めるときは WASM 全体を落とすので、同じプロセスの wasm セッションがすべて消える)。
- ライブラリからは `solver.openSession()` → `session.run(text)` / `session.close()`(`lib/session.ts`)。
- MCP からは local-mcp-server の `z3` ツール(`open` / `run` / `close` / `sessions`。無操作 10 分で自動クローズ)。この lab 単体の MCP ツールは 1 回完結のまま。

### バックエンド

| `--backend` | 中身 | 特徴 |
|---|---|---|
| `exe`(既定) | 公式の z3 実行ファイルを子プロセスで(`z3 -in`) | 速い。`--memory` が効く。呼び出しごとにプロセスを起こす |
| `wasm` | npm の `z3-solver`(Z3 を WASM にしたもの)をプロセス内で | 初回に読み込み(約 0.3〜0.8 秒)。大きい問題では exe の数倍遅い。`--memory` は効かない。`bun add z3-solver` が必要 |

既定は環境変数 `Z3_BACKEND` でも変えられる。どちらも同じ SMT-LIB スクリプトを受け取り、同じ形の結果を返す
(`lib/smtlib.ts` がスクリプトの組み立てと出力の解釈を共有している)。WASM 版は `Z3.eval_smtlib2_string` に
スクリプトを丸ごと渡す。時間制限は `(set-option :timeout)` で、効かなかったときのために 5 秒後に
ワーカースレッドを止める。

## MCP ツール: `z3`

`mcp/z3-tool.ts` が `registerZ3Tool(server)` を export している。local-mcp-server に入れるときは
この 1 ファイルをコピーして登録する(tlc と同じやり方)。単体確認は:

```sh
bun run mcp/server.ts          # stdio。MCP Inspector から接続できる
bun run mcp/smoke-test.ts      # 一通りの動作確認(1 バックエンドあたり 17 件。セッションと数独の数え上げを含む)
```

引数: `action`(`version` / `solve`)、`source`(SMT-LIB 2 のインライン)、`spec`(lab 内のパス。`.cnf` も可)、
`dimacs`(DIMACS CNF の本文)のどれか 1 つ、`raw`、`stats`、`timeoutSec`、`memoryMb`。環境変数: `Z3_LAB`(lab のフォルダ。既定 `<ホーム>/z3-lab`。
Documents に置いたなら必ず指定)、`Z3_EXE`。

## サンプル(`examples/`)

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

## 実験(`experiments/`)

| ファイル | 内容 |
|---|---|
| `probe-z3-solver.mjs` | npm の `z3-solver` が bun / Node で動くかの 10 項目の確認(`bun` でも `node` でも実行できる) |
| `compare-backends.ts` | 2 つのバックエンドに同じ問題(`examples/` の全 `.smt2` / `.cnf` と、生成した N クイーンとランダム 3-SAT)を解かせ、判定が一致するか・時間を比べる。`bun experiments\compare-backends.ts [--repeat N] [--timeout 秒]` |

## 構成と今後

- `lib/solver.ts` … CLI と MCP が知っている薄い `Solver` インターフェース
- `lib/smtlib.ts` … 両バックエンド共通。スクリプトの組み立て(`check-sat` などを足す)と、z3 の出力から `SolveResult` への変換
- `lib/z3-exe.ts` … バックエンド 1(z3 実行ファイルを子プロセスで)
- `lib/z3-wasm.ts` … バックエンド 2(npm の `z3-solver`、WASM)
- `lib/index.ts` … `makeSolver("exe" | "wasm")`
- `lib/session.ts` … 常駐セッションのインターフェースと共通の部品。実装は各バックエンドの `openSession`
- `lib/dimacs.ts` … DIMACS のパーサと SMT-LIB への変換、`solveDimacs`
- 保留: 名前付きの式から組む入口
