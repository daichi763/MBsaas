// w32-ui-small（Sprint 32。11/19 の利用者の報告）の統合テスト
//   #9991 シフト表で人をドラッグすると、通り道にある画面の文字まで選択（青く反転）される
//         → ドラッグ中（Sortable の onChoose〜onUnchoose・onEnd）は body に is-dragging を付け、文字を選べなくする（src/input.css）。
//           始めた時に選んでいた文字は外す。iPhone の Safari 向けに selectstart も止め、チップは長押しのメニューも出さない
//   #9995 管理画面の「案件マニュアル・注意事項」が、スタッフアプリでは「研修・マニュアル」という名前で出ていた
//         → スタッフアプリの画面・メニューの名前を「資料・マニュアル」にし、管理画面の欄にも、そこに出ることを書く
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9021 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9021 node --import ./scripts/fetch-origin.mjs scripts/test-w32-ui-small.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
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
const must = (r, what) => { if (r.status !== 200 || r.data == null) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

// ---------- コード（静的な確認） ----------
const sb = read('public/static/shift-board.js'), css = read('src/input.css'), built = read('public/static/style.css')
const staffJs = read('public/static/staff.js'), adminJs = read('public/static/admin.js')
{
  ok('#9991 Sortable の onChoose・onUnchoose・onStart・onEnd で、ドラッグ中の印（body.is-dragging）を付け外しする',
    /onChoose: dndLock, onUnchoose: dndUnlock, onStart: dndStart, onEnd: dndEnd/.test(sb)
    && /function dndLock\(\) \{ document\.body\.classList\.add\('is-dragging'\); clearSelection\(\) \}/.test(sb)
    && /function dndUnlock\(\) \{ document\.body\.classList\.remove\('is-dragging'\) \}/.test(sb)
    && /function dndStart\(\) \{\n\s+DND\.handled = false\n\s+dndLock\(\)/.test(sb) && /function dndEnd\(evt\) \{\n\s+DND\.endAt = Date\.now\(\)\n\s+dndUnlock\(\)/.test(sb))
  ok('#9991 始めた時に選んでいた文字は外す（getSelection().removeAllRanges()）', /function clearSelection\(\) \{ try \{ const s = window\.getSelection && window\.getSelection\(\); if \(s && s\.rangeCount\) s\.removeAllRanges\(\) \} catch \{ \} \}/.test(sb))
  ok('#9991 iPhone の Safari 向けに、ドラッグ中だけ selectstart を止める', /document\.addEventListener\('selectstart', \(ev\) => \{ if \(document\.body\.classList\.contains\('is-dragging'\)\) ev\.preventDefault\(\) \}\)/.test(sb))
  ok('#9991 離した・取り消した・別のアプリへ移った時にも印を外す（文字を選べないままにしない）',
    /for \(const t of \['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel'\]\) document\.addEventListener\(t, \(\) => setTimeout\(dndUnlock, 0\), true\)/.test(sb) && /window\.addEventListener\('blur', dndUnlock\)/.test(sb))
  ok('#9991 候補のスタッフ一覧（cand-list）も同じ設定（DND_OPTS）を使う', /sortableOn\(document\.getElementById\('cand-list'\), \{ group: \{ name: 'board', pull: 'clone'/.test(sb) && /Sortable\.create\(el, \{ \.\.\.DND_OPTS, \.\.\.opts \}\)/.test(sb))
  ok('#9991 CSS: ドラッグ中は body の中の文字を選べない（-webkit- 付きも）',
    /body\.is-dragging, body\.is-dragging \* \{ -webkit-user-select: none !important; user-select: none !important; \}/.test(css))
  ok('#9991 CSS: ドラッグできるチップ・候補は、長押しで文字の選択・iPhone の長押しメニューを出さない',
    /\.dnd-item, #cand-list \.cand-item \{ -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; \}/.test(css))
  ok('#9991 CSS: 入力欄など、ドラッグしていない時の文字選択は止めない（body 全体・input には user-select を付けない）',
    !/(^|\n)\s*(body|html|input|textarea)\s*\{[^}]*user-select/.test(css))
  ok('#9991 ビルドした style.css に入っている', /body\.is-dragging/.test(built) && /touch-callout:none/.test(built.replace(/\s/g, '')))
}
{
  ok('#9995 スタッフアプリ: 画面の名前・その他のメニューを「資料・マニュアル」に（説明は「案件マニュアル・注意事項など」）',
    staffJs.includes("staffScreen('manual', { title: '資料・マニュアル', nav: 'more', render: () => renderManual(),\n  more: { order: 70, icon: 'fa-book-open', label: '資料・マニュアル', sub: '案件マニュアル・注意事項など' } })"))
  ok('#9995 スタッフアプリ: 画面の見出しも「資料・マニュアル」', /<i class="fas fa-book-open text-primary-600 mr-1"><\/i>資料・マニュアル<\/h2>/.test(staffJs))
  ok('#9995 管理画面: 案件詳細の編集の説明は「スタッフアプリの『資料・マニュアル』に出ます」',
    adminJs.includes("['requirements', '求められる内容', 2000, 'スタッフアプリの「資料・マニュアル」に出ます'],")
    && adminJs.includes("['manual_text', '案件マニュアル・注意事項', 5000, 'スタッフアプリの「資料・マニュアル」に出ます（集合場所・服装・持ち物・現場のルールなど）'],"))
  const note = '<p class="text-2xs text-neutral-400 mt-1">スタッフアプリの「資料・マニュアル」に出ます（その案件のシフトに入っているスタッフが見られます）</p></div>'
  ok('#9995 管理画面: 案件の新規・編集の「案件マニュアル・注意事項」の欄の下に、スタッフアプリの「資料・マニュアル」に出ることを書く',
    adminJs.includes('<textarea id="np-manual" rows="3" class="inp" maxlength="5000" placeholder="集合場所・服装・持ち物・現場のルールなど"></textarea>\n        ' + note)
    && adminJs.includes('<textarea id="ep-manual" rows="4" class="inp" maxlength="5000">${esc(p.manual_text || \'\')}</textarea>\n        ' + note))
  // 「研修・マニュアル」という呼び名をどこにも残さない（コメント・docs・テストも）
  let left = ''
  try { left = execFileSync('git', ['grep', '-n', '研修・マニュアル', '--', '.', ':!scripts/test-w32-ui-small.mjs'], { cwd: ROOT, encoding: 'utf8' }) } catch (e) { left = e.status === 1 ? '' : String(e.stdout || e.message) }
  ok('#9995 「研修・マニュアル」という呼び名が残っていない（git grep）', left.trim() === '', left)
  ok('#9995 「研修資料」の説明も残っていない', !/研修資料/.test(staffJs))
}

// ---------- API ----------
const PFX = 'W32U' + Date.now().toString(36).slice(-4).toUpperCase()
const NEWPW = 'W32-staff-pass-2026'
const adminCk = await login('sample', 'admin')
const admin = client(adminCk)
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  const st = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
  const c0 = client(await login('sample', `${PFX}${k}`))
  must(await c0.post('/api/auth/change-password', { current_password: 'pass1234', new_password: NEWPW }), 'change pw ' + k)
  const ck = await login('sample', `${PFX}${k}`, NEWPW)
  must(await client(ck).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] }), 'tour ' + k)
  return { ...st, ck, api: client(ck) }
}
const MANUAL = `${PFX} 開店30分前に集合。黒のスーツ。`
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
const pj = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: cl.client_id, unit_price: 10000, allow_duplicate: true, manual_text: MANUAL, requirements: `${PFX} 笑顔で接客` }), 'project')
const P = pj.project_id
must(await admin.put(`/api/admin/projects/${P}/pricing`, { engagement_type: 'regular', unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000 }), 'pricing')
const A = await newStaff('A'), C = await newStaff('C')
let W = addDays(today, 7); while (weekday(W) !== 1) W = addDays(W, 1)
must(await admin.post('/api/admin/shift-slots', { project_id: P, dates: [W, addDays(W, 1)], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'slots')
const boardOf = async () => must(await admin.get(`/api/admin/shift-board?from=${W}&to=${addDays(W, 6)}&project_ids=${P}`), 'board')
const slots = (await boardOf()).slots.filter(s => s.start_time === '10:00').sort((a, b) => a.work_date.localeCompare(b.work_date))
const [S1, S2] = slots
must(await admin.post(`/api/admin/shift-slots/roles/${S1.roles[0].slot_role_id}/assign`, { staff_ids: [A.staff_id], force: true }), 'assign')
const aShift = (await boardOf()).slots.find(s => s.slot_id === S1.slot_id).roles[0].assigned[0].shift_id
{
  const m = must(await A.api.get('/api/staff/manuals'), 'manuals').projects || []
  const p = m.find(x => x.project_id === P)
  ok('#9995 API: スタッフの「資料・マニュアル」に、シフトに入っている案件の案件マニュアル・注意事項が出る（名前を変えても中身は今のまま）', p && p.manual_text === MANUAL && /笑顔で接客/.test(p.requirements || ''), m)
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const lib = await import('./lib/chrome.mjs')
  const PORT = await lib.freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w32u-'))
  const chrome = await lib.launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1900,1100', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    // ===== #9991 管理画面のシフト表 =====
    await client(adminCk).put('/api/admin/tours', { items: [{ key: 'admin-welcome', status: 'skipped' }, { key: 'admin-checklist', status: 'skipped' },
      ...['dashboard', 'clients', 'projects', 'staff', 'shifts', 'reports', 'corrections', 'settlement'].map(s => ({ key: `admin-screen-${s}`, status: 'done' }))] })
    await as(adminCk)
    await send('Page.navigate', { url: `${BASE}/admin#shifts` }); await wait(3500)
    await ev(`(async () => { Object.assign(__boardState, { from: '${W}', range: 'week', view: 'slot', projectIds: [${P}], onlyShort: false, bulkDel: false, sel: null }); window.__boardDrafts.clear(); window.__boardShiftOps.clear(); await renderShiftBoard() })()`)
    ok('（前提）シフト表が描ける', await until(`document.querySelectorAll('#board-grid .board-cell').length >= 2`))
    const center = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 10) } })()`)
    const rectOf = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    const mouse = (type, p) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' })
    const state = () => ev(`({ cls: document.body.classList.contains('is-dragging'), sel: String(window.getSelection()), us: getComputedStyle(document.querySelector('#board-grid')).userSelect })`)
    // ドラッグ: 押す → 通り道（via。文字のある所）を通る → 落とす場所で待つ → 離す。途中で mid() を呼んで様子を見る
    async function drag(fromSel, via, to, mid) {
      const a = await center(fromSel); if (!a) return null
      await mouse('mousePressed', a)
      const atPress = await state()
      for (let i = 1; i <= 4; i++) { await mouse('mouseMoved', { x: a.x + i * 3, y: a.y + i * 3 }); await wait(30) }
      for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', { x: a.x + (via.x - a.x) * i / 10, y: a.y + (via.y - a.y) * i / 10 }); await wait(30) }
      const atMid = mid ? await mid() : await state()
      const b = typeof to === 'function' ? await to() : to
      for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', { x: via.x + (b.x - via.x) * i / 10, y: via.y + (b.y - via.y) * i / 10 }); await wait(30) }
      await wait(250)
      await mouse('mouseReleased', b); await wait(400)
      return { atPress, atMid, after: await state() }
    }
    ok('#9991 画面: ドラッグしていない時は、表の文字を選べる（user-select は none でない）', (await state()).us !== 'none' && !(await state()).cls, await state())
    // 前もって表の文字を選んでおき、割り当て済みの人を、表の見出し（文字のある所）の上を通って「ここへドラッグで外す」へ
    await ev(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#board-grid')); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })()`)
    const preSel = await ev(`String(getSelection()).length`)
    const via = await ev(`(() => { const els = [...document.querySelectorAll('#board-grid th, #board-grid .board-need, #board-grid .board-cell')].filter(e => e.textContent.trim()); const r = els[0].getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 } })()`)
    const d1 = await drag(`.board-cell[data-slot-id="${S1.slot_id}"] .shift-chip[data-shift-id="${aShift}"]`, via,
      () => rectOf('#board-trash'),
      () => ev(`({ cls: document.body.classList.contains('is-dragging'), sel: String(window.getSelection()), us: getComputedStyle(document.querySelector('#board-grid')).userSelect, trash: getComputedStyle(document.getElementById('board-trash')).display, ghost: !!document.querySelector('.sortable-fallback, .sortable-drag') })`))
    ok('#9991 画面: 押した時に body に is-dragging が付き、前から選んでいた文字は外れる', preSel > 0 && d1 && d1.atPress.cls && d1.atPress.sel === '', { preSel, d1 })
    ok('#9991 画面: ドラッグ中（文字の上を通っても）は文字が選択されず、表の文字は選べない（user-select: none）', d1 && d1.atMid.cls && d1.atMid.sel === '' && d1.atMid.us === 'none' && d1.atMid.trash === 'flex', d1 && d1.atMid)
    ok('#9991 画面: 離すと is-dragging が外れ、文字を選べる状態に戻る（ドラッグ自体は今のまま「外す」の下書きになる）',
      d1 && !d1.after.cls && d1.after.us !== 'none' && await ev(`(window.__boardShiftOps.get(${aShift}) || {}).kind === 'remove'`), d1 && d1.after)
    await ev(`(async () => { window.__boardShiftOps.clear(); await renderShiftBoard() })()`)
    await until(`!!document.querySelector('.shift-chip[data-shift-id="${aShift}"]')`)
    // 押してすぐ離した（ドラッグしなかった）時も、印は残らない
    {
      const a = await center(`.shift-chip[data-shift-id="${aShift}"]`)
      await mouse('mousePressed', a); const pressed = await state(); await mouse('mouseReleased', a); await wait(400)
      const released = await state()
      await ev(`typeof closeModal === 'function' && closeModal()`); await wait(200)
      ok('#9991 画面: 押してすぐ離した時も、is-dragging は外れる（onUnchoose）', pressed.cls && !released.cls, { pressed, released })
    }
    // 右の欄の候補から表へのドラッグも同じ
    await ev(`document.querySelector('.board-cell[data-slot-id="${S2.slot_id}"]').click()`)
    const candOk = await until(`!!document.querySelector('#cand-list .cand-item[data-staff-id="${C.staff_id}"]')`, 10000)
    if (!candOk) ok('（前提）右の欄に候補が出る', false)
    else {
      await ev(`(() => { const q = document.getElementById('cand-q'); q.value = '${PFX} C'; q.dispatchEvent(new Event('input', { bubbles: true })) })()`); await wait(300)
      const candStyle = await ev(`(() => { const c = getComputedStyle(document.querySelector('#cand-list .cand-item')); return { us: c.userSelect, callout: c.webkitTouchCallout || c.getPropertyValue('-webkit-touch-callout') } })()`)
      ok('#9991 画面: 候補・チップは長押しで文字を選ばない（user-select: none）', candStyle.us === 'none', candStyle)
      const r1 = S1.roles[0].slot_role_id
      const via2 = await ev(`(() => { const r = document.querySelector('#board-side').getBoundingClientRect(); return { x: r.left + 30, y: r.top + 20 } })()`)
      const d2 = await drag(`#cand-list .cand-item[data-staff-id="${C.staff_id}"]`, via2, await rectOf(`.board-drop[data-slot-role-id="${r1}"]`))
      ok('#9991 画面: 候補のスタッフをドラッグしている間も文字が選択されず、離すと印が外れる（追加の下書きは今のまま）',
        d2 && d2.atPress.cls && d2.atMid.cls && d2.atMid.sel === '' && !d2.after.cls && await ev(`window.__boardDrafts.has('${r1}:${C.staff_id}')`), d2)
      const q = await ev(`(() => { const q = document.getElementById('cand-q'); q.value = 'abcdef'; q.focus(); q.setSelectionRange(1, 4); return { us: getComputedStyle(q).userSelect, sel: q.value.slice(q.selectionStart, q.selectionEnd) } })()`)
      ok('#9991 画面: ドラッグの後も、入力欄の文字は選べる', q.us !== 'none' && q.sel === 'bcd', q)
      await ev(`window.__boardDrafts.clear()`)
    }
    ok('#9991 画面: スクリプトのエラーがない', !errors.length, errors)

    // ===== #9995 管理画面の案件の新規登録 =====
    errors = []
    await send('Page.navigate', { url: `${BASE}/admin#projects` }); await wait(3000)
    await ev(`showAddProject()`)
    ok('#9995 画面: 案件の新規登録の「案件マニュアル・注意事項」の欄の下に、スタッフアプリの「資料・マニュアル」に出ると書いてある',
      await until(`(() => { const t = document.getElementById('np-manual'); return !!t && /スタッフアプリの「資料・マニュアル」に出ます/.test(t.parentElement.textContent) })()`), await ev(`(document.getElementById('np-manual') || {}).parentElement?.textContent`))
    await ev(`closeModal()`)

    // ===== #9995 スタッフアプリ =====
    await send('Page.navigate', { url: 'about:blank' }); await wait(300)
    await as(A.ck)
    await send('Page.navigate', { url: `${BASE}/staff#more` })
    ok('（前提）スタッフアプリの「その他」が開く', await until(`!!document.querySelector('a[href="#manual"]')`, 20000))
    const more = await ev(`document.querySelector('a[href="#manual"]').textContent.replace(/\\s+/g, ' ').trim()`)
    ok('#9995 画面: 「その他」のメニューは「資料・マニュアル」（説明は「案件マニュアル・注意事項など」）', /資料・マニュアル/.test(more) && /案件マニュアル・注意事項など/.test(more) && !/研修/.test(more), more)
    await ev(`location.hash = 'manual'`)
    ok('#9995 画面: 「資料・マニュアル」の画面に、管理画面で登録した案件マニュアル・注意事項が出る', await until(`!!document.getElementById('manual-list') && document.body.innerText.includes(${JSON.stringify(MANUAL)})`, 15000))
    const scr = await ev(`({ h2: document.querySelector('#app h2').textContent.trim(), body: document.body.innerText })`)
    ok('#9995 画面: 画面の見出し・上の名前が「資料・マニュアル」で、「研修・マニュアル」はどこにも出ない', /資料・マニュアル/.test(scr.h2) && !/研修・マニュアル/.test(scr.body), scr.h2)
    ok('#9995 画面: スクリプトのエラーがない', !errors.length, errors)
  } finally {
    try { ws && ws.close() } catch { }
    chrome.kill()
    await wait(500)
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
