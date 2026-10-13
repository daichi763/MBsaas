-- 案件報告管理（docs/spec_attendance_correction.md 2章・3章）
-- 勤怠報告を 8 種類（起床・出発・入店・勤務開始・休憩入・休憩出・勤務終了・退店）に広げ、
-- 案件の標準設定と「案件 × スタッフ」別の設定で ON/OFF する。
-- 案件・スタッフ単位の提出設定（projects.attendance_mode / staff_profiles.attendance_mode）はこの設定に移し、以後は読まない（列は残す）。
-- シフト単位の例外（shifts.attendance_mode）と日報の提出設定（daily_report_mode）は従来どおり。
-- attendance_reports.report_type は TEXT のため、新しい 4 種類の追加に DDL 変更は不要。

-- 案件の標準設定（新しく所属したスタッフに引き継ぐ値）
CREATE TABLE IF NOT EXISTS project_report_defaults (
  project_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER,
  updated_at DATETIME DEFAULT (datetime('now', '+9 hours')),
  PRIMARY KEY (project_id, report_type)
);
CREATE INDEX IF NOT EXISTS idx_project_report_defaults_company ON project_report_defaults(company_id);

-- 案件 × スタッフ別の設定（実際に適用する値。行がなければ案件の標準設定）
-- source: default（標準設定の引き継ぎ）/ individual（個別変更）/ bulk（一括変更）/ migration（導入時の移行）
CREATE TABLE IF NOT EXISTS project_staff_report_settings (
  project_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'individual',
  updated_by INTEGER,
  updated_at DATETIME DEFAULT (datetime('now', '+9 hours')),
  PRIMARY KEY (project_id, staff_id, report_type)
);
CREATE INDEX IF NOT EXISTS idx_project_staff_report_settings_staff ON project_staff_report_settings(staff_id);
CREATE INDEX IF NOT EXISTS idx_project_staff_report_settings_company ON project_staff_report_settings(company_id);

-- 設定変更の履歴（追記のみ。更新・削除の API は作らない）
-- staff_id が NULL の行は案件の標準設定の変更
-- action: project_default / individual / bulk / migration
CREATE TABLE IF NOT EXISTS report_setting_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  staff_id INTEGER,
  report_type TEXT NOT NULL,
  old_enabled INTEGER,
  new_enabled INTEGER NOT NULL,
  action TEXT NOT NULL,
  batch_id TEXT,
  changed_by INTEGER,
  changed_by_name TEXT,
  changed_by_role TEXT,
  created_at DATETIME DEFAULT (datetime('now', '+9 hours'))   -- 日本時間（アプリは nowJST() で記録）
);
CREATE INDEX IF NOT EXISTS idx_report_setting_logs_company ON report_setting_logs(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_setting_logs_project ON report_setting_logs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_setting_logs_staff ON report_setting_logs(staff_id);

-- ---------- 導入時の移行 ----------
-- 提出設定の値 → 8 種類: full（既定）・NULL・不正な値 = すべて ON / in_out = 入店・退店のみ ON / none = すべて OFF
-- 案件の標準設定
INSERT OR IGNORE INTO project_report_defaults (project_id, company_id, report_type, enabled)
WITH t(rt) AS (VALUES ('wake_up'), ('departure'), ('check_in'), ('work_start'), ('break_start'), ('break_end'), ('work_end'), ('check_out'))
SELECT p.project_id, p.company_id, t.rt,
  CASE COALESCE(p.attendance_mode, 'full')
    WHEN 'none' THEN 0
    WHEN 'in_out' THEN CASE WHEN t.rt IN ('check_in', 'check_out') THEN 1 ELSE 0 END
    ELSE 1 END
FROM projects p CROSS JOIN t;

-- 案件 × スタッフ別（シフトがある組み合わせ。スタッフ単位の提出設定があればそれを、なければ案件の設定を使う）
INSERT OR IGNORE INTO project_staff_report_settings (project_id, staff_id, company_id, report_type, enabled, source)
WITH t(rt) AS (VALUES ('wake_up'), ('departure'), ('check_in'), ('work_start'), ('break_start'), ('break_end'), ('work_end'), ('check_out')),
pairs AS (
  SELECT DISTINCT s.project_id, s.staff_id, s.company_id,
    CASE WHEN sp.attendance_mode IN ('none', 'in_out', 'full') THEN sp.attendance_mode ELSE COALESCE(p.attendance_mode, 'full') END AS mode
  FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN projects p ON p.project_id = s.project_id
)
SELECT pairs.project_id, pairs.staff_id, pairs.company_id, t.rt,
  CASE pairs.mode
    WHEN 'none' THEN 0
    WHEN 'in_out' THEN CASE WHEN t.rt IN ('check_in', 'check_out') THEN 1 ELSE 0 END
    ELSE 1 END,
  'migration'
FROM pairs CROSS JOIN t;

-- 移行の履歴（日時はアプリの記録と同じ日本時間）
INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, batch_id, created_at)
SELECT company_id, project_id, NULL, report_type, NULL, enabled, 'migration', 'migration-0027', datetime('now', '+9 hours') FROM project_report_defaults;
INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, batch_id, created_at)
SELECT company_id, project_id, staff_id, report_type, NULL, enabled, 'migration', 'migration-0027', datetime('now', '+9 hours') FROM project_staff_report_settings;
