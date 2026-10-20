-- 持ち越しの仕上げ（サーバー：シフト・精算・打刻・日報・ダッシュボード・その他。w7-followup-server-b）
-- 列・索引・トリガーの追加のみ。日時は日本時間の 'YYYY-MM-DD HH:MM:SS'。

-- 1. まとめて出した打刻修正の申請の束（#392）。同じ申請操作で登録した行に同じ値を入れる（1件だけの申請は NULL）。
--    承認依頼のメールを1通にまとめる・添付を共有する単位。これまでは同じシフト・申請者・created_at（秒）で束ねていたため、
--    同じ秒に別々に出した申請が1つにまとまることがあった（NULL の行は従来どおり created_at で束ねる）
ALTER TABLE attendance_corrections ADD COLUMN batch_key TEXT;

-- 2. 日報をスタッフ × 稼働日で引く索引（#463。スタッフ一覧の集計・スタッフ詳細の月の範囲の条件に使う）
CREATE INDEX IF NOT EXISTS idx_daily_reports_staff_date ON daily_reports(staff_id, work_date);

-- 3. スキルシートの推薦コメント（#447）。社内用の管理者メモ（memo）とは別に持ち、スキルシートにだけ印刷する
ALTER TABLE staff_profiles ADD COLUMN skill_sheet_comment TEXT;

-- 4. 公開の応募で、ロボット判定（Turnstile）の確認サービスに接続できなかったまま受け付けた印（#501。利用者の判断）。
--    1 = 要確認（ロボット判定できず）。判定に落ちた応募はこれまでどおり受け付けない
ALTER TABLE recruit_applications ADD COLUMN turnstile_unverified INTEGER;

-- 5. 欠勤（absent）から別の状態に変えたシフトのキャンセル料・補償（shift_cancellations）を消す（#283）。
--    どの画面・API で状態を変えても、後で欠勤に戻したときに前の金額が戻らないようにする
CREATE TRIGGER IF NOT EXISTS trg_shift_cancellations_clear AFTER UPDATE OF status ON shifts
WHEN OLD.status = 'absent' AND NEW.status IS NOT 'absent'
BEGIN
  DELETE FROM shift_cancellations WHERE shift_id = NEW.shift_id;
END;

-- 6. お知らせを、ログインのないスタッフ（報告用URLで稼働する人）にもメールで送るか（#281）。
--    1 = 配信対象のうちメールアドレスのあるログインのない人にもメールを送る（既読率の対象には含めない）
ALTER TABLE notices ADD COLUMN email_nologin INTEGER NOT NULL DEFAULT 0;

-- 7. 案件ごとの現場責任者の連絡先（#173。任意）。スタッフアプリ・報告用URLの当日のシフトに、会社の緊急連絡先と並べて出す
ALTER TABLE projects ADD COLUMN site_contact_name TEXT;
ALTER TABLE projects ADD COLUMN site_contact_phone TEXT;
