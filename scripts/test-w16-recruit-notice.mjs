// w16-recruit-notice（#9801）の統合テスト: 止めている「新しい募集」の通知をスタッフに出さない
//  - スタッフアプリの募集は外した（D-22。Sprint 20 の #9926 でコードと環境変数 STAFF_APP_RECRUIT も外した）。止める前に作った recruit_new の通知を、
//    スタッフの通知の一覧・未読の数（unread-count・badges）・プッシュ（push/latest と送信）に出さない。行は消さない・既読にもしない
//  - 新しい募集を作っても recruit_new の通知・メールは作らない。受け取り設定に「新しい募集」を出さない（「応募の結果」は残す）
//  - 管理者の通知の一覧はこの絞り込みの影響を受けない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8810 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（古い通知の行をローカルの D1 に直接入れる。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w16-recruit-notice.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import http from 'http'
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function login(company_code, user_code, password = 'pass1234') {
  const send = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await send().catch(async () => { await sleep(1000); return send() })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

// ---------- プッシュの事業者の代わりの受け口 ----------
const received = []
const server = http.createServer((req, res) => {
  req.on('data', () => { })
  req.on('end', () => { received.push({ path: req.url, at: Date.now() }); res.statusCode = 201; res.end() })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const EP = (p) => `http://127.0.0.1:${server.address().port}${p}`
const KEYS = { p256dh: 'BOr4bW1kZXZpY2VLZXlGb3JUZXN0aW5nT25seQ', auth: 'dGVzdEF1dGhLZXk' }
const waitPush = async (path, since, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = received.slice(since).find(x => x.path === path)
    if (hit) return hit
    await sleep(200)
  }
  return null
}

try {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
  const PFX = 'RN' + Date.now().toString(36).slice(-4).toUpperCase()
  const tag = PFX.toLowerCase()
  const admin = client(await login('sample', 'admin'))
  const phone = '080' + String(Date.now() % 100000000).padStart(8, '0')
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}A`, name: `${PFX} 募集通知`, password: 'pass1234', phone, email: `${tag}-a@example.com` }), 'staff')
  const staff = client(await login('sample', `${PFX}A`))
  const me = must(await staff.get('/api/auth/me'), 'me')
  const UID = Number(me.user?.user_id ?? me.user_id)
  const CID = Number(me.user?.company_id ?? me.company_id)
  if (!UID || !CID) throw new Error('me: ' + JSON.stringify(me).slice(0, 300))

  // 端末を登録しておく（プッシュが届くかを確かめる）
  const sub = await staff.post('/api/staff/push/subscribe', { endpoint: EP('/push/staff'), keys: KEYS })
  ok('準備: スタッフの端末をプッシュの受け口に登録できる', sub.status === 200, sub.data)

  // ---------- 止める前に作られた「新しい募集」の通知（10/23 の報告の状態）を入れる ----------
  const OLD_BODY = '期間: 10/23(金)〜10/31(土)\nシフト画面の「募集中のお仕事」から応募できます'
  const since1 = received.length
  d1(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES
    (${CID}, ${UID}, 'recruit_new', ${q(`新しい募集があります: ${PFX} 古い募集1`)}, ${q(OLD_BODY)}, '#shift', 999901, '2026-10-23 09:00:00'),
    (${CID}, ${UID}, 'recruit_new', ${q(`新しい募集があります: ${PFX} 古い募集2`)}, ${q(OLD_BODY)}, '#shift', 999902, '2026-10-23 10:00:00')`)
  const queued = d1(`SELECT COUNT(*) AS n FROM push_queue WHERE user_id = ${UID} AND kind = 'recruit_new'`)[0][0].n
  ok('準備: 古い通知の行を入れると、トリガーでプッシュが積まれる（送る側で止めるかを確かめる）', Number(queued) === 2, queued)
  // 書き込みの API の応答の後に、積まれたプッシュを送る（存在しない通知の既読。何も変えずに 404 を返す）
  await staff.post('/api/staff/notifications/999999999/read', {})
  await sleep(2500)
  ok('#9801 「新しい募集」の通知はプッシュで送らない（端末に届かない）', !received.slice(since1).some(x => x.path === '/push/staff'), received.slice(since1))
  const left = d1(`SELECT COUNT(*) AS n FROM push_queue WHERE user_id = ${UID} AND kind = 'recruit_new' AND claimed_at IS NULL`)[0][0].n
  ok('#9801 送らなかったプッシュは積んだままにしない', Number(left) === 0, left)

  // ---------- 一覧・未読の数 ----------
  const list0 = must(await staff.get('/api/staff/notifications'), 'list')
  ok('#9801 スタッフの通知の一覧に「新しい募集」を出さない', !list0.notifications.some(n => n.kind === 'recruit_new'), list0.notifications.map(n => n.kind))
  ok('#9801 一覧の本文に「募集中のお仕事」から応募できます、が出ない', !list0.notifications.some(n => /募集中のお仕事/.test(`${n.title}\n${n.body}`)), list0.notifications)
  ok('#9801 一覧の未読の数・種類ごとの未読の数にも数えない', list0.unread === 0 && !('recruit_new' in (list0.unread_by_kind || {})), { unread: list0.unread, by: list0.unread_by_kind })
  const byKind = must(await staff.get('/api/staff/notifications?kind=recruit_new'), 'list kind')
  ok('#9801 種類を recruit_new に絞っても出さない', byKind.notifications.length === 0, byKind.notifications)
  const cnt0 = must(await staff.get('/api/staff/notifications/unread-count'), 'unread-count')
  ok('#9801 未読の数（ホームの「未読の通知があります」・その他の件数）に数えない', cnt0.count === 0, cnt0)
  const badges0 = must(await staff.get('/api/staff/badges'), 'badges')
  ok('#9801 下のタブ・その他のメニューのバッジにも数えない', badges0.notifications === 0, badges0)

  // ---------- ほかの通知は今までどおり出る（プッシュも送る） ----------
  const since2 = received.length
  d1(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES
    (${CID}, ${UID}, 'shift_assigned', ${q(`${PFX} シフトが入りました`)}, '11/5(木) 10:00〜19:00', '#shift', NULL, '2026-10-24 09:00:00')`)
  await staff.post('/api/staff/notifications/999999999/read', {})
  ok('#9801 ほかの通知（シフトの登録）はプッシュで送る', !!(await waitPush('/push/staff', since2)), received.slice(since2))
  const lat = must(await staff.get(`/api/staff/push/latest?endpoint=${encodeURIComponent(EP('/push/staff'))}`), 'push latest')
  ok('#9801 端末が取りに来る中身は、新しい募集ではなくシフトの通知（「ほか N 件の未読」に新しい募集を数えない）',
    lat.title === `${PFX} シフトが入りました` && !/ほか\d+件/.test(lat.body) && !/募集/.test(`${lat.title}${lat.body}`), lat)
  const list1 = must(await staff.get('/api/staff/notifications'), 'list1')
  ok('#9801 ほかの通知は一覧・未読の数に出る', list1.notifications.some(n => n.kind === 'shift_assigned' && n.title === `${PFX} シフトが入りました`) && list1.unread === 1 && list1.unread_by_kind.shift_assigned === 1, list1)
  ok('#9801 未読の数は一覧・unread-count・badges でそろう',
    must(await staff.get('/api/staff/notifications/unread-count'), 'c1').count === 1 && must(await staff.get('/api/staff/badges'), 'b1').notifications === 1)

  // ---------- すべて既読にしても、出していない通知の行はそのまま（消さない・既読にしない） ----------
  must(await staff.post('/api/staff/notifications/read-all'), 'read-all')
  const rows = d1(`SELECT kind, read_at FROM user_notifications WHERE user_id = ${UID} ORDER BY notification_id`)[0]
  ok('#9801 「新しい募集」の通知の行は消さない（以前のデータ。スタッフには出さない）', rows.filter(r => r.kind === 'recruit_new').length === 2, rows)
  ok('#9801 すべて既読にしても、出していない通知は未読のまま（ほかの通知は既読になる）',
    rows.filter(r => r.kind === 'recruit_new').every(r => r.read_at == null) && rows.filter(r => r.kind === 'shift_assigned').every(r => r.read_at != null), rows)
  ok('#9801 すべて既読にした後も、未読の数は 0', must(await staff.get('/api/staff/notifications/unread-count'), 'c2').count === 0)

  // ---------- 新しい募集を作っても、スタッフに知らせない ----------
  must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
  const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 新しい募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true,
    show_remaining: true, description: '', pay_note: '日給 12,000円', contact_note: '', notify_staff_email: true }), 'page')
  const made = d1(`SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'recruit_new' AND related_id = ${Number(page.page_id)}`)[0][0].n
  ok('#9801 募集を作っても「新しい募集」の通知を作らない（アプリからの応募を許可にしても）', Number(made) === 0 && page.staff_notified === undefined, { made, page })
  const mails = d1(`SELECT COUNT(*) AS n FROM email_logs WHERE type = 'recruit_new' AND to_email = ${q(`${tag}-a@example.com`)}`)[0][0].n
  ok('#9801 メールでも知らせる指定があっても、「新しい募集」のメールを送らない', Number(mails) === 0, mails)
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'closed' }), 'close')
  const re = must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'open' }), 're-open')
  const made2 = d1(`SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'recruit_new' AND related_id = ${Number(page.page_id)}`)[0][0].n
  ok('#9801 募集を再開しても知らせない', Number(made2) === 0 && re.staff_notified === undefined, { made2, re })
  ok('#9801 #9926 スタッフアプリの募集の API は無い（404）', (await staff.get('/api/staff/recruit')).status === 404)

  // ---------- 受け取り設定 ----------
  const prefs = must(await staff.get('/api/staff/notification-prefs'), 'prefs')
  const keys = prefs.groups.map(g => g.key)
  ok('#9801 受け取り設定に「新しい募集」を出さない', !keys.includes('recruit_new') && !prefs.groups.some(g => /新しい募集/.test(g.label)), keys)
  ok('#9801 「応募の結果」は残す（公開ページからの応募でも、承認で紐づいたスタッフに届くため）', keys.includes('recruit_result'), keys)
  const saved = must(await staff.put('/api/staff/notification-prefs', { prefs: { shift: { push: true } } }), 'save prefs')
  ok('#9801 設定を保存した後の画面にも「新しい募集」を出さない', !saved.groups.some(g => g.key === 'recruit_new'), saved.groups.map(g => g.key))

  // ---------- 管理者の通知の一覧は影響を受けない ----------
  const al = await admin.get('/api/admin/notifications')
  const ac = await admin.get('/api/admin/notifications/unread-count')
  ok('管理者の通知の一覧・未読の数は今までどおり使える', al.status === 200 && Array.isArray(al.data?.notifications) && ac.status === 200 && typeof ac.data?.count === 'number' && al.data.unread === ac.data.count, { al: al.data?.unread, ac: ac.data })
} catch (e) {
  ok('テストの途中で止まった: ' + (e && e.message), false)
} finally {
  server.close()
}
const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
