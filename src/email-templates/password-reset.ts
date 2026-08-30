import { escapeHtml } from './_util'

export function passwordResetEmail(params: { name: string; resetUrl: string; expiresInHours: number }) {
  const { name, resetUrl, expiresInHours } = params
  const subject = 'パスワード再設定のご案内'
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>パスワード再設定のリクエストを受け付けました。</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold;">パスワードを再設定</a>
      </p>
      <p>このURLは${expiresInHours}時間有効です。</p>
      <p style="color:#6b7280;font-size:13px;">心当たりがない場合は、このメールを無視してください。</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#9ca3af;font-size:12px;">Field OS</p>
    </div>`
  const text = `${name} 様

パスワード再設定のリクエストを受け付けました。
以下のURLからパスワードを再設定してください。

${resetUrl}

このURLは${expiresInHours}時間有効です。
心当たりがない場合は、このメールを無視してください。

Field OS`
  return { subject, html, text }
}
