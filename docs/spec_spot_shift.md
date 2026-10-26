# 常勤・スポット案件のシフト管理 / 単価（請求・支払）/ 所属区分の移行 仕様

最終更新: 2026-09-29

## 0. 背景と方針
- これまでは週5日稼働の「常勤案件」を前提にした作り（シフト = スタッフ × 案件 × 日付の1件ずつ登録）
- スポット案件（イベント・週末のみ・ピンポイント日程）では、1度しか入らないスタッフの登録と、複数案件をまたぐシフト管理が負担になっている
- 方針
  - **基本は管理者がシフトを組む**。募集（公開の応募フォーム）は補助機能として追加し、応募はすべて承認制とする
  - 常勤とスポットを **同じシフトボード** で扱う。今の常勤の登録方法とデータはそのまま使えるようにする
  - 請求（クライアントへの請求）と支払（スタッフ・協力会社への支払）を **シフトごとに分けて記録** する
  - 金額（請求・支払・粗利）は **管理画面のみ** で表示する。スタッフ画面のAPIは金額の列を返さない
    - 例外（12章）: 会社設定『スタッフに支払額を表示する』（既定 OFF）を ON にした会社では、支払先が本人のシフトの **支払側の金額だけ** を本人に返す（請求額・粗利・協力会社や他社への支払は返さない）
  - 所属区分（自社雇用 / 日雇い / 個人事業主 / 協力会社所属 / 他社連携）は **双方向に移行** できる。スタッフIDは変えずに区分の履歴を記録する

## 1. 段階計画
| 段階 | 内容 |
|---|---|
| 第1段階（実装済み） | 案件区分（常勤/スポット）、開催場所（現場マスタの土台）、募集枠と役割、単価ルール（請求/支払/交通費）、シフトへの金額記録、繰り返し登録、常勤の一括登録・前週コピー、シフトボード（複数案件の比較・ドラッグ・充足・重複警告・金額合計） |
| 第2段階（実装済み） | 区分の新設（自社日雇い・個人事業主）、仮登録、区分変更の手順と履歴（適用日以降の予定シフトの単価・支払先の置き換え）、雇用終了と退職の分離、勤怠・日報の提出設定（案件→スタッフ→シフト）、シフト専用の報告URL（コピーして送付）、代理入力 |
| 第3段階（実装済み） | 実績の確定（入店・退店報告から実働時間を反映）、請求・支払の集計（クライアント別 / 支払先別、月ごと・任意の期間）、CSV出力 |
| 第4段階（実装済み） | 公開の募集ページ（URL・QR、Turnstile、送信回数の制限）、承認による確定と仮登録の自動作成、既存スタッフの希望日提出 |
| 第5段階（本PR） | 仮登録スタッフと連携スタッフの統合（シフト・勤怠・評価の引き継ぎ） |

## 2. 第1段階 データモデル（migrations/0016_add_spot_shift_board.sql）

### 2.1 projects（列を追加）
| 列 | 内容 |
|---|---|
| engagement_type | `regular`（常勤）/ `spot`（スポット）。既定は regular |
| （既存）unit_price_type / unit_price | 案件の **請求** の標準単価（日額 `daily` / 時給 `hourly`。それ以外の値は日額として扱う） |
| pay_unit_type / pay_rate | 案件の **支払** の標準単価（未設定なら「支払単価未設定」として警告） |
| bill_transport_type / bill_transport_amount | 交通費の請求: `actual`（実費）/ `fixed`（定額）/ `included`（単価に込み＝請求なし） |
| pay_transport_type / pay_transport_amount | 交通費の支払: `actual`（実費）/ `capped`（実費・上限あり）/ `fixed`（定額）/ `none`（支払なし） |
| default_break_minutes | 時給計算で差し引く休憩（分） |
| price_valid_from | 今の標準単価（請求・支払・交通費）を使う最初の稼働日（NULL = すべての期間。0045）。それより前の稼働日は `project_price_history` の単価を使う |

### 2.2 sites（開催場所。今後作成する現場マスタの土台）
`site_id, company_id, client_id, site_name, address, lat, lng, memo, status(active/inactive)`
- クライアントに紐づけて管理する（クライアント詳細から登録）。今後の現場マスタは本テーブルを拡張する

### 2.3 rate_rules（単価ルール）
条件（`project_id` / `site_id` / `role_name` / `staff_id`。NULL は「すべて」）と、上書きしたい値（NULLは上書きしない）を持つ。
値: `bill_unit_type, bill_rate, pay_unit_type, pay_rate, bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount`
- **項目ごとに**、条件に合うルールのうち最も具体的なものを採用する
  - 具体度: スタッフ指定 8 ＞ 役割指定 4 ＞ 開催場所指定 2 ＞ 案件指定 1（合計点が高いほど優先。同点なら新しいルール）
- 適用期間 `valid_from / valid_to`（0045。NULL は期限なし）。シフトの稼働日が期間に含まれるルールだけを使う。単価を改定するときは、旧ルールに終了日を付けて残し、新しいルールに開始日を入れる（単価ルールの一覧の「終了日」）
- 役割は役割名で照合する。枠のシフトは枠の役割（`slot_role_id`）の名前で照合し、役割名を変えたときに「今の単価ルールのまま」を選んだ役割は変更前の名前（`shift_slot_roles.rate_role_name`）で照合する
- 単価・交通費の金額は0以上（負の値は 400）。単位を省略した単価は日額
- 例
  - 案件Aの役割「リーダー」: 請求 22,000 / 支払 15,000
  - 案件Aの開催場所「△△モール」: 交通費の請求を定額 1,000
  - スタッフXの全案件: 支払 13,000（経験者加算。案件指定なし）

### 2.4 募集枠
- `shift_slots`: `slot_id, company_id, project_id, site_id, location, work_date, start_time, end_time, break_minutes, pattern_id, memo, status`
- `shift_slot_roles`: `slot_role_id, slot_id, role_name, headcount, bill_unit_type, bill_rate, pay_unit_type, pay_rate, rate_role_name`（単価列は枠でだけ変える場合に使う）
  - 枠の単価には必ず単位（日額・時給）を付ける。画面で選び、単位のない単価は日額として保存する（0045 で、既存の単位のない単価には、それまで使われていた単位を補った）
  - 役割名を変えるとき、変更前・変更後の名前の単価ルールがあれば確認する（PUT の `role_rate`: `follow` = 新しい名前のルールに切り替える / `keep` = 今のルールのまま。`keep` のときは `rate_role_name` に変更前の名前を残す）。確定済みのシフトの役割名は変えない
- `slot_patterns`（繰り返し）: `project_id, site_id, weekdays('0,6' 等), date_from, date_to, start_time, end_time, break_minutes, roles_json`
  - 登録すると期間内の該当曜日に枠をまとめて作る。個別の枠は後から変更・削除できる（例外日）
  - パターンを削除するときは「割り当てのない今後の枠」も削除できる

### 2.5 shifts（列を追加。既存の列の意味は変えない）
| 列 | 内容 |
|---|---|
| slot_id / slot_role_id / site_id | 枠・役割・開催場所（常勤の従来登録では NULL のまま） |
| break_minutes | 休憩（分） |
| （既存）unit_price | **請求の基本額**（= 請求単価 × 数量）。既存の集計（売上概算・請求前確認）はこの列を使い続ける |
| bill_unit_type / bill_rate / bill_qty | 請求の単位・単価・数量（日額は1、時給は時間） |
| pay_unit_type / pay_rate / pay_qty / pay_amount | 支払の単位・単価・数量・基本額 |
| （既存）transportation_fee | **交通費の実費**（これまでどおり実費の記録） |
| bill_transport_type / bill_transport_amount / pay_transport_type / pay_transport_amount | 割り当て時点の交通費ルール。請求・支払の交通費は実費とルールから計算する |
| bill_adjust / pay_adjust / adjust_note | 調整（残業・手当・値引き・控除など） |
| payee_type / payee_affiliation_id / payee_company_id | 支払先の種類（`payroll` 自社給与 / `partner` 協力会社 / `linked` 他社連携元 など）。第2段階の区分変更で置き換える |
| price_locked / price_source | 手動で金額を変更したシフトは 1（ルール再適用の対象外）。price_source は採用したルールの説明 |
| qty_locked | 時給の数量を手動で固定したシフトは 1（0045）。0 なら単価だけを固定し、時給の数量は実働に合わせる。NULL は従来の行（price_locked なら数量も固定） |

**単価の優先順位**（上ほど優先）: シフトの手動変更 ＞ 枠の役割の単価 ＞ 単価ルール（具体度順）＞ 案件の標準 ＞ 未設定
- 単価ルールと案件の標準単価は、シフトの稼働日に適用期間が含まれるものを使う。単価を改定した後に、改定前の稼働日のシフトを計算し直しても（枠の変更・区分変更・再適用など）、改定前の単価のまま
- 案件の標準単価は「区分・標準単価」で適用開始日を付けて変えられる。付けると、今の単価を前日までの単価として `project_price_history` に残す。付けずに変えると、今の単価の適用期間の単価を直す
- 金額の手動変更（PUT /shifts/:id/price）: 単価・単位・数量・交通費のルールを変えたときだけ手動変更（price_locked）にする。交通費の実費・調整・休憩だけを直したときは、単価ルールの対象のまま。数量は空欄なら計算時間を使い、計算と違う値を入れたときだけ固定する（qty_locked）
- 範囲: 単価・交通費は0以上、休憩は0〜600分、数量は0〜24、時刻は 00:00〜23:59。調整額は控除に使うため負の値も認める
- 割り当てた時点の金額をシフトに記録する。単価表を変えても確定済みのシフトは変わらない（「単価ルールを再適用」で置き換えられる）
- 時給の数量: 第1段階では予定時間 −休憩。第3段階で入店・退店報告の実働時間に置き換える
- 交通費: 請求 = 実費 / 定額 / 0（単価込み）、支払 = 実費 / min(実費, 上限) / 定額 / 0

## 3. 第1段階 API（`/api/admin/*`。管理ロールのみ。src/shift-board.ts）
| メソッド | パス | 内容 |
|---|---|---|
| GET | /admin/shift-board?from&to&client_id&project_ids&site_id | 最大31日。枠・役割・割り当て・枠なしのシフト・重複警告・合計（請求/支払/粗利/充足） |
| GET | /admin/shift-board/candidates?slot_role_id= | 候補スタッフ（同時間帯の空き / 案件経験回数 / スキル一致 / NG / 他社シフトあり） |
| POST | /admin/shift-slots | 枠の作成（複数日をまとめて指定可） |
| PUT / DELETE | /admin/shift-slots/:id | 枠の変更（時間の変更は割り当て済みシフトにも反映）/ 削除（割り当てがある場合は force 指定が必要） |
| POST | /admin/shift-slots/roles/:id/assign | 役割にスタッフを割り当てる（複数可。重複・NGは警告を返し、force で登録） |
| POST | /admin/shifts/:id/move | 別の枠・役割へ移動（案件が変われば単価を再計算） |
| PUT | /admin/shifts/:id/price | 金額の手動変更（price_locked=1）/ ルールに戻す |
| POST | /admin/shifts/reprice | 期間・案件を指定して単価ルールを再適用（手動変更したものは除く）。`dry_run` は件数と、金額・支払先が変わるシフトの一覧（先頭200件）・請求と支払の増減の合計を返す（日付順に3000件まで計算し、超えたら `truncated`） |
| POST | /admin/shifts/bulk | 常勤の一括登録（スタッフ × 曜日 × 期間） |
| POST | /admin/shifts/copy-week | 前週のコピー（枠と割り当て） |
| GET/POST/DELETE | /admin/slot-patterns | 繰り返し登録 |
| GET/POST/PUT/DELETE | /admin/sites | 開催場所 |
| GET/POST/PUT/DELETE | /admin/rate-rules, GET /admin/rate-rules/resolve | 単価ルールと適用結果のプレビュー |
| PUT | /admin/projects/:id/pricing | 案件区分・標準単価・交通費ルール・時間の数え方・丸め（`pay_time_round`）・適用開始日（`price_valid_from`） |
| GET | /admin/projects/:id/price-history | 標準単価の適用開始日と、改定前の単価 |

- スタッフ向け（`/api/staff/home`, `/api/staff/shifts`）は金額の列を取り除いて返す

## 4. 第1段階 画面
- **シフトボード**（`#shifts`）: 行 = 案件 / 開催場所 / 役割 / 時間、列 = 日付（1週・2週・1か月）
  - クライアント・案件（複数選択）・開催場所で絞り込み。「不足のみ」表示
  - セルに「確定/必要」の充足（不足は赤）と割り当てたスタッフを表示。スタッフ名をドラッグして別の枠へ移動
  - 右側パネルから候補スタッフをドラッグして割り当て。枠をクリックすると候補一覧（空き・経験・スキル・NG）
  - 重複（同時間帯の別案件・別企業のシフト）と NG スタッフを警告
  - 「人ごと」表示に切り替え（行 = スタッフ、週の稼働日数）
  - 上部に表示範囲の請求合計・支払合計・粗利
  - 従来の週表示は「週表示（従来）」から開ける
- **案件詳細**: 区分（常勤/スポット）、標準単価（請求・支払）、交通費ルール、単価ルール一覧（開催場所・役割・スタッフ別）、繰り返し登録の一覧
- **クライアント詳細**: 開催場所の一覧と登録
- **スタッフ詳細**: スタッフ別の単価ルール

## 5. 第2段階以降の要点（確定事項）
- 区分の移行: スタッフIDは変えず、`staff_affiliation_history`（区分・適用日）で履歴を持つ。適用日以降の予定シフトの単価・支払先は確認画面で件数を示したうえで自動で置き換える
  - 他社連携 → 自社雇用: 連携を終了し、基本情報をコピーして自社で管理する（元の企業への通知はしない）
  - 自社雇用 → 日雇い・個人事業主など: 従業員管理のデータは「雇用終了」として保持し、雇用終了日から7年で定期削除する（従業員データ（給与・口座・保険番号・緊急連絡先など）と入社時書類・R2 のファイル。自社雇用に戻した人は対象外。削除の保留中は消さない。w5-retention-c #425）
- 請求・支払: 大多数は1稼働ごとの日額。実働時間で計算する案件もある（第3段階で実働時間を反映）
- 支払データ: 将来は給与ソフトと連携する。まずは CSV 出力と、月ごと・任意の期間の一覧
- 報告用URL: 管理者が画面からコピーして送る（SMS の自動送信は行わない）
- 募集: すべて管理者の承認が必要。基本は管理者がシフトを組み、募集は補助機能
- 枠の規模: 1枠 1〜10名以上（平均3〜4名）、表示期間は最大1か月

## 6. 第2段階 データモデル（migrations/0017_add_staff_lifecycle_and_report_settings.sql）
- `staff_profiles.affiliation_type` に `daily_worker`（自社日雇い）・`freelance`（個人事業主）を追加（列の追加はなく、値の追加のみ）
- `staff_profiles.is_provisional`（仮登録）、`attendance_mode`・`daily_report_mode`（スタッフ別の提出設定。NULL = 案件に従う）
- `projects.attendance_mode`（既定 `full`）・`daily_report_mode`（既定 `required`）
- `shifts.attendance_mode`・`daily_report_mode`（シフト別の上書き。NULL = スタッフ → 案件の順に従う）
- `attendance_reports.entry_method`（`app` / `link` / `proxy`）・`entered_by`、`daily_reports.entry_method`
- `employee_records.employment_ended_at`・`ended_reason`（雇用終了。退職 `users.retired_at` とは別に持つ）
- `staff_affiliation_history`（区分変更の履歴: 変更前後の区分・所属、適用日、置き換えたシフト数、メモ、変更者）
- `shift_report_tokens`（シフト専用の報告URL。勤務日の翌日 23:59:59 まで有効、取り消し可能）

### 6.1 提出設定
| 値 | 勤怠 attendance_mode | 日報 daily_report_mode |
|---|---|---|
| none | 報告なし | 提出なし |
| in_out | 入店・退店のみ | — |
| full | 出発・入店・休憩・退店など従来どおり | — |
| required | — | 提出必須 |
- 優先順位: シフト ＞ スタッフ ＞ 案件（案件の既定は full / required）
- スタッフ画面・報告URL・ダッシュボードの未報告一覧は、不要な報告を表示・受け付けしない

### 6.2 支払先（payee_type）
| 区分 | payee_type |
|---|---|
| own_employee | payroll |
| daily_worker | payroll_daily |
| freelance | freelance |
| partner_manual | partner |
| linked_external | linked |

## 7. 第2段階 API（`/api/admin/*`。src/staff-lifecycle.ts）
- `GET /staff-lookup?phone=` 電話番号で既存スタッフを検索
- `POST /staff-quick` 仮登録（氏名・電話・区分のみ）。電話番号が重複すると 409（`need_force` で確認後に登録）。ログインは発行しない
- `POST /staff/:id/finalize` 仮登録の本登録（性別は必須、ログインの発行は任意）
- `POST /staff/:id/affiliation-change` 区分変更。`dry_run: true` で影響（置き換えるシフト数・従業員データの扱い）を返す
  - 適用日以降の未報告のシフトは単価を再計算する。手動で金額を変えたシフト（price_locked）は支払先だけ置き換える
  - 他社連携 → 他の区分: 基本情報をコピーして連携を解除（元の企業への通知なし）
  - 自社雇用へ: 従業員データを作成（雇用終了済みなら再開）
  - 自社雇用から: 従業員データに雇用終了日（適用日の前日）を記録し、閲覧のみで保持（雇用終了日から7年で定期削除。過去の雇用期間も終了日から7年で削除）
- `GET /staff/:id/lifecycle` 区分・履歴・提出設定
- `PUT /staff/:id/report-settings`、`PUT /projects/:id/report-settings`、`PUT /shifts/:id/report-settings`
- `GET /shifts/:id/report-status` 提出状況
- `POST /shifts/:id/proxy-attendance`、`DELETE /shifts/:id/proxy-attendance/:type` 管理者の代理入力（代理入力した分のみ削除可）
- `POST /shifts/:id/report-link`（`regenerate` で再発行）、`DELETE /shifts/:id/report-link` 報告URLの発行・取り消し
- ログインのない人（`users.role` が `staff` でない人）向け（w5-nologin-features。migrations/0072_nologin_features.sql）
  - `GET /report-links/bulk?date=&project_id=`、`POST /report-links/bulk`（`date`・`project_id`・任意で `shift_ids`） その日のログインのない人の勤務のシフト（確定・代打）と報告用URLの状態（未発行・発行済み・未使用・最終アクセス）。POST は未発行の分だけをまとめて発行する（発行済みのURLは変えない。#275）
  - `GET /proxy-attendance/bulk?date=&project_id=`、`POST /proxy-attendance/bulk`（`scope`: `start` = 入店・勤務開始だけ / `all` = 予定どおり全部、`items`: `[{ shift_id, start?, end? }]`。1回 50 件まで） 予定どおりのまとめての代理入力（#508）。時刻は予定から決める（入店・勤務開始 = 開始、勤務終了・退店 = 終了、休憩 = 予定の休憩）。`start`・`end` で人ごとに直せる。1件の代理入力と同じ確認をし、まだ先の時刻・報告済み・予定から決められない報告（起床・出発）は記録しない。記録できないシフトは理由を付けて返す。ログインのある人には、1件の代理入力と同じくアプリ内で知らせる
  - `POST /shifts/:id/proxy-daily-report` 日報の代理入力（#276。`daily_reports.entry_method = 'proxy'`、`entered_by` = 記録した管理者）。本人が提出した日報は `overwrite: true` のときだけ上書きする。本人が出し直したら `entered_by` は空に戻る
  - `POST /staff/:id/schedule-link`、`DELETE /staff/:id/schedule-link` 予定確認URL（#442。スタッフ単位）の発行（発行し直すと前のURLは使えない）・無効化。URL は発行の応答でだけ返す（`staff_schedule_tokens` にはハッシュだけを保存）。有効期限は90日。ログインのある人・退職・停止・統合済みの人には発行しない

### 7.1 公開の報告URL（ログイン不要。`/r/:token`、API は `/api/public/report/:token`）
- `GET` 名（名字なし）・案件・シフトの時間・提出設定・提出状況・日報テンプレートを返す。金額は返さない
- `POST /attendance` 提出設定・順序・重複・勤務日（退店は翌日も可）・写真の必須を確認して記録（entry_method = link）
- `POST /daily-report` 日報の登録・更新
- `POST /consultation` 遅刻・欠勤・体調不良・現場のトラブル・その他の連絡（#163。`kind`: late / absent / health / trouble / other、`body`）。相談（`consultations`、`entry_method = 'link'`）にそのシフトの案件・日付を付けて登録する。同じ内容の2分以内の再送は 409、URL からの連絡は1人24時間に5件まで
- `GET` は本人あての重要・緊急のお知らせ（直近30日・5件まで。全員・案件・個人あて。既読は記録しない。#281）と、会社の問い合わせ先の電話番号（`settings_json.mail_contact_phone`）も返す
- 無効・期限切れのURLは 404。発行されたことのあるURLなら、会社名と電話番号を添える（#163）
- 予定確認URL（#442）も同じ `/r/:token`・`/api/public/report/:token` で開く（シフトのトークンに当たらなければ予定確認URLとして探す）。`GET` は `kind: 'schedule'` で、前日〜14日先の確定・代打のシフト（日時・案件・場所・役割。金額なし）と、前日〜翌日のシフトの報告用URL（なければ発行する）・お知らせ・電話番号を返す。`POST /consultation` は `shift_id`（本人のシフト）を任意で付けられる。退職（退職日の翌日から）・停止・統合・企業の停止で使えなくなる
- ページは noindex・no-referrer。URL は管理者がコピーして送る

## 8. 第2段階 画面
- スタッフマスタ: 一覧に「仮」バッジ・仮登録ボタン・仮登録の絞り込み。詳細に「区分・登録状態」（履歴・本登録・区分変更）と「勤怠・日報の提出設定」
- 日雇い・個人事業主はスタッフマスタで基本情報を編集できる
- シフトボード: 候補一覧から仮登録してそのまま割り当て。シフト詳細に提出状況・提出設定・報告URL・代理入力。案件パネルに提出設定
- シフト詳細の報告パネル: 日報の代理入力（テンプレートの項目で入力）。ログインのない人のシフトでは「この日のログインのない人をまとめて」から、報告用URLのまとめての発行（案内文の1人ずつ・全員分のコピー、SMS）と、予定どおりのまとめての代理入力を開く（`openNologinBulk(日付, 案件ID, 'links' | 'proxy')`。ほかの画面からも呼べる）
- スタッフ詳細の「区分・登録状態」: ログインのない人に予定確認URLの発行・発行し直し・無効化
- 報告用ページ（report-link.js）: 会社からの重要なお知らせ、遅刻・欠勤・トラブルの連絡（フォームと電話）、無効なURLの画面の会社名と電話番号。予定確認URLでは、日ごとのシフトの一覧と、前日〜翌日のシフトの報告画面への入口
- 従業員管理: 雇用終了した従業員を別の一覧に表示し、詳細は閲覧のみ

## 9. 第3段階 実績の確定・請求/支払の集計・CSV（migrations/0018_add_settlement.sql, src/settlement.ts）
### 9.1 データ
- `shifts.actual_start / actual_end / actual_break_minutes / actual_source(report|manual) / actual_note`
- `shifts.settle_status(planned|confirmed) / settled_at / settled_by`
- `projects.hours_basis`（clipped: 実績・予定の範囲内〈既定〉/ actual: 実績どおり / scheduled: 予定どおり）、`projects.time_round_minutes`（開始は切り上げ・終了は切り捨て）
- `projects.pay_time_round`（0045）: `none` = 支払は丸めない（1分単位。既定）/ `same` = 支払も請求と同じく丸める。丸めは請求の数量に使い、支払の数量は `none` なら丸めない時間を使う（自社給与・日雇い給与の労働時間を日ごとに切り捨てないため）。0045 の時点で丸めを設定していた案件は、金額が黙って変わらないよう `same` にした（画面で `none` に変えられる）

### 9.2 実働時間の反映
- 入店・退店の報告（アプリ・報告URL・代理入力・代理入力の削除）のたびに実績へ反映する。両方そろったときだけ反映
- 管理者の手入力（manual）は報告で上書きしない。「報告の時刻に戻す」で解除
- 金額: 単価ルールは再適用しない（記録済みの単価のまま）。時給のものだけ数量を計算時間に合わせる。日額は変わらない。手動で数量を固定したシフト（qty_locked。従来の手動変更を含む）は数量も変えず「確認」に表示する。単価だけを手動で変えたシフトは、数量を計算時間に合わせる
- 実績は時刻だけを記録しているため、実績の開始は予定の開始に最も近い日（前日・当日・翌日）の時刻とみなす。0時台に始まる予定で前日の23時台に入店した場合は前日、日をまたぐ予定で0時を過ぎてから入店した場合は翌日になる

### 9.3 確定
- 今日までのシフトのみ確定できる。確認事項（入店/退店報告なし・実績未入力・予定と0.5h以上の差・単価未設定・手動変更の数量差）がある場合は確認のうえ確定
- 確定済みのシフトは、時間・状態・スタッフ・金額・実績の変更、移動、削除、単価ルールの再適用、区分変更による置き換え、代理入力の取り消しの対象外（メモは変更可）。取り消すと再び変更できる
- 勤怠・日報の報告があるシフトは削除できない（欠勤などに変更する）

### 9.4 API（/api/admin/*）
| メソッド | パス | 内容 |
|---|---|---|
| GET | /settlement?from&to&client_id&project_id&staff_id&payee_type&settle&issues_only | 明細・合計・クライアント別・支払先別（最大93日） |
| POST | /settlement/sync-actuals | 期間の入店・退店報告を実績へ反映 |
| PUT | /shifts/:id/actual | 実績の手入力 / `reset` で報告の時刻に戻す |
| POST | /settlement/confirm | 確定（`shift_ids` または絞り込み条件。`dry_run` / `force`） |
| POST | /settlement/unconfirm | 確定の取り消し |
| GET | /settlement/export?kind=detail\|billing\|payment | CSV（UTF-8 BOM付き。数式の実行を防ぐ処理あり） |

- 支払先別: 自社給与・日雇い給与はスタッフごと、個人事業主は本人、協力会社・他社連携はその会社ごと
- 画面: サイドメニュー「精算（請求・支払）」（`#settlement`）。案件の「区分・標準単価」に時間の数え方と丸めを追加

## 10. 第4段階 募集ページ・応募・承認（migrations/0019_add_recruitment.sql, src/recruit.ts）
### 10.1 データ
- `recruit_pages`: 公開URLのトークン（推測できない乱数）、タイトル・仕事内容・給与の表示文言・問い合わせ先、対象の案件（複数）、期間（最大62日）、残り人数の表示、スタッフアプリからの応募の可否、状態（open / closed）
- `recruit_applications`: 応募者（氏名・フリガナ・電話・メール・メモ）、経路（public / staff）、紐づくスタッフ、状態（pending / done / cancelled）、送信回数の制限用のIPハッシュ
- `recruit_application_items`: 応募した枠（役割）ごとの状態（pending / approved / rejected / cancelled）と、承認で作成したシフト

### 10.2 公開ページ（/apply/:token、API /api/public/recruit/:token。ログイン不要）
- 対象案件の募集枠（今日以降・期間内・枠が open）を、日時・開催場所・役割・残り人数だけで表示する。**案件名・クライアント名・金額は表示しない**（給与は管理者が入力した文言のみ）
- 定員に達した枠も「キャンセル待ち」として応募できる（承認時に定員超過を警告）
- 機械的な送信の対策: 見えない入力欄、表示から3秒未満の送信は保存しない、同じ接続元から1時間に5件まで、同じ電話番号から1日に3件まで（ページごと）、Cloudflare Turnstile（`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` を設定した場合のみ）
- 同じ電話番号で同じ枠への重複応募はまとめる。個人情報の取り扱いへの同意が必須
- ページは noindex・no-referrer

### 10.3 承認（管理画面 #募集・応募）
- 日時ごとに承認・見送りを選ぶ。承認するとシフトを「確定」で作成し、単価ルールを適用する（メモ「募集から承認」）
- 未登録の応募者: 電話番号が一致するスタッフがいれば紐づけを提案する。紐づけない場合は **仮登録を作成**（区分を選択。ログインは発行しない）
- 警告（確認のうえ承認できる）: 定員超過、過去の日付、同じ時間帯の別のシフト（他社を含む）、同時に承認する日時どうしの重複、NGスタッフ
- 仮登録は警告の確認後に作成する（警告で止めた場合に仮登録だけが残らないように）
- シフトボードの役割に未対応の応募数を表示する

### 10.4 既存スタッフの応募（スタッフアプリ「シフト」→「募集中のお仕事」）
- 「スタッフアプリから応募できる」を有効にした募集ページの枠を表示し、選んで応募する。自分のシフトがある枠・応募済みの枠は選べない
- 承認待ちの応募は取り下げできる。承認・見送りの結果を表示する

### 10.5 個人情報の保存期間
- スタッフに紐づかない応募（見送り・放置）は180日で削除する（Cron）。IPハッシュは7日で消す
- スタッフに紐づく応募（承認で紐づけた公開応募・スタッフアプリからの応募）と応募した枠は、そのスタッフの退職後7年の定期削除で消す（src/services/retention.ts。#350）
- 入店などの報告の位置情報（緯度経度・住所）・端末情報と写真は、在職中でも報告から1年（本部画面「保存期間の設定」で変更可）で消す。勤怠の時刻・種別の行は残す（#420）
- 対応済みの相談・完了したフォロー記録は在職中でも3年で消す（#511）。日報は稼働日から3年で消え、日報一覧から期間（62日まで）を指定して CSV で控えを書き出せる（GET /api/admin/daily-reports-csv。#417）
- 本部画面で「削除の保留」にしたスタッフ・企業のデータは、どの定期削除でも消さない（係争中・調査中など。#543）

### 10.6 API
| メソッド | パス | 内容 |
|---|---|---|
| GET / POST | /api/admin/recruit-pages | 一覧 / 作成 |
| PUT / DELETE | /api/admin/recruit-pages/:id | 変更（`status`・`regenerate_token`）/ 削除（応募がない場合のみ） |
| GET | /api/admin/recruit-applications?status&page_id | 応募一覧（枠・充足・重複・電話番号が一致するスタッフ） |
| GET | /api/admin/recruit-applications/summary | 未対応件数 |
| POST | /api/admin/recruit-applications/:id/decide | 承認・見送り（`approve` / `reject` / `staff_id` / `new_staff_type` / `force`） |
| GET / POST | /api/public/recruit/:token, /:token/apply | 公開ページ |
| GET / POST | /api/staff/recruit, /apply, /items/:id/cancel | スタッフアプリ（ログインできるスタッフのみ） |

## 11. 第5段階 仮登録スタッフと既存スタッフの統合（migrations/0020_add_staff_merge.sql, src/staff-merge.ts）
### 11.1 目的
仮登録（当日の急な参加・募集からの応募など）で作ったスタッフが、すでに登録のある人（他社から連携したスタッフ・自社雇用など）と同一人物と分かったときに、記録を1人にまとめる。

### 11.2 データ
- `staff_profiles.merged_into_staff_id / merged_at`: 統合済みの行（統合元）に、統合先の staff_id を記録する。統合元は削除しない
- `staff_merges`: 統合の記録（統合元・統合先・移した件数とシフトID・置き換えた予定シフト数・メモ・実行者）
- 統合先の `staff_affiliation_history` に「仮登録「〇〇」を統合」を記録する

### 11.3 ルール
- 統合元は **仮登録のスタッフのみ**。統合先はスキルシートのみ・統合済み以外のすべての区分（他社連携を含む）
- 統合候補: 電話番号・氏名・フリガナ（ひらがな/カタカナ・空白を無視）が一致するスタッフ。氏名・フリガナで検索もできる。他社連携の電話番号は表示しない
- 移すもの: シフト・勤怠・日報・評価・フォロー・相談・書類・スタッフ別の単価ルール・報告用URL・募集の応募・クライアントのNGスタッフ指定。従業員管理のデータは統合先にない場合のみ移す（両方にある場合は統合元のまま保持して警告）
- 金額: 今日以降の未報告・未確定のシフトは統合先の区分で単価・支払先を置き換える（手動変更の金額は支払先のみ）。過去・報告済み・確定済みのシフトは金額を変えずにスタッフだけ付け替える
- 統合先の空欄（電話・メール、他社連携以外はフリガナ・性別）を統合元の値で補い、統合元の管理者メモを統合先のメモに追記する
- 統合元は一覧（「統合済み」の絞り込みでのみ表示）・シフトボードの候補・電話番号の検索・募集の紐づけ先から外し、シフト登録・区分変更・本登録・編集をできなくする。ログインとセッションは無効化する
- 警告（確認のうえ実行）: 統合先に同じ時間帯のシフトがある（他社のシフトを含む・同じ枠）、両方に従業員管理のデータがある
- 統合は元に戻せない（確認画面で表示）

### 11.4 API（/api/admin/*）
| メソッド | パス | 内容 |
|---|---|---|
| GET | /staff/:id/merge-candidates?q= | 統合候補（一致した理由・稼働件数） |
| POST | /staff/:id/merge | 統合（`target_staff_id`・`dry_run`・`force`・`note`） |
| GET | /staff/:id/merges | 統合の履歴 |

### 11.5 画面
- スタッフ詳細の「区分・登録状態」に「既存のスタッフに統合」（仮登録のみ）→ 候補の選択 → 確認（移す件数・置き換え・警告）→ 実行後は統合先の詳細へ移動
- 統合済みのスタッフ詳細は閲覧のみ（「統合先を開く」リンク）。スタッフ一覧に「統合済み」の絞り込み

## 12. スタッフ向けの勤務時間・支払と、交通費・延長の申請（migrations/0068_staff_pay_features.sql, src/staff-pay.ts）
### 12.1 勤務時間・支払の確認（スタッフアプリ「その他」→「勤務時間・支払」。#pay / #pay/YYYY-MM）
- 月ごとに、勤務（確定・代打）と補償を入れた欠勤のシフトを出す。希望（仮）は出さない
- 実働（#274）: 時給の計算に使う時間（workHours の pay_hours）と、その元の実績（開始〜終了・休憩）。入力元（報告から／管理者が入力）と、精算の確定済みかどうかを出す。管理者の実績のメモ（actual_note）は社内の記録のため返さない
- 月の集計: 勤務した日数・実働時間の合計と、これからの予定の日数・時間
- 支払額（#290）: companies.settings_json の `staff_pay_visible` が true の会社のシフトで、支払先（payee_type）が payroll / payroll_daily / freelance のものだけ。単位・単価・数量・基本額・交通費（支払側）・調整額・合計（shiftTotals の支払側）と、月の見込み（すべて）・確定済み（settle_status = confirmed）の合計を返す。調整のメモ・請求額は返さない
- 設定は精算の画面の「スタッフからの交通費・延長の申請」の欄で変える（会社管理者のみ）
- 管理者が精算画面で実績を入力すると、本人にアプリ内通知（kind = actual_entered）を送る（時刻・休憩が変わったときだけ。メモは入れない）

### 12.2 交通費（実費）・延長（残業）の申請（staff_pay_requests）
- 対象: 自分の確定・代打のシフトで、勤務が始まった後。精算の確定済み・締めた期間は申請できない。会社の打刻修正の受付期限（correction_deadline_days）があれば同じ期限を使う
- 1つのシフトに、種類ごとに承認待ちは1件まで（直すときは本人が取り消して出し直す）。1時間に20件まで
- 交通費（transport, #273）: 区間・金額（往復の合計。1〜100,000円）・往復/片道・メモ。承認すると shifts.transportation_fee（実費）を承認した金額に置き換える。支払われる額はシフトの交通費の支払区分（実費・上限・定額・支給なし）で決まる
- 延長（overtime, #172）: 延長後の終了時刻（今の予定の終了より後、延長は12時間まで）・指示した人・理由。承認すると shifts.end_time を延ばし、時給のシフトは数量・金額を計算し直す（refreshShiftAmounts。日給は変わらない）。同じスタッフの別の勤務と時間が重なる延長は承認できない
- 承認・却下は管理者（精算の画面の「スタッフからの交通費・延長の申請」）。承認では金額・終了時刻を直せる。却下は理由が必須。確定済み・締めた期間・削除や担当替えのあったシフトの申請は承認できない（却下する）
- 通知（アプリ内のみ）: 申請 → シフトの会社の管理者（pay_request_submitted）、承認・却下 → 本人（pay_request_approved / pay_request_rejected）
- 精算の確認事項: 承認待ちの申請があるシフトに「承認待ちの交通費・延長の申請あり」（確認済みにはできない）。時間の数え方が『実績（予定の範囲内）』のシフトで、予定の終了より後まで勤務し（丸め単位と15分の大きいほう以上）、延長の申請がないときは「予定の終了より◯分後まで勤務（延長の申請・承認なし）」

### 12.3 API
| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/staff/pay?month=YYYY-MM | 月の自分のシフトの実働・支払額・申請と、月の集計 |
| POST | /api/staff/pay/requests | 申請（`shift_id`・`kind`、交通費は `amount`・`route`・`round_trip`・`reason`、延長は `new_end_time`・`instructed_by`・`reason`） |
| POST | /api/staff/pay/requests/:id/cancel | 本人の取り消し（承認待ちのみ） |
| GET | /api/admin/pay-requests?status=pending|all | 申請の一覧（承認できない理由 `shift_issue` 付き） |
| POST | /api/admin/pay-requests/:id/approve | 承認（交通費は `amount`、延長は `end_time` で直せる。`note`） |
| POST | /api/admin/pay-requests/:id/reject | 却下（`note` 必須） |
| GET / PUT | /api/admin/staff-pay/settings | スタッフアプリでの支払額の表示（`staff_pay_visible`。変更は会社管理者のみ） |
