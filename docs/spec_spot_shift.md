# 常勤・スポット案件のシフト管理 / 単価（請求・支払）/ 所属区分の移行 仕様

最終更新: 2026-09-29

## 0. 背景と方針
- これまでは週5日稼働の「常勤案件」を前提にした作り（シフト = スタッフ × 案件 × 日付の1件ずつ登録）
- スポット案件（イベント・週末のみ・ピンポイント日程）では、1度しか入らないスタッフの登録と、複数案件をまたぐシフト管理が負担になっている
- 方針
  - **基本は管理者がシフトを組む**。募集（公開の応募フォーム）は補助機能として追加し、応募はすべて承認制とする
  - 常勤とスポットを **同じシフトボード** で扱う。今の常勤の登録方法とデータはそのまま使えるようにする
  - 請求（クライアントへの請求）と支払（スタッフ・取引先への支払）を **シフトごとに分けて記録** する
  - 金額（請求・支払・粗利）は **管理画面のみ** で表示する。スタッフ画面のAPIは金額の列を返さない
  - 所属区分（自社雇用 / 日雇い / 個人事業主 / 取引先所属 / 他社連携）は **双方向に移行** できる。スタッフIDは変えずに区分の履歴を記録する

## 1. 段階計画
| 段階 | 内容 |
|---|---|
| 第1段階（実装済み） | 案件区分（常勤/スポット）、開催場所（現場マスタの土台）、募集枠と役割、単価ルール（請求/支払/交通費）、シフトへの金額記録、繰り返し登録、常勤の一括登録・前週コピー、シフトボード（複数案件の比較・ドラッグ・充足・重複警告・金額合計） |
| 第2段階（実装済み） | 区分の新設（自社日雇い・個人事業主）、仮登録、区分変更の手順と履歴（適用日以降の予定シフトの単価・支払先の置き換え）、雇用終了と退職の分離、勤怠・日報の提出設定（案件→スタッフ→シフト）、シフト専用の報告URL（コピーして送付）、代理入力 |
| 第3段階（本PR） | 実績の確定（入店・退店報告から実働時間を反映）、請求・支払の集計（クライアント別 / 支払先別、月ごと・任意の期間）、CSV出力 |
| 第4段階 | 公開の募集ページ（URL・QR、Turnstile、送信回数の制限）、承認による確定と仮登録の自動作成、既存スタッフの希望日提出 |
| 第5段階 | 仮登録スタッフと連携スタッフの統合（シフト・勤怠・評価の引き継ぎ） |

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

### 2.2 sites（開催場所。今後作成する現場マスタの土台）
`site_id, company_id, client_id, site_name, address, lat, lng, memo, status(active/inactive)`
- クライアントに紐づけて管理する（クライアント詳細から登録）。今後の現場マスタは本テーブルを拡張する

### 2.3 rate_rules（単価ルール）
条件（`project_id` / `site_id` / `role_name` / `staff_id`。NULL は「すべて」）と、上書きしたい値（NULLは上書きしない）を持つ。
値: `bill_unit_type, bill_rate, pay_unit_type, pay_rate, bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount`
- **項目ごとに**、条件に合うルールのうち最も具体的なものを採用する
  - 具体度: スタッフ指定 8 ＞ 役割指定 4 ＞ 開催場所指定 2 ＞ 案件指定 1（合計点が高いほど優先。同点なら新しいルール）
- 例
  - 案件Aの役割「リーダー」: 請求 22,000 / 支払 15,000
  - 案件Aの開催場所「△△モール」: 交通費の請求を定額 1,000
  - スタッフXの全案件: 支払 13,000（経験者加算。案件指定なし）

### 2.4 募集枠
- `shift_slots`: `slot_id, company_id, project_id, site_id, location, work_date, start_time, end_time, break_minutes, pattern_id, memo, status`
- `shift_slot_roles`: `slot_role_id, slot_id, role_name, headcount, bill_unit_type, bill_rate, pay_unit_type, pay_rate`（単価列は枠でだけ変える場合に使う）
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
| payee_type / payee_affiliation_id / payee_company_id | 支払先の種類（`payroll` 自社給与 / `partner` 取引先 / `linked` 他社連携元 など）。第2段階の区分変更で置き換える |
| price_locked / price_source | 手動で金額を変更したシフトは 1（ルール再適用の対象外）。price_source は採用したルールの説明 |

**単価の優先順位**（上ほど優先）: シフトの手動変更 ＞ 枠の役割の単価 ＞ 単価ルール（具体度順）＞ 案件の標準 ＞ 未設定
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
| POST | /admin/shifts/reprice | 期間・案件を指定して単価ルールを再適用（手動変更したものは除く） |
| POST | /admin/shifts/bulk | 常勤の一括登録（スタッフ × 曜日 × 期間） |
| POST | /admin/shifts/copy-week | 前週のコピー（枠と割り当て） |
| GET/POST/DELETE | /admin/slot-patterns | 繰り返し登録 |
| GET/POST/PUT/DELETE | /admin/sites | 開催場所 |
| GET/POST/PUT/DELETE | /admin/rate-rules, GET /admin/rate-rules/resolve | 単価ルールと適用結果のプレビュー |
| PUT | /admin/projects/:id/pricing | 案件区分・標準単価・交通費ルール |

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
  - 自社雇用 → 日雇い・個人事業主など: 従業員管理のデータは「雇用終了」として保持し、7年保存ルールを当てはめる
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
  - 自社雇用から: 従業員データに雇用終了日（適用日の前日）を記録し、閲覧のみで保持（7年保存ルールの対象）
- `GET /staff/:id/lifecycle` 区分・履歴・提出設定
- `PUT /staff/:id/report-settings`、`PUT /projects/:id/report-settings`、`PUT /shifts/:id/report-settings`
- `GET /shifts/:id/report-status` 提出状況
- `POST /shifts/:id/proxy-attendance`、`DELETE /shifts/:id/proxy-attendance/:type` 管理者の代理入力（代理入力した分のみ削除可）
- `POST /shifts/:id/report-link`（`regenerate` で再発行）、`DELETE /shifts/:id/report-link` 報告URLの発行・取り消し

### 7.1 公開の報告URL（ログイン不要。`/r/:token`、API は `/api/public/report/:token`）
- `GET` 名（名字なし）・案件・シフトの時間・提出設定・提出状況・日報テンプレートを返す。金額は返さない
- `POST /attendance` 提出設定・順序・重複・勤務日（退店は翌日も可）・写真の必須を確認して記録（entry_method = link）
- `POST /daily-report` 日報の登録・更新
- ページは noindex・no-referrer。URL は管理者がコピーして送る

## 8. 第2段階 画面
- スタッフマスタ: 一覧に「仮」バッジ・仮登録ボタン・仮登録の絞り込み。詳細に「区分・登録状態」（履歴・本登録・区分変更）と「勤怠・日報の提出設定」
- 日雇い・個人事業主はスタッフマスタで基本情報を編集できる
- シフトボード: 候補一覧から仮登録してそのまま割り当て。シフト詳細に提出状況・提出設定・報告URL・代理入力。案件パネルに提出設定
- 従業員管理: 雇用終了した従業員を別の一覧に表示し、詳細は閲覧のみ

## 9. 第3段階 実績の確定・請求/支払の集計・CSV（migrations/0018_add_settlement.sql, src/settlement.ts）
### 9.1 データ
- `shifts.actual_start / actual_end / actual_break_minutes / actual_source(report|manual) / actual_note`
- `shifts.settle_status(planned|confirmed) / settled_at / settled_by`
- `projects.hours_basis`（clipped: 実績・予定の範囲内〈既定〉/ actual: 実績どおり / scheduled: 予定どおり）、`projects.time_round_minutes`（開始は切り上げ・終了は切り捨て）

### 9.2 実働時間の反映
- 入店・退店の報告（アプリ・報告URL・代理入力・代理入力の削除）のたびに実績へ反映する。両方そろったときだけ反映
- 管理者の手入力（manual）は報告で上書きしない。「報告の時刻に戻す」で解除
- 金額: 単価ルールは再適用しない（記録済みの単価のまま）。時給のものだけ数量を計算時間に合わせる。日額は変わらない。手動で金額を変えたシフトは数量も変えず「確認」に表示する

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

- 支払先別: 自社給与・日雇い給与はスタッフごと、個人事業主は本人、取引先・他社連携はその会社ごと
- 画面: サイドメニュー「精算（請求・支払）」（`#settlement`）。案件の「区分・標準単価」に時間の数え方と丸めを追加
