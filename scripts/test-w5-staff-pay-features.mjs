// スタッフ向けの勤務時間・支払と、交通費・延長の申請（w5-staff-pay-features: #172 #273 #274 #290）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w5-staff-pay-features.mjs
//   スタッフ st005（staff_id 5）の3日前のシフト（早朝 06:00〜08:00。シードのシフトと重ならない時間）を使う
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
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const PFX = 'W5P' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const st5 = client(await login('sample', 'st005'))
const st6 = client(await login('sample', 'st006'))
const D = addDays(jstToday(), -3)
const MONTH = D.slice(0, 7)

// ---------- 準備: 時給の案件（予定の範囲内で数える・休憩なし）と、st005 のシフト ----------
const pid = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-時給案件`, unit_price: 1500, unit_price_type: 'hourly', allow_duplicate: true }), 'project').project_id
must(await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'clipped', pay_transport_type: 'actual' }), 'pricing')
async function createShift(staff_id, start_time, end_time, tag) {
  const memo = `${PFX}-${tag}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id: pid, work_date: D, start_time, end_time, memo, break_minutes: 0 }), 'shift ' + tag)
  return (await admin.get(`/api/admin/shifts?from=${D}&to=${D}`)).data.shifts.find(x => x.memo === memo).shift_id
}
const S1 = await createShift(5, '06:00', '08:00', 's1')
const S2 = await createShift(5, '08:30', '09:30', 's2') // 延長の重なりの確認用
const settleRow = async (id) => (must(await admin.get(`/api/admin/settlement?from=${D}&to=${D}&staff_id=5`), 'settlement').rows || []).find(r => r.shift_id === id)
const myShift = async (id, month = MONTH) => (must(await st5.get(`/api/staff/pay?month=${month}`), 'staff pay').shifts || []).find(s => s.shift_id === id)

// ---------- #274 実働時間・月の集計 ----------
{
  const d = must(await st5.get(`/api/staff/pay?month=${MONTH}`), 'staff pay')
  const s = d.shifts.find(x => x.shift_id === S1)
  ok('#274 自分のシフトを月の一覧で返す（予定の時間で計算）', s && s.hours === 2 && s.actual_source === null && s.started === true, s)
  ok('#290 既定（表示 OFF）では支払額を返さない', d.pay_visible === false && s && s.pay === null && d.summary.pay === null, { pv: d.pay_visible, pay: s && s.pay })
  ok('#290 スタッフ向けの応答に請求・単価の列を含めない', !/"(unit_price|bill_[a-z_]+|pay_rate|adjust_note|actual_note)"/.test(JSON.stringify(d)), JSON.stringify(d).slice(0, 200))
  ok('#274 月の勤務日数・実働時間を集計する', d.summary.worked_days >= 1 && d.summary.worked_hours >= 3, d.summary)
  const other = must(await st6.get(`/api/staff/pay?month=${MONTH}`), 'st6 pay')
  ok('#274 ほかのスタッフのシフトは返さない', !other.shifts.some(x => x.shift_id === S1))
  const bad = must(await st5.get('/api/staff/pay?month=2026-13'), 'bad month')
  ok('#274 月の指定が正しくなければ今月', bad.month === jstToday().slice(0, 7), bad.month)

  // 管理者が実績を入力すると、本人に見え、通知が届く
  must(await admin.put(`/api/admin/shifts/${S1}/actual`, { actual_start: '06:00', actual_end: '08:20', actual_break_minutes: 0, actual_note: '社内メモ' }), 'manual actual')
  const s2 = await myShift(S1)
  ok('#274 管理者が入力した実績と入力元を返す（予定の範囲内で 2 時間）', s2 && s2.actual_start === '06:00' && s2.actual_end === '08:20' && s2.actual_source === 'manual' && s2.hours === 2, s2)
  const notes = must(await st5.get('/api/staff/notifications'), 'notifications').notifications || []
  const n = notes.find(x => x.kind === 'actual_entered' && x.related_id === S1)
  ok('#274 管理者が実績を入力したら本人に通知する（メモは入れない）', n && n.link === `#pay/${MONTH}` && !String(n.body).includes('社内メモ'), n)
  must(await admin.put(`/api/admin/shifts/${S1}/actual`, { actual_start: '06:00', actual_end: '08:20', actual_break_minutes: 0, actual_note: 'メモだけ変更' }), 'manual actual same')
  const notes2 = (must(await st5.get('/api/staff/notifications'), 'notifications').notifications || []).filter(x => x.kind === 'actual_entered' && x.related_id === S1)
  ok('#274 時刻が変わらなければ通知を重ねない', notes2.length === 1, notes2.length)

  const r = await settleRow(S1)
  ok('#172 延長の申請がなく予定の終了の後まで勤務したら、精算の確認事項に出す（0.5h 未満でも）', r && r.issues.some(i => i.startsWith('予定の終了より20分後まで勤務')), r && r.issues)
}

// ---------- #273 交通費の申請 ----------
let T1
{
  let r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 0, route: '新宿〜渋谷' })
  ok('#273 金額は1円以上', r.status === 400, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 200000, route: '新宿〜渋谷' })
  ok('#273 金額の上限を超えると断る', r.status === 400, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 840 })
  ok('#273 区間は必須', r.status === 400, r.status)
  r = await st6.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 840, route: '新宿〜渋谷' })
  ok('#273 ほかのスタッフのシフトには申請できない', r.status === 404, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'other' })
  ok('#273 種類は transport / overtime だけ', r.status === 400, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 840, route: '新宿〜渋谷', round_trip: true, reason: 'バス' })
  ok('#273 交通費を申請できる', r.status === 200 && r.data.request_id > 0, r.data)
  T1 = r.data.request_id
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 500, route: '新宿〜渋谷' })
  ok('#273 同じシフトの承認待ちは1件まで', r.status === 409, r.status)
  const an = (must(await admin.get('/api/admin/notifications'), 'admin notifications').notifications || []).find(x => x.kind === 'pay_request_submitted' && x.related_id === T1)
  ok('#273 申請を管理者に通知する', an && an.link === '/admin#settlement', an)
  const list = must(await admin.get('/api/admin/pay-requests'), 'pay-requests')
  const q = list.requests.find(x => x.request_id === T1)
  ok('#273 管理者の一覧に承認待ちとして出る（今の実費・支払区分付き）', q && q.status === 'pending' && q.amount === 840 && q.round_trip === true && q.transportation_fee === 0 && q.pay_transport_type === 'actual' && q.shift_issue === null, q)
  const row = await settleRow(S1)
  ok('#273 承認待ちの申請を精算の確認事項に出す', row && row.issues.includes('承認待ちの交通費・延長の申請あり') && row.pending_pay_requests === 1, row && row.issues)
  ok('#172 承認待ちの申請があれば、予定の終了の後の勤務の確認事項は出さない', row && !row.issues.some(i => i.startsWith('予定の終了より')), row && row.issues)
  must(await admin.post('/api/admin/settlement/acks', { shift_ids: [S1] }), 'acks')
  const row2 = await settleRow(S1)
  ok('#273 承認待ちの申請は確認済みにできない', row2 && row2.issues.includes('承認待ちの交通費・延長の申請あり'), row2 && row2.issues)
  must(await admin.post('/api/admin/settlement/acks', { shift_ids: [S1], undo: true }), 'unack')

  r = await admin.post(`/api/admin/pay-requests/${T1}/approve`, { amount: -1 })
  ok('#273 承認の金額は0円以上', r.status === 400, r.status)
  r = await admin.post(`/api/admin/pay-requests/${T1}/approve`, { amount: 800, note: '往復の運賃に合わせました' })
  ok('#273 金額を直して承認できる', r.status === 200, r.data)
  const row3 = await settleRow(S1)
  ok('#273 承認するとシフトの交通費（実費）と支払の交通費に反映する', row3 && row3.transportation_fee === 800 && row3.pay_transport === 800 && !row3.issues.includes('承認待ちの交通費・延長の申請あり'), row3 && { tf: row3.transportation_fee, pt: row3.pay_transport, issues: row3.issues })
  r = await admin.post(`/api/admin/pay-requests/${T1}/approve`, {})
  ok('#273 二重に承認できない', r.status === 409, r.status)
  const sn = (must(await st5.get('/api/staff/notifications'), 'notifications').notifications || []).find(x => x.kind === 'pay_request_approved' && x.related_id === T1)
  ok('#273 承認を本人に通知する（直した金額とコメント付き）', sn && sn.body.includes('800円') && sn.body.includes('往復の運賃に合わせました'), sn)
  const mine = await myShift(S1)
  const mq = mine && mine.requests.find(x => x.request_id === T1)
  ok('#273 本人の画面に申請の結果を返す', mq && mq.status === 'approved' && mq.approved_amount === 800 && mine.transportation_fee === 800, mq)
}

// ---------- #172 延長の申請 ----------
{
  let r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'overtime', new_end_time: '07:30', reason: '閉店作業' })
  ok('#172 今の予定の終了より前は断る', r.status === 400, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'overtime', new_end_time: '25:00', reason: '閉店作業' })
  ok('#172 時刻の形を確かめる', r.status === 400, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'overtime', new_end_time: '08:45' })
  ok('#172 理由は必須', r.status === 400, r.status)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'overtime', new_end_time: '08:45', instructed_by: '店長', reason: '閉店作業が長引いた' })
  ok('#172 延長を申請できる', r.status === 200, r.data)
  const O1 = r.data.request_id
  r = await admin.post(`/api/admin/pay-requests/${O1}/approve`, {})
  ok('#172 同じスタッフの別のシフトと重なる延長は承認しない', r.status === 409 && /重なる/.test(r.data.error), r.data)
  r = await admin.post(`/api/admin/pay-requests/${O1}/approve`, { end_time: '08:20' })
  ok('#172 終了時刻を直して承認できる', r.status === 200, r.data)
  const row = await settleRow(S1)
  ok('#172 承認すると予定の終了時刻が延び、時給の数量・金額を計算し直す', row && row.end_time === '08:20' && row.pay_hours === 2.33 && row.pay_base === 2800, row && { end: row.end_time, h: row.pay_hours, base: row.pay_base })
  ok('#172 延長の承認の後は、予定の終了の後の勤務の確認事項が消える', row && !row.issues.some(i => i.startsWith('予定の終了より')), row && row.issues)
  const sn = (must(await st5.get('/api/staff/notifications'), 'notifications').notifications || []).find(x => x.kind === 'pay_request_approved' && x.related_id === O1)
  ok('#172 承認を本人に通知する', sn && sn.body.includes('08:00 → 08:20'), sn)
  const s = await myShift(S1)
  ok('#172 #274 本人の実働が延ばした予定まで数えられる', s && s.hours === 2.33 && s.end_time === '08:20', s && { h: s.hours, end: s.end_time })
}

// ---------- 却下・取り消し ----------
{
  let r = await st5.post('/api/staff/pay/requests', { shift_id: S2, kind: 'transport', amount: 300, route: 'A〜B' })
  const R1 = r.data.request_id
  r = await admin.post(`/api/admin/pay-requests/${R1}/reject`, {})
  ok('#273 却下の理由は必須', r.status === 400, r.status)
  r = await admin.post(`/api/admin/pay-requests/${R1}/reject`, { note: '定期券の区間です' })
  ok('#273 却下できる', r.status === 200, r.data)
  const sn = (must(await st5.get('/api/staff/notifications'), 'notifications').notifications || []).find(x => x.kind === 'pay_request_rejected' && x.related_id === R1)
  ok('#273 却下を理由付きで本人に通知する', sn && sn.body.includes('定期券の区間です'), sn)
  r = await st5.post('/api/staff/pay/requests', { shift_id: S2, kind: 'transport', amount: 300, route: 'A〜C' })
  const R2 = r.data.request_id
  r = await st6.post(`/api/staff/pay/requests/${R2}/cancel`)
  ok('#273 ほかのスタッフの申請は取り消せない', r.status === 404, r.status)
  r = await st5.post(`/api/staff/pay/requests/${R2}/cancel`)
  ok('#273 本人は承認待ちの申請を取り消せる', r.status === 200, r.data)
  r = await st5.post(`/api/staff/pay/requests/${R2}/cancel`)
  ok('#273 取り消し済みは取り消せない', r.status === 409, r.status)
  r = await admin.post(`/api/admin/pay-requests/${R2}/approve`, {})
  ok('#273 取り消された申請は承認できない', r.status === 409, r.status)
  r = await mgr.post(`/api/admin/pay-requests/999999/approve`, {})
  ok('#273 存在しない申請は 404', r.status === 404, r.status)
}

// ---------- #290 支払額の表示 ----------
{
  let r = await mgr.put('/api/admin/staff-pay/settings', { staff_pay_visible: true })
  ok('#290 表示の設定は会社管理者だけが変えられる', r.status === 403, r.status)
  r = await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: 'yes' })
  ok('#290 設定は true / false', r.status === 400, r.status)
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: true }), 'visible on')
  const st = must(await admin.get('/api/admin/staff-pay/settings'), 'settings')
  ok('#290 設定を保存する', st.staff_pay_visible === true && st.can_edit === true, st)
  const d = must(await st5.get(`/api/staff/pay?month=${MONTH}`), 'staff pay')
  const s = d.shifts.find(x => x.shift_id === S1)
  ok('#290 ON のとき、支払先が本人のシフトの支払額（単価・数量・交通費・合計）を返す', s && s.pay && s.pay.unit_type === 'hourly' && s.pay.rate === 1200 && s.pay.base === 2800 && s.pay.transport === 800 && s.pay.total === 3600, s && s.pay)
  ok('#290 月の見込みと確定済みの合計を返す（未確定は確定に入れない）', d.pay_visible === true && d.summary.pay && d.summary.pay.estimate_total >= 3600 && d.summary.pay.confirmed_total === 0, d.summary.pay)
  ok('#290 ON でも請求額は返さない', !/"(unit_price|bill_[a-z_]+|bill_total|adjust_note)"/.test(JSON.stringify(d)))
}

// ---------- 確定済みのシフト ----------
{
  const r0 = await st5.post('/api/staff/pay/requests', { shift_id: S2, kind: 'overtime', new_end_time: '10:00', reason: '確定前の申請' })
  const P1 = r0.data && r0.data.request_id
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [S1, S2], force: true }), 'confirm')
  let r = await st5.post('/api/staff/pay/requests', { shift_id: S1, kind: 'transport', amount: 100, route: 'X〜Y' })
  ok('#273 確定済みのシフトには申請できない', r.status === 409, r.status)
  r = await admin.post(`/api/admin/pay-requests/${P1}/approve`, {})
  ok('#172 確定済みのシフトの申請は承認できない', r.status === 409 && /確定/.test(r.data.error), r.data)
  const row = await settleRow(S2)
  ok('#172 確定済みでも承認待ちの申請は確認事項に出る', row && row.issues.includes('承認待ちの交通費・延長の申請あり'), row && row.issues)
  const d = must(await st5.get(`/api/staff/pay?month=${MONTH}`), 'staff pay')
  const s = d.shifts.find(x => x.shift_id === S1)
  ok('#290 確定したシフトは確定として返し、確定済みの合計に入る', s && s.settled === true && d.summary.pay.confirmed_total >= 3600 && !!s.request_block, { settled: s && s.settled, pay: d.summary.pay })
  // 後片づけ
  must(await admin.post(`/api/admin/pay-requests/${P1}/reject`, { note: 'テストの後片づけ' }), 'cleanup reject')
  must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [S1, S2] }), 'unconfirm')
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: false }), 'visible off')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
