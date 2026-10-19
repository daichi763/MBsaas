// 共通メール送信サービス。
// 「どんなメールを送るか」は各機能側が決め、「Resendをどう呼ぶか」はここに隠蔽する。
// 新しいメール種別（契約更新通知・スタッフ登録通知など）を追加する場合も、
// テンプレートを src/email-templates/ に追加し、この sendEmail() を呼ぶだけでよい。
// 多人数へ送るとき（お知らせなど）は sendEmailBatch() を使う（Resend のバッチ送信で100件ずつ、送信上限に合わせて間隔を空ける）。
// 送信元（MAIL_FROM）・有効/無効（MAIL_ENABLED）は wrangler.jsonc の vars で環境ごとに設定する。
// 送らないもの（#541 #13）: 不達・迷惑メールの報告があったアドレス（email_suppressions）と、契約が停止中の企業のメール。
// 配信の結果（不達・迷惑メールの報告・配信済み）は Resend の Webhook（handleResendWebhook）で受け取り、送信の記録を更新する。
import { Resend } from 'resend'

export type MailEnv = {
  RESEND_API_KEY: string
  MAIL_FROM: string
  MAIL_ENABLED?: string // 'false' の場合は実送信せずログのみ（開発環境での誤送信防止）
  DB: D1Database
  RESEND_WEBHOOK_SECRET?: string // Resend の Webhook の署名の秘密（whsec_...）。未設定なら Webhook を受け付けない
}

export type SendEmailInput = {
  to: string
  subject: string
  html: string
  text?: string
  type: string // ログ用の種別（例: 'password_reset' | 'notice'）
  company_id?: number | null
  reply_to?: string | null // 返信先（企業が設定した問い合わせ先のアドレス。#367）
}

// skipped: MAIL_ENABLED='false' のため送らなかった（ok は true のまま。既存の呼び出し側の扱いを変えないため）
export type SendEmailResult = { ok: boolean; id?: string; error?: string; skipped?: boolean }

// Resend のバッチ送信の上限（1回100件）と、既定の送信上限（1秒あたり2リクエスト）に合わせた間隔
const BATCH_SIZE = 100
const REQUEST_INTERVAL_MS = 600
const MAX_ATTEMPTS = 3
const VALID_EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 0) return '***'
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`
}
// 文中のメールアドレスを伏せる（送信サービスのエラー文に宛先が入ることがあるため）
export const maskEmailsIn = (s: string) => String(s ?? '').replace(/[^\s@<>,;:"'()]+@[^\s@<>,;:"'()]+/g, m => maskEmail(m))

// 送信サービスのエラーを「resend_error: 名前 - 内容」の短い文にする（#438。本文・APIキーは含めない。宛先は伏せる）
// 画面はコロンの前（resend_error など）で理由の種類を見分ける
const ERROR_DETAIL_MAX = 200
function resendErrorDetail(error: { name?: unknown; message?: unknown } | null | undefined): string {
  const name = String(error?.name ?? '').slice(0, 60)
  const message = maskEmailsIn(String(error?.message ?? '')).replace(/\s+/g, ' ').trim()
  const detail = [name, message].filter(Boolean).join(' - ')
  return ('resend_error' + (detail ? ': ' + detail : '')).slice(0, ERROR_DETAIL_MAX)
}
export const normalizeAddress = (s: string | null | undefined) => String(s || '').trim().toLowerCase()

// 送らない宛先・企業を調べる（#541 #13）。戻り値は inputs と同じ順の「止める理由」（送るものは null）
async function blockedReasons(env: MailEnv, inputs: SendEmailInput[]): Promise<(string | null)[]> {
  const out: (string | null)[] = inputs.map(() => null)
  try {
    const addrs = [...new Set(inputs.map(i => normalizeAddress(i.to)).filter(Boolean))]
    const companyIds = [...new Set(inputs.map(i => i.company_id).filter((x): x is number => typeof x === 'number'))]
    const [sup, inactive] = await Promise.all([
      addrs.length ? env.DB.prepare('SELECT email, reason FROM email_suppressions WHERE email IN (SELECT value FROM json_each(?))').bind(JSON.stringify(addrs)).all() : null,
      companyIds.length ? env.DB.prepare(`SELECT company_id FROM companies WHERE active_status = 'inactive' AND company_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(companyIds)).all() : null,
    ])
    const supMap = new Map(((sup?.results || []) as any[]).map(r => [String(r.email), String(r.reason)]))
    const inactiveSet = new Set(((inactive?.results || []) as any[]).map(r => Number(r.company_id)))
    inputs.forEach((i, k) => {
      if (typeof i.company_id === 'number' && inactiveSet.has(i.company_id)) out[k] = 'company_inactive'
      else if (supMap.has(normalizeAddress(i.to))) out[k] = `suppressed_${supMap.get(normalizeAddress(i.to))}`
    })
  } catch {
    // 表が無い環境（マイグレーションの適用前）では止めない
  }
  return out
}

// 送信できる設定かどうか。disabled: MAIL_ENABLED='false' / not_configured: APIキーか送信元が未設定
export function mailMode(env: MailEnv): 'enabled' | 'disabled' | 'not_configured' {
  if (env.MAIL_ENABLED === 'false') return 'disabled'
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return 'not_configured'
  return 'enabled'
}

function warnTestSender(env: MailEnv) {
  // Resend のテスト用アドレスはアカウント所有者あてにしか届かない（本番では独自ドメインの送信元にする）
  if (/@resend\.dev>?\s*$/i.test(env.MAIL_FROM || '')) console.log('mail warning: MAIL_FROM is the resend.dev test sender')
}

// 送信ログ（本文・APIキーは保存しない）。ログ保存の失敗は送信結果に影響させない
async function writeLogs(env: MailEnv, items: { input: SendEmailInput; result: SendEmailResult }[]) {
  if (!items.length) return
  try {
    const rows = items.map(({ input, result }) => ({
      c: input.company_id ?? null, to: input.to, t: input.type,
      s: result.skipped ? 'skipped' : result.ok ? 'sent' : 'failed', id: result.id ?? null, e: result.error ?? null,
    }))
    // json_each で1文にまとめる（D1 のバインド上限を避ける）
    await env.DB.prepare(
      `INSERT INTO email_logs (company_id, to_email, type, status, provider_message_id, error_message)
       SELECT json_extract(value, '$.c'), json_extract(value, '$.to'), json_extract(value, '$.t'), json_extract(value, '$.s'), json_extract(value, '$.id'), json_extract(value, '$.e')
       FROM json_each(?)`
    ).bind(JSON.stringify(rows)).run()
  } catch {
    // ログ保存失敗は無視（メール送信結果を優先して返す）
  }
}

export async function sendEmail(env: MailEnv, input: SendEmailInput): Promise<SendEmailResult> {
  let result: SendEmailResult
  const mode = mailMode(env)
  const [blocked] = await blockedReasons(env, [input])

  if (blocked) {
    console.log(`mail blocked: type=${input.type} to=${maskEmail(input.to)} reason=${blocked}`)
    result = { ok: false, error: blocked }
  } else if (mode === 'disabled') {
    console.log(`mail disabled: skipped type=${input.type} to=${maskEmail(input.to)}`)
    result = { ok: true, id: 'skipped-disabled', skipped: true }
  } else if (mode === 'not_configured') {
    // Secret未設定時は送信せず失敗として記録する（本文・APIキーはログに出さない）
    console.log(`mail not configured: type=${input.type}`)
    result = { ok: false, error: 'mail_not_configured' }
  } else {
    warnTestSender(env)
    try {
      const resend = new Resend(env.RESEND_API_KEY)
      const { data, error } = await resend.emails.send({
        from: env.MAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.reply_to ? { replyTo: input.reply_to } : {}),
      })
      if (error) {
        console.log(`resend send failed: type=${input.type} to=${maskEmail(input.to)} name=${error.name}`)
        result = { ok: false, error: resendErrorDetail(error) }
      } else {
        result = { ok: true, id: data?.id }
      }
    } catch {
      console.log(`resend send exception: type=${input.type} to=${maskEmail(input.to)}`)
      result = { ok: false, error: 'network_error' }
    }
  }

  await writeLogs(env, [{ input, result }])
  return result
}

/**
 * 複数のメールをまとめて送る。戻り値は inputs と同じ順の結果。
 * - Resend のバッチ送信（1回100件）を使い、リクエストの間隔を空ける。送信上限（rate_limit_exceeded）や通信エラーは待って再試行する
 * - idempotencyKey を渡すと「キー-n」を各バッチの冪等キーにする（再試行や二重起動でも同じバッチを二重に送らない）
 * - 1件ずつの結果は email_logs にも記録する
 */
export async function sendEmailBatch(env: MailEnv, inputs: SendEmailInput[], opts: { idempotencyKey?: string } = {}): Promise<SendEmailResult[]> {
  if (!inputs.length) return []
  const mode = mailMode(env)
  let results: SendEmailResult[]
  const blocked = await blockedReasons(env, inputs)
  if (mode === 'disabled') {
    console.log(`mail disabled: skipped ${inputs.length} mails type=${inputs[0].type}`)
    results = inputs.map(() => ({ ok: true, id: 'skipped-disabled', skipped: true }))
  } else if (mode === 'not_configured') {
    console.log(`mail not configured: type=${inputs[0].type}`)
    results = inputs.map(() => ({ ok: false, error: 'mail_not_configured' }))
  } else {
    warnTestSender(env)
    const resend = new Resend(env.RESEND_API_KEY)
    results = inputs.map((): SendEmailResult => ({ ok: false, error: 'invalid_address' }))
    // 書式の誤ったアドレスが1件でもあるとバッチ全体が失敗するため、先に除いておく
    const valid = inputs.map((_, k) => k).filter(k => VALID_EMAIL.test(inputs[k].to) && !blocked[k])
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const idx = valid.slice(i, i + BATCH_SIZE)
      const chunk = idx.map(k => inputs[k])
      if (i > 0) await sleep(REQUEST_INTERVAL_MS)
      let chunkResults: SendEmailResult[] | null = null
      let lastError = 'resend_error'
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chunkResults; attempt++) {
        try {
          const { data, error } = await resend.batch.send(
            chunk.map(m => ({ from: env.MAIL_FROM, to: m.to, subject: m.subject, html: m.html, text: m.text, ...(m.reply_to ? { replyTo: m.reply_to } : {}) })),
            opts.idempotencyKey ? { idempotencyKey: `${opts.idempotencyKey}-${i / BATCH_SIZE}` } : undefined
          )
          if (error) {
            console.log(`resend batch failed: type=${chunk[0].type} size=${chunk.length} name=${error.name} attempt=${attempt}`)
            lastError = resendErrorDetail(error)
            // 送信上限・同時実行・サービス側の障害は待って再試行する。宛先・送信元の不備などは再試行しても同じなので打ち切る
            const retryable = ['rate_limit_exceeded', 'concurrent_idempotent_requests', 'application_error', 'internal_server_error'].includes(String(error.name))
            if (!retryable) break
            await sleep(1000 * attempt)
            continue
          }
          const ids = data?.data || []
          chunkResults = chunk.map((_, j): SendEmailResult => ids[j]?.id ? { ok: true, id: ids[j].id } : { ok: false, error: 'resend_error' })
        } catch {
          console.log(`resend batch exception: type=${chunk[0].type} size=${chunk.length} attempt=${attempt}`)
          lastError = 'network_error'
          await sleep(1000 * attempt)
        }
      }
      idx.forEach((k, j) => { results[k] = chunkResults ? chunkResults[j] : { ok: false, error: lastError } })
    }
  }
  // 不達・迷惑メールの報告があったアドレスと、停止中の企業のメールは送らない（送信が無効の環境でも同じ結果にする）
  blocked.forEach((b, k) => { if (b) results[k] = { ok: false, error: b } })
  await writeLogs(env, inputs.map((input, k) => ({ input, result: results[k] })))
  return results
}

// =========================================================
// Resend の Webhook（#541）。POST /webhooks/resend（src/index.tsx。ログイン不要）
// 署名（Svix 形式: svix-id・svix-timestamp・svix-signature）を RESEND_WEBHOOK_SECRET で確かめてから、
// provider_message_id で email_logs・notification_emails・notice_email_deliveries の状態を更新する。
//   email.delivered  → email_logs を delivered に
//   email.bounced    → 送信の記録を不達（bounced）に。恒久的な不達（Permanent）は email_suppressions に入れ、以後は送らない
//   email.complained → 送信の記録を迷惑メールの報告（complained）にし、email_suppressions に入れる
// 同じイベントが何度届いても結果は同じ（更新は上書き、停止の登録は INSERT OR REPLACE）
// =========================================================
const WEBHOOK_TOLERANCE_SEC = 5 * 60
const textEnc = new TextEncoder()

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// Svix の署名を確かめる。nowSec はテスト用
export async function verifySvixSignature(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const { id, timestamp, signature } = headers
  if (!secret || !id || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false
  let keyBytes: Uint8Array
  try { keyBytes = b64ToBytes(secret.replace(/^whsec_/, '')) } catch { return false }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, textEnc.encode(`${id}.${timestamp}.${body}`)))
  const expected = bytesToB64(mac)
  // 「v1,署名」を空白区切りで複数持つことがある（秘密の切り替え中など）
  return signature.split(' ').some(part => {
    const [ver, sig] = part.split(',')
    return ver === 'v1' && !!sig && sameString(sig, expected)
  })
}

export async function handleResendWebhook(env: MailEnv, req: Request): Promise<Response> {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  if (!env.RESEND_WEBHOOK_SECRET) return json({ error: 'webhook_not_configured' }, 503)
  const body = await req.text()
  if (body.length > 256 * 1024) return json({ error: 'too_large' }, 413)
  const ok = await verifySvixSignature(env.RESEND_WEBHOOK_SECRET, {
    id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature'),
  }, body)
  if (!ok) return json({ error: 'invalid_signature' }, 401)
  let ev: any
  try { ev = JSON.parse(body) } catch { return json({ error: 'invalid_json' }, 400) }
  const type = String(ev?.type || '')
  const data = ev?.data || {}
  const messageId = typeof data.email_id === 'string' ? data.email_id : null
  const to: string[] = (Array.isArray(data.to) ? data.to : [data.to]).map((x: unknown) => normalizeAddress(String(x ?? ''))).filter(Boolean)
  if (!messageId) return json({ ok: true, ignored: true })
  const db = env.DB
  const at = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  if (type === 'email.delivered') {
    await db.prepare(`UPDATE email_logs SET status = 'delivered' WHERE provider_message_id = ? AND status = 'sent'`).bind(messageId).run()
    return json({ ok: true })
  }
  if (type !== 'email.bounced' && type !== 'email.complained') return json({ ok: true, ignored: true })
  const bounced = type === 'email.bounced'
  const bounceType = String(data.bounce?.type || '')
  // 一時的な不達（Transient）は記録だけにし、送信は止めない
  const permanent = !bounced || bounceType !== 'Transient'
  const code = bounced ? (permanent ? 'bounced' : 'bounced_soft') : 'complained'
  const detail = maskEmailsIn([bounceType, data.bounce?.subType, data.bounce?.message].filter(Boolean).join(' - ')).slice(0, ERROR_DETAIL_MAX) || null
  const errorText = detail ? `${code}: ${detail}` : code
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE email_logs SET status = ?, error_message = ? WHERE provider_message_id = ?`).bind(code, errorText, messageId),
    db.prepare(`UPDATE notification_emails SET status = 'failed', error = ? WHERE provider_message_id = ?`).bind(errorText, messageId),
    db.prepare(`UPDATE notice_email_deliveries SET status = 'failed', error = ? WHERE provider_message_id = ?`).bind(errorText, messageId),
  ]
  if (permanent) {
    for (const addr of to) {
      stmts.push(db.prepare(`INSERT OR REPLACE INTO email_suppressions (email, reason, detail, provider_message_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(addr, bounced ? 'bounced' : 'complained', detail, messageId, at))
    }
  }
  await db.batch(stmts)
  return json({ ok: true })
}
