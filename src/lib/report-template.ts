// 本部が配信する日報テンプレートの項目（fields_json）の検証（#378）。
// 日報の画面は data-key ごとに値を集め、type が 'number' の項目だけを数値の欄・件数の集計に使う（staff.js・report-link.js）。
// キーの重複・空欄やタイプの書き間違いがあると、値の上書きや集計漏れになるため、保存の前にここで確かめる。
// 画面（hq.js）のプレビューも同じ規則で確かめる。

export const TEMPLATE_FIELD_TYPES = ['number', 'text', 'textarea'] as const
export type TemplateFieldType = typeof TEMPLATE_FIELD_TYPES[number]
export type TemplateField = { key: string; label: string; type: TemplateFieldType; required?: true; placeholder?: string; maxLength?: number }

export const TEMPLATE_FIELDS_MAX = 50
export const TEMPLATE_NAME_MAX = 60
const LABEL_MAX = 40
const PLACEHOLDER_MAX = 200
const TEXT_MAX = 2000
// キーは半角英数字と _（先頭は英字）。日報の値の JSON のキーになる
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
// 日報の値に別の用途で保存しているキー（インシデント・クレームの内容。lib/daily-report.ts）と、JS の特別な名前
const RESERVED_KEYS = new Set(['incident_note', 'complaint_note', 'incident_flag', 'complaint_flag', 'constructor', 'prototype', 'toString', 'hasOwnProperty'])

// キーの規則（KEY_RE。#378）より前に作ったテンプレートには、日本語などの規則に合わないキーがある（#165）。
// 編集では、そのテンプレートにすでにあるキー（legacyKeys）は規則に合わなくてもそのまま認める（過去の日報の値のキーなので変えられない）。
// 新しく足す項目のキーには規則を当てる
const LEGACY_KEY_MAX = 100
export function validateTemplateFields(raw: unknown, opts: { legacyKeys?: Iterable<unknown> } = {}): { fields: TemplateField[] } | { error: string } {
  const legacy = new Set([...(opts.legacyKeys || [])].filter((k): k is string => typeof k === 'string' && !!k.trim()).map(k => k.trim()))
  if (!Array.isArray(raw) || raw.length === 0) return { error: '項目を1つ以上入力してください' }
  if (raw.length > TEMPLATE_FIELDS_MAX) return { error: `項目は${TEMPLATE_FIELDS_MAX}個までにしてください` }
  const seen = new Set<string>()
  const fields: TemplateField[] = []
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] as any
    const at = `${i + 1}番目の項目`
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: `${at}の形式が正しくありません` }
    const key = typeof f.key === 'string' ? f.key.trim() : ''
    if (!key) return { error: `${at}のキーが空欄です` }
    const legacyOk = legacy.has(key) && key.length <= LEGACY_KEY_MAX && !/[\u0000-\u001f\u007f]/.test(key)
    if (!legacyOk && !KEY_RE.test(key)) return { error: `${at}のキー「${key.slice(0, 40)}」は、半角英字で始まる英数字と _ の40文字以内にしてください` }
    if (RESERVED_KEYS.has(key)) return { error: `${at}のキー「${key}」は日報の別の用途で使っているため使えません` }
    if (seen.has(key.toLowerCase())) return { error: `${at}のキー「${key}」が重複しています（大文字・小文字の違いだけのキーも重複とみなします）` }
    seen.add(key.toLowerCase())
    const label = typeof f.label === 'string' && f.label.trim() ? f.label.trim() : key
    if (/[\u0000-\u001f\u007f]/.test(label) || label.length > LABEL_MAX) return { error: `${at}の表示名は${LABEL_MAX}文字以内にしてください` }
    const type = f.type === undefined || f.type === null || f.type === '' ? 'text' : f.type
    if (!(TEMPLATE_FIELD_TYPES as readonly unknown[]).includes(type)) {
      return { error: `${at}（${label}）のタイプ「${String(type).slice(0, 20)}」は使えません。number / text / textarea のどれかにしてください` }
    }
    const out: TemplateField = { key, label, type }
    if (f.required === true || f.required === 1 || f.required === 'true') out.required = true
    if (f.placeholder !== undefined && f.placeholder !== null && f.placeholder !== '') {
      if (typeof f.placeholder !== 'string' || f.placeholder.length > PLACEHOLDER_MAX) return { error: `${at}（${label}）の入力例は${PLACEHOLDER_MAX}文字以内にしてください` }
      out.placeholder = f.placeholder
    }
    const ml = f.maxLength ?? f.max_length
    if (ml !== undefined && ml !== null && ml !== '') {
      const n = Number(ml)
      if (type === 'number' || !Number.isInteger(n) || n < 1 || n > TEXT_MAX) return { error: `${at}（${label}）の文字数の上限は、テキストの項目に1〜${TEXT_MAX}で指定してください` }
      out.maxLength = n
    }
    fields.push(out)
  }
  return { fields }
}
