-- シフト希望（出勤可能日）の回収の対象をスタッフごとに選ぶ（利用者の決定 Sprint 17。#9907。w17-shift-collect）
-- 列の追加のみ（既存の表・列・値は変えない）。
--
-- staff_profiles.availability_exempt: 1 = 回収の対象外（スポットの人など）。既定の 0 は今までどおり「対象」。
--   対象外の人には、スタッフアプリのシフトタブの未提出の案内・管理者からの提出のお願いの通知を出さず、
--   管理画面（出勤可能日）の未提出の数・一覧にも数えない。本人が自分から提出することはできる（提出した分は一覧に出す）。
--   会社ごとの行（staff_profiles は会社ごと）に持つので、他社から連携したスタッフも稼働先の会社ごとに決められる。
--   スタッフの行の一部なので、退職後の削除・解約企業の削除（src/services/retention.ts）は staff_profiles と同じに扱われる
ALTER TABLE staff_profiles ADD COLUMN availability_exempt INTEGER NOT NULL DEFAULT 0;
