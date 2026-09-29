// =========================================================
// 常勤・スポット案件のシフトボード / 募集枠 / 単価（請求・支払）
// docs/spec_spot_shift.md 第1段階
//
// api.ts とのコンフリクトを避けるため新規APIはこのファイルにまとめ、
// api.ts からは api.route('/admin', shiftBoardApi) で認証・権限ミドルウェアの後に登録する。
// 金額（請求・支払・粗利）は管理画面（/api/admin/*）でのみ返す。
// =========================================================
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ---------- 定数 ----------
export const UNIT_TYPES = ['daily', 'hourly'] as const
export const BILL_TRANSPORT_TYPES = ['actual', 'fixed', 'included'] as const
export const PAY_TRANSPORT_TYPES = ['actual', 'capped', 'fixed', 'none'] as const
const MAX_RANGE_DAYS = 31
const ACTIVE_STATUSES = ['requested', 'confirmed', 'substitute']

// スタッフ向けAPIから取り除く金額系の列
export const MONEY_COLUMNS = [
  'unit_price', 'bill_unit_type', 'bill_rate', 'bill_qty', 'pay_unit_type', 'pay_rate', 'pay_qty', 'pay_amount',
  'bill_transport_type', 'bill_transport_amount', 'pay_transport_type', 'pay_transport_amount',
  'bill_adjust', 'pay_adjust', 'adjust_note', 'payee_type', 'payee_affiliation_id', 'payee_company_id',
  'price_locked', 'price_source',
]
export function stripMoney<T extends Record<string, any>>(row: T | null): T | null {
  if (!row) return row
  const out: any = { ...row }
  for (const k of MONEY_COLUMNS) delete out[k]
  return out
}

// ---------- 日付・時間ユーティリティ ----------
function toMin(t: string): number { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
// 終了が開始より前なら日跨ぎ（翌日）とみなす
function spanMinutes(start: string, end: string): number { const s = toMin(start); let e = toMin(end); if (e <= s) e += 1440; return e - s }
function addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
function dayDiff(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) }
function weekday(d: string): number { return new Date(d + 'T00:00:00Z').getUTCDay() }
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const isTime = (s: any) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s)
function overlaps(aS: string, aE: string, bS: string, bE: string): boolean {
  const as = toMin(aS), ae = as + spanMinutes(aS, aE), bs = toMin(bS), be = bs + spanMinutes(bS, bE)
  return as < be && bs < ae
}
const intOrNull = (v: any) => (v === '' || v == null || isNaN(Number(v))) ? null : Math.round(Number(v))

// =========================================================
// 単価の解決
// 優先順: シフトの手動変更 ＞ 枠の役割の単価 ＞ 単価ルール（具体度: スタッフ8 役割4 開催場所2 案件1）＞ 案件の標準
// 項目ごとに（請求単価 / 支払単価 / 交通費の請求 / 交通費の支払）最も具体的な値を採用する
// =========================================================
export type PriceContext = { company_id: number; project_id: number; site_id?: number | null; role_name?: string | null; staff_id?: number | null; slot_role?: any }
export type ResolvedPrice = {
  bill_unit_type: string; bill_rate: number | null; pay_unit_type: string; pay_rate: number | null
  bill_transport_type: string; bill_transport_amount: number; pay_transport_type: string; pay_transport_amount: number
  sources: Record<string, string>
}

function ruleScore(r: any) { return (r.staff_id ? 8 : 0) + (r.role_name ? 4 : 0) + (r.site_id ? 2 : 0) + (r.project_id ? 1 : 0) }
function ruleLabel(r: any) {
  const p: string[] = []
  if (r.project_id) p.push('案件'); if (r.site_id) p.push('開催場所'); if (r.role_name) p.push('役割'); if (r.staff_id) p.push('スタッフ')
  return 'ルール#' + r.rule_id + '（' + (p.join('×') || '全体') + '）'
}

export async function loadPricingData(db: D1Database, companyId: number, projectIds: number[]) {
  const ids = [...new Set(projectIds.filter(Boolean))]
  const projects = ids.length ? (await db.prepare(`SELECT project_id, unit_price_type, unit_price, pay_unit_type, pay_rate,
      bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount, default_break_minutes, hours_basis, time_round_minutes
      FROM projects WHERE company_id = ? AND project_id IN (${ids.map(() => '?').join(',')})`).bind(companyId, ...ids).all()).results as any[] : []
  const rules = (await db.prepare(`SELECT * FROM rate_rules WHERE company_id = ? AND (project_id IS NULL ${ids.length ? `OR project_id IN (${ids.map(() => '?').join(',')})` : ''})`)
    .bind(companyId, ...ids).all()).results as any[]
  return { projects: new Map(projects.map(p => [p.project_id, p])), rules }
}

export function resolvePrice(ctx: PriceContext, data: { projects: Map<number, any>; rules: any[] }): ResolvedPrice {
  const p = data.projects.get(Number(ctx.project_id)) || {}
  const unit = (v: any) => (v === 'hourly' ? 'hourly' : 'daily')
  const out: ResolvedPrice = {
    bill_unit_type: unit(p.unit_price_type), bill_rate: p.unit_price ?? null,
    pay_unit_type: unit(p.pay_unit_type), pay_rate: p.pay_rate ?? null,
    bill_transport_type: p.bill_transport_type || 'actual', bill_transport_amount: p.bill_transport_amount || 0,
    pay_transport_type: p.pay_transport_type || 'actual', pay_transport_amount: p.pay_transport_amount || 0,
    sources: { bill: '案件の標準', pay: p.pay_rate == null ? '未設定' : '案件の標準', bill_transport: '案件の標準', pay_transport: '案件の標準' },
  }
  const matches = data.rules.filter(r =>
    (!r.project_id || Number(r.project_id) === Number(ctx.project_id)) &&
    (!r.site_id || (ctx.site_id && Number(r.site_id) === Number(ctx.site_id))) &&
    (!r.role_name || (ctx.role_name && r.role_name === ctx.role_name)) &&
    (!r.staff_id || (ctx.staff_id && Number(r.staff_id) === Number(ctx.staff_id))))
    .sort((a, b) => ruleScore(a) - ruleScore(b) || a.rule_id - b.rule_id) // 弱い順に適用し、強いもので上書き
  for (const r of matches) {
    if (r.bill_rate != null) { out.bill_rate = r.bill_rate; out.bill_unit_type = unit(r.bill_unit_type || out.bill_unit_type); out.sources.bill = ruleLabel(r) }
    if (r.pay_rate != null) { out.pay_rate = r.pay_rate; out.pay_unit_type = unit(r.pay_unit_type || out.pay_unit_type); out.sources.pay = ruleLabel(r) }
    if (r.bill_transport_type) { out.bill_transport_type = r.bill_transport_type; out.bill_transport_amount = r.bill_transport_amount || 0; out.sources.bill_transport = ruleLabel(r) }
    if (r.pay_transport_type) { out.pay_transport_type = r.pay_transport_type; out.pay_transport_amount = r.pay_transport_amount || 0; out.sources.pay_transport = ruleLabel(r) }
  }
  // 枠の役割で単価を指定している場合は最優先（ただしスタッフ別の支払ルールは除く：経験者加算を活かす）
  const sr = ctx.slot_role
  if (sr) {
    if (sr.bill_rate != null) { out.bill_rate = sr.bill_rate; out.bill_unit_type = unit(sr.bill_unit_type || out.bill_unit_type); out.sources.bill = '枠の単価' }
    const staffPay = matches.some(r => r.staff_id && r.pay_rate != null)
    if (sr.pay_rate != null && !staffPay) { out.pay_rate = sr.pay_rate; out.pay_unit_type = unit(sr.pay_unit_type || out.pay_unit_type); out.sources.pay = '枠の単価' }
  }
  return out
}

// 数量（日額=1、時給=拘束時間−休憩）と金額の計算。hoursOverride を渡すとその時間で計算する（実働時間）
export function calcAmounts(price: Pick<ResolvedPrice, 'bill_unit_type' | 'bill_rate' | 'pay_unit_type' | 'pay_rate'>, start: string, end: string, breakMin: number, hoursOverride?: number | null) {
  const hours = hoursOverride != null ? Math.max(0, hoursOverride) : Math.max(0, (spanMinutes(start, end) - (breakMin || 0)) / 60)
  const qty = (u: string) => (u === 'hourly' ? Math.round(hours * 100) / 100 : 1)
  const billQty = qty(price.bill_unit_type), payQty = qty(price.pay_unit_type)
  return {
    bill_qty: billQty, unit_price: Math.round((price.bill_rate || 0) * billQty),
    pay_qty: payQty, pay_amount: price.pay_rate == null ? null : Math.round(price.pay_rate * payQty),
  }
}
// ---------- 実働時間（第3段階） ----------
// hours_basis: clipped（実績。ただし予定の範囲内）/ actual（実績どおり）/ scheduled（予定どおり）
export const HOURS_BASIS = ['clipped', 'actual', 'scheduled'] as const
export function workHours(s: any, proj: any = {}) {
  const brkPlan = Number(s.break_minutes ?? proj.default_break_minutes ?? 0) || 0
  const planStart = toMin(s.start_time), planEnd = planStart + spanMinutes(s.start_time, s.end_time)
  const planned = Math.max(0, planEnd - planStart - brkPlan) / 60
  const basis = HOURS_BASIS.includes(proj.hours_basis) ? proj.hours_basis : 'clipped'
  const hasActual = isTime(s.actual_start) && isTime(s.actual_end)
  if (!hasActual) return { hours: round2(planned), planned_hours: round2(planned), actual_hours: null as number | null, basis, used: 'planned' as const, break_minutes: brkPlan }
  let aStart = toMin(s.actual_start)
  // 日をまたぐ予定で、実績の開始が予定より大きく前なら翌日とみなす
  if (planEnd > 1440 && aStart < planStart - 360) aStart += 1440
  let aEnd = toMin(s.actual_end); while (aEnd <= aStart) aEnd += 1440
  const brk = s.actual_break_minutes != null ? Number(s.actual_break_minutes) : brkPlan
  const r = Number(proj.time_round_minutes || 0)
  const roundUp = (m: number) => (r > 0 ? Math.ceil(m / r) * r : m), roundDown = (m: number) => (r > 0 ? Math.floor(m / r) * r : m)
  const actual = Math.max(0, roundDown(aEnd) - roundUp(aStart) - brk) / 60
  const cs = roundUp(Math.max(aStart, planStart)), ce = roundDown(Math.min(aEnd, planEnd))
  const clipped = Math.max(0, ce - cs - brk) / 60
  const hours = basis === 'scheduled' ? planned : basis === 'actual' ? actual : clipped
  return { hours: round2(hours), planned_hours: round2(planned), actual_hours: round2(actual), basis, used: basis === 'scheduled' ? 'planned' as const : 'actual' as const, break_minutes: brk }
}
function round2(n: number) { return Math.round(n * 100) / 100 }
export const isSettled = (s: any) => s?.settle_status === 'confirmed'

// 交通費（請求・支払）: 実費 transportation_fee とシフトに記録したルールから算出
export function transportAmounts(s: any) {
  const actual = Number(s.transportation_fee || 0)
  const bt = s.bill_transport_type || 'actual', pt = s.pay_transport_type || 'actual'
  const bill = bt === 'fixed' ? Number(s.bill_transport_amount || 0) : bt === 'included' ? 0 : actual
  const pay = pt === 'fixed' ? Number(s.pay_transport_amount || 0) : pt === 'none' ? 0
    : pt === 'capped' ? Math.min(actual, Number(s.pay_transport_amount || 0)) : actual
  return { bill_transport: bill, pay_transport: pay }
}
export function shiftTotals(s: any) {
  const t = transportAmounts(s)
  const bill = Number(s.unit_price || 0) + t.bill_transport + Number(s.bill_adjust || 0)
  const pay = s.pay_amount == null ? null : Number(s.pay_amount || 0) + t.pay_transport + Number(s.pay_adjust || 0)
  return { bill_total: bill, pay_total: pay, ...t }
}

// 支払先（第2段階の区分変更で置き換える。第1段階は現在の所属区分から決める）
export async function resolvePayee(db: D1Database, companyId: number, staffId: number) {
  const sp = await db.prepare('SELECT affiliation_type, partner_affiliation_id, owner_company_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).first() as any
  const t = sp?.affiliation_type || 'own_employee'
  if (t === 'linked_external') return { payee_type: 'linked', payee_affiliation_id: null, payee_company_id: sp.owner_company_id ?? null }
  if (t === 'partner_manual') return { payee_type: 'partner', payee_affiliation_id: sp.partner_affiliation_id ?? null, payee_company_id: null }
  // 第2段階: 個人事業主（本人へ業務委託費）/ 自社日雇い（日雇いの給与）
  if (t === 'freelance') return { payee_type: 'freelance', payee_affiliation_id: null, payee_company_id: null }
  if (t === 'daily_worker') return { payee_type: 'payroll_daily', payee_affiliation_id: null, payee_company_id: null }
  return { payee_type: 'payroll', payee_affiliation_id: null, payee_company_id: null }
}

// シフトの単価・金額・支払先を計算して書き込む（price_locked のシフトは金額を変えない）
export async function applyPricingToShift(db: D1Database, companyId: number, shiftId: number, opts: { force?: boolean; data?: any } = {}) {
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s) return
  if (isSettled(s)) return // 確定済みは変更しない
  if (s.price_locked && !opts.force) return
  const data = opts.data || await loadPricingData(db, companyId, [s.project_id])
  const slotRole = s.slot_role_id ? await db.prepare('SELECT * FROM shift_slot_roles WHERE slot_role_id = ?').bind(s.slot_role_id).first() : null
  const price = resolvePrice({ company_id: companyId, project_id: s.project_id, site_id: s.site_id, role_name: s.role, staff_id: s.staff_id, slot_role: slotRole }, data)
  const proj = data.projects.get(Number(s.project_id)) || {}
  const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
  const amt = calcAmounts(price, s.start_time, s.end_time, brk, workHours({ ...s, break_minutes: brk }, proj).hours)
  const payee = await resolvePayee(db, companyId, s.staff_id)
  await db.prepare(`UPDATE shifts SET bill_unit_type = ?, bill_rate = ?, bill_qty = ?, unit_price = ?,
      pay_unit_type = ?, pay_rate = ?, pay_qty = ?, pay_amount = ?,
      bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?,
      payee_type = ?, payee_affiliation_id = ?, payee_company_id = ?, price_source = ?, price_locked = 0
    WHERE shift_id = ? AND company_id = ?`)
    .bind(price.bill_unit_type, price.bill_rate, amt.bill_qty, amt.unit_price,
      price.pay_unit_type, price.pay_rate, amt.pay_qty, amt.pay_amount,
      price.bill_transport_type, price.bill_transport_amount, price.pay_transport_type, price.pay_transport_amount,
      payee.payee_type, payee.payee_affiliation_id, payee.payee_company_id,
      JSON.stringify(price.sources), shiftId, companyId).run()
}

// ---------- 共通の確認 ----------
async function ownProject(db: D1Database, companyId: number, projectId: any) {
  return db.prepare('SELECT * FROM projects WHERE project_id = ? AND company_id = ?').bind(projectId, companyId).first() as Promise<any>
}
async function ownSlot(db: D1Database, companyId: number, slotId: any) {
  return db.prepare('SELECT * FROM shift_slots WHERE slot_id = ? AND company_id = ?').bind(slotId, companyId).first() as Promise<any>
}
async function ownSlotRole(db: D1Database, companyId: number, slotRoleId: any) {
  return db.prepare(`SELECT r.*, s.company_id, s.project_id, s.site_id, s.location, s.work_date, s.start_time, s.end_time, s.break_minutes
    FROM shift_slot_roles r JOIN shift_slots s ON s.slot_id = r.slot_id WHERE r.slot_role_id = ? AND s.company_id = ?`).bind(slotRoleId, companyId).first() as Promise<any>
}
async function ownSite(db: D1Database, companyId: number, siteId: any) {
  if (!siteId) return null
  return db.prepare('SELECT * FROM sites WHERE site_id = ? AND company_id = ?').bind(siteId, companyId).first() as Promise<any>
}
function parseIds(v: any): number[] { return String(v || '').split(',').map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0) }

// ---------- 重複・NGチェック ----------
// 同じ人物（person_id）の全企業のシフトから、同じ日・時間帯の重なりを探す
export async function findConflicts(db: D1Database, companyId: number, staffIds: number[], from: string, to: string) {
  if (!staffIds.length) return new Map<number, any[]>()
  const ids = [...new Set(staffIds)]
  const rows = (await db.prepare(`
    SELECT me.staff_id AS my_staff_id, s.shift_id, s.staff_id, s.company_id, s.work_date, s.start_time, s.end_time, s.status,
      p.project_name, co.company_name
    FROM staff_profiles me
    JOIN staff_profiles sp ON (sp.person_id = me.person_id AND me.person_id IS NOT NULL) OR sp.staff_id = me.staff_id
    JOIN shifts s ON s.staff_id = sp.staff_id
    JOIN projects p ON p.project_id = s.project_id
    JOIN companies co ON co.company_id = s.company_id
    WHERE me.company_id = ? AND me.staff_id IN (${ids.map(() => '?').join(',')})
      AND s.work_date BETWEEN ? AND ? AND s.status IN ('requested','confirmed','substitute')`)
    .bind(companyId, ...ids, from, to).all()).results as any[]
  const map = new Map<number, any[]>()
  for (const r of rows) { const a = map.get(r.my_staff_id) || []; if (!a.some(x => x.shift_id === r.shift_id)) a.push(r); map.set(r.my_staff_id, a) }
  return map
}
function conflictFor(list: any[] | undefined, date: string, start: string, end: string, excludeShiftId?: number) {
  return (list || []).filter(x => x.work_date === date && x.shift_id !== excludeShiftId && overlaps(x.start_time, x.end_time, start, end))
}
async function ngStaffIds(db: D1Database, projectId: number): Promise<number[]> {
  const r = await db.prepare('SELECT cl.ng_staff_ids FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id WHERE p.project_id = ?').bind(projectId).first() as any
  return parseIds(r?.ng_staff_ids)
}

// =========================================================
// シフトボード
// =========================================================
app.get('/shift-board', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const from = c.req.query('from'); let to = c.req.query('to')
  if (!isDate(from)) return c.json({ error: '開始日を指定してください' }, 400)
  if (!isDate(to) || dayDiff(from!, to!) < 0) to = addDays(from!, 6)
  if (dayDiff(from!, to!) > MAX_RANGE_DAYS - 1) to = addDays(from!, MAX_RANGE_DAYS - 1)
  const clientId = intOrNull(c.req.query('client_id'))
  const projectIds = parseIds(c.req.query('project_ids'))
  const siteId = intOrNull(c.req.query('site_id'))
  const engagement = c.req.query('engagement') // regular / spot / 未指定=すべて

  const pf: string[] = ['p.company_id = ?']; const pb: any[] = [u.company_id]
  if (clientId) { pf.push('p.client_id = ?'); pb.push(clientId) }
  if (projectIds.length) { pf.push(`p.project_id IN (${projectIds.map(() => '?').join(',')})`); pb.push(...projectIds) }
  if (engagement === 'regular' || engagement === 'spot') { pf.push("COALESCE(p.engagement_type,'regular') = ?"); pb.push(engagement) }
  const projects = (await db.prepare(`SELECT p.project_id, p.project_name, p.client_id, cl.client_name, p.status, COALESCE(p.engagement_type,'regular') AS engagement_type, p.location
    FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id WHERE ${pf.join(' AND ')} ORDER BY cl.client_name, p.project_name`).bind(...pb).all()).results as any[]
  const pids = projects.map(p => p.project_id)
  const empty = { from, to, projects, slots: [], unslotted: [], staff: [], totals: { bill: 0, pay: 0, profit: 0, required: 0, filled: 0, pay_missing: 0 } }
  if (!pids.length) return c.json(empty)
  const inP = pids.map(() => '?').join(',')

  const slotRows = (await db.prepare(`SELECT sl.*, si.site_name FROM shift_slots sl LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE sl.company_id = ? AND sl.project_id IN (${inP}) AND sl.work_date BETWEEN ? AND ? ${siteId ? 'AND sl.site_id = ?' : ''}
    ORDER BY sl.work_date, sl.start_time`).bind(u.company_id, ...pids, from, to, ...(siteId ? [siteId] : [])).all()).results as any[]
  const slotIds = slotRows.map(s => s.slot_id)
  const roles = slotIds.length ? (await db.prepare(`SELECT * FROM shift_slot_roles WHERE slot_id IN (${slotIds.map(() => '?').join(',')}) ORDER BY sort_order, slot_role_id`).bind(...slotIds).all()).results as any[] : []

  const shiftRows = (await db.prepare(`
    SELECT s.*, us.name AS staff_name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, si.site_name
    FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN sites si ON si.site_id = s.site_id
    WHERE s.company_id = ? AND s.project_id IN (${inP}) AND s.work_date BETWEEN ? AND ? ${siteId ? 'AND s.site_id = ?' : ''}
    ORDER BY s.work_date, s.start_time, us.name`).bind(u.company_id, ...pids, from, to, ...(siteId ? [siteId] : [])).all()).results as any[]

  const conflicts = await findConflicts(db, u.company_id, shiftRows.map(s => s.staff_id), from!, to!)
  const ngByProject = new Map<number, number[]>()
  for (const p of projects) ngByProject.set(p.project_id, [])
  const ngRows = (await db.prepare(`SELECT p.project_id, cl.ng_staff_ids FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id WHERE p.project_id IN (${inP})`).bind(...pids).all()).results as any[]
  for (const r of ngRows) ngByProject.set(r.project_id, parseIds(r.ng_staff_ids))

  const totals = { bill: 0, pay: 0, profit: 0, required: 0, filled: 0, pay_missing: 0 }
  const decorate = (s: any) => {
    const t = shiftTotals(s)
    const active = ['confirmed', 'substitute'].includes(s.status)
    if (active) { totals.bill += t.bill_total; if (t.pay_total == null) totals.pay_missing++; else totals.pay += t.pay_total }
    const cf = conflictFor(conflicts.get(s.staff_id), s.work_date, s.start_time, s.end_time, s.shift_id)
    return {
      ...s, ...t,
      conflicts: cf.map(x => ({ shift_id: x.shift_id, work_date: x.work_date, start_time: x.start_time, end_time: x.end_time, project_name: x.company_id === u.company_id ? x.project_name : null, company_name: x.company_name, other_company: x.company_id !== u.company_id })),
      ng: (ngByProject.get(s.project_id) || []).includes(s.staff_id),
    }
  }
  const byRole = new Map<number, any[]>(); const unslotted: any[] = []
  for (const s of shiftRows) {
    const d = decorate(s)
    if (s.slot_role_id) { const a = byRole.get(s.slot_role_id) || []; a.push(d); byRole.set(s.slot_role_id, a) } else unslotted.push(d)
  }
  const rolesBySlot = new Map<number, any[]>()
  for (const r of roles) {
    const assigned = byRole.get(r.slot_role_id) || []
    const filled = assigned.filter(a => ['confirmed', 'substitute'].includes(a.status)).length
    totals.required += r.headcount; totals.filled += Math.min(filled, r.headcount)
    const arr = rolesBySlot.get(r.slot_id) || []; arr.push({ ...r, assigned, filled, requested: assigned.filter(a => a.status === 'requested').length }); rolesBySlot.set(r.slot_id, arr)
  }
  const slots = slotRows.map(s => ({ ...s, roles: rolesBySlot.get(s.slot_id) || [] }))
  // 割り当てのない役割のシフトが消えた枠でも、役割に孤立したシフトがあれば枠なし扱いにする
  const knownRoles = new Set(roles.map(r => r.slot_role_id))
  for (const [rid, list] of byRole) if (!knownRoles.has(rid)) unslotted.push(...list)
  totals.profit = totals.bill - totals.pay
  return c.json({ from, to, projects, slots, unslotted, totals })
})

// 候補スタッフ（枠の役割に対して）
app.get('/shift-board/candidates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const role = await ownSlotRole(db, u.company_id, c.req.query('slot_role_id'))
  if (!role) return c.json({ error: '枠が見つかりません' }, 404)
  const proj = await ownProject(db, u.company_id, role.project_id)
  const staff = (await db.prepare(`
    SELECT sp.staff_id, us.name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.employment_status,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.skills ELSE sp.skills END AS skills,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.work_area ELSE sp.work_area END AS work_area,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.project_id = ? AND s.status IN ('confirmed','substitute')) AS project_count,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.site_id = ? AND s.site_id IS NOT NULL AND s.status IN ('confirmed','substitute')) AS site_count,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date BETWEEN ? AND ? AND s.status IN ('confirmed','substitute')) AS week_days
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = sp.source_staff_id
    WHERE sp.company_id = ? AND COALESCE(sp.affiliation_type,'own_employee') != 'skillsheet_only'
      AND COALESCE(sp.employment_status,'working') NOT IN ('retired') AND us.status = 'active'
    ORDER BY us.name`).bind(role.project_id, role.site_id ?? -1, addDays(role.work_date, -weekday(role.work_date)), addDays(role.work_date, 6 - weekday(role.work_date)), u.company_id).all()).results as any[]
  const conflicts = await findConflicts(db, u.company_id, staff.map(s => s.staff_id), role.work_date, role.work_date)
  const ng = await ngStaffIds(db, role.project_id)
  const required = String(proj?.required_skills || '').split(',').map(s => s.trim()).filter(Boolean)
  const assigned = new Set(((await db.prepare("SELECT staff_id FROM shifts WHERE slot_role_id = ? AND status != 'absent'").bind(role.slot_role_id).all()).results as any[]).map(r => r.staff_id))
  const list = staff.filter(s => !assigned.has(s.staff_id)).map(s => {
    const skills = String(s.skills || '').split(',').map((x: string) => x.trim())
    const cf = conflictFor(conflicts.get(s.staff_id), role.work_date, role.start_time, role.end_time)
    return {
      staff_id: s.staff_id, name: s.name, affiliation_type: s.affiliation_type, employment_status: s.employment_status,
      project_count: s.project_count, site_count: s.site_count, week_days: s.week_days,
      skill_match: required.filter(r => skills.includes(r)).length, skill_required: required.length,
      busy: cf.length > 0, busy_detail: cf.map(x => (x.company_id === u.company_id ? x.project_name : x.company_name + '（他社）') + ' ' + x.start_time + '〜' + x.end_time),
      ng: ng.includes(s.staff_id), on_leave: s.employment_status === 'leave',
    }
  })
  // 並び: 空きあり → NGでない → 同じ開催場所の経験 → 案件の経験 → スキル一致 → 週の稼働が少ない
  list.sort((a, b) => Number(a.busy) - Number(b.busy) || Number(a.ng) - Number(b.ng) || b.site_count - a.site_count || b.project_count - a.project_count || b.skill_match - a.skill_match || a.week_days - b.week_days)
  return c.json({ slot_role: role, candidates: list })
})

// =========================================================
// 募集枠
// =========================================================
function normalizeRoles(roles: any): { role_name: string; headcount: number; bill_rate: number | null; pay_rate: number | null; bill_unit_type: string | null; pay_unit_type: string | null }[] | null {
  if (!Array.isArray(roles) || !roles.length) return null
  const out = roles.map((r: any) => ({
    role_name: String(r.role_name || '').trim(), headcount: Math.max(1, Math.min(200, Number(r.headcount) || 1)),
    bill_rate: intOrNull(r.bill_rate), pay_rate: intOrNull(r.pay_rate),
    bill_unit_type: r.bill_unit_type === 'hourly' ? 'hourly' : r.bill_unit_type === 'daily' ? 'daily' : null,
    pay_unit_type: r.pay_unit_type === 'hourly' ? 'hourly' : r.pay_unit_type === 'daily' ? 'daily' : null,
  }))
  if (out.some(r => !r.role_name)) return null
  return out
}
async function insertSlot(db: D1Database, u: any, b: any, date: string, roles: any[], patternId: number | null) {
  const res = await db.prepare(`INSERT INTO shift_slots (company_id, project_id, site_id, location, work_date, start_time, end_time, break_minutes, pattern_id, memo, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, b.project_id, b.site_id || null, b.location || null, date, b.start_time, b.end_time,
    intOrNull(b.break_minutes), patternId, b.memo || null, u.user_id).run()
  const slotId = res.meta.last_row_id
  await db.batch(roles.map((r, i) => db.prepare(`INSERT INTO shift_slot_roles (slot_id, role_name, headcount, bill_unit_type, bill_rate, pay_unit_type, pay_rate, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(slotId, r.role_name, r.headcount, r.bill_unit_type, r.bill_rate, r.pay_unit_type, r.pay_rate, i)))
  return slotId
}
async function validateSlotBody(db: D1Database, u: any, b: any): Promise<string | null> {
  if (!b.project_id || !(await ownProject(db, u.company_id, b.project_id))) return '案件を選択してください'
  if (!isTime(b.start_time) || !isTime(b.end_time)) return '開始・終了時刻を入力してください'
  if (b.site_id && !(await ownSite(db, u.company_id, b.site_id))) return '開催場所が見つかりません'
  return null
}

app.post('/shift-slots', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const err = await validateSlotBody(db, u, b); if (err) return c.json({ error: err }, 400)
  const roles = normalizeRoles(b.roles); if (!roles) return c.json({ error: '役割と必要人数を入力してください' }, 400)
  const dates: string[] = [...new Set(((Array.isArray(b.dates) ? b.dates : [b.work_date]) as any[]).filter(isDate))] as string[]
  if (!dates.length) return c.json({ error: '日付を選択してください' }, 400)
  if (dates.length > 92) return c.json({ error: '一度に作成できるのは92日分までです' }, 400)
  if (!b.location && b.site_id) b.location = (await ownSite(db, u.company_id, b.site_id))?.site_name
  const ids: number[] = []
  for (const d of dates.sort()) ids.push(await insertSlot(db, u, b, d, roles, null))
  return c.json({ ok: true, slot_ids: ids })
})

app.get('/shift-slots/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const slot = await ownSlot(db, u.company_id, c.req.param('id'))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const roles = (await db.prepare('SELECT * FROM shift_slot_roles WHERE slot_id = ? ORDER BY sort_order, slot_role_id').bind(slot.slot_id).all()).results
  return c.json({ slot, roles })
})

// 枠の変更: 時間・場所・役割（人数・単価）。時間/場所を変えたら割り当て済みシフトにも反映し、単価を再計算する
app.put('/shift-slots/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const slot = await ownSlot(db, u.company_id, c.req.param('id'))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const next = { ...slot, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => ['site_id', 'location', 'work_date', 'start_time', 'end_time', 'break_minutes', 'memo', 'status'].includes(k) && v !== undefined)) }
  if (!isTime(next.start_time) || !isTime(next.end_time) || !isDate(next.work_date)) return c.json({ error: '日付・時刻が正しくありません' }, 400)
  if (next.site_id && !(await ownSite(db, u.company_id, next.site_id))) return c.json({ error: '開催場所が見つかりません' }, 400)
  await db.prepare(`UPDATE shift_slots SET site_id = ?, location = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, memo = ?, status = ? WHERE slot_id = ?`)
    .bind(next.site_id || null, next.location || null, next.work_date, next.start_time, next.end_time, intOrNull(next.break_minutes), next.memo || null, next.status || 'open', slot.slot_id).run()

  if (Array.isArray(b.roles)) {
    const roles = normalizeRoles(b.roles.filter((r: any) => !r._delete)); if (!roles && b.roles.some((r: any) => !r._delete)) return c.json({ error: '役割と必要人数を入力してください' }, 400)
    for (const [i, r] of (b.roles as any[]).entries()) {
      if (r.slot_role_id) {
        const own = await db.prepare('SELECT slot_role_id FROM shift_slot_roles WHERE slot_role_id = ? AND slot_id = ?').bind(r.slot_role_id, slot.slot_id).first()
        if (!own) continue
        if (r._delete) {
          const used = await db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE slot_role_id = ? AND status != 'absent'").bind(r.slot_role_id).first() as any
          if (used.n > 0) return c.json({ error: `役割「${r.role_name}」には割り当て済みのスタッフがいるため削除できません` }, 409)
          await db.prepare('DELETE FROM shift_slot_roles WHERE slot_role_id = ?').bind(r.slot_role_id).run()
          continue
        }
        const n = normalizeRoles([r])![0]
        await db.prepare(`UPDATE shift_slot_roles SET role_name = ?, headcount = ?, bill_unit_type = ?, bill_rate = ?, pay_unit_type = ?, pay_rate = ?, sort_order = ? WHERE slot_role_id = ?`)
          .bind(n.role_name, n.headcount, n.bill_unit_type, n.bill_rate, n.pay_unit_type, n.pay_rate, i, r.slot_role_id).run()
        await db.prepare('UPDATE shifts SET role = ? WHERE slot_role_id = ?').bind(n.role_name, r.slot_role_id).run()
      } else if (!r._delete) {
        const n = normalizeRoles([r])![0]
        await db.prepare(`INSERT INTO shift_slot_roles (slot_id, role_name, headcount, bill_unit_type, bill_rate, pay_unit_type, pay_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(slot.slot_id, n.role_name, n.headcount, n.bill_unit_type, n.bill_rate, n.pay_unit_type, n.pay_rate, i).run()
      }
    }
  }
  // 割り当て済みシフトへ反映
  await db.prepare(`UPDATE shifts SET work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, site_id = ?, location = COALESCE(?, location) WHERE slot_id = ? AND company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed'`)
    .bind(next.work_date, next.start_time, next.end_time, intOrNull(next.break_minutes), next.site_id || null, next.location || null, slot.slot_id, u.company_id).run()
  const data = await loadPricingData(db, u.company_id, [slot.project_id])
  const sids = ((await db.prepare('SELECT shift_id FROM shifts WHERE slot_id = ? AND company_id = ?').bind(slot.slot_id, u.company_id).all()).results as any[])
  for (const s of sids) await applyPricingToShift(db, u.company_id, s.shift_id, { data })
  return c.json({ ok: true })
})

app.delete('/shift-slots/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const slot = await ownSlot(db, u.company_id, c.req.param('id'))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const used = await db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE slot_id = ?').bind(slot.slot_id).first() as any
  if (used.n > 0 && c.req.query('force') !== '1') return c.json({ error: `この枠には ${used.n} 件のシフトがあります`, assigned: used.n, need_force: true }, 409)
  // force: 割り当て済みシフトは削除せず「枠なし」に戻す（勤怠・日報が紐づいている可能性があるため）
  await db.batch([
    db.prepare('UPDATE shifts SET slot_id = NULL, slot_role_id = NULL WHERE slot_id = ? AND company_id = ?').bind(slot.slot_id, u.company_id),
    db.prepare('DELETE FROM shift_slot_roles WHERE slot_id = ?').bind(slot.slot_id),
    db.prepare('DELETE FROM shift_slots WHERE slot_id = ?').bind(slot.slot_id),
  ])
  return c.json({ ok: true })
})

// 役割への割り当て（複数可）
app.post('/shift-slots/roles/:id/assign', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const role = await ownSlotRole(db, u.company_id, c.req.param('id'))
  if (!role) return c.json({ error: '枠が見つかりません' }, 404)
  const staffIds: number[] = [...new Set(((Array.isArray(b.staff_ids) ? b.staff_ids : [b.staff_id]) as any[]).map(Number).filter(Boolean))]
  if (!staffIds.length) return c.json({ error: 'スタッフを選択してください' }, 400)
  const status = ['confirmed', 'requested'].includes(b.status) ? b.status : 'confirmed'
  const staffRows = (await db.prepare(`SELECT sp.staff_id, us.name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND sp.staff_id IN (${staffIds.map(() => '?').join(',')})`).bind(u.company_id, ...staffIds).all()).results as any[]
  if (staffRows.length !== staffIds.length) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (staffRows.some(s => s.affiliation_type === 'skillsheet_only')) return c.json({ error: 'スキルシートのみ作成のスタッフにはシフトを登録できません' }, 400)

  const already = new Set(((await db.prepare("SELECT staff_id FROM shifts WHERE slot_role_id = ? AND status != 'absent'").bind(role.slot_role_id).all()).results as any[]).map(r => r.staff_id))
  const conflicts = await findConflicts(db, u.company_id, staffIds, role.work_date, role.work_date)
  const ng = await ngStaffIds(db, role.project_id)
  const warnings = staffRows.flatMap(s => {
    const w: string[] = []
    if (already.has(s.staff_id)) w.push(`${s.name}: すでにこの枠に割り当て済みです`)
    const cf = conflictFor(conflicts.get(s.staff_id), role.work_date, role.start_time, role.end_time)
    if (cf.length) w.push(`${s.name}: 同じ時間帯に別のシフトがあります（${cf.map(x => (x.company_id === u.company_id ? x.project_name : x.company_name + '・他社') + ' ' + x.start_time + '〜' + x.end_time).join('、')}）`)
    if (ng.includes(s.staff_id)) w.push(`${s.name}: クライアントのNGスタッフに指定されています`)
    return w
  })
  if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)

  const data = await loadPricingData(db, u.company_id, [role.project_id])
  const created: number[] = []
  for (const s of staffRows) {
    if (already.has(s.staff_id)) continue
    const res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo, slot_id, slot_role_id, site_id, break_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, s.staff_id, role.project_id, role.work_date, role.start_time, role.end_time, role.location || '', role.role_name,
        intOrNull(b.transportation_fee) ?? 0, status, u.user_id, b.memo ?? null, role.slot_id, role.slot_role_id, role.site_id ?? null, role.break_minutes ?? null).run()
    await applyPricingToShift(db, u.company_id, res.meta.last_row_id, { data })
    created.push(res.meta.last_row_id)
  }
  return c.json({ ok: true, shift_ids: created, warnings })
})

// シフトを別の枠・役割へ移動（案件が変われば単価を再計算）。slot_role_id=null なら枠から外す
app.post('/shifts/:id/move', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (isSettled(s)) return c.json({ error: '確定済みのシフトは移動できません。精算画面で確定を取り消してください' }, 409)
  const role = await ownSlotRole(db, u.company_id, b.slot_role_id)
  if (!role) return c.json({ error: '移動先の枠が見つかりません' }, 404)
  const hasReports = await db.prepare('SELECT (SELECT COUNT(*) FROM attendance_reports WHERE shift_id = ?) + (SELECT COUNT(*) FROM daily_reports WHERE shift_id = ?) AS n').bind(s.shift_id, s.shift_id).first().catch(() => ({ n: 0 })) as any
  if (hasReports?.n > 0 && (role.work_date !== s.work_date || role.project_id !== s.project_id)) return c.json({ error: '勤怠・日報の報告があるシフトは、別の日付・案件へ移動できません' }, 409)
  const conflicts = await findConflicts(db, u.company_id, [s.staff_id], role.work_date, role.work_date)
  const cf = conflictFor(conflicts.get(s.staff_id), role.work_date, role.start_time, role.end_time, s.shift_id)
  const ng = (await ngStaffIds(db, role.project_id)).includes(s.staff_id)
  const warnings = [...(cf.length ? [`同じ時間帯に別のシフトがあります（${cf.map(x => (x.company_id === u.company_id ? x.project_name : x.company_name + '・他社') + ' ' + x.start_time + '〜' + x.end_time).join('、')}）`] : []), ...(ng ? ['クライアントのNGスタッフに指定されています'] : [])]
  if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  const projectChanged = role.project_id !== s.project_id
  await db.prepare(`UPDATE shifts SET project_id = ?, slot_id = ?, slot_role_id = ?, site_id = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, role = ?, location = ? WHERE shift_id = ?`)
    .bind(role.project_id, role.slot_id, role.slot_role_id, role.site_id ?? null, role.work_date, role.start_time, role.end_time, role.break_minutes ?? null, role.role_name, role.location || s.location || '', s.shift_id).run()
  // 手動変更した金額でも、案件が変わった場合は移動先の単価に置き換える
  await applyPricingToShift(db, u.company_id, s.shift_id, { force: projectChanged })
  return c.json({ ok: true, warnings })
})

// 金額の手動変更 / ルールに戻す
app.put('/shifts/:id/price', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (isSettled(s)) return c.json({ error: '確定済みのシフトの金額は変更できません。精算画面で確定を取り消してください' }, 409)
  if (b.reset) { await applyPricingToShift(db, u.company_id, s.shift_id, { force: true }); return c.json({ ok: true }) }
  const unit = (v: any, d: string) => (v === 'hourly' ? 'hourly' : v === 'daily' ? 'daily' : d)
  const billUnit = unit(b.bill_unit_type, s.bill_unit_type || 'daily'), payUnit = unit(b.pay_unit_type, s.pay_unit_type || 'daily')
  const billRate = b.bill_rate !== undefined ? intOrNull(b.bill_rate) : s.bill_rate
  const payRate = b.pay_rate !== undefined ? intOrNull(b.pay_rate) : s.pay_rate
  const brk = b.break_minutes !== undefined ? intOrNull(b.break_minutes) : s.break_minutes
  const pdata = await loadPricingData(db, u.company_id, [s.project_id])
  const amt = calcAmounts({ bill_unit_type: billUnit, bill_rate: billRate, pay_unit_type: payUnit, pay_rate: payRate }, s.start_time, s.end_time, brk || 0,
    workHours({ ...s, break_minutes: brk }, pdata.projects.get(Number(s.project_id)) || {}).hours)
  // 数量を直接指定した場合（実働時間など）はそちらを優先
  const billQty = b.bill_qty != null && b.bill_qty !== '' ? Number(b.bill_qty) : amt.bill_qty
  const payQty = b.pay_qty != null && b.pay_qty !== '' ? Number(b.pay_qty) : amt.pay_qty
  const bt = BILL_TRANSPORT_TYPES.includes(b.bill_transport_type) ? b.bill_transport_type : s.bill_transport_type
  const pt = PAY_TRANSPORT_TYPES.includes(b.pay_transport_type) ? b.pay_transport_type : s.pay_transport_type
  await db.prepare(`UPDATE shifts SET bill_unit_type = ?, bill_rate = ?, bill_qty = ?, unit_price = ?, pay_unit_type = ?, pay_rate = ?, pay_qty = ?, pay_amount = ?,
      break_minutes = ?, transportation_fee = ?, bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?,
      bill_adjust = ?, pay_adjust = ?, adjust_note = ?, price_locked = 1, price_source = ? WHERE shift_id = ?`)
    .bind(billUnit, billRate, billQty, Math.round((billRate || 0) * billQty), payUnit, payRate, payQty, payRate == null ? null : Math.round(payRate * payQty),
      brk, b.transportation_fee !== undefined ? (intOrNull(b.transportation_fee) ?? 0) : s.transportation_fee,
      bt, b.bill_transport_amount !== undefined ? (intOrNull(b.bill_transport_amount) ?? 0) : s.bill_transport_amount,
      pt, b.pay_transport_amount !== undefined ? (intOrNull(b.pay_transport_amount) ?? 0) : s.pay_transport_amount,
      intOrNull(b.bill_adjust) ?? s.bill_adjust ?? 0, intOrNull(b.pay_adjust) ?? s.pay_adjust ?? 0, b.adjust_note !== undefined ? (b.adjust_note || null) : s.adjust_note,
      JSON.stringify({ manual: '手動変更' }), s.shift_id).run()
  return c.json({ ok: true })
})

// 単価ルールの再適用（手動変更したシフトは対象外）
app.post('/shifts/reprice', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  if (!isDate(b.from) || !isDate(b.to)) return c.json({ error: '期間を指定してください' }, 400)
  const f: string[] = ['company_id = ?', 'work_date BETWEEN ? AND ?', 'COALESCE(price_locked,0) = 0', "COALESCE(settle_status,'planned') != 'confirmed'"]; const bind: any[] = [u.company_id, b.from, b.to]
  if (b.project_id) { f.push('project_id = ?'); bind.push(b.project_id) }
  if (b.staff_id) { f.push('staff_id = ?'); bind.push(b.staff_id) }
  const rows = (await db.prepare(`SELECT shift_id, project_id FROM shifts WHERE ${f.join(' AND ')}`).bind(...bind).all()).results as any[]
  if (b.dry_run) return c.json({ count: rows.length })
  const data = await loadPricingData(db, u.company_id, rows.map(r => r.project_id))
  for (const r of rows) await applyPricingToShift(db, u.company_id, r.shift_id, { data })
  return c.json({ ok: true, count: rows.length })
})

// 常勤の一括登録: スタッフ × 曜日 × 期間（枠なしのシフトとして登録）
app.post('/shifts/bulk', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  if (!(await ownProject(db, u.company_id, b.project_id))) return c.json({ error: '案件を選択してください' }, 400)
  const staffIds: number[] = [...new Set(((b.staff_ids || []) as any[]).map(Number).filter(Boolean))]
  if (!staffIds.length) return c.json({ error: 'スタッフを選択してください' }, 400)
  if (!isDate(b.date_from) || !isDate(b.date_to) || dayDiff(b.date_from, b.date_to) < 0) return c.json({ error: '期間を正しく入力してください' }, 400)
  if (dayDiff(b.date_from, b.date_to) > 92) return c.json({ error: '一度に登録できる期間は93日までです' }, 400)
  const wds = new Set(((b.weekdays || []) as any[]).map(Number))
  if (!wds.size) return c.json({ error: '曜日を選択してください' }, 400)
  if (!isTime(b.start_time) || !isTime(b.end_time)) return c.json({ error: '開始・終了時刻を入力してください' }, 400)
  const staffRows = (await db.prepare(`SELECT staff_id, COALESCE(affiliation_type,'own_employee') AS t FROM staff_profiles WHERE company_id = ? AND staff_id IN (${staffIds.map(() => '?').join(',')})`).bind(u.company_id, ...staffIds).all()).results as any[]
  if (staffRows.length !== staffIds.length || staffRows.some(s => s.t === 'skillsheet_only')) return c.json({ error: 'シフトを登録できないスタッフが含まれています' }, 400)
  const site = b.site_id ? await ownSite(db, u.company_id, b.site_id) : null
  const conflicts = await findConflicts(db, u.company_id, staffIds, b.date_from, b.date_to)
  const data = await loadPricingData(db, u.company_id, [b.project_id])
  let created = 0; const skipped: string[] = []
  for (let d = b.date_from; dayDiff(d, b.date_to) >= 0; d = addDays(d, 1)) {
    if (!wds.has(weekday(d))) continue
    for (const sid of staffIds) {
      if (conflictFor(conflicts.get(sid), d, b.start_time, b.end_time).length) { skipped.push(`${d} staff#${sid}`); continue }
      const res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, site_id, break_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'confirmed', ?, ?, ?)`)
        .bind(u.company_id, sid, b.project_id, d, b.start_time, b.end_time, b.location || site?.site_name || '', b.role || '販売スタッフ', intOrNull(b.transportation_fee) ?? 0, u.user_id, site?.site_id ?? null, intOrNull(b.break_minutes)).run()
      await applyPricingToShift(db, u.company_id, res.meta.last_row_id, { data })
      created++
    }
  }
  return c.json({ ok: true, created, skipped })
})

// 前週（任意の期間）のコピー: 枠と役割、割り当て（confirmed/substitute は confirmed として）をコピー
app.post('/shifts/copy-week', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  if (!isDate(b.source_from) || !isDate(b.target_from)) return c.json({ error: 'コピー元とコピー先の開始日を指定してください' }, 400)
  const days = Math.min(Math.max(Number(b.days) || 7, 1), MAX_RANGE_DAYS)
  const offset = dayDiff(b.source_from, b.target_from)
  if (offset === 0) return c.json({ error: 'コピー元とコピー先が同じです' }, 400)
  const sourceTo = addDays(b.source_from, days - 1)
  const projectIds = parseIds(b.project_ids)
  const pf = projectIds.length ? `AND project_id IN (${projectIds.map(() => '?').join(',')})` : ''
  const includeAssign = b.include_assignments !== false
  const slots = (await db.prepare(`SELECT * FROM shift_slots WHERE company_id = ? AND work_date BETWEEN ? AND ? ${pf}`).bind(u.company_id, b.source_from, sourceTo, ...projectIds).all()).results as any[]
  let slotCount = 0, shiftCount = 0; const skipped: string[] = []
  const allStaff = includeAssign ? ((await db.prepare(`SELECT DISTINCT staff_id FROM shifts WHERE company_id = ? AND work_date BETWEEN ? AND ? ${pf}`).bind(u.company_id, b.source_from, sourceTo, ...projectIds).all()).results as any[]).map(r => r.staff_id) : []
  const conflicts = await findConflicts(db, u.company_id, allStaff, b.target_from, addDays(b.target_from, days - 1))
  const pdata = await loadPricingData(db, u.company_id, [...new Set(slots.map(s => s.project_id))])
  for (const sl of slots) {
    const date = addDays(sl.work_date, offset)
    const roles = (await db.prepare('SELECT * FROM shift_slot_roles WHERE slot_id = ? ORDER BY sort_order, slot_role_id').bind(sl.slot_id).all()).results as any[]
    const newSlotId = await insertSlot(db, u, sl, date, roles, null); slotCount++
    if (!includeAssign) continue
    const newRoles = (await db.prepare('SELECT * FROM shift_slot_roles WHERE slot_id = ? ORDER BY sort_order, slot_role_id').bind(newSlotId).all()).results as any[]
    for (const [i, r] of roles.entries()) {
      const nr = newRoles[i]; if (!nr) continue
      const src = (await db.prepare("SELECT * FROM shifts WHERE slot_role_id = ? AND status IN ('confirmed','substitute')").bind(r.slot_role_id).all()).results as any[]
      for (const s of src) {
        if (conflictFor(conflicts.get(s.staff_id), date, sl.start_time, sl.end_time).length) { skipped.push(`${date} staff#${s.staff_id}`); continue }
        const res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, slot_id, slot_role_id, site_id, break_minutes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'confirmed', ?, ?, ?, ?, ?)`).bind(u.company_id, s.staff_id, sl.project_id, date, sl.start_time, sl.end_time, sl.location || s.location || '', nr.role_name, s.transportation_fee || 0, u.user_id, newSlotId, nr.slot_role_id, sl.site_id ?? null, sl.break_minutes ?? null).run()
        await applyPricingToShift(db, u.company_id, res.meta.last_row_id, { data: pdata }); shiftCount++
      }
    }
  }
  // 枠なしのシフト（常勤の従来登録）
  if (includeAssign && b.include_unslotted !== false) {
    const plain = (await db.prepare(`SELECT * FROM shifts WHERE company_id = ? AND work_date BETWEEN ? AND ? AND slot_id IS NULL AND status IN ('confirmed','substitute') ${pf}`).bind(u.company_id, b.source_from, sourceTo, ...projectIds).all()).results as any[]
    const pd2 = await loadPricingData(db, u.company_id, [...new Set(plain.map(s => s.project_id))])
    for (const s of plain) {
      const date = addDays(s.work_date, offset)
      if (conflictFor(conflicts.get(s.staff_id), date, s.start_time, s.end_time).length) { skipped.push(`${date} staff#${s.staff_id}`); continue }
      const res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, site_id, break_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'confirmed', ?, ?, ?)`).bind(u.company_id, s.staff_id, s.project_id, date, s.start_time, s.end_time, s.location || '', s.role || '販売スタッフ', s.transportation_fee || 0, u.user_id, s.site_id ?? null, s.break_minutes ?? null).run()
      await applyPricingToShift(db, u.company_id, res.meta.last_row_id, { data: pd2 }); shiftCount++
    }
  }
  return c.json({ ok: true, slots: slotCount, shifts: shiftCount, skipped })
})

// =========================================================
// 繰り返し登録
// =========================================================
app.get('/slot-patterns', async (c) => {
  const u = c.get('user')
  const pid = intOrNull(c.req.query('project_id'))
  const rows = (await c.env.DB.prepare(`SELECT sp.*, p.project_name, si.site_name,
      (SELECT COUNT(*) FROM shift_slots s WHERE s.pattern_id = sp.pattern_id) AS slot_count
    FROM slot_patterns sp JOIN projects p ON p.project_id = sp.project_id LEFT JOIN sites si ON si.site_id = sp.site_id
    WHERE sp.company_id = ? ${pid ? 'AND sp.project_id = ?' : ''} ORDER BY sp.pattern_id DESC`).bind(u.company_id, ...(pid ? [pid] : [])).all()).results as any[]
  return c.json({ patterns: rows.map(r => ({ ...r, roles: JSON.parse(r.roles_json || '[]') })) })
})
app.post('/slot-patterns', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const err = await validateSlotBody(db, u, b); if (err) return c.json({ error: err }, 400)
  const roles = normalizeRoles(b.roles); if (!roles) return c.json({ error: '役割と必要人数を入力してください' }, 400)
  const wds = [...new Set(((b.weekdays || []) as any[]).map(Number).filter(n => n >= 0 && n <= 6))]
  if (!wds.length) return c.json({ error: '曜日を選択してください' }, 400)
  if (!isDate(b.date_from) || !isDate(b.date_to) || dayDiff(b.date_from, b.date_to) < 0) return c.json({ error: '期間を正しく入力してください' }, 400)
  if (dayDiff(b.date_from, b.date_to) > 366) return c.json({ error: '期間は1年以内で指定してください' }, 400)
  if (!b.location && b.site_id) b.location = (await ownSite(db, u.company_id, b.site_id))?.site_name
  const dates: string[] = []
  for (let d = b.date_from; dayDiff(d, b.date_to) >= 0; d = addDays(d, 1)) if (wds.includes(weekday(d))) dates.push(d)
  if (!dates.length) return c.json({ error: '期間内に該当する曜日がありません' }, 400)
  if (dates.length > 160) return c.json({ error: '一度に作成できる枠は160件までです（期間を分けてください）' }, 400)
  const res = await db.prepare(`INSERT INTO slot_patterns (company_id, project_id, site_id, location, weekdays, date_from, date_to, start_time, end_time, break_minutes, roles_json, memo, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, b.project_id, b.site_id || null, b.location || null, wds.sort().join(','), b.date_from, b.date_to,
    b.start_time, b.end_time, intOrNull(b.break_minutes), JSON.stringify(roles), b.memo || null, u.user_id).run()
  const patternId = res.meta.last_row_id
  for (const d of dates) await insertSlot(db, u, b, d, roles, patternId)
  return c.json({ ok: true, pattern_id: patternId, slots: dates.length })
})
// パターンの削除: remove_future=1 なら、今日以降で割り当てのない枠も削除
app.delete('/slot-patterns/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await db.prepare('SELECT * FROM slot_patterns WHERE pattern_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!p) return c.json({ error: '繰り返し登録が見つかりません' }, 404)
  let removed = 0
  if (c.req.query('remove_future') === '1') {
    const today = c.req.query('today') && isDate(c.req.query('today')) ? c.req.query('today')! : new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
    const empties = (await db.prepare(`SELECT s.slot_id FROM shift_slots s WHERE s.pattern_id = ? AND s.work_date >= ? AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.slot_id = s.slot_id)`).bind(p.pattern_id, today).all()).results as any[]
    for (const e of empties) {
      await db.batch([db.prepare('DELETE FROM shift_slot_roles WHERE slot_id = ?').bind(e.slot_id), db.prepare('DELETE FROM shift_slots WHERE slot_id = ?').bind(e.slot_id)])
      removed++
    }
  }
  await db.batch([
    db.prepare('UPDATE shift_slots SET pattern_id = NULL WHERE pattern_id = ?').bind(p.pattern_id),
    db.prepare('DELETE FROM slot_patterns WHERE pattern_id = ?').bind(p.pattern_id),
  ])
  return c.json({ ok: true, removed })
})

// =========================================================
// 開催場所
// =========================================================
app.get('/sites', async (c) => {
  const u = c.get('user')
  const clientId = intOrNull(c.req.query('client_id'))
  const rows = (await c.env.DB.prepare(`SELECT si.*, cl.client_name,
      (SELECT COUNT(*) FROM shifts s WHERE s.site_id = si.site_id) AS shift_count
    FROM sites si LEFT JOIN clients cl ON cl.client_id = si.client_id
    WHERE si.company_id = ? ${clientId ? 'AND si.client_id = ?' : ''} ORDER BY cl.client_name, si.site_name`).bind(u.company_id, ...(clientId ? [clientId] : [])).all()).results
  return c.json({ sites: rows })
})
app.post('/sites', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!String(b.site_name || '').trim()) return c.json({ error: '開催場所名を入力してください' }, 400)
  if (b.client_id) { const cl = await c.env.DB.prepare('SELECT 1 FROM clients WHERE client_id = ? AND company_id = ?').bind(b.client_id, u.company_id).first(); if (!cl) return c.json({ error: 'クライアントが見つかりません' }, 404) }
  const res = await c.env.DB.prepare('INSERT INTO sites (company_id, client_id, site_name, address, lat, lng, memo) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(u.company_id, b.client_id || null, String(b.site_name).trim(), b.address || null, b.lat ?? null, b.lng ?? null, b.memo || null).run()
  return c.json({ ok: true, site_id: res.meta.last_row_id })
})
app.put('/sites/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const s = await ownSite(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: '開催場所が見つかりません' }, 404)
  await c.env.DB.prepare('UPDATE sites SET site_name = ?, address = ?, memo = ?, status = ? WHERE site_id = ?')
    .bind(String(b.site_name ?? s.site_name).trim() || s.site_name, b.address ?? s.address, b.memo ?? s.memo, b.status === 'inactive' ? 'inactive' : 'active', s.site_id).run()
  return c.json({ ok: true })
})
app.delete('/sites/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await ownSite(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: '開催場所が見つかりません' }, 404)
  const used = await db.prepare('SELECT (SELECT COUNT(*) FROM shifts WHERE site_id = ?) + (SELECT COUNT(*) FROM shift_slots WHERE site_id = ?) AS n').bind(s.site_id, s.site_id).first() as any
  if (used.n > 0) { await db.prepare("UPDATE sites SET status = 'inactive' WHERE site_id = ?").bind(s.site_id).run(); return c.json({ ok: true, deactivated: true }) }
  await db.batch([db.prepare('DELETE FROM rate_rules WHERE site_id = ? AND company_id = ?').bind(s.site_id, u.company_id), db.prepare('DELETE FROM sites WHERE site_id = ?').bind(s.site_id)])
  return c.json({ ok: true })
})

// =========================================================
// 単価ルール・案件の単価設定
// =========================================================
function ruleValues(b: any) {
  return {
    // 単価を指定して単位を省略した場合は日額（案件の単位を引き継ぐと、日額の金額が時給として計算されるため）
    bill_unit_type: b.bill_unit_type === 'hourly' ? 'hourly' : b.bill_unit_type === 'daily' || intOrNull(b.bill_rate) != null ? 'daily' : null,
    bill_rate: intOrNull(b.bill_rate),
    pay_unit_type: b.pay_unit_type === 'hourly' ? 'hourly' : b.pay_unit_type === 'daily' || intOrNull(b.pay_rate) != null ? 'daily' : null,
    pay_rate: intOrNull(b.pay_rate),
    bill_transport_type: BILL_TRANSPORT_TYPES.includes(b.bill_transport_type) ? b.bill_transport_type : null,
    bill_transport_amount: intOrNull(b.bill_transport_amount),
    pay_transport_type: PAY_TRANSPORT_TYPES.includes(b.pay_transport_type) ? b.pay_transport_type : null,
    pay_transport_amount: intOrNull(b.pay_transport_amount),
  }
}
app.get('/rate-rules', async (c) => {
  const u = c.get('user')
  const pid = intOrNull(c.req.query('project_id')), sid = intOrNull(c.req.query('staff_id'))
  const f: string[] = ['r.company_id = ?']; const b: any[] = [u.company_id]
  if (pid) { f.push('(r.project_id = ? OR (r.project_id IS NULL AND r.staff_id IS NOT NULL))'); b.push(pid) }
  if (sid) { f.push('r.staff_id = ?'); b.push(sid) }
  const rows = (await c.env.DB.prepare(`SELECT r.*, p.project_name, si.site_name, us.name AS staff_name
    FROM rate_rules r LEFT JOIN projects p ON p.project_id = r.project_id LEFT JOIN sites si ON si.site_id = r.site_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = r.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE ${f.join(' AND ')} ORDER BY r.project_id, r.site_id, r.role_name, r.staff_id`).bind(...b).all()).results
  return c.json({ rules: rows })
})
async function validateRuleScope(db: D1Database, u: any, b: any): Promise<string | null> {
  if (!b.project_id && !b.staff_id) return '案件またはスタッフを指定してください'
  if (b.project_id && !(await ownProject(db, u.company_id, b.project_id))) return '案件が見つかりません'
  if (b.site_id && !(await ownSite(db, u.company_id, b.site_id))) return '開催場所が見つかりません'
  if (b.staff_id && !(await db.prepare('SELECT 1 FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(b.staff_id, u.company_id).first())) return 'スタッフが見つかりません'
  const v = ruleValues(b)
  if (v.bill_rate == null && v.pay_rate == null && !v.bill_transport_type && !v.pay_transport_type) return '単価または交通費ルールを1つ以上入力してください'
  return null
}
app.post('/rate-rules', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const err = await validateRuleScope(c.env.DB, u, b); if (err) return c.json({ error: err }, 400)
  const v = ruleValues(b)
  const res = await c.env.DB.prepare(`INSERT INTO rate_rules (company_id, project_id, site_id, role_name, staff_id, bill_unit_type, bill_rate, pay_unit_type, pay_rate,
      bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.project_id || null, b.site_id || null, String(b.role_name || '').trim() || null, b.staff_id || null,
      v.bill_unit_type, v.bill_rate, v.pay_unit_type, v.pay_rate, v.bill_transport_type, v.bill_transport_amount, v.pay_transport_type, v.pay_transport_amount, b.memo || null).run()
  return c.json({ ok: true, rule_id: res.meta.last_row_id })
})
app.put('/rate-rules/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const r = await c.env.DB.prepare('SELECT * FROM rate_rules WHERE rule_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!r) return c.json({ error: 'ルールが見つかりません' }, 404)
  const merged = { ...r, ...b }
  const err = await validateRuleScope(c.env.DB, u, merged); if (err) return c.json({ error: err }, 400)
  const v = ruleValues(merged)
  await c.env.DB.prepare(`UPDATE rate_rules SET project_id = ?, site_id = ?, role_name = ?, staff_id = ?, bill_unit_type = ?, bill_rate = ?, pay_unit_type = ?, pay_rate = ?,
      bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?, memo = ? WHERE rule_id = ?`)
    .bind(merged.project_id || null, merged.site_id || null, String(merged.role_name || '').trim() || null, merged.staff_id || null,
      v.bill_unit_type, v.bill_rate, v.pay_unit_type, v.pay_rate, v.bill_transport_type, v.bill_transport_amount, v.pay_transport_type, v.pay_transport_amount, merged.memo || null, r.rule_id).run()
  return c.json({ ok: true })
})
app.delete('/rate-rules/:id', async (c) => {
  const u = c.get('user')
  await c.env.DB.prepare('DELETE FROM rate_rules WHERE rule_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})
// 適用結果のプレビュー
app.get('/rate-rules/resolve', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const pid = intOrNull(c.req.query('project_id'))
  if (!pid || !(await ownProject(db, u.company_id, pid))) return c.json({ error: '案件を指定してください' }, 400)
  const data = await loadPricingData(db, u.company_id, [pid])
  const price = resolvePrice({ company_id: u.company_id, project_id: pid, site_id: intOrNull(c.req.query('site_id')), role_name: c.req.query('role_name') || null, staff_id: intOrNull(c.req.query('staff_id')) }, data)
  const start = isTime(c.req.query('start_time')) ? c.req.query('start_time')! : '10:00', end = isTime(c.req.query('end_time')) ? c.req.query('end_time')! : '19:00'
  const brk = intOrNull(c.req.query('break_minutes')) ?? data.projects.get(pid)?.default_break_minutes ?? 60
  return c.json({ price, amounts: calcAmounts(price, start, end, brk) })
})

app.put('/projects/:id/pricing', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const p = await ownProject(c.env.DB, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const eng = b.engagement_type === 'spot' ? 'spot' : b.engagement_type === 'regular' ? 'regular' : (p.engagement_type || 'regular')
  const unit = (v: any, d: string) => (v === 'hourly' ? 'hourly' : v === 'daily' ? 'daily' : d)
  const basis = HOURS_BASIS.includes(b.hours_basis) ? b.hours_basis : (p.hours_basis || 'clipped')
  const roundMin = [0, 1, 5, 10, 15, 30].includes(Number(b.time_round_minutes)) ? Number(b.time_round_minutes) : (p.time_round_minutes || 0)
  await c.env.DB.prepare(`UPDATE projects SET engagement_type = ?, unit_price_type = ?, unit_price = ?, pay_unit_type = ?, pay_rate = ?,
      bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?, default_break_minutes = ?, hours_basis = ?, time_round_minutes = ? WHERE project_id = ?`)
    .bind(eng, unit(b.unit_price_type, p.unit_price_type === 'hourly' ? 'hourly' : 'daily'), intOrNull(b.unit_price) ?? p.unit_price ?? 0,
      unit(b.pay_unit_type, p.pay_unit_type || 'daily'), b.pay_rate !== undefined ? intOrNull(b.pay_rate) : p.pay_rate,
      BILL_TRANSPORT_TYPES.includes(b.bill_transport_type) ? b.bill_transport_type : (p.bill_transport_type || 'actual'),
      intOrNull(b.bill_transport_amount) ?? p.bill_transport_amount ?? 0,
      PAY_TRANSPORT_TYPES.includes(b.pay_transport_type) ? b.pay_transport_type : (p.pay_transport_type || 'actual'),
      intOrNull(b.pay_transport_amount) ?? p.pay_transport_amount ?? 0,
      intOrNull(b.default_break_minutes) ?? p.default_break_minutes ?? 60, basis, roundMin, p.project_id).run()
  return c.json({ ok: true })
})

export default app
