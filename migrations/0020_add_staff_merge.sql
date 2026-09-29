-- 第5段階: 仮登録スタッフと既存スタッフ（他社連携など）の統合
-- 統合元（仮登録）のシフト・勤怠・日報・評価などを統合先へ移し、統合元は「統合済み」として残す（削除しない）
ALTER TABLE staff_profiles ADD COLUMN merged_into_staff_id INTEGER;  -- 統合先の staff_id（統合済みの行のみ）
ALTER TABLE staff_profiles ADD COLUMN merged_at DATETIME;

-- 統合の記録（何をいくつ移したか。移したシフトIDも保持して、問い合わせ時に追えるようにする）
CREATE TABLE IF NOT EXISTS staff_merges (
  merge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  source_staff_id INTEGER NOT NULL,        -- 統合元（仮登録）
  target_staff_id INTEGER NOT NULL,        -- 統合先
  source_name TEXT,
  target_name TEXT,
  moved_json TEXT,                         -- 移した件数（テーブルごと）とシフトID
  repriced_shifts INTEGER DEFAULT 0,       -- 支払先・単価を置き換えた予定シフト数
  note TEXT,
  merged_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_merges_company ON staff_merges(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_merged ON staff_profiles(merged_into_staff_id);
