-- すべての割当経路で退職者・NG・重複・二度押しを防ぐ（w2-assign-guards: #187 #249 #530 #568）
--
-- 1. 同じ枠の役割への二重割当の防止（#530）
--    (slot_role_id, staff_id) に、欠勤を除いた部分一意インデックスを付ける。
--    すでに重複している行があるとインデックスを作れないため、重複のうち最も古い1件以外に印（legacy_duplicate=1）を付け、
--    印の付いた行はインデックスの対象から外す（行の削除・状態の変更はしない。精算の確認で見直せるように残す）。
ALTER TABLE shifts ADD COLUMN legacy_duplicate INTEGER;
UPDATE shifts SET legacy_duplicate = 1
  WHERE slot_role_id IS NOT NULL AND status != 'absent'
    AND EXISTS (SELECT 1 FROM shifts o
      WHERE o.slot_role_id = shifts.slot_role_id AND o.staff_id = shifts.staff_id AND o.status != 'absent' AND o.shift_id < shifts.shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_slot_role_staff ON shifts(slot_role_id, staff_id)
  WHERE slot_role_id IS NOT NULL AND status != 'absent' AND legacy_duplicate IS NULL;

-- 2. 連携先（稼働先）での取引終了（#249）
--    linked_external の行に、稼働先が「取引終了」にした日時を持たせる。設定した行はシフトの割当候補から外す。
--    所属元のユーザー状態・退職日・在籍状況は変えない（休職中などは、連携行の employment_status で持つ）。
ALTER TABLE staff_profiles ADD COLUMN link_ended_at TEXT;

-- 3. 仮登録の二度押し・同時送信の防止（#568）
--    同じ会社・同じ電話番号（数字のみに正規化）の仮登録は、処理中と直後の一定時間は1件だけにする。
--    request_key は画面を開くたびに作る値で、同じ画面からの再送には作成済みのスタッフを返す。
CREATE TABLE IF NOT EXISTS staff_quick_locks (
  company_id INTEGER NOT NULL,
  phone_norm TEXT NOT NULL,
  request_key TEXT,
  staff_id INTEGER,                -- 作成済みのスタッフ（処理中は NULL）
  created_at INTEGER NOT NULL,     -- Date.now()（ミリ秒）
  PRIMARY KEY (company_id, phone_norm)
);
