-- 0017: 所属区分の追加・仮登録・区分変更の履歴・雇用終了・勤怠/日報の提出設定・報告用URL・代理入力（第2段階）
-- 仕様: docs/spec_spot_shift.md 第2段階
-- 列とテーブルの追加のみ。既存データの動作は変わらない（提出設定は従来どおり「すべて必要」が既定）。

-- ---------- スタッフ: 仮登録・提出設定 ----------
-- affiliation_type に 'daily_worker'（自社日雇い）/ 'freelance'（個人事業主）を追加（TEXT 列のため DDL 変更は不要）
ALTER TABLE staff_profiles ADD COLUMN is_provisional INTEGER DEFAULT 0;   -- 1 = 仮登録（氏名・電話のみで稼働可）
ALTER TABLE staff_profiles ADD COLUMN attendance_mode TEXT;              -- NULL=案件の設定に従う / none / in_out / full
ALTER TABLE staff_profiles ADD COLUMN daily_report_mode TEXT;            -- NULL=案件の設定に従う / none / required

-- ---------- 案件: 提出設定の初期値 ----------
ALTER TABLE projects ADD COLUMN attendance_mode TEXT DEFAULT 'full';
ALTER TABLE projects ADD COLUMN daily_report_mode TEXT DEFAULT 'required';

-- ---------- シフト: 提出設定の上書き ----------
ALTER TABLE shifts ADD COLUMN attendance_mode TEXT;
ALTER TABLE shifts ADD COLUMN daily_report_mode TEXT;

-- ---------- 勤怠報告: 入力経路 ----------
ALTER TABLE attendance_reports ADD COLUMN entry_method TEXT DEFAULT 'app';  -- app / link（報告用URL）/ proxy（管理者の代理入力）
ALTER TABLE attendance_reports ADD COLUMN entered_by INTEGER;               -- 代理入力した管理者の user_id
ALTER TABLE daily_reports ADD COLUMN entry_method TEXT DEFAULT 'app';

-- ---------- 従業員管理: 雇用終了（スタッフとしての退職とは別） ----------
ALTER TABLE employee_records ADD COLUMN employment_ended_at DATE;          -- 雇用終了日（自社雇用 → 他区分へ移行した日の前日）
ALTER TABLE employee_records ADD COLUMN ended_reason TEXT;

-- ---------- 所属区分の変更履歴 ----------
CREATE TABLE IF NOT EXISTS staff_affiliation_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  effective_date DATE NOT NULL,                  -- この日以降のシフトは to_type として扱う
  from_affiliation TEXT,
  to_affiliation TEXT,
  partner_affiliation_id INTEGER,
  affected_shifts INTEGER DEFAULT 0,
  note TEXT,
  changed_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id)
);
CREATE INDEX IF NOT EXISTS idx_aff_history_staff ON staff_affiliation_history(staff_id, effective_date);

-- ---------- シフト専用の報告用URL（ログイン不要。そのシフトの勤怠・日報のみ） ----------
CREATE TABLE IF NOT EXISTS shift_report_tokens (
  token TEXT PRIMARY KEY,
  shift_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,                  -- 稼働日の翌日 23:59（日本時間）
  revoked INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  FOREIGN KEY (shift_id) REFERENCES shifts(shift_id)
);
CREATE INDEX IF NOT EXISTS idx_report_tokens_shift ON shift_report_tokens(shift_id);
