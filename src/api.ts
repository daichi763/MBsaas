import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { JSON_IN, batchInChunks, bindJsonArray } from './lib/d1-chunk'
import { sendEmail, sendEmailBatch, mailMode } from './services/email'
import { passwordResetEmail } from './email-templates/password-reset'
import { noticeEmail } from './email-templates/notice'
import { runRetentionCleanup, listRetentionSchedule, validateRetiredAt, isRetirementEffective } from './services/retention'
import { buildUpdate } from './lib/update-builder'
import chatApi from './roster-chat'
import shiftBoardApi, { applyPricingToShift, stripMoney } from './shift-board'
import boardApi from './board'
import settlementApi, { syncActualFromReports } from './settlement'
import { recruitAdminApi, recruitPublicApi, recruitStaffApi } from './recruit'
import { staffMergeApi } from './staff-merge'
import { adminLifecycleApi, publicReportApi, modesForShifts, resolveModes } from './staff-lifecycle'
import reportSettingsApi, { REPORT_TYPES as ALL_REPORT_TYPES, ACTUAL_SYNC_TYPES, checkReportable } from './report-settings'
import { addDays, addMinutes, crossesMidnight, isWithin, reportableWindow, shiftWindow } from './lib/shift-time'
import { correctionsAdminApi, correctionsStaffApi } from './corrections'
import { notificationsAdminApi, notificationsStaffApi } from './notifications'
import {
  SESSION_COOKIE, SESSION_HOURS, LOGIN_WINDOW_MINUTES, hashPassword, verifyPassword, needsRehash, dummyVerify, validatePassword, normalizeEmail,
  hashToken, isCompanyActive, canLogin, revokeSessions, revokeCompanySessions, loadSessionUser, homePathFor, sessionCookieOptions,
  loginAttemptKeys, isLoginLocked, recordLoginFailure, clearLoginFailures,
} from './lib/auth'
import rosterApi, { staffSelfApi, personStaffRows, ensureRosterIdentity, loadRoster, createPerson, partnerNameConflict, propagateNameToLinked, ROSTER_BASE_FIELDS, ROSTER_BUSINESS_FIELDS, normalizeCareerRows, careerSummary, getRequiredFields, missingRequired, linkedStaffEmails } from './roster'
import { isHHMM, oneOf, pickReportValues, cleanFileName, CONSULT_CATEGORIES, CONSULT_URGENCIES } from './lib/validate'
import { ownProject, ownClient, ownStaff, ownNotice, ownShift } from './lib/tenant'

type Bindings = {
  DB: D1Database; PHOTOS: R2Bucket; DOCUMENTS: R2Bucket; CONTRACTS: R2Bucket
  RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string
  RETENTION_ENABLED?: string
  TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string
}
type Variables = { user: any }

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ============ Utils ============
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
function todayJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}
// 生年月日から満年齢を計算する（NULLならnull）
function calcAge(dob: string | null | undefined): number | null {
  if (!dob) return null
  const today = todayJST()
  const [ty, tm, td] = today.split('-').map(Number)
  const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number)
  let age = ty - by
  if (tm < bm || (tm === bm && td < bd)) age--
  return age
}
// 入社年月日から勤続年月（"n年mヶ月"）を計算する
function calcTenure(hireDate: string | null | undefined): string | null {
  if (!hireDate) return null
  const today = todayJST()
  const [ty, tm] = today.split('-').map(Number)
  const [hy, hm] = hireDate.slice(0, 10).split('-').map(Number)
  let months = (ty - hy) * 12 + (tm - hm)
  if (months < 0) months = 0
  return `${Math.floor(months / 12)}年${months % 12}ヶ月`
}
function monthJST(): string { return todayJST().slice(0, 7) }
function nowJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}
function genToken(): string {
  const a = new Uint8Array(32); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}
// 日本の年度（4/1〜翌3/31）。fiscal_year=2025 は 2025/04/01〜2026/03/31 を指す
function fiscalYearOf(dateStr: string): number {
  const y = Number(dateStr.slice(0, 4)); const m = Number(dateStr.slice(5, 7))
  return m >= 4 ? y : y - 1
}
function fiscalYearRange(fy: number): { start: string; end: string } {
  return { start: `${fy}-04-01`, end: `${fy + 1}-04-01` }
}
function currentFiscalYear(): number { return fiscalYearOf(todayJST()) }
function round1(n: number): number { return Math.round(n * 10) / 10 }

// 勤怠報告の種類（8 種類。順序・表示名は report-settings.ts）
const REPORT_TYPES: readonly string[] = ALL_REPORT_TYPES
// 写真添付が必須の報告種別（入店報告・退店報告のみ）
const PHOTO_REQUIRED_TYPES = ['check_in', 'check_out']
const PHOTO_MAX_BYTES = 500 * 1024 // 圧縮後の許容上限（500KB）
const PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png']

// companies.settings_json (JSON文字列) から真偽値設定を安全に読み取る
function getCompanySetting(u: any, key: string, defaultValue: boolean): boolean {
  try {
    const s = JSON.parse(u.settings_json || '{}')
    return typeof s[key] === 'boolean' ? s[key] : defaultValue
  } catch {
    return defaultValue
  }
}

// 案件の photo_required_override (NULL=会社設定に従う / 1=必須 / 0=不要) を加味した実効値
function resolvePhotoRequired(u: any, projectOverride: number | null | undefined): boolean {
  const companyDefault = getCompanySetting(u, 'photo_required_attendance', true)
  return projectOverride === null || projectOverride === undefined ? companyDefault : !!projectOverride
}
// system_admin（SaaS本部）は含めない。本部ユーザーは company_id=1 に所属しているため、
// /admin を操作できると本部の操作がテナント1のデータとして登録されてしまう。本部は /hq のみを使う。
const ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']

// ============ 勤怠の自動振り分け（フェーズH） ============
// 同一人物が複数企業に所属する場合、シフトの所有企業（shifts.company_id / staff_id）に基づいて
// 勤怠・日報を該当企業のスタッフ行に記録する。スタッフが企業を切り替える必要はない。
// 戻り値の staff は「そのシフトの持ち主（同一人物の該当企業のスタッフ行）」
async function resolvePersonShift(c: any, shiftId: any): Promise<{ shift: any; staff: { staff_id: number; company_id: number; settings_json: string } } | null> {
  const u = c.get('user')
  const rows = await personStaffRows(c.env.DB, u)
  if (!rows.length) return null
  const ids = rows.map(r => r.staff_id)
  const shift = await c.env.DB.prepare(`SELECT * FROM shifts WHERE shift_id = ? AND staff_id IN (${ids.map(() => '?').join(',')})`).bind(shiftId, ...ids).first()
  if (!shift) return null
  const staff = rows.find(r => r.staff_id === shift.staff_id)!
  if (shift.company_id !== staff.company_id) return null
  return { shift, staff }
}

// ============ お知らせ既読率レポート（集計・Cron共用ロジック） ============
// 対象者判定は /staff/notices の実クエリ（target_type: all/staff/project）と同じルールに揃える
type NoticeReadReport = {
  targetNoticeCount: number
  targetUserCount: number
  readCount: number
  unreadCount: number
  readRate: number | null
  perStaff: Map<number, { target: number; read: number }>
}

async function computeNoticeReadReport(db: D1Database, companyId: number, fiscalYear: number): Promise<NoticeReadReport> {
  const { start, end } = fiscalYearRange(fiscalYear)

  const staffRows = await db.prepare(
    `SELECT sp.staff_id, sp.user_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.company_id = ? AND u.role = 'staff' AND u.status = 'active'`
  ).bind(companyId).all()
  const staffList = staffRows.results as { staff_id: number; user_id: number }[]
  const staffById = new Map(staffList.map(s => [s.staff_id, s.user_id]))

  const noticeRows = await db.prepare(
    `SELECT notice_id, target_type, target_ids FROM notices WHERE company_id = ? AND published_at >= ? AND published_at < ?`
  ).bind(companyId, start, end).all()
  const notices = noticeRows.results as { notice_id: number; target_type: string; target_ids: string }[]

  const perStaff = new Map<number, { target: number; read: number }>()
  for (const s of staffList) perStaff.set(s.staff_id, { target: 0, read: 0 })
  let targetUserCount = 0
  let readCount = 0

  for (const n of notices) {
    let targetStaffIds: number[] = []
    if (n.target_type === 'all') {
      targetStaffIds = staffList.map(s => s.staff_id)
    } else if (n.target_type === 'staff') {
      const ids = new Set((n.target_ids || '').split(',').map(v => v.trim()).filter(Boolean).map(Number))
      targetStaffIds = staffList.filter(s => ids.has(s.staff_id)).map(s => s.staff_id)
    } else if (n.target_type === 'project') {
      const projIds = (n.target_ids || '').split(',').map(v => v.trim()).filter(Boolean)
      if (projIds.length) {
        const shiftRows = await db.prepare(`SELECT DISTINCT staff_id FROM shifts WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(projIds)).all()
        const projStaffIds = new Set((shiftRows.results as { staff_id: number }[]).map(r => r.staff_id))
        targetStaffIds = staffList.filter(s => projStaffIds.has(s.staff_id)).map(s => s.staff_id)
      }
    }
    if (targetStaffIds.length === 0) continue

    // 既読者はお知らせ単位で全件取り、対象者との突き合わせは手元で行う（在籍者を IN に並べると D1 のバインド上限 100 を超える）
    const readRows = await db.prepare(`SELECT user_id FROM notice_reads WHERE notice_id = ?`).bind(n.notice_id).all()
    const readUserIds = new Set((readRows.results as { user_id: number }[]).map(r => r.user_id))

    targetUserCount += targetStaffIds.length
    for (const sid of targetStaffIds) {
      const acc = perStaff.get(sid)!
      acc.target++
      if (readUserIds.has(staffById.get(sid) as number)) { acc.read++; readCount++ }
    }
  }

  return {
    targetNoticeCount: notices.length,
    targetUserCount,
    readCount,
    unreadCount: targetUserCount - readCount,
    readRate: targetUserCount > 0 ? round1((readCount / targetUserCount) * 100) : null,
    perStaff,
  }
}

// 指定会社・年度のレポートを再計算してUPSERT保存する（同一年度を何度実行しても重複しない）
async function generateNoticeReadReport(db: D1Database, companyId: number, fiscalYear: number): Promise<void> {
  const r = await computeNoticeReadReport(db, companyId, fiscalYear)

  await db.prepare(`
    INSERT INTO notice_read_reports (company_id, fiscal_year, target_notice_count, target_user_count, read_count, unread_count, read_rate, calculated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, fiscal_year) DO UPDATE SET
      target_notice_count = excluded.target_notice_count, target_user_count = excluded.target_user_count,
      read_count = excluded.read_count, unread_count = excluded.unread_count, read_rate = excluded.read_rate,
      calculated_at = excluded.calculated_at, updated_at = excluded.updated_at
  `).bind(companyId, fiscalYear, r.targetNoticeCount, r.targetUserCount, r.readCount, r.unreadCount, r.readRate, nowJST(), nowJST()).run()

  // スタッフ別は1人1文のまま、db.batch でまとめて書く（在籍者が多くても問い合わせ回数を抑える）
  const stmts: D1PreparedStatement[] = []
  for (const [staffId, v] of r.perStaff) {
    const rate = v.target > 0 ? round1((v.read / v.target) * 100) : null
    stmts.push(db.prepare(`
      INSERT INTO notice_read_staff_reports (company_id, fiscal_year, staff_id, target_count, read_count, unread_count, read_rate, calculated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, fiscal_year, staff_id) DO UPDATE SET
        target_count = excluded.target_count, read_count = excluded.read_count, unread_count = excluded.unread_count,
        read_rate = excluded.read_rate, calculated_at = excluded.calculated_at, updated_at = excluded.updated_at
    `).bind(companyId, fiscalYear, staffId, v.target, v.read, v.target - v.read, rate, nowJST(), nowJST()))
  }
  await batchInChunks(db, stmts)
}

// Cron: 全社について「直前に終了した年度」のレポートを生成/更新する（冪等）
export async function generateFiscalYearReportsForAllCompanies(db: D1Database): Promise<{ companies: number; ok: number; failed: number }> {
  const fy = currentFiscalYear() - 1 // まだ年度途中の当年度は対象外。確定済みの前年度を対象にする
  const companies = await db.prepare('SELECT company_id FROM companies').all()
  let ok = 0, failed = 0
  for (const row of companies.results as { company_id: number }[]) {
    try {
      await generateNoticeReadReport(db, row.company_id, fy)
      ok++
    } catch (e) {
      failed++
      console.log(`notice_read_reports generation failed: company_id=${row.company_id} fiscal_year=${fy} error=${e}`)
    }
  }
  return { companies: companies.results.length, ok, failed }
}

// Cron: 2年（730日）以上経過した notice_reads をバッチ削除する（1回のCronで最大10,000件、以降は翌日以降に継続）
export async function purgeOldNoticeReads(db: D1Database): Promise<{ deleted: number; batches: number; error?: string }> {
  const cutoff = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const BATCH_SIZE = 500
  const MAX_BATCHES = 20
  let deleted = 0
  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await db.prepare(`
        DELETE FROM notice_reads WHERE (notice_id, user_id) IN (
          SELECT notice_id, user_id FROM notice_reads WHERE read_at < ? LIMIT ?
        )
      `).bind(cutoff, BATCH_SIZE).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes < BATCH_SIZE) break
    }
    return { deleted, batches: Math.ceil(deleted / BATCH_SIZE) || 0 }
  } catch (e) {
    console.log(`notice_reads purge failed after deleting ${deleted}: error=${e}`)
    return { deleted, batches: 0, error: String(e) }
  }
}

// ============ Auth ============
// 会社コード・ID・パスワードのどれが違っても同じ文言・同じステータスで返す（会社コードの有無を推測されないように）
const LOGIN_FAILED_MESSAGE = '会社コード・ID・パスワードのいずれかが正しくありません'
const LOGIN_HELP = 'ログインできない場合は、所属の会社の担当者にお問い合わせください'
api.post('/auth/login', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const company_code = String(b.company_code ?? '').trim()
  const user_code = String(b.user_code ?? '').trim()
  const password = typeof b.password === 'string' ? b.password : ''
  if (!company_code || !user_code || !password) return c.json({ error: '入力内容が不足しています' }, 400)
  const db = c.env.DB

  const keys = await loginAttemptKeys(company_code, user_code, c.req.header('CF-Connecting-IP'))
  if (await isLoginLocked(db, keys)) {
    return c.json({ error: `ログインの失敗が続いたため、一時的にログインを止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください。${LOGIN_HELP}` }, 429)
  }

  const company = await db.prepare('SELECT * FROM companies WHERE company_code = ?').bind(company_code).first() as any
  const user = company
    ? await db.prepare('SELECT * FROM users WHERE company_id = ? AND user_code = ?').bind(company.company_id, user_code).first() as any
    : null
  // ログインできないロール（スタッフマスタだけの行・仮登録）は、パスワードが合っても通さない
  let passwordOk = false
  if (user && canLogin(user.role)) passwordOk = await verifyPassword(password, user.password_hash)
  else await dummyVerify(password)
  if (!passwordOk) {
    await recordLoginFailure(db, keys)
    return c.json({ error: LOGIN_FAILED_MESSAGE }, 401)
  }
  // パスワードが合ったときだけ、利用できない理由を伝える（アカウントの有無は漏れない）
  if (user.status !== 'active') return c.json({ error: `このアカウントは現在利用できません。${LOGIN_HELP}` }, 403)
  if (user.role !== 'system_admin' && !isCompanyActive(company.active_status)) {
    return c.json({ error: `ご契約が停止中のため、現在ご利用いただけません。${LOGIN_HELP}` }, 403)
  }
  await clearLoginFailures(db, keys)
  // 旧形式（ソルトなし SHA-256）のパスワードは、ここで PBKDF2 に作り直す
  if (needsRehash(user.password_hash)) {
    await db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').bind(await hashPassword(password), user.user_id).run()
  }

  // 同じ端末の古いセッション（Cookie で送られてきたもの）と、期限切れのセッションは消してから発行する
  const oldToken = getCookie(c, SESSION_COOKIE)
  if (oldToken) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(oldToken)).run()
  const nowIso = new Date().toISOString()
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.user_id, nowIso).run()
  const token = genToken()
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000)
  await db.prepare('INSERT INTO sessions (token, user_id, company_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), user.user_id, user.company_id, expires.toISOString()).run()
  await db.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').bind(nowJST(), user.user_id).run()
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c))

  return c.json({ ok: true, user: { user_id: user.user_id, name: user.name, role: user.role, company_name: company.company_name }, redirect: homePathFor(user.role) })
})

// パスワード再設定メールの送信リクエスト
// セキュリティ: メールアドレスの存在有無に関わらず常に同じレスポンスを返す（アカウント存在の推測を防ぐ）
api.post('/auth/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string }))
  const genericResponse = { ok: true, message: '登録されているメールアドレスの場合は、パスワード再設定メールを送信しました。数分たっても届かない場合は、所属の会社の担当者にお問い合わせください。' }
  // メールアドレスは前後の空白を除き、小文字にそろえて照合する（登録時の表記ゆれで届かないのを防ぐ）
  const email = normalizeEmail(body.email)
  if (!email) return c.json(genericResponse)

  // 簡易レート制限: 同一メールアドレスへの直近1時間のリクエストが5件を超えたら新規発行しない
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM password_reset_tokens t JOIN users u ON u.user_id = t.user_id WHERE LOWER(TRIM(u.email)) = ? AND t.created_at > datetime('now', '-1 hour')`
  ).bind(email).first()
  if (((recent?.n as number) || 0) >= 5) return c.json(genericResponse)

  // ログインできる行だけが対象（仮登録・スタッフマスタだけの行、退職者、停止中の企業の利用者は除く）
  const users = await c.env.DB.prepare(`SELECT u.user_id, u.name, u.user_code, u.email, u.company_id, co.company_name
    FROM users u JOIN companies co ON co.company_id = u.company_id
    WHERE LOWER(TRIM(u.email)) = ? AND u.status = 'active' AND u.role != 'roster_only'
      AND (COALESCE(co.active_status, 'active') != 'inactive' OR u.role = 'system_admin')`).bind(email).all()
  const EXPIRES_HOURS = 1
  for (const u of users.results as { user_id: number; name: string; user_code: string; email: string; company_id: number; company_name: string }[]) {
    const rawToken = genToken()
    const tokenHash = await hashToken(rawToken)
    const expiresAt = new Date(Date.now() + EXPIRES_HOURS * 3600 * 1000).toISOString()
    await c.env.DB.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .bind(u.user_id, tokenHash, expiresAt).run()

    const resetUrl = `${c.env.APP_BASE_URL}/reset-password?token=${rawToken}`
    // 同じメールアドレスに複数の会社のアカウントがあっても、どのアカウントのリンクか分かるように会社名とIDを入れる
    const tpl = passwordResetEmail({ name: u.name, resetUrl, expiresInHours: EXPIRES_HOURS, companyName: u.company_name, userCode: u.user_code })
    // レスポンスを待たせないため、実際の送信はバックグラウンドで行う
    c.executionCtx.waitUntil(sendEmail(c.env, { to: String(u.email).trim(), subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'password_reset', company_id: u.company_id }))
  }

  return c.json(genericResponse)
})

// パスワード再設定の実行（トークンは生の値では保存されておらずハッシュ照合、1回使用したら失効）
api.post('/auth/reset-password', async (c) => {
  const { token, password } = await c.req.json().catch(() => ({} as { token?: string; password?: string }))
  if (!token || !password) return c.json({ error: '入力内容が不足しています' }, 400)
  const pwErr = validatePassword(password)
  if (pwErr) return c.json({ error: pwErr }, 400)

  const tokenHash = await hashToken(token)
  // expires_at は ISO 8601 で保存しているので、同じ書式の現在時刻と比べる
  const row = await c.env.DB.prepare(
    `SELECT t.*, u.status AS user_status, u.role AS user_role FROM password_reset_tokens t JOIN users u ON u.user_id = t.user_id
     WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?`
  ).bind(tokenHash, new Date().toISOString()).first() as any
  if (!row || row.user_status !== 'active' || !canLogin(row.user_role)) return c.json({ error: 'このリンクは無効か、有効期限が切れています' }, 400)

  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').bind(await hashPassword(password), row.user_id).run()
  await c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .bind(nowJST(), row.user_id).run() // 同一ユーザーの他の未使用トークンも合わせて失効させる
  // 乗っ取られた場合に備え、既存のセッションはすべて切る（再設定後はログインし直す）
  await revokeSessions(c.env.DB, row.user_id)

  return c.json({ ok: true })
})

api.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token)).run()
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: new URL(c.req.url).protocol === 'https:' })
  return c.json({ ok: true })
})

// ログイン不要のシフト専用報告用URL（トークンで1シフトのみ操作可。src/staff-lifecycle.ts）。認証ミドルウェアより前に登録する
api.route('/public/report', publicReportApi)
// 公開の募集ページ（ログイン不要。src/recruit.ts）
api.route('/public/recruit', recruitPublicApi)

// 認証ミドルウェア
// /auth/login・/auth/logout などの公開ルートは、このミドルウェアより前に登録してあるのでここには来ない。
// 除外はパスの完全一致・前方一致だけで判定する（末尾一致だと /api/xxx/auth/login が認証なしで通るため）
api.use('/*', async (c, next) => {
  if (c.req.path.startsWith('/api/public/report/')) return next()
  if (c.req.path.startsWith('/api/public/recruit/')) return next()
  const token = getCookie(c, SESSION_COOKIE)
  const r = await loadSessionUser(c.env.DB, token)
  if (!r.ok) {
    // 退職・停止になった利用者のセッションは、その場で消す
    if (token && r.reason !== 'none') await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token)).run()
    if (r.reason === 'company_inactive') return c.json({ error: 'ご契約が停止中のため、現在ご利用いただけません', code: 'company_inactive' }, 403)
    return c.json({ error: 'unauthorized' }, 401)
  }
  c.set('user', r.user)
  return next()
})

api.get('/auth/me', (c) => {
  const u = c.get('user')
  return c.json({ user_id: u.user_id, name: u.name, role: u.role, company_name: u.company_name, staff_id: u.staff_id, company_id: u.company_id })
})

// 権限チェックミドルウェア
api.use('/admin/*', async (c, next) => {
  if (!ADMIN_ROLES.includes(c.get('user')?.role)) return c.json({ error: 'forbidden' }, 403)
  return next()
})
api.use('/hq/*', async (c, next) => {
  if (c.get('user')?.role !== 'system_admin') return c.json({ error: 'forbidden' }, 403)
  return next()
})
// スタッフ本人向け API（/api/staff/*）はスタッフのロールだけ（管理者・本部のセッションでは使えない）
api.use('/staff/*', async (c, next) => {
  if (c.get('user')?.role !== 'staff') return c.json({ error: 'forbidden' }, 403)
  return next()
})
// スタッフマスタ（企業間連携・4ルート作成）: /admin/* の権限ミドルウェア適用後に登録（src/roster.ts）
api.route('/admin/roster', rosterApi)
api.route('/staff/me', staffSelfApi)
// 企業間チャット（所属元⇔稼働先担当者）。/admin/* 配下のみ。スタッフ本人向けAPIには公開しない（src/roster-chat.ts）
api.route('/admin/roster-chat', chatApi)
// 常勤/スポットのシフトボード・募集枠・単価（請求/支払）。金額は /api/admin/* のみで返す（src/shift-board.ts）
api.route('/admin', shiftBoardApi)
// 所属区分の移行・仮登録・提出設定・代理入力・報告用URLの発行（src/staff-lifecycle.ts）
api.route('/admin', adminLifecycleApi)
// 実績の確定・請求/支払の集計・CSV出力（src/settlement.ts）
api.route('/admin', settlementApi)
// 募集ページ・応募の承認（src/recruit.ts）
api.route('/admin', recruitAdminApi)
// 仮登録スタッフと既存スタッフの統合（src/staff-merge.ts）
api.route('/admin', staffMergeApi)
api.route('/admin', reportSettingsApi)
api.route('/admin', correctionsAdminApi)
api.route('/staff', correctionsStaffApi)
api.route('/admin', notificationsAdminApi)
api.route('/staff', notificationsStaffApi)
// 案件掲示板（企業間の案件掲載・案件チャット・人材提案）。/admin/* 配下のみ（src/board.ts）
api.route('/admin/board', boardApi)
// スタッフアプリからの応募（src/recruit.ts）
api.route('/staff/recruit', recruitStaffApi)

// =========================================================
// スタッフ側 API
// =========================================================

// ---------- スタッフホーム ----------
// 取得はシフト・報告・日報・お知らせ・相談の部分関数に分け、ルートはそれを並べるだけにする
// 前日に始まった日をまたぐシフトを、終了予定から何時間ホームに出すか
const HOME_CARRYOVER_HOURS = 6

// シフト: 本日のシフトと、前日に始まった日をまたぐシフト（同一人物の全所属企業。欠勤を除く）
async function homeLoadShifts(db: D1Database, personIds: number[], today: string): Promise<any[]> {
  const rows = (await db.prepare(`
    SELECT s.*, p.project_name, p.project_type, p.report_template_id, p.photo_required_override, co.company_name AS shift_company_name
    FROM shifts s JOIN projects p ON s.project_id = p.project_id JOIN companies co ON co.company_id = s.company_id
    WHERE s.staff_id IN (${personIds.map(() => '?').join(',')}) AND s.work_date IN (?, ?) AND s.status != 'absent'
    ORDER BY s.work_date, s.start_time`).bind(...personIds, addDays(today, -1), today).all()).results as any[]
  return rows.filter(s => s.work_date === today || crossesMidnight(s))
}

// 報告: シフトごとの有効な報告（提出設定）と報告済みのもの
async function homeLoadReports(db: D1Database, shifts: any[]) {
  const out = new Map<number, { required_attendance: string[]; daily_report_required: boolean; reports: Record<string, any> }>()
  if (!shifts.length) return out
  const ids = shifts.map(s => s.shift_id as number)
  const modes = await modesForShifts(db, ids)
  for (const id of ids) {
    const m = modes.get(id)
    out.set(id, { required_attendance: m ? m.required_attendance : [...REPORT_TYPES], daily_report_required: m ? m.daily_report_required : true, reports: {} })
  }
  const rows = (await db.prepare(`SELECT shift_id, report_type, reported_at, status FROM attendance_reports WHERE shift_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results as any[]
  for (const r of rows) { const o = out.get(r.shift_id); if (o) o.reports[r.report_type] = { report_type: r.report_type, reported_at: r.reported_at, status: r.status } }
  return out
}

// 日報: 提出済みのシフト。shift_id で照合する（shift_id の無い古い日報と、同じ日・同じ案件の日報は稼働日・案件でも照合する）
async function homeLoadDailyReports(db: D1Database, shifts: any[]): Promise<Set<number>> {
  const done = new Set<number>()
  if (!shifts.length) return done
  const ids = shifts.map(s => s.shift_id as number)
  const staffIds = [...new Set(shifts.map(s => s.staff_id as number))]
  const dates = [...new Set(shifts.map(s => s.work_date as string))]
  const rows = (await db.prepare(`SELECT shift_id, staff_id, work_date, project_id FROM daily_reports
    WHERE shift_id IN (${ids.map(() => '?').join(',')}) OR (staff_id IN (${staffIds.map(() => '?').join(',')}) AND work_date IN (${dates.map(() => '?').join(',')}))`)
    .bind(...ids, ...staffIds, ...dates).all()).results as any[]
  for (const s of shifts) {
    if (rows.some(d => d.shift_id === s.shift_id || (d.staff_id === s.staff_id && d.work_date === s.work_date && d.project_id === s.project_id))) done.add(s.shift_id)
  }
  return done
}

// 対象のシフトを選ぶ。指定があればそれ。なければ
//   1. 前日からの日をまたぐシフトで、報告が残っているもの（夜勤明けの勤務終了・退店）
//   2. 本日のシフトで、報告が残っているもの（開始時刻順。報告の不要なシフトは飛ばす）
//   3. 報告は済んだが、日報が未提出のもの
//   4. 本日の最初のシフト
function homePickShift(items: any[], requestedId: number | null): any | null {
  if (requestedId) { const r = items.find(s => s.shift_id === requestedId); if (r) return r }
  return items.find(s => s.carryover && !s.attendance_done)
    || items.find(s => !s.carryover && !s.attendance_done)
    || items.find(s => s.daily_report_required && !s.daily_report_done)
    || items.find(s => !s.carryover) || items[0] || null
}

// お知らせ (対象: all / 所属案件 / 個人)
async function homeLoadNotices(db: D1Database, u: any) {
  return (await db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = ?) AS is_read
    FROM notices n WHERE n.company_id = ?
      AND (n.target_type = 'all'
        OR (n.target_type = 'staff' AND (',' || n.target_ids || ',') LIKE '%,' || ? || ',%')
        OR (n.target_type = 'project' AND EXISTS (
             SELECT 1 FROM shifts sh WHERE sh.staff_id = ? AND (',' || n.target_ids || ',') LIKE '%,' || sh.project_id || ',%')))
    ORDER BY n.published_at DESC LIMIT 5`).bind(u.user_id, u.company_id, u.staff_id, u.staff_id).all()).results
}

// 相談: 管理者から返信のある未完了の相談の件数
async function homeLoadConsultations(db: D1Database, u: any): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM consultations WHERE staff_id = ? AND status != 'done' AND manager_reply IS NOT NULL`).bind(u.staff_id).first()
  return (r?.n as number) || 0
}

// スタッフホーム。?shift_id= で対象のシフトを選べる（本日のシフトと前日からの日をまたぐシフトの中から）
api.get('/staff/home', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const today = todayJST(); const now = nowJST()
  // 勤怠の自動振り分け（フェーズH）: 同一人物の全所属企業のシフトから探す
  const personRows = await personStaffRows(db, u)
  const personIds = personRows.length ? personRows.map(r => r.staff_id) : [u.staff_id]
  const shifts = await homeLoadShifts(db, personIds, today)
  const status = await homeLoadReports(db, shifts)
  const dailyDone = await homeLoadDailyReports(db, shifts)

  const items = shifts.map(s => {
    const st = status.get(s.shift_id)!
    const next = st.required_attendance.find(t => !st.reports[t])
    return { ...s, ...st, carryover: s.work_date !== today, next_type: next || null,
      attendance_done: !next, daily_report_done: dailyDone.has(s.shift_id) }
  }).filter(s => {
    if (!s.carryover) return true
    // 前日からのシフトは、終了予定から HOME_CARRYOVER_HOURS 時間まで、残りの報告を受け付けている間か日報が未提出の間だけ出す
    const w = shiftWindow(s.work_date, s.start_time, s.end_time)
    if (now > addMinutes(w.end, HOME_CARRYOVER_HOURS * 60)) return false
    if (s.next_type) return isWithin(reportableWindow(s, s.next_type), now)
    return s.daily_report_required && !s.daily_report_done
  })
  const picked = homePickShift(items, Number(c.req.query('shift_id')) || null)
  const shift = picked ? shifts.find(s => s.shift_id === picked.shift_id) : null
  const shiftOwner = shift ? (personRows.find(r => r.staff_id === shift.staff_id) || { staff_id: u.staff_id, settings_json: u.settings_json }) : null

  const notices = await homeLoadNotices(db, u)
  const replied = await homeLoadConsultations(db, u)

  return c.json({
    today, shift: stripMoney(shift), carryover: !!picked?.carryover,
    reports: picked ? picked.reports : {}, daily_report_done: picked ? picked.daily_report_done : false,
    required_attendance: picked ? picked.required_attendance : [...REPORT_TYPES],
    daily_report_required: picked ? picked.daily_report_required : true, notices,
    replied_consultations: replied,
    // 写真必須設定はシフトの所有企業の設定に従う
    photo_required_attendance: resolvePhotoRequired(shiftOwner || u, shift ? (shift.photo_required_override as number | null) : undefined),
    // 本日の全シフト（複数企業・複数案件）と、前日からの日をまたぐシフト。他社のシフトは company_name で識別
    today_shifts: items.map(s => ({ shift_id: s.shift_id, work_date: s.work_date, project_id: s.project_id, project_name: s.project_name,
      start_time: s.start_time, end_time: s.end_time, company_name: s.shift_company_name, other_company: s.company_id !== u.company_id,
      checked_out: !!s.reports.check_out, carryover: s.carryover, attendance_done: s.attendance_done,
      daily_report_required: s.daily_report_required, daily_report_done: s.daily_report_done })),
  })
})

// 勤怠報告
api.post('/staff/attendance', async (c) => {
  const u = c.get('user')
  const { shift_id, report_type, latitude, longitude, address } = await c.req.json()
  if (!REPORT_TYPES.includes(report_type)) return c.json({ error: '不正な報告種別です' }, 400)
  // 勤怠の自動振り分け: シフトの所有企業・スタッフ行に記録する（同一人物の他社シフトも可）
  const resolved = await resolvePersonShift(c, shift_id)
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff: owner } = resolved
  const modes = (await modesForShifts(c.env.DB, [shift.shift_id])).get(shift.shift_id)
  // 有効な報告か・報告済みでないか・前の報告が済んでいるか（報告設定で OFF の報告は順序から除く）
  const done = new Set(((await c.env.DB.prepare('SELECT report_type FROM attendance_reports WHERE shift_id = ?').bind(shift.shift_id).all()).results as any[]).map(r => r.report_type))
  const ng = checkReportable(modes ? modes.required_attendance : [...REPORT_TYPES], done, report_type)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  if (PHOTO_REQUIRED_TYPES.includes(report_type)) {
    const proj = await c.env.DB.prepare('SELECT photo_required_override FROM projects WHERE project_id = ?').bind(shift.project_id).first()
    if (resolvePhotoRequired(owner, proj?.photo_required_override as number | null)) {
      return c.json({ error: 'この案件は写真の添付が必須です' }, 400)
    }
  }
  const dup = await c.env.DB.prepare('SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?').bind(shift_id, report_type).first()
  if (dup) return c.json({ error: 'すでに報告済みです' }, 409)

  // 遅延判定: 入店報告がシフト開始後なら late
  let status = 'normal'
  if (report_type === 'check_in') {
    const nowTime = nowJST().slice(11, 16)
    if (todayJST() === shift.work_date && nowTime > (shift.start_time as string)) status = 'late'
    if (latitude == null) status = status === 'late' ? 'late' : 'no_location'
  }
  await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(owner.company_id, owner.staff_id, shift_id, report_type, nowJST(), latitude ?? null, longitude ?? null, address ?? null, c.req.header('user-agent') || '', status).run()
  // 勤務開始・終了（なければ入店・退店）と休憩を実績（実働時間）に反映
  if (ACTUAL_SYNC_TYPES.includes(report_type)) await syncActualFromReports(c.env.DB, owner.company_id, Number(shift_id)).catch(() => {})
  return c.json({ ok: true, status })
})

// 勤怠報告（写真必須：入店報告・退店報告専用）
// フロント側で圧縮済みのJPEG/PNGをmultipart/form-dataで受け取り、R2へ保存する
api.post('/staff/attendance-photo', async (c) => {
  const u = c.get('user')

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: '送信データの形式が不正です' }, 400)
  }

  const shift_id = form.get('shift_id')
  const report_type = form.get('report_type')
  const latitude = form.get('latitude')
  const longitude = form.get('longitude')
  const photo = form.get('photo')

  if (typeof report_type !== 'string' || !PHOTO_REQUIRED_TYPES.includes(report_type)) {
    return c.json({ error: '不正な報告種別です' }, 400)
  }
  if (typeof shift_id !== 'string' || !shift_id) return c.json({ error: 'シフト情報が不正です' }, 400)
  if (!(photo instanceof File) || photo.size === 0) return c.json({ error: '写真が添付されていません' }, 400)
  if (!PHOTO_ALLOWED_TYPES.includes(photo.type)) return c.json({ error: '対応していない画像形式です（JPEG/PNGのみ）' }, 400)
  if (photo.size > PHOTO_MAX_BYTES) return c.json({ error: '画像サイズが大きすぎます。圧縮に失敗している可能性があります' }, 400)

  const resolved = await resolvePersonShift(c, shift_id)
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff: owner } = resolved
  const modes = (await modesForShifts(c.env.DB, [shift.shift_id])).get(shift.shift_id)
  const done = new Set(((await c.env.DB.prepare('SELECT report_type FROM attendance_reports WHERE shift_id = ?').bind(shift.shift_id).all()).results as any[]).map(r => r.report_type))
  const ng = checkReportable(modes ? modes.required_attendance : [...REPORT_TYPES], done, report_type)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)

  let status = 'normal'
  const lat = latitude != null && latitude !== '' ? Number(latitude) : null
  const lng = longitude != null && longitude !== '' ? Number(longitude) : null
  if (report_type === 'check_in') {
    const nowTime = nowJST().slice(11, 16)
    if (todayJST() === shift.work_date && nowTime > (shift.start_time as string)) status = 'late'
    if (lat == null) status = status === 'late' ? 'late' : 'no_location'
  }

  const ext = photo.type === 'image/png' ? 'png' : 'jpg'
  const key = `attendance/${owner.company_id}/${owner.staff_id}/${shift_id}/${report_type}_${Date.now()}.${ext}`

  try {
    const buf = await photo.arrayBuffer()
    await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: photo.type } })
  } catch {
    return c.json({ error: '写真のアップロードに失敗しました。通信環境を確認して再度お試しください' }, 502)
  }

  try {
    await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, photo_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(owner.company_id, owner.staff_id, shift_id, report_type, nowJST(), lat, lng, null, c.req.header('user-agent') || '', status, key).run()
  } catch {
    // DB登録に失敗した場合はアップロード済みの写真を掃除する
    await c.env.PHOTOS.delete(key).catch(() => {})
    return c.json({ error: '報告の登録に失敗しました。もう一度お試しください' }, 500)
  }
  await syncActualFromReports(c.env.DB, owner.company_id, Number(shift_id)).catch(() => {})

  return c.json({ ok: true, status, photo_key: key })
})

// 勤怠報告に添付された写真の取得（同一会社のログインユーザーのみ閲覧可）
api.get('/staff/attendance-photo/*', async (c) => {
  const u = c.get('user')
  const key = c.req.path.replace('/api/staff/attendance-photo/', '')
  if (!key.startsWith(`attendance/${u.company_id}/`)) return c.json({ error: 'forbidden' }, 403)

  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.json({ error: 'not found' }, 404)
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
    'Cache-Control': 'private, max-age=3600',
  })
})

// 日報テンプレート取得
api.get('/staff/report-template/:projectId', async (c) => {
  const u = c.get('user')
  // 他社シフトの案件でも日報テンプレートを取得できるよう、同一人物の所属企業の案件を対象にする
  const cids = [...new Set([(u.company_id as number), ...(await personStaffRows(c.env.DB, u)).map(r => r.company_id)])]
  const p = await c.env.DB.prepare(`SELECT report_template_id FROM projects WHERE project_id = ? AND company_id IN (${cids.map(() => '?').join(',')})`).bind(c.req.param('projectId'), ...cids).first()
  if (!p) return c.json({ error: 'not found' }, 404)
  const t = await c.env.DB.prepare('SELECT * FROM report_templates WHERE template_id = ?').bind(p.report_template_id).first()
  return c.json({ template: t ? { ...t, fields: JSON.parse(t.fields_json as string) } : null })
})

// 日報提出
api.post('/staff/daily-report', async (c) => {
  const u = c.get('user')
  const { project_id, shift_id, work_date, values, incident_flag, complaint_flag } = await c.req.json()
  const date = work_date || todayJST()
  // 勤怠の自動振り分け: shift_id があればシフトの所有企業に記録。無い場合は従来どおりログイン中の企業
  let owner = { company_id: u.company_id as number, staff_id: u.staff_id as number }
  if (shift_id) {
    const resolved = await resolvePersonShift(c, shift_id)
    if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
    owner = resolved.staff
  }
  // values のキーは案件の日報テンプレートの項目に限る（キーは管理画面に表示されるため、任意の文字列を保存させない）
  const tpl = await c.env.DB.prepare('SELECT rt.fields_json FROM projects p LEFT JOIN report_templates rt ON rt.template_id = p.report_template_id WHERE p.project_id = ?').bind(project_id ?? null).first<{ fields_json: string | null }>()
  const picked = pickReportValues(tpl?.fields_json, values)
  if ('error' in picked) return c.json({ error: picked.error }, 400)
  const valuesJson = JSON.stringify(picked.values)
  const exists = await c.env.DB.prepare('SELECT daily_report_id FROM daily_reports WHERE staff_id = ? AND work_date = ? AND project_id = ?').bind(owner.staff_id, date, project_id).first()
  if (exists) {
    await c.env.DB.prepare('UPDATE daily_reports SET report_values = ?, incident_flag = ?, complaint_flag = ?, submitted_at = ? WHERE daily_report_id = ?')
      .bind(valuesJson, incident_flag ? 1 : 0, complaint_flag ? 1 : 0, nowJST(), exists.daily_report_id).run()
    return c.json({ ok: true, updated: true })
  }
  await c.env.DB.prepare(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(owner.company_id, owner.staff_id, project_id, shift_id ?? null, date, valuesJson, incident_flag ? 1 : 0, complaint_flag ? 1 : 0, nowJST()).run()
  return c.json({ ok: true })
})

// 自分の日報一覧
api.get('/staff/my-reports', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT dr.*, p.project_name FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    WHERE dr.staff_id = ? ORDER BY dr.work_date DESC LIMIT 30`).bind(u.staff_id).all()
  return c.json({ reports: rows.results.map((r: any) => ({ ...r, values: JSON.parse(r.report_values) })) })
})

// シフト確認
api.get('/staff/shifts', async (c) => {
  const u = c.get('user')
  const month = c.req.query('month') || monthJST()
  // 同一人物の全所属企業のシフトを表示（他社分は company_name で識別）
  const ids = (await personStaffRows(c.env.DB, u)).map(r => r.staff_id)
  if (!ids.length) ids.push(u.staff_id)
  const rows = await c.env.DB.prepare(`
    SELECT s.*, p.project_name, co.company_name, (s.company_id != ?) AS other_company FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN companies co ON co.company_id = s.company_id
    WHERE s.staff_id IN (${ids.map(() => '?').join(',')}) AND s.work_date LIKE ? ORDER BY s.work_date, s.start_time`).bind(u.company_id, ...ids, month + '%').all()
  return c.json({ shifts: (rows.results as any[]).map(stripMoney), month })
})

// シフト希望提出
api.post('/staff/shifts/request', async (c) => {
  const u = c.get('user')
  const { work_date, start_time, end_time, project_id, memo } = await c.req.json()
  if (!work_date) return c.json({ error: '日付は必須です' }, 400)
  if ((start_time && !isHHMM(start_time)) || (end_time && !isHHMM(end_time))) return c.json({ error: '時刻は HH:MM の形式で入力してください' }, 400)
  await c.env.DB.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, registered_by, memo)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`)
    .bind(u.company_id, u.staff_id, project_id || 0, work_date, start_time || '09:30', end_time || '19:00', u.user_id, memo || '希望提出').run()
  return c.json({ ok: true })
})

// お知らせ
api.get('/staff/notices', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = ?) AS is_read
    FROM notices n WHERE n.company_id = ?
      AND (n.target_type = 'all'
        OR (n.target_type = 'staff' AND (',' || n.target_ids || ',') LIKE '%,' || ? || ',%')
        OR (n.target_type = 'project' AND EXISTS (
             SELECT 1 FROM shifts sh WHERE sh.staff_id = ? AND (',' || n.target_ids || ',') LIKE '%,' || sh.project_id || ',%')))
    ORDER BY n.published_at DESC LIMIT 50`).bind(u.user_id, u.company_id, u.staff_id, u.staff_id).all()
  return c.json({ notices: rows.results })
})

api.post('/staff/notices/:id/read', async (c) => {
  const u = c.get('user')
  // 自社のお知らせで、本人が配信対象のものだけ既読にできる
  const n = await ownNotice(c.env.DB, u.company_id, c.req.param('id'))
  const targets = n ? await resolveNoticeTargets(c.env.DB, u.company_id, n.target_type, n.target_ids) : []
  if (!targets.some(t => t.user_id === u.user_id)) return c.json({ error: 'お知らせが見つかりません' }, 404)
  await c.env.DB.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?, ?)').bind(c.req.param('id'), u.user_id).run()
  return c.json({ ok: true })
})

// 自分の実績
api.get('/staff/performance', async (c) => {
  const u = c.get('user')
  const month = c.req.query('month') || monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT dr.work_date, dr.report_values, p.project_name, p.show_performance, dr.manager_comment
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    WHERE dr.staff_id = ? AND dr.work_date LIKE ? ORDER BY dr.work_date`).bind(u.staff_id, month + '%').all()
  const visible = rows.results.filter((r: any) => r.show_performance)
  const totals: Record<string, number> = {}
  const daily: any[] = []
  for (const r of visible as any[]) {
    const v = JSON.parse(r.report_values)
    const day: any = { date: r.work_date, project: r.project_name, comment: r.manager_comment }
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number') { totals[k] = (totals[k] || 0) + val; day[k] = val }
    }
    daily.push(day)
  }
  return c.json({ month, totals, daily })
})

// 相談・連絡
api.get('/staff/consultations', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare('SELECT * FROM consultations WHERE staff_id = ? ORDER BY created_at DESC LIMIT 30').bind(u.staff_id).all()
  return c.json({ consultations: rows.results })
})

api.post('/staff/consultations', async (c) => {
  const u = c.get('user')
  const { category, body, urgency, target_project_id, target_date } = await c.req.json()
  if (!category || !body) return c.json({ error: 'カテゴリと内容は必須です' }, 400)
  if (!oneOf(category, CONSULT_CATEGORIES)) return c.json({ error: 'カテゴリが正しくありません' }, 400)
  if (urgency && !oneOf(urgency, CONSULT_URGENCIES)) return c.json({ error: '緊急度が正しくありません' }, 400)
  await c.env.DB.prepare(`INSERT INTO consultations (company_id, staff_id, category, body, urgency, target_project_id, target_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, u.staff_id, category, body, urgency || 'normal', target_project_id ?? null, target_date ?? null, nowJST()).run()
  return c.json({ ok: true })
})

// =========================================================
// 管理者側 API
// =========================================================

// 管理者ダッシュボード
api.get('/admin/dashboard', async (c) => {
  const u = c.get('user'); const today = todayJST(); const month = monthJST()
  const db = c.env.DB; const cid = u.company_id

  // 本日のシフト + 勤怠状況
  const shifts = await db.prepare(`
    SELECT s.shift_id, s.staff_id, s.start_time, s.end_time, s.status, s.unit_price, s.location,
           p.project_id, p.project_name, us.name AS staff_name,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'wake_up') AS wake_up,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'departure') AS departure,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'check_in') AS check_in,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'check_out') AS check_out,
           (SELECT GROUP_CONCAT(a.report_type) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS done_types
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id
    JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date = ? AND s.status IN ('confirmed','substitute')`).bind(cid, today).all()

  const active = shifts.results as any[]
  const revenue = active.reduce((a, s) => a + (s.unit_price || 0), 0)
  // 提出設定で「不要」の報告は未報告アラートの対象外（第2段階）
  const todayModes = await modesForShifts(db, active.map(s => s.shift_id))
  const needs = (s: any, t: string) => (todayModes.get(s.shift_id)?.required_attendance ?? REPORT_TYPES).includes(t)
  // 画面の報告状況の列: シフトごとの有効な報告と報告済みの種類
  for (const s of active) {
    s.required_types = todayModes.get(s.shift_id)?.required_attendance ?? [...REPORT_TYPES]
    s.done_types = String(s.done_types || '').split(',').filter(Boolean)
  }

  // 昨日までの日報未提出 (直近3日)
  const missingReports = await db.prepare(`
    SELECT s.shift_id, s.work_date, us.name AS staff_name, s.staff_id, p.project_name
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status = 'confirmed' AND s.work_date < ? AND s.work_date >= date(?, '-3 days')
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.staff_id = s.staff_id AND dr.work_date = s.work_date)
    ORDER BY s.work_date DESC`).bind(cid, today, today).all()
  // 日報「不要」のシフトは未提出の対象外（第2段階）
  {
    const m = await modesForShifts(db, (missingReports.results as any[]).map(r => r.shift_id))
    missingReports.results = (missingReports.results as any[]).filter(r => m.get(r.shift_id)?.daily_report_required !== false)
  }

  // インシデント (直近7日)
  const incidents = await db.prepare(`
    SELECT dr.work_date, dr.incident_flag, dr.complaint_flag, us.name AS staff_name, dr.staff_id, p.project_name, dr.report_values
    FROM daily_reports dr
    JOIN projects p ON dr.project_id = p.project_id
    JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ? AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date >= date(?, '-7 days')
    ORDER BY dr.work_date DESC`).bind(cid, today).all()

  // 要フォロースタッフ
  const followStaff = await db.prepare(`
    SELECT sp.staff_id, us.name, sp.retention_risk, sp.memo, sp.evaluation_score
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.company_id = ? AND (sp.follow_flag = 1 OR sp.retention_risk != 'low')`).bind(cid).all()

  // 今月の案件別実績
  const projPerf = await db.prepare(`
    SELECT p.project_id, p.project_name,
      COUNT(dr.daily_report_id) AS report_count,
      SUM(COALESCE(json_extract(dr.report_values, '$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(dr.report_values, '$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(dr.report_values, '$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(dr.report_values, '$.kishuhen'),0)) AS kishuhen,
      SUM(COALESCE(json_extract(dr.report_values, '$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(dr.report_values, '$.seiyaku'),0)) AS seiyaku
    FROM projects p LEFT JOIN daily_reports dr ON dr.project_id = p.project_id AND dr.work_date LIKE ?
    WHERE p.company_id = ? AND p.status = 'active' GROUP BY p.project_id`).bind(month + '%', cid).all()

  // 未対応の相談
  const openConsults = await db.prepare(`
    SELECT co.*, us.name AS staff_name FROM consultations co
    JOIN staff_profiles sp ON co.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE co.company_id = ? AND co.status = 'open' ORDER BY co.created_at DESC`).bind(cid).all()

  // ===== 管理者ToDo (ルールベース) =====
  const todos: any[] = []
  // ルール1: 日報未提出3回以上
  const drCounts: Record<string, { name: string; count: number; staff_id: number }> = {}
  for (const m of missingReports.results as any[]) {
    const k = String(m.staff_id)
    drCounts[k] = drCounts[k] || { name: m.staff_name, count: 0, staff_id: m.staff_id }
    drCounts[k].count++
  }
  for (const v of Object.values(drCounts)) {
    if (v.count >= 3) todos.push({ level: 'high', text: `${v.name}さんが${v.count}日連続で日報未提出です。面談してください。`, staff_id: v.staff_id })
    else if (v.count >= 1) todos.push({ level: 'mid', text: `${v.name}さんの日報が${v.count}件未提出です。リマインドしてください。`, staff_id: v.staff_id })
  }
  // ルール2: 入店報告遅れが月2回以上
  const lateRows = await db.prepare(`
    SELECT a.staff_id, us.name, COUNT(*) AS n FROM attendance_reports a
    JOIN staff_profiles sp ON a.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE a.company_id = ? AND a.report_type = 'check_in' AND a.status = 'late' AND a.reported_at LIKE ?
    GROUP BY a.staff_id HAVING n >= 2`).bind(cid, month + '%').all()
  for (const r of lateRows.results as any[]) {
    todos.push({ level: 'mid', text: `${r.name}さんの入店報告が今月${r.n}回遅れています。前日確認を強化してください。`, staff_id: r.staff_id })
  }
  // ルール3: 欠勤が月2回以上
  const absRows = await db.prepare(`
    SELECT s.staff_id, us.name, COUNT(*) AS n FROM shifts s
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status = 'absent' AND s.work_date LIKE ? GROUP BY s.staff_id HAVING n >= 2`).bind(cid, month + '%').all()
  for (const r of absRows.results as any[]) {
    todos.push({ level: 'high', text: `${r.name}さんの欠勤が今月${r.n}回です。離職リスク中として体調・状況確認をしてください。`, staff_id: r.staff_id })
  }
  // ルール4: インシデント増加案件
  const incByProj: Record<string, number> = {}
  for (const i of incidents.results as any[]) incByProj[i.project_name] = (incByProj[i.project_name] || 0) + 1
  for (const [pname, n] of Object.entries(incByProj)) {
    if (n >= 1) todos.push({ level: n >= 2 ? 'high' : 'mid', text: `${pname}で直近7日にインシデント/クレームが${n}件発生しています。内容を確認しクライアント共有を検討してください。` })
  }
  // ルール5: 未対応相談
  for (const co of openConsults.results as any[]) {
    todos.push({ level: co.urgency === 'high' ? 'high' : 'mid', text: `${co.staff_name}さんから相談（${catLabel(co.category)}）が届いています。返信してください。`, staff_id: co.staff_id })
  }

  return c.json({
    today, month,
    working_count: active.length,
    revenue_forecast: revenue,
    shifts: active,
    unreported: {
      wake_up: active.filter(s => !s.wake_up && needs(s, 'wake_up')).map(s => ({ staff_id: s.staff_id, name: s.staff_name, project: s.project_name })),
      departure: active.filter(s => !s.departure && needs(s, 'departure')).map(s => ({ staff_id: s.staff_id, name: s.staff_name, project: s.project_name })),
      check_in: active.filter(s => !s.check_in && needs(s, 'check_in')).map(s => ({ staff_id: s.staff_id, name: s.staff_name, project: s.project_name })),
    },
    missing_daily_reports: missingReports.results,
    incidents: (incidents.results as any[]).map(i => ({ ...i, values: JSON.parse(i.report_values) })),
    follow_staff: followStaff.results,
    project_performance: projPerf.results,
    open_consultations: openConsults.results,
    todos: todos.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1)),
    photo_required_attendance: getCompanySetting(u, 'photo_required_attendance', true),
  })
})

// 入店/退店報告の写真添付必須設定を切り替え
api.post('/admin/settings/photo-required', async (c) => {
  const u = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return c.json({ error: '不正なパラメータです' }, 400)

  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  let settings: Record<string, any> = {}
  try { settings = JSON.parse((row?.settings_json as string) || '{}') } catch { settings = {} }
  settings.photo_required_attendance = body.enabled

  await c.env.DB.prepare('UPDATE companies SET settings_json = ? WHERE company_id = ?')
    .bind(JSON.stringify(settings), u.company_id).run()

  return c.json({ ok: true, photo_required_attendance: body.enabled })
})

function catLabel(cat: string): string {
  const m: Record<string, string> = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
  return m[cat] || cat
}

// スタッフ一覧
api.get('/admin/staff', async (c) => {
  const u = c.get('user'); const month = monthJST(); const today = todayJST()
  await ensureRosterIdentity(c.env.DB, u.company_id) // person_id 未採番の行を補完（seed後投入・他経路INSERT対策）
  const rows = await c.env.DB.prepare(`
    SELECT sp.staff_id, sp.evaluation_score, sp.retention_risk, sp.follow_flag,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.skills ELSE sp.skills END AS skills,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.work_area ELSE sp.work_area END AS work_area,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana,
           COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type, sp.affiliation, sp.employment_status, sp.is_provisional, sp.merged_into_staff_id, sp.board_proposal_id, us.phone,
           oc.company_name AS owner_company_name, CASE WHEN sp.affiliation_type = 'linked_external' THEN sp.relink_code ELSE pe.global_staff_code END AS global_staff_code,
           us.user_id, us.user_code, us.name, us.status, us.role AS user_role,
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_days,
           (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date <= ? AND s.status = 'confirmed') AS last_work_date,
           (SELECT MAX(dr.work_date) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id) AS last_report_date,
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date = ?) AS today_shift,
           (SELECT COUNT(*) FROM attendance_reports a JOIN shifts s2 ON a.shift_id = s2.shift_id WHERE a.staff_id = sp.staff_id AND s2.work_date = ? AND a.report_type = 'check_in') AS today_checkin,
           (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id AND dr.work_date LIKE ?) AS month_seiyaku,
           (SELECT GROUP_CONCAT(DISTINCT p.project_name) FROM shifts s3 JOIN projects p ON s3.project_id = p.project_id WHERE s3.staff_id = sp.staff_id AND s3.work_date LIKE ?) AS projects
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ? ORDER BY sp.staff_id`).bind(month + '%', today, today, today, month + '%', month + '%', u.company_id).all()
  return c.json({ staff: rows.results })
})

// 第2段階: 自社日雇い（daily_worker）・個人事業主（freelance）は従業員管理がないため、スタッフマスタで編集する
const STAFF_MASTER_EDITABLE_TYPES = ['partner_manual', 'skillsheet_only', 'daily_worker', 'freelance']
// スタッフ詳細
api.get('/admin/staff/:id', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const db = c.env.DB
  // 基本項目は linked_external（他社から連携）の場合、所属元企業の値で解決される（src/roster.ts）
  const profile = await loadRoster(db, sid, u.company_id)
  if (!profile) return c.json({ error: 'not found' }, 404)
  // 自社雇用者は従業員管理（社員名簿）の連絡先をそのまま表示する
  if (profile.affiliation_type === 'own_employee') {
    const er = await db.prepare('SELECT phone_main, personal_email, employee_number, department, job_title FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sid, u.company_id).first()
    if (er) Object.assign(profile, { emp_phone: er.phone_main, emp_email: er.personal_email, employee_number: er.employee_number, department: er.department, job_title: er.job_title })
  }
  // 画面の編集可否（APIでも同じ判定で制御している）
  profile.can_edit_in_master = STAFF_MASTER_EDITABLE_TYPES.includes(profile.affiliation_type) && profile.can_edit_base && !profile.merged_into_staff_id
  // 業務側項目（通勤・稼働開始・エリア・スキル・経歴・PR・備考）は他社連携以外の全区分で編集可
  profile.can_edit_business = canEditBusiness(profile)
  profile.career_rows = parseCareerRows(profile.career_rows)
  // 掲示板経由で取り込んだ行: 直前の提案企業名だけを返す（経路は出さない）
  if (profile.board_proposal_id) {
    const bp = await db.prepare(`SELECT co.company_name, p.thread_id FROM board_proposals p JOIN companies co ON co.company_id = p.proposer_company_id
      WHERE p.proposal_id = ? AND p.receiver_company_id = ?`).bind(profile.board_proposal_id, u.company_id).first() as any
    profile.board_source = bp ? { proposer_company_name: bp.company_name, thread_id: bp.thread_id } : null
  }

  const [shifts, attendance, reports, evals, follows] = await Promise.all([
    db.prepare(`SELECT s.*, p.project_name FROM shifts s JOIN projects p ON s.project_id = p.project_id WHERE s.staff_id = ? ORDER BY s.work_date DESC LIMIT 30`).bind(sid).all(),
    db.prepare(`SELECT a.*, s.work_date FROM attendance_reports a JOIN shifts s ON a.shift_id = s.shift_id WHERE a.staff_id = ? ORDER BY a.reported_at DESC LIMIT 40`).bind(sid).all(),
    db.prepare(`SELECT dr.*, p.project_name FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id WHERE dr.staff_id = ? ORDER BY dr.work_date DESC LIMIT 20`).bind(sid).all(),
    db.prepare(`SELECT * FROM evaluations WHERE staff_id = ? ORDER BY evaluation_period DESC LIMIT 6`).bind(sid).all(),
    db.prepare(`SELECT f.*, um.name AS manager_name FROM follow_logs f LEFT JOIN users um ON f.manager_id = um.user_id WHERE f.staff_id = ? ORDER BY f.created_at DESC LIMIT 20`).bind(sid).all(),
  ])
  // 月次実績推移 (直近3ヶ月)
  const perf = await db.prepare(`
    SELECT substr(work_date, 1, 7) AS ym,
      SUM(COALESCE(json_extract(report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(report_values,'$.seiyaku'),0)) AS seiyaku,
      COUNT(*) AS days
    FROM daily_reports WHERE staff_id = ? GROUP BY ym ORDER BY ym DESC LIMIT 3`).bind(sid).all()

  return c.json({
    profile: { ...profile, age: calcAge(profile.date_of_birth as string | null) },
    shifts: shifts.results,
    attendance: attendance.results,
    reports: (reports.results as any[]).map(r => ({ ...r, values: JSON.parse(r.report_values) })),
    evaluations: evals.results,
    follow_logs: follows.results,
    performance: perf.results,
  })
})

// スタッフ更新 (メモ・フォローフラグ・リスク)
// ============ スタッフ基本情報の更新（スタッフマスタ / 従業員管理 共通） ============
// 編集できる画面の振り分け（社員名簿=労務側 / スタッフマスタ=業務側）:
//  - 業務側項目（ROSTER_BUSINESS_FIELDS: 通勤可能時間・稼働開始可能日・稼働可能エリア・スキル・経歴・PRポイント・備考）
//      : linked_external 以外の全区分（自社雇用を含む）でスタッフマスタ画面から編集可
//  - それ以外の基本項目（氏名・フリガナ・性別・生年月日・所属・最寄駅・在籍状況 等）
//      own_employee（自社雇用）      : 従業員管理画面からのみ
//      partner_manual / skillsheet_only / daily_worker / freelance: スタッフマスタ画面から編集可
//  - linked_external（他社連携）    : 所属元企業が管理するため編集不可
//  - 管理者メモ・要フォロー・稼働先追記項目 は全スタッフでスタッフマスタ画面から編集可
const PROFILE_BASE_KEYS = ['name', 'employment_status', 'retired_at', ...(ROSTER_BASE_FIELDS as readonly string[])]
const BUSINESS_KEYS = ROSTER_BUSINESS_FIELDS as readonly string[]
function touchesProfileBase(body: any): boolean {
  return PROFILE_BASE_KEYS.some(k => body[k] !== undefined && !BUSINESS_KEYS.includes(k))
}
function touchesBusiness(body: any): boolean {
  return BUSINESS_KEYS.some(k => body[k] !== undefined)
}
function canEditBusiness(roster: any): boolean {
  return roster.affiliation_type !== 'linked_external' && !!roster.can_edit_base && !roster.merged_into_staff_id
}
function parseCareerRows(v: any): any[] {
  if (Array.isArray(v)) return v
  try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch { return [] }
}
/** 業務側項目の入力を検証・正規化する（経歴テーブル → career 要約の生成を含む）。エラー時はメッセージを返す */
function normalizeBusinessBody(body: any): string | null {
  if (body.career_rows !== undefined) {
    const r = normalizeCareerRows(body.career_rows)
    if ('error' in r) return r.error
    body.career_rows = JSON.stringify(r.rows)
    body.career = careerSummary(r.rows)
  } else if (body.career !== undefined) {
    // 旧形式（経歴テキストのみ）で更新された場合は、食い違わないよう経歴テーブルを外してテキストを正とする
    body.career_rows = null
  }
  for (const k of ['pr_points', 'remarks']) {
    if (body[k] !== undefined) {
      body[k] = body[k] == null ? '' : String(body[k])
      if (body[k].length > 4000) return (k === 'pr_points' ? '経験・スキル・人柄・PRポイント等' : '備考') + 'は4000文字以内で入力してください'
    }
  }
  if (body.commute_minutes !== undefined && body.commute_minutes !== null && body.commute_minutes !== '') {
    const n = Number(body.commute_minutes)
    if (!Number.isFinite(n) || n < 0 || n > 1440) return '通勤可能時間は0〜1440分で入力してください'
    body.commute_minutes = Math.round(n)
  } else if (body.commute_minutes === '') body.commute_minutes = null
  if (body.available_from !== undefined && body.available_from && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.available_from))) return '稼働開始可能日の形式が不正です'
  return null
}
// 必須項目チェック（企業ごとの必須設定 + 氏名・性別）。不足があればエラーメッセージを返す
async function validateProfileBase(c: any, body: any, roster: any): Promise<string | null> {
  const u = c.get('user')
  const missing = missingRequired(await getRequiredFields(c.env.DB, u.company_id), body, 'update', roster.affiliation_type)
  if (body.gender !== undefined && !body.gender) missing.unshift('性別')
  if (body.name !== undefined && !String(body.name || '').trim()) missing.unshift('氏名')
  if (missing.length) return `次の項目は必須です: ${missing.join('・')}`
  // 取引先所属スタッフの所属会社名を変えるときは、導入企業名を受け付けない（取引先マスタに登録されるため）。
  // 変えていない場合は確認しない（案件掲示板から取り込んだスタッフは、提案企業＝導入企業を所属会社として持つ: board.ts）
  if (roster.affiliation_type === 'partner_manual' && body.affiliation && body.affiliation !== roster.affiliation) return partnerNameConflict(c.env.DB, u.company_id, body.affiliation)
  return null
}
// 基本情報・追記項目・在籍状況を保存する（権限チェックは呼び出し側で実施済みであること）
async function applyProfileUpdate(c: any, sid: string, body: any, roster: any) {
  const u = c.get('user')
  const { retired_at, affiliation, employment_status } = body
  if (body.name !== undefined) {
    const newName = String(body.name).trim()
    await c.env.DB.prepare('UPDATE users SET name = ? WHERE user_id = ?').bind(newName, roster.user_id).run()
    await propagateNameToLinked(c.env.DB, sid, newName)
  }

  // 送られてきた項目だけを更新し、空欄は NULL にして消せるようにする（#18）。
  // follow_flag・retention_risk は空にできない（空で送られたら変更しない）
  const base = buildUpdate(body, ['memo', 'follow_flag', 'retention_risk', 'affiliation', 'affiliation_contact', 'kana', 'gender',
    'date_of_birth', 'nearest_station_line', 'nearest_station'], { required: ['follow_flag', 'retention_risk'] })
  if (base.clause) {
    await c.env.DB.prepare(`UPDATE staff_profiles SET ${base.clause} WHERE staff_id = ? AND company_id = ?`)
      .bind(...base.values, sid, u.company_id).run()
  }

  // 業務側項目は「送られてきた項目だけ」をそのまま保存する（空欄にしてクリアできるように COALESCE は使わない）
  // skills / career / work_area は従来どおり NOT NULL 相当の扱いなので null は空文字にする
  const biz = BUSINESS_KEYS.filter(k => body[k] !== undefined)
  if (biz.length) {
    const textKeys = ['skills', 'career', 'work_area', 'pr_points', 'remarks']
    await c.env.DB.prepare(`UPDATE staff_profiles SET ${biz.map(k => `${k} = ?`).join(', ')} WHERE staff_id = ? AND company_id = ?`)
      .bind(...biz.map(k => body[k] === null && textKeys.includes(k) ? '' : (body[k] ?? null)), sid, u.company_id).run()
  }

  // 稼働先追記項目（所属元にも共有される: 現場評価・稼働メモ）
  if (body.site_evaluation !== undefined || body.work_memo !== undefined) {
    await c.env.DB.prepare(`UPDATE staff_profiles SET site_evaluation = COALESCE(?, site_evaluation), work_memo = COALESCE(?, work_memo), host_note_updated_at = ?
      WHERE staff_id = ? AND company_id = ?`).bind(body.site_evaluation ?? null, body.work_memo ?? null, nowJST(), sid, u.company_id).run()
  }

  // 取引先所属スタッフの所属会社名を変更した場合は、取引先マスタ（staff_affiliations）のIDも追従させる
  if (roster.affiliation_type === 'partner_manual' && affiliation) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(u.company_id, affiliation).run()
    await c.env.DB.prepare(`UPDATE staff_profiles SET partner_affiliation_id = (SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?)
      WHERE staff_id = ? AND company_id = ?`).bind(u.company_id, affiliation, sid, u.company_id).run()
  }

  if (retired_at !== undefined || employment_status !== undefined) await applyRetirement(c.env.DB, sid, u.company_id, roster, retired_at, employment_status)
}

// ============ 退職日・在籍状況（#5 #34 #139） ============
// 退職日は users テーブル側で管理する（定期削除の「退職後7年」判定に使用）。
// users.status('active'/'suspended') は他機能の対象判定に使われているため、退職が効力を持つときだけ suspended にする。
//  - 退職日が今日より前        : 退職（suspended・employment_status=retired）
//  - 退職日が今日以降          : 退職予定。退職日だけを保存し、在籍状況とログインはそのまま。
//                                退職日の翌日に毎日の cron（applyDueRetirements）が退職へ切り替える
//  - 退職日を消す / 退職以外へ : 退職日を消して active に戻す
const EMPLOYMENT_STATUSES = ['working', 'leave', 'retired', 'preboarding']

/** 退職日・在籍状況の入力を確認し、body.retired_at を正規化する。確認が必要なときは confirm_required を付けて返す */
// hireDateOverride: 同じ送信で入社日も変えるとき（従業員管理）はその値で比べる
async function validateRetirement(db: D1Database, sid: string, body: any, roster: any, hireDateOverride?: string | null): Promise<{ error: string; confirm_required?: boolean } | null> {
  const status = body.employment_status
  if (status !== undefined && !EMPLOYMENT_STATUSES.includes(status)) return { error: '在籍状況の値が正しくありません' }
  if (body.retired_at === undefined) {
    if (status === 'retired' && !roster.retired_at) return { error: '退職にする場合は退職日を入力してください' }
    return null
  }
  const raw = typeof body.retired_at === 'string' ? body.retired_at.trim() : body.retired_at
  // 保存済みと同じ退職日なら、確認は済んでいるものとして扱う（従業員管理は毎回退職日も送るため）
  const unchanged = !!raw && raw === roster.retired_at
  let hireDate: string | null = null, lastWorkDate: string | null = null
  if (raw && !unchanged && body.retired_at_confirmed !== true) {
    const hire = await db.prepare('SELECT hire_date FROM employee_records WHERE staff_id = ?').bind(sid).first() as any
    const last = await db.prepare('SELECT MAX(work_date) AS d FROM shifts WHERE staff_id = ?').bind(sid).first() as any
    hireDate = hireDateOverride !== undefined ? (hireDateOverride || null) : (hire?.hire_date || null); lastWorkDate = last?.d || null
  }
  const v = validateRetiredAt(raw, { today: todayJST(), confirmed: unchanged || body.retired_at_confirmed === true, hireDate, lastWorkDate })
  if (!v.ok) return { error: v.error, confirm_required: v.confirm || undefined }
  body.retired_at = v.value
  if (v.value === null && status === 'retired') return { error: '退職にする場合は退職日を入力してください' }
  // 在籍状況と退職日の食い違い（退職以外なのに、過去の退職日が残っている）は保存しない
  if (v.value && !v.scheduled && status !== undefined && status !== 'retired') {
    return { error: '在籍状況が「退職」以外のときは、退職日を空欄にしてください（今日以降の日付なら退職予定として登録できます）' }
  }
  return null
}

async function applyRetirement(db: D1Database, sid: string, companyId: number, roster: any, retiredAt: string | null | undefined, status: string | undefined) {
  const current = (roster.employment_status as string) || 'working'
  let newRetired: string | null, userStatus: string, empStatus: string
  if (retiredAt === undefined) {
    // 在籍状況だけの変更。退職（退職日は保存済み）以外にするときは退職日を消す
    if (status === 'retired') {
      await db.prepare('UPDATE staff_profiles SET employment_status = ? WHERE staff_id = ? AND company_id = ?').bind('retired', sid, companyId).run()
      return
    }
    newRetired = null; userStatus = 'active'; empStatus = status as string
  } else if (retiredAt && isRetirementEffective(retiredAt, todayJST())) {
    newRetired = retiredAt; userStatus = 'suspended'; empStatus = 'retired'
  } else {
    // 退職予定（今日以降の日付）または退職日を消す。在籍状況は指定があればそれに、退職のままなら在職中に戻す
    newRetired = retiredAt || null; userStatus = 'active'
    empStatus = status && status !== 'retired' ? status : (current === 'retired' ? 'working' : current)
  }
  // 退職日が変わったら、定期削除の猶予をやり直す
  const changed = (roster.retired_at || null) !== newRetired
  await db.batch([
    db.prepare(`UPDATE users SET retired_at = ?, status = ?
      WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?)`).bind(newRetired, userStatus, sid, companyId),
    db.prepare(`UPDATE staff_profiles SET employment_status = ?${changed ? ', retention_flagged_at = NULL' : ''} WHERE staff_id = ? AND company_id = ?`)
      .bind(empStatus, sid, companyId),
  ])
}

// スタッフ更新（スタッフマスタ画面から）
api.put('/admin/staff/:id', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const body = await c.req.json()
  const roster = await loadRoster(c.env.DB, sid, u.company_id)
  if (!roster) return c.json({ error: 'not found' }, 404)
  if (roster.merged_into_staff_id) return c.json({ error: '統合済みのスタッフは変更できません（統合先のスタッフで編集してください）' }, 409)
  if (touchesProfileBase(body)) {
    if (roster.affiliation_type === 'own_employee') return c.json({ error: '自社雇用スタッフの氏名・生年月日・最寄駅・在籍状況などは従業員管理から編集してください' }, 403)
    if (!STAFF_MASTER_EDITABLE_TYPES.includes(roster.affiliation_type) || !roster.can_edit_base) {
      return c.json({ error: '基本項目は所属元企業のみ編集できます' }, 403)
    }
  }
  if (touchesBusiness(body)) {
    if (!canEditBusiness(roster)) return c.json({ error: '他社連携のスタッフの経歴・スキル等は所属元企業のみ編集できます' }, 403)
    const bizErr = normalizeBusinessBody(body)
    if (bizErr) return c.json({ error: bizErr }, 400)
  }
  if (touchesProfileBase(body) || touchesBusiness(body)) {
    const err = await validateProfileBase(c, body, roster)
    if (err) return c.json({ error: err }, 400)
  }
  const retErr = await validateRetirement(c.env.DB, sid, body, roster)
  if (retErr) return c.json(retErr, retErr.confirm_required ? 409 : 400)
  await applyProfileUpdate(c, sid, body, roster)
  return c.json({ ok: true })
})

// スタッフ登録
api.post('/admin/staff', async (c) => {
  const u = c.get('user')
  const { user_code: rawCode, name, password, email, phone, skills, career, work_area } = await c.req.json()
  const user_code = String(rawCode ?? '').trim()
  if (!user_code || !name || !password) return c.json({ error: 'スタッフ番号・氏名・パスワードは必須です' }, 400)
  const pwErr = validatePassword(password)
  if (pwErr) return c.json({ error: pwErr }, 400)
  const hash = await hashPassword(password)
  try {
    const r = await c.env.DB.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone) VALUES (?, ?, ?, 'staff', ?, ?, ?)`)
      .bind(u.company_id, user_code, name, hash, email ?? null, phone ?? null).run()
    const person = await createPerson(c.env.DB, u.company_id)
    await c.env.DB.prepare('UPDATE users SET person_id = ? WHERE user_id = ?').bind(person.person_id, r.meta.last_row_id).run()
    await c.env.DB.prepare(`INSERT INTO staff_profiles (user_id, company_id, affiliation, skills, career, work_area, person_id, owner_company_id, affiliation_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'own_employee')`)
      .bind(r.meta.last_row_id, u.company_id, u.company_name, skills ?? '', career ?? '', work_area ?? '', person.person_id, u.company_id).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: 'スタッフ番号が重複しています' }, 409)
  }
})

// スキルシート生成
api.get('/admin/staff/:id/skill-sheet', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const profile = await loadRoster(c.env.DB, sid, u.company_id)
  if (!profile) return c.json({ error: 'not found' }, 404)
  // 経験案件は、確定・代打で稼働日が今日までのシフトに限る（欠勤・希望・未来の予定は含めない）
  const projects = await c.env.DB.prepare(`
    SELECT DISTINCT p.project_name, p.project_type FROM shifts s JOIN projects p ON s.project_id = p.project_id
    WHERE s.staff_id = ? AND s.company_id = ? AND s.status IN ('confirmed','substitute') AND s.work_date <= ?`).bind(sid, u.company_id, todayJST()).all()
  const perf = await c.env.DB.prepare(`
    SELECT SUM(COALESCE(json_extract(report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(report_values,'$.seiyaku'),0)) AS seiyaku,
      COUNT(*) AS total_days
    FROM daily_reports WHERE staff_id = ?`).bind(sid).first()
  const latestEval = await c.env.DB.prepare('SELECT * FROM evaluations WHERE staff_id = ? ORDER BY evaluation_period DESC LIMIT 1').bind(sid).first()
  // 管理者メモは社内用なので、社外に出すスキルシートには返さない（推薦コメントは作成時に入力する）
  const { memo: _memo, ...sheet } = profile
  return c.json({ profile: { ...sheet, career_rows: parseCareerRows(profile.career_rows), age: calcAge(profile.date_of_birth as string | null) }, experienced_projects: projects.results, performance: perf, evaluation: latestEval })
})

// ============ スタッフ履歴書ファイル管理 ============
// 対応形式・上限は既存の写真添付(PHOTO_*)とは別に定義する
const DOC_ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'odt', 'ods', 'odp', 'jpg', 'jpeg', 'png', 'gif', 'webp']
const DOC_MAX_BYTES = 20 * 1024 * 1024 // 20MB
const DOC_MIME_MAP: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  txt: ['text/plain'],
  odt: ['application/vnd.oasis.opendocument.text'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet'],
  odp: ['application/vnd.oasis.opendocument.presentation'],
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
  png: ['image/png'],
  gif: ['image/gif'],
  webp: ['image/webp'],
}
function docExt(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename)
  return m ? m[1].toLowerCase() : ''
}
// R2キーの一部に使うため危険な記号だけ置換する（元のファイル名はDB側にそのまま保持）
function sanitizeForKey(filename: string): string {
  return filename.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 150)
}
async function assertStaffInCompany(c: any, sid: string) {
  const u = c.get('user')
  return c.env.DB.prepare('SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(sid, u.company_id).first()
}

// ファイル一覧
api.get('/admin/staff/:id/documents', async (c) => {
  const sid = c.req.param('id')
  const staff = await assertStaffInCompany(c, sid)
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const docs = await c.env.DB.prepare(
    'SELECT document_id, original_file_name, mime_type, file_size, uploaded_at FROM staff_documents WHERE staff_id = ? ORDER BY uploaded_at DESC'
  ).bind(sid).all()
  return c.json({ documents: docs.results })
})

// アップロード（複数ファイル対応。1ファイルずつ個別に検証し、成功分のみ保存する）
api.post('/admin/staff/:id/documents', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const staff = await assertStaffInCompany(c, sid)
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: '送信データの形式が不正です' }, 400)
  }
  const files = form.getAll('files').filter(f => f instanceof File) as File[]
  if (files.length === 0) return c.json({ error: 'ファイルが選択されていません' }, 400)

  const results: { filename: string; ok: boolean; document_id?: number; error?: string }[] = []

  for (const file of files) {
    const ext = docExt(file.name)
    if (!DOC_ALLOWED_EXT.includes(ext)) {
      results.push({ filename: file.name, ok: false, error: 'このファイル形式には対応していません。' })
      continue
    }
    if (file.size > DOC_MAX_BYTES) {
      results.push({ filename: file.name, ok: false, error: 'ファイルサイズは20MB以下にしてください。' })
      continue
    }
    // MIME Typeは端末・ブラウザ差で信頼性が低いため、拡張子を主判定としつつ
    // 明確に一致しない場合のみ弾く補助チェックとする（空/octet-streamは許容）
    const acceptableMimes = DOC_MIME_MAP[ext] || []
    if (file.type && file.type !== 'application/octet-stream' && acceptableMimes.length && !acceptableMimes.includes(file.type)) {
      results.push({ filename: file.name, ok: false, error: 'このファイル形式には対応していません。' })
      continue
    }

    // 同名ファイルでも上書きされないよう、UUIDを含むキーにする
    const uuid = crypto.randomUUID()
    const key = `staff-documents/${u.company_id}/${sid}/${uuid}/${sanitizeForKey(file.name)}`
    try {
      const buf = await file.arrayBuffer()
      await c.env.DOCUMENTS.put(key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } })
    } catch {
      results.push({ filename: file.name, ok: false, error: 'ファイルのアップロードに失敗しました。' })
      continue
    }

    try {
      const r = await c.env.DB.prepare(`INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, sid, cleanFileName(file.name), key, file.type || 'application/octet-stream', file.size, u.user_id).run()
      results.push({ filename: file.name, ok: true, document_id: r.meta.last_row_id as number })
    } catch {
      // D1登録に失敗した場合はアップロード済みのR2オブジェクトを掃除する
      await c.env.DOCUMENTS.delete(key).catch(() => {})
      results.push({ filename: file.name, ok: false, error: 'ファイルの登録に失敗しました。' })
    }
  }

  return c.json({ results })
})

// ダウンロード（元ファイル名・元Content-Typeで返す。実行される事故を避けるため常にattachment指定）
api.get('/admin/staff/documents/:docId/download', async (c) => {
  const u = c.get('user'); const docId = c.req.param('docId')
  const doc = await c.env.DB.prepare('SELECT * FROM staff_documents WHERE document_id = ? AND company_id = ?').bind(docId, u.company_id).first()
  if (!doc) return c.json({ error: 'ファイルを取得できませんでした' }, 404)

  const obj = await c.env.DOCUMENTS.get(doc.storage_key as string)
  if (!obj) return c.json({ error: 'ファイルを取得できませんでした' }, 404)

  const filename = (doc.original_file_name as string).replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(doc.original_file_name as string)
  return c.body(obj.body, 200, {
    'Content-Type': (doc.mime_type as string) || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
  })
})

// 削除（D1を先に消し、R2はベストエフォート。孤立するならR2側の残骸の方が実害が小さいため）
api.delete('/admin/staff/documents/:docId', async (c) => {
  const u = c.get('user'); const docId = c.req.param('docId')
  const doc = await c.env.DB.prepare('SELECT * FROM staff_documents WHERE document_id = ? AND company_id = ?').bind(docId, u.company_id).first()
  if (!doc) return c.json({ error: 'ファイルの削除に失敗しました' }, 404)

  try {
    await c.env.DB.prepare('DELETE FROM staff_documents WHERE document_id = ?').bind(docId).run()
  } catch {
    return c.json({ error: 'ファイルの削除に失敗しました' }, 500)
  }
  await c.env.DOCUMENTS.delete(doc.storage_key as string).catch(() => {})
  return c.json({ ok: true })
})

// クライアント
api.get('/admin/clients', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT cl.*, (SELECT GROUP_CONCAT(p.project_name) FROM projects p WHERE p.client_id = cl.client_id AND p.status = 'active') AS active_projects
    FROM clients cl WHERE cl.company_id = ? ORDER BY cl.client_id`).bind(u.company_id).all()
  return c.json({ clients: rows.results })
})

api.post('/admin/clients', async (c) => {
  const u = c.get('user')
  const b = await c.req.json()
  if (!b.client_name) return c.json({ error: 'クライアント名は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO clients (company_id, client_name, stream_type, contact_name, email, phone, address, contract_type, billing_rule, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.client_name, b.stream_type || 'upstream', b.contact_name ?? null, b.email ?? null, b.phone ?? null, b.address ?? null, b.contract_type ?? null, b.billing_rule ?? null, b.memo ?? null).run()
  return c.json({ ok: true })
})

// クライアント詳細（会社詳細画面用。まだ一覧のみだったため今回新設）
api.get('/admin/clients/:id', async (c) => {
  const u = c.get('user'); const cid = c.req.param('id')
  const client = await c.env.DB.prepare(`
    SELECT cl.*, (SELECT GROUP_CONCAT(p.project_name) FROM projects p WHERE p.client_id = cl.client_id AND p.status = 'active') AS active_projects
    FROM clients cl WHERE cl.client_id = ? AND cl.company_id = ?`).bind(cid, u.company_id).first()
  if (!client) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const contacts = await c.env.DB.prepare(
    'SELECT * FROM client_contacts WHERE client_id = ? AND company_id = ? ORDER BY contact_id'
  ).bind(cid, u.company_id).all()
  return c.json({ client, contacts: contacts.results })
})

// インボイス登録番号: T + 数字13桁のみ許可（前後の空白はトリムする）
function validateInvoiceNumber(v: string | null | undefined): string | null | 'invalid' {
  if (v == null || v === '') return null
  const trimmed = v.trim()
  return /^T\d{13}$/.test(trimmed) ? trimmed : 'invalid'
}

api.put('/admin/clients/:id', async (c) => {
  const u = c.get('user'); const cid = c.req.param('id')
  const b = await c.req.json()

  let invoiceNumber: string | null = null
  if (b.invoice_number !== undefined) {
    const v = validateInvoiceNumber(b.invoice_number)
    if (v === 'invalid') return c.json({ error: 'インボイス登録番号は「T」+数字13桁で入力してください（例: T1234567890123）' }, 400)
    invoiceNumber = v
  }

  const exists = await c.env.DB.prepare('SELECT client_id FROM clients WHERE client_id = ? AND company_id = ?').bind(cid, u.company_id).first()
  if (!exists) return c.json({ error: 'クライアントが見つかりません' }, 404)

  // 送られてきた項目だけを更新し、空欄は NULL にして消せるようにする（#92）。
  // 会社名は空にできない。区分・評価は空で送られたら変更しない
  const upd = buildUpdate({ ...b, invoice_number: b.invoice_number === undefined ? undefined : invoiceNumber },
    ['client_name', 'stream_type', 'contract_type', 'billing_rule', 'memo', 'client_rating',
      'representative_title', 'representative_name', 'representative_kana', 'invoice_number'],
    { required: ['client_name', 'stream_type', 'client_rating'] })
  if (upd.missing.includes('client_name')) return c.json({ error: 'クライアント名は必須です' }, 400)
  if (upd.clause) {
    await c.env.DB.prepare(`UPDATE clients SET ${upd.clause} WHERE client_id = ? AND company_id = ?`)
      .bind(...upd.values, cid, u.company_id).run()
  }
  return c.json({ ok: true })
})

// ============ 顧客担当者（1会社に複数登録可、支店・部署は自由入力） ============
async function assertClientOwned(c: any, cid: string) {
  const u = c.get('user')
  return c.env.DB.prepare('SELECT client_id FROM clients WHERE client_id = ? AND company_id = ?').bind(cid, u.company_id).first()
}

api.get('/admin/clients/:id/contacts', async (c) => {
  const cid = c.req.param('id')
  if (!(await assertClientOwned(c, cid))) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const u = c.get('user')
  const rows = await c.env.DB.prepare('SELECT * FROM client_contacts WHERE client_id = ? AND company_id = ? ORDER BY contact_id')
    .bind(cid, u.company_id).all()
  return c.json({ contacts: rows.results })
})

api.post('/admin/clients/:id/contacts', async (c) => {
  const u = c.get('user'); const cid = c.req.param('id')
  if (!(await assertClientOwned(c, cid))) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const b = await c.req.json()
  if (!b.contact_name) return c.json({ error: '担当者氏名は必須です' }, 400)
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)

  await c.env.DB.prepare(`INSERT INTO client_contacts (company_id, client_id, contact_name, branch_name, department, title, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, cid, b.contact_name, b.branch_name ?? null, b.department ?? null, b.title ?? null, b.phone ?? null, b.email ?? null).run()
  return c.json({ ok: true })
})

api.put('/admin/clients/contacts/:contactId', async (c) => {
  const u = c.get('user'); const contactId = c.req.param('contactId')
  const existing = await c.env.DB.prepare('SELECT contact_id FROM client_contacts WHERE contact_id = ? AND company_id = ?').bind(contactId, u.company_id).first()
  if (!existing) return c.json({ error: '担当者が見つかりません' }, 404)
  const b = await c.req.json()
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)

  // 送られてきた項目だけを更新し、空欄は NULL にして消せるようにする（#92）。氏名は空にできない
  const upd = buildUpdate(b, ['contact_name', 'branch_name', 'department', 'title', 'phone', 'email'], { required: ['contact_name'] })
  if (upd.missing.length) return c.json({ error: '担当者氏名は必須です' }, 400)
  await c.env.DB.prepare(`UPDATE client_contacts SET ${upd.clause ? upd.clause + ', ' : ''}updated_at = ? WHERE contact_id = ? AND company_id = ?`)
    .bind(...upd.values, nowJST(), contactId, u.company_id).run()
  return c.json({ ok: true })
})

api.delete('/admin/clients/contacts/:contactId', async (c) => {
  const u = c.get('user'); const contactId = c.req.param('contactId')
  const existing = await c.env.DB.prepare('SELECT contact_id FROM client_contacts WHERE contact_id = ? AND company_id = ?').bind(contactId, u.company_id).first()
  if (!existing) return c.json({ error: '担当者が見つかりません' }, 404)
  await c.env.DB.prepare('DELETE FROM client_contacts WHERE contact_id = ?').bind(contactId).run()
  return c.json({ ok: true })
})

// ============ 所属会社マスタ（スタッフの「所属会社名」選択肢） ============
api.get('/admin/staff-affiliations', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE company_id = ? ORDER BY affiliation_name')
    .bind(u.company_id).all()
  return c.json({ affiliations: rows.results })
})
api.post('/admin/staff-affiliations', async (c) => {
  const u = c.get('user'); const { affiliation_name } = await c.req.json()
  if (!affiliation_name) return c.json({ error: '所属会社名は必須です' }, 400)
  const conflict = await partnerNameConflict(c.env.DB, u.company_id, affiliation_name)
  if (conflict) return c.json({ error: conflict }, 400)
  await c.env.DB.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)')
    .bind(u.company_id, affiliation_name).run()
  return c.json({ ok: true })
})

// ============ 従業員管理（社員名簿）: 自社雇用者のみ ============
// 0012 以降、「自社」判定は所属会社名の文字列一致ではなく staff_profiles.affiliation_type = 'own_employee'
// （かつ所属元企業 = 自社）で行う。他社から連携したスタッフ（linked_external）・取引先所属（partner_manual）・
// スキルシートのみ（skillsheet_only）は従業員管理に一切表示されず、APIでも参照・更新できない。
// ※既存データは 0012 の移行で「所属会社名 = 自社名」だったものが own_employee に変換済み。
// 統合済みの行（仮登録を既存のスタッフに統合した統合元）は在職者として扱わず、一覧・編集・保存の対象から外す（#108）
const OWN_EMPLOYEE_COND = `COALESCE(sp.affiliation_type, 'own_employee') = 'own_employee' AND COALESCE(sp.owner_company_id, sp.company_id) = sp.company_id AND sp.merged_into_staff_id IS NULL`
async function assertOwnEmployee(c: any, sid: string) {
  const u = c.get('user')
  return c.env.DB.prepare(`SELECT sp.staff_id FROM staff_profiles sp WHERE sp.staff_id = ? AND sp.company_id = ? AND ${OWN_EMPLOYEE_COND}`).bind(sid, u.company_id).first()
}
async function ownCompanyName(db: D1Database, companyId: number): Promise<string> {
  const row = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(companyId).first()
  return (row?.company_name as string) || ''
}

api.get('/admin/employees', async (c) => {
  const u = c.get('user')
  await ensureRosterIdentity(c.env.DB, u.company_id)
  const rows = await c.env.DB.prepare(`
    SELECT sp.staff_id, us.name, sp.kana, sp.employment_status, er.employee_number, er.department, er.job_title, er.base_location, er.contract_type
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = sp.staff_id
    WHERE sp.company_id = ? AND ${OWN_EMPLOYEE_COND}
    ORDER BY us.name`).bind(u.company_id).all()
  // 第2段階: 自社雇用から他の区分へ移行したスタッフ（雇用終了）は閲覧のみで一覧に表示する。統合して統合元に残った従業員データも同じ（#109）
  const ended = await c.env.DB.prepare(`
    SELECT sp.staff_id, us.name, sp.kana, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.merged_into_staff_id, er.employee_number, er.department, er.job_title,
      er.employment_ended_at, er.ended_reason
    FROM employee_records er JOIN staff_profiles sp ON sp.staff_id = er.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE er.company_id = ? AND er.employment_ended_at IS NOT NULL AND (COALESCE(sp.affiliation_type,'own_employee') != 'own_employee' OR sp.merged_into_staff_id IS NOT NULL)
    ORDER BY er.employment_ended_at DESC`).bind(u.company_id).all()
  return c.json({ employees: rows.results, ended: ended.results })
})

api.get('/admin/employees/:staffId', async (c) => {
  const u = c.get('user'); const sid = c.req.param('staffId')
  // 自社雇用者（own_employee）でなければ従業員管理としては閲覧不可にする
  const staff = await c.env.DB.prepare(`
    SELECT sp.*, us.name, us.email, us.phone, us.retired_at FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.staff_id = ? AND sp.company_id = ? AND ${OWN_EMPLOYEE_COND}`).bind(sid, u.company_id).first()
  if (!staff) {
    // 雇用終了（自社雇用から他の区分へ移行）した従業員は閲覧のみで返す
    const endedStaff = await c.env.DB.prepare(`SELECT sp.*, us.name, us.email, us.phone, us.retired_at FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
      JOIN employee_records er ON er.staff_id = sp.staff_id WHERE sp.staff_id = ? AND sp.company_id = ? AND er.employment_ended_at IS NOT NULL`).bind(sid, u.company_id).first()
    if (!endedStaff) return c.json({ error: '社員名簿の対象ではありません' }, 404)
    const rec = await c.env.DB.prepare('SELECT * FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sid, u.company_id).first()
    return c.json({ staff: { ...endedStaff, age: calcAge(endedStaff.date_of_birth as string | null) }, record: rec ? { ...rec, tenure: calcTenure(rec.hire_date as string | null) } : null, read_only: true })
  }

  const record = await c.env.DB.prepare('SELECT * FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sid, u.company_id).first()
  return c.json({
    staff: { ...staff, age: calcAge(staff.date_of_birth as string | null) },
    record: record ? { ...record, tenure: calcTenure(record.hire_date as string | null) } : null,
  })
})

api.put('/admin/employees/:staffId', async (c) => {
  const u = c.get('user'); const sid = c.req.param('staffId')
  const staff = await assertOwnEmployee(c, sid)
  if (!staff) return c.json({ error: '社員名簿の対象ではありません' }, 404)

  const b = await c.req.json()
  // スタッフ基本情報（スタッフマスタに反映される項目）。自社雇用者はここでのみ編集できる
  // 所属会社名は自社名で固定のため受け付けない。メモ・フォロー等の追記項目はスタッフマスタ画面側で扱う
  const profile: Record<string, any> = {}
  if (b.profile && typeof b.profile === 'object') {
    for (const k of PROFILE_BASE_KEYS) if (k !== 'affiliation' && b.profile[k] !== undefined) profile[k] = b.profile[k]
  }
  if (b.profile && typeof b.profile === 'object') {
    for (const k of ['pr_points', 'remarks']) if (b.profile[k] !== undefined) profile[k] = b.profile[k]
  }
  const bizErr = normalizeBusinessBody(profile)
  if (bizErr) return c.json({ error: bizErr }, 400)
  const roster = Object.keys(profile).length ? await loadRoster(c.env.DB, sid, u.company_id) : null
  if (roster) {
    const err = await validateProfileBase(c, profile, roster)
    if (err) return c.json({ error: err }, 400)
    if (b.profile.retired_at_confirmed === true) profile.retired_at_confirmed = true
    const retErr = await validateRetirement(c.env.DB, sid, profile, roster, b.hire_date === undefined ? undefined : (typeof b.hire_date === 'string' ? b.hire_date.trim() : null))
    if (retErr) return c.json(retErr, retErr.confirm_required ? 409 : 400)
  }
  if (b.employee_number) {
    const dup = await c.env.DB.prepare('SELECT 1 FROM employee_records WHERE company_id = ? AND employee_number = ? AND staff_id != ?')
      .bind(u.company_id, b.employee_number, sid).first()
    if (dup) return c.json({ error: 'この社員番号は既に使用されています' }, 409)
  }

  const cols = [
    'employee_number', 'hire_date', 'base_location', 'department', 'job_title', 'contract_type', 'work_style',
    'scheduled_hours', 'scheduled_days_week', 'scheduled_days_month', 'hr_staff_user_id',
    'postal_code', 'prefecture', 'city', 'town', 'address_detail', 'personal_email', 'phone_main', 'phone_work',
    'dependents_info', 'dependents_count',
    'emergency_name', 'emergency_kana', 'emergency_relationship', 'emergency_phone',
    'emergency_postal_code', 'emergency_prefecture', 'emergency_city', 'emergency_town', 'emergency_address',
    'bank_code', 'bank_name', 'branch_name', 'branch_code', 'account_type', 'account_number',
    'contract_start', 'contract_end',
    'base_salary_type', 'base_salary', 'fixed_overtime_hours', 'fixed_overtime_pay', 'gross_pay',
    'position_allowance_note', 'position_allowance', 'sales_allowance_note', 'sales_allowance',
    'other_deduction_note', 'other_deduction',
    'employment_insurance_no', 'social_insurance_no',
    'paid_leave_granted_at', 'paid_leave_remaining', 'telework_remaining_this_month',
  ]
  const exists = await c.env.DB.prepare('SELECT employee_record_id FROM employee_records WHERE staff_id = ?').bind(sid).first()
  if (exists) {
    // 送られてきた項目だけを更新し、空欄は NULL にして消せるようにする（#18）
    const upd = buildUpdate(b, cols)
    await c.env.DB.prepare(`UPDATE employee_records SET ${upd.clause ? upd.clause + ', ' : ''}updated_at = ? WHERE staff_id = ? AND company_id = ?`)
      .bind(...upd.values, nowJST(), sid, u.company_id).run()
  } else {
    const placeholders = cols.map(() => '?').join(', ')
    await c.env.DB.prepare(`INSERT INTO employee_records (staff_id, company_id, ${cols.join(', ')}) VALUES (?, ?, ${placeholders})`)
      .bind(sid, u.company_id, ...cols.map(k => b[k] === '' ? null : (b[k] ?? null))).run()
  }
  if (roster) await applyProfileUpdate(c, sid, profile, roster)
  return c.json({ ok: true })
})

// ============ 入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） ============
api.get('/admin/employees/:staffId/documents', async (c) => {
  // 雇用終了した従業員（他区分へ移行）の書類も閲覧はできる（7年保存）
  const staff = (await assertOwnEmployee(c, c.req.param('staffId'))) || (await c.env.DB.prepare(
    'SELECT staff_id FROM employee_records WHERE staff_id = ? AND company_id = ? AND employment_ended_at IS NOT NULL').bind(c.req.param('staffId'), c.get('user').company_id).first())
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const docs = await c.env.DB.prepare(
    'SELECT document_id, original_file_name, mime_type, file_size, uploaded_at FROM employee_documents WHERE staff_id = ? ORDER BY uploaded_at DESC'
  ).bind(c.req.param('staffId')).all()
  return c.json({ documents: docs.results })
})

api.post('/admin/employees/:staffId/documents', async (c) => {
  const u = c.get('user'); const sid = c.req.param('staffId')
  const staff = await assertOwnEmployee(c, sid)
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)

  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: '送信データの形式が不正です' }, 400) }
  const files = form.getAll('files').filter(f => f instanceof File) as File[]
  if (files.length === 0) return c.json({ error: 'ファイルが選択されていません' }, 400)

  const results: { filename: string; ok: boolean; document_id?: number; error?: string }[] = []
  for (const file of files) {
    const ext = docExt(file.name)
    if (!DOC_ALLOWED_EXT.includes(ext)) { results.push({ filename: file.name, ok: false, error: 'このファイル形式には対応していません。' }); continue }
    if (file.size > DOC_MAX_BYTES) { results.push({ filename: file.name, ok: false, error: 'ファイルサイズは20MB以下にしてください。' }); continue }
    const acceptableMimes = DOC_MIME_MAP[ext] || []
    if (file.type && file.type !== 'application/octet-stream' && acceptableMimes.length && !acceptableMimes.includes(file.type)) {
      results.push({ filename: file.name, ok: false, error: 'このファイル形式には対応していません。' }); continue
    }
    const uuid = crypto.randomUUID()
    const key = `employee-documents/${u.company_id}/${sid}/${uuid}/${sanitizeForKey(file.name)}`
    try {
      const buf = await file.arrayBuffer()
      await c.env.DOCUMENTS.put(key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } })
    } catch { results.push({ filename: file.name, ok: false, error: 'ファイルのアップロードに失敗しました。' }); continue }
    try {
      const r = await c.env.DB.prepare(`INSERT INTO employee_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, sid, cleanFileName(file.name), key, file.type || 'application/octet-stream', file.size, u.user_id).run()
      results.push({ filename: file.name, ok: true, document_id: r.meta.last_row_id as number })
    } catch {
      await c.env.DOCUMENTS.delete(key).catch(() => {})
      results.push({ filename: file.name, ok: false, error: 'ファイルの登録に失敗しました。' })
    }
  }
  return c.json({ results })
})

api.get('/admin/employees/documents/:docId/download', async (c) => {
  const u = c.get('user'); const docId = c.req.param('docId')
  const doc = await c.env.DB.prepare('SELECT * FROM employee_documents WHERE document_id = ? AND company_id = ?').bind(docId, u.company_id).first()
  if (!doc) return c.json({ error: 'ファイルを取得できませんでした' }, 404)
  const obj = await c.env.DOCUMENTS.get(doc.storage_key as string)
  if (!obj) return c.json({ error: 'ファイルを取得できませんでした' }, 404)
  const filename = (doc.original_file_name as string).replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(doc.original_file_name as string)
  return c.body(obj.body, 200, {
    'Content-Type': (doc.mime_type as string) || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=0',
  })
})

api.delete('/admin/employees/documents/:docId', async (c) => {
  const u = c.get('user'); const docId = c.req.param('docId')
  const doc = await c.env.DB.prepare('SELECT * FROM employee_documents WHERE document_id = ? AND company_id = ?').bind(docId, u.company_id).first()
  if (!doc) return c.json({ error: 'ファイルの削除に失敗しました' }, 404)
  try {
    await c.env.DB.prepare('DELETE FROM employee_documents WHERE document_id = ?').bind(docId).run()
  } catch { return c.json({ error: 'ファイルの削除に失敗しました' }, 500) }
  await c.env.DOCUMENTS.delete(doc.storage_key as string).catch(() => {})
  return c.json({ ok: true })
})

// ============ クライアント契約書ファイル管理 ============
// バリデーション用の定数・ヘルパーは履歴書機能（DOC_ALLOWED_EXT等）をそのまま再利用する
async function assertClientInCompany(c: any, cid: string) {
  const u = c.get('user')
  return c.env.DB.prepare('SELECT client_id FROM clients WHERE client_id = ? AND company_id = ?').bind(cid, u.company_id).first()
}

// ファイル一覧
api.get('/admin/clients/:id/documents', async (c) => {
  const cid = c.req.param('id')
  const client = await assertClientInCompany(c, cid)
  if (!client) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const docs = await c.env.DB.prepare(
    'SELECT document_id, original_file_name, mime_type, file_size, uploaded_at FROM client_documents WHERE client_id = ? ORDER BY uploaded_at DESC'
  ).bind(cid).all()
  return c.json({ documents: docs.results })
})

// アップロード（複数ファイル対応。履歴書機能と同一の検証ロジックを再利用）
api.post('/admin/clients/:id/documents', async (c) => {
  const u = c.get('user'); const cid = c.req.param('id')
  const client = await assertClientInCompany(c, cid)
  if (!client) return c.json({ error: 'クライアントが見つかりません' }, 404)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: '送信データの形式が不正です' }, 400)
  }
  const files = form.getAll('files').filter(f => f instanceof File) as File[]
  if (files.length === 0) return c.json({ error: 'ファイルが選択されていません' }, 400)

  const results: { filename: string; ok: boolean; document_id?: number; error?: string }[] = []

  for (const file of files) {
    const ext = docExt(file.name)
    if (!DOC_ALLOWED_EXT.includes(ext)) {
      results.push({ filename: file.name, ok: false, error: 'このファイル形式には対応していません。' })
      continue
    }
    if (file.size > DOC_MAX_BYTES) {
      results.push({ filename: file.name, ok: false, error: 'ファイルサイズは20MB以下にしてください。' })
      continue
    }
    const acceptableMimes = DOC_MIME_MAP[ext] || []
    if (file.type && file.type !== 'application/octet-stream' && acceptableMimes.length && !acceptableMimes.includes(file.type)) {
      results.push({ filename: file.name, ok: false, error: 'このファイル形式には対応していません。' })
      continue
    }

    const uuid = crypto.randomUUID()
    const key = `client-documents/${u.company_id}/${cid}/${uuid}/${sanitizeForKey(file.name)}`
    try {
      const buf = await file.arrayBuffer()
      await c.env.CONTRACTS.put(key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } })
    } catch {
      results.push({ filename: file.name, ok: false, error: 'ファイルのアップロードに失敗しました。' })
      continue
    }

    try {
      const r = await c.env.DB.prepare(`INSERT INTO client_documents (company_id, client_id, original_file_name, storage_key, mime_type, file_size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, cid, cleanFileName(file.name), key, file.type || 'application/octet-stream', file.size, u.user_id).run()
      results.push({ filename: file.name, ok: true, document_id: r.meta.last_row_id as number })
    } catch {
      await c.env.CONTRACTS.delete(key).catch(() => {})
      results.push({ filename: file.name, ok: false, error: 'ファイルの登録に失敗しました。' })
    }
  }

  return c.json({ results })
})

// ダウンロード
api.get('/admin/clients/documents/:docId/download', async (c) => {
  const u = c.get('user'); const docId = c.req.param('docId')
  const doc = await c.env.DB.prepare('SELECT * FROM client_documents WHERE document_id = ? AND company_id = ?').bind(docId, u.company_id).first()
  if (!doc) return c.json({ error: 'ファイルを取得できませんでした' }, 404)

  const obj = await c.env.CONTRACTS.get(doc.storage_key as string)
  if (!obj) return c.json({ error: 'ファイルを取得できませんでした' }, 404)

  const filename = (doc.original_file_name as string).replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(doc.original_file_name as string)
  return c.body(obj.body, 200, {
    'Content-Type': (doc.mime_type as string) || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
  })
})

// 削除（D1を先に消し、R2はベストエフォート。履歴書機能と同じ順序方針）
api.delete('/admin/clients/documents/:docId', async (c) => {
  const u = c.get('user'); const docId = c.req.param('docId')
  const doc = await c.env.DB.prepare('SELECT * FROM client_documents WHERE document_id = ? AND company_id = ?').bind(docId, u.company_id).first()
  if (!doc) return c.json({ error: 'ファイルの削除に失敗しました' }, 404)

  try {
    await c.env.DB.prepare('DELETE FROM client_documents WHERE document_id = ?').bind(docId).run()
  } catch {
    return c.json({ error: 'ファイルの削除に失敗しました' }, 500)
  }
  await c.env.CONTRACTS.delete(doc.storage_key as string).catch(() => {})
  return c.json({ ok: true })
})

// 案件一覧
api.get('/admin/projects', async (c) => {
  const u = c.get('user'); const month = monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT p.*, cl.client_name,
      (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date LIKE ?) AS staff_count,
      (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_shifts,
      (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.project_id = p.project_id AND dr.work_date LIKE ?) AS month_seiyaku,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date LIKE ?) AS incidents
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    WHERE p.company_id = ? ORDER BY p.project_id`).bind(month + '%', month + '%', month + '%', month + '%', u.company_id).all()
  return c.json({ projects: rows.results, month })
})

// 案件詳細
api.get('/admin/projects/:id', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id'); const month = monthJST()
  const db = c.env.DB
  const project = await db.prepare(`
    SELECT p.*, cl.client_name, rt.template_name, rt.fields_json
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    LEFT JOIN report_templates rt ON p.report_template_id = rt.template_id
    WHERE p.project_id = ? AND p.company_id = ?`).bind(pid, u.company_id).first()
  if (!project) return c.json({ error: 'not found' }, 404)

  const staffPerf = await db.prepare(`
    SELECT dr.staff_id, us.name,
      COUNT(*) AS days,
      SUM(COALESCE(json_extract(dr.report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(dr.report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(dr.report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(dr.report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) AS seiyaku
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.project_id = ? AND dr.work_date LIKE ? GROUP BY dr.staff_id ORDER BY seiyaku DESC`).bind(pid, month + '%').all()

  const incidents = await db.prepare(`
    SELECT dr.work_date, dr.incident_flag, dr.complaint_flag, us.name AS staff_name, dr.report_values
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.project_id = ? AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) ORDER BY dr.work_date DESC LIMIT 10`).bind(pid).all()

  const monthShifts = await db.prepare(`SELECT COUNT(*) AS n, SUM(unit_price) AS revenue FROM shifts WHERE project_id = ? AND work_date LIKE ? AND status IN ('confirmed','substitute')`).bind(pid, month + '%').first()

  return c.json({
    project: { ...project, template_fields: project.fields_json ? JSON.parse(project.fields_json as string) : [] },
    staff_performance: staffPerf.results,
    incidents: (incidents.results as any[]).map(i => ({ ...i, values: JSON.parse(i.report_values) })),
    month_summary: monthShifts, month,
    company_photo_default: getCompanySetting(u, 'photo_required_attendance', true),
  })
})

// 画面の選択肢と同じ値だけを受け付ける（admin.js の PTYPE_LABELS・FOLLOW_LABELS）
const PROJECT_TYPES = ['mobile_shop', 'electronics', 'event', 'fiber', 'fixed_line', 'callcenter', 'other']
const UNIT_PRICE_TYPES = ['monthly', 'daily', 'hourly', 'performance']
const FOLLOW_TYPES = ['interview', 'phone', 'line', 'warning', 'praise', 'training', 'claim', 'health', 'shift', 'career', 'round']
const FOLLOW_STATUSES = ['open', 'done']
const SHIFT_STATUSES = ['requested', 'confirmed', 'substitute', 'absent']

// 案件登録
api.post('/admin/projects', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.project_name) return c.json({ error: '案件名は必須です' }, 400)
  if (b.project_type && !PROJECT_TYPES.includes(b.project_type)) return c.json({ error: '業務種別が正しくありません' }, 400)
  if (b.unit_price_type && !UNIT_PRICE_TYPES.includes(b.unit_price_type)) return c.json({ error: '単価の種類が正しくありません' }, 400)
  // 他社のクライアント・テンプレートは指定できない
  if (b.client_id != null && b.client_id !== '' && !(await ownClient(c.env.DB, u.company_id, b.client_id))) return c.json({ error: 'クライアントが見つかりません' }, 400)
  if (b.report_template_id != null && b.report_template_id !== '' && !(await c.env.DB.prepare('SELECT 1 FROM report_templates WHERE template_id = ? AND (company_id IS NULL OR company_id = ?)').bind(b.report_template_id, u.company_id).first()))
    return c.json({ error: '日報テンプレートが見つかりません' }, 400)
  await c.env.DB.prepare(`INSERT INTO projects (company_id, client_id, project_name, project_type, location, unit_price_type, unit_price, required_skills, report_template_id, requirements, manual_text, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.client_id ?? null, b.project_name, b.project_type || 'mobile_shop', b.location ?? null,
      b.unit_price_type || 'daily', b.unit_price || 0, b.required_skills ?? null, b.report_template_id ?? 1, b.requirements ?? null, b.manual_text ?? null, b.memo ?? null).run()
  return c.json({ ok: true })
})

// 案件ごとの入店/退店報告 写真添付オーバーライド更新
api.put('/admin/projects/:id/photo-required', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id')
  const { override } = await c.req.json().catch(() => ({ override: undefined }))
  if (!['inherit', 'on', 'off'].includes(override)) return c.json({ error: '不正なパラメータです' }, 400)
  const value = override === 'inherit' ? null : override === 'on' ? 1 : 0

  const proj = await c.env.DB.prepare('SELECT project_id FROM projects WHERE project_id = ? AND company_id = ?').bind(pid, u.company_id).first()
  if (!proj) return c.json({ error: '案件が見つかりません' }, 404)

  await c.env.DB.prepare('UPDATE projects SET photo_required_override = ? WHERE project_id = ?').bind(value, pid).run()
  return c.json({ ok: true })
})

// シフト管理
api.get('/admin/shifts', async (c) => {
  const u = c.get('user')
  const from = c.req.query('from') || todayJST()
  const to = c.req.query('to') || from
  const rows = await c.env.DB.prepare(`
    SELECT s.*, p.project_name, us.name AS staff_name
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? ORDER BY s.work_date, s.start_time`).bind(u.company_id, from, to).all()
  return c.json({ shifts: rows.results })
})

api.post('/admin/shifts', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.staff_id || !b.project_id || !b.work_date) return c.json({ error: 'スタッフ・案件・日付は必須です' }, 400)
  // 自社のスタッフマスタ行のみシフト登録可。スキルシートのみ作成（稼働管理対象外）は不可
  const st = await c.env.DB.prepare('SELECT affiliation_type, merged_into_staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(b.staff_id, u.company_id).first()
  if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (st.merged_into_staff_id) return c.json({ error: '統合済みのスタッフにはシフトを登録できません' }, 400)
  if (st.affiliation_type === 'skillsheet_only') return c.json({ error: 'スキルシートのみ作成のスタッフにはシフトを登録できません' }, 400)
  if (b.status && !SHIFT_STATUSES.includes(b.status)) return c.json({ error: 'シフトの状態が正しくありません' }, 400)
  // 自社の案件のみ（他社の案件名・場所・単価を取り込まない）
  const proj = await ownProject(c.env.DB, u.company_id, b.project_id)
  if (!proj) return c.json({ error: '案件が見つかりません' }, 404)
  const ins = await c.env.DB.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, b.project_id, b.work_date, b.start_time || '09:30', b.end_time || '19:00',
      b.location || proj?.location || '', b.role || '販売スタッフ', b.unit_price ?? proj?.unit_price ?? 0, b.transportation_fee || 0,
      b.status || 'confirmed', u.user_id, b.memo ?? null).run()
  // 単価ルール（請求/支払/交通費）を適用。単価を明示指定した場合は請求をその値で固定する
  const sid = ins.meta.last_row_id
  if (sid) {
    await applyPricingToShift(c.env.DB, u.company_id, sid)
    if (b.unit_price != null) await c.env.DB.prepare("UPDATE shifts SET unit_price = ?, bill_rate = ?, bill_unit_type = 'daily', bill_qty = 1, price_locked = 1 WHERE shift_id = ?").bind(b.unit_price, b.unit_price, sid).run()
  }
  return c.json({ ok: true })
})

api.put('/admin/shifts/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  // 確定済み（精算）のシフトはメモ以外を変更できない
  const cur = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!cur) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (cur.settle_status === 'confirmed' && (b.status != null || b.start_time != null || b.end_time != null || b.staff_id != null))
    return c.json({ error: '確定済みのシフトは変更できません。精算画面で確定を取り消してください' }, 409)
  if (b.status != null && !SHIFT_STATUSES.includes(b.status)) return c.json({ error: 'シフトの状態が正しくありません' }, 400)
  // 付け替え先は自社のスタッフマスタ行のみ（統合済み・スキルシートのみは不可）
  if (b.staff_id != null) {
    const st = await ownStaff(c.env.DB, u.company_id, b.staff_id)
    if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
    if (st.merged_into_staff_id) return c.json({ error: '統合済みのスタッフにはシフトを登録できません' }, 400)
    if (st.affiliation_type === 'skillsheet_only') return c.json({ error: 'スキルシートのみ作成のスタッフにはシフトを登録できません' }, 400)
  }
  await c.env.DB.prepare(`UPDATE shifts SET
      status = COALESCE(?, status), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time),
      staff_id = COALESCE(?, staff_id), memo = COALESCE(?, memo)
    WHERE shift_id = ? AND company_id = ?`)
    .bind(b.status ?? null, b.start_time ?? null, b.end_time ?? null, b.staff_id ?? null, b.memo ?? null, c.req.param('id'), u.company_id).run()
  // 時間・スタッフを変えた場合は単価（時給の数量・スタッフ別単価・支払先）を再計算（手動変更したシフトは除く）
  if (b.start_time != null || b.end_time != null || b.staff_id != null) await applyPricingToShift(c.env.DB, u.company_id, Number(c.req.param('id')))
  return c.json({ ok: true })
})

api.delete('/admin/shifts/:id', async (c) => {
  const u = c.get('user')
  const cur = await c.env.DB.prepare('SELECT settle_status FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (cur?.settle_status === 'confirmed') return c.json({ error: '確定済みのシフトは削除できません。精算画面で確定を取り消してください' }, 409)
  // 勤怠・日報の報告があるシフトは削除できない（記録を残すため。欠勤などに変更する）
  const rep = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM attendance_reports WHERE shift_id = ?) + (SELECT COUNT(*) FROM daily_reports WHERE shift_id = ?) AS n')
    .bind(c.req.param('id'), c.req.param('id')).first() as any
  if (rep?.n > 0) return c.json({ error: '勤怠・日報の報告があるシフトは削除できません。状態を「欠勤」などに変更してください' }, 409)
  await c.env.DB.prepare('DELETE FROM shift_report_tokens WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).run()
  await c.env.DB.prepare('DELETE FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// 日報一覧
api.get('/admin/daily-reports', async (c) => {
  const u = c.get('user')
  const date = c.req.query('date')
  const projectId = c.req.query('project_id')
  let sql = `
    SELECT dr.*, p.project_name, us.name AS staff_name
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ?`
  const binds: any[] = [u.company_id]
  if (date) { sql += ' AND dr.work_date = ?'; binds.push(date) }
  if (projectId) { sql += ' AND dr.project_id = ?'; binds.push(projectId) }
  sql += ' ORDER BY dr.work_date DESC, dr.submitted_at DESC LIMIT 100'
  const rows = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ reports: (rows.results as any[]).map(r => ({ ...r, values: JSON.parse(r.report_values) })) })
})

// 日報コメント・確認
api.put('/admin/daily-reports/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  await c.env.DB.prepare('UPDATE daily_reports SET manager_comment = COALESCE(?, manager_comment), manager_checked = COALESCE(?, manager_checked) WHERE daily_report_id = ? AND company_id = ?')
    .bind(b.manager_comment ?? null, b.manager_checked ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// 実績分析
api.get('/admin/analytics', async (c) => {
  const u = c.get('user'); const month = c.req.query('month') || monthJST()
  const db = c.env.DB; const cid = u.company_id
  const KEYS = ['mnp', 'pi', 'shinki', 'kishuhen', 'hikari', 'wifi', 'denki', 'card', 'koekake', 'shodan', 'seiyaku']
  const sel = KEYS.map(k => `SUM(COALESCE(json_extract(report_values,'$.${k}'),0)) AS ${k}`).join(',')

  const totals = await db.prepare(`SELECT ${sel}, COUNT(*) AS reports FROM daily_reports WHERE company_id = ? AND work_date LIKE ?`).bind(cid, month + '%').first()
  const daily = await db.prepare(`SELECT work_date, ${sel} FROM daily_reports WHERE company_id = ? AND work_date LIKE ? GROUP BY work_date ORDER BY work_date`).bind(cid, month + '%').all()
  const byStaff = await db.prepare(`
    SELECT dr.staff_id, us.name, COUNT(*) AS days, ${sel.replace(/report_values/g, 'dr.report_values')}
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY dr.staff_id ORDER BY seiyaku DESC`).bind(cid, month + '%').all()
  const byProject = await db.prepare(`
    SELECT dr.project_id, p.project_name, COUNT(*) AS days, ${sel.replace(/report_values/g, 'dr.report_values')}
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY dr.project_id`).bind(cid, month + '%').all()
  const byClient = await db.prepare(`
    SELECT cl.client_name, COUNT(*) AS days, ${sel.replace(/report_values/g, 'dr.report_values')}
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY cl.client_id`).bind(cid, month + '%').all()

  return c.json({ month, totals, daily: daily.results, by_staff: byStaff.results, by_project: byProject.results, by_client: byClient.results })
})

// お知らせ配信
api.get('/admin/notices', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notice_reads r WHERE r.notice_id = n.notice_id) AS read_count,
      (SELECT COUNT(*) FROM users us WHERE us.company_id = n.company_id AND us.role = 'staff' AND us.status = 'active') AS staff_total
    FROM notices n WHERE n.company_id = ? ORDER BY n.published_at DESC LIMIT 50`).bind(u.company_id).all()
  // メールの送信結果（状態ごとの人数）。メールを送らなかったお知らせは email_counts = null
  const ids = (rows.results as any[]).map(n => n.notice_id)
  const counts = ids.length ? (await c.env.DB.prepare(`SELECT notice_id, status, COUNT(*) AS n FROM notice_email_deliveries
    WHERE company_id = ? AND notice_id IN (SELECT value FROM json_each(?)) GROUP BY notice_id, status`).bind(u.company_id, JSON.stringify(ids)).all()).results as any[] : []
  const byNotice = new Map<number, Record<string, number>>()
  for (const r of counts) { const m = byNotice.get(r.notice_id) || {}; m[r.status] = r.n; byNotice.set(r.notice_id, m) }
  return c.json({ notices: (rows.results as any[]).map(({ client_request_id: _k, ...n }) => ({ ...n, email_counts: byNotice.get(n.notice_id) || null })) })
})

// お知らせの対象者を解決する（画面表示・既読率レポートと同じtarget_type判定ルールを踏襲）
async function resolveNoticeTargets(db: D1Database, companyId: number, targetType: string, targetIds: string):
  Promise<{ staff_id: number; user_id: number; name: string; email: string | null }[]> {
  if (targetType === 'all') {
    const rows = await db.prepare(
      `SELECT sp.staff_id, u.user_id, u.name, u.email FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
       WHERE u.company_id = ? AND u.role = 'staff' AND u.status = 'active'`
    ).bind(companyId).all()
    return rows.results as any[]
  }
  if (targetType === 'staff') {
    const ids = (targetIds || '').split(',').map(v => v.trim()).filter(Boolean)
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = await db.prepare(
      `SELECT sp.staff_id, u.user_id, u.name, u.email FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
       WHERE u.company_id = ? AND u.role = 'staff' AND u.status = 'active' AND sp.staff_id IN (${placeholders})`
    ).bind(companyId, ...ids).all()
    return rows.results as any[]
  }
  if (targetType === 'project') {
    const projIds = (targetIds || '').split(',').map(v => v.trim()).filter(Boolean)
    if (!projIds.length) return []
    const placeholders = projIds.map(() => '?').join(',')
    const rows = await db.prepare(
      `SELECT DISTINCT sp.staff_id, u.user_id, u.name, u.email FROM shifts sh
       JOIN staff_profiles sp ON sp.staff_id = sh.staff_id JOIN users u ON u.user_id = sp.user_id
       WHERE u.company_id = ? AND u.role = 'staff' AND u.status = 'active' AND sh.project_id IN (${placeholders})`
    ).bind(companyId, ...projIds).all()
    return rows.results as any[]
  }
  return []
}

// 対象者へお知らせメールをまとめて送り、1人ずつの結果を notice_email_deliveries に記録する（pending → sent / failed / skipped）
type NoticeMailRecipient = { user_id: number; name: string; email: string }
async function sendNoticeEmails(env: Bindings, noticeId: number, companyId: number, title: string, body: string, recipients: NoticeMailRecipient[]) {
  const db = env.DB
  try {
    const url = `${String(env.APP_BASE_URL || '').replace(/\/+$/, '')}/staff`
    const inputs = recipients.map(r => {
      const tpl = noticeEmail({ name: r.name, title, body, url })
      return { to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'notice', company_id: companyId }
    })
    // 冪等キーはお知らせ単位（同じお知らせの送信が二重に動いても、Resend 側で同じバッチを二度送らない）
    const results = await sendEmailBatch(env, inputs, { idempotencyKey: `notice-${noticeId}` })
    const rows = recipients.map((r, k) => ({
      u: r.user_id, s: results[k].skipped ? 'skipped' : results[k].ok ? 'sent' : 'failed',
      e: results[k].ok ? null : (results[k].error || 'unknown'), id: results[k].skipped ? null : (results[k].id ?? null),
    }))
    await db.prepare(`UPDATE notice_email_deliveries AS d SET status = json_extract(j.value, '$.s'), error = json_extract(j.value, '$.e'),
        provider_message_id = json_extract(j.value, '$.id'), sent_at = ?
      FROM json_each(?) AS j WHERE d.notice_id = ? AND d.user_id = json_extract(j.value, '$.u')`)
      .bind(nowJST(), JSON.stringify(rows), noticeId).run()
  } catch {
    console.log(`notice mail failed: notice=${noticeId}`)
    // 途中で止まった分は送信失敗として残す（送信中のまま放置しない）
    try {
      await db.prepare(`UPDATE notice_email_deliveries SET status = 'failed', error = 'internal_error' WHERE notice_id = ? AND status = 'pending'`).bind(noticeId).run()
    } catch { /* 記録の失敗は無視 */ }
  }
}

// 二重配信とみなす時間（同じ作成者・同じ内容・同じ対象）
const NOTICE_DUP_WINDOW_SEC = 30

api.post('/admin/notices', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const title = String(b.title ?? '').trim()
  if (!title) return c.json({ error: 'タイトルは必須です' }, 400)
  const body = String(b.body ?? '')
  const target_type = b.target_type || 'all'; const target_ids = String(b.target_ids ?? '')
  // 二重送信の防止（#105）: 画面が発行した一意キー（client_request_id）が同じなら受け付けない。
  // キーが無い呼び出しも、同じ人が同じ内容を直前に配信していれば重複として扱う
  const requestId = typeof b.client_request_id === 'string' && b.client_request_id.trim() ? b.client_request_id.trim().slice(0, 64) : null
  const since = new Date(Date.now() + 9 * 3600 * 1000 - NOTICE_DUP_WINDOW_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const dup = await c.env.DB.prepare(`SELECT notice_id FROM notices WHERE company_id = ? AND created_by = ? AND title = ? AND COALESCE(body, '') = ?
    AND target_type = ? AND COALESCE(target_ids, '') = ? AND published_at >= ? LIMIT 1`)
    .bind(u.company_id, u.user_id, title, body, target_type, target_ids, since).first() as any
  if (dup) return c.json({ error: '同じお知らせを配信したばかりです。一覧を確認してください', duplicate: true, notice_id: dup.notice_id }, 409)
  const ins = await c.env.DB.prepare(`INSERT INTO notices (company_id, title, body, target_type, target_ids, importance, read_required, published_at, created_by, client_request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING notice_id`)
    .bind(u.company_id, title, body, target_type, target_ids, b.importance || 'normal', b.read_required ? 1 : 0, nowJST(), u.user_id, requestId).first() as any
  if (!ins) return c.json({ error: 'このお知らせは配信済みです。一覧を確認してください', duplicate: true }, 409)
  const noticeId = Number(ins.notice_id)

  // メール通知（対象者判定ロジックは既存のnotice表示ロジックを再利用。既読状態には一切影響しない）
  // 送信対象・メール未登録の人数を返し、1人ずつの結果を記録する（#24）。連携スタッフは雇用元の本人のアドレスに送る（#128）
  let email: { mode: string; targets: number; with_email: number; no_email: number } | null = null
  if (b.send_email) {
    const targets = await resolveNoticeTargets(c.env.DB, u.company_id, target_type, target_ids)
    const linked = await linkedStaffEmails(c.env.DB, targets.filter(t => !String(t.email || '').trim()).map(t => t.staff_id))
    const withEmail: NoticeMailRecipient[] = []
    const rows: { u: number; s: string }[] = []
    const seen = new Set<number>()
    for (const t of targets) {
      if (seen.has(t.user_id)) continue
      seen.add(t.user_id)
      const addr = String(t.email || '').trim() || linked.get(Number(t.staff_id)) || ''
      if (addr) withEmail.push({ user_id: t.user_id, name: t.name, email: addr })
      rows.push({ u: t.user_id, s: addr ? 'pending' : 'no_email' })
    }
    if (rows.length) {
      await c.env.DB.prepare(`INSERT OR IGNORE INTO notice_email_deliveries (notice_id, company_id, user_id, status, created_at)
        SELECT ?, ?, json_extract(value, '$.u'), json_extract(value, '$.s'), ? FROM json_each(?)`)
        .bind(noticeId, u.company_id, nowJST(), JSON.stringify(rows)).run()
    }
    if (withEmail.length) c.executionCtx.waitUntil(sendNoticeEmails(c.env, noticeId, u.company_id, title, body, withEmail))
    email = { mode: mailMode(c.env), targets: rows.length, with_email: withEmail.length, no_email: rows.length - withEmail.length }
  }
  return c.json({ ok: true, notice_id: noticeId, email })
})

// お知らせメールの送信結果（1人ずつ）。メールアドレスは返さない（連携スタッフの所属元のアドレスを見せないため）
api.get('/admin/notices/:id{[0-9]+}/email-deliveries', async (c) => {
  const u = c.get('user')
  const n = await c.env.DB.prepare('SELECT notice_id, title FROM notices WHERE notice_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first()
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  const rows = (await c.env.DB.prepare(`SELECT d.user_id, us.name, d.status, d.error, d.sent_at FROM notice_email_deliveries d
    LEFT JOIN users us ON us.user_id = d.user_id WHERE d.notice_id = ? AND d.company_id = ?
    ORDER BY CASE d.status WHEN 'failed' THEN 0 WHEN 'no_email' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, us.name`).bind(n.notice_id, u.company_id).all()).results
  return c.json({ notice: n, deliveries: rows })
})

// お知らせ既読状況
api.get('/admin/notices/:id/reads', async (c) => {
  const u = c.get('user')
  if (!(await ownNotice(c.env.DB, u.company_id, c.req.param('id')))) return c.json({ error: 'お知らせが見つかりません' }, 404)
  const rows = await c.env.DB.prepare(`
    SELECT us.name, r.read_at FROM notice_reads r JOIN users us ON r.user_id = us.user_id WHERE r.notice_id = ? AND us.company_id = ?`).bind(c.req.param('id'), u.company_id).all()
  const unread = await c.env.DB.prepare(`
    SELECT us.name FROM users us WHERE us.company_id = ? AND us.role = 'staff' AND us.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = ? AND r.user_id = us.user_id)`).bind(u.company_id, c.req.param('id')).all()
  return c.json({ read: rows.results, unread: unread.results })
})

// ============ お知らせ既読率レポート ============
// 年度別（会社サマリ + スタッフ別）。長期保存されたレポートテーブルから取得する
api.get('/admin/notice-reports/:fiscalYear', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear'))
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)

  const summary = await c.env.DB.prepare(
    'SELECT * FROM notice_read_reports WHERE company_id = ? AND fiscal_year = ?'
  ).bind(u.company_id, fy).first()

  const staffRows = await c.env.DB.prepare(`
    SELECT r.staff_id, us.name AS staff_name, r.target_count, r.read_count, r.unread_count, r.read_rate
    FROM notice_read_staff_reports r
    JOIN staff_profiles sp ON sp.staff_id = r.staff_id
    JOIN users us ON us.user_id = sp.user_id
    WHERE r.company_id = ? AND r.fiscal_year = ?
    ORDER BY us.name`).bind(u.company_id, fy).all()

  return c.json({
    fiscal_year: fy,
    summary: summary || null, // 未生成の年度はnull（「対象となるお知らせがありません」表示等はフロント側で判断）
    staff_reports: staffRows.results,
  })
})

// 再集計（管理者が任意年度を指定して即時更新）
api.post('/admin/notice-reports/:fiscalYear/recalculate', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear'))
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)
  try {
    await generateNoticeReadReport(c.env.DB, u.company_id, fy)
  } catch {
    return c.json({ error: '再集計に失敗しました' }, 500)
  }
  return c.json({ ok: true })
})

// スタッフ別・お知らせ単位の詳細（notice_readsが残っている直近2年分のみ表示可能）
api.get('/admin/notice-reports/:fiscalYear/staff/:staffId', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear')); const staffId = c.req.param('staffId')
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)

  const staff = await c.env.DB.prepare(
    'SELECT sp.staff_id, sp.user_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ? AND sp.company_id = ?'
  ).bind(staffId, u.company_id).first()
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)

  const { start, end } = fiscalYearRange(fy)
  const noticeRows = await c.env.DB.prepare(`
    SELECT n.notice_id, n.title, n.published_at, n.target_type, n.target_ids,
      EXISTS(SELECT 1 FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = ?) AS is_read
    FROM notices n WHERE n.company_id = ? AND n.published_at >= ? AND n.published_at < ?
      AND (n.target_type = 'all'
        OR (n.target_type = 'staff' AND (',' || n.target_ids || ',') LIKE '%,' || ? || ',%')
        OR (n.target_type = 'project' AND EXISTS (
             SELECT 1 FROM shifts sh WHERE sh.staff_id = ? AND (',' || n.target_ids || ',') LIKE '%,' || sh.project_id || ',%')))
    ORDER BY n.published_at DESC`).bind(staff.user_id, u.company_id, start, end, staffId, staffId).all()

  return c.json({
    fiscal_year: fy, staff_name: staff.name,
    notices: noticeRows.results.map((n: any) => ({ notice_id: n.notice_id, title: n.title, published_at: n.published_at, is_read: !!n.is_read })),
  })
})

// CSV出力（スタッフ別レポート。人事評価の参考資料用）
api.get('/admin/notice-reports/:fiscalYear/csv', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear'))
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)

  const company = await c.env.DB.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first()
  const staffRows = await c.env.DB.prepare(`
    SELECT us.name AS staff_name, r.target_count, r.read_count, r.unread_count, r.read_rate
    FROM notice_read_staff_reports r
    JOIN staff_profiles sp ON sp.staff_id = r.staff_id
    JOIN users us ON us.user_id = sp.user_id
    WHERE r.company_id = ? AND r.fiscal_year = ?
    ORDER BY us.name`).bind(u.company_id, fy).all()

  let csv = '\uFEFF年度,会社,スタッフ,対象数,既読数,未読数,既読率\n'
  for (const r of staffRows.results as any[]) {
    const rate = r.read_rate == null ? '-' : `${r.read_rate.toFixed(1)}%`
    csv += `${fy},${(company?.company_name as string) || ''},${r.staff_name},${r.target_count},${r.read_count},${r.unread_count},${rate}\n`
  }

  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="notice_read_report_${fy}.csv"`,
  })
})

// 相談対応
api.get('/admin/consultations', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT co.*, us.name AS staff_name FROM consultations co
    JOIN staff_profiles sp ON co.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE co.company_id = ? ORDER BY co.created_at DESC LIMIT 50`).bind(u.company_id).all()
  return c.json({ consultations: rows.results })
})

api.put('/admin/consultations/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  await c.env.DB.prepare('UPDATE consultations SET manager_reply = COALESCE(?, manager_reply), status = COALESCE(?, status) WHERE consultation_id = ? AND company_id = ?')
    .bind(b.manager_reply ?? null, b.status ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// フォロー履歴
api.get('/admin/follow-logs', async (c) => {
  const u = c.get('user')
  const staffId = c.req.query('staff_id')
  let sql = `SELECT f.*, us.name AS staff_name, um.name AS manager_name
    FROM follow_logs f JOIN staff_profiles sp ON f.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN users um ON f.manager_id = um.user_id WHERE f.company_id = ?`
  const binds: any[] = [u.company_id]
  if (staffId) { sql += ' AND f.staff_id = ?'; binds.push(staffId) }
  sql += ' ORDER BY f.created_at DESC LIMIT 50'
  const rows = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ logs: rows.results })
})

api.post('/admin/follow-logs', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.staff_id || !b.follow_type) return c.json({ error: 'スタッフと種別は必須です' }, 400)
  if (!FOLLOW_TYPES.includes(b.follow_type)) return c.json({ error: '対応種別が正しくありません' }, 400)
  if (b.status && !FOLLOW_STATUSES.includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
  if (!(await assertStaffInCompany(c, String(b.staff_id)))) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (b.related_project_id != null && b.related_project_id !== '' && !(await ownProject(c.env.DB, u.company_id, b.related_project_id))) return c.json({ error: '案件が見つかりません' }, 404)
  await c.env.DB.prepare(`INSERT INTO follow_logs (company_id, staff_id, manager_id, follow_type, content, next_action, status, related_project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, u.user_id, b.follow_type, b.content ?? '', b.next_action ?? null, b.status || 'open', b.related_project_id ?? null, nowJST()).run()
  return c.json({ ok: true })
})

api.put('/admin/follow-logs/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (b.status != null && !FOLLOW_STATUSES.includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
  await c.env.DB.prepare('UPDATE follow_logs SET status = COALESCE(?, status), next_action = COALESCE(?, next_action) WHERE follow_id = ? AND company_id = ?')
    .bind(b.status ?? null, b.next_action ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// 請求前確認
api.get('/admin/billing-check', async (c) => {
  const u = c.get('user'); const month = c.req.query('month') || monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT p.project_id, p.project_name, cl.client_name,
      COUNT(CASE WHEN s.status IN ('confirmed','substitute') THEN 1 END) AS work_days,
      COUNT(CASE WHEN s.status = 'absent' THEN 1 END) AS absent_days,
      COUNT(CASE WHEN s.status = 'substitute' THEN 1 END) AS substitute_days,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.unit_price ELSE 0 END) AS total_amount,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.transportation_fee ELSE 0 END) AS total_transport,
      COUNT(DISTINCT s.staff_id) AS staff_count,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND dr.work_date LIKE ?) AS report_count
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    LEFT JOIN shifts s ON s.project_id = p.project_id AND s.work_date LIKE ? AND s.work_date <= ?
    WHERE p.company_id = ? GROUP BY p.project_id`).bind(month + '%', month + '%', todayJST(), u.company_id).all()

  // スタッフ別明細
  const detail = await c.env.DB.prepare(`
    SELECT s.staff_id, us.name, p.project_name,
      COUNT(CASE WHEN s.status IN ('confirmed','substitute') THEN 1 END) AS work_days,
      COUNT(CASE WHEN s.status = 'absent' THEN 1 END) AS absent_days,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.unit_price ELSE 0 END) AS amount,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.transportation_fee ELSE 0 END) AS transport
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date LIKE ? AND s.work_date <= ?
    GROUP BY s.staff_id, s.project_id ORDER BY p.project_id, us.name`).bind(u.company_id, month + '%', todayJST()).all()

  return c.json({ month, by_project: rows.results, detail: detail.results })
})

// テンプレート一覧 (企業側から参照)
api.get('/admin/templates', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare('SELECT * FROM report_templates WHERE company_id IS NULL OR company_id = ? ORDER BY template_id').bind(u.company_id).all()
  return c.json({ templates: (rows.results as any[]).map(t => ({ ...t, fields: JSON.parse(t.fields_json) })) })
})

// =========================================================
// SaaS本部 API
// =========================================================
api.get('/hq/companies', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT co.*,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND u.status = 'active' AND u.role != 'roster_only') AS user_count,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND u.last_login_at >= date('now', '-7 days')) AS active_users,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.company_id = co.company_id AND dr.work_date >= date('now', '-30 days')) AS reports_30d
    FROM companies co ORDER BY co.company_id`).all()
  // 料金計算: 基本990円(3ユーザー) + 追加1ユーザー300円
  const companies = (rows.results as any[]).map(co => ({
    ...co,
    monthly_fee: 990 + Math.max(0, (co.user_count || 0) - 3) * 300
  }))
  return c.json({ companies })
})

api.get('/hq/companies/:id', async (c) => {
  const cid = c.req.param('id')
  const company = await c.env.DB.prepare('SELECT * FROM companies WHERE company_id = ?').bind(cid).first()
  if (!company) return c.json({ error: 'not found' }, 404)
  const users = await c.env.DB.prepare('SELECT user_id, user_code, name, role, status, last_login_at FROM users WHERE company_id = ? ORDER BY user_id').bind(cid).all()
  const stats = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM daily_reports WHERE company_id = ?) AS total_reports,
      (SELECT COUNT(*) FROM shifts WHERE company_id = ?) AS total_shifts,
      (SELECT COUNT(*) FROM attendance_reports WHERE company_id = ?) AS total_attendance,
      (SELECT COUNT(*) FROM projects WHERE company_id = ? AND status = 'active') AS active_projects`).bind(cid, cid, cid, cid).first()
  return c.json({ company, users: users.results, stats })
})

api.put('/hq/companies/:id', async (c) => {
  const b = await c.req.json()
  if (b.active_status != null && !['active', 'trial', 'inactive'].includes(b.active_status)) return c.json({ error: '利用状態の値が正しくありません' }, 400)
  await c.env.DB.prepare(`UPDATE companies SET
      plan = COALESCE(?, plan), user_limit = COALESCE(?, user_limit), active_status = COALESCE(?, active_status),
      billing_status = COALESCE(?, billing_status), support_memo = COALESCE(?, support_memo), maturity_level = COALESCE(?, maturity_level)
    WHERE company_id = ?`)
    .bind(b.plan ?? null, b.user_limit ?? null, b.active_status ?? null, b.billing_status ?? null, b.support_memo ?? null, b.maturity_level ?? null, c.req.param('id')).run()
  // 停止にした時点で、その企業の利用者（本部ユーザーを除く）をログアウトさせる
  const revoked = b.active_status === 'inactive' ? await revokeCompanySessions(c.env.DB, Number(c.req.param('id'))) : 0
  return c.json({ ok: true, revoked_sessions: revoked })
})

api.post('/hq/companies', async (c) => {
  const b = await c.req.json()
  b.company_code = String(b.company_code ?? '').trim()
  b.admin_code = String(b.admin_code ?? '').trim()
  if (!b.company_code || !b.company_name) return c.json({ error: '会社コードと会社名は必須です' }, 400)
  if (b.admin_code || b.admin_password) {
    if (!b.admin_code) return c.json({ error: '初期管理者のIDを入力してください' }, 400)
    const pwErr = validatePassword(b.admin_password)
    if (pwErr) return c.json({ error: '初期管理者の' + pwErr }, 400)
  }
  try {
    const r = await c.env.DB.prepare('INSERT INTO companies (company_code, company_name, plan, user_limit, active_status) VALUES (?, ?, ?, ?, ?)')
      .bind(b.company_code, b.company_name, b.plan || 'basic', b.user_limit || 3, 'trial').run()
    // 初期管理者作成
    if (b.admin_code && b.admin_password) {
      const hash = await hashPassword(b.admin_password)
      await c.env.DB.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash) VALUES (?, ?, ?, 'company_admin', ?)`)
        .bind(r.meta.last_row_id, b.admin_code, b.admin_name || '管理者', hash).run()
    }
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: '会社コードが重複しています' }, 409)
  }
})

// テンプレート配信管理
api.get('/hq/templates', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM report_templates ORDER BY template_id').all()
  return c.json({ templates: (rows.results as any[]).map(t => ({ ...t, fields: JSON.parse(t.fields_json) })) })
})

api.post('/hq/templates', async (c) => {
  const b = await c.req.json()
  if (!b.template_name || !b.fields) return c.json({ error: 'テンプレート名と項目は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO report_templates (company_id, template_name, template_type, fields_json) VALUES (NULL, ?, 'hq', ?)`)
    .bind(b.template_name, JSON.stringify(b.fields)).run()
  return c.json({ ok: true })
})

// ============ データ保持（定期削除、system_admin限定）============
// 注意: 実際の削除はCron Triggerからのみ実行する（HTTP経由の一般APIとしては公開しない）。
// ここではdry-run（削除せず対象件数のみ確認）と、過去の実行ログの閲覧のみ提供する。
// 全社にまたがる集計のため、各社admin(company_admin等)ではなく本部(system_admin)限定とする。
api.post('/hq/retention/dry-run', async (c) => {
  const result = await runRetentionCleanup(c.env.DB, c.env.PHOTOS, { dryRun: true })
  return c.json(result)
})

// 次回削除予定（猶予中・猶予待ち）と、退職日より後にシフトがあるため対象外にしている退職者の一覧
api.get('/hq/retention/schedule', async (c) => {
  return c.json(await listRetentionSchedule(c.env.DB))
})

api.get('/hq/retention/logs', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM retention_logs ORDER BY log_id DESC LIMIT 30').all()
  return c.json({ logs: rows.results })
})

export default api

