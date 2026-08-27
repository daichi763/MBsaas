-- スタッフ履歴書・職務経歴書等のファイル管理
-- ファイル本体はD1へ保存しない（R2のみ）。ここにはメタデータのみ保持する。
-- 同一スタッフ・同名ファイルでも別レコード（別storage_key）として複数保存できる。
CREATE TABLE IF NOT EXISTS staff_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  original_file_name TEXT NOT NULL,   -- ダウンロード時に復元する元のファイル名
  storage_key TEXT NOT NULL,          -- R2オブジェクトキー（UUID込みで一意）
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  uploaded_by INTEGER,                -- アップロードした管理者ユーザー
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id),
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_documents_staff ON staff_documents(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_documents_company ON staff_documents(company_id);
