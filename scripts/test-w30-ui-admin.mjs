// w30-ui-admin（Sprint 30 #9987。11/16 の打合せで採用した管理画面・本部の画面の直し）の統合テスト
//  No.6 ダッシュボードの並び替え（ui-admin-02）: 今日の数字 → 予定の時刻を過ぎた未報告 → 本日のシフト・報告状況 → 管理者ToDo・インシデント →
//       日報未提出・今後の人員不足 → 前日確認 → 写真の設定 → 今月の集計・要フォロー（下でたたむ。開け閉めは端末に覚える）。
//       曜日を「Mo」から「月」に（ui-admin-11。admin.js で dayjs を日本語にする）
//  No.7 スマホで崩れていた詳細画面（ui-admin-01・03）: 案件・スタッフ・クライアント・従業員の詳細の見出しを2段（戻ると名前／操作のボタン）にし、
//       表は画面の幅に収める（左の列を固定して表の中だけ横に動く）。ページ全体は横にスクロールしない
//  No.9 本部の企業一覧（ui-hq-01・02）: 企業名の列を固定・最小の幅にし、暗い地で読めなかったボタンを濃い枠のボタン（btn-dark-outline・btn-warn）に
//  No.8（スマホでボタンを44px以上）は見送りなので入れていないことも確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9021 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9021 node --import ./scripts/fetch-origin.mjs scripts/test-w30-ui-admin.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。
//   SHOT_DIR=<フォルダ> で、新旧比較の写真（打合せ/20261116_画面の新旧比較/img/ui1/after）と同じ幅（390px・1280px）の画面の写しを残す
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}

// ---------- コード ----------
const adminJs = read('public/static/admin.js'), hqJs = read('public/static/hq.js'), css = read('src/input.css'), built = read('public/static/style.css')
const dash = adminJs.slice(adminJs.indexOf('async function renderDashboard()'), adminJs.indexOf('// ---------- ダッシュボード: 本日のシフトの表'))
const pos = (s) => dash.indexOf(s)
const ORDER = ['id="kpi-cards"', 'id="unreported-section"', 'id="today-shifts"', 'id="todo-section"', 'id="incident-section"', 'id="dash-missing-reports"', 'id="dash-ahead"', '${dashDayBeforeHtml(data)}', 'id="dash-photo-setting"', 'id="dash-monthly"', '要フォロースタッフ</h3>', '今月の案件別実績</h3>']
ok('#9987 No.6 ダッシュボードの並び: 今日の数字→未報告→本日のシフト→ToDo・インシデント→日報未提出・人員不足→前日確認→写真の設定→今月の集計・要フォロー',
  ORDER.every((s, i) => pos(s) >= 0 && (i === 0 || pos(ORDER[i - 1]) < pos(s))), ORDER.map(pos))
const fold = dash.slice(pos('id="dash-monthly"'), dash.indexOf('</details>'))
ok('#9987 No.6 今月の集計・要フォローは <details> でたたみ、案内（tour.js）が指す要素はたたむ所の外に置く',
  /<details class="mb-5 dash-fold" id="dash-monthly" \$\{DASH_MONTHLY_OPEN \? 'open' : ''\}>/.test(dash) && fold.includes('要フォロースタッフ</h3>') && fold.includes('今月の案件別実績</h3>')
  && ['kpi-cards', 'unreported-section', 'todo-section', 'today-shifts', 'dash-ahead'].every(id => !fold.includes(`id="${id}"`)))
ok('#9987 No.6 開け閉めは端末に覚える（localStorage。覚えられなくても開け閉めはできる）', /const DASH_MONTHLY_KEY = 'admin-dash-monthly-open'/.test(adminJs) && /try \{ localStorage\.setItem\(DASH_MONTHLY_KEY, d\.open \? '1' : '0'\) \} catch/.test(adminJs))
ok('#9987 No.6 今月の案件別実績: 案件名の列を固定（tbl-sticky-col）・数字は右寄せ', /<th class="tbl-sticky-col">案件<\/th><th class="text-right">日報<\/th>/.test(dash) && /<td class="tbl-sticky-col"><a href="#projects\//.test(dash) && /text-right whitespace-nowrap tabular-nums/.test(dash))
ok('#9987 No.6 ui-admin-11: 管理画面の dayjs を日本語の曜日に（weekdaysMin が 日〜土。週の始まりは変えない）',
  /dayjs\.locale\(\{\s*name: 'ja',[\s\S]{0,200}weekdaysMin: '日_月_火_水_木_金_土'\.split\('_'\)/.test(adminJs) && !/weekStart/.test(adminJs))
ok('#9987 No.6 ui-admin-11 は common.js に入れない（スタッフアプリの表示を変えない）', !/dayjs\.locale\(/.test(read('public/static/common.js')))
// 詳細画面の見出し
ok('#9987 No.7 詳細画面の見出しを共通の detailHeaderHtml（スマホは2段・md 以上は1行）にする', /function detailHeaderHtml\(\{ back, above, title, sub, actions \}\)/.test(adminJs)
  && /<div class="detail-head flex flex-col md:flex-row md:items-center gap-3 mb-5">/.test(adminJs) && /<div class="min-w-0 flex-1">/.test(adminJs))
for (const [fn, back] of [['staffDetailHeaderHtml', '#staff'], ['renderProjectDetail', '#projects'], ['renderClientDetail', '#clients'], ['renderEmployeeDetail', '#employees']]) {
  const body = adminJs.slice(adminJs.indexOf(`function ${fn}(`), adminJs.indexOf(`function ${fn}(`) + 4000)
  ok(`#9987 No.7 ${fn} の見出しは detailHeaderHtml を使い、戻るボタンは縮まない（shrink-0）`, body.includes('${detailHeaderHtml({') && body.includes(`href="${back}" class="btn btn-outline shrink-0"`))
}
ok('#9987 No.7 詳細画面の2列の grid に grid-cols-1（子が縮み、表が画面の幅を広げない）', !/class="grid lg:grid-cols-2 gap-4(?: mb-4)?">/.test(adminJs.slice(adminJs.indexOf('function staffDetailHeaderHtml'), adminJs.indexOf('async function renderAccount'))))
// 本部
ok('#9987 No.9 本部の企業一覧: 企業名の列を固定（hq-sticky-col）・ほかの列は折り返さない', /\{ key: 'company_name', label: '企業', cls: 'text-left px-4 hq-sticky-col' \}/.test(hqJs) && /<td class="px-4 py-3 font-medium hq-sticky-col">/.test(hqJs)
  && /<td class="px-3 py-3 whitespace-nowrap">\$\{esc\(PLAN_LABELS/.test(hqJs))
ok('#9987 No.9 本部の白い .btn-outline に明るい文字を重ねたボタンをなくす（btn-dark-outline・btn-warn に）', !/btn-outline[^"]*" style="border-color:rgb\(var\(--color-(hq-700|warning-700)\)\)/.test(hqJs)
  && (hqJs.match(/btn btn-dark-outline/g) || []).length >= 14 && /class="btn btn-warn text-xs" data-action="hqCloseBilling"/.test(hqJs))
ok('#9987 No.9 本部の上のタブ: 狭い画面では名前の下の段に並べ、タブの帯の中だけを横に動かす（タブの名前は折り返さない）',
  /<div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-x-4 gap-y-2">/.test(read('src/index.tsx')) && /<nav class="flex gap-1 min-w-0 overflow-x-auto">/.test(read('src/index.tsx'))
  && /\.hq-nav \{ white-space: nowrap; flex-shrink: 0; \}/.test(css))
// CSS
const added = (css.slice(css.indexOf('.tbl-sticky-col'), css.indexOf('/* 本部ナビ */')) + css.slice(css.indexOf('.btn-dark-outline'), css.indexOf('/* 長い URL・英数字'))).replace(/\/\*[\s\S]*?\*\//g, '')
ok('#9987 input.css: 足したクラスはトークン（rgb(var(--color-…))）だけを使い、#xxxxxx を書かない', added.includes('rgb(var(--color-hq-200))') && !/#[0-9a-fA-F]{3,8}\b/.test(added), added.match(/#[0-9a-fA-F]{3,8}\b/g))
ok('#9987 ビルドした style.css に足したクラスが出ている', ['.btn-dark-outline{', '.btn-warn{', '.hq-sticky-col{', '.tbl-sticky-col{', '.dash-fold-caret{'].every(s => built.includes(s)))
ok('#9987 No.8（スマホでボタン・入力欄を44px以上）は見送りなので入れていない', !/min-height: 44px/.test(css) && !/tap-44/.test(css + adminJs + hqJs))

// ---------- API ----------
const adminCk = await login('sample', 'admin'), hqCk = await login('', 'hq')
const admin = client(adminCk), hq = client(hqCk)
const TAG = `w30ui${Date.now() % 100000}`
const LONG = `${TAG} 株式会社ロングネームモバイルプロモーション東日本ホールディングス 携帯ショップ新宿西口 常駐販売（週末ヘルプあり）`
const cl = await admin.post('/api/admin/clients', { client_name: LONG, client_name_kana: 'ロングネーム モバイル プロモーション ヒガシニホン', ng_staff_ids: '' })
const CID = Number(cl.data && (cl.data.client_id || cl.data.id))
ok('（前提）長い名前のクライアントを登録できる', cl.status === 200 && CID > 0, cl)
const pj = await admin.post('/api/admin/projects', { project_name: LONG, client_id: CID, project_type: 'mobile_shop', location: '東京都新宿区西新宿1-1-1 ロングネームビル 3F', unit_price: 18000, unit_price_type: 'daily' })
const PID = Number(pj.data && (pj.data.project_id || pj.data.id))
ok('（前提）長い名前の案件を登録できる', pj.status === 200 && PID > 0, pj)
const d = await admin.get('/api/admin/dashboard')
ok('#9987 No.6 ダッシュボードの API は今までの項目をそのまま返す（並べ替えは画面だけ）', d.status === 200 && ['shifts', 'unreported', 'missing_daily_reports', 'staffing_ahead', 'day_before', 'incidents', 'follow_staff', 'project_performance', 'performance_fields', 'todos', 'photo_required_attendance'].every(k => k in d.data), d.status)
const staffList = await admin.get('/api/admin/staff')
const staffRows = (staffList.data && (staffList.data.staff || staffList.data.rows)) || []
const own = staffRows.find(s => s.affiliation_type === 'own_employee' && s.user_role !== 'roster_only') || staffRows[0]
const SID = Number(own && own.staff_id)
ok('（前提）スタッフ詳細・従業員詳細の API が開ける', SID > 0 && (await admin.get(`/api/admin/staff/${SID}`)).status === 200 && (await admin.get(`/api/admin/employees/${SID}`)).status === 200, { SID })
const co = await hq.get('/api/hq/companies')
ok('#9987 No.9 本部の企業一覧の API は今までどおり返す', co.status === 200 && Array.isArray(co.data.companies) && co.data.companies.length > 0, co.status)

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
const PAGE_FN = `(function () { const s = document.scrollingElement; return { sw: s.scrollWidth, cw: document.documentElement.clientWidth } })()`
// 文字とその後ろの地（透明なら親をたどる）のコントラスト比
const CONTRAST_FN = `(function (el) {
  const rgb = (s) => (s.match(/[\\d.]+/g) || []).map(Number)
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  let a = el, bg = null
  while (a) { const c = rgb(getComputedStyle(a).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) { bg = c; break } a = a.parentElement }
  bg = bg || [255, 255, 255]
  const fg = rgb(getComputedStyle(el).color)
  const L1 = lum(fg), L2 = lum(bg)
  return Math.round((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) * 100) / 100
})`

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w30uia-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let tabs
    for (let i = 0; i < 60 && !tabs; i++) { await wait(300); tabs = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = tabs && tabs.find(t => t.type === 'page')
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
    let curW = 1280
    // full: ページ全体（縦に長い画面）を撮る。新旧比較の写真と同じ撮り方
    const shot = async (name, full) => {
      if (!process.env.SHOT_DIR) return
      let clip
      if (full) { const h = await ev(`Math.ceil(document.scrollingElement.scrollHeight)`); clip = { x: 0, y: 0, width: curW, height: Math.min(Number(h) || 900, 6000), scale: 1 } }
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w30-ui-admin-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    const setWidth = (w) => { curW = w; return send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 }) }
    const pageNoScroll = async (label) => { const p = await ev(PAGE_FN); ok(label, p && p.sw <= p.cw + 1, p) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    await client(adminCk).put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup', ...['dashboard', 'clients', 'projects', 'staff'].map(x => 'admin-screen-' + x)].map(key => ({ key, status: 'skipped', step: 0 })) })

    // ----- ダッシュボード -----
    for (const w of [1280, 390]) {
      errors = []
      await setWidth(w)
      await as(adminCk)
      await send('Page.navigate', { url: `${BASE}/admin#dashboard` })
      const drawn = await until(`!!document.getElementById('kpi-cards') && !!document.getElementById('dash-monthly') && !!document.querySelector('#dash-shift-rows tr')`, 40000)
      ok(`画面 ${w}px: ダッシュボードが描ける`, drawn)
      if (!drawn) continue
      await ev(`try { localStorage.removeItem('admin-dash-monthly-open') } catch (e) {} ; true`)
      await send('Page.reload'); await wait(800); await until(`!!document.getElementById('dash-monthly') && !!document.querySelector('#dash-shift-rows tr')`, 40000)
      await wait(400)
      const tops = await ev(`['kpi-cards','unreported-section','today-shifts','todo-section','dash-missing-reports','dash-day-before','dash-photo-setting','dash-monthly'].map(id => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null })`)
      ok(`画面 ${w}px: 上から 今日の数字→未報告→本日のシフト→ToDo→日報未提出→前日確認→写真の設定→今月の集計 の順に並ぶ`, Array.isArray(tops) && tops.every(t => t != null) && tops.every((t, i) => i === 0 || tops[i - 1] < t), tops)
      ok(`画面 ${w}px: 今月の集計・要フォローは最初はたたんである（中の表は見えない）`, await ev(`(() => { const d = document.getElementById('dash-monthly'); return !d.open && !d.querySelector('table').checkVisibility() })()`))
      ok(`画面 ${w}px: 曜日は日本語（dayjs の dd が「日」〜「土」）`, await ev(`dayjs('2026-11-15').format('M/D(dd)') === '11/15(日)' && dayjs('2026-11-16').format('dd') === '月' && dayjs('2026-11-16').startOf('week').format('D') === '15'`))
      await pageNoScroll(`画面 ${w}px: ダッシュボードのページが横にスクロールしない`)
      await shot(`dashboard-${w}`, true)
      // 開くと端末に覚え、読み込み直しても開いたまま
      await ev(`document.querySelector('#dash-monthly > summary').click(); true`)
      await wait(300)
      ok(`画面 ${w}px: 押すと開き、要フォロースタッフ・今月の案件別実績が見える`, await ev(`(() => { const d = document.getElementById('dash-monthly'); return d.open && d.querySelector('table').checkVisibility() && localStorage.getItem('admin-dash-monthly-open') === '1' })()`))
      // 更新ボタン（描き直し）でも開いたまま
      await ev(`document.getElementById('dash-refresh').click(); true`)
      await until(`document.getElementById('dash-body') && document.getElementById('dash-body').getAttribute('aria-busy') === 'false'`, 20000)
      await wait(300)
      ok(`画面 ${w}px: 更新しても開いたまま`, await ev(`document.getElementById('dash-monthly').open === true`))
      await send('Page.reload'); await wait(800); await until(`!!document.getElementById('dash-monthly') && !!document.querySelector('#dash-shift-rows tr')`, 40000)
      ok(`画面 ${w}px: 読み込み直しても開いたまま（端末に覚える）`, await ev(`document.getElementById('dash-monthly').open === true`))
      const sticky = await ev(`(() => { const td = document.querySelector('#dash-monthly td.tbl-sticky-col'); if (!td) return null; const cs = getComputedStyle(td); return { pos: cs.position, w: Math.round(td.getBoundingClientRect().width), bg: cs.backgroundColor } })()`)
      ok(`画面 ${w}px: 今月の案件別実績の案件名の列は左に固定し、幅を保つ（1文字ずつ縦に並ばない）`, sticky && sticky.pos === 'sticky' && sticky.w >= 140 && sticky.bg !== 'rgba(0, 0, 0, 0)', sticky)
      await pageNoScroll(`画面 ${w}px: 開いてもページが横にスクロールしない`)
      if (w === 390) await shot(`dashboard-open-${w}`, true)
      await ev(`document.querySelector('#dash-monthly > summary').click(); true`)
      ok(`画面 ${w}px: ダッシュボードでスクリプトのエラーがない`, errors.length === 0, errors)
    }

    // ----- 詳細画面（案件・スタッフ・クライアント・従業員） -----
    const details = [['project-detail', `projects/${PID}`, '#project-texts'], ['staff-detail', `staff/${SID}`, '#staff-basic-info, #roster-panels'], ['client-detail', `clients/${CID}`, '#client-basic-info'], ['employee-detail', `employees/${SID}`, '#employee-staff-profile']]
    for (const w of [390, 1280]) {
      await setWidth(w)
      await as(adminCk)
      for (const [name, hash, mark] of details) {
        errors = []
        await send('Page.navigate', { url: `${BASE}/admin#${hash}` })
        const drawn = await until(`!!document.querySelector('#app .detail-head h2') && !!document.querySelector(${JSON.stringify(mark)})`, 40000)
        ok(`画面 ${w}px: ${name} が描ける`, drawn)
        if (!drawn) continue
        await wait(800)
        const h = await ev(`(() => { const head = document.querySelector('#app .detail-head'), h2 = head.querySelector('h2'), back = head.querySelector('a.btn'), act = head.querySelector('.detail-head-actions')
          const r = h2.getBoundingClientRect(), lh = parseFloat(getComputedStyle(h2).lineHeight) || 28
          return { w: Math.round(r.width), lines: Math.round(r.height / lh), backW: Math.round(back.getBoundingClientRect().width), actTop: act ? Math.round(act.getBoundingClientRect().top) : null, h2Bottom: Math.round(r.bottom), h2Top: Math.round(r.top), headW: Math.round(head.getBoundingClientRect().width) } })()`)
        // 名前の欄が狭いと1文字ずつ縦に並ぶ（前は 390px で幅 20px ほど）。長い名前は数行に折り返してよい
        ok(`画面 ${w}px: ${name} の見出しの名前は幅を保ち（1文字ずつ縦に並ばない）、戻るボタンは縮まない`, h && h.w >= Math.min(200, h.headW - 80) && h.backW >= 36, h)
        if (h && h.actTop != null) {
          if (w === 390) ok(`画面 ${w}px: ${name} の操作のボタンは名前の下の段に出る（2段）`, h.actTop >= h.h2Bottom, h)
          else ok(`画面 ${w}px: ${name} の操作のボタンは名前と同じ行に出る（1行）`, h.actTop < h.h2Bottom, h)
        }
        await pageNoScroll(`画面 ${w}px: ${name} のページが横にスクロールしない（表は表の中だけで横に動く）`)
        if (w === 390) await shot(`${name}-${w}`, false)
        else if (name === 'project-detail') await shot(`${name}-${w}`, false)
        ok(`画面 ${w}px: ${name} でスクリプトのエラーがない`, errors.length === 0, errors)
      }
    }

    // ----- 本部の企業一覧 -----
    for (const w of [390, 1280]) {
      errors = []
      await setWidth(w)
      await as(hqCk)
      await send('Page.navigate', { url: `${BASE}/hq#companies` })
      const drawn = await until(`!!document.querySelector('#hq-co-body tr td')`, 40000)
      ok(`画面 ${w}px: 本部の企業一覧が描ける`, drawn)
      if (!drawn) continue
      await wait(500)
      const col = await ev(`(() => { const td = document.querySelector('#hq-co-body tr td'), th = document.querySelector('#hq-co-head th'); const cs = getComputedStyle(td); const r = td.getBoundingClientRect(), lh = parseFloat(cs.lineHeight) || 20
        return { pos: cs.position, thPos: getComputedStyle(th).position, w: Math.round(r.width), bg: cs.backgroundColor } })()`)
      ok(`画面 ${w}px: 企業名の列は左に固定し、最小の幅を保つ（企業名が1文字ずつ縦に並ばない）`, col && col.pos === 'sticky' && col.thPos === 'sticky' && col.w >= 150 && col.bg !== 'rgba(0, 0, 0, 0)', col)
      ok(`画面 ${w}px: 表のほかの列は折り返さない（行の高さがそろう）`, await ev(`[...document.querySelectorAll('#hq-co-body tr')].every(tr => tr.getBoundingClientRect().height < 110)`))
      const bad = await ev(`(() => { const f = ${CONTRAST_FN}; return [...document.querySelectorAll('#app button.btn, #app a.btn')].map(b => ({ t: b.textContent.trim().slice(0, 20), c: f(b) })).filter(x => x.c < 4.5) })()`)
      ok(`画面 ${w}px: 企業一覧のボタンの文字はすべて読める（地とのコントラスト 4.5:1 以上）`, Array.isArray(bad) && bad.length === 0, bad)
      const dark = await ev(`(() => { const b = document.querySelector('[data-action="hqAuditLogs"]'); const cs = getComputedStyle(b); return { cls: b.className, bg: cs.backgroundColor, color: cs.color } })()`)
      ok(`画面 ${w}px: 本部の操作の履歴などのボタンは濃い枠（白い地ではない）`, dark && /btn-dark-outline/.test(dark.cls) && dark.bg !== 'rgb(255, 255, 255)', dark)
      // 上のタブ（index.tsx）は、狭い画面では名前の下の段に並べ、タブの帯の中だけを横に動かす（前は 390px でタブが1文字ずつ縦に並び、ページが 556px に広がった）
      const nav = await ev(`(() => { const as = [...document.querySelectorAll("header .hq-nav")]; const n = document.querySelector("header nav"); return { maxH: Math.max(...as.map(a => Math.round(a.getBoundingClientRect().height))), navRight: Math.round(n.getBoundingClientRect().right), ox: getComputedStyle(n).overflowX, cw: document.documentElement.clientWidth } })()`)
      ok(`画面 ${w}px: 本部の上のタブは1行で（名前を折り返さない）、タブの帯は画面の幅に収まる`, nav && nav.maxH <= 40 && nav.navRight <= nav.cw + 1 && nav.ox === "auto", nav)
      await pageNoScroll(`画面 ${w}px: 本部の企業一覧のページが横にスクロールしない`)
      const app = await ev(`(() => { const a = document.getElementById('app'); const out = [...a.querySelectorAll('*')].filter(e => { let p = e.parentElement; while (p && p !== a) { if (getComputedStyle(p).overflowX !== 'visible') return false; p = p.parentElement } return e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 }).map(e => e.tagName + '.' + String(e.className).slice(0, 60)); return { sw: a.scrollWidth, cw: a.clientWidth, out: out.slice(0, 5) } })()`)
      ok(`画面 ${w}px: 本部の企業一覧の本文が画面の幅に収まる（表は表の中だけで横に動く）`, app && app.sw <= app.cw + 1 && app.out.length === 0, app)
      await shot(`companies-${w}`, w === 1280)
      ok(`画面 ${w}px: 本部の画面でスクリプトのエラーがない`, errors.length === 0, errors)
    }
    // 企業の詳細（戻るボタン・管理者を追加）
    errors = []
    const cid = co.data.companies[0].company_id
    await send('Page.navigate', { url: `${BASE}/hq#companies/${Number(cid)}` })
    if (await until(`!!document.querySelector('[data-action="hqAddAdmin"]')`, 30000)) {
      const bad = await ev(`(() => { const f = ${CONTRAST_FN}; return [...document.querySelectorAll('#app .btn-dark-outline')].map(b => ({ t: b.textContent.trim().slice(0, 20), c: f(b) })).filter(x => x.c < 4.5) })()`)
      ok('画面 1280px: 本部の企業の詳細の濃い枠のボタンも読める（4.5:1 以上）', Array.isArray(bad) && bad.length === 0, bad)
    } else ok('画面 1280px: 本部の企業の詳細が開ける', false)
    ok('画面 1280px: 本部の企業の詳細でスクリプトのエラーがない', errors.length === 0, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
