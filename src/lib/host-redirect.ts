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

/** 要求が APP_BASE_URL（https）と違う *.workers.dev のホストに来たときの、要求と宛先の URL。そうでなければ null */
function otherWorkersDev(requestUrl: string, env: { APP_BASE_URL?: string } | null | undefined): { req: URL; to: URL } | null {
  const base = appBaseUrl(env)
  if (!/^https:\/\//i.test(base)) return null
  let req: URL, to: URL
  try { req = new URL(requestUrl); to = new URL(base) } catch { return null }
  const host = req.hostname.toLowerCase()
  if (!host.endsWith('.workers.dev') || host === to.hostname.toLowerCase()) return null
  return { req, to }
}

/** 転送先の URL。転送しないときは null */
export function hostRedirectTarget(method: string, requestUrl: string, env: { APP_BASE_URL?: string } | null | undefined): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null
  const hit = otherWorkersDev(requestUrl, env)
  if (!hit) return null
  const { req, to } = hit
  const path = req.pathname
  if (NO_REDIRECT_PATHS.has(path) || NO_REDIRECT_PREFIXES.some(p => path.startsWith(p))) return null
  // 静的ファイル（/static の外に置いたアイコンなど）。画面のパス（/r/<トークン> など）には拡張子が付かない
  if (/\.[A-Za-z0-9]{1,8}$/.test(path)) return null
  // 宛先のホストは APP_BASE_URL から取り、要求からはパスとクエリだけを引き継ぐ（別のサイトへは移さない）
  return to.origin + path + req.search
}

// ============ workers.dev でのログイン・ログインなしの送信を断る（Sprint 33 #10001 セキュリティの点検 H2 の (6)） ============
// ログインの回数の制限（WAF。/api/auth/login で始まるパス・同じ IP から10秒に20回まで）は app.mobital.jp にしか効かない。
// workers.dev の URL（mbsaas.<サブドメイン>.workers.dev）へ送ればすり抜けられるので、そこでの次の書き込みは 403（code: use_app_host）で断る:
//   ・/api/auth/* の書き込み（ログイン・二段階認証・パスワードの再設定の依頼と実行・メールアドレスの確認など）。/api/auth/logout だけは通す（古いタブからログアウトできるように）
//   ・/api/public/* の書き込み（報告用URLの報告・募集ページの応募・お知らせの「確認しました」）
// 通すもの: GET・HEAD・OPTIONS、ログインした人の /api の書き込み（古いタブ・ホーム画面のアプリ。CSRF の確認はそのまま）、
//   /webhooks/*（Resend の Webhook は宛先を変えるまで workers.dev に届く。署名で確かめる。docs/operations.md の 11 章）、/api/health。
// 本番だけに効く: APP_BASE_URL が https で、要求のホストがそれと違う *.workers.dev のとき（転送と同じ条件）。
//   検証環境（mbsaas-stg）は APP_BASE_URL が自分の workers.dev なので断らない。ローカル（localhost・127.0.0.1）・テストでも断らない
export const APP_HOST_ONLY_PREFIXES = ['/api/auth/', '/api/public/']
export const APP_HOST_ONLY_ALLOW = new Set(['/api/auth/logout'])
/** 断るなら、案内に出す本来の URL（APP_BASE_URL の origin）。断らないなら null */
export function appHostOnlyBlock(method: string, requestUrl: string, env: { APP_BASE_URL?: string } | null | undefined): string | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  const hit = otherWorkersDev(requestUrl, env)
  if (!hit) return null
  const path = hit.req.pathname
  if (APP_HOST_ONLY_ALLOW.has(path) || !APP_HOST_ONLY_PREFIXES.some(p => path.startsWith(p))) return null
  return hit.to.origin
}
