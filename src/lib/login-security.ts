// ログインの安全対策の共通部品（作業単位 w4-auth-features: #552 #453 #544）
// - ログインの履歴（login_events）の記録（失敗は1分ごとにまとめる。#10001）
// - ログインしていない人の書き込みの全体の上限（auth_write_counters。#10001）
// - 二段階認証（認証アプリの TOTP。RFC 6238: HMAC-SHA1・30秒・6桁）と予備コード
// - 会社ごとの設定（二段階認証を必須にするか・接続元 IP の制限）。companies.settings_json に持つ
// - 同じ人（person_id が同じ他社の行）のセッションをまとめて扱う条件
import type { Context } from 'hono'
import { sha256Hex } from './auth'
import { ADMIN_ROLES } from './permissions'
import { requestGeo } from './share-detect'
import { claimAlert, notifyHq, type AlertEnv } from '../services/alerts'

/** 二段階認証を使える（接続元の制限の対象になる）ロール。スタッフは対象外 */
export const MFA_ROLES: readonly string[] = ['system_admin', ...ADMIN_ROLES]
export function canUseMfa(role: unknown): boolean { return MFA_ROLES.includes(String(role)) }

const nowIso = () => new Date().toISOString()

// ---------- ログインの履歴 ----------
export type LoginEvent = {
  company_id?: number | null; user_id?: number | null; company_code?: string | null; user_code?: string | null
  event_type?: 'login' | 'password_reset' | 'logout_all' | 'forced_logout' | 'switch_company'
  result: 'success' | 'bad_password' | 'locked' | 'inactive' | 'company_inactive' | 'ip_denied' | 'mfa_failed'
  method?: 'password' | 'totp' | 'recovery' | null; actor_user_id?: number | null
  /** ログインの成功の時点で別の種類の端末のセッションが使われていたとき（使い回しの疑いの手がかり。src/lib/share-detect.ts の loginConcurrency） */
  concurrent?: { device: string; minutes: number } | null
}
/** 接続元 IP と端末（User-Agent の先頭300文字） */
export function requestMeta(c: Context): { ip: string | null; ua: string | null } {
  return { ip: c.req.header('CF-Connecting-IP') || null, ua: (c.req.header('User-Agent') || '').slice(0, 300) || null }
}
/** まとめる行の鍵（失敗だけ。成功・パスワードの再設定などは1件1行のまま）。#10001 */
export function loginEventBucket(ip: string | null, ev: LoginEvent, now = Date.now()): string | null {
  if (ev.result === 'success' || (ev.event_type || 'login') !== 'login') return null
  return [ip || '', 'login', ev.result, ev.company_id ?? '', ev.user_id ?? '', new Date(now).toISOString().slice(0, 16)].join('|')
}
/**
 * 履歴を残す。記録に失敗してもログインなどの処理は止めない。
 * 接続元のおおよその場所（Cloudflare の request.cf の国・都道府県・市）も残す（使い回しの疑いの手がかり。#9989。migrations/0116）。
 * 失敗（成功以外のログイン）は、同じ接続元 × 同じ結果 × 同じ会社・利用者 × 同じ1分（UTC）を1行にまとめ、repeat_count を増やす（#10001。migrations/0118）。
 * まとめた行の日時・端末・入力された会社コードと ID は、その分の最初の1回のもの
 */
export async function recordLoginEvent(db: D1Database, c: Context, ev: LoginEvent): Promise<void> {
  const m = requestMeta(c)
  const g = requestGeo(c)
  try {
    // 成功したら、その人のまとめている途中の失敗の行（今の1分の分）を閉じる。成功の後の失敗は新しい行にし、
    // 「最後に成功してから」の失敗の回数（会社管理者への知らせ）を数え直せるようにする。当てはまる行が無ければ書き込みは起きない
    if (ev.result === 'success' && ev.user_id && (ev.event_type || 'login') === 'login') {
      await db.prepare('UPDATE login_events SET bucket_key = NULL WHERE user_id = ? AND bucket_key IS NOT NULL AND created_at >= ?')
        .bind(ev.user_id, new Date(Date.now() - 120000).toISOString()).run()
    }
    await db.prepare(`INSERT INTO login_events (company_id, user_id, company_code, user_code, event_type, result, method, ip, user_agent, actor_user_id, created_at,
        country, region_code, region, city, concurrent_device, concurrent_minutes, repeat_count, bucket_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(bucket_key) WHERE bucket_key IS NOT NULL DO UPDATE SET repeat_count = login_events.repeat_count + 1`).bind(ev.company_id ?? null, ev.user_id ?? null,
      ev.company_code ? String(ev.company_code).slice(0, 40) : null, ev.user_code ? String(ev.user_code).slice(0, 40) : null,
      ev.event_type || 'login', ev.result, ev.method ?? null, m.ip, m.ua, ev.actor_user_id ?? null, nowIso(),
      g.country, g.region_code, g.region, g.city, ev.concurrent ? ev.concurrent.device.slice(0, 60) : null, ev.concurrent ? ev.concurrent.minutes : null,
      loginEventBucket(m.ip, ev)).run()
  } catch (e) { console.log(`login_events record failed: ${e}`) }
}

// ---------- ログインしていない人の書き込みの全体の上限（#10001 セキュリティの点検 H2） ----------
// 無料プランの D1 の書き込みは1日10万行（UTC の 0 時 = 日本時間 9:00 に戻る）。接続元ごとの制限（login_attempts・WAF）は IP を変えればすり抜けるので、
// ログインの失敗の記録と、ログインなしで書き込みを起こせる所（再設定の依頼・応募）の回数を、全体で1分ごと・1日ごとに数えて止める。
//   minute   … 1分に受け付ける回数（ふだん）
//   day      … 1日（UTC）にこの回数に届いたら、その日の残りは1分に degraded 回までにする（攻撃が続いても、その日の書き込みを一定の量に収める）
// 止めるときは D1 に何も書かずに 429 を返す（ログインはパスワードを確かめる前に断る。数えずに確かめると総当たりができるため）。
// 書き込みの見積もり（索引の分を含む）: ログインの失敗1回 約8〜12行（login_attempts 2行と索引・login_events 1行か件数の更新・この表の更新）、
//   再設定の依頼1回 約4行、応募1回 約10〜20行。上限いっぱいで1日中続けられても、login と public を合わせて1日約7万行に収まる（docs/monitoring.md の 12 章）
// 1日の書き込みの量を決めるのは day と degraded で、minute は急な増え方の歯止め（ふつうの人の打ち間違い・募集の案内を流した直後の応募が重なっても止めない大きさ）
export type WriteBudgetScope = 'login' | 'public'
export type WriteBudget = { minute: number; day: number; degraded: number }
export const WRITE_BUDGETS: Record<WriteBudgetScope, WriteBudget> = {
  login: { minute: 60, day: 1500, degraded: 1 },
  public: { minute: 60, day: 1000, degraded: 1 },
}
export const WRITE_BUDGET_BUSY_MESSAGE = 'ただいま混み合っているため、受け付けを一時的に止めています。1〜2分ほど待ってから、もう一度お試しください'
type BudgetEnv = { TEST_HOOKS?: string; LOGIN_WRITE_BUDGET?: string; PUBLIC_WRITE_BUDGET?: string } | null | undefined
/** 上限の値。テスト（TEST_HOOKS='true'）だけ、vars の LOGIN_WRITE_BUDGET・PUBLIC_WRITE_BUDGET（「分/日/日の後の分」。例 5/8/1）で変えられる */
export function writeBudgetOf(env: BudgetEnv, scope: WriteBudgetScope): WriteBudget {
  const raw = env?.TEST_HOOKS === 'true' ? (scope === 'login' ? env.LOGIN_WRITE_BUDGET : env.PUBLIC_WRITE_BUDGET) : undefined
  const m = /^(\d{1,6})\/(\d{1,7})\/(\d{1,6})$/.exec(String(raw || ''))
  return m ? { minute: Number(m[1]), day: Number(m[2]), degraded: Number(m[3]) } : WRITE_BUDGETS[scope]
}
const utcMinute = (now: number) => new Date(now).toISOString().slice(0, 16)
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
export type BudgetState = { minute_count: number; day_count: number; limit: number; full: boolean }
/** 今の回数と、上限に達しているか（読むだけ。表が無いなど DB の失敗では止めない） */
export async function writeBudgetState(db: D1Database, env: BudgetEnv, scope: WriteBudgetScope, now = Date.now()): Promise<BudgetState> {
  const b = writeBudgetOf(env, scope)
  let minuteCount = 0, dayCount = 0
  try {
    const r = await db.prepare('SELECT minute, minute_count, day, day_count FROM auth_write_counters WHERE scope = ?').bind(scope).first() as any
    if (r && r.minute === utcMinute(now)) minuteCount = Number(r.minute_count) || 0
    if (r && r.day === utcDay(now)) dayCount = Number(r.day_count) || 0
  } catch (e) { console.log(`auth_write_counters check failed: ${e}`) }
  const limit = dayCount >= b.day ? b.degraded : b.minute
  return { minute_count: minuteCount, day_count: dayCount, limit, full: minuteCount >= limit }
}
export type BudgetSpent = { minute_count: number; day_count: number; reached: 'minute' | 'day' | null }
/**
 * 1回分を数える（書き込みが起きる操作のあとに呼ぶ）。数えたあとの回数と、この1回で上限に届いたか（届いたときだけ本部に知らせる）。
 * 失敗しても処理は止めない（null）
 */
export async function spendWriteBudget(db: D1Database, env: BudgetEnv, scope: WriteBudgetScope, now = Date.now()): Promise<BudgetSpent | null> {
  const b = writeBudgetOf(env, scope)
  try {
    // SET の右辺は更新前の行の値で計算される（minute・day の比較は前の値と）
    const r = await db.prepare(`INSERT INTO auth_write_counters (scope, minute, minute_count, day, day_count, updated_at) VALUES (?, ?, 1, ?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        minute_count = CASE WHEN auth_write_counters.minute = excluded.minute THEN auth_write_counters.minute_count + 1 ELSE 1 END,
        day_count = CASE WHEN auth_write_counters.day = excluded.day THEN auth_write_counters.day_count + 1 ELSE 1 END,
        minute = excluded.minute, day = excluded.day, updated_at = excluded.updated_at
      RETURNING minute_count, day_count`).bind(scope, utcMinute(now), utcDay(now), nowIso()).first() as any
    const mc = Number(r?.minute_count) || 0, dc = Number(r?.day_count) || 0
    const limit = dc > b.day ? b.degraded : b.minute
    return { minute_count: mc, day_count: dc, reached: dc === b.day ? 'day' : mc === limit ? 'minute' : null }
  } catch (e) {
    console.log(`auth_write_counters spend failed: ${e}`)
    return null
  }
}
export const WRITE_BUDGET_LABEL: Record<WriteBudgetScope, string> = { login: 'ログインの失敗', public: 'ログインなしの送信（パスワードの再設定の依頼・募集ページの応募）' }
/**
 * 上限に届いたことを、本部の管理者（アプリ内の通知。kind は error_alert）と送り先に知らせる。1分の上限は60分に1回、1日の上限はその日に1回まで。
 * 1時間ごとの使った量の確認（cron）より早く、ログインの失敗の急増に気づけるようにする。アプリ内の通知を作ったら true（呼び出し側でプッシュを送る）
 */
export async function notifyWriteBudgetReached(env: AlertEnv, scope: WriteBudgetScope, spent: BudgetSpent, now = Date.now()): Promise<boolean> {
  if (!spent.reached) return false
  try {
    const b = writeBudgetOf(env as BudgetEnv, scope)
    const day = utcDay(now)
    const isDay = spent.reached === 'day'
    const claim = await claimAlert(env.DB, isDay ? `write_budget:${scope}:day:${day}` : `write_budget:${scope}:minute`, isDay ? 1440 : 60)
    if (!claim.claimed) return false
    const label = WRITE_BUDGET_LABEL[scope]
    const title = isDay ? `${label}が今日の目安（${b.day}回）に届きました` : `${label}が急に増えています（1分に${spent.minute_count}回）`
    const lines = [isDay
      ? `今日（UTC の ${day}。日本時間 9:00 から）の${label}が${spent.day_count}回になりました。D1 の書き込みの枠を守るため、次の日本時間 9:00 までは1分に${b.degraded}回までしか受け付けません。`
      : `${label}が1分の上限（${spent.minute_count}回）に届いたため、その分の残りは記録せずに断っています（1〜2分後に受け付けを再開します）。`,
      '総当たり・大量の送信の疑いがあります。Cloudflare のダッシュボードの Security → Events（WAF の記録）と、本部画面「セキュリティ」のログインの履歴を確かめてください。']
    const r = await notifyHq(env, { event: 'write_budget', severity: 'critical', title, lines, count: isDay ? spent.day_count : spent.minute_count }, lines.join(''))
    return r.notified > 0
  } catch (e) {
    console.log(`write budget alert failed: ${String((e as any)?.name || 'Error')}`)
    return false
  }
}

/** 上限に達していれば 429 の応答（D1 には書かない。code: write_budget）、まだなら null */
export async function writeBudgetBusy(c: Context, scope: WriteBudgetScope): Promise<Response | null> {
  const env = c.env as any
  const st = await writeBudgetState(env.DB, env, scope)
  return st.full ? c.json({ error: WRITE_BUDGET_BUSY_MESSAGE, code: 'write_budget' }, 429) : null
}
/** 1回分を数え、上限に届いたら本部に知らせる（知らせるのは応答の後。afterNotify はアプリ内の通知を作ったときに呼ぶ＝プッシュの送信） */
export async function spendWriteBudgetFor(c: Context, scope: WriteBudgetScope, afterNotify?: (env: any) => Promise<unknown>): Promise<void> {
  const env = c.env as any
  const spent = await spendWriteBudget(env.DB, env, scope)
  if (!spent?.reached) return
  const p = notifyWriteBudgetReached(env, scope, spent).then(n => (n && afterNotify ? afterNotify(env) : null))
    .catch(e => console.log(`write budget alert failed: ${String((e as any)?.name || 'Error')}`))
  try { c.executionCtx.waitUntil(p) } catch { await p }
}

/** User-Agent から「iPhone / Safari」のような短い表示を作る（一覧用。判別できなければ「不明な端末」） */
export function deviceLabel(ua: unknown): string {
  const s = String(ua || '')
  if (!s) return '不明な端末'
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : ''
  const br = /Edg\//.test(s) ? 'Edge' : /Line\//.test(s) ? 'LINE' : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : ''
  return [os, br].filter(Boolean).join(' / ') || s.slice(0, 40)
}

// ---------- 同じ人のセッション ----------
/**
 * sessions の WHERE 句: その利用者の行と、同じ人（person_id）のほかの行（企業を切り替えたスタッフのセッションは稼働先の行を指すため）。
 * bind には同じ user_id を2回渡す
 */
export const PERSON_SESSION_WHERE = `(user_id = ? OR user_id IN (
    SELECT user_id FROM users WHERE person_id IS NOT NULL AND person_id = (SELECT person_id FROM users WHERE user_id = ?)))`
/** companyId を渡すと、その会社に切り替えている（その会社の行を指す）セッションだけに絞る（他社連携の行から開いたとき。D-53 #9940） */
function personSessionWhere(userId: number, companyId?: number): { sql: string; binds: any[] } {
  return companyId == null ? { sql: PERSON_SESSION_WHERE, binds: [userId, userId] }
    : { sql: `${PERSON_SESSION_WHERE} AND company_id = ?`, binds: [userId, userId, companyId] }
}
/** 有効なセッション（同じ人のほかの会社の行の分も含む。companyId を渡すとその会社の分だけ） */
export async function personSessions(db: D1Database, userId: number, companyId?: number): Promise<any[]> {
  const w = personSessionWhere(userId, companyId)
  return (await db.prepare(`SELECT token, user_id, company_id, created_at, expires_at, ip, user_agent FROM sessions WHERE ${w.sql} AND expires_at > ? ORDER BY created_at DESC`)
    .bind(...w.binds, nowIso()).all()).results as any[]
}
/**
 * 同じ人の全セッション（企業を切り替えて他社の行を指している分も）を消す文。パスワードの再設定・統合・強制ログアウトで使う（#9941）。
 * companyId を渡すと、その会社に切り替えている分だけを消す
 */
export function revokePersonSessionsStmt(db: D1Database, userId: number, companyId?: number) {
  const w = personSessionWhere(userId, companyId)
  return db.prepare(`DELETE FROM sessions WHERE ${w.sql}`).bind(...w.binds)
}
export async function revokePersonSessions(db: D1Database, userId: number, companyId?: number): Promise<number> {
  const r = await revokePersonSessionsStmt(db, userId, companyId).run()
  return r.meta.changes || 0
}

// ---------- 会社ごとの設定（companies.settings_json） ----------
export const IP_ALLOWLIST_MAX = 50
export type SecuritySettings = { mfa_required: boolean; ip_allowlist: string[] }
export function securitySettings(settingsJson: unknown): SecuritySettings {
  let s: any = {}
  try { s = JSON.parse(String(settingsJson || '{}')) || {} } catch { s = {} }
  const list = Array.isArray(s.security_ip_allowlist) ? s.security_ip_allowlist.filter((x: any) => typeof x === 'string' && parseCidr(x)) : []
  return { mfa_required: s.security_mfa_required === true, ip_allowlist: list }
}
/** 設定を書き換える文（ほかの設定を上書きしないよう、この2項目だけを json_set で書く） */
export function saveSecuritySettingsStmt(db: D1Database, companyId: number, v: Partial<SecuritySettings>) {
  const sets: string[] = []; const binds: any[] = []
  if (v.mfa_required !== undefined) { sets.push(`'$.security_mfa_required', json(?)`); binds.push(v.mfa_required ? 'true' : 'false') }
  if (v.ip_allowlist !== undefined) { sets.push(`'$.security_ip_allowlist', json(?)`); binds.push(JSON.stringify(v.ip_allowlist)) }
  return db.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, ${sets.join(', ')}) WHERE company_id = ?`)
    .bind(...binds, companyId)
}
/** 二段階認証が必須で、まだ登録していない（登録の画面しか使えない状態） */
export function mfaSetupPending(user: { role: unknown; totp_enabled_at?: unknown }, settingsJson: unknown): boolean {
  return canUseMfa(user.role) && !user.totp_enabled_at && securitySettings(settingsJson).mfa_required
}
/** 接続元の制限で止めるなら true（スタッフは対象外。制限の一覧が空なら止めない。接続元が分からなければ止める） */
export function ipDenied(role: unknown, settingsJson: unknown, ip: string | null | undefined): boolean {
  if (!canUseMfa(role)) return false
  const list = securitySettings(settingsJson).ip_allowlist
  return list.length > 0 && !ipInList(ip, list)
}

// ---------- 接続元 IP（IPv4・IPv6 と CIDR） ----------
type Addr = { v: 4 | 6; n: bigint }
function parseV4(s: string): bigint | null {
  const p = s.split('.')
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null
  return p.reduce((a, x) => (a << 8n) + BigInt(Number(x)), 0n)
}
function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || (s.match(/::/g) || []).length > 1) return null
  let tail: bigint[] = []
  // 末尾の IPv4 表記（::ffff:192.0.2.1 など）
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (m) { const v4 = parseV4(m[2]); if (v4 === null) return null; s = m[1] + '0:0'; tail = [v4 >> 16n, v4 & 0xffffn] }
  const [head, rest] = s.includes('::') ? s.split('::') : [s, null]
  const hs = head ? head.split(':') : []
  const rs = rest ? rest.split(':') : []
  if ([...hs, ...rs].some(x => !/^[0-9a-fA-F]{1,4}$/.test(x))) return null
  const fill = 8 - hs.length - rs.length
  if (rest === null ? fill !== 0 : fill < 1) return null
  const groups = [...hs, ...Array(rest === null ? 0 : fill).fill('0'), ...rs].map(x => BigInt(parseInt(x, 16)))
  if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1] }
  return groups.reduce((a, g) => (a << 16n) + g, 0n)
}
function parseAddr(s: string): Addr | null {
  const t = String(s || '').trim()
  if (t.includes(':')) {
    const n = parseV6(t)
    if (n === null) return null
    // IPv4 射影アドレス（::ffff:a.b.c.d）は IPv4 として比べる
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn }
    return { v: 6, n }
  }
  const n = parseV4(t)
  return n === null ? null : { v: 4, n }
}
/** 「203.0.113.5」「203.0.113.0/24」「2001:db8::/32」の形を読む。読めなければ null */
export function parseCidr(s: string): { v: 4 | 6; base: bigint; bits: number } | null {
  const [a, b, extra] = String(s || '').trim().split('/')
  if (extra !== undefined) return null
  const addr = parseAddr(a)
  if (!addr) return null
  const max = addr.v === 4 ? 32 : 128
  const bits = b === undefined ? max : /^\d{1,3}$/.test(b) ? Number(b) : -1
  if (bits < 0 || bits > max) return null
  const shift = BigInt(max - bits)
  return { v: addr.v, base: (addr.n >> shift) << shift, bits }
}
export function ipInList(ip: string | null | undefined, list: string[]): boolean {
  const a = ip ? parseAddr(ip) : null
  if (!a) return false
  return list.some(e => {
    const net = parseCidr(e)
    if (!net || net.v !== a.v) return false
    const shift = BigInt((a.v === 4 ? 32 : 128) - net.bits)
    return (a.n >> shift) << shift === net.base
  })
}
/** 画面から受け取った一覧（改行・カンマ区切りの文字列か配列）を検証する */
export function normalizeIpList(input: unknown): { list: string[] } | { error: string } {
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[\s,、]+/)
  const list = [...new Set(raw.map(x => x.normalize('NFKC').trim()).filter(Boolean))]
  if (list.length > IP_ALLOWLIST_MAX) return { error: `接続元は${IP_ALLOWLIST_MAX}件までにしてください` }
  const bad = list.find(x => !parseCidr(x))
  if (bad) return { error: `「${bad.slice(0, 50)}」は IP アドレス（例: 203.0.113.5、203.0.113.0/24）の形ではありません` }
  return { list }
}

// ---------- 二段階認証（TOTP） ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32Encode(u8: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of u8) {
    value = (value << 8) | b; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(out)
}
export const TOTP_STEP_SECONDS = 30
/** 新しい秘密鍵（160bit・Base32） */
export function newTotpSecret(): string {
  const a = new Uint8Array(20); crypto.getRandomValues(a)
  return base32Encode(a)
}
/** 認証アプリに登録する URI（QR コードにする） */
export function totpUri(secret: string, account: string, issuer = 'Mobital'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`
}
async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const buf = new ArrayBuffer(8); const dv = new DataView(buf)
  dv.setUint32(0, Math.floor(counter / 2 ** 32)); dv.setUint32(4, counter >>> 0)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))
  const off = mac[mac.length - 1] & 0xf
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]
  return String(bin % 1000000).padStart(6, '0')
}
/**
 * 6桁のコードを確かめる。端末の時計のずれを考えて前後1区切り（±30秒）まで受け付ける。
 * lastStep 以前の区切りのコードは使用済みとして受け付けない。合えば使った区切りの番号、合わなければ null
 */
export async function verifyTotp(secret: string | null | undefined, code: unknown, lastStep: number | null | undefined, now = Date.now()): Promise<number | null> {
  const c = String(code ?? '').normalize('NFKC').replace(/[\s-]/g, '')
  if (!secret || !/^\d{6}$/.test(c)) return null
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS)
  let hit: number | null = null
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep != null && s <= lastStep) continue
    // 一致の位置で処理時間が変わらないよう、すべての候補を計算してから判定する
    if ((await hotp(secret, s)) === c && hit === null) hit = s
  }
  return hit
}

// ---------- 予備コード（認証アプリを使えないときに1回ずつ使える） ----------
export const RECOVERY_CODE_COUNT = 8
const RC_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'
const normRecovery = (s: unknown) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')
/** 予備コード（表示用 xxxxx-xxxxx）と、保存用のハッシュの JSON */
export async function newRecoveryCodes(): Promise<{ codes: string[]; stored: string }> {
  const codes: string[] = []
  const limit = 256 - (256 % RC_CHARS.length)
  while (codes.length < RECOVERY_CODE_COUNT) {
    const buf = new Uint8Array(40); crypto.getRandomValues(buf)
    const chars = [...buf].filter(b => b < limit).map(b => RC_CHARS[b % RC_CHARS.length])
    if (chars.length >= 10) codes.push(chars.slice(0, 5).join('') + '-' + chars.slice(5, 10).join(''))
  }
  const hashes = await Promise.all(codes.map(c => sha256Hex('recovery|' + normRecovery(c))))
  return { codes, stored: JSON.stringify(hashes) }
}
export function recoveryCodesLeft(stored: unknown): number {
  try { const a = JSON.parse(String(stored || '[]')); return Array.isArray(a) ? a.length : 0 } catch { return 0 }
}
/** 予備コードが合えば、それを除いた残りの JSON を返す。合わなければ null */
export async function consumeRecoveryCode(stored: unknown, input: unknown): Promise<string | null> {
  const c = normRecovery(input)
  if (c.length !== 10) return null
  let list: string[] = []
  try { const a = JSON.parse(String(stored || '[]')); if (Array.isArray(a)) list = a } catch { return null }
  const h = await sha256Hex('recovery|' + c)
  const i = list.indexOf(h)
  if (i < 0) return null
  list.splice(i, 1)
  return JSON.stringify(list)
}
