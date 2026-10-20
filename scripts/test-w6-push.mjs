// プッシュ通知（#178）と通知の受け取り設定（#284）（作業単位 w6-push）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --test-scheduled --port 8810 --persist-to <保存先> で起動していること
//   （MAIL_ENABLED は既定の false のまま。APP_BASE_URL が http://localhost のときだけ、手元の受け口 http://127.0.0.1 へプッシュを送れる）。
//   プッシュの事業者の代わりに、このテストが 127.0.0.1 に受け口を立て、届いた要求（VAPID の署名）を確かめる。
//   まとめメールの確認は --test-scheduled で起動し、日本時間 8 時以降に実行したときだけ行う。
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w6-push.mjs
import http from 'node:http'
import { webcrypto } from 'node:crypto'

const BASE = process.env.BASE || 'http://127.0.0.1:8810'
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'PU' + Date.now().toString(36).slice(-4).toUpperCase()
const tag = PFX.toLowerCase()

// ---------- プッシュの事業者の代わりの受け口 ----------
const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body })
    // /gone/ あては「購読がなくなった」（410）を返す
    res.statusCode = req.url.startsWith('/gone/') ? 410 : 201
    res.end()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const EP = (p) => `http://127.0.0.1:${PORT}${p}`
const waitPush = async (path, since, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = received.slice(since).find(x => x.path === path)
    if (hit) return hit
    await sleep(200)
  }
  return null
}
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const admin = client(await login('sample', 'admin'))     // 会社管理者
const mgr = client(await login('sample', 'mgr01'))       // 現場管理者（藤田）
const sales = client(await login('sample', 'sales01'))   // 営業（岡本）

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
const deliveriesOf = async (cid) => (must(await admin.get('/api/admin/notification-emails?status=all'), 'deliveries').deliveries).filter(d => d.correction_id === cid)
const notifsOf = async (who, kind) => (must(await who.get(`/api/admin/notifications?kind=${kind}`), 'notifs').notifications)

const pid = await newProject(`${PFX}-案件`)
const A = await newStaff('A'), B = await newStaff('B')
const dPast = addDays(today, -3)
let shiftSeq = 0
async function pastShift(st) {
  const memo = `${PFX}-S${++shiftSeq}`
  must(await admin.post('/api/admin/shifts', { staff_id: st.staff_id, project_id: pid, work_date: addDays(dPast, -shiftSeq), start_time: '10:00', end_time: '19:00', memo }), 'past shift')
  const d = addDays(dPast, -shiftSeq)
  return { id: (await admin.get(`/api/admin/shifts?from=${d}&to=${d}`)).data.shifts.find(x => x.memo === memo).shift_id, date: d }
}
async function submitCorrection(st) {
  const s = await pastShift(st)
  return must(await st.api.post('/api/staff/corrections', { shift_id: s.id, report_type: 'check_in', kind: 'add', requested_at: `${s.date} 09:58`, reason: `${PFX} 入店報告を忘れた` }), 'correction').correction_id
}

// =========================================================
// #284 通知メールの受け取り設定
// =========================================================
{
  const pa = must(await admin.get('/api/admin/notification-prefs'), 'prefs admin')
  const ps = must(await sales.get('/api/admin/notification-prefs'), 'prefs sales')
  const g = (d, k) => d.groups.find(x => x.key === k)
  ok('#284 既定: 承認依頼のメールは会社管理者に ON、営業には OFF', g(pa, 'correction_request').email === true && g(ps, 'correction_request').email === false && g(ps, 'correction_request').email_default === false, [g(pa, 'correction_request'), g(ps, 'correction_request')])
  ok('#284 既定: 自分が処理した控えのメールは OFF（アプリ内の通知だけ）', g(pa, 'correction_processed').email === false, g(pa, 'correction_processed'))
  ok('#284 管理者の設定にはスタッフ向けの種類を出さない', !pa.groups.some(x => ['shift', 'reminder'].includes(x.key)), pa.groups.map(x => x.key))
  const bad = await admin.put('/api/admin/notification-prefs', { prefs: { shift: { email: false } } })
  ok('#284 管理者の設定にスタッフの種類を送ると 400', bad.status === 400, bad)
  ok('#284 スタッフは管理者の設定を使えない（403）', (await A.api.get('/api/admin/notification-prefs')).status === 403)
}
let cid1
{
  cid1 = await submitCorrection(A)
  await sleep(500)
  const ds = await deliveriesOf(cid1)
  const names = ds.filter(d => d.kind === 'correction_submitted').map(d => d.recipient_name)
  ok('#284 申請: 承認依頼のメールは会社管理者と現場管理者に送り、営業には送らない', names.some(n => /出井/.test(n)) && names.some(n => /藤田/.test(n)) && !names.some(n => /岡本/.test(n)), ds.map(d => [d.recipient_name, d.kind]))
  const ns = await notifsOf(sales, 'correction_submitted')
  ok('#284 メールを送らない人にも、アプリ内の承認依頼は届く', ns.some(n => n.related_id === cid1), ns.slice(0, 2))
  must(await admin.post(`/api/admin/corrections/${cid1}/approve`, { comment: 'ok' }), 'approve')
  await sleep(500)
  const da = (await deliveriesOf(cid1)).filter(d => d.event === 'approved')
  ok('#284 承認: 処理した管理者の控えのメールは送らない（申請者への結果だけ）', da.length === 1 && da[0].kind === 'correction_approved', da.map(d => [d.recipient_name, d.kind]))
  const np = await notifsOf(admin, 'correction_processed')
  ok('#284 処理した管理者には、アプリ内の控えは残る', np.some(n => n.related_id === cid1), np.slice(0, 2))
}
{
  // 現場管理者がまとめて受け取る、会社管理者が控えのメールを ON にする
  const r1 = await mgr.put('/api/admin/notification-prefs', { prefs: { correction_request: { email: true, digest: true } } })
  ok('#284 承認依頼を「1日1回まとめて」に変えられる', r1.status === 200 && r1.data.groups.find(x => x.key === 'correction_request').digest === true, r1.data)
  const r2 = await admin.put('/api/admin/notification-prefs', { prefs: { correction_processed: { email: true } } })
  ok('#284 処理の控えのメールを ON にできる', r2.status === 200 && r2.data.groups.find(x => x.key === 'correction_processed').email === true, r2.data)
  const cid2 = await submitCorrection(A)
  await sleep(500)
  const ds = (await deliveriesOf(cid2)).filter(d => d.kind === 'correction_submitted')
  ok('#284 まとめて受け取る人には、承認依頼のメールをすぐには送らない', !ds.some(d => /藤田/.test(d.recipient_name)) && ds.some(d => /出井/.test(d.recipient_name)), ds.map(d => d.recipient_name))
  must(await admin.post(`/api/admin/corrections/${cid2}/approve`, {}), 'approve2')
  await sleep(500)
  const da = (await deliveriesOf(cid2)).filter(d => d.event === 'approved')
  ok('#284 控えのメールを ON にした人には、処理の控えのメールを送る', da.some(d => d.kind === 'correction_processed'), da.map(d => [d.recipient_name, d.kind]))
  // 承認待ちを1件残して、まとめメールを確かめる（日本時間 8 時以降・--test-scheduled のときだけ）
  await submitCorrection(A)
  const hour = Number(new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 13))
  const sch = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`).catch(() => null)
  if (hour >= 8 && sch && sch.status === 200) {
    await sleep(500)
    const logs = must(await admin.get('/api/admin/email-logs?type=notification_digest'), 'digest logs').logs
    ok('#284 まとめメール: 「まとめて」を選んだ人に、承認待ちの件数のメールを1通送る', logs.filter(l => /fujita/.test(l.to_email)).length === 1, logs.slice(0, 3))
    await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`)
    await sleep(500)
    const logs2 = must(await admin.get('/api/admin/email-logs?type=notification_digest'), 'digest logs').logs
    ok('#284 まとめメール: 同じ日には二度送らない', logs2.filter(l => /fujita/.test(l.to_email)).length === 1, logs2.slice(0, 3))
  } else console.log(`SKIP  まとめメール（日本時間 ${hour} 時、または --test-scheduled なしで起動）`)
  // 後のテストに影響しないよう戻す
  await mgr.put('/api/admin/notification-prefs', { prefs: { correction_request: { email: true, digest: false } } })
  await admin.put('/api/admin/notification-prefs', { prefs: { correction_processed: { email: null } } })
}

// =========================================================
// #178 プッシュ通知
// =========================================================
const sw = await fetch(`${BASE}/sw.js`)
const swText = await sw.text()
ok('#178 Service Worker（/sw.js）を JavaScript で配信する', sw.status === 200 && /javascript/.test(sw.headers.get('content-type') || '') && /push\/latest/.test(swText) && /showNotification/.test(swText), [sw.status, sw.headers.get('content-type')])
const cfg = must(await A.api.get('/api/staff/push/config'), 'push config')
ok('#178 VAPID の公開鍵を返す（P-256 の非圧縮の公開鍵）', cfg.available && b64urlDecode(cfg.public_key).length === 65 && b64urlDecode(cfg.public_key)[0] === 4, cfg)
const cfg2 = must(await B.api.get('/api/staff/push/config'), 'push config 2')
ok('#178 鍵はアプリで1組（同じ公開鍵を返す）', cfg2.public_key === cfg.public_key)
ok('#178 管理者のセッションではスタッフの購読の API を使えない（403）', (await admin.get('/api/staff/push/config')).status === 403)
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
{
  const bad = await A.api.post('/api/staff/push/subscribe', { endpoint: 'https://evil.example.com/push/1', keys })
  ok('#178 プッシュの事業者でない宛先は登録できない（400）', bad.status === 400, bad)
  const badKeys = await A.api.post('/api/staff/push/subscribe', { endpoint: EP(`/push/${tag}-a`), keys: { p256dh: '<x>', auth: '' } })
  ok('#178 鍵の形式が正しくなければ登録できない（400）', badKeys.status === 400, badKeys)
  must(await A.api.post('/api/staff/push/subscribe', { endpoint: EP(`/push/${tag}-a`), keys }), 'subscribe A')
  const c2 = must(await A.api.get(`/api/staff/push/config?endpoint=${encodeURIComponent(EP(`/push/${tag}-a`))}`), 'config after')
  ok('#178 購読を登録できる（この端末で受け取る状態になる）', c2.subscribed === true && c2.devices === 1, c2)
}
{
  // シフトを登録すると、アプリ内の通知が入り、応答の後にプッシュが送られる
  const since = received.length
  must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: addDays(today, 5), start_time: '10:00', end_time: '18:00' }), 'shift A')
  const hit = await waitPush(`/push/${tag}-a`, since)
  ok('#178 通知が入ると、購読した端末へプッシュを送る', !!hit, received.slice(since).map(x => x.path))
  if (hit) {
    const auth = String(hit.headers.authorization || '')
    const m = auth.match(/^vapid t=([^,]+), k=(.+)$/)
    ok('#178 VAPID の認証（vapid t=..., k=公開鍵）と TTL を付け、本文は送らない', !!m && m[2] === cfg.public_key && Number(hit.headers.ttl) > 0 && hit.body === '', [auth.slice(0, 40), hit.headers.ttl, hit.body.length])
    if (m) {
      const [h, p, s] = m[1].split('.')
      const claims = JSON.parse(b64urlDecode(p).toString())
      const key = await webcrypto.subtle.importKey('raw', b64urlDecode(cfg.public_key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      const valid = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`))
      ok('#178 JWT は ES256 で署名され、aud は送信先のオリジン、exp は24時間以内', valid && JSON.parse(b64urlDecode(h).toString()).alg === 'ES256' && claims.aud === `http://127.0.0.1:${PORT}`
        && claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600 && /^(mailto:|https:)/.test(claims.sub), claims)
    }
  }
  const lat = must(await A.api.get(`/api/staff/push/latest?endpoint=${encodeURIComponent(EP(`/push/${tag}-a`))}`), 'latest')
  ok('#178 端末が取りに来ると、最新の未読（シフトの通知）の題名と開く先を返す', /シフトが入りました/.test(lat.title || '') && /^\/staff#shift\//.test(lat.link || ''), lat)
  const latB = must(await B.api.get(`/api/staff/push/latest?endpoint=${encodeURIComponent(EP(`/push/${tag}-a`))}`), 'latest B')
  ok('#178 ほかの人のログインでは、その端末の通知の中身を返さない', latB.generic === true && !/シフト/.test(latB.title + latB.body), latB)
  ok('#178 ログインしていなければ、中身を返さない（401）', (await fetch(`${BASE}/api/staff/push/latest?endpoint=x`)).status === 401)
}
{
  // テスト通知
  const since = received.length
  const t = await A.api.post('/api/staff/push/test', { endpoint: EP(`/push/${tag}-a`) })
  ok('#178 テスト通知を送れる', t.status === 200 && !!(await waitPush(`/push/${tag}-a`, since)), t)
  const lat = must(await A.api.get(`/api/staff/push/latest?endpoint=${encodeURIComponent(EP(`/push/${tag}-a`))}`), 'latest test')
  ok('#178 テスト通知のときは、テストの文面を返す（1回だけ）', lat.test === true, lat)
  ok('#178 ほかの人の端末にはテスト通知を送れない（404）', (await B.api.post('/api/staff/push/test', { endpoint: EP(`/push/${tag}-a`) })).status === 404)
}
{
  // スタッフの受け取り設定: シフトのプッシュとメールを止める
  const p0 = must(await A.api.get('/api/staff/notification-prefs'), 'staff prefs')
  ok('#178 スタッフの設定は、種類ごとのプッシュ（既定 ON）とメールを返す', p0.groups.find(x => x.key === 'shift')?.push === true && p0.groups.find(x => x.key === 'shift')?.email === true && !p0.groups.some(x => x.key === 'correction_request'), p0.groups)
  const r = await A.api.put('/api/staff/notification-prefs', { prefs: { shift: { push: false, email: false } } })
  ok('#178 シフトのプッシュとメールを止められる', r.status === 200 && r.data.groups.find(x => x.key === 'shift').push === false && r.data.groups.find(x => x.key === 'shift').email === false, r.data)
  const r2 = await A.api.put('/api/staff/notification-prefs', { prefs: { recruit_result: { push: true } } })
  ok('#178 送らなかった種類の設定は変わらない', r2.data.groups.find(x => x.key === 'shift').push === false, r2.data.groups.find(x => x.key === 'shift'))
  const since = received.length
  must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: addDays(today, 1), start_time: '09:00', end_time: '17:00' }), 'shift A tomorrow')
  const hit = await waitPush(`/push/${tag}-a`, since, 2500)
  ok('#178 プッシュを止めた種類の通知では、プッシュを送らない', !hit, received.slice(since).map(x => x.path))
  const n = must(await A.api.get('/api/staff/notifications?kind=shift_assigned'), 'notifs A')
  ok('#178 プッシュを止めても、アプリ内の通知は届く', n.notifications.filter(x => x.kind === 'shift_assigned').length >= 2, n.notifications.length)
  await sleep(500)
  const logs = must(await admin.get('/api/admin/email-logs?type=shift_change'), 'shift mail logs').logs
  ok('#284 シフトのメールを止めた人には、明日のシフトのメールも送らない', !logs.some(l => String(l.to_email).includes(`${tag}-a@`)), logs.slice(0, 3).map(l => l.to_email))
  // 比較: 設定を変えていない B には明日のシフトのメールが送られる
  must(await admin.post('/api/admin/shifts', { staff_id: B.staff_id, project_id: pid, work_date: addDays(today, 1), start_time: '09:00', end_time: '17:00' }), 'shift B tomorrow')
  await sleep(800)
  const logsB = must(await admin.get('/api/admin/email-logs?type=shift_change'), 'shift mail logs B').logs
  ok('#284 （比較）設定を変えていない人には、明日のシフトのメールを送る', logsB.some(l => String(l.to_email).includes(`${tag}-b@`)), logsB.slice(0, 3).map(l => l.to_email))
}
{
  // 購読がなくなった端末（410）は消す
  must(await A.api.post('/api/staff/push/subscribe', { endpoint: EP(`/gone/${tag}`), keys }), 'subscribe gone')
  must(await A.api.put('/api/staff/notification-prefs', { prefs: { shift: { push: true } } }), 'push on')
  const since = received.length
  must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: pid, work_date: addDays(today, 7), start_time: '09:00', end_time: '17:00' }), 'shift A +7')
  const hit = await waitPush(`/gone/${tag}`, since)
  await sleep(500)
  const c = must(await A.api.get(`/api/staff/push/config?endpoint=${encodeURIComponent(EP(`/gone/${tag}`))}`), 'config gone')
  ok('#178 プッシュの事業者が「購読なし」（410）を返した端末は、購読を消す', !!hit && c.subscribed === false && c.devices === 1, { hit: !!hit, c })
  const u = await A.api.post('/api/staff/push/unsubscribe', { endpoint: EP(`/push/${tag}-a`) })
  const c2 = must(await A.api.get('/api/staff/push/config'), 'config after unsubscribe')
  ok('#178 この端末で受け取らないようにできる（購読を消す）', u.status === 200 && u.data.removed === 1 && c2.devices === 0, [u.data, c2])
}
{
  // 解約企業の削除の対象（未対応の表がないこと）
  const hqLogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code: '', user_code: 'hq', password: 'pass1234' }) })
  if (hqLogin.ok) {
    const hq = client((hqLogin.headers.get('set-cookie') || '').split(';')[0])
    const r = await hq.get('/api/hq/offboarding/1')
    const targets = (r.data?.tables || []).map(t => t.target)
    ok('#178 #284 追加した表は解約企業の削除の対象に入っている（未対応の表なし）', Array.isArray(r.data?.unknown_tables) && r.data.unknown_tables.length === 0
      && ['push_subscriptions', 'push_queue', 'user_notification_prefs'].every(t => targets.includes(t)), { unknown: r.data?.unknown_tables, has: targets.filter(t => /push|prefs/.test(t)) })
  } else console.log('SKIP  本部ユーザーでログインできないため、解約企業の削除の対象の確認を省きました')
}

server.close()
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
