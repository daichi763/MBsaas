-- シフトボードの表示と候補（w3-shift-board-ui）
-- 既存のデータは変えない（インデックスとテーブルの追加のみ）

-- #408 開催場所ごとのシフト件数の集計と、開催場所の削除時の使用中チェック（shifts・shift_slots の site_id を全件走査しないように）
CREATE INDEX IF NOT EXISTS idx_shifts_site ON shifts(site_id);
CREATE INDEX IF NOT EXISTS idx_shift_slots_site ON shift_slots(site_id);

-- #204 クライアントのNGスタッフの理由・登録日・登録者。
-- NG の判定は従来どおり clients.ng_staff_ids（カンマ区切り）を正とし、この表は画面に出す補足情報だけを持つ
-- （PUT /api/admin/clients/:id/ng-staff が ng_staff_ids と同時に書き換える。スタッフの統合時は統合先へ付け替える）
CREATE TABLE IF NOT EXISTS client_ng_staff (
  client_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  reason TEXT,
  created_by INTEGER,
  created_at DATETIME DEFAULT (datetime('now', '+9 hours')),
  PRIMARY KEY (client_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_client_ng_staff_staff ON client_ng_staff(company_id, staff_id);
