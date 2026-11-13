// w23-menus（総点検 Sprint 23。#9961 #9962）の統合テスト
//  #9961 管理画面のメニューの定義を1つの配列（src/admin-menu.ts の ADMIN_MENU）にまとめ、左のメニュー・スマホのメニュー・画面の登録（routes）をそこから作る。
//    JS が後から足していたメニュー（出勤可能日・スタッフの申請）と、ほかの JS からの routes[...] = をやめる。通らない予備の分岐（window.renderX ? … : renderDashboard()）を消す。
//    ロールごとの出し分け（従業員管理は会社管理者・事務担当だけ）は今のまま
//  #9962 スタッフアプリの画面の登録を1つの関数（staff.js の staffScreen）にし、renderMore の二重の包み直し・notifOpenStaff の差し替えをやめる。
//    本部の「解約・データ」のタブは index.tsx の HTML に書く（hq.js の差し込みをやめる）
//  見た目と動きは変えない: メニューの項目・順番・見出し、「その他」の項目と順番、通知から開く画面、本部のタブが変更前と同じこと（変更前の画面から取った一覧と突き合わせる）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8935 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8935 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w23-menus.mjs
//   PERSIST は通知を作るのに使う（wrangler d1 execute は --local のみ）。無いときは通知の行き先の確認を省く
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
//   DUMP=<ファイル> を付けると、画面から取った一覧を JSON で書き出す（変更前の一覧を作るのに使った）
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8935'
const PERSIST = process.env.PERSIST || ''
const DUMP = process.env.DUMP || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const read = (p) => existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') : ''
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
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w23mn-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const j = JSON.parse(out)
      return j[j.length - 1].results
    } catch (e) { if (i >= 3) throw e }
  }
}

// ============ 変更前の画面から取った一覧（DUMP で書き出したもの。見た目を変えていないことの基準） ============
// 管理画面の左のメニュー（会社管理者）。[見出しのキー, 見出し, [[hash, 名前, アイコン, 件数のバッジの id（'' はバッジなし、'*' は JS が足す）], …]]。見出しのキーが '' は見出しの外
const ADMIN_SIDE = [
  ['', '', [['dashboard', 'ダッシュボード', 'fa-gauge-high', ''], ['notifications', '通知', 'fa-bell', 'notif-badge']]],
  ['attendance', 'シフト・勤怠', [['shifts', 'シフト管理', 'fa-calendar-days', ''], ['availability', '出勤可能日', 'fa-calendar-check', ''], ['reports', '日報一覧', 'fa-file-lines', ''],
    ['corrections', '打刻修正承認', 'fa-user-clock', 'corrections-badge'], ['staff-requests', 'スタッフの申請', 'fa-file-signature', 'staff-requests-badge'],
    ['report-settings', '案件報告管理', 'fa-list-check', ''], ['attendance-history', '履歴・CSV', 'fa-clock-rotate-left', '']]],
  ['people', '人材', [['staff', 'スタッフマスタ', 'fa-users', ''], ['employees', '従業員管理', 'fa-id-card', ''], ['partners', '協力会社', 'fa-handshake', ''],
    ['recruit', '募集・応募', 'fa-bullhorn', 'recruit-badge'], ['consult', '相談対応', 'fa-comments', ''], ['follow', 'フォロー履歴', 'fa-handshake-angle', '']]],
  ['deals', '案件・取引', [['projects', '案件管理', 'fa-briefcase', ''], ['clients', 'クライアント', 'fa-building', ''], ['board', '案件掲示板', 'fa-clipboard-list', 'board-badge'], ['roster-chat', '企業間チャット', 'fa-people-arrows', '*']]],
  ['money', 'お金', [['settlement', '精算（請求・支払）', 'fa-scale-balanced', ''], ['billing', '請求前確認', 'fa-file-invoice-yen', '']]],
  ['notices', 'お知らせ', [['notices', 'お知らせ配信', 'fa-bullhorn', ''], ['notice-reports', '既読率レポート', 'fa-chart-pie', '']]],
  ['analytics', '分析', [['analytics', '実績分析', 'fa-chart-column', '']]],
  ['settings', '設定', [['account', 'アカウント設定', 'fa-user-gear', ''], ['security', 'セキュリティ', 'fa-shield-halved', '']]],
]
// スマホのメニュー（選択欄）。[見出し（'' は見出しの外）, [[value, 名前], …]]
const ADMIN_MOBILE = [
  ['', [['dashboard', 'ダッシュボード'], ['notifications', '通知']]],
  ['シフト・勤怠', [['shifts', 'シフト'], ['availability', '出勤可能日'], ['reports', '日報'], ['corrections', '打刻修正承認'], ['staff-requests', 'スタッフの申請'], ['report-settings', '案件報告管理'], ['attendance-history', '履歴・CSV']]],
  ['人材', [['staff', 'スタッフマスタ'], ['employees', '従業員管理'], ['partners', '協力会社'], ['recruit', '募集・応募'], ['consult', '相談'], ['follow', 'フォロー']]],
  ['案件・取引', [['projects', '案件'], ['clients', 'クライアント'], ['board', '案件掲示板'], ['roster-chat', '企業間チャット']]],
  ['お金', [['settlement', '精算'], ['billing', '請求前確認']]],
  ['お知らせ', [['notices', 'お知らせ'], ['notice-reports', '既読率レポート']]],
  ['分析', [['analytics', '分析']]],
  ['設定', [['account', 'アカウント設定'], ['security', 'セキュリティ']]],
]
// 従業員管理（労務情報）を扱えないロールは、従業員管理だけを出さない（#205。今のまま）
const withoutHr = (side) => side.map(([k, l, items]) => [k, l, items.filter(i => i[0] !== 'employees')])
const withoutHrMobile = (mob) => mob.map(([l, opts]) => [l, opts.filter(o => o[0] !== 'employees')])
const ADMIN_EXPECT = {
  company_admin: { side: ADMIN_SIDE, mobile: ADMIN_MOBILE },
  office_staff: { side: ADMIN_SIDE, mobile: ADMIN_MOBILE },
  field_manager: { side: withoutHr(ADMIN_SIDE), mobile: withoutHrMobile(ADMIN_MOBILE) },
  sales_manager: { side: withoutHr(ADMIN_SIDE), mobile: withoutHrMobile(ADMIN_MOBILE) },
}
// スタッフアプリの下のナビ
const STAFF_NAV = [['home', 'ホーム', 'fa-house'], ['shift', 'シフト', 'fa-calendar-days'], ['report', '日報', 'fa-pen-to-square'], ['perf', '実績', 'fa-chart-line'], ['more', 'その他', 'fa-bars']]
// 「その他」の項目。[リンク先（ボタンは data-action）, 名前, 説明, アイコン, 件数のバッジの id, 最初は隠す]
const STAFF_MORE = [
  ['#notices', 'お知らせ', '会社からのお知らせを確認', 'fa-bullhorn', 'more-notice-count', false],
  ['#consult', '相談・連絡', '管理者への相談・連絡', 'fa-comments', '', false],
  ['#notifications', '通知', '打刻修正申請の受付・承認・却下、お知らせの確認のお願い', 'fa-bell', 'more-notif-count', false],
  ['#notify-settings', '通知の設定', 'プッシュ通知・メールの受け取り', 'fa-sliders', '', false],
  ['#attendance', '打刻履歴・修正申請', '打刻の確認・時刻の修正・打刻漏れの追加', 'fa-user-clock', '', false],
  ['#pay', '勤務時間・支払', '月の勤務日数・実働時間の確認、交通費・延長の申請', 'fa-yen-sign', '', false],
  ['#manual', '研修・マニュアル', '案件マニュアル・研修資料', 'fa-book-open', '', false],
  ['tourStaffReplay', '使い方をもう一度見る', 'ホーム画面に追加・打刻・日報・通知の案内', 'fa-circle-question', '', false],
  ['#profile', 'マイプロフィール / スタッフID', '登録情報と企業間連携用QRコード', 'fa-id-badge', '', false],
  ['#my-docs', '書類の提出', '資格証・身分証・入社書類などを写真やPDFで提出', 'fa-file-arrow-up', '', false],
  ['#my-leave', '有給・休暇', '有給の残日数の確認と休暇の申請', 'fa-umbrella-beach', '', null],
  ['#password', 'パスワードの変更', 'ログインのパスワードを変更します', 'fa-lock', '', false],
]
// 画面ごとの上の見出しと、下のナビで選んだ表示になるタブ（'' はどれも選ばない）
const STAFF_SCREENS = [
  ['home', 'ホーム', 'home'], ['shift', 'シフト', 'shift'], ['report', '日報入力', 'report'], ['perf', '実績', 'perf'], ['more', 'その他', 'more'],
  ['attendance', '打刻履歴・修正申請', 'more'], ['notifications', '通知', 'more'], ['notices', 'お知らせ', 'more'], ['consult', '相談・連絡', 'more'], ['manual', '研修・マニュアル', 'more'],
  ['profile', 'マイプロフィール', 'more'], ['password', 'パスワードの変更', 'more'], ['notify-settings', '通知の設定', 'more'], ['pay', '勤務時間・支払', 'more'],
  ['profile-request', '登録情報の変更申請', 'more'], ['my-docs', '書類の提出', 'more'], ['my-leave', '有給・休暇', 'more'],
  ['availability', '出勤可能日の提出', ''], ['calendar', 'カレンダーに追加', ''], ['nosuch', 'ホーム', ''],
]
// 本部画面の上のタブ
const HQ_NAV = [['companies', '導入企業'], ['templates', 'テンプレート配信'], ['retention', 'データ保持・定期処理'], ['mail', 'メール送信'], ['support', '伴走支援'],
  ['announcements', '企業へのお知らせ'], ['security', 'セキュリティ'], ['errors', '障害'], ['offboarding', '解約・データ']]

// ---------- コード ----------
{
  const idx = read('src/index.tsx'), menu = read('src/admin-menu.ts'), adminJs = read('public/static/admin.js')
  const roster = read('public/static/roster.js'), chat = read('public/static/roster-chat.js')
  const staffJs = read('public/static/staff.js'), att = read('public/static/staff-attendance.js'), prof = read('public/static/staff-profile.js'), hqJs = read('public/static/hq.js')
  ok('#9961 メニューの項目は src/admin-menu.ts の ADMIN_MENU の1か所に書く（index.tsx に左のメニュー・スマホのメニューの項目を書かない）',
    /export const ADMIN_MENU\b/.test(menu) && !/<a href="#dashboard" class="side-link/.test(idx) && !/<option value="dashboard">/.test(idx) && /adminSideNavHtml\(/.test(idx) && /adminMobileNavHtml\(/.test(idx))
  ok('#9961 JS がメニューを後から足さない（出勤可能日・スタッフの申請）', !/insertAdjacentHTML\([^)]*side-link/.test(adminJs) && !/#mobile-nav option\[value="(shifts|corrections)"\]/.test(adminJs) && !/addAvailabilityMenu|addStaffRequestsNav/.test(adminJs))
  ok('#9961 ほかの JS から routes[...] = で画面を登録しない（roster.js・roster-chat.js・admin.js）', !/routes(\.[\w]+|\[['"][\w-]+['"]\])\s*=(?!=)/.test(roster + chat + adminJs))
  ok('#9961 通らない予備の分岐（window.renderX ? renderX() : …）を消した', !/window\.render\w+\s*\?\s*render\w+\(\)\s*:/.test(adminJs) && !/&& window\.render\w+\) return/.test(adminJs))
  ok('#9961 routes は ADMIN_MENU（index.tsx が window.ADMIN_SCREENS に入れる）から作る', /window\.ADMIN_SCREENS/.test(idx) && /window\.ADMIN_SCREENS/.test(adminJs))
  ok('#9962 スタッフアプリの画面は staffScreen で登録する（routes・titles・MORE_SUB_TABS を直接書き換えない）',
    /function staffScreen\(/.test(staffJs) && ![att, prof].some(s => /\broutes(\.[\w]+|\[['"][\w-]+['"]\])\s*=(?!=)|\btitles(\.[\w]+|\[)|MORE_SUB_TABS\.push|Object\.assign\(titles/.test(s))
    && !/\broutes(\.[\w]+|\[['"][\w-]+['"]\])\s*=(?!=)|titles(\.[\w]+|\[['"][\w-]+['"]\])\s*=|MORE_SUB_TABS\.push/.test(staffJs))
  ok('#9962 renderMore を包み直さない・notifOpenStaff を差し替えない', !/window\.renderMore\s*=/.test(att + prof + staffJs) && (att.match(/window\.notifOpenStaff\s*=/g) || []).length === 1 && !/window\.notifOpenStaff\s*=/.test(prof + staffJs) && !/_origNotifOpenStaff|_origRenderMore|origMore/.test(att + prof + staffJs))
  ok('#9962 本部の「解約・データ」のタブは index.tsx の HTML に書く（hq.js は足さない）', /<a href="#offboarding" class="hq-nav px-3 py-1\.5 rounded-lg" data-tab="offboarding">解約・データ<\/a>/.test(idx) && !/addOffboardingNav|textContent = '解約・データ'/.test(hqJs))
}

// ---------- サーバーの HTML ----------
const adminCk = await login('sample', 'admin')
const admin = client(adminCk)
const mgrCk = await login('sample', 'mgr01'), salesCk = await login('sample', 'sales01')
const hqCk = await login('', 'hq')
const staffCk = await login('sample', 'st001')
// 事務担当（office_staff）のアカウントを作る
const officeCode = `w23of${Date.now() % 100000}`
must(await admin.post('/api/admin/users', { user_code: officeCode, name: 'W23 事務', email: `${officeCode}@example.com`, role: 'office_staff', password: 'w23pass1234' }), '事務担当の作成')
const officeCk = await login('sample', officeCode, 'w23pass1234')
const ROLE_CK = { company_admin: adminCk, office_staff: officeCk, field_manager: mgrCk, sales_manager: salesCk }
{
  const pages = {}
  for (const [role, ck] of Object.entries(ROLE_CK)) pages[role] = (await client(ck).get('/admin')).text
  const tabsOf = (html) => [...html.slice(html.indexOf('id="side-nav"'), html.indexOf('</nav>', html.indexOf('id="side-nav"'))).matchAll(/class="side-link[^"]*" data-tab="([\w-]+)"/g)].map(m => m[1])
  const optsOf = (html) => { const a = html.indexOf('<select id="mobile-nav"'); return [...html.slice(a, html.indexOf('</select>', a)).matchAll(/<option value="([\w-]+)">/g)].map(m => m[1]) }
  const flat = (side) => side.flatMap(g => g[2].map(i => i[0]))
  for (const [role, exp] of Object.entries(ADMIN_EXPECT)) {
    ok(`#9961 /admin の HTML（${role}）: 左のメニューとスマホのメニューに、出す項目だけが順番どおりにある`, JSON.stringify(tabsOf(pages[role])) === JSON.stringify(flat(exp.side)) && JSON.stringify(optsOf(pages[role])) === JSON.stringify(flat(exp.side)), { side: tabsOf(pages[role]), mob: optsOf(pages[role]) })
  }
  ok('#9961 /admin の HTML: 画面の一覧（window.ADMIN_SCREENS）に、メニューの項目と協力会社の追記の画面がある', ['dashboard', 'employees', 'partners', 'roster-chat', 'roster-notes', 'availability', 'staff-requests', 'board'].every(h => pages.company_admin.includes(`["${h}",`)))
  const hqHtml = (await client(hqCk).get('/hq')).text
  const hqTabs = [...hqHtml.matchAll(/<a href="#([\w-]+)" class="hq-nav[^"]*" data-tab="\1">/g)].map(m => m[1])
  ok('#9962 /hq の HTML: 上のタブが順番どおり（解約・データを含む）', JSON.stringify(hqTabs) === JSON.stringify(HQ_NAV.map(x => x[0])), hqTabs)
}

// ---------- 通知（スタッフアプリで開いたときの行き先）を作る ----------
const NOTIFS = [
  // [種類, リンク, related_id, 開いたときの行き先（location.hash の # の後）]
  ['shift_changed', '#shift/2026-12-03', null, 'shift/2026-12-03'],
  ['recruit_result', null, null, 'shift'],
  ['daily_report_comment', '#report', 1, 'report'],
  ['profile_change_approved', '#profile-request', null, 'profile-request'],
  ['leave_approved', '#my-leave', null, 'my-leave'],
  ['consult_reply', '#consult', null, 'consult'],
  ['notice_confirm', '#notices/1', null, 'notices/1'],
  ['pay_request_approved', '#pay/2026-10', null, 'pay/2026-10'],
  ['availability_request', '#availability/2026-12', null, 'availability/2026-12'],
  ['profile_change_approved', '#nosuch', null, 'attendance'],
  ['other_kind', null, null, 'attendance'],
]
let notifIds = []
if (PERSIST) {
  const vals = NOTIFS.map(([k, link, rel], i) => `(1, 4, '${k}', 'W23 通知${i + 1}', 'w23', ${link ? `'${link}'` : 'NULL'}, ${rel == null ? 'NULL' : rel})`).join(',\n')
  sql(`DELETE FROM user_notifications WHERE user_id = 4 AND body = 'w23';
INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id) VALUES ${vals};`)
  notifIds = sql(`SELECT notification_id AS id, title FROM user_notifications WHERE user_id = 4 AND body = 'w23' ORDER BY notification_id`).map(r => Number(r.id))
  ok('（準備）通知を作った', notifIds.length === NOTIFS.length, notifIds)
} else console.log('SKIP  通知の行き先（PERSIST が無いため）')

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
const dump = {}
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()
if (DUMP) writeFileSync(DUMP, JSON.stringify(dump, null, 1))

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()  // 空いているポート（#9980）
  const prof = mkdtempSync(join(tmpdir(), 'w23mn-chrome-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = list && list.find(t => t.type === 'page')
    if (!pg) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: false })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w23-menus-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    const width = async (w) => send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 800 : 900, deviceScaleFactor: 1, mobile: w < 600 })
    // 同じ URL（# の後だけ違う）への移動はページを読み直さないので、いったん空のページに移ってから開く
    const go = async (path) => { await send('Page.navigate', { url: 'about:blank' }); await wait(200); await send('Page.navigate', { url: BASE + path }) }
    const drawnExpr = `!document.querySelector('#app .fa-spinner') && document.getElementById('app').innerText.trim().length > 10`
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    // ----- 管理画面: ロールごとのメニュー（PC の幅とスマホの幅） -----
    // 件数のバッジの中身・active・畳んだときの title は、開いたときの状態で変わるので外して比べる
    const ADMIN_MENU_EXPR = `(() => {
      const icon = a => ((a.querySelector('i') || {}).className || '').split(' ').find(c => c.startsWith('fa-') && c !== 'fa-solid') || ''
      const text = a => [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const badge = a => { const s = a.querySelector('span[id]'); return s ? s.id : a.querySelector('.chat-badge') || /flex/.test(a.className) ? '*' : '' }
      const item = a => [a.dataset.tab, text(a), icon(a), badge(a)]
      const side = []
      const top = [...document.querySelectorAll('#side-nav > a.side-link')]
      if (top.length) side.push(['', '', top.map(item)])
      for (const g of document.querySelectorAll('#side-nav > .nav-group')) {
        if (g.classList.contains('hidden')) continue
        side.push([g.dataset.group, g.querySelector('.nav-group-head span').textContent, [...g.querySelectorAll('.nav-group-body > a.side-link')].map(item)])
      }
      const lab = o => (o.dataset.label || o.textContent).replace(/（\\d+）$/, '')
      const mobile = []
      const sel = document.getElementById('mobile-nav')
      const loose = [...sel.children].filter(c => c.tagName === 'OPTION')
      if (loose.length) mobile.push(['', loose.map(o => [o.value, lab(o)])])
      for (const og of sel.querySelectorAll('optgroup')) if (!og.hidden) mobile.push([og.label, [...og.querySelectorAll('option')].map(o => [o.value, lab(o)])])
      // リンクの形（class・属性）も比べる（件数・active・title は外す）
      const shape = [...document.querySelectorAll('#side-nav a.side-link')].map(a => { const c = a.cloneNode(true); c.querySelectorAll('.chat-badge').forEach(x => x.remove()); c.querySelectorAll('span').forEach(s => { s.textContent = ''; s.classList.remove('hidden') }); c.classList.remove('active'); c.removeAttribute('title'); c.removeAttribute('data-side-title'); return c.outerHTML.replace(/\\s+/g, ' ').replace(/> </g, '><') })
      const heads = [...document.querySelectorAll('#side-nav .nav-group-head')].map(h => h.outerHTML.replace(/\\s+/g, ' ').replace(/> </g, '><'))
      return { who: (document.getElementById('company-name') || {}).textContent || '', side, mobile, shape, heads, sideVisible: getComputedStyle(document.getElementById('sidebar')).display !== 'none', mobileVisible: getComputedStyle(sel).display !== 'none' && !!sel.offsetParent }
    })()`
    dump.admin = {}
    for (const [role, ck] of Object.entries(ROLE_CK)) {
      await client(ck).put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup'].map(key => ({ key, status: 'skipped', step: 0 })) })
      await as(ck)
      for (const w of [1280, 375]) {
        errors = []
        await width(w)
        await go('/admin#dashboard')
        await until(`typeof delegate === 'function' && !!document.getElementById('app') && document.getElementById('app').innerText.length > 20 && (typeof ME === 'undefined' || !!ME)`, 40000)
        await wait(1500)
        const got = await ev(ADMIN_MENU_EXPR)
        dump.admin[`${role}-${w}`] = got
        const exp = ADMIN_EXPECT[role]
        ok(`#9961 管理画面（${role}・幅 ${w}）: 左のメニューの項目・順番・見出し・アイコン・件数のバッジが変更前と同じ`, JSON.stringify(got.side) === JSON.stringify(exp.side), got.side)
        ok(`#9961 管理画面（${role}・幅 ${w}）: スマホのメニューの項目・順番・見出しが変更前と同じ`, JSON.stringify(got.mobile) === JSON.stringify(exp.mobile), got.mobile)
        ok(`#9961 管理画面（${role}・幅 ${w}）: ${w < 600 ? 'スマホのメニューを出し、左のメニューは隠す' : '左のメニューを出し、スマホのメニューは隠す'}`, w < 600 ? (got.mobileVisible && !got.sideVisible) : (got.sideVisible && !got.mobileVisible), got)
        if (w === 375) await shot(`admin-${role}-375`)
        ok(`#9961 管理画面（${role}・幅 ${w}）: スクリプトのエラーがない`, errors.length === 0, errors)
      }
    }
    // リンクの形（class・属性）は、変更前に取ったものと同じ（BEFORE=<DUMP の JSON> のときだけ）
    if (process.env.BEFORE && existsSync(process.env.BEFORE)) {
      const before = JSON.parse(readFileSync(process.env.BEFORE, 'utf8'))
      for (const k of Object.keys(dump.admin)) {
        const a = dump.admin[k], b = before.admin && before.admin[k]
        ok(`#9961 管理画面（${k}）: メニューのリンクと見出しの HTML が変更前と同じ（class・属性・中の要素）`, b && JSON.stringify(a.shape) === JSON.stringify(b.shape) && JSON.stringify(a.heads) === JSON.stringify(b.heads),
          b && { diff: a.shape.map((s, i) => s !== b.shape[i] ? [s, b.shape[i]] : null).filter(Boolean).slice(0, 3) })
      }
    }

    // ----- 管理画面: 各ハッシュで画面が開く（会社管理者） -----
    await width(1280)
    await as(adminCk)
    await go('/admin#dashboard')
    await until(`typeof delegate === 'function' && !!document.getElementById('app') && document.getElementById('app').innerText.length > 20`, 40000)
    const sid = Number((must(await admin.get('/api/admin/staff'), 'staff').staff || [])[0]?.staff_id)
    const pid = Number((must(await admin.get('/api/admin/projects'), 'projects').projects || [])[0]?.project_id)
    const cid = Number((must(await admin.get('/api/admin/clients'), 'clients').clients || [])[0]?.client_id)
    const hashes = ADMIN_SIDE.flatMap(g => g[2].map(i => i[0])).concat(['roster-notes', `staff/${sid}`, `projects/${pid}`, 'projects/templates', `clients/${cid}`, 'analytics/', `analytics/${pid}`, 'shifts/week',
      'board/new', 'board/threads', 'corrections/emails', 'corrections/punches', 'report-settings/off', 'staff-requests/documents', 'availability/2026-12', 'nosuch'])
    const opened = []
    errors = []
    for (const h of hashes) {
      await ev(`location.hash = ${JSON.stringify(h)}`)
      await wait(400)
      const drawn = await until(drawnExpr, 15000)
      // 後から読む部分（募集の応募の一覧など）が描き終わるのを待ってから次へ移る
      await wait(1200)
      const st = await ev(`({ active: (document.querySelector('#side-nav .side-link.active') || {}).dataset?.tab || '', mob: document.getElementById('mobile-nav').value, h2: ((document.querySelector('#app h2') || {}).textContent || '').trim().slice(0, 40) })`)
      opened.push({ h, drawn, ...st })
    }
    dump.adminRoutes = opened
    const BEFORE_DUMP = process.env.BEFORE && existsSync(process.env.BEFORE) ? JSON.parse(readFileSync(process.env.BEFORE, 'utf8')) : null
    if (BEFORE_DUMP && BEFORE_DUMP.adminRoutes) {
      const diff = opened.filter(o => { const b = BEFORE_DUMP.adminRoutes.find(x => x.h === o.h); return !b || b.h2 !== o.h2 || b.active !== o.active })
      ok('#9961 管理画面: 各ハッシュで開く画面（見出し）と選ばれるメニューの項目が変更前と同じ', !diff.length, diff)
    }
    ok('#9961 管理画面: メニューのすべての項目・詳細・サブ画面のハッシュで画面が開く', opened.every(o => o.drawn), opened.filter(o => !o.drawn))
    const tabOf = h => h.split('/')[0]
    // 変更前は #board だけ routes に無かったため、スマホのメニューの値が前の画面のまま残っていた（今は案件掲示板を選ぶ。ほかの項目は前と同じ）
    ok('#9961 管理画面: 開いた画面のメニューの項目が選ばれ、スマホのメニューの値も合う（メニューにない画面は選ばない）',
      opened.every(o => ADMIN_SIDE.some(g => g[2].some(i => i[0] === tabOf(o.h))) ? (o.active === tabOf(o.h) && o.mob === tabOf(o.h)) : o.active === ''), opened.map(o => [o.h, o.active, o.mob]))
    ok('#9961 管理画面: 知らないハッシュはダッシュボードを描く', /ダッシュボード|今日/.test(JSON.stringify(opened.find(o => o.h === 'nosuch'))) || opened.find(o => o.h === 'nosuch')?.drawn, opened.find(o => o.h === 'nosuch'))
    ok('#9961 管理画面: 画面を開いている間にスクリプトのエラーがない', errors.length === 0, errors)
    // 従業員管理を扱えないロールが #employees を開くと、今までどおり案内を出す・詳細はスタッフ詳細へ
    await as(mgrCk)
    await go('/admin#employees')
    const lock = await until(`!!document.getElementById('app') && /会社管理者と事務担当のみ/.test(document.getElementById('app').innerText)`, 30000)
    await ev(`location.hash = 'employees/${sid}'`)
    const toStaff = await until(`location.hash === '#staff/${sid}'`, 10000)
    ok('#9961 現場責任者が #employees を開くと案内を出し、#employees/<ID> はスタッフ詳細へ移す（今のまま）', lock && toStaff)

    // ----- スタッフアプリ（375px と PC の幅） -----
    await client(staffCk).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] })
    await as(staffCk)
    dump.staff = {}
    for (const w of [375, 1280]) {
      errors = []
      await width(w)
      await go('/staff#home')
      await until(`!!document.getElementById('app') && document.getElementById('app').innerText.trim().length > 10`, 30000)
      const nav = await ev(`[...document.querySelectorAll('#bottom-nav a.nav-item')].map(a => [a.dataset.tab, [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(), ((a.querySelector('i') || {}).className || '').split(' ').find(c => c.startsWith('fa-') && c !== 'fa-solid' && c !== 'fas') || ''])`)
      ok(`#9962 スタッフアプリ（幅 ${w}）: 下のナビの項目と順番が変更前と同じ`, JSON.stringify(nav) === JSON.stringify(STAFF_NAV), nav)
      await ev(`location.hash = 'more'`)
      await until(`!!document.querySelector('#app a[href="#password"]')`, 15000)
      await wait(800)
      const more = await ev(`[...document.querySelectorAll('#app .space-y-3 > .report-btn')].map(a => [a.getAttribute('href') || a.dataset.action, (a.querySelector('.font-bold') ? [...a.querySelector('.font-bold').childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() : ''),
        ((a.querySelector('.text-xs') || {}).textContent || '').trim(), ((a.querySelector('i') || {}).className || '').split(' ').find(c => c.startsWith('fa-') && c !== 'fas') || '', (a.querySelector('span[id]') || {}).id || '', a.classList.contains('hidden')])`)
      dump.staff[`more-${w}`] = more
      const moreShape = await ev(`[...document.querySelectorAll('#app .space-y-3 > .report-btn')].map(a => { const c = a.cloneNode(true); c.querySelectorAll('span[id]').forEach(s => { s.textContent = ''; s.classList.remove('hidden') }); c.classList.remove('hidden'); return c.outerHTML.replace(/\\s+/g, ' ').replace(/> </g, '><') })`)
      dump.staff[`moreShape-${w}`] = moreShape
      if (process.env.BEFORE && existsSync(process.env.BEFORE)) {
        const b = (JSON.parse(readFileSync(process.env.BEFORE, 'utf8')).staff || {})[`moreShape-${w}`]
        ok(`#9962 スタッフアプリ（幅 ${w}）: 「その他」の項目の HTML が変更前と同じ（class・属性・中の要素）`, b && JSON.stringify(b) === JSON.stringify(moreShape), b && moreShape.map((x, i) => x !== b[i] ? [x, b[i]] : null).filter(Boolean).slice(0, 2))
      }
      ok(`#9962 スタッフアプリ（幅 ${w}）: 「その他」の項目・順番・説明・アイコンが変更前と同じ`, more.length === STAFF_MORE.length && STAFF_MORE.every((e, i) => more[i] && e.slice(0, 5).every((v, k) => v === more[i][k]) && (e[5] === null || e[5] === more[i][5])), more)
      if (w === 375) await shot('staff-more-375')
      const screens = []
      for (const [h, title, navTab] of STAFF_SCREENS) {
        await ev(`location.hash = ${JSON.stringify(h)}`)
        await wait(300)
        const drawn = await until(drawnExpr, 15000)
        await wait(500)
        const st = await ev(`({ title: document.getElementById('header-title').textContent, nav: (document.querySelector('#bottom-nav .nav-item.active') || {}).dataset?.tab || '' })`)
        screens.push({ h, drawn, ...st, ok: drawn && st.title === title && st.nav === navTab })
      }
      dump.staff[`screens-${w}`] = screens
      ok(`#9962 スタッフアプリ（幅 ${w}）: 各画面が開き、上の見出しと下のナビの選択が変更前と同じ`, screens.every(s => s.ok), screens.filter(s => !s.ok))
      // 「その他」の中の画面の「戻る」（renderMore() を呼ぶボタン）で「その他」に戻る
      await ev(`location.hash = 'profile'`)
      await until(drawnExpr, 15000)
      await ev(`renderMore()`)
      const back = await until(`location.hash === '#more' && !!document.querySelector('#app a[href="#password"]') && !!document.querySelector('#app a[href="#pay"]')`, 10000)
      ok(`#9962 スタッフアプリ（幅 ${w}）: マイプロフィールの「戻る」（renderMore）で「その他」に戻り、項目が揃う`, back)
      ok(`#9962 スタッフアプリ（幅 ${w}）: スクリプトのエラーがない`, errors.length === 0, errors)
    }
    // 通知から開く画面
    if (notifIds.length) {
      await width(375)
      errors = []
      const went = []
      for (let i = 0; i < NOTIFS.length; i++) {
        await ev(`location.hash = 'home'`)
        await wait(300)
        await ev(`location.hash = 'notifications'`)
        const listed = await until(`!!document.querySelector('[data-action="notifOpenStaff"][data-id="${notifIds[i]}"]')`, 15000)
        await ev(`document.querySelector('[data-action="notifOpenStaff"][data-id="${notifIds[i]}"]').click()`)
        await until(`location.hash !== '#notifications'`, 8000)
        await wait(800)
        const h = await ev(`location.hash.slice(1)`)
        went.push({ kind: NOTIFS[i][0], link: NOTIFS[i][1], listed, h, ok: listed && h === NOTIFS[i][3] })
      }
      dump.staffNotifs = went
      ok('#9962 スタッフアプリ: 通知から開く画面が変更前と同じ（シフト・募集・日報のコメント・変更申請・休暇・相談・お知らせ・支払・出勤可能日・知らない通知）', went.every(x => x.ok), went.filter(x => !x.ok))
      const unread = sql(`SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 4 AND body = 'w23' AND read_at IS NULL`)[0]
      ok('#9962 スタッフアプリ: 開いた通知はすべて既読になる', Number(unread.n) === 0, unread)
      ok('#9962 スタッフアプリ: 通知を開いている間にスクリプトのエラーがない', errors.length === 0, errors)
    }

    // ----- 本部画面（PC の幅と 375px） -----
    await as(hqCk)
    dump.hq = {}
    for (const w of [1280, 375]) {
      errors = []
      await width(w)
      await go('/hq#companies')
      await until(`!!document.querySelector('.hq-nav') && !!document.getElementById('app') && document.getElementById('app').innerText.trim().length > 10`, 30000)
      const nav = await ev(`[...document.querySelectorAll('header nav a')].map(a => [a.dataset.tab, [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(), a.className.replace(/\\bactive\\b/, '').trim(), a.getAttribute('href')])`)
      dump.hq[`nav-${w}`] = nav
      ok(`#9962 本部画面（幅 ${w}）: 上のタブの項目・順番・形が変更前と同じ（解約・データが最後）`, JSON.stringify(nav.map(n => n.slice(0, 2))) === JSON.stringify(HQ_NAV) && nav.every(n => n[2] === 'hq-nav px-3 py-1.5 rounded-lg' && n[3] === '#' + n[0]), nav)
      const tabs = []
      for (const [t] of HQ_NAV) {
        await ev(`location.hash = ${JSON.stringify(t)}`)
        await wait(400)
        const drawn = await until(drawnExpr, 15000)
        const active = await ev(`[...document.querySelectorAll('.hq-nav.active')].map(a => a.dataset.tab).join(',')`)
        tabs.push({ t, drawn, active, ok: drawn && active === t })
      }
      if (w === 375) await shot('hq-375')
      ok(`#9962 本部画面（幅 ${w}）: 各タブが開き、そのタブが選ばれる`, tabs.every(x => x.ok), tabs.filter(x => !x.ok))
      ok(`#9962 本部画面（幅 ${w}）: スクリプトのエラーがない`, errors.length === 0, errors)
    }
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

try { rmSync(SQL_DIR, { recursive: true, force: true }) } catch { }
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
