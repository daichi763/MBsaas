// =========================================================
// Web Push（VAPID。#178）の送信
// 本文（payload）は送らない。端末の Service Worker（/sw.js）がプッシュを受けたら /api/staff/push/latest から最新の未読を取りに来て表示する。
// 本文の暗号化（ECDH・HKDF・AES-GCM）を省くので、1回の送信は署名（ES256）1回と HTTP の送信だけで済む（Free プランの CPU 時間に収める）。
// 署名した JWT は送信先（プッシュの事業者）ごとに、この isolate の中で期限の手前まで使い回す。
// 鍵: Secret の VAPID_PUBLIC_KEY（非圧縮の公開鍵 65 バイトの base64url）・VAPID_PRIVATE_KEY（秘密鍵 d 32 バイトの base64url）があればそれを使う
// （npx web-push generate-vapid-keys の出力と同じ形式）。なければ初回に作って push_vapid_keys に保存する
// =========================================================
import { nowJST } from './time'
import { appBaseUrl } from './http'
import { b64url } from './hash'
export { b64url }

export type VapidEnv = { DB: D1Database; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string; APP_BASE_URL?: string }
type LoadedVapid = { publicKey: string; key: CryptoKey }
export function fromB64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let cached: { id: string; v: LoadedVapid } | null = null
const jwtCache = new Map<string, { jwt: string; exp: number }>()
const JWT_HOURS = 12

async function importVapid(publicKey: string, privateD: string): Promise<LoadedVapid> {
  const raw = fromB64url(publicKey)
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('VAPID の公開鍵の形式が正しくありません')
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33, 65)), d: privateD, ext: true }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return { publicKey, key }
}

/** VAPID の鍵を読む（なければ作って保存する）。同じ isolate の中では読み直さない */
export async function loadVapid(env: VapidEnv): Promise<LoadedVapid> {
  const pub = String(env.VAPID_PUBLIC_KEY || '').trim(), priv = String(env.VAPID_PRIVATE_KEY || '').trim()
  if (pub && priv) {
    if (cached?.id !== 'env:' + pub) cached = { id: 'env:' + pub, v: await importVapid(pub, priv) }
    return cached.v
  }
  let row = await env.DB.prepare('SELECT public_key, private_key FROM push_vapid_keys WHERE key_id = 1').first() as any
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey) as ArrayBuffer
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey) as JsonWebKey
    const at = nowJST()
    // 同時に作られたときは先に入った鍵を使う
    await env.DB.prepare('INSERT OR IGNORE INTO push_vapid_keys (key_id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)').bind(b64url(rawPub), jwk.d, at).run()
    row = await env.DB.prepare('SELECT public_key, private_key FROM push_vapid_keys WHERE key_id = 1').first() as any
  }
  if (cached?.id !== 'db:' + row.public_key) cached = { id: 'db:' + row.public_key, v: await importVapid(row.public_key, row.private_key) }
  return cached.v
}

// VAPID の sub（連絡先）。https の URL か mailto: でなければならない
function vapidSubject(env: VapidEnv): string {
  const s = String(env.VAPID_SUBJECT || '').trim()
  if (/^(mailto:|https:\/\/)/.test(s)) return s
  const base = appBaseUrl(env)
  return /^https:\/\//.test(base) ? base : 'mailto:noreply@example.com'
}

async function vapidJwt(env: VapidEnv, v: LoadedVapid, audience: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const hit = jwtCache.get(v.publicKey + ' ' + audience)
  if (hit && hit.exp - now > 3600) return hit.jwt
  const exp = now + JWT_HOURS * 3600
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp, sub: vapidSubject(env) })}`
  // WebCrypto の ECDSA の署名は r||s（64 バイト）で、JWT の ES256 の形式と同じ
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${b64url(sig)}`
  jwtCache.set(v.publicKey + ' ' + audience, { jwt, exp })
  return jwt
}

// 送ってよい送信先（ブラウザのプッシュの事業者）。利用者が登録する URL なので、ほかのサーバーへは送らない
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com']
export function isAllowedPushEndpoint(endpoint: string, allowLocal: boolean): boolean {
  let u: URL
  try { u = new URL(endpoint) } catch { return false }
  if (endpoint.length > 1000) return false
  // ローカルの開発・テスト（APP_BASE_URL が http://localhost・127.0.0.1）では、手元の受け口へ送れるようにする
  if (allowLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true
  if (u.protocol !== 'https:' || u.port) return false
  return PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
}
export function allowLocalPush(env: { APP_BASE_URL?: string }): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(env.APP_BASE_URL || ''))
}

/**
 * 本文なしのプッシュを1件送る。gone: 購読がなくなった（404・410。購読を消す）
 * Topic を付けて、端末が電波のない間に届かなかったプッシュを1件にまとめる（届いたら最新の未読を取りに来るので、まとめても足りる）
 */
export async function sendWebPush(env: VapidEnv, endpoint: string, ttlSeconds = 86400): Promise<{ ok: boolean; status: number; gone: boolean; error?: string }> {
  try {
    const v = await loadVapid(env)
    const jwt = await vapidJwt(env, v, new URL(endpoint).origin)
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { TTL: String(ttlSeconds), Urgency: 'normal', Topic: 'fieldos-notice', Authorization: `vapid t=${jwt}, k=${v.publicKey}`, 'Content-Length': '0' },
    })
    const gone = r.status === 404 || r.status === 410
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone, error: r.ok ? undefined : `http_${r.status}` }
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: 'network_error' }
  }
}

/**
 * 購読を登録した要求のホストと、同じ人の別のホストの購読を消すかどうか（Sprint 27 #9981）。
 * 購読はオリジン（ホスト）ごとなので、本番の URL を workers.dev から APP_BASE_URL（app.mobital.jp）に移した後、
 * 新しいホストで通知をオンにし直すと、同じ端末に古いホストの購読（古い Service Worker）も残り、同じ通知が2回届く。
 * そこで、APP_BASE_URL のホストで購読を登録したときだけ、同じ人の、別のホストで登録した購読を消す（その端末には新しいホストの購読から届く）。
 *   ・host: 保存する登録のホスト（push_subscriptions.subscribed_host。小文字・ポート付き）
 *   ・cleanup: 別のホストの購読を消すか。APP_BASE_URL のホストでの登録のときだけ（古いホストの開いたままのタブで登録しても、新しいホストの購読は消さない）
 *   ・nullIsOther: ホストの記録がない購読（0113 より前の登録）も別のホストとして消すか。0113 より前の購読は、
 *     本番・ステージングでは workers.dev、手元では localhost で登録したもの。APP_BASE_URL が workers.dev（ステージング・戻したとき）なら
 *     同じホストの購読なので消さない
 * 端末の Service Worker の更新に頼らない（iOS のホーム画面のアプリ・Android の Chrome のどちらも、古い Service Worker がいつ更新されるか決まらないため）。
 * 消した古い購読の端末には、もうプッシュを送らない（ブラウザに残った購読には何も届かない）
 */
export function pushHostCleanup(requestUrl: string, env: { APP_BASE_URL?: string } | null | undefined): { host: string; cleanup: boolean; nullIsOther: boolean } {
  let host = ''
  try { host = new URL(requestUrl).host.toLowerCase() } catch { /* 読めない URL は記録しない */ }
  let app = ''
  try { app = new URL(appBaseUrl(env)).host.toLowerCase() } catch { /* APP_BASE_URL が無いときは消さない */ }
  const cleanup = !!host && !!app && host === app
  return { host, cleanup, nullIsOther: cleanup && !app.split(':')[0].endsWith('.workers.dev') }
}
