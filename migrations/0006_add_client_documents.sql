-- クライアント（発注元企業）契約書ファイル管理
-- ファイル本体はD1へ保存しない（R2のみ）。ここにはメタデータのみ保持する。
-- 同一クライアント・同名ファイルでも別レコード（別storage_key）として複数保存できる。
-- staff_documentsと同じ設計パターン（company_idはテナント分離用、client_idが実際の紐付け先）
CREATE TABLE IF NOT EXISTS client_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  original_file_name TEXT NOT NULL,   -- ダウンロード時に復元する元のファイル名
  storage_key TEXT NOT NULL,          -- R2オブジェクトキー（UUID込みで一意）
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  uploaded_by INTEGER,                -- アップロードした管理者ユーザー
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (client_id) REFERENCES clients(client_id),
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_client_documents_client ON client_documents(client_id);
CREATE INDEX IF NOT EXISTS idx_client_documents_company ON client_documents(company_id);
