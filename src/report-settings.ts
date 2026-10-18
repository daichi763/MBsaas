// =========================================================
// 案件報告管理（勤怠報告 8 種類の ON/OFF・一括変更・変更履歴）
// docs/spec_attendance_correction.md 2章・3章
//
// 有効な報告の決め方（シフトごと）:
//   1. シフトの例外 shifts.attendance_mode（none = なし / in_out = 入店・退店のみ / full・NULL = 2 以降に従う）
//   2. 案件 × スタッフ別の設定（project_staff_report_settings）
//   3. 案件 × スタッフ別の行がない組み合わせは、0027 より前のスタッフ単位の設定（staff_profiles.attendance_mode の none / in_out）
//   4. 案件の標準設定（project_report_defaults）
//   5. いずれもなければ ON
//   報告を始めた後に設定が変わったシフトは、変わる前に OFF だった報告を ON にしない（shifts.attendance_types_fixed。ON にした報告は次のシフトから効く。#458）
// 報告の順序: 有効な報告は REPORT_TYPES の順に押す。前の報告を飛ばして後の報告を押すことはできる（飛ばした報告は打刻修正の申請で追加する）。
//   後の報告が済んだ後に、それより前の報告を今の時刻で押すことはできない（checkReportable）
// 管理者向け API（/api/admin/report-settings/*）は api.ts から権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'
import { toCsv, csvResponse } from './csv'
import { NEXT_DAY_TYPES, addDays, reportableWindow, type ShiftTimes } from './lib/shift-time'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// 報告の順序（この順に日時が並ぶ）
export const REPORT_TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'] as const
export const REPORT_LABEL: Record<string, string> = {
  wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始',
  break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告',
}
// 稼働日の翌日も受け付ける報告（日をまたぐ勤務）。受付の時間帯は lib/shift-time.ts の reportableWindow
export { NEXT_DAY_TYPES }
// 実績（実働・休憩）に関わる報告。登録・変更のたびに syncActualFromReports を呼ぶ
export const ACTUAL_SYNC_TYPES = ['check_in', 'check_out', 'work_start', 'work_end', 'break_start', 'break_end']

export const isReportType = (t: any): t is string => typeof t === 'string' && (REPORT_TYPES as readonly string[]).includes(t)

// 旧来の提出設定（none / in_out / full）を 8 種類の ON/OFF に置き換える
export function flagsFromLegacyMode(mode: any): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of REPORT_TYPES) out[t] = mode === 'none' ? 0 : mode === 'in_out' ? (t === 'check_in' || t === 'check_out' ? 1 : 0) : 1
  return out
}

export type AttendanceSource = 'shift' | 'staff' | 'project' | 'default'
export type ShiftAttendance = { types: string[]; source: AttendanceSource }

// 0027 より前のスタッフ単位の提出設定のうち、案件 × スタッフ別の行がない組み合わせに引き継ぐ値（none / in_out のみ。full は案件の標準設定に従う）
export function legacyStaffFlags(mode: any): Record<string, number> | null {
  return mode === 'none' || mode === 'in_out' ? flagsFromLegacyMode(mode) : null
}
// shifts.attendance_types_fixed（JSON 配列）を REPORT_TYPES の順の配列にする。壊れていれば null
function parseFixedTypes(v: any): string[] | null {
  if (typeof v !== 'string' || !v) return null
  try {
    const a = JSON.parse(v)
    return Array.isArray(a) ? REPORT_TYPES.filter(t => a.includes(t)) : null
  } catch { return null }
}

// シフトごとに有効な報告（REPORT_TYPES の順）を返す
export async function attendanceTypesForShifts(db: D1Database, shiftIds: number[]): Promise<Map<number, ShiftAttendance>> {
  const map = new Map<number, ShiftAttendance>()
  const ids = [...new Set(shiftIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const shifts = (await db.prepare(`SELECT s.shift_id, s.project_id, s.staff_id, s.attendance_mode, s.attendance_types_fixed, sp.attendance_mode AS legacy_mode
      FROM shifts s LEFT JOIN staff_profiles sp ON sp.staff_id = s.staff_id WHERE s.shift_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all()).results as any[]
    const projectIds = [...new Set(shifts.map(s => s.project_id))]
    const staffIds = [...new Set(shifts.map(s => s.staff_id))]
    const defaults = new Map<string, number>()
    const personal = new Map<string, number>()
    const hasPersonal = new Set<string>()
    if (projectIds.length) {
      const q = projectIds.map(() => '?').join(',')
      for (const r of (await db.prepare(`SELECT project_id, report_type, enabled FROM project_report_defaults WHERE project_id IN (${q})`).bind(...projectIds).all()).results as any[]) {
        defaults.set(`${r.project_id}:${r.report_type}`, r.enabled)
      }
      // バインド変数は 1 文 100 個までのため、スタッフで絞って案件は手元で照合する
      const pset = new Set(projectIds)
      for (const r of (await db.prepare(`SELECT project_id, staff_id, report_type, enabled FROM project_staff_report_settings WHERE staff_id IN (${staffIds.map(() => '?').join(',')})`)
        .bind(...staffIds).all()).results as any[]) {
        if (!pset.has(r.project_id)) continue
        personal.set(`${r.project_id}:${r.staff_id}:${r.report_type}`, r.enabled)
        hasPersonal.add(`${r.project_id}:${r.staff_id}`)
      }
    }
    for (const s of shifts) map.set(s.shift_id, resolveAttendanceTypes(s, defaults, personal, hasPersonal))
  }
  return map
}

// 1つのシフトの有効な報告を決める（attendanceTypesForShifts・attendanceTypesForRows で共用）。
// s は shift_id, project_id, staff_id, attendance_mode（シフトの例外）, attendance_types_fixed, legacy_mode（staff_profiles.attendance_mode）
function resolveAttendanceTypes(s: any, defaults: Map<string, number>, personal: Map<string, number>, hasPersonal: Set<string>): ShiftAttendance {
  if (s.attendance_mode === 'none') return { types: [], source: 'shift' }
  if (s.attendance_mode === 'in_out') return { types: ['check_in', 'check_out'], source: 'shift' }
  const fixed = parseFixedTypes(s.attendance_types_fixed)
  const legacy = hasPersonal.has(`${s.project_id}:${s.staff_id}`) ? null : legacyStaffFlags(s.legacy_mode)
  let source: AttendanceSource = legacy ? 'staff' : 'default'
  const types = REPORT_TYPES.filter(t => {
    const pv = personal.get(`${s.project_id}:${s.staff_id}:${t}`)
    if (pv !== undefined) { source = 'staff'; return !!pv }
    if (legacy) return !!legacy[t]
    const dv = defaults.get(`${s.project_id}:${t}`)
    if (dv !== undefined) { if (source === 'default') source = 'project'; return !!dv }
    return true
  })
  // 報告を始めた後に設定が変わったシフトは、変わる前に OFF だった報告を ON にしない（OFF にした報告はすぐ外す。docs 2.7）
  return { types: fixed ? types.filter(t => fixed.includes(t)) : types, source }
}

// シフトの行を読み済みのとき（精算の一覧など件数の多い一覧）に、有効な報告をまとめて決める。
// 規則は attendanceTypesForShifts と同じ。設定は json_each で2回の問い合わせにまとめて読む（シフトの件数で問い合わせが増えない）
export async function attendanceTypesForRows(db: D1Database, rows: { shift_id: number; project_id: number; staff_id: number; attendance_mode?: any; attendance_types_fixed?: any; legacy_mode?: any }[]) {
  const map = new Map<number, ShiftAttendance>()
  if (!rows.length) return map
  const defaults = new Map<string, number>(), personal = new Map<string, number>(), hasPersonal = new Set<string>()
  const pset = new Set(rows.map(r => Number(r.project_id)))
  for (const r of (await db.prepare(`SELECT project_id, report_type, enabled FROM project_report_defaults WHERE project_id IN ${JSON_IN}`)
    .bind(bindJsonArray(pset)).all()).results as any[]) defaults.set(`${r.project_id}:${r.report_type}`, r.enabled)
  for (const r of (await db.prepare(`SELECT project_id, staff_id, report_type, enabled FROM project_staff_report_settings WHERE staff_id IN ${JSON_IN}`)
    .bind(bindJsonArray(rows.map(x => x.staff_id))).all()).results as any[]) {
    if (!pset.has(Number(r.project_id))) continue
    personal.set(`${r.project_id}:${r.staff_id}:${r.report_type}`, r.enabled)
    hasPersonal.add(`${r.project_id}:${r.staff_id}`)
  }
  for (const s of rows) map.set(s.shift_id, resolveAttendanceTypes(s, defaults, personal, hasPersonal))
  return map
}

// 日報が必要なシフトか（SQL の式）。シフト → スタッフ → 案件の順に none / required の最初の値、なければ required。
// staff-lifecycle.ts の resolveModes（modesForShifts）と同じ規則を、集計の SQL の中で使う。引数は shifts・staff_profiles・projects の別名
export function dailyReportRequiredSql(s: string, sp: string, p: string): string {
  const v = (a: string) => `CASE WHEN ${a}.daily_report_mode IN ('none','required') THEN ${a}.daily_report_mode END`
  return `(COALESCE(${v(s)}, ${v(sp)}, ${v(p)}, 'required') = 'required')`
}

type Ng = { error: string; status: number }

// 報告できるかの確認（有効・未報告・承認待ちの申請・順序）。done は登録済みの報告の種類、pending は承認待ちの打刻修正申請がある種類
//   前の報告が済んでいなくても、後の報告は押せる（飛ばした報告は打刻修正の申請で追加する。#47）。
//   そのため、勤務の途中で前の報告が ON になっても後の報告は止まらない（#458）。
//   後の報告が済んだ後に、それより前の報告を今の時刻で押すことはできない（順序が逆の記録を作らない）
export function checkReportable(required: string[], done: Set<string>, type: string, pending?: Set<string>): Ng | null {
  if (!required.includes(type)) return { error: 'このシフトでは不要な報告です', status: 400 }
  if (done.has(type)) return { error: 'すでに報告済みです', status: 409 }
  if (pending && pending.has(type)) return { error: `${REPORT_LABEL[type]}は打刻修正を申請中です（承認待ち）。今の時刻で報告する場合は、打刻履歴から申請を取り消してください`, status: 409 }
  const idx = REPORT_TYPES.indexOf(type as any)
  const later = REPORT_TYPES.find((t, j) => j > idx && done.has(t))
  if (later) return { error: `${REPORT_LABEL[later]}を報告済みのため、${REPORT_LABEL[type]}は報告できません。打刻の修正申請から追加してください`, status: 400 }
  return null
}

// 今押せる報告（REPORT_TYPES の順）。先頭がホームの『次の報告』。空なら報告は済んでいる（飛ばした報告は打刻修正の申請で追加する）
export function reportableTypes(required: string[], done: Set<string>, pending?: Set<string>): string[] {
  return required.filter(t => !checkReportable(required, done, t, pending))
}

// 報告を受け付ける時間帯か（now は JST の 'YYYY-MM-DD HH:MM:SS'）。時間帯の外ならエラーを返す
export function checkReportTime(shift: ShiftTimes, type: string, now: string): Ng | null {
  const w = reportableWindow(shift, type)
  if (now < w.start) return { error: `まだ報告できません（${Number(w.start.slice(5, 7))}/${Number(w.start.slice(8, 10))} ${w.start.slice(11, 16)} から報告できます）`, status: 400 }
  if (now > w.end) return { error: '報告の受付期間を過ぎています。打刻の修正申請から追加してください', status: 400 }
  return null
}

// スタッフ本人の報告（アプリ・写真付き・報告用URL）を受け付けるシフトか: 欠勤・精算の確定済みは受け付けない（#116）。
// 希望（仮）のシフトは受け付ける（画面で確認を出す。精算での扱いは確認事項で知らせる）
export function checkShiftAcceptsReport(shift: { status?: any; shift_status?: any; settle_status?: any }): Ng | null {
  const status = shift.status ?? shift.shift_status
  if (status === 'absent') return { error: '欠勤のシフトには報告できません', status: 400 }
  if (shift.settle_status === 'confirmed') return { error: '精算が確定したシフトには報告できません。打刻の修正は管理者に連絡してください', status: 409 }
  return null
}

// スタッフ本人の報告の受付をまとめて確認する（シフトの状態 → 受付の時間帯 → 有効・未報告・申請中・順序）
export function checkStaffReport(shift: ShiftTimes & { status?: any; shift_status?: any; settle_status?: any }, type: string, now: string,
  required: string[], state: { done: Set<string>; pending: Set<string> }): Ng | null {
  return checkShiftAcceptsReport(shift) || checkReportTime(shift, type, now) || checkReportable(required, state.done, type, state.pending)
}

// シフトの登録済みの報告と、承認待ちの打刻修正申請がある報告
export async function loadReportState(db: D1Database, shiftId: number): Promise<{ done: Set<string>; pending: Set<string> }> {
  const [reports, pending] = await db.batch([
    db.prepare('SELECT report_type FROM attendance_reports WHERE shift_id = ?').bind(shiftId),
    db.prepare("SELECT report_type FROM attendance_corrections WHERE shift_id = ? AND status = 'pending'").bind(shiftId),
  ])
  return {
    done: new Set((reports.results as any[]).map(r => r.report_type)),
    pending: new Set((pending.results as any[]).map(r => r.report_type)),
  }
}

// 報告の記録日時は分の単位にそろえる（打刻修正の申請と同じ精度。#133）
export function reportedAtMinute(now: string): string {
  return now.slice(0, 16) + ':00'
}

// ---------- 設定の読み書き ----------
type Actor = { user_id: number; name: string; role: string }
const actorOf = (u: any): Actor => ({ user_id: u.user_id, name: u.name, role: u.role })

async function projectDefaults(db: D1Database, projectId: number): Promise<Record<string, number>> {
  const rows = (await db.prepare('SELECT report_type, enabled FROM project_report_defaults WHERE project_id = ?').bind(projectId).all()).results as any[]
  const out: Record<string, number> = {}
  for (const t of REPORT_TYPES) out[t] = 1
  for (const r of rows) if (isReportType(r.report_type)) out[r.report_type] = r.enabled ? 1 : 0
  return out
}
// 案件にシフトがあるスタッフ（= 所属スタッフ）
async function projectMemberIds(db: D1Database, companyId: number, projectId: number): Promise<number[]> {
  return ((await db.prepare('SELECT DISTINCT staff_id FROM shifts WHERE project_id = ? AND company_id = ?').bind(projectId, companyId).all()).results as any[]).map(r => r.staff_id)
}
// スタッフ別の値（行がなければ、0027 より前のスタッフ単位の設定（none / in_out）か案件の標準設定）
async function staffSettings(db: D1Database, projectId: number, staffIds: number[], defaults: Record<string, number>) {
  const out = new Map<number, { values: Record<string, number>; individual: boolean; legacy_mode: string | null }>()
  for (const id of staffIds) out.set(id, { values: { ...defaults }, individual: false, legacy_mode: null })
  for (let i = 0; i < staffIds.length; i += 90) {
    const chunk = staffIds.slice(i, i + 90)
    const legacy = (await db.prepare(`SELECT staff_id, attendance_mode FROM staff_profiles WHERE staff_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results as any[]
    for (const r of legacy) {
      const s = out.get(r.staff_id); const flags = legacyStaffFlags(r.attendance_mode)
      if (s && flags) { s.values = flags; s.legacy_mode = r.attendance_mode }
    }
    const rows = (await db.prepare(`SELECT staff_id, report_type, enabled FROM project_staff_report_settings WHERE project_id = ? AND staff_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(projectId, ...chunk).all()).results as any[]
    for (const r of rows) {
      const s = out.get(r.staff_id); if (!s || !isReportType(r.report_type)) continue
      // 行がある組み合わせは、スタッフ単位の旧設定を使わない（attendanceTypesForShifts と同じ）
      if (!s.individual && s.legacy_mode) { s.values = { ...defaults }; s.legacy_mode = null }
      s.values[r.report_type] = r.enabled ? 1 : 0; s.individual = true
    }
  }
  return out
}

// 報告を始めたシフト（稼働日が昨日・今日で、報告が 1 つ以上ある）の、設定を変える前の有効な報告を記録する文を返す。
// 勤務の途中で ON にした報告は、そのシフトでは求めない（次のシフトから効く。#458）。OFF にした報告はすぐ外れる
async function freezeStartedShifts(db: D1Database, companyId: number, projectId: number, staffIds: number[]): Promise<D1PreparedStatement[]> {
  if (!staffIds.length) return []
  const today = nowJST().slice(0, 10)
  const ids = ((await db.prepare(`SELECT s.shift_id FROM shifts s
    WHERE s.project_id = ? AND s.company_id = ? AND s.staff_id IN ${JSON_IN} AND s.work_date >= ? AND s.status != 'absent'
      AND s.attendance_types_fixed IS NULL AND EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id)`)
    .bind(projectId, companyId, bindJsonArray(staffIds), addDays(today, -1)).all()).results as any[]).map(r => r.shift_id as number)
  if (!ids.length) return []
  const current = await attendanceTypesForShifts(db, ids)
  // 同じ値のシフトをまとめて 1 文で書く（シフトの例外 none / in_out はシフトの設定が優先するので固定しない）
  const groups = new Map<string, number[]>()
  for (const id of ids) {
    const a = current.get(id); if (!a || a.source === 'shift') continue
    const key = JSON.stringify(a.types)
    if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(id)
  }
  return [...groups].map(([types, sids]) => db.prepare(`UPDATE shifts SET attendance_types_fixed = ? WHERE shift_id IN ${JSON_IN} AND attendance_types_fixed IS NULL`).bind(types, bindJsonArray(sids)))
}
function newBatchId(): string {
  const a = new Uint8Array(8); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
// 1 人分（最大 8 行）を 1 文で書く（D1 のバインド変数は 1 文 100 個まで: 8 行 × 8 個 = 64）
function upsertStaffRows(db: D1Database, companyId: number, projectId: number, staffId: number, rows: { t: string; enabled: number; source: string }[], by: number | null, at: string) {
  return db.prepare(`INSERT INTO project_staff_report_settings (project_id, staff_id, company_id, report_type, enabled, source, updated_by, updated_at)
    VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
    ON CONFLICT(project_id, staff_id, report_type) DO UPDATE SET enabled = excluded.enabled, source = excluded.source, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(...rows.flatMap(r => [projectId, staffId, companyId, r.t, r.enabled, r.source, by, at]))
}
// 履歴を 1 文で書く（最大 8 行 × 12 個 = 96）
function logRows(db: D1Database, companyId: number, projectId: number, staffId: number | null, rows: { t: string; oldV: number | null; newV: number }[], action: string, batchId: string, a: Actor | null, at: string) {
  return db.prepare(`INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, batch_id, changed_by, changed_by_name, changed_by_role, created_at)
    VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
    .bind(...rows.flatMap(r => [companyId, projectId, staffId, r.t, r.oldV, r.newV, action, batchId, a?.user_id ?? null, a?.name ?? null, a?.role ?? null, at]))
}
async function runBatch(db: D1Database, stmts: D1PreparedStatement[]) {
  // D1 の batch は 1 トランザクション。途中で失敗したら全体が取り消される
  if (stmts.length) await db.batch(stmts)
}

// 案件の標準設定を変える。変える前に、個別の行がない所属スタッフへ今の値を固定する（標準設定の変更は新しく所属するスタッフにだけ効く）
export async function setProjectDefaults(db: D1Database, companyId: number, projectId: number, next: Record<string, any>, u: any) {
  const cur = await projectDefaults(db, projectId)
  const changed = REPORT_TYPES.filter(t => next[t] !== undefined && (next[t] ? 1 : 0) !== cur[t])
  if (!changed.length) return { changed: 0 }
  const at = nowJST(), batchId = newBatchId(), a = actorOf(u)
  const members = await projectMemberIds(db, companyId, projectId)
  const settings = await staffSettings(db, projectId, members, cur)
  const stmts: D1PreparedStatement[] = []
  for (const [staffId, s] of settings) {
    if (s.individual) continue
    // 今の値（標準設定。スタッフ単位の旧設定がある人はその値）を固定する
    stmts.push(upsertStaffRows(db, companyId, projectId, staffId, REPORT_TYPES.map(t => ({ t, enabled: s.values[t], source: 'default' })), a.user_id, at))
  }
  for (const t of changed) {
    stmts.push(db.prepare(`INSERT INTO project_report_defaults (project_id, company_id, report_type, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, report_type) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(projectId, companyId, t, next[t] ? 1 : 0, a.user_id, at))
  }
  stmts.push(logRows(db, companyId, projectId, null, changed.map(t => ({ t, oldV: cur[t], newV: next[t] ? 1 : 0 })), 'project_default', batchId, a, at))
  await runBatch(db, stmts)
  return { changed: changed.length }
}

// スタッフ別の設定を変える（individual / bulk）。changes: staffId → { type: 0|1 }
async function setStaffSettings(db: D1Database, companyId: number, projectId: number, changes: Map<number, Record<string, number>>, action: 'individual' | 'bulk', u: any) {
  const defaults = await projectDefaults(db, projectId)
  const settings = await staffSettings(db, projectId, [...changes.keys()], defaults)
  const at = nowJST(), batchId = newBatchId(), a = actorOf(u)
  const stmts: D1PreparedStatement[] = []
  let staffChanged = 0, cells = 0
  // 報告を始めたシフトは、変える前の設定で固定してから変更する（同じ batch で書く）
  const changedIds = [...changes].filter(([id, next]) => REPORT_TYPES.some(t => next[t] !== undefined && next[t] !== settings.get(id)!.values[t])).map(([id]) => id)
  stmts.push(...await freezeStartedShifts(db, companyId, projectId, changedIds))
  for (const [staffId, next] of changes) {
    const cur = settings.get(staffId)!.values
    const diff = REPORT_TYPES.filter(t => next[t] !== undefined && next[t] !== cur[t])
    if (!diff.length) continue
    staffChanged++; cells += diff.length
    // 8 種類すべての行を持たせる（変えない種類は今の値のまま。由来は変えた種類のみ更新）
    const individual = settings.get(staffId)!.individual
    const rows = REPORT_TYPES.filter(t => diff.includes(t) || !individual)
      .map(t => diff.includes(t) ? { t, enabled: next[t], source: action } : { t, enabled: cur[t], source: 'default' })
    stmts.push(upsertStaffRows(db, companyId, projectId, staffId, rows, a.user_id, at))
    stmts.push(logRows(db, companyId, projectId, staffId, diff.map(t => ({ t, oldV: cur[t], newV: next[t] })), action, batchId, a, at))
  }
  await runBatch(db, stmts)
  return { staff_changed: staffChanged, cells, batch_id: staffChanged ? batchId : null }
}

// 旧来のスタッフ単位の提出設定 API（PUT /admin/staff/:id/report-settings）の勤怠部分: 所属する全案件の設定を置き換える
// mode = '' / null は「案件の標準設定に戻す」
export async function applyLegacyStaffMode(db: D1Database, companyId: number, staffId: number, mode: any, u: any) {
  const projects = ((await db.prepare('SELECT DISTINCT project_id FROM shifts WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).all()).results as any[]).map(r => r.project_id)
  for (const pid of projects) {
    const next = mode ? flagsFromLegacyMode(mode) : await projectDefaults(db, pid)
    await setStaffSettings(db, companyId, pid, new Map([[staffId, next]]), 'individual', u)
  }
  // スタッフ単位の値も保存する（これから所属する案件で、案件 × スタッフ別の行がない間に使う）
  await db.prepare('UPDATE staff_profiles SET attendance_mode = ? WHERE staff_id = ? AND company_id = ?').bind(mode || null, staffId, companyId).run()
  return { projects: projects.length }
}

// ---------- 管理者 API ----------
export const reportSettingsApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

async function ownProject(db: D1Database, companyId: number, id: any) {
  return db.prepare('SELECT p.project_id, p.project_name, p.status, p.attendance_mode, cl.client_name FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id WHERE p.project_id = ? AND p.company_id = ?')
    .bind(id, companyId).first() as Promise<any>
}
function parseSettings(b: any): Record<string, number> | null {
  if (!b || typeof b !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(b)) {
    if (!isReportType(k) || typeof v !== 'boolean') return null
    out[k] = v ? 1 : 0
  }
  return Object.keys(out).length ? out : null
}
function todayJST(): string { return nowJST().slice(0, 10) }

// 案件一覧（終了した案件は include_closed=1 で表示）
reportSettingsApi.get('/report-settings/projects', async (c) => {
  const u = c.get('user')
  const includeClosed = c.req.query('include_closed') === '1'
  const rows = (await c.env.DB.prepare(`SELECT p.project_id, p.project_name, p.status, cl.client_name,
      (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.project_id = p.project_id) AS member_count,
      (SELECT COUNT(*) FROM project_report_defaults d WHERE d.project_id = p.project_id AND d.enabled = 0) AS default_off
    FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id
    WHERE p.company_id = ? ${includeClosed ? '' : "AND COALESCE(p.status, 'active') = 'active'"}
    ORDER BY CASE WHEN COALESCE(p.status, 'active') = 'active' THEN 0 ELSE 1 END, p.project_name`).bind(u.company_id).all()).results
  return c.json({ projects: rows })
})

// 案件詳細: 標準設定・所属スタッフ別の設定
reportSettingsApi.get('/report-settings/projects/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const defaults = await projectDefaults(db, p.project_id)
  const members = (await db.prepare(`SELECT s.staff_id, us.name, COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type,
      MIN(s.work_date) AS first_date, MAX(s.work_date) AS last_date,
      SUM(CASE WHEN s.work_date >= ? AND s.status != 'absent' THEN 1 ELSE 0 END) AS upcoming
    FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE s.project_id = ? AND s.company_id = ? GROUP BY s.staff_id ORDER BY us.name`).bind(todayJST(), p.project_id, u.company_id).all()).results as any[]
  const settings = await staffSettings(db, p.project_id, members.map(m => m.staff_id), defaults)
  return c.json({
    project: { project_id: p.project_id, project_name: p.project_name, status: p.status || 'active', client_name: p.client_name },
    report_types: REPORT_TYPES, labels: REPORT_LABEL, defaults,
    // legacy_mode: 0027 より前のスタッフ単位の設定（none / in_out）を使っている人
    staff: members.map(m => ({ ...m, settings: settings.get(m.staff_id)!.values, individual: settings.get(m.staff_id)!.individual, legacy_mode: settings.get(m.staff_id)!.legacy_mode })),
  })
})

// 標準設定の変更（新しく所属するスタッフにだけ効く）
reportSettingsApi.put('/report-settings/projects/:id/default', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const next = parseSettings((await c.req.json().catch(() => ({} as any))).settings)
  if (!next) return c.json({ error: '設定値が正しくありません' }, 400)
  const r = await setProjectDefaults(db, u.company_id, p.project_id, next, u)
  return c.json({ ok: true, ...r })
})

// スタッフ別の変更（1 人）
reportSettingsApi.put('/report-settings/projects/:id/staff/:staffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const staffId = Number(c.req.param('staffId'))
  if (!(await projectMemberIds(db, u.company_id, p.project_id)).includes(staffId)) return c.json({ error: 'この案件に所属していないスタッフです' }, 404)
  const next = parseSettings((await c.req.json().catch(() => ({} as any))).settings)
  if (!next) return c.json({ error: '設定値が正しくありません' }, 400)
  const r = await setStaffSettings(db, u.company_id, p.project_id, new Map([[staffId, next]]), 'individual', u)
  return c.json({ ok: true, ...r })
})

// 一括変更。dry_run で確認内容（対象者ごとの変更前・変更後、影響人数）と確認トークンを返す。
// 保存時は確認トークンを送る。確認後に設定が変わっていた場合（別の操作・二重送信）は 409 で再確認を求める
reportSettingsApi.post('/report-settings/projects/:id/bulk', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const types = Array.isArray(b.report_types) ? [...new Set(b.report_types)].filter(isReportType) as string[] : []
  if (!types.length || types.length !== new Set(b.report_types).size) return c.json({ error: '報告の種類を選択してください' }, 400)
  if (typeof b.enabled !== 'boolean') return c.json({ error: 'ON / OFF を選択してください' }, 400)
  const members = await projectMemberIds(db, u.company_id, p.project_id)
  const staffIds = Array.isArray(b.staff_ids) ? [...new Set(b.staff_ids.map(Number))] as number[] : []
  if (!staffIds.length) return c.json({ error: '対象のスタッフを選択してください' }, 400)
  if (staffIds.some(id => !members.includes(id))) return c.json({ error: 'この案件に所属していないスタッフが含まれています' }, 400)
  const v = b.enabled ? 1 : 0
  const defaults = await projectDefaults(db, p.project_id)
  const settings = await staffSettings(db, p.project_id, staffIds, defaults)
  const names = new Map<number, string>()
  for (let i = 0; i < staffIds.length; i += 90) {
    const chunk = staffIds.slice(i, i + 90)
    for (const r of (await db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results as any[]) names.set(r.staff_id, r.name)
  }
  const upcoming = new Set(((await db.prepare(`SELECT DISTINCT staff_id FROM shifts WHERE project_id = ? AND company_id = ? AND work_date >= ? AND status != 'absent'`)
    .bind(p.project_id, u.company_id, todayJST()).all()).results as any[]).map(r => r.staff_id))
  const preview = staffIds.map(id => {
    const before = settings.get(id)!.values
    const after = { ...before }; for (const t of types) after[t] = v
    return { staff_id: id, name: names.get(id) || '', before, after, changed: types.some(t => before[t] !== v), upcoming: upcoming.has(id) }
  })
  const changedRows = preview.filter(r => r.changed)
  // 確認トークン: 対象・変更内容・現在の値から作る。保存までに値が変わると一致しない
  const token = await sha256(JSON.stringify([p.project_id, types.slice().sort(), v, staffIds.slice().sort((a, b) => a - b), preview.map(r => [r.staff_id, types.map(t => r.before[t])])]))
  if (b.dry_run) {
    return c.json({
      report_types: types, enabled: b.enabled, target_count: staffIds.length, changed_count: changedRows.length,
      affected_upcoming: v === 0 ? changedRows.filter(r => r.upcoming).length : 0, rows: preview, confirm_token: token,
    })
  }
  if (b.confirm_token !== token) return c.json({ error: '確認後に設定が変わりました。もう一度内容を確認してください', need_confirm: true }, 409)
  const changes = new Map<number, Record<string, number>>()
  for (const r of changedRows) changes.set(r.staff_id, Object.fromEntries(types.map(t => [t, v])))
  try {
    const r = await setStaffSettings(db, u.company_id, p.project_id, changes, 'bulk', u)
    return c.json({ ok: true, ...r, target_count: staffIds.length })
  } catch {
    return c.json({ error: '保存に失敗しました。設定は変更されていません。もう一度お試しください' }, 500)
  }
})

// 設定変更の履歴（案件・スタッフ・期間・報告種類・操作で絞り込み）
function logFilter(companyId: number, q: (k: string) => string | undefined) {
  const w = ['l.company_id = ?']; const bind: any[] = [companyId]
  if (q('project_id')) { w.push('l.project_id = ?'); bind.push(Number(q('project_id'))) }
  if (q('staff_id')) { w.push('l.staff_id = ?'); bind.push(Number(q('staff_id'))) }
  if (q('scope') === 'default') w.push('l.staff_id IS NULL')
  if (isReportType(q('report_type'))) { w.push('l.report_type = ?'); bind.push(q('report_type')) }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q('from') || '')) { w.push('l.created_at >= ?'); bind.push(q('from') + ' 00:00:00') }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q('to') || '')) { w.push('l.created_at <= ?'); bind.push(q('to') + ' 23:59:59') }
  if (q('staff_name')) { w.push("us.name LIKE ? ESCAPE '\\'"); bind.push('%' + String(q('staff_name')).replace(/[\\%_]/g, m => '\\' + m) + '%') }
  if (q('action') && ACTION_LABEL[q('action')!]) { w.push('l.action = ?'); bind.push(q('action')) }
  return { where: w.join(' AND '), bind }
}
const ACTION_LABEL: Record<string, string> = { project_default: '標準設定', individual: '個別変更', bulk: '一括変更', migration: '導入時の移行', merge: 'スタッフ統合' }
const LOG_FROM = `FROM report_setting_logs l LEFT JOIN projects p ON p.project_id = l.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = l.staff_id LEFT JOIN users us ON us.user_id = sp.user_id`
reportSettingsApi.get('/report-settings/logs', async (c) => {
  const u = c.get('user'); const q = (k: string) => c.req.query(k)
  const { where, bind } = logFilter(u.company_id, q)
  const limit = Math.min(500, Math.max(1, Number(q('limit')) || 200))
  const rows = (await c.env.DB.prepare(`SELECT l.*, p.project_name, p.status AS project_status, us.name AS staff_name ${LOG_FROM}
    WHERE ${where} ORDER BY l.log_id DESC LIMIT ?`).bind(...bind, limit).all()).results
  return c.json({ logs: rows, labels: REPORT_LABEL })
})
reportSettingsApi.get('/report-settings/logs/export', async (c) => {
  const u = c.get('user')
  const { where, bind } = logFilter(u.company_id, k => c.req.query(k))
  const rows = (await c.env.DB.prepare(`SELECT l.*, p.project_name, p.status AS project_status, us.name AS staff_name ${LOG_FROM}
    WHERE ${where} ORDER BY l.log_id LIMIT 10000`).bind(...bind).all()).results as any[]
  const onoff = (v: any) => v == null ? '' : v ? 'ON' : 'OFF'
  const csv = toCsv(['履歴ID', '日時', '案件', '案件の状態', '対象', '報告', '変更前', '変更後', '操作', '一括の識別子', '変更者', '変更者のロール'],
    rows.map(l => [l.log_id, l.created_at, l.project_name, (l.project_status || 'active') === 'active' ? '稼働中' : '終了', l.staff_id ? l.staff_name : '標準設定',
      REPORT_LABEL[l.report_type] || l.report_type, onoff(l.old_enabled), onoff(l.new_enabled), ACTION_LABEL[l.action] || l.action, l.batch_id, l.changed_by_name || (l.action === 'migration' ? 'システム' : ''), l.changed_by_role]))
  return csvResponse(`報告設定の変更履歴_${nowJST().slice(0, 10)}.csv`, csv)
})

export default reportSettingsApi
