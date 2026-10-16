-- w2-shift-request（#12 #59 #353 #411）
-- 1) スタッフが出すシフト希望は shifts と分けて持つ（#12）。
--    shifts.project_id は NOT NULL で projects への外部キーがあるため、案件を選ばない希望を入れられなかった。
--    希望の案件は任意（NULL 可）。管理者の返事（採用・見送り）と本人の取り下げをここに残す（#353）。
--    定期削除で staff_profiles を消せるよう、外部キーは付けない（会社・スタッフの確認は API で行う）。
-- status: pending（返事待ち）/ accepted（採用）/ declined（見送り）/ withdrawn（本人が取り下げ）
-- 日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。
CREATE TABLE IF NOT EXISTS shift_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,                    -- 提出したユーザー（本人）
  project_id INTEGER,                          -- 希望する案件（任意）
  work_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  response_note TEXT,                          -- 管理者からの返事（任意）
  responded_by INTEGER,
  responded_at TEXT,
  withdrawn_at TEXT,
  legacy_shift_id INTEGER,                     -- 0034 で shifts から移した行の元の shift_id
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_shift_requests_company ON shift_requests(company_id, work_date, status);
CREATE INDEX IF NOT EXISTS idx_shift_requests_staff ON shift_requests(staff_id, work_date);
-- 同じ日時の返事待ちの希望は1件だけ（二度押し・再送の防止）
CREATE UNIQUE INDEX IF NOT EXISTS uq_shift_requests_pending ON shift_requests(staff_id, work_date, start_time, end_time) WHERE status = 'pending';

-- 2) これまでスタッフ本人が出した希望（shifts.status = 'requested' で登録者が本人）を移す。
--    勤怠・日報・報告用URL・打刻修正・応募と結び付いた行は、参照を壊さないよう移さずに残す。
INSERT OR IGNORE INTO shift_requests (company_id, staff_id, user_id, project_id, work_date, start_time, end_time, memo, status, legacy_shift_id, created_at)
SELECT s.company_id, s.staff_id, s.registered_by, s.project_id, s.work_date, s.start_time, s.end_time, NULLIF(s.memo, '希望提出'), 'pending', s.shift_id,
  COALESCE(datetime(s.created_at, '+9 hours'), datetime('now', '+9 hours'))  -- shifts.created_at は UTC（CURRENT_TIMESTAMP）
FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id
WHERE s.status = 'requested' AND s.registered_by IS NOT NULL AND s.registered_by = sp.user_id
  AND s.slot_id IS NULL AND COALESCE(s.settle_status, 'planned') != 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM attendance_reports x WHERE x.shift_id = s.shift_id)
  AND NOT EXISTS (SELECT 1 FROM daily_reports x WHERE x.shift_id = s.shift_id)
  AND NOT EXISTS (SELECT 1 FROM shift_report_tokens x WHERE x.shift_id = s.shift_id)
  AND NOT EXISTS (SELECT 1 FROM attendance_corrections x WHERE x.shift_id = s.shift_id)
  AND NOT EXISTS (SELECT 1 FROM recruit_application_items x WHERE x.shift_id = s.shift_id)
  AND NOT EXISTS (SELECT 1 FROM shift_requests r WHERE r.legacy_shift_id = s.shift_id);
DELETE FROM shifts WHERE status = 'requested' AND shift_id IN (SELECT legacy_shift_id FROM shift_requests WHERE legacy_shift_id IS NOT NULL);

-- 3) 管理者が『希望（仮）』で入れたシフト（shifts.status = 'requested'）への本人の返事（#411）
-- staff_reply: ok（入れます）/ ng（入れません）。NULL = 返事なし
ALTER TABLE shifts ADD COLUMN staff_reply TEXT;
ALTER TABLE shifts ADD COLUMN staff_reply_note TEXT;
ALTER TABLE shifts ADD COLUMN staff_reply_at TEXT;
