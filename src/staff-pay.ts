// =========================================================
// スタッフ向けの勤務時間・支払額の確認と、交通費（実費）・残業（延長）の申請（w5-staff-pay-features: #172 #273 #274 #290）
//
// スタッフ API（/api/staff/pay*）: 自分のシフト（同一人物の他社のシフトを含む）の実働時間と月の集計（#274）。
//   支払額（#290）は、会社設定 staff_pay_visible（companies.settings_json。既定 OFF）が ON の会社のシフトで、
//   支払先が本人（自社給与・日雇い給与・個人事業主）のものだけを返す。請求額・取引先や他社への支払・調整のメモは返さない。
// 申請（staff_pay_requests。migrations/0068）: 交通費の実費（#273）と、予定の終了時刻の延長（#172）。
//   管理者が承認すると、交通費は shifts.transportation_fee を、延長は shifts.end_time を書き換える（時給の金額は計算し直す）。
//   確定済み・締めた期間のシフトは申請も承認もできない。承認待ちの申請は精算の確認事項に出す（settlement.ts）。
// 管理者 API（/api/admin/pay-requests*・/api/admin/staff-pay/settings）は api.ts から権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'
import { shiftTotals, workHours } from './shift-board'
import { closedMessage, refreshShiftAmounts } from './settlement'
import { correctionDeadlineDays } from './corrections'
import { personStaffRows } from './roster'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { isWorkingShift, WORKING_SHIFT_STATUSES } from './lib/shift-status'
import { addDays, overlaps, shiftWindow, toMin } from './lib/shift-time'
import { isHHMM, oneOf, toInt } from './lib/validate'
import { mdText, notifyCompanyAdmins, notifyShiftStaff, nowJST } from './lib/staff-pay-notify'

type Bindings = { DB: D1Database }
type Variables = { user: any }

export const PAY_REQUEST_KINDS = ['transport', 'overtime'] as const
export const PAY_REQUEST_KIND_LABEL: Record<string, string> = { transport: '交通費', overtime: '延長' }
// 支払先が本人のシフト（支払額を本人に見せてよいもの）
const SELF_PAYEES = ['payroll', 'payroll_daily', 'freelance']
// 交通費の申請の上限（円。往復の合計）・延長の上限（分）・1時間あたりの申請数の上限
export const TRANSPORT_MAX = 100000
export const OVERTIME_MAX_MINUTES = 720
const HOURLY_LIMIT = 20
const TEXT_MAX = 500
const WORKING_IN = `(${WORKING_SHIFT_STATUSES.map(s => `'${s}'`).join(',')})`

// 会社設定: スタッフアプリに支払額を表示するか（既定 OFF）
export function staffPayVisible(settingsJson: any): boolean {
  try { const v = JSON.parse(settingsJson || '{}')?.staff_pay_visible; return v === true || v === 1 } catch { return false }
}
const isMonth = (s: any) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
const monthEnd = (m: string) => addDays(addDays(m + '-01', 32).slice(0, 7) + '-01', -1)
// 開始から終了までの分（終了が開始以前なら翌日）
const spanOf = (start: string, end: string) => { const s = toMin(start); let e = toMin(end); if (e <= s) e += 1440; return e - s }
const cleanText = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const yenText = (n: number) => `${Math.round(n).toLocaleString('ja-JP')}円`

// 申請できない理由（申請できるなら null）。closed は締めた期間のシフトか
function requestBlock(s: any, now: string, closed: boolean): string | null {
  if (!isWorkingShift(s.status)) return '確定・代打のシフトだけ申請できます'
  if (s.settle_status === 'confirmed') return '精算が確定済みのシフトです。申請が必要な場合は管理者に連絡してください'
  if (closed) return '精算を締めた期間のシフトです。申請が必要な場合は管理者に連絡してください'
  if (shiftWindow(s.work_date, s.start_time, s.end_time).start > now) return '勤務が始まってから申請できます'
  const d = correctionDeadlineDays(s.settings_json)
  if (d && addDays(s.work_date, d) < now.slice(0, 10)) return `申請は勤務日から${d}日以内です。申請が必要な場合は管理者に連絡してください`
  return null
}

// 締めた期間（会社ごと）
async function loadClosingRanges(db: D1Database, companyIds: number[], from: string, to: string) {
  const ids = bindJsonArray(companyIds)
  if (ids === '[]') return [] as { company_id: number; period_from: string; period_to: string }[]
  return (await db.prepare(`SELECT company_id, period_from, period_to FROM settlement_closings
    WHERE company_id IN ${JSON_IN} AND reopened_at IS NULL AND period_from <= ? AND period_to >= ?`).bind(ids, to, from).all()).results as any[]
}
const inClosing = (list: { company_id: number; period_from: string; period_to: string }[], companyId: number, date: string) =>
  list.some(k => Number(k.company_id) === Number(companyId) && k.period_from <= date && date <= k.period_to)

// 申請の表示用（スタッフ・管理者共通）
function requestView(q: any) {
  return {
    request_id: q.request_id, shift_id: q.shift_id, kind: q.kind, status: q.status, created_at: q.created_at,
    amount: q.amount, route: q.route, round_trip: !!q.round_trip, before_amount: q.before_amount,
    new_end_time: q.new_end_time, before_end_time: q.before_end_time, instructed_by: q.instructed_by, reason: q.reason,
    decided_by_name: q.decided_by_name, decided_at: q.decided_at, decision_note: q.decision_note, approved_amount: q.approved_amount, approved_end_time: q.approved_end_time,
  }
}

// =========================================================
// スタッフ API（/api/staff/pay*）
// =========================================================
export const staffPayStaffApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 月（month=YYYY-MM。既定は今月）の自分のシフトの実働時間・支払額・申請と、月の集計
staffPayStaffApi.get('/pay', async (c) => {
  const db = c.env.DB
  const now = nowJST(), today = now.slice(0, 10)
  const month = isMonth(c.req.query('month')) ? c.req.query('month')! : today.slice(0, 7)
  const from = month + '-01', to = monthEnd(month)
  const mine = await personStaffRows(db, c.get('user'))
  const staffIds = mine.map(r => r.staff_id)
  const empty = { month, from, to, pay_visible: false, multi_company: mine.length > 1, shifts: [], summary: { worked_days: 0, worked_hours: 0, scheduled_days: 0, scheduled_hours: 0, pay: null } }
  if (!staffIds.length) return c.json(empty)
  // 勤務（確定・代打）と、補償を入れた欠勤（#283）のシフト。希望（仮）は勤務ではないので出さない
  const rows = (await db.prepare(`SELECT s.shift_id, s.company_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.break_minutes,
      s.actual_start, s.actual_end, s.actual_break_minutes, s.actual_source, s.settle_status, s.transportation_fee,
      s.unit_price, s.bill_transport_type, s.bill_transport_amount, s.bill_adjust,
      s.pay_unit_type, s.pay_rate, s.pay_qty, s.pay_amount, s.pay_transport_type, s.pay_transport_amount, s.pay_adjust, s.payee_type,
      p.project_name, p.hours_basis, p.time_round_minutes, p.pay_time_round, p.default_break_minutes, co.company_name, co.settings_json,
      sc.shift_id AS cx_shift_id, sc.pay_amount AS cx_pay
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN companies co ON co.company_id = s.company_id
    LEFT JOIN shift_cancellations sc ON sc.shift_id = s.shift_id AND sc.company_id = s.company_id
    WHERE s.staff_id IN ${JSON_IN} AND s.work_date BETWEEN ? AND ? AND (s.status IN ${WORKING_IN} OR (s.status = 'absent' AND sc.shift_id IS NOT NULL))
    ORDER BY s.work_date, s.start_time, s.shift_id`).bind(bindJsonArray(staffIds), from, to).all()).results as any[]
  const shiftIds = rows.map(r => r.shift_id)
  const reqs = shiftIds.length ? (await db.prepare(`SELECT * FROM staff_pay_requests WHERE shift_id IN ${JSON_IN} AND staff_id IN ${JSON_IN} ORDER BY request_id`)
    .bind(bindJsonArray(shiftIds), bindJsonArray(staffIds)).all()).results as any[] : []
  const closings = await loadClosingRanges(db, [...new Set(rows.map(r => Number(r.company_id)))], from, to)
  const visibleOf = new Map<number, boolean>()
  for (const r of rows) if (!visibleOf.has(r.company_id)) visibleOf.set(r.company_id, staffPayVisible(r.settings_json))
  const anyVisible = [...visibleOf.values()].some(Boolean)

  let workedDays = new Set<string>(), workedHours = 0, schedDays = new Set<string>(), schedHours = 0
  let confirmedTotal = 0, estimateTotal = 0, payUnset = 0, payShifts = 0
  const shifts = rows.map(s => {
    const cancel = s.status === 'absent'
    const proj = { hours_basis: s.hours_basis, time_round_minutes: s.time_round_minutes, pay_time_round: s.pay_time_round, default_break_minutes: s.default_break_minutes }
    const h = workHours(s, proj)
    const started = shiftWindow(s.work_date, s.start_time, s.end_time).start <= now
    if (!cancel) {
      if (started) { workedDays.add(s.work_date); workedHours += h.pay_hours } else { schedDays.add(s.work_date); schedHours += h.pay_hours }
    }
    const settled = s.settle_status === 'confirmed'
    // 支払額（#290）: 会社の設定が ON で、支払先が本人のシフトだけ
    let pay: any = null
    if (visibleOf.get(s.company_id) && SELF_PAYEES.includes(s.payee_type || 'payroll')) {
      if (cancel) pay = { unit_type: null, rate: null, qty: null, base: s.cx_pay == null ? null : Number(s.cx_pay), transport: 0, adjust: 0, total: s.cx_pay == null ? null : Number(s.cx_pay) }
      else {
        const t = shiftTotals(s)
        pay = { unit_type: s.pay_unit_type || 'daily', rate: s.pay_rate ?? null, qty: s.pay_qty ?? null, base: s.pay_amount == null ? null : Number(s.pay_amount),
          transport: t.pay_transport, adjust: Number(s.pay_adjust || 0), total: t.pay_total }
      }
      payShifts++
      if (pay.total == null) payUnset++
      else { estimateTotal += pay.total; if (settled) confirmedTotal += pay.total }
    }
    const closed = inClosing(closings, s.company_id, s.work_date)
    const block = cancel ? '欠勤のシフトです' : requestBlock(s, now, closed)
    return {
      shift_id: s.shift_id, work_date: s.work_date, project_name: s.project_name, company_name: mine.length > 1 ? s.company_name : null,
      start_time: s.start_time, end_time: s.end_time, status: s.status, kind: cancel ? 'cancel' : 'work',
      // 実働（#274）: 時給の計算に使う時間（pay_hours）と、その元の実績。actual_source: report（報告から）/ manual（管理者が入力）
      // 管理者のメモ（actual_note）は社内の記録のため返さない（#520）
      planned_hours: cancel ? 0 : h.planned_hours, hours: cancel ? 0 : h.pay_hours, actual_hours: cancel ? null : h.actual_hours,
      actual_start: cancel ? null : s.actual_start || null, actual_end: cancel ? null : s.actual_end || null,
      break_minutes: cancel ? null : h.break_minutes, planned_break_minutes: h.planned_break_minutes,
      actual_source: cancel ? null : s.actual_source || null, settled, started, closed,
      transportation_fee: Number(s.transportation_fee || 0), pay,
      requests: reqs.filter(q => q.shift_id === s.shift_id).map(requestView),
      request_block: block,
    }
  })
  const round2 = (n: number) => Math.round(n * 100) / 100
  return c.json({
    month, from, to, today, pay_visible: anyVisible, multi_company: mine.length > 1, shifts,
    summary: {
      worked_days: workedDays.size, worked_hours: round2(workedHours), scheduled_days: schedDays.size, scheduled_hours: round2(schedHours),
      pay: anyVisible ? { confirmed_total: confirmedTotal, estimate_total: estimateTotal, unset: payUnset, shifts: payShifts } : null,
    },
    limits: { transport_max: TRANSPORT_MAX, overtime_max_minutes: OVERTIME_MAX_MINUTES },
  })
})

// 申請: { shift_id, kind: 'transport', amount, route, round_trip, reason } / { shift_id, kind: 'overtime', new_end_time, instructed_by, reason }
staffPayStaffApi.post('/pay/requests', async (c) => {
  const db = c.env.DB; const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  if (!oneOf(b.kind, PAY_REQUEST_KINDS)) return c.json({ error: '申請の種類が正しくありません' }, 400)
  const mine = await personStaffRows(db, u)
  const staffIds = mine.map(r => r.staff_id)
  const shiftId = toInt(b.shift_id, 1)
  const s = shiftId ? await db.prepare(`SELECT s.*, co.settings_json, p.project_name FROM shifts s JOIN companies co ON co.company_id = s.company_id
    JOIN projects p ON p.project_id = s.project_id WHERE s.shift_id = ?`).bind(shiftId).first() as any : null
  if (!s || !staffIds.includes(s.staff_id)) return c.json({ error: 'シフトが見つかりません' }, 404)
  const now = nowJST()
  const block = requestBlock(s, now, !!(await closedMessage(db, s.company_id, s.work_date)))
  if (block) return c.json({ error: block }, 409)
  const kind = b.kind as typeof PAY_REQUEST_KINDS[number]
  const dup = await db.prepare(`SELECT request_id FROM staff_pay_requests WHERE shift_id = ? AND staff_id = ? AND kind = ? AND status = 'pending'`).bind(s.shift_id, s.staff_id, kind).first()
  if (dup) return c.json({ error: `このシフトには承認待ちの${PAY_REQUEST_KIND_LABEL[kind]}の申請があります。直す場合は、取り消してから出し直してください` }, 409)
  const recent = await db.prepare(`SELECT COUNT(*) AS n FROM staff_pay_requests WHERE staff_id IN ${JSON_IN} AND created_at >= datetime(?, '-1 hour')`)
    .bind(bindJsonArray(staffIds), now).first() as any
  if (Number(recent?.n || 0) >= HOURLY_LIMIT) return c.json({ error: '申請が多すぎます。しばらくしてからお試しください' }, 429)
  const reason = cleanText(b.reason, TEXT_MAX)
  let lines: string[]
  let ins: D1PreparedStatement
  if (kind === 'transport') {
    const amount = toInt(b.amount, 1, TRANSPORT_MAX)
    if (amount == null) return c.json({ error: `金額は1〜${TRANSPORT_MAX.toLocaleString('ja-JP')}円の整数で入力してください` }, 400)
    const route = cleanText(b.route, 100)
    if (!route) return c.json({ error: '区間を入力してください（例: 新宿駅〜渋谷駅）' }, 400)
    const roundTrip = b.round_trip ? 1 : 0
    ins = db.prepare(`INSERT INTO staff_pay_requests (company_id, shift_id, staff_id, kind, status, amount, route, round_trip, before_amount, reason, requested_by, created_at)
      VALUES (?, ?, ?, 'transport', 'pending', ?, ?, ?, ?, ?, ?, ?) RETURNING request_id`)
      .bind(s.company_id, s.shift_id, s.staff_id, amount, route, roundTrip, Number(s.transportation_fee || 0), reason || null, u.user_id, now)
    lines = [`金額: ${yenText(amount)}（${roundTrip ? '往復' : '片道'}）`, `区間: ${route}`]
  } else {
    if (!isHHMM(b.new_end_time)) return c.json({ error: '延長後の終了時刻を入力してください' }, 400)
    const cur = spanOf(s.start_time, s.end_time), next = spanOf(s.start_time, b.new_end_time)
    if (next <= cur) return c.json({ error: `延長後の終了時刻は、今の予定の終了（${s.end_time}）より後にしてください` }, 400)
    if (next - cur > OVERTIME_MAX_MINUTES || next >= 1440) return c.json({ error: `延長は${OVERTIME_MAX_MINUTES / 60}時間までです（勤務は24時間未満）` }, 400)
    if (!reason) return c.json({ error: '延長の理由を入力してください' }, 400)
    const instructed = cleanText(b.instructed_by, 50)
    ins = db.prepare(`INSERT INTO staff_pay_requests (company_id, shift_id, staff_id, kind, status, new_end_time, before_end_time, instructed_by, reason, requested_by, created_at)
      VALUES (?, ?, ?, 'overtime', 'pending', ?, ?, ?, ?, ?, ?) RETURNING request_id`)
      .bind(s.company_id, s.shift_id, s.staff_id, b.new_end_time, s.end_time, instructed || null, reason, u.user_id, now)
    lines = [`予定: ${s.start_time}〜${s.end_time} → 終了 ${b.new_end_time}（+${next - cur}分）`, `指示した人: ${instructed || '（記入なし）'}`]
  }
  const row = await ins.first() as any
  const label = PAY_REQUEST_KIND_LABEL[kind]
  await notifyCompanyAdmins(db, s.company_id, 'pay_request_submitted', `${label}の申請: ${u.name || ''} ${mdText(s.work_date)} ${s.project_name || ''}`,
    [...lines, ...(reason ? [`理由: ${reason}`] : []), '精算の画面の「スタッフからの申請」で承認・却下してください'].join('\n'), '/admin#settlement', row.request_id)
  return c.json({ ok: true, request_id: row.request_id })
})

// 本人の取り消し（承認待ちのものだけ）
staffPayStaffApi.post('/pay/requests/:id{[0-9]+}/cancel', async (c) => {
  const db = c.env.DB
  const staffIds = (await personStaffRows(db, c.get('user'))).map(r => r.staff_id)
  const q = await db.prepare(`SELECT request_id, status FROM staff_pay_requests WHERE request_id = ? AND staff_id IN ${JSON_IN}`).bind(Number(c.req.param('id')), bindJsonArray(staffIds)).first() as any
  if (!q) return c.json({ error: '申請が見つかりません' }, 404)
  const r = await db.prepare(`UPDATE staff_pay_requests SET status = 'cancelled', decided_at = ? WHERE request_id = ? AND status = 'pending'`).bind(nowJST(), q.request_id).run()
  if (!r.meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
  return c.json({ ok: true })
})

// =========================================================
// 管理者 API（/api/admin/pay-requests*・/api/admin/staff-pay/settings）
// =========================================================
export const staffPayAdminApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const LIST_LIMIT = 200
const DONE_MESSAGE: Record<string, string> = { approved: 'この申請はすでに承認されています', rejected: 'この申請はすでに却下されています', cancelled: 'この申請はスタッフが取り消しました' }

// 一覧（status=pending: 承認待ち（既定）/ all: 直近の申請）。承認できない理由（shift_issue）も付ける
staffPayAdminApi.get('/pay-requests', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const all = c.req.query('status') === 'all'
  const rows = (await db.prepare(`SELECT q.*, s.work_date, s.start_time, s.end_time, s.status AS shift_status, s.staff_id AS shift_staff_id, s.settle_status,
      s.transportation_fee, s.pay_transport_type, s.pay_transport_amount, s.pay_unit_type, s.price_locked, p.project_name, us.name AS staff_name
    FROM staff_pay_requests q LEFT JOIN shifts s ON s.shift_id = q.shift_id AND s.company_id = q.company_id LEFT JOIN projects p ON p.project_id = s.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = q.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE q.company_id = ? ${all ? '' : "AND q.status = 'pending'"} ORDER BY q.request_id DESC LIMIT ${LIST_LIMIT}`).bind(u.company_id).all()).results as any[]
  const dates = rows.map(r => r.work_date).filter(Boolean).sort()
  const closings = dates.length ? await loadClosingRanges(db, [u.company_id], dates[0], dates[dates.length - 1]) : []
  const pending = all ? Number(((await db.prepare(`SELECT COUNT(*) AS n FROM staff_pay_requests WHERE company_id = ? AND status = 'pending'`).bind(u.company_id).first()) as any)?.n || 0)
    : rows.length
  return c.json({
    pending,
    requests: rows.map(r => ({
      ...requestView(r), staff_id: r.staff_id, staff_name: r.staff_name || '', project_name: r.project_name || '',
      work_date: r.work_date || null, start_time: r.start_time || null, end_time: r.end_time || null,
      transportation_fee: r.transportation_fee == null ? null : Number(r.transportation_fee), pay_transport_type: r.pay_transport_type || 'actual',
      pay_transport_amount: Number(r.pay_transport_amount || 0), pay_unit_type: r.pay_unit_type || 'daily', price_locked: !!r.price_locked,
      shift_issue: r.status !== 'pending' ? null : approveBlock(r, !!r.work_date && inClosing(closings, u.company_id, r.work_date)),
    })),
  })
})

// 承認できない理由（承認できるなら null）。r は申請とシフトの行（shift_status・shift_staff_id・settle_status）
function approveBlock(r: any, closed: boolean): string | null {
  if (!r.work_date) return 'シフトが削除されています。却下してください'
  if (Number(r.shift_staff_id) !== Number(r.staff_id)) return 'シフトの担当者が変わっています。却下してください'
  if (!isWorkingShift(r.shift_status)) return '欠勤・未確定のシフトです。却下してください'
  if (r.settle_status === 'confirmed') return '精算が確定済みのシフトです。承認するには確定を取り消してください'
  if (closed) return '精算を締めた期間のシフトです。承認するには締めを解除してください'
  return null
}
async function loadForDecision(c: any) {
  const u = c.get('user'); const db: D1Database = c.env.DB
  return await db.prepare(`SELECT q.*, s.work_date, s.start_time, s.end_time, s.status AS shift_status, s.staff_id AS shift_staff_id, s.settle_status, s.company_id AS shift_company_id,
      s.transportation_fee AS shift_transport, p.project_name
    FROM staff_pay_requests q LEFT JOIN shifts s ON s.shift_id = q.shift_id AND s.company_id = q.company_id LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE q.request_id = ? AND q.company_id = ?`).bind(Number(c.req.param('id')), u.company_id).first() as any
}

// 承認: 交通費は { amount?（直した金額）, note? }、延長は { end_time?（直した終了時刻）, note? }
staffPayAdminApi.post('/pay-requests/:id{[0-9]+}/approve', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const q = await loadForDecision(c)
  if (!q) return c.json({ error: '申請が見つかりません' }, 404)
  if (q.status !== 'pending') return c.json({ error: DONE_MESSAGE[q.status] || 'この申請は処理済みです' }, 409)
  const closed = q.work_date ? await closedMessage(db, u.company_id, q.work_date) : null
  const block = approveBlock(q, !!closed)
  if (block) return c.json({ error: block }, 409)
  const note = cleanText(b.note, TEXT_MAX) || null
  const now = nowJST()
  const decide = db.prepare(`UPDATE staff_pay_requests SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_note = ?, approved_amount = ?, approved_end_time = ?
    WHERE request_id = ? AND status = 'pending'`)
  // シフトの更新は、この承認で申請の状態を変えたときだけ効かせる（同時に承認・取り消しされたときに二重に反映しない）
  const decidedNow = `EXISTS (SELECT 1 FROM staff_pay_requests WHERE request_id = ? AND status = 'approved' AND decided_at = ? AND decided_by = ?)`
  let stmts: D1PreparedStatement[]
  let resultLine: string
  if (q.kind === 'transport') {
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? Number(q.amount) : toInt(b.amount, 0, TRANSPORT_MAX)
    if (amount == null) return c.json({ error: `金額は0〜${TRANSPORT_MAX.toLocaleString('ja-JP')}円の整数で入力してください` }, 400)
    stmts = [decide.bind(u.user_id, u.name || null, now, note, amount, null, q.request_id),
      db.prepare(`UPDATE shifts SET transportation_fee = ? WHERE shift_id = ? AND company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed' AND ${decidedNow}`)
        .bind(amount, q.shift_id, u.company_id, q.request_id, now, u.user_id)]
    resultLine = `交通費（実費）: ${yenText(amount)}${amount !== Number(q.amount) ? `（申請 ${yenText(Number(q.amount))} から管理者が変更）` : ''}`
  } else {
    const end = b.end_time === undefined || b.end_time === null || b.end_time === '' ? q.new_end_time : b.end_time
    if (!isHHMM(end)) return c.json({ error: '終了時刻を HH:MM で入力してください' }, 400)
    const cur = spanOf(q.start_time, q.end_time), next = spanOf(q.start_time, end)
    if (next <= cur) return c.json({ error: `延長後の終了時刻は、今の予定の終了（${q.end_time}）より後にしてください` }, 400)
    if (next - cur > OVERTIME_MAX_MINUTES || next >= 1440) return c.json({ error: `延長は${OVERTIME_MAX_MINUTES / 60}時間までです（勤務は24時間未満）` }, 400)
    // 同じスタッフの別の勤務と時間が重なる延長は承認しない
    const w = shiftWindow(q.work_date, q.start_time, end)
    const others = (await db.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, p.project_name FROM shifts s JOIN projects p ON p.project_id = s.project_id
      WHERE s.staff_id = ? AND s.shift_id != ? AND s.status IN ${WORKING_IN} AND s.work_date BETWEEN ? AND ?`)
      .bind(q.staff_id, q.shift_id, addDays(q.work_date, -1), addDays(q.work_date, 1)).all()).results as any[]
    const hit = others.find(o => o.start_time && o.end_time && overlaps(w, shiftWindow(o.work_date, o.start_time, o.end_time)))
    if (hit) return c.json({ error: `同じスタッフの別のシフト（${mdText(hit.work_date)} ${hit.start_time}〜${hit.end_time} ${hit.project_name}）と時間が重なるため、延長できません` }, 409)
    stmts = [decide.bind(u.user_id, u.name || null, now, note, null, end, q.request_id),
      db.prepare(`UPDATE shifts SET end_time = ? WHERE shift_id = ? AND company_id = ? AND COALESCE(settle_status,'planned') != 'confirmed' AND ${decidedNow}`)
        .bind(end, q.shift_id, u.company_id, q.request_id, now, u.user_id)]
    resultLine = `予定の終了: ${q.end_time} → ${end}${end !== q.new_end_time ? `（申請 ${q.new_end_time} から管理者が変更）` : ''}`
  }
  const res = await db.batch(stmts)
  if (!res[0].meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
  // 延長: 時給のシフトは、延ばした予定で数量・金額を計算し直す（日給は変わらない。手動で数量を固定したシフトは変えない）
  if (q.kind === 'overtime') await refreshShiftAmounts(db, u.company_id, q.shift_id)
  const label = PAY_REQUEST_KIND_LABEL[q.kind]
  await notifyShiftStaff(db, { company_id: u.company_id, staff_id: q.staff_id }, 'pay_request_approved', `${label}の申請が承認されました: ${mdText(q.work_date)} ${q.project_name || ''}`,
    [resultLine, ...(note ? [`管理者より: ${note}`] : [])].join('\n'), `#pay/${String(q.work_date).slice(0, 7)}`, q.request_id)
  return c.json({ ok: true })
})

// 却下: { note（理由。必須） }
staffPayAdminApi.post('/pay-requests/:id{[0-9]+}/reject', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const q = await loadForDecision(c)
  if (!q) return c.json({ error: '申請が見つかりません' }, 404)
  if (q.status !== 'pending') return c.json({ error: DONE_MESSAGE[q.status] || 'この申請は処理済みです' }, 409)
  const note = cleanText(b.note, TEXT_MAX)
  if (!note) return c.json({ error: '却下の理由を入力してください（スタッフに伝わります）' }, 400)
  const r = await db.prepare(`UPDATE staff_pay_requests SET status = 'rejected', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_note = ? WHERE request_id = ? AND status = 'pending'`)
    .bind(u.user_id, u.name || null, nowJST(), note, q.request_id).run()
  if (!r.meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
  const label = PAY_REQUEST_KIND_LABEL[q.kind]
  await notifyShiftStaff(db, { company_id: u.company_id, staff_id: q.staff_id }, 'pay_request_rejected', `${label}の申請が却下されました: ${mdText(q.work_date)} ${q.project_name || ''}`,
    `却下の理由: ${note}`, `#pay/${String(q.work_date || '').slice(0, 7)}`, q.request_id)
  return c.json({ ok: true })
})

// スタッフアプリに支払額を表示するか（#290。変更は会社管理者のみ）
staffPayAdminApi.get('/staff-pay/settings', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ staff_pay_visible: staffPayVisible(row?.settings_json), can_edit: u.role === 'company_admin' })
})
staffPayAdminApi.put('/staff-pay/settings', async (c) => {
  const u = c.get('user')
  if (u.role !== 'company_admin') return c.json({ error: 'この設定は会社管理者だけが変更できます' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  if (typeof b.staff_pay_visible !== 'boolean') return c.json({ error: 'staff_pay_visible を true / false で指定してください' }, 400)
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.staff_pay_visible', json(?)) WHERE company_id = ?`)
    .bind(b.staff_pay_visible ? 'true' : 'false', u.company_id).run()
  return c.json({ ok: true, staff_pay_visible: b.staff_pay_visible })
})
