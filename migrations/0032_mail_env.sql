-- w1-mail-env（#24 #105 #457）
-- 1) 本部の標準日報テンプレート4種（携帯ショップ・家電量販店・催事・光回線）を投入する。
--    これまで seed.sql にしか無く、本番では0件だった（案件登録のテンプレート欄が空になる）。
--    同じ名前の本部テンプレートが既にあれば入れない。ID 1〜4 が空いていればその番号を使う（seed.sql の案件が参照するため）。
INSERT INTO report_templates (template_id, company_id, template_name, template_type, fields_json)
SELECT CASE WHEN EXISTS (SELECT 1 FROM report_templates WHERE template_id = 1) THEN NULL ELSE 1 END, NULL, '携帯ショップ稼働テンプレート', 'hq',
  '[{"key":"mnp","label":"MNP件数","type":"number"},{"key":"pi","label":"PI件数","type":"number"},{"key":"shinki","label":"新規件数","type":"number"},{"key":"kishuhen","label":"機種変更件数","type":"number"},{"key":"hikari","label":"光回線件数","type":"number"},{"key":"denki","label":"でんき件数","type":"number"},{"key":"card","label":"クレジットカード件数","type":"number"},{"key":"koekake","label":"声かけ数","type":"number"},{"key":"shodan","label":"商談数","type":"number"},{"key":"seiyaku","label":"成約数","type":"number"},{"key":"good_case","label":"好事例","type":"text"},{"key":"store_share","label":"店舗共有事項","type":"text"},{"key":"other_result","label":"他社実績","type":"text"},{"key":"free","label":"自由記述","type":"textarea"}]'
WHERE NOT EXISTS (SELECT 1 FROM report_templates WHERE company_id IS NULL AND template_name = '携帯ショップ稼働テンプレート');
INSERT INTO report_templates (template_id, company_id, template_name, template_type, fields_json)
SELECT CASE WHEN EXISTS (SELECT 1 FROM report_templates WHERE template_id = 2) THEN NULL ELSE 2 END, NULL, '家電量販店稼働テンプレート', 'hq',
  '[{"key":"mnp","label":"MNP件数","type":"number"},{"key":"shinki","label":"新規件数","type":"number"},{"key":"hikari","label":"光回線件数","type":"number"},{"key":"wifi","label":"置き型Wi-Fi件数","type":"number"},{"key":"koekake","label":"声かけ数","type":"number"},{"key":"shodan","label":"商談数","type":"number"},{"key":"seiyaku","label":"成約数","type":"number"},{"key":"store_share","label":"店舗共有事項","type":"text"},{"key":"free","label":"自由記述","type":"textarea"}]'
WHERE NOT EXISTS (SELECT 1 FROM report_templates WHERE company_id IS NULL AND template_name = '家電量販店稼働テンプレート');
INSERT INTO report_templates (template_id, company_id, template_name, template_type, fields_json)
SELECT CASE WHEN EXISTS (SELECT 1 FROM report_templates WHERE template_id = 3) THEN NULL ELSE 3 END, NULL, '催事・イベント稼働テンプレート', 'hq',
  '[{"key":"koekake","label":"声かけ数","type":"number"},{"key":"shodan","label":"商談数","type":"number"},{"key":"seiyaku","label":"成約数","type":"number"},{"key":"mnp","label":"MNP件数","type":"number"},{"key":"hikari","label":"光回線件数","type":"number"},{"key":"good_case","label":"好事例","type":"text"},{"key":"free","label":"自由記述","type":"textarea"}]'
WHERE NOT EXISTS (SELECT 1 FROM report_templates WHERE company_id IS NULL AND template_name = '催事・イベント稼働テンプレート');
INSERT INTO report_templates (template_id, company_id, template_name, template_type, fields_json)
SELECT CASE WHEN EXISTS (SELECT 1 FROM report_templates WHERE template_id = 4) THEN NULL ELSE 4 END, NULL, '光回線・固定回線テンプレート', 'hq',
  '[{"key":"hikari","label":"光回線件数","type":"number"},{"key":"wifi","label":"置き型Wi-Fi件数","type":"number"},{"key":"denki","label":"でんき件数","type":"number"},{"key":"koekake","label":"声かけ数","type":"number"},{"key":"shodan","label":"商談数","type":"number"},{"key":"seiyaku","label":"成約数","type":"number"},{"key":"free","label":"自由記述","type":"textarea"}]'
WHERE NOT EXISTS (SELECT 1 FROM report_templates WHERE company_id IS NULL AND template_name = '光回線・固定回線テンプレート');

-- 2) お知らせの二重配信の防止（#105）。画面が発行した一意キーを保存し、同じキーの配信は受け付けない
ALTER TABLE notices ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notices_client_request ON notices(company_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- 3) お知らせメールの送信結果（#24）。対象者ごとに1行。メールアドレスは保存しない（連携スタッフの所属元のアドレスを連携先に見せないため）
-- status: pending（送信前）/ sent / failed / no_email（メールアドレス未登録のため送らない）/ skipped（MAIL_ENABLED=false で送らない）
CREATE TABLE IF NOT EXISTS notice_email_deliveries (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  provider_message_id TEXT,
  created_at TEXT,
  sent_at TEXT,
  UNIQUE (notice_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notice_email_deliveries_notice ON notice_email_deliveries(notice_id, status);
