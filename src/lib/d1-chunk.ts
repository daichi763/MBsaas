// =========================================================
// D1 のバインド上限（1文 100 個）を避けるための共通処理
//
// - 件数が増える ID の一覧は、原則として json_each で 1 つのバインドにまとめる:
//     `WHERE x.id IN ${JSON_IN}` + bind(bindJsonArray(ids))
// - 1 文に並べる必要がある場合（INSERT の VALUES など）は inChunks で 90 件ずつに分ける
// - db.batch に渡す文が多いときは batchInChunks で分けて実行する
// =========================================================

export const D1_MAX_BINDS = 100
export const CHUNK_SIZE = 90

// `IN ${JSON_IN}` と書き、bindJsonArray(ids) を 1 つバインドする
export const JSON_IN = '(SELECT value FROM json_each(?))'

// 正の整数だけを重複なしで JSON 配列の文字列にする（数値として渡し、列の型と比較できるようにする）
export function bindJsonArray(ids: Iterable<any>): string {
  const out = new Set<number>()
  for (const v of ids) { const n = Number(v); if (Number.isInteger(n) && n > 0) out.add(n) }
  return JSON.stringify([...out])
}

export function chunk<T>(arr: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ids を size 件ずつに分けて fn を順に呼び、結果の配列をつなげて返す
export async function inChunks<T, R>(ids: T[], size: number, fn: (part: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = []
  for (const part of chunk(ids, Math.max(1, Math.min(size || CHUNK_SIZE, CHUNK_SIZE)))) out.push(...await fn(part))
  return out
}

// `?, ?, ?` を返す（inChunks の中で使う）
export const placeholders = (n: number) => Array(n).fill('?').join(',')

// db.batch を size 文ずつに分けて実行する
export async function batchInChunks(db: D1Database, stmts: D1PreparedStatement[], size = 50) {
  const out: D1Result[] = []
  for (const part of chunk(stmts, size)) if (part.length) out.push(...await db.batch(part))
  return out
}
