// 精算の締め（settlement_closings。#170）の確認をシフトボード（shift-board.ts）から使う。
// settlement.ts の closedMessage と同じ条件・文言（settlement.ts は shift-board.ts を読み込むため、循環しないようここに置く）
import { isISODate } from './validate'

type ClosingRange = { period_from: string; period_to: string }

const closedText = (k: ClosingRange) => `${k.period_from}〜${k.period_to} は精算を締めています。変更するには精算画面で締めを解除してください`

/**
 * from〜to（稼働日）と重なる有効な締めを読み、稼働日ごとに締めの文言を返す関数を作る（締めていない日は null）。
 * まとめて登録・コピーなどで日付ごとに問い合わせないよう、1回だけ読む
 */
export async function closedChecker(db: D1Database, companyId: number, from: string, to: string): Promise<(date: any) => string | null> {
  if (!isISODate(from) || !isISODate(to)) return () => null
  const list = (await db.prepare(`SELECT period_from, period_to FROM settlement_closings
    WHERE company_id = ? AND reopened_at IS NULL AND period_from <= ? AND period_to >= ? ORDER BY period_from`).bind(companyId, to, from).all()).results as ClosingRange[]
  if (!list.length) return () => null
  return (date: any) => {
    const d = String(date || '')
    const k = list.find(x => x.period_from <= d && d <= x.period_to)
    return k ? closedText(k) : null
  }
}

/** 1つの稼働日が締めた期間に入っていれば、その文言 */
export async function closedOn(db: D1Database, companyId: number, date: any): Promise<string | null> {
  if (!isISODate(date)) return null
  return (await closedChecker(db, companyId, date, date))(date)
}
