-- 作業単位 w7-followup-server-a（持ち越しの仕上げ）。列の追加とトリガーだけ（既存のデータは変えない）

-- #225 公開の応募フォームで、送信回数の制限で止めた件数（募集ページごと）。管理画面の募集ページの一覧に出す
ALTER TABLE recruit_pages ADD COLUMN blocked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recruit_pages ADD COLUMN blocked_last_at TEXT;

-- #151 応募の結果（承認・見送り）のメールの送信状態。応募一覧で、届いていない応募を見分けて送り直せるようにする
--   result_mail_status: queued（送信待ち）/ sent / failed / disabled（送信を止めている環境）/ off（本人が受け取りを止めている）/ none（宛先なし）
--   result_mail_error: 失敗の理由（アドレスは伏せた形）
ALTER TABLE recruit_applications ADD COLUMN result_mail_status TEXT;
ALTER TABLE recruit_applications ADD COLUMN result_mail_at TEXT;
ALTER TABLE recruit_applications ADD COLUMN result_mail_error TEXT;

-- #158 スタッフが管理者の日報へのコメントを開いた日時（コメントが変わると空に戻す）。管理画面の「スタッフ既読」に使う
ALTER TABLE daily_reports ADD COLUMN comment_read_at TEXT;

-- #155 スタッフに関係する項目（日時・案件・場所・状態・担当者）が最後に変わった日時（日本時間）。
-- シフトを書き換える経路が多いため、トリガーで記録する。スタッフのシフト一覧で「変更」の印を出すのに使う
ALTER TABLE shifts ADD COLUMN staff_changed_at TEXT;
CREATE TRIGGER IF NOT EXISTS trg_shifts_staff_changed_at
AFTER UPDATE OF work_date, start_time, end_time, project_id, site_id, location, status, staff_id ON shifts
WHEN OLD.work_date IS NOT NEW.work_date OR OLD.start_time IS NOT NEW.start_time OR OLD.end_time IS NOT NEW.end_time
  OR OLD.project_id IS NOT NEW.project_id OR OLD.site_id IS NOT NEW.site_id OR OLD.location IS NOT NEW.location
  OR OLD.status IS NOT NEW.status OR OLD.staff_id IS NOT NEW.staff_id
BEGIN
  UPDATE shifts SET staff_changed_at = datetime('now', '+9 hours') WHERE shift_id = NEW.shift_id;
END;
