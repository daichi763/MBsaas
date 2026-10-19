-- 0061: 精算の締め・明細書・キャンセル料（w4-settlement-features: #168 #170 #283）
-- 表・列の追加と、請求条件（自由入力）から締め日を読み取る補いだけ。既存の値は変えない。
-- シフトの削除・定期削除を止めないよう、shift_id には外部キーを付けない（シフトが消えた行は参照されないだけ）

-- ---------- #170 精算の締め（期間のロック） ----------
-- reopened_at が NULL の行が有効な締め。締めた期間（period_from〜period_to。稼働日）のシフトは、
-- 確定・取り消し、実績・金額の変更、報告・打刻修正の実績への反映、シフトの追加・変更・削除を受け付けない。
-- 解除は会社管理者だけが理由を入力して行い、行は消さずに解除の日時・人・理由を残す
CREATE TABLE IF NOT EXISTS settlement_closings (
  closing_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  shift_count INTEGER NOT NULL DEFAULT 0,        -- 締めたときの精算の対象（確定済み）の件数
  bill_total INTEGER NOT NULL DEFAULT 0,         -- 締めたときの請求合計
  pay_total INTEGER NOT NULL DEFAULT 0,          -- 締めたときの支払合計
  note TEXT,
  closed_by INTEGER,
  closed_at DATETIME NOT NULL,
  reopened_by INTEGER,
  reopened_at DATETIME,
  reopen_reason TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_settlement_closings_company ON settlement_closings(company_id, period_from, period_to);

-- CSV・明細書を出力した記録（いつ・だれが・どの期間を出したか）
CREATE TABLE IF NOT EXISTS settlement_export_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- detail / billing / payment / statement_billing / statement_payment
  period_from DATE,
  period_to DATE,
  filters_json TEXT,
  row_count INTEGER,
  exported_by INTEGER,
  exported_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_export_logs_company ON settlement_export_logs(company_id, exported_at);

-- ---------- #168 クライアントの締め日 ----------
-- 1〜31（31 = 月末。その月にない日は月末として扱う）。NULL = 未設定（暦月）
ALTER TABLE clients ADD COLUMN billing_closing_day INTEGER;
-- 請求条件（billing_rule。例: 『20日締め・翌月末払い』『月末締め』）から締め日を読み取れるものだけ補う。
-- 2桁の日を先に調べる（『15日締』を『5日締』と読まないように）
UPDATE clients SET billing_closing_day = CASE
    WHEN billing_rule LIKE '%月末締%' OR billing_rule LIKE '%末日締%' THEN 31
    WHEN billing_rule LIKE '%31日締%' THEN 31
    WHEN billing_rule LIKE '%30日締%' THEN 30
    WHEN billing_rule LIKE '%29日締%' THEN 29
    WHEN billing_rule LIKE '%28日締%' THEN 28
    WHEN billing_rule LIKE '%27日締%' THEN 27
    WHEN billing_rule LIKE '%26日締%' THEN 26
    WHEN billing_rule LIKE '%25日締%' THEN 25
    WHEN billing_rule LIKE '%24日締%' THEN 24
    WHEN billing_rule LIKE '%23日締%' THEN 23
    WHEN billing_rule LIKE '%22日締%' THEN 22
    WHEN billing_rule LIKE '%21日締%' THEN 21
    WHEN billing_rule LIKE '%20日締%' THEN 20
    WHEN billing_rule LIKE '%19日締%' THEN 19
    WHEN billing_rule LIKE '%18日締%' THEN 18
    WHEN billing_rule LIKE '%17日締%' THEN 17
    WHEN billing_rule LIKE '%16日締%' THEN 16
    WHEN billing_rule LIKE '%15日締%' THEN 15
    WHEN billing_rule LIKE '%14日締%' THEN 14
    WHEN billing_rule LIKE '%13日締%' THEN 13
    WHEN billing_rule LIKE '%12日締%' THEN 12
    WHEN billing_rule LIKE '%11日締%' THEN 11
    WHEN billing_rule LIKE '%10日締%' THEN 10
    WHEN billing_rule LIKE '%9日締%' THEN 9
    WHEN billing_rule LIKE '%8日締%' THEN 8
    WHEN billing_rule LIKE '%7日締%' THEN 7
    WHEN billing_rule LIKE '%6日締%' THEN 6
    WHEN billing_rule LIKE '%5日締%' THEN 5
    WHEN billing_rule LIKE '%4日締%' THEN 4
    WHEN billing_rule LIKE '%3日締%' THEN 3
    WHEN billing_rule LIKE '%2日締%' THEN 2
    WHEN billing_rule LIKE '%1日締%' THEN 1
    ELSE NULL END
WHERE billing_closing_day IS NULL AND billing_rule IS NOT NULL AND billing_rule LIKE '%締%';

-- ---------- #283 欠勤・中止のキャンセル料（請求）と補償・控除（支払） ----------
-- 欠勤（status = 'absent'）のシフトのうち、この表に行のあるものを精算の対象にする（金額はこの表の値。確定は shifts.settle_status）。
-- 金額はスタッフ向けの API に出さないよう、shifts の列ではなく別の表に持つ
CREATE TABLE IF NOT EXISTS shift_cancellations (
  shift_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  reason TEXT NOT NULL,                          -- staff（スタッフ都合の欠勤） / client（クライアント都合の中止）
  notified_on DATE,                              -- 欠勤・中止の連絡を受けた日（規定の『前日まで』『当日』の判定に使う）
  bill_amount INTEGER,                           -- クライアントへのキャンセル料（請求）
  pay_amount INTEGER,                            -- スタッフ・支払先への補償（負の値は控除）
  note TEXT,
  updated_by INTEGER,
  updated_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shift_cancellations_company ON shift_cancellations(company_id);
-- 欠勤にした日時（管理画面で欠勤にしたとき。連絡日の初期値に使う）
ALTER TABLE shifts ADD COLUMN absent_at DATETIME;

-- 案件ごとのキャンセル料の規定（率は %。NULL = 規定なし）。
-- クライアント都合の中止: 請求 = 予定の請求基本額 × 前日／当日の率、支払 = 予定の支払基本額 × 補償率
CREATE TABLE IF NOT EXISTS project_cancel_policies (
  project_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  bill_rate_prev_day INTEGER,                    -- 前日の連絡
  bill_rate_same_day INTEGER,                    -- 当日の連絡
  pay_rate INTEGER,                              -- クライアント都合の中止での補償率
  updated_by INTEGER,
  updated_at DATETIME NOT NULL
);
