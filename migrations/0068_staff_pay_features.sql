-- 0068: スタッフからの交通費（実費）・残業（延長）の申請（w5-staff-pay-features: #273 #172）
-- 表の追加だけ。既存の値は変えない。
-- スタッフに支払額を表示するか（#290）は companies.settings_json の staff_pay_visible（既定 OFF）に持つため、列は足さない。
-- シフトの削除・定期削除を止めないよう、shift_id には外部キーを付けない（シフトが消えた行は参照されないだけ）

-- kind: transport（交通費の実費）/ overtime（残業・延長）
-- status: pending（承認待ち）/ approved / rejected / cancelled（本人の取り消し）
-- 承認すると、transport は shifts.transportation_fee を申請の金額に、overtime は shifts.end_time を延長後の終了時刻に変える
CREATE TABLE IF NOT EXISTS staff_pay_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,                   -- シフトの所有企業（承認する企業）
  shift_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- 交通費（transport）
  amount INTEGER,                                -- 申請の金額（円。往復の合計）
  route TEXT,                                    -- 区間（例: 新宿〜渋谷）
  round_trip INTEGER,                            -- 1 = 往復
  before_amount INTEGER,                         -- 申請したときのシフトの交通費（実費）
  -- 残業・延長（overtime）
  new_end_time TEXT,                             -- 延長後の終了時刻（HH:MM）
  before_end_time TEXT,                          -- 申請したときの予定の終了時刻
  instructed_by TEXT,                            -- 延長を指示した人
  reason TEXT,                                   -- 理由・メモ
  requested_by INTEGER,                          -- 申請したユーザー
  created_at DATETIME NOT NULL,
  decided_by INTEGER,
  decided_by_name TEXT,
  decided_at DATETIME,
  decision_note TEXT,                            -- 却下の理由・承認のコメント
  approved_amount INTEGER,                       -- 承認した金額（管理者が直した場合はその値）
  approved_end_time TEXT                         -- 承認した終了時刻（管理者が直した場合はその値）
);
CREATE INDEX IF NOT EXISTS idx_staff_pay_requests_company ON staff_pay_requests(company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_staff_pay_requests_shift ON staff_pay_requests(shift_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_staff_pay_requests_staff ON staff_pay_requests(staff_id, created_at);
