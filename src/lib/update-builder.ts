// 更新（UPDATE）の SET 句を組み立てる共通処理。
//  - 送られてきたキー（値が undefined 以外）だけを `列 = ?` で更新する。送られてこなかった列は変えない
//  - 空文字（空白だけを含む）は NULL にする。画面で空欄にして保存すれば値を消せる
//    （`COALESCE(?, 列)` だと null が「変更なし」になり、空欄にしても元の値が残ってしまうため使わない）
//  - required に挙げた列は、送られてきて空なら missing に入れる（呼び出し側で 400 にする）
// keys はコード中の固定の列名だけを渡すこと（利用者の入力を列名に使わない）。

export type UpdateParts = {
  /** `a = ?, b = ?` の形。更新する列が無ければ空文字 */
  clause: string
  values: unknown[]
  /** 更新した列名 */
  columns: string[]
  /** required のうち、空で送られてきた列 */
  missing: string[]
}

export type UpdateOptions = {
  /** 空にできない列（送られてきて空なら missing に入る。更新対象からは外す） */
  required?: readonly string[]
}

/** 空文字・空白だけの文字列を NULL にする（数値・真偽値・0 はそのまま） */
export function blankToNull(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' && v.trim() === '') return null
  return v
}

export function buildUpdate(body: Record<string, any>, keys: readonly string[], opts: UpdateOptions = {}): UpdateParts {
  const columns: string[] = []
  const values: unknown[] = []
  const missing: string[] = []
  for (const k of keys) {
    if (body[k] === undefined) continue
    const v = blankToNull(body[k])
    if (v === null && opts.required?.includes(k)) { missing.push(k); continue }
    columns.push(k)
    values.push(v)
  }
  return { clause: columns.map(k => `${k} = ?`).join(', '), values, columns, missing }
}
