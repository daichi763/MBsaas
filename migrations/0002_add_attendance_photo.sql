-- 入店報告・退店報告への写真添付対応
-- photo_key: Cloudflare R2 上のオブジェクトキー（画像自体はDBへ保存しない）
-- wake_up / departure は対象外のため NULL のまま運用する
ALTER TABLE attendance_reports ADD COLUMN photo_key TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_photo_key ON attendance_reports(photo_key);
