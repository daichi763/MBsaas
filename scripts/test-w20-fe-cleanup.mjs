// w20-fe-cleanup（総点検 Sprint 20。#9923 #9924）の統合テスト
//  #9923 画面の残骸を消す: 入口のない旧「スタッフ登録」のモーダル（showAddStaff・addStaff と delegate の addStaff・addStaffForce）、
//    呼ばれない関数（saveStaffMemo・setStaffRetiredAt・setStaffEmploymentStatus・boardFilterStaff・boardHasDrafts・__projectForPanel・loadNotifBanner）、
//    /hq の使っていない Chart.js、src/renderer.tsx と tsconfig の JSX の設定。POST /api/admin/staff はテスト・内部用として残す
//  #9924 プレビューの URL を止める（wrangler.jsonc の preview_urls: false）と、11/9 の判断を資料に残す（D-45〜D-49）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8710 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8710 node scripts/test-w20-fe-cleanup.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8710'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}

// ---------- #9923 コード: 消したもの・残すもの ----------
const adminJs = read('public/static/admin.js'), boardJs = read('public/static/shift-board.js'), attJs = read('public/static/staff-attendance.js')
const staticAll = ['admin.js', 'shift-board.js', 'staff-attendance.js', 'staff.js', 'roster.js', 'staff-lifecycle.js', 'hq.js', 'common.js'].map(f => read(`public/static/${f}`)).join('\n') + read('src/index.tsx')
const gone = ['showAddStaff', 'saveStaffMemo', 'setStaffRetiredAt', 'setStaffEmploymentStatus', 'boardFilterStaff', 'boardHasDrafts', '__projectForPanel', 'loadNotifBanner', 'addStaffForce', 'board-staff-list', 'notif-banner"']
ok('#9923 消した関数・要素の名前が画面の JS・index.tsx に残っていない', gone.every(n => !staticAll.includes(n)), gone.filter(n => staticAll.includes(n)))
ok('#9923 旧「スタッフ登録」の delegate（addStaff）と window.addStaff を消した', !/delegate\('addStaff'/.test(adminJs) && !/window\.addStaff\s*=/.test(adminJs) && !/data-action="addStaff"/.test(adminJs))
ok('#9923 新規追加は名簿の登録（showAddRoster）のまま', /onclick="showAddRoster\(\)"[^<]*<i class="fas fa-user-plus"><\/i>新規追加/.test(adminJs) && /window\.showAddRoster\s*=/.test(read('public/static/roster.js')))
ok('#9923 使っている関数は残す（saveStaffBasicInfo・retirementBody・putConfirmingRetiredAt・confirmDiscardDrafts・renderStaffNotifications）',
  /window\.saveStaffBasicInfo\s*=/.test(adminJs) && /function retirementBody\(/.test(adminJs) && /async function putConfirmingRetiredAt\(/.test(adminJs)
  && /function confirmDiscardDrafts\(/.test(boardJs) && /window\.renderStaffNotifications\s*=/.test(attJs))
ok('#9923 スタッフアプリの未読の数は、今までどおり applyBadges が #more-notif-count に出す', /set\('more-notif-count', notifs\)/.test(read('public/static/staff.js')))
const apiTs = read('src/api.ts')
ok('#9923 POST /admin/staff は残し、「テスト・内部用（画面からは呼ばない）」と書く', /\/\/ スタッフ登録（テスト・内部用。画面からは呼ばない。[^\n]*\)?\napi\.post\('\/admin\/staff', /.test(apiTs))
ok('#9923 src/renderer.tsx を消した（どこからも読まれていなかった）', !existsSync(join(ROOT, 'src/renderer.tsx')) && !/renderer/.test(read('src/index.tsx')))
const tsconfig = read('tsconfig.json')
ok('#9923 tsconfig から JSX の設定を外した（index.tsx は JSX を使わない）', !/"jsx"/.test(tsconfig) && !/jsxImportSource/.test(tsconfig) && /"types": \["vite\/client"\]/.test(tsconfig))
const idx = read('src/index.tsx')
const hqRoute = idx.slice(idx.indexOf("app.get('/hq'"), idx.indexOf('</html>', idx.indexOf("app.get('/hq'")))
ok('#9923 /hq の HTML に Chart.js の読み込みがない（管理画面は残す）', !/chart\.js/.test(hqRoute) && /cdnJs\('chart\.js@4\.5\.1\/dist\/chart\.umd\.min\.js'\)/.test(idx))
ok('#9923 本部画面の JS（hq.js・security.js）は Chart を使っていない', !/new Chart\b|\bChart\./.test(read('public/static/hq.js') + read('public/static/security.js')))

// ---------- #9924 プレビューの URL ----------
// JSONC のコメントと末尾のカンマを取り除く（scripts/ci-wrangler-config.mjs と同じ考え方。文字列の中の // は残す）
const stripJsonc = (src) => {
  let out = '', inStr = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], next = src[i + 1]
    if (inStr) { out += ch; if (ch === '\\') { out += next; i++ } else if (ch === '"') inStr = false }
    else if (ch === '"') { inStr = true; out += ch }
    else if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n' }
    else if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++ }
    else out += ch
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
const wr = JSON.parse(stripJsonc(read('wrangler.jsonc')))
ok('#9924 wrangler.jsonc のトップレベルと env.production の両方で preview_urls: false', wr.preview_urls === false && wr.env.production.preview_urls === false, { top: wr.preview_urls, prod: wr.env.production.preview_urls })
ok('#9924 本番の workers.dev の URL は止めない（workers_dev を false にしない）', wr.workers_dev !== false && wr.env.production.workers_dev !== false && wr.env.production.vars.APP_BASE_URL === 'https://mbsaas.saas-2a2.workers.dev')
// CI（Workers Builds）で作る wrangler.json にも残るか。repo の外の一時フォルダで、本物のスクリプトを動かす
{
  const dir = mkdtempSync(join(tmpdir(), 'w20fe-ci-'))
  try {
    copyFileSync(join(ROOT, 'wrangler.jsonc'), join(dir, 'wrangler.jsonc'))
    const env = { ...process.env, WORKERS_CI: '1' }
    execFileSync(process.execPath, [join(ROOT, 'scripts/ci-wrangler-config.mjs')], { cwd: dir, env, stdio: 'pipe' })
    const out = JSON.parse(readFileSync(join(dir, 'wrangler.json'), 'utf8'))
    ok('#9924 CI で作る wrangler.json にも preview_urls: false が残る（本番の設定で作る）', out.preview_urls === false && out.env.production.preview_urls === false && out.vars.DEMO_MODE === 'false', { p: out.preview_urls, demo: out.vars.DEMO_MODE })
    // 設定が落ちたときは本番のビルドを止める
    writeFileSync(join(dir, 'wrangler.jsonc'), read('wrangler.jsonc').replace(/"preview_urls": false,/g, ''))
    rmSync(join(dir, 'wrangler.json'), { force: true })
    let failed = false
    try { execFileSync(process.execPath, [join(ROOT, 'scripts/ci-wrangler-config.mjs')], { cwd: dir, env, stdio: 'pipe' }) } catch (e) { failed = /preview_urls/.test(String(e.stderr)) }
    ok('#9924 preview_urls が落ちていたら、CI の設定作りが失敗して wrangler.json を作らない', failed && !existsSync(join(dir, 'wrangler.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------- #9924 資料 ----------
const dec = read('docs/decisions.md'), ops = read('docs/operations.md'), bk = read('docs/backup.md'), spec = read('docs/spec_multi_company_staff.md')
const D = ['D-45', 'D-46', 'D-47', 'D-48', 'D-49']
ok('#9924 decisions.md に 11/9 の判断（D-45〜D-49）を一覧と本文の両方に書く', D.every(d => new RegExp(`\\| ${d} \\| 2026-11-09 \\|`).test(dec) && new RegExp(`### ${d} `).test(dec)), D.filter(d => !new RegExp(`### ${d} `).test(dec)))
const sec = (d) => { const i = dec.indexOf(`### ${d} `); return dec.slice(i, dec.indexOf('\n### ', i + 5)) }
ok('#9924 D-45 募集は再開しない・D-46 提出は止める・D-47 契約ユーザー数・D-48 R2・D-49 プレビュー',
  /再開しない/.test(sec('D-45')) && /STAFF_APP_RECRUIT/.test(sec('D-45')) && /受け付けは終了しました/.test(sec('D-46')) && /staff_availability/.test(sec('D-46'))
  && /契約ユーザー数/.test(sec('D-47')) && /merges/.test(sec('D-47')) && /consents/.test(sec('D-47')) && /対象にしない/.test(sec('D-48'))
  && /preview_urls/.test(sec('D-49')) && /mbsaas\.pages\.dev/.test(sec('D-49')) && /存在しない/.test(sec('D-49')))
ok('#9924 D-22・D-23 は消さずに「変更」を書き足す', /### D-22 [\s\S]*?\*\*変更\*\*: [^\n]*D-45/.test(dec) && /### D-23 [\s\S]*?\*\*変更\*\*: [^\n]*D-46/.test(dec))
ok('#9924 operations.md: プレビューの URL は使わない（本番の D1・R2 につながる）・main 以外のブランチのビルドの止め方', /### 3\.4 プレビューの URL は使わない/.test(ops) && /本番の D1・R2 につながります/.test(ops) && /Builds for non-production branches/.test(ops))
ok('#9924 operations.md・backup.md: R2 のファイルはバックアップの対象外', /バックアップの対象外/.test(ops) && /### バックアップの対象（R2 のファイルは対象外）/.test(bk) && /D-48/.test(bk))
ok('#9924 spec_multi_company_staff.md の Pages の記述は古いと注記する', /\*\*注（2026-11-09 追記）\*\*: この指示書の Cloudflare Pages・`mbsaas\.pages\.dev` の記述/.test(spec) && /本番環境（注: 古い記述/.test(spec))

// ---------- API ----------
const admin = client(await login('sample', 'admin'))
const hqCookie = await login('', 'hq')
const staffCookie = await login('sample', 'st001')
const page = async (path, cookie) => { const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' }); return { status: r.status, text: await r.text() } }
const hqPage = await page('/hq', hqCookie), staffPage = await page('/staff', staffCookie)
ok('#9923 /hq は開け、Chart.js を読み込まない', hqPage.status === 200 && /hq\.js/.test(hqPage.text) && !/chart\.js/.test(hqPage.text), hqPage.status)
const adminCk = await login('sample', 'admin')
const adminHtml = await page('/admin', adminCk)
ok('#9923 管理画面は今までどおり Chart.js を読み込む（実績分析・評価のグラフ）', adminHtml.status === 200 && /chart\.js@4\.5\.1\/dist\/chart\.umd\.min\.js/.test(adminHtml.text) && /\/static\/admin\.js/.test(adminHtml.text))
ok('#9923 スタッフアプリは開ける', staffPage.status === 200 && /\/static\/staff-attendance\.js/.test(staffPage.text))
for (const f of ['admin.js', 'shift-board.js', 'staff-attendance.js']) {
  const r = await fetch(`${BASE}/static/${f}`)
  const t = await r.text()
  ok(`#9923 配信している /static/${f} にも消した関数がない`, r.status === 200 && gone.every(n => !t.includes(n)), gone.filter(n => t.includes(n)))
}
// テスト・内部用の POST /api/admin/staff は今までどおり動く（多くのテストのデータ作りに使う）
const code = `w20fe${Date.now() % 100000}`
const created = await admin.post('/api/admin/staff', { user_code: code, name: 'W20 確認', password: 'w20pass1234', force: true })
const listed = await admin.get('/api/admin/staff')
const sid = Number(((listed.data && listed.data.staff) || []).find(s => s.user_code === code)?.staff_id)
ok('#9923 POST /api/admin/staff（テスト・内部用）はそのまま使える', created.status === 200 && created.data && created.data.ok === true && sid > 0, { status: created.status, data: created.data, sid })
// 消した saveStaffMemo の代わり: メモは saveStaffBasicInfo と同じ PUT で保存する
const memo = await admin.put(`/api/admin/staff/${sid}`, { memo: 'w20 のメモ' })
const detail = await admin.get(`/api/admin/staff/${sid}`)
const memoOf = d => d && (d.memo ?? (d.staff && d.staff.memo) ?? (d.profile && d.profile.memo))
ok('#9923 スタッフのメモは PUT /api/admin/staff/:id で今までどおり保存できる', memo.status === 200 && detail.status === 200 && memoOf(detail.data) === 'w20 のメモ', { memo: memo.status, got: memoOf(detail.data) })
const staffApi = client(staffCookie)
const unread = await staffApi.get('/api/staff/notifications/unread-count')
ok('#9923 スタッフの通知の未読の数の API は残る（loadNotifBanner を消しただけ）', unread.status === 200 && typeof unread.data.count === 'number', unread.status)

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w20fe-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = list && list.find(t => t.type === 'page')
    if (!pg) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: false })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w20-fe-cleanup-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    // ----- 管理画面 -----
    await client(adminCk).put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup'].map(key => ({ key, status: 'skipped', step: 0 })) })
    await as(adminCk)
    await send('Page.navigate', { url: `${BASE}/admin#dashboard` })
    await until(`typeof delegate === 'function' && !!document.getElementById('app') && document.getElementById('app').innerText.length > 20`, 40000)
    const screens = [['dashboard', 'dashboard'], ['staff', 'staff'], [`staff/${sid}`, 'staff-detail'], ['shifts', 'shifts'], ['projects', 'projects'], ['clients', 'clients'], ['analytics', 'analytics'], ['settlement', 'settlement'], ['recruit', 'recruit'], ['account', 'account']]
    const drawn = []
    for (const [hash, name] of screens) {
      await ev(`location.hash = ${JSON.stringify(hash)}`)
      await wait(400)
      const okDraw = await until(`!document.querySelector('#app .fa-spinner') && document.getElementById('app').innerText.trim().length > 10`, 15000)
      // 画面の中の後から読む部分（募集の応募の一覧など）が描き終わるのを待ってから次へ移る。
      // 読み込み中に画面を移ると、recruit.js の renderApplications が消えた要素を探してエラーになる（この Sprint の変更とは別の、前からの動き）
      await wait(1500)
      drawn.push({ hash, okDraw })
      if (name === 'staff' || name === 'staff-detail' || name === 'shifts') await shot(name)
    }
    ok('画面: 管理画面の主な画面が描ける', drawn.every(d => d.okDraw), drawn.filter(d => !d.okDraw))
    const fns = await ev(`({ add: typeof window.showAddStaff, addS: typeof window.addStaff, memo: typeof window.saveStaffMemo, ret: typeof window.setStaffRetiredAt, emp: typeof window.setStaffEmploymentStatus,
      filt: typeof window.boardFilterStaff, drafts: typeof window.boardHasDrafts, roster: typeof window.showAddRoster, basic: typeof window.saveStaffBasicInfo,
      dg: !!(delegate.handlers && (delegate.handlers.addStaff || delegate.handlers.addStaffForce)) })`)
    ok('画面: 消した関数は window にない・名簿の登録とスタッフの保存は残る', fns.add === 'undefined' && fns.addS === 'undefined' && fns.memo === 'undefined' && fns.ret === 'undefined' && fns.emp === 'undefined'
      && fns.filt === 'undefined' && fns.drafts === 'undefined' && fns.roster === 'function' && fns.basic === 'function' && fns.dg === false, fns)
    // スタッフマスタの「新規追加」は名簿の登録のモーダルを開く（今までどおり）
    await ev(`location.hash = 'staff'`)
    await until(`!![...document.querySelectorAll('#app button')].find(b => /新規追加/.test(b.textContent))`, 15000)
    await ev(`[...document.querySelectorAll('#app button')].find(b => /新規追加/.test(b.textContent)).click()`)
    const opened = await until(`!!document.querySelector('#modal-root .modal-box')`, 5000)
    ok('画面: スタッフマスタの「新規追加」は今までどおりモーダルを開く', opened && !(await ev(`/スタッフ登録/.test((document.querySelector('#modal-root h3') || {}).textContent || '') && !!document.getElementById('ns-code')`)))
    await shot('staff-add')
    await ev(`typeof closeModal === 'function' && closeModal()`)
    ok('画面: 管理画面でスクリプトのエラーがない', errors.length === 0, errors)

    // ----- 本部画面 -----
    errors = []
    await as(hqCookie)
    await send('Page.navigate', { url: `${BASE}/hq#companies` })
    const hqDrawn = await until(`!!document.querySelector('.hq-nav') && !!document.getElementById('app') && document.getElementById('app').innerText.trim().length > 10`, 30000)
    const hqTabs = []
    for (const tab of ['companies', 'templates', 'retention', 'support', 'announcements', 'security', 'errors']) {
      await ev(`location.hash = ${JSON.stringify(tab)}`)
      await wait(400)
      hqTabs.push({ tab, ok: await until(`!document.querySelector('#app .fa-spinner') && document.getElementById('app').innerText.trim().length > 10`, 15000) })
    }
    await shot('hq')
    ok('画面: /hq の主な画面が描ける（Chart.js なし）', hqDrawn && hqTabs.every(t => t.ok) && await ev(`typeof window.Chart === 'undefined'`), hqTabs.filter(t => !t.ok))
    ok('画面: /hq でスクリプトのエラーがない', errors.length === 0, errors)

    // ----- スタッフアプリ -----
    errors = []
    await client(staffCookie).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] })
    await as(staffCookie)
    await send('Page.navigate', { url: `${BASE}/staff#home` })
    const stDrawn = []
    await until(`!!document.getElementById('app') && document.getElementById('app').innerText.trim().length > 10`, 30000)
    for (const h of ['home', 'shift', 'attendance', 'report', 'more', 'notifications']) {
      await ev(`location.hash = ${JSON.stringify(h)}`)
      await wait(400)
      stDrawn.push({ h, ok: await until(`!document.querySelector('#app .fa-spinner') && document.getElementById('app').innerText.trim().length > 10`, 15000) })
    }
    await shot('staff-more')
    ok('画面: スタッフアプリの主な画面が描ける', stDrawn.every(d => d.ok), stDrawn.filter(d => !d.ok))
    ok('画面: スタッフアプリに loadNotifBanner はない・通知の一覧は残る', await ev(`typeof window.loadNotifBanner === 'undefined' && typeof window.renderStaffNotifications === 'function'`))
    ok('画面: スタッフアプリでスクリプトのエラーがない', errors.length === 0, errors)
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
