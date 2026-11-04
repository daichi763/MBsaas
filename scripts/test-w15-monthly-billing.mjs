// 請求単価の「月額（固定）」（利用者の要望 Sprint 15。#9702。w15-monthly-billing）の統合テスト
//   1. 案件の登録で「月額（固定）」を選べる（シフトの請求単価は日額 0、案件全体の月額のルールを作る）
//   2. 月額は、その月に確定・代打のシフトが1件以上あれば月に1回だけ請求する（シフトの数・時間に左右されない。シフトの金額には入れない）
//   3. 精算（集計・請求のタブ・請求の CSV・請求明細書・締め）、請求前確認、案件詳細・案件一覧・クライアント詳細の売上に「月額」の行として足す
//   4. スタッフ別の月額・金額の改定（適用開始月）・期間の重なり・締めた期間の変更の禁止
//   5. 時給・日額のシフトの金額は変わらない（月額のある案件でも、ない案件と同じ）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること（追加の起動オプションはない）
// 実行: BASE=http://127.0.0.1:8813 node scripts/test-w15-monthly-billing.mjs
//   日付は過去の期間（2018年5〜7月）を使い、締めは最後に解除する（ほかのテストの日付と重ならないように）
const BASE = process.env.BASE || 'http://127.0.0.1:8813'
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

const PFX = 'W15M' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// ---------- 画面のコード ----------
{
  const a = await staticJs('admin.js'), st = await staticJs('settlement.js')
  ok('案件の登録の請求単価に「月額（固定）」がある', a.includes('<option value="monthly">月額（固定）</option>') && a.includes('np-price-monthly-note'))
  ok('案件一覧・案件詳細の請求単価は月額を「/月」で出す', a.includes('function projectPriceText(p)') && a.includes('/月（固定）') && a.includes('うち月額'))
  ok('請求前確認に月額の列と CSV の列がある', a.includes("hasMonthly ? '<th>月額</th>' : ''") && a.includes("'スタッフID', '月額'"))
  ok('精算の単価の設定のタブに月額の欄（登録・変更・削除）がある', st.includes('settle-monthly-panel') && st.includes('/api/admin/settlement/monthly-rules')
    && ['monthlyAdd', 'monthlyEdit', 'monthlySave', 'monthlyDelete'].every(k => st.includes(`delegate('${k}'`)))
  ok('精算の請求のタブに月額の行、集計に月額の内訳がある', st.includes('function monthlyRowHtml(l)') && st.includes('settle-monthly-total') && st.includes('settle-monthly-note'))
  ok('月額の操作はイベント属性に値を埋め込まない', !/onclick="[^"]*monthly/i.test(st) && !/onclick="[^"]*monthly/i.test(a))
}

// ---------- 準備: クライアント・案件・スタッフ ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX} クライアント` }), 'client')
const opts0 = must(await admin.get('/api/admin/settlement/options'), 'options')
const CL = opts0.clients.find(c => c.client_name === `${PFX} クライアント`).client_id
{
  const bad = await admin.post('/api/admin/projects', { project_name: `${PFX}-月額0`, client_id: CL, unit_price_type: 'monthly', unit_price: 0 })
  ok('月額（固定）は1円以上（0円は登録しない）', bad.status === 400 && /月額/.test(bad.data?.error || ''), bad)
}
const PM = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-月額案件`, client_id: CL, unit_price_type: 'monthly', unit_price: 300000 }), 'monthly project').project_id
// 時給・日額との混在: 日額 16000 の案件に月額 100000 も足す。比べる用に、同じ日額で月額のない案件
const PD = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-日額＋月額`, client_id: CL, unit_price_type: 'daily', unit_price: 16000 }), 'daily project').project_id
const PC = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-日額のみ`, client_id: CL, unit_price_type: 'daily', unit_price: 16000 }), 'control project').project_id
const PH = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-時給`, client_id: CL, unit_price_type: 'hourly', unit_price: 1500 }), 'hourly project').project_id
{
  const p = must(await admin.get(`/api/admin/projects/${PM}?month=2018-05`), 'detail').project
  ok('月額の案件は、シフトの請求単価を日額 0 にする（シフトの計算に月額を混ぜない）', p.unit_price_type === 'daily' && Number(p.unit_price) === 0, p)
  ok('案件詳細は、その月の案件全体の月額を返す', Number(p.monthly_amount) === 300000, p.monthly_amount)
  const r = must(await admin.get(`/api/admin/settlement/monthly-rules?project_id=${PM}`), 'rules')
  ok('案件の登録で、案件全体・期限なしの月額のルールを作る', r.rules.length === 1 && r.rules[0].staff_id == null && Number(r.rules[0].amount) === 300000 && !r.rules[0].valid_from && !r.rules[0].valid_to, r.rules)
  const list = must(await admin.get('/api/admin/projects?month=2018-05'), 'projects').projects
  ok('案件一覧は月額（monthly_amount）を返し、月額のない案件は null', Number(list.find(x => x.project_id === PM).monthly_amount) === 300000 && list.find(x => x.project_id === PC).monthly_amount == null)
  const pd = must(await admin.get(`/api/admin/projects/${PD}`), 'detail').project
  ok('日額の案件は今までどおり（日額 16000）', pd.unit_price_type === 'daily' && Number(pd.unit_price) === 16000, pd)
}
must(await admin.post('/api/admin/settlement/monthly-rules', { project_id: PD, amount: 100000, memo: '管理費' }), 'rule PD')

const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const A = await newStaff(1), B = await newStaff(2)
const newShift = async (project_id, staff_id, work_date, extra = {}) => must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '19:00', ...extra }), 'shift').shift_id
// 5月: A 2件・B 1件、6月: なし、7月: A 1件
const m1 = await newShift(PM, A, '2018-05-10'), m2 = await newShift(PM, B, '2018-05-15'), m3 = await newShift(PM, A, '2018-05-20'), m4 = await newShift(PM, A, '2018-07-03')
const d1 = await newShift(PD, A, '2018-05-11'), c1 = await newShift(PC, A, '2018-05-12'), h1 = await newShift(PH, B, '2018-05-13')

const settle = async (from, to, extra = '') => must(await admin.get(`/api/admin/settlement?from=${from}&to=${to}&client_id=${CL}${extra}`), 'settlement')

// ---------- 2. 月に1回・シフトの金額には入れない ----------
{
  const s = await settle('2018-05-01', '2018-05-31')
  const rowOf = (id) => s.rows.find(r => r.shift_id === id)
  const pm = s.monthly_lines.filter(l => l.project_id === PM)
  ok('月額は、その月にシフトが何件あっても1回だけ（3件 → 1行）', pm.length === 1 && pm[0].amount === 300000 && pm[0].shifts === 3 && pm[0].ym === '2018-05' && pm[0].staff_id == null, pm)
  ok('計上する日は、その月の最初のシフトの日', pm[0]?.bill_date === '2018-05-10', pm[0])
  ok('月額の案件のシフトの請求額は 0（月額をシフトに入れない）', [m1, m2, m3].every(id => rowOf(id) && rowOf(id).bill_total === 0), [m1, m2, m3].map(rowOf).map(r => r && r.bill_total))
  ok('月額の案件のシフトには「請求単価未設定」を出さない', [m1, m2, m3].every(id => !rowOf(id).issues.includes('請求単価未設定') && !rowOf(id).acked_issues.includes('請求単価未設定')), rowOf(m1).issues)
  const shiftBill = s.rows.reduce((n, r) => n + r.bill_total, 0)
  ok('請求合計 = シフトの請求額 + 月額（月額 300000 + 100000）', s.totals.bill === shiftBill + 400000 && s.totals.monthly_bill === 400000 && s.totals.monthly_count === 2, [s.totals, shiftBill])
  ok('シフトの集計（by_client）には月額を入れない', s.by_client.reduce((n, g) => n + g.bill_total, 0) === shiftBill)
  // 5. 時給・日額は変わらない: 月額のある日額の案件と、ない案件のシフトの金額が同じ
  const d = rowOf(d1), cc = rowOf(c1), h = rowOf(h1)
  ok('日額のシフトの金額は、月額のある案件でもない案件と同じ（16000）', d && cc && d.bill_total === cc.bill_total && d.bill_rate === 16000 && d.bill_unit_type === 'daily' && d.bill_qty === cc.bill_qty, [d, cc].map(r => r && [r.bill_unit_type, r.bill_rate, r.bill_qty, r.bill_total]))
  ok('時給のシフトは今までどおり（時給 1500 × 時間）', h && h.bill_unit_type === 'hourly' && h.bill_rate === 1500 && h.bill_total === Math.round(1500 * h.bill_qty), h && [h.bill_unit_type, h.bill_rate, h.bill_qty, h.bill_total])
  const pd = s.monthly_lines.find(l => l.project_id === PD)
  ok('日額と月額の混在: 月額は別の行（備考つき）', pd && pd.amount === 100000 && pd.memo === '管理費' && pd.shifts === 1, pd)
}
{
  const s = await settle('2018-05-01', '2018-07-31')
  const pm = s.monthly_lines.filter(l => l.project_id === PM).map(l => l.ym)
  ok('シフトのない月（6月）は請求しない', JSON.stringify(pm) === JSON.stringify(['2018-05', '2018-07']), pm)
  const half = await settle('2018-05-01', '2018-05-09'), rest = await settle('2018-05-10', '2018-05-31')
  ok('期間を区切っても月額は1回だけ（最初のシフトの日を含む期間に出す）', !half.monthly_lines.some(l => l.project_id === PM) && rest.monthly_lines.filter(l => l.project_id === PM).length === 1)
  const payee = await settle('2018-05-01', '2018-05-31', '&payee_type=payroll_daily')
  ok('支払区分で絞ったときは月額を出さない', payee.monthly_lines.length === 0 && !payee.totals.monthly_bill)
}

// ---------- 4. スタッフ別の月額・改定・重なり ----------
{
  const r1 = must(await admin.post('/api/admin/settlement/monthly-rules', { project_id: PM, staff_id: A, amount: 50000, valid_from: '2018-05' }), 'staff rule')
  const s = await settle('2018-05-01', '2018-07-31')
  const a = s.monthly_lines.filter(l => l.project_id === PM && l.staff_id === A).map(l => [l.ym, l.amount, l.shifts])
  ok('スタッフ別の月額は、そのスタッフのシフトがある月に1回（5月 2件・7月 1件）', JSON.stringify(a) === JSON.stringify([['2018-05', 50000, 2], ['2018-07', 50000, 1]]), a)
  ok('スタッフ別の月額は、案件全体の月額とは別に請求する', s.monthly_lines.filter(l => l.project_id === PM && l.ym === '2018-05').length === 2)
  ok('シフトのないスタッフ（B は7月なし）のスタッフ別の月額は出ない', !s.monthly_lines.some(l => l.staff_id === B))
  const sa = await settle('2018-05-01', '2018-05-31', `&staff_id=${A}`)
  ok('スタッフで絞ると、そのスタッフのスタッフ別の月額だけ', sa.monthly_lines.length === 1 && sa.monthly_lines[0].staff_id === A, sa.monthly_lines)
  const dup = await admin.post('/api/admin/settlement/monthly-rules', { project_id: PM, staff_id: A, amount: 60000, valid_from: '2018-04', valid_to: '2018-05' })
  ok('同じ対象の期間が重なる月額は登録できない', dup.status === 409 && /重なって/.test(dup.data?.error || ''), dup)
  // 改定: 案件全体を7月から 350000 にする（前の月額は6月まで）
  const rev = must(await admin.post('/api/admin/settlement/monthly-rules', { project_id: PM, amount: 350000, valid_from: '2018-07' }), 'revise')
  const rules = must(await admin.get(`/api/admin/settlement/monthly-rules?project_id=${PM}`), 'rules').rules.filter(r => r.staff_id == null)
  ok('適用開始月を付けて追加すると、前の月額をその前の月までにする（改定）', rev.revised_rule_id && rules.some(r => r.rule_id === rev.revised_rule_id && r.valid_to === '2018-06') && rules.some(r => r.rule_id === rev.rule_id && r.valid_from === '2018-07'), rules)
  const s2 = await settle('2018-05-01', '2018-07-31')
  const amounts = s2.monthly_lines.filter(l => l.project_id === PM && l.staff_id == null).map(l => [l.ym, l.amount])
  ok('改定の前の月は前の月額、後の月は新しい月額（月の途中では変えない）', JSON.stringify(amounts) === JSON.stringify([['2018-05', 300000], ['2018-07', 350000]]), amounts)
  const gap = await admin.post('/api/admin/settlement/monthly-rules', { project_id: PM, amount: 1000, valid_from: '2030-01', valid_to: '2030-02' })
  const after = must(await admin.get(`/api/admin/settlement/monthly-rules?project_id=${PM}`), 'rules').rules
  ok('終了月のある月額では、期限のない月額を切らない（後に隙間ができるので重なりとして断る）', gap.status === 409 && after.some(r => r.rule_id === rev.rule_id && !r.valid_to), [gap.status, after])
  const badYm = await admin.post('/api/admin/settlement/monthly-rules', { project_id: PM, amount: 1000, valid_from: '2018-13' })
  ok('適用する月の形が違うと 400', badYm.status === 400, badYm.status)
  const badAmt = await admin.put(`/api/admin/settlement/monthly-rules/${r1.rule_id}`, { amount: -5 })
  ok('月額のマイナスは 400', badAmt.status === 400, badAmt.status)
  const none = await admin.put('/api/admin/settlement/monthly-rules/99999999', { amount: 5 })
  ok('ない月額の変更は 404', none.status === 404, none.status)
  const noProject = await admin.post('/api/admin/settlement/monthly-rules', { project_id: 99999999, amount: 5 })
  ok('ない案件には登録できない（404）', noProject.status === 404, noProject.status)
}

// ---------- 3. 請求前確認・案件詳細・クライアント詳細 ----------
{
  const bc = must(await admin.get('/api/admin/billing-check?month=2018-05'), 'billing-check')
  const p = bc.by_project.find(x => x.project_id === PM)
  ok('請求前確認: 案件の月額（案件全体 300000 + スタッフ別 50000）を請求合計に含める', p && p.total_monthly === 350000 && p.total_bill === p.total_amount + p.total_transport + p.total_adjust + 350000, p)
  const dA = bc.detail.find(x => x.project_id === PM && x.staff_id === A), dB = bc.detail.find(x => x.project_id === PM && x.staff_id === B)
  ok('請求前確認: スタッフ別の月額はそのスタッフの行に出す', dA && dA.monthly === 50000 && dB && dB.monthly === 0, [dA, dB])
  ok('請求前確認: 月額の行（monthly_lines）を返す', bc.monthly_lines.filter(l => l.project_id === PM).length === 2)
  const pc = bc.by_project.find(x => x.project_id === PC)
  ok('請求前確認: 月額のない案件は今までどおり（total_monthly 0）', pc && pc.total_monthly === 0 && pc.total_bill === pc.total_amount + pc.total_transport + pc.total_adjust, pc)
  const det = must(await admin.get(`/api/admin/projects/${PM}?month=2018-05`), 'detail').month_summary
  ok('案件詳細: その月の売上（概算）に月額を足す', det.monthly_bill === 350000 && det.revenue === det.bill_total + 350000, det)
  const june = must(await admin.get(`/api/admin/projects/${PM}?month=2018-06`), 'detail').month_summary
  ok('案件詳細: シフトのない月は月額なし', june.monthly_bill === 0 && june.revenue === 0, june)
  const cd = must(await admin.get(`/api/admin/clients/${CL}?month=2018-05`), 'client detail')
  const cp = cd.projects.find(x => x.project_id === PM)
  ok('クライアント詳細: 案件の売上に月額を足す', cp && cp.bill_total === 350000, cp)
  const tr = cd.trend.find(t => t.ym === '2018-05'), all = await settle('2018-05-01', '2018-05-31')
  ok('クライアント詳細: 月別の売上に月額を足す（精算の請求合計と同じ）', tr && tr.bill_total === all.totals.bill, [tr, all.totals.bill])
}

// ---------- 3. 請求の CSV・明細書・締め ----------
let closingId = null
{
  const csv = await admin.get(`/api/admin/settlement/export?kind=billing&from=2018-05-01&to=2018-05-31&client_id=${CL}`)
  const lines = csv.text.replace(/^﻿/, '').split('\r\n')
  ok('請求の CSV: 区分・対象月・月額の対象の列を末尾に足す（既存の列の位置は変えない）', lines[0] === 'クライアント,案件,シフト数,スタッフ数,時間,請求基本額,交通費,調整,請求合計,確定数,区分,対象月,月額の対象', lines[0])
  const mon = lines.filter(l => l.includes('月額（固定）'))
  ok('請求の CSV: 月額の行（案件全体・スタッフ別）', mon.length === 3 && mon.some(l => l.includes(',350000,') === false && l.includes('300000') && l.includes('案件全体')) && mon.some(l => l.includes('50000') && l.includes(`${PFX} スタッフ1`)), mon)
  const pmRow = lines.findIndex(l => l.includes(`${PFX}-月額案件`) && l.includes(',シフト,'))
  ok('請求の CSV: 月額の行は、同じ案件のシフトの行の後に置く', pmRow > 0 && lines[pmRow + 1].includes('月額（固定）'), lines.slice(pmRow, pmRow + 3))
  // 確定前の明細書には月額を載せない（その月に確定済みのシフトがない）
  const st0 = await admin.get(`/api/admin/settlement/statement?kind=billing&client_id=${CL}&from=2018-05-01&to=2018-05-31`)
  ok('明細書: その月に確定済みのシフトがない月額は載せない', st0.status === 200 && !st0.text.includes('月額（固定）') && st0.text.includes('確定済みのシフトのない月額 3件'), st0.text.slice(-600))
  const all = await settle('2018-05-01', '2018-05-31')
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: all.rows.map(r => r.shift_id), force: true }), 'confirm')
  const st1 = await admin.get(`/api/admin/settlement/statement?kind=billing&client_id=${CL}&from=2018-05-01&to=2018-05-31`)
  const sum = all.rows.reduce((n, r) => n + r.bill_total, 0) + 400000 + 50000
  ok('明細書: 確定後は月額の行（2018年5月分）を載せ、合計に含める', st1.text.includes('2018年5月分') && st1.text.includes('月額（固定）・管理費') && st1.text.includes('¥' + sum.toLocaleString('en-US')), st1.text.match(/請求合計: [^<]*/)?.[0])
  const s = await settle('2018-05-01', '2018-05-31', '&settle=confirmed')
  ok('確定で絞ると、その月に確定済みのシフトがある月額だけ', s.monthly_lines.length === 3 && s.monthly_lines.every(l => l.confirmed > 0))
  // 締め: 請求合計に月額を含める。締めた期間に計上した月額は変えられない
  const cl = await admin.post('/api/admin/settlement/closings', { from: '2018-05-01', to: '2018-05-31', force: true })
  closingId = cl.data?.closing_id
  const totalAll = (await admin.get('/api/admin/settlement?from=2018-05-01&to=2018-05-31')).data.totals.bill
  ok('締め: 請求合計に月額を含める（精算の画面の請求合計と同じ）', cl.status === 200 && cl.data.bill === totalAll, [cl.data, totalAll])
  const rules = must(await admin.get(`/api/admin/settlement/monthly-rules?project_id=${PM}`), 'rules').rules
  const may = rules.find(r => r.staff_id == null && r.valid_to === '2018-06')
  const put = await admin.put(`/api/admin/settlement/monthly-rules/${may.rule_id}`, { amount: 1 })
  ok('締めた期間に計上した月額の金額は変えられない', put.status === 409 && /締め/.test(put.data?.error || ''), put)
  const memo = await admin.put(`/api/admin/settlement/monthly-rules/${may.rule_id}`, { memo: '備考だけ' })
  ok('備考だけは変えられる', memo.status === 200, memo)
  const del = await admin.del(`/api/admin/settlement/monthly-rules/${may.rule_id}`)
  ok('締めた期間に計上した月額は削除できない', del.status === 409, del.status)
  const july = rules.find(r => r.staff_id == null && r.valid_from === '2018-07')
  const putJuly = await admin.put(`/api/admin/settlement/monthly-rules/${july.rule_id}`, { amount: 360000 })
  ok('締めていない月の月額は変えられる', putJuly.status === 200, putJuly)
  if (closingId) must(await admin.post(`/api/admin/settlement/closings/${closingId}/reopen`, { reason: 'テストの後片付け' }), 'reopen')
}

// ---------- 案件の削除で月額のルールも消す ----------
{
  const P2 = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-削除用`, unit_price_type: 'monthly', unit_price: 1000 }), 'p2').project_id
  const del = await admin.del(`/api/admin/projects/${P2}`)
  ok('使われていない月額の案件は削除でき、月額のルールも一緒に消える', del.status === 200 && (await admin.get(`/api/admin/settlement/monthly-rules?project_id=${P2}`)).status === 404, del)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:\n' + failed.map(f => '  - ' + f.name).join('\n')); process.exit(1) }
