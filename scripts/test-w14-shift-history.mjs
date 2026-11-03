// 持ち越しの棚卸し（Sprint 14）w14-shift-history の統合テスト
//   #65  繰り返し登録の削除の確認に、消える枠への未対応の応募の件数（GET /slot-patterns の future_pending_applications）
//   #456 繰り返し登録の編集で必要人数を、割り当て済みの確定・代打より少なくするときは確認（need_force・headcount_warnings）
//   #159 シフトの変更履歴: 報告から実績を反映（1回の操作として残す）・交通費／延長の申請の承認・スタッフの統合
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w14-shift-history.mjs
//   PERSIST（ローカルの D1 の保存先）があれば、実績を消してから「報告から実績を反映」を確かめる（無ければその項目は飛ばす）
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
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
    const headers = { Cookie: cookie || '' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const opts = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
    // wrangler d1 execute（sql）の間に閉じられた接続を使ったときは、1回だけ送り直す（送る前に切れているので二重にはならない）
    const r = await fetch(`${BASE}${path}`, opts).catch(e => { if (e && e.cause && e.cause.code === 'ECONNRESET') return fetch(`${BASE}${path}`, opts); throw e })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const sql = (command) => JSON.parse(execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --json --command "${command.replace(/\s*\n\s*/g, ' ').replace(/"/g, '\\"')}"`, { stdio: 'pipe' }).toString())[0].results
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const PFX = 'W14H' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')

async function newProject(name, extra = {}) {
  return must(await admin.post('/api/admin/projects', { project_name: name, allow_duplicate: true, ...extra }), 'project ' + name).project_id
}
async function newStaff(k, extra = {}) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: phoneOf(), ...extra }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`).staff_id
}
async function newShift(staff_id, project_id, work_date, extra = {}) {
  const memo = `${PFX}-${++seq}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '15:00', memo, break_minutes: 0, ...extra })
  if (r.status !== 200) throw new Error('shift ' + r.text)
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
}
const patternSlots = async (pid, patternId, from, to) =>
  must(await admin.get(`/api/admin/shift-board?from=${from}&to=${to}&project_ids=${pid}`), 'board').slots.filter(s => s.pattern_id === patternId).sort((a, b) => a.work_date.localeCompare(b.work_date))
const opLogs = async (q) => must(await admin.get(`/api/admin/operation-logs?${q}`), 'operation-logs ' + q).logs

// ---------- #65 繰り返し登録の削除: 消える枠への未対応の応募の件数 ----------
{
  const P = await newProject(`${PFX}-応募`)
  const from = addDays(today, 30), to = addDays(from, 2)
  const pt = must(await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: to, start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'pattern')
  const slots = await patternSlots(P, pt.pattern_id, from, to)
  ok('（前提）繰り返し登録で枠を3件作った', slots.length === 3, slots.length)
  const roleOf = (s) => s.roles.find(r => r.role_name === '販売').slot_role_id
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [P], date_from: from, date_to: to, allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'recruit page')
  await newStaff('AP')
  const sp = client(await login('sample', `${PFX}AP`))
  must(await sp.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: slots.map(roleOf) }), 'staff apply')
  // 3日目の枠には人を割り当てる（割り当てのある枠は消さないので、その枠への応募は数えない）
  const SX = await newStaff('X')
  must(await admin.post(`/api/admin/shift-slots/roles/${roleOf(slots[2])}/assign`, { staff_ids: [SX], force: true }), 'assign day3')
  const list = must(await admin.get(`/api/admin/slot-patterns?project_id=${P}`), 'patterns').patterns
  const x = list.find(p => p.pattern_id === pt.pattern_id)
  ok('#65 一覧に、今日以降の割り当てのない枠への未対応の応募の件数を返す（割り当てのある枠の分は数えない）', x && x.future_pending_applications === 2, x && { f: x.future_pending_applications, slots: x.future_slot_count })
  const other = must(await admin.get('/api/admin/slot-patterns'), 'patterns all').patterns.filter(p => p.pattern_id !== pt.pattern_id)
  ok('#65 応募のない繰り返し登録は 0 件', other.every(p => typeof p.future_pending_applications === 'number'), other.slice(0, 2))
  const del = must(await admin.del(`/api/admin/slot-patterns/${pt.pattern_id}?remove_future=1&today=${today}`), 'delete pattern')
  ok('（前提）今日以降の割り当てのない枠（2件）を削除した', del.removed === 2, del)
  if (PERSIST) {
    const items = sql(`SELECT i.status FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
      WHERE a.page_id = ${Number(page.page_id)} ORDER BY i.item_id`)
    ok('#65 数えた件数（2件）が、削除で「枠の削除」になった応募の件数と一致する', items.filter(i => i.status === 'slot_removed').length === 2 && items.filter(i => i.status === 'pending').length === 1, items)
  } else console.log('SKIP  #65 削除後の応募の状態（PERSIST がないため）')
}

// ---------- #456 繰り返し登録の編集で必要人数を減らす ----------
{
  const P = await newProject(`${PFX}-人数`)
  const from = addDays(today, 40), to = addDays(from, 1)
  const pt = must(await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: to, start_time: '10:00', end_time: '18:00',
    roles: [{ role_name: '販売', headcount: 2 }, { role_name: 'MC', headcount: 1 }] }), 'pattern')
  const slots = await patternSlots(P, pt.pattern_id, from, to)
  const sale = slots[0].roles.find(r => r.role_name === '販売')
  const A = await newStaff('HA'), B = await newStaff('HB')
  must(await admin.post(`/api/admin/shift-slots/roles/${sale.slot_role_id}/assign`, { staff_ids: [A, B], force: true }), 'assign 2')
  const body = { roles: [{ orig_name: '販売', headcount: 1 }, { orig_name: 'MC', headcount: 1 }] }
  const dry = must(await admin.put(`/api/admin/slot-patterns/${pt.pattern_id}`, { ...body, dry_run: true }), 'dry')
  ok('#456 確認（dry_run）で、割り当て済みの確定・代打より少なくなる枠を知らせる（1日目だけ）', dry.headcount_warnings.length === 1 && dry.headcount_warnings[0].startsWith(from) && dry.headcount_warnings[0].includes('販売') && dry.headcount_warnings[0].includes('（2名）') && dry.warnings.length === 1, dry)
  const r1 = await admin.put(`/api/admin/slot-patterns/${pt.pattern_id}`, body)
  ok('#456 force なしで保存すると 409 need_force', r1.status === 409 && r1.data.need_force && r1.data.headcount_warnings.length === 1 && /必要人数/.test(r1.data.error), r1.data)
  const s1 = await patternSlots(P, pt.pattern_id, from, to)
  ok('#456 409 のときは人数を変えない', s1.every(s => s.roles.find(r => r.role_name === '販売').headcount === 2), s1.map(s => s.roles.map(r => r.role_name + r.headcount)))
  const r2 = await admin.put(`/api/admin/slot-patterns/${pt.pattern_id}`, { ...body, force: true })
  const s2 = await patternSlots(P, pt.pattern_id, from, to)
  ok('#456 force なら人数を変える（割り当ては外さない）', r2.status === 200 && s2.every(s => s.roles.find(r => r.role_name === '販売').headcount === 1)
    && s2[0].roles.find(r => r.role_name === '販売').assigned.length === 2, { r2: r2.data, roles: s2.map(s => s.roles.map(r => r.role_name + r.headcount)) })
  const up = await admin.put(`/api/admin/slot-patterns/${pt.pattern_id}`, { roles: [{ orig_name: '販売', headcount: 3 }] })
  ok('#456 人数を増やすときは確認しない', up.status === 200 && up.data.headcount_warnings.length === 0, up.data)
  // 減らしても、割り当て済みの人数以上なら確認しない
  const down = await admin.put(`/api/admin/slot-patterns/${pt.pattern_id}`, { roles: [{ orig_name: 'MC', headcount: 1 }, { orig_name: '販売', headcount: 2 }], dry_run: true })
  ok('#456 割り当てが必要人数以内なら確認しない（販売 3→2・割り当て 2名）', down.status === 200 && down.data.headcount_warnings.length === 0 && down.data.warnings.length === 0, down.data)
}

// ---------- #159 交通費・延長の申請の承認の変更履歴 ----------
{
  const P = await newProject(`${PFX}-申請`, { unit_price: 1500, unit_price_type: 'hourly' })
  must(await admin.put(`/api/admin/projects/${P}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'clipped', pay_transport_type: 'actual' }), 'pricing')
  const ST = await newStaff('PAY')
  const stc = client(await login('sample', `${PFX}PAY`))
  const D = addDays(today, -2)
  const s = await newShift(ST, P, D, { start_time: '06:00', end_time: '08:00' })
  let r = await stc.post('/api/staff/pay/requests', { shift_id: s.shift_id, kind: 'transport', amount: 640, route: '新宿〜渋谷' })
  ok('（前提）交通費を申請した', r.status === 200, r.data)
  must(await admin.post(`/api/admin/pay-requests/${r.data.request_id}/approve`, { amount: 600 }), 'approve transport')
  let logs = await opLogs(`entity=shift&entity_id=${s.shift_id}&action=transport_approve`)
  const tf = logs[0] && logs[0].changes.find(c => c.field === 'transportation_fee')
  ok('#159 交通費の申請の承認が、シフトの変更履歴に残る（交通費の実費の前後）', logs.length === 1 && logs[0].action_label === '交通費の申請の承認' && tf && Number(tf.before) === 0 && tf.after === 600 && logs[0].actor_name, logs)
  const again = await admin.post(`/api/admin/pay-requests/${r.data.request_id}/approve`, {})
  ok('#159 処理済みの申請をもう一度承認しても、履歴は増えない', again.status === 409 && (await opLogs(`entity=shift&entity_id=${s.shift_id}&action=transport_approve`)).length === 1, again.status)

  r = await stc.post('/api/staff/pay/requests', { shift_id: s.shift_id, kind: 'overtime', new_end_time: '08:30', instructed_by: '店長', reason: '閉店作業' })
  ok('（前提）延長を申請した', r.status === 200, r.data)
  must(await admin.post(`/api/admin/pay-requests/${r.data.request_id}/approve`, {}), 'approve overtime')
  logs = await opLogs(`entity=shift&entity_id=${s.shift_id}&action=overtime_approve`)
  const end = logs[0] && logs[0].changes.find(c => c.field === 'end_time')
  const qty = logs[0] && logs[0].changes.find(c => c.field === 'pay_qty' || c.field === 'pay_amount')
  ok('#159 延長の申請の承認が、シフトの変更履歴に残る（終了時刻と、計算し直した金額）', logs.length === 1 && logs[0].action_label === '延長の申請の承認' && end && end.before === '08:00' && end.after === '08:30' && !!qty, logs[0] && logs[0].changes)

  // 却下はシフトを変えないので履歴に残らない
  r = await stc.post('/api/staff/pay/requests', { shift_id: s.shift_id, kind: 'transport', amount: 100, route: 'バス' })
  must(await admin.post(`/api/admin/pay-requests/${r.data.request_id}/reject`, { note: '定期券の区間です' }), 'reject')
  ok('#159 却下は変更履歴に残さない（シフトが変わらないため）', (await opLogs(`entity=shift&entity_id=${s.shift_id}`)).filter(l => /approve|reject/.test(l.action)).length === 2)
}

// ---------- #159 スタッフの統合の変更履歴 ----------
{
  const P = await newProject(`${PFX}-統合`)
  const q = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 仮`, phone: phoneOf(), affiliation_type: 'daily_worker', force: true }), 'quick')
  const sh = await newShift(q.staff_id, P, addDays(today, 10))
  const T = await newStaff('MT')
  const dry = must(await admin.post(`/api/admin/staff/${q.staff_id}/merge`, { target_staff_id: T, dry_run: true }), 'merge dry')
  ok('#159 統合の確認（dry_run）では履歴を残さない', (await opLogs(`entity=shift&entity_id=${sh.shift_id}&action=staff_merge`)).length === 0, dry.counts)
  const mg = await admin.post(`/api/admin/staff/${q.staff_id}/merge`, { target_staff_id: T, force: true })
  ok('（前提）仮登録をシフトごと統合した', mg.status === 200 && mg.data.moved.shifts === 1, mg.data)
  const logs = await opLogs(`entity=shift&entity_id=${sh.shift_id}&action=staff_merge`)
  const ch = logs[0] && logs[0].changes.find(c => c.field === 'staff_id')
  ok('#159 統合でシフトの担当者を付け替えたことが、変更履歴に残る（前後のスタッフ）', logs.length === 1 && logs[0].action_label === 'スタッフの統合' && ch && ch.before === q.staff_id && ch.after === T, logs)
  ok('#159 統合の履歴は統合先のスタッフで絞り込める', (await opLogs(`staff_id=${T}&action=staff_merge`)).some(l => l.entity_id === sh.shift_id))
}

// ---------- #159 報告から実績を反映の変更履歴（まとめて1つの操作） ----------
if (PERSIST) {
  const P = await newProject(`${PFX}-実績`)
  const ST = await newStaff('ACT')
  const D = addDays(today, -4)
  const a = await newShift(ST, P, D, { start_time: '09:00', end_time: '12:00' })
  const b = await newShift(ST, P, D, { start_time: '13:00', end_time: '17:00' })
  for (const s of [a, b]) must(await admin.post(`/api/admin/shifts/${s.shift_id}/proxy-attendance`, { report_types: ['check_in', 'check_out'], time: '' }), 'proxy ' + s.shift_id)
  sql(`UPDATE shifts SET actual_start = NULL, actual_end = NULL, actual_source = NULL WHERE shift_id IN (${Number(a.shift_id)}, ${Number(b.shift_id)})`)
  const sy = must(await admin.post('/api/admin/settlement/sync-actuals', { from: D, to: D, project_id: P }), 'sync')
  ok('#159 実績の反映の件数は、履歴の行を数えない（2件）', sy.updated === 2 && sy.checked === 2, sy)
  const logs = (await opLogs(`staff_id=${ST}&action=sync_actuals`)).filter(l => [a.shift_id, b.shift_id].includes(l.entity_id))
  ok('#159 報告から実績を反映した2件が、1つの操作（同じ op_key）として変更履歴に残る', logs.length === 2 && logs[0].op_key === logs[1].op_key && logs.every(l => l.action_label === '報告から実績を反映'), logs.map(l => [l.entity_id, l.op_key]))
  const st = logs.find(l => l.entity_id === a.shift_id)?.changes.find(c => c.field === 'actual_start')
  ok('#159 実績の時刻の前後が残る', st && st.before === null && st.after === '09:00', st)
  const sy2 = must(await admin.post('/api/admin/settlement/sync-actuals', { from: D, to: D, project_id: P }), 'sync2')
  ok('#159 変わらないときは履歴を増やさない', sy2.updated === 0 && (await opLogs(`staff_id=${ST}&action=sync_actuals`)).length === 2, sy2)
} else console.log('SKIP  #159 報告から実績を反映（PERSIST がないため）')

// ---------- 画面（静的な確認） ----------
{
  const sb = readFileSync(new URL('../public/static/shift-board.js', import.meta.url), 'utf8')
  ok('#456 繰り返し登録の編集の確認に、必要人数の不足を時間の重なりと分けて出す', /d\.headcount_warnings/.test(sb) && /必要人数が、割り当て済みの確定・代打の人数より少なくなります/.test(sb))
  ok('#65 繰り返し登録の削除の確認: 未対応の応募が0件ならその旨を出す', /削除する枠への未対応の応募はありません/.test(sb) && /x\.future_pending_applications/.test(sb))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
