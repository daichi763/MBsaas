// 前の Sprint の持ち越し（w13-small-fixes: Sprint 13 #9631 #9632 #9633 #9634）の統合テスト
//   #9631 スタッフ詳細の「日報履歴」: 日報テンプレートを差し替えた後の古い項目を、キー名でなく元の表示名で出す（API の report_templates・report_past_fields）
//   #9632 募集ページの枠の人数の変更: 過ぎた日（今日の JST より前）の枠の人数は、サーバーでも 400 で止める（同じ人数のままなら通す）
//   #9633 入力のあるモーダルに「キャンセル」（スタッフ一覧の新規追加など）。入力したところがあれば、閉じてよいかを確かめる
//   #9634 毎週の繰り返し登録（/shifts/bulk の slot_match）: 引き継ぐ単価は、枠の役割の rate_role_name（単価を決める名前）で探す
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`npx wrangler dev --local --port 8813 --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8813 node scripts/test-w13-small-fixes.mjs
//   画面の確認（キャンセルのボタン・閉じる前の確認・日報履歴の表示名）は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8813'
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
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

const PFX = 'W13S' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`.toLowerCase(), name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`.toLowerCase())
}
async function newProject(tag, extra = {}) {
  must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${tag}`, unit_price: 10000, allow_duplicate: true, ...extra }), 'project ' + tag)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-${tag}`).project_id
}
async function newSlot(pid, date, roles, start = '10:00', end = '18:00') {
  const r = must(await admin.post('/api/admin/shift-slots', { project_id: pid, work_date: date, start_time: start, end_time: end, break_minutes: 0, roles }), 'slot ' + date)
  const slotId = r.slot_ids[0]
  const s = must(await admin.get(`/api/admin/shift-slots/${slotId}`), 'slot get')
  return { slot_id: slotId, roles: s.roles }
}
async function boardShift(id, date) {
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  for (const s of b.slots || []) for (const r of s.roles) { const a = r.assigned.find(x => x.shift_id === id); if (a) return a }
  return (b.unslotted || []).find(x => x.shift_id === id)
}

// =========================================================
// #9632 過ぎた日の枠の人数は、サーバーでも変えさせない
// =========================================================
{
  const pid = await newProject('recruit')
  const past = await newSlot(pid, addDays(today, -3), [{ role_name: '販売', headcount: 2 }])
  const now = await newSlot(pid, today, [{ role_name: '販売', headcount: 2 }])
  const future = await newSlot(pid, addDays(today, 3), [{ role_name: '販売', headcount: 2 }])
  const pastRole = past.roles[0].slot_role_id, todayRole = now.roles[0].slot_role_id, futureRole = future.roles[0].slot_role_id
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 10), notify_staff: false }), 'page')
  const headOf = async (id) => (await admin.get(`/api/admin/shift-slots/${id === pastRole ? past.slot_id : id === todayRole ? now.slot_id : future.slot_id}`)).data.roles.find(r => r.slot_role_id === id).headcount

  let r = await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { slot_headcounts: [{ slot_role_id: pastRole, headcount: 5 }] })
  ok('#9632 過ぎた日の枠の人数を変えると 400（理由を返す）', r.status === 400 && /過ぎた日の枠/.test(r.data?.error || '') && /販売/.test(r.data?.error || ''), r.data)
  ok('#9632 止めたときは人数を変えない', await headOf(pastRole) === 2)
  r = await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { slot_headcounts: [{ slot_role_id: futureRole, headcount: 4 }, { slot_role_id: pastRole, headcount: 3 }] })
  ok('#9632 過ぎた日の枠が1件でも混じれば、ほかの枠の人数も変えない', r.status === 400 && await headOf(futureRole) === 2, r.data)
  r = await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集2`, project_ids: [pid], date_from: today, date_to: addDays(today, 10), notify_staff: false, slot_headcounts: [{ slot_role_id: pastRole, headcount: 5 }] })
  ok('#9632 募集ページの作成でも、過ぎた日の枠の人数は変えられない（400）', r.status === 400 && /過ぎた日の枠/.test(r.data?.error || ''), r.data)
  r = await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { slot_headcounts: [{ slot_role_id: pastRole, headcount: 2 }, { slot_role_id: futureRole, headcount: 4 }] })
  ok('#9632 過ぎた日の枠でも、人数が同じままなら通す（ほかの枠の人数は変わる）', r.status === 200 && r.data?.headcounts_updated === 1 && await headOf(futureRole) === 4 && await headOf(pastRole) === 2, r.data)
  r = await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { slot_headcounts: [{ slot_role_id: todayRole, headcount: 3 }] })
  ok('#9632 今日の枠の人数は変えられる（今日は「過ぎた日」に入れない）', r.status === 200 && r.data?.headcounts_updated === 1 && await headOf(todayRole) === 3, r.data)
}

// =========================================================
// #9634 毎週の繰り返し登録（slot_match）の単価の引き継ぎは、rate_role_name で探す
// =========================================================
{
  const pid = await newProject('spot')
  must(await admin.put(`/api/admin/projects/${pid}/pricing`, { engagement_type: 'spot', unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000 }), 'pricing')
  must(await admin.post('/api/admin/rate-rules', { project_id: pid, role_name: '販売A', pay_unit_type: 'daily', pay_rate: 9000 }), 'rate rule')
  const B = await newStaff('b'), C = await newStaff('c'), D = await newStaff('d')
  let MON = addDays(today, 30); while (weekday(MON) !== 1) MON = addDays(MON, 1)
  const W1 = addDays(MON, 7)
  // 前回: 役割「販売A」の枠のシフト（支払 9,500 円に変えたもの）と、そのあとの別の役割の枠なしのシフト（支払 7,700 円）
  const s0 = await newSlot(pid, MON, [{ role_name: '販売A', headcount: 2 }])
  const a0 = must(await admin.post(`/api/admin/shift-slots/roles/${s0.roles[0].slot_role_id}/assign`, { staff_ids: [B.staff_id], force: true, inherit: false, price: { pay_rate: 9500 } }), 'assign B')
  const bShift = a0.shift_ids[0]
  ok('（準備）前回の「販売A」のシフトは支払 9,500 円', (await boardShift(bShift, MON))?.pay_rate === 9500, await boardShift(bShift, MON))
  must(await admin.post('/api/admin/shifts', { staff_id: D.staff_id, project_id: pid, work_date: addDays(MON, 1), start_time: '10:00', end_time: '18:00', role: 'サポート', inherit: false, price: { pay_rate: 7700 } }), 'plain shift D')
  // 今回の枠: 「販売A」を「販売B」に名前だけ変える（単価は今のルールのまま = rate_role_name は「販売A」）
  const s1 = await newSlot(pid, W1, [{ role_name: '販売A', headcount: 2 }])
  const rn = await admin.put(`/api/admin/shift-slots/${s1.slot_id}`, { roles: [{ slot_role_id: s1.roles[0].slot_role_id, role_name: '販売B', headcount: 2 }], role_rate: 'keep' })
  const renamed = must(await admin.get(`/api/admin/shift-slots/${s1.slot_id}`), 'slot').roles[0]
  ok('（準備）役割名を「販売B」に変え、単価を決める名前は「販売A」のまま', rn.status === 200 && renamed.role_name === '販売B' && renamed.rate_role_name === '販売A', [rn.data, renamed])

  const r = must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [C.staff_id], weekdays: [weekday(W1)], date_from: W1, date_to: W1, start_time: '10:00', end_time: '18:00', role: '販売B', slot_match: true }), 'bulk')
  const from = (r.inherited_from || [])[0]
  ok('#9634 枠に割り当てて登録する', r.created === 1, r)
  ok('#9634 引き継ぎ元は、単価を決める名前（販売A）の前回のシフト（あとの別の役割のシフトではない）', from && from.shift_id === bShift && from.work_date === MON && from.pay_rate === 9500, r.inherited_from)
  const bb = must(await admin.get(`/api/admin/shift-board?from=${W1}&to=${W1}&project_ids=${pid}`), 'board')
  const got = bb.slots.find(s => s.slot_id === s1.slot_id)?.roles[0].assigned.find(x => x.staff_id === C.staff_id)
  ok('#9634 登録したシフトの支払は、引き継いだ 9,500 円', got && got.pay_rate === 9500, got)

  // 名前を変えていない枠は今までどおり（役割名で探す）
  const W2 = addDays(W1, 7)
  await newSlot(pid, W2, [{ role_name: '販売A', headcount: 2 }])
  const r2 = must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [D.staff_id], weekdays: [weekday(W2)], date_from: W2, date_to: W2, start_time: '10:00', end_time: '18:00', role: '販売A', slot_match: true }), 'bulk2')
  const f2 = (r2.inherited_from || [])[0]
  ok('#9634 名前を変えていない枠は、役割名で前回を探す（今回登録した販売B の枠のシフト = 販売A の単価）', r2.created === 1 && f2 && f2.work_date === W1 && f2.pay_rate === 9500, r2.inherited_from)
  // slot_match なしは今までどおり（登録する役割名で探す）
  const W3 = addDays(W2, 7)
  const r3 = must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [B.staff_id], weekdays: [weekday(W3)], date_from: W3, date_to: W3, start_time: '10:00', end_time: '18:00', role: 'サポート' }), 'bulk3')
  const f3 = (r3.inherited_from || [])[0]
  ok('#9634 slot_match なしは、登録する役割名で前回を探す（サポート の 7,700 円）', r3.created === 1 && f3 && f3.pay_rate === 7700, r3.inherited_from)
}

// =========================================================
// #9631 スタッフ詳細の日報履歴の表示名
// =========================================================
const R = {}
{
  const ta = must(await admin.post('/api/admin/templates', { template_name: `${PFX}旧`, fields: [
    { key: 'seiyaku', label: '成約数', type: 'number' }, { key: 'w13old', label: 'W13旧の件数', type: 'number' }] }), 'template A')
  const tb = must(await admin.post('/api/admin/templates', { template_name: `${PFX}新`, fields: [
    { key: 'seiyaku', label: '成約数', type: 'number' }, { key: 'w13new', label: 'W13新の件数', type: 'number' }] }), 'template B')
  const pid = await newProject('report')
  must(await admin.put(`/api/admin/projects/${pid}`, { report_template_id: ta.template_id }), 'template A on project')
  const X = await newStaff('x')
  must(await admin.post('/api/admin/shifts', { staff_id: X.staff_id, project_id: pid, work_date: today, start_time: '00:01', end_time: '00:02', memo: PFX }), 'shift X')
  const list = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts
  const shiftId = list.find(s => s.memo === PFX && s.staff_id === X.staff_id).shift_id
  const st = client(await login('sample', X.user_code))
  const dr = await st.post('/api/staff/daily-report', { shift_id: shiftId, values: { seiyaku: 2, w13old: 4 } })
  ok('（準備）テンプレート A の項目（w13old）で日報を出す', dr.status === 200, dr.data)
  const ch = await admin.put(`/api/admin/projects/${pid}`, { report_template_id: tb.template_id, confirm_template_change: true })
  ok('（準備）案件のテンプレートを B に差し替える', ch.status === 200, ch.data)

  const d = must(await admin.get(`/api/admin/staff/${X.staff_id}`), 'staff detail')
  const rep = d.reports.find(x => x.project_id === pid)
  const past = (d.report_past_fields || {})[pid] || []
  const cur = (d.report_templates || {})[tb.template_id] || []
  ok('#9631 スタッフ詳細の日報履歴に、案件の今のテンプレートの項目を返す', rep && rep.report_template_id === tb.template_id && cur.some(f => f.key === 'w13new' && f.label === 'W13新の件数'), { rep, templates: d.report_templates })
  ok('#9631 差し替える前のテンプレートの項目を、元の表示名で返す', past.some(f => f.key === 'w13old' && f.label === 'W13旧の件数'), d.report_past_fields)
  ok('#9631 今のテンプレートにある項目は古い項目に入れない', !past.some(f => f.key === 'seiyaku'), past)
  ok('#9631 日報の値はこれまでどおり values で返し、内部の列（past_report_fields_json）は返さない', rep && rep.values.w13old === 4 && !('past_report_fields_json' in rep), rep)
  R.staff = X.staff_id
}

// ---------- 画面（静的な確認） ----------
{
  const js = (f) => readFileSync(new URL(`../public/static/${f}`, import.meta.url), 'utf8')
  const ad = js('admin.js'), cm = js('common.js'), ro = js('roster.js')
  ok('#9631 日報履歴は、日報の一覧と同じ reportFieldsOf で項目の表示名を引く', ad.includes('staffReportNumbersHtml(r, reportFieldsOf({ templates: data.report_templates, past_fields: data.report_past_fields }, r))')
    && !ad.includes("Object.entries(r.values).filter(([k, v]) => typeof v === 'number' && v > 0)"))
  ok('#9633 common.js に、キャンセルのボタンと、閉じる前に確かめる処理がある', cm.includes("const MODAL_CANCEL_BTN = '<button type=\"button\" class=\"btn btn-outline flex-1\" data-action=\"modalCancel\">キャンセル</button>'")
    && cm.includes("delegate('modalCancel', closeModalIfConfirmed)") && cm.includes("delegate('modalX', closeModalIfConfirmed)") && /入力した内容は保存されていません。閉じてよいですか？/.test(cm))
  ok('#9633 スタッフ一覧の新規追加（showRosterForm）の登録の横にキャンセル', /\$\{MODAL_CANCEL_BTN\}\s*<button class="btn btn-primary flex-1" data-action="submitRosterForm"/.test(ro))
  // 入力のあるモーダルで、キャンセル・戻る・やめる・閉じるのどれも無いものが残っていない（hq.js は本部の画面で別の作業単位の担当）
  const BS = 92
  const endOfTemplate = (s, i) => { i++; while (i < s.length) { const c = s[i]; if (s.charCodeAt(i) === BS) { i += 2; continue } if (c === '`') return i; if (c === '$' && s[i + 1] === '{') { i = endOfExpr(s, i + 2); continue } i++ } return i }
  const endOfExpr = (s, i) => { let d = 1; while (i < s.length) { const c = s[i]; if (c === '`') { i = endOfTemplate(s, i) + 1; continue } if (c === "'" || c === '"') { const q = c; i++; while (i < s.length && s[i] !== q) { if (s.charCodeAt(i) === BS) i++; i++ } i++; continue } if (c === '{') d++; if (c === '}') { d--; if (!d) return i + 1 } i++ } return i }
  // 入力欄はあるが、保存のボタンが無い・別の描き方で閉じるボタンを出すモーダル（[ファイル, モーダルの中の目印]。理由は各行）
  const EXEMPT = [
    ['admin.js', 'data-action="assignSubstitute"'], // 代打の候補: 「あとで探す」で閉じる（入力は候補の絞り込みだけ）
    ['admin.js', 'doc-dropzone'], // 書類のアップロード: ファイルを選ぶとすぐアップロードする（保存のボタンが無い）。右上に ✕
    ['admin.js', 'saveSkillSheetComment'], ['admin.js', 'remindNotice'], ['roster.js', 'shareCodesExport'], // 表示・印刷・既読の確認が中心
    ['shift-board.js', 'boardSavePrice'], ['shift-board.js', 'toggleShiftRequestsAll'], // シフトの詳細・シフト希望の一覧
    ['board.js', 'boardLoadCandidates'], ['corrections.js', '管理者として申請'], // 選んだ後に描く欄にキャンセルがある
    ['staff-attendance.js', '${foot}'], // スタッフアプリの申請: 下のボタン（foot）に「やめる」
  ]
  const leftovers = []
  for (const f of ['admin.js', 'roster.js', 'shift-board.js', 'staff-lifecycle.js', 'settlement.js', 'report-settings.js', 'corrections.js', 'board.js', 'recruit.js', 'hq-support.js', 'staff-attendance.js']) {
    const s = js(f), re = /\bmodal\(`/g; let m
    while ((m = re.exec(s))) {
      const t = s.slice(m.index + 6, endOfTemplate(s, m.index + 6) + 1)
      if (!/<input|<select|<textarea/.test(t) || /キャンセル|>閉じる<|>やめる<|MODAL_CANCEL_BTN|戻る|fa-arrow-left/.test(t)) continue
      if (!EXEMPT.some(([ef, mark]) => ef === f && t.includes(mark))) leftovers.push(`${f}:${s.slice(0, m.index).split('\n').length}`)
    }
  }
  ok('#9633 入力のあるモーダルで、キャンセル・戻るの無いものは、決めた例外だけ', !leftovers.length, leftovers)
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w13s-'))
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
    let dialogAccept = true
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: dialogAccept }) }
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const ck = await login('sample', 'admin')
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    await send('Page.navigate', { url: `${BASE}/admin#staff/${R.staff}` }); await wait(4000)
    const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200) } return false }
    const typeInto = async (sel, text) => { await ev(`document.querySelector('${sel}').focus()`); await send('Input.insertText', { text }); await wait(100) }
    const modalOpen = () => ev(`!!document.querySelector('#modal-root .modal-bg')`)

    // #9631 スタッフ詳細の日報履歴に、元の表示名で出る
    await until(`[...document.querySelectorAll('h3')].some(h => h.textContent.includes('日報履歴'))`)
    const hist = await ev(`(() => { const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('日報履歴')); return h ? h.closest('section').innerText : '' })()`)
    ok('#9631 画面: 日報履歴に、差し替える前の項目を元の表示名で出す（キー名 w13old で出さない）', /W13旧の件数 4/.test(hist) && /成約数 2/.test(hist) && !/w13old/.test(hist), hist)

    // #9633 スタッフ一覧の新規追加（②③④）にキャンセル。入力が無ければそのまま閉じる
    for (const route of ['employee', 'partner', 'skillsheet']) {
      await ev('closeModal()'); await ev(`showRosterForm('${route}')`); await wait(900)
      const btns = await ev(`[...document.querySelectorAll('#modal-root .modal-box button')].map(b => b.textContent.trim())`)
      ok(`#9633 新規追加（${route}）: 「登録する」の横に「キャンセル」`, Array.isArray(btns) && btns.includes('キャンセル') && btns.indexOf('キャンセル') === btns.indexOf('登録する') - 1, btns)
    }
    await ev('closeModal()'); await ev(`showRosterForm('employee')`); await wait(900)
    dialogs.length = 0
    await ev(`document.querySelector('#modal-root [data-action=modalCancel]').click()`); await wait(300)
    ok('#9633 入力していなければ、確かめずに閉じる（スタッフ番号は画面が入れた値なので入力に数えない）', !(await modalOpen()) && dialogs.length === 0, dialogs)
    await ev(`showRosterForm('employee')`); await wait(900)
    await typeInto('#rf-name', '山田 太郎')
    dialogAccept = false; dialogs.length = 0
    await ev(`document.querySelector('#modal-root [data-action=modalCancel]').click()`); await wait(400)
    ok('#9633 入力したあとのキャンセルは、閉じてよいかを確かめる（やめれば入力は残る）', dialogs.some(d => /閉じてよいですか/.test(d)) && await modalOpen() && await ev(`document.getElementById('rf-name').value === '山田 太郎'`), dialogs)
    dialogs.length = 0
    await ev(`document.querySelector('#modal-root .modal-x').click()`); await wait(400)
    ok('#9633 右上の ✕ でも同じく確かめる', dialogs.some(d => /閉じてよいですか/.test(d)) && await modalOpen(), dialogs)
    dialogAccept = true; dialogs.length = 0
    await ev(`document.querySelector('#modal-root [data-action=modalCancel]').click()`); await wait(400)
    ok('#9633 「OK」なら閉じる', !(await modalOpen()) && dialogs.length === 1)
    // 入力して元に戻したときは確かめない
    await ev(`showRosterForm('skillsheet')`); await wait(900)
    await typeInto('#rf-kana', 'ア')
    await ev(`document.getElementById('rf-kana').focus()`); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await wait(200)
    dialogs.length = 0
    await ev(`document.querySelector('#modal-root [data-action=modalCancel]').click()`); await wait(300)
    ok('#9633 入力して元に戻したときは、確かめずに閉じる', await ev(`!document.querySelector('#modal-root .modal-bg')`) && dialogs.length === 0, { dialogs, v: await ev(`document.getElementById('rf-kana') && document.getElementById('rf-kana').value`) })

    // #9633 ほかの入力のあるモーダルにも「キャンセル」（主なボタンの左）
    // シフト管理の画面のモーダル（枠・繰り返し登録など）は、シフト管理を開いてから呼ぶ
    await ev(`location.hash = 'shifts'`); await wait(3500)
    // data-action で開くものは delegate の処理を直接呼ぶ
    const dg = (name, data = {}) => `delegate.handlers.${name}({ dataset: ${JSON.stringify(data)} })`
    const openers = [
      ['スタッフ登録', 'showAddStaff()'], ['案件登録', 'showAddProject()'], ['クライアント登録', 'showAddClient()'], ['シフト登録', `showAddShift('${today}')`],
      ['日報テンプレート', dg('newAdminTemplate')], ['IDをまとめて連携', 'showRosterBulkLink()'], ['フォロー記録', `showFollowModal(${R.staff}, 'X')`],
      ['評価', dg('showEvaluationModal', { id: String(R.staff) })], ['仮登録', 'showQuickRegister({})'], ['区分を変更', `openAffiliationChange(${R.staff})`],
      ['前日確認の設定', dg('showDayBeforeSetting')], ['遅刻の猶予', dg('showLatenessSetting')], ['緊急連絡先・入店の位置', dg('showSiteContactSetting')],
      ['枠を作成', 'openSlotModal()'], ['枠の繰り返し登録', 'openPatternModal()'], ['常勤の一括登録', 'openBulkModal()'], ['枠とシフトをコピー', 'openCopyModal()'],
      ['単価ルール', 'openRuleModal({})'], ['単価ルールの再適用', 'repriceProject()'], ['管理者を追加', dg('showAddAdminUser')],
    ]
    const seen = []
    for (const [label, call] of openers) {
      await ev('closeModal()')
      const r = await ev(`(async () => { await ${call}; return 'ok' })()`)
      await wait(900)
      const st = await ev(`(() => { const box = document.querySelector('#modal-root .modal-box'); if (!box) return null
        const c = box.querySelector('[data-action=modalCancel]'); const row = c && c.parentElement
        return { cancel: !!c, text: c && c.textContent.trim(), next: c && c.nextElementSibling && c.nextElementSibling.className, flex: !!row && getComputedStyle(row).display === 'flex' } })()`)
      if (r !== 'ok' || !st) { console.log(`  （${label}: モーダルを開けませんでした ${JSON.stringify(r).slice(0, 120)}）`); continue }
      seen.push({ label, ...st })
    }
    const bad = seen.filter(s => !s.cancel || s.text !== 'キャンセル' || !s.flex || !/btn/.test(s.next || ''))
    ok(`#9633 ほかの入力のあるモーダル（${seen.length}件）にも、主なボタンの左に「キャンセル」が横並びで出る`, seen.length >= 12 && !bad.length, { bad, opened: seen.map(s => s.label) })
    await ev('closeModal()')
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
