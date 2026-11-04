// シフト管理（w15-shift: Sprint 15 #9705 #9706 #9708）の統合テスト
//   #9705 帯で入れた枠・シフトの削除: 帯の範囲（GET /api/admin/shift-slots/:id/band・GET /api/admin/shifts/:id/band）、
//         枠のまとめて削除で割り当て済みのシフトも削除（delete_shifts。報告のあるシフトは残す）、シフトのまとめて削除（POST /api/admin/shifts/bulk-delete）
//   #9706 ドラッグを下書きにし、「まとめて保存」で反映する（ドロップのたびにサーバーを呼ばない。移動・外す・追加）
//   #9708 エラー・「できない」理由のトーストは長めに出し、✕ で閉じられる（common.js。成功の短い知らせは今のまま）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w15-shift.mjs
//   画面の確認（ドラッグ・帯の削除・トースト）は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8811'
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200 || r.data == null) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

const PFX = 'W15S' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
async function newProject(tag) {
  const r = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${tag}`, client_id: cl.client_id, unit_price: 10000, allow_duplicate: true }), 'project')
  must(await admin.put(`/api/admin/projects/${r.project_id}/pricing`, { engagement_type: 'regular', unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000 }), 'pricing')
  return r.project_id
}
const board = async (pid, from, to = from) => must(await admin.get(`/api/admin/shift-board?from=${from}&to=${to}&project_ids=${pid}`), 'board')
async function slotsOn(pid, from, to, start) { return (await board(pid, from, to)).slots.filter(s => !start || s.start_time === start) }
async function newSlots(pid, dates, start = '10:00', end = '18:00', roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates, start_time: start, end_time: end, roles }), 'slot')
  const sorted = [...dates].sort()
  return (await slotsOn(pid, sorted[0], sorted[sorted.length - 1], start)).filter(s => s.end_time === end && dates.includes(s.work_date))
}
const assign = async (rid, sid) => must(await admin.post(`/api/admin/shift-slots/roles/${rid}/assign`, { staff_ids: [sid], force: true }), 'assign')
const proxy = (id, t, time) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: [t], time })
const bulkShiftDelete = (body) => admin.post('/api/admin/shifts/bulk-delete', body)

let MON = addDays(today, 60); while (weekday(MON) !== 1) MON = addDays(MON, 1)
const P = await newProject('案件A')
const A = await newStaff('A'), B = await newStaff('B'), C = await newStaff('C')

// ---------- #9705 枠の帯の範囲 ----------
{
  // 繰り返し登録（月・水 × 3週 = 6枠）
  const pt = must(await admin.post('/api/admin/slot-patterns', { project_id: P, start_time: '09:00', end_time: '17:00', roles: [{ role_name: '販売', headcount: 2 }], weekdays: [1, 3], date_from: MON, date_to: addDays(MON, 20) }), 'pattern')
  ok('（前提）繰り返し登録で6枠', pt.slots === 6, pt)
  const ps = await slotsOn(P, MON, addDays(MON, 20), '09:00')
  await assign(ps[1].roles[0].slot_role_id, A.staff_id)
  const band = must(await admin.get(`/api/admin/shift-slots/${ps[0].slot_id}/band`), 'band')
  ok('#9705 繰り返し登録の枠の帯は、同じ登録の枠（kind=pattern・6件）', band.kind === 'pattern' && band.pattern?.pattern_id === pt.pattern_id && band.scopes.all.slots === 6 && band.scopes.today.slots === 6 && band.scopes.one.slots === 1, band)
  ok('#9705 帯の確認に、割り当て済みの人数・名前・削除できるシフトの数を出す', band.scopes.all.assigned === 1 && band.scopes.all.names.includes(A.name) && band.scopes.all.deletable_shifts === 1 && band.scopes.one.assigned === 0, band.scopes)
  ok('#9705 帯の枠の ID は日付の順', band.scopes.all.slot_ids.join() === ps.map(s => s.slot_id).join() && band.scopes.all.first_date === MON, { ids: band.scopes.all.slot_ids, ps: ps.map(s => s.slot_id) })

  // 日付を複数選んで作った枠（繰り返し登録なし）: 同じ案件・開催場所・時間の枠
  const W2 = addDays(MON, 28)
  const rs = await newSlots(P, [W2, addDays(W2, 1), addDays(W2, 2)], '13:00', '20:00')
  const other = await newSlots(P, [W2], '13:00', '21:00')
  const rb = must(await admin.get(`/api/admin/shift-slots/${rs[1].slot_id}/band`), 'row band')
  ok('#9705 繰り返し登録でない枠の帯は、同じ案件・開催場所・時間の枠（表の同じ行。時間の違う枠は入らない）', rb.kind === 'row' && rb.scopes.all.slots === 3 && !rb.scopes.all.slot_ids.includes(other[0].slot_id), rb.scopes.all)
  // 他社の枠は見られない
  const r404 = await admin.get('/api/admin/shift-slots/999999991/band')
  ok('#9705 ない枠の帯は 404', r404.status === 404, r404.data)

  // 帯のすべてを削除（画面と同じ: 枠のまとめて削除 → 繰り返し登録の削除）。割り当て済みのシフトも削除（delete_shifts）
  let r = await admin.post('/api/admin/shift-slots/bulk-delete', { slot_ids: band.scopes.all.slot_ids, delete_shifts: true })
  ok('#9705 シフトも削除するときは、残るシフトがなければ force なしで削除できる', r.status === 200 && r.data.deleted === 6 && r.data.deleted_shifts === 1 && r.data.kept_shifts === 0, r.data)
  const after = await board(P, MON, addDays(MON, 20))
  ok('#9705 帯の枠と、割り当て済みのシフトが消える（枠なしで残らない）', !after.slots.some(s => s.start_time === '09:00') && !after.unslotted.some(s => s.staff_id === A.staff_id), { slots: after.slots.length, un: after.unslotted.length })
  must(await admin.del(`/api/admin/slot-patterns/${pt.pattern_id}?remove_future=0`), 'pattern delete')
  const pl = must(await admin.get(`/api/admin/slot-patterns?project_id=${P}`), 'patterns').patterns
  ok('#9705 繰り返し登録も削除できる（案件詳細に枠のない登録が残らない）', !pl.some(x => x.pattern_id === pt.pattern_id), pl.map(x => x.pattern_id))
  const logs = must(await admin.get(`/api/admin/operation-logs?entity=shift&action=delete&staff_id=${A.staff_id}`), 'logs').logs
  ok('#9705 削除したシフトの操作履歴は「削除」で残る（枠の削除の履歴と重ねない）', logs.length === 1 && logs[0].changes.length > 0, logs)
  const sdl = must(await admin.get(`/api/admin/operation-logs?entity=shift&action=slot_delete&staff_id=${A.staff_id}`), 'slot logs').logs
  ok('#9705 削除したシフトには「枠の削除」の履歴を重ねない', sdl.length === 0, sdl)
  must(await admin.post('/api/admin/shift-slots/bulk-delete', { slot_ids: [...rs, ...other].map(s => s.slot_id), force: true }), 'cleanup row')
}

// ---------- #9705 報告のあるシフトは削除しない（枠の削除で delete_shifts） ----------
{
  const past = addDays(today, -3)
  const [s] = await newSlots(P, [past], '06:00', '09:00')
  await assign(s.roles[0].slot_role_id, B.staff_id)
  const sh = (await board(P, past)).slots.find(x => x.slot_id === s.slot_id).roles[0].assigned[0]
  const pr = await proxy(sh.shift_id, 'work_start', '06:00')
  ok('（前提）過去の枠のシフトに代理入力で報告', pr.status === 200, pr.data)
  let r = await admin.post('/api/admin/shift-slots/bulk-delete', { slot_ids: [s.slot_id], delete_shifts: true })
  ok('#9705 報告のあるシフトが残るときは、delete_shifts でも force が要る（409・残る件数）', r.status === 409 && r.data.need_force && r.data.assigned === 1, r.data)
  r = await admin.post('/api/admin/shift-slots/bulk-delete', { slot_ids: [s.slot_id], delete_shifts: true, force: true })
  const b = await board(P, past)
  ok('#9705 force で枠を削除し、報告のあるシフトは削除せず枠なしで残す（理由を返す）', r.status === 200 && r.data.deleted_shifts === 0 && r.data.kept_shifts === 1
    && /報告/.test(r.data.skipped_shifts?.[0]?.reason || '') && b.unslotted.some(x => x.shift_id === sh.shift_id), r.data)
}

// ---------- #9705 シフトの帯（常勤の一括登録）と、シフトのまとめて削除 ----------
{
  let r = await bulkShiftDelete({})
  ok('#9705 シフトを送らないと 400', r.status === 400 && /選んで/.test(r.data?.error || ''), r.data)
  r = await bulkShiftDelete({ shift_ids: [1, 'x'] })
  ok('#9705 数でない ID は 400', r.status === 400, r.data)
  r = await bulkShiftDelete({ shift_ids: Array.from({ length: 201 }, (_, i) => i + 1) })
  ok('#9705 201件は 400（一度に200件まで）', r.status === 400 && /200件まで/.test(r.data?.error || ''), r.data)
  r = await bulkShiftDelete({ shift_ids: [999999991] })
  ok('#9705 ないシフトだけなら 404', r.status === 404, r.data)

  const from = addDays(today, -3), to = addDays(today, 4)
  must(await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [C.staff_id], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: to, start_time: '19:00', end_time: '23:00', role: '販売スタッフ' }), 'shifts bulk')
  // 同じ人の別の時間の枠なしシフト（帯に入らない）
  must(await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [C.staff_id], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: to, date_to: to, start_time: '06:00', end_time: '08:00', role: '販売スタッフ' }), 'other bulk')
  const un = (await board(P, from, to)).unslotted.filter(x => x.staff_id === C.staff_id && x.start_time === '19:00').sort((a, b) => a.work_date.localeCompare(b.work_date))
  ok('（前提）常勤の一括登録で枠なしのシフトが8件', un.length === 8, un.length)
  const reported = un[1] // 2日前（報告あり）
  must(await proxy(reported.shift_id, 'work_start', '19:00'), 'proxy')
  // 承認待ちの打刻修正（打刻漏れの追加）がある前日のシフト
  const yday = un.find(x => x.work_date === addDays(today, -1))
  const cr = await admin.post('/api/admin/corrections', { shift_id: yday.shift_id, report_type: 'work_start', kind: 'add', requested_at: `${yday.work_date} 19:00`, reason: 'w15 テスト' })
  ok('（前提）承認待ちの打刻修正を登録', cr.status === 200 && cr.data.correction_id, cr.data)

  const band = must(await admin.get(`/api/admin/shifts/${un[0].shift_id}/band`), 'shift band')
  ok('#9705 シフトの帯は、同じスタッフ・案件・時間の枠なしシフト（すべて8件・今日以降5件。時間の違うシフトは入らない）', band.scopes.all.shifts === 8 && band.scopes.today.shifts === 5 && band.scopes.today.first_date === today, band.scopes)
  ok('#9705 報告のあるシフトは削除できない数（kept）と理由に出し、削除する ID に入れない', band.scopes.all.kept === 1 && band.scopes.all.deletable === 7 && !band.scopes.all.deletable_ids.includes(reported.shift_id)
    && Object.keys(band.scopes.all.kept_reasons).some(k => /報告/.test(k)), band.scopes.all)
  const slotted = await admin.get(`/api/admin/shifts/999999991/band`)
  ok('#9705 ないシフトの帯は 404', slotted.status === 404, slotted.data)

  r = await bulkShiftDelete({ shift_ids: [...band.scopes.all.deletable_ids, reported.shift_id], dry_run: true })
  ok('#9705 dry_run は件数と理由だけ（削除しない）', r.status === 200 && r.data.dry_run && r.data.deletable === 7 && r.data.skipped.length === 1, r.data)
  r = await bulkShiftDelete({ shift_ids: [...band.scopes.all.deletable_ids, reported.shift_id] })
  const left = (await board(P, from, to)).unslotted.filter(x => x.staff_id === C.staff_id)
  ok('#9705 まとめて削除: 7件を削除し、報告のある1件は理由を付けて残す', r.status === 200 && r.data.deleted === 7 && r.data.skipped.length === 1 && r.data.skipped[0].shift_id === reported.shift_id
    && /報告/.test(r.data.skipped[0].reason) && left.some(x => x.shift_id === reported.shift_id) && left.filter(x => x.start_time === '19:00').length === 1, { r: r.data, left: left.map(x => x.shift_id) })
  ok('#9705 帯に入らない（時間の違う）シフトは残る', left.some(x => x.start_time === '06:00'), left)
  ok('#9705 承認待ちの打刻修正は「取り消し」になる', r.data.cancelled_corrections === 1, r.data)
  const crs = must(await admin.get('/api/admin/corrections?status=cancelled'), 'corrections').corrections
  ok('#9705 取り消した打刻修正は一覧で「取り消し」', crs.some(x => x.correction_id === cr.data.correction_id), crs.slice(0, 3))
  const lg = must(await admin.get(`/api/admin/operation-logs?entity=shift&entity_id=${un[0].shift_id}&action=delete`), 'logs').logs
  ok('#9705 削除したシフトの操作履歴（削除の後の値はなし）', lg.length === 1, lg)
  r = await bulkShiftDelete({ shift_ids: [reported.shift_id] })
  ok('#9705 報告のあるシフトだけを送ると、削除せずに理由を返す', r.status === 200 && r.data.deleted === 0 && r.data.skipped.length === 1, r.data)
}

// ---------- 画面（静的な確認） ----------
{
  const sb = readFileSync(new URL('../public/static/shift-board.js', import.meta.url), 'utf8')
  const cm = readFileSync(new URL('../public/static/common.js', import.meta.url), 'utf8')
  const dnd = sb.slice(sb.indexOf('// ドラッグ＆ドロップ（SortableJS。Sprint 15 #9706）'), sb.indexOf('// 割当の送信中'))
  ok('#9706 ドロップではサーバーを呼ばない（ドラッグの処理に axios がない）', dnd.length > 1000 && !/axios\./.test(dnd) && !/renderShiftBoard\(/.test(dnd))
  ok('#9706 まとめて保存で、外す（シフトのまとめて削除）→ 移動 → 追加の順に送る', /axios\.post\('\/api\/admin\/shifts\/bulk-delete'/.test(sb) && /\/move`, \{ slot_role_id: o\.to_rid/.test(sb) && sb.indexOf("'/api/admin/shifts/bulk-delete'") < sb.indexOf("'/api/admin/shift-slots/assign-batch'"))
  ok('#9706 マウスとタッチの両方（forceFallback・タッチは長押し）', /forceFallback: true/.test(sb) && /delayOnTouchOnly: true/.test(sb))
  ok('#9708 common.js: エラーのトーストは長め（8秒〜）で ✕ で閉じられる', /function holdToast\(el\)/.test(cm) && /Math\.max\(8000/.test(cm) && /aria-label', '閉じる'/.test(cm))
  ok('画面: イベント属性に値を埋め込まない', !/onclick="[^"]*\$\{/.test(sb.slice(sb.indexOf('// シフト管理（D 案'), sb.indexOf('// 重複の表示。'))))
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  // 画面用のデータ: 週 W に、A を割り当てた枠 S1・空の枠 S2、枠なしの B のシフト2件。繰り返し登録（帯の削除）は2週後
  const W = addDays(MON, 35)
  const P2 = await newProject('画面')
  const [S1] = await newSlots(P2, [W], '10:00', '18:00'), [S2] = await newSlots(P2, [addDays(W, 1)], '10:00', '18:00')
  await assign(S1.roles[0].slot_role_id, A.staff_id)
  must(await admin.post('/api/admin/shifts/bulk', { project_id: P2, staff_ids: [B.staff_id], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: addDays(W, 2), date_to: addDays(W, 3), start_time: '19:00', end_time: '22:00', role: '販売スタッフ' }), 'B bulk')
  const aShift = (await board(P2, W)).slots[0].roles[0].assigned[0].shift_id
  const bShifts = (await board(P2, W, addDays(W, 6))).unslotted.filter(x => x.staff_id === B.staff_id).sort((a, b) => a.work_date.localeCompare(b.work_date)).map(x => x.shift_id)
  const W3 = addDays(W, 14)
  const pt = must(await admin.post('/api/admin/slot-patterns', { project_id: P2, start_time: '08:00', end_time: '12:00', roles: [{ role_name: '販売', headcount: 1 }], weekdays: [1, 3], date_from: W3, date_to: addDays(W3, 9) }), 'pattern 2')

  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w15s-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1900,1100', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []; const dialogs = []; const reqs = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true }) }
      if (m.method === 'Network.requestWillBeSent' && /\/api\//.test(m.params.request.url)) reqs.push({ method: m.params.request.method, url: m.params.request.url.replace(BASE, '') })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const ck = await login('sample', 'admin')
    // 案内（チュートリアル。Sprint 15 の w15-tour）が初回に画面を覆うと、ドラッグが案内に当たるので、見終わった扱いにしておく
    await client(ck).put('/api/admin/tours', { items: [{ key: 'admin-welcome', status: 'skipped' }, { key: 'admin-checklist', status: 'skipped' },
      ...['dashboard', 'clients', 'projects', 'staff', 'shifts', 'reports', 'corrections', 'settlement'].map(s => ({ key: `admin-screen-${s}`, status: 'done' }))] })
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    await send('Page.navigate', { url: `${BASE}/admin#shifts` }); await wait(4000)
    const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200) } return false }
    const center = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 10) } })()`)
    const mouse = (type, p) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' })
    // ドラッグ: 押す → 少しずつ動かす → 落とす場所で待つ（Sortable は 50ms ごとに下の要素を見る）→ 離す。to は関数（ドラッグ中に出る「外す」の場所の位置を読むため）でもよい
    async function drag(fromSel, to) {
      const a = await center(fromSel); if (!a) return false
      await mouse('mousePressed', a)
      for (let i = 1; i <= 4; i++) { await mouse('mouseMoved', { x: a.x + i * 3, y: a.y + i * 3 }); await wait(30) }
      const b = typeof to === 'function' ? await to() : to.x != null ? to : await ev(`(() => { const el = document.querySelector(${JSON.stringify(to)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
      if (!b) { await mouse('mouseReleased', a); return false }
      for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12 }); await wait(30) }
      await wait(250)
      await mouse('mouseReleased', b); await wait(400)
      return true
    }
    const writes = () => reqs.filter(r => r.method !== 'GET').length
    const reloads = () => reqs.filter(r => r.method === 'GET' && r.url.startsWith('/api/admin/shift-board?')).length

    await ev(`(async () => { Object.assign(__boardState, { from: '${W}', range: 'week', view: 'slot', projectIds: [${P2}], onlyShort: false, bulkDel: false, sel: null }); window.__boardDrafts.clear(); window.__boardShiftOps.clear(); await renderShiftBoard() })()`)
    await until(`document.querySelectorAll('#board-grid .board-cell').length >= 2`)
    const w0 = writes(), r0 = reloads()

    // #9706 割り当て済みの A を S2 へドラッグ → 移動の下書き（サーバーを呼ばない）
    const r2 = S2.roles[0].slot_role_id, r1 = S1.roles[0].slot_role_id
    await drag(`.board-cell[data-slot-id="${S1.slot_id}"] .shift-chip[data-shift-id="${aShift}"]`, `.board-drop[data-slot-role-id="${r2}"]`)
    const mv = await ev(`(() => { const o = window.__boardShiftOps.get(${aShift}); return { kind: o && o.kind, to: o && o.to_rid, chip: !!document.querySelector('.board-drop[data-slot-role-id="${r2}"] .chip-draft[data-shift-id="${aShift}"]'), ghost: /→/.test(document.querySelector('.board-drop[data-slot-role-id="${r1}"]').textContent), bar: document.getElementById('board-savebar').textContent } })()`)
    ok('#9706 割り当て済みの人をほかのマスへドラッグすると、移動の下書きになる（移動先に「移動」、元に「→」）', mv.kind === 'move' && mv.to === r2 && mv.chip && mv.ghost && /移動 1/.test(mv.bar), mv)
    ok('#9706 ドロップでサーバーに書き込まず、表を読み込み直さない', writes() === w0 && reloads() === r0, reqs.slice(-5))
    const need = await ev(`({ s1: document.querySelector('.board-cell[data-slot-id="${S1.slot_id}"] .board-need').textContent, s2: document.querySelector('.board-cell[data-slot-id="${S2.slot_id}"] .board-need').textContent })`)
    ok('#9706 充足の見込みに下書きを数える（元は2人不足、移動先は1人不足）', /2人不足/.test(need.s1) && /1人不足/.test(need.s2), need)

    // 枠なしの B を「外す」の場所へ（ドラッグ中だけ出る）
    let trashShown = false
    await drag(`.board-drop-src .shift-chip[data-shift-id="${bShifts[0]}"]`, async () => {
      trashShown = await ev(`getComputedStyle(document.getElementById('board-trash')).display === 'flex'`)
      return ev(`(() => { const r = document.getElementById('board-trash').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    })
    const rm = await ev(`(() => { const o = window.__boardShiftOps.get(${bShifts[0]}); return { kind: o && o.kind, hidden: getComputedStyle(document.getElementById('board-trash')).display === 'none', mark: /外す/.test(document.querySelector('#board-grid').textContent) } })()`)
    ok('#9706 ドラッグ中に「ここへドラッグで外す」が出て、そこへ落とすと外す下書き（終わると隠れる）', trashShown && rm.kind === 'remove' && rm.hidden && rm.mark, { trashShown, rm })
    // 表の外へ落としても外す。取り消し（1つ）で元に戻る
    await drag(`.board-drop-src .shift-chip[data-shift-id="${bShifts[1]}"]`, { x: 300, y: 15 })
    const out = await ev(`(window.__boardShiftOps.get(${bShifts[1]}) || {}).kind`)
    await ev(`document.querySelector('[data-action="boardOpUndo"][data-shift-id="${bShifts[1]}"]').click()`); await wait(200)
    ok('#9706 表の外へ落としても外す下書きになり、「元に戻す」で1つずつ取り消せる', out === 'remove' && await ev(`!window.__boardShiftOps.has(${bShifts[1]})`), out)
    // 移動先から元のマスへ戻すと、下書きが消える
    await drag(`.board-drop[data-slot-role-id="${r2}"] .chip-draft[data-shift-id="${aShift}"]`, `.board-drop[data-slot-role-id="${r1}"]`)
    const back = await ev(`!window.__boardShiftOps.has(${aShift})`)
    await drag(`.board-cell[data-slot-id="${S1.slot_id}"] .shift-chip[data-shift-id="${aShift}"]`, `.board-drop[data-slot-role-id="${r2}"]`)
    ok('#9706 移動の下書きを元のマスへ戻すと取り消しになり、もう一度ドラッグできる', back && await ev(`(window.__boardShiftOps.get(${aShift}) || {}).to_rid === ${r2}`))

    // 右の欄の候補を S1 へドラッグ → 追加の下書き
    await ev(`document.querySelector('.board-cell[data-slot-id="${S2.slot_id}"]').click()`)
    await until(`!!document.querySelector('#cand-list .cand-item[data-staff-id="${C.staff_id}"]')`, 8000)
    await ev(`(() => { const q = document.getElementById('cand-q'); q.value = '${PFX} C'; q.dispatchEvent(new Event('input', { bubbles: true })) })()`); await wait(300)
    const w1 = writes()
    await drag(`#cand-list .cand-item[data-staff-id="${C.staff_id}"]`, `.board-drop[data-slot-role-id="${r1}"]`)
    const ad = await ev(`({ has: window.__boardDrafts.has('${r1}:${C.staff_id}'), other: window.__boardDrafts.has('${r2}:${C.staff_id}'), chip: !!document.querySelector('.board-drop[data-slot-role-id="${r1}"] .chip-draft[data-draft-key="${r1}:${C.staff_id}"]'), modal: !!document.querySelector('#modal-root .modal-bg') })`)
    ok('#9706 右の欄の候補をマスへドラッグすると、そのマスの追加の下書き（押したときの下書きは入らない）', ad.has && !ad.other && ad.chip && !ad.modal && writes() === w1, ad)
    ok('#9706 保存の帯に件数（追加・移動・外す）を出す', /追加 1・移動 1・外す 1/.test(await ev(`document.getElementById('board-savebar').textContent`)), await ev(`document.getElementById('board-savebar').textContent`))

    // まとめて保存
    await ev(`document.getElementById('board-save-top').click()`)
    await until(`window.__boardDrafts.size === 0 && window.__boardShiftOps.size === 0 && !!document.querySelector('#board-grid .board-cell')`, 10000)
    const saved = await board(P2, W, addDays(W, 6))
    const s1 = saved.slots.find(s => s.slot_id === S1.slot_id).roles[0].assigned, s2 = saved.slots.find(s => s.slot_id === S2.slot_id).roles[0].assigned
    ok('#9706 まとめて保存で、移動・外す・追加をまとめて反映する', s2.some(a => a.shift_id === aShift) && s1.some(a => a.staff_id === C.staff_id) && !s1.some(a => a.staff_id === A.staff_id)
      && !saved.unslotted.some(x => x.shift_id === bShifts[0]) && saved.unslotted.some(x => x.shift_id === bShifts[1]), { s1, s2, un: saved.unslotted.map(x => x.shift_id) })
    ok('#9706 保存の後は下書きが消え、結果を知らせる', await until(`[...document.querySelectorAll('#toast .toast-msg')].some(t => /1件を登録しました/.test(t.textContent) && /1件を移動しました/.test(t.textContent) && /1件を外しました/.test(t.textContent))`, 3000))

    // 保存で止まった行は理由つきで残る（報告のあるシフトは外せない）
    {
      // 代理入力は稼働日より前にはできないので、過去の日のシフトで確かめる
      const past = addDays(today, -2)
      must(await admin.post('/api/admin/shifts/bulk', { project_id: P2, staff_ids: [B.staff_id], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: past, date_to: past, start_time: '05:00', end_time: '06:00', role: '販売スタッフ' }), 'B past')
      const ps = (await board(P2, past)).unslotted.find(x => x.staff_id === B.staff_id && x.start_time === '05:00')
      must(await proxy(ps.shift_id, 'work_start', '05:00'), 'proxy past')
      await ev(`(async () => { Object.assign(__boardState, { from: boardWeekStart('${past}'), sel: null }); await renderShiftBoard() })()`)
      await until(`!!document.querySelector('.board-drop-src .shift-chip[data-shift-id="${ps.shift_id}"]')`)
      await drag(`.board-drop-src .shift-chip[data-shift-id="${ps.shift_id}"]`, async () => ev(`(() => { const r = document.getElementById('board-trash').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`))
      await ev(`document.getElementById('board-save-top').click()`)
      await until(`!!document.querySelector('#modal-root [data-action="boardProblemRemove"]')`, 8000)
      const pm = await ev(`({ text: document.querySelector('#modal-root .modal-box').innerText, kept: (window.__boardShiftOps.get(${ps.shift_id}) || {}).problem })`)
      ok('#9706 保存できなかった下書き（報告のあるシフトを外す）は、理由つきで残る', /外す/.test(pm.text) && /報告/.test(pm.text) && pm.kept && /報告/.test(pm.kept.reasons[0]), pm)
      await ev(`document.querySelector('#modal-root [data-action="boardProblemRemove"]').click()`); await wait(300)
      ok('#9706 一覧から取り消すと、下書きが消えて一覧を閉じる', await ev(`!window.__boardShiftOps.size && !document.querySelector('#modal-root .modal-bg')`))
    }

    // #9705 帯の削除（繰り返し登録の枠のマスから）
    await ev(`(async () => { Object.assign(__boardState, { from: '${W3}', sel: null }); await renderShiftBoard() })()`)
    await until(`document.querySelectorAll('#board-grid .board-cell').length >= 2`)
    const firstSlot = await ev(`Number(document.querySelector('#board-grid .board-cell').dataset.slotId)`)
    await ev(`document.querySelector('.board-cell[data-slot-id="${firstSlot}"] [data-action="boardDeleteSlot"]').click()`)
    await until(`!!document.querySelector('#modal-root input[name="del-scope"][value="all"]')`, 6000)
    const dm = await ev(`document.querySelector('#modal-root .modal-box').innerText`)
    ok('#9705 枠の削除で、帯（繰り返し登録）の「この枠だけ・今日以降・すべて」を選べる', /この枠だけ/.test(dm) && /この帯のすべての枠/.test(dm) && /4件/.test(dm) && /繰り返し登録も削除します/.test(dm), dm)
    await ev(`document.querySelector('#modal-root input[name="del-scope"][value="all"]').click()`); await wait(200)
    ok('#9705 範囲を選ぶとボタンに件数を出す', /4件の枠を削除する/.test(await ev(`document.getElementById('del-run').textContent`)))
    await ev(`document.getElementById('del-run').click()`)
    await until(`[...document.querySelectorAll('#toast .toast-msg')].some(t => /4件の枠を削除しました/.test(t.textContent))`, 8000)
    const gone = await board(P2, W3, addDays(W3, 13))
    const pl = must(await admin.get(`/api/admin/slot-patterns?project_id=${P2}`), 'patterns').patterns
    ok('#9705 画面から帯のすべての枠と、繰り返し登録を削除する', !gone.slots.length && !pl.some(x => x.pattern_id === pt.pattern_id), { slots: gone.slots.length, pl })

    // #9705 枠なしのシフト（常勤の一括登録）の帯の削除: シフトの詳細の「シフトを削除」から
    {
      const W4 = addDays(W, 7)
      must(await admin.post('/api/admin/shifts/bulk', { project_id: P2, staff_ids: [A.staff_id], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: W4, date_to: addDays(W4, 2), start_time: '15:00', end_time: '20:00', role: '販売スタッフ' }), 'A bulk')
      await ev(`(async () => { Object.assign(__boardState, { from: '${W4}', sel: null }); await renderShiftBoard() })()`)
      await until(`document.querySelectorAll('.board-drop-src .shift-chip').length >= 3`)
      const first = await ev(`Number(document.querySelector('.board-drop-src .shift-chip').dataset.shiftId)`)
      await ev(`openShiftDetail(${first})`); await wait(500)
      await ev(`document.querySelector('#modal-root [data-action="boardDeleteShift"]').click()`)
      await until(`!!document.querySelector('#modal-root input[name="sd-scope"][value="all"]')`, 6000)
      const sm = await ev(`document.querySelector('#modal-root .modal-box').innerText`)
      ok('#9705 枠なしのシフトの削除で、帯（このシフトだけ・今日以降・すべて）を選べる', /このシフトだけ/.test(sm) && /この帯のすべてのシフト/.test(sm) && /3件/.test(sm), sm)
      await ev(`document.querySelector('#modal-root input[name="sd-scope"][value="all"]').click()`)
      await ev(`document.querySelector('#modal-root [data-action="shiftBandDeleteRun"]').click()`)
      const t = await until(`[...document.querySelectorAll('#toast .toast-msg')].some(t => /3件のシフトを削除しました/.test(t.textContent))`, 8000)
      const rest = (await board(P2, W4, addDays(W4, 6))).unslotted.filter(x => x.staff_id === A.staff_id)
      ok('#9705 画面から帯のシフトをまとめて削除する', t && !rest.length, rest.map(x => x.shift_id))
    }

    // #9708 トーストの表示時間
    await ev(`(() => { document.querySelectorAll('#toast .toast-msg').forEach(t => Element.prototype.remove.call(t)); toast('勤怠・日報の報告があるシフトは削除できません。状態を「欠勤」などに変更してください'); toast('保存しました'); toast('テストの知らせです。これは長めの文で、読み終わるまでに時間がかかるので少し長く出します。おしまい') })()`)
    await wait(3300)
    const t1 = await ev(`[...document.querySelectorAll('#toast .toast-msg')].map(t => ({ text: t.textContent, x: !!t.querySelector('button[aria-label="閉じる"]'), role: t.getAttribute('role') }))`)
    ok('#9708 エラーのトーストは 3 秒を過ぎても出ていて、✕ がある（成功の短い知らせは消える）', t1.some(t => /削除できません/.test(t.text) && t.x && t.role === 'alert') && !t1.some(t => /^保存しました/.test(t.text)), t1)
    ok('#9708 長い文の知らせは読める時間まで出す（✕ は付けない）', t1.some(t => /テストの知らせ/.test(t.text) && !t.x), t1)
    await ev(`document.querySelector('#toast .toast-msg button[aria-label="閉じる"]').click()`); await wait(200)
    ok('#9708 ✕ で閉じる', await ev(`![...document.querySelectorAll('#toast .toast-msg')].some(t => /削除できません/.test(t.textContent))`))
    await wait(5000)
    ok('#9708 長い文の知らせも、時間がたてば消える', await ev(`![...document.querySelectorAll('#toast .toast-msg')].some(t => /テストの知らせ/.test(t.textContent))`))

    ok('画面: スクリプトのエラーがない', !errors.length, errors)
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
