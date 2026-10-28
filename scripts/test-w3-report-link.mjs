// 報告用URLと勤怠報告の写真の統合テスト（w3-report-link: #129 #199 #217 #440）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w3-report-link.mjs
// 画面（report-link.js の再読み込み・送信中の表示・日報の下書き）はブラウザで確かめる。ここでは画面が頼る API の応答を確かめる
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`) }

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
  const raw = async (path) => { const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } }); const buf = await r.arrayBuffer(); return { status: r.status, type: r.headers.get('content-type') || '', size: buf.byteLength } }
  const form = async (path, fd) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), raw, form }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const tag = Date.now().toString(36).slice(-5)
// 1x1 の PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))
const photoForm = (type, shiftId) => { const fd = new FormData(); if (shiftId) fd.append('shift_id', String(shiftId)); fd.append('report_type', type); fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png'); return fd }

async function createShift(admin, staff_id, project_id, memo) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date: today, start_time: '00:01', end_time: '23:30', memo, force: true })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const s = (await admin.get(`/api/admin/shifts?from=${today}&to=${today}`)).data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}

const admin = client(await login('sample', 'admin'))
const st9 = client(await login('sample', 'st009'))   // staff_id 9
const st10 = client(await login('sample', 'st010')) // staff_id 10（同じ会社の別のスタッフ）
await admin.post('/api/admin/settings/photo-required', { enabled: true })

// ---------- #217 アプリの入店（写真つき） → 本人だけが写真を取得でき、管理者は自社のシフトの報告として取得できる ----------
const S1 = await createShift(admin, 9, 1, 'W3RL-S1-' + tag)
const up = await st9.form('/api/staff/attendance-photo', photoForm('check_in', S1))
ok('（前提）アプリの入店報告（写真つき）', up.status === 200 && up.data.photo_key, up)
const key = up.data && up.data.photo_key
{
  const mine = await st9.raw('/api/staff/attendance-photo/' + key)
  ok('#217 本人は自分の写真を取得できる', mine.status === 200 && mine.size > 0, mine)
  const other = await st10.raw('/api/staff/attendance-photo/' + key)
  ok('#217 同じ会社の別のスタッフは他人の写真を取得できない（404）', other.status === 404, other)
  const byAdmin = await admin.raw('/api/staff/attendance-photo/' + key)
  ok('#217 スタッフ用の取得 API は管理者のセッションでは使えない（403）', byAdmin.status === 403, byAdmin)
  const unknown = await st9.raw('/api/staff/attendance-photo/attendance/1/9/0/none.jpg')
  ok('#217 記録にないキーは 404', unknown.status === 404, unknown)
}
{
  const list = await admin.get(`/api/admin/shifts?from=${today}&to=${today}`)
  const row = list.data.shifts.find(x => x.shift_id === S1)
  ok('#217 シフト一覧に写真の件数（photo_count）が付く', row && Number(row.photo_count) === 1, row)
  const ph = await admin.get(`/api/admin/shifts/${S1}/attendance-photos`)
  const ci = ph.data && ph.data.reports.find(r => r.report_type === 'check_in')
  ok('#217 シフトの勤怠報告の一覧に写真の有無と報告ID（キーは返さない）', ph.status === 200 && ci && ci.has_photo === true && ci.attendance_id && !('photo_key' in ci), ph)
  const img = await admin.raw(`/api/admin/attendance-photo/${ci.attendance_id}`)
  ok('#217 管理者は自社のシフトの写真を取得できる', img.status === 200 && /image\//.test(img.type) && img.size > 0, img)
  const none = await admin.raw(`/api/admin/attendance-photo/999999`)
  ok('#217 存在しない報告は 404', none.status === 404, none)
  const byStaff = await st9.raw(`/api/admin/attendance-photo/${ci.attendance_id}`)
  ok('#217 管理者用の取得 API はスタッフのセッションでは使えない（403）', byStaff.status === 403, byStaff)

  // 他社の管理者は取得できない
  const hq = client(await login('sample', 'hq'))
  const codeB = 'rl' + tag, pwB = 'Rl-Passw0rd-' + tag
  const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `報告URL確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
  ok('（前提）B 社を作成', cr.status === 200, cr)
  const adminB = client(await login(codeB, 'adminb', pwB))
  const imgB = await adminB.raw(`/api/admin/attendance-photo/${ci.attendance_id}`)
  ok('#217 他社の管理者は写真を取得できない（404）', imgB.status === 404, imgB)
  const listB = await adminB.get(`/api/admin/shifts/${S1}/attendance-photos`)
  ok('#217 他社のシフトの報告一覧は取得できない（404）', listB.status === 404, listB)
}

// ---------- #217 報告用URLの入店（写真つき）も管理画面で見られる。#129 無効なURLだけが 404 ----------
const S2 = await createShift(admin, 10, 1, 'W3RL-S2-' + tag)
const link = await admin.post(`/api/admin/shifts/${S2}/report-link`, {})
ok('（前提）報告用URLの発行', link.status === 200 && link.data.token, link)
const token = link.data && link.data.token
{
  const g = await fetch(`${BASE}/api/public/report/${token}`)
  ok('#129 有効なURLは 200', g.status === 200)
  const bad = await fetch(`${BASE}/api/public/report/${'x'.repeat(30)}`)
  ok('#129 無効なURLは 404（画面は 404 のときだけ「新しいURLを依頼」を出す）', bad.status === 404)
  const fd = photoForm('check_in')
  const r = await fetch(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', body: fd })
  ok('（前提）報告用URLから入店（写真つき）', r.status === 200, await r.json().catch(() => null))
  const again = await fetch(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', body: photoForm('check_in') })
  ok('#199 二度目の入店は登録されない（画面は届いたかを読み直して確かめる）', again.status >= 400)
  const ph = await admin.get(`/api/admin/shifts/${S2}/attendance-photos`)
  const rows = (ph.data && ph.data.reports || []).filter(x => x.report_type === 'check_in')
  ok('#199 入店の報告は 1 件だけ', rows.length === 1, ph.data)
  ok('#217 報告用URLの写真も一覧に出る（entry_method=link）', rows[0] && rows[0].has_photo && rows[0].entry_method === 'link', rows)
  const img = await admin.raw(`/api/admin/attendance-photo/${rows[0].attendance_id}`)
  ok('#217 報告用URLの写真を管理者が取得できる', img.status === 200 && img.size > 0, img)
  const pub = await fetch(`${BASE}/api/public/report/${token}`).then(x => x.json())
  ok('#129 送信の後に読み直すと報告済みが返る', pub.reports.some(x => x.report_type === 'check_in'), pub.reports)
}

await admin.post('/api/admin/settings/photo-required', { enabled: true })
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
