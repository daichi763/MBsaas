-- 定期削除機能: 退職日情報 + 削除実行ログ
--
-- users.retired_at: 既存に退職日を保持する仕組みがなかったため、今回の定期削除のために追加する。
-- NULL（未設定・退職日不明）の場合は「退職後7年」ルールの削除対象に一切含めない（安全側に倒す）。
ALTER TABLE users ADD COLUMN retired_at DATE;

-- 削除処理の実行ログ（対象/削除/失敗件数、dry-runかどうかを記録）
CREATE TABLE IF NOT EXISTS retention_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,            -- daily_reports / attendance_reports / shifts / evaluations / follow_logs / consultations / r2_photos
  dry_run INTEGER NOT NULL DEFAULT 0,
  target_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  started_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_retention_logs_started ON retention_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_retention_logs_target ON retention_logs(target);

CREATE INDEX IF NOT EXISTS idx_users_retired_at ON users(retired_at);
CREATE INDEX IF NOT EXISTS idx_daily_reports_work_date ON daily_reports(work_date);
