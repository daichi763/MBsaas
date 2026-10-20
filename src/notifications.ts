// =========================================================
// アプリ内通知・メール通知（打刻修正申請の申請・承認・却下）
// docs/spec_attendance_correction.md 5章
//
// 宛先:
//   申請・再申請 → 自社の管理者全員（管理ロール・在籍中。本部アカウントは含めない）＋ 申請者本人（受付の控え。既読で登録し、メールは送らない #341）
//                  管理者が代わりに出した申請は、スタッフ本人にも未読で知らせる（メールは送らない）。
//                  まとめて出した申請の承認依頼メールは1通にまとめ、本人が取り消した直後の申請し直しはメールを送らない（#392）
//   承認・却下   → 申請者本人 ＋ 処理した管理者。管理者が出した申請の承認は、記録が変わったスタッフ本人にも知らせる（#181）
//                  申請者と処理した管理者が同じとき（申請と同時に承認 #174 など）は、既読の控えだけでメールは送らない
//   取り消し     → シフトの削除・担当者の差し替えで自動で取り消した場合だけ申請者本人へ（本人の取り消しは通知しない）
//   承認・却下・取り消しの後は、その申請の承認依頼（correction_submitted）を全員分既読にする（#189）
// アプリ内通知は申請・承認の処理の後に登録し、メールはその後に送る（waitUntil）。
// メールの失敗で申請・承認は取り消さない。送信状態は notification_emails に残し、管理者が再送できる。本文は保存せず、再送時に申請データから作り直す。
// =========================================================
import { Hono } from 'hono'
import { sendEmail, sendEmailBatch, maskEmail, maskEmailsIn, normalizeAddress } from './services/email'
import type { SendEmailInput } from './services/email'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { assignableStaffSql } from './lib/staff-eligibility'
import { attendanceCorrectionEmail } from './email-templates/attendance-correction'
import { REPORT_LABEL } from './report-settings'
import { toCsv, csvResponse, loadLatestForCsv, csvLimitNote, csvLimitHeaders } from './csv'
import { shareableEmail, HIDDEN_EMAIL_LABEL } from './lib/tenant'
import { loadStaffNotices } from './lib/notices'
import { sha256Hex } from './lib/auth'
import { personStaffRows } from './roster'
import * as emailService from './services/email'
import { loadVapid, sendWebPush, isAllowedPushEndpoint, allowLocalPush, type VapidEnv } from './lib/web-push'

export type NotifyEnv = { DB: D1Database; RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string
  VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
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
// quietProcessor: 処理した管理者の控えを既読・メールなしにする（まとめて承認 #280。自分の操作の控えが件数分のメールにならないように）
type NotifyOpts = { quietProcessor?: boolean }
async function recipientsFor(db: D1Database, c: any, event: CorrectionEvent, opts: NotifyOpts = {}): Promise<Recipient[]> {
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
    // 管理者が自分で出した申請を自分で処理した（申請と同時に承認 #174 を含む）ときは、本人には既読の控えだけを残す（結果の通知・メールは送らない）
    if (requester && requester.user_id === c.decided_by) add(requester, 'correction_processed', { read: true, noEmail: true })
    add(requester, event === 'approved' ? 'correction_approved' : 'correction_rejected')
    add(await user(c.decided_by), 'correction_processed', opts.quietProcessor ? { read: true, noEmail: true } : {})
    // 管理者が出した申請を承認したときは、記録が変わったスタッフ本人にも知らせる（申請者と同じ人なら送らない。#181）
    if (event === 'approved') {
      const o = await owner()
      if (o && !samePerson(o, requester)) add(o, 'correction_changed_by_admin')
    }
  }
  return [...out.values()]
}

// アプリ内通知を登録し、送るメールの送信状態（pending）を作る。戻り値の delivery_id を sendDeliveries で送る
export async function createCorrectionNotifications(db: D1Database, correctionId: number, event: CorrectionEvent, opts: NotifyOpts = {}) {
  const c = await loadInfo(db, correctionId)
  if (!c) return { notified: 0, deliveries: [] as number[] }
  const rcpts = await recipientsFor(db, c, event, opts)
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
  // 受け取り設定でメールを止めた・まとめて受け取る人には、すぐのメールを送らない（#284。アプリ内の通知は作る）
  const prefs = await loadNotifyPrefs(db, rows.filter(({ r }) => r.email && !r.noEmail).map(({ r }) => r.user_id))
  for (const { r } of rows) {
    if (!r.email || r.noEmail || !emailWanted(prefs, r.user_id, r.role, r.kind)) continue
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
export async function notifyCorrection(c: any, correctionId: number, event: CorrectionEvent, opts: NotifyOpts = {}) {
  try {
    // 処理済み・取り消し済みになった申請の承認依頼は、ほかの管理者の分も既読にする（#189）
    if (event !== 'submitted' && event !== 'resubmitted') await markRequestNotificationsRead(c.env.DB, correctionId)
    const r = await createCorrectionNotifications(c.env.DB, correctionId, event, opts)
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
    const admins = (await db.prepare(`SELECT user_id, name, email, role FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
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
    // 受け取り設定でこの種類のメールを止めた人には送らない（#284）
    const prefs = await loadNotifyPrefs(db, admins.map(a => a.user_id))
    const mails = admins.filter(a => a.email && emailWanted(prefs, a.user_id, a.role, 'incident_reported')).map(a => {
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
    const admins = ((await db.prepare(`SELECT user_id, name, email, role FROM users WHERE company_id = ? AND status = 'active' AND role IN (${NOTIFY_ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(n.companyId, ...NOTIFY_ADMIN_ROLES).all()).results as any[]).filter(a => !exclude.has(Number(a.user_id)))
    if (!admins.length) return { notified: 0, emailed: 0 }
    // 受け取り設定でこの種類のメールを止めた人には送らない（#284）
    const prefs = n.email === 'never' ? new Map() : await loadNotifyPrefs(db, admins.map(a => a.user_id))
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
      const sendMail = !!a.email && emailWanted(prefs, a.user_id, a.role, n.kind) && (n.email === 'always' || (n.email === 'throttle' && (!cur || !cur.emailed_at || cur.emailed_at < quietSince)))
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
// 本人あての自動リマインド（#160）。対象の選び方と送る時点の判定は services/reminders.ts（15分おきの cron）
// 会社の設定: companies.settings_json の reminders（既定は送らない）
//   enabled: 送るか / email: メールも送るか（アプリ内の通知は ON の間は必ず作る）
//   wake_up・departure: 開始の何分前に、check_in: 開始の何分後に、daily_report: 予定の終了の何分後に送るか。null はその種類を送らない
// 種類（user_notifications.kind）: report_reminder（起床・出発・入店）/ daily_report_reminder（日報）
// 1回の起動の分は、本人ごと・種類ごとに1件の通知・1通のメールにまとめる。メールの送信結果は email_logs（type = reminder）に残す
// =========================================================
export const REMINDER_TYPES = ['wake_up', 'departure', 'check_in', 'daily_report'] as const
export type ReminderType = typeof REMINDER_TYPES[number]
export type ReminderSettings = { enabled: boolean; email: boolean } & Record<ReminderType, number | null>
export const REMINDER_DEFAULTS: ReminderSettings = { enabled: false, email: true, wake_up: 120, departure: 60, check_in: 0, daily_report: 60 }
// 設定できる分の上限（起床・出発は開始の6時間前まで。報告の受付は開始の6時間前から。lib/shift-time.ts の PRE_START_HOURS）
export const REMINDER_LIMITS: Record<ReminderType, number> = { wake_up: 360, departure: 360, check_in: 120, daily_report: 720 }
export const REMINDER_KIND = { attendance: 'report_reminder', daily_report: 'daily_report_reminder' } as const
MAIL_TYPES.push('reminder')

export function reminderSettings(settingsJson: unknown): ReminderSettings {
  let r: any = null
  try { const s = typeof settingsJson === 'string' ? JSON.parse(settingsJson) : settingsJson; r = s && typeof s === 'object' ? s.reminders : null } catch { r = null }
  const out: ReminderSettings = { ...REMINDER_DEFAULTS }
  if (!r || typeof r !== 'object') return out
  out.enabled = r.enabled === true
  out.email = r.email !== false
  for (const t of REMINDER_TYPES) {
    if (r[t] === null) out[t] = null
    else if (Number.isInteger(r[t]) && r[t] >= 0 && r[t] <= REMINDER_LIMITS[t]) out[t] = r[t]
  }
  return out
}

notificationsAdminApi.get('/settings/reminders', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ ...reminderSettings(row?.settings_json), limits: REMINDER_LIMITS, can_edit: u.role === 'company_admin' })
})
notificationsAdminApi.put('/settings/reminders', async (c) => {
  const u = c.get('user')
  if (u.role !== 'company_admin') return c.json({ error: 'リマインドの設定は会社管理者だけが変更できます' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  if (typeof b.enabled !== 'boolean') return c.json({ error: '送るかどうか（enabled）を指定してください' }, 400)
  if (b.email !== undefined && typeof b.email !== 'boolean') return c.json({ error: 'メールを送るかどうかの指定が正しくありません' }, 400)
  const LABEL: Record<ReminderType, string> = { wake_up: '起床報告（開始の何分前）', departure: '出発報告（開始の何分前）', check_in: '入店報告（開始の何分後）', daily_report: '日報（終了の何分後）' }
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const next = reminderSettings(row?.settings_json)
  next.enabled = b.enabled
  if (b.email !== undefined) next.email = b.email
  for (const t of REMINDER_TYPES) {
    if (b[t] === undefined) continue
    if (b[t] !== null && !(Number.isInteger(b[t]) && b[t] >= 0 && b[t] <= REMINDER_LIMITS[t])) return c.json({ error: `${LABEL[t]}は 0〜${REMINDER_LIMITS[t]} 分の整数か、送らない（null）で指定してください` }, 400)
    next[t] = b[t]
  }
  // ほかの設定を上書きしないよう、この項目だけを書き換える。次の定期処理（15分おき）から効く
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.reminders', json(?)) WHERE company_id = ?`)
    .bind(JSON.stringify(next), u.company_id).run()
  return c.json({ ok: true, ...next })
})

export type ReminderItem = {
  company_id: number; shift_id: number; staff_id: number; user_id: number; user_name: string; email: string | null; email_on: boolean
  type: ReminderType; work_date: string; start_time: string; end_time: string; project_name: string | null
}
const REMINDER_LABEL: Record<ReminderType, string> = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', daily_report: '日報' }
const fmtShiftLine = (x: ReminderItem) => `${fmtDate(x.work_date)} ${x.start_time}〜${x.end_time <= x.start_time ? '翌' : ''}${x.end_time} ${x.project_name || ''}`.trim()

// 送ると決めたリマインド（reminder_sends に記録済みのもの）を、アプリ内通知とメールで本人に送る。
// 戻り値の emailed は、メールを送った（送信を試みた）リマインドの shift_id:type
export async function deliverReminders(env: NotifyEnv, items: ReminderItem[]) {
  const db = env.DB
  const groups = new Map<string, ReminderItem[]>()
  for (const x of items) {
    const key = `${x.user_id}:${x.type === 'daily_report' ? 'daily_report' : 'attendance'}`
    const g = groups.get(key) || []
    g.push(x); groups.set(key, g)
  }
  const at = nowJST()
  const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '')
  const rows: any[] = []
  const mails: emailService.SendEmailInput[] = []
  const emailed: string[] = []
  const contacts = new Map<number, MailContact>()
  // 受け取り設定でリマインドのメールを止めた人には送らない（アプリ内の通知は送る。#284）
  const prefs = await loadNotifyPrefs(db, items.filter(x => x.email_on && x.email).map(x => x.user_id))
  for (const list of groups.values()) {
    list.sort((a, b) => (a.work_date + a.start_time).localeCompare(b.work_date + b.start_time) || REMINDER_TYPES.indexOf(a.type) - REMINDER_TYPES.indexOf(b.type))
    const first = list[0]
    const daily = first.type === 'daily_report'
    // シフトごとに、まだの報告をまとめる
    const byShift = new Map<number, ReminderItem[]>()
    for (const x of list) byShift.set(x.shift_id, [...(byShift.get(x.shift_id) || []), x])
    const shifts = [...byShift.values()]
    const what = (xs: ReminderItem[]) => xs.map(x => REMINDER_LABEL[x.type]).join('・')
    const title = daily
      ? `日報がまだ提出されていません: ${fmtShiftLine(first)}${shifts.length > 1 ? ` ほか${shifts.length - 1}件` : ''}`
      : `${what(shifts[0])}がまだです: ${fmtShiftLine(first)}${shifts.length > 1 ? ` ほか${shifts.length - 1}件` : ''}`
    const headline = daily ? '稼働の日報がまだ提出されていません。日報・実績入力から提出してください。'
      : '勤怠の報告がまだ届いていません。報告を忘れていたら、アプリのホームから報告してください。遅れる・休む場合は、相談・連絡から会社に連絡してください。'
    const lines: [string, string][] = shifts.map((xs, i) => [shifts.length > 1 ? `シフト${i + 1}` : 'シフト', `${fmtShiftLine(xs[0])}${daily ? '' : `（${what(xs)}）`}`])
    const link = daily ? `#report/${Number(first.shift_id)}` : '#home'
    rows.push({ c: first.company_id, u: first.user_id, k: daily ? REMINDER_KIND.daily_report : REMINDER_KIND.attendance, t: title,
      b: [headline, ...lines.map(([k, v]) => `${k}: ${v}`)].join('\n'), l: link, r: first.shift_id })
    const to = String(first.email || '').trim()
    if (first.email_on && to && emailWanted(prefs, first.user_id, 'staff', daily ? REMINDER_KIND.daily_report : REMINDER_KIND.attendance)) {
      if (!contacts.has(first.company_id)) contacts.set(first.company_id, await loadMailContact(db, first.company_id))
      const contact = contacts.get(first.company_id)!
      const tpl = attendanceCorrectionEmail({ name: first.user_name, title, headline, lines: [...lines, ...(contact.company_name ? [['会社', contact.company_name] as [string, string]] : [])],
        url: `${base}/staff${link}`, button: daily ? '日報を入力する' : 'アプリを開く' })
      mails.push({ to, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'reminder', company_id: first.company_id, reply_to: contact.reply_to })
      for (const x of list) emailed.push(`${x.shift_id}:${x.type}`)
    }
  }
  // 通知は 200 件ずつ1文で入れる
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += 200) {
    stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT json_extract(value, '$.c'), json_extract(value, '$.u'), json_extract(value, '$.k'), json_extract(value, '$.t'), json_extract(value, '$.b'),
        json_extract(value, '$.l'), json_extract(value, '$.r'), ? FROM json_each(?)`).bind(at, JSON.stringify(rows.slice(i, i + 200))))
  }
  if (stmts.length) await db.batch(stmts)
  let mailFailed = 0
  if (mails.length) {
    try {
      // 二度送らないことは reminder_sends の記録で守る（送る前に記録を取る）
      const results = await emailService.sendEmailBatch(env, mails)
      mailFailed = results.filter(r => !r.ok).length
    } catch (e) {
      mailFailed = mails.length
      console.log(`reminder mail failed: ${e}`)
    }
  }
  return { notified: rows.length, mails: mails.length, mail_failed: mailFailed, emailed }
}

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

// =========================================================
// スタッフあての通知（#155 #151 #156 #158）。管理者あての通知（承認依頼・インシデントなど）とは種類と関数を分ける
// 種類（user_notifications.kind）:
//   shift_assigned / shift_changed / shift_cancelled … シフトの登録・変更（日時・場所・案件・状態）・取消（#155）
//   recruit_result … 募集への応募の承認・見送りの結果（#151）/ recruit_new … 新しい募集（#156）
//   daily_report_comment … 日報への管理者のコメント（#158）
// 宛先は、スタッフマスタ行のユーザーがログインできるスタッフ（role = 'staff'・在籍中）のときだけ。ログインのない人（roster_only）には送らない。
// メールの送信結果は email_logs に残す（notification_emails は打刻修正の申請に結び付くため使わない）。通知の失敗で元の操作は取り消さない
// =========================================================
export const STAFF_NOTIFY_KINDS = ['shift_assigned', 'shift_changed', 'shift_cancelled', 'recruit_result', 'recruit_new', 'daily_report_comment'] as const
MAIL_TYPES.push('shift_change', 'recruit_result', 'recruit_new')

type StaffUser = { staff_id: number; user_id: number; name: string; email: string | null }
type StaffNotifyRow = { company_id: number; user_id: number; kind: string; title: string; body: string; link: string; related_id: number | null }
const todayStr = () => nowJST().slice(0, 10)
const addDaysStr = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']
const fmtDay = (d: string | null | undefined) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[2])}/${Number(m[3])}(${WEEKDAY[new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay()]})` : ''
}
// 終了が開始以前なら日をまたぐ勤務（画面の formatShiftTime と同じく『翌』を付ける）
const fmtTimes = (s: string | null | undefined, e: string | null | undefined) => `${s || ''}〜${e && s && e <= s ? '翌' : ''}${e || ''}`
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

// スタッフマスタ行 → ログインできるスタッフのユーザー
async function staffLoginUsers(db: D1Database, staffIds: number[]): Promise<Map<number, StaffUser>> {
  const ids = [...new Set(staffIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  if (!ids.length) return new Map()
  const rows = (await db.prepare(`SELECT sp.staff_id, us.user_id, us.name, us.email FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.staff_id IN ${JSON_IN} AND us.role = 'staff' AND us.status = 'active' AND sp.merged_into_staff_id IS NULL`).bind(bindJsonArray(ids)).all()).results as any[]
  return new Map(rows.map(r => [Number(r.staff_id), { staff_id: Number(r.staff_id), user_id: r.user_id, name: r.name, email: r.email || null }]))
}
// 通知の登録（件数が多くても、200 行ずつ1文で入れる）
async function insertStaffNotifications(db: D1Database, rows: StaffNotifyRow[]) {
  if (!rows.length) return
  const at = nowJST()
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += 200) {
    stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT json_extract(value, '$.c'), json_extract(value, '$.u'), json_extract(value, '$.k'), json_extract(value, '$.t'), json_extract(value, '$.b'),
        json_extract(value, '$.l'), json_extract(value, '$.r'), ? FROM json_each(?)`)
      .bind(at, JSON.stringify(rows.slice(i, i + 200).map(r => ({ c: r.company_id, u: r.user_id, k: r.kind, t: r.title, b: r.body, l: r.link, r: r.related_id })))))
  }
  await db.batch(stmts)
}
// メールは応答の後に送る（waitUntil。使えないときはその場で送る）。送信の結果は email_logs に残る
async function queueStaffMails(c: any, mails: SendEmailInput[]) {
  if (!mails.length) return
  // 受け取り設定でその種類のメールを止めた人には送らない（#284 #178）
  mails = await filterStaffMails(c.env.DB, mails)
  if (!mails.length) return
  const job = (async () => {
    try { if (mails.length === 1) await sendEmail(c.env, mails[0]); else await sendEmailBatch(c.env, mails) } catch { /* 送信の失敗は email_logs に残る */ }
  })()
  try { c.executionCtx.waitUntil(job) } catch { await job }
}
const appUrl = (env: any, path: string) => String(env?.APP_BASE_URL || '').replace(/\/+$/, '') + path

// ---------- シフトの登録・変更・取消（#155） ----------
// 変更の前後のシフトを比べて、本人に知らせる。1回の操作の分は、スタッフごとに1件の通知・1通のメールにまとめる。
// - 今日より前のシフト（精算のための直し）は知らせない。欠勤のシフトの登録・取消は知らせない
// - メールは、今日・明日のシフトの変更があるときだけ送る（それ以外はアプリ内の通知のみ。数が多くなりすぎないように）
// shift_id のない行（一括登録で作ったシフト）は、登録として扱う
export type ShiftSnap = { shift_id: number | null; staff_id: number; work_date: string; start_time: string; end_time: string; status: string;
  location?: string | null; project_name?: string | null; site_name?: string | null; site_address?: string | null }
const SHIFT_STATUS_TEXT: Record<string, string> = { requested: '仮（希望）', confirmed: '確定', substitute: '代打', absent: '欠勤' }
export async function loadShiftSnaps(db: D1Database, companyId: number, shiftIds: (number | null | undefined)[]): Promise<ShiftSnap[]> {
  const ids = [...new Set(shiftIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  if (!ids.length) return []
  return (await db.prepare(`SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.location, p.project_name, si.site_name, si.address AS site_address
    FROM shifts s LEFT JOIN projects p ON p.project_id = s.project_id LEFT JOIN sites si ON si.site_id = s.site_id
    WHERE s.company_id = ? AND s.shift_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(ids)).all()).results as any[]
}
const placeOf = (s: ShiftSnap) => String(s.site_name || s.location || '').trim()
type ShiftEvent = { type: 'assigned' | 'changed' | 'cancelled'; snap: ShiftSnap; diffs: string[] }
function shiftDiffs(b: ShiftSnap, a: ShiftSnap): string[] {
  const out: string[] = []
  if (b.work_date !== a.work_date) out.push(`日付: ${fmtDay(b.work_date)} → ${fmtDay(a.work_date)}`)
  if (b.start_time !== a.start_time || b.end_time !== a.end_time) out.push(`時間: ${fmtTimes(b.start_time, b.end_time)} → ${fmtTimes(a.start_time, a.end_time)}`)
  if ((b.project_name || '') !== (a.project_name || '')) out.push(`案件: ${b.project_name || ''} → ${a.project_name || ''}`)
  if (placeOf(b) !== placeOf(a)) out.push(`場所: ${placeOf(b) || '（なし）'} → ${placeOf(a) || '（なし）'}`)
  if (b.status !== a.status) out.push(`状態: ${SHIFT_STATUS_TEXT[b.status] || b.status} → ${SHIFT_STATUS_TEXT[a.status] || a.status}`)
  return out
}
function shiftEventLine(e: ShiftEvent) {
  const s = e.snap
  const head = `${fmtDay(s.work_date)} ${fmtTimes(s.start_time, s.end_time)} ${s.project_name || ''}${placeOf(s) ? '・' + placeOf(s) : ''}`
  if (e.type === 'assigned') return `【登録${s.status === 'requested' ? '（仮）' : ''}】${head}`
  if (e.type === 'cancelled') return `【取消】${head}`
  return `【変更】${head}\n  ${e.diffs.join('\n  ')}`
}
const SHIFT_EVENT_LABEL = { assigned: '登録', changed: '変更', cancelled: '取消' } as const
const SHIFT_NOTIFY_MAX_LINES = 20
export async function notifyShiftChanges(c: any, companyId: number, before: ShiftSnap[], after: ShiftSnap[]) {
  try {
    const db: D1Database = c.env.DB
    const today = todayStr(), tomorrow = addDaysStr(today, 1)
    const events: ShiftEvent[] = []
    const prev = new Map(before.filter(s => s.shift_id).map(s => [Number(s.shift_id), s]))
    const seen = new Set<number>()
    for (const a of after) {
      const b = a.shift_id ? prev.get(Number(a.shift_id)) : undefined
      if (a.shift_id) seen.add(Number(a.shift_id))
      if (b && b.staff_id === a.staff_id) {
        if ((b.work_date < today && a.work_date < today) || (b.status === 'absent' && a.status === 'absent')) continue
        const diffs = shiftDiffs(b, a)
        if (diffs.length) events.push({ type: 'changed', snap: a, diffs })
        continue
      }
      // 担当者の差し替え: 前の人には取消、新しい人には登録
      if (b && b.status !== 'absent' && b.work_date >= today) events.push({ type: 'cancelled', snap: b, diffs: [] })
      if (a.status !== 'absent' && a.work_date >= today) events.push({ type: 'assigned', snap: a, diffs: [] })
    }
    for (const b of before) if (b.shift_id && !seen.has(Number(b.shift_id)) && b.status !== 'absent' && b.work_date >= today) events.push({ type: 'cancelled', snap: b, diffs: [] })
    if (!events.length) return
    const users = await staffLoginUsers(db, events.map(e => e.snap.staff_id))
    const byUser = new Map<number, { u: StaffUser; list: ShiftEvent[] }>()
    for (const e of events) {
      const u = users.get(Number(e.snap.staff_id)); if (!u) continue
      const g = byUser.get(u.user_id) || { u, list: [] as ShiftEvent[] }
      g.list.push(e); byUser.set(u.user_id, g)
    }
    const rows: StaffNotifyRow[] = []
    const mails: SendEmailInput[] = []
    for (const { u, list } of byUser.values()) {
      list.sort((x, y) => (x.snap.work_date + x.snap.start_time).localeCompare(y.snap.work_date + y.snap.start_time))
      const types = new Set(list.map(e => e.type))
      const kind = types.size === 1 ? `shift_${list[0].type}` : 'shift_changed'
      const first = list[0].snap
      const what = `${fmtDay(first.work_date)} ${first.project_name || ''}`
      let title: string
      if (list.length === 1) {
        const t = list[0].type
        title = t === 'assigned' ? (first.status === 'requested' ? `仮のシフトが入りました（返事をしてください）: ${what}` : `シフトが入りました: ${what}`)
          : t === 'cancelled' ? `シフトが取り消されました: ${what}` : `シフトが変更されました: ${what}`
      } else {
        const counts = (['assigned', 'changed', 'cancelled'] as const).filter(t => types.has(t)).map(t => `${SHIFT_EVENT_LABEL[t]}${list.filter(e => e.type === t).length}件`).join('・')
        const last = list[list.length - 1].snap
        title = `シフトの${types.size === 1 ? SHIFT_EVENT_LABEL[list[0].type] : '変更'}があります（${counts}）: ${fmtDay(first.work_date)}${last.work_date !== first.work_date ? '〜' + fmtDay(last.work_date) : ''}`
      }
      const lines = list.slice(0, SHIFT_NOTIFY_MAX_LINES).map(shiftEventLine)
      if (list.length > SHIFT_NOTIFY_MAX_LINES) lines.push(`ほか${list.length - SHIFT_NOTIFY_MAX_LINES}件（シフト画面で確認してください）`)
      const body = lines.join('\n')
      // シフト画面のその日から開く（staff.js の route が #shift/YYYY-MM-DD を受ける）
      const link = `#shift/${first.work_date >= today ? first.work_date : today}`
      rows.push({ company_id: companyId, user_id: u.user_id, kind, title, body, link, related_id: list.length === 1 ? (first.shift_id ?? null) : null })
      // メールは今日・明日の分があるときだけ（その日のうちに気づく必要があるため）
      if (u.email && list.some(e => e.snap.work_date === today || e.snap.work_date === tomorrow)) {
        const tpl = attendanceCorrectionEmail({ name: u.name, title, headline: '管理者がシフトを登録・変更しました。内容を確認してください。', lines: [['内容', body]], url: appUrl(c.env, '/staff' + link), button: 'シフトを確認する' })
        mails.push({ to: u.email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'shift_change', company_id: companyId })
      }
    }
    await insertStaffNotifications(db, rows)
    await queueStaffMails(c, mails)
  } catch (e) {
    console.log(`shift notify failed: company=${companyId}`)
  }
}

// ---------- 募集への応募の結果（#151） ----------
// 承認・見送りにした日時を、応募者に知らせる。ログインできるスタッフにはアプリ内通知、メールは公開ページからの応募なら応募フォームのアドレス、
// アプリからの応募ならログインのアドレスへ送る。承認は日時・場所・役割と募集の案内（仕事内容・問い合わせ先）、見送りは定型文。
// 複数の応募をまとめて知らせても、データベースの読み書きの回数は応募の数によらない（枠の残りをまとめて見送るとき。Free プランの回数の上限のため）。
// wait: メールの送信を待って結果を返す（承認・見送りの画面に、送れたかを出す）。待たないときは応答の後にまとめて送る。
// 戻り値: app（アプリ内通知を作ったか）、email（sent / failed / disabled（送信を止めている環境）/ queued / none（宛先なし））
export type RecruitResultNotice = { app: boolean; email: 'sent' | 'failed' | 'disabled' | 'queued' | 'none'; error?: string }
type RecruitResultTarget = { applicationId: number; approved: number[]; rejected: number[] }
export async function notifyRecruitResults(c: any, companyId: number, targets: RecruitResultTarget[], opts: { wait?: boolean } = {}): Promise<Map<number, RecruitResultNotice>> {
  const out = new Map<number, RecruitResultNotice>(targets.map(t => [t.applicationId, { app: false, email: 'none' }]))
  try {
    const db: D1Database = c.env.DB
    const appIds = targets.filter(t => t.approved.length || t.rejected.length).map(t => t.applicationId)
    const itemIds = targets.flatMap(t => [...t.approved, ...t.rejected])
    if (!appIds.length) return out
    const apps = (await db.prepare(`SELECT a.application_id, a.source, a.staff_id, a.name, a.email, rp.title AS page_title, rp.description, rp.contact_note, rp.token
      FROM recruit_applications a LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id WHERE a.company_id = ? AND a.application_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(appIds)).all()).results as any[]
    const items = (await db.prepare(`SELECT i.item_id, i.application_id, i.status, sl.work_date, sl.start_time, sl.end_time, r.role_name, COALESCE(si.site_name, sl.location, p.location, '') AS place, si.address AS site_address
      FROM recruit_application_items i LEFT JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id LEFT JOIN shift_slots sl ON sl.slot_id = r.slot_id
      LEFT JOIN projects p ON p.project_id = sl.project_id LEFT JOIN sites si ON si.site_id = sl.site_id
      WHERE i.item_id IN ${JSON_IN} ORDER BY sl.work_date, sl.start_time`).bind(bindJsonArray(itemIds)).all()).results as any[]
    if (!apps.length) return out
    const contact = await loadMailContact(db, companyId)
    const users = await staffLoginUsers(db, apps.map(a => a.staff_id).filter(Boolean))
    const when = (i: any) => `${fmtDay(i.work_date)} ${fmtTimes(i.start_time, i.end_time)}`
    const rows: StaffNotifyRow[] = []
    const mails: { appId: number; mail: SendEmailInput }[] = []
    for (const a of apps) {
      const t = targets.find(x => x.applicationId === a.application_id)!
      const mine = items.filter(i => i.application_id === a.application_id)
      const ok = mine.filter(i => i.status === 'approved' && t.approved.includes(i.item_id))
      const ng = mine.filter(i => i.status === 'rejected' && t.rejected.includes(i.item_id))
      if (!ok.length && !ng.length) continue
      const lines: [string, string][] = [['募集', a.page_title || '（スタッフアプリからの応募）']]
      // 複数の日時は1つの項目にまとめる（メールのテキスト版に見出しのない「: 」の行ができないように）
      if (ok.length) lines.push(['確定した日時', ok.map(i => `${when(i)} ${i.role_name || ''}\n場所: ${i.place || '（担当者から連絡します）'}${i.site_address ? `（${i.site_address}）` : ''}`).join('\n')])
      if (ng.length) lines.push(['見送りの日時', ng.map(i => `${when(i)} ${i.role_name || ''}`).join('\n')])
      if (ok.length && a.description) lines.push(['仕事内容・集合の案内', clip(String(a.description), 1000)])
      const contactText = [a.contact_note, contact.phone ? `電話 ${contact.phone}` : ''].filter(Boolean).join(' / ')
      if (contactText) lines.push(['問い合わせ先', contactText])
      const title = ok.length && ng.length ? `応募の結果のお知らせ（確定${ok.length}件・見送り${ng.length}件）` : ok.length ? `応募いただいたお仕事が確定しました（${ok.length}件）` : `応募の結果のお知らせ（見送り${ng.length}件）`
      const headline = (ok.length ? `ご応募ありがとうございます。次の日時で勤務が確定しました。当日は開始時刻までに集合場所へお越しください。${ng.length ? '一部の日時は、定員などの都合で見送りとなりました。' : ''}`
        : 'ご応募ありがとうございます。誠に恐れ入りますが、今回は定員などの都合により、次の日時は見送りとさせていただきました。またのご応募をお待ちしています。')
        + (contactText ? 'ご不明な点は問い合わせ先までご連絡ください。' : '')
      const res = out.get(a.application_id)!
      // アプリ内通知（ログインできるスタッフ）
      const u = a.staff_id ? users.get(Number(a.staff_id)) : undefined
      if (u) {
        rows.push({ company_id: companyId, user_id: u.user_id, kind: 'recruit_result', title,
          body: lines.map(([k, v]) => `${k}: ${v}`).join('\n'), link: ok.length ? `#shift/${ok[0].work_date}` : '#shift', related_id: a.application_id })
        res.app = true
      }
      // メール: 公開ページからの応募は応募フォームのアドレス（本人が結果の連絡先として入れたもの）。アプリからの応募はログインのアドレス
      const to = String((a.source === 'public' ? a.email : u?.email) || '').trim()
      if (!to) continue
      const url = a.source === 'public' ? appUrl(c.env, a.token ? `/apply/${a.token}` : '/') : appUrl(c.env, '/staff#shift')
      const tpl = attendanceCorrectionEmail({ name: a.name || u?.name || '', title: `${contact.company_name ? contact.company_name + ' ' : ''}${title}`, headline, lines, url,
        button: a.source === 'public' ? '募集ページを開く' : 'シフトを確認する' })
      mails.push({ appId: a.application_id, mail: { to, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'recruit_result', company_id: companyId, reply_to: contact.reply_to } })
    }
    await insertStaffNotifications(db, rows)
    if (!mails.length) return out
    if (!opts.wait) {
      await queueStaffMails(c, mails.map(m => m.mail))
      for (const m of mails) out.get(m.appId)!.email = 'queued'
      return out
    }
    const results = mails.length === 1 ? [await sendEmail(c.env, mails[0].mail)] : await sendEmailBatch(c.env, mails.map(m => m.mail))
    mails.forEach((m, k) => {
      const r = results[k], res = out.get(m.appId)!
      res.email = r.ok ? (r.skipped ? 'disabled' : 'sent') : 'failed'
      if (!r.ok) res.error = maskEmailsIn(r.error || 'unknown')
    })
    return out
  } catch (e) {
    console.log(`recruit result notify failed: applications=${targets.length}`)
    return out
  }
}
export async function notifyRecruitResult(c: any, companyId: number, applicationId: number, itemIds: { approved: number[]; rejected: number[] }, opts: { wait?: boolean } = {}): Promise<RecruitResultNotice> {
  return (await notifyRecruitResults(c, companyId, [{ applicationId, ...itemIds }], opts)).get(applicationId)!
}

// ---------- 新しい募集（#156） ----------
// スタッフアプリから応募できる募集（allow_staff）を公開・再開したら、自社の割り当てられるスタッフ（ログインできる人）に知らせる。
// 同じ募集ページの通知は RECRUIT_NEW_QUIET_HOURS に1回まで（終了・再開をくり返しても何度も届かないように）。メールは管理者が選んだときだけ送る
export const RECRUIT_NEW_QUIET_HOURS = 24
export async function notifyRecruitNew(c: any, companyId: number, pageId: number, opts: { email?: boolean } = {}): Promise<{ notified: number; emailed: number; skipped_recent?: boolean }> {
  try {
    const db: D1Database = c.env.DB
    const p = await db.prepare(`SELECT page_id, title, date_from, date_to, pay_note, status, allow_staff FROM recruit_pages WHERE page_id = ? AND company_id = ?`).bind(pageId, companyId).first() as any
    if (!p || p.status !== 'open' || !p.allow_staff || p.date_to < todayStr()) return { notified: 0, emailed: 0 }
    const since = new Date(Date.now() + 9 * 3600 * 1000 - RECRUIT_NEW_QUIET_HOURS * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const recent = await db.prepare(`SELECT 1 FROM user_notifications WHERE company_id = ? AND kind = 'recruit_new' AND related_id = ? AND created_at >= ? LIMIT 1`).bind(companyId, pageId, since).first()
    if (recent) return { notified: 0, emailed: 0, skipped_recent: true }
    const elig = assignableStaffSql({ onDate: todayStr() })
    const staff = (await db.prepare(`SELECT us.user_id, us.name, us.email FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
      WHERE sp.company_id = ? AND us.role = 'staff' AND ${elig.sql}`).bind(companyId, ...elig.binds).all()).results as any[]
    if (!staff.length) return { notified: 0, emailed: 0 }
    const period = `${fmtDay(p.date_from)}〜${fmtDay(p.date_to)}`
    const title = `新しい募集があります: ${p.title}`
    const body = [`期間: ${period}`, p.pay_note ? `給与: ${p.pay_note}` : '', 'シフト画面の「募集中のお仕事」から応募できます'].filter(Boolean).join('\n')
    await insertStaffNotifications(db, staff.map(s => ({ company_id: companyId, user_id: s.user_id, kind: 'recruit_new', title, body, link: '#shift', related_id: pageId })))
    let emailed = 0
    if (opts.email) {
      const contact = await loadMailContact(db, companyId)
      const lines: [string, string][] = [['募集', p.title], ['期間', period]]
      if (p.pay_note) lines.push(['給与', p.pay_note])
      const mails: SendEmailInput[] = staff.filter(s => s.email).map(s => {
        const tpl = attendanceCorrectionEmail({ name: s.name, title: `${contact.company_name ? contact.company_name + ' ' : ''}${title}`, headline: '新しいお仕事の募集が始まりました。スタッフアプリから応募できます。',
          lines, url: appUrl(c.env, '/staff#shift'), button: '募集を見る' })
        return { to: s.email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'recruit_new', company_id: companyId, reply_to: contact.reply_to }
      })
      emailed = mails.length
      await queueStaffMails(c, mails)
    }
    return { notified: staff.length, emailed }
  } catch (e) {
    console.log(`recruit new notify failed: page=${pageId}`)
    return { notified: 0, emailed: 0 }
  }
}

// ---------- 日報へのコメント（#158） ----------
// コメントを新しく付けた・書き換えたときに、日報を出したスタッフに知らせる（アプリ内のみ）。
// 同じ日報のまだ読んでいないコメントの通知は、新しい内容の1件に置き換える。戻り値は通知したか
export async function notifyReportComment(c: any, companyId: number, dailyReportId: number, actorName: string): Promise<boolean> {
  try {
    const db: D1Database = c.env.DB
    const r = await db.prepare(`SELECT dr.daily_report_id, dr.staff_id, dr.work_date, dr.manager_comment, p.project_name FROM daily_reports dr LEFT JOIN projects p ON p.project_id = dr.project_id
      WHERE dr.daily_report_id = ? AND dr.company_id = ?`).bind(dailyReportId, companyId).first() as any
    if (!r || !r.manager_comment) return false
    const u = (await staffLoginUsers(db, [r.staff_id])).get(Number(r.staff_id))
    if (!u) return false
    await db.prepare(`DELETE FROM user_notifications WHERE kind = 'daily_report_comment' AND related_id = ? AND company_id = ? AND read_at IS NULL`).bind(dailyReportId, companyId).run()
    await insertStaffNotifications(db, [{ company_id: companyId, user_id: u.user_id, kind: 'daily_report_comment', title: `日報にコメントがあります: ${fmtDay(r.work_date)} ${r.project_name || ''}`,
      body: `${clip(String(r.manager_comment), 300)}\nコメントした人: ${actorName || '管理者'}`, link: '#report', related_id: dailyReportId }])
    return true
  } catch (e) {
    console.log(`report comment notify failed: report=${dailyReportId}`)
    return false
  }
}

// =========================================================
// 通知の受け取り設定（#284）とプッシュ通知（#178）（作業単位 w6-push）
// 受け取り設定: ユーザーごと・通知のまとまり（NOTIFY_PREF_GROUPS）ごとに、メールとプッシュの ON/OFF を持つ（user_notification_prefs）。
//   未設定（NULL）のときは既定（defaultEmail）。アプリ内の通知は設定によらず必ず作る（受信箱・ToDo から漏れないように）。
//   打刻修正の承認依頼は、既定でメールを会社管理者と現場管理者だけに送り、「1日1回まとめて」（digest）も選べる。
//   自分が処理した打刻修正の控えは、既定でメールを送らない（アプリ内の控えだけ）。
//   スタッフの設定は、同じ人のすべての会社のユーザーに同じ値を保存する。
// プッシュ: アプリ内の通知（未読）が登録されると、購読のある人の分をトリガーで push_queue に積む（migrations/0081_push.sql）。
//   API の書き込みの応答の後（index.tsx の waitUntil）と15分おきの cron で flushPushQueue が送る。本文は送らず、
//   端末の Service Worker（/sw.js）が GET /api/staff/push/latest で最新の未読を取りに来る（src/lib/web-push.ts）
// =========================================================
type PrefGroup = {
  key: string; label: string; desc: string; audience: 'admin' | 'staff'; kinds: string[]
  // メールの既定（ロールごと）。ないまとまりはメールの ON/OFF を選べない（送るものは今までどおり送る）
  defaultEmail?: (role: string) => boolean
  push?: boolean
  digest?: boolean
  // スタッフあてのメールの種類（email_logs の type）。queueStaffMails で、このまとまりのメールを止めた人に送らない
  mailTypes?: string[]
}
const always = () => true
export const NOTIFY_PREF_GROUPS: PrefGroup[] = [
  // ---- 管理者 ----
  { key: 'correction_request', audience: 'admin', label: '打刻修正の承認依頼', desc: 'スタッフからの打刻修正の申請・再申請', kinds: ['correction_submitted'],
    defaultEmail: (role) => role === 'company_admin' || role === 'field_manager', digest: true },
  { key: 'correction_processed', audience: 'admin', label: '自分が処理した打刻修正の控え', desc: '自分が承認・却下した申請の控え（既定はアプリ内の通知だけ）', kinds: ['correction_processed'],
    defaultEmail: () => false },
  { key: 'correction_result_admin', audience: 'admin', label: '自分が出した打刻修正の結果', desc: '代わりに出した申請が承認・却下・取り消しになったとき',
    kinds: ['correction_approved', 'correction_rejected', 'correction_cancelled'], defaultEmail: always },
  { key: 'incident', audience: 'admin', label: 'インシデント・クレームの報告', desc: 'スタッフの日報でのインシデント・クレームの報告', kinds: ['incident_reported'], defaultEmail: always },
  { key: 'recruit_applied', audience: 'admin', label: '新しい応募', desc: '募集ページへの応募（30分に1通まで）', kinds: ['recruit_applied'], defaultEmail: always },
  { key: 'board_message', audience: 'admin', label: '案件掲示板のやり取り', desc: '掲載への問い合わせ・提案・返信', kinds: ['board_message'], defaultEmail: always },
  { key: 'roster_chat', audience: 'admin', label: '企業間チャット', desc: '連携先の企業とのチャット', kinds: ['roster_chat'], defaultEmail: always },
  { key: 'consult', audience: 'admin', label: 'スタッフからの相談・連絡', desc: '緊急度の高い相談・体調不良・遅刻欠勤のメール', kinds: ['consult_received', 'consult_message'], defaultEmail: always },
  // ---- スタッフ ----
  { key: 'shift', audience: 'staff', label: 'シフトの登録・変更・取消', desc: 'メールは今日・明日のシフトの変更のときだけ', kinds: ['shift_assigned', 'shift_changed', 'shift_cancelled'],
    defaultEmail: always, push: true, mailTypes: ['shift_change'] },
  { key: 'reminder', audience: 'staff', label: '報告・日報のリマインド', desc: '起床・出発・入店の報告や日報がまだのとき', kinds: ['report_reminder', 'daily_report_reminder'],
    defaultEmail: always, push: true, mailTypes: ['reminder'] },
  { key: 'recruit_new', audience: 'staff', label: '新しい募集', desc: 'スタッフアプリから応募できる募集が始まったとき', kinds: ['recruit_new'], defaultEmail: always, push: true, mailTypes: ['recruit_new'] },
  { key: 'recruit_result', audience: 'staff', label: '応募の結果', desc: '応募したお仕事の確定・見送り', kinds: ['recruit_result'], push: true },
  { key: 'correction_staff', audience: 'staff', label: '打刻の修正・代理入力', desc: '打刻修正の申請の結果、管理者による修正・代理入力',
    kinds: ['correction_approved', 'correction_rejected', 'correction_changed_by_admin', 'correction_cancelled', 'correction_proxy_submitted', 'attendance_proxy'], push: true },
  { key: 'daily_report_comment', audience: 'staff', label: '日報へのコメント', desc: '管理者が日報にコメントしたとき', kinds: ['daily_report_comment'], push: true },
  { key: 'staff_other', audience: 'staff', label: 'そのほかの通知', desc: '相談への返信・申請の結果・お知らせの確認のお願いなど', kinds: [], push: true },
]
const audienceOf = (role: string): 'admin' | 'staff' => (role === 'staff' ? 'staff' : 'admin')
function prefGroupFor(kind: string, audience: 'admin' | 'staff'): PrefGroup | undefined {
  return NOTIFY_PREF_GROUPS.find(g => g.audience === audience && g.kinds.includes(kind)) || (audience === 'staff' ? NOTIFY_PREF_GROUPS.find(g => g.key === 'staff_other') : undefined)
}
type PrefRow = { email: number | null; push: number | null; digest: number }
type PrefMap = Map<number, Map<string, PrefRow>>
export async function loadNotifyPrefs(db: D1Database, userIds: number[]): Promise<PrefMap> {
  const out: PrefMap = new Map()
  const ids = [...new Set(userIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  if (!ids.length) return out
  const rows = (await db.prepare(`SELECT user_id, pref_key, email, push, digest FROM user_notification_prefs WHERE user_id IN ${JSON_IN}`).bind(bindJsonArray(ids)).all()).results as any[]
  for (const r of rows) {
    const m = out.get(Number(r.user_id)) || new Map<string, PrefRow>()
    m.set(r.pref_key, { email: r.email, push: r.push, digest: Number(r.digest || 0) })
    out.set(Number(r.user_id), m)
  }
  return out
}
/** この通知をメールですぐに送るか（設定がないまとまりは送る。まとめて送る設定のときは送らない） */
export function emailWanted(prefs: PrefMap, userId: number, role: string, kind: string): boolean {
  const g = prefGroupFor(kind, audienceOf(role))
  if (!g || !g.defaultEmail) return true
  const p = prefs.get(Number(userId))?.get(g.key)
  if (g.digest && p?.digest) return false
  return p && p.email != null ? !!p.email : g.defaultEmail(role)
}
/** この通知をプッシュで送るか（スタッフのみ。既定は送る） */
function pushWanted(prefs: PrefMap, userId: number, role: string, kind: string): boolean {
  if (role !== 'staff') return false
  const g = prefGroupFor(kind, 'staff')
  const p = g ? prefs.get(Number(userId))?.get(g.key) : undefined
  return p && p.push != null ? !!p.push : true
}
// スタッフあてのメールのうち、そのまとまりのメールを止めた人（メールアドレスで照合する）あてのものを除く
async function filterStaffMails(db: D1Database, mails: SendEmailInput[]): Promise<SendEmailInput[]> {
  const keyOf = (type: string) => NOTIFY_PREF_GROUPS.find(g => g.mailTypes?.includes(type))?.key
  const keys = [...new Set(mails.map(m => keyOf(m.type)).filter(Boolean))] as string[]
  if (!keys.length) return mails
  try {
    const addrs = [...new Set(mails.map(m => String(m.to || '').trim().toLowerCase()).filter(Boolean))]
    const rows = (await db.prepare(`SELECT DISTINCT p.pref_key, LOWER(TRIM(u.email)) AS email FROM user_notification_prefs p JOIN users u ON u.user_id = p.user_id
      WHERE p.email = 0 AND p.pref_key IN (SELECT value FROM json_each(?)) AND u.role = 'staff' AND LOWER(TRIM(u.email)) IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(keys), JSON.stringify(addrs)).all()).results as any[]
    if (!rows.length) return mails
    const off = new Set(rows.map(r => `${r.pref_key} ${r.email}`))
    return mails.filter(m => !off.has(`${keyOf(m.type)} ${String(m.to || '').trim().toLowerCase()}`))
  } catch (e) {
    // 設定を読めないときは今までどおり送る
    return mails
  }
}

// ---------- 受け取り設定の API ----------
function prefView(groups: PrefGroup[], role: string, mine: Map<string, PrefRow> | undefined) {
  return groups.map(g => {
    const p = mine?.get(g.key)
    const emailDefault = g.defaultEmail ? g.defaultEmail(role) : null
    return {
      key: g.key, label: g.label, desc: g.desc,
      email_supported: !!g.defaultEmail, email: g.defaultEmail ? (p && p.email != null ? !!p.email : !!emailDefault) : null, email_default: emailDefault,
      digest_supported: !!g.digest, digest: !!(g.digest && p?.digest),
      push_supported: !!g.push, push: g.push ? (p && p.push != null ? !!p.push : true) : null,
    }
  })
}
// 受け取った設定を検証して保存する。userIds のすべてに同じ値を入れる。送られなかったまとまりは変えない
async function savePrefs(db: D1Database, companyId: number, userIds: number[], groups: PrefGroup[], body: any): Promise<string | null> {
  const prefs = body && typeof body.prefs === 'object' && body.prefs ? body.prefs : null
  if (!prefs) return '設定がありません'
  const at = nowJST()
  const stmts: D1PreparedStatement[] = []
  const bool = (x: unknown) => (x === true ? 1 : x === false ? 0 : null)
  for (const [key, v] of Object.entries(prefs as Record<string, any>)) {
    const g = groups.find(x => x.key === key)
    if (!g || !v || typeof v !== 'object') return `設定の種類が正しくありません: ${key}`
    const email = g.defaultEmail ? bool(v.email) : null
    const push = g.push ? bool(v.push) : null
    const digest = g.digest && v.digest === true && email !== 0 ? 1 : 0
    // 送られなかった項目（メールアドレスがなく画面に出さなかったメールなど）は、今の値のままにする
    const has = (f: string) => (Object.prototype.hasOwnProperty.call(v, f) ? 1 : 0)
    const setDigest = has('digest') || email === 0 ? 1 : 0
    for (const uid of userIds) {
      stmts.push(db.prepare(`INSERT INTO user_notification_prefs (user_id, company_id, pref_key, email, push, digest, updated_at) VALUES (?, COALESCE((SELECT company_id FROM users WHERE user_id = ?), ?), ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, pref_key) DO UPDATE SET email = CASE WHEN ? = 1 THEN excluded.email ELSE email END, push = CASE WHEN ? = 1 THEN excluded.push ELSE push END,
          digest = CASE WHEN ? = 1 THEN excluded.digest ELSE digest END, updated_at = excluded.updated_at`)
        .bind(uid, uid, companyId, key, email, push, digest, at, has('email'), has('push'), setDigest))
    }
  }
  if (stmts.length) await db.batch(stmts)
  return null
}
const ADMIN_GROUPS = NOTIFY_PREF_GROUPS.filter(g => g.audience === 'admin')
const STAFF_GROUPS = NOTIFY_PREF_GROUPS.filter(g => g.audience === 'staff')
notificationsAdminApi.get('/notification-prefs', async (c) => {
  const u = c.get('user')
  const prefs = await loadNotifyPrefs(c.env.DB, [u.user_id])
  return c.json({ groups: prefView(ADMIN_GROUPS, u.role, prefs.get(Number(u.user_id))), digest_hour: DIGEST_HOUR, has_email: !!u.email })
})
notificationsAdminApi.put('/notification-prefs', async (c) => {
  const u = c.get('user')
  if (!NOTIFY_ADMIN_ROLES.includes(u.role)) return c.json({ error: 'この設定は、会社の管理者のアカウントで行ってください' }, 403)
  const err = await savePrefs(c.env.DB, u.company_id, [u.user_id], ADMIN_GROUPS, await c.req.json().catch(() => null))
  if (err) return c.json({ error: err }, 400)
  const prefs = await loadNotifyPrefs(c.env.DB, [u.user_id])
  return c.json({ ok: true, groups: prefView(ADMIN_GROUPS, u.role, prefs.get(Number(u.user_id))) })
})
// スタッフは同じ人のすべての会社のユーザーに保存する（どの会社の通知も同じ設定で受け取る）
const staffUserIds = async (c: any): Promise<number[]> => {
  const u = c.get('user')
  const ids = (await personStaffRows(c.env.DB, u)).map(r => Number(r.user_id))
  return [...new Set([Number(u.user_id), ...ids])]
}
notificationsStaffApi.get('/notification-prefs', async (c) => {
  const u = c.get('user')
  const prefs = await loadNotifyPrefs(c.env.DB, [u.user_id])
  return c.json({ groups: prefView(STAFF_GROUPS, 'staff', prefs.get(Number(u.user_id))), has_email: !!u.email })
})
notificationsStaffApi.put('/notification-prefs', async (c) => {
  const u = c.get('user')
  const err = await savePrefs(c.env.DB, u.company_id, await staffUserIds(c), STAFF_GROUPS, await c.req.json().catch(() => null))
  if (err) return c.json({ error: err }, 400)
  const prefs = await loadNotifyPrefs(c.env.DB, [u.user_id])
  return c.json({ ok: true, groups: prefView(STAFF_GROUPS, 'staff', prefs.get(Number(u.user_id))) })
})

// ---------- 承認依頼のまとめメール（#284。digest）----------
// 「1日1回まとめて」を選んだ管理者に、毎朝 DIGEST_HOUR 時以降の最初の cron（15分おき）で、自社の承認待ちの件数を1通で知らせる。
// 承認待ちがなければ送らない。送る前に digest_sent_on を今日にして、同じ日に二度送らない。1回の起動で DIGEST_BATCH 人まで
export const DIGEST_HOUR = 8
const DIGEST_BATCH = 50
MAIL_TYPES.push('notification_digest')
export async function runNotificationDigests(env: NotifyEnv): Promise<{ due: number; sent: number; idle?: boolean }> {
  const now = nowJST()
  if (Number(now.slice(11, 13)) < DIGEST_HOUR) return { idle: true, due: 0, sent: 0 }
  const db = env.DB
  const today = now.slice(0, 10)
  const due = (await db.prepare(`SELECT p.user_id, u.company_id, u.name, u.email FROM user_notification_prefs p JOIN users u ON u.user_id = p.user_id
    WHERE p.pref_key = 'correction_request' AND p.digest = 1 AND COALESCE(p.email, 1) = 1 AND (p.digest_sent_on IS NULL OR p.digest_sent_on < ?)
      AND u.status = 'active' AND u.role IN (SELECT value FROM json_each(?)) ORDER BY p.user_id LIMIT ?`)
    .bind(today, JSON.stringify(NOTIFY_ADMIN_ROLES), DIGEST_BATCH).all()).results as any[]
  if (!due.length) return { idle: true, due: 0, sent: 0 }
  await db.prepare(`UPDATE user_notification_prefs SET digest_sent_on = ? WHERE pref_key = 'correction_request' AND user_id IN ${JSON_IN}`).bind(today, bindJsonArray(due.map(d => d.user_id))).run()
  const counts = new Map(((await db.prepare(`SELECT company_id, COUNT(*) AS n, MIN(created_at) AS oldest FROM attendance_corrections WHERE status = 'pending' AND company_id IN ${JSON_IN} GROUP BY company_id`)
    .bind(bindJsonArray(due.map(d => d.company_id))).all()).results as any[]).map(r => [Number(r.company_id), r]))
  const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '')
  const mails: SendEmailInput[] = []
  for (const d of due) {
    const cnt = counts.get(Number(d.company_id))
    const to = String(d.email || '').trim()
    if (!cnt || !Number(cnt.n) || !to) continue
    const title = `承認待ちの打刻修正が${Number(cnt.n)}件あります`
    const tpl = attendanceCorrectionEmail({ name: d.name, title, headline: '承認待ちの打刻修正の申請があります（1日1回のまとめのお知らせ）。内容を確認し、承認または却下してください。',
      lines: [['承認待ち', `${Number(cnt.n)}件`], ['いちばん古い申請', fmtAt(cnt.oldest)]], url: `${base}/admin#corrections`, button: '打刻修正承認を開く' })
    mails.push({ to, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'notification_digest', company_id: d.company_id })
  }
  if (mails.length) {
    try { await sendEmailBatch(env, mails) } catch (e) { console.log(`digest mail failed: ${e}`) }
  }
  return { due: due.length, sent: mails.length }
}

// ---------- プッシュ通知（#178）----------
const PUSH_FLUSH_LIMIT = 30      // 1回に取る push_queue の行数
const PUSH_SEND_LIMIT = 20       // 1回に送るプッシュの数（Free プランの CPU 時間・外部への fetch の数に収める）
const PUSH_MAX_FAILURES = 20     // 続けて失敗したら購読を消す
const PUSH_MAX_PER_USER = 10     // 1人の購読の上限（古いものから消す）
const PUSH_TEST_MINUTES = 10
const PUSH_STALE_CLAIM_MINUTES = 30
type PushEnv = NotifyEnv & VapidEnv
/** 積まれたプッシュを送る。送る分がなければ、問い合わせ1回で終わる */
export async function flushPushQueue(env: PushEnv, limit = PUSH_FLUSH_LIMIT): Promise<{ claimed: number; sent: number; failed: number; removed: number }> {
  const db = env.DB
  const res = { claimed: 0, sent: 0, failed: 0, removed: 0 }
  const has = await db.prepare('SELECT 1 FROM push_queue WHERE claimed_at IS NULL LIMIT 1').first()
  if (!has) return res
  // 取った行は、ほかの同時の送信では送らない（claimed_at）
  const rows = (await db.prepare(`UPDATE push_queue SET claimed_at = ? WHERE queue_id IN (SELECT queue_id FROM push_queue WHERE claimed_at IS NULL ORDER BY queue_id LIMIT ?)
    RETURNING queue_id, user_id, kind`).bind(nowJST(), limit).all()).results as any[]
  res.claimed = rows.length
  if (!rows.length) return res
  try {
    const userIds = [...new Set(rows.map(r => Number(r.user_id)))]
    const users = new Map(((await db.prepare(`SELECT user_id, role, status, person_id FROM users WHERE user_id IN ${JSON_IN}`).bind(bindJsonArray(userIds)).all()).results as any[])
      .map(u => [Number(u.user_id), u]))
    const prefs = await loadNotifyPrefs(db, userIds)
    const targets = new Set<number>()
    for (const r of rows) {
      const u = users.get(Number(r.user_id))
      if (u && u.status === 'active' && pushWanted(prefs, u.user_id, u.role, String(r.kind || ''))) targets.add(Number(u.user_id))
    }
    if (targets.size) {
      const persons = [...new Set([...targets].map(id => users.get(id)?.person_id).filter(Boolean))] as string[]
      // 同じ端末への複数の通知は、1回のプッシュにまとめる（端末は最新の未読を取りに来る）
      const subs = (await db.prepare(`SELECT subscription_id, endpoint FROM push_subscriptions
        WHERE user_id IN ${JSON_IN} OR person_id IN (SELECT value FROM json_each(?)) ORDER BY subscription_id`).bind(bindJsonArray([...targets]), JSON.stringify(persons)).all()).results as any[]
      const allowLocal = allowLocalPush(env)
      const updates: D1PreparedStatement[] = []
      for (const s of subs.slice(0, PUSH_SEND_LIMIT)) {
        if (!isAllowedPushEndpoint(s.endpoint, allowLocal)) { updates.push(db.prepare('DELETE FROM push_subscriptions WHERE subscription_id = ?').bind(s.subscription_id)); res.removed++; continue }
        const r = await sendWebPush(env, s.endpoint)
        if (r.ok) { res.sent++; updates.push(db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failures = 0, last_error = NULL WHERE subscription_id = ?').bind(nowJST(), s.subscription_id)) }
        else if (r.gone) { res.removed++; updates.push(db.prepare('DELETE FROM push_subscriptions WHERE subscription_id = ?').bind(s.subscription_id)) }
        else {
          res.failed++
          updates.push(db.prepare('UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE subscription_id = ?').bind(r.error || 'unknown', s.subscription_id))
          updates.push(db.prepare('DELETE FROM push_subscriptions WHERE subscription_id = ? AND failures >= ?').bind(s.subscription_id, PUSH_MAX_FAILURES))
        }
      }
      if (updates.length) await db.batch(updates)
    }
  } finally {
    await db.prepare(`DELETE FROM push_queue WHERE queue_id IN ${JSON_IN}`).bind(bindJsonArray(rows.map(r => r.queue_id))).run()
  }
  return res
}
/** 15分おきの cron: 残っているプッシュを送り、送れずに残った古い行を消す。端末側の失敗（push_failed）は定期処理の失敗にしない */
export async function runPushQueueJob(env: PushEnv) {
  const r = await flushPushQueue(env, PUSH_FLUSH_LIMIT * 2)
  const stale = await env.DB.prepare('DELETE FROM push_queue WHERE (claimed_at IS NOT NULL AND claimed_at < ?) OR created_at < ?')
    .bind(minutesAgoJST(PUSH_STALE_CLAIM_MINUTES), minutesAgoJST(24 * 60)).run()
  const purged = stale.meta.changes || 0
  // 何もなかった実行は idle を返す（cron_runs の記録を1行にまとめる。services/cron.ts）
  if (!r.claimed && !purged) return { idle: true, sent: 0 }
  return { claimed: r.claimed, sent: r.sent, push_failed: r.failed, removed: r.removed, purged }
}

// 購読の API（スタッフ本人）。購読はこの人（同じ人のほかの会社のユーザーを含む）のもの
const ownsSub = (u: any) => ({ sql: '(user_id = ? OR (person_id IS NOT NULL AND person_id = ?))', binds: [u.user_id, u.person_id || ''] })
notificationsStaffApi.get('/push/config', async (c) => {
  const u = c.get('user')
  let publicKey: string
  try { publicKey = (await loadVapid(c.env)).publicKey } catch (e) {
    console.log(`push: vapid load failed: ${e}`)
    return c.json({ available: false, error: 'プッシュ通知の準備ができていません' })
  }
  const o = ownsSub(u)
  const endpoint = c.req.query('endpoint') || ''
  const row = endpoint ? await c.env.DB.prepare(`SELECT subscription_id, last_success_at, last_error FROM push_subscriptions WHERE endpoint = ? AND ${o.sql}`).bind(endpoint, ...o.binds).first() as any : null
  const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE ${o.sql}`).bind(...o.binds).first() as any
  return c.json({ available: true, public_key: publicKey, subscribed: !!row, last_success_at: row?.last_success_at || null, last_error: row?.last_error || null, devices: Number(n?.n || 0) })
})
notificationsStaffApi.post('/push/subscribe', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  const endpoint = String(b?.endpoint || '')
  const keys = b?.keys && typeof b.keys === 'object' ? b.keys : {}
  const key = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,200}={0,2}$/.test(v) ? v : null)
  if (!isAllowedPushEndpoint(endpoint, allowLocalPush(c.env))) return c.json({ error: 'この端末のプッシュ通知の宛先は登録できません' }, 400)
  const p256dh = key(keys.p256dh), auth = key(keys.auth)
  if (!p256dh || !auth) return c.json({ error: '購読の情報が正しくありません' }, 400)
  const at = nowJST()
  const ua = String(c.req.header('User-Agent') || '').slice(0, 200)
  await c.env.DB.batch([
    // 同じ端末で別の人がログインし直して登録したときは、その端末の宛先を今の人に付け替える
    c.env.DB.prepare(`INSERT INTO push_subscriptions (company_id, user_id, person_id, endpoint, p256dh, auth, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET company_id = excluded.company_id, user_id = excluded.user_id, person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, updated_at = excluded.updated_at, failures = 0, last_error = NULL, test_requested_at = NULL`)
      .bind(u.company_id, u.user_id, u.person_id || null, endpoint, p256dh, auth, ua, at, at),
    c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND subscription_id NOT IN (SELECT subscription_id FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC, subscription_id DESC LIMIT ?)`)
      .bind(u.user_id, u.user_id, PUSH_MAX_PER_USER),
  ])
  return c.json({ ok: true })
})
notificationsStaffApi.post('/push/unsubscribe', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  const o = ownsSub(u)
  const r = await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND ${o.sql}`).bind(String(b?.endpoint || ''), ...o.binds).run()
  return c.json({ ok: true, removed: r.meta.changes || 0 })
})
// テスト通知: この端末にだけ、その場で送る（端末が取りに来たときにテストの文面を返す）
notificationsStaffApi.post('/push/test', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  const o = ownsSub(u)
  const s = await c.env.DB.prepare(`SELECT subscription_id, endpoint FROM push_subscriptions WHERE endpoint = ? AND ${o.sql}`).bind(String(b?.endpoint || ''), ...o.binds).first() as any
  if (!s) return c.json({ error: 'この端末はプッシュ通知を受け取る設定になっていません' }, 404)
  if (!isAllowedPushEndpoint(s.endpoint, allowLocalPush(c.env))) return c.json({ error: 'この端末のプッシュ通知の宛先には送れません' }, 400)
  await c.env.DB.prepare('UPDATE push_subscriptions SET test_requested_at = ? WHERE subscription_id = ?').bind(nowJST(), s.subscription_id).run()
  const r = await sendWebPush(c.env, s.endpoint)
  if (r.gone) await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE subscription_id = ?').bind(s.subscription_id).run()
  else if (r.ok) await c.env.DB.prepare('UPDATE push_subscriptions SET last_success_at = ?, failures = 0, last_error = NULL WHERE subscription_id = ?').bind(nowJST(), s.subscription_id).run()
  else await c.env.DB.prepare('UPDATE push_subscriptions SET last_error = ? WHERE subscription_id = ?').bind(r.error || 'unknown', s.subscription_id).run()
  if (!r.ok) return c.json({ error: r.gone ? 'この端末の購読は無効になっていました。もう一度「受け取る」を押してください' : 'プッシュ通知を送れませんでした。時間をおいてお試しください', reason: r.error }, 502)
  return c.json({ ok: true })
})
// 端末の Service Worker が、プッシュを受けたときに表示する内容を取りに来る（本文はプッシュに載せない）。
// 端末の購読が今ログインしている人のものでなければ（同じ端末で別の人がログインした後など）、中身を出さない
const PUSH_BODY_MAX = 120
notificationsStaffApi.get('/push/latest', async (c) => {
  const u = c.get('user')
  const generic = { title: 'Field OS', body: '新しい通知があります。アプリを開いて確認してください', link: '/staff#notifications', tag: 'fieldos' }
  const o = ownsSub(u)
  const s = await c.env.DB.prepare(`SELECT subscription_id, test_requested_at FROM push_subscriptions WHERE endpoint = ? AND ${o.sql}`).bind(c.req.query('endpoint') || '', ...o.binds).first() as any
  if (!s) return c.json({ ...generic, generic: true })
  if (s.test_requested_at && s.test_requested_at >= minutesAgoJST(PUSH_TEST_MINUTES)) {
    await c.env.DB.prepare('UPDATE push_subscriptions SET test_requested_at = NULL WHERE subscription_id = ?').bind(s.subscription_id).run()
    return c.json({ title: 'テスト通知', body: 'この端末でプッシュ通知を受け取れます', link: '/staff#notify-settings', tag: 'fieldos-test', test: true })
  }
  const ids = await staffUserIds(c)
  const rows = (await c.env.DB.prepare(`SELECT notification_id, user_id, kind, title, body, link FROM user_notifications WHERE user_id IN ${JSON_IN} AND read_at IS NULL
    ORDER BY notification_id DESC LIMIT 20`).bind(bindJsonArray(ids)).all()).results as any[]
  const prefs = await loadNotifyPrefs(c.env.DB, ids)
  const shown = rows.filter(r => pushWanted(prefs, r.user_id, 'staff', r.kind))
  if (!shown.length) return c.json({ ...generic, generic: true })
  const n = shown[0]
  // 開く先はスタッフ画面の中だけ（#shift/... など）。それ以外の通知は通知の一覧を開く
  const link = String(n.link || '')
  const hash = /^#[A-Za-z0-9_\-/=&.]{0,200}$/.test(link) ? link : /^\/staff#[A-Za-z0-9_\-/=&.]{0,200}$/.test(link) ? link.slice(6) : '#notifications'
  const body = String(n.body || '').replace(/\s+/g, ' ').trim()
  return c.json({ title: n.title, body: (body.length > PUSH_BODY_MAX ? body.slice(0, PUSH_BODY_MAX) + '…' : body) + (shown.length > 1 ? `（ほか${shown.length - 1}件の未読）` : ''),
    link: '/staff' + hash, tag: 'fieldos', notification_id: n.notification_id })
})
