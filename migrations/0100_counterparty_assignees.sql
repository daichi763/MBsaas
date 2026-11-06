-- クライアント・協力会社の社内担当者と、協力会社の項目をクライアントにそろえる（利用者の要望 Sprint 17。#9909 #9910。w17-masters）
-- 表と列の追加のみ（既存の列・値は変えない。既存の行の新しい列は空のまま）。
-- 新しい表 counterparty_assignees は、解約企業の書き出しと削除（retention.ts の OFFBOARDING_TABLES）と、
-- 退職後の削除（利用者の行の後始末）の対象に入れる。

-- 1. 社内担当者（#9910。利用者の決定: 主担当1人＋副担当（複数））。
--    target_type: 'client'（clients.client_id）/ 'partner'（staff_affiliations.affiliation_id）。target_id はその ID。
--    user_id: 担当の自社の管理者のアカウント（users.user_id。company_admin・sales_manager・field_manager・office_staff）。
--    is_primary: 1 = 主担当（会社ごとに1人まで）/ 0 = 副担当。
--    アカウントを止めた・消したときも行は残し、画面で「担当から外れた」ことを出す（編集して保存すると外れる）。
--    これまでの文字の社内担当者（staff_affiliations.internal_contact_name）は消さずに「旧」として出す
CREATE TABLE IF NOT EXISTS counterparty_assignees (
  assignee_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_assignees_user ON counterparty_assignees(target_type, target_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_assignees_primary ON counterparty_assignees(target_type, target_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_counterparty_assignees_company ON counterparty_assignees(company_id, user_id);

-- 2. 協力会社（staff_affiliations）の項目をクライアントにそろえる（#9909）。
--    partner_kind: 種別（corporation = 法人 / sole_proprietor = 個人事業主 / other = その他。クライアントの client_kind と同じ値）
--    branch_name / department_name: 支店・部門（クライアントと同じく1つの自由入力）
--    company_email: 会社のメール（クライアントの「連絡先」のメール。先方の担当者のメールは今の email のまま）
--    payment_rule: 支払条件（締め日・支払サイトなど。クライアントの「請求条件」にあたる自由入力）
--    partner_rating: 評価（1〜5。NULL は未評価）
ALTER TABLE staff_affiliations ADD COLUMN partner_kind TEXT;
ALTER TABLE staff_affiliations ADD COLUMN branch_name TEXT;
ALTER TABLE staff_affiliations ADD COLUMN department_name TEXT;
ALTER TABLE staff_affiliations ADD COLUMN company_email TEXT;
ALTER TABLE staff_affiliations ADD COLUMN payment_rule TEXT;
ALTER TABLE staff_affiliations ADD COLUMN partner_rating INTEGER;
