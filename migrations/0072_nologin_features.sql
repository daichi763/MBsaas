-- ログインのないスタッフ向けの機能（w5-nologin-features: #163 #275 #276 #281 #442 #508）
-- 列・表の追加のみ。既存の行の値は変えない。日時は日本時間の 'YYYY-MM-DD HH:MM:SS'

-- #276 日報の代理入力: 管理者が記録した日報は entry_method = 'proxy' とし、入力した管理者を entered_by に残す。
--      本人がアプリ・報告用URLで出し直したら NULL に戻す（daily_reports の entry_method と同じく、最後に出した人を表す）
ALTER TABLE daily_reports ADD COLUMN entered_by INTEGER;

-- #163 報告用URL・予定確認URLから届いた連絡（遅刻・欠勤・トラブル）。NULL はアプリから（これまでの行）、'link' は URL から
ALTER TABLE consultations ADD COLUMN entry_method TEXT;

-- #442 予定確認URL（スタッフ単位。ログインのない人が、今日から2週間の確定シフトを見られる）。
--   トークンそのものは保存せず、SHA-256 のハッシュだけを持つ（URL は発行したときに一度だけ画面に出す）。
--   1人に有効なものは1つ（発行し直すと前のものは revoked_at を入れて使えなくする）。
--   退職・統合・停止の人のURLは、開いたときの確認で使えなくする（行は残る）。匿名化したら下のトリガーで消す
CREATE TABLE IF NOT EXISTS staff_schedule_tokens (
  token_id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_schedule_tokens_staff ON staff_schedule_tokens(staff_id, revoked_at);

-- 定期削除で本人情報を匿名化したら、そのスタッフの予定確認URLの行も消す（どの経路で匿名化しても残さない）
CREATE TRIGGER IF NOT EXISTS trg_staff_schedule_tokens_anonymized AFTER UPDATE OF anonymized_at ON staff_profiles
WHEN NEW.anonymized_at IS NOT NULL
BEGIN
  DELETE FROM staff_schedule_tokens WHERE staff_id = NEW.staff_id;
END;

-- スタッフの行を消したとき（統合元の削除・企業のデータ削除など）も消す
CREATE TRIGGER IF NOT EXISTS trg_staff_schedule_tokens_staff_delete AFTER DELETE ON staff_profiles
BEGIN
  DELETE FROM staff_schedule_tokens WHERE staff_id = OLD.staff_id;
END;
