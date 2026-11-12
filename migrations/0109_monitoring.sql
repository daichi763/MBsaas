-- 障害に気づく仕組み（Sprint 25 #9971 #9974。作業単位 w25-monitor）
-- 表を足すだけ（今のコードは使わないので、デプロイの前に当ててもよい）。どの表も会社・利用者の情報は持たない。
-- 保存期間は src/services/retention.ts（db_size_logs は2年、ほかの2つは最後の更新から90日）。

-- D1 の DB の大きさの記録（毎日1回。src/services/monitor.ts の runMonitorDaily）。
-- day は日本時間の日付（1日1行）。stage は上限（vars の DB_SIZE_LIMIT_MB）に対する段階: ok / prepare / start / warning / emergency。
-- checked_at は定期処理が記録・通知の判定をした日時（本部画面の「表ごとの行数を数える」だけで作った行は NULL）。
-- table_counts_json は表ごとの行数（[{ "table": 名前, "rows": 件数 }]。本部画面のボタンで数えたときだけ入る）
CREATE TABLE IF NOT EXISTS db_size_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  limit_mb INTEGER NOT NULL,
  method TEXT,
  stage TEXT NOT NULL DEFAULT 'ok',
  notified INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  table_counts_json TEXT,
  table_counts_at TEXT,
  table_counts_rows_read INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 障害の通知の送り先（秘密の値 ALERT_DESTINATIONS）ごとの最後の送信の結果。
-- dest_key は種類と URL・トークンから作った短いハッシュ。URL・トークン・宛先そのものは持たない
CREATE TABLE IF NOT EXISTS alert_destination_status (
  dest_key TEXT PRIMARY KEY,
  dest_type TEXT NOT NULL,
  last_status TEXT NOT NULL,
  last_http_status INTEGER,
  last_error TEXT,
  last_event TEXT,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);

-- 同じ通知を続けて送らないための記録（打刻・日報の失敗は60分に1回までなど）。
-- pending は前回の通知の後に起きて、まだ知らせていない件数。last_pending は最後に通知したときに一緒に知らせた件数。
-- claim_token は最後に通知を出した呼び出しの印（同時に2つの要求が来ても、通知を出すのは1つだけにする）
CREATE TABLE IF NOT EXISTS alert_cooldowns (
  alert_key TEXT PRIMARY KEY,
  last_sent_at TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  last_pending INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  updated_at TEXT NOT NULL
);
