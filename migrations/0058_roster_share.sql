-- 企業間連携の共有情報（w4-roster-share: #462 #538）
--
-- #462 企業間チャットの既読を、会社単位からユーザー単位にする。
--   roster_comment_reads（会社単位）は「自社で最後に読んだ人」の記録として残し、未読件数はこの表で数える。
--   既存の会社単位の既読位置は、その会社の管理系ユーザー全員の既読位置として引き継ぐ（移行直後に未読が増えないように）。
--   定期削除で roster_comment_reads（スレッドの既読位置）を消したら、この表の同じスレッドの行も消す（トリガー）。
CREATE TABLE IF NOT EXISTS roster_comment_user_reads (
  thread_staff_id INTEGER NOT NULL,      -- 稼働先側の連携行の staff_id（roster_comments.thread_staff_id）
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  last_read_comment_id INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,                          -- 日本時間
  PRIMARY KEY (thread_staff_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_roster_comment_user_reads_user ON roster_comment_user_reads(user_id, thread_staff_id);

INSERT OR IGNORE INTO roster_comment_user_reads (thread_staff_id, user_id, company_id, last_read_comment_id, read_at)
SELECT r.thread_staff_id, us.user_id, r.company_id, r.last_read_comment_id, r.read_at
FROM roster_comment_reads r
JOIN users us ON us.company_id = r.company_id AND us.status = 'active'
  AND us.role IN ('company_admin', 'sales_manager', 'field_manager', 'office_staff');

CREATE TRIGGER IF NOT EXISTS trg_roster_comment_reads_delete AFTER DELETE ON roster_comment_reads
BEGIN
  DELETE FROM roster_comment_user_reads WHERE thread_staff_id = OLD.thread_staff_id;
END;

-- #538 稼働先が書く現場評価・稼働メモ（所属元と共有する追記項目）の履歴。
--   staff_profiles の site_evaluation / work_memo は最新の値として残し、保存のたびに変わった内容をここに追記する。
--   source_staff_id・owner_company_id は書いた時点の所属元（直接連携した1つ前の企業）の行と企業。所属元の一覧はこれで引く。
--   本人の匿名化（定期削除）で、稼働先の行・所属元の行のどちらかが匿名化されたら、その人の履歴を消す（トリガー）。
CREATE TABLE IF NOT EXISTS roster_host_note_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,             -- 稼働先の連携行（linked_external）
  company_id INTEGER NOT NULL,           -- 稼働先の企業（書いた企業）
  source_staff_id INTEGER,               -- 所属元の行
  owner_company_id INTEGER,              -- 所属元の企業（閲覧する企業）
  site_evaluation TEXT,
  work_memo TEXT,
  written_by INTEGER,                    -- 書いた稼働先のユーザー（移行で作った行は NULL）
  created_at TEXT NOT NULL               -- 日本時間
);
CREATE INDEX IF NOT EXISTS idx_roster_host_note_history_owner ON roster_host_note_history(owner_company_id, history_id);
CREATE INDEX IF NOT EXISTS idx_roster_host_note_history_staff ON roster_host_note_history(staff_id, history_id);

-- 既存の現場評価・稼働メモを、最初の履歴として入れる
INSERT INTO roster_host_note_history (staff_id, company_id, source_staff_id, owner_company_id, site_evaluation, work_memo, written_by, created_at)
SELECT sp.staff_id, sp.company_id, sp.source_staff_id, sp.owner_company_id, sp.site_evaluation, sp.work_memo, NULL,
  COALESCE(sp.host_note_updated_at, sp.created_at, datetime('now', '+9 hours'))
FROM staff_profiles sp
WHERE sp.affiliation_type = 'linked_external' AND sp.anonymized_at IS NULL
  AND (COALESCE(sp.site_evaluation, '') != '' OR COALESCE(sp.work_memo, '') != '')
  AND NOT EXISTS (SELECT 1 FROM roster_host_note_history h WHERE h.staff_id = sp.staff_id);

CREATE TRIGGER IF NOT EXISTS trg_roster_host_note_history_anonymize AFTER UPDATE OF anonymized_at ON staff_profiles
WHEN NEW.anonymized_at IS NOT NULL
BEGIN
  DELETE FROM roster_host_note_history WHERE staff_id = NEW.staff_id OR source_staff_id = NEW.staff_id;
END;

-- 所属元のユーザーが「連携先からの追記」の一覧で、どこまで確認したか（ユーザー単位）。
-- 移行の時点の履歴は、今の管理系ユーザー全員が確認済みとして始める（移行で入れた行が一斉に未確認にならないように）
CREATE TABLE IF NOT EXISTS roster_host_note_seen (
  user_id INTEGER PRIMARY KEY,
  last_seen_history_id INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT
);
INSERT OR IGNORE INTO roster_host_note_seen (user_id, last_seen_history_id, seen_at)
SELECT us.user_id, COALESCE((SELECT MAX(history_id) FROM roster_host_note_history), 0), datetime('now', '+9 hours')
FROM users us WHERE us.status = 'active' AND us.role IN ('company_admin', 'sales_manager', 'field_manager', 'office_staff');
