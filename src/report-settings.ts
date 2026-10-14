// =========================================================
// 案件報告管理（勤怠報告 8 種類の ON/OFF・一括変更・変更履歴）
// docs/spec_attendance_correction.md 2章・3章
//
// 有効な報告の決め方（シフトごと）:
//   1. シフトの例外 shifts.attendance_mode（none = なし / in_out = 入店・退店のみ / full・NULL = 2 以降に従う）
//   2. 案件 × スタッフ別の設定（project_staff_report_settings）
//   3. 案件の標準設定（project_report_defaults）
//   4. いずれもなければ ON
// 管理者向け API（/api/admin/report-settings/*）は api.ts から権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// 報告の順序（この順に日時が並ぶ）
export const REPORT_TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'] as const
export const REPORT_LABEL: Record<string, string> = {
  wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始',
  break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告',
}
// 稼働日の翌日も受け付ける報告（日をまたぐ勤務）
export const NEXT_DAY_TYPES = ['break_start', 'break_end', 'work_end', 'check_out']
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

// シフトごとに有効な報告（REPORT_TYPES の順）を返す
export async function attendanceTypesForShifts(db: D1Database, shiftIds: number[]): Promise<Map<number, ShiftAttendance>> {
  const map = new Map<number, ShiftAttendance>()
  const ids = [...new Set(shiftIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const shifts = (await db.prepare(`SELECT shift_id, project_id, staff_id, attendance_mode FROM shifts WHERE shift_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all()).results as any[]
    const projectIds = [...new Set(shifts.map(s => s.project_id))]
    const staffIds = [...new Set(shifts.map(s => s.staff_id))]
    const defaults = new Map<string, number>()
    const personal = new Map<string, number>()
    if (projectIds.length) {
      const q = projectIds.map(() => '?').join(',')
      for (const r of (await db.prepare(`SELECT project_id, report_type, enabled FROM project_report_defaults WHERE project_id IN (${q})`).bind(...projectIds).all()).results as any[]) {
        defaults.set(`${r.project_id}:${r.report_type}`, r.enabled)
      }
      // バインド変数は 1 文 100 個までのため、スタッフで絞って案件は手元で照合する
      const pset = new Set(projectIds)
      for (const r of (await db.prepare(`SELECT project_id, staff_id, report_type, enabled FROM project_staff_report_settings WHERE staff_id IN (${staffIds.map(() => '?').join(',')})`)
        .bind(...staffIds).all()).results as any[]) {
        if (pset.has(r.project_id)) personal.set(`${r.project_id}:${r.staff_id}:${r.report_type}`, r.enabled)
      }
    }
    for (const s of shifts) {
      if (s.attendance_mode === 'none') { map.set(s.shift_id, { types: [], source: 'shift' }); continue }
      if (s.attendance_mode === 'in_out') { map.set(s.shift_id, { types: ['check_in', 'check_out'], source: 'shift' }); continue }
      let source: AttendanceSource = 'default'
      const types = REPORT_TYPES.filter(t => {
        const pv = personal.get(`${s.project_id}:${s.staff_id}:${t}`)
        if (pv !== undefined) { source = 'staff'; return !!pv }
        const dv = defaults.get(`${s.project_id}:${t}`)
        if (dv !== undefined) { if (source === 'default') source = 'project'; return !!dv }
        return true
      })
      map.set(s.shift_id, { types, source })
    }
  }
  return map
}

// 報告できるかの確認（有効・未報告・順序）。done は登録済みの報告の種類
export function checkReportable(required: string[], done: Set<string>, type: string): { error: string; status: number } | null {
  if (!required.includes(type)) return { error: 'このシフトでは不要な報告です', status: 400 }
  if (done.has(type)) return { error: 'すでに報告済みです', status: 409 }
  const idx = required.indexOf(type)
  if (required.slice(0, idx).some(t => !done.has(t))) return { error: '前の報告を先に行ってください', status: 400 }
  return null
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
// スタッフ別の値（行がなければ案件の標準設定）
async function staffSettings(db: D1Database, projectId: number, staffIds: number[], defaults: Record<string, number>) {
  const out = new Map<number, { values: Record<string, number>; individual: boolean }>()
  for (const id of staffIds) out.set(id, { values: { ...defaults }, individual: false })
  for (let i = 0; i < staffIds.length; i += 90) {
    const chunk = staffIds.slice(i, i + 90)
    const rows = (await db.prepare(`SELECT staff_id, report_type, enabled FROM project_staff_report_settings WHERE project_id = ? AND staff_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(projectId, ...chunk).all()).results as any[]
    for (const r of rows) {
      const s = out.get(r.staff_id); if (!s || !isReportType(r.report_type)) continue
      s.values[r.report_type] = r.enabled ? 1 : 0; s.individual = true
    }
  }
  return out
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
    stmts.push(upsertStaffRows(db, companyId, projectId, staffId, REPORT_TYPES.map(t => ({ t, enabled: cur[t], source: 'default' })), a.user_id, at))
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
    staff: members.map(m => ({ ...m, settings: settings.get(m.staff_id)!.values, individual: settings.get(m.staff_id)!.individual })),
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

// 設定変更の履歴（案件・スタッフ・期間・報告種類で絞り込み）
reportSettingsApi.get('/report-settings/logs', async (c) => {
  const u = c.get('user'); const q = (k: string) => c.req.query(k)
  const w = ['l.company_id = ?']; const bind: any[] = [u.company_id]
  if (q('project_id')) { w.push('l.project_id = ?'); bind.push(Number(q('project_id'))) }
  if (q('staff_id')) { w.push('l.staff_id = ?'); bind.push(Number(q('staff_id'))) }
  if (q('scope') === 'default') w.push('l.staff_id IS NULL')
  if (isReportType(q('report_type'))) { w.push('l.report_type = ?'); bind.push(q('report_type')) }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q('from') || '')) { w.push('l.created_at >= ?'); bind.push(q('from') + ' 00:00:00') }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q('to') || '')) { w.push('l.created_at <= ?'); bind.push(q('to') + ' 23:59:59') }
  const limit = Math.min(500, Math.max(1, Number(q('limit')) || 200))
  const rows = (await c.env.DB.prepare(`SELECT l.*, p.project_name, us.name AS staff_name FROM report_setting_logs l
    LEFT JOIN projects p ON p.project_id = l.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = l.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE ${w.join(' AND ')} ORDER BY l.log_id DESC LIMIT ?`).bind(...bind, limit).all()).results
  return c.json({ logs: rows, labels: REPORT_LABEL })
})

export default reportSettingsApi
