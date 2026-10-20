-- 解約・停止した企業のデータの書き出しと削除（作業単位 w5-hq-offboarding: #177）
--
-- 1. 解約の処理（企業ごと）。本部が「契約終了」を登録すると猶予中（scheduled）になり、
--    契約終了日＋猶予日数（delete_after）を過ぎると、本部の二重の確認のうえで削除できる（deleting → completed）。
--    削除は1回の要求で処理できる量に区切って進める（delete_step は次に処理する段階の番号）。
--    取り消した記録（cancelled）・削除が済んだ記録（completed）は残し、削除の証明に使う。
--    日時は ISO 8601（UTC）、日付は YYYY-MM-DD（日本時間）。
CREATE TABLE IF NOT EXISTS company_offboardings (
  offboarding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled（猶予中）/ deleting（削除中）/ completed（削除済み）/ cancelled（取消）
  contract_end_date TEXT NOT NULL,
  grace_days INTEGER NOT NULL,
  delete_after TEXT NOT NULL,               -- この日から削除できる（契約終了日＋猶予日数）
  reason TEXT,
  requested_by INTEGER,
  requested_at TEXT NOT NULL,
  export_skip_reason TEXT,                  -- 書き出しをせずに削除した理由（企業が不要と回答した など）
  cancelled_by INTEGER,
  cancelled_at TEXT,
  delete_started_by INTEGER,
  delete_started_at TEXT,
  delete_step INTEGER NOT NULL DEFAULT 0,
  deleted_json TEXT,                        -- 対象ごとの削除・匿名化の件数（JSON）
  completed_at TEXT,
  last_error TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_offboardings_company ON company_offboardings(company_id, offboarding_id);
-- 1つの企業で進行中（猶予中・削除中）の処理は1つだけ
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_offboardings_open ON company_offboardings(company_id) WHERE status IN ('scheduled', 'deleting');

-- 2. 操作の記録（契約終了の登録・取消・書き出し・ファイルの取得・削除の開始と完了・失敗）。
--    offboarding_id は契約終了の登録前の書き出しでは NULL。detail は JSON
CREATE TABLE IF NOT EXISTS company_offboarding_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  offboarding_id INTEGER,
  company_id INTEGER NOT NULL,
  action TEXT NOT NULL,                     -- start / cancel / export / file / delete_start / delete_error / complete
  actor_user_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_offboarding_events_company ON company_offboarding_events(company_id, event_id);

-- 3. 削除する R2 のファイル。D1 の行を消す前にキーを控え、D1 の削除が済んでから R2 を消す（消せたものから行を消す）。
--    bucket は photos（PHOTOS）/ documents（DOCUMENTS）/ contracts（CONTRACTS）
CREATE TABLE IF NOT EXISTS offboarding_pending_r2 (
  bucket TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  offboarding_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket, r2_key)
);
CREATE INDEX IF NOT EXISTS idx_offboarding_pending_r2 ON offboarding_pending_r2(offboarding_id);
