-- 協力会社（staff_affiliations）とクライアント（clients）をつなぐ（利用者の要望 Sprint 10。#9302。w10-partners）
-- 列の追加と索引のみ（既存の列・値は変えない。新しい表はないので、退職後の削除・解約企業の書き出しと削除の対象の表は増えない）。
--
-- client_id: この協力会社がクライアントでもあるとき、そのクライアントの client_id。NULL はつながりなし。
--   1対1（同じクライアントを2つの協力会社につなげない）。クライアントは AUTOINCREMENT なので、消したクライアントの番号が
--   別のクライアントに使い回されることはない（消したクライアントにつながった行は、画面ではつながりなしとして扱う）。
--   クライアントを消せなくならないように、外部キーにはしない
ALTER TABLE staff_affiliations ADD COLUMN client_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_affiliations_client ON staff_affiliations(client_id) WHERE client_id IS NOT NULL;
