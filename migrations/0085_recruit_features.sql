-- 募集・掲示板の機能追加（w6-recruit-features: #300 #478 #479）
-- 列・テーブルの追加のみ。日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。

-- 1. 募集ページの独自の質問（#300）
--    recruit_pages.questions: [{ key: 'q1', label, type: 'text' | 'select' | 'yesno', required: 0/1, options: [..] }]（最大5問。NULL は質問なし）
--    recruit_applications.answers: 応募の時点の質問と回答の控え [{ key, label, type, value }]（あとで質問を変えても、応募の表示は変わらない）
ALTER TABLE recruit_pages ADD COLUMN questions TEXT;
ALTER TABLE recruit_applications ADD COLUMN answers TEXT;

-- 2. 応募の対応メモ（#478）。電話済み・不在・面談予定など、管理者どうしで対応を共有する
CREATE TABLE IF NOT EXISTS recruit_application_notes (
  note_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_recruit_app_notes_app ON recruit_application_notes(application_id, note_id);

-- 3. 案件掲示板の保存した検索条件（#479）。利用者ごと。
--    条件は一覧の検索と同じ項目（NULL は条件なし）。notify: 新着をアプリ内通知で知らせる / notify_email: メールでも知らせる（1日1通にまとめる）
--    last_checked_at: 新着を確かめた日時（この日時より後に掲載された案件を新着とみなす）/ prev_checked_at: その前に確かめた日時
CREATE TABLE IF NOT EXISTS board_saved_searches (
  search_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  engagement_type TEXT,
  prefecture TEXT,
  area TEXT,
  work_date TEXT,
  skill TEXT,
  keyword TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  notify_email INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL,
  prev_checked_at TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_board_saved_searches_user ON board_saved_searches(user_id, search_id);
CREATE INDEX IF NOT EXISTS idx_board_saved_searches_due ON board_saved_searches(notify, last_checked_at);
