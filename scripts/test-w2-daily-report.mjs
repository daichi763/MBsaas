// 日報をシフト（shift_id）単位にする修正の統合テスト（w2-daily-report: #16 #53 #56 #61 #67 #73 #112 #241 #369 #521）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-daily-report.mjs
// テストのたびに DB を作り直すこと（シフト・日報を追加するため、2 回目は結果が変わる）

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
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

async function createShift(admin, staff_id, project_id, work_date, memo, start_time, end_time, status) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, status })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const list = await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)
  const s = list.data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const reportsOf = async (admin, date, staffId) => ((await admin.get(`/api/admin/daily-reports?date=${date}`)).data.reports || []).filter(r => r.staff_id === staffId)
const pub = async (token, method, sub, body) => {
  const r = await fetch(`${BASE}/api/public/report/${token}${sub}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data }
}

const admin = client(await login('sample', 'admin'))
const st8 = client(await login('sample', 'st008')) // staff_id 8

// ---------- #61 #73 同じ日・同じ案件の2シフトは別々の日報。二度押しでも1件 ----------
const s1 = await createShift(admin, 8, 1, today, 'DR-S1', '00:01', '00:02')
const s2 = await createShift(admin, 8, 1, today, 'DR-S2', '23:50', '23:55')
{
  const r1 = await st8.post('/api/staff/daily-report', { project_id: 1, shift_id: s1, work_date: today, values: { mnp: 1, free: '午前' } })
  ok('1つ目のシフトの日報を提出', r1.status === 200 && r1.data.updated === false, r1)
  let h = await st8.get('/api/staff/home')
  const t2 = (h.data.today_shifts || []).find(s => s.shift_id === s2)
  ok('#61 同じ案件の2つ目のシフトは、ホームで未提出のまま', t2 && t2.daily_report_done === false, t2)
  const r2 = await st8.post('/api/staff/daily-report', { project_id: 1, shift_id: s2, work_date: today, values: { mnp: 5 } })
  ok('2つ目のシフトの日報を提出（新しい行）', r2.status === 200 && r2.data.updated === false, r2)
  const mine = await reportsOf(admin, today, 8)
  const a = mine.find(r => r.shift_id === s1), b = mine.find(r => r.shift_id === s2)
  ok('#61 2つ目の日報が1つ目を上書きしない（シフトごとに1件）', mine.length === 2 && a && a.values.mnp === 1 && a.values.free === '午前' && b && b.values.mnp === 5, mine.map(r => ({ shift_id: r.shift_id, values: r.values })))

  // 二度押し（同時に5回）
  const many = await Promise.all([1, 2, 3, 4, 5].map(n => st8.post('/api/staff/daily-report', { shift_id: s1, values: { mnp: 10 + n } })))
  ok('#73 同時に送っても、すべて成功する', many.every(r => r.status === 200), many.map(r => r.status))
  const after = (await reportsOf(admin, today, 8)).filter(r => r.shift_id === s1)
  ok('#73 同じシフトの日報は1行のまま（上書き）', after.length === 1 && after[0].values.mnp > 10, after.map(r => r.values))
}

// ---------- #16 前回の内容を返す・再提出で確認済みを外す ----------
{
  const before = (await reportsOf(admin, today, 8)).find(r => r.shift_id === s2)
  const chk = await admin.put(`/api/admin/daily-reports/${before.daily_report_id}`, { manager_checked: 1, manager_comment: '確認しました' })
  ok('管理者が確認済みにする', chk.status === 200, chk)
  const g = await st8.get(`/api/staff/daily-report/${s2}`)
  ok('#16 日報の入力画面に、提出済みの内容と確認済みの印が返る', g.status === 200 && g.data.report && g.data.report.values.mnp === 5 && g.data.report.manager_checked === true && g.data.report.manager_comment === '確認しました' && g.data.template && Array.isArray(g.data.template.fields), g.data)
  const r = await st8.post('/api/staff/daily-report', { shift_id: s2, values: { mnp: 6 } })
  ok('#16 再提出は上書き（updated）', r.status === 200 && r.data.updated === true, r)
  const after = (await reportsOf(admin, today, 8)).find(x => x.shift_id === s2)
  ok('#16 再提出すると確認済みが外れ、確認後の修正日時が残る', after && !after.manager_checked && after.revised_after_check_at && after.values.mnp === 6 && after.manager_comment === '確認しました', after)
  const other = await client(await login('sample', 'st009')).get(`/api/staff/daily-report/${s2}`)
  ok('他人のシフトの日報は取得できない', other.status === 404, other)
}

// ---------- #56 案件・稼働日はシフトと一致すること ----------
{
  const p = await st8.post('/api/staff/daily-report', { project_id: 2, shift_id: s1, work_date: today, values: { mnp: 1 } })
  ok('#56 シフトと違う案件は 400', p.status === 400, p)
  const d = await st8.post('/api/staff/daily-report', { project_id: 1, shift_id: s1, work_date: addDays(today, -1), values: { mnp: 1 } })
  ok('#56 シフトと違う稼働日は 400', d.status === 400, d)
  const n = await st8.post('/api/staff/daily-report', { project_id: 1, work_date: today, values: { mnp: 1 } })
  ok('#56 shift_id の無い日報は 400', n.status === 400, n)
  const x = await st8.post('/api/staff/daily-report', { shift_id: 1, values: { mnp: 1 } })
  ok('#56 他人のシフトは 404', x.status === 404, x)
}

// ---------- #369 #521 数値と大きさの検証 ----------
{
  const post = (values) => st8.post('/api/staff/daily-report', { shift_id: s1, values })
  ok('#369 負の数は 400', (await post({ mnp: -1 })).status === 400)
  ok('#369 小数は 400', (await post({ mnp: 1.5 })).status === 400)
  ok('#369 上限を超える数は 400', (await post({ mnp: 100000 })).status === 400)
  const s = await post({ mnp: '12' })
  const rep = (await reportsOf(admin, today, 8)).find(r => r.shift_id === s1)
  ok('#369 数字の文字列は数値として保存', s.status === 200 && rep && rep.values.mnp === 12, rep && rep.values)
  ok('#521 values が配列なら 400', (await post([1, 2])).status === 400)
  const ctl = '\u0001'.repeat(2000) // JSON にすると 1 文字 6 文字
  const big = await post({ good_case: ctl, store_share: ctl, other_result: ctl, free: ctl })
  ok('#521 JSON 全体が 20000 文字を超えると 400', big.status === 400, big)
}

// ---------- #67 インシデント・クレームの印を保つ ----------
{
  const r = await st8.post('/api/staff/daily-report', { shift_id: s1, values: { mnp: 1 }, incident_flag: true, complaint_flag: true, incident_note: 'テストのインシデント', complaint_note: 'テストのクレーム', flags_explicit: true })
  ok('インシデント・クレームありで提出', r.status === 200, r)
  const link = await admin.post(`/api/admin/shifts/${s1}/report-link`)
  ok('報告用URLの発行', link.status === 200 && link.data.token, link)
  const g = await pub(link.data.token, 'GET', '')
  ok('#67 報告用URLの取得で、印が返る', g.status === 200 && g.data.daily_report && g.data.daily_report.incident_flag === true && g.data.daily_report.complaint_flag === true, g.data && g.data.daily_report)
  // 前回の値を表示しない古い画面からの再提出（flags_explicit なし）では印を下げない
  const p1 = await pub(link.data.token, 'POST', '/daily-report', { values: { mnp: 2 }, incident_flag: false, complaint_flag: false })
  let rep = (await reportsOf(admin, today, 8)).find(x => x.shift_id === s1)
  ok('#67 再提出で印が消えない', p1.status === 200 && rep && rep.incident_flag === 1 && rep.complaint_flag === 1 && rep.values.mnp === 2 && rep.entry_method === 'link', rep)
  // 画面で外して送ったときだけ下げる
  const p2 = await pub(link.data.token, 'POST', '/daily-report', { values: { mnp: 2 }, incident_flag: false, complaint_flag: true, flags_explicit: true })
  rep = (await reportsOf(admin, today, 8)).find(x => x.shift_id === s1)
  ok('#67 チェックを外して送れば下がる', p2.status === 200 && rep && rep.incident_flag === 0 && rep.complaint_flag === 1, rep)
  ok('報告用URLでも同じシフトの日報は1行', (await reportsOf(admin, today, 8)).filter(x => x.shift_id === s1).length === 1)
  const st = await admin.get(`/api/admin/shifts/${s1}/report-status`)
  ok('報告状況の日報はシフトの日報', st.status === 200 && st.data.daily_report && st.data.daily_report.entry_method === 'link', st.data && st.data.daily_report)
}

// ---------- #241 稼働日の前・日報なしのシフト ----------
{
  const tomorrow = addDays(today, 1)
  const f = await createShift(admin, 8, 1, tomorrow, 'DR-FUT', '09:00', '18:00')
  const link = await admin.post(`/api/admin/shifts/${f}/report-link`)
  const p = await pub(link.data.token, 'POST', '/daily-report', { values: { mnp: 1 } })
  ok('#241 報告用URL: 稼働日の前は 400', p.status === 400, p)
  const a = await st8.post('/api/staff/daily-report', { shift_id: f, values: { mnp: 1 } })
  ok('#241 アプリ: 稼働日の前は 400', a.status === 400, a)
  ok('#241 稼働日の前の日報は登録されていない', (await reportsOf(admin, tomorrow, 8)).length === 0)

  const n = await createShift(admin, 8, 1, today, 'DR-NONE', '12:00', '12:30')
  const set = await admin.put(`/api/admin/shifts/${n}/report-settings`, { attendance_mode: '', daily_report_mode: 'none' })
  ok('シフトの日報を「不要」にする', set.status === 200, set)
  const ln = await admin.post(`/api/admin/shifts/${n}/report-link`)
  const pn = await pub(ln.data.token, 'POST', '/daily-report', { values: { mnp: 1 } })
  ok('#241 報告用URL: 日報「不要」のシフトは 400', pn.status === 400, pn)
}

// ---------- #53 #112 ダッシュボードの日報未提出 ----------
{
  const st9 = client(await login('sample', 'st009'))
  const y1 = addDays(today, -1), y2 = addDays(today, -2), y3 = addDays(today, -3)
  const a = await createShift(admin, 9, 1, y1, 'DR-D-A', '09:00', '10:00')
  const b = await createShift(admin, 9, 2, y1, 'DR-D-B', '11:00', '12:00')
  const c = await createShift(admin, 9, 1, y2, 'DR-D-C', '09:00', '18:00', 'substitute')
  const d = await createShift(admin, 9, 1, y3, 'DR-D-D', '09:00', '18:00')
  const r = await st9.post('/api/staff/daily-report', { shift_id: a, values: { mnp: 1 } })
  ok('前日の1つ目のシフトの日報を提出', r.status === 200, r)
  const e = await createShift(admin, 10, 1, y1, 'DR-D-E', '09:00', '10:00')
  const f = await createShift(admin, 10, 2, y1, 'DR-D-F', '11:00', '12:00')

  const dash = await admin.get('/api/admin/dashboard')
  ok('ダッシュボードの取得', dash.status === 200, dash.status)
  const miss = (dash.data.missing_daily_reports || []).map(m => m.shift_id)
  ok('#112 同じ日の別のシフトの日報を出しても、未提出のシフトは残る', miss.includes(b) && !miss.includes(a), miss)
  ok('#53 代打のシフトも未提出に出る', miss.includes(c), miss)
  ok('未提出のシフトがすべて出る', miss.includes(d) && miss.includes(e) && miss.includes(f), miss)
  const todos = (dash.data.todos || []).map(t => t.text)
  const t9 = todos.find(t => t.includes('日報') && (dash.data.todos.find(x => x.text === t) || {}).staff_id === 9)
  const t10 = todos.find(t => t.includes('日報') && (dash.data.todos.find(x => x.text === t) || {}).staff_id === 10)
  ok('#112 3日とも未提出なら「3日連続」（件数はシフトの数）', t9 && t9.includes('3日連続') && t9.includes('3件'), t9)
  ok('#112 1日に2シフトの未提出は「連続」にしない', t10 && !t10.includes('連続') && t10.includes('2件') && t10.includes('1日分'), t10)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
