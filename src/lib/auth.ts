// 認証の共通部品（パスワードのハッシュ・パスワードの条件・セッション・企業停止の判定・ログイン試行の制限）
// - パスワード: PBKDF2（SHA-256・ソルト付き）。保存形式は pbkdf2$回数$ソルト$ハッシュ（Base64）。
//   旧形式（ソルトなし SHA-256 の16進64文字）も照合でき、ログイン成功時に新形式へ作り直す（needsRehash）。
// - セッション・再設定トークン: DB には SHA-256 のハッシュだけを保存し、Cookie の生の値をハッシュにして照合する。
// - 期限の比較はすべて ISO 8601（toISOString）の文字列同士で行う（CURRENT_TIMESTAMP とは書式が違うため比べない）。
import type { Context } from 'hono'

export const SESSION_COOKIE = 'session'
export const SESSION_HOURS = 12 // 1シフト分を目安とした有効期限
// Workers の Free プラン（CPU 10ms/リクエスト）に収まる回数。Paid プランに移ったら 100000 まで上げてよい
// （上げると、回数の少ないハッシュはログイン成功時に作り直される。needsRehash）
const PBKDF2_ITERATIONS = 10000
const PBKDF2_MAX_ITERATIONS = 100000 // Workers の PBKDF2 の上限。照合はこの回数まで受け付ける
const PBKDF2_BITS = 256
// ログインできないロール（スタッフマスタだけの行・仮登録の行）
const NO_LOGIN_ROLES = ['roster_only']
// ログイン試行の制限: 15分間に 会社コード＋ID 単位で10回、IP 単位で50回失敗したら一時的に止める
export const LOGIN_WINDOW_MINUTES = 15
const LOGIN_MAX_FAILURES_ACCOUNT = 10
const LOGIN_MAX_FAILURES_IP = 50

const enc = new TextEncoder()
function toB64(u8: Uint8Array): string { return btoa(String.fromCharCode(...u8)) }
function fromB64(s: string): Uint8Array { return Uint8Array.from(atob(s), ch => ch.charCodeAt(0)) }
function toHex(u8: Uint8Array): string { return [...u8].map(b => b.toString(16).padStart(2, '0')).join('') }
// 長さが同じなら全文字を比べる（一致位置で処理時間が変わらないように）
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))))
}
/** セッション・再設定トークンの保存用ハッシュ */
export const hashToken = sha256Hex

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, PBKDF2_BITS)
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt)
  const dk = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(dk)}`
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const s = String(stored || '')
  if (s.startsWith('pbkdf2$')) {
    const [, iter, saltB64, hashB64] = s.split('$')
    const n = Number(iter)
    if (!Number.isInteger(n) || n < 1 || n > PBKDF2_MAX_ITERATIONS || !saltB64 || !hashB64) return false
    try {
      const dk = await pbkdf2(password, fromB64(saltB64), n)
      return safeEqual(toB64(dk), hashB64)
    } catch { return false }
  }
  // 旧形式（ソルトなし SHA-256）
  if (/^[0-9a-f]{64}$/.test(s)) return safeEqual(await sha256Hex(password), s)
  return false
}

/** 旧形式・回数の少ないハッシュなら true（ログイン成功時に作り直す） */
export function needsRehash(stored: string | null | undefined): boolean {
  const s = String(stored || '')
  if (!s.startsWith('pbkdf2$')) return true
  return Number(s.split('$')[1]) < PBKDF2_ITERATIONS
}

// 会社コードやユーザーが無いときも同じだけ計算して、応答時間からアカウントの有無を推測されないようにする
let dummyHash: Promise<string> | null = null
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('!dummy!')
  await verifyPassword(password, await dummyHash)
}

/** パスワードの最低条件（全経路で共通）。問題があればエラー文言を返す */
export const PASSWORD_MIN_LENGTH = 8
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'パスワードを入力してください'
  if (password.length < PASSWORD_MIN_LENGTH) return `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`
  if (password.length > 128) return 'パスワードは128文字以内で入力してください'
  if (!password.trim()) return 'パスワードに空白だけは使えません'
  return null
}

/** メールアドレスの照合用の正規化（前後の空白を除き、小文字にそろえる） */
export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase()
}

/** 企業が利用中か（本部で「停止」にした企業は false。トライアルは利用可） */
export function isCompanyActive(activeStatus: unknown): boolean {
  return activeStatus !== 'inactive'
}
/** ログインできるロールか */
export function canLogin(role: unknown): boolean {
  return !NO_LOGIN_ROLES.includes(String(role))
}

/** そのユーザーの全セッションを削除する（退職・再設定・統合など） */
export function revokeSessionsStmt(db: D1Database, userId: number) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId)
}
export async function revokeSessions(db: D1Database, userId: number): Promise<void> {
  await revokeSessionsStmt(db, userId).run()
}
/** 企業を停止したときに、その企業のユーザーのセッションを削除する（本部ユーザーは残す） */
export async function revokeCompanySessions(db: D1Database, companyId: number): Promise<number> {
  const r = await db.prepare(`DELETE FROM sessions WHERE user_id IN (
      SELECT user_id FROM users WHERE company_id = ? AND role != 'system_admin')`).bind(companyId).run()
  return r.meta.changes || 0
}

export type SessionCheck =
  | { ok: true; user: any }
  | { ok: false; reason: 'none' | 'user_inactive' | 'company_inactive' }
/**
 * Cookie のセッショントークンから利用者を引く（API の認証ミドルウェアと画面の currentUser で共用）。
 * 期限切れ・退職（status!='active'）・ログインできないロール・停止中の企業（本部ユーザーは除く）は通さない。
 */
export async function loadSessionUser(db: D1Database, token: string | undefined | null): Promise<SessionCheck> {
  if (!token) return { ok: false, reason: 'none' }
  const row = await db.prepare(`
    SELECT u.*, s.expires_at, c.company_name, c.company_code, c.settings_json, c.active_status AS company_active_status,
           sp.staff_id
    FROM sessions s JOIN users u ON s.user_id = u.user_id
    JOIN companies c ON u.company_id = c.company_id
    LEFT JOIN staff_profiles sp ON sp.user_id = u.user_id
    WHERE s.token = ? AND s.expires_at > ?`).bind(await hashToken(token), new Date().toISOString()).first() as any
  if (!row) return { ok: false, reason: 'none' }
  if (row.status !== 'active' || !canLogin(row.role)) return { ok: false, reason: 'user_inactive' }
  if (row.role !== 'system_admin' && !isCompanyActive(row.company_active_status)) return { ok: false, reason: 'company_inactive' }
  return { ok: true, user: row }
}

/** ログイン後の遷移先 */
export function homePathFor(role: unknown): string {
  return role === 'staff' ? '/staff' : role === 'system_admin' ? '/hq' : '/admin'
}

/** セッション Cookie の属性（https では Secure を付ける。ローカルの http 開発でも動くように判定する） */
export function sessionCookieOptions(c: Context) {
  const secure = new URL(c.req.url).protocol === 'https:'
  return { path: '/', httpOnly: true, secure, sameSite: 'Lax' as const, maxAge: SESSION_HOURS * 3600 }
}

// ---------- ログイン試行の制限（login_attempts。生の ID・IP は保存せずハッシュにする） ----------
export async function loginAttemptKeys(companyCode: string, userCode: string, ip: string | null | undefined) {
  return {
    account: await sha256Hex(`account|${companyCode.toLowerCase()}|${userCode.toLowerCase()}`),
    ip: ip ? await sha256Hex(`ip|${ip}`) : null,
  }
}
function windowStart(): string { return new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString() }
/** 失敗が上限に達していれば true。テーブルが無いなど DB の失敗ではログインを止めない */
export async function isLoginLocked(db: D1Database, keys: { account: string; ip: string | null }): Promise<boolean> {
  try {
    const since = windowStart()
    const r = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM login_attempts WHERE scope = 'account' AND key_hash = ? AND attempted_at > ?) AS acc,
        (SELECT COUNT(*) FROM login_attempts WHERE scope = 'ip' AND key_hash = ? AND attempted_at > ?) AS ip`)
      .bind(keys.account, since, keys.ip || '', since).first() as any
    return (r?.acc || 0) >= LOGIN_MAX_FAILURES_ACCOUNT || (!!keys.ip && (r?.ip || 0) >= LOGIN_MAX_FAILURES_IP)
  } catch (e) {
    console.log(`login_attempts check failed: ${e}`)
    return false
  }
}
export async function recordLoginFailure(db: D1Database, keys: { account: string; ip: string | null }): Promise<void> {
  try {
    const now = new Date().toISOString()
    const stmts = [db.prepare(`INSERT INTO login_attempts (scope, key_hash, attempted_at) VALUES ('account', ?, ?)`).bind(keys.account, now)]
    if (keys.ip) stmts.push(db.prepare(`INSERT INTO login_attempts (scope, key_hash, attempted_at) VALUES ('ip', ?, ?)`).bind(keys.ip, now))
    await db.batch(stmts)
  } catch (e) { console.log(`login_attempts record failed: ${e}`) }
}
/** ログインに成功したら、その ID の失敗回数を消す（IP の分は残す） */
export async function clearLoginFailures(db: D1Database, keys: { account: string }): Promise<void> {
  try { await db.prepare(`DELETE FROM login_attempts WHERE scope = 'account' AND key_hash = ?`).bind(keys.account).run() }
  catch (e) { console.log(`login_attempts clear failed: ${e}`) }
}
/** 定期処理: 期限切れのセッションと、古いログイン試行の記録を消す */
export async function purgeExpiredAuthRows(db: D1Database): Promise<{ sessions: number; attempts: number }> {
  const s = await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run()
  let attempts = 0
  try {
    const a = await db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(new Date(Date.now() - 24 * 3600 * 1000).toISOString()).run()
    attempts = a.meta.changes || 0
  } catch (e) { console.log(`login_attempts purge failed: ${e}`) }
  return { sessions: s.meta.changes || 0, attempts }
}
