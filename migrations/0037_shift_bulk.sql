-- 0037: シフトの一括処理（w2-shift-bulk #78）
-- 前週コピーで作った枠・役割・シフトに、コピー元のIDを記録する。
-- コピーをやり直したとき（途中で止まった後・二度押し）に、同じ枠・シフトを二重に作らないようにする。
-- 列と索引の追加のみ。既存の行はすべて NULL のままで、動作は変わらない。

ALTER TABLE shift_slots ADD COLUMN source_slot_id INTEGER;          -- コピー元の枠
ALTER TABLE shift_slot_roles ADD COLUMN source_slot_role_id INTEGER; -- コピー元の役割
ALTER TABLE shifts ADD COLUMN source_shift_id INTEGER;              -- コピー元のシフト

-- 同じコピー元から同じ日に作るのは1つだけ（コピーは INSERT OR IGNORE で行い、同時に実行しても二重にならない）
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_slots_source ON shift_slots(source_slot_id, work_date) WHERE source_slot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_slot_roles_source ON shift_slot_roles(slot_id, source_slot_role_id) WHERE source_slot_role_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_source ON shifts(source_shift_id, work_date) WHERE source_shift_id IS NOT NULL;
