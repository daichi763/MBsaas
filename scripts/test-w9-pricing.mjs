// 単価の設定を精算画面へ移す（利用者の要望 Sprint 9。w9-pricing）の統合テスト
//
// 9201 案件詳細: 区分・標準単価と単価ルールの欄を外し、基本単価（表示だけ）と備考（projects.remarks）を置く
// 9202 案件詳細: 求められる内容・案件マニュアル・備考をその場で編集（PUT /admin/projects/:id）
// 9203 精算画面: 「単価の設定」のタブ。区分・標準単価・単価ルール（人ごとの単価・インセンティブ・備考）。計算は変えない
// 9204 スタッフマスタ: スタッフ別の単価の欄を外し、支払の参考単価（staff_profiles.reference_pay_*）を入れる。他社連携の行には出さない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w9-pricing.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8811'
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
const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const staticJs = async (name) => (await fetch(`${BASE}/static/${name}`)).text()

const PFX = 'W9P' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// ---------- 画面のコード（配信される JS） ----------
{
  const a = await staticJs('admin.js'), sb = await staticJs('shift-board.js'), st = await staticJs('settlement.js')
  ok('9201 案件詳細は単価の設定の欄（renderProjectPricingPanel）を出さず、基本単価（表示だけ）と繰り返し登録を出す',
    !a.includes('renderProjectPricingPanel') && !sb.includes('window.renderProjectPricingPanel') && a.includes('projectBasePriceHtml(p)') && a.includes('renderProjectPatternsPanel(p)')
    && sb.includes('window.projectBasePriceHtml = function') && sb.includes('data-action="projectOpenPricing"'))
  ok('9201 基本単価の欄には入力欄がない（区分・標準単価の入力欄 pp-* は精算画面の単価の設定にだけある）', (() => {
    const i = sb.indexOf('window.projectBasePriceHtml'), j = sb.indexOf('window.renderProjectPatternsPanel')
    const part = sb.slice(i, j)
    return i > 0 && j > i && !/<input|<select/.test(part) && part.includes('請求') && part.includes('支払') && part.includes('交通費')
  })())
  ok('9201 案件の登録フォームの案内は精算画面の「単価の設定」', a.includes('登録後に精算画面の「単価の設定」で設定します') && !a.includes('登録後に案件詳細の「区分・標準単価」で設定します'))
  ok('9201 9202 案件詳細に備考の欄、求められる内容・案件マニュアル・備考の編集ボタン（その場で保存）',
    a.includes("['remarks', '備考', 2000") && a.includes('data-action="editProjectText"') && a.includes("delegate('saveProjectText'") && a.includes('putProjectConfirming(pid, { [k]: v })'))
  ok('9201 案件の登録・編集のフォームでも備考を送る', a.includes("remarks: document.getElementById('np-remarks').value") && a.includes("remarks: v('ep-remarks')"))
  ok('9203 精算画面に「単価の設定」のタブがあり、案件を選ぶと単価の設定を出す',
    st.includes("['pricing', '単価の設定']") && st.includes('function renderPricingTab') && st.includes('window.renderSettlePricingPanel') && st.includes('window.openSettlePricing = function'))
  ok('9203 単価の設定に区分・標準単価・休憩・時間の数え方・丸め・改定履歴・再適用・単価ルールがある', (() => {
    const i = sb.indexOf('window.renderSettlePricingPanel'), part = sb.slice(i, i + 12000)
    return i > 0 && ['pp-eng', 'pp-bill-unit', 'pp-pay', 'pp-bt', 'pp-pt', 'pp-valid-from', 'pp-break', 'pp-hours-basis', 'pp-round', 'pp-pay-round', 'priceHistoryHtml(ph)', 'data-action="pricingReprice"', 'data-action="ruleAdd"', 'data-action="editRule"', 'data-action="ruleSetEnd"', 'data-action="ruleDelete"'].every(k => part.includes(k))
  })())
  ok('9203 単価ルールにインセンティブ（加算額）・備考・参考単価の目安', sb.includes('id="rl-inc"') && sb.includes('pay_incentive') && sb.includes('<label class="col-span-2">備考') && sb.includes('/api/admin/staff-reference-pay') && sb.includes("data-action=\"ruleUseReference\""))
  ok('9203 単価の設定の操作はイベント属性に値を埋め込まない', !/onclick="(saveProjectPricing|repriceProject|openRuleModal|deleteRule|openPatternModal\(\{project_id)/.test(sb) && !sb.includes('onclick="window.__boardState.projectIds'))
  ok('9204 スタッフ詳細にスタッフ別の単価の欄がなく、支払の参考単価の欄がある',
    !a.includes('staff-rate-panel') && !sb.includes('window.renderStaffRatePanel') && a.includes('staff-reference-pay-panel') && sb.includes('window.renderStaffReferencePayPanel')
    && sb.includes('参考価格を入力してください。計算には使いません（精算画面で人ごとの単価を決めるときの目安として表示します）'))
  ok('9204 参考単価の欄は他社連携の行には出さない', sb.includes("['linked_external', 'skillsheet_only'].includes(p.affiliation_type)"))
}

// ---------- 9201 9202 案件の備考と、文の項目だけの更新 ----------
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, allow_duplicate: true, requirements: '接客経験', manual_text: '黒の靴', remarks: '  初回の備考  ' }), 'project').project_id
{
  const p0 = must(await admin.get(`/api/admin/projects/${P}`), 'project detail').project
  ok('9201 案件の登録で備考を保存する（前後の空白を除く）', p0.remarks === '初回の備考', p0.remarks)
  const r1 = await admin.put(`/api/admin/projects/${P}`, { remarks: '請求は月末締め' })
  const p1 = must(await admin.get(`/api/admin/projects/${P}`), 'project detail').project
  ok('9202 備考だけを PUT で変えられ、ほかの項目は変わらない', r1.status === 200 && p1.remarks === '請求は月末締め' && p1.requirements === '接客経験' && p1.manual_text === '黒の靴' && p1.project_name === `${PFX}-案件`, [r1, p1])
  const r2 = await admin.put(`/api/admin/projects/${P}`, { manual_text: '黒の靴\n名札を持参' })
  const p2 = must(await admin.get(`/api/admin/projects/${P}`), 'project detail').project
  ok('9202 案件マニュアルだけを PUT で変えられる（備考はそのまま）', r2.status === 200 && p2.manual_text === '黒の靴\n名札を持参' && p2.remarks === '請求は月末締め', p2)
  const r3 = await admin.put(`/api/admin/projects/${P}`, { remarks: 'あ'.repeat(2001) })
  ok('9201 備考は2000文字まで', r3.status === 400 && /備考/.test(r3.data?.error || ''), r3)
  const r4 = await admin.put(`/api/admin/projects/${P}`, { remarks: '   ' })
  const p4 = must(await admin.get(`/api/admin/projects/${P}`), 'project detail').project
  ok('9202 空欄で保存すると備考を消す', r4.status === 200 && p4.remarks === null, p4.remarks)
  const r5 = await admin.put(`/api/admin/projects/${P}`, { remarks: 123 })
  ok('9201 備考が文字でないときは 400', r5.status === 400, r5)
  const list = must(await admin.get('/api/admin/projects'), 'projects').projects.find(x => x.project_id === P)
  ok('9203 案件の一覧（単価の設定の選択肢）に単価の列がある', list && 'unit_price' in list && 'pay_rate' in list && 'engagement_type' in list && 'pay_transport_type' in list, list)
}

// ---------- 9203 単価の設定（標準単価・スタッフ別のルール・インセンティブ） ----------
const A = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 単価スタッフ`, phone: phone(1), affiliation_type: 'daily_worker', force: true }), 'staff-quick').staff_id
const B = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 他のスタッフ`, phone: phone(2), affiliation_type: 'daily_worker', force: true }), 'staff-quick').staff_id
let ruleId
{
  must(await admin.put(`/api/admin/projects/${P}/pricing`, { engagement_type: 'regular', unit_price_type: 'daily', unit_price: 18000, pay_unit_type: 'daily', pay_rate: 12000 }), 'pricing')
  const rr = await admin.post('/api/admin/rate-rules', { project_id: P, staff_id: A, pay_unit_type: 'daily', pay_rate: 14000, pay_incentive: 2000, memo: 'リーダー手当' })
  ok('9203 スタッフ別のルールにインセンティブ（加算額）と備考を付けて追加できる', rr.status === 200 && rr.data.rule_id > 0, rr)
  ruleId = rr.data?.rule_id
  const rules = must(await admin.get(`/api/admin/rate-rules?project_id=${P}`), 'rules').rules
  const r = rules.find(x => x.rule_id === ruleId)
  ok('9203 ルールの一覧に支払単価（加算後）・インセンティブ・備考・スタッフ名が出る', r && r.pay_rate === 14000 && r.pay_incentive === 2000 && r.memo === 'リーダー手当' && String(r.staff_name || '').includes(PFX), r)
  // 計算は今までどおり（加算後の支払単価をそのまま使い、加算額を二重に足さない）
  const resA = must(await admin.get(`/api/admin/rate-rules/resolve?project_id=${P}&staff_id=${A}&work_date=${jstToday}`), 'resolve A')
  const resB = must(await admin.get(`/api/admin/rate-rules/resolve?project_id=${P}&staff_id=${B}&work_date=${jstToday}`), 'resolve B')
  ok('9203 単価の計算は変わらない（その人は支払単価 14,000、ほかの人は案件の標準 12,000）', resA.price.pay_rate === 14000 && resA.amounts.pay_amount === 14000 && resB.price.pay_rate === 12000 && resA.price.bill_rate === 18000, [resA, resB])
  // シフトを登録すると、ルールの支払単価で金額が入る
  const day = addDays(jstToday, 3)
  const memo = `${PFX}-s1`
  must(await admin.post('/api/admin/shifts', { staff_id: A, project_id: P, work_date: day, start_time: '10:00', end_time: '19:00', memo, force: true }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${day}&to=${day}`), 'shifts').shifts.find(x => x.memo === memo)
  ok('9203 シフトの支払額は加算後の支払単価（日額 14,000）', s && Number(s.pay_amount) === 14000 && Number(s.unit_price) === 18000, s && [s.pay_amount, s.unit_price])

  const bad1 = await admin.post('/api/admin/rate-rules', { project_id: P, staff_id: B, pay_incentive: 1000, bill_rate: 20000 })
  ok('9203 支払単価のないインセンティブは 400', bad1.status === 400 && /インセンティブ/.test(bad1.data?.error || ''), bad1)
  const bad2 = await admin.post('/api/admin/rate-rules', { project_id: P, staff_id: B, pay_rate: 1000, pay_incentive: 3000 })
  ok('9203 支払単価より大きいインセンティブは 400', bad2.status === 400, bad2)
  const bad3 = await admin.post('/api/admin/rate-rules', { project_id: P, staff_id: B, pay_rate: 13000, pay_incentive: -5 })
  ok('9203 マイナスのインセンティブは 400', bad3.status === 400, bad3)

  // 終了日だけを付けても、インセンティブは残る
  must(await admin.put(`/api/admin/rate-rules/${ruleId}`, { valid_to: addDays(jstToday, 60) }), 'rule end')
  let r2 = must(await admin.get(`/api/admin/rate-rules?project_id=${P}`), 'rules').rules.find(x => x.rule_id === ruleId)
  ok('9203 終了日だけを変えてもインセンティブは残る', r2.pay_incentive === 2000 && r2.pay_rate === 14000 && r2.valid_to === addDays(jstToday, 60), r2)
  // 加算額を送らずに支払単価だけを変えたら（加算額のない画面からの編集）、加算額は外す
  must(await admin.put(`/api/admin/rate-rules/${ruleId}`, { pay_rate: 15000 }), 'rule pay only')
  r2 = must(await admin.get(`/api/admin/rate-rules?project_id=${P}`), 'rules').rules.find(x => x.rule_id === ruleId)
  ok('9203 加算額を送らずに支払単価を変えると、インセンティブの記録を外す', r2.pay_rate === 15000 && r2.pay_incentive == null, r2)
  must(await admin.put(`/api/admin/rate-rules/${ruleId}`, { pay_rate: 16000, pay_incentive: 3000 }), 'rule with incentive')
  r2 = must(await admin.get(`/api/admin/rate-rules?project_id=${P}`), 'rules').rules.find(x => x.rule_id === ruleId)
  ok('9203 編集でインセンティブを付け直せる', r2.pay_rate === 16000 && r2.pay_incentive === 3000, r2)

  // すべての案件に当てるスタッフ別のルール（案件を持たない）も、案件の単価の設定の一覧に出る
  const all = await admin.post('/api/admin/rate-rules', { project_id: null, staff_id: B, pay_unit_type: 'hourly', pay_rate: 1500, memo: '全案件' })
  const rules3 = must(await admin.get(`/api/admin/rate-rules?project_id=${P}`), 'rules').rules
  ok('9203 すべての案件のスタッフ別のルールを作れ、案件の一覧にも出る', all.status === 200 && rules3.some(x => x.rule_id === all.data.rule_id && x.project_id == null && x.staff_id === B), [all, rules3.length])
  const del = await admin.del(`/api/admin/rate-rules/${all.data?.rule_id}`)
  ok('9203 ルールを削除できる', del.status === 200, del)

  // 再適用の確認（dry_run）。再適用の計算は今までどおり
  const rp = await admin.post('/api/admin/shifts/reprice', { from: jstToday, to: addDays(jstToday, 10), project_id: P, dry_run: true })
  ok('9203 再適用の確認は今までどおり動き、変わるシフトの支払額は新しい支払単価（16,000）', rp.status === 200 && rp.data.count >= 1 && (rp.data.changes || []).some(x => x.pay_after === 16000), rp.data)
}

// ---------- 9204 支払の参考単価 ----------
{
  const r1 = await admin.put(`/api/admin/staff/${A}/reference-pay`, { unit: 'daily', amount: 12500 })
  const p1 = must(await admin.get(`/api/admin/staff/${A}`), 'staff').profile
  ok('9204 参考単価（日給 12,500）を保存し、スタッフ詳細で返す', r1.status === 200 && p1.reference_pay_unit === 'daily' && p1.reference_pay_amount === 12500, [r1, p1.reference_pay_unit, p1.reference_pay_amount])
  const list = must(await admin.get('/api/admin/staff-reference-pay'), 'ref list').staff
  ok('9204 単価の設定の目安に使う一覧に出る', list.some(x => x.staff_id === A && x.reference_pay_amount === 12500 && x.reference_pay_unit === 'daily'), list.slice(0, 3))
  const r2 = await admin.put(`/api/admin/staff/${A}/reference-pay`, { unit: 'monthly', amount: 300000 })
  ok('9204 単位は日給・時給だけ', r2.status === 400, r2)
  const r3 = await admin.put(`/api/admin/staff/${A}/reference-pay`, { unit: 'hourly', amount: -1 })
  ok('9204 マイナスの金額は 400', r3.status === 400, r3)
  const r4 = await admin.put(`/api/admin/staff/${A}/reference-pay`, { unit: 'hourly', amount: 1400 })
  const p4 = must(await admin.get(`/api/admin/staff/${A}`), 'staff').profile
  ok('9204 時給に変えられる', r4.status === 200 && p4.reference_pay_unit === 'hourly' && p4.reference_pay_amount === 1400, [p4.reference_pay_unit, p4.reference_pay_amount])
  // 参考単価は計算に使わない（スタッフ B の単価は案件の標準のまま）
  must(await admin.put(`/api/admin/staff/${B}/reference-pay`, { unit: 'daily', amount: 99999 }), 'ref B')
  const resB = must(await admin.get(`/api/admin/rate-rules/resolve?project_id=${P}&staff_id=${B}&work_date=${jstToday}`), 'resolve B')
  ok('9204 参考単価は計算に使わない（案件の標準の支払単価のまま）', resB.price.pay_rate === 12000, resB.price)
  const r5 = await admin.put(`/api/admin/staff/${B}/reference-pay`, { unit: 'daily', amount: null })
  const p5 = must(await admin.get(`/api/admin/staff/${B}`), 'staff').profile
  ok('9204 空欄で保存すると消す', r5.status === 200 && p5.reference_pay_amount == null && p5.reference_pay_unit == null, [p5.reference_pay_unit, p5.reference_pay_amount])
  const r6 = await admin.put('/api/admin/staff/99999999/reference-pay', { unit: 'daily', amount: 1 })
  ok('9204 ほかの会社・存在しないスタッフは 404', r6.status === 404, r6)
}

// ---------- 9204 他社連携の行には参考単価を出さない ----------
{
  const hq = client(await login('sample', 'hq'))
  const code = 'w9p' + Date.now().toString(36).slice(-5), pw = 'W9p-Passw0rd-' + code
  const cr = await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX}連携先`, admin_code: 'adminb', admin_password: pw, admin_name: 'B社 管理者' })
  ok('（前提）連携先の会社を作成', cr.status === 200, cr)
  const adminB = client(await login(code, 'adminb', pw))
  await admin.get('/api/admin/staff')
  must(await admin.put('/api/admin/staff/1/reference-pay', { unit: 'daily', amount: 13000 }), 'ref staff 1')
  const sc = await admin.get('/api/admin/roster/1/share-code')
  const terms = must(await adminB.get('/api/admin/roster/consent-terms'), 'terms')
  const lk = await adminB.post('/api/admin/roster/link', { code: sc.data?.global_staff_code, agreed: true, consent_version: terms.version })
  ok('（前提）連携先が st001 を連携', sc.status === 200 && lk.status === 200, [sc.status, lk])
  if (lk.status === 200) {
    const L = lk.data.staff_id
    const linked = must(await adminB.get(`/api/admin/staff/${L}`), 'linked staff').profile
    ok('9204 連携先のスタッフ詳細に参考単価を返さない', !('reference_pay_amount' in linked) && !('reference_pay_unit' in linked), Object.keys(linked).filter(k => k.startsWith('reference')))
    const put = await adminB.put(`/api/admin/staff/${L}/reference-pay`, { unit: 'daily', amount: 1000 })
    ok('9204 連携先は他社連携の行に参考単価を入れられない（403）', put.status === 403, put)
    const listB = must(await adminB.get('/api/admin/staff-reference-pay'), 'ref list B').staff
    ok('9204 連携先の目安の一覧に連携した人は出ない', !listB.some(x => x.staff_id === L), listB)
    const own = must(await admin.get('/api/admin/staff/1'), 'own staff 1').profile
    ok('9204 所属元は今までどおり参考単価を見られる', own.reference_pay_amount === 13000 && own.reference_pay_unit === 'daily', [own.reference_pay_unit, own.reference_pay_amount])
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:\n' + failed.map(f => '  - ' + f.name).join('\n')); process.exit(1) }
