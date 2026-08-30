import { escapeHtml } from './_util'

export function noticeEmail(params: { name: string; title: string; body: string; url: string }) {
  const { name, title, body, url } = params
  const subject = `【Field OS】${title}`
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>新しいお知らせがあります。</p>
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:20px 0;">
        <p style="font-weight:bold;margin:0 0 8px;">${escapeHtml(title)}</p>
        <p style="white-space:pre-wrap;margin:0;color:#374151;">${escapeHtml(body)}</p>
      </div>
      <p style="margin: 24px 0;">
        <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold;">お知らせを確認する</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#9ca3af;font-size:12px;">Field OS</p>
    </div>`
  const text = `${name} 様

新しいお知らせがあります。

────────────
${title}
────────────

${body}

詳細はField OSからご確認ください。
${url}`
  return { subject, html, text }
}
