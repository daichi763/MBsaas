-- 深夜・時間外・休日の割増の自動計算と、交通費の標準（作業単位 w6-premium-pay: #167 #564）
--
-- 1. 割増の設定（企業ごと。行がなければ割増を計算しない）。
--    対象は支払先が自社給与・日雇い給与（payee_type が payroll / payroll_daily）のシフトだけ。
--    深夜 = 22:00〜5:00 の勤務、時間外 = 同じスタッフ・同じ稼働日の勤務の合計が daily_limit_minutes を超えた分（後の時間のシフトに付ける）、
--    休日 = holiday_weekdays の曜日の勤務（休日の勤務には時間外を付けない）。割増率は %（25 = 25%）。
--    割増額 = 1時間あたりの賃金 ×（深夜の時間 × 深夜の率 ＋ 時間外の時間 × 時間外の率 ＋ 休日の時間 × 休日の率）。
--    1時間あたりの賃金は、時給はその単価、日額は単価を予定の実働時間で割った額。計算は src/lib/premium-pay.ts。
CREATE TABLE IF NOT EXISTS premium_pay_settings (
  company_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  night_rate INTEGER NOT NULL DEFAULT 25,
  overtime_rate INTEGER NOT NULL DEFAULT 25,
  holiday_rate INTEGER NOT NULL DEFAULT 35,
  holiday_weekdays TEXT NOT NULL DEFAULT '',   -- 休日の曜日（0 = 日曜 〜 6 = 土曜）をカンマで区切る。空なら休日の割増なし
  daily_limit_minutes INTEGER NOT NULL DEFAULT 480,
  updated_by INTEGER,
  updated_at TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);

-- 2. 確定した時点の割増（確定済みのシフトはこの値を使い、未確定のシフトは表示のたびに計算する）。
--    確定を取り消すと 0 / NULL に戻す。既存の行は割増なし（0）のまま
ALTER TABLE shifts ADD COLUMN pay_premium INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN premium_night_minutes INTEGER;
ALTER TABLE shifts ADD COLUMN premium_overtime_minutes INTEGER;
ALTER TABLE shifts ADD COLUMN premium_holiday_minutes INTEGER;

-- 3. 交通費の標準（スタッフ × 開催場所。往復・円）。site_id = 0 はそのスタッフのすべての開催場所に使う標準。
--    シフトボードの割り当て・一括登録と募集の承認で、交通費の入力がなければこの値を実費（transportation_fee）に入れる。
--    開催場所の標準があればそれを、なければ site_id = 0 の標準を使う
CREATE TABLE IF NOT EXISTS staff_transport_defaults (
  default_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  note TEXT,
  updated_by INTEGER,
  updated_at TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_transport_defaults ON staff_transport_defaults(company_id, staff_id, site_id);
CREATE INDEX IF NOT EXISTS idx_staff_transport_defaults_staff ON staff_transport_defaults(staff_id);
