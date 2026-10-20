// ログインの安全対策の共通部品（作業単位 w4-auth-features: #552 #453 #544）
// - ログインの履歴（login_events）の記録
// - 二段階認証（認証アプリの TOTP。RFC 6238: HMAC-SHA1・30秒・6桁）と予備コード
// - 会社ごとの設定（二段階認証を必須にするか・接続元 IP の制限）。companies.settings_json に持つ
// - 同じ人（person_id が同じ他社の行）のセッションをまとめて扱う条件
import type { Context } from 'hono'
import { sha256Hex } from './auth'

/** 二段階認証を使える（接続元の制限の対象になる）ロール。スタッフは対象外 */
export const MFA_ROLES = ['system_admin', 'company_admin', 'sales_manager', 'field_manager', 'office_staff']
export function canUseMfa(role: unknown): boolean { return MFA_ROLES.includes(String(role)) }

const nowIso = () => new Date().toISOString()

// ---------- ログインの履歴 ----------
export type LoginEvent = {
  company_id?: number | null; user_id?: number | null; company_code?: string | null; user_code?: string | null
  event_type?: 'login' | 'password_reset' | 'logout_all' | 'forced_logout' | 'switch_company'
  result: 'success' | 'bad_password' | 'locked' | 'inactive' | 'company_inactive' | 'ip_denied' | 'mfa_failed'
  method?: 'password' | 'totp' | 'recovery' | null; actor_user_id?: number | null
}
/** 接続元 IP と端末（User-Agent の先頭300文字） */
export function requestMeta(c: Context): { ip: string | null; ua: string | null } {
  return { ip: c.req.header('CF-Connecting-IP') || null, ua: (c.req.header('User-Agent') || '').slice(0, 300) || null }
}
/** 履歴を1行残す。記録に失敗してもログインなどの処理は止めない */
export async function recordLoginEvent(db: D1Database, c: Context, ev: LoginEvent): Promise<void> {
  const m = requestMeta(c)
  try {
    await db.prepare(`INSERT INTO login_events (company_id, user_id, company_code, user_code, event_type, result, method, ip, user_agent, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(ev.company_id ?? null, ev.user_id ?? null,
      ev.company_code ? String(ev.company_code).slice(0, 40) : null, ev.user_code ? String(ev.user_code).slice(0, 40) : null,
      ev.event_type || 'login', ev.result, ev.method ?? null, m.ip, m.ua, ev.actor_user_id ?? null, nowIso()).run()
  } catch (e) { console.log(`login_events record failed: ${e}`) }
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
export function totpUri(secret: string, account: string, issuer = 'Field OS'): string {
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
