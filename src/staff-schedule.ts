// =========================================================
// 出勤可能日の提出（#171）と、確定シフトのカレンダー追加（#301）。作業単位 w5-staff-schedule
//
// 出勤可能日（staff_availability）:
//   スタッフが月のカレンダーで日ごとに ○（終日可 ok）/ △（時間帯なら可 partial）/ ×（不可 ng）を付け、月の分をまとめて提出する。
//   提出できるのは今月〜3か月先の月の、今日以降の日だけ（過ぎた日は提出した内容のまま残す）。
//   提出は月単位の置き換え（今日以降の日は、送られた日の分だけになる）。提出の記録は availability_submissions に残す。
//   管理者は月ごとに締切と案内文を決め（availability_periods）、提出状況・日付×スタッフの一覧を見て、未提出の人にアプリ内通知を送る。
//   シフト（shifts）・案件を指定したシフト希望（shift_requests）とは別に持ち、シフトの登録には影響しない。
//
// カレンダー（.ics）:
//   ・1件ずつ: GET /api/staff/shifts/:id/ics（ログイン中の本人のシフトだけ）
//   ・購読: GET /api/public/calendar/<トークン>.ics（ログイン不要。トークンは1人1つでハッシュで保存し、発行し直す・止めると前の URL は使えない）
//   どちらも確定・代打のシフトだけを出し、金額は含めない。欠勤にしたシフト・削除したシフトは購読のカレンダーから消える
// =========================================================
import { Hono } from 'hono'
import { personStaffRows } from './roster'
import { hashToken, isCompanyActive } from './lib/auth'
import { isHHMM, isISODate, toInt } from './lib/validate'
import { assignableStaffSql } from './lib/staff-eligibility'
import { addDays, shiftWindow } from './lib/shift-time'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { WORKING_SHIFT_STATUSES } from './lib/shift-status'

type Bindings = { DB: D1Database; APP_BASE_URL?: string }
type Variables = { user: any }

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}
// 'YYYY-MM' の月初と翌月の月初
const monthStart = (month: string) => month + '-01'
const nextMonthStart = (month: string) => addMonths(month, 1) + '-01'
const fmtMD = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

export const AVAILABILITY_STATUSES = ['ok', 'partial', 'ng'] as const
// スタッフが提出できる月（今月〜この月数先まで）
const AVAILABILITY_MONTHS_AHEAD = 3
const AVAILABILITY_NOTE_MAX = 100
const PERIOD_NOTE_MAX = 300
// 未提出の人への通知を、続けて押して二重に送らないための間隔（分）
const REMIND_INTERVAL_MINUTES = 10
export const AVAILABILITY_REQUEST_KIND = 'availability_request'

// スタッフが提出できる月の一覧（今月から）
function submittableMonths(today: string): string[] {
  const cur = today.slice(0, 7)
  return Array.from({ length: AVAILABILITY_MONTHS_AHEAD + 1 }, (_, i) => addMonths(cur, i))
}

async function loadPeriod(db: D1Database, companyId: number, month: string) {
  return await db.prepare('SELECT deadline, note, last_reminded_at FROM availability_periods WHERE company_id = ? AND month = ?').bind(companyId, month).first() as any
}
// 締切の後に（最初に）提出したか
const isLate = (submittedAt: string | null | undefined, deadline: string | null | undefined) => !!(submittedAt && deadline && String(submittedAt).slice(0, 10) > deadline)

// =========================================================
// スタッフ本人（/api/staff/*）
// =========================================================
export const scheduleStaffApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 月の出勤可能日（本人の入力・締切・提出の記録と、参考にその月のシフト）。?month= の既定は翌月
scheduleStaffApi.get('/availability', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ error: 'スタッフ情報が見つかりません' }, 403)
  const today = todayJST()
  const months = submittableMonths(today)
  const q = c.req.query('month')
  // 見るだけなら先月も開ける（提出は今月から）
  const month = isMonth(q) && q >= addMonths(months[0], -1) && q <= months[months.length - 1] ? q : months[1]
  const from = monthStart(month), to = nextMonthStart(month)
  const days = (await db.prepare(`SELECT work_date, status, start_time, end_time, note FROM staff_availability
    WHERE staff_id = ? AND work_date >= ? AND work_date < ? ORDER BY work_date`).bind(u.staff_id, from, to).all()).results
  const sub = await db.prepare('SELECT submitted_at, updated_at FROM availability_submissions WHERE staff_id = ? AND month = ?').bind(u.staff_id, month).first() as any
  const period = await loadPeriod(db, u.company_id, month)
  // 参考: その月に入っているシフト（同じ人のほかの会社の分も。案件名は自社の分だけ）。欠勤は出さない
  const ids = (await personStaffRows(db, u)).map(r => r.staff_id)
  if (!ids.length) ids.push(u.staff_id)
  const shifts = (await db.prepare(`SELECT s.work_date, s.start_time, s.end_time, s.status, (s.company_id != ?) AS other_company,
      CASE WHEN s.company_id = ? THEN p.project_name END AS project_name
    FROM shifts s LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE s.staff_id IN ${JSON_IN} AND s.work_date >= ? AND s.work_date < ? AND s.status != 'absent' ORDER BY s.work_date, s.start_time`)
    .bind(u.company_id, u.company_id, bindJsonArray(ids), from, to).all()).results
  return c.json({
    month, months, today, editable: months.includes(month), editable_from: today > from ? today : from,
    deadline: period?.deadline || null, note: period?.note || null,
    submitted_at: sub?.submitted_at || null, updated_at: sub?.updated_at || null, late: isLate(sub?.submitted_at, period?.deadline),
    days, shifts,
  })
})

// シフト画面の案内用: 翌月の提出状況と締切だけ
scheduleStaffApi.get('/availability/summary', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ month: null })
  const month = addMonths(todayJST().slice(0, 7), 1)
  const sub = await db.prepare('SELECT submitted_at FROM availability_submissions WHERE staff_id = ? AND month = ?').bind(u.staff_id, month).first() as any
  const period = await loadPeriod(db, u.company_id, month)
  return c.json({ month, submitted: !!sub, submitted_at: sub?.submitted_at || null, deadline: period?.deadline || null })
})

// 月の出勤可能日をまとめて提出する。days: [{ date, status: ok|partial|ng, start_time, end_time, note }]。
// その月の今日以降の日は、送った日の分だけに置き換える（送らなかった日は未入力に戻る）
scheduleStaffApi.put('/availability', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ error: 'スタッフ情報が見つかりません' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const today = todayJST()
  const month = b.month
  if (!isMonth(month) || !submittableMonths(today).includes(month)) return c.json({ error: `提出できるのは今月から${AVAILABILITY_MONTHS_AHEAD}か月先までです` }, 400)
  if (!Array.isArray(b.days)) return c.json({ error: '日ごとの入力が正しくありません' }, 400)
  if (b.days.length > 31) return c.json({ error: '日付が多すぎます' }, 400)
  const from = monthStart(month), to = nextMonthStart(month)
  const editableFrom = today > from ? today : from
  const rows: { d: string; s: string; st: string | null; et: string | null; n: string | null }[] = []
  const seen = new Set<string>()
  for (const x of b.days) {
    const d = x && x.date
    if (!isISODate(d) || d < from || d >= to) return c.json({ error: 'この月の日付ではありません' }, 400)
    if (d < editableFrom) return c.json({ error: `過ぎた日（${fmtMD(d)}）は変更できません` }, 400)
    if (seen.has(d)) return c.json({ error: `${fmtMD(d)} が2回入っています` }, 400)
    seen.add(d)
    if (!AVAILABILITY_STATUSES.includes(x.status)) return c.json({ error: `${fmtMD(d)} の入力（○△×）が正しくありません` }, 400)
    let st: string | null = null, et: string | null = null
    if (x.status === 'partial') {
      if (!isHHMM(x.start_time) || !isHHMM(x.end_time)) return c.json({ error: `${fmtMD(d)} の時間帯（△）は開始と終了を HH:MM で入力してください` }, 400)
      if (x.start_time === x.end_time) return c.json({ error: `${fmtMD(d)} の時間帯の開始と終了が同じです` }, 400)
      st = x.start_time; et = x.end_time
    }
    if (x.note != null && typeof x.note !== 'string') return c.json({ error: '備考が正しくありません' }, 400)
    const n = String(x.note || '').trim()
    if (n.length > AVAILABILITY_NOTE_MAX) return c.json({ error: `備考は${AVAILABILITY_NOTE_MAX}文字以内で入力してください（${fmtMD(d)}）` }, 400)
    rows.push({ d, s: x.status, st, et, n: n || null })
  }
  if (!rows.length) return c.json({ error: '1日以上、○△×を付けてください' }, 400)
  const now = nowJST()
  await db.batch([
    db.prepare('DELETE FROM staff_availability WHERE staff_id = ? AND work_date >= ? AND work_date < ?').bind(u.staff_id, editableFrom, to),
    db.prepare(`INSERT INTO staff_availability (company_id, staff_id, work_date, status, start_time, end_time, note, updated_at)
      SELECT ?, ?, json_extract(j.value, '$.d'), json_extract(j.value, '$.s'), json_extract(j.value, '$.st'), json_extract(j.value, '$.et'), json_extract(j.value, '$.n'), ?
      FROM json_each(?) AS j`).bind(u.company_id, u.staff_id, now, JSON.stringify(rows)),
    db.prepare(`INSERT INTO availability_submissions (company_id, staff_id, month, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (staff_id, month) DO UPDATE SET updated_at = excluded.updated_at`).bind(u.company_id, u.staff_id, month, now, now),
  ])
  const sub = await db.prepare('SELECT submitted_at, updated_at FROM availability_submissions WHERE staff_id = ? AND month = ?').bind(u.staff_id, month).first() as any
  const period = await loadPeriod(db, u.company_id, month)
  return c.json({ ok: true, month, count: rows.length, submitted_at: sub?.submitted_at, updated_at: sub?.updated_at, late: isLate(sub?.submitted_at, period?.deadline) })
})

// ---------- カレンダー（#301） ----------
function genToken(): string {
  const a = new Uint8Array(32); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}
function baseUrl(c: any): string {
  return String(c.env.APP_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '')
}

// 購読 URL の状態（URL そのものはハッシュで保存しているため返せない。分からなくなったら発行し直す）
scheduleStaffApi.get('/calendar-token', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT created_at, last_accessed_at FROM staff_calendar_tokens WHERE user_id = ?').bind(u.user_id).first() as any
  return c.json({ active: !!row, created_at: row?.created_at || null, last_accessed_at: row?.last_accessed_at || null })
})
// 購読 URL を発行する（すでにあれば発行し直し、前の URL は使えなくなる）
scheduleStaffApi.post('/calendar-token', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ error: 'スタッフ情報が見つかりません' }, 403)
  const token = genToken()
  await db.prepare(`INSERT INTO staff_calendar_tokens (user_id, company_id, token_hash, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, company_id = excluded.company_id, created_at = excluded.created_at, last_accessed_at = NULL`)
    .bind(u.user_id, u.company_id, await hashToken(token), nowJST()).run()
  return c.json({ ok: true, url: `${baseUrl(c)}/api/public/calendar/${token}.ics` })
})
// 購読 URL を止める
scheduleStaffApi.delete('/calendar-token', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare('DELETE FROM staff_calendar_tokens WHERE user_id = ?').bind(u.user_id).run()
  return c.json({ ok: true, deleted: r.meta.changes || 0 })
})

// シフト1件の .ics（本人＝同じ人のほかの会社の分も含む。確定・代打だけ）
scheduleStaffApi.get('/shifts/:id/ics', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const id = toInt(c.req.param('id'), 1)
  const ids = (await personStaffRows(db, u)).map(r => r.staff_id)
  if (!ids.length && u.staff_id) ids.push(u.staff_id)
  const rows = id == null || !ids.length ? [] : await loadCalendarShifts(db, ids, { shiftId: id })
  if (!rows.length) return c.json({ error: '確定したシフトが見つかりません（仮押さえ・欠勤のシフトはカレンダーに追加できません）' }, 404)
  const multi = rows[0].company_id !== u.company_id
  const ics = buildCalendar(rows, { appUrl: baseUrl(c) + '/staff#shift', showCompany: multi, name: 'Field OS シフト' })
  return new Response(ics, { headers: {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="shift-${rows[0].work_date.replace(/-/g, '')}-${rows[0].shift_id}.ics"`,
    'Cache-Control': 'no-store',
  } })
})

// =========================================================
// 購読用（ログイン不要。/api/public/calendar/<トークン>.ics）
// =========================================================
export const calendarPublicApi = new Hono<{ Bindings: Bindings }>()
// 購読で出す期間（過ぎたシフトも少し残し、カレンダーから急に消えないようにする）
const FEED_PAST_DAYS = 31
const FEED_FUTURE_DAYS = 120
const FEED_MAX_EVENTS = 400

calendarPublicApi.get('/:file', async (c) => {
  const db = c.env.DB
  const token = String(c.req.param('file') || '').replace(/\.ics$/i, '')
  const notFound = () => c.text('このカレンダーの URL は使えません。アプリの「カレンダーに追加」で URL を発行し直してください', 404, { 'Cache-Control': 'no-store' })
  if (!/^[0-9a-f]{64}$/.test(token)) return notFound()
  const t = await db.prepare(`SELECT t.user_id, t.last_accessed_at, us.company_id, us.person_id, us.status, us.role, sp.staff_id,
      co.company_name, co.settings_json, co.active_status
    FROM staff_calendar_tokens t JOIN users us ON us.user_id = t.user_id AND us.company_id = t.company_id
    JOIN companies co ON co.company_id = us.company_id
    LEFT JOIN staff_profiles sp ON sp.user_id = us.user_id
    WHERE t.token_hash = ?`).bind(await hashToken(token)).first() as any
  // 退職・停止の人と、停止中の企業には返さない
  if (!t || t.status !== 'active' || t.role !== 'staff' || !t.staff_id || !isCompanyActive(t.active_status)) return notFound()
  const u = { user_id: t.user_id, company_id: t.company_id, staff_id: t.staff_id, person_id: t.person_id, company_name: t.company_name, settings_json: t.settings_json }
  const persons = await personStaffRows(db, u)
  const ids = persons.map(r => r.staff_id)
  if (!ids.length) ids.push(t.staff_id)
  const today = todayJST()
  const rows = await loadCalendarShifts(db, ids, { from: addDays(today, -FEED_PAST_DAYS), to: addDays(today, FEED_FUTURE_DAYS) })
  // 最後に読まれた日（1日1回だけ書く）
  if (!t.last_accessed_at || String(t.last_accessed_at).slice(0, 10) < today) {
    await db.prepare('UPDATE staff_calendar_tokens SET last_accessed_at = ? WHERE user_id = ?').bind(nowJST(), t.user_id).run()
  }
  const multi = new Set(persons.map(r => r.company_id)).size > 1
  const ics = buildCalendar(rows, { appUrl: baseUrl(c) + '/staff#shift', showCompany: multi, name: 'Field OS シフト', feed: true })
  return new Response(ics, { headers: {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'private, max-age=600',
    'X-Robots-Tag': 'noindex',
  } })
})

// カレンダーに出すシフト（確定・代打）。開催場所・役割・休憩・枠のメモを付ける。金額の列は読まない
async function loadCalendarShifts(db: D1Database, staffIds: number[], opt: { shiftId?: number; from?: string; to?: string }): Promise<any[]> {
  const where = [`s.staff_id IN ${JSON_IN}`, `s.status IN ('${WORKING_SHIFT_STATUSES.join("','")}')`]
  const binds: any[] = [bindJsonArray(staffIds)]
  if (opt.shiftId != null) { where.push('s.shift_id = ?'); binds.push(opt.shiftId) }
  if (opt.from) { where.push('s.work_date >= ?'); binds.push(opt.from) }
  if (opt.to) { where.push('s.work_date <= ?'); binds.push(opt.to) }
  return (await db.prepare(`SELECT s.shift_id, s.company_id, s.work_date, s.start_time, s.end_time, s.status, s.location, s.role,
      COALESCE(s.break_minutes, sl.break_minutes, p.default_break_minutes) AS break_minutes,
      p.project_name, co.company_name, si.site_name, si.address AS site_address, sl.memo AS slot_memo
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN companies co ON co.company_id = s.company_id
    LEFT JOIN sites si ON si.site_id = s.site_id AND si.company_id = s.company_id
    LEFT JOIN shift_slots sl ON sl.slot_id = s.slot_id AND sl.company_id = s.company_id
    WHERE ${where.join(' AND ')} ORDER BY s.work_date, s.start_time LIMIT ?`).bind(...binds, FEED_MAX_EVENTS).all()).results as any[]
}

// ---------- iCalendar（RFC 5545）の組み立て ----------
// 文字列の値のエスケープ（\ ; , 改行）
const icsText = (v: unknown) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
// 1行は 75 バイトまで。超える分は改行＋空白で折り返す（UTF-8 の文字の途中では切らない）
function foldLine(line: string): string {
  const out: string[] = []
  let cur = '', bytes = 0
  for (const ch of line) {
    const cp = ch.codePointAt(0) as number
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0 }
    cur += ch; bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}
// 日本時間の 'YYYY-MM-DD HH:MM:SS' を UTC の 'YYYYMMDDTHHMMSSZ' に
function icsUtc(jst: string): string {
  return new Date(Date.parse(jst.replace(' ', 'T') + '+09:00')).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}
const hm = (t: string) => String(t || '').slice(0, 5)

export function buildCalendar(rows: any[], opt: { appUrl: string; showCompany: boolean; name: string; feed?: boolean }): string {
  const stamp = icsUtc(nowJST())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Field OS//Shift Calendar//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(opt.name)}`, 'X-WR-TIMEZONE:Asia/Tokyo']
  if (opt.feed) lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT3H', 'X-PUBLISHED-TTL:PT3H')
  for (const s of rows) {
    const w = shiftWindow(s.work_date, hm(s.start_time), hm(s.end_time))
    const place = s.site_name || s.location || ''
    const end = hm(s.end_time) <= hm(s.start_time) ? `翌${hm(s.end_time)}` : hm(s.end_time)
    const desc = [
      opt.showCompany ? `会社: ${s.company_name}` : '',
      `案件: ${s.project_name}`,
      `時間: ${hm(s.start_time)}〜${end}${Number(s.break_minutes) > 0 ? `（休憩 ${Number(s.break_minutes)}分）` : ''}`,
      s.status === 'substitute' ? '代打のシフトです' : '',
      s.role ? `役割: ${s.role}` : '',
      place ? `場所: ${place}` : '',
      s.site_address ? `住所: ${s.site_address}` : '',
      s.slot_memo ? `メモ: ${s.slot_memo}` : '',
      `シフトの確認・報告: ${opt.appUrl}`,
    ].filter(Boolean).join('\n')
    lines.push('BEGIN:VEVENT',
      `UID:shift-${Number(s.shift_id)}@field-os`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsUtc(w.start)}`,
      `DTEND:${icsUtc(w.end)}`,
      `SUMMARY:${icsText(`${s.project_name}${opt.showCompany ? `（${s.company_name}）` : ''}`)}`,
      ...(place || s.site_address ? [`LOCATION:${icsText([place, s.site_address].filter(Boolean).join(' '))}`] : []),
      `DESCRIPTION:${icsText(desc)}`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

// =========================================================
// 管理者（/api/admin/*）
// =========================================================
export const scheduleAdminApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 提出を集める対象: その月の初日に割り当てられるスタッフ（退職・統合・取引終了・スキルシートのみを除く）
function availabilityStaffWhere(month: string) {
  const elig = assignableStaffSql({ sp: 'sp', us: 'us', onDate: monthStart(month) })
  return { sql: `sp.company_id = ? AND us.role IN ('staff', 'roster_only') AND ${elig.sql}`, binds: elig.binds }
}

// 月の提出状況と、日付×スタッフの一覧。marks は日ごとの1文字（o=○ p=△ x=× -=未入力）、shift_days はシフトの入っている日（DD）
scheduleAdminApi.get('/availability', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const today = todayJST()
  const q = c.req.query('month')
  const month = isMonth(q) ? q : addMonths(today.slice(0, 7), 1)
  const from = monthStart(month), to = nextMonthStart(month)
  const dayCount = Number(addDays(to, -1).slice(8, 10))
  const w = availabilityStaffWhere(month)
  const staff = (await db.prepare(`SELECT sp.staff_id, us.name, us.role,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana,
      COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type, sub.submitted_at, sub.updated_at
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN availability_submissions sub ON sub.staff_id = sp.staff_id AND sub.month = ?
    WHERE ${w.sql}
    ORDER BY (sub.submitted_at IS NOT NULL), COALESCE(CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END, us.name), sp.staff_id`).bind(month, u.company_id, ...w.binds).all()).results as any[]
  // 日ごとの記号は staff_id ごとに1行にまとめて取る（人数×日数の行を返さない）
  const marks = (await db.prepare(`SELECT staff_id, GROUP_CONCAT(substr(work_date, 9, 2) || status) AS m FROM staff_availability
    WHERE company_id = ? AND work_date >= ? AND work_date < ? GROUP BY staff_id`).bind(u.company_id, from, to).all()).results as any[]
  const details = (await db.prepare(`SELECT staff_id, work_date, status, start_time, end_time, note FROM staff_availability
    WHERE company_id = ? AND work_date >= ? AND work_date < ? AND (status = 'partial' OR note IS NOT NULL) ORDER BY staff_id, work_date`).bind(u.company_id, from, to).all()).results as any[]
  const shiftDays = (await db.prepare(`SELECT staff_id, GROUP_CONCAT(DISTINCT substr(work_date, 9, 2)) AS d FROM shifts
    WHERE company_id = ? AND work_date >= ? AND work_date < ? AND status != 'absent' GROUP BY staff_id`).bind(u.company_id, from, to).all()).results as any[]
  const code: Record<string, string> = { ok: 'o', partial: 'p', ng: 'x' }
  const markOf = new Map<number, string>()
  for (const r of marks) {
    const a = Array(dayCount).fill('-')
    for (const x of String(r.m || '').split(',')) { const d = Number(x.slice(0, 2)); if (d >= 1 && d <= dayCount) a[d - 1] = code[x.slice(2)] || '-' }
    markOf.set(r.staff_id, a.join(''))
  }
  const shiftOf = new Map<number, string[]>(shiftDays.map(r => [r.staff_id, String(r.d || '').split(',').filter(Boolean)]))
  const period = await loadPeriod(db, u.company_id, month)
  const blank = '-'.repeat(dayCount)
  return c.json({
    month, today, days: dayCount, deadline: period?.deadline || null, note: period?.note || null, last_reminded_at: period?.last_reminded_at || null,
    staff: staff.map(s => ({ staff_id: s.staff_id, name: s.name, kana: s.kana, affiliation_type: s.affiliation_type, has_login: s.role === 'staff',
      submitted_at: s.submitted_at || null, updated_at: s.updated_at || null, late: isLate(s.submitted_at, period?.deadline),
      marks: markOf.get(s.staff_id) || blank, shift_days: shiftOf.get(s.staff_id) || [] })),
    details: details.filter(d => staff.some(s => s.staff_id === d.staff_id)),
  })
})

// 締切と案内文（month は今月の前後。deadline は空欄で締切なし）
scheduleAdminApi.put('/availability/period', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const cur = todayJST().slice(0, 7)
  if (!isMonth(b.month) || b.month < addMonths(cur, -1) || b.month > addMonths(cur, 12)) return c.json({ error: '月が正しくありません' }, 400)
  const deadline = b.deadline == null || b.deadline === '' ? null : b.deadline
  if (deadline != null && !isISODate(deadline)) return c.json({ error: '締切日が正しくありません' }, 400)
  if (deadline && deadline >= nextMonthStart(b.month)) return c.json({ error: '締切日はその月の末日までにしてください' }, 400)
  if (b.note != null && typeof b.note !== 'string') return c.json({ error: '案内文が正しくありません' }, 400)
  const note = String(b.note || '').trim()
  if (note.length > PERIOD_NOTE_MAX) return c.json({ error: `案内文は${PERIOD_NOTE_MAX}文字以内で入力してください` }, 400)
  await db.prepare(`INSERT INTO availability_periods (company_id, month, deadline, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, month) DO UPDATE SET deadline = excluded.deadline, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(u.company_id, b.month, deadline, note || null, u.user_id, nowJST()).run()
  return c.json({ ok: true, month: b.month, deadline, note: note || null })
})

// 未提出の人（ログインできるスタッフ）へアプリ内通知で提出を頼む
scheduleAdminApi.post('/availability/remind', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const today = todayJST()
  if (!isMonth(b.month) || !submittableMonths(today).includes(b.month)) return c.json({ error: '提出を頼めるのは今月から先の月です' }, 400)
  const period = await loadPeriod(db, u.company_id, b.month)
  const since = new Date(Date.now() + 9 * 3600 * 1000 - REMIND_INTERVAL_MINUTES * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const now = nowJST()
  // 送る権利を先に1回の書き込みで取る（ほかの管理者・別のタブから同時に押されても、通知は1回分だけにする）
  const claimed = await db.prepare(`INSERT INTO availability_periods (company_id, month, last_reminded_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (company_id, month) DO UPDATE SET last_reminded_at = excluded.last_reminded_at
      WHERE availability_periods.last_reminded_at IS NULL OR availability_periods.last_reminded_at <= ?
    RETURNING month`).bind(u.company_id, b.month, now, u.user_id, now, since).first()
  if (!claimed) return c.json({ error: `さきほど通知しました。続けて送る場合は${REMIND_INTERVAL_MINUTES}分ほど待ってください` }, 409)
  const m = Number(b.month.slice(5, 7))
  const title = `${m}月の出勤可能日を提出してください`
  const body = [period?.deadline ? `締切: ${fmtMD(period.deadline)}` : '', 'アプリの「シフト」→「出勤可能日を提出」から、日ごとに ○△× を付けて提出してください', period?.note || ''].filter(Boolean).join('\n')
  const w = availabilityStaffWhere(b.month)
  try {
    const r = await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT sp.company_id, us.user_id, ?, ?, ?, ?, NULL, ? FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
      WHERE ${w.sql} AND us.role = 'staff'
        AND NOT EXISTS (SELECT 1 FROM availability_submissions sub WHERE sub.staff_id = sp.staff_id AND sub.month = ?)`)
      .bind(AVAILABILITY_REQUEST_KIND, title, body, `#availability/${b.month}`, now, u.company_id, ...w.binds, b.month).run()
    return c.json({ ok: true, sent: r.meta.changes || 0 })
  } catch (e) {
    // 送れなかったときは、すぐに押し直せるよう前回の通知日時に戻す
    await db.prepare('UPDATE availability_periods SET last_reminded_at = ? WHERE company_id = ? AND month = ? AND last_reminded_at = ?')
      .bind(period?.last_reminded_at ?? null, u.company_id, b.month, now).run()
    throw e
  }
})

// ある日の出勤可能日（シフトを組むときの参考。staff_id ごと）
scheduleAdminApi.get('/availability/day', async (c) => {
  const u = c.get('user')
  const date = c.req.query('date')
  if (!isISODate(date)) return c.json({ error: '日付が正しくありません' }, 400)
  const rows = (await c.env.DB.prepare(`SELECT staff_id, status, start_time, end_time, note FROM staff_availability WHERE company_id = ? AND work_date = ?`)
    .bind(u.company_id, date).all()).results
  return c.json({ date, availability: rows })
})
