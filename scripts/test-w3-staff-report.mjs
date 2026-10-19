// スタッフの日報入力の統合テスト（w3-staff-report: #185 #232 #349 #525）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w3-staff-report.mjs
// テストのたびに DB を作り直すこと（シフト・日報・テンプレートを追加するため、2 回目は結果が変わる）

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
const must = (r, label) => { if (r.status !== 200) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.data)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tag = Date.now().toString(36)

async function createShift(admin, staff_id, project_id, work_date, memo, start_time = '10:00', end_time = '18:00') {
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'createShift')
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
const incidentNotices = async (admin) => ((await admin.get('/api/admin/notifications')).data.notifications || []).filter(n => n.kind === 'incident_reported')

const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const st8 = client(await login('sample', 'st008')) // staff_id 8
const st9 = client(await login('sample', 'st009'))

// ---------- #525 標準テンプレートのテキスト項目は複数行の欄・記入例つき ----------
{
  const s = await createShift(admin, 8, 1, today, `SR-TPL-${tag}`)
  const g = await st8.get(`/api/staff/daily-report/${s}`)
  const f = (k) => ((g.data && g.data.template && g.data.template.fields) || []).find(x => x.key === k)
  ok('#525 好事例・店舗共有事項は textarea で記入例がある', g.status === 200 && f('good_case') && f('good_case').type === 'textarea' && f('good_case').placeholder && f('store_share').type === 'textarea' && f('store_share').placeholder, g.data && g.data.template)
  ok('#185 日報の入力画面にシフトの情報が返る', g.data.shift && g.data.shift.shift_id === s && g.data.shift.work_date === today && g.data.shift.project_name && g.data.shift.daily_report_required === true && g.data.shift.blocked === null, g.data.shift)
}

// ---------- #349 テンプレートの必須項目・文字数の上限 ----------
let reqProject, reqShift
{
  const name = `SR必須テンプレート-${tag}`
  must(await hq.post('/api/hq/templates', { template_name: name, fields: [
    { key: 'calls', label: '架電数', type: 'number', required: true },
    { key: 'connects', label: '接続数', type: 'number' },
    { key: 'memo', label: 'メモ', type: 'text', required: true, maxLength: 10 },
  ] }), 'template')
  const tpl = (await hq.get('/api/hq/templates')).data.templates.find(t => t.template_name === name)
  must(await admin.post('/api/admin/projects', { project_name: `SR必須案件-${tag}`, report_template_id: tpl.template_id }), 'project')
  reqProject = (await admin.get('/api/admin/projects')).data.projects.find(p => p.project_name === `SR必須案件-${tag}`).project_id
  reqShift = await createShift(admin, 8, reqProject, today, `SR-REQ-${tag}`)
  const post = (values) => st8.post('/api/staff/daily-report', { shift_id: reqShift, values })
  const r1 = await post({ connects: 3, memo: 'あり' })
  ok('#349 必須の数値が未送信なら 400', r1.status === 400 && /架電数/.test(r1.data.error), r1)
  const r2 = await post({ calls: '', connects: 3, memo: 'あり' })
  ok('#349 必須の数値が空欄なら 400（0件は0と案内）', r2.status === 400 && /0件の場合は0/.test(r2.data.error), r2)
  const r3 = await post({ calls: 0, memo: '   ' })
  ok('#349 必須のテキストが空白だけなら 400', r3.status === 400 && /メモ/.test(r3.data.error), r3)
  const r4 = await post({ calls: 0, memo: '12345678901' })
  ok('#525 テンプレートの maxLength を超えると 400', r4.status === 400 && /10文字/.test(r4.data.error), r4)
  const r5 = await post({ calls: 0, memo: 'OK' })
  ok('#349 必須がそろえば提出できる（0 は入力済み）', r5.status === 200, r5)
  // 報告用URLでも同じ検証
  const link = must(await admin.post(`/api/admin/shifts/${reqShift}/report-link`), 'link')
  const p1 = await pub(link.token, 'POST', '/daily-report', { values: { calls: 1, memo: '' }, flags_explicit: true })
  ok('#349 報告用URLでも必須のテキストが空なら 400', p1.status === 400 && /メモ/.test(p1.data.error), p1)
  const p2 = await pub(link.token, 'POST', '/daily-report', { values: { calls: 1, memo: 'リンク' }, flags_explicit: true })
  ok('#349 報告用URLでも必須がそろえば提出できる', p2.status === 200, p2)
}

// ---------- #232 インシデント・クレームの内容と通知 ----------
{
  const s = await createShift(admin, 8, 1, today, `SR-INC-${tag}`)
  const before = (await incidentNotices(admin)).length
  const r1 = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 1 }, incident_flag: true, flags_explicit: true })
  ok('#232 インシデントの印だけで内容が無ければ 400', r1.status === 400 && /インシデントの内容/.test(r1.data.error), r1)
  const r1b = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 1 }, complaint_flag: true, complaint_note: '  ', flags_explicit: true })
  ok('#232 クレームの内容が空白だけなら 400', r1b.status === 400 && /クレームの内容/.test(r1b.data.error), r1b)
  ok('#232 受け付けなかった日報は保存されない', (await reportsOf(admin, today, 8)).every(r => r.shift_id !== s))
  const r2 = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 1 }, incident_flag: true, incident_note: '14時 什器を倒した。店長に報告済み', complaint_note: '送っても印が無いので保存しない', flags_explicit: true })
  ok('#232 内容があれば提出できる', r2.status === 200, r2)
  let rep = (await reportsOf(admin, today, 8)).find(r => r.shift_id === s)
  ok('#232 内容は values.incident_note に保存（印の無いクレームの内容は保存しない）', rep && rep.incident_flag === 1 && rep.values.incident_note === '14時 什器を倒した。店長に報告済み' && rep.values.complaint_note === undefined, rep && rep.values)
  let ns = await incidentNotices(admin)
  const n = ns.find(x => x.related_id === rep.daily_report_id)
  ok('#232 管理者にアプリ内通知が届く（リンク先は日報一覧の該当日）', ns.length === before + 1 && n && n.link === `/admin#reports/date=${today}&flagged=1` && /インシデント/.test(n.title) && /什器を倒した/.test(n.body), n)
  // 同じ印のまま再提出しても、もう一度は知らせない。内容を送らなければ前回の内容を保つ
  const r3 = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 2 }, incident_flag: true })
  rep = (await reportsOf(admin, today, 8)).find(r => r.shift_id === s)
  ok('#232 内容を送らない再提出では前回の内容を保つ', r3.status === 200 && rep.values.incident_note === '14時 什器を倒した。店長に報告済み' && rep.values.mnp === 2, rep && rep.values)
  ok('#232 印が変わらない再提出では通知しない', (await incidentNotices(admin)).length === before + 1)
  // 更新でクレームを新しく付けたら知らせる
  const r4 = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 2 }, incident_flag: true, complaint_flag: true, complaint_note: 'お客様から説明が長いと苦情', flags_explicit: true })
  ns = await incidentNotices(admin)
  ok('#232 更新でクレームの印を付けたときも通知する', r4.status === 200 && ns.length === before + 2 && /クレーム/.test(ns[0].title) && !/インシデント・/.test(ns[0].title), ns[0])
  // 印を外したら内容も消す
  const r5 = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 2 }, incident_flag: false, complaint_flag: true, flags_explicit: true })
  rep = (await reportsOf(admin, today, 8)).find(r => r.shift_id === s)
  ok('#232 印を外すと内容も消え、残した印の内容は保つ', r5.status === 200 && rep.incident_flag === 0 && rep.values.incident_note === undefined && rep.values.complaint_note === 'お客様から説明が長いと苦情', rep && rep.values)
  const r6 = await st8.post('/api/staff/daily-report', { shift_id: s, values: { mnp: 2 }, complaint_flag: true, complaint_note: 'x'.repeat(2001), flags_explicit: true })
  ok('#232 内容が2000文字を超えると 400', r6.status === 400, r6)
  // スタッフ本人には届かない
  const staffN = ((await st8.get('/api/staff/notifications')).data.notifications || []).filter(x => x.kind === 'incident_reported')
  ok('#232 スタッフには通知しない', staffN.length === 0, staffN)
  // 報告用URL: 内容の欄が無い画面なので必須にはしないが、印を新しく付けたら知らせる
  const s2 = await createShift(admin, 8, 1, today, `SR-INC-LINK-${tag}`)
  const link = must(await admin.post(`/api/admin/shifts/${s2}/report-link`), 'link')
  const p = await pub(link.token, 'POST', '/daily-report', { values: { mnp: 1 }, incident_flag: true, flags_explicit: true })
  ns = await incidentNotices(admin)
  ok('#232 報告用URLからの印は内容なしでも受け付け、通知する', p.status === 200 && ns.length === before + 3 && /記入なし/.test(ns[0].body), ns[0])
}

// ---------- #185 前日以前の未提出の日報 ----------
{
  const d2 = addDays(today, -2), d10 = addDays(today, -10), d1 = addDays(today, -1)
  const past = await createShift(admin, 8, 1, d2, `SR-PAST-${tag}`)
  const old = await createShift(admin, 8, 1, d10, `SR-OLD-${tag}`)
  const absent = await createShift(admin, 8, 1, d1, `SR-ABS-${tag}`)
  must(await admin.put(`/api/admin/shifts/${absent}`, { status: 'absent' }), 'absent')
  const done = await createShift(admin, 8, 2, d1, `SR-DONE-${tag}`)
  must(await st8.post('/api/staff/daily-report', { shift_id: done, values: { mnp: 0 } }), 'done report')
  const other = await createShift(admin, 9, 1, d2, `SR-OTHER-${tag}`)
  const fut = await createShift(admin, 8, 1, addDays(today, 1), `SR-FUT-${tag}`)

  const g = await st8.get('/api/staff/pending-daily-reports')
  const ids = (g.data && g.data.shifts || []).map(s => s.shift_id)
  ok('#185 直近7日の未提出の日報が返る', g.status === 200 && ids.includes(past) && g.data.days === 7, g.data)
  ok('#185 7日より前・欠勤・提出済み・本日以降・他人のシフトは含まない', !ids.includes(old) && !ids.includes(absent) && !ids.includes(done) && !ids.includes(fut) && !ids.includes(other) && !ids.includes(reqShift), ids)
  const row = g.data.shifts.find(s => s.shift_id === past)
  ok('#185 一覧に案件名・稼働日・時刻がある', row && row.project_name && row.work_date === d2 && row.start_time === '10:00', row)
  ok('#185 他人の一覧には出ない', !((await st9.get('/api/staff/pending-daily-reports')).data.shifts || []).some(s => s.shift_id === past))

  const v = await st8.get(`/api/staff/daily-report/${past}`)
  ok('#185 前日以前のシフトも入力画面の情報を取れる', v.status === 200 && v.data.shift && v.data.shift.work_date === d2 && v.data.shift.blocked === null && v.data.report === null, v.data && v.data.shift)
  const a = await st8.get(`/api/staff/daily-report/${absent}`)
  ok('#185 欠勤のシフトは提出できない理由が返る', a.status === 200 && a.data.shift && /欠勤/.test(a.data.shift.blocked || ''), a.data && a.data.shift)
  const r = await st8.post('/api/staff/daily-report', { project_id: 1, shift_id: past, work_date: d2, values: { mnp: 3 } })
  ok('#185 前日以前のシフトの日報を提出できる', r.status === 200 && r.data.updated === false, r)
  const after = ((await st8.get('/api/staff/pending-daily-reports')).data.shifts || []).map(s => s.shift_id)
  ok('#185 提出したら未提出の一覧から消える', !after.includes(past), after)
  const rep = (await reportsOf(admin, d2, 8)).find(x => x.shift_id === past)
  ok('#185 稼働日の日報として保存される', rep && rep.work_date === d2 && rep.values.mnp === 3, rep)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
