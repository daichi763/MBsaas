// シフトの単価を小数（小数第2位まで）で入れられるようにする（利用者の要望 11/17。Sprint 29 #9985。w29-decimal）の統合テスト
//   1. 単価の手動変更（PUT /shifts/:id/price）: 時給 1,012.5 円 × 7.5 時間 = 7,594 円（7,593.75 の丸め）、日額 10,000.5 円 = 10,001 円。単価は 1012.5 のまま保存
//   2. 小数第3位以下は 400。月額は円単位だけ（400）
//   3. 精算の一覧・CSV・明細書に単価を入力どおり（1012.5 / ¥1,012.5）出す。金額は円
//   4. 同じ部品で受ける所（案件の登録・案件の標準単価・単価ルール（インセンティブ）・募集枠の役割の単価・シフト登録の単価）も小数を受け付ける
//   5. 既存の整数の単価の金額は変わらない。手動変更のシフトの時間を変えると、小数の単価のまま金額を計算し直す
//   6. 画面の単価の入力欄に step="0.01" がある
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --port 9020 --persist-to <保存先>` で起動していること（ローカルの D1 を読むだけ。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9020 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w29-decimal.mjs
//   本番には接続しない（wrangler d1 execute は --local のみ）。日付は過去の期間（2015年）を使う
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED'].includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500)); return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9020'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 800) : ''}`) }

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w29d-'))
let sqlSeq = 0
async function sql(command) {
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
  return JSON.parse(out.slice(out.indexOf('['))).at(-1).results
}
// d1 execute の後は、サーバーが DB を開き直すまで少し待つ（切れた接続を避ける）
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await rawFetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}

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

const PFX = 'W29D' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + 500 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// ---------- 6. 画面のコード ----------
{
  const sb = await staticJs('shift-board.js'), st = await staticJs('settlement.js'), a = await staticJs('admin.js')
  const hasStep = (src, re) => re.test(src)
  ok('シフトボードのシフト詳細の単価の欄に step="0.01"', hasStep(sb, /id="sp-bill-rate" type="number" min="0" step="0\.01"/) && hasStep(sb, /id="sp-pay-rate" type="number" min="0" step="0\.01"/))
  ok('精算の金額の修正の単価の欄に step="0.01"', hasStep(st, /id="spx-bill-rate" type="number" min="0" step="0\.01"/) && hasStep(st, /id="spx-pay-rate" type="number" min="0" step="0\.01"/))
  ok('案件の標準単価・単価ルール・インセンティブ・枠の役割・登録で変える単価の欄に step="0.01"',
    ['id="pp-bill"', 'id="pp-pay"', 'id="rl-bill"', 'id="rl-pay"', 'id="rl-inc"', 'rr-bill"', 'rr-pay"', 'id="${prefix}-bill-rate"', 'id="${prefix}-pay-rate"'].every(k => sb.includes(`${k} type="number" min="0" step="0.01"`)))
  ok('シフト登録・案件の登録の単価の欄に step="0.01"', a.includes('id="sh-bill-rate" type="number" min="0" step="0.01"') && a.includes('id="sh-pay-rate" type="number" min="0" step="0.01"') && a.includes('id="np-price" type="number" min="0" step="0.01"'))
  ok('画面の yen は toLocaleString（¥1,012.5 と出る）', a.includes("function yen(n) { return '¥' + Number(n || 0).toLocaleString() }") && Number(1012.5).toLocaleString('ja-JP') === '1,012.5')
  ok('インセンティブを足した支払単価は小数2桁に丸めて送る', sb.includes('String(rate2(Number(base) + Number(inc)))'))
}

// ---------- 準備 ----------
must(await admin.post('/api/admin/clients', { client_name: `${PFX} クライアント` }), 'client')
const CL = must(await admin.get('/api/admin/settlement/options'), 'options').clients.find(c => c.client_name === `${PFX} クライアント`).client_id
const newProject = async (name, unit, price) => {
  const id = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${name}`, client_id: CL, unit_price_type: unit, unit_price: price }), 'project ' + name).project_id
  // 休憩 60 分（10:00〜18:30 で 7.5 時間）
  must(await admin.put(`/api/admin/projects/${id}/pricing`, { unit_price_type: unit, unit_price: price, default_break_minutes: 60 }), 'pricing ' + name)
  return id
}
const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const newShift = async (project_id, staff_id, work_date, extra = {}) => must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '18:30', notify: false, ...extra }), `shift ${work_date}`).shift_id
const row = async (id) => (await sql(`SELECT shift_id, bill_unit_type, bill_rate, bill_qty, unit_price, pay_unit_type, pay_rate, pay_qty, pay_amount, price_locked, end_time FROM shifts WHERE shift_id = ${Number(id)}`))[0]

const PH = await newProject('時給', 'hourly', 1000)
const PD = await newProject('日額', 'daily', 16000)
const A = await newStaff(1), B = await newStaff(2), C = await newStaff(3), D = await newStaff(4)

// ---------- 1. 単価の手動変更 ----------
const h1 = await newShift(PH, A, '2015-03-02')
const d1 = await newShift(PD, A, '2015-03-03')
{
  const before = await row(h1)
  ok('準備: 時給 1,000 円 × 7.5 時間 = 7,500 円', before.bill_unit_type === 'hourly' && Number(before.bill_qty) === 7.5 && Number(before.unit_price) === 7500, before)
  must(await admin.put(`/api/admin/shifts/${h1}/price`, { bill_unit_type: 'hourly', bill_rate: '1012.5', pay_unit_type: 'hourly', pay_rate: '1012.5', bill_qty: '', pay_qty: '' }), 'price h1')
  const r = await row(h1)
  ok('時給 1,012.5 円 × 7.5 時間 = 7,594 円（7,593.75 の丸め）。単価は 1012.5 のまま保存', Number(r.bill_rate) === 1012.5 && Number(r.unit_price) === 7594 && Number(r.pay_rate) === 1012.5 && Number(r.pay_amount) === 7594 && r.price_locked === 1, r)
  must(await admin.put(`/api/admin/shifts/${d1}/price`, { bill_unit_type: 'daily', bill_rate: 10000.5, pay_unit_type: 'daily', pay_rate: 8000.25 }), 'price d1')
  const d = await row(d1)
  ok('日額 10,000.5 円 = 10,001 円、支払 8,000.25 円 = 8,000 円', Number(d.bill_rate) === 10000.5 && Number(d.unit_price) === 10001 && Number(d.pay_rate) === 8000.25 && Number(d.pay_amount) === 8000, d)
  // 数量を直接入れたとき
  const h2 = await newShift(PH, B, '2015-03-04')
  must(await admin.put(`/api/admin/shifts/${h2}/price`, { bill_unit_type: 'hourly', bill_rate: 1012.55, bill_qty: 3 }), 'price h2')
  const q = await row(h2)
  ok('時給 1,012.55 円 × 数量 3（直接入力）= 3,038 円（3,037.65 の丸め）', Number(q.bill_rate) === 1012.55 && Number(q.unit_price) === 3038 && Number(q.bill_qty) === 3, q)
  // ちょうど .5 になる金額は誤差で切り下げない（そのまま掛けると 1,024.6 × 7.5 = 7,684.4999… → 7,684 になる）
  const h3 = await newShift(PH, C, '2015-03-05')
  must(await admin.put(`/api/admin/shifts/${h3}/price`, { bill_unit_type: 'hourly', bill_rate: 1024.6, pay_unit_type: 'hourly', pay_rate: 1026.6, bill_qty: '', pay_qty: '' }), 'price h3')
  const e = await row(h3)
  ok('時給 1,024.6 円 × 7.5 時間 = 7,685 円（7,684.5 の丸め）、支払 1,026.6 円 × 7.5 時間 = 7,700 円', Number(e.unit_price) === 7685 && Number(e.pay_amount) === 7700, e)
  must(await admin.put(`/api/admin/shifts/${h3}/price`, { bill_unit_type: 'hourly', bill_rate: 1025.36, bill_qty: 6.25, pay_unit_type: 'hourly', pay_rate: 1027.12, pay_qty: 6.25 }), 'price h3 qty')
  const e2 = await row(h3)
  ok('数量を直接入れても .5 を切り下げない（1,025.36 × 6.25 = 6,408.5 → 6,409、1,027.12 × 6.25 = 6,419.5 → 6,420）', Number(e2.unit_price) === 6409 && Number(e2.pay_amount) === 6420, e2)
  // 実績を入れると、小数の単価のまま時給の数量と金額を実働に合わせる（10:00〜17:30・休憩 60 分 = 6.5 時間 → 6,581.25 → 6,581）
  must(await admin.put(`/api/admin/shifts/${h1}/actual`, { actual_start: '10:00', actual_end: '17:30', actual_break_minutes: 60 }), 'actual h1')
  const t = await row(h1)
  ok('実績を入れると、1,012.5 円 × 6.5 時間 = 6,581 円に計算し直す（単価は 1012.5 のまま）', Number(t.bill_rate) === 1012.5 && Number(t.bill_qty) === 6.5 && Number(t.unit_price) === 6581 && Number(t.pay_amount) === 6581, t)
  must(await admin.put(`/api/admin/shifts/${h1}/actual`, { reset: true }), 'actual h1 reset')
  const back = await row(h1)
  ok('実績を戻すと 7,594 円に戻る', Number(back.unit_price) === 7594 && Number(back.bill_qty) === 7.5, back)
}

// ---------- 2. 第3位以下・月額 ----------
{
  const bad = await admin.put(`/api/admin/shifts/${h1}/price`, { bill_unit_type: 'hourly', bill_rate: 1012.555 })
  ok('小数第3位のある単価は 400（丸めない）', bad.status === 400 && bad.data?.error === '請求単価は小数第2位までで入力してください', [bad.status, bad.data])
  const badPay = await admin.put(`/api/admin/shifts/${h1}/price`, { pay_unit_type: 'hourly', pay_rate: '1000.001' })
  ok('支払単価も小数第3位は 400', badPay.status === 400 && badPay.data?.error === '支払単価は小数第2位までで入力してください', [badPay.status, badPay.data])
  const r = await row(h1)
  ok('400 のときは単価・金額を変えない', Number(r.bill_rate) === 1012.5 && Number(r.unit_price) === 7594, r)
  const mon = await admin.put(`/api/admin/shifts/${d1}/price`, { bill_unit_type: 'monthly', bill_rate: 300000.5 })
  ok('月額は円単位だけ（小数は 400）', mon.status === 400 && mon.data?.error === '請求単価（月額）は1円単位で入力してください', [mon.status, mon.data])
  const monOnly = await admin.put(`/api/admin/shifts/${h1}/price`, { bill_unit_type: 'monthly' })
  ok('単位だけを月額に変えても、今の小数の単価（1012.5）は 400', monOnly.status === 400 && /月額/.test(monOnly.data?.error || ''), [monOnly.status, monOnly.data])
  const neg = await admin.put(`/api/admin/shifts/${h1}/price`, { bill_rate: -0.5 })
  ok('マイナスの単価は今までどおり 400', neg.status === 400 && /マイナス/.test(neg.data?.error || ''), [neg.status, neg.data])
}

// ---------- 3. 精算の一覧・CSV・明細書 ----------
{
  const s = must(await admin.get(`/api/admin/settlement?from=2015-03-01&to=2015-03-31&project_id=${PH}`), 'settlement')
  const r = s.rows.find(x => x.shift_id === h1)
  ok('精算の一覧: 単価 1012.5・基本額 7,594 を返す（画面は yen で ¥1,012.5）', r && r.bill_rate === 1012.5 && r.bill_base === 7594 && r.pay_rate === 1012.5 && r.pay_base === 7594, r)
  ok('精算の一覧: 小数の単価で「数量・金額が今の計算と違う」を出さない', r && !r.issues.includes('数量・金額が今の計算と違う'), r?.issues)
  const csv = await admin.get(`/api/admin/settlement/export?kind=detail&from=2015-03-01&to=2015-03-31&project_id=${PH}`)
  const lines = csv.text.replace(/^﻿/, '').split('\r\n')
  const head = lines[0].split(',')
  const ir = head.indexOf('請求単価'), ib = head.indexOf('請求基本額'), pr = head.indexOf('支払単価'), pb = head.indexOf('支払基本額')
  const cells = lines.find(l => l.startsWith(String(h1) + ','))?.split(',') || []
  ok('明細の CSV: 請求単価 1012.5・請求基本額 7594・支払単価 1012.5（列の並びは今までどおり）', cells[ir] === '1012.5' && cells[ib] === '7594' && cells[pr] === '1012.5' && cells[pb] === '7594' && head.slice(20, 23).join(',') === '請求単位,請求単価,請求数量', [cells[ir], cells[ib], cells[pr], cells[pb]])
  const q = s.rows.find(x => x.shift_id !== h1)
  const qc = lines.find(l => q && l.startsWith(String(q.shift_id) + ','))?.split(',') || []
  ok('明細の CSV: 1012.55 もそのまま出す', qc[ir] === '1012.55' && qc[ib] === '3038', [qc[ir], qc[ib]])
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [h1], force: true }), 'confirm')
  const stmt = await admin.get(`/api/admin/settlement/statement?kind=billing&client_id=${CL}&from=2015-03-01&to=2015-03-31`)
  ok('請求明細書: 単価「¥1,012.5/時」・金額「¥7,594」', stmt.status === 200 && stmt.text.includes('¥1,012.5/時') && stmt.text.includes('¥7,594'), stmt.text.slice(0, 300))
  ok('請求明細書: 単価を円に丸めて出さない（¥1,013/時 がない）', !stmt.text.includes('¥1,013/時'))
  const locked = await admin.put(`/api/admin/shifts/${h1}/price`, { bill_rate: 1100.5 })
  ok('確定済みのシフトの単価は今までどおり変えられない（409）', locked.status === 409, locked.status)
  must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [h1] }), 'unconfirm')
}

// ---------- 4. 同じ部品で受ける所 ----------
{
  // 案件の登録
  const PX = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-小数の登録`, client_id: CL, unit_price_type: 'hourly', unit_price: 1012.5 }), 'project decimal').project_id
  const px = must(await admin.get(`/api/admin/projects/${PX}`), 'detail').project
  ok('案件の登録: 時給 1012.5 を保存', Number(px.unit_price) === 1012.5 && px.unit_price_type === 'hourly', [px.unit_price, px.unit_price_type])
  const pBad = await admin.post('/api/admin/projects', { project_name: `${PFX}-小数3桁`, client_id: CL, unit_price_type: 'hourly', unit_price: 1012.555 })
  ok('案件の登録: 小数第3位は 400', pBad.status === 400 && /小数第2位/.test(pBad.data?.error || ''), [pBad.status, pBad.data])
  const pMon = await admin.post('/api/admin/projects', { project_name: `${PFX}-月額小数`, client_id: CL, unit_price_type: 'monthly', unit_price: 300000.5 })
  ok('案件の登録: 月額の小数は 400（今までどおり）', pMon.status === 400 && /月額/.test(pMon.data?.error || ''), [pMon.status, pMon.data])

  // 案件の標準単価
  must(await admin.put(`/api/admin/projects/${PX}/pricing`, { unit_price_type: 'hourly', unit_price: '1012.5', pay_unit_type: 'hourly', pay_rate: '980.75', default_break_minutes: 60 }), 'pricing PX')
  const pp = must(await admin.get(`/api/admin/projects/${PX}`), 'detail').project
  ok('案件の標準単価: 請求 1012.5・支払 980.75 を保存', Number(pp.unit_price) === 1012.5 && Number(pp.pay_rate) === 980.75, [pp.unit_price, pp.pay_rate])
  const x1 = await newShift(PX, C, '2015-04-01')
  const xr = await row(x1)
  ok('案件の標準単価から作ったシフト: 1,012.5 × 7.5 = 7,594、支払 980.75 × 7.5 = 7,356（7,355.625 の丸め）', Number(xr.bill_rate) === 1012.5 && Number(xr.unit_price) === 7594 && Number(xr.pay_rate) === 980.75 && Number(xr.pay_amount) === 7356 && xr.price_locked === 0, xr)
  const ppBad = await admin.put(`/api/admin/projects/${PX}/pricing`, { unit_price_type: 'hourly', unit_price: 1012.5, pay_rate: 980.755 })
  ok('案件の標準単価: 小数第3位は 400', ppBad.status === 400 && ppBad.data?.error === '支払単価は小数第2位までで入力してください', [ppBad.status, ppBad.data])
  const ppMonOnly = await admin.put(`/api/admin/projects/${PX}/pricing`, { unit_price_type: 'monthly' })
  ok('案件の標準単価: 単位だけを月額に変えても、今の小数の単価は 400', ppMonOnly.status === 400 && /月額/.test(ppMonOnly.data?.error || ''), [ppMonOnly.status, ppMonOnly.data])
  const ppMon = await admin.put(`/api/admin/projects/${PX}/pricing`, { unit_price_type: 'monthly', unit_price: 300000.5 })
  ok('案件の標準単価: 月額の小数は 400', ppMon.status === 400 && /月額/.test(ppMon.data?.error || ''), [ppMon.status, ppMon.data])

  // 単価ルール（インセンティブも小数）
  const rule = must(await admin.post('/api/admin/rate-rules', { project_id: PD, staff_id: C, bill_unit_type: 'hourly', bill_rate: 1050.25, pay_unit_type: 'hourly', pay_rate: 1100.75, pay_incentive: 100.25 }), 'rule')
  const rules = must(await admin.get(`/api/admin/rate-rules?project_id=${PD}`), 'rules').rules
  const rr = rules.find(x => x.rule_id === rule.rule_id)
  ok('単価ルール: 請求 1050.25・支払 1100.75・インセンティブ 100.25 を保存', rr && Number(rr.bill_rate) === 1050.25 && Number(rr.pay_rate) === 1100.75 && Number(rr.pay_incentive) === 100.25, rr)
  const c1 = await newShift(PD, C, '2015-04-02')
  const cr = await row(c1)
  ok('単価ルールから作ったシフト: 1,050.25 × 7.5 = 7,877（7,876.875）、支払 1,100.75 × 7.5 = 8,256（8,255.625）', Number(cr.bill_rate) === 1050.25 && Number(cr.unit_price) === 7877 && Number(cr.pay_amount) === 8256, cr)
  const rBad = await admin.post('/api/admin/rate-rules', { project_id: PD, staff_id: C, bill_unit_type: 'daily', bill_rate: 1000.001 })
  ok('単価ルール: 小数第3位は 400', rBad.status === 400 && rBad.data?.error === '請求単価は小数第2位までで入力してください', [rBad.status, rBad.data])
  const rMon = await admin.post('/api/admin/rate-rules', { project_id: PD, staff_id: C, bill_unit_type: 'monthly', bill_rate: 90000.5 })
  ok('単価ルール: 月額の小数は 400', rMon.status === 400 && /月額/.test(rMon.data?.error || ''), [rMon.status, rMon.data])
  must(await admin.put(`/api/admin/rate-rules/${rule.rule_id}`, { pay_rate: 1100.75 }), 'rule same pay')
  const rr2 = must(await admin.get(`/api/admin/rate-rules?project_id=${PD}`), 'rules').rules.find(x => x.rule_id === rule.rule_id)
  ok('単価ルールの編集: 同じ小数の支払単価を送っても、インセンティブを外さない', Number(rr2.pay_incentive) === 100.25, rr2)
  must(await admin.del(`/api/admin/rate-rules/${rule.rule_id}`), 'rule del')

  // 募集枠の役割の単価
  const slot = must(await admin.post('/api/admin/shift-slots', { project_id: PD, dates: ['2015-04-06'], start_time: '10:00', end_time: '18:30',
    roles: [{ role_name: '販売', headcount: 1, bill_unit_type: 'hourly', bill_rate: '1012.5', pay_unit_type: 'daily', pay_rate: '9000.5' }] }), 'slot').slot_ids[0]
  const role = must(await admin.get(`/api/admin/shift-slots/${slot}`), 'slot detail').roles[0]
  ok('募集枠の役割: 請求 1012.5（時給）・支払 9000.5（日額）を保存', Number(role.bill_rate) === 1012.5 && role.bill_unit_type === 'hourly' && Number(role.pay_rate) === 9000.5, role)
  const sBad = await admin.post('/api/admin/shift-slots', { project_id: PD, dates: ['2015-04-07'], start_time: '10:00', end_time: '18:30', roles: [{ role_name: '販売', headcount: 1, bill_rate: '1012.555' }] })
  ok('募集枠の役割: 小数第3位は 400', sBad.status === 400 && /小数第2位/.test(sBad.data?.error || ''), [sBad.status, sBad.data])

  // シフト登録で変える単価
  const o1 = await newShift(PD, B, '2015-04-08', { price: { bill_unit_type: 'hourly', bill_rate: 1012.5 } })
  const or = await row(o1)
  ok('シフト登録で変えた単価 1012.5（時給）: 7,594 円・手動変更', Number(or.bill_rate) === 1012.5 && or.bill_unit_type === 'hourly' && Number(or.unit_price) === 7594 && or.price_locked === 1, or)
  const oBad = await admin.post('/api/admin/shifts', { staff_id: B, project_id: PD, work_date: '2015-04-09', start_time: '10:00', end_time: '18:30', notify: false, price: { bill_rate: 1012.555 } })
  ok('シフト登録で変える単価: 小数第3位は 400', oBad.status === 400 && /小数第2位/.test(oBad.data?.error || ''), [oBad.status, oBad.data])
}

// ---------- 5. 整数の単価は今までどおり ----------
{
  const PI = await newProject('整数の時給', 'hourly', 1500)
  // B は直前に時給 1012.5 のシフトがある（直近の単価の引き継ぎ D-18 が効く）ので、日額は D で確かめる
  const i1 = await newShift(PI, B, '2015-05-01'), i2 = await newShift(PD, D, '2015-05-02')
  const [a, b] = [await row(i1), await row(i2)]
  ok('整数の時給 1,500 × 7.5 = 11,250（今までどおり）', Number(a.bill_rate) === 1500 && Number(a.unit_price) === 11250 && Number(a.bill_qty) === 7.5, a)
  ok('整数の日額 16,000（今までどおり）', Number(b.bill_rate) === 16000 && Number(b.unit_price) === 16000 && Number(b.bill_qty) === 1, b)
  must(await admin.put(`/api/admin/shifts/${i1}/price`, { bill_unit_type: 'hourly', bill_rate: 1200, pay_unit_type: 'hourly', pay_rate: 1000 }), 'price i1')
  const c = await row(i1)
  ok('整数の単価の手動変更: 1,200 × 7.5 = 9,000、支払 1,000 × 7.5 = 7,500', Number(c.bill_rate) === 1200 && Number(c.unit_price) === 9000 && Number(c.pay_amount) === 7500, c)
  // 調整額・交通費は今までどおり円（小数は丸める）
  must(await admin.put(`/api/admin/shifts/${i2}/price`, { bill_adjust: 100.4, transportation_fee: 500 }), 'adjust i2')
  const adj = (await sql(`SELECT bill_adjust, transportation_fee, unit_price, price_locked FROM shifts WHERE shift_id = ${i2}`))[0]
  ok('調整額・交通費は今までどおり円（100.4 → 100）、調整だけなら手動変更にしない', Number(adj.bill_adjust) === 100 && Number(adj.transportation_fee) === 500 && Number(adj.unit_price) === 16000 && adj.price_locked === 0, adj)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
