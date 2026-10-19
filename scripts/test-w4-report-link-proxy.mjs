// 報告用URLと代理入力・写真付きの報告の統合テスト（w4-report-link-proxy: #256 #322 #326 #418 #439 #441 #473 #507 #532 #533 #535 #546）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w4-report-link-proxy.mjs
// 画面（report-link.js のボタンの無効化・完了の表示・写真の撮り直し、staff-lifecycle.js の取消・案内文・SMS）はブラウザで確かめる。
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
  const form = async (path, fd) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p), form }
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tomorrow = addDays(today, 1)
const tag = Date.now().toString(36).slice(-5)
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))

// 報告用URL（ログイン不要）
const pub = {
  get: async (token) => { const r = await fetch(`${BASE}/api/public/report/${token}`); return { status: r.status, data: await r.json().catch(() => null) } },
  post: async (token, body, headers = {}) => {
    const r = await fetch(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => null) }
  },
  form: async (token, fd, headers = {}) => {
    const r = await fetch(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', headers, body: fd })
    return { status: r.status, data: await r.json().catch(() => null) }
  },
}

const admin = client(await login('sample', 'admin'))
const st9 = client(await login('sample', 'st009'))   // staff_id 9
async function createShift(staff_id, project_id, work_date, start_time, end_time, extra = {}) {
  const memo = `W4RLP-${tag}-${Math.random().toString(36).slice(2, 7)}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, force: true, ...extra })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const s = (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
async function issue(shiftId) {
  const r = await admin.post(`/api/admin/shifts/${shiftId}/report-link`, {})
  if (r.status !== 200) throw new Error('issue ' + JSON.stringify(r.data))
  return r.data.token
}

await admin.post('/api/admin/settings/photo-required', { enabled: true })
await admin.post('/api/admin/settings/photo-skip', { enabled: false })

// ---------- #326 役割・注意事項・場所。#256 #439 受付の時間帯を返す ----------
const proj = await admin.post('/api/admin/projects', { project_name: `W4RLP案件${tag}`, location: '渋谷店', manual_text: '黒の上下で来てください\n名札を持参', allow_duplicate: true })
ok('（前提）注意事項つきの案件を作成', proj.status === 200 && proj.data.project_id, proj)
const P = proj.data.project_id
const S1 = await createShift(10, P, today, '00:01', '23:30', { role: '設営スタッフ' })
const T1 = await issue(S1)
{
  const g = await pub.get(T1)
  ok('#326 報告用URLが役割を返す', g.status === 200 && g.data.shift.role === '設営スタッフ', g.data && g.data.shift)
  ok('#326 報告用URLが案件の注意事項（manual_text）を返す', g.data.manual_text === '黒の上下で来てください\n名札を持参', g.data.manual_text)
  ok('#326 開催場所の項目（site_name・site_address）を返す（未設定なら null）', 'site_address' in g.data.shift && 'site_lat' in g.data.shift, g.data.shift)
  ok('#439 報告ごとの受付の時間帯（windows。00:01 開始なら前日 18:01 から）とサーバーの日時（now）を返す', g.data.windows && g.data.windows.check_in && g.data.windows.check_in.start === `${addDays(today, -1)} 18:01:00` && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(g.data.now), { windows: g.data.windows, now: g.data.now })
  ok('#134 承認待ちの打刻修正がある報告（pending_types）を返す', Array.isArray(g.data.pending_types), g.data.pending_types)
  ok('#535 写真なしの報告の可否と理由の選択肢を返す（既定は許可しない）', g.data.photo_skip_allowed === false && g.data.no_photo_reasons && g.data.no_photo_reasons.prohibited, g.data)
  ok('報告用URLは金額を返さない', !JSON.stringify(g.data).includes('unit_price'), Object.keys(g.data))
}

// ---------- #535 写真なしの報告（報告用URL） ----------
{
  const r0 = await pub.post(T1, { report_type: 'check_in' })
  ok('#535 写真必須の入店を写真なしで送ると 400（担当者への連絡を案内する）', r0.status === 400 && /担当者に連絡/.test(r0.data.error), r0)
  const r1 = await pub.post(T1, { report_type: 'check_in', no_photo_reason: 'prohibited' })
  ok('#535 会社が許可していなければ、理由があっても写真なしは受け付けない', r1.status === 400, r1)
  const set = await admin.post('/api/admin/settings/photo-skip', { enabled: true })
  const cur = await admin.get('/api/admin/settings/photo-skip')
  ok('#535 写真なしの報告を会社設定で許可できる', set.status === 200 && cur.data.enabled === true && cur.data.reasons.camera, cur)
  const g = await pub.get(T1)
  ok('#535 許可すると報告用URLの応答も photo_skip_allowed=true', g.data.photo_skip_allowed === true, g.data.photo_skip_allowed)
  const r2 = await pub.post(T1, { report_type: 'check_in', no_photo_reason: 'other' })
  ok('#535 「その他」は補足が必須', r2.status === 400 && /その他/.test(r2.data.error), r2)
  const r3 = await pub.post(T1, { report_type: 'check_in', no_photo_reason: 'xxx' })
  ok('#535 決められていない理由は 400', r3.status === 400, r3)
  // #532 管理者としてログインしている端末からは報告できない
  const asAdmin = await pub.post(T1, { report_type: 'check_in', no_photo_reason: 'prohibited' }, { Cookie: admin.cookie })
  ok('#532 管理者のログインがある端末からの報告は 403（代理入力を案内）', asAdmin.status === 403 && /代理入力/.test(asAdmin.data.error), asAdmin)
  const r4 = await pub.post(T1, { report_type: 'check_in', no_photo_reason: 'prohibited', device_id: 'devAAAAAAAA1' }, { 'User-Agent': IPHONE_UA })
  ok('#535 理由を選べば写真なしで入店を報告できる', r4.status === 200, r4)
  const rs = await admin.get(`/api/admin/shifts/${S1}/report-status`)
  const ci = rs.data.reports.find(r => r.report_type === 'check_in')
  ok('#535 報告状況に写真なしの理由が出る', ci && ci.no_photo_reason === '店舗が撮影禁止' && ci.has_photo === false, ci)
  ok('#532 報告状況に端末の要約（OS・ブラウザ）が出て、生の user-agent は返さない', ci && ci.device === 'iPhone・Safari' && !('device_info' in ci) && !('device_id' in ci), ci)
  const ph = await admin.get(`/api/admin/shifts/${S1}/attendance-photos`)
  const pci = ph.data.reports.find(r => r.report_type === 'check_in')
  ok('#535 写真の一覧（勤怠報告の一覧）にも写真なしの理由が出る', pci && pci.no_photo_reason === '店舗が撮影禁止', pci)
  // 別の端末から勤務開始
  const r5 = await pub.post(T1, { report_type: 'work_start', device_id: 'devBBBBBBBB2' }, { 'User-Agent': ANDROID_UA })
  ok('（前提）別の端末から勤務開始', r5.status === 200, r5)
  const rs2 = await admin.get(`/api/admin/shifts/${S1}/report-status`)
  ok('#532 1つのURLで2台の端末から報告されたら link_devices.count=2 と要約を返す', rs2.data.link_devices.count === 2 && rs2.data.link_devices.summaries.includes('Android・Chrome'), rs2.data.link_devices)
  // 端末IDのない報告（端末IDを記録する前の画面から）は、同じ user-agent の端末とみなし、3台目と数えない
  const r6 = await pub.post(T1, { report_type: 'break_start' }, { 'User-Agent': IPHONE_UA })
  const rs3 = await admin.get(`/api/admin/shifts/${S1}/report-status`)
  ok('#532 端末IDのない報告は、同じ user-agent の端末IDがあれば同じ端末として数える', r6.status === 200 && rs3.data.link_devices.count === 2, { r6, ld: rs3.data.link_devices })
  await admin.post('/api/admin/settings/photo-skip', { enabled: false })
}

// ---------- #533 壊れた multipart は 400、二度目の写真付き報告は 409 ----------
{
  const r = await fetch(`${BASE}/api/public/report/${T1}/attendance`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' }, body: '--xyz\r\nbroken' })
  ok('#533 壊れた multipart は 500 にせず 400', r.status === 400, r.status)
  const fd = () => { const f = new FormData(); f.append('report_type', 'check_in'); f.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png'); return f }
  const again = await pub.form(T1, fd())
  ok('#533 報告済みの入店に写真付きで送ると 409（写真は記録に紐づかないので消す）', again.status === 409, again)
}

// ---------- #418 写真のファイルの日時・選び方（アプリ） ----------
const S2 = await createShift(9, P, today, '00:01', '23:30')
{
  const f = new FormData(); f.append('shift_id', String(S2)); f.append('report_type', 'check_in')
  f.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png')
  f.append('photo_taken_at', String(Date.now() - 3 * 3600 * 1000)); f.append('photo_source', 'album')
  const up = await st9.form('/api/staff/attendance-photo', f)
  ok('（前提）アプリの入店（3時間前のファイルの写真・アルバム）', up.status === 200, up)
  const rs = await admin.get(`/api/admin/shifts/${S2}/report-status`)
  const ci = rs.data.reports.find(r => r.report_type === 'check_in')
  ok('#418 写真のファイルの日時と選び方が残り、報告と30分以上ずれていれば photo_stale', ci && ci.photo_stale === true && ci.photo_source === 'album' && ci.photo_taken_at, ci)
  const ph = await admin.get(`/api/admin/shifts/${S2}/attendance-photos`)
  const pci = ph.data.reports.find(r => r.report_type === 'check_in')
  ok('#418 写真の一覧にも photo_stale・photo_source が出る', pci && pci.photo_stale === true && pci.photo_source === 'album', pci)
}

// ---------- #535 アプリの写真なしの報告 ----------
{
  const o1 = await st9.get(`/api/staff/photo-options?shift_id=${S2}`)
  ok('#535 アプリ: 写真なしの報告の可否を返す（許可していない）', o1.status === 200 && o1.data.skip_allowed === false && o1.data.reasons.camera, o1)
  const n1 = await st9.post('/api/staff/attendance', { shift_id: S2, report_type: 'check_out', no_photo_reason: 'camera' })
  ok('#535 アプリ: 許可していなければ写真なしの退店は 400', n1.status === 400, n1)
  await admin.post('/api/admin/settings/photo-skip', { enabled: true })
  const o2 = await st9.get(`/api/staff/photo-options?shift_id=${S2}`)
  ok('#535 アプリ: 許可すると skip_allowed=true', o2.data.skip_allowed === true, o2)
  const n2 = await st9.post('/api/staff/attendance', { shift_id: S2, report_type: 'check_out', no_photo_reason: 'camera', address: 'x'.repeat(500) })
  ok('#535 アプリ: 理由つきで写真なしの退店を報告できる（長い住所も受け付けて切る。#521）', n2.status === 200, n2)
  const rs = await admin.get(`/api/admin/shifts/${S2}/report-status`)
  const co = rs.data.reports.find(r => r.report_type === 'check_out')
  ok('#535 アプリの写真なしの理由も報告状況に出る', co && co.no_photo_reason === 'カメラが使えない', co)
  await admin.post('/api/admin/settings/photo-skip', { enabled: false })
}

// ---------- #322 代理入力の取消。#441 #507 案内文・SMS の情報。#473 例外を除いた日報の設定 ----------
const S3 = await createShift(10, P, today, '00:01', '23:30')
{
  const px = await admin.post(`/api/admin/shifts/${S3}/proxy-attendance`, { report_types: ['wake_up'], times: { wake_up: '00:00' } })
  ok('（前提）代理入力（起床）', px.status === 200, px)
  const rs = await admin.get(`/api/admin/shifts/${S3}/report-status`)
  ok('#322 報告状況が確定済みかどうか（settled）を返す', rs.data.settled === false, rs.data.settled)
  ok('#322 代理入力の行は entry_method=proxy で、端末の要約は空', rs.data.reports.some(r => r.report_type === 'wake_up' && r.entry_method === 'proxy' && r.device === ''), rs.data.reports)
  const del = await admin.del(`/api/admin/shifts/${S3}/proxy-attendance/wake_up`)
  ok('#322 代理入力を取り消せる', del.status === 200 && del.data.deleted === 1, del)
  ok('#441 #507 案内文・SMS 用に会社名・案件名・電話番号を返す', rs.data.company_name && rs.data.project_name === `W4RLP案件${tag}` && 'staff_phone' in rs.data && 'place' in rs.data, { c: rs.data.company_name, p: rs.data.project_name, ph: rs.data.staff_phone })
  ok('#473 例外を除いた日報の設定（inherited_daily_report_mode）を返す', rs.data.inherited_daily_report_mode === 'required', rs.data.inherited_daily_report_mode)
  await admin.put(`/api/admin/shifts/${S3}/report-settings`, { attendance_mode: '', daily_report_mode: 'none' })
  const rs2 = await admin.get(`/api/admin/shifts/${S3}/report-status`)
  ok('#473 シフトの例外で日報なしにしても、例外を除いた値は日報あり', rs2.data.modes.daily_report_mode === 'none' && rs2.data.inherited_daily_report_mode === 'required', { m: rs2.data.modes.daily_report_mode, i: rs2.data.inherited_daily_report_mode })
}

// ---------- #256 0時台に始まるシフトは前日の夜から報告できる ----------
{
  const S4 = await createShift(10, P, tomorrow, '00:30', '05:00')
  const T4 = await issue(S4)
  const g = await pub.get(T4)
  ok('#256 0:30 開始のシフトは、前日の 18:30 から起床・出発・入店を受け付ける', g.status === 200 && g.data.windows.wake_up.start === `${today} 18:30:00` && g.data.windows.check_in.start === `${today} 18:30:00`, g.data && g.data.windows)
  const now = jstNow()
  const r = await pub.post(T4, { report_type: 'wake_up' })
  if (now >= `${today} 18:30:00`) ok('#256 前日の 18:30 以降なら、前日のうちに起床を報告できる', r.status === 200, r)
  else ok('#256 前日の 18:30 より前は「18:30 から報告できます」と返す', r.status === 400 && /18:30 から報告できます/.test(r.data.error), r)
  const rs = await admin.get(`/api/admin/shifts/${S4}/report-status`)
  ok('#256 代理入力も同じ時間帯から受け付ける', now >= `${today} 18:30:00` ? rs.data.proxy_blocked === null : rs.data.proxy_blocked === '稼働日より前', { now, b: rs.data.proxy_blocked })
  const S5 = await createShift(10, P, tomorrow, '10:00', '19:00')
  const T5 = await issue(S5)
  const g5 = await pub.get(T5)
  ok('#256 6:00 以降に始まるシフトは、これまでどおり稼働日の 0:00 から', g5.data.windows.wake_up.start === `${tomorrow} 00:00:00`, g5.data.windows)
  const r5 = await pub.post(T5, { report_type: 'wake_up' })
  ok('#439 受付の前の報告は 400（画面ではボタンを押せなくする）', r5.status === 400 && /から報告できます/.test(r5.data.error), r5)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
