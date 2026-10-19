-- 報告用URLと代理入力・写真付きの報告（w4-report-link-proxy: #418 #532 #535）
--
-- #418 photo_taken_at: 写真のファイルの日時（端末が付けた最終更新日時。JST の 'YYYY-MM-DD HH:MM:SS'）。
--      報告の日時と 30 分以上ずれていれば、管理画面に「撮影日時が報告と異なる」と出す。取れなければ NULL
--      photo_source: 写真の選び方（camera = カメラで撮影 / album = アルバムから選択）。分からなければ NULL
-- #535 no_photo_reason: 写真が必須の入店・退店を、写真なしで報告したときの理由（画面に出す文言。会社設定で許可したときだけ）
-- #532 device_id: 報告用URLを開いた端末ごとの識別子（ブラウザに保存した乱数）。1つのURLで別の端末から報告されたら管理画面で知らせる
-- いずれも列の追加のみ（既存の行は NULL のまま）
ALTER TABLE attendance_reports ADD COLUMN photo_taken_at TEXT;
ALTER TABLE attendance_reports ADD COLUMN photo_source TEXT;
ALTER TABLE attendance_reports ADD COLUMN no_photo_reason TEXT;
ALTER TABLE attendance_reports ADD COLUMN device_id TEXT;
