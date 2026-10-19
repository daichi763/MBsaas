// =========================================================
// 常勤・スポット案件のシフトボード / 募集枠 / 単価（請求・支払）
// docs/spec_spot_shift.md 第1段階
//
// api.ts とのコンフリクトを避けるため新規APIはこのファイルにまとめ、
// api.ts からは api.route('/admin', shiftBoardApi) で認証・権限ミドルウェアの後に登録する。
// 金額（請求・支払・粗利）は管理画面（/api/admin/*）でのみ返す。
// =========================================================
import { Hono } from 'hono'
import { JSON_IN, batchInChunks, bindJsonArray } from './lib/d1-chunk'
import { assertAssignable, assignableStaffSql, conflictFor, conflictLabel, conflictView, findConflicts, isUniqueViolation, ngStaffIds } from './lib/staff-eligibility'
import type { ConflictRow } from './lib/staff-eligibility'
import { changesOf, insertRowsStmts, updateRowsStmts } from './lib/bulk-write'

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
  // 案件IDは json_each で1つにまとめてバインドする（D1 のバインド上限 100 を超えないように）
  const ids = bindJsonArray(projectIds)
  const projects = ids !== '[]' ? (await db.prepare(`SELECT project_id, unit_price_type, unit_price, pay_unit_type, pay_rate,
      bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount, default_break_minutes, hours_basis, time_round_minutes
      FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(companyId, ids).all()).results as any[] : []
  const rules = (await db.prepare(`SELECT * FROM rate_rules WHERE company_id = ? AND (project_id IS NULL OR project_id IN ${JSON_IN})`)
    .bind(companyId, ids).all()).results as any[]
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
// 時給の金額は、分単位の時間に単価を掛けてから円に丸める（小数2桁に丸めた時間に掛けると、分単位の勤務で数円ずれるため）。
// 数量は表示用に小数2桁に丸める。hoursOverride は workHours の hours（小数2桁）でよい（実働は分単位なので、60 を掛けて丸めると元の分数に戻る）
export function calcAmounts(price: Pick<ResolvedPrice, 'bill_unit_type' | 'bill_rate' | 'pay_unit_type' | 'pay_rate'>, start: string, end: string, breakMin: number, hoursOverride?: number | null) {
  const minutes = hoursOverride != null ? Math.max(0, Math.round(hoursOverride * 60)) : Math.max(0, spanMinutes(start, end) - (breakMin || 0))
  const hourly = (u: string) => u === 'hourly'
  const qty = (u: string) => (hourly(u) ? Math.round(minutes / 60 * 100) / 100 : 1)
  const amount = (u: string, rate: number) => (hourly(u) ? Math.round(rate * minutes / 60) : Math.round(rate))
  return {
    bill_qty: qty(price.bill_unit_type), unit_price: amount(price.bill_unit_type, price.bill_rate || 0),
    pay_qty: qty(price.pay_unit_type), pay_amount: price.pay_rate == null ? null : amount(price.pay_unit_type, price.pay_rate),
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
  // planned_break_minutes = 予定の休憩、break_minutes = 実働の計算に使った休憩（実績の休憩があればその値）
  if (!hasActual) return { hours: round2(planned), planned_hours: round2(planned), actual_hours: null as number | null, basis, used: 'planned' as const, break_minutes: brkPlan, planned_break_minutes: brkPlan }
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
  return { hours: round2(hours), planned_hours: round2(planned), actual_hours: round2(actual), basis, used: basis === 'scheduled' ? 'planned' as const : 'actual' as const, break_minutes: brk, planned_break_minutes: brkPlan }
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
// workDate を渡すと、その日より後に適用した区分変更があれば変更前の支払先を返す（適用日より前のシフトを計算し直しても、
// 新しい区分の支払先にしない。#82）。変更前の支払先を記録していない履歴（0039 より前の変更・統合の記録）なら、今の区分から決める。
// 区分が変わらない記録（支払先の付け直し）は見ない
export async function resolvePayee(db: D1Database, companyId: number, staffId: number, workDate?: string | null) {
  if (workDate) {
    const h = await db.prepare(`SELECT from_payee_type, from_payee_affiliation_id, from_payee_company_id FROM staff_affiliation_history
      WHERE staff_id = ? AND company_id = ? AND from_type != 'new' AND (from_type != to_type OR from_payee_type IS NOT NULL) AND effective_date > ?
      ORDER BY effective_date, history_id LIMIT 1`).bind(staffId, companyId, workDate).first() as any
    if (h?.from_payee_type) return { payee_type: h.from_payee_type as string, payee_affiliation_id: (h.from_payee_affiliation_id ?? null) as number | null, payee_company_id: (h.from_payee_company_id ?? null) as number | null }
  }
  const sp = await db.prepare('SELECT affiliation_type, partner_affiliation_id, owner_company_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).first() as any
  return payeeFromProfile(sp)
}
export type Payee = { payee_type: string; payee_affiliation_id: number | null; payee_company_id: number | null }
// staff_profiles の行（affiliation_type, partner_affiliation_id, owner_company_id）から支払先を決める。一括処理では、まとめて読んだ行を渡す
export function payeeFromProfile(sp: any): Payee {
  const t = sp?.affiliation_type || 'own_employee'
  if (t === 'linked_external') return { payee_type: 'linked', payee_affiliation_id: null, payee_company_id: sp.owner_company_id ?? null }
  if (t === 'partner_manual') return { payee_type: 'partner', payee_affiliation_id: sp.partner_affiliation_id ?? null, payee_company_id: null }
  // 第2段階: 個人事業主（本人へ業務委託費）/ 自社日雇い（日雇いの給与）
  if (t === 'freelance') return { payee_type: 'freelance', payee_affiliation_id: null, payee_company_id: null }
  if (t === 'daily_worker') return { payee_type: 'payroll_daily', payee_affiliation_id: null, payee_company_id: null }
  return { payee_type: 'payroll', payee_affiliation_id: null, payee_company_id: null }
}

// 区分変更の履歴（resolvePayee と同じ条件の行）をスタッフごとにまとめて読む。一括処理（再適用・一括登録・コピー）で payeeOn に渡す
export async function loadPayeeHistory(db: D1Database, companyId: number, staffIds: number[]) {
  const map = new Map<number, any[]>()
  const ids = bindJsonArray(staffIds)
  if (ids === '[]') return map
  const rows = (await db.prepare(`SELECT staff_id, effective_date, from_payee_type, from_payee_affiliation_id, from_payee_company_id FROM staff_affiliation_history
    WHERE company_id = ? AND staff_id IN ${JSON_IN} AND from_type != 'new' AND (from_type != to_type OR from_payee_type IS NOT NULL)
    ORDER BY staff_id, effective_date, history_id`).bind(companyId, ids).all()).results as any[]
  for (const r of rows) { const a = map.get(r.staff_id) || []; a.push(r); map.set(r.staff_id, a) }
  return map
}
// その日のシフトの支払先（resolvePayee と同じ規則）。sp は staff_profiles の行、hist は loadPayeeHistory で読んだそのスタッフの履歴
export function payeeOn(sp: any, hist: any[] | undefined, workDate: string): Payee {
  const h = hist?.find(x => x.effective_date > workDate)
  if (h?.from_payee_type) return { payee_type: h.from_payee_type as string, payee_affiliation_id: (h.from_payee_affiliation_id ?? null) as number | null, payee_company_id: (h.from_payee_company_id ?? null) as number | null }
  return payeeFromProfile(sp)
}
// シフトの単価・金額・支払先を計算する（書き込みはしない）。s は shifts の行（これから登録する行でもよい）
export const PRICE_COLUMNS = ['bill_unit_type', 'bill_rate', 'bill_qty', 'unit_price', 'pay_unit_type', 'pay_rate', 'pay_qty', 'pay_amount',
  'bill_transport_type', 'bill_transport_amount', 'pay_transport_type', 'pay_transport_amount',
  'payee_type', 'payee_affiliation_id', 'payee_company_id', 'price_source', 'price_locked']
export function computeShiftPricing(companyId: number, s: any, slotRole: any, payee: Payee, data: { projects: Map<number, any>; rules: any[] }) {
  const price = resolvePrice({ company_id: companyId, project_id: s.project_id, site_id: s.site_id, role_name: s.role, staff_id: s.staff_id, slot_role: slotRole }, data)
  const proj = data.projects.get(Number(s.project_id)) || {}
  const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
  const amt = calcAmounts(price, s.start_time, s.end_time, brk, workHours({ ...s, break_minutes: brk }, proj).hours)
  return {
    bill_unit_type: price.bill_unit_type, bill_rate: price.bill_rate, bill_qty: amt.bill_qty, unit_price: amt.unit_price,
    pay_unit_type: price.pay_unit_type, pay_rate: price.pay_rate, pay_qty: amt.pay_qty, pay_amount: amt.pay_amount,
    bill_transport_type: price.bill_transport_type, bill_transport_amount: price.bill_transport_amount,
    pay_transport_type: price.pay_transport_type, pay_transport_amount: price.pay_transport_amount,
    payee_type: payee.payee_type, payee_affiliation_id: payee.payee_affiliation_id, payee_company_id: payee.payee_company_id,
    price_source: JSON.stringify(price.sources), price_locked: 0,
  } as Record<string, any>
}

// シフトの単価・金額・支払先を計算して書き込む（price_locked のシフトは金額を変えない）。
// 1件ごとに問い合わせるため、多くのシフトをまとめて処理するとき（再適用・一括登録・コピー）は computeShiftPricing で計算し、まとめて書き込む
export async function applyPricingToShift(db: D1Database, companyId: number, shiftId: number, opts: { force?: boolean; data?: any } = {}) {
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s) return
  if (isSettled(s)) return // 確定済みは変更しない
  if (s.price_locked && !opts.force) return
  const data = opts.data || await loadPricingData(db, companyId, [s.project_id])
  const slotRole = s.slot_role_id ? await db.prepare('SELECT * FROM shift_slot_roles WHERE slot_role_id = ?').bind(s.slot_role_id).first() : null
  const v = computeShiftPricing(companyId, s, slotRole, await resolvePayee(db, companyId, s.staff_id, s.work_date), data)
  await db.prepare(`UPDATE shifts SET ${PRICE_COLUMNS.map(k => `${k} = ?`).join(', ')} WHERE shift_id = ? AND company_id = ?`)
    .bind(...PRICE_COLUMNS.map(k => v[k]), shiftId, companyId).run()
}

// ---------- 一括処理（再適用・一括登録・コピー）の共通部分 ----------
// 1回の呼び出しで処理する件数の上限。超えた分は next_cursor を返し、画面から続きを呼ぶ
const BULK_LIMIT = 1000
const bulkLimit = (v: any) => Math.max(1, Math.min(BULK_LIMIT, Number(v) || BULK_LIMIT))

// 割当の確認に使うスタッフの情報（割当可能な条件は staff-eligibility の assignableStaffSql と同じ）と支払先の決定に使う列
async function loadStaffForAssign(db: D1Database, companyId: number, staffIds: number[]) {
  const map = new Map<number, any>()
  const ids = bindJsonArray(staffIds)
  if (ids === '[]') return map
  const elig = assignableStaffSql({ sp: 'sp', us: 'us' })
  const rows = (await db.prepare(`SELECT sp.staff_id, us.name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.partner_affiliation_id, sp.owner_company_id,
      sp.merged_into_staff_id, sp.employment_status, us.status AS user_status, us.retired_at, CASE WHEN ${elig.sql} THEN 1 ELSE 0 END AS assignable
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND sp.staff_id IN ${JSON_IN}`)
    .bind(...elig.binds, companyId, ids).all()).results as any[]
  for (const r of rows) map.set(r.staff_id, r)
  return map
}
// その日にシフトを入れられない理由（入れられるなら null）。退職日の当日は稼働可
function ineligibleReason(st: any, date: string): string | null {
  if (!st) return 'スタッフが見つかりません'
  if (st.merged_into_staff_id) return '統合済み'
  if (st.affiliation_type === 'skillsheet_only') return 'スキルシートのみ'
  if (st.employment_status === 'retired' || (st.retired_at && String(st.retired_at).slice(0, 10) < date)) return '退職'
  if (st.user_status !== 'active') return '停止中'
  if (!st.assignable) return '割当できない状態'
  return null
}
// 案件ごとの NG スタッフ（クライアントの ng_staff_ids）
async function ngByProjects(db: D1Database, companyId: number, projectIds: number[]) {
  const map = new Map<number, number[]>()
  const ids = bindJsonArray(projectIds)
  if (ids === '[]') return map
  const rows = (await db.prepare(`SELECT p.project_id, cl.ng_staff_ids FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    WHERE p.company_id = ? AND p.project_id IN ${JSON_IN}`).bind(companyId, ids).all()).results as any[]
  for (const r of rows) map.set(r.project_id, parseIds(r.ng_staff_ids))
  return map
}
// 一括処理で登録する予定のシフトを、後続の重複チェックに加える（同じ呼び出しの中で重ならないように）
let plannedSeq = 0
function addPlannedConflict(conflicts: Map<number, ConflictRow[]>, companyId: number, staffId: number, date: string, start: string, end: string, projectName: string | null) {
  const a = conflicts.get(staffId) || []
  a.push({ my_staff_id: staffId, shift_id: -(++plannedSeq), slot_role_id: null, staff_id: staffId, company_id: companyId, work_date: date, start_time: start, end_time: end, status: 'confirmed', project_name: projectName })
  conflicts.set(staffId, a)
}
type Skipped = { date: string; staff_id: number; staff_name: string; reason: string; detail?: string; project_name?: string | null; start_time?: string; end_time?: string; slot_role_id?: number | null }
// 登録するシフトの列（単価の列 PRICE_COLUMNS と合わせて INSERT する）
const SHIFT_INSERT_COLUMNS = ['company_id', 'staff_id', 'project_id', 'work_date', 'start_time', 'end_time', 'location', 'role', 'transportation_fee', 'status',
  'registered_by', 'slot_id', 'slot_role_id', 'site_id', 'break_minutes', 'source_shift_id', ...PRICE_COLUMNS]

// ---------- 共通の確認 ----------
async function ownProject(db: D1Database, companyId: number, projectId: any) {
  return db.prepare('SELECT * FROM projects WHERE project_id = ? AND company_id = ?').bind(projectId, companyId).first() as Promise<any>
}
async function ownSlot(db: D1Database, companyId: number, slotId: any) {
  return db.prepare('SELECT * FROM shift_slots WHERE slot_id = ? AND company_id = ?').bind(slotId, companyId).first() as Promise<any>
}
export async function ownSlotRole(db: D1Database, companyId: number, slotRoleId: any) {
  return db.prepare(`SELECT r.*, s.company_id, s.project_id, s.site_id, s.location, s.work_date, s.start_time, s.end_time, s.break_minutes
    FROM shift_slot_roles r JOIN shift_slots s ON s.slot_id = r.slot_id WHERE r.slot_role_id = ? AND s.company_id = ?`).bind(slotRoleId, companyId).first() as Promise<any>
}
async function ownSite(db: D1Database, companyId: number, siteId: any) {
  if (!siteId) return null
  return db.prepare('SELECT * FROM sites WHERE site_id = ? AND company_id = ?').bind(siteId, companyId).first() as Promise<any>
}
function parseIds(v: any): number[] { return String(v || '').split(',').map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0) }

// ---------- 重複・NGチェック ----------
// 本体は src/lib/staff-eligibility.ts（他社の会社名を出さない重複チェックと、割当可能な条件）。既存の import のため再エクスポートする
export { findConflicts, conflictFor, ngStaffIds }

// =========================================================
// スタッフのシフト希望（shift_requests。#12 #353）
// 希望はシフトではないので、ここでは採用・見送りの返事だけを記録する。シフトは枠への割り当てなど通常の経路で登録する
// =========================================================
const SHIFT_REQUEST_MAX_RANGE_DAYS = 92
app.get('/shift-requests', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const from = isDate(c.req.query('from')) ? c.req.query('from')! : new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  let to = isDate(c.req.query('to')) ? c.req.query('to')! : addDays(from, 30)
  if (dayDiff(from, to) < 0) to = from
  if (dayDiff(from, to) > SHIFT_REQUEST_MAX_RANGE_DAYS - 1) to = addDays(from, SHIFT_REQUEST_MAX_RANGE_DAYS - 1)
  const onlyPending = c.req.query('status') !== 'all'
  const rows = (await db.prepare(`
    SELECT r.request_id, r.staff_id, r.project_id, r.work_date, r.start_time, r.end_time, r.memo, r.status, r.response_note, r.responded_at, r.withdrawn_at, r.created_at,
      us.name AS staff_name, p.project_name, rb.name AS responded_by_name,
      (SELECT COUNT(*) FROM shifts s WHERE s.company_id = r.company_id AND s.staff_id = r.staff_id AND s.work_date = r.work_date AND s.status IN ('requested','confirmed','substitute')) AS shifts_on_date
    FROM shift_requests r JOIN staff_profiles sp ON sp.staff_id = r.staff_id AND sp.company_id = r.company_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id
    LEFT JOIN users rb ON rb.user_id = r.responded_by
    WHERE r.company_id = ? AND r.work_date BETWEEN ? AND ? ${onlyPending ? "AND r.status = 'pending'" : ''}
    ORDER BY r.work_date, r.start_time, us.name, r.request_id LIMIT 500`).bind(u.company_id, from, to).all()).results
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM shift_requests WHERE company_id = ? AND work_date BETWEEN ? AND ? AND status = 'pending'`).bind(u.company_id, from, to).first() as any
  return c.json({ from, to, requests: rows, pending: n?.n || 0 })
})

// 採用（accept）・見送り（decline）の返事。返事待ちのものだけ（本人が取り下げた後や二重の返事は 409）
app.post('/shift-requests/:id/respond', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const status = b.decision === 'accept' ? 'accepted' : b.decision === 'decline' ? 'declined' : null
  if (!status) return c.json({ error: '採用か見送りを選んでください' }, 400)
  if (b.note != null && typeof b.note !== 'string') return c.json({ error: '返事の内容が正しくありません' }, 400)
  const note = String(b.note || '').trim()
  if (note.length > 500) return c.json({ error: '返事は500文字以内で入力してください' }, 400)
  const req = await db.prepare('SELECT request_id, status FROM shift_requests WHERE request_id = ? AND company_id = ?').bind(intOrNull(c.req.param('id')), u.company_id).first() as any
  if (!req) return c.json({ error: '希望が見つかりません' }, 404)
  const r = await db.prepare(`UPDATE shift_requests SET status = ?, response_note = ?, responded_by = ?, responded_at = datetime('now', '+9 hours')
    WHERE request_id = ? AND company_id = ? AND status = 'pending'`).bind(status, note || null, u.user_id, req.request_id, u.company_id).run()
  if (!r.meta.changes) return c.json({ error: req.status === 'withdrawn' ? '本人が取り下げた希望です' : 'すでに返事をした希望です' }, 409)
  return c.json({ ok: true, status })
})

// =========================================================
// シフトボード
// =========================================================
// その日を含む週の月曜日（シフトボードの週は月曜始まり。#528）
function weekStart(d: string): string { return addDays(d, -((weekday(d) + 6) % 7)) }
// 割り当て済みのシフトの人が、その稼働日に働けない理由（働けるなら null）。#500
// 退職日があれば稼働日と比べる（退職日の当日までは稼働可。退職の保存と同時にログインは止まるため、ログインの状態だけでは判定しない）
type StaffState = { employment_status?: string | null; user_status?: string | null; retired_at?: string | null; link_ended_at?: string | null }
function retiredOn(workDate: string, st: StaffState): string | null {
  if (st.retired_at) return String(st.retired_at).slice(0, 10) < workDate ? '退職' : null
  if (st.employment_status === 'retired') return '退職'
  if (st.user_status && st.user_status !== 'active') return '停止中'
  return null
}
function unavailableOn(workDate: string, affiliationType: string, st: StaffState, emp: StaffState): string | null {
  if (affiliationType === 'linked_external' && emp.user_status != null && retiredOn(workDate, emp)) return '所属元で退職'
  if (st.link_ended_at) return '取引終了'
  return retiredOn(workDate, st)
}
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
  if (projectIds.length) { pf.push(`p.project_id IN ${JSON_IN}`); pb.push(bindJsonArray(projectIds)) }
  if (engagement === 'regular' || engagement === 'spot') { pf.push("COALESCE(p.engagement_type,'regular') = ?"); pb.push(engagement) }
  const projects = (await db.prepare(`SELECT p.project_id, p.project_name, p.client_id, cl.client_name, p.status, COALESCE(p.engagement_type,'regular') AS engagement_type, p.location
    FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id WHERE ${pf.join(' AND ')} ORDER BY cl.client_name, p.project_name`).bind(...pb).all()).results as any[]
  const pids = projects.map(p => p.project_id)
  const empty = { from, to, projects, slots: [], unslotted: [], staff: [], totals: { bill: 0, pay: 0, profit: 0, profit_bill: 0, required: 0, filled: 0, pay_missing: 0, pay_missing_bill: 0, by_date: {} } }
  if (!pids.length) return c.json(empty)
  // 案件・枠のIDは1つずつバインドしない（D1 のバインド上限 100）。案件は同じ絞り込みのサブクエリ、枠は json_each で渡す
  const inP = `(SELECT p.project_id FROM projects p WHERE ${pf.join(' AND ')})`

  const slotRows = (await db.prepare(`SELECT sl.*, si.site_name FROM shift_slots sl LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE sl.company_id = ? AND sl.project_id IN ${inP} AND sl.work_date BETWEEN ? AND ? ${siteId ? 'AND sl.site_id = ?' : ''}
    ORDER BY sl.work_date, sl.start_time`).bind(u.company_id, ...pb, from, to, ...(siteId ? [siteId] : [])).all()).results as any[]
  const slotIds = slotRows.map(s => s.slot_id)
  // 募集の未対応の応募数（第4段階。src/recruit.ts）を役割ごとに持たせる
  const roles = slotIds.length ? (await db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
      WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending' AND a.status = 'pending') AS applicants
    FROM shift_slot_roles r WHERE r.slot_id IN ${JSON_IN} ORDER BY r.sort_order, r.slot_role_id`).bind(bindJsonArray(slotIds)).all()).results as any[] : []

  // 退職などで稼働できない人のシフトに印を付けるため、在籍状況（他社連携は所属元も）を一緒に読む（#500）
  const shiftRows = (await db.prepare(`
    SELECT s.*, us.name AS staff_name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, si.site_name,
      COALESCE(sp.employment_status,'working') AS st_employment_status, us.status AS st_user_status, us.retired_at AS st_retired_at, sp.link_ended_at AS st_link_ended_at,
      COALESCE(emp_sp.employment_status,'working') AS st_emp_status, emp_us.status AS st_emp_user_status, emp_us.retired_at AS st_emp_retired_at
    FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles emp_sp ON sp.affiliation_type = 'linked_external' AND emp_sp.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN users emp_us ON emp_us.user_id = emp_sp.user_id
    LEFT JOIN sites si ON si.site_id = s.site_id
    WHERE s.company_id = ? AND s.project_id IN ${inP} AND s.work_date BETWEEN ? AND ? ${siteId ? 'AND s.site_id = ?' : ''}
    ORDER BY s.work_date, s.start_time, us.name`).bind(u.company_id, ...pb, from, to, ...(siteId ? [siteId] : [])).all()).results as any[]

  const conflicts = await findConflicts(db, u.company_id, shiftRows.map(s => s.staff_id), from!, to!)
  const ngByProject = new Map<number, number[]>()
  for (const p of projects) ngByProject.set(p.project_id, [])
  const ngRows = (await db.prepare(`SELECT p.project_id, cl.ng_staff_ids FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id WHERE p.company_id = ? AND p.project_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(pids)).all()).results as any[]
  for (const r of ngRows) ngByProject.set(r.project_id, parseIds(r.ng_staff_ids))

  // 粗利は支払が決まっているシフトだけで計算する（profit_bill = その請求額）。支払単価が未設定のシフトは件数と請求額を pay_missing* に出す
  // by_date: 日ごとの必要人数・充足・希望（#566。充足は退職などで稼働できない人を数えない）
  const totals = { bill: 0, pay: 0, profit: 0, profit_bill: 0, required: 0, filled: 0, pay_missing: 0, pay_missing_bill: 0,
    by_date: {} as Record<string, { required: number; filled: number; requested: number }> }
  const decorate = (raw: any) => {
    const { st_employment_status, st_user_status, st_retired_at, st_link_ended_at, st_emp_status, st_emp_user_status, st_emp_retired_at, ...s } = raw
    const t = shiftTotals(s)
    const active = ['confirmed', 'substitute'].includes(s.status)
    if (active) {
      totals.bill += t.bill_total
      if (t.pay_total == null) { totals.pay_missing++; totals.pay_missing_bill += t.bill_total } else { totals.pay += t.pay_total; totals.profit_bill += t.bill_total }
    }
    const cf = conflictFor(conflicts.get(s.staff_id), s.work_date, s.start_time, s.end_time, s.shift_id)
    return {
      ...s, ...t,
      conflicts: cf.map(x => conflictView(x, u.company_id)),
      ng: (ngByProject.get(s.project_id) || []).includes(s.staff_id),
      unavailable: unavailableOn(s.work_date, s.affiliation_type, { employment_status: st_employment_status, user_status: st_user_status, retired_at: st_retired_at, link_ended_at: st_link_ended_at },
        { employment_status: st_emp_status, user_status: st_emp_user_status, retired_at: st_emp_retired_at }),
    }
  }
  const byRole = new Map<number, any[]>(); const unslotted: any[] = []
  for (const s of shiftRows) {
    const d = decorate(s)
    if (s.slot_role_id) { const a = byRole.get(s.slot_role_id) || []; a.push(d); byRole.set(s.slot_role_id, a) } else unslotted.push(d)
  }
  const rolesBySlot = new Map<number, any[]>()
  const slotDate = new Map<number, string>(slotRows.map(s => [s.slot_id, s.work_date]))
  for (const r of roles) {
    const assigned = byRole.get(r.slot_role_id) || []
    // 退職などで稼働できない人は充足に数えない（枠が空いていることに気づけるように #500）
    const filled = assigned.filter(a => ['confirmed', 'substitute'].includes(a.status) && !a.unavailable).length
    const requested = assigned.filter(a => a.status === 'requested').length
    totals.required += r.headcount; totals.filled += Math.min(filled, r.headcount)
    const d = slotDate.get(r.slot_id)
    if (d) {
      const t = totals.by_date[d] || (totals.by_date[d] = { required: 0, filled: 0, requested: 0 })
      t.required += r.headcount; t.filled += Math.min(filled, r.headcount); t.requested += requested
    }
    const arr = rolesBySlot.get(r.slot_id) || []; arr.push({ ...r, assigned, filled, requested }); rolesBySlot.set(r.slot_id, arr)
  }
  const slots = slotRows.map(s => ({ ...s, roles: rolesBySlot.get(s.slot_id) || [] }))
  // 割り当てのない役割のシフトが消えた枠でも、役割に孤立したシフトがあれば枠なし扱いにする
  const knownRoles = new Set(roles.map(r => r.slot_role_id))
  for (const [rid, list] of byRole) if (!knownRoles.has(rid)) unslotted.push(...list)
  totals.profit = totals.profit_bill - totals.pay
  return c.json({ from, to, projects, slots, unslotted, totals })
})

// 候補スタッフ（枠の役割に対して）
app.get('/shift-board/candidates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const role = await ownSlotRole(db, u.company_id, c.req.query('slot_role_id'))
  if (!role) return c.json({ error: '枠が見つかりません' }, 404)
  const proj = await ownProject(db, u.company_id, role.project_id)
  const elig = assignableStaffSql({ sp: 'sp', us: 'us', onDate: role.work_date })
  const staff = (await db.prepare(`
    SELECT sp.staff_id, us.name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.employment_status,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.skills ELSE sp.skills END AS skills,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.work_area ELSE sp.work_area END AS work_area,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.available_from ELSE sp.available_from END AS available_from,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.project_id = ? AND s.status IN ('confirmed','substitute')) AS project_count,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.site_id = ? AND s.site_id IS NOT NULL AND s.status IN ('confirmed','substitute')) AS site_count,
      (SELECT COUNT(DISTINCT s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date BETWEEN ? AND ? AND s.status IN ('confirmed','substitute')) AS week_days
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    WHERE sp.company_id = ? AND ${elig.sql}
    ORDER BY us.name`).bind(role.project_id, role.site_id ?? -1, weekStart(role.work_date), addDays(weekStart(role.work_date), 6), u.company_id, ...elig.binds).all()).results as any[]
  const conflicts = await findConflicts(db, u.company_id, staff.map(s => s.staff_id), role.work_date, role.work_date)
  const ng = await ngStaffIds(db, role.project_id)
  const required = String(proj?.required_skills || '').split(',').map(s => s.trim()).filter(Boolean)
  const assigned = new Set(((await db.prepare("SELECT staff_id FROM shifts WHERE slot_role_id = ? AND status != 'absent'").bind(role.slot_role_id).all()).results as any[]).map(r => r.staff_id))
  const list = staff.filter(s => !assigned.has(s.staff_id)).map(s => {
    const skills = String(s.skills || '').split(',').map((x: string) => x.trim())
    const cf = conflictFor(conflicts.get(s.staff_id), role.work_date, role.start_time, role.end_time)
    const availableFrom = isDate(s.available_from) ? s.available_from : null
    return {
      staff_id: s.staff_id, name: s.name, affiliation_type: s.affiliation_type, employment_status: s.employment_status,
      work_area: s.work_area || '', available_from: availableFrom,
      project_count: s.project_count, site_count: s.site_count, week_days: s.week_days,
      skill_match: required.filter(r => skills.includes(r)).length, skill_required: required.length,
      busy: cf.length > 0, busy_detail: cf.map(x => conflictLabel(x, u.company_id)),
      ng: ng.includes(s.staff_id), on_leave: s.employment_status === 'leave',
      // 入社予定の人と、稼働開始可能日が枠の日付より後の人は注意として出し、空きのある人の後ろに回す（#557）
      preboarding: s.employment_status === 'preboarding', not_yet_available: !!availableFrom && availableFrom > role.work_date,
    }
  })
  // 並び: 空きあり → NGでない → 休職中・入社予定・稼働開始前でない → 同じ開催場所の経験 → 案件の経験 → スキル一致 → 週（月〜日）の稼働日数が少ない
  const caution = (x: any) => Number(x.on_leave || x.preboarding || x.not_yet_available)
  list.sort((a, b) => Number(a.busy) - Number(b.busy) || Number(a.ng) - Number(b.ng) || caution(a) - caution(b) || b.site_count - a.site_count || b.project_count - a.project_count || b.skill_match - a.skill_match || a.week_days - b.week_days)
  role.week_from = weekStart(role.work_date)
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
  // 退職・統合・取引終了などは割り当てない。重複・NG・休職中・割当済みは確認のうえ force で続ける（#119 #354）
  const chk = await assertAssignable(db, { companyId: u.company_id, project: role.project_id, slot: role, staffIds, workDate: role.work_date, start: role.start_time, end: role.end_time })
  if (chk.error) return c.json({ error: chk.error }, chk.status)
  const warnings = chk.warnings
  if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)

  const data = await loadPricingData(db, u.company_id, [role.project_id])
  const created: number[] = []
  for (const s of chk.staff) {
    if (chk.already.has(s.staff_id)) continue
    let res: D1Result
    try {
      res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo, slot_id, slot_role_id, site_id, break_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, s.staff_id, role.project_id, role.work_date, role.start_time, role.end_time, role.location || '', role.role_name,
          intOrNull(b.transportation_fee) ?? 0, status, u.user_id, b.memo ?? null, role.slot_id, role.slot_role_id, role.site_id ?? null, role.break_minutes ?? null).run()
    } catch (e) {
      // 同時に届いた別のリクエストが先に割り当てた（一意インデックス）。二重には作らない（#530）
      if (isUniqueViolation(e)) { warnings.push(`${s.name}: すでにこの枠に割り当て済みです`); continue }
      throw e
    }
    await applyPricingToShift(db, u.company_id, res.meta.last_row_id as number, { data })
    created.push(res.meta.last_row_id as number)
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
  const chk = await assertAssignable(db, { companyId: u.company_id, project: role.project_id, slot: role, staffId: s.staff_id, workDate: role.work_date, start: role.start_time, end: role.end_time, excludeShiftId: s.shift_id })
  if (chk.error) return c.json({ error: chk.error }, chk.status)
  const warnings = chk.warnings
  if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  const projectChanged = role.project_id !== s.project_id
  // 移動したシフトは、移行時の重複の印（legacy_duplicate）を外して一意インデックスの対象に戻す
  try {
    await db.prepare(`UPDATE shifts SET project_id = ?, slot_id = ?, slot_role_id = ?, site_id = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, role = ?, location = ?, legacy_duplicate = NULL WHERE shift_id = ?`)
      .bind(role.project_id, role.slot_id, role.slot_role_id, role.site_id ?? null, role.work_date, role.start_time, role.end_time, role.break_minutes ?? null, role.role_name, role.location || s.location || '', s.shift_id).run()
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'このスタッフはすでに移動先の枠に割り当て済みです' }, 409)
    throw e
  }
  // 手動変更した金額でも、案件が変わった場合は移動先の単価に置き換える
  await applyPricingToShift(db, u.company_id, s.shift_id, { force: projectChanged })
  return c.json({ ok: true, warnings })
})

// =========================================================
// 退職・取引終了にするときの、今後のシフトの確認と取り外し（#500 #187）
// 対象: 自社の、from 以降（今日より前は対象外）の希望・確定・代打のシフトで、精算が確定していないもの
// =========================================================
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
async function futureShiftsOf(db: D1Database, companyId: number, staffId: number, from: string) {
  return (await db.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.slot_role_id, p.project_name,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) + (SELECT COUNT(*) FROM daily_reports d WHERE d.shift_id = s.shift_id)
        + (SELECT COUNT(*) FROM attendance_corrections ac WHERE ac.shift_id = s.shift_id)
        + (SELECT COUNT(*) FROM recruit_application_items ri WHERE ri.shift_id = s.shift_id) AS records
    FROM shifts s LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE s.company_id = ? AND s.staff_id = ? AND s.work_date >= ? AND s.status IN ('requested','confirmed','substitute')
      AND COALESCE(s.settle_status,'planned') != 'confirmed'
    ORDER BY s.work_date, s.start_time`).bind(companyId, staffId, from).all()).results as any[]
}
function futureFrom(v: any): string | null {
  if (!isDate(v)) return null
  const t = todayJST()
  return v < t ? t : v
}

// 今後のシフトの件数と一覧。退職日を保存する前の確認に使う（from = 退職日の翌日）
app.get('/staff/:id/future-shifts', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const st = await db.prepare('SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const from = futureFrom(c.req.query('from'))
  if (!from) return c.json({ error: '日付の形式が正しくありません' }, 400)
  const shifts = await futureShiftsOf(db, u.company_id, st.staff_id, from)
  // 連携先（多段連携の先を含む）のシフトは件数だけを返す（会社名・案件名は出さない）
  const linked = await db.prepare(`SELECT COUNT(*) AS n FROM shifts s JOIN staff_profiles l ON l.staff_id = s.staff_id
    WHERE l.affiliation_type = 'linked_external' AND COALESCE(l.root_staff_id, l.source_staff_id) = ? AND l.company_id != ?
      AND s.work_date >= ? AND s.status IN ('requested','confirmed','substitute')`).bind(st.staff_id, u.company_id, from).first() as any
  return c.json({ from, count: shifts.length, shifts: shifts.map(({ records, ...x }) => ({ ...x, has_records: records > 0 })), linked_count: Number(linked?.n || 0) })
})

// 今後のシフトをまとめて外す。記録（勤怠・日報・打刻修正・募集の承認）のないシフトは削除して枠を空きに戻し、
// 記録のあるシフトは残して欠勤にする。shift_ids を送ったときは、確認画面に出したものだけを処理する
app.post('/staff/:id/release-future-shifts', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const st = await db.prepare('SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const from = futureFrom(b.from)
  if (!from) return c.json({ error: '日付の形式が正しくありません' }, 400)
  let shifts = await futureShiftsOf(db, u.company_id, st.staff_id, from)
  if (Array.isArray(b.shift_ids)) { const want = new Set(b.shift_ids.map(Number)); shifts = shifts.filter(s => want.has(s.shift_id)) }
  const stmts: D1PreparedStatement[] = []
  let removed = 0, absent = 0
  for (const s of shifts) {
    if (s.records > 0) { stmts.push(db.prepare("UPDATE shifts SET status = 'absent' WHERE shift_id = ? AND company_id = ?").bind(s.shift_id, u.company_id)); absent++ }
    else {
      stmts.push(db.prepare('DELETE FROM shift_report_tokens WHERE shift_id = ? AND company_id = ?').bind(s.shift_id, u.company_id))
      stmts.push(db.prepare('DELETE FROM shifts WHERE shift_id = ? AND company_id = ?').bind(s.shift_id, u.company_id))
      removed++
    }
  }
  await batchInChunks(db, stmts)
  return c.json({ ok: true, removed, absent })
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
  // 数量を指定しないとき、または計算どおりの数量のとき（シフトボードの画面は計算した数量を入れたまま送る）は、calcAmounts の金額（分単位で計算）を使う
  const billQtyIn = b.bill_qty != null && b.bill_qty !== '', payQtyIn = b.pay_qty != null && b.pay_qty !== ''
  const billQty = billQtyIn ? Number(b.bill_qty) : amt.bill_qty
  const payQty = payQtyIn ? Number(b.pay_qty) : amt.pay_qty
  const sameQty = (q: number, calc: number) => Math.abs(q - calc) < 0.005
  const billAmount = billQtyIn && !sameQty(billQty, amt.bill_qty) ? Math.round((billRate || 0) * billQty) : amt.unit_price
  const payAmount = payRate == null ? null : payQtyIn && !sameQty(payQty, amt.pay_qty) ? Math.round(payRate * payQty) : amt.pay_amount
  const bt = BILL_TRANSPORT_TYPES.includes(b.bill_transport_type) ? b.bill_transport_type : s.bill_transport_type
  const pt = PAY_TRANSPORT_TYPES.includes(b.pay_transport_type) ? b.pay_transport_type : s.pay_transport_type
  await db.prepare(`UPDATE shifts SET bill_unit_type = ?, bill_rate = ?, bill_qty = ?, unit_price = ?, pay_unit_type = ?, pay_rate = ?, pay_qty = ?, pay_amount = ?,
      break_minutes = ?, transportation_fee = ?, bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?,
      bill_adjust = ?, pay_adjust = ?, adjust_note = ?, price_locked = 1, price_source = ? WHERE shift_id = ?`)
    .bind(billUnit, billRate, billQty, billAmount, payUnit, payRate, payQty, payAmount,
      brk, b.transportation_fee !== undefined ? (intOrNull(b.transportation_fee) ?? 0) : s.transportation_fee,
      bt, b.bill_transport_amount !== undefined ? (intOrNull(b.bill_transport_amount) ?? 0) : s.bill_transport_amount,
      pt, b.pay_transport_amount !== undefined ? (intOrNull(b.pay_transport_amount) ?? 0) : s.pay_transport_amount,
      intOrNull(b.bill_adjust) ?? s.bill_adjust ?? 0, intOrNull(b.pay_adjust) ?? s.pay_adjust ?? 0, b.adjust_note !== undefined ? (b.adjust_note || null) : s.adjust_note,
      JSON.stringify({ manual: '手動変更' }), s.shift_id).run()
  return c.json({ ok: true })
})

// 単価ルールの再適用（手動変更・確定済みのシフトは対象外）。
// 必要な行をまとめて読み、メモリ上で計算して、まとめて書き込む。1回に BULK_LIMIT 件まで処理し、残りがあれば next_cursor（最後に処理した shift_id）を返す
async function repriceRows(db: D1Database, companyId: number, rows: any[]): Promise<number> {
  if (!rows.length) return 0
  const data = await loadPricingData(db, companyId, rows.map(r => r.project_id))
  const staff = await loadStaffForAssign(db, companyId, rows.map(r => r.staff_id))
  const hist = await loadPayeeHistory(db, companyId, rows.map(r => r.staff_id))
  const roleIds = bindJsonArray(rows.map(r => r.slot_role_id))
  const roles = roleIds === '[]' ? [] : (await db.prepare(`SELECT r.* FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE sl.company_id = ? AND r.slot_role_id IN ${JSON_IN}`).bind(companyId, roleIds).all()).results as any[]
  const roleMap = new Map(roles.map(r => [r.slot_role_id, r]))
  const upd = rows.map(s => ({ shift_id: s.shift_id, ...computeShiftPricing(companyId, s, s.slot_role_id ? roleMap.get(s.slot_role_id) || null : null, payeeOn(staff.get(s.staff_id), hist.get(s.staff_id), s.work_date), data) }))
  // 読み込みの後に確定・手動変更されたシフトは書き換えない
  const res = await batchInChunks(db, updateRowsStmts(db, 'shifts', 'shift_id', PRICE_COLUMNS, upd,
    "shifts.company_id = ? AND COALESCE(shifts.price_locked,0) = 0 AND COALESCE(shifts.settle_status,'planned') != 'confirmed'", [companyId]))
  return changesOf(res)
}
app.post('/shifts/reprice', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  if (!isDate(b.from) || !isDate(b.to)) return c.json({ error: '期間を指定してください' }, 400)
  const f: string[] = ['company_id = ?', 'work_date BETWEEN ? AND ?', 'COALESCE(price_locked,0) = 0', "COALESCE(settle_status,'planned') != 'confirmed'"]; const bind: any[] = [u.company_id, b.from, b.to]
  if (b.project_id) { f.push('project_id = ?'); bind.push(b.project_id) }
  if (b.staff_id) { f.push('staff_id = ?'); bind.push(b.staff_id) }
  if (b.dry_run) {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE ${f.join(' AND ')}`).bind(...bind).first() as any
    return c.json({ count: Number(r?.n || 0) })
  }
  const limit = bulkLimit(b.limit)
  const after = Math.max(0, Math.floor(Number(b.cursor) || 0))
  const rows = (await db.prepare(`SELECT * FROM shifts WHERE ${f.join(' AND ')} AND shift_id > ? ORDER BY shift_id LIMIT ?`).bind(...bind, after, limit + 1).all()).results as any[]
  const part = rows.slice(0, limit)
  const updated = await repriceRows(db, u.company_id, part)
  return c.json({ ok: true, count: part.length, updated, next_cursor: rows.length > limit ? part[part.length - 1].shift_id : null })
})

// 常勤の一括登録: スタッフ × 曜日 × 期間（枠なしのシフトとして登録）。
// 退職・統合・停止中・NG・同じ時間帯に別のシフトがある組み合わせはスキップし、理由を skipped で返す。
// 組み合わせ（日付順 → 指定したスタッフ順）を BULK_LIMIT 件ずつ処理し、残りがあれば next_cursor（次に処理する組み合わせの番号）を返す
app.post('/shifts/bulk', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const project = await ownProject(db, u.company_id, b.project_id)
  if (!project) return c.json({ error: '案件を選択してください' }, 400)
  const staffIds: number[] = [...new Set(((b.staff_ids || []) as any[]).map(Number).filter(n => Number.isInteger(n) && n > 0))]
  if (!staffIds.length) return c.json({ error: 'スタッフを選択してください' }, 400)
  if (!isDate(b.date_from) || !isDate(b.date_to) || dayDiff(b.date_from, b.date_to) < 0) return c.json({ error: '期間を正しく入力してください' }, 400)
  if (dayDiff(b.date_from, b.date_to) > 92) return c.json({ error: '一度に登録できる期間は93日までです' }, 400)
  const wds = new Set(((b.weekdays || []) as any[]).map(Number))
  if (!wds.size) return c.json({ error: '曜日を選択してください' }, 400)
  if (!isTime(b.start_time) || !isTime(b.end_time)) return c.json({ error: '開始・終了時刻を入力してください' }, 400)
  const staff = await loadStaffForAssign(db, u.company_id, staffIds)
  if (staff.size !== staffIds.length) return c.json({ error: 'スタッフが見つかりません' }, 400)
  const hist = await loadPayeeHistory(db, u.company_id, staffIds)
  const site = b.site_id ? await ownSite(db, u.company_id, b.site_id) : null

  const items: [string, number][] = []
  for (let d = b.date_from; dayDiff(d, b.date_to) >= 0; d = addDays(d, 1)) if (wds.has(weekday(d))) for (const sid of staffIds) items.push([d, sid])
  const start = Math.max(0, Math.floor(Number(b.cursor) || 0))
  const limit = bulkLimit(b.limit)
  const part = items.slice(start, start + limit)
  const next = start + limit < items.length ? start + limit : null
  if (!part.length) return c.json({ ok: true, created: 0, skipped: [], total: items.length, next_cursor: null })

  const conflicts = await findConflicts(db, u.company_id, staffIds, part[0][0], part[part.length - 1][0])
  const ng = (await ngByProjects(db, u.company_id, [project.project_id])).get(project.project_id) || []
  const data = await loadPricingData(db, u.company_id, [project.project_id])
  const base = {
    company_id: u.company_id, project_id: project.project_id, start_time: b.start_time, end_time: b.end_time,
    location: b.location || site?.site_name || '', role: String(b.role || '').trim() || '販売スタッフ', transportation_fee: intOrNull(b.transportation_fee) ?? 0,
    status: 'confirmed', registered_by: u.user_id, slot_id: null, slot_role_id: null, site_id: site?.site_id ?? null, break_minutes: intOrNull(b.break_minutes), source_shift_id: null,
  }
  const rows: any[] = []; const skipped: Skipped[] = []
  for (const [d, sid] of part) {
    const st = staff.get(sid)
    let reason = ineligibleReason(st, d), detail: string | undefined
    if (!reason && ng.includes(sid)) reason = 'NG'
    if (!reason) {
      const cf = conflictFor(conflicts.get(sid), d, b.start_time, b.end_time)
      if (cf.length) { reason = '重複'; detail = cf.map(x => conflictLabel(x, u.company_id)).join('、') }
    }
    if (reason) { skipped.push({ date: d, staff_id: sid, staff_name: st?.name || '', reason, detail, project_name: project.project_name, start_time: b.start_time, end_time: b.end_time }); continue }
    const row: any = { ...base, staff_id: sid, work_date: d }
    rows.push({ ...row, ...computeShiftPricing(u.company_id, row, null, payeeOn(st, hist.get(sid), d), data) })
    addPlannedConflict(conflicts, u.company_id, sid, d, b.start_time, b.end_time, project.project_name)
  }
  const res = await batchInChunks(db, insertRowsStmts(db, 'shifts', SHIFT_INSERT_COLUMNS, rows))
  return c.json({ ok: true, created: changesOf(res), skipped, total: items.length, processed: start + part.length, next_cursor: next })
})

// 前週（任意の期間）のコピー: 枠と役割、割り当て（confirmed/substitute は confirmed として）をコピーする。
// - コピーするのは、シフトボードの絞り込み（クライアント・区分・案件）と同じ条件の案件だけ（#493）
// - コピー先の期間がコピー元と重なる指定は受け付けない。曜日がずれる指定は force を付けて確認してから実行する（#527）
// - コピーした枠・役割・シフトにコピー元のIDを記録し、やり直しても二重に作らない。
//   コピー先に同じ案件・日付・時間・場所の枠があれば、新しく作らずにその枠を使う（#78）
// - 退職・統合・停止中・NG・時間の重なり・コピー先の枠に割当済みのスタッフはスキップし、理由を返す（#33）
// - dry_run は書き込まずに件数とスキップを返す。実行は枠を単位に進め、書き込む行が BULK_LIMIT を超えたら next_cursor を返す
type SlotPlan = { src: any; date: string; target: any | null; reused: boolean }
type RolePlan = { src: any; slot: SlotPlan; target: any | null }
type ShiftPlan = { src: any; date: string; role: RolePlan | null; start: string; end: string }
app.post('/shifts/copy-week', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json(); const cid = u.company_id
  if (!isDate(b.source_from) || !isDate(b.target_from)) return c.json({ error: 'コピー元とコピー先の開始日を指定してください' }, 400)
  const days = Math.min(Math.max(Math.floor(Number(b.days)) || 7, 1), MAX_RANGE_DAYS)
  const offset = dayDiff(b.source_from, b.target_from)
  if (offset === 0) return c.json({ error: 'コピー元とコピー先が同じです' }, 400)
  if (Math.abs(offset) < days) return c.json({ error: `コピー元とコピー先の期間が重なっています（${days}日間をコピーするときは、コピー先の開始日をコピー元の開始日から${days}日以上離してください）` }, 400)
  const weekdayShift = ((offset % 7) + 7) % 7
  const dryRun = !!b.dry_run
  if (!dryRun && weekdayShift && !b.force) return c.json({ error: `コピー先の曜日がコピー元と${weekdayShift}日ずれます`, need_force: true, weekday_shift: weekdayShift }, 409)
  const sourceTo = addDays(b.source_from, days - 1), targetTo = addDays(b.target_from, days - 1)

  // 対象の案件（シフトボードの絞り込みと同じ条件）
  const clientId = intOrNull(b.client_id); const projectIds = parseIds(b.project_ids)
  const pf: string[] = ['p.company_id = ?']; const pb: any[] = [cid]
  if (clientId) { pf.push('p.client_id = ?'); pb.push(clientId) }
  if (projectIds.length) { pf.push(`p.project_id IN ${JSON_IN}`); pb.push(bindJsonArray(projectIds)) }
  if (b.engagement === 'regular' || b.engagement === 'spot') { pf.push("COALESCE(p.engagement_type,'regular') = ?"); pb.push(b.engagement) }
  const inP = `(SELECT p.project_id FROM projects p WHERE ${pf.join(' AND ')})`
  const includeAssign = b.include_assignments !== false
  const includePlain = includeAssign && b.include_unslotted !== false
  const cur = /^(slot|plain):(\d+)$/.exec(String(b.cursor || ''))
  const phase = cur ? cur[1] : 'slot', after = cur ? Number(cur[2]) : 0
  const limit = dryRun ? Infinity : bulkLimit(b.limit)

  // ---------- 読み込み（まとめて読む） ----------
  const all = async (sql: string, ...binds: any[]) => (await db.prepare(sql).bind(...binds).all()).results as any[]
  const srcSlots = phase === 'slot' ? await all(`SELECT * FROM shift_slots WHERE company_id = ? AND work_date BETWEEN ? AND ? AND project_id IN ${inP} AND slot_id > ? ORDER BY slot_id`,
    cid, b.source_from, sourceTo, ...pb, after) : []
  const srcRoles = srcSlots.length ? await all(`SELECT * FROM shift_slot_roles WHERE slot_id IN ${JSON_IN} ORDER BY sort_order, slot_role_id`, bindJsonArray(srcSlots.map(s => s.slot_id))) : []
  const srcAssigned = includeAssign && srcRoles.length ? await all(`SELECT * FROM shifts WHERE company_id = ? AND slot_role_id IN ${JSON_IN} AND status IN ('confirmed','substitute') ORDER BY shift_id`,
    cid, bindJsonArray(srcRoles.map(r => r.slot_role_id))) : []
  const srcPlain = includePlain ? await all(`SELECT * FROM shifts WHERE company_id = ? AND work_date BETWEEN ? AND ? AND slot_id IS NULL AND status IN ('confirmed','substitute')
      AND project_id IN ${inP} AND shift_id > ? ORDER BY shift_id`, cid, b.source_from, sourceTo, ...pb, phase === 'plain' ? after : 0) : []
  const tgtSlots = await all(`SELECT * FROM shift_slots WHERE company_id = ? AND work_date BETWEEN ? AND ? AND project_id IN ${inP} ORDER BY slot_id`, cid, b.target_from, targetTo, ...pb)
  const tgtRoles = tgtSlots.length ? await all(`SELECT * FROM shift_slot_roles WHERE slot_id IN ${JSON_IN} ORDER BY sort_order, slot_role_id`, bindJsonArray(tgtSlots.map(s => s.slot_id))) : []
  const tgtShifts = await all('SELECT shift_id, staff_id, slot_id, work_date, status, source_shift_id FROM shifts WHERE company_id = ? AND work_date BETWEEN ? AND ?', cid, b.target_from, targetTo)
  const staffIds = [...new Set([...srcAssigned, ...srcPlain].map(s => s.staff_id))]
  const staff = await loadStaffForAssign(db, cid, staffIds)
  const usedProjectIds = [...new Set([...srcSlots, ...srcPlain].map(s => s.project_id))]
  const ng = await ngByProjects(db, cid, usedProjectIds)
  const conflicts = await findConflicts(db, cid, staffIds, b.target_from, targetTo)
  const projects = usedProjectIds.length ? await all(`SELECT p.project_id, p.project_name, cl.client_name FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    WHERE p.company_id = ? AND p.project_id IN ${JSON_IN} ORDER BY cl.client_name, p.project_name`, cid, bindJsonArray(usedProjectIds)) : []
  const projectName = (pid: number) => projects.find(p => p.project_id === pid)?.project_name || null

  // ---------- 計画（メモリ上で決める） ----------
  const group = <T,>(rows: T[], key: (r: T) => any) => { const m = new Map<any, T[]>(); for (const r of rows) { const k = key(r); const a = m.get(k) || []; a.push(r); m.set(k, a) } return m }
  const copied = new Set(tgtShifts.filter(s => s.source_shift_id).map(s => `${s.source_shift_id}:${s.work_date}`))
  const staffInSlot = new Map<number, Set<number>>()
  for (const s of tgtShifts) if (s.slot_id && s.status !== 'absent') { const a = staffInSlot.get(s.slot_id) || new Set<number>(); a.add(s.staff_id); staffInSlot.set(s.slot_id, a) }
  // コピー元の期間のすべての枠。続きから実行したとき、前の呼び出しで作ったほかの枠のコピーを「同じ内容の既存の枠」として使わないよう、カーソルより前の枠も含める
  const srcSlotIds = new Set<number>(srcSlots.length
    ? (await all(`SELECT slot_id FROM shift_slots WHERE company_id = ? AND work_date BETWEEN ? AND ? AND project_id IN ${inP}`, cid, b.source_from, sourceTo, ...pb)).map(s => s.slot_id)
    : [])
  const tgtRolesBySlot = group(tgtRoles, r => r.slot_id), srcRolesBySlot = group(srcRoles, r => r.slot_id), assignedByRole = group(srcAssigned, s => s.slot_role_id)
  const claimedSlots = new Set<number>()
  const slotPlans: SlotPlan[] = [], rolePlans: RolePlan[] = [], shiftPlans: ShiftPlan[] = []
  const skipped: (Skipped & { _role?: RolePlan })[] = []
  let already = 0, used = 0, nextCursor: string | null = null

  const check = (staffId: number, date: string, projectId: number, start: string, end: string, slotStaff?: Set<number>): { reason: string; detail?: string } | null => {
    const reason = ineligibleReason(staff.get(staffId), date)
    if (reason) return { reason }
    if ((ng.get(projectId) || []).includes(staffId)) return { reason: 'NG' }
    if (slotStaff && slotStaff.has(staffId)) return { reason: '割当済み', detail: 'コピー先の枠にすでに割り当てられています' }
    const cf = conflictFor(conflicts.get(staffId), date, start, end)
    if (cf.length) return { reason: '重複', detail: cf.map(x => conflictLabel(x, cid)).join('、') }
    return null
  }
  const sameSlot = (t: any, sl: any, date: string) => t.project_id === sl.project_id && t.work_date === date && t.start_time === sl.start_time && t.end_time === sl.end_time
    && (t.site_id || null) === (sl.site_id || null) && (t.location || '') === (sl.location || '')

  let i = 0
  for (; i < srcSlots.length && used < limit; i++) {
    const sl = srcSlots[i]; const date = addDays(sl.work_date, offset)
    // コピー済みの枠 → 同じ内容の既存の枠（ほかのコピー元のコピーは除く）の順に探す
    const target = tgtSlots.find(t => t.source_slot_id === sl.slot_id && t.work_date === date)
      || tgtSlots.find(t => !claimedSlots.has(t.slot_id) && !(t.source_slot_id && srcSlotIds.has(t.source_slot_id)) && sameSlot(t, sl, date)) || null
    if (target) claimedSlots.add(target.slot_id); else used++
    const sp: SlotPlan = { src: sl, date, target, reused: !!target }
    slotPlans.push(sp)
    const start = target ? target.start_time : sl.start_time, end = target ? target.end_time : sl.end_time
    const slotStaff = new Set<number>(target ? staffInSlot.get(target.slot_id) || [] : [])
    const tRoles = target ? tgtRolesBySlot.get(target.slot_id) || [] : []
    const sRoles = srcRolesBySlot.get(sl.slot_id) || []
    // コピー先の役割: コピー元のIDが同じもの → 同じ役割名のもの
    const matched = new Map<number, any>(); const claimedRoles = new Set<number>()
    for (const r of sRoles) { const t = tRoles.find(x => x.source_slot_role_id === r.slot_role_id); if (t) { matched.set(r.slot_role_id, t); claimedRoles.add(t.slot_role_id) } }
    for (const r of sRoles) {
      if (matched.has(r.slot_role_id)) continue
      const t = tRoles.find(x => !claimedRoles.has(x.slot_role_id) && x.role_name === r.role_name)
      if (t) { matched.set(r.slot_role_id, t); claimedRoles.add(t.slot_role_id) }
    }
    for (const r of sRoles) {
      const rp: RolePlan = { src: r, slot: sp, target: matched.get(r.slot_role_id) || null }
      rolePlans.push(rp); if (!rp.target) used++
      if (!includeAssign) continue
      for (const s of assignedByRole.get(r.slot_role_id) || []) {
        if (copied.has(`${s.shift_id}:${date}`)) { already++; continue }
        const ngr = check(s.staff_id, date, sl.project_id, start, end, slotStaff)
        if (ngr) { skipped.push({ date, staff_id: s.staff_id, staff_name: staff.get(s.staff_id)?.name || '', ...ngr, project_name: projectName(sl.project_id), start_time: start, end_time: end, _role: rp }); continue }
        slotStaff.add(s.staff_id); addPlannedConflict(conflicts, cid, s.staff_id, date, start, end, projectName(sl.project_id))
        shiftPlans.push({ src: s, date, role: rp, start, end }); used++
      }
    }
  }
  if (i < srcSlots.length) nextCursor = `slot:${srcSlots[i - 1].slot_id}`
  else {
    let j = 0
    for (; j < srcPlain.length && used < limit; j++) {
      const s = srcPlain[j]; const date = addDays(s.work_date, offset)
      if (copied.has(`${s.shift_id}:${date}`)) { already++; continue }
      const ngr = check(s.staff_id, date, s.project_id, s.start_time, s.end_time)
      if (ngr) { skipped.push({ date, staff_id: s.staff_id, staff_name: staff.get(s.staff_id)?.name || '', ...ngr, project_name: projectName(s.project_id), start_time: s.start_time, end_time: s.end_time }); continue }
      addPlannedConflict(conflicts, cid, s.staff_id, date, s.start_time, s.end_time, projectName(s.project_id))
      shiftPlans.push({ src: s, date, role: null, start: s.start_time, end: s.end_time }); used++
    }
    if (j < srcPlain.length) nextCursor = `plain:${j > 0 ? srcPlain[j - 1].shift_id : (phase === 'plain' ? after : 0)}`
  }
  const view = () => skipped.map(({ _role, ...x }) => ({ ...x, slot_role_id: _role?.target?.slot_role_id ?? null }))
  const summary = {
    source: { from: b.source_from, to: sourceTo }, target: { from: b.target_from, to: targetTo }, weekday_shift: weekdayShift,
    projects: projects.map(p => ({ project_id: p.project_id, project_name: p.project_name, client_name: p.client_name || '' })),
  }
  if (dryRun) {
    return c.json({ dry_run: true, ...summary, slots: slotPlans.filter(p => !p.reused).length, slots_reused: slotPlans.filter(p => p.reused).length,
      roles: rolePlans.filter(p => !p.target).length, shifts: shiftPlans.length, already, skipped: view() })
  }

  // ---------- 書き込み（まとめて書く。コピー元のIDの一意制約で、同時に実行しても二重にならない） ----------
  const newSlots = slotPlans.filter(p => !p.target)
  let slotsCreated = 0, rolesCreated = 0
  if (newSlots.length) {
    const res = await batchInChunks(db, insertRowsStmts(db, 'shift_slots', ['company_id', 'project_id', 'site_id', 'location', 'work_date', 'start_time', 'end_time', 'break_minutes', 'memo', 'created_by', 'source_slot_id'],
      newSlots.map(p => ({ company_id: cid, project_id: p.src.project_id, site_id: p.src.site_id ?? null, location: p.src.location ?? null, work_date: p.date, start_time: p.src.start_time, end_time: p.src.end_time,
        break_minutes: p.src.break_minutes ?? null, memo: p.src.memo ?? null, created_by: u.user_id, source_slot_id: p.src.slot_id })), { orIgnore: true }))
    slotsCreated = changesOf(res)
    const got = await all(`SELECT * FROM shift_slots WHERE company_id = ? AND source_slot_id IN ${JSON_IN} AND work_date BETWEEN ? AND ?`, cid, bindJsonArray(newSlots.map(p => p.src.slot_id)), b.target_from, targetTo)
    for (const p of newSlots) {
      p.target = got.find(t => t.source_slot_id === p.src.slot_id && t.work_date === p.date) || null
      if (!p.target) throw new Error('コピー先の枠を作成できませんでした')
    }
  }
  const newRoles = rolePlans.filter(p => !p.target)
  if (newRoles.length) {
    const res = await batchInChunks(db, insertRowsStmts(db, 'shift_slot_roles', ['slot_id', 'role_name', 'headcount', 'bill_unit_type', 'bill_rate', 'pay_unit_type', 'pay_rate', 'sort_order', 'source_slot_role_id'],
      newRoles.map(p => ({ slot_id: p.slot.target.slot_id, role_name: p.src.role_name, headcount: p.src.headcount, bill_unit_type: p.src.bill_unit_type ?? null, bill_rate: p.src.bill_rate ?? null,
        pay_unit_type: p.src.pay_unit_type ?? null, pay_rate: p.src.pay_rate ?? null, sort_order: p.src.sort_order ?? 0, source_slot_role_id: p.src.slot_role_id })), { orIgnore: true }))
    rolesCreated = changesOf(res)
    const got = await all(`SELECT * FROM shift_slot_roles WHERE slot_id IN ${JSON_IN} AND source_slot_role_id IS NOT NULL`, bindJsonArray(newRoles.map(p => p.slot.target.slot_id)))
    for (const p of newRoles) {
      p.target = got.find(t => t.slot_id === p.slot.target.slot_id && t.source_slot_role_id === p.src.slot_role_id) || null
      if (!p.target) throw new Error('コピー先の役割を作成できませんでした')
    }
  }
  let shiftsCreated = 0
  if (shiftPlans.length) {
    const pdata = await loadPricingData(db, cid, usedProjectIds)
    const hist = await loadPayeeHistory(db, cid, shiftPlans.map(p => p.src.staff_id))
    const rows = shiftPlans.map(p => {
      const s = p.src, role = p.role?.target || null, slot = p.role?.slot.target || null
      const row: any = {
        company_id: cid, staff_id: s.staff_id, project_id: slot ? slot.project_id : s.project_id, work_date: p.date, start_time: p.start, end_time: p.end,
        location: (slot ? slot.location : null) || s.location || '', role: role ? role.role_name : (s.role || '販売スタッフ'), transportation_fee: s.transportation_fee || 0,
        status: 'confirmed', registered_by: u.user_id, slot_id: slot?.slot_id ?? null, slot_role_id: role?.slot_role_id ?? null,
        site_id: slot ? slot.site_id ?? null : s.site_id ?? null, break_minutes: slot ? slot.break_minutes ?? null : s.break_minutes ?? null, source_shift_id: s.shift_id,
      }
      return { ...row, ...computeShiftPricing(cid, row, role, payeeOn(staff.get(s.staff_id), hist.get(s.staff_id), p.date), pdata) }
    })
    shiftsCreated = changesOf(await batchInChunks(db, insertRowsStmts(db, 'shifts', SHIFT_INSERT_COLUMNS, rows, { orIgnore: true })))
  }
  return c.json({ ok: true, ...summary, slots: slotsCreated, slots_reused: slotPlans.filter(p => p.reused).length, roles: rolesCreated,
    shifts: shiftsCreated, already, skipped: view(), next_cursor: nextCursor })
})


// =========================================================
// 繰り返し登録
// =========================================================
app.get('/slot-patterns', async (c) => {
  const u = c.get('user')
  const pid = intOrNull(c.req.query('project_id'))
  const today = todayJST()
  const rows = (await c.env.DB.prepare(`SELECT sp.*, p.project_name, si.site_name,
      (SELECT COUNT(*) FROM shift_slots s WHERE s.pattern_id = sp.pattern_id) AS slot_count,
      (SELECT COUNT(*) FROM shift_slots s WHERE s.pattern_id = sp.pattern_id AND s.work_date >= ?) AS future_slot_count
    FROM slot_patterns sp JOIN projects p ON p.project_id = sp.project_id AND p.company_id = sp.company_id LEFT JOIN sites si ON si.site_id = sp.site_id
    WHERE sp.company_id = ? ${pid ? 'AND sp.project_id = ?' : ''} ORDER BY sp.pattern_id DESC`).bind(today, u.company_id, ...(pid ? [pid] : [])).all()).results as any[]
  // days_left: 終了日までの日数（終了が近い繰り返し登録を画面で目立たせる。#456）
  return c.json({ today, patterns: rows.map(r => ({ ...r, roles: JSON.parse(r.roles_json || '[]'), days_left: dayDiff(today, r.date_to) })) })
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

// 繰り返し登録の編集と延長（#456）
//   apply_from 以降のこのパターンの枠に、変えた項目（時刻・休憩・役割の人数・役割の追加と削除）だけを反映する。
//   報告済み（勤怠・日報）・実績が確定済みのシフトがある枠は変えずに除外し、件数を返す。
//   時刻・休憩を変えた枠の割り当て済みシフトも同じ時刻にし（シフトごとに直した休憩はそのまま）、単価を再計算する。
//   役割の削除は、割り当て・未対応の応募のない枠だけで行う。役割名の変更はしない（単価ルールの照合が変わるため、枠の編集で行う）。
//   date_to を今の終了日より後にすると、延長した期間の該当する曜日に枠を追加する。
//   dry_run=true は件数と重複の確認だけを返す。割り当て済みの人の時間が別のシフトと重なるときは force が必要
app.put('/slot-patterns/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const p = await db.prepare('SELECT * FROM slot_patterns WHERE pattern_id = ? AND company_id = ?').bind(intOrNull(c.req.param('id')), u.company_id).first() as any
  if (!p) return c.json({ error: '繰り返し登録が見つかりません' }, 404)
  const today = todayJST()
  const applyFrom = b.apply_from == null || b.apply_from === '' ? today : b.apply_from
  if (!isDate(applyFrom)) return c.json({ error: '反映を始める日を正しく入力してください' }, 400)
  if (applyFrom < today) return c.json({ error: '反映を始める日は今日以降にしてください（過去の枠は変えません）' }, 400)

  // ---- 変える項目 ----
  const start = b.start_time ?? p.start_time, end = b.end_time ?? p.end_time
  if (!isTime(start) || !isTime(end)) return c.json({ error: '開始・終了時刻を正しく入力してください' }, 400)
  const brk = b.break_minutes === undefined ? p.break_minutes : intOrNull(b.break_minutes)
  if (brk != null && (brk < 0 || brk > 1440)) return c.json({ error: '休憩は0〜1440分で入力してください' }, 400)
  const timeChanged = start !== p.start_time || end !== p.end_time
  const breakChanged = (brk ?? null) !== (p.break_minutes ?? null)

  const oldRoles: any[] = JSON.parse(p.roles_json || '[]')
  let newRoles = oldRoles
  const headcountChanged: { role_name: string; headcount: number }[] = [], added: any[] = [], removed: string[] = []
  if (Array.isArray(b.roles)) {
    const kept: any[] = []
    for (const r of b.roles as any[]) {
      const orig = r && r.orig_name != null ? oldRoles.find(o => o.role_name === r.orig_name) : null
      if (r && r.orig_name != null && !orig) return c.json({ error: `役割「${r.orig_name}」が見つかりません` }, 400)
      const headcount = Number(r?.headcount)
      if (!r?._delete && (!Number.isInteger(headcount) || headcount < 1 || headcount > 200)) return c.json({ error: '必要人数は1〜200で入力してください' }, 400)
      if (orig) {
        if (r._delete) { removed.push(orig.role_name); continue }
        if (headcount !== Number(orig.headcount)) headcountChanged.push({ role_name: orig.role_name, headcount })
        kept.push({ ...orig, headcount })
      } else if (!r?._delete) {
        const name = String(r?.role_name || '').trim()
        if (!name || name.length > 50) return c.json({ error: '追加する役割の名前を入力してください（50文字以内）' }, 400)
        added.push({ role_name: name, headcount, bill_rate: null, pay_rate: null, bill_unit_type: null, pay_unit_type: null })
      }
    }
    // 送られなかった既存の役割はそのまま残す（並びは元のまま）
    newRoles = [...oldRoles.filter(o => !removed.includes(o.role_name)).map(o => kept.find(k => k.role_name === o.role_name) || o), ...added]
    const names = newRoles.map(r => r.role_name)
    if (!names.length) return c.json({ error: '役割を1つ以上残してください' }, 400)
    if (new Set(names).size !== names.length) return c.json({ error: '同じ名前の役割があります' }, 400)
  }

  let newTo = p.date_to
  if (b.date_to !== undefined && b.date_to !== null && b.date_to !== '') {
    if (!isDate(b.date_to)) return c.json({ error: '終了日を正しく入力してください' }, 400)
    if (b.date_to < p.date_to) return c.json({ error: '終了日を早めることはできません（不要な枠は枠ごとに削除してください）' }, 400)
    if (dayDiff(p.date_to, b.date_to) > 366) return c.json({ error: '一度に延長できるのは1年以内です' }, 400)
    newTo = b.date_to
  }
  const wds = String(p.weekdays || '').split(',').map(Number)
  const extendDates: string[] = []
  for (let d = addDays(p.date_to, 1); dayDiff(d, newTo) >= 0; d = addDays(d, 1)) if (d >= today && wds.includes(weekday(d))) extendDates.push(d)
  if (extendDates.length > 160) return c.json({ error: '一度に追加できる枠は160件までです（終了日を手前にしてください）' }, 400)

  // ---- 対象の枠と、除外する枠（報告済み・確定済みのシフトがある） ----
  const slots = (await db.prepare(`SELECT slot_id, work_date, start_time, end_time, break_minutes FROM shift_slots
    WHERE pattern_id = ? AND company_id = ? AND work_date >= ? ORDER BY work_date`).bind(p.pattern_id, u.company_id, applyFrom).all()).results as any[]
  const lockedIds = new Set((((await db.prepare(`SELECT DISTINCT sh.slot_id FROM shifts sh
    WHERE sh.company_id = ? AND sh.slot_id IN (SELECT slot_id FROM shift_slots WHERE pattern_id = ? AND company_id = ? AND work_date >= ?)
      AND (COALESCE(sh.settle_status,'planned') = 'confirmed' OR EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = sh.shift_id)
        OR EXISTS (SELECT 1 FROM daily_reports d WHERE d.shift_id = sh.shift_id))`)
    .bind(u.company_id, p.pattern_id, u.company_id, applyFrom).all()).results as any[]).map(r => r.slot_id)))
  const targets = slots.filter(s => !lockedIds.has(s.slot_id))
  const targetIds = bindJsonArray(targets.map(s => s.slot_id))
  const slotRoles = targets.length ? (await db.prepare(`SELECT r.slot_role_id, r.slot_id, r.role_name,
      (SELECT COUNT(*) FROM shifts sh WHERE sh.slot_role_id = r.slot_role_id) AS used,
      (SELECT COUNT(*) FROM recruit_application_items i WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending') AS pending
    FROM shift_slot_roles r WHERE r.slot_id IN ${JSON_IN}`).bind(targetIds).all()).results as any[] : []
  const removable = slotRoles.filter(r => removed.includes(r.role_name) && !r.used && !r.pending)
  const keptRoles = slotRoles.filter(r => removed.includes(r.role_name) && (r.used || r.pending)).length
  const addRows: any[] = []
  for (const s of targets) for (const [i, r] of added.entries()) {
    if (!slotRoles.some(x => x.slot_id === s.slot_id && x.role_name === r.role_name)) addRows.push({ slot_id: s.slot_id, role: r, sort_order: 100 + i })
  }
  // 時刻・休憩を変える枠の割り当て済みシフト（実績が確定済みのものは除外済み）
  const moving = (timeChanged || breakChanged) && targets.length ? (await db.prepare(`SELECT sh.* FROM shifts sh
    WHERE sh.company_id = ? AND sh.slot_id IN ${JSON_IN} AND COALESCE(sh.settle_status,'planned') != 'confirmed'`).bind(u.company_id, targetIds).all()).results as any[] : []
  const slotById = new Map(targets.map(s => [s.slot_id, s]))
  // 時刻を変えると、割り当て済みの人の別のシフトと重なることがある（欠勤は除く）
  const warnings: string[] = []
  if (timeChanged) {
    const active = moving.filter(s => s.status !== 'absent')
    if (active.length) {
      const dates = active.map(s => s.work_date).sort()
      const conflicts = await findConflicts(db, u.company_id, active.map(s => s.staff_id), dates[0], dates[dates.length - 1])
      const names = new Map(((await db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND sp.staff_id IN ${JSON_IN}`)
        .bind(u.company_id, bindJsonArray(active.map(s => s.staff_id))).all()).results as any[]).map(r => [r.staff_id, r.name]))
      for (const s of active) {
        const cf = conflictFor(conflicts.get(s.staff_id), s.work_date, start, end, s.shift_id).filter(x => !moving.some(m => m.shift_id === x.shift_id))
        if (cf.length) warnings.push(`${s.work_date} ${names.get(s.staff_id) || ''}: 同じ時間帯に別のシフトがあります（${cf.map(x => conflictLabel(x, u.company_id)).join('、')}）`)
      }
    }
  }
  const summary = {
    slots: targets.length, skipped_slots: lockedIds.size, shifts: moving.length,
    roles_added: addRows.length, roles_removed: removable.length, roles_kept: keptRoles,
    headcount_changed: headcountChanged.length ? targets.length : 0, extend_slots: extendDates.length, date_to: newTo, warnings,
  }
  if (b.dry_run) return c.json({ ok: true, dry_run: true, ...summary })
  if (warnings.length && !b.force) return c.json({ error: '割り当て済みのスタッフの時間が、別のシフトと重なります', need_force: true, ...summary }, 409)

  // ---- 書き込み ----
  const stmts: D1PreparedStatement[] = []
  if (targets.length && (timeChanged || breakChanged)) {
    stmts.push(db.prepare(`UPDATE shift_slots SET start_time = ?, end_time = ?, break_minutes = ? WHERE company_id = ? AND slot_id IN ${JSON_IN}`)
      .bind(start, end, brk ?? null, u.company_id, targetIds))
    // シフトごとに直した休憩（枠の休憩と違う値）はそのまま残す
    const upd = moving.map(s => {
      const sl = slotById.get(s.slot_id)
      const ownBreak = sl && (s.break_minutes ?? null) !== (sl.break_minutes ?? null)
      return { shift_id: s.shift_id, start_time: start, end_time: end, break_minutes: ownBreak ? s.break_minutes : (brk ?? null) }
    })
    stmts.push(...updateRowsStmts(db, 'shifts', 'shift_id', ['start_time', 'end_time', 'break_minutes'], upd,
      "shifts.company_id = ? AND COALESCE(shifts.settle_status,'planned') != 'confirmed'", [u.company_id]))
  }
  for (const h of headcountChanged) {
    if (targets.length) stmts.push(db.prepare(`UPDATE shift_slot_roles SET headcount = ? WHERE role_name = ? AND slot_id IN ${JSON_IN}`).bind(h.headcount, h.role_name, targetIds))
  }
  if (removable.length) stmts.push(db.prepare(`DELETE FROM shift_slot_roles WHERE slot_role_id IN ${JSON_IN}
    AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.slot_role_id = shift_slot_roles.slot_role_id)`).bind(bindJsonArray(removable.map(r => r.slot_role_id))))
  if (addRows.length) stmts.push(...insertRowsStmts(db, 'shift_slot_roles', ['slot_id', 'role_name', 'headcount', 'bill_unit_type', 'bill_rate', 'pay_unit_type', 'pay_rate', 'sort_order'],
    addRows.map(a => ({ slot_id: a.slot_id, role_name: a.role.role_name, headcount: a.role.headcount, bill_unit_type: null, bill_rate: null, pay_unit_type: null, pay_rate: null, sort_order: a.sort_order }))))
  stmts.push(db.prepare('UPDATE slot_patterns SET start_time = ?, end_time = ?, break_minutes = ?, roles_json = ?, date_to = ? WHERE pattern_id = ? AND company_id = ?')
    .bind(start, end, brk ?? null, JSON.stringify(newRoles), newTo, p.pattern_id, u.company_id))
  await batchInChunks(db, stmts)
  // 延長: 追加する日の枠（同じパターンの枠がすでにある日は作らない）
  let createdSlots = 0
  if (extendDates.length) {
    const exists = new Set(((await db.prepare('SELECT work_date FROM shift_slots WHERE pattern_id = ? AND company_id = ? AND work_date > ?').bind(p.pattern_id, u.company_id, p.date_to).all()).results as any[]).map(r => r.work_date))
    const body = { project_id: p.project_id, site_id: p.site_id, location: p.location, start_time: start, end_time: end, break_minutes: brk, memo: p.memo }
    for (const d of extendDates) if (!exists.has(d)) { await insertSlot(db, u, body, d, newRoles, p.pattern_id); createdSlots++ }
  }
  // 時刻・休憩を変えたシフトの単価を計算し直す（時給の時間が変わるため）
  const repriced = moving.length ? await repriceRows(db, u.company_id, ((await db.prepare(`SELECT * FROM shifts WHERE company_id = ? AND shift_id IN ${JSON_IN}`)
    .bind(u.company_id, bindJsonArray(moving.map(s => s.shift_id))).all()).results as any[])) : 0
  return c.json({ ok: true, ...summary, extend_slots: createdSlots, repriced })
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
  const cb = clientId ? [clientId] : []
  // counts=0 は件数を数えない（シフトボードの選択肢の読み込み用）。件数は、この会社の対象の開催場所のシフトを GROUP BY でまとめて数える（#408）
  const counts = c.req.query('counts') !== '0'
  const rows = (await c.env.DB.prepare(`SELECT si.*, cl.client_name${counts ? ', COALESCE(sc.n, 0) AS shift_count' : ''}
    FROM sites si LEFT JOIN clients cl ON cl.client_id = si.client_id AND cl.company_id = si.company_id
    ${counts ? `LEFT JOIN (SELECT s.site_id, COUNT(*) AS n FROM shifts s
      WHERE s.company_id = ? AND s.site_id IN (SELECT site_id FROM sites WHERE company_id = ? ${clientId ? 'AND client_id = ?' : ''}) GROUP BY s.site_id) sc ON sc.site_id = si.site_id` : ''}
    WHERE si.company_id = ? ${clientId ? 'AND si.client_id = ?' : ''} ORDER BY cl.client_name, si.site_name`)
    .bind(...(counts ? [u.company_id, u.company_id, ...cb] : []), u.company_id, ...cb).all()).results
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
