-- スタッフアプリの募集・応募の使い勝手と性能（w4-recruit-staffapp: #270 #410）
-- 列・インデックスの追加のみ（既存の行の状態は変えない）
--
-- 1. スタッフアプリからの応募の二重登録の防止（#270）
--    応募した枠（recruit_application_items）に、応募したスタッフ（スタッフアプリからの応募のみ）を持たせ、
--    同じスタッフ・同じ枠の未対応・処理中の明細を1件だけにする部分一意インデックスを付ける。
--    承認済み・見送り・取り下げの明細は対象外（シフトが外れた枠への応募し直しは今までどおりできる。#64）。
--    すでに重複している未対応・処理中の明細があるとインデックスを作れないため、重複のうち最も古い1件にだけ staff_id を入れ、
--    残りは NULL のまま（インデックスの対象外）にする。明細の削除・状態の変更はしない（管理画面で見送りにできるように残す）
ALTER TABLE recruit_application_items ADD COLUMN staff_id INTEGER;
UPDATE recruit_application_items
  SET staff_id = (SELECT a.staff_id FROM recruit_applications a WHERE a.application_id = recruit_application_items.application_id AND a.source = 'staff')
  WHERE status IN ('pending', 'processing')
    AND EXISTS (SELECT 1 FROM recruit_applications a WHERE a.application_id = recruit_application_items.application_id AND a.source = 'staff' AND a.staff_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM recruit_application_items o JOIN recruit_applications oa ON oa.application_id = o.application_id
      WHERE o.slot_role_id = recruit_application_items.slot_role_id AND o.item_id < recruit_application_items.item_id
        AND o.status IN ('pending', 'processing') AND oa.source = 'staff'
        AND oa.staff_id = (SELECT a.staff_id FROM recruit_applications a WHERE a.application_id = recruit_application_items.application_id));
CREATE UNIQUE INDEX IF NOT EXISTS uq_recruit_items_staff_role ON recruit_application_items(staff_id, slot_role_id)
  WHERE staff_id IS NOT NULL AND status IN ('pending', 'processing');

-- 2. 募集ページ一覧の集計・公開ページの送信回数の確認・スタッフの応募の取得（#410）
CREATE INDEX IF NOT EXISTS idx_recruit_apps_page ON recruit_applications(page_id, phone, created_at);
CREATE INDEX IF NOT EXISTS idx_recruit_apps_staff ON recruit_applications(company_id, staff_id);
-- 募集ページの対象の枠を、案件と期間でまとめて取る
CREATE INDEX IF NOT EXISTS idx_shift_slots_project_date ON shift_slots(project_id, work_date);
