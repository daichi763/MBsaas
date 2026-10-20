// =========================================================
// 案件報告管理（勤怠報告 8 種類の ON/OFF・一括変更・変更履歴）
// docs/spec_attendance_correction.md 2章・3章
//
// 有効な報告の決め方（シフトごと）:
//   1. シフトの例外 shifts.attendance_mode（none = なし / in_out = 入店・退店のみ / full・NULL = 2 以降に従う）
//   2. 案件 × スタッフ別の設定（project_staff_report_settings）
//   3. 案件 × スタッフ別の行がない組み合わせは、0027 より前のスタッフ単位の設定（staff_profiles.attendance_mode の none / in_out）
//   4. 案件の標準設定（project_report_defaults）
//   5. いずれもなければ ON
//   報告を始めた後に設定が変わったシフトは、変わる前に OFF だった報告を ON にしない（shifts.attendance_types_fixed。ON にした報告は次のシフトから効く。#458）
// 報告の順序: 有効な報告は REPORT_TYPES の順に押す。前の報告を飛ばして後の報告を押すことはできる（飛ばした報告は打刻修正の申請で追加する）。
//   後の報告が済んだ後に、それより前の報告を今の時刻で押すことはできない（checkReportable）
// 管理者向け API（/api/admin/report-settings/*）は api.ts から権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'
import { toCsv, csvResponse, loadLatestForCsv, csvLimitNote, csvLimitHeaders, roleLabel, CSV_LIMIT } from './csv'
import { NEXT_DAY_TYPES, addDays, reportableWindow, shiftWindow, type ShiftTimes } from './lib/shift-time'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// 報告の順序（この順に日時が並ぶ）
export const REPORT_TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'] as const
export const REPORT_LABEL: Record<string, string> = {
  wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始',
  break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告',
}
// 稼働日の翌日も受け付ける報告（日をまたぐ勤務）。受付の時間帯は lib/shift-time.ts の reportableWindow
export { NEXT_DAY_TYPES }
// 実績（実働・休憩）に関わる報告。登録・変更のたびに syncActualFromReports を呼ぶ
export const ACTUAL_SYNC_TYPES = ['check_in', 'check_out', 'work_start', 'work_end', 'break_start', 'break_end']

export const isReportType = (t: any): t is string => typeof t === 'string' && (REPORT_TYPES as readonly string[]).includes(t)

// 旧来の提出設定（none / in_out / full）を 8 種類の ON/OFF に置き換える
export function flagsFromLegacyMode(mode: any): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of REPORT_TYPES) out[t] = mode === 'none' ? 0 : mode === 'in_out' ? (t === 'check_in' || t === 'check_out' ? 1 : 0) : 1
  return out
}

export type AttendanceSource = 'shift' | 'staff' | 'project' | 'default'
export type ShiftAttendance = { types: string[]; source: AttendanceSource }

// 0027 より前のスタッフ単位の提出設定のうち、案件 × スタッフ別の行がない組み合わせに引き継ぐ値（none / in_out のみ。full は案件の標準設定に従う）
export function legacyStaffFlags(mode: any): Record<string, number> | null {
  return mode === 'none' || mode === 'in_out' ? flagsFromLegacyMode(mode) : null
}
// shifts.attendance_types_fixed（JSON 配列）を REPORT_TYPES の順の配列にする。壊れていれば null
function parseFixedTypes(v: any): string[] | null {
  if (typeof v !== 'string' || !v) return null
  try {
    const a = JSON.parse(v)
    return Array.isArray(a) ? REPORT_TYPES.filter(t => a.includes(t)) : null
  } catch { return null }
}

// シフトごとに有効な報告（REPORT_TYPES の順）を返す
export async function attendanceTypesForShifts(db: D1Database, shiftIds: number[]): Promise<Map<number, ShiftAttendance>> {
  const map = new Map<number, ShiftAttendance>()
  const ids = [...new Set(shiftIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const shifts = (await db.prepare(`SELECT s.shift_id, s.project_id, s.staff_id, s.attendance_mode, s.attendance_types_fixed, sp.attendance_mode AS legacy_mode
      FROM shifts s LEFT JOIN staff_profiles sp ON sp.staff_id = s.staff_id WHERE s.shift_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all()).results as any[]
    const projectIds = [...new Set(shifts.map(s => s.project_id))]
    const staffIds = [...new Set(shifts.map(s => s.staff_id))]
    const defaults = new Map<string, number>()
    const personal = new Map<string, number>()
    const hasPersonal = new Set<string>()
    if (projectIds.length) {
      const q = projectIds.map(() => '?').join(',')
      for (const r of (await db.prepare(`SELECT project_id, report_type, enabled FROM project_report_defaults WHERE project_id IN (${q})`).bind(...projectIds).all()).results as any[]) {
        defaults.set(`${r.project_id}:${r.report_type}`, r.enabled)
      }
      // バインド変数は 1 文 100 個までのため、スタッフで絞って案件は手元で照合する
      const pset = new Set(projectIds)
      for (const r of (await db.prepare(`SELECT project_id, staff_id, report_type, enabled FROM project_staff_report_settings WHERE staff_id IN (${staffIds.map(() => '?').join(',')})`)
        .bind(...staffIds).all()).results as any[]) {
        if (!pset.has(r.project_id)) continue
        personal.set(`${r.project_id}:${r.staff_id}:${r.report_type}`, r.enabled)
        hasPersonal.add(`${r.project_id}:${r.staff_id}`)
      }
    }
    for (const s of shifts) map.set(s.shift_id, resolveAttendanceTypes(s, defaults, personal, hasPersonal))
  }
  return map
}

// 1つのシフトの有効な報告を決める（attendanceTypesForShifts・attendanceTypesForRows で共用）。
// s は shift_id, project_id, staff_id, attendance_mode（シフトの例外）, attendance_types_fixed, legacy_mode（staff_profiles.attendance_mode）
function resolveAttendanceTypes(s: any, defaults: Map<string, number>, personal: Map<string, number>, hasPersonal: Set<string>): ShiftAttendance {
  if (s.attendance_mode === 'none') return { types: [], source: 'shift' }
  if (s.attendance_mode === 'in_out') return { types: ['check_in', 'check_out'], source: 'shift' }
  const fixed = parseFixedTypes(s.attendance_types_fixed)
  const legacy = hasPersonal.has(`${s.project_id}:${s.staff_id}`) ? null : legacyStaffFlags(s.legacy_mode)
  let source: AttendanceSource = legacy ? 'staff' : 'default'
  const types = REPORT_TYPES.filter(t => {
    const pv = personal.get(`${s.project_id}:${s.staff_id}:${t}`)
    if (pv !== undefined) { source = 'staff'; return !!pv }
    if (legacy) return !!legacy[t]
    const dv = defaults.get(`${s.project_id}:${t}`)
    if (dv !== undefined) { if (source === 'default') source = 'project'; return !!dv }
    return true
  })
  // 報告を始めた後に設定が変わったシフトは、変わる前に OFF だった報告を ON にしない（OFF にした報告はすぐ外す。docs 2.7）
  return { types: fixed ? types.filter(t => fixed.includes(t)) : types, source }
}

// シフトの行を読み済みのとき（精算の一覧など件数の多い一覧）に、有効な報告をまとめて決める。
// 規則は attendanceTypesForShifts と同じ。設定は json_each で2回の問い合わせにまとめて読む（シフトの件数で問い合わせが増えない）
export async function attendanceTypesForRows(db: D1Database, rows: { shift_id: number; project_id: number; staff_id: number; attendance_mode?: any; attendance_types_fixed?: any; legacy_mode?: any }[]) {
  const map = new Map<number, ShiftAttendance>()
  if (!rows.length) return map
  const defaults = new Map<string, number>(), personal = new Map<string, number>(), hasPersonal = new Set<string>()
  const pset = new Set(rows.map(r => Number(r.project_id)))
  for (const r of (await db.prepare(`SELECT project_id, report_type, enabled FROM project_report_defaults WHERE project_id IN ${JSON_IN}`)
    .bind(bindJsonArray(pset)).all()).results as any[]) defaults.set(`${r.project_id}:${r.report_type}`, r.enabled)
  for (const r of (await db.prepare(`SELECT project_id, staff_id, report_type, enabled FROM project_staff_report_settings WHERE staff_id IN ${JSON_IN}`)
    .bind(bindJsonArray(rows.map(x => x.staff_id))).all()).results as any[]) {
    if (!pset.has(Number(r.project_id))) continue
    personal.set(`${r.project_id}:${r.staff_id}:${r.report_type}`, r.enabled)
    hasPersonal.add(`${r.project_id}:${r.staff_id}`)
  }
  for (const s of rows) map.set(s.shift_id, resolveAttendanceTypes(s, defaults, personal, hasPersonal))
  return map
}

// 日報が必要なシフトか（SQL の式）。シフト → スタッフ → 案件の順に none / required の最初の値、なければ required。
// staff-lifecycle.ts の resolveModes（modesForShifts）と同じ規則を、集計の SQL の中で使う。引数は shifts・staff_profiles・projects の別名
export function dailyReportRequiredSql(s: string, sp: string, p: string): string {
  const v = (a: string) => `CASE WHEN ${a}.daily_report_mode IN ('none','required') THEN ${a}.daily_report_mode END`
  return `(COALESCE(${v(s)}, ${v(sp)}, ${v(p)}, 'required') = 'required')`
}

type Ng = { error: string; status: number }

// 報告できるかの確認（有効・未報告・承認待ちの申請・順序）。done は登録済みの報告の種類、pending は承認待ちの打刻修正申請がある種類
//   前の報告が済んでいなくても、後の報告は押せる（飛ばした報告は打刻修正の申請で追加する。#47）。
//   そのため、勤務の途中で前の報告が ON になっても後の報告は止まらない（#458）。
//   後の報告が済んだ後に、それより前の報告を今の時刻で押すことはできない（順序が逆の記録を作らない）
export function checkReportable(required: string[], done: Set<string>, type: string, pending?: Set<string>): Ng | null {
  if (!required.includes(type)) return { error: 'このシフトでは不要な報告です', status: 400 }
  if (done.has(type)) return { error: 'すでに報告済みです', status: 409 }
  if (pending && pending.has(type)) return { error: `${REPORT_LABEL[type]}は打刻修正を申請中です（承認待ち）。今の時刻で報告する場合は、打刻履歴から申請を取り消してください`, status: 409 }
  const idx = REPORT_TYPES.indexOf(type as any)
  const later = REPORT_TYPES.find((t, j) => j > idx && done.has(t))
  if (later) return { error: `${REPORT_LABEL[later]}を報告済みのため、${REPORT_LABEL[type]}は報告できません。打刻の修正申請から追加してください`, status: 400 }
  return null
}

// 『休憩なし』の申告（休憩入・休憩出を同じ時刻で記録し、休憩0分にする。#324）ができるか。
// 休憩入・休憩出の両方が有効で、どちらも checkReportable で押せること（未報告・申請中でない・勤務終了などの後の報告が済んでいない）
export function checkNoBreak(required: string[], done: Set<string>, pending?: Set<string>): Ng | null {
  if (!required.includes('break_start') || !required.includes('break_end')) return { error: 'このシフトでは休憩の報告は不要です', status: 400 }
  if (done.has('break_start') || done.has('break_end')) return { error: '休憩の報告がすでにあるため、休憩なしにはできません。打刻履歴から修正を申請してください', status: 409 }
  return checkReportable(required, done, 'break_start', pending) || checkReportable(required, done, 'break_end', pending)
}

// 今押せる報告（REPORT_TYPES の順）。先頭がホームの『次の報告』。空なら報告は済んでいる（飛ばした報告は打刻修正の申請で追加する）
export function reportableTypes(required: string[], done: Set<string>, pending?: Set<string>): string[] {
  return required.filter(t => !checkReportable(required, done, t, pending))
}

// 報告を受け付ける時間帯か（now は JST の 'YYYY-MM-DD HH:MM:SS'）。時間帯の外ならエラーを返す
export function checkReportTime(shift: ShiftTimes, type: string, now: string): Ng | null {
  const w = reportableWindow(shift, type)
  if (now < w.start) return { error: `まだ報告できません（${Number(w.start.slice(5, 7))}/${Number(w.start.slice(8, 10))} ${w.start.slice(11, 16)} から報告できます）`, status: 400 }
  if (now > w.end) return { error: '報告の受付期間を過ぎています。打刻の修正申請から追加してください', status: 400 }
  return null
}

// スタッフ本人の報告（アプリ・写真付き・報告用URL）を受け付けるシフトか: 欠勤・精算の確定済みは受け付けない（#116）。
// 希望（仮）のシフトは受け付ける（画面で確認を出す。精算での扱いは確認事項で知らせる）
export function checkShiftAcceptsReport(shift: { status?: any; shift_status?: any; settle_status?: any }): Ng | null {
  const status = shift.status ?? shift.shift_status
  if (status === 'absent') return { error: '欠勤のシフトには報告できません', status: 400 }
  if (shift.settle_status === 'confirmed') return { error: '精算が確定したシフトには報告できません。打刻の修正は管理者に連絡してください', status: 409 }
  return null
}

// スタッフ本人の報告の受付をまとめて確認する（シフトの状態 → 受付の時間帯 → 有効・未報告・申請中・順序）
export function checkStaffReport(shift: ShiftTimes & { status?: any; shift_status?: any; settle_status?: any }, type: string, now: string,
  required: string[], state: { done: Set<string>; pending: Set<string> }): Ng | null {
  return checkShiftAcceptsReport(shift) || checkReportTime(shift, type, now) || checkReportable(required, state.done, type, state.pending)
}

// シフトの登録済みの報告と、承認待ちの打刻修正申請がある報告
export async function loadReportState(db: D1Database, shiftId: number): Promise<{ done: Set<string>; pending: Set<string> }> {
  const [reports, pending] = await db.batch([
    db.prepare('SELECT report_type FROM attendance_reports WHERE shift_id = ?').bind(shiftId),
    db.prepare("SELECT report_type FROM attendance_corrections WHERE shift_id = ? AND status = 'pending'").bind(shiftId),
  ])
  return {
    done: new Set((reports.results as any[]).map(r => r.report_type)),
    pending: new Set((pending.results as any[]).map(r => r.report_type)),
  }
}

// 報告の記録日時は分の単位にそろえる（打刻修正の申請と同じ精度。#133）
export function reportedAtMinute(now: string): string {
  return now.slice(0, 16) + ':00'
}

// ---------- 電波がない場所で押した報告（#427） ----------
// アプリは通信に失敗した報告を端末に保存し、通信が戻ってから押した時刻（pressed_at。端末の時計のエポックミリ秒）を付けて送る。
// 端末の時計は本人が変えられるので、次の範囲だけを受け付け、記録には time_source='device' の印と受け取った時刻を残す:
//   ・受け取った時刻より DEVICE_TIME_MAX_AHEAD_MINUTES 分を超えて先の時刻は受け付けない（端末の時計が進んでいる）
//   ・受け取った時刻から DEVICE_TIME_MAX_DELAY_MINUTES 分より前に押したものは受け付けない（打刻修正の申請で直す）
//   ・報告の受付時間帯（reportableWindow）と、記録済みの前の報告との順序は、押した時刻で確かめる（api.ts の staffReportTime）
// 押した時刻が受け取った時刻と同じ分（か少し先）なら、これまでどおり受け取った時刻で記録する
export const DEVICE_TIME_MAX_AHEAD_MINUTES = 2
export const DEVICE_TIME_MAX_DELAY_MINUTES = 12 * 60
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
// 画面が押すたびに作る一意キー（形が正しくなければ使わない）
export function clientRequestId(v: any): string | null {
  return typeof v === 'string' && CLIENT_REQUEST_ID_RE.test(v) ? v : null
}
const jstOfEpoch = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
// pressed: 端末で押した時刻（JST。送られていなければ null）、adopt: 記録の時刻に使うか
export function deviceReportTime(raw: any, now: string): { pressed: string | null; adopt: boolean } | Ng {
  if (raw == null || raw === '') return { pressed: null, adopt: false }
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return { error: '押した時刻が正しくありません', status: 400 }
  const pressed = jstOfEpoch(Math.floor(ms / 1000) * 1000)
  if (minutesFromTo(now, pressed) > DEVICE_TIME_MAX_AHEAD_MINUTES) {
    return { error: '端末の時計が進んでいるため、押した時刻で記録できません。端末の日時の設定を確かめてから、もう一度報告してください', status: 400 }
  }
  if (minutesFromTo(pressed, now) > DEVICE_TIME_MAX_DELAY_MINUTES) {
    return { error: `押してから${DEVICE_TIME_MAX_DELAY_MINUTES / 60}時間を過ぎたため、押した時刻では記録できません。打刻履歴から打刻漏れの追加を申請してください`, status: 400 }
  }
  return { pressed, adopt: reportedAtMinute(pressed) < reportedAtMinute(now) }
}

// ---------- 前日確認（#176） ----------
// スタッフが前日に『明日の稼働を確認しました』を押す（shifts.day_before_confirmed_at）。会社の設定（companies.settings_json の day_before_check）:
//   enabled: 使うか（既定は使わない。使うとスタッフのホームに確認のボタン、ダッシュボードに明日のシフトの確認状況を出す）
//   deadline: 確認の締切（前日の 'HH:MM'。既定 18:00）。過ぎても未確認の人がいれば、ダッシュボードの ToDo に出す
export type DayBeforeSettings = { enabled: boolean; deadline: string }
export const DAY_BEFORE_DEFAULT_DEADLINE = '18:00'
const isHm = (v: any) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
export function dayBeforeSettings(settingsJson: any): DayBeforeSettings {
  let v: any = null
  try { v = JSON.parse(settingsJson || '{}').day_before_check } catch { }
  return { enabled: !!(v && v.enabled === true), deadline: v && isHm(v.deadline) ? v.deadline : DAY_BEFORE_DEFAULT_DEADLINE }
}
// 確認したときのシフトの内容。確認の後に日時・案件・担当が変わったら合わなくなる（未確認に戻る）
export function dayBeforeKey(s: { work_date: any; start_time: any; end_time: any; project_id: any; staff_id: any }): string {
  return `${s.work_date} ${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)} p${s.project_id} s${s.staff_id}`
}
// 確認済みの日時（確認の後にシフトが変わったものは null）と、確認の後に変わったか
export function dayBeforeState(s: any): { confirmed_at: string | null; changed: boolean } {
  if (!s.day_before_confirmed_at) return { confirmed_at: null, changed: false }
  const same = s.day_before_confirmed_key === dayBeforeKey(s)
  return { confirmed_at: same ? s.day_before_confirmed_at : null, changed: !same }
}

// ---------- 遅刻・早退の判定（#219 #497） ----------
// 報告を書き込むとき（アプリ・写真付き・報告用URL・代理入力。打刻修正の承認でも）にこの関数で判定し、
// attendance_reports の status（'late'）・late_minutes・early_leave_minutes に保存する。集計・画面は保存された値を読む
//   遅刻: 入店・勤務開始が、シフト開始の絶対日時より後（分単位）。late_minutes に遅れた分数を入れ、
//         会社設定の猶予（settings_json.late_grace_minutes）を超えたら late。勤務開始だけで運用する案件でも判定する
//   早退: 勤務終了・退店が、シフト終了の絶対日時より前。early_leave_minutes に早かった分数を入れる（0 なら早退でない。status は変えない）
//   ほかの報告は、どちらも NULL
export const LATE_TYPES = ['check_in', 'work_start']
export const EARLY_LEAVE_TYPES = ['work_end', 'check_out']
export const MAX_LATE_GRACE_MINUTES = 120
export type LatenessSettings = { grace_minutes: number }
export type ReportLateness = { report_type: string; late: boolean; late_minutes: number | null; early_leave_minutes: number | null }

// 会社設定（companies.settings_json）から遅刻の猶予を読む。未設定・不正なら 0 分
export function latenessSettings(settingsJson: any): LatenessSettings {
  let g = 0
  try {
    const v = JSON.parse(settingsJson || '{}').late_grace_minutes
    if (Number.isInteger(v) && v >= 0 && v <= MAX_LATE_GRACE_MINUTES) g = v
  } catch { }
  return { grace_minutes: g }
}
// a から b までの分数（'YYYY-MM-DD HH:MM[:SS]'。秒は切り捨てて分で比べる）
const minuteOf = (t: string) => Date.parse(String(t).slice(0, 16).replace(' ', 'T') + ':00Z') / 60000
const minutesFromTo = (a: string, b: string) => Math.round(minuteOf(b) - minuteOf(a))

export function lateness(shift: ShiftTimes, reports: { report_type: string; reported_at: string }[], settings: LatenessSettings): ReportLateness[] {
  const w = shiftWindow(shift.work_date, shift.start_time, shift.end_time)
  return reports.map(r => {
    if (LATE_TYPES.includes(r.report_type)) {
      const m = Math.max(0, minutesFromTo(w.start, r.reported_at))
      return { report_type: r.report_type, late: m > settings.grace_minutes, late_minutes: m, early_leave_minutes: null }
    }
    if (EARLY_LEAVE_TYPES.includes(r.report_type)) {
      return { report_type: r.report_type, late: false, late_minutes: null, early_leave_minutes: Math.max(0, minutesFromTo(r.reported_at, w.end)) }
    }
    return { report_type: r.report_type, late: false, late_minutes: null, early_leave_minutes: null }
  })
}
// 本人の報告の status。遅刻なら late、位置が取れなかった入店は no_location、それ以外は normal（位置の扱いは従来どおり入店のみ）
export function reportStatus(j: ReportLateness, latitude: any): 'late' | 'no_location' | 'normal' {
  if (j.late) return 'late'
  return j.report_type === 'check_in' && latitude == null ? 'no_location' : 'normal'
}

// ---------- 設定の読み書き ----------
type Actor = { user_id: number; name: string; role: string }
const actorOf = (u: any): Actor => ({ user_id: u.user_id, name: u.name, role: u.role })

async function projectDefaults(db: D1Database, projectId: number): Promise<Record<string, number>> {
  const rows = (await db.prepare('SELECT report_type, enabled FROM project_report_defaults WHERE project_id = ?').bind(projectId).all()).results as any[]
  const out: Record<string, number> = {}
  for (const t of REPORT_TYPES) out[t] = 1
  for (const r of rows) if (isReportType(r.report_type)) out[r.report_type] = r.enabled ? 1 : 0
  return out
}
// 所属スタッフの在籍状況（SQL の式。sp = staff_profiles、us = users）
//   merged = 統合済み / retired = 退職・停止 / ended = 他社連携の取引終了 / leave = 休職 / active = 在籍
// retired・merged・ended は一括変更と「今の所属スタッフにも適用」の対象にしない（#247 #379）
const MEMBER_STATUS_SQL = `CASE WHEN sp.merged_into_staff_id IS NOT NULL THEN 'merged'
  WHEN COALESCE(sp.employment_status, 'working') = 'retired' OR us.status != 'active' THEN 'retired'
  WHEN sp.link_ended_at IS NOT NULL THEN 'ended'
  WHEN sp.employment_status = 'leave' THEN 'leave' ELSE 'active' END`
const INACTIVE_STATUSES = ['retired', 'merged', 'ended']
const isInactive = (status: any) => INACTIVE_STATUSES.includes(status)
// 案件にシフトがあるスタッフ（= 所属スタッフ）
async function projectMemberIds(db: D1Database, companyId: number, projectId: number): Promise<number[]> {
  return [...(await projectMemberStatus(db, companyId, projectId)).keys()]
}
// 所属スタッフと在籍状況（staff_id → member_status）
async function projectMemberStatus(db: D1Database, companyId: number, projectId: number): Promise<Map<number, string>> {
  const rows = (await db.prepare(`SELECT m.staff_id, ${MEMBER_STATUS_SQL} AS member_status
    FROM (SELECT DISTINCT staff_id FROM shifts WHERE project_id = ? AND company_id = ?) m
    LEFT JOIN staff_profiles sp ON sp.staff_id = m.staff_id LEFT JOIN users us ON us.user_id = sp.user_id`).bind(projectId, companyId).all()).results as any[]
  return new Map(rows.map(r => [r.staff_id as number, String(r.member_status)]))
}
// 設定の種類（#268）
//   none       = 行がない（案件の標準設定に従う）
//   inherited  = 標準設定の変更の前に、その時点の値で固定した行・導入時の移行の行だけ（標準（引き継ぎ））
//   individual = 個別変更・一括変更の行がある（個別）
//   legacy     = 行がなく、0027 より前のスタッフ単位の設定（none / in_out）を使っている（個別の扱い）
export type SettingKind = 'none' | 'inherited' | 'individual' | 'legacy'
type StaffSetting = { values: Record<string, number>; hasRows: boolean; kind: SettingKind; legacy_mode: string | null }
const EXPLICIT_SOURCES = ['individual', 'bulk']
// スタッフ別の値（行がなければ、0027 より前のスタッフ単位の設定（none / in_out）か案件の標準設定）
async function staffSettings(db: D1Database, projectId: number, staffIds: number[], defaults: Record<string, number>) {
  const out = new Map<number, StaffSetting>()
  for (const id of staffIds) out.set(id, emptySetting(defaults))
  for (let i = 0; i < staffIds.length; i += 90) {
    const chunk = staffIds.slice(i, i + 90)
    const legacy = (await db.prepare(`SELECT staff_id, attendance_mode FROM staff_profiles WHERE staff_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results as any[]
    for (const r of legacy) { const s = out.get(r.staff_id); if (s) applyLegacy(s, r.attendance_mode) }
    const rows = (await db.prepare(`SELECT staff_id, report_type, enabled, source FROM project_staff_report_settings WHERE project_id = ? AND staff_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(projectId, ...chunk).all()).results as any[]
    for (const r of rows) { const s = out.get(r.staff_id); if (s) applyRow(s, r, defaults) }
  }
  return out
}
const emptySetting = (defaults: Record<string, number>): StaffSetting => ({ values: { ...defaults }, hasRows: false, kind: 'none', legacy_mode: null })
function applyLegacy(s: StaffSetting, mode: any) {
  const flags = legacyStaffFlags(mode)
  if (flags && !s.hasRows) { s.values = flags; s.legacy_mode = mode; s.kind = 'legacy' }
}
function applyRow(s: StaffSetting, r: { report_type: string; enabled: any; source: string }, defaults: Record<string, number>) {
  if (!isReportType(r.report_type)) return
  // 行がある組み合わせは、スタッフ単位の旧設定を使わない（attendanceTypesForShifts と同じ）
  if (!s.hasRows) { s.values = { ...defaults }; s.legacy_mode = null; s.kind = 'inherited' }
  s.values[r.report_type] = r.enabled ? 1 : 0; s.hasRows = true
  if (EXPLICIT_SOURCES.includes(r.source)) s.kind = 'individual'
}
// 画面の『個別』の印: 個別変更・一括変更をした人と、スタッフ単位の旧設定を使っている人
const isCustom = (s: StaffSetting) => s.kind === 'individual' || s.kind === 'legacy'

// 報告を始めたシフト（稼働日が昨日・今日で、報告が 1 つ以上ある）の、設定を変える前の有効な報告を記録する文を返す。
// 勤務の途中で ON にした報告は、そのシフトでは求めない（次のシフトから効く。#458）。OFF にした報告はすぐ外れる
async function freezeStartedShifts(db: D1Database, companyId: number, projectId: number, staffIds: number[]): Promise<D1PreparedStatement[]> {
  if (!staffIds.length) return []
  const today = nowJST().slice(0, 10)
  const ids = ((await db.prepare(`SELECT s.shift_id FROM shifts s
    WHERE s.project_id = ? AND s.company_id = ? AND s.staff_id IN ${JSON_IN} AND s.work_date >= ? AND s.status != 'absent'
      AND s.attendance_types_fixed IS NULL AND EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id)`)
    .bind(projectId, companyId, bindJsonArray(staffIds), addDays(today, -1)).all()).results as any[]).map(r => r.shift_id as number)
  if (!ids.length) return []
  const current = await attendanceTypesForShifts(db, ids)
  // 同じ値のシフトをまとめて 1 文で書く（シフトの例外 none / in_out はシフトの設定が優先するので固定しない）
  const groups = new Map<string, number[]>()
  for (const id of ids) {
    const a = current.get(id); if (!a || a.source === 'shift') continue
    const key = JSON.stringify(a.types)
    if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(id)
  }
  return [...groups].map(([types, sids]) => db.prepare(`UPDATE shifts SET attendance_types_fixed = ? WHERE shift_id IN ${JSON_IN} AND attendance_types_fixed IS NULL`).bind(types, bindJsonArray(sids)))
}
function newBatchId(): string {
  const a = new Uint8Array(8); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
// 案件 × スタッフ別の行の書き込み。同じ（種類・値・由来）のスタッフをまとめて 1 文で書く（json_each）。
// 文の数はスタッフの人数で増えない（最大 8 種類 × 2 値 × 由来の数）ため、人数の多い案件でも D1 の batch の上限に当たらない（#247）
type Cell = { staffId: number; t: string; enabled: number; source: string }
function upsertCells(db: D1Database, companyId: number, projectId: number, cells: Cell[], by: number | null, at: string): D1PreparedStatement[] {
  const groups = new Map<string, { c: Cell; ids: number[] }>()
  for (const c of cells) {
    const k = `${c.t}|${c.enabled}|${c.source}`
    if (!groups.has(k)) groups.set(k, { c, ids: [] }); groups.get(k)!.ids.push(c.staffId)
  }
  // INSERT ... SELECT に ON CONFLICT を付けるときは、構文の曖昧さを避けるため WHERE が要る
  return [...groups.values()].map(({ c, ids }) => db.prepare(`INSERT INTO project_staff_report_settings (project_id, staff_id, company_id, report_type, enabled, source, updated_by, updated_at)
    SELECT ?, j.value, ?, ?, ?, ?, ?, ? FROM json_each(?) j WHERE 1
    ON CONFLICT(project_id, staff_id, report_type) DO UPDATE SET enabled = excluded.enabled, source = excluded.source, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(projectId, companyId, c.t, c.enabled, c.source, by, at, bindJsonArray(ids)))
}
// 履歴の書き込み。同じ（種類・変更前・変更後）のスタッフをまとめて 1 文で書く。staffId が null の行は案件の標準設定の変更
type LogCell = { staffId: number | null; t: string; oldV: number | null; newV: number }
type LogExtra = { shift_id?: number | null; detail?: string | null }
function logCells(db: D1Database, companyId: number, projectId: number, cells: LogCell[], action: string, batchId: string, a: Actor | null, at: string, extra: LogExtra = {}): D1PreparedStatement[] {
  const cols = `(company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, batch_id, changed_by, changed_by_name, changed_by_role, created_at, shift_id, detail)`
  const tail = [action, batchId, a?.user_id ?? null, a?.name ?? null, a?.role ?? null, at, extra.shift_id ?? null, extra.detail ?? null]
  const stmts: D1PreparedStatement[] = []
  const groups = new Map<string, { c: LogCell; ids: number[] }>()
  for (const c of cells) {
    if (c.staffId == null) {
      stmts.push(db.prepare(`INSERT INTO report_setting_logs ${cols} VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(companyId, projectId, c.t, c.oldV, c.newV, ...tail))
      continue
    }
    const k = `${c.t}|${c.oldV}|${c.newV}`
    if (!groups.has(k)) groups.set(k, { c, ids: [] }); groups.get(k)!.ids.push(c.staffId)
  }
  for (const { c, ids } of groups.values()) {
    stmts.push(db.prepare(`INSERT INTO report_setting_logs ${cols} SELECT ?, ?, j.value, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM json_each(?) j`)
      .bind(companyId, projectId, c.t, c.oldV, c.newV, ...tail, bindJsonArray(ids)))
  }
  return stmts
}
async function runBatch(db: D1Database, stmts: D1PreparedStatement[]) {
  // D1 の batch は 1 トランザクション。途中で失敗したら全体が取り消される
  if (stmts.length) await db.batch(stmts)
}

// 案件の標準設定の版番号（楽観ロック。#509）
async function defaultsVersion(db: D1Database, projectId: number): Promise<number> {
  return Number(((await db.prepare('SELECT report_defaults_version AS v FROM projects WHERE project_id = ?').bind(projectId).first()) as any)?.v || 0)
}

// 案件の標準設定を変える（docs 2.5）。apply で、今の所属スタッフにも当てるかを選ぶ（#329）
//   none     : 変える前に、個別の行がない所属スタッフへ今の値を固定する（標準設定の変更は新しく所属するスタッフにだけ効く）
//   standard : 個別に変えていない在籍中の所属スタッフにも当てる（個別に変えた人・退職者などは今の値で固定）
//   all      : 個別に変えた人を含め、在籍中の所属スタッフ全員に当てる（変えた種類だけを上書きする）
// version を渡すと、画面を開いた時点の版番号と比べ、ほかの人が先に変えていたら conflict を返す（#509）
export type ApplyScope = 'none' | 'standard' | 'all'
export async function setProjectDefaults(db: D1Database, companyId: number, projectId: number, next: Record<string, any>, u: any,
  opts: { apply?: ApplyScope; version?: number | null } = {}, retried = false): Promise<{ conflict?: boolean; changed: number; applied_staff: number; version: number }> {
  // 版番号を先に読む（標準設定・所属スタッフの値はその後に読むので、読んだ後の変更は版番号の照合で必ず分かる）
  const version = await defaultsVersion(db, projectId)
  const cur = await projectDefaults(db, projectId)
  if (opts.version != null && opts.version !== version) return { conflict: true, changed: 0, applied_staff: 0, version }
  const changed = REPORT_TYPES.filter(t => next[t] !== undefined && (next[t] ? 1 : 0) !== cur[t])
  if (!changed.length) return { changed: 0, applied_staff: 0, version }
  const apply = opts.apply || 'none'
  const nv = (t: string) => next[t] ? 1 : 0
  const at = nowJST(), batchId = newBatchId(), a = actorOf(u)
  const members = await projectMemberStatus(db, companyId, projectId)
  const settings = await staffSettings(db, projectId, [...members.keys()], cur)
  const cells: Cell[] = [], staffLogs: LogCell[] = [], applied: number[] = []
  for (const [staffId, s] of settings) {
    // 旧設定（スタッフ単位の none / in_out）の値は本人に明示した設定なので、固定するときも『個別』として残す
    const keepSource = s.legacy_mode ? 'individual' : 'default'
    const target = apply !== 'none' && !isInactive(members.get(staffId)) && (apply === 'all' || !isCustom(s))
    if (!target) {
      if (s.hasRows) continue
      // 今の値（標準設定。スタッフ単位の旧設定がある人はその値）を固定する
      cells.push(...REPORT_TYPES.map(t => ({ staffId, t, enabled: s.values[t], source: keepSource })))
      continue
    }
    const diff = changed.filter(t => s.values[t] !== nv(t))
    if (diff.length) { applied.push(staffId); staffLogs.push(...diff.map(t => ({ staffId, t, oldV: s.values[t], newV: nv(t) }))) }
    // 行のない人は書かずに、変更後の標準設定に従わせる
    if (s.kind === 'none') continue
    // 行のある人・旧設定の人は、変えた種類だけを変更後の値にする（旧設定の人は 8 種類の行を作る）
    cells.push(...REPORT_TYPES.filter(t => changed.includes(t) || !s.hasRows)
      .map(t => changed.includes(t) ? { staffId, t, enabled: nv(t), source: 'default' } : { staffId, t, enabled: s.values[t], source: keepSource }))
  }
  const stmts: D1PreparedStatement[] = []
  // 版番号を進める。読んだ後にほかの人が保存して版が変わっていたら NULL を入れ、NOT NULL 制約で batch 全体を取り消す
  // （読んでから書くまでの間に同時に保存されても上書きしない）
  stmts.push(db.prepare('UPDATE projects SET report_defaults_version = CASE WHEN COALESCE(report_defaults_version, 0) = ? THEN COALESCE(report_defaults_version, 0) + 1 ELSE NULL END WHERE project_id = ? AND company_id = ?')
    .bind(version, projectId, companyId))
  // 当てる人の、報告を始めたシフトは変える前の設定で固定する
  stmts.push(...await freezeStartedShifts(db, companyId, projectId, applied))
  for (const t of changed) {
    stmts.push(db.prepare(`INSERT INTO project_report_defaults (project_id, company_id, report_type, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, report_type) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(projectId, companyId, t, nv(t), a.user_id, at))
  }
  stmts.push(...upsertCells(db, companyId, projectId, cells, a.user_id, at))
  stmts.push(...logCells(db, companyId, projectId, changed.map(t => ({ staffId: null, t, oldV: cur[t], newV: nv(t) })), 'project_default', batchId, a, at))
  // 今の所属スタッフに当てた分は、スタッフごとに履歴を残す（同じ batch_id）
  stmts.push(...logCells(db, companyId, projectId, staffLogs, 'default_apply', batchId, a, at))
  try {
    await runBatch(db, stmts)
  } catch (e) {
    const now = await defaultsVersion(db, projectId)
    if (now === version) throw e
    // 版番号を指定しない呼び出し（案件の編集の勤怠報告など）は、最新の値で 1 回だけやり直す
    if (opts.version == null && !retried) return setProjectDefaults(db, companyId, projectId, next, u, opts, true)
    return { conflict: true, changed: 0, applied_staff: 0, version: now }
  }
  return { changed: changed.length, applied_staff: applied.length, version: version + 1 }
}

// スタッフ別の設定を変える（individual / bulk）。changes: staffId → { type: 0|1 }
async function setStaffSettings(db: D1Database, companyId: number, projectId: number, changes: Map<number, Record<string, number>>, action: 'individual' | 'bulk', u: any) {
  const defaults = await projectDefaults(db, projectId)
  const settings = await staffSettings(db, projectId, [...changes.keys()], defaults)
  const at = nowJST(), batchId = newBatchId(), a = actorOf(u)
  const stmts: D1PreparedStatement[] = []
  let staffChanged = 0, cellCount = 0
  // 報告を始めたシフトは、変える前の設定で固定してから変更する（同じ batch で書く）
  const changedIds = [...changes].filter(([id, next]) => REPORT_TYPES.some(t => next[t] !== undefined && next[t] !== settings.get(id)!.values[t])).map(([id]) => id)
  stmts.push(...await freezeStartedShifts(db, companyId, projectId, changedIds))
  const cells: Cell[] = [], logs: LogCell[] = []
  for (const [staffId, next] of changes) {
    const s = settings.get(staffId)!, cur = s.values
    const diff = REPORT_TYPES.filter(t => next[t] !== undefined && next[t] !== cur[t])
    if (!diff.length) continue
    staffChanged++; cellCount += diff.length
    // 8 種類すべての行を持たせる（変えない種類は今の値のまま。由来は変えた種類のみ更新）
    cells.push(...REPORT_TYPES.filter(t => diff.includes(t) || !s.hasRows)
      .map(t => diff.includes(t) ? { staffId, t, enabled: next[t], source: action } : { staffId, t, enabled: cur[t], source: s.legacy_mode ? 'individual' : 'default' }))
    logs.push(...diff.map(t => ({ staffId, t, oldV: cur[t], newV: next[t] })))
  }
  stmts.push(...upsertCells(db, companyId, projectId, cells, a.user_id, at))
  stmts.push(...logCells(db, companyId, projectId, logs, action, batchId, a, at))
  await runBatch(db, stmts)
  return { staff_changed: staffChanged, cells: cellCount, batch_id: staffChanged ? batchId : null }
}

// スタッフにシフトがある案件
async function staffProjectIds(db: D1Database, companyId: number, staffId: number): Promise<number[]> {
  return ((await db.prepare('SELECT DISTINCT project_id FROM shifts WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).all()).results as any[]).map(r => r.project_id)
}

// 旧来のスタッフ単位の提出設定 API（PUT /admin/staff/:id/report-settings）の勤怠部分: 所属する全案件の設定を置き換える
// mode = '' / null は「案件の標準設定に戻す」（案件 × スタッフ別の行を消し、スタッフ単位の値も消す。#413）
export async function applyLegacyStaffMode(db: D1Database, companyId: number, staffId: number, mode: any, u: any) {
  if (!mode) return { projects: (await resetStaffSettings(db, companyId, staffId, null, u)).projects }
  const projects = await staffProjectIds(db, companyId, staffId)
  for (const pid of projects) await setStaffSettings(db, companyId, pid, new Map([[staffId, flagsFromLegacyMode(mode)]]), 'individual', u)
  // スタッフ単位の値も保存する（これから所属する案件で、案件 × スタッフ別の行がない間に使う）
  await db.prepare('UPDATE staff_profiles SET attendance_mode = ? WHERE staff_id = ? AND company_id = ?').bind(mode, staffId, companyId).run()
  return { projects: projects.length }
}

// スタッフの設定を案件の標準設定に戻す（#413）。案件 × スタッフ別の行を消して、標準設定に従う状態にする。
// projectIds が null なら、シフトのあるすべての案件。すべての案件を戻すときは、スタッフ単位の旧設定（none / in_out）も消す。
// 一部の案件だけを戻すときに旧設定が残っている場合は、行を消すと旧設定が効くため、標準設定の値で行を作る（標準（引き継ぎ））
export async function resetStaffSettings(db: D1Database, companyId: number, staffId: number, projectIds: number[] | null, u: any) {
  const all = await staffProjectIds(db, companyId, staffId)
  const targets = projectIds ? all.filter(p => projectIds.includes(p)) : all
  const legacyMode = ((await db.prepare('SELECT attendance_mode FROM staff_profiles WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).first()) as any)?.attendance_mode
  const hasLegacy = !!legacyStaffFlags(legacyMode)
  const clearLegacy = hasLegacy && targets.length === all.length
  const at = nowJST(), batchId = newBatchId(), a = actorOf(u)
  let projects = 0, cells = 0
  for (const pid of targets) {
    const defaults = await projectDefaults(db, pid)
    const s = (await staffSettings(db, pid, [staffId], defaults)).get(staffId)!
    const diff = REPORT_TYPES.filter(t => s.values[t] !== defaults[t])
    if (!s.hasRows && !diff.length) continue
    const stmts: D1PreparedStatement[] = [...await freezeStartedShifts(db, companyId, pid, diff.length ? [staffId] : [])]
    stmts.push(db.prepare('DELETE FROM project_staff_report_settings WHERE project_id = ? AND staff_id = ? AND company_id = ?').bind(pid, staffId, companyId))
    if (hasLegacy && !clearLegacy) stmts.push(...upsertCells(db, companyId, pid, REPORT_TYPES.map(t => ({ staffId, t, enabled: defaults[t], source: 'default' })), a.user_id, at))
    stmts.push(...logCells(db, companyId, pid, diff.map(t => ({ staffId, t, oldV: s.values[t], newV: defaults[t] })), 'staff_reset', batchId, a, at))
    await runBatch(db, stmts)
    projects++; cells += diff.length
  }
  if (clearLegacy) await db.prepare('UPDATE staff_profiles SET attendance_mode = NULL WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).run()
  return { projects, cells, batch_id: projects ? batchId : null }
}

// シフト単位の例外（shifts.attendance_mode）を変えたときの履歴の文（#313）。
// shift は shifts の行（s.*）に sp_att（staff_profiles.attendance_mode）を加えたもの。例外が変わらなければ空
const SHIFT_MODE_LABEL: Record<string, string> = { full: '案件報告管理の設定どおり', none: '勤怠報告なし', in_out: '入店・退店のみ' }
const normShiftMode = (m: any) => m === 'none' || m === 'in_out' ? m : 'full'
export async function shiftOverrideLogStatements(db: D1Database, companyId: number, shift: any, nextMode: any, u: any): Promise<D1PreparedStatement[]> {
  const from = normShiftMode(shift.attendance_mode), to = normShiftMode(nextMode)
  if (from === to) return []
  const row = { shift_id: shift.shift_id, project_id: shift.project_id, staff_id: shift.staff_id, attendance_types_fixed: shift.attendance_types_fixed, legacy_mode: shift.sp_att }
  const before = (await attendanceTypesForRows(db, [{ ...row, attendance_mode: shift.attendance_mode }])).get(shift.shift_id)!.types
  const after = (await attendanceTypesForRows(db, [{ ...row, attendance_mode: nextMode }])).get(shift.shift_id)!.types
  let cells: LogCell[] = REPORT_TYPES.filter(t => before.includes(t) !== after.includes(t))
    .map(t => ({ staffId: shift.staff_id, t, oldV: before.includes(t) ? 1 : 0, newV: after.includes(t) ? 1 : 0 }))
  // 有効な報告が変わらない変更も、誰がいつ例外を付けたかを残す（入店報告の行に、変更前と同じ値で記録する）
  if (!cells.length) { const v = after.includes('check_in') ? 1 : 0; cells = [{ staffId: shift.staff_id, t: 'check_in', oldV: v, newV: v }] }
  const detail = `${shift.work_date} ${shift.start_time || ''}〜${shift.end_time || ''} のシフト: ${SHIFT_MODE_LABEL[from]} → ${SHIFT_MODE_LABEL[to]}`
  return logCells(db, companyId, shift.project_id, cells, 'shift_override', newBatchId(), actorOf(u), nowJST(), { shift_id: shift.shift_id, detail })
}

// ---------- 管理者 API ----------
export const reportSettingsApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// クライアントは案件と同じ会社のものだけを結ぶ（他社のクライアント名を出さない。#22）
const CLIENT_JOIN = 'LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id'
async function ownProject(db: D1Database, companyId: number, id: any) {
  return db.prepare(`SELECT p.project_id, p.project_name, p.status, p.attendance_mode, cl.client_name, COALESCE(p.report_defaults_version, 0) AS defaults_version
    FROM projects p ${CLIENT_JOIN} WHERE p.project_id = ? AND p.company_id = ?`)
    .bind(id, companyId).first() as Promise<any>
}
async function ownStaffRow(db: D1Database, companyId: number, id: any) {
  return db.prepare(`SELECT sp.staff_id, us.name, sp.attendance_mode, ${MEMBER_STATUS_SQL} AS member_status
    FROM staff_profiles sp LEFT JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(Number(id) || 0, companyId).first() as Promise<any>
}
function parseSettings(b: any): Record<string, number> | null {
  if (!b || typeof b !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(b)) {
    if (!isReportType(k) || typeof v !== 'boolean') return null
    out[k] = v ? 1 : 0
  }
  return Object.keys(out).length ? out : null
}
function parseIdList(v: any): number[] | null {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v)) return []
  return [...new Set(v.map(Number))].filter(n => Number.isInteger(n) && n > 0)
}
function todayJST(): string { return nowJST().slice(0, 10) }

// 前日確認の設定（#176）。ほかの会社設定を上書きしないよう、この項目だけを書き換える
reportSettingsApi.get('/report-settings/day-before-check', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json(dayBeforeSettings(row?.settings_json))
})
reportSettingsApi.put('/report-settings/day-before-check', async (c) => {
  const u = c.get('user')
  const b = await c.req.json().catch(() => ({} as any))
  if (typeof b.enabled !== 'boolean') return c.json({ error: '使うかどうかを指定してください' }, 400)
  if (!isHm(b.deadline)) return c.json({ error: '締切の時刻は 00:00〜23:59 で入力してください' }, 400)
  const v = { enabled: b.enabled, deadline: b.deadline }
  await c.env.DB.prepare(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.day_before_check', json(?)) WHERE company_id = ?`)
    .bind(JSON.stringify(v), u.company_id).run()
  return c.json({ ok: true, ...v })
})

const TOO_MANY ='保存に失敗しました。設定は変更されていません。対象が多い場合は、スタッフを分けて実行してください'

// 案件一覧（終了した案件は include_closed=1 で表示）。
// 個別設定のある人数と、OFF の報告がある在籍中の所属スタッフの人数も返す（#446）
reportSettingsApi.get('/report-settings/projects', async (c) => {
  const u = c.get('user')
  const includeClosed = c.req.query('include_closed') === '1'
  const rows = (await c.env.DB.prepare(`SELECT p.project_id, p.project_name, p.status, cl.client_name,
      (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.project_id = p.project_id) AS member_count,
      (SELECT COUNT(*) FROM project_report_defaults d WHERE d.project_id = p.project_id AND d.enabled = 0) AS default_off,
      (SELECT COUNT(DISTINCT r.staff_id) FROM project_staff_report_settings r WHERE r.project_id = p.project_id AND r.source IN ('individual', 'bulk')) AS custom_count,
      (SELECT COUNT(DISTINCT r.staff_id) FROM project_staff_report_settings r JOIN staff_profiles sp ON sp.staff_id = r.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
        WHERE r.project_id = p.project_id AND r.enabled = 0 AND ${MEMBER_STATUS_SQL} NOT IN ('retired', 'merged', 'ended')) AS off_staff_count
    FROM projects p ${CLIENT_JOIN}
    WHERE p.company_id = ? ${includeClosed ? '' : "AND COALESCE(p.status, 'active') = 'active'"}
    ORDER BY CASE WHEN COALESCE(p.status, 'active') = 'active' THEN 0 ELSE 1 END, p.project_name`).bind(u.company_id).all()).results
  return c.json({ projects: rows })
})

// 案件詳細: 標準設定（版番号つき）・所属スタッフ別の設定（在籍状況・設定の種類・今後のシフトの例外の件数）
reportSettingsApi.get('/report-settings/projects/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const defaults = await projectDefaults(db, p.project_id)
  const today = todayJST()
  const members = (await db.prepare(`SELECT s.staff_id, us.name, COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type,
      MIN(s.work_date) AS first_date, MAX(s.work_date) AS last_date,
      SUM(CASE WHEN s.work_date >= ? AND s.status != 'absent' THEN 1 ELSE 0 END) AS upcoming,
      SUM(CASE WHEN s.work_date >= ? AND s.status != 'absent' AND s.attendance_mode IN ('none', 'in_out') THEN 1 ELSE 0 END) AS upcoming_exceptions,
      ${MEMBER_STATUS_SQL} AS member_status
    FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE s.project_id = ? AND s.company_id = ? GROUP BY s.staff_id ORDER BY us.name`).bind(today, today, p.project_id, u.company_id).all()).results as any[]
  const settings = await staffSettings(db, p.project_id, members.map(m => m.staff_id), defaults)
  return c.json({
    project: { project_id: p.project_id, project_name: p.project_name, status: p.status || 'active', client_name: p.client_name },
    report_types: REPORT_TYPES, labels: REPORT_LABEL, defaults, defaults_version: p.defaults_version,
    // kind: none（標準）/ inherited（標準（引き継ぎ））/ individual（個別）/ legacy（スタッフ単位の旧設定）。individual は画面の『個別』の印（#268）
    // legacy_mode: 0027 より前のスタッフ単位の設定（none / in_out）を使っている人
    staff: members.map(m => {
      const s = settings.get(m.staff_id)!
      return { ...m, settings: s.values, kind: s.kind, individual: isCustom(s), legacy_mode: s.legacy_mode }
    }),
  })
})

// 標準設定の変更。version は画面を開いた時点の版番号（違えば 409。#509）。
// apply: none = 新しく所属するスタッフにだけ / standard = 個別に変えていない今の所属スタッフにも / all = 今の所属スタッフ全員にも（#329）
reportSettingsApi.put('/report-settings/projects/:id/default', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const next = parseSettings(b.settings)
  if (!next) return c.json({ error: '設定値が正しくありません' }, 400)
  const apply = b.apply === undefined ? 'none' : b.apply
  if (!['none', 'standard', 'all'].includes(apply)) return c.json({ error: '適用の範囲が正しくありません' }, 400)
  const version = b.version === undefined || b.version === null ? null : Number(b.version)
  if (version !== null && !Number.isInteger(version)) return c.json({ error: '版番号が正しくありません' }, 400)
  try {
    const r = await setProjectDefaults(db, u.company_id, p.project_id, next, u, { apply, version })
    if (r.conflict) return c.json({ error: 'ほかの人が標準設定を変更しました。画面を読み込み直してから、もう一度変更してください', conflict: true, version: r.version }, 409)
    return c.json({ ok: true, ...r })
  } catch {
    return c.json({ error: TOO_MANY }, 500)
  }
})

// スタッフ別の変更（1 人）
reportSettingsApi.put('/report-settings/projects/:id/staff/:staffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const staffId = Number(c.req.param('staffId'))
  if (!(await projectMemberIds(db, u.company_id, p.project_id)).includes(staffId)) return c.json({ error: 'この案件に所属していないスタッフです' }, 404)
  const next = parseSettings((await c.req.json().catch(() => ({} as any))).settings)
  if (!next) return c.json({ error: '設定値が正しくありません' }, 400)
  const r = await setStaffSettings(db, u.company_id, p.project_id, new Map([[staffId, next]]), 'individual', u)
  return c.json({ ok: true, ...r })
})

// 一括変更。dry_run で確認内容（対象者ごとの変更前・変更後、影響人数）と確認トークンを返す。
// 保存時は確認トークンを送る。確認後に設定が変わっていた場合（別の操作・二重送信）は 409 で再確認を求める。
// 退職・統合済み・取引終了のスタッフは対象にしない（#247）
reportSettingsApi.post('/report-settings/projects/:id/bulk', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await ownProject(db, u.company_id, c.req.param('id'))
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const types = Array.isArray(b.report_types) ? [...new Set(b.report_types)].filter(isReportType) as string[] : []
  if (!types.length || types.length !== new Set(b.report_types).size) return c.json({ error: '報告の種類を選択してください' }, 400)
  if (typeof b.enabled !== 'boolean') return c.json({ error: 'ON / OFF を選択してください' }, 400)
  const members = await projectMemberStatus(db, u.company_id, p.project_id)
  const staffIds = Array.isArray(b.staff_ids) ? [...new Set(b.staff_ids.map(Number))] as number[] : []
  if (!staffIds.length) return c.json({ error: '対象のスタッフを選択してください' }, 400)
  if (staffIds.some(id => !members.has(id))) return c.json({ error: 'この案件に所属していないスタッフが含まれています' }, 400)
  if (staffIds.some(id => isInactive(members.get(id)))) return c.json({ error: '退職・統合済み・取引終了のスタッフは一括変更の対象にできません。選択から外してください' }, 400)
  const v = b.enabled ? 1 : 0
  const defaults = await projectDefaults(db, p.project_id)
  const settings = await staffSettings(db, p.project_id, staffIds, defaults)
  const names = new Map<number, string>()
  for (let i = 0; i < staffIds.length; i += 90) {
    const chunk = staffIds.slice(i, i + 90)
    for (const r of (await db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results as any[]) names.set(r.staff_id, r.name)
  }
  const upcoming = new Set(((await db.prepare(`SELECT DISTINCT staff_id FROM shifts WHERE project_id = ? AND company_id = ? AND work_date >= ? AND status != 'absent'`)
    .bind(p.project_id, u.company_id, todayJST()).all()).results as any[]).map(r => r.staff_id))
  const preview = staffIds.map(id => {
    const before = settings.get(id)!.values
    const after = { ...before }; for (const t of types) after[t] = v
    return { staff_id: id, name: names.get(id) || '', before, after, changed: types.some(t => before[t] !== v), upcoming: upcoming.has(id) }
  })
  const changedRows = preview.filter(r => r.changed)
  // 確認トークン: 対象・変更内容・現在の値から作る。保存までに値が変わると一致しない
  const token = await sha256(JSON.stringify([p.project_id, types.slice().sort(), v, staffIds.slice().sort((a, b) => a - b), preview.map(r => [r.staff_id, types.map(t => r.before[t])])]))
  if (b.dry_run) {
    return c.json({
      report_types: types, enabled: b.enabled, target_count: staffIds.length, changed_count: changedRows.length,
      affected_upcoming: v === 0 ? changedRows.filter(r => r.upcoming).length : 0, rows: preview, confirm_token: token,
    })
  }
  if (b.confirm_token !== token) return c.json({ error: '確認後に設定が変わりました。もう一度内容を確認してください', need_confirm: true }, 409)
  const changes = new Map<number, Record<string, number>>()
  for (const r of changedRows) changes.set(r.staff_id, Object.fromEntries(types.map(t => [t, v])))
  try {
    const r = await setStaffSettings(db, u.company_id, p.project_id, changes, 'bulk', u)
    return c.json({ ok: true, ...r, target_count: staffIds.length })
  } catch {
    return c.json({ error: TOO_MANY }, 500)
  }
})

// ---------- シフト単位の例外（#313） ----------
// 今日以降のシフトのうち、シフト単位の例外（勤怠報告なし・入店・退店のみ）があるもの。project_id・staff_id で絞り込む
async function upcomingExceptions(db: D1Database, companyId: number, f: { project_id?: number; staff_id?: number; include_closed?: boolean }, limit = 300) {
  const w = ["s.company_id = ?", 's.work_date >= ?', "s.status != 'absent'", "s.attendance_mode IN ('none', 'in_out')"]
  const bind: any[] = [companyId, todayJST()]
  if (f.project_id) { w.push('s.project_id = ?'); bind.push(f.project_id) }
  if (f.staff_id) { w.push('s.staff_id = ?'); bind.push(f.staff_id) }
  if (!f.include_closed) w.push("COALESCE(p.status, 'active') = 'active'")
  return (await db.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.attendance_mode, s.project_id, p.project_name, s.staff_id, us.name AS staff_name
    FROM shifts s JOIN projects p ON p.project_id = s.project_id LEFT JOIN staff_profiles sp ON sp.staff_id = s.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE ${w.join(' AND ')} ORDER BY s.work_date, s.start_time, s.shift_id LIMIT ?`).bind(...bind, limit).all()).results as any[]
}
reportSettingsApi.get('/report-settings/exceptions', async (c) => {
  const u = c.get('user')
  const rows = await upcomingExceptions(c.env.DB, u.company_id, {
    project_id: Number(c.req.query('project_id')) || undefined, staff_id: Number(c.req.query('staff_id')) || undefined,
    include_closed: c.req.query('include_closed') === '1',
  })
  return c.json({ exceptions: rows })
})

// ---------- スタッフ 1 人の全案件の設定（#413） ----------
// スタッフにシフトがある案件ごとの、標準設定・スタッフ別の値・設定の種類・今後のシフト
async function staffProjectSettings(db: D1Database, companyId: number, staffId: number, legacyMode: any) {
  const today = todayJST()
  const projects = (await db.prepare(`SELECT p.project_id, p.project_name, COALESCE(p.status, 'active') AS status, cl.client_name,
      MIN(s.work_date) AS first_date, MAX(s.work_date) AS last_date,
      SUM(CASE WHEN s.work_date >= ? AND s.status != 'absent' THEN 1 ELSE 0 END) AS upcoming,
      SUM(CASE WHEN s.work_date >= ? AND s.status != 'absent' AND s.attendance_mode IN ('none', 'in_out') THEN 1 ELSE 0 END) AS upcoming_exceptions
    FROM shifts s JOIN projects p ON p.project_id = s.project_id ${CLIENT_JOIN}
    WHERE s.staff_id = ? AND s.company_id = ? AND p.company_id = s.company_id
    GROUP BY p.project_id ORDER BY CASE WHEN COALESCE(p.status, 'active') = 'active' THEN 0 ELSE 1 END, MAX(s.work_date) DESC`).bind(today, today, staffId, companyId).all()).results as any[]
  if (!projects.length) return []
  const ids = projects.map(p => p.project_id)
  const defaults = new Map<number, Record<string, number>>()
  for (const id of ids) defaults.set(id, Object.fromEntries(REPORT_TYPES.map(t => [t, 1])))
  for (const r of (await db.prepare(`SELECT project_id, report_type, enabled FROM project_report_defaults WHERE project_id IN ${JSON_IN}`).bind(bindJsonArray(ids)).all()).results as any[]) {
    if (isReportType(r.report_type)) defaults.get(r.project_id)![r.report_type] = r.enabled ? 1 : 0
  }
  const settings = new Map<number, StaffSetting>()
  for (const id of ids) { const s = emptySetting(defaults.get(id)!); applyLegacy(s, legacyMode); settings.set(id, s) }
  for (const r of (await db.prepare('SELECT project_id, report_type, enabled, source FROM project_staff_report_settings WHERE staff_id = ? AND company_id = ?').bind(staffId, companyId).all()).results as any[]) {
    const s = settings.get(r.project_id); if (s) applyRow(s, r, defaults.get(r.project_id)!)
  }
  return projects.map(p => {
    const s = settings.get(p.project_id)!
    return { ...p, defaults: defaults.get(p.project_id), settings: s.values, kind: s.kind, individual: isCustom(s), legacy_mode: s.legacy_mode }
  })
}
reportSettingsApi.get('/report-settings/staff/:staffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const st = await ownStaffRow(db, u.company_id, c.req.param('staffId'))
  if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
  return c.json({
    staff: { staff_id: st.staff_id, name: st.name, member_status: st.member_status, legacy_mode: legacyStaffFlags(st.attendance_mode) ? st.attendance_mode : null },
    report_types: REPORT_TYPES, labels: REPORT_LABEL, projects: await staffProjectSettings(db, u.company_id, st.staff_id, st.attendance_mode),
  })
})
// すべての案件（または選んだ案件）に同じ設定を当てる。dry_run で案件ごとの変更前・変更後と確認トークンを返す（一括変更と同じ流れ）
// project_ids を省くと、稼働中の案件すべて
reportSettingsApi.post('/report-settings/staff/:staffId/apply', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const st = await ownStaffRow(db, u.company_id, c.req.param('staffId'))
  if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (isInactive(st.member_status)) return c.json({ error: '退職・統合済み・取引終了のスタッフの設定は変更できません' }, 400)
  const b = await c.req.json().catch(() => ({} as any))
  const next = parseSettings(b.settings)
  if (!next) return c.json({ error: '設定値が正しくありません' }, 400)
  const all = await staffProjectSettings(db, u.company_id, st.staff_id, st.attendance_mode)
  const ids = parseIdList(b.project_ids)
  if (ids && ids.some(id => !all.some(p => p.project_id === id))) return c.json({ error: 'このスタッフにシフトのない案件が含まれています' }, 400)
  const targets = ids ? all.filter(p => ids.includes(p.project_id)) : all.filter(p => p.status === 'active')
  if (!targets.length) return c.json({ error: '対象の案件を選択してください' }, 400)
  const preview = targets.map(p => {
    const after = { ...p.settings }; for (const [t, v] of Object.entries(next)) after[t] = v
    return { project_id: p.project_id, project_name: p.project_name, before: p.settings, after, changed: REPORT_TYPES.some(t => after[t] !== p.settings[t]), upcoming: p.upcoming }
  })
  const changedRows = preview.filter(r => r.changed)
  const token = await sha256(JSON.stringify([st.staff_id, next, preview.map(r => [r.project_id, REPORT_TYPES.map(t => r.before[t])])]))
  if (b.dry_run) return c.json({ target_count: targets.length, changed_count: changedRows.length, rows: preview, confirm_token: token })
  if (b.confirm_token !== token) return c.json({ error: '確認後に設定が変わりました。もう一度内容を確認してください', need_confirm: true }, 409)
  let cells = 0
  for (const r of changedRows) cells += (await setStaffSettings(db, u.company_id, r.project_id, new Map([[st.staff_id, next]]), 'individual', u)).cells
  return c.json({ ok: true, projects_changed: changedRows.length, cells })
})
// 案件の標準設定に戻す（案件 × スタッフ別の行を消す）。project_ids を省くとシフトのある全案件
reportSettingsApi.post('/report-settings/staff/:staffId/reset', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const st = await ownStaffRow(db, u.company_id, c.req.param('staffId'))
  if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const ids = parseIdList(b.project_ids)
  if (ids && !ids.length) return c.json({ error: '対象の案件を選択してください' }, 400)
  const r = await resetStaffSettings(db, u.company_id, st.staff_id, ids, u)
  return c.json({ ok: true, ...r })
})

// ---------- 案件をまたいだ OFF の設定一覧（#446） ----------
// 案件 × スタッフ別の行で OFF になっている報告。既定では、在籍中のスタッフ・稼働中の案件・標準設定と違う OFF だけ
// （行がなくスタッフ単位の旧設定で OFF になっている人は、案件詳細で『個別（旧設定）』として表示する）
function offFilter(companyId: number, q: (k: string) => string | undefined) {
  const w = ['r.company_id = ?', 'r.enabled = 0']; const bind: any[] = [companyId]
  if (Number(q('project_id'))) { w.push('r.project_id = ?'); bind.push(Number(q('project_id'))) }
  if (Number(q('staff_id'))) { w.push('r.staff_id = ?'); bind.push(Number(q('staff_id'))) }
  if (isReportType(q('report_type'))) { w.push('r.report_type = ?'); bind.push(q('report_type')) }
  if (q('include_closed') !== '1') w.push("COALESCE(p.status, 'active') = 'active'")
  if (q('include_inactive') !== '1') w.push(`${MEMBER_STATUS_SQL} NOT IN ('retired', 'merged', 'ended')`)
  if (q('include_default') !== '1') w.push('COALESCE(d.enabled, 1) = 1')
  return { where: w.join(' AND '), bind }
}
const OFF_FROM = `FROM project_staff_report_settings r
    JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id ${CLIENT_JOIN}
    JOIN staff_profiles sp ON sp.staff_id = r.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN users um ON um.user_id = r.updated_by
    LEFT JOIN employee_records er ON er.staff_id = r.staff_id AND er.company_id = r.company_id
    LEFT JOIN project_report_defaults d ON d.project_id = r.project_id AND d.report_type = r.report_type`
const OFF_SELECT = `SELECT r.project_id, p.project_name, COALESCE(p.status, 'active') AS project_status, cl.client_name, r.staff_id, us.name AS staff_name, er.employee_number,
    r.report_type, r.source, r.updated_at, um.name AS updated_by_name, COALESCE(d.enabled, 1) AS default_enabled, ${MEMBER_STATUS_SQL} AS member_status`
const OFF_ORDER = `ORDER BY p.project_name, r.project_id, us.name, r.staff_id, instr('${REPORT_TYPES.join(',')}', r.report_type)`
const SOURCE_LABEL: Record<string, string> = { individual: '個別変更', bulk: '一括変更', default: '標準設定から引き継ぎ', migration: '導入時の移行' }
const MEMBER_STATUS_LABEL: Record<string, string> = { active: '在籍', leave: '休職', retired: '退職', merged: '統合済み', ended: '取引終了' }
reportSettingsApi.get('/report-settings/off-list', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const q = (k: string) => c.req.query(k)
  const { where, bind } = offFilter(u.company_id, q)
  const limit = 1000
  const rows = (await db.prepare(`${OFF_SELECT} ${OFF_FROM} WHERE ${where} ${OFF_ORDER} LIMIT ?`).bind(...bind, limit + 1).all()).results as any[]
  const total = rows.length > limit ? Number(((await db.prepare(`SELECT COUNT(*) AS n ${OFF_FROM} WHERE ${where}`).bind(...bind).first()) as any)?.n || 0) : rows.length
  const exceptions = await upcomingExceptions(db, u.company_id, { project_id: Number(q('project_id')) || undefined, staff_id: Number(q('staff_id')) || undefined, include_closed: q('include_closed') === '1' })
  return c.json({ rows: rows.slice(0, limit), total, limit, exceptions, labels: REPORT_LABEL, csv_limit: CSV_LIMIT })
})
reportSettingsApi.get('/report-settings/off-list/export', async (c) => {
  const u = c.get('user'); const q = (k: string) => c.req.query(k)
  const { where, bind } = offFilter(u.company_id, q)
  const got = (await c.env.DB.prepare(`${OFF_SELECT} ${OFF_FROM} WHERE ${where} ${OFF_ORDER} LIMIT ${CSV_LIMIT + 1}`).bind(...bind).all()).results as any[]
  const total = got.length > CSV_LIMIT ? Number(((await c.env.DB.prepare(`SELECT COUNT(*) AS n ${OFF_FROM} WHERE ${where}`).bind(...bind).first()) as any)?.n || 0) : got.length
  const csv = toCsv(['案件', '案件の状態', 'クライアント', 'スタッフ', 'スタッフID', '社員番号', '在籍状況', '報告', '案件の標準設定', '設定の由来', '最終変更日時', '最終変更者'],
    got.slice(0, CSV_LIMIT).map(r => [r.project_name, r.project_status === 'active' ? '稼働中' : '終了', r.client_name || '', r.staff_name, r.staff_id, r.employee_number ?? '',
      MEMBER_STATUS_LABEL[r.member_status] || r.member_status, REPORT_LABEL[r.report_type] || r.report_type, r.default_enabled ? 'ON' : 'OFF',
      SOURCE_LABEL[r.source] || r.source, r.updated_at || '', r.updated_by_name || '']),
    { textCols: ['社員番号'], note: csvLimitNote(total) })
  return csvResponse(`報告OFFの設定一覧_${nowJST().slice(0, 10)}.csv`, csv, csvLimitHeaders(total))
})

// 設定変更の履歴（案件・スタッフ・期間・報告種類・操作で絞り込み）
function logFilter(companyId: number, q: (k: string) => string | undefined) {
  const w = ['l.company_id = ?']; const bind: any[] = [companyId]
  if (q('project_id')) { w.push('l.project_id = ?'); bind.push(Number(q('project_id'))) }
  if (q('staff_id')) { w.push('l.staff_id = ?'); bind.push(Number(q('staff_id'))) }
  if (q('scope') === 'default') w.push('l.staff_id IS NULL')
  if (isReportType(q('report_type'))) { w.push('l.report_type = ?'); bind.push(q('report_type')) }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q('from') || '')) { w.push('l.created_at >= ?'); bind.push(q('from') + ' 00:00:00') }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q('to') || '')) { w.push('l.created_at <= ?'); bind.push(q('to') + ' 23:59:59') }
  // スタッフは氏名の一部か、社員番号（完全一致）で探す
  if (q('staff_name')) { w.push("(us.name LIKE ? ESCAPE '\\' OR er.employee_number = ?)"); bind.push('%' + String(q('staff_name')).replace(/[\\%_]/g, m => '\\' + m) + '%', String(q('staff_name'))) }
  if (q('action') && ACTION_LABEL[q('action')!]) { w.push('l.action = ?'); bind.push(q('action')) }
  // 導入時の移行（0027 で一度に作った行）を除く（#102）
  if (q('exclude_migration') === '1' && q('action') !== 'migration') w.push("l.action != 'migration'")
  return { where: w.join(' AND '), bind }
}
// default_apply = 標準設定の変更を今の所属スタッフに当てた（#329）/ staff_reset = 案件の標準設定に戻した（#413）/ shift_override = シフト単位の例外（#313）
const ACTION_LABEL: Record<string, string> = {
  project_default: '標準設定', default_apply: '標準設定の適用', individual: '個別変更', bulk: '一括変更', staff_reset: '標準に戻す',
  shift_override: 'シフト単位の例外', migration: '導入時の移行', merge: 'スタッフ統合',
}
const LOG_FROM = `FROM report_setting_logs l LEFT JOIN projects p ON p.project_id = l.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = l.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = l.staff_id AND er.company_id = l.company_id`
reportSettingsApi.get('/report-settings/logs', async (c) => {
  const u = c.get('user'); const q = (k: string) => c.req.query(k)
  const { where, bind } = logFilter(u.company_id, q)
  const limit = Math.min(500, Math.max(1, Number(q('limit')) || 200))
  const rows = (await c.env.DB.prepare(`SELECT l.*, p.project_name, p.status AS project_status, us.name AS staff_name, er.employee_number ${LOG_FROM}
    WHERE ${where} ORDER BY l.log_id DESC LIMIT ?`).bind(...bind, limit).all()).results
  // 条件に合う全件数（画面で、表示と CSV の上限を超えたかを知らせる #102）
  const total = Number(((await c.env.DB.prepare(`SELECT COUNT(*) AS n ${LOG_FROM} WHERE ${where}`).bind(...bind).first()) as any)?.n || 0)
  return c.json({ logs: rows, labels: REPORT_LABEL, actions: ACTION_LABEL, total, csv_limit: CSV_LIMIT })
})
reportSettingsApi.get('/report-settings/logs/export', async (c) => {
  const u = c.get('user')
  const { where, bind } = logFilter(u.company_id, k => c.req.query(k))
  // 新しい順に上限まで取り、古い順に出す。上限を超えたら注記を入れる（#102）
  const { rows, total } = await loadLatestForCsv(c.env.DB,
    `SELECT l.*, p.project_name, p.status AS project_status, us.name AS staff_name, er.employee_number ${LOG_FROM} WHERE ${where} ORDER BY l.log_id DESC`,
    `SELECT COUNT(*) AS n ${LOG_FROM} WHERE ${where}`, bind)
  const onoff = (v: any) => v == null ? '' : v ? 'ON' : 'OFF'
  // 同姓同名を区別できるよう、対象のスタッフID・社員番号も出す（既存の列の位置を変えないよう末尾に足す）。ロールは日本語にする（#474）
  // シフト単位の例外は、シフトID と内容（勤務日・時間・変更前後の例外）を末尾に出す（#313）
  const csv = toCsv(['履歴ID', '日時', '案件', '案件の状態', '対象', '報告', '変更前', '変更後', '操作', '一括の識別子', '変更者', '変更者のロール', 'スタッフID', '社員番号', 'シフトID', '内容'],
    rows.map(l => [l.log_id, l.created_at, l.project_name, (l.project_status || 'active') === 'active' ? '稼働中' : '終了', l.staff_id ? l.staff_name : '標準設定',
      REPORT_LABEL[l.report_type] || l.report_type, onoff(l.old_enabled), onoff(l.new_enabled), ACTION_LABEL[l.action] || l.action, l.batch_id,
      l.changed_by_name || (l.action === 'migration' ? 'システム' : ''), roleLabel(l.changed_by_role),
      l.staff_id ?? '', l.employee_number ?? '', l.shift_id ?? '', l.detail ?? '']),
    { textCols: ['社員番号'], note: csvLimitNote(total) })
  return csvResponse(`報告設定の変更履歴_${nowJST().slice(0, 10)}.csv`, csv, csvLimitHeaders(total))
})

export default reportSettingsApi
