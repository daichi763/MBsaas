-- 本部の支援機能（作業単位 w5-hq-support: #179 #516 #293）。テーブルの追加のみで、既存のデータは変えない
--
-- 1. 伴走支援の依頼（#179）
--    管理画面の「伴走支援を依頼する」から送られた依頼。会社と依頼した人を付けて残し、本部の「伴走支援」タブで対応状況を管理する。
--    menu: 依頼のメニュー（初期設定代行・日報項目設計など。画面の選択肢の値）。preferred_at: 希望日時（自由入力）。
--    status: open（未対応）/ in_progress（対応中）/ done（完了）。hq_note: 本部の対応メモ。handled_by: 最後に状況を変えた本部ユーザー
CREATE TABLE IF NOT EXISTS support_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER,
  requester_name TEXT,
  menu TEXT NOT NULL,
  detail TEXT NOT NULL,
  preferred_at TEXT,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  hq_note TEXT,
  handled_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_requests_status ON support_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_support_requests_company ON support_requests(company_id, created_at);

-- 2. 本部から導入企業の管理者へのお知らせ（#516）
--    importance: normal（通常）/ important（重要）/ maintenance（メンテナンス）。
--    target: all（全企業）/ companies（選んだ企業。hq_announcement_companies）/ plan（target_plan のプランの企業）。
--    starts_at・ends_at: 掲載期間（日本時間 'YYYY-MM-DD HH:MM'。ends_at を過ぎると管理画面に出さない）。
--    withdrawn_at: 本部が取り消した日時（取り消したお知らせは管理画面に出さない）
CREATE TABLE IF NOT EXISTS hq_announcements (
  announcement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal',
  target TEXT NOT NULL DEFAULT 'all',
  target_plan TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_by INTEGER,
  withdrawn_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hq_announcements_period ON hq_announcements(starts_at, ends_at);
CREATE TABLE IF NOT EXISTS hq_announcement_companies (
  announcement_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_hq_announcement_companies_company ON hq_announcement_companies(company_id);
-- 管理者ごとの「確認しました」。企業別の既読状況は company_id で数える
CREATE TABLE IF NOT EXISTS hq_announcement_reads (
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_hq_announcement_reads_company ON hq_announcement_reads(announcement_id, company_id);

-- 3. 本部による管理画面の閲覧（読み取り専用。#293）
--    企業が許可したとき（companies.settings_json の hq_view_allowed）だけ、本部ユーザーが期限付きで閲覧できる。
--    token_hash: 閲覧用 Cookie のトークンの SHA-256。started_at・expires_at・ended_at は ISO 8601（UTC）。
--    end_reason: hq（本部が終了）/ replaced（別の企業の閲覧を始めた）/ revoked（企業が許可を取り消した）
CREATE TABLE IF NOT EXISTS hq_view_sessions (
  view_id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  hq_user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  support_request_id INTEGER,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_view_sessions_company ON hq_view_sessions(company_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hq_view_sessions_user ON hq_view_sessions(hq_user_id, started_at);
-- 閲覧中に開いた画面（API のパス）の記録。定期の取得（X-Background）は残さない
CREATE TABLE IF NOT EXISTS hq_view_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  view_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_view_logs_view ON hq_view_logs(view_id, created_at);
