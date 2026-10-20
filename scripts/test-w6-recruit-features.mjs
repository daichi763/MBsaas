// 募集・掲示板の機能追加（w6-recruit-features: #287 #300 #478 #479）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8814 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8814 PERSIST=<保存先> node scripts/test-w6-recruit-features.mjs
//   PERSIST を指定すると、ローカルの D1 を直接書き換える確認（保存した条件の新着の知らせ・仮登録のメモ）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8814'
const PERSIST = process.env.PERSIST || ''
let sqlSeq = 0, SQL_DIR = ''
function sql(command) {
  SQL_DIR = SQL_DIR || mkdtempSync(join(tmpdir(), 'w6rf-'))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
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
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'RF' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '070' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const pub = client(null)

async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k, phone) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newRoles(pid, date, start = '10:00', end = '18:00', roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  const slots = b.slots.filter(s => s.project_id === pid && s.start_time === start)
  return slots[slots.length - 1]
}
const listApps = async (params) => must(await admin.get('/api/admin/recruit-applications?' + new URLSearchParams(params)), 'apps')
const publicApply = (token, phone, roleIds, name, extra = {}) =>
  pub.post(`/api/public/recruit/${token}/apply`, { name, phone, agree: true, slot_role_ids: roleIds, issued_at: Date.now() - 10000, ...extra })

const pid = await newProject(`${PFX}-案件`)
const D = addDays(today, 6)

// ---------- #300 募集ページの独自の質問 ----------
const Q = [
  { label: '携帯販売の経験はありますか', type: 'yesno', required: true },
  { label: '保有資格', type: 'select', options: 'なし, 販売士, 携帯電話販売の資格', required: false },
  { label: '来られる交通手段', type: 'text' },
]
const base = { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true, show_remaining: true, notify_staff: false, description: '', pay_note: '', contact_note: '' }
{
  const bad1 = await admin.post('/api/admin/recruit-pages', { ...base, questions: [{ label: '資格', type: 'select', options: ['なし'] }] })
  ok('#300 選択肢が1つだけの質問は 400', bad1.status === 400 && /選択肢/.test(bad1.data?.error), bad1)
  const bad2 = await admin.post('/api/admin/recruit-pages', { ...base, questions: Array.from({ length: 6 }, (_, i) => ({ label: `質問${i}`, type: 'text' })) })
  ok('#300 質問が6問以上は 400', bad2.status === 400 && /5問/.test(bad2.data?.error), bad2)
}
const page = must(await admin.post('/api/admin/recruit-pages', { ...base, questions: Q }), 'page')
let adminPage = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(p => p.page_id === page.page_id)
ok('#300 質問に q1〜q3 の key を振って保存する', adminPage && adminPage.questions.map(q => q.key).join() === 'q1,q2,q3' && adminPage.questions[1].options.length === 3, adminPage?.questions)
{
  const g = must(await pub.get(`/api/public/recruit/${page.token}`), 'public get')
  ok('#300 公開ページに質問（文言・形式・必須・選択肢）を返す', g.questions.length === 3 && g.questions[0].type === 'yesno' && g.questions[0].required === true && g.questions[1].options.includes('販売士'), g.questions)
}
const s1 = await newRoles(pid, D, '10:00', '18:00', [{ role_name: '販売', headcount: 3 }])
const role1 = s1.roles[0].slot_role_id
{
  const r1 = await publicApply(page.token, newPhone(), [role1], `${PFX} 回答なし`)
  ok('#300 必須の質問に答えていないときは 400（field=q_q1）', r1.status === 400 && r1.data.field === 'q_q1', r1)
  const r2 = await publicApply(page.token, newPhone(), [role1], `${PFX} 選択肢外`, { answers: { q1: 'yes', q2: '英検' } })
  ok('#300 選択肢にない回答は 400（field=q_q2）', r2.status === 400 && r2.data.field === 'q_q2', r2)
  const r3 = await publicApply(page.token, newPhone(), [role1], `${PFX} 回答あり`, { answers: { q1: 'yes', q2: '販売士', q3: '<b>電車</b>' } })
  ok('#300 質問に答えた応募を受け付ける', r3.status === 200 && r3.data.count === 1, r3)
  const app = (await listApps({ status: 'pending', page_id: page.page_id })).applications.find(a => a.name === `${PFX} 回答あり`)
  ok('#300 応募一覧に質問の文言と回答を返す（はい・いいえは文字で）', app && app.answers.length === 3 && app.answers[0].label === Q[0].label && app.answers[0].value === 'はい' && app.answers[2].value === '<b>電車</b>', app?.answers)
}
{
  // 既存の質問の key を保ったまま並べ替え・追加する。質問を送らない更新では変えない
  const qs = adminPage.questions
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { questions: [qs[1], { label: '18歳以上ですか', type: 'yesno', required: true }] }), 'put questions')
  adminPage = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(p => p.page_id === page.page_id)
  ok('#300 編集: 既存の質問の key を保ち、新しい質問には使っていない番号を振る', adminPage.questions.map(q => q.key).join() === 'q2,q4', adminPage.questions)
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { title: `${PFX} 募集（改）` }), 'put title')
  adminPage = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(p => p.page_id === page.page_id)
  ok('#300 質問を送らない更新では質問を変えない', adminPage.questions.length === 2, adminPage.questions)
  const old = (await listApps({ status: 'pending', page_id: page.page_id })).applications.find(a => a.name === `${PFX} 回答あり`)
  ok('#300 質問を変えても、応募の回答の控えは応募の時点のまま', old && old.answers[0].label === Q[0].label, old?.answers)
}

// ---------- #478 対応メモ・対応者 ----------
{
  const apps = (await listApps({ status: 'pending', page_id: page.page_id })).applications
  const app = apps.find(a => a.name === `${PFX} 回答あり`)
  const empty = await admin.post(`/api/admin/recruit-applications/${app.application_id}/notes`, { body: '  ' })
  ok('#478 空のメモは 400', empty.status === 400, empty)
  const n1 = await admin.post(`/api/admin/recruit-applications/${app.application_id}/notes`, { body: '電話済み' })
  ok('#478 メモを残すと、書いた人と日時つきで返す', n1.status === 200 && n1.data.notes.length === 1 && n1.data.notes[0].body === '電話済み' && !!n1.data.notes[0].author_name && n1.data.notes[0].mine === true, n1)
  const n2 = await mgr.post(`/api/admin/recruit-applications/${app.application_id}/notes`, { body: '不在（折り返し待ち）' })
  ok('#478 ほかの管理者もメモを足せる', n2.status === 200 && n2.data.notes.length === 2, n2)
  const listed = (await listApps({ status: 'pending', page_id: page.page_id })).applications.find(a => a.application_id === app.application_id)
  ok('#478 応募一覧にメモの履歴を返す（自分のメモに mine）', listed.notes.length === 2 && listed.notes[0].mine === true && listed.notes[1].mine === false, listed.notes)
  const noNote = (await listApps({ status: 'pending', page_id: page.page_id, no_note: '1' })).applications
  ok('#478 「対応メモなしのみ」でメモのある応募を除く', !noNote.some(a => a.application_id === app.application_id), noNote.map(a => a.application_id))
  const delOther = await mgr.del(`/api/admin/recruit-applications/${app.application_id}/notes/${n1.data.notes[0].note_id}`)
  ok('#478 他人のメモは消せない（404）', delOther.status === 404, delOther)
  const delMine = await admin.del(`/api/admin/recruit-applications/${app.application_id}/notes/${n1.data.notes[0].note_id}`)
  ok('#478 自分のメモは消せる', delMine.status === 200 && delMine.data.notes.length === 1, delMine)

  // 仮登録で承認すると、回答をスタッフのメモに引き継ぎ、対応者を返す
  const d = await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), new_staff_type: 'daily_worker', force_new: true, notify_applicant: false })
  ok('#300 仮登録を作って承認できる', d.status === 200 && d.data.created_staff, d)
  const done = (await listApps({ status: 'done', page_id: page.page_id })).applications.find(a => a.application_id === app.application_id)
  ok('#478 対応済みの応募に対応者の名前（decided_by_name）を返す', done && !!done.decided_by_name && !!done.decided_at, done && { n: done.decided_by_name, at: done.decided_at })
  if (PERSIST && d.data?.staff_id) {
    const m = sql(`SELECT memo FROM staff_profiles WHERE staff_id = ${Number(d.data.staff_id)}`)[0]?.memo || ''
    ok('#300 仮登録のスタッフのメモに回答を引き継ぐ', /応募時の回答/.test(m) && /携帯販売の経験はありますか: はい/.test(m), m)
  } else skip('#300 仮登録のスタッフのメモに回答を引き継ぐ')
}

// ---------- #287 まとめて承認（画面は応募ごとに承認の API を順に呼ぶ。確認が必要な日時は承認しない） ----------
{
  const st1 = await newStaff('a', newPhone()), st2 = await newStaff('b', newPhone())
  const c1 = client(await login('sample', `${PFX}a`)), c2 = client(await login('sample', `${PFX}b`))
  const pageS = must(await admin.post('/api/admin/recruit-pages', { ...base, title: `${PFX} スタッフ募集` }), 'page S')
  const full = await newRoles(pid, addDays(D, 1), '09:00', '12:00', [{ role_name: '受付', headcount: 1 }])
  const open = await newRoles(pid, addDays(D, 2), '09:00', '12:00', [{ role_name: '受付', headcount: 2 }])
  must(await c1.post('/api/staff/recruit/apply', { page_id: pageS.page_id, slot_role_ids: [full.roles[0].slot_role_id] }), 'apply 1')
  must(await c2.post('/api/staff/recruit/apply', { page_id: pageS.page_id, slot_role_ids: [full.roles[0].slot_role_id, open.roles[0].slot_role_id] }), 'apply 2')
  const apps = (await listApps({ status: 'pending', page_id: pageS.page_id })).applications
  const a1 = apps.find(a => a.staff_id === st1.staff_id), a2 = apps.find(a => a.staff_id === st2.staff_id)
  ok('#287 登録済みスタッフの応募は staff_id 付きで一覧に出る（まとめて承認の対象）', a1 && a2 && !a1.staff_inactive, apps.map(a => a.staff_id))
  // 1人目: 警告なしで承認できる
  const r1 = await admin.post(`/api/admin/recruit-applications/${a1.application_id}/decide`, { approve: a1.items.map(i => i.item_id), notify_applicant: false })
  ok('#287 警告のない日時は force なしで承認される', r1.status === 200 && r1.data.created_shifts === 1, r1)
  // 2人目: 定員に達した日時を含むので、まとめて送ると警告で止まる（何も処理しない）
  const r2 = await admin.post(`/api/admin/recruit-applications/${a2.application_id}/decide`, { approve: a2.items.map(i => i.item_id), notify_applicant: false })
  ok('#287 確認が必要な日時を含むと 409 need_force で、何も承認しない', r2.status === 409 && r2.data.need_force && r2.data.warnings.some(w => /定員/.test(w)), r2)
  // 画面と同じく1件ずつ送り直す: 警告のない日時だけ承認され、警告のある日時は未対応のまま残る
  const fullItem = a2.items.find(i => i.slot_role_id === full.roles[0].slot_role_id), openItem = a2.items.find(i => i.slot_role_id === open.roles[0].slot_role_id)
  const r3 = await admin.post(`/api/admin/recruit-applications/${a2.application_id}/decide`, { approve: [fullItem.item_id], notify_applicant: false })
  const r4 = await admin.post(`/api/admin/recruit-applications/${a2.application_id}/decide`, { approve: [openItem.item_id], notify_applicant: false })
  ok('#287 1件ずつ: 定員を超える日時は 409、空きのある日時は承認', r3.status === 409 && r3.data.need_force && r4.status === 200 && r4.data.created_shifts === 1, { r3: r3.status, r4: r4.data })
  const after = (await listApps({ status: 'pending', page_id: pageS.page_id })).applications.find(a => a.application_id === a2.application_id)
  ok('#287 警告のあった日時は未対応のまま残る', after && after.items.find(i => i.item_id === fullItem.item_id).status === 'pending' && after.items.find(i => i.item_id === openItem.item_id).status === 'approved', after?.items.map(i => i.status))
}

// ---------- #479 掲示板の検索条件の保存と新着の知らせ ----------
{
  const hq = client((await rawLogin('', 'hq')).cookie)
  const coCode = `w6rf${PFX.toLowerCase()}`
  const created = must(await hq.post('/api/hq/companies', { company_code: coCode, company_name: `W6RF 人材社${PFX}`, admin_code: 'boss', admin_name: '人材 太郎', admin_email: `${coCode}@example.com` }), 'company')
  const tmpB = client(await login(coCode, 'boss', created.admin_temp_password))
  must(await tmpB.post('/api/auth/change-password', { current_password: created.admin_temp_password, new_password: 'boss-pass-1' }), 'change password')
  const B = client(await login(coCode, 'boss', 'boss-pass-1'))

  // 他社の応募にはメモを残せない（#478 の会社の確認）
  const anyApp = (await listApps({ status: 'all' })).applications[0]
  const cross = await B.post(`/api/admin/recruit-applications/${anyApp.application_id}/notes`, { body: '他社から' })
  ok('#478 他社の応募にはメモを残せない（404）', cross.status === 404, cross)

  const cond = { engagement_type: 'spot', prefecture: '東京都', area: '', date: '', skill: 'MNP', q: '' }
  const sv = await B.post('/api/admin/board/saved-searches', { ...cond, name: '' })
  ok('#479 検索条件を保存できる（名前は条件から付ける）', sv.status === 200 && sv.data.search_id && /スポット/.test(sv.data.name), sv)
  const dup = await B.post('/api/admin/board/saved-searches', { ...cond })
  ok('#479 同じ条件は二重に保存しない（409）', dup.status === 409, dup)
  const list = must(await B.get('/api/admin/board/saved-searches'), 'saved list')
  ok('#479 保存した条件の一覧を返す', list.searches.length === 1 && list.searches[0].conditions.skill === 'MNP' && list.searches[0].notify === true && list.searches[0].notify_email === false, list)
  const other = await admin.get('/api/admin/board/saved-searches')
  ok('#479 保存した条件は利用者ごと（他社・他の人には見えない）', other.status === 200 && !other.data.searches.some(s => s.search_id === sv.data.search_id), other.data)
  const put = await B.put(`/api/admin/board/saved-searches/${sv.data.search_id}`, { notify_email: true, name: '東京のMNP' })
  ok('#479 名前・メールの知らせを変えられる', put.status === 200 && must(await B.get('/api/admin/board/saved-searches'), 'l').searches[0].notify_email === true, put)
  const otherPut = await admin.put(`/api/admin/board/saved-searches/${sv.data.search_id}`, { notify: false })
  ok('#479 他人の条件は変えられない（404）', otherPut.status === 404, otherPut)

  // 掲載: 条件に合うもの・合わないもの（大阪）・自社（B）の掲載
  const spot = (extra) => ({ status: 'open', engagement_type: 'spot', title: `W6RF 掲載${PFX}`, prefecture: '東京都', date_from: addDays(today, 20), time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 1, required_skills: 'MNP,販売', ...extra })
  must(await admin.post('/api/admin/board/posts', spot({ title: `W6RF 合う${PFX}` })), 'post match')
  must(await admin.post('/api/admin/board/posts', spot({ title: `W6RF 大阪${PFX}`, prefecture: '大阪府' })), 'post osaka')
  must(await admin.post('/api/admin/board/posts', spot({ title: `W6RF スキル違い${PFX}`, required_skills: '販売' })), 'post skill')
  must(await B.post('/api/admin/board/posts', spot({ title: `W6RF 自社${PFX}` })), 'post own')

  if (PERSIST) {
    // 前日に確認した状態にしてから、その日はじめての未読件数の確認を行う
    // 同じ掲載に合う2つ目の条件（キーワードでこの回の掲載だけに絞る）。新着の件数は、複数の条件に合う掲載を1件と数える
    const sv2 = must(await B.post('/api/admin/board/saved-searches', { ...cond, skill: '', q: `合う${PFX}`, name: '2つ目' }), 'saved 2')
    sql(`UPDATE board_saved_searches SET last_checked_at = '${addDays(today, -1)} 00:00:00' WHERE search_id IN (${Number(sv.data.search_id)}, ${Number(sv2.search_id)})`)
    must(await B.get('/api/admin/board/unread-count'), 'unread-count')
    const ns = must(await B.get('/api/admin/notifications?kind=board_saved_search'), 'notifications').notifications
    const n = ns[0]
    // 同じ DB でテストを繰り返したときは、前の回の掲載も新着に入るため、この回の掲載（PFX）で確かめる
    ok('#479 条件に合う他社の新しい掲載だけを1件の通知にまとめて知らせる', ns.length === 1 && /新着 \d+件/.test(n.title) && n.body.includes(`W6RF 合う${PFX}`)
      && !n.body.includes(`大阪${PFX}`) && !n.body.includes(`自社${PFX}`) && !n.body.includes(`スキル違い${PFX}`), ns)
    const first = n && (n.body.split('\n').find(l => l.startsWith('「東京のMNP」')) || '').match(/ (\d+)件:/)
    ok('#479 条件ごとの件数を出し、全体の件数は重なる掲載を1件と数える', n && n.body.split('\n').length === 2 && /「2つ目」 1件: /.test(n.body) && first && n.title.includes(`新着 ${first[1]}件`), n)
    ok('#479 条件が複数のときの通知のリンクは掲示板の一覧', n && n.link === '/admin#board', n?.link)
    must(await B.del(`/api/admin/board/saved-searches/${sv2.search_id}`), 'del 2')
    const row = sql(`SELECT last_checked_at, prev_checked_at FROM board_saved_searches WHERE search_id = ${Number(sv.data.search_id)}`)[0]
    ok('#479 確認の日時を進める（同じ日に二重に知らせない）', row && row.last_checked_at.slice(0, 10) === today && row.prev_checked_at.startsWith(addDays(today, -1)), row)
    const mail = sql(`SELECT COUNT(*) AS n FROM email_logs WHERE type = 'board_saved_search' AND company_id = (SELECT company_id FROM users WHERE user_id = (SELECT user_id FROM board_saved_searches WHERE search_id = ${Number(sv.data.search_id)}))`)[0]
    ok('#479 メールを選んだ条件は、まとめのメールを1通送る（email_logs）', Number(mail?.n) === 1, mail)
  } else skip('#479 新着の通知')

  const del = await B.del(`/api/admin/board/saved-searches/${sv.data.search_id}`)
  ok('#479 保存した条件を削除できる', del.status === 200 && must(await B.get('/api/admin/board/saved-searches'), 'l').searches.length === 0, del)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
