-- 翌月の出勤可能日の提出と、確定シフトのカレンダー追加（w5-staff-schedule: #171 #301）
--
-- #171 staff_availability: スタッフが月のカレンダーで付けた日ごとの出勤可否（1人1日1行）。
--   status: ok（終日可 ○）/ partial（時間帯なら可 △。start_time・end_time）/ ng（不可 ×）。行が無い日は未入力。
--   シフト（shifts）とも、案件を指定したシフト希望（shift_requests）とも別に持つ。日付は 'YYYY-MM-DD'（日本時間）
CREATE TABLE IF NOT EXISTS staff_availability (
  availability_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'ng')),
  start_time TEXT,
  end_time TEXT,
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now', '+9 hours')),
  UNIQUE (staff_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_staff_availability_company_date ON staff_availability(company_id, work_date);

-- #171 availability_submissions: 月ごとの提出の記録（未提出者の一覧と、締切後の提出の判定に使う）。
--   submitted_at は最初に提出した日時、updated_at は最後に出し直した日時（日本時間）
CREATE TABLE IF NOT EXISTS availability_submissions (
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  month TEXT NOT NULL,                  -- 'YYYY-MM'
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, month)
);
CREATE INDEX IF NOT EXISTS idx_availability_submissions_company ON availability_submissions(company_id, month);

-- #171 availability_periods: 会社が月ごとに決める提出の締切と、スタッフへの案内文。未提出者へ通知した日時も残す
CREATE TABLE IF NOT EXISTS availability_periods (
  company_id INTEGER NOT NULL,
  month TEXT NOT NULL,                  -- 'YYYY-MM'（どの月の出勤可能日か）
  deadline TEXT,                        -- 提出の締切日 'YYYY-MM-DD'（その日の終わりまで）
  note TEXT,
  last_reminded_at TEXT,
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now', '+9 hours')),
  PRIMARY KEY (company_id, month)
);

-- #301 staff_calendar_tokens: シフトをカレンダーアプリで購読する URL のトークン（1人1つ。ハッシュで保存し、発行し直すと前の URL は使えない）。
--   本人（user_id）が停止・退職になったり、会社が停止になったりしたら、URL があっても返さない
CREATE TABLE IF NOT EXISTS staff_calendar_tokens (
  user_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now', '+9 hours')),
  last_accessed_at TEXT
);
