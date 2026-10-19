// 単価の解決と時間計算（w3-pricing: #80 #91 #144 #145 #196 #210 #218 #220 #469）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8813 node scripts/test-w3-pricing.mjs
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
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const admin = client(await login('sample', 'admin'))
const PFX = 'W3P' + Date.now().toString(36).slice(-4).toUpperCase()

// テスト用の案件（休憩0分・時給）を作る
async function newProject(tag, pricing = {}) {
  const r = await admin.post('/api/admin/projects', { project_name: `${PFX}-${tag}`, unit_price: 1000, unit_price_type: 'hourly', allow_duplicate: true })
  if (r.status !== 200) throw new Error('project ' + JSON.stringify(r.data))
  const pid = r.data.project_id
  const p = await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price_type: 'hourly', unit_price: 1000, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, ...pricing })
  if (p.status !== 200) throw new Error('pricing ' + JSON.stringify(p.data))
  return pid
}
async function createShift(project_id, staff_id, work_date, start_time, end_time, tag) {
  const memo = `${PFX}-${tag}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  return r.data.shift_id
}
const settleRow = async (id, date) => ((await admin.get(`/api/admin/settlement?from=${date}&to=${date}`)).data.rows || []).find(x => x.shift_id === id)
async function boardShift(id, date) {
  const b = (await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`)).data
  for (const s of b.slots || []) for (const r of s.roles) { const a = r.assigned.find(x => x.shift_id === id); if (a) return a }
  return (b.unslotted || []).find(x => x.shift_id === id)
}

// ---------- #218 負の値・範囲外の時刻 ----------
{
  const pid = await newProject('range')
  const r1 = await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price: -1500 })
  ok('#218 案件の標準単価にマイナスは 400', r1.status === 400, r1.data)
  const r2 = await admin.put(`/api/admin/projects/${pid}/pricing`, { default_break_minutes: -60 })
  ok('#218 案件の休憩にマイナスは 400', r2.status === 400, r2.data)
  const r3 = await admin.post('/api/admin/rate-rules', { project_id: pid, pay_rate: -100 })
  ok('#218 単価ルールのマイナスは 400', r3.status === 400, r3.data)
  const r4 = await admin.post('/api/admin/shift-slots', { project_id: pid, work_date: addDays(today, 3), start_time: '25:00', end_time: '26:00', roles: [{ role_name: '販売', headcount: 1 }] })
  ok('#218 24時を超える時刻の枠は 400', r4.status === 400, r4.data)
  const r5 = await admin.post('/api/admin/shift-slots', { project_id: pid, work_date: addDays(today, 3), start_time: '10:00', end_time: '19:00', roles: [{ role_name: '販売', headcount: 1, pay_rate: -1 }] })
  ok('#218 枠の役割のマイナスの単価は 400', r5.status === 400, r5.data)
  const r6 = await admin.post('/api/admin/shift-slots', { project_id: pid, work_date: addDays(today, 3), start_time: '10:00', end_time: '19:00', break_minutes: -30, roles: [{ role_name: '販売', headcount: 1 }] })
  ok('#218 枠の休憩のマイナスは 400', r6.status === 400, r6.data)
  const d = addDays(today, -20)
  const sid = await createShift(pid, 3, d, '10:00', '19:00', 'range')
  const r7 = await admin.put(`/api/admin/shifts/${sid}/price`, { break_minutes: -60 })
  ok('#218 シフトの金額の休憩のマイナスは 400', r7.status === 400, r7.data)
  const r8 = await admin.put(`/api/admin/shifts/${sid}/price`, { pay_qty: 30 })
  ok('#218 数量が24を超えると 400', r8.status === 400, r8.data)
  const r9 = await admin.put(`/api/admin/shifts/${sid}/price`, { pay_adjust: -500 })
  ok('#218 調整額のマイナス（控除）は受け付ける', r9.status === 200, r9.data)
  const r10 = await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '09:00', actual_end: '24:30' })
  ok('#218 実績の 24:30 は 400', r10.status === 400, r10.data)
  const r11 = await admin.post('/api/admin/projects', { project_name: `${PFX}-neg`, unit_price: -100, allow_duplicate: true })
  ok('#218 案件登録のマイナスの単価は 400', r11.status === 400, r11.data)
}

// ---------- #91 案件登録で時給を選べる ----------
{
  const r = await admin.post('/api/admin/projects', { project_name: `${PFX}-hourly`, unit_price: 1500, unit_price_type: 'hourly', allow_duplicate: true })
  const p = (await admin.get(`/api/admin/projects/${r.data.project_id}`)).data.project
  ok('#91 案件登録で請求の単位（時給）を保存する', p.unit_price_type === 'hourly' && p.unit_price === 1500, p)
}

// ---------- #80 0時台に始まる予定で、前日の23時台に入店 ----------
{
  const pid = await newProject('midnight')
  const d = addDays(today, -15)
  const sid = await createShift(pid, 4, d, '00:00', '05:00', 'mid')
  await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '23:50', actual_end: '05:00' })
  const row = await settleRow(sid, d)
  ok('#80 予定 00:00-05:00・実績 23:50-05:00 の計算時間は5時間（予定の範囲内）', row && row.hours === 5 && row.bill_base === 5000 && row.pay_base === 6000, row && [row.hours, row.bill_base, row.pay_base])
  ok('#80 実働は 5h10m', row && Math.abs(row.actual_hours - 5.17) < 0.01, row && row.actual_hours)
  // 日をまたぐ予定（22:00-06:00）で0時を過ぎてから入店した場合は翌日とみなす（従来どおり）
  const sid2 = await createShift(pid, 5, d, '22:00', '06:00', 'night')
  await admin.put(`/api/admin/shifts/${sid2}/actual`, { actual_start: '00:30', actual_end: '06:00' })
  const row2 = await settleRow(sid2, d)
  ok('#80 予定 22:00-06:00・実績 00:30-06:00 は5.5時間', row2 && row2.hours === 5.5, row2 && row2.hours)
}

// ---------- #220 支払側の丸め ----------
{
  const pid = await newProject('round', { time_round_minutes: 15 })
  const d = addDays(today, -14)
  const sid = await createShift(pid, 3, d, '09:00', '18:00', 'round')
  await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '09:07', actual_end: '18:07' })
  const row = await settleRow(sid, d)
  ok('#220 新しい案件の既定は「支払は丸めない」: 請求 8.75h・支払 8.88h', row && row.hours === 8.75 && row.pay_hours === 8.88, row && [row.hours, row.pay_hours])
  ok('#220 請求は丸めた時間、支払は1分単位で計算する', row && row.bill_base === 8750 && row.pay_base === Math.round(1200 * 533 / 60) && row.pay_qty === 8.88, row && [row.bill_base, row.pay_base, row.pay_qty])
  await admin.put(`/api/admin/projects/${pid}/pricing`, { pay_time_round: 'same' })
  await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '09:07', actual_end: '18:08' })
  const row2 = await settleRow(sid, d)
  ok('#220 「支払も同じく丸める」を選ぶと支払も 8.75h', row2 && row2.pay_hours === 8.75 && row2.pay_base === 10500, row2 && [row2.pay_hours, row2.pay_base])
}

// ---------- #196 交通費・調整だけの変更では数量を固定しない ----------
{
  const pid = await newProject('qty')
  const d = addDays(today, -13)
  const sid = await createShift(pid, 4, d, '10:00', '18:00', 'qty')
  const r1 = await admin.put(`/api/admin/shifts/${sid}/price`, { transportation_fee: 800, bill_adjust: 100 })
  ok('#196 交通費・調整だけの変更は手動変更にしない', r1.status === 200 && r1.data.price_locked === false && r1.data.qty_locked === false, r1.data)
  await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '10:00', actual_end: '16:00' })
  let row = await settleRow(sid, d)
  ok('#196 その後の実績（6h）で時給の数量が変わる', row && row.pay_qty === 6 && row.pay_base === 7200 && row.transportation_fee === 800, row && [row.pay_qty, row.pay_base])
  // 単価だけを変えた（数量は空欄）: 単価は固定、数量は実働に合わせる
  const r2 = await admin.put(`/api/admin/shifts/${sid}/price`, { pay_unit_type: 'hourly', pay_rate: 1500, pay_qty: '' })
  ok('#196 単価を変えると手動変更（数量は固定しない）', r2.data.price_locked === true && r2.data.qty_locked === false, r2.data)
  await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '10:00', actual_end: '17:00' })
  row = await settleRow(sid, d)
  ok('#196 単価だけ固定したシフトは、実績（7h）に数量を合わせる', row && row.pay_rate === 1500 && row.pay_qty === 7 && row.pay_base === 10500 && row.qty_locked === false, row && [row.pay_rate, row.pay_qty, row.pay_base, row.qty_locked])
  ok('#196 数量を合わせたシフトは「手動変更（数量が実働と違う）」にならない', row && !row.issues.some(x => x.includes('数量が実働と違う')), row && row.issues)
  // 数量を入れると固定
  const r3 = await admin.put(`/api/admin/shifts/${sid}/price`, { pay_qty: 8 })
  ok('#196 計算と違う数量を入れると数量も固定', r3.data.qty_locked === true, r3.data)
  await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '10:00', actual_end: '15:00' })
  row = await settleRow(sid, d)
  ok('#196 数量を固定したシフトは実績が変わっても数量を変えず、確認事項に出す', row && row.pay_qty === 8 && row.qty_locked === true && row.issues.some(x => x.includes('数量が実働と違う')), row && [row.pay_qty, row.issues])
}

// ---------- #210 単価ルール・標準単価の適用期間 ----------
{
  const pid = await newProject('period')
  const dOld = addDays(today, -12), dNew = addDays(today, -5), change = addDays(today, -8)
  const a = await admin.post('/api/admin/rate-rules', { project_id: pid, pay_unit_type: 'hourly', pay_rate: 1300, valid_to: addDays(change, -1) })
  const b = await admin.post('/api/admin/rate-rules', { project_id: pid, pay_unit_type: 'hourly', pay_rate: 1400, valid_from: change })
  ok('#210 適用期間付きの単価ルールを登録できる', a.status === 200 && b.status === 200, [a.data, b.data])
  const bad = await admin.post('/api/admin/rate-rules', { project_id: pid, pay_rate: 1, valid_from: change, valid_to: addDays(change, -3) })
  ok('#210 開始日が終了日より後なら 400', bad.status === 400, bad.data)
  const s1 = await createShift(pid, 3, dOld, '10:00', '18:00', 'p-old')
  const s2 = await createShift(pid, 3, dNew, '10:00', '18:00', 'p-new')
  const r1 = await settleRow(s1, dOld), r2 = await settleRow(s2, dNew)
  ok('#210 稼働日に有効な単価ルールを使う（改定前 1300・改定後 1400）', r1 && r2 && r1.pay_rate === 1300 && r2.pay_rate === 1400, [r1 && r1.pay_rate, r2 && r2.pay_rate])
  // 案件の標準単価を適用開始日付きで改定
  const p1 = await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price_type: 'hourly', unit_price: 2000, price_valid_from: change })
  ok('#210 標準単価を適用開始日付きで変更できる', p1.status === 200 && p1.data.price_valid_from === change && p1.data.price_changed === true, p1.data)
  const h = await admin.get(`/api/admin/projects/${pid}/price-history`)
  ok('#210 改定前の標準単価を履歴に残す', h.data.price_valid_from === change && h.data.history.length === 1 && h.data.history[0].unit_price === 1000 && h.data.history[0].valid_to === addDays(change, -1), h.data)
  const rp = await admin.post('/api/admin/shifts/reprice', { from: dOld, to: dNew, project_id: pid })
  const q1 = await settleRow(s1, dOld), q2 = await settleRow(s2, dNew)
  ok('#210 再適用しても、改定前の稼働日は改定前の標準単価のまま', rp.status === 200 && q1.bill_rate === 1000 && q2.bill_rate === 2000, [rp.data, q1 && q1.bill_rate, q2 && q2.bill_rate])
  // さらに前の日付から改定し直すと、それ以降の改定前の単価は置き換わる
  const p2 = await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price: 2500, price_valid_from: addDays(change, -10) })
  const h2 = await admin.get(`/api/admin/projects/${pid}/price-history`)
  ok('#210 より前の日付から改定し直すと、重なる改定前の単価を前日までに縮める', p2.status === 200 && h2.data.history.length === 1 && h2.data.history[0].valid_to === addDays(change, -11), h2.data)
  // 単価ルールに終了日を付ける（PUT）
  const e = await admin.put(`/api/admin/rate-rules/${b.data.rule_id}`, { valid_to: addDays(today, 30) })
  const rules = (await admin.get(`/api/admin/rate-rules?project_id=${pid}`)).data.rules
  ok('#210 単価ルールに終了日を付けられる', e.status === 200 && rules.find(x => x.rule_id === b.data.rule_id).valid_to === addDays(today, 30), rules)
}

// ---------- #145 枠の役割の単価の単位 ----------
{
  const pid = await newProject('slotunit')
  const d = addDays(today, -11)
  const r = await admin.post('/api/admin/shift-slots', { project_id: pid, work_date: d, start_time: '10:00', end_time: '19:00', break_minutes: 60, roles: [{ role_name: 'リーダー', headcount: 2, pay_rate: 15000 }, { role_name: 'MC', headcount: 1, bill_rate: 1800, bill_unit_type: 'hourly' }] })
  const slot = (await admin.get(`/api/admin/shift-slots/${r.data.slot_ids[0]}`)).data
  const leader = slot.roles.find(x => x.role_name === 'リーダー'), mc = slot.roles.find(x => x.role_name === 'MC')
  ok('#145 単位を省略した枠の単価は日額で保存する', leader.pay_unit_type === 'daily' && leader.bill_unit_type === null && mc.bill_unit_type === 'hourly', [leader, mc])
  const as = await admin.post(`/api/admin/shift-slots/roles/${leader.slot_role_id}/assign`, { staff_ids: [4], force: true })
  const sh = await boardShift(as.data.shift_ids[0], d)
  ok('#145 時給の案件でも、日額の枠の支払単価は 15,000円/日（8時間分にしない）', sh && sh.pay_unit_type === 'daily' && sh.pay_amount === 15000, sh && [sh.pay_unit_type, sh.pay_amount])
}

// ---------- #144 役割名の変更と単価ルール ----------
{
  const pid = await newProject('rename')
  const d = addDays(today, -10)
  await admin.post('/api/admin/rate-rules', { project_id: pid, role_name: '販売', pay_unit_type: 'hourly', pay_rate: 2000 })
  const r = await admin.post('/api/admin/shift-slots', { project_id: pid, work_date: d, start_time: '10:00', end_time: '18:00', break_minutes: 0, roles: [{ role_name: '販売', headcount: 2 }] })
  const slotId = r.data.slot_ids[0]
  const role = (await admin.get(`/api/admin/shift-slots/${slotId}`)).data.roles[0]
  const as = await admin.post(`/api/admin/shift-slots/roles/${role.slot_role_id}/assign`, { staff_ids: [3, 5], force: true })
  const [sa, sb] = as.data.shift_ids
  ok('#144 前提: 役割「販売」の単価ルール（支払 2,000円/時）が当たる', (await boardShift(sa, d)).pay_rate === 2000)
  // 1件を確定する
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [sb], force: true })
  ok('#144 前提: 1件を確定', cf.status === 200 && cf.data.confirmed === 1, cf.data)
  const body = { roles: [{ slot_role_id: role.slot_role_id, role_name: '販売スタッフ', headcount: 2 }] }
  const c1 = await admin.put(`/api/admin/shift-slots/${slotId}`, body)
  ok('#144 単価ルールのある役割名を変えると、確認を求める（409）', c1.status === 409 && c1.data.need_role_rate === true && c1.data.roles[0].rules_from === 1, c1.data)
  const roleAfter409 = (await admin.get(`/api/admin/shift-slots/${slotId}`)).data.roles[0]
  ok('#144 確認を求めたときは何も保存しない', roleAfter409.role_name === '販売', roleAfter409)
  const c2 = await admin.put(`/api/admin/shift-slots/${slotId}`, { ...body, role_rate: 'keep' })
  const roleKept = (await admin.get(`/api/admin/shift-slots/${slotId}`)).data.roles[0]
  const a2 = await boardShift(sa, d), b2 = await boardShift(sb, d)
  ok('#144 「今のルールのまま」なら名前だけ変わり、単価は変わらない', c2.status === 200 && roleKept.role_name === '販売スタッフ' && roleKept.rate_role_name === '販売' && a2.pay_rate === 2000 && a2.role === '販売スタッフ', [c2.data, roleKept, a2 && a2.pay_rate])
  ok('#144 確定済みのシフトの役割名は変えない', b2 && b2.role === '販売', b2 && b2.role)
  // 再適用しても外れない（役割の ID から照合する名前を決める）
  await admin.post('/api/admin/shifts/reprice', { from: d, to: d, project_id: pid })
  ok('#144 再適用しても単価ルールが外れない', (await boardShift(sa, d)).pay_rate === 2000)
  // 新しい名前のルールに切り替える
  const c3 = await admin.put(`/api/admin/shift-slots/${slotId}`, { roles: [{ slot_role_id: role.slot_role_id, role_name: 'リーダー', headcount: 2 }], role_rate: 'follow' })
  const a3 = await boardShift(sa, d)
  ok('#144 「新しい名前のルールに切り替える」と、標準単価（1,200円/時）に戻る', c3.status === 200 && a3.pay_rate === 1200, [c3.data, a3 && a3.pay_rate])
  await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [sb] })
}

// ---------- #469 再適用の前に変わる金額を確かめる ----------
{
  const pid = await newProject('preview')
  const d1 = addDays(today, -9), d2 = addDays(today, -8)
  const s1 = await createShift(pid, 4, d1, '10:00', '18:00', 'pv1')
  const s2 = await createShift(pid, 4, d2, '10:00', '18:00', 'pv2')
  await admin.post('/api/admin/rate-rules', { project_id: pid, pay_unit_type: 'hourly', pay_rate: 1500 })
  const dry = await admin.post('/api/admin/shifts/reprice', { from: d1, to: d2, project_id: pid, dry_run: true })
  ok('#469 dry_run は件数と、変わるシフト・増減の合計を返す', dry.status === 200 && dry.data.count === 2 && dry.data.changed === 2 && dry.data.pay_diff === 2 * 8 * 300 && dry.data.bill_diff === 0, dry.data)
  const ch = dry.data.changes.find(x => x.shift_id === s1)
  ok('#469 一覧に日付・スタッフ・支払の前後を出す', ch && ch.work_date === d1 && ch.staff_name && ch.pay_before === 9600 && ch.pay_after === 12000, ch)
  const before = await settleRow(s2, d2)
  ok('#469 dry_run では書き換えない', before && before.pay_rate === 1200, before && before.pay_rate)
  const bad = await admin.post('/api/admin/shifts/reprice', { from: d2, to: d1, project_id: pid, dry_run: true })
  ok('#469 開始日が終了日より後なら 400', bad.status === 400, bad.data)
  const run = await admin.post('/api/admin/shifts/reprice', { from: d1, to: d2, project_id: pid })
  ok('#469 実行すると再計算する', run.status === 200 && run.data.updated === 2 && (await settleRow(s2, d2)).pay_rate === 1500, run.data)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
