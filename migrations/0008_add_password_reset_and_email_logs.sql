-- Resendメール送信基盤: パスワードリセット用トークン + メール送信ログ
--
-- password_reset_tokens: リセットURLに使う生トークンはDBへ保存しない。ハッシュ値のみ保存し、
-- 受信時にハッシュ化して照合する。1回使用したら used_at を立てて無効化する。
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- email_logs: 送信種別(type)ごとの成否を追跡する。本文・トークン・パスワードは記録しない。
CREATE TABLE IF NOT EXISTS email_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  to_email TEXT NOT NULL,
  type TEXT NOT NULL,             -- password_reset / notice
  status TEXT NOT NULL,           -- sent / failed
  provider_message_id TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_logs_company ON email_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_type ON email_logs(type);
