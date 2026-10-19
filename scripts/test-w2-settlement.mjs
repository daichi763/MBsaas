// 精算の確定対象と金額（w2-settlement: #23 #26 #31 #60 #111 #120 #147 #200 #271 #459 #565）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-settlement.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
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
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const admin = client(await login('sample', 'admin'))
const PFX = 'W2S' + Date.now().toString(36).slice(-4).toUpperCase()

async function createShift(staff_id, work_date, tag, start_time = '10:00', end_time = '19:00', project_id = 1) {
  const memo = `${PFX}-${tag}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const s = (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
  return s.shift_id
}
const proxy = (id, t, time) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: [t], time })
async function full(id, cin = '10:00', cout = '19:00') { await proxy(id, 'check_in', cin); await proxy(id, 'check_out', cout) }
const list = async (from, to, extra = '') => admin.get(`/api/admin/settlement?from=${from}&to=${to}${extra}`)
async function row(id, date) { return ((await list(date, date)).data.rows || []).find(x => x.shift_id === id) }

// ---------- #26 #271 確認が必要なもののみ: 表示中だけを確定する・CSV に絞り込みを反映する ----------
{
  const d = addDays(today, -5)
  const A = await createShift(3, d, 'A')            // 報告なし → 「入店報告なし」
  const B = await createShift(4, d, 'B'); await full(B) // 報告あり・支払単価あり → 確認事項なし
  await admin.put(`/api/admin/shifts/${B}/price`, { pay_unit_type: 'daily', pay_rate: 10000 })
  const view = await list(d, d, '&issues_only=1')
  const shown = view.data.rows.map(r => r.shift_id)
  ok('#26 確認事項のみの表示に、確認事項のあるシフトだけが出る', shown.includes(A) && view.data.rows.every(r => r.issues.length), shown)
  const bRow = await row(B, d)
  // 条件で送る場合（API の互換）も issues_only を反映する
  const dry = await admin.post('/api/admin/settlement/confirm', { from: d, to: d, issues_only: '1', dry_run: true })
  ok('#26 条件での指定でも issues_only を反映する（dry_run の対象は表示中の件数）', dry.status === 200 && dry.data.target === shown.length, [dry.data, shown.length])
  // 画面は表示中の shift_id を送る
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: shown, force: true })
  ok('#26 表示中の shift_id で確定できる', cf.status === 200 && cf.data.confirmed === shown.length, cf.data)
  const b2 = await row(B, d)
  if (bRow && !bRow.issues.length) ok('#26 表示していない（確認事項のない）シフトは確定されない', b2.settle_status === 'planned', b2.settle_status)
  else skip('#26 表示していないシフトは確定されない', `B に確認事項がある: ${bRow && bRow.issues}`)
  // CSV: 確認が必要なもののみ
  const csv = await admin.get(`/api/admin/settlement/export?kind=detail&from=${d}&to=${d}&issues_only=1`)
  const ids = csv.text.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean).map(l => Number(l.split(',')[0].replace(/"/g, '')))
  ok('#271 CSV（明細）に絞り込みが反映される', csv.status === 200 && ids.includes(A) && (bRow.issues.length || !ids.includes(B)), ids)
  const header = csv.text.replace(/^﻿/, '').split(/\r?\n/)[0]
  ok('#120 CSV の休憩を予定と実績に分ける', header.includes('予定休憩(分)') && header.includes('実績休憩(分)'), header)
  await admin.post('/api/admin/settlement/unconfirm', { shift_ids: shown })
}

// ---------- #60 上限 ----------
{
  const many = Array.from({ length: 5001 }, (_, i) => i + 1)
  const r = await admin.post('/api/admin/settlement/confirm', { shift_ids: many, dry_run: true })
  ok('#60 一度に処理できる件数（5000件）を超えると 400', r.status === 400 && /5000/.test(r.data.error), r.data)
  const v = await list(addDays(today, -6), addDays(today, -6))
  ok('#60 一覧は上限（max_rows）と、上限を超えたか（truncated）を返す', v.data.max_rows === 5000 && v.data.truncated === false, [v.data.max_rows, v.data.truncated])
}

// ---------- #459 当日の勤務中のシフトは確定できない ----------
{
  const T = await createShift(5, today, 'TODAY', '00:00', '23:59')
  await proxy(T, 'check_in', '00:01')
  let r = await admin.post('/api/admin/settlement/confirm', { shift_ids: [T], force: true })
  ok('#459 当日の勤務中（退店前）のシフトは確定しない', r.status === 200 && r.data.confirmed === 0 && r.data.skipped_in_progress === 1, r.data)
  const pc = await proxy(T, 'check_out', '00:02')
  if (pc.status === 200) {
    r = await admin.post('/api/admin/settlement/confirm', { shift_ids: [T], force: true })
    ok('#459 退店の報告の後は当日でも確定できる', r.status === 200 && r.data.confirmed === 1, r.data)
    await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [T] })
  } else skip('#459 退店の後は確定できる', `代理入力が ${pc.status}`)
}

// ---------- #111 確定後に承認した打刻修正は、確定の取り消しで実績に反映する ----------
{
  const d = addDays(today, -7)
  const E = await createShift(6, d, 'E'); await full(E, '10:00', '19:00')
  await admin.post('/api/admin/settlement/confirm', { shift_ids: [E], force: true })
  const c = await admin.post('/api/admin/corrections', { shift_id: E, report_type: 'check_out', kind: 'modify', requested_at: `${d} 20:00`, reason: '残業' })
  const ap = await admin.post(`/api/admin/corrections/${c.data.correction_id}/approve`, {})
  let r = await row(E, d)
  ok('#111 確定後に承認すると「確定後に打刻修正あり」', ap.status === 200 && ap.data.applied_while_settled && r.issues.includes('確定後に打刻修正あり') && r.actual_end === '19:00', [ap.data, r.issues, r.actual_end])
  const un = await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [E] })
  r = await row(E, d)
  ok('#111 確定を取り消すと、修正後の報告の時刻が実績に反映される', un.status === 200 && un.data.unconfirmed === 1 && un.data.synced === 1 && r.actual_end === '20:00' && r.settle_status === 'planned', [un.data, r.actual_end])
  ok('#111 反映の後は確認事項から消える', !r.issues.some(i => /打刻修正|未反映/.test(i)), r.issues)

  // 確定の後に報告があった（#459）。代理入力・報告が確定済みを受け付けない場合は確認しない
  const F = await createShift(7, d, 'F'); await proxy(F, 'check_in', '10:00')
  await admin.post('/api/admin/settlement/confirm', { shift_ids: [F], force: true })
  const late = await proxy(F, 'check_out', '19:30')
  if (late.status === 200) {
    r = await row(F, d)
    ok('#459 確定の後の報告は「確定後に報告あり（実績に未反映）」', r.issues.includes('確定後に報告あり（実績に未反映）'), r.issues)
    await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [F] })
    r = await row(F, d)
    ok('#459 確定を取り消すと、その報告が実績に入る', r.actual_end === '19:30', r.actual_end)
  } else skip('#459 確定後の報告の確認事項', `確定済みのシフトへの代理入力が ${late.status}`)
}

// ---------- #200 承認待ちの打刻修正 ----------
{
  const d = addDays(today, -8)
  const G = await createShift(3, d, 'G'); await full(G)
  const c = await admin.post('/api/admin/corrections', { shift_id: G, report_type: 'check_out', kind: 'modify', requested_at: `${d} 18:30`, reason: '早退' })
  const r = await row(G, d)
  ok('#200 承認待ちの申請があると確認事項に出る', c.status === 200 && r.issues.includes('承認待ちの打刻修正あり') && r.pending_corrections === 1, [c.data, r.issues])
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [G] })
  ok('#200 force なしでは確定できない（409）', cf.status === 409 && cf.data.need_force, cf.data)
  await admin.post(`/api/admin/corrections/${c.data.correction_id}/reject`, { reason: 'テスト' })
}

// ---------- #31 実績を手入力したシフトの打刻修正 ----------
{
  const d = addDays(today, -9)
  const H = await createShift(4, d, 'H'); await full(H)
  await admin.put(`/api/admin/shifts/${H}/actual`, { actual_start: '10:00', actual_end: '21:00', actual_break_minutes: 60 })
  const c = await admin.post('/api/admin/corrections', { shift_id: H, report_type: 'check_out', kind: 'modify', requested_at: `${d} 18:00`, reason: '押し忘れ' })
  const det = await admin.get(`/api/admin/corrections/${c.data.correction_id}`)
  ok('#31 承認の前に、実績が手入力のシフトと分かる（shift_actual_source）', det.status === 200 && det.data.shift_actual_source === 'manual', det.data && det.data.shift_actual_source)
  const ap = await admin.post(`/api/admin/corrections/${c.data.correction_id}/approve`, {})
  let r = await row(H, d)
  ok('#31 承認の応答で「手入力のため未反映」を返す', ap.status === 200 && ap.data.applied_while_manual === true && r.actual_end === '21:00', [ap.data, r.actual_end])
  ok('#31 精算の確認事項に「手入力後に打刻修正あり」が出る', r.issues.includes('手入力後に打刻修正あり'), r.issues)
  await admin.put(`/api/admin/shifts/${H}/actual`, { reset: true })
  r = await row(H, d)
  ok('#31 「報告の時刻に戻す」と反映され、確認事項から消える', r.actual_end === '18:00' && !r.issues.includes('手入力後に打刻修正あり'), [r.actual_end, r.issues])
}

// ---------- #120 予定の休憩と実績の休憩 / #147 分単位の金額 ----------
{
  const d = addDays(today, -10)
  const I = await createShift(5, d, 'I', '09:00', '17:00')
  for (const [t, tm] of [['check_in', '09:00'], ['break_start', '12:00'], ['break_end', '12:45'], ['check_out', '16:20']]) await proxy(I, t, tm)
  let r = await row(I, d)
  ok('#120 予定欄の休憩は予定の休憩、実績の休憩は別に返す', r.used_break_minutes === 45 && r.planned_hours === Math.round((480 - r.break_minutes) / 60 * 100) / 100, [r.break_minutes, r.used_break_minutes, r.planned_hours])
  const p = await admin.put(`/api/admin/shifts/${I}/price`, { bill_unit_type: 'hourly', bill_rate: 1500, pay_unit_type: 'hourly', pay_rate: 1200, bill_qty: '', pay_qty: '' })
  r = await row(I, d)
  const minutes = Math.round(r.hours * 60) // 9:00〜16:20・休憩45分 = 395分
  ok('#147 時給の金額は分単位で計算する（数量は小数2桁）', p.status === 200 && minutes === 395 && r.pay_base === Math.round(1200 * minutes / 60) && r.bill_base === Math.round(1500 * minutes / 60) && r.pay_qty === 6.58,
    [r.hours, r.pay_qty, r.pay_base, r.bill_base])
  ok('#147 丸めた時間に掛けた額（ずれる額）ではない', r.pay_base !== Math.round(1200 * r.pay_qty), [r.pay_base, Math.round(1200 * r.pay_qty)])
  // シフトボードの金額の画面は、計算した数量（小数2桁）を入れたまま送る。その数量のときも分単位の金額のまま
  await admin.put(`/api/admin/shifts/${I}/price`, { bill_unit_type: 'hourly', bill_rate: 1500, pay_unit_type: 'hourly', pay_rate: 1200, bill_qty: String(r.bill_qty), pay_qty: String(r.pay_qty), transportation_fee: 500 })
  const r2 = await row(I, d)
  ok('#147 計算どおりの数量を送っても、金額は分単位のまま', r2.pay_base === Math.round(1200 * minutes / 60) && r2.bill_base === Math.round(1500 * minutes / 60), [r2.pay_qty, r2.pay_base, r2.bill_base])
  await admin.put(`/api/admin/shifts/${I}/price`, { bill_unit_type: 'hourly', bill_rate: 1500, pay_unit_type: 'hourly', pay_rate: 1200, bill_qty: '7', pay_qty: '7' })
  const r3 = await row(I, d)
  ok('#147 数量を変えたときは、その数量で計算する', r3.pay_base === 8400 && r3.bill_base === 10500, [r3.pay_qty, r3.pay_base, r3.bill_base])
}

// ---------- #565 粗利は支払が決まっている行だけ ----------
{
  const from = addDays(today, -12), to = today
  const d = addDays(today, -11)
  const U = await createShift(6, d, 'U'); await full(U)
  await admin.put(`/api/admin/shifts/${U}/price`, { bill_unit_type: 'daily', bill_rate: 20000, pay_unit_type: 'daily', pay_rate: '' })
  const v = (await list(from, to)).data
  const paid = v.rows.filter(r => r.pay_total != null), unset = v.rows.filter(r => r.pay_total == null)
  const sum = (a, k) => a.reduce((n, r) => n + Number(r[k] || 0), 0)
  ok('#565 支払未設定の行がある', unset.some(r => r.shift_id === U), unset.map(r => r.shift_id))
  ok('#565 粗利 = 支払が決まっている行の請求 − 支払', v.totals.profit === sum(paid, 'bill_total') - sum(paid, 'pay_total') && v.totals.profit_bill === sum(paid, 'bill_total'), v.totals)
  ok('#565 支払未設定の件数と請求額を返す', v.totals.pay_unset === unset.length && v.totals.pay_unset_bill === sum(unset, 'bill_total'), v.totals)
  const g = v.by_client.find(x => x.project_id === 1)
  const pr = v.rows.filter(r => r.project_id === 1 && r.pay_total != null)
  ok('#565 案件別の粗利も支払が決まっている行だけで計算し、未設定の件数を返す', g && g.profit === sum(pr, 'bill_total') - sum(pr, 'pay_total') && g.pay_unset >= 1, g)
  const board = (await admin.get(`/api/admin/shift-board?from=${d}&to=${d}`)).data
  ok('#565 シフトボードの粗利も支払が決まっている行だけ', board.totals.profit === board.totals.profit_bill - board.totals.pay && board.totals.pay_missing >= 1 && board.totals.pay_missing_bill >= 20000, board.totals)
}

// ---------- #23 請求前確認の金額を精算の請求合計とそろえる ----------
{
  const d = addDays(today, -2)
  const month = d.slice(0, 7)
  const K = await createShift(7, d, 'K'); await full(K)
  await admin.put(`/api/admin/shifts/${K}/price`, { bill_unit_type: 'daily', bill_rate: 15000, pay_unit_type: 'daily', pay_rate: 10000, transportation_fee: 1000, bill_transport_type: 'fixed', bill_transport_amount: 500, bill_adjust: 300 })
  const bc = await admin.get(`/api/admin/billing-check?month=${month}`)
  const last = addDays(month + '-01', 40).slice(0, 7) + '-01'
  const end = addDays(last, -1) < today ? addDays(last, -1) : today
  const v = (await list(month + '-01', end)).data
  const sum = (a, k) => a.reduce((n, r) => n + Number(r[k] || 0), 0)
  const p1 = bc.data.by_project.find(p => p.project_id === 1)
  const rows1 = v.rows.filter(r => r.project_id === 1)
  ok('#23 案件別の請求合計が精算の請求合計と同じ（交通費の請求区分・調整額を含む）', bc.status === 200 && p1.total_bill === sum(rows1, 'bill_total') && p1.total_transport === sum(rows1, 'bill_transport') && p1.total_adjust === sum(rows1, 'bill_adjust'), [p1, sum(rows1, 'bill_total')])
  const det = bc.data.detail.find(x => x.staff_id === 7 && x.project_id === 1)
  const rows7 = rows1.filter(r => r.staff_id === 7)
  ok('#23 スタッフ別の請求合計も精算と同じ', det && det.total === sum(rows7, 'bill_total') && det.transport === sum(rows7, 'bill_transport'), [det, sum(rows7, 'bill_total')])
  const bad = await admin.get('/api/admin/billing-check?month=%25')
  ok('#23 月の指定が不正なら 400', bad.status === 400, bad.status)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
