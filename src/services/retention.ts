// データ保存期間ポリシーに基づく定期削除サービス。
//
// 対象と基準:
//   daily_reports              : work_date から3年
//   user_notifications         : created_at から2年（既存の notice_reads の保持期間に合わせる）
//   打刻修正申請・その操作履歴・通知メールの送信状態・報告設定（スタッフ別）とその変更履歴
//                              : 勤怠と同じく、スタッフの退職日から7年（docs/spec_attendance_correction.md 8章）
//   attendance_reports / shifts
//   evaluations / follow_logs
//   consultations / R2写真
//   報告用URLのトークン       : スタッフの退職日(users.retired_at)から7年
//
// 退職者の安全策（#5 #50 #51）:
//   - 退職日が NULL（未設定・不明）のスタッフのデータは絶対に削除しない。
//   - 「退職日と最終稼働日の遅い方から7年」で判定する。退職日より後にシフトがある人は、
//     退職日の入力誤りの可能性があるため対象から外す（本部画面に「対象外」として出す）。
//   - 初めて対象になった人には猶予日数（RETENTION_GRACE_DAYS）を置き、その間は本部画面に
//     「次回削除予定」として出すだけにする。退職日を変えると猶予をやり直す。
//   - 1回のCronで処理する人数には上限があり、まだデータが残っている人だけを、
//     最後に処理を試みた日時の古い順に選ぶ（毎回同じ人ばかりにならないようにする）。
//   - R2 の写真は D1 の削除が成功してから消す。キーは D1 の削除と同じ batch で retention_pending_r2 に
//     控えておき、R2 の削除に失敗したものは次回のCronで再試行する。

const DAILY_REPORTS_YEARS = 3
const RETIRED_YEARS = 7
const DAILY_REPORTS_BATCH = 500
const DAILY_REPORTS_MAX_BATCHES = 20
const STAFF_BATCH = 20 // 1回のCronで処理する退職スタッフの上限人数
const NOTIFICATIONS_YEARS = 2
const NOTIFICATIONS_BATCH = 500
const NOTIFICATIONS_MAX_BATCHES = 20
const R2_RETRY_BATCH = 200 // 1回のCronで再試行する R2 の写真の上限
/** 初めて削除対象になってから実際に削除するまでの猶予日数 */
export const RETENTION_GRACE_DAYS = 7
// 退職スタッフに紐づく打刻修正・報告設定のデータ（勤怠と同じ「退職後7年」）
const RETIRED_EXTRA_TARGETS = ['attendance_corrections', 'attendance_correction_events', 'notification_emails', 'report_setting_logs', 'project_staff_report_settings']
const RETIRED_TARGETS = ['attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations', 'shift_report_tokens', 'r2_photos', ...RETIRED_EXTRA_TARGETS]

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
      return { ok: false, confirm: true, error: `退職日 ${value} は${RETIRED_YEARS}年以上前の日付です。保存すると定期削除の対象になり、猶予期間（${RETENTION_GRACE_DAYS}日）の後に、このスタッフの出退勤記録・シフト・写真・評価・相談などが元に戻せない形で削除されます。日付に誤りがないか確認してください。` }
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
const ELIGIBLE_STAFF_SQL = `SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
  WHERE u.retired_at IS NOT NULL AND length(u.retired_at) >= 10 AND u.retired_at <= ?
    AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date > u.retired_at)`
// まだ削除すべきデータが残っているか（sp.staff_id を参照する）
const HAS_DATA_SQL = `(EXISTS (SELECT 1 FROM shifts WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM attendance_reports WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM evaluations WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM follow_logs WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM consultations WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM shift_report_tokens WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM attendance_corrections WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM report_setting_logs WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM project_staff_report_settings WHERE staff_id = sp.staff_id))`

export type RetentionScheduleRow = {
  staff_id: number; name: string; company_name: string; retired_at: string
  last_work_date: string | null; flagged_at: string | null; delete_on: string | null
}
/**
 * 本部画面の「次回削除予定」と「対象外（退職日より後にシフトあり）」の一覧。
 * delete_on は猶予が明けて削除できるようになる日（まだ猶予が始まっていなければ null）。
 */
export async function listRetentionSchedule(db: D1Database): Promise<{ scheduled: RetentionScheduleRow[]; excluded: RetentionScheduleRow[]; grace_days: number }> {
  const cutoff = cutoffDate(RETIRED_YEARS)
  const cols = `sp.staff_id, u.name, c.company_name, u.retired_at, sp.retention_flagged_at AS flagged_at,
    (SELECT MAX(work_date) FROM shifts WHERE staff_id = sp.staff_id) AS last_work_date
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id LEFT JOIN companies c ON c.company_id = sp.company_id`
  const scheduled = (await db.prepare(`SELECT ${cols}
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL}
    ORDER BY sp.retention_flagged_at IS NULL, sp.retention_flagged_at, u.retired_at, sp.staff_id LIMIT 200`).bind(cutoff).all()).results as any[]
  const excluded = (await db.prepare(`SELECT ${cols}
    WHERE u.retired_at IS NOT NULL AND length(u.retired_at) >= 10 AND u.retired_at <= ?
      AND EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date > u.retired_at)
    ORDER BY u.retired_at, sp.staff_id LIMIT 100`).bind(cutoff).all()).results as any[]
  return {
    scheduled: scheduled.map(r => ({ ...r, delete_on: r.flagged_at ? addDays(r.flagged_at, RETENTION_GRACE_DAYS) : null })),
    excluded: excluded.map(r => ({ ...r, delete_on: null })),
    grace_days: RETENTION_GRACE_DAYS,
  }
}

export type RetentionTargetResult = {
  target: string
  targetCount: number
  deletedCount: number
  failedCount: number
  error?: string
}
export type RetentionRunResult = {
  dryRun: boolean
  results: RetentionTargetResult[]
  startedAt: string
  finishedAt: string
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

async function cleanupUserNotifications(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  const cutoff = cutoffDate(NOTIFICATIONS_YEARS)
  if (dryRun) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE created_at < ?').bind(cutoff).first()
    return { target: 'user_notifications', targetCount: (row?.n as number) || 0, deletedCount: 0, failedCount: 0 }
  }
  let deleted = 0
  try {
    for (let i = 0; i < NOTIFICATIONS_MAX_BATCHES; i++) {
      const result = await db.prepare(
        `DELETE FROM user_notifications WHERE notification_id IN (SELECT notification_id FROM user_notifications WHERE created_at < ? LIMIT ?)`
      ).bind(cutoff, NOTIFICATIONS_BATCH).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes < NOTIFICATIONS_BATCH) break
    }
    return { target: 'user_notifications', targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: user_notifications cleanup failed after deleting ${deleted}: ${e}`)
    return { target: 'user_notifications', targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e) }
  }
}

function emptyRetiredAcc(): Record<string, RetentionTargetResult> {
  const acc: Record<string, RetentionTargetResult> = {}
  for (const t of RETIRED_TARGETS) acc[t] = { target: t, targetCount: 0, deletedCount: 0, failedCount: 0 }
  return acc
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

// 猶予が明け、まだデータが残っている人を、最後に処理を試みた日時の古い順に選ぶ
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
  const counts: Record<string, string> = {
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
  }
  for (const [t, sql] of Object.entries(counts)) {
    try {
      const row = await db.prepare(sql).bind(cutoff).first()
      acc[t].targetCount = (row?.n as number) || 0
    } catch (e) {
      acc[t].failedCount = 1; acc[t].error = String(e)
    }
  }
  return acc
}

// R2 の写真を消し、消せたキーを retention_pending_r2 から外す（消せなかったキーは次回に再試行）
async function deletePhotos(db: D1Database, photos: R2Bucket, keys: string[], acc: Record<string, RetentionTargetResult>): Promise<void> {
  const settled = await Promise.allSettled(keys.map(k => photos.delete(k)))
  const done = keys.filter((_, i) => settled[i].status === 'fulfilled')
  acc.r2_photos.targetCount += keys.length
  acc.r2_photos.deletedCount += done.length
  acc.r2_photos.failedCount += keys.length - done.length
  for (const k of done) {
    await db.prepare('DELETE FROM retention_pending_r2 WHERE photo_key = ?').bind(k).run()
  }
}

async function cleanupRetiredStaffData(db: D1Database, photos: R2Bucket): Promise<Record<string, RetentionTargetResult>> {
  const acc = emptyRetiredAcc()
  const cutoff = cutoffDate(RETIRED_YEARS)

  // 前回までに消せなかった R2 の写真を消し直す
  try {
    const rows = (await db.prepare('SELECT photo_key FROM retention_pending_r2 ORDER BY created_at LIMIT ?').bind(R2_RETRY_BATCH).all()).results as { photo_key: string }[]
    if (rows.length) await deletePhotos(db, photos, rows.map(r => r.photo_key), acc)
  } catch (e) {
    console.log(`retention: R2 retry failed: ${e}`)
    acc.r2_photos.failedCount++; acc.r2_photos.error = String(e)
  }

  await markRetentionCandidates(db, cutoff)
  const staffIds = await getEligibleRetiredStaffIds(db, cutoff, STAFF_BATCH)

  // そのスタッフのシフトに付いた行も対象にする（shifts を消すときの外部キー違反を防ぐ。#51）
  const ofShifts = 'shift_id IN (SELECT shift_id FROM shifts WHERE staff_id = ?)'
  for (const staffId of staffIds) {
    try {
      await db.prepare('UPDATE staff_profiles SET retention_attempted_at = ? WHERE staff_id = ?').bind(nowJST(), staffId).run()
      const photoRows = await db.prepare(
        `SELECT photo_key FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts}) AND photo_key IS NOT NULL`
      ).bind(staffId, staffId).all()
      const keys = (photoRows.results as { photo_key: string }[]).map(r => r.photo_key)

      // 1. D1 側を1つの batch（トランザクション）で削除する。写真のキーは同じ batch で控えておく。
      //    attendance_reports・shift_report_tokens は shifts を参照しているため先に削除する
      const steps: [string | null, D1PreparedStatement][] = [
        [null, db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id)
          SELECT photo_key, ? FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts}) AND photo_key IS NOT NULL`).bind(staffId, staffId, staffId)],
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
      ]
      const del = await db.batch(steps.map(s => s[1]))
      steps.forEach(([t], i) => {
        if (!t) return
        const n = del[i].meta.changes || 0
        acc[t].targetCount += n; acc[t].deletedCount += n
      })

      // 2. D1 の削除が成功してから R2 の写真を消す
      if (keys.length) await deletePhotos(db, photos, keys, acc)
    } catch (e) {
      console.log(`retention: cleanup failed for staff_id=${staffId}: ${e}`)
      for (const t of RETIRED_TARGETS) if (t !== 'r2_photos') { acc[t].failedCount++; acc[t].error = String(e) }
    }
  }
  return acc
}

// dryRun=true の場合は一切DELETEを実行せず、対象件数のみを返す（本番投入前の確認用）。
// 各段階の失敗は捕まえて結果（retention_logs）に残し、他の段階は続ける（#436）
export async function runRetentionCleanup(db: D1Database, photos: R2Bucket, opts: { dryRun: boolean }): Promise<RetentionRunResult> {
  const startedAt = new Date().toISOString()

  const stage = async (target: string, fn: () => Promise<RetentionTargetResult[]>): Promise<RetentionTargetResult[]> => {
    try {
      return await fn()
    } catch (e) {
      console.log(`retention: ${target} failed: ${e}`)
      return [{ target, targetCount: 0, deletedCount: 0, failedCount: 1, error: String(e) }]
    }
  }
  const results = [
    ...await stage('daily_reports', async () => [await cleanupDailyReports(db, opts.dryRun)]),
    ...await stage('user_notifications', async () => [await cleanupUserNotifications(db, opts.dryRun)]),
    ...await stage('retired_staff', async () => Object.values(opts.dryRun ? await dryRunRetiredStaffData(db) : await cleanupRetiredStaffData(db, photos))),
  ]
  const finishedAt = new Date().toISOString()

  for (const r of results) {
    try {
      await db.prepare(`
        INSERT INTO retention_logs (target, dry_run, target_count, deleted_count, failed_count, error_message, duration_ms, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        r.target, opts.dryRun ? 1 : 0, r.targetCount, r.deletedCount, r.failedCount, r.error ? r.error.slice(0, 1000) : null,
        new Date(finishedAt).getTime() - new Date(startedAt).getTime(), startedAt, finishedAt
      ).run()
    } catch {
      // ログ保存の失敗は無視する（削除結果自体の返却を優先する）
    }
  }

  return { dryRun: opts.dryRun, results, startedAt, finishedAt }
}
