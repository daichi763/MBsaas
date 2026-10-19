-- w2-daily-report（#16 #61 #73）
-- 日報をシフト（shift_id）単位で1件にする。
-- 1) 同じシフトの日報が複数ある場合（二度押しなど）は、最後に提出された1件を残す。
--    残す行には、インシデント・クレームの印と管理者のコメントを引き継ぐ。
--    残さない行は daily_report_duplicates に控えを移してから消す（中身を失わないように）。
-- 2) shift_id の無い古い日報は、同じ会社・スタッフ・稼働日・案件のシフトが1件だけで、
--    そのシフトの日報がまだ無いときに限り shift_id を補う（同じ組の古い日報が複数あれば最後の1件だけ）。
--    shift_id の無い古い日報で、同じ組にもっと新しい日報がある行も、二度押しなどの重複として 1) と同じく控えに移す。
-- 3) shift_id に一意インデックスを付ける（SQLite の一意インデックスは NULL を重複とみなさないので、shift_id の無い古い行はそのまま残る）。
-- 4) 管理者が確認済みにした日報を、スタッフが後から修正したときの日時（revised_after_check_at）を足す。

CREATE TABLE IF NOT EXISTS daily_report_duplicates (
  daily_report_id INTEGER PRIMARY KEY,
  kept_daily_report_id INTEGER NOT NULL,  -- 代わりに残した日報
  company_id INTEGER,
  staff_id INTEGER,
  project_id INTEGER,
  shift_id INTEGER,
  work_date DATE,
  report_values TEXT,
  incident_flag INTEGER,
  complaint_flag INTEGER,
  manager_comment TEXT,
  manager_checked INTEGER,
  submitted_at DATETIME,
  entry_method TEXT,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_daily_report_duplicates_staff ON daily_report_duplicates(staff_id);

-- 下の整理は shift_id ごと（shift_id の無い行はスタッフ・稼働日・案件ごと）に日報を引くので、作業用の索引を先に作る（無いと日報の行数の2乗の読み取りになる）。最後に消す
CREATE INDEX IF NOT EXISTS idx_daily_reports_shift_tmp ON daily_reports(shift_id, staff_id, work_date, project_id);

-- 1) 残す行（シフトごとに最後に提出された1件）に、同じシフトのほかの行の印とコメントを引き継ぐ
UPDATE daily_reports SET
  incident_flag = (SELECT MAX(COALESCE(d.incident_flag, 0)) FROM daily_reports d WHERE d.shift_id = daily_reports.shift_id),
  complaint_flag = (SELECT MAX(COALESCE(d.complaint_flag, 0)) FROM daily_reports d WHERE d.shift_id = daily_reports.shift_id),
  manager_comment = COALESCE(manager_comment, (SELECT d.manager_comment FROM daily_reports d
    WHERE d.shift_id = daily_reports.shift_id AND d.manager_comment IS NOT NULL ORDER BY d.submitted_at DESC, d.daily_report_id DESC LIMIT 1))
WHERE shift_id IS NOT NULL
  AND shift_id IN (SELECT shift_id FROM daily_reports WHERE shift_id IS NOT NULL GROUP BY shift_id HAVING COUNT(*) > 1)
  AND daily_report_id = (SELECT d2.daily_report_id FROM daily_reports d2 WHERE d2.shift_id = daily_reports.shift_id
    ORDER BY d2.submitted_at DESC, d2.daily_report_id DESC LIMIT 1);

-- 残さない行の控え
INSERT OR IGNORE INTO daily_report_duplicates (daily_report_id, kept_daily_report_id, company_id, staff_id, project_id, shift_id, work_date,
  report_values, incident_flag, complaint_flag, manager_comment, manager_checked, submitted_at, entry_method)
SELECT d.daily_report_id,
  (SELECT d2.daily_report_id FROM daily_reports d2 WHERE d2.shift_id = d.shift_id ORDER BY d2.submitted_at DESC, d2.daily_report_id DESC LIMIT 1),
  d.company_id, d.staff_id, d.project_id, d.shift_id, d.work_date, d.report_values, d.incident_flag, d.complaint_flag,
  d.manager_comment, d.manager_checked, d.submitted_at, d.entry_method
FROM daily_reports d
WHERE d.shift_id IS NOT NULL
  AND d.shift_id IN (SELECT shift_id FROM daily_reports WHERE shift_id IS NOT NULL GROUP BY shift_id HAVING COUNT(*) > 1)
  AND d.daily_report_id != (SELECT d2.daily_report_id FROM daily_reports d2 WHERE d2.shift_id = d.shift_id
    ORDER BY d2.submitted_at DESC, d2.daily_report_id DESC LIMIT 1);

-- 控えに移した行だけを消す
DELETE FROM daily_reports WHERE daily_report_id IN (SELECT daily_report_id FROM daily_report_duplicates);

-- 2) shift_id の無い古い日報に shift_id を補う（列の前の + は、絞り込みの弱い索引（案件・会社）を使わせないため）
UPDATE daily_reports SET shift_id = (SELECT s.shift_id FROM shifts s
    WHERE s.company_id = daily_reports.company_id AND s.staff_id = daily_reports.staff_id
      AND s.work_date = daily_reports.work_date AND +s.project_id = daily_reports.project_id)
WHERE shift_id IS NULL
  AND (SELECT COUNT(*) FROM shifts s
    WHERE s.company_id = daily_reports.company_id AND s.staff_id = daily_reports.staff_id
      AND s.work_date = daily_reports.work_date AND +s.project_id = daily_reports.project_id) = 1
  AND NOT EXISTS (SELECT 1 FROM daily_reports d2 JOIN shifts s ON s.shift_id = d2.shift_id
    WHERE s.company_id = daily_reports.company_id AND s.staff_id = daily_reports.staff_id
      AND s.work_date = daily_reports.work_date AND +s.project_id = daily_reports.project_id)
  AND daily_report_id = (SELECT d3.daily_report_id FROM daily_reports d3
    WHERE d3.shift_id IS NULL AND +d3.company_id = daily_reports.company_id AND d3.staff_id = daily_reports.staff_id
      AND d3.work_date = daily_reports.work_date AND d3.project_id = daily_reports.project_id
    ORDER BY d3.submitted_at DESC, d3.daily_report_id DESC LIMIT 1);

-- 2b) shift_id の無い古い日報の重複。変更前の登録は同じ会社・スタッフ・稼働日・案件の行を上書きしていたので、
--     同じ組に2行以上あるのは同時に送られた場合だけ。組の中で最後に提出された行（shift_id の有無は問わない）を残し、
--     それより古い shift_id の無い行を控えに移す（shift_id のある行は 1) で整理済みなので動かさない）
UPDATE daily_reports SET
  incident_flag = MAX(COALESCE(incident_flag, 0), (SELECT COALESCE(MAX(d.incident_flag), 0) FROM daily_reports d
    WHERE d.shift_id IS NULL AND d.company_id = daily_reports.company_id AND d.staff_id = daily_reports.staff_id
      AND d.work_date = daily_reports.work_date AND d.project_id = daily_reports.project_id)),
  complaint_flag = MAX(COALESCE(complaint_flag, 0), (SELECT COALESCE(MAX(d.complaint_flag), 0) FROM daily_reports d
    WHERE d.shift_id IS NULL AND d.company_id = daily_reports.company_id AND d.staff_id = daily_reports.staff_id
      AND d.work_date = daily_reports.work_date AND d.project_id = daily_reports.project_id)),
  manager_comment = COALESCE(manager_comment, (SELECT d.manager_comment FROM daily_reports d
    WHERE d.shift_id IS NULL AND d.company_id = daily_reports.company_id AND d.staff_id = daily_reports.staff_id
      AND d.work_date = daily_reports.work_date AND d.project_id = daily_reports.project_id AND d.manager_comment IS NOT NULL
    ORDER BY d.submitted_at DESC, d.daily_report_id DESC LIMIT 1))
WHERE EXISTS (SELECT 1 FROM daily_reports d WHERE d.shift_id IS NULL AND d.daily_report_id != daily_reports.daily_report_id
      AND d.company_id = daily_reports.company_id AND d.staff_id = daily_reports.staff_id
      AND d.work_date = daily_reports.work_date AND d.project_id = daily_reports.project_id)
  AND daily_report_id = (SELECT g.daily_report_id FROM daily_reports g
    WHERE g.company_id = daily_reports.company_id AND g.staff_id = daily_reports.staff_id
      AND g.work_date = daily_reports.work_date AND g.project_id = daily_reports.project_id
    ORDER BY g.submitted_at DESC, g.daily_report_id DESC LIMIT 1);

INSERT OR IGNORE INTO daily_report_duplicates (daily_report_id, kept_daily_report_id, company_id, staff_id, project_id, shift_id, work_date,
  report_values, incident_flag, complaint_flag, manager_comment, manager_checked, submitted_at, entry_method)
SELECT d.daily_report_id, k.kept_id,
  d.company_id, d.staff_id, d.project_id, d.shift_id, d.work_date, d.report_values, d.incident_flag, d.complaint_flag,
  d.manager_comment, d.manager_checked, d.submitted_at, d.entry_method
FROM daily_reports d
JOIN (SELECT x.daily_report_id AS id, (SELECT g.daily_report_id FROM daily_reports g
    WHERE g.company_id = x.company_id AND g.staff_id = x.staff_id AND g.work_date = x.work_date AND g.project_id = x.project_id
    ORDER BY g.submitted_at DESC, g.daily_report_id DESC LIMIT 1) AS kept_id
  FROM daily_reports x WHERE x.shift_id IS NULL) k ON k.id = d.daily_report_id
WHERE k.kept_id IS NOT NULL AND k.kept_id != d.daily_report_id;

DELETE FROM daily_reports WHERE daily_report_id IN (SELECT daily_report_id FROM daily_report_duplicates);

-- 3) シフトごとに1件（登録は INSERT ... ON CONFLICT(shift_id) DO UPDATE。src/lib/daily-report.ts）
CREATE UNIQUE INDEX IF NOT EXISTS ux_daily_reports_shift ON daily_reports(shift_id);
DROP INDEX IF EXISTS idx_daily_reports_shift_tmp;

-- 4) 確認済みの後の修正
ALTER TABLE daily_reports ADD COLUMN revised_after_check_at DATETIME;
