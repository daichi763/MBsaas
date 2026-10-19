-- お知らせの配信対象の展開・再通知（w3-notice-ux: #191 #370）
--
-- #370 notice_targets: 案件あて・個人あてのお知らせの配信先（notices.target_ids のカンマ区切り）を1行ずつに展開した表。
--   対象者の判定（一覧・ホーム・既読数・メールの宛先・既読率レポート）は、これまでの
--   「',' || target_ids || ',' LIKE '%,' || id || ',%'」の走査をやめ、この表を索引で引く。
--   target_ids は表示と二重配信の判定のために残し、notices の追加・変更・削除のたびにトリガーで展開し直す
--   （お知らせを書き込むどの経路でも、表とずれないように）。
--   トリガーでは WITH 句が使えないため、'[' || target_ids || ']' を JSON の配列として展開する
--   （API は target_ids を「1,2,3」の形にそろえて保存する。形が崩れた値は展開しない）。
CREATE TABLE IF NOT EXISTS notice_targets (
  notice_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,       -- project / staff
  target_id INTEGER NOT NULL,      -- project_id / staff_id
  PRIMARY KEY (notice_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_notice_targets_target ON notice_targets(target_type, target_id, notice_id);

-- 既存のお知らせの展開（空白や空の要素があっても取り出せるよう、文字列を1つずつ区切る）
INSERT OR IGNORE INTO notice_targets (notice_id, target_type, target_id)
WITH RECURSIVE parts(notice_id, target_type, rest, item) AS (
  SELECT notice_id, target_type, REPLACE(COALESCE(target_ids, ''), ' ', '') || ',', NULL
  FROM notices WHERE target_type IN ('project', 'staff')
  UNION ALL
  SELECT notice_id, target_type, substr(rest, instr(rest, ',') + 1), substr(rest, 1, instr(rest, ',') - 1)
  FROM parts WHERE rest != ''
)
SELECT notice_id, target_type, CAST(item AS INTEGER) FROM parts
WHERE item IS NOT NULL AND item != '' AND item NOT GLOB '*[^0-9]*';

CREATE TRIGGER IF NOT EXISTS trg_notice_targets_insert AFTER INSERT ON notices
WHEN NEW.target_type IN ('project', 'staff')
BEGIN
  INSERT OR IGNORE INTO notice_targets (notice_id, target_type, target_id)
  SELECT NEW.notice_id, NEW.target_type, CAST(value AS INTEGER)
  FROM json_each(CASE WHEN json_valid('[' || REPLACE(COALESCE(NEW.target_ids, ''), ' ', '') || ']')
    THEN '[' || REPLACE(COALESCE(NEW.target_ids, ''), ' ', '') || ']' ELSE '[]' END)
  WHERE type = 'integer';
END;

CREATE TRIGGER IF NOT EXISTS trg_notice_targets_update AFTER UPDATE OF target_type, target_ids ON notices
BEGIN
  DELETE FROM notice_targets WHERE notice_id = NEW.notice_id;
  INSERT OR IGNORE INTO notice_targets (notice_id, target_type, target_id)
  SELECT NEW.notice_id, NEW.target_type, CAST(value AS INTEGER)
  FROM json_each(CASE WHEN NEW.target_type IN ('project', 'staff') AND json_valid('[' || REPLACE(COALESCE(NEW.target_ids, ''), ' ', '') || ']')
    THEN '[' || REPLACE(COALESCE(NEW.target_ids, ''), ' ', '') || ']' ELSE '[]' END)
  WHERE type = 'integer';
END;

CREATE TRIGGER IF NOT EXISTS trg_notice_targets_delete AFTER DELETE ON notices
BEGIN
  DELETE FROM notice_targets WHERE notice_id = OLD.notice_id;
END;

-- 案件あての対象者の判定（本人の、その案件の最近のシフト）に使う
CREATE INDEX IF NOT EXISTS idx_shifts_staff_project ON shifts(staff_id, project_id, work_date);

-- #191 未読者への再通知（アプリ内通知とメール）の記録。続けて何度も送らないように、最後に送った日時を残す
ALTER TABLE notices ADD COLUMN reminded_at DATETIME;
ALTER TABLE notices ADD COLUMN remind_count INTEGER NOT NULL DEFAULT 0;
