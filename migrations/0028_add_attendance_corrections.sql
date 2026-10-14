-- 打刻修正申請（docs/spec_attendance_correction.md 4章）
-- 1 申請 = 1 報告種類。承認されるまで正式な勤怠データ（attendance_reports）は変えない。
-- 外部キーは張らない（既存の定期削除・シフト削除の処理を止めないため）。ID と申請時点の値を持つ。
-- 日時はアプリの記録（nowJST()）に合わせて日本時間の 'YYYY-MM-DD HH:MM:SS'。

CREATE TABLE IF NOT EXISTS attendance_corrections (
  correction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,                 -- シフトの所有企業
  project_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  attendance_id INTEGER,                       -- 修正対象の報告（打刻漏れの追加は NULL）
  kind TEXT NOT NULL,                          -- modify（時刻修正）/ add（打刻漏れの追加）
  report_type TEXT NOT NULL,
  before_at TEXT,                              -- 修正前の日時（add は NULL）
  requested_at TEXT NOT NULL,                  -- 修正後の日時
  reason TEXT NOT NULL,
  order_warnings TEXT,                         -- 順序の矛盾（JSON 配列。add で矛盾がある場合のみ）
  status TEXT NOT NULL DEFAULT 'pending',      -- pending / approved / rejected / cancelled
  is_exception INTEGER NOT NULL DEFAULT 0,     -- 1 = 順序の矛盾を承知のうえで承認した
  requested_by INTEGER NOT NULL,
  requested_by_name TEXT,
  requested_by_role TEXT,
  decided_by INTEGER,
  decided_by_name TEXT,
  decided_at TEXT,
  decision_token TEXT,                         -- 承認・却下の処理ごとの識別子（同時処理の判定用）
  decision_comment TEXT,                       -- 承認者コメント
  reject_reason TEXT,
  cancelled_at TEXT,
  resubmitted_from INTEGER,                    -- 再申請の元の申請
  applied_attendance_id INTEGER,               -- 承認で反映した報告
  applied_while_settled INTEGER NOT NULL DEFAULT 0, -- 反映時にシフトが確定済みだった（実績・金額は変えていない）
  created_at TEXT DEFAULT (datetime('now', '+9 hours')),
  updated_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
-- 同じシフト・報告種類の承認待ちは 1 件まで
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_corrections_pending ON attendance_corrections(shift_id, report_type) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_company ON attendance_corrections(company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_staff ON attendance_corrections(staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_shift ON attendance_corrections(shift_id);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_from ON attendance_corrections(resubmitted_from);

-- 申請の操作履歴（追記のみ）
-- event: submitted / resubmitted / approved / approved_exception / rejected / cancelled
CREATE TABLE IF NOT EXISTS attendance_correction_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_name TEXT,
  actor_role TEXT,
  detail TEXT,                                 -- JSON（変更前後の日時・理由・コメント・矛盾内容）
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_attendance_correction_events_correction ON attendance_correction_events(correction_id, event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_correction_events_company ON attendance_correction_events(company_id, created_at);
