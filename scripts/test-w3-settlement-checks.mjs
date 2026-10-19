// 精算の確認事項と請求前確認の集計（w3-settlement-checks: #79 #209 #233 #253 #448 #467 #563、#19 の続き）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 PERSIST=<保存先> node scripts/test-w3-settlement-checks.mjs
//   PERSIST は日報の行をローカルの D1 に直接入れるために使う（日報の入力の検証に左右されないように）。未指定なら日報の提出ありの確認は飛ばす
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'W3C' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

const list = async (from, to, extra = '') => must(await admin.get(`/api/admin/settlement?from=${from}&to=${to}${extra}`), 'settlement')
const rowOf = async (id, date) => (await list(date, date)).rows.find(x => x.shift_id === id)
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project')
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
const newStaff = async (n, type = 'daily_worker') => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: type }), 'staff-quick').staff_id
const newShift = async (staff_id, project_id, work_date, start_time = '10:00', end_time = '19:00', extra = {}) =>
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo: PFX, ...extra }), 'shift').shift_id
const proxy = (id, t, time) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: [t], time })

// 稼働日は今月の過去の日（月初めの数日は前月になるため、請求前確認・案件一覧の今月の集計は月をそろえて確かめる）
const d1st = addDays(today, -3), d2nd = addDays(today, -2)
const P = await newProject(`${PFX}-確認事項`)
const A = await newStaff(1), B = await newStaff(2), C = await newStaff(3)

// ---------- #209 報告の設定を見る / 日報の未提出を出す ----------
{
  const off = await newShift(A, P, d1st)
  must(await admin.put(`/api/admin/shifts/${off}/report-settings`, { attendance_mode: 'none', daily_report_mode: 'none' }), 'shift settings')
  const on = await newShift(B, P, d1st)
  const rOff = await rowOf(off, d1st), rOn = await rowOf(on, d1st)
  ok('#209 報告なしのシフトは『入店報告なし』を出さない', rOff && !rOff.issues.includes('入店報告なし') && rOff.attendance_off === true, rOff && rOff.issues)
  ok('#209 日報を不要にしたシフトは『日報なし』を出さない', rOff && !rOff.issues.includes('日報なし') && rOff.daily_required === false, rOff && rOff.issues)
  ok('#209 報告ありのシフトは『入店報告なし』と『日報なし』を出す', rOn && rOn.issues.includes('入店報告なし') && rOn.issues.includes('日報なし'), rOn && rOn.issues)
  // 入店・退店だけ ON（in_out）のシフトで入店だけ報告 → 『退店報告なし』
  must(await admin.put(`/api/admin/shifts/${on}/report-settings`, { attendance_mode: 'in_out', daily_report_mode: null }), 'in_out')
  await proxy(on, 'check_in', '10:00')
  const r2 = await rowOf(on, d1st)
  ok('#209 入店・退店のみのシフトで退店がなければ『退店報告なし』', r2 && r2.issues.includes('退店報告なし') && !r2.issues.includes('入店報告なし'), r2 && r2.issues)
  if (PERSIST) {
    d1(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, submitted_at, entry_method) VALUES (1, ${B}, ${P}, ${on}, '${d1st}', '{}', '${d1st} 20:00:00', 'app')`)
    await waitServer()
    const r3 = await rowOf(on, d1st)
    ok('#209 日報を出したシフトは『日報なし』を出さない', r3 && !r3.issues.includes('日報なし') && r3.has_daily, r3 && r3.issues)
  } else skip('#209 日報を出したシフト', 'PERSIST 未指定')
}

// ---------- #467 同じ人の時間が重なるシフト ----------
{
  const P2 = await newProject(`${PFX}-重複先`)
  const s1 = await newShift(C, P, d2nd, '10:00', '15:00')
  const s2 = await newShift(C, P2, d2nd, '14:00', '18:00')
  const s3 = await newShift(C, P, d2nd, '15:00', '16:00')   // s1 と端が接するだけ（s2 とは重なる）
  const rows = (await list(d2nd, d2nd, `&project_id=${P}`)).rows
  const r1 = rows.find(r => r.shift_id === s1), r3 = rows.find(r => r.shift_id === s3)
  ok('#467 重なる別案件のシフトを確認事項に出す（絞り込みの外のシフトも）', r1 && r1.issues.some(i => i.startsWith('同じ時間帯に別のシフトあり') && i.includes(`#${s2}`)), r1 && r1.issues)
  ok('#467 端が接するだけのシフトは重ならない', r1 && !r1.issues.some(i => i.includes(`#${s3}`)) && r3 && !r3.issues.some(i => i.includes(`#${s1}`)), [r1 && r1.issues, r3 && r3.issues])
  // 日をまたぐ勤務（前日 22:00〜翌 06:00）と翌日 05:00〜 のシフト
  const n1 = await newShift(C, P, addDays(d2nd, -1), '22:00', '06:00')
  const rN = (await list(d2nd, d2nd, `&project_id=${P2}`)).rows
  const nextDay = await newShift(C, P2, d2nd, '05:00', '07:00')
  const rNext = await rowOf(nextDay, d2nd)
  ok('#467 日をまたぐ前日のシフトとの重なりも出す', rNext && rNext.issues.some(i => i.includes(`#${n1}`)), [rNext && rNext.issues, rN.length])
}

// ---------- #563 確認済み / 確定済みは件数から外す ----------
{
  const s = await newShift(A, P, d2nd, '09:00', '12:00')   // 報告なし → 『入店報告なし』『日報なし』
  let r = await rowOf(s, d2nd)
  const before = (await list(d2nd, d2nd)).totals
  ok('#563 準備: 確認事項がある', r && r.issues.length >= 1, r && r.issues)
  let a = await admin.post('/api/admin/settlement/acks', { shift_ids: [s] })
  r = await rowOf(s, d2nd)
  const after = (await list(d2nd, d2nd)).totals
  ok('#563 確認済みにすると確認事項から外れ、確認済みに移る', a.status === 200 && r.issues.length === 0 && r.acked_issues.length >= 1 && r.acked_at, [a.data, r.issues, r.acked_issues])
  ok('#563 『確認が必要』の件数が減る', after.issues === before.issues - 1, [before.issues, after.issues])
  const issuesOnly = (await list(d2nd, d2nd, '&issues_only=1')).rows
  ok('#563 確認が必要なもののみに出ない', !issuesOnly.some(x => x.shift_id === s), issuesOnly.map(x => x.shift_id))
  const dry = must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [s], dry_run: true }), 'dry')
  ok('#563 確認済みのシフトは確定前の警告に数えない', dry.with_issues === 0 && dry.count === 1, dry)
  a = await admin.post('/api/admin/settlement/acks', { shift_ids: [s], undo: true })
  r = await rowOf(s, d2nd)
  ok('#563 確認済みを取り消すと再び確認事項に出る', a.status === 200 && r.issues.length >= 1 && !r.acked_at, [a.data, r.issues])

  // 確認済みとして確定 → 確定済みの行では確定前の事項を数えない
  const c1 = await admin.post('/api/admin/settlement/confirm', { shift_ids: [s], force: true })
  r = await rowOf(s, d2nd)
  const t = (await list(d2nd, d2nd)).totals
  ok('#563 確認済みとして確定すると、確定前の事項は確認済みになる', c1.status === 200 && c1.data.confirmed === 1 && r.settle_status === 'confirmed' && r.issues.length === 0 && r.acked_issues.length >= 1, [c1.data, r.issues, r.acked_issues])
  ok('#563 合計に確定後の要対応（settled_issues）を分けて返す', typeof t.settled_issues === 'number' && t.settled_issues === 0, t)
  // 確定後に打刻修正を承認 → 『確定後に打刻修正あり』は確定済みの行でも確認が必要
  const approveAdd = async (type, time) => {
    const cr = await admin.post('/api/admin/corrections', { shift_id: s, report_type: type, kind: 'add', requested_at: `${d2nd} ${time}`, reason: 'テスト' })
    return cr.status === 200 ? admin.post(`/api/admin/corrections/${cr.data.correction_id}/approve`, {}) : cr
  }
  const ap = await approveAdd('check_in', '09:00')
  r = await rowOf(s, d2nd)
  const t2 = (await list(d2nd, d2nd)).totals
  if (ap.status === 200 && r && r.issues.includes('確定後に打刻修正あり')) {
    ok('#563 確定後に起きた事項は確定済みの行でも数える', t2.settled_issues === 1 && t2.issues === t.issues, [t, t2])
    must(await admin.post('/api/admin/settlement/acks', { shift_ids: [s] }), 'ack after settle')
    r = await rowOf(s, d2nd)
    ok('#563 確定後の事項も確認済みにできる', r.issues.length === 0, r.issues)
    await new Promise(res => setTimeout(res, 1200))
    await approveAdd('check_out', '12:00')
    r = await rowOf(s, d2nd)
    ok('#563 確認済みの後に新しい修正を承認すると、再び確認が必要になる', r.issues.includes('確定後に打刻修正あり'), r.issues)
  } else skip('#563 確定後の打刻修正', `承認できない: ${ap.text.slice(0, 160)} ${JSON.stringify(r && r.issues)}`)
  must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [s] }), 'unconfirm')
}

// ---------- #79 案件の時間の設定を変えた後の数量・金額の食い違い ----------
{
  const P3 = await newProject(`${PFX}-時給`)
  must(await admin.put(`/api/admin/projects/${P3}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, hours_basis: 'clipped', default_break_minutes: 60 }), 'pricing')
  const s = await newShift(A, P3, d1st, '10:00', '19:00')
  must(await admin.put(`/api/admin/shifts/${s}/actual`, { actual_start: '10:00', actual_end: '20:00' }), 'actual')
  let r = await rowOf(s, d1st)
  ok('#79 準備: 実働どおりでない設定では数量8h、食い違いなし', r && Number(r.bill_qty) === 8 && !r.issues.includes('数量・金額が今の計算と違う'), r && [r.bill_qty, r.hours, r.issues])
  must(await admin.put(`/api/admin/projects/${P3}/pricing`, { hours_basis: 'actual' }), 'pricing2')
  r = await rowOf(s, d1st)
  const t = (await list(d1st, d1st)).totals
  ok('#79 時間の設定を変えると『数量・金額が今の計算と違う』を出す', r && r.hours === 9 && r.issues.includes('数量・金額が今の計算と違う') && t.recalc >= 1, r && [r.hours, r.bill_qty, r.issues])
  const rc = await admin.post('/api/admin/settlement/recalc', { shift_ids: [s] })
  r = await rowOf(s, d1st)
  ok('#79 再計算で数量・金額がそろい、確認事項から消える', rc.status === 200 && rc.data.updated === 1 && Number(r.bill_qty) === 9 && r.bill_base === 13500 && !r.issues.includes('数量・金額が今の計算と違う'), [rc.data, r && r.bill_qty, r && r.bill_base])
}

// ---------- #233 区分変更で対象外にしたシフト ----------
{
  const D = await newStaff(4)
  const worked = await newShift(D, P, d1st)
  must(await admin.put(`/api/admin/shifts/${worked}/actual`, { actual_start: '10:00', actual_end: '19:00' }), 'actual')
  const body = { to_type: 'freelance', effective_date: d1st }
  const pv = must(await admin.post(`/api/admin/staff/${D}/affiliation-change`, { ...body, dry_run: true }), 'dry')
  ok('#233 確認画面に、対象外で精算の確認事項に出すシフトの日付を出す', pv.excluded_shifts === 1 && pv.effects.some(e => e.includes('精算の確認事項に出します') && e.includes(`${Number(d1st.slice(5, 7))}/${Number(d1st.slice(8, 10))}`)), pv.effects)
  must(await admin.post(`/api/admin/staff/${D}/affiliation-change`, { ...body, preview_token: pv.preview_token }), 'change')
  let r = await rowOf(worked, d1st)
  ok('#233 支払先が変更前のままのシフトを確認事項に出す', r && r.payee_type === 'payroll_daily' && r.issues.includes('区分変更の対象外（支払先が変更前のまま）'), r && [r.payee_type, r.issues])
  must(await admin.put(`/api/admin/shifts/${worked}/price`, { reset: true }), 'reset')
  r = await rowOf(worked, d1st)
  ok('#233 今の区分の支払先に置き換えると確認事項から消える', r && r.payee_type === 'freelance' && !r.issues.includes('区分変更の対象外（支払先が変更前のまま）'), r && [r.payee_type, r.issues])
  // 区分を元に戻したとき（支払先がもう変更後と同じシフト）は、前の区分変更の記録で確認事項を出し続けない
  const G = await newStaff(7)
  const workedG = await newShift(G, P, d1st)
  must(await admin.put(`/api/admin/shifts/${workedG}/actual`, { actual_start: '10:00', actual_end: '19:00' }), 'actual G')
  const change = async (to_type) => {
    const b = { to_type, effective_date: d1st }
    const v = must(await admin.post(`/api/admin/staff/${G}/affiliation-change`, { ...b, dry_run: true }), 'dry G')
    return must(await admin.post(`/api/admin/staff/${G}/affiliation-change`, { ...b, preview_token: v.preview_token }), 'change G')
  }
  await change('freelance')
  r = await rowOf(workedG, d1st)
  const shownBefore = !!(r && r.issues.includes('区分変更の対象外（支払先が変更前のまま）'))
  await change('daily_worker')
  r = await rowOf(workedG, d1st)
  ok('#233 区分を元に戻すと、支払先が同じになったシフトの確認事項は消える', shownBefore && r && r.payee_type === 'payroll_daily' && !r.issues.includes('区分変更の対象外（支払先が変更前のまま）'), r && [shownBefore, r.payee_type, r.issues])
}

// ---------- #19 の続き: 勤怠報告のある希望（仮）のシフト ----------
{
  const s = await newShift(B, P, d2nd, '20:00', '21:00', { status: 'requested' })
  const pr = await proxy(s, 'check_in', '20:00')
  const data = await list(d2nd, d2nd)
  if (pr.status === 200) ok('#19 報告のある希望（仮）のシフトを tentative_reported に出す（精算の行には入れない）',
    (data.tentative_reported || []).some(x => x.shift_id === s) && !data.rows.some(x => x.shift_id === s), data.tentative_reported)
  else skip('#19 報告のある希望（仮）のシフト', `代理入力できない: ${pr.text.slice(0, 120)}`)
}

// ---------- #448 請求前確認 / #253 案件一覧の人数 ----------
{
  const month = d1st.slice(0, 7)
  // 欠勤だけの人（C は確定シフトがあるので別の人）と希望（仮）だけの人を足す
  const E = await newStaff(5), F = await newStaff(6)
  await newShift(E, P, d1st, '10:00', '19:00', { status: 'absent' })
  await newShift(F, P, d1st, '10:00', '19:00', { status: 'requested' })
  const bc = must(await admin.get(`/api/admin/billing-check?month=${month}`), 'billing-check')
  const p = bc.by_project.find(x => x.project_id === P)
  // P の確定・代打: A(off: 日報不要) B(日報あり※) C(3件) A(#563 の 1件) D(#233: 1件) → 稼働人数は A B C D の4人
  const sh = must(await admin.get(`/api/admin/shifts?from=${month}-01&to=${today}`), 'shifts').shifts.filter(s => s.project_id === P && s.work_date <= today)
  const working = sh.filter(s => ['confirmed', 'substitute'].includes(s.status))
  ok('#448 稼働人数から欠勤・希望（仮）だけの人を外す', p && p.staff_count === new Set(working.map(s => s.staff_id)).size && !working.some(s => s.staff_id === E || s.staff_id === F), [p && p.staff_count, [...new Set(working.map(s => s.staff_id))]])
  ok('#448 日報の分母は日報が必要な確定・代打のシフトだけ（日報不要のシフトを外す）', p && p.report_required === working.length - 1 && p.work_days === working.length, [p && p.report_required, p && p.work_days, working.length])
  if (PERSIST) ok('#448 分子はそのシフトの日報があるもの', p && p.report_count === 1, p && p.report_count)
  // 欠勤のシフトに日報があっても数えない
  if (PERSIST) {
    const absent = sh.find(s => s.staff_id === E)
    d1(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, submitted_at, entry_method) VALUES (1, ${E}, ${P}, ${absent.shift_id}, '${d1st}', '{}', '${d1st} 20:00:00', 'app')`)
    await waitServer()
    const p2 = must(await admin.get(`/api/admin/billing-check?month=${month}`), 'billing-check').by_project.find(x => x.project_id === P)
    ok('#448 欠勤のシフトの日報は分子に数えない', p2.report_count === 1, p2.report_count)
  }
  const det = bc.detail.find(d => d.project_id === P && d.staff_id === A)
  ok('#448 スタッフ別明細にも日報の分母・分子を返す', det && typeof det.report_required === 'number' && typeof det.report_count === 'number', det)
  if (month === today.slice(0, 7)) {
    const pj = must(await admin.get('/api/admin/projects'), 'projects').projects.find(x => x.project_id === P)
    ok('#253 案件一覧の人数から欠勤・希望（仮）だけの人を外す', pj && pj.staff_count === new Set(working.map(s => s.staff_id)).size, [pj && pj.staff_count, pj && pj.month_shifts])
  } else skip('#253 案件一覧の人数', '稼働日が前月のため')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
