// シフトの一括処理（w2-shift-bulk: #15 #33 #78 #493 #527）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8816 PERSIST=<保存先> node scripts/test-w2-shift-bulk.mjs
//   PERSIST を渡すと、API では設定できない NG スタッフと、実績の反映前の状態をローカルの D1 に直接書いて確かめる（--local のみ。本番には接続しない）
// 1回の処理件数の上限は limit で小さくして、続きから実行（next_cursor）を確かめる
import { execSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:8816'
const PERSIST = process.env.PERSIST || ''
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
    const req = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // D1 を直接書き換えている間に切れた接続を使い回すと ECONNRESET になる（サーバーには届いていない）ので、1回だけやり直す
    const r = await req().catch(e => { if (e?.cause?.code === 'ECONNRESET') return req(); throw e })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sql = (command) => execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --command "${command}"`, { stdio: 'pipe' })
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

// 続きがあれば next_cursor で呼び続け、件数を合計する（画面の runJob と同じ）
async function runAll(api, path, body, keys) {
  const sum = Object.fromEntries(keys.map(k => [k, 0])); const skipped = []; let cursor = null, calls = 0, last = null
  do {
    const r = await api.post(path, { ...body, ...(cursor != null ? { cursor } : {}) })
    if (r.status !== 200) return { error: r, sum, skipped, calls }
    last = r.data; calls++
    for (const k of keys) sum[k] += Number(r.data[k] || 0)
    if (Array.isArray(r.data.skipped)) skipped.push(...r.data.skipped)
    cursor = r.data.next_cursor ?? null
  } while (cursor != null && calls < 100)
  return { sum, skipped, calls, last }
}

const PFX = 'SB' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
// 4週先の月曜日から（今日を含まないように）
let W = addDays(today, 28); while (weekday(W) !== 1) W = addDays(W, 1)

// ---------- 準備 ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX}-CA` }), 'client A')
must(await admin.post('/api/admin/clients', { client_name: `${PFX}-CB` }), 'client B')
const clients = must(await admin.get('/api/admin/clients'), 'clients').clients
const CA = clients.find(c => c.client_name === `${PFX}-CA`).client_id, CB = clients.find(c => c.client_name === `${PFX}-CB`).client_id
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-PA`, client_id: CA }), 'project A')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-PB`, client_id: CB }), 'project B')
const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
const PA = projects.find(p => p.project_name === `${PFX}-PA`).project_id, PB = projects.find(p => p.project_name === `${PFX}-PB`).project_id
for (let i = 0; i < 4; i++) must(await admin.post('/api/admin/staff', { user_code: `${PFX}S${i}`, name: `${PFX} スタッフ${i}`, password: 'pass1234' }), 'staff')
const S = (must(await admin.get('/api/admin/staff'), 'staff list').staff).filter(s => String(s.user_code).startsWith(PFX)).sort((a, b) => a.staff_id - b.staff_id).map(s => s.staff_id)
ok('準備: クライアント2社・案件2件・スタッフ4人', CA && CB && PA && PB && S.length === 4, { CA, CB, PA, PB, S })

// コピー元の枠（PA と PB、W の月曜 13:00〜17:00）と割り当て（PA に S0・S3、PB に S1）
must(await admin.post('/api/admin/shift-slots', { project_id: PA, dates: [W], start_time: '13:00', end_time: '17:00', roles: [{ role_name: '販売', headcount: 3 }] }), 'slot A')
must(await admin.post('/api/admin/shift-slots', { project_id: PB, dates: [W], start_time: '13:00', end_time: '17:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'slot B')
let board = must(await admin.get(`/api/admin/shift-board?from=${W}&to=${addDays(W, 6)}`), 'board')
const slotA = board.slots.find(s => s.project_id === PA), slotB = board.slots.find(s => s.project_id === PB)
must(await admin.post(`/api/admin/shift-slots/roles/${slotA.roles[0].slot_role_id}/assign`, { staff_ids: [S[0], S[3]], force: true }), 'assign A')
must(await admin.post(`/api/admin/shift-slots/roles/${slotB.roles[0].slot_role_id}/assign`, { staff_ids: [S[1]], force: true }), 'assign B')

// S3 を退職（昨日の退職日）、S2 を CA の NG にする
const ret = await admin.put(`/api/admin/employees/${S[3]}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } })
ok('準備: S3 を退職にする', ret.status === 200, ret)
if (PERSIST) sql(`UPDATE clients SET ng_staff_ids = '${S[2]}' WHERE client_id = ${CA}`)
else console.log('SKIP  NG の確認（PERSIST が無いため）')

// ---------- #15 #33 常勤の一括登録 ----------
const bulkBody = { project_id: PA, staff_ids: S, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: W, date_to: addDays(W, 13), start_time: '09:00', end_time: '12:00', limit: 10 }
let r = await runAll(admin, '/api/admin/shifts/bulk', bulkBody, ['created'])
const expected = PERSIST ? 28 : 42
ok('#15 一括登録: 上限を超えた分は next_cursor で続きから実行し、最後まで登録する', !r.error && r.calls === 6 && r.sum.created === expected, { calls: r.calls, sum: r.sum, error: r.error })
const reasons = {}; for (const s of r.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1
ok('#33 一括登録: 退職者はスキップし、理由・名前を返す', reasons['退職'] === 14 && r.skipped.filter(s => s.reason === '退職').every(s => s.staff_id === S[3] && s.staff_name.includes('スタッフ3') && s.date), reasons)
if (PERSIST) ok('#33 一括登録: NG のスタッフはスキップする', reasons['NG'] === 14 && r.skipped.filter(s => s.reason === 'NG').every(s => s.staff_id === S[2]), reasons)
r = await runAll(admin, '/api/admin/shifts/bulk', { ...bulkBody, limit: 1000 }, ['created'])
ok('#15 一括登録: もう一度実行しても二重に登録しない（重複としてスキップ）', !r.error && r.sum.created === 0 && r.skipped.filter(s => s.reason === '重複').length === (PERSIST ? 28 : 42), { sum: r.sum, n: r.skipped.length })

// ---------- #15 単価ルールの再適用 ----------
must(await admin.put(`/api/admin/projects/${PA}/pricing`, { unit_price_type: 'daily', unit_price: 12345, pay_unit_type: 'daily', pay_rate: 9000 }), 'pricing')
const rpBody = { from: W, to: addDays(W, 13), project_id: PA }
const dry = must(await admin.post('/api/admin/shifts/reprice', { ...rpBody, dry_run: true }), 'reprice dry')
r = await runAll(admin, '/api/admin/shifts/reprice', { ...rpBody, limit: 7 }, ['count', 'updated'])
ok('#15 再適用: 上限を超えた分は next_cursor で続きから処理し、件数が確認の件数と一致する', !r.error && r.calls > 1 && r.sum.count === dry.count && r.sum.updated === dry.count, { dry, sum: r.sum, calls: r.calls })
let st = must(await admin.get(`/api/admin/settlement?from=${W}&to=${addDays(W, 13)}&project_id=${PA}`), 'settlement')
ok('#15 再適用: 対象のシフトがすべて新しい単価になる', st.rows.length === dry.count && st.rows.every(x => x.bill_base === 12345 && x.pay_base === 9000), st.rows.slice(0, 2).map(x => [x.bill_base, x.pay_base]))

// ---------- #527 コピー: 重なり・曜日のずれ ----------
const T = addDays(W, 14)
const base = { source_from: W, days: 7, client_id: CA, include_assignments: true }
let c = await admin.post('/api/admin/shifts/copy-week', { ...base, target_from: addDays(W, 3) })
ok('#527 コピー: コピー元とコピー先の期間が重なる指定は 400', c.status === 400, c)
c = await admin.post('/api/admin/shifts/copy-week', { ...base, target_from: addDays(T, 1) })
ok('#527 コピー: 曜日がずれる指定は確認を求める（409 need_force）', c.status === 409 && c.data.need_force && c.data.weekday_shift === 1, c)

// ---------- #493 #33 コピー: 絞り込みどおりの案件だけ・退職者のスキップ ----------
c = must(await admin.post('/api/admin/shifts/copy-week', { ...base, target_from: T, dry_run: true }), 'copy dry')
// PA の枠1件、枠の割り当て S0（S3 は退職）、枠なしの一括登録 7日 × (S0, S1[, S2])
const plain = PERSIST ? 14 : 21
ok('#493 コピーの確認: 対象はクライアント A の案件だけ', c.projects.length === 1 && c.projects[0].project_id === PA, c.projects)
ok('#493 コピーの確認: 作成する枠・シフトの件数', c.slots === 1 && c.shifts === 1 + plain, { slots: c.slots, shifts: c.shifts, skipped: c.skipped })
const s3skip = c.skipped.find(x => x.staff_id === S[3])
ok('#33 コピー: 退職者はスキップし、理由とコピー先の役割を返す', s3skip && s3skip.reason === '退職' && s3skip.date === T, c.skipped)
r = await runAll(admin, '/api/admin/shifts/copy-week', { ...base, target_from: T, limit: 5 }, ['slots', 'shifts', 'already'])
ok('#15 コピー: 上限を超えた分は next_cursor で続きから実行し、確認と同じ件数を作る', !r.error && r.calls > 1 && r.sum.slots === 1 && r.sum.shifts === 1 + plain, { sum: r.sum, calls: r.calls, error: r.error })
board = must(await admin.get(`/api/admin/shift-board?from=${T}&to=${addDays(T, 6)}`), 'board T')
ok('#493 コピー: クライアント B の枠はコピーしない', !board.slots.some(s => s.project_id === PB) && board.slots.filter(s => s.project_id === PA).length === 1, board.slots.map(s => s.project_id))
const copiedSlot = board.slots.find(s => s.project_id === PA)
ok('#33 コピー: コピー先の枠には在籍者だけが入る', copiedSlot && copiedSlot.roles[0].assigned.map(a => a.staff_id).join() === String(S[0]), copiedSlot?.roles?.[0]?.assigned)

// ---------- #78 コピーのやり直し ----------
c = must(await admin.post('/api/admin/shifts/copy-week', { ...base, target_from: T, dry_run: true }), 'copy dry 2')
ok('#78 もう一度確認: 作るものは無く、コピー済みとして数える', c.slots === 0 && c.slots_reused === 1 && c.shifts === 0 && c.already === 1 + plain, { slots: c.slots, reused: c.slots_reused, shifts: c.shifts, already: c.already })
r = await runAll(admin, '/api/admin/shifts/copy-week', { ...base, target_from: T }, ['slots', 'shifts', 'already'])
board = must(await admin.get(`/api/admin/shift-board?from=${T}&to=${addDays(T, 6)}`), 'board T2')
ok('#78 もう一度コピーしても枠とシフトは二重にならない', !r.error && r.sum.slots === 0 && r.sum.shifts === 0 && board.slots.filter(s => s.project_id === PA).length === 1, { sum: r.sum })
// 区分の絞り込み: PA はスポットではないので、スポットだけのコピーでは何も作らない
c = must(await admin.post('/api/admin/shifts/copy-week', { source_from: W, days: 7, engagement: 'spot', project_ids: `${PA},${PB}`, target_from: addDays(T, 7), dry_run: true }), 'copy spot')
ok('#493 コピー: 区分（スポットのみ）の絞り込みも反映する', c.projects.length === 0 && c.slots === 0 && c.shifts === 0, c)
// 同じ内容の枠が2つあるとき、続きから実行しても、前の呼び出しで作ったコピーを使い回さずに2つ作る
for (let k = 0; k < 2; k++) must(await admin.post('/api/admin/shift-slots', { project_id: PA, dates: [addDays(W, 2)], start_time: '18:00', end_time: '20:00', roles: [{ role_name: '販売', headcount: 1 }] }), 'twin slot')
const U = addDays(W, 21)
r = await runAll(admin, '/api/admin/shifts/copy-week', { source_from: W, days: 7, client_id: CA, include_assignments: false, target_from: U, limit: 1 }, ['slots', 'slots_reused'])
board = must(await admin.get(`/api/admin/shift-board?from=${U}&to=${addDays(U, 6)}`), 'board U')
const twins = board.slots.filter(s => s.project_id === PA && s.work_date === addDays(U, 2) && s.start_time === '18:00')
ok('#78 コピー: 同じ内容の枠は、続きから実行しても別々にコピーする', !r.error && r.calls > 1 && r.sum.slots === 3 && r.sum.slots_reused === 0 && twins.length === 2, { sum: r.sum, calls: r.calls, twins: twins.length })

// ---------- #15 実績の反映 ----------
const P = addDays(today, -3)
must(await admin.post('/api/admin/shifts/bulk', { project_id: PB, staff_ids: [S[0]], weekdays: [weekday(P)], date_from: P, date_to: P, start_time: '10:00', end_time: '15:00' }), 'past shift')
st = must(await admin.get(`/api/admin/settlement?from=${P}&to=${P}&project_id=${PB}`), 'settlement past')
const ps = st.rows.find(x => x.staff_id === S[0])
const px = await admin.post(`/api/admin/shifts/${ps.shift_id}/proxy-attendance`, { report_types: ['check_in', 'check_out'], time: '' })
ok('準備: 過去のシフトに入店・退店を代理入力', px.status === 200, px)
if (PERSIST) sql(`UPDATE shifts SET actual_start = NULL, actual_end = NULL, actual_source = NULL WHERE shift_id = ${ps.shift_id}`)
const sy = await admin.post('/api/admin/settlement/sync-actuals', { from: P, to: P, project_id: PB })
st = must(await admin.get(`/api/admin/settlement?from=${P}&to=${P}&project_id=${PB}`), 'settlement past 2')
const ps2 = st.rows.find(x => x.shift_id === ps.shift_id)
ok('#15 実績の反映: まとめて読み書きして、報告の時刻を実績にする', sy.status === 200 && sy.data.checked >= 1 && (!PERSIST || sy.data.updated === 1) && ps2.actual_start === '10:00' && ps2.actual_end === '15:00' && ps2.actual_source === 'report', { sy: sy.data, ps2: ps2 && [ps2.actual_start, ps2.actual_end, ps2.actual_source] })
const sy2 = await admin.post('/api/admin/settlement/sync-actuals', { from: P, to: P, project_id: PB })
ok('#15 実績の反映: 変わらないシフトは更新しない', sy2.status === 200 && sy2.data.updated === 0 && sy2.data.next_cursor === null, sy2.data)
const sy3 = await admin.post('/api/admin/settlement/sync-actuals', { from: P, to: P, project_id: PB, cursor: ps.shift_id })
ok('#15 実績の反映: cursor より後だけを確認する', sy3.status === 200 && sy3.data.checked === 0, sy3.data)

const failed = results.filter(x => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
