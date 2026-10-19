-- 案件報告管理の残り（w4-report-settings: #509 #313 #268 #446）

-- ---------- #509 案件の標準設定の版番号（楽観ロック） ----------
-- 標準設定を保存するたびに 1 進める。画面を開いた時点の版番号と違えば、保存せずに読み込み直しを求める（src/report-settings.ts の setProjectDefaults）
ALTER TABLE projects ADD COLUMN report_defaults_version INTEGER NOT NULL DEFAULT 0;

-- ---------- #313 シフト単位の例外を設定変更の履歴に残す ----------
-- action='shift_override' の行に、対象のシフトと内容（勤務日・時間・変更前後の例外）を入れる。ほかの操作では NULL
ALTER TABLE report_setting_logs ADD COLUMN shift_id INTEGER;
ALTER TABLE report_setting_logs ADD COLUMN detail TEXT;
CREATE INDEX IF NOT EXISTS idx_report_setting_logs_shift ON report_setting_logs(shift_id) WHERE shift_id IS NOT NULL;
-- 今日以降のシフトの例外の一覧（案件報告管理・OFF の設定一覧）
CREATE INDEX IF NOT EXISTS idx_shifts_attendance_exception ON shifts(company_id, work_date) WHERE attendance_mode IN ('none', 'in_out');

-- ---------- #446 案件をまたいだ OFF の設定一覧 ----------
CREATE INDEX IF NOT EXISTS idx_project_staff_report_settings_off ON project_staff_report_settings(company_id, report_type) WHERE enabled = 0;

-- ---------- #268 個別に変えた人の印 ----------
-- 画面の『個別』は、個別変更・一括変更（source が individual / bulk）の行がある人だけにする。
-- 0027・0036 の移行の行のうち、スタッフ単位の提出設定（none / in_out。本人に明示した設定）から作った組み合わせは、
-- 移行の後に誰も変えていなければ『個別』の印（source='individual'）にする。値（enabled）は変えない。
-- 案件の設定を写しただけの移行の行は source='migration' のまま（画面では『標準（引き継ぎ）』）
-- （組み合わせは更新の前に1回だけ求める。相関サブクエリにすると、更新中の行を見て一部だけが変わるおそれがある）
UPDATE project_staff_report_settings SET source = 'individual'
WHERE source = 'migration'
  AND staff_id IN (SELECT staff_id FROM staff_profiles WHERE attendance_mode IN ('none', 'in_out'))
  AND (project_id, staff_id) IN (SELECT project_id, staff_id FROM project_staff_report_settings
    GROUP BY project_id, staff_id HAVING SUM(CASE WHEN source = 'migration' THEN 0 ELSE 1 END) = 0);
