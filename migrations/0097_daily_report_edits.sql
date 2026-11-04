-- 日報の実績を管理者が直す（利用者の決定 Sprint 15。#9707。w15-report-edit）
-- 列と表の追加のみ（既存の表・列・値は変えない）。
--
-- 1. daily_reports.admin_edited_at / admin_edited_by: 管理者が日報の値（report_values）を最後に直した日時と、直した管理者（users.user_id）。
--      日報の一覧・スタッフの過去の日報に「管理者が修正」の印を出すのに使う。
--      スタッフが値を変えて出し直したら（アプリ・報告用URL・代理入力の上書き）、再提出の値を正にして NULL に戻す
--      （同じ値のまま出し直したときは印を残す。src/lib/daily-report.ts の saveDailyReport）。
-- 2. daily_report_edits: 日報の値の修正の履歴。1回の修正・出し直しで1行。
--   kind: 'admin_edit'（管理者が直した）/ 'resubmit'（管理者が直した日報を、スタッフが値を変えて出し直した）
--   entry_method: resubmit のときの出し直しの経路（app / link / proxy）。admin_edit は NULL
--   before_values / after_values: 直す前・後の report_values（JSON の文字列）
--   changed_keys: 値の変わった項目のキー（JSON の配列）
--   reason: 管理者が書いた修正の理由（任意。500文字まで）
--   edited_by: 直した管理者（admin_edit）・代理で入力した管理者（resubmit で entry_method = 'proxy'）。スタッフの出し直しは NULL
--   edited_at: 日本時間（YYYY-MM-DD HH:MM:SS）
--   日報（daily_reports）の行と同じく扱う: 日報の3年の定期削除で、その日報の履歴も消す（src/services/retention.ts の cleanupDailyReports）。
--   company_id を持つので、解約企業の削除・書き出し（OFFBOARDING_TABLES）の対象にする。
--   日報の行を消すほかの処理と食い違わないよう、外部キーは付けない（日報の行が無い履歴は画面に出ない）
ALTER TABLE daily_reports ADD COLUMN admin_edited_at TEXT;
ALTER TABLE daily_reports ADD COLUMN admin_edited_by INTEGER;

CREATE TABLE IF NOT EXISTS daily_report_edits (
  edit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  daily_report_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'admin_edit',
  entry_method TEXT,
  before_values TEXT,
  after_values TEXT,
  changed_keys TEXT,
  reason TEXT,
  edited_by INTEGER,
  edited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_report_edits_report ON daily_report_edits(daily_report_id, edit_id);
CREATE INDEX IF NOT EXISTS idx_daily_report_edits_company ON daily_report_edits(company_id);
