// 持ち越しの棚卸し（Sprint 14・w14-ui）の画面の残りの統合テスト
//   #158 管理画面の日報一覧に「スタッフ既読」（comment_read_at）
//   #283 欠勤にするその場で理由（スタッフ都合／クライアント都合）を選ぶ（PUT /admin/shifts の cancel_reason）
//   #297 スタッフ一覧・クライアント一覧で、書類（契約書）の期限が近い・切れたものを絞り込む（doc_expiring）
//   #173 スタッフアプリのホームの今日のシフト・相談の画面と、報告用URLに、現場責任者と会社の緊急連絡先
//   #215 打刻の一覧で、申請の期限（request_until）を過ぎたシフトは「修正」「追加申請」を出さない
//   #167 スタッフアプリの支払の内訳に「＋ 割増 ○円」。割増の設定に、週40時間超・祝日を計算しない注記
//   #9633 本部の画面の入力のあるモーダルに「キャンセル」
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`npx wrangler dev --local --port 8812 --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w14-ui.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8812'
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
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const headers = { Cookie: cookie || '' }
    if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const PFX = 'W14U' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: phoneOf() }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newShift(staff_id, project_id, work_date, start_time = '10:00', end_time = '18:00') {
  const memo = `${PFX}-${++seq}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
}

// 会社の設定は最後に元に戻す
const before = {
  site: must(await admin.get('/api/admin/settings/site-contact'), 'site-contact get'),
  deadline: must(await admin.get('/api/admin/settings/corrections'), 'corrections settings get').deadline_days,
  pay: must(await admin.get('/api/admin/staff-pay/settings'), 'staff pay settings get').staff_pay_visible,
  premium: must(await admin.get('/api/admin/settlement/premium-settings'), 'premium get').settings,
}

const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, allow_duplicate: true }), 'project').project_id
must(await admin.put(`/api/admin/projects/${P}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'scheduled', pay_transport_type: 'actual', bill_transport_type: 'actual' }), 'pricing')
const A = await newStaff('A')
const ac = client(await login('sample', `${PFX}A`))
const R = { staff: A.staff_id }

// ---------- #158 日報のスタッフ既読 ----------
{
  const Y = addDays(today, -1)
  const s = await newShift(A.staff_id, P, Y)
  const sub = await ac.post('/api/staff/daily-report', { shift_id: s.shift_id, values: { free: '本日の報告' } })
  ok('（前提）スタッフが日報を出す', sub.status === 200, sub.text)
  const dr = must(await admin.get(`/api/admin/daily-reports?date=${Y}&staff_id=${A.staff_id}`), 'reports').reports[0]
  must(await admin.put(`/api/admin/daily-reports/${dr.daily_report_id}`, { manager_comment: 'よくできました' }), 'comment')
  const a0 = must(await admin.get(`/api/admin/daily-reports?date=${Y}&staff_id=${A.staff_id}`), 'reports').reports[0]
  ok('#158 コメントを書いた直後の一覧は、スタッフ既読が空（画面は「スタッフ未読」）', a0.manager_comment === 'よくできました' && a0.comment_read_at == null, a0.comment_read_at)
  must(await ac.get(`/api/staff/my-reports/${dr.daily_report_id}`), 'open report')
  const a1 = must(await admin.get(`/api/admin/daily-reports?date=${Y}&staff_id=${A.staff_id}`), 'reports').reports[0]
  ok('#158 スタッフが開くと、管理画面の日報一覧に comment_read_at が入る（画面は「スタッフ既読 M/D HH:mm」）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(a1.comment_read_at || ''), a1.comment_read_at)
  R.reportDate = Y; R.reportId = dr.daily_report_id
}

// ---------- #283 欠勤の理由 ----------
{
  const s1 = await newShift(A.staff_id, P, addDays(today, 2))
  must(await admin.put(`/api/admin/shifts/${s1.shift_id}`, { status: 'absent', cancel_reason: 'client' }), 'absent client')
  const cx = must(await admin.get(`/api/admin/settlement/cancellations/${s1.shift_id}`), 'cancellation')
  ok('#283 欠勤にするときに理由（クライアント都合）を送ると、精算のキャンセル料・補償に理由が入る', cx.cancellation && cx.cancellation.reason === 'client', cx.cancellation)
  must(await admin.put(`/api/admin/shifts/${s1.shift_id}`, { status: 'confirmed' }), 'back')
  const cx2 = must(await admin.get(`/api/admin/settlement/cancellations/${s1.shift_id}`), 'cancellation 2').cancellation
  ok('#283 欠勤から戻すと、理由（キャンセル料・補償）は消える', cx2 == null, cx2)
  const s2 = await newShift(A.staff_id, P, addDays(today, 3))
  must(await admin.put(`/api/admin/shifts/${s2.shift_id}`, { status: 'absent' }), 'absent no reason')
  const cx3 = (await admin.get(`/api/admin/settlement/cancellations/${s2.shift_id}`)).data
  ok('#283 理由を残さずに欠勤にすると、キャンセル料・補償は作らない（今までどおり）', cx3 && cx3.cancellation == null, cx3)
  const bad = await admin.put(`/api/admin/shifts/${s2.shift_id}`, { status: 'confirmed', cancel_reason: 'xxx' })
  ok('#283 理由の値が正しくなければ 400', bad.status === 400, bad.status)
  R.absentShift = (await newShift(A.staff_id, P, addDays(today, 4))).shift_id
}

// ---------- #297 書類の期限 ----------
{
  const B = await newStaff('B')
  const fd = new FormData()
  fd.append('files', new Blob(['%PDF-1.4\n%w14\n'], { type: 'application/pdf' }), 'w14-shikaku.pdf')
  fd.append('doc_type', 'qualification'); fd.append('valid_until', addDays(today, 10))
  const up = await admin.post(`/api/admin/staff/${B.staff_id}/documents`, fd)
  ok('（前提）期限が10日後の資格証をアップロード', up.status === 200 && up.data.results.every(x => x.ok), up.text)
  const list = must(await admin.get('/api/admin/staff'), 'staff list').staff
  const b = list.find(s => s.staff_id === B.staff_id), a = list.find(s => s.staff_id === A.staff_id)
  ok('#297 スタッフ一覧に、期限が30日以内の書類の数（doc_expiring）を返す（画面の「書類の期限」の絞り込みに使う）', Number(b.doc_expiring) === 1 && Number(a.doc_expiring) === 0, { b: b.doc_expiring, a: a.doc_expiring })
  const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
  const cid = cl.client_id || cl.id
  const fd2 = new FormData()
  fd2.append('files', new Blob(['%PDF-1.4\n%w14c\n'], { type: 'application/pdf' }), 'w14-keiyaku.pdf')
  fd2.append('doc_type', 'contract_basic'); fd2.append('valid_until', addDays(today, -1))
  const up2 = await admin.post(`/api/admin/clients/${cid}/documents`, fd2)
  ok('（前提）契約終了日が昨日の契約書をアップロード', up2.status === 200, up2.text)
  const c = must(await admin.get('/api/admin/clients'), 'clients').clients.find(x => x.client_id === cid)
  ok('#297 クライアント一覧に、期限が近い・切れた契約書の数（doc_expiring）を返す', c && Number(c.doc_expiring) === 1, c)
  R.docStaff = B.staff_id; R.docClient = cid
}

// ---------- #173 現場責任者・緊急連絡先 ----------
{
  must(await admin.put(`/api/admin/projects/${P}`, { site_contact_name: '現場 花子', site_contact_phone: '090-1111-2222' }), 'site contact')
  must(await admin.put('/api/admin/settings/site-contact', { emergency_phone: '03-1234-5678', emergency_note: '9時〜18時', far_threshold_m: before.site.far_threshold_m ?? 500 }), 'emergency')
  const s = await newShift(A.staff_id, P, today, '00:00', '23:59')
  const home = must(await ac.get('/api/staff/home?shift_id=' + s.shift_id), 'home')
  ok('#173 ホームのシフトに現場責任者の名前・電話を返す', home.shift && home.shift.site_contact_name === '現場 花子' && home.shift.site_contact_phone === '090-1111-2222', home.shift)
  const em = must(await ac.get('/api/staff/emergency-contacts'), 'emergency contacts').contacts
  ok('#173 会社の緊急連絡先を返す（ホーム・相談の画面に出す）', em.some(x => x.phone === '03-1234-5678'), em)
  const link = must(await admin.post(`/api/admin/shifts/${s.shift_id}/report-link`), 'report link')
  const token = link.token || String(link.url || '').split('/r/')[1]
  const v = must(await client('').get(`/api/public/report/${token}`), 'report link view')
  ok('#173 報告用URLのシフトに現場責任者を返す', v.shift && v.shift.site_contact_phone === '090-1111-2222', v.shift)
  R.todayShift = s.shift_id; R.token = token
}

// ---------- #215 申請の期限 ----------
{
  const old = await newShift(A.staff_id, P, addDays(today, -5))
  must(await admin.put('/api/admin/settings/corrections', { deadline_days: 2 }), 'deadline')
  const tl = must(await ac.get(`/api/staff/attendance/timeline?to=${today}`), 'timeline')
  const row = tl.shifts.find(x => x.shift_id === old.shift_id)
  ok('#215 打刻の一覧のシフトに申請の期限（request_until）を返す（勤務日＋2日）', row && row.request_until === addDays(today, -3), row)
  const r = await ac.post('/api/staff/corrections', { shift_id: old.shift_id, kind: 'add', report_type: 'check_in', requested_at: `${old.work_date} 10:00`, reason: '押し忘れた' })
  ok('#215 期限を過ぎたシフトの申請はサーバーが断る（画面はボタンを出さない）', r.status === 400 && /日を過ぎたため/.test(r.data && r.data.error), r.text)
  R.oldShift = old.shift_id
}

// ---------- #167 割増の内訳 ----------
{
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: true }), 'pay visible')
  must(await admin.put('/api/admin/settlement/premium-settings', { enabled: true, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [], daily_limit_minutes: 480 }), 'premium on')
  // 今月の夜のシフト（22〜23時の1時間が深夜）。月の初日でも今月に入るよう today を使う（A の今日のシフトと重ならないよう別の人）
  const C = await newStaff('C')
  const cc = client(await login('sample', `${PFX}C`))
  const n = await newShift(C.staff_id, P, today, '18:00', '23:00')
  const pay = must(await cc.get(`/api/staff/pay?month=${today.slice(0, 7)}`), 'staff pay')
  const p = (pay.shifts.find(x => x.shift_id === n.shift_id) || {}).pay
  ok('#167 スタッフの支払に割増（premium）と時間の内訳を返し、内訳の足し算が合計と合う', p && p.premium === 300 && p.premium_minutes && p.premium_minutes.night === 60
    && p.base + p.transport + p.premium + p.adjust === p.total, p)
  R.nightShift = n.shift_id
}

// ---------- 画面（静的な確認） ----------
{
  const js = (f) => readFileSync(new URL(`../public/static/${f}`, import.meta.url), 'utf8')
  const ad = js('admin.js'), st = js('staff.js'), sa = js('staff-attendance.js'), rl = js('report-link.js'), se = js('settlement.js'), hq = js('hq.js')
  // コメントを複数にした #9965 の後は、コメントごとの既読（read_at）を出す
  ok('#158 日報のコメントの下に、スタッフ既読（コメントごとの read_at）を出す', /function reportCommentReadHtml\(cm, fmt\)/.test(ad) && ad.includes('スタッフ既読 ${esc(fmt(cm.read_at))}') && ad.includes('${reportCommentReadHtml(cm, fmt)}'))
  ok('#283 欠勤にするときは理由を選び、cancel_reason で送る（シフトボードは putShiftStatus を使う）', ad.includes("if (status === 'absent' && cancelReason) body.cancel_reason = cancelReason") && /function askAbsentReason\(head\)/.test(ad) && ad.includes('const reason = await askAbsentReason(msg)'))
  ok('#297 スタッフ一覧の状態の絞り込みに「書類の期限」、クライアント一覧に契約書の期限の絞り込み', ad.includes("['docexp', '書類の期限']") && ad.includes('docexp: s => Number(s.doc_expiring) > 0') && ad.includes("(!L.docexp || Number(c.doc_expiring) > 0)"))
  ok('#173 スタッフアプリのホームのシフトと相談の画面、報告用URLに現場責任者・緊急連絡先を出す', st.includes('${homeShiftContactsHtml(s, cur)}') && st.includes("loadEmergencyContacts('consult-emergency')") && /function siteContactHtml\(s\)/.test(rl) && (rl.match(/\$\{siteContactHtml\(s\)\}/g) || []).length === 2)
  ok('#215 期限を過ぎたシフトは「修正」「追加申請」を出さず、onclick に値を埋め込まない', sa.includes('const expired = !locked && requestExpired(s)') && !sa.includes('onclick="attOpen(') && sa.includes("delegate('attOpenRow'"))
  ok('#167 支払の内訳に割増、割増の設定に週40時間・祝日の注記', sa.includes('割増 ${esc(yenText(p.premium))}') && se.includes('週40時間を超えた分・国民の祝日の割増は計算しません。必要なときは精算で手で調整してください'))
  const n = (hq.match(/<div class="flex gap-2">\$\{MODAL_CANCEL_BTN\}<button class="btn btn-primary flex-1"/g) || []).length
  ok('#9633 本部の画面の入力のあるモーダル6つに、主なボタンの左に「キャンセル」', n === 6, n)
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()  // 空いているポート（#9980）
  const prof = mkdtempSync(join(tmpdir(), 'w14u-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
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
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200) } return false }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const as = async (company, user) => {
      await send('Network.clearBrowserCookies')
      const ck = await login(company, user)
      const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    }
    const text = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : '' })()`)

    // ----- 管理画面 -----
    await as('sample', 'admin')
    await send('Page.navigate', { url: `${BASE}/admin#reports/date=${R.reportDate}&staff=${R.staff}` }); await wait(1500)
    const readSel = `[data-action=commentReport][data-id="${R.reportId}"]`
    await until(`!!document.querySelector('[data-report-comment] [data-comment-read]')`)
    const badge = await ev(`(() => { const b = document.querySelector(${JSON.stringify(readSel)}); const card = b && b.closest('section'); const el = card && card.querySelector('[data-comment-read]'); return el ? el.innerText : '' })()`)
    ok('#158 画面: 日報のコメントの下に「スタッフ既読 M/D HH:mm」', /スタッフ既読 \d{1,2}\/\d{1,2} \d{2}:\d{2}/.test(badge), badge)

    // スタッフ一覧の「書類の期限」の絞り込み
    await ev(`location.hash = 'staff'`)
    await until(`!!document.querySelector('[data-action=toggleStaffFilter][data-key=docexp]')`)
    await ev(`document.querySelector('[data-action=toggleStaffFilter][data-key=docexp]').click()`); await wait(400)
    const ids = await ev(`[...document.querySelectorAll('#staff-rows [data-action=openStaffDetail]')].map(r => Number(r.dataset.id))`)
    ok('#297 画面: 「書類の期限」で絞ると、期限の近い書類のある人だけが出る', Array.isArray(ids) && ids.includes(R.docStaff) && !ids.includes(R.staff), ids)
    await ev(`document.querySelector('[data-action=toggleStaffFilter][data-key=docexp]').click()`); await wait(200)
    await ev(`location.hash = 'clients'`)
    await until(`!!document.getElementById('client-docexp')`)
    await ev(`(() => { const c = document.getElementById('client-docexp'); c.checked = true; c.dispatchEvent(new Event('change')) })()`); await wait(300)
    const cards = await ev(`[...document.querySelectorAll('#client-cards section')].map(s => s.querySelector('a').getAttribute('href'))`)
    ok('#297 画面: クライアント一覧で「契約書の期限が近い・切れた」を選ぶと、その会社だけが出る', Array.isArray(cards) && cards.includes(`#clients/${R.docClient}`) && cards.every(h => h), cards)

    // 欠勤の理由を選ぶ画面（シフトボードからも同じ putShiftStatus を使う）
    // 理由の画面を押すまで終わらないので、待たずに始める
    await ev(`void (window.__w14 = putShiftStatus(${R.absentShift}, 'absent'))`)
    await until(`!!document.getElementById('absent-reason')`, 3000)
    const reasonBtns = await ev(`[...document.querySelectorAll('#absent-reason button')].map(b => b.textContent.trim())`)
    ok('#283 画面: 欠勤にするとき、スタッフ都合／クライアント都合／理由なし／キャンセルを選べる', Array.isArray(reasonBtns) && reasonBtns.some(t => t.includes('スタッフ都合')) && reasonBtns.some(t => t.includes('クライアント都合')) && reasonBtns.includes('キャンセル'), reasonBtns)
    await ev(`document.querySelector('#absent-reason [data-reason="staff"]').click()`)
    await ev('window.__w14'); await wait(300)
    const cx = must(await admin.get(`/api/admin/settlement/cancellations/${R.absentShift}`), 'cancellation').cancellation
    ok('#283 画面: 選んだ理由（スタッフ都合）で欠勤になる', cx && cx.reason === 'staff' && !(await ev(`!!document.getElementById('absent-reason')`)), cx)
    const res = await ev(`(async () => { const p = putShiftStatus(${R.absentShift}, 'confirmed'); return !!(await p) })()`)
    await ev(`(async () => { const p = putShiftStatus(${R.todayShift}, 'absent'); await new Promise(r => setTimeout(r, 200)); document.querySelector('#absent-reason [data-reason-cancel]').click(); return await p })()`)
    const still = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.shift_id === R.todayShift)
    ok('#283 画面: 理由の画面で「キャンセル」なら欠勤にしない', res && still && still.status !== 'absent', still && still.status)

    // 割増の設定の注記
    await ev(`location.hash = 'settlement'`)
    await until(`!!document.getElementById('settle-premium-btn')`)
    await ev(`document.getElementById('settle-premium-btn').click()`)
    await until(`!!document.getElementById('premium-not-covered')`, 4000)
    ok('#167 画面: 割増の設定に、週40時間超・祝日を計算しない注記', /週40時間を超えた分・国民の祝日の割増は計算しません/.test(await text('#premium-not-covered')))
    await ev('closeModal()')

    // ----- スタッフアプリ -----
    await as('sample', `${PFX}A`)
    await send('Page.navigate', { url: `${BASE}/staff` }); await wait(1500)
    await ev(`(async () => { HOME_SHIFT_ID = ${R.todayShift}; await renderHome() })()`)
    await until(`!!document.querySelector('#home-emergency a[href^="tel:"]')`)
    const card = await text('#today-shift')
    const tels = await ev(`[...document.querySelectorAll('#today-shift a[href^="tel:"]')].map(a => a.getAttribute('href'))`)
    ok('#173 画面: ホームの今日のシフトに、現場責任者と緊急連絡先（タップで発信）', /現場責任者: 現場 花子/.test(card) && /緊急連絡先/.test(card) && tels.includes('tel:09011112222') && tels.includes('tel:0312345678'), { card, tels })
    await ev(`location.hash = 'consult'`)
    await until(`!!document.querySelector('#consult-emergency a[href^="tel:"]')`)
    ok('#173 画面: 相談・連絡の画面にも緊急連絡先', /緊急連絡先/.test(await text('#consult-emergency')))
    await ev(`location.hash = 'attendance/timeline/${today}'`)
    await until(`!!document.getElementById('att-shift-${R.oldShift}')`)
    const oldCard = await text(`#att-shift-${R.oldShift}`)
    const oldBtns = await ev(`document.querySelectorAll('#att-shift-${R.oldShift} [data-action=attOpenRow]').length`)
    const nowBtns = await ev(`document.querySelectorAll('#att-shift-${R.todayShift} [data-action=attOpenRow]').length`)
    ok('#215 画面: 期限を過ぎたシフトは「修正」「追加申請」を出さず「期限切れ」と出す（期限内のシフトは出す）', oldBtns === 0 && /期限切れ/.test(oldCard) && nowBtns > 0, { oldBtns, nowBtns, oldCard })

    // 支払（夜のシフトのある C で開く）
    await as('sample', `${PFX}C`)
    await send('Page.navigate', { url: `${BASE}/staff#pay` }); await wait(1500)
    await until(`!!document.querySelector('[data-shift-id="${R.nightShift}"] .pay-premium')`)
    const payText = await text(`[data-shift-id="${R.nightShift}"]`)
    ok('#167 画面: スタッフアプリの支払の内訳に「＋ 割増 300円（深夜 1時間）」', /＋ 割増 300円（深夜 1時間）/.test(payText), payText)

    // ----- 報告用URL -----
    await send('Network.clearBrowserCookies')
    await send('Page.navigate', { url: `${BASE}/r/${R.token}` })
    await until(`!!document.querySelector('#report-link-shift .site-contact')`)
    const rlText = await text('#report-link-shift .site-contact')
    ok('#173 画面: 報告用URLのシフトの欄に現場責任者（電話はタップで発信）', /現場責任者: 現場 花子/.test(rlText) && await ev(`!!document.querySelector('#report-link-shift a[href="tel:09011112222"]')`), rlText)

    // ----- 本部 -----
    await as('sample', 'hq')
    await send('Page.navigate', { url: `${BASE}/hq#templates` }); await wait(2500)
    const seen = []
    for (const [label, call] of [['テンプレート作成', 'showAddTemplate()'], ['管理者を追加', `delegate.handlers.hqAddAdmin({ dataset: { cid: '1' } })`]]) {
      await ev('closeModal()'); await ev(call); await wait(500)
      const st = await ev(`(() => { const c = document.querySelector('#modal-root [data-action=modalCancel]'); return c ? { next: c.nextElementSibling && c.nextElementSibling.className } : null })()`)
      seen.push({ label, st })
      if (st) { await ev(`document.querySelector('#modal-root [data-action=modalCancel]').click()`); await wait(300) }
      seen[seen.length - 1].closed = await ev(`!document.querySelector('#modal-root .modal-bg')`)
    }
    ok('#9633 画面: 本部のモーダルに「キャンセル」が主なボタンの左にあり、押すと閉じる', seen.every(s => s.st && /btn-primary flex-1/.test(s.st.next || '') && s.closed), seen)

    ok('画面: スクリプトのエラーがない', !errors.length, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await wait(500)
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

// 会社の設定を元に戻す（画面の確認で同じ管理者にログインし直すと、最初のセッションは使えなくなるので、ログインし直して戻す）
{
  const adm = client(await login('sample', 'admin'))
  const back = [
    await adm.put('/api/admin/settings/site-contact', { emergency_phone: before.site.emergency_phone || '', emergency_note: before.site.emergency_note || '', far_threshold_m: before.site.far_threshold_m ?? 500 }),
    await adm.put('/api/admin/settings/corrections', { deadline_days: before.deadline ?? null }),
    await adm.put('/api/admin/staff-pay/settings', { staff_pay_visible: !!before.pay }),
    await adm.put('/api/admin/settlement/premium-settings', before.premium),
  ]
  ok('（後始末）会社の設定を元に戻す', back.every(r => r.status === 200), back.map(r => r.status))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
