-- 0016: 常勤/スポット案件・募集枠・単価（請求/支払）・シフトボード（第1段階）
-- 仕様: docs/spec_spot_shift.md
-- 既存の列の意味は変えない（shifts.unit_price = 請求の基本額、shifts.transportation_fee = 交通費の実費）。
-- 既存データは「常勤」「枠なし」のまま動作する。

-- ---------- 案件: 区分・支払の標準単価・交通費ルール ----------
ALTER TABLE projects ADD COLUMN engagement_type TEXT DEFAULT 'regular';        -- regular(常勤) / spot(スポット)
ALTER TABLE projects ADD COLUMN pay_unit_type TEXT DEFAULT 'daily';            -- daily / hourly
ALTER TABLE projects ADD COLUMN pay_rate INTEGER;                              -- 支払の標準単価（NULL=未設定）
ALTER TABLE projects ADD COLUMN bill_transport_type TEXT DEFAULT 'actual';     -- actual / fixed / included
ALTER TABLE projects ADD COLUMN bill_transport_amount INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN pay_transport_type TEXT DEFAULT 'actual';      -- actual / capped / fixed / none
ALTER TABLE projects ADD COLUMN pay_transport_amount INTEGER DEFAULT 0;        -- capped の上限 / fixed の額
ALTER TABLE projects ADD COLUMN default_break_minutes INTEGER DEFAULT 60;


-- ---------- 開催場所（今後作成する現場マスタの土台） ----------
CREATE TABLE IF NOT EXISTS sites (
  site_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  client_id INTEGER,
  site_name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  memo TEXT,
  status TEXT DEFAULT 'active',                 -- active / inactive
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);
CREATE INDEX IF NOT EXISTS idx_sites_company_client ON sites(company_id, client_id);

-- ---------- 単価ルール（案件 / 開催場所 / 役割 / スタッフ の組み合わせ。NULL は「すべて」） ----------
CREATE TABLE IF NOT EXISTS rate_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  project_id INTEGER,
  site_id INTEGER,
  role_name TEXT,
  staff_id INTEGER,
  bill_unit_type TEXT,
  bill_rate INTEGER,
  pay_unit_type TEXT,
  pay_rate INTEGER,
  bill_transport_type TEXT,
  bill_transport_amount INTEGER,
  pay_transport_type TEXT,
  pay_transport_amount INTEGER,
  memo TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_rate_rules_company ON rate_rules(company_id, project_id);
CREATE INDEX IF NOT EXISTS idx_rate_rules_staff ON rate_rules(company_id, staff_id);

-- ---------- 繰り返し登録 ----------
CREATE TABLE IF NOT EXISTS slot_patterns (
  pattern_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  site_id INTEGER,
  location TEXT,
  weekdays TEXT NOT NULL,                        -- '0,6'（0=日曜）
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes INTEGER,
  roles_json TEXT NOT NULL,                      -- [{"role_name":"販売","headcount":3}, ...]
  memo TEXT,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

-- ---------- 募集枠 ----------
CREATE TABLE IF NOT EXISTS shift_slots (
  slot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  site_id INTEGER,
  location TEXT,
  work_date DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes INTEGER,
  pattern_id INTEGER,
  memo TEXT,
  status TEXT DEFAULT 'open',                    -- open / closed
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_shift_slots_company_date ON shift_slots(company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_shift_slots_pattern ON shift_slots(pattern_id);

CREATE TABLE IF NOT EXISTS shift_slot_roles (
  slot_role_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  role_name TEXT NOT NULL,
  headcount INTEGER NOT NULL DEFAULT 1,
  bill_unit_type TEXT,                           -- 枠でだけ単価を変える場合（NULL=ルールに従う）
  bill_rate INTEGER,
  pay_unit_type TEXT,
  pay_rate INTEGER,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (slot_id) REFERENCES shift_slots(slot_id)
);
CREATE INDEX IF NOT EXISTS idx_shift_slot_roles_slot ON shift_slot_roles(slot_id);

-- ---------- シフト: 枠・金額（請求/支払）・支払先 ----------
ALTER TABLE shifts ADD COLUMN slot_id INTEGER;
ALTER TABLE shifts ADD COLUMN slot_role_id INTEGER;
ALTER TABLE shifts ADD COLUMN site_id INTEGER;
ALTER TABLE shifts ADD COLUMN break_minutes INTEGER;
ALTER TABLE shifts ADD COLUMN bill_unit_type TEXT;
ALTER TABLE shifts ADD COLUMN bill_rate INTEGER;
ALTER TABLE shifts ADD COLUMN bill_qty REAL;
ALTER TABLE shifts ADD COLUMN pay_unit_type TEXT;
ALTER TABLE shifts ADD COLUMN pay_rate INTEGER;
ALTER TABLE shifts ADD COLUMN pay_qty REAL;
ALTER TABLE shifts ADD COLUMN pay_amount INTEGER;
ALTER TABLE shifts ADD COLUMN bill_transport_type TEXT;
ALTER TABLE shifts ADD COLUMN bill_transport_amount INTEGER;
ALTER TABLE shifts ADD COLUMN pay_transport_type TEXT;
ALTER TABLE shifts ADD COLUMN pay_transport_amount INTEGER;
ALTER TABLE shifts ADD COLUMN bill_adjust INTEGER DEFAULT 0;
ALTER TABLE shifts ADD COLUMN pay_adjust INTEGER DEFAULT 0;
ALTER TABLE shifts ADD COLUMN adjust_note TEXT;
ALTER TABLE shifts ADD COLUMN payee_type TEXT;                  -- payroll / partner / linked
ALTER TABLE shifts ADD COLUMN payee_affiliation_id INTEGER;
ALTER TABLE shifts ADD COLUMN payee_company_id INTEGER;
ALTER TABLE shifts ADD COLUMN price_locked INTEGER DEFAULT 0;
ALTER TABLE shifts ADD COLUMN price_source TEXT;

CREATE INDEX IF NOT EXISTS idx_shifts_slot_role ON shifts(slot_role_id);
CREATE INDEX IF NOT EXISTS idx_shifts_company_date ON shifts(company_id, work_date);

-- 既存シフト: 請求は既存の unit_price を日額として記録（金額は変わらない）。支払は未設定のまま
UPDATE shifts SET bill_unit_type = 'daily', bill_rate = unit_price, bill_qty = 1 WHERE bill_unit_type IS NULL;
