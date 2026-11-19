-- 案件掲示板: 掲載の都道府県を複数選べるようにする（#9992）
-- prefectures は ',東京都,神奈川県,' のように前後にカンマを付けた形。場所を問わない掲載は ',全国,'
-- prefecture 列は残し、先頭の1つ（全国なら '全国'）を入れる（今それを読んでいる所が壊れないように）
ALTER TABLE board_posts ADD COLUMN prefectures TEXT;
UPDATE board_posts SET prefectures = ',' || prefecture || ',' WHERE prefecture IS NOT NULL AND prefecture <> '' AND prefectures IS NULL;
