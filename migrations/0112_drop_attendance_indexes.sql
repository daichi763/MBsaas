-- 書き込みの行数を減らす 第2段（Sprint 27 #9982。#9976 の続き。作業単位 w27-index）
-- 索引の削除だけ（表・列・値は変えない）。INDEXED BY で名前を指す文はない。
-- D1 は打刻1行の書き込みのたびに、attendance_reports のすべての索引の行も書き込みとして数える。次の2つを消すと、打刻1回の書き込みが2行減る。
--
-- 1. 報告の日時の索引（0078）。本部の週次アクティブは Sprint 26 から部分索引 idx_attendance_location_photo（reported_at）で引く
--    （src/api.ts の locationPhotoSql の条件を付けた文）。日時で打刻を引くほかの文（定期削除の位置情報・写真）も同じ部分索引を使う
-- 2. 企業の索引（0004）。総勤怠報告（本部の企業の詳細）と解約企業の処理は Sprint 26 から shift_id / staff_id 経由で引く
--    （retention.ts の OB_ATTENDANCE）。ダッシュボードの遅刻の集計は部分索引 idx_attendance_late（company_id, report_type）で引く
-- 今のコードの問い合わせの計画が全件読みにならないことは scripts/test-w27-index.mjs の EXPLAIN QUERY PLAN で確かめる。
-- 戻すとき: CREATE INDEX IF NOT EXISTS idx_attendance_reported_at ON attendance_reports(reported_at);
--           CREATE INDEX IF NOT EXISTS idx_attendance_company ON attendance_reports(company_id);
DROP INDEX IF EXISTS idx_attendance_reported_at;
DROP INDEX IF EXISTS idx_attendance_company;
