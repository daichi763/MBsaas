// =========================================================
// アプリ内通知・メール通知（打刻修正申請の申請・承認・却下）
// docs/spec_attendance_correction.md 5章
//
// 宛先:
//   申請・再申請 → 自社の管理者全員（管理ロール・在籍中。本部アカウントは含めない）＋ 申請者本人（受付の控え。既読で登録し、メールは送らない #341）
//                  管理者が代わりに出した申請は、スタッフ本人にも未読で知らせる（メールは送らない）。
//                  まとめて出した申請の承認依頼メールは1通にまとめ、本人が取り消した直後の申請し直しはメールを送らない（#392）
//   承認・却下   → 申請者本人 ＋ 処理した管理者。管理者が出した申請の承認は、記録が変わったスタッフ本人にも知らせる（#181）
//   取り消し     → シフトの削除・担当者の差し替えで自動で取り消した場合だけ申請者本人へ（本人の取り消しは通知しない）
//   承認・却下・取り消しの後は、その申請の承認依頼（correction_submitted）を全員分既読にする（#189）
// アプリ内通知は申請・承認の処理の後に登録し、メールはその後に送る（waitUntil）。
// メールの失敗で申請・承認は取り消さない。送信状態は notification_emails に残し、管理者が再送できる。本文は保存せず、再送時に申請データから作り直す。
// =========================================================
import { Hono } from 'hono'
import { sendEmail, maskEmail, maskEmailsIn, normalizeAddress } from './services/email'
import { attendanceCorrectionEmail } from './email-templates/attendance-correction'
import { REPORT_LABEL } from './report-settings'
import { toCsv, csvResponse, loadLatestForCsv, csvLimitNote, csvLimitHeaders } from './csv'
import { shareableEmail, HIDDEN_EMAIL_LABEL } from './lib/tenant'
import { loadStaffNotices } from './lib/notices'
import { sha256Hex } from './lib/auth'
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
  const c = await db.prepare(`SELECT c.*, s.work_date, p.project_name, us.name AS staff_name
    FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id WHERE c.correction_id = ?`).bind(correctionId).first() as any
  if (!c) return c
  // まとめて出した申請（同じシフト・申請者・申請日時。corrections.ts の insertCorrections）。承認依頼のメールは先頭の1件にまとめる（#392 #214）
  const group = (await db.prepare(`SELECT correction_id, kind, report_type, before_at, requested_at FROM attendance_corrections
    WHERE shift_id = ? AND requested_by = ? AND created_at = ? ORDER BY correction_id`).bind(c.shift_id, c.requested_by, c.created_at).all()).results as any[]
  c.group = group.length > 1 ? group : null
  return c
}

// 受信者の立場（kind）ごとの文面。受信者が閲覧できる範囲の情報のみ
// kind: correction_submitted（管理者への承認依頼）/ correction_received（申請者への受付）/
//       correction_approved・correction_rejected（申請者への結果）/ correction_processed（処理した管理者への控え）
//       correction_changed_by_admin（管理者が出して承認した修正の、スタッフ本人への知らせ）/ correction_cancelled（自動で取り消した申請の申請者への知らせ）/
//       correction_proxy_submitted（管理者が代わりに出した申請の、スタッフ本人への知らせ。#341 #486）
// 承認待ちの承認依頼で、まとめて出した申請（c.group）は、まとめた内容を1通に書く（#214 #392）
function content(c: any, kind: string, isAdmin: boolean) {
  // シフトが削除された申請は稼働日が取れないので、申請の日時の日付を出す
  const what = `${fmtDate(c.work_date || c.requested_at)} ${REPORT_LABEL[c.report_type] || c.report_type}`
  const changeOf = (x: any) => x.before_at ? `${fmtAt(x.before_at)} → ${fmtAt(x.requested_at)}` : `${fmtAt(x.requested_at)}（追加）`
  const grouped = kind === 'correction_submitted' && c.group ? c.group as any[] : null
  const lines: [string, string][] = [['案件', c.project_name || ''], ['スタッフ', c.staff_name || '']]
  if (grouped) grouped.forEach((x, i) => lines.push([`報告${i + 1}`, `${REPORT_LABEL[x.report_type] || ''}（${KIND_LABEL[x.kind] || ''}） ${changeOf(x)}`]))
  else lines.push(['報告', `${REPORT_LABEL[c.report_type] || ''}（${KIND_LABEL[c.kind] || ''}）`], ['対象日時', changeOf(c)])
  // 精算が確定済みのシフトに反映した承認は、支払額が変わらないことを伝える（#215）
  const settledNote = '勤怠の記録は変更しましたが、精算が確定済みのため支払額は自動では変わりません。必要な対応は管理者が別途行います。'
  let title = '', headline = ''
  if (kind === 'correction_submitted') {
    title = `打刻修正の承認依頼: ${c.staff_name || ''} ${what}${grouped ? ` ほか${grouped.length - 1}件` : ''}`
    headline = grouped ? `打刻修正の申請が${grouped.length}件まとめて届きました。上から順に承認すると、途中で順序の矛盾が出ません。`
      : c.resubmitted_from ? '打刻修正の再申請が届きました。内容を確認し、承認または却下してください。' : '打刻修正の申請が届きました。内容を確認し、承認または却下してください。'
    lines.push(['修正理由', c.reason || ''], ['申請者', c.requested_by_name || ''])
    if (c.order_warnings) lines.push(['注意', '報告の順序に矛盾があります（詳細は画面で確認してください）'])
  } else if (kind === 'correction_received') {
    title = `打刻修正を申請しました: ${what}`
    headline = '打刻修正の申請を受け付けました。承認されると勤怠の記録が変わります。'
    lines.push(['修正理由', c.reason || ''])
  } else if (kind === 'correction_proxy_submitted') {
    title = `管理者があなたの打刻の修正を申請しました: ${what}`
    headline = '管理者が次のとおり、あなたの打刻の修正を申請しました。承認されると勤怠の記録が変わります。内容に心当たりがない場合は、管理者に確認してください。'
    lines.push(['修正理由', c.reason || ''], ['申請者', c.requested_by_name || ''])
  } else if (kind === 'correction_approved') {
    title = `打刻修正が承認されました: ${what}`
    headline = c.applied_while_settled ? `打刻修正の申請が承認されました。${settledNote}` : '打刻修正の申請が承認され、勤怠の記録を変更しました。'
    lines.push(['結果', '承認'], ['承認者', c.decided_by_name || ''])
    if (c.applied_while_settled) lines.push(['支払額', '確定済みのため変わりません（管理者が別途対応します）'])
    if (c.decision_comment) lines.push(['コメント', c.decision_comment])
  } else if (kind === 'correction_rejected') {
    title = `打刻修正が却下されました: ${what}`
    headline = '打刻修正の申請が却下されました。理由を確認し、必要なら修正して再申請してください。'
    lines.push(['結果', '却下'], ['却下の理由', c.reject_reason || ''], ['処理した人', c.decided_by_name || ''])
    if (c.decision_comment) lines.push(['コメント', c.decision_comment])
  } else if (kind === 'correction_changed_by_admin') {
    title = `管理者があなたの打刻を修正しました: ${what}`
    headline = '管理者が次のとおり、あなたの勤怠の記録を修正しました。内容に心当たりがない場合は、管理者に確認してください。' + (c.applied_while_settled ? settledNote : '')
    lines.push(['修正理由', c.reason || ''], ['処理した人', c.decided_by_name || ''])
    if (c.applied_while_settled) lines.push(['支払額', '確定済みのため変わりません（管理者が別途対応します）'])
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
  // スタッフは該当の申請を開く（staff.js の route が #attendance/request/:id を受ける。#306）
  const link = isAdmin ? `/admin#corrections/${c.correction_id}` : `/staff#attendance/request/${c.correction_id}`
  const body = lines.map(([k, v]) => `${k}: ${v}`).join('\n')
  return { title, headline, lines, body, link, button: isAdmin ? '申請を確認する' : '打刻修正申請を確認する' }
}

// read: 既読で登録する（自分の操作の控え）。noEmail: メールを送らない
type Recipient = { user_id: number; name: string; email: string | null; role: string; kind: string; read?: boolean; noEmail?: boolean }
// 本人が取り消してから、この時間内に同じ報告を申請し直したときは、管理者へのメールを送らない（アプリ内通知だけ。#392）
const RESUBMIT_QUIET_MINUTES = 30
async function recipientsFor(db: D1Database, c: any, event: CorrectionEvent): Promise<Recipient[]> {
  const user = async (id: number | null) => id ? await db.prepare('SELECT user_id, name, email, role, status, person_id FROM users WHERE user_id = ?').bind(id).first() as any : null
  const out = new Map<number, Recipient>()
  const add = (u: any, kind: string, opt: { read?: boolean; noEmail?: boolean } = {}) => {
    if (u && u.status !== 'suspended' && !out.has(u.user_id)) out.set(u.user_id, { user_id: u.user_id, name: u.name, email: u.email || null, role: u.role, kind, ...opt })
  }
  const requester = await user(c.requested_by)
  const owner = async () => await db.prepare(`SELECT us.user_id, us.name, us.email, us.role, us.status, us.person_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.staff_id = ? AND us.role = 'staff' AND us.status = 'active'`).bind(c.staff_id).first() as any
  const samePerson = (a: any, b: any) => !!a && !!b && (a.user_id === b.user_id || (!!a.person_id && a.person_id === b.person_id))
  if (event === 'submitted' || event === 'resubmitted') {
    // 自分で出した申請の受付は、既読の控えとして残すだけ（未読にしない・メールも送らない。受付は画面のトーストで伝える。#341）
    add(requester, 'correction_received', { read: true, noEmail: true })
    // 管理者が代わりに出した申請は、記録が変わるスタッフ本人に未読で知らせる（#341 #486）
    const o = await owner()
    if (o && !samePerson(o, requester)) add(o, 'correction_proxy_submitted', { noEmail: true })
    // まとめて出した申請の2件目以降と、本人が取り消した直後の同じ報告の申請し直しは、承認依頼のメールを送らない（#392）
    const lead = !c.group || c.group[0].correction_id === c.correction_id
    const since = new Date(Date.now() + 9 * 3600 * 1000 - RESUBMIT_QUIET_MINUTES * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const recentCancel = await db.prepare(`SELECT 1 FROM attendance_corrections WHERE shift_id = ? AND report_type = ? AND status = 'cancelled' AND cancel_reason IS NULL
      AND requested_by = ? AND cancelled_at >= ? AND correction_id < ? LIMIT 1`).bind(c.shift_id, c.report_type, c.requested_by, since, c.correction_id).first()
    const admins = (await db.prepare(`SELECT user_id, name, email, role, status FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(c.company_id, ...NOTIFY_ADMIN_ROLES).all()).results as any[]
    for (const a of admins) add(a, 'correction_submitted', { noEmail: !lead || !!recentCancel })
  } else if (event === 'cancelled') {
    // 本人の取り消しは誰にも送らない（承認依頼は notifyCorrection で既読にする）
    if (c.cancel_reason) add(requester, 'correction_cancelled')
  } else {
    add(requester, event === 'approved' ? 'correction_approved' : 'correction_rejected')
    add(await user(c.decided_by), 'correction_processed')
    // 管理者が出した申請を承認したときは、記録が変わったスタッフ本人にも知らせる（申請者と同じ人なら送らない。#181）
    if (event === 'approved') {
      const o = await owner()
      if (o && !samePerson(o, requester)) add(o, 'correction_changed_by_admin')
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
  // 1 文 100 バインドまで（1 行 9 個 → 10 行ずつ）
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10)
    stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at, read_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...chunk.flatMap(({ r, m }) => [c.company_id, r.user_id, r.kind, m.title, m.body, m.link, c.correction_id, at, r.read ? at : null])))
  }
  if (stmts.length) await db.batch(stmts)
  const deliveries: number[] = []
  for (const { r } of rows) {
    if (!r.email || r.noEmail) continue
    const d = await db.prepare(`INSERT INTO notification_emails (company_id, correction_id, event, kind, user_id, to_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING delivery_id`)
      .bind(c.company_id, c.correction_id, event, r.kind, r.user_id, r.email, at).first() as any
    if (d) deliveries.push(d.delivery_id)
  }
  return { notified: rows.length, deliveries }
}

// 1 件送る（初回・再送共用）。成否を notification_emails に記録する（メールの失敗は例外にしない）
// 宛先は送るときの users.email（不達で管理者がアドレスを直した後の再送は、直したアドレスへ届く。#541）。
// 宛先が他社のユーザー（連携スタッフの所属元）のときは、この会社の記録にアドレスを残さず、送信の記録（email_logs）も宛先の会社に残す（#570）
export async function sendDelivery(env: NotifyEnv, deliveryId: number, byUserId: number | null) {
  const db = env.DB
  const d = await db.prepare('SELECT * FROM notification_emails WHERE delivery_id = ?').bind(deliveryId).first() as any
  if (!d) return { ok: false, error: 'not_found', skipped: false }
  const c = await loadInfo(db, d.correction_id)
  const u = await db.prepare('SELECT name, role, status, email, company_id FROM users WHERE user_id = ?').bind(d.user_id).first() as any
  const to = String(u?.email || '').trim()
  let result: { ok: boolean; id?: string; error?: string }
  let skip = false
  if (!c || !u) result = { ok: false, error: 'source_missing' }
  // 作成後に退職・停止・統合された宛先には送らない（再送も同じ。#260）
  else if (u.status !== 'active') { result = { ok: false, error: 'recipient_suspended' }; skip = true }
  // 処理済み・取り消し済みの申請の承認依頼は送らない（再送も同じ。#189 #357）
  else if (d.kind === 'correction_submitted' && c.status !== 'pending') { result = { ok: false, error: 'already_processed' }; skip = true }
  else if (!to) result = { ok: false, error: 'no_address' }
  else {
    const m = content(c, d.kind, NOTIFY_ADMIN_ROLES.includes(u.role) || u.role === 'system_admin')
    const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '')
    const tpl = attendanceCorrectionEmail({ name: u.name, title: m.title, headline: m.headline, lines: m.lines, url: base + m.link, button: m.button })
    result = await sendEmail(env, { to, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'attendance_correction', company_id: u.company_id ?? d.company_id })
  }
  const otherCompany = u && u.company_id !== d.company_id
  const toEmail = otherCompany ? '' : (to || d.to_email)
  const error = result.ok ? null : maskEmailsIn(result.error || 'unknown')
  // 送る必要がなくなったもの（処理済みの承認依頼・停止中の宛先）は「対応不要」（skipped）にし、送信失敗の件数から外す
  await db.prepare(`UPDATE notification_emails SET status = ?, error = ?, provider_message_id = ?, to_email = ?, attempts = attempts + 1, last_attempt_at = ?, last_attempt_by = ? WHERE delivery_id = ?`)
    .bind(result.ok ? 'sent' : skip ? 'skipped' : 'failed', error, result.id ?? null, toEmail, nowJST(), byUserId, deliveryId).run()
  return { ...result, error: error ?? undefined, skipped: skip }
}
export async function sendDeliveries(env: NotifyEnv, ids: number[]) {
  for (const id of ids) { try { await sendDelivery(env, id, null) } catch { /* 送信状態の記録に失敗しても申請・承認は取り消さない */ } }
}

// 『送信中』のまま止まったとみなす時間（#311）。送信は応答の後に順に行うので、通常は数十秒で終わる
export const STALLED_PENDING_MINUTES = 10
const minutesAgoJST = (m: number) => new Date(Date.now() + 9 * 3600 * 1000 - m * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
// 再送できる行の条件: 送信失敗か、送信中のまま止まった行
const RESENDABLE_SQL = `(e.status = 'failed' OR (e.status = 'pending' AND COALESCE(e.last_attempt_at, e.created_at) < ?))`

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
  // 絞り込み（#380）: unread=1 で未読だけ、kind で種類、before（notification_id）で続きを取る。limit は 1〜100（既定 100）
  app.get('/notifications', async (c) => {
    const ids = await userIds(c)
    const q = (k: string) => c.req.query(k) || ''
    const limit = Math.min(100, Math.max(1, Number.parseInt(q('limit'), 10) || 100))
    const where = [`n.${inIds(ids)}`]
    const binds: any[] = [...ids]
    if (q('unread') === '1') where.push('n.read_at IS NULL')
    if (/^[a-z_]{1,40}$/.test(q('kind'))) { where.push('n.kind = ?'); binds.push(q('kind')) }
    if (/^\d{1,12}$/.test(q('before'))) { where.push('n.notification_id < ?'); binds.push(Number(q('before'))) }
    const rows = (await c.env.DB.prepare(`SELECT n.notification_id, n.kind, n.title, n.body, n.link, n.related_id, n.created_at, n.read_at,
        CASE WHEN n.kind = 'correction_submitted' THEN ac.status END AS correction_status, CASE WHEN n.kind = 'correction_submitted' THEN ac.decided_by_name END AS correction_decided_by
      FROM user_notifications n LEFT JOIN attendance_corrections ac ON n.kind = 'correction_submitted' AND ac.correction_id = n.related_id
      WHERE ${where.join(' AND ')} ORDER BY n.notification_id DESC LIMIT ?`).bind(...binds, limit + 1).all()).results as any[]
    // 未読の件数は全体と種類ごと（受信箱の切り替えに件数を出す）
    const byKind = (await c.env.DB.prepare(`SELECT kind, COUNT(*) AS n FROM user_notifications WHERE ${inIds(ids)} AND read_at IS NULL GROUP BY kind`).bind(...ids).all()).results as any[]
    const unread = byKind.reduce((a, r) => a + Number(r.n), 0)
    return c.json({ notifications: rows.slice(0, limit), has_more: rows.length > limit, unread, unread_by_kind: Object.fromEntries(byKind.map(r => [r.kind, r.n])) })
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
  // kind（と related_id）で既読にする（募集の応募一覧を開いたときなど、通知を開かずに対応したとき。#150）
  app.post('/notifications/read-related', async (c) => {
    const ids = await userIds(c)
    const b = await c.req.json().catch(() => ({} as any))
    const kind = String(b.kind || '')
    if (!/^[a-z_]{1,40}$/.test(kind)) return c.json({ error: '種類が正しくありません' }, 400)
    const rid = Number.isInteger(b.related_id) && b.related_id > 0 ? b.related_id : null
    const r = await c.env.DB.prepare(`UPDATE user_notifications SET read_at = ? WHERE ${inIds(ids)} AND kind = ? AND read_at IS NULL${rid != null ? ' AND related_id = ?' : ''}`)
      .bind(nowJST(), ...ids, kind, ...(rid != null ? [rid] : [])).run()
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
  const hidden = recipient_company_id != null && recipient_company_id !== viewerCompanyId
  // 送信失敗の理由にアドレスが含まれる場合があるので、そこも伏せる（送信サービスの文言は保存の前にも伏せている）
  let error = r.error ? String(r.error) : r.error
  if (hidden && error && r.to_email) error = error.split(r.to_email).join('（伏せています）')
  if (hidden && error) error = maskEmailsIn(error)
  return { ...rest, to_email: hidden ? HIDDEN_EMAIL_LABEL : shareableEmail(r.to_email, recipient_company_id, viewerCompanyId), to_email_hidden: hidden, error }
}
const EMAIL_PAGE = 100
const EMAIL_STATUSES = ['failed', 'sent', 'pending', 'skipped']
notificationsAdminApi.get('/notification-emails', async (c) => {
  const u = c.get('user')
  const q = c.req.query('status') || ''
  const status = EMAIL_STATUSES.includes(q) || q === 'stalled' ? q : q === 'all' ? null : 'failed'
  const stalledAt = minutesAgoJST(STALLED_PENDING_MINUTES)
  const where = ['e.company_id = ?']
  const binds: any[] = [u.company_id]
  if (status === 'stalled') { where.push(`e.status = 'pending' AND COALESCE(e.last_attempt_at, e.created_at) < ?`); binds.push(stalledAt) }
  else if (status) { where.push('e.status = ?'); binds.push(status) }
  // ページ送り（#444。古い失敗も一覧から追えるように）
  const before = c.req.query('before') || ''
  if (/^\d{1,12}$/.test(before)) { where.push('e.delivery_id < ?'); binds.push(Number(before)) }
  const rows = (await c.env.DB.prepare(`SELECT e.delivery_id, e.correction_id, e.event, e.kind, e.to_email, e.status, e.error, e.attempts, e.last_attempt_at, e.created_at,
      (e.status = 'pending' AND COALESCE(e.last_attempt_at, e.created_at) < ?) AS stalled,
      us.name AS recipient_name, us.company_id AS recipient_company_id, ub.name AS last_attempt_by_name, c.report_type, c.status AS correction_status, s.work_date, p.project_name, su.name AS staff_name
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ub ON ub.user_id = e.last_attempt_by
    LEFT JOIN attendance_corrections c ON c.correction_id = e.correction_id LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users su ON su.user_id = sp.user_id
    WHERE ${where.join(' AND ')} ORDER BY e.delivery_id DESC LIMIT ?`).bind(stalledAt, ...binds, EMAIL_PAGE + 1).all()).results as any[]
  const counts = (await c.env.DB.prepare(`SELECT status, COUNT(*) AS n, SUM(status = 'pending' AND COALESCE(last_attempt_at, created_at) < ?) AS stalled
    FROM notification_emails WHERE company_id = ? GROUP BY status`).bind(stalledAt, u.company_id).all()).results as any[]
  const countMap: Record<string, number> = Object.fromEntries(counts.map(r => [r.status, r.n]))
  countMap.stalled = counts.reduce((a, r) => a + Number(r.stalled || 0), 0)
  // まとめて再送の対象の件数（送信失敗＋止まった送信中）
  countMap.resendable = (countMap.failed || 0) + countMap.stalled
  return c.json({ deliveries: rows.slice(0, EMAIL_PAGE).map(shareableDelivery(u.company_id)), has_more: rows.length > EMAIL_PAGE,
    counts: countMap, stalled_minutes: STALLED_PENDING_MINUTES, labels: REPORT_LABEL })
})
notificationsAdminApi.get('/notification-emails/export', async (c) => {
  const u = c.get('user')
  const status = EMAIL_STATUSES.includes(c.req.query('status') || '') ? c.req.query('status') : null
  // 新しい順に上限まで取り、古い順に出す。上限を超えたら先頭に注記を入れる（#102）
  const where = `e.company_id = ? ${status ? 'AND e.status = ?' : ''}`
  const bind = [u.company_id, ...(status ? [status] : [])]
  const got = await loadLatestForCsv(c.env.DB, `SELECT e.*, us.name AS recipient_name, us.company_id AS recipient_company_id, ub.name AS last_attempt_by_name, c.report_type, s.work_date, su.name AS staff_name
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ub ON ub.user_id = e.last_attempt_by
    LEFT JOIN attendance_corrections c ON c.correction_id = e.correction_id LEFT JOIN shifts s ON s.shift_id = c.shift_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users su ON su.user_id = sp.user_id
    WHERE ${where} ORDER BY e.delivery_id DESC`, `SELECT COUNT(*) AS n FROM notification_emails e WHERE ${where}`, bind)
  const rows = got.rows.map(shareableDelivery(u.company_id)) as any[]
  const ST: Record<string, string> = { sent: '送信済み', failed: '送信失敗', pending: '送信中', skipped: '対応不要' }
  const EV: Record<string, string> = { submitted: '申請', resubmitted: '再申請', approved: '承認', rejected: '却下', cancelled: '取り消し' }
  const csv = toCsv(['送信ID', '作成日時', '状態', '通知', '宛先', 'メールアドレス', '申請ID', 'スタッフ', '勤務日', '報告', '失敗の理由', '試行回数', '最終送信日時', '再送した人'],
    rows.map(r => [r.delivery_id, r.created_at, ST[r.status] || r.status, EV[r.event] || r.event, r.recipient_name, r.to_email, r.correction_id, r.staff_name, r.work_date,
      REPORT_LABEL[r.report_type] || r.report_type, r.error, r.attempts, r.last_attempt_at, r.last_attempt_by_name]), { note: csvLimitNote(got.total) })
  return csvResponse(`通知メールの送信状況_${nowJST().slice(0, 10)}.csv`, csv, csvLimitHeaders(got.total))
})
// 送る必要がなくなった行（処理済み・取り消し済みの申請の承認依頼、停止中の宛先）を「対応不要」（skipped）にする（#357）。
// 戻り値は対応不要にした件数。deliveryId を渡すとその1行だけ
async function skipUnneeded(db: D1Database, companyId: number, stalledAt: string, deliveryId?: number) {
  const r = await db.prepare(`UPDATE notification_emails AS e SET status = 'skipped',
      error = CASE WHEN e.kind = 'correction_submitted' AND COALESCE((SELECT ac.status FROM attendance_corrections ac WHERE ac.correction_id = e.correction_id), '') != 'pending'
        THEN 'already_processed' ELSE 'recipient_suspended' END
    WHERE e.company_id = ? ${deliveryId ? 'AND e.delivery_id = ?' : ''} AND ${RESENDABLE_SQL}
      AND ((e.kind = 'correction_submitted' AND COALESCE((SELECT ac.status FROM attendance_corrections ac WHERE ac.correction_id = e.correction_id), '') != 'pending')
        OR COALESCE((SELECT us.status FROM users us WHERE us.user_id = e.user_id), '') != 'active')`)
    .bind(companyId, ...(deliveryId ? [deliveryId] : []), stalledAt).run()
  return r.meta.changes || 0
}
// 二重送信の防止: 送信失敗か止まった送信中の行を「送信中」にできた場合だけ送る（#311。止まった行は last_attempt_at を今にして、同時の再送を1回にする）
async function claimForResend(db: D1Database, companyId: number, deliveryId: number, stalledAt: string) {
  const r = await db.prepare(`UPDATE notification_emails AS e SET status = 'pending', last_attempt_at = ? WHERE e.delivery_id = ? AND e.company_id = ? AND ${RESENDABLE_SQL}`)
    .bind(nowJST(), deliveryId, companyId, stalledAt).run()
  return !!r.meta.changes
}

notificationsAdminApi.post('/notification-emails/:id{[0-9]+}/resend', async (c) => {
  const u = c.get('user')
  const db = c.env.DB
  const stalledAt = minutesAgoJST(STALLED_PENDING_MINUTES)
  const d = await db.prepare(`SELECT e.delivery_id, e.status, e.kind, ${RESENDABLE_SQL} AS resendable, us.status AS user_status, ac.status AS correction_status
    FROM notification_emails e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN attendance_corrections ac ON ac.correction_id = e.correction_id
    WHERE e.delivery_id = ? AND e.company_id = ?`).bind(stalledAt, c.req.param('id'), u.company_id).first() as any
  if (!d) return c.json({ error: '送信記録が見つかりません' }, 404)
  if (d.status === 'sent') return c.json({ error: 'このメールは送信済みです' }, 409)
  // 処理済み・取り消し済みの申請の承認依頼は送り直さない（#189 #357）
  if (d.kind === 'correction_submitted' && d.correction_status !== 'pending') {
    await skipUnneeded(db, u.company_id, stalledAt, d.delivery_id)
    return c.json({ error: '申請はすでに処理済み（または取り消し済み）のため、承認依頼は送り直しません（対応不要にしました）', reason: 'already_processed' }, 409)
  }
  // 退職・停止中の宛先には再送しない（#260）
  if (d.user_status !== 'active') {
    await skipUnneeded(db, u.company_id, stalledAt, d.delivery_id)
    return c.json({ error: '宛先のアカウントが停止中のため送信しません（対応不要にしました）', reason: 'recipient_suspended' }, 409)
  }
  if (d.status === 'skipped') return c.json({ error: 'このメールは対応不要です' }, 409)
  if (!d.resendable || !(await claimForResend(db, u.company_id, d.delivery_id, stalledAt))) {
    return c.json({ error: `送信中です。${STALLED_PENDING_MINUTES}分たっても送信中のままなら、再送できます` }, 409)
  }
  const r = await sendDelivery(c.env, d.delivery_id, u.user_id)
  return c.json({ ok: true, sent: r.ok, error: r.ok ? null : r.error })
})

// 送信失敗（と止まった送信中）をまとめて再送する（#444 #311）。1回に RESEND_BULK_LIMIT 件まで古い順に送る。
// after（前回の next_after）より後の行だけを送るので、また失敗した行を同じ操作の中で繰り返し送らない。done になるまで画面が続けて呼ぶ。
// 送る必要がなくなった行は先に「対応不要」にする（#357）
const RESEND_BULK_LIMIT = 20
notificationsAdminApi.post('/notification-emails/resend-failed', async (c) => {
  const u = c.get('user')
  const db = c.env.DB
  const stalledAt = minutesAgoJST(STALLED_PENDING_MINUTES)
  const b = await c.req.json().catch(() => ({} as any))
  const after = Number.isInteger(b.after) && b.after > 0 ? b.after : 0
  const skipped = await skipUnneeded(db, u.company_id, stalledAt)
  const targets = (await db.prepare(`SELECT e.delivery_id FROM notification_emails e WHERE e.company_id = ? AND e.delivery_id > ? AND ${RESENDABLE_SQL} ORDER BY e.delivery_id LIMIT ?`)
    .bind(u.company_id, after, stalledAt, RESEND_BULK_LIMIT).all()).results as any[]
  let sent = 0, failed = 0, busy = 0
  const reasons: Record<string, number> = {}
  for (const t of targets) {
    if (!(await claimForResend(db, u.company_id, t.delivery_id, stalledAt))) { busy++; continue }
    try {
      const r = await sendDelivery(c.env, t.delivery_id, u.user_id)
      if (r.ok) sent++
      else if (!r.skipped) { failed++; const k = String(r.error || 'unknown').split(':')[0]; reasons[k] = (reasons[k] || 0) + 1 }
    } catch {
      failed++
      await db.prepare(`UPDATE notification_emails SET status = 'failed', error = 'internal_error' WHERE delivery_id = ? AND status = 'pending'`).bind(t.delivery_id).run()
    }
  }
  const nextAfter = targets.length ? targets[targets.length - 1].delivery_id : after
  const rest = await db.prepare(`SELECT COUNT(*) AS n FROM notification_emails e WHERE e.company_id = ? AND e.delivery_id > ? AND ${RESENDABLE_SQL}`).bind(u.company_id, nextAfter, stalledAt).first() as any
  const remaining = Number(rest?.n || 0)
  return c.json({ ok: true, sent, failed, skipped, busy, reasons, next_after: nextAfter, remaining, done: remaining === 0 })
})

// =========================================================
// 管理者の代理入力（#327）
// 管理者がスタッフの勤怠を代理入力したら、そのスタッフ本人（在籍中のスタッフのユーザー）にアプリ内通知（kind=attendance_proxy）で知らせる。
// 通知から打刻履歴を開き、時刻が違えば打刻修正を申請できる。メールは送らない。通知の失敗で代理入力は取り消さない。
// =========================================================
export const ATTENDANCE_PROXY_KIND = 'attendance_proxy'
export async function notifyProxyAttendance(db: D1Database, shift: { shift_id: number; company_id: number; staff_id: number; work_date: string },
  rows: { report_type: string; reported_at: string }[], actorName: string) {
  if (!rows.length) return
  try {
    const owner = await db.prepare(`SELECT us.user_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
      WHERE sp.staff_id = ? AND us.role = 'staff' AND us.status = 'active'`).bind(shift.staff_id).first() as any
    if (!owner) return
    const title = `管理者があなたの勤怠を記録しました: ${fmtDate(shift.work_date)} ${rows.map(r => REPORT_LABEL[r.report_type] || r.report_type).join('・')}`
    const body = [...rows.map(r => `${REPORT_LABEL[r.report_type] || r.report_type}: ${fmtAt(r.reported_at)}`), `記録した人: ${actorName || '管理者'}`,
      '時刻が違う場合は、打刻履歴から修正を申請してください'].join('\n')
    await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(shift.company_id, owner.user_id, ATTENDANCE_PROXY_KIND, title, body, '#attendance', shift.shift_id, nowJST()).run()
  } catch (e) {
    console.log(`proxy notify failed: shift=${shift.shift_id}`)
  }
}

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

// =========================================================
// 管理者・企業あての通知（w5-notify-admin: #150 #152 #154 #166）
// 宛先の会社の管理ロール（在籍中。本部アカウントは含めない）全員に、アプリ内通知を作り、必要ならメールも送る。
//   kind: recruit_applied（新しい応募。related_id = 募集ページ）/ board_message（案件掲示板のやり取り。related_id = スレッド）/
//         roster_chat（企業間チャット。related_id = スレッドの連携行の staff_id）/
//         consult_received（スタッフからの相談。related_id = 相談）/ consult_message（相談への追加の連絡。related_id = 相談）/
//         roster_source_retired（連携スタッフの所属元での退職。related_id = 自社の連携行の staff_id）
// merge: 同じ kind・related_id の未読の通知があれば、新しい行を作らずに最新の内容に書き換えて件数（merged_count）を数える
// email: always（毎回送る）/ throttle（まとめた通知のメールを送ってから ADMIN_MAIL_QUIET_MINUTES の間は送らない）/ never
// メールの結果は email_logs に残る（notification_emails は打刻修正の申請に結び付くため使わない）。通知の失敗で元の操作は取り消さない
// =========================================================
export const ADMIN_MAIL_QUIET_MINUTES = 30
export type AdminNotice = {
  companyId: number
  kind: string
  relatedId: number
  // count: まとめた件数（1 なら新しい通知）
  title: (count: number) => string
  headline: string
  lines: [string, string][]
  link: string
  button: string
  mailType: string
  email: 'always' | 'throttle' | 'never'
  merge?: boolean
  excludeUserIds?: number[]
  // アプリ内通知の本文だけに足す内容（メールには入れない。相談の本文など）
  appExtra?: string
}
export async function notifyCompanyAdmins(c: any, n: AdminNotice): Promise<{ notified: number; emailed: number }> {
  try {
    const db: D1Database = c.env.DB
    const exclude = new Set((n.excludeUserIds || []).map(Number))
    const admins = ((await db.prepare(`SELECT user_id, name, email FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(n.companyId, ...NOTIFY_ADMIN_ROLES).all()).results as any[]).filter(a => !exclude.has(Number(a.user_id)))
    if (!admins.length) return { notified: 0, emailed: 0 }
    const now = nowJST()
    const quietSince = minutesAgoJST(ADMIN_MAIL_QUIET_MINUTES)
    // まとめる先: 宛先ごとの、同じ kind・related_id の未読の最新の通知
    const open = new Map<number, any>()
    if (n.merge) {
      const rows = (await db.prepare(`SELECT notification_id, user_id, merged_count, emailed_at FROM user_notifications
        WHERE company_id = ? AND kind = ? AND related_id = ? AND read_at IS NULL ORDER BY notification_id`).bind(n.companyId, n.kind, n.relatedId).all()).results as any[]
      for (const r of rows) open.set(Number(r.user_id), r)
    }
    const body = n.lines.map(([k, v]) => `${k}: ${v}`).join('\n') + (n.appExtra ? '\n' + n.appExtra : '')
    const stmts: D1PreparedStatement[] = []
    const mailTo: { name: string; email: string; title: string }[] = []
    for (const a of admins) {
      const cur = open.get(Number(a.user_id))
      const count = cur ? Number(cur.merged_count || 1) + 1 : 1
      const title = n.title(count)
      const sendMail = !!a.email && (n.email === 'always' || (n.email === 'throttle' && (!cur || !cur.emailed_at || cur.emailed_at < quietSince)))
      if (sendMail) mailTo.push({ name: a.name, email: a.email, title })
      // まとめるときは前の未読の行を消して新しく入れ直す（受信箱は新しい順なので、まとめた通知を先頭に出す）
      if (cur) stmts.push(db.prepare('DELETE FROM user_notifications WHERE notification_id = ? AND read_at IS NULL').bind(cur.notification_id))
      stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at, merged_count, emailed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(n.companyId, a.user_id, n.kind, title, body, n.link, n.relatedId, now, count, sendMail ? now : (cur?.emailed_at ?? null)))
    }
    await db.batch(stmts)
    if (mailTo.length) {
      const base = String(c.env.APP_BASE_URL || '').replace(/\/+$/, '')
      const mails = mailTo.map(m => {
        const tpl = attendanceCorrectionEmail({ name: m.name, title: m.title, headline: n.headline, lines: n.lines, url: base + n.link, button: n.button })
        return { to: m.email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: n.mailType, company_id: n.companyId }
      })
      const job = (async () => { for (const m of mails) { try { await sendEmail(c.env, m) } catch { /* 送信の失敗は email_logs に残る */ } } })()
      try { c.executionCtx.waitUntil(job) } catch { await job }
    }
    return { notified: admins.length, emailed: mailTo.length }
  } catch (e) {
    console.log(`admin notify failed: kind=${n.kind} related=${n.relatedId}`)
    return { notified: 0, emailed: 0 }
  }
}
// 自分あての通知のうち、kind（と related_id）が合うものを既読にする（やり取りを開いた・処理した後）。userId を省くと宛先全員の分
export async function markAdminNotificationsRead(db: D1Database, companyId: number, kinds: string[], relatedId: number | null, userId?: number) {
  if (!kinds.length) return 0
  try {
    const r = await db.prepare(`UPDATE user_notifications SET read_at = ? WHERE company_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) AND read_at IS NULL
      ${relatedId != null ? 'AND related_id = ?' : ''} ${userId != null ? 'AND user_id = ?' : ''}`)
      .bind(nowJST(), companyId, ...kinds, ...(relatedId != null ? [relatedId] : []), ...(userId != null ? [userId] : [])).run()
    return r.meta.changes || 0
  } catch { return 0 }
}

// ---- スタッフからの相談（#154）----
// received: 新しい相談 / message: 相談への追加の連絡（同じ相談の未読の通知にまとめる）
// 緊急度『高』と、体調不良・遅刻欠勤の相談はメールでもすぐに知らせる（追加の連絡は30分に1通まで）。それ以外はアプリ内だけ。
// メールには相談の本文を入れない（体調など本人の事情が書かれるため）。アプリ内通知の本文には冒頭だけを入れる
// 相談のカテゴリの表示名（api.ts の catLabel・画面の CAT_LABELS と同じ）
const CONSULT_LABEL: Record<string, string> = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
export const CONSULT_URGENT_CATEGORIES = ['health', 'absence']
const CONSULT_EXCERPT = 100
export async function notifyConsultation(c: any, consultationId: number, event: 'received' | 'message', text?: string) {
  try {
    const co = await c.env.DB.prepare(`SELECT co.consultation_id, co.company_id, co.category, co.urgency, co.body, co.target_date, p.project_name, us.name AS staff_name
      FROM consultations co JOIN staff_profiles sp ON sp.staff_id = co.staff_id JOIN users us ON us.user_id = sp.user_id
      LEFT JOIN projects p ON p.project_id = co.target_project_id AND p.company_id = co.company_id WHERE co.consultation_id = ?`).bind(consultationId).first() as any
    if (!co) return
    const urgent = co.urgency === 'high' || CONSULT_URGENT_CATEGORIES.includes(co.category)
    const cat = CONSULT_LABEL[co.category] || co.category
    const staff = String(co.staff_name || '')
    const lines: [string, string][] = [['スタッフ', staff], ['カテゴリ', cat], ['緊急度', co.urgency === 'high' ? '高' : co.urgency === 'low' ? '低' : '中']]
    if (co.target_date) lines.push(['対象', `${fmtDate(co.target_date)} ${co.project_name || ''}`.trim()])
    const src = String(text ?? co.body ?? '')
    const excerpt = src.length > CONSULT_EXCERPT ? src.slice(0, CONSULT_EXCERPT) + '…' : src
    const mark = urgent ? '【至急】' : ''
    await notifyCompanyAdmins(c, {
      companyId: co.company_id, kind: event === 'received' ? 'consult_received' : 'consult_message', relatedId: co.consultation_id,
      merge: event === 'message', email: !urgent ? 'never' : event === 'received' ? 'always' : 'throttle', mailType: 'consultation',
      title: (n) => event === 'received' ? `${mark}相談・連絡: ${staff}さん（${cat}）`
        : `${mark}相談への追加の連絡: ${staff}さん（${cat}）${n > 1 ? `・${n}件` : ''}`,
      headline: event === 'received' ? `${staff}さんから相談・連絡（${cat}）が届きました。${urgent ? '急ぎの連絡の可能性があります。' : ''}管理画面で内容を確認し、返信してください。`
        : `${staff}さんから、相談・連絡（${cat}）に追加の連絡が届きました。管理画面で内容を確認してください。`,
      lines, appExtra: excerpt ? `内容: ${excerpt}` : '',
      link: `/admin#consult/${co.consultation_id}`, button: '相談を確認する',
    })
  } catch (e) {
    console.log(`consult notify failed: consultation=${consultationId}`)
  }
}

// ---- 新しい応募（#150）。募集ページごとにまとめ、メールは30分に1通まで ----
export async function notifyRecruitApplied(c: any, a: { company_id: number; page_id: number; applicant: string; count: number; source: 'public' | 'staff' }) {
  const page = await c.env.DB.prepare('SELECT title FROM recruit_pages WHERE page_id = ? AND company_id = ?').bind(a.page_id, a.company_id).first().catch(() => null) as any
  const pageTitle = String(page?.title || '募集ページ')
  await notifyCompanyAdmins(c, {
    companyId: a.company_id, kind: 'recruit_applied', relatedId: a.page_id, merge: true, email: 'throttle', mailType: 'recruit_applied',
    title: (n) => n > 1 ? `新しい応募が${n}件あります（${pageTitle}）` : `新しい応募: ${a.applicant}さん（${pageTitle}）`,
    headline: '募集ページに新しい応募が届きました。内容を確認し、承認または見送りをしてください。',
    lines: [['募集ページ', pageTitle], ['応募者', `${a.applicant}${a.source === 'staff' ? '（スタッフアプリから）' : ''}`], ['希望の日時', `${a.count}件`]],
    link: `/admin#recruit/page-${a.page_id}`, button: '応募を確認する',
  })
}

// ---- 連携スタッフの所属元での退職（持ち越し #187）。連携先の各社の管理者に知らせる（アプリ内のみ）----
export async function notifyLinkedRetirement(db: D1Database, rootStaffId: number | string, retiredAt: string | null) {
  try {
    const root = Number(rootStaffId)
    const today = nowJST().slice(0, 10)
    const rows = (await db.prepare(`SELECT l.staff_id, l.company_id, us.name AS staff_name, oc.company_name AS owner_company_name,
        (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = l.staff_id AND s.company_id = l.company_id AND s.work_date >= ? AND s.status != 'absent') AS future_shifts
      FROM staff_profiles l JOIN users us ON us.user_id = l.user_id LEFT JOIN companies oc ON oc.company_id = l.owner_company_id
      WHERE COALESCE(l.root_staff_id, l.source_staff_id) = ? AND l.affiliation_type = 'linked_external'`).bind(today, root).all()).results as any[]
    if (!rows.length) return
    const now = nowJST()
    const stmts = rows.map(r => {
      const title = retiredAt ? `所属元で退職になります: ${r.staff_name || ''}（${fmtDate(retiredAt)}付け）` : `所属元が退職日を取り消しました: ${r.staff_name || ''}`
      const body = [`所属元: ${r.owner_company_name || ''}`, retiredAt ? `退職日: ${retiredAt}` : '退職日: なし（取り消し）',
        retiredAt ? `今日以降のシフト: ${Number(r.future_shifts) || 0}件（退職日より後のシフトは代わりの人を手配してください）` : ''].filter(Boolean).join('\n')
      return db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
        SELECT ?, user_id, 'roster_source_retired', ?, ?, ?, ?, ? FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
        .bind(r.company_id, title, body, `/admin#staff/${Number(r.staff_id)}`, r.staff_id, now, r.company_id, ...NOTIFY_ADMIN_ROLES)
    })
    await db.batch(stmts)
  } catch (e) {
    console.log(`linked retirement notify failed: staff=${rootStaffId}`)
  }
}

// =========================================================
// お知らせメールの差出人の情報（#367）。companies.settings_json の mail_reply_to（返信先）・mail_contact_phone（問い合わせの電話番号）
// お知らせメールの件名・本文の末尾に会社名と問い合わせ先を入れ、返信先（Reply-To）を企業のアドレスにする
// =========================================================
export type MailContact = { company_name: string; reply_to: string | null; phone: string | null }
const CONTACT_EMAIL = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/
const CONTACT_PHONE = /^[0-9０-９+\-－() ]{6,20}$/
export async function loadMailContact(db: D1Database, companyId: number): Promise<MailContact> {
  const r = await db.prepare(`SELECT company_name, CASE WHEN json_valid(settings_json) THEN json_extract(settings_json, '$.mail_reply_to') END AS reply_to,
      CASE WHEN json_valid(settings_json) THEN json_extract(settings_json, '$.mail_contact_phone') END AS phone FROM companies WHERE company_id = ?`).bind(companyId).first() as any
  const reply = String(r?.reply_to || '').trim()
  const phone = String(r?.phone || '').trim()
  return { company_name: String(r?.company_name || ''), reply_to: CONTACT_EMAIL.test(reply) ? reply : null, phone: phone || null }
}
notificationsAdminApi.get('/settings/mail-contact', async (c) => {
  const u = c.get('user')
  const m = await loadMailContact(c.env.DB, u.company_id)
  return c.json({ ...m, can_edit: u.role === 'company_admin' })
})
notificationsAdminApi.put('/settings/mail-contact', async (c) => {
  const u = c.get('user')
  if (u.role !== 'company_admin') return c.json({ error: '問い合わせ先の設定は会社管理者だけが変更できます' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const reply = String(b.reply_to ?? '').trim()
  const phone = String(b.phone ?? '').trim()
  if (reply && (reply.length > 254 || !CONTACT_EMAIL.test(reply))) return c.json({ error: '返信先のメールアドレスの形式が正しくありません' }, 400)
  if (phone && !CONTACT_PHONE.test(phone)) return c.json({ error: '電話番号は数字とハイフンで入力してください' }, 400)
  // ほかの設定を上書きしないよう、この2項目だけを書き換える（空欄は null）
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.mail_reply_to', ?, '$.mail_contact_phone', ?) WHERE company_id = ?`)
    .bind(reply || null, phone || null, u.company_id).run()
  return c.json({ ok: true, reply_to: reply || null, phone: phone || null })
})

// =========================================================
// メールの送信記録（email_logs。#438）と、送信を止めているアドレス（email_suppressions。#541）
// 企業: 自社の記録だけ。宛先は自社のユーザーのアドレスだけを出し、ほかは伏せる（連携スタッフの所属元のアドレスを見せない #570）
// 本部: 全社の集計（直近の日数の会社別・種類別の件数と失敗率、失敗の理由の上位、最後に成功した日時）と記録。宛先は伏せる
// email_logs.created_at は UTC（CURRENT_TIMESTAMP）なので、日本時間にして返す
// =========================================================
const MAIL_LOG_PAGE = 100
const MAIL_TYPES = ['notice', 'attendance_correction', 'incident_report', 'password_reset', 'account_email', 'recruit_applied', 'board_message', 'roster_chat', 'consultation']
function mailLogFilters(c: any, where: string[], binds: any[]) {
  const status = c.req.query('status') || ''
  if (status === 'failed') where.push(`l.status IN ('failed', 'bounced', 'bounced_soft', 'complained')`)
  else if (['sent', 'delivered', 'skipped', 'bounced', 'complained'].includes(status)) { where.push('l.status = ?'); binds.push(status) }
  const type = c.req.query('type') || ''
  if (/^[a-z_]{1,40}$/.test(type)) { where.push('l.type = ?'); binds.push(type) }
  const before = c.req.query('before') || ''
  if (/^\d{1,12}$/.test(before)) { where.push('l.log_id < ?'); binds.push(Number(before)) }
}
notificationsAdminApi.get('/email-logs', async (c) => {
  const u = c.get('user')
  const where = ['l.company_id = ?']; const binds: any[] = [u.company_id]
  mailLogFilters(c, where, binds)
  const rows = (await c.env.DB.prepare(`SELECT l.log_id, l.to_email, l.type, l.status, l.error_message, datetime(l.created_at, '+9 hours') AS created_at,
      (SELECT us.name FROM users us WHERE us.company_id = ? AND LOWER(us.email) = LOWER(l.to_email) ORDER BY us.status = 'active' DESC LIMIT 1) AS own_user_name,
      EXISTS (SELECT 1 FROM email_suppressions x WHERE x.email = LOWER(l.to_email)) AS suppressed
    FROM email_logs l WHERE ${where.join(' AND ')} ORDER BY l.log_id DESC LIMIT ?`).bind(u.company_id, ...binds, MAIL_LOG_PAGE + 1).all()).results as any[]
  const logs = rows.slice(0, MAIL_LOG_PAGE).map(r => {
    const own = r.own_user_name != null
    return { log_id: r.log_id, type: r.type, status: r.status, created_at: r.created_at, suppressed: !!r.suppressed, recipient_name: r.own_user_name,
      to_email: own ? r.to_email : HIDDEN_EMAIL_LABEL, to_email_hidden: !own, error: r.error_message ? (own ? r.error_message : maskEmailsIn(r.error_message)) : null }
  })
  return c.json({ logs, has_more: rows.length > MAIL_LOG_PAGE, types: MAIL_TYPES })
})
// 自社のユーザーのアドレスのうち、送信を止めているもの（不達・迷惑メールの報告）
notificationsAdminApi.get('/email-suppressions', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT x.email, x.reason, x.detail, x.created_at, group_concat(us.name, '、') AS names
    FROM email_suppressions x JOIN users us ON LOWER(us.email) = x.email AND us.company_id = ?
    GROUP BY x.email ORDER BY x.created_at DESC LIMIT 200`).bind(u.company_id).all()).results
  return c.json({ suppressions: rows, can_release: u.role === 'company_admin' })
})
// 送信の停止を解除する（受信できるようになったと本人に確かめた後）。自社のユーザーのアドレスだけ。会社管理者のみ
notificationsAdminApi.post('/email-suppressions/release', async (c) => {
  const u = c.get('user')
  if (u.role !== 'company_admin') return c.json({ error: '送信の停止の解除は会社管理者だけができます' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const email = normalizeAddress(b.email)
  if (!email) return c.json({ error: 'メールアドレスを指定してください' }, 400)
  const r = await c.env.DB.prepare(`DELETE FROM email_suppressions WHERE email = ? AND EXISTS (SELECT 1 FROM users us WHERE us.company_id = ? AND LOWER(us.email) = ?)`)
    .bind(email, u.company_id, email).run()
  if (!r.meta.changes) return c.json({ error: '送信を止めているアドレスが見つかりません' }, 404)
  return c.json({ ok: true })
})

// ---------- 本部（/api/hq。system_admin のみ。api.ts のミドルウェアで確認する）----------
export const mailHqApi = new Hono<{ Bindings: NotifyEnv; Variables: Variables }>()
// 失敗率の警告: 直近の期間に、ある企業の送信（送信停止を除く）が MIN 件以上あり、届かなかった割合が RATE 以上
const MAIL_ALERT_MIN = 5
const MAIL_ALERT_RATE = 0.2
// 届かなかったもの（企業の画面の「届かなかったもの」の絞り込みと同じ。一時的な不達も含める）
const FAILED_STATUSES = `('failed', 'bounced', 'bounced_soft', 'complained')`
mailHqApi.get('/email-stats', async (c) => {
  const days = Math.min(90, Math.max(1, Number.parseInt(c.req.query('days') || '', 10) || 7))
  const since = `-${days} days`
  const db = c.env.DB
  const [byCompany, reasons, lastOk, suppressed] = await Promise.all([
    db.prepare(`SELECT l.company_id, co.company_name, l.type, COUNT(*) AS total, SUM(l.status IN ('sent', 'delivered')) AS ok,
        SUM(l.status IN ${FAILED_STATUSES}) AS failed, SUM(l.status = 'skipped') AS skipped
      FROM email_logs l LEFT JOIN companies co ON co.company_id = l.company_id
      WHERE l.created_at >= datetime('now', ?) GROUP BY l.company_id, l.type ORDER BY l.company_id, l.type`).bind(since).all(),
    db.prepare(`SELECT CASE WHEN instr(error_message, ':') > 0 THEN substr(error_message, 1, instr(error_message, ':') - 1) ELSE COALESCE(error_message, '（理由なし）') END AS code,
        COUNT(*) AS n, MAX(error_message) AS sample
      FROM email_logs WHERE created_at >= datetime('now', ?) AND status IN ${FAILED_STATUSES} GROUP BY code ORDER BY n DESC LIMIT 10`).bind(since).all(),
    db.prepare(`SELECT company_id, datetime(MAX(created_at), '+9 hours') AS at FROM email_logs WHERE status IN ('sent', 'delivered') GROUP BY company_id`).all(),
    db.prepare('SELECT COUNT(*) AS n FROM email_suppressions').first(),
  ])
  const last = new Map(((lastOk.results || []) as any[]).map(r => [r.company_id, r.at]))
  const companies = new Map<any, any>()
  for (const r of (byCompany.results || []) as any[]) {
    const k = r.company_id ?? 0
    const e = companies.get(k) || { company_id: r.company_id, company_name: r.company_name || (r.company_id ? `#${r.company_id}` : '（企業なし）'), total: 0, ok: 0, failed: 0, skipped: 0, types: [] as any[], last_success_at: last.get(r.company_id) || null }
    e.total += r.total; e.ok += r.ok || 0; e.failed += r.failed || 0; e.skipped += r.skipped || 0
    e.types.push({ type: r.type, total: r.total, ok: r.ok || 0, failed: r.failed || 0, skipped: r.skipped || 0 })
    companies.set(k, e)
  }
  const list = [...companies.values()].map(e => ({ ...e, failure_rate: e.total - e.skipped > 0 ? e.failed / (e.total - e.skipped) : 0 }))
  const warnings = list.filter(e => e.total - e.skipped >= MAIL_ALERT_MIN && e.failure_rate >= MAIL_ALERT_RATE)
    .map(e => ({ company_id: e.company_id, message: `${e.company_name}: 直近${days}日のメールの${Math.round(e.failure_rate * 100)}%（${e.failed}/${e.total - e.skipped}件）が届いていません` }))
  const totals = list.reduce((a, e) => ({ total: a.total + e.total, ok: a.ok + e.ok, failed: a.failed + e.failed }), { total: 0, ok: 0, failed: 0 })
  return c.json({ days, totals, companies: list, reasons: ((reasons.results || []) as any[]).map(r => ({ ...r, sample: r.sample ? maskEmailsIn(r.sample) : null })),
    warnings, suppressed_count: Number((suppressed as any)?.n || 0), alert: { min: MAIL_ALERT_MIN, rate: MAIL_ALERT_RATE } })
})
mailHqApi.get('/email-logs', async (c) => {
  const where = ['1 = 1']; const binds: any[] = []
  const cid = c.req.query('company_id') || ''
  if (/^\d{1,9}$/.test(cid)) { where.push('l.company_id = ?'); binds.push(Number(cid)) }
  mailLogFilters(c, where, binds)
  const rows = (await c.env.DB.prepare(`SELECT l.log_id, l.company_id, co.company_name, l.to_email, l.type, l.status, l.error_message, datetime(l.created_at, '+9 hours') AS created_at
    FROM email_logs l LEFT JOIN companies co ON co.company_id = l.company_id WHERE ${where.join(' AND ')} ORDER BY l.log_id DESC LIMIT ?`).bind(...binds, MAIL_LOG_PAGE + 1).all()).results as any[]
  return c.json({ logs: rows.slice(0, MAIL_LOG_PAGE).map(r => ({ ...r, to_email: maskEmail(String(r.to_email || '')), error_message: r.error_message ? maskEmailsIn(r.error_message) : null })),
    has_more: rows.length > MAIL_LOG_PAGE, types: MAIL_TYPES })
})
mailHqApi.get('/email-suppressions', async (c) => {
  const rows = (await c.env.DB.prepare(`SELECT x.email, x.reason, x.detail, x.created_at,
      (SELECT group_concat(DISTINCT co.company_name) FROM users us JOIN companies co ON co.company_id = us.company_id WHERE LOWER(us.email) = x.email) AS companies
    FROM email_suppressions x ORDER BY x.created_at DESC LIMIT 300`).all()).results as any[]
  // 解除に使うため本部にはアドレスも返す（画面では伏せた形で表示する）
  return c.json({ suppressions: rows.map(r => ({ ...r, masked: maskEmail(String(r.email)), detail: r.detail ? maskEmailsIn(r.detail) : null })) })
})
mailHqApi.post('/email-suppressions/release', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const email = normalizeAddress(b.email)
  if (!email) return c.json({ error: 'メールアドレスを指定してください' }, 400)
  const r = await c.env.DB.prepare('DELETE FROM email_suppressions WHERE email = ?').bind(email).run()
  if (!r.meta.changes) return c.json({ error: '送信を止めているアドレスが見つかりません' }, 404)
  return c.json({ ok: true })
})

// =========================================================
// お知らせメールの「確認しました」のリンク（#454）
// 送るときに1人1つのトークンを作り（ハッシュで保存）、メールのボタンは /notice-ack?token=... を開く。
// メールソフトのリンクの事前読み込みで既読にならないよう、開いたページでボタンを押したときに既読にする（POST /api/public/notice-ack）。
// 既読にする条件はアプリの「確認しました」と同じ（今も配信の対象であること。loadStaffNotices）。1つのトークンは1回だけ使える
// =========================================================
export const NOTICE_ACK_DAYS = 30
const daysLaterJST = (d: number) => new Date(Date.now() + 9 * 3600 * 1000 + d * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ')
function randomToken(): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}
// 宛先ごとのトークン（user_id → トークン）。期限切れのトークンは、ついでに消す
export async function createNoticeAckTokens(db: D1Database, noticeId: number, companyId: number, userIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = [...new Set(userIds)]
  if (!ids.length) return out
  const rows: { h: string; u: number }[] = []
  for (const u of ids) {
    const t = randomToken()
    out.set(u, t)
    rows.push({ h: await sha256Hex(t), u })
  }
  await db.batch([
    db.prepare('DELETE FROM notice_ack_tokens WHERE expires_at < ?').bind(nowJST()),
    db.prepare(`INSERT OR IGNORE INTO notice_ack_tokens (token_hash, notice_id, company_id, user_id, expires_at, created_at)
      SELECT json_extract(value, '$.h'), ?, ?, json_extract(value, '$.u'), ?, ? FROM json_each(?)`)
      .bind(noticeId, companyId, daysLaterJST(NOTICE_ACK_DAYS), nowJST(), JSON.stringify(rows)),
  ])
  return out
}
async function findAckToken(db: D1Database, token: string) {
  if (!/^[0-9a-f]{48}$/.test(token)) return null
  return await db.prepare(`SELECT t.*, n.title, co.company_name FROM notice_ack_tokens t JOIN notices n ON n.notice_id = t.notice_id AND n.company_id = t.company_id
    JOIN companies co ON co.company_id = t.company_id WHERE t.token_hash = ?`).bind(await sha256Hex(token)).first() as any
}
export const noticeAckPublicApi = new Hono<{ Bindings: NotifyEnv }>()
noticeAckPublicApi.get('/', async (c) => {
  const t = await findAckToken(c.env.DB, c.req.query('token') || '')
  if (!t) return c.json({ error: 'リンクが正しくないか、お知らせが削除されています' }, 404)
  return c.json({ title: t.title, company_name: t.company_name, used: !!t.used_at, expired: t.expires_at < nowJST() })
})
noticeAckPublicApi.post('/', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const t = await findAckToken(db, String(b.token || ''))
  if (!t) return c.json({ error: 'リンクが正しくないか、お知らせが削除されています' }, 404)
  if (t.used_at) return c.json({ ok: true, already: true, title: t.title, company_name: t.company_name })
  if (t.expires_at < nowJST()) return c.json({ error: `リンクの有効期限（${NOTICE_ACK_DAYS}日）が切れています。アプリでお知らせを開き、「確認しました」を押してください` }, 410)
  const u = await db.prepare('SELECT status FROM users WHERE user_id = ? AND company_id = ?').bind(t.user_id, t.company_id).first() as any
  if (!u || u.status !== 'active') return c.json({ error: 'このアカウントは現在ご利用いただけません' }, 403)
  const [n] = await loadStaffNotices(db, t.user_id, { id: t.notice_id, limit: 1 })
  if (!n) return c.json({ error: 'このお知らせは配信の対象から外れています' }, 404)
  // 先にトークンを使用済みにして、同時に押されても1回だけ記録する
  const claim = await db.prepare('UPDATE notice_ack_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(nowJST(), t.token_hash).run()
  if (!claim.meta.changes) return c.json({ ok: true, already: true, title: t.title, company_name: t.company_name })
  if (!(n as any).no_confirm) await db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?, ?)').bind(t.notice_id, t.user_id).run()
  return c.json({ ok: true, title: t.title, company_name: t.company_name })
})
