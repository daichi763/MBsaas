// =========================================================
// シフトの日時（稼働日＋時刻 → 絶対日時）と、報告を受け付ける時間帯
// 日時は JST の 'YYYY-MM-DD HH:MM:SS'（nowJST()・attendance_reports.reported_at と同じ形）で扱い、文字列の大小で比べる。
// 終了時刻が開始時刻以前のシフト（22:00〜06:00 など）は、終了を稼働日の翌日とみなす。
// =========================================================

export type DateTimeRange = { start: string; end: string }
export type ShiftTimes = { work_date: string; start_time: string; end_time: string }

// 稼働日の翌日も受け付ける報告（勤務開始より後の報告。日をまたぐ勤務）
export const NEXT_DAY_TYPES = ['break_start', 'break_end', 'work_end', 'check_out']
// 開始時刻の何時間前から報告を受け付けるか。0 の間は稼働日の 0:00 から。
// 0時台に始まるシフトを前日の夜から報告できるようにする（#256）ときに増やす。その前に入店の遅延判定を絶対日時にすること
export const PRE_START_HOURS = 0

export function addDays(d: string, n: number): string {
  const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10)
}
export function toMin(t: string): number {
  const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0)
}
// 稼働日から minutes 分後の日時（負の値・1440 以上は前日・翌日以降になる）
export function atMinutes(workDate: string, minutes: number): string {
  const days = Math.floor(minutes / 1440)
  const rest = minutes - days * 1440
  const hh = String(Math.floor(rest / 60)).padStart(2, '0'), mm = String(rest % 60).padStart(2, '0')
  return `${addDays(workDate, days)} ${hh}:${mm}:00`
}
const earlier = (a: string, b: string) => (a < b ? a : b)

// シフトの開始・終了の絶対日時。終了が開始以前なら翌日
export function shiftWindow(workDate: string, start: string, end: string): DateTimeRange {
  const s = toMin(start); let e = toMin(end)
  if (e <= s) e += 1440
  return { start: atMinutes(workDate, s), end: atMinutes(workDate, e) }
}

// 日付をまたぐシフトか（終了が稼働日の翌日になる）
export function crossesMidnight(shift: ShiftTimes): boolean {
  return shiftWindow(shift.work_date, shift.start_time, shift.end_time).end > `${shift.work_date} 23:59:59`
}

// 報告を受け付ける時間帯
//   開始: 稼働日の 0:00 と、開始時刻の PRE_START_HOURS 時間前の早いほう
//   終了: 休憩・勤務終了・退店（NEXT_DAY_TYPES）は稼働日の翌日 23:59:59 まで（報告用URLの有効期限と同じ）。それ以外は稼働日の 23:59:59 まで
export function reportableWindow(shift: ShiftTimes, type: string): DateTimeRange {
  const start = earlier(`${shift.work_date} 00:00:00`, atMinutes(shift.work_date, toMin(shift.start_time) - PRE_START_HOURS * 60))
  const end = NEXT_DAY_TYPES.includes(type) ? `${addDays(shift.work_date, 1)} 23:59:59` : `${shift.work_date} 23:59:59`
  return { start, end }
}

export function isWithin(range: DateTimeRange, at: string): boolean {
  return range.start <= at && at <= range.end
}

// 2つの時間帯が重なるか（端が接するだけなら重ならない）
export function overlaps(a: DateTimeRange, b: DateTimeRange): boolean {
  return a.start < b.end && b.start < a.end
}

// 日時に分を足す（'YYYY-MM-DD HH:MM:SS' → 同じ形）
export function addMinutes(dateTime: string, minutes: number): string {
  const x = new Date(dateTime.replace(' ', 'T') + 'Z'); x.setUTCMinutes(x.getUTCMinutes() + minutes)
  return x.toISOString().slice(0, 19).replace('T', ' ')
}

// 入店の遅延判定（報告用URL・代理入力で共通。アプリの POST /staff/attendance も同じ考え方）。
// 報告の日時（分まで）がシフト開始の絶対日時より後なら遅延。日をまたいだ後の入店も日付を含めて比べる
export function isLateCheckIn(shift: ShiftTimes, at: string): boolean {
  return String(at).slice(0, 16) > shiftWindow(shift.work_date, shift.start_time, shift.end_time).start.slice(0, 16)
}
