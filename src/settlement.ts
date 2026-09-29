// =========================================================
// 実績の確定 / 請求・支払の集計 / CSV出力
// docs/spec_spot_shift.md 第3段階
//
// 管理者向け（/api/admin/*）のみ。api.ts から権限ミドルウェアの後に登録する。
// 実働時間: 入店・退店報告（アプリ・報告URL・代理入力）から actual_start / actual_end に反映する。
// 管理者が入力した実績（actual_source = 'manual'）は報告で上書きしない。
// 確定（settle_status = 'confirmed'）したシフトは金額・時間・スタッフを変更できない。
// =========================================================
import { Hono } from 'hono'
import { calcAmounts, isSettled, loadPricingData, shiftTotals, workHours } from './shift-board'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const MAX_RANGE_DAYS = 93
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
export async function refreshShiftAmounts(db: D1Database, companyId: number, shiftId: number) {
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s || isSettled(s) || s.price_locked) return
  const billHourly = s.bill_unit_type === 'hourly' && s.bill_rate != null
  const payHourly = s.pay_unit_type === 'hourly' && s.pay_rate != null
  if (!billHourly && !payHourly) return
  const data = await loadPricingData(db, companyId, [s.project_id])
  const proj = data.projects.get(Number(s.project_id)) || {}
  const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
  const h = workHours({ ...s, break_minutes: brk }, proj).hours
  const amt = calcAmounts({ bill_unit_type: 'hourly', bill_rate: s.bill_rate, pay_unit_type: 'hourly', pay_rate: s.pay_rate }, s.start_time, s.end_time, brk, h)
  await db.prepare('UPDATE shifts SET bill_qty = ?, unit_price = ?, pay_qty = ?, pay_amount = ? WHERE shift_id = ?')
    .bind(billHourly ? amt.bill_qty : s.bill_qty, billHourly ? amt.unit_price : s.unit_price,
      payHourly ? amt.pay_qty : s.pay_qty, payHourly ? amt.pay_amount : s.pay_amount, shiftId).run()
}

// 入店・退店報告の時刻を実績に反映する（管理者の手入力・確定済みは対象外）。報告の登録・削除のたびに呼ぶ
export async function syncActualFromReports(db: D1Database, companyId: number, shiftId: number) {
  const s = await db.prepare('SELECT shift_id, actual_source, settle_status, actual_start, actual_end FROM shifts WHERE shift_id = ? AND company_id = ?').bind(shiftId, companyId).first() as any
  if (!s || isSettled(s) || s.actual_source === 'manual') return false
  const reps = (await db.prepare("SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ? AND report_type IN ('check_in','check_out')").bind(shiftId).all()).results as any[]
  const hm = (t: string) => (String(t || '').match(/(\d{2}:\d{2})/) || [])[1] || null
  const cin = hm(reps.find(r => r.report_type === 'check_in')?.reported_at), cout = hm(reps.find(r => r.report_type === 'check_out')?.reported_at)
  const start = cin && cout ? cin : null, end = cin && cout ? cout : null
  if (start === (s.actual_start || null) && end === (s.actual_end || null)) return false
  await db.prepare('UPDATE shifts SET actual_start = ?, actual_end = ?, actual_source = ? WHERE shift_id = ?')
    .bind(start, end, start ? 'report' : null, shiftId).run()
  await refreshShiftAmounts(db, companyId, shiftId)
  return true
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

async function loadRows(db: D1Database, companyId: number, f: Filters, shiftIds?: number[]) {
  const w = ['s.company_id = ?', `s.status IN (${WORK_STATUSES.map(() => '?').join(',')})`]; const bind: any[] = [companyId, ...WORK_STATUSES]
  if (shiftIds) { w.push(`s.shift_id IN (${shiftIds.map(() => '?').join(',')})`); bind.push(...shiftIds) }
  else { w.push('s.work_date BETWEEN ? AND ?'); bind.push(f.from, f.to) }
  if (f.client_id) { w.push('p.client_id = ?'); bind.push(f.client_id) }
  if (f.project_id) { w.push('s.project_id = ?'); bind.push(f.project_id) }
  if (f.staff_id) { w.push('s.staff_id = ?'); bind.push(f.staff_id) }
  if (f.payee_type) { w.push("COALESCE(s.payee_type,'payroll') = ?"); bind.push(f.payee_type) }
  if (f.settle === 'confirmed') w.push("s.settle_status = 'confirmed'")
  if (f.settle === 'planned') w.push("COALESCE(s.settle_status,'planned') != 'confirmed'")
  const rows = (await db.prepare(`SELECT s.*, p.project_name, p.client_id, p.hours_basis, p.time_round_minutes, p.default_break_minutes, cl.client_name,
      st.site_name, us.name AS staff_name, sp.affiliation_type, er.employee_number,
      aff.affiliation_name AS payee_affiliation_name, pco.company_name AS payee_company_name,
      (SELECT MAX(CASE WHEN a.report_type = 'check_in' THEN 1 END) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS has_check_in,
      (SELECT MAX(CASE WHEN a.report_type = 'check_out' THEN 1 END) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS has_check_out,
      (SELECT COUNT(*) FROM daily_reports d WHERE d.shift_id = s.shift_id) AS has_daily
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN clients cl ON cl.client_id = p.client_id
    LEFT JOIN sites st ON st.site_id = s.site_id
    JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = s.staff_id
    LEFT JOIN staff_affiliations aff ON aff.affiliation_id = s.payee_affiliation_id
    LEFT JOIN companies pco ON pco.company_id = s.payee_company_id
    WHERE ${w.join(' AND ')} ORDER BY s.work_date, cl.client_name, p.project_name, s.start_time, us.name LIMIT 5000`).bind(...bind).all()).results as any[]
  const today = nowJST().slice(0, 10)
  const out = rows.map(r => {
    const proj = { hours_basis: r.hours_basis, time_round_minutes: r.time_round_minutes, default_break_minutes: r.default_break_minutes }
    const h = workHours(r, proj)
    const t = shiftTotals(r)
    const issues: string[] = []
    const past = r.work_date <= today
    if (past && !r.actual_start) issues.push(!r.has_check_in ? '入店報告なし' : !r.has_check_out ? '退店報告なし' : '実績未入力')
    if (h.actual_hours != null && Math.abs(h.actual_hours - h.planned_hours) >= 0.5) issues.push(`実働が予定と${h.actual_hours > h.planned_hours ? '+' : ''}${Math.round((h.actual_hours - h.planned_hours) * 100) / 100}h 違う`)
    if (r.pay_amount == null) issues.push('支払単価未設定')
    if (!r.unit_price && !r.bill_rate) issues.push('請求単価未設定')
    if (r.price_locked && ((r.bill_unit_type === 'hourly' && Number(r.bill_qty) !== h.hours) || (r.pay_unit_type === 'hourly' && Number(r.pay_qty) !== h.hours))) issues.push('手動変更（数量が実働と違う）')
    const payeeType = r.payee_type || 'payroll'
    const payeeName = payeeType === 'partner' ? (r.payee_affiliation_name || r.affiliation || '取引先') : payeeType === 'linked' ? (r.payee_company_name || '連携元')
      : payeeType === 'freelance' ? r.staff_name : PAYEE_LABEL[payeeType] || payeeType
    return {
      shift_id: r.shift_id, work_date: r.work_date, client_id: r.client_id, client_name: r.client_name || '', project_id: r.project_id, project_name: r.project_name,
      site_name: r.site_name || r.location || '', role: r.role || '', staff_id: r.staff_id, staff_name: r.staff_name, employee_number: r.employee_number || '',
      affiliation_type: r.affiliation_type || 'own_employee', status: r.status,
      start_time: r.start_time, end_time: r.end_time, break_minutes: h.break_minutes, actual_start: r.actual_start, actual_end: r.actual_end,
      actual_break_minutes: r.actual_break_minutes, actual_source: r.actual_source, actual_note: r.actual_note,
      planned_hours: h.planned_hours, actual_hours: h.actual_hours, hours: h.hours, hours_basis: h.basis,
      bill_unit_type: r.bill_unit_type || 'daily', bill_rate: r.bill_rate, bill_qty: r.bill_qty, bill_base: Number(r.unit_price || 0), bill_transport: t.bill_transport, bill_adjust: Number(r.bill_adjust || 0), bill_total: t.bill_total,
      pay_unit_type: r.pay_unit_type || 'daily', pay_rate: r.pay_rate, pay_qty: r.pay_qty, pay_base: r.pay_amount == null ? null : Number(r.pay_amount), pay_transport: t.pay_transport, pay_adjust: Number(r.pay_adjust || 0), pay_total: t.pay_total,
      transportation_fee: Number(r.transportation_fee || 0), adjust_note: r.adjust_note || '',
      bill_transport_type: r.bill_transport_type || 'actual', bill_transport_amount: Number(r.bill_transport_amount || 0), pay_transport_type: r.pay_transport_type || 'actual', pay_transport_amount: Number(r.pay_transport_amount || 0),
      payee_type: payeeType, payee_label: PAYEE_LABEL[payeeType] || payeeType, payee_name: payeeName, payee_key: `${payeeType}:${payeeType === 'partner' ? (r.payee_affiliation_id || r.affiliation || '') : payeeType === 'linked' ? (r.payee_company_id || '') : payeeType === 'freelance' ? r.staff_id : ''}`,
      price_locked: !!r.price_locked, settle_status: r.settle_status === 'confirmed' ? 'confirmed' : 'planned', settled_at: r.settled_at,
      has_check_in: !!r.has_check_in, has_check_out: !!r.has_check_out, has_daily: !!r.has_daily, issues,
    }
  })
  return out
}
type Row = Awaited<ReturnType<typeof loadRows>>[number]

function summarize(rows: Row[]) {
  const sum = (a: Row[], k: keyof Row) => a.reduce((n, r) => n + Number((r as any)[k] || 0), 0)
  const group = <K extends string>(keyFn: (r: Row) => K) => {
    const m = new Map<K, Row[]>(); for (const r of rows) { const k = keyFn(r); m.set(k, [...(m.get(k) || []), r]) } return m
  }
  const totals = {
    shifts: rows.length, bill: sum(rows, 'bill_total'), pay: sum(rows, 'pay_total'),
    confirmed: rows.filter(r => r.settle_status === 'confirmed').length, issues: rows.filter(r => r.issues.length).length,
    pay_unset: rows.filter(r => r.pay_total == null).length,
  }
  const by_client = [...group(r => `${r.client_id || 0}:${r.project_id}` as string)].map(([, a]) => ({
    client_id: a[0].client_id, client_name: a[0].client_name, project_id: a[0].project_id, project_name: a[0].project_name,
    shifts: a.length, staff: new Set(a.map(r => r.staff_id)).size, hours: Math.round(sum(a, 'hours') * 100) / 100,
    bill_base: sum(a, 'bill_base'), bill_transport: sum(a, 'bill_transport'), bill_adjust: sum(a, 'bill_adjust'), bill_total: sum(a, 'bill_total'),
    pay_total: sum(a, 'pay_total'), confirmed: a.filter(r => r.settle_status === 'confirmed').length,
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
  const summary = summarize(rows)
  if (f.issues_only) rows = rows.filter(r => r.issues.length)
  return c.json({ from: f.from, to: f.to, rows, ...summary, truncated: rows.length >= 5000 })
})

// ---------- 実績の反映（入店・退店報告から）----------
app.post('/settlement/sync-actuals', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const f = parseFilters(k => (b[k] != null ? String(b[k]) : undefined))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const ids = ((await db.prepare(`SELECT s.shift_id FROM shifts s JOIN projects p ON p.project_id = s.project_id
    WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? AND COALESCE(s.settle_status,'planned') != 'confirmed' AND COALESCE(s.actual_source,'') != 'manual'
      ${f.project_id ? 'AND s.project_id = ?' : ''} ${f.client_id ? 'AND p.client_id = ?' : ''}`)
    .bind(u.company_id, f.from, f.to, ...(f.project_id ? [f.project_id] : []), ...(f.client_id ? [f.client_id] : [])).all()).results as any[]).map(r => r.shift_id)
  let updated = 0
  for (const id of ids) if (await syncActualFromReports(db, u.company_id, id)) updated++
  return c.json({ ok: true, checked: ids.length, updated })
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
async function targetIds(db: D1Database, companyId: number, b: any): Promise<{ ids: number[]; error?: string }> {
  if (Array.isArray(b.shift_ids)) {
    const ids = [...new Set(b.shift_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
    if (!ids.length) return { ids: [], error: 'シフトを選択してください' }
    if (ids.length > 2000) return { ids: [], error: '一度に処理できるのは2000件までです' }
    return { ids }
  }
  const f = parseFilters(k => (b[k] != null ? String(b[k]) : undefined))
  if ('error' in f) return { ids: [], error: f.error }
  const rows = await loadRows(db, companyId, f)
  return { ids: rows.map(r => r.shift_id) }
}
app.post('/settlement/confirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const t = await targetIds(db, u.company_id, b)
  if (t.error) return c.json({ error: t.error }, 400)
  const rows = t.ids.length ? await loadRowsByIds(db, u.company_id, t.ids) : []
  const today = nowJST().slice(0, 10)
  const targets = rows.filter(r => r.settle_status !== 'confirmed')
  const future = targets.filter(r => r.work_date > today)
  const ok = targets.filter(r => r.work_date <= today)
  const withIssues = ok.filter(r => r.issues.length)
  if (b.dry_run) return c.json({ count: ok.length, with_issues: withIssues.length, future: future.length, already: rows.length - targets.length,
    bill: ok.reduce((n, r) => n + r.bill_total, 0), pay: ok.reduce((n, r) => n + Number(r.pay_total || 0), 0), pay_unset: ok.filter(r => r.pay_total == null).length })
  if (withIssues.length && !b.force) return c.json({ error: `確認が必要なシフトが ${withIssues.length} 件あります`, need_force: true, with_issues: withIssues.length }, 409)
  const now = nowJST()
  for (let i = 0; i < ok.length; i += 90) {
    const chunk = ok.slice(i, i + 90).map(r => r.shift_id)
    await db.prepare(`UPDATE shifts SET settle_status = 'confirmed', settled_at = ?, settled_by = ? WHERE company_id = ? AND shift_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(now, u.user_id, u.company_id, ...chunk).run()
  }
  return c.json({ ok: true, confirmed: ok.length, skipped_future: future.length })
})
app.post('/settlement/unconfirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const t = await targetIds(db, u.company_id, b)
  if (t.error) return c.json({ error: t.error }, 400)
  let n = 0
  for (let i = 0; i < t.ids.length; i += 90) {
    const chunk = t.ids.slice(i, i + 90)
    const r = await db.prepare(`UPDATE shifts SET settle_status = 'planned', settled_at = NULL, settled_by = NULL WHERE company_id = ? AND settle_status = 'confirmed' AND shift_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(u.company_id, ...chunk).run()
    n += r.meta.changes || 0
  }
  return c.json({ ok: true, unconfirmed: n })
})
async function loadRowsByIds(db: D1Database, companyId: number, ids: number[]) {
  const out: Row[] = []
  const blank: Filters = { from: '', to: '', client_id: null, project_id: null, staff_id: null, payee_type: '', settle: '', issues_only: false }
  for (let i = 0; i < ids.length; i += 90) out.push(...await loadRows(db, companyId, blank, ids.slice(i, i + 90)))
  return out
}

// ---------- CSV ----------
function csvCell(v: any): string {
  if (v == null) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s // 数式の実行を防ぐ（負の数値はそのまま）
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function toCsv(header: string[], rows: any[][]) {
  return '\uFEFF' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
const UNIT_LABEL: Record<string, string> = { daily: '日額', hourly: '時給' }

app.get('/settlement/export', async (c) => {
  const u = c.get('user')
  const f = parseFilters(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const kind = c.req.query('kind') || 'detail'
  const rows = await loadRows(c.env.DB, u.company_id, f)
  const { by_client, by_payee } = summarize(rows)
  let csv = '', name = ''
  if (kind === 'billing') {
    name = `請求集計_${f.from}_${f.to}.csv`
    csv = toCsv(['クライアント', '案件', 'シフト数', 'スタッフ数', '時間', '請求基本額', '交通費', '調整', '請求合計', '確定数'],
      by_client.map(g => [g.client_name, g.project_name, g.shifts, g.staff, g.hours, g.bill_base, g.bill_transport, g.bill_adjust, g.bill_total, g.confirmed]))
  } else if (kind === 'payment') {
    name = `支払集計_${f.from}_${f.to}.csv`
    csv = toCsv(['支払区分', '支払先', 'スタッフ', '社員番号', '稼働日数', 'シフト数', '時間', '支払基本額', '交通費', '調整', '支払合計', '単価未設定', '確定数'],
      by_payee.map(g => [g.payee_label, g.payee_name, g.staff_name, g.employee_number, g.days, g.shifts, g.hours, g.pay_base, g.pay_transport, g.pay_adjust, g.pay_total ?? '', g.pay_unset, g.confirmed]))
  } else {
    name = `シフト明細_${f.from}_${f.to}.csv`
    csv = toCsv(['シフトID', '日付', 'クライアント', '案件', '開催場所', '役割', 'スタッフ', '社員番号', '支払区分', '支払先',
      '予定開始', '予定終了', '休憩(分)', '実績開始', '実績終了', '実績の入力', '予定時間', '実働時間', '計算時間',
      '請求単位', '請求単価', '請求数量', '請求基本額', '請求交通費', '請求調整', '請求合計',
      '支払単位', '支払単価', '支払数量', '支払基本額', '交通費実費', '支払交通費', '支払調整', '支払合計', '調整メモ', '確定', '確認事項'],
      rows.map(r => [r.shift_id, r.work_date, r.client_name, r.project_name, r.site_name, r.role, r.staff_name, r.employee_number, r.payee_label, r.payee_name,
        r.start_time, r.end_time, r.break_minutes, r.actual_start || '', r.actual_end || '', r.actual_source === 'manual' ? '手入力' : r.actual_source === 'report' ? '報告' : '',
        r.planned_hours, r.actual_hours ?? '', r.hours,
        UNIT_LABEL[r.bill_unit_type] || r.bill_unit_type, r.bill_rate ?? '', r.bill_qty ?? '', r.bill_base, r.bill_transport, r.bill_adjust, r.bill_total,
        UNIT_LABEL[r.pay_unit_type] || r.pay_unit_type, r.pay_rate ?? '', r.pay_qty ?? '', r.pay_base ?? '', r.transportation_fee, r.pay_transport, r.pay_adjust, r.pay_total ?? '', r.adjust_note,
        r.settle_status === 'confirmed' ? '確定' : '未確定', r.issues.join(' / ')]))
  }
  return new Response(csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="settlement.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  } })
})

export default app
