-- 企業間チャット（所属元企業の担当者 ⇔ 稼働先企業の担当者）（フェーズG）
--
-- ・スレッドは「稼働先側の連携スタッフマスタ行（linked_external の staff_id）」単位 = 所属元1社 × 稼働先1社 × 対象スタッフ1名。
--   参加できるのは thread の owner_company_id（所属元）と host_company_id（稼働先）の管理系ロールのみ。
-- ・スタッフ本人（role='staff'）は閲覧・投稿とも不可。API は /api/admin/* 配下にのみ存在し、/api/staff/* には一切公開しない。
-- ・会話履歴は削除しない（論理削除も持たない）。
CREATE TABLE IF NOT EXISTS roster_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_staff_id INTEGER NOT NULL,       -- 稼働先側の staff_profiles.staff_id（affiliation_type='linked_external'）
  owner_company_id INTEGER NOT NULL,      -- 所属元企業
  host_company_id INTEGER NOT NULL,       -- 稼働先企業
  author_company_id INTEGER NOT NULL,     -- 投稿した企業（owner or host）
  author_user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_staff_id) REFERENCES staff_profiles(staff_id),
  FOREIGN KEY (owner_company_id) REFERENCES companies(company_id),
  FOREIGN KEY (host_company_id) REFERENCES companies(company_id),
  FOREIGN KEY (author_user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_roster_comments_thread ON roster_comments(thread_staff_id, comment_id);
CREATE INDEX IF NOT EXISTS idx_roster_comments_owner ON roster_comments(owner_company_id, comment_id);
CREATE INDEX IF NOT EXISTS idx_roster_comments_host ON roster_comments(host_company_id, comment_id);

-- 既読位置（企業単位で管理。自社の誰かが開けば自社として既読）
CREATE TABLE IF NOT EXISTS roster_comment_reads (
  thread_staff_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  last_read_comment_id INTEGER NOT NULL DEFAULT 0,
  read_by INTEGER,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_staff_id, company_id),
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
