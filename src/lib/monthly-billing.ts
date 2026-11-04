// =========================================================
// 請求単価の「月額（固定）」（#9702。表は monthly_bill_rules。migrations/0096_monthly_billing.sql）
//
// 案件（またはその案件のスタッフ）に月額を決めておき、その月に確定・代打のシフトが1件以上あれば、月に1回だけ請求する。
// シフトの数・時間には左右されず、シフトの請求額（shifts.unit_price・shiftTotals）には入れない。
// 精算・請求前確認・請求の CSV・請求明細書・案件とクライアントの売上に「月額」の行として足す。支払には使わない。
//
// 決まり:
//   - その月 = 暦月（1日〜末日）。シフトの有無は暦月の全体で見る（精算の期間がその月の途中で切れていても、月の全体で数える）
//   - 月額を計上する日は、その月の最初の対象のシフト（確定・代打）の稼働日。精算・明細書の期間（from〜to）には、計上する日が期間に入る月の月額を出す。
//     期間を続けて区切れば、どの月の月額も1回だけ出る。締めた期間（#170）のシフトは追加・削除できないので、締めた後に月額の行が別の期間へ動くことはない
//   - 案件全体のルールとスタッフ別のルールは別の行として、両方を請求する（時給・日額のシフトとの混在も、別の行として出す）
//   - 単価を変えるのは月の単位（適用開始月）。月の途中で変えても、その月は1つの月額だけを使う（日割りしない）
// =========================================================
import { JSON_IN, bindJsonArray } from './d1-chunk'

export const MONTHLY_LABEL = '月額（固定）'
export const MONTHLY_WORK_STATUSES = ['confirmed', 'substitute']

export type MonthlyLine = {
  kind: 'monthly'; ym: string; rule_id: number
  project_id: number; project_name: string; client_id: number | null; client_name: string
  staff_id: number | null; staff_name: string | null
  amount: number; memo: string | null
  shifts: number; confirmed: number // その月の対象のシフトの数と、そのうち確定済みの数
  bill_date: string // 計上する日（その月の最初の対象のシフトの稼働日）
}

export const isYM = (v: any): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
export function addMonthsYM(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}
// from〜to（YYYY-MM-DD）と重なる月
export function monthsOverlapping(from: string, to: string): string[] {
  const out: string[] = []
  for (let ym = from.slice(0, 7), i = 0; i < 24 && ym <= to.slice(0, 7); i++, ym = addMonthsYM(ym, 1)) out.push(ym)
  return out
}
export const ruleActiveIn = (r: { valid_from?: string | null; valid_to?: string | null }, ym: string) => (!r.valid_from || r.valid_from <= ym) && (!r.valid_to || r.valid_to >= ym)

export type MonthlyQuery = {
  months: string[]
  from?: string | null; to?: string | null // 計上する日がこの期間（YYYY-MM-DD）に入る行だけ（精算・明細書）
  client_id?: number | null   // 0 = クライアントなし
  project_id?: number | null
  staff_id?: number | null    // 指定するとそのスタッフのスタッフ別のルールだけ（案件全体の行は出さない）
  until?: string | null       // この日（YYYY-MM-DD）までのシフトだけで有無を見る（請求前確認・売上の概算は今日まで）
}

// 月額の行を作る（ルールのない会社は問い合わせ1回で終わる）
export async function loadMonthlyLines(db: D1Database, companyId: number, q: MonthlyQuery): Promise<MonthlyLine[]> {
  const months = [...new Set(q.months.filter(isYM))].sort()
  if (!months.length) return []
  const minYM = months[0], maxYM = months[months.length - 1]
  const w = ['r.company_id = ?', '(r.valid_from IS NULL OR r.valid_from <= ?)', '(r.valid_to IS NULL OR r.valid_to >= ?)']
  const bind: any[] = [companyId, maxYM, minYM]
  if (q.project_id) { w.push('r.project_id = ?'); bind.push(q.project_id) }
  if (q.client_id === 0) w.push('p.client_id IS NULL')
  else if (q.client_id) { w.push('p.client_id = ?'); bind.push(q.client_id) }
  if (q.staff_id) { w.push('r.staff_id = ?'); bind.push(q.staff_id) }
  const rules = (await db.prepare(`SELECT r.rule_id, r.project_id, r.staff_id, r.amount, r.valid_from, r.valid_to, r.memo,
      p.project_name, p.client_id, cl.client_name, us.name AS staff_name
    FROM monthly_bill_rules r JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id
    LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = r.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE ${w.join(' AND ')}`).bind(...bind).all()).results as any[]
  if (!rules.length) return []
  const pids = [...new Set(rules.map(r => Number(r.project_id)))]
  const sbind: any[] = [companyId, bindJsonArray(pids), minYM + '-01', addMonthsYM(maxYM, 1) + '-01']
  let until = ''
  if (q.until) { until = ' AND s.work_date <= ?'; sbind.push(q.until) }
  const counts = (await db.prepare(`SELECT s.project_id, s.staff_id, substr(s.work_date, 1, 7) AS ym, COUNT(*) AS n, MIN(s.work_date) AS first,
      SUM(CASE WHEN s.settle_status = 'confirmed' THEN 1 ELSE 0 END) AS c
    FROM shifts s WHERE s.company_id = ? AND s.project_id IN ${JSON_IN} AND s.work_date >= ? AND s.work_date < ?${until}
      AND s.status IN (${MONTHLY_WORK_STATUSES.map(() => '?').join(',')})
    GROUP BY s.project_id, s.staff_id, ym`).bind(...sbind, ...MONTHLY_WORK_STATUSES).all()).results as any[]
  // 案件 × 月、案件 × スタッフ × 月 のシフトの数
  type Cnt = { n: number; c: number; first: string }
  const byProject = new Map<string, Cnt>(), byStaff = new Map<string, Cnt>()
  const add = (m: Map<string, Cnt>, k: string, x: any) => {
    const a = m.get(k) || { n: 0, c: 0, first: String(x.first) }
    a.n += Number(x.n) || 0; a.c += Number(x.c) || 0; if (String(x.first) < a.first) a.first = String(x.first)
    m.set(k, a)
  }
  for (const x of counts) {
    add(byProject, `${x.project_id}:${x.ym}`, x)
    if (x.staff_id != null) add(byStaff, `${x.project_id}:${x.staff_id}:${x.ym}`, x)
  }
  // 同じ対象（案件全体／同じスタッフ）で期間が重なるルールがあれば（API では作らせない）、適用開始月の新しいものを使う
  rules.sort((a, b) => String(b.valid_from || '').localeCompare(String(a.valid_from || '')) || b.rule_id - a.rule_id)
  const used = new Set<string>()
  const out: MonthlyLine[] = []
  for (const ym of months) {
    for (const r of rules) {
      if (!ruleActiveIn(r, ym)) continue
      const scope = `${r.project_id}:${r.staff_id ?? ''}:${ym}`
      if (used.has(scope)) continue
      used.add(scope)
      const cnt = r.staff_id != null ? byStaff.get(`${r.project_id}:${r.staff_id}:${ym}`) : byProject.get(`${r.project_id}:${ym}`)
      if (!cnt || !cnt.n) continue
      if ((q.from && cnt.first < q.from) || (q.to && cnt.first > q.to)) continue
      out.push({
        kind: 'monthly', ym, rule_id: Number(r.rule_id), project_id: Number(r.project_id), project_name: String(r.project_name || ''),
        client_id: r.client_id == null ? null : Number(r.client_id), client_name: String(r.client_name || ''),
        staff_id: r.staff_id == null ? null : Number(r.staff_id), staff_name: r.staff_id == null ? null : String(r.staff_name || ''),
        amount: Number(r.amount) || 0, memo: r.memo ?? null, shifts: cnt.n, confirmed: cnt.c, bill_date: cnt.first,
      })
    }
  }
  out.sort((a, b) => a.ym.localeCompare(b.ym) || (a.client_name || '').localeCompare(b.client_name || '', 'ja') || a.project_name.localeCompare(b.project_name, 'ja')
    || (a.staff_id == null ? -1 : b.staff_id == null ? 1 : (a.staff_name || '').localeCompare(b.staff_name || '', 'ja')))
  return out
}

export const monthlyTotal = (lines: MonthlyLine[]) => lines.reduce((n, l) => n + l.amount, 0)
// 「2026年11月分」
export const ymLabel = (ym: string) => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月分`
