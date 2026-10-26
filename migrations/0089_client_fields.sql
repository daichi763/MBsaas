-- クライアント画面の項目の見直し（Sprint 9。w9-client-board）
-- 列の追加と、担当者の値の写しのみ（既存の列・値は消さない。新しい表はないので、退職後の削除・解約企業の書き出しと削除の対象の表は増えない）。

-- 1. 種別（#9102）。corporation = 法人 / sole_proprietor = 個人事業主 / other = その他。NULL は未設定。
--    これまでの契約形態（contract_type）は DB に残すが、画面には出さない
ALTER TABLE clients ADD COLUMN client_kind TEXT;

-- 2. 支店・部門（#9103）。それぞれ1つの自由入力の文字列
ALTER TABLE clients ADD COLUMN branch_name TEXT;
ALTER TABLE clients ADD COLUMN department_name TEXT;

-- 3. 会社基本情報の「担当者」（clients.contact_name）は「代表者氏名」（representative_name）に置き換える（#9101）。
--    今の担当者の値は、顧客担当者の一覧（client_contacts）に1件として写す。同じ名前の担当者がすでにあれば写さない。
--    clients.contact_name の値はそのまま残す（画面には出さない）。日時は日本時間の 'YYYY-MM-DD HH:MM:SS'
INSERT INTO client_contacts (company_id, client_id, contact_name, created_at, updated_at)
SELECT cl.company_id, cl.client_id, TRIM(cl.contact_name), datetime('now', '+9 hours'), datetime('now', '+9 hours')
FROM clients cl
WHERE TRIM(COALESCE(cl.contact_name, '')) <> ''
  AND NOT EXISTS (SELECT 1 FROM client_contacts cc
    WHERE cc.client_id = cl.client_id AND cc.company_id = cl.company_id AND TRIM(cc.contact_name) = TRIM(cl.contact_name));
