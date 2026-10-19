import { escapeHtml } from './_util'

// スタッフのログイン用メールアドレスの確認（#207）。管理者が登録・変更したアドレスに送り、本人がリンクを開いて確認したときだけ有効にする
export function loginEmailVerifyEmail(params: { name: string; companyName: string; companyCode: string; userCode: string; verifyUrl: string; expiresInHours: number }) {
  const { name, companyName, companyCode, userCode, verifyUrl, expiresInHours } = params
  const subject = `メールアドレスの確認のお願い（${companyName}）`
  const account = `会社: ${companyName} / 会社コード: ${companyCode} / スタッフ番号: ${userCode}`
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>所属の会社が、このメールアドレスを Field OS のログイン用のメールアドレスとして登録しようとしています。下のボタンから確認すると、パスワード再設定・打刻修正の結果・お知らせのメールがこのアドレスに届くようになります。</p>
      <p style="background:#f3f4f6;border-radius:8px;padding:8px 12px;">対象のアカウント: ${escapeHtml(account)}</p>
      <p style="margin: 24px 0;">
        <a href="${verifyUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold;">メールアドレスを確認する</a>
      </p>
      <p>このURLは${expiresInHours}時間有効です。</p>
      <p style="color:#6b7280;font-size:13px;">心当たりがない場合は、このメールを無視してください（確認しなければ登録されません）。</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#9ca3af;font-size:12px;">Field OS</p>
    </div>`
  const text = `${name} 様

所属の会社が、このメールアドレスを Field OS のログイン用のメールアドレスとして登録しようとしています。
以下のURLから確認すると、パスワード再設定・打刻修正の結果・お知らせのメールがこのアドレスに届くようになります。
対象のアカウント: ${account}

${verifyUrl}

このURLは${expiresInHours}時間有効です。
心当たりがない場合は、このメールを無視してください（確認しなければ登録されません）。

Field OS`
  return { subject, html, text }
}
