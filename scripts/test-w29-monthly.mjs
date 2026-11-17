// 請求・支払の単位に「月額」を足す（利用者の要望 11/17。Sprint 29 #9984。w29-monthly）の統合テスト
//   1. 1日分 = 月額 ÷ その月の働いた日数（確定・代打）。1円未満は切り捨て、余りは最後の稼働日（300,000円・7日 → 42,857 × 6 + 42,858）
//   2. シフトを足す・消す・欠勤にする・別の月へ動かすと、同じ月のほかのシフトの額を計算し直す（migrations/0114 のトリガー）
//   3. 請求と支払で別々に月額が効く。単位を選ぶ所（案件の標準単価・単価ルール・枠の役割・手動変更・一括登録）で月額を選べる
//   4. 確定済みのシフトの額は変えず、合計が合わなければ精算の確認事項に出す。確定を取り消すと計算し直す
//   5. 精算の一覧・CSV・明細書・スタッフアプリの支払に「月額」「1/◯日」を出す。欠勤のキャンセル料の初期値は1日分
//   6. 0114 の移し替え: 本番と同じ形（案件全体・期限なし・日額 0 の案件）の月額（固定）と、スタッフ別・移せない形のデータで、
//      移す前と後の案件の月ごとの請求の合計が変わらない
//   7. 時給・日額のシフトの金額は今までどおり。月額（固定）の新しいルールは作れない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --port 9021 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w29-monthly.mjs
//   本番には接続しない（wrangler d1 execute は --local のみ）。日付は過去の期間（2016年）を使う
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED'].includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500)); return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 800) : ''}`) }

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w29m-'))
let sqlSeq = 0
async function sqlAll(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); break } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '')
      if (i >= 3 || !/internal error|SQLITE_BUSY|database is locked|bad_alloc|write EOF/i.test(msg)) throw new Error(msg.slice(0, 600))
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  await waitServer()
  return JSON.parse(out.slice(out.indexOf('[')))
}
// d1 execute の後は、サーバーが DB を開き直すまで少し待つ（切れた接続を避ける）
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await rawFetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const sql = async (command) => (await sqlAll(command)).at(-1).results

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

const PFX = 'W29M' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// ---------- 画面のコード ----------
{
  const sb = await staticJs('shift-board.js'), st = await staticJs('settlement.js'), a = await staticJs('admin.js'), sa = await staticJs('staff-attendance.js')
  ok('シフトボード・単価の設定の単位は「日額・時給・月額」の順', sb.includes("const UNIT_LABEL = { daily: '日額', hourly: '時給', monthly: '月額' }"))
  ok('単価ルールの単位の選択肢も UNIT_LABEL（月額を含む）から作る', sb.includes('const unitOpt = (v) => Object.entries(UNIT_LABEL)'))
  ok('シフトの金額の欄: 月額は数量を「1/◯日」で出し、入力させない', sb.includes('sp-monthly-note') && /placeholder="1\/\$\{monthDays\(a\.bill_qty\)\}日" disabled/.test(sb))
  ok('案件の登録の選択肢は「日額・時給・月額」（月額（固定）ではない）', a.includes('<option value="daily">日額</option><option value="hourly">時給</option><option value="monthly">月額</option></select>'))
  ok('シフト登録の単価・操作履歴の単位にも月額がある', a.includes("const ADD_SHIFT_UNIT = { daily: '日額', hourly: '時給', monthly: '月額' }") && a.includes("bill_unit_type: { daily: '日額', hourly: '時給', monthly: '月額' }"))
  ok('精算の明細は「月額 ◯円 ÷ ◯日」、金額の変更の単位に月額がある', st.includes('const rateQtyText = (unit, rate, qty, days)') && st.includes("const UNIT_LABEL = { daily: '日額', hourly: '時給', monthly: '月額' }"))
  ok('精算の単価の設定: 月額（固定）は追加できない（変更・削除だけ）', !st.includes("delegate('monthlyAdd'") && st.includes("delegate('monthlyEdit'") && !st.includes("axios.post('/api/admin/settlement/monthly-rules'"))
  ok('スタッフアプリの支払: 月額は「1日分 ◯円（月額 ◯円 ÷ ◯日）」', sa.includes('pay-monthly') && sa.includes('1日分'))
  ok('月額の操作はイベント属性に値を埋め込まない', !/onclick="[^"]*monthly/i.test(st + sb + a))
}

// ---------- 準備 ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX} クライアント` }), 'client')
const CL = must(await admin.get('/api/admin/settlement/options'), 'options').clients.find(c => c.client_name === `${PFX} クライアント`).client_id
const newProject = async (name, unit, price) => must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${name}`, client_id: CL, unit_price_type: unit, unit_price: price }), 'project ' + name).project_id
const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const newShift = async (project_id, staff_id, work_date, extra = {}) => must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '19:00', ...extra }), `shift ${work_date}`).shift_id
const shiftRows = async (ids) => (await sql(`SELECT shift_id, work_date, status, settle_status, bill_unit_type, bill_rate, bill_qty, unit_price, pay_unit_type, pay_rate, pay_qty, pay_amount FROM shifts WHERE shift_id IN (${ids.join(',')}) ORDER BY work_date, shift_id`))
const amounts = (rows, k = 'unit_price') => rows.map(r => r[k] == null ? null : Number(r[k]))
const total = (a) => a.reduce((n, x) => n + Number(x || 0), 0)
const settle = async (q) => must(await admin.get(`/api/admin/settlement?${q}`), 'settlement ' + q)

const PM = await newProject('月額', 'monthly', 300000)
{
  const p = must(await admin.get(`/api/admin/projects/${PM}`), 'detail').project
  ok('案件の登録で「月額」を選ぶと、標準の請求単価が月額になる（月額（固定）のルールは作らない）', p.unit_price_type === 'monthly' && Number(p.unit_price) === 300000 && p.monthly_amount == null, [p.unit_price_type, p.unit_price, p.monthly_amount])
  const r = must(await admin.get(`/api/admin/settlement/monthly-rules?project_id=${PM}`), 'rules')
  ok('月額（固定）のルールはできていない', r.rules.length === 0, r.rules)
  const bad = await admin.post('/api/admin/projects', { project_name: `${PFX}-月額0`, client_id: CL, unit_price_type: 'monthly', unit_price: 0 })
  ok('月額は1円以上', bad.status === 400 && /月額/.test(bad.data?.error || ''), bad.status)
  const post = await admin.post('/api/admin/settlement/monthly-rules', { project_id: PM, amount: 1000 })
  ok('月額（固定）の新しいルールは作れない（400・置き換えの案内）', post.status === 400 && post.data?.replaced === true && /月額/.test(post.data?.error || ''), post)
}

// ---------- 1. 300,000円・7日 ----------
const A = await newStaff(1)
const marchDates = ['2016-03-01', '2016-03-02', '2016-03-03', '2016-03-04', '2016-03-07', '2016-03-08', '2016-03-09']
const m = []
for (const d of marchDates) m.push(await newShift(PM, A, d))
{
  const rows = await shiftRows(m)
  ok('月額 300,000円・7日 → 42,857 × 6 + 42,858（余りは最後の稼働日）', JSON.stringify(amounts(rows)) === JSON.stringify([42857, 42857, 42857, 42857, 42857, 42857, 42858]), amounts(rows))
  ok('月額のシフトの単位は monthly、単価は月額、数量は 1/7', rows.every(r => r.bill_unit_type === 'monthly' && Number(r.bill_rate) === 300000 && Math.abs(Number(r.bill_qty) - 1 / 7) < 1e-9), rows[0])
  const s = await settle(`from=2016-03-01&to=2016-03-31&project_id=${PM}`)
  const mine = s.rows.filter(r => m.includes(r.shift_id))
  ok('精算: 単位「monthly」・単価 300,000・働いた日数 7 を返し、合計は 300,000', mine.length === 7 && mine.every(r => r.bill_unit_type === 'monthly' && r.bill_rate === 300000 && r.bill_month_days === 7) && total(mine.map(r => r.bill_base)) === 300000, mine.map(r => [r.bill_base, r.bill_month_days]))
  ok('精算: 合計が合っていれば「月額の合計が月額と合わない」は出ない', mine.every(r => !r.issues.some(i => i.startsWith('月額の合計'))), mine[0]?.issues)
  ok('精算: 月額のシフトに「数量・金額が今の計算と違う」「請求単価未設定」を出さない', mine.every(r => !r.issues.includes('数量・金額が今の計算と違う') && !r.issues.includes('請求単価未設定')), mine[0]?.issues)
  const csv = await admin.get(`/api/admin/settlement/export?kind=detail&from=2016-03-01&to=2016-03-31&project_id=${PM}`)
  const lines = csv.text.replace(/^﻿/, '').split('\r\n')
  const head = lines[0].split(',')
  const iu = head.indexOf('請求単位'), iq = head.indexOf('請求数量'), ir = head.indexOf('請求単価')
  const row = lines.find(l => l.startsWith(String(m[0]) + ','))?.split(',') || []
  ok('明細の CSV: 単位「月額」・単価 300000・数量「1/7」（列の並びは今までどおり）', row[iu] === '月額' && row[ir] === '300000' && row[iq] === '1/7' && head.slice(20, 23).join(',') === '請求単位,請求単価,請求数量', [row[iu], row[ir], row[iq], head.slice(20, 23)])
}

// ---------- 2. 足す・消す・欠勤・別の月へ ----------
{
  const add = await newShift(PM, A, '2016-03-10')
  let rows = await shiftRows([...m, add])
  ok('シフトを1件足すと、同じ月のほかのシフトも 300,000 ÷ 8 = 37,500 になる', amounts(rows).every(v => v === 37500) && rows.length === 8, amounts(rows))
  must(await admin.del(`/api/admin/shifts/${add}`), 'delete')
  rows = await shiftRows(m)
  ok('シフトを消すと、残りの7件が 42,857 × 6 + 42,858 に戻る', JSON.stringify(amounts(rows)) === JSON.stringify([42857, 42857, 42857, 42857, 42857, 42857, 42858]), amounts(rows))
  must(await admin.put(`/api/admin/shifts/${m[6]}`, { status: 'absent', notify: false }), 'absent')
  rows = await shiftRows(m)
  ok('欠勤にすると日数に数えず、ほかの6件が 50,000、欠勤のシフトは 0（数量 0）', JSON.stringify(amounts(rows)) === JSON.stringify([50000, 50000, 50000, 50000, 50000, 50000, 0]) && Number(rows[6].bill_qty) === 0, amounts(rows))
  const cx = must(await admin.get(`/api/admin/settlement/cancellations/${m[6]}`), 'cancellation')
  ok('欠勤のキャンセル料の初期値の元は、その日も働いたとしたときの1日分（300,000 ÷ 7 の切り捨て）', cx.shift.planned_bill === 42857, cx.shift)
  // 別の月（4月）の枠へ動かす
  const slot = must(await admin.post('/api/admin/shift-slots', { project_id: PM, dates: ['2016-04-05'], start_time: '10:00', end_time: '19:00',
    roles: [{ role_name: '販売', headcount: 2, bill_unit_type: 'monthly', bill_rate: 300000 }] }), 'slot').slot_ids[0]
  const role = must(await admin.get(`/api/admin/shift-slots/${slot}`), 'slot detail').roles[0]
  ok('募集枠の役割の単価に月額を選べる', role.bill_unit_type === 'monthly' && Number(role.bill_rate) === 300000, role)
  must(await admin.post(`/api/admin/shifts/${m[5]}/move`, { slot_role_id: role.slot_role_id, force: true, notify: false }), 'move')
  rows = await shiftRows(m)
  const march = rows.filter(r => r.work_date.startsWith('2016-03') && r.status !== 'absent'), april = rows.filter(r => r.work_date.startsWith('2016-04'))
  ok('別の月へ動かすと、元の月の5件は 60,000、動かした先の月（1件）は 300,000', amounts(march).every(v => v === 60000) && march.length === 5 && april.length === 1 && Number(april[0].unit_price) === 300000, [amounts(march), amounts(april)])
}

// ---------- 4. 確定済みは変えず、確認事項を出す ----------
{
  const march5 = m.slice(0, 5)
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: march5, force: true }), 'confirm')
  const late = await newShift(PM, A, '2016-03-14')
  const rows = await shiftRows([...march5, late])
  ok('確定済みのシフトの額は変えない（60,000 のまま）。足したシフトは 300,000 ÷ 6 = 50,000', JSON.stringify(amounts(rows)) === JSON.stringify([60000, 60000, 60000, 60000, 60000, 50000]), amounts(rows))
  const s = await settle(`from=2016-03-01&to=2016-03-31&project_id=${PM}`)
  const r = s.rows.find(x => x.shift_id === late)
  const issue = (r?.issues || []).find(i => i.startsWith('月額の合計が月額と合わない'))
  ok('精算の確認事項「月額の合計が月額と合わない（請求 +50,000円の差）」を出す', issue === '月額の合計が月額と合わない（請求 +50,000円の差）', r?.issues)
  const stmt = await admin.get(`/api/admin/settlement/statement?kind=billing&client_id=${CL}&from=2016-03-01&to=2016-03-31`)
  ok('請求明細書: 月額のシフトは単価「¥300,000/月」・数量「1/5日」（確定したときの日数）', stmt.status === 200 && stmt.text.includes('¥300,000/月') && stmt.text.includes('1/5日') && stmt.text.includes('>月額<'), stmt.text.slice(0, 200))
  must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: march5 }), 'unconfirm')
  const after = await shiftRows([...march5, late])
  ok('確定を取り消すと、6件とも 50,000 に計算し直す', amounts(after).every(v => v === 50000), amounts(after))
}

// ---------- 3. 請求と支払で別々に月額 ----------
const PB = await newProject('支払だけ月額', 'daily', 16000)
const B = await newStaff(2)
{
  must(await admin.put(`/api/admin/projects/${PB}/pricing`, { unit_price_type: 'daily', unit_price: 16000, pay_unit_type: 'monthly', pay_rate: 200000 }), 'pricing')
  const p = must(await admin.get(`/api/admin/projects/${PB}`), 'detail').project
  ok('案件の標準単価: 支払の単位に月額を選べる（請求は日額のまま）', p.pay_unit_type === 'monthly' && Number(p.pay_rate) === 200000 && p.unit_price_type === 'daily', [p.unit_price_type, p.pay_unit_type, p.pay_rate])
  const ids = []
  for (const d of ['2016-03-14', '2016-03-15', '2016-03-16']) ids.push(await newShift(PB, B, d))
  const req = await newShift(PB, B, '2016-03-17', { status: 'requested' })
  const rows = await shiftRows([...ids, req])
  ok('支払だけ月額: 支払は 200,000 ÷ 3 = 66,666・66,666・66,668、請求は日額 16,000 のまま', JSON.stringify(amounts(rows.slice(0, 3), 'pay_amount')) === JSON.stringify([66666, 66666, 66668]) && rows.slice(0, 3).every(r => Number(r.unit_price) === 16000 && r.bill_unit_type === 'daily'), rows)
  ok('希望（仮）のシフトは日数に数えず、支払 0', Number(rows[3].pay_amount) === 0 && Number(rows[3].pay_qty) === 0 && rows[3].status === 'requested', rows[3])
  // スタッフアプリの支払（st001 = staff_id 1）
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: true }), 'pay visible')
  const own = []
  for (const d of ['2016-03-21', '2016-03-22', '2016-03-23', '2016-03-24']) own.push(await newShift(PB, 1, d))
  const staff = client(await login('sample', 'st001'))
  const pay = must(await staff.get('/api/staff/pay?month=2016-03'), 'staff pay')
  const sp = pay.shifts.filter(s => own.includes(s.shift_id))
  ok('スタッフアプリの支払: 月額の単位・月額・日数（4日）・1日分（50,000）を返す', sp.length === 4 && sp.every(s => s.pay && s.pay.unit_type === 'monthly' && s.pay.rate === 200000 && s.pay.month_days === 4 && s.pay.base === 50000), sp.map(s => s.pay))
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: false }), 'pay hidden')
}

// ---------- 3. 単価ルール・手動変更・一括登録で月額 ----------
{
  const PD = await newProject('日額', 'daily', 16000)
  const G = await newStaff(3), H = await newStaff(4), F = await newStaff(5)
  must(await admin.post('/api/admin/rate-rules', { project_id: PD, staff_id: G, bill_unit_type: 'monthly', bill_rate: 90000 }), 'rate rule')
  const g = [await newShift(PD, G, '2016-05-02'), await newShift(PD, G, '2016-05-03')]
  ok('単価ルール（スタッフ別）で月額を選べる: 90,000 ÷ 2 = 45,000', amounts(await shiftRows(g)).every(v => v === 45000), amounts(await shiftRows(g)))
  const hh = [await newShift(PD, H, '2016-05-02'), await newShift(PD, H, '2016-05-03')]
  for (const id of hh) must(await admin.put(`/api/admin/shifts/${id}/price`, { bill_unit_type: 'monthly', bill_rate: 120000, bill_qty: 3 }), 'manual price')
  const hr = await shiftRows(hh)
  ok('シフトの単価の手動変更で月額を選べる: 120,000 ÷ 2 = 60,000（数量の入力は使わない）', amounts(hr).every(v => v === 60000) && hr.every(r => Math.abs(Number(r.bill_qty) - 0.5) < 1e-9), hr)
  const bulk = must(await admin.post('/api/admin/shifts/bulk', { project_id: PM, staff_ids: [F], date_from: '2016-06-01', date_to: '2016-06-30', weekdays: [1, 3, 5], start_time: '10:00', end_time: '19:00', notify: false }), 'bulk')
  const fr = await sql(`SELECT unit_price, bill_qty FROM shifts WHERE staff_id = ${F} AND project_id = ${PM} ORDER BY work_date, start_time, shift_id`)
  const n = fr.length, each = Math.floor(300000 / n)
  ok(`一括登録（${n}日）でも、合計が月額ぴったり（${each} × ${n - 1} + 余り）`, bulk.created === n && total(amounts(fr)) === 300000 && amounts(fr).slice(0, -1).every(v => v === each) && amounts(fr).at(-1) === 300000 - each * (n - 1), [bulk.created, amounts(fr)])
}

// ---------- 7. 時給・日額は今までどおり ----------
{
  const PH = await newProject('時給', 'hourly', 1500), PD2 = await newProject('日額2', 'daily', 16000)
  const I = await newStaff(6)
  const h1 = await newShift(PH, I, '2016-07-04'), d1 = await newShift(PD2, I, '2016-07-05')
  const [h, d] = await shiftRows([h1, d1])
  ok('時給のシフトは 1,500 × 時間（今までどおり）', h.bill_unit_type === 'hourly' && Number(h.bill_rate) === 1500 && Number(h.unit_price) === Math.round(1500 * Number(h.bill_qty)) && Number(h.bill_qty) > 0, h)
  ok('日額のシフトは 16,000・数量 1（今までどおり）', d.bill_unit_type === 'daily' && Number(d.unit_price) === 16000 && Number(d.bill_qty) === 1, d)
}

// ---------- 6. 0114 の移し替え ----------
{
  const PL = await newProject('固定の案件全体', 'daily', 0), PS = await newProject('固定のスタッフ別', 'daily', 0), PX = await newProject('固定の2人', 'daily', 0)
  const C = await newStaff(11), D = await newStaff(12), E = await newStaff(13)
  // 本番と同じ形: 日額 0 の案件の、案件全体・期限なしの月額（固定）。1人のスタッフが5月に3件・6月に2件
  const pl = []
  for (const d of ['2016-08-01', '2016-08-02', '2016-08-03', '2016-09-01', '2016-09-02']) pl.push(await newShift(PL, C, d))
  // スタッフ別（D・8月から）: 8月は確定済み（移せない月）、9月は移せる
  const ps = []
  for (const d of ['2016-08-04', '2016-08-05', '2016-09-05', '2016-09-06', '2016-09-07']) ps.push(await newShift(PS, D, d))
  const pse = await newShift(PS, E, '2016-08-04')
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [ps[0], ps[1], pse], force: true }), 'confirm PS Aug')
  // 案件全体で2人（移せない）
  const px = [await newShift(PX, C, '2016-08-08'), await newShift(PX, E, '2016-08-09')]
  await sql(`INSERT INTO monthly_bill_rules (company_id, project_id, staff_id, amount, created_by, created_at) VALUES (1, ${PL}, NULL, 250000, 1, '2016-07-01 10:00:00');
    INSERT INTO monthly_bill_rules (company_id, project_id, staff_id, amount, valid_from, memo, created_by, created_at) VALUES (1, ${PS}, ${D}, 80000, '2016-08', '管理費', 1, '2016-07-01 10:00:00');
    INSERT INTO monthly_bill_rules (company_id, project_id, staff_id, amount, created_by, created_at) VALUES (1, ${PX}, NULL, 100000, 1, '2016-07-01 10:00:00');`)
  const months = [['2016-08-01', '2016-08-31'], ['2016-09-01', '2016-09-30']]
  const billOf = async () => {
    const out = {}
    for (const pid of [PL, PS, PX]) for (const [f, t] of months) out[`${pid}:${f.slice(0, 7)}`] = (await settle(`from=${f}&to=${t}&project_id=${pid}`)).totals.bill
    return out
  }
  const before = await billOf()
  ok('移す前: 月額（固定）の行で請求している（案件全体 250,000 × 2か月・スタッフ別 80,000 × 2か月・2人の案件 100,000）',
    before[`${PL}:2016-08`] === 250000 && before[`${PL}:2016-09`] === 250000 && before[`${PS}:2016-08`] === 80000 && before[`${PS}:2016-09`] === 80000 && before[`${PX}:2016-08`] === 100000, before)
  // 0114 の移し替えの部分（印の間）を、もう一度流す
  const mig = readFileSync(fileURLToPath(new URL('../migrations/0114_monthly_unit.sql', import.meta.url)), 'utf8')
  const part = mig.slice(mig.indexOf('-- [0114-data-begin]'), mig.indexOf('-- [0114-data-end]'))
  ok('0114 に移し替えの部分の印がある', part.length > 1000)
  await sqlAll(part)
  const after = await billOf()
  ok('移す前と後で、案件の月ごとの請求の合計が変わらない', JSON.stringify(after) === JSON.stringify(before), { before, after })
  const rules = Object.fromEntries((await sql(`SELECT project_id, migrated_at, migrated_from FROM monthly_bill_rules WHERE project_id IN (${PL}, ${PS}, ${PX})`)).map(r => [r.project_id, r]))
  ok('案件全体・期限なし・1人のルールは、すべての月を移す（migrated_from = 0000-00）', rules[PL].migrated_at && rules[PL].migrated_from === '0000-00', rules[PL])
  ok('確定済みの月のあるスタッフ別のルールは、その次の月から移す（migrated_from = 2016-09）', rules[PS].migrated_at && rules[PS].migrated_from === '2016-09', rules[PS])
  ok('2人のいる案件全体のルールは移さない（migrated_from = NULL。表は残す）', rules[PX].migrated_at && rules[PX].migrated_from == null, rules[PX])
  const plr = await shiftRows(pl)
  ok('移したシフト: 8月 83,333・83,333・83,334、9月 125,000 × 2（単位 monthly・単価 250,000）', JSON.stringify(amounts(plr)) === JSON.stringify([83333, 83333, 83334, 125000, 125000]) && plr.every(r => r.bill_unit_type === 'monthly' && Number(r.bill_rate) === 250000), amounts(plr))
  const psr = await shiftRows(ps)
  ok('スタッフ別: 確定済みの8月のシフトは変えず（0 のまま）、9月は 26,666・26,666・26,668', JSON.stringify(amounts(psr)) === JSON.stringify([0, 0, 26666, 26666, 26668]) && psr[0].bill_unit_type !== 'monthly', amounts(psr))
  const pxr = await shiftRows(px)
  ok('移さないルールのシフトは変えない', pxr.every(r => r.bill_unit_type !== 'monthly' && Number(r.unit_price) === 0), pxr)
  const s8 = await settle(`from=2016-08-01&to=2016-08-31&project_id=${PS}`), s9 = await settle(`from=2016-09-01&to=2016-09-30&project_id=${PS}`)
  ok('移せなかった月（8月）は「月額（固定）」の行のまま、移した月（9月）は行を出さない', s8.monthly_lines.length === 1 && s8.monthly_lines[0].amount === 80000 && s9.monthly_lines.length === 0, [s8.monthly_lines, s9.monthly_lines])
  const p = must(await admin.get(`/api/admin/projects/${PL}?month=2016-09`), 'detail').project
  ok('案件全体のルールは、案件の標準の請求単価を月額 250,000 にする（案件の一覧・詳細の月額（固定）は出さない）', p.unit_price_type === 'monthly' && Number(p.unit_price) === 250000 && p.monthly_amount == null, [p.unit_price_type, p.unit_price, p.monthly_amount])
  const rr = await sql(`SELECT staff_id, bill_unit_type, bill_rate, valid_from, valid_to FROM rate_rules WHERE project_id = ${PS}`)
  ok('スタッフ別のルールは、スタッフ別の単価ルール（月額 80,000・2016-09-01 から）として残す', rr.length === 1 && Number(rr[0].staff_id) === D && rr[0].bill_unit_type === 'monthly' && Number(rr[0].bill_rate) === 80000 && rr[0].valid_from === '2016-09-01' && rr[0].valid_to == null, rr)
  const n1 = await newShift(PL, C, '2016-10-03'), n2 = await newShift(PS, D, '2016-10-04')
  const nr = await shiftRows([n1, n2])
  ok('移した後に作るシフトにも月額が効く（案件の標準・スタッフ別の単価ルール）', nr[0].bill_unit_type === 'monthly' && Number(nr[0].unit_price) === 250000 && nr[1].bill_unit_type === 'monthly' && Number(nr[1].unit_price) === 80000, nr)
  const again = await billOf()
  await sqlAll(part)
  ok('移し替えをもう一度流しても、何も変わらない（処理済みのルールは見ない）', JSON.stringify(await billOf()) === JSON.stringify(again))
  const list = must(await admin.get(`/api/admin/settlement/monthly-rules?project_id=${PS}`), 'rules').rules
  ok('月額（固定）の一覧は、移した月（migrated_from）を返す', list.length === 1 && list[0].migrated_from === '2016-09' && list[0].migrated_at, list)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:\n' + failed.map(f => '  - ' + f.name).join('\n')); process.exit(1) }
