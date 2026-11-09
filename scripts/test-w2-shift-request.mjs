// シフト希望の表示・採否の返事と、管理者の『希望（仮）』への本人の返事の統合テスト（w2-shift-request: #12 #59 #353 #411）
// シフト希望の提出・取り下げは D-23 で止めた（Sprint 20 の #9927。POST は 410）。以前に出された希望は、ローカルの D1 に直接入れて確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
//   本部（hq）で 2 社目を作り、その会社の案件名が本人の画面に出ないこと・その会社の管理者が返事できないことも確かめる。
// 実行: BASE=http://127.0.0.1:8799 PERSIST=<保存先> node scripts/test-w2-shift-request.mjs（PERSIST が無ければ、以前の希望の確認は SKIP）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
let sqlSeq = 0, SQL_DIR = ''
function sql(command) {
  SQL_DIR = SQL_DIR || mkdtempSync(join(tmpdir(), 'w2sr-'))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
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
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // ローカルの D1 を直接書き換えた直後は、待ち受け側が閉じた接続を使い回して ECONNRESET になることがあるため、通信の失敗は1回だけやり直す
    const r = await send().catch(() => send())
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

// ---------- #9927 シフト希望の提出・取り下げは受け付けない（D-23） ----------
const d1 = addDays(today, 5)
const month1 = d1.slice(0, 7)
const r1 = await st1.post('/api/staff/shifts/request', { work_date: d1, start_time: '10:00', end_time: '18:00', memo: `SR-N${tag}` })
ok('#9927 シフト希望の提出は 410「シフト希望の受け付けは終了しました」', r1.status === 410 && r1.data && r1.data.error === 'シフト希望の受け付けは終了しました', r1)
const r1b = await st1.post('/api/staff/shifts/request', { work_date: addDays(today, -1), start_time: '25:00', end_time: '18:00' })
ok('#9927 入力が正しくなくても 410（入力の確かめより先に止める）', r1b.status === 410, r1b)
const c0 = await st1.post('/api/staff/shift-requests/1/cancel')
ok('#9927 シフト希望の取り下げも 410', c0.status === 410 && c0.data && c0.data.error === 'シフト希望の受け付けは終了しました', c0)
let list = (await st1.get('/api/staff/shifts?month=' + month1)).data
ok('#9927 スタッフのシフトの API は、希望で選べる案件（request_projects）を返さない', list && !('request_projects' in list) && Array.isArray(list.requests), list && Object.keys(list))
ok('#9927 提出しようとした希望は保存されていない', !list.requests.some(r => r.memo === `SR-N${tag}`), list.requests)

// ---------- 以前に出されたシフト希望の表示と、返事待ちの希望への管理者の返事 ----------
if (PERSIST) {
  // 以前のデータ: 返事待ち（案件なし）・取り下げ・返事待ち（自社の案件）・返事待ち（他社の案件を指した行）・返事待ち（採用にする）
  const ins = (memo, start, end, status, project = null) => `INSERT INTO shift_requests (company_id, staff_id, user_id, project_id, work_date, start_time, end_time, memo, status, created_at, withdrawn_at)
    SELECT company_id, staff_id, user_id, ${project == null ? 'NULL' : Number(project)}, '${d1}', '${start}', '${end}', '${memo}', '${status}', datetime('now', '+9 hours'), ${status === 'withdrawn' ? "datetime('now', '+9 hours')" : 'NULL'}
    FROM staff_profiles WHERE staff_id = 1;`
  sql([ins(`SR-A${tag}`, '10:00', '18:00', 'pending'), ins(`SR-W${tag}`, '10:00', '18:00', 'withdrawn'), ins(`SR-P${tag}`, '12:00', '20:00', 'pending', 1),
    ins(`SR-X${tag}`, '13:00', '20:00', 'pending', projB.project_id), ins(`SR-C${tag}`, '14:00', '20:00', 'pending')].join('\n'))
  const byMemo = (rows, m) => (rows || []).find(r => r.memo === m)
  list = (await st1.get('/api/staff/shifts?month=' + month1)).data
  const reqA = byMemo(list.requests, `SR-A${tag}`)
  ok('#12 以前に出した希望が本人のシフト画面に出る（案件の指定なし）', reqA && reqA.status === 'pending' && reqA.project_name == null, list.requests)
  ok('#12 希望は shifts に入らない（シフト一覧に出ない）', !list.shifts.some(s => s.memo === `SR-A${tag}`), list.shifts.filter(s => s.memo))
  ok('#353 取り下げた希望は本人の画面に出ない', !byMemo(list.requests, `SR-W${tag}`), list.requests)
  const reqP = byMemo(list.requests, `SR-P${tag}`)
  ok('#59 自社の案件を指した希望は案件名が付いて返る', reqP && !!reqP.project_name, reqP)
  ok('#59 他社の案件名が本人の画面に出ない', !JSON.stringify(list).includes(`B社の案件${tag}`) && byMemo(list.requests, `SR-X${tag}`)?.project_name == null, byMemo(list.requests, `SR-X${tag}`))
  const adm = (await admin.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}`)).data
  ok('#12 管理者の希望一覧に出る（スタッフ名つき・返事待ち件数）', byMemo(adm.requests, `SR-A${tag}`)?.staff_name && adm.pending >= 4 && !byMemo(adm.requests, `SR-W${tag}`), adm)
  const admAll = (await admin.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}&status=all`)).data.requests
  ok('#353 管理者の一覧（すべて）では取り下げも見える', byMemo(admAll, `SR-W${tag}`)?.status === 'withdrawn', admAll.map(r => [r.request_id, r.status]))
  const idOf = (m) => byMemo(admAll, m).request_id
  const pId = idOf(`SR-P${tag}`), cId = idOf(`SR-C${tag}`), wId = idOf(`SR-W${tag}`)

  // ---------- #353 管理者の採否の返事（返事待ちの希望だけ） ----------
  const respB = await adminB.post(`/api/admin/shift-requests/${pId}/respond`, { decision: 'decline' })
  ok('#353 他社の管理者は返事できない（404）', respB.status === 404, respB)
  const listB = (await adminB.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}&status=all`)).data.requests
  ok('#353 他社の管理者の一覧には出ない', !listB.some(r => r.request_id === pId), listB)
  const badDec = await admin.post(`/api/admin/shift-requests/${pId}/respond`, { decision: 'maybe' })
  ok('#353 返事の種類は採用・見送りだけ（400）', badDec.status === 400, badDec)
  const dec = await admin.post(`/api/admin/shift-requests/${pId}/respond`, { decision: 'decline', note: 'この日は人数が足りています' })
  ok('#353 見送りにできる', dec.status === 200 && dec.data.status === 'declined', dec)
  const dec2 = await admin.post(`/api/admin/shift-requests/${pId}/respond`, { decision: 'accept' })
  ok('#353 返事済みの希望にもう一度返事はできない（409）', dec2.status === 409, dec2)
  const wDec = await admin.post(`/api/admin/shift-requests/${wId}/respond`, { decision: 'accept' })
  ok('#353 本人が取り下げた希望には返事できない（409）', wDec.status === 409, wDec)
  const seenP = byMemo((await st1.get('/api/staff/shifts?month=' + month1)).data.requests, `SR-P${tag}`)
  ok('#353 本人の画面に『見送り』と返事の内容が出る', seenP && seenP.status === 'declined' && seenP.response_note === 'この日は人数が足りています', seenP)
  const cDeclined = await st1.post(`/api/staff/shift-requests/${pId}/cancel`)
  ok('#9927 本人の取り下げは 410（返事の後も）', cDeclined.status === 410, cDeclined)
  const acc = await admin.post(`/api/admin/shift-requests/${cId}/respond`, { decision: 'accept' })
  ok('#353 採用にできる', acc.status === 200 && acc.data.status === 'accepted', acc)
  const seenA = byMemo((await st1.get('/api/staff/shifts?month=' + month1)).data.requests, `SR-C${tag}`)
  ok('#353 本人の画面に『採用』と出る', seenA && seenA.status === 'accepted', seenA)
} else console.log('SKIP  以前に出されたシフト希望の表示と返事（PERSIST 未指定）')

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
