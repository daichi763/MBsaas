-- スタッフ管理拡充 + 社員名簿機能
--
-- 設計方針:
-- ・氏名(users.name)、在籍状況の根幹(users.status/retired_at)は二重管理せず既存のまま利用する。
-- ・既存の users.status('active'/'suspended') は他機能(お知らせ対象・既読率レポート・定期削除等)
--   の判定に既に使われているため変更しない。「在職中/休職中/退職/入社予定」の4区分は
--   staff_profiles.employment_status という別列で新設し、退職のときだけ既存の
--   users.status='suspended' / retired_at と連動させる（アプリ側ロジックで連動）。
-- ・所属会社名(既存 affiliation 列)は自由入力のままだが、表記ゆれ防止のため
--   選択候補となる staff_affiliations マスタ（テナント内）を新設する。自社名は初期値として自動登録する。
-- ・社員名簿(employee_records)は staff_profiles と 1:1。給与改定履歴・有給付与履歴等は
--   仕様通り「現在値のみ」を保持し、履歴テーブルは今回作らない。
-- ・マイナンバーは項目・保存機能とも今回は実装しない（DBカラムを作らない）。
-- ・入社時書類(employee_documents)は既存のDOCUMENTS(履歴書用)R2バケットを
--   キー接頭辞 employee-documents/ で分離して再利用する（新規バケットは作らない）。

-- スタッフ管理の拡充項目
ALTER TABLE staff_profiles ADD COLUMN affiliation_contact TEXT;        -- 所属先担当者名
ALTER TABLE staff_profiles ADD COLUMN kana TEXT;                       -- フリガナ
ALTER TABLE staff_profiles ADD COLUMN gender TEXT;                     -- male / female / other / unspecified
ALTER TABLE staff_profiles ADD COLUMN date_of_birth DATE;              -- 生年月日（年齢はここから自動計算）
ALTER TABLE staff_profiles ADD COLUMN nearest_station_line TEXT;       -- 最寄駅（路線）
ALTER TABLE staff_profiles ADD COLUMN nearest_station TEXT;            -- 最寄駅（駅）
ALTER TABLE staff_profiles ADD COLUMN commute_minutes INTEGER;         -- 通勤可能時間（分）
ALTER TABLE staff_profiles ADD COLUMN available_from DATE;             -- 稼働開始可能日
ALTER TABLE staff_profiles ADD COLUMN employment_status TEXT DEFAULT 'working'; -- working/leave/retired/preboarding

-- 所属会社マスタ（テナント内。既存の会社横断マスタが無いため今回新設。自由入力の表記ゆれ防止用）
CREATE TABLE IF NOT EXISTS staff_affiliations (
  affiliation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  affiliation_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, affiliation_name),
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
-- 自社名を初期候補として自動登録する（社員名簿の「自社社員」判定にも使う基準値）
INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name)
SELECT company_id, company_name FROM companies;

-- 社員名簿（自社社員の人事・労務情報。staff_profilesと1対1）
CREATE TABLE IF NOT EXISTS employee_records (
  employee_record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL UNIQUE,
  company_id INTEGER NOT NULL,
  employee_number TEXT,                  -- 社員番号（会社内で一意）
  -- 在籍・雇用情報
  hire_date DATE,                        -- 入社年月日
  base_location TEXT,                    -- 拠点
  department TEXT,                       -- 所属（部署、所属会社とは別項目）
  job_title TEXT,                        -- 役職
  contract_type TEXT,                    -- 契約形態
  work_style TEXT,                       -- 勤務形態
  scheduled_hours REAL,                  -- 所定労働時間
  scheduled_days_week REAL,              -- 所定労働日数（週）
  scheduled_days_month REAL,             -- 所定労働日数（月）
  hr_staff_user_id INTEGER,              -- 人材担当者（usersを参照）
  -- 個人情報
  postal_code TEXT, prefecture TEXT, city TEXT, town TEXT, address_detail TEXT,
  personal_email TEXT, phone_main TEXT, phone_work TEXT,
  dependents_info TEXT, dependents_count INTEGER,
  -- 緊急連絡先
  emergency_name TEXT, emergency_kana TEXT, emergency_relationship TEXT, emergency_phone TEXT,
  emergency_postal_code TEXT, emergency_prefecture TEXT, emergency_city TEXT, emergency_town TEXT, emergency_address TEXT,
  -- 給与振込口座
  bank_code TEXT, bank_name TEXT, branch_name TEXT, branch_code TEXT, account_type TEXT, account_number TEXT,
  -- 契約情報
  contract_start DATE, contract_end DATE,
  -- 給与情報（現在値のみ。改定履歴は別途「給与支払履歴」として今後拡張する前提で今回は作らない）
  base_salary_type TEXT, base_salary REAL, fixed_overtime_hours REAL, fixed_overtime_pay REAL, gross_pay REAL,
  position_allowance_note TEXT, position_allowance REAL,
  sales_allowance_note TEXT, sales_allowance REAL,
  other_deduction_note TEXT, other_deduction REAL,
  -- 保険情報
  employment_insurance_no TEXT, social_insurance_no TEXT,
  -- 有給情報（現在値のみ）
  paid_leave_granted_at DATE, paid_leave_remaining REAL,
  -- テレワーク残数（月次自動リセットはしない。手動更新のみ）
  telework_remaining_this_month INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, employee_number),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id),
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (hr_staff_user_id) REFERENCES users(user_id)
);

-- 入社時書類（履歴書・契約書と同じ設計パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用）
CREATE TABLE IF NOT EXISTS employee_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  original_file_name TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  uploaded_by INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id),
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_affiliations_company ON staff_affiliations(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_records_company ON employee_records(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_staff ON employee_documents(staff_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_company ON employee_documents(company_id);
