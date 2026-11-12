# 用語集

画面に出る言葉と、テーブル・列・コードの名前の対応です。コードを調べるときは、右の列の名前で `grep` してください。
テーブルの全部の列は [db.md](db.md)、決定の経緯は [decisions.md](decisions.md) を見てください。`ファイル:行` の行番号は、[architecture.md](architecture.md) の冒頭に書いたコミットのものです。

## 1. 会社・人

| 画面の言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| 導入企業・企業・会社 | Field OS を使う人材会社。1社 = 1テナント | `companies`。業務データの表は `company_id` を持つ |
| 会社コード | ログインで入れる、導入企業の識別子 | `companies.company_code` |
| 本部・SaaS本部・システム管理者 | Field OS を運営する側。`/hq` を使う | `users.role = 'system_admin'`。所属は本部専用の企業行 `companies.active_status = 'internal'`（`migrations/0033_account_admin.sql`） |
| 停止（企業） | 本部が企業の利用を止めた状態。ログイン・API・報告用URLが使えなくなる | `companies.active_status = 'inactive'`（`src/lib/auth.ts:98`） |
| 管理者 | 導入企業の社員で、管理画面を使う人 | `users.role` が `company_admin`（会社管理者）・`office_staff`（事務担当）・`sales_manager`（営業管理者）・`field_manager`（現場管理者）。まとめて `ADMIN_ROLES`（`src/api.ts:178`） |
| スタッフ | 導入企業から現場に出る人。スタッフアプリを使う | `users.role = 'staff'` と `staff_profiles` の行 |
| ID・スタッフ番号・ユーザーID | ログインで入れる、会社の中での利用者の識別子 | `users.user_code` |
| ログインなし（名簿のみ） | ログインを持たない人（スタッフマスタだけの行・仮登録） | `users.role = 'roster_only'` |
| 人物・スタッフID（連携用） | 会社をまたいで同じ人を表す。連携に使う恒久のコード | `persons`、`persons.global_staff_code`（`FS` で始まる。`src/roster.ts:268`） |
| クライアント | 案件をくれる会社。こちらが**請求する**相手 | `clients`。担当者は `client_contacts` |
| 協力会社（以前の名前は「取引先」） | Field OS を使っていない会社で、スタッフを出してくれて、こちらが**支払う**相手。クライアントを兼ねるときは1対1でつなぐ | `staff_affiliations`（API のパスは `/api/admin/roster/partners` のまま）。つながりは `staff_affiliations.client_id`（D-15） |
| 開催場所 | クライアントの現場（店舗・催事の会場など） | `sites` |

## 2. スタッフの区分（所属区分）

`staff_profiles.affiliation_type` の値です。表示名は `public/static/admin.js:12`。

| 画面の言葉 | 値 | 意味 |
|---|---|---|
| 自社雇用 | `own_employee` | 自社が雇っている人。基本情報は従業員管理で編集する |
| 自社日雇い | `daily_worker` | 自社が日雇いで雇う人。従業員データは不要 |
| 個人事業主 | `freelance` | 個人で請け負う人 |
| 協力会社所属 | `partner_manual` | 協力会社から出てもらう人（所属は `staff_profiles.partner_affiliation_id`） |
| 他社連携 | `linked_external` | Field OS を使っている別の会社（所属元）から連携で受けた人。基本項目は所属元の行を読む（D-03） |
| スキルシートのみ | `skillsheet_only` | ログインなし。スキルシートを作るためだけの行 |

## 3. スタッフの管理

| 画面の言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| スタッフマスタ | 業務側の情報（氏名・スキル・経歴・稼働できる条件など）。他社と共有し得る | `staff_profiles`（`src/roster.ts`） |
| 従業員管理（以前の名前は「社員名簿」） | 労務側の情報（雇用・給与・口座・保険番号・緊急連絡先など）。自社だけ。会社管理者と事務担当だけが使える | `employee_records`（`src/api.ts:868` の `hrOnly`） |
| 所属元 / 連携先（稼働先） | 連携で、人を出す側の会社 / 受ける側の会社 | 連携先の行の `staff_profiles.owner_company_id`（所属元）・`source_staff_id`（直前の会社の行）・`root_staff_id`（雇用元の行） |
| 連携・企業間連携 | 所属元のスタッフを連携先に登録すること。同意の記録を残す | 連携先に `linked_external` の行と、ユーザーコード `LK-…` のユーザー行を作る（`src/roster.ts:1352`）。同意は `roster_consents` |
| 連携用コード | 連携で受けた人を、さらに次の会社へ連携するときのコード | `staff_profiles.relink_code`（`RL` で始まる） |
| 仮登録 | 氏名と電話番号だけで登録し、すぐシフトに入れられる状態 | `staff_profiles.is_provisional = 1`、ユーザーコード `TMP-…`（`src/staff-lifecycle.ts:63`） |
| 統合 | 仮登録の人などを、既存のスタッフにまとめること。元に戻せない | 統合元は `staff_profiles.merged_into_staff_id`（`src/staff-merge.ts`） |
| 区分変更 | 所属区分を変えること（予約もできる） | `staff_affiliation_history`、予約は cron `affiliation_schedules` |
| 在籍状況 / 退職 | 稼働中・休職・退職など。退職予定日を過ぎると cron で退職に切り替わり、ログインできなくなる | `staff_profiles.employment_status`、`users.retired_at`・`users.status` |
| 企業間チャット | 所属元と連携先の管理者どうしのやり取り。スタッフ本人には見えない | `roster_comments`（`src/roster-chat.ts`） |
| フォロー・相談 | 管理者のフォローの記録 / スタッフからの相談 | `follow_logs` / `consultations` |
| 支払の参考単価 | スタッフマスタの目安の単価。計算には使わない（D-13） | `staff_profiles.reference_pay_unit`・`reference_pay_amount` |

## 4. 案件・シフト

| 画面の言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| 案件 | クライアントから受けた仕事（どの現場に、どういう条件で人を出すか） | `projects` |
| 常勤 / スポット | 案件の区分。常勤 = 決まった人が続けて入る仕事、スポット = その日ごとに人を集める仕事 | `projects.engagement_type` が `regular` / `spot` |
| 枠・募集枠 | ある日・時間・場所で、人を何人入れるかの単位 | `shift_slots`（`src/shift-board.ts`） |
| 役割 | 枠の中の役割ごとの必要人数（例: 「販売」2人・「受付」1人） | `shift_slot_roles.role_name`・`headcount`。シフト側は `shifts.slot_role_id`・`shifts.role` |
| 繰り返し登録 | 曜日 × 期間で枠や常勤のシフトをまとめて作ること | `slot_patterns` |
| シフト | ある人がある日に入る勤務の予定 | `shifts`。**トリガーがあるので、更新した文の `meta.changes` を件数に使わない**（`migrations/0086_followups_a.sql:20`） |
| シフトの状態 | 確定 / 代打（どちらも勤務として扱う）/ 希望（仮）/ 欠勤 | `shifts.status` が `confirmed` / `substitute` / `requested` / `absent`（`src/lib/shift-status.ts`） |
| シフト管理（D 案） | 案件 × 日付の表で枠と割り当てを扱う画面。割り当ては下書きにして「まとめて保存」 | 画面 `public/static/shift-board.js`、API `POST /api/admin/shift-slots/assign-batch`（D-20） |
| 出勤可能日 | スタッフが出せる日を提出したもの。シフトの希望はここに一本化した（D-23） | `staff_availability`・`availability_submissions`（`src/staff-schedule.ts`）。以前のシフト希望は `shift_requests` |
| NG | クライアントが受け入れないスタッフ | `clients.ng_staff_ids` |

## 5. 単価・お金

| 画面の言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| 請求 / 支払 | クライアントへ請求する額 / スタッフ・協力会社へ支払う額。シフトごとに両方を持つ | `shifts.bill_*` / `shifts.pay_*`。`shifts.unit_price` は請求の基本額 |
| 基本単価・標準単価 | 案件の標準の単価 | `projects` の `pay_unit_type`・`pay_rate`・交通費の列など（`migrations/0016_add_spot_shift_board.sql:6`〜`14`） |
| 単価ルール | 開催場所・役割・スタッフ別の単価。精算画面の「単価の設定」で管理する（D-12） | `rate_rules`。インセンティブは `rate_rules.pay_incentive` |
| 単価の引き継ぎ | 新しいシフトに、直近のシフトの単価を使うこと（D-18） | `src/shift-board.ts:203` |
| 日額 / 時給 | 単価の単位 | `bill_unit_type`・`pay_unit_type` が `daily` / `hourly` |
| 支払先 | 自社給与・日雇い給与・個人事業主・協力会社・他社（連携元） | `shifts.payee_type` が `payroll` / `payroll_daily` / `freelance` / `partner` / `linked` |
| 精算・確定 | 実績を確かめて金額を確定すること。確定したシフトは変えられない | `shifts.settle_status` が `planned`（未確定）/ `confirmed`（確定）（`src/settlement.ts`） |
| 請求前確認 | クライアントへの請求の前の確認画面 | 画面 `#billing`、API `GET /api/admin/billing-check` |
| 利用料（本部の請求） | **本部が導入企業に請求する** Field OS の利用料。上の「請求」とは別 | `company_billing_months`・`hq_plan_prices`（cron `billing_close`） |

## 6. 勤怠・日報・報告

| 画面の言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| 勤怠報告 | スタッフが現場で送る報告。8種類（起床・出発・入店・勤務開始・休憩開始・休憩終了・勤務終了・退店） | `attendance_reports.report_type`（`src/report-settings.ts:27`） |
| 入店・退店の写真 | 入店と退店で撮る写真。R2 に保存し、ログインの確認付きで返す | `attendance_reports.photo_key`、R2 の `PHOTOS` |
| 案件報告管理 | 案件・スタッフごとに、どの勤怠報告を求めるかの設定 | `project_report_defaults`・`project_staff_report_settings`（`src/report-settings.ts`） |
| 打刻修正 | 勤怠報告の時刻の修正・打ち漏れの追加の申請と承認 | `attendance_corrections`（`src/corrections.ts`） |
| 日報 | シフトごとの業務の報告。案件の日報テンプレートの項目に答える | `daily_reports`（回答は JSON） |
| 日報テンプレート | 日報の項目の定義。本部が配信する | `report_templates.fields_json`。差し替える前の項目は `projects.past_report_fields_json`（D-28） |
| 報告用URL | ログインのない人が、1つのシフトの勤怠報告と日報だけを送れる URL | `shift_report_tokens`、画面 `/r/:token`（`src/staff-lifecycle.ts`） |
| 代理入力 | 管理者がスタッフの代わりに勤怠を記録すること | `src/staff-lifecycle.ts` |
| 端末時刻 | 電波がない場所で押した報告の、端末の時刻（D-07） | `attendance_reports.time_source = 'device'` |
| 再送 | 押した時刻と受け付けた時刻が1分以上違う打刻の印（混雑・電波で送り直した、端末の時計のずれなど。D-50） | `attendance_reports.time_source IN ('device', 'resent')` |

## 7. 募集・掲示板・お知らせ

| 画面の言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| 募集ページ | 枠を公開の URL と QR で募集するページ（`/apply/:token`）。案件名・クライアント名・金額は出さない | `recruit_pages`（`src/recruit.ts`） |
| 応募 | 募集ページから送られた応募。管理者が承認するとシフトが確定する | `recruit_applications`・`recruit_application_items`。「要確認」は `turnstile_unverified`（D-01） |
| 案件掲示板 | 導入企業どうしが案件を掲載し、問い合わせ・人材の提案をする場所 | `board_posts`・`board_threads`・`board_proposals`（`src/board.ts`） |
| お知らせ | 管理者からスタッフへのお知らせ。既読を記録する | `notices`・`notice_reads` |
| 通知 | アプリ内の通知（ベルのマーク）。プッシュ通知の元にもなる | `user_notifications`、送る順番待ちは `push_queue` |
| 本部からのお知らせ | 本部から導入企業の管理者へのお知らせ | `src/hq-support.ts` |

## 8. 運用

| 言葉 | 意味 | テーブル・列・コード |
|---|---|---|
| 定期処理・cron | 決まった時刻に Worker が動かす処理 | `CRON_JOBS`（`src/index.tsx:829`）、記録は `cron_runs` |
| データ保持・定期削除 | 保存期間を過ぎた個人情報の削除（日報3年・退職後7年など） | `src/services/retention.ts`、記録は `retention_logs` |
| dry-run | 消さずに対象の件数だけを数えること。`RETENTION_ENABLED` が `'true'` 以外のとき | `src/index.tsx:848` |
| 削除の保留 | 本部が、特定のスタッフ・企業のデータの削除を止めること | `staff_profiles.retention_hold_at`・`companies.retention_hold_at` |
| 解約・データ | 解約した企業のデータを書き出して削除する本部の画面 | `company_offboardings`（`src/api.ts:8500`〜） |
| 操作履歴 | シフト・枠・精算の変更の前後の記録 | `operation_logs`（`src/lib/operation-log.ts`） |
| 変更履歴 | 従業員データとスタッフ基本情報の変更の記録 | `employee_change_logs`（`src/lib/change-log.ts`） |
| 本部の操作の履歴 | 本部の書き込みの記録 | `hq_audit_logs` |
| 参照番号 | 予期しないエラーのときに画面に出る8文字。ログの `ref`・`error_logs.ref` と同じ | `newErrorRef()`（`src/lib/error-log.ts:54`）、`app.onError`（`src/index.tsx:63`） |
| Sprint | 修正のまとまりの単位（以前は「波」）。ブランチ名の `w12` などは Sprint の番号 | D-34 |
| 作業単位 | Sprint の中で分けた作業（例: `w13-docs-arch-ops`） | ブランチ `fix/<作業単位>` |

## 9. ID・コードの頭文字

| 頭文字 | 何のコードか | 作る所 |
|---|---|---|
| `FS…` | 人物の恒久のスタッフID（連携に使う） | `src/roster.ts:268` |
| `RL…` | 連携で受けた人を、さらに次の会社へ連携するためのコード | `src/roster.ts:1320` |
| `LK-…` | 連携先に作るユーザー行のユーザーコード（ログインできない） | `src/roster.ts:1352` |
| `TMP-…` | 仮登録のユーザーコード | `src/staff-lifecycle.ts:63` |
| `BD-…` | 案件掲示板の提案から取り込んだ人のユーザーコード | `src/board.ts:909` |
