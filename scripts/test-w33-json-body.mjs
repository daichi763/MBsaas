// 本文が null などのとき 500 にしない（Sprint 33 #10000 セキュリティの点検 M4。作業単位 w33-sec-auth）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --port 9021 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:9021 node --import ./scripts/fetch-origin.mjs scripts/test-w33-json-body.mjs
//   本番には接続しない。テストのたびに DB を作り直すこと（npm test -- w33-json-body なら自動で行う）。
// 確かめること:
//   (1) /api/auth/login と代表的な書き込み（打刻・日報・設定・掲示板）に null・123・"abc"・true・[]・壊れた JSON を送ると 400（invalid_body）で、
//       障害の記録（error_logs）・警報に入らない
//   (2) ふつうの送信は通る（最初の c.req.json() に読んだ本文が渡る）。空の本文は今までどおり各ハンドラの応答
//   (3) アップロード（multipart）・Webhook（/webhooks/resend）は影響を受けない。Content-Type を multipart に偽った null でも 500 にしない
//   (4) 本文の無い DELETE・GET は今までどおり
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

async function call(method, path, { cookie, raw, body, type = 'application/json' } = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(type ? { 'Content-Type': type } : {}) }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let data = null; try { data = JSON.parse(text) } catch { }
  return { status: r.status, data, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function session(company_code, user_code) {
  const r = await call('POST', '/api/auth/login', { body: { company_code, user_code, password: 'pass1234' } })
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${r.text.slice(0, 200)}`)
  return r.cookie
}
const hq = await session('', 'hq')
const admin = await session('sample', 'admin')
const staff = await session('sample', 'st001')
const errTotal = async () => Number((await call('GET', '/api/hq/errors', { cookie: hq })).data?.totals?.last_24h) || 0

// ---------- (1) オブジェクトでない本文は 400 ----------
{
  const before = await errTotal()
  const BODIES = ['null', '123', '"abc"', 'true', '[]', '[{"company_code":"sample"}]', '{"company_code": "sample",', '{broken']
  const TARGETS = [
    ['POST', '/api/auth/login', null],
    ['POST', '/api/auth/login/mfa', null],
    ['POST', '/api/auth/forgot-password', null],
    ['POST', '/api/staff/attendance', staff],
    ['POST', '/api/staff/daily-report', staff],
    ['PUT', '/api/admin/settings/reminders', admin],
    ['POST', '/api/admin/board/posts', admin],
    ['PUT', '/api/admin/staff/1', admin],
  ]
  const bad = []
  for (const [m, p, cookie] of TARGETS) {
    for (const raw of BODIES) {
      const r = await call(m, p, { cookie, raw })
      if (!(r.status === 400 && r.data?.code === 'invalid_body' && /^送信の内容が正しくありません/.test(r.data?.error || ''))) bad.push([m, p, raw, r.status, r.text.slice(0, 120)])
    }
  }
  ok(`#10000 ${TARGETS.length} 個の書き込みに null・数・文字列・true・配列・壊れた JSON を送ると、どれも 400（invalid_body「送信の内容が正しくありません」）`, !bad.length, bad.slice(0, 6))
  const textPlain = await call('POST', '/api/auth/login', { raw: 'null', type: 'text/plain' })
  const noType = await call('POST', '/api/auth/login', { raw: '123', type: null })
  ok('#10000 Content-Type が text/plain・無しでも同じ（ブラウザの外からの送信）', textPlain.status === 400 && textPlain.data?.code === 'invalid_body' && noType.status === 400 && noType.data?.code === 'invalid_body', [textPlain, noType])
  await sleep(2000)
  const after = await errTotal()
  ok('#10000 これらは障害の記録（error_logs）・警報の件数に入らない', after === before, { before, after })
}

// ---------- (2) ふつうの送信・空の本文 ----------
{
  const good = await call('POST', '/api/auth/login', { body: { company_code: 'sample', user_code: 'st002', password: 'pass1234' } })
  ok('#10000 ふつうのログインは通る（読んだ本文がハンドラに渡る）', good.status === 200 && good.data?.ok === true && good.data?.user_code === 'st002', good.status)
  const wrong = await call('POST', '/api/auth/login', { body: { company_code: 'sample', user_code: 'st002', password: 'nope' } })
  ok('#10000 パスワードの誤りは今までどおり 401', wrong.status === 401, wrong.status)
  const empty = await call('POST', '/api/auth/login', { raw: '' })
  const spaces = await call('POST', '/api/auth/login', { raw: '  \n' })
  ok('#10000 空の本文は今までどおり各ハンドラの応答（ログインは「入力内容が不足しています」）', empty.status === 400 && /入力内容が不足しています/.test(empty.data?.error || '') && spaces.status === 400 && spaces.data?.code !== 'invalid_body', [empty, spaces])
  const brd = await call('POST', '/api/admin/board/posts', { cookie: admin, body: {} })
  ok('#10000 オブジェクトの本文は入力の確認に進む（掲示板は項目の誤りの 400。invalid_body ではない）', brd.status === 400 && brd.data?.code !== 'invalid_body', brd)
  const rem = await call('GET', '/api/admin/settings/reminders', { cookie: admin })
  const put = await call('PUT', '/api/admin/settings/reminders', { cookie: admin, body: rem.data?.settings ?? rem.data ?? {} })
  ok('#10000 設定の保存（今の値をそのまま送る）は今までどおり', rem.status === 200 && put.status !== 500 && put.data?.code !== 'invalid_body', [rem.status, put.status, put.text.slice(0, 200)])
  const unicode = await call('POST', '/api/auth/login', { raw: JSON.stringify({ company_code: 'ｓａｍｐｌｅ', user_code: 'ｓｔ００３', password: 'pass1234' }) })
  ok('#10000 全角の会社コード・ID（日本語の本文）も今までどおり読める', unicode.status === 200, unicode.status)
}

// ---------- (3) アップロード・Webhook ----------
{
  const fd = new FormData()
  fd.append('doc_type', 'other')
  fd.append('files', new Blob([Buffer.from('%PDF-1.4\n%w33\n')], { type: 'application/pdf' }), 'w33.pdf')
  const up = await fetch(`${BASE}/api/staff/self/documents`, { method: 'POST', headers: { Cookie: staff }, body: fd })
  const upText = await up.text()
  ok('#10000 アップロード（multipart）は本文を読まずにハンドラへ（invalid_body にしない・500 にしない）', up.status !== 500 && !/invalid_body/.test(upText), [up.status, upText.slice(0, 200)])
  const fake = await call('POST', '/api/auth/login', { raw: 'null', type: 'multipart/form-data; boundary=w33' })
  ok('#10000 Content-Type を multipart に偽った null でも 500 にしない（ハンドラの既定値で 400）', fake.status === 400 && /入力内容が不足しています/.test(fake.data?.error || ''), fake)
  const fake2 = await call('POST', '/api/admin/board/posts', { cookie: admin, raw: '[1]', type: 'multipart/form-data; boundary=w33' })
  ok('#10000 multipart に偽った配列も 500 にしない', fake2.status === 400, fake2)
  const wh = await call('POST', '/webhooks/resend', { raw: 'null' })
  ok('#10000 Webhook（/webhooks/resend）は対象外（署名の確認のまま。invalid_body にしない）', wh.status !== 500 && wh.data?.code !== 'invalid_body', [wh.status, wh.text.slice(0, 120)])
}

// ---------- (4) 本文の無い DELETE・GET ----------
{
  const del = await call('DELETE', '/api/admin/dashboard/todos', { cookie: admin, type: null })
  ok('#10000 本文の無い DELETE は今までどおり（invalid_body にしない）', del.status !== 500 && del.data?.code !== 'invalid_body', [del.status, del.text.slice(0, 120)])
  const me = await call('GET', '/api/auth/me', { cookie: staff })
  ok('#10000 GET は対象外', me.status === 200, me.status)
  const logout = await call('POST', '/api/auth/logout', { cookie: staff, type: null })
  ok('#10000 本文の無い POST（ログアウト）は今までどおり', logout.status === 200, logout.status)
}

// ---------- ソース ----------
{
  const idx = read('src/index.tsx')
  const iCsrf = idx.indexOf("app.use('/api/*', csrfGuard)"), iBody = idx.indexOf("app.use('/api/*', jsonBodyGuard)"), iRoute = idx.indexOf("app.route('/api', api)")
  ok('#10000 本文の確認は CSRF の確認の後・API の前', iCsrf > 0 && iBody > iCsrf && iRoute > iBody)
  const g = read('src/lib/json-body.ts')
  ok('#10000 配列を受け取る API は無い（足すときは JSON_ARRAY_BODY_PATHS）・multipart は読まない', /export const JSON_ARRAY_BODY_PATHS: RegExp\[\] = \[\]/.test(g) && /multipart\/form-data/.test(g))
}

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} 件が成功しました`)
process.exit(failed ? 1 : 0)
