-- スタッフマスタの多段連携（2次・3次・4次受け）
-- source_staff_id : 直接連携した1つ前の企業のスタッフ行（表示する所属元・支払先・企業間チャットの相手はこの行の企業）
-- root_staff_id   : 雇用元（自社雇用として登録した企業）のスタッフ行。氏名・スキル・経歴などの基本項目はここから解決する
--                   ※ 経路（雇用元・途中の企業）はデータとして保持するが、画面・APIでは直接の連携相手より先を出さない
-- relink_code     : 連携で受け入れたスタッフを、さらに次の企業へ連携するための自社専用コード（自社雇用は persons.global_staff_code を使う）
ALTER TABLE staff_profiles ADD COLUMN root_staff_id INTEGER;
ALTER TABLE staff_profiles ADD COLUMN relink_code TEXT;
UPDATE staff_profiles SET root_staff_id = source_staff_id WHERE affiliation_type = 'linked_external' AND source_staff_id IS NOT NULL AND root_staff_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_profiles_relink_code ON staff_profiles(relink_code) WHERE relink_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_profiles_root ON staff_profiles(root_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_source ON staff_profiles(source_staff_id);
