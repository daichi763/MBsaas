// w27-mobital（Sprint 27 #9981）のテスト: サービス名を Mobital に・本番の URL を https://app.mobital.jp に移すコードの側
//   1) 転送の条件（src/lib/host-redirect.ts を esbuild でまとめて呼ぶ）: ホスト・パス・メソッドごとに、転送する／しない
//   2) src/index.tsx をそのまま esbuild でまとめ、本番のホスト（workers.dev・app.mobital.jp）の URL で要求を送る（D1 は差し替え。本番には接続しない）:
//      workers.dev の画面は 301、/api/*・/webhooks/*・/sw.js・静的ファイルは転送しない、CSRF の送り元の確認がどちらのホストでも通る
//   3) メールの本文の URL が APP_BASE_URL（src/accounts.ts のパスワード再設定のメール。fetch を差し替えて Resend には送らない）
//   4) 設定とソース: wrangler.jsonc の env.production の APP_BASE_URL・routes を書かない・workers_dev を止めない、「Field OS」が画面・コードに残っていない、ホスト名の直書きがない
//   5) 開発サーバー（APP_BASE_URL を https://app.mobital.jp にして起動）: ローカルでは転送しない、タイトル・manifest の名前、
//      Origin が app.mobital.jp でもログイン・打刻・報告用URLの報告が通る、Cookie に Domain を付けない
//   6) 画面（ヘッドレスの Chrome）: ログイン画面とスタッフのホームのタイトルが Mobital。Chrome が無いときは省く（CHROME=<パス> で指定できる）
//   7) プッシュの購読の重複（移した後に同じ端末へ2回届かない）: 決め方（src/lib/web-push.ts の pushHostCleanup）の単体と、
//      開発サーバーへ Host: app.mobital.jp で購読を登録すると、同じ人の別のホスト・ホストの記録がない購読が消え、ほかの人の購読は残ること
//      （ホストの記録がない購読は PERSIST=<保存先> のときだけ D1 に直接入れて確かめる。--local のみ）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9025 --persist-to <保存先> --var APP_BASE_URL:https://app.mobital.jp で起動していること
// 実行: BASE=http://127.0.0.1:9025 APP_BASE_URL=https://app.mobital.jp node --import ./scripts/fetch-origin.mjs scripts/test-w27-mobital.mjs
// run-tests: --var APP_BASE_URL:https://app.mobital.jp
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9025'
const SELF = new URL(BASE).origin
const APP = 'https://app.mobital.jp'
const WD = 'https://mbsaas.saas-2a2.workers.dev'
const rawFetch = globalThis.__rawFetch || globalThis.fetch // Origin を自分で決めて送る
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const esbuild = (await import('esbuild')).default
const work = mkdtempSync(join(tmpdir(), 'w27-mobital-'))
async function bundle(entry, name, extra = {}) {
  const out = join(work, name)
  await esbuild.build({ entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error', external: ['node:*'], ...extra })
  return import(pathToFileURL(out).href)
}

// ---------- 1. 転送の条件（単体） ----------
{
  const { hostRedirectTarget: t, HOST_REDIRECT_MAX_AGE } = await bundle('src/lib/host-redirect.ts', 'host-redirect.mjs')
  const env = { APP_BASE_URL: APP }
  ok('転送: workers.dev の GET の画面は APP_BASE_URL の同じパス・クエリへ', t('GET', `${WD}/login?c=sample&next=%2Fstaff`, env) === `${APP}/login?c=sample&next=%2Fstaff`)
  ok('転送: HEAD も転送する', t('HEAD', `${WD}/staff`, env) === `${APP}/staff`)
  const pages = ['/', '/login', '/staff', '/admin', '/hq', '/r/abcDEF123_-', '/apply/tok123', '/reset-password?token=x', '/verify-email?token=y', '/notice-ack/abc']
  const pageMiss = pages.filter(p => t('GET', WD + p, env) !== APP + p)
  ok('転送: 画面のパス（トップ・ログイン・スタッフ・管理・本部・報告用URL・募集ページ・再設定・確認）はすべて転送する', !pageMiss.length, pageMiss)
  const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter(m => t(m, `${WD}/login`, env) !== null)
  ok('転送: GET・HEAD 以外（POST・PUT・PATCH・DELETE・OPTIONS）は転送しない', !methods.length, methods)
  const keep = ['/api', '/api/health', '/api/auth/login', '/api/staff/attendance', '/api/public/report/abc', '/api/public/calendar/x.ics', '/webhooks/resend', '/webhooks', '/sw.js', '/manifest.webmanifest', '/static/style.css', '/static/icon-192.png', '/favicon.ico', '/robots.txt', '/icon.png']
  const keepMiss = keep.filter(p => t('GET', WD + p, env) !== null)
  ok('転送: /api/*（/api/health を含む）・/webhooks/*・/sw.js・静的ファイル・manifest は転送しない', !keepMiss.length, keepMiss)
  ok('転送: app.mobital.jp（APP_BASE_URL と同じホスト）では転送しない', t('GET', `${APP}/login`, env) === null && t('GET', 'https://APP.mobital.jp/login', env) === null)
  ok('転送: localhost・127.0.0.1 では転送しない', t('GET', 'http://localhost:8787/login', env) === null && t('GET', 'http://127.0.0.1:9025/staff', env) === null)
  ok('転送: workers.dev でない別のホスト（独自ドメインの別名など）では転送しない', t('GET', 'https://other.mobital.jp/login', env) === null && t('GET', 'https://example.com/login', env) === null)
  ok('転送: APP_BASE_URL が workers.dev のまま（戻したとき）は、そのホストで転送しない', t('GET', `${WD}/login`, { APP_BASE_URL: WD }) === null)
  ok('転送: APP_BASE_URL が http（ローカルの既定）・未設定のときは転送しない', t('GET', `${WD}/login`, { APP_BASE_URL: 'http://localhost:8787' }) === null && t('GET', `${WD}/login`, {}) === null && t('GET', `${WD}/login`, null) === null)
  ok('転送: 大文字のホスト・末尾の / の APP_BASE_URL でも同じに扱う', t('GET', 'https://MBSAAS.saas-2a2.WORKERS.DEV/staff', { APP_BASE_URL: APP + '/' }) === `${APP}/staff`)
  ok('転送: 宛先のホストは APP_BASE_URL から取る（// で始まるパスでも別のサイトへ移さない）', t('GET', `${WD}//evil.example.com/x`, env) === `${APP}//evil.example.com/x`)
  ok('転送: ブラウザが転送を覚えるのは1日（戻すときのため）', HOST_REDIRECT_MAX_AGE === 86400)
}

// ---------- 1b. プッシュの購読の重複を消す決め方（単体） ----------
{
  const { pushHostCleanup: h } = await bundle('src/lib/web-push.ts', 'web-push.mjs')
  const app = h(`${APP}/api/staff/push/subscribe`, { APP_BASE_URL: APP })
  ok('購読: app.mobital.jp（APP_BASE_URL のホスト）で登録したら、別のホスト・ホストの記録がない購読を消す', app.host === 'app.mobital.jp' && app.cleanup === true && app.nullIsOther === true, app)
  const wd = h(`${WD}/api/staff/push/subscribe`, { APP_BASE_URL: APP })
  ok('購読: workers.dev の古いタブで登録しても、ほかの購読は消さない（ホストは記録する）', wd.host === 'mbsaas.saas-2a2.workers.dev' && wd.cleanup === false && wd.nullIsOther === false, wd)
  const stg = h(`${WD}/api/staff/push/subscribe`, { APP_BASE_URL: WD + '/' })
  ok('購読: APP_BASE_URL が workers.dev（ステージング・戻したとき）は、同じホストなのでホストの記録がない購読は消さない', stg.cleanup === true && stg.nullIsOther === false, stg)
  const up = h('https://APP.Mobital.JP/api/hq/push/subscribe', { APP_BASE_URL: APP })
  ok('購読: ホストの大文字・小文字は同じに扱う', up.host === 'app.mobital.jp' && up.cleanup === true, up)
  const loc = h('http://localhost:8787/api/staff/push/subscribe', { APP_BASE_URL: 'http://localhost:8787' })
  const loc2 = h('http://127.0.0.1:9045/api/staff/push/subscribe', { APP_BASE_URL: 'http://localhost:8787' })
  ok('購読: 手元はポートまで比べる（localhost:8787 なら消す・127.0.0.1 のテストのサーバーでは消さない）', loc.cleanup === true && loc.host === 'localhost:8787' && loc2.cleanup === false && loc2.host === '127.0.0.1:9045', [loc, loc2])
  const none = [h(`${APP}/x`, {}), h(`${APP}/x`, null), h('not a url', { APP_BASE_URL: APP })]
  ok('購読: APP_BASE_URL が無い・URL が読めないときは消さない', none.every(x => x.cleanup === false), none)
}
// ---------- 2. src/index.tsx を本番のホストの URL で呼ぶ（D1 は差し替え） ----------
const fakeDb = () => {
  const stmt = { bind() { return stmt }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }), raw: async () => [] }
  return { prepare: () => stmt, batch: async (a) => a.map(() => ({ results: [], meta: { changes: 0 } })), exec: async () => ({}) }
}
{
  const worker = (await bundle('src/index.tsx', 'index.mjs', { define: { __APP_VERSION__: '"w27test"' } })).default
  const env = { APP_BASE_URL: APP, DB: fakeDb(), MAIL_ENABLED: 'false' }
  const ctx = { waitUntil() { }, passThroughOnException() { } }
  const call = (method, url, headers = {}, body) => worker.fetch(new Request(url, { method, headers, body, redirect: 'manual' }), env, ctx)
  const r1 = await call('GET', `${WD}/login?c=sample`)
  ok('本番のホスト: workers.dev の /login は 301 で app.mobital.jp の同じパス・クエリへ', r1.status === 301 && r1.headers.get('location') === `${APP}/login?c=sample` && r1.headers.get('cache-control') === 'max-age=86400', [r1.status, r1.headers.get('location')])
  const r2 = await call('HEAD', `${WD}/staff`)
  ok('本番のホスト: workers.dev の HEAD /staff も 301', r2.status === 301 && r2.headers.get('location') === `${APP}/staff`)
  const r3 = await call('GET', `${WD}/r/abcdefabcdefabcdef`)
  ok('本番のホスト: workers.dev の報告用URL（/r/<トークン>）は app.mobital.jp の同じ URL へ', r3.status === 301 && r3.headers.get('location') === `${APP}/r/abcdefabcdefabcdef`)
  const h = await call('GET', `${WD}/api/health`)
  ok('本番のホスト: workers.dev の /api/health は転送せずに 200', h.status === 200 && (await h.json()).ok === true, h.status)
  const sw = await call('GET', `${WD}/sw.js`)
  const swText = await sw.text()
  ok('本番のホスト: workers.dev の /sw.js は転送しない（古い Service Worker が通知を出し続ける）・通知の名前は Mobital', sw.status === 200 && /Mobital/.test(swText) && !/Field OS/.test(swText), sw.status)
  const wh = await call('POST', `${WD}/webhooks/resend`, { 'Content-Type': 'application/json' }, '{}')
  ok('本番のホスト: workers.dev の Resend の Webhook（POST）は転送しない', wh.status !== 301 && wh.status !== 308 && !wh.headers.get('location'), wh.status)
  const apiGet = await call('GET', `${WD}/api/auth/me`)
  ok('本番のホスト: workers.dev の API の GET は転送しない（古いタブ・ホーム画面のアプリ）', apiGet.status !== 301 && !apiGet.headers.get('location'), apiGet.status)
  const app = await call('GET', `${APP}/api/health`)
  ok('本番のホスト: app.mobital.jp では転送しない', app.status === 200 && !app.headers.get('location'))
  const appLogin = await call('GET', `${APP}/login`)
  ok('本番のホスト: app.mobital.jp のログイン画面は 200（タイトルは Mobital）', appLogin.status === 200 && /<title>ログイン \| Mobital<\/title>/.test(await appLogin.text()), appLogin.status)

  // CSRF の送り元の確認: 403（csrf_origin）にならなければ、ログインの処理まで進んでいる（D1 が空なので 401 などになる）
  const post = (host, origin) => call('POST', `${host}/api/auth/login`, { 'Content-Type': 'application/json', Origin: origin }, JSON.stringify({ company_code: 'x', user_code: 'y', password: 'z' }))
  const isCsrf = async (r) => r.status === 403 && (await r.clone().json().catch(() => ({}))).code === 'csrf_origin'
  const cases = {
    'app.mobital.jp の画面 → app.mobital.jp': [APP, APP, false],
    'workers.dev の古いタブ → workers.dev': [WD, WD, false],
    'app.mobital.jp の画面 → workers.dev（APP_BASE_URL のホスト）': [WD, APP, false],
    '別のサイト → app.mobital.jp': [APP, 'https://evil.example.com', true],
    '別のサイト → workers.dev': [WD, 'https://evil.example.com', true],
    '別の workers.dev → workers.dev': [WD, 'https://evil.saas-2a2.workers.dev', true],
  }
  const got = {}
  for (const [name, [host, origin]] of Object.entries(cases)) { const r = await post(host, origin); got[name] = { status: r.status, csrf: await isCsrf(r) } }
  const bad = Object.entries(cases).filter(([name, [, , reject]]) => got[name].csrf !== reject)
  ok('CSRF: 送り元が app.mobital.jp・workers.dev（要求のホスト）なら両方のホストで通り、別のサイトは 403', !bad.length, got)
  const pubWd = await call('POST', `${WD}/api/public/report/${'a'.repeat(43)}/attendance`, { 'Content-Type': 'application/json', Origin: WD }, JSON.stringify({ report_type: 'wake_up' }))
  ok('報告用URLの報告（/api/public）は workers.dev でも転送・CSRF で止めない', pubWd.status !== 301 && !(await isCsrf(pubWd)), pubWd.status)
}

// ---------- 3. メールの本文の URL ----------
{
  const acc = await bundle('src/accounts.ts', 'accounts.mjs')
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'msg-w27' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
    return realFetch(url, init)
  }
  try {
    const env = { DB: fakeDb(), APP_BASE_URL: APP, MAIL_ENABLED: 'true', RESEND_API_KEY: 're_test', MAIL_FROM: 'Mobital <notify@notify.mobital.jp>' }
    const r = await acc.sendPasswordResetLink(env, { user_id: 1, name: '山田 太郎', user_code: 'st001', email: 'taro@example.com', company_id: 1, company_name: 'サンプル社' })
    const m = sent[0] || {}
    const links = [...String(m.html || '').matchAll(/href="([^"]+)"/g)].map(x => x[1]).concat([...String(m.text || '').matchAll(/https?:\/\/\S+/g)].map(x => x[0]))
    ok('メール: パスワード再設定のリンクが APP_BASE_URL（https://app.mobital.jp/reset-password?token=…）', r.ok && links.length > 0 && links.every(u => u.startsWith(`${APP}/`)) && links.some(u => u.startsWith(`${APP}/reset-password?token=`)), { r, links })
    ok('メール: 本文・件名に Field OS が残っていない・Mobital の名前', !/Field OS/.test(JSON.stringify(m)) && /Mobital/.test(String(m.html) + String(m.text)), m.subject)
  } finally { globalThis.fetch = realFetch }
}
rmSync(work, { recursive: true, force: true })

// ---------- 4. 設定とソース ----------
{
  const wr = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''))
  ok('wrangler.jsonc: env.production の APP_BASE_URL は https://app.mobital.jp、ローカルは http://localhost:8787 のまま', wr.env.production.vars.APP_BASE_URL === APP && wr.vars.APP_BASE_URL === 'http://localhost:8787')
  const conf = read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '')
  ok('wrangler.jsonc: routes・custom_domain を書かない（ドメインは Cloudflare のダッシュボードで付ける）・workers_dev を止めない', !/"routes"|"route"|custom_domain/.test(conf) && wr.workers_dev !== false && wr.env.production.workers_dev !== false)
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', 'src', 'public', 'scripts/gen_seed.cjs', 'seed.sql', 'wrangler.jsonc', 'README.md'], { encoding: 'utf8' }).split('\n').filter(f => f && !/\.(png|ico)$/.test(f))
  const left = files.filter(f => existsSync(join(ROOT, f)) && read(f).includes('Field OS'))
  ok('名前: 画面・コード・manifest・シード・README に「Field OS」が残っていない（README は旧名の注記だけ）', left.every(f => f === 'README.md') && (read('README.md').match(/Field OS/g) || []).length === 1, left)
  const hard = files.filter(f => f.startsWith('src/') || f.startsWith('public/')).filter(f => /saas-2a2|mbsaas\.[a-z0-9-]+\.workers\.dev/.test(read(f)))
  ok('URL: src・public に本番のホスト名（mbsaas.saas-2a2.workers.dev）の直書きがない', !hard.length, hard)
  const m = JSON.parse(read('public/manifest.webmanifest'))
  ok('manifest: name・short_name が Mobital', m.name === 'Mobital' && m.short_name === 'Mobital')
  const idx = read('src/index.tsx')
  ok('index.tsx: 転送のミドルウェアを API・画面のルートより前に置く', idx.indexOf('hostRedirectTarget(c.req.method') > 0 && idx.indexOf('hostRedirectTarget(c.req.method') < idx.indexOf("app.route('/api', api)") && idx.indexOf('hostRedirectTarget(c.req.method') < idx.indexOf("app.get('/login'"))
  const ops = read('docs/operations.md')
  ok('docs: operations.md に移す手順（カスタムドメイン → 疎通 → デプロイ → 確かめ → 依頼）・戻し方・告知の文', /## 11\. 本番の URL を app\.mobital\.jp に移す/.test(ops) && /### 11\.2 移す手順/.test(ops) && /### 11\.3 戻し方/.test(ops) && /### 11\.4 告知の文/.test(ops)
    && /ログインし/.test(ops.slice(ops.indexOf('### 11.4'))) && /プッシュ通知/.test(ops.slice(ops.indexOf('### 11.4'))) && /ホーム画面/.test(ops.slice(ops.indexOf('### 11.4'))))
}

// ---------- 5. 開発サーバー（APP_BASE_URL を https://app.mobital.jp にして起動） ----------
const req = async (method, path, { cookie, origin = SELF, body, headers = {} } = {}) => {
  const h = { ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  if (cookie) h.Cookie = cookie
  if (origin) h.Origin = origin
  const r = await rawFetch(`${BASE}${path}`, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) })
  const text = method === 'HEAD' ? '' : await r.text()
  let data = null; try { data = JSON.parse(text) } catch { }
  return { status: r.status, data, text, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' }
}
async function login(company_code, user_code, origin = SELF) {
  const r = await req('POST', '/api/auth/login', { origin, body: { company_code, user_code, password: 'pass1234' } })
  return { ...r, cookie: r.setCookie.split(';')[0] }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const tag = Date.now().toString(36).slice(-5)
let serverUp = false
{
  const lg = await req('GET', '/login', { origin: null })
  serverUp = lg.status === 200
  ok('サーバー: ローカル（127.0.0.1）では転送しない（/login は 200）', lg.status === 200 && !lg.headers.get('location'), lg.status)
  ok('サーバー: ログイン画面のタイトル・見出し・ホーム画面の名前が Mobital', /<title>ログイン \| Mobital<\/title>/.test(lg.text) && /<h1[^>]*>Mobital<\/h1>/.test(lg.text) && /apple-mobile-web-app-title" content="Mobital"/.test(lg.text) && !/Field OS/.test(lg.text))
  const mf = await req('GET', '/manifest.webmanifest', { origin: null })
  ok('サーバー: manifest の name・short_name が Mobital', mf.status === 200 && mf.data?.name === 'Mobital' && mf.data?.short_name === 'Mobital', mf.data)

  // ログイン: Origin が app.mobital.jp（APP_BASE_URL）でも、要求のホスト（127.0.0.1）でも通る。Cookie に Domain を付けない
  const a = await login('sample', 'admin', APP)
  const b = await login('sample', 'admin', SELF)
  ok('サーバー: ログインは Origin が app.mobital.jp（APP_BASE_URL）でも要求のホストでも通る', a.status === 200 && b.status === 200, [a.status, b.status])
  ok('サーバー: ログインの Cookie は Domain を付けない（ホストごと）・HttpOnly・SameSite=Lax', /session=/.test(a.setCookie) && !/domain=/i.test(a.setCookie) && /httponly/i.test(a.setCookie) && /samesite=lax/i.test(a.setCookie), a.setCookie)
  const evil = await login('sample', 'admin', WD)
  ok('サーバー: ローカルでは workers.dev は別のサイト（403。自分のサイトは要求のホストと APP_BASE_URL だけ）', evil.status === 403 && evil.data?.code === 'csrf_origin', evil.status)
  const admin = a.cookie

  // 打刻: Origin が app.mobital.jp で送っても通る
  const st = await login('sample', 'st009', APP)
  const memo = 'W27M-' + tag
  const cr = await req('POST', '/api/admin/shifts', { cookie: admin, origin: APP, body: { staff_id: 9, project_id: 1, work_date: today, start_time: '00:01', end_time: '23:30', memo, force: true } })
  const list = await req('GET', `/api/admin/shifts?from=${today}&to=${today}`, { cookie: admin })
  const sid = list.data?.shifts?.find(x => x.memo === memo)?.shift_id
  ok('（前提）シフトを作る（Origin が app.mobital.jp）', cr.status === 200 && sid, cr.data)
  const punch = await req('POST', '/api/staff/attendance', { cookie: st.cookie, origin: APP, body: { shift_id: sid, report_type: 'wake_up', latitude: null, longitude: null, client_request_id: 'w27m-' + tag } })
  ok('サーバー: スタッフの打刻（起床）は Origin が app.mobital.jp でも通る', st.status === 200 && punch.status === 200, punch.data)

  // 報告用URL: 発行・画面・報告
  const memo2 = 'W27M2-' + tag
  await req('POST', '/api/admin/shifts', { cookie: admin, origin: APP, body: { staff_id: 10, project_id: 1, work_date: today, start_time: '00:01', end_time: '23:30', memo: memo2, force: true } })
  const sid2 = (await req('GET', `/api/admin/shifts?from=${today}&to=${today}`, { cookie: admin })).data?.shifts?.find(x => x.memo === memo2)?.shift_id
  const link = await req('POST', `/api/admin/shifts/${sid2}/report-link`, { cookie: admin, origin: APP, body: {} })
  const token = link.data?.token
  ok('（前提）報告用URLを発行する（Origin が app.mobital.jp）', link.status === 200 && token, link.data)
  const page = await req('GET', `/r/${token}`, { origin: null })
  ok('サーバー: 報告用URLの画面は 200 でタイトルが Mobital（ローカルでは転送しない）', page.status === 200 && /\| Mobital<\/title>/.test(page.text), page.status)
  const rep = await req('POST', `/api/public/report/${token}/attendance`, { origin: APP, body: { report_type: 'wake_up' } })
  ok('サーバー: 報告用URLからの報告（起床）が通る', rep.status === 200, rep.data)
  const sw = await req('GET', '/sw.js', { origin: null })
  ok('サーバー: Service Worker の通知の既定の名前が Mobital', sw.status === 200 && /'Mobital'/.test(sw.text) && /'Mobital 本部'/.test(sw.text) && /'Mobital 管理'/.test(sw.text))
}

// ---------- 7. プッシュの購読の重複（開発サーバーに Host: app.mobital.jp で送る） ----------
// 本番では app.mobital.jp の要求の URL のホストが app.mobital.jp になる。開発サーバーでも Host のヘッダーが要求の URL のホストになるので、それで同じ状況を作る
const PERSIST = process.env.PERSIST || ''
function hostReq(method, path, { host, cookie, origin, body } = {}) {
  const u = new URL(BASE + path)
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const headers = { Host: host || u.host }
  if (cookie) headers.Cookie = cookie
  if (origin) headers.Origin = origin
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length) }
  return new Promise((res, rej) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (resp) => {
      let t = ''; resp.setEncoding('utf8'); resp.on('data', d => t += d)
      resp.on('end', () => { let j = null; try { j = JSON.parse(t) } catch { } res({ status: resp.statusCode, data: j, headers: resp.headers }) })
    })
    r.on('error', rej); if (data) r.write(data); r.end()
  })
}
const work2 = mkdtempSync(join(tmpdir(), 'w27-push-'))
let sqlSeq = 0
function sql(command) {
  const file = join(work2, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { cwd: ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
if (!serverUp) console.log('SKIP  プッシュの購読の重複（開発サーバーに接続できません）')
else {
  const APP_HOST = new URL(APP).host
  const keys = { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' }
  const EP = (s) => `https://fcm.googleapis.com/fcm/send/w27-${tag}-${s}`
  const st = await login('sample', 'st012')
  const other = await login('sample', 'st013')
  ok('（前提）スタッフ st012・st013 でログインする', !!st.cookie && !!other.cookie, [st.status, other.status])
  const sub = (cookie, ep, host) => hostReq('POST', '/api/staff/push/subscribe', { host, cookie, origin: host ? `http://${host}` : SELF, body: { endpoint: ep, keys } })
  const cfg = (cookie, host, ep) => hostReq('GET', '/api/staff/push/config' + (ep ? `?endpoint=${encodeURIComponent(ep)}` : ''), { host, cookie })
  // 1) APP_BASE_URL でないホスト（127.0.0.1。移す前の workers.dev に当たる）で登録した購読
  const s1 = await sub(st.cookie, EP('old1'))
  ok('購読: APP_BASE_URL でないホスト（移す前の workers.dev に当たる）で登録しても、ほかの購読は消さない', s1.status === 200 && s1.data?.other_host_removed === 0, s1)
  const o1 = await sub(other.cookie, EP('other'))
  ok('（前提）別の人（st013）の購読を登録する', o1.status === 200, o1)
  let nullRows = false
  if (PERSIST) {
    try {
      sql(`INSERT INTO push_subscriptions (company_id, user_id, person_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
        SELECT company_id, user_id, person_id, '${EP('null1')}', 'x', 'y', 'old', '2026-11-01 00:00:00', '2026-11-01 00:00:00' FROM users WHERE user_id = 15;
        INSERT INTO push_subscriptions (company_id, user_id, person_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
        SELECT company_id, user_id, person_id, '${EP('null2')}', 'x', 'y', 'old', '2026-11-01 00:00:00', '2026-11-01 00:00:00' FROM users WHERE user_id = 16;`)
      nullRows = true
    } catch (e) { ok('（前提）ホストの記録がない購読（0113 より前の登録）を D1 に入れる', false, String(e.message).slice(0, 200)) }
  } else console.log('SKIP  ホストの記録がない購読（PERSIST 未指定）')
  const before = await cfg(st.cookie)
  ok(`（前提）移す前: st012 の購読は ${nullRows ? 2 : 1} 台`, before.data?.devices === (nullRows ? 2 : 1), before.data)
  // 2) app.mobital.jp で通知をオンにし直す
  const s2 = await sub(st.cookie, EP('new'), APP_HOST)
  ok(`購読: app.mobital.jp で登録すると、同じ人の別のホスト${nullRows ? '・ホストの記録がない' : ''}購読を消す（同じ端末に2回届かない）`, s2.status === 200 && s2.data?.other_host_removed === (nullRows ? 2 : 1), s2)
  const after = await cfg(st.cookie, APP_HOST, EP('new'))
  const otherCfg = await cfg(other.cookie)
  ok('購読: 残るのは app.mobital.jp の購読だけ（この端末は受け取る状態）', after.data?.devices === 1 && after.data?.subscribed === true, after.data)
  ok('購読: ほかの人の購読（別のホスト・ホストの記録がないもの）は消さない', otherCfg.data?.devices === (nullRows ? 2 : 1), otherCfg.data)
  if (PERSIST) {
    const rows = sql(`SELECT endpoint, subscribed_host FROM push_subscriptions WHERE endpoint LIKE '%w27-${tag}-%' ORDER BY endpoint`)
    const byEp = Object.fromEntries(rows.map(r => [r.endpoint.split('-').pop(), r.subscribed_host]))
    ok('購読: 登録したホストを subscribed_host に残す（app.mobital.jp・127.0.0.1:<ポート>）', byEp.new === APP_HOST && byEp.other === new URL(BASE).host && !('old1' in byEp) && !('null1' in byEp) && (!nullRows || byEp.null2 === null), byEp)
  }
  // 3) 古いホストの開いたままのタブで登録し直しても、app.mobital.jp の購読は消さない。app.mobital.jp でもう一度登録すると古い方を消す
  const s3 = await sub(st.cookie, EP('old2'))
  const mid = await cfg(st.cookie, APP_HOST, EP('new'))
  ok('購読: 古いホストのタブで登録しても、app.mobital.jp の購読は消さない', s3.status === 200 && s3.data?.other_host_removed === 0 && mid.data?.devices === 2 && mid.data?.subscribed === true, [s3.data, mid.data])
  const s4 = await sub(st.cookie, EP('new'), APP_HOST)
  const fin = await cfg(st.cookie, APP_HOST, EP('new'))
  ok('購読: app.mobital.jp で同じ端末を登録し直すと、古いホストの購読だけを消し、自分の購読は残す', s4.data?.other_host_removed === 1 && fin.data?.devices === 1 && fin.data?.subscribed === true, [s4.data, fin.data])
  // 後片付け（このテストで作った購読を消す）
  await hostReq('POST', '/api/staff/push/unsubscribe', { host: APP_HOST, cookie: st.cookie, origin: APP, body: { endpoint: EP('new') } })
  await hostReq('POST', '/api/staff/push/unsubscribe', { cookie: other.cookie, origin: SELF, body: { endpoint: EP('other') } })
  if (nullRows) sql(`DELETE FROM push_subscriptions WHERE endpoint LIKE '%w27-${tag}-%'`)
}
rmSync(work2, { recursive: true, force: true })

// ---------- 6. 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!serverUp) console.log('SKIP  画面の確認（開発サーバーに接続できません）')
else if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const lib = await import('./lib/chrome.mjs')
  const PORT = await lib.freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w27m-'))
  const chrome = await lib.launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=420,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200) } return false }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    // ログイン画面: 入力してログインし、スタッフのホームへ
    await send('Network.clearBrowserCookies')
    await send('Page.navigate', { url: `${BASE}/login` })
    await until(`!!document.getElementById('login-form')`)
    const loginTitle = await ev('document.title')
    const loginH1 = await ev(`document.querySelector('header h1')?.innerText || ''`)
    ok('画面: ログイン画面のタイトルと見出しが Mobital', loginTitle === 'ログイン | Mobital' && loginH1 === 'Mobital', { loginTitle, loginH1 })
    await ev(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')) }; set('company_code', 'sample'); set('user_code', 'st011'); set('password', 'pass1234'); document.getElementById('login-btn').click() })()`)
    await until(`location.pathname === '/staff' || location.pathname === '/change-password'`, 15000)
    await until(`document.readyState === 'complete'`)
    await wait(1200)
    const path = await ev('location.pathname')
    const staffTitle = await ev('document.title')
    const header = await ev(`document.body.innerText.slice(0, 400)`)
    ok('画面: ログイン画面からログインすると、スタッフのホームのタイトルが Mobital', path === '/staff' && staffTitle === 'スタッフ | Mobital', { path, staffTitle })
    ok('画面: スタッフのホームに「Field OS」が出ない', !/Field OS/.test(String(await ev('document.body.innerText'))), header)
    ok('画面: ログイン・スタッフのホームで JavaScript のエラーが出ない', errors.length === 0, errors.slice(0, 3))
  } finally {
    try { ws && ws.close() } catch { }
    chrome.kill()
    await wait(500)
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:\n' + failed.map(f => '  - ' + f.name).join('\n')); process.exit(1) }
