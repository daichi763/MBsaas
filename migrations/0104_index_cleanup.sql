-- 重複した索引の削除と、足りない索引の追加（Sprint 24。#9968。w24-perf。総点検の db-08・db-09）
-- 索引の削除・追加だけ（表・列・値は変えない）。今のコードと新しいコードのどちらでも動く（INDEXED BY で名前を指す文はない）。
-- 一意の制約は、表の定義の UNIQUE（sqlite_autoindex_*。DROP INDEX では消せない）が残るので、消すのは同じ列の別の索引だけ。

-- 1. 同じ列の一意索引が2つ。表の定義の UNIQUE(shift_id, report_type)（0001）が残るので、0036 で足した方を消す
--    （ON CONFLICT(shift_id, report_type) と二重の報告の防止は、残る方の制約で今までどおり働く）
DROP INDEX IF EXISTS uq_attendance_shift_type;

-- 2. 表の定義の UNIQUE と同じ列の索引（UNIQUE の方で引ける）
DROP INDEX IF EXISTS idx_notice_read_reports_company_fy;          -- UNIQUE(company_id, fiscal_year)

-- 3. 先頭の列が同じで、ほかの索引（UNIQUE か、列の多い索引）で引ける索引。書き込みのたびに更新されるだけなので消す
DROP INDEX IF EXISTS idx_attendance_shift;                        -- UNIQUE(shift_id, report_type) の先頭
DROP INDEX IF EXISTS idx_notice_read_staff_reports_company_fy;    -- UNIQUE(company_id, fiscal_year, staff_id) の先頭
DROP INDEX IF EXISTS idx_shifts_company_date;                     -- idx_shifts_company_date_settle(company_id, work_date, settle_status) の先頭
DROP INDEX IF EXISTS idx_shifts_project;                          -- idx_shifts_project_date(project_id, work_date) の先頭
DROP INDEX IF EXISTS idx_daily_reports_staff;                     -- idx_daily_reports_staff_date(staff_id, work_date) の先頭
DROP INDEX IF EXISTS idx_notices_company;                         -- idx_notices_company_published(company_id, published_at) の先頭
DROP INDEX IF EXISTS idx_users_company;                           -- UNIQUE(company_id, user_code) の先頭
DROP INDEX IF EXISTS idx_staff_profiles_company;                  -- idx_staff_profiles_company_type(company_id, affiliation_type) の先頭
DROP INDEX IF EXISTS idx_employee_records_company;                -- UNIQUE(company_id, employee_number) の先頭
DROP INDEX IF EXISTS idx_staff_affiliations_company;              -- UNIQUE(company_id, affiliation_name) の先頭
DROP INDEX IF EXISTS idx_staff_documents_company;                 -- idx_staff_documents_valid_until(company_id, valid_until) の先頭
DROP INDEX IF EXISTS idx_employee_documents_company;              -- idx_employee_documents_valid_until(company_id, valid_until) の先頭
DROP INDEX IF EXISTS idx_client_documents_company;                -- idx_client_documents_valid_until(company_id, valid_until) の先頭

-- 4. 足りない索引
-- クライアントの一覧は、クライアントごとに projects を client_id で引く（会社で絞らない文もあるので client_id を先頭にする）
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id, company_id);
-- 応募の一覧・承認のたびに、承認の途中で止まった明細（status = 'processing'）を探す（settleRemovedSlotItems）。
-- 明細の表には company_id がなく、status が先頭の索引もないため全社の行を読んでいた。processing の行だけの部分索引にする
CREATE INDEX IF NOT EXISTS idx_recruit_items_processing ON recruit_application_items(decided_at) WHERE status = 'processing';
