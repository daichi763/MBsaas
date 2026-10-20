// =========================================================
// 深夜・時間外・休日の割増（#167）
//
// 対象は支払先が自社給与・日雇い給与（payroll / payroll_daily）の確定・代打のシフトだけ。設定（premium_pay_settings）が OFF なら計算しない。
//   深夜   = 22:00〜5:00 に勤務した分。休憩の時刻は記録していないため、休憩はまず深夜以外の時間に取ったものとみなす（支払の時間を上限にする）
//   時間外 = 同じスタッフ・同じ稼働日の、自社給与・日雇い給与のシフトの支払の時間の合計が daily_limit_minutes を超えた分。
//            開始の早い順に足していき、超えた分を後のシフトに付ける（日をまたぐ勤務は稼働日の分として数える）
//   休日   = 休日の曜日（holiday_weekdays）の稼働日の勤務。休日の勤務には時間外を付けない（深夜は付ける）
// 割増額 = 1時間あたりの賃金 ×（深夜 × 深夜の率 ＋ 時間外 × 時間外の率 ＋ 休日 × 休日の率）。割増の部分（25% など）だけで、基本の賃金は含まない。
// 1時間あたりの賃金は、時給はその単価、日額は単価を予定の実働時間で割った額。
// 未確定のシフトは表示のたびに計算し（attachPremiums）、確定したときに shifts.pay_premium などに書き込んで以後はその値を使う
// =========================================================
import { workHours } from '../shift-board'
import { JSON_IN, bindJsonArray } from './d1-chunk'

export const PREMIUM_PAYEES = ['payroll', 'payroll_daily']
const WORKING = ['confirmed', 'substitute']
export const PREMIUM_RATE_MAX = 200
export type PremiumSettings = {
  enabled: boolean; night_rate: number; overtime_rate: number; holiday_rate: number; holiday_weekdays: number[]; daily_limit_minutes: number
}
export const PREMIUM_DEFAULTS: PremiumSettings = { enabled: false, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [], daily_limit_minutes: 480 }
export type Premium = { pay_premium: number; premium_night_minutes: number | null; premium_overtime_minutes: number | null; premium_holiday_minutes: number | null }
export const PREMIUM_COLUMNS = ['pay_premium', 'premium_night_minutes', 'premium_overtime_minutes', 'premium_holiday_minutes'] as const
const NO_PREMIUM: Premium = { pay_premium: 0, premium_night_minutes: null, premium_overtime_minutes: null, premium_holiday_minutes: null }

export function premiumSettingsOf(row: any): PremiumSettings {
  if (!row) return { ...PREMIUM_DEFAULTS }
  const wd = String(row.holiday_weekdays || '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
  return {
    enabled: !!row.enabled, night_rate: Number(row.night_rate ?? 25), overtime_rate: Number(row.overtime_rate ?? 25), holiday_rate: Number(row.holiday_rate ?? 35),
    holiday_weekdays: [...new Set(wd)].sort(), daily_limit_minutes: Number(row.daily_limit_minutes || 480),
  }
}
export async function loadPremiumSettings(db: D1Database, companyId: number): Promise<PremiumSettings> {
  return premiumSettingsOf(await db.prepare('SELECT * FROM premium_pay_settings WHERE company_id = ?').bind(companyId).first())
}

const toMin = (t: any) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
const storedTime = (t: any) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)
// 勤務した時間帯（稼働日の 0:00 からの分）。時間の数え方（hours_basis）は workHours と同じ規則
export function workedWindow(s: any, basis: string): { start: number; end: number } {
  const ps = toMin(s.start_time); let pe = toMin(s.end_time); if (pe <= ps) pe += 1440
  if (basis === 'scheduled' || !storedTime(s.actual_start) || !storedTime(s.actual_end)) return { start: ps, end: pe }
  let as = toMin(s.actual_start)
  if (as - ps > 720) as -= 1440
  else if (ps - as > 720) as += 1440
  let ae = toMin(s.actual_end); while (ae <= as) ae += 1440
  if (basis === 'actual') return { start: as, end: ae }
  const cs = Math.max(as, ps), ce = Math.min(ae, pe)
  return { start: cs, end: Math.max(cs, ce) }
}
// 時間帯のうち 22:00〜5:00 の分（前日の夜から翌々日の朝まで）
export function nightMinutes(start: number, end: number): number {
  let n = 0
  for (let k = -1; k <= 2; k++) n += Math.max(0, Math.min(end, k * 1440 + 300) - Math.max(start, k * 1440 - 120))
  return n
}
const weekday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay()

// shifts の行（案件の hours_basis・time_round_minutes・pay_time_round・default_break_minutes を含む）から、シフトごとの割増を計算する。
// 渡した行のうち、対象（確定・代打で支払先が自社給与・日雇い給与）の行だけを結果に入れる
export function computePremiums(rows: any[], st: PremiumSettings): Map<number, Premium> {
  const out = new Map<number, Premium>()
  if (!st.enabled) return out
  const items = rows.filter(s => WORKING.includes(s.status) && PREMIUM_PAYEES.includes(s.payee_type || 'payroll')).map(s => {
    const proj = { hours_basis: s.hours_basis, time_round_minutes: s.time_round_minutes, pay_time_round: s.pay_time_round, default_break_minutes: s.default_break_minutes }
    const h = workHours(s, proj)
    const w = workedWindow(s, h.basis)
    const payMin = Math.round(h.pay_hours * 60), planMin = Math.round(h.planned_hours * 60)
    const base = s.pay_rate == null ? null : s.pay_unit_type === 'hourly' ? Number(s.pay_rate) : planMin > 0 ? Number(s.pay_rate) * 60 / planMin : 0
    return { s, w, payMin, base, night: Math.min(nightMinutes(w.start, w.end), payMin) }
  })
  const byDay = new Map<string, typeof items>()
  for (const it of items) { const k = `${it.s.staff_id}:${it.s.work_date}`; const a = byDay.get(k) || []; a.push(it); byDay.set(k, a) }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.w.start - b.w.start || Number(a.s.shift_id) - Number(b.s.shift_id))
    const holiday = st.holiday_weekdays.includes(weekday(String(list[0].s.work_date)))
    let cum = 0
    for (const it of list) {
      const ot = holiday ? 0 : Math.max(0, Math.min(it.payMin, cum + it.payMin - st.daily_limit_minutes))
      cum += it.payMin
      const hol = holiday ? it.payMin : 0
      const amount = it.base == null ? 0 : Math.round(it.base * (it.night * st.night_rate + ot * st.overtime_rate + hol * st.holiday_rate) / 6000)
      out.set(Number(it.s.shift_id), { pay_premium: amount, premium_night_minutes: it.night, premium_overtime_minutes: ot, premium_holiday_minutes: hol })
    }
  }
  return out
}

// 一覧の行（shifts.* を含む）に割増（pay_premium・premium_*_minutes）を付ける。行を書き換える。
// 確定済みの行は確定したときの値のまま。未確定の行は、同じスタッフ・同じ稼働日のほかのシフト（一覧の絞り込みの外も含む）を読んで計算する。
// 欠勤の行・対象外の行は割増なし
export async function attachPremiums(db: D1Database, companyId: number, rows: any[], settings?: PremiumSettings) {
  const open = rows.filter(r => r.settle_status !== 'confirmed')
  for (const r of open) Object.assign(r, NO_PREMIUM)
  const targets = open.filter(r => WORKING.includes(r.status) && PREMIUM_PAYEES.includes(r.payee_type || 'payroll'))
  if (!targets.length) return
  const st = settings || await loadPremiumSettings(db, companyId)
  if (!st.enabled) return
  const dates = targets.map(r => String(r.work_date)).sort()
  const all = (await db.prepare(`SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.break_minutes, s.actual_start, s.actual_end, s.actual_break_minutes,
      s.status, s.payee_type, s.pay_unit_type, s.pay_rate, p.hours_basis, p.time_round_minutes, p.pay_time_round, p.default_break_minutes
    FROM shifts s JOIN projects p ON p.project_id = s.project_id
    WHERE s.company_id = ? AND s.status IN ('confirmed','substitute') AND COALESCE(s.payee_type,'payroll') IN ('payroll','payroll_daily')
      AND s.staff_id IN ${JSON_IN} AND s.work_date BETWEEN ? AND ?`)
    .bind(companyId, bindJsonArray([...new Set(targets.map(r => Number(r.staff_id)))]), dates[0], dates[dates.length - 1]).all()).results as any[]
  const keys = new Set(targets.map(r => `${r.staff_id}:${r.work_date}`))
  const map = computePremiums(all.filter(s => keys.has(`${s.staff_id}:${s.work_date}`)), st)
  for (const r of targets) { const p = map.get(Number(r.shift_id)); if (p) Object.assign(r, p) }
}
