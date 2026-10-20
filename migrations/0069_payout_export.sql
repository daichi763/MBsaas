-- 0069: 振込データの出力と、クライアント単位の単価ルール（w5-payout-export #470 #471）
-- 列・表の追加のみ。既存の行の意味は変えない

-- ---------- #470 クライアント単位の単価ルール ----------
-- 案件を指定しないルールで、そのクライアントの全案件に当てる（NULL = 従来どおり。案件・スタッフのルール）。
-- 具体度は案件より弱い（スタッフ8 役割4 開催場所2 案件1 クライアント0.5）
ALTER TABLE rate_rules ADD COLUMN client_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_rate_rules_client ON rate_rules(company_id, client_id);

-- ---------- #471 振込先の口座（日雇い・個人事業主を含むスタッフごと） ----------
-- 従業員管理（employee_records）の口座より優先して振込データに使う。名義は全銀の受取人名（カナ）
CREATE TABLE IF NOT EXISTS payout_accounts (
  account_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  bank_code TEXT NOT NULL,             -- 金融機関コード（4桁）
  bank_name TEXT,
  branch_code TEXT NOT NULL,           -- 支店コード（3桁）
  branch_name TEXT,
  account_type TEXT NOT NULL,          -- 1 普通 / 2 当座 / 4 貯蓄
  account_number TEXT NOT NULL,        -- 口座番号（7桁）
  holder_kana TEXT NOT NULL,           -- 口座名義（カナ）
  updated_by INTEGER,
  updated_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_accounts_staff ON payout_accounts(company_id, staff_id);

-- ---------- #471 振込元（依頼人）の設定（全銀形式のヘッダーに使う） ----------
CREATE TABLE IF NOT EXISTS payout_settings (
  company_id INTEGER PRIMARY KEY,
  requester_code TEXT,                 -- 委託者コード（銀行が割り当てる10桁）
  requester_kana TEXT,                 -- 委託者名（カナ）
  bank_code TEXT, bank_name TEXT, branch_code TEXT, branch_name TEXT,
  account_type TEXT, account_number TEXT,
  updated_by INTEGER,
  updated_at DATETIME,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
