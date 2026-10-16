-- お知らせの既読数・既読率レポートを配信対象どおりにする（w2-notice-read: #48 #49 #245 #481）
--
-- notice_read_reports.finalized_at: 年度の既読率レポートを確定した日時（JST）。
--   確定した年度は cron でも管理画面の「再集計」でも作り直さない（#48 #49）。
--   cron は前年度を、年度末から30日たった日に最後の集計をして確定する。
-- notices.reads_purged_at / final_read_count / final_target_count:
--   公開から2年たったお知らせの既読の記録（notice_reads）を削除するときに、削除の直前の
--   既読数・対象人数を残す。管理画面の「既読 x/y名」は削除の後もこの値を出す（#245）。

ALTER TABLE notice_read_reports ADD COLUMN finalized_at DATETIME;

ALTER TABLE notices ADD COLUMN reads_purged_at DATETIME;
ALTER TABLE notices ADD COLUMN final_read_count INTEGER;
ALTER TABLE notices ADD COLUMN final_target_count INTEGER;

-- 公開日での既読の記録の削除と、年度の範囲での集計に使う
CREATE INDEX IF NOT EXISTS idx_notices_company_published ON notices(company_id, published_at);
CREATE INDEX IF NOT EXISTS idx_notices_reads_purge ON notices(reads_purged_at, published_at);
