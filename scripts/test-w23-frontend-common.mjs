// w23-frontend-common（総点検 Sprint 23。#9959 #9960）の統合テスト
//  #9959 画面の共通の関数（errMsg・toast・loading・modal・closeModal・esc）を common.js に1つだけ置く。
//    各画面の複製（admin.js・staff.js・hq.js・apply.js・report-link.js と各画面の即時関数の errMsg）を消す。
//    staff.js・hq.js の弱い esc（` を逃がさない）を消し、common.js の esc だけにする。
//    画面ごとの違いは UI_PAGE（toast の既定の秒数・読み込み中の余白）と onModalClose（閉じたときの後片付け・閉じてよいか）で保つ
//  #9960 _orig… で前の定義を包んで上書きする作りを、元の関数へまとめる
//    roster.js: showAddRoster・showRosterLink・showRosterForm・submitRosterForm・closeModal（カメラを止める）
//    staff-lifecycle.js: renderStaffLifecyclePanel の3重の定義（パスワードの再発行・出勤可能日の提出の行。lifecycle の二重の取得もなくなる）
//    スタッフアプリの renderMore・notifOpenStaff の差し替えは、画面の登録をまとめる w23-menus（#9962）の範囲なので、ここでは触らない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8931 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8931 node --import ./scripts/fetch-origin.mjs scripts/test-w23-frontend-common.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import vm from 'vm'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8931'
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

// ---------- #9959 コード: 共通の関数は common.js に1つだけ ----------
const files = readdirSync(join(ROOT, 'public/static')).filter(f => f.endsWith('.js'))
const src = Object.fromEntries(files.map(f => [f, read(`public/static/${f}`)]))
const defsOf = (name) => {
  const re = new RegExp(`^\\s*(?:(?:async\\s+)?function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=|window\\.${name}\\s*=)`, 'gm')
  return files.flatMap(f => (src[f].match(re) || []).map(() => f))
}
for (const name of ['esc', 'escAttr', 'errMsg', 'toast', 'loading', 'modal', 'closeModal', 'onModalClose']) {
  const d = defsOf(name)
  ok(`#9959 ${name} の定義は common.js の1つだけ`, d.length === 1 && d[0] === 'common.js', d)
}
ok('#9959 staff.js・hq.js に弱い esc（` を逃がさない）が残っていない', !/function esc\(/.test(src['staff.js'] + src['hq.js']) && !/\[&<>"'\]\/g/.test(src['staff.js'] + src['hq.js']))
ok('#9959 画面ごとの違いは UI_PAGE で切り替える（スタッフアプリの読み込み中は py-16・募集ページの toast は 3 秒）',
  /const UI_PAGE = \{ toastMs: 2500, loadingPad: 'py-20' \}/.test(src['common.js']) && /^UI_PAGE\.loadingPad = 'py-16'$/m.test(src['staff.js']) && /^\s*UI_PAGE\.toastMs = 3000$/m.test(src['apply.js']))
ok('#9959 閉じたときの後片付けは onModalClose で登録する（スタッフアプリの写真・名簿のカメラ・報告用URLの送信中）',
  /onModalClose\(\(\) => \{\s*if \(pendingPhoto\.previewUrl\) URL\.revokeObjectURL/.test(src['staff.js']) && /^onModalClose\(stopQrScan\)$/m.test(src['roster.js'])
  && /onModalClose\(\(\) => \{ pending = null \}, \{ canClose: \(force\) => !sending \|\| force === true \}\)/.test(src['report-link.js']))
ok('#9959 showApiError も errMsg を使う（文言の決め方を1か所にする）', /function showApiError\(e, fallback\) \{\n  const msg = errMsg\(e, fallback\)/.test(src['common.js']))

// ---------- #9960 コード: _orig の包みをやめた ----------
ok('#9960 roster.js に _orig の包みが残っていない', !/_orig/.test(src['roster.js']), (src['roster.js'].match(/.*_orig.*/g) || []).slice(0, 3))
for (const fn of ['showAddRoster', 'showRosterLink', 'showRosterForm', 'submitRosterForm']) {
  const n = (src['roster.js'].match(new RegExp(`window\\.${fn}\\s*=`, 'g')) || []).length
  ok(`#9960 roster.js の ${fn} の定義は1つ`, n === 1, n)
}
ok('#9960 roster.js: 必須項目の確認・* の表示は元の関数の中で行う', /window\.showRosterForm = async function \(route\) \{\n  await loadRosterRequired\(true\)/.test(src['roster.js'])
  && /markRequiredInForm\(route\)\n\}\ndelegate\('showAddRoster'/.test(src['roster.js']) && /window\.submitRosterForm = async function \(route, force\) \{\n  if \(!rosterRequiredFilled\(route\)\) return/.test(src['roster.js']))
const lcDefs = (src['staff-lifecycle.js'].match(/window\.renderStaffLifecyclePanel\s*=/g) || []).length
ok('#9960 staff-lifecycle.js の renderStaffLifecyclePanel の定義は1つ（3重の包みをやめた）', lcDefs === 1 && !/const orig = window\.renderStaffLifecyclePanel/.test(src['staff-lifecycle.js']), lcDefs)

// ---------- #9959 common.js の動き（vm） ----------
{
  const roots = {}
  const el = (id) => (roots[id] = roots[id] || { id, innerHTML: '' })
  const ctx = { document: { addEventListener() { }, documentElement: null, querySelectorAll: () => [], getElementById: (id) => (id === 'modal-root' || id === 'app' ? el(id) : null) }, console, setTimeout, clearTimeout }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(readFileSync(join(ROOT, 'public/static/common.js'), 'utf8'), ctx)
  ok('#9959 esc は & < > " \' ` を実体参照にする', ctx.esc('&<>"\'`') === '&amp;&lt;&gt;&quot;&#39;&#96;', ctx.esc('&<>"\'`'))
  ok('#9959 errMsg: サーバーの文言 → 引数の既定 → 『エラーが発生しました』の順',
    ctx.errMsg({ response: { data: { error: 'サーバー' } } }, '既定') === 'サーバー' && ctx.errMsg({ response: { data: {} } }, '既定') === '既定' && ctx.errMsg(null) === 'エラーが発生しました' && ctx.errMsg(new Error('x'), '') === 'エラーが発生しました')
  ctx.loading()
  ok('#9959 loading: #app を読み込み中にする（既定は py-20）', /class="flex justify-center py-20"><span class="spin">/.test(roots.app.innerHTML), roots.app.innerHTML)
  const log = []
  vm.runInContext(`onModalClose(() => __log.push('cleanup'))`, Object.assign(ctx, { __log: log }))
  ctx.modal('<p>中身</p>', { onClose: () => log.push('onClose:' + JSON.stringify(roots['modal-root'].innerHTML)) })
  ok('#9959 modal: 背景のタップで閉じる作りのモーダルを #modal-root に描く', /^<div class="modal-bg" onclick="if\(event\.target===this\)closeModal\(\)"><div class="modal-box p-5"><p>中身<\/p><\/div><\/div>$/.test(roots['modal-root'].innerHTML))
  ctx.closeModal(); ctx.closeModal()
  ok('#9959 closeModal: 後片付け → モーダルを消す → onClose は1回だけ（2回目の closeModal では呼ばない）', JSON.stringify(log) === JSON.stringify(['cleanup', 'onClose:""', 'cleanup']), log)
  let sending = true
  vm.runInContext(`onModalClose(null, { canClose: (force) => !__sending() || force === true })`, Object.assign(ctx, { __sending: () => sending }))
  ctx.modal('<p>送信中</p>'); ctx.closeModal()
  const kept = roots['modal-root'].innerHTML !== ''
  ctx.closeModal(true)
  const forced = roots['modal-root'].innerHTML === ''
  sending = false; ctx.modal('<p>送信の後</p>'); ctx.closeModal()
  ok('#9959 closeModal: canClose が false なら閉じない（force を付ければ閉じる。報告用URLの送信中）', kept && forced && roots['modal-root'].innerHTML === '', { kept, forced })
  const noRoot = { document: { addEventListener() { }, documentElement: null, querySelectorAll: () => [], getElementById: () => null }, console, setTimeout, clearTimeout }
  noRoot.window = noRoot; vm.createContext(noRoot); vm.runInContext(readFileSync(join(ROOT, 'public/static/common.js'), 'utf8'), noRoot)
  let threw = null; try { noRoot.closeModal(); noRoot.loading() } catch (e) { threw = String(e) }
  ok('#9959 #modal-root・#app のない画面（ログインなど）で closeModal・loading を呼んでも落ちない', threw === null, threw)
}

// ---------- API: 各画面は common.js を画面の js より先に読み込む ----------
const adminCk = await login('sample', 'admin')
const admin = client(adminCk)
const hqCk = await login('', 'hq')
const staffCk = await login('sample', 'st001')
const page = async (path, cookie) => { const r = await fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' }); return { status: r.status, text: await r.text() } }
for (const [path, cookie, js] of [['/admin', adminCk, 'admin.js'], ['/staff', staffCk, 'staff.js'], ['/hq', hqCk, 'hq.js'], ['/apply/w23-no-such-token', null, 'apply.js'], ['/r/w23-no-such-token', null, 'report-link.js']]) {
  const p = await page(path, cookie)
  const i = p.text.indexOf('/static/common.js'), j = p.text.indexOf(`/static/${js}`)
  ok(`#9959 ${path.replace(/w23-no-such-token/, ':token')} は common.js を ${js} より先に読み込む`, p.status === 200 && i > 0 && j > i, { status: p.status, i, j })
}
const loginPage = await page('/login')
ok('#9959 ログインの画面も common.js を読み込む（toast・closeModal を呼んでも落ちない）', loginPage.status === 200 && loginPage.text.includes('/static/common.js'))
for (const f of ['common.js', 'admin.js', 'staff.js', 'hq.js', 'roster.js', 'staff-lifecycle.js']) {
  const r = await fetch(`${BASE}/static/${f}`)
  const t = (await r.text()).replace(/\r\n/g, '\n')
  ok(`#9959 配信している /static/${f} は手元のファイルと同じ（ビルドの取り違えがない）`, r.status === 200 && t === src[f], r.status)
}

// テストのデータ: ログインのある自社雇用のスタッフ（st001）
const staffList = await admin.get('/api/admin/staff')
const st001 = ((staffList.data && staffList.data.staff) || []).find(s => s.user_code === 'st001')
const sid = Number(st001 && st001.staff_id)
const lc = await admin.get(`/api/admin/staff/${sid}/lifecycle`)
ok('（前提）st001 はログインのある自社のスタッフ', sid > 0 && lc.status === 200 && lc.data.has_own_login === true && !lc.data.merged_into_staff_id, { sid, status: lc.status })
// 必須項目の設定（名簿の作成フォームの * と送信前の確認）。④スキルシートのみでも当てはまる項目を1つ選ぶ
const fs0 = await admin.get('/api/admin/roster/field-settings')
const RF_IDS = { kana: 'rf-kana', skills: 'rf-skills', career: 'rf-career' }
const reqField = ((fs0.data && fs0.data.fields) || []).find(f => RF_IDS[f.code] && f.skillsheet && !f.only && !f.login_only)
ok('（前提）④スキルシートのみで必須にできる項目がある', !!reqField, fs0.data && fs0.data.fields && fs0.data.fields.map(f => f.code))

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w23fc-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = list && list.find(t => t.type === 'page')
    if (!pg) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = []; let requests = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Network.requestWillBeSent') requests.push(`${m.params.request.method} ${m.params.request.url}`)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: false })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w23-frontend-common-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); if (!cookie) return; const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    const drawn = `!document.querySelector('#app .spin') && !document.querySelector('#app .fa-spinner') && document.getElementById('app').innerText.trim().length > 10`
    const toastTexts = `[...document.querySelectorAll('#toast .toast-msg')].map(t => t.textContent)`
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    // ----- 管理画面 -----
    await admin.put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup'].map(key => ({ key, status: 'skipped', step: 0 })) })
    await as(adminCk)
    await send('Page.navigate', { url: `${BASE}/admin#dashboard` })
    ok('画面(管理): ダッシュボードが描ける', await until(`typeof delegate === 'function' && !!document.getElementById('app') && ${drawn}`, 40000))
    const adm = await ev(`({ esc: esc('\`'), err: errMsg({ response: { data: { error: 'E' } } }, 'D') + '|' + errMsg(null, 'D') + '|' + errMsg(null), win: window.closeModal === closeModal, pad: UI_PAGE.loadingPad, ms: UI_PAGE.toastMs })`)
    ok('画面(管理): esc・errMsg・closeModal は common.js のもの（既定の余白 py-20・toast 2.5 秒）', adm.esc === '&#96;' && adm.err === 'E|D|エラーが発生しました' && adm.win === true && adm.pad === 'py-20' && adm.ms === 2500, adm)
    await ev(`document.querySelectorAll('#toast .toast-msg').forEach(t => Element.prototype.remove.call(t)); toast('w23 管理の知らせ')`)
    const tShown = await ev(`${toastTexts}.includes('w23 管理の知らせ')`)
    await wait(3300)
    ok('画面(管理): toast が出て、2.5 秒ほどで消える', tShown === true && await ev(`!${toastTexts}.includes('w23 管理の知らせ')`), tShown)
    await ev(`modal('<p id="w23-m">中身</p>', { onClose: () => { window.__w23closed = (window.__w23closed || 0) + 1 } })`)
    const mShown = await ev(`!!document.querySelector('#modal-root .modal-bg .modal-box #w23-m')`)
    await ev(`closeModal(); closeModal()`)
    ok('画面(管理): modal が出て、closeModal で消え、onClose は1回だけ呼ばれる', mShown === true && await ev(`document.getElementById('modal-root').innerHTML === '' && window.__w23closed === 1`), mShown)
    await ev(`(() => { modal('<p>確認</p><button class="btn btn-outline" onclick="closeModal()">閉じる</button>'); document.querySelector('#modal-root .modal-bg').click() })()`)
    ok('画面(管理): 入力欄のないモーダルは、今までどおり背景のタップで閉じる', await ev(`document.getElementById('modal-root').innerHTML === ''`))
    await ev(`(() => { modal('<input id="w23-in" class="inp">'); document.querySelector('#modal-root .modal-bg').click() })()`)
    await wait(200)
    ok('画面(管理): 入力欄のあるモーダルは背景のタップで閉じず、✕ が付く（common.js の #9422 #9502 のまま）', await ev(`!!document.getElementById('w23-in') && !!document.querySelector('#modal-root .modal-x')`))
    await ev(`closeModal()`)
    // エラーの表示（API のエラーの文言を toast で出す）
    const errShown = await ev(`(async () => { let msg = null, server = null; try { await axios.get('/api/admin/staff/99999999/lifecycle') } catch (e) { server = e.response && e.response.data && e.response.data.error; msg = showApiError(e, 'w23 の取得に失敗しました') }
      await new Promise(r => setTimeout(r, 100)); const t = [...document.querySelectorAll('#toast .toast-msg')].find(x => x.textContent.startsWith(msg)); return { msg, server, shown: !!t, alert: !!(t && t.getAttribute('role') === 'alert' && t.querySelector('button[aria-label="閉じる"]')) } })()`)
    ok('画面(管理): API のエラーは、サーバーの文言（無ければ既定の文言）を toast で出す', errShown.shown && errShown.msg === (errShown.server || 'w23 の取得に失敗しました'), errShown)
    await ev(`showApiError(null, 'w23 の保存に失敗しました')`)
    ok('画面(管理): エラーの toast は長めに出し、✕ で閉じられる（#9708 のまま）', await ev(`!!document.querySelector('#toast .toast-msg[role="alert"] button[aria-label="閉じる"]') && ${toastTexts}.some(t => t.startsWith('w23 の保存に失敗しました'))`))
    await ev(`loading()`)
    ok('画面(管理): loading は #app を読み込み中にする（py-20）', await ev(`!!document.querySelector('#app > .flex.justify-center.py-20 > .spin')`))

    // 名簿の作成方法の選択（showAddRoster）: 下にまとめて連携・連携用IDの一覧・協力会社の管理の入口がある
    await ev(`location.hash = 'staff'`)
    await until(drawn, 15000)
    await ev(`showAddRoster()`)
    const addR = await ev(`(() => { const box = document.querySelector('#modal-root .modal-box'); const last = box && box.lastElementChild; return { routes: box ? box.querySelectorAll('.space-y-2 > button').length : 0,
      bulk: !!(last && last.querySelector('[data-action="rosterOpenBulkLink"]') && last.querySelector('[data-action="rosterOpenShareList"]') && last.querySelector('a[href="#partners"]')),
      once: box ? box.querySelectorAll('[data-action="rosterOpenBulkLink"]').length : 0 } })()`)
    await shot('add-roster')
    ok('#9960 画面(管理): 作成方法の選択の下に、まとめて連携・連携用IDの一覧・協力会社の管理（1回だけ）', addR.routes === 5 && addR.bulk && addR.once === 1, addR)
    // ① スタッフIDから連携（showRosterLink）: カメラで読み取るボタンが、検索の結果の欄の上にある
    await ev(`showRosterLink('FSW23TEST')`)
    const link = await ev(`(() => { const res = document.getElementById('rl-result'); const scan = document.getElementById('rl-scan'); return { value: (document.getElementById('rl-code') || {}).value,
      cam: document.querySelectorAll('#modal-root [onclick="startQrScan()"]').length, order: !!(scan && res && scan.nextElementSibling === res && scan.previousElementSibling && scan.previousElementSibling.getAttribute('onclick') === 'startQrScan()') } })()`)
    ok('#9960 画面(管理): スタッフIDから連携のモーダルに、カメラで読み取るボタンが1つ（結果の欄の上）', link.value === 'FSW23TEST' && link.cam === 1 && link.order, link)
    // モーダルを閉じたらカメラを止める（onModalClose(stopQrScan)）
    const stopped = await ev(`(() => { window.__w23stop = 0; qrStream = { getTracks: () => [{ stop() { window.__w23stop++ } }] }; closeModal(); return { stop: window.__w23stop, stream: qrStream, empty: document.getElementById('modal-root').innerHTML === '' } })()`)
    ok('#9960 画面(管理): モーダルを閉じるとカメラを止める', stopped.stop === 1 && stopped.stream === null && stopped.empty, stopped)
    // ②③④ のフォーム（showRosterForm）: 必須にした項目に * が付き、空のまま登録すると止める（submitRosterForm）
    if (reqField) {
      const fieldId = RF_IDS[reqField.code]
      await admin.put('/api/admin/roster/field-settings', { required: { [reqField.code]: true } })
      try {
        await ev(`showRosterForm('skillsheet')`)
        await until(`!!document.getElementById('rf-name')`, 8000)
        const mark = await ev(`(() => { const el = document.getElementById(${JSON.stringify(fieldId)}); const l = el && el.parentElement.querySelector('label'); return l ? l.querySelectorAll('.req-mark').length : -1 })()`)
        ok(`#9960 画面(管理): 必須にした項目（${reqField.code}）のラベルに * が1つ付く`, mark === 1, mark)
        const before = requests.length
        await ev(`(async () => { document.querySelectorAll('#toast .toast-msg').forEach(t => Element.prototype.remove.call(t)); document.getElementById('rf-name').value = 'W23 必須確認'; document.getElementById('rf-gender').value = 'male'; await submitRosterForm('skillsheet') })()`)
        const blocked = await ev(`${toastTexts}.some(t => /^次の項目は必須です: /.test(t))`)
        ok('#9960 画面(管理): 必須の項目が空なら知らせて、登録の API を呼ばない', blocked === true && !requests.slice(before).some(r => /^POST .*\/api\/admin\/roster$/.test(r)) && await ev(`!!document.getElementById('rf-name')`), requests.slice(before))
        await ev(`document.getElementById(${JSON.stringify(fieldId)}).value = 'w23 入力'`)
        await ev(`submitRosterForm('skillsheet')`)
        const created = await until(`/^#staff\\/\\d+$/.test(location.hash) && document.getElementById('modal-root').innerHTML === ''`, 10000)
        ok('#9960 画面(管理): 入れれば今までどおり登録してスタッフ詳細へ移る', created && await ev(`${toastTexts}.includes('スタッフマスタに登録しました')`), await ev(`location.hash`))
      } finally {
        await admin.put('/api/admin/roster/field-settings', { required: { [reqField.code]: false } })
      }
    }

    // スタッフ詳細の「区分・登録状態」: パスワードの再発行・出勤可能日の提出の行が1つずつ。lifecycle の取得は1回
    await ev(`location.hash = 'staff'`)
    await until(drawn, 15000)
    requests = []
    await ev(`location.hash = 'staff/${sid}'`)
    const panel = await until(`!!document.querySelector('#staff-lifecycle dl') && !!document.getElementById('staff-av-target')`, 15000)
    await wait(1500)
    const rows = await ev(`(() => { const dl = document.querySelector('#staff-lifecycle dl'); const kids = [...dl.children]; return { pw: document.querySelectorAll('#staff-reset-password-btn').length, av: document.querySelectorAll('#staff-av-target').length,
      pwLast2: kids.length >= 2 && !!kids[kids.length - 2].querySelector('#staff-reset-password-btn'), avLast: kids[kids.length - 1].id === 'staff-av-target',
      pressed: [...document.querySelectorAll('#staff-av-target [aria-pressed="true"]')].map(b => b.textContent) } })()`)
    await shot('staff-detail')
    const lcGets = requests.filter(r => r.startsWith('GET ') && new RegExp(`/api/admin/staff/${sid}/lifecycle(\\?|$)`).test(r)).length
    ok('#9960 画面(管理): 区分・登録状態に、パスワードの再発行と出勤可能日の提出の行が1つずつ（今までどおり dl の最後に、この順）', panel && rows.pw === 1 && rows.av === 1 && rows.pwLast2 && rows.avLast && rows.pressed.length === 1, rows)
    ok('#9960 画面(管理): 区分・登録状態の取得（/lifecycle）は1回だけ（包みでの二重の取得をやめた）', lcGets === 1, lcGets)
    // 出勤可能日の提出の切り替えは今までどおり（行を描き直す）
    const was = rows.pressed[0]
    await ev(`document.querySelector('#staff-av-target [aria-pressed="false"]').click()`)
    const flipped = await until(`[...document.querySelectorAll('#staff-av-target [aria-pressed="true"]')].map(b => b.textContent).join() !== ${JSON.stringify(was)}`, 8000)
    await ev(`document.querySelector('#staff-av-target [aria-pressed="false"]').click()`)
    const back = await until(`[...document.querySelectorAll('#staff-av-target [aria-pressed="true"]')].map(b => b.textContent).join() === ${JSON.stringify(was)}`, 8000)
    ok('#9960 画面(管理): 出勤可能日の提出の「する／しない」は今までどおり切り替わる', flipped && back, { was })
    ok('画面(管理): スクリプトのエラーがない', errors.length === 0, errors)

    // ----- 本部画面 -----
    errors = []
    await as(hqCk)
    await send('Page.navigate', { url: `${BASE}/hq#companies` })
    const hqOk = await until(`!!document.getElementById('app') && ${drawn}`, 30000)
    const hq = await ev(`({ esc: esc('<\`>'), err: errMsg(null, 'D'), pad: UI_PAGE.loadingPad })`)
    ok('#9959 画面(本部): esc は common.js のもの（` も逃がす）', hqOk && hq.esc === '&lt;&#96;&gt;' && hq.err === 'D' && hq.pad === 'py-20', hq)
    await ev(`toast('w23 本部の知らせ'); modal('<p id="w23-hq">本部</p>')`)
    const hqShown = await ev(`${toastTexts}.includes('w23 本部の知らせ') && !!document.querySelector('#modal-root #w23-hq')`)
    await ev(`closeModal()`)
    ok('画面(本部): toast・modal が出て、closeModal で閉じる', hqShown === true && await ev(`document.getElementById('modal-root').innerHTML === ''`))
    for (const tab of ['templates', 'security', 'companies']) { await ev(`location.hash = ${JSON.stringify(tab)}`); await wait(400); await until(drawn, 15000) }
    await shot('hq')
    ok('画面(本部): スクリプトのエラーがない', errors.length === 0, errors)

    // ----- スタッフアプリ -----
    errors = []
    await client(staffCk).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] })
    await as(staffCk)
    await send('Page.navigate', { url: `${BASE}/staff#home` })
    const stOk = await until(`!!document.getElementById('app') && ${drawn}`, 30000)
    const st = await ev(`({ esc: esc('\`'), pad: UI_PAGE.loadingPad, ms: UI_PAGE.toastMs })`)
    ok('#9959 画面(スタッフ): esc は common.js のもの・読み込み中の余白は py-16（今までどおり）', stOk && st.esc === '&#96;' && st.pad === 'py-16' && st.ms === 2500, st)
    await ev(`loading()`)
    ok('画面(スタッフ): loading は py-16', await ev(`!!document.querySelector('#app > .flex.justify-center.py-16 > .spin')`))
    await ev(`route()`); await until(drawn, 15000)
    await ev(`toast('w23 スタッフの長めの知らせ', 5000)`)
    await wait(3300)
    ok('画面(スタッフ): toast(msg, ms) の時間の指定は今までどおり効く（5 秒の知らせは 3 秒では消えない）', await ev(`${toastTexts}.includes('w23 スタッフの長めの知らせ')`))
    // 撮った写真のプレビューは、モーダルを閉じたら解放する（staff.js の onModalClose）
    const photo = await ev(`(async () => { const u = URL.createObjectURL(new Blob(['w23'])); pendingPhoto = { blob: null, previewUrl: u, type: 'check_in', shiftId: 1 }; modal('<img src="' + u + '">'); closeModal()
      const revoked = await fetch(u).then(() => false, () => true); return { revoked, reset: pendingPhoto.previewUrl === null && pendingPhoto.type === null, empty: document.getElementById('modal-root').innerHTML === '' } })()`)
    ok('画面(スタッフ): モーダルを閉じると、撮った写真のプレビューを解放して pendingPhoto を空にする', photo.revoked && photo.reset && photo.empty, photo)
    for (const h of ['shift', 'attendance', 'report', 'more', 'notifications', 'home']) { await ev(`location.hash = ${JSON.stringify(h)}`); await wait(400); await until(drawn, 15000) }
    await shot('staff')
    ok('画面(スタッフ): スクリプトのエラーがない', errors.length === 0, errors)

    // ----- 公開ページ（募集・報告用URL）。ログインなし -----
    errors = []
    await as(null)
    await send('Page.navigate', { url: `${BASE}/apply/w23-no-such-token` })
    const apOk = await until(`!!document.getElementById('apply-closed')`, 20000)
    ok('#9959 画面(募集): 使えない URL は理由を出す（errMsg）', apOk && await ev(`document.getElementById('apply-closed').innerText.trim().length > 0`))
    await ev(`toast('ok')`)
    await wait(2700)
    const ap27 = await ev(`${toastTexts}.includes('ok')`)
    await wait(1000)
    const ap37 = await ev(`${toastTexts}.includes('ok')`)
    ok('#9959 画面(募集): toast の既定は 3 秒（今までどおり。2.7 秒では残り、3.7 秒では消える）', await ev(`UI_PAGE.toastMs === 3000`) && ap27 === true && ap37 === false, { ap27, ap37 })
    ok('画面(募集): スクリプトのエラーがない', errors.length === 0, errors)
    errors = []
    await send('Page.navigate', { url: `${BASE}/r/w23-no-such-token` })
    const rlOk = await until(`!!document.getElementById('app') && document.getElementById('app').innerText.trim().length > 0 && !document.querySelector('#app .spin')`, 20000)
    await ev(`modal('<p id="w23-rl">報告</p>')`)
    const rlShown = await ev(`!!document.querySelector('#modal-root #w23-rl')`)
    await ev(`closeModal()`)
    ok('#9959 画面(報告用URL): 使えない URL は理由を出し、送信中でなければ closeModal で閉じる', rlOk && rlShown === true && await ev(`document.getElementById('modal-root').innerHTML === ''`), { rlOk, rlShown })
    ok('画面(報告用URL): スクリプトのエラーがない', errors.length === 0, errors)
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
