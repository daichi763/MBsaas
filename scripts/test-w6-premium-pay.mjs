// 深夜・時間外・休日の割増の自動計算と、交通費の標準（w6-premium-pay: #167 #564）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w6-premium-pay.mjs
//   テスト用の案件・スタッフを作り、過去の月曜（D1）と日曜（D0）のシフトで割増を確かめる
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

const PFX = 'W6P' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
// 8日以上前の月曜（D1）と、その前日の日曜（D0）
let D1 = addDays(jstToday(), -8)
while (weekday(D1) !== 1) D1 = addDays(D1, -1)
const D0 = addDays(D1, -1)
const FUT = addDays(jstToday(), 10)

async function newProject(name, pricing) {
  const pid = must(await admin.post('/api/admin/projects', { project_name: name, allow_duplicate: true }), 'project ' + name).project_id
  must(await admin.put(`/api/admin/projects/${pid}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_transport_type: 'actual', bill_transport_type: 'actual', ...pricing }), 'pricing ' + name)
  return pid
}
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: '090' + String(Date.now() % 100000000).padStart(8, '0') }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`).staff_id
}
async function newShift(staff_id, project_id, work_date, start_time, end_time, tag, extra = {}) {
  const memo = `${PFX}-${tag}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, ...extra }), 'shift ' + tag)
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
}
const settleRows = async (staffId) => must(await admin.get(`/api/admin/settlement?from=${D0}&to=${D1}&staff_id=${staffId}`), 'settlement')
const rowOf = async (staffId, shiftId) => (await settleRows(staffId)).rows.find(r => r.shift_id === shiftId)

const hourly = await newProject(`${PFX}-時給`, { pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'scheduled' })
const daily = await newProject(`${PFX}-日給`, { pay_unit_type: 'daily', pay_rate: 9600, default_break_minutes: 60, hours_basis: 'scheduled' })
const sA = await newStaff('A'), sB = await newStaff('B'), sC = await newStaff('C')
const night = await newShift(sA, hourly, D1, '20:00', '00:00', 'night')
const otFirst = await newShift(sB, hourly, D1, '09:00', '15:00', 'ot1')
const otSecond = await newShift(sB, hourly, D1, '16:00', '20:00', 'ot2')
const holiday = await newShift(sB, hourly, D0, '09:00', '19:00', 'hol')
const dailyShift = await newShift(sC, daily, D1, '13:00', '23:00', 'daily')

// ---------- #167 既定（OFF）では割増を計算しない ----------
{
  const r = await rowOf(sA, night.shift_id)
  ok('#167 既定（設定 OFF）では割増なし（支払合計は基本＋交通費）', r && r.pay_premium === 0 && r.premium_night_minutes === null && r.pay_total === 4800, r && { p: r.pay_premium, n: r.premium_night_minutes, t: r.pay_total })
  const st = must(await admin.get('/api/admin/settlement/premium-settings'), 'premium get')
  ok('#167 割増の設定の既定（OFF・深夜25%・時間外25%・休日35%・8時間）', st.settings.enabled === false && st.settings.night_rate === 25 && st.settings.overtime_rate === 25
    && st.settings.holiday_rate === 35 && st.settings.daily_limit_minutes === 480 && st.can_edit === true, st)
}

// ---------- #167 設定の変更（権限・入力の確認） ----------
{
  const body = { enabled: true, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [0], daily_limit_minutes: 480 }
  const m = await mgr.put('/api/admin/settlement/premium-settings', body)
  ok('#167 会社管理者・事務担当以外は割増の設定を変更できない（403）', m.status === 403, m.status)
  const bad = await admin.put('/api/admin/settlement/premium-settings', { ...body, night_rate: 300 })
  ok('#167 割増率が範囲外なら 400', bad.status === 400, bad)
  const bad2 = await admin.put('/api/admin/settlement/premium-settings', { ...body, holiday_weekdays: [7] })
  ok('#167 休日の曜日が範囲外なら 400', bad2.status === 400, bad2)
  const r = must(await admin.put('/api/admin/settlement/premium-settings', body), 'premium put')
  ok('#167 割増の設定を保存できる（日曜を休日）', r.settings.enabled === true && r.settings.holiday_weekdays.join() === '0', r.settings)
}

// ---------- #167 深夜・時間外・休日・日給の計算 ----------
{
  const r = await rowOf(sA, night.shift_id)
  ok('#167 深夜: 20:00〜24:00 の時給1200円は 22時以降の2時間に25%（600円）', r && r.premium_night_minutes === 120 && r.premium_overtime_minutes === 0 && r.pay_premium === 600 && r.pay_total === 5400,
    r && { n: r.premium_night_minutes, o: r.premium_overtime_minutes, p: r.pay_premium, t: r.pay_total })
  const rows = (await settleRows(sB)).rows
  const a = rows.find(x => x.shift_id === otFirst.shift_id), b = rows.find(x => x.shift_id === otSecond.shift_id)
  ok('#167 時間外: 同じ日の2つのシフトの合計10時間のうち、8時間を超えた2時間を後のシフトに付ける', a && b && a.premium_overtime_minutes === 0 && a.pay_premium === 0
    && b.premium_overtime_minutes === 120 && b.pay_premium === 600, { a: a && [a.premium_overtime_minutes, a.pay_premium], b: b && [b.premium_overtime_minutes, b.pay_premium] })
  const h = rows.find(x => x.shift_id === holiday.shift_id)
  ok('#167 休日: 日曜の10時間はすべて休日の割増（35%）で、時間外は付けない', h && h.premium_holiday_minutes === 600 && h.premium_overtime_minutes === 0 && h.pay_premium === 4200,
    h && [h.premium_holiday_minutes, h.premium_overtime_minutes, h.pay_premium])
  const d = await rowOf(sC, dailyShift.shift_id)
  // 日給9600円・予定の実働9時間 → 1時間あたり1066.67円。深夜1時間（22〜23時）と時間外1時間（9時間−8時間）に25%ずつ → 533円
  ok('#167 日給: 単価を予定の実働時間で割った額を基準に、深夜1時間・時間外1時間の割増（533円）', d && d.premium_night_minutes === 60 && d.premium_overtime_minutes === 60 && d.pay_premium === 533 && d.pay_total === 9600 + 533,
    d && [d.premium_night_minutes, d.premium_overtime_minutes, d.pay_premium, d.pay_total])
  const s = await settleRows(sB)
  const g = s.by_payee.find(x => x.staff_id === sB)
  ok('#167 支払の集計に深夜・時間外・休日の時間と割増額を出す', g && g.overtime_hours === 2 && g.holiday_hours === 10 && g.pay_premium === 4800 && g.pay_total === 1200 * 20 + 4800, g)
  // 実績を入れると計算し直す（深夜の時間が延びる）
  must(await admin.put(`/api/admin/shifts/${night.shift_id}/actual`, { actual_start: '20:00', actual_end: '01:00', actual_break_minutes: 0 }), 'actual')
  const pj = must(await admin.put(`/api/admin/projects/${hourly}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'actual', pay_transport_type: 'actual', bill_transport_type: 'actual' }), 'basis actual')
  must(await admin.post('/api/admin/settlement/recalc', { shift_ids: [night.shift_id] }), 'recalc')
  const r2 = await rowOf(sA, night.shift_id)
  ok('#167 実績（20:00〜25:00）に合わせて深夜3時間で計算し直す', pj && r2 && r2.premium_night_minutes === 180 && r2.pay_premium === 900, r2 && [r2.premium_night_minutes, r2.pay_premium, r2.pay_base])
}

// ---------- #167 CSV ----------
{
  const csvRes = await admin.get(`/api/admin/settlement/export?kind=payment&from=${D0}&to=${D1}&staff_id=${sB}`)
  const lines = csvRes.text.replace(/^﻿/, '').split(/\r?\n/)
  ok('#167 支払集計の CSV の末尾に、深夜時間・時間外時間・休日時間・割増額の列を足す（既存の列の位置は変えない）', /スタッフID,深夜時間,時間外時間,休日時間,割増額$/.test(lines[0]) && /,0,2,10,4800$/.test(lines[1]), lines.slice(0, 2))
  const det = await admin.get(`/api/admin/settlement/export?kind=detail&from=${D0}&to=${D1}&staff_id=${sA}`)
  const dl = det.text.replace(/^﻿/, '').split(/\r?\n/)
  ok('#167 シフト明細の CSV にも深夜・時間外・休日の時間と割増額を出す', /割増額$/.test(dl[0]) && /,3,0,0,900$/.test(dl[1]), dl.slice(0, 2))
}

// ---------- #167 確定で固定し、取り消すと計算し直す ----------
{
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [night.shift_id], force: true }), 'confirm')
  must(await admin.put('/api/admin/settlement/premium-settings', { enabled: true, night_rate: 50, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [0], daily_limit_minutes: 480 }), 'rate 50')
  const r = await rowOf(sA, night.shift_id)
  ok('#167 確定済みのシフトは確定したときの割増のまま（率を変えても変わらない）', r && r.settle_status === 'confirmed' && r.pay_premium === 900 && r.premium_night_minutes === 180, r && [r.settle_status, r.pay_premium])
  const html = await admin.get(`/api/admin/settlement/statement?kind=payment&group=${encodeURIComponent('payroll:staff' + sA)}&from=${D0}&to=${D1}`)
  ok('#167 支払明細書に割増の列と内訳を出す', html.status === 200 && html.text.includes('<th>割増</th>') && html.text.includes('深夜3h'), html.status)
  must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [night.shift_id] }), 'unconfirm')
  const r2 = await rowOf(sA, night.shift_id)
  ok('#167 確定を取り消すと今の設定で計算し直す（深夜50% → 1800円）', r2 && r2.settle_status === 'planned' && r2.pay_premium === 1800, r2 && [r2.settle_status, r2.pay_premium])
  must(await admin.put('/api/admin/settlement/premium-settings', { enabled: false, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [0], daily_limit_minutes: 480 }), 'off')
  const r3 = await rowOf(sA, night.shift_id)
  ok('#167 設定を OFF にすると未確定のシフトの割増はなくなる', r3 && r3.pay_premium === 0 && r3.premium_night_minutes === null, r3 && r3.pay_premium)
}

// ---------- #167 スタッフアプリの支払額 ----------
{
  must(await admin.put('/api/admin/settlement/premium-settings', { enabled: true, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [0], daily_limit_minutes: 480 }), 'on again')
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: true }), 'visible on')
  const me = client(await login('sample', `${PFX}A`))
  const d = must(await me.get(`/api/staff/pay?month=${D1.slice(0, 7)}`), 'staff pay')
  const s = d.shifts.find(x => x.shift_id === night.shift_id)
  ok('#167 スタッフの支払額にも割増を含める（内訳 premium）', s && s.pay && s.pay.premium === 900 && s.pay.total === s.pay.base + s.pay.transport + s.pay.adjust + 900, s && s.pay)
  must(await admin.put('/api/admin/staff-pay/settings', { staff_pay_visible: false }), 'visible off')
}

// ---------- #564 交通費の標準 ----------
const site = { site_id: must(await admin.post('/api/admin/sites', { site_name: `${PFX}会場` }), 'site').site_id }
{
  const bad = await admin.put('/api/admin/transport-defaults', { staff_id: sA, site_id: 0, amount: -1 })
  ok('#564 マイナスの金額は 400', bad.status === 400, bad)
  const nf = await admin.put('/api/admin/transport-defaults', { staff_id: 99999999, site_id: 0, amount: 100 })
  ok('#564 ほかの会社・存在しないスタッフは 404', nf.status === 404, nf.status)
  must(await admin.put('/api/admin/transport-defaults', { staff_id: sA, site_id: 0, amount: 800, note: '自宅〜会場' }), 'td all')
  must(await admin.put('/api/admin/transport-defaults', { staff_id: sA, site_id: site.site_id, amount: 1200 }), 'td site')
  must(await admin.put('/api/admin/transport-defaults', { staff_id: sA, site_id: 0, amount: 820 }), 'td update')
  const l = must(await admin.get('/api/admin/transport-defaults'), 'td list')
  const mine = l.defaults.filter(x => x.staff_id === sA)
  ok('#564 スタッフ × 開催場所ごとに1つ（同じ組み合わせは置き換える）', mine.length === 2 && mine.find(x => x.site_id === 0).amount === 820 && mine.find(x => x.site_id === site.site_id).amount === 1200, mine)
  ok('#564 一覧に登録の候補（スタッフ・開催場所）を返す', l.staff.some(x => x.staff_id === sA) && l.sites.some(x => x.site_id === site.site_id))
}
{
  // シフトボードの割り当て（入力なし → 標準。開催場所の標準を優先）
  must(await admin.post('/api/admin/shift-slots', { project_id: hourly, dates: [FUT], start_time: '10:00', end_time: '15:00', site_id: site.site_id, roles: [{ role_name: `${PFX}販売`, headcount: 3 }] }), 'slot')
  const board = must(await admin.get(`/api/admin/shift-board?from=${FUT}&to=${FUT}`), 'board')
  const slot = board.slots.filter(s => s.project_id === hourly && s.start_time === '10:00').pop()
  const roleId = slot.roles[0].slot_role_id
  const cands = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${roleId}`), 'cands').candidates
  ok('#564 候補の一覧に交通費の標準を出す（開催場所の標準 1200円）', cands.find(x => x.staff_id === sA)?.transport_default === 1200 && cands.find(x => x.staff_id === sB)?.transport_default === null,
    cands.filter(x => [sA, sB].includes(x.staff_id)))
  must(await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [sA, sB], force: true }), 'assign')
  const shifts = must(await admin.get(`/api/admin/shifts?from=${FUT}&to=${FUT}`), 'shifts').shifts
  const a = shifts.find(x => x.staff_id === sA && x.slot_role_id === roleId), b = shifts.find(x => x.staff_id === sB && x.slot_role_id === roleId)
  ok('#564 割り当てで交通費の入力がなければ、スタッフの標準（開催場所の標準）を入れ、標準のない人は 0', a && b && a.transportation_fee === 1200 && b.transportation_fee === 0, [a?.transportation_fee, b?.transportation_fee])
  // 入力したときは全員にその金額
  must(await admin.post('/api/admin/shift-slots', { project_id: hourly, dates: [FUT], start_time: '16:00', end_time: '18:00', roles: [{ role_name: `${PFX}販売2`, headcount: 2 }] }), 'slot2')
  const b2 = must(await admin.get(`/api/admin/shift-board?from=${FUT}&to=${FUT}`), 'board2')
  const role2 = b2.slots.filter(s => s.project_id === hourly && s.start_time === '16:00').pop().roles[0].slot_role_id
  must(await admin.post(`/api/admin/shift-slots/roles/${role2}/assign`, { staff_ids: [sA, sC], transportation_fee: 500, force: true }), 'assign fee')
  const s2 = must(await admin.get(`/api/admin/shifts?from=${FUT}&to=${FUT}`), 'shifts2').shifts.filter(x => x.slot_role_id === role2)
  ok('#564 交通費を入力したときは、選んだ全員にその金額を入れる', s2.length === 2 && s2.every(x => x.transportation_fee === 500), s2.map(x => x.transportation_fee))
}
{
  // 一括登録（開催場所なし → スタッフの標準 820円）
  const from = addDays(FUT, 7)
  const r = must(await admin.post('/api/admin/shifts/bulk', { project_id: hourly, staff_ids: [sA, sB], weekdays: [weekday(from)], date_from: from, date_to: from, start_time: '06:00', end_time: '08:00', role: `${PFX}一括`, transportation_fee: '' }), 'bulk')
  const s = must(await admin.get(`/api/admin/shifts?from=${from}&to=${from}`), 'bulk shifts').shifts.filter(x => x.role === `${PFX}一括`)
  ok('#564 一括登録で交通費が空欄なら、スタッフの標準を入れる', r.created === 2 && s.find(x => x.staff_id === sA)?.transportation_fee === 820 && s.find(x => x.staff_id === sB)?.transportation_fee === 0, s.map(x => [x.staff_id, x.transportation_fee]))
}
{
  // 精算: 表示中の未確定シフトの交通費（実費 0 円）を標準で埋める
  const zero = await newShift(sA, hourly, D0, '06:00', '07:00', 'fill0')
  const paid = await newShift(sA, hourly, D0, '07:30', '08:00', 'fill1', { transportation_fee: 300 })
  const dry = must(await admin.post('/api/admin/settlement/transport-fill', { shift_ids: [zero.shift_id, paid.shift_id, night.shift_id], dry_run: true }), 'fill dry')
  ok('#564 交通費を埋める対象は、未確定で実費が 0 円・標準のあるシフトだけ（dry_run）', dry.count === 2 && dry.total === 1640, dry)
  must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [night.shift_id], force: true }), 'confirm night')
  const run = must(await admin.post('/api/admin/settlement/transport-fill', { shift_ids: [zero.shift_id, paid.shift_id, night.shift_id] }), 'fill')
  const rows = (await settleRows(sA)).rows
  ok('#564 標準で埋め、入力済みの交通費と確定済みのシフトは変えない', run.updated === 1 && rows.find(x => x.shift_id === zero.shift_id).transportation_fee === 820
    && rows.find(x => x.shift_id === paid.shift_id).transportation_fee === 300 && rows.find(x => x.shift_id === night.shift_id).transportation_fee === 0,
    { run, f: rows.filter(x => [zero.shift_id, paid.shift_id, night.shift_id].includes(x.shift_id)).map(x => [x.shift_id, x.transportation_fee, x.price_locked]) })
  ok('#564 交通費を埋めても手動変更（price_locked）にしない', rows.find(x => x.shift_id === zero.shift_id).price_locked === false)
  must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [night.shift_id] }), 'unconfirm night')
}
{
  // 募集の承認（既存スタッフ）: 標準を入れる
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [hourly], date_from: jstToday(), date_to: addDays(FUT, 20), allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'page')
  const day = addDays(FUT, 2)
  must(await admin.post('/api/admin/shift-slots', { project_id: hourly, dates: [day], start_time: '11:00', end_time: '13:00', roles: [{ role_name: `${PFX}募集`, headcount: 2 }] }), 'slot r')
  const b = must(await admin.get(`/api/admin/shift-board?from=${day}&to=${day}`), 'board r')
  const rid = b.slots.filter(s => s.project_id === hourly && s.start_time === '11:00').pop().roles[0].slot_role_id
  const pub = client(null)
  const phone = '070' + String((Date.now() * 7) % 100000000).padStart(8, '0')
  must(await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 応募`, phone, agree: true, slot_role_ids: [rid], issued_at: Date.now() - 10000 }), 'apply')
  const app = must(await admin.get('/api/admin/recruit-applications?' + new URLSearchParams({ status: 'pending', q: `${PFX} 応募` })), 'apps').applications[0]
  const dec = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), staff_id: sA, force: true }), 'decide')
  const s = must(await admin.get(`/api/admin/shifts?from=${day}&to=${day}`), 'shifts r').shifts.find(x => x.slot_role_id === rid && x.staff_id === sA)
  ok('#564 募集の承認で作るシフトに、スタッフの交通費の標準を入れる（0円固定にしない）', dec.created_shifts === 1 && s && s.transportation_fee === 820, { dec, fee: s?.transportation_fee })
}
{
  const l = must(await admin.get('/api/admin/transport-defaults'), 'td list').defaults.filter(x => x.staff_id === sA)
  const del = must(await admin.del(`/api/admin/transport-defaults/${l[0].default_id}`), 'td del')
  const again = await admin.del(`/api/admin/transport-defaults/${l[0].default_id}`)
  ok('#564 交通費の標準を削除できる（2回目は 404）', del.ok && again.status === 404, again.status)
}
must(await admin.put('/api/admin/settlement/premium-settings', { enabled: false, night_rate: 25, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [], daily_limit_minutes: 480 }), 'reset')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
