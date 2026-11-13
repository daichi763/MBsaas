// w26-tokens（Sprint 26 #9977）: 見た目のトークン化の確認
//   1) 画面の JS・HTML に、Tailwind の色の名前（gray・blue など）・11px などの文字の大きさ・style の #xxxxxx が残っていない（決めた例外だけ）
//   2) 置き換えた後のクラスの名前の並び（Tailwind は名前の文字の順に CSS を出す）で、同じ要素の同じ種類のクラスの効く方が、置き換え前と同じ
//   3) トークンの値が、置き換え前の Tailwind の値（色・角丸・影・文字の大きさ）と同じ（見た目は変わらない）
//   4) src/input.css の共通クラスは :root の変数だけを使い、使っている変数はすべて :root にある。候補 A〜G に必要な役割の変数がある
//   5) 配信している style.css・各画面の HTML（ログイン・管理画面・スタッフアプリ・本部画面）がトークンのクラスを使い、元の色の名前を使っていない
//   6) ヘッドレスの Chrome があれば、画面の色が前と同じ値で、変数の値を変えると画面の色が変わる（候補を値の差し替えだけで当てられる）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9031 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9031 node --import ./scripts/fetch-origin.mjs scripts/test-w26-tokens.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9031'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const require = createRequire(import.meta.url)
const colors = require(join(ROOT, 'node_modules/tailwindcss/colors.js'))
const defaults = require(join(ROOT, 'node_modules/tailwindcss/stubs/config.full.js')).theme
const cm = await import(pathToFileURL(join(ROOT, 'scripts/tokens-codemod.mjs')).href)
const rgbOf = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ')

// ---------- :root の変数 ----------
const css = read('src/input.css')
const rootBlock = (css.match(/:root\s*\{([\s\S]*?)\n {2}\}/) || [])[1] || ''
const VARS = new Map([...rootBlock.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
// var(--x) を値までたどる（色は "R G B"）
const resolve = (v, depth = 0) => depth > 5 ? v : v.replace(/var\((--[a-z0-9-]+)\)/g, (m, n) => VARS.has(n) ? resolve(VARS.get(n), depth + 1) : m)
ok(':root に変数がある（段の色・役割の色・角丸・影・文字）', VARS.size > 150, VARS.size)

// ---------- 1) 直書きが残っていない ----------
{
  const left = []
  for (const f of cm.targetFiles()) {
    const s = read(f)
    const t = await cm.transform(s, f)
    if (t !== s) left.push(f)
  }
  ok('1) 置き換え（scripts/tokens-codemod.mjs）が残っているファイルが無い', left.length === 0, left)
  // Tailwind の色の名前が残っているのは、イベント属性（ondragover）とそれと対になる行だけ
  const raw = []
  for (const f of cm.targetFiles()) {
    const lines = read(f).split('\n')
    lines.forEach((l, i) => { for (const m of l.matchAll(cm.RAW_COLOR_RE)) raw.push(`${f}:${i + 1} ${m[0]}`) })
  }
  const allowed = raw.filter(r => /^public\/static\/admin\.js:\d+ (border-blue-400|bg-blue-50)$/.test(r))
  ok('1) Tailwind の色の名前のクラスは、admin.js の資料の置き場（ondragover の中と、対になる行）の 6 か所だけ', raw.length === allowed.length && allowed.length === 6, raw)
  const bgWhite = [], sizes = []
  for (const f of cm.targetFiles()) {
    const s = read(f).replace(/\bon[a-z]+="[^"]*"/g, '')
    for (const m of s.matchAll(/(?<![\w-])(?:[a-z0-9-]+:)*bg-white(?![\w-])/g)) bgWhite.push(f)
    for (const m of s.matchAll(/(?<![\w-])(?:[a-z0-9-]+:)*text-\[(9|10|11)px\]/g)) sizes.push(f + ' ' + m[0])
  }
  ok('1) bg-white は bg-surface に、text-[11px]・[10px]・[9px] は text-2xs・3xs・4xs に置き換わっている', !bgWhite.length && !sizes.length, { bgWhite, sizes })
  // style の直書きの色（#xxxxxx）。印刷用の別ウィンドウ・CDN の部品が読めないときの案内・グラフの色だけは残す。
  // 透明度つきの rgba() は残す（rgb(var(--…) / a) にすると Chrome の重ね方が変わって 1 段ずれるため。docs/design-tokens.md）
  const hex = []
  for (const f of cm.targetFiles().filter(f => /^public\/static\/|^src\/index\.tsx$/.test(f))) {
    read(f).split('\n').forEach((l, i) => {
      if (/<style>|LIB_FALLBACK|theme-color|ACHART_|window\.open|tokenColor\(/.test(l)) return
      for (const m of l.matchAll(/(style="[^"]*"|style='[^']*'|cssText\s*=\s*'[^']*'|^#tour-[^{]*\{.*)/g)) {
        const bad = m[0].match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|rgb\(var\([^)]*\)\s*\/[^)]*\)/g)
        if (bad) hex.push(`${f}:${i + 1} ${bad.join(' ')}`)
      }
    })
  }
  ok('1) 画面の JS・index.tsx の style・cssText・案内の CSS に #xxxxxx が残っていない（透明度つきの色を rgb(var(--…) / a) で作っていない）', hex.length === 0, hex)
  const chart = read('public/static/admin.js')
  ok('1) グラフ（canvas）の主色は tokenColor で変数から読む（読めないときは今の値）', (chart.match(/tokenColor\('primary', [.\d]+, '(#2563eb|rgba\(37,99,235,\.15\))'\)/g) || []).length === 5 && !/['"]#2563eb['"],/.test(chart.replace(/tokenColor\([^)]*\)/g, '')), (chart.match(/tokenColor\([^)]*\)/g) || []).length)
  const common = read('public/static/common.js')
  ok('1) common.js に tokenColor（:root の色を rgba() にする）がある', /function tokenColor\(name, alpha = 1, fallback = ''\)/.test(common) && common.includes("getPropertyValue('--color-' + name)"))
  // イベント属性は変えていない
  const ev = read('public/static/admin.js')
  ok('1) イベント属性（ondragover・ondragleave）の中は変えていない', ev.includes(`ondragover="event.preventDefault(); this.classList.add('border-blue-400','bg-blue-50')"`) && ev.includes(`ondragleave="this.classList.remove('border-blue-400','bg-blue-50')"`) && ev.includes(`classList.remove('border-blue-400', 'bg-blue-50')`))
}

// ---------- 2) 効く方が置き換え前と同じ ----------
{
  // 置き換え後の名前を前の名前に戻して、並びの向きが同じかを確かめる
  const REV = Object.fromEntries(Object.entries(cm.FAMILY).map(([k, v]) => [v, k]))
  const famRe = new RegExp(`^((?:[a-z0-9-]+(?:-\\[[^\\]]+\\])?:)*)(${cm.COLOR_UTILS})-(${Object.keys(REV).sort((a, b) => b.length - a.length).join('|')})-(\\d{2,3})(\\/\\d+)?$`)
  const back = (c) => {
    let m = c.match(famRe)
    if (m) return `${m[1]}${m[2]}-${REV[m[3]]}-${m[4]}${m[5] || ''}`
    if ((m = c.match(/^((?:[a-z0-9-]+:)*)bg-surface(\/\d+)?$/))) return `${m[1]}bg-white${m[2] || ''}`
    if ((m = c.match(/^((?:[a-z0-9-]+:)*)text-(2xs|3xs|4xs)$/))) return `${m[1]}text-[${{ '2xs': '11px', '3xs': '10px', '4xs': '9px' }[m[2]]}]`
    return c
  }
  const flips = []
  let pairs = 0
  for (const f of cm.targetFiles()) {
    const s = read(f)
    // 置き換え後のコードを前の名前に戻したもので orderFlips を流すと、前 → 後で効く方が入れ替わる所が出る
    const before = s.replace(/(?<![\w[-])(?:[a-z0-9-]+(?:-\[[^\]]+\])?:)*[a-z]+-[a-z0-9[\]/.-]+(?![\w-])/g, (c) => { pairs++; return back(c) })
    flips.push(...cm.orderFlips(before, f))
  }
  ok('2) 同じ要素の同じ種類（文字の色・背景・枠・文字の大きさ）のクラスで、効く方が置き換え前と同じ', flips.length === 0 && pairs > 1000, { flips: flips.slice(0, 10), pairs })
}

// ---------- 3) トークンの値が置き換え前の Tailwind の値と同じ ----------
{
  const bad = []
  for (const [raw, fam] of Object.entries({ ...cm.FAMILY, violet: 'accent-2' })) {
    for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      const v = VARS.get(`--color-${fam}-${n}`)
      if (v !== rgbOf(colors[raw][n])) bad.push(`--color-${fam}-${n}=${v} (${raw}-${n} ${rgbOf(colors[raw][n])})`)
    }
  }
  ok('3) 段の色（neutral・primary など 13 系統 × 11 段）は、置き換え前の Tailwind の色と同じ値', bad.length === 0, bad.slice(0, 10))
  const r = defaults.borderRadius, sh = defaults.boxShadow, fs = defaults.fontSize
  const rad = { sm: '--radius-sm', DEFAULT: '--radius', md: '--radius-md', lg: '--radius-lg', xl: '--radius-xl', '2xl': '--radius-2xl', '3xl': '--radius-3xl' }
  const badR = Object.entries(rad).filter(([k, v]) => Number.parseFloat(VARS.get(v)) !== Number.parseFloat(r[k]) || !/rem$/.test(VARS.get(v)))
  ok('3) 角丸（rounded・rounded-sm〜3xl）は Tailwind の既定と同じ値', badR.length === 0, badR)
  const norm = s => String(s).replace(/\s+/g, ' ').replace(/0\.(\d)/g, '.$1').trim()
  const badS = ['sm', 'DEFAULT', 'md', 'lg'].filter(k => norm(VARS.get(k === 'DEFAULT' ? '--shadow' : `--shadow-${k}`)) !== norm(sh[k]))
  ok('3) 影（shadow-sm・shadow・shadow-md・shadow-lg）は Tailwind の既定と同じ値', badS.length === 0, badS)
  ok('3) ログインの画面のロゴの影（shadow-brand）は shadow-lg の形に主色の 200 の色（前の shadow-lg shadow-blue-200 と同じ）', norm(resolve(VARS.get('--shadow-brand'))) === norm(sh.lg.replace(/rgb\(0 0 0 \/ 0\.1\)/g, `rgb(${rgbOf(colors.blue[200])})`)), resolve(VARS.get('--shadow-brand')))
  const badF = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'].filter(k => VARS.get(`--text-${k}`) !== fs[k][0] || VARS.get(`--leading-${k}`) !== fs[k][1].lineHeight)
  ok('3) 文字の大きさ（text-xs〜text-4xl）と行の高さは Tailwind の既定と同じ値', badF.length === 0, badF)
  ok('3) text-2xs・3xs・4xs は 11px・10px・9px（前の text-[11px] などと同じ。行の高さは決めない）', VARS.get('--text-2xs') === '11px' && VARS.get('--text-3xs') === '10px' && VARS.get('--text-4xs') === '9px')
  // 共通クラスの値（役割の変数をたどった値）が、前の直書きの値と同じ
  const was = {
    '.card': ['rgb(255 255 255)', 'rgb(243 244 246)', '1rem', '0 1px 2px rgba(0,0,0,.03)'],
    '.btn-primary': ['rgb(37 99 235)'], '.inp:focus': ['rgb(59 130 246)', '0 0 0 3px rgba(59,130,246,.1)'], '.modal-bg': ['rgba(15,23,42,.5)'],
    '.badge-purple': ['rgb(237 233 254)', 'rgb(109 40 217)'], '.toast-msg': ['rgb(17 24 39)', 'rgb(255 255 255)', '.8rem', '.85rem', '0 8px 20px rgba(0,0,0,.25)'],
    '.report-btn.next': ['rgb(37 99 235)', 'rgb(239 246 255)', '0 4px 12px rgba(37,99,235,.12)'],
  }
  const badC = []
  for (const [sel, vals] of Object.entries(was)) {
    const rule = (css.match(new RegExp(sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}')) || [])[1] || ''
    const got = resolve(rule)
    for (const v of vals) if (!got.includes(v)) badC.push(`${sel} に ${v} が無い: ${got.slice(0, 200)}`)
  }
  ok('3) 共通クラス（card・btn-primary・inp・modal・badge・toast・report-btn）の値は前と同じ', badC.length === 0, badC)
}

// ---------- 4) input.css・tailwind.config ----------
{
  const outside = css.replace(/:root\s*\{[\s\S]*?\n {2}\}/, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const hex = outside.match(/#[0-9a-fA-F]{3,6}\b(?![\w-]*\s*[{,])|rgba?\([0-9][^)]*\)|rgb\(var\([^)]*\)\s*\/[^)]*\)/g) || []
  ok('4) src/input.css の :root の外に #xxxxxx・rgba() の直書きが無く、透明度つきの色を rgb(var(--…) / a) で作っていない', hex.length === 0, hex)
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]))
  const cfg = read('tailwind.config.js')
  const fam = [...cfg.matchAll(/family\('([a-z0-9-]+)'/g)].map(m => m[1])
  for (const f of fam) for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) used.add(`--color-${f}-${n}`)
  for (const m of cfg.matchAll(/rgb\('([a-z0-9-]+)'\)/g)) used.add(`--color-${m[1]}`)
  for (const m of cfg.matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(m[1])
  for (const f of cm.targetFiles()) for (const m of read(f).matchAll(/var\((--color-[a-z0-9-]+)\)/g)) used.add(m[1])
  const local = new Set(['--side-w', '--tw-shadow', '--tw-ring-offset-shadow', '--tw-ring-shadow'])
  const missing = [...used].filter(v => !v.endsWith('-') && !VARS.has(v) && !local.has(v))
  ok('4) 使っている変数（input.css・tailwind.config.js・画面の JS の style）は、すべて :root にある', missing.length === 0, missing)
  const need = ['--color-bg', '--color-backdrop', '--color-surface', '--color-primary', '--color-primary-hover', '--color-primary-soft', '--color-text', '--color-text-sub', '--color-muted', '--color-border', '--color-danger', '--color-success', '--color-warning', '--color-on-primary', '--radius-card', '--radius-ctrl', '--shadow-card', '--font-sans']
  ok('4) 候補 A〜G を値の差し替えで当てるための役割の変数がある（bg・surface・primary・text・muted・border・danger・角丸・影・文字）', need.every(v => VARS.has(v)), need.filter(v => !VARS.has(v)))
  ok('4) 役割の色は段の色を指す（段の値を変えれば、共通クラスとクラスの両方が変わる）', VARS.get('--color-primary') === 'var(--color-primary-600)' && VARS.get('--color-border') === 'var(--color-neutral-200)' && VARS.get('--color-muted') === 'var(--color-neutral-500)')
  ok('4) tailwind.config.js は色・角丸・影・文字の大きさを変数で決める（theme.extend）', /primary: family\('primary'/.test(cfg) && /lg: 'var\(--radius-lg\)'/.test(cfg) && /lg: 'var\(--shadow-lg\)'/.test(cfg) && /xs: \['var\(--text-xs\)', \{ lineHeight: 'var\(--leading-xs\)' \}\]/.test(cfg) && /<alpha-value>/.test(cfg))
  ok('4) 資料 docs/design-tokens.md がある（変数の一覧と使い方・候補の当て方）', existsSync(join(ROOT, 'docs/design-tokens.md')) && /--color-primary/.test(read('docs/design-tokens.md')) && /tokens-codemod/.test(read('docs/design-tokens.md')))
}

// ---------- 5) 配信している CSS・HTML ----------
async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  return (r.headers.get('set-cookie') || '').split(';')[0]
}
let served = true
try {
  const st = await fetch(`${BASE}/static/style.css`).then(r => r.text())
  ok('5) style.css の :root に段の色と役割の変数がある', /--color-primary-600:37 99 235/.test(st) && /--color-primary:var\(--color-primary-600\)/.test(st) && /--radius-card:1rem/.test(st), st.slice(0, 200))
  ok('5) style.css のクラスは変数を見る（bg-primary-600・text-neutral-500・rounded-lg・text-xs・shadow-brand）',
    /\.bg-primary-600\{[^}]*rgb\(var\(--color-primary-600\)\//.test(st) && /\.text-neutral-500\{[^}]*rgb\(var\(--color-neutral-500\)\//.test(st) && /\.rounded-lg\{border-radius:var\(--radius-lg\)\}/.test(st) && /\.text-xs\{font-size:var\(--text-xs\);line-height:var\(--leading-xs\)\}/.test(st) && /\.shadow-brand\{--tw-shadow:var\(--shadow-brand\)/.test(st))
  ok('5) style.css に灰・青などの元の名前のクラス（.bg-gray-50・.text-gray-500・.bg-white・.text-\\[11px\\]）が出ていない', !/\.bg-gray-50\{|\.text-gray-500\{|\.bg-white\{|\.text-\\\[11px\\\]\{/.test(st))
  ok('5) style.css の共通クラスは変数を見る（.card・.btn-primary）', /\.card\{background:rgb\(var\(--color-surface\)\)/.test(st) && /\.btn-primary\{background:rgb\(var\(--color-primary\)\)/.test(st))
  const RAW = /class="[^"]*\b(?:bg|text|border)-(?:gray|blue|red|amber|emerald|slate|cyan|purple|orange|green|yellow|indigo)-\d{2,3}\b/
  const login0 = await fetch(`${BASE}/login`).then(r => r.text())
  ok('5) ログインの画面の HTML はトークンのクラス（bg-neutral-50・bg-surface・shadow-brand）を使い、元の色の名前を使わない', login0.includes('bg-neutral-50') && login0.includes('bg-surface') && login0.includes('shadow-brand') && !RAW.test(login0) && !/\bbg-white\b/.test(login0))
  for (const [name, path] of [['パスワードの再設定', '/reset-password'], ['メールの確認', '/verify-email'], ['お知らせの確認', '/notice-ack']]) {
    const h = await fetch(BASE + path).then(r => r.text())
    ok(`5) ${name}の画面の HTML に元の色の名前のクラスが無い`, h.includes('bg-neutral-50') && !RAW.test(h) && !/\bbg-white\b/.test(h))
  }
  const adm = await login('sample', 'admin')
  const admin = await fetch(`${BASE}/admin`, { headers: { cookie: adm } }).then(r => r.text())
  ok('5) 管理画面の HTML（左のメニュー）は bg-surface・text-2xs などを使い、元の色の名前を使わない', admin.includes('bg-surface') && admin.includes('text-2xs') && !RAW.test(admin), admin.length)
  const stf = await login('sample', 'st001')
  const staff = await fetch(`${BASE}/staff`, { headers: { cookie: stf } }).then(r => r.text())
  ok('5) スタッフアプリの HTML（下のナビ）に元の色の名前のクラスが無い', staff.includes('nav-item') && !RAW.test(staff), staff.length)
  const hqc = await login('', 'hq')
  const hq = await fetch(`${BASE}/hq`, { headers: { cookie: hqc } }).then(r => r.text())
  ok('5) 本部画面の HTML は bg-hq-900・text-hq-accent-400 を使い、slate・cyan を使わない', hq.includes('bg-hq-900') && hq.includes('text-hq-accent-400') && !RAW.test(hq), hq.length)
  for (const js of ['admin.js', 'staff.js', 'hq.js', 'common.js', 'shift-board.js']) {
    const t = await fetch(`${BASE}/static/${js}`).then(r => r.text())
    ok(`5) 配信している ${js} が置き換え後のもの`, t === readFileSync(join(ROOT, 'public/static', js), 'utf8') || t.replace(/\r\n/g, '\n') === read('public/static/' + js))
  }
} catch (e) {
  served = false
  ok('5) サーバーに接続できる', false, String(e))
}

// ---------- 6) 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!served || !CHROME || typeof WebSocket !== 'function') console.log('SKIP  6) 画面の確認（ヘッドレスの Chrome が見つからないか、サーバーに接続できません）')
else {
  const PORT = await (await import('./lib/chrome.mjs')).freePort()  // 空いているポート（#9980）
  const prof = mkdtempSync(join(tmpdir(), 'w26tok-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  const wait = ms => new Promise(r => setTimeout(r, ms))
  try {
    let list
    for (let i = 0; i < 50 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list.find(t => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.result?.value ?? x.result?.exceptionDetails?.exception?.description }
    await send('Runtime.enable'); await send('Page.enable')
    await send('Page.navigate', { url: `${BASE}/login` }); await wait(1500)
    const cs = (sel, prop) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).getPropertyValue(${JSON.stringify(prop)})`
    const before = await ev(`JSON.stringify({ body: ${cs('body', 'background-color')}, logo: ${cs('.shadow-brand', 'background-color')}, shadow: ${cs('.shadow-brand', 'box-shadow')}, card: ${cs('.rounded-2xl.bg-surface', 'border-radius')}, font: ${cs('body', 'font-family')}, color: ${cs('body', 'color')} })`)
    const b = JSON.parse(before || '{}')
    // 影の前の 2 つ（rgba(0, 0, 0, 0) 0px 0px 0px 0px）は Tailwind の ring の空の値で、トークン化の前から付いている
    ok('6) ログインの画面: 地・ロゴ・影・角丸・文字の色が前と同じ値', b.body === 'rgb(249, 250, 251)' && b.logo === 'rgb(37, 99, 235)' && String(b.shadow).replace(/^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px, )+/, '') === 'rgb(191, 219, 254) 0px 10px 15px -3px, rgb(191, 219, 254) 0px 4px 6px -4px' && b.card === '16px' && /Hiragino Kaku Gothic ProN/.test(b.font) && b.color === 'rgb(0, 0, 0)', b)
    ok('6) tokenColor が :root の色を rgba() で返す', await ev(`tokenColor('primary', .15, 'x') + '|' + tokenColor('primary-600') + '|' + tokenColor('no-such', 1, 'fb')`) === 'rgba(37,99,235,0.15)|rgba(37,99,235,1)|fb')
    // 候補を当てるときと同じように、段の変数の値だけを変えると、クラスで付けた色も共通クラスの色も変わる
    const after = await ev(`(() => { const r = document.documentElement.style; r.setProperty('--color-primary-600', '31 95 175'); r.setProperty('--color-neutral-50', '246 247 249'); r.setProperty('--radius-2xl', '8px');
      return JSON.stringify({ body: ${cs('body', 'background-color')}, logo: ${cs('.shadow-brand', 'background-color')}, card: ${cs('.rounded-2xl.bg-surface', 'border-radius')} }) })()`)
    const a = JSON.parse(after || '{}')
    ok('6) 変数の値を変えるだけで、画面の地・主色・角丸が変わる（候補 A〜G を値の差し替えで当てられる）', a.body === 'rgb(246, 247, 249)' && a.logo === 'rgb(31, 95, 175)' && a.card === '8px', a)
    // 管理画面: 主ボタン（.btn-primary）と左のメニューの選択中
    await send('Network.enable')
    const adm = await login('sample', 'admin')
    const [n, ...v] = adm.split('=')
    await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    await send('Page.navigate', { url: `${BASE}/admin#dashboard` }); await wait(3500)
    const adminCs = await ev(`(() => { const a = document.querySelector('.side-link.active'); const s = document.getElementById('sidebar'); return JSON.stringify({ active: a && getComputedStyle(a).backgroundColor, activeColor: a && getComputedStyle(a).color, side: s && getComputedStyle(s).backgroundColor, border: s && getComputedStyle(s).borderRightColor }) })()`)
    const ac = JSON.parse(adminCs || '{}')
    ok('6) 管理画面: 左のメニューの選択中・メニューの地・区切りの色が前と同じ値', ac.active === 'rgb(239, 246, 255)' && ac.activeColor === 'rgb(29, 78, 216)' && ac.side === 'rgb(255, 255, 255)' && /^rgb\(/.test(ac.border || ''), ac)
    ws.close()
  } catch (e) {
    ok('6) 画面の確認が最後まで流れる', false, String(e))
  } finally {
    chrome.kill()
    await wait(500)
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
