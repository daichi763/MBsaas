-- 第3段階: 実績の確定（実働時間）と請求・支払の集計・CSV出力
-- 列の追加のみ。既存のシフトは「実績未入力・未確定」として扱う（金額はこれまでどおり予定時間で計算済み）

-- 実績（入店・退店報告から反映、または管理者が入力）
ALTER TABLE shifts ADD COLUMN actual_start TEXT;              -- 実績の開始 HH:MM
ALTER TABLE shifts ADD COLUMN actual_end TEXT;                -- 実績の終了 HH:MM（日をまたぐ場合は開始より小さい値）
ALTER TABLE shifts ADD COLUMN actual_break_minutes INTEGER;   -- 実績の休憩（分）。NULL = 予定の休憩
ALTER TABLE shifts ADD COLUMN actual_source TEXT;             -- report（報告から反映）/ manual（管理者が入力）
ALTER TABLE shifts ADD COLUMN actual_note TEXT;
-- 確定（確定したシフトは金額・時間・スタッフを変更できない。取り消すと再び変更できる）
ALTER TABLE shifts ADD COLUMN settle_status TEXT DEFAULT 'planned';   -- planned（未確定）/ confirmed（確定）
ALTER TABLE shifts ADD COLUMN settled_at DATETIME;
ALTER TABLE shifts ADD COLUMN settled_by INTEGER;

-- 時給の数量の計算方法（案件ごと）
--   clipped: 実績。ただし予定の範囲内（早く来た・遅く残った分は含めない）… 既定
--   actual : 実績どおり
--   scheduled: 予定どおり（実績は記録のみ）
ALTER TABLE projects ADD COLUMN hours_basis TEXT DEFAULT 'clipped';
-- 丸め（分）。開始は切り上げ、終了は切り捨て。0 または NULL は丸めない
ALTER TABLE projects ADD COLUMN time_round_minutes INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_shifts_company_date_settle ON shifts(company_id, work_date, settle_status);
