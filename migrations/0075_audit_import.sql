-- 従業員データの変更履歴と、スタッフの CSV 一括登録（w5-audit-import: #464 #430）
--
-- #464 従業員管理（employee_records: 口座・給与・住所・保険番号など）と、スタッフ基本情報（氏名・生年月日・在籍状況・退職日など）の
--   変更履歴。保存のたびに、変わった項目だけを1行ずつ残す（誰が・いつ・前の値・新しい値）。
--   口座番号・雇用保険番号・社会保険番号は下4桁だけを残す（アプリ側でマスクしてから入れる）。
--   source: employee（従業員管理の項目）/ profile（スタッフ基本情報。スタッフマスタ画面からの変更を含む）
--   本人の匿名化（退職後7年の定期削除）と、スタッフの行の削除で、その人の履歴も消す（トリガー）。
-- #430 の CSV 一括登録は既存の表（users・staff_profiles・employee_records・staff_affiliations）に入れるため、表の追加はない。
CREATE TABLE IF NOT EXISTS employee_change_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  source TEXT NOT NULL,                  -- employee / profile
  field TEXT NOT NULL,                   -- 列名（employee_records・staff_profiles・users の列）
  old_value TEXT,
  new_value TEXT,
  changed_by INTEGER,                    -- 変更したユーザー
  changed_at TEXT NOT NULL               -- 日本時間
);
CREATE INDEX IF NOT EXISTS idx_employee_change_logs_staff ON employee_change_logs(staff_id, log_id);
CREATE INDEX IF NOT EXISTS idx_employee_change_logs_company ON employee_change_logs(company_id, changed_at);

CREATE TRIGGER IF NOT EXISTS trg_employee_change_logs_anonymize AFTER UPDATE OF anonymized_at ON staff_profiles
WHEN NEW.anonymized_at IS NOT NULL
BEGIN
  DELETE FROM employee_change_logs WHERE staff_id = NEW.staff_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_employee_change_logs_delete AFTER DELETE ON staff_profiles
BEGIN
  DELETE FROM employee_change_logs WHERE staff_id = OLD.staff_id;
END;
