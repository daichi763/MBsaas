// スタッフアプリのホーム・シフト・研修・実績・過去の日報の統合テスト（w3-staff-app: #74 #75 #76 #188 #319 #371 #483 #503 #504）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w3-staff-app.mjs
// 画面だけの修正（#182 読み込み失敗と送信ロック、#465 起動時の失敗、#231 入力欄の文字の大きさ）は、ここでは確かめない
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const PFX = 'SA' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）

async function newStaff(api, k) {
  must(await api.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await api.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(api, name, extra = {}) {
  must(await api.post('/api/admin/projects', { project_name: name, ...extra }), 'project ' + name)
  return must(await api.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function createShift(api, staff_id, project_id, work_date, start_time = '10:00', end_time = '18:00') {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await api.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  const s = must(await api.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}

// ---------- #188 #504 #503 開催場所・枠のメモ・役割・休憩、同じ日の複数のシフト ----------
const S1 = await newStaff(admin, 'HOME')
const st1 = client(await login('sample', `${PFX}HOME`))
{
  const site = must(await admin.post('/api/admin/sites', { site_name: `${PFX}会場`, address: '東京都新宿区西新宿2-8-1', lat: 35.6896, lng: 139.6917 }), 'site').site_id
  must(await admin.post('/api/admin/shift-slots', { project_id: 1, site_id: site, dates: [today], start_time: '09:00', end_time: '13:00', break_minutes: 45, memo: '持ち物: 黒のスニーカー\n集合: 2階通用口', roles: [{ role_name: '受付', headcount: 1 }] }), 'slot')
  const board = must(await admin.get(`/api/admin/shift-board?from=${today}&to=${today}`), 'board')
  const slot = board.slots.filter(s => s.site_id === site).pop()
  must(await admin.post(`/api/admin/shift-slots/roles/${slot.roles[0].slot_role_id}/assign`, { staff_ids: [S1.staff_id], force: true }), 'assign')
  const second = await createShift(admin, S1.staff_id, 2, today, '15:00', '20:00')

  const h = must(await st1.get('/api/staff/home'), 'home')
  ok('#188 ホームのシフトに開催場所の名前・住所・緯度経度が付く', h.shift && h.shift.site_name === `${PFX}会場` && h.shift.site_address === '東京都新宿区西新宿2-8-1' && h.shift.site_lat === 35.6896 && h.shift.site_lng === 139.6917, h.shift)
  ok('#188 枠のメモ（改行を含む）と役割・休憩が付く', h.shift && h.shift.slot_memo === '持ち物: 黒のスニーカー\n集合: 2階通用口' && h.shift.role === '受付' && (h.shift.break_minutes === 45 || h.shift.slot_break_minutes === 45), h.shift)
  ok('#188 お金の項目は返さない', h.shift && !('pay_rate' in h.shift) && !('bill_rate' in h.shift), Object.keys(h.shift || {}))
  ok('#504 today_shifts に同じ日の2件が時刻順で並び、場所が付く', h.today_shifts.length === 2 && h.today_shifts[0].start_time === '09:00' && h.today_shifts[1].shift_id === second && h.today_shifts[0].location === `${PFX}会場`, h.today_shifts)
  ok('#503 1社だけに所属する人は multi_company=false', h.multi_company === false, h.multi_company)
  const sel = must(await st1.get(`/api/staff/home?shift_id=${second}`), 'home2')
  ok('#504 2件目を選ぶと、そのシフトがホームの対象になる', sel.shift && sel.shift.shift_id === second, sel.shift && sel.shift.shift_id)

  const sh = must(await st1.get(`/api/staff/shifts?month=${today.slice(0, 7)}`), 'shifts')
  const row = sh.shifts.find(s => s.site_id === site)
  ok('#188 シフト一覧にも住所・枠のメモ・案件の標準の休憩が付く', row && row.site_address === '東京都新宿区西新宿2-8-1' && row.slot_memo && 'project_break_minutes' in row, row)
  ok('#503 シフト一覧に multi_company と会社名が付く', sh.multi_company === false && row && row.company_name === '株式会社サンプルモバイル人材', { m: sh.multi_company, c: row && row.company_name })
}

// ---------- #483 前日以前の報告漏れ ----------
{
  const d2 = addDays(today, -2)
  const miss = await createShift(admin, S1.staff_id, 1, d2, '10:00', '18:00')
  const absent = await createShift(admin, S1.staff_id, 1, addDays(today, -3), '10:00', '18:00')
  const abs = await admin.put(`/api/admin/shifts/${absent}`, { status: 'absent' })
  const old = await createShift(admin, S1.staff_id, 1, addDays(today, -10), '10:00', '18:00')
  // 1件は打刻漏れの追加を申請しておく（承認待ちの報告は漏れとして数えない）
  const corr = await st1.post('/api/staff/corrections', { shift_id: miss, report_type: 'check_in', kind: 'add', requested_at: `${d2} 10:00`, reason: 'テスト' })
  const h = must(await st1.get('/api/staff/home'), 'home')
  const m = h.missed_reports
  const item = m && m.shifts.find(x => x.shift_id === miss)
  ok('#483 ホームに前日以前の報告漏れのシフトが出る', m && m.total >= 1 && item && item.work_date === d2 && item.missing.includes('check_out'), m)
  ok('#483 承認待ちの申請がある報告は漏れに含めない', corr.status === 200 && item && !item.missing.includes('check_in'), { corr: corr.status, item })
  ok('#483 欠勤のシフトは出さない', abs.status === 200 && !m.shifts.some(x => x.shift_id === absent), { abs: abs.status, m })
  ok('#483 7日より前のシフトは出さない', !m.shifts.some(x => x.shift_id === old), m)
  ok('#483 本日のシフトは報告漏れに出さない', !m.shifts.some(x => x.work_date === today), m)
}

// ---------- #74 研修・マニュアル ----------
{
  const r = must(await st1.get('/api/staff/manuals'), 'manuals')
  const p1 = r.projects.find(p => p.project_id === 1)
  ok('#74 シフトのある案件のマニュアル・求められる内容が返る', p1 && p1.manual_text === '開店30分前入店。制服貸与。店長への朝挨拶必須。' && p1.requirements && p1.next_date === today, p1)
  ok('#74 シフトの無い案件は返さない', !r.projects.some(p => p.project_id === 3), r.projects.map(p => p.project_id))
  const other = client(await login('sample', 'st020'))
  const r2 = must(await other.get('/api/staff/manuals'), 'manuals other')
  ok('#74 ほかのスタッフの今日のシフトは混ざらない（固定のダミー表示ではない）', !r2.projects.some(p => p.next_date === today), r2)
}

// ---------- #76 #319 #371 テンプレートの項目で実績・過去の日報を出す ----------
{
  const tname = `${PFX}コールセンター`
  must(await hq.post('/api/hq/templates', { template_name: tname, fields: [{ key: 'calls', label: '架電数', type: 'number' }, { key: 'connects', label: '接続数', type: 'number' }, { key: 'note', label: '所感', type: 'textarea' }] }), 'template')
  const tid = must(await hq.get('/api/hq/templates'), 'templates').templates.find(t => t.template_name === tname).template_id
  const pid = await newProject(admin, `${PFX}-CC案件`, { report_template_id: tid })
  const sid = await createShift(admin, S1.staff_id, pid, today, '21:00', '22:00')
  must(await st1.post('/api/staff/daily-report', { shift_id: sid, values: { calls: 120, connects: 30, note: '1行目\n2行目' } }), 'daily report')
  const perf = must(await st1.get(`/api/staff/performance?month=${today.slice(0, 7)}`), 'perf')
  const pj = perf.projects.find(p => p.project_id === pid)
  ok('#76 実績は案件ごとに、テンプレートの数値項目の表示名で返る', pj && pj.fields.map(f => f.label).join(',') === '架電数,接続数' && pj.totals.calls === 120 && pj.totals.connects === 30, pj)
  ok('#76 日別実績にも値が付く（データなしにならない）', perf.daily.some(d => d.project_id === pid && d.values.calls === 120), perf.daily)
  ok('#76 不正な月は今月として扱う', must(await st1.get('/api/staff/performance?month=2026-13'), 'perf bad').month === today.slice(0, 7))

  const rep = must(await st1.get('/api/staff/my-reports'), 'my-reports')
  const r = rep.reports.find(x => x.shift_id === sid)
  ok('#319 過去の日報に提出した値・テンプレートの項目名・提出日時が付く', r && r.values.calls === 120 && r.values.note === '1行目\n2行目' && rep.templates[r.template_id].some(f => f.key === 'calls' && f.label === '架電数') && r.submitted_at, { r, t: r && rep.templates[r.template_id] })
  ok('#319 生の report_values は返さない', r && !('report_values' in r), r && Object.keys(r))
  ok('#371 管理者の確認前は manager_checked=false', r && r.manager_checked === false, r)
  must(await admin.put(`/api/admin/daily-reports/${r.daily_report_id}`, { manager_checked: 1, manager_comment: 'よくできました' }), 'check')
  const r2 = must(await st1.get('/api/staff/my-reports'), 'my-reports2').reports.find(x => x.shift_id === sid)
  ok('#371 管理者が確認すると manager_checked=true とコメントが返る', r2 && r2.manager_checked === true && r2.manager_comment === 'よくできました', r2)
}

// ---------- #75 #503 連携先のシフトで出した日報・実績 ----------
{
  const code = `${PFX.toLowerCase()}a`
  const coName = `${PFX}連携先株式会社`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: coName, admin_code: 'admin', admin_password: 'pass1234', admin_name: '連携先管理者' }), 'company')
  const A = client(await login(code, 'admin'))
  const X = await newStaff(admin, 'LINKX')
  const share = must(await admin.get(`/api/admin/roster/${X.staff_id}/share-code`), 'share-code')
  const terms = must(await A.get('/api/admin/roster/consent-terms'), 'terms')
  const xA = must(await A.post('/api/admin/roster/link', { code: share.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
  const aPid = await newProject(A, `${PFX}-A案件`)
  const aShift = await createShift(A, xA, aPid, today, '10:00', '18:00')
  const stX = client(await login('sample', `${PFX}LINKX`))
  const h = must(await stX.get('/api/staff/home'), 'home X')
  const cur = h.today_shifts.find(s => s.shift_id === aShift)
  ok('#503 連携先のシフトは other_company と会社名が付き、multi_company=true', h.multi_company === true && cur && cur.other_company === true && cur.company_name === coName, { m: h.multi_company, cur })
  const sh = must(await stX.get(`/api/staff/shifts?month=${today.slice(0, 7)}`), 'shifts X')
  ok('#503 シフト一覧も multi_company=true で、連携先のシフトに会社名', sh.multi_company === true && sh.shifts.some(s => s.shift_id === aShift && s.other_company && s.company_name === coName), sh.shifts)
  const dr = await stX.post('/api/staff/daily-report', { shift_id: aShift, values: { mnp: 2 } })
  ok('（前提）連携先のシフトに日報を出せる', dr.status === 200, dr)
  const rep = must(await stX.get('/api/staff/my-reports'), 'my-reports X')
  const r = rep.reports.find(x => x.shift_id === aShift)
  ok('#75 連携先のシフトで出した日報が、過去の日報に会社名付きで出る', r && r.other_company === true && r.company_name === coName && r.values.mnp === 2, rep.reports)
  const perf = must(await stX.get(`/api/staff/performance?month=${today.slice(0, 7)}`), 'perf X')
  ok('#75 連携先の案件の実績も出る', perf.projects.some(p => p.project_id === aPid && p.other_company && p.totals.mnp === 2), perf.projects)
  const man = must(await stX.get('/api/staff/manuals'), 'manuals X')
  ok('#74 #75 連携先の案件もマニュアルの一覧に出る（会社名付き）', man.projects.some(p => p.project_id === aPid && p.other_company && p.company_name === coName), man.projects)
  const other = must(await st1.get('/api/staff/my-reports'), 'my-reports st1')
  ok('#75 別の人の日報は混ざらない', !other.reports.some(x => x.shift_id === aShift))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
