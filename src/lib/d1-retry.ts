// =========================================================
// D1 の過負荷のときの短いやり直しと、打刻の API のテスト用の仕掛け（#9939）
//   D1 は混雑すると「D1 DB is overloaded. Too many resources consumed within a 10 second window」で失敗する。
//   一時的なものなので、打刻の読み書きは、このエラーのときだけその場で短く（200ms・500ms の2回まで）やり直す。
//   ほかのエラー（制約違反など）はやり直さない。
// =========================================================

const OVERLOAD_RE = /D1 DB is overloaded|Too many resources consumed/i
export function isD1Overloaded(e: any): boolean {
  return OVERLOAD_RE.test(String((e && (e.message || e.cause?.message)) || e || ''))
}
export const D1_RETRY_DELAYS_MS = [200, 500]

// fn を実行し、D1 の過負荷のときだけ D1_RETRY_DELAYS_MS の間をあけてやり直す。
// inject はテスト用（呼ぶたびに true を返す間は、過負荷のエラーをまねる）
export async function withD1Retry<T>(fn: () => Promise<T>, inject?: () => boolean): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      if (inject && inject()) throw new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window (test)')
      return await fn()
    } catch (e) {
      if (!isD1Overloaded(e) || i >= D1_RETRY_DELAYS_MS.length) throw e
      await new Promise(r => setTimeout(r, D1_RETRY_DELAYS_MS[i]))
    }
  }
}

// ---------- テスト用の仕掛け（環境変数 TEST_HOOKS='true' のときだけ。本番の設定には入れない） ----------
// ローカルの wrangler dev に --var TEST_HOOKS:true を付けて起動したときだけ働く:
//   ・応答のヘッダー X-Test-D1-Calls に、その要求で D1 を呼んだ回数（往復）と文の数を「回数/文の数」で返す
//   ・要求のヘッダー X-Test-D1-Overload: n で、打刻の書き込みの最初の n 回を過負荷のエラーにする（やり直しの確認）
export function testHooksOn(env: any): boolean {
  return !!env && env.TEST_HOOKS === 'true'
}
type Stats = { calls: number; statements: number }
function countingDb(db: D1Database, stats: Stats): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>()
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s as any, {
      get(t, k) {
        if (k === 'bind') return (...a: any[]) => wrap(t.bind(...a))
        if (k === 'first' || k === 'all' || k === 'run' || k === 'raw') return (...a: any[]) => { stats.calls++; stats.statements++; return t[k](...a) }
        const v = Reflect.get(t, k, t)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    real.set(p, s)
    return p as D1PreparedStatement
  }
  return new Proxy(db as any, {
    get(t, k) {
      if (k === 'prepare') return (q: string) => wrap(t.prepare(q))
      if (k === 'batch') return (list: D1PreparedStatement[]) => { stats.calls++; stats.statements += list.length; return t.batch(list.map(x => real.get(x as any) || x)) }
      const v = Reflect.get(t, k, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  }) as D1Database
}
// D1 の呼び出しを数える形にした DB（定期処理で、1回の起動の問い合わせの数を予算の内に収めるのに使う。#9968）。
// stats.statements は実行した文の数（db.batch の中の文も1つずつ数える）
export function countD1(db: D1Database): { db: D1Database; stats: Stats } {
  const stats: Stats = { calls: 0, statements: 0 }
  return { db: countingDb(db, stats), stats }
}
// 回数だけを数えるミドルウェア（割り当て・応募の承認など、人数で問い合わせが増えないことをテストで確かめる API の前に置く。#9968）
export async function d1CallCountHook(c: any, next: () => Promise<void>) {
  if (!testHooksOn(c.env)) return next()
  const stats: Stats = { calls: 0, statements: 0 }
  c.env = { ...c.env, DB: countingDb(c.env.DB, stats) }
  await next()
  try { c.res.headers.set('X-Test-D1-Calls', `${stats.calls}/${stats.statements}`) } catch { /* 応答のヘッダーを変えられないときは付けない */ }
}
// 打刻の API の前に置くミドルウェア。TEST_HOOKS のときだけ、この要求の DB を数える形に差し替える
export async function attendanceTestHooks(c: any, next: () => Promise<void>) {
  if (!testHooksOn(c.env)) return next()
  const stats: Stats = { calls: 0, statements: 0 }
  c.env = { ...c.env, DB: countingDb(c.env.DB, stats) }
  let fail = Math.max(0, Number(c.req.header('X-Test-D1-Overload') || 0) || 0)
  c.set('d1FailWrite', () => fail-- > 0)
  await next()
  try { c.res.headers.set('X-Test-D1-Calls', `${stats.calls}/${stats.statements}`) } catch { /* 応答のヘッダーを変えられないときは付けない */ }
}

// ---------- 読み書きの行数を数える仕掛け（TEST_HOOKS='true' のローカルだけ。#9970） ----------
// 応答のヘッダー X-Test-D1-Rows に、その要求で D1 が返した meta.rows_read・rows_written の合計を「読み取り/書き込み」で返す
// （性能の直しの前後を、ローカルの D1 の値で比べる。応答の後に waitUntil で動く処理の分は入らない）
type RowStats = { read: number; written: number }
function rowCountingDb(db: D1Database, stats: RowStats): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>()
  const add = (r: any) => { const m = r && r.meta; if (m) { stats.read += Number(m.rows_read) || 0; stats.written += Number(m.rows_written) || 0 } return r }
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s as any, {
      get(t, k) {
        if (k === 'bind') return (...a: any[]) => wrap(t.bind(...a))
        if (k === 'all' || k === 'run') return (...a: any[]) => t[k](...a).then(add)
        // first() は meta を返さないので、all() で読んで先頭の行（列の名前があればその値）を返す
        if (k === 'first') return (col?: string) => t.all().then(add).then((r: any) => { const row = (r.results || [])[0]; return row === undefined ? null : col ? (row[col] ?? null) : row })
        const v = Reflect.get(t, k, t)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    real.set(p, s)
    return p as D1PreparedStatement
  }
  return new Proxy(db as any, {
    get(t, k) {
      if (k === 'prepare') return (q: string) => wrap(t.prepare(q))
      if (k === 'batch') return (list: D1PreparedStatement[]) => t.batch(list.map(x => real.get(x as any) || x)).then((rs: any[]) => { rs.forEach(add); return rs })
      const v = Reflect.get(t, k, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  }) as D1Database
}
export async function d1RowsHook(c: any, next: () => Promise<void>) {
  if (!testHooksOn(c.env)) return next()
  const stats: RowStats = { read: 0, written: 0 }
  c.env = { ...c.env, DB: rowCountingDb(c.env.DB, stats) }
  await next()
  try { c.res.headers.set('X-Test-D1-Rows', `${stats.read}/${stats.written}`) } catch { /* 応答のヘッダーを変えられないときは付けない */ }
}
