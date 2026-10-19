// =========================================================
// 実績の確定 / 請求・支払の集計 / CSV出力
// docs/spec_spot_shift.md 第3段階
//
// 管理者向け（/api/admin/*）のみ。api.ts から権限ミドルウェアの後に登録する。
// 実働時間: 勤務開始・勤務終了の報告（なければ入店・退店）から actual_start / actual_end に反映する。
// 休憩入・休憩出の報告が両方あれば、その差を actual_break_minutes に反映する（docs/spec_attendance_correction.md 4.7）。
// 管理者が入力した実績（actual_source = 'manual'）は報告で上書きしない。
// 確定（settle_status = 'confirmed'）したシフトは金額・時間・スタッフを変更できない。
// =========================================================
import { Hono } from 'hono'
import { calcAmounts, isSettled, loadPricingData, shiftTotals, workHours } from './shift-board'
import { toCsv } from './csv'
import { JSON_IN, batchInChunks, bindJsonArray, chunk } from './lib/d1-chunk'
import { shiftWindow } from './lib/shift-time'
import { changesOf, updateRowsStmts } from './lib/bulk-write'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const MAX_RANGE_DAYS = 93
// 一覧・CSV・一括の確定と取り消しで扱う件数の上限。超えたときは一部だけを処理せず、期間や条件を絞ってもらう
export const MAX_ROWS = 5000
const WORK_STATUSES = ['confirmed', 'substitute']
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const isTime = (s: any) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s)
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function dayDiff(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) }
function intOrNull(v: any): number | null { if (v === '' || v == null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null }

export const PAYEE_LABEL: Record<string, string> = {
  payroll: '自社給与', payroll_daily: '日雇い給与', freelance: '個人事業主（業務委託）', partner: '取引先', linked: '他社（連携元）',
}

// ---------- 金額の再計算（実績の変更時） ----------
// 単価ルールは再適用しない（過去のシフトの単価を変えないため）。記録済みの単価のまま、時給の数量だけを実働時間に合わせる。
// 日額のシフトは金額を変えない。手動で金額を変えたシフト（price_locked）は数量も変えず、精算画面の「確認」に表示する
// s はシフトの行（shifts.*）、proj は案件の休憩・時間の計算方法。変えないときは null
export function amountsForActual(s: any, proj: any) {
  if (isSettled(s) || s.price_locked) return null
  const billHourly = s.bill_unit_type === 'hourly' && s.bill_rate != null
  const payHourly = s.pay_unit_type === 'hourly' && s.pay_rate != null
  if (!billHourly && !payHourly) return null
  const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
  const h = workHours({ ...s, break_minutes: brk }, proj).hours
  const amt = calcAmounts({ bill_unit_type: 'hourly', bill_rate: s.bill_rate, pay_unit_type: 'hourly', pay_rate: s.pay_rate }, s.start_time, s.end_time, brk, h)
  return {
    bill_qty: billHourly ? amt.bill_qty : s.bill_qty, unit_price: billHourly ? amt.unit_price : s.unit_price,
    pay_qty: payHourly ? amt.pay_qty : s.pay_qty, pay_amount: payHourly ? amt.pay_amount : s.pay_amount,
  }
}
export async function refreshShiftAmounts(db: D1Database, companyId: number, shiftId: number) {
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s || isSettled(s) || s.price_locked) return
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

// 報告の時刻を実績に反映する（管理者の手入力・確定済みは対象外）。報告の登録・変更・削除のたびに呼ぶ
export async function syncActualFromReports(db: D1Database, companyId: number, shiftId: number) {
  const s = await db.prepare('SELECT shift_id, actual_source, settle_status, actual_start, actual_end, actual_break_minutes FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s || isSettled(s) || s.actual_source === 'manual') return false
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
    const rows = (await db.prepare(`SELECT s.*, p.hours_basis, p.time_round_minutes, p.default_break_minutes, ${REPORT_COLS}
      FROM shifts s JOIN projects p ON p.project_id = s.project_id WHERE s.company_id = ? AND s.shift_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(part)).all()).results as any[]
    const stmts: D1PreparedStatement[] = []
    for (const s of rows) {
      if (isSettled(s) || s.actual_source === 'manual') continue
      const a = actualFromReports(t => s['r_' + t])
      if (sameActual(a, s)) continue
      const amt = amountsForActual({ ...s, actual_start: a.start, actual_end: a.end, actual_break_minutes: a.brk },
        { hours_basis: s.hours_basis, time_round_minutes: s.time_round_minutes, default_break_minutes: s.default_break_minutes })
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

// 条件に合うシフトを MAX_ROWS + 1 件まで読む（上限を超えたかどうかを呼び出し側で判定できるように1件多く読む）
async function loadRows(db: D1Database, companyId: number, f: Filters, shiftIds?: number[]) {
  const w = ['s.company_id = ?', `s.status IN (${WORK_STATUSES.map(() => '?').join(',')})`]; const bind: any[] = [companyId, ...WORK_STATUSES]
  if (shiftIds) { w.push(`s.shift_id IN ${JSON_IN}`); bind.push(bindJsonArray(shiftIds)) }
  else { w.push('s.work_date BETWEEN ? AND ?'); bind.push(f.from, f.to) }
  if (f.client_id) { w.push('p.client_id = ?'); bind.push(f.client_id) }
  if (f.project_id) { w.push('s.project_id = ?'); bind.push(f.project_id) }
  if (f.staff_id) { w.push('s.staff_id = ?'); bind.push(f.staff_id) }
  if (f.payee_type) { w.push("COALESCE(s.payee_type,'payroll') = ?"); bind.push(f.payee_type) }
  if (f.settle === 'confirmed') w.push("s.settle_status = 'confirmed'")
  if (f.settle === 'planned') w.push("COALESCE(s.settle_status,'planned') != 'confirmed'")
  // manual_correction_at: 実績が手入力のときに承認した打刻修正（承認の操作履歴に applied_while_manual を記録している）
  const rows = (await db.prepare(`SELECT s.*, p.project_name, p.client_id, p.hours_basis, p.time_round_minutes, p.default_break_minutes, cl.client_name,
      st.site_name, us.name AS staff_name, sp.affiliation_type, er.employee_number,
      aff.affiliation_name AS payee_affiliation_name, pco.company_name AS payee_company_name,
      (SELECT MAX(c.decided_at) FROM attendance_corrections c WHERE c.shift_id = s.shift_id AND c.status = 'approved') AS last_correction_at,
      (SELECT COUNT(*) FROM attendance_corrections c WHERE c.shift_id = s.shift_id AND c.status = 'pending') AS pending_corrections,
      (SELECT MAX(e.created_at) FROM attendance_corrections c JOIN attendance_correction_events e ON e.correction_id = c.correction_id
        WHERE c.shift_id = s.shift_id AND c.status = 'approved' AND e.event IN ('approved','approved_exception') AND json_extract(e.detail, '$.applied_while_manual') = 1) AS manual_correction_at,
      ${REPORT_COLS},
      (SELECT COUNT(*) FROM daily_reports d WHERE d.shift_id = s.shift_id) AS has_daily
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    LEFT JOIN sites st ON st.site_id = s.site_id
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = s.staff_id
    LEFT JOIN staff_affiliations aff ON aff.affiliation_id = s.payee_affiliation_id
    LEFT JOIN companies pco ON pco.company_id = s.payee_company_id
    WHERE ${w.join(' AND ')} ORDER BY s.work_date, cl.client_name, p.project_name, s.start_time, us.name LIMIT ${MAX_ROWS + 1}`).bind(...bind).all()).results as any[]
  const today = nowJST().slice(0, 10)
  const out = rows.map(r => {
    const proj = { hours_basis: r.hours_basis, time_round_minutes: r.time_round_minutes, default_break_minutes: r.default_break_minutes }
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
    const missing = past && !r.actual_start
    if (missing) issues.push(!hasIn ? '入店報告なし' : !hasOut ? '退店報告なし' : unsynced && !settled ? '報告が実績に未反映' : '実績未入力')
    if (h.actual_hours != null && Math.abs(h.actual_hours - h.planned_hours) >= 0.5) issues.push(`実働が予定と${h.actual_hours > h.planned_hours ? '+' : ''}${Math.round((h.actual_hours - h.planned_hours) * 100) / 100}h 違う`)
    if (r.pay_amount == null) issues.push('支払単価未設定')
    // 承認待ちの打刻修正。確定すると、後で承認したときに確定の取り消しと再確定が必要になる
    if (r.pending_corrections) issues.push('承認待ちの打刻修正あり')
    // 確定の後に打刻修正を承認した、または報告があった（報告は記録済み・実績と金額は確定時のまま）。確定を取り消すと実績に反映される
    if (settled && r.last_correction_at && (!r.settled_at || r.last_correction_at >= r.settled_at)) issues.push('確定後に打刻修正あり')
    else if (settled && (unsynced || (r.settled_at && lastReportAt && lastReportAt > r.settled_at))) issues.push('確定後に報告あり（実績に未反映）')
    else if (!settled && unsynced && !missing) issues.push('報告が実績に未反映')
    // 手入力の実績のあるシフトで打刻修正を承認した（実績・金額は手入力のまま）。「報告の時刻に戻す」で反映される
    if (r.actual_source === 'manual' && r.manual_correction_at && !sameActual(fromReports, r)) issues.push('手入力後に打刻修正あり')
    if (!r.unit_price && !r.bill_rate) issues.push('請求単価未設定')
    if (r.price_locked && ((r.bill_unit_type === 'hourly' && Number(r.bill_qty) !== h.hours) || (r.pay_unit_type === 'hourly' && Number(r.pay_qty) !== h.hours))) issues.push('手動変更（数量が実働と違う）')
    const payeeType = r.payee_type || 'payroll'
    const payeeName = payeeType === 'partner' ? (r.payee_affiliation_name || r.affiliation || '取引先') : payeeType === 'linked' ? (r.payee_company_name || '連携元')
      : payeeType === 'freelance' ? r.staff_name : PAYEE_LABEL[payeeType] || payeeType
    return {
      shift_id: r.shift_id, work_date: r.work_date, client_id: r.client_id, client_name: r.client_name || '', project_id: r.project_id, project_name: r.project_name,
      site_name: r.site_name || r.location || '', role: r.role || '', staff_id: r.staff_id, staff_name: r.staff_name, employee_number: r.employee_number || '',
      affiliation_type: r.affiliation_type || 'own_employee', status: r.status,
      // break_minutes = 予定の休憩、used_break_minutes = 実働の計算に使った休憩（実績の休憩があればその値）
      start_time: r.start_time, end_time: r.end_time, break_minutes: h.planned_break_minutes, used_break_minutes: h.break_minutes, actual_start: r.actual_start, actual_end: r.actual_end,
      actual_break_minutes: r.actual_break_minutes, actual_source: r.actual_source, actual_note: r.actual_note,
      planned_hours: h.planned_hours, actual_hours: h.actual_hours, hours: h.hours, hours_basis: h.basis,
      bill_unit_type: r.bill_unit_type || 'daily', bill_rate: r.bill_rate, bill_qty: r.bill_qty, bill_base: Number(r.unit_price || 0), bill_transport: t.bill_transport, bill_adjust: Number(r.bill_adjust || 0), bill_total: t.bill_total,
      pay_unit_type: r.pay_unit_type || 'daily', pay_rate: r.pay_rate, pay_qty: r.pay_qty, pay_base: r.pay_amount == null ? null : Number(r.pay_amount), pay_transport: t.pay_transport, pay_adjust: Number(r.pay_adjust || 0), pay_total: t.pay_total,
      transportation_fee: Number(r.transportation_fee || 0), adjust_note: r.adjust_note || '',
      bill_transport_type: r.bill_transport_type || 'actual', bill_transport_amount: Number(r.bill_transport_amount || 0), pay_transport_type: r.pay_transport_type || 'actual', pay_transport_amount: Number(r.pay_transport_amount || 0),
      payee_type: payeeType, payee_label: PAYEE_LABEL[payeeType] || payeeType, payee_name: payeeName, payee_key: `${payeeType}:${payeeType === 'partner' ? (r.payee_affiliation_id || r.affiliation || '') : payeeType === 'linked' ? (r.payee_company_id || '') : payeeType === 'freelance' ? r.staff_id : ''}`,
      price_locked: !!r.price_locked, settle_status: settled ? 'confirmed' : 'planned', settled_at: r.settled_at,
      has_check_in: hasIn, has_check_out: hasOut, has_end_report: hasOut || !!at('work_end'), has_daily: !!r.has_daily,
      pending_corrections: Number(r.pending_corrections || 0), issues,
    }
  })
  return out
}
type Row = Awaited<ReturnType<typeof loadRows>>[number]

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
    confirmed: rows.filter(r => r.settle_status === 'confirmed').length, issues: rows.filter(r => r.issues.length).length,
    ...profitOf(rows),
  }
  const by_client = [...group(r => `${r.client_id || 0}:${r.project_id}` as string)].map(([, a]) => ({
    client_id: a[0].client_id, client_name: a[0].client_name, project_id: a[0].project_id, project_name: a[0].project_name,
    shifts: a.length, staff: new Set(a.map(r => r.staff_id)).size, hours: Math.round(sum(a, 'hours') * 100) / 100,
    bill_base: sum(a, 'bill_base'), bill_transport: sum(a, 'bill_transport'), bill_adjust: sum(a, 'bill_adjust'), bill_total: sum(a, 'bill_total'),
    pay_total: sum(a, 'pay_total'), ...profitOf(a), confirmed: a.filter(r => r.settle_status === 'confirmed').length,
  })).sort((x, y) => (x.client_name || '').localeCompare(y.client_name || '', 'ja') || x.project_name.localeCompare(y.project_name, 'ja'))
  const by_payee = [...group(r => (r.payee_type === 'payroll' || r.payee_type === 'payroll_daily' ? `${r.payee_type}:staff${r.staff_id}` : r.payee_key) as string)].map(([, a]) => ({
    payee_type: a[0].payee_type, payee_label: a[0].payee_label, payee_name: a[0].payee_name,
    staff_id: a[0].payee_type === 'partner' || a[0].payee_type === 'linked' ? null : a[0].staff_id,
    staff_name: a[0].payee_type === 'partner' || a[0].payee_type === 'linked' ? [...new Set(a.map(r => r.staff_name))].join('、') : a[0].staff_name,
    employee_number: a[0].payee_type === 'payroll' || a[0].payee_type === 'payroll_daily' ? a[0].employee_number : '',
    shifts: a.length, days: new Set(a.map(r => `${r.staff_id}:${r.work_date}`)).size, hours: Math.round(sum(a, 'hours') * 100) / 100,
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
  return c.json({ from: f.from, to: f.to, rows, ...summary, truncated, max_rows: MAX_ROWS })
})

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
  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const rows = (await db.prepare(`SELECT s.*, p.hours_basis, p.time_round_minutes, p.default_break_minutes FROM shifts s JOIN projects p ON p.project_id = s.project_id
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
  if (r.has_end_report || (r.actual_source === 'manual' && r.actual_start)) return true
  return r.work_date < today && shiftWindow(r.work_date, r.start_time, r.end_time).end <= now
}
app.post('/settlement/confirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const t = await targetRows(db, u.company_id, b)
  if (t.error) return c.json({ error: t.error }, 400)
  const rows = t.rows
  const now = nowJST(), today = now.slice(0, 10)
  const targets = rows.filter(r => r.settle_status !== 'confirmed')
  const future = targets.filter(r => r.work_date > today)
  const inProgress = targets.filter(r => r.work_date <= today && !finishedForSettle(r, now))
  const ok = targets.filter(r => finishedForSettle(r, now))
  const withIssues = ok.filter(r => r.issues.length)
  const paid = ok.filter(r => r.pay_total != null)
  if (b.dry_run) return c.json({ target: rows.length, count: ok.length, with_issues: withIssues.length, future: future.length, in_progress: inProgress.length, already: rows.length - targets.length,
    bill: ok.reduce((n, r) => n + r.bill_total, 0), pay: paid.reduce((n, r) => n + Number(r.pay_total), 0), pay_unset: ok.length - paid.length })
  if (withIssues.length && !b.force) return c.json({ error: `確認が必要なシフトが ${withIssues.length} 件あります`, need_force: true, with_issues: withIssues.length }, 409)
  let confirmed = 0
  for (const part of chunk(ok.map(r => r.shift_id), 500)) {
    const r = await db.prepare(`UPDATE shifts SET settle_status = 'confirmed', settled_at = ?, settled_by = ?
      WHERE company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed' AND shift_id IN ${JSON_IN}`)
      .bind(now, u.user_id, u.company_id, bindJsonArray(part)).run()
    confirmed += r.meta.changes || 0
  }
  return c.json({ ok: true, confirmed, skipped_future: future.length, skipped_in_progress: inProgress.length })
})
app.post('/settlement/unconfirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const t = await targetRows(db, u.company_id, b)
  if (t.error) return c.json({ error: t.error }, 400)
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
        r.actual_source === 'manual' ? '手入力' : r.actual_source === 'report' ? '報告' : '',
        r.planned_hours, r.actual_hours ?? '', r.hours,
        UNIT_LABEL[r.bill_unit_type] || r.bill_unit_type, r.bill_rate ?? '', r.bill_qty ?? '', r.bill_base, r.bill_transport, r.bill_adjust, r.bill_total,
        UNIT_LABEL[r.pay_unit_type] || r.pay_unit_type, r.pay_rate ?? '', r.pay_qty ?? '', r.pay_base ?? '', r.transportation_fee, r.pay_transport, r.pay_adjust, r.pay_total ?? '', r.adjust_note,
        r.settle_status === 'confirmed' ? '確定' : '未確定', r.issues.join(' / '), r.staff_id]), { textCols: ['社員番号'] })
  }
  return new Response(csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="settlement.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  } })
})

export default app
