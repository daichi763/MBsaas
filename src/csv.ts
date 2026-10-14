// CSV 出力の共通処理（精算・打刻修正申請・案件報告管理の履歴で共用）
// UTF-8（BOM 付き。Excel で日本語を読めるようにする）・CRLF。数式として実行される値は先頭に ' を付ける
export function csvCell(v: any): string {
  if (v == null) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s // 数式の実行を防ぐ（負の数値はそのまま）
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(header: string[], rows: any[][]) {
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
// ファイル名は日本語を含むため filename*（RFC 5987）で渡す
export function csvResponse(fileName: string, csv: string) {
  return new Response(csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
  } })
}
