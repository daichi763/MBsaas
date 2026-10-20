-- 管理者・企業あての通知と、相談のやり取り・写真（w5-notify-admin: #150 #152 #154 #166 #429）
-- 日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。

-- 1. 通知のまとめ（#152 #166 #150）
--    同じやり取り（kind と related_id が同じ）の通知がまだ読まれていなければ、新しい行を作らずにその行を最新の内容に書き換え、件数を数える。
--    メールは、まとめた通知のメールを送ってから一定の時間（30分）がたつまで送らない（emailed_at が最後に送った日時）
ALTER TABLE user_notifications ADD COLUMN merged_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_notifications ADD COLUMN emailed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_user_notifications_kind_related ON user_notifications(kind, related_id, read_at);

-- 2. 相談のやり取り（#154）
--    最初の相談の本文は consultations.body のまま。その後の管理者の返信とスタッフの追加の連絡を時系列で残す。
--    consultations.manager_reply は最新の管理者の返信として残す（これまでの画面・API の互換のため）
--    author_side: staff（スタッフ本人）/ admin（管理者）
CREATE TABLE IF NOT EXISTS consultation_messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  author_side TEXT NOT NULL,
  author_user_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_consultation_messages_consult ON consultation_messages(consultation_id, message_id);

-- これまでの返信（上書きで最新の1件だけが残っている）を、やり取りの最初の返信として移す。
-- 日時は最後の返信の通知の日時（なければ相談の受付日時）
INSERT INTO consultation_messages (consultation_id, company_id, author_side, author_user_id, body, created_at)
SELECT co.consultation_id, co.company_id, 'admin', NULL, co.manager_reply,
  COALESCE((SELECT MAX(n.created_at) FROM user_notifications n WHERE n.kind = 'consult_reply' AND n.related_id = co.consultation_id), co.created_at)
FROM consultations co
WHERE co.manager_reply IS NOT NULL AND TRIM(co.manager_reply) != ''
  AND NOT EXISTS (SELECT 1 FROM consultation_messages m WHERE m.consultation_id = co.consultation_id);

-- 3. 相談の写真（#429）。R2 の PHOTOS に consultations/{company_id}/{consultation_id}/... のキーで保存する。
--    message_id は追加の連絡に付けた写真（NULL は最初の相談の写真）
CREATE TABLE IF NOT EXISTS consultation_attachments (
  attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  message_id INTEGER,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_consultation_attachments_consult ON consultation_attachments(consultation_id);

-- 相談を消したら（定期削除・企業のデータ削除など、どの経路でも）、やり取りと写真の行を消し、
-- 写真のファイルは定期削除の R2 の消し残しの控え（retention_pending_r2）に入れて、次の定期削除で消す
CREATE TRIGGER IF NOT EXISTS trg_consultations_delete_children AFTER DELETE ON consultations
BEGIN
  INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
    SELECT storage_key, OLD.staff_id, 'photos' FROM consultation_attachments WHERE consultation_id = OLD.consultation_id;
  DELETE FROM consultation_attachments WHERE consultation_id = OLD.consultation_id;
  DELETE FROM consultation_messages WHERE consultation_id = OLD.consultation_id;
END;
