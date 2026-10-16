-- スタッフ統合・本登録と、応募時の未確認メールの扱い（w2-merge-identity: #38 #109 #148）
--
-- 1. 未確認のメールアドレス（staff_profiles.unverified_email）
--    公開の募集フォームで応募者が入力したメールは、本人のものか確かめていない。
--    これを users.email（ログイン・パスワード再設定・お知らせメールの宛先）に入れず、この列に持つ。
--    本登録・ログインの発行・区分と登録状態の欄で、管理者が本人に確認できたときだけ users.email へ移す。
--    統合でも統合先の users.email には自動でコピーしない（統合先の未確認のメールとして残す）。
ALTER TABLE staff_profiles ADD COLUMN unverified_email TEXT;

-- 既存データ: 募集から仮登録し、まだログインのない（本登録前の）スタッフの users.email は応募フォームの値なので、未確認の列へ移す。
-- 応募の記録（recruit_applications.email）と一致するものだけを対象にし、値は消さずに列を移すだけにする
UPDATE staff_profiles SET unverified_email = (SELECT TRIM(u.email) FROM users u WHERE u.user_id = staff_profiles.user_id)
WHERE is_provisional = 1 AND merged_into_staff_id IS NULL AND unverified_email IS NULL
  AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = staff_profiles.user_id AND u.role = 'roster_only' AND TRIM(COALESCE(u.email, '')) != ''
    AND EXISTS (SELECT 1 FROM recruit_applications a WHERE a.staff_id = staff_profiles.staff_id AND a.source = 'public'
      AND LOWER(TRIM(a.email)) = LOWER(TRIM(u.email))));
UPDATE users SET email = NULL
WHERE role = 'roster_only' AND email IS NOT NULL
  AND EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = users.user_id AND sp.is_provisional = 1 AND sp.merged_into_staff_id IS NULL
    AND sp.unverified_email IS NOT NULL AND LOWER(sp.unverified_email) = LOWER(TRIM(users.email)));

-- 2. 統合で統合元に残った従業員管理のデータ（#109）
--    統合済みのスタッフは従業員管理の在職者の一覧から外す（api.ts の OWN_EMPLOYEE_COND）。
--    統合元に残った従業員データ（統合先にも従業員データがあった場合）は、雇用終了の欄で見られるように、
--    雇用終了日が空なら統合日の前日を入れる
UPDATE employee_records SET employment_ended_at = date(substr((SELECT sp.merged_at FROM staff_profiles sp WHERE sp.staff_id = employee_records.staff_id), 1, 10), '-1 day'),
  ended_reason = COALESCE(ended_reason, '統合（統合先のスタッフに統合）')
WHERE employment_ended_at IS NULL
  AND EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.staff_id = employee_records.staff_id AND sp.merged_into_staff_id IS NOT NULL AND sp.merged_at IS NOT NULL);

--    自社雇用以外のスタッフへ統合して移った従業員データは、雇用終了日が空だとどの画面からも開けないため、統合日の前日で雇用終了にする
UPDATE employee_records SET employment_ended_at = (
    SELECT date(substr(MAX(m.created_at), 1, 10), '-1 day') FROM staff_merges m WHERE m.target_staff_id = employee_records.staff_id),
  ended_reason = COALESCE(ended_reason, '統合（自社雇用以外のスタッフへ統合）')
WHERE employment_ended_at IS NULL
  AND EXISTS (SELECT 1 FROM staff_merges m WHERE m.target_staff_id = employee_records.staff_id)
  AND EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.staff_id = employee_records.staff_id
    AND COALESCE(sp.affiliation_type, 'own_employee') NOT IN ('own_employee', 'skillsheet_only'));
