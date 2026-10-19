import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { JSON_IN, batchInChunks, bindJsonArray } from './lib/d1-chunk'
import { sendEmail, sendEmailBatch, mailMode } from './services/email'
import { passwordResetEmail } from './email-templates/password-reset'
import { noticeEmail } from './email-templates/notice'
import { runRetentionCleanup, listRetentionSchedule, validateRetiredAt, isRetirementEffective, RETENTION_NON_ROW_TARGETS } from './services/retention'
import { cronStatus } from './services/cron'
import { buildUpdate } from './lib/update-builder'
import chatApi from './roster-chat'
import shiftBoardApi, { MONEY_MAX, applyPricingToShift, rangeError, stripMoney } from './shift-board'
import boardApi from './board'
import settlementApi, { syncActualFromReports } from './settlement'
import { shiftTotals } from './shift-board'
import { recruitAdminApi, recruitPublicApi, recruitStaffApi } from './recruit'
import { staffMergeApi } from './staff-merge'
import { adminLifecycleApi, publicReportApi, modesForShifts, resolveModes, normalizePhone, findStaffByPhone } from './staff-lifecycle'
import { loginEmailVerifyEmail } from './email-templates/login-email'
import reportSettingsApi, { REPORT_TYPES as ALL_REPORT_TYPES, ACTUAL_SYNC_TYPES, checkStaffReport, lateness, latenessSettings, loadReportState, reportStatus, reportableTypes, reportedAtMinute, MAX_LATE_GRACE_MINUTES } from './report-settings'
import { dailyReportRequiredSql } from './report-settings'
import { isTentativeShift, WORKING_SHIFT_STATUSES } from './lib/shift-status'
import { addDays, addMinutes, crossesMidnight, isWithin, reportableWindow, shiftWindow } from './lib/shift-time'
import { correctionsAdminApi, correctionsStaffApi, actorOf, autoCancelStatements, notifyAutoCancelled, newCancelToken, pendingCorrectionCount } from './corrections'
import { notificationsAdminApi, notificationsStaffApi, notifyDailyReportIncident } from './notifications'
import { toCsv, csvResponse } from './csv'
import {
  SESSION_COOKIE, SESSION_HOURS, LOGIN_WINDOW_MINUTES, hashPassword, verifyPassword, needsRehash, dummyVerify, validatePassword, normalizeEmail,
  hashToken, isCompanyActive, canLogin, revokeSessions, revokeCompanySessions, loadSessionUser, homePathFor, sessionCookieOptions,
  loginAttemptKeys, isLoginLocked, recordLoginFailure, clearLoginFailures,
} from './lib/auth'
import rosterApi, { staffSelfApi, personStaffRows, ensureRosterIdentity, loadRoster, createPerson, partnerNameConflict, propagateNameToLinked, propagateRetirementStmts, ROSTER_BASE_FIELDS, ROSTER_BUSINESS_FIELDS, normalizeCareerRows, careerSummary, getRequiredFields, missingRequired, normalizeRosterValues, linkedStaffEmails } from './roster'
import { isHHMM, isISODate, oneOf, toInt, pickReportValues, reportFieldRulesError, cleanFileName, CONSULT_CATEGORIES, CONSULT_URGENCIES } from './lib/validate'
import { ownProject, ownClient, ownStaff, ownNotice, ownShift } from './lib/tenant'
import { authAccountApi, adminUsersApi, hqUsersApi, cleanEmail, genTempPassword, HQ_COMPANY_STATUS } from './accounts'
import { findDailyReport, dailyReportView, dailyReportBlocked, saveDailyReport, mergeIncidentNotes } from './lib/daily-report'
import { assertAssignable, assignableStaffSql, isUniqueViolation } from './lib/staff-eligibility'
import { NOTICE_TARGET_SQL, loadStaffNotices, countUnreadNotices } from './lib/notices'

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
// system_admin（SaaS本部）は含めない。本部ユーザーは本部専用の企業行（0033。active_status='internal'）に所属し、
// /admin を操作できると本部の操作がその企業のデータとして登録されてしまう。本部は /hq のみを使う。
const ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
// 従業員管理（給与・口座・保険番号・緊急連絡先・入社時書類）を扱えるロール（#205）。現場管理者・営業管理者は扱えない
const HR_ROLES = ['company_admin', 'office_staff']

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

// ============ お知らせの配信対象と既読率レポート（集計・Cron共用ロジック） ============
// 配信対象の判定（NOTICE_TARGET_SQL）は src/lib/notices.ts にまとめ、一覧の「既読 x/y名」・既読状況・メールの宛先・
// 既読率レポートと、スタッフの一覧・ホーム・企業切替の未読数で同じものを使う（#7 #370）。
// 条件は n = notices、us = users、sp = staff_profiles の別名を前提にする。
// 今の対象者（一覧の既読数・既読状況・メールの宛先）: いま在籍中で、ログインのあるスタッフ
const NOTICE_MEMBER_NOW_SQL = `us.company_id = n.company_id AND us.role = 'staff' AND us.status = 'active' AND sp.merged_into_staff_id IS NULL`
// 公開した時点の対象者（既読率レポート）: 後で退職した人も含めて、公開日に在籍していた人（#49。今の在籍状況では決めない）。
// 退職日の無い停止中の人（退職日の列ができる前に退職した人など）は、いつまで在籍したか分からないので含めない
const NOTICE_MEMBER_AT_PUBLISH_SQL = `us.company_id = n.company_id AND us.role = 'staff' AND sp.merged_into_staff_id IS NULL
  AND ((us.retired_at IS NULL AND us.status = 'active') OR us.retired_at >= date(n.published_at))`
// お知らせ n の今の対象人数・既読人数（既読は対象者の分だけ数える。退職者や対象外の人の既読は含めない）
const NOTICE_TARGET_COUNT_NOW_SQL = `(SELECT COUNT(DISTINCT us.user_id) FROM users us JOIN staff_profiles sp ON sp.user_id = us.user_id
  WHERE ${NOTICE_MEMBER_NOW_SQL} AND ${NOTICE_TARGET_SQL})`
const NOTICE_READ_COUNT_NOW_SQL = `(SELECT COUNT(DISTINCT us.user_id) FROM notice_reads r JOIN users us ON us.user_id = r.user_id JOIN staff_profiles sp ON sp.user_id = us.user_id
  WHERE r.notice_id = n.notice_id AND ${NOTICE_MEMBER_NOW_SQL} AND ${NOTICE_TARGET_SQL})`

// 既読の記録（notice_reads）は、お知らせの公開から2年で削除する（purgeOldNoticeReads）
const NOTICE_READS_KEEP_DAYS = 730
// 前年度のレポートは、年度末からこの日数がたったら最後の集計をして確定する（#49）
const NOTICE_REPORT_FINALIZE_AFTER_DAYS = 30

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
  const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE company_id = ? AND published_at >= ? AND published_at < ?`)
    .bind(companyId, start, end).first() as { n: number } | null
  // お知らせ×対象者の組を、スタッフごとにまとめて1回で数える（在籍者を IN に並べない。D1 のバインド上限を超えないように）
  const rows = (await db.prepare(`
    SELECT sp.staff_id, COUNT(*) AS target_n,
      SUM(EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = us.user_id)) AS read_n
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    WHERE n.company_id = ? AND n.published_at >= ? AND n.published_at < ?
      AND ${NOTICE_MEMBER_AT_PUBLISH_SQL} AND ${NOTICE_TARGET_SQL}
    GROUP BY sp.staff_id`).bind(companyId, start, end).all()).results as { staff_id: number; target_n: number; read_n: number }[]

  const perStaff = new Map<number, { target: number; read: number }>()
  let targetUserCount = 0
  let readCount = 0
  for (const r of rows) {
    perStaff.set(r.staff_id, { target: r.target_n, read: r.read_n })
    targetUserCount += r.target_n
    readCount += r.read_n
  }
  return {
    targetNoticeCount: cnt?.n || 0,
    targetUserCount,
    readCount,
    unreadCount: targetUserCount - readCount,
    readRate: targetUserCount > 0 ? round1((readCount / targetUserCount) * 100) : null,
    perStaff,
  }
}

// 再集計できない理由（できるなら null）。確定した年度と、既読の記録が削除され始めた年度は作り直さない（#48 #49）
function noticeReportRecalcBlock(fiscalYear: number, finalizedAt: string | null | undefined): string | null {
  if (fiscalYear > currentFiscalYear()) return 'まだ始まっていない年度は集計できません'
  if (finalizedAt) return '確定済みの年度のため、再集計できません'
  if (todayJST() >= addDays(fiscalYearRange(fiscalYear).start, NOTICE_READS_KEEP_DAYS)) {
    return '既読の記録の保存期間（2年）を過ぎた年度のため、再集計できません'
  }
  return null
}

// 指定会社・年度のレポートを再計算して保存する（同一年度を何度実行しても重複しない）。
// finalize = true なら、集計した値で確定する。確定済み・保存期間外の年度は作り直さず、理由を返す
async function generateNoticeReadReport(db: D1Database, companyId: number, fiscalYear: number, opts: { finalize?: boolean } = {}):
  Promise<{ ok: true; calculated_at: string; finalized: boolean } | { ok: false; reason: string }> {
  const cur = await db.prepare('SELECT finalized_at FROM notice_read_reports WHERE company_id = ? AND fiscal_year = ?')
    .bind(companyId, fiscalYear).first() as { finalized_at: string | null } | null
  const blocked = noticeReportRecalcBlock(fiscalYear, cur?.finalized_at)
  if (blocked) return { ok: false, reason: blocked }

  const r = await computeNoticeReadReport(db, companyId, fiscalYear)
  const now = nowJST()
  const stmts: D1PreparedStatement[] = []
  // 今回の対象に入らなかったスタッフの行は消す（古い値の行が残って、年度全体とスタッフ別の合計が合わなくなるのを防ぐ #481）
  stmts.push(db.prepare(`DELETE FROM notice_read_staff_reports WHERE company_id = ? AND fiscal_year = ? AND staff_id NOT IN ${JSON_IN}`)
    .bind(companyId, fiscalYear, bindJsonArray(r.perStaff.keys())))
  for (const [staffId, v] of r.perStaff) {
    const rate = v.target > 0 ? round1((v.read / v.target) * 100) : null
    stmts.push(db.prepare(`
      INSERT INTO notice_read_staff_reports (company_id, fiscal_year, staff_id, target_count, read_count, unread_count, read_rate, calculated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, fiscal_year, staff_id) DO UPDATE SET
        target_count = excluded.target_count, read_count = excluded.read_count, unread_count = excluded.unread_count,
        read_rate = excluded.read_rate, calculated_at = excluded.calculated_at, updated_at = excluded.updated_at
    `).bind(companyId, fiscalYear, staffId, v.target, v.read, v.target - v.read, rate, now, now))
  }
  // 年度全体は最後に書く（確定もここで行う。確定済みの行は上書きしない）
  stmts.push(db.prepare(`
    INSERT INTO notice_read_reports (company_id, fiscal_year, target_notice_count, target_user_count, read_count, unread_count, read_rate, calculated_at, updated_at, finalized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, fiscal_year) DO UPDATE SET
      target_notice_count = excluded.target_notice_count, target_user_count = excluded.target_user_count,
      read_count = excluded.read_count, unread_count = excluded.unread_count, read_rate = excluded.read_rate,
      calculated_at = excluded.calculated_at, updated_at = excluded.updated_at, finalized_at = excluded.finalized_at
    WHERE notice_read_reports.finalized_at IS NULL
  `).bind(companyId, fiscalYear, r.targetNoticeCount, r.targetUserCount, r.readCount, r.unreadCount, r.readRate, now, now, opts.finalize ? now : null))
  await batchInChunks(db, stmts)
  return { ok: true, calculated_at: now, finalized: !!opts.finalize }
}

// 1回の起動で集計する会社数の上限（1社あたり数回の問い合わせ。D1 の1回の起動あたりの上限に当たらないように。#198）
const NOTICE_REPORT_COMPANIES_PER_RUN = 30

// Cron: 全社について、今年度（年度の途中の値を毎日更新する #481）と前年度のレポートを作る（冪等）。
// 前年度は、年度末から30日たったら最後の集計をして確定し、それ以降は作り直さない（#49）。
// 1回の起動では、今日まだ集計していない会社を、前回の集計の古い順に上限まで処理し、残りは次回に回す（#198）。
// 確定済みの前年度は問い合わせずに飛ばす
export async function generateFiscalYearReportsForAllCompanies(db: D1Database):
  Promise<{ companies: number; remaining: number; ok: number; failed: number; finalized: number; error: string | null }> {
  const cur = currentFiscalYear()
  const finalizeLast = todayJST() >= addDays(fiscalYearRange(cur - 1).end, NOTICE_REPORT_FINALIZE_AFTER_DAYS)
  const pending = `FROM companies c
    LEFT JOIN notice_read_reports cr ON cr.company_id = c.company_id AND cr.fiscal_year = ?
    LEFT JOIN notice_read_reports pr ON pr.company_id = c.company_id AND pr.fiscal_year = ?
    WHERE cr.calculated_at IS NULL OR cr.calculated_at < ?`
  const today = todayJST()
  const companies = (await db.prepare(`SELECT c.company_id, pr.finalized_at AS prev_finalized_at ${pending}
    ORDER BY cr.calculated_at IS NOT NULL, cr.calculated_at, c.company_id LIMIT ?`)
    .bind(cur, cur - 1, today, NOTICE_REPORT_COMPANIES_PER_RUN).all()).results as { company_id: number; prev_finalized_at: string | null }[]
  let ok = 0, failed = 0, finalized = 0
  const errors: string[] = []
  for (const row of companies) {
    for (const fy of row.prev_finalized_at ? [cur] : [cur - 1, cur]) {
      try {
        const r = await generateNoticeReadReport(db, row.company_id, fy, { finalize: fy === cur - 1 && finalizeLast })
        if (r.ok) { ok++; if (r.finalized) finalized++ }
      } catch (e) {
        failed++
        if (errors.length < 3) errors.push(`company_id=${row.company_id} fiscal_year=${fy}: ${String(e).slice(0, 200)}`)
        console.log(`notice_read_reports generation failed: company_id=${row.company_id} fiscal_year=${fy} error=${e}`)
      }
    }
  }
  // 今日の集計が済んでいない会社の残り（失敗した会社も含む。翌日以降に古い順で処理する）
  const left = await db.prepare(`SELECT COUNT(*) AS n ${pending}`).bind(cur, cur - 1, today).first() as { n: number } | null
  return { companies: companies.length, remaining: left?.n || 0, ok, failed, finalized, error: errors.length ? errors.join(' / ') : null }
}

// Cron: 公開から2年（730日）たったお知らせの既読の記録（notice_reads）を削除する。
// お知らせごとに、削除の直前の既読数・対象人数を notices に残してから、そのお知らせの記録をまとめて消す（#245。
// 管理画面の「既読 x/y名」が0名に戻らないように。1件のお知らせの記録が一部だけ消えた状態も作らない）。
// そのあとで、締めた後に付いた既読などの残りを、既読の日時から2年で削除する（1回のCronでそれぞれ上限まで。続きは翌日以降）
export async function purgeOldNoticeReads(db: D1Database): Promise<{ deleted: number; notices: number; batches: number; error?: string }> {
  const keepMs = NOTICE_READS_KEEP_DAYS * 24 * 3600 * 1000
  const cutoffJst = new Date(Date.now() + 9 * 3600 * 1000 - keepMs).toISOString().slice(0, 19).replace('T', ' ')
  const cutoffUtc = new Date(Date.now() - keepMs).toISOString().slice(0, 19).replace('T', ' ') // read_at は UTC（列の既定値）
  const NOTICE_BATCH = 20
  const BATCH_SIZE = 500
  const MAX_BATCHES = 20
  let deleted = 0, notices = 0, batches = 0
  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const ids = ((await db.prepare(`SELECT notice_id FROM notices WHERE reads_purged_at IS NULL AND published_at < ? ORDER BY published_at LIMIT ?`)
        .bind(cutoffJst, NOTICE_BATCH).all()).results as { notice_id: number }[]).map(r => r.notice_id)
      if (!ids.length) break
      const json = bindJsonArray(ids)
      const res = await db.batch([
        db.prepare(`UPDATE notices AS n SET final_target_count = ${NOTICE_TARGET_COUNT_NOW_SQL}, final_read_count = ${NOTICE_READ_COUNT_NOW_SQL},
            reads_purged_at = ? WHERE n.notice_id IN ${JSON_IN} AND n.reads_purged_at IS NULL`).bind(nowJST(), json),
        db.prepare(`DELETE FROM notice_reads WHERE notice_id IN ${JSON_IN}`).bind(json),
      ])
      notices += ids.length
      deleted += res[1].meta.changes || 0
      batches++
      if (ids.length < NOTICE_BATCH) break
    }
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await db.prepare(`
        DELETE FROM notice_reads WHERE (notice_id, user_id) IN (
          SELECT notice_id, user_id FROM notice_reads WHERE read_at < ? LIMIT ?
        )
      `).bind(cutoffUtc, BATCH_SIZE).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes) batches++
      if (changes < BATCH_SIZE) break
    }
    return { deleted, notices, batches }
  } catch (e) {
    console.log(`notice_reads purge failed after deleting ${deleted}: error=${e}`)
    return { deleted, notices, batches, error: String(e) }
  }
}

// ============ Auth ============
// 会社コード・ID・パスワードのどれが違っても同じ文言・同じステータスで返す（会社コードの有無を推測されないように）
const LOGIN_FAILED_MESSAGE = '会社コード・ID・パスワードのいずれかが正しくありません'
const LOGIN_HELP = 'ログインできない場合は、所属の会社の担当者にお問い合わせください'
// パスワード再設定の受付の、接続元（IP）ごとの1時間あたりの上限（#382。同じ店舗の Wi-Fi から複数人が使っても足りる数）
const RESET_IP_MAX = 20
// 会社コード・ID は、全角で入力されても照合できるよう NFKC でそろえる（#201 #387）
export function normalizeLoginCode(v: unknown): string {
  return String(v ?? '').normalize('NFKC').trim()
}
// 完全一致がなければ、大文字・小文字の違いだけのものを探す（スマホの自動大文字化で「Sample」「St001」と入っても通す）。
// 大文字・小文字だけが違う行が複数あるときは、どれか決められないので一致なしにする。
// 以前は全角のまま保存できたため、正規化した値で見つからなければ、入力どおり（trim のみ）の値でも完全一致を探す
async function findCompanyByCode(db: D1Database, code: string, raw: string): Promise<any> {
  const exact = await db.prepare('SELECT * FROM companies WHERE company_code = ?').bind(code).first()
  if (exact) return exact
  const rows = (await db.prepare('SELECT * FROM companies WHERE LOWER(company_code) = LOWER(?) LIMIT 2').bind(code).all()).results
  if (rows.length === 1) return rows[0]
  return raw && raw !== code ? await db.prepare('SELECT * FROM companies WHERE company_code = ?').bind(raw).first() : null
}
async function findUserByCode(db: D1Database, companyId: number, code: string, raw: string): Promise<any> {
  const exact = await db.prepare('SELECT * FROM users WHERE company_id = ? AND user_code = ?').bind(companyId, code).first()
  if (exact) return exact
  const rows = (await db.prepare('SELECT * FROM users WHERE company_id = ? AND LOWER(user_code) = LOWER(?) LIMIT 2').bind(companyId, code).all()).results
  if (rows.length === 1) return rows[0]
  return raw && raw !== code ? await db.prepare('SELECT * FROM users WHERE company_id = ? AND user_code = ?').bind(companyId, raw).first() : null
}
api.post('/auth/login', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const company_code = normalizeLoginCode(b.company_code)
  const user_code = normalizeLoginCode(b.user_code)
  const rawCompanyCode = String(b.company_code ?? '').trim(), rawUserCode = String(b.user_code ?? '').trim()
  const password = typeof b.password === 'string' ? b.password : ''
  // 会社コードは本部ユーザーだけ空欄でよい（#372）
  if (!user_code || !password) return c.json({ error: '入力内容が不足しています' }, 400)
  const db = c.env.DB
  const ip = c.req.header('CF-Connecting-IP')
  const lockedResponse = () => c.json({ error: `ログインの失敗が続いたため、一時的にログインを止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください。${LOGIN_HELP}` }, 429)

  let keys = await loginAttemptKeys(company_code, user_code, ip)
  if (await isLoginLocked(db, keys)) return lockedResponse()

  let company = company_code ? await findCompanyByCode(db, company_code, rawCompanyCode) : null
  let user = company ? await findUserByCode(db, company.company_id, user_code, rawUserCode) : null
  // 本部ユーザー（本部専用の企業行に所属）は会社コードなしでログインする。以前の案内どおり会社コードを入れても、
  // その会社に同じ ID がなければ本部ユーザーとして照合する。失敗回数は会社コードによらず同じ記録で数える
  if (!user) {
    const hq = await db.prepare(`SELECT u.* FROM users u JOIN companies co ON co.company_id = u.company_id
      WHERE co.active_status = ? AND u.role = 'system_admin' AND LOWER(u.user_code) = LOWER(?) ORDER BY (u.user_code != ?), u.user_id LIMIT 1`).bind(HQ_COMPANY_STATUS, user_code, user_code).first() as any
    if (hq) {
      if (company_code) {
        keys = await loginAttemptKeys('', user_code, ip)
        if (await isLoginLocked(db, keys)) return lockedResponse()
      }
      user = hq
      company = await db.prepare('SELECT * FROM companies WHERE company_id = ?').bind(hq.company_id).first() as any
    }
  }
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

  // 会社コード・ID は登録どおりの表記で返す（ログイン画面が次回の入力欄に入れておく。#308）
  return c.json({ ok: true, user: { user_id: user.user_id, name: user.name, role: user.role, company_name: company.company_name, must_change_password: !!user.must_change_password },
    company_code: user.role === 'system_admin' ? '' : company.company_code, user_code: user.user_code, redirect: homePathFor(user.role) })
})

// パスワード再設定メールの送信リクエスト
// セキュリティ: メールアドレスの存在有無に関わらず常に同じレスポンスを返す（アカウント存在の推測を防ぐ）
api.post('/auth/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string }))
  const genericResponse = { ok: true, message: '登録されているメールアドレスの場合は、パスワード再設定メールを送信しました。数分たっても届かない場合は、所属の会社の担当者にお問い合わせください。' }
  // メールアドレスは前後の空白を除き、小文字にそろえて照合する（登録時の表記ゆれで届かないのを防ぐ）
  const email = normalizeEmail(body.email)
  if (!email) return c.json(genericResponse)

  // 接続元ごとの回数制限（#382）: 1時間に RESET_IP_MAX 件まで受け付ける。超えても同じ応答を返す（制限に達したことも、アカウントの有無も伝えない）。
  // 記録は login_attempts（scope='reset_ip'。IP はハッシュで保存し、1日たつと定期処理で消える）
  const ip = c.req.header('CF-Connecting-IP')
  if (ip) {
    try {
      const key = await sha256(`reset_ip|${ip}`)
      const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE scope = 'reset_ip' AND key_hash = ? AND attempted_at > ?`)
        .bind(key, new Date(Date.now() - 3600 * 1000).toISOString()).first() as any
      if ((n?.n || 0) >= RESET_IP_MAX) return c.json(genericResponse)
      await c.env.DB.prepare(`INSERT INTO login_attempts (scope, key_hash, attempted_at) VALUES ('reset_ip', ?, ?)`).bind(key, new Date().toISOString()).run()
    } catch (e) { console.log(`reset_ip limit failed: ${e}`) }
  }

  // 簡易レート制限: 同一メールアドレスへの直近1時間のリクエストが5件を超えたら新規発行しない
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM password_reset_tokens t JOIN users u ON u.user_id = t.user_id WHERE LOWER(TRIM(u.email)) = ? AND t.created_at > datetime('now', '-1 hour')`
  ).bind(email).first()
  if (((recent?.n as number) || 0) >= 5) return c.json(genericResponse)

  // ログインできる行だけが対象（仮登録・スタッフマスタだけの行、退職者、停止中の企業の利用者は除く）
  const users = await c.env.DB.prepare(`SELECT u.user_id, u.name, u.user_code, u.email, u.company_id, u.role, co.company_name, co.company_code
    FROM users u JOIN companies co ON co.company_id = u.company_id
    WHERE LOWER(TRIM(u.email)) = ? AND u.status = 'active' AND u.role != 'roster_only'
      AND (COALESCE(co.active_status, 'active') != 'inactive' OR u.role = 'system_admin')`).bind(email).all()
  const EXPIRES_HOURS = 1
  for (const u of users.results as { user_id: number; name: string; user_code: string; email: string; company_id: number; role: string; company_name: string; company_code: string }[]) {
    const rawToken = genToken()
    const tokenHash = await hashToken(rawToken)
    const expiresAt = new Date(Date.now() + EXPIRES_HOURS * 3600 * 1000).toISOString()
    await c.env.DB.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .bind(u.user_id, tokenHash, expiresAt).run()

    const resetUrl = `${c.env.APP_BASE_URL}/reset-password?token=${rawToken}`
    // 同じメールアドレスに複数の会社のアカウントがあっても、どのアカウントのリンクか分かるように会社名とIDを入れる
    // ログインに必要な会社コードも入れる（本部ユーザーは会社コードなしでログインするため入れない。#208）
    const tpl = passwordResetEmail({ name: u.name, resetUrl, expiresInHours: EXPIRES_HOURS, companyName: u.company_name, userCode: u.user_code,
      companyCode: u.role === 'system_admin' ? undefined : u.company_code })
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
    `SELECT t.*, u.status AS user_status, u.role AS user_role, u.user_code, co.company_code FROM password_reset_tokens t JOIN users u ON u.user_id = t.user_id
     JOIN companies co ON co.company_id = u.company_id
     WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?`
  ).bind(tokenHash, new Date().toISOString()).first() as any
  if (!row || row.user_status !== 'active' || !canLogin(row.user_role)) return c.json({ error: 'このリンクは無効か、有効期限が切れています' }, 400)

  // 本人が決めたパスワードになるので、仮パスワードの変更の要求は消す
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE user_id = ?').bind(await hashPassword(password), row.user_id).run()
  await c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .bind(nowJST(), row.user_id).run() // 同一ユーザーの他の未使用トークンも合わせて失効させる
  // 乗っ取られた場合に備え、既存のセッションはすべて切る（再設定後はログインし直す）
  await revokeSessions(c.env.DB, row.user_id)

  // 完了画面からログイン画面へ、会社コードと ID を入れた状態で移れるように返す（#208）
  return c.json({ ok: true, company_code: row.user_role === 'system_admin' ? '' : row.company_code, user_code: row.user_code })
})

// ログイン用メールアドレスの確認（#207）。管理者が登録したアドレスに届いたリンク（/verify-email）から、本人が確認したときに有効にする
api.post('/auth/verify-email', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const token = typeof b.token === 'string' ? b.token : ''
  const invalid = () => c.json({ error: 'このリンクは無効か、有効期限が切れています。所属の会社の担当者にお問い合わせください' }, 400)
  if (!token) return invalid()
  const db = c.env.DB
  const v = await db.prepare(`SELECT v.*, u.status AS user_status, u.role AS user_role, u.user_code, co.company_code, co.company_name
    FROM login_email_verifications v JOIN users u ON u.user_id = v.user_id AND u.company_id = v.company_id JOIN companies co ON co.company_id = v.company_id
    WHERE v.token_hash = ? AND v.verified_at IS NULL AND v.canceled_at IS NULL AND v.expires_at > ?`).bind(await hashToken(token), new Date().toISOString()).first() as any
  if (!v || v.user_status !== 'active' || v.user_role !== 'staff') return invalid()
  const now = nowJST()
  await db.batch([
    db.prepare('UPDATE users SET email = ? WHERE user_id = ?').bind(v.email, v.user_id),
    db.prepare('UPDATE login_email_verifications SET verified_at = ? WHERE verification_id = ?').bind(now, v.verification_id),
    // 同じ人のほかの確認待ちは取り消し、以前のアドレスに送った再設定リンクは使えなくする
    db.prepare('UPDATE login_email_verifications SET canceled_at = ? WHERE user_id = ? AND verification_id != ? AND verified_at IS NULL AND canceled_at IS NULL').bind(now, v.user_id, v.verification_id),
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now, v.user_id),
  ])
  return c.json({ ok: true, email: v.email, company_name: v.company_name, company_code: v.company_code, user_code: v.user_code })
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
  const u = r.user
  // 同じブラウザで別のアカウントにログインし直されたら、開いたままの画面からの操作を通さない（#346）。
  // 画面は起動時に読んだ自分の user_id を X-Expected-User-Id で送る。違えば別の人として記録しないよう 409 で止める
  const expected = c.req.header('X-Expected-User-Id')
  c.header('X-User-Id', String(u.user_id))
  if (expected && expected !== String(u.user_id)) {
    return c.json({ error: '別のアカウントでログインされたため、この画面からは操作できません。画面を読み直してください', code: 'account_switched' }, 409)
  }
  c.header('X-Session-Expires', await extendSession(c, token!, u))
  c.set('user', u)
  return next()
})

// セッションの延長（#180）: 利用者の操作による API 呼び出しのたびに、期限を「今から一定時間」に延ばす。
// ・バッジ更新などの定期の取得（X-Background: 1）では延ばさない（画面を開いたままでも、操作がなければ期限が来る）
// ・ログインから最長期間（SESSION_MAX_DAYS）を超えては延ばさない
// ・書き込みを減らすため、前回の延長から SESSION_EXTEND_STEP_MINUTES 以上たったときだけ更新する
// スタッフは日をまたぐ勤務や翌日の報告があるため、操作のない時間の上限と最長期間を長くする
const SESSION_IDLE_HOURS: Record<string, number> = { staff: 72 }
const SESSION_MAX_DAYS: Record<string, number> = { staff: 30 }
const SESSION_MAX_DAYS_DEFAULT = 7
const SESSION_EXTEND_STEP_MINUTES = 10
async function extendSession(c: any, token: string, u: any): Promise<string> {
  const current = String(u.expires_at)
  if (c.req.header('X-Background') === '1') return current
  const idleHours = SESSION_IDLE_HOURS[u.role] ?? SESSION_HOURS
  const maxDays = SESSION_MAX_DAYS[u.role] ?? SESSION_MAX_DAYS_DEFAULT
  const target = new Date(Date.now() + idleHours * 3600 * 1000).toISOString()
  if (Date.parse(current) > Date.parse(target) - SESSION_EXTEND_STEP_MINUTES * 60 * 1000) return current
  // created_at は CURRENT_TIMESTAMP（UTC）。expires_at と同じ ISO 8601 の書式にして比べる
  const maxSql = `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+${maxDays} days'), expires_at)`
  const row = await c.env.DB.prepare(`UPDATE sessions SET expires_at = MIN(?, ${maxSql})
      WHERE token = ? AND expires_at < MIN(?, ${maxSql}) RETURNING expires_at`)
    .bind(target, await hashToken(token), target).first() as any
  if (!row) return current
  const maxAge = Math.floor((Date.parse(row.expires_at) - Date.now()) / 1000)
  if (maxAge > 0) setCookie(c, SESSION_COOKIE, token, { ...sessionCookieOptions(c), maxAge })
  return String(row.expires_at)
}

api.get('/auth/me', (c) => {
  const u = c.get('user')
  return c.json({ user_id: u.user_id, name: u.name, role: u.role, company_name: u.company_name, staff_id: u.staff_id, company_id: u.company_id,
    company_code: u.role === 'system_admin' ? '' : (u.company_code || ''), can_manage_hr: HR_ROLES.includes(u.role),
    user_code: u.user_code, email: u.email || null, must_change_password: !!u.must_change_password })
})

// 権限チェックミドルウェア
api.use('/admin/*', async (c, next) => {
  if (!ADMIN_ROLES.includes(c.get('user')?.role)) return c.json({ error: 'forbidden' }, 403)
  return next()
})
// 従業員管理（社員名簿・入社時書類）は会社管理者・事務担当のみ（#205）
const hrOnly = async (c: any, next: any) => {
  if (!HR_ROLES.includes(c.get('user')?.role)) return c.json({ error: '従業員管理（給与・口座・保険番号などの労務情報）は、会社管理者と事務担当のみ利用できます', code: 'hr_forbidden' }, 403)
  return next()
}
api.use('/admin/employees', hrOnly)
api.use('/admin/employees/*', hrOnly)
api.use('/hq/*', async (c, next) => {
  if (c.get('user')?.role !== 'system_admin') return c.json({ error: 'forbidden' }, 403)
  return next()
})
// スタッフ本人向け API（/api/staff/*）はスタッフのロールだけ（管理者・本部のセッションでは使えない）
api.use('/staff/*', async (c, next) => {
  if (c.get('user')?.role !== 'staff') return c.json({ error: 'forbidden' }, 403)
  return next()
})
// 自分のアカウント（氏名・メール・パスワードの変更）・管理者アカウント・本部からの管理者の管理（src/accounts.ts）
api.route('/auth', authAccountApi)
api.route('/admin', adminUsersApi)
api.route('/hq', hqUsersApi)
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

// シフトに付ける開催場所（名前・住所・地図の位置）と枠（メモ・休憩）、案件の標準の休憩の項目（#188）。s = shifts、p = projects の別名を前提にする
// 休憩はシフト → 枠 → 案件の標準の順（精算の予定の休憩と同じ。shift-board.ts の workHours）
const STAFF_SHIFT_PLACE_COLUMNS = `si.site_name, si.address AS site_address, si.lat AS site_lat, si.lng AS site_lng, sl.memo AS slot_memo, sl.break_minutes AS slot_break_minutes,
  p.default_break_minutes AS project_break_minutes`
const STAFF_SHIFT_PLACE_JOINS = `LEFT JOIN sites si ON si.site_id = s.site_id AND si.company_id = s.company_id
    LEFT JOIN shift_slots sl ON sl.slot_id = s.slot_id AND sl.company_id = s.company_id`

// シフト: 本日のシフトと、前日に始まった日をまたぐシフト（同一人物の全所属企業。欠勤を除く）
async function homeLoadShifts(db: D1Database, personIds: number[], today: string): Promise<any[]> {
  const rows = (await db.prepare(`
    SELECT s.*, p.project_name, p.project_type, p.report_template_id, p.photo_required_override, co.company_name AS shift_company_name, ${STAFF_SHIFT_PLACE_COLUMNS}
    FROM shifts s JOIN projects p ON s.project_id = p.project_id JOIN companies co ON co.company_id = s.company_id
    ${STAFF_SHIFT_PLACE_JOINS}
    WHERE s.staff_id IN (${personIds.map(() => '?').join(',')}) AND s.work_date IN (?, ?) AND s.status != 'absent'
    ORDER BY s.work_date, s.start_time`).bind(...personIds, addDays(today, -1), today).all()).results as any[]
  return rows.filter(s => s.work_date === today || crossesMidnight(s))
}

// 報告漏れ: 直近 HOME_MISSED_DAYS 日の勤務（確定・代打。精算の確定前）で、有効な報告に未報告のもの（承認待ちの申請があるものは除く）（#483）。
// ホームに出しているシフト（本日・前日からの日をまたぐシフト）は除く。画面からは打刻修正の申請（打刻漏れの追加）へ進む
const HOME_MISSED_DAYS = 7
const HOME_MISSED_MAX = 20
async function homeLoadMissedReports(db: D1Database, personIds: number[], today: string, shownIds: Set<number>) {
  const rows = ((await db.prepare(`
    SELECT s.shift_id, s.staff_id, s.company_id, s.project_id, s.work_date, s.start_time, s.end_time, p.project_name, co.company_name
    FROM shifts s JOIN projects p ON s.project_id = p.project_id JOIN companies co ON co.company_id = s.company_id
    WHERE s.staff_id IN (${personIds.map(() => '?').join(',')}) AND s.work_date BETWEEN ? AND ?
      AND s.status IN (${WORKING_SHIFT_STATUSES.map(() => '?').join(',')}) AND COALESCE(s.settle_status, 'planned') != 'confirmed'
    ORDER BY s.work_date DESC, s.start_time DESC LIMIT 60`).bind(...personIds, addDays(today, -HOME_MISSED_DAYS), addDays(today, -1), ...WORKING_SHIFT_STATUSES).all()).results as any[])
    .filter(s => !shownIds.has(s.shift_id))
  const status = await homeLoadReports(db, rows)
  const out: any[] = []
  for (const s of rows) {
    const st = status.get(s.shift_id)
    if (!st) continue
    const missing = st.required_attendance.filter(t => !st.reports[t] && !st.pending_corrections[t])
    if (!missing.length) continue
    out.push({ shift_id: s.shift_id, work_date: s.work_date, start_time: s.start_time, end_time: s.end_time, project_name: s.project_name, company_name: s.company_name, missing })
  }
  return { total: out.length, shifts: out.slice(0, HOME_MISSED_MAX) }
}

// 報告: シフトごとの有効な報告（提出設定）と報告済みのもの、承認待ちの打刻修正申請（種類 → 申請の日時）
async function homeLoadReports(db: D1Database, shifts: any[]) {
  const out = new Map<number, { required_attendance: string[]; daily_report_required: boolean; reports: Record<string, any>; pending_corrections: Record<string, string> }>()
  if (!shifts.length) return out
  const ids = shifts.map(s => s.shift_id as number)
  const modes = await modesForShifts(db, ids)
  for (const id of ids) {
    const m = modes.get(id)
    out.set(id, { required_attendance: m ? m.required_attendance : [...REPORT_TYPES], daily_report_required: m ? m.daily_report_required : true, reports: {}, pending_corrections: {} })
  }
  const rows = (await db.prepare(`SELECT shift_id, report_type, reported_at, status FROM attendance_reports WHERE shift_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results as any[]
  for (const r of rows) { const o = out.get(r.shift_id); if (o) o.reports[r.report_type] = { report_type: r.report_type, reported_at: r.reported_at, status: r.status } }
  const pend = (await db.prepare(`SELECT shift_id, report_type, requested_at FROM attendance_corrections WHERE shift_id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`).bind(...ids).all()).results as any[]
  for (const r of pend) { const o = out.get(r.shift_id); if (o) o.pending_corrections[r.report_type] = r.requested_at }
  return out
}

// 日報: 提出済みのシフト。shift_id で照合する（日報はシフトごとに1件。shift_id の無い古い日報だけは稼働日・案件で照合する。src/lib/daily-report.ts）
async function homeLoadDailyReports(db: D1Database, shifts: any[]): Promise<Set<number>> {
  const done = new Set<number>()
  if (!shifts.length) return done
  const ids = shifts.map(s => s.shift_id as number)
  const staffIds = [...new Set(shifts.map(s => s.staff_id as number))]
  const dates = [...new Set(shifts.map(s => s.work_date as string))]
  const rows = (await db.prepare(`SELECT shift_id, staff_id, work_date, project_id FROM daily_reports
    WHERE shift_id IN (${ids.map(() => '?').join(',')}) OR (+shift_id IS NULL AND staff_id IN (${staffIds.map(() => '?').join(',')}) AND work_date IN (${dates.map(() => '?').join(',')}))`)
    .bind(...ids, ...staffIds, ...dates).all()).results as any[]
  for (const s of shifts) {
    if (rows.some(d => d.shift_id === s.shift_id || (d.shift_id == null && d.staff_id === s.staff_id && d.work_date === s.work_date && d.project_id === s.project_id))) done.add(s.shift_id)
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

// お知らせ（新しい順に5件）。配信対象の判定はお知らせ一覧と同じ（#370 #227 #335。LIKE での走査はしない）
async function homeLoadNotices(db: D1Database, u: any) {
  return loadStaffNotices(db, u.user_id, { order: 'recent', limit: 5 })
}

// 相談: 管理者からの返信をまだ読んでいない相談の件数（本人の全所属企業の分。#320）。
// 返信のたびに user_notifications（kind=consult_reply）を作り、相談・連絡の画面を開くと既読にする
async function homeLoadConsultations(db: D1Database, u: any): Promise<number> {
  const uids = (await consultPersonRows(db, u)).map(r => r.user_id)
  if (!uids.length) return 0
  const r = await db.prepare(`SELECT COUNT(DISTINCT related_id) AS n FROM user_notifications
    WHERE kind = '${CONSULT_REPLY_KIND}' AND read_at IS NULL AND user_id IN (${uids.map(() => '?').join(',')})`).bind(...uids).first()
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
    // 次の報告: 前の報告を飛ばしていても、後の報告は押せる（report-settings.ts の checkReportable）
    const open = reportableTypes(st.required_attendance, new Set(Object.keys(st.reports)), new Set(Object.keys(st.pending_corrections)))
    const next = open[0]
    return { ...s, ...st, carryover: s.work_date !== today, next_type: next || null, open_types: open,
      attendance_done: !next, daily_report_done: dailyDone.has(s.shift_id), tentative: isTentativeShift(s.status) }
  }).filter(s => {
    if (!s.carryover) return true
    // 前日からのシフトは、終了予定から HOME_CARRYOVER_HOURS 時間まで、残りの報告を受け付けている間か日報が未提出の間だけ出す
    const w = shiftWindow(s.work_date, s.start_time, s.end_time)
    if (now > addMinutes(w.end, HOME_CARRYOVER_HOURS * 60)) return false
    // 前の報告（起床など）を飛ばしたまま日付が変わっても、受付中の後の報告（勤務終了・退店など）があれば出す
    if (s.next_type) return s.open_types.some((t: string) =>isWithin(reportableWindow(s, t), now))
    return s.daily_report_required && !s.daily_report_done
  })
  const picked = homePickShift(items, Number(c.req.query('shift_id')) || null)
  const shift = picked ? shifts.find(s => s.shift_id === picked.shift_id) : null
  const shiftOwner = shift ? (personRows.find(r => r.staff_id === shift.staff_id) || { staff_id: u.staff_id, settings_json: u.settings_json }) : null

  const missed = await homeLoadMissedReports(db, personIds, today, new Set(items.map(s => s.shift_id as number)))

  const notices = await homeLoadNotices(db, u)
  const replied = await homeLoadConsultations(db, u)

  return c.json({
    today, shift: stripMoney(shift), carryover: !!picked?.carryover,
    reports: picked ? picked.reports : {}, daily_report_done: picked ? picked.daily_report_done : false,
    // 承認待ちの打刻修正申請がある報告（その報告はホームから押せない）と、希望（仮）のシフト（未確定。報告の前に確認を出す）
    pending_corrections: picked ? picked.pending_corrections : {}, tentative: !!picked?.tentative,
    required_attendance: picked ? picked.required_attendance : [...REPORT_TYPES],
    daily_report_required: picked ? picked.daily_report_required : true, notices,
    replied_consultations: replied,
    // 写真必須設定はシフトの所有企業の設定に従う
    photo_required_attendance: resolvePhotoRequired(shiftOwner || u, shift ? (shift.photo_required_override as number | null) : undefined),
    // 本日の全シフト（複数企業・複数案件）と、前日からの日をまたぐシフト。他社のシフトは company_name で識別
    today_shifts: items.map(s => ({ shift_id: s.shift_id, work_date: s.work_date, project_id: s.project_id, project_name: s.project_name,
      start_time: s.start_time, end_time: s.end_time, company_name: s.shift_company_name, other_company: s.company_id !== u.company_id,
      location: s.site_name || s.location || null,
      checked_out: !!s.reports.check_out, carryover: s.carryover, attendance_done: s.attendance_done, tentative: s.tentative,
      daily_report_required: s.daily_report_required, daily_report_done: s.daily_report_done })),
    // 2社以上に所属しているか（シフトにどの会社のものかを出す。#503）と、前日以前の報告漏れ（#483）
    multi_company: new Set(personRows.map(r => r.company_id)).size > 1,
    missed_reports: missed,
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
  const now = nowJST()
  const modes = (await modesForShifts(c.env.DB, [shift.shift_id])).get(shift.shift_id)
  // 欠勤・確定済みでないか・受付の時間帯か（稼働日。休憩・勤務終了・退店は翌日も）・有効か・報告済みや申請中でないか・順序（#116 #84 #122 #47）
  const state = await loadReportState(c.env.DB, shift.shift_id)
  const ng = checkStaffReport(shift, report_type, now, modes ? modes.required_attendance : [...REPORT_TYPES], state)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  if (PHOTO_REQUIRED_TYPES.includes(report_type)) {
    const proj = await c.env.DB.prepare('SELECT photo_required_override FROM projects WHERE project_id = ?').bind(shift.project_id).first()
    if (resolvePhotoRequired(owner, proj?.photo_required_override as number | null)) {
      return c.json({ error: 'この案件は写真の添付が必須です' }, 400)
    }
  }

  // 遅刻・早退の判定（入店・勤務開始は開始の絶対日時と比べ、会社設定の猶予を超えたら late。勤務終了・退店は早退の分数。#134 #219 #497）
  const at = reportedAtMinute(now)
  const judged = lateness(shift, [{ report_type, reported_at: at }], latenessSettings(owner.settings_json))[0]
  const status = reportStatus(judged, latitude)
  // 同時に届いた2回目は一意制約（shift_id, report_type）で登録されない。秒は 00 にそろえる（#95 #133）
  const ins = await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, late_minutes, early_leave_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shift_id, report_type) DO NOTHING`)
    .bind(owner.company_id, owner.staff_id, shift.shift_id, report_type, at, latitude ?? null, longitude ?? null, address ?? null, c.req.header('user-agent') || '', status,
      judged.late_minutes, judged.early_leave_minutes).run()
  if (!ins.meta.changes) return c.json({ error: 'すでに報告済みです' }, 409)
  // 勤務開始・終了（なければ入店・退店）と休憩を実績（実働時間）に反映
  if (ACTUAL_SYNC_TYPES.includes(report_type)) await syncActualFromReports(c.env.DB, owner.company_id, Number(shift.shift_id)).catch(() => {})
  return c.json({ ok: true, status, late_minutes: judged.late_minutes, early_leave_minutes: judged.early_leave_minutes })
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
  const now = nowJST()
  const modes = (await modesForShifts(c.env.DB, [shift.shift_id])).get(shift.shift_id)
  // POST /staff/attendance と同じ確認（欠勤・確定済み・受付の時間帯・有効・報告済み・申請中・順序）
  const state = await loadReportState(c.env.DB, shift.shift_id)
  const ng = checkStaffReport(shift, report_type, now, modes ? modes.required_attendance : [...REPORT_TYPES], state)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)

  const lat = latitude != null && latitude !== '' ? Number(latitude) : null
  const lng = longitude != null && longitude !== '' ? Number(longitude) : null
  // 遅刻・早退の判定（POST /staff/attendance と同じ）
  const at = reportedAtMinute(now)
  const judged = lateness(shift, [{ report_type, reported_at: at }], latenessSettings(owner.settings_json))[0]
  const status = reportStatus(judged, lat)

  const ext = photo.type === 'image/png' ? 'png' : 'jpg'
  const key = `attendance/${owner.company_id}/${owner.staff_id}/${shift_id}/${report_type}_${Date.now()}.${ext}`

  try {
    const buf = await photo.arrayBuffer()
    await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: photo.type } })
  } catch {
    return c.json({ error: '写真のアップロードに失敗しました。通信環境を確認して再度お試しください' }, 502)
  }

  try {
    // 同時に届いた2回目（2台の端末・再送）は一意制約で登録されないので、写真を消して 409 にする。秒は 00 にそろえる（#95 #133）
    const ins = await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, photo_key, late_minutes, early_leave_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shift_id, report_type) DO NOTHING`)
      .bind(owner.company_id, owner.staff_id, shift.shift_id, report_type, at, lat, lng, null, c.req.header('user-agent') || '', status, key,
        judged.late_minutes, judged.early_leave_minutes).run()
    if (!ins.meta.changes) {
      await c.env.PHOTOS.delete(key).catch(() => {})
      return c.json({ error: 'すでに報告済みです' }, 409)
    }
  } catch {
    // DB登録に失敗した場合はアップロード済みの写真を掃除する
    await c.env.PHOTOS.delete(key).catch(() => {})
    return c.json({ error: '報告の登録に失敗しました。もう一度お試しください' }, 500)
  }
  await syncActualFromReports(c.env.DB, owner.company_id, Number(shift_id)).catch(() => {})

  return c.json({ ok: true, status, photo_key: key, late_minutes: judged.late_minutes, early_leave_minutes: judged.early_leave_minutes })
})

// 写真（R2）をそのまま返す。見つからなければ 404
async function attendancePhotoResponse(c: any, key: string) {
  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.json({ error: '写真が見つかりません' }, 404)
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  })
}

// 勤怠報告に添付された写真の取得（スタッフ本人の報告の写真だけ。連携先の会社のシフトも person 単位で本人とみなす #217）
api.get('/staff/attendance-photo/*', async (c) => {
  const u = c.get('user')
  const key = c.req.path.replace('/api/staff/attendance-photo/', '')
  const row = await c.env.DB.prepare('SELECT staff_id FROM attendance_reports WHERE photo_key = ?').bind(key).first() as any
  const mine = new Set((await personStaffRows(c.env.DB, u)).map(r => Number(r.staff_id)))
  if (!row || !mine.has(Number(row.staff_id))) return c.json({ error: '写真が見つかりません' }, 404)
  return attendancePhotoResponse(c, key)
})

// 管理者: 勤怠報告の写真の取得。報告のシフトが自社のものかを確かめてから返す（写真のキーは画面に出さない #217）
api.get('/admin/attendance-photo/:attendanceId', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare(`SELECT ar.photo_key FROM attendance_reports ar JOIN shifts s ON s.shift_id = ar.shift_id
    WHERE ar.attendance_id = ? AND s.company_id = ? AND ar.photo_key IS NOT NULL`).bind(c.req.param('attendanceId'), u.company_id).first() as any
  if (!row) return c.json({ error: '写真が見つかりません' }, 404)
  return attendancePhotoResponse(c, row.photo_key)
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

// 日報の対象シフトの案件と日報テンプレート（案件はシフトの所有企業のものに限る）
async function shiftReportTemplate(db: D1Database, shift: any): Promise<{ project: any; template: any | null } | null> {
  const project = await ownProject(db, shift.company_id, shift.project_id)
  if (!project) return null
  const template = (await db.prepare('SELECT * FROM report_templates WHERE template_id = ?').bind(project.report_template_id ?? null).first()) ?? null
  return { project, template }
}

// 日報の入力画面に出すシフト（他社のシフトは会社名で区別する）。blocked は提出できない理由（欠勤・稼働日の前）
async function dailyReportShiftView(db: D1Database, u: any, shift: any, project: any) {
  const modes = (await modesForShifts(db, [shift.shift_id])).get(shift.shift_id)
  const co = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(shift.company_id).first() as any
  return {
    shift_id: shift.shift_id, work_date: shift.work_date, start_time: shift.start_time, end_time: shift.end_time,
    project_id: shift.project_id, project_name: project.project_name, company_name: co?.company_name ?? null, other_company: shift.company_id !== u.company_id,
    status: shift.status, tentative: isTentativeShift(shift.status), daily_report_required: modes ? modes.daily_report_required : true,
    blocked: dailyReportBlocked(shift, todayJST()),
  }
}

// 日報の入力画面: 対象シフトと日報テンプレート、提出済みの内容（修正して再提出するときの初期値）。
// 前日以前のシフト（未提出の日報の一覧から選んだもの）も同じ形で返す
api.get('/staff/daily-report/:shiftId', async (c) => {
  const resolved = await resolvePersonShift(c, c.req.param('shiftId'))
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const pt = await shiftReportTemplate(c.env.DB, resolved.shift)
  if (!pt) return c.json({ error: '案件が見つかりません' }, 404)
  const t = pt.template
  let fields: any = []
  try { fields = t ? JSON.parse(t.fields_json as string) : [] } catch { fields = [] }
  const report = dailyReportView(await findDailyReport(c.env.DB, resolved.shift))
  const shift = await dailyReportShiftView(c.env.DB, c.get('user'), resolved.shift, pt.project)
  return c.json({ template: t ? { ...t, fields: Array.isArray(fields) ? fields : [] } : null, report, shift })
})

// 前日以前の未提出の日報（#185）。直近 DAILY_REPORT_PENDING_DAYS 日の確定・代打のシフトで、日報が必要で未提出のもの（同一人物の全所属）。
// ホームには出さず、日報画面で選んで提出する。未提出の判定は管理者ダッシュボードの日報未提出と同じ（shift_id の無い古い日報は稼働日・案件で照合）
const DAILY_REPORT_PENDING_DAYS = 7
api.get('/staff/pending-daily-reports', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const today = todayJST()
  const rows = await personStaffRows(db, u)
  if (!rows.length) return c.json({ days: DAILY_REPORT_PENDING_DAYS, shifts: [] })
  // シフトの所有企業とスタッフ行の企業が一致するものだけ（resolvePersonShift と同じ。提出できるシフトに限る）
  const owned = rows.map(() => '(s.staff_id = ? AND s.company_id = ?)').join(' OR ')
  const list = (await db.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.project_id, s.company_id, p.project_name, co.company_name
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN companies co ON co.company_id = s.company_id
    WHERE (${owned}) AND s.status IN ('confirmed','substitute') AND s.work_date < ? AND s.work_date >= ?
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id)
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE +dr.shift_id IS NULL AND dr.staff_id = s.staff_id AND dr.work_date = s.work_date AND dr.project_id = s.project_id)
    ORDER BY s.work_date DESC, s.start_time LIMIT 50`).bind(...rows.flatMap(r => [r.staff_id, r.company_id]), today, addDays(today, -DAILY_REPORT_PENDING_DAYS)).all()).results as any[]
  const modes = await modesForShifts(db, list.map(s => s.shift_id as number))
  return c.json({
    days: DAILY_REPORT_PENDING_DAYS,
    shifts: list.filter(s => modes.get(s.shift_id)?.daily_report_required !== false).map(s => ({
      shift_id: s.shift_id, work_date: s.work_date, start_time: s.start_time, end_time: s.end_time, project_id: s.project_id,
      project_name: s.project_name, company_name: s.company_name, other_company: s.company_id !== u.company_id,
      daily_report_required: true, daily_report_done: false,
    })),
  })
})

// 日報提出（シフトごとに1件。同じシフトに再提出すると上書きし、管理者の確認済みを外す）
api.post('/staff/daily-report', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  if (!b.shift_id) return c.json({ error: '日報を入力するシフトを選んでください' }, 400)
  // 勤怠の自動振り分け: シフトの所有企業・スタッフ行に記録する（同一人物の他社シフトも可）
  const resolved = await resolvePersonShift(c, b.shift_id)
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff: owner } = resolved
  // 案件・稼働日はシフトの値を使う。本文で別の値が送られたら受け付けない
  if (b.project_id != null && b.project_id !== '' && Number(b.project_id) !== shift.project_id) return c.json({ error: '案件がシフトと一致しません' }, 400)
  if (b.work_date && b.work_date !== shift.work_date) return c.json({ error: '稼働日がシフトと一致しません' }, 400)
  const blocked = dailyReportBlocked(shift, todayJST())
  if (blocked) return c.json({ error: blocked }, 400)
  const pt = await shiftReportTemplate(c.env.DB, shift)
  if (!pt) return c.json({ error: '案件が見つかりません' }, 404)
  // テンプレートの必須項目・文字数の上限（#349 #525。報告用URLと同じ検証）
  const rulesError = reportFieldRulesError(pt.template?.fields_json, b.values)
  if (rulesError) return c.json({ error: rulesError }, 400)
  // values のキーは案件の日報テンプレートの項目に限る（キーは管理画面に表示されるため、任意の文字列を保存させない）。数値・長さも確かめる
  const picked = pickReportValues(pt.template?.fields_json, b.values)
  if ('error' in picked) return c.json({ error: picked.error }, 400)
  // インシデント・クレームの印を付けたら内容を必須にし、新しく付いた印は管理者に知らせる（#232）
  const prev = dailyReportView(await findDailyReport(c.env.DB, shift))
  const merged = mergeIncidentNotes(picked.values, b, prev, { requireNote: true })
  if ('error' in merged) return c.json({ error: merged.error }, 400)
  const r = await saveDailyReport(c.env.DB, {
    company_id: owner.company_id, staff_id: owner.staff_id, project_id: shift.project_id, shift_id: shift.shift_id, work_date: shift.work_date,
    values_json: JSON.stringify(merged.values), incident: !!b.incident_flag, complaint: !!b.complaint_flag,
    flags_explicit: b.flags_explicit === true, entry_method: 'app', now: nowJST(),
  })
  await notifyDailyReportIncident(c, shift.shift_id, merged.raised)
  return c.json({ ok: true, updated: r.updated })
})

// 日報の値（JSON）を読む。壊れていれば空にする
function parseReportValues(json: any): Record<string, unknown> {
  try { const v = JSON.parse(json || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
// 日報テンプレートの項目（key・label・type）。壊れていれば空
function parseTemplateFields(json: any): { key: string; label: string; type: string }[] {
  let f: any = []
  try { f = JSON.parse(json || '[]') } catch { f = [] }
  return Array.isArray(f) ? f.filter((x: any) => x && typeof x.key === 'string').map((x: any) => ({ key: x.key, label: String(x.label || x.key), type: String(x.type || 'text') })) : []
}
// 同一人物の全所属のスタッフ行（連携先のシフトで出した日報も本人のものとして出す。#75）
async function personStaffIds(db: D1Database, u: any): Promise<number[]> {
  const ids = (await personStaffRows(db, u)).map(r => r.staff_id)
  return ids.length ? ids : (u.staff_id ? [u.staff_id] : [])
}

// 自分の日報一覧（過去の日報。#319 #371）。同一人物の全所属の分を新しい順に。項目の表示名は案件のテンプレートから付ける
api.get('/staff/my-reports', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const ids = await personStaffIds(db, u)
  if (!ids.length) return c.json({ reports: [], templates: {} })
  const rows = (await db.prepare(`
    SELECT dr.daily_report_id, dr.shift_id, dr.work_date, dr.project_id, dr.report_values, dr.incident_flag, dr.complaint_flag,
      dr.manager_comment, dr.manager_checked, dr.submitted_at, dr.revised_after_check_at,
      p.project_name, p.report_template_id, co.company_name, (dr.company_id != ?) AS other_company, sh.start_time, sh.end_time
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id JOIN companies co ON co.company_id = dr.company_id
    LEFT JOIN shifts sh ON sh.shift_id = dr.shift_id
    WHERE dr.staff_id IN (${ids.map(() => '?').join(',')}) ORDER BY dr.work_date DESC, dr.submitted_at DESC LIMIT 30`).bind(u.company_id, ...ids).all()).results as any[]
  const tplIds = [...new Set(rows.map(r => r.report_template_id).filter((x: any) => x != null))]
  const templates: Record<string, any[]> = {}
  if (tplIds.length) {
    const ts = (await db.prepare(`SELECT template_id, fields_json FROM report_templates WHERE template_id IN (${tplIds.map(() => '?').join(',')})`).bind(...tplIds).all()).results as any[]
    for (const t of ts) templates[t.template_id] = parseTemplateFields(t.fields_json)
  }
  return c.json({
    reports: rows.map(r => {
      const { report_values, ...rest } = r
      return { ...rest, template_id: r.report_template_id, other_company: !!r.other_company, incident_flag: !!r.incident_flag, complaint_flag: !!r.complaint_flag,
        manager_checked: !!r.manager_checked, values: parseReportValues(report_values) }
    }),
    templates,
  })
})

// シフト確認
// shifts は確定・代打・欠勤と、管理者が入れた『希望（仮）』（status='requested'。本人は可否を返事できる）。
// 本人が出したシフト希望は shift_requests にあり、requests で別に返す（#411）
api.get('/staff/shifts', async (c) => {
  const u = c.get('user')
  const q = c.req.query('month') || ''
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : monthJST()
  // 同一人物の全所属企業のシフトを表示（他社分は company_name で識別）
  const personRows = await personStaffRows(c.env.DB, u)
  const ids = personRows.map(r => r.staff_id)
  if (!ids.length) ids.push(u.staff_id)
  // 開催場所の住所・地図と枠のメモ・休憩も返す（#188）
  const rows = await c.env.DB.prepare(`
    SELECT s.*, p.project_name, co.company_name, (s.company_id != ?) AS other_company, ${STAFF_SHIFT_PLACE_COLUMNS}
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN companies co ON co.company_id = s.company_id
    ${STAFF_SHIFT_PLACE_JOINS}
    WHERE s.staff_id IN (${ids.map(() => '?').join(',')}) AND s.work_date LIKE ? ORDER BY s.work_date, s.start_time`).bind(u.company_id, ...ids, month + '%').all()
  // 本人が出した希望（取り下げたものは出さない）。案件は自社の行だけ名前を付ける
  const requests = (await c.env.DB.prepare(`
    SELECT r.request_id, r.work_date, r.start_time, r.end_time, r.memo, r.status, r.response_note, r.responded_at, r.created_at, r.project_id, p.project_name
    FROM shift_requests r LEFT JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id
    WHERE r.company_id = ? AND r.staff_id = ? AND r.status != 'withdrawn' AND r.work_date LIKE ?
    ORDER BY r.work_date, r.start_time, r.request_id`).bind(u.company_id, u.staff_id, month + '%').all()).results
  return c.json({
    shifts: (rows.results as any[]).map(s => ({ ...stripMoney(s), tentative: s.status === 'requested' })),
    requests,
    request_projects: await requestableProjects(c.env.DB, u),
    month,
    // 2社以上に所属しているか（各シフトにどの会社のものかを出す。#503）
    multi_company: new Set(personRows.map(r => r.company_id)).size > 1,
  })
})

// シフト希望で選べる案件: 自社の稼働中の案件のうち、本人がシフトに入ったことのあるもの（#59 他社・無関係の案件は選べない）
async function requestableProjects(db: D1Database, u: any): Promise<{ project_id: number; project_name: string }[]> {
  if (!u.staff_id) return []
  return (await db.prepare(`
    SELECT p.project_id, p.project_name FROM projects p
    WHERE p.company_id = ? AND COALESCE(p.status, 'active') = 'active'
      AND EXISTS (SELECT 1 FROM shifts s WHERE s.project_id = p.project_id AND s.company_id = p.company_id AND s.staff_id = ? AND s.status != 'absent')
    ORDER BY p.project_name`).bind(u.company_id, u.staff_id).all()).results as any[]
}

const SHIFT_REQUEST_MAX_DAYS_AHEAD = 366

// シフト希望提出（#12 shift_requests に保存する。#59 案件は自社の選べる案件だけ）
api.post('/staff/shifts/request', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ error: 'スタッフ情報が見つかりません' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const { work_date, memo } = b
  const start_time = b.start_time || '09:30', end_time = b.end_time || '19:00'
  if (!isISODate(work_date)) return c.json({ error: '日付を選択してください' }, 400)
  const today = todayJST()
  if (work_date < today) return c.json({ error: '過去の日付には希望を出せません' }, 400)
  if (work_date > addDays(today, SHIFT_REQUEST_MAX_DAYS_AHEAD)) return c.json({ error: '1年より先の日付には希望を出せません' }, 400)
  if (!isHHMM(start_time) || !isHHMM(end_time)) return c.json({ error: '時刻は HH:MM の形式で入力してください' }, 400)
  if (start_time === end_time) return c.json({ error: '開始と終了に同じ時刻は指定できません' }, 400)
  if (memo != null && typeof memo !== 'string') return c.json({ error: '備考が正しくありません' }, 400)
  const note = String(memo || '').trim()
  if (note.length > 500) return c.json({ error: '備考は500文字以内で入力してください' }, 400)
  let projectId: number | null = null
  if (b.project_id !== undefined && b.project_id !== null && b.project_id !== '') {
    projectId = toInt(b.project_id, 1)
    if (projectId == null || !(await requestableProjects(db, u)).some(p => p.project_id === projectId)) return c.json({ error: '案件が見つかりません' }, 400)
  }
  // 同じ日時の返事待ちの希望は1件だけ（uq_shift_requests_pending）。二度押しは 409 で返す
  const r = await db.prepare(`INSERT INTO shift_requests (company_id, staff_id, user_id, project_id, work_date, start_time, end_time, memo, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`)
    .bind(u.company_id, u.staff_id, u.user_id, projectId, work_date, start_time, end_time, note || null, nowJST()).run()
  if (!r.meta.changes) return c.json({ error: '同じ日時の希望をすでに提出しています' }, 409)
  return c.json({ ok: true, request_id: r.meta.last_row_id })
})

// シフト希望の取り下げ（#353）。返事待ちのものだけ。採用・見送りの後は管理者に連絡してもらう
api.post('/staff/shift-requests/:id/cancel', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const id = toInt(c.req.param('id'), 1)
  const req = id == null ? null : await db.prepare('SELECT request_id, status FROM shift_requests WHERE request_id = ? AND company_id = ? AND staff_id = ?').bind(id, u.company_id, u.staff_id).first() as any
  if (!req) return c.json({ error: '希望が見つかりません' }, 404)
  const r = await db.prepare(`UPDATE shift_requests SET status = 'withdrawn', withdrawn_at = ? WHERE request_id = ? AND status = 'pending'`).bind(nowJST(), req.request_id).run()
  if (!r.meta.changes) return c.json({ error: req.status === 'withdrawn' ? 'すでに取り下げています' : '管理者が返事をした希望は取り下げできません。変更は管理者に連絡してください' }, 409)
  return c.json({ ok: true })
})

// 管理者が『希望（仮）』で入れたシフトへの返事（#411）。answer: ok（入れます）/ ng（入れません）
api.post('/staff/shifts/:id/reply', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  if (!oneOf(b.answer, ['ok', 'ng'] as const)) return c.json({ error: '返事を選んでください' }, 400)
  if (b.note != null && typeof b.note !== 'string') return c.json({ error: 'ひとことが正しくありません' }, 400)
  const note = String(b.note || '').trim()
  if (note.length > 200) return c.json({ error: 'ひとことは200文字以内で入力してください' }, 400)
  const id = toInt(c.req.param('id'), 1)
  const ids = (await personStaffRows(db, u)).map(r => r.staff_id)
  if (!ids.length && u.staff_id) ids.push(u.staff_id)
  const s = id == null || !ids.length ? null : await db.prepare(`SELECT shift_id, status, work_date, settle_status FROM shifts WHERE shift_id = ? AND staff_id IN (${ids.map(() => '?').join(',')})`).bind(id, ...ids).first() as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (s.status !== 'requested') return c.json({ error: 'このシフトはすでに確定・変更されています。画面を更新してください' }, 409)
  if (s.work_date < todayJST()) return c.json({ error: '過ぎた日のシフトには返事できません' }, 409)
  await db.prepare(`UPDATE shifts SET staff_reply = ?, staff_reply_note = ?, staff_reply_at = ? WHERE shift_id = ? AND status = 'requested'`)
    .bind(b.answer, note || null, nowJST(), s.shift_id).run()
  return c.json({ ok: true })
})

// お知らせ一覧。未読（既読確認が必須・緊急のものを先）→ 既読の順に、1回に50件ずつ（offset でページ送り #553）。
// 配信対象の判定は管理画面の既読数・メールの宛先と同じ（#227 #335 #370）。公開から2年たって既読の記録を削除した
// お知らせは「確認不要」（no_confirm）として既読の扱いにする（#245）
const STAFF_NOTICE_PAGE = 50
api.get('/staff/notices', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const offset = toInt(c.req.query('offset'), 0, 100000) ?? 0
  const unreadOnly = c.req.query('filter') === 'unread'
  const rows = await loadStaffNotices(db, u.user_id, { unreadOnly, limit: STAFF_NOTICE_PAGE + 1, offset })
  const res: any = { notices: rows.slice(0, STAFF_NOTICE_PAGE), has_more: rows.length > STAFF_NOTICE_PAGE, offset }
  if (offset === 0) {
    // 未読の件数と、ほかの所属企業（切り替えていない企業）の未読（#203）
    const persons = (await personStaffRows(db, u)).filter(r => r.user_id && r.company_id !== u.company_id)
    const counts = await countUnreadNotices(db, [u.user_id, ...persons.map(r => r.user_id)])
    res.unread_count = counts.get(u.user_id) || 0
    res.other_companies = persons.map(r => ({ company_id: r.company_id, company_name: r.company_name, unread: counts.get(r.user_id) || 0 }))
      .filter(r => r.unread > 0)
  }
  return c.json(res)
})

// お知らせの個別画面（#333）。今の企業に無ければ、同じ人のほかの所属企業のお知らせかを調べ、切り替え先を返す
api.get('/staff/notices/:id{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const id = Number(c.req.param('id'))
  const [n] = await loadStaffNotices(db, u.user_id, { id, limit: 1 })
  if (n) return c.json({ notice: n })
  for (const r of await personStaffRows(db, u)) {
    if (!r.user_id || r.company_id === u.company_id) continue
    const [o] = await loadStaffNotices(db, r.user_id, { id, limit: 1 })
    if (o) return c.json({ error: `${r.company_name} のお知らせです。所属企業を切り替えると表示できます`, other_company: { company_id: r.company_id, company_name: r.company_name } }, 404)
  }
  return c.json({ error: 'お知らせが見つかりません（配信の対象外か、削除された可能性があります）' }, 404)
})

// 確認しました（既読）。自社のお知らせで、本人が配信対象のものだけ既読にできる（一覧に出す条件と同じ）
api.post('/staff/notices/:id{[0-9]+}/read', async (c) => {
  const u = c.get('user')
  const [n] = await loadStaffNotices(c.env.DB, u.user_id, { id: Number(c.req.param('id')), limit: 1 })
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.no_confirm) return c.json({ ok: true, no_confirm: true })
  await c.env.DB.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?, ?)').bind(n.notice_id, u.user_id).run()
  return c.json({ ok: true })
})

// まとめて確認（#553）。画面に出ていた未読（ids）のうち、既読確認が必須・緊急でないものだけを既読にする
api.post('/staff/notices/read-all', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const ids: number[] = Array.isArray(b.ids) ? [...new Set<number>(b.ids.map((x: any) => toInt(x, 1)).filter((x: number | null) => x != null))].slice(0, 200) : []
  if (!ids.length) return c.json({ error: '確認するお知らせがありません' }, 400)
  const rows = await loadStaffNotices(db, u.user_id, { ids, unreadOnly: true, limit: ids.length })
  const ok = rows.filter(n => !n.read_required && n.importance !== 'urgent').map(n => n.notice_id)
  if (ok.length) {
    await db.prepare(`INSERT OR IGNORE INTO notice_reads (notice_id, user_id) SELECT value, ? FROM json_each(?)`).bind(u.user_id, bindJsonArray(ok)).run()
  }
  return c.json({ ok: true, read: ok, skipped: rows.length - ok.length })
})

// 自分の実績（#75 #76）。同一人物の全所属の日報を、案件ごとにテンプレートの数値項目（表示名・並び順）で集計する。
// 実績を見せない設定（show_performance）の案件は出さない。テンプレートに無い数値（項目を変える前の日報）は、キーを表示名にして後ろに足す
api.get('/staff/performance', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const q = c.req.query('month') || ''
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : monthJST()
  const ids = await personStaffIds(db, u)
  if (!ids.length) return c.json({ month, projects: [], daily: [], totals: {} })
  const rows = (await db.prepare(`
    SELECT dr.work_date, dr.report_values, dr.manager_comment, dr.project_id, p.project_name, p.show_performance, co.company_name, (dr.company_id != ?) AS other_company, t.fields_json
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id JOIN companies co ON co.company_id = dr.company_id
    LEFT JOIN report_templates t ON t.template_id = p.report_template_id
    WHERE dr.staff_id IN (${ids.map(() => '?').join(',')}) AND dr.work_date LIKE ? ORDER BY dr.work_date, dr.submitted_at`).bind(u.company_id, ...ids, month + '%').all()).results as any[]
  const totals: Record<string, number> = {}
  const projects = new Map<number, { project_id: number; project_name: string; company_name: string; other_company: boolean; fields: { key: string; label: string }[]; totals: Record<string, number>; days: number }>()
  const daily: any[] = []
  for (const r of rows) {
    if (!r.show_performance) continue
    let pj = projects.get(r.project_id)
    if (!pj) {
      const fields = parseTemplateFields(r.fields_json).filter(f => f.type === 'number').map(f => ({ key: f.key, label: f.label }))
      pj = { project_id: r.project_id, project_name: r.project_name, company_name: r.company_name, other_company: !!r.other_company, fields, totals: {}, days: 0 }
      projects.set(r.project_id, pj)
    }
    pj.days++
    const values: Record<string, number> = {}
    for (const [k, val] of Object.entries(parseReportValues(r.report_values))) {
      if (typeof val !== 'number' || !Number.isFinite(val)) continue
      values[k] = val
      pj.totals[k] = (pj.totals[k] || 0) + val
      totals[k] = (totals[k] || 0) + val
      if (!pj.fields.some(f => f.key === k)) pj.fields.push({ key: k, label: k })
    }
    daily.push({ date: r.work_date, project_id: r.project_id, project: r.project_name, company_name: r.company_name, other_company: !!r.other_company, comment: r.manager_comment, values })
  }
  return c.json({ month, projects: [...projects.values()], daily, totals })
})

// 研修・マニュアル（#74）: 本人がシフトに入っている案件（直近30日〜今後。同一人物の全所属。欠勤を除く）の、案件マニュアル・注意事項と求められる内容
api.get('/staff/manuals', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const ids = await personStaffIds(db, u)
  if (!ids.length) return c.json({ projects: [] })
  const today = todayJST()
  const rows = (await db.prepare(`
    SELECT p.project_id, p.project_name, p.manual_text, p.requirements, co.company_name, (p.company_id != ?) AS other_company,
      MIN(CASE WHEN s.work_date >= ? THEN s.work_date END) AS next_date, MAX(s.work_date) AS last_date
    FROM shifts s JOIN projects p ON p.project_id = s.project_id AND p.company_id = s.company_id JOIN companies co ON co.company_id = p.company_id
    WHERE s.staff_id IN (${ids.map(() => '?').join(',')}) AND s.work_date >= ? AND s.status != 'absent' AND COALESCE(p.status, 'active') = 'active'
    GROUP BY p.project_id
    ORDER BY next_date IS NULL, next_date, last_date DESC LIMIT 50`).bind(u.company_id, today, ...ids, addDays(today, -30)).all()).results as any[]
  return c.json({ projects: rows.map(r => ({ ...r, other_company: !!r.other_company })) })
})

// 相談・連絡
// 本人の全所属企業の分を、会社名と対象のシフト（日付・案件）付きで返す（#222 #195）。
// 管理者の返信は user_notifications（kind=consult_reply）で知らせ、未読の返信がある相談を先頭に出す（#320）
const CONSULT_BODY_MAX = 2000
const CONSULT_REPLY_KIND = 'consult_reply'
// 対象に選べるシフト: 前日〜7日後の自分のシフト（欠勤は除く）
const CONSULT_TARGET_PAST_DAYS = 1
const CONSULT_TARGET_FUTURE_DAYS = 7
// 同じ内容を続けて送ったときに二重登録とみなす秒数（#194）
const CONSULT_DUP_SECONDS = 120

async function consultPersonRows(db: D1Database, u: any) {
  const rows = await personStaffRows(db, u)
  return rows.length ? rows : (u.staff_id ? [{ staff_id: u.staff_id, company_id: u.company_id, user_id: u.user_id, company_name: u.company_name, settings_json: u.settings_json }] : [])
}

api.get('/staff/consultations', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const rows = await consultPersonRows(db, u)
  if (!rows.length) return c.json({ consultations: [], targets: [], companies: [] })
  const sids = rows.map(r => r.staff_id); const uids = rows.map(r => r.user_id)
  const list = (await db.prepare(`
    SELECT co.consultation_id, co.company_id, co.category, co.body, co.urgency, co.target_project_id, co.target_date, co.manager_reply, co.status, co.created_at,
      cm.company_name, p.project_name AS target_project_name,
      EXISTS (SELECT 1 FROM user_notifications n WHERE n.kind = '${CONSULT_REPLY_KIND}' AND n.related_id = co.consultation_id AND n.read_at IS NULL
        AND n.user_id IN (${uids.map(() => '?').join(',')})) AS reply_unread
    FROM consultations co JOIN companies cm ON cm.company_id = co.company_id
    LEFT JOIN projects p ON p.project_id = co.target_project_id AND p.company_id = co.company_id
    WHERE co.staff_id IN (${sids.map(() => '?').join(',')})
    ORDER BY reply_unread DESC, co.created_at DESC, co.consultation_id DESC LIMIT 30`).bind(...uids, ...sids).all()).results
  const today = todayJST()
  const targets = (await db.prepare(`
    SELECT s.shift_id, s.company_id, s.work_date, s.start_time, s.end_time, s.status, p.project_name, cm.company_name
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN companies cm ON cm.company_id = s.company_id
    WHERE s.staff_id IN (${sids.map(() => '?').join(',')}) AND s.work_date BETWEEN ? AND ? AND s.status != 'absent'
    ORDER BY s.work_date, s.start_time LIMIT 50`).bind(...sids, addDays(today, -CONSULT_TARGET_PAST_DAYS), addDays(today, CONSULT_TARGET_FUTURE_DAYS)).all()).results
  return c.json({ consultations: list, targets, today, current_company_id: u.company_id,
    companies: rows.map(r => ({ company_id: r.company_id, company_name: r.company_name, current: r.company_id === u.company_id })) })
})

// 管理者の返信を読んだ（相談・連絡の画面を開いた）。本人の全所属企業の分を既読にする（#320）
api.post('/staff/consultations/read-replies', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const uids = (await consultPersonRows(db, u)).map(r => r.user_id)
  if (!uids.length) return c.json({ ok: true, updated: 0 })
  const r = await db.prepare(`UPDATE user_notifications SET read_at = ? WHERE kind = '${CONSULT_REPLY_KIND}' AND read_at IS NULL AND user_id IN (${uids.map(() => '?').join(',')})`)
    .bind(nowJST(), ...uids).run()
  return c.json({ ok: true, updated: r.meta.changes || 0 })
})

// 送り先の会社: 対象のシフトを選んだらそのシフトの会社、なければ選んだ会社（本人の所属に限る）、なければ今の会社（#222）
api.post('/staff/consultations', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const { category, urgency } = b
  const body = typeof b.body === 'string' ? b.body.trim() : ''
  if (!category || !body) return c.json({ error: 'カテゴリと内容は必須です' }, 400)
  if (!oneOf(category, CONSULT_CATEGORIES)) return c.json({ error: 'カテゴリが正しくありません' }, 400)
  if (urgency && !oneOf(urgency, CONSULT_URGENCIES)) return c.json({ error: '緊急度が正しくありません' }, 400)
  if (body.length > CONSULT_BODY_MAX) return c.json({ error: `内容は${CONSULT_BODY_MAX}文字以内で入力してください` }, 400)
  const rows = await consultPersonRows(db, u)
  let owner: { staff_id: number; company_id: number } | undefined
  let targetProjectId: number | null = null, targetDate: string | null = null
  if (b.shift_id != null && b.shift_id !== '') {
    // 対象のシフト（本人のシフトに限る）。会社・案件・日付はシフトから決める
    const resolved = toInt(b.shift_id, 1) == null ? null : await resolvePersonShift(c, toInt(b.shift_id, 1))
    if (!resolved) return c.json({ error: '対象のシフトが見つかりません' }, 404)
    owner = { staff_id: resolved.staff.staff_id, company_id: resolved.staff.company_id }
    targetProjectId = resolved.shift.project_id; targetDate = resolved.shift.work_date
  } else {
    const cid = b.company_id != null && b.company_id !== '' ? toInt(b.company_id, 1) : u.company_id
    owner = rows.find(r => r.company_id === cid)
    if (!owner) return c.json({ error: '送り先の会社が見つかりません' }, 404)
    if (b.target_date != null && b.target_date !== '') {
      if (!isISODate(b.target_date)) return c.json({ error: '対象の日付が正しくありません' }, 400)
      targetDate = b.target_date
    }
    if (b.target_project_id != null && b.target_project_id !== '') {
      // 案件だけを指定する場合も、本人のシフトがある案件に限る
      const pid = toInt(b.target_project_id, 1)
      const hit = pid == null ? null : await db.prepare(`SELECT 1 FROM shifts WHERE staff_id = ? AND company_id = ? AND project_id = ?${targetDate ? ' AND work_date = ?' : ''} LIMIT 1`)
        .bind(owner.staff_id, owner.company_id, pid, ...(targetDate ? [targetDate] : [])).first()
      if (!hit) return c.json({ error: '対象の案件が見つかりません' }, 404)
      targetProjectId = pid
    }
  }
  // 二度押し・再送で同じ相談が続けて登録されないようにする（#194）
  const since = new Date(Date.now() + 9 * 3600 * 1000 - CONSULT_DUP_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const dup = await db.prepare(`SELECT consultation_id FROM consultations WHERE staff_id = ? AND category = ? AND body = ? AND created_at >= ? LIMIT 1`)
    .bind(owner.staff_id, category, body, since).first()
  if (dup) return c.json({ error: '同じ内容の相談をすでに送信しています。相談履歴を確認してください', duplicate: true }, 409)
  const r = await db.prepare(`INSERT INTO consultations (company_id, staff_id, category, body, urgency, target_project_id, target_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(owner.company_id, owner.staff_id, category, body, urgency || 'normal', targetProjectId, targetDate, nowJST()).run()
  const co = rows.find(x => x.company_id === owner!.company_id)
  return c.json({ ok: true, consultation_id: r.meta.last_row_id, company_name: co ? co.company_name : null })
})

// =========================================================
// 管理者側 API
// =========================================================

// ダッシュボードの未報告の目安: 予定の開始から何分後に未報告とみなすか（負の値は開始前。起床は2時間前、出発は1時間前、入店は開始時刻）
const DASH_DUE_OFFSET: Record<string, number> = { wake_up: -120, departure: -60, check_in: 0 }
// 勤務終了・退店は、予定の終了からこの分数を過ぎたら未報告とみなす
const DASH_END_GRACE_MIN = 30
const DASH_END_TYPES = ['work_end', 'check_out']
// 入店以降の報告（あれば勤務したとみなし、ダッシュボードから欠勤にしない）
const DASH_STARTED_TYPES = ['check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
// 'YYYY-MM-DD HH:MM:SS' どうしの差（分）
function minutesBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.replace(' ', 'T') + 'Z') - Date.parse(from.replace(' ', 'T') + 'Z')) / 60000)
}

// 管理者ダッシュボード
api.get('/admin/dashboard', async (c) => {
  const u = c.get('user'); const today = todayJST(); const month = monthJST()
  const db = c.env.DB; const cid = u.company_id

  // 本日と前日のシフト + 勤怠状況（前日分は、日をまたぐ勤務の継続と勤務終了・退店の未報告に使う）
  const now = nowJST(); const yesterday = addDays(today, -1)
  const elig = assignableStaffSql({ sp: 'sp', us: 'us', onDate: today })
  const shifts = await db.prepare(`
    SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.unit_price, s.location, s.slot_role_id, s.settle_status,
           p.project_id, p.project_name, us.name AS staff_name,
           CASE WHEN ${elig.sql} THEN 0 ELSE 1 END AS staff_unavailable,
           (SELECT GROUP_CONCAT(a.report_type) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS done_types,
           (SELECT GROUP_CONCAT(ac.report_type) FROM attendance_corrections ac WHERE ac.shift_id = s.shift_id AND ac.status = 'pending') AS pending_types
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id
    JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date IN (?, ?) AND s.status IN ('confirmed','substitute','absent')
    ORDER BY s.work_date, s.start_time, s.shift_id`).bind(...elig.binds, cid, yesterday, today).all()

  const rows = shifts.results as any[]
  // 提出設定で「不要」の報告は未報告アラートの対象外（第2段階）
  const todayModes = await modesForShifts(db, rows.filter(s => s.status !== 'absent').map(s => s.shift_id))
  // 画面の報告状況の列: シフトごとの有効な報告と報告済みの種類
  for (const s of rows) {
    s.required_types = todayModes.get(s.shift_id)?.required_attendance ?? [...REPORT_TYPES]
    s.done_types = String(s.done_types || '').split(',').filter(Boolean)
    s.pending_types = String(s.pending_types || '').split(',').filter(Boolean)
    s.window = shiftWindow(s.work_date, s.start_time, s.end_time)
    s.carried_over = s.work_date !== today
    // 入店以降の報告がある（勤務した）シフトは、ダッシュボードから欠勤にしない（#221）
    s.started = s.done_types.some((t: string) => DASH_STARTED_TYPES.includes(t))
  }
  const working = rows.filter(s => s.status !== 'absent')
  // 未報告の種類（有効で、報告も承認待ちの修正申請もないもの）
  const missingOf = (s: any, types: string[]) => types.filter(t => s.required_types.includes(t) && !s.done_types.includes(t) && !s.pending_types.includes(t))
  // 前日に始まった日をまたぐ勤務は、勤務中か、勤務終了・退店が未報告の間は「前日から継続」として本日の一覧に出す（#107）
  const active = working.filter(s => !s.carried_over || (crossesMidnight(s) && (now < s.window.end || missingOf(s, DASH_END_TYPES).length > 0)))
  const todayOnly = active.filter(s => !s.carried_over)
  const revenue = todayOnly.reduce((a, s) => a + (s.unit_price || 0), 0)
  // 未報告: 予定の時刻を過ぎたものだけ（起床・出発・入店は開始から、勤務終了・退店は終了から。#186）
  const unreportedItem = (s: any, dueAt: string, extra: any = {}) => ({
    shift_id: s.shift_id, staff_id: s.staff_id, name: s.staff_name, project: s.project_name, work_date: s.work_date,
    start_time: s.start_time, end_time: s.end_time, carried_over: s.carried_over, due_at: dueAt, overdue_minutes: minutesBetween(dueAt, now), ...extra,
  })
  const startDue = (s: any, t: string) => {
    const due = addMinutes(s.window.start, DASH_DUE_OFFSET[t])
    const dayStart = `${s.work_date} 00:00:00` // 報告は稼働日の 0:00 から受け付ける（shift-time.ts reportableWindow）
    return due < dayStart ? dayStart : due
  }
  // 前日から継続している勤務（23時台に始まる夜勤など）も対象にする
  const startList = (t: string) => active
    .filter(s => missingOf(s, [t]).length && startDue(s, t) <= now)
    .map(s => unreportedItem(s, startDue(s, t)))
    .sort((a, b) => b.overdue_minutes - a.overdue_minutes)
  // 勤務終了・退店: 本日と前日のシフト（日をまたがない前日分の退店漏れも含む）
  const endList = working
    .filter(s => missingOf(s, DASH_END_TYPES).length && addMinutes(s.window.end, DASH_END_GRACE_MIN) <= now)
    .map(s => unreportedItem(s, s.window.end, { missing: missingOf(s, DASH_END_TYPES) }))
    .sort((a, b) => b.overdue_minutes - a.overdue_minutes)
  // 本日の欠勤（代わりの手配に使う。#216）
  const absentToday = rows.filter(s => s.status === 'absent' && s.work_date === today)
  const unreported = { wake_up: startList('wake_up'), departure: startList('departure'), check_in: startList('check_in'), work_end: endList }
  for (const s of rows) delete s.window

  // 昨日までの日報未提出 (直近3日)。代打も含め、シフトごとに判定する（shift_id の無い古い日報だけは稼働日・案件で照合）
  const missingReports = await db.prepare(`
    SELECT s.shift_id, s.work_date, us.name AS staff_name, s.staff_id, p.project_name
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status IN ('confirmed','substitute') AND s.work_date < ? AND s.work_date >= date(?, '-3 days')
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id)
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE +dr.shift_id IS NULL AND dr.staff_id = s.staff_id AND dr.work_date = s.work_date AND dr.project_id = s.project_id)
    ORDER BY s.work_date DESC, s.start_time`).bind(cid, today, today).all()
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
  // ルール1: 日報未提出。件数はシフトの数、「n日連続」は稼働日の数で数える（直近3日のすべての日に未提出があれば連続）
  const drCounts: Record<string, { name: string; count: number; dates: Set<string>; staff_id: number }> = {}
  for (const m of missingReports.results as any[]) {
    const k = String(m.staff_id)
    drCounts[k] = drCounts[k] || { name: m.staff_name, count: 0, dates: new Set(), staff_id: m.staff_id }
    drCounts[k].count++
    drCounts[k].dates.add(m.work_date)
  }
  for (const v of Object.values(drCounts)) {
    const days = v.dates.size
    if (days >= 3) todos.push({ level: 'high', text: `${v.name}さんが${days}日連続で日報未提出です（${v.count}件）。面談してください。`, staff_id: v.staff_id })
    else if (v.count >= 1) todos.push({ level: 'mid', text: `${v.name}さんの日報が${v.count}件（${days}日分）未提出です。リマインドしてください。`, staff_id: v.staff_id })
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
    WHERE s.company_id = ? AND s.status = 'absent' AND s.work_date LIKE ? AND s.work_date <= ? GROUP BY s.staff_id HAVING n >= 2`).bind(cid, month + '%', today).all()
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
  // ルール6: 承認待ちの打刻修正（#226）。最も古い申請から2日以上たっていれば high
  const pendCorr = await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM attendance_corrections WHERE company_id = ? AND status = 'pending'`).bind(cid).first() as any
  if (pendCorr?.n > 0) {
    const days = pendCorr.oldest ? Math.max(0, Math.floor(minutesBetween(String(pendCorr.oldest), now) / 1440)) : 0
    todos.push({ level: days >= 2 ? 'high' : 'mid', text: `打刻修正の承認待ちが${pendCorr.n}件あります（最も古いものは${days ? days + '日前' : '24時間以内'}の申請）。確認してください。`, href: '#corrections' })
  }

  return c.json({
    today, month, now,
    working_count: todayOnly.length,
    revenue_forecast: revenue,
    shifts: active,
    absent_shifts: absentToday,
    unreported,
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

// 遅刻の猶予（分）。入店・勤務開始が開始時刻から何分以内なら遅刻にしないか（report-settings.ts の lateness。#497）
api.get('/admin/settings/lateness', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  return c.json({ ...latenessSettings(row?.settings_json), max_grace_minutes: MAX_LATE_GRACE_MINUTES })
})
api.put('/admin/settings/lateness', async (c) => {
  const u = c.get('user')
  const body = await c.req.json().catch(() => ({} as any))
  const g = body.grace_minutes
  if (!Number.isInteger(g) || g < 0 || g > MAX_LATE_GRACE_MINUTES) return c.json({ error: `遅刻の猶予は 0〜${MAX_LATE_GRACE_MINUTES} 分の整数で入力してください` }, 400)
  // ほかの設定（写真必須など）を上書きしないよう、この項目だけを書き換える。これから記録する報告に効く（記録済みの報告は判定し直さない）
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.late_grace_minutes', ?) WHERE company_id = ?`)
    .bind(g, u.company_id).run()
  return c.json({ ok: true, grace_minutes: g })
})

function catLabel(cat: string): string {
  const m: Record<string, string> = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
  return m[cat] || cat
}

// スタッフ一覧
api.get('/admin/staff', async (c) => {
  const u = c.get('user'); const month = monthJST(); const today = todayJST()
  await ensureRosterIdentity(c.env.DB, u.company_id) // person_id 未採番の行を補完（seed後投入・他経路INSERT対策）
  // assignable: 今日の時点でシフトに割り当てられるか（退職・統合・取引終了・所属元で退職などを除く。シフト登録・シフトボードの選択肢に使う）
  const elig = assignableStaffSql({ sp: 'sp', us: 'us' })
  const rows = await c.env.DB.prepare(`
    SELECT sp.staff_id, sp.evaluation_score, sp.retention_risk, sp.follow_flag,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.skills ELSE sp.skills END AS skills,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.work_area ELSE sp.work_area END AS work_area,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana,
           COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type, sp.affiliation, sp.employment_status, sp.is_provisional, sp.merged_into_staff_id, sp.board_proposal_id, us.phone,
           oc.company_name AS owner_company_name,
           -- 恒久IDを採番した企業以外の行（他社連携・他社連携から切り替えた行）は自社専用のコードのみ（#63 頭超え防止）
           CASE WHEN sp.affiliation_type = 'linked_external' OR pe.created_company_id != sp.company_id THEN sp.relink_code ELSE pe.global_staff_code END AS global_staff_code,
           us.user_id, us.user_code, us.name, us.status, us.role AS user_role, sp.link_ended_at,
           CASE WHEN ${elig.sql} THEN 1 ELSE 0 END AS assignable,
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_days,
           (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date <= ? AND s.status IN ('confirmed','substitute')) AS last_work_date,
           (SELECT MAX(dr.work_date) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id) AS last_report_date,
           -- 本日未入店の絞り込みに使う: 欠勤・希望（仮）のシフトは数えない（#85）
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date = ? AND s.status IN ('confirmed','substitute')) AS today_shift,
           (SELECT COUNT(*) FROM attendance_reports a JOIN shifts s2 ON a.shift_id = s2.shift_id WHERE a.staff_id = sp.staff_id AND s2.work_date = ? AND s2.status IN ('confirmed','substitute') AND a.report_type IN ('check_in','work_start')) AS today_checkin,
           (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id AND dr.work_date LIKE ?) AS month_seiyaku,
           (SELECT GROUP_CONCAT(DISTINCT p.project_name) FROM shifts s3 JOIN projects p ON s3.project_id = p.project_id WHERE s3.staff_id = sp.staff_id AND s3.work_date LIKE ?) AS projects
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ? ORDER BY sp.staff_id`).bind(...elig.binds, month + '%', today, today, today, month + '%', month + '%', u.company_id).all()
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
  // ログイン用メール（users.email）と、確認待ちのメール（#207）。他社連携の行の LK- コードは自社のログインではない（#569）
  profile.has_own_login = hasOwnLoginRow(profile)
  profile.login_email_pending = profile.has_own_login ? await db.prepare(`SELECT email, expires_at, created_at FROM login_email_verifications
    WHERE user_id = ? AND company_id = ? AND verified_at IS NULL AND canceled_at IS NULL AND expires_at > ? ORDER BY verification_id DESC LIMIT 1`)
    .bind(profile.user_id, u.company_id, new Date().toISOString()).first() : null
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

  // シフトは今日以降（日付の早い順 20件）と過去（新しい順 30件）を分けて取る。先の予定が多くても過去の稼働が出るように（#224）
  const today = todayJST()
  const shiftCols = `s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.role, s.location, s.project_id, s.slot_id, s.settle_status, p.project_name, si.site_name, cl.client_name`
  const shiftFrom = `FROM shifts s JOIN projects p ON s.project_id = p.project_id AND p.company_id = s.company_id LEFT JOIN sites si ON si.site_id = s.site_id
    LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id WHERE s.staff_id = ? AND s.company_id = ?`
  const [upcoming, past, ngClients] = await Promise.all([
    db.prepare(`SELECT ${shiftCols} ${shiftFrom} AND s.work_date >= ? ORDER BY s.work_date, s.start_time LIMIT 20`).bind(sid, u.company_id, today).all(),
    db.prepare(`SELECT ${shiftCols} ${shiftFrom} AND s.work_date < ? ORDER BY s.work_date DESC, s.start_time DESC LIMIT 30`).bind(sid, u.company_id, today).all(),
    db.prepare(`SELECT cl.client_id, cl.client_name, n.reason, n.created_at FROM clients cl LEFT JOIN client_ng_staff n ON n.client_id = cl.client_id AND n.staff_id = ? AND n.company_id = cl.company_id
      WHERE cl.company_id = ? AND (',' || REPLACE(COALESCE(cl.ng_staff_ids,''), ' ', '') || ',') LIKE ? ORDER BY cl.client_name`).bind(Number(sid), u.company_id, `%,${Number(sid)},%`).all(),
  ])
  const [attendance, reports, evals, follows] = await Promise.all([
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
    shifts: [...(upcoming.results as any[])].reverse().concat(past.results as any[]),
    upcoming_shifts: upcoming.results, past_shifts: past.results, today,
    ng_clients: ngClients.results,
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
  // 生年月日・通勤可能時間・稼働開始可能日の形式（作成時と同じ確認）
  const valueErr = normalizeRosterValues(body)
  if (valueErr) return valueErr
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
    const partner = `(SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?)`
    // 今日以降の未確定の予定シフトの支払先も新しい取引先にそろえる（#28。精算はシフトの payee_affiliation_id で支払先を決めるため）
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE staff_profiles SET partner_affiliation_id = ${partner} WHERE staff_id = ? AND company_id = ?`).bind(u.company_id, affiliation, sid, u.company_id),
      c.env.DB.prepare(`UPDATE shifts SET payee_affiliation_id = ${partner}
        WHERE staff_id = ? AND company_id = ? AND work_date >= ? AND payee_type = 'partner' AND status != 'absent' AND COALESCE(settle_status,'planned') != 'confirmed'
          AND payee_affiliation_id IS NOT ${partner}`).bind(u.company_id, affiliation, sid, u.company_id, todayJST(), u.company_id, affiliation),
    ])
  }

  if (retired_at !== undefined || employment_status !== undefined) await applyRetirement(c.env.DB, sid, u.company_id, roster, retired_at, employment_status)
}

// ============ 電話番号・ログイン用メール（#123 #207） ============
// 自社で発行したログインか（他社連携の行は、連携時に照合できないパスワードで作った LK- の行）
function hasOwnLoginRow(r: any): boolean {
  return r.user_role === 'staff' && !String(r.user_code || '').startsWith('LK-')
}
const LOGIN_EMAIL_VERIFY_HOURS = 72
type ContactCheck = { status: 400 | 403 | 409; body: any } | null
/**
 * phone・login_email の入力を確かめて正規化する（PUT /admin/staff/:id）。
 * 電話番号: 基本項目と同じ権限（自社雇用は従業員管理の電話番号から、他社連携は所属元のみ）。照合用に数字だけで保存し、
 *   ほかのスタッフと同じ番号なら phone_confirmed が無い限り 409 で確認を求める。
 * ログイン用メール: 自社で発行したログインのあるスタッフだけ。同じ会社の別の人が使っているアドレスは受け付けない。
 */
async function checkContactUpdate(c: any, sid: string, body: any, roster: any): Promise<ContactCheck> {
  const u = c.get('user'); const db = c.env.DB
  if (body.phone !== undefined) {
    if (roster.affiliation_type === 'own_employee') return { status: 403, body: { error: '自社雇用スタッフの電話番号は従業員管理（電話番号）から編集してください' } }
    if (!STAFF_MASTER_EDITABLE_TYPES.includes(roster.affiliation_type) || !roster.can_edit_base) return { status: 403, body: { error: '電話番号は所属元企業のみ編集できます' } }
    const raw = String(body.phone ?? '').trim()
    const digits = normalizePhone(raw)
    if (raw && (digits.length < 10 || digits.length > 11)) return { status: 400, body: { error: '電話番号は10〜11桁の数字で入力してください' } }
    if (!raw) {
      const missing = missingRequired(await getRequiredFields(db, u.company_id), { phone: null }, 'update', roster.affiliation_type, roster.user_role === 'staff')
      if (missing.length) return { status: 400, body: { error: `次の項目は必須です: ${missing.join('・')}` } }
    }
    body.phone = digits || null
    if (digits && digits !== normalizePhone(roster.phone) && body.phone_confirmed !== true) {
      const matches = (await findStaffByPhone(db, u.company_id, digits)).filter(m => String(m.staff_id) !== String(sid))
      if (matches.length) return { status: 409, body: { error: 'この電話番号のスタッフが登録済みです', phone_matches: matches, need_confirm: true } }
    }
  }
  if (body.login_email !== undefined) {
    if (roster.affiliation_type === 'linked_external') return { status: 403, body: { error: '他社から連携したスタッフのメールアドレスは、所属元の会社で設定します' } }
    if (!hasOwnLoginRow(roster)) return { status: 400, body: { error: 'ログインのないスタッフです。ログイン用のメールアドレスは、ログインを発行してから設定してください' } }
    const email = cleanEmail(body.login_email)
    if (email === undefined) return { status: 400, body: { error: 'メールアドレスの形式が正しくありません' } }
    if (email && normalizeEmail(email) !== normalizeEmail(roster.email)) {
      const dup = await db.prepare(`SELECT 1 FROM users WHERE company_id = ? AND user_id != ? AND status = 'active' AND role != 'roster_only'
        AND LOWER(TRIM(email)) = ? AND (person_id IS NULL OR person_id IS NOT ?) LIMIT 1`).bind(u.company_id, roster.user_id, normalizeEmail(email), roster.person_id ?? null).first()
      if (dup) return { status: 409, body: { error: 'このメールアドレスは、自社の別のスタッフ・管理者のログインで使われています' } }
    }
    body.login_email = email
  }
  return null
}
/**
 * 電話番号とログイン用メールを保存する（checkContactUpdate の後に呼ぶ）。
 * ログイン用メールは、空欄ならすぐに消す。新しいアドレスはすぐには使わず、確認用のリンクを送り、本人が確認したときに有効にする（/auth/verify-email）
 */
async function applyContactUpdate(c: any, body: any, roster: any): Promise<{ login_email?: { pending: string | null; cleared?: boolean; mail_sent?: boolean; mail_skipped?: boolean } }> {
  const u = c.get('user'); const db = c.env.DB
  const out: any = {}
  if (body.phone !== undefined) await db.prepare('UPDATE users SET phone = ? WHERE user_id = ? AND company_id = ?').bind(body.phone, roster.user_id, u.company_id).run()
  if (body.login_email === undefined) return out
  const now = nowJST()
  const cancelPending = db.prepare('UPDATE login_email_verifications SET canceled_at = ? WHERE user_id = ? AND verified_at IS NULL AND canceled_at IS NULL').bind(now, roster.user_id)
  const email: string | null = body.login_email
  if (!email) {
    await db.batch([
      cancelPending,
      db.prepare('UPDATE users SET email = NULL WHERE user_id = ? AND company_id = ?').bind(roster.user_id, u.company_id),
      db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now, roster.user_id),
    ])
    out.login_email = { pending: null, cleared: true }
    return out
  }
  if (normalizeEmail(email) === normalizeEmail(roster.email)) {
    await cancelPending.run()
    out.login_email = { pending: null }
    return out
  }
  const raw = genToken()
  const expires = new Date(Date.now() + LOGIN_EMAIL_VERIFY_HOURS * 3600 * 1000).toISOString()
  await db.batch([
    // 確認・取消の済んだ行と、期限を30日過ぎた行は消す（メールアドレスを残し続けない）
    db.prepare('DELETE FROM login_email_verifications WHERE user_id = ? AND (verified_at IS NOT NULL OR canceled_at IS NOT NULL OR expires_at < ?)')
      .bind(roster.user_id, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()),
    cancelPending,
    db.prepare(`INSERT INTO login_email_verifications (user_id, company_id, email, token_hash, expires_at, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(roster.user_id, u.company_id, email, await hashToken(raw), expires, u.user_id, now),
  ])
  const co = await db.prepare('SELECT company_name, company_code FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const tpl = loginEmailVerifyEmail({ name: roster.name, companyName: co?.company_name || '', companyCode: co?.company_code || '', userCode: roster.user_code,
    verifyUrl: `${c.env.APP_BASE_URL}/verify-email?token=${raw}`, expiresInHours: LOGIN_EMAIL_VERIFY_HOURS })
  const sent = await sendEmail(c.env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'login_email_verify', company_id: u.company_id })
  out.login_email = { pending: email, mail_sent: !!sent.ok, mail_skipped: !!sent.skipped }
  return out
}
// 従業員管理で電話番号（phone_main）を変えたら、照合（仮登録・応募の重複確認、統合候補）に使う users.phone にもそろえる（#123）
async function syncUserPhoneFromEmployee(db: D1Database, sid: string, companyId: number, phoneMain: unknown) {
  const raw = String(phoneMain ?? '').trim()
  const digits = normalizePhone(raw)
  await db.prepare('UPDATE users SET phone = ? WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?)')
    .bind(digits.length >= 10 && digits.length <= 11 ? digits : (raw || null), sid, companyId).run()
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
    // 他社に連携した先（連携行）にも退職日を伝える（#127）
    ...(changed ? propagateRetirementStmts(db, sid, roster.retired_at || null, newRetired, userStatus === 'suspended') : []),
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
  const contactErr = await checkContactUpdate(c, sid, body, roster)
  if (contactErr) return c.json(contactErr.body, contactErr.status)
  await applyProfileUpdate(c, sid, body, roster)
  const contact = await applyContactUpdate(c, body, roster)
  return c.json({ ok: true, ...contact })
})

// スタッフ登録
api.post('/admin/staff', async (c) => {
  const u = c.get('user')
  const { user_code: rawCode, name, password, email, phone, skills, career, work_area } = await c.req.json()
  const user_code = normalizeLoginCode(rawCode) // ログイン画面と同じく全角を半角にそろえて保存する（#387）
  if (!user_code || !name || !password) return c.json({ error: 'スタッフ番号・氏名・パスワードは必須です' }, 400)
  const pwErr = validatePassword(password)
  if (pwErr) return c.json({ error: pwErr }, 400)
  const hash = await hashPassword(password)
  try {
    // 初期パスワードは管理者が決めたものなので、初回ログインで本人に変更を求める（#43）
    const r = await c.env.DB.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone, must_change_password) VALUES (?, ?, ?, 'staff', ?, ?, ?, 1)`)
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
  const b = await c.req.json().catch(() => ({} as any))
  const name = String(b.client_name ?? '').trim()
  if (!name) return c.json({ error: 'クライアント名は必須です' }, 400)
  let rating = 3
  if (b.client_rating !== undefined && b.client_rating !== null && String(b.client_rating).trim() !== '') {
    const r = toInt(b.client_rating, 1, 5)
    if (r === null) return c.json({ error: '評価は1〜5で入力してください' }, 400)
    rating = r
  }
  // 二度押し・入力ミスで同じクライアントが2件できないよう、同名があれば確認を求める（確認済みなら登録する）
  if (b.allow_duplicate !== true && await c.env.DB.prepare('SELECT 1 FROM clients WHERE company_id = ? AND client_name = ? LIMIT 1').bind(u.company_id, name).first())
    return c.json({ error: `同じ名前のクライアント「${name}」が既に登録されています`, confirm_duplicate: true }, 409)
  const r = await c.env.DB.prepare(`INSERT INTO clients (company_id, client_name, stream_type, contact_name, email, phone, address, contract_type, billing_rule, memo, client_rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, name, b.stream_type || 'upstream', b.contact_name ?? null, b.email ?? null, b.phone ?? null, b.address ?? null, b.contract_type ?? null, b.billing_rule ?? null, b.memo ?? null, rating).run()
  return c.json({ ok: true, client_id: r.meta.last_row_id })
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
  // 評価は1〜5の整数（範囲外の値が入ると一覧の星の描画が止まる）。空なら変更しない
  if (b.client_rating !== undefined && b.client_rating !== null && String(b.client_rating).trim() !== '') {
    const r = toInt(b.client_rating, 1, 5)
    if (r === null) return c.json({ error: '評価は1〜5で入力してください' }, 400)
    b.client_rating = r
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

// ============ クライアントのNGスタッフ（#204） ============
// NG の判定（シフトボードの候補・割当の警告・応募の承認）は従来どおり clients.ng_staff_ids を見る。
// 理由・登録日・登録者は client_ng_staff に持つ（migrations/0051）
const NG_STAFF_MAX = 500
async function clientNgStaffList(db: D1Database, companyId: number, client: any) {
  const ids = String(client.ng_staff_ids || '').split(',').map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0)
  if (!ids.length) return []
  const rows = (await db.prepare(`SELECT sp.staff_id, us.name, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, COALESCE(sp.employment_status,'working') AS employment_status,
      n.reason, n.created_at, cb.name AS created_by_name
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN client_ng_staff n ON n.client_id = ? AND n.company_id = sp.company_id AND n.staff_id = sp.staff_id
    LEFT JOIN users cb ON cb.user_id = n.created_by
    WHERE sp.company_id = ? AND sp.staff_id IN (SELECT value FROM json_each(?))`).bind(client.client_id, companyId, JSON.stringify(ids)).all()).results as any[]
  const byId = new Map(rows.map(r => [r.staff_id, r]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}
api.get('/admin/clients/:id/ng-staff', async (c) => {
  const u = c.get('user')
  const client = await c.env.DB.prepare('SELECT client_id, ng_staff_ids FROM clients WHERE client_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!client) return c.json({ error: 'クライアントが見つかりません' }, 404)
  return c.json({ staff: await clientNgStaffList(c.env.DB, u.company_id, client) })
})
// NGスタッフの一覧を置き換える。body: { staff: [{ staff_id, reason }] }（staff_ids: [id] でも可）。自社の（統合済みでない）スタッフだけを受け付ける
api.put('/admin/clients/:id/ng-staff', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const client = await db.prepare('SELECT client_id, ng_staff_ids FROM clients WHERE client_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!client) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const src: any[] | null = Array.isArray(b.staff) ? b.staff : Array.isArray(b.staff_ids) ? b.staff_ids.map((id: any) => ({ staff_id: id })) : null
  if (!src) return c.json({ error: 'NGスタッフを指定してください' }, 400)
  const items: { staff_id: number; reason: string | null }[] = []
  for (const x of src) {
    const id = Number(x?.staff_id)
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'スタッフの指定が正しくありません' }, 400)
    if (x.reason != null && typeof x.reason !== 'string') return c.json({ error: '理由が正しくありません' }, 400)
    const reason = String(x.reason || '').trim()
    if (reason.length > 500) return c.json({ error: '理由は500文字以内で入力してください' }, 400)
    if (!items.some(i => i.staff_id === id)) items.push({ staff_id: id, reason: reason || null })
  }
  if (items.length > NG_STAFF_MAX) return c.json({ error: `NGスタッフは${NG_STAFF_MAX}人までです` }, 400)
  const ids = JSON.stringify(items.map(i => i.staff_id))
  if (items.length) {
    const own = await db.prepare('SELECT COUNT(*) AS n FROM staff_profiles WHERE company_id = ? AND merged_into_staff_id IS NULL AND staff_id IN (SELECT value FROM json_each(?))').bind(u.company_id, ids).first() as any
    if (Number(own?.n || 0) !== items.length) return c.json({ error: 'スタッフが見つかりません（自社のスタッフだけを指定できます）' }, 400)
  }
  // 続けて指定された人は登録日・登録者を残し、理由だけを書き換える
  await db.batch([
    db.prepare('UPDATE clients SET ng_staff_ids = ? WHERE client_id = ? AND company_id = ?').bind(items.map(i => i.staff_id).join(','), client.client_id, u.company_id),
    db.prepare('DELETE FROM client_ng_staff WHERE client_id = ? AND company_id = ? AND staff_id NOT IN (SELECT value FROM json_each(?))').bind(client.client_id, u.company_id, ids),
    db.prepare(`INSERT INTO client_ng_staff (client_id, staff_id, company_id, reason, created_by)
      SELECT ?, json_extract(value, '$.staff_id'), ?, json_extract(value, '$.reason'), ? FROM json_each(?) WHERE true
      ON CONFLICT(client_id, staff_id) DO UPDATE SET reason = excluded.reason`).bind(client.client_id, u.company_id, u.user_id, JSON.stringify(items)),
  ])
  return c.json({ ok: true, count: items.length })
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
  // 自社名は取引先にしない（#262）
  if (String(affiliation_name).trim() === await ownCompanyName(c.env.DB, u.company_id)) return c.json({ error: '自社名は取引先として登録できません' }, 400)
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
  const exists = await c.env.DB.prepare('SELECT employee_record_id, phone_main FROM employee_records WHERE staff_id = ?').bind(sid).first() as any
  // 電話番号が変わったときだけ users.phone にそろえる（従業員管理を初めて保存したときに、登録時の電話番号を空欄で消さないように比べる。#123）
  const phoneChanged = b.phone_main !== undefined && normalizePhone(b.phone_main) !== normalizePhone(exists?.phone_main)
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
  if (phoneChanged) await syncUserPhoneFromEmployee(c.env.DB, sid, u.company_id, b.phone_main)
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
      (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS staff_count,
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
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const name = String(b.project_name ?? '').trim()
  if (!name) return c.json({ error: '案件名は必須です' }, 400)
  if (b.project_type && !PROJECT_TYPES.includes(b.project_type)) return c.json({ error: '業務種別が正しくありません' }, 400)
  if (b.unit_price_type && !UNIT_PRICE_TYPES.includes(b.unit_price_type)) return c.json({ error: '単価の種類が正しくありません' }, 400)
  // 負の単価は受け付けない（#218。単価パネルの PUT /admin/projects/:id/pricing と同じ範囲）
  const priceErr = rangeError([['単価', b.unit_price, 0, MONEY_MAX]])
  if (priceErr) return c.json({ error: priceErr }, 400)
  // クライアントは任意（社内研修など）。空欄は NULL にする（'' のまま入れると外部キー違反になる）。他社のクライアントは指定できない
  const blank = (v: any) => v === undefined || v === null || String(v).trim() === ''
  const clientId = blank(b.client_id) ? null : b.client_id
  if (clientId !== null && !(await ownClient(c.env.DB, u.company_id, clientId))) return c.json({ error: 'クライアントが見つかりません' }, 400)
  // 日報テンプレートは自社または本部のものだけ。未指定なら、項目のあるテンプレートのうち最初のもの（画面の既定と同じ）
  let templateId: any = null
  if (!blank(b.report_template_id)) {
    if (!(await c.env.DB.prepare('SELECT 1 FROM report_templates WHERE template_id = ? AND (company_id IS NULL OR company_id = ?)').bind(b.report_template_id, u.company_id).first()))
      return c.json({ error: '日報テンプレートが見つかりません' }, 400)
    templateId = b.report_template_id
  } else {
    const t = await c.env.DB.prepare(`SELECT template_id FROM report_templates WHERE (company_id IS NULL OR company_id = ?)
      AND json_valid(fields_json) AND json_array_length(fields_json) > 0 ORDER BY template_id LIMIT 1`).bind(u.company_id).first()
    if (!t) return c.json({ error: '日報テンプレートが登録されていません。本部に登録を依頼してください' }, 400)
    templateId = t.template_id
  }
  // 二度押し・入力ミスで同じ案件が2件できないよう、稼働中の同名案件があれば確認を求める（確認済みなら登録する）
  if (b.allow_duplicate !== true && await c.env.DB.prepare(`SELECT 1 FROM projects WHERE company_id = ? AND project_name = ? AND status = 'active' LIMIT 1`).bind(u.company_id, name).first())
    return c.json({ error: `同じ名前の稼働中の案件「${name}」が既に登録されています`, confirm_duplicate: true }, 409)
  const r = await c.env.DB.prepare(`INSERT INTO projects (company_id, client_id, project_name, project_type, location, unit_price_type, unit_price, required_skills, report_template_id, requirements, manual_text, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, clientId, name, b.project_type || 'mobile_shop', b.location ?? null,
      b.unit_price_type || 'daily', b.unit_price || 0, b.required_skills ?? null, templateId, b.requirements ?? null, b.manual_text ?? null, b.memo ?? null).run()
  return c.json({ ok: true, project_id: r.meta.last_row_id })
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
    SELECT s.*, p.project_name, us.name AS staff_name,
      (SELECT COUNT(*) FROM attendance_reports ar WHERE ar.shift_id = s.shift_id AND ar.photo_key IS NOT NULL) AS photo_count
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? ORDER BY s.work_date, s.start_time`).bind(u.company_id, from, to).all()
  return c.json({ shifts: rows.results })
})

// シフトの勤怠報告の一覧（写真の有無つき）。写真は GET /admin/attendance-photo/:attendance_id で取得する（#217）
api.get('/admin/shifts/:id/attendance-photos', async (c) => {
  const u = c.get('user')
  const shift = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!shift) return c.json({ error: 'シフトが見つかりません' }, 404)
  const rows = await c.env.DB.prepare(`SELECT attendance_id, report_type, reported_at, status, entry_method, (photo_key IS NOT NULL) AS has_photo
    FROM attendance_reports WHERE shift_id = ? ORDER BY reported_at, attendance_id`).bind(shift.shift_id).all()
  return c.json({ shift_id: shift.shift_id, work_date: shift.work_date, reports: rows.results.map((r: any) => ({ ...r, has_photo: !!r.has_photo })) })
})

api.post('/admin/shifts', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.staff_id || !b.project_id || !b.work_date) return c.json({ error: 'スタッフ・案件・日付は必須です' }, 400)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.work_date))) return c.json({ error: '日付の形式が正しくありません' }, 400)
  if ((b.start_time && !isHHMM(b.start_time)) || (b.end_time && !isHHMM(b.end_time))) return c.json({ error: '時刻は HH:MM の形式で入力してください' }, 400)
  if (b.status && !SHIFT_STATUSES.includes(b.status)) return c.json({ error: 'シフトの状態が正しくありません' }, 400)
  // 自社の案件のみ（他社の案件名・場所・単価を取り込まない）
  const proj = await ownProject(c.env.DB, u.company_id, b.project_id)
  if (!proj) return c.json({ error: '案件が見つかりません' }, 404)
  // 交通費（実費）は空欄なら 0。案件の交通費ルール（定額・なし）は単価の適用で反映される（#94）
  const fee = b.transportation_fee === undefined || b.transportation_fee === null || b.transportation_fee === '' ? 0 : Number(b.transportation_fee)
  if (!Number.isInteger(fee) || fee < 0 || fee > 100000) return c.json({ error: '交通費は0〜100000の整数で入力してください' }, 400)
  const start = b.start_time || '09:30', end = b.end_time || '19:00'
  // 自社のスタッフマスタ行のみ。退職・統合・スキルシートのみ・取引終了は不可（#94）。
  // 重複・NG・休職中の警告: 画面（シフト管理の登録）は confirm_warnings を付けて送り、409 で確認してから force で登録する。
  // 付けずに呼んだ場合は登録し、警告を応答に含める（既存の呼び出しの動きを変えないため）
  const chk = await assertAssignable(c.env.DB, { companyId: u.company_id, project: proj, slot: null, staffId: Number(b.staff_id), workDate: b.work_date, start, end })
  if (chk.error) return c.json({ error: chk.error }, chk.status)
  if (chk.warnings.length && b.confirm_warnings === true && !b.force) return c.json({ warnings: chk.warnings, need_force: true }, 409)
  const ins = await c.env.DB.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, b.project_id, b.work_date, start, end,
      b.location || proj?.location || '', b.role || '販売スタッフ', b.unit_price ?? proj?.unit_price ?? 0, fee,
      b.status || 'confirmed', u.user_id, b.memo ?? null).run()
  // 単価ルール（請求/支払/交通費）を適用。単価を明示指定した場合は請求をその値で固定する
  const sid = ins.meta.last_row_id
  if (sid) {
    await applyPricingToShift(c.env.DB, u.company_id, sid)
    if (b.unit_price != null) await c.env.DB.prepare("UPDATE shifts SET unit_price = ?, bill_rate = ?, bill_unit_type = 'daily', bill_qty = 1, price_locked = 1 WHERE shift_id = ?").bind(b.unit_price, b.unit_price, sid).run()
  }
  return c.json({ ok: true, shift_id: sid, warnings: chk.warnings })
})

api.put('/admin/shifts/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  // 確定済み（精算）のシフトはメモ以外を変更できない
  const cur = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!cur) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (cur.settle_status === 'confirmed' && (b.status != null || b.start_time != null || b.end_time != null || b.staff_id != null))
    return c.json({ error: '確定済みのシフトは変更できません。精算画面で確定を取り消してください' }, 409)
  if (b.status != null && !SHIFT_STATUSES.includes(b.status)) return c.json({ error: 'シフトの状態が正しくありません' }, 400)
  // 付け替え先は割り当てられるスタッフのみ（退職・統合済み・スキルシートのみ・取引終了は不可）。重複・NG・休職中は確認のうえ
  // 付け替えたシフトは、移行時の重複の印（legacy_duplicate）を外して一意インデックスの対象に戻す
  const staffChanged = b.staff_id != null && Number(b.staff_id) !== cur.staff_id
  const newStaffId = staffChanged ? Number(b.staff_id) : cur.staff_id
  if (staffChanged) {
    const chk = await assertAssignable(c.env.DB, { companyId: u.company_id, project: cur.project_id, slot: cur.slot_role_id ? { slot_role_id: cur.slot_role_id } : null,
      staffId: newStaffId, workDate: cur.work_date, start: b.start_time ?? cur.start_time, end: b.end_time ?? cur.end_time, excludeShiftId: cur.shift_id })
    if (chk.error) return c.json({ error: chk.error }, chk.status)
    // 報告済み・打刻修正の申請中のシフトの差し替えは、確認してから行う（報告は新しい担当者に付け替え、前の担当者の申請は取り消す。#115 #101）
    const warnings = [...chk.warnings]
    const rep = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM attendance_reports WHERE shift_id = ?) AS a, (SELECT COUNT(*) FROM daily_reports WHERE shift_id = ?) AS d')
      .bind(cur.shift_id, cur.shift_id).first() as any
    if (Number(rep?.a || 0) + Number(rep?.d || 0) > 0)
      warnings.push(`このシフトには勤怠報告${Number(rep?.a || 0)}件・日報${Number(rep?.d || 0)}件があります。差し替えると、これらの報告は新しいスタッフの報告として扱います（前のスタッフが勤務した場合は、欠勤にして新しいシフトを作ってください）`)
    const pend = await pendingCorrectionCount(c.env.DB, cur.shift_id, newStaffId)
    if (pend) warnings.push(`承認待ちの打刻修正申請が${pend}件あります。差し替えると取り消して申請者に知らせます`)
    if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  } else if (b.status != null && b.status !== 'absent' && cur.status === 'absent') {
    // 欠勤から戻すときも、退職・取引終了などの人には戻さない
    const chk = await assertAssignable(c.env.DB, { companyId: u.company_id, project: cur.project_id, slot: null, staffId: cur.staff_id, workDate: cur.work_date, start: cur.start_time, end: cur.end_time })
    if (chk.error) return c.json({ error: chk.error }, chk.status)
  }
  // 担当者・時間が変わったら、スタッフの『入れます』などの返事を消す（別の人・別の時間には答えていない。#411 の残り）
  const timeChanged = (b.start_time != null && b.start_time !== cur.start_time) || (b.end_time != null && b.end_time !== cur.end_time)
  const db = c.env.DB, sid = cur.shift_id
  const stmts: D1PreparedStatement[] = [db.prepare(`UPDATE shifts SET
        status = COALESCE(?, status), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time),
        staff_id = COALESCE(?, staff_id), memo = COALESCE(?, memo),
        legacy_duplicate = CASE WHEN ? = 1 THEN NULL ELSE legacy_duplicate END,
        staff_reply = CASE WHEN ? = 1 THEN NULL ELSE staff_reply END, staff_reply_note = CASE WHEN ? = 1 THEN NULL ELSE staff_reply_note END,
        staff_reply_at = CASE WHEN ? = 1 THEN NULL ELSE staff_reply_at END
      WHERE shift_id = ? AND company_id = ?`)
    .bind(b.status ?? null, b.start_time ?? null, b.end_time ?? null, b.staff_id ?? null, b.memo ?? null, staffChanged ? 1 : 0,
      ...Array(3).fill(staffChanged || timeChanged ? 1 : 0), sid, u.company_id)]
  const cancelToken = newCancelToken()
  if (staffChanged) {
    stmts.push(
      // 報告を新しい担当者に付け替える（前の担当者の staff_id のまま残ると、退職後の定期削除で他人の記録が消える・削除が失敗する。#115）
      db.prepare('UPDATE attendance_reports SET staff_id = ? WHERE shift_id = ?').bind(newStaffId, sid),
      db.prepare('UPDATE daily_reports SET staff_id = ? WHERE shift_id = ?').bind(newStaffId, sid),
      // 前の担当者に送った報告用URLは使えなくする（#81）
      db.prepare('UPDATE shift_report_tokens SET revoked = 1 WHERE shift_id = ? AND revoked = 0').bind(sid),
      // 前の担当者の承認待ちの打刻修正申請は取り消す（#101）
      ...autoCancelStatements(db, sid, 'staff_changed', actorOf(u), cancelToken, newStaffId),
    )
  }
  try {
    await db.batch(stmts)
  } catch (e) {
    // 欠勤から戻すなどで、同じ枠に同じ人の有効なシフトが2件になる（一意インデックス #530）
    if (isUniqueViolation(e)) return c.json({ error: '同じ枠に、このスタッフの有効なシフトがすでにあります' }, 409)
    throw e
  }
  const cancelled = staffChanged ? await notifyAutoCancelled(c, sid, cancelToken) : 0
  // 時間・スタッフを変えた場合は単価（時給の数量・スタッフ別単価・支払先）を再計算（手動変更したシフトは除く）
  if (b.start_time != null || b.end_time != null || b.staff_id != null) await applyPricingToShift(c.env.DB, u.company_id, Number(c.req.param('id')))
  // 欠勤にしたシフトの承認待ちは承認できない（却下が必要）ので、件数を返す（#70）
  const pendingAbsent = b.status === 'absent' && cur.status !== 'absent' ? await pendingCorrectionCount(db, sid) : 0
  return c.json({ ok: true, ...(cancelled ? { cancelled_corrections: cancelled } : {}), ...(pendingAbsent ? { pending_corrections: pendingAbsent } : {}) })
})

api.delete('/admin/shifts/:id', async (c) => {
  const u = c.get('user')
  const cur = await c.env.DB.prepare('SELECT shift_id, settle_status FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (cur.settle_status === 'confirmed') return c.json({ error: '確定済みのシフトは削除できません。精算画面で確定を取り消してください' }, 409)
  // 勤怠・日報の報告があるシフトは削除できない（記録を残すため。欠勤などに変更する）
  const rep = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM attendance_reports WHERE shift_id = ?) + (SELECT COUNT(*) FROM daily_reports WHERE shift_id = ?) AS n')
    .bind(c.req.param('id'), c.req.param('id')).first() as any
  if (rep?.n > 0) return c.json({ error: '勤怠・日報の報告があるシフトは削除できません。状態を「欠勤」などに変更してください' }, 409)
  // 承認待ちの打刻修正申請（打刻漏れの追加）は、処理できなくなるので『取り消し（シフト削除）』にして申請者に知らせる（#70）
  const db = c.env.DB, cancelToken = newCancelToken()
  await db.batch([
    ...autoCancelStatements(db, cur.shift_id, 'shift_deleted', actorOf(u), cancelToken),
    db.prepare('DELETE FROM shift_report_tokens WHERE shift_id = ? AND company_id = ?').bind(cur.shift_id, u.company_id),
    db.prepare('DELETE FROM shifts WHERE shift_id = ? AND company_id = ?').bind(cur.shift_id, u.company_id),
  ])
  const cancelled = await notifyAutoCancelled(c, cur.shift_id, cancelToken)
  return c.json({ ok: true, ...(cancelled ? { cancelled_corrections: cancelled } : {}) })
})

// 日報一覧（#113 ページ送り、#183 未確認のみ、#404 案件・スタッフ・期間、#106 テンプレートの項目、#521 生の report_values は返さない）
// 条件: date（1日）または from〜to、project_id、staff_id、unchecked=1（未確認のみ）、flagged=1（インシデント・クレームのみ）、offset、limit（既定50・最大200）
// options=1 のときは、絞り込みの選択肢（案件・日報のあるスタッフ）も返す
const DAILY_REPORT_PAGE_MAX = 200
// 未確認の条件。migrations/0050_report_admin.sql の部分索引と同じ式にする（同じ式でないと索引が使われない）
const DR_UNCHECKED_SQL = 'COALESCE(dr.manager_checked, 0) = 0'
const DR_FLAGGED_SQL = '(dr.incident_flag = 1 OR dr.complaint_flag = 1)'
api.get('/admin/daily-reports', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const q = (k: string) => { const v = c.req.query(k); return v === undefined || v === '' ? null : v }
  const date = q('date'), from = q('from'), to = q('to')
  for (const [v, name] of [[date, '日付'], [from, '開始日'], [to, '終了日']] as const) {
    if (v !== null && !isISODate(v)) return c.json({ error: `${name}の形式が正しくありません` }, 400)
  }
  if (from && to && from > to) return c.json({ error: '期間の開始日が終了日より後になっています' }, 400)
  const projectId = q('project_id') === null ? null : toInt(q('project_id'), 1)
  const staffId = q('staff_id') === null ? null : toInt(q('staff_id'), 1)
  if ((q('project_id') !== null && projectId === null) || (q('staff_id') !== null && staffId === null)) return c.json({ error: '絞り込みの条件が正しくありません' }, 400)
  const limit = Math.min(toInt(q('limit') ?? 50, 1) ?? 50, DAILY_REPORT_PAGE_MAX)
  const offset = toInt(q('offset') ?? 0, 0) ?? 0
  const unchecked = q('unchecked') === '1', flagged = q('flagged') === '1'
  // 一覧を読んだ時刻。確認済みにするときに送り返してもらい、その後に出し直された日報を確認済みにしないために使う
  const asOf = nowJST()

  // 件数の内訳（未確認・インシデント）は、未確認のみ・インシデントのみの条件を外して数える
  let base = ' WHERE dr.company_id = ?'
  const binds: any[] = [u.company_id]
  if (date) { base += ' AND dr.work_date = ?'; binds.push(date) }
  if (from) { base += ' AND dr.work_date >= ?'; binds.push(from) }
  if (to) { base += ' AND dr.work_date <= ?'; binds.push(to) }
  if (projectId) { base += ' AND dr.project_id = ?'; binds.push(projectId) }
  if (staffId) { base += ' AND dr.staff_id = ?'; binds.push(staffId) }
  const extra = (unchecked ? ` AND ${DR_UNCHECKED_SQL}` : '') + (flagged ? ` AND ${DR_FLAGGED_SQL}` : '')
  const [rowsRes, countRes] = await db.batch([
    db.prepare(`
      SELECT dr.*, p.project_name, p.report_template_id, us.name AS staff_name,
        cu.name AS manager_comment_by_name, ku.name AS manager_checked_by_name
      FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
      JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
      LEFT JOIN users cu ON cu.user_id = dr.manager_comment_by
      LEFT JOIN users ku ON ku.user_id = dr.manager_checked_by
      ${base}${extra}
      ORDER BY dr.work_date DESC, dr.submitted_at DESC, dr.daily_report_id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    db.prepare(`SELECT COUNT(*) AS total_all,
        SUM(CASE WHEN ${DR_UNCHECKED_SQL} THEN 1 ELSE 0 END) AS unchecked,
        SUM(CASE WHEN ${DR_FLAGGED_SQL} THEN 1 ELSE 0 END) AS flagged,
        SUM(CASE WHEN 1${extra} THEN 1 ELSE 0 END) AS total
      FROM daily_reports dr${base}`).bind(...binds),
  ])
  const rows = rowsRes.results as any[]
  const cnt = (countRes.results as any[])[0] || {}
  // 案件の日報テンプレートの項目（表示の順とラベルに使う）
  const tplIds = [...new Set(rows.map(r => r.report_template_id).filter(Boolean))]
  const templates: Record<string, { key: string; label: string; type: string }[]> = {}
  if (tplIds.length) {
    const ts = (await db.prepare(`SELECT template_id, fields_json FROM report_templates WHERE template_id IN ${JSON_IN}`).bind(bindJsonArray(tplIds)).all()).results as any[]
    for (const t of ts) {
      let f: any[] = []
      try { const v = JSON.parse(t.fields_json || '[]'); if (Array.isArray(v)) f = v } catch { f = [] }
      templates[t.template_id] = f.filter(x => x && typeof x.key === 'string').map(x => ({ key: x.key, label: String(x.label || x.key), type: String(x.type || 'text') }))
    }
  }
  const reports = rows.map(r => {
    const { report_values, ...rest } = r
    let values: Record<string, unknown> = {}
    try { const v = JSON.parse(report_values || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) values = v } catch { values = {} }
    return { ...rest, values }
  })
  let options: any = undefined
  if (q('options') === '1') {
    const [pr, st] = await db.batch([
      db.prepare(`SELECT project_id, project_name, status FROM projects WHERE company_id = ? ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, project_id`).bind(u.company_id),
      db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
        WHERE sp.staff_id IN (SELECT DISTINCT staff_id FROM daily_reports WHERE company_id = ?) ORDER BY us.name, sp.staff_id`).bind(u.company_id),
    ])
    options = { projects: pr.results, staff: st.results }
  }
  return c.json({
    reports, templates, offset, limit, total: Number(cnt.total || 0), as_of: asOf,
    counts: { all: Number(cnt.total_all || 0), unchecked: Number(cnt.unchecked || 0), flagged: Number(cnt.flagged || 0) },
    ...(options ? { options } : {}),
  })
})

// 一覧を読んだ時刻（GET の as_of）。形式が違うものは使わない
const reportAsOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v : null)
const REPORT_REVISED = '一覧を開いた後に、スタッフが日報を修正しました。内容を確かめてから確認済みにしてください'

// 表示中の日報をまとめて確認済みにする（#183）。ids は最大 DAILY_REPORT_PAGE_MAX 件。すでに確認済みのものは変えない
api.post('/admin/daily-reports/check', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({})) as any
  if (!Array.isArray(b.ids) || b.ids.length === 0) return c.json({ error: '確認する日報を選んでください' }, 400)
  if (b.ids.length > DAILY_REPORT_PAGE_MAX) return c.json({ error: `一度に確認できるのは${DAILY_REPORT_PAGE_MAX}件までです` }, 400)
  const asOf = reportAsOf(b.as_of)
  // 確認済みにしたら「確認後に修正あり」の印（revised_after_check_at）は外す（後で未確認に戻したときに古い印が出ないように）。
  // as_of（一覧を読んだ時刻）より後にスタッフが出し直した日報は、管理者が見ていない内容なので確認済みにしない
  const r = await c.env.DB.prepare(`UPDATE daily_reports SET manager_checked = 1, manager_checked_by = ?, manager_checked_at = ?, revised_after_check_at = NULL
    WHERE daily_report_id IN ${JSON_IN} AND company_id = ? AND COALESCE(manager_checked, 0) = 0${asOf ? ' AND submitted_at <= ?' : ''}`)
    .bind(u.user_id, nowJST(), bindJsonArray(b.ids), u.company_id, ...(asOf ? [asOf] : [])).run()
  return c.json({ ok: true, checked: r.meta?.changes ?? 0 })
})

// 日報コメント・確認（#360）
// - manager_comment: キーがあれば、その値で置き換える（空欄は削除）。expected_comment（開いたときの内容）を一緒に送ると、
//   今の内容と違うときは 409 を返して書かない（別の管理者のコメントを黙って上書きしないため）
// - manager_checked: 1 で確認済み、0 で未確認に戻す
const MANAGER_COMMENT_MAX = 2000
const COMMENT_CONFLICT = '開いている間に、ほかの管理者がコメントを変更しました。内容を確かめてから保存してください'
api.put('/admin/daily-reports/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({})) as any
  const has = (k: string) => b && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, k)
  const id = toInt(c.req.param('id'), 1)
  const cur = id ? await c.env.DB.prepare('SELECT daily_report_id, manager_comment FROM daily_reports WHERE daily_report_id = ? AND company_id = ?').bind(id, u.company_id).first() as any : null
  if (!cur) return c.json({ error: '日報が見つかりません' }, 404)
  const sets: string[] = []; const vals: any[] = []
  const now = nowJST()
  let guard = false
  let asOf: string | null = null
  if (has('manager_comment')) {
    if (b.manager_comment !== null && typeof b.manager_comment !== 'string') return c.json({ error: 'コメントの形式が正しくありません' }, 400)
    const comment = typeof b.manager_comment === 'string' && b.manager_comment.trim() ? b.manager_comment.trim() : null
    if (comment && comment.length > MANAGER_COMMENT_MAX) return c.json({ error: `コメントは${MANAGER_COMMENT_MAX}文字以内で入力してください` }, 400)
    if (has('expected_comment')) {
      if ((b.expected_comment || '') !== (cur.manager_comment || '')) return c.json({ error: COMMENT_CONFLICT, current_comment: cur.manager_comment ?? null }, 409)
      guard = true
    }
    sets.push('manager_comment = ?', 'manager_comment_by = ?', 'manager_comment_at = ?')
    vals.push(comment, comment ? u.user_id : null, comment ? now : null)
  }
  if (has('manager_checked')) {
    const m = b.manager_checked
    const v = m === true || m === 1 || m === '1' ? 1 : m === false || m === 0 || m === '0' ? 0 : null
    if (v === null) return c.json({ error: '確認の状態が正しくありません' }, 400)
    sets.push('manager_checked = ?', 'manager_checked_by = ?', 'manager_checked_at = ?')
    vals.push(v, v ? u.user_id : null, v ? now : null)
    // 確認済みにしたら「確認後に修正あり」の印を外す（後で未確認に戻したときに古い印が出ないように）
    if (v) sets.push('revised_after_check_at = NULL')
    // as_of（一覧を読んだ時刻）より後にスタッフが出し直していたら、見ていない内容なので確認済みにしない
    if (v) asOf = reportAsOf(b.as_of)
  }
  if (!sets.length) return c.json({ error: '変更する項目がありません' }, 400)
  // 読み取りと書き込みの間に別の管理者が変えた場合も上書きしないよう、開いたときの内容を条件にする
  const conds = (guard ? " AND COALESCE(manager_comment, '') = ?" : '') + (asOf ? ' AND submitted_at <= ?' : '')
  const r = await c.env.DB.prepare(`UPDATE daily_reports SET ${sets.join(', ')} WHERE daily_report_id = ? AND company_id = ?${conds}`)
    .bind(...vals, id, u.company_id, ...(guard ? [cur.manager_comment || ''] : []), ...(asOf ? [asOf] : [])).run()
  if ((guard || asOf) && !(r.meta?.changes ?? 0)) {
    const latest = await c.env.DB.prepare('SELECT manager_comment, submitted_at FROM daily_reports WHERE daily_report_id = ?').bind(id).first() as any
    if (asOf && latest && String(latest.submitted_at) > asOf) return c.json({ error: REPORT_REVISED }, 409)
    return c.json({ error: COMMENT_CONFLICT }, 409)
  }
  return c.json({ ok: true })
})

// 実績分析（#184）。集計する項目は決め打ちにせず、その月に日報のある案件の日報テンプレートの数値項目（type: number）から決める。
// 値は json_each で項目ごとに合計する（キーを SQL に埋め込まない）。テンプレートから外れた古い数値項目も、キーを名前にして出す
type AnalyticsField = { key: string; label: string }
type AnalyticsRow = { reports: number; values: Record<string, number>; [k: string]: any }
const ANALYTICS_NUM = `CASE WHEN je.type IN ('integer','real') THEN je.value ELSE 0 END`
const ANALYTICS_JE = `json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je`
const ANALYTICS_JOINS = `LEFT JOIN projects p ON p.project_id = dr.project_id AND p.company_id = dr.company_id
    LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = dr.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = dr.staff_id AND er.company_id = dr.company_id`
// 集計の単位: 日別・スタッフ別・案件別・クライアント別（g は GROUP BY の式、extra は各行に添える列）
const ANALYTICS_GROUPS = {
  total: { g: "''", extra: '' },
  daily: { g: 'dr.work_date', extra: '' },
  staff: { g: 'dr.staff_id', extra: ', MAX(us.name) AS name, MAX(er.employee_number) AS employee_number' },
  project: { g: 'dr.project_id', extra: ', MAX(p.project_name) AS project_name, MAX(cl.client_name) AS client_name' },
  client: { g: 'COALESCE(p.client_id, 0)', extra: ', MAX(cl.client_name) AS client_name' },
} as const
type AnalyticsGroup = keyof typeof ANALYTICS_GROUPS
async function loadAnalytics(db: D1Database, cid: number, month: string) {
  const where = 'dr.company_id = ? AND dr.work_date LIKE ?'
  const bind = [cid, month + '%']
  const groups = Object.keys(ANALYTICS_GROUPS) as AnalyticsGroup[]
  const stmts = [
    db.prepare(`SELECT DISTINCT rt.template_id, rt.fields_json FROM daily_reports dr
      JOIN projects p ON p.project_id = dr.project_id AND p.company_id = dr.company_id JOIN report_templates rt ON rt.template_id = p.report_template_id
      WHERE ${where} ORDER BY rt.template_id`).bind(...bind),
    ...groups.map(k => db.prepare(`SELECT ${ANALYTICS_GROUPS[k].g} AS g, COUNT(*) AS reports ${ANALYTICS_GROUPS[k].extra}
      FROM daily_reports dr ${ANALYTICS_JOINS} WHERE ${where} GROUP BY g`).bind(...bind)),
    ...groups.map(k => db.prepare(`SELECT ${ANALYTICS_GROUPS[k].g} AS g, je.key AS k, SUM(${ANALYTICS_NUM}) AS v, MAX(je.type IN ('integer','real')) AS isnum
      FROM daily_reports dr ${ANALYTICS_JOINS}, ${ANALYTICS_JE} WHERE ${where} GROUP BY g, je.key`).bind(...bind)),
  ]
  const res = (await db.batch(stmts)).map(r => (r.results || []) as any[])
  // 項目: テンプレートの順に、数値項目を重複なく並べる（同じキーは最初のテンプレートのラベル）
  const fields: AnalyticsField[] = []; const seen = new Set<string>(); const textKeys = new Set<string>()
  for (const t of res[0]) {
    let defs: any[] = []
    try { defs = JSON.parse(t.fields_json) } catch { defs = [] }
    for (const f of Array.isArray(defs) ? defs : []) {
      if (!f || typeof f.key !== 'string' || !f.key) continue
      if (f.type !== 'number') { textKeys.add(f.key); continue }
      if (!seen.has(f.key)) { seen.add(f.key); fields.push({ key: f.key, label: String(f.label || f.key) }) }
    }
  }
  for (const r of res[1 + groups.length]) { // 合計の行から、テンプレートに無い数値項目を拾う
    if (r.isnum && !seen.has(r.k) && !textKeys.has(r.k)) { seen.add(r.k); fields.push({ key: r.k, label: r.k }) }
  }
  const out = {} as Record<AnalyticsGroup, AnalyticsRow[]>
  groups.forEach((k, i) => {
    const rows = new Map<any, AnalyticsRow>()
    for (const r of res[1 + i]) {
      const { g, ...rest } = r
      rows.set(g, { ...rest, values: Object.fromEntries(fields.map(f => [f.key, 0])) })
    }
    for (const r of res[1 + groups.length + i]) {
      const row = rows.get(r.g)
      if (row && seen.has(r.k)) row.values[r.k] = Number(r.v) || 0
    }
    out[k] = [...rows.entries()].map(([g, row]) => (k === 'daily' ? { work_date: g, ...row } : k === 'staff' ? { staff_id: g, ...row }
      : k === 'project' ? { project_id: g, ...row } : k === 'client' ? { client_id: g || null, ...row } : row))
  })
  out.daily.sort((a, b) => String(a.work_date).localeCompare(String(b.work_date)))
  for (const k of ['staff', 'project', 'client'] as const) out[k].sort((a, b) => b.reports - a.reports)
  const totals = out.total[0] || { reports: 0, values: Object.fromEntries(fields.map(f => [f.key, 0])) }
  return { month, fields, totals, daily: out.daily, by_staff: out.staff, by_project: out.project, by_client: out.client }
}
const analyticsMonth = (q: string | undefined) => (q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : monthJST())
api.get('/admin/analytics', async (c) => {
  const u = c.get('user')
  return c.json(await loadAnalytics(c.env.DB, u.company_id, analyticsMonth(c.req.query('month'))))
})
// 実績分析の CSV（by: staff スタッフ別 / project 案件別 / client クライアント別 / daily 日別）。項目の列は画面と同じ
api.get('/admin/analytics/csv', async (c) => {
  const u = c.get('user'); const month = analyticsMonth(c.req.query('month'))
  const by = (['staff', 'project', 'client', 'daily'] as const).find(k => k === c.req.query('by')) || 'staff'
  const a = await loadAnalytics(c.env.DB, u.company_id, month)
  const vals = (r: AnalyticsRow) => a.fields.map(f => r.values[f.key] ?? 0)
  const labels = a.fields.map(f => f.label)
  const NAME = { staff: 'スタッフ別', project: '案件別', client: 'クライアント別', daily: '日別' }[by]
  const csv = by === 'staff'
    ? toCsv(['月', 'スタッフID', '社員番号', 'スタッフ', '日報数', ...labels], a.by_staff.map(r => [month, r.staff_id, r.employee_number, r.name, r.reports, ...vals(r)]), { textCols: ['社員番号'] })
    : by === 'project'
      ? toCsv(['月', '案件ID', '案件', 'クライアント', '日報数', ...labels], a.by_project.map(r => [month, r.project_id, r.project_name, r.client_name, r.reports, ...vals(r)]))
      : by === 'client'
        ? toCsv(['月', 'クライアント', '日報数', ...labels], a.by_client.map(r => [month, r.client_name || '（クライアント未設定）', r.reports, ...vals(r)]))
        : toCsv(['日付', '日報数', ...labels], a.daily.map(r => [r.work_date, r.reports, ...vals(r)]))
  return csvResponse(`実績分析_${NAME}_${month}.csv`, csv)
})

// お知らせ配信
// 「既読 x/y名」は配信対象の人だけで数える（#7）。既読の記録を削除したお知らせは、削除の直前の人数を出す（#245）
// 1回に50件ずつ（offset でページ送り）。キーワード（タイトル・本文）・配信先の案件・期間で絞り込める（#368）。
// 配信先の案件名・スタッフ名と、配信した人の名前も返す
const ADMIN_NOTICE_PAGE = 50
api.get('/admin/notices', async (c) => {
  const u = c.get('user')
  const offset = toInt(c.req.query('offset'), 0, 100000) ?? 0
  const where: string[] = ['n.company_id = ?']
  const binds: any[] = [u.company_id]
  const q = String(c.req.query('q') || '').trim().slice(0, 100)
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
    where.push(`(n.title LIKE ? ESCAPE '\\' OR COALESCE(n.body, '') LIKE ? ESCAPE '\\')`); binds.push(like, like)
  }
  const projectId = toInt(c.req.query('project_id'), 1)
  if (projectId) {
    where.push(`EXISTS (SELECT 1 FROM notice_targets nt WHERE nt.notice_id = n.notice_id AND nt.target_type = 'project' AND nt.target_id = ?)`); binds.push(projectId)
  }
  const from = c.req.query('from'), to = c.req.query('to')
  if (isISODate(from)) { where.push('n.published_at >= ?'); binds.push(from) }
  if (isISODate(to)) { where.push('n.published_at < ?'); binds.push(addDays(to, 1)) }
  binds.push(ADMIN_NOTICE_PAGE + 1, offset)
  const rows = (await c.env.DB.prepare(`
    SELECT n.notice_id, n.title, n.body, n.target_type, n.target_ids, n.importance, n.read_required, n.published_at, n.created_by,
      n.reads_purged_at, n.reminded_at, n.remind_count, cu.name AS created_by_name,
      CASE WHEN n.reads_purged_at IS NULL THEN ${NOTICE_READ_COUNT_NOW_SQL} ELSE n.final_read_count END AS read_count,
      CASE WHEN n.reads_purged_at IS NULL THEN ${NOTICE_TARGET_COUNT_NOW_SQL} ELSE n.final_target_count END AS staff_total,
      CASE n.target_type
        WHEN 'project' THEN (SELECT group_concat(p.project_name, '、') FROM notice_targets nt JOIN projects p ON p.project_id = nt.target_id AND p.company_id = n.company_id
          WHERE nt.notice_id = n.notice_id AND nt.target_type = 'project')
        WHEN 'staff' THEN (SELECT group_concat(su.name, '、') FROM notice_targets nt JOIN staff_profiles tsp ON tsp.staff_id = nt.target_id AND tsp.company_id = n.company_id
          JOIN users su ON su.user_id = tsp.user_id WHERE nt.notice_id = n.notice_id AND nt.target_type = 'staff')
      END AS target_names
    FROM notices n LEFT JOIN users cu ON cu.user_id = n.created_by AND cu.company_id = n.company_id
    WHERE ${where.join(' AND ')}
    ORDER BY n.published_at DESC, n.notice_id DESC LIMIT ? OFFSET ?`).bind(...binds).all()).results as any[]
  const page = rows.slice(0, ADMIN_NOTICE_PAGE)
  // メールの送信結果（状態ごとの人数）。メールを送らなかったお知らせは email_counts = null
  const ids = page.map(n => n.notice_id)
  const counts = ids.length ? (await c.env.DB.prepare(`SELECT notice_id, status, COUNT(*) AS n FROM notice_email_deliveries
    WHERE company_id = ? AND notice_id IN (SELECT value FROM json_each(?)) GROUP BY notice_id, status`).bind(u.company_id, JSON.stringify(ids)).all()).results as any[] : []
  const byNotice = new Map<number, Record<string, number>>()
  for (const r of counts) { const m = byNotice.get(r.notice_id) || {}; m[r.status] = r.n; byNotice.set(r.notice_id, m) }
  return c.json({ notices: page.map(n => ({ ...n, email_counts: byNotice.get(n.notice_id) || null })), has_more: rows.length > ADMIN_NOTICE_PAGE, offset })
})

// お知らせの今の対象者（メールの宛先など）。条件は NOTICE_MEMBER_NOW_SQL と NOTICE_TARGET_SQL（一覧の既読数・既読状況と同じ）
async function resolveNoticeTargets(db: D1Database, companyId: number, noticeId: number):
  Promise<{ staff_id: number; user_id: number; name: string; email: string | null }[]> {
  const rows = await db.prepare(`SELECT sp.staff_id, us.user_id, us.name, us.email
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    WHERE n.notice_id = ? AND n.company_id = ? AND ${NOTICE_MEMBER_NOW_SQL} AND ${NOTICE_TARGET_SQL}`).bind(noticeId, companyId).all()
  return rows.results as any[]
}

// 対象者へお知らせメールをまとめて送り、1人ずつの結果を notice_email_deliveries に記録する（pending → sent / failed / skipped）
type NoticeMailRecipient = { user_id: number; name: string; email: string }
// メールのボタンは、そのお知らせの個別画面を開く（#333）。再通知は冪等キーを分け、送信結果の表には記録しない（#191。
// notice_email_deliveries は最初の配信の結果を1人1行で持つため）
async function sendNoticeEmails(env: Bindings, noticeId: number, companyId: number, title: string, body: string, recipients: NoticeMailRecipient[],
  opts: { idempotencyKey?: string; record?: boolean } = {}) {
  const db = env.DB
  const record = opts.record !== false
  try {
    const url = `${String(env.APP_BASE_URL || '').replace(/\/+$/, '')}/staff#notices/${noticeId}`
    const inputs = recipients.map(r => {
      const tpl = noticeEmail({ name: r.name, title, body, url })
      return { to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'notice', company_id: companyId }
    })
    // 冪等キーはお知らせ単位（同じお知らせの送信が二重に動いても、Resend 側で同じバッチを二度送らない）
    const results = await sendEmailBatch(env, inputs, { idempotencyKey: opts.idempotencyKey || `notice-${noticeId}` })
    if (!record) return
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
    if (!record) return
    try {
      await db.prepare(`UPDATE notice_email_deliveries SET status = 'failed', error = 'internal_error' WHERE notice_id = ? AND status = 'pending'`).bind(noticeId).run()
    } catch { /* 記録の失敗は無視 */ }
  }
}

// 二重配信とみなす時間（同じ作成者・同じ内容・同じ対象）
const NOTICE_DUP_WINDOW_SEC = 30

// 配信先の ID（カンマ区切り）を「1,2,3」の形にそろえる。自社の案件・スタッフでないものがあれば null（#370。notice_targets に展開する）
async function normalizeNoticeTargetIds(db: D1Database, companyId: number, targetType: string, raw: unknown): Promise<string | null> {
  if (targetType === 'all') return ''
  const ids = [...new Set(String(raw ?? '').split(',').map(s => toInt(s.trim(), 1)))]
  if (!ids.length || ids.some(x => x == null)) return null
  const table = targetType === 'project' ? 'projects' : 'staff_profiles'
  const key = targetType === 'project' ? 'project_id' : 'staff_id'
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ? AND ${key} IN ${JSON_IN}`).bind(companyId, bindJsonArray(ids)).first() as any
  return Number(r?.n) === ids.length ? ids.join(',') : null
}

// メールの宛先（連携スタッフは雇用元の本人のアドレスに送る #128）と、1人ずつの記録の行
async function noticeMailRecipients(db: D1Database, targets: { staff_id: number; user_id: number; name: string; email: string | null }[]) {
  const linked = await linkedStaffEmails(db, targets.filter(t => !String(t.email || '').trim()).map(t => t.staff_id))
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
  return { withEmail, rows }
}

// メールの本文。案件あてなら、どの案件あてかを先頭に書く（#455）
async function noticeMailBody(db: D1Database, n: { notice_id: number; company_id: number; target_type: string; body: string | null }) {
  if (n.target_type !== 'project') return String(n.body ?? '')
  const r = await db.prepare(`SELECT group_concat(p.project_name, '、') AS names FROM notice_targets nt JOIN projects p ON p.project_id = nt.target_id AND p.company_id = ?
    WHERE nt.notice_id = ? AND nt.target_type = 'project'`).bind(n.company_id, n.notice_id).first() as any
  return r?.names ? `対象の案件: ${r.names}\n\n${n.body ?? ''}` : String(n.body ?? '')
}

const NOTICE_IMPORTANCE = ['normal', 'important', 'urgent'] as const
const NOTICE_TARGET_TYPES = ['all', 'project', 'staff'] as const

api.post('/admin/notices', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const title = String(b.title ?? '').trim()
  if (!title) return c.json({ error: 'タイトルは必須です' }, 400)
  const body = String(b.body ?? '')
  const target_type = b.target_type || 'all'
  if (!oneOf(target_type, NOTICE_TARGET_TYPES)) return c.json({ error: '配信対象の指定が正しくありません' }, 400)
  const importance = b.importance || 'normal'
  if (!oneOf(importance, NOTICE_IMPORTANCE)) return c.json({ error: '重要度の指定が正しくありません' }, 400)
  const target_ids = await normalizeNoticeTargetIds(c.env.DB, u.company_id, target_type, b.target_ids)
  if (target_ids == null) return c.json({ error: target_type === 'project' ? '対象の案件を選んでください' : '対象のスタッフを選んでください' }, 400)
  // 二重送信の防止（#105）: 画面が発行した一意キー（client_request_id）が同じなら受け付けない。
  // キーが無い呼び出しも、同じ人が同じ内容を直前に配信していれば重複として扱う
  const requestId = typeof b.client_request_id === 'string' && b.client_request_id.trim() ? b.client_request_id.trim().slice(0, 64) : null
  const since = new Date(Date.now() + 9 * 3600 * 1000 - NOTICE_DUP_WINDOW_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const dup = await c.env.DB.prepare(`SELECT notice_id FROM notices WHERE company_id = ? AND created_by = ? AND title = ? AND COALESCE(body, '') = ?
    AND target_type = ? AND COALESCE(target_ids, '') = ? AND published_at >= ? LIMIT 1`)
    .bind(u.company_id, u.user_id, title, body, target_type, target_ids, since).first() as any
  if (dup) return c.json({ error: '同じお知らせを配信したばかりです。一覧を確認してください', duplicate: true, notice_id: dup.notice_id }, 409)
  // 配信先（notice_targets）は notices のトリガーで展開する（0052）
  const ins = await c.env.DB.prepare(`INSERT INTO notices (company_id, title, body, target_type, target_ids, importance, read_required, published_at, created_by, client_request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING notice_id`)
    .bind(u.company_id, title, body, target_type, target_ids, importance, b.read_required ? 1 : 0, nowJST(), u.user_id, requestId).first() as any
  if (!ins) return c.json({ error: 'このお知らせは配信済みです。一覧を確認してください', duplicate: true }, 409)
  const noticeId = Number(ins.notice_id)

  // メール通知（対象者判定ロジックは既存のnotice表示ロジックを再利用。既読状態には一切影響しない）
  // 送信対象・メール未登録の人数を返し、1人ずつの結果を記録する（#24）。連携スタッフは雇用元の本人のアドレスに送る（#128）
  let email: { mode: string; targets: number; with_email: number; no_email: number } | null = null
  if (b.send_email) {
    const targets = await resolveNoticeTargets(c.env.DB, u.company_id, noticeId)
    const { withEmail, rows } = await noticeMailRecipients(c.env.DB, targets)
    if (rows.length) {
      await c.env.DB.prepare(`INSERT OR IGNORE INTO notice_email_deliveries (notice_id, company_id, user_id, status, created_at)
        SELECT ?, ?, json_extract(value, '$.u'), json_extract(value, '$.s'), ? FROM json_each(?)`)
        .bind(noticeId, u.company_id, nowJST(), JSON.stringify(rows)).run()
    }
    if (withEmail.length) {
      const mailBody = await noticeMailBody(c.env.DB, { notice_id: noticeId, company_id: u.company_id, target_type, body })
      c.executionCtx.waitUntil(sendNoticeEmails(c.env, noticeId, u.company_id, title, mailBody, withEmail))
    }
    email = { mode: mailMode(c.env), targets: rows.length, with_email: withEmail.length, no_email: rows.length - withEmail.length }
  }
  return c.json({ ok: true, notice_id: noticeId, email })
})

// 未読者への再通知（#191）。今の配信対象で未読の人に、アプリ内通知（押すとそのお知らせを開く）を送る。
// send_email なら、メールでも送る。続けて何度も送らないよう、前回から10分は受け付けない
const NOTICE_REMIND_INTERVAL_MIN = 10
api.post('/admin/notices/:id{[0-9]+}/remind', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.reads_purged_at) return c.json({ error: '公開から2年たったお知らせは再通知できません' }, 400)
  const unread = (await db.prepare(`SELECT sp.staff_id, us.user_id, us.name, us.email
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    WHERE n.notice_id = ? AND n.company_id = ? AND ${NOTICE_MEMBER_NOW_SQL} AND ${NOTICE_TARGET_SQL}
      AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = us.user_id)`).bind(n.notice_id, u.company_id).all()).results as any[]
  if (!unread.length) return c.json({ error: '未読の人はいません' }, 400)
  // 先に再通知の日時を書き、同時に押されても1回だけ送る
  const now = nowJST()
  const since = new Date(Date.now() + 9 * 3600 * 1000 - NOTICE_REMIND_INTERVAL_MIN * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const claim = await db.prepare(`UPDATE notices SET reminded_at = ?, remind_count = remind_count + 1
    WHERE notice_id = ? AND (reminded_at IS NULL OR reminded_at < ?) RETURNING remind_count`).bind(now, n.notice_id, since).first() as any
  if (!claim) return c.json({ error: `再通知は前回から${NOTICE_REMIND_INTERVAL_MIN}分たってから送れます` }, 409)
  const users = [...new Map(unread.map(t => [t.user_id, t])).values()]
  await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
    SELECT ?, value, 'notice_reminder', ?, ?, ?, ?, ? FROM json_each(?)`)
    .bind(u.company_id, 'お知らせを確認してください', `「${n.title}」をまだ確認していません。開いて「確認しました」を押してください。`,
      `#notices/${n.notice_id}`, n.notice_id, now, bindJsonArray(users.map(t => t.user_id))).run()
  let email: { mode: string; with_email: number; no_email: number } | null = null
  if (b.send_email) {
    const { withEmail, rows } = await noticeMailRecipients(db, users)
    if (withEmail.length) {
      const mailBody = `まだ確認されていないお知らせです。開いて「確認しました」を押してください。\n\n${await noticeMailBody(db, n)}`
      c.executionCtx.waitUntil(sendNoticeEmails(c.env, n.notice_id, u.company_id, `（再通知）${n.title}`, mailBody, withEmail,
        { idempotencyKey: `notice-${n.notice_id}-remind-${claim.remind_count}`, record: false }))
    }
    email = { mode: mailMode(c.env), with_email: withEmail.length, no_email: rows.length - withEmail.length }
  }
  return c.json({ ok: true, notified: users.length, remind_count: claim.remind_count, reminded_at: now, email })
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

// お知らせ既読状況。既読・未読とも、今の配信対象の人だけを出す（#7）。
// 既読の時刻は UTC で保存している（列の既定値）ので、日本時間にして返す（#104）
api.get('/admin/notices/:id/reads', async (c) => {
  const u = c.get('user')
  const n = await ownNotice(c.env.DB, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.reads_purged_at) {
    // 公開から2年たって既読の記録を削除したお知らせ（#245）。削除の直前の人数だけを返す
    return c.json({ read: [], unread: [], purged: true, read_count: n.final_read_count, target_count: n.final_target_count })
  }
  const rows = (await c.env.DB.prepare(`
    SELECT DISTINCT us.user_id, us.name, CASE WHEN r.read_at IS NULL THEN NULL ELSE datetime(r.read_at, '+9 hours') END AS read_at, r.user_id IS NOT NULL AS is_read
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    LEFT JOIN notice_reads r ON r.notice_id = n.notice_id AND r.user_id = us.user_id
    WHERE n.notice_id = ? AND n.company_id = ? AND ${NOTICE_MEMBER_NOW_SQL} AND ${NOTICE_TARGET_SQL}
    ORDER BY us.name`).bind(n.notice_id, u.company_id).all()).results as any[]
  const read = rows.filter(r => r.is_read).map(r => ({ name: r.name, read_at: r.read_at }))
    .sort((a, b) => String(a.read_at || '').localeCompare(String(b.read_at || '')))
  const unread = rows.filter(r => !r.is_read).map(r => ({ name: r.name }))
  return c.json({ read, unread, purged: false, read_count: read.length, target_count: rows.length })
})

// ============ お知らせ既読率レポート ============
// スタッフ別の行（社員番号を添える）。並びは既読率の低い順で、対象のない人（既読率なし）は最後（#518）
const NOTICE_STAFF_REPORT_FROM = `FROM notice_read_staff_reports r
    JOIN staff_profiles sp ON sp.staff_id = r.staff_id
    JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = r.staff_id AND er.company_id = r.company_id`
const NOTICE_STAFF_REPORT_ORDER = 'r.read_rate IS NULL, r.read_rate, r.unread_count DESC, us.name, r.staff_id'
// 年度別（会社サマリ + スタッフ別）。長期保存されたレポートテーブルから取得する。
// 再集計できるかどうか（確定済み・保存期間外ならできない #48 #49）と、年度の途中かどうか（#481）も返す
api.get('/admin/notice-reports/:fiscalYear', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear'))
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)

  const summary = await c.env.DB.prepare(
    'SELECT * FROM notice_read_reports WHERE company_id = ? AND fiscal_year = ?'
  ).bind(u.company_id, fy).first() as any

  const staffRows = await c.env.DB.prepare(`
    SELECT r.staff_id, us.name AS staff_name, er.employee_number, r.target_count, r.read_count, r.unread_count, r.read_rate
    ${NOTICE_STAFF_REPORT_FROM}
    WHERE r.company_id = ? AND r.fiscal_year = ?
    ORDER BY ${NOTICE_STAFF_REPORT_ORDER}`).bind(u.company_id, fy).all()

  const block = noticeReportRecalcBlock(fy, summary?.finalized_at)
  return c.json({
    fiscal_year: fy,
    summary: summary || null, // 未生成の年度はnull（「対象となるお知らせがありません」表示等はフロント側で判断）
    staff_reports: staffRows.results,
    in_progress: fy === currentFiscalYear(), // 年度の途中（毎日の集計で値が変わる）
    finalized: !!summary?.finalized_at,
    recalculable: !block,
    recalc_block_reason: block,
  })
})

// 再集計（管理者が年度を指定して即時更新）。確定済み・保存期間外の年度は 409 で断る（長期保存した値を上書きしない #48）
api.post('/admin/notice-reports/:fiscalYear/recalculate', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear'))
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)
  let r: Awaited<ReturnType<typeof generateNoticeReadReport>>
  try {
    r = await generateNoticeReadReport(c.env.DB, u.company_id, fy)
  } catch {
    return c.json({ error: '再集計に失敗しました' }, 500)
  }
  if (!r.ok) return c.json({ error: r.reason }, 409)
  return c.json({ ok: true, calculated_at: r.calculated_at })
})

// スタッフ別・お知らせ単位の詳細。対象の判定は年度のレポートと同じ（公開した時点の対象者 #49 #481）。
// 既読の記録を削除したお知らせは is_read = null（記録なし）で返す
api.get('/admin/notice-reports/:fiscalYear/staff/:staffId', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear')); const staffId = c.req.param('staffId')
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)

  const staff = await c.env.DB.prepare(
    'SELECT sp.staff_id, sp.user_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ? AND sp.company_id = ?'
  ).bind(staffId, u.company_id).first()
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)

  const { start, end } = fiscalYearRange(fy)
  const noticeRows = await c.env.DB.prepare(`
    SELECT n.notice_id, n.title, n.published_at, n.reads_purged_at, n.importance, n.read_required,
      EXISTS(SELECT 1 FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = us.user_id) AS is_read
    FROM notices n JOIN staff_profiles sp ON sp.staff_id = ? JOIN users us ON us.user_id = sp.user_id
    WHERE n.company_id = ? AND n.published_at >= ? AND n.published_at < ?
      AND ${NOTICE_MEMBER_AT_PUBLISH_SQL} AND ${NOTICE_TARGET_SQL}
    ORDER BY n.published_at DESC`).bind(staff.staff_id, u.company_id, start, end).all()

  return c.json({
    fiscal_year: fy, staff_name: staff.name,
    notices: noticeRows.results.map((n: any) => ({
      notice_id: n.notice_id, title: n.title, published_at: n.published_at, importance: n.importance || 'normal', read_required: !!n.read_required,
      is_read: n.reads_purged_at ? null : !!n.is_read,
    })),
  })
})

// CSV出力（スタッフ別レポート。人事評価の参考資料用）。共通の toCsv でエスケープする（#72）。
// 並びは画面の初期表示と同じ既読率の低い順（order=name で氏名順）。スタッフID・社員番号の列も出す（#518）
api.get('/admin/notice-reports/:fiscalYear/csv', async (c) => {
  const u = c.get('user'); const fy = Number(c.req.param('fiscalYear'))
  if (!Number.isInteger(fy)) return c.json({ error: '年度の指定が不正です' }, 400)

  const company = await c.env.DB.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first()
  const staffRows = await c.env.DB.prepare(`
    SELECT r.staff_id, us.name AS staff_name, er.employee_number, r.target_count, r.read_count, r.unread_count, r.read_rate
    ${NOTICE_STAFF_REPORT_FROM}
    WHERE r.company_id = ? AND r.fiscal_year = ?
    ORDER BY ${c.req.query('order') === 'name' ? 'us.name, r.staff_id' : NOTICE_STAFF_REPORT_ORDER}`).bind(u.company_id, fy).all()

  const csv = toCsv(['年度', '会社', 'スタッフID', '社員番号', 'スタッフ', '対象数', '既読数', '未読数', '既読率'],
    (staffRows.results as any[]).map(r => [fy, (company?.company_name as string) || '', r.staff_id, r.employee_number, r.staff_name,
      r.target_count, r.read_count, r.unread_count, r.read_rate == null ? '-' : `${Number(r.read_rate).toFixed(1)}%`]),
    { textCols: ['社員番号'] })
  return csvResponse(`お知らせ既読率_${fy}年度.csv`, csv)
})

// 相談対応
// ?status= active（未対応＋対応中。既定）/ open / in_progress / done / all で絞り、?page= でページ送りする（#90）。
// 未対応・対応中は件数の上限なしで順に見られる。対象のシフト（日付・案件）があれば、そのシフトの ID も返す（#195）
const CONSULT_STATUSES = ['open', 'in_progress', 'done'] as const
const CONSULT_PAGE_SIZE = 50
api.get('/admin/consultations', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const q = c.req.query('status') || 'active'
  const status = q === 'all' || q === 'active' || oneOf(q, CONSULT_STATUSES) ? q : 'active'
  const page = toInt(c.req.query('page'), 1, 100000) ?? 1
  const cond = status === 'active' ? ` AND co.status != 'done'` : status === 'all' ? '' : ' AND co.status = ?'
  const binds: any[] = status === 'active' || status === 'all' ? [] : [status]
  const total = ((await db.prepare(`SELECT COUNT(*) AS n FROM consultations co WHERE co.company_id = ?${cond}`).bind(u.company_id, ...binds).first()) as any)?.n || 0
  const rows = await db.prepare(`
    SELECT co.*, us.name AS staff_name, p.project_name AS target_project_name,
      (SELECT sh.shift_id FROM shifts sh WHERE sh.company_id = co.company_id AND sh.staff_id = co.staff_id AND sh.project_id = co.target_project_id
         AND sh.work_date = co.target_date ORDER BY sh.start_time LIMIT 1) AS target_shift_id
    FROM consultations co
    JOIN staff_profiles sp ON co.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN projects p ON p.project_id = co.target_project_id AND p.company_id = co.company_id
    WHERE co.company_id = ?${cond} ORDER BY co.created_at DESC, co.consultation_id DESC LIMIT ? OFFSET ?`)
    .bind(u.company_id, ...binds, CONSULT_PAGE_SIZE, (page - 1) * CONSULT_PAGE_SIZE).all()
  const counts = (await db.prepare(`SELECT status, COUNT(*) AS n FROM consultations WHERE company_id = ? GROUP BY status`).bind(u.company_id).all()).results as any[]
  return c.json({ consultations: rows.results, status, page, per_page: CONSULT_PAGE_SIZE, total,
    counts: Object.fromEntries(CONSULT_STATUSES.map(s => [s, (counts.find(r => r.status === s)?.n as number) || 0])) })
})

// 返信・状態の変更。返信したら、スタッフ本人にアプリ内通知（consult_reply）で知らせ、ホームのバナーに出す（#320）
api.put('/admin/consultations/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const id = toInt(c.req.param('id'), 1)
  if (b.status != null && !oneOf(b.status, CONSULT_STATUSES)) return c.json({ error: '状態が正しくありません' }, 400)
  let reply: string | null = null
  if (b.manager_reply != null) {
    if (typeof b.manager_reply !== 'string' || !b.manager_reply.trim()) return c.json({ error: '返信を入力してください' }, 400)
    reply = b.manager_reply.trim()
    if (reply!.length > CONSULT_BODY_MAX) return c.json({ error: `返信は${CONSULT_BODY_MAX}文字以内で入力してください` }, 400)
  }
  const co = id == null ? null : await db.prepare(`SELECT co.consultation_id, co.company_id, co.manager_reply, co.category, sp.user_id
    FROM consultations co JOIN staff_profiles sp ON sp.staff_id = co.staff_id WHERE co.consultation_id = ? AND co.company_id = ?`).bind(id, u.company_id).first() as any
  if (!co) return c.json({ error: '相談が見つかりません' }, 404)
  const stmts = [db.prepare('UPDATE consultations SET manager_reply = COALESCE(?, manager_reply), status = COALESCE(?, status) WHERE consultation_id = ? AND company_id = ?')
    .bind(reply, b.status ?? null, co.consultation_id, u.company_id)]
  if (reply != null && reply !== co.manager_reply && co.user_id) {
    // 同じ相談の前の返信の通知は既読にして、未読は最新の1件だけにする
    const now = nowJST()
    stmts.push(db.prepare(`UPDATE user_notifications SET read_at = ? WHERE kind = '${CONSULT_REPLY_KIND}' AND related_id = ? AND read_at IS NULL`).bind(now, co.consultation_id))
    stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(co.company_id, co.user_id, CONSULT_REPLY_KIND, '相談・連絡に管理者から返信があります', reply.length > 100 ? reply.slice(0, 100) + '…' : reply, '#consult', co.consultation_id, now))
  }
  await db.batch(stmts)
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
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: '月を正しく指定してください' }, 400)
  // 件数は SQL で数え、金額は精算と同じ shiftTotals（交通費の請求区分・請求の調整額を含む）で、シフトの行を読んでから合計する
  const money = (await c.env.DB.prepare(`SELECT s.project_id, s.staff_id, s.unit_price, s.transportation_fee, s.bill_transport_type, s.bill_transport_amount, s.bill_adjust
    FROM shifts s WHERE s.company_id = ? AND s.work_date LIKE ? AND s.work_date <= ? AND s.status IN ('confirmed','substitute')`)
    .bind(u.company_id, month + '%', todayJST()).all()).results as any[]
  type Money = { base: number; transport: number; adjust: number; total: number }
  const byProject = new Map<number, Money>(), byStaff = new Map<string, Money>()
  const add = (m: Map<any, Money>, k: any, s: any) => {
    const t = shiftTotals(s); const a = m.get(k) || { base: 0, transport: 0, adjust: 0, total: 0 }
    a.base += Number(s.unit_price || 0); a.transport += t.bill_transport; a.adjust += Number(s.bill_adjust || 0); a.total += t.bill_total
    m.set(k, a)
  }
  for (const s of money) { add(byProject, s.project_id, s); add(byStaff, `${s.staff_id}:${s.project_id}`, s) }
  const zero: Money = { base: 0, transport: 0, adjust: 0, total: 0 }
  // 稼働人数は確定・代打のシフトの人だけを数える（欠勤・希望（仮）だけの人は数えない）。
  // 日報は、確定・代打のシフトのうち日報が必要なもの（シフト → スタッフ → 案件の設定）を分母に、そのシフトの日報があるものを分子に数える（#448）。
  // 日報の照合は shift_id、shift_id の無い古い日報はスタッフ・稼働日・案件（lib/daily-report.ts の findDailyReport と同じ）
  const working = "s.status IN ('confirmed','substitute')"
  const dailyReq = dailyReportRequiredSql('s', 'sp', 'p')
  const hasDaily = `EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id
    OR (+dr.shift_id IS NULL AND dr.staff_id = s.staff_id AND dr.work_date = s.work_date AND dr.project_id = s.project_id))`
  const rows = await c.env.DB.prepare(`
    SELECT p.project_id, p.project_name, cl.client_name,
      COUNT(CASE WHEN ${working} THEN 1 END) AS work_days,
      COUNT(CASE WHEN s.status = 'absent' THEN 1 END) AS absent_days,
      COUNT(CASE WHEN s.status = 'substitute' THEN 1 END) AS substitute_days,
      COUNT(DISTINCT CASE WHEN ${working} THEN s.staff_id END) AS staff_count,
      COUNT(CASE WHEN ${working} AND ${dailyReq} THEN 1 END) AS report_required,
      COUNT(CASE WHEN ${working} AND ${dailyReq} AND ${hasDaily} THEN 1 END) AS report_count
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    LEFT JOIN shifts s ON s.project_id = p.project_id AND s.work_date LIKE ? AND s.work_date <= ?
    LEFT JOIN staff_profiles sp ON sp.staff_id = s.staff_id
    WHERE p.company_id = ? GROUP BY p.project_id`).bind(month + '%', todayJST(), u.company_id).all()

  // スタッフ別明細
  const detail = await c.env.DB.prepare(`
    SELECT s.staff_id, s.project_id, us.name, p.project_name,
      COUNT(CASE WHEN ${working} THEN 1 END) AS work_days,
      COUNT(CASE WHEN s.status = 'absent' THEN 1 END) AS absent_days,
      COUNT(CASE WHEN ${working} AND ${dailyReq} THEN 1 END) AS report_required,
      COUNT(CASE WHEN ${working} AND ${dailyReq} AND ${hasDaily} THEN 1 END) AS report_count
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date LIKE ? AND s.work_date <= ?
    GROUP BY s.staff_id, s.project_id ORDER BY p.project_id, us.name`).bind(u.company_id, month + '%', todayJST()).all()

  // total_amount / amount = 請求基本額、total_transport / transport = 請求する交通費、total_adjust / adjust = 請求の調整、total_bill / total = 請求合計（精算の請求合計と同じ）
  return c.json({
    month,
    by_project: (rows.results as any[]).map(p => { const m = byProject.get(p.project_id) || zero; return { ...p, total_amount: m.base, total_transport: m.transport, total_adjust: m.adjust, total_bill: m.total } }),
    detail: (detail.results as any[]).map(d => { const m = byStaff.get(`${d.staff_id}:${d.project_id}`) || zero; return { ...d, amount: m.base, transport: m.transport, adjust: m.adjust, total: m.total } }),
  })
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
  // 本部専用の企業行（internal）は出さない。ユーザー数・週次アクティブに本部ユーザー（system_admin）は数えない（#372）
  const rows = await c.env.DB.prepare(`
    SELECT co.*,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND u.status = 'active' AND u.role NOT IN ('roster_only', 'system_admin')) AS user_count,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND u.role NOT IN ('roster_only', 'system_admin') AND u.last_login_at >= date('now', '-7 days')) AS active_users,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.company_id = co.company_id AND dr.work_date >= date('now', '-30 days')) AS reports_30d
    FROM companies co WHERE COALESCE(co.active_status, 'active') != ? ORDER BY co.company_id`).bind(HQ_COMPANY_STATUS).all()
  // 料金計算: 基本990円(3ユーザー) + 追加1ユーザー300円
  const companies = (rows.results as any[]).map(co => ({
    ...co,
    monthly_fee: 990 + Math.max(0, (co.user_count || 0) - 3) * 300
  }))
  return c.json({ companies })
})

api.get('/hq/companies/:id', async (c) => {
  const cid = c.req.param('id')
  const company = await c.env.DB.prepare('SELECT * FROM companies WHERE company_id = ? AND COALESCE(active_status, \'active\') != ?').bind(cid, HQ_COMPANY_STATUS).first()
  if (!company) return c.json({ error: 'not found' }, 404)
  // 本部ユーザーは一覧に出さない。メールアドレスは管理者アカウントの分だけ返す（スタッフの連絡先は本部に出さない）
  const users = await c.env.DB.prepare(`SELECT user_id, user_code, name, role, status, last_login_at, must_change_password,
      CASE WHEN role IN ('company_admin','sales_manager','field_manager','office_staff') THEN email END AS email
    FROM users WHERE company_id = ? AND role != 'system_admin' ORDER BY user_id`).bind(cid).all()
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
  // 本部専用の企業行（internal）は変更しない
  const r = await c.env.DB.prepare(`UPDATE companies SET
      plan = COALESCE(?, plan), user_limit = COALESCE(?, user_limit), active_status = COALESCE(?, active_status),
      billing_status = COALESCE(?, billing_status), support_memo = COALESCE(?, support_memo), maturity_level = COALESCE(?, maturity_level)
    WHERE company_id = ? AND COALESCE(active_status, 'active') != ?`)
    .bind(b.plan ?? null, b.user_limit ?? null, b.active_status ?? null, b.billing_status ?? null, b.support_memo ?? null, b.maturity_level ?? null, c.req.param('id'), HQ_COMPANY_STATUS).run()
  if (!r.meta.changes) return c.json({ error: 'not found' }, 404)
  // 停止にした時点で、その企業の利用者（本部ユーザーを除く）をログアウトさせる
  const revoked = b.active_status === 'inactive' ? await revokeCompanySessions(c.env.DB, Number(c.req.param('id'))) : 0
  return c.json({ ok: true, revoked_sessions: revoked })
})

api.post('/hq/companies', async (c) => {
  const b = await c.req.json()
  b.company_code = String(b.company_code ?? '').trim()
  b.admin_code = String(b.admin_code ?? '').trim()
  if (!b.company_code || !b.company_name) return c.json({ error: '会社コードと会社名は必須です' }, 400)
  // 初期管理者: メールアドレスを登録すると、承認依頼の通知とパスワード再設定のメールが届く（#25）。
  // パスワードを空欄にすると仮パスワードを作って一度だけ返す。どちらも初回ログインで本人に変更を求める
  let adminPassword = typeof b.admin_password === 'string' ? b.admin_password : ''
  let generated = false
  const adminEmail = cleanEmail(b.admin_email)
  if (b.admin_code || adminPassword || b.admin_email) {
    if (!b.admin_code) return c.json({ error: '初期管理者のIDを入力してください' }, 400)
    if (!/^\S{1,40}$/.test(b.admin_code)) return c.json({ error: '初期管理者の ID は空白なしの40文字以内で入力してください' }, 400)
    if (adminEmail === undefined) return c.json({ error: '初期管理者のメールアドレスの形式が正しくありません' }, 400)
    if (!adminPassword) { adminPassword = genTempPassword(); generated = true }
    const pwErr = validatePassword(adminPassword)
    if (pwErr) return c.json({ error: '初期管理者の' + pwErr }, 400)
  }
  const db = c.env.DB
  if (await db.prepare('SELECT 1 FROM companies WHERE company_code = ?').bind(b.company_code).first()) return c.json({ error: '会社コードが重複しています' }, 409)
  // 企業と初期管理者は1つの batch で作る（管理者の作成に失敗して、管理者のいない企業だけが残らないように）
  const stmts = [db.prepare('INSERT INTO companies (company_code, company_name, plan, user_limit, active_status) VALUES (?, ?, ?, ?, ?)')
    .bind(b.company_code, b.company_name, b.plan || 'basic', b.user_limit || 3, 'trial')]
  if (b.admin_code) {
    stmts.push(db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, must_change_password)
      SELECT company_id, ?, ?, 'company_admin', ?, ?, 1 FROM companies WHERE company_code = ?`)
      .bind(b.admin_code, String(b.admin_name || '').trim() || '管理者', await hashPassword(adminPassword), adminEmail, b.company_code))
  }
  try {
    await db.batch(stmts)
  } catch (e) {
    return c.json({ error: '会社コードが重複しています' }, 409)
  }
  return c.json({ ok: true, ...(generated ? { admin_temp_password: adminPassword } : {}) })
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
// 会社別・退職者別の内訳（detail）も返す（#365）
api.post('/hq/retention/dry-run', async (c) => {
  const result = await runRetentionCleanup(c.env.DB, c.env, { dryRun: true, trigger: 'manual', triggeredBy: c.get('user').user_id, detail: true })
  return c.json(result)
})

// 次回削除予定（猶予中・猶予待ち）と、退職日より後にシフトがあるため対象外にしている退職者の一覧。
// 今の動作モード（RETENTION_ENABLED が 'true' なら実削除、それ以外は dry-run のみ）も返す（#365）
api.get('/hq/retention/schedule', async (c) => {
  return c.json({ ...await listRetentionSchedule(c.env.DB), enabled: c.env.RETENTION_ENABLED === 'true' })
})

// 実行ログ。1回の実行（started_at が同じ行）を1行にまとめ、ページ送りする（#305）。
// trigger: all / cron（定期処理）/ manual（本部画面の dry-run）。実行元を記録する前（0048 より前）の行は、
// 実削除なら定期処理、dry-run なら手動として扱う。見出し用に、直近の実削除・定期処理の日時も返す
const RETENTION_RUNS_PER_PAGE = 20
const RETENTION_TRIGGER_SQL = `COALESCE(l.trigger_source, CASE WHEN l.dry_run = 0 THEN 'cron' ELSE 'manual' END)`
api.get('/hq/retention/logs', async (c) => {
  const db = c.env.DB
  const q = c.req.query('trigger')
  const trigger = oneOf(q, ['cron', 'manual'] as const) ? q : 'all'
  const page = toInt(c.req.query('page'), 1, 100000) || 1
  const where = trigger === 'all' ? '' : `WHERE ${RETENTION_TRIGGER_SQL} = ?`
  const binds = trigger === 'all' ? [] : [trigger]
  const groupBy = `GROUP BY l.started_at, l.dry_run, ${RETENTION_TRIGGER_SQL}`
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM retention_logs l ${where} ${groupBy})`).bind(...binds).first() as { n: number } | null
  const runs = (await db.prepare(`SELECT l.started_at, l.dry_run, ${RETENTION_TRIGGER_SQL} AS trigger_source, MAX(l.finished_at) AS finished_at,
      MAX(l.duration_ms) AS duration_ms, MAX(l.triggered_by) AS triggered_by, MAX(l.log_id) AS last_log_id
    FROM retention_logs l ${where} ${groupBy} ORDER BY MAX(l.log_id) DESC LIMIT ? OFFSET ?`)
    .bind(...binds, RETENTION_RUNS_PER_PAGE, (page - 1) * RETENTION_RUNS_PER_PAGE).all()).results as any[]
  // ページに出す実行の内訳（対象ごとの行）。started_at は文字列なので JSON の配列で1個にまとめて渡す
  const keys = [...new Set(runs.map(r => r.started_at).filter(Boolean))]
  const items = keys.length ? (await db.prepare(`SELECT l.started_at, l.dry_run, ${RETENTION_TRIGGER_SQL} AS trigger_source, l.target,
      l.target_count, l.deleted_count, l.failed_count, l.error_message
    FROM retention_logs l WHERE l.started_at IN ${JSON_IN} ORDER BY l.log_id`).bind(JSON.stringify(keys)).all()).results as any[] : []
  const userIds = runs.map(r => r.triggered_by).filter(Boolean)
  const names = new Map<number, string>()
  if (userIds.length) {
    const us = (await db.prepare(`SELECT user_id, name FROM users WHERE user_id IN ${JSON_IN}`).bind(bindJsonArray(userIds)).all()).results as any[]
    for (const u of us) names.set(u.user_id, u.name)
  }
  const nonRow = new Set(RETENTION_NON_ROW_TARGETS)
  const out = runs.map(r => {
    const rows = items.filter(i => i.started_at === r.started_at && i.dry_run === r.dry_run && i.trigger_source === r.trigger_source)
    // 合計は行数の対象だけを足す（人数・翌日に回したファイル数は足さない）
    const sum = (k: string) => rows.filter(i => !nonRow.has(i.target)).reduce((a, i) => a + (Number(i[k]) || 0), 0)
    const staff = rows.find(i => i.target === 'retired_staff')
    return {
      started_at: r.started_at, finished_at: r.finished_at, dry_run: r.dry_run, trigger_source: r.trigger_source, duration_ms: r.duration_ms,
      triggered_by_name: r.triggered_by ? names.get(r.triggered_by) || null : null,
      target_count: sum('target_count'), deleted_count: sum('deleted_count'),
      failed_count: rows.reduce((a, i) => a + (Number(i.failed_count) || 0), 0),
      staff_count: staff ? staff.target_count : null,
      items: rows.map(i => ({ target: i.target, target_count: i.target_count, deleted_count: i.deleted_count, failed_count: i.failed_count, error_message: i.error_message })),
    }
  })
  const latest = await db.prepare(`SELECT
      (SELECT MAX(started_at) FROM retention_logs WHERE dry_run = 0) AS last_real_run,
      (SELECT MAX(l.started_at) FROM retention_logs l WHERE ${RETENTION_TRIGGER_SQL} = 'cron') AS last_cron_run`).first()
  return c.json({ runs: out, page, per_page: RETENTION_RUNS_PER_PAGE, total: Number(total?.n) || 0, trigger, latest })
})

// 定期処理（cron）の処理ごとの最終実行・直近の実行記録・警告（#192）
api.get('/hq/cron/status', async (c) => {
  return c.json(await cronStatus(c.env.DB))
})

export default api

