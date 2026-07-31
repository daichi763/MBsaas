-- パフォーマンス改善用インデックス追加
-- (company_id / staff_id 等での絞り込みが多い箇所を対象)
-- 既に 0001_initial_schema.sql で作成済みのインデックスは除外している
CREATE INDEX IF NOT EXISTS idx_staff_profiles_company ON staff_profiles(company_id);
CREATE INDEX IF NOT EXISTS idx_clients_company ON clients(company_id);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);
CREATE INDEX IF NOT EXISTS idx_shifts_project ON shifts(project_id);
CREATE INDEX IF NOT EXISTS idx_attendance_staff ON attendance_reports(staff_id);
CREATE INDEX IF NOT EXISTS idx_attendance_company ON attendance_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_staff ON evaluations(staff_id);
CREATE INDEX IF NOT EXISTS idx_follow_logs_staff ON follow_logs(staff_id);
CREATE INDEX IF NOT EXISTS idx_notice_reads_user ON notice_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_consultations_staff ON consultations(staff_id);
