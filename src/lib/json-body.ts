// ============ 要求の本文の形の確認（Sprint 33 #10000 セキュリティの点検 M4） ============
// 各 API は c.req.json().catch(() => ({})) で本文を読むが、本文が null・数値・文字列のときは例外にならず、そのあとの b.x で TypeError になって 500 になる
// （app.onError → error_logs への記録・本部への error_alert）。POST /api/auth/login でも起き、ログインしていない人が何度でも起こせる。
// そこで /api/* の POST・PUT・PATCH・DELETE は、ハンドラの前に本文を読み、JSON として正しく、かつプレーンなオブジェクト（{...}）でなければ
// 400 { error, code: 'invalid_body' } で断る（400 は app.onError を通らないので、error_logs・警報には数えない）。
//   ・本文が空（空白だけを含む）のときは今までどおり（各ハンドラの既定値に任せる）
//   ・multipart/form-data（写真・書類のアップロード）は本文を読まない。そのうえで、その要求で c.req.json() が呼ばれたときだけ形を確かめ、
//     オブジェクトでなければ読めなかったことにする（Content-Type を偽った null で 500 にしない。ハンドラの .catch の既定値・readJson の 400 になる）
//   ・/webhooks/*（Resend の Webhook。署名を確かめる）は /api の外なので対象外
//   ・配列（[...]）を本文で受け取る API は、2026-11 の時点で src を探して無かった。足すときは JSON_ARRAY_BODY_PATHS にパスを足す
// 読んだ本文は、最初の c.req.json() にそのまま渡す（同じ本文を2回 JSON として読まない。2回目からは今までどおり読み直す）。
import type { Context, MiddlewareHandler } from 'hono'

export const INVALID_BODY_MESSAGE = '送信の内容が正しくありません。画面を読み込み直してから、もう一度お試しください'
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** 本文に配列を受け取ってよい API のパス（今は無い） */
export const JSON_ARRAY_BODY_PATHS: RegExp[] = []

const isPlainObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
const invalid = (c: Context) => c.json({ error: INVALID_BODY_MESSAGE, code: 'invalid_body' }, 400)

export const jsonBodyGuard: MiddlewareHandler = async (c, next) => {
  if (!BODY_METHODS.has(c.req.method)) return next()
  const arrayOk = JSON_ARRAY_BODY_PATHS.some(re => re.test(c.req.path))
  const accept = (v: unknown) => isPlainObject(v) || (arrayOk && Array.isArray(v))
  const req = c.req as any
  const readJson = req.json.bind(req) as () => Promise<unknown>
  if (String(c.req.header('Content-Type') || '').toLowerCase().startsWith('multipart/form-data')) {
    req.json = async () => {
      const v = await readJson()
      if (!accept(v)) throw new SyntaxError(INVALID_BODY_MESSAGE)
      return v
    }
    return next()
  }
  let text: string
  try { text = await c.req.text() } catch { return invalid(c) }
  if (!text.trim()) return next()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return invalid(c) }
  if (!accept(parsed)) return invalid(c)
  let handed = false
  req.json = async () => {
    if (handed) return readJson()
    handed = true
    return parsed
  }
  return next()
}
