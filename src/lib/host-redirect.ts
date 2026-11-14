// ============ workers.dev から本来の URL（APP_BASE_URL）への転送（Sprint 27 #9981） ============
// 本番の URL を https://app.mobital.jp に移した後も、workers.dev の URL（ブックマーク・古いメールのリンク・ホーム画面のアプリ）で
// 開かれることがあるので、画面だけを APP_BASE_URL の同じパス・クエリへ 301 で移す。
// 転送するのは次のすべてに当てはまるときだけ:
//   ・GET か HEAD（POST などの書き込みは移さない）
//   ・要求のホストが *.workers.dev で、APP_BASE_URL のホストと違う（localhost・127.0.0.1・テスト・APP_BASE_URL と同じホストでは移さない）
//   ・APP_BASE_URL が https の URL
//   ・画面のパス（下の NO_REDIRECT_PREFIXES・拡張子の付いたファイルは除く）
// /api/* と /webhooks/* は移さない。古いタブ・ホーム画面のアプリ（workers.dev のまま）・workers.dev の Service Worker・
// Resend の Webhook（宛先を変えるまで workers.dev に届く）が、そのまま動き続けるようにするため
import { appBaseUrl } from './http'

const NO_REDIRECT_PREFIXES = ['/api/', '/webhooks/', '/static/']
const NO_REDIRECT_PATHS = new Set(['/api', '/webhooks', '/sw.js', '/manifest.webmanifest', '/favicon.ico', '/robots.txt'])
/** 転送した応答をブラウザが覚えておく秒数。戻すときに古い転送が長く残らないよう、1日にとどめる */
export const HOST_REDIRECT_MAX_AGE = 86400

/** 転送先の URL。転送しないときは null */
export function hostRedirectTarget(method: string, requestUrl: string, env: { APP_BASE_URL?: string } | null | undefined): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null
  const base = appBaseUrl(env)
  if (!/^https:\/\//i.test(base)) return null
  let req: URL, to: URL
  try { req = new URL(requestUrl); to = new URL(base) } catch { return null }
  const host = req.hostname.toLowerCase()
  if (!host.endsWith('.workers.dev') || host === to.hostname.toLowerCase()) return null
  const path = req.pathname
  if (NO_REDIRECT_PATHS.has(path) || NO_REDIRECT_PREFIXES.some(p => path.startsWith(p))) return null
  // 静的ファイル（/static の外に置いたアイコンなど）。画面のパス（/r/<トークン> など）には拡張子が付かない
  if (/\.[A-Za-z0-9]{1,8}$/.test(path)) return null
  // 宛先のホストは APP_BASE_URL から取り、要求からはパスとクエリだけを引き継ぐ（別のサイトへは移さない）
  return to.origin + path + req.search
}
