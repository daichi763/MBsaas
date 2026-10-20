-- 企業間連携の機能追加（w5-roster-features: #161 #162 #285 #539）
--
-- #162 所属元が、自社スタッフの連携（稼働先の連携行）を終了できるようにする。
--   link_revoked_at: 所属元が連携を終了した日時（日本時間）。終了した行は所属元の基本項目を参照せず、
--   取引終了（link_ended_at）にしてシフトの候補からも外す。終了した連携行からさらに連携した先の行（多段連携）も同時に終了する。
--   link_revoked_by: 終了の操作をした所属元のユーザー
ALTER TABLE staff_profiles ADD COLUMN link_revoked_at TEXT;
ALTER TABLE staff_profiles ADD COLUMN link_revoked_by INTEGER;

-- 連携の記録（成立・終了・再開）。所属元・稼働先の画面と、スタッフ本人の「共有中の会社」に使う
CREATE TABLE IF NOT EXISTS roster_link_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,             -- 稼働先の連携行（linked_external）
  company_id INTEGER NOT NULL,           -- 稼働先の企業
  source_staff_id INTEGER,               -- 所属元の行（直接連携した1つ前の企業の行）
  owner_company_id INTEGER,              -- 所属元の企業
  event TEXT NOT NULL,                   -- linked（成立）/ ended（所属元が終了）/ resumed（所属元が再開）
  via_staff_id INTEGER,                  -- 多段連携で、1つ前の連携の終了に合わせて終了したときの、その連携行
  actor_user_id INTEGER,
  actor_company_id INTEGER,
  created_at TEXT NOT NULL               -- 日本時間
);
CREATE INDEX IF NOT EXISTS idx_roster_link_events_staff ON roster_link_events(staff_id, event_id);
CREATE INDEX IF NOT EXISTS idx_roster_link_events_source ON roster_link_events(source_staff_id, event_id);

-- 本人の匿名化（定期削除）で、稼働先の行・所属元の行のどちらかが匿名化されたら、その人の記録を消す
CREATE TRIGGER IF NOT EXISTS trg_roster_link_events_anonymize AFTER UPDATE OF anonymized_at ON staff_profiles
WHEN NEW.anonymized_at IS NOT NULL
BEGIN
  DELETE FROM roster_link_events WHERE staff_id = NEW.staff_id OR source_staff_id = NEW.staff_id;
END;

-- #161 取引先の統合。確定済みの精算で参照されている取引先は消さずに、統合先を記録して一覧・選択肢から外す
ALTER TABLE staff_affiliations ADD COLUMN merged_into_id INTEGER;
ALTER TABLE staff_affiliations ADD COLUMN updated_at TEXT;
