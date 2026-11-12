// =========================================================
// 日報一覧の件数（GET /api/admin/daily-reports の total・counts）を、月数に比例しない読み取りで数える（性能の直し。#9970。migrations/0108）
//   今月より前の、期間に丸ごと入る月は、会社・月・案件ごとの件数の控え（daily_report_month_counts）から足す。
//   控えの無い月・古くなった月（前月は1日、それより前は7日）は、同じ db.batch の中で数え直してから足す（数え直しと足し算が1つの処理になる）。
//   今月以降・期間の端の月の途中・スタッフや日付1日の絞り込みは、これまでどおり日報の表から数える。
//   日報の件数・未確認・インシデント・未対応が変わる書き込みは、その月の印（project_id = 0 の行）を消す（dirty*Stmt。同じ batch に入れる）。
//   印を消し忘れた書き込み・SQL で直接変えた行も、古くなった月として数え直されるので、最長で上の日数だけ古い件数が出ることがある。
// =========================================================
import { JSON_IN, bindJsonArray } from './d1-chunk'

export const DR_MONTH_COUNTS = 'daily_report_month_counts'
// 控えを数え直すまでの日数（前月はまだ確認・遅れた提出が多いので短くする）
const STALE_DAYS_PREV_MONTH = 1
const STALE_DAYS_OLDER = 7

// 日報（dr）の条件式。api.ts の DR_UNCHECKED_SQL・DR_FLAGGED_SQL・DR_INCIDENT_OPEN_SQL を渡す
export type DrCountConds = { unchecked: string; flagged: string; open: string }
export type DrCounts = { total_all: number; unchecked: number; flagged: number; incident_open: number; total: number }
export type DrCountQuery = {
  companyId: number
  from: string | null; to: string | null; date: string | null; projectId: number | null; staffId: number | null
  // 「未確認のみ」「インシデント・クレームのみ」「未対応のみ」
  only: { unchecked: boolean; flagged: boolean; open: boolean }
  conds: DrCountConds
  today: string; now: string
}

const ymOf = (d: string) => d.slice(0, 7)
const monthStart = (ym: string) => `${ym}-01`
function nextYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
function prevYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
// 月の最終日（'YYYY-MM-DD'）
const monthEnd = (ym: string) => new Date(Date.parse(monthStart(nextYm(ym)) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
const jstMinusDays = (now: string, days: number) => new Date(Date.parse(now.replace(' ', 'T') + 'Z') - days * 86400000).toISOString().slice(0, 19).replace('T', ' ')

/**
 * 件数の問い合わせを2段に分けて作る。first は一覧の行の問い合わせと同じ db.batch に入れる文、finish はその結果から件数を出す
 * （控えを使うときだけ、もう1回 db.batch を呼ぶ）
 */
export function dailyReportCountPlan(db: D1Database, q: DrCountQuery): { first: D1PreparedStatement[]; finish: (res: D1Result[]) => Promise<DrCounts> } {
  const { unchecked: U, flagged: F, open: O } = q.conds
  const extra = (q.only.unchecked ? ` AND ${U}` : '') + (q.only.flagged ? ` AND ${F}` : '') + (q.only.open ? ` AND ${O}` : '')
  // 日報の表から数える文（これまでと同じ式）。range は work_date の範囲を足す
  // 範囲の端は1つにまとめて書く（下限・上限を2つずつ書くと、索引の範囲に片方しか使われず、広く読むため）
  const live = (range: { gte?: string; lt?: string }) => {
    let w = ' WHERE dr.company_id = ?'; const b: any[] = [q.companyId]
    if (q.date) { w += ' AND dr.work_date = ?'; b.push(q.date) }
    const gte = q.from && range.gte ? (q.from > range.gte ? q.from : range.gte) : (q.from || range.gte)
    if (gte) { w += ' AND dr.work_date >= ?'; b.push(gte) }
    if (range.lt && !(q.to && q.to < range.lt)) { w += ' AND dr.work_date < ?'; b.push(range.lt) }
    else if (q.to) { w += ' AND dr.work_date <= ?'; b.push(q.to) }
    if (q.projectId) { w += ' AND dr.project_id = ?'; b.push(q.projectId) }
    if (q.staffId) { w += ' AND dr.staff_id = ?'; b.push(q.staffId) }
    return db.prepare(`SELECT COUNT(*) AS total_all,
        SUM(CASE WHEN ${U} THEN 1 ELSE 0 END) AS unchecked,
        SUM(CASE WHEN ${F} THEN 1 ELSE 0 END) AS flagged,
        SUM(CASE WHEN ${O} THEN 1 ELSE 0 END) AS incident_open,
        SUM(CASE WHEN 1${extra} THEN 1 ELSE 0 END) AS total
      FROM daily_reports dr${w}`).bind(...b)
  }
  const n = (v: any) => Number(v || 0)
  const add = (a: DrCounts, r: any): DrCounts => ({ total_all: a.total_all + n(r?.total_all), unchecked: a.unchecked + n(r?.unchecked), flagged: a.flagged + n(r?.flagged),
    incident_open: a.incident_open + n(r?.incident_open), total: a.total + n(r?.total) })
  const zero: DrCounts = { total_all: 0, unchecked: 0, flagged: 0, incident_open: 0, total: 0 }
  // スタッフ・日付1日の絞り込みは件数が小さいので、そのまま数える
  if (q.staffId || q.date) return { first: [live({})], finish: async (res) => add(zero, (res[0].results as any[])[0]) }

  // 控えを使える月: 今月より前で、期間（from〜to）に丸ごと入る月
  const curYm = ymOf(q.today)
  let lastYm = prevYm(curYm)
  if (q.to) { const t = q.to >= monthEnd(ymOf(q.to)) ? ymOf(q.to) : prevYm(ymOf(q.to)); if (t < lastYm) lastYm = t }
  const fromYm = q.from ? (q.from === monthStart(ymOf(q.from)) ? ymOf(q.from) : nextYm(ymOf(q.from))) : null
  const first: D1PreparedStatement[] = [
    // 期間の始まりが無いときは、いちばん古い日報の月から（索引の先頭の1行だけを読む）
    db.prepare('SELECT MIN(work_date) AS d FROM daily_reports WHERE company_id = ?').bind(q.companyId),
    db.prepare(`SELECT ym, computed_at FROM ${DR_MONTH_COUNTS} WHERE company_id = ? AND project_id = 0 AND ym >= ? AND ym <= ?`).bind(q.companyId, fromYm || '0000-00', lastYm),
  ]
  return {
    first,
    finish: async (res) => {
      const minDate = (res[0].results as any[])[0]?.d as string | null
      if (!minDate) return zero
      const startYm = fromYm && fromYm > ymOf(minDate) ? fromYm : ymOf(minDate)
      const months: string[] = []
      for (let m = startYm; m <= lastYm; m = nextYm(m)) months.push(m)
      // 控えを使える月が無ければ、これまでどおり日報の表から数える
      if (!months.length) { const r = await live({}).first(); return add(zero, r) }
      const fresh = new Map((res[1].results as any[]).map(r => [String(r.ym), String(r.computed_at)]))
      const prev = prevYm(curYm)
      const stale = months.filter(m => { const t = fresh.get(m); return !t || t < jstMinusDays(q.now, m === prev ? STALE_DAYS_PREV_MONTH : STALE_DAYS_OLDER) })
      const stmts: D1PreparedStatement[] = []
      if (stale.length) {
        // 月の一覧（文字列）。bindJsonArray は数に変えるので使わない
        const list = JSON.stringify(stale)
        stmts.push(
          db.prepare(`DELETE FROM ${DR_MONTH_COUNTS} WHERE company_id = ? AND ym IN ${JSON_IN}`).bind(q.companyId, list),
          db.prepare(`INSERT INTO ${DR_MONTH_COUNTS} (company_id, ym, project_id, computed_at) SELECT ?, value, 0, ? FROM json_each(?)`).bind(q.companyId, q.now, list),
          // 月ごとに、会社と稼働日の索引でその月の日報だけを読む（CROSS JOIN で月の一覧を外側にする）
          db.prepare(`INSERT INTO ${DR_MONTH_COUNTS} (company_id, ym, project_id, total, unchecked, flagged, incident_open, unchecked_flagged, unchecked_open, computed_at)
            SELECT ?, m.value, dr.project_id, COUNT(*),
              SUM(CASE WHEN ${U} THEN 1 ELSE 0 END), SUM(CASE WHEN ${F} THEN 1 ELSE 0 END), SUM(CASE WHEN ${O} THEN 1 ELSE 0 END),
              SUM(CASE WHEN ${U} AND ${F} THEN 1 ELSE 0 END), SUM(CASE WHEN ${U} AND ${O} THEN 1 ELSE 0 END), ?
            FROM json_each(?) m CROSS JOIN daily_reports dr
            WHERE dr.company_id = ? AND dr.work_date >= m.value || '-01' AND dr.work_date < date(m.value || '-01', '+1 month') AND dr.project_id != 0
            GROUP BY m.value, dr.project_id`).bind(q.companyId, q.now, list, q.companyId),
        )
      }
      // 「インシデント・クレームのみ」と「未対応のみ」を両方選んだときは「未対応のみ」と同じ（未対応はインシデント・クレームの一部）
      const col = q.only.unchecked ? (q.only.open ? 'unchecked_open' : q.only.flagged ? 'unchecked_flagged' : 'unchecked')
        : q.only.open ? 'incident_open' : q.only.flagged ? 'flagged' : 'total'
      stmts.push(db.prepare(`SELECT SUM(total) AS total_all, SUM(unchecked) AS unchecked, SUM(flagged) AS flagged, SUM(incident_open) AS incident_open, SUM(${col}) AS total
        FROM ${DR_MONTH_COUNTS} WHERE company_id = ? AND ym >= ? AND ym <= ? AND project_id != 0${q.projectId ? ' AND project_id = ?' : ''}`)
        .bind(q.companyId, months[0], months[months.length - 1], ...(q.projectId ? [q.projectId] : [])))
      // 控えの月の前（期間の始まりの月の途中）と後（今月以降・期間の終わりの月の途中）は日報の表から数える
      const liveCount = (q.from && q.from < monthStart(months[0]) ? 1 : 0) + 1
      if (liveCount === 2) stmts.push(live({ lt: monthStart(months[0]) }))
      stmts.push(live({ gte: monthStart(nextYm(months[months.length - 1])) }))
      const out = await db.batch(stmts)
      // 控えを書けなかったとき（本部の閲覧中は D1 が読み取り専用で、書き込みは実行されない。hq-support.ts の readOnlyDb）は、
      // 控えの無い・古い月を足すと件数がずれるので、これまでどおり日報の表から数える
      if (stale.length && !(Number(out[1]?.meta?.changes) > 0)) return add(zero, await live({}).first())
      return out.slice(out.length - liveCount - 1).reduce((a, r) => add(a, (r.results as any[])[0]), zero)
    },
  }
}

// ---------- 控えの印を消す文（日報の件数・状態が変わる書き込みと同じ batch に入れる） ----------
// 消すのは印（project_id = 0）だけ。今月以降の月は控えを作らないので、ふだんは何も消さない（書き込みの行は増えない）
/** shift_id の日報の月（出し直しの前と後で1回ずつ入れる。稼働日・案件が変わっても両方の月を数え直す） */
export function dirtyReportCountsByShiftStmt(db: D1Database, shiftId: number): D1PreparedStatement {
  return db.prepare(`DELETE FROM ${DR_MONTH_COUNTS} WHERE project_id = 0 AND (company_id, ym) IN
    (SELECT company_id, substr(work_date, 1, 7) FROM daily_reports WHERE shift_id = ?)`).bind(shiftId)
}
/** 日報の id（自社）の月 */
export function dirtyReportCountsByIdsStmt(db: D1Database, companyId: number, ids: number[]): D1PreparedStatement {
  return db.prepare(`DELETE FROM ${DR_MONTH_COUNTS} WHERE company_id = ? AND project_id = 0 AND ym IN
    (SELECT substr(work_date, 1, 7) FROM daily_reports WHERE daily_report_id IN ${JSON_IN} AND company_id = ?)`).bind(companyId, bindJsonArray(ids), companyId)
}
/** 稼働日が cutoff より前の日報を消すとき（定期削除）。cutoff の月まで、すべての会社の印を消す */
export function dirtyReportCountsBeforeStmt(db: D1Database, cutoff: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM ${DR_MONTH_COUNTS} WHERE project_id = 0 AND ym <= substr(?, 1, 7)`).bind(cutoff)
}
