-- ログイン・アカウントの情報（作業単位 w3-account-profile: #207 #396）
--
-- 1. ログイン用メールアドレスの確認（#207）
--    管理者がスタッフのログイン用メール（users.email: パスワード再設定・通知の宛先）を追加・変更するときは、
--    すぐには users.email を書き換えず、この表に確認待ちとして保存し、新しいアドレスに確認用のリンクを送る。
--    本人がリンクを開いて確認したときだけ users.email に移す（入力の誤りや他人のアドレスに通知が届くのを防ぐ）。
--    token_hash はリンクのトークンの SHA-256。expires_at は ISO 8601（UTC）。確認・取消の済んだ行と古い行は、新しい依頼のときに消す。
CREATE TABLE IF NOT EXISTS login_email_verifications (
  verification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  requested_by INTEGER,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  canceled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_email_verifications_token ON login_email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_login_email_verifications_user ON login_email_verifications(user_id, created_at);

-- 2. 会社・本人で絞り込む列のインデックス（#396）
--    users の email は 0030 の式インデックス（LOWER(TRIM(email))）をパスワード再設定の受付で使うため、ここでは足さない。
--    相談対応一覧・ダッシュボードの未対応相談（company_id と status で絞り、新しい順）
CREATE INDEX IF NOT EXISTS idx_consultations_company_status ON consultations(company_id, status, created_at);
--    フォロー履歴一覧（company_id で絞り、新しい順）
CREATE INDEX IF NOT EXISTS idx_follow_logs_company ON follow_logs(company_id, created_at);
--    連携状況（連携先ごとに staff_id で同意を探す）
CREATE INDEX IF NOT EXISTS idx_roster_consents_staff ON roster_consents(staff_id);

-- 3. 自社雇用スタッフの電話番号（#123）
--    スタッフマスタの②で登録した電話番号は users.phone にだけ入り、従業員管理の電話番号（employee_records.phone_main）は空のままだった。
--    この版から従業員管理で電話番号を変えると users.phone もそろえるため、空欄の phone_main に users.phone を入れておく（空欄の行だけ。値は消さない）
UPDATE employee_records SET phone_main = (
    SELECT TRIM(u.phone) FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE sp.staff_id = employee_records.staff_id)
WHERE TRIM(COALESCE(phone_main, '')) = ''
  AND EXISTS (SELECT 1 FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
    WHERE sp.staff_id = employee_records.staff_id AND COALESCE(sp.affiliation_type, 'own_employee') = 'own_employee'
      AND sp.merged_into_staff_id IS NULL AND TRIM(COALESCE(u.phone, '')) != '');
