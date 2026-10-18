-- =========================================================
-- 精算の確認事項（w3-settlement-checks: #233 #563）
-- 既存の行は変えない（表の追加のみ）
-- シフトの削除・定期削除を止めないよう、shift_id には外部キーを付けない（シフトが消えた行は参照されないだけ）
-- =========================================================

-- ---------- 確認事項の「確認済み」（#563） ----------
-- issue は精算画面に出す確認事項の文言そのもの。文言が変われば（実働の差が変わった等）確認済みではなくなる。
-- 確定後に起きる項目（確定後に打刻修正あり など）は、acked_at より後に新しい修正・報告があれば再び確認が必要になる
CREATE TABLE IF NOT EXISTS settlement_issue_acks (
  ack_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  issue TEXT NOT NULL,
  acked_by INTEGER,
  acked_at DATETIME NOT NULL,
  UNIQUE (shift_id, issue)
);
CREATE INDEX IF NOT EXISTS idx_settlement_issue_acks_company ON settlement_issue_acks(company_id, shift_id);

-- ---------- 区分変更で置き換えの対象から外したシフト（#233） ----------
-- 勤務済み（勤怠報告・実績・日報のどれかがある）のため支払先・単価を置き換えなかったシフトと、そのときの変更後の支払先。
-- 精算で、支払先がこの値と違う未確定のシフトを確認事項『区分変更の対象外』として出す
CREATE TABLE IF NOT EXISTS affiliation_excluded_shifts (
  history_id INTEGER NOT NULL,                   -- staff_affiliation_history
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  to_payee_type TEXT NOT NULL,                   -- 変更後の支払先（payroll / payroll_daily / freelance / partner）
  to_payee_affiliation_id INTEGER,               -- 取引先のとき
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (history_id, shift_id)
);
CREATE INDEX IF NOT EXISTS idx_aff_excluded_shift ON affiliation_excluded_shifts(shift_id);
