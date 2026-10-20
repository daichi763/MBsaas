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

// =========================================================
// 振込データ（全銀協の総合振込フォーマット。#471）
// 1レコード120バイトの固定長・Shift_JIS（半角カナ・英大文字・数字だけを使う）。レコードの区切りは CRLF。
// ヘッダー（1）→ データ（2、1件1行）→ トレーラー（8）→ エンド（9）
// =========================================================
const HALF_KANA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ'
const FULL_KANA = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン'
// 全銀で使えない小書きの文字は大きい文字にする（ｬ → ﾔ など）
const SMALL_TO_LARGE: Record<string, string> = { 'ｧ': 'ｱ', 'ｨ': 'ｲ', 'ｩ': 'ｳ', 'ｪ': 'ｴ', 'ｫ': 'ｵ', 'ｬ': 'ﾔ', 'ｭ': 'ﾕ', 'ｮ': 'ﾖ', 'ｯ': 'ﾂ' }
const EXTRA_KANA: Record<string, string> = { 'ヰ': 'ｲ', 'ヱ': 'ｴ', 'ヮ': 'ﾜ', 'ヵ': 'ｶ', 'ヶ': 'ｹ', '\u3099': 'ﾞ', '\u309A': 'ﾟ', '゛': 'ﾞ', '゜': 'ﾟ' }
const ZENGIN_OK = /^[0-9A-Z\uFF66-\uFF9F ().\-\/]*$/
/** 全銀で使える文字（半角カナ・英大文字・数字・空白と ( ) . - /）に直す。直せない文字があれば null */
export function toZenginKana(v: any): string | null {
  // NFKC で半角カナ → 全角、全角英数 → 半角にそろえてから、ひらがな → カタカナ、濁点を分けて半角カナにする
  let s = String(v ?? '').normalize('NFKC').toUpperCase().replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
  s = s.normalize('NFD').replace(/[ー―‐－−~～]/g, '-').replace(/\u3000/g, ' ').replace(/[・･]/g, '.')
  let out = ''
  for (const ch of s) {
    const i = FULL_KANA.indexOf(ch)
    const h = i >= 0 ? HALF_KANA[i] : EXTRA_KANA[ch] ?? ch
    out += SMALL_TO_LARGE[h] ?? (h === 'ｰ' ? '-' : h)
  }
  out = out.replace(/\s+/g, ' ').trim()
  return ZENGIN_OK.test(out) ? out : null
}
/** 預金種目のコード（1 普通 / 2 当座 / 4 貯蓄）。従業員管理の自由入力（「普通」など）も読む。分からなければ null */
export function accountTypeCode(v: any): '1' | '2' | '4' | null {
  const s = String(v ?? '').trim()
  if (/^(1|普通|普通預金|総合|futsu|ordinary)$/i.test(s)) return '1'
  if (/^(2|当座|当座預金|toza|checking)$/i.test(s)) return '2'
  if (/^(4|貯蓄|貯蓄預金|savings)$/i.test(s)) return '4'
  return null
}
export type ZenginHeader = { requester_code: string; requester_kana: string; transfer_date: string; bank_code: string; bank_name?: string | null
  branch_code: string; branch_name?: string | null; account_type: string; account_number: string }
export type ZenginRecord = { bank_code: string; bank_name?: string | null; branch_code: string; branch_name?: string | null; account_type: string
  account_number: string; holder_kana: string; amount: number; customer_code?: string | number | null }
const zAlpha = (v: any, len: number) => (toZenginKana(v) ?? '').slice(0, len).padEnd(len, ' ')
const zNum = (v: any, len: number) => {
  const s = String(v ?? '').replace(/\D/g, '')
  if (s.length > len) throw new Error(`桁数が多すぎます（${len}桁まで）: ${s}`)
  return s.padStart(len, '0')
}
/** 総合振込のファイル（Shift_JIS のバイト列）。transfer_date は YYYY-MM-DD（取組日は MMDD） */
export function zenginTransferFile(h: ZenginHeader, rows: ZenginRecord[]): Uint8Array {
  const mmdd = h.transfer_date.slice(5, 7) + h.transfer_date.slice(8, 10)
  const lines: string[] = []
  lines.push('1' + '21' + '0' + zNum(h.requester_code, 10) + zAlpha(h.requester_kana, 40) + mmdd + zNum(h.bank_code, 4) + zAlpha(h.bank_name, 15)
    + zNum(h.branch_code, 3) + zAlpha(h.branch_name, 15) + (accountTypeCode(h.account_type) || '1') + zNum(h.account_number, 7) + ' '.repeat(17))
  let total = 0
  for (const r of rows) {
    const amount = Math.round(Number(r.amount) || 0)
    total += amount
    lines.push('2' + zNum(r.bank_code, 4) + zAlpha(r.bank_name, 15) + zNum(r.branch_code, 3) + zAlpha(r.branch_name, 15) + ' '.repeat(4)
      + (accountTypeCode(r.account_type) || '1') + zNum(r.account_number, 7) + zAlpha(r.holder_kana, 30) + zNum(amount, 10) + '0'
      + zNum(r.customer_code ?? '', 10) + ' '.repeat(10) + '7' + ' ' + ' '.repeat(7))
  }
  lines.push('8' + zNum(rows.length, 6) + zNum(total, 12) + ' '.repeat(101))
  lines.push('9' + ' '.repeat(119))
  const text = lines.join('\r\n') + '\r\n'
  // 半角カナ（U+FF61〜U+FF9F）は JIS X 0201 の 0xA1〜0xDF、それ以外は ASCII の1バイト
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out[i] = c >= 0xFF61 && c <= 0xFF9F ? c - 0xFF61 + 0xA1 : c < 0x80 ? c : 0x20
  }
  return out
}
