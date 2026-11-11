-- クライアント・協力会社のフリガナ（利用者の要望 11/10。#9964。w24-requests）
-- 列の追加のみ（NULL 可。既存の列・値は変えない。新しい表はないので、解約企業の書き出しと削除（OFFBOARDING_TABLES）は表ごと扱われる）。
-- 値は全角カタカナにそろえて保存する（ひらがな・半角カナは変換する。src/lib/validate.ts の normalizeKana）。
-- clients.representative_kana（代表者のフリガナ。0011）はすでにある
--   clients.client_name_kana            : クライアントの会社名のフリガナ
--   client_contacts.contact_name_kana   : クライアントの担当者の氏名のフリガナ
--   staff_affiliations.affiliation_name_kana : 協力会社の会社名のフリガナ
--   staff_affiliations.contact_name_kana     : 協力会社の先方の担当者の氏名のフリガナ
ALTER TABLE clients ADD COLUMN client_name_kana TEXT;
ALTER TABLE client_contacts ADD COLUMN contact_name_kana TEXT;
ALTER TABLE staff_affiliations ADD COLUMN affiliation_name_kana TEXT;
ALTER TABLE staff_affiliations ADD COLUMN contact_name_kana TEXT;
