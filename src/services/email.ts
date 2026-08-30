// 共通メール送信サービス。
// 「どんなメールを送るか」は各機能側が決め、「Resendをどう呼ぶか」はここに隠蔽する。
// 新しいメール種別（契約更新通知・スタッフ登録通知など）を追加する場合も、
// テンプレートを src/email-templates/ に追加し、この sendEmail() を呼ぶだけでよい。
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

export type SendEmailResult = { ok: boolean; id?: string; error?: string }

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 0) return '***'
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`
}

export async function sendEmail(env: MailEnv, input: SendEmailInput): Promise<SendEmailResult> {
  let result: SendEmailResult

  if (env.MAIL_ENABLED === 'false') {
    console.log(`mail disabled: skipped type=${input.type} to=${maskEmail(input.to)}`)
    result = { ok: true, id: 'skipped-disabled' }
  } else if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    // Secret未設定時は送信せず失敗として記録する（本文・APIキーはログに出さない）
    console.log(`mail not configured: type=${input.type}`)
    result = { ok: false, error: 'mail_not_configured' }
  } else {
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
        console.log(`resend send failed: type=${input.type} to=${maskEmail(input.to)}`)
        result = { ok: false, error: 'resend_error' }
      } else {
        result = { ok: true, id: data?.id }
      }
    } catch {
      console.log(`resend send exception: type=${input.type} to=${maskEmail(input.to)}`)
      result = { ok: false, error: 'network_error' }
    }
  }

  // ログ保存自体が失敗しても、メール送信の成否（呼び出し元への返り値）には影響させない
  try {
    await env.DB.prepare(
      `INSERT INTO email_logs (company_id, to_email, type, status, provider_message_id, error_message) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(input.company_id ?? null, input.to, input.type, result.ok ? 'sent' : 'failed', result.id ?? null, result.error ?? null).run()
  } catch {
    // ログ保存失敗は無視（メール送信結果を優先して返す）
  }

  return result
}
