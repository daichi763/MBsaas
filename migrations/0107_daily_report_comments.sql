-- 日報のコメントを複数にする（利用者の要望 11/10。#9965。w24-requests）
-- 表・索引・トリガーの追加と、既存のコメントの写しのみ（daily_reports の列・値は消さない・変えない）。
--
-- daily_report_comments: 日報1件に何件でも付けられる、管理者のコメント。1コメント1行。
--   body: コメントの本文（2000文字まで）
--   author_user_id: 書いた人（users.user_id）。編集・削除は書いた本人だけ（src/api.ts の /admin/daily-reports/:id/comments）
--   created_at / updated_at: 書いた日時・最後に直した日時（日本時間 'YYYY-MM-DD HH:MM:SS'。直していなければ updated_at は NULL）
--   read_at: スタッフがアプリでこのコメントを開いた日時（#158 をコメントごとに。直すと NULL に戻る）
--   日報（daily_reports）の行と同じく扱う: 日報の3年の定期削除で、その日報のコメントも消す（src/services/retention.ts の cleanupDailyReports）。
--   company_id を持つので、解約企業の削除・書き出し（OFFBOARDING_TABLES）の対象にする。外部キーは付けない（daily_report_edits と同じ）
--
-- daily_reports.manager_comment・manager_comment_by・manager_comment_at・comment_read_at は残し、
-- 新しいコードは「最新のコメント」を写し続ける（古いコードに戻しても、最新のコメントと既読が今までどおり出るように）。
--   manager_comment / _by / _at: 最新のコメントの本文・書いた人・日時（直した日時があればそちら）。コメントが無ければ NULL
--   comment_read_at: 未読のコメントがあれば NULL、すべて既読なら最後に開いた日時
--
-- 1. 表と索引
CREATE TABLE IF NOT EXISTS daily_report_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  daily_report_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author_user_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_daily_report_comments_report ON daily_report_comments(daily_report_id, comment_id);
CREATE INDEX IF NOT EXISTS idx_daily_report_comments_company ON daily_report_comments(company_id);

-- 2. 既存のコメントを1件ずつ写す（すでに写した日報は写さない。何度当てても同じ結果）。
--    日時の無い古いコメント（0050 より前）は提出日時、それも無ければ当てた時刻にする
INSERT INTO daily_report_comments (company_id, daily_report_id, body, author_user_id, created_at, read_at)
SELECT dr.company_id, dr.daily_report_id, dr.manager_comment, dr.manager_comment_by,
  COALESCE(dr.manager_comment_at, dr.submitted_at, datetime('now', '+9 hours')), dr.comment_read_at
FROM daily_reports dr
WHERE TRIM(COALESCE(dr.manager_comment, '')) <> ''
  AND NOT EXISTS (SELECT 1 FROM daily_report_comments c WHERE c.daily_report_id = dr.daily_report_id);

-- 3. このマイグレーションを当ててから新しいコードを出すまでの間に、古いコードが書いたコメントも新しい表に入れる。
--    manager_comment が最新のコメントと違う内容に変わったときだけ、1件のコメントとして足す
--    （新しいコードは最新のコメントを写すので、写した内容は最新のコメントと同じになり、ここでは足さない）。
--    古いコードの「削除」（NULL にする）は写さない
CREATE TRIGGER IF NOT EXISTS trg_daily_reports_legacy_comment AFTER UPDATE OF manager_comment ON daily_reports
WHEN TRIM(COALESCE(NEW.manager_comment, '')) <> ''
  AND NEW.manager_comment IS NOT (SELECT c.body FROM daily_report_comments c WHERE c.daily_report_id = NEW.daily_report_id ORDER BY c.comment_id DESC LIMIT 1)
BEGIN
  INSERT INTO daily_report_comments (company_id, daily_report_id, body, author_user_id, created_at, read_at)
  VALUES (NEW.company_id, NEW.daily_report_id, NEW.manager_comment, NEW.manager_comment_by,
    COALESCE(NEW.manager_comment_at, datetime('now', '+9 hours')), NEW.comment_read_at);
END;
