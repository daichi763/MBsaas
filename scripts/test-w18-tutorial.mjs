// 初回のチュートリアルで「はじめにやること」の5つを作成までさせる（Sprint 18・w18-tutorial #9915）の統合テスト
//   - GET /api/admin/tours/checklist の setup（初回の案内で使う各項目の済み。logins はログインの発行で済み）
//   - 会社管理者の初回: クライアント → 案件 → スタッフ → シフト → ログインの発行 を、実際の画面で作るところまで案内する
//     （済むまで「次へ」を押せない・「あとで」→ 開き直すと続きから・済んだ項目は飛ばす・前の項目で作ったものの名前を出す）
//   - 会社管理者以外は今までどおりの「主な機能の案内」。各画面の「この画面の使い方」も今までどおり
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   `npx wrangler dev --local --port 8870 --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8870 node scripts/test-w18-tutorial.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8870'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const headers = { Cookie: cookie || '' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

const PFX = 'W18T' + Date.now().toString(36).slice(-4).toUpperCase()
const NEWPW = 'Setup-pass-2026'
const hq = client(await login('', 'hq'))
const mgr = client(await login('sample', 'mgr01'))
// 新しい会社（最初の管理者は仮パスワード。変更してから使う）
async function newCompany(tag) {
  const code = ('w18' + tag + Date.now().toString(36).slice(-5)).toLowerCase()
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX} ${tag} 準備テスト`, admin_code: 'boss', admin_password: 'pass1234', admin_email: `boss-${code}@example.com`, admin_name: '最初 管理者', user_limit: '' }), 'create company ' + tag)
  const c0 = client(await login(code, 'boss'))
  must(await c0.post('/api/auth/change-password', { current_password: 'pass1234', new_password: NEWPW }), 'change pw ' + tag)
  return { code, api: client(await login(code, 'boss', NEWPW)) }
}

// ---------- API: setup（初回の案内で使う各項目の済み） ----------
const A = await newCompany('a')   // 画面で5つを作る会社
const B = await newCompany('b')   // 済んだ項目を飛ばす・ログインの発行を確かめる会社
const C = await newCompany('c')   // 進み具合の API・会社管理者以外の人を確かめる会社
const K = ['clients', 'projects', 'staff', 'shifts', 'logins']
{
  const c = must(await A.api.get('/api/admin/tours/checklist'), 'checklist A')
  ok('#9915 新しい会社の会社管理者: setup に5項目（すべて未完了）', c.setup && K.every(k => c.setup[k] === false) && Object.keys(c.setup).length === 5, c)
  ok('#9915 「はじめにやること」（items）は今までどおり', c.items && K.every(k => c.items[k] === false) && c.show === true, c)
  const m = must(await mgr.get('/api/admin/tours/checklist'), 'mgr checklist')
  ok('#9915 会社管理者以外（現場管理者）には setup を返さない（作成の案内を出さない）', m.setup === null && m.items === null && m.show === false, m)
  // 進み具合の API は別の会社で確かめる（A は画面で初回の状態から確かめるため）
  const p = await C.api.put('/api/admin/tours', { items: [{ key: 'admin-setup', status: 'in_progress', step: 2 }] })
  const g = must(await C.api.get('/api/admin/tours'), 'tours C').progress['admin-setup']
  ok('#9915 PUT で admin-setup（はじめの準備）の進み具合を残せる', p.status === 200 && g && g.status === 'in_progress' && g.step === 2, { p, g })
}
// B: クライアントと案件だけ先に作る（画面で「済んだ項目を飛ばす」を確かめる）
const B_CLIENT = `${PFX} B 顧客`, B_PROJECT = `${PFX} B 案件`
{
  const cl = must(await B.api.post('/api/admin/clients', { client_name: B_CLIENT }), 'client B')
  const pr = must(await B.api.post('/api/admin/projects', { project_name: B_PROJECT, client_id: cl.client_id }), 'project B')
  B.client = cl.client_id; B.project = pr.project_id
  const c = must(await B.api.get('/api/admin/tours/checklist'), 'checklist B')
  ok('#9915 setup は実データで済みになる（クライアント・案件を作った）', c.setup.clients && c.setup.projects && !c.setup.staff && !c.setup.shifts && !c.setup.logins, c.setup)
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') {
  console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
  await apiOnlyFlow()
} else await browserChecks()

// Chrome が無いとき: B の残り（スタッフ・シフト・ログイン）を API で作って setup を確かめる
async function apiOnlyFlow() {
  const st = await partnerStaffNoLogin(B.api, 'API')
  must(await B.api.post('/api/admin/shifts', { staff_id: st.staff_id, project_id: B.project, work_date: today, start_time: '10:00', end_time: '19:00' }), 'shift B')
  const c1 = must(await B.api.get('/api/admin/tours/checklist'), 'checklist B2')
  ok('#9915 ログインのないスタッフだけなら setup.logins は未完了', c1.setup.staff && c1.setup.shifts && !c1.setup.logins, c1.setup)
  must(await B.api.post(`/api/admin/staff/${st.staff_id}/issue-login`, { user_code: `${PFX}L`, password: 'Staff-pass-2026' }), 'issue login')
  await checkIssued(st)
}
async function partnerStaffNoLogin(api, tag) {
  const r = must(await api.post('/api/admin/roster', { route: 'partner', name: `${PFX} ${tag} 協力`, gender: 'female', new_partner_name: `${PFX} ${tag} 協力会社` }), 'partner staff')
  return { staff_id: r.staff_id }
}
// ログインを発行した（本人はまだログインしていない）→ setup.logins は済み・items.logins は未完了。本人がログインすると items.logins も済み
async function checkIssued(st, userCode = `${PFX}L`, pw = 'Staff-pass-2026') {
  const c2 = must(await B.api.get('/api/admin/tours/checklist'), 'checklist B3')
  ok('#9915 ログインを発行したら setup.logins は済み（本人のログインを待たない）。「はじめにやること」の logins は今までどおり未完了', c2.setup.logins === true && c2.items.logins === false, c2)
  await login(B.code, userCode, pw)
  const c3 = must(await B.api.get('/api/admin/tours/checklist'), 'checklist B4')
  ok('#9915 スタッフがログインすると items.logins も済み', c3.items.logins === true && c3.setup.logins === true, c3)
}

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w18t-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
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
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w18-tutorial-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const setCookie = async (ck) => {
      await send('Network.clearBrowserCookies')
      const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    }
    const ready = async () => { await wait(800); await until(`typeof FosTour !== 'undefined' && typeof ME !== 'undefined' && !!ME && !document.querySelector('#app > div > .spin') && !!document.getElementById('tour-help-bar')`, 40000); await wait(700) }
    const title = () => ev(`(document.querySelector('#tour-root .tour-title') || {}).textContent || ''`)
    const bodyText = () => ev(`(document.querySelector('#tour-root .tour-body') || {}).textContent || ''`)
    const clickAct = (act) => ev(`(() => { const b = document.querySelector('#tour-root [data-tour-act="${act}"]'); if (b && !b.disabled) b.click(); return !!b && !b.disabled })()`)
    const nextDisabled = () => ev(`(() => { const b = document.querySelector('#tour-root [data-tour-act="next"]'); return !!b && b.disabled })()`)
    const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`)
    const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    const holeOn0 = (sel) => ev(`(() => {
      const h = document.querySelector('#tour-root .tour-hole'), el = document.querySelector(${JSON.stringify(sel)})
      if (!h || h.hidden || !el) return false
      const a = h.getBoundingClientRect(), r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight
      const b = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(vw, r.right), bottom: Math.min(vh, r.bottom) }
      return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1
    })()`)
    // 吹き出しがその要素を指すまで待つ（400ms ごとに画面に合わせて描き直す）
    const holeOn = async (sel, ms = 6000) => { for (let t = 0; t < ms; t += 200) { await wait(200); if (await holeOn0(sel)) { await wait(300); if (await holeOn0(sel)) return true } } return false }
    const fits = () => ev(`(() => {
      const b = document.querySelector('#tour-root .tour-bubble'); if (!b) return { ok: false, why: 'no bubble' }
      const r = b.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight
      return { ok: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= vh + 0.5 && document.documentElement.scrollWidth <= vw, l: r.left, r: r.right, t: r.top, b: r.bottom, vw, vh }
    })()`)
    const progress = async (api) => must(await api.get('/api/admin/tours'), 'tours').progress
    const actButtons = () => ev(`[...document.querySelectorAll('#tour-root .tour-actions button')].map(b => b.textContent.trim()).join(',')`)

    // ===== A: 新しい会社の会社管理者が、案内の中で5つを作る =====
    await setCookie(A.api.cookie)
    await send('Page.navigate', { url: `${BASE}/admin` }); await ready()
    await until(`/ようこそ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 会社管理者の初回は「Field OS へようこそ」で、はじめの準備（5つ）を出す［あとで］［始める］', /ようこそ/.test(await title())
      && (await actButtons()) === 'あとで,始める' && /実際に登録しながら/.test(await bodyText())
      && (await ev(`[...document.querySelectorAll('#tour-root .tour-setup-list li')].length`)) === 5, { t: await title(), b: await actButtons() })
    await shot('a-welcome')
    await clickAct('start')
    await until(`location.hash === '#clients' && /1\\. クライアント/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: ［始める］でクライアントの画面に移り、「クライアント登録」を囲む', await holeOn('[onclick^="showAddClient"]'), await title())
    ok('#9915 画面: 画面は暗くせず操作できる（暗い幕を出さない）・吹き出しは aria-modal=false', await ev(`getComputedStyle(document.querySelector('#tour-root .tour-block')).display === 'none' && document.querySelector('#tour-root .tour-bubble').getAttribute('aria-modal') === 'false'`))
    ok('#9915 画面: 登録が済むまで［次へ］は押せない・［あとで］がある', await nextDisabled() && /あとで/.test(await actButtons()) && /登録が済むと/.test(await bodyText()))
    await clickAct('next'); await wait(400)
    ok('#9915 画面: 済んでいない間に［次へ］を押しても進まない', /1\. クライアント/.test(await title()) && (await ev('location.hash')) === '#clients')
    await shot('a-client-open')
    await click('[onclick^="showAddClient"]')
    ok('#9915 画面: フォームを開くと、入れる欄（クライアント名）を囲む', await holeOn('#nc-name') && /クライアント名/.test(await bodyText()))
    await shot('a-client-name')
    const A_CLIENT = `${PFX} A 顧客`
    await type('#nc-name', A_CLIENT)
    ok('#9915 画面: 入れると「登録する」を囲む', await holeOn('[data-action="addClient"]'))
    await click('[data-action="addClient"]')
    await until(`/✓/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 保存したら実データで確かめて「✓」・［次へ］が押せる', /✓ 1\. クライアント/.test(await title()) && !(await nextDisabled()) && (await bodyText()).includes(A_CLIENT), { t: await title(), b: await bodyText() })
    await shot('a-client-done')
    // 2. 案件（さっき作ったクライアントを選ぶよう案内する）
    await clickAct('next')
    await until(`location.hash === '#projects' && /2\\. 案件/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 次は案件の画面の「案件登録」', await holeOn('[onclick^="showAddProject"]'))
    await click('[onclick^="showAddProject"]')
    await holeOn('#np-name')
    const A_PROJECT = `${PFX} A 案件`
    await type('#np-name', A_PROJECT)
    ok('#9915 画面: 案件では、前の項目で作ったクライアントを選ぶよう案内する（名前を出す）', await holeOn('#np-client') && (await bodyText()).includes(A_CLIENT), await bodyText())
    await shot('a-project-client')
    await ev(`(() => { const s = document.getElementById('np-client'); const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(A_CLIENT)})); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await holeOn('[data-action="addProject"]')
    await click('[data-action="addProject"]')
    await until(`/✓ 2\\. 案件/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 案件を作ると「✓」', /✓ 2\. 案件/.test(await title()))
    const pj = must(await A.api.get('/api/admin/projects'), 'projects A').projects.find(p => p.project_name === A_PROJECT)
    ok('#9915 案内の中で作った案件は、選んだクライアントにひも付く', pj && pj.client_name === A_CLIENT, pj)
    // 3. スタッフの途中で「あとで」→ 開き直すと続きから
    await clickAct('next')
    await until(`location.hash === '#staff' && /3\\. スタッフ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    await clickAct('later'); await wait(900)
    const pa = (await progress(A.api))['admin-setup']
    ok('#9915 画面: ［あとで］で閉じ、今の項目（スタッフ）を残す', !(await ev(`!!document.querySelector('#tour-root')`)) && pa && pa.status === 'skipped' && pa.step === 2, pa)
    await send('Page.reload'); await ready()
    await until(`/はじめの準備の続き/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 次に管理画面を開くと「はじめの準備の続き」（済んだ項目にチェック）［あとで］［続ける］', /続き/.test(await title()) && (await actButtons()) === 'あとで,続ける'
      && (await ev(`[...document.querySelectorAll('#tour-root .tour-setup-list li')].map(li => li.classList.contains('ok') ? 1 : 0).join('')`)) === '11000')
    await clickAct('start')
    await until(`location.hash === '#staff' && /3\\. スタッフ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: ［続ける］で、まだ済んでいない最初の項目（スタッフ）から', /3\. スタッフ/.test(await title()) && await holeOn('[onclick^="showAddRoster"]'))
    await click('[onclick^="showAddRoster"]')
    ok('#9915 画面: 作成方法では「② 従業員管理から作成（自社雇用）」を囲む（ログインも一緒に作れる）', await holeOn(`[onclick="showRosterForm('employee')"]`) && /ログイン/.test(await bodyText()))
    await click(`[onclick="showRosterForm('employee')"]`)
    await holeOn('#rf-name', 8000)
    const A_STAFF = `${PFX} A 太郎`
    await type('#rf-name', A_STAFF)
    ok('#9915 画面: 氏名を入れると性別を囲む', await holeOn('#rf-gender'))
    await type('#rf-gender', 'male')
    ok('#9915 画面: 次は初期パスワードを囲む', await holeOn('#rf-pass') && /初期パスワード/.test(await bodyText()))
    const STAFF_PW = 'Staff-pass-2026'
    await type('#rf-pass', STAFF_PW)
    await holeOn('[data-action="submitRosterForm"]')
    const staffCode = await ev(`document.getElementById('rf-code').value`)
    await click('[data-action="submitRosterForm"]')
    // ② 自社雇用は登録の後に従業員の詳細（#employees/ID）へ移る
    await until(`/^#(staff|employees)\\/\\d+$/.test(location.hash) && /✓ 3\\. スタッフ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 10000)
    ok('#9915 画面: 登録の後に詳細の画面に移っても案内は止まらず「✓」', /✓ 3\. スタッフ/.test(await title()) && /^#(staff|employees)\/\d+$/.test(await ev('location.hash')), { t: await title(), h: await ev('location.hash') })
    // 4. シフト（枠を作り、スタッフを割り当てて保存）
    await clickAct('next')
    await until(`location.hash === '#shifts' && /4\\. シフト/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: シフトでは「枠を作成」を囲む', await holeOn('[data-action="boardNewSlot"]', 8000))
    await click('[data-action="boardNewSlot"]')
    ok('#9915 画面: 枠の作成では、前の項目で作った案件を選ぶよう案内する', await holeOn('#slot-project', 8000) && (await bodyText()).includes(A_PROJECT), await bodyText())
    await ev(`(() => { const s = document.getElementById('slot-project'); const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(A_PROJECT)})); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    // 日付は今日（過去の日付の警告で止まらないように）
    await ev(`(() => { window.__slotDates = new Set([${JSON.stringify(today)}]); const i = document.getElementById('slot-date-input'); if (i) i.value = ${JSON.stringify(today)} })()`)
    ok('#9915 画面: 案件を選ぶと「作成する」を囲む', await holeOn('[data-action="saveSlot"][data-id="0"]'))
    await click('[data-action="saveSlot"][data-id="0"]')
    ok('#9915 画面: 枠ができたら、不足のマスを押すよう案内する', await holeOn('#board-grid .board-cell.board-short', 10000) && /不足/.test(await bodyText()), await bodyText())
    ok('#9915 画面: 表の横のスクロールで隠れたマスは、表をスクロールして見せる', await ev(`(() => { const c = document.querySelector('#board-grid .board-cell.board-short').getBoundingClientRect(), g = document.getElementById('board-grid').getBoundingClientRect(); return c.left >= g.left - 1 && c.right <= g.right + 1 })()`))
    await shot('a-shift-cell')
    await click('#board-grid .board-cell.board-short')
    ok('#9915 画面: 候補では、前の項目で作ったスタッフを囲む（名前を出す）', await holeOn('#cand-list .cand-item', 10000) && (await bodyText()).includes(A_STAFF)
      && await ev(`(() => { const h = document.querySelector('#tour-root .tour-hole').getBoundingClientRect(); const c = [...document.querySelectorAll('#cand-list .cand-item')].find(x => x.textContent.includes(${JSON.stringify(A_STAFF)})); if (!c) return false; const r = c.getBoundingClientRect(); return h.top <= r.top + 1 && h.bottom >= r.bottom - 1 })()`), await bodyText())
    await ev(`[...document.querySelectorAll('#cand-list .cand-item')].find(x => x.textContent.includes(${JSON.stringify(A_STAFF)})).click()`)
    ok('#9915 画面: 下書きに入れたら「まとめて保存」を囲む', await holeOn('#board-save-top') && /まとめて保存/.test(await bodyText()))
    ok('#9915 画面: 保存するまでは「次へ」を押せない（下書きは済みにしない）', await nextDisabled())
    await click('#board-save-top')
    let shiftsDone = await until(`/✓ 4\\. シフト/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 6000)
    if (!shiftsDone && await ev(`!!document.querySelector('[data-action="boardSaveForce"]')`)) {
      ok('#9915 画面: 保存で確認が出たら「このまま保存する」を囲む', await holeOn('[data-action="boardSaveForce"]'))
      await click('[data-action="boardSaveForce"]')
      shiftsDone = await until(`/✓ 4\\. シフト/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    }
    ok('#9915 画面: まとめて保存したら「✓ シフトを組む」', shiftsDone, await title())
    await shot('a-shift-done')
    // 5. ログイン: ② で登録したのでログインは発行済み。ログイン案内を出せる
    await clickAct('next')
    await until(`/5\\. スタッフにログイン/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: ② でログインを作ったので、ログインの項目は「✓」で［ログイン案内を表示］［完了］', /✓ 5\./.test(await title()) && /ログイン案内を表示/.test(await actButtons()) && /完了/.test(await actButtons()) && !(await nextDisabled()), { t: await title(), b: await actButtons() })
    await clickAct('guide')
    await until(`!!document.getElementById('login-guide-text')`, 5000)
    const guide = String(await ev(`(document.getElementById('login-guide-text') || {}).value || ''`))
    ok('#9915 画面: ログイン案内（会社コード・スタッフ番号・初期パスワード）を画面に出す（メールを送らなくても止まらない）', guide.includes(A.code) && guide.includes(staffCode) && guide.includes(STAFF_PW), guide)
    ok('#9915 画面: ログイン案内の欄を囲む', await holeOn('#login-guide-text'))
    await shot('a-login-guide')
    await clickAct('next')
    await until(`/はじめの準備ができました/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 6000)
    ok('#9915 画面: 5つ済んで［完了］で「はじめの準備ができました」［閉じる］［主な機能の案内を見る］', /できました/.test(await title()) && (await actButtons()) === '閉じる,主な機能の案内を見る')
    await clickAct('close'); await wait(1200)
    const pdone = await progress(A.api)
    ok('#9915 完了を残す（admin-setup done）・主な機能の案内は自動では出さない（admin-welcome skipped）・案内で開いた画面の案内は done', pdone['admin-setup']?.status === 'done' && pdone['admin-welcome']?.status === 'skipped'
      && pdone['admin-screen-clients']?.status === 'done' && pdone['admin-screen-shifts']?.status === 'done', pdone)
    ok('#9915 画面: 閉じたらダッシュボードへ戻る', (await ev('location.hash')) === '#dashboard' && !(await ev(`!!document.querySelector('#tour-root')`)))
    const ca = must(await A.api.get('/api/admin/tours/checklist'), 'checklist A done')
    ok('#9915 案内の中で5つを実際に作った（setup がすべて済み）', K.every(k => ca.setup[k]), ca.setup)
    await send('Page.reload'); await ready(); await wait(1500)
    // ダッシュボードは案内で開いていないので、初めて開いた画面の短い案内（今までどおり）は出てよい
    const t2 = await title()
    ok('#9915 画面: 完了の後は、開き直してもはじめの準備・主な機能の案内を出さない', !/はじめの準備|ようこそ/.test(t2) && !(await ev(`!!document.querySelector('#tour-root .tour-setup-list')`)), t2)
    if (await ev(`!!document.querySelector('#tour-root .tour-bubble')`)) { await clickAct('skip'); await wait(600) }
    // 各画面の使い方は今までどおり（「？」の「この画面の使い方」・暗くして浮かせる）
    await ev(`document.querySelector('#tour-help-bar .tour-help-btn').click()`)
    await until(`!!document.getElementById('tour-menu')`, 3000)
    const menu = await ev(`[...document.querySelectorAll('#tour-menu [role=menuitem]')].map(b => b.textContent.trim())`)
    ok('#9915 画面: 「？」は今までどおり（この画面の使い方・最初の案内をもう一度見る）。完了の後は「はじめの準備を続ける」を出さない', Array.isArray(menu) && menu.some(t => t.startsWith('この画面の使い方（ダッシュボード）')) && menu.includes('最初の案内をもう一度見る') && !menu.some(t => /はじめの準備/.test(t)), menu)
    await ev(`document.querySelector('#tour-menu [data-tour-menu="screen"]').click()`)
    await until(`/今日の数字/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 5000)
    ok('#9915 画面: 「この画面の使い方」は今までどおり（暗くして浮かせる・［スキップ］［前へ］［次へ］）', /今日の数字/.test(await title())
      && await ev(`!document.getElementById('tour-root').classList.contains('tour-live') && getComputedStyle(document.querySelector('#tour-root .tour-block')).display !== 'none'`)
      && (await actButtons()) === 'スキップ,前へ,次へ')
    await clickAct('skip'); await wait(600)
    // 初めて開いた画面の短い案内も今までどおり（案内で開いていない画面: 日報一覧）
    await ev(`location.hash = 'reports'`)
    const autoRep = await until(`/提出済み・未提出|未確認・インシデント|絞り込み/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 9000)
    ok('#9915 画面: 初めて開いた画面の短い案内は今までどおり出る（日報一覧）', autoRep, await title())
    await clickAct('skip'); await wait(600)

    // ===== B: 済んだ項目を飛ばす・ログインの発行（スタッフの詳細から） =====
    await setCookie(B.api.cookie)
    await send('Page.navigate', { url: `${BASE}/admin` }); await ready()
    await until(`/ようこそ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 確認には済んだ項目（クライアント・案件）にチェック', (await ev(`[...document.querySelectorAll('#tour-root .tour-setup-list li')].map(li => li.classList.contains('ok') ? 1 : 0).join('')`)) === '11000')
    await clickAct('start')
    await until(`location.hash === '#staff' && /3\\. スタッフ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 済んでいる項目（クライアント・案件）は飛ばし、スタッフから始める', /3\. スタッフ/.test(await title()), await title())
    // スマホの幅でもはみ出さない
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 740, deviceScaleFactor: 2, mobile: true })
    await wait(900)
    const f1 = await fits()
    ok('#9915 画面: スマホの幅でも吹き出しが画面からはみ出さない', f1.ok, f1)
    await shot('b-mobile')
    await send('Emulation.clearDeviceMetricsOverride'); await wait(500)
    await clickAct('close'); await wait(900)
    ok('#9915 画面: ✕ でも閉じられる（あとで）', !(await ev(`!!document.querySelector('#tour-root')`)) && (await progress(B.api))['admin-setup']?.status === 'skipped')
    // ログインのないスタッフとシフトは API で作る → 残りはログインの発行だけ
    const st = await partnerStaffNoLogin(B.api, 'B')
    must(await B.api.post('/api/admin/shifts', { staff_id: st.staff_id, project_id: B.project, work_date: today, start_time: '10:00', end_time: '19:00' }), 'shift B')
    const cb = must(await B.api.get('/api/admin/tours/checklist'), 'checklist B2')
    ok('#9915 ログインのないスタッフだけなら setup.logins は未完了', cb.setup.staff && cb.setup.shifts && !cb.setup.logins, cb.setup)
    await send('Page.reload'); await ready()
    await until(`/はじめの準備の続き/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    await clickAct('start')
    await until(`/5\\. スタッフにログイン/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9915 画面: 残りがログインだけなら、ログインの項目から（スタッフの行を押すよう案内する）', /5\./.test(await title()) && await nextDisabled() && await holeOn('#staff-rows tr[data-action="openStaffDetail"]', 8000), await title())
    await click(`#staff-rows tr[data-action="openStaffDetail"][data-id="${Number(st.staff_id)}"]`)
    ok('#9915 画面: スタッフの詳細では「ログインを発行」を囲む', await holeOn('#issue-login-btn', 10000), await bodyText())
    await click('#issue-login-btn')
    ok('#9915 画面: ログインの発行のフォームでは初期パスワードを囲む', await holeOn('#il-pass', 8000))
    await type('#il-code', `${PFX}L`)
    await type('#il-pass', 'Staff-pass-2026')
    await holeOn('[data-action="submitIssueLogin"]')
    await click('[data-action="submitIssueLogin"]')
    await until(`!!document.getElementById('login-guide-text') && /✓ 5\\./.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 10000)
    ok('#9915 画面: 発行したらログイン案内が出て「✓」（発行した時点で済み）・案内の欄を囲む', /✓ 5\./.test(await title()) && await holeOn('#login-guide-text') && !(await nextDisabled()))
    await shot('b-issued')
    await clickAct('next')
    await until(`/はじめの準備ができました/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 6000)
    await clickAct('tour')
    await until(`/クライアント/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '') && location.hash === '#clients'`, 8000)
    ok('#9915 画面: ［主な機能の案内を見る］で今までの主な機能の案内（クライアントから）', /クライアント/.test(await title()) && await holeOn('[onclick^="showAddClient"]'))
    await clickAct('close'); await wait(600)
    ok('#9915 B も完了を残す', (await progress(B.api))['admin-setup']?.status === 'done')
    await checkIssued(st)

    // ===== 会社管理者以外: 今までどおりの「主な機能の案内」（はじめの準備が済んでいない会社の、新しい現場責任者） =====
    must(await C.api.post('/api/admin/users', { user_code: 'fm1', name: '現場 責任者', role: 'field_manager', password: 'pass1234', email: `fm1-${C.code}@example.com` }), 'add field manager')
    const fm0 = client(await login(C.code, 'fm1'))
    must(await fm0.post('/api/auth/change-password', { current_password: 'pass1234', new_password: NEWPW }), 'fm change pw')
    await setCookie(await login(C.code, 'fm1', NEWPW))
    await send('Page.navigate', { url: `${BASE}/admin` }); await ready()
    await until(`!!document.querySelector('#tour-root .tour-title')`, 8000)
    ok('#9915 画面: 会社管理者以外（現場管理者）は今までどおり「主な機能」を案内する（作成の案内は出さない）', /ようこそ/.test(await title()) && /主な機能/.test(await bodyText()) && !(await ev(`!!document.querySelector('#tour-root .tour-setup-list')`)), await bodyText())
    await clickAct('later'); await wait(500)
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
