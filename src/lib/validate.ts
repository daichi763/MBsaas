// サーバー側の入力検証（画面のセレクトや入力欄の制約は API を直接呼べば回避できるため、保存の前にここで確かめる）

// 時刻 HH:MM（00:00〜23:59）
export function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

// 日付 YYYY-MM-DD（実在する日付に限る）
export function isISODate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

// 決められた値のどれかか
export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
}

// 整数に変換する。整数でない・範囲外なら null
export function toInt(v: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}

// 相談のカテゴリ・緊急度（admin.js / staff.js の CAT_LABELS と同じキー）
export const CONSULT_CATEGORIES = ['health', 'absence', 'store_trouble', 'claim', 'relationship', 'shift', 'question', 'other'] as const
export const CONSULT_URGENCIES = ['low', 'normal', 'high'] as const

// 日報の値を、案件の日報テンプレートの項目（fields_json）に合わせて取り出す。
// テンプレートにないキーは捨てる。数値の項目は 0〜REPORT_NUMBER_MAX の整数、それ以外は文字列（長さに上限）にする。
// キーは本部が自由に付けられる（日本語の場合もある）ため、文字種は制限せず、制御文字と長さだけを見る。
// テンプレートの無い案件では、報告用URLの画面が「報告内容（free）」の欄だけを出すので、free だけを受け付ける。
const REPORT_KEY_RE = /^[^\u0000-\u001f\u007f]{1,100}$/
const REPORT_TEXT_MAX = 2000
// 数値の項目は件数（0 以上の整数）。桁違いの誤入力で集計・ランキングがゆがまないよう上限を置く
export const REPORT_NUMBER_MAX = 99999
// 保存する JSON 全体の上限（アプリと報告用URLで同じ）
export const REPORT_JSON_MAX = 20000
export const NO_TEMPLATE_FIELDS = [{ key: 'free', label: '報告内容', type: 'textarea' }]
export function pickReportValues(fieldsJson: unknown, values: unknown): { values: Record<string, number | string> } | { error: string } {
  let fields: any[] = []
  try { fields = typeof fieldsJson === 'string' ? JSON.parse(fieldsJson) : [] } catch { fields = [] }
  if (!Array.isArray(fields) || fields.length === 0) fields = NO_TEMPLATE_FIELDS
  if (values !== undefined && values !== null && (typeof values !== 'object' || Array.isArray(values))) return { error: '日報の形式が正しくありません' }
  const src = values ? values as Record<string, unknown> : {}
  const out: Record<string, number | string> = {}
  for (const f of fields) {
    const key = f && typeof f.key === 'string' ? f.key : ''
    if (!REPORT_KEY_RE.test(key) || key === '__proto__' || !Object.prototype.hasOwnProperty.call(src, key)) continue
    const v = src[key]
    if (v === null || v === undefined) continue
    const label = String(f.label || key)
    if (f.type === 'number') {
      const n = v === '' ? 0 : typeof v === 'number' ? v : Number(String(v).trim())
      if (typeof v === 'boolean' || typeof v === 'object' || !Number.isInteger(n) || n < 0 || n > REPORT_NUMBER_MAX) {
        return { error: `「${label}」は0〜${REPORT_NUMBER_MAX}の整数で入力してください` }
      }
      out[key] = n
    } else {
      if (typeof v === 'object') return { error: `「${label}」の形式が正しくありません` }
      const s = String(v)
      if (s.length > REPORT_TEXT_MAX) return { error: `「${label}」は${REPORT_TEXT_MAX}文字以内で入力してください` }
      out[key] = s
    }
  }
  if (JSON.stringify(out).length > REPORT_JSON_MAX) return { error: '入力内容が長すぎます' }
  return { values: out }
}

// 日報テンプレートの項目の required（必須）と maxLength（文字数の上限）を確かめる（#349 #525）。
// 送られた値（pickReportValues の前の値）で見る。数値の必須は空欄・未送信を、テキストの必須は空白だけも未入力とする。
// アプリと報告用URLで同じものを呼ぶ。問題がなければ null
export function reportFieldRulesError(fieldsJson: unknown, values: unknown): string | null {
  let fields: any[] = []
  try { fields = typeof fieldsJson === 'string' ? JSON.parse(fieldsJson) : [] } catch { fields = [] }
  if (!Array.isArray(fields)) return null
  const src = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {}
  for (const f of fields) {
    const key = f && typeof f.key === 'string' ? f.key : ''
    if (!key) continue
    const label = String(f.label || key)
    const v = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
    if (isRequiredField(f) && empty) {
      return f.type === 'number' ? `「${label}」を入力してください（0件の場合は0を入力してください）` : `「${label}」を入力してください`
    }
    const max = toInt(f.maxLength ?? f.max_length, 1, REPORT_TEXT_MAX)
    if (f.type !== 'number' && max && typeof v === 'string' && v.length > max) return `「${label}」は${max}文字以内で入力してください`
  }
  return null
}
// テンプレートの項目が必須か（true / 1 / "true" を必須とみなす）
export function isRequiredField(f: any): boolean {
  return !!f && (f.required === true || f.required === 1 || f.required === 'true')
}

// アップロードされたファイル名から制御文字を除き、長さを整える（拡張子は残す）
export function cleanFileName(name: unknown, max = 200): string {
  let s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!s) s = 'file'
  if (s.length > max) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : ''
    s = s.slice(0, max - ext.length) + ext
  }
  return s
}
