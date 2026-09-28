-- 従業員管理 / スタッフマスタ 分離 + 企業間スタッフ連携（フェーズA）
--
-- 設計方針（docs/spec_multi_company_staff.md をベースに、既存0010の設計に合わせて調整）:
-- ・staff_profiles は改名せず「スタッフマスタ(staff_rosters)」として扱う。
--   shifts/attendance_reports/daily_reports/evaluations/follow_logs/consultations/staff_documents 等の
--   staff_id 参照・定期削除処理をそのまま維持するため。
-- ・従業員管理は既存 employee_records（0010）をそのまま用いる（employments テーブルは新設しない）。
-- ・取引先（Field OS 未契約の所属元企業）は既存 staff_affiliations（0010）に列を足して流用する。
-- ・persons は「システム全体で1人1レコード」の識別子と、QR化する恒久固定コードのみを持つ。
--   氏名・スキル等の基本項目は、所属元企業のスタッフマスタ行（staff_profiles）を正とし二重管理しない。
-- ・既存の staff_id / user_id の値は一切変更しない。

-- 人物マスタ（企業に非依存）
CREATE TABLE IF NOT EXISTS persons (
  person_id TEXT PRIMARY KEY,                -- 32桁hex（UUID相当）
  global_staff_code TEXT UNIQUE NOT NULL,    -- QR/ID連携用の恒久固定コード（再発行・期限なし）
  created_company_id INTEGER,                -- 最初に登録した企業（参考情報）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_company_id) REFERENCES companies(company_id)
);

-- スタッフマスタ（staff_profiles）拡張
ALTER TABLE staff_profiles ADD COLUMN person_id TEXT;              -- persons.person_id
ALTER TABLE staff_profiles ADD COLUMN owner_company_id INTEGER;    -- 基本項目の編集権限を持つField OS企業（所属元）
ALTER TABLE staff_profiles ADD COLUMN affiliation_type TEXT DEFAULT 'own_employee';
  -- own_employee(自社雇用) / linked_external(他社Field OS企業から連携) / partner_manual(取引先所属) / skillsheet_only(スキルシートのみ)
ALTER TABLE staff_profiles ADD COLUMN source_staff_id INTEGER;     -- linked_external のとき、所属元企業側の staff_id
ALTER TABLE staff_profiles ADD COLUMN partner_affiliation_id INTEGER; -- partner_manual 等のとき、staff_affiliations.affiliation_id

-- 統合ログイン（フェーズH）に向けた人物IDの紐付け
ALTER TABLE users ADD COLUMN person_id TEXT;

-- 取引先マスタとしての拡張（staff_affiliations）
ALTER TABLE staff_affiliations ADD COLUMN contact_name TEXT;
ALTER TABLE staff_affiliations ADD COLUMN phone TEXT;
ALTER TABLE staff_affiliations ADD COLUMN email TEXT;
ALTER TABLE staff_affiliations ADD COLUMN memo TEXT;

-- 連携時の同意履歴（誰が・いつ・どの連携に対して同意したか）
CREATE TABLE IF NOT EXISTS roster_consents (
  consent_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,          -- 連携登録した企業（稼働先）
  user_id INTEGER NOT NULL,             -- 同意操作をした担当者
  person_id TEXT NOT NULL,
  source_staff_id INTEGER NOT NULL,     -- 連携元（所属元企業）の staff_id
  source_company_id INTEGER NOT NULL,   -- 所属元企業
  staff_id INTEGER,                     -- 作成された稼働先側の staff_id
  consent_version TEXT NOT NULL,        -- 表示した同意文面のバージョン
  shared_scope TEXT NOT NULL,           -- 共有される情報範囲（表示した項目一覧）
  agreed INTEGER NOT NULL DEFAULT 1,
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (source_company_id) REFERENCES companies(company_id)
);

-- ============ 既存データ移行 ============
-- 1) 既存スタッフ全員に人物IDを採番
UPDATE staff_profiles SET person_id = lower(hex(randomblob(16))) WHERE person_id IS NULL;

INSERT OR IGNORE INTO persons (person_id, global_staff_code, created_company_id)
SELECT person_id, 'FS' || upper(hex(randomblob(5))), company_id FROM staff_profiles;

UPDATE users SET person_id = (SELECT sp.person_id FROM staff_profiles sp WHERE sp.user_id = users.user_id)
WHERE person_id IS NULL AND EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = users.user_id);

-- 2) 所属区分: 所属会社名が自社名と一致（または未設定）なら自社雇用、それ以外は取引先所属
--    （0010 の「社員名簿 = affiliation が自社名と一致」という判定結果をそのまま引き継ぐ）
UPDATE staff_profiles SET affiliation_type = CASE
  WHEN affiliation IS NULL OR affiliation = '' OR affiliation = (SELECT company_name FROM companies c WHERE c.company_id = staff_profiles.company_id)
    THEN 'own_employee'
  ELSE 'partner_manual' END;

UPDATE staff_profiles SET owner_company_id = company_id WHERE owner_company_id IS NULL;

-- 3) 取引先所属スタッフの所属会社名を取引先マスタに登録し、IDで紐付ける
INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name)
SELECT DISTINCT company_id, affiliation FROM staff_profiles WHERE affiliation_type = 'partner_manual' AND affiliation IS NOT NULL AND affiliation != '';

UPDATE staff_profiles SET partner_affiliation_id = (
  SELECT sa.affiliation_id FROM staff_affiliations sa WHERE sa.company_id = staff_profiles.company_id AND sa.affiliation_name = staff_profiles.affiliation
) WHERE affiliation_type = 'partner_manual';

CREATE INDEX IF NOT EXISTS idx_staff_profiles_person ON staff_profiles(person_id);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_source ON staff_profiles(source_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_company_type ON staff_profiles(company_id, affiliation_type);
CREATE INDEX IF NOT EXISTS idx_users_person ON users(person_id);
CREATE INDEX IF NOT EXISTS idx_roster_consents_company ON roster_consents(company_id);
CREATE INDEX IF NOT EXISTS idx_roster_consents_person ON roster_consents(person_id);
