// サーバーの日時の共通関数（#9955）。DB の日時は日本時間の 'YYYY-MM-DD HH:MM:SS'、日付は 'YYYY-MM-DD' の文字列で持つ。
// 日本時間は UTC に 9 時間を足して toISOString で作る（日本には夏時間がないため固定の差でよい）。
// 日付の計算は 'YYYY-MM-DDT00:00:00Z' として UTC で行い、実行環境のタイムゾーンに左右されないようにする。
const JST_OFFSET_MS = 9 * 3600 * 1000
const DAY_MS = 86400000

/** エポックミリ秒を日本時間の 'YYYY-MM-DD HH:MM:SS' にする */
export function jstOf(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}
/** 今の日本時間の 'YYYY-MM-DD HH:MM:SS'。offsetMs を渡すとその分ずらす（負の値は過去） */
export function nowJST(offsetMs = 0): string {
  return jstOf(Date.now() + offsetMs)
}
/** 今日（日本時間）の 'YYYY-MM-DD' */
export function todayJST(): string {
  return nowJST().slice(0, 10)
}
/** 'YYYY-MM-DD' の n 日後（負の値は前）。月末・年末・うるう年もまたぐ */
export function addDays(d: string, n: number): string {
  const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10)
}
/** a から b まで何日か（b が後なら正） */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS)
}
/** 'YYYY-MM-DD' の形か（形だけを見る。2月30日などの日付の正しさは見ない） */
export const isDate = (s: any): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
