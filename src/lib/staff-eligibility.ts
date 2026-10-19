// =========================================================
// 割当可能なスタッフの条件と、シフトの重複チェック
//
// - assignableStaffSql: シフトに割り当てられるスタッフの条件（候補一覧などの SQL で使う）
//   在籍中（users.status='active'・在籍状況が退職でない・退職日を過ぎていない）、未統合、スキルシートのみでない。
//   他社連携の行は、稼働先で「取引終了」にしていないこと、所属元（雇用元）で退職・停止になっていないこと
// - assertAssignable: すべての割当経路（シフト登録・付け替え・シフトボードの割当と移動）から呼ぶ1つの確認関数。
//   割り当てられない理由（error）と、確認のうえ続けられる警告（warnings: 重複・NG・休職中・同じ枠に割当済み）を返す
// - NG（クライアントのNGスタッフ）は案件ごとに ngStaffIds で取得し、呼び出し側で警告・除外する
// - findConflicts: 同じ人物の、自社と「直接連携した会社」のシフトから重なりを探す。
//   他社のシフトは会社名・案件名を返さず、conflictLabel で「他社の予定あり」と時間帯だけを表示する
//   （多段連携の雇用元や、同じ所属元から連携を受けた別の稼働先の会社名・予定が見えないようにする）
// =========================================================
import { JSON_IN, bindJsonArray } from './d1-chunk'
import { addDays, overlaps, shiftWindow } from './shift-time'

// 割当可能なスタッフの条件。onDate を渡すと、その日より前に退職日がある人を除く（退職日当日は稼働可）
export function assignableStaffSql(opts: { sp?: string; us?: string; onDate?: string | null } = {}): { sql: string; binds: any[] } {
  const sp = opts.sp || 'sp', us = opts.us || 'us'
  const w = [
    `COALESCE(${sp}.affiliation_type,'own_employee') != 'skillsheet_only'`,
    `${sp}.merged_into_staff_id IS NULL`,
    `COALESCE(${sp}.employment_status,'working') != 'retired'`,
    `${us}.status = 'active'`,
    `${sp}.link_ended_at IS NULL`,
  ]
  const binds: any[] = []
  if (opts.onDate) { w.push(`(${us}.retired_at IS NULL OR ${us}.retired_at >= ?)`); binds.push(opts.onDate) }
  // 他社連携の行は、所属元（雇用元）の行の在籍状況も見る（所属元で退職にしても、連携行は在職中のまま残るため）
  w.push(`NOT EXISTS (SELECT 1 FROM staff_profiles emp_sp JOIN users emp_us ON emp_us.user_id = emp_sp.user_id
    WHERE ${sp}.affiliation_type = 'linked_external' AND emp_sp.staff_id = COALESCE(${sp}.root_staff_id, ${sp}.source_staff_id)
      AND (COALESCE(emp_sp.employment_status,'working') = 'retired' OR emp_us.status != 'active'${opts.onDate ? ' OR emp_us.retired_at < ?' : ''}))`)
  if (opts.onDate) binds.push(opts.onDate)
  return { sql: w.join(' AND '), binds }
}

function parseIds(v: any): number[] { return String(v || '').split(',').map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0) }

// 一意制約の違反（同じ枠への二重割当など）かどうか
export function isUniqueViolation(e: any): boolean {
  return /UNIQUE constraint failed/i.test(String((e && (e.message || e.cause?.message)) || e))
}

// ---------- 割当の確認（すべての割当経路で使う） ----------
export type AssignTarget = {
  companyId: number
  project: { project_id: number } | number        // 案件の行または ID（自社の案件であることは呼び出し側で確認済み）
  slot?: { slot_role_id?: number | null } | null  // 枠の役割（枠なしのシフトは null）
  staffId?: number; staffIds?: number[]
  workDate: string; start: string; end: string
  excludeShiftId?: number                         // 移動・付け替えのとき、そのシフト自身は重複から除く
}
export type AssignCheck = {
  status: 200 | 400 | 404
  error?: string             // 割り当てられない（force でも続けられない）
  warnings: string[]         // 確認のうえ force で続けられる
  staff: { staff_id: number; name: string; affiliation_type: string; employment_status: string }[]
  already: Set<number>       // 同じ枠の役割に割り当て済みのスタッフ（新しく作らない）
}

// 割り当てられるかを確認する。
//   error   : 自社のスタッフでない・スキルシートのみ・統合済み・退職（ログイン停止・稼働日が退職日より後）・
//             稼働先で取引終了・所属元で退職、移動先の枠に割り当て済み（移動・付け替えのとき）
//   warnings: 同じ枠に割り当て済み・同じ時間帯の別のシフト・クライアントのNG・休職中
//   error には、終了した案件（#153）も含む
// 案件の条件（終了した案件など）を足すときは、この関数の中に足す（各経路のハンドラーは変えない）
export async function assertAssignable(db: D1Database, t: AssignTarget): Promise<AssignCheck> {
  const projectId = typeof t.project === 'number' ? t.project : Number(t.project?.project_id)
  const staffIds = [...new Set([...(t.staffIds || []), ...(t.staffId != null ? [t.staffId] : [])].map(Number).filter(n => Number.isInteger(n) && n > 0))]
  const out: AssignCheck = { status: 200, warnings: [], staff: [], already: new Set() }
  if (!staffIds.length) return { ...out, status: 400, error: 'スタッフを選択してください' }
  // 終了した案件には新しいシフトを入れない（#153。案件詳細で「稼働中に戻す」と割り当てられる）
  if (projectId) {
    const pj = await db.prepare('SELECT status FROM projects WHERE project_id = ?').bind(projectId).first() as any
    if (pj && (pj.status || 'active') !== 'active') return { ...out, status: 400, error: '終了した案件のため、シフトを登録・変更できません（案件詳細で「稼働中に戻す」と登録できます）' }
  }
  const rows = (await db.prepare(`
    SELECT sp.staff_id, us.name, us.status AS user_status, us.retired_at, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type,
      sp.merged_into_staff_id, COALESCE(sp.employment_status,'working') AS employment_status, sp.link_ended_at,
      COALESCE(emp_sp.employment_status,'working') AS emp_status, emp_us.status AS emp_user_status, emp_us.retired_at AS emp_retired_at
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles emp_sp ON sp.affiliation_type = 'linked_external' AND emp_sp.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN users emp_us ON emp_us.user_id = emp_sp.user_id
    WHERE sp.company_id = ? AND sp.staff_id IN ${JSON_IN}`).bind(t.companyId, bindJsonArray(staffIds)).all()).results as any[]
  if (rows.length !== staffIds.length) return { ...out, status: 404, error: 'スタッフが見つかりません' }
  out.staff = rows.map(r => ({ staff_id: r.staff_id, name: r.name, affiliation_type: r.affiliation_type, employment_status: r.employment_status }))

  const errors: string[] = []
  for (const r of rows) {
    if (r.affiliation_type === 'skillsheet_only') errors.push(`${r.name}: スキルシートのみ作成のスタッフにはシフトを登録できません`)
    else if (r.merged_into_staff_id) errors.push(`${r.name}: 統合済みのスタッフにはシフトを登録できません（統合先のスタッフを選んでください）`)
    // 所属元での退職は連携行にも伝わる（roster.ts の propagateRetirementStmts）ため、連携行自身の退職より先に見て理由を示す
    else if (r.affiliation_type === 'linked_external' && r.emp_user_status != null
      && (r.emp_status === 'retired' || r.emp_user_status !== 'active' || (r.emp_retired_at && r.emp_retired_at < t.workDate)))
      errors.push(`${r.name}: 所属元で退職になっているため、シフトを登録できません`)
    else if (r.employment_status === 'retired' || r.user_status !== 'active' || (r.retired_at && r.retired_at < t.workDate))
      errors.push(`${r.name}: 退職（または退職日より後の日付）のため、シフトを登録できません`)
    else if (r.link_ended_at) errors.push(`${r.name}: 取引終了にしたスタッフです（スタッフ詳細の「取引状況」を戻すと割り当てられます）`)
  }
  if (errors.length) return { ...out, status: 400, error: errors.join('\n') }

  const slotRoleId = t.slot?.slot_role_id || null
  if (slotRoleId) {
    const q = (await db.prepare(`SELECT staff_id FROM shifts WHERE slot_role_id = ? AND status != 'absent' AND staff_id IN ${JSON_IN}${t.excludeShiftId ? ' AND shift_id != ?' : ''}`)
      .bind(slotRoleId, bindJsonArray(staffIds), ...(t.excludeShiftId ? [t.excludeShiftId] : [])).all()).results as any[]
    for (const r of q) out.already.add(r.staff_id)
    // 移動・付け替えでは、同じ枠に同じ人を2件にできない
    if (t.excludeShiftId && out.already.size) return { ...out, status: 400, error: 'このスタッフはすでに移動先の枠に割り当て済みです' }
  }
  const conflicts = await findConflicts(db, t.companyId, staffIds, t.workDate, t.workDate)
  const ng = projectId ? await ngStaffIds(db, projectId) : []
  for (const r of rows) {
    if (out.already.has(r.staff_id)) out.warnings.push(`${r.name}: すでにこの枠に割り当て済みです`)
    const cf = conflictFor(conflicts.get(r.staff_id), t.workDate, t.start, t.end, t.excludeShiftId)
    if (cf.length) out.warnings.push(`${r.name}: 同じ時間帯に別のシフトがあります（${cf.map(x => conflictLabel(x, t.companyId)).join('、')}）`)
    if (ng.includes(r.staff_id)) out.warnings.push(`${r.name}: クライアントのNGスタッフに指定されています`)
    if (r.employment_status === 'leave') out.warnings.push(`${r.name}: 休職中です`)
  }
  return out
}

// 案件のクライアントで NG に指定されたスタッフ
export async function ngStaffIds(db: D1Database, projectId: number): Promise<number[]> {
  const r = await db.prepare('SELECT cl.ng_staff_ids FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id WHERE p.project_id = ?').bind(projectId).first() as any
  return parseIds(r?.ng_staff_ids)
}

// ---------- 重複チェック ----------
// 稼働日＋時刻の絶対日時（lib/shift-time.ts の shiftWindow。終了が開始以前なら翌日）で重なりを判定する。
// 日をまたぐ勤務（22:00〜06:00）と翌日の早朝の勤務のように、稼働日が違うシフトどうしの重なりも見る（#77）
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)

export type ConflictRow = {
  my_staff_id: number; shift_id: number; slot_role_id: number | null; staff_id: number; company_id: number
  work_date: string; start_time: string; end_time: string; status: string
  project_name: string | null // 自社のシフトのみ。他社は null
}

// 対象スタッフ（自社の staff_id）ごとに、期間内の重なり候補のシフトを返す。
// 日をまたぐ勤務と重なるよう、期間の前日・翌日のシフトも返す（どれが重なるかは conflictFor で判定する）。
// 調べる範囲: 自社の行（同じ人物の自社の別の行を含む）、連携元の行（source_staff_id）、自社の行から連携した先の行。
// 直接連携していない会社（多段連携の雇用元・同じ所属元から連携を受けた別の稼働先）のシフトは対象にしない。
export async function findConflicts(db: D1Database, companyId: number, staffIds: number[], from: string, to: string) {
  const map = new Map<number, ConflictRow[]>()
  const ids = bindJsonArray(staffIds)
  if (ids === '[]') return map
  const rows = (await db.prepare(`
    WITH me AS (
      SELECT staff_id, company_id, person_id, source_staff_id FROM staff_profiles WHERE company_id = ? AND staff_id IN ${JSON_IN}
    ), rel AS (
      SELECT me.staff_id AS my_staff_id, me.staff_id AS staff_id FROM me
      UNION SELECT me.staff_id, sp.staff_id FROM me JOIN staff_profiles sp ON sp.person_id = me.person_id AND sp.company_id = me.company_id WHERE me.person_id IS NOT NULL
      UNION SELECT me.staff_id, me.source_staff_id FROM me WHERE me.source_staff_id IS NOT NULL
      UNION SELECT me.staff_id, sp.staff_id FROM me JOIN staff_profiles sp ON sp.source_staff_id = me.staff_id
    )
    SELECT rel.my_staff_id, s.shift_id, s.slot_role_id, s.staff_id, s.company_id, s.work_date, s.start_time, s.end_time, s.status,
      CASE WHEN s.company_id = ? THEN p.project_name END AS project_name
    FROM rel JOIN shifts s ON s.staff_id = rel.staff_id
    LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE s.work_date BETWEEN ? AND ? AND s.status IN ('requested','confirmed','substitute')`)
    .bind(companyId, ids, companyId, addDays(from, -1), addDays(to, 1)).all()).results as ConflictRow[]
  for (const r of rows) { const a = map.get(r.my_staff_id) || []; if (!a.some(x => x.shift_id === r.shift_id)) a.push(r); map.set(r.my_staff_id, a) }
  return map
}

// date の start〜end と時間が重なるシフト。day_offset は相手の稼働日のずれ（-1 = 前日、1 = 翌日）
export function conflictFor<T extends { work_date: string; start_time: string; end_time: string; shift_id: number }>(list: T[] | undefined, date: string, start: string, end: string, excludeShiftId?: number): (T & { day_offset: number })[] {
  const w = shiftWindow(date, start, end)
  return (list || []).filter(x => x.shift_id !== excludeShiftId && overlaps(shiftWindow(x.work_date, x.start_time, x.end_time), w))
    .map(x => ({ ...x, day_offset: dayDiff(date, x.work_date) }))
}

// 画面・警告に出す文言（他社は会社名・案件名を出さない）
// 稼働日が違うシフト（conflictFor の day_offset）は『前日』『翌日』を付ける
export function conflictLabel(x: { company_id: number; project_name?: string | null; start_time: string; end_time: string; day_offset?: number }, companyId: number): string {
  const day = x.day_offset === -1 ? '前日 ' : x.day_offset === 1 ? '翌日 ' : ''
  return (x.company_id === companyId ? (x.project_name || '自社のシフト') : '他社の予定あり') + ' ' + day + x.start_time + '〜' + x.end_time
}

// API で返す形（他社は shift_id・案件名を返さない）
export function conflictView(x: ConflictRow & { day_offset?: number }, companyId: number) {
  const own = x.company_id === companyId
  return {
    shift_id: own ? x.shift_id : null, work_date: x.work_date, start_time: x.start_time, end_time: x.end_time,
    project_name: own ? x.project_name : null, other_company: !own, day_offset: x.day_offset ?? 0, label: conflictLabel(x, companyId),
  }
}
