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
DIMACS 入力では `model` の代わりに `dimacs`(`variables`、`clauses`、`assignment`)が付き、`unsatCore` は付かない。
終了コード: 0 sat、10 unsat、11 unknown、12 timeout、1 error、2 使い方の誤り。

タイムアウトは z3 の `-T:` と、その 5 秒後のプロセス kill の二重。

### もっと詳しく(`docs/`)

| 文書 | 内容 |
|---|---|
| [docs/backends.md](docs/backends.md) | exe と wasm の違い、WASM のメモリの罠、測った比較表 |
| [docs/dimacs.md](docs/dimacs.md) | DIMACS CNF の取り込み(`.cnf` は拡張子で判定、`--dimacs` で標準入力)。出力の形と終了コードの違い |
| [docs/sessions.md](docs/sessions.md) | 常駐セッション(`z3lab session`、ライブラリ、MCP の `open` / `run` / `close`)。作りと約束、実験の結果 |
| [docs/examples.md](docs/examples.md) | `examples/` と `experiments/` の一覧と使い方 |
| [docs/learnings.md](docs/learnings.md) | 環境構築と実験で分かったこと(Windows の癖、z3 / WASM の挙動、不具合の追い方) |

**短く**: バックエンドは `--backend exe`(既定。速い)か `wasm`(npm の z3-solver。小さい問題で速く、大きい問題で遅い)。
DIMACS は `z3lab solve x.cnf` で `s SATISFIABLE` / `v ... 0`(終了コードは z3lab のまま)。
常駐セッションは `z3lab session`(JSON 行)で、宣言・表明・`push` / `pop` を呼び出しをまたいで保つ。

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

## サンプルと実験

`examples/`(SMT-LIB、DIMACS、数独)と `experiments/`(WASM の確認、バックエンドの比較)の一覧と使い方は
[docs/examples.md](docs/examples.md)。まず試すなら:

```powershell
z3lab solve examples\sat-basic.smt2
z3lab solve examples\dimacs\small-sat.cnf
.\examples\sudoku\sudoku.ps1                 # 数独を解いて、解が唯一かを調べる
.\examples\sudoku\enumerate.ps1              # 数独の解を全部数える(常駐セッション)
bun experiments\compare-backends.ts           # exe と wasm の比較
```

## 構成と今後

- `lib/solver.ts` … CLI と MCP が知っている薄い `Solver` インターフェース
- `lib/smtlib.ts` … 両バックエンド共通。スクリプトの組み立て(`check-sat` などを足す)と、z3 の出力から `SolveResult` への変換
- `lib/z3-exe.ts` … バックエンド 1(z3 実行ファイルを子プロセスで)
- `lib/z3-wasm.ts` … バックエンド 2(npm の `z3-solver`、WASM)
- `lib/index.ts` … `makeSolver("exe" | "wasm")`
- `docs/` … 詳しい説明と学んだことのメモ
- `lib/session.ts` … 常駐セッションのインターフェースと共通の部品。実装は各バックエンドの `openSession`
- `lib/dimacs.ts` … DIMACS のパーサと SMT-LIB への変換、`solveDimacs`
- 保留: 名前付きの式から組む入口
