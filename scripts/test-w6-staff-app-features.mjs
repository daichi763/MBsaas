// スタッフアプリの機能追加の統合テスト（w6-staff-app-features: #278 次回の稼働、#176 前日確認、#427 電波がない場所での報告）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w6-staff-app-features.mjs
// 端末に保存して通信が戻ってから送る画面の動き（IndexedDB・online イベント）はここでは確かめない。API の時刻の検証・冪等キーを確かめる

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
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  const form = async (path, fd) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p), form }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const today = jst(Date.now()).slice(0, 10), tomorrow = addDays(today, 1), dayAfter = addDays(today, 2), yesterday = addDays(today, -1)
const minuteOf = (t) => Date.parse(String(t).slice(0, 16).replace(' ', 'T') + ':00Z') / 60000
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))
const key = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36)

const PFX = 'W6S' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function createShift(staff_id, project_id, work_date, start_time, end_time, extra = {}) {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, ...extra }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}

const pid = await newProject(`${PFX}-案件`)
const A = await newStaff('A'), B = await newStaff('B')
const stA = client(await login('sample', `${PFX}A`)), stB = client(await login('sample', `${PFX}B`))

// ---------- #278 次回の稼働 ----------
const tmA = await createShift(A.staff_id, pid, tomorrow, '09:00', '18:00')
const tmA2 = await createShift(A.staff_id, pid, tomorrow, '19:00', '21:00')
const daA = await createShift(A.staff_id, pid, dayAfter, '10:00', '15:00')
{
  const h = must(await stA.get('/api/staff/home'), 'home')
  const n = h.next_shifts || []
  ok('#278 ホームが次回（明日以降の最初の稼働日）のシフトを返す', n.length === 2 && n.every(x => x.work_date === tomorrow) && n[0].shift_id === tmA && n[1].shift_id === tmA2, n)
  ok('#278 次回のシフトに案件名・時刻が付き、金額は返さない', n[0].project_name === `${PFX}-案件` && n[0].start_time === '09:00' && !('unit_price' in n[0]) && !('pay_amount' in n[0]), n[0])
  ok('#176 前日確認を使っていない会社では day_before は null', n[0].day_before === null, n[0])
  const hB = must(await stB.get('/api/staff/home'), 'home B')
  ok('#278 シフトのない人は next_shifts が空', Array.isArray(hB.next_shifts) && hB.next_shifts.length === 0, hB.next_shifts)
}

// ---------- #176 前日確認 ----------
{
  const g = must(await admin.get('/api/admin/report-settings/day-before-check'), 'get setting')
  ok('#176 設定の既定は使わない・締切 18:00', g.enabled === false && g.deadline === '18:00', g)
  const d0 = must(await admin.get('/api/admin/dashboard'), 'dashboard')
  ok('#176 使っていないとダッシュボードの day_before は enabled: false だけ', d0.day_before && d0.day_before.enabled === false && !d0.day_before.shifts, d0.day_before)
  ok('#176 使っていないと本人の確認は 400', (await stA.post('/api/staff/day-before-confirm', { shift_ids: [tmA] })).status === 400)
  ok('#176 締切の時刻が不正なら 400', (await admin.put('/api/admin/report-settings/day-before-check', { enabled: true, deadline: '24:00' })).status === 400)
  ok('#176 enabled が真偽値でなければ 400', (await admin.put('/api/admin/report-settings/day-before-check', { enabled: 'yes', deadline: '18:00' })).status === 400)
  // 締切を 00:00 にして、締切を過ぎた状態にする
  must(await admin.put('/api/admin/report-settings/day-before-check', { enabled: true, deadline: '00:00' }), 'put setting')
  const g2 = must(await admin.get('/api/admin/report-settings/day-before-check'), 'get setting 2')
  ok('#176 設定を保存できる', g2.enabled === true && g2.deadline === '00:00', g2)
  const lat = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
  ok('#176 ほかの会社設定（遅刻の猶予）を消さない', typeof lat.grace_minutes === 'number', lat)

  const h = must(await stA.get('/api/staff/home'), 'home')
  const n = h.next_shifts
  ok('#176 明日のシフトに前日確認の状態（締切・未確認）が付く', n[0].day_before && n[0].day_before.deadline === '00:00' && n[0].day_before.confirmed_at === null, n[0])

  const d = must(await admin.get('/api/admin/dashboard'), 'dashboard')
  const db = d.day_before
  const mine = (db.shifts || []).filter(s => s.staff_id === A.staff_id)
  ok('#176 ダッシュボードに明日のシフトの確認状況（未確認・電話番号の列）', db.enabled && db.date === tomorrow && mine.length === 2 && mine.every(s => s.confirmed_at === null && 'staff_phone' in s), db)
  ok('#176 締切を過ぎても未確認の人がいると ToDo に出る', (d.todos || []).some(t => t.key === `day_before:${tomorrow}` && t.href === '#dash-day-before'), (d.todos || []).map(t => t.key))
  ok('#176 前日確認の ToDo は過ぎたことを示す', db.past_deadline === true && db.unconfirmed_staff_count >= 1, db)

  ok('#176 明日でないシフトは確認できない（400）', (await stA.post('/api/staff/day-before-confirm', { shift_ids: [daA] })).status === 400)
  ok('#176 ほかの人のシフトは確認できない（404）', (await stB.post('/api/staff/day-before-confirm', { shift_ids: [tmA] })).status === 404)
  ok('#176 シフトの指定が無ければ 400', (await stA.post('/api/staff/day-before-confirm', {})).status === 400)
  const c = await stA.post('/api/staff/day-before-confirm', { shift_ids: [tmA, tmA2] })
  ok('#176 本人が明日のシフトをまとめて確認できる', c.status === 200 && c.data.shift_ids.length === 2, c)
  const h2 = must(await stA.get('/api/staff/home'), 'home 2')
  ok('#176 確認するとホームで確認済みになる', h2.next_shifts.every(x => x.day_before && x.day_before.confirmed_at), h2.next_shifts)
  const again = await stA.post('/api/staff/day-before-confirm', { shift_id: tmA })
  ok('#176 もう一度押しても成功し、最初の確認の日時を残す', again.status === 200 && must(await stA.get('/api/staff/home'), 'h').next_shifts[0].day_before.confirmed_at === h2.next_shifts[0].day_before.confirmed_at, again)
  const d2 = must(await admin.get('/api/admin/dashboard'), 'dashboard 2')
  const m2 = d2.day_before.shifts.filter(s => s.staff_id === A.staff_id)
  ok('#176 ダッシュボードで本人の確認済みになる（記録した管理者なし）', m2.every(s => s.confirmed_at && !s.confirmed_by_name), m2)

  // 確認の後にシフトの時刻が変わったら、未確認に戻る
  must(await admin.put(`/api/admin/shifts/${tmA}`, { start_time: '09:30', end_time: '18:00' }), 'update shift')
  const h3 = must(await stA.get('/api/staff/home'), 'home 3')
  const x3 = h3.next_shifts.find(x => x.shift_id === tmA)
  ok('#176 確認の後に時刻が変わったシフトは未確認（changed）に戻る', x3 && x3.day_before.confirmed_at === null && x3.day_before.changed === true, x3)
  const d3 = must(await admin.get('/api/admin/dashboard'), 'dashboard 3')
  const s3 = d3.day_before.shifts.find(s => s.shift_id === tmA)
  ok('#176 ダッシュボードでも『確認後に変更』で未確認', s3 && s3.confirmed_at === null && s3.changed === true, s3)

  // 管理者が電話で確かめて確認済みにする
  const ac = await admin.post(`/api/admin/shifts/${tmA}/day-before-confirm`)
  ok('#176 管理者が確認済みにできる', ac.status === 200 && ac.data.confirmed_by_name, ac)
  const d4 = must(await admin.get('/api/admin/dashboard'), 'dashboard 4')
  const s4 = d4.day_before.shifts.find(s => s.shift_id === tmA)
  ok('#176 管理者が記録したことが分かる', s4 && s4.confirmed_at && s4.confirmed_by_name, s4)

  // 遅刻の ToDo から前日確認の一覧へ移れる（使っている会社だけ）。ここでは ToDo の形だけ確かめる
  const lateTodo = (d4.todos || []).concat(d4.hidden_todos || []).find(t => String(t.key).startsWith('late:'))
  if (lateTodo) ok('#176 遅刻の ToDo から前日確認の一覧へのリンク', lateTodo.href === '#dash-day-before', lateTodo)

  // 他社の管理者は確認済みにできない
  const hq = client(await login('sample', 'hq'))
  const tag = Date.now().toString(36).slice(-5)
  const codeB = 'w6s' + tag, pwB = 'W6s-Passw0rd-' + tag
  const cr = await hq.post('/api/hq/companies', { company_code: codeB, company_name: `前日確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
  if (cr.status === 200) {
    const adminB = client(await login(codeB, 'adminb', pwB))
    must(await adminB.put('/api/admin/report-settings/day-before-check', { enabled: true, deadline: '18:00' }), 'B setting')
    ok('#176 他社のシフトは確認済みにできない（404）', (await adminB.post(`/api/admin/shifts/${tmA2}/day-before-confirm`)).status === 404)
  } else ok('（前提）B 社を作成', false, cr)

  // 使うのをやめると、本人の確認は 400、ホームの day_before は null
  must(await admin.put('/api/admin/report-settings/day-before-check', { enabled: false, deadline: '18:00' }), 'disable')
  ok('#176 使うのをやめると本人の確認は 400', (await stA.post('/api/staff/day-before-confirm', { shift_ids: [tmA] })).status === 400)
  ok('#176 使うのをやめるとホームの day_before は null', must(await stA.get('/api/staff/home'), 'h').next_shifts.every(x => x.day_before === null))
}

// ---------- #427 電波がない場所での報告 ----------
const sid = await createShift(A.staff_id, pid, today, '00:00', '23:59')
const rep = (body) => stA.post('/api/staff/attendance', { shift_id: sid, latitude: null, longitude: null, ...body })
{
  // 一意キーの再送は、別のシフトで確かめる
  const sidW = await createShift(A.staff_id, pid, today, '00:00', '23:57')
  const repW = (body) => stA.post('/api/staff/attendance', { shift_id: sidW, latitude: null, longitude: null, ...body })
  const k1 = key()
  const r1 = await repW({ report_type: 'wake_up', client_request_id: k1 })
  ok('#427 一意キー付きの報告を記録できる（押した時刻なしは受け取った時刻）', r1.status === 200 && r1.data.device_time === false, r1)
  const r1b = await repW({ report_type: 'wake_up', client_request_id: k1 })
  ok('#427 同じキーの再送は 409 にせず、記録済みとして返す', r1b.status === 200 && r1b.data.duplicate === true && r1b.data.reported_at === r1.data.reported_at, r1b)
  const r1c = await repW({ report_type: 'wake_up', client_request_id: key() })
  ok('#427 別のキーなら従来どおり報告済み（409）', r1c.status === 409, r1c)

  ok('#427 数値でない押した時刻は断る（400）', (await rep({ report_type: 'departure', client_request_id: key(), pressed_at: 'abc' })).status === 400)
  const p2 = Date.now() - 30 * 60000
  const r2 = await rep({ report_type: 'departure', client_request_id: key(), pressed_at: p2 })
  ok('#427 30分前に押した報告は押した時刻（分）で記録する', r2.status === 200 && r2.data.device_time === true && r2.data.reported_at === jst(p2).slice(0, 16) + ':00', r2)

  const r3 = await rep({ report_type: 'check_in', client_request_id: key(), pressed_at: Date.now() - 60 * 60000 })
  ok('#427 前の報告（出発）より前の時刻にはできない（400）', r3.status === 400 && r3.data.code === 'device_time', r3)
  const r4 = await rep({ report_type: 'check_in', client_request_id: key(), pressed_at: Date.now() + 10 * 60000 })
  ok('#427 先の時刻（端末の時計が進んでいる）は断る（400）', r4.status === 400 && r4.data.code === 'device_time', r4)
  const r5 = await rep({ report_type: 'check_in', client_request_id: key(), pressed_at: Date.now() - 13 * 3600000 })
  ok('#427 12時間より前に押したものは断る（400）', r5.status === 400 && r5.data.code === 'device_time', r5)

  const p6 = Date.now() - 20 * 60000
  const r6 = await rep({ report_type: 'check_in', client_request_id: key(), pressed_at: p6 })
  const expLate = Math.max(0, minuteOf(jst(p6)) - minuteOf(`${today} 00:00`))
  ok('#427 遅刻の判定は押した時刻で行う', r6.status === 200 && r6.data.device_time === true && r6.data.late_minutes === expLate, { r6, expLate })

  // 押した時刻が受け取った時刻と同じ分・少し先（時計のずれ）なら、受け取った時刻で記録する
  const r7 = await rep({ report_type: 'work_start', client_request_id: key(), pressed_at: Date.now() + 60000 })
  ok('#427 少し先の押した時刻は受け取った時刻で記録する（印なし）', r7.status === 200 && r7.data.device_time === false, r7)
  const h = must(await stA.get(`/api/staff/home?shift_id=${sid}`), 'home')
  const dep = h.reports.departure
  ok('#427 ホームの報告に押した時刻で記録した印と受け取った時刻', dep && dep.device_time === true && dep.received_at && dep.received_at > dep.reported_at, dep)
  ok('#427 受け取った時刻で記録した報告には印が付かない', h.reports.work_start && h.reports.work_start.device_time === false && h.reports.work_start.received_at === null, h.reports.work_start)
  const d = must(await admin.get('/api/admin/dashboard'), 'dashboard')
  const ds = (d.shifts || []).find(s => s.shift_id === sid)
  ok('#427 ダッシュボードの報告に端末時刻の印と受信時刻', ds && ds.reports.departure.device_time === true && ds.reports.departure.received_at && !ds.reports.work_start.device_time, ds && ds.reports)

  // 写真付きの報告（退店）も、押した時刻と一意キーを受け付ける
  const sid2 = await createShift(A.staff_id, pid, today, '00:00', '23:58')
  const kp = key(), pp = Date.now() - 2 * 60000
  const photoForm = () => { const fd = new FormData(); fd.append('shift_id', String(sid2)); fd.append('report_type', 'check_out'); fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png'); fd.append('client_request_id', kp); fd.append('pressed_at', String(pp)); return fd }
  const ph = await stA.form('/api/staff/attendance-photo', photoForm())
  ok('#427 写真付きの報告も押した時刻で記録する', ph.status === 200 && ph.data.device_time === true && ph.data.reported_at === jst(pp).slice(0, 16) + ':00' && ph.data.photo_key, ph)
  const ph2 = await stA.form('/api/staff/attendance-photo', photoForm())
  ok('#427 写真付きの同じキーの再送は記録済みとして返す（写真は増やさない）', ph2.status === 200 && ph2.data.duplicate === true && ph2.data.photo_key === ph.data.photo_key, ph2)

  // 受付の時間帯は押した時刻で確かめる: 昨日の 00:00〜01:00 のシフトに、今日押した起床は受け付けない
  const ys = await createShift(A.staff_id, pid, yesterday, '00:00', '01:00')
  const ry = await stA.post('/api/staff/attendance', { shift_id: ys, report_type: 'wake_up', client_request_id: key(), pressed_at: Date.now() - 60000 })
  ok('#427 押した時刻が受付の時間帯の外なら断る', ry.status === 400, ry)
  // 他人のシフトには送れない
  ok('#427 他人のシフトには送れない（404）', (await stB.post('/api/staff/attendance', { shift_id: sid, report_type: 'work_start', client_request_id: key(), pressed_at: Date.now() - 60000 })).status === 404)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
