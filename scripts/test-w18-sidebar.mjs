// w18-sidebar（#9922）の統合テスト
// 管理画面の左のメニューを畳む・開く（ボタン・状態を人ごと・端末ごとに覚える・本文と下に固定したバーの左の余白）と、
// シフト管理の週の表（案件ごと・人ごと）の列の幅（左の列は決まった幅、日の列は残りを等分。メニューを畳めば 1366px でも横スクロールなし）を確かめる。
// 画面での見え方（1366/1440/1920px の scrollWidth・スクリーンショット）は、ヘッドレスの Chrome で別に確かめる（notes を参照）。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8950 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8950 node scripts/test-w18-sidebar.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8950'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
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
  return { get: (p) => call('GET', p) }
}
const staticFile = async (name) => (await fetchRetry(`${BASE}/static/${name}`)).text()
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))

// ---------- 管理画面の HTML ----------
const page = await admin.get('/admin')
ok('管理画面を開ける', page.status === 200, page.status)
const html = page.text
const me = (await admin.get('/api/auth/me')).data || {}
const meUser = me.user || me
const key = (html.match(/<body[^>]*data-side-key="([^"]+)"/) || [])[1]
ok('状態を覚えるキーは人ごと（body の data-side-key にログイン中の人の ID を入れる）', key === `admin-side-collapsed:${Number(meUser.user_id)}`, { key, user_id: meUser.user_id })
const mgrKey = ((await mgr.get('/admin')).text.match(/<body[^>]*data-side-key="([^"]+)"/) || [])[1]
ok('別の人ではキーが変わる', !!mgrKey && /^admin-side-collapsed:\d+$/.test(mgrKey) && mgrKey !== key, { key, mgrKey })
const bodyStart = html.indexOf('<body')
const early = html.slice(bodyStart, html.indexOf('<aside id="sidebar"'))
ok('描く前に畳んだ状態を戻す（メニューより前の script。localStorage は try/catch で読み、読めないときは開いた状態）',
  /<script>try \{ if \(localStorage\.getItem\(document\.body\.dataset\.sideKey\) === '1'\) document\.body\.classList\.add\('side-collapsed'\) \} catch \(e\) \{\}<\/script>/.test(early))
const aside = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>'))
const toggle = (aside.match(/<button[^>]*id="side-toggle"[^>]*>/) || [''])[0]
ok('メニューに「畳む／開く」のボタンがある（button・aria-expanded・aria-controls・名前）',
  toggle.includes('type="button"') && toggle.includes('data-action="sideToggle"') && toggle.includes('aria-expanded="true"') && toggle.includes('aria-controls="side-nav"') && toggle.includes('aria-label="メニューを畳む"') && toggle.includes('title="メニューを畳む"'), toggle)
ok('メニューの幅はクラスで決める（w-60 を外し、本文は admin-main。md:ml-60 は使わない）',
  /<aside id="sidebar" class="hidden md:flex flex-col bg-white/.test(html) && !/<aside id="sidebar"[^>]*\bw-60\b/.test(html) && html.includes('<div class="admin-main flex-1 min-w-0">') && !html.includes('md:ml-60'))
ok('見出し（#9305）・項目・下の伴走支援・ログアウトはそのまま',
  (aside.match(/class="nav-group-head" data-action="navGroupToggle"/g) || []).length === 7 && (aside.match(/class="side-link/g) || []).length >= 24
  && aside.includes('<div class="side-foot p-3 border-t border-gray-100">') && aside.includes('data-action="hqsOpenSupport"') && aside.includes('id="logout-btn"'))
ok('スマホ幅のメニュー（上のヘッダーの選択欄）は変えない', html.includes('<header class="md:hidden') && html.includes('<select id="mobile-nav"') && /<aside id="sidebar" class="hidden md:flex/.test(html))

// スタッフ画面・本部画面には畳むボタンを付けない（本部画面は上のメニューで、左のメニューはない）
const staffHtml = (await client(await login('sample', 'st001')).get('/staff')).text
ok('スタッフ画面は変わらない（畳むボタン・data-side-key なし）', !staffHtml.includes('side-toggle') && !staffHtml.includes('data-side-key'))

// ---------- 開閉（admin.js） ----------
const a = await staticFile('admin.js')
const sideJs = a.slice(a.indexOf('// 左のメニュー全体を畳む・開く（#9922）'), a.indexOf('// ============ ダッシュボード ============'))
ok('ボタンで開閉し、状態を data-side-key のキーで localStorage に覚える（書けなくても開閉はできる）',
  sideJs.includes("delegate('sideToggle', () => setSideCollapsed(!sideCollapsed(), true))") && sideJs.includes('const SIDE_KEY = document.body.dataset.sideKey')
  && /try \{ localStorage\.setItem\(SIDE_KEY, on \? '1' : '0'\) \} catch \(e\)/.test(sideJs))
ok('aria-expanded・ボタンの名前（畳む／開く）を状態に合わせる', sideJs.includes("b.setAttribute('aria-expanded', String(!on))") && sideJs.includes("on ? 'メニューを開く' : 'メニューを畳む'"))
ok('畳んだときは項目に title（名前・件数）を付け、開いたら自分で付けた title だけを外す',
  sideJs.includes('el.title = sideItemLabel(el)') && sideJs.includes("el.removeAttribute('title')") && sideJs.includes('el.dataset.sideTitle')
  && sideJs.includes("b.style.display !== 'none'") && sideJs.includes('new MutationObserver('))
ok('下に固定したバー（スタッフ一覧のまとめての操作）はメニューの幅に合わせる（md:left-64 を使わない）',
  a.includes('<div id="staff-bulk" class="hidden fixed bottom-4 inset-x-4 side-offset-left md:right-6') && !a.includes('md:left-64'))
const allJs = await Promise.all(['shift-board.js', 'roster.js', 'settlement.js', 'corrections.js', 'recruit.js', 'board.js', 'tour.js', 'hq-support.js', 'report-settings.js', 'attendance-history.js', 'notifications.js', 'security.js', 'staff-lifecycle.js', 'roster-chat.js'].map(staticFile))
ok('ほかの画面にもメニューの幅（md:left-64・md:ml-60・md:left-60）に合わせた固定の余白は残っていない', allJs.every(t => !/md:(left|ml)-(60|64)\b/.test(t)))

// ---------- 見た目（style.css） ----------
const css = await staticFile('style.css')
// 縮めた CSS では、同じ中身のルールがまとめられたり分けられたりするため、セレクタごとに中身を集めて確かめる
const decl = (sel) => [...css.matchAll(/([^{}]+){([^{}]*)}/g)].filter(m => m[1].split(',').map(x => x.trim()).includes(sel)).map(m => m[2]).join(';')
ok('畳んだ幅は 3.5rem（56px）、開いた幅は 15rem。本文と下のバーは同じ幅だけ空ける（md 以上だけ）',
  /@media \(min-width:768px\)\{body\{--side-w:15rem\}body\.side-collapsed\{--side-w:3\.5rem\}#sidebar\{width:var\(--side-w\)/.test(css)
  && css.includes('.admin-main{margin-left:var(--side-w)') && css.includes('.side-offset-left{left:calc(var(--side-w) + 1rem)}'))
ok('畳んだときは見出しを区切り線にし、閉じた見出しの中の項目も出す', css.includes('body.side-collapsed #side-nav .nav-group-head{display:none}') && css.includes('body.side-collapsed #side-nav .nav-group{border-top:1px solid #e5e7eb')
  && css.includes('body.side-collapsed #side-nav .nav-group.collapsed .nav-group-body{display:block}'))
ok('畳んだときは文字を隠してアイコンを出し、件数のバッジはアイコンの右上に小さく出す',
  ['body.side-collapsed #sidebar .side-link', 'body.side-collapsed #sidebar .side-foot button'].every(x => decl(x).includes('justify-content:center') && decl(x).includes('font-size:0'))
  && ['body.side-collapsed #sidebar .side-link>i', 'body.side-collapsed #sidebar .side-foot button>i'].every(x => decl(x).includes('font-size:.95rem'))
  && decl('body.side-collapsed #sidebar .side-link>span').includes('position:absolute;top:.1rem;right:.15rem'))
ok('キーボードで操作したときに枠を出す', ['.side-toggle:focus-visible', '#sidebar .side-link:focus-visible', '#sidebar .side-foot button:focus-visible'].every(x => decl(x).includes('outline:2px solid')))
ok('シフト管理の表の画面では内容の最大幅を外す', css.includes('body:has(#board-grid) #app,body:has(#board-grid) #hq-support-bar,body:has(#board-grid) #tour-help-bar{max-width:none}'))
ok('週の表は table-layout: fixed で幅いっぱいにする', css.includes('.board-table.board-fit{table-layout:fixed;width:100%}'))

// ---------- シフト管理の表の列の幅（shift-board.js） ----------
const sb = allJs[0]
const slot = sb.slice(sb.indexOf('function slotGrid(days)'), sb.indexOf('// 月のカレンダー（月曜始まり）'))
const person = sb.slice(sb.indexOf('function personGrid(days)'), sb.indexOf('// ---------- ボード操作 ----------'))
const rh = Number((sb.match(/const BOARD_RH_W = (\d+)/) || [])[1])
const slotDay = Number((slot.match(/const w = BS\.days > 7 \? \d+ : (\d+)/) || [])[1])
const personDay = Number((person.match(/const dayW = BS\.days > 14 \? \d+ : (\d+)/) || [])[1])
ok('案件ごと: 左の列は決まった幅、日の列は最小の幅だけを決める（表の最小の幅 = 左の列 + 日数 × 最小の幅）',
  rh > 0 && slotDay > 0 && slot.includes('<table class="board-table board-fit" style="min-width:${BOARD_RH_W + days.length * w}px">') && slot.includes('style="width:${BOARD_RH_W}px">案件 / 開催場所 / 役割</th>') && !slot.includes('min-width:190px'), { rh, slotDay })
ok('人ごと: 名前・稼働の列は決まった幅、日の列は最小の幅だけを決める',
  personDay > 0 && person.includes('<table class="board-table board-fit" style="min-width:${BOARD_RH_W + 56 + days.length * dayW}px">') && person.includes('style="width:${BOARD_RH_W}px">スタッフ</th><th class="board-th" style="width:56px">稼働</th>') && !person.includes('118'), { personDay })
ok('左の列の文字は省略し、title で全部を出す（案件ごと・枠なし・人ごと）',
  slot.includes('<td class="board-rowhead sticky left-0 bg-white z-10" title="${esc(`${r.site || \'（場所未設定）\'}\\n${r.start}〜${r.end}・${r.role}`)}">') && slot.includes('<p class="text-[11px] text-gray-500 truncate">${esc(r.start)}')
  && slot.includes('title="${esc(`${p.project_name || \'\'}\\n${r.site || \'\'}`)}"') && person.includes('<td class="board-rowhead sticky left-0 bg-white z-10" title="${esc(`${r.name || \'\'} ') && person.includes('<p class="truncate"><a href="#staff/'))
// 週の表がメニューを畳んだ 1366px で収まる幅か（本文の幅の計算。スクロールバー 15px、本文の左右の余白 48px、右の候補の欄 340px と間 12px、表の枠 2px）
const inner = (vw, side) => vw - 15 - side - 48
const slotFits = (vw, side) => rh + 7 * slotDay <= inner(vw, side) - 340 - 12 - 2
const personFits = (vw, side) => rh + 56 + 7 * personDay <= inner(vw, side) - 2
ok('計算: メニューを畳めば 1366・1440・1920px で、案件ごとの週（左の列 + 7日）が横スクロールなしで収まる', [1366, 1440, 1920].every(vw => slotFits(vw, 56)), { rh, slotDay })
ok('計算: 人ごとの週は、メニューを開いたままでも 1366px で収まる', personFits(1366, 240) && [1366, 1440, 1920].every(vw => personFits(vw, 56)), { rh, personDay })
ok('計算: 最大幅（1280px）が効かないブラウザでも、メニューを畳んだ 1366px で案件ごとの週が収まる', rh + 7 * slotDay <= 1280 - 48 - 340 - 12 - 2)

// シフト管理の API は変わらない（表を描くのに使う）
const week = await admin.get('/api/admin/shift-board?from=2026-11-09&to=2026-11-15')
ok('シフト管理の表のデータは今までどおり取れる', week.status === 200 && Array.isArray(week.data?.slots), week.status)

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
