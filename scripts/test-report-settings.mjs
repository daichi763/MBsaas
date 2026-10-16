// 案件報告管理（docs/spec_attendance_correction.md 2章・3章）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh でローカルの D1 を作り直し、`wrangler dev` で起動していること（手順はスクリプトの冒頭）
// 実行: node scripts/test-report-settings.mjs   （BASE=http://127.0.0.1:8799 で接続先を変更）
// テストのたびに DB を作り直すこと（シフト・設定を追加するため、2 回目は結果が変わる）
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`) }

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
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
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const ALL = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']

async function createShift(admin, staff_id, project_id, work_date, memo, extra = {}) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: extra.start_time || '00:01', end_time: extra.end_time || '23:30', memo, unit_price: extra.unit_price })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const list = await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)
  const s = list.data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
async function settlementRow(admin, shiftId, date) {
  const r = await admin.get(`/api/admin/settlement?from=${date}&to=${date}`)
  return (r.data.rows || []).find(x => x.shift_id === shiftId)
}
async function staffSettings(admin, projectId, staffId) {
  const r = await admin.get(`/api/admin/report-settings/projects/${projectId}`)
  return (r.data.staff || []).find(s => s.staff_id === staffId)
}

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001')) // staff_id 1
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）

// ---------- 1. 導入時の移行 ----------
{
  const p2 = await admin.get('/api/admin/report-settings/projects/2')
  ok('移行: 「入店・退店のみ」の案件は入店・退店だけ ON', p2.data.defaults && ALL.every(t => p2.data.defaults[t] === (t === 'check_in' || t === 'check_out' ? 1 : 0)), p2.data.defaults)
  const p1 = await admin.get('/api/admin/report-settings/projects/1')
  ok('移行: 既定（full）の案件は 8 種類すべて ON', ALL.every(t => p1.data.defaults[t] === 1), p1.data.defaults)
  const s1 = p1.data.staff.find(s => s.staff_id === 1), s2 = p1.data.staff.find(s => s.staff_id === 2)
  ok('移行: 既存スタッフは 8 種類すべて ON', s1 && ALL.every(t => s1.settings[t] === 1), s1)
  ok('移行: スタッフ単位で「報告なし」だったスタッフはすべて OFF（明示的な設定を維持）', s2 && ALL.every(t => s2.settings[t] === 0), s2)
  const logs = await admin.get('/api/admin/report-settings/logs?project_id=1&limit=500')
  ok('移行: 設定変更履歴に移行の記録がある', logs.data.logs.some(l => l.action === 'migration'), logs.data.logs.length)
  const mig = logs.data.logs.find(l => l.action === 'migration')
  ok('移行: 履歴の日時は日本時間（アプリの記録と同じ）', mig && Math.abs(Date.parse(mig.created_at.replace(' ', 'T') + 'Z') - Date.parse(jstNow())) < 30 * 60000, mig && mig.created_at)
}

// ---------- 2. スタッフ画面: 8 種類・順序・OFF の非表示 ----------
const homeShift = await createShift(admin, 1, 1, today, 'RS-TEST-HOME')
{
  const home = await st1.get('/api/staff/home')
  ok('ホーム: 今日のシフトに 8 種類が順に表示される', home.data.shift && home.data.shift.shift_id === homeShift && JSON.stringify(home.data.required_attendance) === JSON.stringify(ALL), home.data.required_attendance)
  // 前の報告を飛ばして後の報告を押せること・後の報告の後に前の報告を押せないことは scripts/test-w2-attendance-report.mjs（#47）
  const bad = await st1.post('/api/staff/attendance', { shift_id: homeShift, report_type: 'nap' })
  ok('不正な報告種別は 400', bad.status === 400, bad)
  const w = await st1.post('/api/staff/attendance', { shift_id: homeShift, report_type: 'wake_up' })
  ok('起床報告は成功', w.status === 200, w)
  const dup = await st1.post('/api/staff/attendance', { shift_id: homeShift, report_type: 'wake_up' })
  ok('二重送信は 409', dup.status === 409, dup)

  // 起床（報告済み）・出発・入店を OFF → 順序から外れ、勤務開始を報告できる
  const off = await admin.put(`/api/admin/report-settings/projects/1/staff/1`, { settings: { wake_up: false, departure: false, check_in: false } })
  ok('個別変更: OFF にできる', off.status === 200 && off.data.staff_changed === 1, off)
  const home2 = await st1.get('/api/staff/home')
  ok('OFF の報告はスタッフ画面に表示されない（保存後すぐ反映）', JSON.stringify(home2.data.required_attendance) === JSON.stringify(ALL.slice(3)), home2.data.required_attendance)
  const offPost = await st1.post('/api/staff/attendance', { shift_id: homeShift, report_type: 'departure' })
  ok('OFF の報告は API でも受け付けない', offPost.status === 400 && /不要/.test(offPost.data.error), offPost)
  const status = await admin.get(`/api/admin/shifts/${homeShift}/report-status`)
  ok('OFF にしても登録済みの報告（起床）は残る', status.data.reports.some(r => r.report_type === 'wake_up'), status.data.reports)
  const ws = await st1.post('/api/staff/attendance', { shift_id: homeShift, report_type: 'work_start' })
  ok('OFF の報告を順序から外して勤務開始を報告できる', ws.status === 200, ws)
  for (const t of ['break_start', 'break_end', 'work_end']) {
    const r = await st1.post('/api/staff/attendance', { shift_id: homeShift, report_type: t })
    ok(`${t} を報告できる`, r.status === 200, r)
  }
  const row = await settlementRow(admin, homeShift, today)
  const hm = jstNow().slice(11, 16)
  ok('集計: 勤務開始・勤務終了から実績が入る（入店・退店なし）', row && row.actual_start && row.actual_end && row.actual_start <= hm, row && { a: row.actual_start, b: row.actual_end })
  ok('集計: 休憩入・休憩出から実績の休憩が入る', row && row.actual_break_minutes === 0, row && row.actual_break_minutes)
}

// ---------- 3. 案件ごとに独立 ----------
{
  await createShift(admin, 1, 3, addDays(today, 3), 'RS-TEST-P3')
  const s = await staffSettings(admin, 3, 1)
  ok('同じスタッフでも別の案件の設定は変わらない', s && ALL.every(t => s.settings[t] === 1), s)
  const s1 = await staffSettings(admin, 1, 1)
  ok('案件1 の個別設定は保持（起床・出発・入店 OFF）', s1 && s1.settings.wake_up === 0 && s1.settings.departure === 0 && s1.settings.check_in === 0 && s1.settings.work_start === 1 && s1.individual, s1)
}

// ---------- 4. 標準設定の変更は新しく所属するスタッフにだけ効く ----------
let p4members
{
  const before = await admin.get('/api/admin/report-settings/projects/4')
  p4members = before.data.staff.map(s => s.staff_id)
  const r = await admin.put('/api/admin/report-settings/projects/4/default', { settings: { wake_up: false } })
  ok('標準設定を変更できる', r.status === 200 && r.data.changed === 1, r)
  const after = await admin.get('/api/admin/report-settings/projects/4')
  ok('既存の所属スタッフの設定は変わらない', after.data.staff.length > 0 && after.data.staff.every(s => s.settings.wake_up === 1), after.data.staff.map(s => [s.staff_id, s.settings.wake_up]))
  const newcomer = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].find(id => !p4members.includes(id))
  await createShift(admin, newcomer, 4, addDays(today, 5), 'RS-TEST-NEW')
  const s = await staffSettings(admin, 4, newcomer)
  ok('新しく所属したスタッフは変更後の標準設定を引き継ぐ', s && s.settings.wake_up === 0 && s.settings.departure === 1 && !s.individual, s)
}

// ---------- 5. 一括変更 ----------
{
  const [m1, m2] = p4members
  const body = { report_types: ['departure'], enabled: false, staff_ids: [m1, m2] }
  const dry = await admin.post('/api/admin/report-settings/projects/4/bulk', { ...body, dry_run: true })
  ok('一括変更: 確認で対象人数・変更前後を返す', dry.status === 200 && dry.data.target_count === 2 && dry.data.changed_count === 2 && dry.data.rows.every(r => r.before.departure === 1 && r.after.departure === 0) && dry.data.confirm_token, dry.data)
  const noToken = await admin.post('/api/admin/report-settings/projects/4/bulk', body)
  ok('一括変更: 確認なしの保存は 409', noToken.status === 409 && noToken.data.need_confirm, noToken)
  const save = await admin.post('/api/admin/report-settings/projects/4/bulk', { ...body, confirm_token: dry.data.confirm_token })
  ok('一括変更: 保存できる', save.status === 200 && save.data.staff_changed === 2, save)
  const again = await admin.post('/api/admin/report-settings/projects/4/bulk', { ...body, confirm_token: dry.data.confirm_token })
  ok('一括変更: 同じ確認での二重送信は 409', again.status === 409, again)
  const s1 = await staffSettings(admin, 4, m1), s2 = await staffSettings(admin, 4, m2)
  ok('一括変更: 対象者の個別設定が上書きされる', s1.settings.departure === 0 && s2.settings.departure === 0, [s1.settings, s2.settings])
  await admin.put(`/api/admin/report-settings/projects/4/staff/${m1}`, { settings: { departure: true } })
  const s1b = await staffSettings(admin, 4, m1), s2b = await staffSettings(admin, 4, m2)
  ok('一括変更の後に個別に変えた値は保持される', s1b.settings.departure === 1 && s2b.settings.departure === 0, [s1b.settings.departure, s2b.settings.departure])
  const bad = await admin.post('/api/admin/report-settings/projects/4/bulk', { ...body, staff_ids: [m1, 99999], dry_run: true })
  ok('一括変更: 所属していないスタッフを含むと 400', bad.status === 400, bad)
}

// ---------- 6. 変更履歴 ----------
{
  const logs = await admin.get('/api/admin/report-settings/logs?project_id=4&limit=500')
  const acts = new Set(logs.data.logs.map(l => l.action))
  ok('履歴: 標準設定・一括・個別の変更が記録される', acts.has('project_default') && acts.has('bulk') && acts.has('individual'), [...acts])
  const bulkLogs = logs.data.logs.filter(l => l.action === 'bulk')
  ok('履歴: 変更前後・変更者・一括の識別子が残る', bulkLogs.length === 2 && bulkLogs.every(l => l.old_enabled === 1 && l.new_enabled === 0 && l.changed_by_name && l.batch_id && l.batch_id === bulkLogs[0].batch_id), bulkLogs)
  const def = logs.data.logs.find(l => l.action === 'project_default')
  ok('履歴: 標準設定の変更は対象が「標準設定」（staff_id なし）', def && def.staff_id === null && def.report_type === 'wake_up', def)
}

// ---------- 7. 集計: 勤務開始・終了を優先 / 休憩 / 入店・退店のみ / 確定済み ----------
{
  const d = addDays(today, -1)
  const proxy = (id, t, time) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: [t], time })
  const a = await createShift(admin, 5, 1, d, 'RS-TEST-AGG-A', { start_time: '10:00', end_time: '19:00' })
  for (const [t, tm] of [['check_in', '09:50'], ['work_start', '10:00'], ['break_start', '12:00'], ['break_end', '12:45'], ['work_end', '18:00'], ['check_out', '18:10']]) await proxy(a, t, tm)
  let r = await settlementRow(admin, a, d)
  ok('集計: 勤務開始・終了があればそちらを使う（入店・退店より優先）', r && r.actual_start === '10:00' && r.actual_end === '18:00', r && [r.actual_start, r.actual_end])
  ok('集計: 休憩入・休憩出の差が実績の休憩になる（45分）', r && r.actual_break_minutes === 45 && r.actual_hours === 7.25, r && [r.actual_break_minutes, r.actual_hours])
  const b = await createShift(admin, 6, 1, d, 'RS-TEST-AGG-B', { start_time: '10:00', end_time: '19:00' })
  await proxy(b, 'check_in', '09:55'); await proxy(b, 'check_out', '19:05')
  r = await settlementRow(admin, b, d)
  ok('集計: 勤務開始・終了がなければ従来どおり入店・退店', r && r.actual_start === '09:55' && r.actual_end === '19:05' && r.actual_break_minutes == null, r && [r.actual_start, r.actual_end, r.actual_break_minutes])
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [b], force: true })
  ok('確定できる', cf.status === 200 && cf.data.confirmed === 1, cf)
  await proxy(b, 'work_start', '11:00'); await proxy(b, 'work_end', '15:00')
  r = await settlementRow(admin, b, d)
  ok('集計: 確定済みのシフトは実績を変えない（既存の規則）', r && r.actual_start === '09:55' && r.actual_end === '19:05', r && [r.actual_start, r.actual_end])
  // 日をまたぐ勤務
  const n = await createShift(admin, 7, 1, d, 'RS-TEST-NIGHT', { start_time: '22:00', end_time: '06:00' })
  await proxy(n, 'work_start', '22:00')
  const nn = await admin.post(`/api/admin/shifts/${n}/proxy-attendance`, { report_types: ['work_end'], time: '05:30' })
  r = await settlementRow(admin, n, d)
  ok('集計: 日をまたぐ勤務（22:00〜翌05:30）', nn.status === 200 && r && r.actual_start === '22:00' && r.actual_end === '05:30' && r.actual_hours != null && r.actual_hours > 0, r && [r.actual_start, r.actual_end, r.actual_hours])
}

// ---------- 8. 報告用URL（ログイン不要）----------
{
  const s = await createShift(admin, 8, 3, today, 'RS-TEST-LINK')
  const issued = await admin.post(`/api/admin/shifts/${s}/report-link`, {})
  const st = await admin.get(`/api/admin/shifts/${s}/report-status`)
  const token = st.data.token && st.data.token.token
  ok('報告URL: 発行できる', issued.status === 200 && token, issued)
  const pub = await fetch(`${BASE}/api/public/report/${token}`).then(r => r.json())
  ok('報告URL: 8 種類が返る', JSON.stringify(pub.modes.required_attendance) === JSON.stringify(ALL), pub.modes)
  const post = (t) => fetch(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report_type: t }) }).then(async r => ({ status: r.status, data: await r.json() }))
  ok('報告URL: 起床報告は成功', (await post('wake_up')).status === 200)
  ok('報告URL: 前の報告を飛ばして勤務開始を報告できる', (await post('work_start')).status === 200)
  const late = await post('departure')
  ok('報告URL: 順序の確認（勤務開始の後に出発報告は 400）', late.status === 400, late)
}

// ---------- 9. 旧来の提出設定 API（互換）----------
{
  const r = await admin.put('/api/admin/projects/5/report-settings', { attendance_mode: 'in_out', daily_report_mode: 'required' })
  const p5 = await admin.get('/api/admin/report-settings/projects/5')
  ok('互換: 案件の提出設定 API（入店・退店のみ）は標準設定に書き込まれる', r.status === 200 && ALL.every(t => p5.data.defaults[t] === (t === 'check_in' || t === 'check_out' ? 1 : 0)), p5.data.defaults)
  const r2 = await admin.put('/api/admin/staff/1/report-settings', { daily_report_mode: '' })
  ok('互換: スタッフの提出設定 API（日報のみ）', r2.status === 200, r2)
  const r3 = await admin.put('/api/admin/projects/5/report-settings', { attendance_mode: 'bogus', daily_report_mode: 'required' })
  ok('互換: 不正な値は 400', r3.status === 400, r3)
}

// ---------- 10. 権限 ----------
{
  const r = await st1.get('/api/admin/report-settings/projects')
  ok('権限: スタッフは案件報告管理 API を使えない（403）', r.status === 403, r)
  const nf = await admin.get('/api/admin/report-settings/projects/99999')
  ok('権限: 存在しない案件は 404（自社以外の案件も同じ判定: company_id で絞り込み）', nf.status === 404, nf)
  const notMember = await admin.put('/api/admin/report-settings/projects/2/staff/99999', { settings: { wake_up: true } })
  ok('権限: 所属していないスタッフの個別変更は 404', notMember.status === 404, notMember)
  const badVal = await admin.put('/api/admin/report-settings/projects/1/staff/1', { settings: { wake_up: 'yes' } })
  ok('入力: 不正な値は 400', badVal.status === 400, badVal)
  const anon = await fetch(`${BASE}/api/admin/report-settings/projects`)
  ok('権限: 未ログインは 401', anon.status === 401, anon.status)
}

// ---------- 11. ダッシュボード ----------
{
  const d = await admin.get('/api/admin/dashboard')
  const s = (d.data.shifts || []).find(x => x.shift_id === homeShift)
  ok('ダッシュボード: 有効な報告と報告済みの種類を返す', s && Array.isArray(s.required_types) && s.required_types[0] === 'work_start' && s.done_types.includes('work_end'), s && [s.required_types, s.done_types])
}

await admin.post('/api/admin/settings/photo-required', { enabled: true })
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
