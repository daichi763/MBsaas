-- 管理画面の重い集計とスタッフのアプリの読み込みを軽くする索引（Sprint 19。#9937。w19-heavy-read）
-- 索引の追加のみ（表・列・値は変えない）。画面に出る数・並びは変わらない（読む行を減らすだけ）。

-- 1. 案件ごとの、ある期間のシフト（案件一覧の稼働人数・シフト数、スタッフ一覧の「今月成約」の対象の人）。
--    これまでの idx_shifts_project（案件だけ）では、案件のすべての期間のシフトを読んでいた
CREATE INDEX IF NOT EXISTS idx_shifts_project_date ON shifts(project_id, work_date);

-- 2. ダッシュボードの「遅刻が月2回以上」。遅刻と判定された報告だけの部分索引（会社のすべての期間の打刻を読まない）
CREATE INDEX IF NOT EXISTS idx_attendance_late ON attendance_reports(company_id, report_type) WHERE status = 'late';

-- 3. ダッシュボードの「欠勤が月2回以上」。欠勤のシフトだけの部分索引（月のすべてのシフトを読まない）
CREATE INDEX IF NOT EXISTS idx_shifts_absent ON shifts(company_id, work_date) WHERE status = 'absent';

-- 4. インシデント・クレームの印のある日報だけの部分索引（対応済みも含む）。
--    会社と日付: ダッシュボードの直近7日。案件と日付: 案件一覧の月の件数・案件詳細の一覧
CREATE INDEX IF NOT EXISTS idx_daily_reports_flagged ON daily_reports(company_id, work_date) WHERE incident_flag = 1 OR complaint_flag = 1;
CREATE INDEX IF NOT EXISTS idx_daily_reports_project_flagged ON daily_reports(project_id, work_date) WHERE incident_flag = 1 OR complaint_flag = 1;
