-- 0065: 案件の編集・終了、企業の日報テンプレート、スタッフ評価（w5-projects-features: #153 #164 #165）
-- 列・索引の追加だけ。既存の値は変えない。

-- ---------- #153 案件の終了 ----------
-- projects.status は active（稼働中）/ closed（終了）。終了した日時と操作した人を残す（稼働中に戻すと NULL にする）
ALTER TABLE projects ADD COLUMN closed_at DATETIME;
ALTER TABLE projects ADD COLUMN closed_by INTEGER;
ALTER TABLE projects ADD COLUMN updated_at DATETIME;

-- ---------- #165 日報テンプレートの編集・配信停止 ----------
-- status: active（選べる）/ stopped（配信停止。新しい案件では選べないが、使っている案件はそのまま使える）
ALTER TABLE report_templates ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE report_templates ADD COLUMN updated_at DATETIME;
ALTER TABLE report_templates ADD COLUMN updated_by INTEGER;
CREATE INDEX IF NOT EXISTS idx_report_templates_company ON report_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_projects_template ON projects(report_template_id);

-- ---------- #164 スタッフ評価 ----------
-- 同じ会社・スタッフ・期間（YYYY-MM）は1件にする（登録は上書き）。既存の重複に備えて一意制約にはしない
ALTER TABLE evaluations ADD COLUMN updated_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_evaluations_company_staff_period ON evaluations(company_id, staff_id, evaluation_period);
