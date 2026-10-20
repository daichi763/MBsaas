# 案件報告管理 / 打刻修正申請・承認ワークフロー 仕様（設計）

最終更新: 2026-10-14（第1〜第4段階 実装済み）

## 0. 背景と方針
- 勤怠報告を「案件 × スタッフ」ごとに 8 種類まで ON/OFF できるようにする。あわせて、スタッフ本人・管理者が打刻の修正と打刻漏れの追加を申請し、管理者が承認する流れを作る
- 既存の勤怠報告（`attendance_reports`）・シフト（`shifts`）・実績の反映（`syncActualFromReports`）・確定（`settle_status`）を再利用し、同じ意味のデータを二重に持たない
- 承認されるまで正式な勤怠データ（`attendance_reports`）は変えない。承認したときに初めて反映する
- 既存データは削除・初期化しない。列とテーブルの追加と、既存の値を新しい設定に移す移行のみ

### 0.1 確定した方針（2026-10-13 合意）
| 論点 | 決定 |
|---|---|
| 報告の種類 | 既存の 4 種類に、勤務開始・休憩入・休憩出・勤務終了の 4 種類を追加して 8 種類にする |
| 集計 | 勤務開始・勤務終了があれば、実働はそちらを使う（なければ従来どおり入店・退店）。休憩入・休憩出が両方あれば実績の休憩に反映する |
| 導入時の初期値 | 8 種類すべて ON（指示書どおり）。ただし提出設定を「入店・退店のみ」「報告なし」に明示している案件・スタッフは、その設定を 8 種類に置き換えて維持する（§2.4） |
| 既存の提出設定との関係 | 勤怠の提出設定（`attendance_mode`）は、案件・スタッフ単位では 8 種類の ON/OFF に一本化する。シフト単位の例外（`shifts.attendance_mode`）は残す |
| 管理者と案件担当者 | 案件担当者の概念は作らない。管理ロール（`ADMIN_ROLES`）全員を「管理者」として扱い、自社の全案件を扱える。指示書の担当者に関する要件（担当案件のみ・担当者への通知・担当者未設定時の扱い）は対象外 |

### 0.2 実装前に確認が必要な点
- **導入すると、既存スタッフの画面に新しいボタンが 4 つ増える。** 勤務開始・勤務終了・休憩を報告すると実績の時刻と休憩が変わるので、時給の案件では金額が変わる。案件ごとに OFF にしてから導入するかどうかは、運用で決める
- 本部アカウント（`system_admin`）は main ではまだ `ADMIN_ROLES` に含まれている（修正ブランチ `fix/partner-tenant-guard` が未マージ）。このままだと、本部アカウントもテナント1の「管理者」として承認依頼の通知を受け取る。先にマージすることを推奨

## 1. 現状（調査結果の要点）
| 項目 | 現状 | 根拠 |
|---|---|---|
| 報告の種類 | `wake_up` / `departure` / `check_in` / `check_out` の 4 種類 | `src/api.ts` `REPORT_TYPES`、`public/static/staff.js` `REPORT_LABELS` |
| 重複防止 | `UNIQUE(shift_id, report_type)`。1 シフトに同じ種類は 1 件 | `migrations/0001` |
| 時刻 | `reported_at` は日本時間の `YYYY-MM-DD HH:MM:SS` | `nowJST()` |
| 順序 | アプリ経由はサーバー側の確認なし（画面で次の報告以外を押せないだけ）。報告URL経由はサーバー側で確認 | `api.ts` `/staff/attendance`、`staff-lifecycle.ts` `/:token/attendance` |
| 日をまたぐ勤務 | 報告URLは、退店のみ翌日も受け付ける | `staff-lifecycle.ts` |
| 提出設定 | `attendance_mode`（none / in_out / full）を案件・スタッフ・シフトに持ち、シフト ＞ スタッフ ＞ 案件の順に優先 | `migrations/0017`、`resolveModes` |
| 実績 | 入店・退店がそろうと `shifts.actual_start/actual_end`（HH:MM）に反映。手入力（`actual_source='manual'`）と確定済みは上書きしない。休憩は `actual_break_minutes`（NULL = 予定の休憩） | `settlement.ts` `syncActualFromReports`、`shift-board.ts` `workHours` |
| 確定 | `settle_status='confirmed'` のシフトは実績・金額を変えない。取り消すと再び変更できる | `settlement.ts` |
| 権限 | 管理ロール 4 種類が自社の全案件を同じ権限で扱う。案件担当者・案件の所属スタッフを表すデータはない（所属はシフトの有無でのみ表現） | `api.ts` `ADMIN_ROLES` |
| 通知 | `notices` は管理者からスタッフへのお知らせ。管理者向けの受信箱はない。既読率レポートが全お知らせを集計する | `api.ts`、`migrations/0007` |
| メール | `sendEmail`（Resend）を `waitUntil` で呼ぶ。`email_logs` に成否を記録。本文は保存しない方針 | `src/services/email.ts` |
| 保存期間 | 勤怠・シフト・従業員データ・書類・企業間チャット等は退職日から 7 年で削除し、本人情報は匿名化。`notice_reads` は 2 年 | `src/services/retention.ts` |
| CSV | UTF-8（BOM 付き）・CRLF・数式インジェクション対策あり | `settlement.ts` `toCsv` / `csvCell` |
| テスト | 自動テストなし（`package.json` に test スクリプトなし） | — |

## 2. 報告の種類と設定

### 2.1 8 種類と順序
| 順 | コード | 表示名 | 備考 |
|---|---|---|---|
| 1 | `wake_up` | 起床報告 | 既存 |
| 2 | `departure` | 出発報告 | 既存 |
| 3 | `check_in` | 入店報告 | 既存。写真・位置情報・遅刻判定は従来どおり |
| 4 | `work_start` | 勤務開始 | 新規 |
| 5 | `break_start` | 休憩入 | 新規。1 シフトにつき 1 回（`UNIQUE(shift_id, report_type)` のため） |
| 6 | `break_end` | 休憩出 | 新規。同上 |
| 7 | `work_end` | 勤務終了 | 新規 |
| 8 | `check_out` | 退店報告 | 既存。写真は従来どおり |

- `report_type` は TEXT 列のため DDL 変更は不要
- 順序の確認は、そのシフトで有効（ON）な報告だけを対象にする。OFF の報告は順序から外す
- 日をまたぐ勤務: 勤務開始より後の報告（休憩入・休憩出・勤務終了・退店）は稼働日の翌日も受け付ける（現状の「退店のみ翌日可」を拡張）
- 休憩が 1 シフト 1 回に限られる点は今回の制約とする（複数回にするには一意制約の変更が必要で、影響が大きいため）

### 2.2 設定の持ち方
| テーブル | 主キー | 内容 |
|---|---|---|
| `project_report_defaults` | (project_id, report_type) | 案件の標準設定。`enabled`、`updated_by`、`updated_at` |
| `project_staff_report_settings` | (project_id, staff_id, report_type) | 案件 × スタッフ別の設定。`enabled`、`source`（`default` = 標準設定の引き継ぎ / `individual` = 個別変更 / `bulk` = 一括変更 / `migration` = 導入時の移行）、`updated_by`、`updated_at` |

### 2.3 有効な報告の決め方
1. シフトに例外（`shifts.attendance_mode`）があればそれに従う: `none` = なし、`in_out` = 入店・退店のみ、`full` = 2 以降に従う
2. 案件 × スタッフ別の設定の行があればそれを使う
3. なければ案件の標準設定
4. それもなければ 8 種類すべて ON

- `resolveModes` / `modesForShifts` の中身をこの規則に置き換え、関数名と返り値（`required_attendance` ほか）はそのまま使う。呼び出し元（スタッフのホーム、報告API、報告URL、ダッシュボードの未報告一覧、シフト詳細）は変更を最小限にする
- 日報の提出設定（`daily_report_mode`）は今回の対象外。従来どおり案件・スタッフ・シフトで持つ

### 2.4 導入時の移行（migration 0027）
- 案件の標準設定: `projects.attendance_mode` が `full`（既定）または NULL → 8 種類 ON。`in_out` → 入店・退店のみ ON。`none` → すべて OFF
- 案件 × スタッフ別: シフトがある（案件, スタッフ）の組み合わせごとに行を作る（`source='migration'`）。`staff_profiles.attendance_mode` が設定されていればそれを上と同じ規則で 8 種類に変換し、なければ案件の標準設定を写す
- 移行後、`projects.attendance_mode` と `staff_profiles.attendance_mode` は読まない（列は削除せず残す。ロールバック用）
- 移行内容は設定変更履歴にも記録する（`action='migration'`）

### 2.5 新しく所属したスタッフ
- 案件の所属は「その案件にシフトがあること」とする（所属を表すデータがないため）
- 個別の行がないスタッフには、案件の標準設定がそのまま効く
- 案件の標準設定を変えるときは、変える直前に、その案件にシフトがあって個別の行がないスタッフ全員について、今の値で行を作る（`source='default'`。スタッフ単位の旧設定を使っている人は `individual`）。これで標準設定の変更は「これから所属するスタッフ」だけに効く。この値の固定は実際に適用される値を変えないため、設定変更の履歴には記録しない
- 標準設定の保存では、今の所属スタッフにも当てるかを選べる（#329。API の `apply`）
  - `none`（既定）: 上のとおり、これから所属するスタッフにだけ効く
  - `standard`: 個別に変えていない在籍中のスタッフ（行がない人・標準（引き継ぎ）の人）にも当てる。行がない人は書かずに標準設定に従わせ、引き継ぎの行は変えた種類だけを新しい値にする
  - `all`: 個別に変えた人を含め、在籍中のスタッフ全員に変えた種類だけを当てる（案件全体の OFF を 1 回の操作でできる）
  - 退職・統合済み・取引終了の人には当てない（今の値で固定する）。当てた人は、スタッフごとに履歴を残す（`action='default_apply'`）。報告を始めたシフトは §2.7 のとおり固定する
- 標準設定には版番号（`projects.report_defaults_version`）を持たせる。画面は開いた時点の版番号と、変えた種類だけを送り、ほかの人が先に保存していたら 409 で読み込み直しを求める（#509）
- 仮登録の画面の「勤怠報告」の選択は廃止した（シフトのないスタッフには案件 × スタッフの行を作れないため）。仮登録のスタッフにも、シフトを割り当てた案件の設定が適用される
- シフトを作る経路（シフトボード・繰り返し登録・募集の承認・掲示板の取り込み等）には手を入れない

### 2.6 一括変更
- 案件を選ぶ → 変更する報告の種類と ON/OFF を選ぶ → 対象スタッフを選ぶ → 対象人数と、スタッフごとの変更前・変更後の一覧を確認（`dry_run`）→ 保存 → 結果を表示
- 対象にできるのは在籍中・休職中の所属スタッフ。退職・統合済み・取引終了の人は選べない（API も 400）。初期の選択は在籍中の人で、「今後のシフトがある人」「全員」をボタンで選び直せる（#247 #379）
- 選んだスタッフの個別の行を上書きする（`source='bulk'`）。一括変更の後に個別に変えた値は、そのまま個別設定として残る
- 保存は `db.batch()` で 1 回にまとめ、途中で失敗したら全体を取り消す（D1 の batch はトランザクション）。同じ `batch_id` で履歴を残す。設定の行と履歴は、同じ（種類・値）のスタッフをまとめて 1 文で書く（`json_each`）ため、文の数は人数で増えない（#247）
- 二重送信: 画面はボタンを無効化。サーバーは `dry_run` で返したトークンを保存時に受け取り、同じトークンの 2 回目は保存しない
- OFF にするときは、影響を受けるスタッフ数（今日以降にその案件のシフトがある人数）を表示して確認する

### 2.6.1 設定の種類の表示（#268）
| 表示 | 条件 |
|---|---|
| 個別 | 個別変更・一括変更の行（`source` が `individual` / `bulk`）がある。0027・0036 の移行の行のうち、スタッフ単位の旧設定から作った組み合わせは 0056 で `individual` にした |
| 個別（旧設定） | 行がなく、スタッフ単位の旧設定（none / in_out）を使っている |
| 標準（引き継ぎ） | 行が `default` / `migration` だけ（標準設定を変える前の値で固定した人） |
| 標準 | 行がない（案件の標準設定に従う） |
- 案件詳細のスタッフ表は、案件の標準設定と違う値のマスに色を付ける
- 既定では在籍中の人と今後のシフトがある人だけを表示し、退職・休職の人は切り替えで表示する。氏名で絞り込める（#379）

### 2.6.2 スタッフ 1 人の全案件の設定（#413。`#report-settings/staff/:id`）
- スタッフにシフトがある案件ごとに、8 種類の ON/OFF・設定の種類・今後のシフト・シフト単位の例外の件数を出す。スタッフ詳細の提出設定の欄に要約とリンクを置く
- 「すべての案件に同じ設定」: 8 種類の値と対象の案件（既定は稼働中の案件）を選び、案件ごとの変更前・変更後を確認してから保存する（個別変更として記録）
- 「標準に戻す」: 案件 × スタッフ別の行を消して、案件の標準設定に従う状態にする（`action='staff_reset'` で履歴を残す）。すべての案件を戻すときは、スタッフ単位の旧設定も消す。一部の案件だけを戻すときに旧設定が残っていれば、標準設定の値で行を作る
- 旧来の `PUT /admin/staff/:id/report-settings` の `attendance_mode: ''` も、この「標準に戻す」と同じ扱い

### 2.6.3 OFF の設定一覧（#446。`#report-settings/off`）
- 案件をまたいで、案件 × スタッフ別の行で OFF になっている報告を、案件・報告の種類で絞り込んで一覧にし、CSV で出力する。既定では在籍中のスタッフ・稼働中の案件・案件の標準設定と違う OFF だけ
- 案件一覧には、個別設定のある人数と、OFF の報告がある在籍中の所属スタッフの人数を出す
- 同じ画面に、今日以降のシフト単位の例外（§2.8）を出す

### 2.7 OFF にした報告の扱い
- スタッフの報告画面ではボタンを表示しない。アプリ・報告URL・写真付き報告の API でも受け付けない
- 登録済みの報告・申請・履歴は削除しない。過去の報告の閲覧、修正申請、打刻漏れの追加申請、承認は OFF でも行える
- 勤務中に OFF にした場合、スタッフ画面は次の再読み込み（画面の切り替え・送信後の再取得）で反映する

### 2.8 シフト単位の例外（#313）
- シフト詳細の「このシフトの勤怠報告」（`shifts.attendance_mode`）を変えたら、設定変更の履歴に残す（`action='shift_override'`、`shift_id` と、勤務日・時間・変更前後の例外を `detail` に入れる）。有効な報告が変わった種類ごとに 1 行。変わらない変更も入店報告の行に同じ値で 1 行残す
- 案件報告管理のスタッフ行に、今日以降のシフトの例外の件数を出し、そこからシフトの設定を開ける

## 3. 設定変更の履歴（`report_setting_logs`。追記のみ）
| 列 | 内容 |
|---|---|
| log_id | 主キー |
| company_id / project_id | |
| staff_id | NULL = 案件の標準設定の変更 |
| report_type | |
| old_enabled / new_enabled | 0 / 1（新規作成時の old は NULL） |
| action | `project_default` / `default_apply`（標準設定を今の所属スタッフに適用）/ `individual` / `bulk` / `staff_reset`（標準に戻す）/ `shift_override`（シフト単位の例外）/ `migration` / `merge` |
| shift_id / detail | `shift_override` の対象シフトと内容（0056） |
| batch_id | 一括変更・移行の識別子 |
| changed_by / changed_by_name / changed_by_role | 変更者の user_id と、変更時点の氏名・ロール |
| created_at | 日本時間（アプリの記録 `nowJST()` と移行時の記録をそろえる） |

- 更新・削除の API は作らない
- 案件が終了（`status='closed'`）しても閲覧できる。案件の物理削除の処理は存在しない

## 4. 打刻修正申請

### 4.1 データ
`attendance_corrections`（申請 1 件 = 1 報告種類）
| 列 | 内容 |
|---|---|
| correction_id | 主キー |
| company_id / project_id / shift_id / staff_id | 申請時点のシフトから設定（シフトの所有企業） |
| attendance_id | 修正対象の報告。追加申請は NULL（承認後に作られた報告の ID を `applied_attendance_id` に入れる） |
| kind | `modify`（時刻修正）/ `add`（打刻漏れの追加） |
| report_type | 8 種類のいずれか |
| before_at | 修正前の日時（`add` は NULL） |
| requested_at | 修正後の日時（`YYYY-MM-DD HH:MM:SS`） |
| reason | 修正理由（必須） |
| order_warnings | 順序の矛盾内容（JSON。`add` で矛盾がある場合のみ） |
| status | `pending`（承認待ち）/ `approved`（承認済み）/ `rejected`（却下）/ `cancelled`（取り消し済み）。命名は募集の応募（`recruit_application_items`）に合わせる |
| is_exception | 1 = 順序の矛盾を承知のうえで承認した |
| requested_by / requested_by_role | 申請者と、申請時点のロール |
| decided_by / decided_at / decision_comment / reject_reason | 承認・却下の結果 |
| cancelled_at | |
| resubmitted_from | 再申請の元になった申請 ID |
| applied_attendance_id / settled_at_apply | 反映した報告 ID / 反映時にシフトが確定済みだったか |
| created_at / updated_at | |

- 同じ報告への承認待ちの重複を防ぐ: `CREATE UNIQUE INDEX ... ON attendance_corrections(shift_id, report_type) WHERE status = 'pending'`
- 外部キーは張らない（既存の定期削除と案件・シフトの削除処理を止めないため）。ID と、申請時点の値（日時）を持つ

`attendance_correction_events`（操作の履歴。追記のみ）
| 列 | 内容 |
|---|---|
| event_id / correction_id / company_id | |
| event | `submitted` / `resubmitted` / `approved` / `approved_exception` / `rejected` / `cancelled` |
| actor_user_id / actor_name / actor_role | |
| detail | JSON（変更前後の日時・理由・コメント・矛盾内容） |
| created_at | |

### 4.2 申請できる人と対象
| 操作 | スタッフ本人 | 管理者 |
|---|---|---|
| 自分のシフトの報告の修正・追加申請 | ○（同一人物の他社シフトを含む。申請はシフトの所有企業に入る） | — |
| 自社のシフトの報告の修正・追加申請 | — | ○（全案件） |
| 承認・却下 | × | ○（自分の申請も可） |
| 取り消し（承認待ちのみ） | 自分が出した申請のみ | 自分が出した申請のみ |
| 再申請（却下後） | 自分が出した申請のみ | 自分が出した申請のみ |
| 閲覧 | 自分のシフトの申請のみ | 自社の全申請 |

- スタッフ本人の判定は、ログインユーザーの人物（`personStaffRows`）に含まれる `staff_id` のシフトかどうかで行う（既存の勤怠報告と同じ）
- 「自分が出した申請」（取り消し・再申請・一覧の `mine`）も人物で判定する。`requested_by` が同じ人のいずれかのユーザーなら本人とみなす（所属企業を切り替えるとセッションのユーザーが変わるため。#96）
- 再申請は、今のシフトの担当者が元の申請と同じ（`shifts.staff_id = attendance_corrections.staff_id`）で、かつ本人のシフトのときだけ受け付ける（#101）
- 他人の申請 ID・シフト ID を指定しても 404 を返す（存在を明かさない）

### 4.3 入力の確認（サーバー側）
- 日時の形式（`YYYY-MM-DD HH:MM`）、報告種類、理由（必須・1〜500 文字）
- シフトの存在と権限、シフト・案件・スタッフの関係
- `modify`: 対象の報告が存在し、同じシフト・種類であること。変更後の日時が変更前と同じなら拒否
- `add`: 同じシフト・種類の報告がまだないこと
- 同じシフト・種類に承認待ちの申請がないこと（一意インデックスでも防ぐ）
- 期限なし。過去日・未来日とも可。報告が OFF でも可。ただし日時は稼働日の前日 0:00〜翌日 23:59 の範囲（年・月の打ち間違いを止める）
- 日をまたぐシフト（終了 <= 開始）で、休憩・勤務終了・退店の日時が稼働日の日付のまま開始時刻より前のときは、「翌日ではありませんか？」の案内を警告に加える（#52）。スタッフ画面の打刻漏れの追加の既定値も、勤務終了・退店は予定の終了の絶対日時（`shiftWindow`。日をまたぐなら翌日）にする
- 欠勤（`status='absent'`）のシフトへの申請は拒否

### 4.4 順序の確認
- そのシフトに登録済みの報告（種類を問わない）に、申請の日時を当てはめ、§2.1 の順で日時が前後していないかを日付込みで比較する
- `modify`: 矛盾があれば申請を拒否する（具体的な矛盾内容をエラーに含める）。承認時にも同じ確認をし、矛盾があれば承認できない
- `add`: 矛盾があっても申請を受け付け、矛盾内容を `order_warnings` に保存する。画面に警告ラベルと内容を表示する。管理者は例外として承認できる（`is_exception=1`、承認者コメントは任意）。例外承認したことと矛盾内容は履歴に残す
- 矛盾内容の例: 「勤務終了（10/12 17:00）が休憩入（10/12 18:30）より前です」

### 4.5 状態遷移
```
（申請）→ pending ─承認→ approved
                 ├却下→ rejected ─再申請→（新しい申請 pending。resubmitted_from に元の ID）
                 └取り消し→ cancelled
```
- approved / rejected / cancelled からは遷移しない。却下された申請は上書きせず、再申請は別の行として作る
- 再申請の報告種類とシフトは元の申請と同じ。申請の種類（時刻修正 / 追加）は再申請の時点の登録状況で決め直す（却下後に報告が登録・変更されている場合があるため）
- 承認の後に、申請時と対象の報告が変わっていた（削除・再登録・時刻の変更）場合は承認できない（409）。管理者が却下し、必要なら再申請してもらう

### 4.6 承認時の処理（二重承認・競合の防止）
- 承認は `db.batch()` の 1 回で次の 2 つを実行する（全体が 1 トランザクション）
  1. `UPDATE attendance_corrections SET status='approved', decided_by=?, decided_at=?, ... WHERE correction_id=? AND status='pending' AND <対象の報告が申請時の状態のまま>`
     - `modify`: 報告が存在し `reported_at = before_at`
     - `add`: 同じシフト・種類の報告が存在しない
  2. 1 が成功した場合だけ効く条件付きの反映（`WHERE EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id=? AND status='approved' AND decided_at=?)`）
     - `modify`: `UPDATE attendance_reports SET reported_at=?`
     - `add`: `INSERT INTO attendance_reports (..., entry_method='correction', entered_by=承認者)`（一意制約で二重登録を防ぐ）
- 1 の更新件数が 0 なら、最新の状態を読み直して理由を返す（すでに処理済み / 取り消し済み / 申請後に打刻が変わった）
- 取り消しも `WHERE status='pending'` の条件付き更新にするので、取り消しと承認が同時に来ても片方しか成功しない
- 反映後に `syncActualFromReports` を呼び、実績と時給の数量を更新する（既存の処理を再利用）

### 4.7 集計への反映（§0.1 の決定に基づく `syncActualFromReports` の変更）
- 実績の開始: 勤務開始があればその時刻、なければ入店
- 実績の終了: 勤務終了があればその時刻、なければ退店
- 開始と終了の両方がそろったときだけ反映する（従来どおり）
- 休憩: 休憩入・休憩出が両方あれば、その差（分）を `actual_break_minutes` に入れる。なければ従来どおり（NULL = 予定の休憩）
- 手入力の実績（`actual_source='manual'`）と確定済みのシフトは従来どおり変えない
- 確定済みのシフトに修正を承認した場合: 報告は更新するが、実績・金額は変えない（既存の規則）。精算画面の確認事項に「確定後に打刻修正あり」を出す。確定を取り消すと、次の実績の反映（既存の「実績を反映」ボタン）で反映される

### 4.8 修正の印（#252）
- 承認で変わった報告には `attendance_reports.corrected_by_correction_id`（最後に反映した申請）・`corrected_at` を付ける。時刻修正では `original_reported_at` に最初の修正の前の日時を残す（何度直しても最初の打刻の日時）
- `entry_method`（`app` / `link` / `proxy` / `correction`）は上書きしない。打刻漏れの追加で作った報告だけが `correction`
- スタッフの打刻履歴は「（修正済み・元: 18:00）」、管理画面の報告状況は「・修正」と注記（元の日時）を出す。位置・写真は元の打刻のもの
- 代理入力の取り消し（`DELETE /api/admin/shifts/:id/proxy-attendance/:type`）は、承認済みの修正がある報告を対象にしない（409）

### 4.9 シフトの差し替え・欠勤・削除との整合（#70 #81 #101 #115）
| 操作 | 打刻修正申請 | 勤怠報告・日報 | 報告用URL |
|---|---|---|---|
| 担当者の差し替え（`PUT /api/admin/shifts/:id` の `staff_id`） | 前の担当者の承認待ちを取り消す（`cancel_reason='staff_changed'`）。申請者に通知 | `staff_id` を新しい担当者に付け替える | 無効にする（`revoked=1`） |
| 欠勤にする | 承認できない（409「却下してください」）。応答に承認待ちの件数（`pending_corrections`）を返す | 変えない | 使えない（従来どおり） |
| 削除（`DELETE /api/admin/shifts/:id`。報告のないシフトのみ） | 承認待ちを取り消す（`cancel_reason='shift_deleted'`）。申請者に通知 | — | 削除する |
- 差し替えの前に、勤怠報告・日報・承認待ちの申請がある場合は確認を求める（409 `need_force` と `warnings`。`force: true` で実行）
- 自動の取り消しは `attendance_correction_events` に `cancelled`（`detail.auto=true`・`reason`）として残す。スタッフの申請一覧には理由を出す
- 承認は、シフトの担当者が申請と同じで、状態が勤務（確定・代打）のときだけ行う（承認の条件付き更新にも同じ条件を入れる。#101 #70 #559）
- 担当者・時間が変わったら、スタッフの返事（`staff_reply`・`staff_reply_note`・`staff_reply_at`）を消す
- 報告用URLの有効期限は、使うときのシフトの稼働日から決める（稼働日の翌日 23:59。#68）。`shift_report_tokens.expires_at` は発行時の記録。報告状況・発行は、今の担当者に発行したURLだけを有効として扱う（#81）
- 移行（0044）: 削除済みのシフトの承認待ちと、担当者が変わったシフトに残る前の担当者の承認待ちを取り消す。既存の承認済みの修正に印を付ける。処理済みの申請の承認依頼を既読にする。承認依頼を申請ごとに既読にするため user_notifications(related_id, kind) にインデックスを付ける

## 5. 通知

### 5.1 アプリ内通知（`user_notifications`）
- 既存の `notices` は使わない。理由: 管理者向けの受信箱がない。お知らせ配信の一覧と既読率レポートに申請の通知が混ざる
| 列 | 内容 |
|---|---|
| notification_id / company_id / user_id | |
| kind | `correction_submitted`（管理者への承認依頼）/ `correction_received`（申請者への受付）/ `correction_approved`・`correction_rejected`（申請者への結果）/ `correction_processed`（処理した管理者への控え） |
| title / body | 受信者に必要な範囲（案件名・スタッフ名・報告種類・対象日時・結果・理由／コメント） |
| link | 画面内のリンク（例: `#corrections/123`） |
| related_id | correction_id |
| created_at / read_at | |
- 管理画面のヘッダーとスタッフ画面のホームに未読件数を表示し、一覧から既読にする
- 保存期間: 既存の `notice_reads` に合わせて 2 年で削除する（定期削除に追加）

### 5.2 宛先
| 出来事 | 宛先 |
|---|---|
| 申請（再申請を含む） | 自社の管理者全員（`ADMIN_ROLES`、`status='active'`）+ 申請者本人（受付の通知） |
| 承認・却下 | 申請者本人 + 処理した管理者。管理者が出した申請を承認したときは、記録が変わったスタッフ本人にも（`correction_changed_by_admin`。申請者と同じ人なら送らない。#181） |
| 取り消し | シフトの削除・担当者の差し替えで自動で取り消したときだけ申請者本人へ（`correction_cancelled`）。本人の取り消しは通知しない |
- 承認・却下・取り消しの後は、その申請の承認依頼（`correction_submitted`）を全管理者分既読にする。管理画面の通知には「処理済み（承認: ○○）」を出す。処理済み・取り消し済みの申請の承認依頼メールは送らない・再送しない（`already_processed`。#189）
- スタッフの通知（一覧・未読件数・既読）は、同じ人のすべてのユーザーあてを対象にする（#96）
- アプリ内通知とメールの両方を送る。メールはメールアドレスが登録されている人だけ
- 受け取り設定（#284。`user_notification_prefs`。管理画面の「通知」→「受け取り設定」）: 自分あてのメールを通知のまとまりごとに選ぶ。アプリ内通知は設定によらず必ず作る
  - 既定: 承認依頼（`correction_submitted`）のメールは会社管理者と現場管理者だけに送る（営業・事務はアプリ内通知だけ）。自分が処理した控え（`correction_processed`）のメールは送らない
  - 承認依頼は「すぐに」「1日1回まとめて」「送らない」を選べる。「まとめて」の人には、毎朝 8 時以降の最初の定期処理（15分おき）で自社の承認待ちの件数を1通で送る（承認待ちがなければ送らない）
  - スタッフは「その他」→「通知の設定」で、種類ごとにプッシュ通知とメール（シフト・リマインド・新しい募集）を選ぶ。同じ人のすべての会社のユーザーに同じ設定を保存する
- プッシュ通知（#178）: スタッフが「その他」→「通知の設定」で端末ごとに登録する（Web Push。`push_subscriptions`）。アプリ内通知（未読）が入るとトリガーで `push_queue` に積み、API の書き込みの応答の後と15分おきの定期処理で送る。
  プッシュには本文を載せず、端末の Service Worker（`/sw.js`）が `GET /api/staff/push/latest` で最新の未読を取りに来て表示する（ログインの期限切れ・別の人のログインでは中身を出さない）。
  VAPID の鍵は Secret の `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`（`npx web-push generate-vapid-keys` の形式）を使い、なければ初回に作って `push_vapid_keys` に保存する。送信先はブラウザのプッシュの事業者（FCM・Mozilla・Windows・Apple）だけ

### 5.3 メールと送信失敗
- 既存の `sendEmail` とテンプレートの仕組み（`src/email-templates/`）を使う。送信元・API キー・アプリ URL は既存の環境変数（`MAIL_FROM` / `RESEND_API_KEY` / `APP_BASE_URL` / `MAIL_ENABLED`）
- 送信は申請・承認の DB 処理の後に `waitUntil` で行い、失敗しても申請・承認は取り消さない
- 送信状態は `notification_emails`（delivery_id、company_id、correction_id、event、user_id、to_email、status = `pending` / `sent` / `failed`、error、attempts、last_attempt_at、created_at）に記録する。本文は保存しない
- 再送: 管理者が送信失敗一覧から選んで再送する。本文は申請データから作り直す。結果（成功・失敗）を同じ行に記録する（attempts を加算）
- `MAIL_ENABLED='false'` のときは既存どおり送信せず成功扱い（開発環境）
- 本部アカウント（`system_admin`）は通知の宛先に含めない
- 再送は「送信失敗」の行を「送信中」に切り替えられた場合だけ送る（同時に再送しても送るのは 1 回）
- 管理画面: サイドメニュー「通知」（未読件数）・打刻修正承認 → メール送信状況（`#corrections/emails`）。スタッフ画面: ホームの未読の案内・その他 → 通知（`#notifications`）

## 6. 画面

### 6.1 管理画面（サイドメニューに「勤怠管理」の見出しを追加）
| 画面 | 内容 |
|---|---|
| 案件報告管理（`#report-settings`） | 案件一覧（終了案件も表示切り替えで閲覧可）→ 案件詳細: 案件名・状態・所属スタッフ一覧 × 8 種類の ON/OFF・標準設定・一括変更（確認画面付き）・設定変更履歴。OFF の設定一覧（`#report-settings/off`）とスタッフの全案件の設定（`#report-settings/staff/:id`） |
| 打刻修正承認（`#corrections`） | 状態タブ（承認待ち / 承認済み / 却下 / 取り消し済み / すべて）と絞り込み（案件・スタッフ名・申請期間・対象日・報告種類・申請種類）。詳細パネルに §4.1 の全項目・順序の警告・申請の履歴（再申請の連なり）。状態に応じて承認・却下ボタン。管理者による申請の作成 |
| 送信失敗（打刻修正承認の中のタブ） | 送信失敗の一覧と再送 |
| 履歴（打刻修正承認の中のタブ） | 設定変更履歴・申請履歴の検索と CSV 出力 |
- 既存のシフト詳細パネル・案件パネルの「勤怠報告」の提出設定は、案件報告管理への案内に置き換える（日報の提出設定は残す）
- PC は表、スマートフォンはカードと折りたたみ。既存の `card` / `badge` / `btn` / `inp` クラスと `toast` を使う

### 6.2 スタッフ画面
- ホームの報告ボタン: 8 種類のうち ON のものだけを順に表示（既存の表示の仕組みを拡張）
- 「その他」に「打刻履歴・修正申請」（`#attendance`）を追加: 日付ごとのタイムライン（報告と申請中の内容）→ 各報告から修正申請、未報告の種類から追加申請
- 自分の申請一覧: 状態・内容・結果・却下理由・承認者コメント・取り消し（承認待ちのみ）・再申請（却下のみ）

### 6.3 次回の稼働・前日確認・電波がない場所での報告（w6-staff-app-features: #278 #176 #427。migration 0083）
- 次回の稼働（#278）: `GET /staff/home` の `next_shifts` に、今日より後の最初の稼働日の確定・代打のシフト（同一人物の全所属企業。同じ日は最大5件）を返し、ホームに「次回の稼働」を出す
- 前日確認（#176）: 会社の設定 `settings_json.day_before_check`（`{ enabled, deadline: 'HH:MM' }`。既定は使わない・18:00。`GET/PUT /admin/report-settings/day-before-check`）
  - スタッフ: 明日のシフトに「確認しました」（`POST /staff/day-before-confirm`。`shift_ids`）と「行けなくなった」（相談・連絡を遅刻・欠勤相談で開く）
  - 記録は `shifts.day_before_confirmed_at`・`_key`（確認したときの稼働日・時刻・案件・担当・場所。変わったら未確認に戻る）・`_by`（管理者が電話などで記録したとき。`POST /admin/shifts/:id/day-before-confirm`）
  - ダッシュボード: 明日のシフトの確認状況（未確認を上に、電話番号と「確認済みにする」）。締切を過ぎても未確認の人がいれば ToDo（`day_before:<日付>`）。遅刻の ToDo からこの一覧へ移れる
- 電波がない場所での報告（#427）: アプリは通信に失敗した報告を、押した時刻・位置・写真ごと端末（IndexedDB）に保存し、通信が戻ったら押した順に送る
  - 送るときは `pressed_at`（端末の時計のエポックミリ秒）と `client_request_id`（押すたびに作る一意キー）を付ける。同じキーの再送は記録済みの内容を返す（409 にしない）
  - サーバーは、受け取った時刻より2分を超えて先・12時間より前の時刻を断り、受付の時間帯と記録済みの前の報告との順序は押した時刻で確かめる。押した時刻を使ったときは `attendance_reports.time_source = 'device'`（受け取った時刻は `received_at`、押した時刻は `pressed_at`）。打刻修正で直した報告には印を出さない。遅刻の判定も押した時刻で行う
  - スタッフのホームとダッシュボードの報告状況に「押した時刻で記録」「端末時刻」の印と受け取った時刻を出す。断られた報告はホームに「送れなかった報告」として出し、打刻履歴からの申請を案内する

## 7. API（案）
### 管理者（`/api/admin/*`）
| メソッド | パス | 内容 |
|---|---|---|
| GET | `/report-settings/projects` | 案件一覧（`include_closed`） |
| GET | `/report-settings/projects/:id` | 標準設定・所属スタッフ別の設定 |
| PUT | `/report-settings/projects/:id/default` | 標準設定の変更（§2.5 の値の固定を含む。`version`・`apply`） |
| PUT | `/report-settings/projects/:id/staff/:staffId` | 個別の変更 |
| POST | `/report-settings/projects/:id/bulk` | 一括変更（`dry_run` で確認内容と影響人数を返す） |
| GET | `/report-settings/logs` | 設定変更履歴（案件・スタッフ・期間・報告種類） |
| GET | `/report-settings/exceptions` | 今日以降のシフト単位の例外（`project_id`・`staff_id`） |
| GET | `/report-settings/off-list`（`/export` は CSV） | OFF の設定一覧（`project_id`・`report_type`・`include_default`・`include_inactive`・`include_closed`） |
| GET | `/report-settings/staff/:staffId` | スタッフ 1 人の全案件の設定 |
| POST | `/report-settings/staff/:staffId/apply` | 選んだ案件に同じ設定を当てる（`dry_run` と確認トークン） |
| POST | `/report-settings/staff/:staffId/reset` | 案件の標準設定に戻す（`project_ids` を省くと全案件） |
| GET | `/corrections` | 申請一覧（§6.1 の絞り込み） |
| GET | `/corrections/:id` | 詳細・操作履歴・再申請の連なり |
| POST | `/corrections` | 管理者による申請 |
| POST | `/corrections/:id/approve` | 承認（`comment`、例外承認は `exception: true`） |
| POST | `/corrections/:id/reject` | 却下（`reason` 必須） |
| POST | `/corrections/:id/cancel` | 取り消し（申請者本人のみ） |
| POST | `/corrections/:id/resubmit` | 再申請（申請者本人・却下のみ） |
| GET | `/notification-emails?status=failed` | 送信失敗一覧 |
| POST | `/notification-emails/:id/resend` | 再送 |
| GET | `/corrections/export`、`/report-settings/logs/export` | CSV（管理者のみ。既存の `toCsv` 形式） |
| GET / POST | `/notifications`、`/notifications/:id/read` | アプリ内通知 |

### スタッフ（`/api/staff/*`）
| メソッド | パス | 内容 |
|---|---|---|
| GET | `/attendance/timeline?from=&to=` | 自分のシフトと報告・申請中の内容 |
| GET / POST | `/corrections` | 自分の申請一覧 / 申請 |
| GET | `/corrections/:id` | 自分の申請の詳細 |
| POST | `/corrections/:id/cancel`、`/corrections/:id/resubmit` | 取り消し・再申請 |
| GET / POST | `/notifications`、`/notifications/:id/read` | アプリ内通知 |

### 既存 API の変更
- `POST /staff/attendance`・`/staff/attendance-photo`・報告URL・代理入力: 8 種類に対応。有効な報告と順序をサーバー側で確認（アプリ経由は新たに順序を確認する）
- 代理入力（`POST /admin/shifts/:id/proxy-attendance`）の確認（2026-10 修正）
  - 時刻は種類ごとに `times: { check_in: "HH:MM", ... }` で受け取る。1つの時刻を複数の種類に使わない（旧形式の `time` は種類が1つのときだけ受け付ける）
  - 日付は受け取らない。稼働日の前日・当日・翌日のうち、種類ごとの目安（入店などは予定の開始、勤務終了・退店は予定の終了、休憩は勤務時間の中ほど。`shiftWindow` から決める）に最も近い日付で記録する（夜勤の翌日の休憩・退店など）。起床・出発は翌日に、休憩・勤務終了・退店は前日にしない
  - 空欄の既定値は予定から決める: 入店・勤務開始 = 予定の開始、勤務終了・退店 = 予定の終了、休憩入・休憩出 = 予定の休憩を勤務時間の中ほどに置いた時刻。起床・出発と、予定の休憩がない休憩は入力が必須。押した日時は使わない
  - 不要な種類（400）・報告済み（409）は `checkReportable` と同じ文言で止める。順序は時刻の前後関係で確認する: すでにある報告も含めて時刻が報告の順に並んでいること、入店・勤務開始と勤務終了・退店、休憩入と休憩出が同じ時刻でないこと。前の報告が欠けていても記録できる（起床・出発などは管理者が知らないことがあるため。後から代理入力したときも前後関係を確認する）
  - 現在より後の日時、稼働日より前のシフト、確定済み（409）・欠勤（400）のシフトは受け付けない
  - 入店・勤務開始は、アプリ・報告用URL・打刻修正の承認と同じ `lateness`（`src/report-settings.ts`）で遅刻を判定する。予定の開始（日をまたぐシフトは `shiftWindow` の開始の日時）から、会社の設定の猶予（`companies.settings_json.late_grace_minutes`。案件管理の「遅刻の猶予」。0〜上限の分）を超えたら遅刻にし、遅れた分数を `attendance_reports.late_minutes` に残す。勤務終了・退店が予定の終了より早いときは、早退の分数を `early_leave_minutes` に残す。猶予の変更は、これから記録する報告に効く（記録済みの報告は判定し直さない）
  - 管理画面では、ダッシュボードの報告の印とスタッフ詳細の勤怠報告履歴に「遅刻 n分」「早退 n分」を出す
  - 一意制約で登録できなかった場合（本人の報告と同時）は 409「すでに報告済みです」
- 報告用URL: 統合済みのスタッフと、退職日より後のシフトでは発行・利用できない（退職日当日までは使える）
- `PUT /admin/projects/:id/report-settings`・`PUT /admin/staff/:id/report-settings`: 勤怠の部分は新しい設定に書き込む（画面は案件報告管理へ移す）。日報の部分は従来どおり
- `GET /staff/home`: `required_attendance` を新しい規則で返す（8 種類）

## 8. 保存期間
- 退職日から 7 年の定期削除（`retention.ts`）に、`attendance_corrections`・`attendance_correction_events`・`report_setting_logs`（スタッフ別の行）・`project_staff_report_settings`・`notification_emails` を追加する。退職日が NULL のスタッフは削除しない（既存の規則）
- 案件の標準設定の履歴（staff_id が NULL）は個人情報を含まないため削除しない
- `user_notifications` は 2 年で削除（§5.1）
- 退職日から 7 年で、次も削除する（#193 #228）: 従業員データ（`employee_records`。口座・住所・扶養・緊急連絡先・給与・保険番号）と過去の雇用期間（`employment_periods`）、履歴書など（`staff_documents`）・入社時書類（`employee_documents`）と R2（DOCUMENTS）のファイル、企業間チャット（`roster_comments`・`roster_comment_reads`）、連携の同意履歴（`roster_consents`）。チャットのスレッドは稼働先の連携行の単位なので、連携行と所属元の行（`source_staff_id` / `root_staff_id`）のどちらかが対象になったら消す。同意履歴は連携行の単位で、連携行が対象になったら消す（所属元の行だけが対象になっても、連携先の行が残っている間は連携の根拠として残す）。R2 のファイルは写真と同じく D1 の削除の後に消し、失敗したものは `retention_pending_r2`（`bucket` 列で写真と書類を区別）から次回に再試行する
- 本人情報の匿名化（#480）: `users`・`staff_profiles` の行は請求の集計などから参照されるため残し、氏名を「退職者#staff_id」にして、メール・電話・フリガナ・性別・生年月日・経歴・PR・備考・メモ・現場評価・稼働メモ・最寄駅・未確認のメールなどを消す。パスワードは使えない値にし、セッションと再設定のリンクを消す（`users` はスタッフ本人の行のみ）。済んだ人は `staff_profiles.anonymized_at` を記録し、次の対象に選び直さない
- 労働者名簿・賃金台帳などの法定の保存期間（退職などから 5 年。当分の間 3 年）は、退職後 7 年の削除で下回らない
- 実行ログ（`retention_logs`）には実行元（`trigger_source`: cron / manual）と手動で実行した本部ユーザー、失敗の理由（どのスタッフで何が起きたか、R2 の削除の失敗）を残し、本部画面に出す（#234）
- 毎日の cron の処理（認証の後片付け・応募の削除・定期削除・退職の切り替え・区分変更の予約・既読の記録の削除・既読率レポート）は、`src/index.tsx` の `CRON_JOBS` の順に実行し、処理ごとの結果を `cron_runs` に記録する。本部画面「データ保持・定期処理」に処理ごとの最終実行・成否・エラーを出し、失敗したときと 25 時間以上実行されていないときは本部画面の上部に警告を出す（#192）。個人情報の削除は先に実行し、問い合わせの多い既読率レポートの集計は別の起動（日本時間 3:30）に分けて、1 回あたりの会社数に上限を設ける（#198）
- 定期削除は毎日の cron（`scheduled`）で動く。ビルドは `@hono/vite-build/cloudflare-workers` で、`scheduled` もビルド結果に含まれる。実際に動いたかは本部画面の定期処理の実行状況で確かめる

## 8.1 履歴の検索・CSV（第4段階）
- 管理画面「勤怠管理 > 履歴・CSV」（`#attendance-history`）: 打刻修正の操作履歴（申請・再申請・承認・例外承認・却下・取り消し）と報告設定の変更履歴（全案件）を、期間・案件・スタッフ名・報告の種類・操作で検索し、表示中の条件で CSV を出力する
- 申請の一覧（打刻修正承認）とメール送信状況にも、表示中の条件の CSV 出力を付ける
- CSV は既存の精算と同じ形式（UTF-8 BOM 付き・CRLF・数式インジェクション対策。`src/csv.ts` に共通化）。最大 10,000 件
- CSV を出力できるのは管理ロールのみ（`/api/admin/*`）。自社のデータのみ。案件担当者の概念は作らない方針のため、管理ロール全員が全案件を出力できる

## 9. マイグレーション（0027〜0029）
- 追加: `project_report_defaults`、`project_staff_report_settings`、`report_setting_logs`、`attendance_corrections`（一意インデックス含む）、`attendance_correction_events`、`user_notifications`、`notification_emails` とインデックス
- 移行: §2.4 の初期値の投入と、その履歴（`action='migration'`）
- 既存の列・データは変更・削除しない
- 本番への適用は手動で、デプロイより先に行う: `npm run db:migrate:remote`（= `npx wrangler d1 migrations apply mbsaas-production --remote --env production`）
- `npm run deploy` は直前（`predeploy`）に型チェック（`npm run typecheck`）と、本番の D1 に未適用のマイグレーションがないかの確認（`scripts/check-migrations.mjs`）を行い、どちらかで問題があればデプロイを止める（#340）
- 適用前の戻し先の確保（#213）: ファイルを作らずに戻せる D1 の Time Travel を使う。適用の直前に `npx wrangler d1 time-travel info mbsaas-production` を実行し、表示されたブックマークを作業記録に控える。戻すときは `npx wrangler d1 time-travel restore mbsaas-production --bookmark=<控えたブックマーク>`
- どうしてもエクスポートする場合は、出力先を repo の外にする（例: cmd では `--output="%TEMP%\mbsaas-backup.sql"`、PowerShell では `--output="$env:TEMP\mbsaas-backup.sql"`）。ダンプには口座番号・住所・給与などの個人情報が入るため、作業が終わったら削除し、共有フォルダやチャットに置かない。repo の中に作らない（`.gitignore` で `backup*.sql` などを除外しているが、それに頼らない）
- ロールバック: アプリを前のバージョンに戻せば、旧来の `attendance_mode` の列がそのまま残っているので従来の動作に戻る。ただし新しい設定で行った変更と申請中の内容は旧来の動作に反映されない。新しいテーブルは削除しなくても旧版の動作に影響しない

## 10. テスト
- ローカル（`wrangler dev` + ローカル D1 にマイグレーションとシードを適用）で API を呼ぶ統合テストのスクリプトを `scripts/test-*.mjs` に追加して実行する
- まとめて実行するときは `npm test`（`scripts/run-tests.mjs`。テスト用の D1 を1回作り、テストのファイルごとに複製して `wrangler dev --local` を起動・停止する。`npm test -- <名前の一部>` で絞り込める）
- 1つずつ手で流す場合: `bash scripts/setup-test-db.sh <保存先>` → `npm run build` → `npx wrangler dev --local --port 8799 --persist-to <保存先>` → `node scripts/test-report-settings.mjs` → `node scripts/test-corrections.mjs`（この順で実行。テストのたびに DB を作り直す）
- 対象: 指示書 15 章の項目のうち、担当者に関するものを除くすべて。画面は PC とスマートフォン幅で表示を確認する
- 実行できなかった項目は、理由と未確認の範囲を完了報告に明記する

## 11. 実装の分割（PR）
1. 報告の種類の追加・案件報告管理（設定・一括変更・履歴）・既存の提出設定の一本化・集計の変更
2. 打刻修正申請・承認・取り消し・再申請・スタッフのタイムライン
3. アプリ内通知・メール通知・送信失敗と再送
4. 履歴の検索と CSV 出力・保存期間の対応
