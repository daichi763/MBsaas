// =========================================================
// 割当可能なスタッフの条件と、シフトの重複チェック
//
// - assignableStaffSql: シフトに割り当てられるスタッフの条件（候補一覧などの SQL で使う）
//   在籍中（users.status='active'・在籍状況が退職でない・退職日を過ぎていない）、未統合、スキルシートのみでない
// - NG（クライアントのNGスタッフ）は案件ごとに ngStaffIds で取得し、呼び出し側で警告・除外する
// - findConflicts: 同じ人物の、自社と「直接連携した会社」のシフトから重なりを探す。
//   他社のシフトは会社名・案件名を返さず、conflictLabel で「他社の予定あり」と時間帯だけを表示する
//   （多段連携の雇用元や、同じ所属元から連携を受けた別の稼働先の会社名・予定が見えないようにする）
// =========================================================
import { JSON_IN, bindJsonArray } from './d1-chunk'

// 割当可能なスタッフの条件。onDate を渡すと、その日より前に退職日がある人を除く（退職日当日は稼働可）
export function assignableStaffSql(opts: { sp?: string; us?: string; onDate?: string | null } = {}): { sql: string; binds: any[] } {
  const sp = opts.sp || 'sp', us = opts.us || 'us'
  const w = [
    `COALESCE(${sp}.affiliation_type,'own_employee') != 'skillsheet_only'`,
    `${sp}.merged_into_staff_id IS NULL`,
    `COALESCE(${sp}.employment_status,'working') != 'retired'`,
    `${us}.status = 'active'`,
  ]
  const binds: any[] = []
  if (opts.onDate) { w.push(`(${us}.retired_at IS NULL OR ${us}.retired_at >= ?)`); binds.push(opts.onDate) }
  return { sql: w.join(' AND '), binds }
}

function parseIds(v: any): number[] { return String(v || '').split(',').map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0) }

// 案件のクライアントで NG に指定されたスタッフ
export async function ngStaffIds(db: D1Database, projectId: number): Promise<number[]> {
  const r = await db.prepare('SELECT cl.ng_staff_ids FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id WHERE p.project_id = ?').bind(projectId).first() as any
  return parseIds(r?.ng_staff_ids)
}

// ---------- 重複チェック ----------
function toMin(t: string): number { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
// 終了が開始以前なら翌日とみなす（日をまたぐ重複は w3 で共通の時刻関数に置き換える）
function spanMinutes(start: string, end: string): number { const s = toMin(start); let e = toMin(end); if (e <= s) e += 1440; return e - s }
function overlaps(aS: string, aE: string, bS: string, bE: string): boolean {
  const as = toMin(aS), ae = as + spanMinutes(aS, aE), bs = toMin(bS), be = bs + spanMinutes(bS, bE)
  return as < be && bs < ae
}

export type ConflictRow = {
  my_staff_id: number; shift_id: number; slot_role_id: number | null; staff_id: number; company_id: number
  work_date: string; start_time: string; end_time: string; status: string
  project_name: string | null // 自社のシフトのみ。他社は null
}

// 対象スタッフ（自社の staff_id）ごとに、期間内の重なり候補のシフトを返す。
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
    .bind(companyId, ids, companyId, from, to).all()).results as ConflictRow[]
  for (const r of rows) { const a = map.get(r.my_staff_id) || []; if (!a.some(x => x.shift_id === r.shift_id)) a.push(r); map.set(r.my_staff_id, a) }
  return map
}

export function conflictFor<T extends { work_date: string; start_time: string; end_time: string; shift_id: number }>(list: T[] | undefined, date: string, start: string, end: string, excludeShiftId?: number) {
  return (list || []).filter(x => x.work_date === date && x.shift_id !== excludeShiftId && overlaps(x.start_time, x.end_time, start, end))
}

// 画面・警告に出す文言（他社は会社名・案件名を出さない）
export function conflictLabel(x: { company_id: number; project_name?: string | null; start_time: string; end_time: string }, companyId: number): string {
  return (x.company_id === companyId ? (x.project_name || '自社のシフト') : '他社の予定あり') + ' ' + x.start_time + '〜' + x.end_time
}

// API で返す形（他社は shift_id・案件名を返さない）
export function conflictView(x: ConflictRow, companyId: number) {
  const own = x.company_id === companyId
  return {
    shift_id: own ? x.shift_id : null, work_date: x.work_date, start_time: x.start_time, end_time: x.end_time,
    project_name: own ? x.project_name : null, other_company: !own, label: conflictLabel(x, companyId),
  }
}
