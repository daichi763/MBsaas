// 案件掲示板: 都道府県の複数選択・全国（#9992）、スキルの部分一致（#9993）、稼働日の見出し・エリア欄の自動入力（#9994）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 9020 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:9020 PERSIST=<保存先> node scripts/test-w32-board-pref.mjs
//   PERSIST を指定すると、ローカルの D1 を直接書き換える確認（移行前の形の行・全角で保存された古い行・新着の通知）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9020'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w32board-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out).at(-1).results
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = String(Date.now()).slice(-6)
const TAG = `W32BP${SUF}`

// ---------- 準備: 掲載企業 A（sample）と、検索条件を保存する企業 B（本部で登録） ----------
const A_COOKIE = await login('sample', 'admin')
const A = client(A_COOKIE)
const hq = client((await rawLogin('', 'hq')).cookie)
const coCode = `w32bp${SUF}`
const created = must(await hq.post('/api/hq/companies', { company_code: coCode, company_name: `W32BP 検索社${SUF}`, admin_code: 'boss', admin_name: '検索 太郎', admin_email: `w32bp${SUF}@example.com` }), 'company')
const tmpB = client(await login(coCode, 'boss', created.admin_temp_password))
must(await tmpB.post('/api/auth/change-password', { current_password: created.admin_temp_password, new_password: 'boss-pass-1' }), 'change password')
const B = client(await login(coCode, 'boss', 'boss-pass-1'))

const spot = (title, extra = {}) => ({ status: 'open', engagement_type: 'spot', title: `${TAG} ${title}`, date_from: addDays(today, 20), time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 1, ...extra })
const detail = async (id) => must(await A.get(`/api/admin/board/posts/${id}`), 'detail').post
const search = async (params) => {
  const sp = new URLSearchParams({ scope: 'open', engagement_type: 'spot', q: TAG, ...params })
  return must(await B.get(`/api/admin/board/posts?${sp}`), 'search').posts.map(p => p.title.replace(`${TAG} `, ''))
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// ---------- #9992 都道府県の複数選択・全国 ----------
const multi = must(await A.post('/api/admin/board/posts', spot('東京神奈川', { prefectures: ['神奈川県', '東京都', '東京都'], required_skills: 'MNP獲得,光回線' })), 'multi').post_id
{
  const p = await detail(multi)
  ok('#9992 都道府県を複数選んで掲載できる（重複を除き、47都道府県の順に並べる）', same(p.prefecture_list, ['東京都', '神奈川県']) && p.prefecture_list[0] === '東京都' && p.prefectures === ',東京都,神奈川県,', p)
  ok('#9992 prefecture 列には先頭の1つを入れる（今それを読んでいる所のため）', p.prefecture === '東京都', p.prefecture)
}
const zenkoku = must(await A.post('/api/admin/board/posts', spot('全国', { prefectures: ['全国', '大阪府'], required_skills: 'ｍｎｐ' })), 'zenkoku').post_id
{
  const p = await detail(zenkoku)
  ok('#9992 全国を選んだら全国だけになる（個別の都道府県は外す）', same(p.prefecture_list, ['全国']) && p.prefecture === '全国' && p.prefectures === ',全国,', p)
}
const osaka = must(await A.post('/api/admin/board/posts', spot('大阪', { prefecture: '大阪府', required_skills: '光回線' })), 'osaka').post_id
{
  const p = await detail(osaka)
  ok('#9992 前の形（prefecture だけ）で送っても保存できる', same(p.prefecture_list, ['大阪府']) && p.prefectures === ',大阪府,', p)
}
{
  const bad = await A.post('/api/admin/board/posts', spot('不正', { prefectures: ['東京'] }))
  ok('#9992 知らない都道府県名は 400', bad.status === 400 && /都道府県/.test(bad.data?.error || ''), bad)
  const bad2 = await A.post('/api/admin/board/posts', spot('不正2', { prefecture: 'Tokyo' }))
  ok('#9992 前の形でも知らない名前は 400', bad2.status === 400, bad2)
  const none = await A.post('/api/admin/board/posts', spot('勤務地なし', { prefectures: [] }))
  ok('#9992 都道府県もエリアもなければ掲載できない（400）', none.status === 400 && /勤務地/.test(none.data?.error || ''), none)
  const areaOnly = await A.post('/api/admin/board/posts', spot('エリアだけ', { prefectures: [], area: '新宿区' }))
  ok('#9992 エリアだけでも掲載できる', areaOnly.status === 200, areaOnly)
  const draft = await A.post('/api/admin/board/posts', spot('下書き', { status: 'draft', prefectures: [] }))
  ok('#9992 下書きは都道府県なしでも保存できる', draft.status === 200, draft)
}
{
  const tokyo = await search({ prefecture: '東京都' })
  ok('#9992 東京都で絞ると、東京都を含む掲載と全国の掲載が出る（大阪は出ない）', tokyo.includes('東京神奈川') && tokyo.includes('全国') && !tokyo.includes('大阪'), tokyo)
  const kana = await search({ prefecture: '神奈川県' })
  ok('#9992 2つ目に選んだ都道府県（神奈川県）でも出る', kana.includes('東京神奈川') && kana.includes('全国') && !kana.includes('大阪'), kana)
  const osk = await search({ prefecture: '大阪府' })
  ok('#9992 大阪府で絞ると、大阪と全国が出る（東京神奈川は出ない）', osk.includes('大阪') && osk.includes('全国') && !osk.includes('東京神奈川'), osk)
  const hok = await search({ prefecture: '北海道' })
  ok('#9992 どれにも当たらない都道府県では全国だけが出る', same(hok, ['全国']), hok)
}
{
  must(await A.put(`/api/admin/board/posts/${multi}`, { prefectures: ['埼玉県'] }), 'edit multi')
  const p = await detail(multi)
  ok('#9992 編集で都道府県を選び直せる', same(p.prefecture_list, ['埼玉県']) && p.prefecture === '埼玉県', p)
  const tokyo = await search({ prefecture: '東京都' })
  ok('#9992 選び直した後は、外した都道府県の絞り込みに出ない', !tokyo.includes('東京神奈川'), tokyo)
  must(await A.put(`/api/admin/board/posts/${multi}`, { prefecture: '千葉県' }), 'edit legacy')
  ok('#9992 前の形（prefecture だけ）の編集は、その1つに置き換える', same((await detail(multi)).prefecture_list, ['千葉県']))
  must(await A.put(`/api/admin/board/posts/${multi}`, { title: `${TAG} 東京神奈川` }), 'edit other')
  ok('#9992 都道府県を送らない編集では、都道府県はそのまま', same((await detail(multi)).prefecture_list, ['千葉県']))
  must(await A.put(`/api/admin/board/posts/${multi}`, { prefectures: ['東京都', '神奈川県'] }), 'edit back')
  const bad = await A.put(`/api/admin/board/posts/${multi}`, { prefectures: ['東京都', '東京市'] })
  ok('#9992 編集でも知らない都道府県名は 400（保存しない）', bad.status === 400 && same((await detail(multi)).prefecture_list, ['東京都', '神奈川県']), bad)
}
{
  const list = must(await A.get(`/api/admin/board/posts?scope=mine&engagement_type=spot&q=${encodeURIComponent(TAG)}`), 'mine').posts
  const m = list.find(p => p.post_id === multi)
  ok('#9992 一覧にも都道府県の並び（prefecture_list）を返す', m && same(m.prefecture_list, ['東京都', '神奈川県']), m)
}

// 移行（0117）前の形の行: prefectures が空で prefecture だけがある
if (PERSIST) {
  const co = sql(`SELECT company_id FROM companies WHERE company_code = 'sample'`)[0].company_id
  sql(`INSERT INTO board_posts (company_id, engagement_type, title, prefecture, prefectures, date_from, time_from, time_to, headcount, required_skills, price_amount, price_unit, status, published_at, created_at, updated_at)
    VALUES (${co}, 'spot', ${q(`${TAG} 古い福岡`)}, '福岡県', NULL, '${addDays(today, 20)}', '10:00', '18:00', 1, 'ＭＮＰ', 10000, 'daily', 'open', datetime('now', '+9 hours'), datetime('now', '+9 hours'), datetime('now', '+9 hours'))`)
  const fk = await search({ prefecture: '福岡県' })
  ok('#9992 移行前の形の行（prefecture だけ）も、その都道府県の絞り込みで出る', fk.includes('古い福岡') && fk.includes('全国'), fk)
  const oldId = sql(`SELECT post_id FROM board_posts WHERE title = ${q(`${TAG} 古い福岡`)}`)[0].post_id
  ok('#9992 移行前の形の行も、詳細で都道府県の並びを返す', same((await detail(oldId)).prefecture_list, ['福岡県']))
  // マイグレーションの移しの文（0117 の UPDATE）をそのまま流す
  const mig = readFileSync(new URL('../migrations/0117_board_prefectures.sql', import.meta.url), 'utf8')
  const upd = mig.split('\n').find(l => /^UPDATE board_posts SET prefectures/.test(l))
  sql(upd)
  const row = sql(`SELECT prefecture, prefectures FROM board_posts WHERE post_id = ${oldId}`)[0]
  ok('#9992 マイグレーションの移しで、prefecture が prefectures（,福岡県,）に入る', row.prefectures === ',福岡県,' && row.prefecture === '福岡県', row)
  const fk2 = await search({ prefecture: '福岡県' })
  ok('#9992 移した後も検索で出る', fk2.includes('古い福岡'), fk2)
  // 全角のまま保存された古い行（ＭＮＰ）も、半角の検索語で拾う（#9993）
  const mnpOld = await search({ skill: 'MNP' })
  ok('#9993 全角で保存された古い掲載（ＭＮＰ）も「MNP」で出る', mnpOld.includes('古い福岡'), mnpOld)
  sql(`UPDATE board_posts SET status = 'closed' WHERE post_id = ${oldId}`)
} else { skip('#9992 移行前の形の行'); skip('#9993 全角で保存された古い掲載') }

// ---------- #9993 スキルの部分一致 ----------
{
  const z = await detail(zenkoku)
  ok('#9993 掲載のスキルは NFKC にして保存する（ｍｎｐ → mnp）', z.required_skills === 'mnp', z.required_skills)
  const mnp = await search({ skill: 'MNP' })
  ok('#9993 「MNP」で「MNP獲得」と「ｍｎｐ」（全角・小文字）の掲載が出る', mnp.includes('東京神奈川') && mnp.includes('全国') && !mnp.includes('大阪'), mnp)
  const wide = await search({ skill: 'ＭＮＰ' })
  ok('#9993 全角の「ＭＮＰ」で検索しても同じ掲載が出る', wide.includes('東京神奈川') && wide.includes('全国') && !wide.includes('大阪'), wide)
  const part = await search({ skill: '回線' })
  ok('#9993 スキルの一部（回線）で「光回線」の掲載が出る', part.includes('東京神奈川') && part.includes('大阪') && !part.includes('全国'), part)
  const both = await search({ skill: '光 MNP' })
  ok('#9993 「光 MNP」（空白で区切る）で、両方を含む掲載だけが出る', same(both, ['東京神奈川']), both)
  const both2 = await search({ skill: '光　ｍｎｐ' })
  ok('#9993 全角の空白で区切っても同じ', same(both2, ['東京神奈川']), both2)
  const pct = await search({ skill: '%' })
  ok('#9993 「%」は文字として扱う（すべての掲載にはならない）', pct.length === 0, pct)
  const combo = await search({ skill: 'MNP', prefecture: '東京都' })
  ok('#9993 都道府県とスキルを合わせて絞れる', same(combo, ['東京神奈川', '全国']), combo)
  const kw = await search({ q: `${TAG} 大阪` })
  ok('#9993 キーワードの検索は今までどおり（部分一致の1語）', same(kw, ['大阪']), kw)
}

// ---------- 保存した検索条件（#479 の照合を #9992・#9993 に合わせる） ----------
{
  const sv = await B.post('/api/admin/board/saved-searches', { engagement_type: 'spot', prefecture: '東京都', skill: '光　ＭＮＰ', date: addDays(today, 20), q: TAG })
  ok('#9993 保存した条件のスキルは、半角の空白で区切った形にする', sv.status === 200 && must(await B.get('/api/admin/board/saved-searches'), 'l').searches.find(s => s.search_id === sv.data.search_id)?.conditions.skill === '光 MNP', sv)
  ok('#9994 名前を付けないときの名前に「稼働日 YYYY/MM/DD」「スキル」の見出しを付ける', sv.status === 200 && sv.data.name.includes(`稼働日 ${addDays(today, 20).replace(/-/g, '/')}`) && sv.data.name.includes('スキル 光 MNP'), sv.data)
  const bad = await B.post('/api/admin/board/saved-searches', { prefecture: '東京' })
  ok('#9992 保存する条件の知らない都道府県名は 400', bad.status === 400, bad)
  must(await B.del(`/api/admin/board/saved-searches/${sv.data.search_id}`), 'del')
}
if (PERSIST) {
  // 東京都 × mnp（小文字）で保存。全国の掲載・東京都を含む掲載で、スキルの一部が合うものが新着として知らせる
  const s1 = must(await B.post('/api/admin/board/saved-searches', { engagement_type: 'spot', prefecture: '東京都', skill: 'mnp', q: TAG, name: `${TAG} 東京MNP` }), 's1')
  const s2 = must(await B.post('/api/admin/board/saved-searches', { engagement_type: 'spot', skill: '光 MNP', q: TAG, name: `${TAG} 光とMNP` }), 's2')
  sql(`UPDATE board_saved_searches SET last_checked_at = '${addDays(today, -1)} 00:00:00' WHERE search_id IN (${Number(s1.search_id)}, ${Number(s2.search_id)})`)
  must(await B.get('/api/admin/board/unread-count'), 'unread-count')
  const ns = must(await B.get('/api/admin/notifications?kind=board_saved_search'), 'notifications').notifications
  const body = ns[0]?.body || ''
  const line = (name) => body.split('\n').find(l => l.startsWith(`「${name}」`)) || ''
  const l1 = line(`${TAG} 東京MNP`), l2 = line(`${TAG} 光とMNP`)
  ok('#9992 新着の通知: 東京都の条件に、東京都を含む掲載と全国の掲載が合う（大阪は合わない）',
    l1.includes(`${TAG} 東京神奈川`) && l1.includes(`${TAG} 全国`) && !l1.includes(`${TAG} 大阪`) && /\s2件:/.test(l1), body)
  ok('#9993 新着の通知: スキルは部分一致で、空白で区切った語はすべてを含む掲載だけが合う', l2.includes(`${TAG} 東京神奈川`) && !l2.includes(`${TAG} 全国`) && !l2.includes(`${TAG} 大阪`) && /\s1件:/.test(l2), body)
  // 壊れた形のスキル（"・\ を含む）が保存されていても、通知の処理が止まらない
  sql(`UPDATE board_saved_searches SET skill = 'a"b\\c', last_checked_at = '${addDays(today, -1)} 00:00:00' WHERE search_id = ${Number(s2.search_id)}`)
  const r = await B.get('/api/admin/board/unread-count')
  ok('#9993 記号を含むスキルの条件でも、通知の確認が失敗しない', r.status === 200, r)
  must(await B.del(`/api/admin/board/saved-searches/${s1.search_id}`), 'del s1')
  must(await B.del(`/api/admin/board/saved-searches/${s2.search_id}`), 'del s2')
} else skip('#9992 #9993 新着の通知の照合')

// ---------- #9994 画面: 稼働日の見出し・エリア欄の自動入力・都道府県の選び方 ----------
{
  const js = await (await fetch(`${BASE}/static/board.js`)).text()
  const tag = (id) => (js.match(new RegExp(`<input id="${id}"[^>]*>`)) || [''])[0]
  ok('#9994 絞り込みの稼働日の欄に、見える見出し「稼働日」がある', /稼働日 <span[^>]*>（この日に稼働）<\/span><\/span>\s*<input id="bf-date"/.test(js))
  ok('#9994 絞り込みのほかの欄にも見出しがある', ['都道府県', 'エリア・駅', 'スキル', 'キーワード'].every(l => js.includes(`<span class="\${FL}">${l}`)))
  ok('#9994 エリア・最寄駅・検索のエリアの欄は autocomplete="off"（連絡先の自動入力を出しにくく）', ['bp-area', 'bp-station', 'bf-area'].every(id => /autocomplete="off"/.test(tag(id)) && /name="[a-z-]*search[a-z-]*"/.test(tag(id))), ['bp-area', 'bp-station', 'bf-area'].map(tag))
  ok('#9992 掲載の都道府県は1つを選ぶ select ではなく、複数選べる画面（全国あり）', !/<select id="bp-pref"/.test(js) && /id="bp-pref-all"/.test(js) && js.includes('全国（場所を問わない）') && /prefectures: formPrefs/.test(js))
  ok('#9992 一覧のカードは都道府県が多いとき「ほか N」にまとめる', /placeText\(p, 3\)/.test(js) && /ほか\$\{l\.length - max\}/.test(js))
  ok('#9992 都道府県の選択はイベント属性に値を埋め込まない（data-* と delegate）', !/onclick="[^"]*(boardPref|bp-pref)/.test(js) && /data-action="boardPrefRemove" data-pref="\$\{esc\(x\)\}"/.test(js))
}

// ---------- 画面（ヘッドレスの Chrome がある環境だけ。CHROME=<chrome.exe のパス>。SHOT_DIR を付けると写真を残す） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w32bp-ui-'))
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
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    let curW = 1280
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w32-board-${name}-${curW}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const setWidth = (w) => { curW = w; return send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 }) }
    const noHScroll = async (label) => { const p = await ev(`(() => { const s = document.scrollingElement; return { sw: s.scrollWidth, cw: document.documentElement.clientWidth } })()`); ok(label, p && p.sw <= p.cw + 1, p) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    await send('Network.clearBrowserCookies')
    const [cn, ...cv] = A_COOKIE.split('='); await send('Network.setCookie', { name: cn, value: cv.join('='), url: BASE })
    await A.put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup'].map(key => ({ key, status: 'skipped', step: 0 })) })
    for (const w of [1280, 390]) {
      errors = []
      await setWidth(w)
      // 一覧: 絞り込みの欄の見出し
      await send('Page.navigate', { url: `${BASE}/admin#board` })
      const drawn = await until(`!!document.getElementById('bf-date') && !!document.querySelector('#board-list .board-card, #board-list .card')`)
      ok(`画面 ${w}px: 掲示板の一覧が描ける`, drawn)
      if (!drawn) continue
      const lab = await ev(`(() => { const d = document.getElementById('bf-date'), l = d.closest('label'), s = l && l.querySelector('span'); const r = s && s.getBoundingClientRect(); return { text: s ? s.textContent.trim() : '', visible: !!r && r.width > 0 && r.height > 0 && getComputedStyle(s).display !== 'none', above: !!r && r.bottom <= d.getBoundingClientRect().top + 1 } })()`)
      ok(`画面 ${w}px: 稼働日の欄の上に、見える見出し「稼働日（この日に稼働）」が出る`, lab && /^稼働日/.test(lab.text) && lab.text.includes('この日に稼働') && lab.visible && lab.above, lab)
      await noHScroll(`画面 ${w}px: 一覧のページが横にスクロールしない`)
      await shot('list')
      // 東京都で絞ると全国の掲載も出る（画面から）
      await ev(`__boardSet('eng', 'spot'); true`); await wait(300); await until(`!!document.getElementById('bf-pref') && !document.querySelector('#board-list .spin')`)
      await ev(`document.getElementById('bf-pref').value = '東京都'; document.getElementById('bf-q').value = ${JSON.stringify(TAG)}; __boardSearch(); true`)
      await until(`[...document.querySelectorAll('#board-list .board-card')].some(a => a.textContent.includes('全国'))`)
      const cards = await ev(`[...document.querySelectorAll('#board-list .board-card')].map(a => a.querySelector('h3').textContent + '|' + a.querySelector('.fa-location-dot').parentElement.textContent.trim())`)
      ok(`画面 ${w}px: 東京都で絞ると、東京都を含む掲載（東京都・神奈川県）と全国の掲載が出る`, Array.isArray(cards) && cards.some(c => c.includes('東京神奈川|東京都・神奈川県')) && cards.some(c => c.includes(`${TAG} 全国|全国`)), cards)
      await ev(`__boardClear(); true`)

      // 新規: 都道府県を選ぶ画面（全国・地方ごと）
      await send('Page.navigate', { url: `${BASE}/admin#board/new` })
      ok(`画面 ${w}px: 掲載の画面が描ける`, await until(`!!document.getElementById('bp-pref-open')`))
      await ev(`document.getElementById('bp-pref-open').click(); true`)
      ok(`画面 ${w}px: 都道府県を選ぶ画面が開く（47都道府県と全国）`, await until(`document.querySelectorAll('#bp-pref-modal .bp-pref-cb').length === 47 && !!document.getElementById('bp-pref-all')`))
      await ev(`(() => { const r = [...document.querySelectorAll('#bp-pref-modal .bp-pref-region')].find(x => x.textContent.includes('関東')); r.querySelector('[data-action=boardPrefRegion]').click(); return true })()`)
      const kanto = await ev(`[...document.querySelectorAll('#bp-pref-modal .bp-pref-cb:checked')].map(x => x.value).join(',') + '|' + document.getElementById('bp-pref-count').textContent`)
      ok(`画面 ${w}px: 「まとめて選ぶ」で関東の7都県を選べる`, kanto === '茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県|7件の都道府県を選んでいます', kanto)
      await shot('pref-modal')
      await ev(`document.getElementById('bp-pref-all').click(); true`)
      const allSt = await ev(`({ checked: document.querySelectorAll('#bp-pref-modal .bp-pref-cb:checked').length, disabled: [...document.querySelectorAll('#bp-pref-modal .bp-pref-cb')].every(x => x.disabled) })`)
      ok(`画面 ${w}px: 全国を選ぶと、都道府県のチェックが外れて選べなくなる`, allSt && allSt.checked === 0 && allSt.disabled, allSt)
      await ev(`document.getElementById('bp-pref-all').click(); true`)
      await ev(`['東京都', '大阪府'].forEach(v => document.querySelector('#bp-pref-modal .bp-pref-cb[value="' + v + '"]').click()); document.getElementById('bp-pref-apply').click(); true`)
      const chips = await ev(`[...document.querySelectorAll('#bp-pref .bp-pref-chip')].map(x => x.textContent.trim()).join(',')`)
      ok(`画面 ${w}px: 決定すると、選んだ都道府県がチップで並ぶ`, chips === '東京都,大阪府', chips)
      await ev(`document.querySelector('#bp-pref [data-action=boardPrefRemove][data-pref="大阪府"]').click(); true`)
      ok(`画面 ${w}px: チップの ✕ で外せる`, await ev(`[...document.querySelectorAll('#bp-pref .bp-pref-chip')].map(x => x.dataset.pref).join(',') === '東京都'`))
      const ac = await ev(`['bp-area', 'bp-station'].map(id => document.getElementById(id).getAttribute('autocomplete')).join(',')`)
      ok(`画面 ${w}px: エリア・最寄駅の欄は autocomplete="off"`, ac === 'off,off', ac)
      await noHScroll(`画面 ${w}px: 掲載の画面が横にスクロールしない`)
      await shot('form')
      // 下書き保存で、選んだ都道府県が保存される
      const title = `${TAG} 画面${w}`
      await ev(`document.getElementById('bp-title').value = ${JSON.stringify(title)}; document.getElementById('bp-price').value = '10000'; document.getElementById('bp-save-draft').click(); true`)
      ok(`画面 ${w}px: 下書きを保存できる`, await until(`/^#board\\/\\d+$/.test(location.hash) && !!document.getElementById('board-detail')`))
      const pid = Number(await ev(`location.hash.slice(7)`))
      const saved = pid ? await detail(pid) : null
      ok(`画面 ${w}px: 画面で選んだ都道府県で保存される`, saved && same(saved.prefecture_list, ['東京都']) && saved.title === title, saved)
      // 編集: 今の都道府県がチップで出る
      await send('Page.navigate', { url: `${BASE}/admin#board/${multi}-edit` })
      await until(`!!document.querySelector('#bp-pref .bp-pref-chip')`)
      const editChips = await ev(`[...document.querySelectorAll('#bp-pref .bp-pref-chip')].map(x => x.dataset.pref).join(',')`)
      ok(`画面 ${w}px: 編集の画面で、保存した都道府県がチップで出る`, editChips === '東京都,神奈川県', editChips)
      ok(`画面 ${w}px: スクリプトのエラーがない`, errors.length === 0, errors)
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
if (failed.length) process.exit(1)
