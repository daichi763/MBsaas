-- 日報の月ごとの集計の表（実績分析・スキルシートの通算実績を、過去の日報を毎回すべて読まずに出す。#9972。w26-summary。src/lib/monthly-summary.ts）
-- 表・索引・トリガーの追加だけ（既存の表・列・値は変えない）。今のコードはこの表を使わないので、デプロイの前に当てても動きは変わらない。
--
-- 集計を持つのは「確定した過去の月」= 今月と前月より前の月（前月はまだ遅れた提出・修正が多いので、今月と同じく日報の表から数える）。
-- 集計は開いたときに作る（作り直す）。打刻・日報の提出・修正のたびには書かない（無料プランの書き込みの枠が小さいため）。
--
-- report_summary_months: 会社・月ごとの「集計済み」の印。computed_at は集計した日時（日本時間）。
--   印の無い月・古い月（30日）は、開いたときに同じ batch で集計し直す（下の2つの表の、その月の行を消して入れ直す）。
-- report_month_summaries: 会社・月・案件・スタッフごとの日報の数（reports）・インシデントかクレームの印のある日報の数（flagged）・
--   日報のある日（days_mask。1日 = 1、2日 = 2、3日 = 4 … のビットの和）・数値の項目の合計（values_json。{ キー: 合計 }。数値の値のあるキーだけ）・
--   スキルシートの決め打ちの項目（mnp・pi・shinki・hikari・seiyaku）の合計（legacy_json。これまでの json_extract の式と同じ数え方）。
-- report_day_summaries: 会社・稼働日・案件ごとの日報の数・稼働人数・インシデントかクレームの印のある日報の数。
--   project_id = 0 の行は全案件（同じ日に2つの案件の日報を出した人を1人と数える）。
-- 日報から作り直せる控えなので、解約企業の削除（OFFBOARDING_TABLES）では消すだけ（書き出さない）。保存期間は日報と同じ（3年）。
-- 解約企業の削除は rowid で消すので、WITHOUT ROWID にはしない
CREATE TABLE IF NOT EXISTS report_summary_months (
  company_id INTEGER NOT NULL,
  ym TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (company_id, ym)
);

CREATE TABLE IF NOT EXISTS report_month_summaries (
  company_id INTEGER NOT NULL,
  ym TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  days_mask INTEGER NOT NULL DEFAULT 0,
  values_json TEXT,
  legacy_json TEXT,
  PRIMARY KEY (company_id, ym, project_id, staff_id)
);
-- スキルシートの通算実績（スタッフ1人のすべての月）を、会社のすべての行を読まずに引く
CREATE INDEX IF NOT EXISTS idx_report_month_summaries_staff ON report_month_summaries(staff_id, ym);

CREATE TABLE IF NOT EXISTS report_day_summaries (
  company_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  staff_count INTEGER NOT NULL DEFAULT 0,
  project_count INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, work_date, project_id)
);

-- 日報の行が増える・消える・集計に使う列が変わったら、その月の印を消す（次に開いたときに集計し直す）。
-- 印は確定した過去の月にしか無いので、ふだん（今月・前月の日報）は何も消さない（書き込みの行は増えない。印の主キーを1回引くだけ）。
-- 注意: D1 の meta.changes はトリガーの中の削除も数える。過去の月の日報を消す・直す文の件数は、印を先に消すか RETURNING で数える
CREATE TRIGGER IF NOT EXISTS trg_daily_reports_summary_ins AFTER INSERT ON daily_reports
BEGIN
  DELETE FROM report_summary_months WHERE company_id = NEW.company_id AND ym = substr(NEW.work_date, 1, 7);
END;
CREATE TRIGGER IF NOT EXISTS trg_daily_reports_summary_del AFTER DELETE ON daily_reports
BEGIN
  DELETE FROM report_summary_months WHERE company_id = OLD.company_id AND ym = substr(OLD.work_date, 1, 7);
END;
CREATE TRIGGER IF NOT EXISTS trg_daily_reports_summary_upd
AFTER UPDATE OF company_id, staff_id, project_id, work_date, report_values, incident_flag, complaint_flag ON daily_reports
BEGIN
  DELETE FROM report_summary_months WHERE company_id = OLD.company_id AND ym = substr(OLD.work_date, 1, 7);
  DELETE FROM report_summary_months WHERE company_id = NEW.company_id AND ym = substr(NEW.work_date, 1, 7);
END;
