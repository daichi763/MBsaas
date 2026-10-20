-- 0073: 打刻修正の機能追加（w5-corrections-features: #174 #175 #280 #485）
-- 表の追加だけ。既存の値は変えない。
-- #174（申請と同時に承認）・#280（まとめて承認）・#175（打刻データの一覧・CSV）は既存の表で足りるため、変更はない。

-- ---------- #485 打刻修正の申請に添付した写真・画像 ----------
-- 画像は R2（PHOTOS）の attendance/{会社}/{スタッフ}/{シフト}/correction_{申請ID}_*.jpg に置く。1申請につき3枚まで。
-- 承認した入店・退店の報告に写真がなければ、1枚目のキーを attendance_reports.photo_key に入れる（同じ R2 のオブジェクトを指す）。
-- 外部キーは張らない（attendance_corrections と同じく、定期削除・シフト削除の処理を止めないため）
CREATE TABLE IF NOT EXISTS attendance_correction_attachments (
  attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,                 -- シフトの所有企業
  staff_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  photo_key TEXT NOT NULL,                     -- R2（PHOTOS）のキー。画面には出さない
  content_type TEXT,
  size_bytes INTEGER,
  photo_taken_at TEXT,                         -- 端末が付けたファイルの日時（JST）
  photo_source TEXT,                           -- camera / album
  uploaded_by INTEGER,
  uploaded_by_name TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_correction_attachments_correction ON attendance_correction_attachments(correction_id);
CREATE INDEX IF NOT EXISTS idx_correction_attachments_staff ON attendance_correction_attachments(staff_id);
CREATE INDEX IF NOT EXISTS idx_correction_attachments_key ON attendance_correction_attachments(photo_key);
