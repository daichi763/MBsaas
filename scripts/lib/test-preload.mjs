// テストの共通の下準備（Sprint 26 #9980）。npm test は各テストを
//   node --import ./scripts/fetch-origin.mjs --import ./scripts/lib/test-preload.mjs scripts/test-xxx.mjs で起動する。
// 機械が混んでいるときに、アプリと関係なくテストが止まるのを防ぐ（テストの中身・アプリのコードは変えない）:
//   1) fetch: 開発サーバーが閉じた接続を使い回したときの ECONNRESET・ECONNABORTED などは、要求がサーバーに届いていないので、少し待って送り直す（2回まで）
//   2) wrangler d1 execute（テストが DB を直接読み書きする所）: 開発サーバーと同じファイルを同時に開いたときの
//      「internal error」・database is locked・EBUSY・EPERM は、少し待ってやり直す（3回まで。1回の実行は1つのトランザクションなので、失敗した回は何も書いていない）
// 環境変数 TEST_RETRY=0 でやり直しをやめる（原因を調べるとき）。
import { createRequire, syncBuiltinESMExports } from 'node:module'

const OFF = process.env.TEST_RETRY === '0'
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const note = (msg) => { if (process.env.TEST_RETRY_LOG !== '0') console.log(`（再試行）${msg}`) }

// ---- 1) fetch ----
const RETRY_NET = new Set(['ECONNRESET', 'ECONNABORTED', 'UND_ERR_SOCKET', 'EPIPE'])  // ECONNREFUSED（まだ起動していない・止まった）はやり直さない
function withNetRetry(f) {
  return async (input, init) => {
    for (let n = 0; ; n++) {
      try { return await f(input, init) } catch (e) {
        const code = e?.cause?.code || e?.code
        const streamBody = init?.body && typeof init.body === 'object' && typeof init.body.getReader === 'function'
        if (OFF || n >= 2 || !RETRY_NET.has(code) || streamBody) throw e
        note(`${code}: ${String(input instanceof Request ? input.url : input).slice(0, 120)}（${n + 1} 回目）`)
        await new Promise(r => setTimeout(r, 500 * (n + 1) * (n + 1)))
      }
    }
  }
}
if (!globalThis.__netRetry) {
  globalThis.__netRetry = true
  globalThis.fetch = withNetRetry(globalThis.fetch)
  if (globalThis.__rawFetch) globalThis.__rawFetch = withNetRetry(globalThis.__rawFetch)
}

// ---- 2) wrangler d1 execute ----
const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const BUSY = /internal error|database is locked|SQLITE_BUSY|EBUSY|EPERM/i
const isD1Exec = (s) => /\bd1\b/.test(s) && /\bexecute\b/.test(s) && /--local\b/.test(s)
function withD1Retry(orig, describe) {
  return function (...args) {
    const line = describe(args)
    if (OFF || !isD1Exec(line)) return orig.apply(this, args)
    for (let n = 0; ; n++) {
      try { return orig.apply(this, args) } catch (e) {
        const text = [e?.message, e?.stdout, e?.stderr].map(x => x == null ? '' : String(x)).join('\n')
        if (n >= 3 || !BUSY.test(text)) throw e
        note(`wrangler d1 execute: ${(text.match(BUSY) || [''])[0]}（${n + 1} 回目）`)
        sleepSync(1000 * 2 ** n)
      }
    }
  }
}
if (!cp.__d1Retry) {
  cp.__d1Retry = true
  cp.execFileSync = withD1Retry(cp.execFileSync, ([file, args]) => [file, ...(Array.isArray(args) ? args : [])].join(' '))
  cp.execSync = withD1Retry(cp.execSync, ([command]) => String(command))
  syncBuiltinESMExports()   // import { execFileSync } from 'child_process' にも反映する
}
