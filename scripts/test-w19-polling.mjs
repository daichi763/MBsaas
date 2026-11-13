// w19-polling（#9935）の統合テスト
// 管理画面のバッジ（企業間チャット・通知・掲示板・打刻修正・応募）の件数を GET /api/admin/badges の1本で返し、
// 開いたときと60秒ごとの更新をその1本にしたことを確かめる。
//   - API: 返す数が今までの5本（roster-chat/unread-count・notifications/unread-count・board/unread-count・corrections/pending-count・
//     recruit-applications/summary）と同じ。ロールごと（会社管理者・現場管理者・営業管理者・事務担当）に同じで、スタッフ・ログインなしは使えない
//   - 画面（ヘッドレスの Chrome）: 開いたときに同じ API を2回ずつ呼ばない・バッジの5本は呼ばずに badges を1回・60秒の間の通信は badges の1本だけ・
//     タブが裏にあるときは呼ばない・バッジの数が API と同じに出る。Chrome が無いときは画面の確認を省く（CHROME=<chrome.exe のパス> で指定できる）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8613 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8613 node scripts/test-w19-polling.mjs（画面の確認で約2分かかる）
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8613'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts) } catch (e) { return fetch(url, opts) }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetchRetry(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = String(Date.now()).slice(-6)

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const sales = client(await login('sample', 'sales01'))
const st1 = client(await login('sample', 'st001'))

// ---------- 数が0でないものを作る（打刻修正の申請 → 承認待ち・管理者あての通知） ----------
{
  const dA = addDays(today, -1)
  const memo = `W19P-${SUF}`
  must(await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 1, work_date: dA, start_time: '10:00', end_time: '19:00', memo }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${dA}&to=${dA}`), 'shifts').shifts.find(x => x.memo === memo)
  for (const [t, tm] of [['work_start', '10:00'], ['work_end', '18:00']]) await admin.post(`/api/admin/shifts/${s.shift_id}/proxy-attendance`, { report_types: [t], time: tm })
  const r = await st1.post('/api/staff/corrections', { shift_id: s.shift_id, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 17:45`, reason: 'w19-polling のテスト' })
  ok('（前提）スタッフの打刻修正の申請（承認待ちが1件以上になる）', r.status === 200 && r.data.correction_id, r)
}
// 事務担当（seed に無いので作る）
const officeCode = `w19p${SUF}`
must(await admin.post('/api/admin/users', { user_code: officeCode, name: '事務 テスト', role: 'office_staff', password: 'Office-pass-2026' }), 'office user')
const office = client(await login('sample', officeCode, 'Office-pass-2026'))

// ---------- API: 5本と同じ数を1回で返す ----------
async function oldFive(cl) {
  const [chat, notif, board, corr, recruit] = await Promise.all([
    cl.get('/api/admin/roster-chat/unread-count'), cl.get('/api/admin/notifications/unread-count'), cl.get('/api/admin/board/unread-count'),
    cl.get('/api/admin/corrections/pending-count'), cl.get('/api/admin/recruit-applications/summary')])
  return { status: [chat, notif, board, corr, recruit].map(x => x.status), data: { roster_chat: chat.data, notifications: notif.data, board: board.data, corrections: corr.data, recruit: recruit.data } }
}
for (const [label, cl] of [['会社管理者', admin], ['現場管理者', mgr], ['営業管理者', sales], ['事務担当', office]]) {
  const b = await cl.get('/api/admin/badges')
  const o = await oldFive(cl)
  ok(`${label}: GET /api/admin/badges は 200 で5つの数を返す`, b.status === 200 && ['roster_chat', 'notifications', 'board', 'corrections', 'recruit'].every(k => b.data && b.data[k]), b)
  ok(`${label}: 返す数は今までの5本と同じ（中身の形も同じ）`, o.status.every(s => s === 200) && JSON.stringify(b.data) === JSON.stringify(o.data), { badges: b.data, old: o })
}
{
  const b = must(await admin.get('/api/admin/badges'), 'badges')
  ok('打刻修正の承認待ち・会社管理者あての通知は0ではない（数が入っていることを確かめる）', b.corrections.count >= 1 && b.notifications.count >= 1, b)
  const bm = must(await mgr.get('/api/admin/badges'), 'badges mgr')
  ok('通知は本人あての数（会社管理者と現場管理者で、それぞれの /notifications/unread-count と同じ）', bm.notifications.count === must(await mgr.get('/api/admin/notifications/unread-count'), 'n').count
    && b.notifications.count === must(await admin.get('/api/admin/notifications/unread-count'), 'n').count, { admin: b.notifications, mgr: bm.notifications })
}
{
  const s = await st1.get('/api/admin/badges')
  ok('スタッフは使えない（403。今の5本と同じ）', s.status === 403 && (await st1.get('/api/admin/corrections/pending-count')).status === 403, s.status)
  const n = await client('').get('/api/admin/badges')
  ok('ログインしていなければ 401', n.status === 401, n.status)
}

// ---------- 画面の JS（静的な確認） ----------
const js = async (name) => (await fetchRetry(`${BASE}/static/${name}`)).text()
const adminJs = await js('admin.js')
ok('admin.js: 60秒ごとの更新は refreshBadges の1本（タブが裏・ログインの期限切れのときは呼ばない）',
  adminJs.includes("axios.get('/api/admin/badges')") && /setInterval\(\(\) => \{ if \(!document\.hidden && ME && window\.sessionUsable\(\)\) refreshBadges\(\) \}, 60 \* 1000\)/.test(adminJs))
ok('admin.js: badges は定期の取得（X-Background。セッションを延ばさない）', /BACKGROUND_API = \/\^\\\/api\\\/admin\\\/\(badges\|/.test(adminJs))
for (const f of ['roster-chat.js', 'notifications.js', 'board.js', 'corrections.js', 'recruit.js']) {
  const src = await js(f)
  ok(`${f}: バッジの定期の更新・開いたときの取得を持たない（onBadge で描き方だけ登録する）`, src.includes('onBadge(') && !/setInterval\([^\n]*Badge/.test(src) && !/setTimeout\([^\n]*Badge/.test(src))
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()  // 空いているポート（#9980）
  const prof = mkdtempSync(join(tmpdir(), 'w19p-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1366,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []; const reqs = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
      if (m.method === 'Network.requestWillBeSent') {
        const u = new URL(m.params.request.url)
        if (u.origin === BASE && u.pathname.startsWith('/api/')) reqs.push({ at: Date.now(), method: m.params.request.method, path: u.pathname })
      }
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    await send('Network.clearBrowserCookies')
    const [n, ...v] = admin.cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })

    await send('Page.navigate', { url: `${BASE}/admin` })
    await until(`typeof ME !== 'undefined' && !!ME && !!document.getElementById('kpi-cards')`, 30000)
    // 開いたときの読み込み（ダッシュボード・案内・バッジ）が済むまで待つ
    await wait(6000)
    const openReqs = reqs.splice(0)
    const cnt = (rs) => rs.reduce((a, r) => { const k = `${r.method} ${r.path}`; a[k] = (a[k] || 0) + 1; return a }, {})
    const oc = cnt(openReqs)
    if (process.env.VERBOSE) console.log('開いたときの API:', JSON.stringify(oc))
    const dup = Object.entries(oc).filter(([, c]) => c > 1)
    ok('画面: 開いたときに同じ API を2回ずつ呼ばない（auth/me・tours/checklist・バッジなど、どれも1回まで）', dup.length === 0, { dup, all: oc })
    ok('画面: 開いたときのバッジは GET /api/admin/badges の1回', oc['GET /api/admin/badges'] === 1, oc)
    const OLD = ['/api/admin/roster-chat/unread-count', '/api/admin/notifications/unread-count', '/api/admin/board/unread-count', '/api/admin/corrections/pending-count', '/api/admin/recruit-applications/summary']
    ok('画面: 開いたときにバッジの5本（unread-count など）は呼ばない', OLD.every(p => !oc[`GET ${p}`]), oc)
    ok('画面: ダッシュボード・企業間チャットの新着・auth/me は今までどおり1回ずつ読む', oc['GET /api/admin/dashboard'] === 1 && oc['GET /api/admin/roster-chat/threads'] === 1 && oc['GET /api/auth/me'] === 1, oc)

    // バッジの見え方（数・出す/隠す）は API と同じ
    const b = must(await admin.get('/api/admin/badges'), 'badges')
    const shown = await ev(`(() => { const t = (id) => { const el = document.getElementById(id); return el ? { text: el.textContent, hidden: el.classList.contains('hidden') } : null }
      const chat = document.querySelector('.side-link[data-tab="roster-chat"] .chat-badge')
      return { corrections: t('corrections-badge'), notifications: t('notif-badge'), recruit: t('recruit-badge'), board: t('board-badge'),
        chat: chat ? { text: chat.textContent, hidden: chat.style.display === 'none' } : null, mobile: t('mobile-todo-badge'),
        opt: (document.querySelector('#mobile-nav option[value="corrections"]') || {}).textContent || '' } })()`)
    const same = (x, n) => !!x && (n ? x.text === String(n) && !x.hidden : x.hidden)
    ok('画面: 打刻修正・通知・応募・掲示板のバッジは API の数で、0 は隠す（今までと同じ見え方）',
      same(shown.corrections, b.corrections.count) && same(shown.notifications, b.notifications.count) && same(shown.recruit, b.recruit.pending) && same(shown.board, b.board.unread), { shown, b })
    ok('画面: 企業間チャットのバッジ（0 は隠す）', b.roster_chat.unread ? shown.chat && shown.chat.text === String(b.roster_chat.unread) && !shown.chat.hidden : (!shown.chat || shown.chat.hidden), { shown: shown.chat, b: b.roster_chat })
    const total = b.corrections.count + b.recruit.pending + b.board.unread + b.roster_chat.unread
    ok('画面: スマホのメニューの件数（項目名の「（n）」とヘッダーの合計）も出る', shown.opt.endsWith(`（${b.corrections.count}）`) && same(shown.mobile, total), { shown, total })

    // 60秒の間の通信は badges の1本だけ
    await wait(61500)
    const minute = cnt(reqs.splice(0))
    ok('画面: 60秒の間の通信は GET /api/admin/badges の1本だけ（前は5本）', JSON.stringify(minute) === JSON.stringify({ 'GET /api/admin/badges': 1 }), minute)

    // タブが裏にあるときは呼ばない（document.hidden を true にして60秒待つ）
    await ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); true`)
    await wait(61500)
    const hidden = cnt(reqs.splice(0))
    ok('画面: タブが裏にあるときは呼ばない', Object.keys(hidden).length === 0, hidden)
    await ev(`delete document.hidden; true`)

    // 通知を読んだ後などの更新（refreshNotifBadge）も badges の1本（前は3本）
    await ev(`window.refreshNotifBadge(); true`); await wait(1500)
    const after = cnt(reqs.splice(0))
    ok('画面: 通知のバッジの更新（refreshNotifBadge）は badges の1本で、打刻修正・応募の数もまとめて更新する', JSON.stringify(after) === JSON.stringify({ 'GET /api/admin/badges': 1 }), after)
    ok('画面: スクリプトのエラーがない', errors.length === 0, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
