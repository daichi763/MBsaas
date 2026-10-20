// =========================================================
// 本人あての自動リマインド（#160）。15分おきの cron（index.tsx の CRON_JOBS の reminders）で実行する
// 対象は、会社の設定（companies.settings_json の reminders。notifications.ts の reminderSettings）で ON にした会社の、
// ログインできるスタッフ本人（role = staff・在籍中・統合されていない）のシフトだけ。ログインのない人・連携先の行には送らない。
//   起床・出発・入店: 確定・代打のシフトで、その報告が有効（案件報告管理の設定）なのに、報告も承認待ちの打刻修正申請もないもの。
//     送る時点は開始の何分前（起床・出発）・何分後（入店）。報告の受付の開始（reportableWindow）より前になるときは受付の開始に送る。
//     それより後の報告が済んでいる・同じ日の別のシフトで起床を報告した・遅刻・欠勤・体調不良の連絡がある（ダッシュボードの『連絡あり』と同じ）ときは送らない。
//     起床・出発は開始の時刻を過ぎたら送らない（入店のリマインドに任せる）。
//   日報: 確定・代打のシフトで日報が必要（dailyReportRequiredSql）なのに、予定の終了の何分後になっても日報がないもの。
// 送る時点から REMIND_LATE_MINUTES 以上過ぎたもの（cron が止まっていた間の分や、設定を ON にした直後の過去の分）は送らない。
// 同じシフト・同じ種類は1回だけ（reminder_sends の一意索引で先に記録を取り、記録が取れたものだけを送る。二重起動でも二度送らない）。
// Workers の CPU 時間の上限があるため、1回の起動で読むシフトは種類ごとに MAX_CANDIDATES 件まで（残りは次の起動で送る）
// =========================================================
import { reminderSettings, deliverReminders, REMINDER_LIMITS, type NotifyEnv, type ReminderItem, type ReminderSettings, type ReminderType } from '../notifications'
import { attendanceTypesForRows, dailyReportRequiredSql, REPORT_TYPES } from '../report-settings'
import { shiftWindow, reportableWindow, addMinutes, addDays } from '../lib/shift-time'
import { JSON_IN, bindJsonArray } from '../lib/d1-chunk'

const START_TYPES = ['wake_up', 'departure', 'check_in'] as const
export const REMIND_LATE_MINUTES = { attendance: 60, daily_report: 180 }
const MAX_CANDIDATES = 1000
const KEEP_DAYS = 90

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }

// 会社ごとの設定（行ごとに JSON を読み直さない）
function settingsCache() {
  const m = new Map<number, ReminderSettings>()
  return (row: { company_id: number; settings_json: unknown }) => {
    let s = m.get(row.company_id)
    if (!s) { s = reminderSettings(row.settings_json); m.set(row.company_id, s) }
    return s
  }
}

// 対象のシフトの共通の条件（会社の設定が ON・会社が停止されていない・ログインできるスタッフ本人・確定か代打）
const BASE_FROM = `FROM shifts s
  JOIN companies co ON co.company_id = s.company_id
  JOIN projects p ON p.project_id = s.project_id
  JOIN staff_profiles sp ON sp.staff_id = s.staff_id
  JOIN users us ON us.user_id = sp.user_id`
const BASE_WHERE = `s.status IN ('confirmed', 'substitute')
  AND (CASE WHEN json_valid(co.settings_json) THEN json_extract(co.settings_json, '$.reminders.enabled') END) = 1
  AND COALESCE(co.active_status, 'active') != 'inactive'
  AND us.role = 'staff' AND us.status = 'active' AND sp.merged_into_staff_id IS NULL`
const BASE_COLS = `s.shift_id, s.company_id, s.project_id, s.staff_id, s.work_date, s.start_time, s.end_time,
  p.project_name, us.user_id, us.name AS user_name, us.email, co.settings_json`

const toItem = (s: any, type: ReminderType, settings: ReminderSettings): ReminderItem => ({
  company_id: s.company_id, shift_id: s.shift_id, staff_id: s.staff_id, user_id: s.user_id, user_name: s.user_name, email: s.email || null,
  email_on: settings.email, type, work_date: s.work_date, start_time: s.start_time, end_time: s.end_time, project_name: s.project_name,
})

// 起床・出発・入店のリマインド（送る時点と、送ると決めたもの）
async function attendanceReminders(db: D1Database, now: string): Promise<(ReminderItem & { due_at: string })[]> {
  const today = now.slice(0, 10)
  // 開始の時刻で粗く絞る（起床は開始の6時間前から、入店は開始の2時間後＋遅れの上限まで）
  const from = addMinutes(now, -(REMINDER_LIMITS.check_in + REMIND_LATE_MINUTES.attendance))
  const to = addMinutes(now, Math.max(REMINDER_LIMITS.wake_up, REMINDER_LIMITS.departure))
  // 入店より後の報告が済んだシフトと、入店のリマインドを送ったシフトは、もう送るものがない
  const rows = (await db.prepare(`SELECT ${BASE_COLS}, s.attendance_mode, s.attendance_types_fixed, sp.attendance_mode AS legacy_mode
    ${BASE_FROM}
    WHERE s.work_date BETWEEN ? AND ? AND ${BASE_WHERE}
      AND datetime(s.work_date || ' ' || s.start_time) BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type NOT IN ('wake_up', 'departure'))
      AND NOT EXISTS (SELECT 1 FROM reminder_sends r WHERE r.shift_id = s.shift_id AND r.reminder_type = 'check_in')
    ORDER BY s.shift_id LIMIT ?`).bind(addDays(today, -1), addDays(today, 1), from, to, MAX_CANDIDATES).all()).results as any[]
  if (!rows.length) return []
  const settingsOf = settingsCache()
  const ids = bindJsonArray(rows.map(r => r.shift_id))
  const staffIds = bindJsonArray(rows.map(r => r.staff_id))
  const [required, done, pending, sent, woke, contacts] = await Promise.all([
    attendanceTypesForRows(db, rows),
    db.prepare(`SELECT shift_id, report_type FROM attendance_reports WHERE shift_id IN ${JSON_IN}`).bind(ids).all(),
    db.prepare(`SELECT shift_id, report_type FROM attendance_corrections WHERE status = 'pending' AND shift_id IN ${JSON_IN}`).bind(ids).all(),
    db.prepare(`SELECT shift_id, reminder_type FROM reminder_sends WHERE shift_id IN ${JSON_IN}`).bind(ids).all(),
    // 同じ日に別のシフトで起床を報告していれば、起床は済みとする（ダッシュボードと同じ。#449）
    db.prepare(`SELECT DISTINCT s.staff_id, s.work_date FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id
      WHERE a.report_type = 'wake_up' AND s.staff_id IN ${JSON_IN} AND s.work_date BETWEEN ? AND ?`).bind(staffIds, addDays(today, -1), addDays(today, 1)).all(),
    // 遅刻・欠勤・体調不良の連絡（ダッシュボードの『連絡あり』と同じ結び付け。#498）
    db.prepare(`SELECT staff_id, target_date, target_project_id, substr(created_at, 1, 10) AS created_date FROM consultations
      WHERE staff_id IN ${JSON_IN} AND category IN ('absence', 'health')
        AND (target_date BETWEEN ? AND ? OR (target_date IS NULL AND created_at >= ?))`).bind(staffIds, addDays(today, -1), addDays(today, 1), `${addDays(today, -2)} 00:00:00`).all(),
  ])
  const setOf = (res: any, col: string) => {
    const m = new Map<number, Set<string>>()
    for (const r of (res.results || []) as any[]) { const s = m.get(r.shift_id) || new Set<string>(); s.add(r[col]); m.set(r.shift_id, s) }
    return m
  }
  const doneMap = setOf(done, 'report_type'), pendingMap = setOf(pending, 'report_type'), sentMap = setOf(sent, 'reminder_type')
  const wokeSet = new Set(((woke.results || []) as any[]).map(r => `${r.staff_id}:${r.work_date}`))
  const contactList = (contacts.results || []) as any[]
  const hasContact = (s: any) => contactList.some(x => x.staff_id === s.staff_id && (x.target_date
    ? x.target_date === s.work_date && (!x.target_project_id || x.target_project_id === s.project_id)
    : [addDays(s.work_date, -1), s.work_date].includes(x.created_date)))
  const out: (ReminderItem & { due_at: string })[] = []
  for (const s of rows) {
    const settings = settingsOf(s)
    const types = required.get(s.shift_id)?.types ?? [...REPORT_TYPES]
    const d = doneMap.get(s.shift_id) || new Set<string>(), p = pendingMap.get(s.shift_id) || new Set<string>(), sn = sentMap.get(s.shift_id) || new Set<string>()
    if (hasContact(s)) continue
    const win = shiftWindow(s.work_date, s.start_time, s.end_time)
    for (const t of START_TYPES) {
      const minutes = settings[t]
      if (minutes === null || !types.includes(t) || d.has(t) || p.has(t) || sn.has(t)) continue
      // 後の報告が済んでいれば、前の報告は今の時刻では押せない（打刻修正で追加する）
      const idx = REPORT_TYPES.indexOf(t)
      if (REPORT_TYPES.some((x, j) => j > idx && d.has(x))) continue
      if (t === 'wake_up' && wokeSet.has(`${s.staff_id}:${s.work_date}`)) continue
      const rw = reportableWindow(s, t)
      let due = addMinutes(win.start, t === 'check_in' ? minutes : -minutes)
      if (due < rw.start) due = rw.start
      if (now < due || now >= addMinutes(due, REMIND_LATE_MINUTES.attendance) || now > rw.end) continue
      if (t !== 'check_in' && now >= win.start) continue
      out.push({ ...toItem(s, t, settings), due_at: due })
    }
  }
  return out
}

// 日報のリマインド
async function dailyReportReminders(db: D1Database, now: string): Promise<(ReminderItem & { due_at: string })[]> {
  const today = now.slice(0, 10)
  // 予定の終了は稼働日の翌日まで。送る時点は終了の12時間後まで、遅れの上限を足しても稼働日の2日後まで
  // 予定の終了でも絞る（送る時点を過ぎて送らなかったシフトや、まだ終わっていないシフトで MAX_CANDIDATES 件が埋まり、送るべきものが読まれなくならないように）
  const endFrom = addMinutes(now, -(REMINDER_LIMITS.daily_report + REMIND_LATE_MINUTES.daily_report))
  const rows = (await db.prepare(`SELECT ${BASE_COLS}
    ${BASE_FROM}
    WHERE s.work_date BETWEEN ? AND ? AND ${BASE_WHERE}
      AND datetime(s.work_date || ' ' || s.end_time, CASE WHEN substr(s.end_time, 1, 5) <= substr(s.start_time, 1, 5) THEN '+1 day' ELSE '+0 days' END) BETWEEN ? AND ?
      AND ${dailyReportRequiredSql('s', 'sp', 'p')}
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id)
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE +dr.shift_id IS NULL AND dr.staff_id = s.staff_id AND dr.work_date = s.work_date AND dr.project_id = s.project_id)
      AND NOT EXISTS (SELECT 1 FROM reminder_sends r WHERE r.shift_id = s.shift_id AND r.reminder_type = 'daily_report')
    ORDER BY s.shift_id LIMIT ?`).bind(addDays(today, -2), today, endFrom, now, MAX_CANDIDATES).all()).results as any[]
  const settingsOf = settingsCache()
  const out: (ReminderItem & { due_at: string })[] = []
  for (const s of rows) {
    const settings = settingsOf(s)
    if (settings.daily_report === null) continue
    const due = addMinutes(shiftWindow(s.work_date, s.start_time, s.end_time).end, settings.daily_report)
    if (now < due || now >= addMinutes(due, REMIND_LATE_MINUTES.daily_report)) continue
    out.push({ ...toItem(s, 'daily_report', settings), due_at: due })
  }
  return out
}

/** 定期処理の本体。now は JST の 'YYYY-MM-DD HH:MM:SS'（テスト用に渡せる） */
export async function runReminders(env: NotifyEnv, now: string = nowJST()) {
  const db = env.DB
  // 重複を防ぐための記録なので、古い行は消す
  await db.prepare('DELETE FROM reminder_sends WHERE created_at < ?').bind(`${addDays(now.slice(0, 10), -KEEP_DAYS)} 00:00:00`).run()
  // ON にした会社がなければ、シフトを読まずに終える（15分おきに全社のシフトを読む分の D1 の読み取りを減らす）
  const anyOn = await db.prepare(`SELECT 1 AS x FROM companies co WHERE (CASE WHEN json_valid(co.settings_json) THEN json_extract(co.settings_json, '$.reminders.enabled') END) = 1
    AND COALESCE(co.active_status, 'active') != 'inactive' LIMIT 1`).first()
  if (!anyOn) return { idle: true, sent: 0 }
  const candidates = [...await attendanceReminders(db, now), ...await dailyReportReminders(db, now)]
  // 何もなかった実行は idle を返す（cron_runs の記録を1行にまとめる。services/cron.ts）
  if (!candidates.length) return { idle: true, sent: 0 }
  // 先に記録を取り、記録が取れたもの（まだ送っていないもの）だけを送る
  const claimed = new Map<string, number>()
  for (let i = 0; i < candidates.length; i += 200) {
    const part = candidates.slice(i, i + 200)
    const res = (await db.prepare(`INSERT OR IGNORE INTO reminder_sends (company_id, shift_id, staff_id, user_id, reminder_type, due_at, created_at)
      SELECT json_extract(value, '$.c'), json_extract(value, '$.s'), json_extract(value, '$.st'), json_extract(value, '$.u'), json_extract(value, '$.t'), json_extract(value, '$.d'), ?
      FROM json_each(?) WHERE true RETURNING reminder_id, shift_id, reminder_type`)
      .bind(now, JSON.stringify(part.map(x => ({ c: x.company_id, s: x.shift_id, st: x.staff_id, u: x.user_id, t: x.type, d: x.due_at })))).all()).results as any[]
    for (const r of res) claimed.set(`${r.shift_id}:${r.reminder_type}`, r.reminder_id)
  }
  const items = candidates.filter(x => claimed.has(`${x.shift_id}:${x.type}`))
  if (!items.length) return { idle: true, sent: 0 }
  const r = await deliverReminders(env, items)
  if (r.emailed.length) {
    await db.prepare(`UPDATE reminder_sends SET emailed = 1 WHERE reminder_id IN ${JSON_IN}`).bind(bindJsonArray(r.emailed.map(k => claimed.get(k)))).run()
  }
  const count = (t: ReminderType) => items.filter(x => x.type === t).length
  return { sent: items.length, wake_up: count('wake_up'), departure: count('departure'), check_in: count('check_in'), daily_report: count('daily_report'),
    notified: r.notified, mails: r.mails, mail_failed: r.mail_failed }
}
