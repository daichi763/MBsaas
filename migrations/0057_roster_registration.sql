-- スタッフの新規登録・本登録・統合の残り（w4-roster-registration: #461 #40）
--
-- #461 統合は1回の db.batch（トランザクション）にまとめた。統合の記録（staff_merges）を batch の最初に入れ、
--   source_lock（統合元の staff_id）の一意インデックスで、同じ統合元を同時に2回統合できないようにする。
--   これまでの記録は source_lock を NULL のままにする（NULL どうしは一意の判定に当たらない）
ALTER TABLE staff_merges ADD COLUMN source_lock INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_merges_source_lock ON staff_merges(source_lock);

-- #40 作成APIで検証していなかった時期に入った、形式に合わない値を直す。
--   通勤可能時間: 数値でない値・0〜1440 の範囲外 → NULL、小数 → 四捨五入
--   生年月日・稼働開始可能日: 区切りが「/」「.」の日付は「-」にそろえ、それでも実在する YYYY-MM-DD でない値 → NULL（空文字も NULL）
--   直す前の値は roster_value_fixes に残す（元に戻したり、本人に確かめたりできるように）
CREATE TABLE IF NOT EXISTS roster_value_fixes (
  fix_id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  field TEXT NOT NULL,          -- commute_minutes / date_of_birth / available_from
  old_value TEXT,
  new_value TEXT,
  migration TEXT NOT NULL DEFAULT '0057',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO roster_value_fixes (staff_id, field, old_value, new_value)
SELECT staff_id, 'commute_minutes', CAST(commute_minutes AS TEXT),
  CASE WHEN typeof(commute_minutes) IN ('integer', 'real') AND commute_minutes >= 0 AND commute_minutes <= 1440 THEN CAST(CAST(ROUND(commute_minutes) AS INTEGER) AS TEXT) ELSE NULL END
FROM staff_profiles
WHERE commute_minutes IS NOT NULL
  AND (typeof(commute_minutes) NOT IN ('integer', 'real') OR commute_minutes < 0 OR commute_minutes > 1440 OR typeof(commute_minutes) = 'real');
UPDATE staff_profiles SET commute_minutes = NULL
WHERE commute_minutes IS NOT NULL AND (typeof(commute_minutes) NOT IN ('integer', 'real') OR commute_minutes < 0 OR commute_minutes > 1440);
UPDATE staff_profiles SET commute_minutes = CAST(ROUND(commute_minutes) AS INTEGER) WHERE typeof(commute_minutes) = 'real';

-- 「2000/01/31」「2000.01.31」の形は「2000-01-31」にそろえる（実在する日付になるときだけ）
INSERT INTO roster_value_fixes (staff_id, field, old_value, new_value)
SELECT staff_id, 'date_of_birth', date_of_birth, replace(replace(date_of_birth, '/', '-'), '.', '-') FROM staff_profiles
WHERE typeof(date_of_birth) = 'text' AND (date_of_birth GLOB '*/*' OR date_of_birth GLOB '*.*') AND date(replace(replace(date_of_birth, '/', '-'), '.', '-')) IS replace(replace(date_of_birth, '/', '-'), '.', '-');
UPDATE staff_profiles SET date_of_birth = replace(replace(date_of_birth, '/', '-'), '.', '-')
WHERE typeof(date_of_birth) = 'text' AND (date_of_birth GLOB '*/*' OR date_of_birth GLOB '*.*') AND date(replace(replace(date_of_birth, '/', '-'), '.', '-')) IS replace(replace(date_of_birth, '/', '-'), '.', '-');
INSERT INTO roster_value_fixes (staff_id, field, old_value, new_value)
SELECT staff_id, 'date_of_birth', CAST(date_of_birth AS TEXT), NULL FROM staff_profiles
WHERE date_of_birth IS NOT NULL AND (typeof(date_of_birth) != 'text' OR date_of_birth NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(date_of_birth) IS NOT date_of_birth);
UPDATE staff_profiles SET date_of_birth = NULL
WHERE date_of_birth IS NOT NULL AND (typeof(date_of_birth) != 'text' OR date_of_birth NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(date_of_birth) IS NOT date_of_birth);

-- 「2000/01/31」「2000.01.31」の形は「2000-01-31」にそろえる（実在する日付になるときだけ）
INSERT INTO roster_value_fixes (staff_id, field, old_value, new_value)
SELECT staff_id, 'available_from', available_from, replace(replace(available_from, '/', '-'), '.', '-') FROM staff_profiles
WHERE typeof(available_from) = 'text' AND (available_from GLOB '*/*' OR available_from GLOB '*.*') AND date(replace(replace(available_from, '/', '-'), '.', '-')) IS replace(replace(available_from, '/', '-'), '.', '-');
UPDATE staff_profiles SET available_from = replace(replace(available_from, '/', '-'), '.', '-')
WHERE typeof(available_from) = 'text' AND (available_from GLOB '*/*' OR available_from GLOB '*.*') AND date(replace(replace(available_from, '/', '-'), '.', '-')) IS replace(replace(available_from, '/', '-'), '.', '-');
INSERT INTO roster_value_fixes (staff_id, field, old_value, new_value)
SELECT staff_id, 'available_from', CAST(available_from AS TEXT), NULL FROM staff_profiles
WHERE available_from IS NOT NULL AND (typeof(available_from) != 'text' OR available_from NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(available_from) IS NOT available_from);
UPDATE staff_profiles SET available_from = NULL
WHERE available_from IS NOT NULL AND (typeof(available_from) != 'text' OR available_from NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(available_from) IS NOT available_from);
