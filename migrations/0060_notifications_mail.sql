-- 通知とメールの運用（w4-notifications-mail: #541 #438 #454）
--
-- #541 email_suppressions: 宛先不明などで戻ってきた（ハードバウンス）・迷惑メールと報告されたアドレス。
--   Resend の Webhook（/webhooks/resend）で記録し、以後このアドレスには送らない（services/email.ts）。
--   アドレスは小文字にそろえて保存する。本部画面で解除する（行を消す）。
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,                 -- bounced / complained
  detail TEXT,                          -- 送信サービスが返した理由（短く切り、アドレスは伏せる）
  provider_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);

-- Webhook で送信の記録を引くための索引（email_logs・打刻修正の通知・お知らせメール）
CREATE INDEX IF NOT EXISTS idx_email_logs_provider ON email_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_emails_provider ON notification_emails(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_notice_email_deliveries_provider ON notice_email_deliveries(provider_message_id);

-- #454 notice_ack_tokens: お知らせメールの「確認しました」のリンク（1人1通ずつのワンタイムのトークン。ハッシュで保存）。
--   リンクを開いてボタンを押すと、notice_reads に既読を記録し used_at を入れる。期限は expires_at（日本時間）
CREATE TABLE IF NOT EXISTS notice_ack_tokens (
  token_hash TEXT PRIMARY KEY,
  notice_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_notice_ack_tokens_expires ON notice_ack_tokens(expires_at);
