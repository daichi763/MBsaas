# 運用手順書

Field OS の開発・リリース・障害対応の手順です。初めて担当する人（社外の開発会社を含む）が、この資料だけで作業を始められるように書いています。
全体の構成は [architecture.md](architecture.md)、用語は [glossary.md](glossary.md) を先に読んでください。`ファイル:行` の行番号は、[architecture.md](architecture.md) の冒頭に書いたコミットのものです。

**本番に触る作業には印を付けています: 🔴 本番**。印のある手順は、Cloudflare のアカウントの権限が要り、取り消せないものもあります。手順どおりに、1人で急がずに行ってください。

| 章 | 内容 |
|---|---|
| 1 | ローカル開発 |
| 2 | テスト |
| 3 | 本番リリース |
| 4 | 戻し方・復元 |
| 5 | ログの見方 |
| 6 | 障害時の初動 |
| 7 | シークレットの登録と入れ替え |
| 8 | データの定期削除（retention）と解約企業のデータ |
| 9 | 開発の決まり（テーブル・定期処理・画面を足すとき） |
| 10 | ローンチ当日のチェックリスト |

自動バックアップの仕組みと設定は [backup.md](backup.md)、障害の記録と通知の仕組みと設定は [monitoring.md](monitoring.md) にあります。

---

## 1. ローカル開発

### 1.1 用意するもの
- Node.js と npm（開発では Node.js 24 で確かめています）。
- Git。Windows では Git Bash（`bash scripts/setup-test-db.sh` を動かすため）。
- Cloudflare のアカウントは**ローカル開発には要りません**。D1・R2 は `wrangler dev --local` が手元に再現します（保存先は `.wrangler/state/`）。

### 1.2 初めての準備

```bash
git clone https://github.com/daichi763/MBsaas.git
cd MBsaas
npm ci                      # package-lock.json どおりに入れる
npm run db:reset:local      # ローカルの D1 を作り直す（マイグレーションをすべて適用 → seed.sql のデモデータ）
```

`db:reset:local` は `scripts/reset-local-db.mjs` で、`.wrangler/state/v3/d1` を消してから作り直します（`--local` だけを使い、本番には接続しません）。
デモデータの日付を今日に合わせたいときは、先に `node scripts/gen_seed.cjs` で `seed.sql` を作り直します。

### 1.3 起動

```bash
npm run build                                   # CSS（Tailwind）→ dist/_worker.js と静的ファイル
npx wrangler dev --local --port 8787            # http://localhost:8787/login
```

- `npm run dev`（vite の開発サーバー）でも動きますが、本番と同じ形（`dist/_worker.js`・Workers Assets・cron）で確かめるときは上のように `wrangler dev` を使います。
- `src/input.css` や画面の Tailwind のクラスを変えたら `npm run build:css` で `public/static/style.css` を作り直します（`style.css` は生成物ですが repo に入れています）。
- 定期処理を試すときは `--test-scheduled` を付けて起動し、`http://localhost:8787/__scheduled?cron=0+18+*+*+*` を開きます（式は [architecture.md](architecture.md) の5章）。
- ローカルの環境変数は `wrangler.jsonc` のトップレベルの `vars`（メールを送らない・定期削除は dry-run・デモの案内を出す）です。一時的に変えるときは `--var 名前:値` を付けます。シークレットを手元で試すときは `.dev.vars`（`.gitignore` 済み）に書きます。

### 1.4 デモアカウント（ローカルだけ。パスワードはすべて `pass1234`）

| 役割 | 会社コード | ID | 画面 |
|---|---|---|---|
| スタッフ | `sample` | `st001`〜`st020` | `/staff` |
| 会社管理者 | `sample` | `admin` | `/admin` |
| 現場管理者 / 営業管理者 | `sample` | `mgr01` / `sales01` | `/admin` |
| 本部 | （空欄） | `hq` | `/hq` |

`seed.sql` は本番には入れません。本番のログイン画面にデモの案内が出ないことは `DEMO_MODE`（本番は `false`）で決まります（`src/index.tsx:317`）。

### 1.5 型チェックとビルド

```bash
npm run typecheck     # tsc --noEmit -p .（型チェックだけ）
npm run build         # 型チェック → CSS → vite build → scripts/ci-wrangler-config.mjs（型のエラーがあると止まる）
```

- `vite build` は型を確かめないので、`npm run build` の最初に型チェックを入れています（Sprint 21。#9944）。Workers Builds のビルドも `npm run build` なので、型のエラーがあると本番にデプロイされません。
- CI（環境変数 `CI` か `WORKERS_CI`）でないときは、`scripts/ci-wrangler-config.mjs` は何もしません。手元に `wrangler.json`（本番の設定）が残っていると注意を出します。`wrangler dev` が本番の設定を先に読むので、消してから動かします（`CI=true` を付けたまま `npm run build` すると作られます。3.2 の 3）。

### 1.6 Windows での注意
- 作業用のフォルダを Windows の Temp に置くと、しばらく触っていないファイルが自動で消えることがあります。`git status` で追跡しているファイルが消えていたら `git checkout -- .` で戻し、`node_modules` がなければ `npm ci` します。
- `wrangler dev` を止めたつもりでも、子の `workerd` が残ってポートをふさぐことがあります。残ったときは、そのポートで動いている `node.exe` と `workerd.exe` だけを止めます（ほかのポートのものは止めない）。

---

## 2. テスト

### 2.1 まとめて流す（`npm test`）

```bash
npm test                          # すべて（約100本）
npm test -- w12-shift w3-board    # ファイル名に含まれる文字で絞る
npm test -- --reuse-db            # 前回のテスト用 D1 を使い回す（マイグレーションを足したときは使わない）
npm test -- --no-build            # ビルドを省く
npm test -- --no-retry            # 落ちたテストを流し直さない
```

`scripts/run-tests.mjs` の流れ（`scripts/run-tests.mjs:3`〜`5`）:
1. `npm run build`。
2. テスト用のローカル D1 を1回だけ作る（`scripts/setup-test-db.sh`。0001〜0026 → `seed.sql` → 0027 以降の順に適用し、既存のデータに後のマイグレーションを当てる本番の状況を再現する）。
3. テストのファイルごとに、その D1 を複製して `wrangler dev --local` を起動し、テストを流してサーバーを止める。起動のオプションはテストの先頭のコメントから読む（2.4。`scripts/run-tests.mjs:70`）。`// run-tests:` の行が複数あるテストは、同じ DB の写しで上から順に起動し直して流す（`scripts/run-tests.mjs:201`）。
4. 落ちたテストは、新しい DB の写しでもう1回だけ流す。2回目で通ったものは結果に「PASS（再試行で合格）」と分けて出す（`scripts/run-tests.mjs:180`）。2回とも落ちたものが FAIL です。

環境変数: `TEST_DB_DIR`（テスト用 D1 の置き場所。既定は OS の一時フォルダの `mbsaas-test-<作業フォルダごとの記号>`）、`TEST_PORT`（既定 8899。2本目の枠は +50 から探す。使われていれば次の空いている番号）、`TEST_MAX_SERVERS`（この機械で同時に動かすテスト用サーバーの数。既定 2。0 で制限なし）、`TEST_TIMEOUT_MIN`（1本の上限。既定 90 分）。テストは本番に接続しません。

作業フォルダの `.dev.vars`・`.env`（`wrangler dev` が読む）に `RESEND_API_KEY` を書いたままだと、`npm test` は始めずに止まります。テストは鍵が無い前提（送ると「送信失敗（mail_not_configured）」）で `MAIL_ENABLED:true` の回があるので、鍵があるとテストのメールが Resend から実際に送られるためです。手元でメールを試したあとは、鍵の行を消してから `npm test` を流します。

**機械が混んでいるとき**（Sprint 26。#9980）: 作業フォルダを分けて何本も同時に `npm test` を流すと、ECONNRESET・`wrangler d1 execute` の「internal error」・作業フォルダの EPERM でテストが途中で止まっていました（アプリの不具合ではない）。今は次のようにしています。
- テスト用 D1 の置き場所を作業フォルダごとに分け、同じ置き場所を2つの `npm test` で使わない（ロック）。ポートが使われていれば別の番号にし、止めたサーバーのポートが空くまで待ってから次へ進む。
- この機械のすべての `npm test` を合わせて、テスト用サーバーを `TEST_MAX_SERVERS` 本までにする（空くまで待つ。印は OS の一時フォルダの `mbsaas-test-slots`）。
- 各テストは `scripts/lib/test-preload.mjs` を読み込んで起動する。開発サーバーが閉じた接続を使い回したときの ECONNRESET・ECONNABORTED は、要求が届いていないので少し待って送り直す（2回まで）。テストが DB を直接読み書きする `wrangler d1 execute --local` が、開発サーバーと同じファイルを取り合って「internal error」・database is locked・EBUSY・EPERM になったときは、少し待ってやり直す（3回まで。1回の実行は1つのトランザクションなので、失敗した回は何も書いていない）。やり直したときは「（再試行）」と出る。原因を調べるときは `TEST_RETRY=0` でやめられる。
- DB の写しを消すときの EPERM・EBUSY（止めた直後の workerd がファイルを持っている）は待ってやり直し、消せなければ次の `npm test` で消す。
- テスト用 D1 を作る `scripts/setup-test-db.sh` も、`wrangler d1 execute` が途中で落ちたとき（機械のメモリが足りないときの「out of memory」など）は、少し待って3回までやり直す（失敗した回は何も書いていない）。3回とも落ちたときは wrangler の出力の最後を出して止まる。機械のメモリ（コミット）が足りないと、テストのサーバーやヘッドレス Chrome も落ちるので、ほかの重いアプリを閉じるか、同時に流す `npm test` を減らす。

### 2.2 以前の既知の失敗（Sprint 26 で直した）

Sprint 25 までは次の3本が `npm test` で必ず落ちていました（[decisions.md](decisions.md) の D-33）。Sprint 26（#9980）で、テストの道具の側を直して `npm test` で通るようにしました。今は、いつも落ちるテストはありません。

| テスト | 落ちていた理由 | 直し方 |
|---|---|---|
| `test-history.mjs` | `test-report-settings` → `test-corrections` → `test-notifications` が同じ DB に作ったデータを前提にしているが、`npm test` はテストごとに DB を作り直す。また、申請 CSV の確認が「今日の 8:00」の打刻漏れを申請していたので、日本時間の 0〜8 時に流すと「まだ来ていない日時」（400）で落ちていた | 先頭のコメントの `// run-tests:` の4行で、前提のテストから同じ DB で順に流す（`scripts/test-history.mjs:9`〜`13`）。申請する日時は前日の 22:00 にした |
| `test-w4-notifications-mail.mjs` | 先頭のコメントの `<WEBHOOK_SECRET と同じ値>` が起動のオプションとして読み取られ、`<` がシェルのリダイレクトになってサーバーが起動しない | `// run-tests:` の行に、Webhook の秘密の値（テストの既定値）を書いた（`scripts/test-w4-notifications-mail.mjs:9`）。`< >` や日本語を含む値は、起動に使わないようにした |
| `test-notifications.mjs` | 先頭のコメントの `--var MAIL_ENABLED:false（既定）` も読み取られ、後の値でメールが無効のまま起動していた | `// run-tests:` の2行で、メールを有効にした回と `--mail-disabled` の回を同じ DB で順に流す（`scripts/test-notifications.mjs:11`〜`12`）。同じ名前の `--var` が2回あるときは最初の値を使う |

ヘッドレス Chrome を使う画面の確認が、2026-11-12 に CDN の axios を読めずに落ちた件は 2.7 にあります。

### 2.3 1本だけ手で流す

```bash
bash scripts/setup-test-db.sh "<短いパスの保存先>"          # Windows ではパスが長いと失敗する
npm run build
npx wrangler dev --local --port 8810 --persist-to "<保存先>"   # テストの先頭のコメントにある --var・--test-scheduled も付ける
BASE=http://127.0.0.1:8810 PERSIST="<保存先>" node --import ./scripts/fetch-origin.mjs --import ./scripts/lib/test-preload.mjs scripts/test-xxx.mjs   # 書き込みに Origin を付ける（2.4）・混んでいるときのやり直し（2.1）
```

終わったら `wrangler dev` を止めます。

### 2.4 テストの書き方
- `scripts/test-<作業単位>.mjs` に、API を呼んで確かめるテストを書きます。1件ごとに `PASS` / `FAIL` を出し、最後に `n/m passed` を出して、失敗があれば終了コード 1 にします（例: `scripts/test-w12-shift.mjs`）。
- ログインは `POST /api/auth/login` に会社コード・ID・パスワードを送り、`set-cookie` の `session` を次の要求に付けます。サーバーはセッションの Cookie を付けた書き込みに `Origin` を求める（CSRF の対策。#9943）ので、`npm test` は各テストを `node --import ./scripts/fetch-origin.mjs` で起動し、Node の `fetch` の書き込みに宛先と同じ `Origin` を付けます（テストの中で付ける必要はありません）。
- 起動のオプションが要るときは、先頭25行のコメントに `// run-tests: --var 名前:値 --test-scheduled` の行を書きます（`npm test` はこの行があればこの行だけを読む）。1行が1回の起動で、行が複数あれば同じ DB の写しで上から順に流します。別のテストのファイル名（`test-xxx.mjs`）を書くとそのテストを、`--arg 値` を書くとテストに引数を渡して流せます（例: `scripts/test-history.mjs:9`〜`13`、`scripts/test-notifications.mjs:11`〜`12`）。値には英数字と `_ . : / + = @ -` だけを使います（`<` `>` や日本語はシェルに渡せない）。
- `// run-tests:` の行がない前からのテストは、コメントの中の `--var 名前:値` と `--test-scheduled` を読みます（同じ名前は最初の値を使い、使えない文字を含む値は使わない）。
- 画面の確認が要るときは、ヘッドレスの Chrome を使い、Chrome がない環境では省くようにします（`scripts/test-w12-shift.mjs:9`）。Chrome は `scripts/lib/chrome.mjs` の `freePort` と `launchChrome` で起動します（2.7）。

### 2.5 時刻に依存するテスト（いつ流しても通るようにする）

サーバーは「今日」「今の時刻」を日本時間で決めます（`Date.now() + 9 時間`）。テストもいつ流しても通るように、次のように書きます（Sprint 14。#9641）。本番のコード（`src/`）に時刻を差し替える仕組みは足さず、テストの側で合わせます。

- 「今日」は、サーバーと同じく `new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)` で作る。`new Date().toISOString()`（UTC の日付）や端末のタイムゾーンの日付は使わない。
- 「今から○分前に始まったシフト」のように今の時刻から逆算するデータは、日本時間の 0 時を過ぎた直後だと前日のシフトになる。前日になると確かめられないことは、日付を見て `SKIP` にする（例: `scripts/test-w3-dashboard.mjs` の #221・#107）か、日付をずらしたデータ（2日以上前の日付など）を使う。
- 「今日の 05:30」のような決まった時刻は、その時刻より前に流すとまだ来ていない時刻になる。過ぎた日（前日より前）の日付を使う。
- テストを流している途中で日付が変わると、テストの始めに作った「今日」とサーバーの「今日」がずれる。`npm test` は、日本時間の 23:45 を過ぎたら、0 時を過ぎるまで待ってから次のテストを始める（`scripts/run-tests.mjs`）。1本だけ手で流すときは、0 時の前後を避ける。
- 月の初め・終わりにまたがるデータ（前日の日報が今月の集計に入らない、など）は、期待する値を日付から決めるか、同じように `SKIP` にする（例: `scripts/test-w5-report-features.mjs` の #496）。
- 「今日のシフトを1時間前に開始」のように 0 時より前にできないデータは、0 時の直後の数分だけテストの始めで待つ（例: `scripts/test-w8-staff-ui.mjs`）。
- 確かめ方: 開発者の手元で、サーバー（`dist/_worker.js` を読み込む入口）とテストの両方の `Date` を同じだけずらして流すと、0:05・23:58・月の1日などの時刻で試せます（Sprint 14 で使った方法。D1 の SQL の `datetime('now')` はずれないので、SQL の時刻を使う確認は落ちることがある）。この仕組みは repo には入れていません。

### 2.6 PR の CI（GitHub Actions）

`main` あての PR と `main` への push で、GitHub Actions の **CI**（`.github/workflows/ci.yml`）が動きます（Sprint 21。#9944）。本番には接続せず、シークレットも使いません。

1. `npm ci`
2. 型チェック（`npx tsc --noEmit -p .`）
3. `npm run build`（GitHub Actions は `CI=true` なので、Workers Builds と同じく本番の設定の `wrangler.json` を作って確かめる）
4. `npm run docs:check`（生成した資料が今のコードと合っているか）
5. `wrangler.json` を消してから、速いテスト（`npm run test:ci -- --no-build`）

`test:ci`（`package.json` の `scripts`）は、数分で終わり外に接続しないテストだけを選んでいます: `test-w21-release-guard`（CI・ビルドの設定）、`test-w13-docs-arch-ops`（資料の行番号と設定の表）、`test-w3-security`（セッション・CSP・機微情報の権限）、`test-w1-tenant-guard`（会社をまたぐアクセス）、`test-w1-xss-escape`（画面の文字の扱い）。手元でも `npm run test:ci` で同じものを流せます。`test-w1-auth-session` は、ローカルの D1 を直接書き換える確認の途中でサーバーとの接続が切れて落ちることがある（Windows で5回に2回）ので、CI には入れていません。全部のテスト（`npm test`。約100本）は CI では流さないので、今までどおり PR の前に手元で流します（2.1）。

テストを足すときは、外に接続しない・数分で終わる・くり返し流しても落ちないものだけを `test:ci` に足します（ヘッドレスの Chrome を使う確認は、Chrome がない CI では省かれます）。

### 2.7 ヘッドレス Chrome と CDN（外のネットワークに頼らない）

画面の CDN のファイル（axios・dayjs・Font Awesome・Chart.js・flatpickr・SortableJS・qrcode-generator・jsQR。`src/index.tsx` の `SRI`）は、テストのヘッドレス Chrome では CDN から読まず、手元の同じ版のファイルで返します（Sprint 26。#9980）。

- `scripts/lib/chrome.mjs` の `launchChrome` が Chrome を起動し、CDP の `Fetch` で `https://cdn.jsdelivr.net/npm/<名前>@<版>/<ファイル>` の要求を横取りして、`node_modules/<名前>/<ファイル>`（`package.json` の版が同じときだけ）を返します。そのため、これらの包みを devDependencies に同じ版で入れています（`npm ci` で入る）。
- jsDelivr がその場で縮めて作る `.min.js`（`qrcode-generator@1.4.4/qrcode.min.js`・`jsqr@1.4.0/dist/jsQR.min.js`）は npm の包みに無いので、CDN から取った写しを `scripts/lib/cdn-min/` に置いています（`/` を `__` にした名前。例: `jsqr@1.4.0__dist__jsQR.min.js`）。
- SRI（`integrity`）は Chrome がそのまま確かめます。返すファイルのハッシュが `src/index.tsx` の `SRI` と合うことは `scripts/test-w26-ops.mjs` で確かめます。CDN の版を上げたときは、`package.json` の devDependencies の版（と `cdn-min` の写し）も合わせます。
- 同じ版が手元に無いときだけ CDN から読みます（最初に1回「（注意）CDN を node_modules で返せないので…」と出る）。`CDN_OFFLINE=0` で横取りをやめられます。
- デバッグ用のポートは `freePort` で空いているものを使います（以前は 9300〜9700 の乱数で、ほかのテスト・開発サーバーと取り合うことがあった）。

**2026-11-12 に CDN が読めなかった件の調べ**（Sprint 26）: ヘッドレス Chrome の画面の確認 8 本が「axios is not defined」で落ち、同じ時に curl では CDN から取れていた。2026-11-13 に調べた結果:
- プロキシ: Windows の設定は使っていない（`ProxyEnable=0`）。環境変数のプロキシも無い。
- 証明書・中身: CDN の axios 1.21.0・dayjs 1.11.10 の sha384 は `src/index.tsx` の値と一致。CDN が別の中身を返していたのではない。
- Chrome の版: 157.0.8103.52。同じ Chrome で、2026-11-13 には CDN から読めた（ヘッドレスで 127.0.0.1 のページから `integrity`・`crossorigin` 付きで読み込み、`axios` と `dayjs` ができた。HTTP/2・IPv6）。
- ネットワーク: 再現しなかったので、原因は特定できていない。Chrome は自分の DNS を使うので、curl と Chrome でつながる先が違うことがある（curl は Fastly の `2a04:4e42::`、Chrome は Cloudflare の `2606:4700::` につながった）。同じ時に機械が混んでいた（fork の失敗・テストの同時実行）ことも分かっている。どちらにしても、テストは CDN に頼らない形にした。
- 本番の利用者の画面は今までどおり CDN から読みます（読めないときは `LIB_FALLBACK` の案内が出る。#409）。

---

## 3. 本番リリース 🔴 本番

本番へのデプロイは、GitHub の `main` へのマージで Workers Builds が自動で行います（[decisions.md](decisions.md) の D-32）。**マイグレーションは自動では適用されない**ので、新しいマイグレーションがあるときは、マージより先に手で本番に適用します。新しい列・テーブルを使うコードが先に出ると、その API が 500 になります。

本番に触るコマンドには、必ず `--env production` を付けます。D1 の `execute`・`export`・`migrations apply` には `--remote` も付けます（wrangler 4 は付けないとローカルに対して動きます）。`d1 time-travel`・`deployments`・`rollback`・`tail`・`secret` は、`--remote` を付けなくても本番に対して動きます。

### 3.1 チェックリスト

| # | 作業 | 本番 |
|---|---|---|
| 0 | PR のテストを確かめる（PR の **CI** が緑（2.6）・手元の `npm test` がすべて合格（「再試行で合格」があれば、そのテストを1本だけ流し直して確かめる）） | |
| 1 | 新しいマイグレーションがあるか確かめる | |
| 2 | 本番 D1 のバックアップを取る（`d1 export`）と、Time Travel の戻し先を控える | 🔴 |
| 3 | バックアップから作った**本番のコピー（ローカル）**でマイグレーションを試し、主な画面が動くか確かめる | |
| 4 | 本番にマイグレーションを適用する（`CI=true`） | 🔴 |
| 5 | PR を `main` にマージする（Workers Builds がデプロイする） | 🔴 |
| 6 | デプロイを確かめる（`wrangler deployments`・ビルドのログ） | 🔴 |
| 7 | 本番の環境変数（`vars`）を確かめる | 🔴 |
| 8 | スモーク（本番の画面を開いて確かめる） | 🔴 |
| 9 | 後片付け（バックアップ・本番のコピーを消す） | |

マイグレーションがないときは 2〜4 を省けます（2 はあっても構いません）。

### 3.2 手順

**1. 新しいマイグレーションがあるか**

```bash
git fetch origin
git diff --name-only origin/main...<マージするブランチ> -- migrations/
```

マイグレーションは「列・テーブルの追加と、安全なデータの移行」だけにする決まりです（9章）。列を消す・型を変える・行を消すものがあれば、リリースを止めて相談します。

**2. バックアップ 🔴**

```bash
# 出力先は必ず repo の外にする（個人情報を含むため）。PowerShell なら "$env:TEMP\..."
npx wrangler d1 export mbsaas-production --remote --env production --output="<repo の外>/backup-before-<番号>.sql"
# 戻し先（ブックマーク）を控える
npx wrangler d1 time-travel info mbsaas-production --env production
```

- バックアップには口座番号・住所・給与などの個人情報が入っています。共有フォルダ・チャット・repo の中に置きません（`.gitignore` で `backup*.sql` を除いていますが、それに頼りません）。
- 自動で毎日取るバックアップの仕組みは [backup.md](backup.md) にあります。

**3. 本番のコピーで試す**

```bash
# コピーの置き場所（repo の外の一時フォルダ）
npx wrangler d1 execute mbsaas-production --local --persist-to "<一時フォルダ>/prodcopy" --file="<バックアップ>.sql"
# CI=true: 確認を聞かずに進める（PowerShell なら $env:CI='true' を先に実行）
CI=true npx wrangler d1 migrations apply mbsaas-production --local --persist-to "<一時フォルダ>/prodcopy"
npm run build
npx wrangler dev --local --port 8790 --persist-to "<一時フォルダ>/prodcopy"
```

- `--local` なので本番には書き込みません。バックアップには適用済みのマイグレーションの記録（`d1_migrations`）も入っているので、新しいマイグレーションだけが当たります。
- 管理者・スタッフ・本部でログインし、ダッシュボード・シフト管理・精算・スタッフ・案件・スタッフアプリのホーム・本部画面を開いて、500 が出ないか、データが消えていないかを確かめます。
- 本番の実データなので、確かめたら 9 で消します。

**4. 本番にマイグレーションを適用する 🔴**

```bash
CI=true npx wrangler d1 migrations apply mbsaas-production --remote --env production
npm run db:migrations:check     # 「未適用のマイグレーションはありません」と出ること（scripts/check-migrations.mjs）
```

`npm run db:migrate:remote` も同じ適用です（`package.json:13`）。`CI=true` は、適用してよいかの確認を聞かずに進めるためのものです。

**5. マージ 🔴**

GitHub で PR を `main` にマージします。Workers Builds が起動し、`npm run build` → `npx wrangler deploy` を行います。

`npm run build` は、型のエラーがあるとき、または本番の設定の `wrangler.json` を作れなかったとき（`env.production` がない・`DEMO_MODE` などが本番の値でない・`preview_urls` が `false` でないなど）に止まり、デプロイされません（`scripts/ci-wrangler-config.mjs`。#9944）。ビルドが失敗したら、ログの「エラー:」の行を見て直し、もう一度マージします。

**6. デプロイの確認 🔴**

```bash
npx wrangler deployments list --env production    # いちばん新しいデプロイの日時が今になっていること
```

Cloudflare のダッシュボードの Workers Builds のビルドのログに、`scripts/ci-wrangler-config.mjs:42` の1行が出ていることを確かめます（本番の設定で `wrangler.json` を作ったという行で、`APP_BASE_URL` と `DEMO_MODE=false` が出ます）。この行がないと、ローカル用の設定（メールを送らない・デモの案内を出す）で本番に出てしまいます。

**7. 環境変数の確認 🔴**

ダッシュボードの Worker `mbsaas` の設定（Variables and Secrets）で、次を確かめます。

| 名前 | 本番の値 |
|---|---|
| `APP_BASE_URL` | 本番の URL（`wrangler.jsonc:86`） |
| `MAIL_ENABLED` | `true` |
| `RETENTION_ENABLED` | `true` |
| `DEMO_MODE` | `false` |

シークレットは `npx wrangler secret list --env production` で名前を確かめます（値は表示されません。7章）。

**8. スモーク 🔴**
- `/login` を開き、デモアカウントの案内が**出ない**こと。
- 管理者でログインし、ダッシュボード・今回変えた画面を開いて、エラーが出ないこと。
- 本部画面の「データ保持・定期処理」の上に、定期処理の警告が出ていないこと。
- Workers Logs（5章）に、デプロイの後の `unhandled_error` が出ていないこと。
- 定期処理を変えたときは、翌朝（日本時間 3:00・3:30 の後）に本部画面で結果を確かめます。

**9. 後片付け**
- 本番のコピー（`<一時フォルダ>/prodcopy`）と、手で取ったバックアップのファイルを消します（自動バックアップがある場合も、手元のファイルは残しません）。

### 3.3 リリースをやめる・戻す
- **デプロイの前に問題が見つかった**: マージしなければ本番のコードは変わりません。マイグレーションだけ適用した状態でも、列・テーブルの追加だけなので今のコードは動きます。
- **デプロイの後に問題が見つかった**: 4章の「コードを前の版に戻す」。

### 3.4 プレビューの URL は使わない
Workers Builds は、PR などの main 以外のブランチをビルドすると、本番とは別の版を作り、「プレビューの URL」（`<ブランチの別名>-mbsaas.saas-2a2.workers.dev`）で開けるようにします。**この版は本番の D1・R2 につながります**（`wrangler.jsonc` の D1・R2 は、トップレベルも `env.production` も本番のもの）。レビュー前のコードで本番のデータを読み書きできてしまうので、プレビューの URL は使いません（[decisions.md](decisions.md) の D-49）。リリースの確認は本番で行います（3.2）。

- `wrangler.jsonc` のトップレベルと `env.production` に `"preview_urls": false` を書いています。この設定の入った版が本番にデプロイされると、プレビューの URL は外から開けなくなります。
- `scripts/ci-wrangler-config.mjs` は、`preview_urls` が `false` でなければ本番のビルドを止めます。この確かめを消さないでください。
- 本番の URL（`https://mbsaas.saas-2a2.workers.dev`）は `workers_dev` で決まり、この設定では止まりません。
- **main 以外のブランチのビルドそのものを止める**（Cloudflare の管理者の権限を持つ人が行う。🔴 本番）: ダッシュボードの **Workers & Pages** → `mbsaas` → **Settings** → **Build** → **Branch control** で、**Builds for non-production branches**（main 以外のブランチのビルド）のチェックを外して保存します。本番（main）のデプロイは変わりません。画面の表記は Cloudflare の変更で変わることがあります。
- プレビューを使いたくなったときは、先にプレビュー用の D1・R2 を作り、main 以外のブランチではそちらを使う設定にしてから、`preview_urls` を見直します。本番の D1・R2 のままプレビューを開けるようにしてはいけません。
- 旧 Cloudflare Pages のプロジェクト `mbsaas`（`mbsaas.pages.dev`）は、2026-11-09 に確かめて、存在しません。

### 3.5 ブランチの保護（CI が通らない PR をマージできないようにする）
PR の CI（2.6）は、落ちても今はマージできます。`main` へのマージがそのまま本番のデプロイになる（D-32）ので、CI が緑でない PR をマージできないように、GitHub の「ブランチの保護」を設定します。**利用者が判断してから設定します**（開発者は GitHub の設定を変えません。10.6）。

設定する人: GitHub の `daichi763/MBsaas` の管理者（Admin）の権限を持つ人。

1. 先に CI を1回動かします（PR を1本作る）。動いたことのない確認は、手順 4 の一覧に出ません。
2. GitHub の repo の **Settings** → **Branches** → **Add branch protection rule**（**Add classic branch protection rule**）を開き、**Branch name pattern** に `main` と入れます。
3. **Require a pull request before merging** にチェックを入れます（`main` に直接 push できなくなり、PR を通す）。レビューの承認を必須にするか（**Require approvals**）は、レビューする人がいるかで決めます。
4. **Require status checks to pass before merging** にチェックを入れ、検索欄で `check`（CI の確認の名前。`.github/workflows/ci.yml` の `jobs` の名前）を選びます。**Require branches to be up to date before merging** は任意です（入れると、マージの前に `main` を取り込み直す手間が増える）。
5. 管理者も例外にしないなら **Do not allow bypassing the above settings** にチェックを入れます。
6. **Allow force pushes** と **Allow deletions** は外したまま（既定）にして、**Create**（**Save changes**）で保存します。
7. 確かめ方: CI が落ちている PR、または CI が終わる前の PR で、マージのボタンが押せないことを確かめます。

- 非公開の repo では、GitHub の無料のプランだとブランチの保護を使えません（GitHub Pro・Team などが要ります）。使えないときは、マージの前に PR の **Checks** が緑であることを人が確かめます（3.1 の 0）。
- 画面の表記は GitHub の変更で変わることがあります（新しい画面では **Rulesets** から同じ設定ができます）。
- ブランチの保護がなくても、Workers Builds のビルド（`npm run build`）は型のエラーと本番の設定の作り忘れで止まります（3.2 の 5）。テストの失敗では止まりません。

---

## 4. 戻し方・復元 🔴 本番

### 4.1 コードを前の版に戻す

```bash
npx wrangler deployments list --env production    # 戻したい版（Version ID）を探す
npx wrangler rollback <Version ID> --env production
```

ダッシュボードの Worker `mbsaas` の Deployments からも戻せます。戻した後、`main` にも戻す変更（revert の PR）を入れます。入れないと、次のマージで問題のある版がまた出ます。
マイグレーションは追加だけなので、前の版のコードは新しい列・テーブルがあっても動きます。

D1 を戻すときは、どちらの方法でも 4.5 の流れ（止める → 戻す時点を決める → 今の状態を残す → 戻す → 確かめる → 知らせる）で行います。

### 4.2 D1 を過去の時点に戻す（Time Travel。まずこれを使う）

```bash
# 今のブックマーク（戻したことを取り消すときの戻し先。必ず控える）
npx wrangler d1 time-travel info mbsaas-production --env production
# 戻したい時点のブックマーク（時刻は Unix 時刻（秒）か RFC3339。UTC で書く: 日本時間 - 9 時間）
npx wrangler d1 time-travel info mbsaas-production --env production --timestamp=2026-11-01T18:00:00Z
# 戻す（どちらか一方を指定。実行すると確認を聞かれる）
npx wrangler d1 time-travel restore mbsaas-production --env production --bookmark=<控えたブックマーク>
npx wrangler d1 time-travel restore mbsaas-production --env production --timestamp=2026-11-01T18:00:00Z
```

- 使えるコマンドは `time-travel info`（`--timestamp`・`--json`）と `time-travel restore`（`--bookmark`・`--timestamp`・`--json`）の2つです（wrangler 4.127.1 の `--help` で確認。Sprint 26）。どちらも `--remote` を付けなくても本番に対して動きます。別の DB に戻す（fork・copy）コマンドはまだ無いので、戻す前の中身を確かめたいときは、4.3 の方法でバックアップをローカルに入れて見ます。
- **DB 全体**がその時点に戻ります（表や行を選べない）。その後に入った勤怠・日報・応募・シフトの変更・ログイン（セッション）も消えます。一部の行だけを戻したいときは 4.3 の「一部の行だけを戻す」を使います。
- restore の出力に、戻す直前の状態のブックマークが出ます。控えておけば、そのブックマークでもう一度 restore して、戻したことを取り消せます（4.5 の 3 で控えたブックマークでも同じ）。
- 戻せる期間: 無料プランは過去7日まで、有料プラン（Workers Paid）は30日まで（`--help` の「within the last 30 days」は有料プランの上限）。それより前は、R2 の毎日のバックアップ（[backup.md](backup.md)）か `d1 export` のファイルから戻します。
- 本番の D1 では試しません。ローカルの D1 には Time Travel が無いので、訓練は 4.3 の方法で行います（4.7）。

### 4.3 バックアップのファイル（`d1 export` の SQL）から戻す

書き出しのファイルは、`PRAGMA defer_foreign_keys=TRUE;` のあと、表ごとに定義（CREATE TABLE）とデータ（INSERT）が並び、索引とトリガーは最後に作られます（4.7 の訓練で確認）。`sqlite_sequence`（AUTOINCREMENT の番号）も入るので、戻した後の新しい行の番号は続きから振られます。

**一部の行だけを戻す**（誤って消した・書き換えた行など。ふつうはこちら）:
1. 3.2 の 3 と同じように、バックアップをローカルの空の D1 に流し込む（`--local --persist-to <空のフォルダ>`）。
2. ローカルで、戻したい行を `SELECT` で確かめ、主キーで突き合わせて `INSERT`（消えた行）/ `UPDATE`（書き換わった行）の SQL を作る（作り方の例: `scripts/restore-drill.mjs` の `repairSql`）。バックアップの後に増えた行は消さない。外部キーの親の表から先に入れる。
3. 作った SQL を、本番の今の DB の写し（3.2 の 3 のローカルのコピー）に流して、行数と中身が思ったとおりになるか確かめる。
4. 本番に流す: `npx wrangler d1 execute mbsaas-production --remote --env production --file=<作った SQL>`。
- 書き換えると別の表が変わるトリガーがあります。`shifts`（日時・担当などの変更で更新日時、欠勤を戻すとキャンセルの記録を消す）、`notices`（対象の表を作り直す）、`daily_reports.manager_comment`（コメントの表に1行足す）、`user_notifications` の INSERT（プッシュの送信待ちに積む）、`staff_profiles` の匿名化・削除（関係する記録を消す）。これらの表を戻すときは、流した後に関係する表も確かめます（`migrations/` の `CREATE TRIGGER`）。
- `daily_reports` を戻したら、日報一覧の件数の控えも消します（5.4 の注意）。

**DB 全体を戻す**（Time Travel で戻せない場合だけ）:
1. 新しい D1 を作る: `npx wrangler d1 create <新しい名前>`。
2. バックアップを流し込む: `npx wrangler d1 execute <新しい名前> --remote --file=<バックアップ>.sql`。今の本番の DB に上書きで流さない（同じ表があるので失敗するか、二重になる）。
3. `wrangler.jsonc` の D1 の `database_id`（と `database_name`）を、トップレベルと `env.production` の両方で新しい DB に変え、マージしてデプロイする。`package.json` の `db:*` のスクリプトと `scripts/check-migrations.mjs:10` も DB の名前を使っているので合わせて直す。
4. バックアップの後に足したマイグレーションだけを当てる（[backup.md](backup.md) の 4-3 の 3）。古い DB は確認が終わるまで消さない。
- 書き出し（`d1 export --remote`）の間は、その DB へのほかの要求が待たされます。利用の少ない時間に行います。

### 4.4 R2 のファイル
入店・退店の写真、履歴書・入社時書類、契約書は R2 にあり、**D1 のバックアップと Time Travel には入りません**。R2 のファイルは**バックアップの対象外**です（[decisions.md](decisions.md) の D-48）。誤って消した・上書きしたファイルは戻せません。詳しくは [backup.md](backup.md) を見てください。

D1 を過去に戻したときの R2 の扱い（写真は戻らない・消えない）:
- **戻した時点より後に撮った写真**は R2 に残りますが、D1 の打刻の記録が消えるので、どの打刻の写真か分からなくなります（本部画面の「勤怠に紐づかない写真」に出る）。**戻した後しばらくは、本部画面で「紐づかない写真」を削除しない**でください。打刻を入れ直すときの確かめに使えます（キーは `attendance/会社/スタッフ/シフト/報告の種類_時刻` なので、会社・スタッフ・シフト・時刻が分かる）。入れ直しが終わり、要らないと決めてから削除します。
- **戻した時点より後に消した写真・書類**（定期削除・退職・解約・本人の削除）は、D1 には記録が戻りますが R2 のファイルはもう無いので、画面では写真・書類が開けません。戻した後の定期削除で記録も消えます。開けない件数は、戻した後に `photo_key` のある行と R2 を突き合わせて数え、利用者に知らせます（4.6）。
- 戻した時点より後にアップロードした履歴書・契約書なども同じく「どこからも参照されないファイル」になります。必要なら管理者に入れ直してもらいます。

### 4.5 D1 を戻すときの流れ

| # | やること | 方法 |
|---|---|---|
| 1 | 書き込みを止める・知らせる | 被害が広がっているときは、本部画面で該当の企業を停止する（全社なら全社）。利用者にはメンテナンスの告知を出す（4.6） |
| 2 | どの時点に戻すかを決める | 誤った操作・デプロイ・マイグレーションの時刻を、操作履歴（`operation_logs`・本部の監査記録）、`wrangler deployments list`、Workers Logs（5.1）で調べ、**その直前**（1分ほど前）にする。後のデータを失う量（その間の打刻・日報の件数）と比べ、Time Travel で全体を戻すか（4.2）、一部の行だけを戻すか（4.3）を決める。戻すと消えるデータの範囲（何時から何時まで）を控える |
| 3 | 戻す前に今の状態を残す | `npx wrangler d1 time-travel info mbsaas-production --env production` のブックマークを控える（取り消すときの戻し先）。加えて `d1 export --remote --env production`（3.2 の 2）か、GitHub の **D1 backup** を手で動かして今の中身を残す（戻した後に、消えた期間のデータを取り出すのに使う） |
| 4 | 戻す | 4.2 か 4.3 |
| 5 | 戻した後に確かめる | (1) 主な表の行数（`SELECT COUNT(*)`）と、戻した時点の前後の最新の行（`MAX(created_at)` など）が思ったとおりか。(2) `d1_migrations` の最後の番号が、デプロイしているコードの必要なマイグレーションまであるか（`npm run db:migrations:check`）。足りなければ当てる。(3) ログイン・打刻・日報・シフト表を本番の画面で開く（スモーク）。(4) 本部画面の「障害」「データ保持・定期処理」に新しい警告がないか。(5) 戻した後に消えたセッションの利用者は、もう一度ログインが要る |
| 6 | R2 の写真・書類の扱い | 4.4 |
| 7 | 消えた期間のデータを入れ直す | 3 で残した今の状態から、消えた期間の打刻・日報などを取り出し、管理者に代理入力をお願いする（または 4.3 の一部の行の戻し方で入れる） |
| 8 | 止めた企業を再開して、知らせる | 4.6 の「終わったとき」の告知 |
| 9 | 記録する | 起きたこと・戻した時点・消えた範囲・入れ直した内容を残す（6章の 10）。3 で書き出したファイルは、作業が終わったら端末から消す（個人情報） |

### 4.6 利用者への告知（文例）

本部画面のお知らせ（重要度「メンテナンス」。掲載終了の日時が必須）と、必要に応じて各社の管理者へのメールで知らせます。

**戻す前**:
> 【メンテナンスのお知らせ】○月○日 ○:○○〜○:○○ ごろ、システムの不具合への対応のため、データを ○月○日 ○:○○ の時点に戻します。作業の間は画面を開けない、または保存できないことがあります。○:○○ 以降に入力された打刻・日報・シフトの変更などは消えるため、作業が終わった後に入れ直しをお願いします（対象の方には個別にご連絡します）。

**終わったとき**:
> 【復旧のお知らせ】○月○日 ○:○○ にメンテナンスが終わりました。データは ○月○日 ○:○○ の時点に戻っています。○:○○〜○:○○ に入力された打刻・日報などは、お手数ですが入れ直してください。この間に撮影した打刻の写真は、システムに残っていますが打刻とのひも付けが外れています（必要な場合はご連絡ください）。もう一度ログインが必要な場合があります。

### 4.7 戻す訓練（ローカル）と記録

`scripts/restore-drill.mjs` で、ローカルのテスト用 DB だけを使って「書き出す → 壊す → 戻す → 行数と中身が元と同じか」を確かめます（本番・mbsaas-stg・本番のバックアップのファイルは使いません。wrangler はすべて `--local`）。

```bash
bash scripts/setup-test-db.sh "<短いパスの保存先>"                 # テスト用 DB（seed のデータ）
node scripts/restore-drill.mjs "<保存先>" --json drill.json      # 保存先の中身は変えない（写しで行う）
```

流れ: (1) すべての表の行数と、行の並びによらない中身のハッシュを控える (2) `wrangler d1 export --local` (3) 日報の半分を消す・打刻の時刻を書き換える・1人分の評価を消す (4) A: 空の D1 に書き出しを流し込み（`d1 execute --local --file`）、全部の表・索引・トリガーが元と同じか (5) B: 戻した D1 から、壊れた D1 に足りない行・違う行を戻す SQL を作って流し、元と同じか。`scripts/test-w26-ops.mjs` でも流しています。

| 日付 | DB | 書き出し | A: 全体を戻す | B: 一部の行を戻す | 結果 |
|---|---|---|---|---|---|
| 2026-11-13 | テスト用 DB（134 表・1,517 行・表と索引とトリガー 401） | 22 秒・1,087 KB・INSERT 1,539 | 57 秒。全部の表の行数・中身・スキーマが一致 | 28 秒。267 文（日報 68 行を足す・打刻 198 行を直す・評価 1 行を足す）。一致 | 成功 |

気づいたこと（2026-11-13）:
- `wrangler d1 export` には `--persist-to` が無く、ローカルの書き出しは設定ファイルの場所の `.wrangler/state` の DB を読みます。訓練のスクリプトは、作業用のフォルダに D1 の設定だけの `wrangler.json` を作り、`--config` で向けています。
- 流し込みは、行数に比例して時間がかかります（ローカルで 1,500 行に約1分）。本番の行数では、書き出し・流し込みとも長くなるので、時間に余裕を見ます（本番で試した時間ではありません）。
- 書き出しの SQL は、索引とトリガーをデータの後に作るので、流し込みの途中でトリガーは動きません。一部の行を戻す SQL は今の DB に流すので、トリガーが動きます（4.3 の注意）。
- 戻したデータが元と同じかは、行数だけでなく中身のハッシュで比べると、書き換えられた行（行数は同じ）も見つけられます。

---

## 5. ログの見方 🔴 本番

障害の記録と通知の仕組み（どこに通知が届くか、何を見張っているか）は [monitoring.md](monitoring.md) にあります。

### 5.1 Workers Logs（本番の console の出力）

本番だけ有効です（`wrangler.jsonc:94`〜`97`）。Cloudflare のダッシュボードで Worker `mbsaas` の Logs（Observability）を開き、文字で検索します。保存される期間はプランによります。

| 探すもの | 検索する文字 | 出す所 |
|---|---|---|
| 予期しないエラー（利用者に参照番号を出したもの） | `unhandled_error`、または参照番号（8文字） | `src/index.tsx:79`〜`85` |
| 定期処理の結果 | `cron <処理名>:`（例 `cron retention:`） | `src/services/cron.ts:76` |
| 定期処理の記録の失敗 | `cron_runs insert failed` | `src/services/cron.ts:92` |
| プッシュ通知の送信の失敗 | `push flush failed` | `src/index.tsx:137` |
| Turnstile の問い合わせの失敗 | `turnstile siteverify failed` | `src/recruit.ts:286` |
| 応募の回数制限の塩がない | `RATE_LIMIT_SALT が未設定` | `src/recruit.ts:378` |
| メールの送信元がテスト用 | `mail warning` | `src/services/email.ts:127` |

予期しないエラーの1行は JSON で、`ref`（参照番号）・`method`・`path`・`company_id`・`user_id`・`role`・`message`・`stack`（6行まで）を持ちます（[architecture.md](architecture.md) の 4.3）。利用者から「参照番号: xxxx」と聞いたら、その文字で検索します。

### 5.2 リアルタイムで見る

```bash
npx wrangler tail --env production --format pretty                  # すべて
npx wrangler tail --env production --format pretty --status error    # エラーだけ
npx wrangler tail --env production --format pretty --search <参照番号>
```

`wrangler tail` は開いている間の出力だけを見せます（過去の分は 5.1）。

### 5.3 アプリの中の記録

| 記録 | テーブル | 見る画面 |
|---|---|---|
| 定期処理の結果・失敗・未実行の警告 | `cron_runs`（180日） | 本部画面「データ保持・定期処理」（`GET /api/hq/cron/status`） |
| データ保持の削除の結果 | `retention_logs` | 本部画面「データ保持・定期処理」 |
| メールの送信の記録（送信・失敗・止めた宛先） | `email_logs`・`email_suppressions` | 本部画面「メール送信」、管理画面「通知」のメール送信状況 |
| シフト・枠・精算の操作履歴（変更の前後） | `operation_logs`（7年） | 管理画面のシフト詳細・精算の明細・スタッフ詳細の「操作履歴」（`GET /api/admin/operation-logs`） |
| 従業員データ・スタッフ基本情報の変更履歴 | `employee_change_logs` | 管理画面のスタッフ・従業員の詳細 |
| 打刻修正の操作・報告設定の変更 | `attendance_correction_events`・`report_setting_logs` | 管理画面「履歴・CSV」 |
| ログインの履歴 | `login_events`（1年） | 管理画面・本部画面の「セキュリティ」 |
| 本部の操作 | `hq_audit_logs` | 本部画面「導入企業」の「本部の操作の履歴」 |

### 5.4 本番の DB を直接見る

```bash
npx wrangler d1 execute mbsaas-production --remote --env production --command "SELECT job, status, started_at, error_message FROM cron_runs ORDER BY run_id DESC LIMIT 20"
```

- 調べるときは `SELECT` だけを使います。書き換えが要るときは、先にバックアップを取り（3.2 の 2）、SQL をもう1人に見てもらってから流します。
- `daily_reports` を SQL で直接足す・消す・書き換えたとき（4.3 の行の戻しや、検証環境への過去のデータの積み込みを含む）は、日報一覧の件数の控えも消します: `DELETE FROM daily_report_month_counts WHERE company_id = <会社>`（次に日報一覧を開いたときに数え直します。消さないと、今月より前の月の件数が最長7日古いまま出ます。#9970・`src/lib/report-counts.ts`）。
- 個人情報の列を画面やチャットに貼らないでください。

---

## 6. 障害時の初動

| # | やること | 見る所 |
|---|---|---|
| 1 | 何が起きているかを集める: どの画面で・どの会社の・だれが・いつから・画面に出た参照番号 | 利用者からの連絡 |
| 2 | Cloudflare 側の障害ではないか | Cloudflare のステータスのページ |
| 3 | エラーの中身を見る | Workers Logs で参照番号・`unhandled_error`（5.1）、`wrangler tail`（5.2） |
| 4 | 直前のデプロイが原因か | `npx wrangler deployments list --env production`。そうなら前の版に戻す（4.1） |
| 5 | マイグレーションの適用漏れではないか（新しい列・テーブルで 500） | `npm run db:migrations:check`（本番を確かめる） |
| 6 | CPU の上限（1リクエスト 10ms）を超えていないか | Workers Logs の CPU の超過の記録。利用者には Cloudflare のエラーのページ（1102 など）が出る。件数の多い操作（まとめて保存・まとめて削除・CSV）で起きやすい |
| 7 | 定期処理が止まっていないか | 本部画面「データ保持・定期処理」の警告（5.3） |
| 8 | データが壊れた・消えた | 書き込みを止める（必要なら本部で企業を停止）→ 範囲を確かめる → Time Travel か、バックアップから一部を戻す（4章） |
| 9 | 個人情報が漏れた疑い | 本部で該当の企業を停止（セッションも消える）、該当の利用者のパスワードを再発行、利用者（発注者）に報告 |
| 10 | 記録する | 起きたこと・原因・対応を残す（記録の仕方は [monitoring.md](monitoring.md)）。仕様を変えたら [decisions.md](decisions.md) に足す |

---

## 7. シークレットの登録と入れ替え 🔴 本番

シークレットの一覧と意味は [architecture.md](architecture.md) の 12.2 です。値は repo・チャット・資料に書きません。

```bash
npx wrangler secret list --env production                 # 登録済みの名前を見る（値は出ない）
npx wrangler secret put <名前> --env production           # 登録・上書き（値は対話で入れる）
npx wrangler secret delete <名前> --env production        # 消す
```

- `secret put` は、すぐに本番の Worker に反映されます（コードのデプロイは要りません）。
- `vars`（`MAIL_ENABLED` など）はシークレットではありません。`wrangler.jsonc` を直してマージします（ダッシュボードで変えても、次のデプロイで戻ります）。

入れ替えるときの注意:

| 名前 | 入れ替え方と影響 |
|---|---|
| `RESEND_API_KEY` | Resend で新しいキーを作る → `secret put` → 送れるのを確かめてから古いキーを Resend で無効にする |
| `RESEND_WEBHOOK_SECRET` | Resend の Webhook の署名の秘密を作り直す → すぐ `secret put`。その間に届いた Webhook は署名が合わず 401 になる（Resend が送り直す） |
| `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` | Cloudflare の Turnstile の画面で作り直す → 2つとも `secret put`。`RATE_LIMIT_SALT` がないときは、応募の回数の数え方（IP のハッシュ）が変わり、直近1時間の回数がいったん0に戻る |
| `RATE_LIMIT_SALT` | 長いランダムな文字列にする。入れ替えると、直近1時間の応募の回数がいったん0に戻る |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 入れ替えると、今までの端末の購読は使えなくなる。スタッフがアプリの通知の設定で「受け取る」を押し直すと、新しい鍵で購読し直す（`public/static/staff.js:2865`〜`2867`）。未設定のときは D1 の `push_vapid_keys` に鍵が保存されるので、D1 のバックアップの扱いに注意する |

Cloudflare の API トークンなど、自動バックアップ・通知の仕組みで使う鍵は [backup.md](backup.md)・[monitoring.md](monitoring.md) にあります。

---

## 8. データの定期削除（retention）と解約企業のデータ

### 8.1 定期削除
- 毎日 3:00 の `retention` と 3:30 の `retention_in_service` が、保存期間を過ぎた個人情報を消します（`src/services/retention.ts:7`〜`63` に対象と基準の一覧）。主な基準: 日報は勤務日から3年、退職したスタッフのデータは退職日（と最終稼働日の遅い方）から7年（本人情報の行は消さずに匿名化）、送信のメール記録は1年、操作履歴は7年、在職中でも位置情報・写真は報告から1年など。
- 本番は `RETENTION_ENABLED = 'true'` なので、実際に消します（`wrangler.jsonc:88`）。`'true'` 以外は dry-run（数えるだけ）です。
- 安全策: 退職日のない人は消さない、退職日より後にシフトがある人は対象外、初めて対象になってから7日は猶予（本部画面に「次回削除予定」と出る）、1回の処理の人数・ファイル数に上限（`src/services/retention.ts:52`〜`63`）。
- 本部画面「データ保持・定期処理」で、dry-run の実行・削除の予定・結果・在職中の保存期間の設定（`src/services/retention.ts:128`）・削除の保留ができます。
- **削除の保留**: 調査や訴訟などで残す必要があるスタッフ・企業は、本部画面で保留にします（`staff_profiles.retention_hold_at`・`companies.retention_hold_at`）。保留中はどの削除でも消しません。
- 消したデータは戻せません（Time Travel の期間内なら DB 全体を戻すことはできます。4.2）。

### 8.2 解約した企業のデータ
本部画面「解約・データ」で、次の順に行います（`src/api.ts:8647`〜`8653`）。
1. 企業を停止にする（利用状態を「停止」。ログインと API が止まる）。
2. 「契約終了」を登録する。登録すると猶予期間（既定90日。登録のときに30〜365日で変えられる。`src/services/retention.ts` の `OFFBOARDING_GRACE_DAYS`）に入る。登録は取り消せる。
3. 猶予のあいだに、データ（CSV・写真・書類のファイル）を書き出して企業に渡す。
4. 契約終了日＋猶予日数を過ぎたら、会社コードと確認の入力のうえで削除する。スタッフ・勤怠・写真・書類などを消し、利用者とスタッフの氏名・連絡先は匿名化する。書き出していないときは、書き出さない理由の入力が要る。停止を解除した企業は削除できない。

登録・取消・書き出し・削除の操作は `company_offboarding_events` に記録が残り、削除の記録は CSV で出せます。

---

## 9. 開発の決まり

- **マイグレーション**: `migrations/` に次の番号で足します。列・テーブルの追加と、安全なデータの移行だけにします（既存のデータを消す・型を変える変更はしない）。Sprint の中で番号がぶつからないよう、計画で割り当てた番号を使います。
- **テーブルを足したら**: 退職後の削除・解約企業の書き出しと削除の対象に入れます（`src/services/retention.ts`）。入れ忘れると、本部画面の「解約・データ」が知らない表として知らせます（`findUnknownOffboardingTables`）。
- **定期処理を足したら**: `src/index.tsx` の `CRON_JOBS` に1行足し、[architecture.md](architecture.md) の5章と README の表にも足します。新しい式なら `wrangler.jsonc` の `triggers.crons` にも（トップレベルと `env.production` の両方）。
- **環境変数を足したら**: `wrangler.jsonc` の `vars` はトップレベルと `env.production` の両方に書きます（環境ごとに引き継がれないため。`wrangler.jsonc:3`〜`4`）。[architecture.md](architecture.md) の12章にも足します。
- **画面**: 値は `esc` を通す。イベント属性の文字列に値を埋め込まず `data-*` と `delegate` を使う。二度押しは `withSubmitLock` で防ぐ（`public/static/common.js`）。
- **D1**: バインドは1文100個まで（`src/lib/d1-chunk.ts`）。`shifts` を更新した文の `meta.changes` を件数に使わない（トリガーの分も数えるため）。SQL 関数の引数は本番で32個まで（ローカルでは見つからない）。
- **テスト**: 時刻に依存するテストは 2.5 のように書きます。
- **資料**: Sprint の終わりに、変えた所に合わせて `docs/` を直します（[decisions.md](decisions.md) の D-40）。`npm test -- w13-docs-arch-ops` が、資料の中の `ファイル:行` の参照・定期処理の表・`vars` の表のずれを知らせます。行番号のずれは `node scripts/test-w13-docs-arch-ops.mjs --fix-refs` で直します（[architecture.md](architecture.md) の14章）。

---

## 10. ローンチ当日のチェックリスト 🔴 本番

正式に利用を始める日（ローンチ）に行うことです。ローンチまでは、デモのアカウントを本番に残す方針です。開発者は本番の設定を変えないので、Cloudflare・GitHub・本部の管理者の権限を持つ人が行います。
ローンチの後に変えると利用者全員がやり直すことになる項目があるので、先に 10.6 の「ローンチの前に利用者が決めること」を決めて、設定を済ませておきます。

| # | 作業 | 確かめ方 | 本番 |
|---|---|---|---|
| 0 | ローンチの前に決めることを決め、設定を済ませている | 下の 10.6 | 🔴 |
| 1 | デモ用の会社・ユーザーを止めるか、パスワードを変える（#62） | 下の 10.1 | 🔴 |
| 2 | 本番の設定が `DEMO_MODE=false` で動いている（#62） | Workers Builds のビルドのログ（10.2） | 🔴 |
| 3 | メールの送信を始めるなら、Resend の準備をする（#36・[decisions.md](decisions.md) の D-31） | 下の 10.3 | 🔴 |
| 4 | 毎日のバックアップが成功し、失敗の通知が届く | 下の 10.4 | |
| 5 | 本部画面のプッシュ通知を有効にする | 下の 10.5 | 🔴 |
| 6 | スモーク | 3.2 の 8 と同じ | 🔴 |

### 10.1 デモ用の会社・ユーザー
本番の DB には、`seed.sql` と同じデモ用の会社（会社コード `sample`・`demo2`・`demo3`）と、本部のデモユーザー（ID `hq`）が残っています。パスワードはすべて `pass1234`（ローカルのデモと同じ。1.4）で、2026-11 の時点で約26件あります。だれでもログインできるので、ローンチの前に必ず止めます。

1. 残っているものを確かめる（`SELECT` だけ）。パスワードはハッシュでは見分けられない（ログインするとハッシュが作り直される）ので、会社コードと ID で探します。

   ```bash
   npx wrangler d1 execute mbsaas-production --remote --env production --command "SELECT c.company_code, c.active_status, u.user_code, u.role, u.status FROM users u LEFT JOIN companies c ON c.company_id = u.company_id WHERE c.company_code IN ('sample', 'demo2', 'demo3') OR u.user_code = 'hq' ORDER BY c.company_code, u.user_code"
   ```

2. デモ用の会社は、本部画面「解約・データ」の「この企業を停止する」で止めます。停止した会社の利用者はログインできず、ログイン中のセッションも使えなくなります（`src/lib/auth.ts:139`）。デモを続けて使う会社があるなら、止めずに、その会社のユーザー全員のパスワードを変えます（管理者の画面での仮パスワードの再発行など）。
3. 本部の `hq` は、本部の担当者が実際に使っているなら、止めずにパスワードを変えます。本部画面にはパスワードを変える画面がないので、`hq` でログインしたブラウザから `POST /api/auth/change-password`（`src/accounts.ts:254`。今のパスワードと新しいパスワードを送る）を呼ぶか、開発者に依頼します。
4. もう一度 1 の SQL を流し、会社が停止（`active_status`）になっているか、ユーザーのパスワードを変えたかを確かめます。`/login` で `sample` / `admin` / `pass1234` でログインできないことも確かめます。

### 10.2 `DEMO_MODE=false` の確認
- Cloudflare のダッシュボードの Workers Builds で、ローンチの日のデプロイのビルドのログに、`scripts/ci-wrangler-config.mjs:42` の1行（`wrangler.json を本番の設定で作成しました（APP_BASE_URL=…, DEMO_MODE=false）`）が出ていることを確かめます（3.2 の 6）。
- `/login` を開いて、デモアカウントの案内が出ないことを確かめます（`src/index.tsx:317`）。

### 10.3 メールの送信を始めるとき（任意）
メールの送信は保留しています（D-31）。ローンチで始めるときだけ行います。始めないときは、パスワードを忘れた人には今までどおり管理者が仮パスワードを再発行します。
1. Resend で独自ドメインを認証する（Resend の Domains で DNS のレコードを足す）。
2. `wrangler.jsonc` の `env.production` の `MAIL_FROM`（`wrangler.jsonc:84`。2026-11-13 に `Mobital <notify@notify.mobital.jp>` に変えた）を、認証したドメインの送信元に変えて、マージする（`vars` なので、ダッシュボードで変えても次のデプロイで戻る。7章）。
3. `RESEND_API_KEY` と `RESEND_WEBHOOK_SECRET` をシークレットに登録する（7章の `secret put`）。
4. 管理者の画面からパスワードの再設定のメールなどを1通送り、届くこと、本部画面「メール送信」に送信の記録が出ることを確かめる。
5. [decisions.md](decisions.md) の D-31 に、再開した日を書き足す。

### 10.4 バックアップと通知
- GitHub の **Actions** → **D1 backup** が、毎日（日本時間 4:05 ごろ）緑（成功）になっていることを、ローンチの前の数日分確かめます。Summary の「表の定義の数」「INSERT の行数」が急に減っていないことも見ます（[backup.md](backup.md) の 3）。
- 失敗したときの GitHub の通知が担当者に届く設定になっていることを確かめます（GitHub の Settings → Notifications → Actions。[monitoring.md](monitoring.md) の 6）。
- 戻せることは、[backup.md](backup.md) の 6 の練習で確かめています。

### 10.5 本部画面のプッシュ通知
- 本部の担当者の端末で、本部画面「障害」の「この端末でプッシュ通知を受け取る」を押し、「テスト通知を送る」で届くことを確かめます（[monitoring.md](monitoring.md) の 3）。端末ごとに行います。
- iPhone・iPad は、Safari で本部画面を「ホーム画面に追加」してから行います（iOS 16.4 以降）。

### 10.6 ローンチの前に利用者が決めること
総点検（Sprint 21。#9945）で、ローンチの後に変えると手間が大きいもの・本番の安全に関わるものを集めました。決めたら、設定の欄の手順で設定し、[decisions.md](decisions.md) に決めたことを残します。🔴 の設定は Cloudflare・GitHub の管理者の権限を持つ人が行います（開発者は本番の設定を変えません）。

| # | 決めること | ローンチの前に決める理由 | 設定 | 本番 |
|---|---|---|---|---|
| 1 | Web Push の VAPID の鍵を Secret にする | 未設定だと、初めての通知のときに鍵を作り、秘密鍵を D1 の `push_vapid_keys` に平文で保存する（`src/lib/web-push.ts`）。D1 のバックアップにも入る。ローンチの後に入れ替えると、スタッフ全員が通知の受け取りを押し直すことになる（7章）。今のうちなら入れ替えの手間がない | 鍵を作り（`npx web-push generate-vapid-keys` と同じ形式）、`VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY` を `secret put`（7章）。`push_vapid_keys` に行が残っていれば、開発者と相談して扱いを決める | 🔴 |
| 2 | `RATE_LIMIT_SALT` を登録する | 未設定だと、応募の送信回数の制限に使う接続元 IP のハッシュが短い形になる（`src/recruit.ts` の `ipSaltState`）。入れ替えると直近1時間の回数がいったん0に戻るので、先に入れておく | 長いランダムな文字列を `secret put`（7章）。本部画面「障害」の設定の状態で、登録済みと出ることを確かめる | 🔴 |
| 3 | Turnstile（応募フォームのロボット判定）を使うか | 未設定だと、公開の応募フォームにロボット判定がない（回数の制限だけ） | 使うなら Cloudflare の Turnstile で本番の URL のサイトを作り、`TURNSTILE_SITE_KEY`・`TURNSTILE_SECRET_KEY` を2つとも `secret put`（7章）。本部画面「障害」の設定の状態で、有効と出ることを確かめる | 🔴 |
| 4 | 本番の URL（`workers.dev` のままか、独自ドメインにするか） | 今の本番の URL は `https://mbsaas.saas-2a2.workers.dev`（`APP_BASE_URL`）。ローンチの後に URL を変えると、プッシュ通知の購読・ホーム画面に追加したアプリ（PWA）・ログインの Cookie・メールのリンクがすべてやり直しになる | 独自ドメインにするなら、Cloudflare で Worker `mbsaas` にカスタムドメインを付け、`wrangler.jsonc` の `env.production` の `APP_BASE_URL` を変えてマージする（`vars` なのでダッシュボードでは変えない。7章）。VAPID・Turnstile の設定も新しい URL で行う | 🔴 |
| 5 | Workers の有料プラン（Workers Paid）に切り替える（利用者の決定 2026-11-09） | 今は Free プラン（[decisions.md](decisions.md) の D-30。CPU は1リクエスト 10ms、D1 の呼び出しは1回の起動で50回まで）。同時に多くの人が使うと上限にかかる。有料プランは CPU 30秒・D1 の呼び出し1,000回まで、D1 の Time Travel も30日前まで戻せる | Cloudflare のダッシュボードの **Workers & Pages** → **Plans** で Workers Paid に切り替える（料金がかかる）。切り替えた日を D-30 に書き足す。PBKDF2 の回数（D-30）は、切り替えとは別に決める | 🔴 |
| 6 | メール（Resend）を使うか | 本番は今メールを送らない（D-31）。「パスワードを忘れた」は、メールを送れない間も今のまま出す（D-52） | 使うなら 10.3 | 🔴 |
| 7 | 管理者の4ロール（会社管理者・現場管理者・営業管理者・事務担当）の権限 | 会社全体の設定の一部（緊急連絡先・入店の位置ずれの判定距離・前日確認）は、今は4ロールのだれでも変えられる（D-51）。ローンチの後に絞ると、今使っている人が急に変えられなくなる | 利用者の決定（2026-11-09）で、4ロールの権限は最後にまとめて決めて設定する（Sprint 24）。決めた内容をコードに入れてリリースする | |
| 8 | デモアカウント（パスワード `pass1234`）を消す | だれでもログインできる | 10.1 | 🔴 |
| 9 | 開発者の Cloudflare の API トークンを消すか、期限を付ける | 開発の間に本番を確かめるために作ったトークンが残っていると、ローンチの後も本番の DB を読み書きできる | Cloudflare のダッシュボードの **My Profile** → **API Tokens** で、開発者が使っているトークンを消すか、**TTL**（有効期限）を付ける。開発者のアカウントを Cloudflare のメンバーにしているなら、権限も見直す。GitHub の Secrets の `CLOUDFLARE_API_TOKEN`（自動バックアップ用。[backup.md](backup.md)）は別のもので、消さない | 🔴 |
| 10 | ブランチの保護（CI が通らない PR をマージできないようにする） | `main` へのマージがそのまま本番のデプロイになる（D-32） | 3.5 | |
| 11 | main 以外のブランチのビルドを止める | プレビューの版は本番の D1・R2 につながる（D-49） | 3.4 | 🔴 |
