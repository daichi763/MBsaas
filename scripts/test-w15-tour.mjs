// 案内（チュートリアル。Sprint 15・w15-tour）の統合テスト
//   #9711 管理画面: 初回の「主な機能を案内します」・各画面の初回の案内・右上の「？」・ダッシュボードの「はじめにやること」・進み具合をサーバーに残す
//   #9712 スタッフアプリ: 初回の短い案内（ホーム画面に追加 → 打刻 → 日報 → 通知）・「使い方をもう一度見る」・スマホの幅ではみ出さない
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   `npx wrangler dev --local --port 8810 --test-scheduled --var RETENTION_ENABLED:true --persist-to <保存先>` で起動していること
//   （退職後の削除の確認で、ローカルの D1 に直接書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w15-tour.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
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
    const headers = { Cookie: cookie || '' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
function d1(sql) {
  const out = execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
async function waitServer() {
  for (let i = 0; i < 30; i++) { try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { } await new Promise(r => setTimeout(r, 1000)) }
  throw new Error('server did not respond')
}

const PFX = 'W15T' + Date.now().toString(36).slice(-4).toUpperCase()
const NEWPW = 'Tour-pass-2026'
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const hq = client(await login('', 'hq'))
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: phoneOf() }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}

// ---------- 進み具合の API ----------
{
  const g = await admin.get('/api/admin/tours')
  ok('#9711 GET /api/admin/tours は自分の進み具合を返す（はじめは空）', g.status === 200 && g.data.progress && typeof g.data.progress === 'object' && !g.data.readonly, g.data)
  const bad = [
    [{ items: [{ key: 'admin-unknown', status: 'done' }] }, '知らない案内'],
    [{ items: [{ key: 'staff-welcome', status: 'done' }] }, 'スタッフの案内（管理画面の API）'],
    [{ items: [{ key: 'admin-welcome', status: 'finished' }] }, '知らない状態'],
    [{ items: [{ key: 'admin-welcome', status: 'in_progress', step: 100 }] }, 'ステップが大きすぎる'],
    [{ items: [{ key: 'admin-welcome', status: 'in_progress', step: 1.5 }] }, 'ステップが整数でない'],
    [{ items: [] }, '空'],
    [{ items: Array.from({ length: 21 }, () => ({ key: 'admin-welcome', status: 'done' })) }, '21件'],
  ]
  for (const [body, what] of bad) { const r = await admin.put('/api/admin/tours', body); ok(`#9711 PUT の誤り（${what}）は 400`, r.status === 400 && r.data.error, r) }
  const p = await admin.put('/api/admin/tours', { items: [{ key: 'admin-welcome', status: 'in_progress', step: 3 }, { key: 'admin-screen-clients', status: 'done' }] })
  ok('#9711 PUT で途中のステップ・見終わったを残せる', p.status === 200, p)
  const g2 = must(await admin.get('/api/admin/tours'), 'tours').progress
  ok('#9711 GET で残した進み具合が返る（別の端末でも同じ）', g2['admin-welcome']?.status === 'in_progress' && g2['admin-welcome'].step === 3 && g2['admin-screen-clients']?.status === 'done', g2)
  must(await admin.put('/api/admin/tours', { items: [{ key: 'admin-welcome', status: 'skipped', step: 3 }] }), 'tours put2')
  const g3 = must(await admin.get('/api/admin/tours'), 'tours').progress
  ok('#9711 同じ案内を残し直すと上書きする', g3['admin-welcome'].status === 'skipped', g3)
  const other = must(await mgr.get('/api/admin/tours'), 'mgr tours').progress
  ok('#9711 進み具合は人ごと（ほかの管理者には出ない）', !other['admin-welcome'], other)
}

// ---------- スタッフの API・権限 ----------
const SA = await newStaff('A')
const sa = client(await login('sample', `${PFX}A`))
{
  const g = await sa.get('/api/staff/tours')
  ok('#9712 GET /api/staff/tours（はじめは空）', g.status === 200 && Object.keys(g.data.progress).length === 0, g.data)
  const bad = await sa.put('/api/staff/tours', { items: [{ key: 'admin-welcome', status: 'done' }] })
  ok('#9712 スタッフは管理画面の案内を残せない', bad.status === 400, bad)
  const p = await sa.put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'in_progress', step: 2 }] })
  ok('#9712 スタッフの案内の途中を残せる', p.status === 200 && must(await sa.get('/api/staff/tours'), 'g').progress['staff-welcome']?.step === 2, p)
  ok('#9712 スタッフは /api/admin/tours を使えない', (await sa.get('/api/admin/tours')).status === 403)
  ok('#9711 管理者は /api/staff/tours を使えない', (await admin.get('/api/staff/tours')).status === 403)
  ok('#9711 スタッフは「はじめにやること」を読めない', (await sa.get('/api/admin/tours/checklist')).status === 403)
}

// ---------- はじめにやること ----------
{
  const s = must(await admin.get('/api/admin/tours/checklist'), 'sample checklist')
  ok('#9711 初期設定が済んだ会社（sample）の会社管理者には出さない（済んだことを残す）', s.show === false && s.items && s.items.clients && s.items.projects && s.items.staff && s.items.shifts && s.items.logins, s)
  const done = must(await admin.get('/api/admin/tours'), 'g').progress['admin-checklist']
  ok('#9711 すべて済んだら admin-checklist を done で残す（後でデータが減っても出し直さない）', done && done.status === 'done', done)
  const m = must(await mgr.get('/api/admin/tours/checklist'), 'mgr checklist')
  ok('#9711 会社管理者でない管理者（現場管理者）には出さない', m.show === false && m.items === null, m)
}
// 新しい会社: 初期設定が済むまで出す。2人目の管理者には出さない
const CODE = ('w15t' + Date.now().toString(36).slice(-5)).toLowerCase()
const created = must(await hq.post('/api/hq/companies', { company_code: CODE, company_name: `${PFX} 案内テスト`, admin_code: 'boss', admin_password: 'pass1234', admin_email: `boss-${CODE}@example.com`, admin_name: '最初 管理者', user_limit: '' }), 'create company')
const boss = client(await login(CODE, 'boss'))
const R = {}
{
  const me = must(await boss.get('/api/auth/me'), 'me')
  created.company_id = me.company_id
  ok('（前提）新しい会社の最初の管理者は仮パスワードのまま', me.must_change_password === true && me.role === 'company_admin', me)
  must(await boss.post('/api/auth/change-password', { current_password: 'pass1234', new_password: NEWPW }), 'change pw')
  const c0 = must(await boss.get('/api/admin/tours/checklist'), 'boss checklist')
  ok('#9711 新しい会社の会社管理者には「はじめにやること」を出す（5項目とも未完了）', c0.show === true && Object.values(c0.items).length === 5 && Object.values(c0.items).every(v => v === false), c0)
  const cl = must(await boss.post('/api/admin/clients', { client_name: `${PFX} 顧客` }), 'client')
  R.client = cl.client_id
  const c1 = must(await boss.get('/api/admin/tours/checklist'), 'boss checklist 2')
  ok('#9711 クライアントを登録すると「クライアントを登録する」が実データで済みになる', c1.show === true && c1.items.clients === true && c1.items.projects === false, c1.items)
  // 2人目の会社管理者（最初の管理者が閉じる前）
  must(await boss.post('/api/admin/users', { user_code: 'boss2', name: '二人目 管理者', role: 'company_admin', password: 'pass1234', email: `boss2-${CODE}@example.com` }), 'add admin')
  const boss2 = client(await login(CODE, 'boss2'))
  R.boss2 = boss2
}

if (PERSIST) {
  // 退職後の削除（7年）で、その人の案内の進み具合も消す
  must(await sa.put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'done' }] }), 'staff done')
  const uid = d1(`SELECT user_id FROM staff_profiles WHERE staff_id = ${Number(SA.staff_id)}`)[0][0].user_id
  ok('（前提）退職させるスタッフの進み具合がある', d1(`SELECT COUNT(*) AS n FROM user_tour_progress WHERE user_id = ${uid}`)[0][0].n === 1)
  d1(`UPDATE users SET retired_at = '2018-01-01', status = 'suspended' WHERE user_id = ${uid};
    UPDATE staff_profiles SET employment_status = 'retired', retention_flagged_at = '${addDays(today, -8)}' WHERE staff_id = ${Number(SA.staff_id)}`)
  await waitServer()
  const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('0 18 * * *').replace(/%20/g, '+')}`)
  await waitServer()
  const left = d1(`SELECT COUNT(*) AS n FROM user_tour_progress WHERE user_id = ${uid}`)[0][0].n
  const anon = d1(`SELECT anonymized_at FROM staff_profiles WHERE staff_id = ${Number(SA.staff_id)}`)[0][0].anonymized_at
  ok('#9712 退職後の削除で、その人の案内の進み具合（user_tour_progress）も消す', r.status < 500 && anon && left === 0, { status: r.status, anon, left })
} else console.log('SKIP  退職後の削除の確認（PERSIST が無いため）')
{
  // 解約企業の削除の対象（未対応の表に出ない・件数を数える）
  const ob = must(await hq.get(`/api/hq/offboarding/${created.company_id}`), 'offboarding')
  const t = (ob.tables || []).find(x => x.target === 'user_tour_progress')
  ok('#9711 解約企業の削除の対象に user_tour_progress がある（未対応の表に出ない・書き出さない）', t && t.export === false && t.count >= 0 && !(ob.unknown_tables || []).includes('user_tour_progress'), { t, unknown: ob.unknown_tables })
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w15t-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w15-tour-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const setCookie = async (ck) => {
      await send('Network.clearBrowserCookies')
      const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    }
    // 画面の起動（ME の読み込み・最初の画面の描画）が済むまで待つ
    const ready = async () => { await wait(800); await until(`typeof FosTour !== 'undefined' && typeof ME !== 'undefined' && !!ME && !document.querySelector('#app > div > .spin') && (location.pathname !== '/admin' || !!document.getElementById('tour-help-bar'))`, 40000); await wait(700) }
    const title = () => ev(`(document.querySelector('#tour-root .tour-title') || {}).textContent || ''`)
    const press = (key) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`)
    const clickAct = (act) => ev(`(() => { const b = document.querySelector('#tour-root [data-tour-act="${act}"]'); if (b) b.click(); return !!b })()`)
    // 吹き出しが画面に収まり、下のナビゲーションと重ならないか
    const fits = () => ev(`(() => {
      const b = document.querySelector('#tour-root .tour-bubble'); if (!b) return { ok: false, why: 'no bubble' }
      const r = b.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight
      const nav = document.getElementById('bottom-nav'), nt = nav ? nav.getBoundingClientRect().top : vh
      return { ok: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= Math.min(vh, nt) + 0.5 && document.documentElement.scrollWidth <= vw, l: r.left, r: r.right, t: r.top, b: r.bottom, vw, vh, nt }
    })()`)
    // 穴は動くときに少しアニメーションするので、止まってから比べる
    const holeOn = async (sel) => { await wait(450); return holeOn0(sel) }
    const holeOn0 = (sel) => ev(`(() => {
      const h = document.querySelector('#tour-root .tour-hole'), el = document.querySelector(${JSON.stringify(sel)})
      if (!h || h.hidden || !el) return false
      // 画面より大きな要素は、画面の中の部分を囲む
      const a = h.getBoundingClientRect(), r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight
      const b = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(vw, r.right), bottom: Math.min(vh, r.bottom) }
      return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1
    })()`)

    // ===== 管理画面: 新しい会社の最初の管理者（仮パスワードのまま） =====
    const ck = await login(CODE, 'boss', NEWPW)
    // 仮パスワードの状態をもう一度作る（パスワードの変更の後に案内が始まるかを画面で確かめる）
    if (PERSIST) { d1(`UPDATE users SET must_change_password = 1 WHERE company_id = ${Number(created.company_id)} AND user_code = 'boss'`); await waitServer() }
    await setCookie(ck)
    await send('Page.navigate', { url: `${BASE}/admin` }); await ready()
    if (PERSIST) {
      ok('#9711 画面: 仮パスワードのままの間は案内を出さない', !(await ev(`!!document.querySelector('#tour-root .tour-bubble')`)) && (await ev('location.hash')) === '#account')
      await ev(`axios.post('/api/auth/change-password', { current_password: ${JSON.stringify(NEWPW)}, new_password: ${JSON.stringify(NEWPW + 'x')} }).then(() => { ME.must_change_password = false })`)
    }
    await until(`!!document.querySelector('#tour-root .tour-bubble[role="dialog"]')`, 6000)
    ok('#9711 画面: 初回（パスワードの変更の後）に「Field OS へようこそ」［始める］［あとで］を出す', /ようこそ/.test(await title())
      && await ev(`[...document.querySelectorAll('#tour-root .tour-actions button')].map(b => b.textContent.trim()).join(',') === 'あとで,始める'`)
      && await ev(`document.querySelector('#tour-root .tour-bubble').getAttribute('aria-labelledby') === 'tour-title' && document.querySelector('#tour-root .tour-bubble').getAttribute('aria-modal') === 'true'`))
    await shot('admin-welcome')
    await clickAct('start')
    await until(`location.hash === '#clients' && /クライアント/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9711 画面: ［始める］でクライアントの画面に移り、「クライアント登録」を浮かせて説明する', (await ev('location.hash')) === '#clients' && await holeOn('[onclick^="showAddClient"]'), await title())
    ok('#9711 画面: 吹き出しに［スキップ］［前へ］［次へ］', await ev(`['skip', 'prev', 'next'].every(a => document.querySelector('#tour-root [data-tour-act="' + a + '"]'))`))
    await shot('admin-step-clients')
    await press('ArrowRight')
    await until(`location.hash === '#projects' && /案件/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9711 画面: → キーで次へ（案件の画面の「案件登録」）', (await ev('location.hash')) === '#projects' && await holeOn('[onclick^="showAddProject"]'), await title())
    await press('ArrowLeft')
    await until(`location.hash === '#clients' && /クライアント/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9711 画面: ← キーで前へ（クライアントに戻る）', /クライアント/.test(await title()))
    await clickAct('next')
    await until(`location.hash === '#projects' && /案件/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    await press('Escape'); await wait(1200)
    ok('#9711 画面: Esc で閉じる', !(await ev(`!!document.querySelector('#tour-root')`)))
    const pr = must(await client(ck).get('/api/admin/tours'), 'tours').progress['admin-welcome']
    ok('#9711 途中で閉じたら、そのステップをサーバーに残す', pr && pr.status === 'in_progress' && pr.step === 2, pr)
    await send('Page.reload'); await ready()
    await until(`/案内の続き/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 6000)
    ok('#9711 画面: 開き直すと「案内の続き」［続きから］を出す', /続き/.test(await title()) && await ev(`!!document.querySelector('#tour-root [data-tour-act="resume"]')`))
    await clickAct('resume')
    await until(`location.hash === '#projects' && /案件/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9711 画面: ［続きから］で閉じたステップ（案件）から再開する', /案件/.test(await title()))
    // シフト・日報・打刻修正・精算の順に進むか（見つからないステップは飛ばす）
    const seen = []
    for (let i = 0; i < 14; i++) {
      const t = await title(); if (t && seen[seen.length - 1] !== t) seen.push(t)
      if (await ev(`(document.querySelector('#tour-root [data-tour-act="next"]') || {}).textContent === '完了'`)) break
      const before = t
      await clickAct('next')
      await until(`(document.querySelector('#tour-root .tour-title') || {}).textContent !== ${JSON.stringify(before)} && !/開いています/.test(document.querySelector('#tour-root .tour-title').textContent)`, 9000)
    }
    const order = ['案件', 'スタッフ', 'シフト', '日報・勤怠', '精算', '使い方']
    const pos = order.map(w => seen.findIndex(t => t.includes(w)))
    ok('#9711 画面: クライアント → 案件 → スタッフ → シフト → 日報・勤怠の確認 → 精算 の順に案内する', pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), seen)
    ok('#9711 画面: 最後は右上の「？」を指して、いつでも見られることを伝える', /使い方/.test(seen[seen.length - 1]) && await holeOn('#tour-help-bar .tour-help-btn'), seen)
    await clickAct('next'); await wait(1500)
    const pr2 = must(await client(ck).get('/api/admin/tours'), 'tours').progress
    ok('#9711 見終わったら done を残し、案内の中で開いた画面の案内は自動で出さない（続きから開いた案件〜精算を done）', pr2['admin-welcome']?.status === 'done' && pr2['admin-screen-projects']?.status === 'done' && pr2['admin-screen-settlement']?.status === 'done', pr2)
    ok('#9711 画面: 見終わったらダッシュボードへ戻る', (await ev('location.hash')) === '#dashboard' && !(await ev(`!!document.querySelector('#tour-root')`)))
    // はじめにやること（クライアントは登録済み）
    await until(`!!document.getElementById('tour-checklist')`, 6000)
    const items = await ev(`[...document.querySelectorAll('#tour-checklist [data-check]')].map(li => li.dataset.check + ':' + (li.querySelector('.fa-circle-check') ? 1 : 0))`)
    ok('#9711 画面: ダッシュボードの上に「はじめにやること」（済んだ項目にチェック）', Array.isArray(items) && items.join(',') === 'clients:1,projects:0,staff:0,shifts:0,logins:0'
      && /はじめにやること/.test(await ev(`document.getElementById('tour-checklist').textContent`)), items)
    await shot('admin-checklist')
    // 右上の「？」
    ok('#9711 画面: PC の幅では右上に「？ 使い方」', await ev(`(() => { const b = document.querySelector('#tour-help-bar .tour-help-btn'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.top < 80 && r.left > innerWidth / 2 })()`))
    await ev(`document.querySelector('#tour-help-bar .tour-help-btn').click()`)
    await until(`!!document.getElementById('tour-menu')`, 3000)
    const menu = await ev(`[...document.querySelectorAll('#tour-menu [role=menuitem]')].map(b => b.textContent.trim())`)
    ok('#9711 画面: 「？」で「この画面の使い方」「最初の案内をもう一度見る」', Array.isArray(menu) && menu.some(t => t.startsWith('この画面の使い方（ダッシュボード）')) && menu.includes('最初の案内をもう一度見る'), menu)
    await ev(`document.querySelector('#tour-menu [data-tour-menu="screen"]').click()`)
    await until(`/今日の数字/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 5000)
    ok('#9711 画面: 「この画面の使い方」でその画面の短い案内（3〜5ステップ）', /今日の数字/.test(await title()) && /\/ [3-5]$/.test(await ev(`document.querySelector('#tour-root .tour-count').textContent`)) && await holeOn('#kpi-cards'))
    await clickAct('skip'); await wait(800)
    // 閉じる
    await ev(`document.querySelector('[data-action="tourChecklistClose"]').click()`); await wait(1000)
    const c2 = must(await client(ck).get('/api/admin/tours/checklist'), 'checklist after close')
    ok('#9711 画面: 「はじめにやること」を閉じると消え、次からも出さない', !(await ev(`!!document.getElementById('tour-checklist')`)) && c2.show === false, c2)
    const c3 = must(await R.boss2.get('/api/admin/tours/checklist'), 'boss2 checklist')
    ok('#9711 会社の2人目以降の管理者には「はじめにやること」を出さない', c3.show === false, c3)
    // 「？」から出し直す
    await ev(`document.querySelector('#tour-help-bar .tour-help-btn').click()`)
    await until(`!!document.querySelector('#tour-menu [data-tour-menu="checklist"]')`, 3000)
    await ev(`document.querySelector('#tour-menu [data-tour-menu="checklist"]').click()`)
    await until(`!!document.getElementById('tour-checklist')`, 5000)
    ok('#9711 画面: 「？」の「「はじめにやること」を表示する」で出し直せる', await ev(`!!document.getElementById('tour-checklist')`))
    // 初めて開いた画面の案内（自動・1回だけ）。最初の案内の中で開いた画面は、見たことにして出さない
    await ev(`location.hash = 'notices'`); await wait(800)
    await ev(`location.hash = 'corrections'`)
    const autoShown = await until(`!!document.querySelector('#tour-root .tour-bubble')`, 5000)
    const autoCorr = must(await client(ck).get('/api/admin/tours'), 'tours').progress['admin-screen-corrections']
    ok('#9711 画面: 案内の中で見た画面は、初めて開いても自動では出さない（打刻修正承認は案内で開いたので出ない）', !autoShown && autoCorr?.status === 'done', { autoShown, autoCorr })
    await ev(`location.hash = 'notices'`); await wait(500)
    // 案内で開いていない画面（日報一覧の進み具合を消して、初めての状態にする）
    if (PERSIST) {
      d1(`DELETE FROM user_tour_progress WHERE user_id = (SELECT user_id FROM users WHERE company_id = ${Number(created.company_id)} AND user_code = 'boss') AND tour_key = 'admin-screen-reports'`)
      await waitServer(); await send('Page.reload'); await ready()
      await ev(`location.hash = 'reports'`)
      const shown = await until(`/提出済み・未提出|未確認・インシデント|絞り込み/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 9000)
      ok('#9711 画面: 主な画面を初めて開いたときに、その画面の短い案内を自動で出す（日報一覧）', shown, await title())
      await press('Escape'); await wait(1000)
      const rp = must(await client(ck).get('/api/admin/tours'), 'tours').progress['admin-screen-reports']
      ok('#9711 自動の案内を途中で閉じたら in_progress を残す（次に開いたときに続きから）', rp && rp.status === 'in_progress', rp)
      await ev(`location.hash = 'notices'`); await wait(600)
      await ev(`location.hash = 'reports'`)
      const again = await until(`!!document.querySelector('#tour-root .tour-bubble')`, 8000)
      ok('#9711 画面: 途中で閉じた画面の案内は、次に開いたときに続きから出す', again)
      await clickAct('skip'); await wait(800)
      await ev(`location.hash = 'notices'`); await wait(600)
      await ev(`location.hash = 'reports'`); await wait(2500)
      ok('#9711 画面: スキップした画面の案内は、もう自動では出さない', !(await ev(`!!document.querySelector('#tour-root .tour-bubble')`)))
    }

    // スマホの幅の管理画面: ヘッダーに「？」
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 740, deviceScaleFactor: 2, mobile: true })
    await ev(`location.hash = 'dashboard'`); await wait(1500)
    ok('#9711 画面: スマホの幅では上のヘッダーに「？」', await ev(`(() => { const b = document.querySelector('header .tour-help-btn'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= document.documentElement.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth })()`))
    await ev(`document.querySelector('header .tour-help-btn').click()`)
    await until(`!!document.getElementById('tour-menu')`, 3000)
    await ev(`document.querySelector('#tour-menu [data-tour-menu="welcome"]').click()`)
    await until(`/主な機能/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 5000)
    await clickAct('next')
    await until(`location.hash === '#clients' && /クライアント/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    const fitA = await fits()
    ok('#9711 画面: スマホの幅でも吹き出しが画面からはみ出さない（最初の案内をもう一度見る）', fitA.ok, fitA)
    await shot('admin-mobile')
    await clickAct('close'); await wait(500)
    await send('Emulation.clearDeviceMetricsOverride')

    // 本部の閲覧（読み取り専用）では、自動の案内を出さず、進み具合も残さない（API）
    const hqTours = await hq.put('/api/admin/tours', { items: [{ key: 'admin-welcome', status: 'done' }] })
    ok('#9711 本部ユーザーは管理画面の案内の進み具合を残せない', hqTours.status === 403, hqTours)

    // ===== スタッフアプリ（iPhone の幅・Safari） =====
    const SB = await newStaff('B')
    const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, allow_duplicate: true }), 'project').project_id
    must(await admin.post('/api/admin/shifts', { staff_id: SB.staff_id, project_id: P, work_date: today, start_time: '00:00', end_time: '23:59', memo: PFX }), 'shift')
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true })
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' })
    await setCookie(await login('sample', `${PFX}B`))
    await send('Page.navigate', { url: `${BASE}/staff` }); await ready()
    ok('#9712 画面: 仮パスワードの変更の画面が出ている間は案内を出さない', !(await ev(`!!document.querySelector('#tour-root .tour-bubble')`)) && await ev(`!!document.getElementById('fpw-new')`))
    await ev(`(async () => { await axios.post('/api/auth/change-password', { current_password: 'pass1234', new_password: ${JSON.stringify(NEWPW)} }); closeModal() })()`)
    await until(`/ホーム画面に追加/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 6000)
    const body1 = await ev(`document.querySelector('#tour-root .tour-body').textContent`)
    ok('#9712 画面: 初回は「ホーム画面に追加」から（iPhone の Safari は共有ボタンの手順と、プッシュ通知に必要なこと・iOS 16.4 以降）', /共有ボタン/.test(body1) && /ホーム画面に追加/.test(body1) && /iOS 16\.4/.test(body1) && /プッシュ通知/.test(body1), body1)
    let f = await fits(); ok('#9712 画面: 375px の幅で吹き出しがはみ出さず、下のナビゲーションと重ならない（ホーム画面に追加）', f.ok, f)
    await shot('staff-home-screen')
    await clickAct('next')
    await until(`/打刻/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    const body2 = await ev(`document.querySelector('#tour-root .tour-body').textContent`)
    ok('#9712 画面: 打刻（その会社の設定で出る報告のボタンを浮かせ、名前を並べる）', await holeOn('#attendance-section') && /入店報告/.test(body2), body2)
    f = await fits(); ok('#9712 画面: 375px の幅で吹き出しがはみ出さない（打刻）', f.ok, f)
    await shot('staff-attendance')
    await clickAct('next')
    await until(`/日報/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 5000)
    ok('#9712 画面: 日報（下の「日報」を浮かせる）', await holeOn('#bottom-nav [data-tab="report"]'))
    f = await fits(); ok('#9712 画面: 下のナビゲーションを指すときも、吹き出しはナビゲーションの上に出る', f.ok, f)
    await shot('staff-report')
    await clickAct('next')
    await until(`/通知とお知らせ/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 5000)
    await clickAct('next')
    await until(`location.hash === '#notify-settings' && /通知を受け取る/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 8000)
    ok('#9712 画面: 通知のステップで「通知の設定」（プッシュの登録の画面）へ案内する', (await ev('location.hash')) === '#notify-settings' && /通知を受け取る/.test(await title()))
    f = await fits(); ok('#9712 画面: 375px の幅で吹き出しがはみ出さない（通知の設定）', f.ok, f)
    await shot('staff-notify')
    ok('#9712 画面: 最後のボタンは「完了」', (await ev(`document.querySelector('#tour-root [data-tour-act="next"]').textContent`)) === '完了')
    await clickAct('next'); await wait(1200)
    const sbc = client(await login('sample', `${PFX}B`, NEWPW))
    ok('#9712 見終わったら staff-welcome を done で残す', must(await sbc.get('/api/staff/tours'), 'g').progress['staff-welcome']?.status === 'done')
    await send('Page.reload'); await ready()
    ok('#9712 画面: 見終わった後は自動で出さない', !(await ev(`!!document.querySelector('#tour-root .tour-bubble')`)))
    await ev(`location.hash = 'more'`)
    await until(`!!document.querySelector('[data-action="tourStaffReplay"]')`, 5000)
    ok('#9712 画面: 「その他」に「使い方をもう一度見る」', /使い方をもう一度見る/.test(await ev(`document.querySelector('[data-action="tourStaffReplay"]').textContent`)))
    await ev(`document.querySelector('[data-action="tourStaffReplay"]').click()`)
    await until(`!!document.querySelector('#tour-root .tour-bubble')`, 5000)
    ok('#9712 画面: 「使い方をもう一度見る」で最初から案内する', /ホーム画面に追加/.test(await title()))
    await clickAct('close'); await wait(400)
    // Android の Chrome: メニューからの追加の手順
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' })
    await send('Page.reload'); await ready()
    await ev(`FosTour.start('staff')`)
    await until(`/ホーム画面に追加/.test((document.querySelector('#tour-root .tour-title') || {}).textContent || '')`, 5000)
    const bodyA = await ev(`document.querySelector('#tour-root .tour-body').textContent`)
    ok('#9712 画面: Android の Chrome にはメニューからの追加の手順', /メニュー/.test(bodyA) && /アプリをインストール/.test(bodyA) && !/共有ボタン/.test(bodyA), bodyA)
    await clickAct('close'); await wait(300)
    // ホーム画面から開いているとき（standalone）は「ホーム画面に追加」を飛ばす
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] })
    const standalone = await ev(`matchMedia('(display-mode: standalone)').matches`)
    if (standalone) {
      await ev(`FosTour.start('staff')`)
      await until(`!!document.querySelector('#tour-root .tour-title') && !/開いています/.test(document.querySelector('#tour-root .tour-title').textContent)`, 8000)
      ok('#9712 画面: ホーム画面から開いているとき（standalone）は「ホーム画面に追加」を飛ばす', /打刻/.test(await title()), await title())
      await clickAct('close')
    } else console.log('SKIP  standalone の確認（このブラウザでは display-mode を変えられない）')
    await send('Emulation.setEmulatedMedia', { features: [] })
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
