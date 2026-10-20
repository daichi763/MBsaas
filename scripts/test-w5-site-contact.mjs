// 会社の緊急連絡先と、入店位置と現場の距離の判定（w5-site-contact: #173 #277）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8823 node scripts/test-w5-site-contact.mjs
// 画面（staff.js の「その他」の発信ボタン、report-link.js の緊急連絡先、admin.js のシフト操作の「入店の位置」）はブラウザで確かめる。
// ここでは画面が頼る API の応答を確かめる
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const pub = {
  get: async (path) => { const r = await fetch(`${BASE}/api/public/report/${path}`); return { status: r.status, data: await r.json().catch(() => null) } },
  post: async (token, body) => {
    const r = await fetch(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => null) }
  },
}

const PFX = 'SC' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで入店できるようにする（テストのみ）

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: cl.client_id }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
// 東京駅付近
const SITE = { lat: 35.681236, lng: 139.767125 }
const site = must(await admin.post('/api/admin/sites', { client_id: cl.client_id, site_name: `${PFX}-会場`, lat: SITE.lat, lng: SITE.lng }), 'site')
let slotSeq = 0
// 開催場所つきの枠を作り、スタッフを割り当てる（開始時刻を1分ずつずらして枠を見分ける）
async function siteShift(staffId, siteId) {
  const start = `00:${String(++slotSeq).padStart(2, '0')}`
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, site_id: siteId, dates: [today], start_time: start, end_time: '23:30', roles: [{ role_name: '販売', headcount: 1 }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${today}&to=${today}&project_ids=${pid}`), 'board')
  const role = b.slots.filter(s => s.start_time === start).pop().roles[0].slot_role_id
  must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [staffId], force: true }), 'assign')
  const s = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.staff_id === staffId && x.start_time === start)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}

// ---------- #173 会社の緊急連絡先の設定 ----------
{
  const g = must(await admin.get('/api/admin/settings/site-contact'), 'get settings')
  ok('#277 距離の基準の既定は 500m', g.far_threshold_m === 500 && g.min_threshold_m === 100, g)
  const bad = await admin.put('/api/admin/settings/site-contact', { emergency_phone: 'abc-tel', emergency_note: '', far_threshold_m: 500 })
  ok('#173 数字でない電話番号は 400', bad.status === 400, bad)
  const bad2 = await admin.put('/api/admin/settings/site-contact', { emergency_phone: '03-1234-5678', emergency_note: 'あ'.repeat(101), far_threshold_m: 500 })
  ok('#173 補足が100文字を超えると 400', bad2.status === 400, bad2)
  const bad3 = await admin.put('/api/admin/settings/site-contact', { emergency_phone: '03-1234-5678', emergency_note: '', far_threshold_m: 50 })
  ok('#277 基準が 100m 未満（0 以外）は 400', bad3.status === 400, bad3)
  const before = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
  const r = await admin.put('/api/admin/settings/site-contact', { emergency_phone: '０３－１２３４－５６７８', emergency_note: ' 7:00〜22:00 ', far_threshold_m: 300 })
  ok('#173 全角の電話番号は半角にして保存する', r.status === 200 && r.data.emergency_phone === '03-1234-5678' && r.data.emergency_note === '7:00〜22:00', r)
  const g2 = must(await admin.get('/api/admin/settings/site-contact'), 'get settings 2')
  ok('#173 保存した連絡先と基準を返す', g2.emergency_phone === '03-1234-5678' && g2.far_threshold_m === 300, g2)
  const after = must(await admin.get('/api/admin/settings/lateness'), 'lateness 2')
  ok('#277 基準の保存でほかの会社設定（遅刻の猶予）は変わらない', after.grace_minutes === before.grace_minutes, { before, after })
}

const A = await newStaff('A')
const st = client(await login('sample', `${PFX}A`))

// ---------- #173 スタッフアプリの緊急連絡先 ----------
{
  const r = await st.get('/api/staff/emergency-contacts')
  ok('#173 スタッフに所属の会社の緊急連絡先を返す', r.status === 200 && r.data.contacts.length >= 1 && r.data.contacts[0].phone === '03-1234-5678' && r.data.contacts[0].note === '7:00〜22:00' && r.data.contacts[0].company_name, r)
}

// ---------- #277 入店の位置と現場の距離 ----------
{
  // 現場から北へ約1km
  const s1 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s1, report_type: 'check_in', latitude: SITE.lat + 0.009, longitude: SITE.lng })
  ok('#277 現場から離れた入店は far と距離を返す', r.status === 200 && r.data.far === true && r.data.distance_m > 900 && r.data.distance_m < 1100, r)
  const loc = must(await admin.get(`/api/admin/shifts/${s1}/check-in-location`), 'loc1')
  ok('#277 管理者のシフト操作に距離と位置ずれを返す', loc.check_in && loc.check_in.far === true && loc.check_in.distance_m === r.data.distance_m && loc.threshold_m === 300 && loc.site_position === 'site', loc)
}
{
  // 現場の近く（約20m）
  const s2 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s2, report_type: 'check_in', latitude: SITE.lat + 0.0002, longitude: SITE.lng })
  ok('#277 現場の近くの入店は far にならない', r.status === 200 && r.data.far === false && r.data.distance_m < 50, r)
  ok('#277 遅刻の判定（status）は従来どおり', r.data.status === 'late' || r.data.status === 'normal', r)
}
{
  // 位置を送らない入店は距離なし
  const s3 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s3, report_type: 'check_in', latitude: null, longitude: null })
  ok('#277 位置のない入店は距離なし（no_location の扱いは従来どおり）', r.status === 200 && r.data.distance_m === null && r.data.far === false, r)
  const loc = must(await admin.get(`/api/admin/shifts/${s3}/check-in-location`), 'loc3')
  ok('#277 位置のない入店は管理画面でも距離なし', loc.check_in && loc.check_in.latitude === null && loc.check_in.distance_m === null && loc.check_in.far === false, loc)
}
{
  // 開催場所の位置がない（開催場所なし・案件の位置もなし）
  const s4 = await siteShift(A.staff_id, null)
  const r = await st.post('/api/staff/attendance', { shift_id: s4, report_type: 'check_in', latitude: SITE.lat + 0.05, longitude: SITE.lng })
  ok('#277 現場の位置が未登録なら判定しない', r.status === 200 && r.data.distance_m === null && r.data.far === false, r)
  const loc = must(await admin.get(`/api/admin/shifts/${s4}/check-in-location`), 'loc4')
  ok('#277 現場の位置が未登録なら site_position は null', loc.site_position === null && loc.check_in && loc.check_in.distance_m === null, loc)
  // 退店など入店以外は距離を返さない
  const out = await st.post('/api/staff/attendance', { shift_id: s4, report_type: 'check_out', latitude: SITE.lat + 0.05, longitude: SITE.lng })
  ok('#277 入店以外の報告は距離を計算しない', out.status === 200 && out.data.distance_m === null, out)
}
{
  // 入店の報告がまだないシフト
  const s5 = await siteShift(A.staff_id, site.site_id)
  const loc = must(await admin.get(`/api/admin/shifts/${s5}/check-in-location`), 'loc5')
  ok('#277 入店の報告がなければ check_in は null', loc.check_in === null && loc.site_position === 'site', loc)
  const nf = await admin.get('/api/admin/shifts/99999999/check-in-location')
  ok('#277 存在しないシフトは 404', nf.status === 404, nf)
  const stDenied = await st.get(`/api/admin/shifts/${s5}/check-in-location`)
  ok('#277 スタッフは管理者の距離の API を使えない', stDenied.status === 401 || stDenied.status === 403, stDenied)
  // 報告用URL（ログイン不要）の入店は、管理画面で表示のときに距離を計算する
  const tok = must(await admin.post(`/api/admin/shifts/${s5}/report-link`, {}), 'issue').token
  const c = await pub.get(`${tok}/contact`)
  ok('#173 報告用URLに会社の緊急連絡先を返す', c.status === 200 && c.data.phone === '03-1234-5678' && c.data.note === '7:00〜22:00' && c.data.company_name, c)
  ok('#173 報告用URLの連絡先はシフト・スタッフの情報を返さない', c.data && Object.keys(c.data).sort().join(',') === 'company_name,note,phone', c.data)
  const bad = await pub.get(`${'x'.repeat(30)}/contact`)
  ok('#173 発行されていないURLの連絡先は 404', bad.status === 404, bad)
  const short = await pub.get('abc/contact')
  ok('#173 形式の違うトークンは 404', short.status === 404, short)
  const p = await pub.post(tok, { report_type: 'check_in', latitude: SITE.lat + 0.009, longitude: SITE.lng })
  ok('（前提）報告用URLから入店', p.status === 200, p)
  const loc2 = must(await admin.get(`/api/admin/shifts/${s5}/check-in-location`), 'loc5b')
  ok('#277 報告用URLの入店も管理画面で距離と位置ずれを出す', loc2.check_in && loc2.check_in.entry_method === 'link' && loc2.check_in.far === true && loc2.check_in.distance_m > 900, loc2)
  // 取り消したURLでも連絡先は出す（期限切れ・取り消しの画面で連絡できるように）
  await admin.del(`/api/admin/shifts/${s5}/report-link`)
  const c2 = await pub.get(`${tok}/contact`)
  ok('#173 取り消したURLでも連絡先は返す', c2.status === 200 && c2.data.phone === '03-1234-5678', c2)
}
{
  // 基準 0 は判定しない
  must(await admin.put('/api/admin/settings/site-contact', { emergency_phone: '03-1234-5678', emergency_note: '7:00〜22:00', far_threshold_m: 0 }), 'threshold 0')
  const s6 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s6, report_type: 'check_in', latitude: SITE.lat + 0.009, longitude: SITE.lng })
  ok('#277 基準 0 なら離れていても far にしない（距離は残す）', r.status === 200 && r.data.far === false && r.data.distance_m > 900, r)
}
{
  // 連絡先を消すと、スタッフにも報告用URLにも出さない
  must(await admin.put('/api/admin/settings/site-contact', { emergency_phone: '', emergency_note: '', far_threshold_m: 500 }), 'clear')
  const r = await st.get('/api/staff/emergency-contacts')
  ok('#173 連絡先を消すとスタッフには返さない', r.status === 200 && !r.data.contacts.some(x => x.phone === '03-1234-5678'), r)
  const g = must(await admin.get('/api/admin/settings/site-contact'), 'get settings 3')
  ok('#173 空欄で保存すると未登録に戻る', g.emergency_phone === '' && g.emergency_note === '' && g.far_threshold_m === 500, g)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
