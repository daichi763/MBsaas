// 案件報告管理の残り（w4-report-settings: #247 #268 #313 #329 #379 #413 #446 #509）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w4-report-settings.mjs
// #267（案件を切り替えたら履歴の絞り込みを戻す）は画面だけの修正のため、ここでは確かめない
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
  const raw = (p) => fetch(`${BASE}${p}`, { headers: { Cookie: cookie } })
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), raw }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const ALL = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']

const PFX = 'RS' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

// ---------- 準備: 案件 1 件・スタッフ 6 人（A〜D は今後のシフト、R は過去のシフトだけで退職、L は休職） ----------
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const names = ['A', 'B', 'C', 'D', 'R', 'L']
for (const n of names) must(await admin.post('/api/admin/staff', { user_code: `${PFX}${n}`, name: `${PFX} ${n}`, password: 'pass1234' }), 'staff ' + n)
const staffAll = must(await admin.get('/api/admin/staff'), 'staff list').staff
const id = Object.fromEntries(names.map(n => [n, staffAll.find(s => s.user_code === `${PFX}${n}`).staff_id]))
async function createShift(staff_id, work_date, memo) {
  must(await admin.post('/api/admin/shifts', { staff_id, project_id: pid, work_date, start_time: '10:00', end_time: '18:00', memo }), 'shift ' + memo)
  const list = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shift list')
  return list.shifts.find(x => x.memo === memo).shift_id
}
const shiftA = await createShift(id.A, addDays(today, 3), `${PFX}-A`)
for (const n of ['B', 'C', 'D', 'L']) await createShift(id[n], addDays(today, 3), `${PFX}-${n}`)
await createShift(id.R, addDays(today, -10), `${PFX}-R`)
// R は退職、L は休職にする
must(await admin.put(`/api/admin/employees/${id.R}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } }), 'retire R')
must(await admin.put(`/api/admin/employees/${id.L}`, { profile: { employment_status: 'leave' } }), 'leave L')

const detail = async () => must(await admin.get(`/api/admin/report-settings/projects/${pid}`), 'detail')
const row = (d, n) => d.staff.find(s => s.staff_id === id[n])

// ---------- #379 在籍状況 ----------
{
  const d = await detail()
  ok('#379 所属スタッフに在籍状況が付く（退職・休職・在籍）', row(d, 'R')?.member_status === 'retired' && row(d, 'L')?.member_status === 'leave' && row(d, 'A')?.member_status === 'active', d.staff.map(s => [s.name, s.member_status]))
  ok('#268 何も変えていない人は『標準』（individual でない）', d.staff.every(s => s.kind === 'none' && !s.individual), d.staff.map(s => [s.name, s.kind]))
  ok('#509 詳細に標準設定の版番号が付く', Number.isInteger(d.defaults_version), d.defaults_version)
}

// ---------- #268 個別の印 ----------
must(await admin.put(`/api/admin/report-settings/projects/${pid}/staff/${id.A}`, { settings: { wake_up: false } }), 'individual A')
let ver = (await detail()).defaults_version
{
  const r = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { departure: false }, version: ver })
  ok('#329 既定（apply なし）の標準設定の保存は今の所属スタッフに当てない', r.status === 200 && r.data.changed === 1 && r.data.applied_staff === 0, r)
  const d = await detail()
  ok('#268 個別に変えた人だけ『個別』', row(d, 'A').kind === 'individual' && row(d, 'A').individual, row(d, 'A'))
  ok('#268 標準設定の変更前に値を固定した人は『標準（引き継ぎ）』で individual でない', row(d, 'B').kind === 'inherited' && !row(d, 'B').individual && row(d, 'B').settings.departure === 1, row(d, 'B'))
  ok('#509 保存で版番号が進む', d.defaults_version === ver + 1, [ver, d.defaults_version])
  ver = d.defaults_version
}

// ---------- #509 楽観ロック ----------
{
  const stale = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { check_in: false }, version: ver - 1 })
  ok('#509 古い版番号の保存は 409 で、値は変わらない', stale.status === 409 && stale.data.conflict && (await detail()).defaults.check_in === 1, stale)
  const bad = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { check_in: false }, version: 'x' })
  ok('#509 版番号が数でなければ 400', bad.status === 400, bad)
  // 変えた項目だけを送れば、ほかの項目（departure は OFF のまま）は戻らない
  const r = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { wake_up: true }, version: ver })
  const d = await detail()
  ok('#509 送らなかった項目は変えない', r.status === 200 && r.data.changed === 0 && d.defaults.departure === 0, { r: r.data, defaults: d.defaults })
}

// ---------- #329 今の所属スタッフにも当てる ----------
{
  ver = (await detail()).defaults_version
  const badApply = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { break_start: false }, version: ver, apply: 'everyone' })
  ok('#329 apply が不正なら 400', badApply.status === 400, badApply)
  const r = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { break_start: false }, version: ver, apply: 'standard' })
  const d = await detail()
  ok('#329 standard: 個別に変えていない在籍中の人に当たる', r.status === 200 && row(d, 'B').settings.break_start === 0 && row(d, 'C').settings.break_start === 0 && row(d, 'L').settings.break_start === 0, { r: r.data, B: row(d, 'B')?.settings })
  ok('#329 standard: 個別に変えた人は変わらない', row(d, 'A').settings.break_start === 1, row(d, 'A').settings)
  ok('#247 #329 standard: 退職者には当てない', row(d, 'R').settings.break_start === 1, row(d, 'R').settings)
  ok('#329 standard: 当てた人は『個別』にならない', row(d, 'B').kind !== 'individual' && !row(d, 'B').individual, row(d, 'B'))
  const r2 = await admin.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: { check_out: false }, version: d.defaults_version, apply: 'all' })
  const d2 = await detail()
  ok('#329 all: 個別に変えた人を含め在籍中の全員に 1 回で当たる', r2.status === 200 && ['A', 'B', 'C', 'D', 'L'].every(n => row(d2, n).settings.check_out === 0), d2.staff.map(s => [s.name, s.settings.check_out]))
  ok('#329 all: 個別に変えた人の、ほかの個別の値は残る', row(d2, 'A').settings.wake_up === 0 && row(d2, 'A').kind === 'individual', row(d2, 'A'))
  ok('#247 all: 退職者には当てない', row(d2, 'R').settings.check_out === 1, row(d2, 'R').settings)
  const logs = must(await admin.get(`/api/admin/report-settings/logs?project_id=${pid}&limit=500`), 'logs').logs
  ok('#329 当てた人ごとに default_apply の履歴が残る', logs.filter(l => l.action === 'default_apply' && l.report_type === 'check_out').length === 5, logs.filter(l => l.action === 'default_apply').length)
}

// ---------- #247 #379 一括変更の対象 ----------
{
  const withRetired = await admin.post(`/api/admin/report-settings/projects/${pid}/bulk`, { report_types: ['work_start'], enabled: false, staff_ids: [id.B, id.R], dry_run: true })
  ok('#247 退職者を含む一括変更は 400', withRetired.status === 400, withRetired)
  const dry = await admin.post(`/api/admin/report-settings/projects/${pid}/bulk`, { report_types: ['work_start'], enabled: false, staff_ids: [id.B, id.C, id.L], dry_run: true })
  ok('#379 休職中の人は一括変更の対象にできる', dry.status === 200 && dry.data.changed_count === 3, dry)
  const save = await admin.post(`/api/admin/report-settings/projects/${pid}/bulk`, { report_types: ['work_start'], enabled: false, staff_ids: [id.B, id.C, id.L], confirm_token: dry.data.confirm_token })
  const d = await detail()
  ok('#247 一括変更が保存され、対象の人だけ変わる', save.status === 200 && save.data.staff_changed === 3 && row(d, 'B').settings.work_start === 0 && row(d, 'D').settings.work_start === 1, save)
  ok('#268 一括変更した人は『個別』', row(d, 'B').kind === 'individual', row(d, 'B'))
}

// ---------- #313 シフト単位の例外 ----------
{
  const r = await admin.put(`/api/admin/shifts/${shiftA}/report-settings`, { attendance_mode: 'in_out', daily_report_mode: null })
  ok('#313 シフトの例外を保存できる', r.status === 200, r)
  const logs = must(await admin.get(`/api/admin/report-settings/logs?project_id=${pid}&staff_id=${id.A}&limit=200`), 'logs').logs
  const so = logs.filter(l => l.action === 'shift_override')
  ok('#313 シフト単位の例外が履歴に残る（shift_id と内容つき）', so.length > 0 && so.every(l => l.shift_id === shiftA && /入店・退店のみ/.test(l.detail || '')), so)
  const same = await admin.put(`/api/admin/shifts/${shiftA}/report-settings`, { attendance_mode: 'in_out', daily_report_mode: null })
  const logs2 = must(await admin.get(`/api/admin/report-settings/logs?project_id=${pid}&staff_id=${id.A}&limit=200`), 'logs').logs
  ok('#313 例外が変わらない保存では履歴を増やさない', same.status === 200 && logs2.filter(l => l.action === 'shift_override').length === so.length, logs2.length)
  const d = await detail()
  ok('#313 案件詳細のスタッフ行に、今後のシフトの例外の件数が出る', Number(row(d, 'A').upcoming_exceptions) === 1 && Number(row(d, 'B').upcoming_exceptions) === 0, row(d, 'A'))
  const ex = must(await admin.get(`/api/admin/report-settings/exceptions?project_id=${pid}`), 'exceptions').exceptions
  ok('#313 例外のあるシフトの一覧に出る', ex.length === 1 && ex[0].shift_id === shiftA && ex[0].attendance_mode === 'in_out', ex)
  const csv = await (await admin.raw(`/api/admin/report-settings/logs/export?project_id=${pid}`)).text()
  ok('#313 履歴の CSV にシフト単位の例外とシフトID が出る', csv.includes('シフト単位の例外') && csv.includes('シフトID'), csv.slice(0, 200))
}

// ---------- #446 OFF の設定一覧 ----------
{
  const list = must(await admin.get('/api/admin/report-settings/projects'), 'projects').projects.find(p => p.project_id === pid)
  ok('#446 案件一覧に個別設定の人数（A・B・C・L）が出る', Number(list.custom_count) === 4, list)
  ok('#446 案件一覧に OFF のある在籍中の所属スタッフの人数が出る（退職者を除く）', Number(list.off_staff_count) === 5, list)
  const off = must(await admin.get(`/api/admin/report-settings/off-list?project_id=${pid}`), 'off-list')
  ok('#446 OFF の設定一覧: 個別の OFF（A の起床報告）が出る', off.rows.some(r => r.staff_id === id.A && r.report_type === 'wake_up'), off.rows.length)
  ok('#446 OFF の設定一覧: 既定では標準設定どおりの OFF（退店報告）を出さない', !off.rows.some(r => r.report_type === 'check_out'), off.rows.map(r => r.report_type))
  const withDef = must(await admin.get(`/api/admin/report-settings/off-list?project_id=${pid}&include_default=1`), 'off-list default')
  ok('#446 include_default=1 で標準設定どおりの OFF も出る', withDef.rows.some(r => r.report_type === 'check_out'), withDef.rows.length)
  ok('#446 既定では退職者を出さない', !withDef.rows.some(r => r.staff_id === id.R), withDef.rows.filter(r => r.staff_id === id.R))
  const byType = must(await admin.get(`/api/admin/report-settings/off-list?project_id=${pid}&report_type=work_start`), 'off-list type')
  ok('#446 報告の種類で絞り込める', byType.rows.length === 3 && byType.rows.every(r => r.report_type === 'work_start'), byType.rows.length)
  ok('#446 #313 OFF の設定一覧にシフト単位の例外も出る', (off.exceptions || []).some(e => e.shift_id === shiftA), off.exceptions)
  const res = await admin.raw(`/api/admin/report-settings/off-list/export?project_id=${pid}`)
  const csv = await res.text()
  ok('#446 OFF の設定一覧の CSV', res.status === 200 && csv.includes('案件の標準設定') && csv.includes(`${PFX} A`), csv.slice(0, 200))
}

// ---------- #413 スタッフ 1 人の全案件の設定 ----------
{
  const s = must(await admin.get(`/api/admin/report-settings/staff/${id.A}`), 'staff page')
  const p = s.projects.find(x => x.project_id === pid)
  ok('#413 スタッフの全案件の設定に、この案件と値・種類が出る', p && p.settings.wake_up === 0 && p.kind === 'individual' && Number(p.upcoming_exceptions) === 1, p)
  const next = Object.fromEntries(ALL.map(t => [t, t === 'check_in' || t === 'check_out']))
  const dry = await admin.post(`/api/admin/report-settings/staff/${id.A}/apply`, { settings: next, project_ids: [pid], dry_run: true })
  ok('#413 すべての案件に同じ設定: 確認内容とトークン', dry.status === 200 && dry.data.changed_count === 1 && dry.data.confirm_token, dry)
  const wrong = await admin.post(`/api/admin/report-settings/staff/${id.A}/apply`, { settings: next, project_ids: [pid], confirm_token: 'x' })
  ok('#413 トークンが違えば 409', wrong.status === 409, wrong)
  const save = await admin.post(`/api/admin/report-settings/staff/${id.A}/apply`, { settings: next, project_ids: [pid], confirm_token: dry.data.confirm_token })
  const d = await detail()
  ok('#413 すべての案件に同じ設定: 保存される', save.status === 200 && ALL.every(t => row(d, 'A').settings[t] === (next[t] ? 1 : 0)), { save: save.data, A: row(d, 'A')?.settings })
  const other = await admin.post(`/api/admin/report-settings/staff/${id.A}/apply`, { settings: next, project_ids: [999999], dry_run: true })
  ok('#413 シフトのない案件は 400', other.status === 400, other)
  const retired = await admin.post(`/api/admin/report-settings/staff/${id.R}/apply`, { settings: next, dry_run: true })
  ok('#413 退職者の設定は変えられない', retired.status === 400, retired)
  const reset = await admin.post(`/api/admin/report-settings/staff/${id.A}/reset`, { project_ids: [pid] })
  const d2 = await detail()
  ok('#413 標準に戻す: 行が消えて『標準』になり、標準設定の値に従う', reset.status === 200 && row(d2, 'A').kind === 'none' && ALL.every(t => row(d2, 'A').settings[t] === d2.defaults[t]), { reset: reset.data, A: row(d2, 'A') })
  const logs = must(await admin.get(`/api/admin/report-settings/logs?staff_id=${id.A}&action=staff_reset`), 'logs').logs
  ok('#413 標準に戻すと staff_reset の履歴が残る', logs.length > 0, logs.length)
  // 旧来の API の『標準に戻す』（attendance_mode: ''）も行を消す
  must(await admin.put(`/api/admin/report-settings/projects/${pid}/staff/${id.C}`, { settings: { check_in: false } }), 'individual C')
  const legacy = await admin.put(`/api/admin/staff/${id.C}/report-settings`, { attendance_mode: '', daily_report_mode: '' })
  const d3 = await detail()
  ok('#413 旧来の API の attendance_mode 空欄も標準に戻す', legacy.status === 200 && row(d3, 'C').kind === 'none', row(d3, 'C'))
}

// ---------- #268 0056 の移行: スタッフ単位の旧設定から作った移行の行は『個別』 ----------
{
  const d = must(await admin.get('/api/admin/report-settings/projects/1'), 'project 1')
  const s2 = d.staff.find(s => s.staff_id === 2)
  // setup-test-db.sh で staff 2 は 0027 より前に『報告なし』にしてある。ほかのテストで変わっていれば確かめない
  if (s2 && ALL.every(t => s2.settings[t] === 0)) ok('#268 旧設定（報告なし）から移行した人は『個別』', s2.kind === 'individual' && s2.individual, s2)
  const s1 = d.staff.find(s => s.staff_id === 1)
  if (s1 && s1.kind !== 'individual') ok('#268 案件の設定を写しただけの移行の人は individual でない', !s1.individual, s1)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
