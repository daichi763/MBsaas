// w23-uploads-mail（#9957 resend の SDK を外し、Resend の REST API を fetch で直接呼ぶ）のテスト
//  src/services/email.ts を esbuild でまとめ、fetch を差し替えて、送る中身（宛先・件名・本文・返信先・ヘッダー・batch の分け方・冪等キー）と、
//  失敗の応答（4xx・5xx・429・通信の失敗）の扱いを確かめる。本物の Resend には送らない（fetch は差し替えたものだけを使う）。
//  待ち（バッチの間隔・再試行の待ち）は setTimeout を差し替えて、長さだけを記録する。
// 前提: なし（開発サーバーは使わない。npm test では起動されるが、このテストは使わない）
// 実行: node scripts/test-w23-email.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

// ---------- email.ts をまとめる ----------
const work = mkdtempSync(join(tmpdir(), 'w23-email-'))
const esbuild = (await import('esbuild')).default
await esbuild.build({ entryPoints: [join(ROOT, 'src/services/email.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(work, 'email.mjs'), logLevel: 'error' })
const mail = await import(pathToFileURL(join(work, 'email.mjs')).href)
rmSync(work, { recursive: true, force: true })

// ---------- 差し替え: fetch・setTimeout・D1 ----------
let calls = []
let responder = () => new Response('{}', { status: 200 })
globalThis.fetch = async (url, init = {}) => {
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  const call = { url: String(url), method: init.method, headers, body: init.body ? JSON.parse(init.body) : undefined }
  calls.push(call)
  return responder(call, calls.length)
}
const realSetTimeout = globalThis.setTimeout
let waits = []
globalThis.setTimeout = (fn, ms, ...a) => { waits.push(ms); return realSetTimeout(fn, 0, ...a) }
const logs = []
const fakeDb = {
  prepare: (sql) => {
    const st = { sql, args: [], bind: (...a) => { st.args = a; return st },
      all: async () => ({ results: [] }), first: async () => null,
      run: async () => { if (/INSERT INTO email_logs/.test(sql)) logs.push(...JSON.parse(st.args[0])); return { meta: { changes: 1 } } } }
    return st
  },
  batch: async (list) => list.map(() => ({ results: [], meta: { changes: 0 } })),
}
const env = (extra = {}) => ({ RESEND_API_KEY: 're_test_key', MAIL_FROM: 'MBsaas <noreply@example.jp>', MAIL_ENABLED: 'true', DB: fakeDb, ...extra })
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const reset = (fn) => { calls = []; waits = []; logs.length = 0; responder = fn }
// 送る JSON の中身が同じか（キーの順は問わない）
const sameObj = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort())
const input = (n, extra = {}) => ({ to: `user${n}@example.com`, subject: `件名${n}`, html: `<p>本文${n}</p>`, text: `本文${n}`, type: 'notice', company_id: 1, ...extra })

// ---------- sendEmail ----------
{
  reset(() => json({ id: 'msg_1' }))
  const r = await mail.sendEmail(env(), input(1, { reply_to: 'contact@example.co.jp' }))
  const c = calls[0]
  ok('sendEmail: POST https://api.resend.com/emails に1回送る', calls.length === 1 && c.url === 'https://api.resend.com/emails' && c.method === 'POST', calls.map(x => x.url))
  ok('sendEmail: 認証・JSON・User-Agent のヘッダーを付け、冪等キーは付けない',
    c.headers.authorization === 'Bearer re_test_key' && c.headers['content-type'] === 'application/json' && !!c.headers['user-agent'] && !('idempotency-key' in c.headers), c.headers)
  ok('sendEmail: 送信元・宛先・件名・本文（HTML・テキスト）・返信先（reply_to）を送る',
    sameObj(c.body, { from: 'MBsaas <noreply@example.jp>', to: 'user1@example.com', subject: '件名1', html: '<p>本文1</p>', text: '本文1', reply_to: 'contact@example.co.jp' }), c.body)
  ok('sendEmail: 成功なら ok と Resend の ID を返し、送信記録に sent で残す', r.ok === true && r.id === 'msg_1' && logs.length === 1 && logs[0].s === 'sent' && logs[0].id === 'msg_1', [r, logs])
}
{
  reset(() => json({ id: 'msg_2' }))
  await mail.sendEmail(env(), input(2))
  ok('sendEmail: 返信先が無ければ reply_to を送らない', calls.length === 1 && !('reply_to' in calls[0].body) && !('replyTo' in calls[0].body), calls[0]?.body)
}
{
  reset(() => json({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field: bad user9@example.com' }, 422))
  const r = await mail.sendEmail(env(), input(3))
  ok('sendEmail: 4xx（422）は「resend_error: 名前 - 内容」にし、宛先は伏せる', r.ok === false && r.error === 'resend_error: validation_error - Invalid `to` field: bad us***@example.com', r)
  ok('sendEmail: 失敗は送信記録に failed で残す（再試行しない）', calls.length === 1 && logs[0]?.s === 'failed' && logs[0]?.e === r.error, [calls.length, logs])
}
{
  reset(() => json({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }, 429))
  const r = await mail.sendEmail(env(), input(4))
  ok('sendEmail: 429 は rate_limit_exceeded として返す（1件の送信は再試行しない。今までと同じ）', r.ok === false && r.error === 'resend_error: rate_limit_exceeded - Too many requests' && calls.length === 1, [r, calls.length])
}
{
  reset(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }))
  const r = await mail.sendEmail(env(), input(5))
  ok('sendEmail: 5xx で JSON でない応答は application_error にする（SDK と同じ文言）',
    r.ok === false && r.error === 'resend_error: application_error - Internal server error. We are unable to process your request right now, please try again later.', r)
}
{
  reset(() => { throw new TypeError('fetch failed') })
  const r = await mail.sendEmail(env(), input(6))
  ok('sendEmail: 通信できないときも例外にせず application_error を返す（SDK と同じ）', r.ok === false && r.error === 'resend_error: application_error - Unable to fetch data. The request could not be resolved.', r)
}
{
  reset(() => json({ id: 'x' }))
  const r = await mail.sendEmail(env({ MAIL_ENABLED: 'false' }), input(7))
  ok('sendEmail: MAIL_ENABLED=false なら送らず、ok・skipped を返す', calls.length === 0 && r.ok === true && r.skipped === true && r.id === 'skipped-disabled' && logs[0]?.s === 'skipped', [calls.length, r])
  const r2 = await mail.sendEmail(env({ RESEND_API_KEY: '' }), input(8))
  ok('sendEmail: API キーが無ければ送らず mail_not_configured', calls.length === 0 && r2.ok === false && r2.error === 'mail_not_configured', r2)
}

// ---------- sendEmailBatch ----------
{
  // 250件（うち1件は書式の誤り）→ 正しい249件を 100・100・49 件に分けて送る
  const inputs = Array.from({ length: 250 }, (_, i) => input(i, i === 10 ? { to: 'not-an-address' } : i % 2 ? { reply_to: 'r@example.jp' } : {}))
  reset((c) => json({ data: c.body.map((m) => ({ id: 'id-' + m.to })) }))
  const r = await mail.sendEmailBatch(env(), inputs, { idempotencyKey: 'notice-77' })
  ok('batch: /emails/batch に 100・100・49 件の3回で送る', calls.length === 3 && calls.every(c => c.url === 'https://api.resend.com/emails/batch' && c.method === 'POST')
    && calls.map(c => c.body.length).join(',') === '100,100,49', calls.map(c => [c.url, c.body?.length]))
  ok('batch: 冪等キーは「キー-バッチの番号」を Idempotency-Key ヘッダーで送る', calls.map(c => c.headers['idempotency-key']).join(',') === 'notice-77-0,notice-77-1,notice-77-2', calls.map(c => c.headers['idempotency-key']))
  ok('batch: 認証のヘッダーを付ける', calls.every(c => c.headers.authorization === 'Bearer re_test_key' && c.headers['content-type'] === 'application/json'))
  const first = calls[0].body
  ok('batch: 1件ずつ送信元・宛先・件名・本文・返信先（reply_to）を入れる',
    sameObj(first[0], { from: 'MBsaas <noreply@example.jp>', to: 'user0@example.com', subject: '件名0', html: '<p>本文0</p>', text: '本文0' })
    && sameObj(first[1], { from: 'MBsaas <noreply@example.jp>', to: 'user1@example.com', subject: '件名1', html: '<p>本文1</p>', text: '本文1', reply_to: 'r@example.jp' }), first.slice(0, 2))
  ok('batch: 書式の誤ったアドレスは送らず invalid_address', !calls.some(c => c.body.some(m => m.to === 'not-an-address')) && r[10].ok === false && r[10].error === 'invalid_address', r[10])
  ok('batch: 結果は入力と同じ順で、それぞれの ID を返す', r.length === 250 && r.every((x, i) => i === 10 || (x.ok && x.id === `id-user${i}@example.com`)), r.slice(0, 3))
  ok('batch: バッチの間は 600ms 空ける', waits.filter(w => w === 600).length === 2, waits)
  ok('batch: 250件の結果を送信記録に残す', logs.length === 250 && logs.filter(l => l.s === 'sent').length === 249, logs.length)
}
{
  reset(() => json({ data: [{ id: 'a' }] }))
  await mail.sendEmailBatch(env(), [input(1)])
  ok('batch: 冪等キーを渡さなければ Idempotency-Key を付けない', calls.length === 1 && !('idempotency-key' in calls[0].headers), calls[0]?.headers)
}
{
  // 429 → 待って同じ冪等キーでやり直し、成功
  reset((c, n) => n === 1 ? json({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }, 429) : json({ data: c.body.map((_, j) => ({ id: 'ok' + j })) }))
  const r = await mail.sendEmailBatch(env(), [input(1), input(2)], { idempotencyKey: 'k' })
  ok('batch: 429（rate_limit_exceeded）は1秒待って同じ冪等キーでやり直す', calls.length === 2 && calls.every(c => c.headers['idempotency-key'] === 'k-0') && waits.includes(1000), [calls.length, waits])
  ok('batch: やり直して成功すれば ok', r.every(x => x.ok) && r[1].id === 'ok1', r)
}
{
  // 5xx（JSON でない）→ application_error として3回まで試し、だめなら失敗
  reset(() => new Response('upstream error', { status: 503 }))
  const r = await mail.sendEmailBatch(env(), [input(1)], { idempotencyKey: 'k5' })
  ok('batch: 5xx は3回まで試す（待ちは 1秒・2秒）', calls.length === 3 && waits.includes(1000) && waits.includes(2000), [calls.length, waits])
  ok('batch: 3回とも失敗なら application_error で返す', r[0].ok === false && r[0].error.startsWith('resend_error: application_error - '), r)
}
{
  reset(() => json({ statusCode: 500, name: 'internal_server_error', message: 'oops' }, 500))
  const r = await mail.sendEmailBatch(env(), [input(1)])
  ok('batch: 500（internal_server_error）も再試行の対象', calls.length === 3 && r[0].error === 'resend_error: internal_server_error - oops', [calls.length, r])
}
{
  // 4xx（宛先・送信元の不備）は再試行しない
  reset(() => json({ statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (owner@example.com).' }, 403))
  const r = await mail.sendEmailBatch(env(), [input(1), input(2)])
  ok('batch: 4xx（validation_error）は再試行せず、全員を失敗にする（宛先は伏せる）', calls.length === 1 && r.every(x => x.ok === false && x.error === 'resend_error: validation_error - You can only send testing emails to your own email address (ow***@example.com).'), [calls.length, r])
}
{
  reset(() => { throw new TypeError('fetch failed') })
  const r = await mail.sendEmailBatch(env(), [input(1)])
  ok('batch: 通信できないときは application_error として3回まで試す', calls.length === 3 && r[0].error === 'resend_error: application_error - Unable to fetch data. The request could not be resolved.', [calls.length, r])
}
{
  reset(() => json({ data: [{ id: 'only-one' }] }))
  const r = await mail.sendEmailBatch(env(), [input(1), input(2)])
  ok('batch: 応答に ID の無いものは resend_error', r[0].ok && r[0].id === 'only-one' && r[1].ok === false && r[1].error === 'resend_error', r)
}
{
  reset(() => json({ data: [] }))
  const r = await mail.sendEmailBatch(env({ MAIL_ENABLED: 'false' }), [input(1), input(2)])
  ok('batch: MAIL_ENABLED=false なら送らず、全員 ok・skipped', calls.length === 0 && r.every(x => x.ok && x.skipped), r)
}

// ---------- 依存とビルド ----------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
ok('package.json・package-lock.json に resend が無い', !pkg.dependencies?.resend && !lock.packages?.['']?.dependencies?.resend && !lock.packages?.['node_modules/resend'])
ok('src に resend の SDK の import が無い', !/from\s+['"]resend['"]/.test(readFileSync(join(ROOT, 'src/services/email.ts'), 'utf8')))
const dist = join(ROOT, 'dist/_worker.js')
if (existsSync(dist)) {
  const w = readFileSync(dist, 'utf8')
  ok('ビルドした Worker に React・prettier が入っていない', !/renderToReadableStream|htmlWhitespaceSensitivity|react\.element/.test(w), w.length)
} else console.log('SKIP  ビルドした Worker の確認（dist/_worker.js が無い）')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
