// w30b-toast（Sprint 30b。画面の下に数秒出るお知らせ＝トースト #toast の幅を、全部の画面で直す）の統合テスト
//  今まで #toast は幅を決めていなかったので、長い文（日報など）が画面の真ん中で細長く縦に折り返していた（スタッフ・管理画面・本部で共通）。
//  直し: #toast に幅（calc(100% - 2rem)・最大 28rem）を決め、中のお知らせ（.toast-msg）を縦に並べる。箱の外の画面は押せるまま（pointer-events）。
//  スタッフのホームの固定のボタンがあるときは、その上に出す（Sprint 30 の body.has-next-bar #toast はそのまま）。色は Sprint 26 のトークンだけ。
//  確かめること（390px・1280px、スタッフ・管理画面・本部）:
//   - 長い文のトーストが横に広がる（390px で 300px 以上、1280px で 28rem 以下）・画面からはみ出さない
//   - 2つ出すと縦に並ぶ（重ならない・真ん中がそろう）
//   - 箱の外（#toast の中でも、お知らせの横の空き）にあるボタンが押せる。お知らせ自身（✕ の閉じるボタン）は押せる
//   - スタッフのホームでは、固定のボタン（#home-next-bar）に重ならない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9022 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9022 node --import ./scripts/fetch-origin.mjs scripts/test-w30b-toast.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写し（390px・1280px）を残す。
//   固定のボタンの確認は、日本時間の 1:30〜21:00 の間だけ行う（日をまたぐシフトにしないため。外の時刻は SKIP と出す）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9022'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}`)
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
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 300)}`); return r.data }
const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst(Date.now()).slice(0, 10)
const hm = (ms) => jst(ms).slice(11, 16)
const nowMin = (() => { const t = jst(Date.now()); return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) })()
const TIMED = nowMin >= 90 && nowMin <= 21 * 60

// ---------- CSS ----------
const css = read('src/input.css'), built = read('public/static/style.css'), common = read('public/static/common.js')
const rule = (src, sel) => { const i = src.indexOf('\n' + sel + ' {'); if (i < 0) return ''; return src.slice(i + 1, src.indexOf('}', i) + 1) }
const toastRule = rule(css, '#toast'), childRule = rule(css, '#toast > *'), barRule = rule(css, 'body.has-next-bar #toast')
ok('CSS: #toast に幅（calc(100% - 2rem)・最大 28rem）と縦の並び（flex・column・真ん中・間 .4rem）を決める', /width: calc\(100% - 2rem\);/.test(toastRule) && /max-width: 28rem;/.test(toastRule)
  && /display: flex;/.test(toastRule) && /flex-direction: column;/.test(toastRule) && /align-items: center;/.test(toastRule) && /gap: \.4rem;/.test(toastRule), toastRule)
ok('CSS: 箱の外は押せるまま（#toast は pointer-events: none、中のお知らせは auto・幅は箱まで）', /pointer-events: none;/.test(toastRule) && /pointer-events: auto;/.test(childRule) && /max-width: 100%;/.test(childRule), { toastRule, childRule })
ok('CSS: 位置は今のまま（下から 5.5rem・真ん中・z-index 60）', /position: fixed; bottom: 5\.5rem; left: 50%; transform: translateX\(-50%\); z-index: 60;/.test(toastRule), toastRule)
ok('CSS: スタッフのホームの固定のボタンの上に出す決まり（body.has-next-bar #toast）は残す', /bottom: calc\(var\(--nav-h, 64px\) \+ 6\.5rem\)/.test(barRule), barRule)
ok('CSS: トーストの決まりに色を直に書かない（#xxxxxx・rgb(数字) なし。.toast-msg はトークン）', [toastRule, childRule, barRule, rule(css, '  .toast-msg')].every(r => !/#[0-9a-fA-F]{3,8}\b|rgba?\(\d/.test(r)) && /\.toast-msg \{ background: rgb\(var\(--color-toast\)\)/.test(css))
ok('CSS: ビルドした style.css に出ている', /#toast\{[^}]*width:calc\(100% - 2rem\)[^}]*max-width:28rem[^}]*pointer-events:none/.test(built) && /#toast>\*\{[^}]*pointer-events:auto/.test(built) && /body\.has-next-bar #toast\{/.test(built))
ok('common.js: toast() は #toast に .toast-msg を足していく作りのまま', /root\.id = 'toast'/.test(common) && /el\.className = 'toast-msg'/.test(common) && /root\.appendChild\(el\)/.test(common))

// ---------- API: 人・シフト ----------
const adminCk = await login('sample', 'admin'), hqCk = await login('', 'hq')
const admin = client(adminCk)
const PFX = 'W30T' + Date.now().toString(36).slice(-4).toUpperCase()
const NEWPW = 'W30b-toast-pass-2026'
must(await admin.post('/api/admin/staff', { user_code: `${PFX}A`, name: `${PFX} A`, password: 'pass1234' }), 'staff')
const st = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}A`)
must(await client(await login('sample', `${PFX}A`)).post('/api/auth/change-password', { current_password: 'pass1234', new_password: NEWPW }), 'change pw')
const staffCk = await login('sample', `${PFX}A`, NEWPW)
must(await client(staffCk).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] }), 'tour')
await admin.put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup', 'admin-screen-dashboard'].map(key => ({ key, status: 'skipped', step: 0 })) })
if (TIMED) {
  const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
  const PID = (projects.find(p => p.status === 'active') || projects[0]).project_id
  must(await admin.post('/api/admin/shifts', { staff_id: st.staff_id, project_id: PID, work_date: today, start_time: hm(Date.now() + 120 * 60000), end_time: '23:59', memo: `${PFX}-toast` }), 'shift')
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
const LONG = '日報を提出しました。件数の欄に入力した内容は管理者が確認します。修正が必要なときは、打刻履歴の画面から修正の申請を送ってください。'
const LONG2 = 'もう1つのお知らせです。2つ出たときは縦に並び、重なりません。'

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w30btoast-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let tabs
    for (let i = 0; i < 60 && !tabs; i++) { await wait(300); tabs = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = tabs && tabs.find(t => t.type === 'page')
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
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w30b-toast-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    const setWidth = (w) => send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: w < 600 })
    const click = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    const screens = [
      { name: 'スタッフ', key: 'staff', ck: staffCk, url: `${BASE}/staff#home`, ready: `!!document.getElementById('home-result') && !document.querySelector('#app .spin')` },
      { name: '管理画面', key: 'admin', ck: adminCk, url: `${BASE}/admin#dashboard`, ready: `!!document.getElementById('kpi-cards')` },
      { name: '本部', key: 'hq', ck: hqCk, url: `${BASE}/hq#companies`, ready: `!!document.querySelector('#hq-co-body tr td')` },
    ]
    for (const w of [390, 1280]) {
      await setWidth(w)
      for (const s of screens) {
        errors = []
        await send('Page.navigate', { url: 'about:blank' }); await wait(300)
        await as(s.ck)
        await send('Page.navigate', { url: s.url })
        const drawn = await until(s.ready, 40000)
        ok(`画面 ${w}px ${s.name}: 開く`, drawn)
        if (!drawn) continue
        await wait(800)
        // 画面の読み込みで出たお知らせを消してから、長い文のお知らせを2つ出す（すぐには消えないよう長めに）
        await ev(`document.querySelectorAll('#toast > .toast-msg').forEach(t => Element.prototype.remove.call(t)); toast(${JSON.stringify(LONG)}, 60000); toast(${JSON.stringify(LONG2)}, 60000); true`)
        await wait(400)
        const m = await ev(`(() => { const root = document.getElementById('toast'); const ts = [...root.querySelectorAll(':scope > .toast-msg')]; const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height } }
          const lh = parseFloat(getComputedStyle(ts[0]).lineHeight) || 20
          return { vw: document.documentElement.clientWidth, vh: innerHeight, root: R(root), ts: ts.map(R), lines: Math.round((ts[0].clientHeight - parseFloat(getComputedStyle(ts[0]).paddingTop) - parseFloat(getComputedStyle(ts[0]).paddingBottom)) / lh),
            rem: parseFloat(getComputedStyle(document.documentElement).fontSize), sw: document.scrollingElement.scrollWidth } })()`)
        if (!m || m.__error || !m.ts || m.ts.length < 2) { ok(`画面 ${w}px ${s.name}: お知らせが2つ出る`, false, m); continue }
        const [a, b] = m.ts
        if (w === 390) ok(`画面 ${w}px ${s.name}: 長い文のお知らせが横に広がる（300px 以上・画面の中）`, a.w >= 300 && a.l >= 0 && a.r <= m.vw && m.sw <= m.vw + 1, m)
        else ok(`画面 ${w}px ${s.name}: 長い文のお知らせは 28rem 以下で、細長くならない（400px 以上）`, a.w <= 28 * m.rem + 0.5 && a.w >= 400 && m.root.w <= 28 * m.rem + 0.5, m)
        ok(`画面 ${w}px ${s.name}: 長い文でも縦に細長く折り返さない（${w === 390 ? 5 : 3}行以下）`, m.lines <= (w === 390 ? 5 : 3), m)
        ok(`画面 ${w}px ${s.name}: 2つ出すと縦に並ぶ（重ならない・真ん中がそろう）`, b.t >= a.b - 0.5 && Math.abs((a.l + a.r) / 2 - (b.l + b.r) / 2) <= 1 && b.b <= m.vh, { a, b })
        // 箱の外（#toast の中で、短いお知らせの横の空き）に置いたボタンが押せる
        const pt = await ev(`(() => { document.querySelectorAll('#toast > .toast-msg').forEach(t => Element.prototype.remove.call(t)); toast('保存しました', 60000)
          const root = document.getElementById('toast'), t = root.querySelector('.toast-msg'), r = root.getBoundingClientRect(), q = t.getBoundingClientRect()
          const x = Math.round((r.left + q.left) / 2), y = Math.round((q.top + q.bottom) / 2)
          const btn = document.createElement('button'); btn.id = 'w30b-under'; btn.type = 'button'; btn.textContent = '下のボタン'
          btn.style.cssText = 'position:fixed;z-index:50;left:' + (x - 20) + 'px;top:' + (y - 15) + 'px;width:40px;height:30px'
          window.__w30bClicked = 0; btn.addEventListener('click', () => { window.__w30bClicked++ }); document.body.appendChild(btn)
          return { x, y, inRoot: x > r.left && x < r.right && y > r.top && y < r.bottom, outMsg: x < q.left, top: document.elementFromPoint(x, y)?.id || '' } })()`)
        await click(pt.x, pt.y); await wait(200)
        ok(`画面 ${w}px ${s.name}: 箱の外（お知らせの横の空き）にあるボタンが押せる`, pt.inRoot && pt.outMsg && pt.top === 'w30b-under' && await ev('window.__w30bClicked') === 1, pt)
        // お知らせ自身は押せる（エラーのお知らせの ✕ で閉じる）
        await ev(`document.getElementById('w30b-under').remove(); document.querySelectorAll('#toast > .toast-msg').forEach(t => Element.prototype.remove.call(t)); toast('保存に失敗しました。もう一度お試しください', 60000); true`)
        await wait(300)
        const x = await ev(`(() => { const b = document.querySelector('#toast .toast-msg button[aria-label="閉じる"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
        if (x) { await click(x.x, x.y); await wait(300) }
        ok(`画面 ${w}px ${s.name}: お知らせの ✕（閉じる）は押せる`, x && await ev(`!document.querySelector('#toast .toast-msg')`), x)
        // 写し（長い文のお知らせを2つ出した状態）
        await ev(`toast(${JSON.stringify(LONG)}, 60000); toast(${JSON.stringify(LONG2)}, 60000); true`); await wait(400)
        await shot(`${s.key}-${w}`)
        // スタッフのホームの固定のボタンに重ならない
        if (s.key === 'staff') {
          if (TIMED) {
            const nb = await ev(`(() => { const bar = document.querySelector('#home-next-bar .next-bar-btn'); const t = [...document.querySelectorAll('#toast > .toast-msg')].pop(); if (!bar || !t) return { bar: !!bar, t: !!t }
              return { bar: true, has: document.body.classList.contains('has-next-bar'), barTop: bar.getBoundingClientRect().top, toastBottom: t.getBoundingClientRect().bottom } })()`)
            ok(`画面 ${w}px スタッフ: ホームの固定のボタンに重ならない（その上に出す）`, nb.bar && nb.has && nb.toastBottom <= nb.barTop, nb)
          } else skip(`画面 ${w}px スタッフ: 固定のボタンに重ならない（日本時間の 1:30〜21:00 の間だけ）`)
        }
        await ev(`document.querySelectorAll('#toast > .toast-msg').forEach(t => Element.prototype.remove.call(t)); true`)
        ok(`画面 ${w}px ${s.name}: スクリプトのエラーがない`, errors.length === 0, errors)
      }
    }
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
