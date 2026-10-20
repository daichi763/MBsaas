// =========================================================
// 実績の確定 / 請求・支払の集計 / CSV出力
// docs/spec_spot_shift.md 第3段階
//
// 管理者向け（/api/admin/*）のみ。api.ts から権限ミドルウェアの後に登録する。
// 実働時間: 勤務開始・勤務終了の報告（なければ入店・退店）から actual_start / actual_end に反映する。
// 休憩入・休憩出の報告が両方あれば、その差を actual_break_minutes に反映する（docs/spec_attendance_correction.md 4.7）。
// 管理者が入力した実績（actual_source = 'manual'）は報告で上書きしない。
// 確定（settle_status = 'confirmed'）したシフトは金額・時間・スタッフを変更できない。
// 締め（settlement_closings。#170）た期間のシフトは、確定・取り消し・実績と金額の変更・報告の反映を受け付けない。
// 欠勤のシフトは、キャンセル料・補償（shift_cancellations。#283）を入れたものだけを精算の対象にする。
// =========================================================
import { Hono } from 'hono'
import { MONEY_MAX, calcAmounts, hoursForAmounts, isSettled, loadPricingData, shiftTotals, workHours } from './shift-board'
import { isHHMM } from './lib/validate'
import { toCsv } from './csv'
import { JSON_IN, batchInChunks, bindJsonArray, chunk } from './lib/d1-chunk'
import { addDays, overlaps, shiftWindow } from './lib/shift-time'
import { changesOf, updateRowsStmts } from './lib/bulk-write'
import { isWorkingShift } from './lib/shift-status'
import { REPORT_TYPES, attendanceTypesForRows } from './report-settings'
import { ownClient, ownProject } from './lib/tenant'
import { notifyShiftStaff } from './lib/staff-pay-notify'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const MAX_RANGE_DAYS = 93
// 一覧・CSV・一括の確定と取り消しで扱う件数の上限。超えたときは一部だけを処理せず、期間や条件を絞ってもらう
export const MAX_ROWS = 5000
const WORK_STATUSES = ['confirmed', 'substitute']
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
// 時刻は 00:00〜23:59 だけを受け付ける（#218）
const isTime = (s: any) => isHHMM(s)
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function dayDiff(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) }
function intOrNull(v: any): number | null { if (v === '' || v == null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null }

export const PAYEE_LABEL: Record<string, string> = {
  payroll: '自社給与', payroll_daily: '日雇い給与', freelance: '個人事業主（業務委託）', partner: '取引先', linked: '他社（連携元）',
}
// 欠勤・中止の理由（#283）
export const CANCEL_REASON_LABEL: Record<string, string> = { staff: 'スタッフ都合の欠勤', client: 'クライアント都合の中止' }

// ---------- 締め（#170） ----------
type Closing = { closing_id: number; period_from: string; period_to: string; closed_at: string; closed_by_name: string | null; shift_count: number; bill_total: number; pay_total: number }
// from〜to（稼働日）と重なる有効な締め
async function loadClosings(db: D1Database, companyId: number, from: string, to: string): Promise<Closing[]> {
  return (await db.prepare(`SELECT k.closing_id, k.period_from, k.period_to, k.closed_at, k.shift_count, k.bill_total, k.pay_total, us.name AS closed_by_name
    FROM settlement_closings k LEFT JOIN users us ON us.user_id = k.closed_by
    WHERE k.company_id = ? AND k.reopened_at IS NULL AND k.period_from <= ? AND k.period_to >= ? ORDER BY k.period_from`).bind(companyId, to, from).all()).results as any[]
}
const closingOf = (list: Closing[], date: string) => list.find(k => k.period_from <= date && date <= k.period_to) || null
const closedText = (k: Closing) => `${k.period_from}〜${k.period_to} は精算を締めています。変更するには精算画面で締めを解除してください`
// 稼働日が締めた期間に入っていれば、その文言を返す（シフトの追加・変更・削除の確認に api.ts からも呼ぶ）
export async function closedMessage(db: D1Database, companyId: number, workDate: any): Promise<string | null> {
  if (!isDate(workDate)) return null
  const k = closingOf(await loadClosings(db, companyId, workDate, workDate), workDate)
  return k ? closedText(k) : null
}

// ---------- 金額の再計算（実績の変更時） ----------
// 単価ルールは再適用しない（過去のシフトの単価を変えないため）。記録済みの単価のまま、時給の数量だけを実働時間に合わせる。
// 日額のシフトは金額を変えない。手動で金額を変えたシフト（price_locked）は、数量も固定したもの（qty_locked。従来の行は NULL）なら数量も変えず、
// 精算画面の「確認」に表示する。単価だけを固定したもの（qty_locked = 0）は、時給の数量を実働に合わせる（#196）
// 請求と支払の時間は workHours の hours と pay_hours（支払側の丸めを分ける #220）
export const qtyFixed = (s: any) => !!s.price_locked && s.qty_locked !== 0
// s はシフトの行（shifts.*）、proj は案件の休憩・時間の計算方法。変えないときは null
export function amountsForActual(s: any, proj: any) {
  if (isSettled(s) || qtyFixed(s)) return null
  const billHourly = s.bill_unit_type === 'hourly' && s.bill_rate != null
  const payHourly = s.pay_unit_type === 'hourly' && s.pay_rate != null
  if (!billHourly && !payHourly) return null
  const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
  const h = hoursForAmounts(workHours({ ...s, break_minutes: brk }, proj))
  const amt = calcAmounts({ bill_unit_type: 'hourly', bill_rate: s.bill_rate, pay_unit_type: 'hourly', pay_rate: s.pay_rate }, s.start_time, s.end_time, brk, h)
  return {
    bill_qty: billHourly ? amt.bill_qty : s.bill_qty, unit_price: billHourly ? amt.unit_price : s.unit_price,
    pay_qty: payHourly ? amt.pay_qty : s.pay_qty, pay_amount: payHourly ? amt.pay_amount : s.pay_amount,
  }
}
export async function refreshShiftAmounts(db: D1Database, companyId: number, shiftId: number) {
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s || isSettled(s) || qtyFixed(s)) return
  if (await closedMessage(db, companyId, s.work_date)) return
  const data = await loadPricingData(db, companyId, [s.project_id])
  const amt = amountsForActual(s, data.projects.get(Number(s.project_id)) || {})
  if (!amt) return
  await db.prepare('UPDATE shifts SET bill_qty = ?, unit_price = ?, pay_qty = ?, pay_amount = ? WHERE shift_id = ?')
    .bind(amt.bill_qty, amt.unit_price, amt.pay_qty, amt.pay_amount, shiftId).run()
}

// 報告の時刻から求める実績（syncActualFromReports と、精算の確認事項「報告が実績に未反映」で共用）
//   開始 = 勤務開始（なければ入店）、終了 = 勤務終了（なければ退店）。両方そろったときだけ
//   休憩 = 休憩出 − 休憩入（分。両方あるときのみ。ないときは NULL = 予定の休憩）
export const ACTUAL_REPORT_TYPES = ['check_in', 'check_out', 'work_start', 'work_end', 'break_start', 'break_end'] as const
export function actualFromReports(at: (type: string) => string | null | undefined) {
  const hm = (t?: string | null) => (String(t || '').match(/(\d{2}:\d{2})/) || [])[1] || null
  const cin = hm(at('work_start') || at('check_in')), cout = hm(at('work_end') || at('check_out'))
  const start = cin && cout ? cin : null, end = cin && cout ? cout : null
  const bs = at('break_start'), be = at('break_end')
  const brkMin = bs && be ? Math.round((Date.parse(be.replace(' ', 'T') + 'Z') - Date.parse(bs.replace(' ', 'T') + 'Z')) / 60000) : NaN
  const brk = Number.isFinite(brkMin) && brkMin >= 0 && brkMin <= 1440 ? brkMin : null
  return { start, end, brk }
}
const sameActual = (a: { start: string | null; end: string | null; brk: number | null }, s: any) =>
  a.start === (s.actual_start || null) && a.end === (s.actual_end || null) && a.brk === (s.actual_break_minutes ?? null)
// 実績に関わる報告の時刻を、シフトの行と一緒に読むための列（r_check_in など）。shifts の別名は s
const REPORT_COLS = ACTUAL_REPORT_TYPES.map(t => `(SELECT a.reported_at FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = '${t}') AS r_${t}`).join(',\n      ')

// 報告の時刻を実績に反映する（管理者の手入力・確定済み・締めた期間は対象外）。報告の登録・変更・削除と、打刻修正の承認のたびに呼ぶ
export async function syncActualFromReports(db: D1Database, companyId: number, shiftId: number) {
  const s = await db.prepare('SELECT shift_id, work_date, actual_source, settle_status, actual_start, actual_end, actual_break_minutes FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s || isSettled(s) || s.actual_source === 'manual') return false
  if (await closedMessage(db, companyId, s.work_date)) return false
  const reps = (await db.prepare("SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ? AND report_type IN ('check_in','check_out','work_start','work_end','break_start','break_end')").bind(shiftId).all()).results as any[]
  const a = actualFromReports(t => reps.find(r => r.report_type === t)?.reported_at as string | undefined)
  if (sameActual(a, s)) return false
  await db.prepare('UPDATE shifts SET actual_start = ?, actual_end = ?, actual_break_minutes = ?, actual_source = ? WHERE shift_id = ?')
    .bind(a.start, a.end, a.brk, a.start || a.brk != null ? 'report' : null, shiftId).run()
  await refreshShiftAmounts(db, companyId, shiftId)
  return true
}

// 複数のシフトの報告の時刻を、まとめて実績に反映する（規則は syncActualFromReports と同じ。確定の取り消しの後に使う）。
// D1 の1回の実行あたりの問い合わせ数を増やさないよう、500件ずつ1回で読み、計算はメモリ上で行い、更新は db.batch で書く。反映した件数を返す
export async function syncActualsForShifts(db: D1Database, companyId: number, shiftIds: number[]) {
  let updated = 0
  for (const part of chunk(shiftIds, 500)) {
    const rows = (await db.prepare(`SELECT s.*, p.hours_basis, p.time_round_minutes, p.pay_time_round, p.default_break_minutes, ${REPORT_COLS}
      FROM shifts s JOIN projects p ON p.project_id = s.project_id WHERE s.company_id = ? AND s.shift_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(part)).all()).results as any[]
    const stmts: D1PreparedStatement[] = []
    for (const s of rows) {
      if (isSettled(s) || s.actual_source === 'manual') continue
      const a = actualFromReports(t => s['r_' + t])
      if (sameActual(a, s)) continue
      const amt = amountsForActual({ ...s, actual_start: a.start, actual_end: a.end, actual_break_minutes: a.brk },
        { hours_basis: s.hours_basis, time_round_minutes: s.time_round_minutes, pay_time_round: s.pay_time_round, default_break_minutes: s.default_break_minutes })
      stmts.push(db.prepare(`UPDATE shifts SET actual_start = ?, actual_end = ?, actual_break_minutes = ?, actual_source = ?, bill_qty = ?, unit_price = ?, pay_qty = ?, pay_amount = ?
        WHERE shift_id = ? AND company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed' AND COALESCE(actual_source,'') != 'manual'`)
        .bind(a.start, a.end, a.brk, a.start || a.brk != null ? 'report' : null,
          amt ? amt.bill_qty : s.bill_qty, amt ? amt.unit_price : s.unit_price, amt ? amt.pay_qty : s.pay_qty, amt ? amt.pay_amount : s.pay_amount, s.shift_id, companyId))
    }
    for (const r of await batchInChunks(db, stmts)) updated += r.meta?.changes || 0
  }
  return updated
}

// ---------- 一覧の取得 ----------
function parseFilters(q: (k: string) => string | undefined) {
  const from = q('from'), to = q('to')
  if (!isDate(from) || !isDate(to) || dayDiff(from!, to!) < 0) return { error: '期間を指定してください' }
  if (dayDiff(from!, to!) > MAX_RANGE_DAYS - 1) return { error: `期間は${MAX_RANGE_DAYS}日以内で指定してください` }
  return {
    from: from!, to: to!, client_id: intOrNull(q('client_id')), project_id: intOrNull(q('project_id')), staff_id: intOrNull(q('staff_id')),
    payee_type: q('payee_type') || '', settle: q('settle') || '', issues_only: q('issues_only') === '1',
  }
}
type Filters = Exclude<ReturnType<typeof parseFilters>, { error: string }>

// ---------- 確認事項 ----------
// 文言は public/static/settlement.js と同じ
const PENDING_ISSUE = '承認待ちの打刻修正あり'
const CORRECTED_AFTER_SETTLE = '確定後に打刻修正あり'
const REPORTED_AFTER_SETTLE = '確定後に報告あり（実績に未反映）'
export const RECALC_ISSUE = '数量・金額が今の計算と違う'
const PAYEE_EXCLUDED_ISSUE = '区分変更の対象外（支払先が変更前のまま）'
const CANCEL_UNSET_ISSUE = 'キャンセル料・補償が未入力'
// スタッフからの交通費・延長の申請（src/staff-pay.ts。#172 #273）が承認待ち
export const PAY_REQUEST_ISSUE = '承認待ちの交通費・延長の申請あり'
// 確定の後に起きる項目。確定済みの行では、これだけを確認が必要として数える（それ以外は確定したときに確認したものとして扱う。#563）
const AFTER_SETTLE_ISSUES = new Set([PENDING_ISSUE, CORRECTED_AFTER_SETTLE, REPORTED_AFTER_SETTLE, PAY_REQUEST_ISSUE])
// 承認待ちの打刻修正・交通費と延長の申請は、承認・却下で片づけるものなので確認済みにはできない
const ackable = (issue: string) => issue !== PENDING_ISSUE && issue !== PAY_REQUEST_ISSUE
// 時間の数え方が『実績（予定の範囲内）』のシフトで、予定の終了より後まで勤務した分（分。延長が承認されていない分は支払われない。#172）
function overrunMinutes(r: any, basis: string): number {
  if (basis !== 'clipped' || !r.actual_start || !r.actual_end || !r.start_time || !r.end_time) return 0
  const m = (t: string) => { const [h, mm] = String(t).split(':').map(Number); return (h || 0) * 60 + (mm || 0) }
  // workHours と同じく、実績の開始は予定の開始に最も近い日の時刻とみなす
  const ps = m(r.start_time); let pe = m(r.end_time); if (pe <= ps) pe += 1440
  let as = m(r.actual_start); if (as - ps > 720) as -= 1440; else if (ps - as > 720) as += 1440
  let ae = m(r.actual_end); while (ae <= as) ae += 1440
  return Math.max(0, ae - pe)
}
// 予定の終了の後の勤務を確認事項にする最小の分（案件の丸め単位がこれより大きければ丸め単位）
const OVERRUN_MIN_MINUTES = 15
const numDiff = (a: any, b: any) => (a == null ? null : Number(a)) !== (b == null ? null : Number(b))
// 日報の提出設定（シフト → スタッフ → 案件の順。staff-lifecycle.ts の resolveModes と同じ規則）
const pickDailyMode = (...vals: any[]) => vals.find(v => v === 'none' || v === 'required') || 'required'

// 確認済みの印（shift_id + 文言 → 確認した日時・人）
async function loadAcks(db: D1Database, companyId: number, rows: any[]) {
  const map = new Map<string, { acked_at: string; acked_by_name: string | null }>()
  if (!rows.length) return map
  const res = (await db.prepare(`SELECT a.shift_id, a.issue, a.acked_at, us.name AS acked_by_name FROM settlement_issue_acks a LEFT JOIN users us ON us.user_id = a.acked_by
    WHERE a.company_id = ? AND a.shift_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(rows.map(r => r.shift_id))).all()).results as any[]
  for (const a of res) map.set(`${a.shift_id}\n${a.issue}`, a)
  return map
}

// 同じスタッフの時間が重なる確定・代打のシフト（#467）。一覧の絞り込み（案件・クライアントなど）の外のシフトも、前後1日まで含めて調べる。
// 判定は lib/shift-time の shiftWindow（日をまたぐ勤務は翌日まで）と overlaps（端が接するだけなら重ならない）
async function loadOverlaps(db: D1Database, companyId: number, rows: any[]) {
  type Other = { shift_id: number; staff_id: number; work_date: string; start_time: string; end_time: string; project_name: string; w: ReturnType<typeof shiftWindow> }
  const map = new Map<number, Other[]>()
  if (!rows.length) return map
  const dates = rows.map(r => String(r.work_date)).sort()
  const res = (await db.prepare(`SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, p.project_name FROM shifts s JOIN projects p ON p.project_id = s.project_id
    WHERE s.company_id = ? AND s.status IN ('confirmed','substitute') AND s.staff_id IN ${JSON_IN} AND s.work_date BETWEEN ? AND ?`)
    .bind(companyId, bindJsonArray(rows.map(r => r.staff_id)), addDays(dates[0], -1), addDays(dates[dates.length - 1], 1)).all()).results as any[]
  const byStaff = new Map<number, Other[]>()
  for (const o of res) {
    if (!o.start_time || !o.end_time) continue
    const a = byStaff.get(o.staff_id) || []; a.push({ ...o, w: shiftWindow(o.work_date, o.start_time, o.end_time) }); byStaff.set(o.staff_id, a)
  }
  for (const list of byStaff.values()) {
    list.sort((x, y) => x.w.start.localeCompare(y.w.start))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].w.start < list[i].w.end; j++) {
        if (!overlaps(list[i].w, list[j].w)) continue
        map.set(list[i].shift_id, [...(map.get(list[i].shift_id) || []), list[j]])
        map.set(list[j].shift_id, [...(map.get(list[j].shift_id) || []), list[i]])
      }
    }
  }
  return map
}

// 条件に合うシフトを MAX_ROWS + 1 件まで読む（上限を超えたかどうかを呼び出し側で判定できるように1件多く読む）
// 対象は確定・代打のシフトと、キャンセル料・補償を入れた欠勤のシフト（#283）
async function loadRows(db: D1Database, companyId: number, f: Filters, shiftIds?: number[]) {
  const w = ['s.company_id = ?', `(s.status IN (${WORK_STATUSES.map(() => '?').join(',')}) OR (s.status = 'absent' AND sc.shift_id IS NOT NULL))`]; const bind: any[] = [companyId, ...WORK_STATUSES]
  if (shiftIds) { w.push(`s.shift_id IN ${JSON_IN}`); bind.push(bindJsonArray(shiftIds)) }
  else { w.push('s.work_date BETWEEN ? AND ?'); bind.push(f.from, f.to) }
  if (f.client_id) { w.push('p.client_id = ?'); bind.push(f.client_id) }
  if (f.project_id) { w.push('s.project_id = ?'); bind.push(f.project_id) }
  if (f.staff_id) { w.push('s.staff_id = ?'); bind.push(f.staff_id) }
  if (f.payee_type) { w.push("COALESCE(s.payee_type,'payroll') = ?"); bind.push(f.payee_type) }
  if (f.settle === 'confirmed') w.push("s.settle_status = 'confirmed'")
  if (f.settle === 'planned') w.push("COALESCE(s.settle_status,'planned') != 'confirmed'")
  // manual_correction_at: 実績が手入力のときに承認した打刻修正（承認の操作履歴に applied_while_manual を記録している）
  const rows = (await db.prepare(`SELECT s.*, p.project_name, p.client_id, p.hours_basis, p.time_round_minutes, p.pay_time_round, p.default_break_minutes, cl.client_name,
      st.site_name, us.name AS staff_name, sp.affiliation_type, er.employee_number,
      aff.affiliation_name AS payee_affiliation_name, pco.company_name AS payee_company_name,
      (SELECT MAX(c.decided_at) FROM attendance_corrections c WHERE c.shift_id = s.shift_id AND c.status = 'approved') AS last_correction_at,
      (SELECT COUNT(*) FROM attendance_corrections c WHERE c.shift_id = s.shift_id AND c.status = 'pending') AS pending_corrections,
      (SELECT MAX(e.created_at) FROM attendance_corrections c JOIN attendance_correction_events e ON e.correction_id = c.correction_id
        WHERE c.shift_id = s.shift_id AND c.status = 'approved' AND e.event IN ('approved','approved_exception') AND json_extract(e.detail, '$.applied_while_manual') = 1) AS manual_correction_at,
      ${REPORT_COLS},
      (SELECT COUNT(*) FROM daily_reports d WHERE d.shift_id = s.shift_id
        OR (+d.shift_id IS NULL AND d.staff_id = s.staff_id AND d.work_date = s.work_date AND d.project_id = s.project_id)) AS has_daily,
      sp.attendance_mode AS legacy_mode, sp.daily_report_mode AS sp_daily_mode, p.daily_report_mode AS p_daily_mode,
      (SELECT x.to_payee_type || ':' || COALESCE(x.to_payee_affiliation_id, '') FROM affiliation_excluded_shifts x
        WHERE x.shift_id = s.shift_id AND x.company_id = s.company_id ORDER BY x.history_id DESC LIMIT 1) AS aff_excluded_payee,
      (SELECT COUNT(*) FROM staff_pay_requests q WHERE q.shift_id = s.shift_id AND q.company_id = s.company_id AND q.status = 'pending') AS pending_pay_requests,
      sc.reason AS cx_reason, sc.notified_on AS cx_notified_on, sc.bill_amount AS cx_bill, sc.pay_amount AS cx_pay, sc.note AS cx_note
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    LEFT JOIN shift_cancellations sc ON sc.shift_id = s.shift_id AND sc.company_id = s.company_id
    LEFT JOIN sites st ON st.site_id = s.site_id
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = s.staff_id
    LEFT JOIN staff_affiliations aff ON aff.affiliation_id = s.payee_affiliation_id
    LEFT JOIN companies pco ON pco.company_id = s.payee_company_id
    WHERE ${w.join(' AND ')} ORDER BY s.work_date, cl.client_name, p.project_name, s.start_time, us.name LIMIT ${MAX_ROWS + 1}`).bind(...bind).all()).results as any[]
  const now = nowJST(), today = now.slice(0, 10)
  // 報告の設定（#209）、確認済みの印（#563）、同じ人の時間が重なるシフト（#467）をまとめて読む
  // 締めた期間（#170）も、行の稼働日の範囲で読む
  const dates = rows.map(r => String(r.work_date)).sort()
  const [attTypes, acks, overlapsOf, closings] = await Promise.all([attendanceTypesForRows(db, rows), loadAcks(db, companyId, rows), loadOverlaps(db, companyId, rows),
    dates.length ? loadClosings(db, companyId, dates[0], dates[dates.length - 1]) : Promise.resolve([] as Closing[])])
  const out = rows.map(r => {
    const proj = { hours_basis: r.hours_basis, time_round_minutes: r.time_round_minutes, pay_time_round: r.pay_time_round, default_break_minutes: r.default_break_minutes }
    const h = workHours(r, proj)
    const t = shiftTotals(r)
    const settled = r.settle_status === 'confirmed'
    const at = (type: string) => r['r_' + type] as string | null
    const hasIn = !!at('check_in'), hasOut = !!at('check_out')
    // 報告から求めた実績と今の実績が違う（手入力の実績は対象外）。確定中の報告・打刻修正や、反映の漏れで起きる
    const fromReports = actualFromReports(at)
    const unsynced = r.actual_source !== 'manual' && !sameActual(fromReports, r)
    const lastReportAt = ACTUAL_REPORT_TYPES.map(at).filter(Boolean).sort().pop() || null
    const issues: string[] = []
    const past = r.work_date <= today
    // 報告の設定で入店・勤務開始（または退店・勤務終了）を OFF にしたシフトは、その報告がないことを確認事項にしない（#209）。
    // 開始・終了のどちらかが OFF なら報告から実績を求められないので、実績がなくても予定の時間で計算する
    const types = attTypes.get(r.shift_id)?.types ?? [...REPORT_TYPES]
    const startOn = types.includes('check_in') || types.includes('work_start'), endOn = types.includes('check_out') || types.includes('work_end')
    const hasStart = !!(at('check_in') || at('work_start')), hasEnd = !!(at('check_out') || at('work_end'))
    let missing = false
    if (past && !r.actual_start) {
      missing = true
      if (startOn && !hasStart) issues.push(types.includes('check_in') ? '入店報告なし' : '勤務開始の報告なし')
      else if (endOn && !hasEnd) issues.push(types.includes('check_out') ? '退店報告なし' : '勤務終了の報告なし')
      else if (startOn && endOn) issues.push(unsynced && !settled ? '報告が実績に未反映' : '実績未入力')
      else missing = false
    }
    const hoursDiff = h.actual_hours != null && Math.abs(h.actual_hours - h.planned_hours) >= 0.5
    if (hoursDiff) issues.push(`実働が予定と${h.actual_hours! > h.planned_hours ? '+' : ''}${Math.round((h.actual_hours! - h.planned_hours) * 100) / 100}h 違う`)
    // 『実績（予定の範囲内）』で予定の終了より後まで勤務し、延長の申請がない（0.5h 未満の延長も、丸め単位以上なら出す。#172）
    const over = overrunMinutes(r, h.basis)
    if (!hoursDiff && !r.pending_pay_requests && over >= Math.max(OVERRUN_MIN_MINUTES, Number(r.time_round_minutes || 0))) issues.push(`予定の終了より${over}分後まで勤務（延長の申請・承認なし）`)
    if (r.pay_amount == null) issues.push('支払単価未設定')
    // 承認待ちの打刻修正。確定すると、後で承認したときに確定の取り消しと再確定が必要になる
    if (r.pending_corrections) issues.push(PENDING_ISSUE)
    // 承認待ちの交通費・延長の申請（#172 #273）。確定すると承認できない（確定の取り消しが必要）
    if (r.pending_pay_requests) issues.push(PAY_REQUEST_ISSUE)
    // 確定の後に打刻修正を承認した、または報告があった（報告は記録済み・実績と金額は確定時のまま）。確定を取り消すと実績に反映される
    if (settled && r.last_correction_at && (!r.settled_at || r.last_correction_at >= r.settled_at)) issues.push(CORRECTED_AFTER_SETTLE)
    else if (settled && (unsynced || (r.settled_at && lastReportAt && lastReportAt > r.settled_at))) issues.push(REPORTED_AFTER_SETTLE)
    else if (!settled && unsynced && !missing) issues.push('報告が実績に未反映')
    // 手入力の実績のあるシフトで打刻修正を承認した（実績・金額は手入力のまま）。「報告の時刻に戻す」で反映される
    if (r.actual_source === 'manual' && r.manual_correction_at && !sameActual(fromReports, r)) issues.push('手入力後に打刻修正あり')
    if (!r.unit_price && !r.bill_rate) issues.push('請求単価未設定')
    if (qtyFixed(r) && ((r.bill_unit_type === 'hourly' && Number(r.bill_qty) !== h.hours) || (r.pay_unit_type === 'hourly' && Number(r.pay_qty) !== h.pay_hours))) issues.push('手動変更（数量が実働と違う）')
    // 案件の時間の数え方・丸め・休憩を変えた後など、保存した数量・金額が今の計算と違う未確定の過去シフト（#79）。
    // 金額は実績が変わったときにしか計算し直さないため。「再計算」（POST /settlement/recalc）で amountsForActual の値にそろえる
    const expect = !settled && past ? amountsForActual(r, proj) : null
    if (expect && (numDiff(expect.bill_qty, r.bill_qty) || numDiff(expect.unit_price, r.unit_price) || numDiff(expect.pay_qty, r.pay_qty) || numDiff(expect.pay_amount, r.pay_amount))) issues.push(RECALC_ISSUE)
    // 日報が必要なシフト（シフト → スタッフ → 案件の設定）で、勤務が終わっても日報がない（#209）
    const dailyRequired = pickDailyMode(r.daily_report_mode, r.sp_daily_mode, r.p_daily_mode) === 'required'
    if (dailyRequired && !r.has_daily && (r.work_date < today || shiftWindow(r.work_date, r.start_time, r.end_time).end <= now)) issues.push('日報なし')
    // 区分変更で勤務済みのため置き換えなかったシフトで、支払先が変更後の区分と違う（#233）。精算の画面から単価ルールを再適用（PUT /shifts/:id/price の reset）して今の区分に合わせる
    if (r.aff_excluded_payee) {
      const [toType, toAff] = String(r.aff_excluded_payee).split(':')
      if ((r.payee_type || 'payroll') !== toType || (toType === 'partner' && String(r.payee_affiliation_id ?? '') !== toAff)) issues.push(PAYEE_EXCLUDED_ISSUE)
    }
    // 同じスタッフの時間が重なる確定・代打のシフト（#467）
    for (const o of overlapsOf.get(r.shift_id) || []) issues.push(`同じ時間帯に別のシフトあり（${Number(o.work_date.slice(5, 7))}/${Number(o.work_date.slice(8, 10))} ${o.start_time}〜${o.end_time} ${o.project_name} #${o.shift_id}）`)
    // 欠勤・中止のシフト（#283）は勤務の確認事項を出さず、金額が未入力のときだけ確認事項にする
    const cancel = r.status === 'absent'
    if (cancel) issues.splice(0, issues.length, ...(r.cx_bill == null && r.cx_pay == null ? [CANCEL_UNSET_ISSUE] : []))
    // 確認済みの印（#563）。確定済みの行では、確定後に起きる項目だけを確認事項として数え、それ以外は確定したときに確認したものとして扱う
    const eventAt = (i: string) => (i === CORRECTED_AFTER_SETTLE ? r.last_correction_at : i === REPORTED_AFTER_SETTLE ? (lastReportAt || r.settled_at) : null)
    const open: string[] = [], acked: string[] = []
    let lastAck: any = null
    for (const i of issues) {
      const a = acks.get(`${r.shift_id}\n${i}`)
      const ackOk = !!a && ackable(i) && (!eventAt(i) || String(a.acked_at) >= String(eventAt(i)))
      if (ackOk && (!lastAck || String(a.acked_at) > String(lastAck.acked_at))) lastAck = a
      if (ackOk || (settled && !AFTER_SETTLE_ISSUES.has(i))) acked.push(i)
      else open.push(i)
    }
    const payeeType = r.payee_type || 'payroll'
    const payeeName = payeeType === 'partner' ? (r.payee_affiliation_name || r.affiliation || '取引先') : payeeType === 'linked' ? (r.payee_company_name || '連携元')
      : payeeType === 'freelance' ? r.staff_name : PAYEE_LABEL[payeeType] || payeeType
    const closing = closingOf(closings, String(r.work_date))
    const row = {
      shift_id: r.shift_id, work_date: r.work_date, client_id: r.client_id, client_name: r.client_name || '', project_id: r.project_id, project_name: r.project_name,
      site_name: r.site_name || r.location || '', role: r.role || '', staff_id: r.staff_id, staff_name: r.staff_name, employee_number: r.employee_number || '',
      affiliation_type: r.affiliation_type || 'own_employee', status: r.status,
      // break_minutes = 予定の休憩、used_break_minutes = 実働の計算に使った休憩（実績の休憩があればその値）
      start_time: r.start_time, end_time: r.end_time, break_minutes: h.planned_break_minutes, used_break_minutes: h.break_minutes, actual_start: r.actual_start, actual_end: r.actual_end,
      actual_break_minutes: r.actual_break_minutes, actual_source: r.actual_source, actual_note: r.actual_note,
      planned_hours: h.planned_hours, actual_hours: h.actual_hours, hours: h.hours, pay_hours: h.pay_hours, hours_basis: h.basis,
      bill_unit_type: r.bill_unit_type || 'daily', bill_rate: r.bill_rate, bill_qty: r.bill_qty, bill_base: Number(r.unit_price || 0), bill_transport: t.bill_transport, bill_adjust: Number(r.bill_adjust || 0), bill_total: t.bill_total,
      pay_unit_type: r.pay_unit_type || 'daily', pay_rate: r.pay_rate, pay_qty: r.pay_qty, pay_base: r.pay_amount == null ? null : Number(r.pay_amount), pay_transport: t.pay_transport, pay_adjust: Number(r.pay_adjust || 0), pay_total: t.pay_total,
      transportation_fee: Number(r.transportation_fee || 0), adjust_note: r.adjust_note || '',
      bill_transport_type: r.bill_transport_type || 'actual', bill_transport_amount: Number(r.bill_transport_amount || 0), pay_transport_type: r.pay_transport_type || 'actual', pay_transport_amount: Number(r.pay_transport_amount || 0),
      payee_type: payeeType, payee_label: PAYEE_LABEL[payeeType] || payeeType, payee_name: payeeName, payee_key: `${payeeType}:${payeeType === 'partner' ? (r.payee_affiliation_id || r.affiliation || '') : payeeType === 'linked' ? (r.payee_company_id || '') : payeeType === 'freelance' ? r.staff_id : ''}`,
      price_locked: !!r.price_locked, qty_locked: qtyFixed(r), settle_status: settled ? 'confirmed' : 'planned', settled_at: r.settled_at,
      has_check_in: hasIn, has_check_out: hasOut, has_end_report: hasOut || !!at('work_end'), has_daily: !!r.has_daily,
      // attendance_off: 入店・退店などの報告を使わない設定のシフト（実績は予定の時間で計算する）。daily_required: 日報が必要なシフト
      attendance_off: !startOn && !endOn, daily_required: dailyRequired,
      // issues = 確認が必要な事項、acked_issues = 確認済みの事項（件数・確定前の警告に数えない）
      pending_corrections: Number(r.pending_corrections || 0), pending_pay_requests: Number(r.pending_pay_requests || 0), issues: open, acked_issues: acked,
      acked_at: lastAck ? lastAck.acked_at as string : null, acked_by_name: lastAck ? (lastAck.acked_by_name || '') as string : null,
      // kind: work = 勤務、cancel = 欠勤・中止のキャンセル料・補償（#283）。closed: 締めた期間のシフト（#170）
      kind: (cancel ? 'cancel' : 'work') as 'cancel' | 'work', cancel_reason: cancel ? String(r.cx_reason) : null, cancel_notified_on: cancel ? (r.cx_notified_on as string | null) : null,
      closed: !!closing, closing_id: closing ? closing.closing_id : null,
    }
    if (!cancel) return row
    // 欠勤・中止: 金額は shift_cancellations の値（未入力は 0）。時間・単価・交通費は使わない
    const bill = r.cx_bill == null ? 0 : Number(r.cx_bill), pay = r.cx_pay == null ? 0 : Number(r.cx_pay)
    return {
      ...row, actual_start: null, actual_end: null, actual_hours: null, hours: 0, pay_hours: 0,
      bill_rate: null, bill_qty: null, bill_base: bill, bill_transport: 0, bill_adjust: 0, bill_total: bill,
      pay_rate: null, pay_qty: null, pay_base: pay, pay_transport: 0, pay_adjust: 0, pay_total: pay, transportation_fee: 0,
      adjust_note: String(r.cx_note || ''), price_locked: false, qty_locked: false,
    }
  })
  return out
}
type Row = Awaited<ReturnType<typeof loadRows>>[number]

// 支払集計のまとめ方（自社給与・日雇い給与はスタッフごと、それ以外は支払先ごと）。支払明細書（#168）の宛先の指定にも使う
const payeeGroupKey = (r: Row) => (r.payee_type === 'payroll' || r.payee_type === 'payroll_daily' ? `${r.payee_type}:staff${r.staff_id}` : r.payee_key) as string
// 粗利は支払が決まっている行だけで計算する（profit_bill = その行の請求額）。支払単価が未設定の行は件数と請求額を pay_unset* に出す
function summarize(rows: Row[]) {
  const sum = (a: Row[], k: keyof Row) => a.reduce((n, r) => n + Number((r as any)[k] || 0), 0)
  const group = <K extends string>(keyFn: (r: Row) => K) => {
    const m = new Map<K, Row[]>(); for (const r of rows) { const k = keyFn(r); m.set(k, [...(m.get(k) || []), r]) } return m
  }
  const profitOf = (a: Row[]) => {
    const paid = a.filter(r => r.pay_total != null), unset = a.filter(r => r.pay_total == null)
    const profitBill = sum(paid, 'bill_total')
    return { profit: paid.length ? profitBill - sum(paid, 'pay_total') : null, profit_bill: profitBill, pay_unset: unset.length, pay_unset_bill: sum(unset, 'bill_total') }
  }
  const totals = {
    shifts: rows.length, bill: sum(rows, 'bill_total'), pay: sum(rows, 'pay_total'),
    // issues = 未確定で確認が必要なシフト、settled_issues = 確定後に対応が必要になったシフト（確認済みの事項は数えない。#563）
    confirmed: rows.filter(r => r.settle_status === 'confirmed').length, issues: rows.filter(r => r.settle_status !== 'confirmed' && r.issues.length).length,
    settled_issues: rows.filter(r => r.settle_status === 'confirmed' && r.issues.length).length,
    recalc: rows.filter(r => r.issues.includes(RECALC_ISSUE)).length,
    // 欠勤・中止のキャンセル料・補償（#283。請求・支払の合計に含む）
    cancel_shifts: rows.filter(r => r.kind === 'cancel').length,
    cancel_bill: sum(rows.filter(r => r.kind === 'cancel'), 'bill_total'), cancel_pay: sum(rows.filter(r => r.kind === 'cancel'), 'pay_total'),
    ...profitOf(rows),
  }
  const by_client = [...group(r => `${r.client_id || 0}:${r.project_id}` as string)].map(([, a]) => ({
    client_id: a[0].client_id, client_name: a[0].client_name, project_id: a[0].project_id, project_name: a[0].project_name,
    shifts: a.length, staff: new Set(a.map(r => r.staff_id)).size, hours: Math.round(sum(a, 'hours') * 100) / 100,
    bill_base: sum(a, 'bill_base'), bill_transport: sum(a, 'bill_transport'), bill_adjust: sum(a, 'bill_adjust'), bill_total: sum(a, 'bill_total'),
    pay_total: sum(a, 'pay_total'), ...profitOf(a), confirmed: a.filter(r => r.settle_status === 'confirmed').length,
  })).sort((x, y) => (x.client_name || '').localeCompare(y.client_name || '', 'ja') || x.project_name.localeCompare(y.project_name, 'ja'))
  const by_payee = [...group(payeeGroupKey)].map(([key, a]) => ({
    group_key: key, payee_type: a[0].payee_type, payee_label: a[0].payee_label, payee_name: a[0].payee_name,
    staff_id: a[0].payee_type === 'partner' || a[0].payee_type === 'linked' ? null : a[0].staff_id,
    staff_name: a[0].payee_type === 'partner' || a[0].payee_type === 'linked' ? [...new Set(a.map(r => r.staff_name))].join('、') : a[0].staff_name,
    employee_number: a[0].payee_type === 'payroll' || a[0].payee_type === 'payroll_daily' ? a[0].employee_number : '',
    shifts: a.length, days: new Set(a.map(r => `${r.staff_id}:${r.work_date}`)).size, hours: Math.round(sum(a, 'pay_hours') * 100) / 100,
    pay_base: sum(a, 'pay_base'), pay_transport: sum(a, 'pay_transport'), pay_adjust: sum(a, 'pay_adjust'), pay_total: sum(a, 'pay_total'),
    pay_unset: a.filter(r => r.pay_total == null).length, confirmed: a.filter(r => r.settle_status === 'confirmed').length,
  })).sort((x, y) => x.payee_type.localeCompare(y.payee_type) || x.payee_name.localeCompare(y.payee_name, 'ja') || (x.staff_name || '').localeCompare(y.staff_name || '', 'ja'))
  return { totals, by_client, by_payee }
}

app.get('/settlement', async (c) => {
  const u = c.get('user')
  const f = parseFilters(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  let rows = await loadRows(c.env.DB, u.company_id, f)
  // 上限は絞り込み（確認事項のみ）の前の件数で判定する
  const truncated = rows.length > MAX_ROWS
  if (truncated) rows = rows.slice(0, MAX_ROWS)
  const summary = summarize(rows)
  if (f.issues_only) rows = rows.filter(r => r.issues.length)
  const [tentative, absent, staffOptions, closings] = await Promise.all([loadTentativeReported(c.env.DB, u.company_id, f), loadAbsentUnhandled(c.env.DB, u.company_id, f),
    loadStaffOptions(c.env.DB, u.company_id, f), loadClosings(c.env.DB, u.company_id, f.from, f.to)])
  return c.json({ from: f.from, to: f.to, rows, ...summary, truncated, max_rows: MAX_ROWS, tentative_reported: tentative,
    absent_shifts: absent, staff_options: staffOptions, closings, can_reopen: u.role === 'company_admin' })
})

// 絞り込みの選択肢: 期間内に精算の対象（確定・代打・欠勤）のシフトがあるスタッフ（#168。スタッフの絞り込みは外して数える）
async function loadStaffOptions(db: D1Database, companyId: number, f: Filters) {
  return (await db.prepare(`SELECT DISTINCT s.staff_id, us.name AS staff_name, er.employee_number FROM shifts s
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id LEFT JOIN employee_records er ON er.staff_id = s.staff_id
    WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? AND s.status IN ('confirmed','substitute','absent') ORDER BY us.name, s.staff_id LIMIT 2000`)
    .bind(companyId, f.from, f.to).all()).results as any[]
}

// キャンセル料・補償をまだ入れていない欠勤のシフト（#283）。精算の対象ではないが、ここから金額を入れると対象になる。上限 TENTATIVE_MAX 件
async function loadAbsentUnhandled(db: D1Database, companyId: number, f: Filters) {
  if (f.settle === 'confirmed') return []
  const w = ["s.company_id = ?", "s.status = 'absent'", 's.work_date BETWEEN ? AND ?', 'NOT EXISTS (SELECT 1 FROM shift_cancellations sc WHERE sc.shift_id = s.shift_id)']
  const bind: any[] = [companyId, f.from, f.to]
  if (f.client_id) { w.push('p.client_id = ?'); bind.push(f.client_id) }
  if (f.project_id) { w.push('s.project_id = ?'); bind.push(f.project_id) }
  if (f.staff_id) { w.push('s.staff_id = ?'); bind.push(f.staff_id) }
  if (f.payee_type) { w.push("COALESCE(s.payee_type,'payroll') = ?"); bind.push(f.payee_type) }
  return (await db.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.absent_at, s.staff_id, us.name AS staff_name, p.project_name, cl.client_name
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE ${w.join(' AND ')} ORDER BY s.work_date, s.start_time LIMIT ${TENTATIVE_MAX}`).bind(...bind).all()).results as any[]
}

// 勤怠報告のある希望（仮）のシフト（#19 の続き）。精算の対象（確定・代打）ではないため一覧と金額には出ないが、
// 働いた分の請求・支払が漏れないよう、確定（または欠勤）にするよう知らせる。上限 TENTATIVE_MAX 件
const TENTATIVE_MAX = 200
async function loadTentativeReported(db: D1Database, companyId: number, f: Filters) {
  if (f.settle === 'confirmed') return []
  const w = ["s.company_id = ?", "s.status != 'absent'", 's.work_date BETWEEN ? AND ?', 'EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id)']
  const bind: any[] = [companyId, f.from, f.to]
  if (f.client_id) { w.push('p.client_id = ?'); bind.push(f.client_id) }
  if (f.project_id) { w.push('s.project_id = ?'); bind.push(f.project_id) }
  if (f.staff_id) { w.push('s.staff_id = ?'); bind.push(f.staff_id) }
  if (f.payee_type) { w.push("COALESCE(s.payee_type,'payroll') = ?"); bind.push(f.payee_type) }
  const rows = (await db.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.staff_id, us.name AS staff_name, p.project_name, cl.client_name,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS report_count
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE ${w.join(' AND ')} AND s.status NOT IN (${WORK_STATUSES.map(() => '?').join(',')})
    ORDER BY s.work_date, s.start_time LIMIT ${TENTATIVE_MAX}`).bind(...bind, ...WORK_STATUSES).all()).results as any[]
  return rows.filter(r => !isWorkingShift(r.status)).map(r => ({
    shift_id: r.shift_id, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time, status: r.status,
    staff_id: r.staff_id, staff_name: r.staff_name, project_name: r.project_name, client_name: r.client_name || '', report_count: Number(r.report_count || 0),
  }))
}

// ---------- 実績の反映（入店・退店報告から）----------
// 対象のシフトを SYNC_PAGE 件ずつ、報告と一緒にまとめて読み、計算はメモリ上で行い、変わったシフトだけを db.batch でまとめて書く
// （規則は1件ずつの syncActualFromReports・refreshShiftAmounts と同じ。D1 の1回の実行あたりの問い合わせ数の上限に達しないように）。
// 1回の呼び出しで SYNC_PAGE × SYNC_MAX_PAGES 件まで確認し、残りがあれば next_cursor（最後に確認した shift_id）を返す。cursor に渡すと続きから確認する
const SYNC_PAGE = 2000
const SYNC_MAX_PAGES = 10
// 報告から実績を求める規則は actualFromReports、金額は amountsForActual（syncActualFromReports・refreshShiftAmounts と共用）
app.post('/settlement/sync-actuals', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const f = parseFilters(k => (b[k] != null ? String(b[k]) : undefined))
  if ('error' in f) return c.json({ error: f.error }, 400)
  let after = Math.max(0, Math.floor(Number(b.cursor) || 0))
  let checked = 0, updated = 0, more = false
  // 読み込みの後に確定・手入力されたシフトは書き換えない
  const guard = "shifts.company_id = ? AND COALESCE(shifts.settle_status,'planned') != 'confirmed' AND COALESCE(shifts.actual_source,'') != 'manual'"
  const actualCols = ['actual_start', 'actual_end', 'actual_break_minutes', 'actual_source']
  // 締めた期間のシフトは反映しない（#170）
  const closings = await loadClosings(db, u.company_id, f.from, f.to)
  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const rows = (await db.prepare(`SELECT s.*, p.hours_basis, p.time_round_minutes, p.pay_time_round, p.default_break_minutes FROM shifts s JOIN projects p ON p.project_id = s.project_id
      WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? AND COALESCE(s.settle_status,'planned') != 'confirmed' AND COALESCE(s.actual_source,'') != 'manual'
        ${f.project_id ? 'AND s.project_id = ?' : ''} ${f.client_id ? 'AND p.client_id = ?' : ''} AND s.shift_id > ? ORDER BY s.shift_id LIMIT ?`)
      .bind(u.company_id, f.from, f.to, ...(f.project_id ? [f.project_id] : []), ...(f.client_id ? [f.client_id] : []), after, SYNC_PAGE + 1).all()).results as any[]
    const part = rows.slice(0, SYNC_PAGE)
    if (!part.length) break
    const reps = (await db.prepare(`SELECT shift_id, report_type, reported_at FROM attendance_reports
      WHERE shift_id IN ${JSON_IN} AND report_type IN (SELECT value FROM json_each(?)) ORDER BY shift_id, attendance_id`)
      .bind(bindJsonArray(part.map(s => s.shift_id)), JSON.stringify(ACTUAL_REPORT_TYPES)).all()).results as any[]
    const repsBy = new Map<number, any[]>()
    for (const r of reps) { const a = repsBy.get(r.shift_id) || []; a.push(r); repsBy.set(r.shift_id, a) }
    const actualOnly: any[] = [], withAmounts: any[] = []
    for (const s of part) {
      if (closingOf(closings, String(s.work_date))) continue
      const reps1 = repsBy.get(s.shift_id) || []
      const { start, end, brk } = actualFromReports(t => reps1.find(r => r.report_type === t)?.reported_at as string | undefined)
      if (start === (s.actual_start || null) && end === (s.actual_end || null) && brk === (s.actual_break_minutes ?? null)) continue
      const row = { shift_id: s.shift_id, actual_start: start, actual_end: end, actual_break_minutes: brk, actual_source: start || brk != null ? 'report' : null }
      const amt = amountsForActual({ ...s, ...row }, s)
      if (amt) withAmounts.push({ ...row, ...amt }); else actualOnly.push(row)
    }
    const res = await batchInChunks(db, [
      ...updateRowsStmts(db, 'shifts', 'shift_id', actualCols, actualOnly, guard, [u.company_id]),
      ...updateRowsStmts(db, 'shifts', 'shift_id', [...actualCols, 'bill_qty', 'unit_price', 'pay_qty', 'pay_amount'], withAmounts, guard, [u.company_id]),
    ])
    checked += part.length; updated += changesOf(res); after = part[part.length - 1].shift_id
    more = rows.length > SYNC_PAGE
    if (!more) break
  }
  return c.json({ ok: true, checked, updated, next_cursor: more ? after : null })
})

// ---------- 実績の手入力 ----------
app.put('/shifts/:id/actual', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (isSettled(s)) return c.json({ error: '確定済みのシフトです。確定を取り消してから変更してください' }, 409)
  const closed = await closedMessage(db, u.company_id, s.work_date)
  if (closed) return c.json({ error: closed }, 409)
  if (s.status === 'absent') return c.json({ error: '欠勤のシフトには実績を入力できません（キャンセル料・補償は欠勤の欄から入力してください）' }, 400)
  if (b.reset) {
    // 報告の時刻に戻す
    await db.prepare('UPDATE shifts SET actual_start = NULL, actual_end = NULL, actual_break_minutes = NULL, actual_source = NULL, actual_note = NULL WHERE shift_id = ?').bind(s.shift_id).run()
    await syncActualFromReports(db, u.company_id, s.shift_id)
    await refreshShiftAmounts(db, u.company_id, s.shift_id)
    return c.json({ ok: true })
  }
  if (!isTime(b.actual_start) || !isTime(b.actual_end)) return c.json({ error: '開始・終了の時刻を入力してください' }, 400)
  const brk = b.actual_break_minutes === '' || b.actual_break_minutes == null ? null : intOrNull(b.actual_break_minutes)
  if (brk != null && (brk < 0 || brk > 600)) return c.json({ error: '休憩は0〜600分で入力してください' }, 400)
  await db.prepare("UPDATE shifts SET actual_start = ?, actual_end = ?, actual_break_minutes = ?, actual_source = 'manual', actual_note = ? WHERE shift_id = ?")
    .bind(b.actual_start, b.actual_end, brk, (b.actual_note || '').slice(0, 200) || null, s.shift_id).run()
  await refreshShiftAmounts(db, u.company_id, s.shift_id)
  // 実績の時刻・休憩が変わったら、本人に知らせる（#274。メモは社内の記録のため通知に入れない）
  if (b.actual_start !== s.actual_start || b.actual_end !== s.actual_end || brk !== (s.actual_break_minutes ?? null)) {
    await notifyShiftStaff(db, s, 'actual_entered', `管理者が勤務の実績を入力しました: ${mdText(s.work_date)}`,
      [`実績: ${b.actual_start}〜${b.actual_end}${brk != null ? `（休憩${brk}分）` : ''}`, `入力した人: ${u.name || '管理者'}`,
        '時給の計算にはこの時刻を使います。違っている場合は、相談・連絡から管理者に伝えてください'].join('\n'), `#pay/${String(s.work_date).slice(0, 7)}`, s.shift_id)
  }
  return c.json({ ok: true })
})

// ---------- 確定・取り消し ----------
// 対象の指定は shift_ids（画面に表示中・選択中のシフト）が基本。条件での指定は API の互換のために残し、
// 確認事項のみ（issues_only）の絞り込みも画面と同じに効かせる。上限を超えるときは一部だけを処理せずに断る
async function targetRows(db: D1Database, companyId: number, b: any): Promise<{ rows: Row[]; error?: string }> {
  if (Array.isArray(b.shift_ids)) {
    const ids = [...new Set(b.shift_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
    if (!ids.length) return { rows: [], error: 'シフトを選択してください' }
    if (ids.length > MAX_ROWS) return { rows: [], error: `一度に処理できるのは${MAX_ROWS}件までです` }
    return { rows: await loadRowsByIds(db, companyId, ids) }
  }
  const f = parseFilters(k => (b[k] != null ? String(b[k]) : undefined))
  if ('error' in f) return { rows: [], error: f.error }
  const rows = await loadRows(db, companyId, f)
  if (rows.length > MAX_ROWS) return { rows: [], error: `対象が${MAX_ROWS}件を超えています。期間や条件を絞ってください` }
  return { rows: f.issues_only ? rows.filter(r => r.issues.length) : rows }
}
// 確定できる状態か。稼働日が今日以前で、勤務が終わっていること
//   退店（勤務終了）の報告がある、実績を手入力している、または稼働日が昨日以前で予定の終了（日をまたぐ勤務は翌日）を過ぎている
//   当日の勤務中に確定すると、その後の勤務終了・退店の報告が実績に入らないため
function finishedForSettle(r: Row, now: string) {
  const today = now.slice(0, 10)
  if (r.work_date > today) return false
  // 欠勤・中止のキャンセル料・補償は、稼働日が来れば確定できる
  if (r.kind === 'cancel') return true
  if (r.has_end_report || (r.actual_source === 'manual' && r.actual_start)) return true
  return r.work_date < today && shiftWindow(r.work_date, r.start_time, r.end_time).end <= now
}
app.post('/settlement/confirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const t = await targetRows(db, u.company_id, b)
  if (t.error) return c.json({ error: t.error }, 400)
  const rows = t.rows
  const now = nowJST(), today = now.slice(0, 10)
  // 締めた期間のシフトは確定しない（締めたときの合計を変えないため。#170）
  const closed = rows.filter(r => r.settle_status !== 'confirmed' && r.closed)
  const targets = rows.filter(r => r.settle_status !== 'confirmed' && !r.closed)
  const future = targets.filter(r => r.work_date > today)
  const inProgress = targets.filter(r => r.work_date <= today && !finishedForSettle(r, now))
  const ok = targets.filter(r => finishedForSettle(r, now))
  const withIssues = ok.filter(r => r.issues.length)
  const paid = ok.filter(r => r.pay_total != null)
  if (b.dry_run) return c.json({ target: rows.length, count: ok.length, with_issues: withIssues.length, future: future.length, in_progress: inProgress.length, closed: closed.length, already: rows.length - targets.length - closed.length,
    bill: ok.reduce((n, r) => n + r.bill_total, 0), pay: paid.reduce((n, r) => n + Number(r.pay_total), 0), pay_unset: ok.length - paid.length })
  if (withIssues.length && !b.force) return c.json({ error: `確認が必要なシフトが ${withIssues.length} 件あります`, need_force: true, with_issues: withIssues.length }, 409)
  let confirmed = 0
  for (const part of chunk(ok.map(r => r.shift_id), 500)) {
    const r = await db.prepare(`UPDATE shifts SET settle_status = 'confirmed', settled_at = ?, settled_by = ?
      WHERE company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed' AND shift_id IN ${JSON_IN}`)
      .bind(now, u.user_id, u.company_id, bindJsonArray(part)).run()
    confirmed += r.meta.changes || 0
  }
  // 『確認済みとして確定する』で確定した確認事項は、確認済みとして記録する（確定を取り消した後も、同じ事項なら確認済みのまま。#563）
  if (withIssues.length) await saveAcks(db, u.company_id, u.user_id, withIssues, now)
  return c.json({ ok: true, confirmed, skipped_future: future.length, skipped_in_progress: inProgress.length, skipped_closed: closed.length })
})
app.post('/settlement/unconfirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const t = await targetRows(db, u.company_id, b)
  if (t.error) return c.json({ error: t.error }, 400)
  // 締めた期間の確定は取り消せない（一部だけを取り消さずに断る。#170）
  const closedRows = t.rows.filter(r => r.settle_status === 'confirmed' && r.closed)
  if (closedRows.length) return c.json({ error: `締めた期間のシフトが ${closedRows.length}件 含まれているため、確定を取り消せません。取り消すには、先に締めを解除してください`, closed: closedRows.length }, 409)
  const ids: number[] = []
  for (const part of chunk(t.rows.filter(r => r.settle_status === 'confirmed').map(r => r.shift_id), 500)) {
    const r = await db.prepare(`UPDATE shifts SET settle_status = 'planned', settled_at = NULL, settled_by = NULL
      WHERE company_id = ? AND settle_status = 'confirmed' AND shift_id IN ${JSON_IN} RETURNING shift_id`)
      .bind(u.company_id, bindJsonArray(part)).all()
    ids.push(...(r.results as any[]).map(x => Number(x.shift_id)))
  }
  // 確定中に承認した打刻修正や、確定の後の報告を、取り消しと同時に実績・金額へ反映する（手入力の実績は変えない）
  const synced = ids.length ? await syncActualsForShifts(db, u.company_id, ids) : 0
  return c.json({ ok: true, unconfirmed: ids.length, synced })
})
async function loadRowsByIds(db: D1Database, companyId: number, ids: number[]) {
  const out: Row[] = []
  const blank: Filters = { from: '', to: '', client_id: null, project_id: null, staff_id: null, payee_type: '', settle: '', issues_only: false }
  for (const part of chunk(ids, 1000)) out.push(...await loadRows(db, companyId, blank, part))
  return out
}

// ---------- 確認済み（#563） ----------
// rows の今の確認事項（承認待ちの打刻修正を除く）を確認済みとして記録する。同じ事項を確認し直したときは日時を新しくする
async function saveAcks(db: D1Database, companyId: number, userId: number, rows: Row[], now: string) {
  const items = rows.flatMap(r => r.issues.filter(ackable).map(issue => ({ shift_id: r.shift_id, issue })))
  const stmts = chunk(items, 100).map(part => db.prepare(`INSERT INTO settlement_issue_acks (company_id, shift_id, issue, acked_by, acked_at)
      SELECT ?, json_extract(value, '$.shift_id'), json_extract(value, '$.issue'), ?, ? FROM json_each(?) WHERE true
      ON CONFLICT(shift_id, issue) DO UPDATE SET acked_by = excluded.acked_by, acked_at = excluded.acked_at`)
    .bind(companyId, userId, now, JSON.stringify(part)))
  return changesOf(await batchInChunks(db, stmts))
}
// shift_ids のシフトの確認事項を確認済みにする（undo: true で確認済みを取り消す）
app.post('/settlement/acks', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const ids = [...new Set((Array.isArray(b.shift_ids) ? b.shift_ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
  if (!ids.length) return c.json({ error: 'シフトを選択してください' }, 400)
  if (ids.length > MAX_ROWS) return c.json({ error: `一度に処理できるのは${MAX_ROWS}件までです` }, 400)
  if (b.undo) {
    let removed = 0
    for (const part of chunk(ids, 1000)) {
      removed += (await db.prepare(`DELETE FROM settlement_issue_acks WHERE company_id = ? AND shift_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(part)).run()).meta.changes || 0
    }
    return c.json({ ok: true, removed })
  }
  const rows = (await loadRowsByIds(db, u.company_id, ids)).filter(r => r.issues.some(ackable))
  const acked = await saveAcks(db, u.company_id, u.user_id, rows, nowJST())
  return c.json({ ok: true, shifts: rows.length, acked })
})

// ---------- 金額の再計算（#79） ----------
// 確認事項『数量・金額が今の計算と違う』のシフトを、今の案件の時間の設定で計算し直す（amountsForActual。単価ルールは再適用しない）。
// 確定済みのシフトと、手動で数量も固定したシフト（qtyFixed）は変えない。単価だけを固定したもの（qty_locked = 0）は時給の数量を合わせる（#196）
app.post('/settlement/recalc', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const ids = [...new Set((Array.isArray(b.shift_ids) ? b.shift_ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
  if (!ids.length) return c.json({ error: 'シフトを選択してください' }, 400)
  if (ids.length > MAX_ROWS) return c.json({ error: `一度に処理できるのは${MAX_ROWS}件までです` }, 400)
  const changed: Record<string, any>[] = []
  let checked = 0
  for (const part of chunk(ids, 1000)) {
    const rows = (await db.prepare(`SELECT s.*, p.hours_basis, p.time_round_minutes, p.pay_time_round, p.default_break_minutes FROM shifts s JOIN projects p ON p.project_id = s.project_id
      WHERE s.company_id = ? AND s.shift_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(part)).all()).results as any[]
    const dates = rows.map(s => String(s.work_date)).sort()
    const closings = dates.length ? await loadClosings(db, u.company_id, dates[0], dates[dates.length - 1]) : []
    for (const s of rows) {
      checked++
      if (s.status === 'absent' || closingOf(closings, String(s.work_date))) continue
      const amt = amountsForActual(s, s)
      if (!amt || !(numDiff(amt.bill_qty, s.bill_qty) || numDiff(amt.unit_price, s.unit_price) || numDiff(amt.pay_qty, s.pay_qty) || numDiff(amt.pay_amount, s.pay_amount))) continue
      changed.push({ shift_id: s.shift_id, ...amt })
    }
  }
  const res = await batchInChunks(db, updateRowsStmts(db, 'shifts', 'shift_id', ['bill_qty', 'unit_price', 'pay_qty', 'pay_amount'], changed,
    "shifts.company_id = ? AND COALESCE(shifts.settle_status,'planned') != 'confirmed' AND (COALESCE(shifts.price_locked, 0) = 0 OR shifts.qty_locked = 0)", [u.company_id]))
  return c.json({ ok: true, checked, updated: changesOf(res) })
})

// ---------- CSV ----------
// csvCell / toCsv は src/csv.ts（UTF-8 BOM 付き・CRLF・数式インジェクション対策）
const UNIT_LABEL: Record<string, string> = { daily: '日額', hourly: '時給' }

app.get('/settlement/export', async (c) => {
  const u = c.get('user')
  const f = parseFilters(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const kind = c.req.query('kind') || 'detail'
  const all = await loadRows(c.env.DB, u.company_id, f)
  // 上限を超えた分を黙って落とさない（請求・給与計算に使うため）
  if (all.length > MAX_ROWS) return c.json({ error: `対象が${MAX_ROWS}件を超えるため出力できません。期間や条件を絞ってください` }, 400)
  // 集計（請求・支払）は画面と同じく全件、明細は「確認が必要なもののみ」の絞り込みを反映する
  const { by_client, by_payee } = summarize(all)
  const rows = f.issues_only ? all.filter(r => r.issues.length) : all
  let csv = '', name = ''
  if (kind === 'billing') {
    name = `請求集計_${f.from}_${f.to}.csv`
    csv = toCsv(['クライアント', '案件', 'シフト数', 'スタッフ数', '時間', '請求基本額', '交通費', '調整', '請求合計', '確定数'],
      by_client.map(g => [g.client_name, g.project_name, g.shifts, g.staff, g.hours, g.bill_base, g.bill_transport, g.bill_adjust, g.bill_total, g.confirmed]))
  } else if (kind === 'payment') {
    // 社員番号は Excel で数値・日付に変わらないよう文字として出す（#571）。スタッフID は既存の列の位置を変えないよう末尾に足す
    name = `支払集計_${f.from}_${f.to}.csv`
    csv = toCsv(['支払区分', '支払先', 'スタッフ', '社員番号', '稼働日数', 'シフト数', '時間', '支払基本額', '交通費', '調整', '支払合計', '単価未設定', '確定数', 'スタッフID'],
      by_payee.map(g => [g.payee_label, g.payee_name, g.staff_name, g.employee_number, g.days, g.shifts, g.hours, g.pay_base, g.pay_transport, g.pay_adjust, g.pay_total ?? '', g.pay_unset, g.confirmed, g.staff_id ?? '']), { textCols: ['社員番号'] })
  } else {
    name = `シフト明細_${f.from}_${f.to}${f.issues_only ? '_確認が必要なもののみ' : ''}.csv`
    csv = toCsv(['シフトID', '日付', 'クライアント', '案件', '開催場所', '役割', 'スタッフ', '社員番号', '支払区分', '支払先',
      '予定開始', '予定終了', '予定休憩(分)', '実績開始', '実績終了', '実績休憩(分)', '実績の入力', '予定時間', '実働時間', '計算時間',
      '請求単位', '請求単価', '請求数量', '請求基本額', '請求交通費', '請求調整', '請求合計',
      '支払単位', '支払単価', '支払数量', '支払基本額', '交通費実費', '支払交通費', '支払調整', '支払合計', '調整メモ', '確定', '確認事項', 'スタッフID'],
      rows.map(r => [r.shift_id, r.work_date, r.client_name, r.project_name, r.site_name, r.role, r.staff_name, r.employee_number, r.payee_label, r.payee_name,
        r.start_time, r.end_time, r.break_minutes, r.actual_start || '', r.actual_end || '', r.actual_start ? r.used_break_minutes : '',
        // 欠勤・中止のキャンセル料・補償の行は『実績の入力』に理由を出す（列の並びは変えない。#283）
        r.kind === 'cancel' ? `キャンセル（${CANCEL_REASON_LABEL[r.cancel_reason || ''] || ''}）` : r.actual_source === 'manual' ? '手入力' : r.actual_source === 'report' ? '報告' : '',
        r.planned_hours, r.actual_hours ?? '', r.hours,
        UNIT_LABEL[r.bill_unit_type] || r.bill_unit_type, r.bill_rate ?? '', r.bill_qty ?? '', r.bill_base, r.bill_transport, r.bill_adjust, r.bill_total,
        UNIT_LABEL[r.pay_unit_type] || r.pay_unit_type, r.pay_rate ?? '', r.pay_qty ?? '', r.pay_base ?? '', r.transportation_fee, r.pay_transport, r.pay_adjust, r.pay_total ?? '', r.adjust_note,
        r.settle_status === 'confirmed' ? '確定' : '未確定', r.issues.join(' / '), r.staff_id]), { textCols: ['社員番号'] })
  }
  await logExport(c.env.DB, u, kind, f, kind === 'billing' ? by_client.length : kind === 'payment' ? by_payee.length : rows.length)
  return new Response(csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="settlement.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  } })
})

// CSV・明細書を出力した記録（#170。いつ・だれが・どの期間を出したか）。記録に失敗しても出力は止めない
async function logExport(db: D1Database, u: any, kind: string, f: Filters, rowCount: number, extra: Record<string, any> = {}) {
  const filters = { client_id: f.client_id, project_id: f.project_id, staff_id: f.staff_id, payee_type: f.payee_type || null, settle: f.settle || null, issues_only: f.issues_only || null, ...extra }
  await db.prepare(`INSERT INTO settlement_export_logs (company_id, kind, period_from, period_to, filters_json, row_count, exported_by, exported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, kind, f.from, f.to, JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null))), rowCount, u.user_id, nowJST()).run().catch(() => {})
}

// ---------- 絞り込みの選択肢（#494） ----------
// 精算画面を開くたびに取り直す（後から登録した案件・クライアントも選べるように）。締め日（#168）も返す
app.get('/settlement/options', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const [cl, pj] = await db.batch([
    db.prepare('SELECT client_id, client_name, billing_rule, billing_closing_day FROM clients WHERE company_id = ? ORDER BY client_name, client_id').bind(u.company_id),
    db.prepare("SELECT project_id, project_name, client_id, status FROM projects WHERE company_id = ? ORDER BY CASE WHEN COALESCE(status, 'active') = 'active' THEN 0 ELSE 1 END, project_name, project_id").bind(u.company_id),
  ])
  return c.json({ clients: cl.results, projects: pj.results })
})

// ---------- クライアントの締め日（#168） ----------
// day: 1〜31（31 = 月末）。空欄で未設定（暦月）に戻す
app.put('/settlement/clients/:id/closing-day', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const cl = await ownClient(c.env.DB, u.company_id, c.req.param('id'))
  if (!cl) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const day = intOrNull(b.day)
  if (b.day !== '' && b.day != null && (day == null || day < 1 || day > 31)) return c.json({ error: '締め日は1〜31（31 = 月末）で入力してください' }, 400)
  await c.env.DB.prepare('UPDATE clients SET billing_closing_day = ? WHERE client_id = ? AND company_id = ?').bind(day, cl.client_id, u.company_id).run()
  return c.json({ ok: true, billing_closing_day: day })
})

// ---------- 締め（#170） ----------
app.get('/settlement/closings', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const [cl, ex] = await db.batch([
    db.prepare(`SELECT k.*, cu.name AS closed_by_name, ru.name AS reopened_by_name FROM settlement_closings k
      LEFT JOIN users cu ON cu.user_id = k.closed_by LEFT JOIN users ru ON ru.user_id = k.reopened_by
      WHERE k.company_id = ? ORDER BY k.period_from DESC, k.closing_id DESC LIMIT 50`).bind(u.company_id),
    db.prepare(`SELECT l.log_id, l.kind, l.period_from, l.period_to, l.filters_json, l.row_count, l.exported_at, us.name AS exported_by_name FROM settlement_export_logs l
      LEFT JOIN users us ON us.user_id = l.exported_by WHERE l.company_id = ? ORDER BY l.exported_at DESC, l.log_id DESC LIMIT 30`).bind(u.company_id),
  ])
  return c.json({ closings: cl.results, exports: ex.results, can_reopen: u.role === 'company_admin' })
})
// 期間を締める。期間内の精算の対象（確定・代打・キャンセル料を入れた欠勤）がすべて確定済みのときだけ締められる。
// 確定後に対応が必要な事項（確定後の打刻修正など）があるときは、確認してから force で締める
app.post('/settlement/closings', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const f = parseFilters(k => ((k === 'from' || k === 'to') && b[k] != null ? String(b[k]) : undefined))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const overlap = await loadClosings(db, u.company_id, f.from, f.to)
  if (overlap.length) return c.json({ error: `${overlap[0].period_from}〜${overlap[0].period_to} がすでに締められています（期間が重なっています）` }, 409)
  const rows = await loadRows(db, u.company_id, f)
  if (rows.length > MAX_ROWS) return c.json({ error: `対象が${MAX_ROWS}件を超えています。期間を分けて締めてください` }, 400)
  const unconfirmed = rows.filter(r => r.settle_status !== 'confirmed').length
  if (unconfirmed) return c.json({ error: `未確定のシフトが ${unconfirmed}件 あります。すべて確定してから締めてください`, unconfirmed }, 409)
  const withIssues = rows.filter(r => r.issues.length).length
  if (withIssues && !b.force) return c.json({ error: `確定後に対応が必要なシフトが ${withIssues}件 あります`, need_force: true, with_issues: withIssues }, 409)
  const t = summarize(rows).totals
  // 同時に締めたときに期間が重ならないよう、重なる締めがないことを条件に入れる
  const r = await db.prepare(`INSERT INTO settlement_closings (company_id, period_from, period_to, shift_count, bill_total, pay_total, note, closed_by, closed_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM settlement_closings WHERE company_id = ? AND reopened_at IS NULL AND period_from <= ? AND period_to >= ?)`)
    .bind(u.company_id, f.from, f.to, t.shifts, t.bill, t.pay, String(b.note || '').trim().slice(0, 200) || null, u.user_id, nowJST(), u.company_id, f.to, f.from).run()
  if (!r.meta.changes) return c.json({ error: '同じ期間がすでに締められています' }, 409)
  return c.json({ ok: true, closing_id: r.meta.last_row_id, shifts: t.shifts, bill: t.bill, pay: t.pay })
})
// 締めの解除は会社管理者だけ。理由を必ず残す（行は消さない）
app.post('/settlement/closings/:id/reopen', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  if (u.role !== 'company_admin') return c.json({ error: '締めの解除は会社管理者だけが行えます' }, 403)
  const reason = String(b.reason ?? '').trim()
  if (!reason) return c.json({ error: '解除の理由を入力してください' }, 400)
  const r = await c.env.DB.prepare('UPDATE settlement_closings SET reopened_at = ?, reopened_by = ?, reopen_reason = ? WHERE closing_id = ? AND company_id = ? AND reopened_at IS NULL')
    .bind(nowJST(), u.user_id, reason.slice(0, 500), c.req.param('id'), u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '締めが見つからないか、すでに解除されています' }, 404)
  return c.json({ ok: true })
})

// ---------- 欠勤・中止のキャンセル料・補償（#283） ----------
const MONEY_MIN = -MONEY_MAX
async function loadAbsentShift(db: D1Database, companyId: number, id: any) {
  return await db.prepare(`SELECT s.shift_id, s.project_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.settle_status, s.absent_at,
      s.unit_price, s.pay_amount, s.payee_type, p.project_name, cl.client_name, us.name AS staff_name
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE s.shift_id = ? AND s.company_id = ?`).bind(id, companyId).first() as any
}
// 入力欄の初期値に使う、予定の金額（請求基本額・支払基本額）と案件の規定を返す
app.get('/settlement/cancellations/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await loadAbsentShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const [cx, policy, closed] = await Promise.all([
    db.prepare('SELECT reason, notified_on, bill_amount, pay_amount, note, updated_at FROM shift_cancellations WHERE shift_id = ? AND company_id = ?').bind(s.shift_id, u.company_id).first(),
    db.prepare('SELECT bill_rate_prev_day, bill_rate_same_day, pay_rate FROM project_cancel_policies WHERE project_id = ? AND company_id = ?').bind(s.project_id, u.company_id).first(),
    closedMessage(db, u.company_id, s.work_date),
  ])
  return c.json({
    shift: { shift_id: s.shift_id, project_id: s.project_id, project_name: s.project_name, client_name: s.client_name || '', staff_name: s.staff_name, work_date: s.work_date,
      start_time: s.start_time, end_time: s.end_time, status: s.status, settle_status: s.settle_status === 'confirmed' ? 'confirmed' : 'planned', absent_at: s.absent_at,
      planned_bill: Number(s.unit_price || 0), planned_pay: s.pay_amount == null ? null : Number(s.pay_amount), payee_type: s.payee_type || 'payroll' },
    cancellation: cx || null, policy: policy || null, closed,
  })
})
// 欠勤のシフトのキャンセル料・補償を保存する（remove: true で取り消し、精算の対象から外す）
app.put('/settlement/cancellations/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const s = await loadAbsentShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (s.status !== 'absent') return c.json({ error: '欠勤のシフトだけに入力できます' }, 400)
  if (isSettled(s)) return c.json({ error: '確定済みです。確定を取り消してから変更してください' }, 409)
  const closed = await closedMessage(db, u.company_id, s.work_date)
  if (closed) return c.json({ error: closed }, 409)
  if (b.remove) {
    await db.prepare('DELETE FROM shift_cancellations WHERE shift_id = ? AND company_id = ?').bind(s.shift_id, u.company_id).run()
    return c.json({ ok: true, removed: true })
  }
  if (!CANCEL_REASON_LABEL[b.reason]) return c.json({ error: '理由を選んでください' }, 400)
  if (b.notified_on != null && b.notified_on !== '' && !isDate(b.notified_on)) return c.json({ error: '連絡日の形式が正しくありません' }, 400)
  const bill = intOrNull(b.bill_amount), pay = intOrNull(b.pay_amount)
  for (const [v, raw, name] of [[bill, b.bill_amount, 'キャンセル料（請求）'], [pay, b.pay_amount, '補償・控除（支払）']] as const) {
    if (raw !== '' && raw != null && v == null) return c.json({ error: `${name}は数値で入力してください` }, 400)
    if (v != null && (v < MONEY_MIN || v > MONEY_MAX)) return c.json({ error: `${name}は${MONEY_MIN}〜${MONEY_MAX}で入力してください` }, 400)
  }
  // 別の画面で確定・欠勤の取り消しをされていても上書きしないよう、欠勤かつ未確定を条件にする
  const r = await db.prepare(`INSERT INTO shift_cancellations (shift_id, company_id, reason, notified_on, bill_amount, pay_amount, note, updated_by, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shifts WHERE shift_id = ? AND company_id = ? AND status = 'absent' AND COALESCE(settle_status,'planned') != 'confirmed')
    ON CONFLICT(shift_id) DO UPDATE SET reason = excluded.reason, notified_on = excluded.notified_on, bill_amount = excluded.bill_amount, pay_amount = excluded.pay_amount,
      note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(s.shift_id, u.company_id, b.reason, b.notified_on || null, bill, pay, String(b.note || '').trim().slice(0, 200) || null, u.user_id, nowJST(), s.shift_id, u.company_id).run()
  if (!r.meta.changes) return c.json({ error: 'シフトの状態が変わったため保存できませんでした。画面を読み直してください' }, 409)
  return c.json({ ok: true })
})
// 案件のキャンセル料の規定（率は 0〜100%。空欄 = 規定なし）
app.put('/settlement/projects/:id/cancel-policy', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const p = await ownProject(c.env.DB, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const vals: (number | null)[] = []
  for (const [k, name] of [['bill_rate_prev_day', '前日の連絡の率'], ['bill_rate_same_day', '当日の連絡の率'], ['pay_rate', '補償率']] as const) {
    const v = intOrNull(b[k])
    if ((b[k] !== '' && b[k] != null && v == null) || (v != null && (v < 0 || v > 100))) return c.json({ error: `${name}は0〜100（%）で入力してください` }, 400)
    vals.push(v)
  }
  await c.env.DB.prepare(`INSERT INTO project_cancel_policies (project_id, company_id, bill_rate_prev_day, bill_rate_same_day, pay_rate, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET bill_rate_prev_day = excluded.bill_rate_prev_day, bill_rate_same_day = excluded.bill_rate_same_day, pay_rate = excluded.pay_rate,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(p.project_id, u.company_id, ...vals, u.user_id, nowJST()).run()
  return c.json({ ok: true })
})

// ---------- 支払明細書・請求明細書（#168） ----------
// 印刷用のページ（ブラウザの印刷から PDF に保存できる）。確定済みのシフトだけを載せる。
//   kind=payment&group=<支払集計の group_key>  … 支払先（スタッフ・取引先・他社）あて
//   kind=billing&client_id=<クライアント。0 = クライアントなし> … クライアントあて
const h = (v: any) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
const yenText = (n: any) => (n == null ? '-' : (Number(n) < 0 ? '-' : '') + '¥' + String(Math.abs(Math.round(Number(n)))).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
const hoursText = (n: any) => (n == null ? '' : String(Math.round(Number(n) * 100) / 100) + 'h')
const mdText = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
function statementPage(title: string, body: string) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${h(title)}</title>
<style>
body{font-family:"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;color:#111;margin:24px;font-size:12px}
h1{font-size:20px;text-align:center;letter-spacing:.3em;margin:0 0 16px}
.meta{display:flex;justify-content:space-between;gap:16px;margin-bottom:12px}.to{font-size:15px;font-weight:bold;border-bottom:1px solid #111;padding-bottom:2px}
.total{font-size:16px;font-weight:bold;margin:8px 0 12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:3px 5px;vertical-align:top}
th{background:#f2f2f2;font-weight:bold}td.n{text-align:right;white-space:nowrap}tfoot td{font-weight:bold}.note{color:#555;margin-top:8px}
.bar{margin-bottom:12px}.bar button{padding:6px 14px;font-size:13px}@media print{.bar{display:none}body{margin:0}}@page{size:A4;margin:12mm}
</style></head><body><div class="bar"><button type="button" onclick="window.print()">印刷・PDFに保存</button></div>${body}</body></html>`
}
app.get('/settlement/statement', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const fail = (msg: string, status: 400 | 404 = 400) => c.html(statementPage('明細書', `<p>${h(msg)}</p>`), status)
  const base = parseFilters(k => (k === 'from' || k === 'to' ? c.req.query(k) : undefined))
  if ('error' in base) return fail(base.error!)
  const kind = c.req.query('kind') === 'billing' ? 'billing' : 'payment'
  const clientId = intOrNull(c.req.query('client_id')), group = String(c.req.query('group') || '')
  if (kind === 'billing' && clientId == null) return fail('クライアントを指定してください')
  if (kind === 'payment' && !group) return fail('支払先を指定してください')
  // 読む件数を減らすため、宛先で絞れる条件は問い合わせに入れる（最後は宛先の一致で選ぶ）
  const staffOfGroup = group.match(/^(?:payroll|payroll_daily):staff(\d+)$/) || group.match(/^freelance:(\d+)$/)
  const f: Filters = { ...base, client_id: kind === 'billing' && clientId ? clientId : null, staff_id: kind === 'payment' && staffOfGroup ? Number(staffOfGroup[1]) : null }
  const all = await loadRows(db, u.company_id, f)
  if (all.length > MAX_ROWS) return fail(`対象が${MAX_ROWS}件を超えています。期間を絞ってください`)
  const mine = all.filter(r => (kind === 'billing' ? Number(r.client_id || 0) === clientId : payeeGroupKey(r) === group))
  if (!mine.length) return fail('この期間に対象のシフトはありません', 404)
  const rows = mine.filter(r => r.settle_status === 'confirmed')
  const unconfirmed = mine.length - rows.length
  const co = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const first = mine[0]
  // 宛先: クライアント、取引先・他社はその会社、自社給与・日雇い給与・個人事業主はスタッフ本人
  const company = first.payee_type === 'partner' || first.payee_type === 'linked'
  const toName = kind === 'billing' ? `${first.client_name || '（クライアントなし）'} 御中` : company ? `${first.payee_name} 御中` : `${first.staff_name} 様（${PAYEE_LABEL[first.payee_type] || first.payee_type}）`
  const title = kind === 'billing' ? '請求明細書' : '支払明細書'
  const v = (r: Row, k: string) => (r as any)[(kind === 'billing' ? 'bill_' : 'pay_') + k]
  const sum = (k: string) => rows.reduce((n, r) => n + Number(v(r, k) || 0), 0)
  const showStaff = kind === 'billing' || first.payee_type === 'partner' || first.payee_type === 'linked'
  const lines = rows.map(r => {
    const isCancel = r.kind === 'cancel'
    const unit = v(r, 'unit_type'), rate = v(r, 'rate'), qty = v(r, 'qty')
    const hours = isCancel ? '' : unit === 'hourly' ? hoursText(kind === 'billing' ? r.hours : r.pay_hours) : '日額'
    const memo = isCancel ? `${CANCEL_REASON_LABEL[r.cancel_reason || ''] || 'キャンセル'}${r.adjust_note ? '・' + r.adjust_note : ''}` : r.adjust_note
    return `<tr><td>${h(mdText(r.work_date))}</td><td>${h(r.project_name)}${r.site_name ? '<br><small>' + h(r.site_name) + '</small>' : ''}</td>${showStaff ? `<td>${h(r.staff_name)}</td>` : ''}
      <td>${isCancel ? '' : h(`${r.actual_start || r.start_time}〜${r.actual_end || r.end_time}`)}</td><td class="n">${h(hours)}</td>
      <td class="n">${rate == null ? '' : h(yenText(rate) + (unit === 'hourly' ? '/時' : '/日'))}</td><td class="n">${qty == null ? '' : h(qty)}</td>
      <td class="n">${h(yenText(v(r, 'base')))}</td><td class="n">${v(r, 'transport') ? h(yenText(v(r, 'transport'))) : ''}</td><td class="n">${v(r, 'adjust') ? h(yenText(v(r, 'adjust'))) : ''}</td>
      <td class="n">${h(yenText(v(r, 'total')))}</td><td>${h(memo)}</td></tr>`
  }).join('')
  const cols = showStaff ? 12 : 11
  const body = `<h1>${h(title)}</h1>
<div class="meta"><div><p class="to">${h(toName)}</p><p>対象期間: ${h(base.from)} 〜 ${h(base.to)}</p></div>
<div style="text-align:right"><p>発行日: ${h(nowJST().slice(0, 10))}</p><p>${h(co?.company_name || '')}</p></div></div>
<p class="total">${kind === 'billing' ? '請求' : '支払'}合計: ${h(yenText(sum('total')))}</p>
<table><thead><tr><th>日付</th><th>案件・場所</th>${showStaff ? '<th>スタッフ</th>' : ''}<th>時間帯</th><th>時間</th><th>単価</th><th>数量</th><th>基本額</th><th>交通費</th><th>調整</th><th>合計</th><th>備考</th></tr></thead>
<tbody>${lines || `<tr><td colspan="${cols}">確定済みのシフトはありません</td></tr>`}</tbody>
<tfoot><tr><td colspan="${cols - 5}">合計（${rows.length}件）</td><td class="n">${h(yenText(sum('base')))}</td><td class="n">${h(yenText(sum('transport')))}</td><td class="n">${h(yenText(sum('adjust')))}</td><td class="n">${h(yenText(sum('total')))}</td><td></td></tr></tfoot></table>
<p class="note">確定済みのシフトだけを載せています。${unconfirmed ? `この期間の未確定のシフト ${unconfirmed}件 は含みません。` : ''}金額は精算画面の確定値です（消費税の計算は含みません）。</p>`
  await logExport(db, u, 'statement_' + kind, base, rows.length, kind === 'billing' ? { client_id: clientId } : { group })
  return c.html(statementPage(`${title}_${toName}_${base.from}_${base.to}`, body))
})

export default app
