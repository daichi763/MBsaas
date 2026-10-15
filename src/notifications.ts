// =========================================================
// アプリ内通知・メール通知（打刻修正申請の申請・承認・却下）
// docs/spec_attendance_correction.md 5章
//
// 宛先:
//   申請・再申請 → 自社の管理者全員（管理ロール・在籍中。本部アカウントは含めない）＋ 申請者本人（受付の通知）
//   承認・却下   → 申請者本人 ＋ 処理した管理者
// アプリ内通知は申請・承認の処理の後に登録し、メールはその後に送る（waitUntil）。
// メールの失敗で申請・承認は取り消さない。送信状態は notification_emails に残し、管理者が再送できる。本文は保存せず、再送時に申請データから作り直す。
// =========================================================
import { Hono } from 'hono'
import { sendEmail } from './services/email'
import { attendanceCorrectionEmail } from './email-templates/attendance-correction'
import { REPORT_LABEL } from './report-settings'
import { toCsv, csvResponse } from './csv'

export type NotifyEnv = { DB: D1Database; RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string }
type Variables = { user: any }
export type CorrectionEvent = 'submitted' | 'resubmitted' | 'approved' | 'rejected'
// 通知を受け取る管理ロール（本部 system_admin は各社の通知を受け取らない）
const NOTIFY_ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
const KIND_LABEL: Record<string, string> = { modify: '時刻修正', add: '打刻漏れの追加' }

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
const fmtAt = (at: string | null) => { const m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/); return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}` : '－' }
const fmtDate = (d: string | null) => { const m = String(d || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${Number(m[1])}/${Number(m[2])}` : '' }

async function loadInfo(db: D1Database, correctionId: number) {
  return db.prepare(`SELECT c.*, s.work_date, p.project_name, us.name AS staff_name
    FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id WHERE c.correction_id = ?`).bind(correctionId).first() as Promise<any>
}

// 受信者の立場（kind）ごとの文面。受信者が閲覧できる範囲の情報のみ
// kind: correction_submitted（管理者への承認依頼）/ correction_received（申請者への受付）/
//       correction_approved・correction_rejected（申請者への結果）/ correction_processed（処理した管理者への控え）
function content(c: any, kind: string, isAdmin: boolean) {
  const what = `${fmtDate(c.work_date)} ${REPORT_LABEL[c.report_type] || c.report_type}`
  const change = c.before_at ? `${fmtAt(c.before_at)} → ${fmtAt(c.requested_at)}` : `${fmtAt(c.requested_at)}（追加）`
  const lines: [string, string][] = [['案件', c.project_name || ''], ['スタッフ', c.staff_name || ''], ['報告', `${REPORT_LABEL[c.report_type] || ''}（${KIND_LABEL[c.kind] || ''}）`], ['対象日時', change]]
  let title = '', headline = ''
  if (kind === 'correction_submitted') {
    title = `打刻修正の承認依頼: ${c.staff_name || ''} ${what}`
    headline = c.resubmitted_from ? '打刻修正の再申請が届きました。内容を確認し、承認または却下してください。' : '打刻修正の申請が届きました。内容を確認し、承認または却下してください。'
    lines.push(['修正理由', c.reason || ''], ['申請者', c.requested_by_name || ''])
    if (c.order_warnings) lines.push(['注意', '報告の順序に矛盾があります（詳細は画面で確認してください）'])
  } else if (kind === 'correction_received') {
    title = `打刻修正を申請しました: ${what}`
    headline = '打刻修正の申請を受け付けました。承認されると勤怠の記録が変わります。'
    lines.push(['修正理由', c.reason || ''])
  } else if (kind === 'correction_approved') {
    title = `打刻修正が承認されました: ${what}`
    headline = '打刻修正の申請が承認され、勤怠の記録を変更しました。'
    lines.push(['結果', '承認'], ['承認者', c.decided_by_name || ''])
    if (c.decision_comment) lines.push(['コメント', c.decision_comment])
  } else if (kind === 'correction_rejected') {
    title = `打刻修正が却下されました: ${what}`
    headline = '打刻修正の申請が却下されました。理由を確認し、必要なら修正して再申請してください。'
    lines.push(['結果', '却下'], ['却下の理由', c.reject_reason || ''], ['処理した人', c.decided_by_name || ''])
    if (c.decision_comment) lines.push(['コメント', c.decision_comment])
  } else {
    const approved = c.status === 'approved'
    title = `打刻修正を${approved ? '承認' : '却下'}しました: ${c.staff_name || ''} ${what}`
    headline = `次の打刻修正の申請を${approved ? '承認' : '却下'}しました。`
    lines.push(['結果', approved ? (c.is_exception ? '承認（例外承認）' : '承認') : '却下'])
    if (!approved) lines.push(['却下の理由', c.reject_reason || ''])
    if (c.decision_comment) lines.push(['コメント', c.decision_comment])
  }
  const link = isAdmin ? `/admin#corrections/${c.correction_id}` : '/staff#attendance'
  const body = lines.map(([k, v]) => `${k}: ${v}`).join('\n')
  return { title, headline, lines, body, link, button: isAdmin ? '申請を確認する' : '打刻修正申請を確認する' }
}

type Recipient = { user_id: number; name: string; email: string | null; role: string; kind: string }
async function recipientsFor(db: D1Database, c: any, event: CorrectionEvent): Promise<Recipient[]> {
  const user = async (id: number | null) => id ? await db.prepare('SELECT user_id, name, email, role, status FROM users WHERE user_id = ?').bind(id).first() as any : null
  const out = new Map<number, Recipient>()
  const add = (u: any, kind: string) => { if (u && u.status !== 'suspended' && !out.has(u.user_id)) out.set(u.user_id, { user_id: u.user_id, name: u.name, email: u.email || null, role: u.role, kind }) }
  const requester = await user(c.requested_by)
  if (event === 'submitted' || event === 'resubmitted') {
    add(requester, 'correction_received')
    const admins = (await db.prepare(`SELECT user_id, name, email, role, status FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(c.company_id, ...NOTIFY_ADMIN_ROLES).all()).results as any[]
    for (const a of admins) add(a, 'correction_submitted')
  } else {
    add(requester, event === 'approved' ? 'correction_approved' : 'correction_rejected')
    add(await user(c.decided_by), 'correction_processed')
  }
  return [...out.values()]
}

// アプリ内通知を登録し、送るメールの送信状態（pending）を作る。戻り値の delivery_id を sendDeliveries で送る
export async function createCorrectionNotifications(db: D1Database, correctionId: number, event: CorrectionEvent) {
  const c = await loadInfo(db, correctionId)
  if (!c) return { notified: 0, deliveries: [] as number[] }
  const rcpts = await recipientsFor(db, c, event)
  const at = nowJST()
  const rows = rcpts.map(r => ({ r, m: content(c, r.kind, NOTIFY_ADMIN_ROLES.includes(r.role) || r.role === 'system_admin') }))
  const stmts: D1PreparedStatement[] = []
  // 1 文 100 バインドまで（1 行 8 個 → 10 行ずつ）
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10)
    stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...chunk.flatMap(({ r, m }) => [c.company_id, r.user_id, r.kind, m.title, m.body, m.link, c.correction_id, at])))
  }
  if (stmts.length) await db.batch(stmts)
  const deliveries: number[] = []
  for (const { r } of rows) {
    if (!r.email) continue
    const d = await db.prepare(`INSERT INTO notification_emails (company_id, correction_id, event, kind, user_id, to_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING delivery_id`)
      .bind(c.company_id, c.correction_id, event, r.kind, r.user_id, r.email, at).first() as any
    if (d) deliveries.push(d.delivery_id)
  }
  return { notified: rows.length, deliveries }
}

// 1 件送る（初回・再送共用）。成否を notification_emails に記録する（メールの失敗は例外にしない）
export async function sendDelivery(env: NotifyEnv, deliveryId: number, byUserId: number | null) {
  const db = env.DB
  const d = await db.prepare('SELECT * FROM notification_emails WHERE delivery_id = ?').bind(deliveryId).first() as any
  if (!d) return { ok: false, error: 'not_found' }
  const c = await loadInfo(db, d.correction_id)
  const u = await db.prepare('SELECT name, role, status FROM users WHERE user_id = ?').bind(d.user_id).first() as any
  let result: { ok: boolean; id?: string; error?: string }
  if (!c || !u) result = { ok: false, error: 'source_missing' }
  // 作成後に退職・停止・統合された宛先には送らない（再送も同じ。#260）
  else if (u.status !== 'active') result = { ok: false, error: 'recipient_suspended' }
  else {
    const m = content(c, d.kind, NOTIFY_ADMIN_ROLES.includes(u.role) || u.role === 'system_admin')
    const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '')
    const tpl = attendanceCorrectionEmail({ name: u.name, headline: m.headline, lines: m.lines, url: base + m.link, button: m.button })
    result = await sendEmail(env, { to: d.to_email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'attendance_correction', company_id: d.company_id })
  }
  await db.prepare(`UPDATE notification_emails SET status = ?, error = ?, provider_message_id = ?, attempts = attempts + 1, last_attempt_at = ?, last_attempt_by = ? WHERE delivery_id = ?`)
    .bind(result.ok ? 'sent' : 'failed', result.ok ? null : (result.error || 'unknown'), result.id ?? null, nowJST(), byUserId, deliveryId).run()
  return result
}
export async function sendDeliveries(env: NotifyEnv, ids: number[]) {
  for (const id of ids) { try { await sendDelivery(env, id, null) } catch { /* 送信状態の記録に失敗しても申請・承認は取り消さない */ } }
}

// 申請・承認・却下の後に呼ぶ。通知の失敗は申請・承認の結果に影響させない
export async function notifyCorrection(c: any, correctionId: number, event: CorrectionEvent) {
  try {
    const r = await createCorrectionNotifications(c.env.DB, correctionId, event)
    if (r.deliveries.length) {
      const job = sendDeliveries(c.env, r.deliveries)
      try { c.executionCtx.waitUntil(job) } catch { await job }
    }
  } catch (e) {
    console.log(`notify failed: correction=${correctionId} event=${event}`)
  }
}

// =========================================================
// アプリ内通知 API（本人あてのみ）。管理者は /api/admin/notifications、スタッフは /api/staff/notifications
// =========================================================
function notificationRoutes() {
  const app = new Hono<{ Bindings: NotifyEnv; Variables: Variables }>()
  app.get('/notifications', async (c) => {
    const u = c.get('user')
    const rows = (await c.env.DB.prepare('SELECT notification_id, kind, title, body, link, related_id, created_at, read_at FROM user_notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT 100').bind(u.user_id).all()).results
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND read_at IS NULL').bind(u.user_id).first() as any
    return c.json({ notifications: rows, unread: n?.n || 0 })
  })
  app.get('/notifications/unread-count', async (c) => {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND read_at IS NULL').bind(c.get('user').user_id).first() as any
    return c.json({ count: n?.n || 0 })
  })
  app.post('/notifications/read-all', async (c) => {
    const r = await c.env.DB.prepare('UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(nowJST(), c.get('user').user_id).run()
    return c.json({ ok: true, updated: r.meta.changes || 0 })
  })
  app.post('/notifications/:id{[0-9]+}/read', async (c) => {
    const r = await c.env.DB.prepare('UPDATE user_notifications SET read_at = COALESCE(read_at, ?) WHERE notification_id = ? AND user_id = ?').bind(nowJST(), c.req.param('id'), c.get('user').user_id).run()
    if (!r.meta.changes) return c.json({ error: '通知が見つかりません' }, 404)
    return c.json({ ok: true })
  })
  return app
}
export const notificationsStaffApi = notificationRoutes()
export const notificationsAdminApi = notificationRoutes()

// ---------- メール送信失敗の一覧・再送（管理者）----------
notificationsAdminApi.get('/notification-emails', async (c) => {
  const u = c.get('user')
  const status = ['failed', 'sent', 'pending'].includes(c.req.query('status') || '') ? c.req.query('status') : c.req.query('status') === 'all' ? null : 'failed'
  const rows = (await c.env.DB.prepare(`SELECT e.delivery_id, e.correction_id, e.event, e.kind, e.to_email, e.status, e.error, e.attempts, e.last_attempt_at, e.created_at,
      us.name AS recipient_name, ub.name AS last_attempt_by_name, c.report_type, s.work_date, p.project_name, su.name AS staff_name
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ub ON ub.user_id = e.last_attempt_by
    LEFT JOIN attendance_corrections c ON c.correction_id = e.correction_id LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users su ON su.user_id = sp.user_id
    WHERE e.company_id = ? ${status ? 'AND e.status = ?' : ''} ORDER BY e.delivery_id DESC LIMIT 300`).bind(u.company_id, ...(status ? [status] : [])).all()).results
  const counts = (await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM notification_emails WHERE company_id = ? GROUP BY status').bind(u.company_id).all()).results as any[]
  return c.json({ deliveries: rows, counts: Object.fromEntries(counts.map(r => [r.status, r.n])), labels: REPORT_LABEL })
})
notificationsAdminApi.get('/notification-emails/export', async (c) => {
  const u = c.get('user')
  const status = ['failed', 'sent', 'pending'].includes(c.req.query('status') || '') ? c.req.query('status') : null
  const rows = (await c.env.DB.prepare(`SELECT e.*, us.name AS recipient_name, ub.name AS last_attempt_by_name, c.report_type, s.work_date, su.name AS staff_name
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ub ON ub.user_id = e.last_attempt_by
    LEFT JOIN attendance_corrections c ON c.correction_id = e.correction_id LEFT JOIN shifts s ON s.shift_id = c.shift_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users su ON su.user_id = sp.user_id
    WHERE e.company_id = ? ${status ? 'AND e.status = ?' : ''} ORDER BY e.delivery_id LIMIT 10000`).bind(u.company_id, ...(status ? [status] : [])).all()).results as any[]
  const ST: Record<string, string> = { sent: '送信済み', failed: '送信失敗', pending: '送信中' }
  const EV: Record<string, string> = { submitted: '申請', resubmitted: '再申請', approved: '承認', rejected: '却下' }
  const csv = toCsv(['送信ID', '作成日時', '状態', '通知', '宛先', 'メールアドレス', '申請ID', 'スタッフ', '勤務日', '報告', '失敗の理由', '試行回数', '最終送信日時', '再送した人'],
    rows.map(r => [r.delivery_id, r.created_at, ST[r.status] || r.status, EV[r.event] || r.event, r.recipient_name, r.to_email, r.correction_id, r.staff_name, r.work_date,
      REPORT_LABEL[r.report_type] || r.report_type, r.error, r.attempts, r.last_attempt_at, r.last_attempt_by_name]))
  return csvResponse(`通知メールの送信状況_${nowJST().slice(0, 10)}.csv`, csv)
})
notificationsAdminApi.post('/notification-emails/:id{[0-9]+}/resend', async (c) => {
  const u = c.get('user')
  const d = await c.env.DB.prepare(`SELECT e.delivery_id, e.status, us.status AS user_status FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id
    WHERE e.delivery_id = ? AND e.company_id = ?`).bind(c.req.param('id'), u.company_id).first() as any
  if (!d) return c.json({ error: '送信記録が見つかりません' }, 404)
  if (d.status === 'sent') return c.json({ error: 'このメールは送信済みです' }, 409)
  // 退職・停止中の宛先には再送しない（#260）
  if (d.user_status !== 'active') {
    await c.env.DB.prepare(`UPDATE notification_emails SET error = 'recipient_suspended' WHERE delivery_id = ? AND status = 'failed'`).bind(d.delivery_id).run()
    return c.json({ error: '宛先のアカウントが停止中のため送信しません', reason: 'recipient_suspended' }, 409)
  }
  // 二重送信の防止: 失敗の行を「送信中」にできた場合だけ送る
  const claim = await c.env.DB.prepare(`UPDATE notification_emails SET status = 'pending' WHERE delivery_id = ? AND status = 'failed'`).bind(d.delivery_id).run()
  if (!claim.meta.changes) return c.json({ error: '送信中です。しばらくしてから一覧を確認してください' }, 409)
  const r = await sendDelivery(c.env, d.delivery_id, u.user_id)
  return c.json({ ok: true, sent: r.ok, error: r.ok ? null : r.error })
})
