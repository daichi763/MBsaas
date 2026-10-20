-- 会社の緊急連絡先と、入店位置と現場の距離（作業単位 w5-site-contact: #173 #277）
--
-- 1. 会社の緊急連絡先（#173）。スタッフアプリの「その他」と報告用URLに、タップで発信できる電話番号として出す。
--    emergency_phone は電話番号（20文字まで）、emergency_note は受付時間などの補足（100文字まで）。未登録は NULL
ALTER TABLE companies ADD COLUMN emergency_phone TEXT;
ALTER TABLE companies ADD COLUMN emergency_note TEXT;

-- 2. 入店の位置と現場の距離（#277）。アプリの入店報告で、シフトの開催場所（なければ案件）の位置との距離（m、整数）を残す。
--    位置が取れなかった・現場の位置が未登録の報告は NULL。離れているかの基準（m）は会社設定（settings_json の check_in_far_meters）で、
--    管理画面では表示のときに基準と比べる（status は遅刻の判定に使うため変えない）
ALTER TABLE attendance_reports ADD COLUMN distance_m INTEGER;
