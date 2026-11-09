// 打刻を混雑で失敗させない（w19-clockin: #9939）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   `wrangler dev --local --persist-to <保存先> --var TEST_HOOKS:true` で起動していること（テスト用の仕掛けを使う。本番の設定には入れない）
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w19-clockin.mjs
// 確かめること:
//   ・同じ一意キーで2回（同時も）送っても1件だけ記録し、2回目は1回目の結果を返す。写真の R2 のキーも一意キーから決まり、増えない
//   ・押した時刻で記録する。端末の時計のずれ5分以上・押してから30分超・未来は受け付けた時刻で記録し、押した時刻と受け付けた時刻が違えば「再送」の印
//   ・D1 の過負荷（テスト用の仕掛け X-Test-D1-Overload）は2回までその場でやり直して記録する。続くときは 503 で、何も記録しない（送り直すと記録される）
//   ・打刻の D1 の往復の回数（X-Test-D1-Calls）が減ったこと、実績（実働時間）への反映が同じ batch で行われること
//   画面の自動の送り直し（IndexedDB・送信中の表示・開き直したときの送り直し）は、ヘッドレスの Chrome で別に確かめる（作業の記録を参照）

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data, calls: r.headers.get('X-Test-D1-Calls') }
  }
  const form = async (path, fd, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie, ...headers }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data, calls: r.headers.get('X-Test-D1-Calls') }
  }
  return { get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b ?? {}, h), put: (p, b) => call('PUT', p, b ?? {}), form }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const minute = (ms) => jst(ms).slice(0, 16) + ':00'
const today = jst(Date.now()).slice(0, 10)
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))
const key = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36)
const callsOf = (r) => { const [c, s] = String(r.calls || '').split('/').map(Number); return { calls: c, statements: s } }

const PFX = 'W19C' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function createShift(staff_id, project_id, start_time, end_time, extra = {}) {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date: today, start_time, end_time, memo, ...extra }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
const reportStatus = async (sid) => must(await admin.get(`/api/admin/shifts/${sid}/report-status`), 'report-status').reports

// 写真が必須の会社設定のままにする（写真なしの入店・退店は写真付きの API で送る）
const pid = await newProject(`${PFX}-案件`)
const A = await newStaff('A'), B = await newStaff('B')
const stA = client(await login('sample', `${PFX}A`)), stB = client(await login('sample', `${PFX}B`))
const sid = await createShift(A.staff_id, pid, '00:00', '23:59')
const rep = (body, headers) => stA.post('/api/staff/attendance', { shift_id: sid, latitude: null, longitude: null, ...body }, headers)

// ---------- (2) 二重にならない ----------
{
  const k1 = key(), p1 = Date.now()
  const r1 = await rep({ report_type: 'wake_up', client_request_id: k1, pressed_at: p1, device_now: Date.now() })
  ok('一意キー付きの打刻を記録できる', r1.status === 200 && r1.data.ok && !r1.data.duplicate, r1)
  const r1b = await rep({ report_type: 'wake_up', client_request_id: k1, pressed_at: p1, device_now: Date.now() })
  ok('同じキーで2回目を送ると、記録済みとして1回目の結果を返す', r1b.status === 200 && r1b.data.duplicate === true && r1b.data.reported_at === r1.data.reported_at, r1b)
  ok('別のキーなら報告済み（409）', (await rep({ report_type: 'wake_up', client_request_id: key() })).status === 409)
  // 同時に2回（応答が届かずに送り直した場合）
  const k2 = key(), p2 = Date.now()
  const [x, y] = await Promise.all([0, 1].map(() => rep({ report_type: 'departure', client_request_id: k2, pressed_at: p2, device_now: Date.now() })))
  ok('同じキーを同時に2回送っても、どちらも成功し、記録は同じ', x.status === 200 && y.status === 200 && x.data.reported_at === y.data.reported_at && [x, y].filter(z => z.data.duplicate).length <= 1, { x, y })
  const rs = await reportStatus(sid)
  ok('記録は種類ごとに1件だけ', rs.filter(r => r.report_type === 'wake_up').length === 1 && rs.filter(r => r.report_type === 'departure').length === 1, rs.map(r => r.report_type))
  ok('他人のシフトには、同じキーでも送れない（404。記録済みの内容も返さない）', (await stB.post('/api/staff/attendance', { shift_id: sid, report_type: 'wake_up', client_request_id: k1 })).status === 404)
}

// ---------- (3) 記録する時刻と「再送」の印 ----------
{
  const s2 = await createShift(A.staff_id, pid, '00:00', '23:58')
  const r2 = (body) => stA.post('/api/staff/attendance', { shift_id: s2, latitude: null, longitude: null, client_request_id: key(), ...body })
  // 押してから3分後に届いた（時計は合っている）: 押した時刻で記録し、再送の印
  const p = Date.now() - 3 * 60000
  const a = await r2({ report_type: 'wake_up', pressed_at: p, device_now: Date.now() })
  ok('押した時刻（分）で記録する', a.status === 200 && a.data.reported_at === minute(p) && a.data.device_time === true && a.data.resent === true, a)
  // すぐ届いた（10秒）: 押した時刻で記録し、印なし
  const pb = Date.now() - 10000
  const b = await r2({ report_type: 'departure', pressed_at: pb, device_now: Date.now() })
  ok('すぐ届いた打刻は押した時刻で記録し、再送の印なし', b.status === 200 && b.data.reported_at === minute(pb) && b.data.resent === false, b)
  // 端末の時計が6分進んでいる: 受け付けた時刻で記録し、再送の印
  const before = Date.now()
  const c = await r2({ report_type: 'work_start', pressed_at: Date.now() - 2 * 60000, device_now: Date.now() + 6 * 60000 })
  ok('端末の時計が5分以上ずれていれば、受け付けた時刻で記録し再送の印', c.status === 200 && c.data.reported_at >= minute(before) && c.data.reported_at <= minute(Date.now()) && c.data.device_time === false && c.data.resent === true, c)
  // 押してから31分: 受け付けた時刻
  const s3 = await createShift(A.staff_id, pid, '00:00', '23:57')
  const r3 = (body) => stA.post('/api/staff/attendance', { shift_id: s3, latitude: null, longitude: null, client_request_id: key(), ...body })
  const before3 = Date.now()
  const d = await r3({ report_type: 'wake_up', pressed_at: Date.now() - 31 * 60000, device_now: Date.now() })
  ok('押してから30分を超えたら、受け付けた時刻で記録し再送の印', d.status === 200 && d.data.reported_at >= minute(before3) && d.data.resent === true && d.data.device_time === false, d)
  // 押した時刻が未来（時計のずれは5分未満）: 受け付けた時刻
  const e = await r3({ report_type: 'departure', pressed_at: Date.now() + 3 * 60000, device_now: Date.now() + 3 * 60000 })
  ok('押した時刻が未来なら、受け付けた時刻で記録し再送の印', e.status === 200 && e.data.reported_at <= minute(Date.now()) && e.data.resent === true && e.data.device_time === false, e)
  // 押した時刻が前の報告より前になるときは、受け付けた時刻で記録する（順序が逆の記録を作らない）
  const f = await r3({ report_type: 'work_start', pressed_at: Date.now() - 20 * 60000, device_now: Date.now() })
  ok('前の報告より前の押した時刻は、受け付けた時刻で記録する', f.status === 200 && f.data.reported_at >= e.data.reported_at && f.data.device_time === false && f.data.resent === true, f)
  ok('押した時刻が数値でなければ 400', (await r3({ report_type: 'break_start', pressed_at: 'abc' })).status === 400)
  // 管理画面: シフトの報告状況と打刻の一覧に「再送」
  const rs = await reportStatus(s2)
  const by = Object.fromEntries(rs.map(r => [r.report_type, r]))
  ok('シフトの報告状況に再送の印（押した時刻で記録・受け付けた時刻で記録とも）', by.wake_up.resent === true && by.wake_up.device_time === true && by.work_start.resent === true && by.work_start.device_time === false && by.departure.resent === false, rs)
  const pl = must(await admin.get(`/api/admin/attendance-punches?from=${today}&to=${today}&staff_name=${encodeURIComponent(PFX + ' A')}`), 'punches')
  const row = pl.rows.find(r => r.shift_id === s2)
  ok('打刻の一覧の印に再送（16）', row && (row.wake_up_f & 16) && (row.work_start_f & 16) && !(row.departure_f & 16), row)
}

// ---------- (4) D1 の過負荷のときのやり直し ----------
{
  const s4 = await createShift(A.staff_id, pid, '00:00', '23:56')
  const r4 = (body, h) => stA.post('/api/staff/attendance', { shift_id: s4, latitude: null, longitude: null, ...body }, h)
  const a = await r4({ report_type: 'wake_up', client_request_id: key(), pressed_at: Date.now(), device_now: Date.now() }, { 'X-Test-D1-Overload': '2' })
  ok('書き込みが2回続けて過負荷でも、その場でやり直して記録する', a.status === 200 && a.data.ok, a)
  const k = key(), p = Date.now()
  const b = await r4({ report_type: 'departure', client_request_id: k, pressed_at: p, device_now: Date.now() }, { 'X-Test-D1-Overload': '3' })
  ok('過負荷が続くときは 503（混雑。画面が送り直す）', b.status === 503 && b.data.code === 'busy', b)
  ok('503 のときは何も記録しない', !(await reportStatus(s4)).some(r => r.report_type === 'departure'))
  const c = await r4({ report_type: 'departure', client_request_id: k, pressed_at: p, device_now: Date.now() })
  ok('同じキーで送り直すと、押した時刻で1件だけ記録する', c.status === 200 && !c.data.duplicate && c.data.reported_at === minute(p), c)
  ok('送り直しの後も1件だけ', (await reportStatus(s4)).filter(r => r.report_type === 'departure').length === 1)
}

// ---------- 写真付きの打刻: 写真のキーも一意キーから決まる ----------
let photoCalls = null
{
  const s5 = await createShift(A.staff_id, pid, '00:00', '23:55')
  const k = key(), p = Date.now() - 2 * 60000
  const fd = (extra = {}) => { const f = new FormData(); f.append('shift_id', String(s5)); f.append('report_type', 'check_in'); f.append('latitude', '35.68'); f.append('longitude', '139.76')
    f.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png'); f.append('client_request_id', k); f.append('pressed_at', String(p)); f.append('device_now', String(Date.now()))
    for (const [x, y] of Object.entries(extra)) f.append(x, y); return f }
  const b = await stA.form('/api/staff/attendance-photo', fd(), { 'X-Test-D1-Overload': '3' })
  ok('写真付きも、過負荷が続くときは 503', b.status === 503, b)
  const a = await stA.form('/api/staff/attendance-photo', fd())
  photoCalls = callsOf(a)
  ok('写真付きの打刻を押した時刻で記録し、写真のキーは一意キーから決まる', a.status === 200 && a.data.reported_at === minute(p) && String(a.data.photo_key).endsWith(`check_in_${k}.png`) && a.data.resent === true, a)
  const a2 = await stA.form('/api/staff/attendance-photo', fd())
  ok('写真付きの同じキーの送り直しは記録済みとして返す（写真のキーは同じ）', a2.status === 200 && a2.data.duplicate === true && a2.data.photo_key === a.data.photo_key, a2)
  const ph = must(await admin.get(`/api/admin/shifts/${s5}/attendance-photos`), 'photos')
  ok('写真は1件だけ', ph.reports.filter(r => r.report_type === 'check_in' && r.has_photo).length === 1, ph.reports)
  const g = await fetch(`${BASE}/api/staff/attendance-photo/${a.data.photo_key}`, { headers: { Cookie: (await login('sample', `${PFX}A`)) } })
  ok('記録した写真を本人が開ける（503 の後の送り直しで写真が消えていない）', g.status === 200)
  // 写真なしの入店（写真必須の会社）は断る（これまでどおり）
  const s6 = await createShift(A.staff_id, pid, '00:00', '23:54')
  ok('写真が必須なら、写真なしの入店は断る（これまでどおり）', (await stA.post('/api/staff/attendance', { shift_id: s6, report_type: 'check_in', client_request_id: key() })).status === 400)
}

// ---------- 実績への反映（報告の追加と同じ batch）と D1 の回数 ----------
{
  const s7 = await createShift(A.staff_id, pid, '00:00', '23:53')
  const r7 = (body) => stA.post('/api/staff/attendance', { shift_id: s7, latitude: null, longitude: null, client_request_id: key(), device_now: Date.now(), ...body })
  const w = await r7({ report_type: 'work_start', pressed_at: Date.now() - 2 * 60000 })
  const wc = callsOf(w)
  const e = await r7({ report_type: 'work_end', pressed_at: Date.now() })
  const ec = callsOf(e)
  ok('勤務開始・勤務終了を記録できる', w.status === 200 && e.status === 200, { w, e })
  const sh = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.shift_id === s7)
  ok('勤務開始・勤務終了が実績（実働時間）に反映される', sh && sh.actual_start === w.data.reported_at.slice(11, 16) && sh.actual_end === e.data.reported_at.slice(11, 16) && sh.actual_source === 'report', sh)
  // 時給のシフト: 入店・退店の記録と同じ batch で時給の数量・金額を反映し、精算の「今の計算と違う」にならない（settlement.ts と同じ計算）
  // 休憩の既定が0分の時給の案件を使う（案件の休憩の既定は60分なので、25分の実働から引くと0時間になるため）
  const pid8 = await newProject(PFX + '-時給')
  must(await admin.put('/api/admin/projects/' + pid8 + '/pricing', { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'clipped' }), 'pricing')
  const s8 = await createShift(A.staff_id, pid8, '00:00', '23:52')
  must(await admin.put(`/api/admin/shifts/${s8}/price`, { bill_unit_type: 'hourly', bill_rate: 1500, pay_unit_type: 'hourly', pay_rate: 1200, bill_qty: '', pay_qty: '' }), 'price')
  const fdp = (type, p) => { const f = new FormData(); f.append('shift_id', String(s8)); f.append('report_type', type); f.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png')
    f.append('client_request_id', key()); f.append('pressed_at', String(p)); f.append('device_now', String(Date.now())); return f }
  const ci = await stA.form('/api/staff/attendance-photo', fdp('check_in', Date.now() - 25 * 60000))
  const co = await stA.form('/api/staff/attendance-photo', fdp('check_out', Date.now()))
  const st = must(await admin.get(`/api/admin/settlement?from=${today}&to=${today}`), 'settlement').rows.find(r => r.shift_id === s8)
  ok('時給のシフトは入店・退店で実績と数量・金額が反映され、精算の確認事項に「今の計算と違う」が出ない',
    ci.status === 200 && co.status === 200 && st && st.actual_start === ci.data.reported_at.slice(11, 16) && st.actual_end === co.data.reported_at.slice(11, 16)
    && Number(st.pay_qty) > 0 && !(st.issues || []).includes('数量・金額が今の計算と違う'), st && { a: st.actual_start, e: st.actual_end, bq: st.bill_qty, pq: st.pay_qty, pa: st.pay_amount, issues: st.issues, src: st.actual_source })
  console.log(`  D1 の回数（往復/文）: 勤務開始 ${w.calls}・勤務終了（実績の反映あり） ${e.calls}・写真付きの入店 ${photoCalls ? photoCalls.calls + '/' + photoCalls.statements : '-'}`)
  ok('打刻の D1 の往復は3回以内（本人の行・読み込み・書き込み）', wc.calls <= 3 && ec.calls <= 3 && photoCalls && photoCalls.calls <= 3, { wc, ec, photoCalls })
  ok('打刻の D1 の文は10以下（読み込みは1つの batch）', wc.statements <= 10 && ec.statements <= 10 && photoCalls.statements <= 10, { wc, ec, photoCalls })
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
