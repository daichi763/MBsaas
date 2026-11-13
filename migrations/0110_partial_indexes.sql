-- 書き込みの行数を減らす 第1段（Sprint 26 #9976。作業単位 w26-writes。11/12 の調査）
-- 索引の入れ替えと削除だけ（表・列・値は変えない）。今のコードと新しいコードのどちらでも動くので、デプロイの前に当ててよい
-- （INDEXED BY で名前を指す文はない。問い合わせの計画が悪くならないことは scripts/test-w26-writes.mjs の EXPLAIN QUERY PLAN で確かめる）。
--
-- D1 は行の書き込みのたびに、その表のすべての索引の行も書き込みとして数える。値がほとんど NULL の列の索引は、
-- 打刻・シフトの登録のたびに NULL の行を書くだけで、引くときは「列 = 値」「列 IN (…)」「結合の列 = 列」でしか使わない。
-- そこで NULL の行を持たない部分索引（WHERE 列 IS NOT NULL）に置き換える。「列 = 値」などの条件は列が NULL でないことを含むので、
-- SQLite は今までと同じ問い合わせでこの部分索引を使う（同じ名前のままだと定義を変えられないので、新しい名前で作ってから古い方を消す）。

-- 1. 打刻の写真のキー（写真のない打刻の方が多い）。写真の参照の確かめ（retention.ts の孤立した写真の削除）は photo_key = 値 で引く
CREATE INDEX IF NOT EXISTS idx_attendance_photo_key_nn ON attendance_reports(photo_key) WHERE photo_key IS NOT NULL;
DROP INDEX IF EXISTS idx_attendance_photo_key;

-- 2. シフトの募集枠・枠の役割・開催場所（枠や開催場所を使わないシフトでは NULL）
CREATE INDEX IF NOT EXISTS idx_shifts_slot_nn ON shifts(slot_id) WHERE slot_id IS NOT NULL;
DROP INDEX IF EXISTS idx_shifts_slot;
CREATE INDEX IF NOT EXISTS idx_shifts_slot_role_nn ON shifts(slot_role_id) WHERE slot_role_id IS NOT NULL;
DROP INDEX IF EXISTS idx_shifts_slot_role;
CREATE INDEX IF NOT EXISTS idx_shifts_site_nn ON shifts(site_id) WHERE site_id IS NOT NULL;
DROP INDEX IF EXISTS idx_shifts_site;

-- 3. セッションの期限の索引を消す。期限で引くのは1日1回の期限切れの削除（auth.ts の purgeExpiredAuthRows）だけで、全件読みでよい。
--    ログインのたびの同じ利用者の期限切れの削除は idx_sessions_user（user_id）で引く。延長（期限の更新）のたびにこの索引も書いていた
DROP INDEX IF EXISTS idx_sessions_expires;
