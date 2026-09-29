// =========================================================
// 募集ページ（公開URL・QR）/ 応募 / 承認でシフト確定・仮登録の自動作成 / 既存スタッフの応募
// docs/spec_spot_shift.md 第4段階
//
// - 管理者向け: recruitAdminApi（/api/admin/*。権限ミドルウェアの後に登録）
// - ログイン不要の公開ページ: recruitPublicApi（/api/public/recruit/*。認証ミドルウェアの前に登録）
// - スタッフアプリ: recruitStaffApi（/api/staff/recruit/*）
// 応募はすべて管理者の承認で確定する。公開ページには金額・案件名・クライアント名を出さない（表示文言は管理者が入力する）。
// =========================================================
import { Hono } from 'hono'
import { applyPricingToShift, conflictFor, findConflicts, loadPricingData, ngStaffIds } from './shift-board'
import { findStaffByPhone, insertProvisionalStaff, normalizePhone } from './staff-lifecycle'

type Bindings = { DB: D1Database; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string }
type Variables = { user: any }

// ---------- 定数 ----------
const MAX_PAGE_DAYS = 62
const MAX_SLOTS_PER_APPLY = 31
const RATE_PER_IP_HOUR = 5        // 同じ接続元からの送信は1時間に5件まで
const RATE_PER_PHONE_DAY = 3      // 同じ電話番号からの送信は1日に3件まで（募集ページごと）
const MIN_FILL_MS = 3000          // 表示から3秒未満の送信は機械的な送信とみなす
const NEW_STAFF_TYPES = ['daily_worker', 'freelance', 'partner_manual', 'own_employee']

// ---------- ユーティリティ ----------
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
function addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
function dayDiff(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) }
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
function randToken(bytes = 18): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const str = (v: any, max: number) => String(v ?? '').trim().slice(0, max)
function parseIds(v: any): number[] {
  const arr = Array.isArray(v) ? v : String(v || '').split(',')
  return [...new Set(arr.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
}
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

// 募集ページの対象となる枠（役割）と残り人数
async function openRoles(db: D1Database, page: any, opts: { fromDate?: string; roleIds?: number[] } = {}) {
  const pids = parseIds(page.project_ids)
  if (!pids.length) return []
  const from = [page.date_from, opts.fromDate || todayJST()].sort().pop()!
  const w = [`sl.company_id = ?`, `sl.project_id IN (${pids.map(() => '?').join(',')})`, `sl.work_date BETWEEN ? AND ?`, `COALESCE(sl.status,'open') = 'open'`]
  const bind: any[] = [page.company_id, ...pids, from, page.date_to]
  if (opts.roleIds) { if (!opts.roleIds.length) return []; w.push(`r.slot_role_id IN (${opts.roleIds.map(() => '?').join(',')})`); bind.push(...opts.roleIds) }
  const rows = (await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes,
      COALESCE(si.site_name, sl.location, p.location, '') AS place, si.address AS site_address,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = r.slot_role_id AND s.status != 'absent') AS assigned,
      (SELECT COUNT(*) FROM recruit_application_items i WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending') AS pending
    FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id JOIN projects p ON p.project_id = sl.project_id
    LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE ${w.join(' AND ')} ORDER BY sl.work_date, sl.start_time, r.sort_order, r.slot_role_id LIMIT 500`).bind(...bind).all()).results as any[]
  return rows.map(r => ({ ...r, remaining: Math.max(0, Number(r.headcount) - Number(r.assigned)) }))
}
async function loadPageByToken(db: D1Database, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return null
  return db.prepare(`SELECT rp.*, co.company_name FROM recruit_pages rp JOIN companies co ON co.company_id = rp.company_id WHERE rp.token = ?`).bind(token).first() as Promise<any>
}
function pageIsOpen(p: any) { return p && p.status === 'open' && p.date_to >= todayJST() }

// 公開・スタッフ向けの枠の表示（金額・案件名・クライアント名は出さない）
function publicRole(r: any, showRemaining: boolean) {
  return {
    slot_role_id: r.slot_role_id, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time, break_minutes: r.break_minutes,
    place: r.place, role_name: r.role_name, full: r.remaining <= 0, ...(showRemaining ? { remaining: r.remaining, headcount: r.headcount } : {}),
  }
}

// =========================================================
// 公開ページ（ログイン不要）
// =========================================================
export const recruitPublicApi = new Hono<{ Bindings: Bindings }>()

recruitPublicApi.get('/:token', async (c) => {
  const page = await loadPageByToken(c.env.DB, c.req.param('token'))
  if (!page) return c.json({ error: 'この募集ページは見つかりません' }, 404)
  if (!pageIsOpen(page)) return c.json({ error: 'この募集は終了しました', closed: true, title: page.title, company_name: page.company_name }, 410)
  const roles = await openRoles(c.env.DB, page)
  return c.json({
    title: page.title, company_name: page.company_name, description: page.description || '', pay_note: page.pay_note || '', contact_note: page.contact_note || '',
    date_from: page.date_from, date_to: page.date_to, roles: roles.map(r => publicRole(r, !!page.show_remaining)),
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null, issued_at: Date.now(),
  })
})

async function verifyTurnstile(secret: string, token: string, ip: string | undefined) {
  try {
    const fd = new FormData(); fd.append('secret', secret); fd.append('response', token || ''); if (ip) fd.append('remoteip', ip)
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd })
    const j = await r.json() as any
    return !!j.success
  } catch { return false }
}

recruitPublicApi.post('/:token/apply', async (c) => {
  const db = c.env.DB
  const page = await loadPageByToken(db, c.req.param('token'))
  if (!page) return c.json({ error: 'この募集ページは見つかりません' }, 404)
  if (!pageIsOpen(page)) return c.json({ error: 'この募集は終了しました' }, 410)
  const b = await c.req.json().catch(() => ({} as any))
  // 機械的な送信の対策: 入力欄に見えない項目（website）に値がある / 表示から送信までが短すぎる → 受け付けたように見せて保存しない
  const issued = Number(b.issued_at || 0)
  if (str(b.website, 200) || !issued || Date.now() - issued < MIN_FILL_MS) return c.json({ ok: true })
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || ''
  if (c.env.TURNSTILE_SECRET_KEY) {
    if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, str(b.turnstile_token, 2048), ip))) return c.json({ error: '確認に失敗しました。ページを再読み込みしてもう一度お試しください' }, 400)
  }
  const name = str(b.name, 60), kana = str(b.kana, 60), email = str(b.email, 120), note = str(b.note, 500)
  const phone = normalizePhone(b.phone)
  if (!name) return c.json({ error: 'お名前を入力してください' }, 400)
  if (phone.length < 10 || phone.length > 11) return c.json({ error: '電話番号を正しく入力してください' }, 400)
  if (email && !isEmail(email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
  if (!b.agree) return c.json({ error: '個人情報の取り扱いに同意してください' }, 400)
  const roleIds = parseIds(b.slot_role_ids)
  if (!roleIds.length) return c.json({ error: '希望する日時を選択してください' }, 400)
  if (roleIds.length > MAX_SLOTS_PER_APPLY) return c.json({ error: `一度に選べるのは${MAX_SLOTS_PER_APPLY}件までです` }, 400)

  // 送信回数の制限（IPはそのまま保存せず、ハッシュのみ）
  const ipHash = ip ? await sha256(`recruit|${ip}|${c.env.TURNSTILE_SECRET_KEY || 'field-os'}`) : null
  if (ipHash) {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE ip_hash = ? AND created_at >= ?`).bind(ipHash, addHourJST(-1)).first() as any
    if (n?.n >= RATE_PER_IP_HOUR) return c.json({ error: '送信回数が多すぎます。しばらくしてからお試しください' }, 429)
  }
  const pn = await db.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE page_id = ? AND phone = ? AND created_at >= ?`).bind(page.page_id, phone, todayJST() + ' 00:00:00').first() as any
  if (pn?.n >= RATE_PER_PHONE_DAY) return c.json({ error: '本日の応募回数の上限に達しました。お問い合わせ先へご連絡ください' }, 429)

  const roles = await openRoles(db, page, { roleIds })
  if (!roles.length) return c.json({ error: '選択した日時は募集が終了しました。ページを再読み込みしてください' }, 409)
  // 同じ電話番号で同じ枠にすでに未対応の応募がある場合は重複させない
  const dupRows = (await db.prepare(`SELECT i.slot_role_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.phone = ? AND i.status IN ('pending','approved') AND i.slot_role_id IN (${roles.map(() => '?').join(',')})`)
    .bind(page.company_id, phone, ...roles.map(r => r.slot_role_id)).all()).results as any[]
  const dup = new Set(dupRows.map(r => r.slot_role_id))
  const targets = roles.filter(r => !dup.has(r.slot_role_id))
  if (!targets.length) return c.json({ ok: true, count: 0, message: '選択した日時はすでに応募済みです' })

  const app = await db.prepare(`INSERT INTO recruit_applications (company_id, page_id, source, name, kana, phone, email, note, ip_hash, created_at)
    VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?, ?)`).bind(page.company_id, page.page_id, name, kana || null, phone, email || null, note || null, ipHash, nowJST()).run()
  const appId = app.meta.last_row_id
  await db.batch(targets.map(r => db.prepare('INSERT OR IGNORE INTO recruit_application_items (application_id, slot_role_id) VALUES (?, ?)').bind(appId, r.slot_role_id)))
  return c.json({ ok: true, count: targets.length, full_count: targets.filter(r => r.remaining <= 0).length })
})
function addHourJST(h: number) { return new Date(Date.now() + (9 + h) * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }

// =========================================================
// スタッフアプリ（登録済みスタッフの応募）
// =========================================================
export const recruitStaffApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()
// スタッフ（ログインできるスタッフ）のみ。管理者アカウントなどは応募できない
recruitStaffApi.use('/*', async (c, next) => {
  const u = c.get('user')
  if (!u || u.role !== 'staff' || !u.staff_id) return c.json({ error: 'forbidden' }, 403)
  return next()
})

recruitStaffApi.get('/', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ pages: [], applications: [] })
  const pages = ((await db.prepare(`SELECT * FROM recruit_pages WHERE company_id = ? AND status = 'open' AND allow_staff = 1 AND date_to >= ? ORDER BY date_from`)
    .bind(u.company_id, todayJST()).all()).results as any[])
  // 自分のシフト（同じ時間帯の確認用）と応募状況
  const mine = ((await db.prepare(`SELECT i.slot_role_id, i.status FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.staff_id = ? AND i.status IN ('pending','approved')`).bind(u.company_id, u.staff_id).all()).results as any[])
  const mineMap = new Map(mine.map(r => [r.slot_role_id, r.status]))
  const assigned = new Set(((await db.prepare(`SELECT slot_role_id FROM shifts WHERE staff_id = ? AND slot_role_id IS NOT NULL AND status != 'absent' AND work_date >= ?`)
    .bind(u.staff_id, todayJST()).all()).results as any[]).map(r => r.slot_role_id))
  const out = []
  for (const p of pages) {
    const roles = await openRoles(db, p)
    out.push({ page_id: p.page_id, title: p.title, description: p.description || '', pay_note: p.pay_note || '', date_from: p.date_from, date_to: p.date_to,
      roles: roles.map(r => ({ ...publicRole(r, !!p.show_remaining), my_status: assigned.has(r.slot_role_id) ? 'assigned' : mineMap.get(r.slot_role_id) || null })) })
  }
  const apps = ((await db.prepare(`SELECT i.item_id, i.status, i.slot_role_id, a.application_id, a.created_at, sl.work_date, sl.start_time, sl.end_time, r.role_name,
      COALESCE(si.site_name, sl.location, '') AS place
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE a.company_id = ? AND a.staff_id = ? AND sl.work_date >= ? ORDER BY sl.work_date, sl.start_time LIMIT 100`).bind(u.company_id, u.staff_id, addDays(todayJST(), -7)).all()).results as any[])
  return c.json({ pages: out, applications: apps })
})

recruitStaffApi.post('/apply', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  if (!u.staff_id) return c.json({ error: 'スタッフ情報が見つかりません' }, 400)
  const page = await db.prepare(`SELECT * FROM recruit_pages WHERE page_id = ? AND company_id = ? AND allow_staff = 1`).bind(b.page_id, u.company_id).first() as any
  if (!pageIsOpen(page)) return c.json({ error: 'この募集は終了しました' }, 410)
  const roleIds = parseIds(b.slot_role_ids)
  if (!roleIds.length) return c.json({ error: '希望する日時を選択してください' }, 400)
  if (roleIds.length > MAX_SLOTS_PER_APPLY) return c.json({ error: `一度に選べるのは${MAX_SLOTS_PER_APPLY}件までです` }, 400)
  const roles = await openRoles(db, page, { roleIds })
  if (!roles.length) return c.json({ error: '選択した日時は募集が終了しました' }, 409)
  const exists = new Set(((await db.prepare(`SELECT i.slot_role_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.staff_id = ? AND i.status IN ('pending','approved')`).bind(u.company_id, u.staff_id).all()).results as any[]).map(r => r.slot_role_id))
  const assigned = new Set(((await db.prepare(`SELECT slot_role_id FROM shifts WHERE staff_id = ? AND slot_role_id IS NOT NULL AND status != 'absent'`).bind(u.staff_id).all()).results as any[]).map(r => r.slot_role_id))
  const targets = roles.filter(r => !exists.has(r.slot_role_id) && !assigned.has(r.slot_role_id))
  if (!targets.length) return c.json({ ok: true, count: 0, message: '選択した日時はすでに応募済みです' })
  const me = await db.prepare('SELECT us.name, us.phone, us.email, sp.kana FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(u.staff_id).first() as any
  const app = await db.prepare(`INSERT INTO recruit_applications (company_id, page_id, source, staff_id, name, kana, phone, email, note, created_at)
    VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, page.page_id, u.staff_id, me?.name || u.name, me?.kana || null, normalizePhone(me?.phone) || null, me?.email || null, str(b.note, 500) || null, nowJST()).run()
  await db.batch(targets.map(r => db.prepare('INSERT OR IGNORE INTO recruit_application_items (application_id, slot_role_id) VALUES (?, ?)').bind(app.meta.last_row_id, r.slot_role_id)))
  return c.json({ ok: true, count: targets.length })
})

recruitStaffApi.post('/items/:id/cancel', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const it = await db.prepare(`SELECT i.*, a.application_id AS aid FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE i.item_id = ? AND a.company_id = ? AND a.staff_id = ?`).bind(c.req.param('id'), u.company_id, u.staff_id).first() as any
  if (!it) return c.json({ error: '応募が見つかりません' }, 404)
  if (it.status !== 'pending') return c.json({ error: '承認済み・対応済みの応募は取り下げできません。管理者に連絡してください' }, 409)
  await db.prepare("UPDATE recruit_application_items SET status = 'cancelled', decided_at = ? WHERE item_id = ?").bind(nowJST(), it.item_id).run()
  await closeIfDone(db, it.aid)
  return c.json({ ok: true })
})

async function closeIfDone(db: D1Database, applicationId: number, byUserId?: number | null) {
  const left = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS c, COUNT(*) AS t FROM recruit_application_items WHERE application_id = ? AND status = 'pending'").bind(applicationId).first() as any
  if (left?.n) return
  const all = await db.prepare("SELECT COUNT(*) AS t, SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS c FROM recruit_application_items WHERE application_id = ?").bind(applicationId).first() as any
  const status = all?.t && all.t === all.c ? 'cancelled' : 'done'
  await db.prepare('UPDATE recruit_applications SET status = ?, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?) WHERE application_id = ?')
    .bind(status, nowJST(), byUserId ?? null, applicationId).run()
}

// =========================================================
// 管理者
// =========================================================
export const recruitAdminApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function pageValues(b: any, cur: any = {}) {
  const v = {
    title: b.title !== undefined ? str(b.title, 80) : cur.title,
    description: b.description !== undefined ? str(b.description, 2000) || null : cur.description,
    pay_note: b.pay_note !== undefined ? str(b.pay_note, 200) || null : cur.pay_note,
    contact_note: b.contact_note !== undefined ? str(b.contact_note, 200) || null : cur.contact_note,
    project_ids: b.project_ids !== undefined ? parseIds(b.project_ids).join(',') : cur.project_ids,
    date_from: b.date_from !== undefined ? b.date_from : cur.date_from,
    date_to: b.date_to !== undefined ? b.date_to : cur.date_to,
    show_remaining: b.show_remaining !== undefined ? (b.show_remaining ? 1 : 0) : (cur.show_remaining ?? 1),
    allow_staff: b.allow_staff !== undefined ? (b.allow_staff ? 1 : 0) : (cur.allow_staff ?? 1),
    status: b.status === 'closed' || b.status === 'open' ? b.status : (cur.status || 'open'),
  }
  let error: string | null = null
  if (!v.title) error = '募集のタイトルを入力してください'
  else if (!v.project_ids) error = '対象の案件を選択してください'
  else if (!isDate(v.date_from) || !isDate(v.date_to) || dayDiff(v.date_from, v.date_to) < 0) error = '期間を正しく入力してください'
  else if (dayDiff(v.date_from, v.date_to) > MAX_PAGE_DAYS - 1) error = `期間は${MAX_PAGE_DAYS}日以内で指定してください`
  return { v, error }
}
async function checkProjects(db: D1Database, companyId: number, ids: string) {
  const list = parseIds(ids)
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE company_id = ? AND project_id IN (${list.map(() => '?').join(',')})`).bind(companyId, ...list).first() as any
  return n?.n === list.length
}

recruitAdminApi.get('/recruit-pages', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const rows = ((await db.prepare(`SELECT rp.*,
      (SELECT COUNT(*) FROM recruit_applications a WHERE a.page_id = rp.page_id AND a.status = 'pending') AS pending_count,
      (SELECT COUNT(*) FROM recruit_applications a WHERE a.page_id = rp.page_id) AS application_count
    FROM recruit_pages rp WHERE rp.company_id = ? ORDER BY rp.status = 'open' DESC, rp.date_from DESC, rp.page_id DESC LIMIT 200`).bind(u.company_id).all()).results as any[])
  const projects = ((await db.prepare('SELECT project_id, project_name FROM projects WHERE company_id = ?').bind(u.company_id).all()).results as any[])
  const pname = new Map(projects.map(p => [p.project_id, p.project_name]))
  const out = []
  for (const r of rows) {
    const roles = r.status === 'open' && r.date_to >= todayJST() ? await openRoles(db, r) : []
    out.push({ ...r, project_names: parseIds(r.project_ids).map(id => pname.get(id) || `#${id}`), open_roles: roles.length,
      open_remaining: roles.reduce((n, x) => n + x.remaining, 0), is_open: pageIsOpen(r) })
  }
  return c.json({ pages: out, turnstile_enabled: !!(c.env.TURNSTILE_SITE_KEY && c.env.TURNSTILE_SECRET_KEY) })
})

recruitAdminApi.post('/recruit-pages', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const { v, error } = pageValues(b)
  if (error) return c.json({ error }, 400)
  if (!(await checkProjects(db, u.company_id, v.project_ids))) return c.json({ error: '案件が見つかりません' }, 404)
  const token = randToken(18)
  const r = await db.prepare(`INSERT INTO recruit_pages (company_id, token, title, description, pay_note, contact_note, project_ids, date_from, date_to, show_remaining, allow_staff, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`).bind(u.company_id, token, v.title, v.description, v.pay_note, v.contact_note, v.project_ids, v.date_from, v.date_to, v.show_remaining, v.allow_staff, u.user_id).run()
  return c.json({ ok: true, page_id: r.meta.last_row_id, token })
})

recruitAdminApi.put('/recruit-pages/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const cur = await db.prepare('SELECT * FROM recruit_pages WHERE page_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '募集ページが見つかりません' }, 404)
  const { v, error } = pageValues(b, cur)
  if (error) return c.json({ error }, 400)
  if (!(await checkProjects(db, u.company_id, v.project_ids))) return c.json({ error: '案件が見つかりません' }, 404)
  const token = b.regenerate_token ? randToken(18) : cur.token // URLを再発行すると、以前のURL・QRは使えなくなる
  await db.prepare(`UPDATE recruit_pages SET title = ?, description = ?, pay_note = ?, contact_note = ?, project_ids = ?, date_from = ?, date_to = ?, show_remaining = ?, allow_staff = ?,
      status = ?, token = ?, closed_at = CASE WHEN ? = 'closed' AND status != 'closed' THEN ? WHEN ? = 'open' THEN NULL ELSE closed_at END WHERE page_id = ?`)
    .bind(v.title, v.description, v.pay_note, v.contact_note, v.project_ids, v.date_from, v.date_to, v.show_remaining, v.allow_staff, v.status, token, v.status, nowJST(), v.status, cur.page_id).run()
  return c.json({ ok: true, token })
})

recruitAdminApi.delete('/recruit-pages/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const cur = await db.prepare('SELECT page_id FROM recruit_pages WHERE page_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '募集ページが見つかりません' }, 404)
  const n = await db.prepare('SELECT COUNT(*) AS n FROM recruit_applications WHERE page_id = ?').bind(cur.page_id).first() as any
  if (n?.n) return c.json({ error: '応募がある募集ページは削除できません。「募集を終了」を使ってください' }, 409)
  await db.prepare('DELETE FROM recruit_pages WHERE page_id = ?').bind(cur.page_id).run()
  return c.json({ ok: true })
})

// 応募一覧（枠の情報・残り人数・重複の警告・電話番号が一致する登録済みスタッフ）
recruitAdminApi.get('/recruit-applications', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const status = c.req.query('status') || 'pending'
  const w = ['a.company_id = ?']; const bind: any[] = [u.company_id]
  if (['pending', 'done', 'cancelled'].includes(status)) { w.push('a.status = ?'); bind.push(status) }
  if (c.req.query('page_id')) { w.push('a.page_id = ?'); bind.push(Number(c.req.query('page_id'))) }
  const apps = ((await db.prepare(`SELECT a.*, rp.title AS page_title, us.name AS staff_name, sp.is_provisional, COALESCE(sp.affiliation_type,'own_employee') AS staff_affiliation_type
    FROM recruit_applications a LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = a.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE ${w.join(' AND ')} ORDER BY a.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`).bind(...bind).all()).results as any[])
  if (!apps.length) return c.json({ applications: [], counts: await counts(db, u.company_id) })
  const ids = apps.map(a => a.application_id)
  const items = ((await db.prepare(`SELECT i.*, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.work_date, sl.start_time, sl.end_time, p.project_name,
      COALESCE(si.site_name, sl.location, '') AS place,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = i.slot_role_id AND s.status != 'absent') AS assigned
    FROM recruit_application_items i JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    JOIN projects p ON p.project_id = sl.project_id LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE i.application_id IN (${ids.map(() => '?').join(',')}) ORDER BY sl.work_date, sl.start_time`).bind(...ids).all()).results as any[])
  // 登録済みスタッフの重複（同じ時間帯のシフト）
  const staffIds = [...new Set(apps.map(a => a.staff_id).filter(Boolean))] as number[]
  const dates = items.map(i => i.work_date).sort()
  const conflicts = staffIds.length && dates.length ? await findConflicts(db, u.company_id, staffIds, dates[0], dates[dates.length - 1]) : new Map()
  const out = []
  for (const a of apps) {
    const its = items.filter(i => i.application_id === a.application_id).map(i => ({
      ...i, remaining: Math.max(0, i.headcount - i.assigned), past: i.work_date < todayJST(),
      conflicts: a.staff_id && i.status === 'pending' ? conflictFor(conflicts.get(a.staff_id), i.work_date, i.start_time, i.end_time).map((x: any) => (x.company_id === u.company_id ? x.project_name : x.company_name + '（他社）') + ' ' + x.start_time + '〜' + x.end_time) : [],
    }))
    const matches = !a.staff_id && a.phone ? await findStaffByPhone(db, u.company_id, a.phone) : []
    out.push({ ...a, ip_hash: undefined, items: its, phone_matches: matches })
  }
  return c.json({ applications: out, counts: await counts(db, u.company_id) })
})
async function counts(db: D1Database, companyId: number) {
  const r = await db.prepare(`SELECT COUNT(*) AS pending, SUM(CASE WHEN source = 'public' THEN 1 ELSE 0 END) AS pending_public FROM recruit_applications WHERE company_id = ? AND status = 'pending'`).bind(companyId).first() as any
  return { pending: r?.pending || 0, pending_public: r?.pending_public || 0 }
}
recruitAdminApi.get('/recruit-applications/summary', async (c) => c.json(await counts(c.env.DB, c.get('user').company_id)))

// 承認・見送り
// body: { approve: [item_id], reject: [item_id], staff_id?: 既存スタッフに紐づけ, new_staff_type?: 仮登録の区分, partner_affiliation_id?, force? }
recruitAdminApi.post('/recruit-applications/:id/decide', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const a = await db.prepare('SELECT * FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const approveIds = parseIds(b.approve), rejectIds = parseIds(b.reject)
  if (!approveIds.length && !rejectIds.length) return c.json({ error: '承認または見送りする日時を選択してください' }, 400)
  if (approveIds.some(id => rejectIds.includes(id))) return c.json({ error: '同じ日時を承認と見送りの両方に指定しています' }, 400)
  const items = ((await db.prepare(`SELECT i.*, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.site_id, sl.location, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = i.slot_role_id AND s.status != 'absent') AS assigned
    FROM recruit_application_items i JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE i.application_id = ? AND sl.company_id = ?`).bind(a.application_id, u.company_id).all()).results as any[])
  const byId = new Map(items.map(i => [i.item_id, i]))
  for (const id of [...approveIds, ...rejectIds]) {
    const it = byId.get(id)
    if (!it) return c.json({ error: '応募の日時が見つかりません' }, 404)
    if (it.status !== 'pending') return c.json({ error: `${it.work_date} ${it.start_time} の応募はすでに対応済みです` }, 409)
  }
  const toApprove = approveIds.map(id => byId.get(id)!)

  // スタッフの決定（承認がある場合のみ）: 応募者のスタッフ / 指定した既存スタッフ / 仮登録の作成
  let staffId: number | null = a.staff_id || null
  let createdStaff = false
  if (toApprove.length && !staffId) {
    if (b.staff_id) {
      const st = await db.prepare(`SELECT staff_id, COALESCE(affiliation_type,'own_employee') AS t FROM staff_profiles WHERE staff_id = ? AND company_id = ?`).bind(b.staff_id, u.company_id).first() as any
      if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
      if (st.t === 'skillsheet_only') return c.json({ error: 'スキルシートのみ作成のスタッフにはシフトを登録できません' }, 400)
      staffId = st.staff_id
    } else {
      const type = NEW_STAFF_TYPES.includes(b.new_staff_type) ? b.new_staff_type : 'daily_worker'
      if (!b.force_new) {
        const matches = await findStaffByPhone(db, u.company_id, a.phone || '')
        if (matches.length) return c.json({ error: 'この電話番号のスタッフが登録済みです。既存のスタッフに紐づけるか、別の人として仮登録してください', phone_matches: matches, need_staff: true }, 409)
      }
      let affiliation: string | null = null, partnerId: number | null = null
      const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first())?.company_name as string) || ''
      if (type === 'own_employee' || type === 'daily_worker') affiliation = ownName
      if (type === 'freelance') affiliation = '個人事業主'
      if (type === 'partner_manual') {
        const p = b.partner_affiliation_id ? await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?').bind(b.partner_affiliation_id, u.company_id).first() as any : null
        if (!p) return c.json({ error: '取引先を選択してください' }, 400)
        partnerId = p.affiliation_id; affiliation = p.affiliation_name
      }
      // 事前チェック（仮登録を作る前に、定員・重複を確認する）
      const pre = await approvalWarnings(db, u.company_id, null, toApprove)
      if (pre.length && !b.force) return c.json({ warnings: pre, need_force: true }, 409)
      const created = await insertProvisionalStaff(db, u.company_id, u.user_id, { name: a.name, phone: a.phone || '', type, affiliation, partnerId, kana: a.kana, email: a.email, memo: a.note ? `応募時のメモ: ${a.note}` : null, note: '募集から仮登録' })
      staffId = created.staff_id; createdStaff = true
    }
  }
  if (toApprove.length && staffId && !createdStaff) {
    const warnings = await approvalWarnings(db, u.company_id, staffId, toApprove)
    if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  }

  // シフトの作成（確定）
  const now = nowJST(); const createdShifts: number[] = []
  const pdata = toApprove.length ? await loadPricingData(db, u.company_id, toApprove.map(i => i.project_id)) : null
  for (const it of toApprove) {
    const already = await db.prepare("SELECT shift_id FROM shifts WHERE slot_role_id = ? AND staff_id = ? AND status != 'absent'").bind(it.slot_role_id, staffId).first() as any
    let shiftId = already?.shift_id
    if (!shiftId) {
      const res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo, slot_id, slot_role_id, site_id, break_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'confirmed', ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, staffId, it.project_id, it.work_date, it.start_time, it.end_time, it.location || '', it.role_name, u.user_id, '募集から承認', it.slot_id, it.slot_role_id, it.site_id ?? null, it.break_minutes ?? null).run()
      shiftId = res.meta.last_row_id
      await applyPricingToShift(db, u.company_id, shiftId, { data: pdata })
      createdShifts.push(shiftId)
    }
    await db.prepare("UPDATE recruit_application_items SET status = 'approved', shift_id = ?, decided_at = ? WHERE item_id = ?").bind(shiftId, now, it.item_id).run()
  }
  for (const id of rejectIds) await db.prepare("UPDATE recruit_application_items SET status = 'rejected', decided_at = ? WHERE item_id = ?").bind(now, id).run()
  if (staffId && !a.staff_id) await db.prepare('UPDATE recruit_applications SET staff_id = ? WHERE application_id = ?').bind(staffId, a.application_id).run()
  await closeIfDone(db, a.application_id, u.user_id)
  return c.json({ ok: true, staff_id: staffId, created_staff: createdStaff, created_shifts: createdShifts.length, rejected: rejectIds.length })
})

async function approvalWarnings(db: D1Database, companyId: number, staffId: number | null, items: any[]) {
  const w: string[] = []
  const label = (i: any) => `${i.work_date.slice(5).replace('-', '/')} ${i.start_time}〜${i.end_time} ${i.role_name}`
  // 同じ枠を同時に承認する分も数える
  const plan = new Map<number, number>()
  for (const i of items) {
    const extra = (plan.get(i.slot_role_id) || 0) + 1; plan.set(i.slot_role_id, extra)
    if (Number(i.assigned) + extra > Number(i.headcount)) w.push(`${label(i)}: 定員（${i.headcount}名）を超えます`)
    if (i.work_date < todayJST()) w.push(`${label(i)}: 過去の日付です`)
  }
  // 同時に承認する日時どうしの重複（同じ人を同じ時間帯の別の役割に入れる）
  for (let x = 0; x < items.length; x++) for (let y = x + 1; y < items.length; y++) {
    const A = items[x], B = items[y]
    if (A.work_date === B.work_date && A.start_time < B.end_time && B.start_time < A.end_time) w.push(`${label(A)} と ${label(B)}: 同じ時間帯です`)
  }
  if (staffId && items.length) {
    const dates = items.map(i => i.work_date).sort()
    const cf = await findConflicts(db, companyId, [staffId], dates[0], dates[dates.length - 1])
    for (const i of items) {
      const list = conflictFor(cf.get(staffId), i.work_date, i.start_time, i.end_time).filter((x: any) => x.slot_role_id !== i.slot_role_id)
      if (list.length) w.push(`${label(i)}: 同じ時間帯に別のシフトがあります（${list.map((x: any) => (x.company_id === companyId ? x.project_name : x.company_name + '・他社') + ' ' + x.start_time + '〜' + x.end_time).join('、')}）`)
    }
    const projects = [...new Set(items.map(i => i.project_id))]
    for (const pid of projects) if ((await ngStaffIds(db, pid)).includes(staffId)) w.push(`クライアントのNGスタッフに指定されています（${items.find(i => i.project_id === pid)!.work_date}〜）`)
  }
  return w
}

// 個人情報の保存期間: 公開ページからの応募で、スタッフに紐づかず対応が終わったもの（または放置されたもの）は180日で削除する（Cron）
export async function purgeOldApplications(db: D1Database) {
  const cutoff = addDays(todayJST(), -180) + ' 00:00:00'
  const olds = ((await db.prepare(`SELECT application_id FROM recruit_applications WHERE staff_id IS NULL AND created_at < ? LIMIT 500`).bind(cutoff).all()).results as any[]).map(r => r.application_id)
  for (let i = 0; i < olds.length; i += 90) {
    const chunk = olds.slice(i, i + 90); const q = chunk.map(() => '?').join(',')
    await db.batch([
      db.prepare(`DELETE FROM recruit_application_items WHERE application_id IN (${q})`).bind(...chunk),
      db.prepare(`DELETE FROM recruit_applications WHERE application_id IN (${q})`).bind(...chunk),
    ])
  }
  // 送信回数の制限用のハッシュは7日で消す
  await db.prepare('UPDATE recruit_applications SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?').bind(addDays(todayJST(), -7) + ' 00:00:00').run()
  return olds.length
}
