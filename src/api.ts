import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { JSON_IN, batchInChunks, bindJsonArray } from './lib/d1-chunk'
import { sendEmail, sendEmailBatch, mailMode } from './services/email'
import { passwordResetEmail } from './email-templates/password-reset'
import { noticeEmail } from './email-templates/notice'
import { runRetentionCleanup, listRetentionSchedule, validateRetiredAt, isRetirementEffective, RETENTION_NON_ROW_TARGETS, RETENTION_TOKEN_TARGETS } from './services/retention'
import { cronStatus } from './services/cron'
import { RETENTION_MAINTENANCE_TARGETS, RETENTION_SETTING_DEFS, dailyReportRetentionInfo, getRetentionSettings, scanOrphanPhotos, setRetentionHold } from './services/retention'
import { csvLimitHeaders, csvLimitNote, loadLatestForCsv } from './csv'
import { OFFBOARDING_TABLES, OFFBOARDING_GRACE_DAYS, OFFBOARDING_GRACE_MIN, OFFBOARDING_GRACE_MAX, OFFBOARDING_EXPORT_PAGE, OFFBOARDING_TOTAL_STEPS,
  countOffboardingData, findUnknownOffboardingTables, exportOffboardingTablePage, listOffboardingFiles, findOffboardingFile, offboardingBucket, runOffboardingDeletion } from './services/retention'
import { buildUpdate } from './lib/update-builder'
import chatApi from './roster-chat'
import shiftBoardApi, { MONEY_MAX, applyPricingToShift, rangeError, stripMoney } from './shift-board'
import { applyRateOverride, inheritView, inheritedAdjustStmt, loadPricingData, parsePriceSource, rateOverrideOf } from './shift-board'
import boardApi from './board'
import settlementApi, { closedMessage, syncActualFromReports } from './settlement'
import { shiftTotals, staffingGaps } from './shift-board'
import { recruitAdminApi, recruitPublicApi, recruitStaffApi } from './recruit'
import { staffMergeApi } from './staff-merge'
import { adminLifecycleApi, publicReportApi, modesForShifts, resolveModes, normalizePhone, findStaffByPhone } from './staff-lifecycle'
import { loginEmailVerifyEmail } from './email-templates/login-email'
import reportSettingsApi, { REPORT_TYPES as ALL_REPORT_TYPES, ACTUAL_SYNC_TYPES, checkStaffReport, lateness, latenessSettings, latenessSettingsFor, validGraceMinutes, canEditAttendanceSettings, ATTENDANCE_SETTING_DENIED, loadReportState, reportStatus, reportableTypes, reportedAtMinute, MAX_LATE_GRACE_MINUTES } from './report-settings'
import { dailyReportRequiredSql } from './report-settings'
import { REPORT_LABEL, checkNoBreak, checkShiftAcceptsReport } from './report-settings'
// 前日確認（#176）と、電波がない場所で押した報告の時刻（#427）
import { clientRequestId, dayBeforeKey, dayBeforeSettings, dayBeforeState, deviceReportTime } from './report-settings'
import { chunk } from './lib/d1-chunk'
import { isTentativeShift, WORKING_SHIFT_STATUSES } from './lib/shift-status'
import { addDays, addMinutes, crossesMidnight, isWithin, reportableWindow, shiftWindow } from './lib/shift-time'
import { NO_PHOTO_REASONS, PHOTO_REQUIRED_ERROR, deviceSummary, isPhotoStale, noPhotoReasonText, photoSkipAllowed, photoSource, photoTakenAt } from './lib/attendance-photo'
import { correctionsAdminApi, correctionsStaffApi, actorOf, autoCancelStatements, notifyAutoCancelled, newCancelToken, pendingCorrectionCount } from './corrections'
import { notificationsAdminApi, notificationsStaffApi, notifyDailyReportIncident, mailHqApi, noticeAckPublicApi, loadMailContact, createNoticeAckTokens } from './notifications'
import { notifyConsultation, notifyLinkedRetirement, markAdminNotificationsRead } from './notifications'
import { loadShiftSnaps, notifyShiftChanges, notifyReportComment } from './notifications'
import { toCsv, csvResponse } from './csv'
import {
  SESSION_COOKIE, SESSION_HOURS, LOGIN_WINDOW_MINUTES, hashPassword, verifyPassword, needsRehash, dummyVerify, validatePassword, normalizeEmail,
  hashToken, isCompanyActive, canLogin, revokeSessions, revokeCompanySessions, loadSessionUser, homePathFor, sessionCookieOptions,
  loginAttemptKeys, isLoginLocked, recordLoginFailure, clearLoginFailures,
} from './lib/auth'
import {
  type LoginEvent, recordLoginEvent, requestMeta, deviceLabel, canUseMfa, ipDenied, mfaSetupPending, securitySettings, saveSecuritySettingsStmt,
  normalizeIpList, ipInList, newTotpSecret, totpUri, verifyTotp, newRecoveryCodes, recoveryCodesLeft, consumeRecoveryCode, PERSON_SESSION_WHERE,
} from './lib/login-security'
import rosterApi, { staffSelfApi, personStaffRows, ensureRosterIdentity, loadRoster, createPerson, partnerNameConflict, propagateNameToLinked, propagateRetirementStmts, hostNoteStmts, ROSTER_BASE_FIELDS, ROSTER_BUSINESS_FIELDS, normalizeCareerRows, careerSummary, getRequiredFields, missingRequired, normalizeRosterValues, linkedStaffEmails, findSamePersonCandidates, nextStaffCode } from './roster'
import { isHHMM, isISODate, oneOf, toInt, pickReportValues, reportFieldRulesError, cleanFileName, CONSULT_CATEGORIES, CONSULT_URGENCIES } from './lib/validate'
import { ownProject, ownClient, ownStaff, ownNotice, ownShift } from './lib/tenant'
import { authAccountApi, adminUsersApi, hqUsersApi, cleanEmail, genTempPassword, HQ_COMPANY_STATUS } from './accounts'
import { findDailyReport, dailyReportView, dailyReportBlocked, saveDailyReport, mergeIncidentNotes } from './lib/daily-report'
import { assertAssignable, assignableStaffSql, isUniqueViolation } from './lib/staff-eligibility'
import { NOTICE_TARGET_SQL, NOTICE_LIVE_SQL, NOTICE_EXPIRED_SQL, loadStaffNotices, countUnreadNotices, parseResponseOptions } from './lib/notices'
import { staffShiftView } from './shift-board'
import { validateTemplateFields, TEMPLATE_NAME_MAX } from './lib/report-template'
import { staffPayAdminApi, staffPayStaffApi } from './staff-pay'
import { staffSelfServiceApi, staffRequestsAdminApi, parseDocMeta } from './staff-self-service'
import { CHECK_IN_FAR_MAX_METERS, CHECK_IN_FAR_MIN_METERS, checkInDistance, distanceResult, emergencyNote, emergencyPhone, farThresholdMeters, haversineMeters, sitePosition } from './lib/site-location'
import { diffFields, changeLogStmts, payrollAlertStmts, PROFILE_LOG_FIELDS, CHANGE_FIELD_LABELS } from './lib/change-log'
import { opLog, logShifts, finishLog, opChanges, OP_ACTION_LABELS } from './lib/operation-log'
import { loadTransportDefaults, transportDefaultFor } from './lib/transport-defaults'
import rosterImportApi from './roster-import'
import { scheduleStaffApi, scheduleAdminApi, calendarPublicApi } from './staff-schedule'
import { hqSupportAdminApi, hqSupportHqApi, hqViewAdminGuard, hqViewUser, loadHqView, HQ_VIEW_COOKIE, HQ_VIEW_READONLY_MESSAGE } from './hq-support'

type Bindings = {
  DB: D1Database; PHOTOS: R2Bucket; DOCUMENTS: R2Bucket; CONTRACTS: R2Bucket
  RESEND_API_KEY: string; MAIL_FROM: string; APP_BASE_URL: string; MAIL_ENABLED?: string
  RETENTION_ENABLED?: string
  TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string
}
type Variables = { user: any; hqAudited?: boolean }

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
// 'YYYY-MM' の月初と翌月の月初。work_date >= 月初 AND work_date < 翌月初 で絞る（LIKE と違い、インデックスが使える。#212）
function monthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return [`${month}-01`, `${next}-01`]
}
// ?month=YYYY-MM を受け取る（形式が違う・無いときは今月）
const queryMonth = (q: string | undefined) => (q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : monthJST())
// スキルの区切り（半角・全角のカンマと読点）。掲示板（board.ts）・シフトボードの候補と同じ
const SKILL_SEP = /[,、，]/
function normalizeSkills(v: unknown): string | null {
  const list = [...new Set(String(v ?? '').split(SKILL_SEP).map(s => s.trim()).filter(Boolean))]
  return list.length ? list.join(',') : null
}
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
  // 下書き・予約前・取り消したお知らせは数えない（#291 #157。NOTICE_LIVE_SQL）
  const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM notices n WHERE n.company_id = ? AND n.published_at >= ? AND n.published_at < ? AND ${NOTICE_LIVE_SQL}`)
    .bind(companyId, start, end).first() as { n: number } | null
  // お知らせ×対象者の組を、スタッフごとにまとめて1回で数える（在籍者を IN に並べない。D1 のバインド上限を超えないように）
  const rows = (await db.prepare(`
    SELECT sp.staff_id, COUNT(*) AS target_n,
      SUM(EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = us.user_id)) AS read_n
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    WHERE n.company_id = ? AND n.published_at >= ? AND n.published_at < ? AND ${NOTICE_LIVE_SQL}
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
// そのあとで、締めた後に付いた既読などの残りを、既読の日時から2年で削除する（1回のCronでそれぞれ上限まで。続きは翌日以降）。
// お知らせへの回答（notice_responses #554）も、既読の記録と同じく公開から2年で削除する。
// 下書き（#291）は配信していないので対象にしない（published_at は作成日時のため。古い下書きを後で配信したときに「確認不要」にならないように）
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
      const ids = ((await db.prepare(`SELECT notice_id FROM notices WHERE reads_purged_at IS NULL AND published_at < ? AND status != 'draft' ORDER BY published_at LIMIT ?`)
        .bind(cutoffJst, NOTICE_BATCH).all()).results as { notice_id: number }[]).map(r => r.notice_id)
      if (!ids.length) break
      const json = bindJsonArray(ids)
      const res = await db.batch([
        db.prepare(`UPDATE notices AS n SET final_target_count = ${NOTICE_TARGET_COUNT_NOW_SQL}, final_read_count = ${NOTICE_READ_COUNT_NOW_SQL},
            reads_purged_at = ? WHERE n.notice_id IN ${JSON_IN} AND n.reads_purged_at IS NULL`).bind(nowJST(), json),
        db.prepare(`DELETE FROM notice_reads WHERE notice_id IN ${JSON_IN}`).bind(json),
        db.prepare(`DELETE FROM notice_responses WHERE notice_id IN ${JSON_IN}`).bind(json),
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
// 二段階認証のコードを待つ時間と、1回のログインで受け付ける失敗の回数（#544）
const MFA_CHALLENGE_MINUTES = 5
const MFA_MAX_ATTEMPTS = 5
const IP_DENIED_MESSAGE = `この接続元からはログインできません（会社の設定で、ログインできる接続元が決められています）。${LOGIN_HELP}`
/**
 * パスワード（と二段階認証）を確かめた後のセッションの発行。ログインと二段階認証の確認で共用する。
 * 同じ端末の古いセッション（Cookie で送られてきたもの）と、期限切れのセッションは消してから発行し、接続元と端末を残す（#453）
 */
async function issueSession(c: any, user: any, company: any, method: 'password' | 'totp' | 'recovery') {
  const db = c.env.DB as D1Database
  const oldToken = getCookie(c, SESSION_COOKIE)
  if (oldToken) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(oldToken)).run()
  const nowIso = new Date().toISOString()
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.user_id, nowIso).run()
  const token = genToken()
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000)
  const meta = requestMeta(c)
  await db.prepare('INSERT INTO sessions (token, user_id, company_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await hashToken(token), user.user_id, user.company_id, expires.toISOString(), meta.ip, meta.ua).run()
  const loginAt = nowJST()
  await db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE user_id = ?').bind(loginAt, loginAt, user.user_id).run()
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c))
  await recordLoginEvent(db, c, { company_id: user.company_id, user_id: user.user_id, company_code: user.role === 'system_admin' ? '' : company.company_code, user_code: user.user_code, result: 'success', method })
  // 会社コード・ID は登録どおりの表記で返す（ログイン画面が次回の入力欄に入れておく。#308）
  return c.json({ ok: true, user: { user_id: user.user_id, name: user.name, role: user.role, company_name: company.company_name, must_change_password: !!user.must_change_password },
    company_code: user.role === 'system_admin' ? '' : company.company_code, user_code: user.user_code, redirect: homePathFor(user.role) })
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
  // ログインの履歴（#552）。入力された会社コード・ID と、分かれば会社・利用者を残す
  const logEvent = (result: LoginEvent['result'], companyId?: number | null, userId?: number | null) =>
    recordLoginEvent(db, c, { company_id: companyId ?? null, user_id: userId ?? null, company_code: rawCompanyCode, user_code: rawUserCode, result })
  const lockedResponse = async (companyId?: number | null) => {
    await logEvent('locked', companyId)
    return c.json({ error: `ログインの失敗が続いたため、一時的にログインを止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください。${LOGIN_HELP}` }, 429)
  }

  let keys = await loginAttemptKeys(company_code, user_code, ip)
  let company = company_code ? await findCompanyByCode(db, company_code, rawCompanyCode) : null
  if (await isLoginLocked(db, keys)) return lockedResponse(company?.company_id)

  let user = company ? await findUserByCode(db, company.company_id, user_code, rawUserCode) : null
  // 本部ユーザー（本部専用の企業行に所属）は会社コードなしでログインする。以前の案内どおり会社コードを入れても、
  // その会社に同じ ID がなければ本部ユーザーとして照合する。失敗回数は会社コードによらず同じ記録で数える
  if (!user) {
    const hq = await db.prepare(`SELECT u.* FROM users u JOIN companies co ON co.company_id = u.company_id
      WHERE co.active_status = ? AND u.role = 'system_admin' AND LOWER(u.user_code) = LOWER(?) ORDER BY (u.user_code != ?), u.user_id LIMIT 1`).bind(HQ_COMPANY_STATUS, user_code, user_code).first() as any
    if (hq) {
      if (company_code) {
        keys = await loginAttemptKeys('', user_code, ip)
        if (await isLoginLocked(db, keys)) return lockedResponse(hq.company_id)
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
    await logEvent('bad_password', user?.company_id ?? company?.company_id, user && canLogin(user.role) ? user.user_id : null)
    return c.json({ error: LOGIN_FAILED_MESSAGE }, 401)
  }
  // パスワードが合ったときだけ、利用できない理由を伝える（アカウントの有無は漏れない）
  if (user.status !== 'active') {
    await logEvent('inactive', user.company_id, user.user_id)
    return c.json({ error: `このアカウントは現在利用できません。${LOGIN_HELP}` }, 403)
  }
  if (user.role !== 'system_admin' && !isCompanyActive(company.active_status)) {
    await logEvent('company_inactive', user.company_id, user.user_id)
    return c.json({ error: `ご契約が停止中のため、現在ご利用いただけません。${LOGIN_HELP}` }, 403)
  }
  // 接続元の制限（#544。会社の設定。本部ユーザーは本部の設定）
  if (ipDenied(user.role, company.settings_json, ip)) {
    await logEvent('ip_denied', user.company_id, user.user_id)
    return c.json({ error: IP_DENIED_MESSAGE, code: 'ip_denied' }, 403)
  }
  // 旧形式（ソルトなし SHA-256）のパスワードは、ここで PBKDF2 に作り直す
  if (needsRehash(user.password_hash)) {
    await db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').bind(await hashPassword(password), user.user_id).run()
  }
  // このブラウザで別の人がログイン中なら、切り替えてよいかを先に確かめる（#346。開いたままの画面が別の人として操作を続けないように）
  const oldToken = getCookie(c, SESSION_COOKIE)
  if (oldToken && b.confirm_switch !== true) {
    const cur = await loadSessionUser(db, oldToken)
    if (cur.ok && cur.user.user_id !== user.user_id && !(cur.user.person_id && cur.user.person_id === user.person_id)) {
      return c.json({ error: `このブラウザでは ${cur.user.name} さんがログイン中です。ログアウトして切り替えますか？`, code: 'already_logged_in', current_name: cur.user.name }, 409)
    }
  }
  // 二段階認証を登録している人は、認証アプリのコードを確かめてからセッションを発行する（#544）。
  // 失敗回数の記録はコードを確かめるまで消さない（パスワードを知る人がコードを総当たりできないように）
  if (canUseMfa(user.role) && user.totp_enabled_at && user.totp_secret) {
    const mfaToken = genToken()
    const now = new Date()
    await db.batch([
      db.prepare('DELETE FROM mfa_challenges WHERE user_id = ? OR expires_at < ?').bind(user.user_id, now.toISOString()),
      db.prepare('INSERT INTO mfa_challenges (token_hash, user_id, attempt_key, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)')
        .bind(await hashToken(mfaToken), user.user_id, keys.account, new Date(now.getTime() + MFA_CHALLENGE_MINUTES * 60000).toISOString(), now.toISOString()),
    ])
    return c.json({ ok: true, mfa_required: true, mfa_token: mfaToken, expires_in_minutes: MFA_CHALLENGE_MINUTES })
  }
  await clearLoginFailures(db, keys)
  return issueSession(c, user, company, 'password')
})

// 二段階認証のコード（認証アプリの6桁、または予備コード）を確かめてログインする（#544）
api.post('/auth/login/mfa', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const db = c.env.DB
  const expired = () => c.json({ error: '確認の時間が過ぎたか、失敗が続きました。もう一度、最初からログインしてください', code: 'mfa_expired' }, 401)
  const token = typeof b.mfa_token === 'string' ? b.mfa_token : ''
  if (!token) return expired()
  const tokenHash = await hashToken(token)
  const ch = await db.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, new Date().toISOString()).first() as any
  if (!ch || ch.attempts >= MFA_MAX_ATTEMPTS) return expired()
  const ip = c.req.header('CF-Connecting-IP')
  const keys = { account: String(ch.attempt_key), ip: (await loginAttemptKeys('', '', ip)).ip }
  const user = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(ch.user_id).first() as any
  const company = user ? await db.prepare('SELECT * FROM companies WHERE company_id = ?').bind(user.company_id).first() as any : null
  // 待っている間に停止・二段階認証の解除などがあれば、最初からやり直してもらう
  if (!user || !company || user.status !== 'active' || !canLogin(user.role) || !user.totp_secret
    || (user.role !== 'system_admin' && !isCompanyActive(company.active_status))) {
    await db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash).run()
    return expired()
  }
  const logEvent = (result: LoginEvent['result']) => recordLoginEvent(db, c, { company_id: user.company_id, user_id: user.user_id,
    company_code: user.role === 'system_admin' ? '' : company.company_code, user_code: user.user_code, result })
  if (await isLoginLocked(db, keys)) {
    await logEvent('locked')
    return c.json({ error: `失敗が続いたため、一時的にログインを止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください。${LOGIN_HELP}` }, 429)
  }
  if (ipDenied(user.role, company.settings_json, ip)) {
    await logEvent('ip_denied')
    return c.json({ error: IP_DENIED_MESSAGE, code: 'ip_denied' }, 403)
  }
  // 6桁なら認証アプリのコード、それ以外は予備コードとして確かめる。同じコードを2回使えないよう、条件付きの更新で記録する
  let method: 'totp' | 'recovery' | null = null
  const step = await verifyTotp(user.totp_secret, b.code, user.totp_last_step)
  if (step !== null) {
    const r = await db.prepare('UPDATE users SET totp_last_step = ? WHERE user_id = ? AND COALESCE(totp_last_step, -1) < ?').bind(step, user.user_id, step).run()
    if (r.meta.changes) method = 'totp'
  } else {
    const rest = await consumeRecoveryCode(user.mfa_recovery_codes, b.code)
    if (rest !== null) {
      const r = await db.prepare('UPDATE users SET mfa_recovery_codes = ? WHERE user_id = ? AND mfa_recovery_codes = ?').bind(rest, user.user_id, user.mfa_recovery_codes).run()
      if (r.meta.changes) method = 'recovery'
    }
  }
  if (!method) {
    await db.prepare('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?').bind(tokenHash).run()
    await recordLoginFailure(db, keys)
    await logEvent('mfa_failed')
    const left = MFA_MAX_ATTEMPTS - ch.attempts - 1
    if (left <= 0) return expired()
    return c.json({ error: `確認コードが正しくありません（あと${left}回）。認証アプリに表示されている最新の6桁を入力してください`, attempts_left: left }, 401)
  }
  await db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash).run()
  await clearLoginFailures(db, keys)
  return issueSession(c, user, company, method)
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
    `SELECT t.*, u.status AS user_status, u.role AS user_role, u.user_code, u.company_id, co.company_code FROM password_reset_tokens t JOIN users u ON u.user_id = t.user_id
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
  await recordLoginEvent(c.env.DB, c, { company_id: row.company_id ?? null, user_id: row.user_id, company_code: row.user_role === 'system_admin' ? '' : row.company_code,
    user_code: row.user_code, event_type: 'password_reset', result: 'success' })

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
  // 本部の管理画面の閲覧（#293）もここで終える
  const viewToken = getCookie(c, HQ_VIEW_COOKIE)
  if (viewToken) {
    await c.env.DB.prepare(`UPDATE hq_view_sessions SET ended_at = ?, end_reason = 'logout' WHERE token_hash = ? AND ended_at IS NULL`).bind(new Date().toISOString(), await hashToken(viewToken)).run()
    deleteCookie(c, HQ_VIEW_COOKIE, { path: '/', secure: new URL(c.req.url).protocol === 'https:' })
  }
  return c.json({ ok: true })
})

// ログイン不要のシフト専用報告用URL（トークンで1シフトのみ操作可。src/staff-lifecycle.ts）。認証ミドルウェアより前に登録する
api.route('/public/report', publicReportApi)
// 報告用URLに出す会社の緊急連絡先（#173）。期限切れ・取り消し後の画面でも連絡できるよう、発行済みのURLなら返す（停止中の企業は返さない）。
// 返すのは会社名と連絡先だけ（シフト・スタッフの情報は返さない）
api.get('/public/report/:token/contact', async (c) => {
  const token = c.req.param('token')
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) return c.json({ error: '連絡先が見つかりません' }, 404)
  // 予定確認URL（#442。staff_schedule_tokens はトークンのハッシュで持つ）でも返す（#163）
  const row = await c.env.DB.prepare(`SELECT co.company_name, co.emergency_phone, co.emergency_note, co.active_status FROM companies co
    WHERE co.company_id = (SELECT company_id FROM shift_report_tokens WHERE token = ? UNION ALL SELECT company_id FROM staff_schedule_tokens WHERE token_hash = ? LIMIT 1)`)
    .bind(token, await sha256(token)).first() as any
  if (!row || !isCompanyActive(row.active_status)) return c.json({ error: '連絡先が見つかりません' }, 404)
  return c.json({ company_name: row.company_name, phone: row.emergency_phone || '', note: row.emergency_note || '' })
})
// 公開の募集ページ（ログイン不要。src/recruit.ts）
api.route('/public/recruit', recruitPublicApi)
// お知らせメールの「確認しました」（ログイン不要。メールのワンタイムのトークンで既読にする #454。src/notifications.ts）
api.route('/public/notice-ack', noticeAckPublicApi)
// シフトのカレンダー購読（ログイン不要。本人ごとのトークンの URL。#301 src/staff-schedule.ts）
api.route('/public/calendar', calendarPublicApi)

// 二段階認証の登録待ちの間も使える API（#544）
const MFA_SETUP_PATHS = ['/api/auth/me', '/api/auth/mfa', '/api/auth/mfa/setup', '/api/auth/mfa/enable', '/api/auth/sessions', '/api/auth/change-password', '/api/auth/logout-all']

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
  // 接続元の制限（#544）: 制限を設定する前からほかの場所で開いていた画面も止める。セッションは消し、ログイン画面で理由を伝える
  if (ipDenied(u.role, u.settings_json, c.req.header('CF-Connecting-IP'))) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token!)).run()
    return c.json({ error: IP_DENIED_MESSAGE, code: 'ip_denied' }, 401)
  }
  // 二段階認証が必須になったのに未登録の人は、登録を済ませるまで登録の画面（と自分のアカウント・ログアウト）だけを使える
  if (mfaSetupPending(u, u.settings_json) && !MFA_SETUP_PATHS.includes(c.req.path) && !(c.req.path === '/api/auth/account' && c.req.method === 'GET')) {
    return c.json({ error: '二段階認証の登録が必要です。「セキュリティ」の画面で認証アプリを登録してください', code: 'mfa_setup_required' }, 403)
  }
  c.header('X-Session-Expires', await extendSession(c, token!, u))
  await touchLastSeen(c, u)
  c.set('user', u)
  return next()
})

// 最後にアプリを使った日時（#491）: パスワードでのログインのほか、セッションでの操作でも残す（週次アクティブの集計に使う）。
// 企業切替の後はセッションの利用者が切替先のユーザー行になるので、切替先の行が更新される。
// 書き込みを減らすため、前回から LAST_SEEN_STEP_MINUTES 以上たったときだけ更新し、定期の取得（X-Background: 1）では更新しない
const LAST_SEEN_STEP_MINUTES = 60
async function touchLastSeen(c: any, u: any) {
  if (c.req.header('X-Background') === '1') return
  const now = nowJST()
  const threshold = new Date(Date.now() + 9 * 3600 * 1000 - LAST_SEEN_STEP_MINUTES * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  if (u.last_seen_at && String(u.last_seen_at) > threshold) return
  try {
    await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE user_id = ?').bind(now, u.user_id).run()
    u.last_seen_at = now
  } catch (e) {
    // 記録できなくても操作は止めない
    console.error('last_seen_at の更新に失敗しました', e)
  }
}

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

// 本部の管理画面の閲覧中（#293。閲覧の画面は X-HQ-View: 1 を付けて呼ぶ）は、本部ユーザー自身のアカウントの変更も通さない
api.use('/auth/*', async (c, next) => {
  if (c.get('user')?.role === 'system_admin' && c.req.header('X-HQ-View') === '1' && c.req.method !== 'GET') {
    return c.json({ error: HQ_VIEW_READONLY_MESSAGE, code: 'hq_view_readonly' }, 403)
  }
  return next()
})
api.get('/auth/me', async (c) => {
  const self = c.get('user')
  let u = self
  // 閲覧の画面（/admin）からの呼び出しでは、閲覧先の企業・閲覧用のロールを返す（user_id は本部ユーザーのまま）
  if (u.role === 'system_admin' && c.req.header('X-HQ-View') === '1') {
    const v = await loadHqView(c.env.DB, getCookie(c, HQ_VIEW_COOKIE), u.user_id)
    if (v) u = hqViewUser(u, v)
  }
  return c.json({ user_id: u.user_id, name: u.name, role: u.role, company_name: u.company_name, staff_id: u.staff_id, company_id: u.company_id,
    company_code: u.role === 'system_admin' ? '' : (u.company_code || ''), can_manage_hr: HR_ROLES.includes(u.role),
    user_code: u.user_code, email: u.email || null, must_change_password: !!u.must_change_password,
    // 二段階認証の登録待ちは、本人（本部ユーザー）のアカウントと会社の設定で判定する（閲覧先の企業の設定で、閲覧の画面が登録の画面へ移らないように）
    mfa_enabled: !!u.totp_enabled_at, mfa_setup_required: mfaSetupPending(self, self.settings_json), hq_view: u.hq_view || null })
})

// 権限チェックミドルウェア
// 本部ユーザーは、企業が許可した期限付きの閲覧（読み取り専用）のときだけ /admin/* の GET を使える（#293。src/hq-support.ts）
api.use('/admin/*', hqViewAdminGuard)
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
// 本部の操作の履歴（#542）: 本部の書き込み（GET 以外）が成功したら、だれが・いつ・どのパスを操作したかを残す。
// 変更前後の値を残すエンドポイントは hqAuditStmt で記録して hqAudited を立てるので、ここでは重ねて記録しない。
// 送られた内容（パスワードなど）は残さない
api.use('/hq/*', async (c, next) => {
  await next()
  if (c.req.method === 'GET' || c.get('hqAudited') || c.res.status >= 400) return
  try {
    const m = c.req.path.match(/^\/api\/hq\/companies\/(\d+)/)
    await c.env.DB.prepare('INSERT INTO hq_audit_logs (actor_user_id, action, company_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(c.get('user')?.user_id ?? null, `${c.req.method} ${c.req.path.replace(/^\/api/, '')}`.slice(0, 200), m ? Number(m[1]) : null, nowJST()).run()
  } catch (e) {
    console.error('本部の操作の履歴を記録できませんでした', e)
  }
})
// 変更前後の値を残す本部の操作の記録（#542）。更新と同じ batch に入れて使う
function hqAuditStmt(c: any, e: { action: string; company_id?: number | null; target?: string | null; before?: unknown; after?: unknown; reason?: string | null }) {
  c.set('hqAudited', true)
  const j = (v: unknown) => v === undefined || v === null ? null : JSON.stringify(v)
  return (c.env.DB as D1Database).prepare(`INSERT INTO hq_audit_logs (actor_user_id, action, company_id, target, before_json, after_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.get('user')?.user_id ?? null, e.action, e.company_id ?? null, e.target ?? null, j(e.before), j(e.after), e.reason ?? null, nowJST())
}
// スタッフ本人向け API（/api/staff/*）はスタッフのロールだけ（管理者・本部のセッションでは使えない）
api.use('/staff/*', async (c, next) => {
  if (c.get('user')?.role !== 'staff') return c.json({ error: 'forbidden' }, 403)
  return next()
})
// ============ セキュリティ: 二段階認証・ログイン中の端末・ログインの履歴（作業単位 w4-auth-features: #544 #453 #552） ============
const LOGIN_HISTORY_PAGE = 50
// 直近24時間で、この回数以上ログインに失敗した ID を画面の上に出す（総当たり・パスワードの使い回しに気づけるように）
const LOGIN_FAILURE_ALERT = 5
/** 本人の現在のパスワードを確かめる（ログインと同じ失敗回数の制限を使う）。問題があればその応答を返す */
async function confirmPassword(c: any, u: any, password: unknown): Promise<Response | null> {
  const db = c.env.DB as D1Database
  const keys = await loginAttemptKeys(u.role === 'system_admin' ? '' : String(u.company_code || ''), String(u.user_code || ''), c.req.header('CF-Connecting-IP'))
  if (await isLoginLocked(db, keys)) return c.json({ error: `失敗が続いたため、一時的に止めています。${LOGIN_WINDOW_MINUTES}分ほど待ってからお試しください` }, 429)
  const cur = await db.prepare('SELECT password_hash FROM users WHERE user_id = ?').bind(u.user_id).first() as any
  if (!(await verifyPassword(String(password ?? ''), cur?.password_hash))) {
    await recordLoginFailure(db, keys)
    return c.json({ error: '現在のパスワードが正しくありません' }, 400)
  }
  return null
}
/** 二段階認証の登録を消す（本人の解除・管理者や本部による解除） */
function clearMfaStmt(db: D1Database, userId: number) {
  return db.prepare('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, mfa_recovery_codes = NULL WHERE user_id = ?').bind(userId)
}
/** セッションの一覧の表示用（トークンのハッシュは返さない） */
function sessionView(s: any, currentHash?: string) {
  return { created_at: s.created_at, expires_at: s.expires_at, ip: s.ip || null, device: s.user_agent ? deviceLabel(s.user_agent) : '不明な端末（この機能の前のログイン）',
    user_agent: s.user_agent || null, current: !!currentHash && s.token === currentHash, ...(s.company_id !== undefined ? { company_id: s.company_id } : {}) }
}
function eventView(e: any) {
  return { event_id: e.event_id, created_at: e.created_at, event_type: e.event_type, result: e.result, method: e.method, company_code: e.company_code, user_code: e.user_code,
    user_id: e.user_id, user_name: e.user_name ?? null, company_id: e.company_id, company_name: e.company_name ?? null, ip: e.ip, device: e.user_agent ? deviceLabel(e.user_agent) : '-',
    actor_name: e.actor_name ?? null }
}
/** ログインの履歴の絞り込み（result: failed=失敗だけ / 結果の値。user_id。q: ID・接続元の部分一致）と、ページ送り */
function loginHistoryFilter(c: any, where: string[], binds: any[]) {
  const result = c.req.query('result')
  if (result === 'failed') where.push(`e.result != 'success'`)
  else if (result && /^[a-z_]{1,30}$/.test(result)) { where.push('e.result = ?'); binds.push(result) }
  const type = c.req.query('event_type')
  if (type && /^[a-z_]{1,30}$/.test(type)) { where.push('e.event_type = ?'); binds.push(type) }
  const uid = c.req.query('user_id')
  if (uid && /^\d+$/.test(uid)) { where.push('e.user_id = ?'); binds.push(Number(uid)) }
  const q = String(c.req.query('q') || '').trim().slice(0, 50)
  if (q) { where.push(`(e.user_code LIKE ? ESCAPE '\\' OR e.ip LIKE ? ESCAPE '\\' OR us.name LIKE ? ESCAPE '\\')`); const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'; binds.push(like, like, like) }
  const page = Math.max(1, Math.min(1000, Number(c.req.query('page')) || 1))
  return { page, offset: (page - 1) * LOGIN_HISTORY_PAGE }
}
async function loadLoginHistory(c: any, where: string[], binds: any[]) {
  const { page, offset } = loginHistoryFilter(c, where, binds)
  const rows = (await c.env.DB.prepare(`SELECT e.*, us.name AS user_name, co.company_name, ac.name AS actor_name
    FROM login_events e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN companies co ON co.company_id = e.company_id
    LEFT JOIN users ac ON ac.user_id = e.actor_user_id
    WHERE ${where.join(' AND ') || '1=1'} ORDER BY e.event_id DESC LIMIT ? OFFSET ?`).bind(...binds, LOGIN_HISTORY_PAGE + 1, offset).all()).results as any[]
  return { events: rows.slice(0, LOGIN_HISTORY_PAGE).map(eventView), page, has_more: rows.length > LOGIN_HISTORY_PAGE }
}
/** 直近24時間に失敗が続いている ID（会社で絞るときは companyId） */
async function loginFailureAlerts(db: D1Database, companyId: number | null) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  return (await db.prepare(`SELECT e.company_id, MAX(co.company_name) AS company_name, e.user_code, MAX(us.name) AS user_name, COUNT(*) AS failures, MAX(e.created_at) AS last_at,
      COUNT(DISTINCT e.ip) AS ip_count
    FROM login_events e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN companies co ON co.company_id = e.company_id
    WHERE e.created_at > ? AND e.result IN ('bad_password', 'mfa_failed', 'locked') ${companyId != null ? 'AND e.company_id = ?' : ''}
    GROUP BY e.company_id, LOWER(e.user_code) HAVING COUNT(*) >= ? ORDER BY failures DESC LIMIT 20`)
    .bind(since, ...(companyId != null ? [companyId] : []), LOGIN_FAILURE_ALERT).all()).results
}
/** 接続元の制限・二段階認証の必須の設定を検証して保存する（会社管理者と本部で共用） */
async function saveSecuritySettings(c: any, companyId: number, b: any) {
  const u = c.get('user')
  const v: { mfa_required?: boolean; ip_allowlist?: string[] } = {}
  if (b.mfa_required !== undefined) {
    if (typeof b.mfa_required !== 'boolean') return c.json({ error: '不正なパラメータです' }, 400)
    // 自分が登録していないまま必須にすると、自分も含めて使えなくなるため先に登録してもらう
    if (b.mfa_required && !u.totp_enabled_at) return c.json({ error: '必須にする前に、ご自身の二段階認証を登録してください' }, 400)
    v.mfa_required = b.mfa_required
  }
  if (b.ip_allowlist !== undefined) {
    const r = normalizeIpList(b.ip_allowlist)
    if ('error' in r) return c.json({ error: r.error }, 400)
    const ip = c.req.header('CF-Connecting-IP') || ''
    // 今の接続元を含まない一覧にすると、保存した直後にこの画面も使えなくなるため止める
    if (r.list.length && !ipInList(ip, r.list)) return c.json({ error: `今の接続元（${ip || '不明'}）が含まれていません。今の接続元を含めて保存してください` }, 400)
    v.ip_allowlist = r.list
  }
  if (v.mfa_required === undefined && v.ip_allowlist === undefined) return c.json({ ok: true, changed: false })
  await saveSecuritySettingsStmt(c.env.DB, companyId, v).run()
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(companyId).first() as any
  return c.json({ ok: true, changed: true, ...securitySettings(row?.settings_json) })
}
/** 有効なセッション（同じ人のほかの会社の行の分も含む） */
async function personSessions(db: D1Database, userId: number) {
  return (await db.prepare(`SELECT token, user_id, company_id, created_at, expires_at, ip, user_agent FROM sessions WHERE ${PERSON_SESSION_WHERE} AND expires_at > ? ORDER BY created_at DESC`)
    .bind(userId, userId, new Date().toISOString()).all()).results as any[]
}
async function revokePersonSessions(db: D1Database, userId: number): Promise<number> {
  const r = await db.prepare(`DELETE FROM sessions WHERE ${PERSON_SESSION_WHERE}`).bind(userId, userId).run()
  return r.meta.changes || 0
}

// ---------- 自分の二段階認証（本部・管理画面のアカウント） ----------
api.get('/auth/mfa', (c) => {
  const u = c.get('user')
  return c.json({ available: canUseMfa(u.role), enabled: !!u.totp_enabled_at, enabled_at: u.totp_enabled_at || null,
    required: canUseMfa(u.role) && securitySettings(u.settings_json).mfa_required, setup_required: mfaSetupPending(u, u.settings_json),
    recovery_codes_left: recoveryCodesLeft(u.mfa_recovery_codes) })
})
// 登録の開始: 秘密鍵を作り、認証アプリに登録する URI（QR コード）を返す。コードを確かめるまでは有効にしない
api.post('/auth/mfa/setup', async (c) => {
  const u = c.get('user')
  if (!canUseMfa(u.role)) return c.json({ error: '二段階認証は管理画面・本部のアカウントで使えます' }, 403)
  if (u.totp_enabled_at) return c.json({ error: 'すでに登録しています。登録し直すときは、先に解除してください' }, 409)
  const secret = newTotpSecret()
  await c.env.DB.prepare('UPDATE users SET totp_pending_secret = ? WHERE user_id = ?').bind(secret, u.user_id).run()
  const account = u.role === 'system_admin' ? `本部/${u.user_code}` : `${u.company_code}/${u.user_code}`
  return c.json({ ok: true, secret, uri: totpUri(secret, account) })
})
// 登録の完了: 認証アプリの6桁と現在のパスワードを確かめて有効にし、予備コードを一度だけ返す
api.post('/auth/mfa/enable', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!canUseMfa(u.role)) return c.json({ error: '二段階認証は管理画面・本部のアカウントで使えます' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const row = await db.prepare('SELECT totp_pending_secret, totp_enabled_at FROM users WHERE user_id = ?').bind(u.user_id).first() as any
  if (row?.totp_enabled_at) return c.json({ error: 'すでに登録しています' }, 409)
  if (!row?.totp_pending_secret) return c.json({ error: '登録の手続きが見つかりません。最初からやり直してください' }, 400)
  const bad = await confirmPassword(c, u, b.password)
  if (bad) return bad
  const step = await verifyTotp(row.totp_pending_secret, b.code, null)
  if (step === null) return c.json({ error: '確認コードが正しくありません。認証アプリに表示されている最新の6桁を入力してください（端末の時刻が合っているかもお確かめください）' }, 400)
  const rc = await newRecoveryCodes()
  const r = await db.prepare(`UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = ?, totp_last_step = ?, mfa_recovery_codes = ?
    WHERE user_id = ? AND totp_pending_secret = ? AND totp_enabled_at IS NULL`).bind(new Date().toISOString(), step, rc.stored, u.user_id, row.totp_pending_secret).run()
  if (!r.meta.changes) return c.json({ error: '登録の手続きが変わりました。画面を読み直して、やり直してください' }, 409)
  return c.json({ ok: true, recovery_codes: rc.codes })
})
// 解除: 現在のパスワードと、認証アプリのコード（または予備コード）を確かめる。必須の設定のときは解除できない
api.post('/auth/mfa/disable', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.totp_enabled_at) return c.json({ ok: true, changed: false })
  if (securitySettings(u.settings_json).mfa_required) return c.json({ error: '会社の設定で二段階認証が必須のため、解除できません。端末を替えたときは、会社管理者（本部の方は別の本部ユーザー）に解除を依頼してください' }, 409)
  const b = await c.req.json().catch(() => ({} as any))
  const bad = await confirmPassword(c, u, b.password)
  if (bad) return bad
  const okCode = (await verifyTotp(u.totp_secret, b.code, u.totp_last_step)) !== null || (await consumeRecoveryCode(u.mfa_recovery_codes, b.code)) !== null
  if (!okCode) {
    // ログイン中の画面からコードを総当たりして解除できないよう、ログインと同じ失敗回数に数える
    await recordLoginFailure(db, await loginAttemptKeys(u.role === 'system_admin' ? '' : String(u.company_code || ''), String(u.user_code || ''), c.req.header('CF-Connecting-IP')))
    return c.json({ error: '確認コードが正しくありません' }, 400)
  }
  await clearMfaStmt(db, u.user_id).run()
  return c.json({ ok: true, changed: true })
})
// 予備コードを作り直す（以前の予備コードは使えなくなる）
api.post('/auth/mfa/recovery-codes', async (c) => {
  const u = c.get('user')
  if (!u.totp_enabled_at) return c.json({ error: '二段階認証を登録していません' }, 400)
  const b = await c.req.json().catch(() => ({} as any))
  const bad = await confirmPassword(c, u, b.password)
  if (bad) return bad
  const rc = await newRecoveryCodes()
  await c.env.DB.prepare('UPDATE users SET mfa_recovery_codes = ? WHERE user_id = ?').bind(rc.stored, u.user_id).run()
  return c.json({ ok: true, recovery_codes: rc.codes })
})

// ---------- 自分のログイン中の端末と、すべての端末からのログアウト（#453。全ロール） ----------
api.get('/auth/sessions', async (c) => {
  const u = c.get('user')
  const token = getCookie(c, SESSION_COOKIE)
  const current = token ? await hashToken(token) : ''
  return c.json({ sessions: (await personSessions(c.env.DB, u.user_id)).map(s => sessionView({ ...s, company_id: undefined }, current)) })
})
api.post('/auth/logout-all', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const n = await revokePersonSessions(db, u.user_id)
  await recordLoginEvent(db, c, { company_id: u.company_id, user_id: u.user_id, company_code: u.role === 'system_admin' ? '' : u.company_code, user_code: u.user_code,
    event_type: 'logout_all', result: 'success' })
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: new URL(c.req.url).protocol === 'https:' })
  return c.json({ ok: true, revoked: n })
})

// ---------- 会社の管理画面（/api/admin/security・/api/admin/login-history・/api/admin/staff/:id/sessions） ----------
// 設定・管理者アカウントの二段階認証・ログインの履歴は会社管理者だけ。スタッフのログイン中の端末は管理系のロール全員（スマホの紛失にその場で対応できるように）
const securityAdminOnly = async (c: any, next: any) => {
  if (c.get('user')?.role !== 'company_admin') return c.json({ error: 'この操作は会社管理者だけが行えます' }, 403)
  return next()
}
api.use('/admin/security/settings', securityAdminOnly)
api.use('/admin/security/users', securityAdminOnly)
api.use('/admin/security/users/*', securityAdminOnly)
api.use('/admin/login-history', securityAdminOnly)

api.get('/admin/security/settings', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ ...securitySettings(row?.settings_json), current_ip: c.req.header('CF-Connecting-IP') || null, my_mfa_enabled: !!u.totp_enabled_at })
})
api.put('/admin/security/settings', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  return saveSecuritySettings(c, c.get('user').company_id, b)
})
// 管理者アカウントの二段階認証の状態とログイン中の端末の数
api.get('/admin/security/users', async (c) => {
  const u = c.get('user')
  const users = (await c.env.DB.prepare(`SELECT us.user_id, us.user_code, us.name, us.role, us.status, us.last_login_at, us.totp_enabled_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = us.user_id AND s.expires_at > ?) AS session_count
    FROM users us WHERE us.company_id = ? AND us.role IN ('company_admin','sales_manager','field_manager','office_staff')
    ORDER BY CASE us.status WHEN 'active' THEN 0 ELSE 1 END, us.user_id`).bind(new Date().toISOString(), u.company_id).all()).results
  return c.json({ users, me: u.user_id })
})
async function ownAdminAccount(c: any): Promise<any | null> {
  const id = c.req.param('id')
  if (!/^\d+$/.test(String(id))) return null
  return c.env.DB.prepare(`SELECT user_id, user_code, name, role FROM users WHERE user_id = ? AND company_id = ? AND role IN ('company_admin','sales_manager','field_manager','office_staff')`)
    .bind(Number(id), c.get('user').company_id).first()
}
// 端末を失くした管理者の二段階認証を解除する（次のログインはパスワードだけ。必須の設定なら登録し直しになる）
api.delete('/admin/security/users/:id/mfa', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await ownAdminAccount(c)
  if (!t) return c.json({ error: 'アカウントが見つかりません' }, 404)
  if (t.user_id === u.user_id) return c.json({ error: '自分の二段階認証は、この画面の「自分の二段階認証」から解除してください' }, 400)
  await db.batch([clearMfaStmt(db, t.user_id), db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(t.user_id)])
  return c.json({ ok: true })
})
api.delete('/admin/security/users/:id/sessions', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await ownAdminAccount(c)
  if (!t) return c.json({ error: 'アカウントが見つかりません' }, 404)
  if (t.user_id === u.user_id) return c.json({ error: '自分のログインは「すべての端末からログアウト」で終了してください' }, 400)
  const n = await revokePersonSessions(db, t.user_id)
  await recordLoginEvent(db, c, { company_id: u.company_id, user_id: t.user_id, company_code: u.company_code, user_code: t.user_code, event_type: 'forced_logout', result: 'success', actor_user_id: u.user_id })
  return c.json({ ok: true, revoked: n })
})
// 自社のログインの履歴（自社の会社コードで試みられた失敗を含む）と、失敗が続いている ID
api.get('/admin/login-history', async (c) => {
  const u = c.get('user')
  const where = ['e.company_id = ?']; const binds: any[] = [u.company_id]
  const r = await loadLoginHistory(c, where, binds)
  const alerts = r.page === 1 ? await loginFailureAlerts(c.env.DB, u.company_id) : []
  return c.json({ ...r, alerts, alert_threshold: LOGIN_FAILURE_ALERT })
})
// ログインを終了させるスタッフを選ぶ: 名前・スタッフ番号で探す。空欄なら、ログイン中の端末があるスタッフを最近のログイン順に出す
api.get('/admin/security/staff', async (c) => {
  const u = c.get('user')
  const q = String(c.req.query('q') || '').normalize('NFKC').trim().slice(0, 50)
  const now = new Date().toISOString()
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
  const rows = (await c.env.DB.prepare(`SELECT * FROM (SELECT sp.staff_id, us.name, us.user_code, us.status, us.last_login_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.expires_at > ? AND (s.user_id = us.user_id
        OR (us.person_id IS NOT NULL AND s.user_id IN (SELECT u2.user_id FROM users u2 WHERE u2.person_id = us.person_id)))) AS session_count
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND us.role = 'staff'
      ${q ? `AND (us.name LIKE ? ESCAPE '\\' OR us.user_code LIKE ? ESCAPE '\\')` : ''})
    ${q ? '' : 'WHERE session_count > 0'}
    ORDER BY session_count > 0 DESC, last_login_at DESC LIMIT 50`).bind(now, u.company_id, ...(q ? [like, like] : [])).all()).results
  return c.json({ staff: rows })
})
async function staffLoginUser(c: any): Promise<any | null> {
  const sp = await ownStaff(c.env.DB, c.get('user').company_id, c.req.param('id'))
  if (!sp) return null
  return c.env.DB.prepare(`SELECT user_id, user_code, name, role FROM users WHERE user_id = ?`).bind(sp.user_id).first()
}
// スタッフのログイン中の端末と直近のログインの履歴（企業を切り替えた他社の画面でのログインも数に含める。会社名は出さない）
api.get('/admin/staff/:id/sessions', async (c) => {
  const u = c.get('user')
  const su = await staffLoginUser(c)
  if (!su) return c.json({ error: 'not found' }, 404)
  const sessions = (await personSessions(c.env.DB, su.user_id)).map(s => ({ ...sessionView(s), company_id: undefined, other_company: s.company_id !== u.company_id }))
  const where = ['e.company_id = ?', 'e.user_id = ?']; const binds: any[] = [u.company_id, su.user_id]
  const history = u.role === 'company_admin' ? (await loadLoginHistory(c, where, binds)).events.slice(0, 20) : []
  return c.json({ staff: { name: su.name, user_code: su.user_code }, sessions, history })
})
// スタッフのログインを強制的に終了する（スマホの紛失・共用端末のログアウト忘れ。同じ人の他社の行のセッションも消す）
api.delete('/admin/staff/:id/sessions', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const su = await staffLoginUser(c)
  if (!su) return c.json({ error: 'not found' }, 404)
  const n = await revokePersonSessions(db, su.user_id)
  await recordLoginEvent(db, c, { company_id: u.company_id, user_id: su.user_id, company_code: u.company_code, user_code: su.user_code, event_type: 'forced_logout', result: 'success', actor_user_id: u.user_id })
  return c.json({ ok: true, revoked: n })
})

// ---------- 本部（/api/hq/security・/api/hq/login-history） ----------
// 本部ユーザーの二段階認証の必須・接続元の制限は、本部専用の企業行の設定に持つ
api.get('/hq/security', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const users = (await c.env.DB.prepare(`SELECT user_id, user_code, name, status, last_login_at, totp_enabled_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = users.user_id AND s.expires_at > ?) AS session_count
    FROM users WHERE company_id = ? AND role = 'system_admin' ORDER BY user_id`).bind(new Date().toISOString(), u.company_id).all()).results
  return c.json({ ...securitySettings(row?.settings_json), current_ip: c.req.header('CF-Connecting-IP') || null, my_mfa_enabled: !!u.totp_enabled_at, users, me: u.user_id })
})
api.put('/hq/security/settings', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  return saveSecuritySettings(c, c.get('user').company_id, b)
})
// 端末を失くした人の二段階認証の解除（会社コード＋ID で指定。会社コードが空欄なら本部ユーザー）。会社管理者が1人で解除できないときの窓口
api.post('/hq/security/reset-mfa', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const companyCode = normalizeLoginCode(b.company_code), userCode = normalizeLoginCode(b.user_code)
  if (!userCode) return c.json({ error: 'ID を入力してください' }, 400)
  const t = await db.prepare(`SELECT us.user_id, us.user_code, us.name, us.role, us.totp_enabled_at, co.company_id, co.company_name FROM users us JOIN companies co ON co.company_id = us.company_id
    WHERE ${companyCode ? 'LOWER(co.company_code) = LOWER(?)' : `co.active_status = ? AND us.role = 'system_admin'`} AND LOWER(us.user_code) = LOWER(?)
      AND us.role IN ('system_admin','company_admin','sales_manager','field_manager','office_staff') LIMIT 2`)
    .bind(companyCode || HQ_COMPANY_STATUS, userCode).all()
  if (t.results.length !== 1) return c.json({ error: '該当するアカウントが見つかりません（管理画面・本部のアカウントだけが対象です）' }, 404)
  const target = t.results[0] as any
  if (target.user_id === u.user_id) return c.json({ error: '自分の二段階認証は「自分の二段階認証」から解除してください' }, 400)
  await db.batch([clearMfaStmt(db, target.user_id), db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.user_id),
    hqAuditStmt(c, { action: 'security.reset_mfa', company_id: target.role === 'system_admin' ? null : target.company_id, target: `${target.user_code} ${target.name}`, before: { mfa_enabled: !!target.totp_enabled_at } })])
  return c.json({ ok: true, name: target.name, company_name: target.company_name, was_enabled: !!target.totp_enabled_at })
})
// 企業の接続元の制限を外す（企業側で設定を誤って管理者が誰も入れなくなったときの窓口）
api.post('/hq/security/clear-ip', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const code = normalizeLoginCode(b.company_code)
  if (!code) return c.json({ error: '会社コードを入力してください' }, 400)
  const co = await c.env.DB.prepare('SELECT company_id, company_name FROM companies WHERE LOWER(company_code) = LOWER(?) LIMIT 1').bind(code).first() as any
  if (!co) return c.json({ error: '会社が見つかりません' }, 404)
  await c.env.DB.batch([saveSecuritySettingsStmt(c.env.DB, co.company_id, { ip_allowlist: [] }),
    hqAuditStmt(c, { action: 'security.clear_ip', company_id: co.company_id, target: co.company_name })])
  return c.json({ ok: true, company_name: co.company_name })
})
api.delete('/hq/security/users/:id/sessions', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const id = c.req.param('id')
  const t = /^\d+$/.test(id) ? await db.prepare(`SELECT user_id, user_code FROM users WHERE user_id = ? AND company_id = ? AND role = 'system_admin'`).bind(Number(id), u.company_id).first() as any : null
  if (!t) return c.json({ error: 'アカウントが見つかりません' }, 404)
  if (t.user_id === u.user_id) return c.json({ error: '自分のログインは「すべての端末からログアウト」で終了してください' }, 400)
  const n = await revokePersonSessions(db, t.user_id)
  await recordLoginEvent(db, c, { company_id: u.company_id, user_id: t.user_id, company_code: '', user_code: t.user_code, event_type: 'forced_logout', result: 'success', actor_user_id: u.user_id })
  return c.json({ ok: true, revoked: n })
})
// 全社のログインの履歴（会社コードの誤りなど、会社が分からない試行も含む）
api.get('/hq/login-history', async (c) => {
  const where: string[] = []; const binds: any[] = []
  const cid = c.req.query('company_id')
  if (cid && /^\d+$/.test(cid)) { where.push('e.company_id = ?'); binds.push(Number(cid)) }
  else if (cid === 'unknown') where.push('e.company_id IS NULL')
  const r = await loadLoginHistory(c, where, binds)
  const alerts = r.page === 1 ? await loginFailureAlerts(c.env.DB, null) : []
  return c.json({ ...r, alerts, alert_threshold: LOGIN_FAILURE_ALERT })
})

// 自分のアカウント（氏名・メール・パスワードの変更）・管理者アカウント・本部からの管理者の管理（src/accounts.ts）
api.route('/auth', authAccountApi)
api.route('/admin', adminUsersApi)
api.route('/hq', hqUsersApi)
// スタッフマスタ（企業間連携・4ルート作成）: /admin/* の権限ミドルウェア適用後に登録（src/roster.ts）
api.route('/admin/roster', rosterApi)
// スタッフマスタ・従業員の CSV 一括登録（#430。src/roster-import.ts）
api.route('/admin/roster/import', rosterImportApi)
api.route('/staff/me', staffSelfApi)
// スタッフ本人の手続き（登録情報の変更申請・書類の提出・休暇の申請）と、管理者の承認（#272 #288 #289 #297。src/staff-self-service.ts）
api.route('/staff/self', staffSelfServiceApi)
api.route('/admin/staff-requests', staffRequestsAdminApi((c, sid, changes) => applyApprovedProfileChange(c, String(sid), changes)))
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
// メールの送信記録・送信を止めているアドレス（本部。#438 #541）
api.route('/hq', mailHqApi)
// 伴走支援の依頼・本部からのお知らせ・管理画面の閲覧（#179 #516 #293。src/hq-support.ts）
api.route('/admin', hqSupportAdminApi)
api.route('/hq', hqSupportHqApi)
api.route('/staff', notificationsStaffApi)
// 案件掲示板（企業間の案件掲載・案件チャット・人材提案）。/admin/* 配下のみ（src/board.ts）
api.route('/admin/board', boardApi)
// スタッフアプリからの応募（src/recruit.ts）
api.route('/staff/recruit', recruitStaffApi)
// スタッフの勤務時間・支払額の確認と、交通費・延長の申請（src/staff-pay.ts。w5-staff-pay-features）
api.route('/staff', staffPayStaffApi)
api.route('/admin', staffPayAdminApi)
// 出勤可能日の提出・一覧（#171）と、シフトのカレンダー追加（#301）（src/staff-schedule.ts）
api.route('/staff', scheduleStaffApi)
api.route('/admin', scheduleAdminApi)

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
  p.default_break_minutes AS project_break_minutes, p.site_contact_name, p.site_contact_phone`
const STAFF_SHIFT_PLACE_JOINS = `LEFT JOIN sites si ON si.site_id = s.site_id AND si.company_id = s.company_id
    LEFT JOIN shift_slots sl ON sl.slot_id = s.slot_id AND sl.company_id = s.company_id`

// 次回の稼働（#278）: 今日より後の最初の稼働日の勤務（確定・代打。同一人物の全所属企業）。同じ日に複数あれば開始時刻順に HOME_NEXT_MAX 件まで。
// 前日確認（#176）: シフトの会社が前日確認を使っていれば、明日のシフトに確認の状態を付ける（確認の後にシフトが変わったものは未確認）
const HOME_NEXT_MAX = 5
async function homeLoadNextShifts(db: D1Database, u: any, personRows: any[], personIds: number[], today: string) {
  const inIds = personIds.map(() => '?').join(','), inSt = WORKING_SHIFT_STATUSES.map(() => '?').join(',')
  const rows = (await db.prepare(`
    SELECT s.*, p.project_name, co.company_name AS shift_company_name, ${STAFF_SHIFT_PLACE_COLUMNS}
    FROM shifts s JOIN projects p ON s.project_id = p.project_id JOIN companies co ON co.company_id = s.company_id
    ${STAFF_SHIFT_PLACE_JOINS}
    WHERE s.staff_id IN (${inIds}) AND s.status IN (${inSt})
      AND s.work_date = (SELECT MIN(work_date) FROM shifts WHERE staff_id IN (${inIds}) AND status IN (${inSt}) AND work_date > ?)
    ORDER BY s.start_time, s.shift_id LIMIT ${HOME_NEXT_MAX}`).bind(...personIds, ...WORKING_SHIFT_STATUSES, ...personIds, ...WORKING_SHIFT_STATUSES, today).all()).results as any[]
  const tomorrow = addDays(today, 1)
  return rows.map(s => {
    const owner = personRows.find(r => r.staff_id === s.staff_id)
    const cfg = dayBeforeSettings(owner ? owner.settings_json : u.settings_json)
    const st = dayBeforeState(s)
    return {
      ...staffShiftView({ ...s, company_name: s.shift_company_name, other_company: s.company_id !== u.company_id }),
      day_before: cfg.enabled && s.work_date === tomorrow ? { deadline: cfg.deadline, confirmed_at: st.confirmed_at, changed: st.changed } : null,
    }
  })
}

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
  // 遅延・位置不明（status・late_minutes）、早退の分数、打刻の方法（代理入力の区別・押し間違いの取消の可否）もボタンに出す（#347 #327 #323）
  // 電波がない場所で押して後から送った報告は、押した時刻で記録したこと（device_time）と受け取った時刻も出す（#427）
  const rows = (await db.prepare(`SELECT shift_id, report_type, reported_at, status, late_minutes, early_leave_minutes, COALESCE(entry_method, 'app') AS entry_method, corrected_by_correction_id,
      time_source, received_at
    FROM attendance_reports WHERE shift_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results as any[]
  for (const r of rows) {
    const o = out.get(r.shift_id)
    if (o) o.reports[r.report_type] = { report_type: r.report_type, reported_at: r.reported_at, status: r.status, late_minutes: r.late_minutes, early_leave_minutes: r.early_leave_minutes,
      entry_method: r.entry_method, corrected: r.corrected_by_correction_id != null,
      ...deviceTimeMark(r) }
  }
  const pend = (await db.prepare(`SELECT shift_id, report_type, requested_at FROM attendance_corrections WHERE shift_id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`).bind(...ids).all()).results as any[]
  for (const r of pend) { const o = out.get(r.shift_id); if (o) o.pending_corrections[r.report_type] = r.requested_at }
  return out
}

// 日報: 提出済みのシフト。shift_id で照合する（日報はシフトごとに1件。shift_id の無い古い日報だけは稼働日・案件で照合する。src/lib/daily-report.ts）
// 値は管理者が確認した日時（未確認・確認の後に直した日報は null。#371）
async function homeLoadDailyReports(db: D1Database, shifts: any[]): Promise<Map<number, { checked_at: string | null }>> {
  const done = new Map<number, { checked_at: string | null }>()
  if (!shifts.length) return done
  const ids = shifts.map(s => s.shift_id as number)
  const staffIds = [...new Set(shifts.map(s => s.staff_id as number))]
  const dates = [...new Set(shifts.map(s => s.work_date as string))]
  const rows = (await db.prepare(`SELECT shift_id, staff_id, work_date, project_id, manager_checked, manager_checked_at FROM daily_reports
    WHERE shift_id IN (${ids.map(() => '?').join(',')}) OR (+shift_id IS NULL AND staff_id IN (${staffIds.map(() => '?').join(',')}) AND work_date IN (${dates.map(() => '?').join(',')}))`)
    .bind(...ids, ...staffIds, ...dates).all()).results as any[]
  for (const s of shifts) {
    const d = rows.find(d => d.shift_id === s.shift_id || (d.shift_id == null && d.staff_id === s.staff_id && d.work_date === s.work_date && d.project_id === s.project_id))
    if (d) done.set(s.shift_id, { checked_at: d.manager_checked ? (d.manager_checked_at || '') : null })
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

// お知らせ。配信対象の判定はお知らせ一覧と同じ（#370 #227 #335。LIKE での走査はしない）
//  ・未読の緊急・重要・確認必須を先頭に固定し（#384 #191。最大 HOME_NOTICE_PINNED_MAX 件）、残りを新しい順に足して少なくとも HOME_NOTICE_PREVIEW 件にする
//  ・未読の件数は最新の数件ではなく、すべてのお知らせで数える（#325）。切り替えていない所属企業の未読も返す（#203）
const HOME_NOTICE_PREVIEW = 3
const HOME_NOTICE_PINNED_MAX = 5
async function homeLoadNotices(db: D1Database, u: any, personRows: any[]) {
  const others = personRows.filter(r => r.user_id && r.company_id !== u.company_id)
  const [unread, recent, counts] = await Promise.all([
    loadStaffNotices(db, u.user_id, { unreadOnly: true, order: 'unread_first', limit: 30 }),
    loadStaffNotices(db, u.user_id, { order: 'recent', limit: HOME_NOTICE_PREVIEW }),
    countUnreadNotices(db, [u.user_id, ...others.map(r => r.user_id)]),
  ])
  const rank = (n: any) => n.importance === 'urgent' ? 0 : n.read_required ? 1 : 2
  const pinned = unread.filter(n => n.importance === 'urgent' || n.importance === 'important' || n.read_required)
    .sort((a, b) => rank(a) - rank(b) || String(b.published_at).localeCompare(String(a.published_at)) || b.notice_id - a.notice_id)
    .slice(0, HOME_NOTICE_PINNED_MAX)
  const pinnedIds = new Set(pinned.map(n => n.notice_id))
  const list = [...pinned.map(n => ({ ...n, pinned: 1 })), ...recent.filter(n => !pinnedIds.has(n.notice_id)).map(n => ({ ...n, pinned: 0 }))]
    .slice(0, Math.max(HOME_NOTICE_PREVIEW, pinned.length))
  return {
    // ホームでは本文を使わないので返さない
    notices: list.map(n => ({ notice_id: n.notice_id, title: n.title, importance: n.importance, read_required: n.read_required, published_at: n.published_at,
      target_type: n.target_type, project_names: n.project_names, is_read: n.is_read, no_confirm: n.no_confirm, pinned: n.pinned })),
    unread_count: counts.get(u.user_id) || 0,
    other_companies: others.map(r => ({ company_id: r.company_id, company_name: r.company_name, unread: counts.get(r.user_id) || 0 })).filter(r => r.unread > 0),
  }
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
      attendance_done: !next, daily_report_done: dailyDone.has(s.shift_id), daily_report_checked_at: dailyDone.get(s.shift_id)?.checked_at ?? null,
      tentative: isTentativeShift(s.status) }
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

  const noticeInfo = await homeLoadNotices(db, u, personRows)
  const replied = await homeLoadConsultations(db, u)
  const nextShifts = await homeLoadNextShifts(db, u, personRows, personIds, today)

  return c.json({
    today, shift: staffShiftView(shift), carryover: !!picked?.carryover,
    reports: picked ? picked.reports : {}, daily_report_done: picked ? picked.daily_report_done : false,
    // 日報を管理者が確認した日時（未確認は null。#371）と、今受け付けている報告の種類（日をまたいだ後の入店などをホームで押せるように。#134）
    daily_report_checked_at: picked ? picked.daily_report_checked_at : null,
    report_window_open: picked ? Object.fromEntries(picked.required_attendance.map((t: string) => [t, isWithin(reportableWindow(picked, t), now)])) : {},
    // 承認待ちの打刻修正申請がある報告（その報告はホームから押せない）と、希望（仮）のシフト（未確定。報告の前に確認を出す）
    pending_corrections: picked ? picked.pending_corrections : {}, tentative: !!picked?.tentative,
    required_attendance: picked ? picked.required_attendance : [...REPORT_TYPES],
    daily_report_required: picked ? picked.daily_report_required : true, notices: noticeInfo.notices,
    // 未読のお知らせの件数（すべてのお知らせで数える #325）と、切り替えていない所属企業の未読（#203）
    notice_unread_count: noticeInfo.unread_count, notice_other_companies: noticeInfo.other_companies,
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
    // 次回（明日以降）の稼働と、明日のシフトの前日確認の状態（#278 #176）
    next_shifts: nextShifts,
  })
})

// 前日確認（#176）: 明日のシフトを本人が『確認しました』にする。shift_ids で同じ日の複数のシフトをまとめて確認できる。
// シフトの会社が前日確認を使っていて、稼働日が明日の確定・代打のシフトだけ。確認したときのシフトの内容を残す（後で変わったら未確認に戻る）
const DAY_BEFORE_MAX_SHIFTS = 10
api.post('/staff/day-before-confirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const ids = [...new Set<number>((Array.isArray(b.shift_ids) ? b.shift_ids : [b.shift_id]).map(Number))].filter(n => Number.isInteger(n) && n > 0)
  if (!ids.length || ids.length > DAY_BEFORE_MAX_SHIFTS) return c.json({ error: 'シフトを指定してください' }, 400)
  const personRows = await personStaffRows(db, u)
  if (!personRows.length) return c.json({ error: 'シフトが見つかりません' }, 404)
  const staffIds = personRows.map(r => r.staff_id)
  const rows = (await db.prepare(`SELECT shift_id, staff_id, company_id, project_id, work_date, start_time, end_time, status, site_id, location FROM shifts
    WHERE shift_id IN (${ids.map(() => '?').join(',')}) AND staff_id IN (${staffIds.map(() => '?').join(',')})`).bind(...ids, ...staffIds).all()).results as any[]
  if (rows.length !== ids.length) return c.json({ error: 'シフトが見つかりません' }, 404)
  const tomorrow = addDays(todayJST(), 1)
  for (const s of rows) {
    const owner = personRows.find(r => r.staff_id === s.staff_id)
    if (!owner || owner.company_id !== s.company_id) return c.json({ error: 'シフトが見つかりません' }, 404)
    if (!dayBeforeSettings(owner.settings_json).enabled) return c.json({ error: 'このシフトの会社では、前日確認を使っていません' }, 400)
    if (s.work_date !== tomorrow) return c.json({ error: '前日確認は、稼働日の前日にできます。画面を読み直してください' }, 400)
    if (!(WORKING_SHIFT_STATUSES as readonly string[]).includes(s.status)) return c.json({ error: '確定していないシフトは確認できません' }, 400)
  }
  const now = nowJST()
  // 読んだ後にシフトが変わっていたら記録しない（確認したときの内容と合わなくなるため）。確認済みのものは最初の確認の日時を残す
  const res = await db.batch(rows.map(s => db.prepare(`UPDATE shifts SET
      day_before_confirmed_at = CASE WHEN day_before_confirmed_at IS NOT NULL AND day_before_confirmed_key = ?1 THEN day_before_confirmed_at ELSE ?2 END,
      day_before_confirmed_by = CASE WHEN day_before_confirmed_at IS NOT NULL AND day_before_confirmed_key = ?1 THEN day_before_confirmed_by ELSE NULL END,
      day_before_confirmed_key = ?1
    WHERE shift_id = ?3 AND staff_id = ?4 AND project_id = ?5 AND work_date = ?6 AND start_time = ?7 AND end_time = ?8 AND site_id IS ?9 AND location IS ?10 AND status IN ('confirmed', 'substitute')`)
    .bind(dayBeforeKey(s), now, s.shift_id, s.staff_id, s.project_id, s.work_date, s.start_time, s.end_time, s.site_id ?? null, s.location ?? null)))
  if (res.some(r => !r.meta.changes)) return c.json({ error: 'シフトが変更されました。画面を読み直してください' }, 409)
  return c.json({ ok: true, shift_ids: ids, confirmed_at: now })
})

// 前日確認を管理者が記録する（電話などで本人に確かめたとき。#176）。ダッシュボードの明日のシフトの一覧から使う
api.post('/admin/shifts/:id/day-before-confirm', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!dayBeforeSettings(u.settings_json).enabled) return c.json({ error: '前日確認を使っていません（ダッシュボードの設定から使えます）' }, 400)
  const s = await ownShift(db, u.company_id, c.req.param('id')) as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (!(WORKING_SHIFT_STATUSES as readonly string[]).includes(s.status)) return c.json({ error: '確定していないシフトは確認済みにできません' }, 400)
  if (s.work_date < todayJST()) return c.json({ error: '過ぎたシフトは確認済みにできません' }, 400)
  if (dayBeforeState(s).confirmed_at) return c.json({ ok: true, confirmed_at: s.day_before_confirmed_at, already: true })
  const now = nowJST()
  const r = await db.prepare(`UPDATE shifts SET day_before_confirmed_at = ?, day_before_confirmed_key = ?, day_before_confirmed_by = ?
    WHERE shift_id = ? AND company_id = ? AND staff_id = ? AND project_id = ? AND work_date = ? AND start_time = ? AND end_time = ? AND site_id IS ? AND location IS ?`)
    .bind(now, dayBeforeKey(s), u.user_id, s.shift_id, u.company_id, s.staff_id, s.project_id, s.work_date, s.start_time, s.end_time, s.site_id ?? null, s.location ?? null).run()
  if (!r.meta.changes) return c.json({ error: 'シフトが変更されました。画面を読み直してください' }, 409)
  return c.json({ ok: true, confirmed_at: now, confirmed_by_name: u.name })
})

// ---------- 勤怠報告の『休憩なし』と、押し間違いの取消（#324 #323） ----------
// 休憩なし: 休憩入・休憩出を同じ時刻で記録する（実績の休憩は0分になる。settlement.ts の actualFromReports）。
//   理由は、シフトの所有企業の管理者へのアプリ内通知（kind=attendance_no_break）に残す
// 取消: 本人がアプリで送った報告を、送ってから ATTENDANCE_WITHDRAW_MINUTES 分以内で、後の報告がなければ取り消せる。
//   代理入力・報告用URL・打刻修正で記録した報告は取り消せない（打刻修正の申請で直す）。
//   取り消した記録は、本人あての既読の通知（kind=attendance_withdrawn。related_id = shift_id）として残し、管理画面のシフト操作に出す
const ATTENDANCE_WITHDRAW_MINUTES = 5
const ATTENDANCE_WITHDRAWN_KIND = 'attendance_withdrawn'
const ATTENDANCE_NO_BREAK_KIND = 'attendance_no_break'
const NO_BREAK_REASON_MAX = 200
const fmtMd = (d: string) => { const m = String(d || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${Number(m[1])}/${Number(m[2])}` : '' }
const fmtHm = (at: string) => (String(at || '').match(/ (\d{2}:\d{2})/) || [])[1] || ''
const fmtMdHm = (at: string) => `${fmtMd(at)} ${fmtHm(at)}`

api.post('/staff/attendance/no-break', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (!reason) return c.json({ error: '休憩を取らなかった理由を選んでください' }, 400)
  if (reason.length > NO_BREAK_REASON_MAX) return c.json({ error: `理由は${NO_BREAK_REASON_MAX}文字以内で入力してください` }, 400)
  const resolved = await resolvePersonShift(c, b.shift_id)
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff: owner } = resolved
  const now = nowJST()
  const modes = (await modesForShifts(db, [shift.shift_id])).get(shift.shift_id)
  const required = modes ? modes.required_attendance : [...REPORT_TYPES]
  const state = await loadReportState(db, shift.shift_id)
  // シフトの状態・受付の時間帯（休憩入・休憩出は同じ）・休憩入と休憩出の両方を押せるか
  const ng = checkStaffReport(shift, 'break_start', now, required, state) || checkNoBreak(required, state.done, state.pending)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  const at = reportedAtMinute(now)
  const ins = (t: string) => db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, device_info, status) VALUES (?, ?, ?, ?, ?, ?, 'normal')`)
    .bind(owner.company_id, owner.staff_id, shift.shift_id, t, at, c.req.header('user-agent') || '')
  try { await db.batch([ins('break_start'), ins('break_end')]) } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'すでに報告済みです' }, 409)
    throw e
  }
  await syncActualFromReports(db, owner.company_id, Number(shift.shift_id)).catch(() => {})
  // 管理者に理由を知らせる（失敗しても報告は取り消さない）
  try {
    const p = await db.prepare('SELECT project_name FROM projects WHERE project_id = ?').bind(shift.project_id).first() as any
    const admins = ((await db.prepare(`SELECT user_id FROM users WHERE company_id = ? AND status = 'active' AND role IN (${ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(owner.company_id, ...ADMIN_ROLES).all()).results as any[]).map(a => a.user_id as number)
    const title = `休憩なしの申告: ${u.name || ''} ${fmtMd(shift.work_date)} ${p?.project_name || ''}`
    const body = `理由: ${reason}\n休憩入・休憩出を ${fmtMdHm(at)} で記録し、休憩0分として実績に反映しました`
    const stmts = chunk(admins, 10).map(ids => db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES ${ids.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...ids.flatMap(id => [owner.company_id, id, ATTENDANCE_NO_BREAK_KIND, title, body, '/admin#shifts', shift.shift_id, now])))
    if (stmts.length) await db.batch(stmts)
  } catch (e) { console.log(`no-break notify failed: shift=${shift.shift_id}`) }
  return c.json({ ok: true, reported_at: at })
})

api.post('/staff/attendance/withdraw', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  if (!REPORT_TYPES.includes(b.report_type)) return c.json({ error: '不正な報告種別です' }, 400)
  // 休憩なし（休憩入・休憩出が同じ時刻）は、まとめて取り消す
  const types: string[] = b.no_break ? ['break_start', 'break_end'] : [b.report_type]
  const resolved = await resolvePersonShift(c, b.shift_id)
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff: owner } = resolved
  const ng = checkShiftAcceptsReport(shift)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  const rows = ((await db.prepare(`SELECT attendance_id, report_type, reported_at, photo_key, COALESCE(entry_method, 'app') AS entry_method, corrected_by_correction_id, time_source, received_at
    FROM attendance_reports WHERE shift_id = ? AND report_type IN (${types.map(() => '?').join(',')})`).bind(shift.shift_id, ...types).all()).results as any[])
  if (rows.length !== types.length) return c.json({ error: '取り消す報告が見つかりません。画面を読み直してください' }, 404)
  if (b.no_break && rows[0].reported_at !== rows[1].reported_at) return c.json({ error: '休憩なしで記録した報告ではありません' }, 400)
  const label = types.map(t => REPORT_LABEL[t]).join('・')
  if (rows.some(r => r.entry_method !== 'app' || r.corrected_by_correction_id != null)) {
    return c.json({ error: '管理者の代理入力・報告用URL・打刻修正で記録した報告は取り消せません。時刻が違う場合は、打刻履歴から修正を申請してください' }, 409)
  }
  const now = nowJST()
  // 取り消せる時間は送った時刻から数える。押した時刻（端末時刻）で記録した報告は、受け取った時刻から数える（#427。後から送った直後でも取り消せる）
  const sentAt = (r: any) => String(r.time_source === 'device' && r.received_at ? r.received_at : r.reported_at).slice(0, 19)
  if (rows.some(r => now > addMinutes(sentAt(r), ATTENDANCE_WITHDRAW_MINUTES))) {
    return c.json({ error: `報告から${ATTENDANCE_WITHDRAW_MINUTES}分を過ぎたため取り消せません。時刻が違う場合は、打刻履歴から修正を申請してください` }, 409)
  }
  const state = await loadReportState(db, shift.shift_id)
  const last = Math.max(...types.map(t => REPORT_TYPES.indexOf(t as any)))
  const later = REPORT_TYPES.find((t, j) => j > last && state.done.has(t))
  if (later) return c.json({ error: `${REPORT_LABEL[later]}を報告済みのため、${label}は取り消せません。打刻履歴から修正を申請してください` }, 409)
  if (types.some(t => state.pending.has(t))) return c.json({ error: `${label}は打刻修正を申請中のため取り消せません` }, 409)
  // 取り消しと記録を1つの batch で行う。記録は、報告が消えたときだけ残す（同時に状態が変わった場合は何も変えない）
  const ids = rows.map(r => r.attendance_id as number)
  const sent = rows.map(r => fmtHm(r.reported_at)).filter((v, i, a) => a.indexOf(v) === i).join('・')
  const title = `${fmtMd(shift.work_date)} ${label}の報告を取り消しました`
  const body = `${sent} に送った${label}を、${fmtMdHm(now)} に本人が取り消しました（押し間違いの取消）`
  const recordUser = (owner as any).user_id || u.user_id
  const res = await db.batch([
    ...rows.map(r => db.prepare(`DELETE FROM attendance_reports WHERE attendance_id = ? AND reported_at = ? AND COALESCE(entry_method, 'app') = 'app' AND corrected_by_correction_id IS NULL`)
      .bind(r.attendance_id, r.reported_at)),
    db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at, read_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM attendance_reports WHERE attendance_id IN (${ids.map(() => '?').join(',')}))`)
      .bind(owner.company_id, recordUser, ATTENDANCE_WITHDRAWN_KIND, title, body, '#attendance', shift.shift_id, now, now, ...ids),
  ])
  if (!res[res.length - 1].meta.changes) return c.json({ error: '報告の状態が変わりました。画面を読み直してください' }, 409)
  if (types.some(t => ACTUAL_SYNC_TYPES.includes(t))) await syncActualFromReports(db, owner.company_id, Number(shift.shift_id)).catch(() => {})
  // 写真は D1 から消した後に消す（失敗しても取消は戻さない）
  for (const r of rows) if (r.photo_key) await c.env.PHOTOS.delete(r.photo_key).catch(() => {})
  return c.json({ ok: true, withdrawn: types })
})

// 本人が取り消した報告の記録（シフト操作のモーダルに出す。#323）
api.get('/admin/shifts/:id/attendance-withdrawals', async (c) => {
  const u = c.get('user')
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const rows = (await c.env.DB.prepare(`SELECT title, body, created_at FROM user_notifications
    WHERE user_id IN (SELECT user_id FROM staff_profiles WHERE staff_id = ? AND user_id IS NOT NULL) AND kind = ? AND related_id = ? AND company_id = ? ORDER BY notification_id`)
    .bind(s.staff_id, ATTENDANCE_WITHDRAWN_KIND, s.shift_id, u.company_id).all()).results
  return c.json({ withdrawals: rows })
})

// 入店の位置と現場の距離（シフト操作のモーダルに出す。#277）。
// アプリの入店は報告のときに保存した距離、報告用URLなど距離のない報告は、いまの現場の位置で計算する。基準は会社設定（0 は判定しない）
api.get('/admin/shifts/:id/check-in-location', async (c) => {
  const u = c.get('user')
  const db = c.env.DB
  const s = await ownShift(db, u.company_id, c.req.param('id')) as any
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const [r, pos, co] = await Promise.all([
    db.prepare("SELECT reported_at, latitude, longitude, distance_m, entry_method FROM attendance_reports WHERE shift_id = ? AND report_type = 'check_in' AND company_id = ?")
      .bind(s.shift_id, u.company_id).first() as Promise<any>,
    sitePosition(db, s),
    db.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as Promise<any>,
  ])
  const threshold = farThresholdMeters(co?.settings_json)
  let distance: number | null = r?.distance_m ?? null
  if (r && distance == null && pos && r.latitude != null && r.longitude != null && Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude))) {
    distance = Math.round(haversineMeters(Number(r.latitude), Number(r.longitude), pos.lat, pos.lng))
  }
  return c.json({
    threshold_m: threshold,
    site_position: pos ? pos.source : null,
    check_in: r ? { reported_at: r.reported_at, latitude: r.latitude ?? null, longitude: r.longitude ?? null, entry_method: r.entry_method || 'app',
      distance_m: distance, far: distance != null && threshold > 0 && distance > threshold } : null,
  })
})

// ---------- 電波がない場所で押した報告（#427） ----------
// アプリは通信に失敗した報告を端末に保存し、通信が戻ってから押した時刻（pressed_at）と一意キー（client_request_id）を付けて送り直す。
// 同じキーの報告が記録済みなら、記録済みの内容をそのまま返す（応答だけが届かなかった送信の再送で 409 にしない）
async function duplicateStaffReport(db: D1Database, shiftId: number, type: string, key: string | null) {
  if (!key) return null
  return db.prepare(`SELECT reported_at, status, late_minutes, early_leave_minutes, distance_m, photo_key, time_source FROM attendance_reports
    WHERE shift_id = ? AND report_type = ? AND client_request_id = ?`).bind(shiftId, type, key).first() as Promise<any>
}
function duplicateStaffReportResult(r: any, settingsJson: any) {
  return { ok: true, duplicate: true, status: r.status, reported_at: r.reported_at, device_time: r.time_source === 'device', late_minutes: r.late_minutes, early_leave_minutes: r.early_leave_minutes,
    ...(r.photo_key ? { photo_key: r.photo_key } : {}), ...distanceResult(r.distance_m ?? null, settingsJson) }
}
// 記録の時刻。押した時刻が送られたら、範囲（report-settings.ts の deviceReportTime）を確かめ、受け取った時刻より前の分なら押した時刻で記録する。
//   checkAt: 受付の時間帯を確かめる時刻（押した時刻で記録するときは押した時刻）
//   押した時刻で記録するときは、記録済みの前の報告より前の時刻にならないことも確かめる（順序が逆の記録を作らない）
async function staffReportTime(db: D1Database, shiftId: number, type: string, now: string, pressedRaw: any):
  Promise<{ at: string; checkAt: string; pressed: string | null; adopt: boolean } | { error: string; status: number }> {
  const dev = deviceReportTime(pressedRaw, now)
  if ('error' in dev) return dev
  if (!dev.adopt || !dev.pressed) return { at: reportedAtMinute(now), checkAt: now, pressed: dev.pressed, adopt: false }
  const at = reportedAtMinute(dev.pressed)
  const earlier = REPORT_TYPES.slice(0, REPORT_TYPES.indexOf(type as any))
  if (earlier.length) {
    const r = await db.prepare(`SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ? AND report_type IN (${earlier.map(() => '?').join(',')})
      ORDER BY reported_at DESC LIMIT 1`).bind(shiftId, ...earlier).first() as any
    if (r && String(r.reported_at) > at) {
      return { error: `${REPORT_LABEL[r.report_type]}（${fmtMdHm(r.reported_at)}）より前の時刻になるため、押した時刻（${fmtMdHm(at)}）では記録できません。打刻履歴から修正を申請してください`, status: 400 }
    }
  }
  return { at, checkAt: dev.pressed, pressed: dev.pressed, adopt: true }
}

// 押した時刻で記録した印（打刻修正で直した報告には付けない。修正の後の時刻は承認した内容のため）
function deviceTimeMark(r: any) {
  const dev = r.time_source === 'device' && r.corrected_by_correction_id == null
  return { device_time: dev, received_at: dev ? r.received_at : null }
}

// 勤怠報告
api.post('/staff/attendance', async (c) => {
  const u = c.get('user')
  const { shift_id, report_type, latitude, longitude, address, no_photo_reason, no_photo_note, client_request_id, pressed_at } = await c.req.json()
  if (!REPORT_TYPES.includes(report_type)) return c.json({ error: '不正な報告種別です' }, 400)
  // 勤怠の自動振り分け: シフトの所有企業・スタッフ行に記録する（同一人物の他社シフトも可）
  const resolved = await resolvePersonShift(c, shift_id)
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff: owner } = resolved
  // 同じ送信の再送（#427）
  const reqId = clientRequestId(client_request_id)
  const dup = await duplicateStaffReport(c.env.DB, shift.shift_id, report_type, reqId)
  if (dup) return c.json(duplicateStaffReportResult(dup, owner.settings_json))
  const now = nowJST()
  const time = await staffReportTime(c.env.DB, shift.shift_id, report_type, now, pressed_at)
  if ('error' in time) return c.json({ error: time.error, code: 'device_time' }, time.status as 400)
  const modes = (await modesForShifts(c.env.DB, [shift.shift_id])).get(shift.shift_id)
  // 欠勤・確定済みでないか・受付の時間帯か（稼働日。休憩・勤務終了・退店は翌日も）・有効か・報告済みや申請中でないか・順序（#116 #84 #122 #47）
  // 受付の時間帯は、押した時刻で記録するときは押した時刻で確かめる（#427）
  const state = await loadReportState(c.env.DB, shift.shift_id)
  const ng = checkStaffReport(shift, report_type, time.checkAt, modes ? modes.required_attendance : [...REPORT_TYPES], state)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  // 写真が必須の入店・退店は写真付きの API で送る。写真を送れないときは、会社が許可していれば理由つきで写真なしで受け付ける（#535）
  let noPhotoReason: string | null = null
  if (PHOTO_REQUIRED_TYPES.includes(report_type)) {
    const proj = await c.env.DB.prepare('SELECT photo_required_override FROM projects WHERE project_id = ?').bind(shift.project_id).first()
    if (resolvePhotoRequired(owner, proj?.photo_required_override as number | null)) {
      const reason = noPhotoReasonText(no_photo_reason, no_photo_note)
      if (reason && typeof reason === 'object') return c.json({ error: reason.error }, 400)
      if (!reason || !photoSkipAllowed(owner.settings_json)) return c.json({ error: PHOTO_REQUIRED_ERROR }, 400)
      noPhotoReason = reason
    }
  }

  // 遅刻・早退の判定（入店・勤務開始は開始の絶対日時と比べ、会社設定の猶予を超えたら late。勤務終了・退店は早退の分数。#134 #219 #497）
  // 記録の時刻は受け取った時刻か、電波がない場所で押した時刻（#427。staffReportTime）
  const at = time.at
  const judged = lateness(shift, [{ report_type, reported_at: at }], await latenessSettingsFor(c.env.DB, owner.settings_json, shift.project_id))[0]
  const status = reportStatus(judged, latitude)
  // 入店の位置と現場（開催場所、なければ案件）の距離（#277）
  const distance = report_type === 'check_in' ? await checkInDistance(c.env.DB, shift, latitude, longitude) : null
  // 同時に届いた2回目は一意制約（shift_id, report_type）で登録されない。秒は 00 にそろえる（#95 #133）
  // 住所・user-agent は長さを切って保存する（報告用URLと同じ。#521）
  const ins = await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, late_minutes, early_leave_minutes, no_photo_reason, distance_m,
      client_request_id, pressed_at, received_at, time_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shift_id, report_type) DO NOTHING`)
    .bind(owner.company_id, owner.staff_id, shift.shift_id, report_type, at, latitude ?? null, longitude ?? null, typeof address === 'string' && address ? address.slice(0, 200) : null,
      (c.req.header('user-agent') || '').slice(0, 300), status, judged.late_minutes, judged.early_leave_minutes, noPhotoReason, distance,
      reqId, time.pressed, now, time.adopt ? 'device' : null).run()
  if (!ins.meta.changes) {
    // 同じキーの送信が同時に届いて先に記録された場合は、記録済みの内容を返す
    const again = await duplicateStaffReport(c.env.DB, shift.shift_id, report_type, reqId)
    if (again) return c.json(duplicateStaffReportResult(again, owner.settings_json))
    return c.json({ error: 'すでに報告済みです' }, 409)
  }
  // 勤務開始・終了（なければ入店・退店）と休憩を実績（実働時間）に反映
  if (ACTUAL_SYNC_TYPES.includes(report_type)) await syncActualFromReports(c.env.DB, owner.company_id, Number(shift.shift_id)).catch(() => {})
  return c.json({ ok: true, status, reported_at: at, device_time: time.adopt, late_minutes: judged.late_minutes, early_leave_minutes: judged.early_leave_minutes, ...distanceResult(distance, owner.settings_json) })
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
  // 写真のファイルの日時と選び方（カメラ・アルバム）。報告の日時とずれていれば管理画面で知らせる（#418）
  const takenAt = photoTakenAt(form.get('photo_taken_at'))
  const source = photoSource(form.get('photo_source'))

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
  // 同じ送信の再送と、電波がない場所で押した時刻（#427。POST /staff/attendance と同じ）。再送なら写真は保存しない
  const rawReqId = form.get('client_request_id'), rawPressed = form.get('pressed_at')
  const reqId = clientRequestId(typeof rawReqId === 'string' ? rawReqId : null)
  const dup = await duplicateStaffReport(c.env.DB, shift.shift_id, report_type, reqId)
  if (dup) return c.json(duplicateStaffReportResult(dup, owner.settings_json))
  const now = nowJST()
  const time = await staffReportTime(c.env.DB, shift.shift_id, report_type, now, typeof rawPressed === 'string' ? rawPressed : null)
  if ('error' in time) return c.json({ error: time.error, code: 'device_time' }, time.status as 400)
  const modes = (await modesForShifts(c.env.DB, [shift.shift_id])).get(shift.shift_id)
  // POST /staff/attendance と同じ確認（欠勤・確定済み・受付の時間帯・有効・報告済み・申請中・順序）
  const state = await loadReportState(c.env.DB, shift.shift_id)
  const ng = checkStaffReport(shift, report_type, time.checkAt, modes ? modes.required_attendance : [...REPORT_TYPES], state)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)

  const lat = latitude != null && latitude !== '' ? Number(latitude) : null
  const lng = longitude != null && longitude !== '' ? Number(longitude) : null
  // 遅刻・早退の判定（POST /staff/attendance と同じ）
  const at = time.at
  const judged = lateness(shift, [{ report_type, reported_at: at }], await latenessSettingsFor(c.env.DB, owner.settings_json, shift.project_id))[0]
  const status = reportStatus(judged, lat)
  // 入店の位置と現場の距離（#277。POST /staff/attendance と同じ）
  const distance = report_type === 'check_in' ? await checkInDistance(c.env.DB, shift, lat, lng) : null

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
    const ins = await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, photo_key, late_minutes, early_leave_minutes,
        photo_taken_at, photo_source, distance_m, client_request_id, pressed_at, received_at, time_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shift_id, report_type) DO NOTHING`)
      .bind(owner.company_id, owner.staff_id, shift.shift_id, report_type, at, lat, lng, null, (c.req.header('user-agent') || '').slice(0, 300), status, key,
        judged.late_minutes, judged.early_leave_minutes, takenAt, source, distance, reqId, time.pressed, now, time.adopt ? 'device' : null).run()
    if (!ins.meta.changes) {
      await c.env.PHOTOS.delete(key).catch(() => {})
      const again = await duplicateStaffReport(c.env.DB, shift.shift_id, report_type, reqId)
      if (again) return c.json(duplicateStaffReportResult(again, owner.settings_json))
      return c.json({ error: 'すでに報告済みです' }, 409)
    }
  } catch {
    // DB登録に失敗した場合はアップロード済みの写真を掃除する
    await c.env.PHOTOS.delete(key).catch(() => {})
    return c.json({ error: '報告の登録に失敗しました。もう一度お試しください' }, 500)
  }
  await syncActualFromReports(c.env.DB, owner.company_id, Number(shift_id)).catch(() => {})

  return c.json({ ok: true, status, reported_at: at, device_time: time.adopt, photo_key: key, late_minutes: judged.late_minutes, early_leave_minutes: judged.early_leave_minutes, ...distanceResult(distance, owner.settings_json) })
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

// 管理者: 相談の写真の取得。自社あての相談の写真だけ（#429）
api.get('/admin/consultation-photo/:id{[0-9]+}', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare(`SELECT a.storage_key FROM consultation_attachments a JOIN consultations co ON co.consultation_id = a.consultation_id
    WHERE a.attachment_id = ? AND co.company_id = ?`).bind(c.req.param('id'), u.company_id).first() as any
  if (!row) return c.json({ error: '写真が見つかりません' }, 404)
  return attendancePhotoResponse(c, row.storage_key)
})

// 写真が送れないときの扱い（#535）。スタッフ: シフトの所有企業が写真なしの報告を許可しているかと、理由の選択肢
api.get('/staff/photo-options', async (c) => {
  const resolved = await resolvePersonShift(c, c.req.query('shift_id'))
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  return c.json({ skip_allowed: photoSkipAllowed(resolved.staff.settings_json), reasons: NO_PHOTO_REASONS })
})

// スタッフ: 所属・連携している会社の緊急連絡先（#173）。ログイン中の会社を先に、登録のある会社だけを返す（停止中の企業は返さない）
api.get('/staff/emergency-contacts', async (c) => {
  const rows = await personStaffRows(c.env.DB, c.get('user'))
  const ids = [...new Set(rows.map(r => Number(r.company_id)))]
  if (!ids.length) return c.json({ contacts: [] })
  const list = ((await c.env.DB.prepare(`SELECT company_id, company_name, emergency_phone, emergency_note, active_status FROM companies
    WHERE company_id IN (${ids.map(() => '?').join(',')}) AND emergency_phone IS NOT NULL AND emergency_phone != ''`).bind(...ids).all()).results as any[])
    .filter(r => isCompanyActive(r.active_status))
  list.sort((a, b) => ids.indexOf(Number(a.company_id)) - ids.indexOf(Number(b.company_id)))
  return c.json({ contacts: list.map(r => ({ company_name: r.company_name, phone: r.emergency_phone, note: r.emergency_note || '' })) })
})
// 管理者: 写真なしの報告を許可するか（companies.settings_json の photo_skip_allowed。既定は許可しない）
api.get('/admin/settings/photo-skip', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ enabled: photoSkipAllowed(row?.settings_json), reasons: NO_PHOTO_REASONS, can_edit: canEditAttendanceSettings(u) })
})
api.post('/admin/settings/photo-skip', async (c) => {
  const u = c.get('user')
  // 写真必須の設定と同じく、会社管理者・現場管理者だけが変えられる（9004）
  if (!canEditAttendanceSettings(u)) return c.json({ error: ATTENDANCE_SETTING_DENIED, code: 'role_forbidden' }, 403)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return c.json({ error: '不正なパラメータです' }, 400)
  // ほかの設定を古い内容で上書きしないよう、この項目だけを書き換える
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.photo_skip_allowed', json(?)) WHERE company_id = ?`)
    .bind(JSON.stringify(body.enabled), u.company_id).run()
  return c.json({ ok: true, enabled: body.enabled })
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
  // 対応済みにした日報に新しく印が付いたら、未対応に戻す（#169。新しい事故が対応済みのまま埋もれないように）
  if (merged.raised.length) await reopenIncidentStmt(c.env.DB, shift.shift_id).run()
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

// comment_read_at: 本人が管理者のコメントを開いた日時（#158。コメントが変わると空に戻る）。unread_comment: まだ開いていないコメントがある
const MY_REPORT_COLS = `dr.daily_report_id, dr.shift_id, dr.work_date, dr.project_id, dr.report_values, dr.incident_flag, dr.complaint_flag,
      dr.manager_comment, dr.manager_comment_at, dr.comment_read_at, dr.manager_checked, dr.manager_checked_at, dr.submitted_at, dr.revised_after_check_at,
      p.project_name, p.report_template_id, co.company_name, (dr.company_id != ?) AS other_company, sh.start_time, sh.end_time
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id JOIN companies co ON co.company_id = dr.company_id
    LEFT JOIN shifts sh ON sh.shift_id = dr.shift_id`
async function myReportsView(db: D1Database, rows: any[]) {
  const tplIds = [...new Set(rows.map(r => r.report_template_id).filter((x: any) => x != null))]
  const templates: Record<string, any[]> = {}
  if (tplIds.length) {
    const ts = (await db.prepare(`SELECT template_id, fields_json FROM report_templates WHERE template_id IN (${tplIds.map(() => '?').join(',')})`).bind(...tplIds).all()).results as any[]
    for (const t of ts) templates[t.template_id] = parseTemplateFields(t.fields_json)
  }
  return {
    reports: rows.map(r => {
      const { report_values, ...rest } = r
      return { ...rest, template_id: r.report_template_id, other_company: !!r.other_company, incident_flag: !!r.incident_flag, complaint_flag: !!r.complaint_flag,
        manager_checked: !!r.manager_checked, values: parseReportValues(report_values), unread_comment: !!r.manager_comment && !r.comment_read_at }
    }),
    templates,
  }
}
// 自分の日報1件（#158。通知から開く・一覧の先頭30件より前の日報も開けるように）。開いたら管理者のコメントを既読にする
api.get('/staff/my-reports/:id{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const ids = await personStaffIds(db, u)
  if (!ids.length) return c.json({ error: '日報が見つかりません' }, 404)
  const row = await db.prepare(`SELECT ${MY_REPORT_COLS} WHERE dr.daily_report_id = ? AND dr.staff_id IN (SELECT value FROM json_each(?))`)
    .bind(u.company_id, c.req.param('id'), JSON.stringify(ids)).first() as any
  if (!row) return c.json({ error: '日報が見つかりません' }, 404)
  if (row.manager_comment && !row.comment_read_at) {
    row.comment_read_at = nowJST()
    await db.prepare('UPDATE daily_reports SET comment_read_at = ? WHERE daily_report_id = ? AND comment_read_at IS NULL AND manager_comment IS NOT NULL')
      .bind(row.comment_read_at, row.daily_report_id).run()
    // 同じ日報のコメントの通知も既読にする
    await db.prepare(`UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND kind = 'daily_report_comment' AND related_id = ? AND read_at IS NULL`)
      .bind(row.comment_read_at, u.user_id, row.daily_report_id).run()
  }
  const v = await myReportsView(db, [row])
  return c.json({ report: v.reports[0], templates: v.templates })
})
// 管理者のコメントを既読にする（#158。一覧でコメントを開いたとき）
api.post('/staff/my-reports/:id{[0-9]+}/comment-read', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const ids = await personStaffIds(db, u)
  const now = nowJST()
  const r = ids.length ? await db.prepare(`UPDATE daily_reports SET comment_read_at = ? WHERE daily_report_id = ? AND staff_id IN (SELECT value FROM json_each(?))
      AND manager_comment IS NOT NULL AND comment_read_at IS NULL`).bind(now, c.req.param('id'), JSON.stringify(ids)).run() : null
  if (r?.meta.changes) await db.prepare(`UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND kind = 'daily_report_comment' AND related_id = ? AND read_at IS NULL`)
    .bind(now, u.user_id, Number(c.req.param('id'))).run()
  return c.json({ ok: true, updated: r?.meta.changes || 0 })
})
// 自分の日報一覧（過去の日報。#319 #371）。同一人物の全所属の分を新しい順に。項目の表示名は案件のテンプレートから付ける
api.get('/staff/my-reports', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const ids = await personStaffIds(db, u)
  if (!ids.length) return c.json({ reports: [], templates: {} })
  const rows = (await db.prepare(`
    SELECT ${MY_REPORT_COLS}
    WHERE dr.staff_id IN (${ids.map(() => '?').join(',')}) ORDER BY dr.work_date DESC, dr.submitted_at DESC LIMIT 30`).bind(u.company_id, ...ids).all()).results as any[]
  return c.json(await myReportsView(db, rows))
})

// スタッフアプリに出す社内の情報の設定（#496 #523。companies.settings_json）。既定はランキングもメンバーも出さず、ランキングは匿名
function staffViewSettings(json: any): { ranking_visible: boolean; ranking_anonymous: boolean; show_coworkers: boolean } {
  let s: any = {}
  try { s = JSON.parse(json || '{}') || {} } catch { s = {} }
  return { ranking_visible: s.ranking_visible === true, ranking_anonymous: s.ranking_anonymous !== false, show_coworkers: s.show_coworkers === true }
}
// ほかのスタッフの名前は姓だけを出す（姓と名の間に空白が無い名前はそのまま）
const familyName = (name: any) => String(name || '').trim().split(/[\s　]+/)[0] || ''

// 店舗の申し送り（#522）。同じ案件（開催場所が決まっていれば同じ場所）の、ほかのスタッフの直近の日報から、
// 共有する項目（テンプレートの項目に share: true。無ければ store_share・good_case）が書かれたものを新しい順に返す。
// 稼働日の前後にだけ見られるよう、直近 DAILY_REPORT_PENDING_DAYS 日より前のシフトでは返さない
const HANDOVER_DAYS = 14
const HANDOVER_MAX = 20
const HANDOVER_DEFAULT_KEYS = ['store_share', 'good_case']
// 申し送り・一緒に入る人を返すのは、本人の確定・代打のシフトだけ（希望（仮）・欠勤などのシフトでは返さない。画面の表示条件と同じ）
const TEAM_VIEW_STATUSES = ['confirmed', 'substitute']
api.get('/staff/handover/:shiftId', async (c) => {
  const db = c.env.DB
  const resolved = await resolvePersonShift(c, c.req.param('shiftId'))
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift } = resolved
  const empty = { days: HANDOVER_DAYS, fields: [], notes: [] }
  if (!TEAM_VIEW_STATUSES.includes(shift.status) || shift.work_date < addDays(todayJST(), -DAILY_REPORT_PENDING_DAYS)) return c.json(empty)
  const pt = await shiftReportTemplate(db, shift)
  if (!pt) return c.json(empty)
  let raw: any[] = []
  try { const v = JSON.parse(pt.template?.fields_json || '[]'); if (Array.isArray(v)) raw = v } catch { raw = [] }
  const textFields = raw.filter(f => f && typeof f.key === 'string' && f.type !== 'number')
  const marked = textFields.filter(f => f.share === true)
  const fields = (marked.length ? marked : textFields.filter(f => HANDOVER_DEFAULT_KEYS.includes(f.key))).map(f => ({ key: f.key as string, label: String(f.label || f.key) }))
  if (!fields.length) return c.json(empty)
  const personIds = await personStaffIds(db, c.get('user'))
  const rows = (await db.prepare(`
    SELECT dr.work_date, dr.report_values, us.name
    FROM daily_reports dr JOIN staff_profiles sp ON sp.staff_id = dr.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN shifts sh ON sh.shift_id = dr.shift_id
    WHERE dr.company_id = ? AND dr.project_id = ? AND dr.work_date <= ? AND dr.work_date >= ?
      AND dr.staff_id NOT IN (SELECT value FROM json_each(?))
      ${shift.site_id ? 'AND (sh.site_id IS NULL OR sh.site_id = ?)' : ''}
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je
        WHERE je.key IN (SELECT value FROM json_each(?)) AND je.type = 'text' AND trim(je.value) != '')
    ORDER BY dr.work_date DESC, dr.submitted_at DESC LIMIT ?`)
    .bind(shift.company_id, shift.project_id, shift.work_date, addDays(shift.work_date, -HANDOVER_DAYS), bindJsonArray(personIds),
      ...(shift.site_id ? [shift.site_id] : []), JSON.stringify(fields.map(f => f.key)), HANDOVER_MAX).all()).results as any[]
  const notes = rows.map(r => {
    const v = parseReportValues(r.report_values)
    const values: Record<string, string> = {}
    for (const f of fields) if (typeof v[f.key] === 'string' && (v[f.key] as string).trim()) values[f.key] = (v[f.key] as string).trim()
    return { work_date: r.work_date, name: familyName(r.name), values }
  }).filter(n => Object.keys(n.values).length)
  return c.json({ days: HANDOVER_DAYS, fields, notes })
})

// 同じ日・同じ案件に入るほかのスタッフ（#523）。会社の設定（show_coworkers）で出すときだけ、姓と時刻だけを返す（電話番号・金額は返さない）。
// 開催場所が決まっていれば同じ場所の人に限り、同じ枠の人には same_slot を付ける
const COWORKERS_MAX = 30
api.get('/staff/shifts/:id/coworkers', async (c) => {
  const db = c.env.DB
  const resolved = await resolvePersonShift(c, c.req.param('id'))
  if (!resolved) return c.json({ error: 'シフトが見つかりません' }, 404)
  const { shift, staff } = resolved
  if (!staffViewSettings(staff.settings_json).show_coworkers) return c.json({ enabled: false, coworkers: [] })
  if (!TEAM_VIEW_STATUSES.includes(shift.status) || shift.work_date < addDays(todayJST(), -DAILY_REPORT_PENDING_DAYS)) return c.json({ enabled: true, coworkers: [] })
  const personIds = await personStaffIds(db, c.get('user'))
  const rows = (await db.prepare(`
    SELECT o.start_time, o.end_time, o.slot_id, us.name
    FROM shifts o JOIN staff_profiles sp ON sp.staff_id = o.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE o.company_id = ? AND o.project_id = ? AND o.work_date = ? AND o.status IN ('confirmed', 'substitute') AND o.shift_id != ?
      AND o.staff_id NOT IN (SELECT value FROM json_each(?))
      ${shift.site_id ? 'AND (o.site_id IS NULL OR o.site_id = ?)' : ''}
    ORDER BY o.start_time, o.end_time, o.shift_id LIMIT ?`)
    .bind(shift.company_id, shift.project_id, shift.work_date, shift.shift_id, bindJsonArray(personIds), ...(shift.site_id ? [shift.site_id] : []), COWORKERS_MAX).all()).results as any[]
  return c.json({
    enabled: true,
    coworkers: rows.map(r => ({ name: familyName(r.name), start_time: r.start_time, end_time: r.end_time, same_slot: !!shift.slot_id && r.slot_id === shift.slot_id })),
  })
})

// シフト確認
// shifts は確定・代打・欠勤と、管理者が入れた『希望（仮）』（status='requested'。本人は可否を返事できる）。
// 本人が出したシフト希望は shift_requests にあり、requests で別に返す（#411）
// 期間は ?from=&to=（日付。月をまたいでよい。最大 STAFF_SHIFT_MAX_DAYS 日。#428）か ?month=（月）で指定する
const STAFF_SHIFT_MAX_DAYS = 62
api.get('/staff/shifts', async (c) => {
  const u = c.get('user')
  const q = c.req.query('month') || ''
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : monthJST()
  let from = month + '-01', to = month + '-31'
  const qf = c.req.query('from'), qt = c.req.query('to')
  if (isISODate(qf)) {
    from = qf as string
    to = isISODate(qt) && (qt as string) >= from ? qt as string : addDays(from, 13)
    if (to > addDays(from, STAFF_SHIFT_MAX_DAYS - 1)) to = addDays(from, STAFF_SHIFT_MAX_DAYS - 1)
  }
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
    WHERE s.staff_id IN (${ids.map(() => '?').join(',')}) AND s.work_date BETWEEN ? AND ? ORDER BY s.work_date, s.start_time`).bind(u.company_id, ...ids, from, to).all()
  // 本人が出した希望（取り下げたものは出さない）。案件は自社の行だけ名前を付ける
  const requests = (await c.env.DB.prepare(`
    SELECT r.request_id, r.work_date, r.start_time, r.end_time, r.memo, r.status, r.response_note, r.responded_at, r.created_at, r.project_id, p.project_name
    FROM shift_requests r LEFT JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id
    WHERE r.company_id = ? AND r.staff_id = ? AND r.status != 'withdrawn' AND r.work_date BETWEEN ? AND ?
    ORDER BY r.work_date, r.start_time, r.request_id`).bind(u.company_id, u.staff_id, from, to).all()).results
  return c.json({
    shifts: (rows.results as any[]).map(s => staffShiftView({ ...s, tentative: s.status === 'requested' })),
    requests,
    request_projects: await requestableProjects(c.env.DB, u),
    month, from, to,
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
// お知らせは「確認不要」（no_confirm）として既読の扱いにする（#245）。
// 掲載期限を過ぎたものは出さず、filter=past で「掲載終了」として新しい順に出す（#294）。添付の一覧も返す（#555）
const STAFF_NOTICE_PAGE = 50
api.get('/staff/notices', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const offset = toInt(c.req.query('offset'), 0, 100000) ?? 0
  const filter = c.req.query('filter')
  const unreadOnly = filter === 'unread'
  if (offset === 0) c.executionCtx.waitUntil(publishDueNotices(c.env, u.company_id).catch(() => {}))
  const rows = await loadStaffNotices(db, u.user_id, filter === 'past'
    ? { expired: 'only', order: 'recent', limit: STAFF_NOTICE_PAGE + 1, offset }
    : { unreadOnly, limit: STAFF_NOTICE_PAGE + 1, offset })
  const page = rows.slice(0, STAFF_NOTICE_PAGE)
  const files = await loadNoticeAttachments(db, page.filter(n => n.attachment_count > 0).map(n => n.notice_id))
  const res: any = { notices: page.map(n => ({ ...n, attachments: files.get(n.notice_id) || [] })), has_more: rows.length > STAFF_NOTICE_PAGE, offset }
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

// 下のタブ・その他のメニューに出す未読の件数（#383）。画面を切り替えるたびに呼ぶので、件数だけを返す軽い API にする。
// notices: 今の企業の未読のお知らせ、notices_other: 切り替えていない所属企業の未読、notifications: 未読の通知（同じ人の全所属の分。通知の一覧と同じ範囲）
api.get('/staff/badges', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const persons = await personStaffRows(db, u)
  const others = persons.filter(r => r.user_id && r.company_id !== u.company_id)
  const uids = [...new Set<number>([u.user_id, ...persons.map(r => r.user_id).filter(Boolean)])]
  const [counts, notif] = await Promise.all([
    countUnreadNotices(db, [u.user_id, ...others.map(r => r.user_id)]),
    db.prepare(`SELECT COUNT(*) AS n FROM user_notifications WHERE user_id IN (${uids.map(() => '?').join(',')}) AND read_at IS NULL`).bind(...uids).first() as Promise<any>,
  ])
  return c.json({
    notices: counts.get(u.user_id) || 0,
    notices_other: others.reduce((n, r) => n + (counts.get(r.user_id) || 0), 0),
    notifications: Number(notif?.n || 0),
  })
})

// お知らせの個別画面（#333）。今の企業に無ければ、同じ人のほかの所属企業のお知らせかを調べ、切り替え先を返す
api.get('/staff/notices/:id{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const id = Number(c.req.param('id'))
  const [n] = await loadStaffNotices(db, u.user_id, { id, limit: 1 })
  if (n) return c.json({ notice: { ...n, attachments: (await loadNoticeAttachments(db, [n.notice_id])).get(n.notice_id) || [] } })
  // 取り消したお知らせ（#157）は、通知やメールのリンクから開かれたときに取り消したことを伝える（内容は出さない）
  const gone = await db.prepare(`SELECT status FROM notices WHERE notice_id = ? AND company_id = ?`).bind(id, u.company_id).first() as any
  if (gone?.status === 'withdrawn') return c.json({ error: 'このお知らせは取り消されました', withdrawn: true }, 404)
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

// お知らせへの回答（#554）。選択肢を1つ選び（選択肢があるとき）、自由記入欄があればコメントを添える。
// 答え直すと上書きする。掲載期限を過ぎたものには答えられない。答えたら既読にもする
const NOTICE_RESPONSE_COMMENT_MAX = 500
api.post('/staff/notices/:id{[0-9]+}/response', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const [n] = await loadStaffNotices(db, u.user_id, { id: Number(c.req.param('id')), limit: 1 })
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  const options: string[] = n.response_options
  if (!options.length && !n.response_comment) return c.json({ error: 'このお知らせには回答できません' }, 400)
  if (n.expired) return c.json({ error: '掲載期限を過ぎたため、回答できません' }, 400)
  if (n.no_confirm) return c.json({ error: '公開から2年以上たったお知らせには回答できません' }, 400)
  const choice = b.choice == null || b.choice === '' ? null : String(b.choice)
  if (options.length && (choice == null || !options.includes(choice))) return c.json({ error: '回答を選んでください' }, 400)
  if (!options.length && choice != null) return c.json({ error: '回答の指定が正しくありません' }, 400)
  const comment = n.response_comment ? String(b.comment ?? '').trim() : ''
  if (comment.length > NOTICE_RESPONSE_COMMENT_MAX) return c.json({ error: `コメントは${NOTICE_RESPONSE_COMMENT_MAX}文字以内にしてください` }, 400)
  if (!options.length && !comment) return c.json({ error: '回答を入力してください' }, 400)
  const now = nowJST()
  await db.batch([
    db.prepare(`INSERT INTO notice_responses (notice_id, user_id, company_id, choice, comment, answered_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(notice_id, user_id) DO UPDATE SET choice = excluded.choice, comment = excluded.comment, updated_at = excluded.answered_at`)
      .bind(n.notice_id, u.user_id, u.company_id, choice, comment || null, now),
    db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?, ?)').bind(n.notice_id, u.user_id),
  ])
  return c.json({ ok: true, my_response: { choice, comment: comment || null, answered_at: now } })
})

// お知らせの添付（#555）。配信先の本人だけが取得できる（一覧に出す条件と同じ。掲載期限を過ぎたものも取得できる）
api.get('/staff/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}', async (c) => {
  const u = c.get('user')
  const [n] = await loadStaffNotices(c.env.DB, u.user_id, { id: Number(c.req.param('id')), limit: 1 })
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  return noticeAttachmentResponse(c, n.notice_id, u.company_id, c.req.param('aid'))
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
// 実績を見せない設定（show_performance）の案件は出さない。テンプレートに無い数値（項目を変える前の日報）は、キーを表示名にして後ろに足す。
// 案件の月間目標（#292。スタッフ1人あたり）があれば goals に、会社がランキングを出す設定（#496）なら ranking に、同じ月・同じ案件の順位を付ける
const RANKING_TOP = 3
api.get('/staff/performance', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const q = c.req.query('month') || ''
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : monthJST()
  const personRows = await personStaffRows(db, u)
  const ids = personRows.length ? personRows.map(r => r.staff_id) : (u.staff_id ? [u.staff_id] : [])
  if (!ids.length) return c.json({ month, projects: [], daily: [], totals: {} })
  const [from, to] = monthBounds(month)
  const rows = (await db.prepare(`
    SELECT dr.work_date, dr.report_values, dr.manager_comment, dr.project_id, dr.staff_id, dr.company_id, p.project_name, p.show_performance, p.performance_goals_json,
      co.company_name, (dr.company_id != ?) AS other_company, t.fields_json
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id JOIN companies co ON co.company_id = dr.company_id
    LEFT JOIN report_templates t ON t.template_id = p.report_template_id
    WHERE dr.staff_id IN (${ids.map(() => '?').join(',')}) AND dr.work_date >= ? AND dr.work_date < ? ORDER BY dr.work_date, dr.submitted_at`).bind(u.company_id, ...ids, from, to).all()).results as any[]
  const totals: Record<string, number> = {}
  type PerfProject = { project_id: number; project_name: string; company_name: string; other_company: boolean; fields: { key: string; label: string }[]; totals: Record<string, number>; days: number;
    goals: { key: string; label: string; target: number; actual: number }[]; ranking?: any; _staff: number; _company: number; _goals: Record<string, number> }
  const projects = new Map<number, PerfProject>()
  const daily: any[] = []
  for (const r of rows) {
    if (!r.show_performance) continue
    let pj = projects.get(r.project_id)
    if (!pj) {
      const fields = parseTemplateFields(r.fields_json).filter(f => f.type === 'number').map(f => ({ key: f.key, label: f.label }))
      pj = { project_id: r.project_id, project_name: r.project_name, company_name: r.company_name, other_company: !!r.other_company, fields, totals: {}, days: 0,
        goals: [], _staff: r.staff_id, _company: r.company_id, _goals: parseGoals(r.performance_goals_json, fields) }
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
  for (const pj of projects.values()) {
    pj.goals = pj.fields.filter(f => pj._goals[f.key] > 0).map(f => ({ key: f.key, label: f.label, target: pj._goals[f.key], actual: pj.totals[f.key] || 0 }))
  }
  // ランキング: 会社の設定で出す案件だけ、同じ月・同じ案件の日報をスタッフ・項目ごとに合計する（値の取り出しは D1 側で行う）
  const settingsOf = (cid: number) => staffViewSettings((personRows.find(r => r.company_id === cid) || u).settings_json)
  const ranked = [...projects.values()].filter(pj => settingsOf(pj._company).ranking_visible)
  if (ranked.length) {
    const sums = (await db.prepare(`
      SELECT dr.project_id, dr.staff_id, MAX(us.name) AS name, je.key AS k, SUM(je.value) AS v
      FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id AND p.company_id = dr.company_id
      LEFT JOIN staff_profiles sp ON sp.staff_id = dr.staff_id LEFT JOIN users us ON us.user_id = sp.user_id,
        json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je
      WHERE dr.project_id IN ${JSON_IN} AND dr.work_date >= ? AND dr.work_date < ? AND je.type IN ('integer', 'real')
      GROUP BY dr.project_id, dr.staff_id, je.key`).bind(bindJsonArray(ranked.map(pj => pj.project_id)), from, to).all()).results as any[]
    for (const pj of ranked) {
      const mine = sums.filter(s => s.project_id === pj.project_id)
      const members = new Map<number, string>()
      for (const s of mine) members.set(s.staff_id, s.name || '')
      if (!members.size) continue
      const anonymous = settingsOf(pj._company).ranking_anonymous
      const byKey: Record<string, any> = {}
      for (const f of pj.fields) {
        const val = new Map<number, number>()
        for (const s of mine) if (s.k === f.key) val.set(s.staff_id, Number(s.v) || 0)
        const list = [...members.keys()].map(id => ({ id, v: val.get(id) || 0 })).sort((a, b) => b.v - a.v)
        const me = val.get(pj._staff) || 0
        byKey[f.key] = {
          rank: 1 + list.filter(x => x.v > me).length, value: me,
          average: round1(list.reduce((n, x) => n + x.v, 0) / list.length),
          // 匿名のときは、ほかの人の名前を出さず件数だけにする。自分の行には me を付ける
          top: list.slice(0, RANKING_TOP).map(x => ({ rank: 1 + list.filter(y => y.v > x.v).length, value: x.v, me: x.id === pj._staff, ...(anonymous || x.id === pj._staff ? {} : { name: familyName(members.get(x.id)) }) })),
        }
      }
      pj.ranking = { anonymous, members: members.size, by_key: byKey }
    }
  }
  // 目標の進み具合の目安（月の日数と、今日までに過ぎた日数）
  const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  const today = todayJST()
  const elapsed = month < today.slice(0, 7) ? dim : month > today.slice(0, 7) ? 0 : Number(today.slice(8, 10))
  return c.json({
    month, daily, totals, goal_period: { days_in_month: dim, days_elapsed: elapsed },
    projects: [...projects.values()].map(({ _staff, _company, _goals, ...pj }) => pj),
  })
})

// 案件の月間目標（#292）。日報テンプレートの数値項目のキーごとの、スタッフ1人あたりの件数。テンプレートに無いキー・0以下は使わない
const GOAL_MAX = 99999
function parseGoals(json: any, fields: { key: string }[]): Record<string, number> {
  let g: any = {}
  try { g = JSON.parse(json || '{}') || {} } catch { g = {} }
  const out: Record<string, number> = {}
  if (!g || typeof g !== 'object' || Array.isArray(g)) return out
  for (const f of fields) { const n = Number(g[f.key]); if (Number.isInteger(n) && n > 0 && n <= GOAL_MAX) out[f.key] = n }
  return out
}

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
// 1人が24時間に送れる相談の数（誤操作・乗っ取りで大量に登録されないように。#510）
const CONSULT_DAILY_MAX = 20

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
    ORDER BY reply_unread DESC, co.created_at DESC, co.consultation_id DESC LIMIT 30`).bind(...uids, ...sids).all()).results as any[]
  await withConsultThreads(db, list, 'staff')
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
  // 送信回数の上限: 本人（全所属企業の分）が直近24時間に送った相談の数（#510）
  const sids = rows.length ? rows.map(r => r.staff_id) : [owner.staff_id]
  const dayAgo = new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const sent = await db.prepare(`SELECT COUNT(*) AS n FROM consultations WHERE staff_id IN (${sids.map(() => '?').join(',')}) AND created_at >= ?`).bind(...sids, dayAgo).first() as any
  if (Number(sent?.n) >= CONSULT_DAILY_MAX) return c.json({ error: `相談・連絡は24時間に${CONSULT_DAILY_MAX}件までです。急ぎの場合は電話で連絡してください` }, 429)
  const r = await db.prepare(`INSERT INTO consultations (company_id, staff_id, category, body, urgency, target_project_id, target_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(owner.company_id, owner.staff_id, category, body, urgency || 'normal', targetProjectId, targetDate, nowJST()).run()
  const co = rows.find(x => x.company_id === owner!.company_id)
  // 管理者に知らせる（#154。緊急・体調不良・遅刻欠勤はメールでも）
  await notifyConsultation(c, Number(r.meta.last_row_id), 'received')
  return c.json({ ok: true, consultation_id: r.meta.last_row_id, company_name: co ? co.company_name : null })
})

// ---------- 相談のやり取り（#154）と写真（#429） ----------
// やり取り: 最初の相談の本文（consultations.body）の後に、管理者の返信とスタッフの追加の連絡を consultation_messages に時系列で残す。
// 写真: 1回の送信（最初の相談・追加の連絡）に3枚まで、1つの相談に10枚まで。送信から1時間以内に付ける（画面は送信の直後に続けて送る）。
// R2 の PHOTOS に consultations/{company_id}/{consultation_id}/... で保存し、本人と相談先の会社の管理者だけが見られる
const CONSULT_PHOTOS_PER_POST = 3
const CONSULT_PHOTOS_MAX = 10
const CONSULT_PHOTO_WINDOW_MIN = 60
// 1人が24時間に送れる追加の連絡の数
const CONSULT_MESSAGE_DAILY_MAX = 50

// 相談の一覧（rows）に messages（やり取り）と photos（写真の ID）を付ける。スタッフには管理者の名前を出さない
async function withConsultThreads(db: D1Database, rows: any[], viewer: 'staff' | 'admin') {
  const ids = rows.map(r => Number(r.consultation_id))
  if (!ids.length) return
  const [m, a] = await db.batch([
    db.prepare(`SELECT m.message_id, m.consultation_id, m.author_side, m.body, m.created_at, us.name AS author_name
      FROM consultation_messages m LEFT JOIN users us ON us.user_id = m.author_user_id
      WHERE m.consultation_id IN (SELECT value FROM json_each(?)) ORDER BY m.message_id`).bind(JSON.stringify(ids)),
    db.prepare(`SELECT attachment_id, consultation_id, message_id, created_at FROM consultation_attachments
      WHERE consultation_id IN (SELECT value FROM json_each(?)) ORDER BY attachment_id`).bind(JSON.stringify(ids)),
  ])
  const msgs = new Map<number, any[]>(), photos = new Map<number, any[]>()
  for (const x of m.results as any[]) {
    const list = msgs.get(x.consultation_id) || []
    list.push({ message_id: x.message_id, author_side: x.author_side, body: x.body, created_at: x.created_at,
      author_name: x.author_side === 'admin' ? (viewer === 'admin' ? x.author_name || '管理者' : '管理者') : null })
    msgs.set(x.consultation_id, list)
  }
  for (const x of a.results as any[]) {
    const list = photos.get(x.consultation_id) || []
    list.push({ attachment_id: x.attachment_id, message_id: x.message_id, created_at: x.created_at })
    photos.set(x.consultation_id, list)
  }
  for (const r of rows) { r.messages = msgs.get(Number(r.consultation_id)) || []; r.photos = photos.get(Number(r.consultation_id)) || [] }
}

// 本人（全所属企業の分）の相談
async function ownConsultation(db: D1Database, u: any, id: number | null) {
  if (id == null) return null
  const sids = (await consultPersonRows(db, u)).map(r => r.staff_id)
  if (!sids.length) return null
  return await db.prepare(`SELECT consultation_id, company_id, staff_id, status, created_at FROM consultations
    WHERE consultation_id = ? AND staff_id IN (SELECT value FROM json_each(?))`).bind(id, JSON.stringify(sids)).first() as any
}

// スタッフの追加の連絡。対応済みの相談に送ったら未対応に戻し、管理者に知らせる
api.post('/staff/consultations/:id{[0-9]+}/messages', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const body = typeof b.body === 'string' ? b.body.trim() : ''
  if (!body) return c.json({ error: '内容を入力してください' }, 400)
  if (body.length > CONSULT_BODY_MAX) return c.json({ error: `内容は${CONSULT_BODY_MAX}文字以内で入力してください` }, 400)
  const co = await ownConsultation(db, u, toInt(c.req.param('id'), 1))
  if (!co) return c.json({ error: '相談が見つかりません' }, 404)
  const uids = (await consultPersonRows(db, u)).map(r => r.user_id)
  const since = new Date(Date.now() + 9 * 3600 * 1000 - CONSULT_DUP_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const dup = await db.prepare(`SELECT 1 FROM consultation_messages WHERE consultation_id = ? AND author_side = 'staff' AND body = ? AND created_at >= ? LIMIT 1`)
    .bind(co.consultation_id, body, since).first()
  if (dup) return c.json({ error: '同じ内容をすでに送信しています', duplicate: true }, 409)
  const dayAgo = new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const sent = await db.prepare(`SELECT COUNT(*) AS n FROM consultation_messages WHERE author_side = 'staff' AND author_user_id IN (SELECT value FROM json_each(?)) AND created_at >= ?`)
    .bind(JSON.stringify(uids.length ? uids : [u.user_id]), dayAgo).first() as any
  if (Number(sent?.n) >= CONSULT_MESSAGE_DAILY_MAX) return c.json({ error: `追加の連絡は24時間に${CONSULT_MESSAGE_DAILY_MAX}件までです。急ぎの場合は電話で連絡してください` }, 429)
  const now = nowJST()
  const [ins] = await db.batch([
    db.prepare(`INSERT INTO consultation_messages (consultation_id, company_id, author_side, author_user_id, body, created_at) VALUES (?, ?, 'staff', ?, ?, ?)`)
      .bind(co.consultation_id, co.company_id, u.user_id, body, now),
    // 返信を待っている状態にする（管理者の返信で『対応中』になる）
    db.prepare(`UPDATE consultations SET status = 'open' WHERE consultation_id = ? AND status != 'open'`).bind(co.consultation_id),
  ])
  await notifyConsultation(c, co.consultation_id, 'message', body)
  return c.json({ ok: true, message_id: ins.meta.last_row_id })
})

// 写真を1枚ずつ付ける（multipart/form-data: photo、追加の連絡に付けるときは message_id）
api.post('/staff/consultations/:id{[0-9]+}/photos', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: '送信データの形式が不正です' }, 400) }
  const photo = form.get('photo')
  if (!(photo instanceof File) || photo.size === 0) return c.json({ error: '写真が添付されていません' }, 400)
  if (!PHOTO_ALLOWED_TYPES.includes(photo.type)) return c.json({ error: '対応していない画像形式です（JPEG/PNGのみ）' }, 400)
  if (photo.size > PHOTO_MAX_BYTES) return c.json({ error: '画像サイズが大きすぎます。圧縮に失敗している可能性があります' }, 400)
  const co = await ownConsultation(db, u, toInt(c.req.param('id'), 1))
  if (!co) return c.json({ error: '相談が見つかりません' }, 404)
  const rawMid = form.get('message_id')
  const messageId = rawMid != null && rawMid !== '' ? toInt(String(rawMid), 1) : null
  if (rawMid != null && rawMid !== '' && messageId == null) return c.json({ error: '追加の連絡が見つかりません' }, 404)
  // 付ける先の送信（最初の相談か、本人の追加の連絡）と、送信からの時間
  const postedAt = messageId == null ? co.created_at
    : ((await db.prepare(`SELECT created_at FROM consultation_messages WHERE message_id = ? AND consultation_id = ? AND author_side = 'staff'`).bind(messageId, co.consultation_id).first()) as any)?.created_at
  if (!postedAt) return c.json({ error: '追加の連絡が見つかりません' }, 404)
  const windowStart = new Date(Date.now() + 9 * 3600 * 1000 - CONSULT_PHOTO_WINDOW_MIN * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  if (String(postedAt) < windowStart) return c.json({ error: '写真は送信から1時間以内に付けてください。新しく追加の連絡を送ると、写真を付けられます' }, 409)
  const ext = photo.type === 'image/png' ? 'png' : 'jpg'
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(x => x.toString(16).padStart(2, '0')).join('')
  const key = `consultations/${co.company_id}/${co.consultation_id}/${Date.now()}_${rand}.${ext}`
  try {
    await c.env.PHOTOS.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } })
  } catch {
    return c.json({ error: '写真のアップロードに失敗しました。通信環境を確認して再度お試しください' }, 502)
  }
  try {
    // 枚数の上限は登録と同じ文で確かめる（同時に送られても上限を超えないように）
    const ins = await db.prepare(`INSERT INTO consultation_attachments (consultation_id, company_id, message_id, storage_key, content_type, size_bytes, uploaded_by, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM consultation_attachments WHERE consultation_id = ? AND message_id IS ?) < ?
        AND (SELECT COUNT(*) FROM consultation_attachments WHERE consultation_id = ?) < ?`)
      .bind(co.consultation_id, co.company_id, messageId, key, photo.type, photo.size, u.user_id, nowJST(),
        co.consultation_id, messageId, CONSULT_PHOTOS_PER_POST, co.consultation_id, CONSULT_PHOTOS_MAX).run()
    if (!ins.meta.changes) {
      await c.env.PHOTOS.delete(key).catch(() => {})
      return c.json({ error: `写真は1回の送信に${CONSULT_PHOTOS_PER_POST}枚、1つの相談に${CONSULT_PHOTOS_MAX}枚までです` }, 409)
    }
    return c.json({ ok: true, attachment_id: ins.meta.last_row_id })
  } catch {
    await c.env.PHOTOS.delete(key).catch(() => {})
    return c.json({ error: '写真の登録に失敗しました。もう一度お試しください' }, 500)
  }
})

// 相談の写真の取得（本人の相談の写真だけ）
api.get('/staff/consultation-photo/:id{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const sids = (await consultPersonRows(db, u)).map(r => r.staff_id)
  const row = sids.length ? await db.prepare(`SELECT a.storage_key FROM consultation_attachments a JOIN consultations co ON co.consultation_id = a.consultation_id
    WHERE a.attachment_id = ? AND co.staff_id IN (SELECT value FROM json_each(?))`).bind(c.req.param('id'), JSON.stringify(sids)).first() as any : null
  if (!row) return c.json({ error: '写真が見つかりません' }, 404)
  return attendancePhotoResponse(c, row.storage_key)
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
// 未報告の一覧に添える相談の本文の長さ（#498）
const DASH_CONTACT_EXCERPT = 40
// ToDo に出す相談の上限（本文は返さない。#510）と、返信してから対応中のまま何日たったら ToDo に出すか（#403）
const DASH_CONSULT_LIMIT = 100
const DASH_CONSULT_WAIT_DAYS = 2
// 仮登録のまま本登録を促す目安: 登録からの日数・稼働の回数（#412）
const DASH_PROVISIONAL_DAYS = 7
const DASH_PROVISIONAL_SHIFTS = 2
// 繰り返し登録の終了を何日前から知らせるか（#456）
const DASH_PATTERN_END_DAYS = 14
// 有効期限が近い・切れた書類（#297。staff-self-service.ts の DOC_EXPIRY_WARN_DAYS と同じ日数）
const DASH_DOC_EXPIRY_DAYS = 30
// 今月の案件別実績で画面に出す項目の数（日報テンプレートの数値項目の先頭から。#184）
const DASH_PERF_FIELDS = 6
const DASH_WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']
// 人員不足の枠・希望（仮）のシフトを、今日から何日先まで見るか（#299）
const DASH_AHEAD_DAYS = 3
// 明日のシフトの前日確認の一覧に出す最大件数（#176）
const DASH_DAY_BEFORE_MAX = 300
// 契約終了を何日前から知らせるか（30日前と14日前の2段階）と、有給の次回付与日を何日前から・過ぎて何日まで知らせるか（#282）
const DASH_CONTRACT_DAYS = 30
const DASH_CONTRACT_SOON_DAYS = 14
const DASH_LEAVE_DAYS = 14
const DASH_LEAVE_OVERDUE_DAYS = 30
// 'YYYY-MM-DD HH:MM:SS' どうしの差（分）
function minutesBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.replace(' ', 'T') + 'Z') - Date.parse(from.replace(' ', 'T') + 'Z')) / 60000)
}
const mdLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

// 管理者ダッシュボード
api.get('/admin/dashboard', async (c) => {
  const u = c.get('user'); const today = todayJST(); const month = monthJST()
  const db = c.env.DB; const cid = u.company_id

  // 本日と前日のシフト + 勤怠状況（前日分は、日をまたぐ勤務の継続と勤務終了・退店の未報告に使う）
  const now = nowJST(); const yesterday = addDays(today, -1)
  const elig = assignableStaffSql({ sp: 'sp', us: 'us', onDate: today })
  const shifts = await db.prepare(`
    SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.unit_price, s.location, s.slot_role_id, s.settle_status,
           s.transportation_fee, s.bill_transport_type, s.bill_transport_amount, s.bill_adjust,
           p.project_id, p.project_name, us.name AS staff_name, us.phone AS staff_phone, us.role = 'staff' AS has_login,
           CASE WHEN ${elig.sql} THEN 0 ELSE 1 END AS staff_unavailable,
           EXISTS (SELECT 1 FROM shift_report_tokens t WHERE t.shift_id = s.shift_id AND t.staff_id = s.staff_id AND t.revoked = 0) AS has_report_link,
           (SELECT GROUP_CONCAT(ac.report_type) FROM attendance_corrections ac WHERE ac.shift_id = s.shift_id AND ac.status = 'pending') AS pending_types
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id
    JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date IN (?, ?) AND s.status IN ('confirmed','substitute','absent')
    ORDER BY s.work_date, s.start_time, p.project_name, us.name, s.shift_id`).bind(...elig.binds, cid, yesterday, today).all()

  const rows = shifts.results as any[]
  // 提出設定で「不要」の報告は未報告アラートの対象外（第2段階）
  const todayModes = await modesForShifts(db, rows.filter(s => s.status !== 'absent').map(s => s.shift_id))
  // 報告ごとの時刻・遅延・位置不明・遅刻と早退の分数（#348）。報告はシフトと種類で1件（uq_attendance_shift_type）
  // 電波がない場所で押して後から届いた報告は、押した時刻で記録したことと受け取った時刻も出す（#427）
  // 入店の位置が現場から離れている（#277。距離と会社のしきい値で判定。far と distance_m を入店の報告に付ける）
  const reportRows = rows.length ? (await db.prepare(`SELECT shift_id, report_type, reported_at, status, late_minutes, early_leave_minutes, time_source, received_at, corrected_by_correction_id, distance_m
    FROM attendance_reports WHERE shift_id IN ${JSON_IN}`).bind(bindJsonArray(rows.map(s => s.shift_id))).all()).results as any[] : []
  const reportsByShift = new Map<number, Record<string, any>>()
  for (const r of reportRows) {
    const m = reportsByShift.get(r.shift_id) || {}
    const dist = r.report_type === 'check_in' ? distanceResult(r.distance_m ?? null, u.settings_json) : null
    m[r.report_type] = { at: String(r.reported_at || '').slice(0, 16), status: r.status, late_minutes: Number(r.late_minutes) || 0, early_leave_minutes: Number(r.early_leave_minutes) || 0,
      ...(deviceTimeMark(r).device_time ? { device_time: true, received_at: String(r.received_at || '').slice(0, 16) } : {}),
      ...(dist && dist.far ? { far: true, distance_m: dist.distance_m } : {}) }
    reportsByShift.set(r.shift_id, m)
  }
  // 画面の報告状況の列: シフトごとの有効な報告と報告済みの種類
  for (const s of rows) {
    s.required_types = todayModes.get(s.shift_id)?.required_attendance ?? [...REPORT_TYPES]
    s.reports = reportsByShift.get(s.shift_id) || {}
    s.done_types = Object.keys(s.reports)
    s.has_login = !!s.has_login; s.has_report_link = !!s.has_report_link
    // 遅刻（入店・勤務開始のどちらか）・早退（勤務終了・退店の長い方）の分数と、休憩中（休憩入があり、休憩出・勤務終了・退店がない）
    const lateRep = ['check_in', 'work_start'].map(t => s.reports[t]).find((r: any) => r && r.status === 'late')
    s.late_minutes = lateRep ? lateRep.late_minutes : 0
    s.early_leave_minutes = Math.max(0, ...['work_end', 'check_out'].map(t => Number(s.reports[t]?.early_leave_minutes) || 0))
    s.no_location = s.reports.check_in?.status === 'no_location'
    s.on_break = !!s.reports.break_start && !s.reports.break_end && !s.reports.work_end && !s.reports.check_out
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
  // 売上予定は精算と同じ式（基本額＋請求交通費＋請求の調整額。shiftTotals）で数える（#414）
  const revenue = todayOnly.reduce((a, s) => a + shiftTotals(s).bill_total, 0)
  // 遅刻・欠勤・体調不良の相談（#498）。対象の日付があればその日（案件があればその案件）のシフト、
  // なければ送った日か前日（前の晩に送った連絡）のシフトに結び付け、未報告の一覧に『連絡あり』と出す
  const contacts = (await db.prepare(`
    SELECT co.consultation_id, co.staff_id, co.category, co.urgency, co.status, co.target_project_id, co.target_date, co.created_at,
      substr(co.body, 1, ${DASH_CONTACT_EXCERPT}) AS excerpt, length(co.body) > ${DASH_CONTACT_EXCERPT} AS truncated
    FROM consultations co
    WHERE co.company_id = ? AND co.category IN ('absence', 'health')
      AND (co.target_date IN (?, ?) OR (co.target_date IS NULL AND co.created_at >= ?))
    ORDER BY co.created_at DESC, co.consultation_id DESC LIMIT 200`).bind(cid, yesterday, today, `${addDays(yesterday, -1)} 00:00:00`).all()).results as any[]
  for (const s of rows) {
    const co = contacts.find(x => x.staff_id === s.staff_id && (x.target_date
      ? x.target_date === s.work_date && (!x.target_project_id || x.target_project_id === s.project_id)
      : [addDays(s.work_date, -1), s.work_date].includes(String(x.created_at).slice(0, 10))))
    s.contact = co ? { consultation_id: co.consultation_id, category: co.category, category_label: catLabel(co.category), urgency: co.urgency, status: co.status,
      excerpt: co.excerpt + (co.truncated ? '…' : ''), created_at: co.created_at } : null
  }
  // 未報告: 予定の時刻を過ぎたものだけ（起床・出発・入店は開始から、勤務終了・退店は終了から。#186）
  // 電話番号・ログインの有無・報告用URLの有無も添える（その場で電話・代理入力・URLの発行に進めるように。#343 #355）
  const unreportedItem = (s: any, dueAt: string, extra: any = {}) => ({
    shift_id: s.shift_id, staff_id: s.staff_id, name: s.staff_name, project: s.project_name, project_id: s.project_id, work_date: s.work_date,
    start_time: s.start_time, end_time: s.end_time, carried_over: s.carried_over, due_at: dueAt, overdue_minutes: minutesBetween(dueAt, now),
    phone: s.staff_phone || '', has_login: s.has_login, has_report_link: s.has_report_link,
    contact: s.contact, ...extra,
  })
  // 同じ日に同じ人の別のシフトで起床を報告していれば、起床は済みとする（#449）
  const wokeUp = new Set(rows.filter(s => s.done_types.includes('wake_up')).map(s => `${s.staff_id}:${s.work_date}`))
  // 一覧は人ごとにまとめる（同じ人の2つ目以降のシフトは件数だけ添える。#449）。連絡のない人を上にする（#498）
  const byPerson = (list: any[]) => {
    const m = new Map<number, any>()
    for (const x of list.sort((a, b) => b.overdue_minutes - a.overdue_minutes)) {
      const cur = m.get(x.staff_id)
      if (!cur) { m.set(x.staff_id, { ...x, other_shifts: 0 }); continue }
      cur.other_shifts++
      if (!cur.contact && x.contact) cur.contact = x.contact
    }
    // 経過時間が同じなら、開始時刻・案件・氏名の順（本日のシフトの表と同じ並び。#488）
    return [...m.values()].sort((a, b) => (a.contact ? 1 : 0) - (b.contact ? 1 : 0) || b.overdue_minutes - a.overdue_minutes
      || String(a.start_time).localeCompare(String(b.start_time)) || String(a.project).localeCompare(String(b.project), 'ja') || String(a.name).localeCompare(String(b.name), 'ja'))
  }
  const startDue = (s: any, t: string) => {
    const due = addMinutes(s.window.start, DASH_DUE_OFFSET[t])
    const dayStart = `${s.work_date} 00:00:00` // 報告は稼働日の 0:00 から受け付ける（shift-time.ts reportableWindow）
    return due < dayStart ? dayStart : due
  }
  // 前日から継続している勤務（23時台に始まる夜勤など）も対象にする
  const startList = (t: string) => byPerson(active
    .filter(s => missingOf(s, [t]).length && startDue(s, t) <= now && !(t === 'wake_up' && wokeUp.has(`${s.staff_id}:${s.work_date}`)))
    .map(s => unreportedItem(s, startDue(s, t))))
  // 勤務終了・退店: 本日と前日のシフト（日をまたがない前日分の退店漏れも含む）
  const endList = byPerson(working
    .filter(s => missingOf(s, DASH_END_TYPES).length && addMinutes(s.window.end, DASH_END_GRACE_MIN) <= now)
    .map(s => unreportedItem(s, s.window.end, { missing: missingOf(s, DASH_END_TYPES) })))
  // 本日の欠勤（代わりの手配に使う。#216）
  const absentToday = rows.filter(s => s.status === 'absent' && s.work_date === today)
  const unreported = { wake_up: startList('wake_up'), departure: startList('departure'), check_in: startList('check_in'), work_end: endList }
  // 本日の表の『未報告あり』の絞り込みと強調に使う、予定の時刻を過ぎた未報告の種類（未報告の一覧と同じ判定。#488）
  for (const s of active) {
    s.overdue_types = [
      ...['wake_up', 'departure', 'check_in'].filter(t => missingOf(s, [t]).length && startDue(s, t) <= now && !(t === 'wake_up' && wokeUp.has(`${s.staff_id}:${s.work_date}`))),
      ...(addMinutes(s.window.end, DASH_END_GRACE_MIN) <= now ? missingOf(s, DASH_END_TYPES) : []),
    ]
  }
  for (const s of rows) delete s.window

  // 昨日までの日報未提出 (直近3日)。代打も含め、シフトごとに判定する（shift_id の無い古い日報だけは稼働日・案件で照合）
  // 画面の一覧（日付・スタッフ・案件・電話。#344）に使う列も返す
  const missingReports = await db.prepare(`
    SELECT s.shift_id, s.work_date, s.start_time, s.end_time, us.name AS staff_name, s.staff_id, p.project_id, p.project_name,
      us.phone AS staff_phone, us.role = 'staff' AS has_login
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status IN ('confirmed','substitute') AND s.work_date < ? AND s.work_date >= date(?, '-3 days')
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id)
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE +dr.shift_id IS NULL AND dr.staff_id = s.staff_id AND dr.work_date = s.work_date AND dr.project_id = s.project_id)
    ORDER BY s.work_date DESC, s.start_time, p.project_name, us.name`).bind(cid, today, today).all()
  // 日報「不要」のシフトは未提出の対象外（第2段階）
  {
    const m = await modesForShifts(db, (missingReports.results as any[]).map(r => r.shift_id))
    missingReports.results = (missingReports.results as any[]).filter(r => m.get(r.shift_id)?.daily_report_required !== false)
  }

  // インシデント (直近7日)。対応状況（#169）を付け、対応済みでないものを先に並べる
  const incidents = await db.prepare(`
    SELECT dr.daily_report_id, dr.project_id, dr.work_date, dr.incident_flag, dr.complaint_flag, us.name AS staff_name, dr.staff_id, p.project_name, dr.report_values,
      COALESCE(dr.incident_status, 'open') AS incident_status, dr.incident_memo, dr.incident_client_shared_at, dr.incident_updated_at
    FROM daily_reports dr
    JOIN projects p ON dr.project_id = p.project_id
    JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ? AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date >= date(?, '-7 days')
    ORDER BY CASE WHEN ${DR_INCIDENT_OPEN_SQL} THEN 0 ELSE 1 END, dr.work_date DESC`).bind(cid, today).all()

  // 要フォロースタッフ。退職・統合済み・停止中などは出さない（#314）
  const followStaff = await db.prepare(`
    SELECT sp.staff_id, us.name, sp.retention_risk, sp.memo, sp.evaluation_score
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.company_id = ? AND (sp.follow_flag = 1 OR sp.retention_risk != 'low') AND ${elig.sql}
    ORDER BY CASE sp.retention_risk WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, sp.staff_id`).bind(cid, ...elig.binds).all()

  // 今月の案件別実績。項目は日報テンプレートの数値項目（固定のキーで集計しない。実績分析 loadAnalytics と同じ数え方。#184）
  const [perfRows, perfVals, perfTpls, unchecked] = (await db.batch([
    db.prepare(`SELECT p.project_id, p.project_name, COUNT(dr.daily_report_id) AS report_count
      FROM projects p LEFT JOIN daily_reports dr ON dr.project_id = p.project_id AND dr.company_id = p.company_id AND dr.work_date LIKE ?
      WHERE p.company_id = ? AND p.status = 'active' GROUP BY p.project_id ORDER BY p.project_id`).bind(month + '%', cid),
    db.prepare(`SELECT dr.project_id, je.key AS k, SUM(${ANALYTICS_NUM}) AS v, MAX(je.type IN ('integer','real')) AS isnum
      FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id AND p.company_id = dr.company_id AND p.status = 'active', ${ANALYTICS_JE}
      WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY dr.project_id, je.key`).bind(cid, month + '%'),
    db.prepare(`SELECT DISTINCT rt.template_id, rt.fields_json FROM projects p JOIN report_templates rt ON rt.template_id = p.report_template_id
      WHERE p.company_id = ? AND p.status = 'active' ORDER BY rt.template_id`).bind(cid),
    // 未確認の日報の件数（日報一覧の「未確認のみ」と同じ条件。#183）
    db.prepare(`SELECT COUNT(*) AS n FROM daily_reports dr WHERE dr.company_id = ? AND ${DR_UNCHECKED_SQL}`).bind(cid),
  ])).map(r => (r.results || []) as any[])
  const perfFields: { key: string; label: string }[] = []
  {
    const seen = new Set<string>(); const textKeys = new Set<string>()
    for (const t of perfTpls) {
      let defs: any[] = []
      try { defs = JSON.parse(t.fields_json) } catch { defs = [] }
      for (const f of Array.isArray(defs) ? defs : []) {
        if (!f || typeof f.key !== 'string' || !f.key) continue
        if (f.type !== 'number') { textKeys.add(f.key); continue }
        if (!seen.has(f.key)) { seen.add(f.key); perfFields.push({ key: f.key, label: String(f.label || f.key) }) }
      }
    }
    for (const r of perfVals) if (r.isnum && !seen.has(r.k) && !textKeys.has(r.k)) { seen.add(r.k); perfFields.push({ key: r.k, label: r.k }) }
  }
  const projectPerformance = perfRows.map(p => ({
    ...p, values: Object.fromEntries(perfFields.map(f => [f.key, Number(perfVals.find(r => r.project_id === p.project_id && r.k === f.key)?.v) || 0])),
  }))

  // 未完了の相談。ToDo の文言に要る列だけを読む（本文は返さない。#510）。
  // 対応中は、最後に返信した日時（返信の通知の日時。なければ受付日時）から数える（#403）
  const waitSince = addMinutes(now, -DASH_CONSULT_WAIT_DAYS * 1440)
  const consults = (await db.prepare(`
    SELECT * FROM (
      SELECT co.consultation_id, co.staff_id, co.category, co.urgency, co.status, co.created_at, us.name AS staff_name,
        (SELECT MAX(n.created_at) FROM user_notifications n WHERE n.related_id = co.consultation_id AND n.kind = '${CONSULT_REPLY_KIND}') AS replied_at
      FROM consultations co JOIN staff_profiles sp ON co.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
      WHERE co.company_id = ? AND co.status IN ('open', 'in_progress')
    ) WHERE status = 'open' OR COALESCE(replied_at, created_at) <= ?
    ORDER BY created_at DESC, consultation_id DESC LIMIT ?`).bind(cid, waitSince, DASH_CONSULT_LIMIT).all()).results as any[]
  const consultCounts = Object.fromEntries((((await db.prepare(`SELECT status, COUNT(*) AS n FROM consultations WHERE company_id = ? AND status IN ('open', 'in_progress') GROUP BY status`)
    .bind(cid).all()).results) as any[]).map(r => [r.status, Number(r.n) || 0]))

  // ===== 管理者ToDo (ルールベース) =====
  // key: ToDo ごとの安定したキー。mark: 件数・最新の ID など。『対応済み』『あとで』にした後で mark が増えたら、もう一度出す（#487）
  // actions: 画面に出す操作（done 対応済み / snooze あとで）。相談・打刻修正はそれぞれの画面で片付けるので、あとでだけにする
  type Todo = { key: string; mark: number; level: 'high' | 'mid'; text: string; staff_id?: number; href?: string; link_label?: string; actions: string[]; follow_id?: number }
  const todos: Todo[] = []
  const BOTH = ['done', 'snooze'], LATER = ['snooze']
  // ルール1: 日報未提出。件数はシフトの数、「n日連続」は稼働日の数で数える（直近3日のすべての日に未提出があれば連続）
  const drCounts: Record<string, { name: string; count: number; dates: Set<string>; staff_id: number; last: number }> = {}
  for (const m of missingReports.results as any[]) {
    const k = String(m.staff_id)
    drCounts[k] = drCounts[k] || { name: m.staff_name, count: 0, dates: new Set(), staff_id: m.staff_id, last: 0 }
    drCounts[k].count++
    drCounts[k].dates.add(m.work_date)
    drCounts[k].last = Math.max(drCounts[k].last, Number(m.shift_id))
  }
  for (const v of Object.values(drCounts)) {
    const days = v.dates.size
    const base = { key: `daily_report:${v.staff_id}`, mark: v.last, staff_id: v.staff_id, actions: BOTH }
    if (days >= 3) todos.push({ ...base, level: 'high', text: `${v.name}さんが${days}日連続で日報未提出です（${v.count}件）。面談してください。` })
    else if (v.count >= 1) todos.push({ ...base, level: 'mid', text: `${v.name}さんの日報が${v.count}件（${days}日分）未提出です。リマインドしてください。` })
  }
  // ルール16: 今日、現場から離れた場所で入店を報告した人（#277。位置ずれ）。シフトの詳細で距離を確かめる
  {
    const far = rows.filter((s: any) => s.work_date === today && s.reports?.check_in?.far)
    if (far.length) {
      const names = [...new Set(far.map((s: any) => s.staff_name))]
      todos.push({ key: `check_in_far:${today}`, mark: far.length, level: 'mid', actions: BOTH, href: '#shifts', link_label: 'シフト→',
        text: `今日、現場から離れた場所で入店を報告した人がいます（${names.slice(0, 5).join('、')}${names.length > 5 ? ` ほか${names.length - 5}名` : ''}）。位置ずれの理由を確認してください。` })
    }
  }
  // ルール2: 遅刻が月2回以上。入店・勤務開始のどちらかが遅刻と判定されたシフトの数（同じシフトの入店と勤務開始は1回。#497）
  const lateRows = await db.prepare(`
    SELECT s.staff_id, us.name, COUNT(DISTINCT a.shift_id) AS n FROM attendance_reports a
    JOIN shifts s ON s.shift_id = a.shift_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE a.company_id = ? AND a.report_type IN ('check_in', 'work_start') AND a.status = 'late' AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')
    GROUP BY s.staff_id HAVING n >= 2`).bind(cid, month + '%').all()
  // 前日確認を使っている会社は、明日のシフトの確認状況の一覧へ移れるようにする（#176）
  const dayBefore = dayBeforeSettings(u.settings_json)
  for (const r of lateRows.results as any[]) {
    todos.push({ key: `late:${r.staff_id}:${month}`, mark: Number(r.n), level: 'mid', text: `${r.name}さんが今月${r.n}回遅刻しています（入店・勤務開始の遅れ）。前日確認を強化してください。`, staff_id: r.staff_id, actions: BOTH,
      ...(dayBefore.enabled ? { href: '#dash-day-before', link_label: '前日確認→' } : {}) })
  }
  // ルール3: 欠勤が月2回以上
  const absRows = await db.prepare(`
    SELECT s.staff_id, us.name, COUNT(*) AS n FROM shifts s
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status = 'absent' AND s.work_date LIKE ? AND s.work_date <= ? GROUP BY s.staff_id HAVING n >= 2`).bind(cid, month + '%', today).all()
  for (const r of absRows.results as any[]) {
    todos.push({ key: `absent:${r.staff_id}:${month}`, mark: Number(r.n), level: 'high', text: `${r.name}さんの欠勤が今月${r.n}回です。離職リスク中として体調・状況確認をしてください。`, staff_id: r.staff_id, actions: BOTH })
  }
  // ルール4: インシデント増加案件。日報一覧をその案件・直近7日・インシデントで絞って開く（#402 #404）
  // 対応済みのインシデント・クレームは数えない（#169）
  const incByProj = new Map<number, { name: string; n: number; last: number }>()
  for (const i of incidents.results as any[]) {
    if (i.incident_status === 'done') continue
    const v = incByProj.get(i.project_id) || { name: i.project_name, n: 0, last: 0 }
    v.n++; v.last = Math.max(v.last, Number(i.daily_report_id))
    incByProj.set(i.project_id, v)
  }
  for (const [pid, v] of incByProj) {
    todos.push({ key: `incident:${pid}`, mark: v.last, level: v.n >= 2 ? 'high' : 'mid', actions: BOTH,
      text: `${v.name}で直近7日に未対応のインシデント/クレームが${v.n}件あります。内容を確認しクライアント共有を検討してください。`,
      href: `#reports/from=${addDays(today, -7)}&to=${today}&project=${pid}&flagged=1&open=1`, link_label: '日報→' })
  }
  // ルール5: 未対応の相談と、返信したまま対応中で止まっている相談。相談対応の画面でその相談を開く（#402 #403）
  for (const co of consults) {
    if (co.status === 'open') {
      todos.push({ key: `consult:${co.consultation_id}`, mark: 0, level: co.urgency === 'high' ? 'high' : 'mid', actions: LATER, staff_id: co.staff_id,
        text: `${co.staff_name}さんから相談（${catLabel(co.category)}）が届いています。返信してください。`, href: `#consult/${co.consultation_id}`, link_label: '返信→' })
    } else {
      const days = Math.max(DASH_CONSULT_WAIT_DAYS, Math.floor(minutesBetween(String(co.replied_at || co.created_at), now) / 1440))
      todos.push({ key: `consult_wait:${co.consultation_id}`, mark: 0, level: 'mid', actions: LATER, staff_id: co.staff_id,
        text: `${co.staff_name}さんの相談（${catLabel(co.category)}）が${co.replied_at ? '返信後' : '受付後'}${days}日、対応中のままです。解決したら対応済みにしてください。`,
        href: `#consult/${co.consultation_id}`, link_label: '確認→' })
    }
  }
  // ルール6: 承認待ちの打刻修正（#226）。最も古い申請から2日以上たっていれば high
  const pendCorr = await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(correction_id) AS last FROM attendance_corrections WHERE company_id = ? AND status = 'pending'`).bind(cid).first() as any
  if (pendCorr?.n > 0) {
    const days = pendCorr.oldest ? Math.max(0, Math.floor(minutesBetween(String(pendCorr.oldest), now) / 1440)) : 0
    todos.push({ key: 'corrections', mark: Number(pendCorr.last) || 0, level: days >= 2 ? 'high' : 'mid', actions: LATER, href: '#corrections', link_label: '確認→',
      text: `打刻修正の承認待ちが${pendCorr.n}件あります（最も古いものは${days ? days + '日前' : '24時間以内'}の申請）。確認してください。` })
  }
  // ルール7: 仮登録のまま、登録から日数がたった人・稼働が続いている人（#412）。電話番号が同じ本登録のスタッフがいれば統合の候補として添える
  const provisional = (await db.prepare(`
    SELECT sp.staff_id, us.name, substr(sp.created_at, 1, 10) AS created_date,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.company_id = sp.company_id AND s.status IN ('confirmed','substitute') AND s.work_date <= ?) AS worked,
      (SELECT COUNT(*) FROM staff_profiles sp2 JOIN users us2 ON us2.user_id = sp2.user_id
        WHERE sp2.company_id = sp.company_id AND sp2.staff_id != sp.staff_id AND sp2.merged_into_staff_id IS NULL AND COALESCE(sp2.is_provisional, 0) = 0
          AND COALESCE(us.phone, '') != '' AND us2.phone = us.phone) AS same_phone
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND sp.is_provisional = 1 AND ${elig.sql}
    ORDER BY sp.staff_id LIMIT 200`).bind(today, cid, ...elig.binds).all()).results as any[]
  for (const p of provisional) {
    const days = p.created_date ? Math.max(0, Math.floor(minutesBetween(`${p.created_date} 00:00:00`, `${today} 00:00:00`) / 1440)) : 0
    if (days < DASH_PROVISIONAL_DAYS && Number(p.worked) < DASH_PROVISIONAL_SHIFTS) continue
    todos.push({ key: `provisional:${p.staff_id}`, mark: 0, level: 'mid', staff_id: p.staff_id, actions: BOTH, link_label: '本登録→',
      text: `${p.name}さんが仮登録のままです（登録から${days}日・稼働${Number(p.worked)}回）。本登録してください。`
        + (Number(p.same_phone) ? `電話番号が同じスタッフが${Number(p.same_phone)}名います。同じ人なら統合してください。` : '') })
  }
  // ルール8: 次回対応日が今日までの、対応中のフォロー記録（#385）。担当者の名前を添える
  const followDue = (await db.prepare(`
    SELECT f.follow_id, f.staff_id, f.next_action, f.next_action_date, us.name AS staff_name, um.name AS manager_name
    FROM follow_logs f JOIN staff_profiles sp ON f.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id LEFT JOIN users um ON um.user_id = f.manager_id
    WHERE f.company_id = ? AND f.status = 'open' AND f.next_action_date IS NOT NULL AND f.next_action_date <= ?
    ORDER BY f.next_action_date, f.follow_id LIMIT 50`).bind(cid, today).all()).results as any[]
  for (const f of followDue) {
    const late = f.next_action_date < today
    todos.push({ key: `follow:${f.follow_id}`, mark: 0, level: late ? 'high' : 'mid', staff_id: f.staff_id, follow_id: f.follow_id, actions: BOTH,
      text: `${f.staff_name}さんのフォロー「${f.next_action || '次回対応'}」が${late ? mdLabel(f.next_action_date) + 'の期日を過ぎています' : '今日が期日です'}（担当: ${f.manager_name || '-'}）。` })
  }
  // ルール9: 終了日が近い繰り返し登録（#456）。続けるなら案件詳細の一覧から延長する
  const patterns = (await db.prepare(`
    SELECT sp.pattern_id, sp.weekdays, sp.date_to, sp.start_time, sp.end_time, p.project_id, p.project_name
    FROM slot_patterns sp JOIN projects p ON p.project_id = sp.project_id AND p.company_id = sp.company_id
    WHERE sp.company_id = ? AND p.status = 'active' AND sp.date_to BETWEEN ? AND ? ORDER BY sp.date_to LIMIT 50`)
    .bind(cid, today, addDays(today, DASH_PATTERN_END_DAYS)).all()).results as any[]
  for (const p of patterns) {
    const wd = String(p.weekdays || '').split(',').map(Number).filter(n => n >= 0 && n <= 6).map(n => DASH_WEEKDAY[n]).join('・')
    const left = Math.round(minutesBetween(`${today} 00:00:00`, `${p.date_to} 00:00:00`) / 1440)
    todos.push({ key: `pattern_end:${p.pattern_id}:${p.date_to}`, mark: 0, level: 'mid', actions: BOTH, href: `#projects/${p.project_id}`, link_label: '案件→',
      text: `${p.project_name}の繰り返し登録（${wd} ${p.start_time}〜${p.end_time}）が${mdLabel(p.date_to)}で終わります（${left ? 'あと' + left + '日' : '今日まで'}）。続ける場合は延長してください。` })
  }
  // ルール10・11: 今日から数日先までの人員不足の枠と、希望（仮）のままのシフト（#299）。mark は件数・最新のシフトID（増えたらもう一度出す）
  const ahead = await staffingGaps(db, cid, today, addDays(today, DASH_AHEAD_DAYS))
  if (ahead.short_role_count) {
    const soon = ahead.short_roles.some(r => r.work_date <= addDays(today, 1))
    todos.push({ key: `staffing_short:${today}`, mark: ahead.short_headcount, level: soon ? 'high' : 'mid', actions: LATER, href: '#dash-ahead', link_label: '一覧→',
      text: `${mdLabel(today)}〜${mdLabel(ahead.to)}に人員不足の枠が${ahead.short_role_count}件（${ahead.short_headcount}名分）あります。シフトボードで補充してください。` })
  }
  if (ahead.requested_shifts.length) {
    todos.push({ key: `requested:${today}`, mark: Math.max(...ahead.requested_shifts.map(s => Number(s.shift_id))), level: 'mid', actions: LATER, href: '#dash-ahead', link_label: '一覧→',
      text: `${mdLabel(today)}〜${mdLabel(ahead.to)}に希望（仮）のままのシフトが${ahead.requested_shifts.length}${ahead.requested_more ? '件以上' : '件'}あります。確定するか見送ってください。` })
  }
  // ルール12・13: 契約終了が近い社員（30日前・14日前）と、有給の次回付与日が近い社員（#282）。従業員管理を使えるロールだけに出す
  let hrAlerts: any[] = []
  if (HR_ROLES.includes(u.role)) {
    hrAlerts = (await db.prepare(`
      SELECT sp.staff_id, us.name, er.contract_end, er.paid_leave_granted_at,
        CASE WHEN er.paid_leave_granted_at > ? THEN er.paid_leave_granted_at ELSE date(er.paid_leave_granted_at, '+1 year') END AS next_leave_grant
      FROM employee_records er JOIN staff_profiles sp ON sp.staff_id = er.staff_id AND sp.company_id = er.company_id JOIN users us ON us.user_id = sp.user_id
      WHERE er.company_id = ? AND ${OWN_EMPLOYEE_COND} AND COALESCE(sp.employment_status, 'working') != 'retired' AND (us.retired_at IS NULL OR us.retired_at >= ?)
        AND ((er.contract_end IS NOT NULL AND er.contract_end <= ?)
          OR (er.paid_leave_granted_at IS NOT NULL AND (CASE WHEN er.paid_leave_granted_at > ? THEN er.paid_leave_granted_at ELSE date(er.paid_leave_granted_at, '+1 year') END) BETWEEN ? AND ?))
      ORDER BY er.contract_end, us.name LIMIT 100`).bind(today, cid, today, addDays(today, DASH_CONTRACT_DAYS), today, addDays(today, -DASH_LEAVE_OVERDUE_DAYS), addDays(today, DASH_LEAVE_DAYS)).all()).results as any[]
    for (const e of hrAlerts) {
      const href = `#employees/${Number(e.staff_id)}`
      if (e.contract_end && e.contract_end <= addDays(today, DASH_CONTRACT_DAYS)) {
        const left = Math.round(minutesBetween(`${today} 00:00:00`, `${e.contract_end} 00:00:00`) / 1440)
        // 30日前に『対応済み』にしても、14日前・期限切れでもう一度出す
        const stage = left < 0 ? 3 : left <= DASH_CONTRACT_SOON_DAYS ? 2 : 1
        todos.push({ key: `contract_end:${e.staff_id}:${e.contract_end}`, mark: stage, level: stage >= 2 ? 'high' : 'mid', actions: BOTH, href, link_label: '従業員→',
          text: left < 0 ? `${e.name}さんの契約終了日（${mdLabel(e.contract_end)}）を過ぎていますが、在職中のままです。契約の更新か退職の手続きを確認してください。`
            : `${e.name}さんの契約が${mdLabel(e.contract_end)}に終了します（${left ? 'あと' + left + '日' : '今日まで'}）。更新の確認をしてください。` })
      }
      if (e.next_leave_grant && e.next_leave_grant >= addDays(today, -DASH_LEAVE_OVERDUE_DAYS) && e.next_leave_grant <= addDays(today, DASH_LEAVE_DAYS)) {
        const past = e.next_leave_grant < today
        todos.push({ key: `paid_leave:${e.staff_id}:${e.next_leave_grant}`, mark: past ? 2 : 1, level: past ? 'high' : 'mid', actions: BOTH, href, link_label: '従業員→',
          text: past ? `${e.name}さんの有給の付与日（${mdLabel(e.next_leave_grant)}）を過ぎています。付与日数と残日数を従業員管理で更新してください。`
            : `${e.name}さんの有給の付与日（${mdLabel(e.next_leave_grant)}）が近づいています。付与日数を確認してください。` })
      }
    }
  }
  // ルール15: 有効期限が近い（DASH_DOC_EXPIRY_DAYS 日以内）・切れた書類（#297）。在籍中のスタッフの書類・取引先の書類と、
  // 従業員管理を使えるロールには入社時書類も数える。一覧は「スタッフの申請」の書類の欄（期限の一覧）で見る。mark は期限切れ・件数が増えたら出し直す
  {
    const limit = addDays(today, DASH_DOC_EXPIRY_DAYS)
    const docQ = [
      db.prepare(`SELECT COUNT(*) AS n, SUM(d.valid_until < ?) AS expired FROM staff_documents d JOIN staff_profiles sp ON sp.staff_id = d.staff_id JOIN users us ON us.user_id = sp.user_id
        WHERE d.company_id = ? AND d.valid_until IS NOT NULL AND d.valid_until <= ? AND us.status = 'active' AND COALESCE(sp.employment_status, 'working') != 'retired' AND sp.merged_into_staff_id IS NULL`).bind(today, cid, limit),
      db.prepare(`SELECT COUNT(*) AS n, SUM(d.valid_until < ?) AS expired FROM client_documents d JOIN clients cl ON cl.client_id = d.client_id AND cl.company_id = d.company_id
        WHERE d.company_id = ? AND d.valid_until IS NOT NULL AND d.valid_until <= ?`).bind(today, cid, limit),
      ...(HR_ROLES.includes(u.role) ? [db.prepare(`SELECT COUNT(*) AS n, SUM(d.valid_until < ?) AS expired FROM employee_documents d JOIN staff_profiles sp ON sp.staff_id = d.staff_id
        LEFT JOIN employee_records er ON er.staff_id = d.staff_id AND er.company_id = d.company_id
        WHERE d.company_id = ? AND d.valid_until IS NOT NULL AND d.valid_until <= ? AND er.employment_ended_at IS NULL AND COALESCE(sp.employment_status, 'working') != 'retired'`).bind(today, cid, limit)] : []),
    ]
    const res = (await db.batch(docQ)).map(r => (r.results?.[0] || {}) as any)
    const total = res.reduce((a, r) => a + Number(r.n || 0), 0), expired = res.reduce((a, r) => a + Number(r.expired || 0), 0)
    if (total) {
      todos.push({ key: 'docs_expiring', mark: expired * 10000 + total, level: expired ? 'high' : 'mid', actions: BOTH, href: '#staff-requests', link_label: '書類→',
        text: expired ? `有効期限が切れた書類が${expired}件あります（${DASH_DOC_EXPIRY_DAYS}日以内に切れるものを含めて${total}件）。資格証・身分証・契約書を更新してください。`
          : `${DASH_DOC_EXPIRY_DAYS}日以内に有効期限が切れる書類が${total}件あります。更新の準備をしてください。` })
    }
  }
  // ルール14: 前日確認（#176）。明日のシフト（確定・代打）の確認状況を返し、締切を過ぎても未確認の人がいれば ToDo に出す。
  // 確認の後にシフトが変わったものは未確認として数える（report-settings.ts の dayBeforeState）
  let dayBeforeOut: any = { enabled: false, deadline: dayBefore.deadline }
  if (dayBefore.enabled) {
    const tomorrow = addDays(today, 1)
    const list = ((await db.prepare(`
      SELECT s.shift_id, s.staff_id, s.project_id, s.work_date, s.start_time, s.end_time, s.site_id, s.location, s.day_before_confirmed_at, s.day_before_confirmed_key, s.day_before_confirmed_by,
        p.project_name, us.name AS staff_name, us.phone AS staff_phone, us.role = 'staff' AS has_login, cu.name AS confirmed_by_name
      FROM shifts s JOIN projects p ON s.project_id = p.project_id
      JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
      LEFT JOIN users cu ON cu.user_id = s.day_before_confirmed_by AND cu.company_id = s.company_id
      WHERE s.company_id = ? AND s.work_date = ? AND s.status IN ('confirmed', 'substitute')
      ORDER BY s.start_time, p.project_name, us.name, s.shift_id LIMIT ${DASH_DAY_BEFORE_MAX}`).bind(cid, tomorrow).all()).results as any[])
      .map(({ day_before_confirmed_at, day_before_confirmed_key, day_before_confirmed_by, ...s }) => {
        const st = dayBeforeState({ ...s, day_before_confirmed_at, day_before_confirmed_key })
        return { ...s, has_login: !!s.has_login, confirmed_at: st.confirmed_at, changed: st.changed,
          confirmed_by_name: st.confirmed_at && day_before_confirmed_by ? (s.confirmed_by_name || '管理者') : null }
      })
    const unconfirmedStaff = new Set(list.filter(s => !s.confirmed_at).map(s => s.staff_id))
    const pastDeadline = now >= `${today} ${dayBefore.deadline}:00`
    dayBeforeOut = { enabled: true, deadline: dayBefore.deadline, date: tomorrow, past_deadline: pastDeadline, shifts: list,
      unconfirmed_staff_count: unconfirmedStaff.size, staff_count: new Set(list.map(s => s.staff_id)).size }
    if (pastDeadline && unconfirmedStaff.size) {
      todos.push({ key: `day_before:${tomorrow}`, mark: unconfirmedStaff.size, level: 'high', actions: LATER, href: '#dash-day-before', link_label: '一覧→',
        text: `明日（${mdLabel(tomorrow)}）のシフトで、前日確認がまだの人が${unconfirmedStaff.size}名います（締切 ${dayBefore.deadline}）。電話などで稼働を確認してください。` })
    }
  }
  // 『対応済み』『あとで』にした ToDo は分けて返す（画面ではたたんで出し、元に戻せる）
  const dismissals = new Map(((await db.prepare(`SELECT d.todo_key, d.action, d.mark, d.until_at, d.created_at, um.name AS user_name
    FROM todo_dismissals d LEFT JOIN users um ON um.user_id = d.user_id WHERE d.company_id = ? AND (d.action = 'done' OR d.until_at > ?)`).bind(cid, now).all()).results as any[])
    .map(d => [String(d.todo_key), d]))
  const visible: Todo[] = [], hidden: any[] = []
  for (const t of todos) {
    const d = dismissals.get(t.key)
    if (d && Number(d.mark) >= t.mark) hidden.push({ ...t, dismissed: { action: d.action, until_at: d.until_at, user_name: d.user_name, created_at: d.created_at } })
    else visible.push(t)
  }
  const byLevel = (a: Todo, b: Todo) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1)

  return c.json({
    today, month, now,
    // 稼働予定は人数（同じ人の複数のシフトは1名）とシフトの数を分けて返す（#449）
    working_count: new Set(todayOnly.map(s => s.staff_id)).size,
    working_shift_count: todayOnly.length,
    revenue_forecast: revenue,
    shifts: active,
    absent_shifts: absentToday,
    unreported,
    missing_daily_reports: (missingReports.results as any[]).map(r => ({ ...r, has_login: !!r.has_login })),
    unchecked_daily_reports: Number(unchecked[0]?.n) || 0,
    staffing_ahead: ahead,
    // 明日のシフトの前日確認（#176。使っていない会社は enabled: false だけ）
    day_before: dayBeforeOut,
    incidents: (incidents.results as any[]).map(({ report_values, ...i }) => {
      let values: any = {}
      try { values = JSON.parse(report_values) || {} } catch { values = {} }
      return { ...i, values }
    }),
    follow_staff: followStaff.results,
    performance_fields: perfFields.slice(0, DASH_PERF_FIELDS),
    performance_field_count: perfFields.length,
    project_performance: projectPerformance,
    consultation_counts: { open: consultCounts.open || 0, in_progress: consultCounts.in_progress || 0 },
    todos: visible.sort(byLevel),
    hidden_todos: hidden.sort(byLevel),
    photo_required_attendance: getCompanySetting(u, 'photo_required_attendance', true),
    photo_required_changed: photoRequiredLastChange(u),
  })
})

// ToDo を『対応済み』『あとで』にする（#487）。キーは GET /admin/dashboard が返した key と mark をそのまま送る。
// あとでは days 日後の 0:00 まで（既定は明日まで）出さない。mark より大きくなった（新しい遅刻などが増えた）ら、もう一度出す
const TODO_KEY_RE = /^[a-z_]{1,30}(:[0-9A-Za-z_-]{1,20}){0,3}$/
api.post('/admin/dashboard/todos', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  if (typeof b.key !== 'string' || !TODO_KEY_RE.test(b.key)) return c.json({ error: 'ToDo の指定が正しくありません' }, 400)
  if (!oneOf(b.action, ['done', 'snooze'] as const)) return c.json({ error: '操作が正しくありません' }, 400)
  const mark = b.mark == null ? 0 : toInt(b.mark, 0)
  if (mark == null) return c.json({ error: 'ToDo の指定が正しくありません' }, 400)
  const days = b.action === 'snooze' ? (b.days == null ? 1 : toInt(b.days, 1, 30)) : null
  if (b.action === 'snooze' && days == null) return c.json({ error: '日数は1〜30で指定してください' }, 400)
  const now = nowJST()
  const until = days ? `${addDays(todayJST(), days)} 00:00:00` : null
  await db.batch([
    db.prepare(`INSERT INTO todo_dismissals (company_id, todo_key, action, mark, until_at, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, todo_key) DO UPDATE SET action = excluded.action, mark = excluded.mark, until_at = excluded.until_at, user_id = excluded.user_id, created_at = excluded.created_at`)
      .bind(u.company_id, b.key, b.action, mark, until, u.user_id, now),
    // 期限の過ぎた『あとで』と、半年より前の『対応済み』は片付ける
    db.prepare(`DELETE FROM todo_dismissals WHERE company_id = ? AND ((action = 'snooze' AND until_at < ?) OR (action = 'done' AND created_at < ?))`)
      .bind(u.company_id, addMinutes(now, -7 * 1440), addMinutes(now, -180 * 1440)),
  ])
  return c.json({ ok: true, key: b.key, action: b.action, until_at: until, user_name: u.name, created_at: now })
})
// 元に戻す（もう一度 ToDo に出す）
api.delete('/admin/dashboard/todos', async (c) => {
  const u = c.get('user')
  const key = c.req.query('key') || ''
  if (!TODO_KEY_RE.test(key)) return c.json({ error: 'ToDo の指定が正しくありません' }, 400)
  await c.env.DB.prepare('DELETE FROM todo_dismissals WHERE company_id = ? AND todo_key = ?').bind(u.company_id, key).run()
  return c.json({ ok: true })
})

// 入店/退店報告の写真添付必須設定（会社全体）。変更した人・日時を settings_json の photo_required_history に残す（新しい順に最大10件。#405）
const PHOTO_REQUIRED_HISTORY_MAX = 10
function photoRequiredHistory(settingsJson: any): any[] {
  try {
    const h = JSON.parse(settingsJson || '{}').photo_required_history
    return Array.isArray(h) ? h.slice(0, PHOTO_REQUIRED_HISTORY_MAX) : []
  } catch { return [] }
}
function photoRequiredLastChange(u: any) {
  const h = photoRequiredHistory(u.settings_json)[0]
  return h ? { enabled: !!h.enabled, at: String(h.at || ''), name: String(h.name || '') } : null
}
// 現在の設定・変更の記録と、変更の影響範囲（会社の設定に従う案件の数・案件ごとに上書きしている案件の数）
api.get('/admin/settings/photo-required', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  const cnt = await c.env.DB.prepare(`SELECT SUM(photo_required_override IS NULL) AS follow, SUM(photo_required_override = 1) AS on_count, SUM(photo_required_override = 0) AS off_count
    FROM projects WHERE company_id = ? AND status = 'active'`).bind(u.company_id).first() as any
  return c.json({
    enabled: getCompanySetting({ settings_json: row?.settings_json }, 'photo_required_attendance', true),
    history: photoRequiredHistory(row?.settings_json).map(h => ({ enabled: !!h.enabled, at: String(h.at || ''), name: String(h.name || '') })),
    projects: { follow: Number(cnt?.follow) || 0, required: Number(cnt?.on_count) || 0, not_required: Number(cnt?.off_count) || 0 },
    can_edit: canEditAttendanceSettings(u),
  })
})
api.post('/admin/settings/photo-required', async (c) => {
  const u = c.get('user')
  if (!canEditAttendanceSettings(u)) return c.json({ error: ATTENDANCE_SETTING_DENIED, code: 'role_forbidden' }, 403)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return c.json({ error: '不正なパラメータです' }, 400)

  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  let settings: Record<string, any> = {}
  try { settings = JSON.parse((row?.settings_json as string) || '{}') } catch { settings = {} }
  const before = typeof settings.photo_required_attendance === 'boolean' ? settings.photo_required_attendance : true
  if (before === body.enabled) return c.json({ ok: true, photo_required_attendance: body.enabled, unchanged: true })
  const entry = { enabled: body.enabled, at: nowJST(), user_id: u.user_id, name: u.name }
  const history = [entry, ...photoRequiredHistory(row?.settings_json)].slice(0, PHOTO_REQUIRED_HISTORY_MAX)
  // この2項目だけを書き換える（同じ時に保存されたほかの設定（遅刻の猶予など）を古い内容で上書きしないように。#405）
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END,
      '$.photo_required_attendance', json(?), '$.photo_required_history', json(?)) WHERE company_id = ?`)
    .bind(JSON.stringify(body.enabled), JSON.stringify(history), u.company_id).run()

  return c.json({ ok: true, photo_required_attendance: body.enabled, changed: { enabled: entry.enabled, at: entry.at, name: entry.name } })
})

// 遅刻の猶予（分）。入店・勤務開始が開始時刻から何分以内なら遅刻にしないか（report-settings.ts の lateness。#497）。
// 基準はシフトの開始時刻。案件ごとに上書きできる（projects.late_grace_minutes。NULL なら会社の値）。
// projects は稼働中の案件と、終了した案件のうち上書きしているもの（late_grace_minutes が null なら会社の値に従う）
api.get('/admin/settings/lateness', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  const projects = (await c.env.DB.prepare(`SELECT project_id, project_name, status, late_grace_minutes FROM projects
    WHERE company_id = ? AND (COALESCE(status, 'active') = 'active' OR late_grace_minutes IS NOT NULL)
    ORDER BY CASE WHEN COALESCE(status, 'active') = 'active' THEN 0 ELSE 1 END, project_name, project_id`).bind(u.company_id).all()).results as any[]
  return c.json({ ...latenessSettings(row?.settings_json), max_grace_minutes: MAX_LATE_GRACE_MINUTES, can_edit: canEditAttendanceSettings(u),
    projects: projects.map(p => ({ project_id: p.project_id, project_name: p.project_name, status: p.status || 'active', late_grace_minutes: p.late_grace_minutes ?? null })) })
})
// 案件ごとの遅刻の猶予の上書き（#497）。grace_minutes: 0〜MAX_LATE_GRACE_MINUTES の整数、null なら会社の値に従う。これから記録する報告に効く
api.put('/admin/projects/:id/lateness', async (c) => {
  const u = c.get('user')
  if (!canEditAttendanceSettings(u)) return c.json({ error: ATTENDANCE_SETTING_DENIED, code: 'role_forbidden' }, 403)
  const body = await c.req.json().catch(() => ({} as any))
  const g = body.grace_minutes
  if (g !== null && !validGraceMinutes(g)) return c.json({ error: `遅刻の猶予は 0〜${MAX_LATE_GRACE_MINUTES} 分の整数で入力してください（空欄なら会社の設定に従います）` }, 400)
  const r = await c.env.DB.prepare('UPDATE projects SET late_grace_minutes = ? WHERE project_id = ? AND company_id = ?').bind(g, c.req.param('id'), u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '案件が見つかりません' }, 404)
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  return c.json({ ok: true, late_grace_minutes: g, effective_grace_minutes: latenessSettings(row?.settings_json, g).grace_minutes })
})
api.put('/admin/settings/lateness', async (c) => {
  const u = c.get('user')
  if (!canEditAttendanceSettings(u)) return c.json({ error: ATTENDANCE_SETTING_DENIED, code: 'role_forbidden' }, 403)
  const body = await c.req.json().catch(() => ({} as any))
  const g = body.grace_minutes
  if (!Number.isInteger(g) || g < 0 || g > MAX_LATE_GRACE_MINUTES) return c.json({ error: `遅刻の猶予は 0〜${MAX_LATE_GRACE_MINUTES} 分の整数で入力してください` }, 400)
  // ほかの設定（写真必須など）を上書きしないよう、この項目だけを書き換える。これから記録する報告に効く（記録済みの報告は判定し直さない）
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.late_grace_minutes', ?) WHERE company_id = ?`)
    .bind(g, u.company_id).run()
  return c.json({ ok: true, grace_minutes: g })
})

// 会社の緊急連絡先（#173）と、入店の位置が現場から離れているとみなす距離（m。0 は判定しない。#277）
api.get('/admin/settings/site-contact', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT emergency_phone, emergency_note, settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ emergency_phone: row?.emergency_phone || '', emergency_note: row?.emergency_note || '', far_threshold_m: farThresholdMeters(row?.settings_json),
    min_threshold_m: CHECK_IN_FAR_MIN_METERS, max_threshold_m: CHECK_IN_FAR_MAX_METERS })
})
api.put('/admin/settings/site-contact', async (c) => {
  const u = c.get('user')
  const body = await c.req.json().catch(() => ({} as any))
  const phone = emergencyPhone(body.emergency_phone), note = emergencyNote(body.emergency_note)
  if (phone && typeof phone === 'object') return c.json({ error: phone.error }, 400)
  if (note && typeof note === 'object') return c.json({ error: note.error }, 400)
  const th = body.far_threshold_m
  if (!Number.isInteger(th) || (th !== 0 && (th < CHECK_IN_FAR_MIN_METERS || th > CHECK_IN_FAR_MAX_METERS))) {
    return c.json({ error: `現場から離れているとみなす距離は 0（判定しない）か ${CHECK_IN_FAR_MIN_METERS}〜${CHECK_IN_FAR_MAX_METERS} m の整数で入力してください` }, 400)
  }
  // ほかの設定を上書きしないよう、settings_json はこの項目だけを書き換える
  await c.env.DB.prepare(`UPDATE companies SET emergency_phone = ?, emergency_note = ?,
      settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.check_in_far_meters', ?) WHERE company_id = ?`)
    .bind(phone, note, th, u.company_id).run()
  return c.json({ ok: true, emergency_phone: phone || '', emergency_note: note || '', far_threshold_m: th })
})

function catLabel(cat: string): string {
  const m: Record<string, string> = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
  return m[cat] || cat
}

// スタッフ一覧
api.get('/admin/staff', async (c) => {
  const u = c.get('user'); const [mFrom, mTo] = monthBounds(monthJST()); const today = todayJST()
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
           -- 最後にアプリを使った日時（ログイン・操作。#286 #491）。他社から連携したスタッフは所属元のログインで使うので、連携元の行も見る
           us.last_login_at,
           NULLIF(MAX(COALESCE(us.last_login_at, ''), COALESCE(us.last_seen_at, ''),
             CASE WHEN sp.affiliation_type = 'linked_external' THEN MAX(COALESCE(srcu.last_login_at, ''), COALESCE(srcu.last_seen_at, '')) ELSE '' END), '') AS app_last_used_at,
           CASE WHEN ${elig.sql} THEN 1 ELSE 0 END AS assignable,
           (SELECT COUNT(DISTINCT s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date >= ? AND s.work_date < ? AND s.status IN ('confirmed','substitute')) AS month_days,
           (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date <= ? AND s.status IN ('confirmed','substitute')) AS last_work_date,
           (SELECT MAX(dr.work_date) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id) AS last_report_date,
           -- 本日未入店の絞り込みに使う: 欠勤・希望（仮）のシフトは数えない（#85）
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date = ? AND s.status IN ('confirmed','substitute')) AS today_shift,
           (SELECT COUNT(*) FROM attendance_reports a JOIN shifts s2 ON a.shift_id = s2.shift_id WHERE a.staff_id = sp.staff_id AND s2.work_date = ? AND s2.status IN ('confirmed','substitute') AND a.report_type IN ('check_in','work_start')) AS today_checkin,
           (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id AND dr.work_date >= ? AND dr.work_date < ?) AS month_seiyaku,
           (SELECT GROUP_CONCAT(DISTINCT p.project_name) FROM shifts s3 JOIN projects p ON s3.project_id = p.project_id WHERE s3.staff_id = sp.staff_id AND s3.work_date >= ? AND s3.work_date < ?) AS projects,
           -- 有効期限が30日以内・切れた書類の数（#297。一覧の絞り込みに使う）
           (SELECT COUNT(*) FROM staff_documents d WHERE d.staff_id = sp.staff_id AND d.company_id = sp.company_id AND d.valid_until IS NOT NULL AND d.valid_until <= ?) AS doc_expiring
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    LEFT JOIN users srcu ON srcu.user_id = src.user_id
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ? ORDER BY sp.staff_id`).bind(...elig.binds, mFrom, mTo, today, today, today, mFrom, mTo, mFrom, mTo, addDays(today, DASH_DOC_EXPIRY_DAYS), u.company_id).all()
  return c.json({ staff: rows.results })
})

// スタッフを選ぶための軽い一覧（シフト登録・シフトボード・NGスタッフの選択肢。#463）。集計はしない。
// 既定は今日の時点で割り当てられる人だけ。?include=all で、統合済み・スキルシートのみ以外の全員（退職・休職を含む）を返す
api.get('/admin/staff/options', async (c) => {
  const u = c.get('user')
  const all = c.req.query('include') === 'all'
  const elig = assignableStaffSql({ sp: 'sp', us: 'us' })
  const rows = await c.env.DB.prepare(`
    SELECT sp.staff_id, us.name,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana,
           COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type, COALESCE(sp.employment_status, 'working') AS employment_status, us.status,
           CASE WHEN ${elig.sql} THEN 1 ELSE 0 END AS assignable
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    WHERE sp.company_id = ? AND sp.merged_into_staff_id IS NULL AND COALESCE(sp.affiliation_type, 'own_employee') != 'skillsheet_only'
      ${all ? '' : `AND ${elig.sql}`}
    ORDER BY us.name, sp.staff_id`).bind(...elig.binds, u.company_id, ...(all ? [] : elig.binds)).all()
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
    db.prepare(`SELECT e.*, ev.name AS evaluator_name FROM evaluations e LEFT JOIN users ev ON ev.user_id = e.evaluator_id
      WHERE e.staff_id = ? AND e.company_id = ? ORDER BY e.evaluation_period DESC, e.evaluation_id DESC LIMIT 6`).bind(sid, u.company_id).all(),
    db.prepare(`SELECT f.*, um.name AS manager_name FROM follow_logs f LEFT JOIN users um ON f.manager_id = um.user_id WHERE f.staff_id = ? ORDER BY f.created_at DESC LIMIT 20`).bind(sid).all(),
  ])
  // 月次実績推移: 今月と前の2か月を新しい順に、日報のない月も0の行として返す（#550）
  const months = [0, 1, 2].map(i => { const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - i, 1)); return d.toISOString().slice(0, 7) })
  const perfRows = await db.prepare(`
    SELECT substr(work_date, 1, 7) AS ym,
      SUM(COALESCE(json_extract(report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(report_values,'$.seiyaku'),0)) AS seiyaku,
      COUNT(*) AS days
    FROM daily_reports WHERE staff_id = ? AND work_date >= ? AND work_date < ? GROUP BY ym`).bind(sid, months[2] + '-01', monthBounds(months[0])[1]).all()
  const perfBy = new Map((perfRows.results as any[]).map(r => [r.ym, r]))
  // テンプレートの数値項目の合計（#184。values。項目の並びとラベルは performance_fields）。mnp などの固定の列は今の画面のために残す
  const metrics = await reportMetricSums(db, 'dr.staff_id = ? AND dr.work_date >= ? AND dr.work_date < ?', [sid, months[2] + '-01', monthBounds(months[0])[1]], 'substr(dr.work_date, 1, 7)')
  const perf = months.map(ym => ({ ...(perfBy.get(ym) || { ym, mnp: 0, pi: 0, shinki: 0, hikari: 0, seiyaku: 0, days: 0 }), values: metrics.valuesOf(ym) }))

  return c.json({
    profile: { ...profile, age: calcAge(profile.date_of_birth as string | null) },
    shifts: [...(upcoming.results as any[])].reverse().concat(past.results as any[]),
    upcoming_shifts: upcoming.results, past_shifts: past.results, today,
    ng_clients: ngClients.results,
    attendance: attendance.results,
    reports: (reports.results as any[]).map(r => ({ ...r, values: JSON.parse(r.report_values) })),
    evaluations: evals.results,
    follow_logs: follows.results,
    performance: perf, performance_fields: metrics.fields,
  })
})

// ---------- スタッフ評価（#164） ----------
// 期間（YYYY-MM）ごとに6項目（1〜5）とコメントを登録する。同じ期間は上書き。
// 登録・削除のたびに、最新の期間の6項目の平均を総合評価（staff_profiles.evaluation_score）に入れる（評価がなくなれば 0 = 未評価）
const EVAL_SCORE_KEYS = ['attendance_score', 'report_score', 'performance_score', 'client_score', 'growth_score', 'retention_score'] as const
function evaluationScoreStmt(db: D1Database, companyId: number, staffId: number) {
  return db.prepare(`UPDATE staff_profiles SET evaluation_score = COALESCE((SELECT ROUND((${EVAL_SCORE_KEYS.join(' + ')}) / 6.0, 1) FROM evaluations
      WHERE company_id = ?1 AND staff_id = ?2 ORDER BY evaluation_period DESC, evaluation_id DESC LIMIT 1), 0)
    WHERE staff_id = ?2 AND company_id = ?1`).bind(companyId, staffId)
}
api.post('/admin/staff/:id/evaluations', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const sp = await ownStaff(db, u.company_id, c.req.param('id')) as any
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (sp.merged_into_staff_id) return c.json({ error: '統合済みのスタッフです。統合先のスタッフで評価を登録してください' }, 400)
  const b = await c.req.json().catch(() => null) as any
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const period = String(b.evaluation_period ?? '')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return c.json({ error: '評価の期間（年月）を選んでください' }, 400)
  // 先の月の評価は付けない（来月まで。月末に翌月分を準備する運用を考えて1か月先までは受け付ける）
  const [ny, nm] = monthJST().split('-').map(Number)
  const maxMonth = nm === 12 ? `${ny + 1}-01` : `${ny}-${String(nm + 1).padStart(2, '0')}`
  if (period > maxMonth || period < '2000-01') return c.json({ error: '評価の期間が正しくありません' }, 400)
  const scores: number[] = []
  for (const k of EVAL_SCORE_KEYS) {
    const n = toInt(b[k], 1, 5)
    if (n === null) return c.json({ error: '評価の各項目は1〜5で選んでください' }, 400)
    scores.push(n)
  }
  const comment = b.comment == null || String(b.comment).trim() === '' ? null : String(b.comment).trim()
  if (comment && comment.length > 1000) return c.json({ error: 'コメントは1000文字以内で入力してください' }, 400)
  const now = nowJST(); const sid = Number(sp.staff_id)
  const setSql = EVAL_SCORE_KEYS.map(k => `${k} = ?`).join(', ')
  // 同じ期間の行があれば上書きし、なければ作る（1回の batch で行い、途中で失敗しても片方だけにならないようにする）
  const res = await db.batch([
    db.prepare(`UPDATE evaluations SET ${setSql}, comment = ?, evaluator_id = ?, updated_at = ? WHERE company_id = ? AND staff_id = ? AND evaluation_period = ?`)
      .bind(...scores, comment, u.user_id, now, u.company_id, sid, period),
    db.prepare(`INSERT INTO evaluations (company_id, staff_id, evaluator_id, evaluation_period, ${EVAL_SCORE_KEYS.join(', ')}, comment, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM evaluations WHERE company_id = ? AND staff_id = ? AND evaluation_period = ?)`)
      .bind(u.company_id, sid, u.user_id, period, ...scores, comment, now, u.company_id, sid, period),
    evaluationScoreStmt(db, u.company_id, sid),
  ])
  const score = await db.prepare('SELECT evaluation_score FROM staff_profiles WHERE staff_id = ?').bind(sid).first() as any
  return c.json({ ok: true, updated: Number(res[0].meta?.changes || 0) > 0, evaluation_score: Number(score?.evaluation_score || 0) })
})
api.delete('/admin/staff/:id/evaluations/:eid', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const sp = await ownStaff(db, u.company_id, c.req.param('id')) as any
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const sid = Number(sp.staff_id)
  const res = await db.batch([
    db.prepare('DELETE FROM evaluations WHERE evaluation_id = ? AND staff_id = ? AND company_id = ?').bind(c.req.param('eid'), sid, u.company_id),
    evaluationScoreStmt(db, u.company_id, sid),
  ])
  if (!Number(res[0].meta?.changes || 0)) return c.json({ error: '評価が見つかりません' }, 404)
  const score = await db.prepare('SELECT evaluation_score FROM staff_profiles WHERE staff_id = ?').bind(sid).first() as any
  return c.json({ ok: true, evaluation_score: Number(score?.evaluation_score || 0) })
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
  if (roster.affiliation_type === 'partner_manual' && body.affiliation && body.affiliation !== roster.affiliation) {
    const conflict = await partnerNameConflict(c.env.DB, u.company_id, body.affiliation)
    if (conflict) return conflict
    // 所属会社は登録済みの取引先から選ぶ（#161。自由入力の名前を取引先として自動で登録すると、表記ゆれが別の支払先になるため）
    const known = await c.env.DB.prepare('SELECT 1 FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ? AND merged_into_id IS NULL').bind(u.company_id, body.affiliation).first()
    if (!known) return `協力会社「${body.affiliation}」は登録されていません。スタッフマスタの「協力会社の管理」で登録してから選んでください`
  }
  return null
}
// 基本情報・追記項目・在籍状況を保存する（権限チェックは呼び出し側で実施済みであること）
async function applyProfileUpdate(c: any, sid: string, body: any, roster: any) {
  const u = c.get('user')
  const { retired_at, affiliation, employment_status } = body
  // 氏名は変わったときだけ保存し、連携先の表示名をそろえる（#482。従業員管理の保存は毎回氏名を送るため）
  if (body.name !== undefined && String(body.name).trim() !== String(roster.name ?? '')) {
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

  // 稼働先追記項目（所属元にも共有される: 現場評価・稼働メモ）。変わったときだけ保存し、履歴に残して所属元に知らせる（#538）
  if (body.site_evaluation !== undefined || body.work_memo !== undefined) {
    const stmts = hostNoteStmts(c.env.DB, roster, body.site_evaluation, body.work_memo, u.user_id)
    if (stmts.length) await c.env.DB.batch(stmts)
  }

  // 取引先所属スタッフの所属会社名を変更した場合は、取引先マスタ（staff_affiliations）のIDも追従させる。
  // 取引先は登録済みのものだけ（validateProfileBase で確認済み。#161 以降は自由入力の名前を自動で登録しない）
  if (roster.affiliation_type === 'partner_manual' && affiliation) {
    const partner = `(SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ? AND merged_into_id IS NULL)`
    // 今日以降の未確定の予定シフトの支払先も新しい取引先にそろえる（#28。精算はシフトの payee_affiliation_id で支払先を決めるため）
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE staff_profiles SET partner_affiliation_id = ${partner} WHERE staff_id = ? AND company_id = ?`).bind(u.company_id, affiliation, sid, u.company_id),
      c.env.DB.prepare(`UPDATE shifts SET payee_affiliation_id = ${partner}
        WHERE staff_id = ? AND company_id = ? AND work_date >= ? AND payee_type = 'partner' AND status != 'absent' AND COALESCE(settle_status,'planned') != 'confirmed'
          AND payee_affiliation_id IS NOT ${partner}`).bind(u.company_id, affiliation, sid, u.company_id, todayJST(), u.company_id, affiliation),
    ])
  }

  if (retired_at !== undefined || employment_status !== undefined) await applyRetirement(c.env.DB, sid, u.company_id, roster, retired_at, employment_status)
  await logProfileChanges(c, sid, body, roster)
}
// スタッフ基本情報の変更履歴（#464）。送られてきた項目だけを、保存した後の値と保存前（roster）の値で比べる
// （退職日・在籍状況は applyRetirement で決まった値を残すため、保存した後に読み直す）。履歴の失敗で保存は取り消さない
async function logProfileChanges(c: any, sid: string, body: any, roster: any) {
  // 退職日・在籍状況はどちらかを送ると、もう一方も変わることがあるので両方を比べる
  const retire = body.retired_at !== undefined || body.employment_status !== undefined
  const fields = PROFILE_LOG_FIELDS.filter(k => body[k] !== undefined || (retire && (k === 'retired_at' || k === 'employment_status')))
  if (!fields.length) return
  const u = c.get('user')
  try {
    const after = await c.env.DB.prepare(`SELECT sp.*, us.name, us.retired_at FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
      WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(sid, u.company_id).first() as any
    if (!after) return
    const saved: Record<string, any> = {}
    for (const k of fields) saved[k] = after[k] ?? null
    // 在籍状況の NULL は在職中として扱う
    if (fields.includes('employment_status')) saved.employment_status = saved.employment_status || 'working'
    const changes = diffFields({ ...roster, employment_status: roster.employment_status || 'working' }, saved, fields)
    if (changes.length) await c.env.DB.batch(changeLogStmts(c.env.DB, { companyId: u.company_id, staffId: sid, source: 'profile', changedBy: u.user_id, at: nowJST(), changes }))
  } catch (e) { console.log(`profile change log failed: staff=${sid}: ${e}`) }
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
/**
 * 登録情報の変更申請（#272）を承認したときに反映する（src/staff-self-service.ts から呼ぶ）。
 * スタッフマスタ・従業員管理の保存と同じ確認（値の形・必須項目・メールの重複）と保存（applyProfileUpdate・applyContactUpdate）を通す。
 * 申請先は所属元の行なので、自社雇用の最寄駅もここで反映する（従業員管理で直すのと同じ扱い）
 */
async function applyApprovedProfileChange(c: any, sid: string, changes: Record<string, any>): Promise<{ error: string; status: 400 | 403 | 404 | 409 } | { ok: true; login_email?: any }> {
  const u = c.get('user')
  const roster = await loadRoster(c.env.DB, sid, u.company_id)
  if (!roster) return { error: 'スタッフが見つかりません', status: 404 }
  if (roster.merged_into_staff_id) return { error: '統合済みのスタッフのため反映できません（統合先のスタッフで編集してください）', status: 409 }
  if (roster.affiliation_type === 'linked_external' || !roster.can_edit_base) return { error: '基本項目は所属元企業のみ編集できます', status: 403 }
  // 自社雇用の最寄駅は従業員管理（会社管理者・事務担当のみ）で直す項目なので、承認も同じロールに限る
  if (roster.affiliation_type === 'own_employee' && !HR_ROLES.includes(u.role) && (changes.nearest_station_line !== undefined || changes.nearest_station !== undefined)) {
    return { error: '自社雇用スタッフの最寄駅の変更は、会社管理者・事務担当が承認してください', status: 403 }
  }
  const body: Record<string, any> = {}
  for (const k of ['nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from', 'work_area', 'skills']) if (changes[k] !== undefined) body[k] = changes[k]
  const bizErr = normalizeBusinessBody(body)
  if (bizErr) return { error: bizErr, status: 400 }
  if (Object.keys(body).length) {
    const err = await validateProfileBase(c, body, roster)
    if (err) return { error: err, status: 400 }
  }
  if (changes.login_email !== undefined) {
    body.login_email = changes.login_email
    const contactErr = await checkContactUpdate(c, sid, body, roster)
    if (contactErr) return { error: contactErr.body?.error || 'ログイン用メールを変更できません', status: contactErr.status }
  }
  await applyProfileUpdate(c, sid, body, roster)
  const contact = await applyContactUpdate(c, body, roster)
  return { ok: true, login_email: contact.login_email }
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
  // 連携先の各社の管理者に、所属元での退職（退職日の設定・変更・取り消し）を知らせる（持ち越し #187）
  if (changed) await notifyLinkedRetirement(db, sid, newRetired)
}

// スタッフ更新（スタッフマスタ画面から）
api.put('/admin/staff/:id', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const body = await c.req.json()
  const roster = await loadRoster(c.env.DB, sid, u.company_id)
  if (!roster) return c.json({ error: 'not found' }, 404)
  if (roster.merged_into_staff_id) return c.json({ error: '統合済みのスタッフは変更できません（統合先のスタッフで編集してください）' }, 409)
  // 離職リスクは 低・中・高 のみ（#381。ダッシュボードの要フォロー・一覧の絞り込みは low 以外を対象にする）
  if (body.retention_risk !== undefined && !['low', 'mid', 'high'].includes(body.retention_risk)) return c.json({ error: '離職リスクは 低・中・高 から選んでください' }, 400)
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
  const { user_code: rawCode, name, password, email, phone, skills, career, work_area, force } = await c.req.json()
  const user_code = normalizeLoginCode(rawCode) // ログイン画面と同じく全角を半角にそろえて保存する（#387）
  if (!user_code || !name || !password) return c.json({ error: 'スタッフ番号・氏名・パスワードは必須です' }, 400)
  const pwErr = validatePassword(password)
  if (pwErr) return c.json({ error: pwErr }, 400)
  // 同じ人の確認（#223。スタッフマスタの新規追加と同じ。force で登録を続ける）
  if (!force) {
    const matches = await findSamePersonCandidates(c.env.DB, u.company_id, { name, phone })
    if (matches.length) return c.json({ error: '同じ人と思われるスタッフが登録済みです', matches, need_force: true }, 409)
  }
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
    // 空いている番号を返し、画面の番号欄に入れ直せるようにする（#424）
    return c.json({ error: 'スタッフ番号が重複しています', suggested_code: (await nextStaffCode(c.env.DB, u.company_id)).code }, 409)
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
  // テンプレートの数値項目の合計（#184。performance.values と performance_fields。固定の列は今の画面のために残す）
  const metrics = await reportMetricSums(c.env.DB, 'dr.staff_id = ?', [sid], "''")
  const latestEval = await c.env.DB.prepare('SELECT * FROM evaluations WHERE staff_id = ? ORDER BY evaluation_period DESC LIMIT 1').bind(sid).first()
  // 管理者メモは社内用なので、社外に出すスキルシートには返さない。推薦コメントは別の欄（skill_sheet_comment。#447）に保存したものを返す
  const { memo: _memo, ...sheet } = profile
  return c.json({ profile: { ...sheet, career_rows: parseCareerRows(profile.career_rows), age: calcAge(profile.date_of_birth as string | null) }, experienced_projects: projects.results,
    performance: { ...(perf || {}), values: metrics.valuesOf('') }, performance_fields: metrics.fields, evaluation: latestEval,
    skill_sheet_comment: profile.skill_sheet_comment || '' })
})
// スキルシートの推薦コメントを保存する（#447）。社内用の管理者メモとは別の欄。空欄なら消す（固定の推薦文は入れない）
const SKILL_SHEET_COMMENT_MAX = 1000
api.put('/admin/staff/:id/skill-sheet-comment', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  if (b.comment != null && typeof b.comment !== 'string') return c.json({ error: '推薦コメントの形式が正しくありません' }, 400)
  const comment = String(b.comment ?? '').trim()
  if (comment.length > SKILL_SHEET_COMMENT_MAX) return c.json({ error: `推薦コメントは${SKILL_SHEET_COMMENT_MAX}文字以内で入力してください` }, 400)
  const r = await c.env.DB.prepare('UPDATE staff_profiles SET skill_sheet_comment = ? WHERE staff_id = ? AND company_id = ?').bind(comment || null, c.req.param('id'), u.company_id).run()
  if (!r.meta.changes) return c.json({ error: 'スタッフが見つかりません' }, 404)
  return c.json({ ok: true, skill_sheet_comment: comment })
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

// 書類の一覧の列。uploaded_at は既定値の CURRENT_TIMESTAMP（UTC）で保存されているので、日本時間にして返す（#257。保存の形は変えない）
// doc_type・valid_until は書類の種類と有効期限（#297）
const DOC_LIST_COLS = "SELECT document_id, original_file_name, mime_type, file_size, datetime(uploaded_at, '+9 hours') AS uploaded_at, doc_type, valid_until"
// ファイル一覧（本人がスマホから提出した書類には submitted_by_staff・確認の印が付く。#288）
api.get('/admin/staff/:id/documents', async (c) => {
  const sid = c.req.param('id')
  const staff = await assertStaffInCompany(c, sid)
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const docs = await c.env.DB.prepare(
    DOC_LIST_COLS + ', submitted_by_staff, confirmed_at FROM staff_documents WHERE staff_id = ? ORDER BY document_id DESC'
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
  // 書類の種類と有効期限（#297。同じ送信のファイルすべてに付ける）
  const meta = parseDocMeta('staff', form.get('doc_type'), form.get('valid_until'))
  if ('error' in meta) return c.json({ error: meta.error }, 400)

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
      const r = await c.env.DB.prepare(`INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, valid_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, sid, cleanFileName(file.name), key, file.type || 'application/octet-stream', file.size, u.user_id, meta.doc_type, meta.valid_until).run()
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
    SELECT cl.*, (SELECT GROUP_CONCAT(p.project_name) FROM projects p WHERE p.client_id = cl.client_id AND p.status = 'active') AS active_projects,
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = cl.client_id AND p.company_id = cl.company_id AND p.status = 'active') AS active_project_count,
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = cl.client_id AND p.company_id = cl.company_id) AS project_count,
      -- 有効期限が30日以内・切れた書類（契約書など）の数（#297。一覧の絞り込みに使う）
      (SELECT COUNT(*) FROM client_documents d WHERE d.client_id = cl.client_id AND d.company_id = cl.company_id AND d.valid_until IS NOT NULL AND d.valid_until <= ?) AS doc_expiring,
      -- 顧客担当者の名前（一覧の検索に使う。#9101 で会社基本情報の担当者は担当者一覧へ移した）
      (SELECT GROUP_CONCAT(cc.contact_name, '、') FROM client_contacts cc WHERE cc.client_id = cl.client_id AND cc.company_id = cl.company_id) AS contact_names
    FROM clients cl WHERE cl.company_id = ? ORDER BY cl.client_id`).bind(addDays(todayJST(), DASH_DOC_EXPIRY_DAYS), u.company_id).all()
  return c.json({ clients: rows.results })
})

api.post('/admin/clients', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  const name = String(b.client_name ?? '').trim()
  if (!name) return c.json({ error: 'クライアント名は必須です' }, 400)
  if (b.email && !CLIENT_EMAIL_RE.test(String(b.email).trim())) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
  const fieldErr = normalizeClientFields(b)
  if (fieldErr) return c.json({ error: fieldErr }, 400)
  let rating = 3
  if (b.client_rating !== undefined && b.client_rating !== null && String(b.client_rating).trim() !== '') {
    const r = toInt(b.client_rating, 1, 5)
    if (r === null) return c.json({ error: '評価は1〜5で入力してください' }, 400)
    rating = r
  }
  // 二度押し・入力ミスで同じクライアントが2件できないよう、同名があれば確認を求める（確認済みなら登録する）。
  // 確かめと登録を1つの文にし、同時に届いた2つの登録でも2件目は登録しない（#359）
  const dupMsg = { error: `同じ名前のクライアント「${name}」が既に登録されています`, confirm_duplicate: true }
  if (b.allow_duplicate !== true && await c.env.DB.prepare('SELECT 1 FROM clients WHERE company_id = ? AND client_name = ? LIMIT 1').bind(u.company_id, name).first())
    return c.json(dupMsg, 409)
  const contactName = typeof b.contact_name === 'string' ? b.contact_name.trim() : ''
  const r = await c.env.DB.prepare(`INSERT INTO clients (company_id, client_name, stream_type, contact_name, email, phone, address, contract_type, billing_rule, memo, client_rating,
      client_kind, representative_name, branch_name, department_name)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? OR NOT EXISTS (SELECT 1 FROM clients WHERE company_id = ? AND client_name = ?)`)
    .bind(u.company_id, name, b.stream_type || 'upstream', contactName || null, b.email ? String(b.email).trim() : null, b.phone ?? null, b.address ?? null, b.contract_type ?? null, b.billing_rule ?? null, b.memo ?? null, rating,
      b.client_kind || null, b.representative_name || null, b.branch_name || null, b.department_name || null,
      b.allow_duplicate === true ? 1 : 0, u.company_id, name).run()
  if (!r.meta.changes) return c.json(dupMsg, 409)
  // 担当者の名前が送られてきたら（以前の画面・外部からの登録）、顧客担当者の一覧に1件として入れる（#9101）
  if (contactName) await c.env.DB.prepare('INSERT INTO client_contacts (company_id, client_id, contact_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(u.company_id, r.meta.last_row_id, contactName, nowJST(), nowJST()).run()
  return c.json({ ok: true, client_id: r.meta.last_row_id })
})

// クライアント詳細（会社詳細画面用。まだ一覧のみだったため今回新設）
// 取引の実績（#345）: 全案件（終了を含む）と、?month=YYYY-MM（無ければ今月）の案件ごとの稼働・売上・日報・インシデント、
// その月までの6か月の月別の稼働・売上を返す。売上は請求前確認と同じく、今日までの確定・代打のシフトを shiftTotals で合計する（概算）
const CLIENT_TREND_MONTHS = 6
api.get('/admin/clients/:id', async (c) => {
  const u = c.get('user'); const cid = c.req.param('id')
  const month = queryMonth(c.req.query('month')); const [mFrom, mTo] = monthBounds(month)
  const client = await c.env.DB.prepare(`
    SELECT cl.*, (SELECT GROUP_CONCAT(p.project_name) FROM projects p WHERE p.client_id = cl.client_id AND p.status = 'active') AS active_projects
    FROM clients cl WHERE cl.client_id = ? AND cl.company_id = ?`).bind(cid, u.company_id).first()
  if (!client) return c.json({ error: 'クライアントが見つかりません' }, 404)
  const contacts = await c.env.DB.prepare(
    'SELECT * FROM client_contacts WHERE client_id = ? AND company_id = ? ORDER BY contact_id'
  ).bind(cid, u.company_id).all()
  const [y, m] = month.split('-').map(Number)
  const months = Array.from({ length: CLIENT_TREND_MONTHS }, (_, i) => new Date(Date.UTC(y, m - CLIENT_TREND_MONTHS + i, 1)).toISOString().slice(0, 7))
  const [projectRows, shiftRows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT p.project_id, p.project_name, p.status, p.location,
        (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND dr.work_date >= ?1 AND dr.work_date < ?2) AS reports,
        (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date >= ?1 AND dr.work_date < ?2) AS incidents
      FROM projects p WHERE p.client_id = ?3 AND p.company_id = ?4 ORDER BY CASE WHEN p.status = 'active' THEN 0 ELSE 1 END, p.project_id DESC`).bind(mFrom, mTo, cid, u.company_id),
    c.env.DB.prepare(`SELECT s.project_id, s.staff_id, s.work_date, s.unit_price, s.transportation_fee, s.bill_transport_type, s.bill_transport_amount, s.bill_adjust
      FROM shifts s JOIN projects p ON p.project_id = s.project_id AND p.company_id = s.company_id
      WHERE p.client_id = ? AND s.company_id = ? AND s.work_date >= ? AND s.work_date < ? AND s.work_date <= ? AND s.status IN ('confirmed','substitute')`)
      .bind(cid, u.company_id, months[0] + '-01', mTo, todayJST()),
  ])
  const perProject = new Map<number, { shifts: number; staff: Set<number>; bill_total: number }>()
  const trend = new Map(months.map(ym => [ym, { ym, shifts: 0, bill_total: 0 }]))
  for (const s of (shiftRows.results || []) as any[]) {
    const bill = shiftTotals(s).bill_total
    const t = trend.get(String(s.work_date).slice(0, 7))
    if (t) { t.shifts++; t.bill_total += bill }
    if (s.work_date < mFrom) continue
    const p = perProject.get(s.project_id) || { shifts: 0, staff: new Set<number>(), bill_total: 0 }
    p.shifts++; p.staff.add(s.staff_id); p.bill_total += bill
    perProject.set(s.project_id, p)
  }
  const projects = ((projectRows.results || []) as any[]).map(p => {
    const a = perProject.get(p.project_id)
    return { ...p, shifts: a?.shifts || 0, staff_count: a?.staff.size || 0, bill_total: a?.bill_total || 0 }
  })
  return c.json({ client, contacts: contacts.results, month, projects, trend: [...trend.values()] })
})

// クライアントのメールは顧客担当者（client_contacts）と同じ形式で確かめる
const CLIENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 種別（#9102。corporation = 法人 / sole_proprietor = 個人事業主 / other = その他）と、文字の項目（代表者氏名・支店・部門。#9101 #9103）の上限
const CLIENT_KINDS = ['corporation', 'sole_proprietor', 'other']
const CLIENT_TEXT_FIELDS: Record<string, [string, number]> = { representative_name: ['代表者氏名', 100], branch_name: ['支店', 100], department_name: ['部門', 100] }
// 種別・代表者氏名・支店・部門を確かめて整える（b を書き換える）。送られていない項目はそのまま。誤りがあれば文言を返す
function normalizeClientFields(b: any): string | null {
  if (b.client_kind !== undefined && b.client_kind !== null) {
    const k = String(b.client_kind).trim()
    if (k && !CLIENT_KINDS.includes(k)) return '種別は 法人・個人事業主・その他 から選んでください'
    b.client_kind = k
  }
  for (const [key, [label, max]] of Object.entries(CLIENT_TEXT_FIELDS)) {
    if (b[key] === undefined || b[key] === null) continue
    if (typeof b[key] !== 'string') return `${label}を正しく入力してください`
    const v = b[key].replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (v.length > max) return `${label}は${max}文字以内で入力してください`
    b[key] = v
  }
  return null
}
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

  if (b.email != null && String(b.email).trim() !== '' && !CLIENT_EMAIL_RE.test(String(b.email).trim())) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
  if (typeof b.email === 'string') b.email = b.email.trim()
  const fieldErr = normalizeClientFields(b)
  if (fieldErr) return c.json({ error: fieldErr }, 400)
  if (b.stream_type !== undefined && b.stream_type !== null && String(b.stream_type).trim() !== '' && !['upstream', 'downstream'].includes(b.stream_type))
    return c.json({ error: '上流・下流の区分が正しくありません' }, 400)

  const exists = await c.env.DB.prepare('SELECT client_id FROM clients WHERE client_id = ? AND company_id = ?').bind(cid, u.company_id).first()
  if (!exists) return c.json({ error: 'クライアントが見つかりません' }, 404)

  // 送られてきた項目だけを更新し、空欄は NULL にして消せるようにする（#92）。
  // 会社名は空にできない。区分・評価は空で送られたら変更しない
  const upd = buildUpdate({ ...b, invoice_number: b.invoice_number === undefined ? undefined : invoiceNumber },
    ['client_name', 'stream_type', 'contract_type', 'billing_rule', 'memo', 'client_rating',
      'contact_name', 'phone', 'email', 'address',
      'representative_title', 'representative_name', 'representative_kana', 'invoice_number',
      'client_kind', 'branch_name', 'department_name'],
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
  // 統合済みの取引先（#161）は選択肢に出さない
  const rows = await c.env.DB.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE company_id = ? AND merged_into_id IS NULL ORDER BY affiliation_name')
    .bind(u.company_id).all()
  return c.json({ affiliations: rows.results })
})
api.post('/admin/staff-affiliations', async (c) => {
  const u = c.get('user'); const { affiliation_name } = await c.req.json()
  if (!affiliation_name) return c.json({ error: '所属会社名は必須です' }, 400)
  const conflict = await partnerNameConflict(c.env.DB, u.company_id, affiliation_name)
  if (conflict) return c.json({ error: conflict }, 400)
  // 自社名は取引先にしない（#262）
  if (String(affiliation_name).trim() === await ownCompanyName(c.env.DB, u.company_id)) return c.json({ error: '自社名は協力会社として登録できません' }, 400)
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
    SELECT sp.staff_id, us.name, sp.kana, sp.employment_status, er.employee_number, er.department, er.job_title, er.base_location, er.contract_type,
      er.contract_end, er.paid_leave_granted_at
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

// 従業員名簿の CSV（#431）。労働者名簿の整備や、給与ソフト・社会保険の手続きへの受け渡しに使う（従業員管理と同じく会社管理者・事務担当のみ）。
// status: 空欄 = 自社雇用のすべて / working・leave・preboarding・retired = 在籍状況で絞る / ended = 雇用終了（他の区分へ移行・統合）。
// 口座・給与の列は、会社管理者が include_pay=1 を付けたときだけ含める。出力した記録を settlement_export_logs（kind = employees）に残す
const GENDER_LABEL: Record<string, string> = { male: '男性', female: '女性', other: 'その他', unspecified: '未回答' }
api.get('/admin/employees/export', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const status = String(c.req.query('status') || '')
  if (status && !['working', 'leave', 'preboarding', 'retired', 'ended'].includes(status)) return c.json({ error: '在籍状況の指定が正しくありません' }, 400)
  const includePay = c.req.query('include_pay') === '1'
  if (includePay && u.role !== 'company_admin') return c.json({ error: '口座・給与を含めた出力は、会社管理者のみ行えます' }, 403)
  await ensureRosterIdentity(db, u.company_id)
  const where = status === 'ended'
    ? `er.company_id = ? AND er.employment_ended_at IS NOT NULL AND (COALESCE(sp.affiliation_type,'own_employee') != 'own_employee' OR sp.merged_into_staff_id IS NOT NULL)`
    : `sp.company_id = ? AND ${OWN_EMPLOYEE_COND}${status ? ` AND COALESCE(sp.employment_status,'working') = ?` : ''}`
  const rows = (await db.prepare(`SELECT er.*, sp.staff_id AS sp_staff_id, us.name, us.email, us.phone, us.retired_at, sp.kana, sp.gender, sp.date_of_birth, COALESCE(sp.employment_status,'working') AS employment_status
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id LEFT JOIN employee_records er ON er.staff_id = sp.staff_id AND er.company_id = sp.company_id
    WHERE ${where} ORDER BY COALESCE(er.employee_number, ''), us.name`).bind(u.company_id, ...(status && status !== 'ended' ? [status] : [])).all()).results as any[]
  const statusLabel = (r: any) => (status === 'ended' ? '雇用終了' : ({ working: '在職中', leave: '休職中', retired: '退職', preboarding: '入社予定' } as Record<string, string>)[r.employment_status] || '在職中')
  const address = (r: any) => [r.prefecture, r.city, r.town, r.address_detail].filter(Boolean).join('')
  const header = ['社員番号', '氏名', 'フリガナ', '性別', '生年月日', '入社日', '在籍状況', '退職日', '雇用終了日', '契約形態', '契約開始', '契約終了', '所属', '役職', '拠点', '勤務形態',
    '郵便番号', '住所', '電話番号', 'メールアドレス', '雇用保険番号', '社会保険番号', 'スタッフID']
  const payHeader = ['金融機関コード', '金融機関名', '支店コード', '支店名', '預金種目', '口座番号', '基本給種別', '基本給', '固定残業時間', '固定残業代', '総支給額', '役職手当', '営業手当', 'その他控除']
  const csvRows = rows.map(r => [
    r.employee_number, r.name, r.kana, GENDER_LABEL[r.gender] || r.gender || '', r.date_of_birth, r.hire_date, statusLabel(r), r.retired_at ? String(r.retired_at).slice(0, 10) : '',
    r.employment_ended_at, r.contract_type, r.contract_start, r.contract_end, r.department, r.job_title, r.base_location, r.work_style,
    r.postal_code, address(r), r.phone_main || r.phone, r.personal_email || r.email, r.employment_insurance_no, r.social_insurance_no, r.sp_staff_id,
    ...(includePay ? [r.bank_code, r.bank_name, r.branch_code, r.branch_name, r.account_type, r.account_number, r.base_salary_type, r.base_salary, r.fixed_overtime_hours,
      r.fixed_overtime_pay, r.gross_pay, r.position_allowance, r.sales_allowance, r.other_deduction] : []),
  ])
  const csv = toCsv(includePay ? [...header, ...payHeader] : header, csvRows,
    { textCols: ['社員番号', '郵便番号', '電話番号', '雇用保険番号', '社会保険番号', '金融機関コード', '支店コード', '口座番号'] })
  await db.prepare('INSERT INTO settlement_export_logs (company_id, kind, filters_json, row_count, exported_by, exported_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(u.company_id, 'employees', JSON.stringify({ status: status || null, include_pay: includePay || null }), rows.length, u.user_id, nowJST()).run().catch(() => {})
  return csvResponse(`従業員名簿_${status ? statusLabel({ employment_status: status }) + '_' : ''}${todayJST()}${includePay ? '_口座給与あり' : ''}.csv`, csv)
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
  const exists = await c.env.DB.prepare('SELECT * FROM employee_records WHERE staff_id = ?').bind(sid).first() as any
  // 電話番号が変わったときだけ users.phone にそろえる（従業員管理を初めて保存したときに、登録時の電話番号を空欄で消さないように比べる。#123）
  const phoneChanged = b.phone_main !== undefined && normalizePhone(b.phone_main) !== normalizePhone(exists?.phone_main)
  // 変わった項目を変更履歴に残し、口座・給与の変更は会社管理者に知らせる（#464 #205。保存と同じ batch で入れる）
  const now = nowJST()
  const changes = diffFields(exists, b, cols)
  const logStmts = [
    ...changeLogStmts(c.env.DB, { companyId: u.company_id, staffId: sid, source: 'employee', changedBy: u.user_id, at: now, changes }),
    ...payrollAlertStmts(c.env.DB, { companyId: u.company_id, staffId: sid, actorId: u.user_id, actorName: u.name, at: now, changes }),
  ]
  if (exists) {
    // 送られてきた項目だけを更新し、空欄は NULL にして消せるようにする（#18）
    const upd = buildUpdate(b, cols)
    await c.env.DB.batch([c.env.DB.prepare(`UPDATE employee_records SET ${upd.clause ? upd.clause + ', ' : ''}updated_at = ? WHERE staff_id = ? AND company_id = ?`)
      .bind(...upd.values, now, sid, u.company_id), ...logStmts])
  } else {
    const placeholders = cols.map(() => '?').join(', ')
    await c.env.DB.batch([c.env.DB.prepare(`INSERT INTO employee_records (staff_id, company_id, ${cols.join(', ')}) VALUES (?, ?, ${placeholders})`)
      .bind(sid, u.company_id, ...cols.map(k => b[k] === '' ? null : (b[k] ?? null))), ...logStmts])
  }
  if (roster) await applyProfileUpdate(c, sid, profile, roster)
  if (phoneChanged) await syncUserPhoneFromEmployee(c.env.DB, sid, u.company_id, b.phone_main)
  return c.json({ ok: true })
})

// 従業員データとスタッフ基本情報の変更履歴（#464）。新しい順に50件ずつ（before に前のページの最後の log_id を渡す）。
// 雇用終了した従業員（他の区分へ移行）も閲覧できる（従業員データと同じく7年保存）
const CHANGE_LOG_PAGE = 50
api.get('/admin/employees/:staffId/history', async (c) => {
  const u = c.get('user'); const sid = c.req.param('staffId')
  const staff = (await assertOwnEmployee(c, sid)) || (await c.env.DB.prepare(
    'SELECT staff_id FROM employee_records WHERE staff_id = ? AND company_id = ? AND employment_ended_at IS NOT NULL').bind(sid, u.company_id).first())
  if (!staff) return c.json({ error: '社員名簿の対象ではありません' }, 404)
  const before = toInt(c.req.query('before'))
  const rows = (await c.env.DB.prepare(`SELECT l.log_id, l.source, l.field, l.old_value, l.new_value, l.changed_at, cu.name AS changed_by_name
    FROM employee_change_logs l LEFT JOIN users cu ON cu.user_id = l.changed_by
    WHERE l.staff_id = ? AND l.company_id = ? ${before ? 'AND l.log_id < ?' : ''}
    ORDER BY l.log_id DESC LIMIT ?`).bind(...[sid, u.company_id, ...(before ? [before] : []), CHANGE_LOG_PAGE + 1]).all()).results as any[]
  const has_more = rows.length > CHANGE_LOG_PAGE
  return c.json({ logs: rows.slice(0, CHANGE_LOG_PAGE).map(r => ({ ...r, label: CHANGE_FIELD_LABELS[r.field] || r.field })), has_more })
})

// ============ 入社時書類（履歴書と同一パターン。既存DOCUMENTSバケットを別キー接頭辞で再利用） ============
api.get('/admin/employees/:staffId/documents', async (c) => {
  // 雇用終了した従業員（他区分へ移行）の書類も閲覧はできる（7年保存）
  const staff = (await assertOwnEmployee(c, c.req.param('staffId'))) || (await c.env.DB.prepare(
    'SELECT staff_id FROM employee_records WHERE staff_id = ? AND company_id = ? AND employment_ended_at IS NOT NULL').bind(c.req.param('staffId'), c.get('user').company_id).first())
  if (!staff) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const docs = await c.env.DB.prepare(
    DOC_LIST_COLS + ' FROM employee_documents WHERE staff_id = ? ORDER BY document_id DESC'
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
  const meta = parseDocMeta('employee', form.get('doc_type'), form.get('valid_until')) // 書類の種類と有効期限（#297）
  if ('error' in meta) return c.json({ error: meta.error }, 400)

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
      const r = await c.env.DB.prepare(`INSERT INTO employee_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, valid_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, sid, cleanFileName(file.name), key, file.type || 'application/octet-stream', file.size, u.user_id, meta.doc_type, meta.valid_until).run()
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
    DOC_LIST_COLS + ' FROM client_documents WHERE client_id = ? ORDER BY document_id DESC'
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
  // 契約書の種類と契約終了日（#297）
  const meta = parseDocMeta('client', form.get('doc_type'), form.get('valid_until'))
  if ('error' in meta) return c.json({ error: meta.error }, 400)

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
      const r = await c.env.DB.prepare(`INSERT INTO client_documents (company_id, client_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, valid_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.company_id, cid, cleanFileName(file.name), key, file.type || 'application/octet-stream', file.size, u.user_id, meta.doc_type, meta.valid_until).run()
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
// ?month=YYYY-MM で集計する月を選べる（#450。無ければ今月）。月は範囲の条件で絞る（#212）
api.get('/admin/projects', async (c) => {
  const u = c.get('user'); const month = queryMonth(c.req.query('month')); const [mFrom, mTo] = monthBounds(month)
  const rows = await c.env.DB.prepare(`
    SELECT p.*, cl.client_name,
      (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date >= ?1 AND s.work_date < ?2 AND s.status IN ('confirmed','substitute')) AS staff_count,
      (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date >= ?1 AND s.work_date < ?2 AND s.status IN ('confirmed','substitute')) AS month_shifts,
      (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.project_id = p.project_id AND dr.work_date >= ?1 AND dr.work_date < ?2) AS month_seiyaku,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date >= ?1 AND dr.work_date < ?2) AS incidents
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    WHERE p.company_id = ?3 ORDER BY p.project_id`).bind(mFrom, mTo, u.company_id).all()
  return c.json({ projects: rows.results, month })
})

// 案件詳細
api.get('/admin/projects/:id', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id'); const month = queryMonth(c.req.query('month')); const [mFrom, mTo] = monthBounds(month)
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
      SUM(COALESCE(json_extract(dr.report_values,'$.shodan'),0)) AS shodan,
      SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) AS seiyaku
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.project_id = ? AND dr.work_date >= ? AND dr.work_date < ? GROUP BY dr.staff_id ORDER BY seiyaku DESC`).bind(pid, mFrom, mTo).all()
  const staffMetrics = await reportMetricSums(db, 'dr.project_id = ? AND dr.company_id = ? AND dr.work_date >= ? AND dr.work_date < ?', [pid, u.company_id, mFrom, mTo], 'dr.staff_id')

  // インシデント・クレーム（#169）: 対応済みでないものを先に、対応状況・メモを付けて返す
  const incidents = await db.prepare(`
    SELECT dr.daily_report_id, dr.work_date, dr.incident_flag, dr.complaint_flag, us.name AS staff_name, dr.report_values,
      COALESCE(dr.incident_status, 'open') AS incident_status, dr.incident_memo, dr.incident_client_shared_at, dr.incident_updated_at
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.project_id = ? AND (dr.incident_flag = 1 OR dr.complaint_flag = 1)
    ORDER BY CASE WHEN ${DR_INCIDENT_OPEN_SQL} THEN 0 ELSE 1 END, dr.work_date DESC LIMIT 10`).bind(pid).all()

  // 今月の売上（概算）は精算と同じ shiftTotals で数える（基本額＋請求交通費＋請求の調整額。#414）。
  // 支払見込みと粗利は、支払が決まっているシフトだけで計算する（シフトボードの合計と同じ。未設定の件数は pay_missing）
  // 確定の時点で記録した割増（pay_premium。#167）も支払見込みに入れる
  const monthRows = (await db.prepare(`SELECT unit_price, transportation_fee, bill_transport_type, bill_transport_amount, bill_adjust,
      pay_amount, pay_transport_type, pay_transport_amount, pay_adjust, pay_premium
    FROM shifts WHERE project_id = ? AND company_id = ? AND work_date >= ? AND work_date < ? AND status IN ('confirmed','substitute')`).bind(pid, u.company_id, mFrom, mTo).all()).results as any[]
  const monthShifts = { n: monthRows.length, revenue: 0, bill_total: 0, pay_total: 0, profit: 0, pay_missing: 0 }
  {
    let profitBill = 0
    for (const s of monthRows) {
      const t = shiftTotals(s)
      monthShifts.bill_total += t.bill_total
      if (t.pay_total == null) monthShifts.pay_missing++
      else { monthShifts.pay_total += t.pay_total; profitBill += t.bill_total }
    }
    monthShifts.revenue = monthShifts.bill_total
    monthShifts.profit = profitBill - monthShifts.pay_total
  }

  return c.json({
    project: { ...project, template_fields: project.fields_json ? JSON.parse(project.fields_json as string) : [] },
    // テンプレートの数値項目の合計（#184。各行の values と performance_fields。mnp などの固定の列は今の画面のために残す）
    staff_performance: (staffPerf.results as any[]).map(r => ({ ...r, values: staffMetrics.valuesOf(r.staff_id) })), performance_fields: staffMetrics.fields,
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
  if ((normalizeSkills(b.required_skills) || '').length > 500) return c.json({ error: '必要スキルは500文字以内で入力してください' }, 400)
  // クライアントは任意（社内研修など）。空欄は NULL にする（'' のまま入れると外部キー違反になる）。他社のクライアントは指定できない
  const blank = (v: any) => v === undefined || v === null || String(v).trim() === ''
  const clientId = blank(b.client_id) ? null : b.client_id
  if (clientId !== null && !(await ownClient(c.env.DB, u.company_id, clientId))) return c.json({ error: 'クライアントが見つかりません' }, 400)
  // 日報テンプレートは自社または本部のものだけ。未指定なら、項目のあるテンプレートのうち最初のもの（画面の既定と同じ）
  const textErr = projectTextError(b)
  if (textErr) return c.json({ error: textErr }, 400)
  let templateId: any = null
  if (!blank(b.report_template_id)) {
    // 配信停止のテンプレートは新しい案件では選べない（#165）
    if (!(await c.env.DB.prepare(`SELECT 1 FROM report_templates WHERE template_id = ? AND (company_id IS NULL OR company_id = ?) AND COALESCE(status, 'active') = 'active'`).bind(b.report_template_id, u.company_id).first()))
      return c.json({ error: '日報テンプレートが見つかりません（配信停止のテンプレートは選べません）' }, 400)
    templateId = b.report_template_id
  } else {
    const t = await c.env.DB.prepare(`SELECT template_id FROM report_templates WHERE (company_id IS NULL OR company_id = ?) AND COALESCE(status, 'active') = 'active'
      AND json_valid(fields_json) AND json_array_length(fields_json) > 0 ORDER BY template_id LIMIT 1`).bind(u.company_id).first()
    if (!t) return c.json({ error: '日報テンプレートが登録されていません。本部に登録を依頼してください' }, 400)
    templateId = t.template_id
  }
  // 二度押し・入力ミスで同じ案件が2件できないよう、稼働中の同名案件があれば確認を求める（確認済みなら登録する）。
  // 確かめと登録を1つの文にし、同時に届いた2つの登録でも2件目は登録しない（#359）
  const contact = projectSiteContact(b) // 現場責任者の連絡先（#173。任意）
  if ('error' in contact) return c.json({ error: contact.error }, 400)
  const dupMsg = { error: `同じ名前の稼働中の案件「${name}」が既に登録されています`, confirm_duplicate: true }
  if (b.allow_duplicate !== true && await c.env.DB.prepare(`SELECT 1 FROM projects WHERE company_id = ? AND project_name = ? AND status = 'active' LIMIT 1`).bind(u.company_id, name).first())
    return c.json(dupMsg, 409)
  const r = await c.env.DB.prepare(`INSERT INTO projects (company_id, client_id, project_name, project_type, location, unit_price_type, unit_price, required_skills, report_template_id, requirements, manual_text, memo, remarks)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? OR NOT EXISTS (SELECT 1 FROM projects WHERE company_id = ? AND project_name = ? AND status = 'active')`)
    .bind(u.company_id, clientId, name, b.project_type || 'mobile_shop', b.location ?? null,
      b.unit_price_type || 'daily', b.unit_price || 0, normalizeSkills(b.required_skills), templateId, b.requirements ?? null, b.manual_text ?? null, b.memo ?? null, blank(b.remarks) ? null : String(b.remarks).trim(),
      b.allow_duplicate === true ? 1 : 0, u.company_id, name).run()
  if (!r.meta.changes) return c.json(dupMsg, 409)
  const cs = Object.keys(contact.set)
  if (cs.length) await c.env.DB.prepare(`UPDATE projects SET ${cs.map(k => `${k} = ?`).join(', ')} WHERE project_id = ? AND company_id = ?`)
    .bind(...cs.map(k => contact.set[k]), r.meta.last_row_id, u.company_id).run()
  return c.json({ ok: true, project_id: r.meta.last_row_id })
})

// 案件の現場責任者の連絡先（#173）。送られた項目だけを返す。電話番号は会社の緊急連絡先と同じ形式（数字・ハイフン）
const SITE_CONTACT_NAME_MAX = 40
function projectSiteContact(b: any): { set: Record<string, string | null> } | { error: string } {
  const set: Record<string, string | null> = {}
  if (b.site_contact_name !== undefined) {
    if (b.site_contact_name !== null && typeof b.site_contact_name !== 'string') return { error: '現場責任者の名前を正しく入力してください' }
    const n = String(b.site_contact_name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (n.length > SITE_CONTACT_NAME_MAX) return { error: `現場責任者の名前は${SITE_CONTACT_NAME_MAX}文字以内で入力してください` }
    set.site_contact_name = n || null
  }
  if (b.site_contact_phone !== undefined) {
    const p = emergencyPhone(b.site_contact_phone)
    if (p && typeof p === 'object') return { error: '現場責任者の電話番号は、数字とハイフンで入力してください' }
    set.site_contact_phone = p
  }
  return { set }
}

// 案件の必要スキル（#556。シフトボードの候補一覧の『スキル n/m』に使う）。カンマ・読点で区切り、空欄なら消す
api.put('/admin/projects/:id/required-skills', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id')
  const b = await c.req.json().catch(() => ({} as any))
  if (b.required_skills !== null && typeof b.required_skills !== 'string') return c.json({ error: '必要スキルの形式が正しくありません' }, 400)
  const skills = normalizeSkills(b.required_skills)
  if (skills && skills.length > 500) return c.json({ error: '必要スキルは500文字以内で入力してください' }, 400)
  const r = await c.env.DB.prepare('UPDATE projects SET required_skills = ? WHERE project_id = ? AND company_id = ?').bind(skills, pid, u.company_id).run()
  if (!(r.meta?.changes ?? 0)) return c.json({ error: '案件が見つかりません' }, 404)
  return c.json({ ok: true, required_skills: skills })
})

// 案件ごとの入店/退店報告 写真添付オーバーライド更新
api.put('/admin/projects/:id/photo-required', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id')
  if (!canEditAttendanceSettings(u)) return c.json({ error: ATTENDANCE_SETTING_DENIED, code: 'role_forbidden' }, 403)
  const { override } = await c.req.json().catch(() => ({ override: undefined }))
  if (!['inherit', 'on', 'off'].includes(override)) return c.json({ error: '不正なパラメータです' }, 400)
  const value = override === 'inherit' ? null : override === 'on' ? 1 : 0

  const proj = await c.env.DB.prepare('SELECT project_id FROM projects WHERE project_id = ? AND company_id = ?').bind(pid, u.company_id).first()
  if (!proj) return c.json({ error: '案件が見つかりません' }, 404)

  await c.env.DB.prepare('UPDATE projects SET photo_required_override = ? WHERE project_id = ?').bind(value, pid).run()
  return c.json({ ok: true })
})

// 案件の文字の項目の長さ（登録・編集で共通）
const PROJECT_TEXT_LIMITS: [string, string, number][] = [
  ['project_name', '案件名', 100], ['location', '稼働場所', 200], ['requirements', '求められる内容', 2000],
  ['manual_text', '案件マニュアル・注意事項', 5000], ['memo', 'メモ', 2000], ['remarks', '備考', 2000],
]
function projectTextError(b: any): string | null {
  for (const [k, label, max] of PROJECT_TEXT_LIMITS) {
    const v = b[k]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return `${label}の形式が正しくありません`
    if (v.length > max) return `${label}は${max}文字以内で入力してください`
  }
  return null
}

// 案件の編集・終了（#153）。送られた項目だけを変える。単価・区分は単価パネル（PUT /admin/projects/:id/pricing）で変える。
//  - status: active（稼働中）/ closed（終了）。終了した案件には新しいシフトを入れられない（lib/staff-eligibility.ts の assertAssignable）
//  - 確認が要る変更は 409 で理由を返し、確認の印を付けて送り直すと保存する
//      confirm_duplicate       : 稼働中の別の案件と同じ名前（allow_duplicate）
//      confirm_close           : 今日以降のシフトが残っている案件を終了する（confirm_close。シフトは取り消さない）
//      confirm_template_change : 日報がある案件の日報テンプレートを変える（confirm_template_change。過去の日報の項目が表示されなくなることがある）
api.put('/admin/projects/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => null) as any
  if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: '入力内容が正しくありません' }, 400)
  const cur = await db.prepare('SELECT * FROM projects WHERE project_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '案件が見つかりません' }, 404)
  const textErr = projectTextError(b)
  if (textErr) return c.json({ error: textErr }, 400)
  const blank = (v: any) => v === undefined || v === null || String(v).trim() === ''
  const set: Record<string, any> = {}
  if (b.project_name !== undefined) {
    const name = String(b.project_name ?? '').trim()
    if (!name) return c.json({ error: '案件名は必須です' }, 400)
    set.project_name = name
  }
  if (b.client_id !== undefined) {
    const clientId = blank(b.client_id) ? null : Number(b.client_id)
    if (clientId !== null && !(await ownClient(db, u.company_id, clientId))) return c.json({ error: 'クライアントが見つかりません' }, 400)
    set.client_id = clientId
  }
  if (b.project_type !== undefined) {
    if (!PROJECT_TYPES.includes(b.project_type)) return c.json({ error: '業務種別が正しくありません' }, 400)
    set.project_type = b.project_type
  }
  for (const k of ['location', 'requirements', 'manual_text', 'memo', 'remarks']) if (b[k] !== undefined) set[k] = blank(b[k]) ? null : String(b[k]).trim()
  // 現場責任者の連絡先（#173。任意）。スタッフアプリ・報告用URLの当日のシフトに出す
  const contact = projectSiteContact(b)
  if ('error' in contact) return c.json({ error: contact.error }, 400)
  Object.assign(set, contact.set)
  if (b.required_skills !== undefined) {
    if (b.required_skills !== null && typeof b.required_skills !== 'string') return c.json({ error: '必要スキルの形式が正しくありません' }, 400)
    const skills = normalizeSkills(b.required_skills)
    if (skills && skills.length > 500) return c.json({ error: '必要スキルは500文字以内で入力してください' }, 400)
    set.required_skills = skills
  }
  if (b.show_performance !== undefined) set.show_performance = b.show_performance === true || b.show_performance === 1 || b.show_performance === '1' ? 1 : 0
  if (b.report_template_id !== undefined && Number(b.report_template_id) !== Number(cur.report_template_id)) {
    // 自社または本部のテンプレートで、配信停止でないもの（いま使っているものはそのまま残せる）
    if (!(await db.prepare(`SELECT 1 FROM report_templates WHERE template_id = ? AND (company_id IS NULL OR company_id = ?) AND COALESCE(status, 'active') = 'active'
      AND json_valid(fields_json) AND json_array_length(fields_json) > 0`).bind(b.report_template_id, u.company_id).first()))
      return c.json({ error: '日報テンプレートが見つかりません（配信停止のテンプレートは選べません）' }, 400)
    set.report_template_id = Number(b.report_template_id)
  }
  let nextStatus = cur.status || 'active'
  if (b.status !== undefined) {
    if (!['active', 'closed'].includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
    nextStatus = b.status
  }
  const nextName = set.project_name ?? cur.project_name
  // 稼働中の同名案件（登録と同じ確認。名前を変えたときと、稼働中に戻すとき）
  if (nextStatus === 'active' && b.allow_duplicate !== true && (set.project_name !== undefined || (cur.status || 'active') !== 'active')
    && await db.prepare(`SELECT 1 FROM projects WHERE company_id = ? AND project_name = ? AND status = 'active' AND project_id != ? LIMIT 1`).bind(u.company_id, nextName, cur.project_id).first())
    return c.json({ error: `同じ名前の稼働中の案件「${nextName}」が既に登録されています`, confirm_duplicate: true }, 409)
  if (set.report_template_id !== undefined && b.confirm_template_change !== true) {
    const used = await db.prepare('SELECT COUNT(*) AS n FROM daily_reports WHERE project_id = ?').bind(cur.project_id).first() as any
    if (Number(used?.n || 0) > 0) return c.json({
      error: `この案件には日報が${Number(used.n)}件あります。日報テンプレートを変えると、新しいテンプレートにない項目は過去の日報の一覧・集計に表示されなくなります（保存された値は消えません）`,
      confirm_template_change: true }, 409)
  }
  if (nextStatus === 'closed' && (cur.status || 'active') === 'active' && b.confirm_close !== true) {
    const fut = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE project_id = ? AND company_id = ? AND work_date >= ? AND status IN ('requested','confirmed','substitute')`)
      .bind(cur.project_id, u.company_id, todayJST()).first() as any
    if (Number(fut?.n || 0) > 0) return c.json({
      error: `この案件には今日以降のシフトが${Number(fut.n)}件あります。終了しても、これらのシフトは取り消されません（必要ならシフト管理で取り消してください）。終了した案件には新しいシフトを登録できません`,
      confirm_close: true, future_shifts: Number(fut.n) }, 409)
  }
  const now = nowJST()
  if (nextStatus !== (cur.status || 'active')) {
    set.status = nextStatus
    set.closed_at = nextStatus === 'closed' ? now : null
    set.closed_by = nextStatus === 'closed' ? u.user_id : null
  }
  const cols = Object.keys(set)
  if (!cols.length) return c.json({ ok: true, changed: false })
  await db.prepare(`UPDATE projects SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE project_id = ? AND company_id = ?`)
    .bind(...cols.map(k => set[k]), now, cur.project_id, u.company_id).run()
  return c.json({ ok: true, changed: true, status: nextStatus })
})

// ---------- 使われていない案件・クライアントの削除（#359。二度押しなどで重複して登録したものを消す） ----------
// どこからも使われていないときだけ消す。使われていれば 409 で使っている所と件数を返す（案件は「終了」、クライアントは名前の変更で対応してもらう）。
// 確かめと削除は1つの batch で行い、どの文も「まだ使われていない」ときだけ消す（確かめた後にシフトなどが入っても消さない）。
// SQL の ?1 は案件・クライアントの ID、?2 は会社の ID
type UsageCheck = [key: string, label: string, sql: string]
const PROJECT_USAGE: UsageCheck[] = [
  ['shifts', 'シフト', 'SELECT 1 FROM shifts WHERE project_id = ?1'],
  ['daily_reports', '日報', 'SELECT 1 FROM daily_reports WHERE project_id = ?1 UNION ALL SELECT 1 FROM daily_report_duplicates WHERE project_id = ?1'],
  ['shift_slots', '募集枠', 'SELECT 1 FROM shift_slots WHERE project_id = ?1'],
  ['slot_patterns', '繰り返し登録', 'SELECT 1 FROM slot_patterns WHERE project_id = ?1'],
  ['shift_requests', 'シフト希望', 'SELECT 1 FROM shift_requests WHERE project_id = ?1'],
  ['attendance_corrections', '打刻修正の申請', 'SELECT 1 FROM attendance_corrections WHERE project_id = ?1'],
  ['notices', 'お知らせの配信先', `SELECT 1 FROM notice_targets WHERE target_type = 'project' AND target_id = ?1
    UNION ALL SELECT 1 FROM notices WHERE company_id = ?2 AND target_type = 'project' AND (',' || REPLACE(COALESCE(target_ids, ''), ' ', '') || ',') LIKE '%,' || ?1 || ',%'`],
  ['recruit_pages', '募集ページ', `SELECT 1 FROM recruit_pages WHERE company_id = ?2 AND (',' || REPLACE(COALESCE(project_ids, ''), ' ', '') || ',') LIKE '%,' || ?1 || ',%'`],
  ['board_posts', '案件掲示板の掲載', 'SELECT 1 FROM board_posts WHERE source_project_id = ?1 AND company_id = ?2'],
  ['consultations', '相談', 'SELECT 1 FROM consultations WHERE target_project_id = ?1 AND company_id = ?2'],
  ['follow_logs', 'フォロー記録', 'SELECT 1 FROM follow_logs WHERE related_project_id = ?1 AND company_id = ?2'],
]
// 案件と一緒に消す設定（単価ルール・単価の履歴・キャンセル料の規定・報告の設定とその変更の記録）
const PROJECT_OWNED_TABLES = ['rate_rules', 'project_price_history', 'project_cancel_policies', 'project_report_defaults', 'project_staff_report_settings', 'report_setting_logs']
const CLIENT_USAGE: UsageCheck[] = [
  ['projects', '案件', 'SELECT 1 FROM projects WHERE client_id = ?1 AND company_id = ?2'],
  ['sites', '開催場所', 'SELECT 1 FROM sites WHERE client_id = ?1 AND company_id = ?2'],
  ['rate_rules', '単価ルール', 'SELECT 1 FROM rate_rules WHERE client_id = ?1 AND company_id = ?2'],
  ['client_documents', '書類', 'SELECT 1 FROM client_documents WHERE client_id = ?1 AND company_id = ?2'],
]
// 担当者の連絡先と NG スタッフの理由はクライアントと一緒に消す
const CLIENT_OWNED_TABLES = ['client_contacts', 'client_ng_staff']
const usageCountSql = (checks: UsageCheck[]) => `SELECT ${checks.map(([k, , sql]) => `(SELECT COUNT(*) FROM (${sql})) AS ${k}`).join(', ')}`
const notUsedSql = (checks: UsageCheck[]) => checks.map(([, , sql]) => `NOT EXISTS (${sql})`).join(' AND ')
async function deleteUnused(c: any, o: { table: 'projects' | 'clients'; idCol: string; id: number; usage: UsageCheck[]; owned: string[]; what: string; hint: string }) {
  const u = c.get('user'); const db: D1Database = c.env.DB
  const cur = await db.prepare(`SELECT ${o.idCol} FROM ${o.table} WHERE ${o.idCol} = ? AND company_id = ?`).bind(o.id, u.company_id).first()
  if (!cur) return c.json({ error: `${o.what}が見つかりません` }, 404)
  const inUse = async () => {
    const row = (await db.prepare(usageCountSql(o.usage)).bind(o.id, u.company_id).first() || {}) as Record<string, number>
    const usage = o.usage.map(([k, label]) => ({ key: k, label, count: Number(row[k]) || 0 })).filter(x => x.count > 0)
    return c.json({ error: `この${o.what}は使われているため削除できません（${usage.map(x => `${x.label} ${x.count}件`).join('、')}）。${o.hint}`, code: 'in_use', usage }, 409)
  }
  const guard = `EXISTS (SELECT 1 FROM ${o.table} WHERE ${o.idCol} = ?1 AND company_id = ?2) AND ${notUsedSql(o.usage)}`
  let res: D1Result[]
  try {
    res = await db.batch([
      ...o.owned.map(t => db.prepare(`DELETE FROM ${t} WHERE ${o.idCol} = ?1 AND ${guard}`).bind(o.id, u.company_id)),
      db.prepare(`DELETE FROM ${o.table} WHERE ${o.idCol} = ?1 AND company_id = ?2 AND ${notUsedSql(o.usage)}`).bind(o.id, u.company_id),
    ])
  } catch (e) {
    // ここで数えていない表から参照されている（外部キー）ときは消さない（batch は全体が取り消される）
    console.log(`delete ${o.table} ${o.id} failed: ${e}`)
    return c.json({ error: `この${o.what}はほかのデータから参照されているため削除できません。${o.hint}`, code: 'in_use', usage: [] }, 409)
  }
  if (!res[res.length - 1].meta.changes) return inUse()
  return c.json({ ok: true, deleted: o.id })
}
api.delete('/admin/projects/:id{[0-9]+}', async (c) => deleteUnused(c, { table: 'projects', idCol: 'project_id', id: Number(c.req.param('id')),
  usage: PROJECT_USAGE, owned: PROJECT_OWNED_TABLES, what: '案件', hint: '使わなくなった案件は「終了」にしてください' }))
api.delete('/admin/clients/:id{[0-9]+}', async (c) => deleteUnused(c, { table: 'clients', idCol: 'client_id', id: Number(c.req.param('id')),
  usage: CLIENT_USAGE, owned: CLIENT_OWNED_TABLES, what: 'クライアント', hint: '重複して登録したクライアントは、名前を変えて区別してください' }))

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
  // 写真の日時・選び方と、写真なしの理由・端末の要約（#418 #532 #535）
  // 押した時刻（端末時刻）で記録した報告の印と受け取った時刻（#427）
  const rows = await c.env.DB.prepare(`SELECT attendance_id, report_type, reported_at, status, entry_method, (photo_key IS NOT NULL) AS has_photo,
      photo_taken_at, photo_source, no_photo_reason, device_info, original_reported_at, time_source, received_at, corrected_by_correction_id
    FROM attendance_reports WHERE shift_id = ? ORDER BY reported_at, attendance_id`).bind(shift.shift_id).all()
  return c.json({ shift_id: shift.shift_id, work_date: shift.work_date, reports: rows.results.map(({ device_info, original_reported_at, time_source, received_at, corrected_by_correction_id, ...r }: any) => ({ ...r, has_photo: !!r.has_photo,
    photo_stale: !!r.has_photo && isPhotoStale(r.photo_taken_at, original_reported_at || r.reported_at), device: r.entry_method === 'proxy' ? '' : deviceSummary(device_info),
    ...deviceTimeMark({ time_source, received_at, corrected_by_correction_id }) })) })
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
  // 精算を締めた期間には追加しない（#170）
  const closedAdd = await closedMessage(c.env.DB, u.company_id, b.work_date)
  if (closedAdd) return c.json({ error: closedAdd }, 409)
  // 交通費（実費）は空欄ならスタッフの標準（#564。開催場所を持たないシフトなので、スタッフの標準）、なければ 0。
  // 案件の交通費ルール（定額・なし）は単価の適用で反映される（#94）
  const feeIn = b.transportation_fee === undefined || b.transportation_fee === null || b.transportation_fee === '' ? null : Number(b.transportation_fee)
  if (feeIn !== null && (!Number.isInteger(feeIn) || feeIn < 0 || feeIn > 100000)) return c.json({ error: '交通費は0〜100000の整数で入力してください' }, 400)
  const fee = feeIn ?? transportDefaultFor(await loadTransportDefaults(c.env.DB, u.company_id, [Number(b.staff_id)]), b.staff_id, null) ?? 0
  const start = b.start_time || '09:30', end = b.end_time || '19:00'
  // 自社のスタッフマスタ行のみ。退職・統合・スキルシートのみ・取引終了は不可（#94）。
  // 重複・NG・休職中の警告: 画面（シフト管理の登録）は confirm_warnings を付けて送り、409 で確認してから force で登録する。
  // 付けずに呼んだ場合は登録し、警告を応答に含める（既存の呼び出しの動きを変えないため）
  const chk = await assertAssignable(c.env.DB, { companyId: u.company_id, project: proj, slot: null, staffId: Number(b.staff_id), workDate: b.work_date, start, end })
  if (chk.error) return c.json({ error: chk.error }, chk.status)
  // 登録の画面で変えた単価（請求・支払の単位と単価。9306）。計算した単価と違えば手動変更として入れる
  const ov = rateOverrideOf(b.price)
  if (ov.error) return c.json({ error: ov.error }, 400)
  if (chk.warnings.length && b.confirm_warnings === true && !b.force) return c.json({ warnings: chk.warnings, need_force: true }, 409)
  const ins = await c.env.DB.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, b.project_id, b.work_date, start, end,
      b.location || proj?.location || '', b.role || '販売スタッフ', b.unit_price ?? proj?.unit_price ?? 0, fee,
      b.status || 'confirmed', u.user_id, b.memo ?? null).run()
  // 単価ルール（請求/支払/交通費）を適用。単価を明示指定した場合は請求をその値で固定する
  // 直近のシフトの単価（常勤: 同じスタッフ×同じ案件、スポット: 同じ案件）を引き継ぐ（9306。inherit: false なら単価の設定のまま）
  const sid = ins.meta.last_row_id
  let inherited: ReturnType<typeof inheritView> = null
  if (sid) {
    const pdata = await loadPricingData(c.env.DB, u.company_id, [Number(proj.project_id)])
    const used = await applyPricingToShift(c.env.DB, u.company_id, sid, { data: pdata, inherit: b.inherit === false ? null : 'fresh' })
    const adjStmt = inheritedAdjustStmt(c.env.DB, u.company_id, sid, used)
    if (adjStmt) await adjStmt.run()
    inherited = inheritView(used)
    if (b.unit_price == null) await applyRateOverride(c.env.DB, u.company_id, sid, ov.value, pdata)
    if (b.unit_price != null) await c.env.DB.prepare("UPDATE shifts SET unit_price = ?, bill_rate = ?, bill_unit_type = 'daily', bill_qty = 1, price_locked = 1 WHERE shift_id = ?").bind(b.unit_price, b.unit_price, sid).run()
    // 操作履歴（#159）
    const op = opLog(c.env.DB, u, 'create')
    await c.env.DB.batch(logShifts(op, [sid], { created: true }))
    await finishLog(op)
    // 本人に知らせる（#155）
    await notifyShiftChanges(c, u.company_id, [], await loadShiftSnaps(c.env.DB, u.company_id, [sid]))
  }
  // inherited: 引き継いだ単価（引き継ぎ元のシフトの日付と金額）。引き継がなかったときは null
  return c.json({ ok: true, shift_id: sid, warnings: chk.warnings, inherited })
})

api.put('/admin/shifts/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  // 確定済み（精算）のシフトはメモ以外を変更できない
  const cur = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!cur) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (cur.settle_status === 'confirmed' && (b.status != null || b.start_time != null || b.end_time != null || b.staff_id != null))
    return c.json({ error: '確定済みのシフトは変更できません。精算画面で確定を取り消してください' }, 409)
  if (b.status != null && !SHIFT_STATUSES.includes(b.status)) return c.json({ error: 'シフトの状態が正しくありません' }, 400)
  // 精算を締めた期間のシフトは、状態・時間・スタッフを変えない（#170。メモだけの変更や、同じ値の送信は受け付ける）
  if ((b.status != null && b.status !== cur.status) || (b.start_time != null && b.start_time !== cur.start_time)
    || (b.end_time != null && b.end_time !== cur.end_time) || (b.staff_id != null && Number(b.staff_id) !== cur.staff_id)) {
    const closed = await closedMessage(c.env.DB, u.company_id, cur.work_date)
    if (closed) return c.json({ error: closed }, 409)
  }
  // 欠勤・中止の理由（任意。staff / client。#283）。指定があれば精算のキャンセル料・補償の入力欄に入れる
  if (b.cancel_reason != null && b.cancel_reason !== '' && !['staff', 'client'].includes(b.cancel_reason)) return c.json({ error: '欠勤・中止の理由が正しくありません' }, 400)
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
  // 入店以降の勤怠報告があるシフトを欠勤にするときは、確認（force）を求める（勤務した記録のあるシフトが黙って精算から外れないように。#221）
  if (!staffChanged && b.status === 'absent' && cur.status !== 'absent' && !b.force) {
    const started = await c.env.DB.prepare(`SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ?
      AND report_type IN ('check_in','work_start','break_start','break_end','work_end','check_out') ORDER BY reported_at LIMIT 1`).bind(cur.shift_id).first() as any
    if (started) {
      const label: Record<string, string> = { check_in: '入店', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店' }
      const msg = `${label[started.report_type] || started.report_type}の報告が ${String(started.reported_at).slice(5, 16).replace('-', '/')} にあります（勤務した記録があります）。欠勤にすると精算の対象から外れます`
      return c.json({ error: `${msg}。確認のうえ欠勤にしてください`, warnings: [msg], need_force: true }, 409)
    }
  }
  // 担当者・時間が変わったら、スタッフの『入れます』などの返事を消す（別の人・別の時間には答えていない。#411 の残り）
  const timeChanged = (b.start_time != null && b.start_time !== cur.start_time) || (b.end_time != null && b.end_time !== cur.end_time)
  const db = c.env.DB, sid = cur.shift_id
  // 担当者・時間・状態が変わるときは、変更の前の内容を取っておき、保存の後に本人に知らせる（#155）
  const notifyBefore = staffChanged || timeChanged || (b.status != null && b.status !== cur.status) ? await loadShiftSnaps(db, u.company_id, [sid]) : null
  // 操作履歴（#159）: 変更の前の値を同じ batch の先頭で残し、単価の再計算の後に変更の後の値を入れる
  const op = opLog(db, u, 'update')
  const stmts: D1PreparedStatement[] = [...logShifts(op, [sid]), db.prepare(`UPDATE shifts SET
        status = COALESCE(?, status), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time),
        staff_id = COALESCE(?, staff_id), memo = COALESCE(?, memo),
        legacy_duplicate = CASE WHEN ? = 1 THEN NULL ELSE legacy_duplicate END,
        staff_reply = CASE WHEN ? = 1 THEN NULL ELSE staff_reply END, staff_reply_note = CASE WHEN ? = 1 THEN NULL ELSE staff_reply_note END,
        staff_reply_at = CASE WHEN ? = 1 THEN NULL ELSE staff_reply_at END
      WHERE shift_id = ? AND company_id = ?`)
    .bind(b.status ?? null, b.start_time ?? null, b.end_time ?? null, b.staff_id ?? null, b.memo ?? null, staffChanged ? 1 : 0,
      ...Array(3).fill(staffChanged || timeChanged ? 1 : 0), sid, u.company_id)]
  // 欠勤にした日時を残し（精算のキャンセル料の連絡日の初期値。#283）、欠勤から戻したらキャンセル料・補償を消す
  if (b.status === 'absent' && cur.status !== 'absent') {
    stmts.push(db.prepare('UPDATE shifts SET absent_at = ? WHERE shift_id = ? AND company_id = ?').bind(nowJST(), sid, u.company_id))
    if (b.cancel_reason) stmts.push(db.prepare(`INSERT INTO shift_cancellations (shift_id, company_id, reason, notified_on, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shift_id) DO UPDATE SET reason = excluded.reason, notified_on = excluded.notified_on, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(sid, u.company_id, b.cancel_reason, todayJST(), u.user_id, nowJST()))
  } else if (b.status != null && b.status !== 'absent' && cur.status === 'absent') {
    stmts.push(db.prepare('UPDATE shifts SET absent_at = NULL WHERE shift_id = ? AND company_id = ?').bind(sid, u.company_id),
      db.prepare('DELETE FROM shift_cancellations WHERE shift_id = ? AND company_id = ?').bind(sid, u.company_id))
  }
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
  let cancelled = 0
  try {
    cancelled = staffChanged ? await notifyAutoCancelled(c, sid, cancelToken) : 0
    // 時間・スタッフを変えた場合は単価（時給の数量・スタッフ別単価・支払先）を再計算（手動変更したシフトは除く）
    // 直近のシフトから単価を引き継いだシフトの担当者を替えたときは、新しい担当者で引き継ぎ元を探し直す（9306）
    if (b.start_time != null || b.end_time != null || b.staff_id != null) await applyPricingToShift(c.env.DB, u.company_id, Number(c.req.param('id')),
      { inherit: staffChanged && parsePriceSource(cur.price_source).inherit ? 'fresh' : undefined })
  } finally { await finishLog(op) } // 途中で失敗しても変更の後の値を入れる（入れないと削除の履歴に見える）
  // 欠勤にしたシフトの承認待ちは承認できない（却下が必要）ので、件数を返す（#70）
  const pendingAbsent = b.status === 'absent' && cur.status !== 'absent' ? await pendingCorrectionCount(db, sid) : 0
  if (notifyBefore) await notifyShiftChanges(c, u.company_id, notifyBefore, await loadShiftSnaps(db, u.company_id, [sid]))
  return c.json({ ok: true, ...(cancelled ? { cancelled_corrections: cancelled } : {}), ...(pendingAbsent ? { pending_corrections: pendingAbsent } : {}) })
})

api.delete('/admin/shifts/:id', async (c) => {
  const u = c.get('user')
  const cur = await c.env.DB.prepare('SELECT shift_id, work_date, settle_status FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (cur.settle_status === 'confirmed') return c.json({ error: '確定済みのシフトは削除できません。精算画面で確定を取り消してください' }, 409)
  const closedDel = await closedMessage(c.env.DB, u.company_id, cur.work_date)
  if (closedDel) return c.json({ error: closedDel }, 409)
  // 勤怠・日報の報告があるシフトは削除できない（記録を残すため。欠勤などに変更する）
  const rep = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM attendance_reports WHERE shift_id = ?) + (SELECT COUNT(*) FROM daily_reports WHERE shift_id = ?) AS n')
    .bind(c.req.param('id'), c.req.param('id')).first() as any
  if (rep?.n > 0) return c.json({ error: '勤怠・日報の報告があるシフトは削除できません。状態を「欠勤」などに変更してください' }, 409)
  // 承認待ちの打刻修正申請（打刻漏れの追加）は、処理できなくなるので『取り消し（シフト削除）』にして申請者に知らせる（#70）
  const db = c.env.DB, cancelToken = newCancelToken()
  const notifyBefore = await loadShiftSnaps(db, u.company_id, [cur.shift_id])
  const op = opLog(db, u, 'delete') // 操作履歴（#159）。削除の前の値を残す
  await db.batch([
    ...logShifts(op, [cur.shift_id]),
    ...autoCancelStatements(db, cur.shift_id, 'shift_deleted', actorOf(u), cancelToken),
    db.prepare('DELETE FROM shift_report_tokens WHERE shift_id = ? AND company_id = ?').bind(cur.shift_id, u.company_id),
    db.prepare('DELETE FROM shift_cancellations WHERE shift_id = ? AND company_id = ?').bind(cur.shift_id, u.company_id),
    db.prepare('DELETE FROM shifts WHERE shift_id = ? AND company_id = ?').bind(cur.shift_id, u.company_id),
  ])
  await finishLog(op)
  const cancelled = await notifyAutoCancelled(c, cur.shift_id, cancelToken)
  await notifyShiftChanges(c, u.company_id, notifyBefore, []) // 本人に取消を知らせる（#155）
  return c.json({ ok: true, ...(cancelled ? { cancelled_corrections: cancelled } : {}) })
})

// シフト・募集枠・精算の操作履歴（#159）。新しい順に50件ずつ（before に前のページの最後の log_id を渡す）。
// 条件: entity（shift / slot）と entity_id（1件の履歴）、staff_id（担当スタッフ）、from〜to（操作した日）、action
// 値の ID（スタッフ・案件・確定した人）は名前も返す（names）。削除したシフトの履歴も見られる
const OP_LOG_PAGE = 50
api.get('/admin/operation-logs', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const q = (k: string) => { const v = c.req.query(k); return v === undefined || v === '' ? null : v }
  const entity = q('entity'), entityId = toInt(q('entity_id'), 1), staffId = toInt(q('staff_id'), 1), before = toInt(q('before'), 1)
  const from = q('from'), to = q('to'), action = q('action')
  if (entity !== null && !['shift', 'slot'].includes(entity)) return c.json({ error: '対象の種類が正しくありません' }, 400)
  if (entityId !== null && entity === null) return c.json({ error: '対象の種類（entity）も指定してください' }, 400)
  for (const [v, name] of [[from, '開始日'], [to, '終了日']] as const) if (v !== null && !isISODate(v)) return c.json({ error: `${name}の形式が正しくありません` }, 400)
  if (action !== null && !OP_ACTION_LABELS[action]) return c.json({ error: '操作の種類が正しくありません' }, 400)
  const where = ['l.company_id = ?'], binds: unknown[] = [u.company_id]
  if (entity !== null) { where.push('l.entity = ?'); binds.push(entity) }
  if (entityId !== null) { where.push('l.entity_id = ?'); binds.push(entityId) }
  if (staffId !== null) { where.push('l.staff_id = ?'); binds.push(staffId) }
  if (from !== null) { where.push('l.created_at >= ?'); binds.push(from) }
  if (to !== null) { where.push('l.created_at < ?'); binds.push(addDays(to, 1)) }
  if (action !== null) { where.push('l.action = ?'); binds.push(action) }
  if (before !== null) { where.push('l.log_id < ?'); binds.push(before) }
  const rows = (await db.prepare(`SELECT l.log_id, l.entity, l.entity_id, l.staff_id, l.action, l.before_json, l.after_json, l.op_key, l.created_at, l.actor_user_id, au.name AS actor_name
    FROM operation_logs l LEFT JOIN users au ON au.user_id = l.actor_user_id
    WHERE ${where.join(' AND ')} ORDER BY l.log_id DESC LIMIT ?`).bind(...binds, OP_LOG_PAGE + 1).all()).results as any[]
  const logs = rows.slice(0, OP_LOG_PAGE).map(r => {
    const d = opChanges(r.entity, r.before_json, r.after_json)
    const cur = d.after || d.before || {}
    return { log_id: r.log_id, entity: r.entity, entity_id: r.entity_id, staff_id: r.staff_id, action: r.action, action_label: OP_ACTION_LABELS[r.action] || r.action,
      op_key: r.op_key, created_at: r.created_at, actor_name: r.actor_name || null,
      summary: { work_date: cur.work_date ?? null, start_time: cur.start_time ?? null, end_time: cur.end_time ?? null, staff_id: cur.staff_id ?? null, project_id: cur.project_id ?? null },
      changes: d.changes }
  })
  // 値の ID を名前にする（自社のものだけ）
  const ids = (k: string) => {
    const out = new Set<number>()
    for (const l of logs) for (const v of [l.summary[k as keyof typeof l.summary], ...l.changes.filter(x => x.field === k).flatMap(x => [x.before, x.after])]) if (Number(v) > 0) out.add(Number(v))
    return [...out]
  }
  const [staffRows, projectRows, userRows] = logs.length ? await db.batch([
    db.prepare(`SELECT sp.staff_id AS id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND sp.staff_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(ids('staff_id'))),
    db.prepare(`SELECT project_id AS id, project_name AS name FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(ids('project_id'))),
    db.prepare(`SELECT user_id AS id, name FROM users WHERE company_id = ? AND user_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray(ids('settled_by'))),
  ]) : [{ results: [] }, { results: [] }, { results: [] }]
  const toMap = (r: any) => Object.fromEntries((r.results as any[]).map(x => [x.id, x.name]))
  return c.json({ logs, has_more: rows.length > OP_LOG_PAGE, names: { staff: toMap(staffRows), project: toMap(projectRows), user: toMap(userRows) } })
})

// 日報一覧（#113 ページ送り、#183 未確認のみ、#404 案件・スタッフ・期間、#106 テンプレートの項目、#521 生の report_values は返さない）
// 条件: date（1日）または from〜to、project_id、staff_id、unchecked=1（未確認のみ）、flagged=1（インシデント・クレームのみ）、
// incident_open=1（対応済みでないインシデント・クレームのみ。#169）、offset、limit（既定50・最大200）
// options=1 のときは、絞り込みの選択肢（案件・日報のあるスタッフ）も返す
const DAILY_REPORT_PAGE_MAX = 200
// 未確認の条件。migrations/0050_report_admin.sql の部分索引と同じ式にする（同じ式でないと索引が使われない）
const DR_UNCHECKED_SQL = 'COALESCE(dr.manager_checked, 0) = 0'
const DR_FLAGGED_SQL = '(dr.incident_flag = 1 OR dr.complaint_flag = 1)'
// 対応済みでないインシデント・クレーム（#169）。migrations/0067_report_features.sql の部分索引と同じ式にする。
// ダッシュボードの ToDo・案件詳細のインシデント欄で未対応だけを数えるときも、この式を使う
const DR_INCIDENT_OPEN_SQL = "(dr.incident_flag = 1 OR dr.complaint_flag = 1) AND COALESCE(dr.incident_status, 'open') != 'done'"
// 日報の未提出（#344。日報一覧の「未提出」タブ）。期間（既定は昨日までの7日。最長62日・今日より前）・案件・スタッフで絞り、
// 日報が必要な確定・代打のシフトのうち日報のないものを返す（ダッシュボードの「日報未提出」と同じ判定）
const MISSING_DR_MAX_DAYS = 62
const MISSING_DR_LIMIT = 500
api.get('/admin/daily-reports/missing', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const today = todayJST()
  const to = isISODate(c.req.query('to')) && c.req.query('to')! < today ? c.req.query('to')! : addDays(today, -1)
  const from = isISODate(c.req.query('from')) && c.req.query('from')! <= to ? c.req.query('from')! : addDays(to, -6)
  if ((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 > MISSING_DR_MAX_DAYS - 1) return c.json({ error: `期間は${MISSING_DR_MAX_DAYS}日以内で指定してください` }, 400)
  const projectId = toInt(c.req.query('project_id'), 1), staffId = toInt(c.req.query('staff_id'), 1)
  const rows = (await db.prepare(`
    SELECT s.shift_id, s.work_date, s.start_time, s.end_time, us.name AS staff_name, s.staff_id, p.project_id, p.project_name,
      us.phone AS staff_phone, us.role = 'staff' AS has_login
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status IN ('confirmed','substitute') AND s.work_date BETWEEN ? AND ?
      ${projectId ? 'AND s.project_id = ?' : ''} ${staffId ? 'AND s.staff_id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id)
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE +dr.shift_id IS NULL AND dr.staff_id = s.staff_id AND dr.work_date = s.work_date AND dr.project_id = s.project_id)
    ORDER BY s.work_date DESC, s.start_time, p.project_name, us.name LIMIT ?`)
    .bind(u.company_id, from, to, ...(projectId ? [projectId] : []), ...(staffId ? [staffId] : []), MISSING_DR_LIMIT + 1).all()).results as any[]
  const more = rows.length > MISSING_DR_LIMIT
  const list = rows.slice(0, MISSING_DR_LIMIT)
  // 日報「不要」のシフトは未提出の対象外
  const m = await modesForShifts(db, list.map(r => r.shift_id))
  const missing = list.filter(r => m.get(r.shift_id)?.daily_report_required !== false).map(r => ({ ...r, has_login: !!r.has_login }))
  return c.json({ from, to, missing, has_more: more })
})
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
  const unchecked = q('unchecked') === '1', flagged = q('flagged') === '1', incidentOpen = q('incident_open') === '1'
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
  const extra = (unchecked ? ` AND ${DR_UNCHECKED_SQL}` : '') + (flagged ? ` AND ${DR_FLAGGED_SQL}` : '') + (incidentOpen ? ` AND ${DR_INCIDENT_OPEN_SQL}` : '')
  const [rowsRes, countRes] = await db.batch([
    db.prepare(`
      SELECT dr.*, p.project_name, p.report_template_id, us.name AS staff_name,
        cu.name AS manager_comment_by_name, ku.name AS manager_checked_by_name, iu.name AS incident_updated_by_name
      FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
      JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
      LEFT JOIN users cu ON cu.user_id = dr.manager_comment_by
      LEFT JOIN users ku ON ku.user_id = dr.manager_checked_by
      LEFT JOIN users iu ON iu.user_id = dr.incident_updated_by
      ${base}${extra}
      ORDER BY dr.work_date DESC, dr.submitted_at DESC, dr.daily_report_id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    db.prepare(`SELECT COUNT(*) AS total_all,
        SUM(CASE WHEN ${DR_UNCHECKED_SQL} THEN 1 ELSE 0 END) AS unchecked,
        SUM(CASE WHEN ${DR_FLAGGED_SQL} THEN 1 ELSE 0 END) AS flagged,
        SUM(CASE WHEN ${DR_INCIDENT_OPEN_SQL} THEN 1 ELSE 0 END) AS incident_open,
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
    counts: { all: Number(cnt.total_all || 0), unchecked: Number(cnt.unchecked || 0), flagged: Number(cnt.flagged || 0), incident_open: Number(cnt.incident_open || 0) },
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
  let commentChanged = false
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
    commentChanged = !!comment && comment !== (cur.manager_comment || '')
    // コメントが変わったら、スタッフの既読（#158）を外す（管理画面の「スタッフ既読」は新しいコメントを開いてから付く）
    if (comment !== (cur.manager_comment || null)) sets.push('comment_read_at = NULL')
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
  // コメントを新しく付けた・書き換えたときは、スタッフに知らせる（#158。ログインのない人には送らない）
  if (commentChanged && (r.meta?.changes ?? 0)) return c.json({ ok: true, staff_notified: await notifyReportComment(c, u.company_id, id!, u.name) })
  return c.json({ ok: true })
})

// インシデント・クレームの対応状況（#169）。status: open（未対応）/ in_progress（対応中）/ done（対応済み）、memo: 対応メモ（空欄で削除）、
// client_shared: true でクライアントに共有した日時を残す（false で外す）。送らなかった項目は変えない。
// expected_updated_at（開いたときの incident_updated_at）を送ると、その後にほかの管理者が更新していたら 409 を返して書かない
const INCIDENT_STATUSES = ['open', 'in_progress', 'done'] as const
const INCIDENT_MEMO_MAX = 2000
const INCIDENT_CONFLICT = '開いている間に、ほかの管理者が対応状況を更新しました。内容を確かめてから保存してください'
api.put('/admin/daily-reports/:id/incident', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({})) as any
  const has = (k: string) => b && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, k)
  const id = toInt(c.req.param('id'), 1)
  const cur = id ? await db.prepare(`SELECT daily_report_id, incident_flag, complaint_flag, incident_status, incident_memo, incident_updated_at, incident_client_shared_at
    FROM daily_reports WHERE daily_report_id = ? AND company_id = ?`).bind(id, u.company_id).first() as any : null
  if (!cur) return c.json({ error: '日報が見つかりません' }, 404)
  if (!cur.incident_flag && !cur.complaint_flag) return c.json({ error: 'この日報にはインシデント・クレームの報告がありません' }, 400)
  const sets: string[] = []; const vals: any[] = []
  const now = nowJST()
  if (has('status')) {
    if (!oneOf(b.status, INCIDENT_STATUSES)) return c.json({ error: '対応状況が正しくありません' }, 400)
    sets.push('incident_status = ?'); vals.push(b.status === 'open' ? null : b.status)
  }
  if (has('memo')) {
    if (b.memo !== null && typeof b.memo !== 'string') return c.json({ error: '対応メモの形式が正しくありません' }, 400)
    const memo = typeof b.memo === 'string' && b.memo.trim() ? b.memo.trim() : null
    if (memo && memo.length > INCIDENT_MEMO_MAX) return c.json({ error: `対応メモは${INCIDENT_MEMO_MAX}文字以内で入力してください` }, 400)
    sets.push('incident_memo = ?'); vals.push(memo)
  }
  if (has('client_shared')) {
    if (typeof b.client_shared !== 'boolean') return c.json({ error: 'クライアントへの共有の指定が正しくありません' }, 400)
    // 共有済みのまま保存したときは、最初に共有した日時を保つ
    sets.push('incident_client_shared_at = ?'); vals.push(b.client_shared ? (cur.incident_client_shared_at || now) : null)
  }
  if (!sets.length) return c.json({ error: '変更する項目がありません' }, 400)
  sets.push('incident_updated_by = ?', 'incident_updated_at = ?'); vals.push(u.user_id, now)
  const guard = has('expected_updated_at')
  if (guard && (b.expected_updated_at || null) !== (cur.incident_updated_at || null)) return c.json({ error: INCIDENT_CONFLICT }, 409)
  const r = await db.prepare(`UPDATE daily_reports SET ${sets.join(', ')} WHERE daily_report_id = ? AND company_id = ?${guard ? " AND COALESCE(incident_updated_at, '') = ?" : ''}`)
    .bind(...vals, id, u.company_id, ...(guard ? [cur.incident_updated_at || ''] : [])).run()
  if (guard && !(r.meta?.changes ?? 0)) return c.json({ error: INCIDENT_CONFLICT }, 409)
  return c.json({ ok: true, incident_updated_at: now })
})
// スタッフが新しく印を付けた日報を、対応済みから未対応に戻す（POST /staff/daily-report から呼ぶ）
function reopenIncidentStmt(db: D1Database, shiftId: number) {
  return db.prepare(`UPDATE daily_reports SET incident_status = NULL WHERE shift_id = ? AND incident_status = 'done'`).bind(shiftId)
}

// スタッフアプリに出す社内の情報（#496 #523）。ranking_visible: 実績画面に案件内の順位を出す、ranking_anonymous: ほかの人の名前を出さない、
// show_coworkers: 同じ日・同じ案件に入るほかのスタッフ（姓と時刻）を出す。送った項目だけを書き換える（ほかの設定は上書きしない）
const STAFF_VIEW_KEYS = ['ranking_visible', 'ranking_anonymous', 'show_coworkers'] as const
api.get('/admin/settings/staff-view', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ ...staffViewSettings(row?.settings_json), can_edit: u.role === 'company_admin' })
})
api.put('/admin/settings/staff-view', async (c) => {
  const u = c.get('user')
  if (u.role !== 'company_admin') return c.json({ error: 'この設定は会社管理者だけが変更できます' }, 403)
  const b = await c.req.json().catch(() => ({})) as any
  const keys = STAFF_VIEW_KEYS.filter(k => b && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, k))
  if (!keys.length) return c.json({ error: '変更する項目がありません' }, 400)
  if (keys.some(k => typeof b[k] !== 'boolean')) return c.json({ error: '設定の値が正しくありません' }, 400)
  // 真偽値は json('true') で入れる（1/0 の数値にしない。staffViewSettings は true/false だけを読む）
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END,
    ${keys.map(() => '?, json(?)').join(', ')}) WHERE company_id = ?`)
    .bind(...keys.flatMap(k => [`$.${k}`, b[k] ? 'true' : 'false']), u.company_id).run()
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ ok: true, ...staffViewSettings(row?.settings_json) })
})

// 案件の月間目標（#292）。稼働中の案件と、日報テンプレートの数値項目・設定済みの目標
api.get('/admin/project-goals', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT p.project_id, p.project_name, p.show_performance, p.performance_goals_json, t.fields_json
    FROM projects p LEFT JOIN report_templates t ON t.template_id = p.report_template_id
    WHERE p.company_id = ? AND COALESCE(p.status, 'active') = 'active' ORDER BY p.project_name, p.project_id`).bind(u.company_id).all()).results as any[]
  return c.json({
    projects: rows.map(r => {
      const fields = parseTemplateFields(r.fields_json).filter(f => f.type === 'number').map(f => ({ key: f.key, label: f.label }))
      return { project_id: r.project_id, project_name: r.project_name, show_performance: !!r.show_performance, fields, goals: parseGoals(r.performance_goals_json, fields) }
    }),
  })
})
// goals: { 項目のキー: 件数 }。空欄・0 の項目は目標なしにする。テンプレートの数値項目に無いキーは受け付けない
api.put('/admin/projects/:id/goals', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id')) as any
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({})) as any
  if (!b || typeof b.goals !== 'object' || b.goals === null || Array.isArray(b.goals)) return c.json({ error: '目標の形式が正しくありません' }, 400)
  const t = p.report_template_id ? await db.prepare('SELECT fields_json FROM report_templates WHERE template_id = ?').bind(p.report_template_id).first() as any : null
  const fields = parseTemplateFields(t?.fields_json).filter(f => f.type === 'number')
  const goals: Record<string, number> = {}
  for (const [k, v] of Object.entries(b.goals)) {
    const f = fields.find(x => x.key === k)
    if (!f) return c.json({ error: '日報テンプレートに無い項目には目標を設定できません' }, 400)
    if (v === null || v === '' || v === 0) continue
    const n = Number(v)
    if (typeof v === 'boolean' || !Number.isInteger(n) || n < 0 || n > GOAL_MAX) return c.json({ error: `「${f.label}」の目標は0〜${GOAL_MAX}の整数で入力してください` }, 400)
    if (n > 0) goals[k] = n
  }
  await db.prepare('UPDATE projects SET performance_goals_json = ? WHERE project_id = ? AND company_id = ?')
    .bind(Object.keys(goals).length ? JSON.stringify(goals) : null, p.project_id, u.company_id).run()
  return c.json({ ok: true, goals })
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
// 項目: テンプレートの順に、数値項目を重複なく並べる（同じキーは最初のテンプレートのラベル）。
// sumRows（je.key AS k・isnum の集計行）から、テンプレートに無い数値のキーも足す（テンプレートで文字の項目のキーは足さない）
function metricFields(templates: any[], sumRows: any[]): AnalyticsField[] {
  const fields: AnalyticsField[] = []; const seen = new Set<string>(); const textKeys = new Set<string>()
  for (const t of templates) {
    let defs: any[] = []
    try { defs = JSON.parse(t.fields_json) } catch { defs = [] }
    for (const f of Array.isArray(defs) ? defs : []) {
      if (!f || typeof f.key !== 'string' || !f.key) continue
      if (f.type !== 'number') { textKeys.add(f.key); continue }
      if (!seen.has(f.key)) { seen.add(f.key); fields.push({ key: f.key, label: String(f.label || f.key) }) }
    }
  }
  for (const r of sumRows) {
    if (r.isnum && !seen.has(r.k) && !textKeys.has(r.k)) { seen.add(r.k); fields.push({ key: r.k, label: r.k }) }
  }
  return fields
}
// 日報の数値項目の合計（#184。スタッフ詳細・スキルシート・案件詳細の実績）。where は daily_reports dr の条件、group は GROUP BY の式。
// 項目は実績分析と同じ規則（metricFields）で決め、group の値ごとに { キー: 合計 } を返す（その組に無い項目は 0）
async function reportMetricSums(db: D1Database, where: string, binds: any[], group: string) {
  const [tpl, sums] = await db.batch([
    db.prepare(`SELECT DISTINCT rt.template_id, rt.fields_json FROM daily_reports dr
      JOIN projects p ON p.project_id = dr.project_id AND p.company_id = dr.company_id JOIN report_templates rt ON rt.template_id = p.report_template_id
      WHERE ${where} ORDER BY rt.template_id`).bind(...binds),
    db.prepare(`SELECT ${group} AS g, je.key AS k, SUM(${ANALYTICS_NUM}) AS v, MAX(je.type IN ('integer','real')) AS isnum
      FROM daily_reports dr, ${ANALYTICS_JE} WHERE ${where} GROUP BY g, je.key`).bind(...binds),
  ])
  const sumRows = (sums.results || []) as any[]
  const fields = metricFields((tpl.results || []) as any[], sumRows)
  const keys = new Set(fields.map(f => f.key))
  const values = new Map<string, Record<string, number>>()
  const valuesOf = (g: unknown) => {
    const k = String(g ?? '')
    if (!values.has(k)) values.set(k, Object.fromEntries(fields.map(f => [f.key, 0])))
    return values.get(k)!
  }
  for (const r of sumRows) if (keys.has(r.k)) valuesOf(r.g)[r.k] = Number(r.v) || 0
  return { fields, valuesOf }
}
async function loadAnalytics(db: D1Database, cid: number, month: string) {
  const where = 'dr.company_id = ? AND dr.work_date >= ? AND dr.work_date < ?'
  const bind = [cid, ...monthBounds(month)]
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
  const fields = metricFields(res[0], res[1 + groups.length]) // 合計の行から、テンプレートに無い数値項目を拾う
  const seen = new Set(fields.map(f => f.key))
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
// 配信先の案件名・スタッフ名と、配信した人の名前も返す。
// 状態（state）: draft（下書き）/ scheduled（予約。配信予定日時の前）/ published（配信済み。予約の時刻を過ぎたものを含む）/ withdrawn（取消）（#291 #157）。
// status=pending で下書き・予約、withdrawn で取り消したもの、expired で掲載終了のものに絞る。下書き・予約は先頭に出す
const ADMIN_NOTICE_PAGE = 50
const NOTICE_STATE_SQL = `CASE WHEN n.status = 'scheduled' AND ${NOTICE_LIVE_SQL} THEN 'published' ELSE n.status END`
const NOTICE_PENDING_SQL = `(n.status = 'draft' OR (n.status = 'scheduled' AND NOT ${NOTICE_LIVE_SQL}))`
api.get('/admin/notices', async (c) => {
  const u = c.get('user')
  const offset = toInt(c.req.query('offset'), 0, 100000) ?? 0
  if (offset === 0) c.executionCtx.waitUntil(publishDueNotices(c.env, u.company_id).catch(() => {}))
  const where: string[] = ['n.company_id = ?']
  const binds: any[] = [u.company_id]
  const status = c.req.query('status')
  if (status === 'pending') where.push(NOTICE_PENDING_SQL)
  else if (status === 'withdrawn') where.push(`n.status = 'withdrawn'`)
  else if (status === 'expired') where.push(`n.status != 'withdrawn' AND ${NOTICE_EXPIRED_SQL}`)
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
      ${NOTICE_STATE_SQL} AS state, n.expires_at, ${NOTICE_EXPIRED_SQL} AS expired, n.send_email, n.email_nologin,
      n.updated_at, upu.name AS updated_by_name, n.withdrawn_at, n.withdraw_reason, wdu.name AS withdrawn_by_name,
      n.response_options, n.response_comment, (SELECT COUNT(*) FROM notice_responses nr WHERE nr.notice_id = n.notice_id) AS response_count,
      (SELECT COUNT(*) FROM notice_attachments a WHERE a.notice_id = n.notice_id) AS attachment_count,
      CASE WHEN n.reads_purged_at IS NULL THEN ${NOTICE_READ_COUNT_NOW_SQL} ELSE n.final_read_count END AS read_count,
      CASE WHEN n.reads_purged_at IS NULL THEN ${NOTICE_TARGET_COUNT_NOW_SQL} ELSE n.final_target_count END AS staff_total,
      CASE n.target_type
        WHEN 'project' THEN (SELECT group_concat(p.project_name, '、') FROM notice_targets nt JOIN projects p ON p.project_id = nt.target_id AND p.company_id = n.company_id
          WHERE nt.notice_id = n.notice_id AND nt.target_type = 'project')
        WHEN 'staff' THEN (SELECT group_concat(su.name, '、') FROM notice_targets nt JOIN staff_profiles tsp ON tsp.staff_id = nt.target_id AND tsp.company_id = n.company_id
          JOIN users su ON su.user_id = tsp.user_id WHERE nt.notice_id = n.notice_id AND nt.target_type = 'staff')
      END AS target_names
    FROM notices n LEFT JOIN users cu ON cu.user_id = n.created_by AND cu.company_id = n.company_id
    LEFT JOIN users upu ON upu.user_id = n.updated_by AND upu.company_id = n.company_id
    LEFT JOIN users wdu ON wdu.user_id = n.withdrawn_by AND wdu.company_id = n.company_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN ${NOTICE_PENDING_SQL} THEN 0 ELSE 1 END, n.published_at DESC, n.notice_id DESC LIMIT ? OFFSET ?`).bind(...binds).all()).results as any[]
  const page = rows.slice(0, ADMIN_NOTICE_PAGE).map(n => ({ ...n, expired: n.expired ? 1 : 0, response_options: parseResponseOptions(n.response_options) }))
  // メールの送信結果（状態ごとの人数）。メールを送らなかったお知らせは email_counts = null
  const ids = page.map(n => n.notice_id)
  const counts = ids.length ? (await c.env.DB.prepare(`SELECT notice_id, status, COUNT(*) AS n FROM notice_email_deliveries
    WHERE company_id = ? AND notice_id IN (SELECT value FROM json_each(?)) GROUP BY notice_id, status`).bind(u.company_id, JSON.stringify(ids)).all()).results as any[] : []
  const byNotice = new Map<number, Record<string, number>>()
  for (const r of counts) { const m = byNotice.get(r.notice_id) || {}; m[r.status] = r.n; byNotice.set(r.notice_id, m) }
  const files = await loadNoticeAttachments(c.env.DB, page.filter(n => n.attachment_count > 0).map(n => n.notice_id))
  return c.json({ notices: page.map(n => ({ ...n, email_counts: byNotice.get(n.notice_id) || null, attachments: files.get(n.notice_id) || [] })),
    has_more: rows.length > ADMIN_NOTICE_PAGE, offset })
})

// 個人あての配信先の候補（#157）。いま在籍中で、ログインのあるスタッフ（お知らせが届く人。NOTICE_MEMBER_NOW_SQL と同じ条件）
api.get('/admin/notices/recipients', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT sp.staff_id, us.name, sp.kana FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND us.company_id = sp.company_id AND us.role = 'staff' AND us.status = 'active' AND sp.merged_into_staff_id IS NULL
    ORDER BY COALESCE(NULLIF(sp.kana, ''), us.name), sp.staff_id LIMIT 3000`).bind(u.company_id).all()).results
  return c.json({ staff: rows })
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
// nologin: ログインのない人あて（#281）。アプリを開くボタンと「確認しました」のリンクを付けない
async function sendNoticeEmails(env: Bindings, noticeId: number, companyId: number, title: string, body: string, recipients: NoticeMailRecipient[],
  opts: { idempotencyKey?: string; record?: boolean; nologin?: boolean } = {}) {
  const db = env.DB
  const record = opts.record !== false
  try {
    const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '')
    const url = `${base}/staff#notices/${noticeId}`
    // 件名・末尾に会社名・重要度・案件名・問い合わせ先を入れ、返信先を企業のアドレスにする（#367 #455）。
    // 「確認しました」のリンクは1人ずつのワンタイムのトークン（#454。確認が要らないお知らせには付けない）
    const [contact, n] = await Promise.all([
      loadMailContact(db, companyId),
      db.prepare(`SELECT n.importance, n.reads_purged_at, CASE WHEN n.target_type = 'project' THEN (SELECT group_concat(p.project_name, '、') FROM notice_targets nt
          JOIN projects p ON p.project_id = nt.target_id AND p.company_id = n.company_id WHERE nt.notice_id = n.notice_id AND nt.target_type = 'project') END AS project_names
        FROM notices n WHERE n.notice_id = ? AND n.company_id = ?`).bind(noticeId, companyId).first() as Promise<any>,
    ])
    const tokens = n && !n.reads_purged_at && !opts.nologin ? await createNoticeAckTokens(db, noticeId, companyId, recipients.map(r => r.user_id)) : new Map<number, string>()
    const inputs = recipients.map(r => {
      const token = tokens.get(r.user_id)
      const tpl = noticeEmail({ name: r.name, title, body, url, companyName: contact.company_name, importance: n?.importance, projectNames: n?.project_names,
        ackUrl: token ? `${base}/notice-ack?token=${token}` : null, contactEmail: contact.reply_to, contactPhone: contact.phone, noApp: !!opts.nologin })
      return { to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text, type: 'notice', company_id: companyId, reply_to: contact.reply_to }
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

// メールの本文。案件あてなら、どの案件あてかを先頭に書く（#455）。
// 添付・回答・掲載期限があれば、末尾にアプリで確認・回答するよう書き添える（#555 #554 #294。添付そのものはメールに付けない）
async function noticeMailBody(db: D1Database, n: { notice_id: number; company_id: number; target_type: string; body: string | null }) {
  const [r, extra] = await Promise.all([
    n.target_type === 'project' ? db.prepare(`SELECT group_concat(p.project_name, '、') AS names FROM notice_targets nt JOIN projects p ON p.project_id = nt.target_id AND p.company_id = ?
      WHERE nt.notice_id = ? AND nt.target_type = 'project'`).bind(n.company_id, n.notice_id).first() as Promise<any> : Promise.resolve(null),
    db.prepare(`SELECT (SELECT COUNT(*) FROM notice_attachments a WHERE a.notice_id = n.notice_id) AS files, n.response_options, n.response_comment, n.expires_at
      FROM notices n WHERE n.notice_id = ? AND n.company_id = ?`).bind(n.notice_id, n.company_id).first() as Promise<any>,
  ])
  const notes: string[] = []
  if (Number(extra?.files) > 0) notes.push(`※ 添付ファイルがあります（${Number(extra.files)}件）。アプリのお知らせで確認してください。`)
  if (parseResponseOptions(extra?.response_options).length || extra?.response_comment) notes.push('※ 回答をお願いします。アプリのお知らせから回答してください。')
  if (extra?.expires_at) notes.push(`※ 掲載期限: ${String(extra.expires_at).slice(0, 10)}`)
  const body = r?.names ? `対象の案件: ${r.names}\n\n${n.body ?? ''}` : String(n.body ?? '')
  return notes.length ? `${body}\n\n${notes.join('\n')}` : body
}

const NOTICE_IMPORTANCE = ['normal', 'important', 'urgent'] as const
const NOTICE_TARGET_TYPES = ['all', 'project', 'staff'] as const

// 配信のしかた（#291）: publish = すぐに配信 / draft = 下書き（スタッフには出さない）/ schedule = 予約（scheduled_at に配信）
const NOTICE_MODES = ['publish', 'draft', 'schedule'] as const
api.post('/admin/notices', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const mode = b.mode || 'publish'
  if (!oneOf(mode, NOTICE_MODES)) return c.json({ error: '配信のしかたの指定が正しくありません' }, 400)
  const p = await parseNoticeInput(c.env.DB, u.company_id, b)
  if ('error' in p) return c.json({ error: p.error }, 400)
  const { title, body, target_type, target_ids, importance } = p.v
  let publishedAt = nowJST()
  if (mode === 'schedule') {
    const at = parseNoticeScheduleAt(b.scheduled_at)
    if ('error' in at) return c.json({ error: at.error }, 400)
    publishedAt = at.at
  }
  const expErr = noticeExpiryError(p.v.expires_at, publishedAt)
  if (expErr) return c.json({ error: expErr }, 400)
  const status = mode === 'draft' ? 'draft' : mode === 'schedule' ? 'scheduled' : 'published'
  // 二重送信の防止（#105）: 画面が発行した一意キー（client_request_id）が同じなら受け付けない。
  // キーが無い呼び出しも、同じ人が同じ内容を直前に配信していれば重複として扱う
  // （予約中のものは published_at が先の日時なので比べない。同じ文面を別の日時に予約できるように #291）
  const requestId = typeof b.client_request_id === 'string' && b.client_request_id.trim() ? b.client_request_id.trim().slice(0, 64) : null
  const since = new Date(Date.now() + 9 * 3600 * 1000 - NOTICE_DUP_WINDOW_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const dup = await c.env.DB.prepare(`SELECT notice_id FROM notices WHERE company_id = ? AND created_by = ? AND title = ? AND COALESCE(body, '') = ?
    AND target_type = ? AND COALESCE(target_ids, '') = ? AND published_at >= ? AND published_at <= ? LIMIT 1`)
    .bind(u.company_id, u.user_id, title, body, target_type, target_ids, since, nowJST()).first() as any
  if (dup) return c.json({ error: '同じお知らせを配信したばかりです。一覧を確認してください', duplicate: true, notice_id: dup.notice_id }, 409)
  // 配信先（notice_targets）は notices のトリガーで展開する（0052）
  const ins = await c.env.DB.prepare(`INSERT INTO notices (company_id, title, body, target_type, target_ids, importance, read_required, published_at, created_by, client_request_id,
      status, expires_at, send_email, response_options, response_comment, email_nologin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING notice_id`)
    .bind(u.company_id, title, body, target_type, target_ids, importance, p.v.read_required, publishedAt, u.user_id, requestId,
      status, p.v.expires_at, b.send_email ? 1 : 0, p.v.response_options, p.v.response_comment, b.email_nologin === true ? 1 : 0).first() as any
  if (!ins) return c.json({ error: 'このお知らせは配信済みです。一覧を確認してください', duplicate: true }, 409)
  const noticeId = Number(ins.notice_id)

  // メール通知（対象者判定ロジックは既存のnotice表示ロジックを再利用。既読状態には一切影響しない）
  // 送信対象・メール未登録の人数を返し、1人ずつの結果を記録する（#24）。連携スタッフは雇用元の本人のアドレスに送る（#128）。
  // 下書き・予約のメールは、配信するとき（publish・予約の時刻の定期処理）に送る
  const email = status === 'published' && b.send_email
    ? await deliverNoticeEmails(c.env, u.company_id, noticeId, p => c.executionCtx.waitUntil(p)) : null
  return c.json({ ok: true, notice_id: noticeId, status, published_at: publishedAt, email })
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
  if (!noticeIsLive(n)) return c.json({ error: n.status === 'withdrawn' ? '取り消したお知らせは再通知できません' : '配信前のお知らせは再通知できません' }, 400)
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
  const rows = await noticeReadRows(c.env.DB, n.notice_id, u.company_id)
  const read = rows.filter(r => r.is_read).map(r => ({ name: r.name, read_at: r.read_at }))
    .sort((a, b) => String(a.read_at || '').localeCompare(String(b.read_at || '')))
  const unread = rows.filter(r => !r.is_read).map(r => ({ name: r.name }))
  // 回答（#554）。選択肢ごとの人数・回答した人・まだの人（今の配信対象の人だけ）
  const options = parseResponseOptions(n.response_options)
  let responses: any = null
  if (options.length || n.response_comment) {
    const answered = rows.filter(r => r.answered_at)
    const counts: Record<string, number> = Object.fromEntries(options.map(o => [o, 0]))
    for (const r of answered) if (r.choice != null) counts[r.choice] = (counts[r.choice] || 0) + 1
    responses = { options, comment: !!n.response_comment, counts,
      answered: answered.map(r => ({ name: r.name, choice: r.choice, comment: r.comment, answered_at: r.answered_at })),
      unanswered: rows.filter(r => !r.answered_at).map(r => ({ name: r.name })) }
  }
  return c.json({ read, unread, purged: false, read_count: read.length, target_count: rows.length, state: noticeState(n), responses })
})

// 今の配信対象の人ごとの既読・回答（既読状況と回答の CSV で共用）
async function noticeReadRows(db: D1Database, noticeId: number, companyId: number) {
  return (await db.prepare(`
    SELECT DISTINCT us.user_id, us.name, sp.staff_id, er.employee_number,
      CASE WHEN r.read_at IS NULL THEN NULL ELSE datetime(r.read_at, '+9 hours') END AS read_at, r.user_id IS NOT NULL AS is_read,
      nr.choice, nr.comment, COALESCE(nr.updated_at, nr.answered_at) AS answered_at
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    LEFT JOIN notice_reads r ON r.notice_id = n.notice_id AND r.user_id = us.user_id
    LEFT JOIN notice_responses nr ON nr.notice_id = n.notice_id AND nr.user_id = us.user_id
    LEFT JOIN employee_records er ON er.staff_id = sp.staff_id AND er.company_id = n.company_id
    WHERE n.notice_id = ? AND n.company_id = ? AND ${NOTICE_MEMBER_NOW_SQL} AND ${NOTICE_TARGET_SQL}
    ORDER BY us.name`).bind(noticeId, companyId).all()).results as any[]
}

// 回答の CSV（#554。出欠の集計などに使う）。今の配信対象の人を全員出し、まだ答えていない人は回答の列を空にする
api.get('/admin/notices/:id{[0-9]+}/responses.csv', async (c) => {
  const u = c.get('user')
  const n = await ownNotice(c.env.DB, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  const rows = await noticeReadRows(c.env.DB, n.notice_id, u.company_id)
  const csv = toCsv(['スタッフID', '社員番号', '氏名', '回答', 'コメント', '回答日時', '既読', '既読日時'],
    rows.map(r => [r.staff_id, r.employee_number, r.name, r.choice ?? (r.answered_at ? '（記入のみ）' : '未回答'), r.comment, r.answered_at, r.is_read ? '既読' : '未読', r.read_at]),
    { textCols: ['社員番号'] })
  return csvResponse(`お知らせ回答_${n.notice_id}.csv`, csv)
})

// ============ お知らせの下書き・予約・修正・取消・掲載期限・回答・添付（w5-notice-features: #157 #291 #294 #554 #555） ============
// 公開中か（NOTICE_LIVE_SQL と同じ判定。配信済みと、配信予定日時を過ぎた予約）。published_at は日本時間
function noticeIsLive(n: { status?: string | null; published_at?: string | null }): boolean {
  const st = n.status || 'published'
  return st === 'published' || (st === 'scheduled' && String(n.published_at || '') <= nowJST())
}
function noticeState(n: any): string { return noticeIsLive(n) ? 'published' : String(n.status || 'published') }

const NOTICE_TITLE_MAX = 200
const NOTICE_BODY_MAX = 10000
const NOTICE_RESPONSE_OPTIONS_MAX = 8
const NOTICE_RESPONSE_OPTION_LEN = 30
const NOTICE_SCHEDULE_MAX_DAYS = 180
const NOTICE_WITHDRAW_REASON_MAX = 200

// 回答の選択肢（配列か、1行に1つの文字列）を JSON の文字列にそろえる。空なら null（#554）
function normalizeResponseOptions(raw: unknown): { value: string | null } | { error: string } {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/)
  const opts = [...new Set(list.map(x => String(x ?? '').trim()).filter(Boolean))]
  if (opts.length > NOTICE_RESPONSE_OPTIONS_MAX) return { error: `回答の選択肢は${NOTICE_RESPONSE_OPTIONS_MAX}個までにしてください` }
  if (opts.some(o => o.length > NOTICE_RESPONSE_OPTION_LEN)) return { error: `回答の選択肢は1つ${NOTICE_RESPONSE_OPTION_LEN}文字以内にしてください` }
  return { value: opts.length ? JSON.stringify(opts) : null }
}

type NoticeInput = {
  title: string; body: string; target_type: string; target_ids: string; importance: string; read_required: number
  expires_at: string | null; response_options: string | null; response_comment: number
}
// 作成・修正の入力の検証。cur（今の行）を渡したときは、送られた項目だけを変える
async function parseNoticeInput(db: D1Database, companyId: number, b: any, cur?: any): Promise<{ v: NoticeInput } | { error: string }> {
  const has = (k: string) => !cur || Object.prototype.hasOwnProperty.call(b, k)
  const title = has('title') ? String(b.title ?? '').trim() : String(cur.title ?? '')
  if (!title) return { error: 'タイトルは必須です' }
  if (title.length > NOTICE_TITLE_MAX) return { error: `タイトルは${NOTICE_TITLE_MAX}文字以内にしてください` }
  const body = has('body') ? String(b.body ?? '') : String(cur.body ?? '')
  if (body.length > NOTICE_BODY_MAX) return { error: `本文は${NOTICE_BODY_MAX}文字以内にしてください` }
  const target_type = has('target_type') ? (b.target_type || 'all') : (cur.target_type || 'all')
  if (!oneOf(target_type, NOTICE_TARGET_TYPES)) return { error: '配信対象の指定が正しくありません' }
  const importance = has('importance') ? (b.importance || 'normal') : (cur.importance || 'normal')
  if (!oneOf(importance, NOTICE_IMPORTANCE)) return { error: '重要度の指定が正しくありません' }
  let target_ids = cur ? String(cur.target_ids ?? '') : ''
  if (has('target_type') || has('target_ids')) {
    const ids = await normalizeNoticeTargetIds(db, companyId, target_type, b.target_ids)
    if (ids == null) return { error: target_type === 'project' ? '対象の案件を選んでください' : '対象のスタッフを選んでください' }
    target_ids = ids
  }
  const read_required = (has('read_required') ? !!b.read_required : !!cur.read_required) ? 1 : 0
  // 掲載期限（#294）は日付で受け取り、その日の終わりまで出す
  let expires_at: string | null = cur ? (cur.expires_at ?? null) : null
  if (has('expires_at')) {
    const d = b.expires_at == null ? '' : String(b.expires_at).trim().slice(0, 10)
    if (d && !isISODate(d)) return { error: '掲載期限の日付が正しくありません' }
    expires_at = d ? `${d} 23:59:59` : null
  }
  let response_options: string | null = cur ? (cur.response_options ?? null) : null
  if (has('response_options')) {
    const r = normalizeResponseOptions(b.response_options)
    if ('error' in r) return r
    response_options = r.value
  }
  const response_comment = (has('response_comment') ? !!b.response_comment : !!cur.response_comment) ? 1 : 0
  return { v: { title, body, target_type, target_ids, importance, read_required, expires_at, response_options, response_comment } }
}

// 予約の配信日時（'YYYY-MM-DDTHH:MM' か 'YYYY-MM-DD HH:MM'。日本時間）。今より後で、180日以内
function parseNoticeScheduleAt(raw: unknown): { at: string } | { error: string } {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(String(raw ?? '').trim())
  if (!m || !isISODate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) return { error: '配信日時を正しく入力してください' }
  const at = `${m[1]} ${m[2]}:${m[3]}:00`
  if (at <= nowJST()) return { error: '配信日時は今より後にしてください' }
  if (m[1] > addDays(todayJST(), NOTICE_SCHEDULE_MAX_DAYS)) return { error: `配信日時は${NOTICE_SCHEDULE_MAX_DAYS}日以内にしてください` }
  return { at }
}
function noticeExpiryError(expiresAt: string | null, publishedAt: string): string | null {
  if (!expiresAt) return null
  return expiresAt.slice(0, 10) < String(publishedAt).slice(0, 10) ? '掲載期限は配信日以降の日付にしてください' : null
}

// 対象者へのお知らせメール（#24 #128）。1人ずつの記録（notice_email_deliveries）を作り、送信は wait に渡す
// （画面からは waitUntil、定期処理では終わるまで待つ）。onlyNew: まだ送っていない人だけに送る（配信の後に配信先を足したとき #157）
async function deliverNoticeEmails(env: Bindings, companyId: number, noticeId: number, wait: (p: Promise<unknown>) => void, opts: { onlyNew?: boolean } = {}) {
  const db = env.DB
  let targets = await resolveNoticeTargets(db, companyId, noticeId)
  // ログインのないスタッフにもメールで送る設定（#281）なら、配信対象のうちメールアドレスのある人を足す（既読率の対象には入れない）
  let nologin = (await db.prepare('SELECT email_nologin FROM notices WHERE notice_id = ? AND company_id = ?').bind(noticeId, companyId).first() as any)?.email_nologin
    ? await resolveNoticeNologinTargets(db, companyId, noticeId) : []
  if (opts.onlyNew && (targets.length || nologin.length)) {
    const done = new Set(((await db.prepare('SELECT user_id FROM notice_email_deliveries WHERE notice_id = ?').bind(noticeId).all()).results as any[]).map(r => Number(r.user_id)))
    targets = targets.filter(t => !done.has(Number(t.user_id)))
    nologin = nologin.filter(t => !done.has(Number(t.user_id)))
  }
  const app = await noticeMailRecipients(db, targets)
  const nl = await noticeMailRecipients(db, nologin)
  const nlWith = nl.withEmail
  const withEmail = app.withEmail
  // ログインのない人はアドレスのある人だけを記録する（送る手段のない人を『未登録』として数えない）
  const rows = [...app.rows, ...nl.rows.filter(r => r.s !== 'no_email')]
  if (rows.length) {
    await db.prepare(`INSERT OR IGNORE INTO notice_email_deliveries (notice_id, company_id, user_id, status, created_at)
      SELECT ?, ?, json_extract(value, '$.u'), json_extract(value, '$.s'), ? FROM json_each(?)`)
      .bind(noticeId, companyId, nowJST(), JSON.stringify(rows)).run()
  }
  if (withEmail.length || nlWith.length) {
    const n = await db.prepare('SELECT title, body, target_type FROM notices WHERE notice_id = ? AND company_id = ?').bind(noticeId, companyId).first() as any
    const mailBody = await noticeMailBody(db, { notice_id: noticeId, company_id: companyId, target_type: n.target_type, body: n.body })
    // 足した配信先への送信は、最初の配信と別の冪等キーにする（同じキーだと送信サービスが送らない）
    if (withEmail.length) wait(sendNoticeEmails(env, noticeId, companyId, n.title, mailBody, withEmail,
      opts.onlyNew ? { idempotencyKey: `notice-${noticeId}-add-${withEmail.map(r => r.user_id).join('.').slice(0, 100)}` } : {}))
    // ログインのない人へのメールは、アプリを開くボタンと「確認しました」を付けない（#281）
    if (nlWith.length) wait(sendNoticeEmails(env, noticeId, companyId, n.title, mailBody, nlWith,
      { nologin: true, idempotencyKey: `notice-${noticeId}-nologin${opts.onlyNew ? `-add-${nlWith.map(r => r.user_id).join('.').slice(0, 100)}` : ''}` }))
  }
  return { mode: mailMode(env), targets: app.rows.length, with_email: withEmail.length, no_email: app.rows.length - withEmail.length, nologin_with_email: nlWith.length }
}
// お知らせの配信対象のうち、ログインのない人（role = roster_only・在籍中・統合されていない）。宛先は本人のアドレス
// （ログイン用・従業員管理の個人のメール・応募や仮登録で受け取ったメールの順）。アドレスのない人は返さない（#281）
async function resolveNoticeNologinTargets(db: D1Database, companyId: number, noticeId: number) {
  return (await db.prepare(`SELECT sp.staff_id, us.user_id, us.name,
      COALESCE(NULLIF(TRIM(us.email), ''), NULLIF(TRIM(er.personal_email), ''), NULLIF(TRIM(sp.unverified_email), '')) AS email
    FROM notices n JOIN users us ON us.company_id = n.company_id JOIN staff_profiles sp ON sp.user_id = us.user_id
    LEFT JOIN employee_records er ON er.staff_id = sp.staff_id AND er.company_id = sp.company_id
    WHERE n.notice_id = ? AND n.company_id = ? AND us.company_id = n.company_id AND us.role = 'roster_only' AND us.status = 'active' AND sp.merged_into_staff_id IS NULL
      AND COALESCE(sp.employment_status, 'working') != 'retired' AND ${NOTICE_TARGET_SQL}
      AND COALESCE(NULLIF(TRIM(us.email), ''), NULLIF(TRIM(er.personal_email), ''), NULLIF(TRIM(sp.unverified_email), '')) IS NOT NULL`)
    .bind(noticeId, companyId).all()).results as { staff_id: number; user_id: number; name: string; email: string | null }[]
}

// 今の配信対象の人へのアプリ内通知（修正・取消の知らせ #157）。送った人数を返す
async function notifyNoticeTargets(db: D1Database, companyId: number, noticeId: number, kind: string, title: string, body: string, link: string) {
  const targets = await resolveNoticeTargets(db, companyId, noticeId)
  const ids = [...new Set(targets.map(t => Number(t.user_id)))]
  if (!ids.length) return 0
  await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
    SELECT ?, value, ?, ?, ?, ?, ?, ? FROM json_each(?)`).bind(companyId, kind, title, body, link, noticeId, nowJST(), bindJsonArray(ids)).run()
  return ids.length
}

// 予約配信（#291）: 配信予定日時を過ぎた予約を published にし、メールを送る設定ならメールを送る。
// スタッフの画面に出るかは時刻で決まる（NOTICE_LIVE_SQL）ので、ここが遅れても画面には時刻どおりに出る（遅れるのはメールだけ）。
// 定期処理（index.tsx の CRON_JOBS）と、お知らせの画面を開いたとき（その会社の分だけ）に呼ぶ。
// 先に published にできた行だけを扱い、同時に動いても二重に送らない。1回の呼び出しで上限まで（続きは次回）
const NOTICE_PUBLISH_BATCH = 20
export async function publishDueNotices(env: Bindings, companyId?: number) {
  const db = env.DB
  const binds: any[] = [nowJST()]
  if (companyId != null) binds.push(companyId)
  binds.push(NOTICE_PUBLISH_BATCH)
  const rows = (await db.prepare(`SELECT notice_id, company_id FROM notices WHERE status = 'scheduled' AND published_at <= ?
    ${companyId != null ? 'AND company_id = ?' : ''} ORDER BY published_at LIMIT ?`).bind(...binds).all()).results as { notice_id: number; company_id: number }[]
  let published = 0, mailed = 0, failed = 0
  const errors: string[] = []
  for (const r of rows) {
    const claim = await db.prepare(`UPDATE notices SET status = 'published' WHERE notice_id = ? AND status = 'scheduled' RETURNING send_email`).bind(r.notice_id).first() as any
    if (!claim) continue
    published++
    if (!claim.send_email) continue
    try {
      const pending: Promise<unknown>[] = []
      await deliverNoticeEmails(env, r.company_id, r.notice_id, p => { pending.push(p) })
      await Promise.all(pending)
      mailed++
    } catch (e) {
      failed++
      if (errors.length < 3) errors.push(`notice_id=${r.notice_id}: ${String(e).slice(0, 200)}`)
      console.log(`scheduled notice mail failed: notice=${r.notice_id} error=${e}`)
    }
  }
  return { due: rows.length, published, mailed, failed, error: errors.length ? errors.join(' / ') : null }
}

// 修正・取消の前の内容を残す（同じ条件の UPDATE と同じ batch で使う。条件が合わなければ何も残らない）
function noticeRevisionStmt(db: D1Database, n: any, action: string, userId: number, now: string) {
  return db.prepare(`INSERT INTO notice_revisions (notice_id, company_id, action, title, body, target_type, target_ids, importance, read_required, expires_at, edited_by, edited_at)
    SELECT notice_id, company_id, ?, title, body, target_type, target_ids, importance, read_required, expires_at, ?, ?
    FROM notices WHERE notice_id = ? AND company_id = ? AND status = ? AND published_at = ?`)
    .bind(action, userId, now, n.notice_id, n.company_id, n.status, n.published_at)
}

// 修正（#157）。配信した後も、タイトル・本文・配信先・重要度・確認必須・掲載期限・回答の設定を直せる。
// 配信済みのものは修正の前の内容を notice_revisions に残し、タイトル・本文を変えたらスタッフの画面に「更新」の印を出す（updated_at）。
// notify: 今の配信対象の人に、修正したことをアプリ内通知で知らせる。send_email: 足した配信先の人（まだメールを送っていない人）にメールを送る。
// 下書き・予約は、mode（draft / schedule）と scheduled_at・send_email も変えられる
api.put('/admin/notices/:id{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.status === 'withdrawn') return c.json({ error: '取り消したお知らせは修正できません' }, 400)
  if (n.reads_purged_at) return c.json({ error: '公開から2年たったお知らせは修正できません' }, 400)
  const live = noticeIsLive(n)
  const p = await parseNoticeInput(db, u.company_id, b, n)
  if ('error' in p) return c.json({ error: p.error }, 400)
  // 回答が届いた選択肢は消せない（集計がずれないように。足すことはできる）
  if (p.v.response_options !== (n.response_options ?? null)) {
    const used = ((await db.prepare('SELECT DISTINCT choice FROM notice_responses WHERE notice_id = ? AND choice IS NOT NULL').bind(n.notice_id).all()).results as any[]).map(r => String(r.choice))
    const next = parseResponseOptions(p.v.response_options)
    const lost = used.filter(x => !next.includes(x))
    if (lost.length) return c.json({ error: `回答が届いている選択肢（${lost.join('、')}）は消せません` }, 400)
  }
  let status = n.status as string, publishedAt = n.published_at as string, sendEmail = n.send_email ? 1 : 0
  if (!live) {
    if (b.mode != null) {
      if (b.mode === 'draft') status = 'draft'
      else if (b.mode === 'schedule') {
        const at = parseNoticeScheduleAt(b.scheduled_at)
        if ('error' in at) return c.json({ error: at.error }, 400)
        status = 'scheduled'; publishedAt = at.at
      } else return c.json({ error: '配信のしかたの指定が正しくありません' }, 400)
    }
    if (b.send_email !== undefined) sendEmail = b.send_email ? 1 : 0
  }
  const expErr = noticeExpiryError(p.v.expires_at, live || status === 'scheduled' ? publishedAt : nowJST())
  if (expErr) return c.json({ error: expErr }, 400)
  const now = nowJST()
  const contentChanged = live && (p.v.title !== n.title || p.v.body !== String(n.body ?? ''))
  const stmts: D1PreparedStatement[] = []
  if (live) stmts.push(noticeRevisionStmt(db, n, 'edit', u.user_id, now))
  stmts.push(db.prepare(`UPDATE notices SET title = ?, body = ?, target_type = ?, target_ids = ?, importance = ?, read_required = ?, expires_at = ?,
      response_options = ?, response_comment = ?, status = ?, published_at = ?, send_email = ?, email_nologin = COALESCE(?, email_nologin),
      updated_at = CASE WHEN ? THEN ? ELSE updated_at END, updated_by = CASE WHEN ? THEN ? ELSE updated_by END
    WHERE notice_id = ? AND company_id = ? AND status = ? AND published_at = ?`)
    .bind(p.v.title, p.v.body, p.v.target_type, p.v.target_ids, p.v.importance, p.v.read_required, p.v.expires_at,
      p.v.response_options, p.v.response_comment, status, publishedAt, sendEmail, b.email_nologin === undefined ? null : (b.email_nologin === true ? 1 : 0),
      contentChanged ? 1 : 0, now, contentChanged ? 1 : 0, u.user_id, n.notice_id, u.company_id, n.status, n.published_at))
  const res = await db.batch(stmts)
  if (!res[res.length - 1].meta.changes) return c.json({ error: 'ほかの操作で状態が変わりました。画面を読み直してください' }, 409)
  let notified = 0
  let email: Awaited<ReturnType<typeof deliverNoticeEmails>> | null = null
  if (live) {
    if (b.notify) notified = await notifyNoticeTargets(db, u.company_id, n.notice_id, 'notice_updated', 'お知らせが修正されました',
      `「${p.v.title}」の内容が修正されました。開いて確認してください。`, `#notices/${n.notice_id}`)
    if (b.send_email) email = await deliverNoticeEmails(c.env, u.company_id, n.notice_id, q => c.executionCtx.waitUntil(q), { onlyNew: true })
  }
  return c.json({ ok: true, state: noticeState({ status, published_at: publishedAt }), notified, email })
})

// 下書き・予約を配信する（#291）。scheduled_at があれば予約にし、無ければすぐに配信する
api.post('/admin/notices/:id{[0-9]+}/publish', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.status === 'withdrawn') return c.json({ error: '取り消したお知らせは配信できません' }, 400)
  if (noticeIsLive(n)) return c.json({ error: 'このお知らせは配信済みです' }, 400)
  let status = 'published', publishedAt = nowJST()
  if (b.scheduled_at) {
    const at = parseNoticeScheduleAt(b.scheduled_at)
    if ('error' in at) return c.json({ error: at.error }, 400)
    status = 'scheduled'; publishedAt = at.at
  }
  const sendEmail = b.send_email !== undefined ? (b.send_email ? 1 : 0) : (n.send_email ? 1 : 0)
  const expErr = noticeExpiryError(n.expires_at, publishedAt)
  if (expErr) return c.json({ error: expErr }, 400)
  const r = await db.prepare(`UPDATE notices SET status = ?, published_at = ?, send_email = ?, email_nologin = COALESCE(?, email_nologin)
    WHERE notice_id = ? AND company_id = ? AND status = ? AND published_at = ? RETURNING notice_id`)
    .bind(status, publishedAt, sendEmail, b.email_nologin === undefined ? null : (b.email_nologin === true ? 1 : 0), n.notice_id, u.company_id, n.status, n.published_at).first()
  if (!r) return c.json({ error: 'ほかの操作で状態が変わりました。画面を読み直してください' }, 409)
  const email = status === 'published' && sendEmail ? await deliverNoticeEmails(c.env, u.company_id, n.notice_id, q => c.executionCtx.waitUntil(q)) : null
  return c.json({ ok: true, state: status, published_at: publishedAt, email })
})

// 取消（#157。論理削除）。スタッフの一覧・ホーム・未読の数から外し、個別画面には「取り消されました」と出す。
// 内容・既読・回答の記録は残す（管理画面では「取消」として見える）。notify なら、今の配信対象の人にアプリ内通知で知らせる
api.post('/admin/notices/:id{[0-9]+}/withdraw', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.status === 'withdrawn') return c.json({ error: 'すでに取り消しています' }, 400)
  if (!noticeIsLive(n)) return c.json({ error: '配信前のお知らせは、取り消しではなく削除してください' }, 400)
  const reason = String(b.reason ?? '').trim()
  if (reason.length > NOTICE_WITHDRAW_REASON_MAX) return c.json({ error: `取消の理由は${NOTICE_WITHDRAW_REASON_MAX}文字以内にしてください` }, 400)
  const now = nowJST()
  const res = await db.batch([
    noticeRevisionStmt(db, n, 'withdraw', u.user_id, now),
    db.prepare(`UPDATE notices SET status = 'withdrawn', withdrawn_at = ?, withdrawn_by = ?, withdraw_reason = ?
      WHERE notice_id = ? AND company_id = ? AND status = ? AND published_at = ?`).bind(now, u.user_id, reason || null, n.notice_id, u.company_id, n.status, n.published_at),
    // メールの「確認しました」のリンクは使えなくする
    db.prepare('DELETE FROM notice_ack_tokens WHERE notice_id = ? AND used_at IS NULL').bind(n.notice_id),
  ])
  if (!res[1].meta.changes) return c.json({ error: 'ほかの操作で状態が変わりました。画面を読み直してください' }, 409)
  const notified = b.notify ? await notifyNoticeTargets(db, u.company_id, n.notice_id, 'notice_withdrawn', 'お知らせが取り消されました',
    `「${n.title}」は取り消されました。${reason ? `（理由: ${reason}）` : ''}`, '#notices') : 0
  return c.json({ ok: true, notified })
})

// 下書き・予約（配信前）の削除。配信したものは取り消す（記録を残すため削除しない）
api.delete('/admin/notices/:id{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.status === 'withdrawn' || noticeIsLive(n)) return c.json({ error: '配信したお知らせは削除できません。取り消してください' }, 400)
  const files = ((await db.prepare('SELECT storage_key FROM notice_attachments WHERE notice_id = ?').bind(n.notice_id).all()).results as any[]).map(r => String(r.storage_key))
  // 削除の直前に配信の時刻を過ぎた予約は消さない（条件を UPDATE と同じにする）。子の行はお知らせを消せたときだけ消す
  const res = await db.batch([
    db.prepare(`DELETE FROM notices WHERE notice_id = ? AND company_id = ? AND status = ? AND published_at = ?
      AND (status = 'draft' OR published_at > ?)`).bind(n.notice_id, u.company_id, n.status, n.published_at, nowJST()),
    ...['notice_attachments', 'notice_revisions', 'notice_email_deliveries', 'notice_responses', 'notice_reads'].map(t =>
      db.prepare(`DELETE FROM ${t} WHERE notice_id = ? AND NOT EXISTS (SELECT 1 FROM notices WHERE notice_id = ?)`).bind(n.notice_id, n.notice_id)),
  ])
  if (!res[0].meta.changes) return c.json({ error: 'ほかの操作で状態が変わりました。画面を読み直してください' }, 409)
  // R2 は D1 の後で消す（失敗しても D1 から参照されないので実害はない）
  for (const k of files) await c.env.DOCUMENTS.delete(k).catch(() => {})
  return c.json({ ok: true })
})

// 修正・取消の履歴（#157）
api.get('/admin/notices/:id{[0-9]+}/revisions', async (c) => {
  const u = c.get('user')
  const n = await ownNotice(c.env.DB, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  const rows = (await c.env.DB.prepare(`SELECT r.revision_id, r.action, r.title, r.body, r.target_type, r.importance, r.read_required, r.expires_at, r.edited_at, us.name AS edited_by_name
    FROM notice_revisions r LEFT JOIN users us ON us.user_id = r.edited_by AND us.company_id = r.company_id
    WHERE r.notice_id = ? AND r.company_id = ? ORDER BY r.revision_id DESC LIMIT 50`).bind(n.notice_id, u.company_id).all()).results
  return c.json({ notice: { notice_id: n.notice_id, title: n.title, body: n.body, updated_at: n.updated_at, withdrawn_at: n.withdrawn_at, withdraw_reason: n.withdraw_reason }, revisions: rows })
})

// ---- 添付（#555）: 画像・PDF を R2（DOCUMENTS）に置き、配信先の本人と自社の管理者だけが取得できる ----
const NOTICE_ATTACH_MAX_FILES = 5
const NOTICE_ATTACH_MAX_BYTES = 10 * 1024 * 1024
// 拡張子で種類を決め、保存・返すときの Content-Type はここから取る（送られた type は使わない）
const NOTICE_ATTACH_TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
// 先頭のバイトが拡張子の形式と合うか（画像・PDF に見せかけた HTML などを、そのまま表示する形で返さないように）
function noticeAttachmentMagicOk(ext: string, b: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)
  switch (ext) {
    case 'pdf': return starts([0x25, 0x50, 0x44, 0x46]) // %PDF
    case 'jpg': case 'jpeg': return starts([0xff, 0xd8, 0xff])
    case 'png': return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'gif': return starts([0x47, 0x49, 0x46, 0x38]) // GIF8
    case 'webp': return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8) // RIFF....WEBP
  }
  return false
}

// お知らせごとの添付の一覧（保存場所のキーは返さない）
async function loadNoticeAttachments(db: D1Database, ids: number[]): Promise<Map<number, any[]>> {
  const out = new Map<number, any[]>()
  if (!ids.length) return out
  const rows = (await db.prepare(`SELECT attachment_id, notice_id, file_name, content_type, file_size FROM notice_attachments
    WHERE notice_id IN ${JSON_IN} ORDER BY attachment_id`).bind(bindJsonArray(ids)).all()).results as any[]
  for (const r of rows) {
    const list = out.get(r.notice_id) || []
    list.push({ attachment_id: r.attachment_id, file_name: r.file_name, content_type: r.content_type, file_size: r.file_size })
    out.set(r.notice_id, list)
  }
  return out
}

// 添付を返す。画像・PDF はその場で表示し（inline）、download=1 なら保存する形にする
async function noticeAttachmentResponse(c: any, noticeId: number, companyId: number, attachmentId: string) {
  const a = await c.env.DB.prepare('SELECT * FROM notice_attachments WHERE attachment_id = ? AND notice_id = ? AND company_id = ?')
    .bind(attachmentId, noticeId, companyId).first() as any
  if (!a) return c.json({ error: '添付ファイルが見つかりません' }, 404)
  const obj = await c.env.DOCUMENTS.get(String(a.storage_key))
  if (!obj) return c.json({ error: '添付ファイルが見つかりません' }, 404)
  // filename= には ASCII だけを入れる（日本語は filename* で渡す）
  const ascii = String(a.file_name).replace(/[^\x20-\x7e]|["\\]/g, '_')
  const disp = c.req.query('download') === '1' ? 'attachment' : 'inline'
  return c.body(obj.body, 200, {
    'Content-Type': String(a.content_type),
    'Content-Disposition': `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(a.file_name))}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  })
}

// 添付の追加（複数可。1ファイルずつ検証し、成功した分だけ保存する）。配信済みのものに足したら「更新」の印を付ける
api.post('/admin/notices/:id{[0-9]+}/attachments', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.status === 'withdrawn') return c.json({ error: '取り消したお知らせには添付できません' }, 400)
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: '送信データの形式が不正です' }, 400) }
  const files = form.getAll('files').filter(f => f instanceof File) as File[]
  if (!files.length) return c.json({ error: 'ファイルが選択されていません' }, 400)
  const results: { filename: string; ok: boolean; attachment_id?: number; error?: string }[] = []
  for (const file of files) {
    const ext = docExt(file.name)
    const type = NOTICE_ATTACH_TYPES[ext]
    if (!type) { results.push({ filename: file.name, ok: false, error: 'PDF か画像（JPEG・PNG・GIF・WebP）を選んでください' }); continue }
    if (!file.size) { results.push({ filename: file.name, ok: false, error: '空のファイルです' }); continue }
    if (file.size > NOTICE_ATTACH_MAX_BYTES) { results.push({ filename: file.name, ok: false, error: '1つ10MB以下にしてください' }); continue }
    const buf = await file.arrayBuffer()
    if (!noticeAttachmentMagicOk(ext, new Uint8Array(buf, 0, Math.min(16, buf.byteLength)))) {
      results.push({ filename: file.name, ok: false, error: 'ファイルの中身が拡張子の形式と合いません' }); continue
    }
    const key = `notice-attachments/${u.company_id}/${n.notice_id}/${crypto.randomUUID()}/${sanitizeForKey(file.name)}`
    try {
      await c.env.DOCUMENTS.put(key, buf, { httpMetadata: { contentType: type } })
    } catch {
      results.push({ filename: file.name, ok: false, error: 'ファイルのアップロードに失敗しました' }); continue
    }
    try {
      // 件数の上限は INSERT の条件で確かめる（同時に追加されても上限を超えないように）
      const r = await db.prepare(`INSERT INTO notice_attachments (notice_id, company_id, storage_key, file_name, content_type, file_size, uploaded_by, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM notice_attachments WHERE notice_id = ?) < ?`)
        .bind(n.notice_id, u.company_id, key, cleanFileName(file.name), type, file.size, u.user_id, nowJST(), n.notice_id, NOTICE_ATTACH_MAX_FILES).run()
      if (!r.meta.changes) {
        await c.env.DOCUMENTS.delete(key).catch(() => {})
        results.push({ filename: file.name, ok: false, error: `添付は1つのお知らせに${NOTICE_ATTACH_MAX_FILES}件までです` }); continue
      }
      results.push({ filename: file.name, ok: true, attachment_id: Number(r.meta.last_row_id) })
    } catch {
      await c.env.DOCUMENTS.delete(key).catch(() => {})
      results.push({ filename: file.name, ok: false, error: 'ファイルの登録に失敗しました' })
    }
  }
  if (results.some(r => r.ok) && noticeIsLive(n)) {
    await db.prepare('UPDATE notices SET updated_at = ?, updated_by = ? WHERE notice_id = ?').bind(nowJST(), u.user_id, n.notice_id).run()
  }
  return c.json({ results })
})

api.get('/admin/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}', async (c) => {
  const u = c.get('user')
  const n = await ownNotice(c.env.DB, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  return noticeAttachmentResponse(c, n.notice_id, u.company_id, c.req.param('aid'))
})

// 添付の削除（D1 を先に消し、R2 は後で消す）
api.delete('/admin/notices/:id{[0-9]+}/attachments/:aid{[0-9]+}', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const n = await ownNotice(db, u.company_id, c.req.param('id')) as any
  if (!n) return c.json({ error: 'お知らせが見つかりません' }, 404)
  if (n.status === 'withdrawn') return c.json({ error: '取り消したお知らせの添付は変えられません' }, 400)
  const a = await db.prepare('DELETE FROM notice_attachments WHERE attachment_id = ? AND notice_id = ? AND company_id = ? RETURNING storage_key')
    .bind(c.req.param('aid'), n.notice_id, u.company_id).first() as any
  if (!a) return c.json({ error: '添付ファイルが見つかりません' }, 404)
  await c.env.DOCUMENTS.delete(String(a.storage_key)).catch(() => {})
  if (noticeIsLive(n)) await db.prepare('UPDATE notices SET updated_at = ?, updated_by = ? WHERE notice_id = ?').bind(nowJST(), u.user_id, n.notice_id).run()
  return c.json({ ok: true })
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
    WHERE n.company_id = ? AND n.published_at >= ? AND n.published_at < ? AND ${NOTICE_LIVE_SQL}
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
  // ?id= で1件だけ返す（ダッシュボードの ToDo から、その相談を開く。#402）
  const focusId = c.req.query('id') != null ? toInt(c.req.query('id'), 1) : null
  if (c.req.query('id') != null && focusId == null) return c.json({ error: '相談が見つかりません' }, 404)
  const cond = focusId != null ? ' AND co.consultation_id = ?' : status === 'active' ? ` AND co.status != 'done'` : status === 'all' ? '' : ' AND co.status = ?'
  const binds: any[] = focusId != null ? [focusId] : status === 'active' || status === 'all' ? [] : [status]
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
  // やり取り（#154）と写真（#429）。1件を開いたときは、その相談の自分あての通知を既読にする
  await withConsultThreads(db, rows.results as any[], 'admin')
  if (focusId != null && rows.results.length) await markAdminNotificationsRead(db, u.company_id, ['consult_received', 'consult_message'], focusId, u.user_id)
  return c.json({ consultations: rows.results, status, page, per_page: CONSULT_PAGE_SIZE, total, focus_id: focusId,
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
  // 返信は上書きせず、やり取り（consultation_messages）に足す。manager_reply は最新の返信として残す（#154）。
  // やり取りの最後が、少し前に送った同じ内容の管理者の返信なら（二度押し・状態だけの変更で同じ返信を送った）足さない
  const now = nowJST()
  let newReply = reply != null
  if (newReply) {
    const last = await db.prepare(`SELECT author_side, body, created_at FROM consultation_messages WHERE consultation_id = ? ORDER BY message_id DESC LIMIT 1`).bind(co.consultation_id).first() as any
    const since = new Date(Date.now() + 9 * 3600 * 1000 - CONSULT_DUP_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')
    if (last && last.author_side === 'admin' && last.body === reply && String(last.created_at) >= since) newReply = false
  }
  const stmts = [db.prepare('UPDATE consultations SET manager_reply = COALESCE(?, manager_reply), status = COALESCE(?, status) WHERE consultation_id = ? AND company_id = ?')
    .bind(reply, b.status ?? null, co.consultation_id, u.company_id)]
  if (newReply) stmts.push(db.prepare(`INSERT INTO consultation_messages (consultation_id, company_id, author_side, author_user_id, body, created_at) VALUES (?, ?, 'admin', ?, ?, ?)`)
    .bind(co.consultation_id, co.company_id, u.user_id, reply, now))
  // 返信した・対応済みにした相談の、管理者全員あての通知を既読にする（ほかの管理者が対応したことが分かるように）
  if (newReply || b.status === 'done') stmts.push(db.prepare(`UPDATE user_notifications SET read_at = ? WHERE company_id = ? AND kind IN ('consult_received', 'consult_message') AND related_id = ? AND read_at IS NULL`)
    .bind(now, co.company_id, co.consultation_id))
  if (newReply && co.user_id) {
    // 同じ相談の前の返信の通知は既読にして、未読は最新の1件だけにする
    stmts.push(db.prepare(`UPDATE user_notifications SET read_at = ? WHERE kind = '${CONSULT_REPLY_KIND}' AND related_id = ? AND read_at IS NULL`).bind(now, co.consultation_id))
    stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(co.company_id, co.user_id, CONSULT_REPLY_KIND, '相談・連絡に管理者から返信があります', reply!.length > 100 ? reply!.slice(0, 100) + '…' : reply, '#consult', co.consultation_id, now))
  }
  await db.batch(stmts)
  return c.json({ ok: true })
})

// フォロー履歴（#385）
// ?status= open（対応中）/ done（完了）/ all（既定）、?q= スタッフ名、?due=1 次回対応日が今日までの対応中、?staff_id=、?page= でページ送り。
// 対応中は次回対応日の早い順（日付のないものは後ろ）、それ以外は新しい順
const FOLLOW_PAGE_SIZE = 50
const FOLLOW_CONTENT_MAX = 2000
const FOLLOW_NEXT_MAX = 200
api.get('/admin/follow-logs', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const today = todayJST()
  const qs = c.req.query('status') || 'all'
  const status = qs === 'all' || FOLLOW_STATUSES.includes(qs) ? qs : 'all'
  const page = toInt(c.req.query('page'), 1, 100000) ?? 1
  let where = ' WHERE f.company_id = ?'
  const binds: any[] = [u.company_id]
  const staffId = c.req.query('staff_id')
  if (staffId) { const sid = toInt(staffId, 1); if (sid == null) return c.json({ error: 'スタッフが見つかりません' }, 404); where += ' AND f.staff_id = ?'; binds.push(sid) }
  if (status !== 'all') { where += ' AND f.status = ?'; binds.push(status) }
  if (c.req.query('due') === '1') { where += ` AND f.status = 'open' AND f.next_action_date IS NOT NULL AND f.next_action_date <= ?`; binds.push(today) }
  const q = (c.req.query('q') || '').trim().slice(0, 50)
  if (q) { where += ` AND us.name LIKE ? ESCAPE '\\'`; binds.push('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%') }
  const from = ` FROM follow_logs f JOIN staff_profiles sp ON f.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN users um ON f.manager_id = um.user_id`
  const order = status === 'open' || c.req.query('due') === '1'
    ? ' ORDER BY f.next_action_date IS NULL, f.next_action_date, f.created_at DESC, f.follow_id DESC'
    : ' ORDER BY f.created_at DESC, f.follow_id DESC'
  const [rows, total, counts] = await db.batch([
    db.prepare(`SELECT f.*, us.name AS staff_name, um.name AS manager_name${from}${where}${order} LIMIT ? OFFSET ?`).bind(...binds, FOLLOW_PAGE_SIZE, (page - 1) * FOLLOW_PAGE_SIZE),
    db.prepare(`SELECT COUNT(*) AS n${from}${where}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS all_n, SUM(f.status = 'open') AS open_n, SUM(f.status = 'done') AS done_n,
      SUM(f.status = 'open' AND f.next_action_date IS NOT NULL AND f.next_action_date <= ?) AS due_n FROM follow_logs f WHERE f.company_id = ?`).bind(today, u.company_id),
  ])
  const cn = (counts.results?.[0] || {}) as any
  return c.json({ logs: rows.results, status, page, per_page: FOLLOW_PAGE_SIZE, total: Number((total.results?.[0] as any)?.n) || 0, today,
    counts: { all: Number(cn.all_n) || 0, open: Number(cn.open_n) || 0, done: Number(cn.done_n) || 0, due: Number(cn.due_n) || 0 } })
})

// 次回対応（内容か日付）がなければ、状態の既定は完了。あれば対応中（#385）
function followFields(b: any): { error?: string; next_action?: string | null; next_action_date?: string | null } {
  const out: { next_action?: string | null; next_action_date?: string | null } = {}
  if (b.next_action !== undefined) {
    if (b.next_action !== null && typeof b.next_action !== 'string') return { error: '次回対応予定が正しくありません' }
    const v = (b.next_action || '').trim()
    if (v.length > FOLLOW_NEXT_MAX) return { error: `次回対応予定は${FOLLOW_NEXT_MAX}文字以内で入力してください` }
    out.next_action = v || null
  }
  if (b.next_action_date !== undefined) {
    if (b.next_action_date !== null && b.next_action_date !== '' && !isISODate(b.next_action_date)) return { error: '次回対応日が正しくありません' }
    out.next_action_date = b.next_action_date || null
  }
  return out
}
api.post('/admin/follow-logs', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  if (!b.staff_id || !b.follow_type) return c.json({ error: 'スタッフと種別は必須です' }, 400)
  if (!FOLLOW_TYPES.includes(b.follow_type)) return c.json({ error: '対応種別が正しくありません' }, 400)
  if (b.status && !FOLLOW_STATUSES.includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
  if (b.content != null && (typeof b.content !== 'string' || b.content.length > FOLLOW_CONTENT_MAX)) return c.json({ error: `内容は${FOLLOW_CONTENT_MAX}文字以内で入力してください` }, 400)
  const ff = followFields(b)
  if (ff.error) return c.json({ error: ff.error }, 400)
  if (!(await assertStaffInCompany(c, String(b.staff_id)))) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (b.related_project_id != null && b.related_project_id !== '' && !(await ownProject(c.env.DB, u.company_id, b.related_project_id))) return c.json({ error: '案件が見つかりません' }, 404)
  const status = b.status || (ff.next_action || ff.next_action_date ? 'open' : 'done')
  const now = nowJST()
  const r = await c.env.DB.prepare(`INSERT INTO follow_logs (company_id, staff_id, manager_id, follow_type, content, next_action, next_action_date, status, done_at, related_project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, u.user_id, b.follow_type, b.content ?? '', ff.next_action ?? null, ff.next_action_date ?? null, status, status === 'done' ? now : null,
      b.related_project_id ?? null, now).run()
  return c.json({ ok: true, follow_id: r.meta.last_row_id, status })
})

api.put('/admin/follow-logs/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  if (b.status != null && !FOLLOW_STATUSES.includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
  const ff = followFields(b)
  if (ff.error) return c.json({ error: ff.error }, 400)
  const id = toInt(c.req.param('id'), 1)
  // 次回対応・次回対応日は送られたものだけを変える（空欄で送れば消す）
  const sets: string[] = ['status = COALESCE(?, status)', `done_at = CASE WHEN ? = 'done' AND status != 'done' THEN ? WHEN ? = 'open' THEN NULL ELSE done_at END`]
  const binds: any[] = [b.status ?? null, b.status ?? null, nowJST(), b.status ?? null]
  if (ff.next_action !== undefined) { sets.push('next_action = ?'); binds.push(ff.next_action) }
  if (ff.next_action_date !== undefined) { sets.push('next_action_date = ?'); binds.push(ff.next_action_date) }
  const r = id == null ? null : await c.env.DB.prepare(`UPDATE follow_logs SET ${sets.join(', ')} WHERE follow_id = ? AND company_id = ?`)
    .bind(...binds, id, u.company_id).run()
  if (!r || !r.meta.changes) return c.json({ error: 'フォロー記録が見つかりません' }, 404)
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
// project_count: そのテンプレートを使う自社の案件の数。has_reports: 自社のテンプレートで日報が出ているか（項目の削除・タイプの変更を止める）
api.get('/admin/templates', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`SELECT t.*, COALESCE(t.status, 'active') AS status,
      (SELECT COUNT(*) FROM projects p WHERE p.report_template_id = t.template_id AND p.company_id = ?1) AS project_count,
      CASE WHEN t.company_id = ?1 THEN EXISTS (SELECT 1 FROM projects p JOIN daily_reports dr ON dr.project_id = p.project_id WHERE p.report_template_id = t.template_id) ELSE 0 END AS has_reports
    FROM report_templates t WHERE t.company_id IS NULL OR t.company_id = ?1 ORDER BY t.template_id`).bind(u.company_id).all()
  return c.json({ templates: (rows.results as any[]).map(t => ({ ...t, fields: safeJsonArray(t.fields_json), editable: t.company_id === u.company_id })) })
})

// ---------- 日報テンプレートの作成・編集（#165） ----------
// 企業は自社のテンプレート（template_type='custom'）を作成・編集・配信停止できる。本部のテンプレートは複製して使う（画面で項目を写して作成する）。
// 本部は PUT /hq/templates/:id で、どのテンプレートも直せる。
// 日報の値（report_values のキー）と食い違わないよう、値が入った日報がある項目は、削除・キーの変更・
// 数値とテキストの切り替えができない（表示名・順序・必須・入力例の変更と、項目の追加はできる。値の入っていない項目は消せる）
const TEMPLATE_STATUSES = ['active', 'stopped']
const COMPANY_TEMPLATES_MAX = 100
async function templateEditError(db: D1Database, templateId: number, oldFields: any[], newFields: { key: string; type: string }[]): Promise<string | null> {
  const next = new Map(newFields.map(f => [f.key, f]))
  const changed = oldFields.filter(o => o && typeof o.key === 'string' && o.key && (!next.has(o.key) || (o.type === 'number') !== (next.get(o.key)!.type === 'number')))
  if (!changed.length) return null
  // 消す・切り替える項目ごとに、このテンプレートを使う案件の日報に値があるかを確かめる
  const rs = await db.batch(changed.map(o => db.prepare(`SELECT 1 AS hit FROM projects p JOIN daily_reports dr ON dr.project_id = p.project_id
    WHERE p.report_template_id = ? AND json_valid(dr.report_values) AND json_extract(dr.report_values, ?) IS NOT NULL LIMIT 1`)
    .bind(templateId, '$."' + String(o.key).replace(/"/g, '') + '"')))
  for (let i = 0; i < changed.length; i++) {
    if (!(rs[i].results || []).length) continue
    const o = changed[i]; const label = String(o.label || o.key)
    return next.has(o.key)
      ? `「${label}」（キー: ${o.key}）は日報に値が入っているため、数値とテキストを切り替えられません`
      : `「${label}」（キー: ${o.key}）は日報に値が入っているため、削除・キーの変更はできません`
  }
  return null
}
// テンプレートの更新（企業・本部で共通）。cur は更新前の行。送られた項目（名前・項目・状態）だけを変える
async function updateTemplate(db: D1Database, cur: any, b: any, userId: number): Promise<{ error: string; status: 400 | 409 } | { ok: true }> {
  const set: Record<string, any> = {}
  if (b.template_name !== undefined) {
    const name = String(b.template_name ?? '').trim()
    if (!name) return { error: 'テンプレート名を入力してください', status: 400 }
    if (name.length > TEMPLATE_NAME_MAX) return { error: `テンプレート名は${TEMPLATE_NAME_MAX}文字以内にしてください`, status: 400 }
    const dup = cur.company_id == null
      ? await db.prepare('SELECT 1 FROM report_templates WHERE company_id IS NULL AND template_name = ? AND template_id != ?').bind(name, cur.template_id).first()
      : await db.prepare('SELECT 1 FROM report_templates WHERE company_id = ? AND template_name = ? AND template_id != ?').bind(cur.company_id, name, cur.template_id).first()
    if (dup) return { error: '同じ名前のテンプレートがあります', status: 409 }
    set.template_name = name
  }
  if (b.fields !== undefined) {
    // 規則より前に作ったテンプレートの、規則に合わない既存のキーは認める（#165。新しいキーには規則を当てる）
    const v = validateTemplateFields(b.fields, { legacyKeys: safeJsonArray(cur.fields_json).map((f: any) => f?.key) })
    if ('error' in v) return { error: v.error, status: 400 }
    const err = await templateEditError(db, cur.template_id, safeJsonArray(cur.fields_json), v.fields)
    if (err) return { error: err, status: 400 }
    set.fields_json = JSON.stringify(v.fields)
  }
  if (b.status !== undefined) {
    if (!TEMPLATE_STATUSES.includes(b.status)) return { error: '状態が正しくありません', status: 400 }
    set.status = b.status
  }
  const cols = Object.keys(set)
  if (!cols.length) return { ok: true }
  await db.prepare(`UPDATE report_templates SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE template_id = ?`)
    .bind(...cols.map(k => set[k]), nowJST(), userId, cur.template_id).run()
  return { ok: true }
}

api.post('/admin/templates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => null) as any
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const name = String(b.template_name ?? '').trim()
  if (!name) return c.json({ error: 'テンプレート名を入力してください' }, 400)
  if (name.length > TEMPLATE_NAME_MAX) return c.json({ error: `テンプレート名は${TEMPLATE_NAME_MAX}文字以内にしてください` }, 400)
  const v = validateTemplateFields(b.fields)
  if ('error' in v) return c.json({ error: v.error }, 400)
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM report_templates WHERE company_id = ?').bind(u.company_id).first() as any
  if (Number(cnt?.n || 0) >= COMPANY_TEMPLATES_MAX) return c.json({ error: `自社のテンプレートは${COMPANY_TEMPLATES_MAX}件までです。使わないものを配信停止にして、編集して使ってください` }, 400)
  if (await db.prepare('SELECT 1 FROM report_templates WHERE company_id = ? AND template_name = ?').bind(u.company_id, name).first())
    return c.json({ error: '同じ名前のテンプレートがあります' }, 409)
  const r = await db.prepare(`INSERT INTO report_templates (company_id, template_name, template_type, fields_json, status, updated_at, updated_by) VALUES (?, ?, 'custom', ?, 'active', ?, ?)`)
    .bind(u.company_id, name, JSON.stringify(v.fields), nowJST(), u.user_id).run()
  return c.json({ ok: true, template_id: r.meta.last_row_id })
})

api.put('/admin/templates/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => null) as any
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const cur = await db.prepare('SELECT * FROM report_templates WHERE template_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first()
  if (!cur) return c.json({ error: 'テンプレートが見つかりません（本部のテンプレートは複製して編集してください）' }, 404)
  const r = await updateTemplate(db, cur, b, u.user_id)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ ok: true })
})

// =========================================================
// SaaS本部 API
// =========================================================
const HQ_PLANS = ['basic', 'standard', 'premium'] as const
const HQ_ACTIVE_STATUSES = ['active', 'trial', 'inactive'] as const
const HQ_BILLING_STATUSES = ['active', 'overdue', 'suspended'] as const
const HQ_USER_LIMIT_MAX = 100000
// 会社コード: ログインの照合（normalizeLoginCode と大文字・小文字を区別しない照合）に合わせ、半角の英小文字・数字・ハイフンにそろえる（#398）
const COMPANY_CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
// 課金対象の利用者（企業一覧の利用数・月額と、企業詳細の見出しで同じ条件を使う。#366）
const HQ_BILLABLE_SQL = "u.status = 'active' AND u.role NOT IN ('roster_only', 'system_admin')"
// 利用が減ったとみなす割合と、比べる前の期間の最低件数（件数が少ない企業で、数件の増減で印が付かないように）
const HQ_DROP_RATE = 0.3
const HQ_DROP_MIN_BASE = 10
const HQ_NO_SHIFT_DAYS = 14

// ユーザー上限: 空欄・null は「上限なし」（NULL）。それ以外は1以上の整数（#254）
function parseUserLimit(v: unknown): { value: number | null } | { error: string } {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return { value: null }
  const n = toInt(v, 1, HQ_USER_LIMIT_MAX)
  return n === null ? { error: `ユーザー上限は1〜${HQ_USER_LIMIT_MAX}の整数で入力してください（空欄にすると上限なし）` } : { value: n }
}
// 前の期間と比べた増減率（前の期間が0なら null）
function changeRate(cur: number, prev: number): number | null {
  return prev > 0 ? Math.round(((cur - prev) / prev) * 100) / 100 : null
}

// ---------- プランの料金（#295） ----------
// 料金 = 基本料金（included_users 人まで）+ 超えた1人ごとの料金。プランごとの値は hq_plan_prices（本部の画面で変更する）
type PlanPrice = { plan: string; base_fee: number; included_users: number; per_user_fee: number; updated_at?: string | null }
const DEFAULT_PLAN_PRICE = { base_fee: 990, included_users: 3, per_user_fee: 300 }
const PLAN_FEE_MAX = 10_000_000
async function loadPlanPrices(db: D1Database): Promise<Map<string, PlanPrice>> {
  const rows = (await db.prepare('SELECT plan, base_fee, included_users, per_user_fee, updated_at FROM hq_plan_prices').all()).results as any[]
  const m = new Map<string, PlanPrice>(rows.map(r => [r.plan, r]))
  for (const p of HQ_PLANS) if (!m.has(p)) m.set(p, { plan: p, ...DEFAULT_PLAN_PRICE })
  return m
}
function planFee(prices: Map<string, PlanPrice>, plan: unknown, users: number): number {
  const p = prices.get(String(plan || 'basic')) || prices.get('basic') || { plan: 'basic', ...DEFAULT_PLAN_PRICE }
  return p.base_fee + Math.max(0, (users || 0) - p.included_users) * p.per_user_fee
}
// 月の請求記録の状態（#295）: 請求済み（入金待ち）・入金済み・滞納・請求しない
const BILLING_MONTH_STATUSES = ['issued', 'paid', 'overdue', 'waived'] as const
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
// 期日が近いとみなす日数（トライアルの終了日・次回レビュー日。#296）
const HQ_DUE_SOON_DAYS = 7
// 企業の連絡先・期日の項目（#296 #558）。空欄は NULL にする
const HQ_DATE_FIELDS = ['trial_ends_at', 'contract_start_at', 'next_review_at'] as const
const HQ_DATE_LABEL: Record<string, string> = { trial_ends_at: 'トライアルの終了日', contract_start_at: '契約開始日', next_review_at: '次回レビュー日' }
type Picked = { value: unknown } | { error: string; field: string }
function pickCompanyContact(b: any, key: string): Picked | null {
  if (b[key] === undefined) return null
  const raw = b[key] === null ? '' : b[key]
  if (typeof raw !== 'string') return { error: '入力の形式が正しくありません', field: key }
  const v = raw.normalize('NFKC').trim()
  if (key === 'contact_email') {
    const e = cleanEmail(v)
    return e === undefined ? { error: '連絡先のメールアドレスの形式が正しくありません', field: key } : { value: e }
  }
  if (key === 'contact_phone') {
    if (v && !/^[0-9+\-() ]{1,30}$/.test(v)) return { error: '連絡先の電話番号は数字とハイフンで30文字以内にしてください', field: key }
    return { value: v || null }
  }
  const max = key === 'billing_address' ? 200 : 60
  if (v.length > max) return { error: `${key === 'billing_address' ? '請求先の住所' : '担当者名'}は${max}文字以内にしてください`, field: key }
  return { value: v || null }
}
function pickCompanyDate(b: any, key: string): Picked | null {
  if (b[key] === undefined) return null
  if (b[key] === null || b[key] === '') return { value: null }
  return isISODate(b[key]) ? { value: b[key] } : { error: `${HQ_DATE_LABEL[key]}の日付が正しくありません`, field: key }
}
const HQ_CONTACT_FIELDS = ['contact_name', 'contact_phone', 'contact_email', 'billing_address'] as const

api.get('/hq/companies', async (c) => {
  // 本部専用の企業行（internal）は出さない。ユーザー数・週次アクティブに本部ユーザー（system_admin）は数えない（#372）
  // 直近30日と、その前の30日の日報数・シフト数を返して、利用が落ちた企業を見つけられるようにする（#517）
  const db = c.env.DB
  const today = todayJST()
  // 週次アクティブ: 今日を含む直近7日（30日も同じ）。日付は日本時間でそろえる（last_login_at・last_seen_at・reported_at は日本時間）
  const d7 = addDays(today, -6), d30 = addDays(today, -29), d60 = addDays(today, -59), d90 = addDays(today, -90)
  const [rows, act, bill] = await db.batch([
    db.prepare(`
    SELECT co.*,
      COALESCE(u.user_count, 0) AS user_count, COALESCE(u.linked_count, 0) AS linked_count, u.last_admin_login_at,
      COALESCE(dr.reports_30d, 0) AS reports_30d, COALESCE(dr.reports_prev_30d, 0) AS reports_prev_30d,
      COALESCE(sh.shifts_30d, 0) AS shifts_30d, COALESCE(sh.shifts_prev_30d, 0) AS shifts_prev_30d,
      (SELECT MAX(s.created_at) FROM shifts s WHERE s.company_id = co.company_id AND s.work_date >= ?) AS last_shift_created_at
    FROM companies co
    LEFT JOIN (SELECT u.company_id,
        SUM(CASE WHEN ${HQ_BILLABLE_SQL} THEN 1 ELSE 0 END) AS user_count,
        SUM(CASE WHEN ${HQ_BILLABLE_SQL} AND u.role = 'staff' AND u.user_code LIKE 'LK-%' THEN 1 ELSE 0 END) AS linked_count,
        NULLIF(MAX(CASE WHEN u.status = 'active' AND u.role IN ('company_admin', 'sales_manager', 'field_manager', 'office_staff')
          THEN MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) ELSE '' END), '') AS last_admin_login_at
      FROM users u GROUP BY u.company_id) u ON u.company_id = co.company_id
    LEFT JOIN (SELECT company_id, SUM(CASE WHEN work_date >= ? THEN 1 ELSE 0 END) AS reports_30d, SUM(CASE WHEN work_date < ? THEN 1 ELSE 0 END) AS reports_prev_30d
      FROM daily_reports WHERE work_date >= ? AND work_date <= ? GROUP BY company_id) dr ON dr.company_id = co.company_id
    LEFT JOIN (SELECT company_id, SUM(CASE WHEN work_date >= ? THEN 1 ELSE 0 END) AS shifts_30d, SUM(CASE WHEN work_date < ? THEN 1 ELSE 0 END) AS shifts_prev_30d
      FROM shifts WHERE work_date >= ? AND work_date <= ? GROUP BY company_id) sh ON sh.company_id = co.company_id
    WHERE COALESCE(co.active_status, 'active') != ? ORDER BY co.company_id`)
      .bind(d90, d30, d30, d60, today, d30, d30, d60, today, HQ_COMPANY_STATUS),
    // 週次アクティブ（#491）: 課金対象の利用者のうち、ログイン・アプリの操作（last_seen_at）か、アプリからの勤怠の報告が期間内にあった人。
    // 他社から連携したスタッフは所属元のログインのまま稼働先へ報告するので、報告先の企業のスタッフ行で数える
    db.prepare(`SELECT company_id, SUM(CASE WHEN last_at >= ? THEN 1 ELSE 0 END) AS active_users, COUNT(*) AS active_users_30d
      FROM (SELECT company_id, user_id, MAX(t) AS last_at FROM (
          SELECT u.company_id, u.user_id, MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) AS t FROM users u
            WHERE ${HQ_BILLABLE_SQL} AND MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) >= ?
          UNION ALL
          SELECT u.company_id, u.user_id, ar.reported_at AS t FROM attendance_reports ar
            JOIN staff_profiles sp ON sp.staff_id = ar.staff_id JOIN users u ON u.user_id = sp.user_id
            WHERE ar.reported_at >= ? AND COALESCE(ar.entry_method, 'app') = 'app' AND ${HQ_BILLABLE_SQL}
        ) GROUP BY company_id, user_id)
      GROUP BY company_id`).bind(d7, d30, d30),
    // 請求記録（#295）: 入金待ち・滞納の月数と、最後に記録した月
    db.prepare(`SELECT company_id, SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue_months,
        SUM(CASE WHEN status IN ('issued', 'overdue') THEN 1 ELSE 0 END) AS unpaid_months, MAX(month) AS last_billed_month,
        SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) AS prev_month_recorded
      FROM company_billing_months GROUP BY company_id`).bind(prevMonth(today.slice(0, 7))),
  ])
  const actBy = new Map((act.results as any[]).map(r => [r.company_id, r]))
  const billBy = new Map((bill.results as any[]).map(r => [r.company_id, r]))
  const prices = await loadPlanPrices(db)
  const noShiftSince = addDays(today, -HQ_NO_SHIFT_DAYS)
  const soon = addDays(today, HQ_DUE_SOON_DAYS)
  const dropped = (cur: number, prev: number) => prev >= HQ_DROP_MIN_BASE && cur <= prev * (1 - HQ_DROP_RATE)
  const companies = (rows.results as any[]).map(co => {
    const a = actBy.get(co.company_id) || {}
    const bl = billBy.get(co.company_id) || {}
    // 次の期日（#296）: トライアル中ならトライアルの終了日と、次回レビュー日のうち早いほう
    const dues = [co.active_status === 'trial' ? co.trial_ends_at : null, co.next_review_at].filter(Boolean).sort()
    const nextDue = dues[0] || null
    return {
      ...co,
      active_users: a.active_users || 0, active_users_30d: a.active_users_30d || 0,
      monthly_fee: planFee(prices, co.plan, co.user_count || 0),
      // 契約ユーザー数（user_limit。NULL は上限なし）を超えているか（#321）
      over_limit: co.user_limit != null && co.user_count > co.user_limit,
      reports_change: changeRate(co.reports_30d, co.reports_prev_30d),
      shifts_change: changeRate(co.shifts_30d, co.shifts_prev_30d),
      usage_drop: dropped(co.reports_30d, co.reports_prev_30d) || dropped(co.shifts_30d, co.shifts_prev_30d),
      // シフトの登録日（created_at）は UTC。日単位の目安なので日付だけで比べる
      no_recent_shift: !co.last_shift_created_at || String(co.last_shift_created_at).slice(0, 10) < noShiftSince,
      next_due: nextDue,
      due_state: !nextDue ? null : nextDue < today ? 'past' : nextDue <= soon ? 'soon' : null,
      trial_no_end: co.active_status === 'trial' && !co.trial_ends_at,
      overdue_months: bl.overdue_months || 0, unpaid_months: bl.unpaid_months || 0, last_billed_month: bl.last_billed_month || null,
      // 未入金が2か月以上か、滞納の月がある
      payment_alert: (bl.overdue_months || 0) > 0 || (bl.unpaid_months || 0) >= 2,
    }
  })
  const pm = prevMonth(today.slice(0, 7))
  const billing = {
    prev_month: pm,
    // 利用中の企業のうち前の月を記録済みの数（記録の後に停止・トライアルにした企業は数えない。利用中の数と比べるため）
    prev_month_recorded: companies.filter(c => c.active_status === 'active' && (billBy.get(c.company_id) as any)?.prev_month_recorded).length,
    billable_companies: companies.filter(c => c.active_status === 'active').length,
  }
  return c.json({ companies, billing, plan_prices: [...prices.values()],
    rules: { drop_rate: HQ_DROP_RATE, drop_min_base: HQ_DROP_MIN_BASE, no_shift_days: HQ_NO_SHIFT_DAYS, due_soon_days: HQ_DUE_SOON_DAYS } })
})

api.get('/hq/companies/:id', async (c) => {
  const cid = c.req.param('id')
  const db = c.env.DB
  const company = await db.prepare('SELECT * FROM companies WHERE company_id = ? AND COALESCE(active_status, \'active\') != ?').bind(cid, HQ_COMPANY_STATUS).first() as any
  if (!company) return c.json({ error: 'not found' }, 404)
  // 本部ユーザーは一覧に出さない。メールアドレスは管理者アカウントの分だけ返す（スタッフの連絡先は本部に出さない）
  // billable: 課金対象（企業一覧の利用数・月額と同じ条件）。在籍状況（休職など）はスタッフ行の値（#366）
  const users = await db.prepare(`SELECT u.user_id, u.user_code, u.name, u.role, u.status, u.last_login_at, u.last_seen_at, u.must_change_password,
      CASE WHEN u.role IN ('company_admin','sales_manager','field_manager','office_staff') THEN u.email END AS email,
      sp.employment_status, (u.role = 'staff' AND u.user_code LIKE 'LK-%') AS linked,
      (${HQ_BILLABLE_SQL}) AS billable
    FROM users u LEFT JOIN staff_profiles sp ON sp.user_id = u.user_id
    WHERE u.company_id = ? AND u.role != 'system_admin' ORDER BY u.user_id`).bind(cid).all()
  const stats = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM daily_reports WHERE company_id = ?) AS total_reports,
      (SELECT COUNT(*) FROM shifts WHERE company_id = ?) AS total_shifts,
      (SELECT COUNT(*) FROM attendance_reports WHERE company_id = ?) AS total_attendance,
      (SELECT COUNT(*) FROM projects WHERE company_id = ? AND status = 'active') AS active_projects`).bind(cid, cid, cid, cid).first()
  // 直近6か月の月別の推移（日報数・シフト数・稼働した人数。#517）
  const today = todayJST()
  const months: string[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - i)
    months.push(d.toISOString().slice(0, 7))
  }
  const from = months[0] + '-01'
  const [rep, sh, billing, supportLogs, auditLogs] = await db.batch([
    db.prepare(`SELECT substr(work_date, 1, 7) AS ym, COUNT(*) AS n FROM daily_reports WHERE company_id = ? AND work_date >= ? AND work_date <= ? GROUP BY ym`).bind(cid, from, today),
    db.prepare(`SELECT substr(work_date, 1, 7) AS ym, COUNT(*) AS n,
        COUNT(DISTINCT CASE WHEN status IN ('confirmed', 'substitute') THEN staff_id END) AS staff
      FROM shifts WHERE company_id = ? AND work_date >= ? AND work_date <= ? GROUP BY ym`).bind(cid, from, today),
    // 月ごとの請求記録（#295。新しい月から24か月分）
    db.prepare(`SELECT month, plan, user_count, amount, status, issued_at, paid_at, note, recorded_at FROM company_billing_months
      WHERE company_id = ? ORDER BY month DESC LIMIT 24`).bind(cid),
    // 伴走支援の履歴（#296。新しい順に50件）
    db.prepare(`SELECT l.log_id, l.body, l.next_action_date, l.created_at, us.name AS actor_name FROM company_support_logs l
      LEFT JOIN users us ON us.user_id = l.actor_user_id WHERE l.company_id = ? ORDER BY l.created_at DESC, l.log_id DESC LIMIT 50`).bind(cid),
    // 本部の操作の履歴（#542。新しい順に50件）
    db.prepare(`SELECT l.log_id, l.action, l.target, l.before_json, l.after_json, l.reason, l.created_at, us.name AS actor_name FROM hq_audit_logs l
      LEFT JOIN users us ON us.user_id = l.actor_user_id WHERE l.company_id = ? ORDER BY l.log_id DESC LIMIT 50`).bind(cid),
  ])
  const repBy = new Map((rep.results as any[]).map(r => [r.ym, r.n]))
  const shBy = new Map((sh.results as any[]).map(r => [r.ym, r]))
  const monthly = months.map(ym => ({ month: ym, reports: repBy.get(ym) || 0, shifts: (shBy.get(ym) as any)?.n || 0, working_staff: (shBy.get(ym) as any)?.staff || 0 }))
  const list = users.results as any[]
  const userCount = list.filter(u => u.billable).length
  const prices = await loadPlanPrices(db)
  const usage = {
    user_count: userCount, user_limit: company.user_limit ?? null,
    linked_count: list.filter(u => u.billable && u.linked).length,
    over_limit: company.user_limit != null && userCount > company.user_limit,
    // 今の人数とプランで計算した今月の見込み額（#295）
    monthly_fee: planFee(prices, company.plan, userCount),
  }
  return c.json({ company, users: list, stats, monthly, usage, billing: billing.results, support_logs: supportLogs.results, audit_logs: auditLogs.results,
    plan_prices: [...prices.values()] })
})

api.put('/hq/companies/:id', async (c) => {
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const db = c.env.DB
  const cid = Number(c.req.param('id'))
  // 本部専用の企業行（internal）は変更しない
  const before = await db.prepare(`SELECT * FROM companies WHERE company_id = ? AND COALESCE(active_status, 'active') != ?`).bind(cid, HQ_COMPANY_STATUS).first() as any
  if (!before) return c.json({ error: 'not found' }, 404)
  // 送られた項目だけを確かめて更新する（#254）。null は従来どおり「変更しない」。ただしユーザー上限の空欄・null は「上限なし」（NULL）
  const set: Record<string, unknown> = {}
  if (b.company_name != null) {
    // 会社名の変更（#558）。掲示板・企業間連携の相手にも新しい名前が出る
    const name = String(b.company_name).trim()
    if (!name) return c.json({ error: '会社名を入力してください', field: 'company_name' }, 400)
    if (name.length > 100) return c.json({ error: '会社名は100文字以内にしてください', field: 'company_name' }, 400)
    set.company_name = name
  }
  if (b.plan != null) { if (!oneOf(b.plan, HQ_PLANS)) return c.json({ error: 'プランの値が正しくありません' }, 400); set.plan = b.plan }
  if (b.active_status != null) { if (!oneOf(b.active_status, HQ_ACTIVE_STATUSES)) return c.json({ error: '利用状態の値が正しくありません' }, 400); set.active_status = b.active_status }
  if (b.billing_status != null) { if (!oneOf(b.billing_status, HQ_BILLING_STATUSES)) return c.json({ error: '請求状態の値が正しくありません' }, 400); set.billing_status = b.billing_status }
  if (b.maturity_level != null) {
    const n = toInt(b.maturity_level, 1, 5)
    if (n === null) return c.json({ error: '運営成熟度は1〜5で指定してください' }, 400)
    set.maturity_level = n
  }
  if (b.user_limit !== undefined) {
    const r = parseUserLimit(b.user_limit)
    if ('error' in r) return c.json({ error: r.error }, 400)
    set.user_limit = r.value
  }
  if (b.support_memo != null) {
    if (typeof b.support_memo !== 'string') return c.json({ error: '伴走支援メモの形式が正しくありません' }, 400)
    if (b.support_memo.length > 5000) return c.json({ error: '伴走支援メモは5000文字以内にしてください' }, 400)
    set.support_memo = b.support_memo || null
  }
  // 契約の期日（#296）と連絡先（#558）。空欄は NULL
  for (const k of [...HQ_DATE_FIELDS, ...HQ_CONTACT_FIELDS]) {
    const r = (HQ_DATE_FIELDS as readonly string[]).includes(k) ? pickCompanyDate(b, k) : pickCompanyContact(b, k)
    if (!r) continue
    if ('error' in r) return c.json({ error: r.error, field: r.field }, 400)
    set[k] = r.value
  }
  if (!Object.keys(set).length) return c.json({ error: '変更する項目がありません' }, 400)
  // 変わった項目だけを更新し、変更前と変更後を本部の操作の履歴に残す（#542）
  const changed = Object.keys(set).filter(k => (before[k] ?? null) !== (set[k] ?? null))
  // 何も変わらない保存は、操作の履歴にも残さない
  if (!changed.length) { c.set('hqAudited', true); return c.json({ ok: true, changed: [], revoked_sessions: 0 }) }
  // 停止・再開の理由（#542）。本部の画面では停止と再開のときに入力を必須にしている（API は理由なしの呼び出しも受け付け、そのまま記録する）
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : ''
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE companies SET ${changed.map(k => `${k} = ?`).join(', ')} WHERE company_id = ? AND COALESCE(active_status, 'active') != ?`)
      .bind(...changed.map(k => set[k] ?? null), cid, HQ_COMPANY_STATUS),
  ]
  if (changed.includes('company_name')) {
    // 自社名の取引先マスタの行（自社社員の判定の基準。0010）と、自社社員の所属会社名も新しい名前にそろえる（#558）
    const oldName = before.company_name, newName = set.company_name
    stmts.push(
      db.prepare('UPDATE OR IGNORE staff_affiliations SET affiliation_name = ? WHERE company_id = ? AND affiliation_name = ?').bind(newName, cid, oldName),
      db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(cid, newName),
      // 新しい名前の行がすでにあって付け替えられなかった古い名前の行は、どこからも使われていなければ消す（取引先の一覧に出ないように）
      db.prepare(`DELETE FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?
          AND NOT EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.partner_affiliation_id = staff_affiliations.affiliation_id)
          AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.payee_affiliation_id = staff_affiliations.affiliation_id)
          AND NOT EXISTS (SELECT 1 FROM affiliation_excluded_shifts x WHERE x.to_payee_affiliation_id = staff_affiliations.affiliation_id)
          AND NOT EXISTS (SELECT 1 FROM staff_affiliation_schedules sc WHERE sc.partner_affiliation_id = staff_affiliations.affiliation_id AND sc.status = 'pending')`).bind(cid, oldName),
      db.prepare(`UPDATE staff_profiles SET affiliation = ? WHERE company_id = ? AND affiliation = ? AND COALESCE(affiliation_type, 'own_employee') = 'own_employee'`)
        .bind(newName, cid, oldName),
    )
  }
  const pick = (o: any) => Object.fromEntries(changed.map(k => [k, o[k] ?? null]))
  stmts.push(hqAuditStmt(c, { action: 'company.update', company_id: cid, target: String(set.company_name ?? before.company_name), before: pick(before), after: pick(set), reason: reason || null }))
  await db.batch(stmts)
  // 停止にした時点で、その企業の利用者（本部ユーザーを除く）をログアウトさせる
  const revoked = b.active_status === 'inactive' ? await revokeCompanySessions(db, cid) : 0
  return c.json({ ok: true, changed, revoked_sessions: revoked })
})

api.post('/hq/companies', async (c) => {
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  // 会社コードはログイン画面と同じく全角を半角にそろえ、小文字にして保存する（#398 #387）
  const companyCode = normalizeLoginCode(b.company_code).toLowerCase()
  const companyName = String(b.company_name ?? '').trim()
  const adminCode = normalizeLoginCode(b.admin_code)
  if (!companyCode || !companyName) return c.json({ error: '会社コードと会社名は必須です', field: !companyCode ? 'company_code' : 'company_name' }, 400)
  if (!COMPANY_CODE_RE.test(companyCode)) return c.json({ error: '会社コードは半角の英小文字・数字・ハイフンで2〜40文字にしてください（先頭は英数字）', field: 'company_code' }, 400)
  if (companyName.length > 100) return c.json({ error: '会社名は100文字以内にしてください', field: 'company_name' }, 400)
  const plan = b.plan === undefined || b.plan === '' ? 'basic' : b.plan
  if (!oneOf(plan, HQ_PLANS)) return c.json({ error: 'プランの値が正しくありません', field: 'plan' }, 400)
  // ユーザー上限: 送られなければ3。空欄は上限なし
  const limit = b.user_limit === undefined ? { value: 3 } : parseUserLimit(b.user_limit)
  if ('error' in limit) return c.json({ error: limit.error, field: 'user_limit' }, 400)
  // トライアルの終了日・契約開始日（#296）と連絡先（#558）は任意
  const extra: Record<string, unknown> = {}
  for (const k of [...HQ_DATE_FIELDS, ...HQ_CONTACT_FIELDS]) {
    const r = (HQ_DATE_FIELDS as readonly string[]).includes(k) ? pickCompanyDate(b, k) : pickCompanyContact(b, k)
    if (!r) continue
    if ('error' in r) return c.json({ error: r.error, field: r.field }, 400)
    if (r.value != null) extra[k] = r.value
  }
  const db = c.env.DB
  // ログインは大文字・小文字の違いだけのコードも照合するため、重複も大文字・小文字を区別せずに確かめる
  if (await db.prepare('SELECT 1 FROM companies WHERE LOWER(company_code) = ?').bind(companyCode).first()) return c.json({ error: '会社コードが重複しています', field: 'company_code' }, 409)
  // 初期管理者は必須（管理者のいない企業を作らない。#398）。メールアドレスを登録すると、承認依頼の通知とパスワード再設定のメールが届く（#25）。
  // パスワードを空欄にすると仮パスワードを作って一度だけ返す。どちらも初回ログインで本人に変更を求める
  let adminPassword = typeof b.admin_password === 'string' ? b.admin_password : ''
  let generated = false
  const adminEmail = cleanEmail(b.admin_email)
  if (!adminCode) return c.json({ error: '初期管理者のIDを入力してください', field: 'admin_code' }, 400)
  if (!/^\S{1,40}$/.test(adminCode)) return c.json({ error: '初期管理者の ID は空白なしの40文字以内で入力してください', field: 'admin_code' }, 400)
  if (adminEmail === undefined) return c.json({ error: '初期管理者のメールアドレスの形式が正しくありません', field: 'admin_email' }, 400)
  if (!adminPassword) { adminPassword = genTempPassword(); generated = true }
  const pwErr = validatePassword(adminPassword)
  if (pwErr) return c.json({ error: '初期管理者の' + pwErr, field: 'admin_password' }, 400)
  // 企業と初期管理者は1つの batch で作る（管理者の作成に失敗して、管理者のいない企業だけが残らないように）
  const extraCols = Object.keys(extra)
  const stmts = [
    db.prepare(`INSERT INTO companies (company_code, company_name, plan, user_limit, active_status${extraCols.map(k => ', ' + k).join('')}) VALUES (?, ?, ?, ?, ?${extraCols.map(() => ', ?').join('')})`)
      .bind(companyCode, companyName, plan, limit.value, 'trial', ...extraCols.map(k => extra[k])),
    db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, must_change_password)
      SELECT company_id, ?, ?, 'company_admin', ?, ?, 1 FROM companies WHERE company_code = ?`)
      .bind(adminCode, String(b.admin_name || '').trim().slice(0, 60) || '管理者', await hashPassword(adminPassword), adminEmail, companyCode),
    // 本部の操作の履歴（#542）。企業の ID は登録した行から引く
    db.prepare(`INSERT INTO hq_audit_logs (actor_user_id, action, company_id, target, after_json, created_at)
      SELECT ?, 'company.create', company_id, ?, ?, ? FROM companies WHERE company_code = ?`)
      .bind(c.get('user').user_id, companyName, JSON.stringify({ company_code: companyCode, company_name: companyName, plan, user_limit: limit.value, admin_code: adminCode, ...extra }), nowJST(), companyCode),
  ]
  c.set('hqAudited', true)
  try {
    await db.batch(stmts)
  } catch (e) {
    // 一意制約の違反（同時に同じコードで登録された）だけを「重複」とし、それ以外は参照番号付きの 500 にする
    if (isUniqueViolation(e)) return c.json({ error: '会社コードが重複しています', field: 'company_code' }, 409)
    throw e
  }
  return c.json({ ok: true, company_code: companyCode, ...(generated ? { admin_temp_password: adminPassword } : {}) })
})

// ---------- プランの料金の設定（#295） ----------
api.get('/hq/plan-prices', async (c) => {
  return c.json({ prices: [...(await loadPlanPrices(c.env.DB)).values()] })
})
api.put('/hq/plan-prices', async (c) => {
  const b = await c.req.json().catch(() => null)
  const list = b && Array.isArray(b.prices) ? b.prices : null
  if (!list || !list.length) return c.json({ error: '料金の内容が正しくありません' }, 400)
  const db = c.env.DB
  const before = await loadPlanPrices(db)
  const next: PlanPrice[] = []
  for (const p of list) {
    if (!p || !oneOf(p.plan, HQ_PLANS)) return c.json({ error: 'プランの値が正しくありません' }, 400)
    const base = toInt(p.base_fee, 0, PLAN_FEE_MAX), inc = toInt(p.included_users, 0, HQ_USER_LIMIT_MAX), per = toInt(p.per_user_fee, 0, PLAN_FEE_MAX)
    if (base === null || inc === null || per === null) return c.json({ error: `${p.plan} の料金は0以上の整数で入力してください（金額は${PLAN_FEE_MAX.toLocaleString()}円まで）` }, 400)
    next.push({ plan: p.plan, base_fee: base, included_users: inc, per_user_fee: per })
  }
  const changed = next.filter(p => { const o = before.get(p.plan); return !o || o.base_fee !== p.base_fee || o.included_users !== p.included_users || o.per_user_fee !== p.per_user_fee })
  if (!changed.length) { c.set('hqAudited', true); return c.json({ ok: true, changed: 0 }) }
  const now = nowJST(), uid = c.get('user').user_id
  const strip = (p?: PlanPrice) => p ? { base_fee: p.base_fee, included_users: p.included_users, per_user_fee: p.per_user_fee } : null
  await db.batch([
    ...changed.map(p => db.prepare(`INSERT INTO hq_plan_prices (plan, base_fee, included_users, per_user_fee, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan) DO UPDATE SET base_fee = excluded.base_fee, included_users = excluded.included_users, per_user_fee = excluded.per_user_fee,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(p.plan, p.base_fee, p.included_users, p.per_user_fee, uid, now)),
    hqAuditStmt(c, { action: 'plan_price.update', target: changed.map(p => p.plan).join(','),
      before: Object.fromEntries(changed.map(p => [p.plan, strip(before.get(p.plan))])), after: Object.fromEntries(changed.map(p => [p.plan, strip(p)])) }),
  ])
  return c.json({ ok: true, changed: changed.length })
})

// ---------- 月ごとの請求記録（#295） ----------
// 指定した月の請求を記録する（締める）。利用中（active）の企業ごとに、この時点の課金対象の人数・プラン・金額を残す。
// すでに記録がある企業は変えない（金額・入金状態は企業詳細で直す）。トライアル・停止中の企業は記録しない
api.post('/hq/billing/close', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const month = String(b?.month || '')
  if (!MONTH_RE.test(month)) return c.json({ error: '締める月を YYYY-MM で指定してください' }, 400)
  const today = todayJST()
  if (month > today.slice(0, 7)) return c.json({ error: 'これから先の月は締められません' }, 400)
  const created = await closeBillingMonth(c.env.DB, month, c.get('user').user_id)
  await hqAuditStmt(c, { action: 'billing.close', target: month, after: { created } }).run()
  return c.json({ ok: true, month, created })
})
/** 月の請求を記録する（記録済みの企業は変えない）。recordedBy が null なら定期処理の記録。記録した企業の数を返す */
export async function closeBillingMonth(db: D1Database, month: string, recordedBy: number | null): Promise<number> {
  const d = DEFAULT_PLAN_PRICE
  const r = await db.prepare(`INSERT OR IGNORE INTO company_billing_months (company_id, month, plan, user_count, amount, status, issued_at, recorded_at, recorded_by)
    SELECT co.company_id, ?, COALESCE(co.plan, 'basic'), COALESCE(n.cnt, 0),
      COALESCE(pp.base_fee, ${d.base_fee}) + MAX(0, COALESCE(n.cnt, 0) - COALESCE(pp.included_users, ${d.included_users})) * COALESCE(pp.per_user_fee, ${d.per_user_fee}),
      'issued', ?, ?, ?
    FROM companies co
    LEFT JOIN (SELECT u.company_id, SUM(CASE WHEN ${HQ_BILLABLE_SQL} THEN 1 ELSE 0 END) AS cnt FROM users u GROUP BY u.company_id) n ON n.company_id = co.company_id
    LEFT JOIN hq_plan_prices pp ON pp.plan = COALESCE(co.plan, 'basic')
    WHERE co.active_status = 'active'`).bind(month, todayJST(), nowJST(), recordedBy).run()
  return r.meta.changes || 0
}
// 毎月1日の定期処理（#295）: 前月の請求を自動で記録する。1日の起動が失敗したときのため、3日までは記録のない企業の分を足す。
// 人数は記録した時点の課金対象の人数（本部の「締める」ボタンと同じ）。手で締めた企業はそのまま
export async function autoCloseBillingMonth(db: D1Database): Promise<{ idle?: boolean; month?: string; created: number }> {
  const today = todayJST()
  if (Number(today.slice(8, 10)) > 3) return { idle: true, created: 0 }
  const month = prevMonth(today.slice(0, 7))
  return { month, created: await closeBillingMonth(db, month, null) }
}
// 1か月分の請求記録の修正（入金状態・入金日・金額・メモ）
api.put('/hq/companies/:id/billing/:month', async (c) => {
  const cid = Number(c.req.param('id')), month = c.req.param('month')
  if (!MONTH_RE.test(month)) return c.json({ error: 'not found' }, 404)
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const db = c.env.DB
  const before = await db.prepare('SELECT * FROM company_billing_months WHERE company_id = ? AND month = ?').bind(cid, month).first() as any
  if (!before) return c.json({ error: 'この月の請求記録がありません' }, 404)
  const set: Record<string, unknown> = {}
  if (b.status !== undefined) { if (!oneOf(b.status, BILLING_MONTH_STATUSES)) return c.json({ error: '入金状態の値が正しくありません' }, 400); set.status = b.status }
  if (b.amount !== undefined) {
    const n = toInt(b.amount, 0, PLAN_FEE_MAX * 10)
    if (n === null) return c.json({ error: '金額は0以上の整数で入力してください' }, 400)
    set.amount = n
  }
  if (b.paid_at !== undefined) {
    if (b.paid_at !== null && b.paid_at !== '' && !isISODate(b.paid_at)) return c.json({ error: '入金日の日付が正しくありません' }, 400)
    set.paid_at = b.paid_at || null
  }
  if (b.note !== undefined) {
    if (b.note !== null && typeof b.note !== 'string') return c.json({ error: 'メモの形式が正しくありません' }, 400)
    if (b.note && b.note.length > 500) return c.json({ error: 'メモは500文字以内にしてください' }, 400)
    set.note = b.note ? b.note.trim() || null : null
  }
  // 入金済みにして入金日がなければ今日にする。入金済み以外に戻したら入金日は消す
  const status = set.status ?? before.status
  if (status === 'paid' && !(set.paid_at ?? before.paid_at)) set.paid_at = todayJST()
  if (status !== 'paid' && set.status !== undefined) set.paid_at = null
  const changed = Object.keys(set).filter(k => (before[k] ?? null) !== (set[k] ?? null))
  if (!changed.length) { c.set('hqAudited', true); return c.json({ ok: true, changed: [] }) }
  const pick = (o: any) => Object.fromEntries(changed.map(k => [k, o[k] ?? null]))
  await db.batch([
    db.prepare(`UPDATE company_billing_months SET ${changed.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE company_id = ? AND month = ?`)
      .bind(...changed.map(k => set[k] ?? null), nowJST(), cid, month),
    hqAuditStmt(c, { action: 'billing.update', company_id: cid, target: month, before: pick(before), after: pick(set) }),
  ])
  return c.json({ ok: true, changed })
})

// ---------- 伴走支援の履歴（#296） ----------
// 追記で残す。次回の予定日を入れると、企業の次回レビュー日もその日にする
api.post('/hq/companies/:id/support-logs', async (c) => {
  const cid = Number(c.req.param('id'))
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const body = typeof b.body === 'string' ? b.body.trim() : ''
  if (!body) return c.json({ error: '支援の内容を入力してください', field: 'body' }, 400)
  if (body.length > 2000) return c.json({ error: '支援の内容は2000文字以内にしてください', field: 'body' }, 400)
  const next = b.next_action_date || null
  if (next !== null && !isISODate(next)) return c.json({ error: '次回の予定日の日付が正しくありません', field: 'next_action_date' }, 400)
  const db = c.env.DB
  const co = await db.prepare(`SELECT company_id, company_name, next_review_at FROM companies WHERE company_id = ? AND COALESCE(active_status, 'active') != ?`).bind(cid, HQ_COMPANY_STATUS).first() as any
  if (!co) return c.json({ error: 'not found' }, 404)
  const uid = c.get('user').user_id
  const stmts: D1PreparedStatement[] = [
    db.prepare('INSERT INTO company_support_logs (company_id, actor_user_id, body, next_action_date, created_at) VALUES (?, ?, ?, ?, ?)').bind(cid, uid, body, next, nowJST()),
  ]
  if (next && next !== co.next_review_at) {
    stmts.push(db.prepare('UPDATE companies SET next_review_at = ? WHERE company_id = ?').bind(next, cid))
    stmts.push(hqAuditStmt(c, { action: 'company.update', company_id: cid, target: co.company_name, before: { next_review_at: co.next_review_at ?? null }, after: { next_review_at: next }, reason: '伴走支援の記録から' }))
  } else {
    // 記録そのものに担当者と日時が残るので、操作の履歴には重ねて残さない
    c.set('hqAudited', true)
  }
  await db.batch(stmts)
  return c.json({ ok: true })
})

// ---------- 本部の操作の履歴（#542） ----------
const HQ_AUDIT_PAGE = 50
api.get('/hq/audit-logs', async (c) => {
  const page = toInt(c.req.query('page') || '1', 1, 10000) || 1
  const cid = c.req.query('company_id')
  const where = cid && /^\d+$/.test(cid) ? 'WHERE l.company_id = ?' : ''
  const rows = (await c.env.DB.prepare(`SELECT l.log_id, l.action, l.company_id, l.target, l.before_json, l.after_json, l.reason, l.created_at,
      us.name AS actor_name, co.company_name
    FROM hq_audit_logs l LEFT JOIN users us ON us.user_id = l.actor_user_id LEFT JOIN companies co ON co.company_id = l.company_id
    ${where} ORDER BY l.log_id DESC LIMIT ? OFFSET ?`).bind(...(where ? [Number(cid)] : []), HQ_AUDIT_PAGE + 1, (page - 1) * HQ_AUDIT_PAGE).all()).results as any[]
  return c.json({ logs: rows.slice(0, HQ_AUDIT_PAGE), page, has_more: rows.length > HQ_AUDIT_PAGE })
})

// 契約ユーザー数（本部が決めた上限）と今の利用数。企業の管理画面に表示する（#321。登録は止めず、表示のみ）
api.get('/admin/contract-usage', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare(`SELECT co.user_limit,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND ${HQ_BILLABLE_SQL}) AS user_count
    FROM companies co WHERE co.company_id = ?`).bind(u.company_id).first() as any
  const limit = row?.user_limit ?? null, count = row?.user_count || 0
  return c.json({ user_count: count, user_limit: limit, over_limit: limit != null && count > limit, remaining: limit != null ? limit - count : null })
})

// テンプレート配信管理
function safeJsonArray(json: any): any[] {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
// 企業独自のテンプレートは会社名、どれも使っている案件の数と日報の有無（編集できる範囲の表示に使う。#165）を付ける
api.get('/hq/templates', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT t.*, COALESCE(t.status, 'active') AS status, co.company_name,
      (SELECT COUNT(*) FROM projects p WHERE p.report_template_id = t.template_id) AS project_count,
      EXISTS (SELECT 1 FROM projects p JOIN daily_reports dr ON dr.project_id = p.project_id WHERE p.report_template_id = t.template_id) AS has_reports
    FROM report_templates t LEFT JOIN companies co ON co.company_id = t.company_id ORDER BY t.company_id IS NOT NULL, t.template_id`).all()
  return c.json({ templates: (rows.results as any[]).map(t => ({ ...t, fields: safeJsonArray(t.fields_json) })) })
})

api.post('/hq/templates', async (c) => {
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const name = String(b.template_name ?? '').trim()
  if (!name) return c.json({ error: 'テンプレート名を入力してください' }, 400)
  if (name.length > TEMPLATE_NAME_MAX) return c.json({ error: `テンプレート名は${TEMPLATE_NAME_MAX}文字以内にしてください` }, 400)
  // 項目のキー・タイプ・数を確かめる（#378）。配信すると全導入企業の案件設定で選べるようになる
  const v = validateTemplateFields(b.fields)
  if ('error' in v) return c.json({ error: v.error }, 400)
  if (await c.env.DB.prepare('SELECT 1 FROM report_templates WHERE company_id IS NULL AND template_name = ?').bind(name).first()) {
    return c.json({ error: '同じ名前の本部テンプレートがあります' }, 409)
  }
  await c.env.DB.prepare(`INSERT INTO report_templates (company_id, template_name, template_type, fields_json) VALUES (NULL, ?, 'hq', ?)`)
    .bind(name, JSON.stringify(v.fields)).run()
  return c.json({ ok: true })
})

// テンプレートの修正・配信停止（#165）。本部のテンプレートのほか、企業独自のテンプレートも直せる（規則は企業と同じ）
api.put('/hq/templates/:id', async (c) => {
  const b = await c.req.json().catch(() => null) as any
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  const cur = await c.env.DB.prepare('SELECT * FROM report_templates WHERE template_id = ?').bind(c.req.param('id')).first()
  if (!cur) return c.json({ error: 'テンプレートが見つかりません' }, 404)
  const r = await updateTemplate(c.env.DB, cur, b, c.get('user').user_id)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ ok: true })
})

// ============ データ保持（定期削除、system_admin限定）============
// 注意: 実際の削除はCron Triggerからのみ実行する（HTTP経由の一般APIとしては公開しない）。
// ここではdry-run（削除せず対象件数のみ確認）と、過去の実行ログの閲覧のみ提供する。
// 全社にまたがる集計のため、各社admin(company_admin等)ではなく本部(system_admin)限定とする。
// 会社別・退職者別の内訳（detail）も返す（#365）
api.post('/hq/retention/dry-run', async (c) => {
  // 在職中の保存期間（#420 #511 #350 #425。cron では別の起動で実行する）もまとめて数える
  const result = await runRetentionCleanup(c.env.DB, c.env, { dryRun: true, trigger: 'manual', triggeredBy: c.get('user').user_id, detail: true, stages: ['main', 'in_service'] })
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
  // トークンの削除は RETENTION_ENABLED に関係なく毎日実削除で記録されるので、データ保持の直近の実行には数えない
  // 本部画面の保守（紐づかない写真の削除。#533）も同じく数えない
  const notToken = `l.target NOT IN (${[...RETENTION_TOKEN_TARGETS, ...RETENTION_MAINTENANCE_TARGETS].map(t => `'${t}'`).join(', ')})`
  const latest = await db.prepare(`SELECT
      (SELECT MAX(l.started_at) FROM retention_logs l WHERE l.dry_run = 0 AND ${notToken}) AS last_real_run,
      (SELECT MAX(l.started_at) FROM retention_logs l WHERE ${RETENTION_TRIGGER_SQL} = 'cron' AND ${notToken}) AS last_cron_run`).first()
  return c.json({ runs: out, page, per_page: RETENTION_RUNS_PER_PAGE, total: Number(total?.n) || 0, trigger, latest })
})

// 在職中の保存期間の設定（位置情報と写真・相談・フォロー記録・決着した人材提案。#420 #511 #350）
api.get('/hq/retention/settings', async (c) => {
  return c.json({ settings: await getRetentionSettings(c.env.DB), defs: RETENTION_SETTING_DEFS })
})
api.put('/hq/retention/settings', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return c.json({ error: '入力が正しくありません' }, 400)
  const stmts: D1PreparedStatement[] = []
  for (const [k, d] of Object.entries(RETENTION_SETTING_DEFS)) {
    if (b[k] === undefined) continue
    const v = toInt(b[k], d.min, d.max)
    if (v === null) return c.json({ error: `${d.label}は ${d.min}〜${d.max} の整数で入力してください`, field: k }, 400)
    stmts.push(db.prepare(`INSERT INTO retention_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(k, v, u.user_id, nowJST()))
  }
  if (!stmts.length) return c.json({ error: '変更する項目がありません' }, 400)
  await db.batch(stmts)
  return c.json({ ok: true, settings: await getRetentionSettings(db) })
})

// 削除の保留（#543）。kind: staff（スタッフ ID）/ company（企業 ID）。設定には理由が必要。
// 一覧は GET /hq/retention/schedule の holds で返す
const RETENTION_HOLD_REASON_MAX = 500
api.put('/hq/retention/holds/:kind/:id', async (c) => {
  const kind = c.req.param('kind'); const id = toInt(c.req.param('id'), 1)
  if (!oneOf(kind, ['staff', 'company'] as const) || id === null) return c.json({ error: '保留の対象が正しくありません' }, 400)
  const b = await c.req.json().catch(() => ({})) as any
  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (!reason) return c.json({ error: '保留の理由を入力してください（例: 未払い賃金の請求で係争中）', field: 'reason' }, 400)
  if (reason.length > RETENTION_HOLD_REASON_MAX) return c.json({ error: `保留の理由は${RETENTION_HOLD_REASON_MAX}文字以内で入力してください`, field: 'reason' }, 400)
  const r = await setRetentionHold(c.env.DB, kind, id, { reason, by: c.get('user').user_id })
  if (!r) return c.json({ error: kind === 'staff' ? 'スタッフが見つかりません' : '企業が見つかりません' }, 404)
  return c.json({ ok: true, name: r.name })
})
api.delete('/hq/retention/holds/:kind/:id', async (c) => {
  const kind = c.req.param('kind'); const id = toInt(c.req.param('id'), 1)
  if (!oneOf(kind, ['staff', 'company'] as const) || id === null) return c.json({ error: '保留の対象が正しくありません' }, 400)
  const r = await setRetentionHold(c.env.DB, kind, id, null)
  if (!r) return c.json({ error: kind === 'staff' ? 'スタッフが見つかりません' : '企業が見つかりません' }, 404)
  return c.json({ ok: true, name: r.name })
})

// R2 に残った、どの勤怠にも紐づかない写真（#533 の残り）。1回に500件ずつ見て、cursor で続きを見る。
// dry_run=false のときだけ、そのページの紐づかない写真を消す（消した件数は実行ログに残す）
api.post('/hq/retention/orphan-photos', async (c) => {
  const b = await c.req.json().catch(() => ({})) as any
  const cursor = typeof b.cursor === 'string' && b.cursor.length > 0 && b.cursor.length <= 2048 ? b.cursor : null
  try {
    return c.json(await scanOrphanPhotos(c.env.DB, c.env.PHOTOS, { dryRun: b.dry_run !== false, cursor, triggeredBy: c.get('user').user_id }))
  } catch (e) {
    console.log(`orphan photos failed: ${e}`)
    return c.json({ error: `写真の確認・削除に失敗しました: ${String(e).slice(0, 200)}` }, 502)
  }
})

// ============ 日報の書き出しと保存期間の案内（導入企業向け。#417） ============
// 日報は稼働日から3年で定期削除される。削除の前に控えを取れるよう、期間（最大62日）・案件・スタッフで絞って CSV で書き出す。
// 列は 稼働日・案件・スタッフ・提出日時・インシデント・クレーム・確認・コメントと、日報テンプレートの項目（テンプレートにない値はキー名の列）
const DR_CSV_MAX_DAYS = 62
const DR_CSV_LIMIT = 2000
api.get('/admin/daily-reports-csv', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const from = c.req.query('from') || '', to = c.req.query('to') || ''
  if (!isISODate(from) || !isISODate(to)) return c.json({ error: '開始日と終了日を指定してください' }, 400)
  if (from > to) return c.json({ error: '期間の開始日が終了日より後になっています' }, 400)
  if (addDays(from, DR_CSV_MAX_DAYS - 1) < to) return c.json({ error: `書き出す期間は${DR_CSV_MAX_DAYS}日以内にしてください` }, 400)
  let where = 'dr.company_id = ? AND dr.work_date >= ? AND dr.work_date <= ?'
  const binds: any[] = [u.company_id, from, to]
  for (const [k, col] of [['project_id', 'dr.project_id'], ['staff_id', 'dr.staff_id']] as const) {
    const q = c.req.query(k)
    if (q === undefined || q === '') continue
    const v = toInt(q, 1)
    if (v === null) return c.json({ error: '絞り込みの条件が正しくありません' }, 400)
    where += ` AND ${col} = ?`; binds.push(v)
  }
  const { rows, total } = await loadLatestForCsv(db, `SELECT dr.work_date, dr.submitted_at, dr.report_values, dr.incident_flag, dr.complaint_flag,
      dr.manager_checked, dr.manager_comment, dr.staff_id, p.project_name, p.report_template_id, us.name AS staff_name
    FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id
    JOIN staff_profiles sp ON sp.staff_id = dr.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE ${where} ORDER BY dr.work_date DESC, dr.submitted_at DESC, dr.daily_report_id DESC`,
    `SELECT COUNT(*) AS n FROM daily_reports dr WHERE ${where}`, binds, DR_CSV_LIMIT)
  // テンプレートの項目の順とラベル（複数の案件のテンプレートは、出てきた順に列を足す）
  const cols = new Map<string, string>()
  const tplIds = [...new Set(rows.map(r => r.report_template_id).filter(Boolean))]
  if (tplIds.length) {
    const ts = (await db.prepare(`SELECT template_id, fields_json FROM report_templates WHERE template_id IN ${JSON_IN}`).bind(bindJsonArray(tplIds)).all()).results as any[]
    const byId = new Map(ts.map(t => [t.template_id, t.fields_json]))
    for (const id of tplIds) {
      let f: any[] = []
      try { const v = JSON.parse(byId.get(id) || '[]'); if (Array.isArray(v)) f = v } catch { f = [] }
      for (const x of f) if (x && typeof x.key === 'string' && !cols.has(x.key)) cols.set(x.key, String(x.label || x.key))
    }
  }
  const values = rows.map(r => {
    let v: Record<string, unknown> = {}
    try { const o = JSON.parse(r.report_values || '{}'); if (o && typeof o === 'object' && !Array.isArray(o)) v = o } catch { v = {} }
    for (const k of Object.keys(v)) if (!cols.has(k)) cols.set(k, k)
    return v
  })
  const cell = (x: unknown) => x == null ? '' : Array.isArray(x) ? x.join('、') : typeof x === 'object' ? JSON.stringify(x) : x
  const keys = [...cols.keys()]
  const header = ['稼働日', '案件', 'スタッフ', 'スタッフID', '提出日時', 'インシデント', 'クレーム', '確認', '管理者コメント', ...keys.map(k => cols.get(k) as string)]
  const body = rows.map((r, i) => [r.work_date, r.project_name, r.staff_name, r.staff_id, r.submitted_at, r.incident_flag ? 'あり' : '', r.complaint_flag ? 'あり' : '',
    r.manager_checked ? '確認済み' : '未確認', r.manager_comment || '', ...keys.map(k => cell(values[i][k]))])
  return csvResponse(`日報_${from}_${to}.csv`, toCsv(header, body, { note: csvLimitNote(total, DR_CSV_LIMIT) }), csvLimitHeaders(total, DR_CSV_LIMIT))
})
// 日報の保存期間と、今後30日のうちに3年を過ぎて削除される件数（日報一覧の案内に出す）
api.get('/admin/daily-reports-retention', async (c) => {
  return c.json({ ...await dailyReportRetentionInfo(c.env.DB, c.get('user').company_id), enabled: c.env.RETENTION_ENABLED === 'true' })
})

// 定期処理（cron）の処理ごとの最終実行・直近の実行記録・警告（#192）
api.get('/hq/cron/status', async (c) => {
  return c.json(await cronStatus(c.env.DB))
})

// ============ 解約・停止した企業のデータの書き出しと削除（system_admin限定。作業単位 w5-hq-offboarding: #177） ============
// 停止中の企業に「契約終了」を登録すると猶予中になり、契約終了日＋猶予日数を過ぎてから削除できる。
// 削除は、会社コードの入力と「削除する」の入力（二重の確認）のうえで、1回の要求で処理できる量ずつ進める（画面が続けて呼ぶ）。
// 書き出し（CSV・ファイルの取得）・登録・取消・削除は company_offboarding_events に記録し、削除の記録は CSV で出せる。
const OFFBOARDING_FILES_PAGE = 100
const OFFBOARDING_CONFIRM_TEXT = '削除する'
const OFFBOARDING_STATUSES_OPEN = ['scheduled', 'deleting']

async function offboardingCompany(db: D1Database, cid: number): Promise<any | null> {
  return await db.prepare(`SELECT company_id, company_code, company_name, active_status, created_at FROM companies
    WHERE company_id = ? AND COALESCE(active_status, 'active') != ?`).bind(cid, HQ_COMPANY_STATUS).first()
}
async function latestOffboarding(db: D1Database, cid: number): Promise<any | null> {
  return await db.prepare('SELECT * FROM company_offboardings WHERE company_id = ? ORDER BY offboarding_id DESC LIMIT 1').bind(cid).first()
}
function offboardingEventStmt(db: D1Database, e: { offboarding_id?: number | null; company_id: number; action: string; actor: number; detail?: unknown }) {
  return db.prepare(`INSERT INTO company_offboarding_events (offboarding_id, company_id, action, actor_user_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(e.offboarding_id ?? null, e.company_id, e.action, e.actor, e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, 4000), new Date().toISOString())
}
// 会社コードの照合（大文字・小文字と全角・半角の違いは問わない）
function sameCompanyCode(input: unknown, code: string): boolean {
  return normalizeLoginCode(input).toLowerCase() === String(code || '').toLowerCase()
}
// 削除の前に書き出したか（契約終了の登録の前の書き出しも数える）
async function offboardingExported(db: D1Database, cid: number): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM company_offboarding_events WHERE company_id = ? AND action = 'export' LIMIT 1`).bind(cid).first())
}

// 一覧: 停止中の企業と、解約の処理の記録がある企業
api.get('/hq/offboarding', async (c) => {
  const rows = (await c.env.DB.prepare(`SELECT co.company_id, co.company_code, co.company_name, co.active_status,
      o.offboarding_id, o.status, o.contract_end_date, o.delete_after, o.completed_at, o.last_error,
      (SELECT MAX(e.created_at) FROM company_offboarding_events e WHERE e.company_id = co.company_id AND e.action = 'export') AS last_export_at
    FROM companies co
    LEFT JOIN company_offboardings o ON o.offboarding_id = (SELECT MAX(x.offboarding_id) FROM company_offboardings x WHERE x.company_id = co.company_id)
    WHERE COALESCE(co.active_status, 'active') != ? AND (co.active_status = 'inactive' OR o.offboarding_id IS NOT NULL)
    ORDER BY CASE o.status WHEN 'deleting' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'completed' THEN 3 ELSE 2 END, o.delete_after, co.company_id`)
    .bind(HQ_COMPANY_STATUS).all()).results
  return c.json({ companies: rows, today: todayJST(), grace_days: OFFBOARDING_GRACE_DAYS })
})

// 詳細: 解約の処理・操作の記録・表ごとの件数（削除の dry-run を兼ねる）・R2 のファイルの件数
api.get('/hq/offboarding/:cid', async (c) => {
  const db = c.env.DB
  const cid = toInt(c.req.param('cid'), 1)
  const company = cid ? await offboardingCompany(db, cid) : null
  if (!cid || !company) return c.json({ error: '企業が見つかりません' }, 404)
  const ob = await latestOffboarding(db, cid)
  const events = (await db.prepare(`SELECT e.event_id, e.offboarding_id, e.action, e.detail, e.created_at, u.name AS actor_name
    FROM company_offboarding_events e LEFT JOIN users u ON u.user_id = e.actor_user_id
    WHERE e.company_id = ? ORDER BY e.event_id DESC LIMIT 100`).bind(cid).all()).results
  const data = await countOffboardingData(db, cid)
  const tables = OFFBOARDING_TABLES.map(t => ({ target: t.target, label: t.label, count: data.counts[t.target] || 0, export: !t.noExport, delete: !t.noDelete }))
  const today = todayJST()
  return c.json({
    company, offboarding: ob, events, tables, files: data.files, unknown_tables: data.unknown_tables,
    exported: await offboardingExported(db, cid), today,
    can_delete: !!ob && ob.status === 'scheduled' && company.active_status === 'inactive' && today >= ob.delete_after,
    settings: { grace_days: OFFBOARDING_GRACE_DAYS, grace_min: OFFBOARDING_GRACE_MIN, grace_max: OFFBOARDING_GRACE_MAX,
      export_page: OFFBOARDING_EXPORT_PAGE, files_page: OFFBOARDING_FILES_PAGE, confirm_text: OFFBOARDING_CONFIRM_TEXT, total_steps: OFFBOARDING_TOTAL_STEPS },
  })
})

// 契約終了の登録（停止中の企業だけ）。会社コードの入力で確かめる
api.post('/hq/offboarding/:cid/start', async (c) => {
  const db = c.env.DB
  const u = c.get('user')
  const cid = toInt(c.req.param('cid'), 1)
  const company = cid ? await offboardingCompany(db, cid) : null
  if (!cid || !company) return c.json({ error: '企業が見つかりません' }, 404)
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  if (company.active_status !== 'inactive') return c.json({ error: '契約終了を登録できるのは、利用状態が「停止」の企業だけです。先に企業の利用状態を停止にしてください' }, 409)
  if (!isISODate(b.contract_end_date)) return c.json({ error: '契約終了日を YYYY-MM-DD 形式の正しい日付で入力してください', field: 'contract_end_date' }, 400)
  const grace = b.grace_days === undefined || b.grace_days === '' ? OFFBOARDING_GRACE_DAYS : toInt(b.grace_days, OFFBOARDING_GRACE_MIN, OFFBOARDING_GRACE_MAX)
  if (grace === null) return c.json({ error: `猶予日数は${OFFBOARDING_GRACE_MIN}〜${OFFBOARDING_GRACE_MAX}日で指定してください`, field: 'grace_days' }, 400)
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 1000) : ''
  if (!sameCompanyCode(b.confirm_company_code, company.company_code)) return c.json({ error: '確認のための会社コードが一致しません', field: 'confirm_company_code' }, 400)
  const deleteAfter = addDays(b.contract_end_date, grace)
  try {
    const r = await db.prepare(`INSERT INTO company_offboardings (company_id, status, contract_end_date, grace_days, delete_after, reason, requested_by, requested_at)
      VALUES (?, 'scheduled', ?, ?, ?, ?, ?, ?)`).bind(cid, b.contract_end_date, grace, deleteAfter, reason || null, u.user_id, new Date().toISOString()).run()
    await offboardingEventStmt(db, { offboarding_id: Number(r.meta.last_row_id), company_id: cid, action: 'start', actor: u.user_id,
      detail: { contract_end_date: b.contract_end_date, grace_days: grace, delete_after: deleteAfter, reason: reason || null } }).run()
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'この企業には進行中の解約の処理があります' }, 409)
    throw e
  }
  return c.json({ ok: true, delete_after: deleteAfter })
})

// 契約終了の取消（猶予中だけ。削除を始めた後は取り消せない）
api.post('/hq/offboarding/:cid/cancel', async (c) => {
  const db = c.env.DB
  const u = c.get('user')
  const cid = toInt(c.req.param('cid'), 1)
  if (!cid) return c.json({ error: '企業が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({})) as any
  const reason = typeof b?.reason === 'string' ? b.reason.trim().slice(0, 1000) : ''
  const ob = await latestOffboarding(db, cid)
  if (!ob || ob.status !== 'scheduled') return c.json({ error: ob?.status === 'deleting' ? '削除を始めた後は取り消せません' : '取り消せる契約終了の登録がありません' }, 409)
  const r = await db.prepare(`UPDATE company_offboardings SET status = 'cancelled', cancelled_by = ?, cancelled_at = ? WHERE offboarding_id = ? AND status = 'scheduled'`)
    .bind(u.user_id, new Date().toISOString(), ob.offboarding_id).run()
  if (!r.meta.changes) return c.json({ error: '状態が変わったため取り消せませんでした。画面を読み直してください' }, 409)
  await offboardingEventStmt(db, { offboarding_id: ob.offboarding_id, company_id: cid, action: 'cancel', actor: u.user_id, detail: { reason: reason || null } }).run()
  return c.json({ ok: true })
})

// 書き出しができるか（停止中で、削除が済んでいない企業）
async function offboardingExportable(db: D1Database, cid: number | null): Promise<{ company: any; ob: any } | { error: string; status: 404 | 409 }> {
  const company = cid ? await offboardingCompany(db, cid) : null
  if (!cid || !company) return { error: '企業が見つかりません', status: 404 }
  if (company.active_status !== 'inactive') return { error: '書き出しができるのは、利用状態が「停止」の企業だけです', status: 409 }
  const ob = await latestOffboarding(db, cid)
  if (ob && (ob.status === 'completed' || ob.status === 'deleting')) return { error: '削除を始めた企業のデータは書き出せません', status: 409 }
  return { company, ob }
}

// 表ごとの CSV（offset から OFFBOARDING_EXPORT_PAGE 行。次があれば X-Export-Next に次の offset を入れる）。最初の取得を記録する
api.get('/hq/offboarding/:cid/export/:target', async (c) => {
  const db = c.env.DB
  const cid = toInt(c.req.param('cid'), 1)
  const ok = await offboardingExportable(db, cid)
  if ('error' in ok) return c.json({ error: ok.error }, ok.status)
  const offset = toInt(c.req.query('offset') ?? '0', 0, 100000000)
  if (offset === null) return c.json({ error: 'offset が正しくありません' }, 400)
  const page = await exportOffboardingTablePage(db, cid!, c.req.param('target'), offset)
  if (!page) return c.json({ error: '書き出せない表です' }, 404)
  if (offset === 0) {
    await offboardingEventStmt(db, { offboarding_id: ok.ob?.status === 'scheduled' ? ok.ob.offboarding_id : null, company_id: cid!, action: 'export', actor: c.get('user').user_id,
      detail: { target: c.req.param('target') } }).run()
  }
  const next = page.rows.length >= OFFBOARDING_EXPORT_PAGE ? String(offset + page.rows.length) : ''
  return csvResponse(`${ok.company.company_code}_${c.req.param('target')}_${offset}.csv`, toCsv(page.header, page.rows),
    { 'X-Export-Rows': String(page.rows.length), 'X-Export-Next': next })
})

// R2 の写真・書類の一覧（offset から OFFBOARDING_FILES_PAGE 件）
api.get('/hq/offboarding/:cid/files', async (c) => {
  const db = c.env.DB
  const cid = toInt(c.req.param('cid'), 1)
  const ok = await offboardingExportable(db, cid)
  if ('error' in ok) return c.json({ error: ok.error }, ok.status)
  const offset = toInt(c.req.query('offset') ?? '0', 0, 100000000)
  if (offset === null) return c.json({ error: 'offset が正しくありません' }, 400)
  const files = await listOffboardingFiles(db, cid!, offset, OFFBOARDING_FILES_PAGE + 1)
  return c.json({ files: files.slice(0, OFFBOARDING_FILES_PAGE), offset, next: files.length > OFFBOARDING_FILES_PAGE ? offset + OFFBOARDING_FILES_PAGE : null })
})

// R2 のファイル1件の取得（元の表と行の ID で。その企業のものだけ）。取得を記録する
api.get('/hq/offboarding/:cid/files/:source/:id', async (c) => {
  const db = c.env.DB
  const cid = toInt(c.req.param('cid'), 1)
  const ok = await offboardingExportable(db, cid)
  if ('error' in ok) return c.json({ error: ok.error }, ok.status)
  const id = toInt(c.req.param('id'), 1)
  const f = id ? await findOffboardingFile(db, cid!, c.req.param('source'), id) : null
  if (!f) return c.json({ error: 'ファイルが見つかりません' }, 404)
  const bucket = offboardingBucket(c.env, f.bucket)
  const obj = bucket ? await bucket.get(f.r2_key) : null
  if (!obj) return c.json({ error: 'ファイルが見つかりません（R2 にありません）' }, 404)
  await offboardingEventStmt(db, { offboarding_id: ok.ob?.status === 'scheduled' ? ok.ob.offboarding_id : null, company_id: cid!, action: 'file', actor: c.get('user').user_id,
    detail: { source: f.source, id: f.id } }).run()
  const name = f.file_name || `${f.source}_${f.id}${/png/.test(obj.httpMetadata?.contentType || '') ? '.png' : '.jpg'}`
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
  })
})

// 削除（猶予を過ぎた企業だけ。会社コードと「削除する」の入力で確かめる）。1回の要求で処理できる量だけ進め、進み具合を返す。
// 書き出しをしていない場合は、書き出しをしない理由（企業が不要と回答した など）を求める
api.post('/hq/offboarding/:cid/delete', async (c) => {
  const db = c.env.DB
  const u = c.get('user')
  const cid = toInt(c.req.param('cid'), 1)
  const company = cid ? await offboardingCompany(db, cid) : null
  if (!cid || !company) return c.json({ error: '企業が見つかりません' }, 404)
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object') return c.json({ error: '入力内容が正しくありません' }, 400)
  let ob = await latestOffboarding(db, cid)
  if (!ob || !OFFBOARDING_STATUSES_OPEN.includes(ob.status)) return c.json({ error: '契約終了が登録されていません' }, 409)
  if (company.active_status !== 'inactive') return c.json({ error: '企業の利用状態が「停止」ではないため削除できません。再開した企業は、契約終了の登録を取り消してください' }, 409)
  if (!sameCompanyCode(b.confirm_company_code, company.company_code)) return c.json({ error: '確認のための会社コードが一致しません', field: 'confirm_company_code' }, 400)
  if (ob.status === 'scheduled') {
    const today = todayJST()
    if (today < ob.delete_after) return c.json({ error: `猶予期間中です。${ob.delete_after} から削除できます` }, 409)
    if (String(b.confirm_text ?? '').trim() !== OFFBOARDING_CONFIRM_TEXT) return c.json({ error: `確認のため「${OFFBOARDING_CONFIRM_TEXT}」と入力してください`, field: 'confirm_text' }, 400)
    const skipReason = typeof b.export_skip_reason === 'string' ? b.export_skip_reason.trim().slice(0, 500) : ''
    if (!skipReason && !await offboardingExported(db, cid)) {
      return c.json({ error: 'データを書き出していません。書き出してから削除するか、書き出しをしない理由を入力してください', field: 'export_skip_reason', code: 'not_exported' }, 409)
    }
    // 削除の一覧にない表が残っていると、削除の記録が実際と合わなくなるため始めない
    const unknown = await findUnknownOffboardingTables(db)
    if (unknown === null || unknown.length) {
      return c.json({ error: unknown === null ? '削除の対象に入っていない表があるかを確かめられませんでした。時間をおいて再度お試しください'
        : `削除の対象に入っていない、企業の行を持つ表があるため削除を始められません（開発者に確認してください）: ${unknown.join(', ')}`, code: 'unknown_tables' }, 409)
    }
    const now = new Date().toISOString()
    const r = await db.prepare(`UPDATE company_offboardings SET status = 'deleting', delete_started_by = ?, delete_started_at = ?, export_skip_reason = ?
      WHERE offboarding_id = ? AND status = 'scheduled'`).bind(u.user_id, now, skipReason || null, ob.offboarding_id).run()
    if (r.meta.changes) {
      await offboardingEventStmt(db, { offboarding_id: ob.offboarding_id, company_id: cid, action: 'delete_start', actor: u.user_id,
        detail: { export_skip_reason: skipReason || null } }).run()
    }
    ob = await latestOffboarding(db, cid)
    if (!ob || ob.status !== 'deleting') return c.json({ error: '状態が変わったため削除を始められませんでした。画面を読み直してください' }, 409)
  }
  const p = await runOffboardingDeletion(db, c.env, ob)
  if (p.error) await offboardingEventStmt(db, { offboarding_id: ob.offboarding_id, company_id: cid, action: 'delete_error', actor: u.user_id, detail: { step: p.step, error: p.error } }).run()
  if (p.done) await offboardingEventStmt(db, { offboarding_id: ob.offboarding_id, company_id: cid, action: 'complete', actor: u.user_id, detail: { deleted: p.deleted } }).run()
  return c.json(p)
})

// 削除の記録（削除の証明として企業に渡せる CSV）: 企業・契約終了・削除の日時と、対象ごとの削除・匿名化の件数と、操作の記録
const OFFBOARDING_EVENT_LABEL: Record<string, string> = { start: '契約終了の登録', cancel: '契約終了の取消', export: 'CSV の書き出し', file: 'ファイルの取得',
  delete_start: '削除の開始', delete_error: '削除の失敗', complete: '削除の完了' }
api.get('/hq/offboarding/:cid/record.csv', async (c) => {
  const db = c.env.DB
  const cid = toInt(c.req.param('cid'), 1)
  const company = cid ? await offboardingCompany(db, cid) : null
  if (!cid || !company) return c.json({ error: '企業が見つかりません' }, 404)
  const ob = await latestOffboarding(db, cid)
  if (!ob) return c.json({ error: '解約の処理の記録がありません' }, 404)
  const events = (await db.prepare(`SELECT e.action, e.detail, e.created_at, u.name AS actor_name FROM company_offboarding_events e
    LEFT JOIN users u ON u.user_id = e.actor_user_id WHERE e.offboarding_id = ? ORDER BY e.event_id`).bind(ob.offboarding_id).all()).results as any[]
  let deleted: Record<string, number> = {}
  try { deleted = JSON.parse(ob.deleted_json || '{}') || {} } catch { deleted = {} }
  const label = new Map(OFFBOARDING_TABLES.map(t => [t.target, t.label]))
  const extra: Record<string, string> = { anonymized_users: '利用者の匿名化', anonymized_staff: 'スタッフの匿名化', r2_photos: '写真（R2）', r2_documents: '書類（R2）', r2_contracts: '契約書類（R2）' }
  const rows: any[][] = [
    ['企業', '会社コード', company.company_code], ['企業', '会社名', company.company_name],
    ['契約終了', '状態', ob.status], ['契約終了', '契約終了日', ob.contract_end_date], ['契約終了', '猶予日数', ob.grace_days], ['契約終了', '削除できる日', ob.delete_after],
    ['削除', '開始', ob.delete_started_at], ['削除', '完了', ob.completed_at], ['削除', '書き出しをしない理由', ob.export_skip_reason],
    ...Object.entries(deleted).map(([k, n]) => ['件数', label.get(k) || extra[k] || k, n]),
    ...events.map(e => ['操作', `${e.created_at} ${OFFBOARDING_EVENT_LABEL[e.action] || e.action}（${e.actor_name || ''}）`, e.detail || '']),
  ]
  return csvResponse(`${company.company_code}_解約の記録.csv`, toCsv(['区分', '項目', '値'], rows))
})

export default api

