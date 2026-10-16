-- 勤怠報告APIの整合（w2-attendance-report: #95 #458 #519）

-- ---------- #95 勤怠報告は 1 シフト・1 種類につき 1 行 ----------
-- 0001 の CREATE TABLE には UNIQUE(shift_id, report_type) があるが、作成時期の違いで制約のない DB があっても同じになるよう、
-- 重複行を退避してから一意インデックスを付ける（制約のある DB では重複はなく、退避・削除は 0 件）。
-- 残すのは最初に登録された行（attendance_id が最小）。退避した行は attendance_reports_duplicates_0036 に残す
CREATE TABLE IF NOT EXISTS attendance_reports_duplicates_0036 AS SELECT * FROM attendance_reports WHERE 0;
INSERT INTO attendance_reports_duplicates_0036
SELECT * FROM attendance_reports a
WHERE EXISTS (SELECT 1 FROM attendance_reports b WHERE b.shift_id = a.shift_id AND b.report_type = a.report_type AND b.attendance_id < a.attendance_id);
DELETE FROM attendance_reports WHERE attendance_id IN (SELECT attendance_id FROM attendance_reports_duplicates_0036);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_shift_type ON attendance_reports(shift_id, report_type);

-- ---------- #458 報告を始めた後に報告設定が変わったシフトの、変わる前の有効な報告 ----------
-- JSON 配列（例: ["check_in","check_out"]）。NULL は今の設定に従う。案件報告管理でスタッフ別の設定を変えたときに、
-- 報告を始めている昨日・今日のシフトにだけ書き込む（src/report-settings.ts の freezeStartedShifts）
ALTER TABLE shifts ADD COLUMN attendance_types_fixed TEXT;

-- ---------- #519 0027 より前のスタッフ単位の提出設定（none / in_out）の引き継ぎ ----------
-- 0027 は移行の時点でシフトがあった（案件, スタッフ）にだけ行を作ったため、その後に入った案件では案件の標準設定が使われていた。
-- 案件 × スタッフ別の行がない組み合わせに行を作る:
--   - その案件でまだ報告していない組み合わせは、スタッフ単位の設定（none = すべて OFF / in_out = 入店・退店のみ）
--   - すでに報告している組み合わせは、今の動き（案件の標準設定）を保つ
-- これから入る案件は、行ができるまでスタッフ単位の設定を使う（src/report-settings.ts の attendanceTypesForShifts）
INSERT OR IGNORE INTO project_staff_report_settings (project_id, staff_id, company_id, report_type, enabled, source)
WITH t(rt) AS (VALUES ('wake_up'), ('departure'), ('check_in'), ('work_start'), ('break_start'), ('break_end'), ('work_end'), ('check_out')),
pairs AS (
  SELECT DISTINCT s.project_id, s.staff_id, s.company_id, sp.attendance_mode AS mode,
    EXISTS (SELECT 1 FROM attendance_reports a JOIN shifts s2 ON s2.shift_id = a.shift_id WHERE s2.project_id = s.project_id AND s2.staff_id = s.staff_id) AS reported
  FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id
  WHERE sp.attendance_mode IN ('none', 'in_out')
    AND NOT EXISTS (SELECT 1 FROM project_staff_report_settings x WHERE x.project_id = s.project_id AND x.staff_id = s.staff_id)
)
SELECT pairs.project_id, pairs.staff_id, pairs.company_id, t.rt,
  CASE
    WHEN pairs.reported THEN COALESCE((SELECT d.enabled FROM project_report_defaults d WHERE d.project_id = pairs.project_id AND d.report_type = t.rt), 1)
    WHEN pairs.mode = 'none' THEN 0
    WHEN t.rt IN ('check_in', 'check_out') THEN 1
    ELSE 0 END,
  CASE WHEN pairs.reported THEN 'default' ELSE 'migration' END
FROM pairs CROSS JOIN t;

-- 引き継ぎの履歴（日時はアプリの記録と同じ日本時間）
INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, batch_id, created_at)
SELECT r.company_id, r.project_id, r.staff_id, r.report_type, NULL, r.enabled, 'migration', 'migration-0036', datetime('now', '+9 hours')
FROM project_staff_report_settings r
WHERE r.updated_by IS NULL AND r.source IN ('migration', 'default')
  AND NOT EXISTS (SELECT 1 FROM report_setting_logs l WHERE l.project_id = r.project_id AND l.staff_id = r.staff_id AND l.report_type = r.report_type);
