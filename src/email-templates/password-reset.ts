import { escapeHtml } from './_util'

// 同じメールアドレスで複数の会社のアカウントを持つ人がいるため、会社名とIDを入れて、どのアカウントのリンクか分かるようにする。
// ログインには会社コードも要るため、会社コードも書く（本部ユーザーは会社コードなしでログインするので渡さない。#208）
export function passwordResetEmail(params: { name: string; resetUrl: string; expiresInHours: number; companyName?: string; userCode?: string; companyCode?: string }) {
  const { name, resetUrl, expiresInHours, companyName, userCode, companyCode } = params
  const subject = companyName ? `パスワード再設定のご案内（${companyName}）` : 'パスワード再設定のご案内'
  const account = [companyName ? `会社: ${companyName}` : '', companyCode ? `会社コード: ${companyCode}` : '', userCode ? `ID: ${userCode}` : ''].filter(Boolean).join(' / ')
  const after = `再設定の後は、${companyCode ? '上の会社コードと' : '上の'}IDと新しいパスワードでログインしてください。`
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>パスワード再設定のリクエストを受け付けました。</p>
      ${account ? `<p style="background:#f3f4f6;border-radius:8px;padding:8px 12px;">対象のアカウント: ${escapeHtml(account)}</p>` : ''}
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold;">パスワードを再設定</a>
      </p>
      <p>このURLは${expiresInHours}時間有効です。${account ? escapeHtml(after) : ''}</p>
      <p style="color:#6b7280;font-size:13px;">心当たりがない場合は、このメールを無視してください。ログインできない場合は、所属の会社の担当者にお問い合わせください。</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#9ca3af;font-size:12px;">Field OS</p>
    </div>`
  const text = `${name} 様

パスワード再設定のリクエストを受け付けました。
${account ? `対象のアカウント: ${account}\n` : ''}以下のURLからパスワードを再設定してください。

${resetUrl}

このURLは${expiresInHours}時間有効です。
${account ? after + '\n' : ''}心当たりがない場合は、このメールを無視してください。
ログインできない場合は、所属の会社の担当者にお問い合わせください。

Field OS`
  return { subject, html, text }
}
