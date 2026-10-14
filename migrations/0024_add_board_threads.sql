-- 案件掲示板 第2段階: 案件チャット（docs/spec_board.md）
-- スレッド = 掲載1件 × 問い合わせ企業1社（1対1）。参加できるのは掲載企業と問い合わせ企業の管理系ユーザーのみ
-- 履歴は削除しない。システムメッセージ（kind='system'）も同じ時系列に記録する
CREATE TABLE IF NOT EXISTS board_threads (
  thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  poster_company_id INTEGER NOT NULL,       -- 掲載企業
  inquirer_company_id INTEGER NOT NULL,     -- 問い合わせ企業
  status TEXT NOT NULL DEFAULT 'open',      -- open / closed（どちらかが終了したスレッド）
  last_message_id INTEGER,
  last_message_at DATETIME,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, inquirer_company_id),
  FOREIGN KEY (post_id) REFERENCES board_posts(post_id),
  FOREIGN KEY (poster_company_id) REFERENCES companies(company_id),
  FOREIGN KEY (inquirer_company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_board_threads_poster ON board_threads(poster_company_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_board_threads_inquirer ON board_threads(inquirer_company_id, last_message_at);

CREATE TABLE IF NOT EXISTS board_messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  author_company_id INTEGER NOT NULL,
  author_user_id INTEGER,                    -- system メッセージは NULL 可
  kind TEXT NOT NULL DEFAULT 'text',         -- text / system（第3段階で proposal を追加）
  body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES board_threads(thread_id)
);
CREATE INDEX IF NOT EXISTS idx_board_messages_thread ON board_messages(thread_id, message_id);

-- 既読位置（企業単位。自社の誰かが開けば自社として既読）
CREATE TABLE IF NOT EXISTS board_thread_reads (
  thread_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  read_by INTEGER,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, company_id)
);
