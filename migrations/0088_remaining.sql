-- 残りの仕上げ（サーバー。w8-server）
-- 列の追加のみ（新しい表はないので、退職後の削除・解約企業の書き出しと削除の対象の表は増えない）。日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。

-- 1. 案件ごとの遅刻の猶予（分。#497）。NULL なら会社の設定（companies.settings_json の late_grace_minutes）に従う。
--    基準はシフトの開始時刻のまま（集合時刻という項目は作らない）。これから記録する報告に効く
ALTER TABLE projects ADD COLUMN late_grace_minutes INTEGER;

-- 2. 書類の有効期限を管理者に知らせた記録（#297）。'有効期限:段階'（段階は soon = 30日以内 / expired = 期限切れ）。
--    同じ期限の同じ段階は二度知らせない（期限を更新すれば、新しい期限で改めて知らせる）
ALTER TABLE staff_documents ADD COLUMN expiry_notified TEXT;
ALTER TABLE client_documents ADD COLUMN expiry_notified TEXT;
ALTER TABLE employee_documents ADD COLUMN expiry_notified TEXT;

-- 3. 交通費の申請の領収書の写真（#273。任意・1枚）。写真は入店の写真と同じ R2（PHOTOS）の pay-receipts/ 以下に置く。
--    申請の行と一緒に消える（退職後7年の削除・解約企業の削除で R2 からも消す。services/retention.ts）
ALTER TABLE staff_pay_requests ADD COLUMN receipt_key TEXT;
ALTER TABLE staff_pay_requests ADD COLUMN receipt_type TEXT;
ALTER TABLE staff_pay_requests ADD COLUMN receipt_size INTEGER;
ALTER TABLE staff_pay_requests ADD COLUMN receipt_uploaded_at TEXT;
