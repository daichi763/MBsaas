-- ログインの失敗で D1 の書き込みの枠を使い切られないようにする（Sprint 33 #10001 セキュリティの点検 H2。作業単位 w33-sec-auth）
-- 無料プランの D1 の書き込みは1日10万行。失敗1回ごとに login_events を1行足していたので、IP を変えながら送られると枠を使い切られ、
-- 翌 9:00（UTC の 0 時）まで全社の打刻・日報が保存できなくなる。そこで、
--   ・失敗（成功以外）の login_events は「同じ接続元 × 同じ種類 × 同じ会社・利用者 × 同じ1分」を1行にまとめ、件数を repeat_count に数える
--   ・締め出し中・全体の上限を超えたときは何も書かずに 429 で断る（src/api.ts の /auth/login。判定は src/lib/login-security.ts）
-- 列・表の追加のみ（既存の列・値は変えない）。前の版のコードは新しい列を書かない（repeat_count は既定の 1、bucket_key は NULL）ので、デプロイの前に当ててよい。

-- 1. ログインの履歴の件数と、まとめる行の鍵
--    repeat_count: この行にまとめた回数（成功・パスワードの再設定などは常に 1。以前の行も 1）
--    bucket_key: まとめる行の鍵（接続元|種類|結果|会社|利用者|UTC の分。例 203.0.113.5|login|bad_password|1|12|2026-11-20T01:23）。まとめない行は NULL
ALTER TABLE login_events ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE login_events ADD COLUMN bucket_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_login_events_bucket ON login_events(bucket_key) WHERE bucket_key IS NOT NULL;

-- 2. ログインしていない人の書き込みの、全体の回数（1分ごと・1日ごと）。会社・利用者の情報は持たない（退職・解約の削除の対象外）
--    scope: login（ログイン・二段階認証の失敗）/ public（パスワードの再設定の依頼・募集ページの応募）
--    minute: 数えている分（UTC の 'YYYY-MM-DDTHH:MM'）。day: 数えている日（UTC の 'YYYY-MM-DD'。D1 の無料枠が戻る区切り = 日本時間 9:00）
--    表は scope ごとに1行だけ（分・日が変わったら数え直す）
CREATE TABLE IF NOT EXISTS auth_write_counters (
  scope TEXT PRIMARY KEY,
  minute TEXT NOT NULL,
  minute_count INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  day_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
