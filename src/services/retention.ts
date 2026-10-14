// データ保存期間ポリシーに基づく定期削除サービス。
//
// 対象と基準:
//   daily_reports              : work_date から3年
//   user_notifications         : created_at から2年（既存の notice_reads の保持期間に合わせる）
//   打刻修正申請・その操作履歴・通知メールの送信状態・報告設定（スタッフ別）とその変更履歴
//                              : 勤怠と同じく、スタッフの退職日から7年（docs/spec_attendance_correction.md 8章）
//   attendance_reports / shifts
//   evaluations / follow_logs
//   consultations / R2写真     : スタッフの退職日(users.retired_at)から7年
//
// 退職日が NULL（未設定・不明）のスタッフのデータは絶対に削除しない。
// 大量データを一度に削除しないよう、日報はバッチ削除、退職スタッフは1回のCronにつき
// 上限人数までを処理し、残りは翌日以降のCronに委ねる。
// R2削除が一部でも失敗した場合、そのスタッフのD1削除は今回スキップし、次回Cronで再試行する
// （D1側の参照を残しておくことで、削除できなかったR2オブジェクトの再試行手段を保つ）。

const DAILY_REPORTS_YEARS = 3
const RETIRED_YEARS = 7
const DAILY_REPORTS_BATCH = 500
const DAILY_REPORTS_MAX_BATCHES = 20
const STAFF_BATCH = 20 // 1回のCronで処理する退職スタッフの上限人数
const NOTIFICATIONS_YEARS = 2
const NOTIFICATIONS_BATCH = 500
const NOTIFICATIONS_MAX_BATCHES = 20
// 退職スタッフに紐づく打刻修正・報告設定のデータ（勤怠と同じ「退職後7年」）
const RETIRED_EXTRA_TARGETS = ['attendance_corrections', 'attendance_correction_events', 'notification_emails', 'report_setting_logs', 'project_staff_report_settings']

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

async function getEligibleRetiredStaffIds(db: D1Database, limit: number): Promise<number[]> {
  const cutoff = cutoffDate(RETIRED_YEARS)
  const rows = await db.prepare(
    `SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
     WHERE u.retired_at IS NOT NULL AND u.retired_at <= ? LIMIT ?`
  ).bind(cutoff, limit).all()
  return (rows.results as { staff_id: number }[]).map(r => r.staff_id)
}

async function dryRunRetiredStaffData(db: D1Database): Promise<Record<string, RetentionTargetResult>> {
  const targets = ['attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations', 'r2_photos', ...RETIRED_EXTRA_TARGETS]
  const acc: Record<string, RetentionTargetResult> = {}
  for (const t of targets) acc[t] = { target: t, targetCount: 0, deletedCount: 0, failedCount: 0 }

  const cutoff = cutoffDate(RETIRED_YEARS)
  const staffRows = (await db.prepare(
    `SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.retired_at IS NOT NULL AND u.retired_at <= ?`
  ).bind(cutoff).all()).results as { staff_id: number }[]
  if (staffRows.length === 0) return acc

  const ids = staffRows.map(s => s.staff_id)
  const placeholders = ids.map(() => '?').join(',')
  for (const table of ['attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations']) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE staff_id IN (${placeholders})`).bind(...ids).first()
    acc[table].targetCount = (row?.n as number) || 0
  }
  const photoRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${placeholders}) AND photo_key IS NOT NULL`
  ).bind(...ids).first()
  acc.r2_photos.targetCount = (photoRow?.n as number) || 0
  // 打刻修正・報告設定（退職スタッフの判定はサブクエリで行う）
  const retired = `SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.retired_at IS NOT NULL AND u.retired_at <= ?`
  const counts: Record<string, string> = {
    attendance_corrections: `SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id IN (${retired})`,
    attendance_correction_events: `SELECT COUNT(*) AS n FROM attendance_correction_events WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id IN (${retired}))`,
    notification_emails: `SELECT COUNT(*) AS n FROM notification_emails WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id IN (${retired}))`,
    report_setting_logs: `SELECT COUNT(*) AS n FROM report_setting_logs WHERE staff_id IN (${retired})`,
    project_staff_report_settings: `SELECT COUNT(*) AS n FROM project_staff_report_settings WHERE staff_id IN (${retired})`,
  }
  for (const [t, sql] of Object.entries(counts)) {
    const row = await db.prepare(sql).bind(cutoff).first()
    acc[t].targetCount = (row?.n as number) || 0
  }
  return acc
}

async function cleanupRetiredStaffData(db: D1Database, photos: R2Bucket): Promise<Record<string, RetentionTargetResult>> {
  const targets = ['attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations', 'r2_photos', ...RETIRED_EXTRA_TARGETS]
  const acc: Record<string, RetentionTargetResult> = {}
  for (const t of targets) acc[t] = { target: t, targetCount: 0, deletedCount: 0, failedCount: 0 }

  const staffIds = await getEligibleRetiredStaffIds(db, STAFF_BATCH)

  for (const staffId of staffIds) {
    try {
      // 1. R2写真を先に削除する（D1レコードを消してしまうとR2キーを再取得できなくなるため）
      const photoRows = await db.prepare(
        'SELECT photo_key FROM attendance_reports WHERE staff_id = ? AND photo_key IS NOT NULL'
      ).bind(staffId).all()
      const keys = (photoRows.results as { photo_key: string }[]).map(r => r.photo_key)

      let r2AllOk = true
      if (keys.length) {
        const settled = await Promise.allSettled(keys.map(k => photos.delete(k)))
        const failedKeys = settled.filter(s => s.status === 'rejected').length
        acc.r2_photos.targetCount += keys.length
        acc.r2_photos.deletedCount += keys.length - failedKeys
        acc.r2_photos.failedCount += failedKeys
        if (failedKeys > 0) r2AllOk = false
      }

      if (!r2AllOk) {
        // R2削除が一部失敗した場合、このスタッフのD1削除は今回見送り、次回Cronで再試行する
        console.log(`retention: staff_id=${staffId} R2 photo deletion partially failed, deferring D1 cleanup to next run`)
        continue
      }

      // 2. D1側を削除する。attendance_reportsはshiftsを参照しているため先に削除する
      const del = await db.batch([
        db.prepare('DELETE FROM attendance_reports WHERE staff_id = ?').bind(staffId),
        db.prepare('DELETE FROM shifts WHERE staff_id = ?').bind(staffId),
        db.prepare('DELETE FROM evaluations WHERE staff_id = ?').bind(staffId),
        db.prepare('DELETE FROM follow_logs WHERE staff_id = ?').bind(staffId),
        db.prepare('DELETE FROM consultations WHERE staff_id = ?').bind(staffId),
        // 打刻修正の操作履歴・通知メールは申請より先に消す（申請 ID で対象を特定するため）
        db.prepare('DELETE FROM attendance_correction_events WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId),
        db.prepare('DELETE FROM notification_emails WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId),
        db.prepare('DELETE FROM attendance_corrections WHERE staff_id = ?').bind(staffId),
        db.prepare('DELETE FROM report_setting_logs WHERE staff_id = ?').bind(staffId),
        db.prepare('DELETE FROM project_staff_report_settings WHERE staff_id = ?').bind(staffId),
      ])
      const changes = del.map(r => r.meta.changes || 0)
      ;['attendance_correction_events', 'notification_emails', 'attendance_corrections', 'report_setting_logs', 'project_staff_report_settings'].forEach((t, i) => {
        acc[t].targetCount += changes[5 + i]; acc[t].deletedCount += changes[5 + i]
      })
      acc.attendance_reports.targetCount += changes[0]; acc.attendance_reports.deletedCount += changes[0]
      acc.shifts.targetCount += changes[1]; acc.shifts.deletedCount += changes[1]
      acc.evaluations.targetCount += changes[2]; acc.evaluations.deletedCount += changes[2]
      acc.follow_logs.targetCount += changes[3]; acc.follow_logs.deletedCount += changes[3]
      acc.consultations.targetCount += changes[4]; acc.consultations.deletedCount += changes[4]
    } catch (e) {
      console.log(`retention: cleanup failed for staff_id=${staffId}: ${e}`)
      for (const t of ['attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations', ...RETIRED_EXTRA_TARGETS]) acc[t].failedCount++
    }
  }
  return acc
}

// dryRun=true の場合は一切DELETEを実行せず、対象件数のみを返す（本番投入前の確認用）
export async function runRetentionCleanup(db: D1Database, photos: R2Bucket, opts: { dryRun: boolean }): Promise<RetentionRunResult> {
  const startedAt = new Date().toISOString()

  const dailyReportsResult = await cleanupDailyReports(db, opts.dryRun)
  const notificationsResult = await cleanupUserNotifications(db, opts.dryRun)
  const retiredResults = opts.dryRun ? await dryRunRetiredStaffData(db) : await cleanupRetiredStaffData(db, photos)

  const results = [dailyReportsResult, notificationsResult, ...Object.values(retiredResults)]
  const finishedAt = new Date().toISOString()

  for (const r of results) {
    try {
      await db.prepare(`
        INSERT INTO retention_logs (target, dry_run, target_count, deleted_count, failed_count, error_message, duration_ms, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        r.target, opts.dryRun ? 1 : 0, r.targetCount, r.deletedCount, r.failedCount, r.error ?? null,
        new Date(finishedAt).getTime() - new Date(startedAt).getTime(), startedAt, finishedAt
      ).run()
    } catch {
      // ログ保存の失敗は無視する（削除結果自体の返却を優先する）
    }
  }

  return { dryRun: opts.dryRun, results, startedAt, finishedAt }
}
