# 環境構築と実験で分かったこと(あとで学ぶためのメモ)

z3-lab を作る過程(連絡帳 #82〜#87、2026-11-26)で出会った落とし穴と、そこから分かったこと。
「何が起きたか → 原因 → どう確かめたか → どう直したか」の順に書く。

## 1. Windows ネイティブで動かすときの癖

| 事象 | 原因と対処 |
|---|---|
| smoke-test で `"sat\r\nunsat"` が `"sat\nunsat"` と一致しない | `z3.exe` は出力が CRLF。**子プロセスの出力を受け取る 1 か所で CRLF を LF にそろえる**(`lib/z3-exe.ts`)。下流は改行を気にしなくてよくなる |
| `Get-Content x.smt2 \| z3lab solve` で `unexpected character`(桁 0, 1, 2) | PowerShell のパイプは UTF-8 の BOM(3 バイト)を付けることがある。z3 は BOM を 3 つの不正な文字として読む。標準入力とファイル入力の先頭の BOM を除く(`stripBom`) |
| `z3lab ... --json \| ConvertFrom-Json` が失敗 | Windows PowerShell 5.1 は複数行のテキストを行の配列で流すので、`Out-String` を挟んで 1 つの文字列にしてから `ConvertFrom-Json` に渡す |
| here-string(`@"..."@`)がエラー | 閉じの `"@` は **行頭**に置く。インデントしない |
| `z3lab.ps1` が実行できない | 実行ポリシー。一度だけ `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `.gitignore` で `lib/` のソースが無視された | tlaplus-lab の `.gitignore` を写したら、そこでは `lib/` が jar の置き場なので無視されていた。z3-lab では `lib/` がソース。`lib/z3/`、`lib/z3.exe`、`lib/z3` だけを無視する |
| z3 のエラーの行番号が、自分の入力の行とずれる | `solve` が前置き(オプション設定など)を足すため。足した行数だけ行番号を戻して報告する(`interpret()`) |

## 2. SMT-LIB と z3 の挙動

- **`solve` が足すもの**: `(check-sat)` と `(get-model)` などを、`(echo "@@印")` で区切って足し、出力を `@@` で分けて
  S 式として読む。入力に自前の `(check-sat)` があれば何も足さず(raw)、`push` / `pop` / `get-value` を自由に使える。
- **終了コードの意味は流儀で逆になる**: z3lab は 0 = sat、10 = unsat。SAT コンペは 10 = SAT、20 = UNSAT。
- **`unsat core` が取れる条件**: `(assert (! F :named n))` で名前を付けた表明だけが対象。名前の無い表明は core に出ない。
  DIMACS の節は名前が無いので、core は空になる。
- **`unsat` のあとの `get-value` / `get-model`** は `model is not available` のエラー。通常の挙動。
- **時間制限**: `(set-option :timeout ミリ秒)` は `check-sat` ごと。`0` は無制限。`unknown` と理由 `timeout` の組を `status: timeout` に
  対応づける。ソフトな制限が効かない場合に備えて、外側にもう 1 つ(プロセス kill、スレッド停止)を置く二重構えにした。
- **答えを信じ切らない**: DIMACS の `sat` は、返された割り当てが全節を満たすかを自分で検査してから返す。
  数独の一意性は「見つけた解を除いて、もう一度解く → `unsat` なら唯一」で確かめる。
- **モデルの書き方で速さが変わる**: 数独は `Int` と `distinct` で素直に書ける(`sudoku.smt2`)。Bool に直すと変数が 729 個になる。
  今回は読みやすさを取った。

## 3. npm の `z3-solver`(WASM)

- **版**: npm は 5.4.1、公式 Windows 版は 5.3.3。版が違っても全 16 問で判定は一致した。
- **`eval_smtlib2_string(ctx.ptr, script)`**: スクリプトを丸ごと実行して、`z3 -in` が出すものを文字列で返す。Context に状態が残るので、
  何度も呼べばセッションになる。
- **`unsat core` は配列ではない**: 高水準 API では `AstVector`(`length()` と `get(i)`)で返る。
- **終了**: `init()` が返す `em` を `killThreads(em)` に渡す。渡さないと、ワーカースレッドが残ってプロセスが終わらないことがある。CLI は終了前に `solver.dispose()` を呼ぶ。
- **ヒープは 2 GB 固定、Context は GC 任せで解放される**: 約 80 回の呼び出しで OOM。呼び出しのたびに
  `Z3.del_context` で明示的に解放して直した(詳しくは [backends.md](backends.md))。
- **起動のコスト**: 初回の読み込みは約 1 秒。小さい問題では exe の「プロセスを起こす約 80 ms」より速いが、大きい探索は数倍遅い。

## 4. 常駐プロセスを作るときの注意(セッション)

- 子プロセスに 1 要求ずつ流すなら、**応答の終わりを示す印**が要る。`(echo "@@END<n>")` を送り、その行まで読む。
- 印を送る前に **括弧の対応を検査する**。閉じていない入力は印を飲み込んで、読み手が永遠に待つ。
- 止められなかったときの策が要る。要求ごとに時計(上限 + 5 秒)を持ち、超えたらプロセスを kill して「状態が消えた」と返す。
- 閉じたものを **黙って作り直さない**。`closed: true` や「自動クローズされた」と理由つきで返し、呼び出し側に状態が消えたことを伝える。
- 子プロセスのコードは起動時のまま。**コードを直したら開いているセッションを閉じて開き直す**。

## 5. 再現しにくい不具合の追い方

1. 最初の 1 回の失敗は、**エラーメッセージを捕まえる**ことから。`compare-backends` に `note:` 行(エラーメッセージ)を出すようにした。
2. 仮説(メモリ増加か、一時的なエラーか)を、繰り返し実行するループ(同じ問題を数百回)と `rss` の表示で切り分ける。
   メモリが右肩上がりなら「解放されていない」が有力。
3. `Bun.gc(true)` を挟んで、GC に任せれば直るのかを試す(今回は直らなかった)。
4. 直したら、**同じ負荷で再度回して** 平らになることを確認する(約 270 MB で横ばい)。

## 6. 作業環境(Claude と PC のあいだ)

- Claude が動くコンテナと PC は別。PC への書き込みは `device_commit_files`。**書いた直後は古い内容が残ることがある**ので、
  数十秒待ってから書き、あとでサイズや時刻で確かめる(`device_list_dir` の値が PC 側の事実)。
- `local-mcp-server` のツールのスキーマ(引数)は起動時にだけ読まれる。引数を足したら Claude Desktop を終了(トレイから)して起動し直す。
  z3-lab 側のコードは、呼び出しごとに bun の子プロセスが起動するので、次の呼び出しから新しい。
- テストはまずコンテナ(Linux)で全部通し、そのあと Windows で通す。Windows 固有の癖(1 章)は後から出る。

## 7. 実験の一覧

| 実験 | 場所 | 分かったこと |
|---|---|---|
| 4 クイーン、数独、一意性 | `examples/`、`examples/sudoku/` | 数独の解は唯一(2 回目の解きで `unsat`) |
| npm `z3-solver` が bun / Node で動くか | `experiments/probe-z3-solver.mjs` | 10 項目すべて通る(Windows と Linux、bun と Node) |
| exe と wasm の比較 | `experiments/compare-backends.ts` | [backends.md](backends.md) の表。判定は全問一致、時間は問題の大きさで逆転する |
| DIMACS | `examples/dimacs/`、ランダム 3-SAT | [dimacs.md](dimacs.md) |
| 数独の数え上げ | `examples/sudoku/enumerate.ts` | セッションで約 6〜11 倍速い([sessions.md](sessions.md)) |
| 6×6 クイーンのマス別の可否 | `z3` ツールの `open` / `run` | 置けるマスは 4 つの解の和と一致 |

## 8. 次に試せること

- SATLIB の公開ベンチマーク(uf20 など)を解かせる。
- 名前付きの式から問題を組む入口(見送り中。必要になったら具体例から設計する)。
- 最適化(`Optimize`)や Tactic を使う実験。`probe-z3-solver.mjs` では WASM 側で動くことまで確認済み。
