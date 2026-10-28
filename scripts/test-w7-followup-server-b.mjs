// 持ち越しの仕上げ（サーバー：シフト・精算・打刻・日報・ダッシュボード・その他。w7-followup-server-b）の統合テスト
//   #170 締めた期間のシフトボードの操作 / #283 欠勤から戻したシフトのキャンセル料 / #159 一括登録・コピー・募集の承認の操作履歴 /
//   #392 打刻修正の申請の束（batch_key）と本部のメール送信数 / #548 修正して承認の通知 / #556 スキルの区切り / #153 終了した案件の枠 /
//   #447 推薦コメント / #564 単体登録・統合の交通費の標準 / #541 #485 統合の付け替え / #123 連携先の電話番号の照合 /
//   #169 インシデントの対応状況 / #163 報告用URLからの連絡の通知・予定確認URLの連絡先 / #165 規則より前のキー / #359 同名の同時登録 /
//   #297 書類の期限の ToDo / #427 端末時刻の印と取消 / #324 #532 精算の確認事項 / #173 現場責任者の連絡先 / #281 ログインのない人へのメール / #167 割増の見込み
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8811 PERSIST=<保存先> node scripts/test-w7-followup-server-b.mjs
//   PERSIST（ローカルの D1 の保存先）があれば、トリガー（#283）と規則より前のテンプレート（#165）を D1 に直接書いて確かめる（無ければその項目は飛ばす）
import { execSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const headers = { Cookie: cookie || '' }
    if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json'
    const opts = { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) }
    // wrangler d1 execute（sql）の間に閉じられた接続を使ったときは、1回だけ送り直す（送る前に切れているので二重にはならない）
    const r = await fetch(`${BASE}${path}`, opts).catch(e => { if (e && e.cause && e.cause.code === 'ECONNRESET') return fetch(`${BASE}${path}`, opts); throw e })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const pub = client('')
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const sql = (command) => JSON.parse(execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --json --command "${command.replace(/\s*\n\s*/g, ' ').replace(/"/g, '\\"')}"`, { stdio: 'pipe' }).toString())[0].results
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

const PFX = 'W7B' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')

async function newProject(name, extra = {}) {
  return must(await admin.post('/api/admin/projects', { project_name: name, allow_duplicate: true, ...extra }), 'project ' + name).project_id
}
async function newStaff(k, extra = {}) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: phoneOf(), ...extra }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`).staff_id
}
async function newShift(staff_id, project_id, work_date, extra = {}) {
  const memo = `${PFX}-${++seq}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '19:00', memo, ...extra })
  if (r.status !== 200) throw new Error('shift ' + r.text)
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
}
async function newSlot(project_id, work_date, roles = [{ role_name: '販売', headcount: 2 }]) {
  const id = must(await admin.post('/api/admin/shift-slots', { project_id, work_date, start_time: '10:00', end_time: '19:00', roles }), 'slot').slot_ids[0]
  return must(await admin.get(`/api/admin/shift-slots/${id}`), 'slot get')
}
const roleIdOf = (slotView) => (slotView.roles || slotView.slot?.roles || [])[0]?.slot_role_id
const proxy = (id, times) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: Object.keys(times), times })

const P = await newProject(`${PFX}-案件`)
const SA = await newStaff('A'), SB = await newStaff('B')

// ---------- #170 締めた期間のシフトボードの操作 ----------
{
  // 過去（2021年）の週を1つ選んで締める（実行ごとに別の週。シードのシフトのない期間）
  let mon = addDays('2021-01-04', 7 * (Date.now() % 50))
  while (weekday(mon) !== 1) mon = addDays(mon, -1)
  const sun = addDays(mon, 6)
  // 締めの対象は確定・代打のシフトだけなので、希望（仮）のシフトは締めた期間に残せる
  const req = await newShift(SA, P, mon, { status: 'requested' })
  const slot = await newSlot(P, addDays(mon, 1))
  const roleId = roleIdOf(slot)
  let cr = await admin.post('/api/admin/settlement/closings', { from: mon, to: sun, note: PFX })
  if (cr.status === 409 && cr.data && cr.data.need_force) cr = await admin.post('/api/admin/settlement/closings', { from: mon, to: sun, note: PFX, force: true })
  ok('（前提）期間を締めた', cr.status === 200, cr.data)
  const closingId = cr.data && cr.data.closing_id
  const asg = await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [SB], force: true })
  ok('#170 締めた期間の枠には割り当てない（409）', asg.status === 409 && /締め/.test(asg.data && asg.data.error), asg.data)
  const pr = await admin.put(`/api/admin/shifts/${req.shift_id}/price`, { bill_rate: 20000 })
  ok('#170 締めた期間のシフトの金額は変えない（409）', pr.status === 409 && /締め/.test(pr.data && pr.data.error), pr.data)
  const cf = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: [req.shift_id], force: true })
  ok('#170 締めた期間の希望（仮）は確定にしない（理由を返す）', cf.status === 200 && cf.data.confirmed === 0 && (cf.data.skipped || []).some(x => /締め/.test(x.reason)), cf.data)
  const bulk = await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [SB], date_from: mon, date_to: mon, weekdays: [1], start_time: '10:00', end_time: '12:00' })
  ok('#170 一括登録は締めた日をスキップする（理由「締め」）', bulk.status === 200 && bulk.data.created === 0 && (bulk.data.skipped || []).some(x => x.reason === '締め'), bulk.data)
  const rp = await admin.post('/api/admin/shifts/reprice', { from: mon, to: sun, project_id: P, dry_run: true })
  ok('#170 単価ルールの再適用の対象に締めた期間のシフトを入れない', rp.status === 200 && rp.data.count === 0, rp.data)
  if (closingId) must(await admin.post(`/api/admin/settlement/closings/${closingId}/reopen`, { reason: `${PFX} テストの後片付け` }), 'reopen')
  const asg2 = await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [SB], force: true })
  ok('#170 締めを解除すると割り当てられる', asg2.status === 200 && asg2.data.shift_ids.length === 1, asg2.data)
}

// ---------- #159 一括登録・コピーの操作履歴、前日確認の列 ----------
{
  let d = addDays(today, 20)
  while (weekday(d) !== 2) d = addDays(d, 1)
  const bulk = must(await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [SA], date_from: d, date_to: d, weekdays: [2], start_time: '09:00', end_time: '12:00' }), 'bulk')
  ok('（前提）一括登録で1件作った', bulk.created === 1, bulk)
  const logs = must(await admin.get(`/api/admin/operation-logs?action=bulk_create&staff_id=${SA}`), 'logs').logs
  ok('#159 常勤の一括登録で作ったシフトの操作履歴が残る', logs.some(l => l.action === 'bulk_create' && l.summary.work_date === d && l.action_label === '常勤の一括登録'), logs.slice(0, 2))
  // 前週のコピー（コピー先は4週後）
  const cp = await admin.post('/api/admin/shifts/copy-week', { source_from: d, target_from: addDays(d, 28), days: 1, project_ids: [P], force: true })
  ok('（前提）前週のコピーで1件以上作った', cp.status === 200 && cp.data.shifts >= 1, cp.data)
  const logs2 = must(await admin.get(`/api/admin/operation-logs?action=copy_week&staff_id=${SA}`), 'logs2').logs
  ok('#159 前週のコピーで作ったシフトの操作履歴が残る', logs2.some(l => l.summary.work_date === addDays(d, 28)), logs2.slice(0, 2))
  ok('#159 操作履歴の項目に前日確認の列がある', !!(must(await admin.get('/api/admin/operation-logs?action=copy_week'), 'logs3').logs[0]?.changes || []).length)
}

// ---------- #283 欠勤から別の状態に変えたシフトのキャンセル料（トリガー） ----------
if (PERSIST) {
  const s = await newShift(SA, P, addDays(today, -3))
  must(await admin.put(`/api/admin/shifts/${s.shift_id}`, { status: 'absent', cancel_reason: 'client' }), 'absent')
  sql(`UPDATE shift_cancellations SET bill_amount = 5000 WHERE shift_id = ${Number(s.shift_id)}`)
  sql(`UPDATE shifts SET status = 'confirmed' WHERE shift_id = ${Number(s.shift_id)}`)
  const left = sql(`SELECT COUNT(*) AS n FROM shift_cancellations WHERE shift_id = ${Number(s.shift_id)}`)[0].n
  ok('#283 欠勤から別の状態に変えると、キャンセル料・補償の行は消える（どの経路でも）', left === 0, left)
} else console.log('SKIP  #283（PERSIST がないため）')

// ---------- #556 スキルの区切り（読点）と一致・不足の名前 ----------
{
  const P2 = await newProject(`${PFX}-スキル案件`)
  must(await admin.put(`/api/admin/projects/${P2}/required-skills`, { required_skills: '接客,レジ,品出し' }), 'skills')
  const SK = await newStaff('SK', { skills: '接客、レジ' })
  const slot = await newSlot(P2, addDays(today, 15))
  const cand = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${roleIdOf(slot)}`), 'candidates')
  const me = (cand.candidates || cand.staff || []).find(x => x.staff_id === SK)
  ok('#556 スタッフのスキルが読点区切りでも一致を数える（2/3）', me && me.skill_match === 2 && me.skill_required === 3, me)
  ok('#556 一致したスキルと足りないスキルの名前を返す', me && JSON.stringify(me.skill_matched) === JSON.stringify(['接客', 'レジ']) && JSON.stringify(me.skill_missing) === JSON.stringify(['品出し']), me)
}

// ---------- #153 終了した案件には募集枠を作らない ----------
{
  const P3 = await newProject(`${PFX}-終了案件`)
  must(await admin.put(`/api/admin/projects/${P3}`, { status: 'closed', confirm_close: true }), 'close project')
  const r = await admin.post('/api/admin/shift-slots', { project_id: P3, work_date: addDays(today, 5), start_time: '10:00', end_time: '19:00', roles: [{ role_name: '販売', headcount: 1 }] })
  ok('#153 終了した案件の募集枠は作れない（400）', r.status === 400 && /終了した案件/.test(r.data.error), r.data)
  const r2 = await admin.post('/api/admin/slot-patterns', { project_id: P3, weekdays: [1, 2, 3], date_from: addDays(today, 3), date_to: addDays(today, 20), start_time: '10:00', end_time: '19:00', roles: [{ role_name: '販売', headcount: 1 }] })
  ok('#153 終了した案件の繰り返し登録も作れない（400）', r2.status === 400, r2.data)
}

// ---------- #447 スキルシートの推薦コメント ----------
{
  must(await admin.put(`/api/admin/staff/${SA}`, { memo: `${PFX} 社内メモ` }), 'memo')
  let sheet = must(await admin.get(`/api/admin/staff/${SA}/skill-sheet`), 'sheet')
  ok('#447 推薦コメントが空なら空（固定文を入れない）・管理者メモは返さない', sheet.skill_sheet_comment === '' && !JSON.stringify(sheet).includes('社内メモ'), sheet.skill_sheet_comment)
  const long = await admin.put(`/api/admin/staff/${SA}/skill-sheet-comment`, { comment: 'あ'.repeat(1001) })
  ok('#447 推薦コメントは1000文字まで（400）', long.status === 400, long.data)
  must(await admin.put(`/api/admin/staff/${SA}/skill-sheet-comment`, { comment: `${PFX} 接客が丁寧です` }), 'comment')
  sheet = must(await admin.get(`/api/admin/staff/${SA}/skill-sheet`), 'sheet2')
  ok('#447 保存した推薦コメントをスキルシートで返す', sheet.skill_sheet_comment === `${PFX} 接客が丁寧です`, sheet.skill_sheet_comment)
  const other = await admin.put('/api/admin/staff/999999/skill-sheet-comment', { comment: 'x' })
  ok('#447 自社にないスタッフは 404', other.status === 404)
}

// ---------- #564 単体のシフト登録で交通費の標準を使う・統合で付け替える（#541 #485 も） ----------
{
  must(await admin.put('/api/admin/transport-defaults', { staff_id: SB, site_id: 0, amount: 730 }), 'td')
  const s1 = await newShift(SB, P, addDays(today, 7))
  ok('#564 交通費の入力がない単体のシフト登録は、スタッフの標準を入れる', Number(s1.transportation_fee) === 730, s1.transportation_fee)
  const s2 = await newShift(SB, P, addDays(today, 8), { transportation_fee: 0 })
  ok('#564 交通費を入れたとき（0 円を含む）は、その値のまま', Number(s2.transportation_fee) === 0, s2.transportation_fee)
  // 統合元（仮登録）に標準を入れて統合する
  const q = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 仮`, phone: phoneOf(), affiliation_type: 'daily_worker', force: true }), 'quick')
  must(await admin.put('/api/admin/transport-defaults', { staff_id: q.staff_id, site_id: 0, amount: 999 }), 'td src')
  const T = await newStaff('T')
  const mg = await admin.post(`/api/admin/staff/${q.staff_id}/merge`, { target_staff_id: T, force: true })
  ok('（前提）仮登録を統合できた', mg.status === 200, mg.data)
  const defs = must(await admin.get('/api/admin/transport-defaults'), 'tds').defaults
  ok('#564 統合で交通費の標準を統合先へ付け替える', defs.some(d => d.staff_id === T && d.amount === 999) && !defs.some(d => d.staff_id === q.staff_id), defs.filter(d => [T, q.staff_id].includes(d.staff_id)))
}

// ---------- #548 修正して承認したときの本人への通知 / #392 申請の束 ----------
{
  const st3 = client(await login('sample', 'st003'))
  const d = addDays(today, -2)
  const E = await newShift(3, 1, d)
  must(await proxy(E.shift_id, { check_in: '09:55', check_out: '19:05' }), 'proxy')
  const id = must(await st3.post('/api/staff/corrections', { shift_id: E.shift_id, report_type: 'check_out', kind: 'modify', requested_at: `${d} 18:30`, reason: '退店の時刻の誤り' }), 'request').correction_id
  must(await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${d} 18:15`, comment: '入退室記録で 18:15 を確認' }), 'approve adjusted')
  const nn = must(await st3.get('/api/staff/notifications?kind=correction_approved'), 'staff notif').notifications.find(n => n.related_id === id)
  ok('#548 本人への通知に「申請 18:30 → 承認 18:15」を入れる', nn && /申請 \d+\/\d+ 18:30 → 承認 \d+\/\d+ 18:15/.test(nn.body) && /時刻を修正して/.test(nn.title), nn)

  // 別々に出した2件の申請（同時に送る）は、それぞれ1件の承認依頼（まとめない）
  const F = await newShift(3, 1, addDays(today, -4))
  must(await proxy(F.shift_id, { check_in: '09:58', check_out: '19:02' }), 'proxy F')
  const [a, b] = await Promise.all([
    st3.post('/api/staff/corrections', { shift_id: F.shift_id, report_type: 'check_in', kind: 'modify', requested_at: `${addDays(today, -4)} 09:50`, reason: '別の申請1' }),
    st3.post('/api/staff/corrections', { shift_id: F.shift_id, report_type: 'check_out', kind: 'modify', requested_at: `${addDays(today, -4)} 19:10`, reason: '別の申請2' }),
  ])
  const ids = [a.data && a.data.correction_id, b.data && b.data.correction_id]
  const an = must(await admin.get('/api/admin/notifications?kind=correction_submitted'), 'admin notif').notifications.filter(n => ids.includes(n.related_id))
  ok('#392 別々に出した申請は、同じ秒に届いても1件ずつの承認依頼にする（まとめない）', an.length === 2 && an.every(n => !/ほか/.test(n.title)), an.map(n => n.title))
  // まとめて申請は1通にまとめる（従来どおり）
  const G = await newShift(3, 1, addDays(today, -5))
  must(await proxy(G.shift_id, { check_in: '09:58', check_out: '19:02' }), 'proxy G')
  const bulk = must(await st3.post('/api/staff/corrections/bulk', { shift_id: G.shift_id, reason: 'まとめて', items: [
    { report_type: 'check_in', requested_at: `${addDays(today, -5)} 09:50` }, { report_type: 'check_out', requested_at: `${addDays(today, -5)} 19:10` }] }), 'bulk corrections')
  const bids = (bulk.corrections || []).map(x => x.correction_id)
  const bn = must(await admin.get('/api/admin/notifications?kind=correction_submitted'), 'admin notif2').notifications.filter(n => bids.includes(n.related_id))
  ok('#392 まとめて出した申請は「ほか1件」としてまとめる', bn.length >= 1 && bn.every(n => /ほか1件/.test(n.title)), bn.map(n => n.title))
  for (const x of [...ids, ...bids]) if (x) await admin.post(`/api/admin/corrections/${x}/reject`, { reason: 'テストの後片付け' })
  const stats = must(await hq.get('/api/hq/email-stats'), 'email stats')
  ok('#392 本部のメールの集計に直近24時間の送信数の目安を返す', stats.alert && stats.alert.daily_warn > 0 && Array.isArray(stats.warnings), stats.alert)
}

// ---------- #123 連携先での電話番号の照合（所属元の今の番号。番号は出さない） ----------
{
  const coCode = `${PFX.toLowerCase()}a`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: coCode, company_name: `${PFX}連携先株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company A')
  const A = client(await login(coCode, 'admin'))
  const ph1 = phoneOf(), ph2 = phoneOf()
  const X = await newStaff('X', { phone: ph1 })
  const xRow = must(await admin.get('/api/admin/staff'), 'list').staff.find(s => s.staff_id === X)
  const terms = must(await admin.get('/api/admin/roster/consent-terms'), 'terms')
  const inA = must(await A.post('/api/admin/roster/link', { code: xRow.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
  let m = must(await A.get(`/api/admin/staff-lookup?phone=${ph1}`), 'lookup').matches
  ok('#123 連携先の照合で、所属元の電話番号の人が見つかる（番号は返さない）', m.some(x => x.staff_id === inA && x.phone === null), m)
  // 所属元で電話番号を変える（従業員管理の電話番号 → users.phone にそろえる）
  must(await admin.put(`/api/admin/employees/${X}`, { phone_main: ph2 }), 'emp phone')
  m = must(await A.get(`/api/admin/staff-lookup?phone=${ph2}`), 'lookup2').matches
  const old = must(await A.get(`/api/admin/staff-lookup?phone=${ph1}`), 'lookup3').matches
  ok('#123 所属元で変えた後は、新しい番号で見つかり、古い番号では見つからない', m.some(x => x.staff_id === inA) && !old.some(x => x.staff_id === inA), { m, old })
  const det = await A.get(`/api/admin/staff/${inA}`), list = await A.get('/api/admin/staff')
  const opts = await A.get('/api/admin/staff/options?include=all')
  const leak = [det.text, list.text, opts.text].some(t => t.includes(ph2) || t.includes(ph1))
  ok('#123 連携先のスタッフ詳細・一覧・選択肢に所属元の電話番号を出さない', det.status === 200 && list.status === 200 && !leak)
}

// ---------- #169 インシデントの対応状況（ダッシュボード・案件詳細・報告用URLでの再開） ----------
{
  const P4 = await newProject(`${PFX}-インシデント`)
  const st = client(await login('sample', `${PFX}A`))
  const d = addDays(today, -1)
  const s = await newShift(SA, P4, d)
  const r = await st.post('/api/staff/daily-report', { project_id: P4, shift_id: s.shift_id, work_date: d, values: {}, incident_flag: true, incident_note: '什器の破損' })
  ok('（前提）インシデントの日報を出した', r.status === 200, r.data)
  const dr = ((await admin.get(`/api/admin/daily-reports?date=${d}`)).data.reports || []).find(x => x.shift_id === s.shift_id)
  must(await admin.put(`/api/admin/daily-reports/${dr.daily_report_id}/incident`, { status: 'done', memo: '対応済み' }), 'incident done')
  const dash = must(await admin.get('/api/admin/dashboard'), 'dash')
  const inc = (dash.incidents || []).find(i => i.daily_report_id === dr.daily_report_id)
  ok('#169 ダッシュボードのインシデントに対応状況を付ける', inc && inc.incident_status === 'done', inc)
  ok('#169 対応済みのインシデントは ToDo（ルール4）に数えない', !(dash.todos || []).some(t => t.key === `incident:${P4}`), (dash.todos || []).filter(t => /incident/.test(t.key)))
  const pd = must(await admin.get(`/api/admin/projects/${P4}`), 'project detail')
  ok('#169 案件詳細のインシデントに対応状況を付ける', (pd.incidents || []).some(i => i.daily_report_id === dr.daily_report_id && i.incident_status === 'done'), pd.incidents)
  // 代理入力で新しくクレームの印が付いたら、未対応に戻す
  const pr = await admin.post(`/api/admin/shifts/${s.shift_id}/proxy-daily-report`, { values: {}, incident_flag: true, complaint_flag: true, overwrite: true })
  const pd2 = must(await admin.get(`/api/admin/projects/${P4}`), 'project detail2')
  ok('#169 代理入力で新しく印が付くと、対応済みを未対応に戻す', pr.status === 200 && (pd2.incidents || []).some(i => i.daily_report_id === dr.daily_report_id && i.incident_status === 'open'), { pr: pr.data, inc: pd2.incidents })
}

// ---------- #163 報告用URLからの連絡を管理者に知らせる・予定確認URLでも連絡先を返す ----------
{
  const s = await newShift(SA, P, today)
  const link = must(await admin.post(`/api/admin/shifts/${s.shift_id}/report-link`), 'report link')
  const before = must(await admin.get('/api/admin/notifications?kind=consult_received'), 'n0').notifications.length
  const r = await pub.post(`/api/public/report/${link.token}/consultation`, { kind: 'late', body: `${PFX} 電車の遅れ` })
  ok('（前提）報告用URLから連絡できた', r.status === 200, r.data)
  const after = must(await admin.get('/api/admin/notifications?kind=consult_received'), 'n1').notifications
  ok('#163 報告用URLからの連絡を管理者のアプリ内通知に出す', after.length === before + 1 && after.some(n => n.related_id === r.data.consultation_id), after.slice(0, 2))
  must(await admin.put('/api/admin/settings/site-contact', { emergency_phone: '03-1234-5678', emergency_note: '9時〜18時', far_threshold_m: 500 }), 'emergency')
  const v = must(await pub.get(`/api/public/report/${link.token}`), 'view')
  ok('#173 報告用URLの内容に会社の緊急連絡先を付ける', v.emergency_phone === '03-1234-5678', { e: v.emergency_phone, c: v.contact_phone })
  // 予定確認URLはログインのない人に発行する
  const nl = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 予定確認`, phone: phoneOf(), affiliation_type: 'daily_worker', force: true }), 'quick nl')
  const sl = await admin.post(`/api/admin/staff/${nl.staff_id}/schedule-link`)
  if (sl.status === 200 && sl.data && sl.data.token) {
    const ct = await pub.get(`/api/public/report/${sl.data.token}/contact`)
    ok('#163 予定確認URLでも会社の連絡先を返す', ct.status === 200 && ct.data.phone === '03-1234-5678', ct.data)
  } else ok('（前提）予定確認URLを発行できた', false, sl.data)
}

// ---------- #173 案件の現場責任者の連絡先 ----------
{
  const bad = await admin.put(`/api/admin/projects/${P}`, { site_contact_phone: 'abc' })
  ok('#173 現場責任者の電話番号の形式を確かめる（400）', bad.status === 400, bad.data)
  must(await admin.put(`/api/admin/projects/${P}`, { site_contact_name: '現場 太郎', site_contact_phone: '090-1111-2222' }), 'site contact')
  const st = client(await login('sample', `${PFX}A`))
  const d = addDays(today, 3)
  await newShift(SA, P, d)
  const sh = must(await st.get(`/api/staff/shifts?from=${d}&to=${d}`), 'staff shifts').shifts.find(x => x.project_id === P)
  ok('#173 スタッフのシフトに現場責任者の連絡先を付ける', sh && sh.site_contact_phone === '090-1111-2222' && sh.site_contact_name === '現場 太郎', sh)
}

// ---------- #165 規則より前に作ったテンプレートの既存のキー ----------
if (PERSIST) {
  const name = `${PFX}-旧テンプレート`
  sql(`INSERT INTO report_templates (company_id, template_name, template_type, fields_json, status) VALUES (1, '${name}', 'custom', '[{"key":"架電数","label":"架電数","type":"number"}]', 'active')`)
  const tid = sql(`SELECT template_id FROM report_templates WHERE template_name = '${name}'`)[0].template_id
  const r1 = await admin.put(`/api/admin/templates/${tid}`, { fields: [{ key: '架電数', label: '架電した数', type: 'number' }] })
  ok('#165 規則より前のキー（日本語）のままでも表示名を直せる', r1.status === 200, r1.data)
  const r2 = await admin.put(`/api/admin/templates/${tid}`, { fields: [{ key: '架電数', label: '架電した数', type: 'number' }, { key: '新しい項目', label: '新', type: 'text' }] })
  ok('#165 新しく足す項目のキーには規則を当てる（400）', r2.status === 400, r2.data)
} else console.log('SKIP  #165（PERSIST がないため）')

// ---------- #359 同名の案件・クライアントの同時登録 ----------
{
  const name = `${PFX}-同時`
  const rs = await Promise.all([1, 2, 3].map(() => admin.post('/api/admin/projects', { project_name: name })))
  ok('#359 同名の案件を同時に登録しても1件だけ（ほかは 409）', rs.filter(r => r.status === 200).length === 1 && rs.filter(r => r.status === 409).length === 2, rs.map(r => r.status))
  const cn = `${PFX}-同時クライアント`
  const cs = await Promise.all([1, 2, 3].map(() => admin.post('/api/admin/clients', { client_name: cn })))
  ok('#359 同名のクライアントを同時に登録しても1件だけ', cs.filter(r => r.status === 200).length === 1, cs.map(r => r.status))
  const again = await admin.post('/api/admin/projects', { project_name: name, allow_duplicate: true })
  ok('#359 確認のうえ（allow_duplicate）なら同名でも登録できる', again.status === 200)
}

// ---------- #297 有効期限が近い書類の ToDo と一覧の件数 ----------
{
  const fd = new FormData()
  fd.append('files', new Blob(['test'], { type: 'text/plain' }), `${PFX}.txt`)
  fd.append('doc_type', 'qualification')
  fd.append('valid_until', addDays(today, -1))
  const up = await admin.post(`/api/admin/staff/${SA}/documents`, fd)
  ok('（前提）期限切れの書類を登録した', up.status === 200, up.data)
  const dash = must(await admin.get('/api/admin/dashboard'), 'dash')
  const t = [...(dash.todos || []), ...(dash.todos_hidden || [])].find(x => x.key === 'docs_expiring')
  ok('#297 有効期限が切れた書類を ToDo に出す', t && t.level === 'high' && t.href === '#staff-requests', t)
  const row = must(await admin.get('/api/admin/staff'), 'list').staff.find(s => s.staff_id === SA)
  ok('#297 スタッフ一覧に期限が近い・切れた書類の件数を返す', row && row.doc_expiring >= 1, row && row.doc_expiring)
  const cl = must(await admin.get('/api/admin/clients'), 'clients').clients
  ok('#297 クライアント一覧にも件数の列を返す', cl.length && cl.every(x => typeof x.doc_expiring === 'number'))
}

// ---------- #427 端末時刻の印（報告状況・打刻データ）と取消の時間 ----------
{
  const st = client(await login('sample', `${PFX}B`))
  const now = jstNow()
  const hh = Number(now.slice(11, 13))
  // 今の時刻の前後に収まるシフト（日をまたがない範囲）
  const start = `${String(Math.max(0, hh - 1)).padStart(2, '0')}:00`, end = `${String(Math.min(23, hh + 2)).padStart(2, '0')}:59`
  const s = await newShift(SB, P, today, { start_time: start, end_time: end })
  const key = () => `${PFX}${Math.random().toString(36).slice(2, 12)}`
  const r = await st.post('/api/staff/attendance', { shift_id: s.shift_id, report_type: 'wake_up', client_request_id: key(), pressed_at: Date.now() - 20 * 60000, latitude: null, longitude: null })
  if (r.status === 200 && r.data.device_time) {
    const rs = must(await admin.get(`/api/admin/shifts/${s.shift_id}/report-status`), 'report status').reports.find(x => x.report_type === 'wake_up')
    ok('#427 報告状況に端末時刻の印と受け取った時刻を出す', rs && rs.device_time === true && !!rs.received_at, rs)
    const ph = must(await admin.get(`/api/admin/shifts/${s.shift_id}/attendance-photos`), 'photos').reports.find(x => x.report_type === 'wake_up')
    ok('#427 写真・端末の一覧にも端末時刻の印を出す', ph && ph.device_time === true, ph)
    const pu = must(await admin.get(`/api/admin/attendance-punches?from=${today}&to=${today}&staff_id=${SB}`), 'punches')
    ok('#427 打刻データの一覧で端末時刻の報告を数える', pu.counts.device_time >= 1, pu.counts)
    const wd = await st.post('/api/staff/attendance/withdraw', { shift_id: s.shift_id, report_type: 'wake_up' })
    ok('#427 押した時刻で記録した報告も、受け取ってから5分以内なら取り消せる', wd.status === 200, wd.data)
  } else console.log('SKIP  #427（端末時刻で記録できる時間帯ではない）', r.status, r.data && r.data.error)
}

// ---------- #324 #532 精算の確認事項 ----------
{
  const d = addDays(today, -6)
  const s = await newShift(SA, P, d)
  must(await proxy(s.shift_id, { check_in: '10:00', break_start: '13:00', break_end: '13:02', check_out: '19:00' }), 'proxy break')
  // 報告用URLで2台の端末から報告した（端末IDの違う2件。D1 に直接入れる）
  const s2 = await newShift(SB, P, addDays(today, -1))
  if (PERSIST) for (const [t, dev] of [['check_in', 'dev1'], ['check_out', 'dev2']]) {
    sql(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, entry_method, device_id, device_info)
      VALUES (1, ${Number(SB)}, ${Number(s2.shift_id)}, '${t}', '${addDays(today, -1)} ${t === 'check_in' ? '10:00' : '19:00'}:00', 'normal', 'link', '${PFX}${dev}', 'Mozilla/5.0 test ${dev}')`)
  }
  const rows = must(await admin.get(`/api/admin/settlement?from=${addDays(today, -6)}&to=${addDays(today, -1)}&project_id=${P}`), 'settle').rows
  const r1 = rows.find(x => x.shift_id === s.shift_id), r2 = rows.find(x => x.shift_id === s2.shift_id)
  ok('#324 休憩が極端に短い（2分）ことを精算の確認事項に出す', r1 && r1.issues.some(i => /休憩が極端に短い/.test(i)), r1 && r1.issues)
  if (PERSIST) ok('#532 報告用URLで2台以上の端末から報告したことを精算の確認事項に出す', r2 && r2.issues.some(i => /2台以上の端末/.test(i)), r2 && r2.issues)
  else console.log('SKIP  #532（PERSIST がないため）')
}

// ---------- #281 ログインのない人にもお知らせをメールで送る ----------
{
  const q = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} ログインなし`, phone: phoneOf(), affiliation_type: 'daily_worker', force: true }), 'quick')
  if (PERSIST) sql(`UPDATE staff_profiles SET unverified_email = '${PFX.toLowerCase()}@example.com' WHERE staff_id = ${Number(q.staff_id)}`)
  const r = await admin.post('/api/admin/notices', { title: `${PFX} 連絡`, body: 'テスト', target_type: 'staff', target_ids: String(q.staff_id), importance: 'important', send_email: true, email_nologin: true })
  ok('#281 ログインのない人あてのメールの件数を返す', r.status === 200 && r.data.email && r.data.email.nologin_with_email === (PERSIST ? 1 : 0), r.data)
  const list = must(await admin.get('/api/admin/notices'), 'notices').notices.find(n => n.notice_id === r.data.notice_id)
  ok('#281 お知らせに email_nologin を保存する', list && list.email_nologin === 1, list)
}

// ---------- #167 案件詳細の支払見込みに確定時の割増を入れる ----------
if (PERSIST) {
  const P5 = await newProject(`${PFX}-割増`)
  const d = today.slice(0, 8) + '01' > addDays(today, -1) ? today : addDays(today, -1)
  const s = await newShift(SA, P5, d)
  const before = must(await admin.get(`/api/admin/projects/${P5}`), 'pd').month_summary.pay_total
  sql(`UPDATE shifts SET pay_premium = 1234, pay_amount = COALESCE(pay_amount, 0) WHERE shift_id = ${Number(s.shift_id)}`)
  const after = must(await admin.get(`/api/admin/projects/${P5}`), 'pd2').month_summary.pay_total
  ok('#167 案件詳細の今月の支払見込みに割増（pay_premium）を入れる', after - before === 1234 || (before === 0 && after >= 1234), { before, after })
} else console.log('SKIP  #167（PERSIST がないため）')

const fail = results.filter(r => !r.pass)
console.log(`\n${results.length - fail.length}/${results.length} passed`)
if (fail.length) process.exit(1)
