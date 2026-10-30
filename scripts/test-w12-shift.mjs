// シフト管理（w12-shift: Sprint 12 #9501 #9502 #9503）の統合テスト
//   #9501 枠のまとめて削除（POST /api/admin/shift-slots/bulk-delete）: 自社の枠だけ・割り当てがあれば 409 と件数・force でシフトを枠なしで残す・
//         操作履歴を枠・シフトごとに残す・未対応の応募を「枠の削除」で処理済みにする。画面は「選択して削除」でマスにチェックを出す
//   #9502 入力欄のあるモーダルに、右上の ✕ が必ず出る（common.js。中に ✕ のアイコンがあるモーダルでも）
//   #9503 シフト・枠を登録する画面の案件（シフト登録はスタッフも）の初期値は「選択してください」。選ぶまで登録できない
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w12-shift.mjs
//   画面の確認（モーダルの ✕・選択してください・選択して削除）は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8810'
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

const PFX = 'W12S' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const pub = client('')

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
async function newProject(tag) {
  const r = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${tag}`, client_id: cl.client_id, unit_price: 10000, allow_duplicate: true }), 'project')
  must(await admin.put(`/api/admin/projects/${r.project_id}/pricing`, { engagement_type: 'spot', unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000 }), 'pricing')
  return r.project_id
}
async function newSlot(pid, date, start = '10:00', end = '18:00', roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}&project_ids=${pid}`), 'board')
  const s = b.slots.filter(x => x.start_time === start && x.end_time === end).pop()
  return { slot_id: s.slot_id, roles: s.roles.map(r => r.slot_role_id) }
}
const board = async (pid, from, to = from) => must(await admin.get(`/api/admin/shift-board?from=${from}&to=${to}&project_ids=${pid}`), 'board')
const bulkDelete = (body) => admin.post('/api/admin/shift-slots/bulk-delete', body)

// 60日以上先の月曜日から
let MON = addDays(today, 60); while (weekday(MON) !== 1) MON = addDays(MON, 1)
const P = await newProject('案件A')
const A = await newStaff('A'), B = await newStaff('B')

// ---------- #9501 入力の確かめ ----------
{
  let r = await bulkDelete({})
  ok('#9501 枠を送らないと 400', r.status === 400 && /選んで/.test(r.data?.error || ''), r.data)
  r = await bulkDelete({ slot_ids: [] })
  ok('#9501 空の一覧は 400', r.status === 400, r.data)
  r = await bulkDelete({ slot_ids: [1, 'x'] })
  ok('#9501 数でない ID は 400', r.status === 400 && /正しくありません/.test(r.data?.error || ''), r.data)
  r = await bulkDelete({ slot_ids: Array.from({ length: 201 }, (_, i) => i + 1) })
  ok('#9501 201件は 400（一度に200件まで）', r.status === 400 && /200件まで/.test(r.data?.error || ''), r.data)
  r = await bulkDelete({ slot_ids: [999999991, 999999992] })
  ok('#9501 ない枠だけなら 404（画面を読み直す案内）', r.status === 404 && /読み直/.test(r.data?.error || ''), r.data)
}

// ---------- #9501 他社の枠は消せない ----------
{
  const s = await newSlot(P, MON, '07:00', '08:00')
  const hq = client(await login('sample', 'hq'))
  const tag = Date.now().toString(36).slice(-5)
  const codeB = 'w12' + tag, pwB = 'W12-Passw0rd-' + tag
  const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `W12確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
  if (cr.status === 200) {
    const adminB = client(await login(codeB, 'adminb', pwB))
    const r = await adminB.post('/api/admin/shift-slots/bulk-delete', { slot_ids: [s.slot_id], force: true })
    const b = await board(P, MON)
    ok('#9501 他社の枠を指定しても削除されない（404）', r.status === 404 && b.slots.some(x => x.slot_id === s.slot_id), { r: r.data })
  } else ok('（前提）B 社を作成', false, cr)
  must(await bulkDelete({ slot_ids: [s.slot_id] }), 'cleanup')
}

// ---------- #9501 割り当て・応募・下書きのある枠のまとめて削除 ----------
let BROWSER_SLOTS = null
{
  const TUE = addDays(MON, 1), WED = addDays(MON, 2)
  const s1 = await newSlot(P, MON)                                   // 割り当てなし
  const s2 = await newSlot(P, TUE, '10:00', '18:00', [{ role_name: '販売', headcount: 2 }, { role_name: 'リーダー', headcount: 1 }]) // A を割り当て（役割2つ）
  const s3 = await newSlot(P, WED)                                   // B を割り当てて欠勤
  const s4 = await newSlot(P, WED, '19:00', '22:00')                 // 公開の募集ページからの応募
  const keep = await newSlot(P, MON, '19:00', '22:00')               // 選ばない枠（残る）
  must(await admin.post(`/api/admin/shift-slots/roles/${s2.roles[1]}/assign`, { staff_ids: [A.staff_id], force: true }), 'assign A')
  must(await admin.post(`/api/admin/shift-slots/roles/${s3.roles[0]}/assign`, { staff_ids: [B.staff_id], force: true }), 'assign B')
  const bShift = (await board(P, WED)).slots.find(x => x.slot_id === s3.slot_id).roles[0].assigned[0]
  must(await admin.put(`/api/admin/shifts/${bShift.shift_id}`, { status: 'absent', force: true }), 'absent B')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [P], date_from: MON, date_to: addDays(MON, 10), allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'recruit page')
  const phone = '090' + String(Date.now()).slice(-8)
  const ap = await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 応募`, phone, agree: true, slot_role_ids: [s4.roles[0]], issued_at: Date.now() - 10000 })
  ok('（前提）公開の募集ページから応募', ap.status === 200, ap.data)
  const pendingBefore = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary').pending

  const ids = [s1.slot_id, s2.slot_id, s3.slot_id, s4.slot_id]
  const before = await board(P, MON, WED)
  ok('（前提）役割2つの枠は表で2マス・割り当てた人と応募が出る', before.slots.find(x => x.slot_id === s2.slot_id)?.roles.length === 2 && before.slots.find(x => x.slot_id === s4.slot_id)?.roles[0].applicants === 1, before.slots.map(x => ({ id: x.slot_id, roles: x.roles.length })))

  let r = await bulkDelete({ slot_ids: ids })
  let b = await board(P, MON, WED)
  ok('#9501 割り当て（欠勤を含むシフト）があり force がないと 409 と件数（need_force）', r.status === 409 && r.data?.need_force && r.data.assigned === 2 && /2 件/.test(r.data.error), r.data)
  ok('#9501 409 のときは何も削除しない', ids.every(id => b.slots.some(x => x.slot_id === id)), b.slots.map(x => x.slot_id))

  // すでに削除された枠が混じっていても、残りを削除して件数を返す
  const gone = await newSlot(P, MON, '06:00', '07:00')
  must(await admin.del(`/api/admin/shift-slots/${gone.slot_id}`), 'delete gone')
  r = await bulkDelete({ slot_ids: [...ids, ids[0], gone.slot_id], force: true })
  b = await board(P, MON, WED)
  ok('#9501 force で選んだ枠をまとめて削除（重複は1件、すでにない枠は missing）', r.status === 200 && r.data.deleted === 4 && r.data.missing === 1 && r.data.kept_shifts === 2
    && [...r.data.deleted_ids].sort().join() === [...ids].sort().join(), r.data)
  ok('#9501 選んだ枠は表から消え、選ばなかった枠は残る', ids.every(id => !b.slots.some(x => x.slot_id === id)) && b.slots.some(x => x.slot_id === keep.slot_id), b.slots.map(x => x.slot_id))
  const ua = b.unslotted.find(x => x.staff_id === A.staff_id), ub = b.unslotted.find(x => x.staff_id === B.staff_id)
  ok('#9501 シフトは消さず「枠を使わないシフト」として残す（欠勤も）', ua && ua.work_date === TUE && ua.start_time === '10:00' && ub && ub.status === 'absent', b.unslotted)

  // 操作履歴（枠ごと・シフトごと。1回の操作として同じ op_key）
  const logs = []
  for (const id of ids) logs.push(...must(await admin.get(`/api/admin/operation-logs?entity=slot&entity_id=${id}&action=slot_delete`), 'logs').logs)
  ok('#9501 操作履歴: 枠ごとに「枠の削除」が1件ずつ（削除後の値はなし）', logs.length === 4 && logs.every(l => l.action_label === '枠の削除') && new Set(logs.map(l => l.op_key)).size === 1
    && logs.every(l => l.changes.some(c => c.field === 'roles' && Array.isArray(c.before) && c.after === null)), logs.map(l => ({ id: l.entity_id, op: l.op_key, ch: l.changes.map(c => c.field) })))
  const sl = must(await admin.get(`/api/admin/operation-logs?entity=shift&entity_id=${ua.shift_id}&action=slot_delete`), 'shift logs').logs
  ok('#9501 操作履歴: 枠から外したシフトにも「枠の削除」（募集枠の役割が空になる）', sl.length === 1 && sl[0].op_key === logs[0].op_key && sl[0].changes.some(c => c.field === 'slot_role_id' && c.before === s2.roles[1] && c.after === null), sl)

  // 未対応の応募は「枠の削除」で処理済み
  const pendingAfter = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary 2').pending
  const done = must(await admin.get(`/api/admin/recruit-applications?status=done&page_id=${page.page_id}`), 'apps').applications.find(a => a.phone === phone)
  ok('#9501 未対応の応募は「枠の削除」で処理済みになり、未対応の件数から外れる', pendingAfter === pendingBefore - 1 && done && done.items[0].status === 'slot_removed', { pendingBefore, pendingAfter, done })

  r = await bulkDelete({ slot_ids: ids, force: true })
  ok('#9501 もう一度送ると 404', r.status === 404, r.data)
  must(await admin.del(`/api/admin/shift-slots/${keep.slot_id}`), 'cleanup keep')

  // 画面の確認用（割り当て1件・応募なし）
  const W = addDays(MON, 7)
  const b1 = await newSlot(P, W), b2 = await newSlot(P, addDays(W, 1)), b3 = await newSlot(P, addDays(W, 2))
  must(await admin.post(`/api/admin/shift-slots/roles/${b2.roles[0]}/assign`, { staff_ids: [A.staff_id], force: true }), 'assign A2')
  BROWSER_SLOTS = { week: W, ids: [b1.slot_id, b2.slot_id, b3.slot_id], roles: [b1.roles[0], b2.roles[0], b3.roles[0]] }
}

// ---------- 画面（静的な確認） ----------
{
  const sb = readFileSync(new URL('../public/static/shift-board.js', import.meta.url), 'utf8')
  const cm = readFileSync(new URL('../public/static/common.js', import.meta.url), 'utf8')
  const ad = readFileSync(new URL('../public/static/admin.js', import.meta.url), 'utf8')
  ok('#9501 画面: 「選択して削除」でマスにチェックを出し、まとめて削除の API を呼ぶ', sb.includes("'選択して削除'") && sb.includes('class="bulk-check" data-action="boardBulkCheck"') && sb.includes("axios.post('/api/admin/shift-slots/bulk-delete'"))
  ok('#9501 画面: 削除した枠の下書きと選択を片づける', /for \(const \[k, d\] of DRAFTS\) if \(rids\.has\(d\.slot_role_id\)\) DRAFTS\.delete\(k\)\s+if \(rids\.has\(BS\.sel\)\) BS\.sel = null\s+BULK\.clear\(\)/.test(sb))
  ok('#9502 common.js: 閉じるボタンの判定は box の中だけ（:scope）', /MODAL_X_SEL = ':scope \.modal-x, :scope \[data-modal-close\], :scope button\[aria-label="閉じる"\], :scope \[onclick\*="closeModal"\] \.fa-xmark, :scope \[onclick\*="closeModal"\] \.fa-times'/.test(cm))
  ok('#9503 枠の作成・繰り返し登録・常勤の一括登録の案件は「選択してください」から', (sb.match(/>選択してください<\/option>/g) || []).length >= 2 && sb.includes("if (!slotId && !requireProject('slot-project')) return") && sb.includes("if (!requireProject('slot-project')) return") && sb.includes("if (!requireProject('bk-project')) return"))
  ok('#9503 開催場所の選択肢は、選んだ案件から作る（m.projects[0] を使わない）', !sb.includes('m.projects[0]') && sb.includes("if (!projectId) return '<option value=\"\">（先に案件を選んでください）</option>'"))
  ok('#9503 シフト登録（showAddShift）のスタッフ・案件も「選択してください」から', /id="sh-staff" class="inp" required><option value="" selected>選択してください<\/option>/.test(ad) && /id="sh-project" class="inp" onchange="addShiftFeeHint\(\)" required><option value="" selected>選択してください<\/option>/.test(ad) && ad.includes("addShiftRequire('sh-project'"))
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w12s-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1400,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []; const dialogs = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true }) }
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const ck = await login('sample', 'admin')
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    await send('Page.navigate', { url: `${BASE}/admin#shifts` }); await wait(4000)
    const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200) } return false }

    // モーダルの状態: 入力欄の有無・box の中の閉じるボタン（右上にあるか）・案件の選択
    const MODAL_STATE = `(() => {
      const bg = document.querySelector('#modal-root .modal-bg'); if (!bg) return null
      const box = bg.querySelector('.modal-box')
      const x = box.querySelector(':scope .modal-x, :scope button[aria-label="閉じる"]') || [...box.querySelectorAll(':scope [onclick*="closeModal"] .fa-xmark, :scope [onclick*="closeModal"] .fa-times')].map(i => i.closest('button')).find(Boolean)
      const bt = box.getBoundingClientRect(), xr = x && x.getBoundingClientRect()
      // 自前の閉じるボタン（common.js が足した ✕ 以外）
      const own = box.querySelectorAll(':scope button[aria-label="閉じる"]:not(.modal-x), :scope [data-modal-close], :scope [onclick*="closeModal"] .fa-xmark, :scope [onclick*="closeModal"] .fa-times').length
      return { inputs: modalHasInputs(bg), backdrop: typeof bg.onclick === 'function', x: !!x, own, added: !!box.querySelector(':scope > .modal-x'),
        topRight: !!xr && xr.top - bt.top < 70 && bt.right - xr.right < 70, title: (box.querySelector('h3') || {}).textContent || '' }
    })()`
    // #9502 全モーダルの一通り: 入力欄のあるモーダルには、box の中の右上に ✕ がある
    const openers = [
      ['枠を作成', 'openSlotModal()'], ['枠の編集', `openSlotModal(null, ${BROWSER_SLOTS.ids[0]})`], ['枠の繰り返し登録', 'openPatternModal()'],
      ['常勤の一括登録', 'openBulkModal()'], ['前の週のコピー', 'openCopyModal()'], ['シフト登録', `showAddShift('${BROWSER_SLOTS.week}')`],
      ['候補', `openCandidates(${BROWSER_SLOTS.roles[0]})`], ['単価ルール', `openRuleModal({ project_id: ${P}, client_id: ${cl.client_id} })`],
      ['クライアントの登録', 'showAddClient()'], ['案件の登録', 'showAddProject()'], ['スタッフの登録', 'showAddStaff()'], ['仮登録', 'showQuickRegister()'],
      ['日報テンプレート', 'showAddTemplate()'], ['名簿の登録', 'showAddRoster()'], ['名簿の取り込み', 'showRosterImport()'], ['名簿のURL', 'showRosterLink()'],
      ['名簿のまとめてURL', 'showRosterBulkLink()'], ['取引先の担当者', `showClientContactForm(${cl.client_id})`], ['報告用URL', `openNologinBulk('${BROWSER_SLOTS.week}')`],
      ['フォロー', `showFollowModal(${A.staff_id}, 'A')`], ['書類の登録', `openDocumentUpload('staff', ${A.staff_id})`], ['所属の変更', `openAffiliationChange(${A.staff_id})`],
      ['案件の単価', `openSettlePricing(${P})`],
    ]
    const seen = []
    for (const [label, call] of openers) {
      await ev('closeModal()')
      const r = await ev(`(async () => { if (typeof ${call.split('(')[0]} !== 'function') return 'nofn'; await ${call}; return 'ok' })()`)
      await wait(900)
      const st = await ev(MODAL_STATE)
      if (r !== 'ok' || !st) { console.log(`  （${label}: モーダルを開けませんでした ${JSON.stringify(r).slice(0, 120)}）`); continue }
      seen.push({ label, ...st })
    }
    const withInputs = seen.filter(s => s.inputs && s.backdrop)
    const bad = withInputs.filter(s => !s.x || !s.topRight)
    ok(`#9502 入力欄のあるモーダル（${withInputs.length}件）すべてで、右上に ✕ が出る`, withInputs.length >= 15 && !bad.length, { bad, opened: seen.map(s => s.label) })
    ok('#9502 枠の作成・編集・繰り返し登録（中に ✕ のアイコンがある）にも ✕ を足す', ['枠を作成', '枠の編集', '枠の繰り返し登録'].every(l => seen.find(s => s.label === l)?.added), seen.filter(s => s.label.startsWith('枠')))
    ok('#9502 自前の ✕ があるモーダルには二重に足さない', seen.every(s => !(s.added && s.own)), seen.filter(s => s.added && s.own).map(s => s.label))
    ok('#9502 ✕ を足さなかったモーダルは、自前の ✕ があるか、入力欄のない（背景で閉じる）モーダル', seen.every(s => s.added || s.own || !s.inputs || !s.backdrop), seen.filter(s => !s.added).map(s => ({ l: s.label, inputs: s.inputs, own: s.own, backdrop: s.backdrop })))
    // ✕ を押すと閉じる・背景を押しても閉じない
    await ev('closeModal()'); await ev('openPatternModal()'); await wait(800)
    await ev(`document.querySelector('#modal-root .modal-bg').click()`); await wait(200)
    const still = await ev(`!!document.querySelector('#modal-root .modal-bg')`)
    await ev(`document.querySelector('#modal-root .modal-x').click()`); await wait(200)
    ok('#9502 背景を押しても閉じず、右上の ✕ で閉じる（枠の繰り返し登録）', still && await ev(`!document.querySelector('#modal-root .modal-bg')`))
    // 入力欄のない確認のモーダルは今までどおり（✕ を足さず、背景で閉じる）
    await ev(`modal('<h3 class="font-bold">確認</h3><p>入力欄なし</p><button class="btn btn-outline" onclick="closeModal()"><i class="fas fa-xmark"></i>閉じる</button>')`); await wait(300)
    const plain = await ev(MODAL_STATE)
    await ev(`document.querySelector('#modal-root .modal-bg').click()`); await wait(200)
    ok('#9502 入力欄のないモーダルには ✕ を足さず、背景のタップで閉じる', plain && !plain.inputs && !plain.added && await ev(`!document.querySelector('#modal-root .modal-bg')`), plain)

    // #9503 案件は「選択してください」から。選ばずに登録すると止まる
    const toastHas = (re) => ev(`[...document.querySelectorAll('#toast .toast-msg')].some(t => ${re}.test(t.textContent))`)
    await ev(`(() => { __boardState.projectIds = []; closeModal() })()`)
    await ev('openSlotModal()'); await wait(800)
    const sm = await ev(`({ v: document.getElementById('slot-project').value, t: document.getElementById('slot-project').selectedOptions[0].textContent, site: document.getElementById('slot-site').options.length })`)
    ok('#9503 枠の作成: 案件は「選択してください」・開催場所は未選択なら選べない', sm.v === '' && sm.t === '選択してください' && sm.site === 1, sm)
    await ev(`document.querySelector('[data-action=saveSlot]').click()`); await wait(400)
    ok('#9503 枠の作成: 選ばずに作成すると止まり、案件を選ぶよう知らせる', await toastHas('/案件を選択してください/') && await ev(`!!document.getElementById('slot-project') && document.activeElement && document.activeElement.id === 'slot-project'`))
    await ev(`(() => { const s = document.getElementById('slot-project'); s.value = '${P}'; s.dispatchEvent(new Event('change')) })()`); await wait(200)
    ok('#9503 枠の作成: 案件を選ぶと、その案件の開催場所が選べる（先頭は「開催場所を選択」）', /開催場所を選択/.test(await ev(`document.getElementById('slot-site').options[0].textContent`)))
    await ev('openPatternModal()'); await wait(800)
    ok('#9503 枠の繰り返し登録: 案件は「選択してください」', await ev(`document.getElementById('slot-project').value === ''`))
    await ev(`document.querySelector('[onclick="savePattern()"]').click()`); await wait(400)
    ok('#9503 枠の繰り返し登録: 選ばずに作成すると止まる', await toastHas('/案件を選択してください/') && await ev(`!!document.getElementById('pt-from')`))
    await ev('openBulkModal()'); await wait(1000)
    ok('#9503 常勤の一括登録: 案件は「選択してください」・単価は案件を選ぶ案内', await ev(`document.getElementById('bk-project').value === '' && /案件を選ぶと/.test(document.getElementById('bk-price-list').textContent)`), await ev(`document.getElementById('bk-price-list') && document.getElementById('bk-price-list').textContent`))
    await ev(`document.querySelector('[data-action=saveBulk]').click()`); await wait(400)
    ok('#9503 常勤の一括登録: 選ばずに登録すると止まる', await toastHas('/案件を選択してください/') && await ev(`!!document.getElementById('bk-project')`))
    await ev(`showAddShift('${BROWSER_SLOTS.week}')`); await wait(1000)
    const as = await ev(`({ s: document.getElementById('sh-staff').value, p: document.getElementById('sh-project').value, st: document.getElementById('sh-staff').selectedOptions[0].textContent, pt: document.getElementById('sh-project').selectedOptions[0].textContent })`)
    ok('#9503 シフト登録: スタッフ・案件は「選択してください」', as.s === '' && as.p === '' && as.st === '選択してください' && as.pt === '選択してください', as)
    await ev(`document.getElementById('sh-staff').value = '${A.staff_id}'; document.querySelector('[data-action=addShift]').click()`); await wait(500)
    ok('#9503 シフト登録: 案件を選ばずに登録すると止まる', await toastHas('/案件を選択してください/') && await ev(`!!document.getElementById('sh-project')`))
    // 絞り込みで案件を1つに決めているときは、その案件を選んでおく
    await ev(`(() => { __boardState.projectIds = [${P}]; closeModal() })()`)
    await ev('openSlotModal()'); await wait(800)
    const pre1 = await ev(`document.getElementById('slot-project').value`)
    await ev('openBulkModal()'); await wait(800)
    const pre2 = await ev(`document.getElementById('bk-project').value`)
    ok('#9503 絞り込みで案件を1つに決めているときは、その案件を選んでおく', pre1 === String(P) && pre2 === String(P), { pre1, pre2 })
    await ev('closeModal()')

    // #9501 選択して削除
    await ev(`(async () => { Object.assign(__boardState, { from: '${BROWSER_SLOTS.week}', range: 'week', view: 'slot', projectIds: [${P}], onlyShort: false, bulkDel: false }); await renderShiftBoard() })()`)
    await until(`document.querySelectorAll('#board-grid .board-cell').length >= 3`)
    ok('#9501 「選択して削除」のボタンが出る（チェックは初めは出ない）', await ev(`!!document.querySelector('[data-action=boardBulkDelToggle]') && !document.querySelector('.bulk-check')`))
    await ev(`document.querySelector('[data-action=boardBulkDelToggle]').click()`); await wait(300)
    ok('#9501 押すと各マスにチェックが出て、選択中の帯が出る', await ev(`document.querySelectorAll('#board-grid .bulk-check').length >= 3 && !document.getElementById('board-bulkbar').hidden`))
    await ev(`document.querySelector('.board-cell[data-slot-id="${BROWSER_SLOTS.ids[0]}"]').click()`); await wait(200)
    ok('#9501 マスを押すとチェックが付き、件数が出る', await ev(`document.querySelector('.board-cell[data-slot-id="${BROWSER_SLOTS.ids[0]}"] .bulk-check').checked && /選択中 1件/.test(document.getElementById('board-bulkbar').textContent)`))
    // マスの中の名前を押しても、シフトの詳細を開かずに枠の選択になる
    await ev(`document.querySelector('.board-cell[data-slot-id="${BROWSER_SLOTS.ids[1]}"] .board-chip').click()`); await wait(300)
    ok('#9501 選択中はマスの中の名前を押しても詳細を開かず、枠を選ぶ', await ev(`!document.querySelector('#modal-root .modal-bg') && document.querySelector('.board-cell[data-slot-id="${BROWSER_SLOTS.ids[1]}"] .bulk-check').checked && /選択中 2件/.test(document.getElementById('board-bulkbar').textContent)`))
    // チェックの欄を直接押して外す・付け直す
    await ev(`document.querySelector('.board-cell[data-slot-id="${BROWSER_SLOTS.ids[1]}"] .bulk-check').click()`); await wait(200)
    ok('#9501 チェックを直接押すと外れる', await ev(`!document.querySelector('.board-cell[data-slot-id="${BROWSER_SLOTS.ids[1]}"] .bulk-check').checked && /選択中 1件/.test(document.getElementById('board-bulkbar').textContent)`))
    await ev(`document.querySelector('[data-action=boardBulkAll]').click()`); await wait(300)
    ok('#9501 「表示中の枠をすべて選ぶ」', await ev(`/選択中 3件/.test(document.getElementById('board-bulkbar').textContent)`), await ev(`document.getElementById('board-bulkbar').textContent`))
    await ev(`document.querySelector('[data-action=boardBulkDelete]').click()`); await wait(400)
    const conf = await ev(`document.querySelector('#modal-root .modal-box').innerText`)
    ok('#9501 確かめのモーダルに、枠の件数・割り当て済みの人数を出す', /3件の枠/.test(conf) && /割り当て済みの人が1人/.test(conf), conf)
    await ev(`document.querySelector('[data-action=bulkDeleteRun]').click()`)
    // toast は 2.5 秒で消えるので、出ている間に確かめる
    const toasted = await until(`[...document.querySelectorAll('#toast .toast-msg')].some(t => /3件の枠を削除しました/.test(t.textContent))`, 2400)
    await until(`!document.querySelector('.bulk-check') && document.querySelectorAll('#board-grid .board-cell').length === 0`, 4000)
    const after = await board(P, BROWSER_SLOTS.week, addDays(BROWSER_SLOTS.week, 6))
    ok('#9501 画面から3件の枠をまとめて削除し、シフトは枠なしで残る', BROWSER_SLOTS.ids.every(id => !after.slots.some(x => x.slot_id === id)) && after.unslotted.some(x => x.staff_id === A.staff_id), after.slots.map(x => x.slot_id))
    ok('#9501 削除の後は選択をやめ、チェックと帯を消す', toasted && await ev(`!document.querySelector('.bulk-check') && document.getElementById('board-bulkbar').hidden && !__boardState.bulkDel`))
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
