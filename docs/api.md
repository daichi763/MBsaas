# API 一覧

Field OS のサーバー（Cloudflare Workers + Hono）が受け付ける、すべてのエンドポイントの一覧です。新しく加わる開発者や外部の開発会社が、前提知識なしで読めるように書いています。

- 関連する資料: [DB 設計書](db.md)・[画面一覧](screens.md)
- 一覧（下の「4. エンドポイントの一覧」）はコードから生成しています。手で直さず、`npm run docs` で作り直してください（作り方は [DB 設計書](db.md) の「この資料の作り方」と同じです）。

## この資料の作り方

生成は、リポジトリの中のファイルだけで行います。本番には接続しません。

1. `src/api.ts` を esbuild で1つのファイルにまとめて Node.js で読み込み、Hono が持っているルートの一覧（`api.routes`。登録した順）を取ります。ここにはミドルウェア（`api.use`）も、登録した順に入っています。
2. `src/*.ts` のルートの定義の行（`api.get('/…'` など）を読み、1 と突き合わせて「定義（ファイル:行）」と「用途」を付けます。「用途」は、定義の直前のコメントです。コメントがなければ、上にあるいちばん近い見出しのコメントを「〔見出し〕」を付けて出します（離れた所の見出しのこともあるので、目安です）。
3. 「通すロール」は、そのルートより前に登録された、パスの当たるミドルウェアから計算します（Hono は登録した順に実行するので、認証のミドルウェアより前に登録したルートはログインなしで通ります）。ミドルウェアの意味は [`MIDDLEWARE_DEFS`](../scripts/gen-docs.mjs) に人が書いています。説明のないミドルウェアが増えると、生成のときに注意が出ます。
4. 「本文で確認」は、ルートの本文に、ロールを確かめる書き方（権限の表の `can(u, '操作')`・`HR_ROLES`・`role !== 'company_admin'` など）があるものです。文字を探しているだけなので、細かい条件は本文を読んで確かめてください。
5. 「画面の JS」は、`public/static/*.js`（と `src/index.tsx` の中の script）にある `/api/…` の文字列を読み、メソッドとパスの形が合うものです。見つからないものは、使っていないとは限りません（パスを組み立てて呼んでいる・Service Worker やメールのリンクから呼ぶ、など）。

ルートを足したり変えたりしたら、`npm run docs` で作り直します。`src/api.ts` 以外のファイルにルートを足したときは、`src/api.ts` の `api.route('/…', …)` で付けないと、ここにも出ません（サーバーでも動きません）。

## 1. 共通の約束

### 1.1 パスと形式

- API はすべて `/api` の下です。画面（HTML）と Service Worker・Webhook は `src/index.tsx` にあります（下の「3. 画面などのルート」）。
- 送るのも返すのも JSON です（CSV のダウンロードは除く。CSV は [`csvResponse`](../src/csv.ts) で返します）。
- エラーは `{ "error": "日本語の説明" }` で返します。画面が分岐に使う場合は `code`（例: `company_inactive`・`mfa_setup_required`・`account_switched`・`hq_view_readonly`・`csrf_origin`）も付けます。
- 予期しないエラーは、`src/index.tsx` の `app.onError` が 500 と `{ "error": "…参照番号: xxxx", "ref": "xxxx" }` を返し、同じ参照番号で Workers のログに1行の JSON を残します（パスの中のトークンは [`maskPath`](../src/index.tsx) で伏せます）。

### 1.2 ログインとセッション

- ログインは `POST /api/auth/login`（二段階認証がある人は続けて `POST /api/auth/login/mfa`）。成功すると、Cookie `session`（[`SESSION_COOKIE`](../src/lib/auth.ts)。HttpOnly・SameSite=Lax・https では Secure。[`sessionCookieOptions`](../src/lib/auth.ts)）が付きます。
- `/api/*` の認証のミドルウェア（`src/api.ts` の `api.use('/*', …)`）が、Cookie のセッションを確かめます。期限切れ・退職・停止中の会社は 401 か 403 です。
- 書き込み（GET・HEAD・OPTIONS 以外）は、送り元（`Origin`。無ければ `Referer`）が自分のサイト（リクエストのホストか `APP_BASE_URL`）のときだけ通し、違えば 403（`csrf_origin`）で止めます（CSRF の対策。[`csrfGuard`](../src/lib/csrf.ts)。#9943）。`Origin` も `Referer` も無い要求は、セッションの Cookie を付けたものだけ止めます（curl などからのログインは通ります）。`/api/public/*`（トークンで入る公開の API）と `/webhooks/resend`（署名で確かめる）は対象外です。
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

- 「管理者（4ロール）」は、`company_admin`・`sales_manager`・`field_manager`・`office_staff` のことです（`src/lib/permissions.ts` の `ADMIN_ROLES`）。
- 「会社管理者・事務」は労務情報を扱えるロールです（権限の表の `hr.manage`）。
- ロールごとにできる操作は、権限の表（`src/lib/permissions.ts` の `PERMISSIONS`。一覧は [permissions.md](permissions.md)）にまとめてあります。ミドルウェアは `requirePerm('操作')`、ハンドラーは `can(u, '操作')` で表を見ます。
- 本部の閲覧の仕組みは [`hqViewAdminGuard`](../src/hq-support.ts) にあります。閲覧の操作は `hq_view_logs` に残ります。
- 本部の書き込みは、`hq_audit_logs` に記録します。

## 3. 全体の数

<!-- BEGIN GENERATED: api-summary -->
- エンドポイント: 569（GET 258・POST 196・PUT 79・PATCH 0・DELETE 36）
- ミドルウェア: 24・画面などのルート（src/index.tsx）: 13
- 画面の JS（public/static）から呼んでいる形が見つかったもの: 557・見つからないもの: 12

| 区分 | 数 |
|---|---|
| `/api/public/…` 公開（ログイン不要。トークンの URL） | 10 |
| `/api/auth/…` ログイン・自分のアカウント | 17 |
| `/api/staff/…` スタッフアプリ | 83 |
| `/api/admin/…` 管理画面 | 392 |
| `/api/hq/…` 本部画面 | 67 |

| 通すロール | 数 |
|---|---|
| 管理者（4ロール） | 203 |
| 管理者（4ロール）＋本部の閲覧（GET） | 166 |
| スタッフ | 83 |
| 本部 | 67 |
| ログイン不要 | 16 |
| 会社管理者・事務 | 13 |
| ログイン中の全員 | 11 |
| 会社管理者 | 10 |
<!-- END GENERATED: api-summary -->

### ミドルウェア（登録した順）

<!-- BEGIN GENERATED: api-middlewares -->
| 順 | パス | 定義 | 内容 |
|---|---|---|---|
| 1 | `/api/*` | [api.ts:100](../src/api.ts#L100) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の読み書きの行数。src/lib/d1-retry.ts） |
| 2 | `/api/public/recruit/:token/*` | [recruit.ts:240](../src/recruit.ts#L240) | 募集ページの会社が停止中なら 410 |
| 3 | `/api/*` | [api.ts:746](../src/api.ts#L746) | ログイン必須（セッションの確認・延長・二段階認証の登録待ちの制限） |
| 4 | `/api/auth/*` | [api.ts:836](../src/api.ts#L836) | 本部の閲覧中は書き込み不可 |
| 5 | `/api/admin/*` | [api.ts:861](../src/api.ts#L861) | 本部は、企業が許可した閲覧の間だけ GET を通す（閲覧中は sales_manager として扱う） |
| 6 | `/api/admin/*` | [api.ts:862](../src/api.ts#L862) | 管理系の4ロールだけ（権限の表の admin.access: 管理画面（/admin）と /api/admin/* を使う） |
| 7 | `/api/admin/employees` | [api.ts:865](../src/api.ts#L865) | 会社管理者・事務だけ（権限の表の hr.manage: 労務情報（従業員管理・入社時書類・休暇の申請・自社雇用の最寄駅の変更の承認・ダッシュボードの労務の知らせ）） |
| 8 | `/api/admin/employees/*` | [api.ts:866](../src/api.ts#L866) | 会社管理者・事務だけ（権限の表の hr.manage: 労務情報（従業員管理・入社時書類・休暇の申請・自社雇用の最寄駅の変更の承認・ダッシュボードの労務の知らせ）） |
| 9 | `/api/hq/*` | [api.ts:867](../src/api.ts#L867) | 本部だけ（権限の表の hq.access: 本部画面の API（/api/hq/*）を使う） |
| 10 | `/api/hq/*` | [api.ts:871](../src/api.ts#L871) | 本部の書き込みを hq_audit_logs に記録 |
| 11 | `/api/staff/*` | [api.ts:891](../src/api.ts#L891) | スタッフだけ（権限の表の staff_app.access: スタッフアプリの API（/api/staff/*）を使う） |
| 12 | `/api/admin/security/settings` | [api.ts:1095](../src/api.ts#L1095) | 会社管理者だけ（権限の表の security.manage: セキュリティの設定・管理者の二段階認証・ログインの履歴（スタッフ詳細のログインの履歴も）） |
| 13 | `/api/admin/security/users` | [api.ts:1096](../src/api.ts#L1096) | 会社管理者だけ（権限の表の security.manage: セキュリティの設定・管理者の二段階認証・ログインの履歴（スタッフ詳細のログインの履歴も）） |
| 14 | `/api/admin/security/users/*` | [api.ts:1097](../src/api.ts#L1097) | 会社管理者だけ（権限の表の security.manage: セキュリティの設定・管理者の二段階認証・ログインの履歴（スタッフ詳細のログインの履歴も）） |
| 15 | `/api/admin/login-history` | [api.ts:1098](../src/api.ts#L1098) | 会社管理者だけ（権限の表の security.manage: セキュリティの設定・管理者の二段階認証・ログインの履歴（スタッフ詳細のログインの履歴も）） |
| 16 | `/api/admin/users` | [accounts.ts:301](../src/accounts.ts#L301) | 会社管理者だけ（権限の表の admin_users.manage: 管理者アカウント（追加・ロールの変更・停止・パスワードの再発行）） |
| 17 | `/api/admin/users/*` | [accounts.ts:302](../src/accounts.ts#L302) | 会社管理者だけ（権限の表の admin_users.manage: 管理者アカウント（追加・ロールの変更・停止・パスワードの再発行）） |
| 18 | `/api/admin/staff-requests/leave` | [staff-self-service.ts:532](../src/staff-self-service.ts#L532) | 会社管理者・事務だけ（権限の表の hr.manage: 労務情報（従業員管理・入社時書類・休暇の申請・自社雇用の最寄駅の変更の承認・ダッシュボードの労務の知らせ）） |
| 19 | `/api/admin/staff-requests/leave/*` | [staff-self-service.ts:533](../src/staff-self-service.ts#L533) | 会社管理者・事務だけ（権限の表の hr.manage: 労務情報（従業員管理・入社時書類・休暇の申請・自社雇用の最寄駅の変更の承認・ダッシュボードの労務の知らせ）） |
| 20 | `/api/admin/roster-chat/*` | [roster-chat.ts:22](../src/roster-chat.ts#L22) | 管理系の4ロールだけ（権限の表の roster_chat.use: 企業間チャット） |
| 21 | `/api/admin/shift-slots/roles/:id/assign` | [shift-board.ts:1622](../src/shift-board.ts#L1622) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の回数。src/lib/d1-retry.ts） |
| 22 | `/api/admin/recruit-applications/:id/decide` | [recruit.ts:869](../src/recruit.ts#L869) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の回数。src/lib/d1-retry.ts） |
| 23 | `/api/staff/attendance` | [api.ts:1776](../src/api.ts#L1776) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の回数・過負荷のまね。src/lib/d1-retry.ts） |
| 24 | `/api/staff/attendance-photo` | [api.ts:1777](../src/api.ts#L1777) | テスト用の仕掛け（TEST_HOOKS のローカルだけ。D1 の回数・過負荷のまね。src/lib/d1-retry.ts） |
<!-- END GENERATED: api-middlewares -->

### 画面などのルート（src/index.tsx）

<!-- BEGIN GENERATED: api-pages -->
| メソッド | パス | 定義 | 用途 |
|---|---|---|---|
| GET | `/api/health` | [index.tsx:104](../src/index.tsx#L104) | ログイン不要・CSRF の対象外（GET だけ）。D1 に SELECT 1 だけを投げ、R2 には触らない。応答は ok と版の短い ID だけ（内部の情報は出さない）。 D1 につながらないときは 503（本文に ok を含めないので、キーワードの監視でも落ちたと分かる）。キャッシュさせない |
| GET | `/sw.js` | [index.tsx:180](../src/index.tsx#L180) | Service Worker（スタッフ画面・本部画面・管理画面のプッシュ通知の表示。#178 #9622 #552） |
| POST | `/webhooks/resend` | [index.tsx:184](../src/index.tsx#L184) | ログイン不要。署名（RESEND_WEBHOOK_SECRET。wrangler secret で登録する）を確かめてから送信の記録を更新する（src/services/email.ts） |
| GET | `/` | [index.tsx:227](../src/index.tsx#L227) | ルート: ロール別リダイレクト |
| GET | `/login` | [index.tsx:247](../src/index.tsx#L247) | ログイン済みならホームへ移す（入力し直しと、不要なセッションの増加を防ぐ） |
| GET | `/reset-password` | [index.tsx:476](../src/index.tsx#L476) | パスワード再設定ページ（メール内リンクからアクセス。トークンはクエリパラメータで受け取る） |
| GET | `/verify-email` | [index.tsx:557](../src/index.tsx#L557) | ログイン用メールアドレスの確認ページ（#207。管理者が登録したアドレスに届いたリンクから開く）。 メールソフトのリンクの事前読み込みで確認済みにならないよう、ボタンを押したときに確認する |
| GET | `/notice-ack` | [index.tsx:605](../src/index.tsx#L605) | お知らせメールの「確認しました」（#454。メールのリンクから開く）。 メールソフトのリンクの事前読み込みで既読にならないよう、ボタンを押したときに既読にする（/api/public/notice-ack） |
| GET | `/r/:token` | [index.tsx:663](../src/index.tsx#L663) | シフト専用の報告用URL（ログイン不要。public/static/report-link.js） |
| GET | `/apply/:token` | [index.tsx:677](../src/index.tsx#L677) | 公開の募集ページ（ログイン不要。/api/public/recruit/:token） |
| GET | `/staff` | [index.tsx:691](../src/index.tsx#L691) | スタッフ画面 (スマホファースト SPA) |
| GET | `/admin` | [index.tsx:731](../src/index.tsx#L731) | 管理者画面 (PC向け SPA) |
| GET | `/hq` | [index.tsx:823](../src/index.tsx#L823) | SaaS本部管理画面 |
<!-- END GENERATED: api-pages -->

## 4. エンドポイントの一覧

パスの `:id` などはパラメーター、`:id{[0-9]+}` は数字だけを受け付けるパラメーターです。

<!-- BEGIN GENERATED: api-endpoints -->
### `/api/public/…` 公開（ログイン不要。トークンの URL）（10）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/public/calendar/:file` | ログイン不要 | [staff-schedule.ts:221](../src/staff-schedule.ts#L221) | 〔見出し〕購読用（ログイン不要。/api/public/calendar/<トークン>.ics） |  |
| GET | `/api/public/notice-ack` | ログイン不要 | [notifications.ts:1197](../src/notifications.ts#L1197) | 〔見出し〕お知らせメールの「確認しました」のリンク（#454） | src/index.tsx |
| POST | `/api/public/notice-ack` | ログイン不要 | [notifications.ts:1203](../src/notifications.ts#L1203) | 〔見出し〕お知らせメールの「確認しました」のリンク（#454） | src/index.tsx |
| GET | `/api/public/recruit/:token` | ログイン不要 | [recruit.ts:248](../src/recruit.ts#L248) | 〔見出し〕公開ページ（ログイン不要） | apply.js |
| POST | `/api/public/recruit/:token/apply` | ログイン不要 | [recruit.ts:291](../src/recruit.ts#L291) | 〔見出し〕公開ページ（ログイン不要） | apply.js |
| GET | `/api/public/report/:token` | ログイン不要 | [staff-lifecycle.ts:1538](../src/staff-lifecycle.ts#L1538) | 〔見出し〕ログイン不要の報告用URL（/api/public/report/:token） | report-link.js |
| POST | `/api/public/report/:token/attendance` | ログイン不要 | [staff-lifecycle.ts:1580](../src/staff-lifecycle.ts#L1580) | 〔見出し〕ログイン不要の報告用URL（/api/public/report/:token） | report-link.js |
| POST | `/api/public/report/:token/consultation` | ログイン不要 | [staff-lifecycle.ts:1771](../src/staff-lifecycle.ts#L1771) | 〔見出し〕報告用URL・予定確認URLからの連絡（#163） | report-link.js |
| GET | `/api/public/report/:token/contact` | ログイン不要 | [api.ts:722](../src/api.ts#L722) | 報告用URLに出す会社の緊急連絡先（#173）。期限切れ・取り消し後の画面でも連絡できるよう、発行済みのURLなら返す（停止中の企業は返さない）。 返すのは会社名と連絡先だけ（シフト・スタッフの情報は返さない） | report-link.js |
| POST | `/api/public/report/:token/daily-report` | ログイン不要 | [staff-lifecycle.ts:1648](../src/staff-lifecycle.ts#L1648) | 〔見出し〕ログイン不要の報告用URL（/api/public/report/:token） | report-link.js |

### `/api/auth/…` ログイン・自分のアカウント（17）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/auth/account` | ログイン中の全員 | [accounts.ts:192](../src/accounts.ts#L192) | 〔見出し〕自分のアカウント（/api/auth/*。ログインしている全ロール） | admin.js |
| PUT | `/api/auth/account` | ログイン中の全員 | [accounts.ts:208](../src/accounts.ts#L208) | 氏名・メールアドレスの変更（管理者・本部のみ。スタッフの登録情報は所属会社が管理する） メールアドレスの変更は乗っ取りの踏み台になるため、現在のパスワードを確かめる | admin.js |
| POST | `/api/auth/change-password` | ログイン中の全員<br>＋本文で確認: 権限の表: admin_users.manage | [accounts.ts:254](../src/accounts.ts#L254) | パスワードの変更（スタッフ・管理者・本部の全員）。ほかの端末のセッションは消し、この端末はログインしたままにする | admin.js staff-profile.js |
| POST | `/api/auth/forgot-password` | ログイン不要 | [api.ts:601](../src/api.ts#L601) | パスワード再設定メールの送信リクエスト セキュリティ: メールアドレスの存在有無に関わらず常に同じレスポンスを返す（アカウント存在の推測を防ぐ） | src/index.tsx |
| POST | `/api/auth/login` | ログイン不要 | [api.ts:453](../src/api.ts#L453) | 〔見出し〕Auth | admin.js src/index.tsx |
| POST | `/api/auth/login/mfa` | ログイン不要 | [api.ts:543](../src/api.ts#L543) | 二段階認証のコード（認証アプリの6桁、または予備コード）を確かめてログインする（#544） | admin.js src/index.tsx |
| POST | `/api/auth/logout` | ログイン不要 | [api.ts:705](../src/api.ts#L705) | 〔見出し〕Auth | admin.js hq.js staff.js |
| POST | `/api/auth/logout-all` | ログイン中の全員<br>＋本文で確認: 権限の表: security.manage | [api.ts:1083](../src/api.ts#L1083) | 〔見出し〕自分のログイン中の端末と、すべての端末からのログアウト（#453。全ロール） | security.js staff-profile.js |
| GET | `/api/auth/me` | ログイン中の全員<br>＋本文で確認: 人事のロール・権限の表: hr.manage | [api.ts:842](../src/api.ts#L842) | 〔見出し〕Auth | admin.js corrections.js hq.js staff.js |
| GET | `/api/auth/mfa` | ログイン中の全員 | [api.ts:1013](../src/api.ts#L1013) | 〔見出し〕自分の二段階認証（本部・管理画面のアカウント） | security.js |
| POST | `/api/auth/mfa/disable` | ログイン中の全員 | [api.ts:1048](../src/api.ts#L1048) | 解除: 現在のパスワードと、認証アプリのコード（または予備コード）を確かめる。必須の設定のときは解除できない | security.js |
| POST | `/api/auth/mfa/enable` | ログイン中の全員 | [api.ts:1030](../src/api.ts#L1030) | 登録の完了: 認証アプリの6桁と現在のパスワードを確かめて有効にし、予備コードを一度だけ返す | security.js |
| POST | `/api/auth/mfa/recovery-codes` | ログイン中の全員 | [api.ts:1065](../src/api.ts#L1065) | 予備コードを作り直す（以前の予備コードは使えなくなる） | security.js |
| POST | `/api/auth/mfa/setup` | ログイン中の全員 | [api.ts:1020](../src/api.ts#L1020) | 登録の開始: 秘密鍵を作り、認証アプリに登録する URI（QR コード）を返す。コードを確かめるまでは有効にしない | security.js |
| POST | `/api/auth/reset-password` | ログイン不要 | [api.ts:653](../src/api.ts#L653) | パスワード再設定の実行（トークンは生の値では保存されておらずハッシュ照合、1回使用したら失効）。同じ人のセッションは、企業を切り替えた分も含めてすべて消す（#9941） | src/index.tsx |
| GET | `/api/auth/sessions` | ログイン中の全員 | [api.ts:1077](../src/api.ts#L1077) | 〔見出し〕自分のログイン中の端末と、すべての端末からのログアウト（#453。全ロール） | security.js staff-profile.js |
| POST | `/api/auth/verify-email` | ログイン不要 | [api.ts:682](../src/api.ts#L682) | ログイン用メールアドレスの確認（#207）。管理者が登録したアドレスに届いたリンク（/verify-email）から、本人が確認したときに有効にする | src/index.tsx |

### `/api/staff/…` スタッフアプリ（83）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| POST | `/api/staff/attendance` | スタッフ | [api.ts:1780](../src/api.ts#L1780) | 勤怠報告（写真なし。写真が必須の入店・退店は、会社が許可していれば理由つきで写真なしで受け付ける #535） | staff.js |
| POST | `/api/staff/attendance-photo` | スタッフ | [api.ts:1791](../src/api.ts#L1791) | 勤怠報告（写真必須：入店報告・退店報告専用） フロント側で圧縮済みのJPEG/PNGをmultipart/form-dataで受け取り、R2へ保存する | staff.js |
| POST | `/api/staff/attendance/no-break` | スタッフ | [api.ts:1640](../src/api.ts#L1640) | 〔見出し〕勤怠報告の『休憩なし』と、押し間違いの取消（#324 #323） | staff.js |
| GET | `/api/staff/attendance/timeline` | スタッフ | [corrections.ts:1135](../src/corrections.ts#L1135) | 日付ごとのタイムライン（既定: 直近 14 日。最大 62 日） | staff-attendance.js |
| POST | `/api/staff/attendance/withdraw` | スタッフ | [api.ts:1678](../src/api.ts#L1678) | 〔見出し〕勤怠報告の『休憩なし』と、押し間違いの取消（#324 #323） | staff.js |
| GET | `/api/staff/availability` | スタッフ | [staff-schedule.ts:76](../src/staff-schedule.ts#L76) | 月の出勤可能日（本人の入力・締切・提出の記録と、参考にその月のシフト）。?month= の既定は翌月 | staff.js |
| PUT | `/api/staff/availability` | スタッフ | [staff-schedule.ts:120](../src/staff-schedule.ts#L120) | 月の出勤可能日をまとめて提出する。days: [{ date, status: ok\|partial\|ng, start_time, end_time, note }]。 その月の今日以降の日は、送った日の分だけに置き換える（送らなかった日は未入力に戻る） | staff.js |
| GET | `/api/staff/availability/summary` | スタッフ | [staff-schedule.ts:107](../src/staff-schedule.ts#L107) | シフト画面の案内用: 翌月の提出状況と締切だけ。target が false（回収の対象外）の人には、画面は未提出の案内を出さない | staff.js |
| GET | `/api/staff/badges` | スタッフ | [api.ts:2290](../src/api.ts#L2290) | 下のタブ・その他のメニューに出す未読の件数（#383）。画面を切り替えるたびに呼ぶので、件数だけを返す軽い API にする。 notices: 今の企業の未読のお知らせ、notices_other: 切り替えていない所属企業の未読、notifications: 未読の通知（同じ人の全所属の分。通知の一覧と同じ範囲） | staff.js |
| DELETE | `/api/staff/calendar-token` | スタッフ | [staff-schedule.ts:189](../src/staff-schedule.ts#L189) | 購読 URL を止める | staff.js |
| GET | `/api/staff/calendar-token` | スタッフ | [staff-schedule.ts:173](../src/staff-schedule.ts#L173) | 購読 URL の状態（URL そのものはハッシュで保存しているため返せない。分からなくなったら発行し直す） | staff.js |
| POST | `/api/staff/calendar-token` | スタッフ | [staff-schedule.ts:179](../src/staff-schedule.ts#L179) | 購読 URL を発行する（すでにあれば発行し直し、前の URL は使えなくなる） | staff.js |
| GET | `/api/staff/consultation-photo/:id{[0-9]+}` | スタッフ | [api.ts:2736](../src/api.ts#L2736) | 相談の写真の取得（本人の相談の写真だけ） | staff.js |
| GET | `/api/staff/consultations` | スタッフ | [api.ts:2524](../src/api.ts#L2524) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| POST | `/api/staff/consultations` | スタッフ | [api.ts:2560](../src/api.ts#L2560) | 送り先の会社: 対象のシフトを選んだらそのシフトの会社、なければ選んだ会社（本人の所属に限る）、なければ今の会社（#222） | staff.js |
| POST | `/api/staff/consultations/:id{[0-9]+}/messages` | スタッフ | [api.ts:2660](../src/api.ts#L2660) | スタッフの追加の連絡。対応済みの相談に送ったら未対応に戻し、管理者に知らせる | staff.js |
| POST | `/api/staff/consultations/:id{[0-9]+}/photos` | スタッフ | [api.ts:2689](../src/api.ts#L2689) | 写真を1枚ずつ付ける（multipart/form-data: photo、追加の連絡に付けるときは message_id） | staff.js |
| POST | `/api/staff/consultations/read-replies` | スタッフ | [api.ts:2550](../src/api.ts#L2550) | 管理者の返信を読んだ（相談・連絡の画面を開いた）。本人の全所属企業の分を既読にする（#320） | staff.js |
| GET | `/api/staff/corrections` | スタッフ | [corrections.ts:1188](../src/corrections.ts#L1188) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| POST | `/api/staff/corrections` | スタッフ | [corrections.ts:1209](../src/corrections.ts#L1209) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| GET | `/api/staff/corrections/:id{[0-9]+}` | スタッフ | [corrections.ts:1204](../src/corrections.ts#L1204) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| POST | `/api/staff/corrections/:id{[0-9]+}/attachments` | スタッフ | [corrections.ts:1263](../src/corrections.ts#L1263) | 申請に写真・画像（店舗の入退館記録・画面の写しなど）を添付する（#485）。multipart/form-data: photo（画面で圧縮した JPEG/PNG）、photo_taken_at、photo_source。 申請者本人が、承認待ちの申請に1枚ずつ送る（1申請に ATTACHMENT_MAX 枚まで）。… | staff-attendance.js |
| POST | `/api/staff/corrections/:id{[0-9]+}/cancel` | スタッフ | [corrections.ts:1243](../src/corrections.ts#L1243) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| POST | `/api/staff/corrections/:id{[0-9]+}/resubmit` | スタッフ | [corrections.ts:1248](../src/corrections.ts#L1248) | 〔見出し〕スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む） | staff-attendance.js |
| GET | `/api/staff/corrections/attachments/:aid{[0-9]+}` | スタッフ | [corrections.ts:1295](../src/corrections.ts#L1295) | 自分の申請に添付した画像 | staff-attendance.js |
| POST | `/api/staff/corrections/bulk` | スタッフ | [corrections.ts:1225](../src/corrections.ts#L1225) | まとめて申請（#214）: { shift_id, reason, items: [{ report_type, requested_at }], dry_run }。申請の種類（時刻修正・打刻漏れの追加）は今の記録から決める | staff-attendance.js |
| POST | `/api/staff/daily-report` | スタッフ | [api.ts:1953](../src/api.ts#L1953) | 日報提出（シフトごとに1件。同じシフトに再提出すると上書きし、管理者の確認済みを外す） | staff.js |
| GET | `/api/staff/daily-report/:shiftId` | スタッフ | [api.ts:1905](../src/api.ts#L1905) | 日報の入力画面: 対象シフトと日報テンプレート、提出済みの内容（修正して再提出するときの初期値）。 前日以前のシフト（未提出の日報の一覧から選んだもの）も同じ形で返す | staff.js |
| POST | `/api/staff/day-before-confirm` | スタッフ | [api.ts:1578](../src/api.ts#L1578) | 〔見出し〕スタッフホーム | staff.js |
| GET | `/api/staff/emergency-contacts` | スタッフ | [api.ts:1855](../src/api.ts#L1855) | スタッフ: 所属・連携している会社の緊急連絡先（#173）。ログイン中の会社を先に、登録のある会社だけを返す（停止中の企業は返さない） | staff.js |
| GET | `/api/staff/handover/:shiftId` | スタッフ | [api.ts:2123](../src/api.ts#L2123) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/home` | スタッフ | [api.ts:1505](../src/api.ts#L1505) | スタッフホーム。?shift_id= で対象のシフトを選べる（本日のシフトと前日からの日をまたぐシフトの中から） | staff.js |
| GET | `/api/staff/manuals` | スタッフ | [api.ts:2491](../src/api.ts#L2491) | 研修・マニュアル（#74）: 本人がシフトに入っている案件（直近30日〜今後。同一人物の全所属。欠勤を除く）の、案件マニュアル・注意事項と求められる内容 | staff.js |
| GET | `/api/staff/me/companies` | スタッフ | [roster.ts:1623](../src/roster.ts#L1623) | 所属企業の一覧（統合ログインの企業切替用）。企業ごとの未読のお知らせの件数も返す（#203。切り替えていない企業の未読に気づけるように）。 連携が終わった会社（所属元の連携の終了・稼働先の取引終了）は出さない（personStaffRows。D-53 #9942） | staff-profile.js |
| GET | `/api/staff/me/profile` | スタッフ | [roster.ts:1563](../src/roster.ts#L1563) | 〔見出し〕スタッフ本人向け（/api/staff/me/*） | staff-profile.js |
| POST | `/api/staff/me/switch-company` | スタッフ | [roster.ts:1630](../src/roster.ts#L1630) | 企業切替: セッションを同一人物の別企業ユーザー行に付け替える（ログインは1つのまま。再ログイン不要）。連携が終わった会社へは切り替えない（404。D-53 #9942） | staff-profile.js |
| GET | `/api/staff/my-reports` | スタッフ | [api.ts:2094](../src/api.ts#L2094) | 自分の日報一覧（過去の日報。#319 #371）。同一人物の全所属の分を新しい順に。項目の表示名は案件のテンプレートから付ける | staff.js |
| GET | `/api/staff/my-reports/:id{[0-9]+}` | スタッフ | [api.ts:2055](../src/api.ts#L2055) | 自分の日報1件（#158。通知から開く・一覧の先頭30件より前の日報も開けるように）。開いたら管理者のコメントを既読にする | staff.js |
| POST | `/api/staff/my-reports/:id{[0-9]+}/comment-read` | スタッフ | [api.ts:2080](../src/api.ts#L2080) | 管理者のコメントを既読にする（#158。一覧でコメントを開いたとき） | staff.js |
| GET | `/api/staff/notices` | スタッフ | [api.ts:2265](../src/api.ts#L2265) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/notices/:id{[0-9]+}` | スタッフ | [api.ts:2309](../src/api.ts#L2309) | お知らせの個別画面（#333）。今の企業に無ければ、同じ人のほかの所属企業のお知らせかを調べ、切り替え先を返す | staff.js |
| GET | `/api/staff/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}` | スタッフ | [api.ts:2364](../src/api.ts#L2364) | お知らせの添付（#555）。配信先の本人だけが取得できる（一覧に出す条件と同じ。掲載期限を過ぎたものも取得できる） | staff.js |
| POST | `/api/staff/notices/:id{[0-9]+}/read` | スタッフ | [api.ts:2326](../src/api.ts#L2326) | 確認しました（既読）。自社のお知らせで、本人が配信対象のものだけ既読にできる（一覧に出す条件と同じ） | staff.js |
| POST | `/api/staff/notices/:id{[0-9]+}/response` | スタッフ | [api.ts:2338](../src/api.ts#L2338) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| POST | `/api/staff/notices/read-all` | スタッフ | [api.ts:2372](../src/api.ts#L2372) | まとめて確認（#553）。画面に出ていた未読（ids）のうち、既読確認が必須・緊急でないものだけを既読にする | staff.js |
| GET | `/api/staff/notification-prefs` | スタッフ | [notifications.ts:1760](../src/notifications.ts#L1760) | 〔見出し〕受け取り設定の API | staff.js |
| PUT | `/api/staff/notification-prefs` | スタッフ<br>＋本文で確認: NOTIFY_ADMIN_ROLES | [notifications.ts:1765](../src/notifications.ts#L1765) | 〔見出し〕受け取り設定の API | staff.js |
| GET | `/api/staff/notifications` | スタッフ | [notifications.ts:420](../src/notifications.ts#L420) | 絞り込み（#380）: unread=1 で未読だけ、kind で種類、before（notification_id）で続きを取る。limit は 1〜100（既定 100） | staff-attendance.js |
| POST | `/api/staff/notifications/:id{[0-9]+}/read` | スタッフ | [notifications.ts:459](../src/notifications.ts#L459) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | staff-attendance.js staff.js |
| POST | `/api/staff/notifications/read-all` | スタッフ | [notifications.ts:439](../src/notifications.ts#L439) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | staff-attendance.js |
| GET | `/api/staff/notifications/unread-count` | スタッフ | [notifications.ts:438](../src/notifications.ts#L438) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications |  |
| GET | `/api/staff/pay` | スタッフ | [staff-pay.ts:101](../src/staff-pay.ts#L101) | 月（month=YYYY-MM。既定は今月）の自分のシフトの実働時間・支払額・申請と、月の集計 | staff-attendance.js |
| POST | `/api/staff/pay/requests` | スタッフ | [staff-pay.ts:185](../src/staff-pay.ts#L185) | 申請: { shift_id, kind: 'transport', amount, route, round_trip, reason } / { shift_id, kind: 'overtime', new_end_time, instructed_by, reason } | staff-attendance.js |
| POST | `/api/staff/pay/requests/:id{[0-9]+}/cancel` | スタッフ | [staff-pay.ts:282](../src/staff-pay.ts#L282) | 本人の取り消し（承認待ちのものだけ） | staff-attendance.js |
| GET | `/api/staff/pay/requests/:id{[0-9]+}/receipt` | スタッフ | [staff-pay.ts:274](../src/staff-pay.ts#L274) | 自分の申請の領収書の写真 | staff-attendance.js |
| POST | `/api/staff/pay/requests/:id{[0-9]+}/receipt` | スタッフ | [staff-pay.ts:240](../src/staff-pay.ts#L240) | 領収書の写真を付ける・差し替える（#273。本人の、承認待ちの交通費の申請だけ）。multipart/form-data: photo（画面で圧縮した JPEG/PNG） | staff-attendance.js |
| GET | `/api/staff/pending-daily-reports` | スタッフ | [api.ts:1928](../src/api.ts#L1928) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/performance` | スタッフ | [api.ts:2389](../src/api.ts#L2389) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/photo-options` | スタッフ | [api.ts:1848](../src/api.ts#L1848) | 写真が送れないときの扱い（#535）。スタッフ: シフトの所有企業が写真なしの報告を許可しているかと、理由の選択肢 | staff.js |
| GET | `/api/staff/push/config` | スタッフ | [notifications.ts:1960](../src/notifications.ts#L1960) | 〔見出し〕プッシュ通知（#178） | staff.js |
| GET | `/api/staff/push/latest` | スタッフ | [notifications.ts:2030](../src/notifications.ts#L2030) | 〔見出し〕プッシュ通知（#178） |  |
| POST | `/api/staff/push/subscribe` | スタッフ | [notifications.ts:1973](../src/notifications.ts#L1973) | 〔見出し〕プッシュ通知（#178） | staff.js |
| POST | `/api/staff/push/test` | スタッフ | [notifications.ts:2010](../src/notifications.ts#L2010) | テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す） | staff.js |
| POST | `/api/staff/push/unsubscribe` | スタッフ | [notifications.ts:2002](../src/notifications.ts#L2002) | 〔見出し〕プッシュ通知（#178） | staff.js |
| GET | `/api/staff/self/documents` | スタッフ | [staff-self-service.ts:259](../src/staff-self-service.ts#L259) | 〔見出し〕#288 書類の提出 | staff-profile.js |
| POST | `/api/staff/self/documents` | スタッフ<br>＋本文で確認: ADMIN_NOTIFY_ROLES | [staff-self-service.ts:267](../src/staff-self-service.ts#L267) | 〔見出し〕#288 書類の提出 | staff-profile.js |
| DELETE | `/api/staff/self/documents/:id` | スタッフ | [staff-self-service.ts:321](../src/staff-self-service.ts#L321) | 本人が削除できるのは、担当者がまだ確認していない書類だけ（D1 を先に消し、R2 は後で消す） | staff-profile.js |
| GET | `/api/staff/self/documents/:id/download` | スタッフ | [staff-self-service.ts:305](../src/staff-self-service.ts#L305) | 本人が出した書類だけを開ける（管理者が登録した書類・ほかの人の書類は開けない） | staff-profile.js |
| GET | `/api/staff/self/leave` | スタッフ | [staff-self-service.ts:353](../src/staff-self-service.ts#L353) | 〔見出し〕#289 有給の残日数と休暇の申請 | staff-profile.js |
| POST | `/api/staff/self/leave` | スタッフ<br>＋本文で確認: 人事のロール | [staff-self-service.ts:364](../src/staff-self-service.ts#L364) | 〔見出し〕#289 有給の残日数と休暇の申請 | staff-profile.js |
| POST | `/api/staff/self/leave/:id/cancel` | スタッフ | [staff-self-service.ts:396](../src/staff-self-service.ts#L396) | 〔見出し〕#289 有給の残日数と休暇の申請 | staff-profile.js |
| GET | `/api/staff/self/profile-requests` | スタッフ | [staff-self-service.ts:194](../src/staff-self-service.ts#L194) | 〔見出し〕スタッフ本人の API（/api/staff/self/*） | staff-profile.js |
| POST | `/api/staff/self/profile-requests` | スタッフ<br>＋本文で確認: ADMIN_NOTIFY_ROLES | [staff-self-service.ts:208](../src/staff-self-service.ts#L208) | 〔見出し〕スタッフ本人の API（/api/staff/self/*） | staff-profile.js |
| POST | `/api/staff/self/profile-requests/:id/cancel` | スタッフ | [staff-self-service.ts:242](../src/staff-self-service.ts#L242) | 〔見出し〕スタッフ本人の API（/api/staff/self/*） | staff-profile.js |
| GET | `/api/staff/self/summary` | スタッフ | [staff-self-service.ts:189](../src/staff-self-service.ts#L189) | 『その他』のメニューの出し分け（有給・休暇は自社雇用の社員だけ） | staff-profile.js |
| POST | `/api/staff/shift-requests/:id/cancel` | スタッフ | [api.ts:2238](../src/api.ts#L2238) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） |  |
| GET | `/api/staff/shifts` | スタッフ | [api.ts:2197](../src/api.ts#L2197) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/shifts/:id/coworkers` | スタッフ | [api.ts:2170](../src/api.ts#L2170) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | staff.js |
| GET | `/api/staff/shifts/:id/ics` | スタッフ | [staff-schedule.ts:196](../src/staff-schedule.ts#L196) | シフト1件の .ics（本人＝同じ人のほかの会社の分も含む。確定・代打だけ） | staff.js |
| POST | `/api/staff/shifts/:id/reply` | スタッフ | [api.ts:2241](../src/api.ts#L2241) | 管理者が『希望（仮）』で入れたシフトへの返事（#411）。answer: ok（入れます）/ ng（入れません） | staff.js |
| POST | `/api/staff/shifts/request` | スタッフ | [api.ts:2237](../src/api.ts#L2237) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） |  |
| GET | `/api/staff/tours` | スタッフ | [tours.ts:101](../src/tours.ts#L101) |  | tour.js |
| PUT | `/api/staff/tours` | スタッフ | [tours.ts:111](../src/tours.ts#L111) |  | tour.js |

### `/api/admin/…` 管理画面（392）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/admin/analytics` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6382](../src/api.ts#L6382) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/analytics/csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6513](../src/api.ts#L6513) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/analytics/series` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6422](../src/api.ts#L6422) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/assignees` | 管理者（4ロール）＋本部の閲覧（GET） | [assignees.ts:110](../src/assignees.ts#L110) | アカウントごとの「担当している会社」（主・副の区別つき）。?user_id= で1人に絞る。 統合済み・消した協力会社とクライアントの行は出さない | admin.js |
| GET | `/api/admin/assignees/options` | 管理者（4ロール）＋本部の閲覧（GET） | [assignees.ts:102](../src/assignees.ts#L102) | 担当に選べるアカウント（自社の利用中の管理者）。同姓の人を見分けられるよう ID と権限も返す | admin.js |
| GET | `/api/admin/attendance-photo/:attendanceId` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1830](../src/api.ts#L1830) | 管理者: 勤怠報告の写真の取得。報告のシフトが自社のものかを確かめてから返す（写真のキーは画面に出さない #217） | admin.js corrections.js |
| GET | `/api/admin/attendance-punches` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:1074](../src/corrections.ts#L1074) | 〔見出し〕打刻データの一覧と CSV（#175）: 勤務日の期間（31日まで）・案件・クライアント・スタッフ・記録方法で絞り、1シフト1行で8種類の報告の日時と記録方法を出す。 | corrections.js |
| GET | `/api/admin/attendance-punches/export` | 管理者（4ロール）＋本部の閲覧（GET） | [corrections.ts:1093](../src/corrections.ts#L1093) | 〔見出し〕打刻データの一覧と CSV（#175）: 勤務日の期間（31日まで）・案件・クライアント・スタッフ・記録方法で絞り、1シフト1行で8種類の報告の日時と記録方法を出す。 | corrections.js |
| GET | `/api/admin/availability` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-schedule.ts:340](../src/staff-schedule.ts#L340) | 月の提出状況と、日付×スタッフの一覧。marks は日ごとの1文字（o=○ p=△ x=× -=未入力）、shift_days はシフトの入っている日（DD）。 exempt は回収の対象外（#9907）。対象外の人は一覧の後ろに出す | admin.js |
| PUT | `/api/admin/availability/period` | 管理者（4ロール） | [staff-schedule.ts:383](../src/staff-schedule.ts#L383) | 締切と案内文（month は今月の前後。deadline は空欄で締切なし） | admin.js |
| POST | `/api/admin/availability/remind` | 管理者（4ロール） | [staff-schedule.ts:401](../src/staff-schedule.ts#L401) | 未提出の人（ログインできるスタッフ。回収の対象外の人を除く）へアプリ内通知で提出を頼む | admin.js |
| PUT | `/api/admin/availability/targets` | 管理者（4ロール） | [staff-schedule.ts:437](../src/staff-schedule.ts#L437) | 〔見出し〕管理者（/api/admin/*） | admin.js staff-lifecycle.js |
| GET | `/api/admin/badges` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: CHAT_ROLES | [admin-badges.ts:23](../src/admin-badges.ts#L23) | 〔見出し〕管理画面のバッジ（左のメニュー・スマホのメニューの件数）をまとめて返す（#9935） | admin.js |
| GET | `/api/admin/billing-check` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7518](../src/api.ts#L7518) | 請求前確認 | admin.js |
| GET | `/api/admin/board/posts` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:126](../src/board.ts#L126) | scope: open（全企業の掲載中）/ mine（自社の掲載すべて） | board.js |
| POST | `/api/admin/board/posts` | 管理者（4ロール） | [board.ts:215](../src/board.ts#L215) | 〔見出し〕作成・更新 | board.js |
| DELETE | `/api/admin/board/posts/:id` | 管理者（4ロール） | [board.ts:317](../src/board.ts#L317) | 削除は下書きのみ（掲載したものは履歴として残し、締切・充足で閉じる） | board.js |
| GET | `/api/admin/board/posts/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:172](../src/board.ts#L172) | 〔見出し〕詳細 | board.js |
| PUT | `/api/admin/board/posts/:id` | 管理者（4ロール） | [board.ts:236](../src/board.ts#L236) | 〔見出し〕作成・更新 | board.js |
| POST | `/api/admin/board/posts/:id/status` | 管理者（4ロール） | [board.ts:297](../src/board.ts#L297) | 状態だけの変更（掲載する / 締め切る / 充足 / 下書きに戻す） | board.js |
| POST | `/api/admin/board/posts/:id/threads` | 管理者（4ロール） | [board.ts:393](../src/board.ts#L393) | 問い合わせを開始する（既にあれば既存スレッドを返す）。自社の掲載・掲載中でない掲載には問い合わせできない | board.js |
| GET | `/api/admin/board/project-template/:projectId` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:199](../src/board.ts#L199) | 〔見出し〕自社案件からのコピー用 | board.js |
| GET | `/api/admin/board/proposals` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:811](../src/board.ts#L811) | 自社が関わる提案の一覧（提案した / 受けた） | board.js |
| POST | `/api/admin/board/proposals/:id/import` | 管理者（4ロール） | [board.ts:862](../src/board.ts#L862) | 取り込んだ行は partner_manual（取引先所属）、所属会社名 = 提案企業名（取引先マスタにも登録）。 基本項目・業務側項目は採用時点の開示内容（氏名 + スナップショット）をコピーし、以後は自社で編集（提案元とは同期しない）。 経路は board_proposals.upstream_chain にだけ残… | board.js |
| POST | `/api/admin/board/proposals/:id/status` | 管理者（4ロール） | [board.ts:763](../src/board.ts#L763) | 状態変更: 受け手 = 面談希望 / 採用 / 見送り、提案者 = 取り下げ（採用前のみ） | board.js |
| GET | `/api/admin/board/saved-searches` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:994](../src/board.ts#L994) | 〔見出し〕保存した検索条件と、条件に合う新しい掲載の知らせ（#479） | board.js |
| POST | `/api/admin/board/saved-searches` | 管理者（4ロール） | [board.ts:999](../src/board.ts#L999) | 〔見出し〕保存した検索条件と、条件に合う新しい掲載の知らせ（#479） | board.js |
| DELETE | `/api/admin/board/saved-searches/:id` | 管理者（4ロール）<br>＋本文で確認: SAVED_SEARCH_NOTIFY_ROLES | [board.ts:1031](../src/board.ts#L1031) | 〔見出し〕保存した検索条件と、条件に合う新しい掲載の知らせ（#479） | board.js |
| PUT | `/api/admin/board/saved-searches/:id` | 管理者（4ロール） | [board.ts:1016](../src/board.ts#L1016) | 名前・知らせ方の変更（条件そのものは変えない。変えるときは保存し直す） | board.js |
| GET | `/api/admin/board/threads` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:423](../src/board.ts#L423) | スレッド一覧（自社が参加する全スレッド）。post_id を指定するとその掲載のスレッドのみ | board.js |
| GET | `/api/admin/board/threads/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:458](../src/board.ts#L458) | メッセージ取得（全履歴）。取得しただけでは既読にしない（既読は POST /threads/:id/read。#250） | board.js |
| POST | `/api/admin/board/threads/:id/messages` | 管理者（4ロール） | [board.ts:493](../src/board.ts#L493) | 投稿 | board.js |
| GET | `/api/admin/board/threads/:id/proposal-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:622](../src/board.ts#L622) | 提案できる自社スタッフの候補（統合済みは除外。区分ごとの注意文付き） | board.js |
| GET | `/api/admin/board/threads/:id/proposal-preview` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:652](../src/board.ts#L652) | 送信前のプレビュー（相手に見える内容そのもの） | board.js |
| GET | `/api/admin/board/threads/:id/proposals` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:752](../src/board.ts#L752) | 提案一覧（スレッド内） | board.js |
| POST | `/api/admin/board/threads/:id/proposals` | 管理者（4ロール） | [board.ts:692](../src/board.ts#L692) | 提案の送信 | board.js |
| POST | `/api/admin/board/threads/:id/read` | 管理者（4ロール） | [board.ts:473](../src/board.ts#L473) | 既読にする（ユーザー単位）。画面が表示されていて、やり取りの一番下まで見えているときに画面から呼ぶ（#250） message_id: 画面に表示した最後のメッセージ。省略したら最新まで | board.js |
| POST | `/api/admin/board/threads/:id/status` | 管理者（4ロール） | [board.ts:508](../src/board.ts#L508) | やり取りの終了 / 再開（どちらの企業からでも可。履歴は残る） | board.js |
| GET | `/api/admin/board/unread-count` | 管理者（4ロール）＋本部の閲覧（GET） | [board.ts:455](../src/board.ts#L455) | 〔見出し〕第2段階: 案件チャット（掲載1件 × 問い合わせ企業1社の1対1スレッド） | board.js |
| GET | `/api/admin/clients` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4279](../src/api.ts#L4279) | クライアント | admin.js corrections.js shift-board.js tour.js |
| POST | `/api/admin/clients` | 管理者（4ロール） | [api.ts:4298](../src/api.ts#L4298) | 〔見出し〕スタッフ履歴書ファイル管理 | admin.js tour.js |
| GET | `/api/admin/clients/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4338](../src/api.ts#L4338) | 〔見出し〕スタッフ履歴書ファイル管理 | admin.js |
| PUT | `/api/admin/clients/:id` | 管理者（4ロール） | [api.ts:4433](../src/api.ts#L4433) | 〔見出し〕スタッフ履歴書ファイル管理 | admin.js |
| DELETE | `/api/admin/clients/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:5228](../src/api.ts#L5228) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| POST | `/api/admin/clients/:id/contacts` | 管理者（4ロール） | [api.ts:4549](../src/api.ts#L4549) | 〔見出し〕顧客担当者（1会社に複数登録可、支店・部署は自由入力） | admin.js |
| GET | `/api/admin/clients/:id/documents` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4829](../src/api.ts#L4829) | ファイル一覧 | admin.js |
| POST | `/api/admin/clients/:id/documents` | 管理者（4ロール） | [api.ts:4840](../src/api.ts#L4840) | アップロード（複数ファイル対応。履歴書機能と同一の検証ロジックを再利用） | admin.js |
| GET | `/api/admin/clients/:id/ng-staff` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4495](../src/api.ts#L4495) | 〔見出し〕クライアントのNGスタッフ（#204） | admin.js |
| PUT | `/api/admin/clients/:id/ng-staff` | 管理者（4ロール） | [api.ts:4502](../src/api.ts#L4502) | NGスタッフの一覧を置き換える。body: { staff: [{ staff_id, reason }] }（staff_ids: [id] でも可）。自社の（統合済みでない）スタッフだけを受け付ける | admin.js |
| DELETE | `/api/admin/clients/contacts/:contactId` | 管理者（4ロール） | [api.ts:4581](../src/api.ts#L4581) | 〔見出し〕顧客担当者（1会社に複数登録可、支店・部署は自由入力） | admin.js |
| PUT | `/api/admin/clients/contacts/:contactId` | 管理者（4ロール） | [api.ts:4564](../src/api.ts#L4564) | 〔見出し〕顧客担当者（1会社に複数登録可、支店・部署は自由入力） | admin.js |
| DELETE | `/api/admin/clients/documents/:docId` | 管理者（4ロール） | [api.ts:4855](../src/api.ts#L4855) | 削除（D1を先に消し、R2はベストエフォート。履歴書機能と同じ順序方針） | admin.js |
| GET | `/api/admin/clients/documents/:docId/download` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4851](../src/api.ts#L4851) | ダウンロード | admin.js |
| GET | `/api/admin/consultation-photo/:id{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1839](../src/api.ts#L1839) | 管理者: 相談の写真の取得。自社あての相談の写真だけ（#429） | admin.js |
| GET | `/api/admin/consultations` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7362](../src/api.ts#L7362) | 〔見出し〕お知らせ既読率レポート | admin.js |
| PUT | `/api/admin/consultations/:id` | 管理者（4ロール） | [api.ts:7391](../src/api.ts#L7391) | 返信・状態の変更。返信したら、スタッフ本人にアプリ内通知（consult_reply）で知らせ、ホームのバナーに出す（#320） | admin.js |
| GET | `/api/admin/contract-usage` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:8240](../src/api.ts#L8240) | 契約ユーザー数（本部が決めた上限）と今の利用数。企業の管理画面（アカウント設定）に表示する（#321 #9928。登録は止めず、表示のみ） 数え方は本部の企業一覧・企業詳細と同じ（HQ_BILLABLE_SQL）。near_limit: 上限の9割以上で、まだ超えていない | admin.js |
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
| GET | `/api/admin/daily-reports` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5589](../src/api.ts#L5589) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/daily-reports-csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:8422](../src/api.ts#L8422) | 〔見出し〕日報の書き出しと保存期間の案内（導入企業向け。#417） | admin.js |
| GET | `/api/admin/daily-reports-retention` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:8480](../src/api.ts#L8480) | 日報の保存期間と、今後30日のうちに3年を過ぎて削除される件数（日報一覧の案内に出す） | admin.js |
| PUT | `/api/admin/daily-reports/:id` | 管理者（4ロール） | [api.ts:5805](../src/api.ts#L5805) | 日報の確認（#360）と、以前の形のコメント（古い画面・外部から。#9965 の後も受け付ける） - manager_comment: 最新のコメントが自分のものならそれを直し（空欄は削除）、そうでなければコメントを追加する。 ほかの人のコメントを空欄で消そうとしたら 403。expected_comment（開いた… | admin.js |
| POST | `/api/admin/daily-reports/:id{[0-9]+}/comments` | 管理者（4ロール） | [api.ts:5763](../src/api.ts#L5763) | コメントを追加する。body: { body } | admin.js |
| DELETE | `/api/admin/daily-reports/:id{[0-9]+}/comments/:cid{[0-9]+}` | 管理者（4ロール） | [api.ts:5792](../src/api.ts#L5792) | 自分のコメントを消す | admin.js |
| PUT | `/api/admin/daily-reports/:id{[0-9]+}/comments/:cid{[0-9]+}` | 管理者（4ロール） | [api.ts:5778](../src/api.ts#L5778) | 自分のコメントを直す。body: { body }（空欄は受け付けない。消すときは DELETE） |  |
| GET | `/api/admin/daily-reports/:id{[0-9]+}/edits` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5881](../src/api.ts#L5881) | 修正の画面の内容と、修正の履歴（新しい順） | admin.js |
| PUT | `/api/admin/daily-reports/:id{[0-9]+}/values` | 管理者（4ロール） | [api.ts:5909](../src/api.ts#L5909) | 値を直す。values は項目のキー → 値（送らなかった項目は今の値のまま）、reason は理由（任意）。 expected_submitted_at・expected_admin_edited_at（画面を開いたときの値）を送ると、その後にスタッフが出し直した・ほかの管理者が直したときは 409 を返して書かない | admin.js |
| PUT | `/api/admin/daily-reports/:id/incident` | 管理者（4ロール） | [api.ts:5949](../src/api.ts#L5949) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js |
| POST | `/api/admin/daily-reports/check` | 管理者（4ロール） | [api.ts:5702](../src/api.ts#L5702) | 表示中の日報をまとめて確認済みにする（#183）。ids は最大 DAILY_REPORT_PAGE_MAX 件。すでに確認済みのものは変えない | admin.js |
| GET | `/api/admin/daily-reports/missing` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5532](../src/api.ts#L5532) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/dashboard` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: hr.manage | [api.ts:2807](../src/api.ts#L2807) | 管理者ダッシュボード 問い合わせは1回の db.batch（と、並べて行う人員不足・月額の読み込み）にまとめる（#9904。1つずつ待つと D1 の往復の数だけ遅くなる）。 案件の絞り込み（#9905）: project_id（その案件）か client_id（そのクライアントの案件）。どちらもなければ全案件。 絞り… | admin.js |
| DELETE | `/api/admin/dashboard/todos` | 管理者（4ロール） | [api.ts:3377](../src/api.ts#L3377) | 元に戻す（もう一度 ToDo に出す） | admin.js |
| POST | `/api/admin/dashboard/todos` | 管理者（4ロール） | [api.ts:3355](../src/api.ts#L3355) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/email-logs` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:915](../src/notifications.ts#L915) | 〔見出し〕メールの送信記録（email_logs。#438）と、送信を止めているアドレス（email_suppressions。#541） | notifications.js |
| GET | `/api/admin/email-suppressions` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: mail_suppression.release | [notifications.ts:931](../src/notifications.ts#L931) | 自社のユーザーのアドレスのうち、送信を止めているもの（不達・迷惑メールの報告） | notifications.js |
| POST | `/api/admin/email-suppressions/release` | 管理者（4ロール）<br>＋本文で確認: 権限の表: mail_suppression.release | [notifications.ts:939](../src/notifications.ts#L939) | 送信の停止を解除する（受信できるようになったと本人に確かめた後）。自社のユーザーのアドレスだけ。会社管理者のみ | notifications.js |
| GET | `/api/admin/employees` | 会社管理者・事務 | [api.ts:4610](../src/api.ts#L4610) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| GET | `/api/admin/employees/:staffId` | 会社管理者・事務 | [api.ts:4666](../src/api.ts#L4666) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| PUT | `/api/admin/employees/:staffId` | 会社管理者・事務 | [api.ts:4688](../src/api.ts#L4688) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| GET | `/api/admin/employees/:staffId/documents` | 会社管理者・事務 | [api.ts:4795](../src/api.ts#L4795) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| POST | `/api/admin/employees/:staffId/documents` | 会社管理者・事務 | [api.ts:4806](../src/api.ts#L4806) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| GET | `/api/admin/employees/:staffId/history` | 会社管理者・事務 | [api.ts:4780](../src/api.ts#L4780) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| DELETE | `/api/admin/employees/documents/:docId` | 会社管理者・事務 | [api.ts:4818](../src/api.ts#L4818) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| GET | `/api/admin/employees/documents/:docId/download` | 会社管理者・事務 | [api.ts:4815](../src/api.ts#L4815) | 〔見出し〕入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） | admin.js |
| GET | `/api/admin/employees/export` | 会社管理者・事務<br>＋本文で確認: 権限の表: roster_export.pay | [api.ts:4634](../src/api.ts#L4634) | 〔見出し〕従業員管理（社員名簿）: 自社雇用者のみ | admin.js |
| GET | `/api/admin/follow-logs` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7437](../src/api.ts#L7437) | 〔見出し〕お知らせ既読率レポート | admin.js |
| POST | `/api/admin/follow-logs` | 管理者（4ロール） | [api.ts:7481](../src/api.ts#L7481) | 〔見出し〕お知らせ既読率レポート | admin.js |
| PUT | `/api/admin/follow-logs/:id` | 管理者（4ロール） | [api.ts:7500](../src/api.ts#L7500) | 〔見出し〕お知らせ既読率レポート | admin.js |
| GET | `/api/admin/hq-access` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: hq_view.allow | [hq-support.ts:323](../src/hq-support.ts#L323) | 本部の閲覧の許可と、これまでの閲覧の記録（いつ・誰が・何のために） | hq-support.js |
| PUT | `/api/admin/hq-access` | 管理者（4ロール）<br>＋本文で確認: 権限の表: hq_view.allow | [hq-support.ts:333](../src/hq-support.ts#L333) | 閲覧の許可の切り替え（会社管理者のみ）。取り消したときは、閲覧中のものもその場で終える | hq-support.js |
| POST | `/api/admin/hq-announcements/:id/read` | 管理者（4ロール） | [hq-support.ts:271](../src/hq-support.ts#L271) | 〔見出し〕管理画面の API（/api/admin に登録する） | hq-support.js |
| GET | `/api/admin/hq-support/status` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: hq_view.allow | [hq-support.ts:257](../src/hq-support.ts#L257) | 管理画面の上部に出すもの: 未確認の本部のお知らせ、本部が閲覧中かどうか、閲覧の許可の状態 | hq-support.js |
| GET | `/api/admin/login-history` | 会社管理者 | [api.ts:1143](../src/api.ts#L1143) | 自社のログインの履歴（自社の会社コードで試みられた失敗を含む）と、失敗が続いている ID | security.js |
| GET | `/api/admin/notice-reports/:fiscalYear` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7268](../src/api.ts#L7268) | 年度別（会社サマリ + スタッフ別）。長期保存されたレポートテーブルから取得する。 再集計できるかどうか（確定済み・保存期間外ならできない #48 #49）と、年度の途中かどうか（#481）も返す | admin.js |
| GET | `/api/admin/notice-reports/:fiscalYear/csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7339](../src/api.ts#L7339) | CSV出力（スタッフ別レポート。人事評価の参考資料用）。共通の toCsv でエスケープする（#72）。 並びは画面の初期表示と同じ既読率の低い順（order=name で氏名順）。スタッフID・社員番号の列も出す（#518） | admin.js |
| POST | `/api/admin/notice-reports/:fiscalYear/recalculate` | 管理者（4ロール） | [api.ts:7295](../src/api.ts#L7295) | 再集計（管理者が年度を指定して即時更新）。確定済み・保存期間外の年度は 409 で断る（長期保存した値を上書きしない #48） | admin.js |
| GET | `/api/admin/notice-reports/:fiscalYear/staff/:staffId` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7310](../src/api.ts#L7310) | スタッフ別・お知らせ単位の詳細。対象の判定は年度のレポートと同じ（公開した時点の対象者 #49 #481）。 既読の記録を削除したお知らせは is_read = null（記録なし）で返す | admin.js |
| GET | `/api/admin/notices` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6546](../src/api.ts#L6546) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| POST | `/api/admin/notices` | 管理者（4ロール） | [api.ts:6720](../src/api.ts#L6720) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| DELETE | `/api/admin/notices/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:7153](../src/api.ts#L7153) | 下書き・予約（配信前）の削除。配信したものは取り消す（記録を残すため削除しない） | admin.js |
| PUT | `/api/admin/notices/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:7048](../src/api.ts#L7048) | 修正（#157）。配信した後も、タイトル・本文・配信先・重要度・確認必須・掲載期限・回答の設定を直せる。 配信済みのものは修正の前の内容を notice_revisions に残し、タイトル・本文を変えたらスタッフの画面に「更新」の印を出す（updated_at）。 notify: 今の配信対象の人に、修正したことを… | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/attachments` | 管理者（4ロール） | [api.ts:7220](../src/api.ts#L7220) | 添付の追加（複数可。1ファイルずつ検証し、成功した分だけ保存する）。配信済みのものに足したら「更新」の印を付ける | admin.js |
| DELETE | `/api/admin/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}` | 管理者（4ロール） | [api.ts:7246](../src/api.ts#L7246) | 添付の削除（D1 を先に消し、R2 は後で消す） | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7238](../src/api.ts#L7238) | 〔見出し〕添付（#555）: 画像・PDF を R2（DOCUMENTS）に置き、配信先の本人と自社の管理者だけが取得できる | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/email-deliveries` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6802](../src/api.ts#L6802) | お知らせメールの送信結果（1人ずつ）。メールアドレスは返さない（連携スタッフの所属元のアドレスを見せないため） | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/publish` | 管理者（4ロール） | [api.ts:7103](../src/api.ts#L7103) | 下書き・予約を配信する（#291）。scheduled_at があれば予約にし、無ければすぐに配信する | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/remind` | 管理者（4ロール） | [api.ts:6765](../src/api.ts#L6765) | 〔見出し〕日報の数値項目の合計を、json_each を全件に使わずに出す（#9937） | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/responses.csv` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6855](../src/api.ts#L6855) | 回答の CSV（#554。出欠の集計などに使う）。今の配信対象の人を全員出し、まだ答えていない人は回答の列を空にする | admin.js |
| GET | `/api/admin/notices/:id{[0-9]+}/revisions` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7173](../src/api.ts#L7173) | 修正・取消の履歴（#157） | admin.js |
| POST | `/api/admin/notices/:id{[0-9]+}/withdraw` | 管理者（4ロール） | [api.ts:7129](../src/api.ts#L7129) | 取消（#157。論理削除）。スタッフの一覧・ホーム・未読の数から外し、個別画面には「取り消されました」と出す。 内容・既読・回答の記録は残す（管理画面では「取消」として見える）。notify なら、今の配信対象の人にアプリ内通知で知らせる | admin.js |
| GET | `/api/admin/notices/:id/reads` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6814](../src/api.ts#L6814) | お知らせ既読状況。既読・未読とも、今の配信対象の人だけを出す（#7）。 既読の時刻は UTC で保存している（列の既定値）ので、日本時間にして返す（#104） | admin.js |
| GET | `/api/admin/notices/recipients` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6602](../src/api.ts#L6602) | 個人あての配信先の候補（#157）。いま在籍中で、ログインのあるスタッフ（お知らせが届く人。NOTICE_MEMBER_NOW_SQL と同じ条件） | admin.js |
| GET | `/api/admin/notification-emails` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:486](../src/notifications.ts#L486) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| POST | `/api/admin/notification-emails/:id{[0-9]+}/resend` | 管理者（4ロール） | [notifications.ts:552](../src/notifications.ts#L552) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| GET | `/api/admin/notification-emails/export` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:514](../src/notifications.ts#L514) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| POST | `/api/admin/notification-emails/resend-failed` | 管理者（4ロール）<br>＋本文で確認: NOTIFY_ADMIN_ROLES | [notifications.ts:583](../src/notifications.ts#L583) | 〔見出し〕メール送信失敗の一覧・再送（管理者） | notifications.js |
| GET | `/api/admin/notification-prefs` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:1741](../src/notifications.ts#L1741) | 〔見出し〕受け取り設定の API | notifications.js |
| PUT | `/api/admin/notification-prefs` | 管理者（4ロール）<br>＋本文で確認: 権限の表: notification_prefs.edit | [notifications.ts:1746](../src/notifications.ts#L1746) | 〔見出し〕受け取り設定の API | notifications.js |
| GET | `/api/admin/notifications` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:420](../src/notifications.ts#L420) | 絞り込み（#380）: unread=1 で未読だけ、kind で種類、before（notification_id）で続きを取る。limit は 1〜100（既定 100） | notifications.js |
| POST | `/api/admin/notifications/:id{[0-9]+}/read` | 管理者（4ロール） | [notifications.ts:459](../src/notifications.ts#L459) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | notifications.js |
| POST | `/api/admin/notifications/read-all` | 管理者（4ロール） | [notifications.ts:439](../src/notifications.ts#L439) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | notifications.js |
| POST | `/api/admin/notifications/read-related` | 管理者（4ロール） | [notifications.ts:448](../src/notifications.ts#L448) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications | recruit.js |
| GET | `/api/admin/notifications/unread-count` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:438](../src/notifications.ts#L438) | 〔見出し〕アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications |  |
| GET | `/api/admin/operation-logs` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5471](../src/api.ts#L5471) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| GET | `/api/admin/pay-requests` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-pay.ts:300](../src/staff-pay.ts#L300) | 一覧（status=pending: 承認待ち（既定）/ all: 直近の申請）。承認できない理由（shift_issue）も付ける | settlement.js |
| POST | `/api/admin/pay-requests/:id{[0-9]+}/approve` | 管理者（4ロール） | [staff-pay.ts:351](../src/staff-pay.ts#L351) | 承認: 交通費は { amount?（直した金額）, note? }、延長は { end_time?（直した終了時刻）, note? } | settlement.js |
| GET | `/api/admin/pay-requests/:id{[0-9]+}/receipt` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-pay.ts:327](../src/staff-pay.ts#L327) | 申請の領収書の写真（自社の申請のみ。#273） | settlement.js |
| POST | `/api/admin/pay-requests/:id{[0-9]+}/reject` | 管理者（4ロール） | [staff-pay.ts:410](../src/staff-pay.ts#L410) | 却下: { note（理由。必須） } | settlement.js |
| GET | `/api/admin/project-goals` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:6036](../src/api.ts#L6036) | 案件の月間目標（#292）。稼働中の案件と、日報テンプレートの数値項目・設定済みの目標 | admin.js |
| GET | `/api/admin/projects` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4863](../src/api.ts#L4863) | 案件一覧 ?month=YYYY-MM で集計する月を選べる（#450。無ければ今月）。月は範囲の条件で絞る（#212）。monthly_amount: その月の案件全体の月額（#9702） | admin.js attendance-history.js board.js corrections.js recruit.js shift-board.js tour.js |
| POST | `/api/admin/projects` | 管理者（4ロール） | [api.ts:4960](../src/api.ts#L4960) | 案件登録 | admin.js tour.js |
| GET | `/api/admin/projects/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4883](../src/api.ts#L4883) | 案件詳細 | admin.js |
| PUT | `/api/admin/projects/:id` | 管理者（4ロール） | [api.ts:5080](../src/api.ts#L5080) | 案件の編集・終了（#153）。送られた項目だけを変える。単価・区分は単価パネル（PUT /admin/projects/:id/pricing）で変える。 - status: active（稼働中）/ closed（終了）。終了した案件には新しいシフトを入れられない（lib/staff-eligibility.ts … | admin.js |
| DELETE | `/api/admin/projects/:id{[0-9]+}` | 管理者（4ロール） | [api.ts:5226](../src/api.ts#L5226) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| PUT | `/api/admin/projects/:id/goals` | 管理者（4ロール） | [api.ts:6049](../src/api.ts#L6049) | goals: { 項目のキー: 件数 }。空欄・0 の項目は目標なしにする。テンプレートの数値項目に無いキーは受け付けない | admin.js |
| PUT | `/api/admin/projects/:id/lateness` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3444](../src/api.ts#L3444) | 案件ごとの遅刻の猶予の上書き（#497）。grace_minutes: 0〜MAX_LATE_GRACE_MINUTES の整数、null なら会社の値に従う。これから記録する報告に効く | admin.js |
| PUT | `/api/admin/projects/:id/photo-required` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:5045](../src/api.ts#L5045) | 案件ごとの入店/退店報告 写真添付オーバーライド更新 | admin.js |
| GET | `/api/admin/projects/:id/price-history` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:3001](../src/shift-board.ts#L3001) | 案件の標準単価の改定履歴（#210） | shift-board.js |
| PUT | `/api/admin/projects/:id/pricing` | 管理者（4ロール） | [shift-board.ts:3038](../src/shift-board.ts#L3038) | 区分・標準単価・交通費ルール・時間の数え方。 price_valid_from（適用開始日）を付けて単価を変えると、その前日までの稼働日には今の単価を使い続ける（改定前の単価を project_price_history に残す。#210）。 付けずに変えると、今の単価の適用期間（price_valid_from 以… | shift-board.js |
| PUT | `/api/admin/projects/:id/report-settings` | 管理者（4ロール） | [staff-lifecycle.ts:824](../src/staff-lifecycle.ts#L824) | 〔見出し〕提出設定 | staff-lifecycle.js |
| PUT | `/api/admin/projects/:id/required-skills` | 管理者（4ロール） | [api.ts:5033](../src/api.ts#L5033) | 案件の必要スキル（#556。シフトボードの候補一覧の『スキル n/m』に使う）。カンマ・読点で区切り、空欄なら消す | admin.js |
| GET | `/api/admin/proxy-attendance/bulk` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:1186](../src/staff-lifecycle.ts#L1186) | 日付（と案件）を選ぶと、勤務のシフトと報告の状況を返す。ログインのない人を先頭に並べる | staff-lifecycle.js |
| POST | `/api/admin/proxy-attendance/bulk` | 管理者（4ロール） | [staff-lifecycle.ts:1219](../src/staff-lifecycle.ts#L1219) | チェックしたシフトに「予定どおり」で記録する。scope: start = 入店・勤務開始だけ / all = 予定どおり全部（休憩・勤務終了・退店も）。 人ごとに start・end（'HH:MM'）で開始・終了の時刻を直せる。1件の代理入力と同じ確認（確定済み・欠勤・稼働日より前・報告済み・順序）をして、 記録で… | staff-lifecycle.js |
| GET | `/api/admin/push/config` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:1960](../src/notifications.ts#L1960) | 〔見出し〕プッシュ通知（#178） | notifications.js |
| GET | `/api/admin/push/latest` | 管理者（4ロール）＋本部の閲覧（GET） | [notifications.ts:2059](../src/notifications.ts#L2059) | 〔見出し〕プッシュ通知（#178） |  |
| POST | `/api/admin/push/subscribe` | 管理者（4ロール） | [notifications.ts:1973](../src/notifications.ts#L1973) | 〔見出し〕プッシュ通知（#178） | notifications.js |
| POST | `/api/admin/push/test` | 管理者（4ロール） | [notifications.ts:2010](../src/notifications.ts#L2010) | テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す） | notifications.js |
| POST | `/api/admin/push/unsubscribe` | 管理者（4ロール） | [notifications.ts:2002](../src/notifications.ts#L2002) | 〔見出し〕プッシュ通知（#178） | notifications.js |
| GET | `/api/admin/rate-rules` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2860](../src/shift-board.ts#L2860) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| POST | `/api/admin/rate-rules` | 管理者（4ロール） | [shift-board.ts:2927](../src/shift-board.ts#L2927) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| DELETE | `/api/admin/rate-rules/:id` | 管理者（4ロール） | [shift-board.ts:2956](../src/shift-board.ts#L2956) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| PUT | `/api/admin/rate-rules/:id` | 管理者（4ロール） | [shift-board.ts:2939](../src/shift-board.ts#L2939) | 〔見出し〕単価ルール・案件の単価設定 | shift-board.js |
| GET | `/api/admin/recruit-applications` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:633](../src/recruit.ts#L633) | 応募一覧（枠の情報・残り人数・重複の警告・電話番号が一致する登録済みスタッフ） 絞り込み: status（pending / done / cancelled / waitlist: 見送りにした勤務日前の日時がある / all）、page_id、slot_role_id（シフトボードの「応募n」から。#303）、 … | recruit.js |
| POST | `/api/admin/recruit-applications/:id/decide` | 管理者（4ロール） | [recruit.ts:870](../src/recruit.ts#L870) | 〔見出し〕応募の対応メモ（#478）。電話済み・不在・面談予定などを、書いた人・日時と一緒に残して管理者どうしで共有する | recruit.js |
| POST | `/api/admin/recruit-applications/:id/notes` | 管理者（4ロール） | [recruit.ts:723](../src/recruit.ts#L723) | 〔見出し〕応募の対応メモ（#478）。電話済み・不在・面談予定などを、書いた人・日時と一緒に残して管理者どうしで共有する | recruit.js |
| DELETE | `/api/admin/recruit-applications/:id/notes/:noteId` | 管理者（4ロール） | [recruit.ts:736](../src/recruit.ts#L736) | 自分が書いたメモだけ消せる（書き間違いの訂正用） | recruit.js |
| POST | `/api/admin/recruit-applications/:id/notify-result` | 管理者（4ロール） | [recruit.ts:814](../src/recruit.ts#L814) | 応募の結果のメールを送り直す（#151。メールが届かなかった・送らずに処理したとき）。承認・見送りにした日時をまとめて1通で送る | recruit.js |
| GET | `/api/admin/recruit-applications/:id/staff-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:827](../src/recruit.ts#L827) | 未登録の応募者を紐づける既存スタッフの候補（#395）。電話番号が一致しなくても、氏名・フリガナ・スタッフ番号・電話番号で探せる。 q を省くと、応募の電話番号・氏名・フリガナが一致するスタッフを返す。一致の強い順（電話番号 → 氏名 → フリガナ）に並べる | recruit.js |
| GET | `/api/admin/recruit-applications/summary` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:771](../src/recruit.ts#L771) | 〔見出し〕応募の対応メモ（#478）。電話済み・不在・面談予定などを、書いた人・日時と一緒に残して管理者どうしで共有する | recruit.js |
| GET | `/api/admin/recruit-pages` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:543](../src/recruit.ts#L543) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| POST | `/api/admin/recruit-pages` | 管理者（4ロール） | [recruit.ts:566](../src/recruit.ts#L566) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| DELETE | `/api/admin/recruit-pages/:id` | 管理者（4ロール） | [recruit.ts:613](../src/recruit.ts#L613) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| PUT | `/api/admin/recruit-pages/:id` | 管理者（4ロール） | [recruit.ts:590](../src/recruit.ts#L590) | 〔見出し〕既存の枠の人数の変更（割り当て済みの人数より少なくはできない） | recruit.js |
| GET | `/api/admin/recruit-slots` | 管理者（4ロール）＋本部の閲覧（GET） | [recruit.ts:525](../src/recruit.ts#L525) | 募集ページの画面に出す、対象の案件・期間の既存の枠（役割ごと）。人数をこの画面で直せるようにする（#9421） | recruit.js |
| POST | `/api/admin/recruit-slots/:id/reject-pending` | 管理者（4ロール） | [recruit.ts:792](../src/recruit.ts#L792) | 枠（役割）に残っている未対応の応募をまとめて見送る（定員に達した枠の残り。#303）。承認の処理中（processing）の明細は対象にしない | recruit.js |
| GET | `/api/admin/report-links/bulk` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:1340](../src/staff-lifecycle.ts#L1340) | 〔見出し〕報告用URLのまとめての発行（#275） | staff-lifecycle.js |
| POST | `/api/admin/report-links/bulk` | 管理者（4ロール） | [staff-lifecycle.ts:1350](../src/staff-lifecycle.ts#L1350) | 未発行のシフトにまとめて発行する（発行済みのURLはそのまま）。shift_ids を送ったときは、その中の未発行のものだけ | staff-lifecycle.js |
| GET | `/api/admin/report-settings/day-before-check` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:633](../src/report-settings.ts#L633) | 前日確認の設定（#176）。ほかの会社設定を上書きしないよう、この項目だけを書き換える | admin.js |
| PUT | `/api/admin/report-settings/day-before-check` | 管理者（4ロール） | [report-settings.ts:638](../src/report-settings.ts#L638) | 〔見出し〕管理者 API | admin.js |
| GET | `/api/admin/report-settings/exceptions` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:793](../src/report-settings.ts#L793) | 〔見出し〕シフト単位の例外（#313） | report-settings.js |
| GET | `/api/admin/report-settings/logs` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:948](../src/report-settings.ts#L948) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | attendance-history.js report-settings.js |
| GET | `/api/admin/report-settings/logs/export` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:958](../src/report-settings.ts#L958) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | attendance-history.js |
| GET | `/api/admin/report-settings/off-list` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:902](../src/report-settings.ts#L902) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | report-settings.js |
| GET | `/api/admin/report-settings/off-list/export` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:911](../src/report-settings.ts#L911) | 〔見出し〕案件をまたいだ OFF の設定一覧（#446） | report-settings.js |
| GET | `/api/admin/report-settings/projects` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:653](../src/report-settings.ts#L653) | 案件一覧（終了した案件は include_closed=1 で表示）。 個別設定のある人数と、OFF の報告がある在籍中の所属スタッフの人数も返す（#446） | report-settings.js |
| GET | `/api/admin/report-settings/projects/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:669](../src/report-settings.ts#L669) | 案件詳細: 標準設定（版番号つき）・所属スタッフ別の設定（在籍状況・設定の種類・今後のシフトの例外の件数） | report-settings.js |
| POST | `/api/admin/report-settings/projects/:id/bulk` | 管理者（4ロール） | [report-settings.ts:733](../src/report-settings.ts#L733) | 一括変更。dry_run で確認内容（対象者ごとの変更前・変更後、影響人数）と確認トークンを返す。 保存時は確認トークンを送る。確認後に設定が変わっていた場合（別の操作・二重送信）は 409 で再確認を求める。 退職・統合済み・取引終了のスタッフは対象にしない（#247） | report-settings.js |
| PUT | `/api/admin/report-settings/projects/:id/default` | 管理者（4ロール） | [report-settings.ts:697](../src/report-settings.ts#L697) | 標準設定の変更。version は画面を開いた時点の版番号（違えば 409。#509）。 apply: none = 新しく所属するスタッフにだけ / standard = 個別に変えていない今の所属スタッフにも / all = 今の所属スタッフ全員にも（#329） | report-settings.js |
| PUT | `/api/admin/report-settings/projects/:id/staff/:staffId` | 管理者（4ロール） | [report-settings.ts:718](../src/report-settings.ts#L718) | スタッフ別の変更（1 人） | report-settings.js |
| GET | `/api/admin/report-settings/staff/:staffId` | 管理者（4ロール）＋本部の閲覧（GET） | [report-settings.ts:830](../src/report-settings.ts#L830) | 〔見出し〕スタッフ 1 人の全案件の設定（#413） | report-settings.js |
| POST | `/api/admin/report-settings/staff/:staffId/apply` | 管理者（4ロール） | [report-settings.ts:841](../src/report-settings.ts#L841) | すべての案件（または選んだ案件）に同じ設定を当てる。dry_run で案件ごとの変更前・変更後と確認トークンを返す（一括変更と同じ流れ） project_ids を省くと、稼働中の案件すべて | report-settings.js |
| POST | `/api/admin/report-settings/staff/:staffId/reset` | 管理者（4ロール） | [report-settings.ts:867](../src/report-settings.ts#L867) | 案件の標準設定に戻す（案件 × スタッフ別の行を消す）。project_ids を省くとシフトのある全案件 | report-settings.js |
| POST | `/api/admin/roster` | 管理者（4ロール） | [roster.ts:1423](../src/roster.ts#L1423) | ②従業員管理から作成 / ③取引先から作成 / ④スキルシートのみ作成 | roster.js tour.js |
| GET | `/api/admin/roster-chat/:staffId` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:188](../src/roster-chat.ts#L188) | メッセージ取得（全履歴）。取得しただけでは既読にしない（#462。既読は POST /:staffId/read）。 自社の担当者それぞれの既読位置（誰がどこまで読んだか）も返す | roster-chat.js |
| POST | `/api/admin/roster-chat/:staffId` | 管理者（4ロール） | [roster-chat.ts:229](../src/roster-chat.ts#L229) | 投稿 | roster-chat.js |
| POST | `/api/admin/roster-chat/:staffId/read` | 管理者（4ロール） | [roster-chat.ts:213](../src/roster-chat.ts#L213) | 既読にする（チャット欄が画面に見えたとき・一覧から開いたとき）。last_comment_id まで（省略時は最新まで）を既読にする | roster-chat.js |
| GET | `/api/admin/roster-chat/ended/:threadStaffId` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:160](../src/roster-chat.ts#L160) | 連携が終わったスレッドのメッセージ（閲覧のみ・投稿はできない）。取得時に自社として既読にする（#237） 自社が所属元・稼働先として参加したやり取りだけを返す。連携中のスレッドはスタッフ詳細のチャット欄から開く | roster-chat.js |
| GET | `/api/admin/roster-chat/threads` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:56](../src/roster-chat.ts#L56) | スレッド一覧（自社が参加する全スレッド + 未読数）— ダッシュボード通知・一覧画面用 | roster-chat.js |
| GET | `/api/admin/roster-chat/unread-count` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-chat.ts:156](../src/roster-chat.ts#L156) | 〔見出し〕企業間チャット（所属元 ⇔ 稼働先 担当者）フェーズG | roster-chat.js |
| PUT | `/api/admin/roster/:id/host-status` | 管理者（4ロール） | [roster.ts:685](../src/roster.ts#L685) | 〔見出し〕稼働先での取引状況（#249） | staff-lifecycle.js |
| GET | `/api/admin/roster/:id/links` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:757](../src/roster.ts#L757) | 所属元: 自社スタッフの連携先企業一覧 + 稼働先が記入した共有追記項目（閲覧のみ） 稼働先: 自社の連携レコードの同意履歴 | roster-chat.js roster.js |
| POST | `/api/admin/roster/:id/links/:linkedId/end` | 管理者（4ロール） | [roster.ts:818](../src/roster.ts#L818) | 〔見出し〕所属元による連携の終了・再開（#162） | roster.js |
| POST | `/api/admin/roster/:id/links/:linkedId/resume` | 管理者（4ロール） | [roster.ts:849](../src/roster.ts#L849) | 終了した連携を再開する（直接連携した行だけ。多段連携の先の行は、その行の所属元が再開する） | roster.js |
| GET | `/api/admin/roster/:id/share-code` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:663](../src/roster.ts#L663) | 自社雇用スタッフの連携用ID（QRの中身）。再発行・有効期限なし。 | roster.js |
| GET | `/api/admin/roster/field-settings` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:610](../src/roster.ts#L610) | 必須項目設定の取得 | roster.js |
| PUT | `/api/admin/roster/field-settings` | 管理者（4ロール）<br>＋本文で確認: 権限の表: roster.required_fields | [roster.ts:619](../src/roster.ts#L619) | 必須項目設定の更新（会社管理者のみ） | roster.js |
| GET | `/api/admin/roster/field-settings/missing` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:635](../src/roster.ts#L635) | 〔見出し〕ルーティング | roster.js |
| GET | `/api/admin/roster/host-notes` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:720](../src/roster.ts#L720) | 〔見出し〕連携先からの追記（現場評価・稼働メモ）の一覧（#538） | roster.js |
| POST | `/api/admin/roster/host-notes/seen` | 管理者（4ロール） | [roster.ts:742](../src/roster.ts#L742) | 確認済みにする（指定した history_id まで。省略時は今ある分すべて） | roster.js |
| POST | `/api/admin/roster/import/commit` | 管理者（4ロール） | [roster-import.ts:359](../src/roster-import.ts#L359) | 〔見出し〕スタッフマスタ・従業員の CSV 一括登録（#430） | roster.js |
| POST | `/api/admin/roster/import/preview` | 管理者（4ロール） | [roster-import.ts:334](../src/roster-import.ts#L334) | 〔見出し〕スタッフマスタ・従業員の CSV 一括登録（#430） | roster.js |
| GET | `/api/admin/roster/import/template` | 管理者（4ロール）＋本部の閲覧（GET） | [roster-import.ts:325](../src/roster-import.ts#L325) | 〔見出し〕スタッフマスタ・従業員の CSV 一括登録（#430） | roster.js |
| POST | `/api/admin/roster/link` | 管理者（4ロール） | [roster.ts:1333](../src/roster.ts#L1333) | ①QR/ID連携: 同意の上で稼働先のスタッフマスタに連携登録する | roster.js |
| GET | `/api/admin/roster/lookup` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:1251](../src/roster.ts#L1251) | ①QR/ID連携: コードから連携候補をプレビュー（同意前なので識別に必要な最小限のみ返す） | roster.js |
| GET | `/api/admin/roster/next-code` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:921](../src/roster.ts#L921) | 次に使えるスタッフ番号（#424。登録画面の番号欄の既定値） | roster.js staff-lifecycle.js |
| GET | `/api/admin/roster/partners` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:928](../src/roster.ts#L928) | 取引先（Field OS未契約の所属元）一覧: 自社名を除いた staff_affiliations。 以前のスタッフ詳細の保存で、個人事業主の屋号やスキルシートのみの人の所属会社名が取引先マスタに入っていたため（#262）、 所属スタッフ・支払先のシフト・連絡先がなく、取引先以外の区分のスタッフの所属会社名と同じ名… | recruit.js roster.js staff-lifecycle.js |
| POST | `/api/admin/roster/partners` | 管理者（4ロール） | [roster.ts:1152](../src/roster.ts#L1152) | 〔見出し〕取引先の登録・編集・統合・削除（#161） | roster.js |
| DELETE | `/api/admin/roster/partners/:pid` | 管理者（4ロール） | [roster.ts:1237](../src/roster.ts#L1237) | 削除: 所属スタッフ・支払先のシフト・予約中の区分変更がない取引先だけ | roster.js |
| PUT | `/api/admin/roster/partners/:pid` | 管理者（4ロール） | [roster.ts:1170](../src/roster.ts#L1170) | 編集。名前を変えたら、所属スタッフの所属会社名もそろえる | roster.js |
| GET | `/api/admin/roster/partners/:pid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:990](../src/roster.ts#L990) | 協力会社の詳細: 連絡先・つながったクライアント・在籍中の所属スタッフ・月の支払と請求の要約・つなぐときのクライアントの選択肢 | roster.js |
| PUT | `/api/admin/roster/partners/:pid{[0-9]+}/client` | 管理者（4ロール） | [roster.ts:1038](../src/roster.ts#L1038) | つなぐ・外す。body: { client_id: number \| null }。同じクライアントを2つの協力会社につなげない | roster.js |
| POST | `/api/admin/roster/partners/:pid/merge` | 管理者（4ロール） | [roster.ts:1206](../src/roster.ts#L1206) | 統合: 表記ゆれなどで分かれた取引先（pid）を、統合先（into_id）にまとめる。 所属スタッフ・未確定のシフトの支払先・予約中の区分変更を統合先に付け替え、統合先の空欄の連絡先は統合元の値で埋める。 確定済みの精算のシフトは支払先を変えない（統合元の行は、使われていなければ削除し、使われていれば統合済みとして残… | roster.js |
| GET | `/api/admin/roster/partners/by-client/:cid{[0-9]+}` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:1017](../src/roster.ts#L1017) | クライアント詳細の「協力会社としての支払」の欄: つながった協力会社と、その会社への月の支払。つながっていなければ、つなげる協力会社の選択肢 | roster.js |
| GET | `/api/admin/roster/share-codes` | 管理者（4ロール）＋本部の閲覧（GET） | [roster.ts:887](../src/roster.ts#L887) | 一覧（自社専用コードをまだ発行していない人は code が null） | roster.js |
| POST | `/api/admin/roster/share-codes` | 管理者（4ロール） | [roster.ts:894](../src/roster.ts#L894) | 〔見出し〕連携用IDの一覧（#539 所属元: 複数のスタッフのIDをまとめて出す） | roster.js |
| GET | `/api/admin/security/settings` | 会社管理者 | [api.ts:1100](../src/api.ts#L1100) | 〔見出し〕会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） | security.js |
| PUT | `/api/admin/security/settings` | 会社管理者 | [api.ts:1105](../src/api.ts#L1105) | 〔見出し〕会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） | security.js |
| GET | `/api/admin/security/staff` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1151](../src/api.ts#L1151) | ログインを終了させるスタッフを選ぶ: 名前・スタッフ番号で探す。空欄なら、ログイン中の端末があるスタッフを最近のログイン順に出す | security.js |
| GET | `/api/admin/security/users` | 会社管理者 | [api.ts:1110](../src/api.ts#L1110) | 管理者アカウントの二段階認証の状態とログイン中の端末の数 | security.js |
| DELETE | `/api/admin/security/users/:id/mfa` | 会社管理者 | [api.ts:1125](../src/api.ts#L1125) | 端末を失くした管理者の二段階認証を解除する（次のログインはパスワードだけ。必須の設定なら登録し直しになる） | security.js |
| DELETE | `/api/admin/security/users/:id/sessions` | 会社管理者 | [api.ts:1133](../src/api.ts#L1133) | 〔見出し〕会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） |  |
| GET | `/api/admin/settings/corrections` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [corrections.ts:677](../src/corrections.ts#L677) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| PUT | `/api/admin/settings/corrections` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [corrections.ts:682](../src/corrections.ts#L682) | 〔見出し〕管理者 API（/api/admin/*。自社のシフトの申請のみ） | corrections.js |
| GET | `/api/admin/settings/lateness` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3434](../src/api.ts#L3434) | 遅刻の猶予（分）。入店・勤務開始が開始時刻から何分以内なら遅刻にしないか（report-settings.ts の lateness。#497）。 基準はシフトの開始時刻。案件ごとに上書きできる（projects.late_grace_minutes。NULL なら会社の値）。 projects は稼働中の案件と、終… | admin.js |
| PUT | `/api/admin/settings/lateness` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3455](../src/api.ts#L3455) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/settings/mail-contact` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: settings.mail_contact | [notifications.ts:879](../src/notifications.ts#L879) | 〔見出し〕お知らせメールの差出人の情報（#367）。companies.settings_json の mail_reply_to（返信先）・mail_contact_phone（問い合わせの電話番号） | notifications.js |
| PUT | `/api/admin/settings/mail-contact` | 管理者（4ロール）<br>＋本文で確認: 権限の表: settings.mail_contact | [notifications.ts:884](../src/notifications.ts#L884) | 〔見出し〕お知らせメールの差出人の情報（#367）。companies.settings_json の mail_reply_to（返信先）・mail_contact_phone（問い合わせの電話番号） | notifications.js |
| GET | `/api/admin/settings/photo-required` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3398](../src/api.ts#L3398) | 現在の設定・変更の記録と、変更の影響範囲（会社の設定に従う案件の数・案件ごとに上書きしている案件の数） | admin.js |
| POST | `/api/admin/settings/photo-required` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:3410](../src/api.ts#L3410) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/settings/photo-skip` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:1866](../src/api.ts#L1866) | 管理者: 写真なしの報告を許可するか（companies.settings_json の photo_skip_allowed。既定は許可しない） | admin.js |
| POST | `/api/admin/settings/photo-skip` | 管理者（4ロール）<br>＋本文で確認: 勤怠の設定の権限 | [api.ts:1871](../src/api.ts#L1871) | 〔見出し〕打刻（#427 #9939。本体は src/attendance-punch.ts） | admin.js |
| GET | `/api/admin/settings/reminders` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: settings.reminders | [notifications.ts:1059](../src/notifications.ts#L1059) | 〔見出し〕本人あての自動リマインド（#160）。対象の選び方と送る時点の判定は services/reminders.ts（15分おきの cron） | report-settings.js |
| PUT | `/api/admin/settings/reminders` | 管理者（4ロール）<br>＋本文で確認: 権限の表: settings.reminders | [notifications.ts:1064](../src/notifications.ts#L1064) | 〔見出し〕本人あての自動リマインド（#160）。対象の選び方と送る時点の判定は services/reminders.ts（15分おきの cron） | report-settings.js |
| GET | `/api/admin/settings/shift-notify` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: settings.shift_notify | [api.ts:6021](../src/api.ts#L6021) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js shift-board.js |
| PUT | `/api/admin/settings/shift-notify` | 管理者（4ロール）<br>＋本文で確認: 権限の表: settings.shift_notify | [api.ts:6025](../src/api.ts#L6025) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | shift-board.js |
| GET | `/api/admin/settings/site-contact` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3468](../src/api.ts#L3468) | 会社の緊急連絡先（#173）と、入店の位置が現場から離れているとみなす距離（m。0 は判定しない。#277） | admin.js |
| PUT | `/api/admin/settings/site-contact` | 管理者（4ロール） | [api.ts:3474](../src/api.ts#L3474) | 〔見出し〕管理者ToDo (ルールベース。会社全体) | admin.js |
| GET | `/api/admin/settings/staff-view` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: settings.staff_view | [api.ts:5994](../src/api.ts#L5994) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js |
| PUT | `/api/admin/settings/staff-view` | 管理者（4ロール）<br>＋本文で確認: 権限の表: settings.staff_view | [api.ts:5999](../src/api.ts#L5999) | 〔見出し〕日報の実績の修正（利用者の決定 Sprint 15。#9707。lib/daily-report.ts・migrations/0097） | admin.js |
| GET | `/api/admin/settlement` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: closing.reopen | [settlement.ts:574](../src/settlement.ts#L574) | 〔見出し〕月額（固定）の請求（#9702。src/lib/monthly-billing.ts） | settlement.js |
| POST | `/api/admin/settlement/acks` | 管理者（4ロール） | [settlement.ts:845](../src/settlement.ts#L845) | shift_ids のシフトの確認事項を確認済みにする（undo: true で確認済みを取り消す） | settlement.js |
| GET | `/api/admin/settlement/cancellations/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1279](../src/settlement.ts#L1279) | 入力欄の初期値に使う、予定の金額（請求基本額・支払基本額）と案件の規定を返す | settlement.js |
| PUT | `/api/admin/settlement/cancellations/:id` | 管理者（4ロール） | [settlement.ts:1296](../src/settlement.ts#L1296) | 欠勤のシフトのキャンセル料・補償を保存する（remove: true で取り消し、精算の対象から外す） | settlement.js |
| PUT | `/api/admin/settlement/clients/:id/closing-day` | 管理者（4ロール） | [settlement.ts:1212](../src/settlement.ts#L1212) | day: 1〜31（31 = 月末）。空欄で未設定（暦月）に戻す | settlement.js |
| GET | `/api/admin/settlement/closings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: closing.reopen | [settlement.ts:1223](../src/settlement.ts#L1223) | 〔見出し〕締め（#170） | settlement.js |
| POST | `/api/admin/settlement/closings` | 管理者（4ロール） | [settlement.ts:1236](../src/settlement.ts#L1236) | 期間を締める。期間内の精算の対象（確定・代打・キャンセル料を入れた欠勤）がすべて確定済みのときだけ締められる。 確定後に対応が必要な事項（確定後の打刻修正など）があるときは、確認してから force で締める | settlement.js |
| POST | `/api/admin/settlement/closings/:id/reopen` | 管理者（4ロール）<br>＋本文で確認: 権限の表: closing.reopen | [settlement.ts:1258](../src/settlement.ts#L1258) | 締めの解除は会社管理者だけ。理由を必ず残す（行は消さない） | settlement.js |
| POST | `/api/admin/settlement/confirm` | 管理者（4ロール） | [settlement.ts:763](../src/settlement.ts#L763) | 〔見出し〕確定・取り消し | settlement.js |
| GET | `/api/admin/settlement/export` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: payout.manage | [settlement.ts:900](../src/settlement.ts#L900) | 〔見出し〕CSV | settlement.js |
| GET | `/api/admin/settlement/monthly-rules` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1523](../src/settlement.ts#L1523) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| POST | `/api/admin/settlement/monthly-rules` | 管理者（4ロール） | [settlement.ts:1537](../src/settlement.ts#L1537) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| DELETE | `/api/admin/settlement/monthly-rules/:id` | 管理者（4ロール） | [settlement.ts:1581](../src/settlement.ts#L1581) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| PUT | `/api/admin/settlement/monthly-rules/:id` | 管理者（4ロール） | [settlement.ts:1561](../src/settlement.ts#L1561) | 〔見出し〕月額（固定）の請求のルール（#9702。monthly_bill_rules） | settlement.js |
| GET | `/api/admin/settlement/options` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1201](../src/settlement.ts#L1201) | 精算画面を開くたびに取り直す（後から登録した案件・クライアントも選べるように）。締め日（#168）も返す | settlement.js |
| GET | `/api/admin/settlement/payout` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1074](../src/settlement.ts#L1074) | 〔見出し〕振込データ（#471） | settlement.js |
| DELETE | `/api/admin/settlement/payout/accounts/:staffId` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1192](../src/settlement.ts#L1192) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/payout/accounts/:staffId` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1158](../src/settlement.ts#L1158) | 〔見出し〕振込データ（#471） | settlement.js |
| PUT | `/api/admin/settlement/payout/accounts/:staffId` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1169](../src/settlement.ts#L1169) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/payout/export` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1088](../src/settlement.ts#L1088) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/payout/settings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1124](../src/settlement.ts#L1124) | 振込元（依頼人）の設定 | settlement.js |
| PUT | `/api/admin/settlement/payout/settings` | 管理者（4ロール）<br>＋本文で確認: payoutForbidden() | [settlement.ts:1130](../src/settlement.ts#L1130) | 〔見出し〕振込データ（#471） | settlement.js |
| GET | `/api/admin/settlement/premium-settings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: premium_settings.edit | [settlement.ts:1428](../src/settlement.ts#L1428) | 変更は給与の計算に関わるため、会社管理者と事務担当だけ（振込データと同じ）。変更は未確定のシフトにだけ効く（確定済みは確定したときの値のまま） | settlement.js |
| PUT | `/api/admin/settlement/premium-settings` | 管理者（4ロール）<br>＋本文で確認: 権限の表: premium_settings.edit | [settlement.ts:1432](../src/settlement.ts#L1432) | 〔見出し〕深夜・時間外・休日の割増の設定（#167） | settlement.js |
| PUT | `/api/admin/settlement/projects/:id/cancel-policy` | 管理者（4ロール） | [settlement.ts:1328](../src/settlement.ts#L1328) | 案件のキャンセル料の規定（率は 0〜100%。空欄 = 規定なし） | settlement.js |
| POST | `/api/admin/settlement/recalc` | 管理者（4ロール） | [settlement.ts:865](../src/settlement.ts#L865) | 確認事項『数量・金額が今の計算と違う』のシフトを、今の案件の時間の設定で計算し直す（amountsForActual。単価ルールは再適用しない）。 確定済みのシフトと、手動で数量も固定したシフト（qtyFixed）は変えない。単価だけを固定したもの（qty_locked = 0）は時給の数量を合わせる（#196） | settlement.js |
| GET | `/api/admin/settlement/statement` | 管理者（4ロール）＋本部の閲覧（GET） | [settlement.ts:1363](../src/settlement.ts#L1363) | 〔見出し〕支払明細書・請求明細書（#168） | settlement.js |
| POST | `/api/admin/settlement/sync-actuals` | 管理者（4ロール） | [settlement.ts:645](../src/settlement.ts#L645) | 報告から実績を求める規則は actualFromReports、金額は amountsForActual（syncActualFromReports・refreshShiftAmounts と共用） | settlement.js |
| POST | `/api/admin/settlement/transport-fill` | 管理者（4ロール） | [settlement.ts:1455](../src/settlement.ts#L1455) | shift_ids のうち、未確定・締めていない期間の勤務（確定・代打）のシフトで、交通費の実費が 0 のものに、スタッフの標準（開催場所 → スタッフ）を入れる。 入力済みの交通費は変えない。単価の手動変更（price_locked）にはしない。dry_run は件数だけを返す | settlement.js |
| POST | `/api/admin/settlement/unconfirm` | 管理者（4ロール） | [settlement.ts:803](../src/settlement.ts#L803) | 〔見出し〕確定・取り消し | settlement.js |
| GET | `/api/admin/shift-board` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:773](../src/shift-board.ts#L773) | 〔見出し〕シフトボード | shift-board.js |
| GET | `/api/admin/shift-board/candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:996](../src/shift-board.ts#L996) | 候補スタッフ（枠の役割に対して） | admin.js shift-board.js |
| GET | `/api/admin/shift-board/export` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:883](../src/shift-board.ts#L883) | 〔見出し〕クライアントに出す配置表（#298） | shift-board.js |
| GET | `/api/admin/shift-requests` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:671](../src/shift-board.ts#L671) | 〔見出し〕スタッフのシフト希望（shift_requests。#12 #353） | shift-board.js |
| POST | `/api/admin/shift-requests/:id/respond` | 管理者（4ロール） | [shift-board.ts:692](../src/shift-board.ts#L692) | 採用（accept）・見送り（decline）の返事。返事待ちのものだけ（本人が取り下げた後や二重の返事は 409） | shift-board.js |
| POST | `/api/admin/shift-slots` | 管理者（4ロール） | [shift-board.ts:1177](../src/shift-board.ts#L1177) | 〔見出し〕募集枠 | shift-board.js |
| DELETE | `/api/admin/shift-slots/:id` | 管理者（4ロール） | [shift-board.ts:1390](../src/shift-board.ts#L1390) | 〔見出し〕書き込み（枠・役割・シフトをまとめて） | shift-board.js |
| GET | `/api/admin/shift-slots/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1191](../src/shift-board.ts#L1191) | 〔見出し〕募集枠 | shift-board.js |
| PUT | `/api/admin/shift-slots/:id` | 管理者（4ロール） | [shift-board.ts:1207](../src/shift-board.ts#L1207) | 〔見出し〕募集枠 | shift-board.js |
| GET | `/api/admin/shift-slots/:id/band` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1561](../src/shift-board.ts#L1561) | 〔見出し〕帯（まとめて入れた枠・シフト）の範囲（Sprint 15 #9705） | shift-board.js |
| POST | `/api/admin/shift-slots/assign-batch` | 管理者（4ロール） | [shift-board.ts:1717](../src/shift-board.ts#L1717) | 〔見出し〕まとめて保存（Sprint 11 #9402） | shift-board.js |
| POST | `/api/admin/shift-slots/bulk-delete` | 管理者（4ロール） | [shift-board.ts:1418](../src/shift-board.ts#L1418) | 〔見出し〕書き込み（枠・役割・シフトをまとめて） | shift-board.js |
| POST | `/api/admin/shift-slots/roles/:id/assign` | 管理者（4ロール） | [shift-board.ts:1623](../src/shift-board.ts#L1623) | 〔見出し〕帯（まとめて入れた枠・シフト）の範囲（Sprint 15 #9705） | admin.js shift-board.js |
| GET | `/api/admin/shifts` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5237](../src/api.ts#L5237) | シフト管理 | admin.js |
| POST | `/api/admin/shifts` | 管理者（4ロール） | [api.ts:5265](../src/api.ts#L5265) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js |
| DELETE | `/api/admin/shifts/:id` | 管理者（4ロール） | [api.ts:5432](../src/api.ts#L5432) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js shift-board.js |
| PUT | `/api/admin/shifts/:id` | 管理者（4ロール） | [api.ts:5323](../src/api.ts#L5323) | 〔見出し〕使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） | admin.js shift-board.js |
| PUT | `/api/admin/shifts/:id/actual` | 管理者（4ロール） | [settlement.ts:702](../src/settlement.ts#L702) | 〔見出し〕実績の手入力 | settlement.js |
| GET | `/api/admin/shifts/:id/attendance-photos` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:5251](../src/api.ts#L5251) | シフトの勤怠報告の一覧（写真の有無つき）。写真は GET /admin/attendance-photo/:attendance_id で取得する（#217） | admin.js |
| GET | `/api/admin/shifts/:id/attendance-withdrawals` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1729](../src/api.ts#L1729) | 本人が取り消した報告の記録（シフト操作のモーダルに出す。#323） | admin.js |
| GET | `/api/admin/shifts/:id/band` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1597](../src/shift-board.ts#L1597) | 〔見出し〕帯（まとめて入れた枠・シフト）の範囲（Sprint 15 #9705） | shift-board.js |
| GET | `/api/admin/shifts/:id/check-in-location` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:1741](../src/api.ts#L1741) | 入店の位置と現場の距離（シフト操作のモーダルに出す。#277）。 アプリの入店は報告のときに保存した距離、報告用URLなど距離のない報告は、いまの現場の位置で計算する。基準は会社設定（0 は判定しない） | admin.js |
| POST | `/api/admin/shifts/:id/day-before-confirm` | 管理者（4ロール） | [api.ts:1610](../src/api.ts#L1610) | 前日確認を管理者が記録する（電話などで本人に確かめたとき。#176）。ダッシュボードの明日のシフトの一覧から使う | admin.js |
| POST | `/api/admin/shifts/:id/move` | 管理者（4ロール） | [shift-board.ts:1843](../src/shift-board.ts#L1843) | シフトを別の枠・役割へ移動（案件が変われば単価を再計算）。slot_role_id=null なら枠から外す | shift-board.js |
| PUT | `/api/admin/shifts/:id/price` | 管理者（4ロール） | [shift-board.ts:2027](../src/shift-board.ts#L2027) | 金額の手動変更 / ルールに戻す | settlement.js shift-board.js |
| POST | `/api/admin/shifts/:id/proxy-attendance` | 管理者（4ロール） | [staff-lifecycle.ts:998](../src/staff-lifecycle.ts#L998) | 〔見出し〕代理入力（管理者が勤怠を記録。entry_method='proxy'） | staff-lifecycle.js |
| DELETE | `/api/admin/shifts/:id/proxy-attendance/:type` | 管理者（4ロール） | [staff-lifecycle.ts:1034](../src/staff-lifecycle.ts#L1034) | 〔見出し〕代理入力（管理者が勤怠を記録。entry_method='proxy'） | staff-lifecycle.js |
| POST | `/api/admin/shifts/:id/proxy-daily-report` | 管理者（4ロール） | [staff-lifecycle.ts:1381](../src/staff-lifecycle.ts#L1381) | 電話・口頭で聞いた内容や、報告用URLの期限が過ぎた日報を管理者が記録する（entry_method = 'proxy'、entered_by = 記録した管理者）。 本人が提出した日報があるときは overwrite: true のときだけ上書きする。確認済みの日報を上書きしたら、アプリと同じく確認済みを外す | staff-lifecycle.js |
| DELETE | `/api/admin/shifts/:id/report-link` | 管理者（4ロール） | [staff-lifecycle.ts:1130](../src/staff-lifecycle.ts#L1130) | 〔見出し〕報告用URLのトークンの保存（#9969。ほかのトークンと同じく SHA-256 のハッシュだけを持つ） | staff-lifecycle.js |
| POST | `/api/admin/shifts/:id/report-link` | 管理者（4ロール） | [staff-lifecycle.ts:1108](../src/staff-lifecycle.ts#L1108) | 〔見出し〕報告用URLのトークンの保存（#9969。ほかのトークンと同じく SHA-256 のハッシュだけを持つ） | staff-lifecycle.js |
| PUT | `/api/admin/shifts/:id/report-settings` | 管理者（4ロール） | [staff-lifecycle.ts:905](../src/staff-lifecycle.ts#L905) | 〔見出し〕提出設定 | staff-lifecycle.js |
| GET | `/api/admin/shifts/:id/report-status` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:853](../src/staff-lifecycle.ts#L853) | 〔見出し〕提出設定 | admin.js settlement.js staff-lifecycle.js |
| POST | `/api/admin/shifts/bulk` | 管理者（4ロール） | [shift-board.ts:2177](../src/shift-board.ts#L2177) | 常勤の一括登録: スタッフ × 曜日 × 期間（枠なしのシフトとして登録）。 退職・統合・停止中・NG・同じ時間帯に別のシフトがある組み合わせはスキップし、理由を skipped で返す。 組み合わせ（日付順 → 指定したスタッフ順）を BULK_LIMIT 件ずつ処理し、残りがあれば next_cursor（次に処… | shift-board.js |
| POST | `/api/admin/shifts/bulk-delete` | 管理者（4ロール） | [shift-board.ts:1531](../src/shift-board.ts#L1531) | 〔見出し〕シフトのまとめて削除（Sprint 15 #9705 #9706） | shift-board.js |
| POST | `/api/admin/shifts/confirm-requested` | 管理者（4ロール） | [shift-board.ts:1889](../src/shift-board.ts#L1889) | 〔見出し〕1回の batch で登録する。同時に別の画面から同じ枠に同じ人が入った行（一意インデックス）は飛ばし、理由を返す | shift-board.js |
| POST | `/api/admin/shifts/copy-week` | 管理者（4ロール） | [shift-board.ts:2330](../src/shift-board.ts#L2330) | 〔見出し〕退職・取引終了にするときの、今後のシフトの確認と取り外し（#500 #187） | shift-board.js |
| GET | `/api/admin/shifts/price-preview` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2965](../src/shift-board.ts#L2965) | 〔見出し〕単価ルール・案件の単価設定 | admin.js shift-board.js |
| POST | `/api/admin/shifts/reprice` | 管理者（4ロール） | [shift-board.ts:2146](../src/shift-board.ts#L2146) | 〔見出し〕退職・取引終了にするときの、今後のシフトの確認と取り外し（#500 #187） | shift-board.js |
| GET | `/api/admin/sites` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2769](../src/shift-board.ts#L2769) | 開催場所 | shift-board.js |
| POST | `/api/admin/sites` | 管理者（4ロール） | [shift-board.ts:2793](../src/shift-board.ts#L2793) | 〔見出し〕開催場所 | shift-board.js |
| DELETE | `/api/admin/sites/:id` | 管理者（4ロール） | [shift-board.ts:2832](../src/shift-board.ts#L2832) | 〔見出し〕開催場所 | shift-board.js |
| PUT | `/api/admin/sites/:id` | 管理者（4ロール） | [shift-board.ts:2802](../src/shift-board.ts#L2802) | 〔見出し〕開催場所 | shift-board.js |
| GET | `/api/admin/slot-patterns` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:2526](../src/shift-board.ts#L2526) | 繰り返し登録 | shift-board.js |
| POST | `/api/admin/slot-patterns` | 管理者（4ロール） | [shift-board.ts:2542](../src/shift-board.ts#L2542) | 〔見出し〕繰り返し登録 | shift-board.js |
| DELETE | `/api/admin/slot-patterns/:id` | 管理者（4ロール） | [shift-board.ts:2742](../src/shift-board.ts#L2742) | パターンの削除: remove_future=1 なら、今日以降で割り当てのない枠も削除 | shift-board.js |
| PUT | `/api/admin/slot-patterns/:id` | 管理者（4ロール） | [shift-board.ts:2574](../src/shift-board.ts#L2574) | 繰り返し登録の編集と延長（#456） apply_from 以降のこのパターンの枠に、変えた項目（時刻・休憩・役割の人数・役割の追加と削除）だけを反映する。 報告済み（勤怠・日報）・実績が確定済みのシフトがある枠は変えずに除外し、件数を返す。 時刻・休憩を変えた枠の割り当て済みシフトも同じ時刻にし（シフトごとに直した… | shift-board.js |
| GET | `/api/admin/staff` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3497](../src/api.ts#L3497) | スタッフ一覧 | admin.js |
| POST | `/api/admin/staff` | 管理者（4ロール） | [api.ts:4163](../src/api.ts#L4163) | スタッフ登録（テスト・内部用。画面からは呼ばない。画面の新規登録は名簿の登録 POST /admin/roster） |  |
| GET | `/api/admin/staff-affiliations` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4590](../src/api.ts#L4590) | 〔見出し〕所属会社マスタ（スタッフの「所属会社名」選択肢） | admin.js |
| GET | `/api/admin/staff-lookup` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:183](../src/staff-lifecycle.ts#L183) | 〔見出し〕仮登録（氏名・電話だけで登録し、すぐシフトに入れられる） | admin.js staff-lifecycle.js |
| GET | `/api/admin/staff-pay/settings` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: staff_pay.visible_setting | [staff-pay.ts:428](../src/staff-pay.ts#L428) | スタッフアプリに支払額を表示するか（#290。変更は会社管理者のみ） | settlement.js |
| PUT | `/api/admin/staff-pay/settings` | 管理者（4ロール）<br>＋本文で確認: 権限の表: staff_pay.visible_setting | [staff-pay.ts:433](../src/staff-pay.ts#L433) | 〔見出し〕管理者 API（/api/admin/pay-requests*・/api/admin/staff-pay/settings） | settlement.js |
| POST | `/api/admin/staff-quick` | 管理者（4ロール） | [staff-lifecycle.ts:189](../src/staff-lifecycle.ts#L189) | 〔見出し〕仮登録（氏名・電話だけで登録し、すぐシフトに入れられる） | staff-lifecycle.js tour.js |
| GET | `/api/admin/staff-reference-pay` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:3014](../src/shift-board.ts#L3014) | 〔見出し〕スタッフの支払の参考単価（9204） | shift-board.js |
| GET | `/api/admin/staff-requests/documents` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-self-service.ts:495](../src/staff-self-service.ts#L495) | 〔見出し〕書類（本人提出の確認・種類と期限の編集・期限の一覧） | admin.js |
| PUT | `/api/admin/staff-requests/documents/:kind/:docId` | 管理者（4ロール）<br>＋本文で確認: 人事のロール | [staff-self-service.ts:505](../src/staff-self-service.ts#L505) | 種類・有効期限の変更と、本人提出の書類の確認（kind: staff / employee / client） | admin.js |
| GET | `/api/admin/staff-requests/leave` | 会社管理者・事務 | [staff-self-service.ts:535](../src/staff-self-service.ts#L535) | 〔見出し〕休暇（会社管理者・事務担当のみ） | admin.js |
| POST | `/api/admin/staff-requests/leave/:id/approve` | 会社管理者・事務 | [staff-self-service.ts:551](../src/staff-self-service.ts#L551) | 承認: 有給は従業員データの有給残数から引く（残数が未入力・足りないときは承認しない）。その日のシフトは自動では変えない（画面で欠勤の処理を案内する） | admin.js |
| POST | `/api/admin/staff-requests/leave/:id/reject` | 会社管理者・事務 | [staff-self-service.ts:583](../src/staff-self-service.ts#L583) | 〔見出し〕休暇（会社管理者・事務担当のみ） | admin.js |
| POST | `/api/admin/staff-requests/leave/:id/revoke` | 会社管理者・事務<br>＋本文で確認: 人事のロール | [staff-self-service.ts:599](../src/staff-self-service.ts#L599) | 承認の取り消し（予定の変更など）。引いた有給を戻す | admin.js |
| GET | `/api/admin/staff-requests/profile` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-self-service.ts:435](../src/staff-self-service.ts#L435) | 〔見出し〕登録情報の変更申請 | admin.js |
| POST | `/api/admin/staff-requests/profile/:id/approve` | 管理者（4ロール） | [staff-self-service.ts:456](../src/staff-self-service.ts#L456) | 〔見出し〕登録情報の変更申請 | admin.js |
| POST | `/api/admin/staff-requests/profile/:id/reject` | 管理者（4ロール） | [staff-self-service.ts:479](../src/staff-self-service.ts#L479) | 〔見出し〕登録情報の変更申請 | admin.js |
| GET | `/api/admin/staff-requests/summary` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 人事のロール | [staff-self-service.ts:422](../src/staff-self-service.ts#L422) | 画面の件数（メニューのバッジ・タブ）。休暇と入社時書類の期限は労務情報を扱えるロールだけ | admin.js |
| GET | `/api/admin/staff/:id` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3566](../src/api.ts#L3566) | スタッフ詳細 | admin.js |
| PUT | `/api/admin/staff/:id` | 管理者（4ロール） | [api.ts:4087](../src/api.ts#L4087) | スタッフ更新（スタッフマスタ画面から） | admin.js roster.js |
| POST | `/api/admin/staff/:id/affiliation-change` | 管理者（4ロール） | [staff-lifecycle.ts:671](../src/staff-lifecycle.ts#L671) | 〔見出し〕所属区分の変更（dry_run で影響範囲を確認 → 実行） | staff-lifecycle.js |
| DELETE | `/api/admin/staff/:id/affiliation-schedules/:scheduleId` | 管理者（4ロール） | [staff-lifecycle.ts:703](../src/staff-lifecycle.ts#L703) | 区分変更の予約の取消（適用できなかった予約は、確認したら表示を消せるように同じく取消にする） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/documents` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4249](../src/api.ts#L4249) | ファイル一覧（本人がスマホから提出した書類には submitted_by_staff・確認の印が付く。#288） | admin.js |
| POST | `/api/admin/staff/:id/documents` | 管理者（4ロール） | [api.ts:4260](../src/api.ts#L4260) | アップロード（複数ファイル対応。1ファイルずつ個別に検証し、成功分のみ保存する） | admin.js |
| POST | `/api/admin/staff/:id/evaluations` | 管理者（4ロール） | [api.ts:3668](../src/api.ts#L3668) | 〔見出し〕スタッフ評価（#164） | admin.js |
| DELETE | `/api/admin/staff/:id/evaluations/:eid` | 管理者（4ロール）<br>＋本文で確認: 権限の表: hr.manage | [api.ts:3703](../src/api.ts#L3703) | 〔見出し〕スタッフ評価（#164） | admin.js |
| POST | `/api/admin/staff/:id/finalize` | 管理者（4ロール） | [staff-lifecycle.ts:262](../src/staff-lifecycle.ts#L262) | 〔見出し〕本登録（仮登録を解除。ログイン発行は任意） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/future-shifts` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:1970](../src/shift-board.ts#L1970) | 今後のシフトの件数と一覧。退職日を保存する前の確認に使う（from = 退職日の翌日） | admin.js |
| POST | `/api/admin/staff/:id/issue-login` | 管理者（4ロール） | [staff-lifecycle.ts:409](../src/staff-lifecycle.ts#L409) | 仮登録ではない、ログインのないスタッフ（ログインなしで登録した人・本登録でログインを発行しなかった人・他社連携から自社管理に切り替えた人）に、後からログインを発行する（#89） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/lifecycle` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-lifecycle.ts:759](../src/staff-lifecycle.ts#L759) | 〔見出し〕所属区分の変更（dry_run で影響範囲を確認 → 実行） | staff-lifecycle.js |
| POST | `/api/admin/staff/:id/login-email-pending/apply` | 管理者（4ロール） | [api.ts:4143](../src/api.ts#L4143) | 〔見出し〕退職日・在籍状況（#5 #34 #139） | admin.js |
| POST | `/api/admin/staff/:id/login-email-pending/cancel` | 管理者（4ロール） | [api.ts:4153](../src/api.ts#L4153) | 〔見出し〕退職日・在籍状況（#5 #34 #139） | admin.js |
| POST | `/api/admin/staff/:id/merge` | 管理者（4ロール） | [staff-merge.ts:91](../src/staff-merge.ts#L91) | 統合の実行（dry_run で影響を確認） | staff-lifecycle.js |
| GET | `/api/admin/staff/:id/merge-candidates` | 管理者（4ロール）＋本部の閲覧（GET） | [staff-merge.ts:53](../src/staff-merge.ts#L53) | 統合候補（同じ電話番号・同じ氏名・同じフリガナ）。q を渡すと氏名の部分一致でも探す | staff-lifecycle.js |
| PUT | `/api/admin/staff/:id/reference-pay` | 管理者（4ロール） | [shift-board.ts:3020](../src/shift-board.ts#L3020) | 〔見出し〕スタッフの支払の参考単価（9204） | shift-board.js |
| POST | `/api/admin/staff/:id/release-future-shifts` | 管理者（4ロール） | [shift-board.ts:1986](../src/shift-board.ts#L1986) | 今後のシフトをまとめて外す。記録（勤怠・日報・打刻修正・募集の承認）のないシフトは削除して枠を空きに戻し、 記録のあるシフトは残して欠勤にする。shift_ids を送ったときは、確認画面に出したものだけを処理する | admin.js |
| PUT | `/api/admin/staff/:id/report-settings` | 管理者（4ロール） | [staff-lifecycle.ts:813](../src/staff-lifecycle.ts#L813) | 〔見出し〕提出設定 | staff-lifecycle.js |
| POST | `/api/admin/staff/:id/reset-password` | 管理者（4ロール） | [staff-lifecycle.ts:794](../src/staff-lifecycle.ts#L794) | 自社でログインを発行したスタッフだけが対象。他社から連携したスタッフは所属元の会社で再発行する（稼働先の行ではログインできない）。 仮パスワードはこの応答で一度だけ返し、次回ログインで本人に変更を求める。今のセッションと未使用の再設定リンクは無効にする | staff-lifecycle.js |
| DELETE | `/api/admin/staff/:id/schedule-link` | 管理者（4ロール） | [staff-lifecycle.ts:1443](../src/staff-lifecycle.ts#L1443) | 〔見出し〕予定確認URL（#442。スタッフ単位） | staff-lifecycle.js |
| POST | `/api/admin/staff/:id/schedule-link` | 管理者（4ロール） | [staff-lifecycle.ts:1427](../src/staff-lifecycle.ts#L1427) | 発行（発行し直すと前のURLは使えなくなる）。URL はこの応答で一度だけ返す（保存するのはハッシュだけ） | staff-lifecycle.js |
| DELETE | `/api/admin/staff/:id/sessions` | 管理者（4ロール） | [api.ts:1189](../src/api.ts#L1189) | スタッフのログインを強制的に終了する（スマホの紛失・共用端末のログアウト忘れ）。自社雇用の行では、同じ人の他社の行のセッションも消す。 他社から連携したスタッフの行では、自社に切り替えているセッションだけを消す（所属元でのログインは残る。D-53 #9940） | security.js |
| GET | `/api/admin/staff/:id/sessions` | 管理者（4ロール）＋本部の閲覧（GET）<br>＋本文で確認: 権限の表: security.manage | [api.ts:1178](../src/api.ts#L1178) | スタッフのログイン中の端末と直近のログインの履歴（自社雇用の行では、企業を切り替えた他社の画面でのログインも数に含める。会社名は出さない）。 他社から連携したスタッフの行では、自社に切り替えている端末だけを返す（D-53 #9940） | security.js |
| GET | `/api/admin/staff/:id/skill-sheet` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4200](../src/api.ts#L4200) | スキルシート生成 | admin.js |
| PUT | `/api/admin/staff/:id/skill-sheet-comment` | 管理者（4ロール） | [api.ts:4227](../src/api.ts#L4227) | 〔見出し〕退職日・在籍状況（#5 #34 #139） | admin.js |
| POST | `/api/admin/staff/:id/unverified-email` | 管理者（4ロール） | [staff-lifecycle.ts:427](../src/staff-lifecycle.ts#L427) | 未確認のメール（応募フォーム・統合元から引き継いだもの）を、本人に確認できたらログイン・再設定用に設定する／不要なら消す（#38 #148） | staff-lifecycle.js |
| DELETE | `/api/admin/staff/documents/:docId` | 管理者（4ロール） | [api.ts:4275](../src/api.ts#L4275) | 削除（D1を先に消し、R2はベストエフォート。孤立するならR2側の残骸の方が実害が小さいため） | admin.js |
| GET | `/api/admin/staff/documents/:docId/download` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:4271](../src/api.ts#L4271) | ダウンロード（元ファイル名・元Content-Typeで返す。実行される事故を避けるため常にattachment指定） | admin.js |
| GET | `/api/admin/staff/options` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:3546](../src/api.ts#L3546) | スタッフを選ぶための軽い一覧（シフト登録・シフトボード・NGスタッフの選択肢。#463）。集計はしない。 既定は今日の時点で割り当てられる人だけ。?include=all で、統合済み・スキルシートのみ以外の全員（退職・休職を含む）を返す | admin.js shift-board.js |
| GET | `/api/admin/support-requests` | 管理者（4ロール）＋本部の閲覧（GET） | [hq-support.ts:282](../src/hq-support.ts#L282) | 自社の伴走支援の依頼の一覧（新しい順） | hq-support.js |
| POST | `/api/admin/support-requests` | 管理者（4ロール） | [hq-support.ts:289](../src/hq-support.ts#L289) | 〔見出し〕管理画面の API（/api/admin に登録する） | hq-support.js |
| GET | `/api/admin/templates` | 管理者（4ロール）＋本部の閲覧（GET） | [api.ts:7626](../src/api.ts#L7626) | テンプレート一覧 (企業側から参照) project_count: そのテンプレートを使う自社の案件の数。has_reports: 自社のテンプレートで日報が出ているか（項目の削除・タイプの変更を止める） | admin.js |
| POST | `/api/admin/templates` | 管理者（4ロール） | [api.ts:7691](../src/api.ts#L7691) | 〔見出し〕日報テンプレートの作成・編集（#165） | admin.js |
| PUT | `/api/admin/templates/:id` | 管理者（4ロール） | [api.ts:7709](../src/api.ts#L7709) | 〔見出し〕日報テンプレートの作成・編集（#165） | admin.js |
| GET | `/api/admin/tours` | 管理者（4ロール）＋本部の閲覧（GET） | [tours.ts:101](../src/tours.ts#L101) |  | tour.js |
| PUT | `/api/admin/tours` | 管理者（4ロール） | [tours.ts:111](../src/tours.ts#L111) |  | tour.js |
| GET | `/api/admin/tours/checklist` | 管理者（4ロール）＋本部の閲覧（GET） | [tours.ts:120](../src/tours.ts#L120) |  | tour.js |
| GET | `/api/admin/transport-defaults` | 管理者（4ロール）＋本部の閲覧（GET） | [shift-board.ts:3097](../src/shift-board.ts#L3097) | 交通費の標準（スタッフ × 開催場所。#564）。site_id = 0 はそのスタッフのすべての開催場所の標準 割り当て・一括登録・募集の承認で、交通費の入力がなければ使う（lib/transport-defaults） | settlement.js |
| PUT | `/api/admin/transport-defaults` | 管理者（4ロール） | [shift-board.ts:3112](../src/shift-board.ts#L3112) | 登録・変更（同じスタッフ × 開催場所の標準は1つ。あれば金額を置き換える） | settlement.js |
| DELETE | `/api/admin/transport-defaults/:id` | 管理者（4ロール） | [shift-board.ts:3129](../src/shift-board.ts#L3129) | 〔見出し〕交通費の標準（スタッフ × 開催場所。#564）。site_id = 0 はそのスタッフのすべての開催場所の標準 | settlement.js |
| GET | `/api/admin/users` | 会社管理者 | [accounts.ts:304](../src/accounts.ts#L304) | 〔見出し〕管理者アカウント（/api/admin/users。会社管理者のみ） | admin.js |
| POST | `/api/admin/users` | 会社管理者 | [accounts.ts:308](../src/accounts.ts#L308) | 〔見出し〕管理者アカウント（/api/admin/users。会社管理者のみ） | admin.js |
| PUT | `/api/admin/users/:id` | 会社管理者 | [accounts.ts:313](../src/accounts.ts#L313) | 〔見出し〕管理者アカウント（/api/admin/users。会社管理者のみ） | admin.js |
| POST | `/api/admin/users/:id/reset-password` | 会社管理者 | [accounts.ts:324](../src/accounts.ts#L324) | 自分のパスワードは「自分のアカウント」から変更する（現在のパスワードの確認があるため） | admin.js |

### `/api/hq/…` 本部画面（67）

| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |
|---|---|---|---|---|---|
| GET | `/api/hq/announcements` | 本部 | [hq-support.ts:374](../src/hq-support.ts#L374) | 〔見出し〕導入企業へのお知らせ | hq.js |
| POST | `/api/hq/announcements` | 本部 | [hq-support.ts:410](../src/hq-support.ts#L410) | 〔見出し〕導入企業へのお知らせ | hq.js |
| PUT | `/api/hq/announcements/:id` | 本部 | [hq-support.ts:425](../src/hq-support.ts#L425) | 修正（内容・配信先・掲載期間）。取り消したものは直せない。確認済みの記録は残す | hq.js |
| GET | `/api/hq/announcements/:id/reads` | 本部 | [hq-support.ts:392](../src/hq-support.ts#L392) | 企業別の既読状況（配信先の企業ごとに、確認した管理者の人数と最初の確認日時） | hq.js |
| POST | `/api/hq/announcements/:id/withdraw` | 本部 | [hq-support.ts:442](../src/hq-support.ts#L442) | 〔見出し〕導入企業へのお知らせ | hq.js |
| GET | `/api/hq/audit-logs` | 本部 | [api.ts:8227](../src/api.ts#L8227) | 〔見出し〕本部の操作の履歴（#542） | hq.js |
| POST | `/api/hq/billing/close` | 本部 | [api.ts:8125](../src/api.ts#L8125) | 指定した月の請求を記録する（締める）。利用中（active）の企業ごとに、この時点の課金対象の人数・プラン・金額を残す。 すでに記録がある企業は変えない（金額・入金状態は企業詳細で直す）。トライアル・停止中の企業は記録しない | hq.js |
| GET | `/api/hq/companies` | 本部 | [api.ts:7799](../src/api.ts#L7799) | 〔見出し〕プランの料金（#295） | hq.js security.js |
| POST | `/api/hq/companies` | 本部 | [api.ts:8022](../src/api.ts#L8022) | 〔見出し〕プランの料金（#295） | hq.js |
| GET | `/api/hq/companies/:id` | 本部 | [api.ts:7886](../src/api.ts#L7886) | 〔見出し〕プランの料金（#295） | hq.js |
| PUT | `/api/hq/companies/:id` | 本部 | [api.ts:7945](../src/api.ts#L7945) | 〔見出し〕プランの料金（#295） | hq.js |
| PUT | `/api/hq/companies/:id/billing/:month` | 本部 | [api.ts:8157](../src/api.ts#L8157) | 1か月分の請求記録の修正（入金状態・入金日・金額・メモ） | hq.js |
| POST | `/api/hq/companies/:id/support-logs` | 本部 | [api.ts:8198](../src/api.ts#L8198) | 追記で残す。次回の予定日を入れると、企業の次回レビュー日もその日にする | hq.js |
| POST | `/api/hq/companies/:id/users` | 本部 | [accounts.ts:342](../src/accounts.ts#L342) | 〔見出し〕本部（/api/hq/companies/:id/users の追加・変更。一覧は GET /api/hq/companies/:id の users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア） | hq.js |
| PUT | `/api/hq/companies/:id/users/:uid` | 本部 | [accounts.ts:349](../src/accounts.ts#L349) | 〔見出し〕本部（/api/hq/companies/:id/users の追加・変更。一覧は GET /api/hq/companies/:id の users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア） | hq.js |
| POST | `/api/hq/companies/:id/users/:uid/reset-password` | 本部 | [accounts.ts:356](../src/accounts.ts#L356) | 〔見出し〕本部（/api/hq/companies/:id/users の追加・変更。一覧は GET /api/hq/companies/:id の users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア） | hq.js |
| GET | `/api/hq/cron/status` | 本部 | [api.ts:8485](../src/api.ts#L8485) | 定期処理（cron）の処理ごとの最終実行・直近の実行記録・警告（#192） | hq.js |
| GET | `/api/hq/email-logs` | 本部 | [notifications.ts:1002](../src/notifications.ts#L1002) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| GET | `/api/hq/email-stats` | 本部 | [notifications.ts:960](../src/notifications.ts#L960) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| GET | `/api/hq/email-suppressions` | 本部 | [notifications.ts:1012](../src/notifications.ts#L1012) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| POST | `/api/hq/email-suppressions/release` | 本部 | [notifications.ts:1019](../src/notifications.ts#L1019) | 〔見出し〕本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する） | hq.js |
| GET | `/api/hq/errors` | 本部 | [hq-errors.ts:23](../src/hq-errors.ts#L23) |  | hq.js |
| GET | `/api/hq/errors/alerts` | 本部 | [hq-errors.ts:83](../src/hq-errors.ts#L83) | 自分あての未読の障害の通知（本部画面のタブの件数に使う。軽い問い合わせ1回） | hq.js |
| POST | `/api/hq/errors/alerts/read` | 本部 | [hq-errors.ts:91](../src/hq-errors.ts#L91) | 自分あての障害の通知を既読にする（画面を開いて「確認しました」を押したとき）。操作の履歴（hq_audit_logs）には残さない | hq.js |
| GET | `/api/hq/login-history` | 本部 | [api.ts:1251](../src/api.ts#L1251) | 全社のログインの履歴（会社コードの誤りなど、会社が分からない試行も含む） | security.js |
| GET | `/api/hq/monitor` | 本部 | [hq-monitor.ts:20](../src/hq-monitor.ts#L20) |  | hq.js |
| GET | `/api/hq/monitor/banner` | 本部 | [hq-monitor.ts:49](../src/hq-monitor.ts#L49) |  | hq.js |
| POST | `/api/hq/monitor/db-size/count-tables` | 本部 | [hq-monitor.ts:69](../src/hq-monitor.ts#L69) |  | hq.js |
| POST | `/api/hq/monitor/destinations/:key/test` | 本部 | [hq-monitor.ts:57](../src/hq-monitor.ts#L57) |  | hq.js |
| GET | `/api/hq/offboarding` | 本部 | [api.ts:8518](../src/api.ts#L8518) | 一覧: 停止中の企業と、解約の処理の記録がある企業 | hq.js |
| GET | `/api/hq/offboarding/:cid` | 本部 | [api.ts:8534](../src/api.ts#L8534) | 詳細: 解約の処理・操作の記録・表ごとの件数（削除の dry-run を兼ねる）・R2 のファイルの件数 | hq.js |
| POST | `/api/hq/offboarding/:cid/cancel` | 本部 | [api.ts:8584](../src/api.ts#L8584) | 契約終了の取消（猶予中だけ。削除を始めた後は取り消せない） | hq.js |
| POST | `/api/hq/offboarding/:cid/delete` | 本部 | [api.ts:8666](../src/api.ts#L8666) | 削除（猶予を過ぎた企業だけ。会社コードと「削除する」の入力で確かめる）。1回の要求で処理できる量だけ進め、進み具合を返す。 書き出しをしていない場合は、書き出しをしない理由（企業が不要と回答した など）を求める | hq.js |
| GET | `/api/hq/offboarding/:cid/export/:target` | 本部 | [api.ts:8611](../src/api.ts#L8611) | 表ごとの CSV（offset から OFFBOARDING_EXPORT_PAGE 行。次があれば X-Export-Next に次の offset を入れる）。最初の取得を記録する | hq.js |
| GET | `/api/hq/offboarding/:cid/files` | 本部 | [api.ts:8630](../src/api.ts#L8630) | R2 の写真・書類の一覧（offset から OFFBOARDING_FILES_PAGE 件） | hq.js |
| GET | `/api/hq/offboarding/:cid/files/:source/:id` | 本部 | [api.ts:8642](../src/api.ts#L8642) | R2 のファイル1件の取得（元の表と行の ID で。その企業のものだけ）。取得を記録する | hq.js |
| GET | `/api/hq/offboarding/:cid/record.csv` | 本部 | [api.ts:8711](../src/api.ts#L8711) | 〔見出し〕解約・停止した企業のデータの書き出しと削除（system_admin限定。作業単位 w5-hq-offboarding: #177） | hq.js |
| POST | `/api/hq/offboarding/:cid/start` | 本部 | [api.ts:8556](../src/api.ts#L8556) | 契約終了の登録（停止中の企業だけ）。会社コードの入力で確かめる | hq.js |
| GET | `/api/hq/plan-prices` | 本部 | [api.ts:8092](../src/api.ts#L8092) | 〔見出し〕プランの料金の設定（#295） | hq.js |
| PUT | `/api/hq/plan-prices` | 本部 | [api.ts:8095](../src/api.ts#L8095) | 〔見出し〕プランの料金の設定（#295） | hq.js |
| GET | `/api/hq/push/config` | 本部 | [notifications.ts:1960](../src/notifications.ts#L1960) | 〔見出し〕プッシュ通知（#178） | hq.js |
| GET | `/api/hq/push/latest` | 本部 | [notifications.ts:2081](../src/notifications.ts#L2081) | 〔見出し〕プッシュ通知（#178） |  |
| POST | `/api/hq/push/subscribe` | 本部 | [notifications.ts:1973](../src/notifications.ts#L1973) | 〔見出し〕プッシュ通知（#178） | hq.js |
| POST | `/api/hq/push/test` | 本部 | [notifications.ts:2010](../src/notifications.ts#L2010) | テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す） | hq.js |
| POST | `/api/hq/push/unsubscribe` | 本部 | [notifications.ts:2002](../src/notifications.ts#L2002) | 〔見出し〕プッシュ通知（#178） | hq.js |
| POST | `/api/hq/retention/dry-run` | 本部 | [api.ts:8296](../src/api.ts#L8296) | 注意: 実際の削除はCron Triggerからのみ実行する（HTTP経由の一般APIとしては公開しない）。 ここではdry-run（削除せず対象件数のみ確認）と、過去の実行ログの閲覧のみ提供する。 全社にまたがる集計のため、各社admin(company_admin等)ではなく本部(system_admin)限定と… | hq.js |
| DELETE | `/api/hq/retention/holds/:kind/:id` | 本部 | [api.ts:8396](../src/api.ts#L8396) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| PUT | `/api/hq/retention/holds/:kind/:id` | 本部 | [api.ts:8385](../src/api.ts#L8385) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| GET | `/api/hq/retention/logs` | 本部 | [api.ts:8313](../src/api.ts#L8313) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| POST | `/api/hq/retention/orphan-photos` | 本部 | [api.ts:8406](../src/api.ts#L8406) | R2 に残った、どの勤怠にも紐づかない写真（#533 の残り）。1回に500件ずつ見て、cursor で続きを見る。 dry_run=false のときだけ、そのページの紐づかない写真を消す（消した件数は実行ログに残す） | hq.js |
| GET | `/api/hq/retention/schedule` | 本部 | [api.ts:8304](../src/api.ts#L8304) | 次回削除予定（猶予中・猶予待ち）と、退職日より後にシフトがあるため対象外にしている退職者の一覧。 今の動作モード（RETENTION_ENABLED が 'true' なら実削除、それ以外は dry-run のみ）も返す（#365） | hq.js |
| GET | `/api/hq/retention/settings` | 本部 | [api.ts:8362](../src/api.ts#L8362) | 在職中の保存期間の設定（位置情報と写真・相談・フォロー記録・決着した人材提案。#420 #511 #350） | hq.js |
| PUT | `/api/hq/retention/settings` | 本部 | [api.ts:8365](../src/api.ts#L8365) | 〔見出し〕データ保持（定期削除、system_admin限定） | hq.js |
| GET | `/api/hq/security` | 本部 | [api.ts:1200](../src/api.ts#L1200) | 本部ユーザーの二段階認証の必須・接続元の制限は、本部専用の企業行の設定に持つ | security.js |
| POST | `/api/hq/security/clear-ip` | 本部 | [api.ts:1230](../src/api.ts#L1230) | 企業の接続元の制限を外す（企業側で設定を誤って管理者が誰も入れなくなったときの窓口） | security.js |
| POST | `/api/hq/security/reset-mfa` | 本部 | [api.ts:1213](../src/api.ts#L1213) | 端末を失くした人の二段階認証の解除（会社コード＋ID で指定。会社コードが空欄なら本部ユーザー）。会社管理者が1人で解除できないときの窓口 | security.js |
| PUT | `/api/hq/security/settings` | 本部 | [api.ts:1208](../src/api.ts#L1208) | 〔見出し〕本部（/api/hq/security・/api/hq/login-history） | security.js |
| DELETE | `/api/hq/security/users/:id/sessions` | 本部 | [api.ts:1240](../src/api.ts#L1240) | 〔見出し〕本部（/api/hq/security・/api/hq/login-history） |  |
| GET | `/api/hq/support-requests` | 本部 | [hq-support.ts:349](../src/hq-support.ts#L349) | 〔見出し〕伴走支援の依頼の受付一覧 | hq.js |
| PUT | `/api/hq/support-requests/:id` | 本部 | [hq-support.ts:360](../src/hq-support.ts#L360) | 〔見出し〕伴走支援の依頼の受付一覧 | hq.js |
| GET | `/api/hq/templates` | 本部 | [api.ts:8255](../src/api.ts#L8255) | 企業独自のテンプレートは会社名、どれも使っている案件の数と日報の有無（編集できる範囲の表示に使う。#165）を付ける | hq.js |
| POST | `/api/hq/templates` | 本部 | [api.ts:8263](../src/api.ts#L8263) | 〔見出し〕本部の操作の履歴（#542） | hq.js |
| PUT | `/api/hq/templates/:id` | 本部 | [api.ts:8281](../src/api.ts#L8281) | テンプレートの修正・配信停止（#165）。本部のテンプレートのほか、企業独自のテンプレートも直せる（規則は企業と同じ） | hq.js |
| GET | `/api/hq/view-sessions` | 本部 | [hq-support.ts:452](../src/hq-support.ts#L452) | 企業ごとの許可の状態・自分の閲覧中のもの・最近の閲覧の記録 | hq.js |
| POST | `/api/hq/view-sessions` | 本部 | [hq-support.ts:473](../src/hq-support.ts#L473) | 閲覧の開始。企業が許可しているときだけ。同じ本部ユーザーの閲覧中のものは終える（同時に開けるのは1社だけ） | hq.js |
| GET | `/api/hq/view-sessions/:id/logs` | 本部 | [hq-support.ts:465](../src/hq-support.ts#L465) | 〔見出し〕管理画面の閲覧（読み取り専用） | hq.js |
| DELETE | `/api/hq/view-sessions/current` | 本部 | [hq-support.ts:504](../src/hq-support.ts#L504) | 閲覧の終了（自分の閲覧中のもの） | hq-support.js hq.js |
<!-- END GENERATED: api-endpoints -->

## 本文で参照しているコードの位置

<!-- BEGIN GENERATED: api-refs -->
| 名前 | 位置 |
|---|---|
| `MIDDLEWARE_DEFS` | [scripts/gen-docs.mjs:407](../scripts/gen-docs.mjs#L407) |
| `csvResponse` | [csv.ts:30](../src/csv.ts#L30) |
| `maskPath` | [index.tsx:16](../src/index.tsx#L16) |
| `SESSION_COOKIE` | [lib/auth.ts:9](../src/lib/auth.ts#L9) |
| `sessionCookieOptions` | [lib/auth.ts:150](../src/lib/auth.ts#L150) |
| `csrfGuard` | [lib/csrf.ts:55](../src/lib/csrf.ts#L55) |
| `SESSION_IDLE_HOURS` | [api.ts:806](../src/api.ts#L806) |
| `SESSION_MAX_DAYS` | [api.ts:807](../src/api.ts#L807) |
| `SESSION_HOURS` | [lib/auth.ts:10](../src/lib/auth.ts#L10) |
| `isISODate` | [lib/validate.ts:9](../src/lib/validate.ts#L9) |
| `isHHMM` | [lib/validate.ts:4](../src/lib/validate.ts#L4) |
| `toInt` | [lib/validate.ts:21](../src/lib/validate.ts#L21) |
| `oneOf` | [lib/validate.ts:16](../src/lib/validate.ts#L16) |
| `ownStaff` | [lib/tenant.ts:23](../src/lib/tenant.ts#L23) |
| `hqViewAdminGuard` | [hq-support.ts:202](../src/hq-support.ts#L202) |
<!-- END GENERATED: api-refs -->
