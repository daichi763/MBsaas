-- 第4段階: 公開の募集ページ・応募・承認（すべて管理者の承認で確定）
-- 列・テーブルの追加のみ

-- 募集ページ（URL・QRで公開。案件・期間の範囲にある募集枠を表示する）
CREATE TABLE IF NOT EXISTS recruit_pages (
  page_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,              -- 公開URL /apply/:token（推測できない乱数）
  title TEXT NOT NULL,
  description TEXT,                        -- 仕事内容・条件など（応募者に表示）
  pay_note TEXT,                           -- 給与の表示文言（任意。金額の列は公開しない）
  contact_note TEXT,                       -- 問い合わせ先の表示文言
  project_ids TEXT NOT NULL,               -- 対象の案件（カンマ区切り）
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  show_remaining INTEGER DEFAULT 1,        -- 残り人数を表示する
  allow_staff INTEGER DEFAULT 1,           -- 登録済みスタッフがアプリから応募できる
  status TEXT DEFAULT 'open',              -- open / closed
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_recruit_pages_company ON recruit_pages(company_id, status);

-- 応募（公開ページから、またはスタッフアプリから）
CREATE TABLE IF NOT EXISTS recruit_applications (
  application_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  page_id INTEGER,                         -- スタッフアプリからの応募でページ経由でない場合は NULL
  source TEXT NOT NULL DEFAULT 'public',   -- public（公開ページ）/ staff（スタッフアプリ）
  staff_id INTEGER,                        -- 登録済みスタッフ / 承認時に紐づけ・仮登録したスタッフ
  name TEXT NOT NULL,
  kana TEXT,
  phone TEXT,
  email TEXT,
  note TEXT,
  status TEXT DEFAULT 'pending',           -- pending（未対応）/ done（対応済み）/ cancelled（取り下げ）
  ip_hash TEXT,                            -- 送信回数の制限用（IPは保存せずハッシュのみ）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME,
  decided_by INTEGER,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_recruit_apps_company ON recruit_applications(company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_recruit_apps_ip ON recruit_applications(ip_hash, created_at);

-- 応募した枠（1件の応募で複数の日・枠を選べる）
CREATE TABLE IF NOT EXISTS recruit_application_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  slot_role_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',           -- pending / approved / rejected / cancelled
  shift_id INTEGER,                        -- 承認して作成したシフト
  decided_at DATETIME,
  UNIQUE(application_id, slot_role_id),
  FOREIGN KEY (application_id) REFERENCES recruit_applications(application_id)
);
CREATE INDEX IF NOT EXISTS idx_recruit_items_role ON recruit_application_items(slot_role_id, status);
