// 残りの仕上げ（サーバー。w8-server）の統合テスト
//   9004 勤怠の設定を変えられる役割 / #497 案件ごとの遅刻の猶予 / #215 打刻修正の受付期限の設定 / #184 日報の数値項目の合計 /
//   #359 使われていない案件・クライアントの削除 / #297 書類の有効期限の知らせ / #273 交通費の申請の領収書の写真
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先> --test-scheduled` で起動していること
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w8-server.mjs
//   PERSIST（ローカルの D1 の保存先）があれば、日報（#184）と書類（#297）を D1 に直接入れて確かめる（無ければその項目は飛ばす）
//   #297 は日本時間 8 時より前は定期処理が何もしないので飛ばす
import { execSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
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
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const headers = { Cookie: cookie || '' }
    if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json'
    const opts = { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) }
    // wrangler d1 execute（sql）の間に閉じられた接続を使ったときは、1回だけ送り直す（送る前に切れているので二重にはならない）
    const r = await fetch(`${BASE}${path}`, opts).catch(e => { if (e && e.cause && e.cause.code === 'ECONNRESET') return fetch(`${BASE}${path}`, opts); throw e })
    const buf = Buffer.from(await r.arrayBuffer())
    const text = buf.toString('utf8')
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, buf, type: r.headers.get('content-type') || '' }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const sql = (command) => JSON.parse(execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --json --command "${command.replace(/\s*\n\s*/g, ' ').replace(/"/g, '\\"')}"`, { stdio: 'pipe' }).toString())[0].results
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1)

const PFX = 'W8S' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const sales = client(await login('sample', 'sales01'))
const hq = client(await login('sample', 'hq'))
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')

async function newProject(name, extra = {}) {
  return must(await admin.post('/api/admin/projects', { project_name: name, allow_duplicate: true, ...extra }), 'project ' + name).project_id
}
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: phoneOf() }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`).staff_id
}
async function newShift(staff_id, project_id, work_date, extra = {}) {
  const memo = `${PFX}-${++seq}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '19:00', memo, force: true, confirm_warnings: true, ...extra })
  if (r.status !== 200) throw new Error('shift ' + r.text)
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
}
const proxy = (id, times) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: Object.keys(times), times })

const P = await newProject(`${PFX}-猶予30`), Q = await newProject(`${PFX}-会社の猶予`)
const SA = await newStaff('A'), SB = await newStaff('B')
const stA = client(await login('sample', `${PFX}A`)), stB = client(await login('sample', `${PFX}B`))

// ---------- 9004 勤怠の設定を変えられるのは会社管理者・現場管理者だけ ----------
const lateBefore = must(await admin.get('/api/admin/settings/lateness'), 'lateness').grace_minutes
const skipBefore = must(await admin.get('/api/admin/settings/photo-skip'), 'photo-skip').enabled
{
  const denied = [
    await sales.post('/api/admin/settings/photo-required', { enabled: true }),
    await sales.post('/api/admin/settings/photo-skip', { enabled: true }),
    await sales.put('/api/admin/settings/lateness', { grace_minutes: 5 }),
    await sales.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 5 }),
    await sales.put(`/api/admin/projects/${P}/photo-required`, { override: 'off' }),
    await sales.put('/api/admin/settings/corrections', { deadline_days: 5 }),
  ]
  ok('9004 営業管理者は写真必須・写真なし・遅刻の猶予・案件の上書き・受付期限を変えられない（403）', denied.every(r => r.status === 403 && r.data.code === 'role_forbidden'), denied.map(r => r.status))
  const g = await sales.get('/api/admin/settings/photo-required')
  ok('9004 営業管理者も設定は見られる（can_edit=false）', g.status === 200 && g.data.can_edit === false, g.data)
  const m = await mgr.put('/api/admin/settings/lateness', { grace_minutes: lateBefore })
  ok('9004 現場管理者は遅刻の猶予を変えられる', m.status === 200, m.data)
  const a = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
  ok('9004 会社管理者は can_edit=true', a.can_edit === true, a)
  // 写真なしの許可は、ほかの設定を上書きしない（json_set）
  must(await admin.put('/api/admin/settings/lateness', { grace_minutes: 7 }), 'grace 7')
  must(await admin.post('/api/admin/settings/photo-skip', { enabled: !skipBefore }), 'photo-skip toggle')
  const after = must(await admin.get('/api/admin/settings/lateness'), 'lateness').grace_minutes
  const skipAfter = must(await admin.get('/api/admin/settings/photo-skip'), 'photo-skip').enabled
  ok('9004 写真なしの許可を保存しても、遅刻の猶予は変わらない', after === 7 && skipAfter === !skipBefore, { after, skipAfter })
  must(await admin.post('/api/admin/settings/photo-skip', { enabled: skipBefore }), 'photo-skip restore')
}

// ---------- #497 案件ごとの遅刻の猶予 ----------
must(await admin.put('/api/admin/settings/lateness', { grace_minutes: 0 }), 'company grace 0')
{
  let r = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 30 })
  ok('#497 案件の猶予を 30 分にできる（効く値 30）', r.status === 200 && r.data.late_grace_minutes === 30 && r.data.effective_grace_minutes === 30, r.data)
  r = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 121 })
  ok('#497 範囲外の猶予は 400', r.status === 400, r.data)
  r = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: '5' })
  ok('#497 整数でない猶予は 400', r.status === 400, r.data)
  r = await admin.put('/api/admin/projects/999999/lateness', { grace_minutes: 5 })
  ok('#497 ほかの会社・存在しない案件は 404', r.status === 404, r.data)
  const g = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
  const pRow = g.projects.find(x => x.project_id === P), qRow = g.projects.find(x => x.project_id === Q)
  ok('#497 設定の一覧に案件ごとの上書きが出る（未設定は null）', g.grace_minutes === 0 && pRow && pRow.late_grace_minutes === 30 && qRow && qRow.late_grace_minutes === null, { pRow, qRow })
  const pd = must(await admin.get(`/api/admin/projects/${P}`), 'project')
  ok('#497 案件詳細に late_grace_minutes が入る', pd.project.late_grace_minutes === 30, pd.project.late_grace_minutes)

  // 代理入力（staff-lifecycle.ts の proxyRowsOf）
  const a = await newShift(SA, P, yesterday), b = await newShift(SB, Q, yesterday)
  let pa = must(await proxy(a.shift_id, { check_in: '10:20' }), 'proxy A')
  let pb = must(await proxy(b.shift_id, { check_in: '10:20' }), 'proxy B')
  ok('#497 代理入力: 猶予30分の案件で20分遅れの入店は遅刻にしない（分数は残す）', pa.reports[0].status === 'normal' && pa.reports[0].late_minutes === 20, pa.reports)
  ok('#497 代理入力: 上書きのない案件は会社の猶予（0分）で遅刻', pb.reports[0].status === 'late' && pb.reports[0].late_minutes === 20, pb.reports)
  must(await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 10 }), 'grace 10')
  pa = must(await proxy(a.shift_id, { work_start: '10:25' }), 'proxy A ws')
  ok('#497 代理入力: 猶予10分にすると25分遅れの勤務開始は遅刻', pa.reports[0].status === 'late' && pa.reports[0].late_minutes === 25, pa.reports)

  // 打刻修正の承認（corrections.ts の judgeApproval）
  must(await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 30 }), 'grace 30')
  const cr = await stA.post('/api/staff/corrections', { shift_id: a.shift_id, kind: 'modify', report_type: 'check_in', requested_at: `${yesterday} 10:24`, reason: `${PFX} 修正` })
  ok('（前提）スタッフが入店の時刻修正を申請した', cr.status === 200 && cr.data.correction_id, cr.data)
  if (cr.data && cr.data.correction_id) {
    const ap = await admin.post(`/api/admin/corrections/${cr.data.correction_id}/approve`, {})
    ok('#497 打刻修正の承認: 案件の猶予（30分）で判定する（24分遅れは遅刻にしない）', ap.status === 200 && ap.data.report_status === 'normal' && ap.data.late_minutes === 24, ap.data)
  }

  // スタッフアプリ（api.ts の POST /staff/attendance）。開始を今の15分前にしたシフト（日をまたがない時間帯だけ）
  const now = jstNow(), mins = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16))
  if (mins >= 90 && mins <= 20 * 60) {
    const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    must(await admin.put(`/api/admin/projects/${P}/photo-required`, { override: 'off' }), 'photo off')
    const s = await newShift(SA, P, today, { start_time: hm(mins - 15), end_time: hm(mins + 180) })
    // 起床・出発は代理入力で済ませる（報告の順序のため）
    await proxy(s.shift_id, { wake_up: hm(mins - 60), departure: hm(mins - 45) })
    const r2 = await stA.post('/api/staff/attendance', { shift_id: s.shift_id, report_type: 'check_in', latitude: 35.68, longitude: 139.76 })
    ok('#497 アプリ: 猶予30分の案件で約15分遅れの入店は遅刻にしない', r2.status === 200 && r2.data.status !== 'late' && r2.data.late_minutes >= 14 && r2.data.late_minutes <= 17, r2.data)
    must(await admin.put(`/api/admin/projects/${P}/photo-required`, { override: 'inherit' }), 'photo inherit')
  } else console.log('SKIP  #497 アプリの入店（日本時間 1:30〜20:00 以外は、日をまたがないシフトを作れないため省略）')

  r = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: null })
  ok('#497 null で会社の設定に戻す（効く値は会社の 0 分）', r.status === 200 && r.data.late_grace_minutes === null && r.data.effective_grace_minutes === 0, r.data)
}

// ---------- #215 打刻修正の受付期限の設定 ----------
{
  const g0 = must(await admin.get('/api/admin/settings/corrections'), 'corrections settings')
  ok('#215 受付期限を読める（既定は期限なし）', g0.deadline_days === null && g0.max_days === 366 && g0.can_edit === true, g0)
  let r = await admin.put('/api/admin/settings/corrections', { deadline_days: 0 })
  ok('#215 0 日は 400', r.status === 400, r.data)
  r = await admin.put('/api/admin/settings/corrections', { deadline_days: 3 })
  ok('#215 3 日にできる', r.status === 200 && r.data.deadline_days === 3, r.data)
  ok('#215 保存した値を読める', must(await admin.get('/api/admin/settings/corrections'), 'get').deadline_days === 3)
  const old = await newShift(SA, Q, addDays(today, -5))
  r = await stA.post('/api/staff/corrections', { shift_id: old.shift_id, kind: 'add', report_type: 'check_in', requested_at: `${addDays(today, -5)} 10:05`, reason: `${PFX} 期限`, dry_run: true })
  ok('#215 勤務日から3日を過ぎたシフトにはアプリから申請できない', r.status === 400 && /3日を過ぎた/.test(r.data.error), r.data)
  r = await mgr.put('/api/admin/settings/corrections', { deadline_days: null })
  ok('#215 現場管理者が期限なしに戻せる', r.status === 200 && r.data.deadline_days === null, r.data)
  r = await stA.post('/api/staff/corrections', { shift_id: old.shift_id, kind: 'add', report_type: 'check_in', requested_at: `${addDays(today, -5)} 10:05`, reason: `${PFX} 期限`, dry_run: true })
  ok('#215 期限なしに戻すと申請できる（確認のみ）', r.status === 200 && r.data.dry_run === true, r.data)
  const lat = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
  ok('#215 受付期限の保存はほかの設定を変えない', lat.grace_minutes === 0, lat)
}

// ---------- #184 日報の数値項目の合計（スタッフ詳細・スキルシート・案件詳細） ----------
if (PERSIST) {
  sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, submitted_at)
    VALUES (1, ${SA}, ${P}, '${yesterday}', json_object('nyuden', 7, 'mnp', 2, 'memo', 'テキスト'), '${yesterday} 20:00:00')`)
  const ym = yesterday.slice(0, 7)
  const sd = must(await admin.get(`/api/admin/staff/${SA}`), 'staff detail')
  const m = sd.performance.find(x => x.ym === ym)
  ok('#184 スタッフ詳細: テンプレートにない数値の項目も月の合計に出る（values・performance_fields）',
    m && m.values && m.values.nyuden === 7 && m.mnp === 2 && sd.performance_fields.some(f => f.key === 'nyuden') && !sd.performance_fields.some(f => f.key === 'memo'), { m, f: sd.performance_fields })
  const sk = must(await admin.get(`/api/admin/staff/${SA}/skill-sheet`), 'skill sheet')
  ok('#184 スキルシート: 数値の項目の合計（values）', sk.performance.values && sk.performance.values.nyuden === 7 && sk.performance_fields.some(f => f.key === 'nyuden'), sk.performance)
  const pd = must(await admin.get(`/api/admin/projects/${P}?month=${ym}`), 'project detail')
  const row = pd.staff_performance.find(x => x.staff_id === SA)
  ok('#184 案件詳細: スタッフ別の数値の項目の合計（values）', row && row.values && row.values.nyuden === 7 && pd.performance_fields.some(f => f.key === 'nyuden'), { row, f: pd.performance_fields })
} else console.log('SKIP  #184（PERSIST がないため）')

// ---------- #359 使われていない案件・クライアントの削除 ----------
{
  const dup = await newProject(`${PFX}-重複`)
  must(await admin.put(`/api/admin/projects/${dup}/lateness`, { grace_minutes: 5 }), 'dup lateness')
  let r = await admin.del(`/api/admin/projects/${dup}`)
  ok('#359 シフト・日報のない案件は削除できる', r.status === 200 && r.data.deleted === dup, r.data)
  r = await admin.get(`/api/admin/projects/${dup}`)
  ok('#359 削除した案件は見つからない', r.status === 404, r.status)
  r = await admin.del(`/api/admin/projects/${P}`)
  ok('#359 シフトのある案件は削除できない（409・使っている所と件数）', r.status === 409 && r.data.code === 'in_use' && r.data.usage.some(u => u.key === 'shifts' && u.count > 0), r.data)
  r = await admin.del('/api/admin/projects/999999')
  ok('#359 ない案件は 404', r.status === 404, r.data)
  const c1 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先1` }), 'client1').client_id
  must(await admin.post(`/api/admin/clients/${c1}/contacts`, { contact_name: '担当', email: 'tanto@example.com' }), 'contact')
  r = await admin.del(`/api/admin/clients/${c1}`)
  ok('#359 案件のないクライアントは削除できる（担当者の連絡先も一緒に消す）', r.status === 200, r.data)
  const c2 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先2` }), 'client2').client_id
  await newProject(`${PFX}-取引先2の案件`, { client_id: c2 })
  r = await admin.del(`/api/admin/clients/${c2}`)
  ok('#359 案件のあるクライアントは削除できない（409）', r.status === 409 && r.data.usage.some(u => u.key === 'projects'), r.data)
  // ほかの会社からは消せない
  const tag = Date.now().toString(36).slice(-5)
  const cr = await hq.post('/api/hq/companies', { company_code: 'w8' + tag, company_name: `w8削除確認${tag}`, admin_code: 'adminb', admin_password: 'W8-Passw0rd-' + tag, admin_name: 'B社 管理者' })
  if (cr.status === 200) {
    const adminB = client(await login('w8' + tag, 'adminb', 'W8-Passw0rd-' + tag))
    const dup2 = await newProject(`${PFX}-他社確認`)
    r = await adminB.del(`/api/admin/projects/${dup2}`)
    ok('#359 ほかの会社の案件は削除できない（404）', r.status === 404, r.data)
    r = await adminB.del(`/api/admin/clients/${c2}`)
    ok('#359 ほかの会社のクライアントは削除できない（404）', r.status === 404, r.data)
  } else ok('（前提）2社目を作成', false, cr.data)
}

// ---------- #273 交通費の申請の領収書の写真 ----------
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b70000000049454e44ae426082', 'hex')
const form = (buf, type) => { const f = new FormData(); f.append('photo', new Blob([buf], { type }), 'receipt.png'); return f }
{
  const s = await newShift(SA, Q, yesterday)
  const rq = await stA.post('/api/staff/pay/requests', { shift_id: s.shift_id, kind: 'transport', amount: 840, route: '新宿駅〜渋谷駅', round_trip: true })
  ok('（前提）交通費を申請した', rq.status === 200 && rq.data.request_id, rq.data)
  const id = rq.data.request_id
  let r = await stA.post(`/api/staff/pay/requests/${id}/receipt`, form(PNG, 'image/png'))
  ok('#273 承認待ちの交通費の申請に領収書の写真を付けられる', r.status === 200 && r.data.has_receipt === true, r.data)
  r = await stA.post(`/api/staff/pay/requests/${id}/receipt`, form(Buffer.from('hello'), 'text/plain'))
  ok('#273 画像でないファイルは 400', r.status === 400, r.data)
  r = await stA.post(`/api/staff/pay/requests/${id}/receipt`, form(PNG, 'image/png'))
  ok('#273 写真は差し替えられる', r.status === 200, r.data)
  const pay = must(await stA.get(`/api/staff/pay?month=${yesterday.slice(0, 7)}`), 'staff pay')
  const mine = pay.shifts.flatMap(x => x.requests).find(x => x.request_id === id)
  ok('#273 スタッフの一覧に has_receipt が出る（R2 のキーは出さない）', mine && mine.has_receipt === true && !('receipt_key' in mine), mine)
  r = await stA.get(`/api/staff/pay/requests/${id}/receipt`)
  ok('#273 本人は自分の領収書の写真を見られる', r.status === 200 && /image\/png/.test(r.type) && r.buf.length === PNG.length, { status: r.status, type: r.type, len: r.buf.length })
  r = await stB.get(`/api/staff/pay/requests/${id}/receipt`)
  ok('#273 ほかのスタッフは見られない（404）', r.status === 404, r.status)
  const list = must(await admin.get('/api/admin/pay-requests'), 'admin list').requests.find(x => x.request_id === id)
  ok('#273 管理者の一覧に has_receipt が出る', list && list.has_receipt === true, list)
  r = await admin.get(`/api/admin/pay-requests/${id}/receipt`)
  ok('#273 管理者は領収書の写真を見られる', r.status === 200 && r.buf.length === PNG.length, r.status)
  const ob = must(await hq.get('/api/hq/offboarding/1'), 'offboarding counts')
  ok('#273 解約企業の書き出し・削除の対象（R2 のファイル）に領収書の写真が入る', Number(ob.files.staff_pay_requests) >= 1, ob.files)
  must(await admin.post(`/api/admin/pay-requests/${id}/approve`, {}), 'approve')
  r = await stA.post(`/api/staff/pay/requests/${id}/receipt`, form(PNG, 'image/png'))
  ok('#273 承認した後は付け替えられない（409）', r.status === 409, r.data)
  const ot = await stA.post('/api/staff/pay/requests', { shift_id: s.shift_id, kind: 'overtime', new_end_time: '20:00', instructed_by: '店長', reason: `${PFX} 延長` })
  if (ot.status === 200) {
    r = await stA.post(`/api/staff/pay/requests/${ot.data.request_id}/receipt`, form(PNG, 'image/png'))
    ok('#273 延長の申請には付けられない（400）', r.status === 400, r.data)
  }
  if (PERSIST) {
    const key = sql(`SELECT receipt_key FROM staff_pay_requests WHERE request_id = ${Number(id)}`)[0].receipt_key
    ok('#273 写真は pay-receipts/ 以下に置く', /^pay-receipts\/1\/\d+\/\d+_\d+\.png$/.test(key), key)
  }
}

// ---------- #297 書類の有効期限の知らせ（15分おきの定期処理） ----------
const hour = Number(jstNow().slice(11, 13))
if (!PERSIST) console.log('SKIP  #297（PERSIST がないため）')
else if (hour < 8) console.log('SKIP  #297（日本時間 8 時より前は知らせないため）')
else {
  const already = must(await admin.get('/api/admin/notifications?kind=docs_expiring'), 'notifications').notifications.some(n => String(n.created_at).startsWith(today))
  const ins = (vu) => sql(`INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, valid_until)
    VALUES (1, ${SA}, '${PFX}.pdf', '${PFX}/${++seq}', 'application/pdf', 1, 1, 'qualification', '${vu}') RETURNING document_id`)[0].document_id
  const d1 = ins(addDays(today, 10))
  // wrangler d1 execute（sql）の間に閉じられた接続を使ったときは、1回だけ送り直す
  const url = `${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`
  const run = async () => { const r = await fetch(url).catch(() => fetch(url)); await r.text(); return r.status }
  ok('（前提）15分おきの定期処理を起動した', (await run()) === 200)
  const mark1 = sql(`SELECT expiry_notified FROM staff_documents WHERE document_id = ${d1}`)[0].expiry_notified
  const job = sql(`SELECT status, result_json FROM cron_runs WHERE job = 'doc_expiry_notice' ORDER BY run_id DESC LIMIT 1`)[0]
  ok('#297 定期処理（doc_expiry_notice）が記録される', job && job.status === 'ok', job)
  if (already) {
    ok('#297 今日すでに知らせた会社の書類は翌日に回す（印を付けない）', mark1 === null, mark1)
  } else {
    ok('#297 30日以内の書類に「知らせた」印（期限:soon）が付く', mark1 === `${addDays(today, 10)}:soon`, mark1)
    const ns = must(await admin.get('/api/admin/notifications?kind=docs_expiring'), 'notifications').notifications
    ok('#297 管理者にアプリ内通知が届く（書類の一覧へのリンク）', ns.some(n => String(n.created_at).startsWith(today) && n.link === '/admin#staff-requests' && /30日以内に期限: \d+件/.test(n.body)), ns.slice(0, 2))
    const sn = must(await sales.get('/api/admin/notifications?kind=docs_expiring'), 'sales notifications').notifications
    ok('#297 営業管理者にも届く（スタッフ・取引先の書類）', sn.some(n => String(n.created_at).startsWith(today)), sn.slice(0, 1))
    const d2 = ins(addDays(today, -1))
    await run()
    const mark2 = sql(`SELECT expiry_notified FROM staff_documents WHERE document_id = ${d2}`)[0].expiry_notified
    ok('#297 同じ日の2回目は知らせない（後から入った期限切れの書類は翌日に回す）', mark2 === null, mark2)
  }
}

// 後片付け: 遅刻の猶予を元に戻す
must(await admin.put('/api/admin/settings/lateness', { grace_minutes: lateBefore }), 'lateness restore')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
