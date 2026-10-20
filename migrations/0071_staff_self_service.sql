-- スタッフ本人の手続き（作業単位 w5-staff-self-service: #272 #288 #289 #297）
-- 日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。既存の行・列は変えない（列とテーブルの追加のみ）。

-- 1. 登録情報の変更申請（#272）
--    スタッフ本人が最寄駅・稼働エリア・稼働開始可能日・スキル・通勤可能時間・ログイン用メールの変更を申請し、管理者が承認したときだけ反映する。
--    company_id・staff_id は申請先（承認して反映する会社と、その会社のスタッフマスタの行）。
--    他社から連携された行（linked_external）で申請したときは、基本項目を持つ所属元（雇用元）の行と会社が申請先になる。
--    requester_user_id は申請したログインのユーザー（企業を切り替えていれば連携先のユーザー行）、person_id は本人の一覧の取得に使う。
--    changes_json は {項目: 新しい値}、before_json は申請した時点の値（承認画面で今の値と比べる）。
--    status: pending（承認待ち）/ approved / rejected / cancelled（本人が取り消した）
CREATE TABLE IF NOT EXISTS profile_change_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  requester_user_id INTEGER NOT NULL,
  requester_company_id INTEGER NOT NULL,
  person_id TEXT,
  changes_json TEXT NOT NULL,
  before_json TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER,
  reviewed_by_name TEXT,
  review_comment TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_company ON profile_change_requests(company_id, status, request_id);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_staff ON profile_change_requests(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_person ON profile_change_requests(person_id);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_requester ON profile_change_requests(requester_user_id);

-- 2. 書類の種類と有効期限（#297）。3つの書類の表に足す（既存の行は NULL＝未設定）
--    doc_type: resume（履歴書）/ qualification（資格証）/ id_card（身分証）/ residence_card（在留カード）/ bank（口座の確認書類）/
--              onboarding（入社書類）/ contract_basic（基本契約書）/ contract_individual（個別契約書）/ other（その他）
--    valid_until: 有効期限・契約終了日（'YYYY-MM-DD'）
ALTER TABLE staff_documents ADD COLUMN doc_type TEXT;
ALTER TABLE staff_documents ADD COLUMN valid_until TEXT;
ALTER TABLE employee_documents ADD COLUMN doc_type TEXT;
ALTER TABLE employee_documents ADD COLUMN valid_until TEXT;
ALTER TABLE client_documents ADD COLUMN doc_type TEXT;
ALTER TABLE client_documents ADD COLUMN valid_until TEXT;
CREATE INDEX IF NOT EXISTS idx_staff_documents_valid_until ON staff_documents(company_id, valid_until);
CREATE INDEX IF NOT EXISTS idx_employee_documents_valid_until ON employee_documents(company_id, valid_until);
CREATE INDEX IF NOT EXISTS idx_client_documents_valid_until ON client_documents(company_id, valid_until);

-- 3. スタッフ本人が提出した書類（#288）。保存先は既存の staff_documents（R2 の DOCUMENTS）
--    submitted_by_staff = 1 は本人がスマホから提出した書類。uploaded_by には本人の user_id が入る。
--    confirmed_at・confirmed_by は管理者が中身を確かめた日時と人（未確認の間だけ本人が削除できる）
ALTER TABLE staff_documents ADD COLUMN submitted_by_staff INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_documents ADD COLUMN confirmed_at TEXT;
ALTER TABLE staff_documents ADD COLUMN confirmed_by INTEGER;
CREATE INDEX IF NOT EXISTS idx_staff_documents_unconfirmed ON staff_documents(company_id, submitted_by_staff, confirmed_at);

-- 4. 休暇の申請（#289）。自社雇用の社員（従業員管理の対象）だけが出せる
--    leave_type: paid（有給。承認で employee_records.paid_leave_remaining を減らす）/ other（その他の休暇。残数は変えない）
--    leave_unit: full（全日）/ am（午前半休）/ pm（午後半休）。days は 1 または 0.5
--    deducted_days は承認のときに実際に有給残数から引いた日数（承認の取り消しで戻す）
--    status: pending / approved / rejected / cancelled（本人が承認前に取り消した、または管理者が承認を取り消した）
CREATE TABLE IF NOT EXISTS leave_requests (
  leave_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  requester_user_id INTEGER NOT NULL,
  leave_date TEXT NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'paid',
  leave_unit TEXT NOT NULL DEFAULT 'full',
  days REAL NOT NULL DEFAULT 1,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  deducted_days REAL NOT NULL DEFAULT 0,
  reviewed_by INTEGER,
  reviewed_by_name TEXT,
  review_comment TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_company ON leave_requests(company_id, status, leave_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_staff ON leave_requests(staff_id, leave_date);
