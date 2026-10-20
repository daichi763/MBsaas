-- 保存期間の残りと削除の保留（作業単位 w5-retention-c: #350 #417 #420 #425 #511 #543）
--
-- 1. 削除の保留（#543）
--    係争中・調査中のスタッフ（または解約手続き中などの企業）のデータを、定期削除の対象から外す。
--    保留中の人・企業は、退職後7年の削除・在職中の保存期間（位置情報と写真・相談・フォロー記録・雇用終了の従業員データ・
--    提案の匿名化）・日報の3年のどれでも削除しない。解除すると、退職後7年の削除は猶予（retention_flagged_at）からやり直す。
--    retention_hold_at は設定した日時（日本時間 YYYY-MM-DD HH:MM:SS）、retention_hold_by は設定した本部ユーザー。
ALTER TABLE staff_profiles ADD COLUMN retention_hold_at TEXT;
ALTER TABLE staff_profiles ADD COLUMN retention_hold_reason TEXT;
ALTER TABLE staff_profiles ADD COLUMN retention_hold_by INTEGER;
CREATE INDEX IF NOT EXISTS idx_staff_profiles_retention_hold ON staff_profiles(retention_hold_at) WHERE retention_hold_at IS NOT NULL;
ALTER TABLE companies ADD COLUMN retention_hold_at TEXT;
ALTER TABLE companies ADD COLUMN retention_hold_reason TEXT;
ALTER TABLE companies ADD COLUMN retention_hold_by INTEGER;

-- 2. 保存期間の設定（#420 #511 #350）。本部画面で変えられる。行がなければ src/services/retention.ts の既定値を使う
--    key: location_photo_days（入店の位置情報・端末情報と写真。報告から N 日）
--         consultation_years（対応済みの相談。相談の日から N 年）
--         follow_log_years（完了したフォロー記録。完了日（なければ作成日）から N 年）
--         proposal_days（決着した人材提案（見送り・取り下げ）のスナップショット。決着から N 日）
CREATE TABLE IF NOT EXISTS retention_settings (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);

-- 3. 入店の位置情報と写真を消す対象を探すための部分索引（#420）。消した行は索引から外れる。
--    retention.ts の LOCATION_PHOTO_SQL と同じ式にする（同じ式でないと索引が使われない）
CREATE INDEX IF NOT EXISTS idx_attendance_location_photo ON attendance_reports(reported_at)
  WHERE latitude IS NOT NULL OR longitude IS NOT NULL OR address IS NOT NULL OR device_info IS NOT NULL OR device_id IS NOT NULL OR photo_key IS NOT NULL;

-- 4. 人材提案のスナップショット（氏名・経歴など）を匿名化した日時（#350）。済んだ提案を選び直さない
ALTER TABLE board_proposals ADD COLUMN anonymized_at TEXT;
CREATE INDEX IF NOT EXISTS idx_board_proposals_settled ON board_proposals(status, decided_at) WHERE anonymized_at IS NULL;

-- 5. 雇用終了から7年の従業員データの削除（#425）で、雇用終了日で対象を探す
CREATE INDEX IF NOT EXISTS idx_employee_records_ended ON employee_records(employment_ended_at) WHERE employment_ended_at IS NOT NULL;

-- 6. 退職後7年の削除で、スタッフに紐づく応募を探す（#350。既存の idx_recruit_apps_staff は company_id が先頭のため使えない）
CREATE INDEX IF NOT EXISTS idx_recruit_apps_staff_retention ON recruit_applications(staff_id) WHERE staff_id IS NOT NULL;
