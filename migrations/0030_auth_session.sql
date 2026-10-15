-- 認証の強化（作業単位 w1-auth-session。#46 #131 #330）
--
-- login_attempts: ログインの失敗の記録（会社コード＋ID 単位と IP 単位で、15分間の失敗回数を数える）。
--   生の会社コード・ID・IP は保存せず、SHA-256 のハッシュだけを保存する。成功すると ID 単位の記録は消し、
--   1日より古い記録は Cron で消す。attempted_at は ISO 8601（UTC）の文字列。
CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- account / ip
  key_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(scope, key_hash, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempted_at);

-- パスワード再設定の照合はメールアドレスを LOWER(TRIM(email)) にそろえて行うため、式インデックスを足す
CREATE INDEX IF NOT EXISTS idx_users_email_norm ON users(LOWER(TRIM(email)));

-- sessions.token には、この版からトークンの SHA-256 を保存する（列の変更はない）。
-- 以前の行は生のトークンのため照合されなくなり、各利用者は一度だけ再ログインになる。
-- 残った行は expires_at（ISO 8601）を過ぎた時点で Cron の削除の対象になる。
-- パスワードは PBKDF2 へ移行する。旧形式（SHA-256）の行は、本人がログインに成功した時点で作り直す。
