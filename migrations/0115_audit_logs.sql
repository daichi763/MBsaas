-- 操作の記録（Sprint 31 w31-audit: #9988。利用者の要望 11/17「CSV出力や諸々の操作履歴もわかるようにして欲しい」）
--
-- CSV・ファイルの書き出しと、管理の操作（スタッフ・従業員の情報、管理者・ログイン、設定、案件・クライアント、お知らせ、統合・退職）を
-- 1操作1行で残す（無料プランの書き込みの枠のため、項目ごとの行にはしない）。書き込みは src/lib/audit-log.ts の /api/admin/* のミドルウェアだけが行う。
--   category   : csv（CSV・ファイル）/ staff（スタッフ・従業員）/ admin（管理者・ログイン）/ settings（設定）/ master（案件・クライアント）/ notice（お知らせ）
--   action     : 操作の名前（src/lib/audit-log.ts の AUDIT_ROUTES の action）
--   label      : 画面に出す操作の名前（書いた時点の文言を残す）
--   target_*   : 操作の対象（staff / employee / user / project / client / notice / partner / site など）と、その時点の名前
--   detail_json: 内容（CSV は file・rows・filters、変更は changes の [項目, 前, 後]。口座などの秘密の値は「変更あり」だけ）
--   actor_role : 操作した人のロール（system_admin は本部の閲覧中の書き出し）
--   ip         : 接続元（CF-Connecting-IP）
--   created_at : 日本時間（YYYY-MM-DD HH:MM:SS）。保存は1年（login_events と同じ。毎日の cron の auth_purge で消す）
-- シフト・精算の操作履歴（operation_logs）とログインの履歴（login_events）は作り直さず、「操作の記録」の画面で読むときに合わせて出す
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  actor_role TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  label TEXT,
  target_type TEXT,
  target_id INTEGER,
  target_name TEXT,
  detail_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
-- 画面の一覧（会社・新しい順、種類で絞る）と、1年を過ぎた行の削除
CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(company_id, category, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at);
