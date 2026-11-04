-- マスタの入力の見直し（利用者の要望 Sprint 15。#9701 #9709 #9710。w15-masters）
-- 列の追加のみ（既存の列・値は変えない。既存の行の新しい列は空のまま）。
-- 新しい表はない。列は今の表（clients・staff_affiliations・staff_profiles）に足すので、解約企業の書き出しと削除（OFFBOARDING_TABLES）は
-- 表ごと扱われる。staff_profiles の年齢の列は、退職後の匿名化（retention.ts の ANONYMIZE_PROFILE_COLUMNS）で空にする。

-- 1. クライアントの郵便番号（#9701）とホームページの URL（#9709。似た名前の会社と区別するため、協力会社とそろえる）。
--    郵便番号は半角の「123-4567」の形で保存する（src/lib/validate.ts の normalizePostalCode）。URL は http/https だけ
ALTER TABLE clients ADD COLUMN postal_code TEXT;
ALTER TABLE clients ADD COLUMN website_url TEXT;

-- 2. 協力会社（staff_affiliations）の項目をクライアントにそろえる（#9709）。
--    これまでの contact_name・phone・email は、先方の担当者の名前・電話・メールとして使い続ける（画面の見出しだけ変える）
--    postal_code / address: 会社の郵便番号・住所
--    company_phone: 会社の代表の電話
--    website_url: ホームページの URL（http/https だけ）
--    representative_name: 代表者氏名
--    invoice_number: インボイス登録番号（T + 13桁。支払先の確かめに使う）
--    internal_contact_name: 自社側の担当者（社内担当者）の名前
--    contact_department: 先方の担当者の部署・役職
ALTER TABLE staff_affiliations ADD COLUMN postal_code TEXT;
ALTER TABLE staff_affiliations ADD COLUMN address TEXT;
ALTER TABLE staff_affiliations ADD COLUMN company_phone TEXT;
ALTER TABLE staff_affiliations ADD COLUMN website_url TEXT;
ALTER TABLE staff_affiliations ADD COLUMN representative_name TEXT;
ALTER TABLE staff_affiliations ADD COLUMN invoice_number TEXT;
ALTER TABLE staff_affiliations ADD COLUMN internal_contact_name TEXT;
ALTER TABLE staff_affiliations ADD COLUMN contact_department TEXT;

-- 3. 生年月日が分からないときの年齢（#9710。利用者の決定: 年齢＋入力した日）。
--    age_entered: 入れた年齢（整数）。age_entered_on: 入力した日（日本時間の 'YYYY-MM-DD'）。
--    今の年齢は、入れた年齢に入力した日からの満年数を足して推定する（src/roster.ts の estimatedAge）。
--    生年月日があればそちらを使い、年齢の列は空にする
ALTER TABLE staff_profiles ADD COLUMN age_entered INTEGER;
ALTER TABLE staff_profiles ADD COLUMN age_entered_on TEXT;
