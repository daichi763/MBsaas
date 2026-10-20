import { escapeHtml } from './_util'

// お知らせメール。件名は「【会社名】［緊急］タイトル（案件名）」の形にし、どの会社・どの現場のお知らせかを分かるようにする（#367 #455）。
// ackUrl があれば「確認しました」のボタン（押すと既読になる）を付け、無ければアプリで押す必要があることを書く（#454）
const IMPORTANCE_MARK: Record<string, string> = { urgent: '［緊急］', important: '［重要］' }
const SUBJECT_PROJECTS_MAX = 30

export function noticeEmail(params: {
  name: string; title: string; body: string; url: string
  companyName?: string; importance?: string | null; projectNames?: string | null
  ackUrl?: string | null; contactEmail?: string | null; contactPhone?: string | null
  // ログインのない人あて（#281）。アプリを開くボタン・「確認しました」を付けず、問い合わせ先を案内する
  noApp?: boolean
}) {
  const { name, title, body, url, companyName, importance, projectNames, ackUrl, contactEmail, contactPhone, noApp } = params
  const from = companyName ? `【${companyName}】` : '【Field OS】'
  const mark = IMPORTANCE_MARK[String(importance || '')] || ''
  const projects = projectNames ? (projectNames.length > SUBJECT_PROJECTS_MAX ? projectNames.slice(0, SUBJECT_PROJECTS_MAX) + '…' : projectNames) : ''
  const subject = `${from}${mark}${title}${projects ? `（${projects}）` : ''}`
  const sender = companyName ? `${companyName}（Field OS から送信しています）` : 'Field OS'
  const contact = [contactPhone ? `電話: ${contactPhone}` : '', contactEmail ? `メール: ${contactEmail}（このメールへの返信も届きます）` : ''].filter(Boolean)
  const ackNote = noApp
    ? 'このお知らせはメールでお送りしています。ご不明な点は、下のお問い合わせ先へご連絡ください。'
    : ackUrl
    ? '内容を確認したら、下の「確認しました」を押してください（アプリで押した場合と同じく確認済みになります）。'
    : 'アプリでこのお知らせを開き、「確認しました」を押してください（押すまで未読のままです）。'
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;${primary ? 'background:#2563eb;color:#fff;' : 'background:#fff;color:#2563eb;border:1px solid #93c5fd;'}text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:bold;margin:4px 8px 4px 0;">${label}</a>`
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>${escapeHtml(companyName || 'Field OS')} から新しいお知らせがあります。</p>
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:20px 0;">
        <p style="font-weight:bold;margin:0 0 8px;">${mark ? `<span style="color:#dc2626;">${escapeHtml(mark)}</span>` : ''}${escapeHtml(title)}</p>
        <p style="white-space:pre-wrap;margin:0;color:#374151;">${escapeHtml(body)}</p>
      </div>
      <p style="font-size:14px;color:#374151;">${escapeHtml(ackNote)}</p>
      ${noApp ? '' : `<p style="margin: 16px 0 24px;">
        ${ackUrl ? button(ackUrl, '確認しました', true) + button(url, 'アプリで開く', false) : button(url, 'お知らせを開く', true)}
      </p>`}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#6b7280;font-size:12px;margin:0;">${escapeHtml(sender)}</p>
      ${contact.length ? `<p style="color:#6b7280;font-size:12px;margin:4px 0 0;">お問い合わせ: ${contact.map(escapeHtml).join(' / ')}</p>` : ''}
    </div>`
  const text = `${name} 様

${companyName || 'Field OS'} から新しいお知らせがあります。

────────────
${mark}${title}
────────────

${body}

${ackNote}
${noApp ? '' : ackUrl ? `確認しました: ${ackUrl}
アプリで開く: ${url}` : url}

--
${sender}${contact.length ? `
お問い合わせ: ${contact.join(' / ')}` : ''}`
  return { subject, html, text }
}
