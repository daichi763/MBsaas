// テストの共通の fetch: 書き込み（GET・HEAD 以外）に、宛先と同じ Origin を付ける（#9943）。
// サーバーは /api/* の書き込みを、送り元（Origin・Referer）が自分のサイトのときだけ通す（src/lib/csrf.ts）。
// ブラウザは Origin を必ず付けるが、Node の fetch は付けないので、セッションの Cookie を付けた書き込みが 403 になる。
// npm test（scripts/run-tests.mjs）は、各テストを node --import ./scripts/fetch-origin.mjs で起動する。
// 1本だけ手で流すときも、node --import ./scripts/fetch-origin.mjs scripts/test-xxx.mjs で流す。
// すでに Origin を付けている要求はそのまま送る。Origin を付けずに送りたいテストは globalThis.__rawFetch を使う。
const rawFetch = globalThis.fetch
if (!globalThis.__rawFetch) {
  globalThis.__rawFetch = rawFetch
  globalThis.fetch = (input, init) => {
    const req = input instanceof Request ? input : null
    const method = String(init?.method || req?.method || 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') return rawFetch(input, init)
    let url
    try { url = new URL(req ? req.url : String(input)) } catch { return rawFetch(input, init) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return rawFetch(input, init)
    const headers = new Headers(init?.headers ?? req?.headers)
    if (headers.has('Origin')) return rawFetch(input, init)
    headers.set('Origin', url.origin)
    return rawFetch(input, { ...init, headers })
  }
}
