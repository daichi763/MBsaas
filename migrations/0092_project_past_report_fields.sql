-- 日報テンプレートを差し替えた後も、古い項目を元の表示名で出す（利用者の要望 Sprint 12。#9511。w12-analytics）
-- 列の追加のみ（既存の列・値は変えない。新しい表はないので、退職後の削除・解約企業の書き出しと削除の対象の表は増えない。
-- 案件の行に入るので、解約企業の書き出し・削除は projects と一緒に行われる）。
--
-- past_report_fields_json: 案件の日報テンプレートを差し替えたときの、それまでのテンプレートの項目の写し（JSON の配列）。
--   1項目は {key, label, type, unit?, template_id, template_name, replaced_at}。同じ key は最後に差し替えたときの表示名で上書きする。
--   NULL は差し替えの記録なし。この列ができる前に差し替えた案件は、画面・CSV で本部・自社のテンプレートの同じ key の表示名を使う（api.ts）
ALTER TABLE projects ADD COLUMN past_report_fields_json TEXT;
