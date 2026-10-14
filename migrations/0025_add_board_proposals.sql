-- 案件掲示板 第3段階: 人材提案（docs/spec_board.md 4・5章）
-- 提案時点のスキルシートを匿名スナップショット（snapshot）として保存し、採用時に氏名（disclosed）を開示する
-- 提案相手からの見え方は区分にかかわらず「所属: 提案元企業」。upstream_chain（上流の経路）は API・画面に一切出さない
CREATE TABLE IF NOT EXISTS board_proposals (
  proposal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  proposer_company_id INTEGER NOT NULL,     -- 提案元（受け手に見える唯一の企業）
  receiver_company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,                -- 提案元のスタッフマスタ行（提案元のみ参照）
  staff_kind TEXT,                          -- 提案時の区分（提案元のみ参照）
  snapshot TEXT NOT NULL,                   -- 匿名スキルシート JSON
  disclosed TEXT,                           -- 採用時に開示する氏名等 JSON（採用までは受け手に返さない）
  proposed_price INTEGER,
  price_unit TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed / interview / adopted / declined / withdrawn
  upstream_chain TEXT,                      -- 非公開: 上流の経路（JSON）。監査用
  imported_staff_id INTEGER,                -- 第4段階: 受け手が取り込んだスタッフ行
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME,
  FOREIGN KEY (thread_id) REFERENCES board_threads(thread_id),
  FOREIGN KEY (post_id) REFERENCES board_posts(post_id)
);
CREATE INDEX IF NOT EXISTS idx_board_proposals_thread ON board_proposals(thread_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_board_proposals_proposer ON board_proposals(proposer_company_id, status);
CREATE INDEX IF NOT EXISTS idx_board_proposals_receiver ON board_proposals(receiver_company_id, status);
CREATE INDEX IF NOT EXISTS idx_board_proposals_staff ON board_proposals(staff_id);
-- チャットの提案カード用: メッセージに提案IDを紐づける（kind='proposal'）
ALTER TABLE board_messages ADD COLUMN proposal_id INTEGER;
