// =========================================================
// アプリ内通知・メール通知（打刻修正申請の申請・承認・却下）
// docs/spec_attendance_correction.md 5章
//
// 宛先:
//   申請・再申請 → 自社の管理者全員（管理ロール・在籍中。本部アカウントは含めない）＋ 申請者本人（受付の通知）
//   承認・却下   → 申請者本人 ＋ 処理した管理者。管理者が出した申請の承認は、記録が変わったスタッフ本人にも知らせる（#181）
//   取り消し     → シフトの削除・担当者の差し替えで自動で取り消した場合だけ申請者本人へ（本人の取り消しは通知しない）
//   承認・却下・取り消しの後は、その申請の承認依頼（correction_submitted）を全員分既読にする（#189）
// アプリ内通知は申請・承認の処理の後に登録し、メールはその後に送る（waitUntil）。
// メールの失敗で申請・承認は取り消さない。送信状態は notification_emails に残し、管理者が再送できる。本文は保存せず、再送時に申請データから作り直す。
// =========================================================
import { Hono } from 'hono'
import { sendEmail } from './services/email'
import { attendanceCorrectionEmail } from './email-templates/attendance-correction'
import { REPORT_LABEL } from './report-settings'
import { toCsv, csvResponse, loadLatestForCsv, csvLimitNote, csvLimitHeaders } from './csv'
import { shareableEmail } from './lib/tenant'
import { personStaffRows } from './roster'

export type NotifyEnv = { DB: D1Database; RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string }
type Variables = { user: any }
export type CorrectionEvent = 'submitted' | 'resubmitted' | 'approved' | 'rejected' | 'cancelled'
// 通知を受け取る管理ロール（本部 system_admin は各社の通知を受け取らない）
const NOTIFY_ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
const KIND_LABEL: Record<string, string> = { modify: '時刻修正', add: '打刻漏れの追加' }
// corrections.ts の CANCEL_REASON_LABEL と同じ（corrections.ts がこのファイルを読み込むため、ここでは複製する）
const CANCEL_REASON_LABEL: Record<string, string> = { shift_deleted: 'シフトが削除されたため', staff_changed: 'シフトの担当者が差し替えられたため' }

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
//       correction_changed_by_admin（管理者が出して承認した修正の、スタッフ本人への知らせ）/ correction_cancelled（自動で取り消した申請の申請者への知らせ）
function content(c: any, kind: string, isAdmin: boolean) {
  // シフトが削除された申請は稼働日が取れないので、申請の日時の日付を出す
  const what = `${fmtDate(c.work_date || c.requested_at)} ${REPORT_LABEL[c.report_type] || c.report_type}`
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
  } else if (kind === 'correction_changed_by_admin') {
    title = `管理者があなたの打刻を修正しました: ${what}`
    headline = '管理者が次のとおり、あなたの勤怠の記録を修正しました。内容に心当たりがない場合は、管理者に確認してください。'
    lines.push(['修正理由', c.reason || ''], ['処理した人', c.decided_by_name || ''])
    if (c.decision_comment) lines.push(['コメント', c.decision_comment])
  } else if (kind === 'correction_cancelled') {
    title = `打刻修正の申請が取り消されました: ${what}`
    headline = `${CANCEL_REASON_LABEL[c.cancel_reason] || '管理者の操作により'}、次の打刻修正の申請を取り消しました。勤怠の記録は変わっていません。`
    lines.push(['結果', '取り消し'])
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
  const user = async (id: number | null) => id ? await db.prepare('SELECT user_id, name, email, role, status, person_id FROM users WHERE user_id = ?').bind(id).first() as any : null
  const out = new Map<number, Recipient>()
  const add = (u: any, kind: string) => { if (u && u.status !== 'suspended' && !out.has(u.user_id)) out.set(u.user_id, { user_id: u.user_id, name: u.name, email: u.email || null, role: u.role, kind }) }
  const requester = await user(c.requested_by)
  if (event === 'submitted' || event === 'resubmitted') {
    add(requester, 'correction_received')
    const admins = (await db.prepare(`SELECT user_id, name, email, role, status FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(c.company_id, ...NOTIFY_ADMIN_ROLES).all()).results as any[]
    for (const a of admins) add(a, 'correction_submitted')
  } else if (event === 'cancelled') {
    // 本人の取り消しは誰にも送らない（承認依頼は notifyCorrection で既読にする）
    if (c.cancel_reason) add(requester, 'correction_cancelled')
  } else {
    add(requester, event === 'approved' ? 'correction_approved' : 'correction_rejected')
    add(await user(c.decided_by), 'correction_processed')
    // 管理者が出した申請を承認したときは、記録が変わったスタッフ本人にも知らせる（申請者と同じ人なら送らない。#181）
    if (event === 'approved') {
      const owner = await db.prepare(`SELECT us.user_id, us.name, us.email, us.role, us.status, us.person_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
        WHERE sp.staff_id = ? AND us.role = 'staff' AND us.status = 'active'`).bind(c.staff_id).first() as any
      const samePerson = owner && requester && (owner.user_id === requester.user_id || (owner.person_id && owner.person_id === requester.person_id))
      if (owner && !samePerson) add(owner, 'correction_changed_by_admin')
    }
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
  // 処理済み・取り消し済みの申請の承認依頼は送らない（再送も同じ。#189）
  else if (d.kind === 'correction_submitted' && c.status !== 'pending') result = { ok: false, error: 'already_processed' }
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

export async function markRequestNotificationsRead(db: D1Database, correctionId: number) {
  await db.prepare(`UPDATE user_notifications SET read_at = ? WHERE related_id = ? AND kind = 'correction_submitted' AND read_at IS NULL
    AND EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.correction_id = ? AND c.status != 'pending')`).bind(nowJST(), correctionId, correctionId).run()
}

// 申請・承認・却下・取り消しの後に呼ぶ。通知の失敗は申請・承認の結果に影響させない
export async function notifyCorrection(c: any, correctionId: number, event: CorrectionEvent) {
  try {
    // 処理済み・取り消し済みになった申請の承認依頼は、ほかの管理者の分も既読にする（#189）
    if (event !== 'submitted' && event !== 'resubmitted') await markRequestNotificationsRead(c.env.DB, correctionId)
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
// スタッフは同じ人のすべてのユーザーあての通知を出す（所属企業を切り替えても、申請の結果の通知が見える。#96）
// 管理者の承認依頼には、申請の今の状態（処理済みか）を添える（#189）
// =========================================================
function notificationRoutes(scope: 'admin' | 'staff') {
  const app = new Hono<{ Bindings: NotifyEnv; Variables: Variables }>()
  const userIds = async (c: any): Promise<number[]> => {
    const u = c.get('user')
    if (scope === 'admin') return [u.user_id]
    const ids = (await personStaffRows(c.env.DB, u)).map(r => r.user_id)
    return ids.includes(u.user_id) ? ids : [u.user_id, ...ids]
  }
  const inIds = (ids: number[]) => `user_id IN (${ids.map(() => '?').join(',')})`
  app.get('/notifications', async (c) => {
    const ids = await userIds(c)
    const rows = (await c.env.DB.prepare(`SELECT n.notification_id, n.kind, n.title, n.body, n.link, n.related_id, n.created_at, n.read_at,
        CASE WHEN n.kind = 'correction_submitted' THEN ac.status END AS correction_status, CASE WHEN n.kind = 'correction_submitted' THEN ac.decided_by_name END AS correction_decided_by
      FROM user_notifications n LEFT JOIN attendance_corrections ac ON n.kind = 'correction_submitted' AND ac.correction_id = n.related_id
      WHERE n.${inIds(ids)} ORDER BY n.notification_id DESC LIMIT 100`).bind(...ids).all()).results
    const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_notifications WHERE ${inIds(ids)} AND read_at IS NULL`).bind(...ids).first() as any
    return c.json({ notifications: rows, unread: n?.n || 0 })
  })
  app.get('/notifications/unread-count', async (c) => {
    const ids = await userIds(c)
    const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_notifications WHERE ${inIds(ids)} AND read_at IS NULL`).bind(...ids).first() as any
    return c.json({ count: n?.n || 0 })
  })
  app.post('/notifications/read-all', async (c) => {
    const ids = await userIds(c)
    const r = await c.env.DB.prepare(`UPDATE user_notifications SET read_at = ? WHERE ${inIds(ids)} AND read_at IS NULL`).bind(nowJST(), ...ids).run()
    return c.json({ ok: true, updated: r.meta.changes || 0 })
  })
  app.post('/notifications/:id{[0-9]+}/read', async (c) => {
    const ids = await userIds(c)
    const r = await c.env.DB.prepare(`UPDATE user_notifications SET read_at = COALESCE(read_at, ?) WHERE notification_id = ? AND ${inIds(ids)}`).bind(nowJST(), c.req.param('id'), ...ids).run()
    if (!r.meta.changes) return c.json({ error: '通知が見つかりません' }, 404)
    return c.json({ ok: true })
  })
  return app
}
export const notificationsStaffApi = notificationRoutes('staff')
export const notificationsAdminApi = notificationRoutes('admin')

// ---------- メール送信失敗の一覧・再送（管理者）----------
// 他社連携のスタッフが申請すると、宛先は所属元（他社）のユーザーになる。連携の同意ではメールを共有しないので、
// 一覧・CSV では自社に属さない宛先のアドレスを伏せる（再送は保存済みのアドレスへ送るので影響しない）
const shareableDelivery = (viewerCompanyId: number) => (r: any) => {
  const { recipient_company_id, ...rest } = r
  const hidden = !!r.to_email && recipient_company_id !== viewerCompanyId
  // 送信失敗の理由にアドレスが含まれる場合があるので、そこも伏せる
  const error = hidden && r.error ? String(r.error).split(r.to_email).join('（伏せています）') : r.error
  return { ...rest, to_email: shareableEmail(r.to_email, recipient_company_id, viewerCompanyId), to_email_hidden: hidden, error }
}
notificationsAdminApi.get('/notification-emails', async (c) => {
  const u = c.get('user')
  const status = ['failed', 'sent', 'pending'].includes(c.req.query('status') || '') ? c.req.query('status') : c.req.query('status') === 'all' ? null : 'failed'
  const rows = (await c.env.DB.prepare(`SELECT e.delivery_id, e.correction_id, e.event, e.kind, e.to_email, e.status, e.error, e.attempts, e.last_attempt_at, e.created_at,
      us.name AS recipient_name, us.company_id AS recipient_company_id, ub.name AS last_attempt_by_name, c.report_type, s.work_date, p.project_name, su.name AS staff_name
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ub ON ub.user_id = e.last_attempt_by
    LEFT JOIN attendance_corrections c ON c.correction_id = e.correction_id LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users su ON su.user_id = sp.user_id
    WHERE e.company_id = ? ${status ? 'AND e.status = ?' : ''} ORDER BY e.delivery_id DESC LIMIT 300`).bind(u.company_id, ...(status ? [status] : [])).all()).results as any[]
  const counts = (await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM notification_emails WHERE company_id = ? GROUP BY status').bind(u.company_id).all()).results as any[]
  return c.json({ deliveries: rows.map(shareableDelivery(u.company_id)), counts: Object.fromEntries(counts.map(r => [r.status, r.n])), labels: REPORT_LABEL })
})
notificationsAdminApi.get('/notification-emails/export', async (c) => {
  const u = c.get('user')
  const status = ['failed', 'sent', 'pending'].includes(c.req.query('status') || '') ? c.req.query('status') : null
  // 新しい順に上限まで取り、古い順に出す。上限を超えたら先頭に注記を入れる（#102）
  const where = `e.company_id = ? ${status ? 'AND e.status = ?' : ''}`
  const bind = [u.company_id, ...(status ? [status] : [])]
  const got = await loadLatestForCsv(c.env.DB, `SELECT e.*, us.name AS recipient_name, us.company_id AS recipient_company_id, ub.name AS last_attempt_by_name, c.report_type, s.work_date, su.name AS staff_name
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ub ON ub.user_id = e.last_attempt_by
    LEFT JOIN attendance_corrections c ON c.correction_id = e.correction_id LEFT JOIN shifts s ON s.shift_id = c.shift_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users su ON su.user_id = sp.user_id
    WHERE ${where} ORDER BY e.delivery_id DESC`, `SELECT COUNT(*) AS n FROM notification_emails e WHERE ${where}`, bind)
  const rows = got.rows.map(shareableDelivery(u.company_id)) as any[]
  const ST: Record<string, string> = { sent: '送信済み', failed: '送信失敗', pending: '送信中' }
  const EV: Record<string, string> = { submitted: '申請', resubmitted: '再申請', approved: '承認', rejected: '却下' }
  const csv = toCsv(['送信ID', '作成日時', '状態', '通知', '宛先', 'メールアドレス', '申請ID', 'スタッフ', '勤務日', '報告', '失敗の理由', '試行回数', '最終送信日時', '再送した人'],
    rows.map(r => [r.delivery_id, r.created_at, ST[r.status] || r.status, EV[r.event] || r.event, r.recipient_name, r.to_email, r.correction_id, r.staff_name, r.work_date,
      REPORT_LABEL[r.report_type] || r.report_type, r.error, r.attempts, r.last_attempt_at, r.last_attempt_by_name]), { note: csvLimitNote(got.total) })
  return csvResponse(`通知メールの送信状況_${nowJST().slice(0, 10)}.csv`, csv, csvLimitHeaders(got.total))
})
notificationsAdminApi.post('/notification-emails/:id{[0-9]+}/resend', async (c) => {
  const u = c.get('user')
  const d = await c.env.DB.prepare(`SELECT e.delivery_id, e.status, e.kind, us.status AS user_status, ac.status AS correction_status FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id
    LEFT JOIN attendance_corrections ac ON ac.correction_id = e.correction_id
    WHERE e.delivery_id = ? AND e.company_id = ?`).bind(c.req.param('id'), u.company_id).first() as any
  if (!d) return c.json({ error: '送信記録が見つかりません' }, 404)
  if (d.status === 'sent') return c.json({ error: 'このメールは送信済みです' }, 409)
  // 処理済み・取り消し済みの申請の承認依頼は送り直さない（#189）
  if (d.kind === 'correction_submitted' && d.correction_status !== 'pending') {
    await c.env.DB.prepare(`UPDATE notification_emails SET error = 'already_processed' WHERE delivery_id = ? AND status = 'failed'`).bind(d.delivery_id).run()
    return c.json({ error: '申請はすでに処理済み（または取り消し済み）のため、承認依頼は送り直しません', reason: 'already_processed' }, 409)
  }
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

// =========================================================
// 日報のインシデント・クレームの報告（#232）
// スタッフが日報でインシデント・クレームの印を新しく付けたら（更新で付けた場合も）、シフトの所有企業の管理者全員に
// アプリ内通知（kind=incident_reported）とメールで知らせる。リンク先は管理画面の日報一覧の該当日（インシデント・クレームのみ）。
// 送信状態の記録（notification_emails）は打刻修正の申請に結び付くため使わず、送信の結果は email_logs に残る。
// 通知の失敗で日報の提出は取り消さない。
// =========================================================
export type IncidentKind = 'incident' | 'complaint'
const INCIDENT_LABEL: Record<IncidentKind, string> = { incident: 'インシデント', complaint: 'クレーム' }
const INCIDENT_NOTE_PREVIEW = 500

export async function notifyDailyReportIncident(c: any, shiftId: number, raised: IncidentKind[]) {
  if (!raised.length) return
  try {
    const db: D1Database = c.env.DB
    const r = await db.prepare(`SELECT dr.daily_report_id, dr.company_id, dr.work_date, dr.report_values, p.project_name, us.name AS staff_name
      FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id
      LEFT JOIN staff_profiles sp ON sp.staff_id = dr.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
      WHERE dr.shift_id = ?`).bind(shiftId).first() as any
    if (!r) return
    let values: Record<string, unknown> = {}
    try { const v = JSON.parse(r.report_values || '{}'); if (v && typeof v === 'object') values = v } catch { values = {} }
    const kinds = raised.map(k => INCIDENT_LABEL[k]).join('・')
    const lines: [string, string][] = [['稼働日', fmtDate(r.work_date)], ['案件', r.project_name || ''], ['スタッフ', r.staff_name || '']]
    for (const k of raised) {
      const note = String(values[`${k}_note`] ?? '').trim()
      const short = note.length > INCIDENT_NOTE_PREVIEW ? note.slice(0, INCIDENT_NOTE_PREVIEW) + '…' : note
      lines.push([`${INCIDENT_LABEL[k]}の内容`, short || '（記入なし）'])
    }
    const title = `${kinds}の報告: ${r.staff_name || ''} ${fmtDate(r.work_date)} ${r.project_name || ''}`
    const headline = `スタッフの日報で${kinds}の報告がありました。内容を確認し、必要な対応をしてください。`
    const body = lines.map(([k, v]) => `${k}: ${v}`).join('\n')
    const link = `/admin#reports/date=${encodeURIComponent(r.work_date)}&flagged=1`
    const admins = (await db.prepare(`SELECT user_id, name, email FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(r.company_id, ...NOTIFY_ADMIN_ROLES).all()).results as any[]
    if (!admins.length) return
    const at = nowJST()
    const stmts: D1PreparedStatement[] = []
    // 1 文 100 バインドまで（1 行 8 個 → 10 行ずつ）
    for (let i = 0; i < admins.length; i += 10) {
      const chunk = admins.slice(i, i + 10)
      stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
        .bind(...chunk.flatMap(a => [r.company_id, a.user_id, 'incident_reported', title, body, link, r.daily_report_id, at])))
    }
    await db.batch(stmts)
    const base = String(c.env.APP_BASE_URL || '').replace(/\/+$/, '')
    const mails = admins.filter(a => a.email).map(a => {
      const tpl = attendanceCorrectionEmail({ name: a.name, headline, lines, url: base + link, button: '日報を確認する' })
      return { to: a.email as string, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'incident_report', company_id: r.company_id }
    })
    if (!mails.length) return
    const job = (async () => { for (const m of mails) { try { await sendEmail(c.env, m) } catch { /* 送信の失敗は email_logs に残る */ } } })()
    try { c.executionCtx.waitUntil(job) } catch { await job }
  } catch (e) {
    console.log(`incident notify failed: shift=${shiftId}`)
  }
}
