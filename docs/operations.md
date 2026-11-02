# 運用手順書

Field OS の開発・リリース・障害対応の手順です。初めて担当する人（社外の開発会社を含む）が、この資料だけで作業を始められるように書いています。
全体の構成は [architecture.md](architecture.md)、用語は [glossary.md](glossary.md) を先に読んでください。

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

`seed.sql` は本番には入れません。本番のログイン画面にデモの案内が出ないことは `DEMO_MODE`（本番は `false`）で決まります（`src/index.tsx:243`）。

### 1.5 型チェックとビルド

```bash
npm run typecheck     # tsc --noEmit -p .（vite build は型を確かめないので、別に流す）
npm run build
```

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
```

`scripts/run-tests.mjs` の流れ（`scripts/run-tests.mjs:3`〜`5`）:
1. `npm run build`。
2. テスト用のローカル D1 を1回だけ作る（`scripts/setup-test-db.sh`。0001〜0026 → `seed.sql` → 0027 以降の順に適用し、既存のデータに後のマイグレーションを当てる本番の状況を再現する）。
3. テストのファイルごとに、その D1 を複製して `wrangler dev --local` を起動し、テストを流してサーバーを止める。テストの先頭のコメントに書いた `--var 名前:値` と `--test-scheduled` を読み取って起動に付ける（`scripts/run-tests.mjs:48`〜`52`）。

環境変数: `TEST_DB_DIR`（テスト用 D1 の置き場所。既定は OS の一時フォルダの `mbsaas-test`）、`TEST_PORT`（既定 8899）。テストは本番に接続しません。

### 2.2 既知の失敗（2本）

`npm test` では次の2本が落ちます。アプリの不具合ではないので直さないと決めています（[decisions.md](decisions.md) の D-33）。この2本以外がすべて通れば合格です。

| テスト | 落ちる理由 | 手で確かめる方法 |
|---|---|---|
| `test-history.mjs` | `test-report-settings` → `test-corrections` → `test-notifications` が同じ DB に作ったデータを前提にしているが、`npm test` はテストごとに DB を作り直す | 先頭のコメント（`scripts/test-history.mjs:2`〜`8`）の順に、同じ DB・同じサーバーで流す |
| `test-w4-notifications-mail.mjs` | 先頭のコメントの `<WEBHOOK_SECRET と同じ値>` が起動のオプションとして読み取られ、`<` がシェルのリダイレクトになってサーバーが起動しない | 先頭のコメント（`scripts/test-w4-notifications-mail.mjs:2`〜`7`）のとおりに、Webhook の秘密の値（テストの既定値）を `--var` で渡して起動して流す |

### 2.3 1本だけ手で流す

```bash
bash scripts/setup-test-db.sh "<短いパスの保存先>"          # Windows ではパスが長いと失敗する
npm run build
npx wrangler dev --local --port 8810 --persist-to "<保存先>"   # テストの先頭のコメントにある --var・--test-scheduled も付ける
BASE=http://127.0.0.1:8810 PERSIST="<保存先>" node scripts/test-xxx.mjs
```

終わったら `wrangler dev` を止めます。

### 2.4 テストの書き方
- `scripts/test-<作業単位>.mjs` に、API を呼んで確かめるテストを書きます。1件ごとに `PASS` / `FAIL` を出し、最後に `n/m passed` を出して、失敗があれば終了コード 1 にします（例: `scripts/test-w12-shift.mjs`）。
- ログインは `POST /api/auth/login` に会社コード・ID・パスワードを送り、`set-cookie` の `session` を次の要求に付けます。
- 起動のオプションが要るときは、先頭25行のコメントに `--var 名前:値` / `--test-scheduled` と書きます（`npm test` がそれを読みます）。値に `<` `>` を書かないでください（2.2 の理由）。
- 画面の確認が要るときは、ヘッドレスの Chrome を使い、Chrome がない環境では省くようにします（`scripts/test-w12-shift.mjs:9`）。

---

## 3. 本番リリース 🔴 本番

本番へのデプロイは、GitHub の `main` へのマージで Workers Builds が自動で行います（[decisions.md](decisions.md) の D-32）。**マイグレーションは自動では適用されない**ので、新しいマイグレーションがあるときは、マージより先に手で本番に適用します。新しい列・テーブルを使うコードが先に出ると、その API が 500 になります。

本番に触るコマンドには、必ず `--remote --env production` を付けます（wrangler 4 は付けないとローカルに対して動きます）。

### 3.1 チェックリスト

| # | 作業 | 本番 |
|---|---|---|
| 0 | PR のテストを確かめる（型チェック・ビルド・`npm test` で既知の2本以外が合格） | |
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

`npm run db:migrate:remote` も同じ適用です（`package.json:11`）。`CI=true` は、適用してよいかの確認を聞かずに進めるためのものです。

**5. マージ 🔴**

GitHub で PR を `main` にマージします。Workers Builds が起動し、`npm run build` → `npx wrangler deploy` を行います。

**6. デプロイの確認 🔴**

```bash
npx wrangler deployments list --env production    # いちばん新しいデプロイの日時が今になっていること
```

Cloudflare のダッシュボードの Workers Builds のビルドのログに、`scripts/ci-wrangler-config.mjs:31` の1行が出ていることを確かめます（本番の設定で `wrangler.json` を作ったという行で、`APP_BASE_URL` と `DEMO_MODE=false` が出ます）。この行がないと、ローカル用の設定（メールを送らない・デモの案内を出す）で本番に出てしまいます。

**7. 環境変数の確認 🔴**

ダッシュボードの Worker `mbsaas` の設定（Variables and Secrets）で、次を確かめます。

| 名前 | 本番の値 |
|---|---|
| `APP_BASE_URL` | 本番の URL（`wrangler.jsonc:79`） |
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

---

## 4. 戻し方・復元 🔴 本番

### 4.1 コードを前の版に戻す

```bash
npx wrangler deployments list --env production    # 戻したい版（Version ID）を探す
npx wrangler rollback <Version ID> --env production
```

ダッシュボードの Worker `mbsaas` の Deployments からも戻せます。戻した後、`main` にも戻す変更（revert の PR）を入れます。入れないと、次のマージで問題のある版がまた出ます。
マイグレーションは追加だけなので、前の版のコードは新しい列・テーブルがあっても動きます。

### 4.2 D1 を過去の時点に戻す（Time Travel。まずこれを使う）

```bash
npx wrangler d1 time-travel info mbsaas-production --env production                       # 今のブックマーク
npx wrangler d1 time-travel restore mbsaas-production --env production --bookmark=<控えたブックマーク>
# 時刻で戻すときは --timestamp=<UNIX 時刻 または RFC3339>
```

- **DB 全体**がその時点に戻ります。その後に入った勤怠・日報・応募なども消えるので、戻す範囲と影響を確かめてから行います。
- restore を実行すると、戻す前の状態のブックマークが表示されます。控えておけば、戻したことを取り消せます。
- 戻せる期間には上限があります（Free プランでは過去7日まで。Cloudflare の D1 の制限で、変わることがあるので Cloudflare のドキュメントで確かめてください）。それより前は、バックアップのファイルから戻します。

### 4.3 バックアップのファイル（`d1 export` の SQL）から戻す

**一部の行だけを戻す**（誤って消した・書き換えた行など。ふつうはこちら）:
1. 3.2 の 3 と同じように、バックアップをローカルに流し込む（`--local --persist-to`）。
2. ローカルで、戻したい行を `SELECT` で確かめ、`INSERT` / `UPDATE` の SQL を作る。
3. 本番に流す: `npx wrangler d1 execute mbsaas-production --remote --env production --file=<作った SQL>`。

**DB 全体を戻す**（Time Travel で戻せない場合だけ）:
1. 新しい D1 を作る: `npx wrangler d1 create <新しい名前>`。
2. バックアップを流し込む: `npx wrangler d1 execute <新しい名前> --remote --file=<バックアップ>.sql`。
3. `wrangler.jsonc` の D1 の `database_id`（と `database_name`）を、トップレベルと `env.production` の両方で新しい DB に変え、マージしてデプロイする。`package.json` の `db:*` のスクリプトと `scripts/check-migrations.mjs:10` も DB の名前を使っているので合わせて直す。

### 4.4 R2 のファイル
入店・退店の写真、履歴書・入社時書類、契約書は R2 にあり、**D1 のバックアップと Time Travel には入りません**。R2 のファイルの扱いは [backup.md](backup.md) を見てください。

---

## 5. ログの見方 🔴 本番

障害の記録と通知の仕組み（どこに通知が届くか、何を見張っているか）は [monitoring.md](monitoring.md) にあります。

### 5.1 Workers Logs（本番の console の出力）

本番だけ有効です（`wrangler.jsonc:86`〜`89`）。Cloudflare のダッシュボードで Worker `mbsaas` の Logs（Observability）を開き、文字で検索します。保存される期間はプランによります。

| 探すもの | 検索する文字 | 出す所 |
|---|---|---|
| 予期しないエラー（利用者に参照番号を出したもの） | `unhandled_error`、または参照番号（8文字） | `src/index.tsx:53`〜`57` |
| 定期処理の結果 | `cron <処理名>:`（例 `cron retention:`） | `src/services/cron.ts:54` |
| 定期処理の記録の失敗 | `cron_runs insert failed` | `src/services/cron.ts:66` |
| プッシュ通知の送信の失敗 | `push flush failed` | `src/index.tsx:71` |
| Turnstile の問い合わせの失敗 | `turnstile siteverify failed` | `src/recruit.ts:304` |
| 応募の回数制限の塩がない | `RATE_LIMIT_SALT が未設定` | `src/recruit.ts:396` |
| メールの送信元がテスト用 | `mail warning` | `src/services/email.ts:90` |

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
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 入れ替えると、今までの端末の購読は使えなくなる。スタッフがアプリの通知の設定で「受け取る」を押し直すと、新しい鍵で購読し直す（`public/static/staff.js:2786`〜`2788`）。未設定のときは D1 の `push_vapid_keys` に鍵が保存されるので、D1 のバックアップの扱いに注意する |

Cloudflare の API トークンなど、自動バックアップ・通知の仕組みで使う鍵は [backup.md](backup.md)・[monitoring.md](monitoring.md) にあります。

---

## 8. データの定期削除（retention）と解約企業のデータ

### 8.1 定期削除
- 毎日 3:00 の `retention` と 3:30 の `retention_in_service` が、保存期間を過ぎた個人情報を消します（`src/services/retention.ts:3`〜`55` に対象と基準の一覧）。主な基準: 日報は勤務日から3年、退職したスタッフのデータは退職日（と最終稼働日の遅い方）から7年（本人情報の行は消さずに匿名化）、送信のメール記録は1年、操作履歴は7年、在職中でも位置情報・写真は報告から1年など。
- 本番は `RETENTION_ENABLED = 'true'` なので、実際に消します（`wrangler.jsonc:81`）。`'true'` 以外は dry-run（数えるだけ）です。
- 安全策: 退職日のない人は消さない、退職日より後にシフトがある人は対象外、初めて対象になってから7日は猶予（本部画面に「次回削除予定」と出る）、1回の処理の人数・ファイル数に上限（`src/services/retention.ts:44`〜`55`）。
- 本部画面「データ保持・定期処理」で、dry-run の実行・削除の予定・結果・在職中の保存期間の設定（`src/services/retention.ts:113`）・削除の保留ができます。
- **削除の保留**: 調査や訴訟などで残す必要があるスタッフ・企業は、本部画面で保留にします（`staff_profiles.retention_hold_at`・`companies.retention_hold_at`）。保留中はどの削除でも消しません。
- 消したデータは戻せません（Time Travel の期間内なら DB 全体を戻すことはできます。4.2）。

### 8.2 解約した企業のデータ
本部画面「解約・データ」で、企業を停止 → データを CSV とファイルで書き出す → 削除、の順に行います。書き出し・削除の操作は記録が残り、削除の記録は CSV で出せます（`src/api.ts:7957`〜`7963`）。

---

## 9. 開発の決まり

- **マイグレーション**: `migrations/` に次の番号で足します。列・テーブルの追加と、安全なデータの移行だけにします（既存のデータを消す・型を変える変更はしない）。Sprint の中で番号がぶつからないよう、計画で割り当てた番号を使います。
- **テーブルを足したら**: 退職後の削除・解約企業の書き出しと削除の対象に入れます（`src/services/retention.ts`）。入れ忘れると、本部画面の「解約・データ」が知らない表として知らせます（`findUnknownOffboardingTables`）。
- **定期処理を足したら**: `src/index.tsx` の `CRON_JOBS` に1行足し、[architecture.md](architecture.md) の5章と README の表にも足します。新しい式なら `wrangler.jsonc` の `triggers.crons` にも（トップレベルと `env.production` の両方）。
- **環境変数を足したら**: `wrangler.jsonc` の `vars` はトップレベルと `env.production` の両方に書きます（環境ごとに引き継がれないため。`wrangler.jsonc:3`〜`4`）。[architecture.md](architecture.md) の12章にも足します。
- **画面**: 値は `esc` を通す。イベント属性の文字列に値を埋め込まず `data-*` と `delegate` を使う。二度押しは `withSubmitLock` で防ぐ（`public/static/common.js`）。
- **D1**: バインドは1文100個まで（`src/lib/d1-chunk.ts`）。`shifts` を更新した文の `meta.changes` を件数に使わない（トリガーの分も数えるため）。SQL 関数の引数は本番で32個まで（ローカルでは見つからない）。
- **資料**: Sprint の終わりに、変えた所に合わせて `docs/` を直します（[decisions.md](decisions.md) の D-40）。`npm test -- w13-docs-arch-ops` が、資料の中の `ファイル:行` の参照・定期処理の表・`vars` の表のずれを知らせます。
