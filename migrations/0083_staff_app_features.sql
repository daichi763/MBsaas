-- スタッフアプリの機能追加（作業単位 w6-staff-app-features: #176 #427。#278 はマイグレーション不要）
--
-- #176 前日確認: スタッフが前日に『明日の稼働を確認しました』を押した日時（JST 'YYYY-MM-DD HH:MM:SS'）。
--   day_before_confirmed_key は確認したときのシフトの内容（稼働日・開始・終了・案件・スタッフ・場所）。
--   day_before_confirmed_by は管理者が電話などで確かめて記録したときの管理者（users.user_id）。本人がアプリで押したときは NULL。
--   確認の後にシフトの日時・案件・担当・場所が変わったら、キーが合わなくなるので未確認として扱う（シフトを変える処理には手を入れない）。
--   会社の設定は companies.settings_json の day_before_check（{ enabled, deadline: 'HH:MM' }。既定は使わない。
--   GET/PUT /api/admin/report-settings/day-before-check）
ALTER TABLE shifts ADD COLUMN day_before_confirmed_at TEXT;
ALTER TABLE shifts ADD COLUMN day_before_confirmed_key TEXT;
ALTER TABLE shifts ADD COLUMN day_before_confirmed_by INTEGER;

-- #427 電波がない場所での報告: 押した時刻を端末に保存し、通信が戻ってから送る（POST /api/staff/attendance・/attendance-photo）。
--   client_request_id: 画面が押すたびに作る一意キー。同じキーの再送は、記録済みの報告をそのまま返す（二重に記録しない・409 にしない）
--   pressed_at: 端末で押した時刻（JST）。端末に保存して後から送ったときだけ入る
--   received_at: サーバーが受け取った時刻（JST）。アプリからの報告で入れる
--   time_source: 'device' は記録の時刻（reported_at）に端末で押した時刻を使ったもの（管理画面に『端末時刻で記録』と出す）。NULL は受け取った時刻
--   端末の時刻は変えられるので、受け付ける範囲（受け取った時刻との差・報告の受付時間帯・前の報告との順序）はサーバーで確かめる
ALTER TABLE attendance_reports ADD COLUMN client_request_id TEXT;
ALTER TABLE attendance_reports ADD COLUMN pressed_at TEXT;
ALTER TABLE attendance_reports ADD COLUMN received_at TEXT;
ALTER TABLE attendance_reports ADD COLUMN time_source TEXT;
