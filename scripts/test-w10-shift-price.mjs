// シフト登録で直近の単価を引き継ぐ（w10-shift-price: 9306）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w10-shift-price.mjs
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
const must = (r, label) => { if (r.status !== 200) throw new Error(`${label}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const admin = client(await login('sample', 'admin'))
const PFX = 'W10P' + Date.now().toString(36).slice(-4).toUpperCase()

// ---------- 準備: スタッフ6人と、日額の案件を作る関数 ----------
for (let i = 0; i < 6; i++) must(await admin.post('/api/admin/staff', { user_code: `${PFX}S${i}`, name: `${PFX} スタッフ${i}`, password: 'pass1234' }), 'staff')
const S = (must(await admin.get('/api/admin/staff'), 'staff list').staff).filter(s => String(s.user_code).startsWith(PFX)).sort((a, b) => a.staff_id - b.staff_id).map(s => s.staff_id)
ok('準備: スタッフ6人', S.length === 6, S)

async function newProject(tag, pricing = {}) {
  const r = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${tag}`, unit_price: 10000, allow_duplicate: true }), 'project')
  must(await admin.put(`/api/admin/projects/${r.project_id}/pricing`, { unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000, default_break_minutes: 60, ...pricing }), 'pricing')
  return r.project_id
}
async function createShift(project_id, staff_id, work_date, extra = {}) {
  return must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '19:00', memo: PFX, ...extra }), 'createShift ' + work_date)
}
async function boardShift(id, date) {
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  for (const s of b.slots || []) for (const r of s.roles) { const a = r.assigned.find(x => x.shift_id === id); if (a) return a }
  return (b.unslotted || []).find(x => x.shift_id === id)
}
const setManual = async (id, bill, pay) => must(await admin.put(`/api/admin/shifts/${id}/price`, { bill_rate: bill, pay_rate: pay }), 'manual price')
const D = (n) => addDays(today, -n)
const firstRole = async (slotId) => must(await admin.get(`/api/admin/shift-slots/${slotId}`), "slot get").roles[0].slot_role_id

// ---------- 常勤: 同じスタッフ × 同じ案件の前回のシフトの単価を引き継ぐ ----------
{
  const P = await newProject('reg')
  const first = await createShift(P, S[0], D(40))
  ok('常勤: 前回のシフトがなければ引き継がない（単価の設定）', first.inherited === null, first)
  await setManual(first.shift_id, 12000, 9000)

  const pv = must(await admin.get(`/api/admin/shifts/price-preview?project_id=${P}&work_date=${D(35)}&staff_ids=${S[0]},${S[1]}&start_time=10:00&end_time=19:00`), 'preview')
  const p0 = pv.items.find(x => x.staff_id === S[0]), p1 = pv.items.find(x => x.staff_id === S[1])
  ok('見込み: 引き継ぎ元の日付と金額を返す', p0?.inherited?.work_date === D(40) && p0.inherited.bill_rate === 12000 && p0.inherited.pay_rate === 9000 && p0.inherited.label === `前回のシフト（${md(D(40))}）`, p0)
  ok('見込み: 引き継いだ単価と、単価の設定の単価を両方返す', p0?.price.bill_rate === 12000 && p0.settings.bill_rate === 10000 && p0.price.amounts.unit_price === 12000, p0)
  ok('見込み: 常勤は別のスタッフの前回を見ない', p1 && p1.inherited === null && p1.price.bill_rate === 10000, p1)

  const second = await createShift(P, S[0], D(35))
  ok('常勤: 登録の応答に引き継ぎ元のシフトの日付と金額', second.inherited?.shift_id === first.shift_id && second.inherited.work_date === D(40) && second.inherited.bill_rate === 12000, second)
  const b2 = await boardShift(second.shift_id, D(35))
  ok('常勤: 前回の単価（請求12000・支払9000）で登録し、手動変更にはしない', b2?.bill_rate === 12000 && b2.pay_rate === 9000 && b2.unit_price === 12000 && b2.pay_amount === 9000 && !b2.price_locked, b2)
  ok('常勤: 金額の出どころに「前回のシフト（M/D）」', JSON.parse(b2.price_source || '{}').bill === `前回のシフト（${md(D(40))}）`, b2?.price_source)

  const other = await createShift(P, S[1], D(35))
  const bo = await boardShift(other.shift_id, D(35))
  ok('常勤: 別のスタッフは単価の設定のまま', other.inherited === null && bo?.bill_rate === 10000 && bo.pay_rate === 8000, { other, bo })

  const older = await createShift(P, S[0], D(45))
  ok('常勤: 稼働日が前回より前なら引き継がない（今回より前のシフトだけを見る）', older.inherited === null && (await boardShift(older.shift_id, D(45)))?.bill_rate === 10000, older)

  const noInh = await createShift(P, S[0], D(33), { inherit: false })
  ok('inherit: false なら単価の設定で登録する', noInh.inherited === null && (await boardShift(noInh.shift_id, D(33)))?.bill_rate === 10000, noInh)

  // 画面で単価を変えて登録 → 手動変更。次の登録はその単価を引き継ぐ
  const ov = await createShift(P, S[0], D(30), { price: { bill_rate: 13000, pay_rate: 9500 } })
  const bov = await boardShift(ov.shift_id, D(30))
  ok('登録の画面で変えた単価は手動変更として入る', bov?.bill_rate === 13000 && bov.pay_rate === 9500 && bov.unit_price === 13000 && !!bov.price_locked, bov)
  const neg = await admin.post('/api/admin/shifts', { staff_id: S[0], project_id: P, work_date: D(29), start_time: '10:00', end_time: '19:00', price: { bill_rate: -1 } })
  ok('登録の画面のマイナスの単価は 400', neg.status === 400, neg.data)
  const next = await createShift(P, S[0], D(28))
  ok('手動で変えた単価を次の登録で引き継ぐ', next.inherited?.work_date === D(30) && (await boardShift(next.shift_id, D(28)))?.bill_rate === 13000, next)

  // 時間を変えても引き継いだ単価は保つ。単価ルールの再適用では設定の単価に戻る（再適用の計算は変えない）
  must(await admin.put(`/api/admin/shifts/${second.shift_id}`, { end_time: '18:00' }), 'time change')
  ok('時間を変えても、引き継いだ単価は保つ', (await boardShift(second.shift_id, D(35)))?.bill_rate === 12000)
  must(await admin.post('/api/admin/shifts/reprice', { from: D(36), to: D(34), project_id: P }), 'reprice')
  const rp = await boardShift(second.shift_id, D(35))
  ok('単価ルールの再適用では、単価の設定の単価にする', rp?.bill_rate === 10000 && rp.pay_rate === 8000, rp)
}

// ---------- 調整も引き継ぐ ----------
{
  const P = await newProject('adj')
  const a = await createShift(P, S[2], D(40))
  must(await admin.put(`/api/admin/shifts/${a.shift_id}/price`, { pay_adjust: 1000, adjust_note: 'リーダー手当' }), 'adjust')
  const b = await createShift(P, S[2], D(38))
  const bb = await boardShift(b.shift_id, D(38))
  ok('調整（支払 +1000・内容）も引き継ぐ', b.inherited?.pay_adjust === 1000 && bb?.pay_adjust === 1000 && bb.adjust_note === 'リーダー手当', { b, bb })
}

// ---------- 単価の設定が変わったときは引き継がない ----------
{
  // 案件の標準単価をその場で直した
  const P1 = await newProject('chg-std')
  const a = await createShift(P1, S[3], D(40)); await setManual(a.shift_id, 12000, 9000)
  must(await admin.put(`/api/admin/projects/${P1}/pricing`, { unit_price: 11000 }), 'std change')
  const b = await createShift(P1, S[3], D(38))
  ok('設定変更: 案件の標準単価を直したあとは引き継がない', b.inherited === null && (await boardShift(b.shift_id, D(38)))?.bill_rate === 11000, b)
  // 直したあとのシフトからは、また引き継ぐ
  await setManual(b.shift_id, 11500, 9000)
  const c = await createShift(P1, S[3], D(36))
  ok('設定変更: 変更のあとのシフトからは引き継ぐ', c.inherited?.work_date === D(38) && (await boardShift(c.shift_id, D(36)))?.bill_rate === 11500, c)

  // 単価ルールを追加した
  const P2 = await newProject('chg-rule')
  const d = await createShift(P2, S[3], D(30)); await setManual(d.shift_id, 12000, 9000)
  const rule = must(await admin.post('/api/admin/rate-rules', { project_id: P2, bill_rate: 10500, bill_unit_type: 'daily' }), 'rule')
  const e = await createShift(P2, S[3], D(28))
  ok('設定変更: 単価ルールを追加したあとは引き継がない', e.inherited === null && (await boardShift(e.shift_id, D(28)))?.bill_rate === 10500, e)

  // 単価ルールを変更した（ルールの単価で作ったシフトを、手動で変えずに引き継ぐ場合も）
  const f = await createShift(P2, S[3], D(26))
  ok('設定変更の確認の前提: ルールのままのシフトは前回（ルールの単価）を引き継ぐ', f.inherited?.work_date === D(28), f)
  await setManual(f.shift_id, 13000, 9000)
  must(await admin.put(`/api/admin/rate-rules/${rule.rule_id}`, { bill_rate: 10800 }), 'rule edit')
  const g = await createShift(P2, S[3], D(24))
  ok('設定変更: 単価ルールを変更したあとは引き継がない', g.inherited === null && (await boardShift(g.shift_id, D(24)))?.bill_rate === 10800, g)

  // 標準単価の改定（適用開始日つき）: 改定日より後の日付は引き継がず、改定日より前の日付は引き継ぐ
  const P3 = await newProject('chg-rev')
  const h = await createShift(P3, S[4], D(40)); await setManual(h.shift_id, 12000, 9000)
  must(await admin.put(`/api/admin/projects/${P3}/pricing`, { unit_price: 11000, price_valid_from: D(36) }), 'revision')
  const i = await createShift(P3, S[4], D(35))
  ok('設定変更: 改定の適用開始日より後のシフトは引き継がない（改定後の単価）', i.inherited === null && (await boardShift(i.shift_id, D(35)))?.bill_rate === 11000, i)
  const j = await createShift(P3, S[4], D(38))
  ok('改定の適用開始日より前のシフトは、改定前の設定のままなので引き継ぐ', j.inherited?.work_date === D(40) && (await boardShift(j.shift_id, D(38)))?.bill_rate === 12000, j)
}

// ---------- スポット: 同じ案件のいちばん新しいシフト（人は見ない。同じ役割を優先） ----------
{
  const P = await newProject('spot', { engagement_type: 'spot' })
  const a = await createShift(P, S[0], D(20)); await setManual(a.shift_id, 15000, 11000)
  const leader = await createShift(P, S[1], D(18), { role: 'リーダー' }); await setManual(leader.shift_id, 20000, 15000)
  const pv = must(await admin.get(`/api/admin/shifts/price-preview?project_id=${P}&work_date=${D(15)}`), 'spot preview')
  ok('スポットの見込み: スタッフを選ばなくても、同じ役割の前回を返す', pv.engagement_type === 'spot' && pv.items.length === 1 && pv.items[0].inherited?.work_date === D(20), pv)
  const b = await createShift(P, S[2], D(15))
  ok('スポット: 別のスタッフでも同じ案件の前回の単価を引き継ぐ（同じ役割を優先）', b.inherited?.shift_id === a.shift_id && (await boardShift(b.shift_id, D(15)))?.bill_rate === 15000, b)
  const c = await createShift(P, S[3], D(15), { role: 'リーダー' })
  ok('スポット: 役割がリーダーならリーダーの前回を引き継ぐ', c.inherited?.shift_id === leader.shift_id && (await boardShift(c.shift_id, D(15)))?.bill_rate === 20000, c)

  // 枠への割り当て（スポットの枠。役割の単価なし）
  const slot = must(await admin.post('/api/admin/shift-slots', { project_id: P, work_date: D(10), start_time: '10:00', end_time: '19:00', roles: [{ role_name: '販売スタッフ', headcount: 2 }] }), 'slot')
  const roleId = await firstRole(slot.slot_ids[0])
  const spv = must(await admin.get(`/api/admin/shifts/price-preview?slot_role_id=${roleId}&staff_ids=${S[4]}`), 'slot preview')
  ok('枠の見込み: 枠の日付で引き継ぎ元を返す', spv.items[0]?.inherited?.work_date === D(15) && spv.items[0].price.bill_rate === 15000, spv)
  const as = must(await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [S[4]], force: true }), 'assign')
  const sb = await boardShift(as.shift_ids[0], D(10))
  ok('枠への割り当て: 応答に引き継ぎ元（日付と金額）', as.inherited?.length === 1 && as.inherited[0].work_date === D(15) && as.inherited[0].bill_rate === 15000, as)
  ok('枠への割り当て: 前回の単価で登録', sb?.bill_rate === 15000 && sb.pay_rate === 11000, sb)
  const as2 = must(await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [S[5]], force: true, inherit: false, price: { pay_rate: 11500 } }), 'assign2')
  const sb2 = await boardShift(as2.shift_ids[0], D(10))
  ok('枠への割り当て: inherit: false と単価の変更（支払 11500）', as2.inherited.length === 0 && sb2?.bill_rate === 10000 && sb2.pay_rate === 11500 && !!sb2.price_locked, sb2)
}

// ---------- 枠の役割の単価は、引き継いだ単価より優先する ----------
{
  const P = await newProject('slotrate', { engagement_type: 'spot' })
  const a = await createShift(P, S[0], D(50)); await setManual(a.shift_id, 15000, 11000)
  const slot = must(await admin.post('/api/admin/shift-slots', { project_id: P, work_date: D(48), start_time: '10:00', end_time: '19:00', roles: [{ role_name: '販売スタッフ', headcount: 1, bill_rate: 17000, bill_unit_type: 'daily' }] }), 'slot')
  const roleId = await firstRole(slot.slot_ids[0])
  const as = must(await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [S[1]], force: true }), 'assign')
  const sb = await boardShift(as.shift_ids[0], D(48))
  ok('枠の役割の請求単価（17000）が優先し、支払は前回（11000）を引き継ぐ', sb?.bill_rate === 17000 && sb.pay_rate === 11000, sb)
}

// ---------- 一括登録（常勤） ----------
{
  const P = await newProject('bulk')
  const a = await createShift(P, S[5], D(70)); await setManual(a.shift_id, 12500, 9500)
  const from = D(66), to = D(60)
  const r = must(await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [S[5], S[4]], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: to, start_time: '10:00', end_time: '19:00' }), 'bulk')
  ok('一括登録: 引き継いだ件数（S5 の7日分）と引き継ぎ元', r.created === 14 && r.inherited === 7 && r.inherited_from.length === 1 && r.inherited_from[0].staff_id === S[5] && r.inherited_from[0].work_date === D(70), r)
  const bs = must(await admin.get(`/api/admin/shift-board?from=${from}&to=${to}`), 'board').unslotted.filter(x => x.project_id === P)
  ok('一括登録: 前回のあるスタッフは前回の単価、ないスタッフは単価の設定', bs.filter(x => x.staff_id === S[5]).every(x => x.bill_rate === 12500 && x.pay_rate === 9500)
    && bs.filter(x => x.staff_id === S[4]).every(x => x.bill_rate === 10000) && bs.length === 14, bs.map(x => [x.staff_id, x.bill_rate]))
  const r2 = must(await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [S[5]], weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: D(58), date_to: D(57), start_time: '10:00', end_time: '19:00', inherit: false, price: { bill_rate: 9000 } }), 'bulk2')
  const bs2 = must(await admin.get(`/api/admin/shift-board?from=${D(58)}&to=${D(57)}`), 'board').unslotted.filter(x => x.project_id === P)
  ok('一括登録: inherit: false と単価の変更（請求 9000・手動変更・数量は固定しない）', r2.inherited === 0 && bs2.length === 2 && bs2.every(x => x.bill_rate === 9000 && x.pay_rate === 8000 && x.price_locked && !x.qty_locked), bs2)
}

// ---------- 担当者を替えたとき（常勤）: 新しい担当者の前回で探し直す ----------
{
  const P = await newProject('swap')
  const a = await createShift(P, S[0], D(80)); await setManual(a.shift_id, 12000, 9000)
  const b = await createShift(P, S[1], D(81)); await setManual(b.shift_id, 14000, 10000)
  const c = await createShift(P, S[0], D(78))
  ok('担当替えの前提: S0 の前回を引き継ぐ', c.inherited?.shift_id === a.shift_id)
  must(await admin.put(`/api/admin/shifts/${c.shift_id}`, { staff_id: S[1], force: true }), 'swap')
  const bc = await boardShift(c.shift_id, D(78))
  ok('担当者を替えると、新しい担当者の前回の単価にする', bc?.bill_rate === 14000 && bc.pay_rate === 10000, bc)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
