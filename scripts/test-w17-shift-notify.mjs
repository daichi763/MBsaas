// シフトの確定・削除の通知の切り替え（w17-shift-notify: #9906。利用者の決定 Sprint 17）の統合テスト
// - 会社の設定（GET/PUT /api/admin/settings/shift-notify。既定は「送る」。変えられるのは会社管理者だけ）
// - 操作ごとの notify（true / false）と notify_message（150文字まで）。省略すると会社の設定に従う
// - 送らないときはアプリ内の通知・メールを作らず、操作履歴に「通知なし」（notify_off）と残す
// - シフト以外の通知（日報へのコメント）は会社の設定によらず送る。スタッフ本人の受け取り設定（シフトのメール）は今までどおり効く
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8810 --persist-to <保存先> で起動していること（MAIL_ENABLED は既定の false のまま）。
//   メールは送らずに email_logs に『skipped』で記録されるので、送ろうとしたメールの宛先はメールの送信記録で確かめる。
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w17-shift-notify.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
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
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p, b) => call('DELETE', p, b) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'SN' + Date.now().toString(36).slice(-4).toUpperCase()
const tag = PFX.toLowerCase()

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))

async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
let phoneSeq = 0
async function newStaff(k) {
  const phone = '080' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone, email: `${tag}-${k.toLowerCase()}@example.com` }), 'staff ' + k)
  const s = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}${k}`)
  return { ...s, api: client(await login('sample', `${PFX}${k}`)) }
}
const notifs = async (st, kind) => (must(await st.api.get('/api/staff/notifications' + (kind ? `?kind=${kind}` : '')), 'notifs').notifications)
const shiftNotifs = async (st) => (await notifs(st)).filter(n => /^shift_/.test(n.kind))
const mailTo = async (who) => (must(await admin.get('/api/admin/email-logs?type=shift_change'), 'email logs').logs).filter(l => l.to_email === `${tag}-${who}@example.com`)
const opLogs = async (shiftId) => (must(await admin.get(`/api/admin/operation-logs?entity=shift&entity_id=${shiftId}`), 'op logs').logs)
async function newSlot(p, date, start = '10:00', end = '18:00', headcount = 3) {
  must(await admin.post('/api/admin/shift-slots', { project_id: p, dates: [date], start_time: start, end_time: end, roles: [{ role_name: '販売', headcount }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  return b.slots.filter(s => s.project_id === p && s.start_time === start).pop()
}

const pid = await newProject(`${PFX}-案件`)
const A = await newStaff('A'), B = await newStaff('B'), C = await newStaff('C')
const T1 = addDays(today, 1)

// ---------- 会社の設定 ----------
{
  const s = must(await admin.get('/api/admin/settings/shift-notify'), 'setting')
  ok('#9906 会社の設定の既定は「送る」（今までと同じ）。会社管理者は変えられる', s.enabled === true && s.can_edit === true && s.updated_at === null, s)
  const m = must(await mgr.get('/api/admin/settings/shift-notify'), 'setting mgr')
  ok('#9906 現場管理者は会社の設定を見られるが、変えられない（can_edit: false）', m.enabled === true && m.can_edit === false, m)
  const mp = await mgr.put('/api/admin/settings/shift-notify', { enabled: false })
  ok('#9906 会社管理者でない人が会社の設定を変えようとすると 403', mp.status === 403, mp)
  const bad = await admin.put('/api/admin/settings/shift-notify', { enabled: 'no' })
  ok('#9906 会社の設定の値が真偽値でなければ 400', bad.status === 400, bad)
}

// ---------- 1件の登録・変更・削除（POST/PUT/DELETE /admin/shifts） ----------
{
  const base = { staff_id: A.staff_id, project_id: pid, work_date: T1, start_time: '10:00', end_time: '19:00' }
  const long = await admin.post('/api/admin/shifts', { ...base, notify: true, notify_message: 'あ'.repeat(151) })
  const badN = await admin.post('/api/admin/shifts', { ...base, notify: 'maybe' })
  const shiftsAfter = must(await admin.get(`/api/admin/shift-board?from=${T1}&to=${T1}`), 'board').unslotted.filter(x => x.staff_id === A.staff_id)
  ok('#9906 メッセージが150文字を超える・notify の値が正しくないときは 400 で、シフトを作らない', long.status === 400 && /150文字/.test(long.data?.error || '') && badN.status === 400 && shiftsAfter.length === 0, { long, badN, shiftsAfter })

  const r = must(await admin.post('/api/admin/shifts', { ...base, notify: false }), 'add silent')
  await sleep(800)
  ok('#9906 notify: false で登録すると、アプリ内の通知もメールも作らない', (await shiftNotifs(A)).length === 0 && (await mailTo('a')).length === 0)
  const l1 = await opLogs(r.shift_id)
  ok('#9906 notify: false の登録は、操作履歴に「通知なし」（notify_off）と残る', l1.length === 1 && l1[0].action === 'create' && l1[0].notify_off === true, l1)

  must(await admin.put(`/api/admin/shifts/${r.shift_id}`, { start_time: '11:00', end_time: '20:00', notify: true, notify_message: '集合場所が変わりました。\r\n裏口から入ってください' }), 'time change notify')
  const n = await notifs(A, 'shift_changed')
  ok('#9906 notify: true とメッセージで変更すると、通知の本文の先頭にメッセージを添える（改行は残す）', n.length === 1 && n[0].body.startsWith('管理者からのメッセージ: 集合場所が変わりました。\n裏口から入ってください\n\n【変更】') && n[0].body.includes('10:00〜19:00 → 11:00〜20:00'), n)
  let mails = []
  for (let i = 0; i < 10 && !mails.length; i++) { mails = await mailTo('a'); if (!mails.length) await sleep(300) }
  ok('#9906 送るときは今までどおり、明日のシフトの変更のメールも送る', mails.length === 1, mails)
  const l2 = (await opLogs(r.shift_id)).find(x => x.action === 'update')
  ok('#9906 送った操作の履歴は「通知なし」にしない', l2 && l2.notify_off === false, l2)

  must(await admin.put(`/api/admin/shifts/${r.shift_id}`, { status: 'absent', cancel_reason: 'staff', notify: false }), 'absent silent')
  ok('#9906 notify: false で欠勤にすると、通知を作らない', (await notifs(A, 'shift_changed')).length === 1)
  const l3 = (await opLogs(r.shift_id)).filter(x => x.action === 'update')
  ok('#9906 欠勤にした操作も「通知なし」と残る', l3.length === 2 && l3[0].notify_off === true, l3)

  // 削除（本文で受け取る）
  const r2 = must(await admin.post('/api/admin/shifts', { ...base, work_date: addDays(today, 2), notify: false }), 'add 2')
  const del = await admin.del(`/api/admin/shifts/${r2.shift_id}`, { notify: false })
  ok('#9906 削除（本文の notify: false）は取消の通知を作らない', del.status === 200 && (await notifs(A, 'shift_cancelled')).length === 0, del)
  const l4 = (await opLogs(r2.shift_id)).find(x => x.action === 'delete')
  ok('#9906 削除した後も、削除の履歴に「通知なし」と残る', l4 && l4.notify_off === true, l4)
  // 削除（クエリで受け取る）
  const r3 = must(await admin.post('/api/admin/shifts', { ...base, work_date: addDays(today, 3), notify: false }), 'add 3')
  const del2 = await admin.del(`/api/admin/shifts/${r3.shift_id}?notify=0`)
  ok('#9906 削除はクエリ（?notify=0）でも受け取る', del2.status === 200 && (await notifs(A, 'shift_cancelled')).length === 0, del2)
  const r4 = must(await admin.post('/api/admin/shifts', { ...base, work_date: addDays(today, 4), notify: false }), 'add 4')
  must(await admin.del(`/api/admin/shifts/${r4.shift_id}`, { notify: true, notify_message: '現場が中止になりました' }), 'delete notify')
  const cn = await notifs(A, 'shift_cancelled')
  ok('#9906 削除で notify: true なら、取消の通知にメッセージを添える', cn.length === 1 && cn[0].body.startsWith('管理者からのメッセージ: 現場が中止になりました'), cn)
}

// ---------- シフト管理（枠への割り当て・まとめて保存・移動・まとめて確定・まとめて削除・枠の変更） ----------
{
  const before = (await shiftNotifs(B)).length
  const D = addDays(today, 10)
  const slot = await newSlot(pid, D)
  const rid = slot.roles[0].slot_role_id
  const a1 = must(await admin.post(`/api/admin/shift-slots/roles/${rid}/assign`, { staff_ids: [B.staff_id], force: true, notify: false }), 'assign silent')
  ok('#9906 枠への割り当て（notify: false）は通知を作らず、履歴に「通知なし」', (await shiftNotifs(B)).length === before && (await opLogs(a1.shift_ids[0]))[0]?.notify_off === true)

  const slot2 = await newSlot(pid, addDays(today, 11))
  const ab = must(await admin.post('/api/admin/shift-slots/assign-batch', { items: [{ slot_role_id: slot2.roles[0].slot_role_id, staff_id: B.staff_id, force: true }], notify: false }), 'assign-batch silent')
  const bid = ab.created[0]?.shift_id
  ok('#9906 まとめて保存（assign-batch。notify: false）は通知を作らず、履歴に「通知なし」', !!bid && (await shiftNotifs(B)).length === before && (await opLogs(bid))[0]?.notify_off === true, ab)

  const slot3 = await newSlot(pid, addDays(today, 12), '12:00', '20:00')
  must(await admin.post(`/api/admin/shifts/${bid}/move`, { slot_role_id: slot3.roles[0].slot_role_id, force: true, notify: false }), 'move silent')
  ok('#9906 移動（notify: false）は通知を作らない', (await shiftNotifs(B)).length === before && (await opLogs(bid)).find(x => x.action === 'move')?.notify_off === true)

  must(await admin.put(`/api/admin/shift-slots/${slot.slot_id}`, { start_time: '09:00', end_time: '17:00', force: true, notify: false }), 'slot edit silent')
  ok('#9906 枠の時間の変更（notify: false）は、枠に入っている人に通知を作らない', (await shiftNotifs(B)).length === before)
  must(await admin.put(`/api/admin/shift-slots/${slot.slot_id}`, { start_time: '09:30', end_time: '17:30', force: true, notify: true, notify_message: '開始を30分遅らせます' }), 'slot edit notify')
  const sc = (await notifs(B, 'shift_changed')).filter(x => x.related_id === a1.shift_ids[0])
  ok('#9906 枠の時間の変更（notify: true）は、メッセージを添えて知らせる', sc.length === 1 && sc[0].body.startsWith('管理者からのメッセージ: 開始を30分遅らせます') && sc[0].body.includes('09:00〜17:00 → 09:30〜17:30'), sc)

  const slot4 = await newSlot(pid, addDays(today, 13))
  const rq = must(await admin.post(`/api/admin/shift-slots/roles/${slot4.roles[0].slot_role_id}/assign`, { staff_ids: [C.staff_id], status: 'requested', force: true, notify: false }), 'requested silent')
  must(await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: rq.shift_ids, force: true, notify: false }), 'confirm silent')
  ok('#9906 希望（仮）のまとめて確定（notify: false）は通知を作らない', (await shiftNotifs(C)).length === 0 && (await opLogs(rq.shift_ids[0])).find(x => x.action === 'confirm_requested')?.notify_off === true)

  const bd = must(await admin.post('/api/admin/shifts/bulk-delete', { shift_ids: [bid], notify: false }), 'bulk-delete silent')
  ok('#9906 シフトのまとめて削除（notify: false）は取消の通知を作らず、削除の履歴に「通知なし」', bd.deleted === 1 && (await shiftNotifs(B)).length === before + 1 && (await opLogs(bid)).find(x => x.action === 'delete')?.notify_off === true, bd)

  const sd = must(await admin.post('/api/admin/shift-slots/bulk-delete', { slot_ids: [slot4.slot_id], force: true, delete_shifts: true, notify: false }), 'slot bulk-delete silent')
  ok('#9906 枠のまとめて削除（シフトも削除。notify: false）は取消の通知を作らない', sd.deleted_shifts === 1 && (await shiftNotifs(C)).length === 0, sd)

  const msg = await admin.post(`/api/admin/shift-slots/roles/${rid}/assign`, { staff_ids: [C.staff_id], force: true, notify_message: 123 })
  ok('#9906 メッセージが文字列でなければ 400（割り当てない）', msg.status === 400 && (await shiftNotifs(C)).length === 0, msg)
}

// ---------- 一括登録・コピー・今後のシフトの取り外し ----------
{
  const from = addDays(today, 20)
  const bk = must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [C.staff_id], date_from: from, date_to: addDays(from, 2), weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '18:00', notify: false }), 'bulk silent')
  ok('#9906 常勤の一括登録（notify: false）は通知を作らない', bk.created === 3 && (await shiftNotifs(C)).length === 0, bk)
  const board = must(await admin.get(`/api/admin/shift-board?from=${from}&to=${addDays(from, 2)}`), 'board').unslotted.filter(x => x.staff_id === C.staff_id)
  ok('#9906 一括登録の履歴にも「通知なし」と残る', board.length === 3 && (await opLogs(board[0].shift_id))[0]?.notify_off === true, board.length)

  const cp = must(await admin.post('/api/admin/shifts/copy-week', { source_from: from, target_from: addDays(from, 7), days: 7, project_ids: String(pid), include_assignments: true, notify: false, force: true }), 'copy silent')
  ok('#9906 コピー（notify: false）は通知を作らない', cp.shifts >= 3 && (await shiftNotifs(C)).length === 0, cp)

  const rl = must(await admin.post(`/api/admin/staff/${C.staff_id}/release-future-shifts`, { from: addDays(today, 1), notify: false }), 'release silent')
  ok('#9906 今後のシフトの取り外し（notify: false）は取消の通知を作らない', rl.removed >= 6 && (await shiftNotifs(C)).length === 0, rl)
}

// ---------- 会社の設定を「送らない」にしたとき ----------
{
  const s = must(await admin.put('/api/admin/settings/shift-notify', { enabled: false }), 'setting off')
  ok('#9906 会社の設定を「送らない」にできる。最後に変えた日時と人を返す', s.enabled === false && !!s.updated_at && s.updated_by_name === '出井 代表', s)
  const before = (await shiftNotifs(B)).length
  const r = must(await admin.post('/api/admin/shifts', { staff_id: B.staff_id, project_id: pid, work_date: addDays(today, 30), start_time: '10:00', end_time: '19:00' }), 'add default off')
  ok('#9906 notify を送らない呼び出しは会社の設定に従い、送らない（履歴に「通知なし」）', (await shiftNotifs(B)).length === before && (await opLogs(r.shift_id))[0]?.notify_off === true)
  must(await admin.put(`/api/admin/shifts/${r.shift_id}`, { start_time: '12:00', notify: true }), 'explicit notify')
  ok('#9906 会社の設定が「送らない」でも、notify: true の操作は送る', (await shiftNotifs(B)).length === before + 1)

  // シフト以外の通知（日報へのコメント）は会社の設定によらず送る
  const s2 = must(await admin.post('/api/admin/shifts', { staff_id: B.staff_id, project_id: pid, work_date: today, start_time: '00:00', end_time: '23:59', notify: false }), 'today shift')
  await B.api.post('/api/staff/daily-report', { shift_id: s2.shift_id, values: { free: '本日の報告' } })
  const rep = must(await admin.get(`/api/admin/daily-reports?date=${today}&staff_id=${B.staff_id}`), 'reports').reports.find(x => x.shift_id === s2.shift_id)
  if (!rep) ok('#9906 日報を出せた（前提）', false)
  else {
    must(await admin.put(`/api/admin/daily-reports/${rep.daily_report_id}`, { manager_comment: 'よくできました', expected_comment: null }), 'comment')
    const dc = await notifs(B, 'daily_report_comment')
    ok('#9906 日報へのコメントの通知は、シフトの通知の設定によらず送る', dc.length === 1 && dc[0].body.includes('よくできました'), dc)
  }
  const back = must(await admin.put('/api/admin/settings/shift-notify', { enabled: true }), 'setting on')
  ok('#9906 会社の設定を「送る」に戻せる', back.enabled === true, back)
}

// ---------- スタッフ本人の受け取り設定は今までどおり効く ----------
{
  must(await A.api.put('/api/staff/notification-prefs', { prefs: { shift: { email: false } } }), 'staff pref email off')
  const mailsBefore = (await mailTo('a')).length
  const r = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: T1, start_time: '20:00', end_time: '23:00', notify: true, notify_message: '夜の追加です' }), 'add notify pref off')
  await sleep(800)
  const n = (await notifs(A, 'shift_assigned')).filter(x => x.related_id === r.shift_id)
  ok('#9906 本人がシフトのメールを止めているときは、送る操作でもメールは送らない（アプリ内の通知は届く）', n.length === 1 && n[0].body.startsWith('管理者からのメッセージ: 夜の追加です') && (await mailTo('a')).length === mailsBefore, { n, mailsBefore })
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
