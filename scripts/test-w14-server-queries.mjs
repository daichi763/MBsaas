// 持ち越しの棚卸し（Sprint 14）の残り: 協力会社の統合先（#161）・一覧の成約（#184）・月の絞り込み（#212）・
// メールの文言（#9414）・ログインの失敗の知らせ（#552。作業単位 w14-server-queries）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --port 8811 --persist-to <保存先> で起動していること
//   （APP_BASE_URL が http://localhost のときだけ、手元の受け口 http://127.0.0.1 へプッシュを送れる）。
//   プッシュの事業者の代わりに、このテストが 127.0.0.1 に受け口を立てる。
// 実行: BASE=http://127.0.0.1:8811 PERSIST=<保存先> node scripts/test-w14-server-queries.mjs
//   PERSIST（ローカルの D1 の保存先）がないと、D1 に直接データを作る確認は飛ばす（wrangler d1 execute は --local のみ）。
//   本番には接続しない。テストのたびに DB を作り直すこと（npm test -- w14-server-queries なら自動で行う）。
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8811'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], data: await r.json().catch(() => null) }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w14sq-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out).at(-1).results
    } catch (e) { if (i >= 3) throw e }
  }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

// ---------- 日付（JST） ----------
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const month = today.slice(0, 7)
const thisFirst = `${month}-01`
const nextFirst = (() => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01` })()
const thisLast = addDays(nextFirst, -1)
const prevLast = addDays(thisFirst, -1)
const prevMonth = prevLast.slice(0, 7)
const prevFirst = `${prevMonth}-01`

const SUF = String(Date.now()).slice(-6)
const PFX = `w14q${SUF}`
let phoneSeq = 0
const newPhone = () => '080' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')

const admin = client(await login('sample', 'admin'))
const pub = client('')
async function newStaff(k, extra = {}) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: newPhone(), ...extra }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}

// =========================================================
// #161 統合した協力会社の古い名前・ID で登録しても、統合先に所属させる
// =========================================================
if (PERSIST) {
  const oldName = `${PFX}協力旧`, newName = `${PFX}協力新`
  const p1 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: oldName }), 'partner old').affiliation_id
  const p2 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: newName }), 'partner new').affiliation_id
  // 統合元の行がまだ使われている（統合済みの印を付けて残る）状態を D1 に直接作る
  sql(`UPDATE staff_affiliations SET merged_into_id = ${p2} WHERE affiliation_id = ${p1} AND company_id = 1`)

  // スタッフの CSV 取り込み
  const header = ['区分', '氏名', 'フリガナ', '性別', '生年月日', '電話番号', 'スタッフ番号', '協力会社名']
  const rows = [
    { line: 2, cells: ['協力会社', `${PFX} 取込 統合`, '', '女性', '', newPhone(), '', oldName] },
    { line: 3, cells: ['スキルシートのみ', `${PFX} 取込 名簿`, '', '男性', '', '', '', ''] },
  ]
  const pv = await admin.post('/api/admin/roster/import/preview', { header, rows })
  const r2 = (pv.data?.rows || []).find(r => r.line === 2) || { errors: [], notes: [] }
  ok('#161 取り込みの確認で、統合済みの協力会社の名前には「統合先に所属させる」と出す（新しく登録するとは出さない）',
    pv.status === 200 && !r2.errors.length && r2.notes.some(n => n.includes('統合済み') && n.includes(newName)) && !r2.notes.some(n => n.includes('新しく登録')), pv.data)
  const cm = await admin.post('/api/admin/roster/import/commit', { header, rows, accept_warnings: true })
  ok('（前提）取り込みを登録できる', cm.status === 200, cm.data)
  const list = must(await admin.get('/api/admin/staff'), 'staff').staff
  const imp = list.find(s => s.name === `${PFX} 取込 統合`)
  const det = imp ? must(await admin.get(`/api/admin/staff/${imp.staff_id}`), 'detail').profile : null
  ok('#161 取り込みで統合済みの協力会社の名前を書いても、統合先の協力会社に所属させる（所属会社名も統合先）',
    det && det.partner_affiliation_id === p2 && det.affiliation === newName, det && { pa: det.partner_affiliation_id, aff: det.affiliation, p1, p2 })
  const cnt = sql(`SELECT COUNT(*) AS n FROM staff_affiliations WHERE company_id = 1 AND affiliation_name IN (${q(oldName)}, ${q(newName)})`)[0].n
  ok('#161 取り込みで協力会社の行を新しく作らない', cnt === 2, cnt)

  // #9414 ログインのないスタッフへのメールの設定のエラー文
  const roster = list.find(s => s.name === `${PFX} 取込 名簿`)
  if (roster) {
    const r = await admin.put(`/api/admin/staff/${roster.staff_id}`, { login_email: `${PFX}@example.com` })
    ok('#9414 ログインのないスタッフにメールを設定しようとしたときの文は「通知・パスワード再設定に使うメールアドレス」',
      r.status === 400 && /通知・パスワード再設定に使うメールアドレス/.test(r.data?.error || '') && !/ログイン用/.test(r.data?.error || ''), r.data)
  } else skip('#9414 エラー文', 'ログインのないスタッフを取り込めなかった')

  // 募集の承認で、協力会社所属のスタッフを新しく作る（画面が古いままで統合済みの協力会社を選んだ）
  const pid = await newProject(`${PFX}-募集案件`)
  const D = addDays(today, 5)
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 3 }] }), 'slot')
  const board = must(await admin.get(`/api/admin/shift-board?from=${D}&to=${D}`), 'board')
  const slot = board.slots.filter(s => s.project_id === pid).at(-1)
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 20), allow_staff: true, show_remaining: true, notify_staff: false }), 'page')
  const name = `${PFX} 応募 協力`
  const ap = await pub.post(`/api/public/recruit/${page.token}/apply`, { name, phone: newPhone(), agree: true, slot_role_ids: [slot.roles[0].slot_role_id], issued_at: Date.now() - 10000 })
  ok('（前提）公開ページから応募できる', ap.status === 200, ap.data)
  const app = must(await admin.get('/api/admin/recruit-applications?status=pending'), 'apps').applications.find(a => a.name === name)
  const dc = app ? await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`,
    { approve: app.items.map(i => i.item_id), new_staff_type: 'partner_manual', partner_affiliation_id: p1, force_new: true, force: true, notify_applicant: false }) : { status: 0 }
  ok('（前提）承認して協力会社所属のスタッフを作れる', dc.status === 200, dc.data)
  const made = must(await admin.get('/api/admin/staff'), 'staff').staff.find(s => s.name === name)
  const md = made ? must(await admin.get(`/api/admin/staff/${made.staff_id}`), 'detail').profile : null
  ok('#161 募集の承認で統合済みの協力会社を選んでも、統合先の協力会社に所属させる',
    md && md.partner_affiliation_id === p2 && md.affiliation === newName, md && { pa: md.partner_affiliation_id, aff: md.affiliation, p1, p2 })
} else skip('#161 統合済みの協力会社', 'PERSIST がない')

// =========================================================
// #184 一覧の「成約」は、テンプレートの「成約」の項目で数える。該当の項目・案件がなければ null（画面は「—」）
// #212 月の絞り込みは範囲の条件（月の最初の日・最後の日を含み、翌月の1日を含まない）
// =========================================================
if (PERSIST) {
  const P1 = await newProject(`${PFX}-成約キー`), P2 = await newProject(`${PFX}-成約名`), P3 = await newProject(`${PFX}-成約なし`), P4 = await newProject(`${PFX}-テンプレなし`)
  const P5 = await newProject(`${PFX}-請求`)
  const tpl = (name, fields) => sql(`INSERT INTO report_templates (company_id, template_name, template_type, fields_json) VALUES (1, ${q(name)}, 'custom', ${q(JSON.stringify(fields))}) RETURNING template_id`)[0].template_id
  const T1 = tpl(`${PFX}T1`, [{ key: 'seiyaku', label: '契約', type: 'number' }, { key: 'memo', label: 'メモ', type: 'text' }])
  const T2 = tpl(`${PFX}T2`, [{ key: 'visits', label: '来店', type: 'number' }, { key: 'deals', label: '成約件数', type: 'number' }])
  const T3 = tpl(`${PFX}T3`, [{ key: 'visits', label: '来店', type: 'number' }, { key: 'seiyaku_memo', label: '成約の所感', type: 'text' }])
  sql(`UPDATE projects SET report_template_id = ${T1} WHERE project_id = ${P1}; UPDATE projects SET report_template_id = ${T2} WHERE project_id = ${P2}; UPDATE projects SET report_template_id = ${T3} WHERE project_id = ${P3}; UPDATE projects SET report_template_id = NULL WHERE project_id = ${P4};`) // 作った案件には既定のテンプレートが付くので、P4 は外す
  const A = await newStaff('A'), B = await newStaff('B'), C = await newStaff('C'), Dd = await newStaff('D')
  const dr = (staff, pid, date, values) => `INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values) VALUES (1, ${staff.staff_id}, ${pid}, '${date}', ${q(JSON.stringify(values))});`
  sql([
    dr(A, P1, thisFirst, { seiyaku: 2, memo: 'x' }),
    dr(A, P1, thisLast, { seiyaku: 3 }),
    dr(A, P1, nextFirst, { seiyaku: 100 }), // 翌月の1日は数えない
    dr(A, P1, prevLast, { seiyaku: 1000 }), // 前月の最後の日も数えない
    dr(A, P2, thisFirst, { deals: 4, visits: 50 }),
    dr(B, P3, thisFirst, { visits: 10 }),
    dr(B, P4, thisFirst, { seiyaku: 7 }), // テンプレートのない案件の値は数えない
  ].join('\n'))
  const sh = (staff, pid, date, start, end, status = 'confirmed', payee = null) =>
    `INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, payee_affiliation_id) VALUES (1, ${staff.staff_id}, ${pid}, '${date}', '${start}', '${end}', '${status}', ${payee ?? 'NULL'});`
  sql(sh(C, P1, thisFirst, '10:00', '12:00'))

  const staffList = must(await admin.get('/api/admin/staff'), 'staff').staff
  const by = (s) => staffList.find(x => x.staff_id === s.staff_id) || {}
  ok('#184 スタッフ一覧の今月成約は、案件のテンプレートの「成約」の項目（キー seiyaku・表示名に「成約」）を合計する（翌月・前月は数えない）', by(A).month_seiyaku === 9, by(A).month_seiyaku)
  ok('#184 今月、テンプレートに「成約」の項目がある案件が1つもない人は null（画面は「—」）', by(B).month_seiyaku === null, by(B).month_seiyaku)
  ok('#184 該当の案件のシフトがあって日報がまだない人は 0', by(C).month_seiyaku === 0, by(C).month_seiyaku)
  ok('#184 今月の稼働も何もない人は null', by(Dd).month_seiyaku === null, by(Dd).month_seiyaku)

  const projs = (m) => admin.get(`/api/admin/projects${m ? `?month=${m}` : ''}`)
  const pl = must(await projs(), 'projects').projects
  const pv = (id) => (pl.find(p => p.project_id === id) || {}).month_seiyaku
  ok('#184 案件一覧の成約: キー seiyaku の項目を合計する', pv(P1) === 5, pv(P1))
  ok('#184 案件一覧の成約: キーが違っても表示名に「成約」を含む数値の項目を合計する', pv(P2) === 4, pv(P2))
  ok('#184 案件一覧の成約: 「成約」の数値の項目がない案件（文字の項目だけ・テンプレートなし）は null', pv(P3) === null && pv(P4) === null, { P3: pv(P3), P4: pv(P4) })
  const plPrev = must(await projs(prevMonth), 'projects prev').projects
  ok('#184 #212 月を選ぶと、その月の範囲で数える（前月の最後の日の分）', (plPrev.find(p => p.project_id === P1) || {}).month_seiyaku === 1000, plPrev.find(p => p.project_id === P1))
  // 画面: 一覧の「成約」の列
  const js = await (await fetch(`${BASE}/static/admin.js`)).text()
  ok('#184 画面: 成約が null のときは 0 ではなく「—」と出す（スタッフ一覧・案件一覧）',
    js.includes('const seiyakuCell') && (js.match(/seiyakuCell\((s|p)\.month_seiyaku/g) || []).length === 2 && !/Number\((s|p)\.month_seiyaku \|\| 0\)/.test(js))

  // #212 ダッシュボードの今月の案件別実績（日報の件数・成約）
  const dash = must(await admin.get('/api/admin/dashboard'), 'dashboard')
  const perf = (dash.project_performance || []).find(p => p.project_id === P1)
  ok('#212 ダッシュボードの案件別実績は、今月の最初の日と最後の日の日報を数え、翌月・前月の日報は数えない', perf && perf.report_count === 2 && perf.values.seiyaku === 5, perf)
  // #212 欠勤が月2回以上の ToDo（今日までの今月の分だけ）
  sql(sh(Dd, P5, thisFirst, '09:00', '10:00', 'absent') + sh(Dd, P5, prevLast, '09:00', '10:00', 'absent'))
  const todoKeys = (d) => [...(d.todos || []), ...(d.hidden_todos || [])].map(t => t.key)
  const k = `absent:${Dd.staff_id}:${month}`
  ok('#212 欠勤の ToDo は前月の欠勤を数えない（今月1回だけなら出ない）', !todoKeys(must(await admin.get('/api/admin/dashboard'), 'dash')).includes(k))
  sql(sh(Dd, P5, thisFirst, '11:00', '12:00', 'absent'))
  ok('#212 今月の欠勤が2回になると ToDo に出る', todoKeys(must(await admin.get('/api/admin/dashboard'), 'dash')).includes(k))

  // #212 請求前確認（月の範囲）と、協力会社の一覧の今月の稼働
  const Q = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}支払先` }), 'partner Q').affiliation_id
  sql([
    sh(C, P5, prevFirst, '13:00', '15:00'),
    sh(C, P5, prevLast, '13:00', '15:00', 'confirmed', Q),
    sh(C, P5, thisFirst, '13:00', '15:00', 'confirmed', Q),
    sh(C, P5, nextFirst, '13:00', '15:00', 'confirmed', Q),
  ].join('\n'))
  const bc = must(await admin.get(`/api/admin/billing-check?month=${prevMonth}`), 'billing check')
  const bp = (bc.by_project || []).find(p => p.project_id === P5)
  const bd = (bc.detail || []).filter(d => d.project_id === P5 && d.staff_id === C.staff_id)
  ok('#212 請求前確認は、選んだ月の最初の日と最後の日のシフトを数え、翌月のシフトは数えない', bp && bp.work_days === 2 && bp.absent_days === 1 && bd.length === 1 && bd[0].work_days === 2, { bp, bd })
  const parts = must(await admin.get('/api/admin/roster/partners'), 'partners').partners
  const pq = parts.find(p => p.affiliation_id === Q)
  ok('#212 協力会社の一覧の今月の稼働は、今月のシフトだけを数える（前月の最後の日・翌月の1日は数えない）', pq && pq.month_shifts === 1 && pq.month_staff === 1, pq)
} else skip('#184 #212 一覧の成約・月の範囲', 'PERSIST がない')

// =========================================================
// #9414 メールアドレスの確認ページ・確認メールの文言
// =========================================================
{
  const html = await (await fetch(`${BASE}/verify-email?token=x`)).text()
  ok('#9414 確認ページの文は「通知・パスワード再設定に使うメールアドレス」（「ログイン用」と書かない）',
    html.includes('通知・パスワード再設定に使うメールアドレスとして登録します') && !html.includes('ログイン用（'), html.slice(0, 200))
}

// =========================================================
// #552 ログインの失敗が続いたら、会社管理者にアプリ内通知とプッシュ通知（同じ ID は1時間に1回まで。本部・存在しない ID には送らない）
// =========================================================
const received = []
const server = http.createServer((req, res) => {
  req.on('data', () => { })
  req.on('end', () => { received.push({ path: req.url }); res.statusCode = 201; res.end() })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const EP = (p) => `http://127.0.0.1:${server.address().port}${p}`
const waitPush = async (path, since, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = received.slice(since).find(x => x.path === path)
    if (hit) return hit
    await sleep(200)
  }
  return null
}
const KEYS = { p256dh: 'BOr4bW1kZXZpY2VLZXlGb3JUZXN0aW5nT25seQ', auth: 'dGVzdEF1dGhLZXk' }
{
  const mgr = client(await login('sample', 'mgr01'))
  const staffC = client(await login('sample', 'st001'))
  // 会社の管理者の端末のプッシュの購読（/api/admin/push/*）
  const cfg = must(await admin.get('/api/admin/push/config'), 'push config')
  ok('#552 会社の管理者はプッシュの購読の設定を読める（/api/admin/push/config）', cfg.available === true && typeof cfg.public_key === 'string', cfg)
  ok('#552 スタッフは管理者のプッシュの購読を使えない（403）', (await staffC.get('/api/admin/push/config')).status === 403)
  const sub = await admin.post('/api/admin/push/subscribe', { endpoint: EP('/admin-push'), keys: KEYS })
  ok('#552 会社の管理者がこの端末でプッシュを受け取る設定にできる', sub.status === 200, sub.data)
  const sub2 = await mgr.post('/api/admin/push/subscribe', { endpoint: EP('/mgr-push'), keys: KEYS })
  ok('（前提）現場の管理者も購読はできる', sub2.status === 200, sub2.data)

  const X = await newStaff('X')
  const fails = async (code, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await rawLogin('sample', code, 'wrong-password-' + i)).status); return out }
  const inbox = async (c = admin) => (must(await c.get('/api/admin/notifications?kind=login_failures'), 'inbox').notifications || []).filter(n => n.related_id === X.user_id)
  const since0 = received.length
  const st4 = await fails(X.user_code, 4)
  ok('（前提）間違ったパスワードは 401', st4.every(s => s === 401), st4)
  ok('#552 4回までの失敗では知らせない', (await inbox()).length === 0)
  await fails(X.user_code, 1)
  const n1 = await inbox()
  ok('#552 同じ ID で5回続けて失敗すると、会社管理者にアプリ内通知が届く（ID と名前と回数）',
    n1.length === 1 && n1[0].title.includes(X.user_code) && n1[0].title.includes(X.name) && /5回/.test(n1[0].body) && n1[0].link === '/admin#security', n1)
  ok('#552 通知の文に、入力されたパスワードを入れない', n1.length === 1 && !JSON.stringify(n1[0]).includes('wrong-password'), n1)
  ok('#552 会社管理者以外の管理ロール（現場の管理者）には送らない', (await inbox(mgr)).length === 0)
  ok('#552 会社管理者の端末にプッシュ通知を送る', !!(await waitPush('/admin-push', since0)))
  ok('#552 現場の管理者の端末にはプッシュ通知を送らない', !received.slice(since0).some(x => x.path === '/mgr-push'))
  const latest = await admin.get(`/api/admin/push/latest?endpoint=${encodeURIComponent(EP('/admin-push'))}`)
  ok('#552 端末がプッシュを受けて取りに来ると、ログインの失敗の通知を出す（開く先は管理画面のセキュリティ）',
    latest.status === 200 && latest.data.title === n1[0]?.title && latest.data.link === '/admin#security' && !latest.data.generic, latest.data)

  const since1 = received.length
  await fails(X.user_code, 2)
  ok('#552 同じ ID は1時間に1回まで（続けて失敗しても通知は増えない）', (await inbox()).length === 1)
  await sleep(1500)
  ok('#552 1時間の間はプッシュ通知も送らない', !received.slice(since1).some(x => x.path === '/admin-push'))

  if (PERSIST) {
    // 1時間たった後の状態を作る（通知の日時を2時間前にする）。ログインに成功すると数え直す
    sql(`UPDATE user_notifications SET created_at = datetime('now', '+9 hours', '-2 hours') WHERE kind = 'login_failures' AND related_id = ${X.user_id}; DELETE FROM login_attempts;`)
    const okLogin = await rawLogin('sample', X.user_code)
    ok('（前提）正しいパスワードでログインできる', okLogin.status === 200, okLogin)
    await fails(X.user_code, 4)
    ok('#552 ログインに成功すると数え直す（成功の後の4回では知らせない）', (await inbox()).length === 1)
    await fails(X.user_code, 1)
    ok('#552 1時間たった後に、また5回続けて失敗すると、もう一度知らせる', (await inbox()).length === 2)
    const roles = sql(`SELECT DISTINCT u.role FROM user_notifications n JOIN users u ON u.user_id = n.user_id WHERE n.kind = 'login_failures'`).map(r => r.role)
    ok('#552 宛先は会社管理者だけ', roles.length === 1 && roles[0] === 'company_admin', roles)
    sql('DELETE FROM login_attempts;')
  } else skip('#552 1時間たった後・宛先のロール', 'PERSIST がない')

  // 存在しない ID・本部の ID
  const before = (must(await admin.get('/api/admin/notifications?kind=login_failures'), 'inbox').notifications || []).length
  await fails(`${PFX}nobody`, 6)
  for (let i = 0; i < 5; i++) await rawLogin('', 'hq', 'wrong-password-hq-' + i)
  const after = (must(await admin.get('/api/admin/notifications?kind=login_failures'), 'inbox').notifications || []).length
  ok('#552 存在しない ID・本部の ID の失敗では、会社管理者に知らせない', after === before, { before, after })
  if (PERSIST) {
    const hqN = sql(`SELECT COUNT(*) AS n FROM user_notifications n JOIN users u ON u.user_id = n.user_id WHERE n.kind = 'login_failures' AND u.role = 'system_admin'`)[0].n
    ok('#552 本部には送らない', hqN === 0, hqN)
    sql('DELETE FROM login_attempts;')
  }
  // 画面: 受け取り設定に、会社管理者だけのプッシュ通知の欄
  const njs = await (await fetch(`${BASE}/static/notifications.js`)).text()
  ok('#552 画面: 通知の受け取り設定に、この端末のプッシュ通知の欄（会社管理者だけ。/api/admin/push/*・scope /admin）',
    njs.includes("hasPerm('admin_push.device')") && njs.includes('/api/admin/push/subscribe') && njs.includes("ADMIN_PUSH_SCOPE = '/admin'") && njs.includes("login_failures: 'ログインの失敗'"))
  const swjs = await (await fetch(`${BASE}/sw.js`)).text()
  ok('#552 Service Worker は scope /admin のとき /api/admin/push/latest を取りに来る', swjs.includes("ADMIN ? '/admin'") && swjs.includes('staff|hq|admin'))
}

server.close()
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
