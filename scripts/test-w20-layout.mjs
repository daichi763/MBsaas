// w20-layout（#9930）の統合テスト
// 管理画面の本文の幅を画面の種類で分ける（一覧・表・ダッシュボードなどは幅いっぱい、入力フォームが中心の画面は 1024px まで）。
// HTML（#app・#hq-support-bar の class）・style.css の規則・admin.js の route() の印を確かめる。
// 画面での見え方（1366/1440/1920/2560px でメニューを開いた・畳んだときの本文の幅・横スクロール・JS のエラー）は、ヘッドレスの Chrome で別に確かめる（notes を参照）。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8780 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8780 node scripts/test-w20-layout.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8780'
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
  const call = async (method, path) => {
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie }, redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p) }
}
const staticFile = async (name) => (await fetchRetry(`${BASE}/static/${name}`)).text()
const admin = client(await login('sample', 'admin'))

// ---------- 管理画面の HTML ----------
const page = await admin.get('/admin')
ok('管理画面を開ける', page.status === 200, page.status)
const html = page.text
const main = (html.match(/<main id="app"[^>]*>/) || [''])[0]
const bar = (html.match(/<div id="hq-support-bar"[^>]*>/) || [''])[0]
ok('本文（#app）に固定の最大幅（max-w-7xl）を付けない。初めの印は幅いっぱい（full）', main === '<main id="app" class="p-4 md:p-6" data-layout="full">', main)
ok('本部の閲覧中の表示（#hq-support-bar）にも固定の最大幅を付けない（余白・hidden はそのまま）', bar === '<div id="hq-support-bar" class="px-4 md:px-6 pt-4 space-y-2 hidden">', bar)
ok('本文は .admin-main の直下（幅の規則の前提）', /<div class="admin-main flex-1 min-w-0">[\s\S]*<div id="hq-support-bar"[^>]*><\/div>\s*(<!--[^>]*-->\s*)?<main id="app"[^>]*><\/main>\s*<\/div>/.test(html))

// 本部画面・スタッフアプリは変えない
const hqHtml = (await client(await login('', 'hq')).get('/hq')).text
ok('本部画面の本文は今までどおり max-w-7xl で中央に寄せる（.admin-main がないので幅の規則は効かない）', hqHtml.includes('<main id="app" class="max-w-7xl mx-auto p-4 md:p-6"></main>') && !hqHtml.includes('admin-main'), hqHtml.slice(0, 200))
const staffHtml = (await client(await login('sample', 'st001')).get('/staff')).text
ok('スタッフアプリの本文は変わらない（max-w-lg）', /<main id="app" class="max-w-lg mx-auto px-4 py-4[^"]*"><\/main>/.test(staffHtml) && !staffHtml.includes('data-layout'))

// ---------- 幅の規則（style.css） ----------
const css = await staticFile('style.css')
// 縮めた CSS では、セレクタの並びが入れ替わることがあるため、セレクタごとに中身を集めて確かめる
const decl = (sel) => [...css.matchAll(/([^{}]+){([^{}]*)}/g)].filter(m => m[1].split(/,(?![^(]*\))/).map(x => x.trim()).includes(sel)).map(m => m[2]).join(';')
ok('幅いっぱい: .admin-main の直下の本文・本部の表示・ヘルプの行は最大幅なし（max-w-7xl の class より強い）',
  ['.admin-main>#app', '.admin-main>#hq-support-bar', '.admin-main>#tour-help-bar'].every(x => decl(x).includes('max-width:none')))
ok('フォームの幅: #app が data-layout=form のときは、本文・本部の表示・ヘルプの行を 64rem（1024px）まで',
  ['.admin-main>#app[data-layout=form]', '.admin-main:has(>#app[data-layout=form])>#hq-support-bar', '.admin-main:has(>#app[data-layout=form])>#tour-help-bar'].every(x => decl(x).includes('max-width:64rem')))
ok('シフト管理だけの古い規則（body:has(#board-grid)）は残っていない（幅いっぱいの規則にまとめた）', !css.includes('body:has(#board-grid)'))
ok('メニューを畳む規則（#9922）はそのまま（本文の左の余白はメニューの幅に合わせる）',
  css.includes('.admin-main{margin-left:var(--side-w)') && /body\{--side-w:15rem\}body\.side-collapsed\{--side-w:3\.5rem\}/.test(css))

// ---------- 画面の切り替え（admin.js） ----------
const a = await staticFile('admin.js')
const formTabs = (a.match(/const APP_FORM_TABS = new Set\(\[([^\]]*)\]\)/) || [])[1]
ok('フォームの幅にする画面は、アカウント設定とセキュリティ', formTabs !== undefined && JSON.stringify(formTabs.split(',').map(x => x.trim().replace(/'/g, ''))) === JSON.stringify(['account', 'security']), formTabs)
const routeFn = a.slice(a.indexOf('function route() {'), a.indexOf("window.addEventListener('hashchange', route)"))
const mark = "$app.dataset.layout = APP_FORM_TABS.has(tab) ? 'form' : 'full'"
ok('route() がハッシュの先頭で #app に印を付ける（それ以外の画面・詳細はすべて幅いっぱい）', routeFn.includes(mark))
ok('印は、二段階認証・仮パスワードの振り替えの後、どの画面を描くよりも前に付ける',
  routeFn.indexOf(mark) > routeFn.indexOf('must_change_password') && routeFn.indexOf(mark) < routeFn.indexOf("if (tab === 'projects' && id === 'templates')"))

// ---------- 広い画面の列の数 ----------
// 1800px 以上（1920px のモニターなど）で、カードの並びの列を増やす（右の欄・カードが間延びしないように）
ok('クライアントのカードは 1800px 以上で 4 列', a.includes('<div class="grid md:grid-cols-2 xl:grid-cols-3 min-[1800px]:grid-cols-4 gap-4" id="client-cards"></div>'))
ok('日報テンプレートのカードは 1800px 以上で 3 列（自社・本部配信）', a.includes('<div class="grid md:grid-cols-2 min-[1800px]:grid-cols-3 gap-4 mb-6">${own.map(card)') && a.includes('<div class="grid md:grid-cols-2 min-[1800px]:grid-cols-3 gap-4">${hq.map(card)'))
ok('スタッフ詳細は 1800px 以上で 4 列（基本情報 3 列・右のファイルと評価のグラフ 1 列）',
  /<div class="grid lg:grid-cols-3 min-\[1800px\]:grid-cols-4 gap-4 mb-4">\s*<section class="card p-4 lg:col-span-2 min-\[1800px\]:col-span-3" id="staff-basic-info">/.test(a))
const m1800 = (css.match(/@media \(min-width:1800px\)\{([^@]*)\}/) || [])[1] || ''
ok('1800px の列の class が style.css にあり、lg・xl の規則より後ろ（後ろの方が効く）',
  ['.min-\\[1800px\\]\\:grid-cols-4{', '.min-\\[1800px\\]\\:grid-cols-3{', '.min-\\[1800px\\]\\:col-span-3{'].every(x => m1800.includes(x))
  && css.indexOf('@media (min-width:1800px)') > css.indexOf('.xl\\:grid-cols-3{') && css.indexOf('@media (min-width:1800px)') > css.indexOf('.lg\\:col-span-2{'), m1800.slice(0, 300))
ok('スマホ幅・下に固定したバー・モーダルの規則は変えない', css.includes('.modal-box{') && /max-width:560px/.test(css) && css.includes('.side-offset-left{left:calc(var(--side-w) + 1rem)}'))

// ---------- 画面のデータは変わらない ----------
for (const p of ['/api/admin/dashboard', '/api/auth/account', '/api/admin/staff']) {
  const r = await admin.get(p)
  ok(`${p} は今までどおり取れる`, r.status === 200 && r.data, r.status)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
