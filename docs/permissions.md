# 権限の表

- 何の資料か: ロール（`users.role`）ごとに、管理画面・API で何ができるかの一覧です（#9978）。
- 表の本体: [`src/lib/permissions.ts`](../src/lib/permissions.ts) の `PERMISSIONS`。API の確かめ（ミドルウェア・各ハンドラー）と、画面のメニュー・ボタンの出し分けは、すべてこの表を見ます。
- 今の権限は、表を作る前と1つも変えていません（変更前のコードで、すべての API × すべてのロールを実際に呼んで測り、変更後も同じことを `scripts/test-w26-perms.mjs` で確かめています）。
- 11/16 に決める4ロールの役目は、表の行の「許すロール」を足し替えるだけで入ります（手順は 4章）。

## 1. ロール

| `users.role` | 画面での名前 | 入口 |
|---|---|---|
| `company_admin` | 会社管理者 | `/admin` |
| `office_staff` | 事務担当 | `/admin` |
| `field_manager` | 現場管理者 | `/admin` |
| `sales_manager` | 営業管理者 | `/admin` |
| `staff` | スタッフ | `/staff`（スタッフアプリ） |
| `system_admin` | 本部 | `/hq`。企業が許可した閲覧の間は `/admin` を読み取りだけで見られる（そのときのロールは `sales_manager`。`src/hq-support.ts` の `HQ_VIEW_ROLE`） |
| `roster_only` | ログインなし（名簿のみ） | なし（ログインできない） |

- 「4ロール」は `company_admin`・`sales_manager`・`field_manager`・`office_staff` です（`ADMIN_ROLES`）。
- `client_viewer` は最初の DB（`migrations/0001_initial_schema.sql`）のコメントにだけある名前で、使っている行もコードもありません。表には入れていません。

## 2. 表（今の権限）

記号: ○ できる／× できない。表にない操作の名前は、だれにも許しません（書き間違いで通さないように）。

| 操作の名前 | 内容 | 会社管理者 | 事務担当 | 現場管理者 | 営業管理者 | スタッフ | 本部 | 止めている所 |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `admin.access` | 管理画面（/admin）と /api/admin/* を使う | ○ | ○ | ○ | ○ | × | × | api.ts の /admin/* のミドルウェア |
| `staff_app.access` | スタッフアプリの API（/api/staff/*）を使う | × | × | × | × | ○ | × | api.ts の /staff/* のミドルウェア |
| `hq.access` | 本部画面の API（/api/hq/*）を使う | × | × | × | × | × | ○ | api.ts の /hq/* のミドルウェア |
| `roster_chat.use` | 企業間チャット | ○ | ○ | ○ | ○ | × | × | roster-chat.ts のミドルウェア・admin-badges.ts |
| `notification_prefs.edit` | 自分の通知の受け取り設定（管理画面） | ○ | ○ | ○ | ○ | × | × | notifications.ts の PUT /admin/notification-prefs |
| `hr.manage` | 労務情報（従業員管理・入社時書類・休暇の申請・自社雇用の最寄駅の変更の承認・ダッシュボードの労務の知らせ） | ○ | ○ | × | × | × | × | api.ts の /admin/employees のミドルウェア・ダッシュボード・最寄駅、staff-self-service.ts の休暇・入社時書類、admin-menu.ts の従業員管理 |
| `payout.manage` | 振込データ・振込の設定・振込先の口座 | ○ | ○ | × | × | × | × | settlement.ts の /settlement/payout/* |
| `premium_settings.edit` | 割増（深夜・時間外・休日）の設定の変更（見るのは4ロール） | ○ | ○ | × | × | × | × | settlement.ts の PUT /settlement/premium-settings |
| `attendance_settings.edit` | 勤怠の設定（写真の必須・写真なしの許可・遅刻の猶予・打刻修正の期限・緊急連絡先と位置ずれ・案件ごとの写真の必須） | ○ | × | ○ | × | × | × | api.ts の /admin/settings/photo-required・photo-skip・lateness・site-contact・/admin/projects/:id/photo-required、corrections.ts の /admin/settings/corrections |
| `admin_users.manage` | 管理者アカウント（追加・ロールの変更・停止・パスワードの再発行） | ○ | × | × | × | × | × | accounts.ts の /admin/users のミドルウェア |
| `security.manage` | セキュリティの設定・管理者の二段階認証・ログインの履歴（スタッフ詳細のログインの履歴も） | ○ | × | × | × | × | × | api.ts の /admin/security/settings・/admin/security/users・/admin/login-history のミドルウェア、/admin/staff/:id/sessions の履歴（応答の一部） |
| `roster_export.pay` | 従業員名簿の CSV に口座・給与を含める | ○ | × | × | × | × | × | api.ts の従業員名簿の CSV（include_pay） |
| `closing.reopen` | 締めの解除 | ○ | × | × | × | × | × | settlement.ts の締めの解除 |
| `settings.staff_view` | スタッフアプリの表示の設定 | ○ | × | × | × | × | × | api.ts の PUT /admin/settings/staff-view |
| `settings.shift_notify` | シフトの通知の既定 | ○ | × | × | × | × | × | api.ts の PUT /admin/settings/shift-notify |
| `settings.mail_contact` | メールの問い合わせ先 | ○ | × | × | × | × | × | notifications.ts の PUT /admin/settings/mail-contact |
| `settings.reminders` | リマインドの設定 | ○ | × | × | × | × | × | notifications.ts の PUT /admin/settings/reminders |
| `mail_suppression.release` | メールの送信の停止の解除 | ○ | × | × | × | × | × | notifications.ts の POST /admin/email-suppressions/release |
| `roster.required_fields` | スタッフ名簿の必須項目の設定 | ○ | × | × | × | × | × | roster.ts の PUT /admin/roster/field-settings |
| `hq_view.allow` | 本部の閲覧の許可 | ○ | × | × | × | × | × | hq-support.ts の PUT /admin/hq-access |
| `staff_pay.visible_setting` | スタッフへの支払額の表示の設定 | ○ | × | × | × | × | × | staff-pay.ts の PUT /admin/staff-pay/settings |
| `admin_push.device` | 管理画面の端末のプッシュ通知の登録（画面だけ。API は4ロール） | ○ | × | × | × | × | × | public/static/notifications.js の通知の受け取り設定 |
| `tour.setup` | はじめにやること・操作ガイドの初期設定の案内 | ○ | × | × | × | × | × | tours.ts の案内、public/static/tour.js |

- 表にない管理画面の操作（シフト・日報・打刻修正・案件・クライアント・単価・スタッフマスタ・精算の確定と締め・CSV・統合など）は、`admin.access` を持つ4ロールのだれでもできます（今のまま）。
- 「見るだけ」の画面（勤怠の設定・割増・会社の設定など）は、GET の応答の `can_edit` などの印を、同じ操作の名前で決めています。

## 3. どう使っているか

| 場所 | 使い方 |
|---|---|
| API のミドルウェア | `requirePerm('操作の名前', 文言, code)`（`/admin/*`・`/staff/*`・`/hq/*`・`/admin/employees`・`/admin/security/*`・`/admin/users`） |
| API のハンドラー | `can(u, '操作の名前')`。403 の文言・code は表を作る前のまま |
| 画面に渡す一覧 | `GET /api/auth/me` の `permissions`（`permissionsFor(role)`。表の順）。本部の閲覧中は閲覧用のロール（`sales_manager`）の一覧 |
| 画面のメニュー | `src/admin-menu.ts` の項目の `perm`（従業員管理は `hr.manage`） |
| 画面のボタン | `public/static/common.js` の `hasPerm('操作の名前')`（`ME.permissions` を見る）。admin.js・settlement.js・security.js・notifications.js・roster.js・tour.js |
| 通知の宛先 | 会社の管理者は `ADMIN_ROLES`、労務の通知（休暇の申請・入社時書類の期限）は `rolesFor('hr.manage')` |

### 表の外に残しているもの（権限ではないもの）

- 通知メールを受け取るかの既定（打刻修正の承認依頼は会社管理者・現場管理者、書類の期限は会社管理者・事務担当。`src/notifications.ts` の `defaultEmail`）。受け取り設定で各自が変えられる既定で、できること・できないことではありません。
- 最後の会社管理者を外さない確かめ（`src/accounts.ts`）・管理者を作るときに選べるロール（4ロール）。
- SQL の中の4ロールの一覧（`role IN ('company_admin', …)`）。ロールの数・名前は変えない方針（案 B も4つのまま）なので、そのままにしています。ロールを足すときは `grep -rn "'office_staff'" src` で探して直します。
- 本部の閲覧のロール（`HQ_VIEW_ROLE = 'sales_manager'`）。営業管理者の行を絞ると、本部の閲覧で見られる範囲も一緒に狭くなります（11/16 の論点 12）。

### 画面だけで、API では止めていない所（今のまま）

- `admin_push.device`: 管理画面の端末のプッシュ通知の登録は、画面では会社管理者だけに出しますが、`/api/admin/push/*` は4ロールが使えます（ログインの失敗の知らせを会社管理者に届けるための画面）。
- `tour.setup`: 案内の表示だけです。

## 4. ロールの役目を変えるとき（11/16 の4ロールなど）

1. `src/lib/permissions.ts` の `PERMISSIONS` の行の `roles` を足し替える。新しい操作を分けるときは行を足し、その操作の API の所で `can(u, '名前')` か `requirePerm('名前', …)` を呼ぶ。画面のボタンは `hasPerm('名前')`、メニューは `src/admin-menu.ts` の `perm`。
2. この資料の 2章の表を直す。
3. 変更前の DB で `scripts/test-w26-perms.mjs` を流し、変わった所（FAIL に出る API とロール）が意図したものだけかを確かめる。
4. 意図どおりなら `RECORD=1` で実測の表（`scripts/w26-perms-baseline.json`）を書き直して、一緒にコミットする。

## 5. 実測の表と、変更前後の突き合わせ

- 測り方: `src/api.ts` の Hono のルートの一覧（esbuild で読む。`scripts/gen-docs.mjs` と同じ）のすべてを、ログインなし・スタッフ・4ロール・本部・本部の閲覧の8つで呼びます。GET はシードにある ID、書き込みはない ID と空の本文（`{}`）で呼びます。自分のセッション・二段階認証・本部の閲覧を終える 10 本は呼びません。
- 比べるもの: 止められたか（401・403 と `code`）、応答の `can_*` の値、ロールで違う項目（あるロールにだけある項目・あるロールにだけ空の配列）。画面は `/`・`/admin`・`/staff`・`/hq` の行き先と、管理画面の左のメニュー・スマホのメニューの項目。`/api/auth/me` の `role`・`can_manage_hr`。
- 結果は `scripts/w26-perms-baseline.json`（変更前のコードで測ったもの）。流し方は `scripts/test-w26-perms.mjs` の先頭のコメントにあります。
