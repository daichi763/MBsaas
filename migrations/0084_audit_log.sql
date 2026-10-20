-- シフト・募集枠・精算の操作履歴（w6-audit-log: #159）
--
-- 管理者は全員が自社の全案件を扱うため、シフトの編集・削除、精算の確定・取り消し、金額・実績の変更などを
-- 「だれが・いつ・何を・前後の値」で残す。1件の操作で変わった行ごとに1行（まとめての操作は op_key で束ねる）。
--   entity     : shift（シフト。キャンセル料・補償を含む）/ slot（募集枠と役割）
--   action     : create / update / delete / move / confirm / unconfirm / price / actual / cancellation / reprice など
--   before_json: 変更の前の値（作成は NULL）。after_json: 変更の後の値（削除は NULL）。値は src/lib/operation-log.ts の項目だけ
--   staff_id   : シフトの担当スタッフ（退職後7年の定期削除で、その人の履歴も消す）
--   created_at : 日本時間（YYYY-MM-DD HH:MM:SS）。保存期間は7年（src/services/retention.ts）
CREATE TABLE IF NOT EXISTS operation_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  staff_id INTEGER,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor_user_id INTEGER,                 -- 操作したユーザー
  op_key TEXT NOT NULL,                  -- 1回の操作の識別子
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operation_logs_entity ON operation_logs(entity, entity_id, log_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_company ON operation_logs(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_logs_staff ON operation_logs(staff_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_op ON operation_logs(op_key);
