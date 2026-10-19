// 打刻修正のスタッフ側（w4-corrections-staff: #214 #215 #306 #312 #341 #358 #392 #399 #484 #486）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8818 PERSIST=<保存先> node scripts/test-w4-corrections-staff.mjs
//   PERSIST を渡すと、API では変えられない会社設定（申請の受付期限）をローカルの D1 に直接書いて確かめる（--local のみ）。渡さないときは、その部分を飛ばす
// 画面だけの修正（#261 警告の出し直し、#342 既定の時刻、#401 報告の一覧と定型の理由）は、このテストでは確かめない
import { execSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:8818'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const req = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await req().catch(e => { if (e?.cause?.code === 'ECONNRESET') return req(); throw e })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sql = (command) => execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --json --command "${command}"`, { stdio: 'pipe' }).toString()
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))   // user_id 1（会社管理者）
const st5 = client(await login('sample', 'st005'))     // staff_id 5（user_id 8）
const st6 = client(await login('sample', 'st006'))     // staff_id 6（user_id 9）
let seq = 0
async function createShift(staff_id, work_date, start_time = '10:00', end_time = '19:00') {
  const memo = `W4CS-${Date.now()}-${++seq}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id: 1, work_date, start_time, end_time, memo }), 'createShift')
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo).shift_id
}
const proxy = (id, times) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: Object.keys(times), times })
const reportAt = async (id, t) => ((await admin.get(`/api/admin/shifts/${id}/report-status`)).data.reports.find(x => x.report_type === t) || {}).reported_at || null
const staffNotes = async (cl) => (await cl.get('/api/staff/notifications')).data.notifications
const deliveries = async () => (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries
const myList = async (cl) => (await cl.get('/api/staff/corrections')).data.corrections

// ---------- #312 勤務日と関係のない日時・まだ来ていない日時 ----------
{
  const d = addDays(today, -2)
  const A = await createShift(5, d)
  must(await proxy(A, { check_in: '09:55' }), 'proxy')
  let r = await st5.post('/api/staff/corrections', { shift_id: A, report_type: 'wake_up', kind: 'add', requested_at: `${addDays(d, 1)} 07:00`, reason: '起床の押し忘れ', dry_run: true })
  ok('#312 起床報告を稼働日の翌日の日時で申請すると 400（報告の種類ごとの受付時間帯の外）', r.status === 400 && /起床報告/.test(r.data.error), r)
  r = await st5.post('/api/staff/corrections', { shift_id: A, report_type: 'wake_up', kind: 'add', requested_at: `${d} 07:00`, reason: '起床の押し忘れ', dry_run: true })
  ok('#312 稼働日の朝の起床報告は受け付ける', r.status === 200, r)
  const F = await createShift(5, addDays(today, 2))
  r = await st5.post('/api/staff/corrections', { shift_id: F, report_type: 'wake_up', kind: 'add', requested_at: `${addDays(today, 2)} 06:00`, reason: '先に申請', dry_run: true })
  ok('#312 まだ来ていない日時は申請できない（400）', r.status === 400 && /まだ来ていない/.test(r.data.error), r)
  r = await admin.post('/api/admin/corrections', { shift_id: F, report_type: 'check_in', kind: 'add', requested_at: `${addDays(today, 2)} 09:50`, reason: '管理者による先回りの申請', dry_run: true })
  ok('#312 管理者の申請でも、まだ来ていない日時は 400', r.status === 400, r)
}

// ---------- #214 隣の報告とぶつかる修正をまとめて申請する ----------
{
  const d = addDays(today, -3)
  const B = await createShift(5, d)
  must(await proxy(B, { check_in: '10:20', work_start: '10:21', work_end: '18:00', check_out: '18:01' }), 'proxy B')
  let r = await st5.post('/api/staff/corrections', { shift_id: B, report_type: 'work_start', kind: 'modify', requested_at: `${d} 10:00`, reason: '遅れて押した', dry_run: true })
  ok('#214 1件だけ直すと順序の矛盾で 400、まとめて申請できることを案内する', r.status === 400 && /まとめて申請/.test(r.data.error), r)
  const items = [{ report_type: 'work_start', requested_at: `${d} 10:00` }, { report_type: 'check_in', requested_at: `${d} 09:55` }]
  r = await st5.post('/api/staff/corrections/bulk', { shift_id: B, reason: '入店と勤務開始を遅れて押した', items, dry_run: true })
  ok('#214 まとめて申請の確認（dry_run）は、直した後の組み合わせで順序を確かめて通る', r.status === 200 && r.data.items.length === 2 && !r.data.warnings.length, r)
  ok('#214 承認できる順番（入店 → 勤務開始）に並べる', r.status === 200 && r.data.items.map(x => x.report_type).join() === 'check_in,work_start', r.data && r.data.items)
  // 一部に誤りがあれば全件を受け付けない
  r = await st5.post('/api/staff/corrections/bulk', { shift_id: B, reason: 'x', items: [...items, { report_type: 'check_out', requested_at: `${addDays(today, 3)} 18:30` }] })
  ok('#214 1件でも誤りがあれば全件を受け付けない（400・どの報告かを返す）', r.status === 400 && r.data.report_type === 'check_out', r)
  ok('#214 失敗したときは申請が1件も登録されない', !(await myList(st5)).some(c => c.shift_id === B), null)
  const delivBefore = (await deliveries()).length
  r = await st5.post('/api/staff/corrections/bulk', { shift_id: B, reason: '入店と勤務開始を遅れて押した', items })
  ok('#214 まとめて申請できる', r.status === 200 && r.data.corrections.length === 2, r)
  const [c1, c2] = r.data.corrections
  ok('#214 承認待ちの一覧の上（ID の小さい方）が先に承認すべき入店', c1.report_type === 'check_in' && c2.report_type === 'work_start' && c1.correction_id < c2.correction_id, r.data.corrections)
  // #392 承認依頼メールは先頭の1件にまとめる。#341 申請者本人の受付メールは送らない
  const ds = (await deliveries()).slice(0, (await deliveries()).length - delivBefore)
  ok('#392 まとめて出した申請の承認依頼メールは先頭の1件だけ（2件目には作らない）', ds.some(x => x.correction_id === c1.correction_id && x.kind === 'correction_submitted') && !ds.some(x => x.correction_id === c2.correction_id), ds.map(x => [x.correction_id, x.kind]))
  ok('#341 申請者本人の受付メールは送らない', !ds.some(x => x.kind === 'correction_received'), ds.map(x => x.kind))
  const an = (await admin.get('/api/admin/notifications')).data.notifications
  const lead = an.find(n => n.related_id === c1.correction_id && n.kind === 'correction_submitted')
  ok('#358 #214 承認依頼のタイトルに、だれの・いつの申請か（とまとめた件数）が入る', lead && /佐藤|伊藤/.test(lead.title) && /入店報告/.test(lead.title) && /ほか1件/.test(lead.title) && /報告2: 勤務開始/.test(lead.body), lead)
  ok('#214 アプリ内の承認依頼は申請ごとに残る（処理済みの判定のため）', an.some(n => n.related_id === c2.correction_id && n.kind === 'correction_submitted'), null)
  // 上から順に承認すれば矛盾しない
  const a1 = await admin.post(`/api/admin/corrections/${c1.correction_id}/approve`, {})
  const a2 = await admin.post(`/api/admin/corrections/${c2.correction_id}/approve`, {})
  ok('#214 上から順に承認すると、2件とも矛盾なく承認できる', a1.status === 200 && a2.status === 200 && await reportAt(B, 'check_in') === `${d} 09:55:00` && await reportAt(B, 'work_start') === `${d} 10:00:00`, [a1, a2])
  // 残業で終わりを延ばす: 退店が先
  r = await st5.post('/api/staff/corrections/bulk', { shift_id: B, reason: '残業', items: [{ report_type: 'work_end', requested_at: `${d} 18:30` }, { report_type: 'check_out', requested_at: `${d} 18:35` }] })
  ok('#214 残業で勤務終了と退店をまとめて延ばすと、退店 → 勤務終了の順に並ぶ', r.status === 200 && r.data.corrections[0].report_type === 'check_out', r)
  for (const x of r.data.corrections || []) await admin.post(`/api/admin/corrections/${x.correction_id}/approve`, {})
  ok('#214 承認後の勤務終了・退店', await reportAt(B, 'work_end') === `${d} 18:30:00` && await reportAt(B, 'check_out') === `${d} 18:35:00`, [await reportAt(B, 'work_end'), await reportAt(B, 'check_out')])
}

// ---------- #341 #306 受付の控え・リンク / #486 管理者が代わりに出した申請 ----------
{
  const d = addDays(today, -4)
  const C = await createShift(5, d)
  must(await proxy(C, { check_in: '09:50' }), 'proxy C')
  const r = must(await st5.post('/api/staff/corrections', { shift_id: C, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:45`, reason: '時刻の誤り' }), 'request')
  const mine = (await staffNotes(st5)).find(n => n.related_id === r.correction_id && n.kind === 'correction_received')
  ok('#341 自分で出した申請の受付は既読の控えとして残る（未読にしない）', mine && mine.read_at, mine)
  ok('#306 スタッフの通知のリンクは該当の申請を開く（#attendance/request/:id）', mine && mine.link === `/staff#attendance/request/${r.correction_id}`, mine && mine.link)
  must(await admin.post(`/api/admin/corrections/${r.correction_id}/reject`, { reason: '記録どおりです' }), 'reject')
  const rej = (await staffNotes(st5)).find(n => n.related_id === r.correction_id && n.kind === 'correction_rejected')
  ok('#306 却下の通知も該当の申請を開く', rej && !rej.read_at && rej.link === `/staff#attendance/request/${r.correction_id}`, rej)

  const p = must(await admin.post('/api/admin/corrections', { shift_id: C, report_type: 'check_out', kind: 'add', requested_at: `${d} 19:00`, reason: '退店の押し忘れ（管理者が代わりに申請）' }), 'admin request')
  const proxyN = (await staffNotes(st5)).find(n => n.related_id === p.correction_id)
  ok('#341 #486 管理者が代わりに出した申請は、スタッフ本人に未読で知らせる', proxyN && proxyN.kind === 'correction_proxy_submitted' && !proxyN.read_at, proxyN)
  ok('#341 管理者が代わりに出した申請の知らせはメールにしない', !(await deliveries()).some(x => x.correction_id === p.correction_id && x.kind === 'correction_proxy_submitted'), null)
  const row = (await myList(st5)).find(x => x.correction_id === p.correction_id)
  ok('#486 スタッフの申請一覧で、管理者が代わりに出した申請を区別できる（申請者の氏名。ロールは返さない）', row && row.by_admin === true && row.mine === false && row.requested_by_name === '出井 代表' && !('requested_by_role' in row), row)
  const own = (await myList(st5)).find(x => x.correction_id === r.correction_id)
  ok('#486 自分の申請は by_admin にならない', own && own.by_admin === false && own.mine === true, own)
}

// ---------- #399 却下された申請を打刻履歴に出し、行からの申請を再申請としてつなぐ ----------
{
  const d = addDays(today, -5)
  const D = await createShift(5, d)
  must(await proxy(D, { check_in: '09:50', check_out: '19:00' }), 'proxy D')
  const r = must(await st5.post('/api/staff/corrections', { shift_id: D, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:30`, reason: '退店が遅れた' }), 'request')
  must(await admin.post(`/api/admin/corrections/${r.correction_id}/reject`, { reason: '19:20 です' }), 'reject')
  let tl = (await st5.get(`/api/staff/attendance/timeline?to=${d}&from=${d}`)).data
  let s = tl.shifts.find(x => x.shift_id === D)
  ok('#399 打刻履歴に、却下されたままの申請（理由付き）が出る', s && s.rejected.some(x => x.correction_id === r.correction_id && x.reject_reason === '19:20 です'), s && s.rejected)
  const n = must(await st5.post('/api/staff/corrections', { shift_id: D, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:20`, reason: '店舗の記録に合わせる' }), 'new request')
  const det = (await admin.get(`/api/admin/corrections/${n.correction_id}`)).data
  ok('#399 行から出した申請は、却下された申請の再申請としてつながる', det.correction.resubmitted_from === r.correction_id && det.events[0].event === 'resubmitted', det.correction)
  const old = (await myList(st5)).find(x => x.correction_id === r.correction_id)
  ok('#399 元の却下申請は再申請済みになり、『修正して再申請』が出ない', old && old.resubmitted_count === 1 && old.superseded_by === n.correction_id, old)
  const again = await st5.post(`/api/staff/corrections/${r.correction_id}/resubmit`, { requested_at: `${d} 19:25`, reason: 'x' })
  ok('#399 再申請済みの却下申請からは、もう一度再申請できない（409）', again.status === 409, again)
  tl = (await st5.get(`/api/staff/attendance/timeline?to=${d}&from=${d}`)).data
  s = tl.shifts.find(x => x.shift_id === D)
  ok('#399 申請し直した後は、打刻履歴の却下の印が消える', s && !s.rejected.length && s.pending.some(x => x.correction_id === n.correction_id), s)
}

// ---------- #484 再申請は今の記録から種類を決める ----------
{
  const d = addDays(today, -6)
  const E = await createShift(5, d)
  must(await proxy(E, { check_in: '09:50' }), 'proxy E')
  const r = must(await st5.post('/api/staff/corrections', { shift_id: E, report_type: 'work_start', kind: 'add', requested_at: `${d} 10:00`, reason: '押し忘れ' }), 'request')
  must(await admin.post(`/api/admin/corrections/${r.correction_id}/reject`, { reason: '代理入力します' }), 'reject')
  must(await proxy(E, { work_start: '10:02' }), 'proxy work_start')
  const det = (await st5.get(`/api/staff/corrections/${r.correction_id}`)).data
  ok('#484 再申請の画面が使う今の記録（詳細の reports）に、却下の後の代理入力が入っている', det.reports.some(x => x.report_type === 'work_start' && x.reported_at === `${d} 10:02:00`), det.reports)
  const dry = await st5.post(`/api/staff/corrections/${r.correction_id}/resubmit`, { requested_at: `${d} 10:00`, reason: '押し忘れ', dry_run: true })
  ok('#484 再申請は今の記録をもとに時刻修正として扱う', dry.status === 200 && dry.data.kind === 'modify' && dry.data.before_at === `${d} 10:02:00`, dry)
}

// ---------- #215 確定済みのシフト ----------
{
  const d = addDays(today, -7)
  const G = await createShift(5, d)
  must(await proxy(G, { check_in: '10:00', check_out: '19:00' }), 'proxy G')
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [G], force: true }), 'confirm')
  const tl = (await st5.get(`/api/staff/attendance/timeline?to=${d}&from=${d}`)).data
  ok('#215 打刻履歴で確定済みのシフトが分かる', tl.shifts.find(x => x.shift_id === G)?.settled === true && /支払額/.test(tl.settled_notice), tl.shifts.find(x => x.shift_id === G))
  const dry = await st5.post('/api/staff/corrections', { shift_id: G, report_type: 'check_out', kind: 'modify', requested_at: `${d} 18:30`, reason: '早く上がった', dry_run: true })
  ok('#215 確定済みのシフトへの申請は、支払額が自動では変わらないことを確認に出す', dry.status === 200 && dry.data.notices.some(x => /支払額/.test(x)), dry)
  const r = must(await st5.post('/api/staff/corrections', { shift_id: G, report_type: 'check_out', kind: 'modify', requested_at: `${d} 18:30`, reason: '早く上がった' }), 'request')
  must(await admin.post(`/api/admin/corrections/${r.correction_id}/approve`, {}), 'approve')
  const nt = (await staffNotes(st5)).find(n => n.related_id === r.correction_id && n.kind === 'correction_approved')
  ok('#215 確定済みのシフトの承認の通知は、支払額は変わらないと伝える', nt && /支払額: 確定済みのため変わりません/.test(nt.body), nt)
  const row = (await myList(st5)).find(x => x.correction_id === r.correction_id)
  ok('#215 申請一覧でも確定済みに反映したことが分かる', row && row.applied_while_settled === 1, row)
  if (PERSIST) {
    sql(`UPDATE companies SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.correction_deadline_days', 3) WHERE company_id = 1`)
    const late = await st5.post('/api/staff/corrections', { shift_id: G, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:55`, reason: 'x', dry_run: true })
    ok('#215 会社が受付期限を決めていれば、期限を過ぎたスタッフの申請は 400', late.status === 400 && /3日を過ぎた/.test(late.data.error), late)
    const byAdmin = await admin.post('/api/admin/corrections', { shift_id: G, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:55`, reason: 'x', dry_run: true })
    ok('#215 管理者の申請は受付期限の対象外', byAdmin.status === 200, byAdmin)
    const tl2 = (await st5.get(`/api/staff/attendance/timeline?to=${d}&from=${d}`)).data
    ok('#215 打刻履歴に申請の期限を返す', tl2.shifts.find(x => x.shift_id === G)?.request_until === addDays(d, 3), tl2.shifts.find(x => x.shift_id === G))
    sql(`UPDATE companies SET settings_json = json_remove(settings_json, '$.correction_deadline_days') WHERE company_id = 1`)
  } else console.log('SKIP  #215 受付期限（PERSIST 未指定）')
}

// ---------- #392 取り消し直後の申請し直しはメールを送らない・回数の上限 ----------
{
  const d = addDays(today, -8)
  const H = await createShift(6, d)
  must(await proxy(H, { check_in: '09:50', check_out: '19:00' }), 'proxy H')
  const a = must(await st6.post('/api/staff/corrections', { shift_id: H, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:10`, reason: '退店' }), 'request a')
  ok('（前提）最初の申請は承認依頼メールを作る', (await deliveries()).some(x => x.correction_id === a.correction_id && x.kind === 'correction_submitted'), null)
  must(await st6.post(`/api/staff/corrections/${a.correction_id}/cancel`), 'cancel a')
  const b = must(await st6.post('/api/staff/corrections', { shift_id: H, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:15`, reason: '退店' }), 'request b')
  ok('#392 本人が取り消した直後に同じ報告を申請し直しても、承認依頼メールは送らない', !(await deliveries()).some(x => x.correction_id === b.correction_id), null)
  ok('#392 アプリ内の承認依頼は届く', (await admin.get('/api/admin/notifications')).data.notifications.some(n => n.related_id === b.correction_id && n.kind === 'correction_submitted'), null)
  must(await st6.post(`/api/staff/corrections/${b.correction_id}/cancel`), 'cancel b')
  // 1時間に20件まで（ここまでで2件）
  let last = null, n = 2
  while (n < 25) {
    last = await st6.post('/api/staff/corrections', { shift_id: H, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:${String(16 + (n % 40)).padStart(2, '0')}`, reason: '連打' })
    if (last.status !== 200) break
    n++
    await st6.post(`/api/staff/corrections/${last.data.correction_id}/cancel`)
  }
  ok('#392 申請と取り消しを繰り返すと、1時間に20件で 429', last && last.status === 429 && n === 20, [n, last])
  const dry = await st6.post('/api/staff/corrections', { shift_id: H, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:20`, reason: '確認だけ', dry_run: true })
  ok('#392 確認（dry_run）は上限の対象外', dry.status === 200, dry)
  const other = await st5.post('/api/staff/corrections', { shift_id: (await createShift(5, d)), report_type: 'wake_up', kind: 'add', requested_at: `${d} 07:00`, reason: 'ほかの人' })
  ok('#392 上限は人ごと（ほかのスタッフは申請できる）', other.status === 200, other)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
