-- 案件ごとの入店/退店報告 写真添付オーバーライド
-- NULL = 会社全体の設定(companies.settings_json.photo_required_attendance)に従う
-- 1 = この案件は写真添付を必須にする / 0 = この案件は不要にする
ALTER TABLE projects ADD COLUMN photo_required_override INTEGER;
