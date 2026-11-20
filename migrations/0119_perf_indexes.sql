-- 管理画面の重い読み取りを軽くする（Sprint 33 #9996。作業単位 w33-perf。11/20 の1日の流れの試験の、問い合わせごとの読み取りの割合）
-- 索引の追加だけ（表・列・値は変えない。消す索引もない）。今のコードと新しいコードのどちらでも動くので、デプロイの前に当ててよい
-- （INDEXED BY で名前を指す文はない。問い合わせの計画と読み取りの行数は scripts/test-w33-perf.mjs で確かめる）。
-- 戻すとき: DROP INDEX IF EXISTS idx_daily_reports_csv_order; DROP INDEX IF EXISTS idx_attendance_late_at; DROP INDEX IF EXISTS idx_staff_profiles_no_person;

-- 1. 日報の CSV（GET /api/admin/daily-reports-csv）: 会社・稼働日・提出日時の順（同じ提出日時は日報の ID の順。索引の最後に行の ID が入る）。
--    「稼働日・提出日時・日報の ID の新しい順に 2,001 件」を、索引の順に読んで 2,001 件で止める（期間の全件を並べ替えのために読まない）。
--    CSV の文だけが使うよう、部分索引にする（WHERE company_id > 0。会社の ID は 1 以上なので、すべての日報が入る）。
--    CSV の文は同じ条件（dr.company_id > 0）を書くので、この索引を使える。ほかの文（company_id = ? だけ）はこの索引を使わない
--    （普通の索引にすると、統計の無い D1 では、スタッフで引く文・未確認の数などもこの索引を選び、会社のすべての日報を読むことがあった）
CREATE INDEX IF NOT EXISTS idx_daily_reports_csv_order ON daily_reports(company_id, work_date, submitted_at) WHERE company_id > 0;

-- 2. ダッシュボードの「遅刻が月2回以上」: 遅刻の報告だけの、会社と報告の日時の部分索引。今月の初めより後に報告した遅刻だけを読む
--    （会社と種類の索引 idx_attendance_late では、すべての期間の遅刻を読んでいた）。遅刻でない打刻の書き込みでは、この索引は書かない
CREATE INDEX IF NOT EXISTS idx_attendance_late_at ON attendance_reports(company_id, reported_at) WHERE status = 'late';

-- 3. スタッフ一覧を開くたびの「人物の ID（person_id）が無い行の補完」（roster.ts の ensureRosterIdentity）: 補完の済んでいない行だけの部分索引。
--    ふだんは行が無いので、会社のすべてのスタッフの行を読まない
CREATE INDEX IF NOT EXISTS idx_staff_profiles_no_person ON staff_profiles(company_id) WHERE person_id IS NULL;
