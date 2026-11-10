// ============ CSRF の対策: 別のサイトからの書き込みを拒否する（#9943） ============
// /api/* の GET・HEAD・OPTIONS 以外は、送り元（Origin。なければ Referer）が自分のサイトのときだけ通す。
// 自分のサイト = リクエストの Host（c.req.url のホスト）と APP_BASE_URL のホスト。プロトコル・ポートまで比べる。
// セッションの Cookie は SameSite=Lax で、今のブラウザは別のサイトからの POST に Cookie を付けないが、
// ・Cookie が要らない POST /api/auth/login は、別のサイトのフォームから攻撃者のアカウントでログインさせられる（ログイン CSRF）
// ・c.req.json() は Content-Type を見ないので、<form enctype="text/plain"> からでも JSON として読める本文を送れる
// ため、Cookie に頼らずに送り元で止める。
//
// Origin も Referer も無いとき:
//   今のブラウザは GET・HEAD 以外のリクエストには、同じサイトでも必ず Origin を付ける。
//   ただし Referrer-Policy が no-referrer の画面（パスワード再設定・メールアドレスの確認など）からは、同じサイトでも Origin が "null" になる。
//   "null" は、ブラウザが付ける Sec-Fetch-Site（画面からは書き換えられない）が same-origin のときだけ通し、それ以外（別のサイトの sandbox の iframe など）は拒否する。
//   Origin も Referer も無いのは curl・テスト・ほかのプログラムからの呼び出しなので、セッションの Cookie を付けていないもの
//   （ログインなど）は通し、セッションの Cookie を付けたものだけを拒否する（古いブラウザでの CSRF の余地を残さないため）。
//   テスト（scripts/test-*.mjs）は scripts/fetch-origin.mjs で宛先と同じ Origin を付けて送る。
//
// 対象から外すもの（2026-11 の時点で src を grep して洗い出したもの。scripts/test-w21-csrf.mjs でも同じ一覧を確かめる）:
//   /api/public/* … ログイン不要で、URL のトークンで入る公開の API（セッションの Cookie を使わない）
//     POST /api/public/report/:token/attendance    報告用URLの勤怠の報告（src/staff-lifecycle.ts）
//     POST /api/public/report/:token/daily-report  報告用URLの日報（src/staff-lifecycle.ts）
//     POST /api/public/report/:token/consultation  報告用URLの相談（src/staff-lifecycle.ts）
//     POST /api/public/recruit/:token/apply        公開の募集ページの応募（src/recruit.ts）
//     POST /api/public/notice-ack                  お知らせメールの「確認しました」（src/notifications.ts）
//     （/api/public/report/:token/contact・/api/public/calendar/* は GET だけ）
//   /webhooks/resend … Resend の Webhook。/api の外にあり、署名で確かめる（src/services/email.ts）
//   定期処理（cron） … HTTP ではなく scheduled で動くので、ここを通らない（src/index.tsx）
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE } from './auth'
import { maskPath } from './error-log'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const CSRF_EXEMPT_PREFIXES = ['/api/public/']
export const CSRF_REJECT_MESSAGE = '別のサイトからの操作のため、受け付けませんでした。画面を開き直してから、もう一度お試しください'

function originOf(v: string | undefined | null): string | null {
  if (!v) return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch { return null }
}

/** 自分のサイトの送り元（Origin の形 "https://host[:port]"）の一覧 */
function allowedOrigins(c: Context): Set<string> {
  const self = new URL(c.req.url)
  const set = new Set<string>([self.origin])
  const host = c.req.header('Host')
  if (host) set.add(`${self.protocol}//${host.toLowerCase()}`)
  const base = originOf((c.env as any)?.APP_BASE_URL)
  if (base) set.add(base)
  return set
}

export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || CSRF_EXEMPT_PREFIXES.some(p => c.req.path.startsWith(p))) return next()
  const origin = c.req.header('Origin')
  const referer = c.req.header('Referer')
  let reason: string | null = null
  if (origin === 'null') {
    if (c.req.header('Sec-Fetch-Site') !== 'same-origin') reason = 'origin'
  } else if (origin != null && origin !== '') {
    const o = originOf(origin)
    if (!o || !allowedOrigins(c).has(o)) reason = 'origin'
  } else if (referer) {
    const r = originOf(referer)
    if (!r || !allowedOrigins(c).has(r)) reason = 'referer'
  } else if (getCookie(c, SESSION_COOKIE)) {
    reason = 'missing'
  }
  if (!reason) return next()
  // 誤って正しい操作を止めていないかを Workers Logs で追えるように、送り元を1行で残す（本文・Cookie は残さない）
  console.log(JSON.stringify({ level: 'warn', event: 'csrf_rejected', reason, method: c.req.method, path: maskPath(c.req.path),
    origin: (origin || '').slice(0, 200), referer_origin: originOf(referer) }))
  return c.json({ error: CSRF_REJECT_MESSAGE, code: 'csrf_origin' }, 403)
}
