// 請求前確認と精算の計算を1つにする（Sprint 19。#9931 #9938。w19-billing）の統合テスト
//   1. 請求前確認（GET /api/admin/billing-check）の請求合計に、欠勤・中止のキャンセル料（shift_cancellations.bill_amount）を含める
//   2. 精算（GET /api/admin/settlement）と同じ対象・同じ計算（src/settlement.ts の settleAmounts・loadSettleMoney）で、同じ期間なら請求・支払の合計が1円まで一致する
//   3. キャンセル料の行が請求前確認の明細で分かる（列・バッジ・キャンセル料の明細・CSV の列）
//   4. 精算の一覧の行と集計は今までどおり（欠勤・中止の行の金額、勤務の行の金額）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること（追加の起動オプションはない）
// 実行: BASE=http://127.0.0.1:8610 node scripts/test-w19-billing.mjs
//   日付は過去の期間（2017年8月）を使う（ほかのテスト・シードの日付と重ならないように）
const BASE = process.env.BASE || 'http://127.0.0.1:8610'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

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
const staticJs = async (name) => (await fetch(`${BASE}/static/${name}`)).text()
const sum = (a, k) => a.reduce((n, r) => n + Number(r[k] || 0), 0)

const PFX = 'W19B' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }
const settlement = async (from, to, extra = '') => must(await admin.get(`/api/admin/settlement?from=${from}&to=${to}${extra}`), 'settlement')
const billing = async (month) => must(await admin.get(`/api/admin/billing-check?month=${month}`), 'billing-check')

// ---------- 画面のコード ----------
{
  const a = await staticJs('admin.js')
  ok('請求前確認にキャンセル料の列（案件別・スタッフ別）がある', a.includes("hasCancel ? '<th>キャンセル料</th>' : ''") && a.includes('cancelCell(p.total_cancel, p.cancel_count, false)') && a.includes('cancelCell(d.cancel, d.cancel_count, true)'))
  ok('スタッフ別明細のキャンセル料はバッジで出す（精算の画面と同じ badge-red）', a.includes('<span class="badge badge-red whitespace-nowrap">キャンセル料 ${Number(n)}件</span>'))
  ok('キャンセル料の明細（欠勤・中止の区分のバッジ付き）と、会社全体の請求合計を出す', a.includes('id="billing-cancel-lines"') && a.includes('${esc(l.reason_label)}') && a.includes('id="billing-totals"'))
  ok('説明文に「キャンセル料」と、精算と合計が一致する期間を書く', a.includes('請求基本額＋請求する交通費＋請求の調整＋キャンセル料') && a.includes('精算で期間をこの月の1日〜今日（過去の月は月末）にすると、請求合計が一致します'))
  ok('CSV にキャンセル料の列がある（今までの列の後ろ）', a.includes("'スタッフID', '月額', 'キャンセル料'"))
  ok('請求前確認の操作はイベント属性に値を埋め込まない', !/onclick="[^"]*\$\{/.test(a.slice(a.indexOf('// ============ 請求前確認'), a.indexOf('function adminCsvCell'))))
}

// ---------- 準備: クライアント・案件・スタッフ・シフト（2017年8月） ----------
const MONTH = '2017-08', FROM = '2017-08-01', TO = '2017-08-31'
must(await admin.post('/api/admin/clients', { client_name: `${PFX} クライアント` }), 'client')
const opts = must(await admin.get('/api/admin/settlement/options'), 'options')
const CL = opts.clients.find(c => c.client_name === `${PFX} クライアント`).client_id
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: CL, unit_price_type: 'daily', unit_price: 15000 }), 'project').project_id
const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const A = await newStaff(1), B = await newStaff(2)
const newShift = async (staff_id, work_date) => must(await admin.post('/api/admin/shifts', { staff_id, project_id: P, work_date, start_time: '10:00', end_time: '19:00', unit_price: 15000 }), 'shift').shift_id
const w1 = await newShift(A, '2017-08-03'), w2 = await newShift(B, '2017-08-04')
const c1 = await newShift(A, '2017-08-10'), c2 = await newShift(B, '2017-08-11'), c3 = await newShift(B, '2017-08-12')
// 勤務の行: 交通費の請求区分・調整額を入れる
must(await admin.put(`/api/admin/shifts/${w1}/price`, { bill_unit_type: 'daily', bill_rate: 15000, pay_unit_type: 'daily', pay_rate: 10000, transportation_fee: 1000, bill_transport_type: 'fixed', bill_transport_amount: 500, bill_adjust: 300, pay_adjust: -200 }), 'price w1')
must(await admin.put(`/api/admin/shifts/${w2}/price`, { bill_unit_type: 'daily', bill_rate: 16000, pay_unit_type: 'daily', pay_rate: 11000, transportation_fee: 800 }), 'price w2')
// 欠勤・中止: c1 はクライアント都合の中止（キャンセル料 15000・補償 6000）、c2 はスタッフ都合の欠勤（キャンセル料 3000・控除 -1000）、
// c3 はキャンセル料を入れていない欠勤（精算の対象外）
for (const id of [c1, c2, c3]) must(await admin.put(`/api/admin/shifts/${id}`, { status: 'absent' }), 'absent')
must(await admin.put(`/api/admin/settlement/cancellations/${c1}`, { reason: 'client', notified_on: '2017-08-10', bill_amount: 15000, pay_amount: 6000, note: '店舗都合で中止' }), 'cancel c1')
must(await admin.put(`/api/admin/settlement/cancellations/${c2}`, { reason: 'staff', notified_on: '2017-08-10', bill_amount: 3000, pay_amount: -1000 }), 'cancel c2')

// ---------- 1. 請求前確認の請求合計にキャンセル料を含める ----------
const bc = await billing(MONTH)
const set = await settlement(FROM, TO)
{
  const p = bc.by_project.find(x => x.project_id === P)
  ok('案件別: キャンセル料（2件 18000）を total_cancel に出し、請求合計に含める', p && p.total_cancel === 18000 && p.cancel_count === 2
    && p.total_bill === p.total_amount + p.total_transport + p.total_adjust + p.total_cancel + p.total_monthly, p)
  ok('案件別: 請求基本額・交通費・調整は勤務の分だけ（キャンセル料を混ぜない）', p && p.total_amount === 31000 && p.total_transport === 500 + 800 && p.total_adjust === 300, p)
  ok('案件別: 欠勤は3件（キャンセル料を入れていない欠勤も数える）', p && p.absent_days === 3, p)
  const dA = bc.detail.find(x => x.project_id === P && x.staff_id === A), dB = bc.detail.find(x => x.project_id === P && x.staff_id === B)
  ok('スタッフ別: キャンセル料をそのスタッフの行に出し、請求合計に含める', dA && dA.cancel === 15000 && dA.cancel_count === 1 && dA.total === 15000 + 500 + 300 + 15000
    && dB && dB.cancel === 3000 && dB.cancel_count === 1 && dB.total === 16000 + 800 + 3000, [dA, dB])
  const lines = bc.cancel_lines.filter(l => l.project_id === P)
  ok('キャンセル料の行（cancel_lines）を、稼働日の順に区分・メモ付きで返す（未入力の欠勤は入れない）', lines.length === 2
    && lines[0].shift_id === c1 && lines[0].reason === 'client' && lines[0].reason_label === 'クライアント都合の中止' && lines[0].bill_amount === 15000 && lines[0].note === '店舗都合で中止'
    && lines[0].staff_name === `${PFX} スタッフ1` && lines[0].project_name === `${PFX}-案件`
    && lines[1].shift_id === c2 && lines[1].reason_label === 'スタッフ都合の欠勤' && lines[1].bill_amount === 3000 && !lines.some(l => l.shift_id === c3), lines)
}

// ---------- 2. 精算と同じ期間なら合計が一致する ----------
{
  const rowsP = set.rows.filter(r => r.project_id === P)
  const p = bc.by_project.find(x => x.project_id === P)
  ok('案件別の請求合計が、精算の同じ案件の行の請求合計（キャンセル料を含む）と一致する', p.total_bill === sum(rowsP, 'bill_total') && sum(rowsP, 'bill_total') === 31000 + 1300 + 300 + 18000, [p.total_bill, sum(rowsP, 'bill_total')])
  ok('案件別のキャンセル料が、精算の欠勤・中止の行の請求額と一致する', p.total_cancel === sum(rowsP.filter(r => r.kind === 'cancel'), 'bill_total'))
  for (const sid of [A, B]) {
    const d = bc.detail.find(x => x.project_id === P && x.staff_id === sid), rs = rowsP.filter(r => r.staff_id === sid)
    ok(`スタッフ別（${sid === A ? 'A' : 'B'}）の請求合計が精算と一致する`, d && d.total === sum(rs, 'bill_total'), [d && d.total, sum(rs, 'bill_total')])
  }
  ok('会社全体: 請求前確認の請求合計・支払合計が、精算の同じ期間の請求合計・支払合計と1円まで一致する（過去の月）',
    bc.totals.bill === set.totals.bill && bc.totals.pay === set.totals.pay && bc.totals.cancel_bill === set.totals.cancel_bill && bc.totals.cancel_pay === set.totals.cancel_pay
    && bc.totals.cancel_count === set.totals.cancel_shifts && bc.totals.monthly_bill === (set.totals.monthly_bill || 0), [bc.totals, set.totals])
  const setP = await settlement(FROM, TO, `&client_id=${CL}`)
  ok('支払: 精算のこの案件の支払合計（補償 6000・控除 -1000 を含む）', setP.totals.pay === (10000 + 1000 - 200) + (11000 + 800) + 6000 - 1000 && setP.totals.cancel_pay === 5000, setP.totals)
  // 今月・前月（シードのデータ）も、その月の1日〜今日（前月は末日）で一致する
  const today = jstToday(), cur = today.slice(0, 7)
  const prev = new Date(Date.UTC(Number(cur.slice(0, 4)), Number(cur.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7)
  for (const [m, to] of [[cur, today], [prev, lastDay(prev)]]) {
    const b = await billing(m), s = await settlement(m + '-01', to)
    ok(`会社全体: ${m} の請求前確認と精算（${m}-01〜${to}）の請求合計・支払合計が一致する`, !s.truncated && b.totals.bill === s.totals.bill && b.totals.pay === s.totals.pay
      && sum(b.by_project, 'total_bill') === s.totals.bill, [b.totals, s.totals, sum(b.by_project, 'total_bill')])
  }
  // 未来の月は対象がない
  const future = await billing('2099-01')
  ok('未来の月は請求合計 0（今日より後のシフトは数えない）', future.totals.bill === 0 && future.cancel_lines.length === 0, future.totals)
}

// ---------- 3. キャンセル料を変えると、請求前確認と精算の両方が変わる ----------
{
  must(await admin.put(`/api/admin/settlement/cancellations/${c2}`, { reason: 'staff', notified_on: '2017-08-10', bill_amount: 4500, pay_amount: -1000 }), 'cancel c2 change')
  const b = await billing(MONTH), s = await settlement(FROM, TO)
  const p = b.by_project.find(x => x.project_id === P)
  ok('キャンセル料を変えると請求前確認の合計も変わり、精算と一致したまま', p.total_cancel === 19500 && b.totals.bill === s.totals.bill && b.totals.bill === bc.totals.bill + 1500, [p.total_cancel, b.totals.bill, s.totals.bill])
  // 精算の対象から外すと、請求前確認からも外れる
  must(await admin.put(`/api/admin/settlement/cancellations/${c2}`, { remove: true }), 'cancel c2 remove')
  const b2 = await billing(MONTH), s2 = await settlement(FROM, TO)
  const p2 = b2.by_project.find(x => x.project_id === P)
  ok('精算の対象から外したキャンセル料は、請求前確認からも外れる', p2.total_cancel === 15000 && p2.cancel_count === 1 && !b2.cancel_lines.some(l => l.shift_id === c2) && b2.totals.bill === s2.totals.bill, [p2, b2.totals.bill, s2.totals.bill])
}

// ---------- 4. 精算の一覧の行・集計は今までどおり ----------
{
  const s = await settlement(FROM, TO, `&client_id=${CL}`)
  const r1 = s.rows.find(r => r.shift_id === c1), rw = s.rows.find(r => r.shift_id === w1)
  ok('精算: 欠勤・中止の行は、請求・支払がキャンセル料・補償の値で、時間・単価・交通費は使わない', r1 && r1.kind === 'cancel' && r1.bill_base === 15000 && r1.bill_transport === 0 && r1.bill_adjust === 0 && r1.bill_total === 15000
    && r1.pay_base === 6000 && r1.pay_transport === 0 && r1.pay_adjust === 0 && r1.pay_total === 6000 && r1.pay_premium === 0 && r1.bill_rate === null && r1.transportation_fee === 0 && r1.hours === 0
    && r1.adjust_note === '店舗都合で中止' && r1.cancel_reason === 'client', r1)
  ok('精算: 勤務の行は交通費の請求区分・調整額を含む（今までどおり）', rw && rw.kind === 'work' && rw.bill_base === 15000 && rw.bill_transport === 500 && rw.bill_adjust === 300 && rw.bill_total === 15800
    && rw.pay_base === 10000 && rw.pay_transport === 1000 && rw.pay_adjust === -200 && rw.pay_total === 10800, rw)
  ok('精算: 集計のキャンセル料・補償の内訳', s.totals.cancel_shifts === 1 && s.totals.cancel_bill === 15000 && s.totals.cancel_pay === 6000 && s.totals.bill === 15800 + 16800 + 15000, s.totals)
  ok('精算: キャンセル料を入れていない欠勤は一覧に入らず、未入力の欠勤の一覧に出る', !s.rows.some(r => r.shift_id === c3) && s.absent_shifts.some(x => x.shift_id === c3) && s.absent_shifts.some(x => x.shift_id === c2))
  const bad = await admin.get('/api/admin/billing-check?month=2017-13')
  ok('月の指定が不正なら 400', bad.status === 400, bad.status)
}

// ---------- 5. 精算の読み込みを軽くした所（#9938）: 絞り込みなし（読んだ行を使い回す）と絞り込みあり（読み直す）で同じ結果 ----------
{
  // 期間の最後の日の夜勤と、期間の外（翌日）の重なるシフト・深夜の割増・確認済みの印
  const C = await newStaff(3)
  const n1 = must(await admin.post('/api/admin/shifts', { staff_id: C, project_id: P, work_date: '2017-08-31', start_time: '22:00', end_time: '03:00', unit_price: 15000 }), 'night').shift_id
  must(await admin.post('/api/admin/shifts', { staff_id: C, project_id: P, work_date: '2017-09-01', start_time: '01:00', end_time: '05:00', unit_price: 15000 }), 'next day')
  must(await admin.put(`/api/admin/shifts/${n1}/price`, { bill_unit_type: 'daily', bill_rate: 15000, pay_unit_type: 'hourly', pay_rate: 1200 }), 'price n1')
  const premiumBefore = must(await admin.get('/api/admin/settlement/premium-settings'), 'premium get').settings
  must(await admin.put('/api/admin/settlement/premium-settings', { enabled: true, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [], daily_limit_minutes: 480 }), 'premium on')
  const all = await settlement(FROM, TO), byStaff = await settlement(FROM, TO, `&staff_id=${C}`), byClient = await settlement(FROM, TO, `&client_id=${CL}`)
  const ra = all.rows.find(r => r.shift_id === n1), rs = byStaff.rows.find(r => r.shift_id === n1), rc = byClient.rows.find(r => r.shift_id === n1)
  const overlapText = (r) => (r?.issues || []).find(i => i.startsWith('同じ時間帯に別のシフトあり（9/1 01:00〜05:00'))
  ok('期間の最後の日のシフトと、期間の外（翌日）のシフトの重なりを、絞り込みなしでも出す', !!overlapText(ra) && overlapText(ra) === overlapText(rs) && overlapText(ra) === overlapText(rc), [ra?.issues, rs?.issues])
  ok('深夜の割増は、絞り込みなし・絞り込みありで同じ（読んだ行を使い回しても同じ計算）', ra && ra.pay_premium > 0 && ra.pay_premium === rs.pay_premium && ra.pay_premium === rc.pay_premium && ra.pay_total === rs.pay_total
    && ra.premium_night_minutes === rs.premium_night_minutes, [ra?.pay_premium, rs?.pay_premium, rc?.pay_premium])
  const b = await billing(MONTH), s = await settlement(FROM, TO)
  ok('割増のある月も、請求前確認と精算の支払合計が一致する', b.totals.pay === s.totals.pay && b.totals.bill === s.totals.bill, [b.totals, s.totals])
  // 確認済みの印（#563）は、絞り込みなし・ありの両方で同じ
  must(await admin.post('/api/admin/settlement/acks', { shift_ids: [n1] }), 'ack')
  const a2 = (await settlement(FROM, TO)).rows.find(r => r.shift_id === n1), s2 = (await settlement(FROM, TO, `&staff_id=${C}`)).rows.find(r => r.shift_id === n1)
  ok('確認済みの印は、絞り込みなし・ありで同じ', a2 && a2.acked_issues.length > 0 && JSON.stringify(a2.acked_issues) === JSON.stringify(s2.acked_issues) && a2.acked_at === s2.acked_at && JSON.stringify(a2.issues) === JSON.stringify(s2.issues), [a2?.acked_issues, s2?.acked_issues])
  ok('精算の絞り込みの選択肢に、期間のスタッフ（欠勤だけの人を含む）を返す', [A, B, C].every(id => all.staff_options.some(o => o.staff_id === id && o.staff_name.startsWith(PFX))), all.staff_options.slice(0, 5))
  must(await admin.put('/api/admin/settlement/premium-settings', premiumBefore), 'premium restore')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
