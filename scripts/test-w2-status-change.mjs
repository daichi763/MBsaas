// 所属区分の変更（w2-status-change: #28 #82 #99 #100 #121 #140 #149 #237 #265）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --test-scheduled --persist-to <保存先>` で起動していること
//   予約の適用（cron）と支払先の付け直しの確認には、環境変数 PERSIST に --persist-to の保存先を指定する
//   （ローカルの D1 に直接書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用。未指定ならその部分は飛ばす）
// 実行: BASE=http://127.0.0.1:8799 PERSIST=<保存先> node scripts/test-w2-status-change.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
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
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
// D1 に書き込んだ・読んだ後は、開発サーバーが応答に戻るまで待つ
async function d1w(sql) { const r = d1(sql); await waitServer(); return r }
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'SC' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '090' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)

const admin = client(await login('sample', 'admin'))
const change = (sid, body) => admin.post(`/api/admin/staff/${sid}/affiliation-change`, body)
// 確認してから実行する（確認で受け取った preview_token を送る）
async function changeConfirmed(api, sid, body) {
  const pv = await api.post(`/api/admin/staff/${sid}/affiliation-change`, { ...body, dry_run: true })
  if (pv.status !== 200) return pv
  return api.post(`/api/admin/staff/${sid}/affiliation-change`, { ...body, preview_token: pv.data.preview_token })
}
const shiftsOf = async (api, sid, from, to) => (must(await api.get(`/api/admin/shifts?from=${from}&to=${to}`), 'shifts').shifts).filter(s => s.staff_id === sid)
const lifecycle = async (sid) => must(await admin.get(`/api/admin/staff/${sid}/lifecycle`), 'lifecycle')

// ---------- 準備: 日雇いの仮登録と、過去・今後のシフト ----------
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const A = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 区分`, phone: phone(1), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const dates = { pastPlain: addDays(today, -3), pastManual: addDays(today, -2), d1: addDays(today, 1), d5: addDays(today, 5), d40: addDays(today, 40) }
for (const d of Object.values(dates)) must(await admin.post('/api/admin/shifts', { staff_id: A, project_id: pid, work_date: d, start_time: '10:00', end_time: '19:00' }), 'shift ' + d)
let sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
const byDate = (list, d) => list.find(s => s.work_date === d)
// 過去のシフトの1件に実績を手入力する（勤務済み）
must(await admin.put(`/api/admin/shifts/${byDate(sh, dates.pastManual).shift_id}/actual`, { actual_start: '10:00', actual_end: '19:00' }), 'actual')
ok('準備: シフト5件（日雇いの支払先）', sh.length === 5 && sh.every(s => s.payee_type === 'payroll_daily'), sh.map(s => s.payee_type))

// ---------- #149 勤務済みのシフトは置き換えない / 過去の適用日は警告 / #100 確認なし・確認と違う内容では実行しない ----------
const partnerName = `${PFX}取引先1`
const bodyPast = { to_type: 'partner_manual', new_partner_name: partnerName, effective_date: dates.pastPlain }
let pv = await change(A, { ...bodyPast, dry_run: true })
ok('#149 確認: 実績を入力したシフトは置き換えの対象外（4件・対象外1件）', pv.status === 200 && pv.data.affected_shifts === 4 && pv.data.excluded_shifts === 1, pv.data)
ok('#149 確認: 適用日が今日より前なら警告を出す', (pv.data.warnings || []).length === 1 && pv.data.warnings[0].includes(dates.pastPlain), pv.data.warnings)
let r = await change(A, { to_type: 'partner_manual', new_partner_name: partnerName, effective_date: today })
ok('#100 確認せずに実行すると 400', r.status === 400, r)
r = await change(A, { to_type: 'partner_manual', new_partner_name: partnerName, effective_date: today, preview_token: pv.data.preview_token })
ok('#100 確認したときと適用日が違うと 409（preview_changed）', r.status === 409 && r.data.preview_changed === true, r)
r = await change(A, { ...bodyPast, new_partner_name: partnerName + 'X', preview_token: pv.data.preview_token })
ok('#100 確認したときと取引先が違うと 409', r.status === 409, r)
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
ok('#100 実行されなかったので、区分・支払先は変わらない', sh.every(s => s.payee_type === 'payroll_daily') && (await lifecycle(A)).affiliation_type === 'daily_worker', sh.map(s => s.payee_type))

// 今日から取引先所属に変更する
r = await changeConfirmed(admin, A, { to_type: 'partner_manual', new_partner_name: partnerName, effective_date: today })
ok('区分変更: 今日から取引先所属（予定シフト3件を置き換え）', r.status === 200 && r.data.affected_shifts === 3 && !r.data.scheduled, r)
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
const partners = must(await admin.get('/api/admin/roster/partners'), 'partners').partners
const p1 = partners.find(p => p.affiliation_name === partnerName)
ok('区分変更: 今日以降のシフトの支払先が新しい取引先になる', [dates.d1, dates.d5, dates.d40].every(d => byDate(sh, d).payee_type === 'partner' && byDate(sh, d).payee_affiliation_id === p1?.affiliation_id), sh.map(s => [s.work_date, s.payee_type, s.payee_affiliation_id]))
ok('区分変更: 適用日より前のシフトは日雇いの支払先のまま', [dates.pastPlain, dates.pastManual].every(d => byDate(sh, d).payee_type === 'payroll_daily'), sh.map(s => [s.work_date, s.payee_type]))
let lc = await lifecycle(A)
ok('区分変更: 履歴に変更前の支払先と対象外の件数が残る', lc.history[0].to_type === 'partner_manual' && lc.history[0].from_payee_type === 'payroll_daily', lc.history[0])

// ---------- #82 適用日より前のシフトを計算し直しても、変更前の支払先のまま ----------
must(await admin.put(`/api/admin/shifts/${byDate(sh, dates.pastPlain).shift_id}`, { start_time: '11:00' }), 'edit past shift')
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
ok('#82 適用日より前のシフトの時間を変えて再計算しても、支払先は変更前（日雇い）', byDate(sh, dates.pastPlain).payee_type === 'payroll_daily', byDate(sh, dates.pastPlain))
must(await admin.put(`/api/admin/shifts/${byDate(sh, dates.d5).shift_id}`, { start_time: '11:00' }), 'edit future shift')
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
ok('#82 適用日以降のシフトを再計算すると、新しい区分（取引先）', byDate(sh, dates.d5).payee_type === 'partner' && byDate(sh, dates.d5).payee_affiliation_id === p1?.affiliation_id, byDate(sh, dates.d5))

// 同じ内容は受け付けない（支払先が残っていなければ）
pv = await change(A, { to_type: 'partner_manual', partner_affiliation_id: p1.affiliation_id, effective_date: today, dry_run: true })
ok('#121 同じ取引先への変更は、置き換えの残りがなければ 400', pv.status === 400, pv)

// ---------- #28 スタッフ詳細で取引先を直すと、今後の未確定シフトの支払先も変わる ----------
const partnerName2 = `${PFX}取引先2`
r = await admin.put(`/api/admin/staff/${A}`, { affiliation: partnerName2 })
ok('#28 （前提）所属会社名を変えて保存できる', r.status === 200, r)
const p2 = must(await admin.get('/api/admin/roster/partners'), 'partners').partners.find(p => p.affiliation_name === partnerName2)
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
ok('#28 今日以降の未確定シフトの支払先が新しい取引先になる', [dates.d1, dates.d5, dates.d40].every(d => byDate(sh, d).payee_affiliation_id === p2?.affiliation_id), sh.map(s => [s.work_date, s.payee_type, s.payee_affiliation_id]))

// ---------- #121 支払先が前の区分のまま残ったシフトの付け直し（途中で失敗した過去の変更の救済） ----------
if (PERSIST) {
  await d1w(`UPDATE shifts SET payee_type = 'payroll_daily', payee_affiliation_id = NULL WHERE shift_id = ${byDate(sh, dates.d40).shift_id}`)
  pv = await change(A, { to_type: 'partner_manual', partner_affiliation_id: p2.affiliation_id, effective_date: today, dry_run: true })
  ok('#121 同じ区分でも、支払先が前のままのシフトがあれば付け直しとして確認できる（1件）', pv.status === 200 && pv.data.repair === true && pv.data.affected_shifts === 1, pv.data)
  r = await change(A, { to_type: 'partner_manual', partner_affiliation_id: p2.affiliation_id, effective_date: today, preview_token: pv.data.preview_token })
  sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
  ok('#121 付け直しを実行すると、残っていたシフトの支払先が直る', r.status === 200 && byDate(sh, dates.d40).payee_type === 'partner' && byDate(sh, dates.d40).payee_affiliation_id === p2.affiliation_id, [r, byDate(sh, dates.d40)])
} else console.log('SKIP  #121 付け直し（PERSIST 未指定）')

// ---------- #82 #265 未来の適用日は予約。入社日の既定は適用日 ----------
const future = addDays(today, 10)
pv = await change(A, { to_type: 'own_employee', effective_date: future, hire_date: '', dry_run: true })
ok('#82 確認: 明日以降の適用日は予約になる', pv.status === 200 && pv.data.scheduled === true, pv.data)
ok('#265 確認: 入社日が空欄なら適用日を入社日にする', pv.data.hire_date === future && pv.data.effects.some(x => x.includes(`入社日 ${future}`)), pv.data)
r = await change(A, { to_type: 'own_employee', effective_date: future, hire_date: '', preview_token: pv.data.preview_token })
ok('#82 予約として保存する', r.status === 200 && r.data.scheduled === true, r)
lc = await lifecycle(A)
ok('#82 予約中は区分が変わらない（取引先所属のまま）', lc.affiliation_type === 'partner_manual' && lc.schedules.some(s => s.status === 'pending' && s.effective_date === future), lc)
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
ok('#82 予約中は適用日より前のシフトの支払先も変わらない', byDate(sh, dates.d5).payee_type === 'partner', byDate(sh, dates.d5))
must(await admin.put(`/api/admin/shifts/${byDate(sh, dates.d1).shift_id}`, { start_time: '12:00' }), 'edit during schedule')
sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
ok('#82 予約中に適用日より前のシフトを再計算しても、今の区分（取引先）の支払先', byDate(sh, dates.d1).payee_type === 'partner', byDate(sh, dates.d1))
pv = await change(A, { to_type: 'daily_worker', effective_date: today, dry_run: true })
ok('#82 予約中は別の区分変更を受け付けない（409）', pv.status === 409, pv)
const sched = lc.schedules.find(s => s.status === 'pending')
r = await admin.del(`/api/admin/staff/${A}/affiliation-schedules/${sched.schedule_id}`)
ok('#82 予約を取り消せる', r.status === 200 && !(await lifecycle(A)).schedules.some(s => s.status === 'pending'), r)
r = await changeConfirmed(admin, A, { to_type: 'own_employee', effective_date: future, hire_date: '' })
ok('#82 （前提）もう一度予約する', r.status === 200 && r.data.scheduled === true, r)

if (PERSIST) {
  // 適用日を今日にして cron を実行する
  await d1w(`UPDATE staff_affiliation_schedules SET effective_date = '${today}', request_json = json_set(request_json, '$.hire_date', '${today}') WHERE staff_id = ${A} AND status = 'pending'`)
  const sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  await waitServer()
  lc = await lifecycle(A)
  ok('#82 cron で適用日の予約を適用する（自社雇用になる）', sc.ok && lc.affiliation_type === 'own_employee' && !lc.schedules.some(s => s.status === 'pending'), [sc.status, lc.affiliation_type, lc.schedules])
  ok('#82 適用した履歴が残る', lc.history[0].to_type === 'own_employee' && String(lc.history[0].note || '').includes('予約'), lc.history[0])
  sh = await shiftsOf(admin, A, dates.pastPlain, dates.d40)
  ok('#82 適用日以降の予定シフトが自社給与の支払先になる', [dates.d1, dates.d5, dates.d40].every(d => byDate(sh, d).payee_type === 'payroll'), sh.map(s => [s.work_date, s.payee_type]))
  ok('#82 #149 適用日より前のシフトは変わらない', byDate(sh, dates.pastPlain).payee_type === 'payroll_daily' && byDate(sh, dates.pastManual).payee_type === 'payroll_daily', sh.map(s => [s.work_date, s.payee_type]))
  ok('#265 従業員管理の入社日は適用日', lc.employee_record && lc.employee_record.hire_date === today, lc.employee_record)

  // ---------- #99 自社雇用 → 日雇い → 自社雇用 で前の雇用期間が残る ----------
  r = await changeConfirmed(admin, A, { to_type: 'daily_worker', effective_date: addDays(today, 1) })
  ok('#99 （前提）自社雇用から日雇いへ（予約）', r.status === 200 && r.data.scheduled, r)
  await d1w(`UPDATE staff_affiliation_schedules SET effective_date = '${today}' WHERE staff_id = ${A} AND status = 'pending'`)
  await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`); await waitServer()
  lc = await lifecycle(A)
  ok('#99 （前提）日雇いに切り替わり、雇用終了日が入る', lc.affiliation_type === 'daily_worker' && lc.employee_record.employment_ended_at === addDays(today, -1), lc.employee_record)
  pv = await change(A, { to_type: 'own_employee', effective_date: today, hire_date: today, dry_run: true })
  ok('#99 確認: 前の雇用期間を履歴に残すと表示する', pv.status === 200 && pv.data.effects.some(x => x.includes('雇用期間の履歴に残します')), pv.data.effects)
  r = await change(A, { to_type: 'own_employee', effective_date: today, hire_date: today, preview_token: pv.data.preview_token })
  lc = await lifecycle(A)
  ok('#99 再雇用しても、前の雇用期間（入社日・雇用終了日）が残る', r.status === 200 && lc.employment_periods.length === 1 && lc.employment_periods[0].hire_date === today && lc.employment_periods[0].employment_ended_at === addDays(today, -1), lc.employment_periods)
  ok('#99 従業員管理は再開される', lc.affiliation_type === 'own_employee' && !lc.employee_record.employment_ended_at, lc.employee_record)
} else console.log('SKIP  #82 cron での予約の適用・#99（PERSIST 未指定）')

// ---------- #121 シフトが多いスタッフ（100件超）でも1回で最後まで置き換える ----------
{
  const B = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 多数`, phone: phone(2), affiliation_type: 'daily_worker' }), 'staff-quick B').staff_id
  const all = [0, 1, 2, 3, 4, 5, 6]
  must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [B], date_from: addDays(today, 1), date_to: addDays(today, 90), weekdays: all, start_time: '10:00', end_time: '18:00' }), 'bulk 1')
  must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [B], date_from: addDays(today, 91), date_to: addDays(today, 130), weekdays: all, start_time: '10:00', end_time: '18:00' }), 'bulk 2')
  r = await changeConfirmed(admin, B, { to_type: 'freelance', trade_name: `${PFX}屋号`, effective_date: today })
  const list = await shiftsOf(admin, B, addDays(today, 1), addDays(today, 130))
  ok('#121 130件のシフトを1回の実行で置き換える', r.status === 200 && r.data.affected_shifts === 130 && list.length === 130 && list.every(s => s.payee_type === 'freelance'), [r.status, r.data, list.filter(s => s.payee_type !== 'freelance').length])
}

// ---------- #121 途中で失敗したら何も変わらず、やり直せる ----------
if (PERSIST) {
  const C = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 失敗`, phone: phone(3), affiliation_type: 'daily_worker' }), 'staff-quick C').staff_id
  for (const n of [1, 2, 3]) must(await admin.post('/api/admin/shifts', { staff_id: C, project_id: pid, work_date: addDays(today, n), start_time: '10:00', end_time: '19:00' }), 'shift C')
  const list = await shiftsOf(admin, C, addDays(today, 1), addDays(today, 3))
  // 最後のシフトの更新だけが失敗するようにする（テスト用の DB にだけ作るトリガー）
  await d1w(`CREATE TRIGGER test_w2sc_fail BEFORE UPDATE OF payee_type ON shifts WHEN NEW.shift_id = ${list[2].shift_id} BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
  const hist0 = (await lifecycle(C)).history.length
  r = await changeConfirmed(admin, C, { to_type: 'freelance', effective_date: today })
  let lcC = await lifecycle(C)
  let listC = await shiftsOf(admin, C, addDays(today, 1), addDays(today, 3))
  ok('#121 途中で失敗すると、区分・シフト・履歴のどれも変わらない', r.status >= 500 && lcC.affiliation_type === 'daily_worker' && lcC.history.length === hist0 && listC.every(s => s.payee_type === 'payroll_daily'), [r.status, lcC.affiliation_type, lcC.history.length, listC.map(s => s.payee_type)])
  await d1w('DROP TRIGGER test_w2sc_fail')
  r = await changeConfirmed(admin, C, { to_type: 'freelance', effective_date: today })
  lcC = await lifecycle(C)
  listC = await shiftsOf(admin, C, addDays(today, 1), addDays(today, 3))
  ok('#121 原因を取り除けば、もう一度実行できる', r.status === 200 && lcC.affiliation_type === 'freelance' && listC.every(s => s.payee_type === 'freelance'), [r.status, lcC.affiliation_type, listC.map(s => s.payee_type)])
} else console.log('SKIP  #121 途中の失敗（PERSIST 未指定）')

// ---------- #140 #237 企業間チャット ----------
{
  const hq = client(await login('sample', 'hq'))
  const code = PFX.toLowerCase() + 'h'
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX}稼働先株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const host = client(await login(code, 'admin'))
  // 所属元（sample）の自社雇用スタッフを稼働先に連携する
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}E1`, name: `${PFX} 連携`, password: 'pass1234' }), 'staff')
  const E = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}E1`)
  const terms = await host.get('/api/admin/roster/consent-terms')
  const hostRow = must(await host.post('/api/admin/roster/link', { code: E.global_staff_code, agreed: true, consent_version: terms.data.version }), 'link').staff_id
  must(await host.post(`/api/admin/roster-chat/${hostRow}`, { body: '稼働先からの連絡1' }), 'chat host→owner')

  // #140 所属元で区分を変えても、連携先とのスレッドを開いて既読にできる
  pv = await change(E.staff_id, { to_type: 'daily_worker', effective_date: today, dry_run: true })
  ok('#140 確認: 他社への連携が続くことを表示する', pv.status === 200 && pv.data.effects.some(x => x.includes('他社への連携 1 件は継続')), pv.data?.effects)
  r = await change(E.staff_id, { to_type: 'daily_worker', effective_date: today, preview_token: pv.data.preview_token })
  ok('#140 （前提）所属元で自社雇用から日雇いに変更', r.status === 200, r)
  const links = must(await admin.get(`/api/admin/roster/${E.staff_id}/links`), 'links')
  ok('#140 区分を変えた後も、連携先の一覧（チャット欄のスレッド）が取れる', links.links.length === 1 && links.links[0].linked_staff_id === hostRow, links)
  let unread = must(await admin.get('/api/admin/roster-chat/unread-count'), 'unread').unread
  const msg = await admin.get(`/api/admin/roster-chat/${E.staff_id}?host_staff_id=${hostRow}`)
  const unread2 = must(await admin.get('/api/admin/roster-chat/unread-count'), 'unread').unread
  ok('#140 所属元でスレッドを開いて読め、未読が減る', msg.status === 200 && msg.data.messages.length === 1 && unread2 === unread - 1, [msg.status, unread, unread2])

  // #237 稼働先が連携行を自社管理に切り替えると、スレッドは閲覧のみで残り、未読を消せる
  // 既読は「最後に読んだメッセージ」で管理するので、稼働先の未読（所属元の最後の投稿）を残す
  must(await host.post(`/api/admin/roster-chat/${hostRow}`, { body: '稼働先からの連絡2' }), 'chat host→owner 2')
  must(await admin.post(`/api/admin/roster-chat/${E.staff_id}`, { body: '所属元からの連絡', host_staff_id: hostRow }), 'chat owner→host')
  pv = await host.post(`/api/admin/staff/${hostRow}/affiliation-change`, { to_type: 'daily_worker', effective_date: today, dry_run: true })
  ok('#237 確認: 所属元とのチャットが終わり、一覧から閲覧できると表示する', pv.status === 200 && pv.data.effects.some(x => x.includes('企業間チャット')), pv.data?.effects)
  r = await host.post(`/api/admin/staff/${hostRow}/affiliation-change`, { to_type: 'daily_worker', effective_date: today, preview_token: pv.data.preview_token })
  ok('#237 （前提）稼働先で連携スタッフを自社管理（日雇い）に変更', r.status === 200, r)
  for (const [label, api, expectUnread] of [['稼働先', host, 1], ['所属元', admin, 0]]) {
    const before = must(await api.get('/api/admin/roster-chat/unread-count'), 'unread').unread
    const th = must(await api.get('/api/admin/roster-chat/threads'), 'threads')
    const t = th.threads.find(x => x.thread_staff_id === hostRow)
    ok(`#237 ${label}: 連携が終わったスレッドが一覧に「連携終了」で出て、未読数がバッジと合う`, t && t.ended === true && t.unread === expectUnread && th.unread_total === before, [t, th.unread_total, before])
    const ended = await api.get(`/api/admin/roster-chat/ended/${hostRow}`)
    ok(`#237 ${label}: 閲覧のみで開ける（3件）`, ended.status === 200 && ended.data.messages.length === 3 && ended.data.thread.ended === true, ended)
    const after = must(await api.get('/api/admin/roster-chat/unread-count'), 'unread').unread
    ok(`#237 ${label}: 開くと未読が消える`, after === before - expectUnread, [before, after])
  }
  r = await host.post(`/api/admin/roster-chat/${hostRow}`, { body: '終了後の投稿' })
  ok('#237 連携が終わったスレッドには投稿できない', r.status === 404, r)
  const other = await host.get(`/api/admin/roster-chat/ended/${A}`)
  ok('#237 参加していないスレッド（チャットのない自社以外の行）は開けない', other.status === 404, other.status)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
