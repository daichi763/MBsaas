// シフト・精算の操作履歴（w6-audit-log: #159）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w6-audit-log.mjs
//   精算の確定・取り消しは過去の日付（2019年3月）のシフトで行う（ほかのテストの日付と重ならないように）
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
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

const PFX = 'W6A' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const me = must(await admin.get('/api/auth/me'), 'me')
const myId = Number(me.user?.user_id ?? me.user_id)

must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const P = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: phone(n), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const A = await newStaff(1), B = await newStaff(2)
const logsOf = async (entity, id, extra = '') => must(await admin.get(`/api/admin/operation-logs?entity=${entity}&entity_id=${id}${extra}`), 'logs')
const change = (log, field) => log?.changes?.find(c => c.field === field)

// ---------- シフトの登録・変更・削除 ----------
const D = '2019-03-05'
const s1 = must(await admin.post('/api/admin/shifts', { staff_id: A, project_id: P, work_date: D, start_time: '10:00', end_time: '19:00', unit_price: 15000 }), 'shift').shift_id
{
  const d = await logsOf('shift', s1)
  const l = d.logs[0]
  ok('登録の履歴が残る（操作した人・日時・登録した値）', d.logs.length === 1 && l.action === 'create' && l.actor_name && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(l.created_at)
    && change(l, 'start_time')?.after === '10:00' && change(l, 'staff_id')?.after === A && change(l, 'start_time')?.before === null, d)
  ok('値の ID を名前にして返す（スタッフ・案件）', String(d.names.staff[A] || '').includes(PFX) && String(d.names.project[P] || '').includes(PFX), d.names)
  ok('項目の名前と操作の名前を返す', change(l, 'start_time')?.label === '開始' && l.action_label === '登録', l)
}
must(await admin.put(`/api/admin/shifts/${s1}`, { start_time: '11:00', memo: '時間を変更' }), 'update')
{
  const d = await logsOf('shift', s1)
  const l = d.logs[0]
  ok('変更の履歴に前後の値が残る（開始 10:00 → 11:00、メモ）', l.action === 'update' && change(l, 'start_time')?.before === '10:00' && change(l, 'start_time')?.after === '11:00'
    && change(l, 'memo')?.after === '時間を変更', l)
  ok('変わっていない項目は変更に出さない', !change(l, 'end_time') && !change(l, 'staff_id') && !change(l, 'work_date'), l.changes.map(c => c.field))
}
must(await admin.put(`/api/admin/shifts/${s1}`, { memo: '時間を変更' }), 'update same')
ok('値が変わらない保存では履歴を残さない', (await logsOf('shift', s1)).logs.length === 2)
must(await admin.put(`/api/admin/shifts/${s1}`, { staff_id: B, force: true }), 'replace staff')
{
  const l = (await logsOf('shift', s1)).logs[0]
  ok('スタッフの差し替えが前後のスタッフ付きで残る', change(l, 'staff_id')?.before === A && change(l, 'staff_id')?.after === B && l.staff_id === B, l)
  const byA = must(await admin.get(`/api/admin/operation-logs?staff_id=${A}`), 'by staff')
  ok('担当スタッフで絞り込める', byA.logs.every(x => x.staff_id === A), byA.logs.map(x => x.staff_id))
}

// ---------- 金額・実績の変更、精算の確定と取り消し ----------
must(await admin.put(`/api/admin/shifts/${s1}/price`, { bill_rate: 20000 }), 'price')
{
  const l = (await logsOf('shift', s1)).logs[0]
  ok('金額の手動変更の履歴（請求単価 15000 → 20000）', l.action === 'price' && change(l, 'bill_rate')?.after === 20000 && change(l, 'bill_rate')?.before !== 20000, l)
}
must(await admin.put(`/api/admin/shifts/${s1}/actual`, { actual_start: '11:05', actual_end: '19:10', actual_break_minutes: 60 }), 'actual')
{
  const l = (await logsOf('shift', s1)).logs[0]
  ok('実績の入力の履歴', l.action === 'actual' && change(l, 'actual_start')?.after === '11:05' && change(l, 'actual_source')?.after === 'manual', l)
}
must(await admin.post('/api/admin/settlement/confirm', { shift_ids: [s1], force: true }), 'confirm')
{
  const d = await logsOf('shift', s1)
  const l = d.logs[0]
  ok('精算の確定の履歴（だれが確定したか）', l.action === 'settle_confirm' && change(l, 'settle_status')?.after === 'confirmed' && change(l, 'settled_by')?.after === myId, l)
  ok('確定した人の名前を返す', !!d.names.user[myId], d.names)
}
must(await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [s1] }), 'unconfirm')
{
  const d = await logsOf('shift', s1)
  const l = d.logs[0]
  ok('確定の取り消しの履歴に、取り消す前の確定日時・確定した人が残る', l.action === 'settle_unconfirm' && change(l, 'settled_by')?.before === myId && !!change(l, 'settled_at')?.before
    && change(l, 'settled_by')?.after === null && change(l, 'settle_status')?.after === 'planned', l)
  const ops = d.logs.map(x => x.action)
  ok('1件のシフトの履歴を新しい順に返す', JSON.stringify(ops.slice(0, 5)) === JSON.stringify(['settle_unconfirm', 'settle_confirm', 'actual', 'price', 'update']), ops)
}

// ---------- 欠勤のキャンセル料 ----------
const s2 = must(await admin.post('/api/admin/shifts', { staff_id: A, project_id: P, work_date: '2019-03-06', start_time: '10:00', end_time: '19:00', unit_price: 15000 }), 'shift2').shift_id
must(await admin.put(`/api/admin/shifts/${s2}`, { status: 'absent' }), 'absent')
must(await admin.put(`/api/admin/settlement/cancellations/${s2}`, { reason: 'client', notified_on: '2019-03-06', bill_amount: 7500, pay_amount: 3000 }), 'cancellation')
{
  const l = (await logsOf('shift', s2)).logs[0]
  ok('キャンセル料・補償の入力の履歴', l.action === 'cancellation' && change(l, 'cancel_bill')?.after === 7500 && change(l, 'cancel_reason')?.after === 'client', l)
}

// ---------- 削除 ----------
const s3 = must(await admin.post('/api/admin/shifts', { staff_id: A, project_id: P, work_date: '2019-03-07', start_time: '10:00', end_time: '19:00' }), 'shift3').shift_id
must(await admin.del(`/api/admin/shifts/${s3}`), 'delete')
{
  const l = (await logsOf('shift', s3)).logs[0]
  ok('削除の履歴に削除の前の値が残る（行が消えても見られる）', l.action === 'delete' && change(l, 'work_date')?.before === '2019-03-07' && change(l, 'work_date')?.after === null && l.summary.work_date === '2019-03-07', l)
}

// ---------- 募集枠の変更と割り当て ----------
{
  const SD = addDays(jstToday, 20)
  const slotId = must(await admin.post('/api/admin/shift-slots', { project_id: P, dates: [SD], start_time: '10:00', end_time: '19:00', break_minutes: 60, roles: [{ role_name: '販売', headcount: 2 }] }), 'slot').slot_ids[0]
  const sl = must(await admin.get(`/api/admin/shift-slots/${slotId}`), 'slot get')
  const [sh] = must(await admin.post(`/api/admin/shift-slots/roles/${sl.roles[0].slot_role_id}/assign`, { staff_ids: [A], force: true }), 'assign').shift_ids
  const la = (await logsOf('shift', sh)).logs[0]
  ok('枠への割り当ての履歴', la?.action === 'assign' && change(la, 'slot_role_id')?.after === sl.roles[0].slot_role_id, la)
  must(await admin.put(`/api/admin/shift-slots/${slotId}`, {
    site_id: sl.slot.site_id, location: sl.slot.location, work_date: SD, start_time: '12:00', end_time: '19:00', break_minutes: 60, memo: sl.slot.memo,
    roles: sl.roles.map(r => ({ slot_role_id: r.slot_role_id, role_name: r.role_name, headcount: 3 })), force: true,
  }), 'slot update')
  const ls = (await logsOf('slot', slotId)).logs[0]
  ok('枠の変更の履歴（時間と役割の人数）', ls?.action === 'slot_update' && change(ls, 'start_time')?.before === '10:00' && change(ls, 'start_time')?.after === '12:00'
    && change(ls, 'roles')?.before?.[0]?.headcount === 2 && change(ls, 'roles')?.after?.[0]?.headcount === 3, ls)
  const lsh = (await logsOf('shift', sh)).logs[0]
  ok('枠の変更で動いたシフトにも同じ操作の履歴が残る', lsh?.action === 'slot_update' && lsh.op_key === ls.op_key && change(lsh, 'start_time')?.after === '12:00', lsh)
}

// ---------- 一覧の条件・ページ送り ----------
{
  let r = await admin.get('/api/admin/operation-logs?entity=foo')
  ok('対象の種類が正しくなければ 400', r.status === 400, r.status)
  r = await admin.get(`/api/admin/operation-logs?entity_id=${s1}`)
  ok('entity_id だけの指定は 400', r.status === 400, r.status)
  r = await admin.get('/api/admin/operation-logs?action=bad')
  ok('操作の種類が正しくなければ 400', r.status === 400, r.status)
  r = await admin.get('/api/admin/operation-logs?from=2019/01/01')
  ok('日付の形式が正しくなければ 400', r.status === 400, r.status)
  const all = must(await admin.get(`/api/admin/operation-logs?from=${jstToday}&to=${jstToday}`), 'today')
  ok('操作した日で絞り込める', all.logs.length > 0 && all.logs.every(l => l.created_at.slice(0, 10) === jstToday), all.logs.length)
  const first = all.logs[0].log_id
  const next = must(await admin.get(`/api/admin/operation-logs?before=${first}`), 'before')
  ok('before で前のページを取れる', next.logs.every(l => l.log_id < first), next.logs.slice(0, 3).map(l => l.log_id))
  const conf = must(await admin.get('/api/admin/operation-logs?action=settle_confirm'), 'by action')
  ok('操作の種類で絞り込める', conf.logs.length > 0 && conf.logs.every(l => l.action === 'settle_confirm'), conf.logs.length)
  const none = must(await admin.get('/api/admin/operation-logs?entity=shift&entity_id=999999999'), 'none')
  ok('無い対象の履歴は空', none.logs.length === 0 && none.has_more === false, none)
  const staff = client(await login('sample', 'st001'))
  r = await staff.get(`/api/admin/operation-logs?entity=shift&entity_id=${s1}`)
  ok('スタッフは操作履歴を見られない', r.status === 401 || r.status === 403, r.status)
}

// ---------- 保存期間・解約企業の削除の対象 ----------
{
  const r = await hq.get('/api/hq/offboarding/1')
  const t = (r.data?.tables || []).find(x => x.target === 'operation_logs')
  ok('解約企業の書き出し・削除の対象に操作履歴が入っている（未対応の表なし）', r.status === 200 && t && t.count > 0 && Array.isArray(r.data?.unknown_tables) && !r.data.unknown_tables.includes('operation_logs'), { t, unknown: r.data?.unknown_tables })
  const dr = await hq.post('/api/hq/retention/dry-run', {})
  const x = (dr.data?.results || []).find(y => y.target === 'operation_logs')
  ok('定期削除（dry-run）に操作履歴（7年）が入り、失敗しない', dr.status === 200 && x && !x.failedCount, x)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
