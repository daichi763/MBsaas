# 本番データのバックアップと復元

本番のデータベース（Cloudflare D1 の `mbsaas-production`）を、毎日自動でバックアップします。
この文書は、外部の開発会社の方を含め、このシステムを初めて触る人が読める形で書いています。

- 仕組みのファイル: [`.github/workflows/d1-backup.yml`](../.github/workflows/d1-backup.yml)
- 決めたこと: 利用者の決定（Sprint 13。要件 #9621）

## 1. 全体の考え方

本番のデータを戻す方法は2つあります。どちらも Cloudflare の機能です。

| 方法 | 戻せる範囲 | 向いている場面 |
|---|---|---|
| **D1 Time Travel**（D1 の標準の機能） | 直近の任意の時点。無料プランは7日前まで、有料プラン（Workers Paid）は30日前まで | 誤った操作・誤ったマイグレーションの直後に、DB 全体をその前の時点に戻す |
| **R2 のバックアップ**（この仕組み） | 毎日の日本時間 4 時台の時点。30日分を残す | Time Travel の期間を過ぎたとき、別の DB に戻して中身を確かめたいとき、Cloudflare のアカウントの外に持ち出す必要があるとき |

Time Travel は設定なしで常に動いています。R2 のバックアップは、下の「1回だけ行う設定」をしてから動きます。

### バックアップの流れ

```
GitHub Actions（毎日 UTC 19:05 = 日本時間 4:05。手動でも実行できる）
  1. Secrets の確認（未登録ならここで失敗して終わる。Cloudflare には接続しない）
  2. npm ci（package-lock.json と同じ版の wrangler を入れる）
  3. wrangler d1 export mbsaas-production --remote  → backup.sql
  4. 中身の確認（主な表の CREATE TABLE があるか。d1_migrations 表がなければ警告）→ gzip
  5. wrangler r2 object put  → R2 のバケット mbsaas-d1-backups の d1/mbsaas-production-YYYYMMDD-HHMM.sql.gz
  6. R2 のライフサイクルのルール（30日で削除）があるかを確かめる（なければ警告）
  7. 保存先・件数・大きさ・SHA-256 を実行結果の要約（Summary）に出す
```

- 時刻は日本時間 4:05 にしています。アプリの定期処理（日本時間 3:00・3:30。`wrangler.jsonc` の `triggers.crons`）と重ならないようにするためです。GitHub の混み具合で、数分から数十分遅れることがあります。
- バックアップには個人情報（氏名・連絡先・勤怠など）が入ります。GitHub の Artifacts には置かず、ログにも中身を出しません。保存先は R2 の非公開のバケットだけです。
- Cloudflare の説明では、`d1 export` の実行中は、同じ DB への他の要求が待たされることがあります。利用の少ない早朝に行うのはこのためです。

## 2. 1回だけ行う設定（利用者・管理者が行う）

開発者は、本番・GitHub・Cloudflare の設定を変えません。以下は、Cloudflare と GitHub の管理者の権限を持つ人が行います。

### 2-1. R2 のバケットを作る

Cloudflare のダッシュボード → **R2 Object Storage** → **Create bucket**

- 名前: `mbsaas-d1-backups`（別の名前にするときは、2-4 の Variables にその名前を登録する）
- Location: 自動（Automatic）のままでよい
- 作ったあと、バケットの **Settings** で **Public access**（R2.dev の公開 URL・独自ドメイン）が **無効** のままであることを確かめる

コマンドで作る場合（管理者の端末で、`npx wrangler login` 済みのとき）:

```bash
npx wrangler r2 bucket create mbsaas-d1-backups
```

### 2-2. 古いバックアップを自動で消すルール（ライフサイクル）を付ける

バックアップのファイルは `d1/` で始まる名前で保存します。`d1/` のファイルを、作成から30日で自動で消すルールを付けます。

ダッシュボード → R2 → `mbsaas-d1-backups` → **Settings** → **Object lifecycle rules** → **Add rule**

- Rule name: `expire-d1-backups`
- Prefix: `d1/`
- **Expire objects**: 30 days

コマンドで付ける場合:

```bash
npx wrangler r2 bucket lifecycle add mbsaas-d1-backups expire-d1-backups d1/ --expire-days 30
npx wrangler r2 bucket lifecycle list mbsaas-d1-backups   # 確認
```

このルールがないと、バックアップは消えずに残り続けます（ワークフローは、ルールが見つからないときに警告を出します）。

### 2-3. Cloudflare の API トークンを作る

ダッシュボード右上のアイコン → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**

| 項目 | 設定 |
|---|---|
| Token name | `github-actions-d1-backup` など |
| Permissions | **Account** / **D1** / **Edit**（書き出しに使う） |
|  | **Account** / **Workers R2 Storage** / **Edit**（R2 への保存と、ライフサイクルのルールの確認に使う） |
| Account Resources | Include / このアプリのアカウントだけ |
| Client IP Address Filtering | 指定しない（GitHub Actions の接続元は決まっていないため） |
| TTL | 任意（期限を付けた場合は、切れる前に作り直して 2-4 の Secret を更新する） |

- 書き出し（`d1 export`）は Cloudflare の API では書き込みの権限（D1 Edit）を求めるため、D1 は Edit にします。ワークフローが行うのは書き出しだけで、DB の中身は変えません。
- このトークンでは Workers のデプロイや DNS の変更はできません。ほかの用途に使い回さないでください。
- 作成後に表示されるトークンは、その画面でしか見られません。2-4 で GitHub に登録したら、ほかの場所には保存しないでください。

**アカウント ID** は、ダッシュボードの **Workers & Pages** の概要画面の右側（Account ID）に出ています。

### 2-4. GitHub に Secrets を登録する

GitHub のリポジトリ → **Settings** → **Secrets and variables** → **Actions**

**Secrets**（New repository secret）

| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 2-3 で作ったトークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |

**Variables**（任意。既定の値を変えるときだけ）

| 名前 | 既定 | 内容 |
|---|---|---|
| `D1_BACKUP_BUCKET` | `mbsaas-d1-backups` | 保存先のバケット名 |

### 2-5. 手動で1回動かして確かめる

GitHub → **Actions** → **D1 backup** → **Run workflow**

- 成功したら、実行結果の **Summary** に保存先（`mbsaas-d1-backups/d1/mbsaas-production-YYYYMMDD-HHMM.sql.gz`）・表の数・大きさが出ます。
- ダッシュボードの R2 → `mbsaas-d1-backups` → `d1/` にファイルがあることを確かめます。
- 定期実行（schedule）は、リポジトリの既定のブランチ（main）にこのファイルがあるときだけ動きます。main にマージされるまでは動きません。
- 失敗の通知: 定期実行（schedule）が失敗すると、GitHub はワークフローを最後に変更した人にメールで知らせます（GitHub の Notifications の設定で、Actions の通知が有効な場合）。確実に気づけるよう、担当者の GitHub の通知設定を確かめてください。

## 3. ふだんの確認

- 週に1回程度、GitHub の **Actions** → **D1 backup** の実行が緑（成功）になっていることを見る。
- 実行結果の Summary の「表の定義の数」「INSERT の行数」が急に減っていないことを見る（減っていたら、データが消えた可能性がある）。
- 警告「ライフサイクルのルールが見つかりません」が出ていたら、2-2 を行う。

## 4. 復元のしかた

**本番の DB を戻す操作は、戻した時点より後のデータ（その間の打刻・シフトの変更など）を失います。** 必ず関係者に知らせ、戻す時点を決めてから行います。

### 4-1. まず、今の状態を保存する

どちらの方法でも、戻す前に今の状態を書き出しておきます（戻し方を誤ったときにやり直せるように）。

```bash
npx wrangler d1 export mbsaas-production --remote --output before-restore-YYYYMMDD.sql
```

または GitHub の **D1 backup** を手動で実行します（R2 に保存されます）。書き出したファイルには個人情報が入るので、作業が終わったら端末から消します。

### 4-2. D1 Time Travel で戻す（直近7日以内。第一の方法）

```bash
# 戻したい時点（RFC3339 か Unix 時刻）の bookmark を確かめる。時刻は UTC で指定する（日本時間 - 9 時間）
npx wrangler d1 time-travel info mbsaas-production --timestamp=2026-11-01T18:00:00Z

# その時点に戻す（DB 全体が置き換わる）
npx wrangler d1 time-travel restore mbsaas-production --timestamp=2026-11-01T18:00:00Z
```

- `restore` の出力に、戻す直前の bookmark が出ます。戻し方を誤ったときは、その bookmark を `--bookmark=...` に指定して、もう一度 `restore` すると元に戻せます。出力は控えておきます。
- 戻せるのは DB 全体だけです（表や行を選んで戻すことはできません）。一部だけ戻したいときは、4-3 の方法で別の DB に戻してから、必要な行を取り出します。
- 無料プランで戻せるのは7日前まで、有料プランは30日前までです。

### 4-3. R2 のバックアップから戻す

1. バックアップを取り出す（ダッシュボードの R2 からダウンロードしてもよい）

   ```bash
   npx wrangler r2 object get mbsaas-d1-backups/d1/mbsaas-production-20261101-0405.sql.gz --remote --file restore.sql.gz
   gunzip restore.sql.gz            # restore.sql ができる
   ```

2. 手元（ローカル）の D1 に入れて、中身を確かめる（本番には接続しない）

   ```bash
   npx wrangler d1 execute mbsaas-production --local --persist-to .wrangler/restore-check --file restore.sql
   npx wrangler d1 execute mbsaas-production --local --persist-to .wrangler/restore-check --command "SELECT COUNT(*) FROM users"
   ```

3. 本番に戻す。**今の本番の DB に上書きで流し込まない**でください（同じ表がすでにあるため失敗するか、データが二重になります）。新しい DB を作って流し込み、アプリの向き先を切り替えます。

   ```bash
   npx wrangler d1 create mbsaas-restore-20261101
   npx wrangler d1 execute mbsaas-restore-20261101 --remote --file restore.sql
   ```

   - `wrangler.jsonc` の `env.production.d1_databases` の `database_id` を、新しい DB の ID に変えてデプロイすると、アプリが新しい DB を使います（DB の名前 `database_name` も合わせて変える）。トップレベル（ローカル開発用）の `d1_databases` も同じに揃えます。
   - 書き出しのファイルは、表の定義 → データ（INSERT）→ 索引とトリガーの順です。流し込みの途中でトリガー（プッシュの積み込みなど）は動きません。
   - 本番のマイグレーションは `wrangler d1 migrations apply` で適用しているので、バックアップには適用の記録（`d1_migrations` 表）も入ります（入っていないときは、ワークフローが警告を出します。その場合は、戻した DB の表・列を migrations/ のファイルと突き合わせて、どこまで適用済みかを確かめてから、足りないものだけを流します）。戻したあとに `npm run db:migrate:remote` を実行すると、バックアップの後に足したマイグレーションだけが適用されます（データベース名を新しいものに変えた場合は、コマンドの DB 名も合わせる）。
   - 切り替えのあと、古い DB はすぐに消さず、確認が終わるまで残します。

4. 復元に使った `restore.sql`・`before-restore-*.sql` は、作業が終わったら端末から消します（個人情報が入っています）。

## 5. 手動のバックアップ（リリースの前など）

これまでリリースの前に手で取っていたバックアップは、GitHub の **D1 backup** を手動で実行（Run workflow）すれば R2 に残ります。PC の一時フォルダに置く必要はありません。

手元に書き出す必要があるときは、次のコマンドで書き出し、使い終わったら消します。

```bash
npx wrangler d1 export mbsaas-production --remote --output backup-YYYYMMDD.sql
```

## 6. 関連

- 障害に気づく仕組み（エラーの記録と通知・Workers Logs）: [monitoring.md](monitoring.md)
- データの保存期間（定期削除）: `src/services/retention.ts` の先頭のコメント
