-- 0045: 単価の解決と時間計算（w3-pricing #144 #145 #196 #210 #220）
-- 列・表の追加と、既存の金額を変えないための値の補いのみ。既存の行の意味は変えない。

-- ---------- #210 単価ルールの適用期間（NULL = 期限なし。シフトの稼働日で選ぶ） ----------
ALTER TABLE rate_rules ADD COLUMN valid_from DATE;
ALTER TABLE rate_rules ADD COLUMN valid_to DATE;

-- ---------- #210 案件の標準単価の適用開始日と、改定前の標準単価 ----------
-- projects の標準単価は price_valid_from（NULL = すべての期間）以降に使う。それより前の稼働日は project_price_history の期間で選ぶ
ALTER TABLE projects ADD COLUMN price_valid_from DATE;
CREATE TABLE IF NOT EXISTS project_price_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  valid_from DATE,                               -- NULL = 最初から
  valid_to DATE NOT NULL,                        -- この日まで（この日を含む）
  unit_price_type TEXT,
  unit_price INTEGER,
  pay_unit_type TEXT,
  pay_rate INTEGER,
  bill_transport_type TEXT,
  bill_transport_amount INTEGER,
  pay_transport_type TEXT,
  pay_transport_amount INTEGER,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_project_price_history ON project_price_history(company_id, project_id, valid_to);

-- ---------- #220 支払側の時刻の丸め ----------
-- none: 支払は丸めない（1分単位。新しい案件の既定）/ same: 請求と同じく丸める
-- すでに丸めを設定している案件は、未確定のシフトの金額が黙って変わらないよう same にしておく（画面で none に変えられる）
ALTER TABLE projects ADD COLUMN pay_time_round TEXT DEFAULT 'none';
UPDATE projects SET pay_time_round = 'same' WHERE COALESCE(time_round_minutes, 0) > 0;

-- ---------- #196 数量の固定（単価の固定 price_locked と分ける） ----------
-- 1 = 数量も手動で固定 / 0 = 単価だけ固定し、時給の数量は実働に合わせる / NULL = 従来の行（price_locked なら数量も固定）
ALTER TABLE shifts ADD COLUMN qty_locked INTEGER;

-- ---------- #144 単価ルールの照合に使う役割名 ----------
-- 枠の役割の名前を変えても、単価ルールを今の役割名のまま当てたいときに、変更前の名前を残す（NULL = role_name で照合）
ALTER TABLE shift_slot_roles ADD COLUMN rate_role_name TEXT;

-- ---------- #145 単位のない枠の役割の単価に、今まで使われていた単位を補う ----------
-- これまでは単位が空だと案件・単価ルールの単位を引き継いでいた。割り当て済みのシフトに枠の単価で記録した単位があればそれを、
-- なければ案件の標準の単位を入れる（以後、単位のない単価は受け付けず、省略したら日額にする）
UPDATE shift_slot_roles SET bill_unit_type = COALESCE(
    (SELECT s.bill_unit_type FROM shifts s WHERE s.slot_role_id = shift_slot_roles.slot_role_id AND s.bill_unit_type IN ('daily','hourly')
       AND CASE WHEN json_valid(s.price_source) THEN json_extract(s.price_source, '$.bill') END = '枠の単価' ORDER BY s.shift_id DESC LIMIT 1),
    (SELECT CASE WHEN p.unit_price_type = 'hourly' THEN 'hourly' ELSE 'daily' END FROM shift_slots sl JOIN projects p ON p.project_id = sl.project_id WHERE sl.slot_id = shift_slot_roles.slot_id),
    'daily')
  WHERE bill_rate IS NOT NULL AND bill_unit_type IS NULL;
UPDATE shift_slot_roles SET pay_unit_type = COALESCE(
    (SELECT s.pay_unit_type FROM shifts s WHERE s.slot_role_id = shift_slot_roles.slot_role_id AND s.pay_unit_type IN ('daily','hourly')
       AND CASE WHEN json_valid(s.price_source) THEN json_extract(s.price_source, '$.pay') END = '枠の単価' ORDER BY s.shift_id DESC LIMIT 1),
    (SELECT CASE WHEN p.pay_unit_type = 'hourly' THEN 'hourly' ELSE 'daily' END FROM shift_slots sl JOIN projects p ON p.project_id = sl.project_id WHERE sl.slot_id = shift_slot_roles.slot_id),
    'daily')
  WHERE pay_rate IS NOT NULL AND pay_unit_type IS NULL;
