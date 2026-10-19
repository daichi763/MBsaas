import { escapeHtml } from './_util'

// 打刻修正申請の通知メール（申請・受付・承認・却下）。本文は受信者が閲覧できる範囲の情報のみ
// 件名は title（だれの・いつの・どの報告か。アプリ内通知のタイトルと同じ。#358）。title が無いときは headline。headline は本文の1行目に出す
export function attendanceCorrectionEmail(params: { name: string; title?: string; headline: string; lines: [string, string][]; url: string; button: string }) {
  const { name, title, headline, lines, url, button } = params
  const subject = `【Field OS】${title || headline}`
  const rows = lines.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:4px 0;white-space:pre-wrap;">${escapeHtml(v)}</td></tr>`).join('')
  const html = `
    <div style="font-family: -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif; line-height:1.7; color:#111827; max-width:480px; margin:0 auto;">
      <p>${escapeHtml(name)} 様</p>
      <p>${escapeHtml(headline)}</p>
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:20px 0;">
        <table style="border-collapse:collapse;font-size:14px;">${rows}</table>
      </div>
      <p style="margin: 24px 0;">
        <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold;">${escapeHtml(button)}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#9ca3af;font-size:12px;">Field OS</p>
    </div>`
  const text = `${name} 様

${headline}

────────────
${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}
────────────

詳細はField OSからご確認ください。
${url}`
  return { subject, html, text }
}
