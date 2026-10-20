-- お知らせの機能追加（w5-notice-features: #157 #291 #294 #554 #555）
--
-- notices に足す列（既存の行はすべて「配信済み」のまま。値は変えない）
--   status         : draft（下書き）/ scheduled（予約。published_at が配信予定日時）/ published（配信済み）/ withdrawn（取消）。
--                    スタッフに見せるのは published と、配信予定日時を過ぎた scheduled（#291。予約配信のメールは定期処理で送り、published にする）
--   expires_at     : 掲載期限（日本時間 'YYYY-MM-DD HH:MM:SS'。過ぎたらスタッフのホーム・一覧から下げ、「掲載終了」に分ける #294）
--   updated_at / updated_by     : 配信した後に修正した日時と人（スタッフの画面に「更新」の印を出す #157）
--   withdrawn_at / withdrawn_by / withdraw_reason : 取り消した日時・人・理由（論理削除。スタッフの画面には出さない #157）
--   send_email     : 予約配信・下書きを配信するときにメールも送るか
--   response_options / response_comment : 回答の選択肢（JSON の文字列の配列）と、自由記入欄の有無（#554）
ALTER TABLE notices ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE notices ADD COLUMN expires_at TEXT;
ALTER TABLE notices ADD COLUMN updated_at TEXT;
ALTER TABLE notices ADD COLUMN updated_by INTEGER;
ALTER TABLE notices ADD COLUMN withdrawn_at TEXT;
ALTER TABLE notices ADD COLUMN withdrawn_by INTEGER;
ALTER TABLE notices ADD COLUMN withdraw_reason TEXT;
ALTER TABLE notices ADD COLUMN send_email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notices ADD COLUMN response_options TEXT;
ALTER TABLE notices ADD COLUMN response_comment INTEGER NOT NULL DEFAULT 0;

-- 予約配信の定期処理（status = 'scheduled' AND published_at <= 今）と、管理画面の状態の絞り込みに使う
CREATE INDEX IF NOT EXISTS idx_notices_status_published ON notices(status, published_at);

-- #157 notice_revisions: 修正・取消の前の内容（誰がいつ何を変えたかを残す）
CREATE TABLE IF NOT EXISTS notice_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  action TEXT NOT NULL,              -- edit / withdraw
  title TEXT,
  body TEXT,
  target_type TEXT,
  target_ids TEXT,
  importance TEXT,
  read_required INTEGER,
  expires_at TEXT,
  edited_by INTEGER,
  edited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notice_revisions_notice ON notice_revisions(notice_id, revision_id);

-- #554 notice_responses: お知らせへの回答（1人1行。答え直したら上書きする）。choice は選択肢の文字列
CREATE TABLE IF NOT EXISTS notice_responses (
  notice_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  choice TEXT,
  comment TEXT,
  answered_at TEXT NOT NULL,         -- 日本時間
  updated_at TEXT,
  PRIMARY KEY (notice_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notice_responses_user ON notice_responses(user_id);

-- #555 notice_attachments: お知らせの添付（画像・PDF。本体は R2 の DOCUMENTS に置く）
CREATE TABLE IF NOT EXISTS notice_attachments (
  attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notice_attachments_notice ON notice_attachments(notice_id);
