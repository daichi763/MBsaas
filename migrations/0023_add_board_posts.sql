-- 案件掲示板 第1段階: 掲載（docs/spec_board.md）
-- 利用企業どうしが案件を掲載・閲覧する。掲載企業名は公開、公開範囲は全利用企業
CREATE TABLE IF NOT EXISTS board_posts (
  post_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,              -- 掲載企業
  engagement_type TEXT NOT NULL,            -- regular（常勤）/ spot（スポット）
  title TEXT NOT NULL,
  description TEXT,                         -- 業務内容・詳細
  prefecture TEXT,
  area TEXT,                                -- 市区町村・エリア
  nearest_station TEXT,
  date_from DATE,                           -- 常勤: 開始日 / スポット: 実施日（開始）
  date_to DATE,                             -- 常勤: 終了予定（空=長期） / スポット: 実施日（終了）
  time_from TEXT,                           -- HH:MM
  time_to TEXT,
  schedule_note TEXT,                       -- 「週5・土日含む」等
  headcount INTEGER NOT NULL DEFAULT 1,
  required_skills TEXT,                     -- カンマ区切り
  price_amount INTEGER NOT NULL,            -- 単価（必須）
  price_unit TEXT NOT NULL,                 -- hourly / daily / monthly
  price_note TEXT,                          -- 「スキルにより交渉可能」「応相談」等
  deadline DATE,                            -- 締切日（過ぎたら閲覧時に自動で締切扱い）
  status TEXT NOT NULL DEFAULT 'draft',     -- draft / open / closed / filled
  source_project_id INTEGER,                -- コピー元の自社案件（自社内のみ参照）
  published_at DATETIME,
  created_by INTEGER,
  updated_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_board_posts_open ON board_posts(status, engagement_type, published_at);
CREATE INDEX IF NOT EXISTS idx_board_posts_company ON board_posts(company_id, status);
