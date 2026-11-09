// w20-retire（利用者の決定 11/9。#9926 #9927）の統合テスト
//  - #9926 スタッフアプリの募集（D-22）を再開しないので、残りを外した: スタッフ向けの募集の API（/api/staff/recruit/*）・
//          環境変数 STAFF_APP_RECRUIT・「新しい募集」の通知と受け取り設定・管理画面のアプリ向けの設定。
//          会社の募集ページ・公開ページからの応募・管理画面の応募の一覧と承認はそのまま。以前にアプリから出された応募（source = 'staff'）も扱える
//  - #9927 シフト希望（D-23）の提出・取り下げの POST は 410「シフト希望の受け付けは終了しました」。GET /staff/shifts は request_projects を返さない。
//          以前に出された希望（shift_requests）は消さず、本人の画面に表示し、管理者は返事待ちの希望に返事できる。案件の削除の確かめも残す
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8712 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8712 PERSIST=<保存先> node scripts/test-w20-retire.mjs
//   PERSIST は、以前のデータ（アプリからの応募・シフト希望）をローカルの D1 に直接入れるのに使う（無ければその確認は SKIP）。本番には接続しない
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const BASE = process.env.BASE || 'http://127.0.0.1:8712'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)
let sqlSeq = 0, SQL_DIR = ''
function sql(command) {
  SQL_DIR = SQL_DIR || mkdtempSync(join(tmpdir(), 'w20r-'))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
async function login(company_code, user_code, password = 'pass1234') {
  const send = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await send().catch(async () => { await new Promise(res => setTimeout(res, 1000)); return send() })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // sql() の実行中に待ち受け側が閉じた接続を使い回すと ECONNRESET になるため、通信の失敗は1回だけやり直す
    const r = await send().catch(() => send())
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const PFX = 'W20R' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '080' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const admin = client(await login('sample', 'admin'))
const pub = client('')
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k, phone) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone }), 'staff ' + k)
  const s = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}${k}`)
  return { ...s, phone, api: client(await login('sample', `${PFX}${k}`)) }
}
async function newRoles(pid, date, start, end, roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  return b.slots.filter(s => s.project_id === pid && s.start_time === start).pop()
}
const publicApply = (token, phone, roleIds, name) => pub.post(`/api/public/recruit/${token}/apply`, { name, phone, agree: true, slot_role_ids: roleIds, issued_at: Date.now() - 10000 })
const appsOf = async (pageId, status = 'pending') => must(await admin.get(`/api/admin/recruit-applications?status=${status}&page_id=${pageId}`), 'apps').applications

const pid = await newProject(`${PFX}-案件`)
const D = addDays(today, 6)
const A = await newStaff('A', newPhone())

// =========================================================
// #9926 スタッフアプリの募集を外す
// =========================================================
{
  for (const [m, p, b] of [['get', '/api/staff/recruit'], ['get', '/api/staff/recruit/summary?counts=1'], ['get', '/api/staff/recruit/pages/1/roles'],
    ['post', '/api/staff/recruit/apply', { page_id: 1, slot_role_ids: [1] }], ['post', '/api/staff/recruit/items/1/cancel']]) {
    const r = await A.api[m](p, b)
    ok(`#9926 スタッフ向けの募集の API は無い（${m.toUpperCase()} ${p.replace(/\?.*$/, '')} は 404）`, r.status === 404, r)
  }
}
let pageA, pageB, roleA, roleA2, roleB
{
  const sA = await newRoles(pid, D, '10:00', '18:00', [{ role_name: '販売', headcount: 2 }, { role_name: '受付', headcount: 1 }])
  const sB = await newRoles(pid, addDays(D, 1), '10:00', '18:00', [{ role_name: '販売', headcount: 1 }])
  roleA = sA.roles[0].slot_role_id; roleA2 = sA.roles[1].slot_role_id; roleB = sB.roles[0].slot_role_id
  // 以前の画面が送っていた値（allow_staff・notify_staff・notify_staff_email）を送っても、受け付けて無視する
  pageA = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集A`, project_ids: [pid], date_from: today, date_to: D, show_remaining: true,
    description: '', pay_note: '日給 12,000円', contact_note: '担当 03-0000-0000', allow_staff: true, notify_staff: true, notify_staff_email: true }), 'page A')
  pageB = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集B`, project_ids: [pid], date_from: addDays(D, 1), date_to: addDays(D, 1), show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'page B')
  ok('#9926 募集ページを作れる。スタッフに知らせた件数（staff_notified）は返さない', pageA.ok && pageA.token && pageA.staff_notified === undefined && pageA.staff_emailed === undefined, pageA)
  const list = must(await admin.get('/api/admin/recruit-pages'), 'pages')
  ok('#9926 募集ページの一覧は、スタッフアプリの募集の状態（staff_app_recruit）を返さない', !('staff_app_recruit' in list) && list.pages.some(p => p.page_id === pageA.page_id), Object.keys(list))
  must(await admin.put(`/api/admin/recruit-pages/${pageA.page_id}`, { status: 'closed' }), 'close')
  const re = must(await admin.put(`/api/admin/recruit-pages/${pageA.page_id}`, { status: 'open', notify_staff: true }), 'reopen')
  ok('#9926 再開しても、スタッフに知らせない', re.ok && re.staff_notified === undefined && re.staff_notice_skipped === undefined, re)
  if (PERSIST) {
    const n = sql(`SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'recruit_new' AND related_id IN (${Number(pageA.page_id)}, ${Number(pageB.page_id)})`)[0].n
    const m = sql(`SELECT COUNT(*) AS n FROM email_logs WHERE type = 'recruit_new'`)[0].n
    ok('#9926 「新しい募集」の通知・メールを作らない', Number(n) === 0 && Number(m) === 0, { n, m })
  } else skip('#9926 「新しい募集」の通知・メールを作らない')
}

// ---------- 公開ページからの応募と、管理画面の件数（w4-recruit-staffapp の #410 #362 を公開ページで確かめる） ----------
{
  const g = must(await pub.get(`/api/public/recruit/${pageA.token}`), 'public get')
  ok('#362 公開ページの枠には会場の住所を返さない', g.roles.length >= 2 && g.roles.every(r => !('site_address' in r)), g.roles[0])
  must(await publicApply(pageA.token, A.phone, [roleA, roleA2], A.name), 'A public apply')
  must(await publicApply(pageB.token, newPhone(), [roleB], `${PFX} 新規の人`), 'public apply B')
  const pages = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages
  const ap = pages.find(p => p.page_id === pageA.page_id), bp = pages.find(p => p.page_id === pageB.page_id)
  ok('#410 募集ページの一覧の応募件数・未対応件数', ap.application_count === 1 && ap.pending_count === 1 && bp.application_count === 1 && bp.pending_count === 1, { ap, bp })
  ok('#410 募集ページの一覧の募集中の枠（まとめて集計）', ap.open_roles === 2 && ap.open_remaining === 3 && bp.open_roles === 1 && bp.open_remaining === 1, { ap, bp })
}

// ---------- 登録済みのスタッフの応募: 公開ページから応募し、承認のときに本人に紐づける ----------
{
  const app = (await appsOf(pageA.page_id)).find(a => a.phone === A.phone)
  ok('#9926 公開ページからの応募は、電話番号が一致する登録済みのスタッフを候補に出す', app && app.staff_id == null && app.phone_matches.some(m => m.staff_id === A.staff_id), app && app.phone_matches)
  const item = app.items.find(i => i.slot_role_id === roleA)
  const dec = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: [item.item_id], staff_id: A.staff_id, force: true }), 'decide A')
  ok('#9926 選んだスタッフに紐づけて承認でき、シフトができる', dec.staff_id === A.staff_id && dec.created_shifts === 1 && !dec.created_staff, dec)
  const n = (must(await A.api.get('/api/staff/notifications?kind=recruit_result'), 'A notifs').notifications || []).filter(x => x.related_id === app.application_id)
  ok('#9926 紐づけたスタッフには、アプリの通知で結果（確定）が届く', dec.applicant_notice && dec.applicant_notice.app === true && n.length === 1 && n[0].title.includes('確定'), { notice: dec.applicant_notice, n })
}

// ---------- 以前にスタッフアプリから出された応募（source = 'staff'・staff_id 付き） ----------
if (PERSIST) {
  const phone = newPhone()
  const L = await newStaff('L', phone)
  const s = await newRoles(pid, addDays(D, 2), '09:00', '12:00')
  const pageL = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 以前の応募`, project_ids: [pid], date_from: today, date_to: addDays(D, 2), show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'page L')
  must(await publicApply(pageL.token, phone, [s.roles[0].slot_role_id], L.name), 'public apply (legacy)')
  sql(`UPDATE recruit_applications SET source = 'staff', staff_id = ${Number(L.staff_id)} WHERE page_id = ${Number(pageL.page_id)} AND phone = '${phone}';
    UPDATE recruit_application_items SET staff_id = ${Number(L.staff_id)} WHERE application_id IN (SELECT application_id FROM recruit_applications WHERE page_id = ${Number(pageL.page_id)});`)
  const app = (await appsOf(pageL.page_id)).find(a => a.staff_id === L.staff_id)
  ok('#9926 以前のアプリからの応募は、応募の一覧に source = staff・staff_id 付きで出る（画面は「アプリから応募」）', app && app.source === 'staff' && app.staff_name, app)
  const dec = await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), force: true, notify_applicant: false })
  ok('#9926 以前のアプリからの応募は、紐づけ先を選ばずに承認できる', dec.status === 200 && dec.data.staff_id === L.staff_id && dec.data.created_shifts === 1, dec)
} else skip('#9926 以前のアプリからの応募の承認')

// ---------- 受け取り設定 ----------
{
  const prefs = must(await A.api.get('/api/staff/notification-prefs'), 'prefs').groups
  ok('#9926 スタッフの受け取り設定に「新しい募集」を出さない（「応募の結果」は残す）', !prefs.some(g => g.key === 'recruit_new') && prefs.some(g => g.key === 'recruit_result'), prefs.map(g => g.key))
  const bad = await A.api.put('/api/staff/notification-prefs', { prefs: { recruit_new: { push: true } } })
  ok('#9926 「新しい募集」の設定は保存できない（400）', bad.status === 400, bad)
  const good = await A.api.put('/api/staff/notification-prefs', { prefs: { recruit_result: { push: false } } })
  ok('#9926 「応募の結果」の設定は保存できる', good.status === 200 && good.data.groups.find(g => g.key === 'recruit_result')?.push === false, good)
  must(await A.api.put('/api/staff/notification-prefs', { prefs: { recruit_result: { push: true } } }), 'restore prefs')
}

// =========================================================
// #9927 シフト希望の提出を止める
// =========================================================
const st1 = client(await login('sample', 'st001')) // staff_id 1
const dR = addDays(today, 8)
{
  const r = await st1.post('/api/staff/shifts/request', { work_date: dR, start_time: '10:00', end_time: '18:00', memo: `${PFX}-新規` })
  ok('#9927 シフト希望の提出は 410「シフト希望の受け付けは終了しました」', r.status === 410 && r.data && r.data.error === 'シフト希望の受け付けは終了しました', r)
  const c = await st1.post('/api/staff/shift-requests/1/cancel')
  ok('#9927 シフト希望の取り下げも 410', c.status === 410 && c.data && c.data.error === 'シフト希望の受け付けは終了しました', c)
  const sh = must(await st1.get(`/api/staff/shifts?from=${dR}&to=${dR}`), 'staff shifts')
  ok('#9927 スタッフのシフトの API は request_projects を返さない（requests はそのまま返す）', !('request_projects' in sh) && Array.isArray(sh.requests) && !sh.requests.some(x => x.memo === `${PFX}-新規`), Object.keys(sh))
  const av = await st1.get('/api/staff/availability')
  ok('#9927 出勤可能日の API はそのまま使える（シフト希望とは別のもの）', av.status === 200 && !!av.data.month, av.status)
}
if (PERSIST) {
  const pidR = await newProject(`${PFX}-希望の案件`)
  const ins = (memo, start, status, project = null) => `INSERT INTO shift_requests (company_id, staff_id, user_id, project_id, work_date, start_time, end_time, memo, status, created_at)
    SELECT company_id, staff_id, user_id, ${project == null ? 'NULL' : Number(project)}, '${dR}', '${start}', '20:00', '${memo}', '${status}', datetime('now', '+9 hours') FROM staff_profiles WHERE staff_id = 1;`
  sql([ins(`${PFX}-返事待ち`, '10:00', 'pending'), ins(`${PFX}-採用済み`, '11:00', 'accepted', pidR)].join('\n'))
  const sh = must(await st1.get(`/api/staff/shifts?from=${dR}&to=${dR}`), 'staff shifts 2')
  ok('#9927 以前に出した希望は、本人のシフトの API で返す（画面は表示だけ）', sh.requests.some(x => x.memo === `${PFX}-返事待ち` && x.status === 'pending') && sh.requests.some(x => x.memo === `${PFX}-採用済み` && x.status === 'accepted' && x.project_name === `${PFX}-希望の案件`), sh.requests)
  const all = must(await admin.get(`/api/admin/shift-requests?from=${dR}&to=${dR}&status=all`), 'admin all')
  const pend = all.requests.find(x => x.memo === `${PFX}-返事待ち`), acc = all.requests.find(x => x.memo === `${PFX}-採用済み`)
  ok('#9927 シフトボードの「過去のシフト希望」（status=all）に、返事待ちと返事済みの希望が出る', pend && acc && all.pending >= 1, all)
  const r1 = await admin.post(`/api/admin/shift-requests/${pend.request_id}/respond`, { decision: 'decline', note: '受け付けを終了しました' })
  ok('#9927 返事待ちの希望には返事できる（以前の希望を片付けられる）', r1.status === 200 && r1.data.status === 'declined', r1)
  const r2 = await admin.post(`/api/admin/shift-requests/${acc.request_id}/respond`, { decision: 'decline' })
  ok('#9927 返事済みの希望には返事できない（409）', r2.status === 409, r2)
  const del = await admin.del(`/api/admin/projects/${pidR}`)
  ok('#9927 シフト希望が指している案件は削除できない（確かめは残す）', del.status === 409 && (del.data.usage || []).some(u => u.key === 'shift_requests'), del)
} else skip('#9927 以前のシフト希望の表示と返事')

// =========================================================
// 画面（静的な確認）
// =========================================================
{
  const sb = src('public/static/shift-board.js'), rc = src('public/static/recruit.js'), st = src('public/static/staff.js')
  ok('#9927 シフトボードのメニューは「過去のシフト希望」（希望が無い期間は出さない）', sb.includes("'過去のシフト希望'") && sb.includes('id="board-req-item" style="display:none"') && /item\.style\.display = \(data\.requests \|\| \[\]\)\.length \? '' : 'none'/.test(sb))
  ok('#9927 「過去のシフト希望」は返事済み・取り下げも含めて表示し、受け付けの終了を案内する', !sb.includes('toggleShiftRequestsAll') && !sb.includes('REQ_ALL') && sb.includes('シフト希望の受け付けは終了しました。') && /status: 'all' \}\)\)\)\.data/.test(sb))
  ok('#9926 管理画面の募集ページから、スタッフアプリ向けの設定（アプリからの応募・アプリで知らせる）を外す', !rc.includes('rp-staff') && !rc.includes('rp-notify') && !rc.includes('__recruitStaffApp') && !rc.includes('allow_staff') && !rc.includes('notify_staff'))
  ok('#9926 応募の一覧の「アプリから応募」の印は残す（以前の応募）', rc.includes("a.source === 'staff' ? 'アプリから応募'"))
  ok('#9926 スタッフアプリは「新しい募集」の通知の行き先を持たない', !st.includes("'recruit_new'") && st.includes("'recruit_result'"))
  const ts = ['src/recruit.ts', 'src/notifications.ts', 'src/api.ts'].map(src).join('\n')
  ok('#9926 サーバーに STAFF_APP_RECRUIT・スタッフ向けの募集の API が残っていない', !ts.includes('STAFF_APP_RECRUIT') && !ts.includes('recruitStaffApi') && !ts.includes('notifyRecruitNew') && !ts.includes('staffAppRecruitEnabled'))
  ok('#9926 資料の環境変数の表に STAFF_APP_RECRUIT が無い', !src('docs/architecture.md').includes('STAFF_APP_RECRUIT'))
  for (const [name, s] of [['shift-board.js', sb], ['recruit.js', rc], ['staff.js', st]]) {
    let err = null
    try { new Function(s) } catch (e) { err = String(e) }
    ok(`構文: ${name}`, !err, err)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
