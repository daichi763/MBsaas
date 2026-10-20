-- 0067: 日報・実績の機能追加（w5-report-features: #169 #292）
-- 列・索引の追加だけ。既存の値は変えない。

-- ---------- #169 インシデント・クレームの対応状況 ----------
-- incident_status: NULL（未対応。印が付いた日報の初期値）/ in_progress（対応中）/ done（対応済み）
-- 対応メモ・最後に更新した人と日時・クライアントに共有した日時を残す（PUT /api/admin/daily-reports/:id/incident）
ALTER TABLE daily_reports ADD COLUMN incident_status TEXT;
ALTER TABLE daily_reports ADD COLUMN incident_memo TEXT;
ALTER TABLE daily_reports ADD COLUMN incident_updated_by INTEGER;
ALTER TABLE daily_reports ADD COLUMN incident_updated_at DATETIME;
ALTER TABLE daily_reports ADD COLUMN incident_client_shared_at DATETIME;
-- 日報一覧の「未対応のインシデント・クレームのみ」。条件の式は api.ts の DR_INCIDENT_OPEN_SQL と同じにする
CREATE INDEX IF NOT EXISTS idx_daily_reports_incident_open ON daily_reports(company_id, work_date)
  WHERE (incident_flag = 1 OR complaint_flag = 1) AND COALESCE(incident_status, 'open') != 'done';

-- ---------- #292 案件ごとの月間目標件数 ----------
-- 日報テンプレートの数値項目のキーごとの、スタッフ1人あたりの月間目標（例: {"seiyaku":30,"mnp":10}）。NULL は目標なし
ALTER TABLE projects ADD COLUMN performance_goals_json TEXT;
