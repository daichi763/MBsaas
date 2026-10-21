// 募集・応募の不具合（w3-recruit: #64 #65 #86 #87 #114 #126 #136 #190 #225 #501）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8821 node scripts/test-w3-recruit.mjs
//   #501 を確かめるときは、秘密鍵だけを渡して起動し（--var TURNSTILE_SECRET_KEY:dummy）、TURNSTILE=secret_key_only を付けて実行する
//   【注意】サーバーの起動オプションとテストの環境変数を必ず組で合わせる（合っていないと #501 の確認が FAIL になる。9005）。
//     - npm test（scripts/run-tests.mjs）は上の --var を起動に付け、同じ値をテストの環境変数にも渡すので、そのままで合う
//       （TURNSTILE が無くても、渡された TURNSTILE_SECRET_KEY / TURNSTILE_SITE_KEY から期待する状態を決める）
//     - 手で流すときは、--var を付けずに起動したなら TURNSTILE も付けない（off）。秘密鍵だけを渡して起動したなら
//       TURNSTILE=secret_key_only（または TURNSTILE_SECRET_KEY=dummy）を付けて実行する
//   PERSIST=<保存先> を付けると、ローカルの D1 を直接書き換える確認（処理中のまま止まった明細の復旧）も行う
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
let sqlSeq = 0, SQL_DIR = ''
function sql(command) {
  SQL_DIR = SQL_DIR || mkdtempSync(join(tmpdir(), 'w3rc-'))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // sql() の実行中に待ち受け側が閉じた接続を使い回すと ECONNRESET になるため、通信の失敗は1回だけやり直す
    const r = await send().catch(() => send())
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'RC' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '080' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')

const admin = client(await login('sample', 'admin'))
const pub = client(null)

async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k, phone) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
// 枠を作り、その日の枠の役割を返す
async function newRoles(pid, date, start = '10:00', end = '18:00', roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  const slots = b.slots.filter(s => s.project_id === pid && s.start_time === start)
  return slots[slots.length - 1]
}
async function newPage(pids, from, to, extra = {}) {
  return must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: pids, date_from: from, date_to: to, allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '', ...extra }), 'recruit page')
}
const publicApply = (token, phone, roleIds, name = `${PFX} 応募`) =>
  pub.post(`/api/public/recruit/${token}/apply`, { name, phone, agree: true, slot_role_ids: roleIds, issued_at: Date.now() - 10000 })
const appsOf = async (pageId, status = 'pending') => must(await admin.get(`/api/admin/recruit-applications?status=${status}&page_id=${pageId}`), 'apps').applications

const pid = await newProject(`${PFX}-案件`)
const D = addDays(today, 5)

// ---------- #190 開始時刻を過ぎた当日の枠は出さない ----------
{
  const nowHM = jstNow().slice(11, 16)
  const pid190 = await newProject(`${PFX}-開始済み`)
  const started = await newRoles(pid190, today, '00:00', '00:30')
  const later = await newRoles(pid190, addDays(today, 1), '00:00', '00:30')
  const page = await newPage([pid190], today, addDays(today, 3))
  const g = must(await pub.get(`/api/public/recruit/${page.token}`), 'public get')
  const ids = g.roles.map(r => r.slot_role_id)
  if (nowHM > '00:00') {
    ok('#190 公開ページ: 開始時刻を過ぎた当日の枠は出さない', !ids.includes(started.roles[0].slot_role_id), ids)
    const ap = await publicApply(page.token, newPhone(), [started.roles[0].slot_role_id])
    ok('#190 開始時刻を過ぎた枠には応募できない（409）', ap.status === 409, ap)
  }
  ok('#190 翌日の枠は出る', ids.includes(later.roles[0].slot_role_id), ids)
}

// ---------- #126 枠が300件を超える募集ページ ----------
{
  const pid126 = await newProject(`${PFX}-大量`)
  const from = addDays(today, 1), dates = [...Array(62).keys()].map(i => addDays(from, i))
  must(await admin.post('/api/admin/shift-slots', { project_id: pid126, dates, start_time: '10:00', end_time: '18:00', roles: [1, 2, 3, 4, 5, 6].map(n => ({ role_name: '役割' + n, headcount: 1 })) }), 'bulk slots')
  const page = await newPage([pid126], from, dates[dates.length - 1])
  const g1 = must(await pub.get(`/api/public/recruit/${page.token}`), 'public get 1')
  ok('#126 公開ページ: 一度に返すのは300件まで、続きの日付を返す', g1.roles.length <= 300 && !!g1.next_from, { n: g1.roles.length, next: g1.next_from })
  let all = [...g1.roles], next = g1.next_from, guard = 0
  while (next && guard++ < 5) { const g = must(await pub.get(`/api/public/recruit/${page.token}?from=${next}`), 'public get more'); all.push(...g.roles); next = g.next_from }
  const uniq = new Set(all.map(r => r.slot_role_id))
  ok('#126 公開ページ: 続きを取ると全372件がそろい、重複しない', all.length === 372 && uniq.size === 372, { n: all.length, uniq: uniq.size })
  ok('#126 公開ページ: 期間の最後の日の枠も出る', all.some(r => r.work_date === dates[dates.length - 1]))
  const list = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(p => p.page_id === page.page_id)
  ok('#126 管理画面: 募集中の枠の件数を打ち切らずに数える', list.open_roles === 372 && list.open_remaining === 372, { roles: list.open_roles, rem: list.open_remaining })
  const st = await newStaff('S126')
  const sc = client(await login('sample', `${PFX}S126`))
  const sp = must(await sc.get('/api/staff/recruit'), 'staff recruit').pages.find(p => p.page_id === page.page_id)
  ok('#126 スタッフアプリ: 300件までと続きの日付を返す', sp && sp.roles.length <= 300 && !!sp.next_from, { n: sp?.roles?.length })
  const more = must(await sc.get(`/api/staff/recruit/pages/${page.page_id}/roles?from=${sp.next_from}`), 'staff more')
  ok('#126 スタッフアプリ: 続きの日時を取得できる', sp.roles.length + more.roles.length === 372 && more.next_from === null, { a: sp.roles.length, b: more.roles.length })
  void st
}

// ---------- #136 期間切れの募集ページの再開 ----------
{
  const page = await newPage([pid], today, addDays(today, 3))
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'closed' }), 'close')
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { date_from: addDays(today, -10), date_to: addDays(today, -1) }), 'shift period to past')
  const re = await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'open' })
  ok('#136 期間切れのページを再開しようとすると 400（期間の延長を求める）', re.status === 400 && re.data.need_extend, re)
  let p = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(x => x.page_id === page.page_id)
  ok('#136 一覧: 期間切れは expired・公開中ではない', p.expired === true && p.is_open === false && p.status === 'closed', p)
  const ext = await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { date_to: addDays(today, 5), status: 'open' })
  p = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(x => x.page_id === page.page_id)
  ok('#136 期間を延ばして再開すると公開中になる', ext.status === 200 && p.is_open === true && p.expired === false, { ext, p })
  const past = await admin.post('/api/admin/recruit-pages', { title: `${PFX} 過去`, project_ids: [pid], date_from: addDays(today, -5), date_to: addDays(today, -1) })
  ok('#136 終了日が過去の募集ページは作れない', past.status === 400, past)
}

// ---------- #225 送信回数の制限は募集ページごと ----------
{
  const s = await newRoles(pid, addDays(D, 1), '09:00', '12:00', [{ role_name: '受付', headcount: 50 }])
  const pageA = await newPage([pid], today, addDays(today, 20))
  const pageB = await newPage([pid], today, addDays(today, 20))
  const rs = []
  for (let i = 0; i < 7; i++) rs.push(await publicApply(pageA.token, newPhone(), [s.roles[0].slot_role_id], `${PFX} 会場${i}`))
  ok('#225 同じ接続元から同じページへ7件続けて応募できる（以前は5件まで）', rs.every(r => r.status === 200 && r.data.count === 1), rs.map(r => r.status))
  const rb = await publicApply(pageB.token, newPhone(), [s.roles[0].slot_role_id])
  ok('#225 別のページへの応募は合算されない', rb.status === 200, rb)
  // 同じ枠への2回目以降は重複として登録しないため、別々の枠に応募して数える
  const s4 = await newRoles(pid, addDays(D, 1), '13:00', '14:00', [1, 2, 3, 4].map(n => ({ role_name: '係' + n, headcount: 1 })))
  const phone = newPhone()
  const p3 = []
  for (let i = 0; i < 4; i++) p3.push(await publicApply(pageA.token, phone, [s4.roles[i].slot_role_id]))
  ok('#225 電話番号ごとの制限（1日3件）は残る', p3[3].status === 429, p3.map(r => r.status))
}

// ---------- #86 未登録の応募者の承認の二度押し ----------
{
  const s = await newRoles(pid, D, '13:00', '15:00', [{ role_name: '案内', headcount: 1 }])
  const page = await newPage([pid], today, addDays(today, 20))
  const phone = newPhone()
  must(await publicApply(page.token, phone, [s.roles[0].slot_role_id], `${PFX} 二度押し`), 'apply')
  const app = (await appsOf(page.page_id)).find(a => a.phone === phone)
  const body = { approve: app.items.map(i => i.item_id), new_staff_type: 'daily_worker', force_new: true, force: true }
  const rs = await Promise.all([1, 2, 3].map(() => admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, body)))
  const okN = rs.filter(r => r.status === 200).length
  ok('#86 同時に3回承認しても成功は1回だけ（他は 409）', okN === 1 && rs.filter(r => r.status === 409).length === 2, rs.map(r => r.status))
  const shifts = must(await admin.get(`/api/admin/shifts?from=${D}&to=${D}`), 'shifts').shifts.filter(x => x.slot_role_id === s.roles[0].slot_role_id)
  ok('#86 確定シフトは1件だけ', shifts.length === 1, shifts.length)
  const staff = must(await admin.get('/api/admin/staff'), 'staff').staff.filter(x => x.name === `${PFX} 二度押し`)
  ok('#86 仮登録も1人だけ', staff.length === 1, staff.length)
  const done = (await appsOf(page.page_id, 'done')).find(a => a.application_id === app.application_id)
  ok('#86 応募は対応済みになり、明細は承認', done && done.items.every(i => i.status === 'approved'), done)
}
// ---------- #86 処理中（processing）のまま止まった明細は、一定時間たつと未対応に戻る ----------
if (PERSIST) {
  const s2 = await newRoles(pid, D, '16:00', '17:00', [{ role_name: '受付', headcount: 2 }, { role_name: '誘導', headcount: 2 }])
  const page = await newPage([pid], today, addDays(today, 20))
  const phone = newPhone()
  must(await publicApply(page.token, phone, s2.roles.map(r => r.slot_role_id), `${PFX} 処理中`), 'apply')
  const app = (await appsOf(page.page_id)).find(a => a.phone === phone)
  const [stale, fresh] = app.items.map(i => Number(i.item_id))
  sql(`UPDATE recruit_application_items SET status = 'processing', decided_at = datetime('now', '+9 hours', '-30 minutes') WHERE item_id = ${stale};
    UPDATE recruit_application_items SET status = 'processing', decided_at = datetime('now', '+9 hours') WHERE item_id = ${fresh};`)
  const items = (await appsOf(page.page_id)).find(a => a.application_id === app.application_id).items
  ok('#86 30分前から処理中の明細は未対応に戻る', items.find(i => i.item_id === stale)?.status === 'pending', items)
  ok('#86 押さえたばかりの処理中の明細はそのまま', items.find(i => i.item_id === fresh)?.status === 'processing', items)
  const r = await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { reject: [fresh] })
  ok('#86 処理中の明細は見送りにもできない（409）', r.status === 409, r)
  sql(`UPDATE recruit_application_items SET status = 'pending', decided_at = NULL WHERE item_id = ${fresh}`)
  must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { reject: [stale, fresh] }), 'reject')
} else console.log('SKIP  #86 処理中のまま止まった明細の復旧（PERSIST 未指定）')

// ---------- #64 承認後にシフトを削除したら『シフト解除』になり、応募し直せる ----------
{
  const st = await newStaff('S64')
  const sc = client(await login('sample', `${PFX}S64`))
  const s = await newRoles(pid, addDays(D, 2), '10:00', '12:00')
  const page = await newPage([pid], today, addDays(today, 20))
  const rid = s.roles[0].slot_role_id
  must(await sc.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [rid] }), 'staff apply')
  const app = (await appsOf(page.page_id)).find(a => a.staff_id === st.staff_id)
  const dec = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), force: true }), 'decide')
  ok('#64 承認でシフトができる', dec.created_shifts === 1, dec)
  let r = must(await sc.get('/api/staff/recruit'), 'staff recruit')
  ok('#64 承認直後は『確定』', r.applications.find(a => a.slot_role_id === rid)?.status === 'approved', r.applications)
  const sh = must(await admin.get(`/api/admin/shifts?from=${addDays(D, 2)}&to=${addDays(D, 2)}`), 'shifts').shifts.find(x => x.slot_role_id === rid && x.staff_id === st.staff_id)
  must(await admin.del(`/api/admin/shifts/${sh.shift_id}`), 'delete shift')
  r = must(await sc.get('/api/staff/recruit'), 'staff recruit 2')
  ok('#64 シフトを削除すると『シフト解除』（released）になる', r.applications.find(a => a.slot_role_id === rid)?.status === 'released', r.applications)
  const role = r.pages.find(p => p.page_id === page.page_id)?.roles.find(x => x.slot_role_id === rid)
  ok('#64 その枠は応募済みとして扱わない', role && role.my_status === null, role)
  const again = must(await sc.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [rid] }), 'apply again')
  ok('#64 同じ枠に応募し直せる', again.count === 1, again)
  const adm = (await appsOf(page.page_id, 'done')).find(a => a.application_id === app.application_id)
  ok('#64 管理画面でも『シフト解除』と出る', adm && adm.items[0].status === 'released', adm?.items)
}

// ---------- #87 退職したスタッフの応募は承認できない ----------
{
  const st = await newStaff('S87')
  const sc = client(await login('sample', `${PFX}S87`))
  const s = await newRoles(pid, addDays(D, 3), '10:00', '12:00')
  const page = await newPage([pid], today, addDays(today, 20))
  must(await sc.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [s.roles[0].slot_role_id] }), 'staff apply')
  must(await admin.put(`/api/admin/employees/${st.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } }), 'retire')
  // w7-followup-server-a（#87 の残り）から、退職したスタッフの未対応の応募は、一覧を開いたときに取り下げ（cancelled）にする
  ok('#87 退職者の応募は未対応の一覧に残らない', !(await appsOf(page.page_id)).some(a => a.staff_id === st.staff_id))
  const app = (await appsOf(page.page_id, 'cancelled')).find(a => a.staff_id === st.staff_id)
  ok('#87 退職者の未対応の応募は取り下げ（cancelled）になり、退職・停止中の印が付く', app && app.items.every(i => i.status === 'cancelled') && app.staff_inactive === 1, app)
  const dec = app ? await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), force: true }) : { status: 0 }
  ok('#87 退職者の応募は承認できない（force でも）', dec.status >= 400 && dec.status < 500, dec)
  const n = must(await admin.get(`/api/admin/shifts?from=${addDays(D, 3)}&to=${addDays(D, 3)}`), 'shifts').shifts.filter(x => x.staff_id === st.staff_id).length
  ok('#87 シフトは作られない', n === 0, n)
  const after = app && (await appsOf(page.page_id, 'cancelled')).find(a => a.application_id === app.application_id)
  ok('#87 明細は取り下げのまま（処理中のまま残らない）', after && after.items.every(i => i.status === 'cancelled'), after?.items)
  // 電話番号が一致する退職者には印が付く
  const phone = newPhone()
  const st2 = await newStaff('S87B', phone)
  must(await admin.put(`/api/admin/employees/${st2.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } }), 'retire 2')
  must(await publicApply(page.token, phone, [s.roles[0].slot_role_id]), 'public apply')
  const pa = (await appsOf(page.page_id)).find(a => a.phone === phone)
  ok('#87 電話番号が一致する退職者に印が付く', pa && pa.phone_matches.some(m => m.staff_id === st2.staff_id && m.inactive), pa?.phone_matches)
  const link = await admin.post(`/api/admin/recruit-applications/${pa.application_id}/decide`, { approve: pa.items.map(i => i.item_id), staff_id: st2.staff_id, force: true })
  ok('#87 退職者に紐づけて承認はできない', link.status === 400, link)
}

// ---------- #114 登録済みスタッフが公開URLから応募した場合 ----------
{
  const phone = newPhone()
  const st = await newStaff('S114', phone)
  const sc = client(await login('sample', `${PFX}S114`))
  const s = await newRoles(pid, addDays(D, 4), '10:00', '12:00')
  const page = await newPage([pid], today, addDays(today, 20))
  const rid = s.roles[0].slot_role_id
  must(await publicApply(page.token, phone, [rid], `${PFX} S114`), 'public apply')
  let r = must(await sc.get('/api/staff/recruit'), 'staff recruit')
  const mine = r.applications.find(a => a.slot_role_id === rid)
  ok('#114 公開URLからの応募が本人のアプリに出る', mine && mine.status === 'pending' && mine.source === 'public', r.applications)
  ok('#114 その枠は応募済みとして表示される', r.pages.find(p => p.page_id === page.page_id)?.roles.find(x => x.slot_role_id === rid)?.my_status === 'pending')
  const dup = must(await sc.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [rid] }), 'staff apply dup')
  ok('#114 アプリから同じ枠に重ねて応募できない', dup.count === 0, dup)
  const cancel = await sc.post(`/api/staff/recruit/items/${mine.item_id}/cancel`)
  ok('#114 公開URLからの応募をアプリで取り下げられる', cancel.status === 200, cancel)
  // 他人（電話番号が違う）の公開応募は見えない
  const other = client(await login('sample', `${PFX}S64`))
  const ro = must(await other.get('/api/staff/recruit'), 'other recruit')
  ok('#114 電話番号が違うスタッフには出ない', !ro.applications.some(a => a.item_id === mine.item_id))
  void st
}

// ---------- #65 応募がある枠を削除すると『枠の削除』で処理済みになる ----------
{
  const s = await newRoles(pid, addDays(D, 6), '10:00', '12:00')
  const page = await newPage([pid], today, addDays(today, 20))
  const phone = newPhone()
  must(await publicApply(page.token, phone, [s.roles[0].slot_role_id]), 'public apply')
  const before = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary').pending
  must(await admin.del(`/api/admin/shift-slots/${s.slot_id}`), 'delete slot')
  const after = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary 2').pending
  ok('#65 枠を削除すると未対応件数から外れる', after === before - 1, { before, after })
  const done = (await appsOf(page.page_id, 'done')).find(a => a.phone === phone)
  ok('#65 応募は対応済みになり、明細は『枠の削除』', done && done.items.length === 1 && done.items[0].status === 'slot_removed' && !done.items[0].work_date, done)
  // 枠の編集で役割を削除した場合も、次に一覧を開いたときに片づく
  const s2 = await newRoles(pid, addDays(D, 7), '10:00', '12:00', [{ role_name: '残す', headcount: 1 }, { role_name: '消す', headcount: 1 }])
  const phone2 = newPhone()
  const del = s2.roles.find(x => x.role_name === '消す'), keep = s2.roles.find(x => x.role_name === '残す')
  must(await publicApply(page.token, phone2, [del.slot_role_id]), 'public apply 2')
  must(await admin.put(`/api/admin/shift-slots/${s2.slot_id}`, { roles: [{ ...keep }, { ...del, _delete: true }], force: true }), 'delete role')
  const d2 = (await appsOf(page.page_id, 'done')).find(a => a.phone === phone2)
  ok('#65 役割を削除した応募も『枠の削除』で処理済みになる', d2 && d2.items[0].status === 'slot_removed', d2)
}

// ---------- #501 Turnstile の鍵が片方だけ ----------
{
  const list = must(await admin.get('/api/admin/recruit-pages'), 'pages')
  // 期待する状態: TURNSTILE があればそれ。無ければ、起動に付けた鍵（npm test はテストの環境変数にも渡す）から決める（recruit.ts の turnstileState と同じ）
  const sk = !!process.env.TURNSTILE_SECRET_KEY, pk = !!process.env.TURNSTILE_SITE_KEY
  const expect = process.env.TURNSTILE || (sk && pk ? 'enabled' : pk ? 'site_key_only' : sk ? 'secret_key_only' : 'off')
  ok(`#501 管理画面に Turnstile の設定状態（${expect}）を返す`, list.turnstile === expect && list.turnstile_enabled === (expect === 'enabled'), { t: list.turnstile })
  if (expect === 'secret_key_only' || expect === 'site_key_only') {
    const s = await newRoles(pid, addDays(D, 8), '10:00', '12:00')
    const page = await newPage([pid], today, addDays(today, 20))
    const g = must(await pub.get(`/api/public/recruit/${page.token}`), 'public get')
    ok('#501 片方だけのときは公開ページに確認欄を出さない', g.turnstile_site_key === null, g.turnstile_site_key)
    const ap = await publicApply(page.token, newPhone(), [s.roles[0].slot_role_id])
    ok('#501 片方だけのときも応募を受け付ける（確認しない）', ap.status === 200 && ap.data.count === 1, ap)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
