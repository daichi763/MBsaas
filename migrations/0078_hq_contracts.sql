-- 本部の契約管理（w5-hq-contracts: #295 #296 #558 #542 #491）
--
-- #296 契約の期日: トライアルの終了日・契約開始日・次回レビュー日（いずれも YYYY-MM-DD。未設定は NULL）
ALTER TABLE companies ADD COLUMN trial_ends_at TEXT;
ALTER TABLE companies ADD COLUMN contract_start_at TEXT;
ALTER TABLE companies ADD COLUMN next_review_at TEXT;

-- #558 企業の連絡先（担当者・電話・メール・請求先の住所）。本部の企業詳細で編集する
ALTER TABLE companies ADD COLUMN contact_name TEXT;
ALTER TABLE companies ADD COLUMN contact_phone TEXT;
ALTER TABLE companies ADD COLUMN contact_email TEXT;
ALTER TABLE companies ADD COLUMN billing_address TEXT;

-- #491 最後にアプリを使った日時（日本時間の文字列。last_login_at と同じ書式）。
--   ログインのほか、セッションでの操作（1時間に1回まで）と企業切替の後の操作でも更新する。週次アクティブの集計に使う
ALTER TABLE users ADD COLUMN last_seen_at TEXT;

-- #296 伴走支援の履歴（上書きの support_memo とは別に、追記で残す）。next_action_date は次回の予定日（YYYY-MM-DD）
CREATE TABLE IF NOT EXISTS company_support_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  body TEXT NOT NULL,
  next_action_date TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_company_support_logs_company ON company_support_logs(company_id, created_at);

-- これまでの伴走支援メモを、履歴の最初の1件として残す（メモの欄はそのまま）
INSERT INTO company_support_logs (company_id, actor_user_id, body, created_at)
SELECT company_id, NULL, '（これまでの伴走支援メモ）' || char(10) || support_memo, COALESCE(created_at, datetime('now', '+9 hours'))
FROM companies
WHERE COALESCE(TRIM(support_memo), '') != ''
  AND NOT EXISTS (SELECT 1 FROM company_support_logs l WHERE l.company_id = companies.company_id);

-- #295 プランごとの料金（基本料金・基本料金に含む人数・追加1人あたり）。
--   これまでの料金（990円で3人まで、追加1人300円）を3つのプランに入れておく（金額は変わらない）。本部の画面で変更する
CREATE TABLE IF NOT EXISTS hq_plan_prices (
  plan TEXT PRIMARY KEY,                 -- basic / standard / premium
  base_fee INTEGER NOT NULL,
  included_users INTEGER NOT NULL,
  per_user_fee INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
INSERT OR IGNORE INTO hq_plan_prices (plan, base_fee, included_users, per_user_fee) VALUES
  ('basic', 990, 3, 300), ('standard', 990, 3, 300), ('premium', 990, 3, 300);

-- #295 月ごとの請求記録。締めた時点の課金対象の人数・プラン・金額を残す（後から人数が変わっても記録は変わらない）。
--   status: issued（請求済み・入金待ち）/ paid（入金済み）/ overdue（滞納）/ waived（請求しない）
--   recorded_at は人数を数えた日時（日本時間）
CREATE TABLE IF NOT EXISTS company_billing_months (
  billing_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  month TEXT NOT NULL,                   -- YYYY-MM
  plan TEXT,
  user_count INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued',
  issued_at TEXT,
  paid_at TEXT,
  note TEXT,
  recorded_at TEXT DEFAULT (datetime('now', '+9 hours')),
  recorded_by INTEGER,
  updated_at TEXT,
  UNIQUE(company_id, month)
);
CREATE INDEX IF NOT EXISTS idx_company_billing_months_month ON company_billing_months(month);

-- #542 本部の操作の履歴。だれが・いつ・何を（変更前と変更後）・なぜ（停止・再開の理由）。
--   action は操作の名前（company.update など）。詳しく記録しない本部の書き込みは、メソッドとパスを action に残す
CREATE TABLE IF NOT EXISTS hq_audit_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  company_id INTEGER,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_hq_audit_logs_company ON hq_audit_logs(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hq_audit_logs_created ON hq_audit_logs(created_at);

-- 週次アクティブの集計で、直近の報告を日時で引く
CREATE INDEX IF NOT EXISTS idx_attendance_reported_at ON attendance_reports(reported_at);
