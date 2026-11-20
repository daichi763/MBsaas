// ログインの失敗で D1 の書き込みの枠を使い切られないようにする（Sprint 33 #10001 セキュリティの点検 H2。作業単位 w33-sec-auth）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に、下の run-tests の行の --var を付けて
//   npx wrangler dev --local --test-scheduled --port 9021 --persist-to <保存先> で起動していること
//   （全体の上限はテストのときだけ小さくする: ログインの失敗 1分6回・1日9回・その後1分1回、ログインなしの送信 1分3回。
//    使った量の問い合わせ先は、このテストが 127.0.0.1:9033 に立てる受け口。本物の Cloudflare には問い合わせない）。
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w33-login-flood.mjs
//   PERSIST が無いと、D1 の行数を数える確かめは省く（wrangler d1 execute は --local のみ）。本番には接続しない。
// run-tests: --var TEST_HOOKS:true --var LOGIN_WRITE_BUDGET:6/9/1 --var PUBLIC_WRITE_BUDGET:3/50/1 --var CF_ANALYTICS_TOKEN:w33-test-token --var CF_ACCOUNT_ID:w33acct --var CF_ANALYTICS_ENDPOINT:http://127.0.0.1:9033/graphql --test-scheduled
// 確かめること:
//   (1) 締め出し中の失敗は 429 で、login_events・login_attempts・全体の回数の行が増えない（正しいパスワードでも同じ）
//   (2) 同じ接続元から1分に何回失敗しても login_events は1行で、repeat_count が増える。管理画面のログインの履歴・失敗が続いている ID・操作の記録にも回数が出る
//   (3) 全体の上限（1分）を超えたら、書かずに 429（code: write_budget）。上限に届いたとき本部に1回だけ知らせる。1日の目安を超えたら1分1回まで
//   (4) ログインなしの送信（パスワードの再設定の依頼）にも全体の上限が効く
//   (5) 成功のログインは今までどおり1件1行（repeat_count 1・まとめない）・操作の記録に出る・使い回しの疑いの集計が動く
//   (6) workers.dev の URL でのログイン・ログインなしの送信は 403（use_app_host）、app.mobital.jp では通る。Webhook・ログアウト・GET・検証環境は通る
//       （src/index.tsx をそのまま esbuild でまとめ、本番のホストの URL で呼ぶ。D1 は差し替え）
//   (7) 使った量の通知: トークンが無ければ何もしない・50%／80% を超えたら本部に1回だけ・同じ日に同じ線は知らせ直さない
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawFetch = globalThis.fetch
// 書き込みの上限（auth_write_counters）と使った量の問い合わせは、サーバーが UTC の日付で数える。ここだけは日本時間の「今日」ではなく UTC の日付を使う（#9641 の例外）
const utcDayNow = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
const GQL_PORT = 9033
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const SQL_DIR = mkdtempSync(join(tmpdir(), 'w33flood-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const j = JSON.parse(out)
      return j[j.length - 1].results
    } catch (e) { if (i >= 3) throw e }
  }
}
async function waitServer() {
  for (let i = 0; i < 40; i++) { try { const r = await rawFetch(`${BASE}/api/health`); if (r.status < 500) return } catch { } await sleep(500) }
}
const q1 = async (command) => { const r = sql(command); await waitServer(); return r }
const count = async (where) => Number((await q1(`SELECT ${where} AS n`))[0]?.n) || 0

// 1分の窓の中で終わるように、UTC の分が変わった直後まで待つ（残りが need 秒より少なければ次の分へ）
async function freshMinute(need = 30) {
  const s = new Date().getUTCSeconds() + new Date().getUTCMilliseconds() / 1000
  if (s > 60 - need) await sleep((60.5 - s) * 1000)
}
async function call(method, path, { body, cookie, ip, raw } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let data = null; try { data = JSON.parse(text) } catch { }
  return { status: r.status, data, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
const login = (company_code, user_code, password, ip) => call('POST', '/api/auth/login', { body: { company_code, user_code, password }, ip })
async function session(company_code, user_code) {
  const r = await login(company_code, user_code, 'pass1234')
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${r.text.slice(0, 200)}`)
  return r.cookie
}

// ---------- 0. ソース・設定 ----------
{
  const mig = read('migrations/0118_login_event_counts.sql')
  ok('0118: login_events に repeat_count・bucket_key（まとめる行だけの一意の索引）、全体の回数の表を足すだけ（DROP・UPDATE・DELETE がない）',
    /ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1/.test(mig) && /CREATE UNIQUE INDEX IF NOT EXISTS idx_login_events_bucket ON login_events\(bucket_key\) WHERE bucket_key IS NOT NULL/.test(mig)
      && /CREATE TABLE IF NOT EXISTS auth_write_counters/.test(mig) && !/\b(DROP|UPDATE|DELETE)\b/i.test(mig.replace(/^--.*$/gm, '')))
  const wr = read('wrangler.jsonc')
  ok('wrangler.jsonc の triggers は変えていない（3つの式のまま）', (wr.match(/"crons": \["0 18 \* \* \*", "30 18 \* \* \*", "\*\/15 \* \* \* \*"\]/g) || []).length === 2)
  const ls = read('src/lib/login-security.ts')
  ok('本番の上限の値はコードで決める（テストの vars は TEST_HOOKS のときだけ）', /login: \{ minute: 60, day: 1500, degraded: 1 \}/.test(ls) && /public: \{ minute: 60, day: 1000, degraded: 1 \}/.test(ls) && /env\?\.TEST_HOOKS === 'true'/.test(ls))
  const api = read('src/api.ts')
  const loginSrc = api.slice(api.indexOf("api.post('/auth/login', async"), api.indexOf("api.post('/auth/forgot-password'"))
  ok('締め出しの応答（lockedResponse）・二段階認証の締め出しは何も書かない', /const lockedResponse = \(\) => c\.json\(/.test(loginSrc) && !/logEvent\('locked'|logFailure\('locked'/.test(loginSrc))
  const docs = read('docs/monitoring.md')
  ok('資料: トークンの作り方と wrangler secret put の手順（Account Analytics の読み取りだけ）', /## 12\./.test(docs) && /Account Analytics/.test(docs) && /npx wrangler secret put CF_ANALYTICS_TOKEN --env production/.test(docs) && /npx wrangler secret put CF_ACCOUNT_ID --env production/.test(docs))
}

// ---------- 6. workers.dev の URL（src/index.tsx を esbuild で。D1 は差し替え） ----------
{
  const esbuild = (await import('esbuild')).default
  const work = mkdtempSync(join(tmpdir(), 'w33-host-'))
  const bundle = async (entry, name, extra = {}) => {
    const out = join(work, name)
    await esbuild.build({ entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error', external: ['node:*'], ...extra })
    return import(pathToFileURL(out).href)
  }
  const APP = 'https://app.mobital.jp', WD = 'https://mbsaas.saas-2a2.workers.dev', STG = 'https://mbsaas-stg.n0101r2000.workers.dev'
  const { appHostOnlyBlock: b } = await bundle('src/lib/host-redirect.ts', 'host.mjs')
  const env = { APP_BASE_URL: APP }
  const blocked = ['/api/auth/login', '/api/auth/login/mfa', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/verify-email', '/api/auth/change-password',
    '/api/public/recruit/tok/apply', '/api/public/report/abc/attendance', '/api/public/notice-ack'].filter(p => b('POST', WD + p, env) !== APP)
  ok('判定: 本番の workers.dev への /api/auth/*・/api/public/* の書き込みは断る（案内は app.mobital.jp）', !blocked.length, blocked)
  const pass = [['POST', '/api/auth/logout'], ['GET', '/api/auth/me'], ['GET', '/api/public/recruit/tok'], ['POST', '/webhooks/resend'], ['POST', '/api/staff/attendance'],
    ['PUT', '/api/admin/settings/reminders'], ['OPTIONS', '/api/auth/login'], ['HEAD', '/api/auth/login']].filter(([m, p]) => b(m, WD + p, env) !== null)
  ok('判定: ログアウト・GET・Webhook・ログインした人の書き込みは workers.dev でも通す', !pass.length, pass)
  ok('判定: app.mobital.jp・ローカル・検証環境（APP_BASE_URL が自分の workers.dev）・APP_BASE_URL が http のときは断らない',
    b('POST', `${APP}/api/auth/login`, env) === null && b('POST', 'http://127.0.0.1:9021/api/auth/login', env) === null
      && b('POST', `${STG}/api/auth/login`, { APP_BASE_URL: STG }) === null && b('POST', `${WD}/api/auth/login`, { APP_BASE_URL: 'http://localhost:8787' }) === null && b('POST', `${WD}/api/auth/login`, {}) === null)

  const stmt = { bind() { return stmt }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }), raw: async () => [] }
  const fakeDb = { prepare: () => stmt, batch: async (a) => a.map(() => ({ results: [], meta: { changes: 0 } })), exec: async () => ({}) }
  const worker = (await bundle('src/index.tsx', 'index.mjs', { define: { __APP_VERSION__: '"w33test"' } })).default
  const ctx = { waitUntil() { }, passThroughOnException() { } }
  const req = (host, method, path, body, e = env) => worker.fetch(new Request(host + path, { method, headers: { 'Content-Type': 'application/json', Origin: host }, body, redirect: 'manual' }), { ...e, DB: fakeDb, MAIL_ENABLED: 'false' }, ctx)
  const loginBody = JSON.stringify({ company_code: 'sample', user_code: 'st001', password: 'wrong' })
  const wd = await req(WD, 'POST', '/api/auth/login', loginBody)
  const wdj = await wd.clone().json().catch(() => ({}))
  ok('本番のホスト: workers.dev のログインは 403（use_app_host・app.mobital.jp への案内）', wd.status === 403 && wdj.code === 'use_app_host' && wdj.url === APP && /app\.mobital\.jp/.test(wdj.error || ''), [wd.status, wdj])
  // パスを %xx で書いても（Hono はほどいてからルートに振り分ける）すり抜けない（RV で追加）
  const enc = []
  for (const p of ['/api/%61uth/login', '/api/auth/%6Cogin', '/api/%70ublic/recruit/abcdefghijklmnop/apply']) {
    const r = await req(WD, 'POST', p, p.includes('recruit') ? '{}' : loginBody)
    if (r.status !== 403 || (await r.json().catch(() => ({}))).code !== 'use_app_host') enc.push([p, r.status])
  }
  ok('本番のホスト: workers.dev で %xx で書いたパス（/api/%61uth/login など）も 403', !enc.length && b('POST', WD + '/api/%61uth/login', env) === APP, enc)
  ok('画面: パスワードの再設定の依頼が混雑（write_budget）・別のアドレス（use_app_host）で断られたら「送信しました」と出さない（RV で追加）',
    /d\.code === 'write_budget' \|\| d\.code === 'use_app_host'/.test(read('src/index.tsx')))
  const app = await req(APP, 'POST', '/api/auth/login', loginBody)
  ok('本番のホスト: app.mobital.jp のログインは通る（照合まで進んで 401）', app.status === 401, app.status)
  const pub = await req(WD, 'POST', '/api/public/recruit/abcdefghijklmnop/apply', '{}')
  ok('本番のホスト: workers.dev の応募（/api/public/*）も 403', pub.status === 403 && (await pub.json()).code === 'use_app_host', pub.status)
  const wh = await req(WD, 'POST', '/webhooks/resend', '{}')
  ok('本番のホスト: workers.dev の Resend の Webhook は今までどおり（use_app_host にしない）', wh.status !== 403 && wh.status !== 301, wh.status)
  const lo = await req(WD, 'POST', '/api/auth/logout', '')
  ok('本番のホスト: workers.dev のログアウトは通る', lo.status === 200, lo.status)
  const stg = await req(STG, 'POST', '/api/auth/login', loginBody, { APP_BASE_URL: STG })
  ok('検証環境（APP_BASE_URL が自分の workers.dev）ではログインを断らない', stg.status === 401, stg.status)
}

// ---------- 7a. 使った量（単体: src/services/monitor.ts を esbuild で） ----------
{
  const esbuild = (await import('esbuild')).default
  const work = mkdtempSync(join(tmpdir(), 'w33-usage-'))
  const out = join(work, 'monitor.mjs')
  await esbuild.build({ entryPoints: [join(ROOT, 'src/services/monitor.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error', external: ['node:*'] })
  const m = await import(pathToFileURL(out).href)
  let fetched = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...a) => { fetched++; return realFetch(...a) }
  const none = await m.runUsageWatch({ DB: null })
  const noAcct = await m.runUsageWatch({ DB: null, CF_ANALYTICS_TOKEN: 'x' })
  globalThis.fetch = realFetch
  ok('使った量: トークン・アカウント ID が無ければ何もしない（問い合わせもしない）', none.skipped === 'no_token' && noAcct.skipped === 'no_token' && fetched === 0, { none, noAcct, fetched })
  const quarter = await m.runUsageWatch({ DB: null, CF_ANALYTICS_TOKEN: 'x', CF_ACCOUNT_ID: 'y' }, Date.UTC(2026, 10, 20, 3, 20))
  ok('使った量: 問い合わせは毎時 0〜14 分の起動だけ（ほかは何もしない）', quarter.skipped === 'not_this_quarter', quarter)
  const lv = m.usageLevels({ d1_rows_written: 49_999, d1_rows_read: 2_500_000, workers_requests: 80_000 })
  ok('使った量: 線は 50%・80%（届かなければ null）。上限は無料プランの1日の値', lv.find(x => x.metric === 'd1_rows_written').line === null && lv.find(x => x.metric === 'd1_rows_read').line === 50
    && lv.find(x => x.metric === 'workers_requests').line === 80 && m.FREE_DAILY_LIMITS.d1_rows_written === 100000 && m.FREE_DAILY_LIMITS.d1_rows_read === 5000000 && m.FREE_DAILY_LIMITS.workers_requests === 100000, lv)
}

// ---------- ここから開発サーバー ----------
const hq = await session('', 'hq')
const admin = await session('sample', 'admin')
const UNIQ = Date.now().toString(36)

if (!PERSIST) {
  skip('(1)〜(5)(7) D1 の行数を数える確かめ', 'PERSIST 未指定')
} else {
  const resetBudget = () => q1('DELETE FROM auth_write_counters;')
  const rowsFor = async (ip) => ({
    events: await count(`(SELECT COUNT(*) FROM login_events WHERE ip = '${ip}')`),
    attempts: await count('(SELECT COUNT(*) FROM login_attempts)'),
    budget: await count(`(SELECT COALESCE(SUM(minute_count), 0) FROM auth_write_counters WHERE scope = 'login')`),
  })

  // ---------- (2) 1分に同じ接続元から何回失敗しても1行 ----------
  {
    await resetBudget()
    const IP = '198.51.100.21'
    const before = await rowsFor(IP)
    await freshMinute(30)
    const r = []
    for (let i = 0; i < 3; i++) r.push(await login('sample', 'st005', `wrong-${UNIQ}-${i}`, IP))
    ok('（前提）パスワードの誤りは 401', r.every(x => x.status === 401), r.map(x => x.status))
    const rows = await q1(`SELECT result, repeat_count, bucket_key, user_code FROM login_events WHERE ip = '${IP}'`)
    ok('#10001 同じ接続元から1分に3回失敗しても login_events は1行で、repeat_count が 3', rows.length === 1 && rows[0].repeat_count === 3 && rows[0].result === 'bad_password' && /^198\.51\.100\.21\|login\|bad_password\|1\|\d+\|\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(rows[0].bucket_key || ''), rows)
    const after = await rowsFor(IP)
    ok('#10001 失敗の回数（login_attempts）は今までどおり1回ごと（ID と接続元で2行ずつ）・全体の回数も3', after.attempts - before.attempts === 6 && after.budget === 3, { before, after })
    const other = await login('sample', 'st005', `wrong-${UNIQ}-x`, '198.51.100.22')
    const rows2 = await q1(`SELECT COUNT(*) AS n FROM login_events WHERE ip IN ('198.51.100.21', '198.51.100.22')`)
    ok('#10001 接続元が違えば別の行', other.status === 401 && rows2[0].n === 2, rows2)
    const hist = await call('GET', '/api/admin/login-history?result=failed', { cookie: admin })
    const ev = (hist.data?.events || []).find(e => e.ip === IP)
    ok('#10001 管理画面のログインの履歴に回数（repeat_count 3）を返す', ev && ev.repeat_count === 3 && ev.user_code === 'st005', ev)
    const js = read('public/static/security.js')
    ok('#10001 画面（セキュリティのログインの履歴）は2回以上の行に「N回（1分の間）」と出す', /Number\(e\.repeat_count\) > 1 \? `<br><span class="\$\{MUTED\} text-xs">\$\{Number\(e\.repeat_count\)\}回（1分の間）<\/span>`/.test(js))
    // 失敗が続いている ID（5回以上）: 1行にまとめても回数で数える
    await freshMinute(20)
    await resetBudget()
    for (let i = 0; i < 2; i++) await login('sample', 'st005', `wrong2-${UNIQ}-${i}`, IP)
    const al = await call('GET', '/api/admin/login-history', { cookie: admin })
    const a = (al.data?.alerts || []).find(x => x.user_code === 'st005')
    ok('#10001 失敗が続いている ID の回数は行の数でなく repeat_count の合計（3+1+2 = 6回）', a && Number(a.failures) === 6, al.data?.alerts)
    const audit = await call('GET', '/api/admin/audit-logs?kind=login', { cookie: admin })
    const item = (audit.data?.items || []).find(x => x.ip === IP && x.failed)
    ok('#10001 操作の記録のログインの失敗にも回数を出す（回数: N回）', item && item.lines.some(l => /^回数: \d+回（同じ接続元から1分の間に）$/.test(l)), audit.data?.items?.slice(0, 3))
  }

  // ---------- (1) 締め出し中は何も書かない ----------
  {
    await resetBudget()
    const acc = sha256('account|sample|st006')
    const now = new Date().toISOString()
    await q1(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) INSERT INTO login_attempts (scope, key_hash, attempted_at) SELECT 'account', '${acc}', '${now}' FROM n;`)
    const IP = '198.51.100.31'
    const before = { ...(await rowsFor(IP)), all: await count('(SELECT COUNT(*) FROM login_events)') }
    const r1 = await login('sample', 'st006', 'wrong-locked', IP)
    const r2 = await login('sample', 'st006', 'pass1234', IP)
    const r3 = await login('sample', 'st006', 'wrong-locked-2', '198.51.100.32')
    const after = { ...(await rowsFor(IP)), all: await count('(SELECT COUNT(*) FROM login_events)') }
    ok('#10001 締め出し中は 429（正しいパスワードでも・接続元を変えても）', [r1, r2, r3].every(r => r.status === 429 && /一時的にログインを止めています/.test(r.data?.error || '')), [r1, r2, r3].map(r => [r.status, r.data?.error]))
    ok('#10001 締め出し中の失敗で login_events・login_attempts・全体の回数の行が増えない', after.all === before.all && after.attempts === before.attempts && after.budget === before.budget, { before, after })
    await q1(`DELETE FROM login_attempts WHERE key_hash = '${acc}';`)
  }

  // ---------- (3) 全体の上限（1分6回）を超えたら書かずに 429 ----------
  {
    await resetBudget()
    await q1(`DELETE FROM alert_cooldowns WHERE alert_key LIKE 'write_budget:%';`)
    const nBefore = await count(`(SELECT COUNT(*) FROM user_notifications WHERE kind = 'error_alert' AND title LIKE 'ログインの失敗が急に増えています%')`)
    const evBefore = await count('(SELECT COALESCE(SUM(repeat_count), 0) FROM login_events)')
    await freshMinute(40)
    const r = []
    // 接続元・ID を変えながら（接続元ごと・ID ごとの制限にはかからない）
    for (let i = 0; i < 6; i++) r.push(await login('sample', `nouser-${UNIQ}-${i}`, 'x', `203.0.113.${10 + i}`))
    const attemptsMid = await count('(SELECT COUNT(*) FROM login_attempts)')
    const evMid = await count('(SELECT COALESCE(SUM(repeat_count), 0) FROM login_events)')
    const over = await login('sample', `nouser-${UNIQ}-7`, 'x', '203.0.113.30')
    const real = await login('sample', 'st001', 'pass1234', '203.0.113.31')
    const attemptsAfter = await count('(SELECT COUNT(*) FROM login_attempts)')
    const evAfter = await count('(SELECT COALESCE(SUM(repeat_count), 0) FROM login_events)')
    const budget = (await q1(`SELECT minute_count, day_count FROM auth_write_counters WHERE scope = 'login'`))[0]
    ok('（前提）上限までの6回は 401', r.every(x => x.status === 401), r.map(x => x.status))
    ok('#10001 1分の上限を超えたら、接続元を変えても 429（code: write_budget・混み合っている旨）', over.status === 429 && over.data?.code === 'write_budget' && /混み合っている/.test(over.data?.error || ''), over)
    ok('#10001 上限の間は正しいパスワードでも確かめずに断る（数えずに確かめると総当たりができるため）', real.status === 429 && real.data?.code === 'write_budget', real)
    ok('#10001 上限を超えた分は login_events・login_attempts・全体の回数を書かない', evAfter === evMid && attemptsAfter === attemptsMid && budget?.minute_count === 6 && evMid - evBefore === 6, { evBefore, evMid, evAfter, attemptsMid, attemptsAfter, budget })
    await sleep(1500)
    const nAfter = await count(`(SELECT COUNT(*) FROM user_notifications WHERE kind = 'error_alert' AND title LIKE 'ログインの失敗が急に増えています%')`)
    const hqUsers = await count(`(SELECT COUNT(*) FROM users WHERE role = 'system_admin' AND COALESCE(status, 'active') = 'active')`)
    ok('#10001 上限に届いたとき、本部の管理者全員にアプリ内の通知を1回だけ（error_alert）', nAfter - nBefore === hqUsers && hqUsers > 0, { nBefore, nAfter, hqUsers })
    // 次の分には受け付けを再開する
    await freshMinute(58)
    const again = await login('sample', 'st001', 'pass1234', '203.0.113.32')
    ok('#10001 次の分には受け付けを再開する（正しいパスワードでログインできる）', again.status === 200, again.status)
  }

  // ---------- (3) 1日の目安（9回）に届いたら、その日は1分1回まで ----------
  {
    await freshMinute(40)
    const day = utcDayNow()
    await q1(`DELETE FROM auth_write_counters; INSERT INTO auth_write_counters (scope, minute, minute_count, day, day_count) VALUES ('login', '2000-01-01T00:00', 0, '${day}', 8);`)
    const nBefore = await count(`(SELECT COUNT(*) FROM user_notifications WHERE kind = 'error_alert' AND title LIKE 'ログインの失敗が今日の目安%')`)
    await freshMinute(40)
    const r1 = await login('sample', `nouser-${UNIQ}-d1`, 'x', '203.0.113.40')
    const r2 = await login('sample', `nouser-${UNIQ}-d2`, 'x', '203.0.113.41')
    const b = (await q1(`SELECT minute_count, day_count FROM auth_write_counters WHERE scope = 'login'`))[0]
    ok('#10001 1日の目安（9回目）までは受け付け、届いた後はその分の2回目から 429', r1.status === 401 && r2.status === 429 && r2.data?.code === 'write_budget' && b?.day_count === 9 && b?.minute_count === 1, { r1: r1.status, r2: r2.status, b })
    await sleep(1500)
    const nAfter = await count(`(SELECT COUNT(*) FROM user_notifications WHERE kind = 'error_alert' AND title LIKE 'ログインの失敗が今日の目安%')`)
    ok('#10001 1日の目安に届いたことを本部に知らせる', nAfter > nBefore, { nBefore, nAfter })
    await freshMinute(58)
    const r3 = await login('sample', `nouser-${UNIQ}-d3`, 'x', '203.0.113.42')
    const r4 = await login('sample', `nouser-${UNIQ}-d4`, 'x', '203.0.113.43')
    ok('#10001 目安の後は次の分も1回だけ受け付ける', r3.status === 401 && r4.status === 429, [r3.status, r4.status])
    await resetBudget()
  }

  // ---------- (4) ログインなしの送信（パスワードの再設定の依頼）にも全体の上限 ----------
  {
    await q1(`DELETE FROM auth_write_counters WHERE scope = 'public';`)
    await freshMinute(30)
    const fp = (i) => call('POST', '/api/auth/forgot-password', { body: { email: `nobody-${UNIQ}-${i}@example.com` }, ip: `192.0.2.${50 + i}` })
    const r = [await fp(1), await fp(2), await fp(3)]
    const resetRows = await count(`(SELECT COUNT(*) FROM login_attempts WHERE scope = 'reset_ip')`)
    const over = await fp(4)
    const resetRows2 = await count(`(SELECT COUNT(*) FROM login_attempts WHERE scope = 'reset_ip')`)
    ok('#10001 再設定の依頼は1分3回（テストの値）までいつもの応答、超えたら書かずに 429（write_budget）', r.every(x => x.status === 200 && x.data?.ok) && over.status === 429 && over.data?.code === 'write_budget' && resetRows2 === resetRows, { r: r.map(x => x.status), over, resetRows, resetRows2 })
    const busyLogin = await login('sample', 'st001', 'pass1234', '192.0.2.60')
    ok('#10001 ログインの数え方（login）とは別（再設定の上限でもログインはできる）', busyLogin.status === 200, busyLogin.status)
    await q1(`DELETE FROM auth_write_counters WHERE scope = 'public';`)
  }

  // ---------- (5) 成功のログインは今までどおり ----------
  {
    const IP = '198.51.100.41'
    await login('sample', 'st007', 'pass1234', IP)
    await login('sample', 'st007', 'pass1234', IP)
    const rows = await q1(`SELECT result, repeat_count, bucket_key FROM login_events WHERE ip = '${IP}'`)
    ok('#10001 成功のログインは1件1行（同じ1分・同じ接続元でもまとめない。repeat_count 1・bucket_key なし）', rows.length === 2 && rows.every(r => r.result === 'success' && r.repeat_count === 1 && r.bucket_key === null), rows)
    const audit = await call('GET', '/api/admin/audit-logs?kind=login', { cookie: admin })
    ok('#10001 操作の記録にログインの成功が今までどおり出る（回数の行は付けない）', (audit.data?.items || []).filter(x => x.ip === IP && !x.failed && !x.lines.some(l => /^回数/.test(l))).length === 2, audit.data?.items?.slice(0, 3))
    // 失敗 → 成功 → 失敗（同じ1分・同じ接続元）: 成功の後の失敗は新しい行（「最後に成功してから」の回数を数え直せる）
    await freshMinute(20)
    const IP2 = '198.51.100.42'
    await login('sample', 'st008', 'wrong-a', IP2)
    await login('sample', 'st008', 'pass1234', IP2)
    await login('sample', 'st008', 'wrong-b', IP2)
    const seq = await q1(`SELECT result, repeat_count FROM login_events WHERE ip = '${IP2}' ORDER BY event_id`)
    ok('#10001 成功を挟んだ失敗はまとめない（失敗・成功・失敗の3行）', seq.length === 3 && seq.map(r => r.result).join(',') === 'bad_password,success,bad_password' && seq.every(r => r.repeat_count === 1), seq)
    const run = await call('POST', '/api/hq/share-detect/run', { cookie: hq, body: {} })
    ok('#10001 使い回しの疑いの集計（成功のログインの行を読む）はそのまま動く', run.status === 200, run)
  }

  // ---------- (7) 使った量の通知（定期処理 usage_watch。問い合わせ先は手元の受け口） ----------
  {
    let usage = { rowsWritten: 60_000, rowsRead: 1_000_000, requests: 10_000 }
    const got = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', ch => { body += ch })
      req.on('end', () => {
        got.push({ path: req.url, auth: req.headers.authorization, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: { viewer: { accounts: [{
          d1: [{ sum: { rowsRead: usage.rowsRead - 1, rowsWritten: usage.rowsWritten - 1 }, dimensions: { databaseId: 'a' } }, { sum: { rowsRead: 1, rowsWritten: 1 }, dimensions: { databaseId: 'b' } }],
          w: [{ sum: { requests: usage.requests }, dimensions: { scriptName: 'mbsaas' } }],
        }] } }, errors: null }))
      })
    })
    await new Promise(r => server.listen(GQL_PORT, '127.0.0.1', r))
    const title = (kw) => count(`(SELECT COUNT(*) FROM user_notifications WHERE kind = 'error_alert' AND instr(title, '無料プランの${kw}') = 1)`)
    const runCron = async () => { await rawFetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`); await sleep(800) }
    try {
      const w50a = await title('D1 の書き込み（行）が1日の上限の50%')
      await runCron()
      const w50b = await title('D1 の書き込み（行）が1日の上限の50%')
      const r50 = await title('D1 の読み取り')
      const last = (await q1(`SELECT status, result_json FROM cron_runs WHERE job = 'usage_watch' ORDER BY run_id DESC LIMIT 1`))[0]
      const res = JSON.parse(last?.result_json || '{}')
      ok('使った量: 定期処理 usage_watch が問い合わせ（Bearer のトークン・アカウント ID・今日の UTC の 0 時から）、合計を記録に残す',
        got.length >= 1 && got[0].auth === 'Bearer w33-test-token' && /"a":"w33acct"/.test(got[0].body) && new RegExp(`"s":"${utcDayNow()}T00:00:00Z"`).test(got[0].body)
          && new RegExp(`"d":"${utcDayNow()}"`).test(got[0].body) && /date_geq: \$d/.test(got[0].body)
          && last?.status === 'ok' && res.d1_rows_written === 60000 && res.d1_rows_read === 1000000 && res.workers_requests === 10000, { got: got[0], last })
      const hqUsers = await count(`(SELECT COUNT(*) FROM users WHERE role = 'system_admin' AND COALESCE(status, 'active') = 'active')`)
      ok('使った量: D1 の書き込みが 50% を超えたら本部の管理者全員に知らせる（読み取りは 20% なので知らせない）', w50b - w50a === hqUsers && r50 === 0, { w50a, w50b, r50, hqUsers })
      await runCron()
      ok('使った量: 同じ日に同じ線（50%）は知らせ直さない', (await title('D1 の書き込み（行）が1日の上限の50%')) === w50b)
      usage = { rowsWritten: 85_000, rowsRead: 1_000_000, requests: 81_000 }
      await runCron()
      const w80 = await title('D1 の書き込み（行）が1日の上限の80%')
      const q80 = await title('Workers の要求が1日の上限の80%')
      ok('使った量: 80% を超えたら1回知らせる（D1 の書き込み・Workers の要求のそれぞれ）', w80 === hqUsers && q80 === hqUsers, { w80, q80 })
      await runCron()
      ok('使った量: 80% も同じ日は知らせ直さない', (await title('D1 の書き込み（行）が1日の上限の80%')) === w80 && (await title('Workers の要求が1日の上限の80%')) === q80)
      const body = (await q1(`SELECT body FROM user_notifications WHERE instr(title, '無料プランのD1 の書き込み（行）が1日の上限の80%') = 1 LIMIT 1`))[0]?.body || ''
      ok('使った量: 通知の文に今日の数・上限・確かめる場所（トークン・アカウント ID は入れない）', /85,000／1日の上限 100,000/.test(body) && /日本時間 9:00/.test(body) && !/w33-test-token|w33acct/.test(body), body)
    } finally { server.close() }
  }
}

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} 件が成功しました`)
process.exit(failed ? 1 : 0)
