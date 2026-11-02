-- 障害の記録と通知（利用者の決定 Sprint 13。#9622。w13-ops-safety）
-- 表の追加のみ（既存の表・列・値は変えない）。
--
-- 1. error_logs: サーバーの予期しないエラー（index.tsx の app.onError。利用者には参照番号を返している #230）と、
--      定期処理（cron）の失敗を1件ずつ残す。書き込みは src/lib/error-log.ts の recordError だけ。
--      残すのは参照番号・時刻・パス（トークンは伏せる）・メソッド・会社・ロール・エラーの要約だけで、
--      利用者の ID・入力値・SQL の値・スタックの全文は残さない（要約の中の引用・メールアドレス・長い英数字も伏せる）。
--      同じエラー（fingerprint）が続くときは、10分あたり一定の行数を超えた分を新しい行にせず、
--      最後の行の repeat_count に数える（行が増えすぎないように）。
--      created_at から90日で消す（src/services/retention.ts の error_logs）。
--      company_id を持つので、解約企業の削除（OFFBOARDING_TABLES）でも消す。
--   ref: 参照番号（8桁の16進）。cron の失敗にも付ける
--   source: 'request'（画面・API の要求）/ 'cron'（定期処理）
--   method / path: 要求のメソッドとパス。cron のときは method = 'CRON'、path = 処理名（CRON_JOBS の name）
--   company_id / role: 操作していた利用者の会社とロール（ログイン前・cron は NULL）
--   error_name: エラーの種類（TypeError など）
--   message: エラーの要約（300文字まで。伏せ字済み）
--   location: スタックの最初の1行（どのファイルのどこで起きたか。200文字まで）
--   fingerprint: 同じエラーをまとめるための値（source・メソッド・数字を除いたパス・種類・数字を除いた要約から作る）
--   repeat_count / last_repeat_at: まとめた回数と最後の日時
--   created_at: 日本時間（YYYY-MM-DD HH:MM:SS）
-- 2. error_alerts: 直近のエラーが閾値を超えたときに、本部の管理者へ送った通知の記録。
--      同じ通知を繰り返さないための判定（最後の通知から一定時間は送らない）に使う。created_at から90日で消す
CREATE TABLE IF NOT EXISTS error_logs (
  error_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  source TEXT NOT NULL,
  method TEXT,
  path TEXT,
  company_id INTEGER,
  role TEXT,
  error_name TEXT,
  message TEXT,
  location TEXT,
  fingerprint TEXT NOT NULL,
  repeat_count INTEGER NOT NULL DEFAULT 0,
  last_repeat_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_error_logs_fingerprint ON error_logs(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_error_logs_ref ON error_logs(ref);
CREATE INDEX IF NOT EXISTS idx_error_logs_company ON error_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_repeat ON error_logs(last_repeat_at);

CREATE TABLE IF NOT EXISTS error_alerts (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_minutes INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_alerts_created ON error_alerts(created_at);
