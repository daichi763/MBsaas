// 振込データ・配置表・従業員名簿の出力と、クライアント単位の単価ルール（w5-payout-export: #298 #431 #470 #471）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w5-payout-export.mjs
//   振込データのテストは過去の期間（2019年3月）を使う（ほかのテストの日付と重ならないように）
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
    const buf = new Uint8Array(await r.arrayBuffer())
    const text = new TextDecoder().decode(buf)
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, buf, type: r.headers.get('content-type') || '', headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }

const PFX = 'W5P' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

// ---------- 準備: クライアント2つ・案件・開催場所 ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX} チェーン` }), 'client A')
must(await admin.post('/api/admin/clients', { client_name: `${PFX} 別会社` }), 'client B')
const opts = must(await admin.get('/api/admin/settlement/options'), 'options')
const CA = opts.clients.find(c => c.client_name === `${PFX} チェーン`).client_id
const CB = opts.clients.find(c => c.client_name === `${PFX} 別会社`).client_id
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件A1`, client_id: CA }), 'project A1')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件B1`, client_id: CB }), 'project B1')
const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
const PA = projects.find(p => p.project_name === `${PFX}-案件A1`).project_id
const PB = projects.find(p => p.project_name === `${PFX}-案件B1`).project_id
const SA = must(await admin.post('/api/admin/sites', { client_id: CA, site_name: `${PFX} 渋谷店` }), 'site A').site_id
const SB = must(await admin.post('/api/admin/sites', { client_id: CB, site_name: `${PFX} 別店` }), 'site B').site_id
for (const pid of [PA, PB]) must(await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000 }), 'pricing')

// ---------- #470 クライアント単位の単価ルール ----------
{
  const resolve = async (pid, q = '') => must(await admin.get(`/api/admin/rate-rules/resolve?project_id=${pid}&work_date=${today}${q}`), 'resolve').price
  const r1 = must(await admin.post('/api/admin/rate-rules', { client_id: CA, role_name: 'リーダー', bill_rate: 20000 }), 'client role rule')
  ok('#470 クライアントと役割だけのルールを登録できる', r1.ok && r1.client_id === CA, r1)
  let p = await resolve(PA, '&role_name=' + encodeURIComponent('リーダー'))
  ok('#470 クライアントのルールが、そのクライアントの案件に当たる', p.bill_rate === 20000 && /クライアント/.test(p.sources.bill), p)
  p = await resolve(PB, '&role_name=' + encodeURIComponent('リーダー'))
  ok('#470 別のクライアントの案件には当たらない', p.bill_rate === 10000, p)
  must(await admin.post('/api/admin/rate-rules', { client_id: CA, bill_rate: 12000 }), 'client rule')
  must(await admin.post('/api/admin/rate-rules', { project_id: PA, bill_rate: 15000 }), 'project rule')
  p = await resolve(PA)
  ok('#470 同じ条件なら案件のルールがクライアントのルールより優先', p.bill_rate === 15000, p)
  p = await resolve(PA, '&role_name=' + encodeURIComponent('リーダー'))
  ok('#470 役割を指定したクライアントのルールは、案件だけのルールより具体的', p.bill_rate === 20000, p)
  // 開催場所だけのルールは、その開催場所のクライアントの範囲になる
  const r2 = must(await admin.post('/api/admin/rate-rules', { site_id: SA, pay_transport_type: 'fixed', pay_transport_amount: 1000 }), 'site rule')
  ok('#470 開催場所だけのルールは、開催場所のクライアントの範囲で登録される', r2.client_id === CA, r2)
  p = await resolve(PA, `&site_id=${SA}`)
  ok('#470 開催場所のルールが当たる', p.pay_transport_type === 'fixed' && p.pay_transport_amount === 1000, p)
  const bad1 = await admin.post('/api/admin/rate-rules', { client_id: CA, staff_id: 1, bill_rate: 1 })
  ok('#470 クライアント単位のルールにスタッフは付けられない', bad1.status === 400, bad1.data)
  const bad2 = await admin.post('/api/admin/rate-rules', { client_id: CA, site_id: SB, bill_rate: 1 })
  ok('#470 別のクライアントの開催場所は選べない', bad2.status === 400, bad2.data)
  const bad3 = await admin.post('/api/admin/rate-rules', { bill_rate: 1 })
  ok('#470 範囲のないルールは登録できない', bad3.status === 400, bad3.data)
  const bad4 = await admin.post('/api/admin/rate-rules', { client_id: 999999, bill_rate: 1 })
  ok('#470 他社・存在しないクライアントは指定できない', bad4.status === 400, bad4.data)
  const list = must(await admin.get(`/api/admin/rate-rules?client_id=${CA}`), 'list').rules
  ok('#470 クライアントのルールの一覧（案件のルールは含まない）', list.length === 3 && list.every(r => r.client_id === CA && !r.project_id) && list[0].client_name === `${PFX} チェーン`, list)
  // 編集で案件を指定すると、クライアントは外れる（案件で決まる）
  must(await admin.put(`/api/admin/rate-rules/${r1.rule_id}`, { bill_rate: 21000 }), 'edit')
  p = await resolve(PA, '&role_name=' + encodeURIComponent('リーダー'))
  ok('#470 クライアントのルールを編集できる', p.bill_rate === 21000, p)
  // 再適用はクライアントの全案件が対象
  const rp = must(await admin.post('/api/admin/shifts/reprice', { from: today, to: addDays(today, 30), client_id: CA, dry_run: true }), 'reprice dry')
  ok('#470 クライアント単位で再適用の確認ができる', typeof rp.count === 'number', rp)
}

// ---------- #298 配置表（金額なし・未充足を含む） ----------
{
  const D = addDays(today, 20)
  must(await admin.post('/api/admin/shift-slots', { project_id: PA, site_id: SA, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 3 }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${D}&to=${D}&project_ids=${PA}`), 'board')
  const role = b.slots.find(s => s.project_id === PA).roles[0].slot_role_id
  const sid = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 配置`, phone: phone(9), affiliation_type: 'daily_worker' }), 'staff').staff_id
  must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [sid], force: true }), 'assign')
  const csv = await admin.get(`/api/admin/shift-board/export?from=${D}&to=${D}&project_ids=${PA}`)
  const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n')
  ok('#298 配置表の CSV を出せる（UTF-8 BOM・CSV）', csv.status === 200 && /text\/csv/.test(csv.type) && csv.buf[0] === 0xEF && csv.buf[1] === 0xBB && csv.buf[2] === 0xBF, csv.status)
  ok('#298 配置表に金額の列がない', !/請求|支払|単価|金額/.test(lines[0]) && lines[0].includes('未充足') === false && lines[0].includes('不足'), lines[0])
  ok('#298 割り当てたスタッフの行がある', lines.some(l => l.includes(`${PFX} 配置`) && l.includes('確定') && l.includes('渋谷店')), lines)
  ok('#298 未充足の枠（あと2名）の行がある', lines.some(l => l.includes('未充足 あと2名')), lines)
  const pr = await admin.get(`/api/admin/shift-board/export?from=${D}&to=${D}&project_ids=${PA}&format=print`)
  ok('#298 印刷用の配置表（HTML）を出せる', pr.status === 200 && /text\/html/.test(pr.type) && pr.text.includes(`${PFX}-案件A1`) && pr.text.includes('未充足 あと2名') && !/¥/.test(pr.text), pr.status)
  const other = await admin.get(`/api/admin/shift-board/export?from=${D}&to=${D}&project_ids=${PB}`)
  ok('#298 絞り込みの外の案件は載らない', !other.text.includes(`${PFX} 配置`), other.text.slice(0, 200))
}

// ---------- #431 従業員名簿の CSV ----------
{
  const r = await admin.get('/api/admin/employees/export')
  const head = r.text.replace(/^﻿/, '').split('\r\n')[0]
  ok('#431 従業員名簿の CSV を出せる', r.status === 200 && /text\/csv/.test(r.type) && head.includes('社員番号') && head.includes('入社日') && head.includes('雇用保険番号'), head)
  ok('#431 既定では口座・給与の列を含めない', !head.includes('口座番号') && !head.includes('基本給'), head)
  const pay = await admin.get('/api/admin/employees/export?include_pay=1')
  ok('#431 会社管理者は口座・給与を含めて出せる', pay.status === 200 && pay.text.includes('口座番号') && pay.text.includes('基本給'), pay.status)
  const st = await admin.get('/api/admin/employees/export?status=retired')
  ok('#431 在籍状況で絞って出せる', st.status === 200, st.status)
  const bad = await admin.get('/api/admin/employees/export?status=xxx')
  ok('#431 在籍状況の指定が正しくなければ 400', bad.status === 400, bad.status)
  const m = await mgr.get('/api/admin/employees/export')
  ok('#431 現場管理者は従業員名簿を出せない（403）', m.status === 403, m.status)
  const logs = must(await admin.get('/api/admin/settlement/closings'), 'closings').exports
  ok('#431 出力の記録が残る', logs.some(x => x.kind === 'employees'), logs.slice(0, 3))
}

// ---------- #471 振込データ ----------
{
  const FROM = '2019-03-01', TO = '2019-03-31'
  const newStaff = async (n, type) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 振込${n}`, phone: phone(n), affiliation_type: type }), 'staff-quick').staff_id
  const A = await newStaff(1, 'daily_worker'), B = await newStaff(2, 'freelance'), C = await newStaff(3, 'daily_worker')
  const newShift = async (staff_id, work_date) => must(await admin.post('/api/admin/shifts', { staff_id, project_id: PB, work_date, start_time: '10:00', end_time: '19:00', unit_price: 10000 }), 'shift').shift_id
  const ids = [await newShift(A, '2019-03-05'), await newShift(A, '2019-03-06'), await newShift(B, '2019-03-05'), await newShift(C, '2019-03-07')]
  const unconfirmed = await newShift(B, '2019-03-08')
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: ids, force: true }), 'confirm')
  const rows = must(await admin.get(`/api/admin/settlement?from=${FROM}&to=${TO}&staff_id=${A}`), 'settle').rows
  const payA = rows.reduce((n, r) => n + Number(r.pay_total || 0), 0)

  const m = await mgr.get(`/api/admin/settlement/payout?from=${FROM}&to=${TO}`)
  ok('#471 現場管理者は振込データを扱えない（403）', m.status === 403, m.status)
  const mAcc = await mgr.put(`/api/admin/settlement/payout/accounts/${A}`, { bank_code: '0001', branch_code: '001', account_type: '1', account_number: '1234567', holder_kana: 'ﾃｽﾄ' })
  ok('#471 現場管理者は口座を登録できない（403）', mAcc.status === 403, mAcc.status)

  // 口座の登録と検証
  const badKana = await admin.put(`/api/admin/settlement/payout/accounts/${A}`, { bank_code: '0001', branch_code: '001', account_type: '1', account_number: '1234567', holder_kana: '山田太郎' })
  ok('#471 漢字の名義は受け付けない', badKana.status === 400, badKana.data)
  const badCode = await admin.put(`/api/admin/settlement/payout/accounts/${A}`, { bank_code: '01', branch_code: '001', account_type: '1', account_number: '1234567', holder_kana: 'ヤマダ' })
  ok('#471 金融機関コードは4桁', badCode.status === 400, badCode.data)
  const sv = must(await admin.put(`/api/admin/settlement/payout/accounts/${A}`, { bank_code: '0005', bank_name: 'ミツビシ', branch_code: '123', branch_name: 'シブヤ', account_type: '普通', account_number: '765', holder_kana: 'やまだ たろう' }), 'account A')
  ok('#471 日雇いのスタッフの口座を登録でき、名義を全銀のカナにする', sv.holder_zengin === 'ﾔﾏﾀﾞ ﾀﾛｳ', sv)
  must(await admin.put(`/api/admin/settlement/payout/accounts/${B}`, { bank_code: '0009', branch_code: '456', account_type: '2', account_number: '1112223', holder_kana: 'スズキ ハナコ' }), 'account B')
  const other = await admin.put('/api/admin/settlement/payout/accounts/999999', { bank_code: '0009', branch_code: '456', account_type: '1', account_number: '1', holder_kana: 'ア' })
  ok('#471 他社・存在しないスタッフの口座は登録できない', other.status === 404, other.status)

  // 振込元の設定を空にしてから確かめる（テストを繰り返しても同じ結果になるように）
  must(await admin.put('/api/admin/settlement/payout/settings', {}), 'clear settings')
  const pv = must(await admin.get(`/api/admin/settlement/payout?from=${FROM}&to=${TO}`), 'payout')
  const ia = pv.items.find(x => x.staff_id === A), ib = pv.items.find(x => x.staff_id === B), ic = pv.items.find(x => x.staff_id === C)
  ok('#471 確定済みのシフトの支払合計を振込金額にする', ia && ia.amount === payA && ia.amount > 0 && ia.exportable, { ia, payA })
  ok('#471 口座番号は末尾だけを返す', ia && ia.account.account_number_masked === '****765', ia && ia.account)
  ok('#471 未確定のシフトは含めず、件数を知らせる', ib && ib.unconfirmed === 1 && ib.notes.some(n => n.includes('未確定')), ib)
  ok('#471 口座が未登録の人は出力しない（警告）', ic && !ic.exportable && ic.problems.includes('口座が未登録'), ic)
  ok('#471 振込元が未設定なら設定の不足を返す', pv.settings_problems.length > 0, pv.settings_problems)
  const noSettings = await admin.get(`/api/admin/settlement/payout/export?from=${FROM}&to=${TO}&format=zengin&transfer_date=2019-04-10`)
  ok('#471 振込元が未設定なら全銀形式は出せない', noSettings.status === 400, noSettings.data)
  const badSt = await admin.put('/api/admin/settlement/payout/settings', { requester_code: '123', requester_kana: 'カ）テスト' })
  ok('#471 委託者コードは10桁', badSt.status === 400, badSt.data)
  must(await admin.put('/api/admin/settlement/payout/settings', { requester_code: '1234567890', requester_kana: 'カ）テスト', bank_code: '0001', bank_name: 'ミズホ', branch_code: '001', branch_name: 'トウキヨウ', account_type: '1', account_number: '7654321' }), 'settings')

  const z = await admin.get(`/api/admin/settlement/payout/export?from=${FROM}&to=${TO}&format=zengin&transfer_date=2019-04-10`)
  const recs = Buffer.from(z.buf).toString('latin1').split('\r\n').filter(Boolean)
  ok('#471 全銀形式を出せる（1レコード120バイト・ヘッダー/データ/トレーラー/エンド）', z.status === 200 && recs.every(r => r.length === 120) && recs[0][0] === '1' && recs[recs.length - 1][0] === '9' && recs[recs.length - 2][0] === '8', recs.map(r => r.length))
  ok('#471 ヘッダーに種別21・委託者コード・取組日', recs[0].slice(1, 3) === '21' && recs[0].slice(4, 14) === '1234567890' && recs[0].slice(54, 58) === '0410', recs[0].slice(0, 60))
  const dataRecs = recs.filter(r => r[0] === '2')
  ok('#471 データは口座のある人だけ（未登録の人は出さない）', z.headers.get('x-payout-skipped') === String(pv.skipped) && dataRecs.length === pv.exportable, { n: dataRecs.length, pv: pv.exportable })
  const recA = dataRecs.find(r => r.slice(1, 5) === '0005')
  ok('#471 データに銀行・支店・口座番号（7桁）・金額', recA && recA.slice(20, 23) === '123' && recA.slice(43, 50) === '0000765' && Number(recA.slice(80, 90)) === payA, recA)
  const trailer = recs[recs.length - 2]
  ok('#471 トレーラーの件数と合計', Number(trailer.slice(1, 7)) === dataRecs.length && Number(trailer.slice(7, 19)) === pv.total, trailer.slice(0, 20))
  // 名義の半角カナは Shift_JIS の1バイト（0xA1〜0xDF）
  const ya = recA ? Buffer.from(recA, 'latin1')[50] : 0
  ok('#471 名義は半角カナの1バイト（ﾔ = 0xD4）', ya === 0xD4, ya)
  const csv = await admin.get(`/api/admin/settlement/payout/export?from=${FROM}&to=${TO}&format=csv`)
  ok('#471 振込一覧の CSV（口座番号は先頭の0を残す）', csv.status === 200 && csv.text.includes('"=""0000765"""') && csv.text.includes('ﾔﾏﾀﾞ ﾀﾛｳ'), csv.text.slice(0, 300))
  const logs = must(await admin.get('/api/admin/settlement/closings'), 'closings').exports
  ok('#471 出力の記録が残る', logs.some(x => x.kind === 'payout_zengin') && logs.some(x => x.kind === 'payout_csv'), logs.slice(0, 3))
  void unconfirmed
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
