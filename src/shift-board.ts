// =========================================================
// 常勤・スポット案件のシフトボード / 募集枠 / 単価（請求・支払）
// docs/spec_spot_shift.md 第1段階
//
// api.ts とのコンフリクトを避けるため新規APIはこのファイルにまとめ、
// api.ts からは api.route('/admin', shiftBoardApi) で認証・権限ミドルウェアの後に登録する。
// 金額（請求・支払・粗利）は管理画面（/api/admin/*）でのみ返す。
// =========================================================
import { Hono } from 'hono'
import { settleRemovedSlotItems } from './recruit'
import { JSON_IN, batchInChunks, bindJsonArray } from './lib/d1-chunk'
import { assertAssignable, assignableStaffSql, conflictFor, conflictLabel, conflictView, findConflicts, isUniqueViolation, ngStaffIds } from './lib/staff-eligibility'
import type { ConflictRow } from './lib/staff-eligibility'
import { changesOf, insertRowsStmts, returnedIds, updateRowsStmts } from './lib/bulk-write'
import { buildUpdate } from './lib/update-builder'
import { isHHMM, isISODate } from './lib/validate'
import { loadShiftSnaps, notifyShiftChanges } from './notifications'
import type { ShiftSnap } from './notifications'
import { opLog, logShifts, logShiftsOfSlot, logSlot, finishLog } from './lib/operation-log'
import { csvResponse, toCsv } from './csv'
import { feeInput, loadTransportDefaults, transportDefaultFor } from './lib/transport-defaults'
import { closedChecker, closedOn } from './lib/closings'

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
  'price_locked', 'price_source', 'pay_premium', 'premium_night_minutes', 'premium_overtime_minutes', 'premium_holiday_minutes',
]
export function stripMoney<T extends Record<string, any>>(row: T | null): T | null {
  if (!row) return row
  const out: any = { ...row }
  for (const k of MONEY_COLUMNS) delete out[k]
  return out
}

// スタッフ向けAPIで返すシフトの列（許可リスト。#520）。精算のメモ（actual_note）・確定の状況・登録者・金額は返さない。
// shifts に列を足しても、ここに足さない限りスタッフには渡らない。開催場所・枠・案件の列は api.ts の取得で付けたもの
export const STAFF_SHIFT_COLUMNS = [
  'shift_id', 'company_id', 'staff_id', 'project_id', 'work_date', 'start_time', 'end_time', 'location', 'role', 'status', 'break_minutes',
  'site_id', 'slot_id', 'staff_reply', 'staff_reply_note', 'staff_reply_at',
  'project_name', 'company_name', 'other_company', 'tentative',
  'site_name', 'site_address', 'site_lat', 'site_lng', 'slot_memo', 'slot_break_minutes', 'project_break_minutes',
  // 日時・場所・案件・状態が最後に変わった日時（0086 のトリガーで記録。スタッフのシフト一覧の「変更」の印に使う。#155）
  'staff_changed_at',
  // 案件の現場責任者の連絡先（#173。api.ts の STAFF_SHIFT_PLACE_COLUMNS で付ける）
  'site_contact_name', 'site_contact_phone',
] as const
export function staffShiftView(row: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!row) return null
  const out: Record<string, any> = {}
  for (const k of STAFF_SHIFT_COLUMNS) if (row[k] !== undefined) out[k] = row[k]
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
// 時刻は 00:00〜23:59 だけを受け付ける（25:00 や 99:99 を通さない。#218）
const isTime = (s: any) => isHHMM(s)
const intOrNull = (v: any) => (v === '' || v == null || isNaN(Number(v))) ? null : Math.round(Number(v))

// ---------- 金額・休憩・数量の範囲（#218） ----------
// 単価・交通費は0以上、休憩は0〜600分、数量は0〜24。調整額（bill_adjust / pay_adjust）は控除に使うため負の値も認める
export const MONEY_MAX = 10000000
export const BREAK_MAX = 600
export const QTY_MAX = 24
// [項目名, 値, 最小, 最大] を並べて渡し、範囲外の最初の項目のエラー文を返す（空欄・未指定は確かめない）
export function rangeError(items: [string, any, number, number][]): string | null {
  for (const [label, v, min, max] of items) {
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    if (typeof v === 'boolean' || typeof v === 'object' || !Number.isFinite(n)) return `${label}は数値で入力してください`
    if (n < min) return min === 0 ? `${label}にマイナスの値は入力できません` : `${label}は${min}〜${max}の範囲で入力してください`
    if (n > max) return `${label}は${min}〜${max}の範囲で入力してください`
  }
  return null
}
const unitOf = (v: any): 'daily' | 'hourly' => (v === 'hourly' ? 'hourly' : 'daily')

// =========================================================
// 単価の解決
// 優先順: シフトの手動変更 ＞ 枠の役割の単価 ＞ 単価ルール（具体度: スタッフ8 役割4 開催場所2 案件1 クライアント0.5。#470）＞ 案件の標準
// 項目ごとに（請求単価 / 支払単価 / 交通費の請求 / 交通費の支払）最も具体的な値を採用する
// 単価ルールと案件の標準単価は、シフトの稼働日（work_date）に適用期間が含まれるものを使う（#210）
// =========================================================
export type PriceContext = { company_id: number; project_id: number; site_id?: number | null; role_name?: string | null; staff_id?: number | null; slot_role?: any; work_date?: string | null }
export type PricingData = { projects: Map<number, any>; rules: any[]; history?: Map<number, any[]> }
export type ResolvedPrice = {
  bill_unit_type: string; bill_rate: number | null; pay_unit_type: string; pay_rate: number | null
  bill_transport_type: string; bill_transport_amount: number; pay_transport_type: string; pay_transport_amount: number
  sources: Record<string, string>
}

// クライアント単位のルール（#470）は案件より弱い 0.5（同じ条件なら案件のルールが勝つ）
function ruleScore(r: any) { return (r.staff_id ? 8 : 0) + (r.role_name ? 4 : 0) + (r.site_id ? 2 : 0) + (r.project_id ? 1 : 0) + (r.client_id && !r.project_id ? 0.5 : 0) }
function ruleLabel(r: any) {
  const p: string[] = []
  if (r.client_id && !r.project_id) p.push('クライアント')
  if (r.project_id) p.push('案件'); if (r.site_id) p.push('開催場所'); if (r.role_name) p.push('役割'); if (r.staff_id) p.push('スタッフ')
  return 'ルール#' + r.rule_id + '（' + (p.join('×') || '全体') + '）'
}

export async function loadPricingData(db: D1Database, companyId: number, projectIds: number[]) {
  // 案件IDは json_each で1つにまとめてバインドする（D1 のバインド上限 100 を超えないように）
  const ids = bindJsonArray(projectIds)
  const projects = ids !== '[]' ? (await db.prepare(`SELECT project_id, unit_price_type, unit_price, pay_unit_type, pay_rate,
      bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount, default_break_minutes, hours_basis, time_round_minutes,
      pay_time_round, price_valid_from, client_id
      FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(companyId, ids).all()).results as any[] : []
  // クライアント単位のルール（#470）は、対象の案件のクライアントのものだけを読む
  const rules = (await db.prepare(`SELECT * FROM rate_rules WHERE company_id = ? AND (project_id IS NULL OR project_id IN ${JSON_IN})
      AND (client_id IS NULL OR project_id IS NOT NULL OR client_id IN (SELECT p.client_id FROM projects p WHERE p.company_id = ? AND p.project_id IN ${JSON_IN}))`)
    .bind(companyId, ids, companyId, ids).all()).results as any[]
  // 改定前の案件の標準単価（#210）
  const history = new Map<number, any[]>()
  if (ids !== '[]') {
    const rows = (await db.prepare(`SELECT * FROM project_price_history WHERE company_id = ? AND project_id IN ${JSON_IN} ORDER BY project_id, valid_to, history_id`)
      .bind(companyId, ids).all()).results as any[]
    for (const h of rows) { const a = history.get(h.project_id) || []; a.push(h); history.set(h.project_id, a) }
  }
  return { projects: new Map(projects.map(p => [p.project_id, p])), rules, history } as PricingData
}

// 稼働日に使う案件の標準単価。今の標準単価の適用開始日より前の稼働日は、その日を含む改定前の単価を使う（見つからなければ今の単価）
export const PROJECT_PRICE_FIELDS = ['unit_price_type', 'unit_price', 'pay_unit_type', 'pay_rate', 'bill_transport_type', 'bill_transport_amount', 'pay_transport_type', 'pay_transport_amount'] as const
export function projectPriceOn(p: any, history: any[] | undefined, workDate?: string | null) {
  if (!p || !workDate || !p.price_valid_from || workDate >= p.price_valid_from) return p || {}
  const h = (history || []).find(x => (!x.valid_from || x.valid_from <= workDate) && x.valid_to >= workDate)
  if (!h) return p
  const out: any = { ...p }
  for (const k of PROJECT_PRICE_FIELDS) out[k] = h[k]
  return out
}
// 単価ルールの適用期間に稼働日が含まれるか（期間のないルール、稼働日の分からないプレビューは常に対象）
export const ruleActiveOn = (r: any, workDate?: string | null) => !workDate || ((!r.valid_from || r.valid_from <= workDate) && (!r.valid_to || r.valid_to >= workDate))

export function resolvePrice(ctx: PriceContext, data: PricingData): ResolvedPrice {
  const proj = data.projects.get(Number(ctx.project_id))
  const p = projectPriceOn(proj, data.history?.get(Number(ctx.project_id)), ctx.work_date)
  const unit = unitOf
  const out: ResolvedPrice = {
    bill_unit_type: unit(p.unit_price_type), bill_rate: p.unit_price ?? null,
    pay_unit_type: unit(p.pay_unit_type), pay_rate: p.pay_rate ?? null,
    bill_transport_type: p.bill_transport_type || 'actual', bill_transport_amount: p.bill_transport_amount || 0,
    pay_transport_type: p.pay_transport_type || 'actual', pay_transport_amount: p.pay_transport_amount || 0,
    sources: { bill: '案件の標準', pay: p.pay_rate == null ? '未設定' : '案件の標準', bill_transport: '案件の標準', pay_transport: '案件の標準' },
  }
  const matches = data.rules.filter(r => ruleActiveOn(r, ctx.work_date) &&
    (!r.project_id || Number(r.project_id) === Number(ctx.project_id)) &&
    (!r.client_id || r.project_id || (proj?.client_id != null && Number(r.client_id) === Number(proj.client_id))) &&
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
// 請求と支払で時間が違う（支払は丸めない #220）ときは { bill, pay } で渡す（workHours の hours と pay_hours）
export function calcAmounts(price: Pick<ResolvedPrice, 'bill_unit_type' | 'bill_rate' | 'pay_unit_type' | 'pay_rate'>, start: string, end: string, breakMin: number,
  hoursOverride?: number | { bill: number; pay: number } | null) {
  const planned = Math.max(0, spanMinutes(start, end) - (breakMin || 0))
  const toMinutes = (h: number | null | undefined) => (h != null ? Math.max(0, Math.round(h * 60)) : planned)
  const billMin = toMinutes(typeof hoursOverride === 'object' && hoursOverride ? hoursOverride.bill : hoursOverride as number | null | undefined)
  const payMin = toMinutes(typeof hoursOverride === 'object' && hoursOverride ? hoursOverride.pay : hoursOverride as number | null | undefined)
  const hourly = (u: string) => u === 'hourly'
  const qty = (u: string, minutes: number) => (hourly(u) ? Math.round(minutes / 60 * 100) / 100 : 1)
  const amount = (u: string, rate: number, minutes: number) => (hourly(u) ? Math.round(rate * minutes / 60) : Math.round(rate))
  return {
    bill_qty: qty(price.bill_unit_type, billMin), unit_price: amount(price.bill_unit_type, price.bill_rate || 0, billMin),
    pay_qty: qty(price.pay_unit_type, payMin), pay_amount: price.pay_rate == null ? null : amount(price.pay_unit_type, price.pay_rate, payMin),
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
  // 保存済みの実績は、入力の検証を厳しくする前（#218）の 24:30 などもあるため、形だけを見る
  const storedTime = (t: any) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)
  const hasActual = storedTime(s.actual_start) && storedTime(s.actual_end)
  // planned_break_minutes = 予定の休憩、break_minutes = 実働の計算に使った休憩（実績の休憩があればその値）
  // hours = 請求の数量に使う時間、pay_hours = 支払の数量に使う時間（支払側の丸めを分ける #220。pay_time_round が same のときだけ支払も丸める）
  if (!hasActual) return { hours: round2(planned), pay_hours: round2(planned), planned_hours: round2(planned), actual_hours: null as number | null, basis, used: 'planned' as const, break_minutes: brkPlan, planned_break_minutes: brkPlan }
  // 実績は時刻だけを記録しているため、予定の開始に最も近い日（前日・当日・翌日）の時刻とみなす（#80）。
  // 日をまたぐ予定で0時を過ぎてから始めた場合は翌日、0時台に始まる予定で前日の23時台に始めた場合は前日になる
  let aStart = toMin(s.actual_start)
  if (aStart - planStart > 720) aStart -= 1440
  else if (planStart - aStart > 720) aStart += 1440
  let aEnd = toMin(s.actual_end); while (aEnd <= aStart) aEnd += 1440
  const brk = s.actual_break_minutes != null ? Number(s.actual_break_minutes) : brkPlan
  const calc = (r: number) => {
    const roundUp = (m: number) => (r > 0 ? Math.ceil(m / r) * r : m), roundDown = (m: number) => (r > 0 ? Math.floor(m / r) * r : m)
    const actual = Math.max(0, roundDown(aEnd) - roundUp(aStart) - brk) / 60
    const cs = roundUp(Math.max(aStart, planStart)), ce = roundDown(Math.min(aEnd, planEnd))
    const clipped = Math.max(0, ce - cs - brk) / 60
    return { actual, hours: basis === 'scheduled' ? planned : basis === 'actual' ? actual : clipped }
  }
  const r = Number(proj.time_round_minutes || 0)
  const bill = calc(r), pay = proj.pay_time_round === 'same' ? bill : calc(0)
  return { hours: round2(bill.hours), pay_hours: round2(pay.hours), planned_hours: round2(planned), actual_hours: round2(bill.actual), basis, used: basis === 'scheduled' ? 'planned' as const : 'actual' as const, break_minutes: brk, planned_break_minutes: brkPlan }
}
// workHours の結果を calcAmounts に渡す形にする（請求と支払の時間）
export const hoursForAmounts = (h: { hours: number; pay_hours: number }) => ({ bill: h.hours, pay: h.pay_hours })
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
// 支払には深夜・時間外・休日の割増（pay_premium。#167）を足す。未確定のシフトの割増は lib/premium-pay の attachPremiums で行に付けてから呼ぶ
// （付けていない行は、確定したときに記録した値。未確定なら 0）
export function shiftTotals(s: any) {
  const t = transportAmounts(s)
  const bill = Number(s.unit_price || 0) + t.bill_transport + Number(s.bill_adjust || 0)
  const premium = Number(s.pay_premium || 0)
  const pay = s.pay_amount == null ? null : Number(s.pay_amount || 0) + t.pay_transport + Number(s.pay_adjust || 0) + premium
  return { bill_total: bill, pay_total: pay, pay_premium: premium, ...t }
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
// 枠のシフトは、単価ルールの役割を枠の役割（slot_role_id）から決める。役割の名前を変えても単価を変えないことを選んだ役割は、
// 変更前の名前（rate_role_name）で照合する（#144）。枠のないシフトはシフトの役割名で照合する
export function rateRoleName(s: any, slotRole: any): string | null {
  return (slotRole ? (slotRole.rate_role_name || slotRole.role_name) : null) || s.role || null
}
export function computeShiftPricing(companyId: number, s: any, slotRole: any, payee: Payee, data: PricingData) {
  const price = resolvePrice({ company_id: companyId, project_id: s.project_id, site_id: s.site_id, role_name: rateRoleName(s, slotRole), staff_id: s.staff_id, slot_role: slotRole, work_date: s.work_date }, data)
  const proj = data.projects.get(Number(s.project_id)) || {}
  const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
  const amt = calcAmounts(price, s.start_time, s.end_time, brk, hoursForAmounts(workHours({ ...s, break_minutes: brk }, proj)))
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

// ---------- 必要人数の超過（#407） ----------
// adds: 役割（slot_role_id）ごとに、今回確定・代打として加える人数。確定・代打の人数＋今回の人数が必要人数を超える役割の警告を返す。
// excludeShiftIds: 数えないシフト（移動・確定にする本人のシフト）。文言は募集の承認（recruit.ts の approvalWarnings）とそろえる
export async function capacityWarnings(db: D1Database, companyId: number, adds: Map<number, number>, excludeShiftIds: number[] = []): Promise<string[]> {
  const ids = [...adds.entries()].filter(([, n]) => n > 0).map(([id]) => id)
  if (!ids.length) return []
  const rows = (await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, s.work_date, s.start_time, s.end_time,
      (SELECT COUNT(*) FROM shifts x WHERE x.slot_role_id = r.slot_role_id AND x.status IN ('confirmed','substitute') AND x.shift_id NOT IN ${JSON_IN}) AS filled
    FROM shift_slot_roles r JOIN shift_slots s ON s.slot_id = r.slot_id WHERE s.company_id = ? AND r.slot_role_id IN ${JSON_IN}`)
    .bind(bindJsonArray(excludeShiftIds), companyId, bindJsonArray(ids)).all()).results as any[]
  const out: string[] = []
  for (const r of rows) {
    const add = adds.get(Number(r.slot_role_id)) || 0
    if (Number(r.filled) + add > Number(r.headcount))
      out.push(`${String(r.work_date).slice(5).replace('-', '/')} ${r.start_time}〜${r.end_time} ${r.role_name}: 定員（${r.headcount}名）を超えます（確定・代打 ${Number(r.filled)}名＋今回 ${add}名）`)
  }
  return out
}

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

/**
 * 期間内の人員不足の枠（役割ごとの確定・代打が必要人数に満たないもの）と、希望（仮）のままのシフト（ダッシュボード #299）。
 * 充足の数え方はシフトボードと同じ（退職などで稼働できない人は数えない）。返す行数には上限を設ける
 */
export const STAFFING_GAP_LIMIT = 100
export async function staffingGaps(db: D1Database, companyId: number, from: string, to: string) {
  const [roleRows, assignedRows, requestedRows] = (await db.batch([
    db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.slot_id, sl.work_date, sl.start_time, sl.end_time, p.project_id, p.project_name,
        (SELECT COUNT(*) FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
          WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending' AND a.status = 'pending') AS applicants
      FROM shift_slots sl JOIN shift_slot_roles r ON r.slot_id = sl.slot_id JOIN projects p ON p.project_id = sl.project_id AND p.company_id = sl.company_id
      WHERE sl.company_id = ? AND sl.work_date BETWEEN ? AND ?
      ORDER BY sl.work_date, sl.start_time, p.project_name, r.sort_order, r.slot_role_id`).bind(companyId, from, to),
    db.prepare(`SELECT s.slot_role_id, s.work_date, s.status, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type,
        COALESCE(sp.employment_status,'working') AS employment_status, us.status AS user_status, us.retired_at, sp.link_ended_at,
        COALESCE(emp_sp.employment_status,'working') AS emp_status, emp_us.status AS emp_user_status, emp_us.retired_at AS emp_retired_at
      FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
      LEFT JOIN staff_profiles emp_sp ON sp.affiliation_type = 'linked_external' AND emp_sp.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
      LEFT JOIN users emp_us ON emp_us.user_id = emp_sp.user_id
      WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? AND s.slot_role_id IS NOT NULL AND s.status IN ('confirmed','substitute','requested')`).bind(companyId, from, to),
    db.prepare(`SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.slot_role_id, p.project_id, p.project_name, us.name AS staff_name
      FROM shifts s JOIN projects p ON p.project_id = s.project_id AND p.company_id = s.company_id
      JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
      WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? AND s.status = 'requested'
      ORDER BY s.work_date, s.start_time, p.project_name, us.name LIMIT ?`).bind(companyId, from, to, STAFFING_GAP_LIMIT + 1),
  ])).map(r => (r.results || []) as any[])
  const count = new Map<number, { filled: number; requested: number }>()
  for (const a of assignedRows) {
    const c = count.get(a.slot_role_id) || { filled: 0, requested: 0 }
    if (a.status === 'requested') c.requested++
    else if (!unavailableOn(a.work_date, a.affiliation_type, { employment_status: a.employment_status, user_status: a.user_status, retired_at: a.retired_at, link_ended_at: a.link_ended_at },
      { employment_status: a.emp_status, user_status: a.emp_user_status, retired_at: a.emp_retired_at })) c.filled++
    count.set(a.slot_role_id, c)
  }
  const short = roleRows.map(r => {
    const c = count.get(r.slot_role_id) || { filled: 0, requested: 0 }
    return { ...r, filled: c.filled, requested: c.requested, applicants: Number(r.applicants) || 0, shortage: Number(r.headcount) - c.filled }
  }).filter(r => r.shortage > 0)
  return {
    from, to,
    short_roles: short.slice(0, STAFFING_GAP_LIMIT), short_role_count: short.length,
    short_headcount: short.reduce((a, r) => a + r.shortage, 0),
    requested_shifts: requestedRows.slice(0, STAFFING_GAP_LIMIT), requested_more: requestedRows.length > STAFFING_GAP_LIMIT,
  }
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

// ---------- クライアントに出す配置表（#298） ----------
// ボードの絞り込み（期間・クライアント・案件・区分・開催場所）のまま、金額を含めずに出す。未充足の枠（あと何名）と希望（仮）も載せる。
// format=csv: 1人1行の CSV（未充足は1枠1行）/ format=print: 案件ごとに改ページする印刷用の画面。
// 欠勤のシフトと、退職などで稼働できない人は載せない（不足に数える）
const PLACEMENT_STATUS: Record<string, string> = { confirmed: '確定', substitute: '代打', requested: '希望（仮）' }
const WD_JA = ['日', '月', '火', '水', '木', '金', '土']
const htmlEsc = (v: any) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
type PlacementLine = {
  work_date: string; client_name: string; project_id: number; project_name: string; site: string; start_time: string; end_time: string; role: string
  headcount: number | null; filled: number; staff: { name: string; status: string; start_time: string; end_time: string }[]
}
app.get('/shift-board/export', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const print = c.req.query('format') === 'print'
  const from = c.req.query('from'); let to = c.req.query('to')
  if (!isDate(from)) return c.json({ error: '開始日を指定してください' }, 400)
  if (!isDate(to) || dayDiff(from!, to!) < 0) to = addDays(from!, 6)
  if (dayDiff(from!, to!) > MAX_RANGE_DAYS - 1) to = addDays(from!, MAX_RANGE_DAYS - 1)
  const clientId = intOrNull(c.req.query('client_id')), projectIds = parseIds(c.req.query('project_ids')), siteId = intOrNull(c.req.query('site_id'))
  const engagement = c.req.query('engagement')
  // 希望（仮）を載せるか（既定は載せる。include_requested=0 で確定・代打だけ）
  const withRequested = c.req.query('include_requested') !== '0'
  const pf: string[] = ['p.company_id = ?']; const pb: any[] = [u.company_id]
  if (clientId) { pf.push('p.client_id = ?'); pb.push(clientId) }
  if (projectIds.length) { pf.push(`p.project_id IN ${JSON_IN}`); pb.push(bindJsonArray(projectIds)) }
  if (engagement === 'regular' || engagement === 'spot') { pf.push("COALESCE(p.engagement_type,'regular') = ?"); pb.push(engagement) }
  const inP = `(SELECT p.project_id FROM projects p WHERE ${pf.join(' AND ')})`
  const siteCond = siteId ? 'AND x.site_id = ?' : ''
  const siteBind = siteId ? [siteId] : []
  const [projRes, slotRes, roleRes, shiftRes] = await db.batch([
    db.prepare(`SELECT p.project_id, p.project_name, cl.client_name FROM projects p LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
      WHERE ${pf.join(' AND ')}`).bind(...pb),
    db.prepare(`SELECT x.slot_id, x.project_id, x.work_date, x.start_time, x.end_time, x.location, si.site_name FROM shift_slots x LEFT JOIN sites si ON si.site_id = x.site_id
      WHERE x.company_id = ? AND x.project_id IN ${inP} AND x.work_date BETWEEN ? AND ? ${siteCond}`).bind(u.company_id, ...pb, from, to, ...siteBind),
    db.prepare(`SELECT r.slot_role_id, r.slot_id, r.role_name, r.headcount FROM shift_slot_roles r JOIN shift_slots x ON x.slot_id = r.slot_id
      WHERE x.company_id = ? AND x.project_id IN ${inP} AND x.work_date BETWEEN ? AND ? ${siteCond} ORDER BY r.sort_order, r.slot_role_id`).bind(u.company_id, ...pb, from, to, ...siteBind),
    db.prepare(`SELECT x.shift_id, x.project_id, x.slot_role_id, x.work_date, x.start_time, x.end_time, x.role, x.location, x.status, si.site_name, us.name AS staff_name,
        COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, COALESCE(sp.employment_status,'working') AS st_employment_status, us.status AS st_user_status,
        us.retired_at AS st_retired_at, sp.link_ended_at AS st_link_ended_at,
        COALESCE(emp_sp.employment_status,'working') AS st_emp_status, emp_us.status AS st_emp_user_status, emp_us.retired_at AS st_emp_retired_at
      FROM shifts x JOIN staff_profiles sp ON sp.staff_id = x.staff_id JOIN users us ON us.user_id = sp.user_id
      LEFT JOIN staff_profiles emp_sp ON sp.affiliation_type = 'linked_external' AND emp_sp.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
      LEFT JOIN users emp_us ON emp_us.user_id = emp_sp.user_id
      LEFT JOIN sites si ON si.site_id = x.site_id
      WHERE x.company_id = ? AND x.project_id IN ${inP} AND x.work_date BETWEEN ? AND ? ${siteCond} AND x.status IN ('confirmed','substitute','requested')
      ORDER BY x.start_time, us.name`).bind(u.company_id, ...pb, from, to, ...siteBind),
  ])
  const projects = new Map((projRes.results as any[]).map(p => [p.project_id, p]))
  const shifts = (shiftRes.results as any[]).filter(x => x.status !== 'requested' || withRequested)
    .filter(x => !unavailableOn(x.work_date, x.affiliation_type,
      { employment_status: x.st_employment_status, user_status: x.st_user_status, retired_at: x.st_retired_at, link_ended_at: x.st_link_ended_at },
      { employment_status: x.st_emp_status, user_status: x.st_emp_user_status, retired_at: x.st_emp_retired_at }))
  const byRole = new Map<number, any[]>()
  for (const x of shifts) if (x.slot_role_id) { const a = byRole.get(x.slot_role_id) || []; a.push(x); byRole.set(x.slot_role_id, a) }
  const rolesBySlot = new Map<number, any[]>()
  for (const r of roleRes.results as any[]) { const a = rolesBySlot.get(r.slot_id) || []; a.push(r); rolesBySlot.set(r.slot_id, a) }
  const staffOf = (a: any) => ({ name: a.staff_name, status: PLACEMENT_STATUS[a.status] || a.status, start_time: a.start_time, end_time: a.end_time })
  // 枠の役割ごとに1行（印刷用。CSV ではこれを1人1行に広げる）
  const lines: PlacementLine[] = []
  const knownRoles = new Set<number>()
  for (const sl of slotRes.results as any[]) {
    const p = projects.get(sl.project_id); if (!p) continue
    for (const r of rolesBySlot.get(sl.slot_id) || []) {
      knownRoles.add(r.slot_role_id)
      const assigned = byRole.get(r.slot_role_id) || []
      lines.push({ work_date: sl.work_date, client_name: p.client_name || '', project_id: p.project_id, project_name: p.project_name, site: sl.site_name || sl.location || '',
        start_time: sl.start_time, end_time: sl.end_time, role: r.role_name, headcount: Number(r.headcount || 0),
        filled: assigned.filter(a => a.status !== 'requested').length, staff: assigned.map(staffOf) })
    }
  }
  // 枠のないシフト（常勤の一括登録など）と、役割が消えた枠のシフトは1人1行で載せる（必要人数は空欄）
  for (const x of shifts) {
    if (x.slot_role_id && knownRoles.has(x.slot_role_id)) continue
    const p = projects.get(x.project_id); if (!p) continue
    lines.push({ work_date: x.work_date, client_name: p.client_name || '', project_id: p.project_id, project_name: p.project_name, site: x.site_name || x.location || '',
      start_time: x.start_time, end_time: x.end_time, role: x.role || '', headcount: null, filled: x.status !== 'requested' ? 1 : 0, staff: [staffOf(x)] })
  }
  lines.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.client_name.localeCompare(b.client_name, 'ja') || a.project_name.localeCompare(b.project_name, 'ja')
    || a.start_time.localeCompare(b.start_time) || a.site.localeCompare(b.site, 'ja') || a.role.localeCompare(b.role, 'ja'))
  const short = (l: PlacementLine) => (l.headcount == null ? 0 : Math.max(0, l.headcount - l.filled))
  const wd = (d: string) => WD_JA[weekday(d)]
  const title = `配置表_${from}_${to}`
  if (!print) {
    const rows: any[][] = []
    for (const l of lines) {
      const base = [l.work_date, wd(l.work_date), l.client_name, l.project_name, l.site]
      const counts = [l.headcount ?? '', l.headcount == null ? '' : Math.min(l.filled, l.headcount), l.headcount == null ? '' : short(l)]
      for (const st of l.staff) rows.push([...base, st.start_time, st.end_time, l.role, ...counts, st.name, st.status])
      if (short(l)) rows.push([...base, l.start_time, l.end_time, l.role, ...counts, `（未充足 あと${short(l)}名）`, '未充足'])
    }
    return csvResponse(`${title}.csv`, toCsv(['日付', '曜日', 'クライアント', '案件', '開催場所', '開始', '終了', '役割', '必要人数', '充足', '不足', 'スタッフ', '状態'], rows))
  }
  // 印刷: 案件ごとに改ページし、枠の役割を1行にする（スタッフの時間が枠と違うときは名前の後ろに添える）
  const groups = new Map<number, PlacementLine[]>()
  for (const l of lines) { const a = groups.get(l.project_id) || []; a.push(l); groups.set(l.project_id, a) }
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${wd(d)})`
  const sections = [...groups.values()].map(ls => {
    const req = ls.reduce((n, l) => n + (l.headcount || 0), 0), shortTotal = ls.reduce((n, l) => n + short(l), 0)
    const body = ls.map(l => {
      const names = l.staff.map(st => htmlEsc(st.name) + (st.status === '確定' ? '' : `<small>（${htmlEsc(st.status)}）</small>`)
        + (st.start_time !== l.start_time || st.end_time !== l.end_time ? `<small> ${htmlEsc(st.start_time)}〜${htmlEsc(st.end_time)}</small>` : '')).join('、')
      const shortHtml = short(l) ? `${names ? '、' : ''}<span class="short">未充足 あと${short(l)}名</span>` : ''
      return `<tr><td>${htmlEsc(md(l.work_date))}</td><td>${htmlEsc(l.start_time)}〜${htmlEsc(l.end_time)}</td><td>${htmlEsc(l.site)}</td><td>${htmlEsc(l.role)}</td>
        <td class="n">${l.headcount == null ? '' : `${Math.min(l.filled, l.headcount)}/${l.headcount}`}</td><td>${names}${shortHtml}</td></tr>`
    }).join('')
    return `<section><h2>${htmlEsc(ls[0].client_name ? ls[0].client_name + ' ／ ' : '')}${htmlEsc(ls[0].project_name)}</h2>
<p class="meta">期間: ${htmlEsc(from)} 〜 ${htmlEsc(to)}${req ? `・必要 ${req}名` : ''}${shortTotal ? `・<span class="short">未充足 ${shortTotal}名</span>` : ''}</p>
<table><thead><tr><th>日付</th><th>時間</th><th>開催場所</th><th>役割</th><th>充足</th><th>スタッフ</th></tr></thead><tbody>${body}</tbody></table></section>`
  }).join('')
  const co = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.html(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${htmlEsc(title)}</title>
<style>
body{font-family:"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;color:#111;margin:24px;font-size:12px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:0 0 4px}.meta{color:#444;margin:0 0 8px}
section{margin-bottom:24px}section+section{break-before:page;page-break-before:always}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:3px 5px;vertical-align:top;text-align:left}th{background:#f2f2f2}
td.n{text-align:right;white-space:nowrap}.short{color:#c00;font-weight:bold}small{color:#555}
.bar{margin-bottom:12px}.bar button{padding:6px 14px;font-size:13px}@media print{.bar{display:none}body{margin:0}}@page{size:A4;margin:12mm}
</style></head><body><div class="bar"><button type="button" onclick="window.print()">印刷・PDFに保存</button></div>
<h1>配置表</h1><p class="meta">${htmlEsc(co?.company_name || '')}・作成日 ${htmlEsc(todayJST())}${withRequested ? '・（仮）は希望の段階で未確定です' : ''}</p>
${sections || '<p>この期間・条件のシフト枠はありません</p>'}</body></html>`)
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
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    WHERE sp.company_id = ? AND ${elig.sql}
    ORDER BY us.name`).bind(role.project_id, role.site_id ?? -1, weekStart(role.work_date), addDays(weekStart(role.work_date), 6), u.company_id, ...elig.binds).all()).results as any[]
  const conflicts = await findConflicts(db, u.company_id, staff.map(s => s.staff_id), role.work_date, role.work_date)
  const ng = await ngStaffIds(db, role.project_id)
  // スキルは保存のときと同じく , 、 ， で区切り、前後の空白を除いて比べる（#556。スタッフのスキルが読点区切りでも一致する）
  const splitSkills = (v: any) => String(v || '').split(/[,、，]/).map(s => s.trim()).filter(Boolean)
  const required = splitSkills(proj?.required_skills)
  const assigned = new Set(((await db.prepare("SELECT staff_id FROM shifts WHERE slot_role_id = ? AND status != 'absent'").bind(role.slot_role_id).all()).results as any[]).map(r => r.staff_id))
  const tdefs = await loadTransportDefaults(db, u.company_id, staff.map(s => s.staff_id))
  const list = staff.filter(s => !assigned.has(s.staff_id)).map(s => {
    const skills = splitSkills(s.skills)
    const matched = required.filter(r => skills.includes(r))
    const cf = conflictFor(conflicts.get(s.staff_id), role.work_date, role.start_time, role.end_time)
    const availableFrom = isDate(s.available_from) ? s.available_from : null
    return {
      staff_id: s.staff_id, name: s.name, affiliation_type: s.affiliation_type, employment_status: s.employment_status,
      work_area: s.work_area || '', available_from: availableFrom,
      project_count: s.project_count, site_count: s.site_count, week_days: s.week_days,
      skill_match: matched.length, skill_required: required.length,
      // 一致したスキルと足りないスキルの名前（#556）
      skill_matched: matched, skill_missing: required.filter(r => !skills.includes(r)),
      busy: cf.length > 0, busy_detail: cf.map(x => conflictLabel(x, u.company_id)),
      ng: ng.includes(s.staff_id), on_leave: s.employment_status === 'leave',
      // 入社予定の人と、稼働開始可能日が枠の日付より後の人は注意として出し、空きのある人の後ろに回す（#557）
      preboarding: s.employment_status === 'preboarding', not_yet_available: !!availableFrom && availableFrom > role.work_date,
      // 交通費の標準（#564。この枠の開催場所 → スタッフの標準。なければ null）
      transport_default: transportDefaultFor(tdefs, s.staff_id, role.site_id),
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
    // 単価には単位を必ず付ける。単位を省略したら日額（単価ルールと同じ。案件の単位を引き継ぐと、日額のつもりの金額が時給で計算されるため #145）
    bill_unit_type: intOrNull(r.bill_rate) == null ? null : unitOf(r.bill_unit_type),
    pay_unit_type: intOrNull(r.pay_rate) == null ? null : unitOf(r.pay_unit_type),
  }))
  if (out.some(r => !r.role_name)) return null
  return out
}
// 枠の役割の単価・人数の範囲（#218）。normalizeRoles の前に呼ぶ
function rolesRangeError(roles: any): string | null {
  if (!Array.isArray(roles)) return null
  for (const r of roles) {
    if (!r || r._delete) continue
    const name = String(r.role_name || '').trim() || '役割'
    const err = rangeError([[`「${name}」の請求単価`, r.bill_rate, 0, MONEY_MAX], [`「${name}」の支払単価`, r.pay_rate, 0, MONEY_MAX], [`「${name}」の必要人数`, r.headcount, 1, 200]])
    if (err) return err
  }
  return null
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
// 終了した案件（#153）には募集枠を作らない（割り当ては assertAssignable で止めている。画面は稼働中の案件だけを出す）
const CLOSED_PROJECT_SLOT_ERROR = '終了した案件には募集枠を作れません（案件詳細で「稼働中に戻す」と作れます）'
const projectClosed = (p: any) => !!p && (p.status || 'active') !== 'active'
async function validateSlotBody(db: D1Database, u: any, b: any): Promise<string | null> {
  const proj = b.project_id ? await ownProject(db, u.company_id, b.project_id) : null
  if (!proj) return '案件を選択してください'
  if (projectClosed(proj)) return CLOSED_PROJECT_SLOT_ERROR
  if (!isTime(b.start_time) || !isTime(b.end_time)) return '開始・終了時刻を入力してください'
  if (b.site_id && !(await ownSite(db, u.company_id, b.site_id))) return '開催場所が見つかりません'
  return rangeError([['休憩', b.break_minutes, 0, BREAK_MAX]]) || rolesRangeError(b.roles)
}
// 枠の役割名の変更と単価ルール（#144）。単価ルールは役割名で照合するため、名前を変えると当たるルールが変わることがある。
// 変更前・変更後の名前の単価ルールがあるときは、どちらで計算するかを確かめる（role_rate: follow = 新しい名前のルール / keep = 今のルールのまま）。
// 返す map: 名前を変える役割ごとの、単価ルールの照合に使う名前（rate_role_name。null = 役割名で照合）
async function planRoleRename(db: D1Database, companyId: number, slot: any, b: any) {
  const map = new Map<number, string | null>()
  if (!Array.isArray(b.roles)) return { map }
  const cur = new Map(((await db.prepare('SELECT slot_role_id, role_name, rate_role_name FROM shift_slot_roles WHERE slot_id = ?').bind(slot.slot_id).all()).results as any[]).map(r => [r.slot_role_id, r]))
  const ask: { slot_role_id: number; from: string; to: string; rules_from: number; rules_to: number }[] = []
  for (const r of b.roles) {
    const c = r && !r._delete ? cur.get(Number(r.slot_role_id)) : null
    const to = String(r?.role_name || '').trim()
    if (!c || !to || to === c.role_name) continue
    const from = c.rate_role_name || c.role_name
    if (to === from) { map.set(c.slot_role_id, null); continue }
    const n = await db.prepare(`SELECT SUM(role_name = ?) AS f, SUM(role_name = ?) AS t FROM rate_rules
      WHERE company_id = ? AND role_name IN (?, ?) AND (project_id IS NULL OR project_id = ?)
        AND (client_id IS NULL OR project_id IS NOT NULL OR client_id = (SELECT client_id FROM projects WHERE project_id = ?))`).bind(from, to, companyId, from, to, slot.project_id, slot.project_id).first() as any
    const rf = Number(n?.f || 0), rt = Number(n?.t || 0)
    if (!rf && !rt) { map.set(c.slot_role_id, null); continue }
    if (b.role_rate === 'follow') map.set(c.slot_role_id, null)
    else if (b.role_rate === 'keep') map.set(c.slot_role_id, from)
    else ask.push({ slot_role_id: c.slot_role_id, from, to, rules_from: rf, rules_to: rt })
  }
  if (ask.length) {
    const text = ask.map(a => `役割「${a.from}」→「${a.to}」: 「${a.from}」の単価ルール ${a.rules_from}件、「${a.to}」の単価ルール ${a.rules_to}件`).join('\n')
    return { map, confirm: { error: `役割名を変えると、当たる単価ルールが変わります。\n${text}`, need_role_rate: true, roles: ask } }
  }
  return { map }
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

// 枠の変更: 日付・時間・場所・休憩・役割（人数・単価）。
//  - 役割・開催場所・割り当て済みスタッフの確認をすべて済ませてから、枠・役割・シフトの更新を1つの batch で書く（途中で失敗しても一部だけ保存しない。#146）
//  - 日付・時刻を変えるとき、勤怠・日報の報告があるシフトと確定済みのシフトは動かさず、元の日時のまま「枠なし」にする。
//    それらがあるとき、または割り当て済みスタッフに重複・NG などの警告があるときは、確認のうえ force で続ける（#57 #117）
//  - シフトには、枠で変えた項目だけを反映する。休憩は、シフトの値が変更前の枠の値と同じとき（シフトごとに直していないとき）だけ書き換える（#118）
//  - 送られていない項目は変えない。開催場所は site_id を送らなければそのまま（無効にした場所でも外さない。#492）
const SLOT_EDIT_FIELDS = ['site_id', 'location', 'work_date', 'start_time', 'end_time', 'break_minutes', 'memo', 'status'] as const
const sameVal = (a: any, b: any) => (a ?? null) === (b ?? null)
app.put('/shift-slots/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const slot = await ownSlot(db, u.company_id, c.req.param('id'))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const next: any = { ...slot }
  for (const k of SLOT_EDIT_FIELDS) if (b[k] !== undefined) next[k] = b[k]
  next.site_id = intOrNull(next.site_id); next.break_minutes = intOrNull(next.break_minutes)
  next.location = String(next.location ?? '').trim() || null; next.memo = next.memo || null; next.status = next.status === 'closed' ? 'closed' : 'open'
  if (!isTime(next.start_time) || !isTime(next.end_time) || !isDate(next.work_date)) return c.json({ error: '日付・時刻が正しくありません' }, 400)
  const siteChanged = !sameVal(next.site_id, slot.site_id)
  if (next.site_id && siteChanged) {
    const site = await ownSite(db, u.company_id, next.site_id)
    if (!site) return c.json({ error: '開催場所が見つかりません' }, 400)
    if (site.status === 'inactive') return c.json({ error: '無効にした開催場所は選べません（クライアント詳細で有効にしてください）' }, 400)
  }
  const rangeErr = rangeError([['休憩', next.break_minutes, 0, BREAK_MAX]]) || rolesRangeError(b.roles); if (rangeErr) return c.json({ error: rangeErr }, 400)
  // 役割名の変更で当たる単価ルールが変わるときは、書き込む前に確かめる（#144）
  const rename = await planRoleRename(db, u.company_id, slot, b); if (rename.confirm) return c.json(rename.confirm, 409)

  // ---- 役割の確認（ここでは書き込まない） ----
  const existing = (await db.prepare('SELECT * FROM shift_slot_roles WHERE slot_id = ?').bind(slot.slot_id).all()).results as any[]
  const existingById = new Map(existing.map(r => [Number(r.slot_role_id), r]))
  const roleStmts: D1PreparedStatement[] = []
  const shrunk = new Map<number, { role_name: string; headcount: number }>() // 必要人数を減らした役割（#456 の残り）
  if (Array.isArray(b.roles)) {
    const items = b.roles as any[]
    const deleteIds = new Set<number>()
    let added = 0
    for (const r of items) {
      const id = Number(r.slot_role_id) || 0
      if (id && !existingById.has(id)) continue // 他の枠の役割は扱わない
      if (r._delete) { if (id) deleteIds.add(id); continue }
      if (!normalizeRoles([r])) return c.json({ error: '役割と必要人数を入力してください' }, 400)
      if (!id) added++
    }
    if (existing.length - deleteIds.size + added < 1) return c.json({ error: '役割を1つ以上残してください（枠をなくすときは枠の削除を使ってください）' }, 400)
    if (deleteIds.size) {
      const used = (await db.prepare(`SELECT slot_role_id, COUNT(*) AS n FROM shifts WHERE slot_role_id IN ${JSON_IN} AND status != 'absent' GROUP BY slot_role_id`)
        .bind(bindJsonArray(deleteIds)).all()).results as any[]
      const u0 = used.find(x => Number(x.n) > 0)
      if (u0) return c.json({ error: `役割「${existingById.get(Number(u0.slot_role_id))?.role_name || ''}」には割り当て済みのスタッフがいるため削除できません` }, 409)
    }
    for (const [i, r] of items.entries()) {
      const id = Number(r.slot_role_id) || 0
      if (id && !existingById.has(id)) continue
      if (id && deleteIds.has(id)) { roleStmts.push(db.prepare('DELETE FROM shift_slot_roles WHERE slot_role_id = ? AND slot_id = ?').bind(id, slot.slot_id)); continue }
      if (r._delete) continue
      const n = normalizeRoles([r])![0]
      if (id) {
        if (n.headcount < Number(existingById.get(id).headcount)) shrunk.set(id, { role_name: n.role_name, headcount: n.headcount })
        roleStmts.push(db.prepare(`UPDATE shift_slot_roles SET role_name = ?, headcount = ?, bill_unit_type = ?, bill_rate = ?, pay_unit_type = ?, pay_rate = ?, sort_order = ? WHERE slot_role_id = ? AND slot_id = ?`)
          .bind(n.role_name, n.headcount, n.bill_unit_type, n.bill_rate, n.pay_unit_type, n.pay_rate, i, id, slot.slot_id))
        // 確定済みのシフトの役割名は変えない（確定後に明細・CSV の役割名が変わらないように）
        if (n.role_name !== existingById.get(id).role_name)
          roleStmts.push(db.prepare("UPDATE shifts SET role = ? WHERE slot_role_id = ? AND company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed'").bind(n.role_name, id, u.company_id))
        // 名前を変えた役割は、単価ルールの照合に使う名前を記録する（#144）
        if (rename.map.has(id)) roleStmts.push(db.prepare('UPDATE shift_slot_roles SET rate_role_name = ? WHERE slot_role_id = ? AND slot_id = ?').bind(rename.map.get(id) ?? null, id, slot.slot_id))
      } else {
        roleStmts.push(db.prepare(`INSERT INTO shift_slot_roles (slot_id, role_name, headcount, bill_unit_type, bill_rate, pay_unit_type, pay_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(slot.slot_id, n.role_name, n.headcount, n.bill_unit_type, n.bill_rate, n.pay_unit_type, n.pay_rate, i))
      }
    }
  }

  // ---- 割り当て済みシフトの確認 ----
  const dateTimeChanged = next.work_date !== slot.work_date || next.start_time !== slot.start_time || next.end_time !== slot.end_time
  const breakChanged = !sameVal(next.break_minutes, slot.break_minutes)
  const locationChanged = !sameVal(next.location, slot.location)
  const shifts = (await db.prepare(`SELECT s.*, us.name AS staff_name,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) + (SELECT COUNT(*) FROM daily_reports d WHERE d.shift_id = s.shift_id) AS report_count
    FROM shifts s LEFT JOIN staff_profiles sp ON sp.staff_id = s.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE s.slot_id = ? AND s.company_id = ? ORDER BY s.shift_id`).bind(slot.slot_id, u.company_id).all()).results as any[]
  // 日付・時刻を変えるときに動かさないシフト（報告あり・確定済み）。元の日時のまま枠から外す
  const detach = dateTimeChanged ? shifts.filter(s => isSettled(s) || Number(s.report_count) > 0) : []
  const follow = shifts.filter(s => !isSettled(s) && !detach.includes(s))
  // 割り当て済みのシフトを、精算を締めた期間から・期間へ動かさない（#170）
  if (dateTimeChanged && follow.length) {
    const closedSlot = await closedOn(db, u.company_id, slot.work_date) || await closedOn(db, u.company_id, next.work_date)
    if (closedSlot) return c.json({ error: closedSlot }, 409)
  }
  const warnings: string[] = []
  if (dateTimeChanged) {
    for (const s of follow) {
      if (!ACTIVE_STATUSES.includes(s.status)) continue
      const chk = await assertAssignable(db, { companyId: u.company_id, project: slot.project_id, slot: null, staffId: s.staff_id,
        workDate: next.work_date, start: next.start_time, end: next.end_time, excludeShiftId: s.shift_id })
      if (chk.error) return c.json({ error: chk.error + '\n（このスタッフを枠から外してから、日付・時間を変えてください）' }, chk.status)
      warnings.push(...chk.warnings)
    }
  }
  // 消す役割に未対応の応募があれば確かめる（削除すると「枠の削除」として処理済みになる。#65 の残り）
  const deletedRoleIds = Array.isArray(b.roles) ? (b.roles as any[]).filter(r => r._delete && existingById.has(Number(r.slot_role_id))).map(r => Number(r.slot_role_id)) : []
  if (deletedRoleIds.length) {
    const pend = (await db.prepare(`SELECT i.slot_role_id, COUNT(*) AS n FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
      WHERE i.slot_role_id IN ${JSON_IN} AND i.status = 'pending' AND a.status = 'pending' GROUP BY i.slot_role_id`).bind(bindJsonArray(deletedRoleIds)).all()).results as any[]
    for (const p of pend) warnings.push(`役割「${existingById.get(Number(p.slot_role_id))?.role_name || ''}」には未対応の応募が${Number(p.n)}件あります。削除すると、これらの応募は「枠の削除」として処理済みになります`)
  }
  // 必要人数を、割り当て済みの確定・代打の人数より少なくするときは確かめる（人を外し忘れて超過のまま残らないように）
  if (shrunk.size) {
    const filled = (await db.prepare(`SELECT slot_role_id, COUNT(*) AS n FROM shifts WHERE slot_role_id IN ${JSON_IN} AND status IN ('confirmed','substitute') GROUP BY slot_role_id`)
      .bind(bindJsonArray(shrunk.keys())).all()).results as any[]
    for (const f of filled) {
      const r = shrunk.get(Number(f.slot_role_id))
      if (r && Number(f.n) > r.headcount) warnings.push(`役割「${r.role_name}」: 必要人数（${r.headcount}名）が、割り当て済みの確定・代打（${Number(f.n)}名）より少なくなります`)
    }
  }
  if ((detach.length || warnings.length) && !b.force) {
    return c.json({
      need_force: true, warnings,
      detach: detach.map(s => ({ shift_id: s.shift_id, staff_name: s.staff_name, reason: isSettled(s) ? '確定済み' : '報告あり' })),
    }, 409)
  }

  // ---- 書き込み（枠・役割・シフトをまとめて） ----
  const op = opLog(db, u, 'slot_update') // 操作履歴（#159）。枠と割り当て済みシフトの変更の前の値を残す
  const stmts: D1PreparedStatement[] = [
    logSlot(op, slot.slot_id), logShiftsOfSlot(op, slot.slot_id),
    db.prepare(`UPDATE shift_slots SET site_id = ?, location = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, memo = ?, status = ? WHERE slot_id = ? AND company_id = ?`)
      .bind(next.site_id, next.location, next.work_date, next.start_time, next.end_time, next.break_minutes, next.memo, next.status, slot.slot_id, u.company_id),
    ...roleStmts,
  ]
  for (const s of detach)
    stmts.push(db.prepare('UPDATE shifts SET slot_id = NULL, slot_role_id = NULL WHERE shift_id = ? AND company_id = ?').bind(s.shift_id, u.company_id))
  const pdata = await loadPricingData(db, u.company_id, [slot.project_id])
  const proj = pdata.projects.get(Number(slot.project_id)) || {}
  let lockedKept = 0
  for (const s of follow) {
    const set: Record<string, any> = {}
    if (dateTimeChanged) {
      Object.assign(set, { work_date: next.work_date, start_time: next.start_time, end_time: next.end_time })
      // 本人の「入れます／入れません」の返事は前の日時に対するものなので消す（#411）
      Object.assign(set, { staff_reply: null, staff_reply_note: null, staff_reply_at: null })
    }
    if (breakChanged && sameVal(s.break_minutes, slot.break_minutes)) set.break_minutes = next.break_minutes
    if (siteChanged) set.site_id = next.site_id
    if (locationChanged && next.location && (s.location || '') === (slot.location || '')) set.location = next.location
    // 手動で金額を変えたシフト（price_locked）は単価の再計算から外れるため、時間・休憩が変わったら、単価はそのままで時給の数量と金額を計算し直す。
    // 数量を手で直していた（計算どおりでない）ときは変えない
    if (s.price_locked && ('start_time' in set || 'break_minutes' in set)) {
      const amtOf = (x: any) => {
        const brk = x.break_minutes ?? proj.default_break_minutes ?? 0
        return calcAmounts({ bill_unit_type: x.bill_unit_type || 'daily', bill_rate: x.bill_rate, pay_unit_type: x.pay_unit_type || 'daily', pay_rate: x.pay_rate },
          x.start_time, x.end_time, brk, workHours({ ...x, break_minutes: brk }, proj).hours)
      }
      const before = amtOf(s), after = amtOf({ ...s, ...set })
      const near = (a: any, z: any) => a != null && z != null && Math.abs(Number(a) - Number(z)) < 0.005
      let kept = false
      if (s.bill_unit_type === 'hourly') {
        if (near(s.bill_qty, before.bill_qty) && near(s.unit_price, before.unit_price)) Object.assign(set, { bill_qty: after.bill_qty, unit_price: after.unit_price })
        else kept = true
      }
      if (s.pay_unit_type === 'hourly' && s.pay_rate != null) {
        if (near(s.pay_qty, before.pay_qty) && near(s.pay_amount, before.pay_amount)) Object.assign(set, { pay_qty: after.pay_qty, pay_amount: after.pay_amount })
        else kept = true
      }
      if (kept) lockedKept++
    }
    const cols = Object.keys(set)
    if (!cols.length) continue
    stmts.push(db.prepare(`UPDATE shifts SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE shift_id = ? AND company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed'`)
      .bind(...cols.map(k => set[k]), s.shift_id, u.company_id))
  }
  // 日時・場所を変えるときは、枠に付いて動くシフトの変更の前の内容を取っておき、保存の後に本人に知らせる（#155）
  const notifyIds = dateTimeChanged || siteChanged || locationChanged ? follow.map(s => s.shift_id) : []
  const notifyBefore = await loadShiftSnaps(db, u.company_id, notifyIds)
  try {
    await db.batch(stmts)
  } catch (e) {
    // コピーで作った枠・シフトは、同じコピー元から同じ日付に2つ作れない（idx_shift_slots_source / idx_shifts_source）
    if (isUniqueViolation(e)) return c.json({ error: '同じコピー元の枠（またはシフト）が、変更先の日付にすでにあります' }, 409)
    throw e
  }
  // 単価の再計算（手動変更・確定済みは対象外。役割の単価・開催場所・時間の変更を反映する）
  const rows = (await db.prepare(`SELECT * FROM shifts WHERE slot_id = ? AND company_id = ? AND COALESCE(price_locked,0) = 0 AND COALESCE(settle_status,'planned') != 'confirmed'`)
    .bind(slot.slot_id, u.company_id).all()).results as any[]
  await repriceRows(db, u.company_id, rows)
  await finishLog(op)
  if (notifyIds.length) await notifyShiftChanges(c, u.company_id, notifyBefore, await loadShiftSnaps(db, u.company_id, notifyIds))
  return c.json({ ok: true, detached: detach.length, locked_kept: lockedKept, warnings })
})

app.delete('/shift-slots/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const slot = await ownSlot(db, u.company_id, c.req.param('id'))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const used = await db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE slot_id = ?').bind(slot.slot_id).first() as any
  if (used.n > 0 && c.req.query('force') !== '1') return c.json({ error: `この枠には ${used.n} 件のシフトがあります`, assigned: used.n, need_force: true }, 409)
  // force: 割り当て済みシフトは削除せず「枠なし」に戻す（勤怠・日報が紐づいている可能性があるため）
  const op = opLog(db, u, 'slot_delete') // 操作履歴（#159）
  await db.batch([
    logSlot(op, slot.slot_id), logShiftsOfSlot(op, slot.slot_id),
    db.prepare('UPDATE shifts SET slot_id = NULL, slot_role_id = NULL WHERE slot_id = ? AND company_id = ?').bind(slot.slot_id, u.company_id),
    db.prepare('DELETE FROM shift_slot_roles WHERE slot_id = ?').bind(slot.slot_id),
    db.prepare('DELETE FROM shift_slots WHERE slot_id = ?').bind(slot.slot_id),
  ])
  await finishLog(op)
  await settleRemovedSlotItems(db, u.company_id) // 未対応の応募を「枠の削除」で処理済みにする（#65）
  return c.json({ ok: true })
})

// 役割への割り当て（複数可）
app.post('/shift-slots/roles/:id/assign', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const role = await ownSlotRole(db, u.company_id, c.req.param('id'))
  if (!role) return c.json({ error: '枠が見つかりません' }, 404)
  const staffIds: number[] = [...new Set(((Array.isArray(b.staff_ids) ? b.staff_ids : [b.staff_id]) as any[]).map(Number).filter(Boolean))]
  if (!staffIds.length) return c.json({ error: 'スタッフを選択してください' }, 400)
  // substitute: ダッシュボードで欠勤にしたシフトの代わりを割り当てるとき（#216）
  const status = ['confirmed', 'requested', 'substitute'].includes(b.status) ? b.status : 'confirmed'
  // 退職・統合・取引終了などは割り当てない。重複・NG・休職中・割当済みは確認のうえ force で続ける（#119 #354）
  // 精算を締めた期間にはシフトを足さない（#170）
  const closedAssign = await closedOn(db, u.company_id, role.work_date)
  if (closedAssign) return c.json({ error: closedAssign }, 409)
  const chk = await assertAssignable(db, { companyId: u.company_id, project: role.project_id, slot: role, staffIds, workDate: role.work_date, start: role.start_time, end: role.end_time })
  if (chk.error) return c.json({ error: chk.error }, chk.status)
  const warnings = chk.warnings
  // 確定・代打で入れるときは、必要人数を超えないかも確かめる（希望（仮）は充足に数えないので確かめない。#407）
  if (status !== 'requested') {
    const adding = chk.staff.filter(s => !chk.already.has(s.staff_id)).length
    warnings.push(...await capacityWarnings(db, u.company_id, new Map([[Number(role.slot_role_id), adding]])))
  }
  if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)

  const data = await loadPricingData(db, u.company_id, [role.project_id])
  // 交通費の入力がなければ、スタッフの標準（開催場所 → スタッフ）を入れる（#564）
  const fee = feeInput(b.transportation_fee)
  const tdefs = fee == null ? await loadTransportDefaults(db, u.company_id, chk.staff.map((s: any) => s.staff_id)) : null
  const created: number[] = []
  for (const s of chk.staff) {
    if (chk.already.has(s.staff_id)) continue
    let res: D1Result
    try {
      res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo, slot_id, slot_role_id, site_id, break_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, s.staff_id, role.project_id, role.work_date, role.start_time, role.end_time, role.location || '', role.role_name,
          fee ?? transportDefaultFor(tdefs, s.staff_id, role.site_id) ?? 0, status, u.user_id, b.memo ?? null, role.slot_id, role.slot_role_id, role.site_id ?? null, role.break_minutes ?? null).run()
    } catch (e) {
      // 同時に届いた別のリクエストが先に割り当てた（一意インデックス）。二重には作らない（#530）
      if (isUniqueViolation(e)) { warnings.push(`${s.name}: すでにこの枠に割り当て済みです`); continue }
      throw e
    }
    await applyPricingToShift(db, u.company_id, res.meta.last_row_id as number, { data })
    created.push(res.meta.last_row_id as number)
  }
  if (created.length) { // 操作履歴（#159）
    const op = opLog(db, u, 'assign')
    await db.batch(logShifts(op, created, { created: true }))
    await finishLog(op)
  }
  await notifyShiftChanges(c, u.company_id, [], await loadShiftSnaps(db, u.company_id, created)) // 本人に知らせる（#155）
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
  // 移動元・移動先のどちらかが精算を締めた期間なら移動しない（#170）
  const closedMove = await closedOn(db, u.company_id, s.work_date) || await closedOn(db, u.company_id, role.work_date)
  if (closedMove) return c.json({ error: closedMove }, 409)
  const hasReports = await db.prepare('SELECT (SELECT COUNT(*) FROM attendance_reports WHERE shift_id = ?) + (SELECT COUNT(*) FROM daily_reports WHERE shift_id = ?) AS n').bind(s.shift_id, s.shift_id).first().catch(() => ({ n: 0 })) as any
  if (hasReports?.n > 0 && (role.work_date !== s.work_date || role.project_id !== s.project_id)) return c.json({ error: '勤怠・日報の報告があるシフトは、別の日付・案件へ移動できません' }, 409)
  const chk = await assertAssignable(db, { companyId: u.company_id, project: role.project_id, slot: role, staffId: s.staff_id, workDate: role.work_date, start: role.start_time, end: role.end_time, excludeShiftId: s.shift_id })
  if (chk.error) return c.json({ error: chk.error }, chk.status)
  const warnings = chk.warnings
  // 確定・代打のシフトを別の役割へ移すときは、移動先の必要人数を超えないかを確かめる（#407）
  if (['confirmed', 'substitute'].includes(s.status) && Number(role.slot_role_id) !== Number(s.slot_role_id))
    warnings.push(...await capacityWarnings(db, u.company_id, new Map([[Number(role.slot_role_id), 1]]), [s.shift_id]))
  if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  const projectChanged = role.project_id !== s.project_id
  // 日時が変わるときは、本人の「入れます／入れません」の返事（前の日時に対するもの）を消す（#411）
  const replyReset = role.work_date !== s.work_date || role.start_time !== s.start_time || role.end_time !== s.end_time
    ? ', staff_reply = NULL, staff_reply_note = NULL, staff_reply_at = NULL' : ''
  const notifyBefore = await loadShiftSnaps(db, u.company_id, [s.shift_id]) // 移動の前の内容（本人への通知に使う。#155）
  // 移動したシフトは、移行時の重複の印（legacy_duplicate）を外して一意インデックスの対象に戻す
  const op = opLog(db, u, 'move') // 操作履歴（#159）
  try {
    await db.batch([...logShifts(op, [s.shift_id]), db.prepare(`UPDATE shifts SET project_id = ?, slot_id = ?, slot_role_id = ?, site_id = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, role = ?, location = ?, legacy_duplicate = NULL${replyReset} WHERE shift_id = ?`)
      .bind(role.project_id, role.slot_id, role.slot_role_id, role.site_id ?? null, role.work_date, role.start_time, role.end_time, role.break_minutes ?? null, role.role_name, role.location || s.location || '', s.shift_id)])
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'このスタッフはすでに移動先の枠に割り当て済みです' }, 409)
    throw e
  }
  // 手動変更した金額でも、案件が変わった場合は移動先の単価に置き換える
  await applyPricingToShift(db, u.company_id, s.shift_id, { force: projectChanged })
  await finishLog(op)
  await notifyShiftChanges(c, u.company_id, notifyBefore, await loadShiftSnaps(db, u.company_id, [s.shift_id])) // 本人に知らせる（#155）
  return c.json({ ok: true, warnings })
})

// 希望（仮）のシフトをまとめて確定にする（#390）。shift_ids: 確定にするシフト（1回に500件まで）
// 希望（仮）でないもの・実績が確定済みのもの・退職などで稼働できない人のものは skipped に理由を付けて返し、確定にしない。
// 重複・NG・休職中・本人の『入れません』・必要人数の超過は警告として返し、確認のうえ force で続ける
const CONFIRM_REQUESTED_MAX = 500
app.post('/shifts/confirm-requested', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const ids = [...new Set((Array.isArray(b.shift_ids) ? b.shift_ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
  if (!ids.length) return c.json({ error: '確定にするシフトを選んでください' }, 400)
  if (ids.length > CONFIRM_REQUESTED_MAX) return c.json({ error: `一度に確定にできるのは${CONFIRM_REQUESTED_MAX}件までです` }, 400)
  const rows = (await db.prepare(`SELECT s.shift_id, s.staff_id, s.project_id, s.slot_role_id, s.work_date, s.start_time, s.end_time, s.status, s.settle_status, s.staff_reply, s.staff_reply_note,
      p.project_name FROM shifts s LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE s.company_id = ? AND s.shift_id IN ${JSON_IN} ORDER BY s.work_date, s.start_time, s.shift_id`).bind(u.company_id, bindJsonArray(ids)).all()).results as any[]
  const staff = await loadStaffForAssign(db, u.company_id, rows.map(r => r.staff_id))
  const skipped: { shift_id: number; staff_name: string; work_date: string; reason: string }[] = []
  const targets: any[] = []
  // 精算を締めた期間のシフトは確定にしない（#170）
  const rowDates = rows.map(r => String(r.work_date)).sort()
  const closedAt = await closedChecker(db, u.company_id, rowDates[0], rowDates[rowDates.length - 1])
  for (const r of rows) {
    const st = staff.get(r.staff_id)
    const name = st?.name || ''
    const reason = r.status !== 'requested' ? '希望（仮）ではありません' : isSettled(r) ? '実績が確定済みです' : closedAt(r.work_date) ? '精算を締めた期間です' : ineligibleReason(st, r.work_date)
    if (reason) skipped.push({ shift_id: r.shift_id, staff_name: name, work_date: r.work_date, reason })
    else targets.push({ ...r, staff_name: name, employment_status: st?.employment_status })
  }
  if (!targets.length) return c.json({ ok: true, confirmed: 0, skipped })

  const warnings: string[] = []
  if (!b.force) {
    const label = (r: any) => `${String(r.work_date).slice(5).replace('-', '/')} ${r.start_time}〜${r.end_time} ${r.staff_name}`
    const dates = targets.map(r => r.work_date).sort()
    const conflicts = await findConflicts(db, u.company_id, targets.map(r => r.staff_id), dates[0], dates[dates.length - 1])
    const ng = await ngByProjects(db, u.company_id, targets.map(r => r.project_id))
    for (const r of targets) {
      const cf = conflictFor(conflicts.get(r.staff_id), r.work_date, r.start_time, r.end_time, r.shift_id)
      if (cf.length) warnings.push(`${label(r)}: 同じ時間帯に別のシフトがあります（${cf.map(x => conflictLabel(x, u.company_id)).join('、')}）`)
      if ((ng.get(r.project_id) || []).includes(r.staff_id)) warnings.push(`${label(r)}: クライアントのNGスタッフに指定されています`)
      if (r.employment_status === 'leave') warnings.push(`${label(r)}: 休職中です`)
      if (r.staff_reply === 'ng') warnings.push(`${label(r)}: 本人が「入れません」と返事しています${r.staff_reply_note ? `（${r.staff_reply_note}）` : ''}`)
    }
    const adds = new Map<number, number>()
    for (const r of targets) if (r.slot_role_id) adds.set(Number(r.slot_role_id), (adds.get(Number(r.slot_role_id)) || 0) + 1)
    warnings.push(...await capacityWarnings(db, u.company_id, adds))
    if (warnings.length) return c.json({ need_force: true, warnings, skipped, count: targets.length }, 409)
  }
  // 確認の後に状態が変わったもの（別の画面で確定・削除した等）は変えない
  const targetIds = targets.map(r => r.shift_id)
  const notifyBefore = await loadShiftSnaps(db, u.company_id, targetIds)
  const op = opLog(db, u, 'confirm_requested') // 操作履歴（#159）
  const res = (await db.batch([...logShifts(op, targetIds), db.prepare(`UPDATE shifts SET status = 'confirmed' WHERE company_id = ? AND status = 'requested' AND COALESCE(settle_status,'planned') != 'confirmed'
    AND shift_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(targetIds))])).at(-1)!
  await finishLog(op)
  // 確定にしたことを本人に知らせる（スタッフごとにまとめる。#155）
  await notifyShiftChanges(c, u.company_id, notifyBefore, await loadShiftSnaps(db, u.company_id, targetIds))
  return c.json({ ok: true, confirmed: res.meta.changes || 0, skipped })
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
  // 精算を締めた期間のシフトは外さない（#170。外さなかった件数を closed で返す）
  const sDates = shifts.map(s => String(s.work_date)).sort()
  const closedAt = await closedChecker(db, u.company_id, sDates[0], sDates[sDates.length - 1])
  const closed = shifts.filter(s => closedAt(s.work_date)).length
  shifts = shifts.filter(s => !closedAt(s.work_date))
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
  const op = opLog(db, u, 'release') // 操作履歴（#159）。外す前の値を先に残す
  const before = await loadShiftSnaps(db, u.company_id, shifts.map(s => s.shift_id))
  try { await batchInChunks(db, [...logShifts(op, shifts.map(s => s.shift_id)), ...stmts]) } finally { await finishLog(op) }
  // 外したシフトを本人に知らせる（#155。削除は取消、欠勤にした分は状態の変更として、本人ごとに1件にまとめる。ログインが止まっている人には届かない）
  await notifyShiftChanges(c, u.company_id, before, await loadShiftSnaps(db, u.company_id, shifts.filter(s => s.records > 0).map(s => s.shift_id)))
  return c.json({ ok: true, removed, absent, closed })
})

// 金額の手動変更 / ルールに戻す
app.put('/shifts/:id/price', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (isSettled(s)) return c.json({ error: '確定済みのシフトの金額は変更できません。精算画面で確定を取り消してください' }, 409)
  // 精算を締めた期間のシフトの金額は変えない（#170）
  const closedPrice = await closedOn(db, u.company_id, s.work_date)
  if (closedPrice) return c.json({ error: closedPrice }, 409)
  if (b.reset) {
    const op = opLog(db, u, 'price_reset') // 操作履歴（#159）
    await db.batch(logShifts(op, [s.shift_id]))
    try { await applyPricingToShift(db, u.company_id, s.shift_id, { force: true }) } finally { await finishLog(op) }
    return c.json({ ok: true })
  }
  // 負の単価・休憩、範囲外の数量は受け付けない（#218）。調整額は控除に使うため負の値も認める
  const err = rangeError([['請求単価', b.bill_rate, 0, MONEY_MAX], ['支払単価', b.pay_rate, 0, MONEY_MAX], ['請求の数量', b.bill_qty, 0, QTY_MAX], ['支払の数量', b.pay_qty, 0, QTY_MAX],
    ['休憩', b.break_minutes, 0, BREAK_MAX], ['交通費の実費', b.transportation_fee, 0, MONEY_MAX], ['交通費の請求額', b.bill_transport_amount, 0, MONEY_MAX], ['交通費の支払額', b.pay_transport_amount, 0, MONEY_MAX],
    ['請求の調整', b.bill_adjust, -MONEY_MAX, MONEY_MAX], ['支払の調整', b.pay_adjust, -MONEY_MAX, MONEY_MAX]])
  if (err) return c.json({ error: err }, 400)
  const unit = (v: any, d: string) => (v === 'hourly' ? 'hourly' : v === 'daily' ? 'daily' : d)
  const billUnit = unit(b.bill_unit_type, s.bill_unit_type || 'daily'), payUnit = unit(b.pay_unit_type, s.pay_unit_type || 'daily')
  const billRate = b.bill_rate !== undefined ? intOrNull(b.bill_rate) : s.bill_rate
  const payRate = b.pay_rate !== undefined ? intOrNull(b.pay_rate) : s.pay_rate
  const brk = b.break_minutes !== undefined ? intOrNull(b.break_minutes) : s.break_minutes
  const pdata = await loadPricingData(db, u.company_id, [s.project_id])
  const amt = calcAmounts({ bill_unit_type: billUnit, bill_rate: billRate, pay_unit_type: payUnit, pay_rate: payRate }, s.start_time, s.end_time, brk || 0,
    hoursForAmounts(workHours({ ...s, break_minutes: brk }, pdata.projects.get(Number(s.project_id)) || {})))
  // 数量を直接指定した場合（実働時間など）はそちらを優先
  // 数量を指定しないとき、または計算どおりの数量のときは、calcAmounts の金額（分単位で計算）を使う
  const billQtyIn = b.bill_qty != null && b.bill_qty !== '', payQtyIn = b.pay_qty != null && b.pay_qty !== ''
  const billQty = billQtyIn ? Number(b.bill_qty) : amt.bill_qty
  const payQty = payQtyIn ? Number(b.pay_qty) : amt.pay_qty
  const sameQty = (q: number, calc: number) => Math.abs(q - calc) < 0.005
  const billAmount = billQtyIn && !sameQty(billQty, amt.bill_qty) ? Math.round((billRate || 0) * billQty) : amt.unit_price
  const payAmount = payRate == null ? null : payQtyIn && !sameQty(payQty, amt.pay_qty) ? Math.round(payRate * payQty) : amt.pay_amount
  const bt = BILL_TRANSPORT_TYPES.includes(b.bill_transport_type) ? b.bill_transport_type : s.bill_transport_type
  const pt = PAY_TRANSPORT_TYPES.includes(b.pay_transport_type) ? b.pay_transport_type : s.pay_transport_type
  const btAmt = b.bill_transport_amount !== undefined ? (intOrNull(b.bill_transport_amount) ?? 0) : s.bill_transport_amount
  const ptAmt = b.pay_transport_amount !== undefined ? (intOrNull(b.pay_transport_amount) ?? 0) : s.pay_transport_amount
  // 数量は、計算と違う値を入れたときだけ固定する（qty_locked）。空欄なら計算時間に合わせ、実績が入れば実働に合わせる（#196）
  const qtyLocked = (billQtyIn && !sameQty(billQty, amt.bill_qty)) || (payQtyIn && !sameQty(payQty, amt.pay_qty))
  // 単価・単位・数量・交通費のルールを変えたときだけ手動変更（price_locked）にする。交通費の実費・調整・休憩だけを直したときは、単価ルールの対象のまま
  const same = (a: any, x: any) => (a ?? null) === (x ?? null)
  const priceChanged = qtyLocked || billUnit !== (s.bill_unit_type || 'daily') || payUnit !== (s.pay_unit_type || 'daily') || !same(billRate, s.bill_rate) || !same(payRate, s.pay_rate)
    || (bt || 'actual') !== (s.bill_transport_type || 'actual') || (pt || 'actual') !== (s.pay_transport_type || 'actual')
    || Number(btAmt || 0) !== Number(s.bill_transport_amount || 0) || Number(ptAmt || 0) !== Number(s.pay_transport_amount || 0)
  const locked = s.price_locked || priceChanged ? 1 : 0
  // 調整額・調整の内容は、送られてきたときだけ変える。空欄で保存したら消す（NULL = 調整なし。#137）
  const adj = buildUpdate({
    bill_adjust: b.bill_adjust === undefined ? undefined : (intOrNull(b.bill_adjust) ?? ''),
    pay_adjust: b.pay_adjust === undefined ? undefined : (intOrNull(b.pay_adjust) ?? ''),
    adjust_note: b.adjust_note,
  }, ['bill_adjust', 'pay_adjust', 'adjust_note'])
  const op = opLog(db, u, 'price') // 操作履歴（#159）
  await db.batch([...logShifts(op, [s.shift_id]), db.prepare(`UPDATE shifts SET bill_unit_type = ?, bill_rate = ?, bill_qty = ?, unit_price = ?, pay_unit_type = ?, pay_rate = ?, pay_qty = ?, pay_amount = ?,
      break_minutes = ?, transportation_fee = ?, bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?,
      ${adj.clause ? adj.clause + ', ' : ''}price_locked = ?, qty_locked = ?, price_source = ? WHERE shift_id = ?`)
    .bind(billUnit, billRate, billQty, billAmount, payUnit, payRate, payQty, payAmount,
      brk, b.transportation_fee !== undefined ? (intOrNull(b.transportation_fee) ?? 0) : s.transportation_fee,
      bt, btAmt, pt, ptAmt,
      ...adj.values, locked, qtyLocked ? 1 : 0, locked ? JSON.stringify({ manual: '手動変更' }) : s.price_source, s.shift_id)])
  await finishLog(op)
  return c.json({ ok: true, price_locked: !!locked, qty_locked: qtyLocked })
})

// 単価ルールの再適用（手動変更・確定済みのシフトは対象外）。
// 必要な行をまとめて読み、メモリ上で計算して、まとめて書き込む。1回に BULK_LIMIT 件まで処理し、残りがあれば next_cursor（最後に処理した shift_id）を返す
// 再適用した後の単価・金額・支払先を計算する（書き込みはしない）。staff はスタッフ名の表示にも使う
async function planReprice(db: D1Database, companyId: number, rows: any[]) {
  const data = await loadPricingData(db, companyId, rows.map(r => r.project_id))
  const staff = await loadStaffForAssign(db, companyId, rows.map(r => r.staff_id))
  const hist = await loadPayeeHistory(db, companyId, rows.map(r => r.staff_id))
  const roleIds = bindJsonArray(rows.map(r => r.slot_role_id))
  const roles = roleIds === '[]' ? [] : (await db.prepare(`SELECT r.* FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE sl.company_id = ? AND r.slot_role_id IN ${JSON_IN}`).bind(companyId, roleIds).all()).results as any[]
  const roleMap = new Map(roles.map(r => [r.slot_role_id, r]))
  const upd = rows.map(s => ({ shift_id: s.shift_id, ...computeShiftPricing(companyId, s, s.slot_role_id ? roleMap.get(s.slot_role_id) || null : null, payeeOn(staff.get(s.staff_id), hist.get(s.staff_id), s.work_date), data) }))
  return { upd, staff }
}
async function repriceRows(db: D1Database, companyId: number, rows: any[]): Promise<number> {
  if (!rows.length) return 0
  const { upd } = await planReprice(db, companyId, rows)
  // 読み込みの後に確定・手動変更されたシフトは書き換えない
  const res = await batchInChunks(db, updateRowsStmts(db, 'shifts', 'shift_id', PRICE_COLUMNS, upd,
    "shifts.company_id = ? AND COALESCE(shifts.price_locked,0) = 0 AND COALESCE(shifts.settle_status,'planned') != 'confirmed'", [companyId]))
  return changesOf(res)
}
// 再適用の前の確認（#469）: 金額・支払先が変わるシフトの一覧（日付・スタッフ・請求と支払の前後・支払先の前後）と、請求・支払の増減の合計。
// 計算するのは日付順に PREVIEW_MAX 件まで（超えたら truncated）。一覧は PREVIEW_LIST 件まで返す
const PREVIEW_MAX = 3000, PREVIEW_LIST = 200
const sameValue = (a: any, b: any) => (a == null || b == null) ? (a == null) === (b == null) : (typeof a === 'number' || typeof b === 'number') ? Math.abs(Number(a) - Number(b)) < 0.005 : String(a) === String(b)
async function repricePreview(db: D1Database, companyId: number, where: string[], binds: any[]) {
  const rows = (await db.prepare(`SELECT * FROM shifts WHERE ${where.join(' AND ')} ORDER BY work_date, shift_id LIMIT ?`).bind(...binds, PREVIEW_MAX + 1).all()).results as any[]
  const part = rows.slice(0, PREVIEW_MAX)
  const out = { checked: part.length, truncated: rows.length > PREVIEW_MAX, changed: 0, bill_diff: 0, pay_diff: 0, payee_changed: 0, pay_set_changed: 0, changes: [] as any[] }
  if (!part.length) return out
  const { upd, staff } = await planReprice(db, companyId, part)
  const names = new Map(((await db.prepare(`SELECT project_id, project_name FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`)
    .bind(companyId, bindJsonArray(part.map(s => s.project_id))).all()).results as any[]).map(p => [p.project_id, p.project_name]))
  const compared = PRICE_COLUMNS.filter(k => k !== 'price_source' && k !== 'price_locked')
  part.forEach((s, i) => {
    const v = upd[i] as Record<string, any>
    if (compared.every(k => sameValue(s[k], v[k]))) return
    const before = shiftTotals(s), after = shiftTotals({ ...s, ...v })
    const payeeChanged = !sameValue(s.payee_type, v.payee_type) || !sameValue(s.payee_affiliation_id, v.payee_affiliation_id) || !sameValue(s.payee_company_id, v.payee_company_id)
    out.changed++
    out.bill_diff += after.bill_total - before.bill_total
    if (before.pay_total != null && after.pay_total != null) out.pay_diff += after.pay_total - before.pay_total
    else if ((before.pay_total == null) !== (after.pay_total == null)) out.pay_set_changed++
    if (payeeChanged) out.payee_changed++
    if (out.changes.length < PREVIEW_LIST) out.changes.push({
      shift_id: s.shift_id, work_date: s.work_date, start_time: s.start_time, end_time: s.end_time, staff_name: staff.get(s.staff_id)?.name || '', project_name: names.get(s.project_id) || '',
      bill_before: before.bill_total, bill_after: after.bill_total, pay_before: before.pay_total, pay_after: after.pay_total,
      payee_before: s.payee_type || null, payee_after: v.payee_type || null, payee_changed: payeeChanged,
    })
  })
  return out
}
app.post('/shifts/reprice', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json()
  if (!isISODate(b.from) || !isISODate(b.to)) return c.json({ error: '期間を指定してください' }, 400)
  if (b.from > b.to) return c.json({ error: '期間の開始日は終了日以前にしてください' }, 400)
  const f: string[] = ['company_id = ?', 'work_date BETWEEN ? AND ?', 'COALESCE(price_locked,0) = 0', "COALESCE(settle_status,'planned') != 'confirmed'",
    // 精算を締めた期間のシフトは再適用しない（#170）
    'NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL AND shifts.work_date BETWEEN k.period_from AND k.period_to)']
  const bind: any[] = [u.company_id, b.from, b.to]
  if (b.project_id) { f.push('project_id = ?'); bind.push(b.project_id) }
  // クライアント単位の単価ルール（#470）の再適用は、そのクライアントの全案件のシフトが対象
  if (b.client_id) { f.push('project_id IN (SELECT project_id FROM projects WHERE company_id = ? AND client_id = ?)'); bind.push(u.company_id, b.client_id) }
  if (b.staff_id) { f.push('staff_id = ?'); bind.push(b.staff_id) }
  if (b.dry_run) {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE ${f.join(' AND ')}`).bind(...bind).first() as any
    return c.json({ count: Number(r?.n || 0), ...(await repricePreview(db, u.company_id, f, bind)) })
  }
  const limit = bulkLimit(b.limit)
  const after = Math.max(0, Math.floor(Number(b.cursor) || 0))
  const rows = (await db.prepare(`SELECT * FROM shifts WHERE ${f.join(' AND ')} AND shift_id > ? ORDER BY shift_id LIMIT ?`).bind(...bind, after, limit + 1).all()).results as any[]
  const part = rows.slice(0, limit)
  // 操作履歴（#159）。再適用の対象（手動変更・確定済みを除く）の前の値を残し、金額が変わったものだけを残す
  const op = opLog(db, u, 'reprice')
  let updated = 0
  await batchInChunks(db, logShifts(op, part.map(s => s.shift_id), { where: "COALESCE(s.price_locked,0) = 0 AND COALESCE(s.settle_status,'planned') != 'confirmed'" }))
  try { updated = await repriceRows(db, u.company_id, part) } finally { await finishLog(op) }
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
  // 精算を締めた期間の日付には登録しない（#170。理由「締め」でスキップ）
  const closedAt = await closedChecker(db, u.company_id, part[0][0], part[part.length - 1][0])
  const ng = (await ngByProjects(db, u.company_id, [project.project_id])).get(project.project_id) || []
  const data = await loadPricingData(db, u.company_id, [project.project_id])
  // 交通費の入力がなければ、スタッフの標準（開催場所 → スタッフ）を入れる（#564）
  const fee = feeInput(b.transportation_fee)
  const tdefs = fee == null ? await loadTransportDefaults(db, u.company_id, staffIds) : null
  const base = {
    company_id: u.company_id, project_id: project.project_id, start_time: b.start_time, end_time: b.end_time,
    location: b.location || site?.site_name || '', role: String(b.role || '').trim() || '販売スタッフ', transportation_fee: fee ?? 0,
    status: 'confirmed', registered_by: u.user_id, slot_id: null, slot_role_id: null, site_id: site?.site_id ?? null, break_minutes: intOrNull(b.break_minutes), source_shift_id: null,
  }
  const rows: any[] = []; const skipped: Skipped[] = []
  for (const [d, sid] of part) {
    const st = staff.get(sid)
    let reason = ineligibleReason(st, d), detail: string | undefined
    if (!reason && closedAt(d)) { reason = '締め'; detail = closedAt(d)! }
    if (!reason && ng.includes(sid)) reason = 'NG'
    if (!reason) {
      const cf = conflictFor(conflicts.get(sid), d, b.start_time, b.end_time)
      if (cf.length) { reason = '重複'; detail = cf.map(x => conflictLabel(x, u.company_id)).join('、') }
    }
    if (reason) { skipped.push({ date: d, staff_id: sid, staff_name: st?.name || '', reason, detail, project_name: project.project_name, start_time: b.start_time, end_time: b.end_time }); continue }
    const row: any = { ...base, staff_id: sid, work_date: d, transportation_fee: fee ?? transportDefaultFor(tdefs, sid, base.site_id) ?? 0 }
    rows.push({ ...row, ...computeShiftPricing(u.company_id, row, null, payeeOn(st, hist.get(sid), d), data) })
    addPlannedConflict(conflicts, u.company_id, sid, d, b.start_time, b.end_time, project.project_name)
  }
  const res = await batchInChunks(db, insertRowsStmts(db, 'shifts', SHIFT_INSERT_COLUMNS, rows, { returning: 'shift_id' }))
  await logCreatedShifts(db, u, 'bulk_create', returnedIds(res, 'shift_id')) // 操作履歴（#159）
  // 登録したシフトを本人に知らせる（スタッフごとに1件にまとめる。#155）。件数が多く何回かに分けて呼ばれるときは、
  // 最後の回で、この操作で登録したシフト（同じ案件・期間・時刻・登録した人で、2時間以内に作ったもの）をまとめて知らせる（分けた回ごとに届かないように）
  if (next == null) {
    const made = start === 0 ? rows.map((r): ShiftSnap => ({ shift_id: null, staff_id: r.staff_id, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time,
        status: r.status, location: r.location, project_name: project.project_name, site_name: site?.site_name ?? null }))
      : await loadShiftSnaps(db, u.company_id, ((await db.prepare(`SELECT shift_id FROM shifts WHERE company_id = ? AND project_id = ? AND work_date BETWEEN ? AND ?
          AND start_time = ? AND end_time = ? AND registered_by = ? AND slot_id IS NULL AND status = 'confirmed' AND created_at >= datetime('now', '-2 hours')
          AND staff_id IN (SELECT value FROM json_each(?)) LIMIT 5000`).bind(u.company_id, project.project_id, b.date_from, b.date_to, b.start_time, b.end_time, u.user_id,
          JSON.stringify(staffIds)).all()).results as any[]).map(r => r.shift_id))
    await notifyShiftChanges(c, u.company_id, [], made)
  }
  return c.json({ ok: true, created: changesOf(res), skipped, total: items.length, processed: start + part.length, next_cursor: next })
})

// まとめて作ったシフトの操作履歴（#159）。作成の後の値だけを残す。
// シフトはもう登録してあるので、記録に失敗しても本人への知らせと結果の応答は続ける（500 で返すと、画面で登録できなかったと誤解される）
async function logCreatedShifts(db: D1Database, u: any, action: string, ids: number[]) {
  if (!ids.length) return
  try {
    const op = opLog(db, u, action)
    await batchInChunks(db, logShifts(op, ids, { created: true }))
    await finishLog(op)
  } catch (e) { console.error(`${action} operation log failed`, e) }
}

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

  // 精算を締めた期間の日付には割り当てをコピーしない（#170。枠はコピーする）
  const closedAt = await closedChecker(db, cid, b.target_from, targetTo)
  const check = (staffId: number, date: string, projectId: number, start: string, end: string, slotStaff?: Set<number>): { reason: string; detail?: string } | null => {
    const reason = ineligibleReason(staff.get(staffId), date)
    if (reason) return { reason }
    const closedText = closedAt(date)
    if (closedText) return { reason: '締め', detail: closedText }
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
    const res = await batchInChunks(db, insertRowsStmts(db, 'shift_slot_roles', ['slot_id', 'role_name', 'headcount', 'bill_unit_type', 'bill_rate', 'pay_unit_type', 'pay_rate', 'sort_order', 'source_slot_role_id', 'rate_role_name'],
      newRoles.map(p => ({ slot_id: p.slot.target.slot_id, role_name: p.src.role_name, headcount: p.src.headcount, bill_unit_type: p.src.bill_unit_type ?? null, bill_rate: p.src.bill_rate ?? null,
        pay_unit_type: p.src.pay_unit_type ?? null, pay_rate: p.src.pay_rate ?? null, sort_order: p.src.sort_order ?? 0, source_slot_role_id: p.src.slot_role_id, rate_role_name: p.src.rate_role_name ?? null })), { orIgnore: true }))
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
    // コピー元の交通費が 0 のときは、スタッフの標準（開催場所 → スタッフ）を入れる（#564）
    const tdefs = await loadTransportDefaults(db, cid, shiftPlans.filter(p => !Number(p.src.transportation_fee || 0)).map(p => p.src.staff_id))
    const rows = shiftPlans.map(p => {
      const s = p.src, role = p.role?.target || null, slot = p.role?.slot.target || null
      const siteId = slot ? slot.site_id ?? null : s.site_id ?? null
      const row: any = {
        company_id: cid, staff_id: s.staff_id, project_id: slot ? slot.project_id : s.project_id, work_date: p.date, start_time: p.start, end_time: p.end,
        location: (slot ? slot.location : null) || s.location || '', role: role ? role.role_name : (s.role || '販売スタッフ'),
        transportation_fee: Number(s.transportation_fee || 0) || transportDefaultFor(tdefs, s.staff_id, siteId) || 0,
        status: 'confirmed', registered_by: u.user_id, slot_id: slot?.slot_id ?? null, slot_role_id: role?.slot_role_id ?? null,
        site_id: siteId, break_minutes: slot ? slot.break_minutes ?? null : s.break_minutes ?? null, source_shift_id: s.shift_id,
      }
      return { ...row, ...computeShiftPricing(cid, row, role, payeeOn(staff.get(s.staff_id), hist.get(s.staff_id), p.date), pdata) }
    })
    const insRes = await batchInChunks(db, insertRowsStmts(db, 'shifts', SHIFT_INSERT_COLUMNS, rows, { orIgnore: true, returning: 'shift_id' }))
    shiftsCreated = changesOf(insRes)
    await logCreatedShifts(db, u, 'copy_week', returnedIds(insRes, 'shift_id')) // 操作履歴（#159）
    // コピーで登録したシフトを本人に知らせる（スタッフごとに1件にまとめる。#155）。
    // 同時に実行されて一部が作られなかったとき（どの行を作ったか分からない）は、作った側の呼び出しが知らせるので、ここでは送らない
    if (shiftsCreated === rows.length) await notifyShiftChanges(c, cid, [], rows.map((r: any): ShiftSnap => ({ shift_id: null, staff_id: r.staff_id, work_date: r.work_date,
      start_time: r.start_time, end_time: r.end_time, status: r.status, location: r.location, project_name: projectName(r.project_id) })))
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
  if (extendDates.length && projectClosed(await ownProject(db, u.company_id, p.project_id))) return c.json({ error: CLOSED_PROJECT_SLOT_ERROR }, 400)

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
  // 時刻・休憩は変えた項目だけを、繰り返し登録の元の値のままの枠・シフトに反映する。
  // 枠ごと・シフトごとに直した時刻・休憩（元の値と違うもの）は上書きしない
  const sameBreak = (x: any, y: any) => (x ?? null) === (y ?? null)
  const timeSlotIds = new Set(timeChanged ? targets.filter(s => s.start_time === p.start_time && s.end_time === p.end_time).map(s => s.slot_id) : [])
  const breakSlotIds = new Set(breakChanged ? targets.filter(s => sameBreak(s.break_minutes, p.break_minutes)).map(s => s.slot_id) : [])
  const customSlots = targets.filter(s => (timeChanged && !timeSlotIds.has(s.slot_id)) || (breakChanged && !breakSlotIds.has(s.slot_id))).length
  const slotById = new Map(targets.map(s => [s.slot_id, s]))
  const editIds = targets.filter(s => timeSlotIds.has(s.slot_id) || breakSlotIds.has(s.slot_id)).map(s => s.slot_id)
  const assignedRows = editIds.length ? (await db.prepare(`SELECT sh.* FROM shifts sh
    WHERE sh.company_id = ? AND sh.slot_id IN ${JSON_IN} AND COALESCE(sh.settle_status,'planned') != 'confirmed'`).bind(u.company_id, bindJsonArray(editIds)).all()).results as any[] : []
  const moving = assignedRows.map(s => {
    const sl = slotById.get(s.slot_id)
    const moveTime = !!sl && timeSlotIds.has(s.slot_id) && s.start_time === sl.start_time && s.end_time === sl.end_time
    const moveBreak = !!sl && breakSlotIds.has(s.slot_id) && sameBreak(s.break_minutes, sl.break_minutes)
    return { s, moveTime, moveBreak }
  }).filter(x => x.moveTime || x.moveBreak)
  // 時刻を変えると、割り当て済みの人の別のシフトと重なることがある（欠勤は除く）
  const warnings: string[] = []
  const active = moving.filter(x => x.moveTime && x.s.status !== 'absent').map(x => x.s)
  if (active.length) {
    const dates = active.map(s => s.work_date).sort()
    const conflicts = await findConflicts(db, u.company_id, active.map(s => s.staff_id), dates[0], dates[dates.length - 1])
    const names = new Map(((await db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND sp.staff_id IN ${JSON_IN}`)
      .bind(u.company_id, bindJsonArray(active.map(s => s.staff_id))).all()).results as any[]).map(r => [r.staff_id, r.name]))
    const movingIds = new Set(active.map(s => s.shift_id))
    for (const s of active) {
      const cf = conflictFor(conflicts.get(s.staff_id), s.work_date, start, end, s.shift_id).filter(x => !movingIds.has(x.shift_id))
      if (cf.length) warnings.push(`${s.work_date} ${names.get(s.staff_id) || ''}: 同じ時間帯に別のシフトがあります（${cf.map(x => conflictLabel(x, u.company_id)).join('、')}）`)
    }
  }
  const summary = {
    slots: targets.length, skipped_slots: lockedIds.size, custom_slots: customSlots, shifts: moving.length,
    roles_added: addRows.length, roles_removed: removable.length, roles_kept: keptRoles,
    headcount_changed: headcountChanged.length ? targets.length : 0, extend_slots: extendDates.length, date_to: newTo, warnings,
  }
  if (b.dry_run) return c.json({ ok: true, dry_run: true, ...summary })
  if (warnings.length && !b.force) return c.json({ error: '割り当て済みのスタッフの時間が、別のシフトと重なります', need_force: true, ...summary }, 409)

  // ---- 書き込み ----
  const stmts: D1PreparedStatement[] = []
  if (timeSlotIds.size) stmts.push(db.prepare(`UPDATE shift_slots SET start_time = ?, end_time = ? WHERE company_id = ? AND slot_id IN ${JSON_IN}`)
    .bind(start, end, u.company_id, bindJsonArray([...timeSlotIds])))
  if (breakSlotIds.size) stmts.push(db.prepare(`UPDATE shift_slots SET break_minutes = ? WHERE company_id = ? AND slot_id IN ${JSON_IN}`)
    .bind(brk ?? null, u.company_id, bindJsonArray([...breakSlotIds])))
  if (moving.length) {
    const upd = moving.map(({ s, moveTime, moveBreak }) => ({ shift_id: s.shift_id,
      start_time: moveTime ? start : s.start_time, end_time: moveTime ? end : s.end_time, break_minutes: moveBreak ? (brk ?? null) : s.break_minutes }))
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
    .bind(u.company_id, bindJsonArray(moving.map(x => x.s.shift_id))).all()).results as any[])) : 0
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
  if (removed) await settleRemovedSlotItems(db, u.company_id) // 未対応の応募を「枠の削除」で処理済みにする（#65）
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
// 開催場所の緯度・経度（#406）。送られていなければ undefined（変えない）、空欄なら null（消す）。片方だけ・範囲外は error
function siteLatLng(b: any): { lat?: number | null; lng?: number | null; error?: string } {
  if (b.lat === undefined && b.lng === undefined) return {}
  const num = (v: any) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v))
  const lat = num(b.lat), lng = num(b.lng)
  if (lat == null && lng == null) return { lat: null, lng: null }
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return { error: '緯度（-90〜90）と経度（-180〜180）を両方とも数値で入力してください' }
  return { lat, lng }
}
app.post('/sites', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!String(b.site_name || '').trim()) return c.json({ error: '開催場所名を入力してください' }, 400)
  if (b.client_id) { const cl = await c.env.DB.prepare('SELECT 1 FROM clients WHERE client_id = ? AND company_id = ?').bind(b.client_id, u.company_id).first(); if (!cl) return c.json({ error: 'クライアントが見つかりません' }, 404) }
  const latlng = siteLatLng(b); if (latlng.error) return c.json({ error: latlng.error }, 400)
  const res = await c.env.DB.prepare('INSERT INTO sites (company_id, client_id, site_name, address, lat, lng, memo) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(u.company_id, b.client_id || null, String(b.site_name).trim(), String(b.address ?? '').trim() || null, latlng.lat ?? null, latlng.lng ?? null, String(b.memo ?? '').trim() || null).run()
  return c.json({ ok: true, site_id: res.meta.last_row_id })
})
app.put('/sites/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const s = await ownSite(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: '開催場所が見つかりません' }, 404)
  // 送られてきた項目だけを変える（名前の変更だけで無効の場所が有効に戻らないように。#130）。住所・メモは空欄で消す
  const name = b.site_name === undefined ? undefined : String(b.site_name ?? '').trim()
  if (name === '') return c.json({ error: '開催場所名を入力してください' }, 400)
  // 位置（緯度・経度。#406）は両方そろえて入れる。空欄なら消す
  const latlng = siteLatLng(b); if (latlng.error) return c.json({ error: latlng.error }, 400)
  const textOf = (v: any) => (v === undefined ? undefined : String(v ?? '').trim())
  const upd = buildUpdate({
    site_name: name, address: textOf(b.address), memo: textOf(b.memo), lat: latlng.lat, lng: latlng.lng,
    status: b.status === undefined ? undefined : (b.status === 'inactive' ? 'inactive' : 'active'),
  }, ['site_name', 'address', 'memo', 'lat', 'lng', 'status'])
  if (!upd.clause) return c.json({ ok: true })
  const db = c.env.DB
  const stmts = [db.prepare(`UPDATE sites SET ${upd.clause} WHERE site_id = ? AND company_id = ?`).bind(...upd.values, s.site_id, u.company_id)]
  // 名前を変えたら、枠・シフトに写してある場所名も新しい名前にする（スタッフのアプリは shifts.location を表示するため。#142）。
  // 確定済みと過去のシフト、場所名を別に入力したもの（前の名前と違うもの）は変えない
  if (name !== undefined && name !== s.site_name) {
    const today = todayJST()
    stmts.push(db.prepare('UPDATE shift_slots SET location = ? WHERE site_id = ? AND company_id = ? AND location = ? AND work_date >= ?').bind(name, s.site_id, u.company_id, s.site_name, today))
    stmts.push(db.prepare(`UPDATE shifts SET location = ? WHERE site_id = ? AND company_id = ? AND location = ? AND work_date >= ?
      AND COALESCE(settle_status,'planned') != 'confirmed'`).bind(name, s.site_id, u.company_id, s.site_name, today))
    // 繰り返し登録の場所名も直す（延長で作る枠に前の名前が付かないように。#142 の残り）
    stmts.push(db.prepare('UPDATE slot_patterns SET location = ? WHERE site_id = ? AND company_id = ? AND location = ?').bind(name, s.site_id, u.company_id, s.site_name))
  }
  await db.batch(stmts)
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
// 適用期間（#210）。空欄は期限なし
const optDate = (v: any) => (v === undefined || v === null || v === '' ? null : v)
app.get('/rate-rules', async (c) => {
  const u = c.get('user')
  const pid = intOrNull(c.req.query('project_id')), sid = intOrNull(c.req.query('staff_id')), cid = intOrNull(c.req.query('client_id'))
  const f: string[] = ['r.company_id = ?']; const b: any[] = [u.company_id]
  if (pid) { f.push('(r.project_id = ? OR (r.project_id IS NULL AND r.staff_id IS NOT NULL))'); b.push(pid) }
  if (sid) { f.push('r.staff_id = ?'); b.push(sid) }
  // クライアント単位のルール（#470）: 案件を指定しないもの
  if (cid) { f.push('r.client_id = ? AND r.project_id IS NULL'); b.push(cid) }
  const rows = (await c.env.DB.prepare(`SELECT r.*, p.project_name, si.site_name, us.name AS staff_name, cl.client_name
    FROM rate_rules r LEFT JOIN projects p ON p.project_id = r.project_id LEFT JOIN sites si ON si.site_id = r.site_id
    LEFT JOIN clients cl ON cl.client_id = r.client_id AND cl.company_id = r.company_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = r.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE ${f.join(' AND ')} ORDER BY r.project_id, r.site_id, r.role_name, r.staff_id, COALESCE(r.valid_from, '')`).bind(...b).all()).results
  return c.json({ rules: rows })
})
// ルールの範囲（案件・クライアント・開催場所・役割・スタッフ）を確かめて、保存する値にそろえる。
// 案件を指定したら、クライアントは持たない（案件のクライアントで決まる）。案件もスタッフも指定しないルールはクライアント単位（#470）で、
// 開催場所だけを指定したら、その開催場所のクライアントの範囲にする。クライアント単位のルールにはスタッフを付けない
// （スタッフ別の単価は案件を選んで登録する。staff-merge.ts の同じ範囲の判定がクライアントを見ないため）
type RuleScope = { project_id: number | null; client_id: number | null; site_id: number | null; role_name: string | null; staff_id: number | null }
async function ruleScopeOf(db: D1Database, u: any, b: any): Promise<{ scope?: RuleScope; error?: string }> {
  const projectId = intOrNull(b.project_id), staffId = intOrNull(b.staff_id), siteId = intOrNull(b.site_id)
  let clientId = projectId ? null : intOrNull(b.client_id)
  if (projectId && !(await ownProject(db, u.company_id, projectId))) return { error: '案件が見つかりません' }
  const site = siteId ? await ownSite(db, u.company_id, siteId) : null
  if (siteId && !site) return { error: '開催場所が見つかりません' }
  if (staffId && !(await db.prepare('SELECT 1 FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(staffId, u.company_id).first())) return { error: 'スタッフが見つかりません' }
  if (!projectId && !staffId) {
    if (!clientId && site?.client_id) clientId = Number(site.client_id)
    if (!clientId && !site) return { error: '案件・クライアント・スタッフのいずれかを指定してください' }
  }
  if (clientId) {
    if (staffId) return { error: 'クライアント単位のルールにはスタッフを指定できません（スタッフ別の単価は、スタッフ詳細で案件を選んで登録してください）' }
    if (!(await db.prepare('SELECT 1 FROM clients WHERE client_id = ? AND company_id = ?').bind(clientId, u.company_id).first())) return { error: 'クライアントが見つかりません' }
    if (site && site.client_id != null && Number(site.client_id) !== clientId) return { error: '開催場所は、そのクライアントのものを選んでください' }
  }
  return { scope: { project_id: projectId, client_id: clientId, site_id: siteId, role_name: String(b.role_name || '').trim() || null, staff_id: staffId } }
}
async function validateRuleScope(db: D1Database, u: any, b: any): Promise<{ error?: string; scope?: RuleScope }> {
  const sc = await ruleScopeOf(db, u, b)
  if (sc.error) return sc
  const err = ruleValuesError(b)
  return err ? { error: err } : sc
}
function ruleValuesError(b: any): string | null {
  const range = rangeError([['請求単価', b.bill_rate, 0, MONEY_MAX], ['支払単価', b.pay_rate, 0, MONEY_MAX],
    ['交通費の請求額', b.bill_transport_amount, 0, MONEY_MAX], ['交通費の支払額', b.pay_transport_amount, 0, MONEY_MAX]])
  if (range) return range
  const from = optDate(b.valid_from), to = optDate(b.valid_to)
  if ((from && !isISODate(from)) || (to && !isISODate(to))) return '適用期間の日付が正しくありません'
  if (from && to && from > to) return '適用開始日は適用終了日以前にしてください'
  const v = ruleValues(b)
  if (v.bill_rate == null && v.pay_rate == null && !v.bill_transport_type && !v.pay_transport_type) return '単価または交通費ルールを1つ以上入力してください'
  return null
}
app.post('/rate-rules', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const vr = await validateRuleScope(c.env.DB, u, b); if (vr.error) return c.json({ error: vr.error }, 400)
  const v = ruleValues(b), s = vr.scope!
  const res = await c.env.DB.prepare(`INSERT INTO rate_rules (company_id, project_id, client_id, site_id, role_name, staff_id, bill_unit_type, bill_rate, pay_unit_type, pay_rate,
      bill_transport_type, bill_transport_amount, pay_transport_type, pay_transport_amount, memo, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, s.project_id, s.client_id, s.site_id, s.role_name, s.staff_id,
      v.bill_unit_type, v.bill_rate, v.pay_unit_type, v.pay_rate, v.bill_transport_type, v.bill_transport_amount, v.pay_transport_type, v.pay_transport_amount, b.memo || null,
      optDate(b.valid_from), optDate(b.valid_to)).run()
  return c.json({ ok: true, rule_id: res.meta.last_row_id, client_id: s.client_id })
})
app.put('/rate-rules/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  const r = await c.env.DB.prepare('SELECT * FROM rate_rules WHERE rule_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!r) return c.json({ error: 'ルールが見つかりません' }, 404)
  const merged = { ...r, ...b }
  const vr = await validateRuleScope(c.env.DB, u, merged); if (vr.error) return c.json({ error: vr.error }, 400)
  const v = ruleValues(merged), s = vr.scope!
  await c.env.DB.prepare(`UPDATE rate_rules SET project_id = ?, client_id = ?, site_id = ?, role_name = ?, staff_id = ?, bill_unit_type = ?, bill_rate = ?, pay_unit_type = ?, pay_rate = ?,
      bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?, memo = ?, valid_from = ?, valid_to = ? WHERE rule_id = ?`)
    .bind(s.project_id, s.client_id, s.site_id, s.role_name, s.staff_id,
      v.bill_unit_type, v.bill_rate, v.pay_unit_type, v.pay_rate, v.bill_transport_type, v.bill_transport_amount, v.pay_transport_type, v.pay_transport_amount, merged.memo || null,
      optDate(merged.valid_from), optDate(merged.valid_to), r.rule_id).run()
  return c.json({ ok: true })
})
app.delete('/rate-rules/:id', async (c) => {
  const u = c.get('user')
  await c.env.DB.prepare('DELETE FROM rate_rules WHERE rule_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})
// 適用結果のプレビュー（work_date を省略したら今日の単価）
app.get('/rate-rules/resolve', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const pid = intOrNull(c.req.query('project_id'))
  if (!pid || !(await ownProject(db, u.company_id, pid))) return c.json({ error: '案件を指定してください' }, 400)
  const data = await loadPricingData(db, u.company_id, [pid])
  const workDate = isISODate(c.req.query('work_date')) ? c.req.query('work_date')! : todayJST()
  const price = resolvePrice({ company_id: u.company_id, project_id: pid, site_id: intOrNull(c.req.query('site_id')), role_name: c.req.query('role_name') || null, staff_id: intOrNull(c.req.query('staff_id')), work_date: workDate }, data)
  const start = isTime(c.req.query('start_time')) ? c.req.query('start_time')! : '10:00', end = isTime(c.req.query('end_time')) ? c.req.query('end_time')! : '19:00'
  const brk = intOrNull(c.req.query('break_minutes')) ?? data.projects.get(pid)?.default_break_minutes ?? 60
  return c.json({ work_date: workDate, price, amounts: calcAmounts(price, start, end, brk) })
})

// 案件の標準単価の改定履歴（#210）
app.get('/projects/:id/price-history', async (c) => {
  const u = c.get('user')
  const p = await ownProject(c.env.DB, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const rows = (await c.env.DB.prepare('SELECT * FROM project_price_history WHERE company_id = ? AND project_id = ? ORDER BY valid_to DESC, history_id DESC')
    .bind(u.company_id, p.project_id).all()).results
  return c.json({ price_valid_from: p.price_valid_from || null, history: rows })
})

// 区分・標準単価・交通費ルール・時間の数え方。
// price_valid_from（適用開始日）を付けて単価を変えると、その前日までの稼働日には今の単価を使い続ける（改定前の単価を project_price_history に残す。#210）。
// 付けずに変えると、今の単価の適用期間（price_valid_from 以降。未設定ならすべての期間）の単価を直す
app.put('/projects/:id/pricing', async (c) => {
  const u = c.get('user'); const b = await c.req.json(); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  // 負の単価・交通費・休憩は受け付けない（#218）
  const range = rangeError([['請求単価', b.unit_price, 0, MONEY_MAX], ['支払単価', b.pay_rate, 0, MONEY_MAX], ['交通費の請求額', b.bill_transport_amount, 0, MONEY_MAX],
    ['交通費の支払額', b.pay_transport_amount, 0, MONEY_MAX], ['休憩', b.default_break_minutes, 0, BREAK_MAX]])
  if (range) return c.json({ error: range }, 400)
  const validFrom = optDate(b.price_valid_from)
  if (validFrom && !isISODate(validFrom)) return c.json({ error: '適用開始日が正しくありません' }, 400)
  const eng = b.engagement_type === 'spot' ? 'spot' : b.engagement_type === 'regular' ? 'regular' : (p.engagement_type || 'regular')
  const unit = (v: any, d: string) => (v === 'hourly' ? 'hourly' : v === 'daily' ? 'daily' : d)
  const basis = HOURS_BASIS.includes(b.hours_basis) ? b.hours_basis : (p.hours_basis || 'clipped')
  const roundMin = [0, 1, 5, 10, 15, 30].includes(Number(b.time_round_minutes)) ? Number(b.time_round_minutes) : (p.time_round_minutes || 0)
  // 支払側の丸め（#220）: none = 支払は丸めない / same = 請求と同じく丸める
  const payRound = b.pay_time_round === 'same' || b.pay_time_round === 'none' ? b.pay_time_round : (p.pay_time_round || 'none')
  const next: Record<string, any> = {
    unit_price_type: unit(b.unit_price_type, p.unit_price_type === 'hourly' ? 'hourly' : 'daily'), unit_price: intOrNull(b.unit_price) ?? p.unit_price ?? 0,
    pay_unit_type: unit(b.pay_unit_type, p.pay_unit_type || 'daily'), pay_rate: b.pay_rate !== undefined ? intOrNull(b.pay_rate) : p.pay_rate,
    bill_transport_type: BILL_TRANSPORT_TYPES.includes(b.bill_transport_type) ? b.bill_transport_type : (p.bill_transport_type || 'actual'),
    bill_transport_amount: intOrNull(b.bill_transport_amount) ?? p.bill_transport_amount ?? 0,
    pay_transport_type: PAY_TRANSPORT_TYPES.includes(b.pay_transport_type) ? b.pay_transport_type : (p.pay_transport_type || 'actual'),
    pay_transport_amount: intOrNull(b.pay_transport_amount) ?? p.pay_transport_amount ?? 0,
  }
  const cur: Record<string, any> = {
    unit_price_type: p.unit_price_type === 'hourly' ? 'hourly' : 'daily', unit_price: p.unit_price ?? 0, pay_unit_type: p.pay_unit_type || 'daily', pay_rate: p.pay_rate,
    bill_transport_type: p.bill_transport_type || 'actual', bill_transport_amount: p.bill_transport_amount ?? 0,
    pay_transport_type: p.pay_transport_type || 'actual', pay_transport_amount: p.pay_transport_amount ?? 0,
  }
  const priceChanged = PROJECT_PRICE_FIELDS.some(k => !sameValue(cur[k], next[k]))
  const stmts: D1PreparedStatement[] = []
  let priceFrom = p.price_valid_from || null
  if (validFrom && priceChanged) {
    const dayBefore = addDays(validFrom, -1)
    // 適用開始日以降に始まる改定前の単価は新しい単価に置き換わり、適用開始日をまたぐものはその前日までにする
    stmts.push(db.prepare('DELETE FROM project_price_history WHERE company_id = ? AND project_id = ? AND valid_from >= ?').bind(u.company_id, p.project_id, validFrom))
    stmts.push(db.prepare('UPDATE project_price_history SET valid_to = ? WHERE company_id = ? AND project_id = ? AND valid_to >= ?').bind(dayBefore, u.company_id, p.project_id, validFrom))
    // 今の単価は、適用開始日の前日までの単価として残す（今の単価の適用開始日が新しい適用開始日以降なら、今の単価は使われないので残さない）
    if (!priceFrom || priceFrom < validFrom) {
      stmts.push(db.prepare(`INSERT INTO project_price_history (company_id, project_id, valid_from, valid_to, ${PROJECT_PRICE_FIELDS.join(', ')}, created_by)
        VALUES (?, ?, ?, ?, ${PROJECT_PRICE_FIELDS.map(() => '?').join(', ')}, ?)`)
        .bind(u.company_id, p.project_id, priceFrom, dayBefore, ...PROJECT_PRICE_FIELDS.map(k => p[k] ?? null), u.user_id))
    }
    priceFrom = validFrom
  }
  stmts.push(db.prepare(`UPDATE projects SET engagement_type = ?, unit_price_type = ?, unit_price = ?, pay_unit_type = ?, pay_rate = ?,
      bill_transport_type = ?, bill_transport_amount = ?, pay_transport_type = ?, pay_transport_amount = ?, default_break_minutes = ?, hours_basis = ?, time_round_minutes = ?,
      pay_time_round = ?, price_valid_from = ? WHERE project_id = ? AND company_id = ?`)
    .bind(eng, next.unit_price_type, next.unit_price, next.pay_unit_type, next.pay_rate, next.bill_transport_type, next.bill_transport_amount,
      next.pay_transport_type, next.pay_transport_amount, intOrNull(b.default_break_minutes) ?? p.default_break_minutes ?? 60, basis, roundMin,
      payRound, priceFrom, p.project_id, u.company_id))
  await db.batch(stmts)
  return c.json({ ok: true, price_valid_from: priceFrom, price_changed: priceChanged })
})

// =========================================================
// 交通費の標準（スタッフ × 開催場所。#564）。site_id = 0 はそのスタッフのすべての開催場所の標準
// 割り当て・一括登録・募集の承認で、交通費の入力がなければ使う（lib/transport-defaults）
// =========================================================
app.get('/transport-defaults', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const elig = assignableStaffSql({ sp: 'sp', us: 'us' })
  const [defaults, staff, sites] = await Promise.all([
    db.prepare(`SELECT d.default_id, d.staff_id, d.site_id, d.amount, d.note, d.updated_at, us.name AS staff_name, si.site_name, ub.name AS updated_by_name
      FROM staff_transport_defaults d JOIN staff_profiles sp ON sp.staff_id = d.staff_id JOIN users us ON us.user_id = sp.user_id
      LEFT JOIN sites si ON si.site_id = d.site_id AND si.company_id = d.company_id LEFT JOIN users ub ON ub.user_id = d.updated_by
      WHERE d.company_id = ? ORDER BY us.name, d.staff_id, d.site_id LIMIT 5000`).bind(u.company_id).all(),
    db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND ${elig.sql} ORDER BY us.name LIMIT 5000`)
      .bind(u.company_id, ...elig.binds).all(),
    db.prepare('SELECT site_id, site_name FROM sites WHERE company_id = ? ORDER BY site_name LIMIT 2000').bind(u.company_id).all(),
  ])
  return c.json({ defaults: defaults.results, staff: staff.results, sites: sites.results })
})
// 登録・変更（同じスタッフ × 開催場所の標準は1つ。あれば金額を置き換える）
app.put('/transport-defaults', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const staffId = Number(b.staff_id), siteId = b.site_id === '' || b.site_id == null ? 0 : Number(b.site_id)
  if (!Number.isInteger(staffId) || staffId <= 0) return c.json({ error: 'スタッフを選択してください' }, 400)
  if (!Number.isInteger(siteId) || siteId < 0) return c.json({ error: '開催場所が正しくありません' }, 400)
  if (b.amount === '' || b.amount == null) return c.json({ error: '金額を入力してください' }, 400)
  const err = rangeError([['交通費の標準', b.amount, 0, MONEY_MAX]])
  if (err) return c.json({ error: err }, 400)
  const sp = await db.prepare('SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(staffId, u.company_id).first()
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (siteId && !(await ownSite(db, u.company_id, siteId))) return c.json({ error: '開催場所が見つかりません' }, 404)
  const note = String(b.note ?? '').trim().slice(0, 100) || null
  await db.prepare(`INSERT INTO staff_transport_defaults (company_id, staff_id, site_id, amount, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
    ON CONFLICT(company_id, staff_id, site_id) DO UPDATE SET amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(u.company_id, staffId, siteId, Math.round(Number(b.amount)), note, u.user_id).run()
  return c.json({ ok: true })
})
app.delete('/transport-defaults/:id', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare('DELETE FROM staff_transport_defaults WHERE default_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '交通費の標準が見つかりません' }, 404)
  return c.json({ ok: true })
})

export default app
