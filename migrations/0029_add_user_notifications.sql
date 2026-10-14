-- アプリ内通知とメール通知の送信状態（docs/spec_attendance_correction.md 5章）
-- 既存の notices（管理者からスタッフへのお知らせ）は使わない: 管理者向けの受信箱がなく、お知らせ配信の一覧と既読率レポートに混ざるため。
-- 日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。

-- 個人あての通知（受信者ごとに 1 行。既読は read_at）
-- kind: correction_submitted（管理者への承認依頼）/ correction_received（申請者への受付）/
--       correction_approved・correction_rejected（申請者への結果）/ correction_processed（処理した管理者への控え）
CREATE TABLE IF NOT EXISTS user_notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  related_id INTEGER,                          -- correction_id
  created_at TEXT DEFAULT (datetime('now', '+9 hours')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, read_at, notification_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_created ON user_notifications(created_at);

-- メール通知の送信状態（本文は保存しない。再送時は申請データから作り直す）
-- status: pending（送信前）/ sent / failed
CREATE TABLE IF NOT EXISTS notification_emails (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  correction_id INTEGER NOT NULL,
  event TEXT NOT NULL,                         -- submitted / resubmitted / approved / rejected
  kind TEXT NOT NULL,                          -- user_notifications.kind と同じ（受信者の立場）
  user_id INTEGER NOT NULL,
  to_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_attempt_at TEXT,
  last_attempt_by INTEGER,                     -- 再送した管理者（自動送信は NULL）
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_notification_emails_company ON notification_emails(company_id, status, delivery_id);
CREATE INDEX IF NOT EXISTS idx_notification_emails_correction ON notification_emails(correction_id);
