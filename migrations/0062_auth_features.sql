-- ログイン履歴・ログイン中の端末・二段階認証（作業単位 w4-auth-features: #552 #453 #544）
--
-- 1. ログインの履歴（#552）
--    ログインの成功・失敗、二段階認証の失敗、パスワードの再設定、管理者による強制ログアウト、本人の「すべての端末からログアウト」を1行ずつ残す。
--    company_id・user_id は分かったときだけ入れる（会社コードの誤りなどは NULL。本部だけが見られる）。
--    company_code・user_code は入力された値（各40文字まで）。ip は CF-Connecting-IP、user_agent は先頭300文字。
--    actor_user_id は強制ログアウトを行った管理者。created_at は ISO 8601（UTC）。1年より古い行は Cron で消す（lib/auth の purgeExpiredAuthRows）。
CREATE TABLE IF NOT EXISTS login_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  user_id INTEGER,
  company_code TEXT,
  user_code TEXT,
  event_type TEXT NOT NULL DEFAULT 'login', -- login / password_reset / logout_all / forced_logout
  result TEXT NOT NULL,                     -- success / bad_password / locked / inactive / company_inactive / ip_denied / mfa_failed
  method TEXT,                              -- password / totp / recovery（ログインの成功で、どの方法で確かめたか）
  ip TEXT,
  user_agent TEXT,
  actor_user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_events_company ON login_events(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events(created_at);

-- 2. ログイン中の端末（#453）。この版から発行するセッションに、接続元と端末（User-Agent）を残す。
--    利用者ごとに一覧・削除できるよう user_id にインデックスを足す（以前の行は NULL のまま）
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 3. 二段階認証（#544）。本部ユーザーと管理画面のアカウントが、認証アプリ（TOTP）を登録できる。
--    totp_pending_secret: 登録の途中（コードを確かめる前）の秘密鍵。totp_secret: 確かめた後の秘密鍵（Base32）。
--    totp_last_step: 最後に使ったコードの時刻の区切り（同じコードの使い回しを防ぐ）。
--    mfa_recovery_codes: 予備コードの SHA-256 の JSON 配列（使ったものは消す）。
--    必須にするかと接続元の制限は companies.settings_json の security_mfa_required・security_ip_allowlist に持つ
--    （本部ユーザーの分は本部専用の企業行の settings_json）
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
ALTER TABLE users ADD COLUMN mfa_recovery_codes TEXT;

--    パスワードを確かめた後、認証アプリのコードを待つ間の一時的な記録（5分で期限切れ。token_hash は一時トークンの SHA-256）。
--    attempt_key はログイン試行の制限（login_attempts の account）のキー。失敗は5回まで
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires ON mfa_challenges(expires_at);
