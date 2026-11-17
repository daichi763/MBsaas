// w29-notice-wrap（Sprint 29 #9983。bigforest の報告: お知らせの URL が折り返される所と折り返されない所がある）の統合テスト
//  長い URL・長い英数字（空白のない文字列）が、どの画面でも枠からはみ出さずに折り返されることを確かめる。
//  共通のクラス .text-wrap-any（src/input.css。overflow-wrap:anywhere・word-break:break-word・min-width:0）を、お知らせのタイトル・本文などに付けた。
//  - 管理画面のお知らせ配信: 一覧のカード・編集（入力中）・既読状況と回答・修正の履歴のモーダル
//  - スタッフアプリ: ホームのお知らせ（固定のお知らせ）・一覧・詳細
//  - お知らせのメール（HTML の本文に折り返しの指定。メールソフトが表の中に入れても横に広がらない）
//  幅 390px と 1280px で開き、要素の scrollWidth が clientWidth を超えない（横にはみ出さない）ことと、ページ全体が横にスクロールしないことを見る。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9020 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9020 node --import ./scripts/fetch-origin.mjs scripts/test-w29-notice-wrap.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9020'
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

// 長い文字列（空白なし）。URL は 200 文字、英数字は 200 文字
const TAG = `w29wrap${Date.now() % 100000}`
const longUrl = (n) => { const head = `https://example.com/${TAG}/path?q=`; return head + 'a1B2c3D4e5'.repeat(30).slice(0, n - head.length) }
const longAlnum = (n) => (TAG + 'X9y8Z7w6V5'.repeat(30)).slice(0, n)
const URL200 = longUrl(200), ALNUM200 = longAlnum(200)

// ---------- コード ----------
const css = read('src/input.css'), built = read('public/static/style.css')
ok('#9983 input.css に共通のクラス .text-wrap-any（overflow-wrap:anywhere・word-break:break-word・min-width:0）', /\.text-wrap-any \{ overflow-wrap: anywhere; word-break: break-word; min-width: 0; \}/.test(css))
ok('#9983 ビルドした style.css にも .text-wrap-any が出ている', /\.text-wrap-any\{overflow-wrap:anywhere;word-break:break-word;min-width:0\}/.test(built))
const adminJs = read('public/static/admin.js'), staffJs = read('public/static/staff.js'), linkJs = read('public/static/report-link.js')
ok('#9983 管理画面のお知らせのカード: タイトル・本文・配信先・添付に付ける', /<h3 class="font-bold text-neutral-800 text-wrap-any /.test(adminJs) && /whitespace-pre-wrap text-wrap-any">\$\{esc\(n\.body\)\}<\/p>/.test(adminJs)
  && /badge badge-gray text-wrap-any">\$\{target\}/.test(adminJs) && /inline-flex items-center gap-1 text-wrap-any" target="_blank"/.test(adminJs))
ok('#9983 管理画面: 一覧と入力の2列（grid）の子に min-w-0', /lg:col-span-2 h-fit min-w-0/.test(adminJs) && /lg:col-span-3 space-y-3 min-w-0/.test(adminJs))
ok('#9983 スタッフアプリのお知らせ: タイトル・本文（リンクにした URL を含む）・案件名・回答に付ける', /<h3 class="font-bold text-neutral-800 text-wrap-any">/.test(staffJs)
  && /whitespace-pre-wrap text-wrap-any \$\{collapsed && long \? 'line-clamp-3' : ''\}" id="notice-body-/.test(staffJs) && /badge badge-gray text-wrap-any">案件:/.test(staffJs))
ok('#9983 報告用URL のお知らせ: タイトル（summary）と本文に付ける', /cursor-pointer text-wrap-any">/.test(linkJs) && /whitespace-pre-wrap text-wrap-any mt-2">\$\{esc\(n\.body/.test(linkJs))
ok('#9983 メールの「確認しました」のページ（/notice-ack）のタイトルに付ける', /p2\.className = 'font-bold text-neutral-800 mt-1 text-wrap-any'/.test(read('src/index.tsx')))
// 利用者の入力の表示（日報・相談・コメント・チャット・フォロー）。whitespace-pre-wrap の所は pre-wrap のまま text-wrap-any を足す
const views = ['admin.js', 'staff.js', 'board.js', 'roster-chat.js', 'roster.js', 'notifications.js', 'staff-attendance.js', 'report-link.js', 'recruit.js', 'corrections.js', 'staff-profile.js', 'apply.js', 'hq-support.js']
const missing = []
for (const f of views) for (const m of read(`public/static/${f}`).matchAll(/class="([^"]*\bwhitespace-pre-wrap\b[^"]*)"/g)) if (!/\btext-wrap-any\b/.test(m[1])) missing.push(`${f}: ${m[1]}`)
ok('#9983 利用者の入力を出す所（whitespace-pre-wrap）は、すべて text-wrap-any も付ける', missing.length === 0, missing)
ok('#9983 チャット・相談・日報のコメント・フォローの記録にも付ける', /<p class="whitespace-pre-wrap text-wrap-any">\$\{esc\(m\.body\)\}<\/p>/.test(read('public/static/roster-chat.js'))
  && /whitespace-pre-wrap text-wrap-any">\$\{esc\(co\.body\)\}/.test(staffJs) && /whitespace-pre-wrap text-wrap-any">\$\{esc\(cm\.body\)\}/.test(adminJs) && /whitespace-pre-wrap text-wrap-any">\$\{esc\(f\.content\)\}/.test(adminJs))

// ---------- メール ----------
const esbuild = (await import('esbuild')).default
const work = mkdtempSync(join(tmpdir(), 'w29wrap-mail-'))
await esbuild.build({ entryPoints: [join(ROOT, 'src/email-templates/notice.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(work, 'notice.mjs'), logLevel: 'error' })
const { noticeEmail } = await import(pathToFileURL(join(work, 'notice.mjs')).href)
rmSync(work, { recursive: true, force: true })
const mail = noticeEmail({ name: 'テスト 太郎', title: `${TAG} ${ALNUM200}`, body: `詳しくはこちら ${URL200}\n${ALNUM200}`, url: `${BASE}/staff#notices/1`, companyName: 'テスト会社', ackUrl: `${BASE}/notice-ack?token=${ALNUM200}` })
const WRAP_RE = /word-wrap:break-word;overflow-wrap:anywhere;word-break:break-word;/
const tagOf = (re) => (mail.html.match(re) || [''])[0]
ok('#9983 メール: 本文の枠（div）に折り返しの指定（word-wrap・overflow-wrap:anywhere・word-break）', WRAP_RE.test(tagOf(/<div style="border:1px solid #e5e7eb[^"]*">/)))
ok('#9983 メール: タイトルと本文の p にも折り返しの指定（本文は pre-wrap のまま）', WRAP_RE.test(tagOf(/<p style="font-weight:bold[^"]*">/)) && /white-space:pre-wrap;[^"]*overflow-wrap:anywhere/.test(tagOf(/<p style="white-space:pre-wrap[^"]*">/)))
ok('#9983 メール: 全体の枠にも折り返しの指定・本文はそのまま（エスケープだけ）', WRAP_RE.test(tagOf(/<div style="font-family:[^"]*">/)) && mail.html.includes(URL200) && mail.html.includes(ALNUM200) && mail.text.includes(URL200))

// ---------- API: 長い URL・英数字のお知らせを作る ----------
const adminCk = await login('sample', 'admin'), staffCk = await login('sample', 'st001')
const admin = client(adminCk), staff = client(staffCk)
const BODY1 = `${TAG} の連絡です。詳しくは次のページを見てください。\n${URL200}\n管理番号: ${ALNUM200}\n（以上）`
const OPT = longAlnum(30)
const n1 = await admin.post('/api/admin/notices', { title: `${TAG} ${URL200}`.slice(0, 200), body: BODY1, target_type: 'all', importance: 'normal', response_options: [OPT, 'はい'], response_comment: true })
const n2 = await admin.post('/api/admin/notices', { title: ALNUM200, body: `${ALNUM200}${ALNUM200}`, target_type: 'all', importance: 'urgent' })
const id1 = Number(n1.data && n1.data.notice_id), id2 = Number(n2.data && n2.data.notice_id)
ok('（前提）長い URL・英数字のお知らせを2件配信できる', n1.status === 200 && n2.status === 200 && id1 > 0 && id2 > 0, { n1: n1.status, n2: n2.status, d1: n1.data, d2: n2.data })
const resp = await staff.post(`/api/staff/notices/${id1}/response`, { choice: OPT, comment: `${URL200}` })
ok('（前提）スタッフが長い選択肢・長いコメントで回答できる', resp.status === 200, { status: resp.status, data: resp.data })
const edit = await admin.put(`/api/admin/notices/${id1}`, { title: `${TAG} ${URL200}`.slice(0, 200), body: `${BODY1}\n追記: ${ALNUM200}`, target_type: 'all', target_ids: '', importance: 'normal', response_options: [OPT, 'はい'], response_comment: true, notify: false })
ok('（前提）配信済みのお知らせを修正できる（修正の履歴が1件できる）', edit.status === 200, { status: edit.status, data: edit.data })
const list = await admin.get('/api/admin/notices')
const got = ((list.data && list.data.notices) || []).find(n => n.notice_id === id1)
ok('#9983 お知らせの中身は変えない（本文の URL・英数字はそのまま保存・返す）', !!got && got.body === `${BODY1}\n追記: ${ALNUM200}` && got.title === `${TAG} ${URL200}`.slice(0, 200), got && got.body)
const sd = await staff.get(`/api/staff/notices/${id1}`)
ok('#9983 スタッフの API もそのまま返す', sd.status === 200 && sd.data.notice.body === got.body, sd.status)

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))

// 要素の中で横にはみ出しているものを探す（ページの中で評価する）。
//  el 自体の scrollWidth > clientWidth、el の右端を越える子、横にスクロールする（overflow が visible でない）子を拾う。
//  … で切る（truncate）所と、入力欄（input・select）の中の文字は対象にしない
const OVERFLOW_FN = `(function (el) {
  const out = []
  const r = el.getBoundingClientRect()
  if (el.scrollWidth > el.clientWidth + 1) out.push({ who: 'self', sw: el.scrollWidth, cw: el.clientWidth })
  for (const d of el.querySelectorAll('*')) {
    if (/^(INPUT|SELECT|OPTION|SCRIPT|STYLE)$/.test(d.tagName)) continue
    let a = d.parentElement, clipped = false
    while (a && a !== el) { if (getComputedStyle(a).overflowX !== 'visible') { clipped = true; break } a = a.parentElement }
    const cs = getComputedStyle(d)
    if (!clipped) { const dr = d.getBoundingClientRect(); if (dr.width && dr.right > r.right + 1) out.push({ who: d.tagName + '.' + String(d.className).slice(0, 80), over: Math.round(dr.right - r.right) }) }
    if (cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && d.scrollWidth > d.clientWidth + 1) out.push({ who: 'scroll ' + d.tagName + '.' + String(d.className).slice(0, 80), sw: d.scrollWidth, cw: d.clientWidth })
  }
  return out.slice(0, 5)
})`
const PAGE_FN = `(function () { const s = document.scrollingElement; return { sw: s.scrollWidth, cw: document.documentElement.clientWidth } })()`

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w29wrap-'))
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
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w29-notice-wrap-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    const setWidth = (w) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 })
    // sel の要素（複数なら全部）が横にはみ出していないこと。multi: 長い文字列が実際に複数行に折り返されていること（見えなくなっていない）
    const noOverflow = async (label, sel, multiSel) => {
      const res = await ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; if (!els.length) return { none: true }
        const f = ${OVERFLOW_FN}; const bad = els.map(f).filter(x => x.length)
        const multi = ${JSON.stringify(multiSel || '')} ? [...document.querySelectorAll(${JSON.stringify(multiSel || '')})].map(e => { const lh = parseFloat(getComputedStyle(e).lineHeight) || 20; return Math.round(e.getBoundingClientRect().height / lh) }) : []
        return { n: els.length, bad, multi } })()`)
      const lines = (res && res.multi) || []
      ok(label, res && !res.none && res.bad.length === 0 && (!multiSel || (lines.length && lines.every(l => l >= 2))), res)
    }
    const pageNoScroll = async (label) => { const p = await ev(PAGE_FN); ok(label, p && p.sw <= p.cw + 1, p) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    // ----- メール（メールソフトのように、幅 100% の表の中に入れて 390px で描く） -----
    await setWidth(390)
    await send('Page.navigate', { url: 'about:blank' })
    await wait(300)
    await ev(`document.open(); document.write(${JSON.stringify(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><table width="100%" cellpadding="0" cellspacing="0" id="mail"><tr><td>${mail.html}</td></tr></table></body></html>`)}); document.close(); true`)
    await wait(300)
    const mw = await ev(`({ table: document.getElementById('mail').getBoundingClientRect().width, page: document.scrollingElement.scrollWidth, cw: document.documentElement.clientWidth })`)
    ok('画面: メールの本文を幅 390px の表の中で描いても、表とページが横に広がらない', mw && mw.table <= mw.cw + 1 && mw.page <= mw.cw + 1, mw)
    await shot('mail-390')

    // ----- 管理画面 -----
    await client(adminCk).put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup'].map(key => ({ key, status: 'skipped', step: 0 })) })
    await client(staffCk).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] })
    const card = (nid) => `#notice-admin-list .card:has([data-id="${nid}"])`
    for (const w of [390, 1280]) {
      errors = []
      await setWidth(w)
      await as(adminCk)
      await send('Page.navigate', { url: `${BASE}/admin#notices` })
      const drawn = await until(`!!document.querySelector('${card(id1)}') && !!document.querySelector('${card(id2)}')`, 40000)
      ok(`画面 ${w}px: 管理画面のお知らせ配信に、作ったお知らせが出る`, drawn)
      if (!drawn) continue
      await wait(500)
      await noOverflow(`画面 ${w}px: 管理画面のお知らせの一覧のカードが横にはみ出さない（タイトル・本文・配信先・回答）`, `${card(id1)}, ${card(id2)}`, `${card(id1)} h3, ${card(id2)} h3`)
      await noOverflow(`画面 ${w}px: 管理画面の新規配信の欄と一覧の列が画面の幅に収まる`, '#app')
      await pageNoScroll(`画面 ${w}px: 管理画面のお知らせ配信のページが横にスクロールしない`)
      await shot(`admin-list-${w}`)
      // 編集（入力中の表示）
      await ev(`document.querySelector('[data-action="noticeEdit"][data-id="${id1}"]').click()`)
      if (await until(`!!document.querySelector('#modal-root .modal-box #ne-title')`, 5000)) {
        await noOverflow(`画面 ${w}px: 管理画面のお知らせの修正（入力中）のモーダルが横にはみ出さない`, '#modal-root .modal-box')
        await shot(`admin-edit-${w}`)
      } else ok(`画面 ${w}px: 修正のモーダルが開く`, false)
      await ev(`closeModal()`)
      // 既読状況・回答
      await ev(`document.querySelector('${card(id1)} [data-action="showReads"]').click()`)
      if (await until(`!!document.querySelector('#modal-root .modal-box') && /既読状況/.test(document.querySelector('#modal-root .modal-box').textContent)`, 8000)) {
        await noOverflow(`画面 ${w}px: 管理画面の既読状況・回答（長い選択肢・長いコメント）のモーダルが横にはみ出さない`, '#modal-root .modal-box')
        await shot(`admin-reads-${w}`)
      } else ok(`画面 ${w}px: 既読状況のモーダルが開く`, false)
      await ev(`closeModal()`)
      // 修正の履歴
      await ev(`document.querySelector('${card(id1)} [data-action="noticeRevisions"]').click()`)
      if (await until(`!!document.querySelector('#modal-root .modal-box') && /修正・取消の履歴/.test(document.querySelector('#modal-root .modal-box').textContent)`, 8000)) {
        await noOverflow(`画面 ${w}px: 管理画面の修正の履歴のモーダルが横にはみ出さない`, '#modal-root .modal-box', '#modal-root .modal-box p.font-bold')
      } else ok(`画面 ${w}px: 修正の履歴のモーダルが開く`, false)
      await ev(`closeModal()`)
      ok(`画面 ${w}px: 管理画面でスクリプトのエラーがない`, errors.length === 0, errors)
    }

    // ----- スタッフアプリ -----
    for (const w of [390, 1280]) {
      errors = []
      await setWidth(w)
      await as(staffCk)
      await send('Page.navigate', { url: `${BASE}/staff#home` })
      const home = await until(`!!document.querySelector('#notice-preview a[href="#notices/${id2}"]')`, 40000)
      ok(`画面 ${w}px: スタッフのホームに作ったお知らせが出る`, home)
      if (home) {
        await noOverflow(`画面 ${w}px: スタッフのホームのお知らせ（固定のお知らせ）が横にはみ出さない`, '#notice-preview')
        await pageNoScroll(`画面 ${w}px: スタッフのホームが横にスクロールしない`)
        await shot(`staff-home-${w}`)
      }
      await ev(`location.hash = 'notices'`)
      const listed = await until(`!!document.getElementById('notice-${id1}') && !!document.getElementById('notice-${id2}')`, 20000)
      ok(`画面 ${w}px: スタッフのお知らせの一覧に出る`, listed)
      if (listed) {
        await noOverflow(`画面 ${w}px: スタッフのお知らせの一覧のカードが横にはみ出さない（タイトル・本文のリンク・回答の選択肢）`, `#notice-${id1}, #notice-${id2}`, `#notice-${id1} h3, #notice-${id2} h3`)
        await pageNoScroll(`画面 ${w}px: スタッフのお知らせの一覧が横にスクロールしない`)
        await shot(`staff-list-${w}`)
      }
      await ev(`location.hash = 'notices/${id1}'`)
      const det = await until(`!!document.getElementById('notice-${id1}') && /notices\\/${id1}$/.test(location.hash) && !document.getElementById('notice-${id2}')`, 20000)
      ok(`画面 ${w}px: スタッフのお知らせの詳細が開く`, det)
      if (det) {
        const link = await ev(`(() => { const a = document.querySelector('#notice-body-${id1} a[href^="https://example.com/"]'); return a ? { lines: Math.round(a.getBoundingClientRect().height / (parseFloat(getComputedStyle(a).lineHeight) || 20)), wrap: getComputedStyle(a).overflowWrap } : null })()`)
        ok(`画面 ${w}px: 本文の URL はリンクになり、リンクも折り返す`, link && link.lines >= 2 && link.wrap === 'anywhere', link)
        await noOverflow(`画面 ${w}px: スタッフのお知らせの詳細が横にはみ出さない`, `#notice-${id1}`, `#notice-${id1} h3, #notice-body-${id1}`)
        await pageNoScroll(`画面 ${w}px: スタッフのお知らせの詳細が横にスクロールしない`)
        await shot(`staff-detail-${w}`)
      }
      ok(`画面 ${w}px: スタッフアプリでスクリプトのエラーがない`, errors.length === 0, errors)
    }
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
