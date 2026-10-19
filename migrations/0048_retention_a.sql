-- 定期削除の対象の追加と、定期処理（cron）の実行記録（w3-retention-a: #192 #193 #198 #228 #234 #480）
--
-- 1. 定期処理の実行記録（#192）
--    毎日の cron の処理ごとに1行。本部画面「データ保持・定期処理」に最終実行・成否・エラーを出し、
--    失敗したときと、24時間以上実行されていないときに本部画面の上部に警告を出す。
--    started_at / finished_at は ISO 8601（UTC）。result_json は処理が返した件数など
CREATE TABLE IF NOT EXISTS cron_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron TEXT,                       -- 起動した cron の式（手動・テストの実行では空）
  job TEXT NOT NULL,               -- 処理名（index.tsx の CRON_JOBS の name）
  label TEXT,                      -- 画面に出す処理の名前
  status TEXT NOT NULL,            -- ok / failed
  result_json TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job, run_id);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at);

-- 2. データ保持の実行ログに実行元を残す（#234）
--    trigger_source: cron（毎日の定期処理）/ manual（本部画面の dry-run）。この列ができる前の行は NULL
--    triggered_by  : 手動で実行した本部ユーザー
ALTER TABLE retention_logs ADD COLUMN trigger_source TEXT;
ALTER TABLE retention_logs ADD COLUMN triggered_by INTEGER;

-- 3. 退職後7年の本人情報の匿名化（#480）
--    users・staff_profiles の行は請求の集計などから参照されるため消さずに残し、氏名などの個人情報を消す。
--    匿名化した日時を残し、済んだ人を定期削除の対象に選び直さないようにする
ALTER TABLE staff_profiles ADD COLUMN anonymized_at TEXT;

-- 4. 書類のファイル（R2 の DOCUMENTS バケット）も、写真と同じく D1 の削除の後に消し、失敗したら次回に再試行する（#193）
--    bucket: NULL / 'photos' = 勤怠写真（PHOTOS）、'documents' = 履歴書・入社時書類（DOCUMENTS）
ALTER TABLE retention_pending_r2 ADD COLUMN bucket TEXT;
