// =========================================================
// 交通費の標準（スタッフ × 開催場所。#564）
// staff_transport_defaults の site_id = 0 は、そのスタッフのすべての開催場所に使う標準。
// シフトを作るとき（シフトボードの割り当て・一括登録、募集の承認）に交通費の入力がなければ、
// 開催場所の標準 → スタッフの標準の順に探して実費（transportation_fee）に入れる。どちらもなければ 0
// =========================================================
import { JSON_IN, bindJsonArray } from './d1-chunk'

// staff_id → (site_id → 金額)
export type TransportDefaults = Map<number, Map<number, number>>
export async function loadTransportDefaults(db: D1Database, companyId: number, staffIds: number[]): Promise<TransportDefaults> {
  const map: TransportDefaults = new Map()
  const ids = bindJsonArray([...new Set(staffIds.map(Number).filter(n => Number.isInteger(n) && n > 0))])
  if (ids === '[]') return map
  const rows = (await db.prepare(`SELECT staff_id, site_id, amount FROM staff_transport_defaults WHERE company_id = ? AND staff_id IN ${JSON_IN}`)
    .bind(companyId, ids).all()).results as any[]
  for (const r of rows) { const m = map.get(Number(r.staff_id)) || new Map<number, number>(); m.set(Number(r.site_id) || 0, Number(r.amount) || 0); map.set(Number(r.staff_id), m) }
  return map
}
// 標準の金額（開催場所の標準 → スタッフの標準）。なければ null
export function transportDefaultFor(map: TransportDefaults | null | undefined, staffId: any, siteId: any): number | null {
  const m = map?.get(Number(staffId))
  if (!m) return null
  const site = Number(siteId) || 0
  if (site && m.has(site)) return m.get(site)!
  return m.has(0) ? m.get(0)! : null
}
// 入力された交通費（空欄・未指定なら null）
export const feeInput = (v: any): number | null => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)))
