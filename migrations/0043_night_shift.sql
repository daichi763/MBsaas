-- 遅刻・早退の分数（w3-night-shift: #219 #497）
--
-- attendance_reports.late_minutes: 入店・勤務開始が、シフト開始の日時（稼働日＋開始時刻）より何分遅れたか（遅れていなければ 0）。
--   ほかの報告は NULL。status = 'late' は、この分数が会社設定の猶予（companies.settings_json の late_grace_minutes。既定 0 分）を超えたもの。
--   画面で『遅刻 n分』を出すときは status = 'late' の行だけを使う（猶予内の遅れは status が normal / no_location のまま）
-- attendance_reports.early_leave_minutes: 勤務終了・退店が、シフト終了の日時（日をまたぐ勤務は翌日）より何分早かったか（早くなければ 0）。
--   ほかの報告は NULL。0 より大きければ早退。status は変えない
-- どちらも報告を書き込むときに src/report-settings.ts の lateness で判定する（アプリ・写真付き・報告用URL・代理入力）

ALTER TABLE attendance_reports ADD COLUMN late_minutes INTEGER;
ALTER TABLE attendance_reports ADD COLUMN early_leave_minutes INTEGER;

-- 記録済みの報告にも、今のシフトの予定から分数を入れる（status は変えない。秒は切り捨てて分で比べる）
UPDATE attendance_reports
SET late_minutes = (
  SELECT MAX(0, CAST(ROUND((julianday(substr(attendance_reports.reported_at, 1, 16)) - julianday(s.work_date || ' ' || s.start_time)) * 1440) AS INTEGER))
  FROM shifts s WHERE s.shift_id = attendance_reports.shift_id
)
WHERE report_type IN ('check_in', 'work_start') AND shift_id IS NOT NULL AND late_minutes IS NULL;

UPDATE attendance_reports
SET early_leave_minutes = (
  SELECT MAX(0, CAST(ROUND((julianday(s.work_date || ' ' || s.end_time) + (CASE WHEN s.end_time <= s.start_time THEN 1 ELSE 0 END)
    - julianday(substr(attendance_reports.reported_at, 1, 16))) * 1440) AS INTEGER))
  FROM shifts s WHERE s.shift_id = attendance_reports.shift_id
)
WHERE report_type IN ('work_end', 'check_out') AND shift_id IS NOT NULL AND early_leave_minutes IS NULL;
