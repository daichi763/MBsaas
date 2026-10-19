-- シフトの差し替え・欠勤・削除と打刻修正・報告用URLの整合（w3-corrections-consistency: #70 #101 #252）
--
-- attendance_corrections.cancel_reason: 申請者本人以外の理由で取り消した申請の理由（#70 #101）
--   shift_deleted = シフトが削除されたため / staff_changed = シフトの担当者が差し替えられたため。本人の取り消しは NULL
-- attendance_reports.corrected_by_correction_id / corrected_at / original_reported_at:
--   打刻修正の承認で変わった報告の印（#252）。entry_method（app / link / proxy / correction）は元の打刻の方法のまま残す。
--   original_reported_at は最初の修正の前の日時（何度修正しても最初の打刻の日時を残す）

ALTER TABLE attendance_corrections ADD COLUMN cancel_reason TEXT;

ALTER TABLE attendance_reports ADD COLUMN corrected_by_correction_id INTEGER;
ALTER TABLE attendance_reports ADD COLUMN corrected_at TEXT;
ALTER TABLE attendance_reports ADD COLUMN original_reported_at TEXT;

-- 既存の承認済みの修正に印を付ける（時刻修正 = 最後の承認の申請・最初の修正前の日時。打刻漏れの追加 = 追加した申請）
UPDATE attendance_reports
SET corrected_by_correction_id = (SELECT MAX(c.correction_id) FROM attendance_corrections c WHERE c.status = 'approved' AND c.applied_attendance_id = attendance_reports.attendance_id),
    corrected_at = (SELECT c.decided_at FROM attendance_corrections c WHERE c.status = 'approved' AND c.applied_attendance_id = attendance_reports.attendance_id ORDER BY c.correction_id DESC LIMIT 1),
    original_reported_at = (SELECT c.before_at FROM attendance_corrections c WHERE c.status = 'approved' AND c.kind = 'modify' AND c.applied_attendance_id = attendance_reports.attendance_id ORDER BY c.correction_id LIMIT 1)
WHERE corrected_by_correction_id IS NULL
  AND EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.status = 'approved' AND c.applied_attendance_id = attendance_reports.attendance_id);

-- 削除されたシフトの承認待ちは処理できないので取り消す（#70）
INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
SELECT correction_id, company_id, 'cancelled', NULL, 'システム', NULL, '{"auto":true,"reason":"shift_deleted"}', datetime('now', '+9 hours')
FROM attendance_corrections WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.shift_id = attendance_corrections.shift_id);
UPDATE attendance_corrections SET status = 'cancelled', cancel_reason = 'shift_deleted', cancelled_at = datetime('now', '+9 hours'), updated_at = datetime('now', '+9 hours')
WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.shift_id = attendance_corrections.shift_id);

-- 担当者が差し替えられたシフトに残っている前の担当者の承認待ちを取り消す（#101）
INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
SELECT c.correction_id, c.company_id, 'cancelled', NULL, 'システム', NULL, '{"auto":true,"reason":"staff_changed"}', datetime('now', '+9 hours')
FROM attendance_corrections c JOIN shifts s ON s.shift_id = c.shift_id WHERE c.status = 'pending' AND s.staff_id != c.staff_id;
UPDATE attendance_corrections SET status = 'cancelled', cancel_reason = 'staff_changed', cancelled_at = datetime('now', '+9 hours'), updated_at = datetime('now', '+9 hours')
WHERE status = 'pending' AND EXISTS (SELECT 1 FROM shifts s WHERE s.shift_id = attendance_corrections.shift_id AND s.staff_id != attendance_corrections.staff_id);

-- 処理済み・取り消し済みの申請の承認依頼を既読にする（#189）
UPDATE user_notifications SET read_at = datetime('now', '+9 hours')
WHERE kind = 'correction_submitted' AND read_at IS NULL
  AND EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.correction_id = user_notifications.related_id AND c.status != 'pending');

-- 承認・却下・取り消しのたびに、その申請の承認依頼（related_id）を既読にするため（#189。全件の走査を避ける）
CREATE INDEX IF NOT EXISTS idx_user_notifications_related ON user_notifications(related_id, kind);
