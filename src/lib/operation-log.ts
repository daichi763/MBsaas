// シフト・募集枠・精算の操作履歴（#159。表は migrations/0084_audit_log.sql の operation_logs）。
// 使い方（1回の操作ごと）:
//   const op = opLog(db, u, 'update')
//   書き込みの batch の先頭に ...logShifts(op, [shiftId]) を入れて変更の前の値を残し、
//   単価の再計算などをすべて終えた後に await finishLog(op) で変更の後の値を入れる（値が変わらなかった行は消す）。
//   作成は書き込みの後に logShifts(op, ids, { created: true }) → finishLog(op)。
// 前後の値は D1 の中で json_object で作る（Worker の CPU を使わないように。まとめての確定・取り消しでも行ごとに残す）
import { chunk } from './d1-chunk'

export type OpEntity = 'shift' | 'slot'
export type OpCtx = { db: D1Database; companyId: number; actorId: number | null; action: string; key: string; at: string }

// 残す項目と画面に出す名前（シフト。s = shifts、cx = shift_cancellations）。
// D1 の SQL 関数の引数の上限（本番は 32。ローカルの wrangler dev は 127 まで通る）に収まるよう、
// json_object は 16 項目ずつに分けて作り、文字列としてつなぐ（snapSql）
const SHIFT_FIELDS: [string, string, string][] = [
  ['staff_id', 's.staff_id', 'スタッフ'], ['project_id', 's.project_id', '案件'], ['work_date', 's.work_date', '日付'],
  ['start_time', 's.start_time', '開始'], ['end_time', 's.end_time', '終了'], ['break_minutes', 's.break_minutes', '休憩（分）'],
  ['status', 's.status', '状態'], ['role', 's.role', '役割'], ['location', 's.location', '場所'], ['slot_role_id', 's.slot_role_id', '募集枠の役割'],
  ['memo', 's.memo', 'メモ'],
  ['bill_unit_type', 's.bill_unit_type', '請求の単位'], ['bill_rate', 's.bill_rate', '請求単価'], ['bill_qty', 's.bill_qty', '請求の数量'],
  ['unit_price', 's.unit_price', '請求額'], ['pay_unit_type', 's.pay_unit_type', '支払の単位'], ['pay_rate', 's.pay_rate', '支払単価'],
  ['pay_qty', 's.pay_qty', '支払の数量'], ['pay_amount', 's.pay_amount', '支払額'], ['transportation_fee', 's.transportation_fee', '交通費（実費）'],
  ['bill_transport_type', 's.bill_transport_type', '交通費の請求の方法'], ['bill_transport_amount', 's.bill_transport_amount', '交通費の請求額'],
  ['pay_transport_type', 's.pay_transport_type', '交通費の支払の方法'], ['pay_transport_amount', 's.pay_transport_amount', '交通費の支払額'],
  ['bill_adjust', 's.bill_adjust', '請求の調整'], ['pay_adjust', 's.pay_adjust', '支払の調整'], ['adjust_note', 's.adjust_note', '調整の内容'],
  ['payee_type', 's.payee_type', '支払先'], ['price_locked', 's.price_locked', '金額の手動変更'],
  // 確定の時点で記録する割増（#167。w6-premium-pay の 0082）
  ['pay_premium', 's.pay_premium', '割増額'], ['premium_night_minutes', 's.premium_night_minutes', '深夜の時間（分）'],
  ['premium_overtime_minutes', 's.premium_overtime_minutes', '時間外の時間（分）'], ['premium_holiday_minutes', 's.premium_holiday_minutes', '休日の時間（分）'],
  ['actual_start', 's.actual_start', '実績の開始'], ['actual_end', 's.actual_end', '実績の終了'], ['actual_break_minutes', 's.actual_break_minutes', '実績の休憩（分）'],
  ['actual_source', 's.actual_source', '実績の入力元'], ['actual_note', 's.actual_note', '実績のメモ'],
  ['settle_status', 's.settle_status', '精算'], ['settled_at', 's.settled_at', '確定日時'], ['settled_by', 's.settled_by', '確定した人'],
  // 前日確認（#176。w6-staff-app-features の 0083）
  ['day_before_confirmed_at', 's.day_before_confirmed_at', '前日確認'], ['day_before_confirmed_by', 's.day_before_confirmed_by', '前日確認を記録した管理者'],
  ['cancel_reason', 'cx.reason', '欠勤・中止の理由'], ['cancel_notified_on', 'cx.notified_on', '欠勤・中止の連絡日'],
  ['cancel_bill', 'cx.bill_amount', 'キャンセル料（請求）'], ['cancel_pay', 'cx.pay_amount', '補償・控除（支払）'], ['cancel_note', 'cx.note', 'キャンセルのメモ'],
]
const SLOT_FIELDS: [string, string, string][] = [
  ['project_id', 'sl.project_id', '案件'], ['site_id', 'sl.site_id', '開催場所'], ['location', 'sl.location', '場所'], ['work_date', 'sl.work_date', '日付'],
  ['start_time', 'sl.start_time', '開始'], ['end_time', 'sl.end_time', '終了'], ['break_minutes', 'sl.break_minutes', '休憩（分）'],
  ['memo', 'sl.memo', 'メモ'], ['status', 'sl.status', '募集の状態'],
  // 役割（名前・人数・枠の単価）。サブクエリの結果は JSON の型が外れるので json() で戻す
  ['roles', `json((SELECT json_group_array(json_object('slot_role_id', r.slot_role_id, 'role_name', r.role_name, 'headcount', r.headcount,
    'bill_unit_type', r.bill_unit_type, 'bill_rate', r.bill_rate, 'pay_unit_type', r.pay_unit_type, 'pay_rate', r.pay_rate))
    FROM (SELECT * FROM shift_slot_roles WHERE slot_id = sl.slot_id ORDER BY sort_order, slot_role_id) r))`, '役割'],
]
const SNAP_GROUP = 16
const snapSql = (fields: [string, string, string][]) => {
  const groups: string[] = []
  for (let i = 0; i < fields.length; i += SNAP_GROUP) groups.push(`json_object(${fields.slice(i, i + SNAP_GROUP).map(([k, expr]) => `'${k}', ${expr}`).join(', ')})`)
  if (groups.length === 1) return groups[0]
  // 各組の外側の括弧を外してつなぐ（値に入れ子のオブジェクトはないので、各組は '{' で始まり '}' で終わる）
  return groups.map((g, i) => i === 0 ? `substr(${g}, 1, length(${g}) - 1)` : i === groups.length - 1 ? `substr(${g}, 2)` : `substr(${g}, 2, length(${g}) - 2)`).join(" || ',' || ")
}
const SHIFT_SNAP = snapSql(SHIFT_FIELDS)
const SLOT_SNAP = snapSql(SLOT_FIELDS)
const SHIFT_FROM = 'shifts s LEFT JOIN shift_cancellations cx ON cx.shift_id = s.shift_id'

export const OP_FIELD_LABELS: Record<OpEntity, Record<string, string>> = {
  shift: Object.fromEntries(SHIFT_FIELDS.map(([k, , l]) => [k, l])),
  slot: Object.fromEntries(SLOT_FIELDS.map(([k, , l]) => [k, l])),
}
export const OP_ACTION_LABELS: Record<string, string> = {
  create: '登録', update: '変更', delete: '削除', assign: '割り当て', move: '移動', confirm_requested: '希望（仮）を確定',
  release: '今後のシフトの取り外し', price: '金額の変更', price_reset: '金額をルールに戻す', reprice: '単価ルールの再適用',
  slot_update: '枠の変更', slot_delete: '枠の削除', actual: '実績の入力', actual_reset: '実績を報告に戻す',
  settle_confirm: '精算の確定', settle_unconfirm: '精算の確定の取り消し', recalc: '金額の再計算', cancellation: 'キャンセル料・補償の入力',
  cancellation_remove: 'キャンセル料・補償の取り消し', transport_fill: '交通費を標準で埋める',
  bulk_create: '常勤の一括登録', copy_week: '前週のコピー', recruit_approve: '募集の承認',
}

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function newKey(): string { const a = new Uint8Array(9); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join('') }

/** 1回の操作の記録の準備（u はログイン中の管理者） */
export function opLog(db: D1Database, u: { company_id: number; user_id: number }, action: string): OpCtx {
  return { db, companyId: Number(u.company_id), actorId: u.user_id ?? null, action, key: newKey(), at: nowJST() }
}

/**
 * シフトの変更の前の値を残す文（書き込みと同じ batch の、書き込みより前に入れる）。
 * where は shifts（別名 s）への追加の条件（実際に変わる行だけを残すため。例: 未確定のものだけ）。
 * created: true は作成の後に呼び、前の値なしで残す
 */
export function logShifts(op: OpCtx, ids: Iterable<number>, o: { where?: string; created?: boolean } = {}): D1PreparedStatement[] {
  const list = [...new Set([...ids].map(Number).filter(n => Number.isInteger(n) && n > 0))]
  return chunk(list, 500).map(part => op.db.prepare(`INSERT INTO operation_logs (company_id, entity, entity_id, staff_id, action, before_json, actor_user_id, op_key, created_at)
    SELECT s.company_id, 'shift', s.shift_id, s.staff_id, ?, ${o.created ? 'NULL' : SHIFT_SNAP}, ?, ?, ?
    FROM ${SHIFT_FROM} WHERE s.company_id = ? AND s.shift_id IN (SELECT value FROM json_each(?))${o.where ? ` AND (${o.where})` : ''}`)
    .bind(op.action, op.actorId, op.key, op.at, op.companyId, JSON.stringify(part)))
}

/** 募集枠に割り当てたシフトの変更の前の値を残す文（枠の削除で枠から外すときなど） */
export function logShiftsOfSlot(op: OpCtx, slotId: number): D1PreparedStatement {
  return op.db.prepare(`INSERT INTO operation_logs (company_id, entity, entity_id, staff_id, action, before_json, actor_user_id, op_key, created_at)
    SELECT s.company_id, 'shift', s.shift_id, s.staff_id, ?, ${SHIFT_SNAP}, ?, ?, ? FROM ${SHIFT_FROM} WHERE s.company_id = ? AND s.slot_id = ?`)
    .bind(op.action, op.actorId, op.key, op.at, op.companyId, Number(slotId))
}

/** 募集枠（役割を含む）の変更の前の値を残す文 */
export function logSlot(op: OpCtx, slotId: number): D1PreparedStatement {
  return op.db.prepare(`INSERT INTO operation_logs (company_id, entity, entity_id, staff_id, action, before_json, actor_user_id, op_key, created_at)
    SELECT sl.company_id, 'slot', sl.slot_id, NULL, ?, ${SLOT_SNAP}, ?, ?, ? FROM shift_slots sl WHERE sl.slot_id = ? AND sl.company_id = ?`)
    .bind(op.action, op.actorId, op.key, op.at, Number(slotId), op.companyId)
}

/** 変更の後の値を入れる文（消えた行は NULL）。前後で値が同じ行（実際には変わらなかった行）は消す */
export function finishLogStmts(op: OpCtx): D1PreparedStatement[] {
  const db = op.db
  return [
    db.prepare(`UPDATE operation_logs SET
        after_json = (SELECT ${SHIFT_SNAP} FROM ${SHIFT_FROM} WHERE s.shift_id = operation_logs.entity_id AND s.company_id = operation_logs.company_id),
        staff_id = COALESCE((SELECT s.staff_id FROM shifts s WHERE s.shift_id = operation_logs.entity_id AND s.company_id = operation_logs.company_id), staff_id)
      WHERE op_key = ? AND entity = 'shift'`).bind(op.key),
    db.prepare(`UPDATE operation_logs SET after_json = (SELECT ${SLOT_SNAP} FROM shift_slots sl WHERE sl.slot_id = operation_logs.entity_id AND sl.company_id = operation_logs.company_id)
      WHERE op_key = ? AND entity = 'slot'`).bind(op.key),
    db.prepare('DELETE FROM operation_logs WHERE op_key = ? AND before_json IS after_json').bind(op.key),
  ]
}
export async function finishLog(op: OpCtx): Promise<void> {
  await op.db.batch(finishLogStmts(op))
}

export type OpChange = { field: string; label: string; before: unknown; after: unknown }
function parse(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || !v) return null
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null } catch { return null }
}
/** 前後の値から、変わった項目の一覧を作る（作成は値のある項目、削除は前の値のある項目） */
export function opChanges(entity: string, beforeJson: unknown, afterJson: unknown): { before: Record<string, unknown> | null; after: Record<string, unknown> | null; changes: OpChange[] } {
  const before = parse(beforeJson), after = parse(afterJson)
  const labels = OP_FIELD_LABELS[entity as OpEntity] || {}
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
  const changes: OpChange[] = []
  for (const k of keys) {
    const b = before ? before[k] ?? null : null, a = after ? after[k] ?? null : null
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    changes.push({ field: k, label: labels[k] || k, before: b, after: a })
  }
  return { before, after, changes }
}
