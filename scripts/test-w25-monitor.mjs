// 障害に気づく仕組み（Sprint 25 #9973 #9974 #9971。作業単位 w25-monitor）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --test-scheduled --port 9025 --persist-to <保存先> --var TEST_HOOKS:true --var DB_SIZE_LIMIT_MB:1 と、下の行の --var ALERT_DESTINATIONS を付けて
//   起動していること（本物の外部には送らない。送り先はこのテストが 127.0.0.1:9027 に立てる受け口と、何も待っていない 9028）。
//   --var ALERT_DESTINATIONS:W3sidHlwZSI6InNsYWNrIiwidXJsIjoiaHR0cDovLzEyNy4wLjAuMTo5MDI3L3NsYWNrIiwibmFtZSI6IlNsYWNr77yI44OG44K544OI77yJIn0seyJ0eXBlIjoiZGlzY29yZCIsInVybCI6Imh0dHA6Ly8xMjcuMC4wLjE6OTAyNy9kaXNjb3JkIiwicmVjZWl2ZSI6ImNyaXRpY2FsIn0seyJ0eXBlIjoiZ29vZ2xlX2NoYXQiLCJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjkwMjcvZ2NoYXQiLCJyZWNlaXZlIjoiZGlnZXN0In0seyJ0eXBlIjoidGVhbXMiLCJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjkwMjcvdGVhbXMifSx7InR5cGUiOiJsaW5lIiwidG9rZW4iOiJMSU5FdG9rZW4wMTIzNDU2Nzg5QUJDREVGIiwidG8iOiJVMDEyMzQ1Njc4OWFiY2RlZiIsInVybCI6Imh0dHA6Ly8xMjcuMC4wLjE6OTAyNy9saW5lIn0seyJ0eXBlIjoid2ViaG9vayIsInVybCI6Imh0dHA6Ly8xMjcuMC4wLjE6OTAyNy9mYWlsP2tleT1IT09Lc2VjcmV0MDEyMzQ1Njc4OSJ9LHsidHlwZSI6IndlYmhvb2siLCJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjkwMjgvZG93biJ9LHsidHlwZSI6ImVtYWlsIiwidG8iOiJvcHMtdzI1QGV4YW1wbGUuY29tIn0seyJ0eXBlIjoicGFnZXIifV0=
//   （中身は下の DESTS を base64 にしたもの。--var TEST_HOOKS:true のときだけ http の送り先と LINE の url の差し替えを受け付ける）
// 実行: BASE=http://127.0.0.1:9025 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w25-monitor.mjs
//   PERSIST を指定すると、ローカルの D1 に一時的なトリガー・行を入れて、日報の 500・定期処理の失敗・DB の大きさの記録も確かめる
//   （wrangler d1 execute は --local のみ）。本番・mbsaas-stg には接続しない。テストのたびに DB を作り直すこと（npm test -- w25-monitor なら自動で行う）。
// 確かめること:
//   #9973 (1) GET /api/health: ログイン不要・{ ok, version } だけ・キャッシュさせない・HEAD も 200・D1 の失敗は 503（ソース）
//   #9974 (2) 送り先の読み込み・種類ごとの送り方・受け取る種類・送り先が無いときは何もしない（src/services/alerts.ts を esbuild で読み込み、fetch を差し替えて確かめる）
//         (3) 本部画面の送り先の一覧（URL・トークン・宛先を返さない）・テスト送信（1分に1回）・最後の送信の結果
//         (4) 打刻（503）・日報（500）の失敗を1件目から知らせる。同じ場所は60分に1回まで。中身は参照番号・場所・件数だけ。1つの送り先の失敗はほかに影響しない
//         (5) 定期処理の失敗を知らせる
//   #9971 (6) 段階・増え方・残り月数・届く見込みの日の計算（esbuild で読み込む）
//         (7) 毎日1回の記録（meta.size_after）・緊急の通知（毎日）・2回目は何もしない・上部の帯・表ごとの行数（読んだ行数）
//   (8) データ保持の定期削除の対象・設定（wrangler.jsonc・資料）
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9025'
const PERSIST = process.env.PERSIST || ''
const RECEIVER_PORT = 9027
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 秘密の値として渡した送り先（ヘッダーの base64 と同じ）。URL・トークン・宛先が画面・記録に出ないことを確かめる
const DESTS = [
  { type: 'slack', url: 'http://127.0.0.1:9027/slack', name: 'Slack（テスト）' },
  { type: 'discord', url: 'http://127.0.0.1:9027/discord', receive: 'critical' },
  { type: 'google_chat', url: 'http://127.0.0.1:9027/gchat', receive: 'digest' },
  { type: 'teams', url: 'http://127.0.0.1:9027/teams' },
  { type: 'line', token: 'LINEtoken0123456789ABCDEF', to: 'U0123456789abcdef', url: 'http://127.0.0.1:9027/line' },
  { type: 'webhook', url: 'http://127.0.0.1:9027/fail?key=HOOKsecret0123456789' },
  { type: 'webhook', url: 'http://127.0.0.1:9028/down' },
  { type: 'email', to: 'ops-w25@example.com' },
  { type: 'pager' },
]
const SECRETS = ['127.0.0.1', 'LINEtoken0123456789ABCDEF', 'U0123456789abcdef', 'HOOKsecret0123456789', 'ops-w25@example.com', '/slack', '/discord']
const headB64 = (read('scripts/test-w25-monitor.mjs').match(/--var ALERT_DESTINATIONS:(\S+)/) || [])[1]
ok('（前提）ヘッダーの ALERT_DESTINATIONS は DESTS を base64 にしたもの', headB64 === Buffer.from(JSON.stringify(DESTS)).toString('base64'))

// ---------- 送り先の受け口（127.0.0.1:9027）。/fail は 500 を返す ----------
const got = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', ch => { body += ch })
  req.on('end', () => {
    let json = null; try { json = JSON.parse(body) } catch { }
    got.push({ path: req.url.split('?')[0], auth: req.headers.authorization || null, type: req.headers['content-type'] || '', json, body })
    res.writeHead(req.url.startsWith('/fail') ? 500 : 200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
  })
})
await new Promise((r, j) => { server.once('error', j); server.listen(RECEIVER_PORT, '127.0.0.1', r) })
const waitGot = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (got.some(pred)) return true; await sleep(200) } return got.some(pred) }
const textOf = (g) => g.json ? (g.json.text ?? g.json.content ?? g.json.messages?.[0]?.text ?? g.json.attachments?.[0]?.content?.body?.[0]?.text ?? '') : ''

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, headers: r.headers }
  }
  return { get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b ?? {}, h), head: (p) => call('HEAD', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w25mon-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out)[0].results
    } catch (e) { if (i >= 3) throw e }
  }
}
async function waitServer() {
  for (let i = 0; i < 30; i++) { try { const r = await rawFetch(`${BASE}/login`); if (r.status < 500) return } catch { } await sleep(500) }
}
const scheduled = (cron) => rawFetch(`${BASE}/__scheduled?cron=${encodeURIComponent(cron)}`)
const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst(Date.now()).slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

// src/services/*.ts を esbuild で1つにまとめて読み込む（gen-docs.mjs と同じやり方）
async function loadTs(entry) {
  const esbuild = await import('esbuild')
  const out = join(SQL_DIR, `bundle-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({ entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' })
  return import(pathToFileURL(out).href)
}

const hq = client(await login('', 'hq'))
const admin = client(await login('sample', 'admin'))
const anon = client('')

// =========================================================
// (1) #9973 GET /api/health
// =========================================================
{
  const r = await anon.get('/api/health')
  ok('#9973 GET /api/health はログインなしで 200 の { ok: true, version }', r.status === 200 && r.data?.ok === true && typeof r.data?.version === 'string' && r.data.version.length > 0 && r.data.version.length <= 12, r.text)
  ok('#9973 応答は ok と version だけ（内部の情報を出さない）', r.data && JSON.stringify(Object.keys(r.data).sort()) === '["ok","version"]', r.data)
  ok('#9973 キャッシュさせない（Cache-Control: no-store）', /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'))
  ok('#9973 Cookie を作らない', !r.headers.get('set-cookie'))
  const h = await anon.head('/api/health')
  ok('#9973 HEAD でも 200（監視サービスの HEAD に答える）', h.status === 200, h.status)
  const withCookie = await client('fos_session=xxxx').get('/api/health')
  ok('#9973 壊れたセッションの Cookie があっても 200（認証を通さない）', withCookie.status === 200 && withCookie.data?.ok === true, withCookie.status)
  const idx = read('src/index.tsx')
  const at = idx.indexOf("app.get('/api/health'")
  const block = idx.slice(at, idx.indexOf('\n})', at))
  ok('#9973 D1 に SELECT 1 だけを投げ、R2 には触らない。失敗したら 503（本文に ok を含めない）', /prepare\('SELECT 1'\)/.test(block) && !/PHOTOS|DOCUMENTS|CONTRACTS|R2/.test(block) && /503/.test(block) && !/\bok\b[^']*503/.test(block.split('catch')[1] || ''), block.slice(0, 400))
  ok('#9973 /api/health は CSRF の確認・API の認証より前に登録している', at > 0 && at < idx.indexOf("app.use('/api/*', csrfGuard)") && at < idx.indexOf("app.route('/api', api)"))
  const vite = read('vite.config.ts')
  ok('#9973 版の短い ID はビルドのときに git のコミット（Workers Builds はコミットの環境変数）から入れる', /__APP_VERSION__/.test(vite) && /git rev-parse --short=8 HEAD/.test(vite) && /WORKERS_CI_COMMIT_SHA/.test(vite))
  const mon = read('docs/monitoring.md')
  ok('#9973 docs/monitoring.md に UptimeRobot の手順（5分ごと・キーワード ok・通知先）', /UptimeRobot/.test(mon) && /\/api\/health/.test(mon) && /5分/.test(mon) && /キーワード/.test(mon) && /"ok":true/.test(mon) && /通知先/.test(mon))
}

// =========================================================
// (2) #9974 送り先の読み込み・送り方（関数を直接呼ぶ。fetch を差し替える）
// =========================================================
{
  const A = await loadTs('src/services/alerts.ts')
  const sent = []
  const fakeDb = (log) => ({ prepare: (q) => { log.push(q); const s = { bind: () => s, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: {} }) }; return s }, batch: async (l) => { log.push(`batch:${l.length}`); return [] } })
  const throwingDb = { prepare: () => { throw new Error('DB を使ってはいけない') }, batch: () => { throw new Error('DB を使ってはいけない') } }
  // 送り先が無い・空: 何も送らず、DB にも触らず、例外も出さない
  for (const v of [undefined, '', '  ']) {
    const d = await A.loadDestinations({ ALERT_DESTINATIONS: v })
    const r = await A.sendAlert({ DB: throwingDb, ALERT_DESTINATIONS: v }, { event: 'test', severity: 'critical', title: 'x' })
    ok(`#9974 ALERT_DESTINATIONS が ${JSON.stringify(v)} なら送らない・DB に触らない・エラーにしない`, d.source === 'none' && d.list.length === 0 && Array.isArray(r) && r.length === 0, { d, r })
  }
  const bad = await A.loadDestinations({ ALERT_DESTINATIONS: '{not json' })
  ok('#9974 読めない ALERT_DESTINATIONS は invalid（送らない）', bad.source === 'invalid' && bad.list.length === 0, bad)
  const fromB64 = await A.loadDestinations({ ALERT_DESTINATIONS: headB64, TEST_HOOKS: 'true' })
  ok('#9974 base64 にした JSON も読める', fromB64.source === 'set' && fromB64.list.length === DESTS.length, fromB64.list.map(d => d.type))
  const prodLike = await A.loadDestinations({ ALERT_DESTINATIONS: JSON.stringify(DESTS) })
  ok('#9974 本番（TEST_HOOKS なし）では http の URL と LINE の url の差し替えを受け付けない', prodLike.list.filter(d => d.problem).length === DESTS.length - 1 && !prodLike.list.find(d => d.type === 'email').problem, prodLike.list.map(d => [d.type, d.problem]))
  ok('#9974 知らない種類（pager）は設定の誤り', !!fromB64.list.find(d => d.type === 'pager')?.problem)
  const legacy = await A.loadDestinations({ ALERT_WEBHOOK_URL: 'https://hooks.example.invalid/x' })
  ok('#9974 以前の決定の ALERT_WEBHOOK_URL も webhook の送り先として使う', legacy.source === 'set' && legacy.list.length === 1 && legacy.list[0].type === 'webhook' && !legacy.list[0].problem)
  ok('#9974 受け取る種類: all はすべて・critical はすぐに知らせるものだけ・digest は毎朝のまとめだけ（テスト送信はどれも受け取る）',
    A.receives({ receive: 'all' }, 'normal') && A.receives({ receive: 'all' }, 'digest') && A.receives({ receive: 'critical' }, 'critical') && !A.receives({ receive: 'critical' }, 'normal') && !A.receives({ receive: 'critical' }, 'digest')
    && A.receives({ receive: 'digest' }, 'digest') && !A.receives({ receive: 'digest' }, 'critical') && A.receives({ receive: 'digest' }, 'test'))
  // 種類ごとの形（https の本番と同じ形の設定で）
  const https = [
    { type: 'slack', url: 'https://hooks.slack.example/T/B/X' }, { type: 'discord', url: 'https://discord.example/api/webhooks/1/x' },
    { type: 'google_chat', url: 'https://chat.example/v1/spaces/x/messages?key=k' }, { type: 'teams', url: 'https://teams.example/webhook/x' },
    { type: 'line', token: 'TOKENabcdefghijklmnopqrstu', to: 'Uabcdef0123456789' }, { type: 'webhook', url: 'https://example.invalid/hook' },
    { type: 'email', to: 'ops@example.com' },
  ]
  const env = { DB: fakeDb([]), ALERT_DESTINATIONS: JSON.stringify(https), APP_BASE_URL: 'https://app.example', MAIL_ENABLED: 'false' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), init }); if (String(url).includes('discord')) throw new Error('down'); return new Response('{}', { status: String(url).includes('teams') ? 400 : 200 }) }
  let res
  try { res = await A.sendAlert(env, { event: 'critical_failure', severity: 'critical', title: '打刻が失敗しました（応答 500）', lines: ['打刻がサーバーの予期しないエラーで失敗しました。'], ref: 'ab12cd34', path: '/api/staff/attendance', count: 2 }) }
  finally { globalThis.fetch = realFetch }
  const by = (t) => sent.find(s => s.url.includes(t))
  const body = (t) => JSON.parse(by(t)?.init?.body || 'null')
  ok('#9974 Slack は { text }', typeof body('slack')?.text === 'string' && /打刻が失敗しました/.test(body('slack').text))
  ok('#9974 Discord は { content }（2000文字以内）', typeof body('discord')?.content === 'string' && body('discord').content.length <= 2000)
  ok('#9974 Google Chat は { text }', typeof body('chat.example')?.text === 'string')
  ok('#9974 Teams は Adaptive Card のメッセージ', body('teams')?.type === 'message' && body('teams').attachments?.[0]?.contentType === 'application/vnd.microsoft.card.adaptive' && /打刻/.test(body('teams').attachments[0].content.body[0].text))
  const line = by('api.line.me')
  ok('#9974 LINE は Messaging API の push（Bearer のトークン・to・text のメッセージ）', line?.url === 'https://api.line.me/v2/bot/message/push' && line.init.headers.Authorization === 'Bearer TOKENabcdefghijklmnopqrstu' && body('api.line.me').to === 'Uabcdef0123456789' && body('api.line.me').messages[0].type === 'text')
  const wh = body('example.invalid/hook')
  ok('#9974 汎用の Webhook は JSON（種類・参照番号・場所・件数）', wh?.source === 'fieldos' && wh.event === 'critical_failure' && wh.severity === 'critical' && wh.ref === 'ab12cd34' && wh.path === '/api/staff/attendance' && wh.count === 2)
  ok('#9974 中身に参照番号・場所・件数・本部画面のリンクが入る', /参照番号: ab12cd34/.test(body('slack').text) && /場所: \/api\/staff\/attendance/.test(body('slack').text) && /件数: 2件/.test(body('slack').text) && /https:\/\/app\.example\/hq#errors/.test(body('slack').text))
  const st = Object.fromEntries((res || []).map(r => [r.type, r]))
  ok('#9974 1つの送り先が通信できない・4xx でも、ほかは送れる（結果は送り先ごと）', st.slack?.status === 'sent' && st.discord?.status === 'failed' && st.teams?.status === 'failed' && st.teams.http_status === 400 && st.line?.status === 'sent' && st.webhook?.status === 'sent', res)
  ok('#9974 email は MAIL_ENABLED が true でないと送らず「未設定」と残す（Resend を呼ばない）', st.email?.status === 'not_configured' && /未設定/.test(st.email.error) && !sent.some(s => s.url.includes('resend')), st.email)
  ok('#9974 失敗の理由に URL・トークンを入れない', (res || []).every(r => !/https?:|TOKEN|hooks|discord\.example/.test(String(r.error || ''))), res)
  // email: MAIL_ENABLED=true と RESEND_API_KEY があるときだけ Resend に送る
  const sent2 = []
  globalThis.fetch = async (url, init) => { sent2.push({ url: String(url), init }); return new Response('{"id":"x"}', { status: 200 }) }
  let r2
  try { r2 = await A.sendAlert({ DB: fakeDb([]), ALERT_DESTINATIONS: JSON.stringify([{ type: 'email', to: 'ops@example.com' }]), MAIL_ENABLED: 'true', RESEND_API_KEY: 're_x', MAIL_FROM: 'a <a@example.com>' }, { event: 'test', severity: 'test', title: 'テスト' }) }
  finally { globalThis.fetch = realFetch }
  ok('#9974 email は MAIL_ENABLED=true・RESEND_API_KEY があれば Resend で送る', r2?.[0]?.status === 'sent' && sent2.some(s => s.url === 'https://api.resend.com/emails'), r2)
}

// =========================================================
// (3) #9974 本部画面の送り先の一覧・テスト送信
// =========================================================
let destKeys = {}
{
  const forb = await admin.get('/api/hq/monitor')
  ok('#9974 本部の管理者でなければ /api/hq/monitor は 403', forb.status === 403, forb.status)
  const m = await hq.get('/api/hq/monitor')
  ok('#9974 GET /api/hq/monitor は送り先の一覧と DB の大きさを返す', m.status === 200 && Array.isArray(m.data?.destinations) && m.data.destinations.length === DESTS.length && m.data.destinations_source === 'set' && m.data.db_size, m.text.slice(0, 300))
  ok('#9974 一覧に URL・トークン・宛先を出さない', m.status === 200 && SECRETS.every(s => !m.text.includes(s)), SECRETS.filter(s => m.text.includes(s)))
  const ds = m.data?.destinations || []
  destKeys = Object.fromEntries(ds.map((d, i) => [i, d.key]))
  ok('#9974 名前・種類・受け取る種類が出る（名前の省略時は「種類 番号」）', ds[0]?.label === 'Slack（テスト）' && ds[0].type_label === 'Slack' && ds[1]?.label === 'Discord 2' && ds[1].receive === 'critical' && ds[2]?.receive === 'digest' && ds[0].receive === 'all', ds.slice(0, 3))
  ok('#9974 設定の誤り（知らない種類）は problem に理由を出す', !!ds[8]?.problem && ds.slice(0, 8).every(d => !d.problem), ds.map(d => d.problem))
  // テスト送信
  got.length = 0
  const t1 = await hq.post(`/api/hq/monitor/destinations/${ds[0].key}/test`)
  ok('#9974 テスト送信: Slack に届く', t1.status === 200 && t1.data?.ok === true && await waitGot(g => g.path === '/slack' && /テストの通知/.test(textOf(g))), [t1.data, got.map(g => g.path)])
  ok('#9974 テスト送信はその送り先だけに送る', got.every(g => g.path === '/slack'), got.map(g => g.path))
  const t2 = await hq.post(`/api/hq/monitor/destinations/${ds[0].key}/test`)
  ok('#9974 同じ送り先へのテスト送信は1分に1回まで（429）', t2.status === 429, t2)
  const tl = await hq.post(`/api/hq/monitor/destinations/${ds[4].key}/test`)
  const lg = got.find(g => g.path === '/line')
  ok('#9974 LINE のテスト送信: Bearer のトークンと to・text のメッセージで届く', tl.data?.ok === true && await waitGot(g => g.path === '/line') && got.find(g => g.path === '/line').auth === 'Bearer LINEtoken0123456789ABCDEF' && got.find(g => g.path === '/line').json?.to === 'U0123456789abcdef', [tl.data, lg])
  const tf = await hq.post(`/api/hq/monitor/destinations/${ds[5].key}/test`)
  ok('#9974 送り先が 500 を返したら失敗（HTTP 500）と返す。URL は返さない', tf.status === 200 && tf.data?.ok === false && tf.data.result?.status === 'failed' && tf.data.result.http_status === 500 && !/HOOK|127\.0/.test(tf.text), tf.text)
  const td = await hq.post(`/api/hq/monitor/destinations/${ds[6].key}/test`)
  ok('#9974 送り先に通信できなければ失敗（URL は返さない）', td.status === 200 && td.data?.result?.status === 'failed' && !/9028|127\.0/.test(td.text), td.text)
  const te = await hq.post(`/api/hq/monitor/destinations/${ds[7].key}/test`)
  ok('#9974 メールの送り先は MAIL_ENABLED が true でなければ送らずに「未設定」', te.status === 200 && te.data?.result?.status === 'not_configured' && /未設定/.test(te.data.result.error || ''), te.text)
  const tx = await hq.post('/api/hq/monitor/destinations/000000000000/test')
  ok('#9974 知らない送り先は 404', tx.status === 404, tx.status)
  const m2 = (await hq.get('/api/hq/monitor')).data
  const s = (i) => m2.destinations[i]
  ok('#9974 一覧に送り先ごとの最後の送信の結果が出る（送れた・失敗・未設定・まだ）', s(0).last_status === 'sent' && s(0).last_event === 'test' && s(0).last_success_at && s(5).last_status === 'failed' && /HTTP 500/.test(s(5).last_error) && s(7).last_status === 'not_configured' && s(2).last_status === null,
    m2.destinations.map(d => [d.label, d.last_status, d.last_error]))
  if (PERSIST) {
    const rows = sql('SELECT * FROM alert_destination_status')
    ok('#9974 alert_destination_status に URL・トークン・宛先を残さない', rows.length >= 4 && SECRETS.every(x => !JSON.stringify(rows).includes(x)), rows)
    await waitServer()
  } else skip('#9974 alert_destination_status の中身', 'PERSIST 未指定')
}

// =========================================================
// (4) #9974 打刻・日報の送信の失敗を1件目から知らせる
// =========================================================
{
  const PFX = 'W25M' + Date.now().toString(36).slice(-4).toUpperCase()
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}A`, name: `${PFX} 個人名`, password: 'pass1234' }), 'staff')
  const sA = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}A`)
  const memo = `${PFX}-m`
  must(await admin.post('/api/admin/shifts', { staff_id: sA.staff_id, project_id: 1, work_date: today, start_time: '00:00', end_time: '23:59', memo }), 'shift')
  const sid = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.memo === memo).shift_id
  const st = client(await login('sample', `${PFX}A`))
  const unread0 = (await hq.get('/api/hq/errors/alerts')).data.alerts_unread.length
  got.length = 0
  const p1 = await st.post('/api/staff/attendance', { shift_id: sid, report_type: 'wake_up', client_request_id: `${PFX}-1`, pressed_at: Date.now(), device_now: Date.now(), latitude: null, longitude: null }, { 'X-Test-D1-Overload': '9' })
  ok('（前提）打刻が混雑で 503 になる（テスト用の仕掛け）', p1.status === 503, p1)
  const arrived = await waitGot(g => g.path === '/slack' && /打刻が失敗しました/.test(textOf(g)))
  ok('#9974 打刻の失敗（503）を1件目から送り先に知らせる', arrived, got.map(g => [g.path, textOf(g).slice(0, 60)]))
  await sleep(800)
  const slack = got.find(g => g.path === '/slack')
  const t = slack ? textOf(slack) : ''
  ok('#9974 中身は場所・件数（混雑の 503 は参照番号なし）', /場所: \/api\/staff\/attendance/.test(t) && /件数: 1件/.test(t) && /応答 503/.test(t), t)
  ok('#9974 中身に個人の情報（スタッフの名前・ID・シフト）を入れない', got.every(g => !g.body.includes(PFX) && !g.body.includes('個人名')), got.map(g => g.body.slice(0, 200)))
  ok('#9974 すぐに知らせるもの（critical）だけを受け取る送り先（Discord）にも届く', got.some(g => g.path === '/discord'))
  ok('#9974 毎朝のまとめだけを受け取る送り先（Google Chat）には送らない', !got.some(g => g.path === '/gchat'))
  ok('#9974 1つの送り先の失敗（500・通信できない）があっても、Teams・LINE にも届く', got.some(g => g.path === '/teams') && got.some(g => g.path === '/line') && got.some(g => g.path === '/fail'), got.map(g => g.path))
  const al = (await hq.get('/api/hq/errors/alerts')).data.alerts_unread
  ok('#9974 本部の管理者にもアプリ内の通知（プッシュ）を作る', al.length === unread0 + 1 && /打刻が失敗しました/.test(al[0].title), al)
  // 2件目: 60分以内は送らない
  got.length = 0
  const p3 = await st.post('/api/staff/attendance', { shift_id: sid, report_type: 'wake_up', client_request_id: `${PFX}-2`, pressed_at: Date.now(), device_now: Date.now() }, { 'X-Test-D1-Overload': '9' })
  await sleep(2500)
  ok('#9974 同じ場所（打刻）の2件目は60分以内は送らない', p3.status === 503 && !got.some(g => /打刻が失敗しました/.test(textOf(g))), [p3.status, got.map(g => g.path)])
  ok('#9974 2件目でアプリ内の通知を増やさない', (await hq.get('/api/hq/errors/alerts')).data.alerts_unread.length === unread0 + 1)
  if (PERSIST) {
    const cd = sql("SELECT alert_key, pending FROM alert_cooldowns WHERE alert_key = 'critical:punch'")
    ok('#9974 知らせなかった件数を数えておく（次の通知で「ほかにN件」と出す）', cd.length === 1 && Number(cd[0].pending) >= 1, cd)
    await waitServer()
    // 日報の送信の 500（一時的なトリガーで保存を失敗させる）
    sql(`CREATE TRIGGER w25_fail_daily BEFORE INSERT ON daily_reports BEGIN SELECT RAISE(ABORT, 'w25 test failure'); END;`)
    await waitServer()
    got.length = 0
    const dr = await st.post('/api/staff/daily-report', { project_id: 1, shift_id: sid, work_date: today, values: { mnp: 1 } })
    ok('（前提）日報の送信が 500（参照番号つき）になる', dr.status === 500 && /^[0-9a-f]{8}$/.test(dr.data?.ref || ''), dr.text.slice(0, 200))
    const arr2 = await waitGot(g => g.path === '/slack' && /日報の送信が失敗しました/.test(textOf(g)))
    const t2 = textOf(got.find(g => g.path === '/slack') || {})
    ok('#9974 日報の送信の失敗（500）も1件目から知らせる（打刻とは別に数える）', arr2, got.map(g => g.path))
    ok('#9974 日報の失敗の中身に参照番号・場所・件数', t2.includes(`参照番号: ${dr.data?.ref}`) && /場所: \/api\/staff\/daily-report/.test(t2) && /件数: 1件/.test(t2), t2)
    const wh = got.find(g => g.path === '/fail')?.json
    ok('#9974 汎用の Webhook にも参照番号・場所・件数（個人の情報なし）', wh && wh.ref === dr.data?.ref && wh.path === '/api/staff/daily-report' && wh.count === 1 && !JSON.stringify(wh).includes(PFX), wh)
    sql('DROP TRIGGER IF EXISTS w25_fail_daily;')
    await waitServer()
    const ok2 = await st.post('/api/staff/daily-report', { project_id: 1, shift_id: sid, work_date: today, values: { mnp: 1 } })
    ok('（後片付け）トリガーを消すと日報を送れる', ok2.status === 200, ok2.text)
    const logs = sql("SELECT message, path FROM error_logs")
    ok('#9974 障害の記録（error_logs）に送り先の URL・トークンが入らない', SECRETS.every(x => !JSON.stringify(logs).includes(x)))
  } else skip('#9974 日報の送信の失敗', 'PERSIST 未指定')
  // 成功・4xx は知らせない
  got.length = 0
  const bad = await st.post('/api/staff/attendance', { shift_id: sid, report_type: 'nope' })
  await sleep(1500)
  ok('#9974 4xx（入力の誤り）は知らせない', bad.status === 400 && !got.length, got.map(g => g.path))
}

// =========================================================
// (6) #9971 段階・増え方・残り月数の計算（関数を直接呼ぶ）
// =========================================================
{
  const M = await loadTs('src/services/monitor.ts')
  const MB = 1024 * 1024
  ok('#9971 段階: 50%=準備・60%=着手・80%=警告・90%=緊急', M.dbStageOf(49.9, null) === 'ok' && M.dbStageOf(50, null) === 'prepare' && M.dbStageOf(60, null) === 'start' && M.dbStageOf(80, null) === 'warning' && M.dbStageOf(90, null) === 'emergency')
  ok('#9971 段階: 残り12か月=準備・残り6か月=着手（割合が低くても）', M.dbStageOf(10, 12) === 'prepare' && M.dbStageOf(10, 12.5) === 'ok' && M.dbStageOf(10, 6) === 'start' && M.dbStageOf(55, 5) === 'start')
  ok('#9971 通知: 準備・着手は上がった日だけ、警告・緊急は毎日', M.shouldNotifyDbStage(null, 'prepare') && !M.shouldNotifyDbStage('prepare', 'prepare') && M.shouldNotifyDbStage('prepare', 'start') && !M.shouldNotifyDbStage('start', 'prepare')
    && M.shouldNotifyDbStage('warning', 'warning') && M.shouldNotifyDbStage('emergency', 'emergency') && !M.shouldNotifyDbStage(null, 'ok'))
  ok('#9971 上限は DB_SIZE_LIMIT_MB（既定 500）', M.dbSizeLimitMb({}) === 500 && M.dbSizeLimitMb({ DB_SIZE_LIMIT_MB: '10240' }) === 10240 && M.dbSizeLimitMb({ DB_SIZE_LIMIT_MB: 'x' }) === 500)
  // 90日で 100MB → 200MB（1日 1.11MB）。上限 500MB
  const T = '2026-11-12'
  const rows = Array.from({ length: 91 }, (_, i) => ({ day: addDays(T, i - 90), size_bytes: Math.round((100 + 100 * i / 90) * MB) }))
  const s = M.summarizeDbSize(rows, 500, T)
  const perMonth = 100 / 90 * 30.44
  ok('#9971 1か月の増え方（直近3か月の記録から）', Math.abs(s.growth_bytes_per_month / MB - perMonth) < 0.1 && s.growth_days === 90, s)
  ok('#9971 割合と残り月数（上限に対して）', s.pct === 40 && Math.abs(s.months_left - Math.round(300 / perMonth * 10) / 10) < 0.01, s)
  ok('#9971 80%・100% に届く見込みの日', s.date_80 === addDays(T, Math.ceil((400 - 200) / (100 / 90))) && s.date_100 === addDays(T, Math.ceil((500 - 200) / (100 / 90))) && !s.reached_80, [s.date_80, s.date_100])
  ok('#9971 残り月数で段階を決める（40% でも残り約8か月なら準備）', s.stage === 'prepare' && s.stage_label === '準備', s.stage)
  const few = M.summarizeDbSize(rows.slice(-5), 500, T)
  ok('#9971 記録が7日分より少ないうちは増え方・残り月数・見込みの日を出さない', few.growth_bytes_per_month === null && few.months_left === null && few.date_80 === null && few.stage === 'ok', few)
  const big = M.summarizeDbSize([{ day: T, size_bytes: 460 * MB }], 500, T)
  ok('#9971 92% は緊急・80% は届いている', big.stage === 'emergency' && big.reached_80 && !big.reached_100, big)
  const flat = M.summarizeDbSize(rows.map(r => ({ ...r, size_bytes: 100 * MB })), 500, T)
  ok('#9971 増えていないときは残り月数・見込みの日を出さない', flat.growth_bytes_per_month === 0 && flat.months_left === null && flat.date_100 === null && flat.stage === 'ok', flat)
  ok('#9971 空の記録', M.summarizeDbSize([], 500, T).size_bytes === null)
}

// =========================================================
// (5)(7) 定期処理: 失敗の通知・DB の大きさの記録（DB_SIZE_LIMIT_MB:1 で起動しているので「緊急」になる）
// =========================================================
if (PERSIST) {
  const r0 = await scheduled('*/15 * * * *')
  if (r0.status === 404) skip('#9971 定期処理', '--test-scheduled なしで起動')
  else {
    await sleep(500)
    // (5) 定期処理の失敗: 今日の記録を作らせない一時的なトリガーで monitor_daily を失敗させる
    sql(`DELETE FROM db_size_logs; DELETE FROM alert_cooldowns WHERE alert_key LIKE 'cron:%'; CREATE TRIGGER w25_fail_size BEFORE INSERT ON db_size_logs BEGIN SELECT RAISE(ABORT, 'w25 size failure'); END;`)
    await waitServer()
    got.length = 0
    await scheduled('*/15 * * * *')
    const arrived = await waitGot(g => g.path === '/slack' && /定期処理「DB の大きさの記録/.test(textOf(g)))
    ok('#9974 定期処理の失敗を送り先に知らせる（参照番号・場所つき）', arrived && /参照番号: [0-9a-f]{8}/.test(textOf(got.find(g => g.path === '/slack'))) && /場所: cron\/monitor_daily/.test(textOf(got.find(g => g.path === '/slack'))), got.map(g => [g.path, textOf(g).slice(0, 80)]))
    ok('#9974 定期処理の失敗は critical だけを受け取る送り先には送らない', !got.some(g => g.path === '/discord'))
    const runs = sql("SELECT status FROM cron_runs WHERE job = 'monitor_daily' ORDER BY run_id DESC LIMIT 1")
    ok('#9974 定期処理の記録（cron_runs）は今までどおり「失敗」', runs[0]?.status === 'failed', runs)
    sql('DROP TRIGGER IF EXISTS w25_fail_size;')
    await waitServer()
    // (7) 毎日1回の記録と緊急の通知
    got.length = 0
    const unread0 = (await hq.get('/api/hq/errors/alerts')).data.alerts_unread.length
    await scheduled('*/15 * * * *')
    const row = sql(`SELECT * FROM db_size_logs WHERE day = '${today}'`)[0]
    ok('#9971 毎日の記録（db_size_logs）に大きさ・取れた方法・段階を残す', row && Number(row.size_bytes) > 0 && row.method === 'meta.size_after' && row.limit_mb === 1 && row.stage === 'emergency' && row.checked_at && Number(row.notified) === 1, row)
    const arrived2 = await waitGot(g => g.path === '/discord' && /DB の大きさが「緊急」/.test(textOf(g)))
    ok('#9971 緊急（90%）は critical の送り先にも知らせる', arrived2, got.map(g => [g.path, textOf(g).slice(0, 60)]))
    const sl = got.find(g => g.path === '/slack' && /DB の大きさ/.test(textOf(g)))
    ok('#9971 通知に今の大きさ・割合・上限', sl && /今の大きさ: [\d.]+MB（上限 1MB の [\d.]+%）/.test(textOf(sl)), sl && textOf(sl))
    const al = (await hq.get('/api/hq/errors/alerts')).data.alerts_unread
    ok('#9971 本部の管理者にもアプリ内の通知', al.length === unread0 + 1 && /DB の大きさ/.test(al[0].title), al)
    ok('#9974 毎朝のまとめ: digest の送り先（Google Chat）と all の送り先（Slack）に届く', await waitGot(g => g.path === '/gchat' && /毎朝のまとめ/.test(textOf(g))) && got.some(g => g.path === '/slack' && /毎朝のまとめ/.test(textOf(g))) && !got.some(g => g.path === '/discord' && /毎朝のまとめ/.test(textOf(g))), got.map(g => [g.path, textOf(g).slice(0, 40)]))
    const dg = textOf(got.find(g => g.path === '/gchat') || {})
    ok('#9974 毎朝のまとめに前日からのエラーの件数・定期処理の失敗・DB の大きさ', /直近24時間のエラー: \d+件/.test(dg) && /失敗した定期処理: monitor_daily/.test(dg) && /DB の今の大きさ/.test(dg), dg)
    got.length = 0
    await scheduled('*/15 * * * *')
    await sleep(1500)
    const rows2 = sql(`SELECT COUNT(*) AS n FROM db_size_logs`)
    ok('#9971 同じ日の2回目の起動は何もしない（1日1行・通知しない）', Number(rows2[0].n) === 1 && !got.length, [rows2, got.map(g => g.path)])
    const last = sql("SELECT status, result_json FROM cron_runs WHERE job = 'monitor_daily' ORDER BY run_id DESC LIMIT 1")[0]
    ok('#9971 2回目は idle（問い合わせ1回）', last?.status === 'ok' && /"idle":true/.test(last.result_json || ''), last)
    // 本部画面の表示と帯
    const m = (await hq.get('/api/hq/monitor')).data.db_size
    ok('#9971 本部画面: 今の大きさ・割合・段階', m.size_bytes > 0 && m.pct > 90 && m.stage === 'emergency' && m.limit_mb === 1 && m.day === today, m)
    const b = await hq.get('/api/hq/monitor/banner')
    ok('#9971 上部の赤い帯の判定（緊急）', b.status === 200 && b.data.db_stage === 'emergency' && b.data.db_pct > 90, b.data)
    ok('#9971 帯の API も本部の管理者だけ', (await admin.get('/api/hq/monitor/banner')).status === 403)
    // 表ごとの行数
    const c1 = await hq.post('/api/hq/monitor/db-size/count-tables')
    ok('#9971 表ごとの行数を数える（多い順・読んだ行数）', c1.status === 200 && c1.data.tables.length > 0 && c1.data.tables.length <= 15 && c1.data.tables_total > 50 && c1.data.tables.every((t, i, a) => !i || a[i - 1].rows >= t.rows) && c1.data.tables_rows_read > 0, c1.text.slice(0, 300))
    ok('#9971 表ごとの行数は10分に1回まで（429）', (await hq.post('/api/hq/monitor/db-size/count-tables')).status === 429)
    const m3 = (await hq.get('/api/hq/monitor')).data.db_size
    ok('#9971 数えた行数は今日の記録に残り、本部画面に出る', m3.tables.length === c1.data.tables.length && m3.tables_at && m3.tables_rows_read === c1.data.tables_rows_read, m3)
    console.log(`  （参考）表ごとの行数を数えたときに読んだ行数: ${c1.data.tables_rows_read}（${c1.data.tables_total}表）`)
    // 増え方: 過去の記録を足すと、増え方・残り月数が出る
    sql(`INSERT INTO db_size_logs (day, size_bytes, limit_mb, method, stage, notified, checked_at, created_at, updated_at) VALUES ('${addDays(today, -30)}', ${Math.max(1, Number(row.size_bytes) - 300000)}, 1, 'meta.size_after', 'emergency', 1, '${addDays(today, -30)} 08:00:00', '${addDays(today, -30)} 08:00:00', '${addDays(today, -30)} 08:00:00')`)
    await waitServer()
    const m4 = (await hq.get('/api/hq/monitor')).data.db_size
    ok('#9971 30日前の記録があれば1か月の増え方を出す', m4.growth_days === 30 && Math.abs(m4.growth_bytes_per_month - Math.round(300000 / 30 * 30.44)) <= 1, m4)
  }
} else skip('#9971 定期処理の記録', 'PERSIST 未指定')

// =========================================================
// (8) データ保持・設定・資料
// =========================================================
{
  const dr = must(await hq.post('/api/hq/retention/dry-run', {}), 'dry-run')
  const targets = (dr.results || []).map(r => r.target)
  ok('#9971 #9974 データ保持の定期削除の対象に新しい表（db_size_logs・alert_destination_status・alert_cooldowns）が入る', ['db_size_logs', 'alert_destination_status', 'alert_cooldowns'].every(t => targets.includes(t)), targets)
  if (PERSIST) {
    sql(`INSERT INTO alert_cooldowns (alert_key, last_sent_at, updated_at) VALUES ('w25-old', '2020-01-01 00:00:00', '2020-01-01 00:00:00')`)
    await waitServer()
    const dr2 = must(await hq.post('/api/hq/retention/dry-run', {}), 'dry-run2')
    ok('#9974 最後の更新から90日を過ぎた通知の間隔の記録を数える', (dr2.results || []).find(r => r.target === 'alert_cooldowns')?.targetCount >= 1, dr2.results?.find(r => r.target === 'alert_cooldowns'))
  }
  const wr = read('wrangler.jsonc')
  const blocks = [...wr.matchAll(/"vars":\s*\{([^}]*)\}/g)].map(m => m[1])
  ok('#9971 wrangler.jsonc の vars（ローカル・本番）に DB_SIZE_LIMIT_MB: "500"', blocks.length === 2 && blocks.every(b => /"DB_SIZE_LIMIT_MB": "500"/.test(b)))
  const mon = read('docs/monitoring.md')
  ok('#9971 資料: 有料プランに切り替えたら 10240 に変える', /DB_SIZE_LIMIT_MB/.test(mon) && /10240/.test(mon))
  ok('#9974 資料: ALERT_DESTINATIONS の書き方（7種類・受け取る種類）', /ALERT_DESTINATIONS/.test(mon) && ['slack', 'discord', 'google_chat', 'teams', 'line', 'webhook', 'email'].every(t => mon.includes('`' + t + '`')) && /critical/.test(mon) && /digest/.test(mon))
  const mig = read('migrations/0109_monitoring.sql').replace(/--[^\n]*/g, '')
  ok('（マイグレーション）0109 は表を足すだけ（DROP・ALTER・DELETE・UPDATE なし）', !/\b(DROP|ALTER|DELETE|UPDATE)\b/i.test(mig) && (mig.match(/CREATE TABLE IF NOT EXISTS/g) || []).length === 3)
  const js = read('public/static/hq.js')
  ok('（画面）本部画面の送り先・DB の大きさは data-action と delegate（onclick に値を埋め込まない）', /data-action="hqDestTest" data-key=/.test(js) && /delegate\('hqDestTest'/.test(js) && /delegate\('hqDbCountTables'/.test(js) && !/onclick="[^"]*hqDest/.test(js))
}

server.close()
try { rmSync(SQL_DIR, { recursive: true, force: true }) } catch { }
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
