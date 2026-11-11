// API の要求・応答の共通の処理（Sprint 24 #9967）
//
// - readJson: 要求の本文を JSON として読む。読めない（壊れた JSON・空・オブジェクトでない）ときは 400 で止める。
//   HTTPException で返すので、index.tsx の app.onError はそのまま応答にし、障害の記録（error_logs）と通知の件数には入れない。
// - apiNotFound: /api の存在しないパスの 404（JSON の { error }）。
// - recordSwallowedError: 利用者への応答は成功のままにする後続の処理（実績の同期・書き出しの記録など）の失敗を、
//   Workers Logs と error_logs（本部画面「障害」）に残す。記録に失敗しても例外は投げない。
// - appBaseUrl: APP_BASE_URL の末尾の / を除いた値（リンクの組み立てはこれを使う）。
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { recordError, newErrorRef, maskPath, sanitizeErrorText, type ErrorAlertEnv } from './error-log'

export const BAD_JSON_MESSAGE = '送られた内容を読み取れませんでした。画面を読み込み直してから、もう一度お試しください'
export const NOT_FOUND_MESSAGE = '見つかりません'

const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=UTF-8' },
})

/** 本文を JSON のオブジェクトとして読む。読めなければ 400（{ error, code: 'bad_json' }）で止める */
export async function readJson<T = any>(c: Context): Promise<T> {
  let b: unknown
  try { b = await c.req.json() } catch { b = undefined }
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new HTTPException(400, { res: jsonResponse({ error: BAD_JSON_MESSAGE, code: 'bad_json' }, 400) })
  }
  return b as T
}

/** /api の存在しないパス */
export const apiNotFound = (c: Context) => c.json({ error: NOT_FOUND_MESSAGE }, 404)

type SwallowedAt = { method?: string | null; path?: string | null; companyId?: number | null; role?: string | null }

// 記録の本体。label を付けたエラーにして、Workers Logs（伏せた要約）と error_logs に残す
function logSwallowed(env: ErrorAlertEnv, label: string, err: unknown, at: SwallowedAt): Promise<void> {
  const ref = newErrorRef()
  const e = err as any
  const wrapped = new Error(`${label}に失敗しました: ${String(e && typeof e === 'object' && 'message' in e ? e.message : err)}`)
  wrapped.name = String((e && typeof e === 'object' && e.name) || 'Error')
  if (e && e.stack) wrapped.stack = String(e.stack)
  console.log(JSON.stringify({ level: 'warn', event: 'swallowed_error', ref, label, method: at.method ?? null, path: at.path ? maskPath(at.path) : null,
    company_id: at.companyId ?? null, message: sanitizeErrorText(wrapped.message) }))
  return recordError(env, { ref, source: 'request', method: at.method ?? null, path: at.path ?? null, companyId: at.companyId ?? null, role: at.role ?? null, error: wrapped })
    .then(() => {}, x => { console.log(`error log failed: ${x}`) })
}

/**
 * 握りつぶしていた失敗を記録する（応答は変えない）。label は何の処理か（例: 「実績の同期」）。
 * error_logs への記録は応答の後（waitUntil）に行う。waitUntil が使えないときはその場で待つ。例外は投げない
 */
export async function recordSwallowedError(c: Context, label: string, err: unknown): Promise<void> {
  try {
    const u = (c as any).get?.('user')
    const p = logSwallowed(c.env as ErrorAlertEnv, label, err, { method: c.req.method, path: c.req.path, companyId: u?.company_id ?? null, role: u?.role ?? null })
    try { c.executionCtx.waitUntil(p) } catch { await p }
  } catch (x) {
    console.log(`swallowed error log failed: ${x}`)
  }
}

/** 要求（Context）を受け取らない関数の中から記録する（その場で待つ。失敗したときだけ呼ばれるので、ふだんの応答は遅くならない）。例外は投げない */
export async function recordSwallowedErrorDb(db: D1Database, label: string, err: unknown, at: SwallowedAt = {}): Promise<void> {
  try { await logSwallowed({ DB: db }, label, err, at) } catch (x) { console.log(`swallowed error log failed: ${x}`) }
}

/** APP_BASE_URL の前後の空白と末尾の / を除く（未設定なら空文字） */
export function appBaseUrl(env: { APP_BASE_URL?: string } | null | undefined): string {
  return String(env?.APP_BASE_URL || '').trim().replace(/\/+$/, '')
}
