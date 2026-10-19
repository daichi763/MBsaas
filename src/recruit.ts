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
import { findStaffByPhone, findStaffByPhones, insertProvisionalStaff, normalizePhone } from './staff-lifecycle'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { assertAssignable, conflictLabel } from './lib/staff-eligibility'
import { shiftWindow } from './lib/shift-time'
import { isCompanyActive } from './lib/auth'

// RATE_LIMIT_SALT: 送信回数の制限に使う接続元IPのハッシュの塩（秘密の値。wrangler secret put で登録する。#351）
type Bindings = { DB: D1Database; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string; RATE_LIMIT_SALT?: string }
type Variables = { user: any }

// ---------- 定数 ----------
const MAX_PAGE_DAYS = 62
const MAX_SLOTS_PER_APPLY = 31
const MAX_PAGE_PROJECTS = 50      // 1つの募集ページで対象にできる案件の数
const MAX_APPLICATIONS_LIST = 200 // 応募一覧で一度に返す件数（続きは offset で取得する。#339）
const ROLES_PER_PAGE = 300        // 公開ページ・スタッフアプリで一度に返す枠の数（続きは next_from の日付から取得する。#126）
const RATE_PER_IP_HOUR = 30       // 同じ接続元からの送信は、募集ページごとに1時間に30件まで（会場の共用回線を考えてページ単位にする。#225）
const RATE_PER_PHONE_DAY = 3      // 同じ電話番号からの送信は1日に3件まで（募集ページごと）
const MIN_FILL_MS = 3000          // 表示から3秒未満の送信は機械的な送信とみなす
const PROCESSING_STALE_MIN = 10   // 承認の処理中（processing）のまま止まった明細を未対応に戻すまでの分数
const RETENTION_DAYS = 180        // 採用に至らなかった公開ページの応募を保存する日数（purgeOldApplications）
const NEW_STAFF_TYPES = ['daily_worker', 'freelance', 'partner_manual', 'own_employee']

// ---------- ユーティリティ ----------
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
function addMinutesJST(m: number): string { return new Date(Date.now() + (9 * 60 + m) * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
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

// 募集ページの対象となる枠（役割）の条件。開始時刻を過ぎた当日の枠は締め切る（#190）
function openRolesWhere(page: any, opts: { fromDate?: string; roleIds?: number[] } = {}): { sql: string; bind: any[] } | null {
  const pids = parseIds(page.project_ids)
  if (!pids.length) return null
  if (opts.roleIds && !opts.roleIds.length) return null
  const now = nowJST(), today = now.slice(0, 10)
  const from = [page.date_from, isDate(opts.fromDate) && opts.fromDate! > today ? opts.fromDate! : today].sort().pop()!
  // 案件・枠のIDは json_each で1つにまとめてバインドする（D1 のバインド上限 100）
  const w = [`sl.company_id = ?`, `sl.project_id IN ${JSON_IN}`, `sl.work_date BETWEEN ? AND ?`, `COALESCE(sl.status,'open') = 'open'`, `(sl.work_date > ? OR sl.start_time > ?)`]
  const bind: any[] = [page.company_id, bindJsonArray(pids), from, page.date_to, today, now.slice(11, 16)]
  if (opts.roleIds) { w.push(`r.slot_role_id IN ${JSON_IN}`); bind.push(bindJsonArray(opts.roleIds)) }
  return { sql: w.join(' AND '), bind }
}
const ASSIGNED_SQL = `(SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = r.slot_role_id AND s.status != 'absent')`

// 募集ページの対象となる枠（役割）と残り人数。limit を付けないときは、条件に合う枠をすべて返す
async function openRoles(db: D1Database, page: any, opts: { fromDate?: string; roleIds?: number[]; limit?: number } = {}) {
  const q = openRolesWhere(page, opts)
  if (!q) return []
  const rows = (await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes,
      COALESCE(si.site_name, sl.location, p.location, '') AS place, si.address AS site_address,
      ${ASSIGNED_SQL} AS assigned,
      (SELECT COUNT(*) FROM recruit_application_items i WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending') AS pending
    FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id JOIN projects p ON p.project_id = sl.project_id
    LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE ${q.sql} ORDER BY sl.work_date, sl.start_time, r.sort_order, r.slot_role_id${opts.limit ? ` LIMIT ${Number(opts.limit)}` : ''}`).bind(...q.bind).all()).results as any[]
  return rows.map(r => ({ ...r, remaining: Math.max(0, Number(r.headcount) - Number(r.assigned)) }))
}

// 公開ページ・スタッフアプリ向けに、fromDate の日から ROLES_PER_PAGE 件ずつ返す（#126）。
// 日付の途中では切らず、最後の日付は次の取得に回す（next_from）。1日だけで上限を超えるときは、その日の上限までを返して翌日から続ける
async function openRolesPage(db: D1Database, page: any, fromDate?: string) {
  const rows = await openRoles(db, page, { fromDate, limit: ROLES_PER_PAGE + 1 })
  if (rows.length <= ROLES_PER_PAGE) return { roles: rows, next_from: null as string | null }
  const lastDate = rows[ROLES_PER_PAGE].work_date
  const before = rows.slice(0, ROLES_PER_PAGE).filter(r => r.work_date < lastDate)
  if (before.length) return { roles: before, next_from: lastDate as string }
  return { roles: rows.slice(0, ROLES_PER_PAGE), next_from: addDays(lastDate, 1) }
}

// 管理画面の「募集中の枠 n件（残りm名）」。件数で打ち切らずに数える（#126）
async function openRolesSummary(db: D1Database, page: any) {
  const q = openRolesWhere(page)
  if (!q) return { roles: 0, remaining: 0 }
  const r = await db.prepare(`SELECT COUNT(*) AS roles, COALESCE(SUM(MAX(0, headcount - assigned)), 0) AS remaining FROM (
      SELECT r.headcount, ${ASSIGNED_SQL} AS assigned FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id WHERE ${q.sql})`).bind(...q.bind).first() as any
  return { roles: Number(r?.roles || 0), remaining: Number(r?.remaining || 0) }
}

// 応募の日時の状態。承認済みでも、作ったシフトが削除・欠勤・別のスタッフへの差し替え・別の枠への移動になったものは
// 「シフト解除」（released）とみなす（#64。シフトを変える側では応募の行を書き換えないため、読むときに判定する）。
// 枠の削除で「枠なし」になったシフトは、本人のシフトとして残っているので承認済みのまま。recruit_applications を a として JOIN して使う
const ITEM_STATE_SQL = `CASE WHEN i.status = 'approved' AND NOT EXISTS (SELECT 1 FROM shifts xs WHERE xs.shift_id = i.shift_id AND xs.status != 'absent'
    AND xs.staff_id = a.staff_id AND (xs.slot_role_id IS NULL OR xs.slot_role_id = i.slot_role_id)) THEN 'released' ELSE i.status END`
// 応募済みとみなす（同じ枠に重ねて応募させない）状態: 未対応・処理中と、シフトが残っている承認済み
const ACTIVE_ITEM_SQL = `(i.status IN ('pending','processing') OR (i.status = 'approved' AND ${ITEM_STATE_SQL} = 'approved'))`

// 枠・役割が削除されて残った未対応の応募を「枠の削除」で処理済みにする（#65）。
// 枠の削除・繰り返し登録の削除（shift-board.ts）の後と、応募一覧・件数の取得のときに呼ぶ（枠の編集で役割を消した分もここで片づく）
export async function settleRemovedSlotItems(db: D1Database, companyId: number) {
  // 承認の途中で処理が止まった（通信が切れて打ち切られたなど）明細は、一定時間たったら未対応に戻す（#86。processing の間の decided_at は押さえた時刻）
  await db.prepare(`UPDATE recruit_application_items SET status = 'pending', decided_at = NULL WHERE status = 'processing' AND (decided_at IS NULL OR decided_at < ?)
    AND application_id IN (SELECT application_id FROM recruit_applications WHERE company_id = ?)`).bind(addMinutesJST(-PROCESSING_STALE_MIN), companyId).run()
  await expirePastItems(db, companyId)
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.status = 'pending' AND i.status = 'pending' AND NOT EXISTS (SELECT 1 FROM shift_slot_roles r WHERE r.slot_role_id = i.slot_role_id)`)
    .bind(companyId).all()).results as any[]
  if (!rows.length) return 0
  await db.prepare(`UPDATE recruit_application_items SET status = 'slot_removed', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(r => r.item_id))).run()
  for (const id of new Set(rows.map(r => r.application_id as number))) await closeIfDone(db, id)
  return rows.length
}
// 勤務日を過ぎても未対応のままの日時は「期限切れ」（expired）にする（#302）。未対応の件数・一覧の先頭に残り続けないようにする。
// 当日の分は、開始時刻を過ぎても管理者が承認できるよう（警告付き）、翌日になってから片づける
async function expirePastItems(db: D1Database, companyId: number) {
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE a.company_id = ? AND a.status = 'pending' AND i.status = 'pending' AND sl.work_date < ?`).bind(companyId, todayJST()).all()).results as any[]
  if (!rows.length) return
  await db.prepare(`UPDATE recruit_application_items SET status = 'expired', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(r => r.item_id))).run()
  for (const id of new Set(rows.map(r => r.application_id as number))) await closeIfDone(db, id)
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

// 本部で停止にした企業の募集ページは、表示も応募の受け付けも止める（#66。ログインの要らない公開URLのため、ログインの停止とは別に確かめる）
recruitPublicApi.use('/:token/*', async (c, next) => {
  const token = c.req.param('token')
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return next()
  const co = await c.env.DB.prepare(`SELECT co.active_status FROM recruit_pages rp JOIN companies co ON co.company_id = rp.company_id WHERE rp.token = ?`).bind(token).first() as any
  if (co && !isCompanyActive(co.active_status)) return c.json({ error: 'この募集は終了しました', closed: true }, 410)
  return next()
})

recruitPublicApi.get('/:token', async (c) => {
  const page = await loadPageByToken(c.env.DB, c.req.param('token'))
  if (!page) return c.json({ error: 'この募集ページは見つかりません' }, 404)
  if (!pageIsOpen(page)) return c.json({ error: 'この募集は終了しました', closed: true, title: page.title, company_name: page.company_name }, 410)
  // ?from=日付 で続きの日時を取得する（#126）
  const { roles, next_from } = await openRolesPage(c.env.DB, page, c.req.query('from'))
  return c.json({
    title: page.title, company_name: page.company_name, description: page.description || '', pay_note: page.pay_note || '', contact_note: page.contact_note || '',
    date_from: page.date_from, date_to: page.date_to, roles: roles.map(r => publicRole(r, !!page.show_remaining)), next_from,
    turnstile_site_key: turnstileEnabled(c.env) ? c.env.TURNSTILE_SITE_KEY : null, issued_at: Date.now(),
    retention_days: RETENTION_DAYS, // 同意文に書く保存期間（#351）
  })
})

// Turnstile はサイトキーと秘密鍵の両方があるときだけ使う。片方だけのときは、画面に確認欄が出ないのにサーバーで確認して
// すべての応募が失敗するため、確認しない（管理画面に「片方だけ設定」と警告を出す。#501）
function turnstileEnabled(env: Bindings) { return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) }
function turnstileState(env: Bindings): 'enabled' | 'off' | 'site_key_only' | 'secret_key_only' {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) return 'enabled'
  if (env.TURNSTILE_SITE_KEY) return 'site_key_only'
  if (env.TURNSTILE_SECRET_KEY) return 'secret_key_only'
  return 'off'
}

// 'ok' / 'fail'（確認できなかった） / 'error'（Cloudflare に問い合わせできなかった）
async function verifyTurnstile(secret: string, token: string, ip: string | undefined): Promise<'ok' | 'fail' | 'error'> {
  try {
    const fd = new FormData(); fd.append('secret', secret); fd.append('response', token || ''); if (ip) fd.append('remoteip', ip)
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd })
    const j = await r.json() as any
    return j.success ? 'ok' : 'fail'
  } catch (e) {
    console.error('turnstile siteverify failed', e)
    return 'error'
  }
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
  if (turnstileEnabled(c.env)) {
    const v = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY!, str(b.turnstile_token, 2048), ip)
    if (v === 'error') return c.json({ error: '確認サービスに接続できませんでした。時間をおいてもう一度お試しいただくか、お問い合わせ先へご連絡ください' }, 503)
    // 入力した内容は画面に残したまま、確認だけをやり直してもらう（#515）
    if (v !== 'ok') return c.json({ error: '「人間であることの確認」をもう一度行ってから、送信してください', field: 'turnstile' }, 400)
  }
  // 入力の誤りは、どの欄かを field で返す（画面でその欄へ移動して強調する。#416）
  const name = str(b.name, 60), kana = str(b.kana, 60), email = str(b.email, 120).normalize('NFKC'), note = str(b.note, 500)
  const phone = normalizePhone(b.phone)
  if (!name) return c.json({ error: 'お名前を入力してください', field: 'name' }, 400)
  if (phone.length < 10 || phone.length > 11) return c.json({ error: '電話番号は10〜11桁の数字で入力してください（ハイフンはあってもなくても構いません）', field: 'phone' }, 400)
  if (email && !isEmail(email)) return c.json({ error: 'メールアドレスの形式が正しくありません', field: 'email' }, 400)
  if (!b.agree) return c.json({ error: '個人情報の取り扱いに同意してください', field: 'agree' }, 400)
  const roleIds = parseIds(b.slot_role_ids)
  if (!roleIds.length) return c.json({ error: '希望する日時を選択してください', field: 'slots' }, 400)
  if (roleIds.length > MAX_SLOTS_PER_APPLY) return c.json({ error: `一度に選べるのは${MAX_SLOTS_PER_APPLY}件までです`, field: 'slots' }, 400)

  // 送信回数の制限（IPはそのまま保存せず、ハッシュのみ）
  const ipHash = ip ? await ipHashFor(c.env, ip) : null
  if (ipHash) {
    // 募集ページごとに数える（説明会・イベント会場の共用回線や、他社の募集ページへの応募と合算しない。#225）
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE ip_hash = ? AND page_id = ? AND created_at >= ?`).bind(ipHash, page.page_id, addHourJST(-1)).first() as any
    if (n?.n >= RATE_PER_IP_HOUR) return c.json({ error: '送信回数が多すぎます。しばらくしてからお試しいただくか、お問い合わせ先へご連絡ください' }, 429)
  }
  const pn = await db.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE page_id = ? AND phone = ? AND created_at >= ?`).bind(page.page_id, phone, todayJST() + ' 00:00:00').first() as any
  if (pn?.n >= RATE_PER_PHONE_DAY) return c.json({ error: '本日の応募回数の上限に達しました。お問い合わせ先へご連絡ください' }, 429)

  const roles = await openRoles(db, page, { roleIds })
  // 選んだ日時の一部でも締め切られていたら、残りだけで応募を成立させず、選び直してもらう（#242）。
  // 画面は入力を保ったまま日時の一覧を取り直し、締め切られた日時を選択から外して知らせる（#515）
  const openIds = new Set(roles.map(r => r.slot_role_id))
  const closedIds = roleIds.filter(id => !openIds.has(id))
  if (closedIds.length) {
    return c.json({ error: roles.length ? `選んだ日時のうち${closedIds.length}件は募集が終了しました。選び直してから、もう一度送信してください` : '選んだ日時は募集が終了しました。ほかの日時を選んでください',
      closed_role_ids: closedIds, need_reselect: true, field: 'slots' }, 409)
  }
  // 同じ電話番号で同じ枠にすでに未対応（またはシフトが残っている承認済み）の応募がある場合は重複させない
  const dupRows = (await db.prepare(`SELECT i.slot_role_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.phone = ? AND ${ACTIVE_ITEM_SQL} AND i.slot_role_id IN ${JSON_IN}`)
    .bind(page.company_id, phone, bindJsonArray(roles.map(r => r.slot_role_id))).all()).results as any[]
  const dup = new Set(dupRows.map(r => r.slot_role_id))
  const targets = roles.filter(r => !dup.has(r.slot_role_id))
  // 完了画面の控え: 受け付けた日時と、応募済みのため除いた日時を分けて返す（#242 #317）
  const receipt = (list: any[]) => list.map(r => publicRole(r, false))
  const already = receipt(roles.filter(r => dup.has(r.slot_role_id)))
  const appliedAt = nowJST()
  if (!targets.length) return c.json({ ok: true, count: 0, message: '選択した日時はすでに応募済みです', accepted: [], already_applied: already, applied_at: appliedAt })

  const app = await db.prepare(`INSERT INTO recruit_applications (company_id, page_id, source, name, kana, phone, email, note, ip_hash, created_at)
    VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?, ?)`).bind(page.company_id, page.page_id, name, kana || null, phone, email || null, note || null, ipHash, appliedAt).run()
  const appId = app.meta.last_row_id
  await db.batch(targets.map(r => db.prepare('INSERT OR IGNORE INTO recruit_application_items (application_id, slot_role_id) VALUES (?, ?)').bind(appId, r.slot_role_id)))
  return c.json({ ok: true, count: targets.length, full_count: targets.filter(r => r.remaining <= 0).length, accepted: receipt(targets), already_applied: already, applied_at: appliedAt })
})
function addHourJST(h: number) { return new Date(Date.now() + (9 + h) * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }

// 送信回数の制限に使う接続元IPのハッシュ（#351）。塩は秘密の値（RATE_LIMIT_SALT、無ければ TURNSTILE_SECRET_KEY）を使う。
// どちらも無いときは、ソースから分かる固定の塩で全数を試すとIPに戻せてしまうため、ハッシュを4桁（65,536通り）に縮めて保存する
// （1つのハッシュに多数のIPが当たるので元のIPは特定できない。ページごと1時間の件数の制限には足りる）。管理画面で設定を促す
function ipSaltState(env: Bindings): 'set' | 'turnstile' | 'none' { return env.RATE_LIMIT_SALT ? 'set' : env.TURNSTILE_SECRET_KEY ? 'turnstile' : 'none' }
let warnedNoSalt = false
async function ipHashFor(env: Bindings, ip: string) {
  const secret = env.RATE_LIMIT_SALT || env.TURNSTILE_SECRET_KEY
  if (secret) return sha256(`recruit|${ip}|${secret}`)
  if (!warnedNoSalt) { warnedNoSalt = true; console.warn('RATE_LIMIT_SALT が未設定のため、応募の送信回数の制限は接続元IPの短いハッシュで行います（wrangler secret put RATE_LIMIT_SALT で設定してください）') }
  return 'w:' + (await sha256(`recruit|${ip}`)).slice(0, 4)
}

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

// 自分の応募とみなす範囲。アプリからの応募（a.staff_id = 自分）に加えて、登録済みのスタッフが公開URLから出した応募も、
// 電話番号（正規化済み）が自分と一致し、自社でその番号のスタッフが自分だけのときは本人の応募として扱う（#114）。
// 公開URLでは本人確認をしていないため staff_id は書き込まない（管理者が承認するときに紐づける）
async function myAppScope(db: D1Database, u: any): Promise<{ sql: string; bind: any[] }> {
  const base = { sql: 'a.company_id = ? AND a.staff_id = ?', bind: [u.company_id, u.staff_id] }
  const me = await db.prepare('SELECT us.phone FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(u.staff_id).first() as any
  const phone = normalizePhone(me?.phone)
  if (phone.length < 10) return base
  const has = await db.prepare(`SELECT 1 FROM recruit_applications WHERE company_id = ? AND staff_id IS NULL AND source = 'public' AND phone = ? LIMIT 1`).bind(u.company_id, phone).first()
  if (!has) return base
  const matches = await findStaffByPhone(db, u.company_id, phone)
  if (matches.length !== 1 || Number(matches[0].staff_id) !== Number(u.staff_id)) return base
  return { sql: `a.company_id = ? AND (a.staff_id = ? OR (a.staff_id IS NULL AND a.source = 'public' AND a.phone = ?))`, bind: [u.company_id, u.staff_id, phone] }
}
// 自分が応募済み（未対応・シフトが残っている承認済み）の枠と、割り当て済みの枠
async function myRoleStates(db: D1Database, u: any, scope: { sql: string; bind: any[] }) {
  const mine = ((await db.prepare(`SELECT i.slot_role_id, CASE WHEN i.status = 'processing' THEN 'pending' ELSE i.status END AS status
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE ${scope.sql} AND ${ACTIVE_ITEM_SQL}`).bind(...scope.bind).all()).results as any[])
  const assigned = new Set(((await db.prepare(`SELECT slot_role_id FROM shifts WHERE staff_id = ? AND slot_role_id IS NOT NULL AND status != 'absent' AND work_date >= ?`)
    .bind(u.staff_id, todayJST()).all()).results as any[]).map(r => r.slot_role_id))
  return { mineMap: new Map(mine.map(r => [r.slot_role_id, r.status])), assigned }
}
function staffRole(r: any, p: any, st: { mineMap: Map<any, any>; assigned: Set<any> }) {
  return { ...publicRole(r, !!p.show_remaining), my_status: st.assigned.has(r.slot_role_id) ? 'assigned' : st.mineMap.get(r.slot_role_id) || null }
}

recruitStaffApi.get('/', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ pages: [], applications: [] })
  await settleRemovedSlotItems(db, u.company_id)
  const pages = ((await db.prepare(`SELECT * FROM recruit_pages WHERE company_id = ? AND status = 'open' AND allow_staff = 1 AND date_to >= ? ORDER BY date_from`)
    .bind(u.company_id, todayJST()).all()).results as any[])
  // 自分のシフト（同じ時間帯の確認用）と応募状況
  const scope = await myAppScope(db, u)
  const st = await myRoleStates(db, u, scope)
  const out = []
  for (const p of pages) {
    const { roles, next_from } = await openRolesPage(db, p)
    out.push({ page_id: p.page_id, title: p.title, description: p.description || '', pay_note: p.pay_note || '', date_from: p.date_from, date_to: p.date_to,
      roles: roles.map(r => staffRole(r, p, st)), next_from })
  }
  // 応募した日時。承認後にシフトが外れたものは released（シフト解除）で返す（#64）
  const apps = ((await db.prepare(`SELECT i.item_id, CASE WHEN i.status = 'processing' THEN 'pending' ELSE ${ITEM_STATE_SQL} END AS status, i.slot_role_id, a.application_id, a.source, a.created_at,
      sl.work_date, sl.start_time, sl.end_time, r.role_name, COALESCE(si.site_name, sl.location, '') AS place
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE ${scope.sql} AND sl.work_date >= ? ORDER BY sl.work_date, sl.start_time LIMIT 100`).bind(...scope.bind, addDays(todayJST(), -7)).all()).results as any[])
  return c.json({ pages: out, applications: apps })
})

// 募集ページの続きの日時（next_from の日から。#126）
recruitStaffApi.get('/pages/:id/roles', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await db.prepare(`SELECT * FROM recruit_pages WHERE page_id = ? AND company_id = ? AND allow_staff = 1`).bind(c.req.param('id'), u.company_id).first() as any
  if (!pageIsOpen(p)) return c.json({ error: 'この募集は終了しました' }, 410)
  const st = await myRoleStates(db, u, await myAppScope(db, u))
  const { roles, next_from } = await openRolesPage(db, p, c.req.query('from'))
  return c.json({ roles: roles.map(r => staffRole(r, p, st)), next_from })
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
  // 応募済み（公開URLから出した自分の応募を含む）と割り当て済みの枠には重ねて応募しない。シフトが外れた承認済みの枠には応募し直せる（#64 #114）
  const scope = await myAppScope(db, u)
  const exists = new Set(((await db.prepare(`SELECT i.slot_role_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE ${scope.sql} AND ${ACTIVE_ITEM_SQL}`).bind(...scope.bind).all()).results as any[]).map(r => r.slot_role_id))
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
  const scope = await myAppScope(db, u)
  const it = await db.prepare(`SELECT i.*, a.application_id AS aid FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE i.item_id = ? AND ${scope.sql}`).bind(c.req.param('id'), ...scope.bind).first() as any
  if (!it) return c.json({ error: '応募が見つかりません' }, 404)
  if (it.status !== 'pending') return c.json({ error: '承認済み・対応済みの応募は取り下げできません。管理者に連絡してください' }, 409)
  // 管理者が同時に承認しているとき（processing）は取り下げにしない
  const r = await db.prepare("UPDATE recruit_application_items SET status = 'cancelled', decided_at = ? WHERE item_id = ? AND status = 'pending'").bind(nowJST(), it.item_id).run()
  if (!r.meta.changes) return c.json({ error: '承認済み・対応済みの応募は取り下げできません。管理者に連絡してください' }, 409)
  await closeIfDone(db, it.aid)
  return c.json({ ok: true })
})

async function closeIfDone(db: D1Database, applicationId: number, byUserId?: number | null) {
  const left = await db.prepare("SELECT COUNT(*) AS n FROM recruit_application_items WHERE application_id = ? AND status IN ('pending','processing')").bind(applicationId).first() as any
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
  // 件数の上限は案件を送ってきたときだけ確認する（既存のページの終了・再開は妨げない）
  else if (b.project_ids !== undefined && parseIds(b.project_ids).length > MAX_PAGE_PROJECTS) error = `対象の案件は${MAX_PAGE_PROJECTS}件までです`
  else if (!isDate(v.date_from) || !isDate(v.date_to) || dayDiff(v.date_from, v.date_to) < 0) error = '期間を正しく入力してください'
  else if (dayDiff(v.date_from, v.date_to) > MAX_PAGE_DAYS - 1) error = `期間は${MAX_PAGE_DAYS}日以内で指定してください`
  return { v, error }
}
async function checkProjects(db: D1Database, companyId: number, ids: string) {
  const list = parseIds(ids)
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(list)).first() as any
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
    const sum = pageIsOpen(r) ? await openRolesSummary(db, r) : { roles: 0, remaining: 0 }
    // expired: 期間の終了日を過ぎている（再開するには期間の延長が必要。#136）
    out.push({ ...r, project_names: parseIds(r.project_ids).map(id => pname.get(id) || `#${id}`), open_roles: sum.roles,
      open_remaining: sum.remaining, is_open: pageIsOpen(r), expired: r.date_to < todayJST() })
  }
  const turnstile = turnstileState(c.env)
  return c.json({ pages: out, turnstile, turnstile_enabled: turnstile === 'enabled' })
})

recruitAdminApi.post('/recruit-pages', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const { v, error } = pageValues(b)
  if (error) return c.json({ error }, 400)
  if (v.date_to < todayJST()) return c.json({ error: '期間の終了日が過ぎています。今日以降の日付を指定してください' }, 400)
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
  // 期間を過ぎたまま再開しても公開されないため、終了日を延ばすよう求める（#136）
  if (b.status === 'open' && v.date_to < todayJST()) return c.json({ error: '期間の終了日が過ぎています。期間を延ばしてから再開してください', need_extend: true }, 400)
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

// 応募の紐づけ先のスタッフが割り当てられない（退職・ログイン停止・統合済み）。recruit_applications a と staff_profiles sp・users us を LEFT JOIN して使う
const STAFF_INACTIVE_SQL = `(a.staff_id IS NOT NULL AND (COALESCE(sp.employment_status,'working') = 'retired' OR COALESCE(us.status,'active') != 'active' OR sp.merged_into_staff_id IS NOT NULL))`
const likeEsc = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m)
// 空白（全角を含む）を除いて比べる列の式
const squashSql = (col: string) => `REPLACE(REPLACE(COALESCE(${col},''),' ',''),'　','')`
const squash = (s: any) => String(s || '').normalize('NFKC').replace(/\s/g, '')

// 応募一覧（枠の情報・残り人数・重複の警告・電話番号が一致する登録済みスタッフ）
// 絞り込み: status（pending / done / cancelled / waitlist: 見送りにした勤務日前の日時がある / all）、page_id、slot_role_id（シフトボードの「応募n」から。#303）、
// q（氏名・フリガナ・電話番号）、from・to（勤務日）。offset で続きを取得する（#339）
recruitAdminApi.get('/recruit-applications', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await settleRemovedSlotItems(db, u.company_id)
  const status = c.req.query('status') || 'pending'
  const w = ['a.company_id = ?']; const bind: any[] = [u.company_id]
  if (['pending', 'done', 'cancelled'].includes(status)) { w.push('a.status = ?'); bind.push(status) }
  // キャンセル待ち: 見送りにした日時のうち、勤務日が今日以降のもの（繰り上げて承認できる。#211）
  if (status === 'waitlist') {
    w.push(`EXISTS (SELECT 1 FROM recruit_application_items wi JOIN shift_slot_roles wr ON wr.slot_role_id = wi.slot_role_id JOIN shift_slots ws ON ws.slot_id = wr.slot_id
      WHERE wi.application_id = a.application_id AND wi.status = 'rejected' AND ws.work_date >= ?)`); bind.push(todayJST())
  }
  if (c.req.query('page_id')) { w.push('a.page_id = ?'); bind.push(Number(c.req.query('page_id'))) }
  const slotRoleId = Number(c.req.query('slot_role_id')) || 0
  if (slotRoleId) { w.push('EXISTS (SELECT 1 FROM recruit_application_items fi WHERE fi.application_id = a.application_id AND fi.slot_role_id = ?)'); bind.push(slotRoleId) }
  const from = c.req.query('from'), to = c.req.query('to')
  if (isDate(from) || isDate(to)) {
    w.push(`EXISTS (SELECT 1 FROM recruit_application_items di JOIN shift_slot_roles dr ON dr.slot_role_id = di.slot_role_id JOIN shift_slots ds ON ds.slot_id = dr.slot_id
      WHERE di.application_id = a.application_id AND ds.work_date BETWEEN ? AND ?)`); bind.push(isDate(from) ? from : '0000-01-01', isDate(to) ? to : '9999-12-31')
  }
  // 氏名・フリガナ（空白は無視）・電話番号（数字だけで部分一致）で探す
  const q = str(c.req.query('q'), 60).normalize('NFKC')
  if (q) {
    const digits = q.replace(/[\s()\-‐－]/g, '')
    if (/^\+?\d{3,}$/.test(digits)) { w.push(`a.phone LIKE ? ESCAPE '\\'`); bind.push(`%${likeEsc(normalizePhone(digits))}%`) }
    else {
      const k = `%${likeEsc(squash(q))}%`
      w.push(`(${squashSql('a.name')} LIKE ? ESCAPE '\\' OR ${squashSql('a.kana')} LIKE ? ESCAPE '\\' OR ${squashSql('us.name')} LIKE ? ESCAPE '\\')`); bind.push(k, k, k)
    }
  }
  const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0))
  const FROM = `FROM recruit_applications a LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = a.staff_id LEFT JOIN users us ON us.user_id = sp.user_id WHERE ${w.join(' AND ')}`
  const total = Number(((await db.prepare(`SELECT COUNT(*) AS n ${FROM}`).bind(...bind).first()) as any)?.n || 0)
  const apps = ((await db.prepare(`SELECT a.*, rp.title AS page_title, us.name AS staff_name, sp.is_provisional, COALESCE(sp.affiliation_type,'own_employee') AS staff_affiliation_type,
      CASE WHEN ${STAFF_INACTIVE_SQL} THEN 1 ELSE 0 END AS staff_inactive
    ${FROM} ORDER BY a.created_at ${status === 'pending' ? 'ASC' : 'DESC'}, a.application_id LIMIT ${MAX_APPLICATIONS_LIST} OFFSET ${offset}`).bind(...bind).all()).results as any[])
  const nextOffset = offset + apps.length < total ? offset + apps.length : null
  // 絞り込みの選択肢（募集ページ）と、枠で絞り込んだときの枠の情報（まとめて見送るボタンに使う）
  const pages = ((await db.prepare(`SELECT page_id, title, status FROM recruit_pages WHERE company_id = ? ORDER BY status = 'open' DESC, date_from DESC, page_id DESC LIMIT 200`).bind(u.company_id).all()).results as any[])
  const slot = slotRoleId ? await slotSummary(db, u.company_id, slotRoleId) : null
  const meta = { counts: await counts(db, u.company_id, true), total, offset, next_offset: nextOffset, truncated: nextOffset !== null, pages, slot, ip_salt: ipSaltState(c.env) }
  if (!apps.length) return c.json({ applications: [], ...meta })
  // 応募IDは json_each で1つにまとめてバインドする（D1 のバインド上限 100）
  // 枠が削除された日時（slot_removed）も出すため、枠・役割は LEFT JOIN にする（#65）。状態は承認後のシフトの有無で判定する（#64）
  const items = ((await db.prepare(`SELECT i.item_id, i.application_id, i.slot_role_id, i.shift_id, i.decided_at, ${ITEM_STATE_SQL} AS status,
      r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.work_date, sl.start_time, sl.end_time, p.project_name,
      COALESCE(si.site_name, sl.location, '') AS place,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = i.slot_role_id AND s.status != 'absent') AS assigned
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    LEFT JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id LEFT JOIN shift_slots sl ON sl.slot_id = r.slot_id
    LEFT JOIN projects p ON p.project_id = sl.project_id LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE i.application_id IN ${JSON_IN} ORDER BY sl.work_date IS NULL, sl.work_date, sl.start_time`).bind(bindJsonArray(apps.map(a => a.application_id))).all()).results as any[])
  // 登録済みスタッフの重複（同じ時間帯のシフト）
  const staffIds = [...new Set(apps.map(a => a.staff_id).filter(Boolean))] as number[]
  const dates = items.map(i => i.work_date).filter(Boolean).sort()
  const conflicts = staffIds.length && dates.length ? await findConflicts(db, u.company_id, staffIds, dates[0], dates[dates.length - 1]) : new Map()
  // 電話番号が一致するスタッフは、未登録の応募の分をまとめて1回で照合する（#309）
  const byPhone = await findStaffByPhones(db, u.company_id, apps.filter(a => !a.staff_id && a.phone).map(a => a.phone))
  const inactive = await inactiveStaffIds(db, [...byPhone.values()].flat().map(m => m.staff_id))
  const now = nowJST()
  const itemsByApp = new Map<number, any[]>()
  for (const i of items) itemsByApp.set(i.application_id, [...(itemsByApp.get(i.application_id) || []), i])
  const out = apps.map(a => {
    const its = (itemsByApp.get(a.application_id) || []).map(i => ({
      ...i, remaining: Math.max(0, Number(i.headcount || 0) - Number(i.assigned || 0)), past: !!i.work_date && hasStarted(i, now),
      conflicts: a.staff_id && ['pending', 'rejected'].includes(i.status) && i.work_date ? conflictFor(conflicts.get(a.staff_id), i.work_date, i.start_time, i.end_time).map((x: any) => conflictLabel(x, u.company_id)) : [],
    }))
    const matches = !a.staff_id && a.phone ? (byPhone.get(normalizePhone(a.phone)) || []).map(m => ({ ...m, inactive: inactive.has(Number(m.staff_id)) })) : []
    return { ...a, ip_hash: undefined, items: its, phone_matches: matches }
  })
  return c.json({ applications: out, ...meta })
})
// 枠の開始時刻を過ぎているか（日付だけでなく開始時刻で判定する。#190）
function hasStarted(i: { work_date: string; start_time: string; end_time: string }, now = nowJST()) {
  return shiftWindow(i.work_date, i.start_time, i.end_time).start <= now
}
// 退職・停止中（割り当てられない）のスタッフID（#87）
async function inactiveStaffIds(db: D1Database, ids: any[]) {
  const list = [...new Set(ids.map(Number).filter(Boolean))]
  if (!list.length) return new Set<number>()
  const rows = (await db.prepare(`SELECT sp.staff_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.staff_id IN ${JSON_IN} AND (COALESCE(sp.employment_status,'working') = 'retired' OR us.status != 'active')`).bind(bindJsonArray(list)).all()).results as any[]
  return new Set(rows.map(r => Number(r.staff_id)))
}
// 電話番号が一致するスタッフに、退職・停止・統合済み（割り当てられない）の印を付ける（#87）
async function withInactiveFlag(db: D1Database, matches: any[]) {
  if (!matches.length) return matches
  const inactive = await inactiveStaffIds(db, matches.map(m => m.staff_id))
  return matches.map(m => ({ ...m, inactive: inactive.has(Number(m.staff_id)) }))
}
// 未対応の件数（サイドメニューのバッジ）。退職・停止中のスタッフの応募は承認できず見送るだけなので数えない（#87。一覧には印を付けて出す）。
// 勤務日を過ぎた日時は settleRemovedSlotItems で期限切れにするため、ここには残らない（#302）
async function counts(db: D1Database, companyId: number, settled = false) {
  if (!settled) await settleRemovedSlotItems(db, companyId)
  const r = await db.prepare(`SELECT COUNT(*) AS pending, SUM(CASE WHEN a.source = 'public' THEN 1 ELSE 0 END) AS pending_public, SUM(CASE WHEN ${STAFF_INACTIVE_SQL} THEN 1 ELSE 0 END) AS inactive
    FROM recruit_applications a LEFT JOIN staff_profiles sp ON sp.staff_id = a.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE a.company_id = ? AND a.status = 'pending'`).bind(companyId).first() as any
  const inactive = Number(r?.inactive || 0)
  return { pending: Number(r?.pending || 0) - inactive, pending_public: Number(r?.pending_public || 0), pending_inactive: inactive }
}
recruitAdminApi.get('/recruit-applications/summary', async (c) => c.json(await counts(c.env.DB, c.get('user').company_id)))

// 枠（役割）の充足と、残っている未対応の応募の件数
async function slotSummary(db: D1Database, companyId: number, slotRoleId: number) {
  const r = await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.work_date, sl.start_time, sl.end_time, p.project_name,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = r.slot_role_id AND s.status != 'absent') AS assigned,
      (SELECT COUNT(*) FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
        WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending' AND a.company_id = ?) AS pending
    FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id JOIN projects p ON p.project_id = sl.project_id
    WHERE r.slot_role_id = ? AND sl.company_id = ?`).bind(companyId, slotRoleId, companyId).first() as any
  if (!r) return null
  return { ...r, assigned: Number(r.assigned), headcount: Number(r.headcount), pending: Number(r.pending), full: Number(r.assigned) >= Number(r.headcount) }
}

// 枠（役割）に残っている未対応の応募をまとめて見送る（定員に達した枠の残り。#303）。承認の処理中（processing）の明細は対象にしない
recruitAdminApi.post('/recruit-slots/:id/reject-pending', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const slot = await slotSummary(db, u.company_id, Number(c.req.param('id')))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE i.slot_role_id = ? AND i.status = 'pending' AND a.company_id = ?`).bind(slot.slot_role_id, u.company_id).all()).results as any[]
  if (!rows.length) return c.json({ ok: true, rejected: 0 })
  const r = await db.prepare(`UPDATE recruit_application_items SET status = 'rejected', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(x => x.item_id))).run()
  for (const id of new Set(rows.map(x => x.application_id as number))) await closeIfDone(db, id, u.user_id)
  return c.json({ ok: true, rejected: Number(r.meta.changes || 0) })
})

// 未登録の応募者を紐づける既存スタッフの候補（#395）。電話番号が一致しなくても、氏名・フリガナ・スタッフ番号・電話番号で探せる。
// q を省くと、応募の電話番号・氏名・フリガナが一致するスタッフを返す。一致の強い順（電話番号 → 氏名 → フリガナ）に並べる
recruitAdminApi.get('/recruit-applications/:id/staff-candidates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const a = await db.prepare('SELECT application_id, name, kana, phone FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const q = str(c.req.query('q'), 60).normalize('NFKC')
  const cond: string[] = []; const bind: any[] = [u.company_id]
  if (q) {
    const k = `%${likeEsc(squash(q))}%`
    cond.push(`${squashSql('us.name')} LIKE ? ESCAPE '\\'`, `${squashSql('sp.kana')} LIKE ? ESCAPE '\\'`, `us.user_code LIKE ? ESCAPE '\\'`); bind.push(k, k, `%${likeEsc(q.trim())}%`)
  } else {
    if (squash(a.name)) { cond.push(`${squashSql('us.name')} = ?`); bind.push(squash(a.name)) }
    if (squash(a.kana)) { cond.push(`${squashSql('sp.kana')} = ?`); bind.push(squash(a.kana)) }
  }
  const rows = cond.length ? ((await db.prepare(`SELECT sp.staff_id, us.name, us.phone, us.user_code, sp.kana, sp.is_provisional, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND sp.merged_into_staff_id IS NULL AND (${cond.join(' OR ')}) ORDER BY us.name LIMIT 30`).bind(...bind).all()).results as any[]) : []
  // 電話番号（数字だけ）で探したときと、q を省いたときの応募の電話番号の一致
  const phoneQ = q && /^\+?[\d\s()\-‐－]{10,}$/.test(q) ? q : ''
  const byPhone = await findStaffByPhone(db, u.company_id, q ? phoneQ : (a.phone || ''))
  const seen = new Set(rows.map(r => r.staff_id))
  const all = [...byPhone.filter(m => !seen.has(m.staff_id)), ...rows]
  const inactive = await inactiveStaffIds(db, all.map(m => m.staff_id))
  const phone = normalizePhone(a.phone)
  const phoneMatch = (m: any) => phone.length >= 10 && normalizePhone(m.phone) === phone
  const nameMatch = (m: any) => !!squash(a.name) && squash(m.name) === squash(a.name)
  const kanaMatch = (m: any) => !!squash(a.kana) && squash(m.kana) === squash(a.kana)
  const score = (m: any) => (phoneMatch(m) ? 4 : 0) + (nameMatch(m) ? 2 : 0) + (kanaMatch(m) ? 1 : 0)
  const out = all.map(m => ({ staff_id: m.staff_id, name: m.name, phone: m.phone, user_code: m.user_code ?? null, kana: m.kana ?? null, is_provisional: m.is_provisional,
    inactive: inactive.has(Number(m.staff_id)), phone_match: phoneMatch(m), name_match: nameMatch(m) }))
    .sort((x, y) => score(y) - score(x)).slice(0, 30)
  return c.json({ candidates: out })
})

// 承認・見送り
// body: { approve: [item_id], reject: [item_id], staff_id?: 既存スタッフに紐づけ, new_staff_type?: 仮登録の区分, partner_affiliation_id?, force? }
// 確認をすべて済ませてから、対象の明細を「処理中」（processing）にして押さえ、仮登録・シフトを作る。
// 二度押しなどで同じ明細を同時に処理しようとしたときは、押さえられなかった側を 409 にする（#86）
recruitAdminApi.post('/recruit-applications/:id/decide', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const a = await db.prepare('SELECT * FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const approveIds = parseIds(b.approve), rejectIds = parseIds(b.reject)
  if (!approveIds.length && !rejectIds.length) return c.json({ error: '承認または見送りする日時を選択してください' }, 400)
  if (approveIds.some(id => rejectIds.includes(id))) return c.json({ error: '同じ日時を承認と見送りの両方に指定しています' }, 400)
  await settleRemovedSlotItems(db, u.company_id)
  const items = ((await db.prepare(`SELECT i.*, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.site_id, sl.location, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = i.slot_role_id AND s.status != 'absent') AS assigned
    FROM recruit_application_items i JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE i.application_id = ? AND sl.company_id = ?`).bind(a.application_id, u.company_id).all()).results as any[])
  const byId = new Map(items.map(i => [i.item_id, i]))
  const nowAt = nowJST()
  for (const id of [...approveIds, ...rejectIds]) {
    const it = byId.get(id)
    if (!it) return c.json({ error: '応募の日時が見つかりません（枠が削除された可能性があります。画面を読み直してください）' }, 404)
    // 見送りにした日時は、開始前なら繰り上げて承認できる（キャンセルが出たときなど。#211）。見送りに戻す操作はない
    const promotable = it.status === 'rejected' && approveIds.includes(id) && !hasStarted(it, nowAt)
    if (it.status !== 'pending' && !promotable) {
      return c.json({ error: it.status === 'rejected' && approveIds.includes(id) ? `${it.work_date} ${it.start_time} の枠は開始時刻を過ぎているため、繰り上げて承認できません` : `${it.work_date} ${it.start_time} の応募はすでに対応済みです` }, 409)
    }
  }
  const toApprove = approveIds.map(id => byId.get(id)!)

  // ---- スタッフの決定と確認（承認がある場合のみ。ここでは書き込まない）: 応募者のスタッフ / 指定した既存スタッフ / 仮登録の作成 ----
  let staffId: number | null = a.staff_id || null
  let newStaff: { type: string; affiliation: string | null; partnerId: number | null } | null = null
  if (toApprove.length && !staffId) {
    if (b.staff_id) {
      const st = await db.prepare(`SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?`).bind(b.staff_id, u.company_id).first() as any
      if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
      staffId = st.staff_id
    } else {
      const type = NEW_STAFF_TYPES.includes(b.new_staff_type) ? b.new_staff_type : 'daily_worker'
      if (!b.force_new) {
        const matches = await withInactiveFlag(db, await findStaffByPhone(db, u.company_id, a.phone || ''))
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
      newStaff = { type, affiliation, partnerId }
    }
  }
  if (toApprove.length) {
    const warnings: string[] = []
    if (staffId) {
      // 退職・ログイン停止・統合済み・スキルシートのみなど、割り当てられないスタッフには承認しない（#87。割当の共通の確認を使う）
      const last = toApprove.reduce((m, i) => (i.work_date > m.work_date ? i : m), toApprove[0])
      const chk = await assertAssignable(db, { companyId: u.company_id, project: last.project_id, slot: null, staffId, workDate: last.work_date, start: last.start_time, end: last.end_time })
      if (chk.error) return c.json({ error: chk.error }, chk.status)
      if (chk.staff[0]?.employment_status === 'leave') warnings.push(`${chk.staff[0].name}: 休職中です`)
    }
    // 仮登録を作る場合も、作る前に定員・重複を確認する
    warnings.push(...await approvalWarnings(db, u.company_id, staffId, toApprove))
    if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  }

  // ---- 対象の明細を押さえる（ほかの操作で対応済み・処理中のものがあれば何もしない） ----
  // 繰り上げ（見送り → 承認）の明細は、見送りのままであることを条件に押さえ、失敗したときは見送りに戻す（#211）
  const allIds = [...approveIds, ...rejectIds]
  const from = (id: number) => byId.get(id)!
  const claimed = await db.batch(allIds.map(id => db.prepare("UPDATE recruit_application_items SET status = 'processing', decided_at = ? WHERE item_id = ? AND application_id = ? AND status = ?").bind(nowJST(), id, a.application_id, from(id).status)))
  const mine = allIds.filter((_, k) => Number(claimed[k].meta.changes || 0) > 0)
  const release = async () => {
    if (mine.length) await db.batch(mine.map(id => db.prepare("UPDATE recruit_application_items SET status = ?, decided_at = ? WHERE item_id = ? AND status = 'processing'")
      .bind(from(id).status, from(id).status === 'pending' ? null : from(id).decided_at, id)))
  }
  if (mine.length !== allIds.length) {
    await release()
    return c.json({ error: 'この応募は、ほかの操作で対応中または対応済みです。画面を読み直してください' }, 409)
  }

  let createdStaff = false
  const now = nowJST(); const createdShifts: number[] = []
  try {
    if (toApprove.length && newStaff) {
      // 応募フォームのメールは本人確認をしていないため、ログイン・再設定の宛先（users.email）には入れず未確認のメールとして持つ（#38 #148）
      const created = await insertProvisionalStaff(db, u.company_id, u.user_id, { name: a.name, phone: a.phone || '', type: newStaff.type, affiliation: newStaff.affiliation, partnerId: newStaff.partnerId, kana: a.kana, unverified_email: a.email, memo: a.note ? `応募時のメモ: ${a.note}` : null, note: '募集から仮登録' })
      staffId = created.staff_id; createdStaff = true
    }
    // シフトの作成（確定）
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
      await db.prepare("UPDATE recruit_application_items SET status = 'approved', shift_id = ?, decided_at = ? WHERE item_id = ? AND status = 'processing'").bind(shiftId, now, it.item_id).run()
    }
    for (const id of rejectIds) await db.prepare("UPDATE recruit_application_items SET status = 'rejected', decided_at = ? WHERE item_id = ? AND status = 'processing'").bind(now, id).run()
    if (staffId && !a.staff_id) await db.prepare('UPDATE recruit_applications SET staff_id = ? WHERE application_id = ? AND staff_id IS NULL').bind(staffId, a.application_id).run()
  } catch (e) {
    // 途中で失敗したときは、まだ承認・見送りにしていない明細を未対応に戻す（作ったシフト・仮登録は残るので、画面で確認する）
    await release()
    throw e
  }
  await closeIfDone(db, a.application_id, u.user_id)
  // 承認で定員に達した枠に、ほかの人の未対応の応募が残っていれば知らせる（画面からまとめて見送れる。#303）
  const filled = []
  for (const rid of new Set(toApprove.map(i => i.slot_role_id as number))) {
    const s = await slotSummary(db, u.company_id, rid)
    if (s && s.full && s.pending) filled.push(s)
  }
  return c.json({ ok: true, staff_id: staffId, created_staff: createdStaff, created_shifts: createdShifts.length, rejected: rejectIds.length,
    promoted: toApprove.filter(i => i.status === 'rejected').length, filled_slots: filled })
})

async function approvalWarnings(db: D1Database, companyId: number, staffId: number | null, items: any[]) {
  const w: string[] = []
  const label = (i: any) => `${i.work_date.slice(5).replace('-', '/')} ${i.start_time}〜${i.end_time} ${i.role_name}`
  // 同じ枠を同時に承認する分も数える
  const plan = new Map<number, number>()
  const now = nowJST()
  for (const i of items) {
    const extra = (plan.get(i.slot_role_id) || 0) + 1; plan.set(i.slot_role_id, extra)
    if (Number(i.assigned) + extra > Number(i.headcount)) w.push(`${label(i)}: 定員（${i.headcount}名）を超えます`)
    if (hasStarted(i, now)) w.push(`${label(i)}: ${i.work_date < now.slice(0, 10) ? '過去の日付です' : '開始時刻を過ぎています'}`)
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
      if (list.length) w.push(`${label(i)}: 同じ時間帯に別のシフトがあります（${list.map((x: any) => conflictLabel(x, companyId)).join('、')}）`)
    }
    const projects = [...new Set(items.map(i => i.project_id))]
    for (const pid of projects) if ((await ngStaffIds(db, pid)).includes(staffId)) w.push(`クライアントのNGスタッフに指定されています（${items.find(i => i.project_id === pid)!.work_date}〜）`)
  }
  return w
}

// 個人情報の保存期間: 公開ページからの応募で、スタッフに紐づかず対応が終わったもの（または放置されたもの）は180日で削除する（Cron）
export async function purgeOldApplications(db: D1Database) {
  const cutoff = addDays(todayJST(), -RETENTION_DAYS) + ' 00:00:00'
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
