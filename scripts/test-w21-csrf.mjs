// w21-csrf（#9943）の統合テスト: 別のサイトからの /api/* の書き込みを拒否する（src/lib/csrf.ts）
//   - GET・HEAD・OPTIONS 以外は、Origin（なければ Referer）が自分のサイト（リクエストのホスト・APP_BASE_URL）のときだけ通す。違えば 403（code: csrf_origin）
//   - Origin も Referer も無いときは、セッションの Cookie を付けたものだけ拒否する（curl などからのログインは通す）
//   - 外すもの: /api/public/*（報告用URL・公開の募集・お知らせメールの確認。トークンで入る）、/webhooks/resend（/api の外。署名で確かめる）。
//     外すものの一覧は src から洗い出して、このテストの EXEMPT_WRITE_ROUTES と同じかを確かめる（公開の書き込みの API を足したら、両方を直す）
//   - 画面（ヘッドレスの Chrome）: ログイン画面からのログイン（管理者・スタッフ・本部）と、管理画面・スタッフアプリ・本部の保存の操作がエラーにならない。
//     Chrome が無いときは画面の確認を省く（CHROME=<chrome.exe のパス> で指定できる）
// このテストは Origin を自分で付ける（scripts/fetch-origin.mjs の有無によらず同じに動く）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8711 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8711 node scripts/test-w21-csrf.mjs
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8711'
const SELF = new URL(BASE).origin
const APP_BASE = new URL(process.env.APP_BASE_URL || 'http://localhost:8787').origin // wrangler.jsonc の vars（ローカルの既定）
const EVIL = 'https://evil.example.com'
const rawFetch = globalThis.__rawFetch || globalThis.fetch // Origin を自分で決めて送る（scripts/fetch-origin.mjs で付けさせない）
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

// opts.origin を null にすると Origin を付けない（既定は自分のサイト）。opts.referer は渡したときだけ付ける
async function req(method, path, { cookie, origin = SELF, referer, body, contentType = 'application/json', extra = {} } = {}) {
  const headers = { ...extra }
  if (contentType) headers['Content-Type'] = contentType
  if (cookie) headers.Cookie = cookie
  if (origin !== null) headers.Origin = origin
  if (referer !== undefined) headers.Referer = referer
  const init = { method, headers, redirect: 'manual', body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }
  let r
  try { r = await rawFetch(`${BASE}${path}`, init) } catch { r = await rawFetch(`${BASE}${path}`, init) }
  const text = method === 'HEAD' ? '' : await r.text()
  let data = null; try { data = JSON.parse(text) } catch { }
  return { status: r.status, data, text, setCookie: r.headers.get('set-cookie') || '' }
}
const isCsrf = (r) => r.status === 403 && r.data?.code === 'csrf_origin'
const LOGIN = (company_code, user_code, password = 'pass1234') => ({ company_code, user_code, password })
async function login(company_code, user_code, opts = {}) {
  const r = await req('POST', '/api/auth/login', { ...opts, body: LOGIN(company_code, user_code) })
  return { ...r, cookie: r.setCookie.split(';')[0] }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const SUF = String(Date.now()).slice(-6)

// ---------- 1. ログイン（Cookie が要らないので、ログイン CSRF を送り元で止める） ----------
{
  const a = await login('sample', 'admin', { origin: EVIL })
  ok('ログイン: 別のサイトの Origin からは 403（csrf_origin）で、セッションを作らない', isCsrf(a) && !/session=/.test(a.setCookie), { status: a.status, data: a.data })
  ok('ログイン: 403 の文言は日本語で、画面を開き直すよう案内する', /別のサイトからの操作/.test(a.data?.error || ''), a.data)
  const n = await login('sample', 'admin', { origin: 'null' })
  ok('ログイン: Origin が null（送り元を隠したフォーム）も 403', isCsrf(n), { status: n.status })
  const nx = await login('sample', 'admin', { origin: 'null', extra: { 'Sec-Fetch-Site': 'cross-site' } })
  const ns = await login('sample', 'admin', { origin: 'null', extra: { 'Sec-Fetch-Site': 'same-origin' } })
  ok('ログイン: Origin が null でも、Sec-Fetch-Site が same-origin（no-referrer の自分の画面）なら通り、cross-site なら 403', isCsrf(nx) && ns.status === 200, { cross: nx.status, same: ns.status })
  const port = new URL(BASE); port.port = String(Number(port.port || 80) + 1)
  const p = await login('sample', 'admin', { origin: port.origin })
  ok('ログイン: 同じホストでもポートが違えば 403', isCsrf(p), { status: p.status, origin: port.origin })
  // プロトコルの違い（http と https）は本番でだけ確かめられる（wrangler dev は自分の URL を指す Origin を https に書き換えて Worker に渡すため）
  const look = await login('sample', 'admin', { origin: `http://${new URL(BASE).hostname}.evil.example.com:${new URL(BASE).port || 80}` })
  ok('ログイン: ホスト名が前方で一致するだけの別のサイトは 403', isCsrf(look), { status: look.status })
  const refEvil = await login('sample', 'admin', { origin: null, referer: `${EVIL}/attack.html` })
  ok('ログイン: Origin が無く、Referer が別のサイトなら 403', isCsrf(refEvil), { status: refEvil.status })
  const refSelf = await login('sample', 'admin', { origin: null, referer: `${SELF}/login` })
  ok('ログイン: Origin が無く、Referer が自分のサイトなら通る', refSelf.status === 200 && !!refSelf.cookie, { status: refSelf.status })
  const none = await login('sample', 'admin', { origin: null })
  ok('ログイン: Origin も Referer も無い（curl・アプリ）で Cookie も無いときは通る', none.status === 200 && !!none.cookie, { status: none.status })
  const base = await login('sample', 'admin', { origin: APP_BASE })
  ok(`ログイン: APP_BASE_URL（${APP_BASE}）の Origin は、リクエストのホストと違っても通る`, base.status === 200 && !!base.cookie, { status: base.status })
  const self = await login('sample', 'admin')
  ok('ログイン: 自分のサイトの Origin からは今までどおりログインできる', self.status === 200 && !!self.cookie, { status: self.status })
}

const admin = (await login('sample', 'admin')).cookie
const staff = (await login('sample', 'st001')).cookie
const hq = (await login('sample', 'hq')).cookie

// ---------- 2. ログインした後の書き込み（POST・PUT・DELETE） ----------
const projects = async () => must(await req('GET', '/api/admin/projects', { cookie: admin }), 'projects').projects || []
{
  const name = `W21CSRF-${SUF}`
  const evilPost = await req('POST', '/api/admin/projects', { cookie: admin, origin: EVIL, body: { project_name: name } })
  ok('POST: 別のサイトの Origin からの案件の登録は 403', isCsrf(evilPost), { status: evilPost.status, data: evilPost.data })
  ok('POST: 403 のときは登録されていない', !(await projects()).some(p => p.project_name === name))
  const plain = await req('POST', '/api/admin/projects', { cookie: admin, origin: EVIL, contentType: 'text/plain', body: JSON.stringify({ project_name: name }) })
  ok('POST: 別のサイトのフォーム（text/plain で JSON を送る）も 403', isCsrf(plain), { status: plain.status })
  const noHdr = await req('POST', '/api/admin/projects', { cookie: admin, origin: null, body: { project_name: name } })
  ok('POST: セッションの Cookie を付けて、Origin も Referer も無いものは 403', isCsrf(noHdr), { status: noHdr.status })
  ok('POST: （その 403 のときも）登録されていない', !(await projects()).some(p => p.project_name === name))
  const refSelf = await req('POST', '/api/admin/projects', { cookie: admin, origin: null, referer: `${SELF}/admin#projects`, body: { project_name: name + '-ref' } })
  ok('POST: Origin が無く Referer が自分のサイトなら通る', refSelf.status === 200, { status: refSelf.status, data: refSelf.data })
  const selfPost = await req('POST', '/api/admin/projects', { cookie: admin, body: { project_name: name } })
  ok('POST: 自分のサイトの Origin からは登録できる', selfPost.status === 200, { status: selfPost.status, data: selfPost.data })
  const pj = (await projects()).find(p => p.project_name === name)
  ok('POST: 登録した案件が一覧にある', !!pj)
  if (pj) {
    const id = pj.project_id
    const evilPut = await req('PUT', `/api/admin/projects/${id}`, { cookie: admin, origin: EVIL, body: { project_name: name + '-evil' } })
    ok('PUT: 別のサイトの Origin からの案件の変更は 403', isCsrf(evilPut), { status: evilPut.status })
    ok('PUT: 403 のときは変わっていない', (await projects()).find(p => p.project_id === id)?.project_name === name)
    const selfPut = await req('PUT', `/api/admin/projects/${id}`, { cookie: admin, body: { project_name: name + '-2' } })
    ok('PUT: 自分のサイトの Origin からは変更できる', selfPut.status === 200 && (await projects()).find(p => p.project_id === id)?.project_name === name + '-2', { status: selfPut.status, data: selfPut.data })
    const evilDel = await req('DELETE', `/api/admin/projects/${id}`, { cookie: admin, origin: EVIL })
    ok('DELETE: 別のサイトの Origin からの削除は 403', isCsrf(evilDel), { status: evilDel.status })
    ok('DELETE: 403 のときは消えていない', (await projects()).some(p => p.project_id === id))
    const selfDel = await req('DELETE', `/api/admin/projects/${id}`, { cookie: admin })
    ok('DELETE: 自分のサイトの Origin からは削除できる', selfDel.status === 200 && !(await projects()).some(p => p.project_id === id), { status: selfDel.status, data: selfDel.data })
  }
  const refPj = (await projects()).find(p => p.project_name === name + '-ref')
  if (refPj) await req('DELETE', `/api/admin/projects/${refPj.project_id}`, { cookie: admin })

  const get = await req('GET', '/api/admin/projects', { cookie: admin, origin: EVIL, contentType: null })
  ok('GET: 読み取りは Origin によらず今までどおり（別のサイトの Origin でも 200）', get.status === 200, { status: get.status })
  const head = await req('HEAD', '/api/auth/me', { cookie: admin, origin: EVIL, contentType: null })
  const opt = await req('OPTIONS', '/api/admin/projects', { cookie: admin, origin: EVIL, contentType: null })
  ok('HEAD・OPTIONS: 対象にしない（csrf_origin の 403 にならない）', head.status !== 403 && !isCsrf(opt), { head: head.status, opt: opt.status })

  const out = await req('POST', '/api/auth/logout', { cookie: admin, origin: EVIL })
  ok('ログアウト: 別のサイトからは 403 で、セッションは残る', isCsrf(out) && (await req('GET', '/api/auth/me', { cookie: admin })).status === 200, { status: out.status })
}
// スタッフアプリ・本部の書き込みも同じ
{
  const e = await req('POST', '/api/staff/notifications/read-all', { cookie: staff, origin: EVIL })
  const s = await req('POST', '/api/staff/notifications/read-all', { cookie: staff })
  ok('スタッフ: 別のサイトからの書き込み（通知をすべて既読）は 403、自分のサイトからは 200', isCsrf(e) && s.status === 200, { evil: e.status, self: s.status, data: s.data })
  const body = `w21-csrf のテスト ${SUF}`
  const he = await req('POST', '/api/hq/companies/1/support-logs', { cookie: hq, origin: EVIL, body: { body: body + '-evil' } })
  const hs = await req('POST', '/api/hq/companies/1/support-logs', { cookie: hq, body: { body } })
  ok('本部: 別のサイトからの書き込み（支援の記録）は 403、自分のサイトからは 200', isCsrf(he) && hs.status === 200, { evil: he.status, self: hs.status, data: hs.data })
}

// ---------- 3. 対象から外すもの ----------
// src を grep して洗い出した、/api/public/* の書き込み（GET 以外）の API。src/lib/csrf.ts のコメントと同じ一覧
const EXEMPT_WRITE_ROUTES = [
  'POST /api/public/notice-ack',
  'POST /api/public/recruit/:token/apply',
  'POST /api/public/report/:token/attendance',
  'POST /api/public/report/:token/consultation',
  'POST /api/public/report/:token/daily-report',
]
{
  const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8')
  const files = readdirSync(join(ROOT, 'src')).filter(f => /\.tsx?$/.test(f))
  const all = files.map(f => src(f)).join('\n')
  const api = src('api.ts')
  const found = []
  // api.route('/public/xxx', 変数) でつないだ API の書き込み
  for (const m of api.matchAll(/api\.route\('(\/public\/[^']*)',\s*(\w+)\)/g)) {
    for (const r of all.matchAll(new RegExp(`\\b${m[2]}\\.(post|put|delete|patch|all)\\('([^']*)'`, 'g'))) found.push(`${r[1].toUpperCase()} /api${m[1]}${r[2] === '/' ? '' : r[2]}`)
  }
  // api.post('/public/…') のように直接書いたもの
  for (const r of api.matchAll(/api\.(post|put|delete|patch|all)\('(\/public\/[^']*)'/g)) found.push(`${r[1].toUpperCase()} /api${r[2]}`)
  found.sort()
  ok('外すもの: /api/public/* の書き込みの API は EXEMPT_WRITE_ROUTES の5本（増えたら src/lib/csrf.ts のコメントとこの一覧を直す）', JSON.stringify(found) === JSON.stringify(EXEMPT_WRITE_ROUTES), found)
  const csrfSrc = src('lib/csrf.ts')
  ok('外すもの: src/lib/csrf.ts のコメントに同じ一覧がある', EXEMPT_WRITE_ROUTES.every(r => csrfSrc.includes(r)), EXEMPT_WRITE_ROUTES.filter(r => !csrfSrc.includes(r)))
  ok('外すもの: 対象から外す前方一致は /api/public/ だけ', /CSRF_EXEMPT_PREFIXES = \['\/api\/public\/'\]/.test(csrfSrc))
  // /api の外の書き込みは Webhook だけ（署名で確かめる）
  const outside = [...src('index.tsx').matchAll(/app\.(post|put|delete|patch|all)\('([^']*)'/g)].map(r => `${r[1].toUpperCase()} ${r[2]}`)
  ok('外すもの: /api の外の書き込みは POST /webhooks/resend だけ', JSON.stringify(outside) === JSON.stringify(['POST /webhooks/resend']), outside)
  const wired = src('index.tsx')
  ok('ミドルウェア: /api/* に csrfGuard をかけ、api のルートより前に登録している', wired.indexOf("app.use('/api/*', csrfGuard)") > 0 && wired.indexOf("app.use('/api/*', csrfGuard)") < wired.indexOf("app.route('/api', api)"))
}
{
  // 別のサイトの Origin（とスタッフのセッションの Cookie）を付けても、csrf_origin では止めない（トークンが無効なので 4xx になる）
  const bad = 'x'.repeat(32)
  const cases = [
    ['POST', '/api/public/notice-ack', { token: bad }],
    ['POST', `/api/public/recruit/${bad}/apply`, { name: 'テスト' }],
    ['POST', `/api/public/report/${bad}/attendance`, { report_type: 'work_start' }],
    ['POST', `/api/public/report/${bad}/consultation`, { body: 'テスト' }],
    ['POST', `/api/public/report/${bad}/daily-report`, { body: 'テスト' }],
  ]
  const got = []
  for (const [m, p, b] of cases) { const r = await req(m, p, { cookie: staff, origin: EVIL, body: b }); got.push({ p, status: r.status, code: r.data?.code ?? null }) }
  ok('外すもの: 公開の API（報告用URL・募集の応募・お知らせの確認）は、別のサイトの Origin でも csrf_origin で止めない', got.every(g => g.code !== 'csrf_origin' && g.status !== 500), got)
  const wh = await req('POST', '/webhooks/resend', { origin: EVIL, body: { type: 'email.delivered' } })
  ok('外すもの: Webhook（/webhooks/resend）は対象外（署名がないので 401 か、秘密の値が未設定の 503）', [401, 503].includes(wh.status) && wh.data?.code !== 'csrf_origin', { status: wh.status, data: wh.data })
}

// ---------- 4. 画面（ヘッドレスの Chrome）: 画面からのログインと保存がエラーにならない ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()  // 空いているポート（#9980）
  const prof = mkdtempSync(join(tmpdir(), 'w21c-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1366,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await rawFetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []; const writes = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const reqMap = new Map()
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
      if (m.method === 'Network.requestWillBeSent') {
        const u = new URL(m.params.request.url)
        if (u.origin === SELF && u.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(m.params.request.method)) reqMap.set(m.params.requestId, { method: m.params.request.method, path: u.pathname, origin: m.params.request.headers.Origin ?? null })
      }
      if (m.method === 'Network.responseReceived' && reqMap.has(m.params.requestId)) writes.push({ ...reqMap.get(m.params.requestId), status: m.params.response.status })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const toastHas = (text) => `[...document.querySelectorAll('#toast .toast-msg')].some(t => t.textContent.includes(${JSON.stringify(text)}))`

    // ログイン画面から入る（ボタンを押す）。company_code が空のときは本部
    const uiLogin = async (who, company, user, home) => {
      await send('Network.clearBrowserCookies')
      await send('Page.navigate', { url: `${BASE}/login` })
      await until(`!!document.getElementById('login-btn')`)
      await ev(`(() => { const s = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
        s('company_code', ${JSON.stringify(company)}); s('user_code', ${JSON.stringify(user)}); s('password', 'pass1234'); document.getElementById('login-btn').click(); return true })()`)
      const okNav = await until(`location.pathname === ${JSON.stringify(home)}`, 20000)
      await wait(1500) // ネットワークの記録（CDP）は画面の処理より遅れて届くことがある
      const w = writes.splice(0)
      ok(`画面: ${who}がログイン画面からログインできる（POST /api/auth/login が 200）`, okNav && w.some(x => x.path === '/api/auth/login' && x.status === 200), { path: await ev('location.pathname'), w })
      return okNav
    }

    // 管理画面: 通知の受け取り設定を保存する
    if (await uiLogin('管理者', 'sample', 'admin', '/admin')) {
      await until(`typeof ME !== 'undefined' && !!ME`, 30000)
      await ev(`location.hash = 'notifications'; true`)
      await until(`!!document.querySelector('[data-action="notifTab"][data-tab="prefs"]')`)
      await ev(`document.querySelector('[data-action="notifTab"][data-tab="prefs"]').click(); true`)
      await until(`!!document.querySelector('[data-action="notifyPrefsSave"]')`)
      writes.splice(0)
      await ev(`document.querySelector('[data-action="notifyPrefsSave"]').click(); true`)
      const saved = await until(toastHas('保存しました'))
      await wait(1500) // ネットワークの記録（CDP）は画面の処理より遅れて届くことがある
      const w = writes.splice(0)
      ok('画面: 管理画面の保存（通知の受け取り設定）が「保存しました」になり、PUT が 200', saved && w.some(x => x.method === 'PUT' && x.path === '/api/admin/notification-prefs' && x.status === 200), w)
    }
    // スタッフアプリ: 通知の設定を保存する
    if (await uiLogin('スタッフ', 'sample', 'st001', '/staff')) {
      await until(`typeof routes === 'object' && !!routes['notify-settings']`, 30000)
      await ev(`location.hash = 'notify-settings'; true`)
      await until(`!!document.querySelector('[data-action="notifyPrefsSave"]')`)
      writes.splice(0)
      await ev(`document.querySelector('[data-action="notifyPrefsSave"]').click(); true`)
      const saved = await until(toastHas('保存しました'))
      await wait(1500) // ネットワークの記録（CDP）は画面の処理より遅れて届くことがある
      const w = writes.splice(0)
      ok('画面: スタッフアプリの保存（通知の設定）が「保存しました」になり、PUT が 200', saved && w.some(x => x.method === 'PUT' && x.path === '/api/staff/notification-prefs' && x.status === 200), w)
    }
    // 本部: 企業の詳細で支援の記録を追加する
    if (await uiLogin('本部', '', 'hq', '/hq')) {
      await until(`typeof renderCompanyDetail === 'function'`, 30000)
      await wait(1500)
      await ev(`renderCompanyDetail(1); true`)
      await until(`!!document.getElementById('sl-body') && !!document.querySelector('[data-action="hqAddSupportLog"]')`)
      writes.splice(0)
      await ev(`document.getElementById('sl-body').value = '画面からの記録（w21-csrf）'; document.querySelector('[data-action="hqAddSupportLog"]').click(); true`)
      const saved = await until(toastHas('記録しました'))
      await wait(1500) // ネットワークの記録（CDP）は画面の処理より遅れて届くことがある
      const w = writes.splice(0)
      ok('画面: 本部の保存（支援の記録）が「記録しました」になり、POST が 200', saved && w.some(x => x.method === 'POST' && /\/api\/hq\/companies\/1\/support-logs$/.test(x.path) && x.status === 200), w)
      // ログアウト（書き込み）も画面から通る
      await ev(`axios.post('/api/auth/logout').then(() => true)`)
      await wait(1500)
      const lo = writes.splice(0)
      ok('画面: ログアウト（POST /api/auth/logout）も通る', lo.some(x => x.path === '/api/auth/logout' && x.status === 200), lo)
    }
    // トークンを URL に持つ画面（パスワード再設定・メールアドレスの確認）からの送信も通る（Referrer-Policy は strict-origin。Referer にトークンを載せず、Origin は付く。
    // no-referrer だと Origin が null になり、Sec-Fetch-Site を送らない古い Safari では 403 になるため）。
    // トークンは無効なので 400 などになるが、csrf_origin の 403 にはならない
    for (const [path, api, body] of [['/reset-password?token=' + 'y'.repeat(40), '/api/auth/reset-password', `{ token: '${'y'.repeat(40)}', password: 'Abcdefgh-2026' }`],
      ['/verify-email?token=' + 'y'.repeat(40), '/api/auth/verify-email', `{ token: '${'y'.repeat(40)}' }`]]) {
      await send('Page.navigate', { url: `${BASE}${path}` })
      await until(`typeof axios === 'function' && document.readyState === 'complete'`)
      await wait(800)
      const r = await ev(`axios.post('${api}', ${body}).then(x => ({ status: x.status, code: null }), e => ({ status: e.response ? e.response.status : 0, code: e.response && e.response.data ? e.response.data.code || null : null }))`)
      ok(`画面: トークンを URL に持つ画面（${path.split('?')[0]}）からの送信は csrf_origin で止めない`, r && r.status !== 0 && r.code !== 'csrf_origin', r)
      const rp = await ev(`[...document.querySelectorAll('meta[name="referrer"]')].map(m => m.content).join(',')`)
      ok(`画面: ${path.split('?')[0]} の Referrer-Policy は strict-origin（トークンを Referer に載せず、Origin を null にしない）`, rp === 'strict-origin', rp)
    }
    ok('画面: スクリプトのエラーがない', errors.length === 0, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
