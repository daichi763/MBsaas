-- w3-report-admin（#183 #212 #360）
-- 1) 索引（#212）
--    daily_reports.shift_id は 0035 の一意索引（ux_daily_reports_shift）があるので足さない。
--    案件ごとの日報（案件一覧・案件詳細・ダッシュボード・日報一覧の案件の絞り込み）は project_id と稼働日で引く。
--    shifts.slot_id は枠の削除・繰り返し登録の削除・枠の更新でシフトを引く。
CREATE INDEX IF NOT EXISTS idx_daily_reports_project_date ON daily_reports(project_id, work_date);
CREATE INDEX IF NOT EXISTS idx_shifts_slot ON shifts(slot_id);
-- 日報一覧の「未確認のみ」（#183）。条件の式は api.ts GET /admin/daily-reports と同じにする（同じ式でないと索引が使われない）
CREATE INDEX IF NOT EXISTS idx_daily_reports_unchecked ON daily_reports(company_id, work_date) WHERE COALESCE(manager_checked, 0) = 0;

-- 2) コメント・確認済みを、誰がいつ付けたか（#360）
ALTER TABLE daily_reports ADD COLUMN manager_comment_by INTEGER;
ALTER TABLE daily_reports ADD COLUMN manager_comment_at DATETIME;
ALTER TABLE daily_reports ADD COLUMN manager_checked_by INTEGER;
ALTER TABLE daily_reports ADD COLUMN manager_checked_at DATETIME;
