// シフト希望の提出・取り下げ・採否の返事と、管理者の『希望（仮）』への本人の返事の統合テスト（w2-shift-request: #12 #59 #353 #411）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
//   本部（hq）で 2 社目を作り、その会社の案件を指定した希望が受け付けられないことも確かめる。
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-shift-request.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
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
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tag = Date.now().toString(36).slice(-5)

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001')) // staff_id 1
const st2 = client(await login('sample', 'st002')) // staff_id 2

// ---------- 2 社目（B 社）と、その案件 ----------
const hq = client(await login('sample', 'hq'))
const codeB = 'sr' + tag, pwB = 'Sr-Passw0rd-' + tag
const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `希望確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
ok('（前提）B 社を作成', cr.status === 200, cr)
const adminB = client(await login(codeB, 'adminb', pwB))
await adminB.post('/api/admin/clients', { client_name: `B社の取引先${tag}` })
const clientB = (await adminB.get('/api/admin/clients')).data.clients.find(x => x.client_name === `B社の取引先${tag}`)
await adminB.post('/api/admin/projects', { project_name: `B社の案件${tag}`, client_id: clientB.client_id, location: 'B社の店舗' })
const projB = (await adminB.get('/api/admin/projects')).data.projects.find(x => x.project_name === `B社の案件${tag}`)
ok('（前提）B 社の案件', !!projB, projB)

// ---------- #12 案件を選ばない希望を提出できる ----------
const d1 = addDays(today, 5)
const month1 = d1.slice(0, 7)
const r1 = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '10:00', end_time: '18:00', memo: `SR-A${tag}` })
ok('#12 案件なしの希望を提出できる（200）', r1.status === 200 && r1.data.request_id, r1)
let list = (await st1.get('/api/staff/shifts?month=' + month1)).data
const reqA = (list.requests || []).find(r => r.request_id === r1.data.request_id)
ok('#12 提出した希望が本人のシフト画面に出る（案件の指定なし）', reqA && reqA.status === 'pending' && reqA.project_name == null && reqA.memo === `SR-A${tag}`, list.requests)
ok('#12 希望は shifts に入らない（シフト一覧に出ない）', !list.shifts.some(s => s.memo === `SR-A${tag}`), list.shifts.filter(s => s.memo))
const dup = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '10:00', end_time: '18:00', memo: 'もう一度' })
ok('#12 同じ日時の返事待ちの希望は二重に作らない（409）', dup.status === 409, dup)
let adm = (await admin.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}`)).data
const admA = adm.requests && adm.requests.find(r => r.request_id === r1.data.request_id)
ok('#12 管理者の希望一覧に出る（スタッフ名つき・返事待ち件数）', admA && admA.staff_name && adm.pending >= 1, adm)

// ---------- 入力の検証 ----------
const bad = [
  ['過去の日付', { work_date: addDays(today, -1), start_time: '10:00', end_time: '18:00' }],
  ['日付なし', { start_time: '10:00', end_time: '18:00' }],
  ['実在しない日付', { work_date: '2026-02-30', start_time: '10:00', end_time: '18:00' }],
  ['時刻の形式', { work_date: d1, start_time: '25:00', end_time: '18:00' }],
  ['開始と終了が同じ', { work_date: d1, start_time: '10:00', end_time: '10:00' }],
  ['備考が長すぎる', { work_date: d1, start_time: '11:00', end_time: '18:00', memo: 'あ'.repeat(501) }],
]
for (const [name, body] of bad) {
  const r = await st1.post('/api/staff/shifts/request', body)
  ok(`検証: ${name}は 400`, r.status === 400, r)
}

// ---------- #59 他社・無関係の案件は指定できない ----------
const rx = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '12:00', end_time: '20:00', project_id: projB.project_id })
ok('#59 他社の案件を指定した希望は 400', rx.status === 400, rx)
const afterX = (await st1.get('/api/staff/shifts?month=' + month1)).data
ok('#59 他社の案件名が本人の画面に出ない', !JSON.stringify(afterX).includes(`B社の案件${tag}`))
ok('#59 選べる案件は自社の案件だけ', (afterX.request_projects || []).length > 0 && !afterX.request_projects.some(p => p.project_id === projB.project_id), afterX.request_projects)
const pj = afterX.request_projects[0]
const rp = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '12:00', end_time: '20:00', project_id: pj.project_id, memo: `SR-P${tag}` })
ok('#59 選べる案件なら案件つきで提出できる', rp.status === 200, rp)
const reqP = (await st1.get('/api/staff/shifts?month=' + month1)).data.requests.find(r => r.request_id === rp.data.request_id)
ok('#59 案件名が付いて返る', reqP && reqP.project_name === pj.project_name, reqP)
const allProjects = (await admin.get('/api/admin/projects')).data.projects
const unrelated = allProjects.find(p => !afterX.request_projects.some(x => x.project_id === p.project_id))
if (unrelated) {
  const ru = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '13:00', end_time: '20:00', project_id: unrelated.project_id })
  ok('#59 入ったことのない案件は指定できない（400）', ru.status === 400, ru)
}

// ---------- #353 取り下げ ----------
const c2 = await st2.post(`/api/staff/shift-requests/${r1.data.request_id}/cancel`)
ok('#353 他人の希望は取り下げられない（404）', c2.status === 404, c2)
const c1 = await st1.post(`/api/staff/shift-requests/${r1.data.request_id}/cancel`)
ok('#353 本人は返事待ちの希望を取り下げられる', c1.status === 200, c1)
const c1b = await st1.post(`/api/staff/shift-requests/${r1.data.request_id}/cancel`)
ok('#353 二度目の取り下げは 409', c1b.status === 409, c1b)
list = (await st1.get('/api/staff/shifts?month=' + month1)).data
ok('#353 取り下げた希望は本人の画面に出ない', !list.requests.some(r => r.request_id === r1.data.request_id))
const again = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '10:00', end_time: '18:00', memo: `SR-A2${tag}` })
ok('#353 取り下げた後は同じ日時で出し直せる', again.status === 200, again)
const admAll = (await admin.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}&status=all`)).data.requests
ok('#353 管理者の一覧（すべて）では取り下げも見える', admAll.some(r => r.request_id === r1.data.request_id && r.status === 'withdrawn'), admAll.map(r => [r.request_id, r.status]))

// ---------- #353 管理者の採否の返事 ----------
const respB = await adminB.post(`/api/admin/shift-requests/${rp.data.request_id}/respond`, { decision: 'decline' })
ok('#353 他社の管理者は返事できない（404）', respB.status === 404, respB)
const listB = (await adminB.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}&status=all`)).data.requests
ok('#353 他社の管理者の一覧には出ない', !listB.some(r => r.request_id === rp.data.request_id), listB)
const badDec = await admin.post(`/api/admin/shift-requests/${rp.data.request_id}/respond`, { decision: 'maybe' })
ok('#353 返事の種類は採用・見送りだけ（400）', badDec.status === 400, badDec)
const dec = await admin.post(`/api/admin/shift-requests/${rp.data.request_id}/respond`, { decision: 'decline', note: 'この日は人数が足りています' })
ok('#353 見送りにできる', dec.status === 200 && dec.data.status === 'declined', dec)
const dec2 = await admin.post(`/api/admin/shift-requests/${rp.data.request_id}/respond`, { decision: 'accept' })
ok('#353 返事済みの希望にもう一度返事はできない（409）', dec2.status === 409, dec2)
const seenP = (await st1.get('/api/staff/shifts?month=' + month1)).data.requests.find(r => r.request_id === rp.data.request_id)
ok('#353 本人の画面に『見送り』と返事の内容が出る', seenP && seenP.status === 'declined' && seenP.response_note === 'この日は人数が足りています', seenP)
const cDeclined = await st1.post(`/api/staff/shift-requests/${rp.data.request_id}/cancel`)
ok('#353 返事済みの希望は取り下げできない（409）', cDeclined.status === 409, cDeclined)
const acc = await admin.post(`/api/admin/shift-requests/${again.data.request_id}/respond`, { decision: 'accept' })
ok('#353 採用にできる', acc.status === 200 && acc.data.status === 'accepted', acc)
const seenA = (await st1.get('/api/staff/shifts?month=' + month1)).data.requests.find(r => r.request_id === again.data.request_id)
ok('#353 本人の画面に『採用』と出る', seenA && seenA.status === 'accepted', seenA)

// ---------- #411 管理者の『希望（仮）』と本人の返事 ----------
const d2 = addDays(today, 6)
const memo = `SR-T${tag}`
const cs = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 1, work_date: d2, start_time: '09:30', end_time: '18:30', status: 'requested', memo })
ok('（前提）管理者が希望（仮）のシフトを登録', cs.status === 200, cs)
const tent = (await admin.get(`/api/admin/shifts?from=${d2}&to=${d2}`)).data.shifts.find(s => s.memo === memo)
const mine = (await st1.get('/api/staff/shifts?month=' + d2.slice(0, 7))).data.shifts.find(s => s.shift_id === tent.shift_id)
ok('#411 本人のシフト一覧で、管理者の仮押さえは自分の希望と分けて返る（tentative）', mine && mine.status === 'requested' && mine.tentative === true, mine)
const rBad = await st1.post(`/api/staff/shifts/${tent.shift_id}/reply`, { answer: 'maybe' })
ok('#411 返事は ok / ng だけ（400）', rBad.status === 400, rBad)
const rOther = await st2.post(`/api/staff/shifts/${tent.shift_id}/reply`, { answer: 'ok' })
ok('#411 他人のシフトには返事できない（404）', rOther.status === 404, rOther)
const rNg = await st1.post(`/api/staff/shifts/${tent.shift_id}/reply`, { answer: 'ng', note: '別の予定があります' })
ok('#411 本人は『入れません』と返事できる', rNg.status === 200, rNg)
const board = (await admin.get(`/api/admin/shift-board?from=${d2}&to=${d2}`)).data
const chip = [...board.unslotted, ...board.slots.flatMap(s => s.roles.flatMap(r => r.assigned))].find(a => a.shift_id === tent.shift_id)
ok('#411 シフトボードに本人の返事が出る', chip && chip.staff_reply === 'ng' && chip.staff_reply_note === '別の予定があります', chip)
const rOk = await st1.post(`/api/staff/shifts/${tent.shift_id}/reply`, { answer: 'ok' })
const mine2 = (await st1.get('/api/staff/shifts?month=' + d2.slice(0, 7))).data.shifts.find(s => s.shift_id === tent.shift_id)
ok('#411 返事は変えられる（入れます）', rOk.status === 200 && mine2.staff_reply === 'ok' && !mine2.staff_reply_note, mine2)
await admin.put(`/api/admin/shifts/${tent.shift_id}`, { status: 'confirmed' })
const rConf = await st1.post(`/api/staff/shifts/${tent.shift_id}/reply`, { answer: 'ng' })
ok('#411 確定したシフトには返事できない（409）', rConf.status === 409, rConf)

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
