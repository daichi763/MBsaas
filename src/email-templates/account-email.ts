import { escapeHtml } from './_util'

// 管理者アカウントのメールアドレスを登録・変更したときの確認メール。
// 新しいアドレスには「このアドレスに通知が届くこと」を、以前のアドレスには「変更されたこと」を知らせる（心当たりがなければ連絡してもらう）
export function accountEmailChangedEmail(params: { name: string; companyName: string; userCode: string; newEmail: string; toOld: boolean }) {
  const { name, companyName, userCode, newEmail, toOld } = params
  const subject = toOld ? `メールアドレスが変更されました（${companyName}）` : `メールアドレスを登録しました（${companyName}）`
  const headline = toOld
    ? `アカウントのメールアドレスが ${newEmail} に変更されました。今後の通知とパスワード再設定のメールは新しいアドレスに届きます。`
    : 'このメールアドレスを Field OS のアカウントに登録しました。今後、承認依頼などの通知とパスワード再設定のメールがこのアドレスに届きます。'
  const account = `会社: ${companyName} / ID: ${userCode}`
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>${escapeHtml(headline)}</p>
      <p style="background:#f3f4f6;border-radius:8px;padding:8px 12px;">対象のアカウント: ${escapeHtml(account)}</p>
      <p style="color:#6b7280;font-size:13px;">心当たりがない場合は、すぐに所属の会社の担当者にお問い合わせください。</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#9ca3af;font-size:12px;">Field OS</p>
    </div>`
  const text = `${name} 様

${headline}
対象のアカウント: ${account}

心当たりがない場合は、すぐに所属の会社の担当者にお問い合わせください。

Field OS`
  return { subject, html, text }
}
