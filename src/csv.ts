// CSV 出力の共通処理（精算・打刻修正申請・案件報告管理の履歴・通知メール・既読率レポート・実績分析で共用）
// UTF-8（BOM 付き。Excel で日本語を読めるようにする）・CRLF。数式として実行される値は先頭に ' を付ける
export function csvCell(v: any): string {
  if (v == null) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s // 数式の実行を防ぐ（負の数値はそのまま）
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
// 社員番号などの識別子の列（#571）。Excel は数字・日付に見える文字列を変換する（000123 → 123、1-2 → 1月2日、1E3 → 1000）ため、
// ="000123" の形（固定の文字列。数式の実行にはならない）で出す。数字と区切り記号だけの値に限り、それ以外は csvCell と同じ
export function csvTextCell(v: any): string {
  if (v == null || v === '') return ''
  const s = String(v)
  if (/^[0-9][0-9eE\-\/.:,\s]*$/.test(s)) return `"=""${s}"""`
  return csvCell(s)
}
export type CsvOptions = {
  // 識別子として文字のまま出す列（見出しの名前で指定する）
  textCols?: string[]
  // 見出しの前に入れる注記（上限で切ったときなど。普段は入れない）
  note?: string
}
export function toCsv(header: string[], rows: any[][], opts: CsvOptions = {}) {
  const text = new Set((opts.textCols || []).map(h => header.indexOf(h)).filter(i => i >= 0))
  const line = (r: any[]) => r.map((v, i) => (text.has(i) ? csvTextCell(v) : csvCell(v))).join(',')
  const lines = [...(opts.note ? [csvCell(opts.note)] : []), header.map(csvCell).join(','), ...rows.map(line)]
  return '﻿' + lines.join('\r\n') + '\r\n'
}
// ファイル名は日本語を含むため filename*（RFC 5987）で渡す
export function csvResponse(fileName: string, csv: string, headers: Record<string, string> = {}) {
  return new Response(csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
    ...headers,
  } })
}

// 履歴・申請・送信状況の CSV の上限（#102）。新しい順に上限まで取り、古い順に並べ直して出す。
// 上限を超えたら、見出しの前の注記と X-Csv-Total / X-Csv-Truncated ヘッダーで知らせる
export const CSV_LIMIT = 10000
export function csvLimitNote(total: number, limit = CSV_LIMIT): string | undefined {
  return total > limit
    ? `※ 条件に合う全${total.toLocaleString('ja-JP')}件のうち、新しい${limit.toLocaleString('ja-JP')}件を出力しています。期間を区切って、複数回に分けて出力してください`
    : undefined
}
export function csvLimitHeaders(total: number, limit = CSV_LIMIT): Record<string, string> {
  return { 'X-Csv-Total': String(total), 'X-Csv-Truncated': total > limit ? '1' : '0' }
}
// 新しい順に上限＋1件まで読み、超えたときだけ件数を数える。戻り値の rows は古い順
export async function loadLatestForCsv(db: D1Database, select: string, countSql: string, bind: any[], limit = CSV_LIMIT): Promise<{ rows: any[]; total: number }> {
  const got = (await db.prepare(`${select} LIMIT ${limit + 1}`).bind(...bind).all()).results as any[]
  let total = got.length
  if (got.length > limit) total = Number(((await db.prepare(countSql).bind(...bind).first()) as any)?.n || 0)
  return { rows: got.slice(0, limit).reverse(), total }
}

// 操作した人・変更者のロールの表示名（打刻修正・報告設定の CSV で共用。#474）
export const ROLE_LABEL: Record<string, string> = {
  company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', staff: 'スタッフ', system_admin: '本部',
}
export const roleLabel = (r: any) => (r == null || r === '' ? '' : ROLE_LABEL[r] || String(r))
