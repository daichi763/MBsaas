-- ダッシュボードの ToDo とフォロー記録（w4-dashboard-todo: #487 #385 #498）
-- 既存のデータは変えない（テーブル・列・インデックスの追加のみ）

-- #487 ToDo を『対応済み』『あとで』にした記録。ToDo は毎回ルールから作るので、ここには非表示にしたキーだけを持つ。
--   todo_key: ToDo ごとの安定したキー（例: late:{staff_id}:{月}、consult:{consultation_id}）
--   mark: 非表示にした時点の目印（件数・最新の ID など）。今の値がこれより大きくなったら（新しい遅刻・未提出などが増えたら）もう一度出す
--   action: done（対応済み）/ snooze（あとで。until_at まで出さない）
CREATE TABLE IF NOT EXISTS todo_dismissals (
  company_id INTEGER NOT NULL,
  todo_key TEXT NOT NULL,
  action TEXT NOT NULL,
  mark INTEGER NOT NULL DEFAULT 0,
  until_at DATETIME,
  user_id INTEGER,
  created_at DATETIME DEFAULT (datetime('now', '+9 hours')),
  PRIMARY KEY (company_id, todo_key)
);

-- #385 フォロー記録の次回対応日と、完了にした日時
ALTER TABLE follow_logs ADD COLUMN next_action_date DATE;
ALTER TABLE follow_logs ADD COLUMN done_at DATETIME;
-- 対応中で期日を過ぎた記録（ダッシュボードの ToDo）と、フォロー履歴の状態の絞り込み
CREATE INDEX IF NOT EXISTS idx_follow_logs_company_status ON follow_logs(company_id, status, next_action_date);

-- #498 当日の遅刻・欠勤の相談をダッシュボードの未報告一覧に結び付ける（対象の日付で引く）
CREATE INDEX IF NOT EXISTS idx_consultations_company_target ON consultations(company_id, target_date);
