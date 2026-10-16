-- =========================================================
-- 所属区分の変更（w2-status-change: #82 #99 #121）
-- 既存の行は変えない（表・列の追加のみ）
-- =========================================================

-- ---------- 未来の適用日の区分変更（予約）。適用日の早朝に cron（applyDueAffiliationSchedules）が切り替える ----------
-- status: pending（予約中）/ applied（適用済み）/ canceled（取消）/ failed（適用できなかった。error に理由）
CREATE TABLE IF NOT EXISTS staff_affiliation_schedules (
  schedule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,                       -- 予約した時点の区分（参考）
  to_type TEXT NOT NULL,
  effective_date DATE NOT NULL,
  to_affiliation TEXT,
  partner_affiliation_id INTEGER,                -- 取引先所属への変更のときの取引先（予約時に取引先マスタへ登録済み）
  request_json TEXT NOT NULL DEFAULT '{}',       -- 予約した内容（屋号・入社日・雇用形態・メモ）
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  history_id INTEGER,                            -- 適用したときの staff_affiliation_history
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME,
  canceled_by INTEGER,
  canceled_at DATETIME,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id)
);
-- 予約は1人につき1件まで
CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_schedules_pending ON staff_affiliation_schedules(staff_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_aff_schedules_due ON staff_affiliation_schedules(status, effective_date);

-- ---------- 区分変更の前の支払先（#82） ----------
-- 適用日より前のシフトの単価を計算し直したときに、変更前の支払先を使う（shift-board.ts の resolvePayee）。
-- この列が空の履歴（このマイグレーションより前の変更・統合の記録）は、従来どおり今の区分から支払先を決める
ALTER TABLE staff_affiliation_history ADD COLUMN from_payee_type TEXT;
ALTER TABLE staff_affiliation_history ADD COLUMN from_payee_affiliation_id INTEGER;
ALTER TABLE staff_affiliation_history ADD COLUMN from_payee_company_id INTEGER;
ALTER TABLE staff_affiliation_history ADD COLUMN excluded_shifts INTEGER DEFAULT 0;   -- 勤務済み（報告・実績・日報あり）で置き換えなかった件数

-- ---------- 過去の雇用期間（#99） ----------
-- 自社雇用に戻す（再雇用）ときに、employee_records の入社日・雇用終了日を上書きする前の値を残す。7年保存の対象
CREATE TABLE IF NOT EXISTS employment_periods (
  period_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  hire_date DATE,
  employment_ended_at DATE,
  ended_reason TEXT,
  contract_type TEXT,
  recorded_by INTEGER,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id)
);
CREATE INDEX IF NOT EXISTS idx_employment_periods_staff ON employment_periods(staff_id);
