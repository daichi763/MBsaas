-- クライアント情報拡充: 会社基本情報(代表者・インボイス番号) + 顧客担当者(1対多)
--
-- 既存の clients.contact_name / email / phone は既存データのため変更・削除しない。
-- 顧客担当者は複数登録可能にするため、clientsへのカラム追加ではなく
-- client_contacts という別テーブル(1対多)で管理する。

ALTER TABLE clients ADD COLUMN representative_title TEXT;   -- 代表者役職
ALTER TABLE clients ADD COLUMN representative_name TEXT;    -- 代表者氏名
ALTER TABLE clients ADD COLUMN representative_kana TEXT;    -- 代表者フリガナ
ALTER TABLE clients ADD COLUMN invoice_number TEXT;         -- インボイス登録番号（T+13桁、サーバー側でも形式チェック）

CREATE TABLE IF NOT EXISTS client_contacts (
  contact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,          -- テナント分離用（clientsと同じ考え方）
  client_id INTEGER NOT NULL,
  contact_name TEXT NOT NULL,           -- 顧客名（担当者氏名の意）
  branch_name TEXT,                     -- 支店名（自由入力、マスタ化しない）
  department TEXT,                      -- 部署名（自由入力、マスタ化しない）
  title TEXT,                           -- 担当者役職
  phone TEXT,
  email TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX IF NOT EXISTS idx_client_contacts_client ON client_contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_client_contacts_company ON client_contacts(company_id);
