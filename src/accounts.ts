// =========================================================
// アカウントの管理（作業単位 w2-account-admin。#25 #43 #44 #45 #372）
// - 自分のアカウント（/api/auth/*。認証ミドルウェアの後に登録）: 氏名・メールアドレスの変更、パスワードの変更
// - 管理者アカウント（/api/admin/users。company_admin のみ）: 営業・現場・事務の管理者の追加・権限の変更・停止・パスワード再発行
// - 本部（/api/hq/companies/:id/users）: 導入企業の管理者の追加・メールアドレスの設定・停止・パスワード再発行
// パスワードは lib/auth の validatePassword / hashPassword を使い、変更・再発行・停止のときはセッションを消す。
// 仮パスワード（管理者・本部が決めたもの）は users.must_change_password = 1 にし、本人の変更で 0 に戻す。
// =========================================================
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import {
  SESSION_COOKIE, hashPassword, verifyPassword, validatePassword, hashToken, revokeSessionsStmt,
  loginAttemptKeys, isLoginLocked, recordLoginFailure, LOGIN_WINDOW_MINUTES,
} from './lib/auth'
import { sendEmail } from './services/email'
import { passwordResetEmail } from './email-templates/password-reset'
import { accountEmailChangedEmail } from './email-templates/account-email'

type Bindings = { DB: D1Database; RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string }
type Variables = { user: any }
type Env = { Bindings: Bindings; Variables: Variables }

/** 管理系のロール（本部 system_admin は含めない） */
export const ADMIN_ACCOUNT_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff'] as const
/** 本部専用の企業行の active_status（0033。本部の企業一覧・課金の集計に出さない） */
export const HQ_COMPANY_STATUS = 'internal'
const USER_STATUSES = ['active', 'suspended']
const RESET_EXPIRES_HOURS = 1
const VALID_EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function genToken(): string {
  const a = new Uint8Array(32); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** メールアドレスの入力値（空欄は null）。形式が正しくなければ undefined */
export function cleanEmail(v: unknown): string | null | undefined {
  const s = String(v ?? '').trim()
  if (!s) return null
  return s.length <= 254 && VALID_EMAIL.test(s) ? s : undefined
}

// 紛らわしい文字（0/O・1/l/I）を除いた12文字の仮パスワード
const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
export function genTempPassword(len = 12): string {
  const out: string[] = []
  const limit = 256 - (256 % TEMP_CHARS.length) // 偏りが出ないよう、端数の値は捨てる
  while (out.length < len) {
    const buf = new Uint8Array(len * 2); crypto.getRandomValues(buf)
    for (const b of buf) { if (b < limit && out.length < len) out.push(TEMP_CHARS[b % TEMP_CHARS.length]) }
  }
  return out.join('')
}

/**
 * 仮パスワードを発行する（管理者によるスタッフ・管理者の再発行、本部による再発行で共用）。
 * 次回ログインで変更を求め（must_change_password = 1）、未使用の再設定リンクとすべてのセッションを無効にする。
 */
export async function issueTempPassword(db: D1Database, userId: number): Promise<string> {
  const pw = genTempPassword()
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE user_id = ?').bind(await hashPassword(pw), userId),
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(nowJST(), userId),
    // 企業を切り替えたスタッフのセッションは稼働先の行を指すため、同じ人の行のセッションもまとめて消す
    db.prepare(`DELETE FROM sessions WHERE user_id = ? OR user_id IN (
        SELECT user_id FROM users WHERE person_id IS NOT NULL AND person_id = (SELECT person_id FROM users WHERE user_id = ?))`).bind(userId, userId),
  ])
  return pw
}

/** パスワード再設定メール（1時間有効のリンク）を送る。/auth/forgot-password と本部の再発行で共用 */
export async function sendPasswordResetLink(env: Bindings, u: { user_id: number; name: string; user_code: string; email: string; company_id: number; company_name: string }) {
  const rawToken = genToken()
  const expiresAt = new Date(Date.now() + RESET_EXPIRES_HOURS * 3600 * 1000).toISOString()
  await env.DB.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .bind(u.user_id, await hashToken(rawToken), expiresAt).run()
  const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${rawToken}`
  // 同じメールアドレスに複数の会社のアカウントがあっても、どのアカウントのリンクか分かるように会社名とIDを入れる
  const tpl = passwordResetEmail({ name: u.name, resetUrl, expiresInHours: RESET_EXPIRES_HOURS, companyName: u.company_name, userCode: u.user_code })
  return sendEmail(env, { to: String(u.email).trim(), subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'password_reset', company_id: u.company_id })
}

// ---------- 管理者アカウントの共通処理（会社の管理者・本部で共用） ----------
type Result = { status: 200 | 400 | 403 | 404 | 409; body: any }
const fail = (status: Result['status'], error: string): Result => ({ status, body: { error } })

/** 管理者アカウントの追加。password を省くと仮パスワードを作って返す（一度だけ表示する） */
export async function createAdminAccount(db: D1Database, companyId: number, b: any): Promise<Result> {
  // ID はログインの照合と同じく NFKC で半角にそろえて保存する（#387。全角で入力しても半角で入力してもログインできるように）
  const userCode = String(b.user_code ?? '').normalize('NFKC').trim()
  const name = String(b.name ?? '').trim()
  const role = ADMIN_ACCOUNT_ROLES.includes(b.role) ? b.role : null
  if (!/^\S{1,40}$/.test(userCode)) return fail(400, 'ID を空白なしの40文字以内で入力してください')
  if (!name || name.length > 60) return fail(400, '氏名を60文字以内で入力してください')
  if (!role) return fail(400, '権限を選択してください')
  const email = cleanEmail(b.email)
  if (email === undefined) return fail(400, 'メールアドレスの形式が正しくありません')
  let password = typeof b.password === 'string' ? b.password : ''
  const generated = !password
  if (generated) password = genTempPassword()
  const pwErr = validatePassword(password)
  if (pwErr) return fail(400, pwErr)
  // 大文字・小文字だけが違う ID は、ログインで区別できない（どちらか決められず一致なしになる）ため同じ ID として扱う
  const dup = await db.prepare('SELECT 1 FROM users WHERE company_id = ? AND LOWER(user_code) = LOWER(?)').bind(companyId, userCode).first()
  if (dup) return fail(409, 'この ID はすでに使われています（スタッフ番号と同じ ID も使えません）')
  try {
    const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, status, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 'active', 1)`)
      .bind(companyId, userCode, name, role, await hashPassword(password), email).run()
    return { status: 200, body: { ok: true, user_id: r.meta.last_row_id, ...(generated ? { temp_password: password } : {}) } }
  } catch {
    return fail(409, 'この ID はすでに使われています（スタッフ番号と同じ ID も使えません）')
  }
}

/** 管理者アカウントの対象行（自社の管理系ロールだけ。スタッフ・本部ユーザーは対象外） */
async function loadAdminAccount(db: D1Database, companyId: number, userId: any) {
  if (!/^\d+$/.test(String(userId ?? ''))) return null
  return db.prepare(`SELECT u.user_id, u.company_id, u.user_code, u.name, u.email, u.role, u.status, co.company_name
    FROM users u JOIN companies co ON co.company_id = u.company_id
    WHERE u.user_id = ? AND u.company_id = ? AND u.role IN ('company_admin','sales_manager','field_manager','office_staff')`)
    .bind(Number(userId), companyId).first() as Promise<any>
}

/**
 * 管理者アカウントの変更（氏名・メール・権限・停止）。actorId は操作した本人（本部の操作は null）。
 * 自分自身の権限の変更・停止はできない。最後の1人の会社管理者（company_admin・利用中）は、権限の変更も停止もできない。
 */
export async function updateAdminAccount(db: D1Database, companyId: number, targetId: any, b: any, actorId: number | null): Promise<Result> {
  const t = await loadAdminAccount(db, companyId, targetId)
  if (!t) return fail(404, 'アカウントが見つかりません')
  const sets: string[] = []; const binds: any[] = []
  if (b.name !== undefined) {
    const name = String(b.name ?? '').trim()
    if (!name || name.length > 60) return fail(400, '氏名を60文字以内で入力してください')
    sets.push('name = ?'); binds.push(name)
  }
  if (b.email !== undefined) {
    const email = cleanEmail(b.email)
    if (email === undefined) return fail(400, 'メールアドレスの形式が正しくありません')
    sets.push('email = ?'); binds.push(email)
  }
  const role = b.role !== undefined && b.role !== t.role ? b.role : null
  const status = b.status !== undefined && b.status !== t.status ? b.status : null
  if (role && !ADMIN_ACCOUNT_ROLES.includes(role)) return fail(400, '権限の値が正しくありません')
  if (status && !USER_STATUSES.includes(status)) return fail(400, '状態の値が正しくありません')
  if ((role || status) && actorId != null && t.user_id === actorId) return fail(400, '自分自身の権限の変更・停止はできません')
  if (role) { sets.push('role = ?'); binds.push(role) }
  if (status) { sets.push('status = ?'); binds.push(status) }
  if (!sets.length) return { status: 200, body: { ok: true, changed: false } }

  // 会社管理者が1人もいなくなる変更は、更新の条件で止める（同時に2人を外す操作でも残るように1文で判定する）
  const removesAdmin = t.role === 'company_admin' && t.status === 'active' && ((role && role !== 'company_admin') || status === 'suspended')
  const guard = removesAdmin
    ? ` AND (SELECT COUNT(*) FROM users WHERE company_id = ? AND role = 'company_admin' AND status = 'active' AND user_id != ?) > 0`
    : ''
  const r = await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ? AND company_id = ?${guard}`)
    .bind(...binds, t.user_id, companyId, ...(removesAdmin ? [companyId, t.user_id] : [])).run()
  if (!r.meta.changes) return fail(409, '会社管理者が1人もいなくなるため、変更できません。先に別の会社管理者を追加してください')
  // 停止・権限の変更は、ログイン中の画面にもすぐ反映させるためセッションを消す
  if (status === 'suspended' || role) await revokeSessionsStmt(db, t.user_id).run()
  return { status: 200, body: { ok: true, changed: true } }
}

/** 管理者アカウントのパスワード再発行（mode: temp=仮パスワード / email=再設定メール） */
export async function resetAdminAccountPassword(env: Bindings, companyId: number, targetId: any, mode: string): Promise<Result> {
  const t = await loadAdminAccount(env.DB, companyId, targetId)
  if (!t) return fail(404, 'アカウントが見つかりません')
  if (t.status !== 'active') return fail(409, '停止中のアカウントです。先に利用を再開してください')
  if (mode === 'email') {
    if (!t.email) return fail(400, 'メールアドレスが登録されていません。仮パスワードを発行するか、先にメールアドレスを登録してください')
    const sent = await sendPasswordResetLink(env, t)
    if (!sent.ok) return fail(409, 'メールを送信できませんでした。仮パスワードを発行してください')
    return { status: 200, body: { ok: true, mode: 'email', skipped: !!sent.skipped } }
  }
  const pw = await issueTempPassword(env.DB, t.user_id)
  return { status: 200, body: { ok: true, mode: 'temp', temp_password: pw, user_code: t.user_code } }
}

/** 会社の管理者アカウントの一覧 */
async function listAdminAccounts(db: D1Database, companyId: number) {
  return (await db.prepare(`SELECT user_id, user_code, name, email, role, status, last_login_at, must_change_password, created_at
    FROM users WHERE company_id = ? AND role IN ('company_admin','sales_manager','field_manager','office_staff')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, user_id`).bind(companyId).all()).results
}

// =========================================================
// 自分のアカウント（/api/auth/*。ログインしている全ロール）
// =========================================================
export const authAccountApi = new Hono<Env>()

authAccountApi.get('/account', async (c) => {
  const u = c.get('user')
  return c.json({
    user_id: u.user_id, user_code: u.user_code, name: u.name, email: u.email || null, role: u.role,
    company_name: u.company_name, must_change_password: !!u.must_change_password,
  })
})

/** 現在のパスワードの確認で使う失敗回数の記録（ログインと同じ記録。本部ユーザーは会社コードなしでログインするため空欄で数える） */
function passwordCheckKeys(c: any, u: any) {
  const companyCode = u.role === 'system_admin' ? '' : String(u.company_code || '')
  return loginAttemptKeys(companyCode, String(u.user_code || ''), c.req.header('CF-Connecting-IP'))
}

// 氏名・メールアドレスの変更（管理者・本部のみ。スタッフの登録情報は所属会社が管理する）
// メールアドレスの変更は乗っ取りの踏み台になるため、現在のパスワードを確かめる
authAccountApi.put('/account', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (u.role === 'staff') return c.json({ error: '登録情報の変更は所属会社の担当者にご連絡ください' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const sets: string[] = []; const binds: any[] = []
  if (b.name !== undefined) {
    const name = String(b.name ?? '').trim()
    if (!name || name.length > 60) return c.json({ error: '氏名を60文字以内で入力してください' }, 400)
    sets.push('name = ?'); binds.push(name)
  }
  let emailChanged = false; let newEmail: string | null = null
  if (b.email !== undefined) {
    const email = cleanEmail(b.email)
    if (email === undefined) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
    if ((email || '') !== String(u.email || '').trim()) {
      // 総当たりを防ぐため、パスワードの変更と同じくログインの失敗回数の制限を使う
      const keys = await passwordCheckKeys(c, u)
      if (await isLoginLocked(db, keys)) return c.json({ error: `失敗が続いたため、一時的に変更を止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください` }, 429)
      const cur = await db.prepare('SELECT password_hash FROM users WHERE user_id = ?').bind(u.user_id).first() as any
      if (!(await verifyPassword(String(b.current_password ?? ''), cur?.password_hash))) {
        await recordLoginFailure(db, keys)
        return c.json({ error: 'メールアドレスを変更するには、現在のパスワードを正しく入力してください' }, 400)
      }
      emailChanged = true; newEmail = email
      sets.push('email = ?'); binds.push(email)
    }
  }
  if (!sets.length) return c.json({ ok: true, changed: false })
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`).bind(...binds, u.user_id).run()
  let notice = false
  if (emailChanged) {
    // 新しいアドレスに登録の確認を、以前のアドレスには変更の知らせを送る（入力の誤り・なりすましに気づけるように）
    const name = b.name !== undefined ? String(b.name).trim() : u.name
    const mails: { to: string; toOld: boolean }[] = []
    if (newEmail) mails.push({ to: newEmail, toOld: false })
    if (u.email && String(u.email).trim()) mails.push({ to: String(u.email).trim(), toOld: true })
    for (const m of mails) {
      const tpl = accountEmailChangedEmail({ name, companyName: u.company_name, userCode: u.user_code, newEmail: newEmail || '（削除）', toOld: m.toOld })
      c.executionCtx.waitUntil(sendEmail(c.env, { to: m.to, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'account_email', company_id: u.company_id }))
    }
    notice = !!newEmail
  }
  return c.json({ ok: true, changed: true, email_notice_sent: notice })
})

// パスワードの変更（スタッフ・管理者・本部の全員）。ほかの端末のセッションは消し、この端末はログインしたままにする
authAccountApi.post('/change-password', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const current = typeof b.current_password === 'string' ? b.current_password : ''
  const next = typeof b.new_password === 'string' ? b.new_password : ''
  if (!current) return c.json({ error: '現在のパスワードを入力してください' }, 400)
  const pwErr = validatePassword(next)
  if (pwErr) return c.json({ error: '新しい' + pwErr }, 400)
  if (current === next) return c.json({ error: '現在と同じパスワードは使えません' }, 400)
  // 現在のパスワードの総当たりを防ぐため、ログインと同じ失敗回数の制限を使う
  const keys = await passwordCheckKeys(c, u)
  if (await isLoginLocked(db, keys)) return c.json({ error: `失敗が続いたため、一時的に変更を止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください` }, 429)
  const loginId = await loginUserId(db, u)
  const cur = await db.prepare('SELECT password_hash FROM users WHERE user_id = ?').bind(loginId).first() as any
  if (!(await verifyPassword(current, cur?.password_hash))) {
    await recordLoginFailure(db, keys)
    return c.json({ error: '現在のパスワードが正しくありません' }, 400)
  }
  const token = getCookie(c, SESSION_COOKIE)
  const keep = token ? await hashToken(token) : ''
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE user_id = ?').bind(await hashPassword(next), loginId),
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(nowJST(), loginId),
    // ほかの端末のセッション（企業を切り替えた稼働先の行のものも含む）を消す
    db.prepare(`DELETE FROM sessions WHERE token != ? AND (user_id = ? OR user_id IN (
        SELECT user_id FROM users WHERE person_id IS NOT NULL AND person_id = (SELECT person_id FROM users WHERE user_id = ?)))`).bind(keep, loginId, loginId),
  ])
  return c.json({ ok: true })
})

/**
 * パスワードを持つ行（ログインに使う行）。スタッフが企業を切り替えると、セッションは稼働先の行（照合できないパスワード）を指すため、
 * 同じ人の所属元の行（他社連携ではない、ログインできる行）を探す
 */
async function loginUserId(db: D1Database, u: any): Promise<number> {
  if (u.role !== 'staff' || !u.person_id) return u.user_id
  const own = await db.prepare(`SELECT us.user_id FROM users us JOIN staff_profiles sp ON sp.user_id = us.user_id
    WHERE us.person_id = ? AND us.role = 'staff' AND us.status = 'active' AND COALESCE(sp.affiliation_type, 'own_employee') != 'linked_external'
    ORDER BY (us.user_id != ?), us.user_id LIMIT 1`).bind(u.person_id, u.user_id).first() as any
  return own?.user_id ?? u.user_id
}

// =========================================================
// 管理者アカウント（/api/admin/users。会社管理者のみ）
// =========================================================
export const adminUsersApi = new Hono<Env>()
const companyAdminOnly = async (c: any, next: () => Promise<void>) => {
  if (c.get('user')?.role !== 'company_admin') return c.json({ error: '管理者アカウントの管理は会社管理者だけが行えます' }, 403)
  return next()
}
adminUsersApi.use('/users', companyAdminOnly)
adminUsersApi.use('/users/*', companyAdminOnly)

adminUsersApi.get('/users', async (c) => {
  const u = c.get('user')
  return c.json({ users: await listAdminAccounts(c.env.DB, u.company_id), me: u.user_id })
})
adminUsersApi.post('/users', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const r = await createAdminAccount(c.env.DB, c.get('user').company_id, b)
  return c.json(r.body, r.status)
})
adminUsersApi.put('/users/:id', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  // 自分のメールアドレスは、現在のパスワードを確かめる PUT /auth/account から変更する
  if (String(u.user_id) === c.req.param('id') && b.email !== undefined && String(b.email ?? '').trim() !== String(u.email ?? '').trim()) {
    return c.json({ error: '自分のメールアドレスは「アカウント設定」の自分のアカウントから変更してください' }, 400)
  }
  const r = await updateAdminAccount(c.env.DB, u.company_id, c.req.param('id'), b, u.user_id)
  return c.json(r.body, r.status)
})
// 自分のパスワードは「自分のアカウント」から変更する（現在のパスワードの確認があるため）
adminUsersApi.post('/users/:id/reset-password', async (c) => {
  const u = c.get('user')
  if (String(u.user_id) === c.req.param('id')) return c.json({ error: '自分のパスワードは「アカウント設定」から変更してください' }, 400)
  const b = await c.req.json().catch(() => ({} as any))
  const r = await resetAdminAccountPassword(c.env, u.company_id, c.req.param('id'), b.mode === 'email' ? 'email' : 'temp')
  return c.json(r.body, r.status)
})

// =========================================================
// 本部（/api/hq/companies/:id/users。system_admin のみ。権限の確認は api.ts の /hq/* ミドルウェア）
// =========================================================
export const hqUsersApi = new Hono<Env>()

async function loadCustomerCompany(db: D1Database, companyId: any) {
  if (!/^\d+$/.test(String(companyId ?? ''))) return null
  return db.prepare(`SELECT company_id, company_name FROM companies WHERE company_id = ? AND COALESCE(active_status, 'active') != ?`)
    .bind(Number(companyId), HQ_COMPANY_STATUS).first() as Promise<any>
}
hqUsersApi.get('/companies/:id/users', async (c) => {
  const co = await loadCustomerCompany(c.env.DB, c.req.param('id'))
  if (!co) return c.json({ error: 'not found' }, 404)
  return c.json({ users: await listAdminAccounts(c.env.DB, co.company_id) })
})
hqUsersApi.post('/companies/:id/users', async (c) => {
  const co = await loadCustomerCompany(c.env.DB, c.req.param('id'))
  if (!co) return c.json({ error: 'not found' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const r = await createAdminAccount(c.env.DB, co.company_id, { ...b, role: b.role || 'company_admin' })
  return c.json(r.body, r.status)
})
hqUsersApi.put('/companies/:id/users/:uid', async (c) => {
  const co = await loadCustomerCompany(c.env.DB, c.req.param('id'))
  if (!co) return c.json({ error: 'not found' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const r = await updateAdminAccount(c.env.DB, co.company_id, c.req.param('uid'), b, null)
  return c.json(r.body, r.status)
})
hqUsersApi.post('/companies/:id/users/:uid/reset-password', async (c) => {
  const co = await loadCustomerCompany(c.env.DB, c.req.param('id'))
  if (!co) return c.json({ error: 'not found' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const r = await resetAdminAccountPassword(c.env, co.company_id, c.req.param('uid'), b.mode === 'email' ? 'email' : 'temp')
  return c.json(r.body, r.status)
})
