// =========================================================
// 日報の月ごとの集計の表（#9972。利用者の決定 11/11。migrations/0111）。
//   実績分析（GET /api/admin/analytics・/series・/csv）とスキルシートの通算実績で、確定した過去の月を、日報の表ではなく集計の表から読む。
//   考え方は日報一覧の件数の控え（report-counts.ts・0108）と同じ:
//   - 今月と前月は、これまでどおり日報の表から数える（前月はまだ遅れた提出・修正が多く、集計を何度も作り直すと書き込みが増えるため）。
//   - それより前の月は集計の表から読む。集計の無い月・古い月（STALE_DAYS 日）は、開いたときに同じ db.batch の中で集計し直す。
//   - 日報の書き込みのたびには集計を書かない。日報の行が変わったら、トリガー（0111）がその月の「集計済み」の印を消すだけ
//     （印は過去の月にしか無いので、ふだんの提出・修正では何も書かない）。印が無ければ、次に開いたときに集計し直す。
//   集計を書けなかったとき（本部の閲覧中は D1 が読み取り専用。hq-support.ts の readOnlyDb）は、呼び出し側が日報の表から数える。
// =========================================================
import { nextYm, prevYm } from './report-counts'

export const RS_MONTHS = 'report_summary_months'
export const RS_MONTH = 'report_month_summaries'
export const RS_DAY = 'report_day_summaries'
// 集計を作り直すまでの日数（トリガーで印が消えるので、ふだんは使わない。消し漏れの保険）
const STALE_DAYS = 30
// スキルシートの通算実績の決め打ちの項目（api.ts の skill-sheet。今の画面のために残している列）
export const LEGACY_KEYS = ['mnp', 'pi', 'shinki', 'hikari', 'seiyaku'] as const
const FLAGGED = '(dr.incident_flag = 1 OR dr.complaint_flag = 1)'
// その月（m.value）の日報（会社と稼働日の索引で読む）
const IN_MONTH = `dr.company_id = ?1 AND dr.work_date >= m.value || '-01' AND dr.work_date < date(m.value || '-01', '+1 month')`

/** 集計の表から読める最後の月（今月の前の前の月。'YYYY-MM'）。これより後の月は日報の表から数える */
export function summaryLastYm(today: string): string {
  return prevYm(prevYm(today.slice(0, 7)))
}
/** fromYm〜toYm の月（古い順） */
export function monthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = []
  for (let m = fromYm; m <= toYm; m = nextYm(m)) out.push(m)
  return out
}
const minusDays = (now: string, days: number) => new Date(Date.parse(now.replace(' ', 'T') + 'Z') - days * 86400000).toISOString().slice(0, 19).replace('T', ' ')

/** 集計済みの印を読む文（fromYm〜toYm） */
export function summaryMarksStmt(db: D1Database, companyId: number, fromYm: string, toYm: string): D1PreparedStatement {
  return db.prepare(`SELECT ym, computed_at FROM ${RS_MONTHS} WHERE company_id = ? AND ym >= ? AND ym <= ?`).bind(companyId, fromYm, toYm)
}
/** 印の結果から、新しい集計のある月の一覧 */
export function freshSummaryMonths(res: D1Result | undefined, now: string): string[] {
  const limit = minusDays(now, STALE_DAYS)
  return ((res?.results || []) as any[]).filter(r => String(r.computed_at) >= limit).map(r => String(r.ym)).sort()
}
/** months のうち、集計し直す月（印が無い・古い） */
export function staleSummaryMonths(months: string[], res: D1Result | undefined, now: string): string[] {
  const fresh = new Set(freshSummaryMonths(res, now))
  return months.filter(m => !fresh.has(m))
}

/**
 * months（古い順。summaryLastYm 以前の月だけ）の集計を作り直す文（1つの db.batch に入れる。印の上書き・その月の行の削除・入れ直しが1つの処理になる）。
 * 1つ目の文は印の書き込みで、meta.changes が 0 なら書けなかった（本部の閲覧中など）
 */
export function refreshSummaryStmts(db: D1Database, companyId: number, months: string[], now: string): D1PreparedStatement[] {
  if (!months.length) return []
  const list = JSON.stringify(months)
  return [
    db.prepare(`INSERT INTO ${RS_MONTHS} (company_id, ym, computed_at) SELECT ?, value, ? FROM json_each(?) WHERE true
      ON CONFLICT(company_id, ym) DO UPDATE SET computed_at = excluded.computed_at`).bind(companyId, now, list),
    db.prepare(`DELETE FROM ${RS_MONTH} WHERE company_id = ? AND ym IN (SELECT value FROM json_each(?))`).bind(companyId, list),
    db.prepare(`DELETE FROM ${RS_DAY} WHERE company_id = ? AND work_date >= ? AND work_date < ? AND substr(work_date, 1, 7) IN (SELECT value FROM json_each(?))`)
      .bind(companyId, `${months[0]}-01`, `${nextYm(months[months.length - 1])}-01`, list),
    // 案件 × スタッフ: 日報の数・印のある日報の数・日報のある日（ビット）・数値の項目の合計（values_json）・スキルシートの決め打ちの項目の合計（legacy_json）。
    // 項目の合計は実績分析の月の表（jsonKeySums）と同じ数え方: 日報ごとにキーの最初の値だけ（同じキーが2つある JSON は前の値）、
    // 数値の値のあるキーだけを出し、オブジェクトでない JSON（配列など）の値は 0 として数える
    db.prepare(`INSERT INTO ${RS_MONTH} (company_id, ym, project_id, staff_id, reports, flagged, days_mask, values_json, legacy_json)
      SELECT ?1, c.ym, c.project_id, c.staff_id, c.reports, c.flagged, c.days_mask, v.values_json,
        json_object('mnp', c.mnp, 'pi', c.pi, 'shinki', c.shinki, 'hikari', c.hikari, 'seiyaku', c.seiyaku)
      FROM (SELECT m.value AS ym, dr.project_id, dr.staff_id, COUNT(*) AS reports, SUM(CASE WHEN ${FLAGGED} THEN 1 ELSE 0 END) AS flagged,
          SUM(DISTINCT 1 << (CAST(substr(dr.work_date, 9, 2) AS INTEGER) - 1)) AS days_mask,
          ${LEGACY_KEYS.map(k => `SUM(COALESCE(CASE WHEN json_valid(dr.report_values) THEN json_extract(dr.report_values, '$.${k}') END, 0)) AS ${k}`).join(', ')}
        FROM json_each(?2) m CROSS JOIN daily_reports dr WHERE ${IN_MONTH} GROUP BY m.value, dr.project_id, dr.staff_id) c
      LEFT JOIN (SELECT ym, project_id, staff_id, json_group_object(k, v) AS values_json FROM (
          SELECT ym, project_id, staff_id, k, SUM(v) AS v FROM (
            SELECT m.value AS ym, dr.project_id, dr.staff_id, CAST(je.key AS TEXT) AS k, je.type IN ('integer', 'real') AS isnum,
              CASE WHEN je.type IN ('integer', 'real') AND json_type(dr.report_values) = 'object' THEN je.value ELSE 0 END AS v, MIN(je.id)
            FROM json_each(?2) m CROSS JOIN daily_reports dr, json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je
            WHERE ${IN_MONTH} AND je.key IS NOT NULL
            GROUP BY dr.daily_report_id, je.key)
          GROUP BY ym, project_id, staff_id, k HAVING MAX(isnum) = 1) GROUP BY ym, project_id, staff_id) v
        ON v.ym = c.ym AND v.project_id = c.project_id AND v.staff_id = c.staff_id`).bind(companyId, list),
    // 日 × 案件と、日 × 全案件（project_id = 0。2つの案件に出した人を1人と数える）
    db.prepare(`INSERT INTO ${RS_DAY} (company_id, work_date, project_id, reports, staff_count, project_count, flagged)
      SELECT ?1, dr.work_date, dr.project_id, COUNT(*), COUNT(DISTINCT dr.staff_id), 1, SUM(CASE WHEN ${FLAGGED} THEN 1 ELSE 0 END)
      FROM json_each(?2) m CROSS JOIN daily_reports dr WHERE ${IN_MONTH} GROUP BY dr.work_date, dr.project_id`).bind(companyId, list),
    db.prepare(`INSERT INTO ${RS_DAY} (company_id, work_date, project_id, reports, staff_count, project_count, flagged)
      SELECT ?1, dr.work_date, 0, COUNT(*), COUNT(DISTINCT dr.staff_id), COUNT(DISTINCT dr.project_id), SUM(CASE WHEN ${FLAGGED} THEN 1 ELSE 0 END)
      FROM json_each(?2) m CROSS JOIN daily_reports dr WHERE ${IN_MONTH} GROUP BY dr.work_date`).bind(companyId, list),
  ]
}

// ---------- 読むときの部品 ----------
/** 日報のある日の数（days_mask の立っているビットの数） */
export function popcount(n: number): number {
  let c = 0
  for (let x = Number(n) || 0; x > 0; x = Math.floor(x / 2)) c += x % 2
  return c
}
/** values_json（{ キー: 合計 }）を into に足す */
export function addValues(into: Map<string, number>, json: unknown) {
  if (typeof json !== 'string' || !json) return
  let o: any
  try { o = JSON.parse(json) } catch { return }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) into.set(k, (into.get(k) || 0) + v)
}

// ---------- 定期削除（retention.ts。日報の3年）----------
// 基準日 cutoff（'YYYY-MM-DD'。これより前の日報を消す）の月までの集計を消す。会社ごとに主キーの範囲で引く（表をすべて読まない）
const EACH_COMPANY = 'company_id IN (SELECT company_id FROM companies)'
/** 印を消す文。日報を消す文より前に、同じ batch に入れる（印が残っていると、トリガーが消した印の数が日報の削除の件数に入るため） */
export function summaryMarksBeforeStmt(db: D1Database, cutoff: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM ${RS_MONTHS} WHERE ${EACH_COMPANY} AND ym <= substr(?, 1, 7)`).bind(cutoff)
}
/** 集計の行を消す文 */
export function summaryRowsBeforeStmts(db: D1Database, cutoff: string): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM ${RS_MONTH} WHERE ${EACH_COMPANY} AND ym <= substr(?, 1, 7)`).bind(cutoff),
    db.prepare(`DELETE FROM ${RS_DAY} WHERE ${EACH_COMPANY} AND work_date < date(substr(?, 1, 7) || '-01', '+1 month')`).bind(cutoff),
  ]
}

/**
 * fromYm〜toYm（summaryLastYm 以前）の集計を使えるようにする。印を読み、無い・古い月を1つの batch で集計し直す（消して入れ直す・印は上書き）。
 * 集計を書けなかったとき（本部の閲覧中は D1 が読み取り専用。hq-support.ts の readOnlyDb）は false（呼び出し側は日報の表から数える）
 */
export async function summaryReady(db: D1Database, companyId: number, fromYm: string, toYm: string, now: string): Promise<boolean> {
  if (fromYm > toYm) return true
  const stale = staleSummaryMonths(monthsBetween(fromYm, toYm), await summaryMarksStmt(db, companyId, fromYm, toYm).all(), now)
  if (!stale.length) return true
  const out = await db.batch(refreshSummaryStmts(db, companyId, stale, now))
  return Number(out[0]?.meta?.changes) > 0
}
