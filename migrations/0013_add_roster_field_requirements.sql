-- スタッフマスタ項目の必須/任意を企業ごとに設定する（フェーズD）
--
-- ・絶対必須項目（氏名・性別）はこのテーブルの対象外で、常に必須（アプリ側で固定チェック）。
-- ・レコードが無い項目は「任意」扱い（既定値）。既存企業の挙動は変わらない。
-- ・適用対象: スタッフマスタの新規作成（②③④ルート）と、所属元による基本項目の更新。
--   ①QR/ID連携は基本項目を所属元が管理するため、稼働先の必須設定は適用しない。
CREATE TABLE IF NOT EXISTS roster_field_requirements (
  company_id INTEGER NOT NULL,
  field_code TEXT NOT NULL,          -- kana / date_of_birth / skills / career / work_area 等（src/roster.ts の ROSTER_CONFIGURABLE_FIELDS）
  is_required INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, field_code),
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (updated_by) REFERENCES users(user_id)
);

-- 稼働先追記項目（フェーズF）
-- 指示書の権限表「スタッフマスタ追記項目（現場評価・稼働メモ）: 所属元=閲覧可 / 稼働先=編集可 / 本人=不可」に対応する専用列。
-- 既存の memo（管理者メモ）は各社の社内メモのまま他社へは一切公開しない。これらの列だけが所属元に共有される。
ALTER TABLE staff_profiles ADD COLUMN site_evaluation TEXT;   -- 現場評価（稼働先が記入）
ALTER TABLE staff_profiles ADD COLUMN work_memo TEXT;         -- 稼働メモ（稼働先が記入）
ALTER TABLE staff_profiles ADD COLUMN host_note_updated_at DATETIME;
