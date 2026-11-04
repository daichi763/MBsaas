-- 案内（チュートリアル）の進み具合（利用者の決定 Sprint 15。#9711 #9712。w15-tour）
-- 表の追加のみ（既存の表・列・値は変えない）。
--
-- user_tour_progress: 人（users の行）ごと・案内（tour_key）ごとに、見終わった・スキップした・途中まで進んだかを残す。
--   別の端末で開いても同じ状態になるよう、端末ではなくサーバーに残す。書き込みは src/tours.ts だけ。
--   tour_key: 'admin-welcome'（管理画面の最初の案内）、'admin-screen-<画面>'（各画面の使い方）、
--             'admin-checklist'（ダッシュボードの「はじめにやること」）、'staff-welcome'（スタッフアプリの案内）。使える値は src/tours.ts の TOUR_KEYS
--   status: 'in_progress'（途中まで。step から続ける）/ 'done'（見終わった）/ 'skipped'（スキップした・閉じた）
--   step: 途中まで進んだステップ（0 から）
--   company_id: その利用者の会社（解約企業の削除 OFFBOARDING_TABLES で消すため）
--   退職後の削除（src/services/retention.ts）でもその人の行を消す
CREATE TABLE IF NOT EXISTS user_tour_progress (
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  tour_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'done', 'skipped')),
  step INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tour_key)
);
CREATE INDEX IF NOT EXISTS idx_user_tour_progress_company ON user_tour_progress(company_id, tour_key);
