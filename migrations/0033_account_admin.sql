-- 管理者アカウントの管理・パスワードの変更と再発行・本部ユーザーの切り離し（作業単位 w2-account-admin。#25 #43 #44 #45 #372）
--
-- users.must_change_password: 管理者・本部が決めた仮パスワード（再発行・管理者アカウントの追加）のときに 1。
--   本人がパスワードを変更・再設定すると 0 に戻す。既存の行はすべて 0（今までどおり）。
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- #372 本部専用の企業行（active_status = 'internal'）を作り、本部ユーザー（system_admin）を企業1から移す。
--   'internal' の企業は本部の企業一覧・課金の集計に出さない。本部はログインで会社コードを入力しなくてよい。
--   すでに同じ会社コードの行がある場合は作らない（その場合は本部ユーザーも移さない）。
INSERT OR IGNORE INTO companies (company_code, company_name, plan, user_limit, active_status, billing_status, settings_json)
SELECT 'hq-internal', '本部（システム管理）', 'internal', 0, 'internal', 'active', '{}'
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE active_status = 'internal');

-- 同じ ID の本部ユーザーが複数の企業にいて移せない行は、そのまま残す（UPDATE OR IGNORE。アプリ側でも system_admin は集計から外す）
UPDATE OR IGNORE users
SET company_id = (SELECT company_id FROM companies WHERE active_status = 'internal' ORDER BY company_id LIMIT 1)
WHERE role = 'system_admin'
  AND EXISTS (SELECT 1 FROM companies WHERE active_status = 'internal');

-- 本部ユーザーのログイン中のセッションも、移した先の企業にそろえる
UPDATE sessions SET company_id = (SELECT u.company_id FROM users u WHERE u.user_id = sessions.user_id)
WHERE user_id IN (SELECT user_id FROM users WHERE role = 'system_admin');
