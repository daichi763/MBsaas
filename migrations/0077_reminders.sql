-- 本人あての自動リマインド（作業単位 w5-reminders: #160）
--
-- 起床・出発・入店の報告がない人と、日報を出していない人に、本人あてのアプリ内通知（とメール）を自動で送る（15分おきの cron。src/services/reminders.ts）。
-- 送った記録を1行ずつ残し、同じシフト・同じ種類のリマインドを二度送らない（ux_reminder_sends_shift_type）。
--   reminder_type: wake_up / departure / check_in / daily_report
--   due_at: 送る時点（会社の設定で決めた時刻。JST 'YYYY-MM-DD HH:MM:SS'）、created_at: 送った日時（JST）
--   user_id: 通知を送ったユーザー、emailed: メールを送ったか（送信の結果は email_logs に残る）
-- 90日より古い行はリマインドの処理の中で消す（重複を防ぐためだけの記録のため）。
-- 会社の設定は companies.settings_json の reminders（既定は送らない。GET/PUT /api/admin/settings/reminders）。
CREATE TABLE IF NOT EXISTS reminder_sends (
  reminder_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  user_id INTEGER,
  reminder_type TEXT NOT NULL,
  due_at TEXT,
  emailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reminder_sends_shift_type ON reminder_sends(shift_id, reminder_type);
CREATE INDEX IF NOT EXISTS idx_reminder_sends_created ON reminder_sends(created_at);
