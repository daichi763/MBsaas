-- シフトの確定・削除の通知の切り替え（利用者の決定 Sprint 17。#9906。w17-shift-notify）
-- 列の追加のみ（既存の表・列・値は変えない）。
--
-- 1. companies.shift_notify_default: シフト管理でシフトを登録・確定・変更・削除・欠勤にしたときに、スタッフに通知を送るかの会社の既定。
--      1 = 送る（今までと同じ。既定）/ 0 = 送らない。操作のたびの確認の画面の「スタッフに通知を送る」のチェックの初期値になる。
--      画面を通らない呼び出し（チェックを送らない呼び出し）は、この値に従う。
--    companies.shift_notify_updated_at / shift_notify_updated_by: 最後に変えた日時（日本時間）と、変えた管理者（users.user_id）。設定の画面に出す
-- 2. operation_logs.notify_off: その操作でスタッフに通知を送らなかった（チェックを外した・会社の既定が「送らない」）とき 1。
--      送ったとき・通知に関係のない操作は NULL。シフトの変更履歴に「通知なし」と出す
ALTER TABLE companies ADD COLUMN shift_notify_default INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN shift_notify_updated_at TEXT;
ALTER TABLE companies ADD COLUMN shift_notify_updated_by INTEGER;
ALTER TABLE operation_logs ADD COLUMN notify_off INTEGER;
