// =========================================================
// 多くの行をまとめて書き込む（D1 の 1 回の実行あたりの問い合わせ数を抑える）
//
// - insertRowsStmts: 行の配列を JSON にして 1 つバインドし、INSERT ... SELECT FROM json_each(?) で 1 文あたり最大 100 行を登録する
// - updateRowsStmts: 同じく UPDATE ... FROM (json_each) で 1 文あたり最大 100 行を更新する（キーの列で突き合わせる）
// どちらも文の配列を返すので、batchInChunks（d1-chunk）でまとめて実行する。
// 表名・列名は呼び出し側のコードに書いた固定の名前だけを渡すこと（利用者の入力を渡さない）
// =========================================================
import { chunk } from './d1-chunk'

export const ROWS_PER_STATEMENT = 100

const NAME = /^[a-z_][a-z0-9_]*$/
function assertNames(names: string[]) {
  for (const n of names) if (!NAME.test(n)) throw new Error('invalid column name: ' + n)
}
// undefined は JSON にならないので null にそろえる。数値でない値（NaN など）も null にする
function pick(row: Record<string, any>, cols: string[]) {
  const o: Record<string, any> = {}
  for (const c of cols) { const v = row[c]; o[c] = v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v }
  return o
}

// returning: 登録した行の列（例: 'shift_id'）。結果の results に登録できた行だけが入る（OR IGNORE で飛ばした行は入らない）
export function insertRowsStmts(db: D1Database, table: string, cols: string[], rows: Record<string, any>[], opts: { orIgnore?: boolean; returning?: string } = {}): D1PreparedStatement[] {
  assertNames([table, ...cols, ...(opts.returning ? [opts.returning] : [])])
  const sql = `INSERT ${opts.orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${cols.join(', ')})
    SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?) ORDER BY key${opts.returning ? ` RETURNING ${opts.returning}` : ''}`
  return chunk(rows, ROWS_PER_STATEMENT).map(part => db.prepare(sql).bind(JSON.stringify(part.map(r => pick(r, cols)))))
}

// where は更新先の表の列を「表名.列名」で書く追加の条件（例: 'shifts.company_id = ?'）。binds はその値。
// where は +( ) で囲み、索引の条件に使わせない。company_id などの索引が使われると、更新先の表をその条件で全件読み、
// 1行ごとに json_each を読み直すため（行数 × 100 回）、キーの主キーで1行ずつ引く形にする
export function updateRowsStmts(db: D1Database, table: string, key: string, cols: string[], rows: Record<string, any>[], where: string, binds: any[] = []): D1PreparedStatement[] {
  assertNames([table, key, ...cols])
  const sql = `UPDATE ${table} SET ${cols.map((c, i) => `${c} = j.v${i}`).join(', ')}
    FROM (SELECT json_extract(value, '$.${key}') AS k, ${cols.map((c, i) => `json_extract(value, '$.${c}') AS v${i}`).join(', ')} FROM json_each(?)) AS j
    WHERE ${table}.${key} = j.k${where ? ` AND +(${where})` : ''}`
  return chunk(rows, ROWS_PER_STATEMENT).map(part => db.prepare(sql).bind(JSON.stringify(part.map(r => pick(r, [key, ...cols]))), ...binds))
}

// RETURNING で返った列の値をまとめる（insertRowsStmts の returning）
export function returnedIds(results: D1Result[], col: string): number[] {
  return results.flatMap(r => ((r?.results || []) as any[]).map(x => Number(x[col])).filter(n => Number.isInteger(n) && n > 0))
}

// batch の結果から変更行数の合計を返す。
// 注意: D1 の meta.changes はトリガーの中の更新も数える。shifts の日時・案件・場所・状態・担当者を変える文（0086 の trg_shifts_staff_changed_at）や
// 欠勤から戻す文（0087 の trg_shift_cancellations_clear）の件数には使わず、前後の状態から数える（9005。shift-board.ts の希望の確定を参照）
export function changesOf(results: D1Result[]): number {
  return results.reduce((n, r) => n + Number(r?.meta?.changes || 0), 0)
}
