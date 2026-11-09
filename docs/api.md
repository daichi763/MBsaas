# API 一覧

Field OS のサーバー（Cloudflare Workers + Hono）が受け付ける、すべてのエンドポイントの一覧です。新しく加わる開発者や外部の開発会社が、前提知識なしで読めるように書いています。

- 関連する資料: [DB 設計書](db.md)・[画面一覧](screens.md)
- 一覧（下の「4. エンドポイントの一覧」）はコードから生成しています。手で直さず、`npm run docs` で作り直してください（作り方は [DB 設計書](db.md) の「この資料の作り方」と同じです）。

## この資料の作り方

生成は、リポジトリの中のファイルだけで行います。本番には接続しません。

1. `src/api.ts` を esbuild で1つのファイルにまとめて Node.js で読み込み、Hono が持っているルートの一覧（`api.routes`。登録した順）を取ります。ここにはミドルウェア（`api.use`）も、登録した順に入っています。
2. `src/*.ts` のルートの定義の行（`api.get('/…'` など）を読み、1 と突き合わせて「定義（ファイル:行）」と「用途」を付けます。「用途」は、定義の直前のコメントです。コメントがなければ、上にあるいちばん近い見出しのコメントを「〔見出し〕」を付けて出します（離れた所の見出しのこともあるので、目安です）。
3. 「通すロール」は、そのルートより前に登録された、パスの当たるミドルウェアから計算します（Hono は登録した順に実行するので、認証のミドルウェアより前に登録したルートはログインなしで通ります）。ミドルウェアの意味は [`MIDDLEWARE_DEFS`](../scripts/gen-docs.mjs) に人が書いています。説明のないミドルウェアが増えると、生成のときに注意が出ます。
4. 「本文で確認」は、ルートの本文に、ロールを確かめる書き方（`HR_ROLES`・`role !== 'company_admin'` など）があるものです。文字を探しているだけなので、細かい条件は本文を読んで確かめてください。
5. 「画面の JS」は、`public/static/*.js`（と `src/index.tsx` の中の script）にある `/api/…` の文字列を読み、メソッドとパスの形が合うものです。見つからないものは、使っていないとは限りません（パスを組み立てて呼んでいる・Service Worker やメールのリンクから呼ぶ、など）。

ルートを足したり変えたりしたら、`npm run docs` で作り直します。`src/api.ts` 以外のファイルにルートを足したときは、`src/api.ts` の `api.route('/…', …)` で付けないと、ここにも出ません（サーバーでも動きません）。

## 1. 共通の約束

### 1.1 パスと形式

- API はすべて `/api` の下です。画面（HTML）と Service Worker・Webhook は `src/index.tsx` にあります（下の「3. 画面などのルート」）。
- 送るのも返すのも JSON です（CSV のダウンロードは除く。CSV は [`csvResponse`](../src/csv.ts) で返します）。
- エラーは `{ "error": "日本語の説明" }` で返します。画面が分岐に使う場合は `code`（例: `company_inactive`・`mfa_setup_required`・`account_switched`・`hq_view_readonly`）も付けます。
- 予期しないエラーは、`src/index.tsx` の `app.onError` が 500 と `{ "error": "…参照番号: xxxx", "ref": "xxxx" }` を返し、同じ参照番号で Workers のログに1行の JSON を残します（パスの中のトークンは [`maskPath`](../src/index.tsx) で伏せます）。

### 1.2 ログインとセッション

- ログインは `POST /api/auth/login`（二段階認証がある人は続けて `POST /api/auth/login/mfa`）。成功すると、Cookie `session`（[`SESSION_COOKIE`](../src/lib/auth.ts)。HttpOnly・SameSite=Lax・https では Secure。[`sessionCookieOptions`](../src/lib/auth.ts)）が付きます。
- `/api/*` の認証のミドルウェア（`src/api.ts` の `api.use('/*', …)`）が、Cookie のセッションを確かめます。期限切れ・退職・停止中の会社は 401 か 403 です。
- 操作のたびに、セッションの期限を延ばします。延ばす幅と最長の期間はロールで違います（[`SESSION_IDLE_HOURS`](../src/api.ts)・[`SESSION_MAX_DAYS`](../src/api.ts)。既定は [`SESSION_HOURS`](../src/lib/auth.ts)）。

### 1.3 画面が付けるヘッダー

| ヘッダー | 意味 |
|---|---|
| `X-Expected-User-Id` | 画面を開いたときの利用者の ID。同じブラウザで別の人がログインし直していたら、409（`account_switched`）で止めます |
| `X-Background: 1` | バッジの更新などの定期の取得。セッションの期限を延ばさず、最後に使った日時も更新しません |
| `X-HQ-View: 1` | 本部の利用者が、企業の管理画面を閲覧しているとき（読み取り専用。下の 2） |

### 1.4 書き込みの後の処理

- GET 以外の API の応答の後に、積まれたプッシュ通知（`push_queue`）を送ります（`src/index.tsx` の `app.use('/api/*', …)`）。

### 1.5 入力のチェック

- 共通の部品は [`isISODate`](../src/lib/validate.ts)・[`isHHMM`](../src/lib/validate.ts)・[`toInt`](../src/lib/validate.ts)・[`oneOf`](../src/lib/validate.ts) などです。各ルートの本文で、受け取った値をこれらで確かめてから使います。
- ID で1行を取るときは、その行が自社のものかを [`ownStaff`](../src/lib/tenant.ts) などで確かめます（[DB 設計書](db.md) の 2.1）。
- Free プランの CPU 時間（1回 10ms）に収めるため、一覧や一括の処理には件数の上限があります。上限はルートごとに違うので、本文の定数を見てください。

## 2. ロールと権限

| ロール（`users.role`） | 画面 | 使える API |
|---|---|---|
| `staff` | `/staff`（スタッフアプリ） | `/api/staff/*`・`/api/auth/*` |
| `company_admin`（会社管理者） | `/admin` | `/api/admin/*` のすべて・`/api/auth/*` |
| `office_staff`（事務） | `/admin` | `/api/admin/*`（会社管理者だけのものを除く）。労務情報（従業員管理・休暇の申請）も使えます |
| `sales_manager`（営業）・`field_manager`（現場責任者） | `/admin` | `/api/admin/*`（会社管理者だけのものと、労務情報（従業員管理・休暇の申請）を除く） |
| `system_admin`（本部） | `/hq` | `/api/hq/*`・`/api/auth/*`。企業が許可した閲覧の間は `/api/admin/*` の GET だけ（`sales_manager` と同じ扱い） |
| ログインなし | `/r/:token`・`/apply/:token` など | `/api/public/*`（URL のトークンで確かめる）・`/api/auth/login` など |

- 「管理者（4ロール）」は、`company_admin`・`sales_manager`・`field_manager`・`office_staff` のことです（`src/api.ts` の `ADMIN_ROLES`）。
- 「会社管理者・事務」は労務情報を扱えるロールです（`src/api.ts` の `HR_ROLES`）。
- 本部の閲覧の仕組みは [`hqViewAdminGuard`](../src/hq-support.ts) にあります。閲覧の操作は `hq_view_logs` に残ります。
- 本部の書き込みは、`hq_audit_logs` に記録します。

## 3. 全体の数

<!-- BEGIN GENERATED: api-summary -->
- エンドポイント: 564（GET 257・POST 194・PUT 78・PATCH 0・DELETE 35）
- ミドルウェア: 22・画面などのルート（src/index.tsx）: 12
- 画面の JS（public/static）から呼んでいる形が見つかったもの: 551・見つからないもの: 13

| 区分 | 数 |
|---|---|
| `/api/public/…` 公開（ログイン不要。トークンの URL） | 10 |
| `/api/auth/…` ログイン・自分のアカウント | 17 |
| `/api/staff/…` スタッフアプリ | 85 |
| `/api/admin/…` 管理画面 | 389 |
| `/api/hq/…` 本部画面 | 63 |

| 通すロール | 数 |
|---|---|
| 管理者（4ロール） | 200 |
| 管理者（4ロール）＋本部の閲覧（GET） | 166 |
| スタッフ | 85 |
| 本部 | 63 |
| ログイン不要 | 16 |
| 会社管理者・事務 | 13 |
| ログイン中の全員 | 11 |
| 会社管理者 | 10 |
<!-- END GENERATED: api-summary -->

### ミドルウェア（登録した順）

<!-- BEGIN GENERATED: api-middlewares -->
| 順 | パス | 定義 | 内容 |
|---|---|---|---|
| 1 | `/api/public/recruit/:token/*` | [recruit.ts:248](../src/recruit.ts#L248) | 募集ページの会社が停止中なら 410 |
| 2 | `/api/*` | [api.ts:745](../src/api.ts#L745) | ログイン必須（セッションの確認・延長・二段階認証の登録待ちの制限） |
| 3 | `/api/auth/*` | [api.ts:825](../src/api.ts#L825) | 本部の閲覧中は書き込み不可 |
| 4 | `/api/admin/*` | [api.ts:848](../src/api.ts#L848) | 本部は、企業が許可した閲覧の間だけ GET を通す（閲覧中は sales_manager として扱う） |
| 5 | `/api/admin/*` | [api.ts:849](../src/api.ts#L849) | 管理系の4ロールだけ |
| 6 | `/api/admin/employees` | [api.ts:858](../src/api.ts#L858) | 会社管理者・事務担当だけ（労務情報） |
| 7 | `/api/admin/employees/*` | [api.ts:859](../src/api.ts#L859) | 会社管理者・事務担当だけ（労務情報） |
| 8 | `/api/hq/*` | [api.ts:860](../src/api.ts#L860) | 本部（system_admin）だけ |
| 9 | `/api/hq/*` | [api.ts:867](../src/api.ts#L867) | 本部の書き込みを hq_audit_logs に記録 |
| 10 | `/api/staff/*` | [api.ts:887](../src/api.ts#L887) | スタッフだけ |
| 11 | `/api/admin/security/settings` | [api.ts:1106](../src/api.ts#L1106) | 会社管理者だけ（セキュリティの設定・ログインの履歴） |
| 12 | `/api/admin/security/users` | [api.ts:1107](../src/api.ts#L1107) | 会社管理者だけ（セキュリティの設定・ログインの履歴） |
| 13 | `/api/admin/security/users/*` | [api.ts:1108](../src/api.ts#L1108) | 会社管理者だけ（セキュリティの設定・ログインの履歴） |
| 14 | `/api/admin/login-history` | [api.ts:1109](../src/api.ts#L1109) | 会社管理者だけ（セキュリティの設定・ログインの履歴） |
| 15 | `/api/admin/users` | [accounts.ts:304](../src/accounts.ts#L304) | 会社管理者だけ（管理者アカウントの管理） |
| 16 | `/api/admin/users/*` | [accounts.ts:305](../src/accounts.ts#L305) | 会社管理者だけ（管理者アカウントの管理） |
| 17 | `/api/admin/roster/*` | [roster.ts:589](../src/roster.ts#L589) | 会社の連携用の識別子を用意する（権限の制限なし） |
| 18 | `/api/admin/staff-requests/leave` | [staff-self-service.ts:544](../src/staff-self-service.ts#L544) | 会社管理者・事務担当だけ（休暇の申請） |
| 19 | `/api/admin/staff-requests/leave/*` | [staff-self-service.ts:545](../src/staff-self-service.ts#L545) | 会社管理者・事務担当だけ（休暇の申請） |
| 20 | `/api/admin/roster-chat/*` | [roster-chat.ts:22](../src/roster-chat.ts#L22) | 管理系の4ロールだけ（企業間チャット） |
| 21 | `/api/staff/attendance` | [api.ts:1779](../src/api.ts#L1779) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の回数・過負荷のまね。src/lib/d1-retry.ts） |
| 22 | `/api/staff/attendance-photo` | [api.ts:1780](../src/api.ts#L1780) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の回数・過負荷のまね。src/lib/d1-retry.ts） |
<!-- END GENERATED: api-middlewares -->

### 画面などのルート（src/index.tsx）

<!-- BEGIN GENERATED: api-pages -->
| メソッド | パス | 定義 | 用途 |
|---|---|---|---|
| GET | `/sw.js` | [index.tsx:120](../src/index.tsx#L120) | Service Worker（スタッフ画面・本部画面・管理画面のプッシュ通知の表示。#178 #9622 #552） |
| POST | `/webhooks/resend` | [index.tsx:124](../src/index.tsx#L124) | ログイン不要。署名（RESEND_WEBHOOK_SECRET。wrangler secret で登録する）を確かめてから送信の記録を更新する（src/services/email.ts） |
| GET | `/` | [index.tsx:167](../src/index.tsx#L167) | ルート: ロール別リダイレクト |
| GET | `/login` | [index.tsx:187](../src/index.tsx#L187) | ログイン済みならホームへ移す（入力し直しと、不要なセッションの増加を防ぐ） |
| GET | `/reset-password` | [index.tsx:416](../src/index.tsx#L416) | パスワード再設定ページ（メール内リンクからアクセス。トークンはクエリパラメータで受け取る） |
| GET | `/verify-email` | [index.tsx:497](../src/index.tsx#L497) | ログイン用メールアドレスの確認ページ（#207。管理者が登録したアドレスに届いたリンクから開く）。 メールソフトのリンクの事前読み込みで確認済みにならないよう、ボタンを押したときに確認する |
| GET | `/notice-ack` | [index.tsx:545](../src/index.tsx#L545) | お知らせメールの「確認しました」（#454。メールのリンクから開く）。 メールソフトのリンクの事前読み込みで既読にならないよう、ボタンを押したときに既読にする（/api/public/notice-ack） |
| GET | `/r/:token` | [index.tsx:603](../src/index.tsx#L603) | シフト専用の報告用URL（ログイン不要。public/static/report-link.js） |
| GET | `/apply/:token` | [index.tsx:617](../src/index.tsx#L617) | 公開の募集ページ（ログイン不要。/api/public/recruit/:token） |
| GET | `/staff` | [index.tsx:631](../src/index.tsx#L631) | スタッフ画面 (スマホファースト SPA) |
| GET | `/admin` | [index.tsx:679](../src/index.tsx#L679) | 管理者画面 (PC向け SPA) |
| GET | `/hq` | [index.tsx:807](../src/index.tsx#L807) | SaaS本部管理画面 |
<!-- END GENERATED: api-pages -->

## 4. エンドポイントの一覧

パスの `:id` などはパラメーター、`:id{[0-9]+}` は数字だけを受け付けるパラメーターです。

<!-- BEGIN GENERATED: api-endpoints -->
### `/api/public/…` 公開（ログイン不要。トークンの URL）（10）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/public/calendar/:file` | ログイン不要 | [staff-schedule.ts:223](../src/staff-schedule.ts#L223) | 〔見出し〕購読用（ログイン不要。/api/public/calendar/<トークン>.ics） |  |
| GET | `/api/public/notice-ack` | ログイン不要 | [notifications.ts:1193](../src/notifications.ts#L1193) | 〔見出し〕お知らせメールの「確認しました」のリンク（#454） | src/index.tsx |
| POST | `/api/public/notice-ack` | ログイン不要 | [notifications.ts:1198](../src/notifications.ts#L1198) | 〔見出し〕お知らせメールの「確認しました」のリンク（#454） | src/index.tsx |
| GET | `/api/public/recruit/:token` | ログイン不要 | [recruit.ts:256](../src/recruit.ts#L256) | 〔見出し〕公開ページ（ログイン不要） | apply.js |
| POST | `/api/public/recruit/:token/apply` | ログイン不要 | [recruit.ts:299](../src/recruit.ts#L299) | 〔見出し〕公開ページ（ログイン不要） | apply.js |
| GET | `/api/public/report/:token` | ログイン不要 | [staff-lifecycle.ts:1450](../src/staff-lifecycle.ts#L1450) | 〔見出し〕ログイン不要の報告用URL（/api/public/report/:token） | report-link.js |
| POST | `/api/public/report/:token/attendance` | ログイン不要 | [staff-lifecycle.ts:1492](../src/staff-lifecycle.ts#L1492) | 〔見出し〕ログイン不要の報告用URL（/api/public/report/:token） | report-link.js |
| POST | `/api/public/report/:token/consultation` | ログイン不要 | [staff-lifecycle.ts:1669](../src/staff-lifecycle.ts#L1669) | 〔見出し〕報告用URL・予定確認URLからの連絡（#163） | report-link.js |
| GET | `/api/public/report/:token/contact` | ログイン不要 | [api.ts:722](../src/api.ts#L722) | 報告用URLに出す会社の緊急連絡先（#173）。期限切れ・取り消し後の画面でも連絡できるよう、発行済みのURLなら返す（停止中の企業は返さない）。 返すのは会社名と連絡先だけ（シフト・スタッフの情報は返さない） | report-link.js |
| POST | `/api/public/report/:token/daily-report` | ログイン不要 | [staff-lifecycle.ts:1560](../src/staff-lifecycle.ts#L1560) | 〔見出し〕ログイン不要の報告用URL（/api/public/report/:token） | report-link.js |

### `/api/auth/…` ログイン・自分のアカウント（17）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/auth/account` | ログイン中の全員 | [accounts.ts:192](../src/accounts.ts#L192) | 〔見出し〕自分のアカウント（/api/auth/*。ログインしている全ロール） | admin.js |
| PUT | `/api/auth/account` | ログイン中の全員 | [accounts.ts:208](../src/accounts.ts#L208) | 氏名・メールアドレスの変更（管理者・本部のみ。スタッフの登録情報は所属会社が管理する） メールアドレスの変更は乗っ取りの踏み台になるため、現在のパスワードを確かめる | admin.js |
| POST | `/api/auth/change-password` | ログイン中の全員<br>＋本文で確認: 会社管理者 | [accounts.ts:254](../src/accounts.ts#L254) | パスワードの変更（スタッフ・管理者・本部の全員）。ほかの端末のセッションは消し、この端末はログインしたままにする | admin.js staff-profile.js |
| POST | `/api/auth/forgot-password` | ログイン不要 | [api.ts:601](../src/api.ts#L601) | パスワード再設定メールの送信リクエスト セキュリティ: メールアドレスの存在有無に関わらず常に同じレスポンスを返す（アカウント存在の推測を防ぐ） | src/index.tsx |
| POST | `/api/auth/login` | ログイン不要 | [api.ts:453](../src/api.ts#L453) | 〔見出し〕Auth | admin.js src/index.tsx |
| POST | `/api/auth/login/mfa` | ログイン不要 | [api.ts:543](../src/api.ts#L543) | 二段階認証のコード（認証アプリの6桁、または予備コード）を確かめてログインする（#544） | admin.js src/index.tsx |
| POST | `/api/auth/logout` | ログイン不要 | [api.ts:705](../src/api.ts#L705) | 〔見出し〕Auth | admin.js hq.js staff.js |
| POST | `/api/auth/logout-all` | ログイン中の全員<br>＋本文で確認: 会社管理者 | [api.ts:1091](../src/api.ts#L1091) | 〔見出し〕自分のログイン中の端末と、すべての端末からのログアウト（#453。全ロール） | security.js staff-profile.js |
| GET | `/api/auth/me` | ログイン中の全員<br>＋本文で確認: 人事のロール | [api.ts:831](../src/api.ts#L831) | 〔見出し〕Auth | admin.js corrections.js hq.js staff-profile.js staff.js |
| GET | `/api/auth/mfa` | ログイン中の全員 | [api.ts:1021](../src/api.ts#L1021) | 〔見出し〕自分の二段階認証（本部・管理画面のアカウント） | security.js |
| POST | `/api/auth/mfa/disable` | ログイン中の全員 | [api.ts:1056](../src/api.ts#L1056) | 解除: 現在のパスワードと、認証アプリのコード（または予備コード）を確かめる。必須の設定のときは解除できない | security.js |
| POST | `/api/auth/mfa/enable` | ログイン中の全員 | [api.ts:1038](../src/api.ts#L1038) | 登録の完了: 認証アプリの6桁と現在のパスワードを確かめて有効にし、予備コードを一度だけ返す | security.js |
| POST | `/api/auth/mfa/recovery-codes` | ログイン中の全員 | [api.ts:1073](../src/api.ts#L1073) | 予備コードを作り直す（以前の予備コードは使えなくなる） | security.js |
| POST | `/api/auth/mfa/setup` | ログイン中の全員 | [api.ts:1028](../src/api.ts#L1028) | 登録の開始: 秘密鍵を作り、認証アプリに登録する URI（QR コード）を返す。コードを確かめるまでは有効にしない | security.js |
| POST | `/api/auth/reset-password` | ログイン不要 | [api.ts:653](../src/api.ts#L653) | パスワード再設定の実行（トークンは生の値では保存されておらずハッシュ照合、1回使用したら失効） | src/index.tsx |
| GET | `/api/auth/sessions` | ログイン中の全員 | [api.ts:1085](../src/api.ts#L1085) | 〔見出し〕自分のログイン中の端末と、すべての端末からのログアウト（#453。全ロール） | security.js staff-profile.js |
| POST | `/api/auth/verify-email` | ログイン不要 | [api.ts:682](../src/api.ts#L682) | ログイン用メールアドレスの確認（#207）。管理者が登録したアドレスに届いたリンク（/verify-email）から、本人が確認したときに有効にする | src/index.tsx |

### `/api/staff/…` スタッフアプリ（85）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| POST | `/api/staff/attendance` | スタッフ | [api.ts:1783](../src/api.ts#L1783) | 勤怠報告（写真なし。写真が必須の入店・退店は、会社が許可していれば理由つきで写真なしで受け付ける #535） | staff.js |
| POST | `/api/staff/attendance-photo` | スタッフ | [api.ts:1794](../src/api.ts#L1794) | 勤怠報告（写真必須：入店報告・退店報告専用） フロント側で圧縮済みのJPEG/PNGをmultipart/form-dataで受け取り、R2へ保存する | staff.js |
| GET | `/api/staff/attendance-photo/*` | スタッフ | [api.ts:1830](../src/api.ts#L1830) | 勤怠報告に添付された写真の取得（スタッフ本人の報告の写真だけ。連携先の会社のシフトも person 単位で本人とみなす #217） |  |
| POST | `/api/staff/attendance/no-break` | スタッフ | [api.ts:1643](../src/api.ts#L1643) | 〔見出し〕勤怠報告の『休憩なし』と、押し間違いの取消（#324 #323） | staff.js |
| GET | `/api/staff/attendance/timeline` | スタッフ | [corrections.ts:1135](../src/corrections.ts#L1135) | 日付ごとのタイムライン（既定: 直近 14 日。最大 62 日） | staff-attendance.js |
| POST | `/api/staff/attendance/withdraw` | スタッフ | [api.ts:1681](../src/api.ts#L1681) | 〔見出し〕勤怠報告の『休憩なし』と、押し間違いの取消（#324 #323） | staff.js |
| GET | `/api/staff/availability` | スタッフ | [staff-schedule.ts:75](../src/staff-schedule.ts#L75) | 月の出勤可能日（本人の入力・締切・提出の記録と、参考にその月のシフト）。?month= の既定は翌月 | staff.js |
| PUT | `/api/staff/availability` | スタッフ | [staff-schedule.ts:119](../src/staff-schedule.ts#L119) | 月の出勤可能日をまとめて提出する。days: [{ date, status: ok\|partial\|ng, start_time, end_time, note }]。 その月の今日以降の日は、送った日の分だけに置き換える（送らなかった日は未入力に戻る） | staff.js |
| GET | `/api/staff/availability/summary` | スタッフ | [staff-schedule.ts:106](../src/staff-schedule.ts#L106) | シフト画面の案内用: 翌月の提出状況と締切だけ。target が false（回収の対象外）の人には、画面は未提出の案内を出さない | staff.js |
| GET | `/api/staff/badges` | スタッフ | [api.ts:2288](../src/api.ts#L2288) | 下のタブ・その他のメニューに出す未読の件数（#383）。画面を切り替えるたびに呼ぶので、件数だけを返す軽い API にする。 notices: 今の企業の未読のお知らせ、notices_other: 切り替えていない所属企業の未読、notifications: 未読の通知（同じ人の全所属の分。通知の一覧と同じ範囲） | staff.js |
| DELETE | `/api/staff/calendar-token` | スタッフ | [staff-schedule.ts:191](../src/staff-schedule.ts#L191) | 購読 URL を止める | staff.js |
| GET | `/api/staff/calendar-token` | スタッフ | [staff-schedule.ts:175](../src/staff-schedule.ts#L175) | 購読 URL の状態（URL そのものはハッシュで保存しているため返せない。分からなくなったら発行し直す） | staff.js |
| POST | `/api/staff/calendar-token` | スタッフ | [staff-schedule.ts:181](../src/staff-schedule.ts#L181) | 購読 URL を発行する（すでにあれば発行し直し、前の URL は使えなくなる） | staff.js |
| GET | `/api/staff/consultation-photo/:id{[0-9]+}` | スタッフ | [api.ts:2730](../src/api.ts#L2730) | 相談の写真の取得（本人の相談の写真だけ） | staff.js |
| GET | `/api/staff/consultations` | スタッフ | [api.ts:2518](../src/api.ts#L2518) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| POST | `/api/staff/consultations` | スタッフ | [api.ts:2554](../src/api.ts#L2554) | 送り先の会社: 対象のシフトを選んだらそのシフトの会社、なければ選んだ会社（本人の所属に限る）、なければ今の会社（#222） | staff.js |
| POST | `/api/staff/consultations/:id{[0-9]+}/messages` | スタッフ | [api.ts:2654](../src/api.ts#L2654) | スタッフの追加の連絡。対応済みの相談に送ったら未対応に戻し、管理者に知らせる | staff.js |
| POST | `/api/staff/consultations/:id{[0-9]+}/photos` | スタッフ | [api.ts:2683](../src/api.ts#L2683) | 写真を1枚ずつ付ける（multipart/form-data: photo、追加の連絡に付けるときは message_id） | staff.js |
| POST | `/api/staff/consultations/read-replies` | スタッフ | [api.ts:2544](../src/api.ts#L2544) | 管理者の返信を読んだ（相談・連絡の画面を開いた）。本人の全所属企業の分を既読にする（#320） | staff.js |
| GET | `/api/staff/corrections` | スタッフ | [corrections.ts:1188](../src/corrections.ts#L1188) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| POST | `/api/staff/corrections` | スタッフ | [corrections.ts:1209](../src/corrections.ts#L1209) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| GET | `/api/staff/corrections/:id{[0-9]+}` | スタッフ | [corrections.ts:1204](../src/corrections.ts#L1204) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| POST | `/api/staff/corrections/:id{[0-9]+}/attachments` | スタッフ | [corrections.ts:1263](../src/corrections.ts#L1263) | 申請に写真・画像（店舗の入退館記録・画面の写しなど）を添付する（#485）。multipart/form-data: photo（画面で圧縮した JPEG/PNG）、photo_taken_at、photo_source。 申請者本人が、承認待ちの申請に1枚ずつ送る（1申請に ATTACHMENT_MAX 枚まで）。… | staff-attendance.js |
| POST | `/api/staff/corrections/:id{[0-9]+}/cancel` | スタッフ | [corrections.ts:1243](../src/corrections.ts#L1243) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| POST | `/api/staff/corrections/:id{[0-9]+}/resubmit` | スタッフ | [corrections.ts:1248](../src/corrections.ts#L1248) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| GET | `/api/staff/corrections/attachments/:aid{[0-9]+}` | スタッフ | [corrections.ts:1295](../src/corrections.ts#L1295) | 自分の申請に添付した画像 | staff-attendance.js |
| POST | `/api/staff/corrections/bulk` | スタッフ | [corrections.ts:1225](../src/corrections.ts#L1225) | まとめて申請（#214）: { shift_id, reason, items: [{ report_type, requested_at }], dry_run }。申請の種類（時刻修正・打刻漏れの追加）は今の記録から決める | staff-attendance.js |
| POST | `/api/staff/daily-report` | スタッフ | [api.ts:1961](../src/api.ts#L1961) | 日報提出（シフトごとに1件。同じシフトに再提出すると上書きし、管理者の確認済みを外す） | staff.js |
| GET | `/api/staff/daily-report/:shiftId` | スタッフ | [api.ts:1915](../src/api.ts#L1915) | 日報の入力画面: 対象シフトと日報テンプレート、提出済みの内容（修正して再提出するときの初期値）。 前日以前のシフト（未提出の日報の一覧から選んだもの）も同じ形で返す | staff.js |
| POST | `/api/staff/day-before-confirm` | スタッフ | [api.ts:1581](../src/api.ts#L1581) | 〔見出し〕スタッフホーム | staff.js |
| GET | `/api/staff/emergency-contacts` | スタッフ | [api.ts:1865](../src/api.ts#L1865) | スタッフ: 所属・連携している会社の緊急連絡先（#173）。ログイン中の会社を先に、登録のある会社だけを返す（停止中の企業は返さない） | staff.js |
| GET | `/api/staff/handover/:shiftId` | スタッフ | [api.ts:2121](../src/api.ts#L2121) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/home` | スタッフ | [api.ts:1508](../src/api.ts#L1508) | スタッフホーム。?shift_id= で対象のシフトを選べる（本日のシフトと前日からの日をまたぐシフトの中から） | staff.js |
| GET | `/api/staff/manuals` | スタッフ | [api.ts:2485](../src/api.ts#L2485) | 研修・マニュアル（#74）: 本人がシフトに入っている案件（直近30日〜今後。同一人物の全所属。欠勤を除く）の、案件マニュアル・注意事項と求められる内容 | staff.js |
| GET | `/api/staff/me/companies` | スタッフ | [roster.ts:1586](../src/roster.ts#L1586) | 所属企業の一覧（統合ログインの企業切替用）。企業ごとの未読のお知らせの件数も返す（#203。切り替えていない企業の未読に気づけるように） | staff-profile.js |
| GET | `/api/staff/me/profile` | スタッフ | [roster.ts:1527](../src/roster.ts#L1527) | 〔見出し〕スタッフ本人向け（/api/staff/me/*） | staff-profile.js |
| POST | `/api/staff/me/switch-company` | スタッフ | [roster.ts:1593](../src/roster.ts#L1593) | 企業切替: セッションを同一人物の別企業ユーザー行に付け替える（ログインは1つのまま。再ログイン不要） | staff-profile.js |
| GET | `/api/staff/my-reports` | スタッフ | [api.ts:2092](../src/api.ts#L2092) | 自分の日報一覧（過去の日報。#319 #371）。同一人物の全所属の分を新しい順に。項目の表示名は案件のテンプレートから付ける | staff.js |
| GET | `/api/staff/my-reports/:id{[0-9]+}` | スタッフ | [api.ts:2059](../src/api.ts#L2059) | 自分の日報1件（#158。通知から開く・一覧の先頭30件より前の日報も開けるように）。開いたら管理者のコメントを既読にする | staff.js |
| POST | `/api/staff/my-reports/:id{[0-9]+}/comment-read` | スタッフ | [api.ts:2081](../src/api.ts#L2081) | 管理者のコメントを既読にする（#158。一覧でコメントを開いたとき） | staff.js |
| GET | `/api/staff/notices` | スタッフ | [api.ts:2263](../src/api.ts#L2263) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/notices/:id{[0-9]+}` | スタッフ | [api.ts:2307](../src/api.ts#L2307) | お知らせの個別画面（#333）。今の企業に無ければ、同じ人のほかの所属企業のお知らせかを調べ、切り替え先を返す | staff.js |
| GET | `/api/staff/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}` | スタッフ | [api.ts:2362](../src/api.ts#L2362) | お知らせの添付（#555）。配信先の本人だけが取得できる（一覧に出す条件と同じ。掲載期限を過ぎたものも取得できる） | staff.js |
| POST | `/api/staff/notices/:id{[0-9]+}/read` | スタッフ | [api.ts:2324](../src/api.ts#L2324) | 確認しました（既読）。自社のお知らせで、本人が配信対象のものだけ既読にできる（一覧に出す条件と同じ） | staff.js |
| POST | `/api/staff/notices/:id{[0-9]+}/response` | スタッフ | [api.ts:2336](../src/api.ts#L2336) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| POST | `/api/staff/notices/read-all` | スタッフ | [api.ts:2370](../src/api.ts#L2370) | まとめて確認（#553）。画面に出ていた未読（ids）のうち、既読確認が必須・緊急でないものだけを既読にする | staff.js |
| GET | `/api/staff/notification-prefs` | スタッフ | [notifications.ts:1752](../src/notifications.ts#L1752) | 〔見出し〕受け取り設定の API | staff.js |
| PUT | `/api/staff/notification-prefs` | スタッフ<br>＋本文で確認: NOTIFY_ADMIN_ROLES | [notifications.ts:1757](../src/notifications.ts#L1757) | 〔見出し〕受け取り設定の API | staff.js |
| GET | `/api/staff/notifications` | スタッフ | [notifications.ts:417](../src/notifications.ts#L417) | 絞り込み（#380）: unread=1 で未読だけ、kind で種類、before（notification_id）で続きを取る。limit は 1〜100（既定 100） | staff-attendance.js staff-profile.js staff.js |
| POST | `/api/staff/notifications/:id{[0-9]+}/read` | スタッフ | [notifications.ts:453](../src/notifications.ts#L453) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | staff-attendance.js staff-profile.js staff.js |
| POST | `/api/staff/notifications/read-all` | スタッフ | [notifications.ts:436](../src/notifications.ts#L436) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | staff-attendance.js |
| POST | `/api/staff/notifications/read-related` | スタッフ | [notifications.ts:443](../src/notifications.ts#L443) | kind（と related_id）で既読にする（募集の応募一覧を開いたときなど、通知を開かずに対応したとき。#150） |  |
| GET | `/api/staff/notifications/unread-count` | スタッフ | [notifications.ts:435](../src/notifications.ts#L435) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications |  |
| GET | `/api/staff/pay` | スタッフ | [staff-pay.ts:99](../src/staff-pay.ts#L99) | 月（month=YYYY-MM。既定は今月）の自分のシフトの実働時間・支払額・申請と、月の集計 | staff-attendance.js |
| POST | `/api/staff/pay/requests` | スタッフ | [staff-pay.ts:183](../src/staff-pay.ts#L183) | 申請: { shift_id, kind: 'transport', amount, route, round_trip, reason } / { shift_id, kind: 'overtime', new_end_time, instructed_by, reason } | staff-attendance.js |
| POST | `/api/staff/pay/requests/:id{[0-9]+}/cancel` | スタッフ | [staff-pay.ts:280](../src/staff-pay.ts#L280) | 本人の取り消し（承認待ちのものだけ） | staff-attendance.js |
| GET | `/api/staff/pay/requests/:id{[0-9]+}/receipt` | スタッフ | [staff-pay.ts:272](../src/staff-pay.ts#L272) | 自分の申請の領収書の写真 | staff-attendance.js |
| POST | `/api/staff/pay/requests/:id{[0-9]+}/receipt` | スタッフ | [staff-pay.ts:238](../src/staff-pay.ts#L238) | 領収書の写真を付ける・差し替える（#273。本人の、承認待ちの交通費の申請だけ）。multipart/form-data: photo（画面で圧縮した JPEG/PNG） | staff-attendance.js |
| GET | `/api/staff/pending-daily-reports` | スタッフ | [api.ts:1936](../src/api.ts#L1936) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/performance` | スタッフ | [api.ts:2387](../src/api.ts#L2387) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/photo-options` | スタッフ | [api.ts:1858](../src/api.ts#L1858) | 写真が送れないときの扱い（#535）。スタッフ: シフトの所有企業が写真なしの報告を許可しているかと、理由の選択肢 | staff.js |
| GET | `/api/staff/push/config` | スタッフ | [notifications.ts:1952](../src/notifications.ts#L1952) | 〔見出し〕プッシュ通知（#178） | staff.js |
| GET | `/api/staff/push/latest` | スタッフ | [notifications.ts:2015](../src/notifications.ts#L2015) | 〔見出し〕プッシュ通知（#178） |  |
| POST | `/api/staff/push/subscribe` | スタッフ | [notifications.ts:1965](../src/notifications.ts#L1965) | 〔見出し〕プッシュ通知（#178） | staff.js |
| POST | `/api/staff/push/test` | スタッフ | [notifications.ts:1995](../src/notifications.ts#L1995) | テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す） | staff.js |
| POST | `/api/staff/push/unsubscribe` | スタッフ | [notifications.ts:1987](../src/notifications.ts#L1987) | 〔見出し〕プッシュ通知（#178） | staff.js |
| GET | `/api/staff/self/documents` | スタッフ | [staff-self-service.ts:270](../src/staff-self-service.ts#L270) | 〔見出し〕#288 書類の提出 | staff-profile.js |
| POST | `/api/staff/self/documents` | スタッフ<br>＋本文で確認: ADMIN_NOTIFY_ROLES | [staff-self-service.ts:278](../src/staff-self-service.ts#L278) | 〔見出し〕#288 書類の提出 | staff-profile.js |
| DELETE | `/api/staff/self/documents/:id` | スタッフ | [staff-self-service.ts:333](../src/staff-self-service.ts#L333) | 本人が削除できるのは、担当者がまだ確認していない書類だけ（D1 を先に消し、R2 は後で消す） | staff-profile.js |
| GET | `/api/staff/self/documents/:id/download` | スタッフ | [staff-self-service.ts:317](../src/staff-self-service.ts#L317) | 本人が出した書類だけを開ける（管理者が登録した書類・ほかの人の書類は開けない） | staff-profile.js |
| GET | `/api/staff/self/leave` | スタッフ | [staff-self-service.ts:365](../src/staff-self-service.ts#L365) | 〔見出し〕#289 有給の残日数と休暇の申請 | staff-profile.js |
| POST | `/api/staff/self/leave` | スタッフ<br>＋本文で確認: 人事のロール | [staff-self-service.ts:376](../src/staff-self-service.ts#L376) | 〔見出し〕#289 有給の残日数と休暇の申請 | staff-profile.js |
| POST | `/api/staff/self/leave/:id/cancel` | スタッフ | [staff-self-service.ts:408](../src/staff-self-service.ts#L408) | 〔見出し〕#289 有給の残日数と休暇の申請 | staff-profile.js |
| GET | `/api/staff/self/profile-requests` | スタッフ | [staff-self-service.ts:196](../src/staff-self-service.ts#L196) | 〔見出し〕スタッフ本人の API（/api/staff/self/*） | staff-profile.js |
| POST | `/api/staff/self/profile-requests` | スタッフ<br>＋本文で確認: ADMIN_NOTIFY_ROLES | [staff-self-service.ts:210](../src/staff-self-service.ts#L210) | 〔見出し〕スタッフ本人の API（/api/staff/self/*） | staff-profile.js |
| POST | `/api/staff/self/profile-requests/:id/cancel` | スタッフ | [staff-self-service.ts:244](../src/staff-self-service.ts#L244) | 〔見出し〕スタッフ本人の API（/api/staff/self/*） | staff-profile.js |
| GET | `/api/staff/self/summary` | スタッフ | [staff-self-service.ts:191](../src/staff-self-service.ts#L191) | 『その他』のメニューの出し分け（有給・休暇は自社雇用の社員だけ） | staff-profile.js |
| POST | `/api/staff/shift-requests/:id/cancel` | スタッフ | [api.ts:2236](../src/api.ts#L2236) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） |  |
| GET | `/api/staff/shifts` | スタッフ | [api.ts:2195](../src/api.ts#L2195) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/shifts/:id/coworkers` | スタッフ | [api.ts:2168](../src/api.ts#L2168) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/shifts/:id/ics` | スタッフ | [staff-schedule.ts:198](../src/staff-schedule.ts#L198) | シフト1件の .ics（本人＝同じ人のほかの会社の分も含む。確定・代打だけ） | staff.js |
| POST | `/api/staff/shifts/:id/reply` | スタッフ | [api.ts:2239](../src/api.ts#L2239) | 管理者が『希望（仮）』で入れたシフトへの返事（#411）。answer: ok（入れます）/ ng（入れません） | staff.js |
| POST | `/api/staff/shifts/request` | スタッフ | [api.ts:2235](../src/api.ts#L2235) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） |  |
| GET | `/api/staff/tours` | スタッフ | [tours.ts:100](../src/tours.ts#L100) |  | tour.js |
| PUT | `/api/staff/tours` | スタッフ | [tours.ts:110](../src/tours.ts#L110) |  | tour.js |

### `/api/admin/…` 管理画面（389）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/admin/analytics` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6449](../src/api.ts#L6449) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/analytics/csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6575](../src/api.ts#L6575) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/analytics/series` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6487](../src/api.ts#L6487) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/assignees` | 管理者（4ロール）＋本部の閲覧（GET） | [assignees.ts:110](../src/assignees.ts#L110) | アカウントごとの「担当している会社」（主・副の区別つき）。?user_id= で1人に絞る。 統合済み・消した協力会社とクライアントの行は出さない | admin.js |
| GET | `/api/admin/assignees/options` | 管理者（4ロール）＋本部の閲覧（GET） | [assignees.ts:102](../src/assignees.ts#L102) | 担当に選べるアカウント（自社の利用中の管理者）。同姓の人を見分けられるよう ID と権限も返す | admin.js |
| GET | `/api/admin/attendance-photo/:attendanceId` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1840](../src/api.ts#L1840) | 管理者: 勤怠報告の写真の取得。報告のシフトが自社のものかを確かめてから返す（写真のキーは画面に出さない #217） | admin.js corrections.js |
| GET | `/api/admin/attendance-punches` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:1074](../src/corrections.ts#L1074) | 〔見出し〕打刻データの一覧と CSV（#175）: 勤務日の期間（31日まで）・案件・クライアント・スタッフ・記録方法で絞り、1シフト1行で8種類の報告の日時と記録方法を出す。 | corrections.js |
| GET | `/api/admin/attendance-punches/export` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:1093](../src/corrections.ts#L1093) | 〔見出し〕打刻データの一覧と CSV（#175）: 勤務日の期間（31日まで）・案件・クライアント・スタッフ・記録方法で絞り、1シフト1行で8種類の報告の日時と記録方法を出す。 | corrections.js |
| GET | `/api/admin/availability` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-schedule.ts:342](../src/staff-schedule.ts#L342) | 月の提出状況と、日付×スタッフの一覧。marks は日ごとの1文字（o=○ p=△ x=× -=未入力）、shift_days はシフトの入っている日（DD）。 exempt は回収の対象外（#9907）。対象外の人は一覧の後ろに出す | admin.js |
| PUT | `/api/admin/availability/period` | 管理者（4ロール） | [staff-schedule.ts:385](../src/staff-schedule.ts#L385) | 締切と案内文（month は今月の前後。deadline は空欄で締切なし） | admin.js |
| POST | `/api/admin/availability/remind` | 管理者（4ロール） | [staff-schedule.ts:403](../src/staff-schedule.ts#L403) | 未提出の人（ログインできるスタッフ。回収の対象外の人を除く）へアプリ内通知で提出を頼む | admin.js |
| PUT | `/api/admin/availability/targets` | 管理者（4ロール） | [staff-schedule.ts:439](../src/staff-schedule.ts#L439) | 〔見出し〕管理者（/api/admin/*） | admin.js staff-lifecycle.js |
| GET | `/api/admin/badges` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: CHAT_ROLES | [admin-badges.ts:23](../src/admin-badges.ts#L23) | 〔見出し〕管理画面のバッジ（左のメニュー・スマホのメニューの件数）をまとめて返す（#9935） | admin.js |
| GET | `/api/admin/billing-check` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7619](../src/api.ts#L7619) | 請求前確認 | admin.js |
| GET | `/api/admin/board/posts` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:127](../src/board.ts#L127) | scope: open（全企業の掲載中）/ mine（自社の掲載すべて） | board.js |
| POST | `/api/admin/board/posts` | 管理者（4ロール） | [board.ts:216](../src/board.ts#L216) | 〔見出し〕作成・更新 | board.js |
| DELETE | `/api/admin/board/posts/:id` | 管理者（4ロール） | [board.ts:318](../src/board.ts#L318) | 削除は下書きのみ（掲載したものは履歴として残し、締切・充足で閉じる） | board.js |
| GET | `/api/admin/board/posts/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:173](../src/board.ts#L173) | 〔見出し〕詳細 | board.js |
| PUT | `/api/admin/board/posts/:id` | 管理者（4ロール） | [board.ts:237](../src/board.ts#L237) | 〔見出し〕作成・更新 | board.js |
| POST | `/api/admin/board/posts/:id/status` | 管理者（4ロール） | [board.ts:298](../src/board.ts#L298) | 状態だけの変更（掲載する / 締め切る / 充足 / 下書きに戻す） | board.js |
| POST | `/api/admin/board/posts/:id/threads` | 管理者（4ロール） | [board.ts:394](../src/board.ts#L394) | 問い合わせを開始する（既にあれば既存スレッドを返す）。自社の掲載・掲載中でない掲載には問い合わせできない | board.js |
| GET | `/api/admin/board/project-template/:projectId` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:200](../src/board.ts#L200) | 〔見出し〕自社案件からのコピー用 | board.js |
| GET | `/api/admin/board/proposals` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:812](../src/board.ts#L812) | 自社が関わる提案の一覧（提案した / 受けた） | board.js |
| POST | `/api/admin/board/proposals/:id/import` | 管理者（4ロール） | [board.ts:863](../src/board.ts#L863) | 取り込んだ行は partner_manual（取引先所属）、所属会社名 = 提案企業名（取引先マスタにも登録）。 基本項目・業務側項目は採用時点の開示内容（氏名 + スナップショット）をコピーし、以後は自社で編集（提案元とは同期しない）。 経路は board_proposals.upstream_chain にだけ残… | board.js |
| POST | `/api/admin/board/proposals/:id/status` | 管理者（4ロール） | [board.ts:764](../src/board.ts#L764) | 状態変更: 受け手 = 面談希望 / 採用 / 見送り、提案者 = 取り下げ（採用前のみ） | board.js |
| GET | `/api/admin/board/saved-searches` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:993](../src/board.ts#L993) | 〔見出し〕保存した検索条件と、条件に合う新しい掲載の知らせ（#479） | board.js |
| POST | `/api/admin/board/saved-searches` | 管理者（4ロール） | [board.ts:998](../src/board.ts#L998) | 〔見出し〕保存した検索条件と、条件に合う新しい掲載の知らせ（#479） | board.js |
| DELETE | `/api/admin/board/saved-searches/:id` | 管理者（4ロール）<br>＋本文で確認: SAVED_SEARCH_NOTIFY_ROLES | [board.ts:1030](../src/board.ts#L1030) | 〔見出し〕保存した検索条件と、条件に合う新しい掲載の知らせ（#479） | board.js |
| PUT | `/api/admin/board/saved-searches/:id` | 管理者（4ロール） | [board.ts:1015](../src/board.ts#L1015) | 名前・知らせ方の変更（条件そのものは変えない。変えるときは保存し直す） | board.js |
| GET | `/api/admin/board/threads` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:424](../src/board.ts#L424) | スレッド一覧（自社が参加する全スレッド）。post_id を指定するとその掲載のスレッドのみ | board.js |
| GET | `/api/admin/board/threads/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:459](../src/board.ts#L459) | メッセージ取得（全履歴）。取得しただけでは既読にしない（既読は POST /threads/:id/read。#250） | board.js |
| POST | `/api/admin/board/threads/:id/messages` | 管理者（4ロール） | [board.ts:494](../src/board.ts#L494) | 投稿 | board.js |
| GET | `/api/admin/board/threads/:id/proposal-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:623](../src/board.ts#L623) | 提案できる自社スタッフの候補（統合済みは除外。区分ごとの注意文付き） | board.js |
| GET | `/api/admin/board/threads/:id/proposal-preview` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:653](../src/board.ts#L653) | 送信前のプレビュー（相手に見える内容そのもの） | board.js |
| GET | `/api/admin/board/threads/:id/proposals` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:753](../src/board.ts#L753) | 提案一覧（スレッド内） | board.js |
| POST | `/api/admin/board/threads/:id/proposals` | 管理者（4ロール） | [board.ts:693](../src/board.ts#L693) | 提案の送信 | board.js |
| POST | `/api/admin/board/threads/:id/read` | 管理者（4ロール） | [board.ts:474](../src/board.ts#L474) | 既読にする（ユーザー単位）。画面が表示されていて、やり取りの一番下まで見えているときに画面から呼ぶ（#250） message_id: 画面に表示した最後のメッセージ。省略したら最新まで | board.js |
| POST | `/api/admin/board/threads/:id/status` | 管理者（4ロール） | [board.ts:509](../src/board.ts#L509) | やり取りの終了 / 再開（どちらの企業からでも可。履歴は残る） | board.js |
| GET | `/api/admin/board/unread-count` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:456](../src/board.ts#L456) | 〔見出し〕第2段階: 案件チャット（掲載1件 × 問い合わせ企業1社の1対1スレッド） | board.js |
| GET | `/api/admin/clients` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4374](../src/api.ts#L4374) | クライアント | admin.js corrections.js shift-board.js tour.js |
| POST | `/api/admin/clients` | 管理者（4ロール） | [api.ts:4391](../src/api.ts#L4391) | 〔見出し〕スタッフ履歴書ファイル管理 | admin.js tour.js |
| GET | `/api/admin/clients/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4431](../src/api.ts#L4431) | 〔見出し〕スタッフ履歴書ファイル管理 | admin.js |
| PUT | `/api/admin/clients/:id` | 管理者（4ロール） | [api.ts:4520](../src/api.ts#L4520) | 〔見出し〕スタッフ履歴書ファイル管理 | admin.js |
| DELETE | `/api/admin/clients/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:5420](../src/api.ts#L5420) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| POST | `/api/admin/clients/:id/contacts` | 管理者（4ロール） | [api.ts:4628](../src/api.ts#L4628) | 〔見出し〕顧客担当者（1会社に複数登録可、支店・部署は自由入力） | admin.js |
| GET | `/api/admin/clients/:id/documents` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4946](../src/api.ts#L4946) | ファイル一覧 | admin.js |
| POST | `/api/admin/clients/:id/documents` | 管理者（4ロール） | [api.ts:4957](../src/api.ts#L4957) | アップロード（複数ファイル対応。履歴書機能と同一の検証ロジックを再利用） | admin.js |
| GET | `/api/admin/clients/:id/ng-staff` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4582](../src/api.ts#L4582) | 〔見出し〕クライアントのNGスタッフ（#204） | admin.js |
| PUT | `/api/admin/clients/:id/ng-staff` | 管理者（4ロール） | [api.ts:4589](../src/api.ts#L4589) | NGスタッフの一覧を置き換える。body: { staff: [{ staff_id, reason }] }（staff_ids: [id] でも可）。自社の（統合済みでない）スタッフだけを受け付ける | admin.js |
| DELETE | `/api/admin/clients/contacts/:contactId` | 管理者（4ロール） | [api.ts:4656](../src/api.ts#L4656) | 〔見出し〕顧客担当者（1会社に複数登録可、支店・部署は自由入力） | admin.js |
| PUT | `/api/admin/clients/contacts/:contactId` | 管理者（4ロール） | [api.ts:4641](../src/api.ts#L4641) | 〔見出し〕顧客担当者（1会社に複数登録可、支店・部署は自由入力） | admin.js |
| DELETE | `/api/admin/clients/documents/:docId` | 管理者（4ロール） | [api.ts:5036](../src/api.ts#L5036) | 削除（D1を先に消し、R2はベストエフォート。履歴書機能と同じ順序方針） | admin.js |
| GET | `/api/admin/clients/documents/:docId/download` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5017](../src/api.ts#L5017) | ダウンロード | admin.js |
| GET | `/api/admin/consultation-photo/:id{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1849](../src/api.ts#L1849) | 管理者: 相談の写真の取得。自社あての相談の写真だけ（#429） | admin.js |
| GET | `/api/admin/consultations` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7463](../src/api.ts#L7463) | 〔見出し〕お知らせ既読率レポート | admin.js |
| PUT | `/api/admin/consultations/:id` | 管理者（4ロール） | [api.ts:7492](../src/api.ts#L7492) | 返信・状態の変更。返信したら、スタッフ本人にアプリ内通知（consult_reply）で知らせ、ホームのバナーに出す（#320） | admin.js |
| GET | `/api/admin/contract-usage` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:8341](../src/api.ts#L8341) | 契約ユーザー数（本部が決めた上限）と今の利用数。企業の管理画面（アカウント設定）に表示する（#321 #9928。登録は止めず、表示のみ） 数え方は本部の企業一覧・企業詳細と同じ（HQ_BILLABLE_SQL）。near_limit: 上限の9割以上で、まだ超えていない | admin.js |
| GET | `/api/admin/corrections` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:739](../src/corrections.ts#L739) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| POST | `/api/admin/corrections` | 管理者（4ロール） | [corrections.ts:884](../src/corrections.ts#L884) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/corrections/:id{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:844](../src/corrections.ts#L844) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| POST | `/api/admin/corrections/:id{[0-9]+}/approve` | 管理者（4ロール） | [corrections.ts:1003](../src/corrections.ts#L1003) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| POST | `/api/admin/corrections/:id{[0-9]+}/cancel` | 管理者（4ロール） | [corrections.ts:1016](../src/corrections.ts#L1016) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| POST | `/api/admin/corrections/:id{[0-9]+}/reject` | 管理者（4ロール） | [corrections.ts:1010](../src/corrections.ts#L1010) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| POST | `/api/admin/corrections/:id{[0-9]+}/resubmit` | 管理者（4ロール） | [corrections.ts:1021](../src/corrections.ts#L1021) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/corrections/attachments/:aid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:998](../src/corrections.ts#L998) | 申請に添付した画像（自社の申請のみ。R2 のキーは画面に出さない。#485） | corrections.js |
| POST | `/api/admin/corrections/bulk-approve` | 管理者（4ロール） | [corrections.ts:942](../src/corrections.ts#L942) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/corrections/events` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:823](../src/corrections.ts#L823) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | attendance-history.js |
| GET | `/api/admin/corrections/events/export` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:831](../src/corrections.ts#L831) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | attendance-history.js |
| GET | `/api/admin/corrections/export` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:775](../src/corrections.ts#L775) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/corrections/pending-count` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:713](../src/corrections.ts#L713) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/corrections/shift-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:855](../src/corrections.ts#L855) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/corrections/shift/:shiftId` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:879](../src/corrections.ts#L879) | 管理者による申請（自社のシフト）。dry_run で確認のみ | corrections.js |
| GET | `/api/admin/daily-reports` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5778](../src/api.ts#L5778) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/daily-reports-csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:8523](../src/api.ts#L8523) | 〔見出し〕日報の書き出しと保存期間の案内（導入企業向け。#417） | admin.js |
| GET | `/api/admin/daily-reports-retention` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:8573](../src/api.ts#L8573) | 日報の保存期間と、今後30日のうちに3年を過ぎて削除される件数（日報一覧の案内に出す） | admin.js |
| PUT | `/api/admin/daily-reports/:id` | 管理者（4ロール） | [api.ts:5908](../src/api.ts#L5908) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/daily-reports/:id{[0-9]+}/edits` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5981](../src/api.ts#L5981) | 修正の画面の内容と、修正の履歴（新しい順） | admin.js |
| PUT | `/api/admin/daily-reports/:id{[0-9]+}/values` | 管理者（4ロール） | [api.ts:6009](../src/api.ts#L6009) | 値を直す。values は項目のキー → 値（送らなかった項目は今の値のまま）、reason は理由（任意）。 expected_submitted_at・expected_admin_edited_at（画面を開いたときの値）を送ると、その後にスタッフが出し直した・ほかの管理者が直したときは 409 を返して書かない | admin.js |
| PUT | `/api/admin/daily-reports/:id/incident` | 管理者（4ロール） | [api.ts:6049](../src/api.ts#L6049) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js |
| POST | `/api/admin/daily-reports/check` | 管理者（4ロール） | [api.ts:5889](../src/api.ts#L5889) | 表示中の日報をまとめて確認済みにする（#183）。ids は最大 DAILY_REPORT_PAGE_MAX 件。すでに確認済みのものは変えない | admin.js |
| GET | `/api/admin/daily-reports/missing` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5721](../src/api.ts#L5721) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/dashboard` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 人事のロール | [api.ts:2801](../src/api.ts#L2801) | 管理者ダッシュボード 問い合わせは1回の db.batch（と、並べて行う人員不足・月額の読み込み）にまとめる（#9904。1つずつ待つと D1 の往復の数だけ遅くなる）。 案件の絞り込み（#9905）: project_id（その案件）か client_id（そのクライアントの案件）。どちらもなければ全案件。 絞り… | admin.js |
| DELETE | `/api/admin/dashboard/todos` | 管理者（4ロール） | [api.ts:3371](../src/api.ts#L3371) | 元に戻す（もう一度 ToDo に出す） | admin.js |
| POST | `/api/admin/dashboard/todos` | 管理者（4ロール） | [api.ts:3349](../src/api.ts#L3349) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/email-logs` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:909](../src/notifications.ts#L909) | 〔見出し〕メールの送信記録（email_logs。#438）と、送信を止めているアドレス（email_suppressions。#541） | notifications.js |
| GET | `/api/admin/email-suppressions` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [notifications.ts:925](../src/notifications.ts#L925) | 自社のユーザーのアドレスのうち、送信を止めているもの（不達・迷惑メールの報告） | notifications.js |
| POST | `/api/admin/email-suppressions/release` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [notifications.ts:933](../src/notifications.ts#L933) | 送信の停止を解除する（受信できるようになったと本人に確かめた後）。自社のユーザーのアドレスだけ。会社管理者のみ | notifications.js |
| GET | `/api/admin/employees` | 会社管理者・事務 | [api.ts:4685](../src/api.ts#L4685) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| GET | `/api/admin/employees/:staffId` | 会社管理者・事務 | [api.ts:4741](../src/api.ts#L4741) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| PUT | `/api/admin/employees/:staffId` | 会社管理者・事務 | [api.ts:4763](../src/api.ts#L4763) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| GET | `/api/admin/employees/:staffId/documents` | 会社管理者・事務 | [api.ts:4862](../src/api.ts#L4862) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| POST | `/api/admin/employees/:staffId/documents` | 会社管理者・事務 | [api.ts:4873](../src/api.ts#L4873) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| GET | `/api/admin/employees/:staffId/history` | 会社管理者・事務 | [api.ts:4847](../src/api.ts#L4847) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| DELETE | `/api/admin/employees/documents/:docId` | 会社管理者・事務 | [api.ts:4927](../src/api.ts#L4927) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| GET | `/api/admin/employees/documents/:docId/download` | 会社管理者・事務 | [api.ts:4912](../src/api.ts#L4912) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| GET | `/api/admin/employees/export` | 会社管理者・事務<br>＋本文で確認: 会社管理者 | [api.ts:4709](../src/api.ts#L4709) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| GET | `/api/admin/follow-logs` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7538](../src/api.ts#L7538) | 〔見出し〕お知らせ既読率レポート | admin.js |
| POST | `/api/admin/follow-logs` | 管理者（4ロール） | [api.ts:7582](../src/api.ts#L7582) | 〔見出し〕お知らせ既読率レポート | admin.js |
| PUT | `/api/admin/follow-logs/:id` | 管理者（4ロール） | [api.ts:7601](../src/api.ts#L7601) | 〔見出し〕お知らせ既読率レポート | admin.js |
| GET | `/api/admin/hq-access` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [hq-support.ts:318](../src/hq-support.ts#L318) | 本部の閲覧の許可と、これまでの閲覧の記録（いつ・誰が・何のために） | hq-support.js |
| PUT | `/api/admin/hq-access` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [hq-support.ts:328](../src/hq-support.ts#L328) | 閲覧の許可の切り替え（会社管理者のみ）。取り消したときは、閲覧中のものもその場で終える | hq-support.js |
| POST | `/api/admin/hq-announcements/:id/read` | 管理者（4ロール） | [hq-support.ts:266](../src/hq-support.ts#L266) | 〔見出し〕管理画面の API（/api/admin に登録する） | hq-support.js |
| GET | `/api/admin/hq-support/status` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [hq-support.ts:252](../src/hq-support.ts#L252) | 管理画面の上部に出すもの: 未確認の本部のお知らせ、本部が閲覧中かどうか、閲覧の許可の状態 | hq-support.js |
| GET | `/api/admin/login-history` | 会社管理者 | [api.ts:1154](../src/api.ts#L1154) | 自社のログインの履歴（自社の会社コードで試みられた失敗を含む）と、失敗が続いている ID | security.js |
| GET | `/api/admin/notice-reports/:fiscalYear` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7369](../src/api.ts#L7369) | 年度別（会社サマリ + スタッフ別）。長期保存されたレポートテーブルから取得する。 再集計できるかどうか（確定済み・保存期間外ならできない #48 #49）と、年度の途中かどうか（#481）も返す | admin.js |
| GET | `/api/admin/notice-reports/:fiscalYear/csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7440](../src/api.ts#L7440) | CSV出力（スタッフ別レポート。人事評価の参考資料用）。共通の toCsv でエスケープする（#72）。 並びは画面の初期表示と同じ既読率の低い順（order=name で氏名順）。スタッフID・社員番号の列も出す（#518） | admin.js |
| POST | `/api/admin/notice-reports/:fiscalYear/recalculate` | 管理者（4ロール） | [api.ts:7396](../src/api.ts#L7396) | 再集計（管理者が年度を指定して即時更新）。確定済み・保存期間外の年度は 409 で断る（長期保存した値を上書きしない #48） | admin.js |
| GET | `/api/admin/notice-reports/:fiscalYear/staff/:staffId` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7411](../src/api.ts#L7411) | スタッフ別・お知らせ単位の詳細。対象の判定は年度のレポートと同じ（公開した時点の対象者 #49 #481）。 既読の記録を削除したお知らせは is_read = null（記録なし）で返す | admin.js |
| GET | `/api/admin/notices` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6605](../src/api.ts#L6605) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| POST | `/api/admin/notices` | 管理者（4ロール） | [api.ts:6778](../src/api.ts#L6778) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| DELETE | `/api/admin/notices/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:7211](../src/api.ts#L7211) | 下書き・予約（配信前）の削除。配信したものは取り消す（記録を残すため削除しない） | admin.js |
| PUT | `/api/admin/notices/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:7106](../src/api.ts#L7106) | 修正（#157）。配信した後も、タイトル・本文・配信先・重要度・確認必須・掲載期限・回答の設定を直せる。 配信済みのものは修正の前の内容を notice_revisions に残し、タイトル・本文を変えたらスタッフの画面に「更新」の印を出す（updated_at）。 notify: 今の配信対象の人に、修正したことを… | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/attachments` | 管理者（4ロール） | [api.ts:7292](../src/api.ts#L7292) | 添付の追加（複数可。1ファイルずつ検証し、成功した分だけ保存する）。配信済みのものに足したら「更新」の印を付ける | admin.js |
| DELETE | `/api/admin/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}` | 管理者（4ロール） | [api.ts:7347](../src/api.ts#L7347) | 添付の削除（D1 を先に消し、R2 は後で消す） | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7339](../src/api.ts#L7339) | 〔見出し〕添付（#555）: 画像・PDF を R2（DOCUMENTS）に置き、配信先の本人と自社の管理者だけが取得できる | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/email-deliveries` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6860](../src/api.ts#L6860) | お知らせメールの送信結果（1人ずつ）。メールアドレスは返さない（連携スタッフの所属元のアドレスを見せないため） | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/publish` | 管理者（4ロール） | [api.ts:7161](../src/api.ts#L7161) | 下書き・予約を配信する（#291）。scheduled_at があれば予約にし、無ければすぐに配信する | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/remind` | 管理者（4ロール） | [api.ts:6823](../src/api.ts#L6823) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/responses.csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6913](../src/api.ts#L6913) | 回答の CSV（#554。出欠の集計などに使う）。今の配信対象の人を全員出し、まだ答えていない人は回答の列を空にする | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/revisions` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7231](../src/api.ts#L7231) | 修正・取消の履歴（#157） | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/withdraw` | 管理者（4ロール） | [api.ts:7187](../src/api.ts#L7187) | 取消（#157。論理削除）。スタッフの一覧・ホーム・未読の数から外し、個別画面には「取り消されました」と出す。 内容・既読・回答の記録は残す（管理画面では「取消」として見える）。notify なら、今の配信対象の人にアプリ内通知で知らせる | admin.js |
| GET | `/api/admin/notices/:id/reads` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6872](../src/api.ts#L6872) | お知らせ既読状況。既読・未読とも、今の配信対象の人だけを出す（#7）。 既読の時刻は UTC で保存している（列の既定値）ので、日本時間にして返す（#104） | admin.js |
| GET | `/api/admin/notices/recipients` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6661](../src/api.ts#L6661) | 個人あての配信先の候補（#157）。いま在籍中で、ログインのあるスタッフ（お知らせが届く人。NOTICE_MEMBER_NOW_SQL と同じ条件） | admin.js |
| GET | `/api/admin/notification-emails` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:480](../src/notifications.ts#L480) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| POST | `/api/admin/notification-emails/:id{[0-9]+}/resend` | 管理者（4ロール） | [notifications.ts:546](../src/notifications.ts#L546) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| GET | `/api/admin/notification-emails/export` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:508](../src/notifications.ts#L508) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| POST | `/api/admin/notification-emails/resend-failed` | 管理者（4ロール）<br>＋本文で確認: NOTIFY_ADMIN_ROLES | [notifications.ts:577](../src/notifications.ts#L577) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| GET | `/api/admin/notification-prefs` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:1733](../src/notifications.ts#L1733) | 〔見出し〕受け取り設定の API | notifications.js |
| PUT | `/api/admin/notification-prefs` | 管理者（4ロール）<br>＋本文で確認: NOTIFY_ADMIN_ROLES | [notifications.ts:1738](../src/notifications.ts#L1738) | 〔見出し〕受け取り設定の API | notifications.js |
| GET | `/api/admin/notifications` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:417](../src/notifications.ts#L417) | 絞り込み（#380）: unread=1 で未読だけ、kind で種類、before（notification_id）で続きを取る。limit は 1〜100（既定 100） | notifications.js |
| POST | `/api/admin/notifications/:id{[0-9]+}/read` | 管理者（4ロール） | [notifications.ts:453](../src/notifications.ts#L453) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | notifications.js |
| POST | `/api/admin/notifications/read-all` | 管理者（4ロール） | [notifications.ts:436](../src/notifications.ts#L436) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | notifications.js |
| POST | `/api/admin/notifications/read-related` | 管理者（4ロール） | [notifications.ts:443](../src/notifications.ts#L443) | kind（と related_id）で既読にする（募集の応募一覧を開いたときなど、通知を開かずに対応したとき。#150） | recruit.js |
| GET | `/api/admin/notifications/unread-count` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:435](../src/notifications.ts#L435) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications |  |
| GET | `/api/admin/operation-logs` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5660](../src/api.ts#L5660) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/pay-requests` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-pay.ts:298](../src/staff-pay.ts#L298) | 一覧（status=pending: 承認待ち（既定）/ all: 直近の申請）。承認できない理由（shift_issue）も付ける | settlement.js |
| POST | `/api/admin/pay-requests/:id{[0-9]+}/approve` | 管理者（4ロール） | [staff-pay.ts:349](../src/staff-pay.ts#L349) | 承認: 交通費は { amount?（直した金額）, note? }、延長は { end_time?（直した終了時刻）, note? } | settlement.js |
| GET | `/api/admin/pay-requests/:id{[0-9]+}/receipt` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-pay.ts:325](../src/staff-pay.ts#L325) | 申請の領収書の写真（自社の申請のみ。#273） | settlement.js |
| POST | `/api/admin/pay-requests/:id{[0-9]+}/reject` | 管理者（4ロール） | [staff-pay.ts:408](../src/staff-pay.ts#L408) | 却下: { note（理由。必須） } | settlement.js |
| GET | `/api/admin/project-goals` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6134](../src/api.ts#L6134) | 案件の月間目標（#292）。稼働中の案件と、日報テンプレートの数値項目・設定済みの目標 | admin.js |
| GET | `/api/admin/projects` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5055](../src/api.ts#L5055) | 案件一覧 ?month=YYYY-MM で集計する月を選べる（#450。無ければ今月）。月は範囲の条件で絞る（#212）。monthly_amount: その月の案件全体の月額（#9702） | admin.js attendance-history.js board.js corrections.js recruit.js shift-board.js tour.js |
| POST | `/api/admin/projects` | 管理者（4ロール） | [api.ts:5152](../src/api.ts#L5152) | 案件登録 | admin.js tour.js |
| GET | `/api/admin/projects/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5075](../src/api.ts#L5075) | 案件詳細 | admin.js |
| PUT | `/api/admin/projects/:id` | 管理者（4ロール） | [api.ts:5272](../src/api.ts#L5272) | 案件の編集・終了（#153）。送られた項目だけを変える。単価・区分は単価パネル（PUT /admin/projects/:id/pricing）で変える。 - status: active（稼働中）/ closed（終了）。終了した案件には新しいシフトを入れられない（lib/staff-eligibility.ts … | admin.js |
| DELETE | `/api/admin/projects/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:5418](../src/api.ts#L5418) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| PUT | `/api/admin/projects/:id/goals` | 管理者（4ロール） | [api.ts:6147](../src/api.ts#L6147) | goals: { 項目のキー: 件数 }。空欄・0 の項目は目標なしにする。テンプレートの数値項目に無いキーは受け付けない | admin.js |
| PUT | `/api/admin/projects/:id/lateness` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3438](../src/api.ts#L3438) | 案件ごとの遅刻の猶予の上書き（#497）。grace_minutes: 0〜MAX_LATE_GRACE_MINUTES の整数、null なら会社の値に従う。これから記録する報告に効く | admin.js |
| PUT | `/api/admin/projects/:id/photo-required` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:5237](../src/api.ts#L5237) | 案件ごとの入店/退店報告 写真添付オーバーライド更新 | admin.js |
| GET | `/api/admin/projects/:id/price-history` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2979](../src/shift-board.ts#L2979) | 案件の標準単価の改定履歴（#210） | shift-board.js |
| PUT | `/api/admin/projects/:id/pricing` | 管理者（4ロール） | [shift-board.ts:3016](../src/shift-board.ts#L3016) | 区分・標準単価・交通費ルール・時間の数え方。 price_valid_from（適用開始日）を付けて単価を変えると、その前日までの稼働日には今の単価を使い続ける（改定前の単価を project_price_history に残す。#210）。 付けずに変えると、今の単価の適用期間（price_valid_from 以… | shift-board.js |
| PUT | `/api/admin/projects/:id/report-settings` | 管理者（4ロール） | [staff-lifecycle.ts:806](../src/staff-lifecycle.ts#L806) | 〔見出し〕提出設定 | staff-lifecycle.js |
| PUT | `/api/admin/projects/:id/required-skills` | 管理者（4ロール） | [api.ts:5225](../src/api.ts#L5225) | 案件の必要スキル（#556。シフトボードの候補一覧の『スキル n/m』に使う）。カンマ・読点で区切り、空欄なら消す | admin.js |
| GET | `/api/admin/proxy-attendance/bulk` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:1115](../src/staff-lifecycle.ts#L1115) | 日付（と案件）を選ぶと、勤務のシフトと報告の状況を返す。ログインのない人を先頭に並べる | staff-lifecycle.js |
| POST | `/api/admin/proxy-attendance/bulk` | 管理者（4ロール） | [staff-lifecycle.ts:1148](../src/staff-lifecycle.ts#L1148) | チェックしたシフトに「予定どおり」で記録する。scope: start = 入店・勤務開始だけ / all = 予定どおり全部（休憩・勤務終了・退店も）。 人ごとに start・end（'HH:MM'）で開始・終了の時刻を直せる。1件の代理入力と同じ確認（確定済み・欠勤・稼働日より前・報告済み・順序）をして、 記録で… | staff-lifecycle.js |
| GET | `/api/admin/push/config` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:1952](../src/notifications.ts#L1952) | 〔見出し〕プッシュ通知（#178） | notifications.js |
| GET | `/api/admin/push/latest` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:2044](../src/notifications.ts#L2044) | 〔見出し〕プッシュ通知（#178） |  |
| POST | `/api/admin/push/subscribe` | 管理者（4ロール） | [notifications.ts:1965](../src/notifications.ts#L1965) | 〔見出し〕プッシュ通知（#178） | notifications.js |
| POST | `/api/admin/push/test` | 管理者（4ロール） | [notifications.ts:1995](../src/notifications.ts#L1995) | テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す） | notifications.js |
| POST | `/api/admin/push/unsubscribe` | 管理者（4ロール） | [notifications.ts:1987](../src/notifications.ts#L1987) | 〔見出し〕プッシュ通知（#178） | notifications.js |
| GET | `/api/admin/rate-rules` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2838](../src/shift-board.ts#L2838) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| POST | `/api/admin/rate-rules` | 管理者（4ロール） | [shift-board.ts:2905](../src/shift-board.ts#L2905) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| DELETE | `/api/admin/rate-rules/:id` | 管理者（4ロール） | [shift-board.ts:2934](../src/shift-board.ts#L2934) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| PUT | `/api/admin/rate-rules/:id` | 管理者（4ロール） | [shift-board.ts:2917](../src/shift-board.ts#L2917) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| GET | `/api/admin/recruit-applications` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:641](../src/recruit.ts#L641) | 応募一覧（枠の情報・残り人数・重複の警告・電話番号が一致する登録済みスタッフ） 絞り込み: status（pending / done / cancelled / waitlist: 見送りにした勤務日前の日時がある / all）、page_id、slot_role_id（シフトボードの「応募n」から。#303）、 … | recruit.js |
| POST | `/api/admin/recruit-applications/:id/decide` | 管理者（4ロール） | [recruit.ts:870](../src/recruit.ts#L870) | 承認・見送り body: { approve: [item_id], reject: [item_id], staff_id?: 既存スタッフに紐づけ, new_staff_type?: 仮登録の区分, partner_affiliation_id?, force? } 確認をすべて済ませてから、対象の明細を「処理中… | recruit.js |
| POST | `/api/admin/recruit-applications/:id/notes` | 管理者（4ロール） | [recruit.ts:731](../src/recruit.ts#L731) | 〔見出し〕応募の対応メモ（#478）。電話済み・不在・面談予定などを、書いた人・日時と一緒に残して管理者どうしで共有する | recruit.js |
| DELETE | `/api/admin/recruit-applications/:id/notes/:noteId` | 管理者（4ロール） | [recruit.ts:744](../src/recruit.ts#L744) | 自分が書いたメモだけ消せる（書き間違いの訂正用） | recruit.js |
| POST | `/api/admin/recruit-applications/:id/notify-result` | 管理者（4ロール） | [recruit.ts:818](../src/recruit.ts#L818) | 応募の結果のメールを送り直す（#151。メールが届かなかった・送らずに処理したとき）。承認・見送りにした日時をまとめて1通で送る | recruit.js |
| GET | `/api/admin/recruit-applications/:id/staff-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:831](../src/recruit.ts#L831) | 未登録の応募者を紐づける既存スタッフの候補（#395）。電話番号が一致しなくても、氏名・フリガナ・スタッフ番号・電話番号で探せる。 q を省くと、応募の電話番号・氏名・フリガナが一致するスタッフを返す。一致の強い順（電話番号 → 氏名 → フリガナ）に並べる | recruit.js |
| GET | `/api/admin/recruit-applications/summary` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:779](../src/recruit.ts#L779) | 〔見出し〕応募の対応メモ（#478）。電話済み・不在・面談予定などを、書いた人・日時と一緒に残して管理者どうしで共有する | recruit.js |
| GET | `/api/admin/recruit-pages` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:551](../src/recruit.ts#L551) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| POST | `/api/admin/recruit-pages` | 管理者（4ロール） | [recruit.ts:574](../src/recruit.ts#L574) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| DELETE | `/api/admin/recruit-pages/:id` | 管理者（4ロール） | [recruit.ts:621](../src/recruit.ts#L621) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| PUT | `/api/admin/recruit-pages/:id` | 管理者（4ロール） | [recruit.ts:598](../src/recruit.ts#L598) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| GET | `/api/admin/recruit-slots` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:533](../src/recruit.ts#L533) | 募集ページの画面に出す、対象の案件・期間の既存の枠（役割ごと）。人数をこの画面で直せるようにする（#9421） | recruit.js |
| POST | `/api/admin/recruit-slots/:id/reject-pending` | 管理者（4ロール） | [recruit.ts:796](../src/recruit.ts#L796) | 枠（役割）に残っている未対応の応募をまとめて見送る（定員に達した枠の残り。#303）。承認の処理中（processing）の明細は対象にしない | recruit.js |
| GET | `/api/admin/report-links/bulk` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:1264](../src/staff-lifecycle.ts#L1264) | 〔見出し〕報告用URLのまとめての発行（#275） | staff-lifecycle.js |
| POST | `/api/admin/report-links/bulk` | 管理者（4ロール） | [staff-lifecycle.ts:1274](../src/staff-lifecycle.ts#L1274) | 未発行のシフトにまとめて発行する（発行済みのURLはそのまま）。shift_ids を送ったときは、その中の未発行のものだけ | staff-lifecycle.js |
| GET | `/api/admin/report-settings/day-before-check` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:640](../src/report-settings.ts#L640) | 前日確認の設定（#176）。ほかの会社設定を上書きしないよう、この項目だけを書き換える | admin.js |
| PUT | `/api/admin/report-settings/day-before-check` | 管理者（4ロール） | [report-settings.ts:645](../src/report-settings.ts#L645) | 〔見出し〕管理者 API | admin.js |
| GET | `/api/admin/report-settings/exceptions` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:800](../src/report-settings.ts#L800) | 〔見出し〕シフト単位の例外（#313） | report-settings.js |
| GET | `/api/admin/report-settings/logs` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:955](../src/report-settings.ts#L955) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | attendance-history.js report-settings.js |
| GET | `/api/admin/report-settings/logs/export` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:965](../src/report-settings.ts#L965) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | attendance-history.js |
| GET | `/api/admin/report-settings/off-list` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:909](../src/report-settings.ts#L909) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | report-settings.js |
| GET | `/api/admin/report-settings/off-list/export` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:918](../src/report-settings.ts#L918) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | report-settings.js |
| GET | `/api/admin/report-settings/projects` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:660](../src/report-settings.ts#L660) | 案件一覧（終了した案件は include_closed=1 で表示）。 個別設定のある人数と、OFF の報告がある在籍中の所属スタッフの人数も返す（#446） | report-settings.js |
| GET | `/api/admin/report-settings/projects/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:676](../src/report-settings.ts#L676) | 案件詳細: 標準設定（版番号つき）・所属スタッフ別の設定（在籍状況・設定の種類・今後のシフトの例外の件数） | report-settings.js |
| POST | `/api/admin/report-settings/projects/:id/bulk` | 管理者（4ロール） | [report-settings.ts:740](../src/report-settings.ts#L740) | 一括変更。dry_run で確認内容（対象者ごとの変更前・変更後、影響人数）と確認トークンを返す。 保存時は確認トークンを送る。確認後に設定が変わっていた場合（別の操作・二重送信）は 409 で再確認を求める。 退職・統合済み・取引終了のスタッフは対象にしない（#247） | report-settings.js |
| PUT | `/api/admin/report-settings/projects/:id/default` | 管理者（4ロール） | [report-settings.ts:704](../src/report-settings.ts#L704) | 標準設定の変更。version は画面を開いた時点の版番号（違えば 409。#509）。 apply: none = 新しく所属するスタッフにだけ / standard = 個別に変えていない今の所属スタッフにも / all = 今の所属スタッフ全員にも（#329） | report-settings.js |
| PUT | `/api/admin/report-settings/projects/:id/staff/:staffId` | 管理者（4ロール） | [report-settings.ts:725](../src/report-settings.ts#L725) | スタッフ別の変更（1 人） | report-settings.js |
| GET | `/api/admin/report-settings/staff/:staffId` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:837](../src/report-settings.ts#L837) | 〔見出し〕スタッフ 1 人の全案件の設定（#413） | report-settings.js |
| POST | `/api/admin/report-settings/staff/:staffId/apply` | 管理者（4ロール） | [report-settings.ts:848](../src/report-settings.ts#L848) | すべての案件（または選んだ案件）に同じ設定を当てる。dry_run で案件ごとの変更前・変更後と確認トークンを返す（一括変更と同じ流れ） project_ids を省くと、稼働中の案件すべて | report-settings.js |
| POST | `/api/admin/report-settings/staff/:staffId/reset` | 管理者（4ロール） | [report-settings.ts:874](../src/report-settings.ts#L874) | 案件の標準設定に戻す（案件 × スタッフ別の行を消す）。project_ids を省くとシフトのある全案件 | report-settings.js |
| POST | `/api/admin/roster` | 管理者（4ロール） | [roster.ts:1396](../src/roster.ts#L1396) | ②従業員管理から作成 / ③取引先から作成 / ④スキルシートのみ作成 | roster.js tour.js |
| GET | `/api/admin/roster-chat/:staffId` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:191](../src/roster-chat.ts#L191) | メッセージ取得（全履歴）。取得しただけでは既読にしない（#462。既読は POST /:staffId/read）。 自社の担当者それぞれの既読位置（誰がどこまで読んだか）も返す | roster-chat.js |
| POST | `/api/admin/roster-chat/:staffId` | 管理者（4ロール） | [roster-chat.ts:232](../src/roster-chat.ts#L232) | 投稿 | roster-chat.js |
| POST | `/api/admin/roster-chat/:staffId/read` | 管理者（4ロール） | [roster-chat.ts:216](../src/roster-chat.ts#L216) | 既読にする（チャット欄が画面に見えたとき・一覧から開いたとき）。last_comment_id まで（省略時は最新まで）を既読にする | roster-chat.js |
| GET | `/api/admin/roster-chat/ended/:threadStaffId` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:163](../src/roster-chat.ts#L163) | 連携が終わったスレッドのメッセージ（閲覧のみ・投稿はできない）。取得時に自社として既読にする（#237） 自社が所属元・稼働先として参加したやり取りだけを返す。連携中のスレッドはスタッフ詳細のチャット欄から開く | roster-chat.js |
| GET | `/api/admin/roster-chat/threads` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:59](../src/roster-chat.ts#L59) | スレッド一覧（自社が参加する全スレッド + 未読数）— ダッシュボード通知・一覧画面用 | roster-chat.js |
| GET | `/api/admin/roster-chat/unread-count` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:159](../src/roster-chat.ts#L159) | 〔見出し〕企業間チャット（所属元 ⇔ 稼働先 担当者）フェーズG | roster-chat.js |
| PUT | `/api/admin/roster/:id/host-status` | 管理者（4ロール） | [roster.ts:667](../src/roster.ts#L667) | 〔見出し〕稼働先での取引状況（#249） | staff-lifecycle.js |
| GET | `/api/admin/roster/:id/links` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:739](../src/roster.ts#L739) | 所属元: 自社スタッフの連携先企業一覧 + 稼働先が記入した共有追記項目（閲覧のみ） 稼働先: 自社の連携レコードの同意履歴 | roster-chat.js roster.js |
| POST | `/api/admin/roster/:id/links/:linkedId/end` | 管理者（4ロール） | [roster.ts:800](../src/roster.ts#L800) | 〔見出し〕所属元による連携の終了・再開（#162） | roster.js |
| POST | `/api/admin/roster/:id/links/:linkedId/resume` | 管理者（4ロール） | [roster.ts:831](../src/roster.ts#L831) | 終了した連携を再開する（直接連携した行だけ。多段連携の先の行は、その行の所属元が再開する） | roster.js |
| GET | `/api/admin/roster/:id/share-code` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:645](../src/roster.ts#L645) | 自社雇用スタッフの連携用ID（QRの中身）。再発行・有効期限なし。 | roster.js |
| GET | `/api/admin/roster/field-settings` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:592](../src/roster.ts#L592) | 必須項目設定の取得 | roster.js |
| PUT | `/api/admin/roster/field-settings` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [roster.ts:601](../src/roster.ts#L601) | 必須項目設定の更新（会社管理者のみ） | roster.js |
| GET | `/api/admin/roster/field-settings/missing` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:617](../src/roster.ts#L617) | 〔見出し〕ルーティング | roster.js |
| GET | `/api/admin/roster/host-notes` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:702](../src/roster.ts#L702) | 〔見出し〕連携先からの追記（現場評価・稼働メモ）の一覧（#538） | roster.js |
| POST | `/api/admin/roster/host-notes/seen` | 管理者（4ロール） | [roster.ts:724](../src/roster.ts#L724) | 確認済みにする（指定した history_id まで。省略時は今ある分すべて） | roster.js |
| POST | `/api/admin/roster/import/commit` | 管理者（4ロール） | [roster-import.ts:358](../src/roster-import.ts#L358) | 〔見出し〕スタッフマスタ・従業員の CSV 一括登録（#430） | roster.js |
| POST | `/api/admin/roster/import/preview` | 管理者（4ロール） | [roster-import.ts:333](../src/roster-import.ts#L333) | 〔見出し〕スタッフマスタ・従業員の CSV 一括登録（#430） | roster.js |
| GET | `/api/admin/roster/import/template` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-import.ts:324](../src/roster-import.ts#L324) | 〔見出し〕スタッフマスタ・従業員の CSV 一括登録（#430） | roster.js |
| POST | `/api/admin/roster/link` | 管理者（4ロール） | [roster.ts:1306](../src/roster.ts#L1306) | ①QR/ID連携: 同意の上で稼働先のスタッフマスタに連携登録する | roster.js |
| GET | `/api/admin/roster/lookup` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:1224](../src/roster.ts#L1224) | ①QR/ID連携: コードから連携候補をプレビュー（同意前なので識別に必要な最小限のみ返す） | roster.js |
| GET | `/api/admin/roster/next-code` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:903](../src/roster.ts#L903) | 次に使えるスタッフ番号（#424。登録画面の番号欄の既定値） | roster.js staff-lifecycle.js |
| GET | `/api/admin/roster/partners` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:910](../src/roster.ts#L910) | 取引先（Field OS未契約の所属元）一覧: 自社名を除いた staff_affiliations。 以前のスタッフ詳細の保存で、個人事業主の屋号やスキルシートのみの人の所属会社名が取引先マスタに入っていたため（#262）、 所属スタッフ・支払先のシフト・連絡先がなく、取引先以外の区分のスタッフの所属会社名と同じ名… | recruit.js roster.js staff-lifecycle.js |
| POST | `/api/admin/roster/partners` | 管理者（4ロール） | [roster.ts:1125](../src/roster.ts#L1125) | 〔見出し〕取引先の登録・編集・統合・削除（#161） | roster.js |
| DELETE | `/api/admin/roster/partners/:pid` | 管理者（4ロール） | [roster.ts:1210](../src/roster.ts#L1210) | 削除: 所属スタッフ・支払先のシフト・予約中の区分変更がない取引先だけ | roster.js |
| PUT | `/api/admin/roster/partners/:pid` | 管理者（4ロール） | [roster.ts:1143](../src/roster.ts#L1143) | 編集。名前を変えたら、所属スタッフの所属会社名もそろえる | roster.js |
| GET | `/api/admin/roster/partners/:pid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:972](../src/roster.ts#L972) | 協力会社の詳細: 連絡先・つながったクライアント・在籍中の所属スタッフ・月の支払と請求の要約・つなぐときのクライアントの選択肢 | roster.js |
| PUT | `/api/admin/roster/partners/:pid{[0-9]+}/client` | 管理者（4ロール） | [roster.ts:1020](../src/roster.ts#L1020) | つなぐ・外す。body: { client_id: number \| null }。同じクライアントを2つの協力会社につなげない | roster.js |
| POST | `/api/admin/roster/partners/:pid/merge` | 管理者（4ロール） | [roster.ts:1179](../src/roster.ts#L1179) | 統合: 表記ゆれなどで分かれた取引先（pid）を、統合先（into_id）にまとめる。 所属スタッフ・未確定のシフトの支払先・予約中の区分変更を統合先に付け替え、統合先の空欄の連絡先は統合元の値で埋める。 確定済みの精算のシフトは支払先を変えない（統合元の行は、使われていなければ削除し、使われていれば統合済みとして残… | roster.js |
| GET | `/api/admin/roster/partners/by-client/:cid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:999](../src/roster.ts#L999) | クライアント詳細の「協力会社としての支払」の欄: つながった協力会社と、その会社への月の支払。つながっていなければ、つなげる協力会社の選択肢 | roster.js |
| GET | `/api/admin/roster/share-codes` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:869](../src/roster.ts#L869) | 一覧（自社専用コードをまだ発行していない人は code が null） | roster.js |
| POST | `/api/admin/roster/share-codes` | 管理者（4ロール） | [roster.ts:876](../src/roster.ts#L876) | 〔見出し〕連携用IDの一覧（#539 所属元: 複数のスタッフのIDをまとめて出す） | roster.js |
| GET | `/api/admin/security/settings` | 会社管理者 | [api.ts:1111](../src/api.ts#L1111) | 〔見出し〕会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） | security.js |
| PUT | `/api/admin/security/settings` | 会社管理者 | [api.ts:1116](../src/api.ts#L1116) | 〔見出し〕会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） | security.js |
| GET | `/api/admin/security/staff` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1162](../src/api.ts#L1162) | ログインを終了させるスタッフを選ぶ: 名前・スタッフ番号で探す。空欄なら、ログイン中の端末があるスタッフを最近のログイン順に出す | security.js |
| GET | `/api/admin/security/users` | 会社管理者 | [api.ts:1121](../src/api.ts#L1121) | 管理者アカウントの二段階認証の状態とログイン中の端末の数 | security.js |
| DELETE | `/api/admin/security/users/:id/mfa` | 会社管理者 | [api.ts:1136](../src/api.ts#L1136) | 端末を失くした管理者の二段階認証を解除する（次のログインはパスワードだけ。必須の設定なら登録し直しになる） | security.js |
| DELETE | `/api/admin/security/users/:id/sessions` | 会社管理者 | [api.ts:1144](../src/api.ts#L1144) | 〔見出し〕会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） |  |
| GET | `/api/admin/settings/corrections` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [corrections.ts:677](../src/corrections.ts#L677) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| PUT | `/api/admin/settings/corrections` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [corrections.ts:682](../src/corrections.ts#L682) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/settings/lateness` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3428](../src/api.ts#L3428) | 遅刻の猶予（分）。入店・勤務開始が開始時刻から何分以内なら遅刻にしないか（report-settings.ts の lateness。#497）。 基準はシフトの開始時刻。案件ごとに上書きできる（projects.late_grace_minutes。NULL なら会社の値）。 projects は稼働中の案件と、終… | admin.js |
| PUT | `/api/admin/settings/lateness` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3449](../src/api.ts#L3449) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/settings/mail-contact` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [notifications.ts:873](../src/notifications.ts#L873) | 〔見出し〕お知らせメールの差出人の情報（#367）。companies.settings_json の mail_reply_to（返信先）・mail_contact_phone（問い合わせの電話番号） | notifications.js |
| PUT | `/api/admin/settings/mail-contact` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [notifications.ts:878](../src/notifications.ts#L878) | 〔見出し〕お知らせメールの差出人の情報（#367）。companies.settings_json の mail_reply_to（返信先）・mail_contact_phone（問い合わせの電話番号） | notifications.js |
| GET | `/api/admin/settings/photo-required` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3392](../src/api.ts#L3392) | 現在の設定・変更の記録と、変更の影響範囲（会社の設定に従う案件の数・案件ごとに上書きしている案件の数） | admin.js |
| POST | `/api/admin/settings/photo-required` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3404](../src/api.ts#L3404) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/settings/photo-skip` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:1876](../src/api.ts#L1876) | 管理者: 写真なしの報告を許可するか（companies.settings_json の photo_skip_allowed。既定は許可しない） | admin.js |
| POST | `/api/admin/settings/photo-skip` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:1881](../src/api.ts#L1881) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | admin.js |
| GET | `/api/admin/settings/reminders` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [notifications.ts:1053](../src/notifications.ts#L1053) | 〔見出し〕本人あての自動リマインド（#160）。対象の選び方と送る時点の判定は services/reminders.ts（15分おきの cron） | report-settings.js |
| PUT | `/api/admin/settings/reminders` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [notifications.ts:1058](../src/notifications.ts#L1058) | 〔見出し〕本人あての自動リマインド（#160）。対象の選び方と送る時点の判定は services/reminders.ts（15分おきの cron） | report-settings.js |
| GET | `/api/admin/settings/shift-notify` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [api.ts:6119](../src/api.ts#L6119) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js shift-board.js |
| PUT | `/api/admin/settings/shift-notify` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [api.ts:6123](../src/api.ts#L6123) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | shift-board.js |
| GET | `/api/admin/settings/site-contact` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3462](../src/api.ts#L3462) | 会社の緊急連絡先（#173）と、入店の位置が現場から離れているとみなす距離（m。0 は判定しない。#277） | admin.js |
| PUT | `/api/admin/settings/site-contact` | 管理者（4ロール） | [api.ts:3468](../src/api.ts#L3468) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/settings/staff-view` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [api.ts:6092](../src/api.ts#L6092) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js |
| PUT | `/api/admin/settings/staff-view` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [api.ts:6097](../src/api.ts#L6097) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js |
| GET | `/api/admin/settlement` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [settlement.ts:571](../src/settlement.ts#L571) | 〔見出し〕月額（固定）の請求（#9702。src/lib/monthly-billing.ts） | settlement.js |
| POST | `/api/admin/settlement/acks` | 管理者（4ロール） | [settlement.ts:842](../src/settlement.ts#L842) | shift_ids のシフトの確認事項を確認済みにする（undo: true で確認済みを取り消す） | settlement.js |
| GET | `/api/admin/settlement/cancellations/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1275](../src/settlement.ts#L1275) | 入力欄の初期値に使う、予定の金額（請求基本額・支払基本額）と案件の規定を返す | settlement.js |
| PUT | `/api/admin/settlement/cancellations/:id` | 管理者（4ロール） | [settlement.ts:1292](../src/settlement.ts#L1292) | 欠勤のシフトのキャンセル料・補償を保存する（remove: true で取り消し、精算の対象から外す） | settlement.js |
| PUT | `/api/admin/settlement/clients/:id/closing-day` | 管理者（4ロール） | [settlement.ts:1208](../src/settlement.ts#L1208) | day: 1〜31（31 = 月末）。空欄で未設定（暦月）に戻す | settlement.js |
| GET | `/api/admin/settlement/closings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [settlement.ts:1219](../src/settlement.ts#L1219) | 〔見出し〕締め（#170） | settlement.js |
| POST | `/api/admin/settlement/closings` | 管理者（4ロール） | [settlement.ts:1232](../src/settlement.ts#L1232) | 期間を締める。期間内の精算の対象（確定・代打・キャンセル料を入れた欠勤）がすべて確定済みのときだけ締められる。 確定後に対応が必要な事項（確定後の打刻修正など）があるときは、確認してから force で締める | settlement.js |
| POST | `/api/admin/settlement/closings/:id/reopen` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [settlement.ts:1254](../src/settlement.ts#L1254) | 締めの解除は会社管理者だけ。理由を必ず残す（行は消さない） | settlement.js |
| POST | `/api/admin/settlement/confirm` | 管理者（4ロール） | [settlement.ts:760](../src/settlement.ts#L760) | 〔見出し〕確定・取り消し | settlement.js |
| GET | `/api/admin/settlement/export` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: PAYOUT_ROLES | [settlement.ts:897](../src/settlement.ts#L897) | 〔見出し〕CSV | settlement.js |
| GET | `/api/admin/settlement/monthly-rules` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1519](../src/settlement.ts#L1519) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| POST | `/api/admin/settlement/monthly-rules` | 管理者（4ロール） | [settlement.ts:1533](../src/settlement.ts#L1533) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| DELETE | `/api/admin/settlement/monthly-rules/:id` | 管理者（4ロール） | [settlement.ts:1577](../src/settlement.ts#L1577) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| PUT | `/api/admin/settlement/monthly-rules/:id` | 管理者（4ロール） | [settlement.ts:1557](../src/settlement.ts#L1557) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| GET | `/api/admin/settlement/options` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1197](../src/settlement.ts#L1197) | 精算画面を開くたびに取り直す（後から登録した案件・クライアントも選べるように）。締め日（#168）も返す | settlement.js |
| GET | `/api/admin/settlement/payout` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1070](../src/settlement.ts#L1070) | 〔見出し〕振込データ（#471） | settlement.js |
| DELETE | `/api/admin/settlement/payout/accounts/:staffId` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1188](../src/settlement.ts#L1188) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/payout/accounts/:staffId` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1154](../src/settlement.ts#L1154) | 〔見出し〕振込データ（#471） | settlement.js |
| PUT | `/api/admin/settlement/payout/accounts/:staffId` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1165](../src/settlement.ts#L1165) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/payout/export` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1084](../src/settlement.ts#L1084) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/payout/settings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1120](../src/settlement.ts#L1120) | 振込元（依頼人）の設定 | settlement.js |
| PUT | `/api/admin/settlement/payout/settings` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1126](../src/settlement.ts#L1126) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/premium-settings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1424](../src/settlement.ts#L1424) | 変更は給与の計算に関わるため、会社管理者と事務担当だけ（振込データと同じ）。変更は未確定のシフトにだけ効く（確定済みは確定したときの値のまま） | settlement.js |
| PUT | `/api/admin/settlement/premium-settings` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1428](../src/settlement.ts#L1428) | 〔見出し〕深夜・時間外・休日の割増の設定（#167） | settlement.js |
| PUT | `/api/admin/settlement/projects/:id/cancel-policy` | 管理者（4ロール） | [settlement.ts:1324](../src/settlement.ts#L1324) | 案件のキャンセル料の規定（率は 0〜100%。空欄 = 規定なし） | settlement.js |
| POST | `/api/admin/settlement/recalc` | 管理者（4ロール） | [settlement.ts:862](../src/settlement.ts#L862) | 確認事項『数量・金額が今の計算と違う』のシフトを、今の案件の時間の設定で計算し直す（amountsForActual。単価ルールは再適用しない）。 確定済みのシフトと、手動で数量も固定したシフト（qtyFixed）は変えない。単価だけを固定したもの（qty_locked = 0）は時給の数量を合わせる（#196） | settlement.js |
| GET | `/api/admin/settlement/statement` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1359](../src/settlement.ts#L1359) | 〔見出し〕支払明細書・請求明細書（#168） | settlement.js |
| POST | `/api/admin/settlement/sync-actuals` | 管理者（4ロール） | [settlement.ts:642](../src/settlement.ts#L642) | 報告から実績を求める規則は actualFromReports、金額は amountsForActual（syncActualFromReports・refreshShiftAmounts と共用） | settlement.js |
| POST | `/api/admin/settlement/transport-fill` | 管理者（4ロール） | [settlement.ts:1451](../src/settlement.ts#L1451) | shift_ids のうち、未確定・締めていない期間の勤務（確定・代打）のシフトで、交通費の実費が 0 のものに、スタッフの標準（開催場所 → スタッフ）を入れる。 入力済みの交通費は変えない。単価の手動変更（price_locked）にはしない。dry_run は件数だけを返す | settlement.js |
| POST | `/api/admin/settlement/unconfirm` | 管理者（4ロール） | [settlement.ts:800](../src/settlement.ts#L800) | 〔見出し〕確定・取り消し | settlement.js |
| GET | `/api/admin/shift-board` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:773](../src/shift-board.ts#L773) | 〔見出し〕シフトボード | shift-board.js |
| GET | `/api/admin/shift-board/candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:996](../src/shift-board.ts#L996) | 候補スタッフ（枠の役割に対して） | admin.js shift-board.js |
| GET | `/api/admin/shift-board/export` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:883](../src/shift-board.ts#L883) | 〔見出し〕クライアントに出す配置表（#298） | shift-board.js |
| GET | `/api/admin/shift-requests` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:671](../src/shift-board.ts#L671) | 〔見出し〕スタッフのシフト希望（shift_requests。#12 #353） | shift-board.js |
| POST | `/api/admin/shift-requests/:id/respond` | 管理者（4ロール） | [shift-board.ts:692](../src/shift-board.ts#L692) | 採用（accept）・見送り（decline）の返事。返事待ちのものだけ（本人が取り下げた後や二重の返事は 409） | shift-board.js |
| POST | `/api/admin/shift-slots` | 管理者（4ロール） | [shift-board.ts:1177](../src/shift-board.ts#L1177) | 〔見出し〕募集枠 | shift-board.js |
| DELETE | `/api/admin/shift-slots/:id` | 管理者（4ロール） | [shift-board.ts:1390](../src/shift-board.ts#L1390) | 〔見出し〕書き込み（枠・役割・シフトをまとめて） | shift-board.js |
| GET | `/api/admin/shift-slots/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1191](../src/shift-board.ts#L1191) | 〔見出し〕募集枠 | shift-board.js |
| PUT | `/api/admin/shift-slots/:id` | 管理者（4ロール） | [shift-board.ts:1207](../src/shift-board.ts#L1207) | 〔見出し〕募集枠 | shift-board.js |
| GET | `/api/admin/shift-slots/:id/band` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1559](../src/shift-board.ts#L1559) | 〔見出し〕帯（まとめて入れた枠・シフト）の範囲（Sprint 15 #9705） | shift-board.js |
| POST | `/api/admin/shift-slots/assign-batch` | 管理者（4ロール） | [shift-board.ts:1702](../src/shift-board.ts#L1702) | 〔見出し〕まとめて保存（Sprint 11 #9402） | shift-board.js |
| POST | `/api/admin/shift-slots/bulk-delete` | 管理者（4ロール） | [shift-board.ts:1418](../src/shift-board.ts#L1418) | 〔見出し〕書き込み（枠・役割・シフトをまとめて） | shift-board.js |
| POST | `/api/admin/shift-slots/roles/:id/assign` | 管理者（4ロール） | [shift-board.ts:1617](../src/shift-board.ts#L1617) | 役割への割り当て（複数可） | admin.js shift-board.js |
| GET | `/api/admin/shifts` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5429](../src/api.ts#L5429) | シフト管理 | admin.js |
| POST | `/api/admin/shifts` | 管理者（4ロール） | [api.ts:5457](../src/api.ts#L5457) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| DELETE | `/api/admin/shifts/:id` | 管理者（4ロール） | [api.ts:5624](../src/api.ts#L5624) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js shift-board.js |
| PUT | `/api/admin/shifts/:id` | 管理者（4ロール） | [api.ts:5515](../src/api.ts#L5515) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js shift-board.js |
| PUT | `/api/admin/shifts/:id/actual` | 管理者（4ロール） | [settlement.ts:699](../src/settlement.ts#L699) | 〔見出し〕実績の手入力 | settlement.js |
| GET | `/api/admin/shifts/:id/attendance-photos` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5443](../src/api.ts#L5443) | シフトの勤怠報告の一覧（写真の有無つき）。写真は GET /admin/attendance-photo/:attendance_id で取得する（#217） | admin.js |
| GET | `/api/admin/shifts/:id/attendance-withdrawals` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1732](../src/api.ts#L1732) | 本人が取り消した報告の記録（シフト操作のモーダルに出す。#323） | admin.js |
| GET | `/api/admin/shifts/:id/band` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1595](../src/shift-board.ts#L1595) | 〔見出し〕帯（まとめて入れた枠・シフト）の範囲（Sprint 15 #9705） | shift-board.js |
| GET | `/api/admin/shifts/:id/check-in-location` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1744](../src/api.ts#L1744) | 入店の位置と現場の距離（シフト操作のモーダルに出す。#277）。 アプリの入店は報告のときに保存した距離、報告用URLなど距離のない報告は、いまの現場の位置で計算する。基準は会社設定（0 は判定しない） | admin.js |
| POST | `/api/admin/shifts/:id/day-before-confirm` | 管理者（4ロール） | [api.ts:1613](../src/api.ts#L1613) | 前日確認を管理者が記録する（電話などで本人に確かめたとき。#176）。ダッシュボードの明日のシフトの一覧から使う | admin.js |
| POST | `/api/admin/shifts/:id/move` | 管理者（4ロール） | [shift-board.ts:1828](../src/shift-board.ts#L1828) | シフトを別の枠・役割へ移動（案件が変われば単価を再計算）。slot_role_id=null なら枠から外す | shift-board.js |
| PUT | `/api/admin/shifts/:id/price` | 管理者（4ロール） | [shift-board.ts:2006](../src/shift-board.ts#L2006) | 金額の手動変更 / ルールに戻す | settlement.js shift-board.js |
| POST | `/api/admin/shifts/:id/proxy-attendance` | 管理者（4ロール） | [staff-lifecycle.ts:980](../src/staff-lifecycle.ts#L980) | 〔見出し〕代理入力（管理者が勤怠を記録。entry_method='proxy'） | staff-lifecycle.js |
| DELETE | `/api/admin/shifts/:id/proxy-attendance/:type` | 管理者（4ロール） | [staff-lifecycle.ts:1016](../src/staff-lifecycle.ts#L1016) | 〔見出し〕代理入力（管理者が勤怠を記録。entry_method='proxy'） | staff-lifecycle.js |
| POST | `/api/admin/shifts/:id/proxy-daily-report` | 管理者（4ロール） | [staff-lifecycle.ts:1299](../src/staff-lifecycle.ts#L1299) | 電話・口頭で聞いた内容や、報告用URLの期限が過ぎた日報を管理者が記録する（entry_method = 'proxy'、entered_by = 記録した管理者）。 本人が提出した日報があるときは overwrite: true のときだけ上書きする。確認済みの日報を上書きしたら、アプリと同じく確認済みを外す | staff-lifecycle.js |
| DELETE | `/api/admin/shifts/:id/report-link` | 管理者（4ロール） | [staff-lifecycle.ts:1059](../src/staff-lifecycle.ts#L1059) | 〔見出し〕報告用URL（シフト専用。稼働日の翌日 23:59 まで有効） | staff-lifecycle.js |
| POST | `/api/admin/shifts/:id/report-link` | 管理者（4ロール） | [staff-lifecycle.ts:1042](../src/staff-lifecycle.ts#L1042) | 〔見出し〕報告用URL（シフト専用。稼働日の翌日 23:59 まで有効） | staff-lifecycle.js |
| PUT | `/api/admin/shifts/:id/report-settings` | 管理者（4ロール） | [staff-lifecycle.ts:887](../src/staff-lifecycle.ts#L887) | 〔見出し〕提出設定 | staff-lifecycle.js |
| GET | `/api/admin/shifts/:id/report-status` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:835](../src/staff-lifecycle.ts#L835) | 〔見出し〕提出設定 | admin.js settlement.js staff-lifecycle.js |
| POST | `/api/admin/shifts/bulk` | 管理者（4ロール） | [shift-board.ts:2156](../src/shift-board.ts#L2156) | 常勤の一括登録: スタッフ × 曜日 × 期間（枠なしのシフトとして登録）。 退職・統合・停止中・NG・同じ時間帯に別のシフトがある組み合わせはスキップし、理由を skipped で返す。 組み合わせ（日付順 → 指定したスタッフ順）を BULK_LIMIT 件ずつ処理し、残りがあれば next_cursor（次に処… | shift-board.js |
| POST | `/api/admin/shifts/bulk-delete` | 管理者（4ロール） | [shift-board.ts:1528](../src/shift-board.ts#L1528) | 〔見出し〕シフトのまとめて削除（Sprint 15 #9705 #9706） | shift-board.js |
| POST | `/api/admin/shifts/confirm-requested` | 管理者（4ロール） | [shift-board.ts:1874](../src/shift-board.ts#L1874) | 〔見出し〕1回の batch で登録する。同時に別の画面から同じ枠に同じ人が入った行（一意インデックス）は飛ばし、理由を返す | shift-board.js |
| POST | `/api/admin/shifts/copy-week` | 管理者（4ロール） | [shift-board.ts:2309](../src/shift-board.ts#L2309) | 〔見出し〕退職・取引終了にするときの、今後のシフトの確認と取り外し（#500 #187） | shift-board.js |
| GET | `/api/admin/shifts/price-preview` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2943](../src/shift-board.ts#L2943) | 〔見出し〕単価ルール・案件の単価設定 | admin.js shift-board.js |
| POST | `/api/admin/shifts/reprice` | 管理者（4ロール） | [shift-board.ts:2125](../src/shift-board.ts#L2125) | 〔見出し〕退職・取引終了にするときの、今後のシフトの確認と取り外し（#500 #187） | shift-board.js |
| GET | `/api/admin/sites` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2747](../src/shift-board.ts#L2747) | 開催場所 | shift-board.js |
| POST | `/api/admin/sites` | 管理者（4ロール） | [shift-board.ts:2771](../src/shift-board.ts#L2771) | 〔見出し〕開催場所 | shift-board.js |
| DELETE | `/api/admin/sites/:id` | 管理者（4ロール） | [shift-board.ts:2810](../src/shift-board.ts#L2810) | 〔見出し〕開催場所 | shift-board.js |
| PUT | `/api/admin/sites/:id` | 管理者（4ロール） | [shift-board.ts:2780](../src/shift-board.ts#L2780) | 〔見出し〕開催場所 | shift-board.js |
| GET | `/api/admin/slot-patterns` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2505](../src/shift-board.ts#L2505) | 繰り返し登録 | shift-board.js |
| POST | `/api/admin/slot-patterns` | 管理者（4ロール） | [shift-board.ts:2521](../src/shift-board.ts#L2521) | 〔見出し〕繰り返し登録 | shift-board.js |
| DELETE | `/api/admin/slot-patterns/:id` | 管理者（4ロール） | [shift-board.ts:2721](../src/shift-board.ts#L2721) | パターンの削除: remove_future=1 なら、今日以降で割り当てのない枠も削除 | shift-board.js |
| PUT | `/api/admin/slot-patterns/:id` | 管理者（4ロール） | [shift-board.ts:2553](../src/shift-board.ts#L2553) | 繰り返し登録の編集と延長（#456） apply_from 以降のこのパターンの枠に、変えた項目（時刻・休憩・役割の人数・役割の追加と削除）だけを反映する。 報告済み（勤怠・日報）・実績が確定済みのシフトがある枠は変えずに除外し、件数を返す。 時刻・休憩を変えた枠の割り当て済みシフトも同じ時刻にし（シフトごとに直した… | shift-board.js |
| GET | `/api/admin/staff` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3491](../src/api.ts#L3491) | スタッフ一覧 | admin.js |
| POST | `/api/admin/staff` | 管理者（4ロール） | [api.ts:4157](../src/api.ts#L4157) | スタッフ登録（テスト・内部用。画面からは呼ばない。画面の新規登録は名簿の登録 POST /admin/roster） |  |
| GET | `/api/admin/staff-affiliations` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4665](../src/api.ts#L4665) | 〔見出し〕所属会社マスタ（スタッフの「所属会社名」選択肢） | admin.js |
| GET | `/api/admin/staff-lookup` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:184](../src/staff-lifecycle.ts#L184) | 〔見出し〕仮登録（氏名・電話だけで登録し、すぐシフトに入れられる） | admin.js staff-lifecycle.js |
| GET | `/api/admin/staff-pay/settings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [staff-pay.ts:426](../src/staff-pay.ts#L426) | スタッフアプリに支払額を表示するか（#290。変更は会社管理者のみ） | settlement.js |
| PUT | `/api/admin/staff-pay/settings` | 管理者（4ロール）<br>＋本文で確認: 会社管理者 | [staff-pay.ts:431](../src/staff-pay.ts#L431) | 〔見出し〕管理者 API（/api/admin/pay-requests*・/api/admin/staff-pay/settings） | settlement.js |
| POST | `/api/admin/staff-quick` | 管理者（4ロール） | [staff-lifecycle.ts:190](../src/staff-lifecycle.ts#L190) | 〔見出し〕仮登録（氏名・電話だけで登録し、すぐシフトに入れられる） | staff-lifecycle.js tour.js |
| GET | `/api/admin/staff-reference-pay` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2992](../src/shift-board.ts#L2992) | 〔見出し〕スタッフの支払の参考単価（9204） | shift-board.js |
| GET | `/api/admin/staff-requests/documents` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-self-service.ts:507](../src/staff-self-service.ts#L507) | 〔見出し〕書類（本人提出の確認・種類と期限の編集・期限の一覧） | admin.js |
| PUT | `/api/admin/staff-requests/documents/:kind/:docId` | 管理者（4ロール）<br>＋本文で確認: 人事のロール | [staff-self-service.ts:517](../src/staff-self-service.ts#L517) | 種類・有効期限の変更と、本人提出の書類の確認（kind: staff / employee / client） | admin.js |
| GET | `/api/admin/staff-requests/leave` | 会社管理者・事務 | [staff-self-service.ts:547](../src/staff-self-service.ts#L547) | 〔見出し〕休暇（会社管理者・事務担当のみ） | admin.js |
| POST | `/api/admin/staff-requests/leave/:id/approve` | 会社管理者・事務 | [staff-self-service.ts:563](../src/staff-self-service.ts#L563) | 承認: 有給は従業員データの有給残数から引く（残数が未入力・足りないときは承認しない）。その日のシフトは自動では変えない（画面で欠勤の処理を案内する） | admin.js |
| POST | `/api/admin/staff-requests/leave/:id/reject` | 会社管理者・事務 | [staff-self-service.ts:595](../src/staff-self-service.ts#L595) | 〔見出し〕休暇（会社管理者・事務担当のみ） | admin.js |
| POST | `/api/admin/staff-requests/leave/:id/revoke` | 会社管理者・事務<br>＋本文で確認: 人事のロール | [staff-self-service.ts:611](../src/staff-self-service.ts#L611) | 承認の取り消し（予定の変更など）。引いた有給を戻す | admin.js |
| GET | `/api/admin/staff-requests/profile` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-self-service.ts:447](../src/staff-self-service.ts#L447) | 〔見出し〕登録情報の変更申請 | admin.js |
| POST | `/api/admin/staff-requests/profile/:id/approve` | 管理者（4ロール） | [staff-self-service.ts:468](../src/staff-self-service.ts#L468) | 〔見出し〕登録情報の変更申請 | admin.js |
| POST | `/api/admin/staff-requests/profile/:id/reject` | 管理者（4ロール） | [staff-self-service.ts:491](../src/staff-self-service.ts#L491) | 〔見出し〕登録情報の変更申請 | admin.js |
| GET | `/api/admin/staff-requests/summary` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 人事のロール | [staff-self-service.ts:434](../src/staff-self-service.ts#L434) | 画面の件数（メニューのバッジ・タブ）。休暇と入社時書類の期限は労務情報を扱えるロールだけ | admin.js |
| GET | `/api/admin/staff/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3560](../src/api.ts#L3560) | スタッフ詳細 | admin.js |
| PUT | `/api/admin/staff/:id` | 管理者（4ロール） | [api.ts:4081](../src/api.ts#L4081) | スタッフ更新（スタッフマスタ画面から） | admin.js roster.js |
| POST | `/api/admin/staff/:id/affiliation-change` | 管理者（4ロール） | [staff-lifecycle.ts:672](../src/staff-lifecycle.ts#L672) | 〔見出し〕所属区分の変更（dry_run で影響範囲を確認 → 実行） | staff-lifecycle.js |
| DELETE | `/api/admin/staff/:id/affiliation-schedules/:scheduleId` | 管理者（4ロール） | [staff-lifecycle.ts:704](../src/staff-lifecycle.ts#L704) | 区分変更の予約の取消（適用できなかった予約は、確認したら表示を消せるように同じく取消にする） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/documents` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4265](../src/api.ts#L4265) | ファイル一覧（本人がスマホから提出した書類には submitted_by_staff・確認の印が付く。#288） | admin.js |
| POST | `/api/admin/staff/:id/documents` | 管理者（4ロール） | [api.ts:4276](../src/api.ts#L4276) | アップロード（複数ファイル対応。1ファイルずつ個別に検証し、成功分のみ保存する） | admin.js |
| POST | `/api/admin/staff/:id/evaluations` | 管理者（4ロール） | [api.ts:3662](../src/api.ts#L3662) | 〔見出し〕スタッフ評価（#164） | admin.js |
| DELETE | `/api/admin/staff/:id/evaluations/:eid` | 管理者（4ロール）<br>＋本文で確認: 人事のロール | [api.ts:3697](../src/api.ts#L3697) | 〔見出し〕スタッフ評価（#164） | admin.js |
| POST | `/api/admin/staff/:id/finalize` | 管理者（4ロール） | [staff-lifecycle.ts:263](../src/staff-lifecycle.ts#L263) | 〔見出し〕本登録（仮登録を解除。ログイン発行は任意） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/future-shifts` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1956](../src/shift-board.ts#L1956) | 今後のシフトの件数と一覧。退職日を保存する前の確認に使う（from = 退職日の翌日） | admin.js |
| POST | `/api/admin/staff/:id/issue-login` | 管理者（4ロール） | [staff-lifecycle.ts:410](../src/staff-lifecycle.ts#L410) | 仮登録ではない、ログインのないスタッフ（ログインなしで登録した人・本登録でログインを発行しなかった人・他社連携から自社管理に切り替えた人）に、後からログインを発行する（#89） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/lifecycle` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:741](../src/staff-lifecycle.ts#L741) | 〔見出し〕所属区分の変更（dry_run で影響範囲を確認 → 実行） | staff-lifecycle.js |
| POST | `/api/admin/staff/:id/login-email-pending/apply` | 管理者（4ロール） | [api.ts:4137](../src/api.ts#L4137) | 〔見出し〕退職日・在籍状況（#5 #34 #139） | admin.js |
| POST | `/api/admin/staff/:id/login-email-pending/cancel` | 管理者（4ロール） | [api.ts:4147](../src/api.ts#L4147) | 〔見出し〕退職日・在籍状況（#5 #34 #139） | admin.js |
| POST | `/api/admin/staff/:id/merge` | 管理者（4ロール） | [staff-merge.ts:92](../src/staff-merge.ts#L92) | 統合の実行（dry_run で影響を確認） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/merge-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-merge.ts:54](../src/staff-merge.ts#L54) | 統合候補（同じ電話番号・同じ氏名・同じフリガナ）。q を渡すと氏名の部分一致でも探す | staff-lifecycle.js |
| PUT | `/api/admin/staff/:id/reference-pay` | 管理者（4ロール） | [shift-board.ts:2998](../src/shift-board.ts#L2998) | 〔見出し〕スタッフの支払の参考単価（9204） | shift-board.js |
| POST | `/api/admin/staff/:id/release-future-shifts` | 管理者（4ロール） | [shift-board.ts:1972](../src/shift-board.ts#L1972) | 今後のシフトをまとめて外す。記録（勤怠・日報・打刻修正・募集の承認）のないシフトは削除して枠を空きに戻し、 記録のあるシフトは残して欠勤にする。shift_ids を送ったときは、確認画面に出したものだけを処理する | admin.js |
| PUT | `/api/admin/staff/:id/report-settings` | 管理者（4ロール） | [staff-lifecycle.ts:795](../src/staff-lifecycle.ts#L795) | 〔見出し〕提出設定 | staff-lifecycle.js |
| POST | `/api/admin/staff/:id/reset-password` | 管理者（4ロール） | [staff-lifecycle.ts:776](../src/staff-lifecycle.ts#L776) | 自社でログインを発行したスタッフだけが対象。他社から連携したスタッフは所属元の会社で再発行する（稼働先の行ではログインできない）。 仮パスワードはこの応答で一度だけ返し、次回ログインで本人に変更を求める。今のセッションと未使用の再設定リンクは無効にする | staff-lifecycle.js |
| DELETE | `/api/admin/staff/:id/schedule-link` | 管理者（4ロール） | [staff-lifecycle.ts:1361](../src/staff-lifecycle.ts#L1361) | 〔見出し〕予定確認URL（#442。スタッフ単位） | staff-lifecycle.js |
| POST | `/api/admin/staff/:id/schedule-link` | 管理者（4ロール） | [staff-lifecycle.ts:1345](../src/staff-lifecycle.ts#L1345) | 発行（発行し直すと前のURLは使えなくなる）。URL はこの応答で一度だけ返す（保存するのはハッシュだけ） | staff-lifecycle.js |
| DELETE | `/api/admin/staff/:id/sessions` | 管理者（4ロール） | [api.ts:1193](../src/api.ts#L1193) | スタッフのログインを強制的に終了する（スマホの紛失・共用端末のログアウト忘れ。同じ人の他社の行のセッションも消す） | security.js |
| GET | `/api/admin/staff/:id/sessions` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 会社管理者 | [api.ts:1183](../src/api.ts#L1183) | スタッフのログイン中の端末と直近のログインの履歴（企業を切り替えた他社の画面でのログインも数に含める。会社名は出さない） | security.js |
| GET | `/api/admin/staff/:id/skill-sheet` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4188](../src/api.ts#L4188) | スキルシート生成 | admin.js |
| PUT | `/api/admin/staff/:id/skill-sheet-comment` | 管理者（4ロール） | [api.ts:4215](../src/api.ts#L4215) | 〔見出し〕退職日・在籍状況（#5 #34 #139） | admin.js |
| POST | `/api/admin/staff/:id/unverified-email` | 管理者（4ロール） | [staff-lifecycle.ts:428](../src/staff-lifecycle.ts#L428) | 未確認のメール（応募フォーム・統合元から引き継いだもの）を、本人に確認できたらログイン・再設定用に設定する／不要なら消す（#38 #148） | staff-lifecycle.js |
| DELETE | `/api/admin/staff/documents/:docId` | 管理者（4ロール） | [api.ts:4359](../src/api.ts#L4359) | 削除（D1を先に消し、R2はベストエフォート。孤立するならR2側の残骸の方が実害が小さいため） | admin.js |
| GET | `/api/admin/staff/documents/:docId/download` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4340](../src/api.ts#L4340) | ダウンロード（元ファイル名・元Content-Typeで返す。実行される事故を避けるため常にattachment指定） | admin.js |
| GET | `/api/admin/staff/options` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3540](../src/api.ts#L3540) | スタッフを選ぶための軽い一覧（シフト登録・シフトボード・NGスタッフの選択肢。#463）。集計はしない。 既定は今日の時点で割り当てられる人だけ。?include=all で、統合済み・スキルシートのみ以外の全員（退職・休職を含む）を返す | admin.js shift-board.js |
| GET | `/api/admin/support-requests` | 管理者（4ロール）＋本部の閲覧（GET） | [hq-support.ts:277](../src/hq-support.ts#L277) | 自社の伴走支援の依頼の一覧（新しい順） | hq-support.js |
| POST | `/api/admin/support-requests` | 管理者（4ロール） | [hq-support.ts:284](../src/hq-support.ts#L284) | 〔見出し〕管理画面の API（/api/admin に登録する） | hq-support.js |
| GET | `/api/admin/templates` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7727](../src/api.ts#L7727) | テンプレート一覧 (企業側から参照) project_count: そのテンプレートを使う自社の案件の数。has_reports: 自社のテンプレートで日報が出ているか（項目の削除・タイプの変更を止める） | admin.js |
| POST | `/api/admin/templates` | 管理者（4ロール） | [api.ts:7792](../src/api.ts#L7792) | 〔見出し〕日報テンプレートの作成・編集（#165） | admin.js |
| PUT | `/api/admin/templates/:id` | 管理者（4ロール） | [api.ts:7810](../src/api.ts#L7810) | 〔見出し〕日報テンプレートの作成・編集（#165） | admin.js |
| GET | `/api/admin/tours` | 管理者（4ロール）＋本部の閲覧（GET） | [tours.ts:100](../src/tours.ts#L100) |  | tour.js |
| PUT | `/api/admin/tours` | 管理者（4ロール） | [tours.ts:110](../src/tours.ts#L110) |  | tour.js |
| GET | `/api/admin/tours/checklist` | 管理者（4ロール）＋本部の閲覧（GET） | [tours.ts:119](../src/tours.ts#L119) |  | tour.js |
| GET | `/api/admin/transport-defaults` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:3075](../src/shift-board.ts#L3075) | 交通費の標準（スタッフ × 開催場所。#564）。site_id = 0 はそのスタッフのすべての開催場所の標準 割り当て・一括登録・募集の承認で、交通費の入力がなければ使う（lib/transport-defaults） | settlement.js |
| PUT | `/api/admin/transport-defaults` | 管理者（4ロール） | [shift-board.ts:3090](../src/shift-board.ts#L3090) | 登録・変更（同じスタッフ × 開催場所の標準は1つ。あれば金額を置き換える） | settlement.js |
| DELETE | `/api/admin/transport-defaults/:id` | 管理者（4ロール） | [shift-board.ts:3107](../src/shift-board.ts#L3107) | 〔見出し〕交通費の標準（スタッフ × 開催場所。#564）。site_id = 0 はそのスタッフのすべての開催場所の標準 | settlement.js |
| GET | `/api/admin/users` | 会社管理者 | [accounts.ts:307](../src/accounts.ts#L307) | 〔見出し〕管理者アカウント（/api/admin/users。会社管理者のみ） | admin.js |
| POST | `/api/admin/users` | 会社管理者 | [accounts.ts:311](../src/accounts.ts#L311) | 〔見出し〕管理者アカウント（/api/admin/users。会社管理者のみ） | admin.js |
| PUT | `/api/admin/users/:id` | 会社管理者 | [accounts.ts:316](../src/accounts.ts#L316) | 〔見出し〕管理者アカウント（/api/admin/users。会社管理者のみ） | admin.js |
| POST | `/api/admin/users/:id/reset-password` | 会社管理者 | [accounts.ts:327](../src/accounts.ts#L327) | 自分のパスワードは「自分のアカウント」から変更する（現在のパスワードの確認があるため） | admin.js |

### `/api/hq/…` 本部画面（63）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/hq/announcements` | 本部 | [hq-support.ts:369](../src/hq-support.ts#L369) | 〔見出し〕導入企業へのお知らせ | hq.js |
| POST | `/api/hq/announcements` | 本部 | [hq-support.ts:405](../src/hq-support.ts#L405) | 〔見出し〕導入企業へのお知らせ | hq.js |
| PUT | `/api/hq/announcements/:id` | 本部 | [hq-support.ts:420](../src/hq-support.ts#L420) | 修正（内容・配信先・掲載期間）。取り消したものは直せない。確認済みの記録は残す | hq.js |
| GET | `/api/hq/announcements/:id/reads` | 本部 | [hq-support.ts:387](../src/hq-support.ts#L387) | 企業別の既読状況（配信先の企業ごとに、確認した管理者の人数と最初の確認日時） | hq.js |
| POST | `/api/hq/announcements/:id/withdraw` | 本部 | [hq-support.ts:437](../src/hq-support.ts#L437) | 〔見出し〕導入企業へのお知らせ | hq.js |
| GET | `/api/hq/audit-logs` | 本部 | [api.ts:8328](../src/api.ts#L8328) | 〔見出し〕本部の操作の履歴（#542） | hq.js |
| POST | `/api/hq/billing/close` | 本部 | [api.ts:8226](../src/api.ts#L8226) | 指定した月の請求を記録する（締める）。利用中（active）の企業ごとに、この時点の課金対象の人数・プラン・金額を残す。 すでに記録がある企業は変えない（金額・入金状態は企業詳細で直す）。トライアル・停止中の企業は記録しない | hq.js |
| GET | `/api/hq/companies` | 本部 | [api.ts:7900](../src/api.ts#L7900) | 〔見出し〕プランの料金（#295） | hq.js security.js |
| POST | `/api/hq/companies` | 本部 | [api.ts:8123](../src/api.ts#L8123) | 〔見出し〕プランの料金（#295） | hq.js |
| GET | `/api/hq/companies/:id` | 本部 | [api.ts:7987](../src/api.ts#L7987) | 〔見出し〕プランの料金（#295） | hq.js |
| PUT | `/api/hq/companies/:id` | 本部 | [api.ts:8046](../src/api.ts#L8046) | 〔見出し〕プランの料金（#295） | hq.js |
| PUT | `/api/hq/companies/:id/billing/:month` | 本部 | [api.ts:8258](../src/api.ts#L8258) | 1か月分の請求記録の修正（入金状態・入金日・金額・メモ） | hq.js |
| POST | `/api/hq/companies/:id/support-logs` | 本部 | [api.ts:8299](../src/api.ts#L8299) | 追記で残す。次回の予定日を入れると、企業の次回レビュー日もその日にする | hq.js |
| POST | `/api/hq/companies/:id/users` | 本部 | [accounts.ts:345](../src/accounts.ts#L345) | 〔見出し〕本部（/api/hq/companies/:id/users の追加・変更。一覧は GET /api/hq/companies/:id の users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア） | hq.js |
| PUT | `/api/hq/companies/:id/users/:uid` | 本部 | [accounts.ts:352](../src/accounts.ts#L352) | 〔見出し〕本部（/api/hq/companies/:id/users の追加・変更。一覧は GET /api/hq/companies/:id の users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア） | hq.js |
| POST | `/api/hq/companies/:id/users/:uid/reset-password` | 本部 | [accounts.ts:359](../src/accounts.ts#L359) | 〔見出し〕本部（/api/hq/companies/:id/users の追加・変更。一覧は GET /api/hq/companies/:id の users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア） | hq.js |
| GET | `/api/hq/cron/status` | 本部 | [api.ts:8578](../src/api.ts#L8578) | 定期処理（cron）の処理ごとの最終実行・直近の実行記録・警告（#192） | hq.js |
| GET | `/api/hq/email-logs` | 本部 | [notifications.ts:996](../src/notifications.ts#L996) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| GET | `/api/hq/email-stats` | 本部 | [notifications.ts:954](../src/notifications.ts#L954) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| GET | `/api/hq/email-suppressions` | 本部 | [notifications.ts:1006](../src/notifications.ts#L1006) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| POST | `/api/hq/email-suppressions/release` | 本部 | [notifications.ts:1013](../src/notifications.ts#L1013) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| GET | `/api/hq/errors` | 本部 | [hq-errors.ts:22](../src/hq-errors.ts#L22) |  | hq.js |
| GET | `/api/hq/errors/alerts` | 本部 | [hq-errors.ts:82](../src/hq-errors.ts#L82) | 自分あての未読の障害の通知（本部画面のタブの件数に使う。軽い問い合わせ1回） | hq.js |
| POST | `/api/hq/errors/alerts/read` | 本部 | [hq-errors.ts:90](../src/hq-errors.ts#L90) | 自分あての障害の通知を既読にする（画面を開いて「確認しました」を押したとき）。操作の履歴（hq_audit_logs）には残さない | hq.js |
| GET | `/api/hq/login-history` | 本部 | [api.ts:1255](../src/api.ts#L1255) | 全社のログインの履歴（会社コードの誤りなど、会社が分からない試行も含む） | security.js |
| GET | `/api/hq/offboarding` | 本部 | [api.ts:8611](../src/api.ts#L8611) | 一覧: 停止中の企業と、解約の処理の記録がある企業 | hq.js |
| GET | `/api/hq/offboarding/:cid` | 本部 | [api.ts:8627](../src/api.ts#L8627) | 詳細: 解約の処理・操作の記録・表ごとの件数（削除の dry-run を兼ねる）・R2 のファイルの件数 | hq.js |
| POST | `/api/hq/offboarding/:cid/cancel` | 本部 | [api.ts:8677](../src/api.ts#L8677) | 契約終了の取消（猶予中だけ。削除を始めた後は取り消せない） | hq.js |
| POST | `/api/hq/offboarding/:cid/delete` | 本部 | [api.ts:8759](../src/api.ts#L8759) | 削除（猶予を過ぎた企業だけ。会社コードと「削除する」の入力で確かめる）。1回の要求で処理できる量だけ進め、進み具合を返す。 書き出しをしていない場合は、書き出しをしない理由（企業が不要と回答した など）を求める | hq.js |
| GET | `/api/hq/offboarding/:cid/export/:target` | 本部 | [api.ts:8704](../src/api.ts#L8704) | 表ごとの CSV（offset から OFFBOARDING_EXPORT_PAGE 行。次があれば X-Export-Next に次の offset を入れる）。最初の取得を記録する | hq.js |
| GET | `/api/hq/offboarding/:cid/files` | 本部 | [api.ts:8723](../src/api.ts#L8723) | R2 の写真・書類の一覧（offset から OFFBOARDING_FILES_PAGE 件） | hq.js |
| GET | `/api/hq/offboarding/:cid/files/:source/:id` | 本部 | [api.ts:8735](../src/api.ts#L8735) | R2 のファイル1件の取得（元の表と行の ID で。その企業のものだけ）。取得を記録する | hq.js |
| GET | `/api/hq/offboarding/:cid/record.csv` | 本部 | [api.ts:8804](../src/api.ts#L8804) | 〔見出し〕解約・停止した企業のデータの書き出しと削除（system_admin限定。作業単位 w5-hq-offboarding: #177） | hq.js |
| POST | `/api/hq/offboarding/:cid/start` | 本部 | [api.ts:8649](../src/api.ts#L8649) | 契約終了の登録（停止中の企業だけ）。会社コードの入力で確かめる | hq.js |
| GET | `/api/hq/plan-prices` | 本部 | [api.ts:8193](../src/api.ts#L8193) | 〔見出し〕プランの料金の設定（#295） | hq.js |
| PUT | `/api/hq/plan-prices` | 本部 | [api.ts:8196](../src/api.ts#L8196) | 〔見出し〕プランの料金の設定（#295） | hq.js |
| GET | `/api/hq/push/config` | 本部 | [notifications.ts:1952](../src/notifications.ts#L1952) | 〔見出し〕プッシュ通知（#178） | hq.js |
| GET | `/api/hq/push/latest` | 本部 | [notifications.ts:2066](../src/notifications.ts#L2066) | 〔見出し〕プッシュ通知（#178） |  |
| POST | `/api/hq/push/subscribe` | 本部 | [notifications.ts:1965](../src/notifications.ts#L1965) | 〔見出し〕プッシュ通知（#178） | hq.js |
| POST | `/api/hq/push/test` | 本部 | [notifications.ts:1995](../src/notifications.ts#L1995) | テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す） | hq.js |
| POST | `/api/hq/push/unsubscribe` | 本部 | [notifications.ts:1987](../src/notifications.ts#L1987) | 〔見出し〕プッシュ通知（#178） | hq.js |
| POST | `/api/hq/retention/dry-run` | 本部 | [api.ts:8397](../src/api.ts#L8397) | 注意: 実際の削除はCron Triggerからのみ実行する（HTTP経由の一般APIとしては公開しない）。 ここではdry-run（削除せず対象件数のみ確認）と、過去の実行ログの閲覧のみ提供する。 全社にまたがる集計のため、各社admin(company_admin等)ではなく本部(system_admin)限定と… | hq.js |
| DELETE | `/api/hq/retention/holds/:kind/:id` | 本部 | [api.ts:8497](../src/api.ts#L8497) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| PUT | `/api/hq/retention/holds/:kind/:id` | 本部 | [api.ts:8486](../src/api.ts#L8486) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| GET | `/api/hq/retention/logs` | 本部 | [api.ts:8414](../src/api.ts#L8414) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| POST | `/api/hq/retention/orphan-photos` | 本部 | [api.ts:8507](../src/api.ts#L8507) | R2 に残った、どの勤怠にも紐づかない写真（#533 の残り）。1回に500件ずつ見て、cursor で続きを見る。 dry_run=false のときだけ、そのページの紐づかない写真を消す（消した件数は実行ログに残す） | hq.js |
| GET | `/api/hq/retention/schedule` | 本部 | [api.ts:8405](../src/api.ts#L8405) | 次回削除予定（猶予中・猶予待ち）と、退職日より後にシフトがあるため対象外にしている退職者の一覧。 今の動作モード（RETENTION_ENABLED が 'true' なら実削除、それ以外は dry-run のみ）も返す（#365） | hq.js |
| GET | `/api/hq/retention/settings` | 本部 | [api.ts:8463](../src/api.ts#L8463) | 在職中の保存期間の設定（位置情報と写真・相談・フォロー記録・決着した人材提案。#420 #511 #350） | hq.js |
| PUT | `/api/hq/retention/settings` | 本部 | [api.ts:8466](../src/api.ts#L8466) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| GET | `/api/hq/security` | 本部 | [api.ts:1204](../src/api.ts#L1204) | 本部ユーザーの二段階認証の必須・接続元の制限は、本部専用の企業行の設定に持つ | security.js |
| POST | `/api/hq/security/clear-ip` | 本部 | [api.ts:1234](../src/api.ts#L1234) | 企業の接続元の制限を外す（企業側で設定を誤って管理者が誰も入れなくなったときの窓口） | security.js |
| POST | `/api/hq/security/reset-mfa` | 本部 | [api.ts:1217](../src/api.ts#L1217) | 端末を失くした人の二段階認証の解除（会社コード＋ID で指定。会社コードが空欄なら本部ユーザー）。会社管理者が1人で解除できないときの窓口 | security.js |
| PUT | `/api/hq/security/settings` | 本部 | [api.ts:1212](../src/api.ts#L1212) | 〔見出し〕本部（/api/hq/security・/api/hq/login-history） | security.js |
| DELETE | `/api/hq/security/users/:id/sessions` | 本部 | [api.ts:1244](../src/api.ts#L1244) | 〔見出し〕本部（/api/hq/security・/api/hq/login-history） |  |
| GET | `/api/hq/support-requests` | 本部 | [hq-support.ts:344](../src/hq-support.ts#L344) | 〔見出し〕伴走支援の依頼の受付一覧 | hq.js |
| PUT | `/api/hq/support-requests/:id` | 本部 | [hq-support.ts:355](../src/hq-support.ts#L355) | 〔見出し〕伴走支援の依頼の受付一覧 | hq.js |
| GET | `/api/hq/templates` | 本部 | [api.ts:8356](../src/api.ts#L8356) | 企業独自のテンプレートは会社名、どれも使っている案件の数と日報の有無（編集できる範囲の表示に使う。#165）を付ける | hq.js |
| POST | `/api/hq/templates` | 本部 | [api.ts:8364](../src/api.ts#L8364) | 〔見出し〕本部の操作の履歴（#542） | hq.js |
| PUT | `/api/hq/templates/:id` | 本部 | [api.ts:8382](../src/api.ts#L8382) | テンプレートの修正・配信停止（#165）。本部のテンプレートのほか、企業独自のテンプレートも直せる（規則は企業と同じ） | hq.js |
| GET | `/api/hq/view-sessions` | 本部 | [hq-support.ts:447](../src/hq-support.ts#L447) | 企業ごとの許可の状態・自分の閲覧中のもの・最近の閲覧の記録 | hq.js |
| POST | `/api/hq/view-sessions` | 本部 | [hq-support.ts:468](../src/hq-support.ts#L468) | 閲覧の開始。企業が許可しているときだけ。同じ本部ユーザーの閲覧中のものは終える（同時に開けるのは1社だけ） | hq.js |
| GET | `/api/hq/view-sessions/:id/logs` | 本部 | [hq-support.ts:460](../src/hq-support.ts#L460) | 〔見出し〕管理画面の閲覧（読み取り専用） | hq.js |
| DELETE | `/api/hq/view-sessions/current` | 本部 | [hq-support.ts:500](../src/hq-support.ts#L500) | 閲覧の終了（自分の閲覧中のもの） | hq-support.js hq.js |
<!-- END GENERATED: api-endpoints -->

## 本文で参照しているコードの位置

<!-- BEGIN GENERATED: api-refs -->
| 名前 | 位置 |
|---|---|
| `MIDDLEWARE_DEFS` | [scripts/gen-docs.mjs:387](../scripts/gen-docs.mjs#L387) |
| `csvResponse` | [csv.ts:30](../src/csv.ts#L30) |
| `maskPath` | [index.tsx:15](../src/index.tsx#L15) |
| `SESSION_COOKIE` | [lib/auth.ts:8](../src/lib/auth.ts#L8) |
| `sessionCookieOptions` | [lib/auth.ts:148](../src/lib/auth.ts#L148) |
| `SESSION_IDLE_HOURS` | [api.ts:802](../src/api.ts#L802) |
| `SESSION_MAX_DAYS` | [api.ts:803](../src/api.ts#L803) |
| `SESSION_HOURS` | [lib/auth.ts:9](../src/lib/auth.ts#L9) |
| `isISODate` | [lib/validate.ts:9](../src/lib/validate.ts#L9) |
| `isHHMM` | [lib/validate.ts:4](../src/lib/validate.ts#L4) |
| `toInt` | [lib/validate.ts:21](../src/lib/validate.ts#L21) |
| `oneOf` | [lib/validate.ts:16](../src/lib/validate.ts#L16) |
| `ownStaff` | [lib/tenant.ts:23](../src/lib/tenant.ts#L23) |
| `hqViewAdminGuard` | [hq-support.ts:197](../src/hq-support.ts#L197) |
<!-- END GENERATED: api-refs -->
