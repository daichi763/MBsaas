// 本部の支援機能（作業単位 w5-hq-support）
//  #179 伴走支援の依頼: 管理画面から依頼を送り（会社・依頼者を付けて保存）、本部ユーザーにメールで知らせる。本部は受付一覧で対応状況を管理する
//  #516 本部から導入企業の管理者へのお知らせ: 全企業・選んだ企業・プラン別に、掲載期間を付けて配信する。管理画面の上部に未確認のものを出す
//  #293 本部による管理画面の閲覧: 企業が許可したときだけ、期限付き・読み取り専用で閲覧する。開始・終了と開いた画面を記録する
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { hashToken } from './lib/auth'
import { sendEmailBatch } from './services/email'
import { escapeHtml } from './email-templates/_util'

type Bindings = {
  DB: D1Database; PHOTOS?: R2Bucket; DOCUMENTS?: R2Bucket; CONTRACTS?: R2Bucket
  RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string
}
type Env = { Bindings: Bindings; Variables: { user: any } }

const HQ_COMPANY_STATUS = 'internal'
const nowIso = () => new Date().toISOString()
// 日本時間の 'YYYY-MM-DD HH:MM'（お知らせの掲載期間と比べる）
const nowJstMinute = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
const isId = (v: unknown) => /^\d{1,9}$/.test(String(v ?? ''))
function settingsOf(json: unknown): Record<string, unknown> {
  try { const s = JSON.parse(String(json || '{}')); return s && typeof s === 'object' ? s : {} } catch { return {} }
}

// ============ #179 伴走支援の依頼 ============
export const SUPPORT_MENUS: Record<string, string> = {
  setup: '初期設定代行', report_design: '日報項目設計', staff_training: 'スタッフ研修', manager_training: '管理者教育',
  monthly_review: '月次運営レビュー', recruiting: '採用支援', retention: 'スタッフ定着支援', kpi: 'KPI設計', other: 'その他・相談',
}
const SUPPORT_STATUSES = ['open', 'in_progress', 'done'] as const
const SUPPORT_STATUS_LABEL: Record<string, string> = { open: '未対応', in_progress: '対応中', done: '完了' }
const SUPPORT_DETAIL_MAX = 2000
// 1社あたり1日に送れる依頼の数（誤操作の連打・いたずらで本部のメールが埋まらないように）
const SUPPORT_DAILY_LIMIT = 10

function supportRequestEmail(p: { companyName: string; companyCode: string; requester: string; menu: string; detail: string; preferredAt: string; contact: string; url: string }) {
  const subject = `【Field OS】伴走支援の依頼: ${p.companyName}（${p.menu}）`
  const rows: [string, string][] = [['企業', `${p.companyName}（${p.companyCode}）`], ['依頼者', p.requester], ['メニュー', p.menu], ['希望日時', p.preferredAt || '指定なし'], ['連絡先', p.contact || '指定なし']]
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:520px; margin:0 auto;">
      <p>管理画面から伴走支援の依頼が届きました。</p>
      <table style="border-collapse:collapse;margin:12px 0;">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;">${k}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`).join('')}</table>
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;white-space:pre-wrap;">${escapeHtml(p.detail)}</div>
      <p style="margin:20px 0;"><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#0e7490;color:#fff;text-decoration:none;padding:10px 20px;border-radius:10px;font-weight:bold;">本部画面で確認する</a></p>
    </div>`
  const text = `管理画面から伴走支援の依頼が届きました。\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${p.detail}\n\n本部画面で確認する: ${p.url}`
  return { subject, html, text }
}

// ============ #516 本部からのお知らせ ============
const ANN_IMPORTANCE = ['normal', 'important', 'maintenance'] as const
const ANN_TARGETS = ['all', 'companies', 'plan'] as const
const ANN_PLANS = ['basic', 'standard', 'premium'] as const
const ANN_TITLE_MAX = 100
const ANN_BODY_MAX = 3000
const ANN_TARGET_COMPANIES_MAX = 500
// 'YYYY-MM-DDTHH:MM' か 'YYYY-MM-DD HH:MM'（日本時間）を 'YYYY-MM-DD HH:MM' にそろえる。空なら null、形式違いは undefined
function jstMinute(v: unknown): string | null | undefined {
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = s.match(/^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))[T ]([01]\d|2[0-3]):([0-5]\d)$/)
  return m ? `${m[1]} ${m[4]}:${m[5]}` : undefined
}
// その企業に今出すお知らせ（取消・掲載期間外を除く）。? の順: now, now, company_id(plan), company_id
const ANN_ACTIVE_FOR_COMPANY = `a.withdrawn_at IS NULL AND a.starts_at <= ? AND (a.ends_at IS NULL OR a.ends_at > ?)
  AND (a.target = 'all'
    OR (a.target = 'plan' AND a.target_plan = (SELECT plan FROM companies WHERE company_id = ?))
    OR (a.target = 'companies' AND EXISTS (SELECT 1 FROM hq_announcement_companies x WHERE x.announcement_id = a.announcement_id AND x.company_id = ?)))`

type AnnInput = { title: string; body: string; importance: string; target: string; target_plan: string | null; company_ids: number[]; starts_at: string; ends_at: string | null }
async function parseAnnouncement(db: D1Database, b: any): Promise<AnnInput | { error: string }> {
  const title = str(b.title, ANN_TITLE_MAX + 1)
  const body = String(b.body ?? '').trim()
  if (!title) return { error: 'タイトルを入力してください' }
  if (title.length > ANN_TITLE_MAX) return { error: `タイトルは${ANN_TITLE_MAX}文字以内で入力してください` }
  if (!body) return { error: '本文を入力してください' }
  if (body.length > ANN_BODY_MAX) return { error: `本文は${ANN_BODY_MAX}文字以内で入力してください` }
  const importance = String(b.importance || 'normal')
  if (!(ANN_IMPORTANCE as readonly string[]).includes(importance)) return { error: '重要度が正しくありません' }
  const target = String(b.target || 'all')
  if (!(ANN_TARGETS as readonly string[]).includes(target)) return { error: '配信先が正しくありません' }
  let target_plan: string | null = null
  let company_ids: number[] = []
  if (target === 'plan') {
    target_plan = String(b.target_plan || '')
    if (!(ANN_PLANS as readonly string[]).includes(target_plan)) return { error: '配信先のプランを選んでください' }
  } else if (target === 'companies') {
    const raw = Array.isArray(b.company_ids) ? b.company_ids : []
    company_ids = [...new Set(raw.filter(isId).map(Number))] as number[]
    if (!company_ids.length) return { error: '配信先の企業を選んでください' }
    if (company_ids.length > ANN_TARGET_COMPANIES_MAX) return { error: `配信先の企業は${ANN_TARGET_COMPANIES_MAX}社までです` }
    const found = await db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE active_status != ? AND company_id IN (SELECT value FROM json_each(?))`)
      .bind(HQ_COMPANY_STATUS, JSON.stringify(company_ids)).first<{ n: number }>()
    if (Number(found?.n || 0) !== company_ids.length) return { error: '配信先に見つからない企業が含まれています' }
  }
  const starts = jstMinute(b.starts_at)
  if (starts === undefined) return { error: '掲載開始の日時の形式が正しくありません' }
  const ends = jstMinute(b.ends_at)
  if (ends === undefined) return { error: '掲載終了の日時の形式が正しくありません' }
  const starts_at = starts || nowJstMinute()
  if (ends && ends <= starts_at) return { error: '掲載終了は掲載開始より後の日時にしてください' }
  // メンテナンスの告知は、終わった後も出続けないよう掲載終了を必須にする
  if (importance === 'maintenance' && !ends) return { error: 'メンテナンスのお知らせは、掲載終了の日時を入れてください（過ぎると自動で消えます）' }
  return { title, body, importance, target, target_plan, company_ids, starts_at, ends_at: ends }
}

// ============ #293 本部による管理画面の閲覧（読み取り専用） ============
export const HQ_VIEW_COOKIE = 'hq_view'
// 閲覧中に使うロール。管理画面の閲覧はできるが、従業員管理（給与・口座・保険番号）・セキュリティ・管理者アカウントの画面は開けない
export const HQ_VIEW_ROLE = 'sales_manager'
const HQ_VIEW_MINUTES = [15, 30, 60]
const HQ_VIEW_REASON_MAX = 200
export const HQ_VIEW_READONLY_MESSAGE = '本部の閲覧（読み取り専用）では、登録・変更はできません'
/** 企業の設定で、本部の閲覧を許可しているか（既定は許可しない） */
export const hqViewAllowed = (settingsJson: unknown) => settingsOf(settingsJson).hq_view_allowed === true

/** 本部ユーザーの閲覧用 Cookie から、有効な閲覧の記録を引く（期限切れ・終了・企業が許可を取り消したものは null） */
export async function loadHqView(db: D1Database, token: string | undefined | null, hqUserId: number): Promise<any | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null
  const v = await db.prepare(`SELECT v.view_id, v.company_id, v.expires_at, v.started_at, v.reason, c.company_name, c.company_code, c.settings_json, c.active_status, c.plan
      FROM hq_view_sessions v JOIN companies c ON c.company_id = v.company_id
      WHERE v.token_hash = ? AND v.hq_user_id = ? AND v.ended_at IS NULL AND v.expires_at > ?`)
    .bind(await hashToken(token), hqUserId, nowIso()).first() as any
  if (!v || v.active_status === HQ_COMPANY_STATUS || !hqViewAllowed(v.settings_json)) return null
  return v
}

/** 閲覧中の利用者（会社はその企業、ロールは HQ_VIEW_ROLE。user_id は本部ユーザーのまま） */
export function hqViewUser(u: any, v: any) {
  return {
    ...u, role: HQ_VIEW_ROLE, company_id: v.company_id, company_name: v.company_name, company_code: v.company_code,
    settings_json: v.settings_json, company_active_status: v.active_status, staff_id: null, email: null,
    name: `本部（${u.name}）`, hq_view: { view_id: v.view_id, expires_at: v.expires_at, company_id: v.company_id },
  }
}

// 読み取りの SQL か。文字列の値・コメントを除いてから、先頭が SELECT / WITH で、書き込みの語を含まないものだけを読み取りとみなす（REPLACE 文は先頭で外れる。replace() 関数は通す）
const WRITE_SQL = /\b(insert|update|delete|create|drop|alter|pragma|attach|detach|vacuum|reindex)\b/i
export function isReadOnlySql(sql: string): boolean {
  const s = String(sql).replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  return /^\s*(select|with)\b/i.test(s) && !WRITE_SQL.test(s)
}
const readonlyError = () => new HTTPException(403, {
  res: new Response(JSON.stringify({ error: HQ_VIEW_READONLY_MESSAGE, code: 'hq_view_readonly' }), { status: 403, headers: { 'Content-Type': 'application/json; charset=UTF-8' } }),
})
// 一覧を開いたときの後片付けの書き込み（期限切れの掲載の終了・恒久IDの補完など）は、閲覧中は実行せず「0件を変更した」ことにする。
// 例外にすると一覧そのものが開けなくなるため。登録・変更の要求（GET 以外）は hqViewAdminGuard で先に止めている
const SKIPPED_WRITE = Symbol('hq_view_skipped_write')
function skippedStatement(): any {
  const result = { success: true, results: [], meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: 0, rows_written: 0 } }
  const st: any = {
    [SKIPPED_WRITE]: true,
    bind: () => st,
    run: async () => result, all: async () => result, first: async () => null, raw: async () => [],
  }
  return st
}
function readOnlyDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => isReadOnlySql(sql) ? t.prepare(sql) : skippedStatement()
      if (p === 'batch') return async (stmts: any[]) => {
        const real = stmts.filter(s => !s?.[SKIPPED_WRITE])
        const out = real.length ? await t.batch(real) : []
        let i = 0
        return stmts.map(s => s?.[SKIPPED_WRITE] ? { success: true, results: [], meta: { changes: 0, last_row_id: 0 } } : out[i++])
      }
      if (p === 'exec' || p === 'dump' || p === 'withSession') return () => { throw readonlyError() }
      const v = Reflect.get(t, p)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}
function readOnlyBucket(b: R2Bucket): R2Bucket {
  return new Proxy(b, {
    get(t, p) {
      if (p === 'put' || p === 'delete' || p === 'createMultipartUpload' || p === 'resumeMultipartUpload') return () => { throw readonlyError() }
      const v = Reflect.get(t, p)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}
/** この要求の中だけで使う、書き込みのできない環境（D1 の書き込みは実行しない。R2 の書き込みは 403） */
export function readOnlyEnv<T extends Record<string, any>>(env: T): T {
  const out: any = { ...env, DB: readOnlyDb(env.DB) }
  for (const k of ['PHOTOS', 'DOCUMENTS', 'CONTRACTS']) if (env[k]) out[k] = readOnlyBucket(env[k])
  return out
}

/**
 * /api/admin/* の前に置くミドルウェア。本部ユーザー（system_admin）は、有効な閲覧の記録があるときだけ、
 * その企業の管理画面の API を GET で使える（ロールは HQ_VIEW_ROLE、D1・R2 は読み取り専用）。開いたパスを記録する
 */
export async function hqViewAdminGuard(c: any, next: () => Promise<void>) {
  const u = c.get('user')
  if (u?.role !== 'system_admin') return next()
  const db = c.env.DB as D1Database
  const v = await loadHqView(db, getCookie(c, HQ_VIEW_COOKIE), u.user_id)
  if (!v) return c.json({ error: '本部のアカウントでは管理画面を操作できません。閲覧は本部画面の「伴走支援」から、企業が許可している場合に開始できます', code: 'hq_view_required' }, 403)
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json({ error: HQ_VIEW_READONLY_MESSAGE, code: 'hq_view_readonly' }, 403)
  if (c.req.header('X-Background') !== '1') {
    // パスに入るトークン（報告用URLなど）は残さない
    const path = String(c.req.path).replace(/[A-Za-z0-9_-]{20,}/g, '***').slice(0, 300)
    await db.prepare('INSERT INTO hq_view_logs (view_id, method, path, created_at) VALUES (?, ?, ?, ?)').bind(v.view_id, c.req.method, path, nowIso()).run()
  }
  c.set('user', hqViewUser(u, v))
  c.env = readOnlyEnv(c.env)
  await next()
  // 応答に入る生きたトークン（報告用URL・カレンダー購読など）は閲覧中には返さない（#293。公開の API は閲覧の制限の外にあるため）
  if (!String(c.res?.headers?.get('content-type') || '').includes('application/json')) return
  // トークンらしい文字列がない応答は JSON を解かずにそのまま返す（大きな一覧で CPU 時間を使わないように）
  const text = await c.res.clone().text().catch(() => '')
  if (!TOKEN_HINT_RE.test(text)) return
  let body: any
  try { body = JSON.parse(text) } catch { return }
  const masked = maskTokens(body)
  if (masked.changed) {
    const headers = new Headers(c.res.headers); headers.delete('content-length')
    c.res = new Response(JSON.stringify(masked.value), { status: c.res.status, headers })
  }
}
// キーが token / 〜_token の値と、文字列の中の公開URLのトークン（/r/… /api/public/report/… /api/public/calendar/…）を伏せる
const TOKEN_KEY_RE = /(^|_)token$/i
const TOKEN_URL_RE = /(\/r\/|\/api\/public\/(?:report|calendar|schedule)\/)[A-Za-z0-9_-]{16,}/g
const TOKEN_HINT_RE = /token"\s*:|\/r\/|\/api\/public\//i
export function maskTokens(v: any): { value: any; changed: boolean } {
  let changed = false
  const walk = (x: any, depth: number): any => {
    if (depth > 20) return x
    if (typeof x === 'string') { const y = x.replace(TOKEN_URL_RE, '$1***'); if (y !== x) changed = true; return y }
    if (Array.isArray(x)) return x.map(e => walk(e, depth + 1))
    if (x && typeof x === 'object') {
      const out: any = {}
      for (const [k, val] of Object.entries(x)) {
        if (TOKEN_KEY_RE.test(k) && typeof val === 'string' && val) { out[k] = null; changed = true } else out[k] = walk(val, depth + 1)
      }
      return out
    }
    return x
  }
  const value = walk(v, 0)
  return { value, changed }
}

// ============ 管理画面の API（/api/admin に登録する） ============
export const hqSupportAdminApi = new Hono<Env>()

// 管理画面の上部に出すもの: 未確認の本部のお知らせ、本部が閲覧中かどうか、閲覧の許可の状態
hqSupportAdminApi.get('/hq-support/status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const now = nowJstMinute()
  const viewing = !!u.hq_view
  const anns = (await db.prepare(`SELECT a.announcement_id, a.title, a.body, a.importance, a.starts_at, a.ends_at
      FROM hq_announcements a WHERE ${ANN_ACTIVE_FOR_COMPANY}
        AND NOT EXISTS (SELECT 1 FROM hq_announcement_reads r WHERE r.announcement_id = a.announcement_id AND r.user_id = ?)
      ORDER BY CASE a.importance WHEN 'maintenance' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, a.starts_at DESC LIMIT 10`)
    .bind(now, now, u.company_id, u.company_id, viewing ? 0 : u.user_id).all()).results
  const views = viewing ? [] : (await db.prepare(`SELECT v.started_at, v.expires_at, us.name AS hq_name FROM hq_view_sessions v LEFT JOIN users us ON us.user_id = v.hq_user_id
      WHERE v.company_id = ? AND v.ended_at IS NULL AND v.expires_at > ? ORDER BY v.started_at DESC LIMIT 5`).bind(u.company_id, nowIso()).all()).results
  return c.json({ announcements: anns, active_views: views, viewing, view_allowed: hqViewAllowed(u.settings_json), can_manage_view: u.role === 'company_admin' })
})

// 本部のお知らせの一覧（掲載中のもの。確認済みも含む）
hqSupportAdminApi.get('/hq-announcements', async (c) => {
  const u = c.get('user'); const now = nowJstMinute()
  const rows = (await c.env.DB.prepare(`SELECT a.announcement_id, a.title, a.body, a.importance, a.starts_at, a.ends_at,
        (SELECT r.read_at FROM hq_announcement_reads r WHERE r.announcement_id = a.announcement_id AND r.user_id = ?) AS read_at
      FROM hq_announcements a WHERE ${ANN_ACTIVE_FOR_COMPANY} ORDER BY a.starts_at DESC LIMIT 50`)
    .bind(u.hq_view ? 0 : u.user_id, now, now, u.company_id, u.company_id).all()).results
  return c.json({ announcements: rows })
})

hqSupportAdminApi.post('/hq-announcements/:id/read', async (c) => {
  const u = c.get('user'); const id = c.req.param('id'); const now = nowJstMinute()
  if (!isId(id)) return c.json({ error: 'not found' }, 404)
  const a = await c.env.DB.prepare(`SELECT a.announcement_id FROM hq_announcements a WHERE a.announcement_id = ? AND ${ANN_ACTIVE_FOR_COMPANY}`)
    .bind(Number(id), now, now, u.company_id, u.company_id).first()
  if (!a) return c.json({ error: 'お知らせが見つかりません（掲載が終わったか、取り消されました）' }, 404)
  await c.env.DB.prepare('INSERT OR IGNORE INTO hq_announcement_reads (announcement_id, user_id, company_id) VALUES (?, ?, ?)').bind(Number(id), u.user_id, u.company_id).run()
  return c.json({ ok: true })
})

// 自社の伴走支援の依頼の一覧（新しい順）
hqSupportAdminApi.get('/support-requests', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT request_id, menu, detail, preferred_at, contact, status, requester_name, created_at, updated_at
      FROM support_requests WHERE company_id = ? ORDER BY request_id DESC LIMIT 30`).bind(u.company_id).all()).results
  return c.json({ requests: rows, menus: SUPPORT_MENUS })
})

hqSupportAdminApi.post('/support-requests', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({})) as any
  const menu = String(b.menu || '')
  if (!SUPPORT_MENUS[menu]) return c.json({ error: '依頼のメニューを選んでください' }, 400)
  const detail = String(b.detail ?? '').trim()
  if (!detail) return c.json({ error: '依頼の内容を入力してください' }, 400)
  if (detail.length > SUPPORT_DETAIL_MAX) return c.json({ error: `依頼の内容は${SUPPORT_DETAIL_MAX}文字以内で入力してください` }, 400)
  const preferredAt = str(b.preferred_at, 100)
  const contact = str(b.contact, 200)
  const today = await db.prepare(`SELECT COUNT(*) AS n FROM support_requests WHERE company_id = ? AND created_at >= datetime('now', '-1 day')`).bind(u.company_id).first<{ n: number }>()
  if (Number(today?.n || 0) >= SUPPORT_DAILY_LIMIT) return c.json({ error: '1日に送れる依頼の数を超えました。急ぎの場合は、担当者へ直接ご連絡ください' }, 429)
  const row = await db.prepare(`INSERT INTO support_requests (company_id, user_id, requester_name, menu, detail, preferred_at, contact)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING request_id`)
    .bind(u.company_id, u.user_id, u.name || null, menu, detail, preferredAt || null, contact || null).first<{ request_id: number }>()
  // 本部ユーザー（本部専用の企業行に所属し、メールアドレスのある人）にメールで知らせる。届かなくても依頼は本部画面の受付一覧に出る
  const hqUsers = (await db.prepare(`SELECT us.email FROM users us JOIN companies co ON co.company_id = us.company_id
      WHERE us.role = 'system_admin' AND us.status = 'active' AND co.active_status = ? AND us.email IS NOT NULL AND TRIM(us.email) != ''`)
    .bind(HQ_COMPANY_STATUS).all()).results as any[]
  let mailQueued = 0
  if (hqUsers.length) {
    const tpl = supportRequestEmail({
      companyName: String(u.company_name || ''), companyCode: String(u.company_code || ''), requester: String(u.name || ''),
      menu: SUPPORT_MENUS[menu], detail, preferredAt, contact, url: `${String(c.env.APP_BASE_URL || '').replace(/\/+$/, '')}/hq#support`,
    })
    const inputs = [...new Set(hqUsers.map(x => String(x.email).trim()))].map(to => ({ to, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'support_request', company_id: u.company_id }))
    mailQueued = inputs.length
    const p = sendEmailBatch(c.env, inputs).catch(() => [])
    try { c.executionCtx.waitUntil(p) } catch { await p }
  }
  return c.json({ ok: true, request_id: row?.request_id, mail_queued: mailQueued })
})

// 本部の閲覧の許可と、これまでの閲覧の記録（いつ・誰が・何のために）
hqSupportAdminApi.get('/hq-access', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT v.view_id, v.reason, v.started_at, v.expires_at, v.ended_at, v.end_reason, us.name AS hq_name,
        (SELECT COUNT(*) FROM hq_view_logs l WHERE l.view_id = v.view_id) AS pages
      FROM hq_view_sessions v LEFT JOIN users us ON us.user_id = v.hq_user_id
      WHERE v.company_id = ? ORDER BY v.view_id DESC LIMIT 20`).bind(u.company_id).all()).results
  return c.json({ allowed: hqViewAllowed(u.settings_json), can_manage: u.role === 'company_admin', sessions: rows, now: nowIso() })
})

// 閲覧の許可の切り替え（会社管理者のみ）。取り消したときは、閲覧中のものもその場で終える
hqSupportAdminApi.put('/hq-access', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (u.role !== 'company_admin') return c.json({ error: '本部の閲覧の許可は、会社管理者だけが変更できます' }, 403)
  const b = await c.req.json().catch(() => ({})) as any
  if (typeof b.allowed !== 'boolean') return c.json({ error: 'allowed は true か false で指定してください' }, 400)
  const stmts = [db.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.hq_view_allowed', json(?)) WHERE company_id = ?`)
    .bind(b.allowed ? 'true' : 'false', u.company_id)]
  if (!b.allowed) stmts.push(db.prepare(`UPDATE hq_view_sessions SET ended_at = ?, end_reason = 'revoked' WHERE company_id = ? AND ended_at IS NULL`).bind(nowIso(), u.company_id))
  await db.batch(stmts)
  return c.json({ ok: true, allowed: b.allowed })
})

// ============ 本部の API（/api/hq に登録する。system_admin の確認は api.ts の /hq/* のミドルウェア） ============
export const hqSupportHqApi = new Hono<Env>()

// ---- 伴走支援の依頼の受付一覧 ----
hqSupportHqApi.get('/support-requests', async (c) => {
  const status = String(c.req.query('status') || '')
  const filter = (SUPPORT_STATUSES as readonly string[]).includes(status) ? status : ''
  const rows = (await c.env.DB.prepare(`SELECT r.*, co.company_name, co.company_code, hu.name AS handled_by_name
      FROM support_requests r JOIN companies co ON co.company_id = r.company_id LEFT JOIN users hu ON hu.user_id = r.handled_by
      ${filter ? 'WHERE r.status = ?' : ''} ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, r.request_id DESC LIMIT 200`)
    .bind(...(filter ? [filter] : [])).all()).results
  const counts = (await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM support_requests GROUP BY status').all()).results as any[]
  return c.json({ requests: rows, counts: Object.fromEntries(counts.map(x => [x.status, Number(x.n)])), menus: SUPPORT_MENUS, statuses: SUPPORT_STATUS_LABEL })
})

hqSupportHqApi.put('/support-requests/:id', async (c) => {
  const u = c.get('user'); const id = c.req.param('id')
  if (!isId(id)) return c.json({ error: 'not found' }, 404)
  const b = await c.req.json().catch(() => ({})) as any
  if (!(SUPPORT_STATUSES as readonly string[]).includes(String(b.status))) return c.json({ error: '対応状況が正しくありません' }, 400)
  const note = String(b.hq_note ?? '').trim()
  if (note.length > SUPPORT_DETAIL_MAX) return c.json({ error: `対応メモは${SUPPORT_DETAIL_MAX}文字以内で入力してください` }, 400)
  const r = await c.env.DB.prepare(`UPDATE support_requests SET status = ?, hq_note = ?, handled_by = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?`)
    .bind(b.status, note || null, u.user_id, Number(id)).run()
  if (!r.meta.changes) return c.json({ error: '依頼が見つかりません' }, 404)
  return c.json({ ok: true })
})

// ---- 導入企業へのお知らせ ----
hqSupportHqApi.get('/announcements', async (c) => {
  const now = nowJstMinute()
  const rows = (await c.env.DB.prepare(`SELECT a.*, cu.name AS created_by_name,
        CASE a.target
          WHEN 'all' THEN (SELECT COUNT(*) FROM companies WHERE active_status NOT IN (?, 'inactive'))
          WHEN 'plan' THEN (SELECT COUNT(*) FROM companies WHERE active_status NOT IN (?, 'inactive') AND plan = a.target_plan)
          ELSE (SELECT COUNT(*) FROM hq_announcement_companies x WHERE x.announcement_id = a.announcement_id) END AS target_count,
        (SELECT COUNT(DISTINCT r.company_id) FROM hq_announcement_reads r WHERE r.announcement_id = a.announcement_id) AS read_companies,
        (SELECT json_group_array(x.company_id) FROM hq_announcement_companies x WHERE x.announcement_id = a.announcement_id) AS company_ids_json,
        CASE WHEN a.withdrawn_at IS NOT NULL THEN 'withdrawn' WHEN a.starts_at > ? THEN 'scheduled' WHEN a.ends_at IS NOT NULL AND a.ends_at <= ? THEN 'ended' ELSE 'active' END AS state
      FROM hq_announcements a LEFT JOIN users cu ON cu.user_id = a.created_by
      ORDER BY a.announcement_id DESC LIMIT 100`).bind(HQ_COMPANY_STATUS, HQ_COMPANY_STATUS, now, now).all()).results as any[]
  const companies = (await c.env.DB.prepare(`SELECT company_id, company_name, plan, active_status FROM companies WHERE active_status != ? ORDER BY company_id`).bind(HQ_COMPANY_STATUS).all()).results
  return c.json({ announcements: rows.map(r => ({ ...r, company_ids: safeIds(r.company_ids_json), company_ids_json: undefined })), companies })
})
function safeIds(json: unknown): number[] { try { const a = JSON.parse(String(json || '[]')); return Array.isArray(a) ? a.map(Number) : [] } catch { return [] } }

// 企業別の既読状況（配信先の企業ごとに、確認した管理者の人数と最初の確認日時）
hqSupportHqApi.get('/announcements/:id/reads', async (c) => {
  const id = c.req.param('id')
  if (!isId(id)) return c.json({ error: 'not found' }, 404)
  const a = await c.env.DB.prepare('SELECT * FROM hq_announcements WHERE announcement_id = ?').bind(Number(id)).first() as any
  if (!a) return c.json({ error: 'お知らせが見つかりません' }, 404)
  const where = a.target === 'all' ? `co.active_status NOT IN (?, 'inactive')`
    : a.target === 'plan' ? `co.active_status NOT IN (?, 'inactive') AND co.plan = ?`
      : `co.active_status != ? AND co.company_id IN (SELECT company_id FROM hq_announcement_companies WHERE announcement_id = ?)`
  const binds: any[] = [Number(id), Number(id), HQ_COMPANY_STATUS]
  if (a.target === 'plan') binds.push(a.target_plan)
  if (a.target === 'companies') binds.push(Number(id))
  const rows = (await c.env.DB.prepare(`SELECT co.company_id, co.company_name, co.active_status,
        (SELECT COUNT(*) FROM hq_announcement_reads r WHERE r.announcement_id = ? AND r.company_id = co.company_id) AS read_users,
        (SELECT MIN(r.read_at) FROM hq_announcement_reads r WHERE r.announcement_id = ? AND r.company_id = co.company_id) AS first_read_at
      FROM companies co WHERE ${where} ORDER BY read_users = 0 DESC, co.company_id`).bind(...binds).all()).results
  return c.json({ announcement: a, companies: rows })
})

hqSupportHqApi.post('/announcements', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await parseAnnouncement(db, await c.req.json().catch(() => ({})))
  if ('error' in p) return c.json({ error: p.error }, 400)
  const row = await db.prepare(`INSERT INTO hq_announcements (title, body, importance, target, target_plan, starts_at, ends_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING announcement_id`)
    .bind(p.title, p.body, p.importance, p.target, p.target_plan, p.starts_at, p.ends_at, u.user_id).first<{ announcement_id: number }>()
  const id = row!.announcement_id
  if (p.company_ids.length) {
    await db.prepare(`INSERT OR IGNORE INTO hq_announcement_companies (announcement_id, company_id) SELECT ?, value FROM json_each(?)`).bind(id, JSON.stringify(p.company_ids)).run()
  }
  return c.json({ ok: true, announcement_id: id })
})

// 修正（内容・配信先・掲載期間）。取り消したものは直せない。確認済みの記録は残す
hqSupportHqApi.put('/announcements/:id', async (c) => {
  const id = c.req.param('id'); const db = c.env.DB
  if (!isId(id)) return c.json({ error: 'not found' }, 404)
  const cur = await db.prepare('SELECT withdrawn_at FROM hq_announcements WHERE announcement_id = ?').bind(Number(id)).first() as any
  if (!cur) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (cur.withdrawn_at) return c.json({ error: '取り消したお知らせは修正できません' }, 409)
  const p = await parseAnnouncement(db, await c.req.json().catch(() => ({})))
  if ('error' in p) return c.json({ error: p.error }, 400)
  await db.batch([
    db.prepare(`UPDATE hq_announcements SET title = ?, body = ?, importance = ?, target = ?, target_plan = ?, starts_at = ?, ends_at = ?, updated_at = CURRENT_TIMESTAMP WHERE announcement_id = ?`)
      .bind(p.title, p.body, p.importance, p.target, p.target_plan, p.starts_at, p.ends_at, Number(id)),
    db.prepare('DELETE FROM hq_announcement_companies WHERE announcement_id = ?').bind(Number(id)),
    db.prepare(`INSERT OR IGNORE INTO hq_announcement_companies (announcement_id, company_id) SELECT ?, value FROM json_each(?)`).bind(Number(id), JSON.stringify(p.company_ids)),
  ])
  return c.json({ ok: true })
})

hqSupportHqApi.post('/announcements/:id/withdraw', async (c) => {
  const id = c.req.param('id')
  if (!isId(id)) return c.json({ error: 'not found' }, 404)
  const r = await c.env.DB.prepare('UPDATE hq_announcements SET withdrawn_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE announcement_id = ? AND withdrawn_at IS NULL').bind(Number(id)).run()
  if (!r.meta.changes) return c.json({ error: 'お知らせが見つからないか、取り消し済みです' }, 404)
  return c.json({ ok: true })
})

// ---- 管理画面の閲覧（読み取り専用） ----
// 企業ごとの許可の状態・自分の閲覧中のもの・最近の閲覧の記録
hqSupportHqApi.get('/view-sessions', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const current = await loadHqView(db, getCookie(c, HQ_VIEW_COOKIE), u.user_id)
  const companies = ((await db.prepare(`SELECT company_id, company_name, company_code, active_status, settings_json FROM companies WHERE active_status != ? ORDER BY company_id`)
    .bind(HQ_COMPANY_STATUS).all()).results as any[]).map(x => ({ company_id: x.company_id, company_name: x.company_name, company_code: x.company_code, active_status: x.active_status, allowed: hqViewAllowed(x.settings_json) }))
  const sessions = (await db.prepare(`SELECT v.view_id, v.company_id, co.company_name, v.reason, v.support_request_id, v.started_at, v.expires_at, v.ended_at, v.end_reason, us.name AS hq_name,
        (SELECT COUNT(*) FROM hq_view_logs l WHERE l.view_id = v.view_id) AS pages
      FROM hq_view_sessions v JOIN companies co ON co.company_id = v.company_id LEFT JOIN users us ON us.user_id = v.hq_user_id
      ORDER BY v.view_id DESC LIMIT 50`).all()).results
  return c.json({ current: current ? { view_id: current.view_id, company_id: current.company_id, company_name: current.company_name, expires_at: current.expires_at } : null,
    companies, sessions, minutes: HQ_VIEW_MINUTES, now: nowIso() })
})

hqSupportHqApi.get('/view-sessions/:id/logs', async (c) => {
  const id = c.req.param('id')
  if (!isId(id)) return c.json({ error: 'not found' }, 404)
  const rows = (await c.env.DB.prepare('SELECT method, path, created_at FROM hq_view_logs WHERE view_id = ? ORDER BY log_id DESC LIMIT 500').bind(Number(id)).all()).results
  return c.json({ logs: rows })
})

// 閲覧の開始。企業が許可しているときだけ。同じ本部ユーザーの閲覧中のものは終える（同時に開けるのは1社だけ）
hqSupportHqApi.post('/view-sessions', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({})) as any
  if (!isId(b.company_id)) return c.json({ error: '企業を選んでください' }, 400)
  const reason = str(b.reason, HQ_VIEW_REASON_MAX + 1)
  if (!reason) return c.json({ error: '閲覧の目的（問い合わせの内容・依頼の番号など）を入力してください' }, 400)
  if (reason.length > HQ_VIEW_REASON_MAX) return c.json({ error: `閲覧の目的は${HQ_VIEW_REASON_MAX}文字以内で入力してください` }, 400)
  const minutes = Number(b.minutes || 30)
  if (!HQ_VIEW_MINUTES.includes(minutes)) return c.json({ error: '閲覧の時間が正しくありません' }, 400)
  const requestId = b.support_request_id == null || b.support_request_id === '' ? null : isId(b.support_request_id) ? Number(b.support_request_id) : NaN
  if (Number.isNaN(requestId)) return c.json({ error: '依頼の番号が正しくありません' }, 400)
  const co = await db.prepare('SELECT company_id, company_name, active_status, settings_json FROM companies WHERE company_id = ?').bind(Number(b.company_id)).first() as any
  if (!co || co.active_status === HQ_COMPANY_STATUS) return c.json({ error: '企業が見つかりません' }, 404)
  if (!hqViewAllowed(co.settings_json)) return c.json({ error: 'この企業は本部の閲覧を許可していません。企業の会社管理者に、管理画面の「伴走支援を依頼する」から許可してもらってください', code: 'hq_view_not_allowed' }, 403)
  if (requestId != null && !(await db.prepare('SELECT 1 FROM support_requests WHERE request_id = ? AND company_id = ?').bind(requestId, co.company_id).first())) {
    return c.json({ error: 'この企業の依頼の番号ではありません' }, 400)
  }
  const a = new Uint8Array(32); crypto.getRandomValues(a)
  const token = [...a].map(x => x.toString(16).padStart(2, '0')).join('')
  const started = nowIso()
  const expires = new Date(Date.now() + minutes * 60 * 1000).toISOString()
  await db.batch([
    db.prepare(`UPDATE hq_view_sessions SET ended_at = ?, end_reason = 'replaced' WHERE hq_user_id = ? AND ended_at IS NULL`).bind(started, u.user_id),
    db.prepare(`INSERT INTO hq_view_sessions (token_hash, hq_user_id, company_id, reason, support_request_id, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(await hashToken(token), u.user_id, co.company_id, reason, requestId, started, expires),
  ])
  const secure = new URL(c.req.url).protocol === 'https:'
  setCookie(c, HQ_VIEW_COOKIE, token, { path: '/', httpOnly: true, secure, sameSite: 'Lax', maxAge: minutes * 60 })
  return c.json({ ok: true, company_name: co.company_name, expires_at: expires, redirect: '/admin' })
})

// 閲覧の終了（自分の閲覧中のもの）
hqSupportHqApi.delete('/view-sessions/current', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`UPDATE hq_view_sessions SET ended_at = ?, end_reason = 'hq' WHERE hq_user_id = ? AND ended_at IS NULL`).bind(nowIso(), u.user_id).run()
  deleteCookie(c, HQ_VIEW_COOKIE, { path: '/', secure: new URL(c.req.url).protocol === 'https:' })
  return c.json({ ok: true, ended: r.meta.changes || 0 })
})
