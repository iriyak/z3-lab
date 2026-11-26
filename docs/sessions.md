# 常駐セッション

`solve` は 1 回ごとにソルバを作り直すので、宣言・表明・`push` / `pop` の状態は残らない。
**セッション**は 1 つのソルバを起動したままにして、状態を呼び出しをまたいで保つ。
「制約を足して解き、戻してまた解く」「見つけた解を除いて次の解を探す」といった使い方のため。

## 3 つの入口

| 入口 | 内容 |
|---|---|
| ライブラリ | `solver.openSession({ timeoutSec })` → `session.run(text)` → `session.close()`(`lib/session.ts`)。`run` は z3 の出力 `output`、各 `check-sat` の答え `verdicts`、`errors`、`elapsedMs` を返す |
| CLI `z3lab session` | 標準入力 1 行 = 1 要求(JSON)、標準出力 1 行 = 1 答え(JSON) |
| MCP(local-mcp-server の `z3` ツール) | `open` / `run` / `close` / `sessions`。サーバーが `z3lab session` の子プロセスを 1 つずつ持つ |

### CLI のやりとり

```text
→ {"ready":true,"backend":"z3-exe","version":"..."}
← {"script":"(declare-const x Int)(push)(assert (> x 3))(check-sat)(get-value (x))"}
→ {"output":"sat\n((x 4))\n","verdicts":["sat"],"errors":[],"elapsedMs":8}
← {"script":"(assert (< x 2))(check-sat)(pop)(check-sat)","timeoutSec":10}   # この 1 回だけの上限
← {"close":true}                                                                # 標準入力を閉じても終わる
```

`script` は **そのまま** z3 に渡す。`solve` と違って何も足さないので、`(check-sat)` や `(get-value (x y))` は自分で書く。

## 作りと約束

- **exe**: `z3 -in` を起動したままにする。`run` は、スクリプトのあとに `(echo "@@END<n>")` を送り、標準出力をその印まで読む。
  呼び出しは直列(前の run が終わるまで次を待たせる)。
- **wasm**: 1 つの `Context` を保ち、`eval_smtlib2_string` を繰り返し呼ぶ(状態は Context に残る)。
- **括弧が閉じていない入力は、送る前に断る**(`errors` に理由。セッションは生きる)。exe では、閉じていないと
  終わりの印が式の途中に飲み込まれて、永遠に待つことになるため。wasm でも、途中で切れた命令を残さないよう同じ検査をする。
- **上限**: `check-sat` ごとの上限は `(set-option :timeout)`。それとは別に、1 回の `run` の上限(既定は開くときの
  `timeoutSec`)+ 5 秒で z3 を止める。止めたらセッションは消え、答えに `closed: true` が付く。**状態は戻らない**。
  exe はプロセスを kill、wasm は WASM 全体を落とす(同じプロセスの wasm セッションがすべて消える)。
- エラーは `errors` に `(error "...")` の形で入る。wasm のエラーの桁位置は、セッション全体で通算になる
  (`line 1 column 126` のように、前の呼び出しの文字数も数えられる)。
- `check-sat` が `unsat` のあとの `get-value` / `get-model` は `model is not available` のエラーになる。z3 の通常の挙動で、
  数え上げのループでは「`unsat` で終わる」合図として利用できる。

## MCP 側(local-mcp-server の `src/z3.ts`)

- 無操作で自動クローズ(`Z3_SESSION_IDLE_SEC`、既定 600 秒)。同時に開けるのは `Z3_SESSION_MAX`(既定 4)個。
- 閉じたセッションに `run` すると、理由(自動クローズ、要求で閉じた、プロセス終了)つきで断る。**黙って作り直さない**
  (状態が消えたことを呼び出し側が知る必要があるため)。
- **z3-lab のコードを直したら、開いているセッションには反映されない**(子プロセスは起動時のコードのまま)。
  `solve` は呼び出しごとにプロセスを起こすので、直した次の呼び出しから新しい。セッションは閉じて開き直す。
  MCP ツールのスキーマ(引数)を変えたときは Claude Desktop の再起動が要る。

## 実験の結果

- **数独の解の数え上げ**(`examples/sudoku/enumerate.ts`): 解が 33 個ある盤面で、見つけた解を除く節を足しては解き直し、
  `unsat` で終わる。1 つのセッションで 525 ms(Windows)、セッションなしで毎回全部を解き直すと 5659 ms(約 11 倍)。
  コンテナでは 299 ms と 1913 ms(約 6 倍)。wasm のセッションは 1825 ms(コンテナ)で、この問題では exe のほうが速い。
- **6×6 クイーンの「このマスに置けるか」**(Claude Desktop から `z3` ツールで): 制約を 1 回送り、36 マスを
  `(push)(assert (= qR C))(check-sat)(pop)` で問う。6×6 の解は 4 つ(`246135`、`362514`、`415263`、`531642`)で、置けるマスは
  その 4 解に現れる列の和と一致した。最後に `q1 = 2` を固定すると解は `246135` だけで、それを除くと `unsat`(解が唯一)。
