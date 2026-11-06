// ダッシュボード（利用者の要望 Sprint 17・w17-dashboard）の統合テスト
//   #9904 読み込みを速くする（問い合わせを db.batch にまとめる。結果は今までと同じ）・更新しても前の表示を残す
//   #9905 上部の「すべての案件／案件ごと（クライアントごと）」の絞り込み。売上（月額（固定）を含む）・未報告・日報など案件で分けられる数字を、
//         選んだ案件で出す。管理者ToDo・要フォロースタッフは会社全体のまま。選んだ案件はその管理者の端末（localStorage）に覚える
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること（追加の起動オプションはない）
// 実行: BASE=http://127.0.0.1:8813 node scripts/test-w17-dashboard.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
//   今日・昨日のシフトを足すので、テストのたびに DB を作り直すこと（npm test -- w17-dashboard なら自動で行う）
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8813'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const staticJs = async (name) => (await fetch(`${BASE}/static/${name}`)).text()

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000)
const today = jstNow().toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1)
const hhmm = (offsetMin) => new Date(jstNow().getTime() + offsetMin * 60000).toISOString().slice(11, 16)
const PFX = 'W17D' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const dash = async (q = '') => must(await admin.get('/api/admin/dashboard' + q), 'dashboard ' + q)

// ---------- 画面のコード ----------
{
  const a = await staticJs('admin.js')
  ok('#9905 画面: ダッシュボードの上部に案件の絞り込み（すべての案件／クライアント／案件）', a.includes('id="dash-scope"') && a.includes("opt('', 'すべての案件')") && a.includes("'c:' + Number(g.client_id)") && a.includes("'p:' + Number(p.project_id)"))
  ok('#9905 画面: 選んだ案件は管理者ごとに localStorage に覚える（使えないときも動く）', a.includes("'admin-dash-scope:'") && /function dashScopeSave[\s\S]{0,200}try \{/.test(a) && /function dashScopeLoad[\s\S]{0,200}try \{/.test(a))
  ok('#9904 画面: 更新は前の表示を残して薄くし、ボタンを回す（画面を真っ白にしない）', a.includes('function dashSetBusy(on)') && a.includes("'opacity-60'") && a.includes("'fa-spin'") && /if \(refreshing\) dashSetBusy\(true\)\s*\n\s*else loading\(\)/.test(a))
  ok('#9904 画面: 後から始めた読み込みだけを描く', a.includes('seq !== DASH_SEQ'))
  ok('画面: 更新ボタンはイベント属性に処理を書かない（data-action）', a.includes('data-action="dashRefresh"') && !a.includes('onclick="renderDashboard()"'))
  ok('画面: 案内（tour.js）が指すダッシュボードの要素を残す', ['id="kpi-cards"', 'id="unreported-section"', 'id="todo-section"', 'id="today-shifts"', 'id="dash-ahead"'].every(s => a.includes(s)) && a.includes('FosTour.dashboard()'))
}

// ---------- 準備: クライアント・案件・シフト ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX} クライアント` }), 'client')
const CL = must(await admin.get('/api/admin/settlement/options'), 'options').clients.find(c => c.client_name === `${PFX} クライアント`).client_id
const PA = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-A`, client_id: CL, unit_price_type: 'daily', unit_price: 11000 }), 'project A').project_id
const PB = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-B`, client_id: CL, unit_price_type: 'daily', unit_price: 23000 }), 'project B').project_id
const PC = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-C`, client_id: 1, unit_price_type: 'daily', unit_price: 7000 }), 'project C').project_id
async function createShift(staff_id, project_id, work_date, start_time, end_time) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo: PFX, force: true })
  if (r.status !== 200) throw new Error('createShift ' + r.text.slice(0, 300))
  return r.data.shift_id
}
// 今日のシフト: 開始を少し前にして、入店が未報告になるようにする（0時台は開始を今日の 0:00 にする）
const early = jstNow().getUTCHours() * 60 + jstNow().getUTCMinutes() < 40
const st = early ? '00:00' : hhmm(-30), en = early ? '08:00' : hhmm(240)
const SA = await createShift(1, PA, today, st, en)
const SB = await createShift(3, PB, today, st, en)
const SC = await createShift(4, PC, today, st, en)
// 昨日のシフト（日報が未提出のまま）: B の案件
const SBY = await createShift(5, PB, yesterday, '09:00', '18:00')

// ---------- #9905 絞り込み ----------
const all = await dash()
const dA = await dash(`?project_id=${PA}`), dB = await dash(`?project_id=${PB}`), dC = await dash(`?project_id=${PC}`)
const dCL = await dash(`?client_id=${CL}`)
{
  ok('#9905 絞り込みなしは scope が null・選択肢に進行中の案件（クライアント付き）', all.scope === null && all.scope_invalid === false
    && all.scope_options.some(p => p.project_id === PA && p.client_id === CL && p.client_name === `${PFX} クライアント` && p.active), all.scope)
  ok('#9905 案件で絞ると scope にその案件', dA.scope && dA.scope.project_id === PA && dA.scope.client_id === null && dA.scope.label === `${PFX}-A`, dA.scope)
  ok('#9905 クライアントで絞ると scope にそのクライアント', dCL.scope && dCL.scope.client_id === CL && dCL.scope.project_id === null && dCL.scope.label === `${PFX} クライアント`, dCL.scope)
  ok('#9905 本日のシフトは選んだ案件のものだけ', dA.shifts.length > 0 && dA.shifts.every(s => s.project_id === PA) && dA.shifts.some(s => s.shift_id === SA) && !dA.shifts.some(s => s.shift_id === SB), dA.shifts.map(s => s.project_id))
  ok('#9905 クライアントで絞ると、そのクライアントの案件のシフトだけ', dCL.shifts.length === 2 && dCL.shifts.every(s => [PA, PB].includes(s.project_id)), dCL.shifts.map(s => s.project_id))
  ok('#9905 稼働予定の人数・シフトの数も選んだ案件で数える', dA.working_count === 1 && dA.working_shift_count === 1 && dCL.working_count === 2 && all.working_count >= 3, [dA.working_count, dCL.working_count, all.working_count])
  ok('#9905 売上予定は案件ごとに分かれ、すべての案件は各案件の合計', dA.revenue_forecast >= 11000 && dB.revenue_forecast >= 23000 && dA.revenue_forecast !== dB.revenue_forecast
    && all.revenue_forecast === dA.revenue_forecast + dB.revenue_forecast + dC.revenue_forecast && dCL.revenue_forecast === dA.revenue_forecast + dB.revenue_forecast,
    [all.revenue_forecast, dA.revenue_forecast, dB.revenue_forecast, dC.revenue_forecast, dCL.revenue_forecast])
  const unA = Object.values(dA.unreported).flat(), unAll = Object.values(all.unreported).flat()
  ok('#9905 出発・入店などの未報告は選んだ案件の人だけ', unA.length > 0 && unA.every(x => x.project_id === PA) && dA.unreported.check_in.some(x => x.shift_id === SA)
    && unAll.some(x => x.shift_id === SB) && !unA.some(x => x.shift_id === SB), dA.unreported)
  ok('#9905 日報未提出は選んだ案件のものだけ', dB.missing_daily_reports.some(r => r.shift_id === SBY) && !dA.missing_daily_reports.some(r => r.shift_id === SBY)
    && all.missing_daily_reports.some(r => r.shift_id === SBY) && dA.missing_daily_reports.every(r => r.project_id === PA), dB.missing_daily_reports)
  ok('#9905 今月の案件別実績は選んだ案件の行だけ', dA.project_performance.length === 1 && dA.project_performance[0].project_id === PA && all.project_performance.length > 1, dA.project_performance.map(p => p.project_id))
  ok('#9905 管理者ToDo は会社全体のまま（絞り込んでも同じ）', JSON.stringify(dA.todos.map(t => t.key).sort()) === JSON.stringify(all.todos.map(t => t.key).sort())
    && all.todos.some(t => t.key === 'daily_report:5'), [dA.todos.length, all.todos.length])
  ok('#9905 要フォロースタッフ・相談の件数は会社全体のまま', JSON.stringify(dA.follow_staff) === JSON.stringify(all.follow_staff) && JSON.stringify(dA.consultation_counts) === JSON.stringify(all.consultation_counts))
  ok('#9905 人員不足・希望（仮）の一覧は選んだ案件のものだけ', dA.staffing_ahead.short_roles.every(r => r.project_id === PA) && dA.staffing_ahead.requested_shifts.every(s => s.project_id === PA))
  // 未確認の日報: 日報一覧の「未確認のみ」の件数と同じ
  const r1 = must(await admin.get('/api/admin/daily-reports?project_id=1&limit=1'), 'reports p1').counts.unchecked
  const rAll = must(await admin.get('/api/admin/daily-reports?limit=1'), 'reports all').counts.unchecked
  const d1 = await dash('?project_id=1')
  ok('#9905 未確認の日報の件数は選んだ案件で数える（日報一覧の未確認の件数と同じ）', d1.unchecked_daily_reports === r1 && all.unchecked_daily_reports === rAll && r1 <= rAll, [d1.unchecked_daily_reports, r1, all.unchecked_daily_reports, rAll])
  const inc1 = d1.incidents
  ok('#9905 インシデント・クレームは選んだ案件のものだけ', inc1.every(i => i.project_id === 1) && all.incidents.length >= inc1.length)
}
// 見つからない・他社の案件やクライアントは、すべての案件で返す（scope_invalid）
{
  const bad = await dash('?project_id=99999999')
  ok('#9905 見つからない案件は、すべての案件で返して scope_invalid', bad.scope === null && bad.scope_invalid === true && bad.working_count === all.working_count && bad.revenue_forecast === all.revenue_forecast, [bad.scope, bad.scope_invalid])
  const badC = await dash('?client_id=99999999')
  ok('#9905 見つからないクライアントも同じ', badC.scope === null && badC.scope_invalid === true)
  const junk = await dash('?project_id=abc')
  ok('#9905 数字でない指定は絞り込まない（エラーにしない）', junk.scope === null && junk.scope_invalid === false && junk.working_count === all.working_count)
  // 他社の案件: 本部で2社目を作り、その管理者で会社1の案件 PA を指定する
  const hq = client(await login('sample', 'hq'))
  const code = ('w17d' + Date.now().toString(36).slice(-5)).toLowerCase()
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX} 2社目`, admin_code: 'boss', admin_password: 'pass1234', admin_email: `boss-${code}@example.com`, admin_name: '2社目 管理者', user_limit: '' }), 'create company')
  const boss = client(await login(code, 'boss'))
  must(await boss.post('/api/auth/change-password', { current_password: 'pass1234', new_password: 'W17d-pass-2026' }), 'change pw')
  const o = must(await boss.get(`/api/admin/dashboard?project_id=${PA}`), 'other dashboard')
  ok('#9905 他社の案件の ID では絞り込めない（自社のすべての案件で返し、他社の案件は選択肢にも出ない）', o.scope === null && o.scope_invalid === true && !o.shifts.some(s => s.project_id === PA)
    && !o.scope_options.some(p => p.project_id === PA) && o.revenue_forecast === 0, o.scope)
  const oc = must(await boss.get(`/api/admin/dashboard?client_id=${CL}`), 'other dashboard client')
  ok('#9905 他社のクライアントの ID でも絞り込めない', oc.scope === null && oc.scope_invalid === true)
}

// ---------- #9905 月額（固定）の売上も案件で分かれる ----------
{
  must(await admin.post('/api/admin/settlement/monthly-rules', { project_id: PA, amount: 50000, memo: PFX }), 'monthly rule A')
  const a2 = await dash(`?project_id=${PA}`), b2 = await dash(`?project_id=${PB}`), all2 = await dash(), cl2 = await dash(`?client_id=${CL}`)
  ok('#9905 月額（固定）は、今日がその月の最初の稼働日の案件の売上予定に入る', a2.revenue_monthly === 50000 && a2.revenue_forecast === dA.revenue_forecast + 50000, [a2.revenue_monthly, a2.revenue_forecast, dA.revenue_forecast])
  ok('#9905 月額はほかの案件の売上予定には入らない', b2.revenue_monthly === 0 && b2.revenue_forecast === dB.revenue_forecast, [b2.revenue_monthly, b2.revenue_forecast])
  ok('#9905 すべての案件・クライアントの売上予定にも月額が入る', all2.revenue_monthly === all.revenue_monthly + 50000 && all2.revenue_forecast === all.revenue_forecast + 50000
    && cl2.revenue_forecast === dCL.revenue_forecast + 50000, [all2.revenue_monthly, all2.revenue_forecast, cl2.revenue_forecast])
  // その月の最初の稼働日が今日でない（前日にシフトがある）案件の月額は、今日の売上予定に入れない（精算で計上する日と同じ）
  if (today.slice(0, 7) === yesterday.slice(0, 7)) {
    must(await admin.post('/api/admin/settlement/monthly-rules', { project_id: PB, amount: 30000, memo: PFX }), 'monthly rule B')
    const b3 = await dash(`?project_id=${PB}`)
    ok('#9905 その月の最初の稼働日が今日より前の案件の月額は、今日の売上予定に入れない', b3.revenue_monthly === 0 && b3.revenue_forecast === dB.revenue_forecast, [b3.revenue_monthly, b3.revenue_forecast])
  } else console.log('SKIP  月の最初の稼働日が前日の月額の確認（今日は月の1日）')
}

// ---------- #9904 応答の形・重さ ----------
{
  const t0 = Date.now(); const again = await dash(); const ms = Date.now() - t0
  ok('#9904 応答の項目は今までどおり（画面が使う項目がそろっている）', ['today', 'month', 'now', 'working_count', 'working_shift_count', 'revenue_forecast', 'shifts', 'absent_shifts', 'unreported', 'missing_daily_reports',
    'unchecked_daily_reports', 'staffing_ahead', 'day_before', 'incidents', 'follow_staff', 'performance_fields', 'performance_field_count', 'project_performance', 'consultation_counts', 'todos', 'hidden_todos',
    'photo_required_attendance', 'photo_required_changed'].every(k => k in again))
  const s = again.shifts.find(x => x.shift_id === SA)
  ok('#9904 本日のシフトの報告状況の列（有効な報告・未報告の種類）は今までどおり', s && Array.isArray(s.required_types) && s.required_types.length > 0 && Array.isArray(s.overdue_types) && s.overdue_types.includes('check_in')
    && !('window' in s) && s.carried_over === false && typeof s.reports === 'object', s)
  const u = again.unreported.check_in.find(x => x.shift_id === SA)
  ok('#9904 未報告の予定の時刻・経過の分数は今までどおり（開始の時刻・経過した分）', u && u.due_at === `${today} ${st}:00` && u.overdue_minutes >= 0 && u.overdue_minutes <= (early ? 60 : 40), u)
  console.log(`INFO  ダッシュボードの応答 ${ms}ms`)
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w17d-'))
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
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w17-dashboard-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const ck = await login('sample', 'admin')
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    // 案内（はじめての案内・画面の案内・はじめにやること）は済んだことにしておく（src/tours.ts）
    await admin.put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-screen-dashboard'].map(key => ({ key, status: 'skipped', step: 0 })) })
    await send('Page.navigate', { url: `${BASE}/admin#dashboard` })
    await until(`!!document.getElementById('dash-scope') && !!document.getElementById('kpi-cards')`, 40000)
    await wait(500)
    ok('#9905 画面: 上部に案件の絞り込み（すべての案件・クライアントの案件すべて・案件）', await ev(`(() => { const o = [...document.querySelectorAll('#dash-scope option')].map(x => x.value); return o[0] === '' && o.includes('p:${PA}') && o.includes('c:${CL}') && o.includes('p:${PC}') })()`))
    await shot('all')
    // 案件 A を選ぶ
    await ev(`(() => { const s = document.getElementById('dash-scope'); s.value = 'p:${PA}'; s.dispatchEvent(new Event('change')) })()`)
    await until(`!!document.querySelector('#dash-head .fa-filter') && document.getElementById('dash-body').getAttribute('aria-busy') !== 'true'`, 15000)
    const body = await ev(`document.getElementById('dash-body').innerText`)
    ok('#9905 画面: 選んだ案件の表示であることと、ToDo・要フォローは会社全体であることを出す', await ev(`document.getElementById('dash-head').innerText.includes('${PFX}-A') && document.getElementById('dash-head').innerText.includes('管理者ToDo・要フォロースタッフは会社全体')`))
    ok('#9905 画面: 売上予定に月額（固定）の内訳を出す', /うち月額（固定）/.test(body) && /¥\s?6[0-9],[0-9]{3}|6[0-9],[0-9]{3}/.test(body), body.slice(0, 400))
    ok('#9905 画面: 本日のシフトの表は選んだ案件の行だけ', await ev(`[...document.querySelectorAll('#dash-shift-rows tr')].every(tr => tr.innerText.includes('${PFX}-A'))`))
    ok('#9905 画面: 選んだ案件をこの端末に覚える', (await ev(`localStorage.getItem('admin-dash-scope:' + ME.company_id + ':' + ME.user_id)`)) === `p:${PA}`)
    await shot('project-a')
    // 読み込み直しても、選んだ案件のまま
    await send('Page.reload')
    await until(`!!document.getElementById('dash-scope') && !!document.getElementById('kpi-cards')`, 40000)
    await wait(500)
    ok('#9905 画面: 開き直しても選んだ案件で表示する', (await ev(`document.getElementById('dash-scope').value`)) === `p:${PA}` && await ev(`!!document.querySelector('#dash-head .fa-filter')`))
    // 更新: 前の表示を残したまま、読み込み中を出す
    const busySeen = await ev(`new Promise(res => {
      const body = document.getElementById('dash-body'); let seen = false
      const mo = new MutationObserver(() => { const b = document.getElementById('dash-body'); if (b && b.getAttribute('aria-busy') === 'true' && b.classList.contains('opacity-60') && document.getElementById('kpi-cards')) seen = true })
      mo.observe(body, { attributes: true })
      document.getElementById('dash-refresh').click()
      const t0 = Date.now(); const tick = () => { const b = document.getElementById('dash-body'); if (b && b !== body && b.getAttribute('aria-busy') !== 'true') { mo.disconnect(); res({ seen, kept: true }) } else if (Date.now() - t0 > 15000) { mo.disconnect(); res({ seen, kept: false }) } else setTimeout(tick, 50) }
      tick()
    })`)
    ok('#9904 画面: 更新中も前の表示（数字の欄）を残し、薄くして読み込み中を出す', busySeen && busySeen.seen && busySeen.kept, busySeen)
    ok('#9904 画面: 更新しても上の「はじめにやること」などは消えず、表示は1つだけ', await ev(`document.querySelectorAll('#dash-head').length === 1 && document.querySelectorAll('#dash-body').length === 1 && document.querySelectorAll('#kpi-cards').length === 1`))
    // すべての案件に戻す
    await ev(`document.querySelector('[data-action="dashScopeClear"]').click()`)
    await until(`document.getElementById('dash-scope').value === '' && !document.querySelector('#dash-head .fa-filter')`, 15000)
    ok('#9905 画面: 「すべての案件に戻す」で全案件に戻し、覚えた案件も消す', (await ev(`localStorage.getItem('admin-dash-scope:' + ME.company_id + ':' + ME.user_id)`)) === null)
    // スマホの幅で横にはみ出さない
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await wait(600)
    ok('#9905 画面: スマホの幅でも上部の絞り込みが横にはみ出さない', await ev(`(() => { const s = document.getElementById('dash-scope').getBoundingClientRect(); return s.right <= document.documentElement.clientWidth + 0.5 && s.left >= 0 })()`))
    await shot('mobile')
    await send('Emulation.clearDeviceMetricsOverride')
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
