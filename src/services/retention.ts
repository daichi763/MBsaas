// データ保存期間ポリシーに基づく定期削除サービス。
//
// 対象と基準:
//   daily_reports              : work_date から3年
//   user_notifications         : created_at から2年（既存の notice_reads の保持期間に合わせる）
//   email_logs                 : created_at から1年（宛先のメールアドレスを含む送信記録。#240）
//   打刻修正申請・その操作履歴・通知メールの送信状態・報告設定（スタッフ別）とその変更履歴
//                              : 勤怠と同じく、スタッフの退職日から7年（docs/spec_attendance_correction.md 8章）
//   notice_read_staff_reports  : スタッフ別の既読率（人事評価の参考資料）も退職後7年（#437）
//   attendance_reports / shifts
//   evaluations / follow_logs
//   consultations / R2写真
//   報告用URLのトークン       : スタッフの退職日(users.retired_at)から7年
//   従業員データ（employee_records: 口座・住所・扶養・緊急連絡先・給与・保険番号）と過去の雇用期間
//   履歴書など（staff_documents）・入社時書類（employee_documents）と R2 のファイル
//   企業間チャット（roster_comments・既読位置）と連携の同意履歴（roster_consents）
//                              : 同じく退職後7年（#193 #228）。チャットのスレッドは稼働先の連携行の単位なので、
//                                連携行と所属元の行（source_staff_id / root_staff_id）のどちらかが対象になったら消す。
//                                同意履歴は連携行の単位で、連携行が対象になったら消す
//   本人情報（users・staff_profiles）: 退職後7年で匿名化する（#480）。請求の集計などから参照されるため行は残し、
//                                氏名を「退職者#staff_id」にして連絡先・生年月日・経歴・メモなどを消す。
//                                済んだ人は anonymized_at を付け、次の対象に選び直さない
//
// 退職者の安全策（#5 #50 #51）:
//   - 退職日が NULL（未設定・不明）のスタッフのデータは絶対に削除しない。
//   - 「退職日と最終稼働日の遅い方から7年」で判定する。退職日より後にシフトがある人は、
//     退職日の入力誤りの可能性があるため対象から外す（本部画面に「対象外」として出す）。
//   - 初めて対象になった人には猶予日数（RETENTION_GRACE_DAYS）を置き、その間は本部画面に
//     「次回削除予定」として出すだけにする。退職日を変えると猶予をやり直す。
//   - 1回のCronで処理する人数には上限があり、まだデータが残っている人だけを、
//     最後に処理を試みた日時の古い順に選ぶ（毎回同じ人ばかりにならないようにする）。
//   - R2 の写真・書類は D1 の削除が成功してから消す。キーは D1 の削除と同じ batch で retention_pending_r2 に
//     控えておき、R2 の削除に失敗したものは次回のCronで再試行する。
//   - 失敗したときは、どのスタッフで何が起きたかを retention_logs.error_message に残す（#234）。
//   - R2 は最大1000キーずつまとめて消し、1回のCronで消すファイル数に上限を置く。超えた分は retention_pending_r2 に
//     残して翌日に回し、上限に達したらそれ以降の人も次回に回す（#419）。
//
// 期限切れ・使用済みのトークン（パスワード再設定・報告用URL）は、データ保持とは別の定期処理（purgeExpiredTokens）で消す（#397）。

const DAILY_REPORTS_YEARS = 3
const RETIRED_YEARS = 7
const DAILY_REPORTS_BATCH = 500
const DAILY_REPORTS_MAX_BATCHES = 20
const STAFF_BATCH = 20 // 1回のCronで処理する退職スタッフの上限人数
const NOTIFICATIONS_YEARS = 2
const NOTIFICATIONS_BATCH = 500
const NOTIFICATIONS_MAX_BATCHES = 20
const EMAIL_LOGS_YEARS = 1
const R2_DELETE_CHUNK = 1000 // R2 の delete に1回で渡すキーの数（R2 の上限）
const R2_DELETE_BUDGET = 5000 // 1回のCronで消す R2 の写真・書類の上限（超えた分は翌日に回す。#419）
const DRY_RUN_STAFF_LIMIT = 300 // dry-run で一覧に出す対象スタッフの上限
/** 初めて削除対象になってから実際に削除するまでの猶予日数 */
export const RETENTION_GRACE_DAYS = 7
// 退職スタッフに紐づく打刻修正・報告設定のデータ（勤怠と同じ「退職後7年」）
const RETIRED_EXTRA_TARGETS = ['attendance_corrections', 'attendance_correction_events', 'notification_emails', 'report_setting_logs', 'project_staff_report_settings',
  'notice_read_staff_reports']
// 退職スタッフの人事データ・書類・企業間チャット・同意履歴と、本人情報の匿名化（#193 #228 #480）
const RETIRED_PERSONAL_TARGETS = ['employee_records', 'employment_periods', 'staff_documents', 'employee_documents', 'r2_documents',
  'roster_comments', 'roster_comment_reads', 'roster_consents', 'anonymized_staff']
// retired_staff は人数（対象の人・処理できた人・失敗した人）。スタッフ単位の失敗の理由はここに残す（#234）
// retired_staff_deferred・r2_pending は、上限に達して翌日に回した人数と R2 のファイル数（#419）
const RETIRED_TARGETS = ['retired_staff', 'attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations', 'shift_report_tokens', 'r2_photos',
  ...RETIRED_EXTRA_TARGETS, ...RETIRED_PERSONAL_TARGETS, 'retired_staff_deferred', 'r2_pending']
// 件数の単位が行数でない対象（実行ログの合計に含めない）
export const RETENTION_NON_ROW_TARGETS = ['retired_staff', 'retired_staff_deferred', 'r2_pending']
const MAX_ERRORS_PER_TARGET = 3 // error_message に残す失敗の理由の件数（それ以上は件数だけ）
// 匿名化で消す staff_profiles の個人情報の列（所属区分・連携の情報・評価の点数は集計に使うので残す）
const ANONYMIZE_PROFILE_COLUMNS = ['career', 'skills', 'work_area', 'age_group', 'memo', 'affiliation_contact', 'kana', 'gender', 'date_of_birth',
  'nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from', 'site_evaluation', 'work_memo', 'career_rows', 'pr_points',
  'remarks', 'unverified_email']

function nowJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}
function todayJST(): string {
  return nowJST().slice(0, 10)
}
function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
function isValidYmd(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

// ============ 退職日の検証（#5 #34） ============
/**
 * 退職日が効力を持つか（退職扱いにしてログインを止めるか）。
 * 退職日の当日までは在籍（ログイン可）とし、翌日から退職とする。今日以降の日付は「退職予定」。
 */
export function isRetirementEffective(retiredAt: string, today: string = todayJST()): boolean {
  return retiredAt < today
}

export type RetiredAtCheck =
  | { ok: true; value: string | null; scheduled: boolean }
  | { ok: false; error: string; confirm?: boolean }

/**
 * 退職日の入力を確認する。
 *  - 空なら null（退職日を消す）
 *  - YYYY-MM-DD の実在する日付であること
 *  - 次の場合は誤入力のおそれがあるので確認（confirmed=true で送り直し）を求める:
 *      7年以上前（保存すると定期削除の対象になる）／1年以上前／入社日より前／退職日より後にシフトがある
 *  - 今日以降の日付は退職予定（scheduled=true）
 */
export function validateRetiredAt(
  v: unknown,
  opts: { today?: string; confirmed?: boolean; hireDate?: string | null; lastWorkDate?: string | null } = {},
): RetiredAtCheck {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null, scheduled: false }
  const value = typeof v === 'string' ? v.trim() : ''
  if (!isValidYmd(value)) return { ok: false, error: '退職日は YYYY-MM-DD 形式の正しい日付で入力してください' }
  const today = opts.today || todayJST()
  if (!opts.confirmed) {
    const [y, m, d] = today.split('-')
    const yearsAgo = (n: number) => `${Number(y) - n}-${m}-${d}`
    if (value <= yearsAgo(RETIRED_YEARS)) {
      return { ok: false, confirm: true, error: `退職日 ${value} は${RETIRED_YEARS}年以上前の日付です。保存すると定期削除の対象になり、猶予期間（${RETENTION_GRACE_DAYS}日）の後に、このスタッフの出退勤記録・シフト・写真・評価・相談・従業員データ・書類などが元に戻せない形で削除され、氏名・連絡先などの本人情報は匿名化されます。日付に誤りがないか確認してください。` }
    }
    if (value < yearsAgo(1)) return { ok: false, confirm: true, error: `退職日 ${value} は1年以上前の日付です。日付に誤りがないか確認してください。` }
    if (opts.hireDate && value < String(opts.hireDate).slice(0, 10)) {
      return { ok: false, confirm: true, error: `退職日 ${value} が入社日 ${String(opts.hireDate).slice(0, 10)} より前です。日付に誤りがないか確認してください。` }
    }
    if (opts.lastWorkDate && value < String(opts.lastWorkDate).slice(0, 10)) {
      return { ok: false, confirm: true, error: `退職日 ${value} より後の ${String(opts.lastWorkDate).slice(0, 10)} にシフトがあります。日付に誤りがないか、シフトが残っていないか確認してください。` }
    }
  }
  return { ok: true, value, scheduled: !isRetirementEffective(value, today) }
}

/**
 * 退職予定日を過ぎたスタッフを退職（ログイン停止）に切り替える（毎日の cron から呼ぶ。#34）。
 * 退職日の当日までは在籍とし、翌日に切り替える。あわせてその人のセッションを削除する。
 */
export async function applyDueRetirements(db: D1Database): Promise<number> {
  const due = `SELECT user_id FROM users WHERE retired_at IS NOT NULL AND length(retired_at) >= 10 AND retired_at < ? AND status = 'active'
    AND user_id IN (SELECT user_id FROM staff_profiles)`
  const today = todayJST()
  const r = await db.batch([
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${due})`).bind(today),
    db.prepare(`UPDATE staff_profiles SET employment_status = 'retired' WHERE user_id IN (${due})`).bind(today),
    db.prepare(`UPDATE users SET status = 'suspended' WHERE user_id IN (${due})`).bind(today),
  ])
  return r[2].meta.changes || 0
}

// ============ 定期削除の対象（退職後7年） ============
// 対象の退職スタッフを選ぶサブクエリ（バインド: cutoff 1個）。
// 退職日より後のシフトがある人は外すので、残る人の最終稼働日は退職日以前になり、
// 「退職日と最終稼働日の遅い方から7年」＝「退職日から7年」になる。
// 退職日（sp・u を参照する）。他社連携の行（linked_external）で自分の行に退職日がなければ、雇用元の行の退職日を使う（#127）。
// 連携行には所属元の退職日を伝えている（roster.ts の propagateRetirementStmts・0041 の移行）が、伝わっていない行も対象にする
const STAFF_RETIRED_AT_SQL = `COALESCE(u.retired_at, CASE WHEN sp.affiliation_type = 'linked_external' THEN (SELECT ru.retired_at FROM staff_profiles r
    JOIN users ru ON ru.user_id = r.user_id WHERE r.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)) END)`
const ELIGIBLE_STAFF_SQL = `SELECT x.staff_id FROM (SELECT sp.staff_id, ${STAFF_RETIRED_AT_SQL} AS retired_at
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id) x
  WHERE x.retired_at IS NOT NULL AND length(x.retired_at) >= 10 AND x.retired_at <= ?
    AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = x.staff_id AND s.work_date > x.retired_at)`
// その人を所属元とする連携行（企業間チャットのスレッドの単位）。多段連携の先の行も root_staff_id で含める
function linkedRowsOf(staffIdExpr: string): string {
  return `SELECT l.staff_id FROM staff_profiles l WHERE l.affiliation_type = 'linked_external'
    AND (l.source_staff_id = ${staffIdExpr} OR l.root_staff_id = ${staffIdExpr})`
}
// まだ削除・匿名化すべきデータが残っているか（sp.staff_id を参照する）。匿名化が済むまでは残っているものとして扱う
const HAS_DATA_SQL = `(sp.anonymized_at IS NULL
    OR EXISTS (SELECT 1 FROM shifts WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM attendance_reports WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM evaluations WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM follow_logs WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM consultations WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM shift_report_tokens WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM attendance_corrections WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM report_setting_logs WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM project_staff_report_settings WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM notice_read_staff_reports WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM employee_records WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM employment_periods WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM staff_documents WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM employee_documents WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM roster_comments WHERE thread_staff_id = sp.staff_id OR thread_staff_id IN (${linkedRowsOf('sp.staff_id')}))
    OR EXISTS (SELECT 1 FROM roster_consents WHERE staff_id = sp.staff_id OR (source_staff_id = sp.staff_id AND staff_id IS NULL)))`

export type RetentionScheduleRow = {
  staff_id: number; name: string; company_name: string; retired_at: string
  last_work_date: string | null; flagged_at: string | null; delete_on: string | null
}
/**
 * 本部画面の「次回削除予定」と「対象外（退職日より後にシフトあり）」の一覧。
 * delete_on は猶予が明けて削除できるようになる日（まだ猶予が始まっていなければ null）。
 */
export async function listRetentionSchedule(db: D1Database): Promise<{ scheduled: RetentionScheduleRow[]; excluded: RetentionScheduleRow[]; grace_days: number
  next_run_date: string; next_run_count: number; next_run_due: number; staff_batch: number }> {
  const cutoff = cutoffDate(RETIRED_YEARS)
  const cols = `sp.staff_id, u.name, c.company_name, ${STAFF_RETIRED_AT_SQL} AS retired_at, sp.retention_flagged_at AS flagged_at,
    (SELECT MAX(work_date) FROM shifts WHERE staff_id = sp.staff_id) AS last_work_date
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id LEFT JOIN companies c ON c.company_id = sp.company_id`
  const scheduled = (await db.prepare(`SELECT ${cols}
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL}
    ORDER BY sp.retention_flagged_at IS NULL, sp.retention_flagged_at, retired_at, sp.staff_id LIMIT 200`).bind(cutoff).all()).results as any[]
  const excluded = (await db.prepare(`SELECT * FROM (SELECT ${cols}) x
    WHERE x.retired_at IS NOT NULL AND length(x.retired_at) >= 10 AND x.retired_at <= ?
      AND EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = x.staff_id AND s.work_date > x.retired_at)
    ORDER BY x.retired_at, x.staff_id LIMIT 100`).bind(cutoff).all()).results as any[]
  // 次の定期削除（毎日 日本時間3:00）で削除する人数（猶予が明けている人。1回の上限は STAFF_BATCH 人。#365）
  const nowJ = nowJST()
  const nextRunDate = nowJ.slice(11, 13) < '03' ? nowJ.slice(0, 10) : addDays(nowJ.slice(0, 10), 1)
  const due = await db.prepare(`SELECT COUNT(*) AS n FROM staff_profiles sp
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND sp.retention_flagged_at IS NOT NULL AND sp.retention_flagged_at <= ? AND ${HAS_DATA_SQL}`)
    .bind(cutoff, addDays(nextRunDate, -RETENTION_GRACE_DAYS)).first() as { n: number } | null
  const nextRunDue = Number(due?.n) || 0
  return {
    scheduled: scheduled.map(r => ({ ...r, delete_on: r.flagged_at ? addDays(r.flagged_at, RETENTION_GRACE_DAYS) : null })),
    excluded: excluded.map(r => ({ ...r, delete_on: null })),
    grace_days: RETENTION_GRACE_DAYS,
    next_run_date: nextRunDate,
    next_run_due: nextRunDue,
    next_run_count: Math.min(nextRunDue, STAFF_BATCH),
    staff_batch: STAFF_BATCH,
  }
}

export type RetentionTargetResult = {
  target: string
  targetCount: number
  deletedCount: number
  failedCount: number
  error?: string
  errorCount?: number // 失敗の理由の件数（集計中だけ使う）
}
export type RetentionRunResult = {
  dryRun: boolean
  results: RetentionTargetResult[]
  startedAt: string
  finishedAt: string
  detail?: Awaited<ReturnType<typeof dryRunRetiredStaffDetail>> // 本部画面の dry-run の内訳（#365）
  detailError?: string
}

function cutoffDate(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  return d.toISOString().slice(0, 10)
}

async function cleanupDailyReports(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  const cutoff = cutoffDate(DAILY_REPORTS_YEARS)

  if (dryRun) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM daily_reports WHERE work_date < ?').bind(cutoff).first()
    return { target: 'daily_reports', targetCount: (row?.n as number) || 0, deletedCount: 0, failedCount: 0 }
  }

  let deleted = 0
  try {
    for (let i = 0; i < DAILY_REPORTS_MAX_BATCHES; i++) {
      const result = await db.prepare(
        `DELETE FROM daily_reports WHERE daily_report_id IN (SELECT daily_report_id FROM daily_reports WHERE work_date < ? LIMIT ?)`
      ).bind(cutoff, DAILY_REPORTS_BATCH).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes < DAILY_REPORTS_BATCH) break
    }
    return { target: 'daily_reports', targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: daily_reports cleanup failed after deleting ${deleted}: ${e}`)
    return { target: 'daily_reports', targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e) }
  }
}

// 作成日時から一定年数たった行を、件数を区切って消す（user_notifications・email_logs で共用）。
// created_at は CURRENT_TIMESTAMP（YYYY-MM-DD HH:MM:SS）か ISO 8601 で、どちらも YYYY-MM-DD との文字列比較で判定できる
async function cleanupByCreatedAt(db: D1Database, dryRun: boolean, t: { target: string; table: string; idCol: string; years: number }): Promise<RetentionTargetResult> {
  const cutoff = cutoffDate(t.years)
  if (dryRun) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE created_at < ?`).bind(cutoff).first()
    return { target: t.target, targetCount: (row?.n as number) || 0, deletedCount: 0, failedCount: 0 }
  }
  let deleted = 0
  try {
    for (let i = 0; i < NOTIFICATIONS_MAX_BATCHES; i++) {
      const result = await db.prepare(
        `DELETE FROM ${t.table} WHERE ${t.idCol} IN (SELECT ${t.idCol} FROM ${t.table} WHERE created_at < ? LIMIT ?)`
      ).bind(cutoff, NOTIFICATIONS_BATCH).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes < NOTIFICATIONS_BATCH) break
    }
    return { target: t.target, targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: ${t.target} cleanup failed after deleting ${deleted}: ${e}`)
    return { target: t.target, targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e) }
  }
}
function cleanupUserNotifications(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  return cleanupByCreatedAt(db, dryRun, { target: 'user_notifications', table: 'user_notifications', idCol: 'notification_id', years: NOTIFICATIONS_YEARS })
}
// メールの送信記録（宛先のメールアドレスを含む）は1年で消す（#240）
function cleanupEmailLogs(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  return cleanupByCreatedAt(db, dryRun, { target: 'email_logs', table: 'email_logs', idCol: 'log_id', years: EMAIL_LOGS_YEARS })
}

function emptyRetiredAcc(): Record<string, RetentionTargetResult> {
  const acc: Record<string, RetentionTargetResult> = {}
  for (const t of RETIRED_TARGETS) acc[t] = { target: t, targetCount: 0, deletedCount: 0, failedCount: 0 }
  return acc
}

// 失敗の理由を残す（最初の数件だけ文言を残し、それ以上は件数だけ数える。#234）
function noteError(r: RetentionTargetResult, msg: string): void {
  const m = msg.slice(0, 300)
  const n = (r.errorCount || 0) + 1
  r.errorCount = n
  if (n <= MAX_ERRORS_PER_TARGET) r.error = r.error ? `${r.error} / ${m}` : m
}
function errorMessageOf(r: RetentionTargetResult): string | null {
  if (!r.error) return null
  const more = (r.errorCount || 0) - MAX_ERRORS_PER_TARGET
  return (more > 0 ? `${r.error} / ほか${more}件` : r.error).slice(0, 1000)
}

// 削除の候補になった人に猶予の開始日を付け、対象から外れた人（退職日の変更など）の印を外す
async function markRetentionCandidates(db: D1Database, cutoff: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE staff_profiles SET retention_flagged_at = NULL
      WHERE retention_flagged_at IS NOT NULL AND staff_id NOT IN (${ELIGIBLE_STAFF_SQL})`).bind(cutoff),
    db.prepare(`UPDATE staff_profiles SET retention_flagged_at = ?
      WHERE retention_flagged_at IS NULL AND staff_id IN (SELECT sp.staff_id FROM staff_profiles sp WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL})`).bind(todayJST(), cutoff),
  ])
}

// 猶予が明け、まだデータが残っている（または匿名化が済んでいない）人を、最後に処理を試みた日時の古い順に選ぶ
async function getEligibleRetiredStaffIds(db: D1Database, cutoff: string, limit: number): Promise<number[]> {
  const graceCutoff = addDays(todayJST(), -RETENTION_GRACE_DAYS)
  const rows = await db.prepare(
    `SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
     WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND sp.retention_flagged_at IS NOT NULL AND sp.retention_flagged_at <= ?
       AND ${HAS_DATA_SQL}
     ORDER BY sp.retention_attempted_at IS NOT NULL, sp.retention_attempted_at, u.retired_at, sp.staff_id LIMIT ?`
  ).bind(cutoff, graceCutoff, limit).all()
  return (rows.results as { staff_id: number }[]).map(r => r.staff_id)
}

// 対象件数の確認（削除はしない）。対象者の ID を IN 句に並べず、サブクエリで数える（D1 のバインド上限を避ける。#436）
async function dryRunRetiredStaffData(db: D1Database): Promise<Record<string, RetentionTargetResult>> {
  const acc = emptyRetiredAcc()
  const cutoff = cutoffDate(RETIRED_YEARS)
  const retired = ELIGIBLE_STAFF_SQL
  // バインドは cutoff の1個だけにするため、対象者を WITH で1回だけ書く
  const withRetired = `WITH r AS (${retired})`
  const linkedOfRetired = `SELECT l.staff_id FROM staff_profiles l WHERE l.affiliation_type = 'linked_external'
    AND (l.source_staff_id IN (SELECT staff_id FROM r) OR l.root_staff_id IN (SELECT staff_id FROM r))`
  const threadsOfRetired = `(thread_staff_id IN (SELECT staff_id FROM r) OR thread_staff_id IN (${linkedOfRetired}))`
  const counts: Record<string, string> = {
    retired_staff: `SELECT COUNT(*) AS n FROM staff_profiles sp WHERE sp.staff_id IN (${retired}) AND ${HAS_DATA_SQL}`,
    attendance_reports: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${retired})`,
    shifts: `SELECT COUNT(*) AS n FROM shifts WHERE staff_id IN (${retired})`,
    evaluations: `SELECT COUNT(*) AS n FROM evaluations WHERE staff_id IN (${retired})`,
    follow_logs: `SELECT COUNT(*) AS n FROM follow_logs WHERE staff_id IN (${retired})`,
    consultations: `SELECT COUNT(*) AS n FROM consultations WHERE staff_id IN (${retired})`,
    shift_report_tokens: `SELECT COUNT(*) AS n FROM shift_report_tokens WHERE staff_id IN (${retired})`,
    r2_photos: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${retired}) AND photo_key IS NOT NULL`,
    attendance_corrections: `SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id IN (${retired})`,
    attendance_correction_events: `SELECT COUNT(*) AS n FROM attendance_correction_events WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id IN (${retired}))`,
    notification_emails: `SELECT COUNT(*) AS n FROM notification_emails WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id IN (${retired}))`,
    report_setting_logs: `SELECT COUNT(*) AS n FROM report_setting_logs WHERE staff_id IN (${retired})`,
    project_staff_report_settings: `SELECT COUNT(*) AS n FROM project_staff_report_settings WHERE staff_id IN (${retired})`,
    notice_read_staff_reports: `SELECT COUNT(*) AS n FROM notice_read_staff_reports WHERE staff_id IN (${retired})`,
    employee_records: `SELECT COUNT(*) AS n FROM employee_records WHERE staff_id IN (${retired})`,
    employment_periods: `SELECT COUNT(*) AS n FROM employment_periods WHERE staff_id IN (${retired})`,
    staff_documents: `SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id IN (${retired})`,
    employee_documents: `SELECT COUNT(*) AS n FROM employee_documents WHERE staff_id IN (${retired})`,
    r2_documents: `${withRetired} SELECT (SELECT COUNT(*) FROM staff_documents WHERE staff_id IN (SELECT staff_id FROM r))
      + (SELECT COUNT(*) FROM employee_documents WHERE staff_id IN (SELECT staff_id FROM r)) AS n`,
    roster_comments: `${withRetired} SELECT COUNT(*) AS n FROM roster_comments WHERE ${threadsOfRetired}`,
    roster_comment_reads: `${withRetired} SELECT COUNT(*) AS n FROM roster_comment_reads WHERE ${threadsOfRetired}`,
    roster_consents: `${withRetired} SELECT COUNT(*) AS n FROM roster_consents WHERE staff_id IN (SELECT staff_id FROM r) OR (source_staff_id IN (SELECT staff_id FROM r) AND staff_id IS NULL)`,
    anonymized_staff: `SELECT COUNT(*) AS n FROM staff_profiles WHERE staff_id IN (${retired}) AND anonymized_at IS NULL`,
    // 前回までに消せず、次回に消す R2 のファイル（バインドの数をそろえるため ? を置く）
    r2_pending: `SELECT COUNT(*) AS n FROM retention_pending_r2 WHERE ? IS NOT NULL`,
  }
  for (const [t, sql] of Object.entries(counts)) {
    try {
      const row = await db.prepare(sql).bind(cutoff).first()
      acc[t].targetCount = (row?.n as number) || 0
    } catch (e) {
      acc[t].failedCount = 1; noteError(acc[t], `集計に失敗: ${e}`)
    }
  }
  return acc
}

export type RetentionDryRunStaff = {
  staff_id: number; name: string; company_id: number | null; company_name: string | null; retired_at: string
  last_work_date: string | null; last_report_date: string | null; flagged_at: string | null; delete_on: string | null
  report_after_retired: boolean; counts: Record<string, number>
}
export type RetentionDryRunCompany = { company_id: number | null; company_name: string | null; staff_count: number; counts: Record<string, number> }
// 退職者ごとに数える対象（列名 → 数える SQL。sp.staff_id を参照する）
const DRY_RUN_STAFF_COUNTS: Record<string, string> = {
  shifts: 'SELECT COUNT(*) FROM shifts WHERE staff_id = sp.staff_id',
  attendance_reports: 'SELECT COUNT(*) FROM attendance_reports WHERE staff_id = sp.staff_id',
  r2_photos: 'SELECT COUNT(*) FROM attendance_reports WHERE staff_id = sp.staff_id AND photo_key IS NOT NULL',
  evaluations: 'SELECT COUNT(*) FROM evaluations WHERE staff_id = sp.staff_id',
  follow_logs: 'SELECT COUNT(*) FROM follow_logs WHERE staff_id = sp.staff_id',
  consultations: 'SELECT COUNT(*) FROM consultations WHERE staff_id = sp.staff_id',
  attendance_corrections: 'SELECT COUNT(*) FROM attendance_corrections WHERE staff_id = sp.staff_id',
  employee_records: 'SELECT COUNT(*) FROM employee_records WHERE staff_id = sp.staff_id',
  documents: '(SELECT COUNT(*) FROM staff_documents WHERE staff_id = sp.staff_id) + (SELECT COUNT(*) FROM employee_documents WHERE staff_id = sp.staff_id)',
  roster_comments: `SELECT COUNT(*) FROM roster_comments WHERE thread_staff_id = sp.staff_id OR thread_staff_id IN (${linkedRowsOf('sp.staff_id')})`,
  notice_read_staff_reports: 'SELECT COUNT(*) FROM notice_read_staff_reports WHERE staff_id = sp.staff_id',
}

/**
 * dry-run の内訳: 次の定期削除の対象になる退職者を、会社別の件数と、人ごとの一覧（会社・氏名・退職日・最終稼働日・
 * テーブルごとの件数）で返す（#365）。猶予中の人も含む。退職日より後に勤怠の報告がある人には印を付ける
 * （退職日より後にシフトがある人は、元から対象外）。対象者は IN 句に並べず、サブクエリで選ぶ（バインドは cutoff の1個）
 */
export async function dryRunRetiredStaffDetail(db: D1Database): Promise<{ staff: RetentionDryRunStaff[]; staff_total: number; companies: RetentionDryRunCompany[] }> {
  const cutoff = cutoffDate(RETIRED_YEARS)
  const countCols = Object.entries(DRY_RUN_STAFF_COUNTS).map(([k, sql]) => `(${sql}) AS c_${k}`).join(',\n      ')
  const base = `SELECT sp.staff_id, u.name, sp.company_id, c.company_name, ${STAFF_RETIRED_AT_SQL} AS retired_at, sp.retention_flagged_at AS flagged_at,
      (SELECT MAX(work_date) FROM shifts WHERE staff_id = sp.staff_id) AS last_work_date,
      (SELECT MAX(substr(reported_at, 1, 10)) FROM attendance_reports WHERE staff_id = sp.staff_id) AS last_report_date,
      ${countCols}
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id LEFT JOIN companies c ON c.company_id = sp.company_id
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL}`
  const rows = (await db.prepare(`SELECT * FROM (${base}) x ORDER BY x.company_id, x.retired_at, x.staff_id LIMIT ?`)
    .bind(cutoff, DRY_RUN_STAFF_LIMIT).all()).results as any[]
  const sums = Object.keys(DRY_RUN_STAFF_COUNTS).map(k => `SUM(x.c_${k}) AS c_${k}`).join(', ')
  const companyRows = (await db.prepare(`SELECT x.company_id, MAX(x.company_name) AS company_name, COUNT(*) AS staff_count, ${sums}
    FROM (${base}) x GROUP BY x.company_id ORDER BY staff_count DESC, x.company_id`).bind(cutoff).all()).results as any[]
  const countsOf = (r: any) => Object.fromEntries(Object.keys(DRY_RUN_STAFF_COUNTS).map(k => [k, Number(r[`c_${k}`]) || 0]))
  return {
    staff: rows.map(r => ({
      staff_id: r.staff_id, name: r.name, company_id: r.company_id, company_name: r.company_name, retired_at: r.retired_at,
      last_work_date: r.last_work_date, last_report_date: r.last_report_date, flagged_at: r.flagged_at,
      delete_on: r.flagged_at ? addDays(r.flagged_at, RETENTION_GRACE_DAYS) : null,
      report_after_retired: !!(r.last_report_date && r.retired_at && r.last_report_date > String(r.retired_at).slice(0, 10)),
      counts: countsOf(r),
    })),
    staff_total: companyRows.reduce((a, r) => a + (Number(r.staff_count) || 0), 0),
    companies: companyRows.map(r => ({ company_id: r.company_id, company_name: r.company_name, staff_count: Number(r.staff_count) || 0, counts: countsOf(r) })),
  }
}

export type RetentionBuckets = { PHOTOS: R2Bucket; DOCUMENTS?: R2Bucket }
type PendingBucket = 'photos' | 'documents'

// 1回のCronで R2 から消せる残りのファイル数（#419）
type R2Budget = { left: number }

// R2 のファイルを消し、消せたキーを retention_pending_r2 から外す（消せなかったキー・上限を超えたキーは
// retention_pending_r2 に残り、次回に再試行する）。R2 の delete は1回で最大1000キーをまとめて消せるので、
// 1件ずつ呼ばずに配列で渡す（呼び出し回数の上限に当たらないようにする。#419）
async function deleteR2Files(db: D1Database, buckets: RetentionBuckets, kind: PendingBucket, keys: string[], acc: Record<string, RetentionTargetResult>, budget: R2Budget): Promise<void> {
  const r = acc[kind === 'documents' ? 'r2_documents' : 'r2_photos']
  const bucket = kind === 'documents' ? buckets.DOCUMENTS : buckets.PHOTOS
  const take = keys.slice(0, Math.max(0, budget.left))
  if (!take.length) return
  budget.left -= take.length
  r.targetCount += take.length
  if (!bucket) {
    r.failedCount += take.length
    noteError(r, `R2 のバケット（${kind === 'documents' ? 'DOCUMENTS' : 'PHOTOS'}）が設定されていないため ${take.length}件を消せませんでした（次回再試行）`)
    return
  }
  for (let i = 0; i < take.length; i += R2_DELETE_CHUNK) {
    const chunk = take.slice(i, i + R2_DELETE_CHUNK)
    try {
      await bucket.delete(chunk)
    } catch (e) {
      r.failedCount += chunk.length
      noteError(r, `R2 の削除に失敗 ${chunk.length}件（次回再試行）: ${e}`)
      continue
    }
    r.deletedCount += chunk.length
    // 消せたキーは json_each で1文にまとめて控えから外す（バインドは1個）
    await db.prepare('DELETE FROM retention_pending_r2 WHERE photo_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(chunk)).run()
  }
}

async function cleanupRetiredStaffData(db: D1Database, buckets: RetentionBuckets): Promise<Record<string, RetentionTargetResult>> {
  const acc = emptyRetiredAcc()
  const cutoff = cutoffDate(RETIRED_YEARS)

  const budget: R2Budget = { left: R2_DELETE_BUDGET }
  // 前回までに消せなかった（上限で翌日に回した）R2 の写真・書類を消し直す
  try {
    const rows = (await db.prepare('SELECT photo_key, bucket FROM retention_pending_r2 ORDER BY created_at LIMIT ?').bind(budget.left).all()).results as { photo_key: string; bucket: string | null }[]
    const docs = rows.filter(r => r.bucket === 'documents').map(r => r.photo_key)
    const photos = rows.filter(r => r.bucket !== 'documents').map(r => r.photo_key)
    if (photos.length) await deleteR2Files(db, buckets, 'photos', photos, acc, budget)
    if (docs.length) await deleteR2Files(db, buckets, 'documents', docs, acc, budget)
  } catch (e) {
    console.log(`retention: R2 retry failed: ${e}`)
    acc.r2_photos.failedCount++; noteError(acc.r2_photos, `R2 の再試行に失敗: ${e}`)
  }

  await markRetentionCandidates(db, cutoff)
  const staffIds = await getEligibleRetiredStaffIds(db, cutoff, STAFF_BATCH)
  acc.retired_staff.targetCount = staffIds.length

  // そのスタッフのシフトに付いた行も対象にする（shifts を消すときの外部キー違反を防ぐ。#51）
  const ofShifts = 'shift_id IN (SELECT shift_id FROM shifts WHERE staff_id = ?)'
  // 企業間チャットのスレッド: その人の行（連携行ならそれ自体がスレッド）と、その人を所属元とする連携行（#228）
  const ofThreads = `(thread_staff_id = ? OR thread_staff_id IN (${linkedRowsOf('?')}))`
  const userOf = '(SELECT user_id FROM staff_profiles WHERE staff_id = ?)'
  const anonymizeCols = ANONYMIZE_PROFILE_COLUMNS.map(col => `${col} = NULL`).join(', ')
  for (const [idx, staffId] of staffIds.entries()) {
    // R2 の上限を使い切ったら、残りの人は処理を試みずに次回へ回す（retention_attempted_at を付けないので次回の先頭に来る）
    if (budget.left <= 0) {
      acc.retired_staff_deferred.targetCount = staffIds.length - idx
      break
    }
    try {
      await db.prepare('UPDATE staff_profiles SET retention_attempted_at = ? WHERE staff_id = ?').bind(nowJST(), staffId).run()
      const fileRows = (await db.prepare(
        `SELECT photo_key AS k, 'photos' AS b FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts}) AND photo_key IS NOT NULL
         UNION ALL SELECT storage_key, 'documents' FROM staff_documents WHERE staff_id = ?
         UNION ALL SELECT storage_key, 'documents' FROM employee_documents WHERE staff_id = ?`
      ).bind(staffId, staffId, staffId, staffId).all()).results as { k: string; b: PendingBucket }[]
      const photoKeys = fileRows.filter(r => r.b === 'photos').map(r => r.k)
      const docKeys = fileRows.filter(r => r.b === 'documents').map(r => r.k)

      // 1. D1 側を1つの batch（トランザクション）で削除・匿名化する。写真・書類のキーは同じ batch で控えておく。
      //    attendance_reports・shift_report_tokens は shifts を参照しているため先に削除する
      const steps: [string | null, D1PreparedStatement][] = [
        [null, db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
          SELECT photo_key, ?, 'photos' FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts}) AND photo_key IS NOT NULL`).bind(staffId, staffId, staffId)],
        [null, db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
          SELECT storage_key, ?, 'documents' FROM staff_documents WHERE staff_id = ?
          UNION ALL SELECT storage_key, ?, 'documents' FROM employee_documents WHERE staff_id = ?`).bind(staffId, staffId, staffId, staffId)],
        ['shift_report_tokens', db.prepare(`DELETE FROM shift_report_tokens WHERE staff_id = ? OR ${ofShifts}`).bind(staffId, staffId)],
        ['attendance_reports', db.prepare(`DELETE FROM attendance_reports WHERE staff_id = ? OR ${ofShifts}`).bind(staffId, staffId)],
        ['shifts', db.prepare('DELETE FROM shifts WHERE staff_id = ?').bind(staffId)],
        ['evaluations', db.prepare('DELETE FROM evaluations WHERE staff_id = ?').bind(staffId)],
        ['follow_logs', db.prepare('DELETE FROM follow_logs WHERE staff_id = ?').bind(staffId)],
        ['consultations', db.prepare('DELETE FROM consultations WHERE staff_id = ?').bind(staffId)],
        // 打刻修正の操作履歴・通知メールは申請より先に消す（申請 ID で対象を特定するため）
        ['attendance_correction_events', db.prepare('DELETE FROM attendance_correction_events WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId)],
        ['notification_emails', db.prepare('DELETE FROM notification_emails WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId)],
        ['attendance_corrections', db.prepare('DELETE FROM attendance_corrections WHERE staff_id = ?').bind(staffId)],
        ['report_setting_logs', db.prepare('DELETE FROM report_setting_logs WHERE staff_id = ?').bind(staffId)],
        ['project_staff_report_settings', db.prepare('DELETE FROM project_staff_report_settings WHERE staff_id = ?').bind(staffId)],
        // スタッフ別の既読率（人事評価の参考資料。会社全体の notice_read_reports は個人を含まない集計なので残す。#437）
        ['notice_read_staff_reports', db.prepare('DELETE FROM notice_read_staff_reports WHERE staff_id = ?').bind(staffId)],
        // 従業員データ（口座・住所・給与・緊急連絡先など）・過去の雇用期間・書類（#193）
        ['employee_records', db.prepare('DELETE FROM employee_records WHERE staff_id = ?').bind(staffId)],
        ['employment_periods', db.prepare('DELETE FROM employment_periods WHERE staff_id = ?').bind(staffId)],
        ['staff_documents', db.prepare('DELETE FROM staff_documents WHERE staff_id = ?').bind(staffId)],
        ['employee_documents', db.prepare('DELETE FROM employee_documents WHERE staff_id = ?').bind(staffId)],
        // 企業間チャットと連携の同意履歴（#228）
        ['roster_comment_reads', db.prepare(`DELETE FROM roster_comment_reads WHERE ${ofThreads}`).bind(staffId, staffId, staffId)],
        ['roster_comments', db.prepare(`DELETE FROM roster_comments WHERE ${ofThreads}`).bind(staffId, staffId, staffId)],
        // 同意履歴は連携行（staff_id）の単位で消す。所属元の行が対象になっても、連携先の行が残っている間は連携の根拠として残す
        ['roster_consents', db.prepare('DELETE FROM roster_consents WHERE staff_id = ? OR (source_staff_id = ? AND staff_id IS NULL)').bind(staffId, staffId)],
        // 本人情報の匿名化（#480）。ログインに使えないようにし、セッションと再設定のリンクも消す。
        // users はスタッフ本人の行（staff / roster_only）だけを匿名化する（管理者の行は変えない）
        [null, db.prepare(`DELETE FROM sessions WHERE user_id = ${userOf}`).bind(staffId)],
        [null, db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ${userOf}`).bind(staffId)],
        [null, db.prepare(`UPDATE users SET name = ?, email = NULL, phone = NULL, password_hash = '!anonymized', status = 'suspended'
          WHERE user_id = ${userOf} AND role IN ('staff', 'roster_only')`).bind(`退職者#${staffId}`, staffId)],
        ['anonymized_staff', db.prepare(`UPDATE staff_profiles SET ${anonymizeCols}, anonymized_at = ? WHERE staff_id = ? AND anonymized_at IS NULL`).bind(nowJST(), staffId)],
      ]
      const del = await db.batch(steps.map(s => s[1]))
      steps.forEach(([t], i) => {
        if (!t) return
        const n = del[i].meta.changes || 0
        acc[t].targetCount += n; acc[t].deletedCount += n
      })
      acc.retired_staff.deletedCount++

      // 2. D1 の削除が成功してから R2 の写真・書類を消す
      //    上限を超えた分は retention_pending_r2 に残り、翌日以降の再試行で消す
      if (photoKeys.length) await deleteR2Files(db, buckets, 'photos', photoKeys, acc, budget)
      if (docKeys.length) await deleteR2Files(db, buckets, 'documents', docKeys, acc, budget)
    } catch (e) {
      console.log(`retention: cleanup failed for staff_id=${staffId}: ${e}`)
      acc.retired_staff.failedCount++
      noteError(acc.retired_staff, `staff_id=${staffId}: ${e}`)
    }
  }
  // 翌日に回した R2 のファイル（上限を超えた分と、消せなかった分）
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM retention_pending_r2').first()
    acc.r2_pending.targetCount = (row?.n as number) || 0
  } catch (e) { console.log(`retention: pending count failed: ${e}`) }
  return acc
}

export type RetentionTrigger = 'cron' | 'manual'

// dryRun=true の場合は一切DELETEを実行せず、対象件数のみを返す（本番投入前の確認用）。
// 各段階の失敗は捕まえて結果（retention_logs）に残し、他の段階は続ける（#436）。
// trigger・triggeredBy は実行元（毎日の cron か、本部画面の dry-run か）と実行した本部ユーザー（#234）
export async function runRetentionCleanup(db: D1Database, buckets: RetentionBuckets,
  opts: { dryRun: boolean; trigger: RetentionTrigger; triggeredBy?: number | null; detail?: boolean }): Promise<RetentionRunResult> {
  const startedAt = new Date().toISOString()

  const stage = async (target: string, fn: () => Promise<RetentionTargetResult[]>): Promise<RetentionTargetResult[]> => {
    try {
      return await fn()
    } catch (e) {
      console.log(`retention: ${target} failed: ${e}`)
      return [{ target, targetCount: 0, deletedCount: 0, failedCount: 1, error: String(e).slice(0, 1000) }]
    }
  }
  const results = [
    ...await stage('daily_reports', async () => [await cleanupDailyReports(db, opts.dryRun)]),
    ...await stage('user_notifications', async () => [await cleanupUserNotifications(db, opts.dryRun)]),
    ...await stage('email_logs', async () => [await cleanupEmailLogs(db, opts.dryRun)]),
    ...await stage('retired_staff', async () => Object.values(opts.dryRun ? await dryRunRetiredStaffData(db) : await cleanupRetiredStaffData(db, buckets))),
  ]
  const finishedAt = new Date().toISOString()
  for (const r of results) {
    r.error = errorMessageOf(r) || undefined
    delete r.errorCount
  }

  await writeRetentionLogs(db, results, { ...opts, startedAt, finishedAt })
  const run: RetentionRunResult = { dryRun: opts.dryRun, results, startedAt, finishedAt }
  // 本部画面の dry-run では、会社別・退職者別の内訳も返す（#365）
  if (opts.dryRun && opts.detail) {
    try { run.detail = await dryRunRetiredStaffDetail(db) }
    catch (e) { console.log(`retention: dry-run detail failed: ${e}`); run.detailError = String(e).slice(0, 300) }
  }
  return run
}

// 1回の実行の行はまとめて書く（対象ごとに1文ずつ書くとクエリ数が増えるため）。
// 同じ実行の行は started_at が同じになり、本部画面ではこれで1回の実行にまとめて表示する（#305）
async function writeRetentionLogs(db: D1Database, results: RetentionTargetResult[],
  o: { dryRun: boolean; trigger: RetentionTrigger; triggeredBy?: number | null; startedAt: string; finishedAt: string }): Promise<void> {
  try {
    const duration = new Date(o.finishedAt).getTime() - new Date(o.startedAt).getTime()
    await db.batch(results.map(r => db.prepare(`
        INSERT INTO retention_logs (target, dry_run, target_count, deleted_count, failed_count, error_message, duration_ms, started_at, finished_at, trigger_source, triggered_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        r.target, o.dryRun ? 1 : 0, r.targetCount, r.deletedCount, r.failedCount, r.error || null,
        duration, o.startedAt, o.finishedAt, o.trigger, o.triggeredBy ?? null
      )))
  } catch (e) {
    // ログ保存の失敗は削除結果の返却を優先して続ける（cron の実行記録には結果が残る）
    console.log(`retention: log insert failed: ${e}`)
  }
}

// ============ 期限切れ・使用済みのトークンの削除（毎日の cron。#397） ============
// データ保持（RETENTION_ENABLED）とは別に、常に実際に削除する（使えなくなったトークンを消すだけで、記録としての価値はない）
const PASSWORD_RESET_KEEP_DAYS = 7 // 期限（1時間）が切れてから残す日数（問い合わせの調査用）
const REPORT_TOKEN_KEEP_DAYS = 30 // 報告用URLの期限（稼働日の翌日 23:59）が切れてから残す日数
const TOKEN_PURGE_BATCH = 500
const TOKEN_PURGE_MAX_BATCHES = 20

async function purgeInBatches(db: D1Database, target: string, sql: string, binds: unknown[]): Promise<RetentionTargetResult> {
  let deleted = 0
  try {
    for (let i = 0; i < TOKEN_PURGE_MAX_BATCHES; i++) {
      const r = await db.prepare(sql).bind(...binds, TOKEN_PURGE_BATCH).run()
      const n = r.meta.changes || 0
      deleted += n
      if (n < TOKEN_PURGE_BATCH) break
    }
    return { target, targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: ${target} purge failed after deleting ${deleted}: ${e}`)
    return { target, targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e).slice(0, 1000) }
  }
}

/**
 * 期限切れ・使用済みのパスワード再設定トークンと、期限切れ・取り消し済みの報告用URLのトークンを消し、
 * 結果を retention_logs に残す。
 *  - password_reset_tokens: expires_at（ISO 8601）から7日たった行。使用済みの行は作成から1日たったら消す
 *    （再設定の回数制限が直近1時間の行を数えるため、すぐには消さない）
 *  - shift_report_tokens: 有効期限は今のシフトの稼働日から決まる（staff-lifecycle.ts の reportTokenExpiry）ので、
 *    稼働日から 1+30 日たった行を消す。取り消し済み（revoked=1）の行は作成から30日たったら消す
 */
export async function purgeExpiredTokens(db: D1Database): Promise<{ deleted: number; failed: number; error: string | null }> {
  const startedAt = new Date().toISOString()
  const resetCutoff = new Date(Date.now() - PASSWORD_RESET_KEEP_DAYS * 86400 * 1000).toISOString()
  const reportCutoff = addDays(todayJST(), -(1 + REPORT_TOKEN_KEEP_DAYS))
  const results = [
    await purgeInBatches(db, 'password_reset_tokens',
      `DELETE FROM password_reset_tokens WHERE token_id IN (SELECT token_id FROM password_reset_tokens
        WHERE expires_at < ? OR (used_at IS NOT NULL AND created_at < datetime('now', '-1 day')) LIMIT ?)`, [resetCutoff]),
    await purgeInBatches(db, 'expired_report_tokens',
      `DELETE FROM shift_report_tokens WHERE token IN (SELECT t.token FROM shift_report_tokens t LEFT JOIN shifts s ON s.shift_id = t.shift_id
        WHERE s.work_date < ? OR s.shift_id IS NULL OR (t.revoked = 1 AND t.created_at < datetime('now', '-${REPORT_TOKEN_KEEP_DAYS} days')) LIMIT ?)`, [reportCutoff]),
  ]
  for (const r of results) {
    r.error = errorMessageOf(r) || r.error
    delete r.errorCount
  }
  await writeRetentionLogs(db, results, { dryRun: false, trigger: 'cron', startedAt, finishedAt: new Date().toISOString() })
  const failed = results.filter(r => r.failedCount > 0)
  return {
    deleted: results.reduce((a, r) => a + r.deletedCount, 0),
    failed: failed.reduce((a, r) => a + r.failedCount, 0),
    error: failed.map(r => `${r.target}: ${r.error || '失敗'}`).join(' / ').slice(0, 1000) || null,
  }
}
