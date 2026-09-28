-- 統合ログイン（フェーズH）
--
-- 他社連携（linked_external）で稼働先に作られたユーザー行は、これまで role='roster_only'（ログイン不可）だった。
-- 所属元でログインアカウントを持つスタッフ（role='staff'）については、稼働先の行も role='staff' にし、
-- 「所属元のアカウントでログイン → 企業切替」で稼働先の画面（お知らせ・相談等）を利用できるようにする。
-- ・稼働先の行のパスワードは引き続き照合不能なハッシュのままなので、稼働先の会社コードで直接ログインはできない（ログインは1つ）。
-- ・稼働先の行は稼働先のスタッフとして扱われる（お知らせ対象・スタッフ数集計に含まれる）。
-- ・メールアドレスは稼働先の行にコピーしていないため、稼働先からのお知らせメールは送信されない。
UPDATE users SET role = 'staff'
WHERE role = 'roster_only' AND user_id IN (
  SELECT sp.user_id FROM staff_profiles sp
  JOIN staff_profiles src ON src.staff_id = sp.source_staff_id
  JOIN users su ON su.user_id = src.user_id
  WHERE sp.affiliation_type = 'linked_external' AND su.role = 'staff'
);
