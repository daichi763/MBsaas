# 障害に気づく仕組み（エラーの記録・通知・ログ）

サーバーでエラーが起きたときに、だれかが気づけるようにする仕組みです。
この文書は、外部の開発会社の方を含め、このシステムを初めて触る人が読める形で書いています。

- 決めたこと: 利用者の決定（Sprint 13。要件 #9622）。Sprint 25 で、通知の送り先（Slack・LINE など。#9974）・DB の大きさの見張り（#9971）・外からの死活監視の入口（#9973）を足した（9〜11 章）
- 主なファイル:
  - `src/lib/error-log.ts` … エラーの記録・同じエラーのまとめ・通知の判定
  - `src/index.tsx` … `app.onError`（予期しないエラーを受け止めて参照番号を返す）と、定期処理の失敗の記録（`withErrorLog`）
  - `src/hq-errors.ts` … 本部画面「障害」の API（`/api/hq/errors`）
  - `src/notifications.ts` … 本部の管理者の端末へのプッシュ通知（`/api/hq/push/*`）
  - `public/static/hq.js` … 本部画面「障害」のタブ
  - `migrations/0093_error_logs.sql` … 記録の表（`error_logs`・`error_alerts`）
  - `src/services/alerts.ts` … 通知の送り先（`ALERT_DESTINATIONS`）への送信・同じ通知の間隔の判定・打刻と日報の失敗の通知（#9974）
  - `src/services/monitor.ts` … DB の大きさの記録・段階・毎朝のまとめ（#9971）
  - `src/hq-monitor.ts` … 本部画面「障害」の送り先・DB の大きさの API（`/api/hq/monitor`）
  - `migrations/0109_monitoring.sql` … `db_size_logs`・`alert_destination_status`・`alert_cooldowns`

## 1. 全体の流れ

```
利用者の操作 → サーバーで予期しないエラー
   │
   ├─ 利用者の画面: 「処理に失敗しました（日時 参照番号: 1a2b3c4d）」と出す（JSON の 500。#230）
   ├─ Workers Logs: 1行の JSON（参照番号・パス・会社・利用者・エラーの全文・スタックの先頭）を残す
   └─ 応答の後（waitUntil）: D1 の error_logs に要約を1件残す
          └─ 直近10分の件数が10件以上なら（最後の通知から60分以上たっていれば）
                 本部の管理者全員に、アプリ内の通知 ＋ プッシュ通知（受け取る設定をした端末だけ）＋ 送り先（9 章）

打刻・日報の送信の失敗（5xx） → 10件を待たず1件目から、本部の管理者と送り先に知らせる（同じ場所は60分に1回まで。9.3）
定期処理（cron）の失敗 → cron_runs に記録（本部画面の上部に警告。以前から）＋ error_logs にも1件残す
                         ＋ 本部の管理者と送り先に知らせる（同じ処理は60分に1回まで。9.3）
DB の大きさ → 毎朝8時以降に1日1回記録し、段階が上がったら知らせる（10 章）
外の監視サービス（UptimeRobot など） → 5分ごとに GET /api/health（11 章）
```

- メールは、送り先に `email` を書き、`MAIL_ENABLED` が `true` で `RESEND_API_KEY` があるときだけ送ります（今の本番は `RESEND_API_KEY` が無いので送りません。9 章）。
- 記録や通知に失敗しても、利用者への応答や定期処理の結果は変わりません（失敗は Workers Logs に1行残るだけ）。
- 記録は応答の後に行うので、利用者の待ち時間と Workers の CPU 時間（無料プランは1回 10ms）にはほとんど影響しません。D1 への書き込みは、エラー1件につき1回のまとめた書き込み（batch）と、件数の確認の問い合わせ1回です。

## 2. 何を記録するか（error_logs）

| 列 | 内容 |
|---|---|
| `ref` | 参照番号（8桁の16進）。利用者の画面に出たものと同じ。定期処理の失敗にも付ける |
| `source` | `request`（画面・API）／ `cron`（定期処理） |
| `method` / `path` | 要求のメソッドとパス。定期処理は `CRON` と処理名（`src/index.tsx` の `CRON_JOBS` の `name`） |
| `company_id` / `role` | 操作していた利用者の会社とロール（ログイン前・定期処理は空） |
| `error_name` / `message` | エラーの種類と要約（300文字まで） |
| `location` | スタックの最初の1行（どのファイルのどこで起きたか） |
| `repeat_count` / `last_repeat_at` | 同じエラーをまとめた回数と最後の日時（下記） |
| `created_at` | 日本時間 |

**記録しないもの**: 利用者の ID・氏名・入力値・SQL に渡した値・スタックの全文。
要約の中の引用符で囲まれた部分（JSON の入力の抜粋など）、メールアドレス、6桁以上の数字、トークンのような長い英数字は伏せ字にします（`sanitizeErrorText`）。
パスに入るトークン（報告用URL・募集ページ・パスワード再設定）も伏せます（`maskPath`）。

**書き込みが増えすぎないように**: 直近10分に同じエラー（種類・パス・要約が同じもの）が20行あるとき、または全体で100行あるときは、新しい行を作らず、同じエラーの最後の行の `repeat_count` に数えます。まとめた分の参照番号は `error_logs` には残りません（Workers Logs には1件ずつ残ります）。

**保存期間**: 90日で消します（毎日 日本時間 3:00 のデータ保持の定期削除。`src/services/retention.ts` の `error_logs`・`error_alerts`）。解約した企業のデータの削除でも、その企業の行を消します（`OFFBOARDING_TABLES`）。

## 3. 本部画面「障害」

本部画面（`/hq`）の上部のタブ「障害」で見ます。未読の通知があると、タブに件数が出ます。

- **通知**: 「エラーが増えています（直近10分にN件）」・打刻や日報の送信の失敗・定期処理の失敗・DB の大きさの段階（9・10 章）。「確認しました」で既読にします。
- **件数**: 直近10分・24時間・7日の件数と、最後に通知した日時。
- **件数の推移**: 直近14日の日別の件数（定期処理の分を含む）。
- **よく起きているエラー**: 直近7日で、同じエラーをまとめた件数の多い順。「例を見る」でその参照番号の記録を出します。
- **記録**: 新しい順。参照番号（途中まででも可）と種類（画面・API／定期処理）で探せます。企業名を押すと、その企業の記録だけを出します。
- **プッシュ通知（この端末）**: 「この端末でプッシュ通知を受け取る」を押すと、本部画面を開いていなくても、エラーが増えたときに端末の通知が届きます。端末ごとに設定します。「テスト通知を送る」で届くか確かめられます。
- **通知の送り先**・**DB の大きさ**: 9・10 章。DB の大きさが「緊急」のときは、どのタブでも上部に赤い帯を出します。
  - iPhone・iPad は、Safari の共有ボタンから「ホーム画面に追加」した本部画面で受け取れます（iOS 16.4 以降）。
  - 本部の管理者がプッシュで受け取るのは、この障害の通知だけです。

### 利用者から参照番号の問い合わせがあったとき

1. 本部画面「障害」の検索欄に参照番号を入れて「探す」。場所（パス）・企業・エラーの要約が分かります。
2. 詳しく見るときは、下の 5. の Workers Logs で同じ参照番号を検索します（エラーの全文・スタックの先頭が出ます）。
3. 「この参照番号の記録はありません」と出るときは、同じエラーが続いてまとめられたか、90日を過ぎたかです。Workers Logs で探します（ただし Workers Logs は数日しか残りません）。

## 4. 通知の目安を変える

既定は「直近10分に10件以上で通知。同じ通知は60分に1回まで」です。`wrangler.jsonc` の `env.production.vars` に次の値を足してデプロイすると変えられます（値は文字列で書く）。

| 名前 | 既定 | 範囲 |
|---|---|---|
| `ERROR_ALERT_THRESHOLD` | `10` | 通知する件数（1〜10000） |
| `ERROR_ALERT_WINDOW_MINUTES` | `10` | 数える期間（分。1〜1440） |
| `ERROR_ALERT_COOLDOWN_MINUTES` | `60` | 次の通知までの間隔（分。1〜10080） |

範囲の外の値や数字でない値は、既定の値を使います（`src/lib/error-log.ts` の `errorAlertSettings`）。

## 5. Cloudflare の Workers Logs（詳しいログ）

`wrangler.jsonc` の `env.production.observability` で、本番の Workers Logs を有効にしています（`enabled: true`、`head_sampling_rate: 1` = すべての要求のログを残す）。

```jsonc
"observability": {
  "enabled": true,
  "head_sampling_rate": 1
}
```

**見かた**: Cloudflare のダッシュボード → **Workers & Pages** → `mbsaas` → **Observability**（または **Logs**）

- 予期しないエラーは `"event": "unhandled_error"` の1行の JSON です。項目 `ref`（参照番号）・`path`・`company_id`・`user_id`・`message`・`stack` で絞り込めます。
- 障害の通知を出したときは `"event": "error_alert"` の行が出ます。
- 定期処理は `cron <処理名>: ok / failed ...` の行が出ます。
- 無料プランでは、ログの保存は数日（Cloudflare の説明では3日）で、1日に残せる件数にも上限があります。上限を超えた分は残りません。長く残す必要がある情報は `error_logs`（90日）を見ます。

## 6. Cloudflare のダッシュボードの通知の設定（利用者が行う）

アプリの外の障害（Cloudflare 自体の障害など）に気づけるよう、Cloudflare の通知を設定します。開発者は本番・Cloudflare の設定を変えないため、管理者が行います。
（この文書を書いたときは本番のダッシュボードを開いていないため、メニューの名前は変わっている場合があります。）

ダッシュボード → 右上のアカウント → **Notifications** → **Add**

1. **Cloudflare の障害・メンテナンスの知らせ**（Incident alerts など）: 対象の製品に Workers・D1・R2 を選び、宛先に担当者のメールアドレスを入れる。
2. Workers に関する通知の種類が一覧にあれば（エラーの増加・利用量など）、宛先に担当者のメールアドレスを入れて有効にする。選べる種類はプランによって変わります。
3. 設定したら、通知の一覧で **Test** を押し、メールが届くことを確かめる。

あわせて、次の通知も担当者に届くようにしておきます。

- **GitHub Actions の失敗**（毎日のバックアップ。[backup.md](backup.md)）: GitHub の Settings → Notifications → **Actions** の通知を有効にする。
- **デプロイの失敗**: 手元から `npm run deploy` でデプロイする場合は、その場の出力で分かります。GitHub 連携の自動デプロイ（Cloudflare の Workers Builds）を使う場合は、ダッシュボードの `mbsaas` → **Settings** → **Builds** で、ビルドの結果をだれが確かめるかを決めておきます（自動デプロイを使うかどうかはリポジトリのファイルからは決まりません。`docs/spec_multi_company_staff.md` の設定の節を参照）。

## 7. 本部画面のほかの警告（以前からあるもの）

- **定期処理の確認が必要です**: 定期処理（cron）の最後の実行の失敗や、目安（15分おきの処理は1時間、毎日の処理は25時間）を過ぎた停止を、本部画面の上部に出します（`src/services/cron.ts` の `cronStatus`。#192）。この Sprint から、失敗は `error_logs` にも残り、件数が目安を超えると通知されます。
- **メールが届いていない会社があります**: メールの不達の割合が高い会社を出します（#438）。

## 8. 手元での確認（開発者向け）

本番には接続しません（`--remote` は使わない）。

```bash
npm test -- w13-ops-safety
```

`scripts/test-w13-ops-safety.mjs` は、通知の目安を小さくして（`--var ERROR_ALERT_THRESHOLD:3` など。テストの先頭のコメントにある）ローカルのサーバーを起動し、
わざと予期しないエラーを起こして、記録・まとめ・参照番号での検索・本部の管理者への通知・同じ通知を繰り返さないこと・権限を確かめます。

```bash
npm test -- w25-monitor
```

`scripts/test-w25-monitor.mjs` は、送り先をテストが手元に立てる受け口（`127.0.0.1:9027`）にして（`--var ALERT_DESTINATIONS:…`。本物の外部には送らない）、
`/api/health`・種類ごとの送り方・テスト送信・打刻と日報の失敗の通知・定期処理の失敗の通知・DB の大きさの記録と段階・毎朝のまとめを確かめます。

## 9. 通知の送り先（Slack・LINE など。#9974）

障害の通知を、アプリ内の通知・プッシュ通知に加えて、外の送り先にも送ります。送り先は秘密の値 `ALERT_DESTINATIONS` に書きます。
**登録していない・空のときは、送り先へは何も送りません（エラーにはなりません）。** アカウント・送り先・Resend のドメインは、利用者が決めてから登録します（11/16 の打ち合わせで決める）。

### 9.1 書き方

JSON の配列です。1つの送り先が1つの要素です（10個まで）。

| 項目 | 内容 |
|---|---|
| `type` | `slack` / `discord` / `google_chat` / `teams` / `line` / `webhook` / `email` |
| `url` | `slack`・`discord`・`google_chat`・`teams`・`webhook` の Incoming Webhook の URL（`https://`） |
| `token`・`to` | `line`: Messaging API のチャネルのアクセストークン（長期）と、送る相手のユーザー ID・グループ ID（LINE Notify は終わったので使わない） |
| `to` | `email`: 宛先（`,` で区切って複数）。`MAIL_ENABLED` が `true` で `RESEND_API_KEY` があるときだけ Resend で送る。無ければ送らずに、最後の送信の結果を「未設定」にする |
| `receive` | 受け取る通知。`all`（既定。すべて）/ `critical`（すぐに知らせるものだけ）/ `digest`（毎朝のまとめだけ） |
| `name` | 本部画面に出す名前（省略時は「Slack 1」など） |

```json
[
  { "type": "slack", "url": "https://hooks.slack.com/services/…", "name": "本部の Slack" },
  { "type": "line", "token": "チャネルのアクセストークン", "to": "U0123…", "receive": "critical", "name": "担当者の LINE" },
  { "type": "email", "to": "ops@example.com", "receive": "digest" }
]
```

登録: `npx wrangler secret put ALERT_DESTINATIONS --env production`（入力を求められたら上の JSON を1行で貼る）。
シェルで引用符を書きにくいときは、JSON を base64 にした文字列でも受け付けます。
以前の決定の `ALERT_WEBHOOK_URL`（URL 1つ）があれば、`type: webhook`・`receive: all` の送り先として足します。

### 9.2 種類ごとの送り方（`src/services/alerts.ts` の `formatRequest`）

| 種類 | 送る形 |
|---|---|
| `slack` / `google_chat` | `POST url`、本文 `{ "text": … }` |
| `discord` | `POST url`、本文 `{ "content": … }`（2000文字まで） |
| `teams` | `POST url`、Adaptive Card のメッセージ（`{ "type": "message", "attachments": [ … ] }`。Workflows の Webhook でも受け取れる形） |
| `line` | `POST https://api.line.me/v2/bot/message/push`、`Authorization: Bearer <token>`、本文 `{ "to": …, "messages": [{ "type": "text", "text": … }] }` |
| `webhook` | `POST url`、本文 `{ "source": "fieldos", "event", "severity", "title", "text", "ref", "path", "count", "at" }`（自分で受け取る仕組み向け） |
| `email` | Resend（`src/services/email.ts` の `sendEmail`。送信の記録は `email_logs`） |

- 送る中身は、件名・場所（パス。トークンは伏せる）・参照番号・件数・本部画面へのリンクだけです。利用者の名前・ID・入力値は入れません。
- 1つの送り先の失敗（通信できない・4xx・5xx・5秒で応答がない）は、ほかの送り先に影響しません。失敗は記録だけで、利用者への応答や定期処理の結果は変わりません。
- 送り先の URL・トークン・宛先は、画面・Workers Logs・`error_logs`・`alert_destination_status` に出しません。送り先は種類と URL などから作った短いハッシュ（`dest_key`）で見分けます。

### 9.3 何を・いつ送るか

| 通知 | 種類 | いつ |
|---|---|---|
| 打刻（`POST /api/staff/attendance`・`attendance-photo`）・日報の送信（`POST /api/staff/daily-report`）の失敗（5xx） | すぐに知らせる（critical） | 1件目から。同じ場所（打刻／日報）は `ERROR_ALERT_COOLDOWN_MINUTES` 分（既定60分）に1回まで。その間の件数は次の通知で「ほかにN件」と知らせる |
| エラーの急増（直近10分に10件以上。4 章） | すぐに知らせる（critical） | 今までどおり60分に1回まで |
| 定期処理の失敗 | そのほか | 同じ処理は60分に1回まで |
| DB の大きさ（10 章） | 緊急（90%）はすぐに知らせる、ほかはそのほか | 準備・着手は段階が上がった日に1回、警告・緊急は毎日 |
| 毎朝のまとめ（直近24時間のエラーの件数・失敗した定期処理・DB の大きさ） | 毎朝のまとめ（digest） | 毎朝8時以降の最初の15分おきの起動で1回 |

`all` の送り先はすべてを、`critical` の送り先は「すぐに知らせる」ものだけを、`digest` の送り先は毎朝のまとめだけを受け取ります。
打刻・日報の失敗・定期処理の失敗・DB の大きさは、本部の管理者全員へのアプリ内の通知（プッシュ通知も）も作ります（エラーの急増と同じ）。

### 9.4 本部画面

本部画面「障害」の「通知の送り先」に、送り先ごとの名前・種類・受け取る通知・最後の送信の結果（送れた／失敗と理由／未設定）を出します。
「テスト送信」でその送り先だけにテストの通知を送れます（同じ送り先は1分に1回まで）。

## 10. DB の大きさの見張り（#9971）

D1 の DB には上限があります（今の無料プランは 500MB、有料プランは 10GB）。上限に届くと書き込みができなくなるので、毎日大きさを記録し、届く前に知らせます。

- **取り方**: D1 の結果の `meta.size_after`（その文の後の DB の大きさ。バイト）を使います（`src/services/monitor.ts` の `measureDbSize`）。
  `PRAGMA page_count`・`page_size` は D1 では使えません（ローカルの D1 で `not authorized` になることを確かめた）。予備として残していますが、ふだんは `meta.size_after` で取れます。
- **上限**: `wrangler.jsonc` の vars の `DB_SIZE_LIMIT_MB`（ローカル・本番とも `500`）。**有料プランに切り替えたら、トップレベルと `env.production` の両方を `10240` に変えてデプロイします。** 割合・段階はこの値に対して計算します。
- **記録**: 毎朝8時以降の最初の15分おきの起動で1日1回（`monitor_daily`。`db_size_logs` に1日1行。済んだ後の起動は問い合わせ1回）。2年で消します。
- **増え方**: 直近3か月の記録（7日分以上あるとき）から、1か月の増え方・上限までの残り月数・80% と 100% に届く見込みの日を出します。

| 段階 | 目安 | 知らせ方 |
|---|---|---|
| 準備 | 上限の50%、または上限まで残り12か月 | 本部画面に出す。通知は段階が上がった日に1回 |
| 着手 | 上限の60%、または残り6か月（データを移す仕組み・有料プランへの切り替えに着手する） | 同上 |
| 警告 | 上限の80% | 毎日通知 |
| 緊急 | 上限の90% | 毎日通知（すぐに知らせる種類）＋ 本部画面のどのタブでも上部に赤い帯 |

本部画面「障害」の「DB の大きさ」に、今の大きさ・割合・1か月の増え方・残り月数・80% と 100% に届く見込みの日・直近の推移を出します。
「表ごとの行数を数える」を押すと、行の多い表を出します。すべての表のすべての行を読むので、D1 の1日の読み取りの枠を使います（画面に読んだ行数を出します。10分に1回まで。定期処理では数えません）。

## 11. 外からの死活監視（UptimeRobot など。#9973）

アプリが止まったこと（Cloudflare の障害・デプロイの失敗・D1 につながらないなど）に、アプリの外から気づけるようにします。

**確認の入口**: `GET /api/health`（ログイン不要。D1 に `SELECT 1` を1回投げるだけで、R2 には触らない）

| 状態 | 応答 |
|---|---|
| 動いている | `200` `{"ok":true,"version":"1a2b3c4d"}`（`version` はデプロイしたコミットの短い ID。ビルドのときに `vite.config.ts` が入れる） |
| D1 につながらない | `503` `{"error":"unavailable"}`（本文に `ok` を含めない） |

キャッシュさせません（`Cache-Control: no-store`）。内部の情報（件数・設定など）は返しません。`HEAD` でも答えます。

**UptimeRobot の設定（利用者が行う。アカウントと通知先は利用者が用意する）**

1. UptimeRobot にログイン → **Add New Monitor**。
2. **Monitor Type** は **Keyword**（キーワードの監視）を選ぶ。
3. **URL** に `https://<本番の URL>/api/health` を入れる（本番の URL は `wrangler.jsonc` の `env.production.vars.APP_BASE_URL`）。
4. **Keyword** に `"ok":true` を入れ、「キーワードが無いときに落ちたとみなす」（Alert When: Keyword Not Exists）を選ぶ。`ok` だけでもよい（落ちたときの応答には `ok` が入らない）。
5. **Monitoring Interval** を **5分**（無料プランの最短）にする。
6. **Alert Contacts**（通知先）に、担当者のメールアドレス・Slack などを選ぶ（先に **My Settings → Alert Contacts** で登録しておく）。
7. 保存したら、数分後に **Up** になることを確かめる。

5分ごとの確認は1日288回で、D1 の読み取りはほとんど使いません（`SELECT 1` は表を読まない）。
