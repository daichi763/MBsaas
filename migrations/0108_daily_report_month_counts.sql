-- 日報一覧の件数を、月数に比例しない読み取りで数える（性能の直し。#9970。w25-perf）
-- 表の追加だけ（既存の表・列・値は変えない）。今のコードはこの表を使わないので、デプロイの前に当てても動きは変わらない。
--
-- daily_report_month_counts: 会社・稼働月・案件ごとの日報の件数の控え（src/lib/report-counts.ts）。
--   GET /api/admin/daily-reports の件数（全件・未確認・インシデント・未対応・絞り込み後の件数）を、今月より前の月はこの控えから足し、
--   今月以降と月の途中から始まる期間の端だけを日報の表から数える（過去の日報を毎回すべて読まない）。
--   ym: 稼働月（'YYYY-MM'）。project_id = 0 の行は「その月を数えた」印（件数は 0）で、computed_at は数えた日時（日本時間）。
--   印の無い月・古くなった月（前月は1日、それより前は7日）は、開いたときに数え直す（印・件数の行を消して入れ直す）。
--   日報の追加・出し直し・確認・対応状況の変更・定期削除では、その月の印を消す（次に開いたときに数え直す）。
--   unchecked_flagged / unchecked_open: 「未確認のみ」と「インシデント・クレームのみ」「未対応のみ」を同時に選んだときの件数。
--   日報から作り直せる控えなので、解約企業の削除（OFFBOARDING_TABLES）では消すだけ（書き出さない）。スタッフの列は持たない
CREATE TABLE IF NOT EXISTS daily_report_month_counts (
  company_id INTEGER NOT NULL,
  ym TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  unchecked INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  incident_open INTEGER NOT NULL DEFAULT 0,
  unchecked_flagged INTEGER NOT NULL DEFAULT 0,
  unchecked_open INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (company_id, ym, project_id)
);
