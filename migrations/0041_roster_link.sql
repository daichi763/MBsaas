-- 企業間連携（QR/ID連携）の検証（w2-roster-link）
--
-- #238 同じ人を同じ企業に二重に連携しない
--   link_key: 連携行（linked_external）の「連携先の企業ID:person_id」。一意インデックスで同時送信による二重登録を防ぐ。
--   既に重複している行があってもインデックスを作れるよう、既存の行は (企業, 人) ごとに最初の1行にだけ付ける
--   （重複している残りの行は消さない。データの整理は運用で行う）
ALTER TABLE staff_profiles ADD COLUMN link_key TEXT;
UPDATE staff_profiles SET link_key = company_id || ':' || person_id
WHERE affiliation_type = 'linked_external' AND person_id IS NOT NULL AND link_key IS NULL
  AND staff_id = (SELECT MIN(x.staff_id) FROM staff_profiles x
    WHERE x.company_id = staff_profiles.company_id AND x.person_id = staff_profiles.person_id AND x.affiliation_type = 'linked_external');
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_profiles_link_key ON staff_profiles(link_key) WHERE link_key IS NOT NULL;

-- #127 連携行に所属元（雇用元の行）の退職日を伝える（定期削除・割当候補の判定に使う）。
--   連携行の退職日が空のものだけを埋める。在籍状況・ログインの停止は、毎日の cron（applyDueRetirements）が退職日の翌日以降に行う
UPDATE users SET retired_at = (
  SELECT ru.retired_at FROM staff_profiles l
  JOIN staff_profiles r ON r.staff_id = COALESCE(l.root_staff_id, l.source_staff_id)
  JOIN users ru ON ru.user_id = r.user_id
  WHERE l.user_id = users.user_id AND l.affiliation_type = 'linked_external')
WHERE retired_at IS NULL AND user_id IN (
  SELECT l.user_id FROM staff_profiles l
  JOIN staff_profiles r ON r.staff_id = COALESCE(l.root_staff_id, l.source_staff_id)
  JOIN users ru ON ru.user_id = r.user_id
  WHERE l.affiliation_type = 'linked_external' AND ru.retired_at IS NOT NULL);

-- #255 連携の同意記録と連携行の作成日時を日本時間にそろえる。
--   これまでは既定値の CURRENT_TIMESTAMP（UTC）で保存していた（アプリのほかの記録は日本時間）。
--   このマイグレーションの適用後に、日本時間で保存する新しいコードを動かすこと（順序が逆だと新しい行も9時間ずれる）
UPDATE roster_consents SET created_at = datetime(created_at, '+9 hours') WHERE created_at IS NOT NULL;
UPDATE staff_profiles SET created_at = datetime(created_at, '+9 hours') WHERE affiliation_type = 'linked_external' AND created_at IS NOT NULL;
