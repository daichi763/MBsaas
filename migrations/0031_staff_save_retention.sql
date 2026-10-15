-- 退職日の検証と定期削除の安全策（w1-staff-save-retention: #5 #50 #51）
--
-- 1. 定期削除の猶予と処理の順番（staff_profiles）
--    retention_flagged_at   : 退職後7年の削除対象に初めてなった日（日本時間 YYYY-MM-DD）。
--                             この日から猶予日数が過ぎるまでは削除せず、本部画面に「次回削除予定」として出す。
--                             退職日を変えたら NULL に戻し、猶予をやり直す。
--    retention_attempted_at : 最後に削除を試みた日時。毎回同じ人ばかりを処理しないよう、古い順に選ぶ。
ALTER TABLE staff_profiles ADD COLUMN retention_flagged_at TEXT;
ALTER TABLE staff_profiles ADD COLUMN retention_attempted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_staff_profiles_retention_flagged ON staff_profiles(retention_flagged_at);

-- 2. D1 の削除が済んだ後に消せなかった R2 の写真キー（次回の定期削除で再試行する）
CREATE TABLE IF NOT EXISTS retention_pending_r2 (
  photo_key TEXT PRIMARY KEY,
  staff_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. 報告用URLのトークン: shifts の削除で一緒に消えるよう、外部キーに ON DELETE CASCADE を付ける。
--    SQLite は外部キーの変更ができないため、テーブルを作り直して全行を移す。
--    （shift_report_tokens を参照するテーブルは無い。外部キーは常に有効なので、存在しないシフトを指す行は元から無い）
CREATE TABLE shift_report_tokens_new (
  token TEXT PRIMARY KEY,
  shift_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,                  -- 稼働日の翌日 23:59（日本時間）
  revoked INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  FOREIGN KEY (shift_id) REFERENCES shifts(shift_id) ON DELETE CASCADE
);
INSERT INTO shift_report_tokens_new (token, shift_id, company_id, staff_id, expires_at, revoked, created_by, created_at, last_used_at)
  SELECT token, shift_id, company_id, staff_id, expires_at, revoked, created_by, created_at, last_used_at FROM shift_report_tokens;
DROP TABLE shift_report_tokens;
ALTER TABLE shift_report_tokens_new RENAME TO shift_report_tokens;
CREATE INDEX IF NOT EXISTS idx_report_tokens_shift ON shift_report_tokens(shift_id);
CREATE INDEX IF NOT EXISTS idx_report_tokens_staff ON shift_report_tokens(staff_id);
