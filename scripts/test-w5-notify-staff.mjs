// スタッフあての通知（w5-notify-staff: #151 #155 #156 #158）の統合テスト
// 起動に --var STAFF_APP_RECRUIT:1 を付ける（スタッフアプリの募集は Sprint 11 で止めた。#9411。この試験はスタッフアプリからの応募も使う。npm test は自動で付ける）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8813 --persist-to <保存先> で起動していること（MAIL_ENABLED は既定の false のまま）。
//   メールは送らずに email_logs に『skipped』で記録されるので、送ろうとしたメールの種類と宛先はメールの送信記録で確かめる。
// 実行: BASE=http://127.0.0.1:8813 node scripts/test-w5-notify-staff.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8813'
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
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'NS' + Date.now().toString(36).slice(-4).toUpperCase()
const tag = PFX.toLowerCase()

const admin = client(await login('sample', 'admin'))
const pub = client(null)

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
const mailLogs = async (type) => (must(await admin.get(`/api/admin/email-logs?type=${type}`), 'email logs').logs)

const pid = await newProject(`${PFX}-案件`)
const pid2 = await newProject(`${PFX}-別案件`)
const A = await newStaff('A'), B = await newStaff('B')
const T1 = addDays(today, 1), T10 = addDays(today, 10)

// ---------- #155 シフト管理（POST/PUT/DELETE /admin/shifts） ----------
let sidA
{
  const r = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: T1, start_time: '10:00', end_time: '19:00' }), 'add shift')
  sidA = r.shift_id
  const n = await notifs(A, 'shift_assigned')
  ok('#155 シフトを登録すると、本人にアプリ内の通知（shift_assigned）が届く', n.length === 1 && n[0].related_id === sidA && n[0].link === `#shift/${T1}` && n[0].title.includes(`${PFX}-案件`), n)
  const logs = await mailLogs('shift_change')
  ok('#155 明日のシフトの登録は、本人にメールも送る（email_logs に shift_change）', logs.some(l => l.to_email === `${tag}-a@example.com`), logs.slice(0, 3))
}
{
  must(await admin.put(`/api/admin/shifts/${sidA}`, { start_time: '11:00', end_time: '20:00' }), 'time change')
  const n = await notifs(A, 'shift_changed')
  ok('#155 時間を変えると、変更前と変更後の時間を書いた通知（shift_changed）が届く', n.length === 1 && n[0].body.includes('10:00〜19:00 → 11:00〜20:00'), n)
  must(await admin.put(`/api/admin/shifts/${sidA}`, { memo: 'メモだけ' }), 'memo')
  ok('#155 メモだけの変更では通知しない', (await notifs(A, 'shift_changed')).length === 1)
}
{
  must(await admin.put(`/api/admin/shifts/${sidA}`, { staff_id: B.staff_id, force: true }), 'swap staff')
  const a = await notifs(A, 'shift_cancelled'), b = await notifs(B, 'shift_assigned')
  ok('#155 担当者を差し替えると、前の人には取消、新しい人には登録を知らせる', a.length === 1 && b.length === 1 && b[0].related_id === sidA, { a, b })
  must(await admin.del(`/api/admin/shifts/${sidA}`), 'delete')
  const bc = await notifs(B, 'shift_cancelled')
  ok('#155 シフトを削除すると、本人に取消を知らせる', bc.length === 1 && bc[0].title.includes('取り消されました'), bc)
}
{
  const before = (await notifs(A)).length
  must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: addDays(today, -3), start_time: '10:00', end_time: '19:00' }), 'past shift')
  ok('#155 過去の日付のシフトの登録（精算のための直し）は知らせない', (await notifs(A)).length === before)
}

// ---------- #155 シフトボード（割当・枠の変更・移動・一括登録・確定） ----------
async function newSlot(p, date, start = '10:00', end = '18:00') {
  must(await admin.post('/api/admin/shift-slots', { project_id: p, dates: [date], start_time: start, end_time: end, roles: [{ role_name: '販売', headcount: 2 }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  return b.slots.filter(s => s.project_id === p && s.start_time === start).pop()
}
{
  const mailBefore = (await mailLogs('shift_change')).length
  const slot = await newSlot(pid, T10)
  const rid = slot.roles[0].slot_role_id
  const r = must(await admin.post(`/api/admin/shift-slots/roles/${rid}/assign`, { staff_ids: [A.staff_id], force: true }), 'assign')
  const sid = r.shift_ids[0]
  const n = await notifs(A, 'shift_assigned')
  ok('#155 枠への割り当てを本人に知らせる', n.some(x => x.related_id === sid), n)
  ok('#155 10日後のシフトはアプリ内の通知だけで、メールは送らない', (await mailLogs('shift_change')).length === mailBefore)

  must(await admin.put(`/api/admin/shift-slots/${slot.slot_id}`, { start_time: '12:00', end_time: '20:00', force: true }), 'slot edit')
  const c = (await notifs(A, 'shift_changed')).filter(x => x.related_id === sid)
  ok('#155 枠の時間を変えると、枠に入っている人に変更を知らせる', c.length === 1 && c[0].body.includes('10:00〜18:00 → 12:00〜20:00'), c)

  const slot2 = await newSlot(pid2, addDays(today, 11), '09:00', '17:00')
  must(await admin.post(`/api/admin/shifts/${sid}/move`, { slot_role_id: slot2.roles[0].slot_role_id, force: true }), 'move')
  const m = (await notifs(A, 'shift_changed')).filter(x => x.related_id === sid)
  ok('#155 別の枠へ移動すると、日付・時間・案件の変更を知らせる', m.length === 2 && m[0].body.includes('日付:') && m[0].body.includes(`${PFX}-別案件`), m[0])

  // 希望（仮）→ まとめて確定
  const slot3 = await newSlot(pid, addDays(today, 12), '10:00', '15:00')
  const r3 = must(await admin.post(`/api/admin/shift-slots/roles/${slot3.roles[0].slot_role_id}/assign`, { staff_ids: [B.staff_id], status: 'requested', force: true }), 'assign requested')
  const req = (await notifs(B, 'shift_assigned')).find(x => x.related_id === r3.shift_ids[0])
  ok('#155 希望（仮）で入れたときは、返事を促す通知にする', !!req && req.title.includes('仮のシフト'), req)
  must(await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: r3.shift_ids, force: true }), 'confirm')
  const cf = (await notifs(B, 'shift_changed')).find(x => x.related_id === r3.shift_ids[0])
  ok('#155 希望（仮）を確定にすると、状態の変更を知らせる', !!cf && cf.body.includes('仮（希望） → 確定'), cf)
}
{
  const before = (await notifs(A)).length
  const from = addDays(today, 20)
  const r = must(await admin.post('/api/admin/shifts/bulk', { project_id: pid, staff_ids: [A.staff_id, B.staff_id], date_from: from, date_to: addDays(from, 6), weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '18:00' }), 'bulk')
  const after = await notifs(A)
  const top = after[0]
  ok('#155 一括登録は、スタッフごとに1件の通知にまとめる', r.created === 14 && after.length === before + 1 && top.kind === 'shift_assigned' && top.title.includes('登録7件') && top.body.split('\n').length === 7, { created: r.created, top })
}

// ---------- #158 日報のコメント ----------
{
  const s = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: today, start_time: '00:00', end_time: '23:59' }), 'today shift')
  const dr = await A.api.post('/api/staff/daily-report', { shift_id: s.shift_id, values: { free: '本日の報告' } })
  const list = must(await admin.get(`/api/admin/daily-reports?date=${today}&staff_id=${A.staff_id}`), 'reports').reports
  const rep = list.find(x => x.shift_id === s.shift_id)
  if (!rep) { ok('#158 日報を出せた（前提）', false, dr) } else {
    const r1 = must(await admin.put(`/api/admin/daily-reports/${rep.daily_report_id}`, { manager_comment: 'トークがとても良かったです', expected_comment: null }), 'comment')
    const n1 = await notifs(A, 'daily_report_comment')
    ok('#158 コメントを付けると、スタッフにアプリ内の通知が届き、応答で知らせたことを返す', r1.staff_notified === true && n1.length === 1 && n1[0].related_id === rep.daily_report_id && n1[0].body.includes('トークがとても良かった'), { r1, n1 })
    must(await admin.put(`/api/admin/daily-reports/${rep.daily_report_id}`, { manager_comment: '追記: 声かけも良かったです', expected_comment: 'トークがとても良かったです' }), 'comment 2')
    const n2 = await notifs(A, 'daily_report_comment')
    ok('#158 読んでいないうちに書き換えたときは、通知を新しい内容の1件に置き換える', n2.length === 1 && n2[0].body.includes('声かけ'), n2)
    const r3 = must(await admin.put(`/api/admin/daily-reports/${rep.daily_report_id}`, { manager_checked: 1 }), 'check')
    ok('#158 確認済みにするだけでは通知しない', r3.staff_notified === undefined && (await notifs(A, 'daily_report_comment')).length === 1, r3)
    must(await A.api.post(`/api/staff/notifications/${n2[0].notification_id}/read`), 'read')
    must(await admin.put(`/api/admin/daily-reports/${rep.daily_report_id}`, { manager_comment: null }), 'delete comment')
    ok('#158 コメントを消したときは通知しない', (await notifs(A, 'daily_report_comment')).length === 1)
  }
}

// ---------- #156 新しい募集 ----------
let page
const BLANK = { show_remaining: true, description: '', pay_note: '', contact_note: '' }
{
  page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true, show_remaining: true, description: '黒のパンツで集合', pay_note: '日給 12,000円', contact_note: '採用担当 03-0000-0000' }), 'page')
  const n = (await notifs(A, 'recruit_new')).filter(x => x.related_id === page.page_id)
  ok('#156 アプリから応募できる募集を作ると、スタッフに知らせる（件数を応答で返す）', page.staff_notified >= 2 && n.length === 1 && n[0].title.includes(`${PFX} 募集`), { page, n })
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'closed' }), 'close')
  const re = must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'open' }), 'reopen')
  ok('#156 同じ募集を同じ日に再開しても、通知は1日1回まで', re.staff_notice_skipped === true && (await notifs(A, 'recruit_new')).filter(x => x.related_id === page.page_id).length === 1, re)
  const silent = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 通知なし`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true, ...BLANK, notify_staff: false }), 'page silent')
  ok('#156 notify_staff: false なら知らせない', silent.staff_notified === undefined && !(await notifs(A, 'recruit_new')).some(x => x.related_id === silent.page_id), silent)
  const mailed = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} メールも`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true, ...BLANK, notify_staff_email: true }), 'page mail')
  ok('#156 メールでも知らせる指定のときは、メールアドレスのあるスタッフにメールを送る', mailed.staff_emailed >= 2 && (await mailLogs('recruit_new')).some(l => l.to_email === `${tag}-a@example.com`), mailed)
  const appOnly = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 公開のみ`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: false, ...BLANK }), 'page public only')
  ok('#156 アプリからの応募を許可しない募集は知らせない', appOnly.staff_notified === undefined, appOnly)
  const sum = must(await A.api.get('/api/staff/recruit/summary?counts=1'), 'summary')
  ok('#156 ホーム用の件数だけの取得（counts=1）', typeof sum.open === 'number' && sum.other_companies === undefined && sum.pending_items === undefined, sum)
}

// ---------- #151 応募の結果 ----------
{
  const slot = await newSlot(pid, addDays(today, 5), '13:00', '17:00')
  const rid = slot.roles[0].slot_role_id
  const slotB = await newSlot(pid, addDays(today, 6), '13:00', '17:00')
  const ridB = slotB.roles[0].slot_role_id
  // 公開ページから（メールあり）
  const ap = await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 公開`, phone: '07012345' + String(Date.now() % 1000).padStart(3, '0'), email: `${tag}-pub@example.com`, agree: true, slot_role_ids: [rid, ridB], issued_at: Date.now() - 10000 })
  const apps = must(await admin.get(`/api/admin/recruit-applications?status=pending&page_id=${page.page_id}`), 'apps').applications
  const pa = apps.find(a => a.name === `${PFX} 公開`)
  if (!pa) ok('#151 公開ページから応募できた（前提）', false, ap)
  else {
    const it = pa.items.find(i => i.slot_role_id === ridB)
    const rj = must(await admin.post(`/api/admin/recruit-applications/${pa.application_id}/decide`, { reject: [it.item_id] }), 'reject')
    ok('#151 見送ると、公開ページの応募者（メールあり）に結果のメールを送る（ローカルは送信停止のため disabled）', rj.applicant_notice && rj.applicant_notice.email === 'disabled' && rj.applicant_notice.app === false, rj)
    const logs = await mailLogs('recruit_result')
    ok('#151 結果のメールの送信記録が残る', logs.some(l => l.type === 'recruit_result'), logs.slice(0, 2))
    const it2 = pa.items.find(i => i.slot_role_id === rid)
    const ap2 = await admin.post(`/api/admin/recruit-applications/${pa.application_id}/decide`, { approve: [it2.item_id], new_staff_type: 'daily_worker', force_new: true, force: true, notify_applicant: false })
    ok('#151 notify_applicant: false なら知らせない', ap2.status === 200 && ap2.data.applicant_notice === undefined, ap2.data)
    const rs = must(await admin.post(`/api/admin/recruit-applications/${pa.application_id}/notify-result`), 'resend')
    ok('#151 結果のお知らせを送り直せる（承認・見送りをまとめて1通）', rs.applicant_notice.email === 'disabled', rs)
  }
  // スタッフアプリから
  const slotC = await newSlot(pid, addDays(today, 7), '13:00', '17:00')
  must(await B.api.post('/api/staff/recruit/apply', { pages: [{ page_id: page.page_id, slot_role_ids: [slotC.roles[0].slot_role_id] }] }), 'staff apply')
  const sa = must(await admin.get(`/api/admin/recruit-applications?status=pending&page_id=${page.page_id}`), 'apps').applications.find(a => a.staff_id === B.staff_id)
  const dec = must(await admin.post(`/api/admin/recruit-applications/${sa.application_id}/decide`, { approve: sa.items.map(i => i.item_id), force: true }), 'approve staff')
  const rn = (await notifs(B, 'recruit_result')).filter(x => x.related_id === sa.application_id)
  ok('#151 アプリから応募したスタッフには、アプリ内の通知で確定を知らせる（シフトの登録の通知は重ねない）', dec.applicant_notice.app === true && rn.length === 1 && rn[0].title.includes('確定') && rn[0].body.includes('黒のパンツ'),
    { dec: dec.applicant_notice, rn })
  // 定員に達した枠の残りをまとめて見送る
  const slotD = await newSlot(pid, addDays(today, 8), '13:00', '17:00')
  const ridD = slotD.roles[0].slot_role_id
  must(await A.api.post('/api/staff/recruit/apply', { pages: [{ page_id: page.page_id, slot_role_ids: [ridD] }] }), 'A apply')
  const rp = must(await admin.post(`/api/admin/recruit-slots/${ridD}/reject-pending`), 'reject pending')
  const an = (await notifs(A, 'recruit_result')).filter(x => x.title.includes('見送り'))
  ok('#151 枠の残りをまとめて見送ったときも、応募者に知らせる', rp.rejected === 1 && rp.applicants_notified === 1 && an.length === 1, { rp, an })
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
