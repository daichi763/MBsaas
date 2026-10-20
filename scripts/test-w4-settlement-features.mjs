// 精算の締め・明細書・キャンセル料と、精算画面の使い勝手（w4-settlement-features: #168 #170 #283 #389 #391 #494）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w4-settlement-features.mjs
//   締めのテストは過去の期間（2019年2月）を使い、最後に解除する（ほかのテストの日付と重ならないように）
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, type: r.headers.get('content-type') || '' }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }

const PFX = 'W4S' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// 2019年2月（ほかのテスト・シードと重ならない過去の期間）
const FROM = '2019-02-01', TO = '2019-02-28'
const list = async (extra = '') => must(await admin.get(`/api/admin/settlement?from=${FROM}&to=${TO}${extra}`), 'settlement')

// ---------- 準備: クライアント・案件・スタッフ・シフト ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX} クライアント`, billing_rule: '20日締め・翌月末払い' }), 'client')
// #494 選択肢は精算の API から取り直す（後から登録したクライアント・案件も出る）
let opts = must(await admin.get('/api/admin/settlement/options'), 'options')
const cl = opts.clients.find(c => c.client_name === `${PFX} クライアント`)
ok('#494 登録したばかりのクライアントが精算の選択肢に出る', !!cl, opts.clients.length)
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: cl.client_id }), 'project')
opts = must(await admin.get('/api/admin/settlement/options'), 'options')
const P = opts.projects.find(p => p.project_name === `${PFX}-案件`)
ok('#494 登録したばかりの案件が精算の選択肢に出る（クライアントの紐づけ付き）', P && Number(P.client_id) === Number(cl.client_id), P)

const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const A = await newStaff(1), B = await newStaff(2)
const newShift = async (staff_id, work_date) => must(await admin.post('/api/admin/shifts', { staff_id, project_id: P.project_id, work_date, start_time: '10:00', end_time: '19:00', unit_price: 15000 }), 'shift').shift_id
const s1 = await newShift(A, '2019-02-05'), s2 = await newShift(B, '2019-02-06'), s3 = await newShift(A, '2019-02-07')

// ---------- #168 クライアントの締め日 ----------
{
  const bad = await admin.put(`/api/admin/settlement/clients/${cl.client_id}/closing-day`, { day: 40 })
  ok('#168 締め日は1〜31だけ', bad.status === 400, bad.status)
  must(await admin.put(`/api/admin/settlement/clients/${cl.client_id}/closing-day`, { day: 20 }), 'closing-day')
  const o = must(await admin.get('/api/admin/settlement/options'), 'options').clients.find(c => c.client_id === cl.client_id)
  ok('#168 締め日を保存して選択肢と一緒に返す', o && o.billing_closing_day === 20, o)
  const other = await admin.put('/api/admin/settlement/clients/999999/closing-day', { day: 10 })
  ok('#168 他社・存在しないクライアントの締め日は変えられない', other.status === 404, other.status)
}

// ---------- #283 欠勤のキャンセル料・補償 ----------
{
  must(await admin.put(`/api/admin/shifts/${s3}`, { status: 'absent' }), 'absent')
  let d = await list()
  ok('#283 欠勤にしたシフトは、金額を入れるまで精算の一覧に入らない', !d.rows.some(r => r.shift_id === s3), d.rows.map(r => r.shift_id))
  const ab = (d.absent_shifts || []).find(x => x.shift_id === s3)
  ok('#283 キャンセル料を入れていない欠勤のシフトを一覧で返す（欠勤にした日時付き）', ab && !!ab.absent_at, d.absent_shifts)
  const notAbsent = await admin.put(`/api/admin/settlement/cancellations/${s1}`, { reason: 'client', bill_amount: 100 })
  ok('#283 欠勤でないシフトには入れられない', notAbsent.status === 400, notAbsent.status)
  const badReason = await admin.put(`/api/admin/settlement/cancellations/${s3}`, { reason: 'other', bill_amount: 100 })
  ok('#283 理由は staff / client だけ', badReason.status === 400, badReason.status)
  const badPolicy = await admin.put(`/api/admin/settlement/projects/${P.project_id}/cancel-policy`, { bill_rate_same_day: 150 })
  ok('#283 規定の率は0〜100%', badPolicy.status === 400, badPolicy.status)
  must(await admin.put(`/api/admin/settlement/projects/${P.project_id}/cancel-policy`, { bill_rate_prev_day: 50, bill_rate_same_day: 100, pay_rate: 60 }), 'policy')
  const g = must(await admin.get(`/api/admin/settlement/cancellations/${s3}`), 'cancellation get')
  ok('#283 入力欄の初期値に使う規定と予定の請求額を返す', g.policy && g.policy.bill_rate_same_day === 100 && g.shift.planned_bill === 15000 && g.cancellation === null, g)
  must(await admin.put(`/api/admin/settlement/cancellations/${s3}`, { reason: 'client', notified_on: '2019-02-07', bill_amount: 15000, pay_amount: 6000, note: '店舗都合で中止' }), 'cancellation put')
  d = await list()
  const r3 = d.rows.find(r => r.shift_id === s3)
  ok('#283 金額を入れた欠勤は精算の対象になり、請求・支払に入る', r3 && r3.kind === 'cancel' && r3.bill_total === 15000 && r3.pay_total === 6000 && r3.cancel_reason === 'client', r3)
  // 合計は、このテストのクライアントだけで確かめる（何度か流したときの前回の行を数えないように）
  const dc = await list(`&client_id=${cl.client_id}`)
  ok('#283 合計にキャンセル料・補償の内訳を出す', dc.totals.cancel_shifts === 1 && dc.totals.cancel_bill === 15000 && dc.totals.cancel_pay === 6000, dc.totals)
  ok('#283 金額を入れた欠勤は、未入力の欠勤の一覧から消える', !(d.absent_shifts || []).some(x => x.shift_id === s3))
  // 欠勤から戻すとキャンセル料は消える（別のシフトで確かめる）
  const s5 = await newShift(B, '2019-02-08')
  must(await admin.put(`/api/admin/shifts/${s5}`, { status: 'absent', cancel_reason: 'staff' }), 'absent with reason')
  const g5 = must(await admin.get(`/api/admin/settlement/cancellations/${s5}`), 'cancellation s5')
  ok('#283 欠勤にするときに理由を受け取って記録する', g5.cancellation && g5.cancellation.reason === 'staff', g5.cancellation)
  must(await admin.put(`/api/admin/shifts/${s5}`, { status: 'confirmed' }), 'back to confirmed')
  const g5b = must(await admin.get(`/api/admin/settlement/cancellations/${s5}`), 'cancellation s5 after')
  ok('#283 欠勤から戻すと、キャンセル料・補償の記録を消す', g5b.cancellation === null && !g5b.shift.absent_at, g5b)
  must(await admin.del(`/api/admin/shifts/${s5}`), 'delete s5')
}

// ---------- #168 スタッフの絞り込み ----------
{
  const all = await list()
  ok('#168 絞り込みの候補に、期間内のスタッフを返す', [A, B].every(id => (all.staff_options || []).some(o => o.staff_id === id)), all.staff_options)
  const onlyA = await list(`&staff_id=${A}`)
  ok('#168 スタッフで絞り込める', onlyA.rows.length >= 1 && onlyA.rows.every(r => r.staff_id === A), onlyA.rows.map(r => r.staff_id))
  ok('#168 絞り込んでも候補は全員を返す', [A, B].every(id => (onlyA.staff_options || []).some(o => o.staff_id === id)))
}

// ---------- #170 締め ----------
let closingId = null
{
  const early = await admin.post('/api/admin/settlement/closings', { from: FROM, to: TO })
  ok('#170 未確定のシフトがあると締められない', early.status === 409 && early.data.unconfirmed >= 1, early.data)
  const ids = (await list()).rows.map(r => r.shift_id)
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: ids, force: true }), 'confirm')
  const d0 = await list()
  ok('#283 キャンセル料の行も確定できる', d0.rows.find(r => r.shift_id === s3)?.settle_status === 'confirmed', d0.rows.find(r => r.shift_id === s3))
  let cr = await admin.post('/api/admin/settlement/closings', { from: FROM, to: TO, note: `${PFX} テスト` })
  if (cr.status === 409 && cr.data && cr.data.need_force) cr = await admin.post('/api/admin/settlement/closings', { from: FROM, to: TO, note: `${PFX} テスト`, force: true })
  ok('#170 すべて確定していれば締められ、そのときの合計を記録する', cr.status === 200 && cr.data.shifts === d0.totals.shifts && cr.data.bill === d0.totals.bill && cr.data.pay === d0.totals.pay, cr.data)
  closingId = cr.data && cr.data.closing_id
  const dup = await admin.post('/api/admin/settlement/closings', { from: '2019-02-10', to: '2019-03-05' })
  ok('#170 重なる期間は締められない', dup.status === 409, dup.status)
  const d = await list()
  ok('#170 一覧に締めた期間と、行ごとの締めの印を返す', (d.closings || []).some(k => k.closing_id === closingId) && d.rows.every(r => r.closed === true), d.closings)
  const un = await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [s1] })
  ok('#170 締めた期間の確定は取り消せない', un.status === 409 && un.data.closed === 1, un.data)
  const act = await admin.put(`/api/admin/shifts/${s2}/actual`, { actual_start: '10:00', actual_end: '20:00' })
  ok('#170 締めた期間の実績は変えられない', act.status === 409, act.status)
  const add = await admin.post('/api/admin/shifts', { staff_id: B, project_id: P.project_id, work_date: '2019-02-10', start_time: '10:00', end_time: '19:00' })
  ok('#170 締めた期間にシフトを追加できない', add.status === 409, add.status)
  const cxs = await admin.put(`/api/admin/settlement/cancellations/${s3}`, { reason: 'staff', bill_amount: 0, pay_amount: 0 })
  ok('#170 締めた期間のキャンセル料は変えられない', cxs.status === 409, cxs.status)
  const sync = must(await admin.post('/api/admin/settlement/sync-actuals', { from: FROM, to: TO }), 'sync')
  ok('#170 報告の反映でも締めた期間は変えない', sync.updated === 0, sync)
  const noReason = await admin.post(`/api/admin/settlement/closings/${closingId}/reopen`, { reason: ' ' })
  ok('#170 解除には理由が必要', noReason.status === 400, noReason.status)
}

// ---------- #168 明細書・出力の記録 ----------
{
  const d = await list()
  const gA = d.by_payee.find(g => g.staff_id === A)
  ok('#168 支払集計に明細書の宛先に使うキーを返す', gA && typeof gA.group_key === 'string', gA)
  const pay = await admin.get(`/api/admin/settlement/statement?kind=payment&group=${encodeURIComponent(gA.group_key)}&from=${FROM}&to=${TO}`)
  ok('#168 支払明細書（印刷用のページ）を出せる', pay.status === 200 && pay.type.startsWith('text/html') && pay.text.includes('支払明細書') && pay.text.includes(`${PFX} スタッフ1`) && pay.text.includes('クライアント都合の中止'), pay.status)
  ok('#168 支払明細書に他の人の行を入れない', !pay.text.includes(`${PFX} スタッフ2`))
  const bill = await admin.get(`/api/admin/settlement/statement?kind=billing&client_id=${cl.client_id}&from=${FROM}&to=${TO}`)
  ok('#168 請求明細書（クライアントあて）を出せる', bill.status === 200 && bill.text.includes('請求明細書') && bill.text.includes(`${PFX} クライアント 御中`) && bill.text.includes(`${PFX} スタッフ2`), bill.status)
  const none = await admin.get(`/api/admin/settlement/statement?kind=billing&client_id=999999&from=${FROM}&to=${TO}`)
  ok('#168 対象のないクライアントは 404', none.status === 404, none.status)
  const csv = await admin.get(`/api/admin/settlement/export?kind=detail&from=${FROM}&to=${TO}&client_id=${cl.client_id}`)
  ok('#283 シフト明細CSVの『実績の入力』にキャンセルの理由を出す（列の並びは変えない）', csv.status === 200 && csv.text.split('\r\n')[0].includes(',確認事項,スタッフID') && csv.text.includes('キャンセル（クライアント都合の中止）'), csv.text.slice(0, 200))
  const logs = must(await admin.get('/api/admin/settlement/closings'), 'closings')
  ok('#170 CSV・明細書の出力を記録する', ['detail', 'statement_payment', 'statement_billing'].every(k => logs.exports.some(x => x.kind === k && x.period_from === FROM)), logs.exports.slice(0, 5))
  ok('#170 締めの記録を返す（会社管理者は解除できる）', logs.closings.some(k => k.closing_id === closingId && !k.reopened_at) && logs.can_reopen === true)
}

// ---------- #389 実績の根拠（報告状況の API を精算から使う） ----------
{
  const rs = await admin.get(`/api/admin/shifts/${s1}/report-status`)
  ok('#389 精算のモーダルが使う報告状況を取れる', rs.status === 200 && Array.isArray(rs.data.reports) && rs.data.modes, rs.status)
}

// ---------- #170 解除 ----------
{
  const mgr = client(await login('sample', 'mgr01'))
  const byMgr = await mgr.post(`/api/admin/settlement/closings/${closingId}/reopen`, { reason: '現場管理者による解除' })
  ok('#170 会社管理者でない管理者は締めを解除できない', byMgr.status === 403, byMgr.status)
  must(await admin.post(`/api/admin/settlement/closings/${closingId}/reopen`, { reason: `${PFX} テストの後片付け` }), 'reopen')
  const logs = must(await admin.get('/api/admin/settlement/closings'), 'closings')
  const k = logs.closings.find(x => x.closing_id === closingId)
  ok('#170 解除しても記録は残り、解除の理由と人を残す', k && k.reopened_at && k.reopen_reason === `${PFX} テストの後片付け` && !!k.reopened_by_name, k)
  const un = await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [s1, s2, s3] })
  ok('#170 解除した後は確定を取り消せる', un.status === 200 && un.data.unconfirmed === 3, un.data)
  const again = await admin.post(`/api/admin/settlement/closings/${closingId}/reopen`, { reason: 'x' })
  ok('#170 解除済みの締めは解除できない', again.status === 404, again.status)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
