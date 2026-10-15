// 共通メール送信サービス。
// 「どんなメールを送るか」は各機能側が決め、「Resendをどう呼ぶか」はここに隠蔽する。
// 新しいメール種別（契約更新通知・スタッフ登録通知など）を追加する場合も、
// テンプレートを src/email-templates/ に追加し、この sendEmail() を呼ぶだけでよい。
// 多人数へ送るとき（お知らせなど）は sendEmailBatch() を使う（Resend のバッチ送信で100件ずつ、送信上限に合わせて間隔を空ける）。
// 送信元（MAIL_FROM）・有効/無効（MAIL_ENABLED）は wrangler.jsonc の vars で環境ごとに設定する。
import { Resend } from 'resend'

export type MailEnv = {
  RESEND_API_KEY: string
  MAIL_FROM: string
  MAIL_ENABLED?: string // 'false' の場合は実送信せずログのみ（開発環境での誤送信防止）
  DB: D1Database
}

export type SendEmailInput = {
  to: string
  subject: string
  html: string
  text?: string
  type: string // ログ用の種別（例: 'password_reset' | 'notice'）
  company_id?: number | null
}

// skipped: MAIL_ENABLED='false' のため送らなかった（ok は true のまま。既存の呼び出し側の扱いを変えないため）
export type SendEmailResult = { ok: boolean; id?: string; error?: string; skipped?: boolean }

// Resend のバッチ送信の上限（1回100件）と、既定の送信上限（1秒あたり2リクエスト）に合わせた間隔
const BATCH_SIZE = 100
const REQUEST_INTERVAL_MS = 600
const MAX_ATTEMPTS = 3
const VALID_EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 0) return '***'
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`
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

  if (mode === 'disabled') {
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
      })
      if (error) {
        console.log(`resend send failed: type=${input.type} to=${maskEmail(input.to)} name=${error.name}`)
        result = { ok: false, error: 'resend_error' }
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
    const valid = inputs.map((_, k) => k).filter(k => VALID_EMAIL.test(inputs[k].to))
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const idx = valid.slice(i, i + BATCH_SIZE)
      const chunk = idx.map(k => inputs[k])
      if (i > 0) await sleep(REQUEST_INTERVAL_MS)
      let chunkResults: SendEmailResult[] | null = null
      let lastError = 'resend_error'
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chunkResults; attempt++) {
        try {
          const { data, error } = await resend.batch.send(
            chunk.map(m => ({ from: env.MAIL_FROM, to: m.to, subject: m.subject, html: m.html, text: m.text })),
            opts.idempotencyKey ? { idempotencyKey: `${opts.idempotencyKey}-${i / BATCH_SIZE}` } : undefined
          )
          if (error) {
            console.log(`resend batch failed: type=${chunk[0].type} size=${chunk.length} name=${error.name} attempt=${attempt}`)
            lastError = 'resend_error'
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
  await writeLogs(env, inputs.map((input, k) => ({ input, result: results[k] })))
  return results
}
