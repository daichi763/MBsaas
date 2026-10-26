// w10-client-nav（#9303 #9304 #9305）の統合テスト
// クライアント画面の会社基本情報（支店・部門を会社基本情報の中へ、インボイス情報はインボイス番号だけ）と、
// 管理画面の左側のメニューの見出し（並び・開閉・件数の合計・スマホのメニュー）を確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8811 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w10-client-nav.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8811'
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const staticJs = async (name) => (await fetchRetry(`${BASE}/static/${name}`)).text()
const PFX = 'W10N' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

// ---------- #9305 左側のメニューの見出しと並び ----------
const EXPECTED = [
  ['', '', ['dashboard', 'notifications']],
  ['attendance', 'シフト・勤怠', ['shifts', 'reports', 'corrections', 'report-settings', 'attendance-history']],
  ['people', '人材', ['staff', 'employees', 'partners', 'recruit', 'consult', 'follow']],
  ['deals', '案件・取引', ['projects', 'clients', 'board', 'roster-chat']],
  ['money', 'お金', ['settlement', 'billing']],
  ['notices', 'お知らせ', ['notices', 'notice-reports']],
  ['analytics', '分析', ['analytics']],
  ['settings', '設定', ['account', 'security']],
]
function parseSideNav(html) {
  const nav = html.slice(html.indexOf('id="side-nav"'), html.indexOf('</nav>', html.indexOf('id="side-nav"')))
  const parts = nav.split('<div class="nav-group"')
  return parts.map((p, i) => {
    const key = i === 0 ? '' : (p.match(/data-group="([^"]+)"/) || [])[1]
    const label = i === 0 ? '' : (p.match(/<span class="flex-1 text-left">([^<]+)<\/span>/) || [])[1]
    const tabs = [...p.matchAll(/class="side-link[^"]*" data-tab="([^"]+)"/g)].map(m => m[1])
    return [key, label, tabs]
  })
}
function parseMobileNav(html) {
  const a = html.indexOf('<select id="mobile-nav"'), sel = html.slice(a, html.indexOf('</select>', a))
  const head = sel.slice(0, sel.indexOf('<optgroup') < 0 ? sel.length : sel.indexOf('<optgroup'))
  const groups = [['', [...head.matchAll(/<option value="([^"]+)"/g)].map(m => m[1])]]
  for (const m of sel.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)) groups.push([m[1], [...m[2].matchAll(/<option value="([^"]+)"/g)].map(x => x[1])])
  return groups
}
{
  const r = await admin.get('/admin')
  ok('#9305 管理画面を開ける', r.status === 200, r.status)
  const html = r.text
  const side = parseSideNav(html)
  ok('#9305 左側のメニューの見出しと項目の並びが決めたとおり（ダッシュボード・通知の下に、シフト・勤怠／人材／案件・取引／お金／お知らせ／分析／設定）',
    JSON.stringify(side) === JSON.stringify(EXPECTED), side)
  const nav = html.slice(html.indexOf('id="side-nav"'), html.indexOf('</aside>'))
  ok('#9305 メニューの名前は「協力会社」（「取引先」は出さない）', nav.includes('data-tab="partners"><i class="fas fa-handshake w-5"></i>協力会社</a>') && !nav.includes('取引先'))
  ok('#9305 これまでの「勤怠管理」の見出しはなくす', !nav.includes('>勤怠管理<'))
  ok('#9305 見出しは押して開閉するボタン（delegate の navGroupToggle・aria-expanded・aria-controls）',
    (nav.match(/<button type="button" class="nav-group-head" data-action="navGroupToggle" aria-expanded="true" aria-controls="nav-group-[a-z]+">/g) || []).length === 7
    && EXPECTED.slice(1).every(([k]) => nav.includes(`id="nav-group-${k}"`)))
  ok('#9305 見出しの横に件数の合計を出す欄がある（はじめは隠す）', (nav.match(/<span class="nav-group-count hidden"/g) || []).length === 7)
  ok('#9305 未読などのバッジ（通知・打刻修正・応募・掲示板）は項目の中にそのまま残す',
    ['notif-badge', 'corrections-badge', 'recruit-badge', 'board-badge'].every(id => (html.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1))
  ok('#9305 アカウント設定・セキュリティは「設定」の見出しの中（下の欄には伴走支援とログアウトだけ）',
    (html.match(/data-tab="account"/g) || []).length === 1 && (html.match(/class="side-link[^"]*" data-tab="security"/g) || []).length === 1 && html.includes('data-action="hqsOpenSupport"') && html.includes('id="logout-btn"'))
  ok('#9305 イベント属性に値を埋め込まない（メニューに onclick を使わない）', !/<(a|button)[^>]*onclick/.test(nav))
  const mob = parseMobileNav(html)
  const expMob = EXPECTED.map(([, l, tabs]) => [l, tabs])
  ok('#9305 スマホのメニューも同じ見出し・同じ並び（協力会社・セキュリティも選べる）', JSON.stringify(mob) === JSON.stringify(expMob), mob)
  ok('#9305 スマホのメニューも「取引先」ではなく「協力会社」', html.includes('<option value="partners">協力会社</option>'))
  // 項目にある画面は、すべて画面の切り替え（routes）か、他のファイルの登録で開ける
  const a = await staticJs('admin.js'), roster = await staticJs('roster.js'), chat = await staticJs('roster-chat.js')
  ok('#9305 協力会社・企業間チャットの画面の登録はそのまま（roster.js・roster-chat.js）', roster.includes("routes['partners']") && chat.includes("routes['roster-chat']"))

  // 画面のコード（admin.js）
  ok('#9305 開閉の状態は localStorage に覚え、読み書きは try/catch で囲む',
    /function navCollapsedGroups\(\) \{\s*try \{[\s\S]*?localStorage\.getItem\(NAV_COLLAPSED_KEY\)[\s\S]*?\} catch \(e\) \{ return new Set\(\) \}/.test(a)
    && /function saveNavCollapsedGroups\(set\) \{\s*try \{ localStorage\.setItem\(NAV_COLLAPSED_KEY/.test(a))
  ok('#9305 起動時に覚えた状態で見出しを開閉し、押すと切り替えて覚える', a.includes('function initNavGroups()') && a.includes("delegate('navGroupToggle'") && a.includes('saveNavCollapsedGroups(set)'))
  const route = a.slice(a.indexOf('function route() {'), a.indexOf("window.addEventListener('hashchange', route)"))
  ok('#9305 画面を移るたびに、今のページがある見出しを開く', route.includes('openNavGroupOf(tab)'))
  ok('#9305 今のページの見出しは、ハッシュの文字をセレクタに入れずに探す（dataset で比べる）', /function openNavGroupOf\(tab\) \{[\s\S]*?\.find\(el => el\.dataset\.tab === tab\)/.test(a))
  const setCount = a.slice(a.indexOf('window.setNavCount = function'), a.indexOf('// 左側のメニューの見出し（#9305'))
  ok('#9305 件数（NAV_COUNTS）が変わるたびに、見出しの合計を描き直す', setCount.includes('updateNavGroupCounts()') && /function updateNavGroupCounts\(\) \{[\s\S]*?NAV_COUNTS\[el\.dataset\.tab\]/.test(a))
  ok('#9305 スタッフの申請の件数も NAV_COUNTS に入れる（シフト・勤怠の見出しの合計に入る）', /function applyStaffRequestsBadge[\s\S]*?setNavCount\('staff-requests', n\)/.test(a))
  ok('#9305 スマホのヘッダーの合計（打刻修正・応募・掲示板・チャット）はこれまでどおり', a.includes("const NAV_TOTAL_TABS = ['corrections', 'recruit', 'board', 'roster-chat']"))
  ok('#9305 役割での出し分け（従業員管理を扱えないロールは項目を外す）はそのままで、項目のなくなった見出しは隠す',
    a.includes(`document.querySelectorAll('.side-link[data-tab="employees"], #mobile-nav option[value="employees"]').forEach(el => el.remove())`)
    && /hideEmptyNavGroups\(\)\s*route\(\)\s*\}\)\(\)/.test(a))
  ok('#9305 あとから足すメニュー（出勤可能日・スタッフの申請）は、シフト管理・打刻修正承認の下（＝シフト・勤怠の見出しの中）に入る',
    a.includes(`document.querySelector('#side-nav a[data-tab="shifts"]')`) && a.includes(`document.querySelector('.side-link[data-tab="corrections"]')`))
  const css = await (await fetchRetry(`${BASE}/static/style.css`)).text()
  ok('#9305 閉じた見出しは中の項目を隠し、件数の合計は閉じたときだけ出す（style.css）',
    css.includes('.nav-group.collapsed .nav-group-body{display:none}') && css.includes('.nav-group:not(.collapsed) .nav-group-count{display:none}') && css.includes('.nav-group-head{'))
}

// ---------- #9305 役割による出し分けは変えない（現場責任者も同じメニューの HTML で、従業員管理は画面で外す） ----------
{
  const mgr = client(await login('sample', 'mgr01'))
  const r = await mgr.get('/admin')
  const me = must(await mgr.get('/api/auth/me'), 'me')
  ok('#9305 現場責任者も見出し付きのメニューで開ける', r.status === 200 && JSON.stringify(parseSideNav(r.text)) === JSON.stringify(EXPECTED), r.status)
  ok('#9305 現場責任者は従業員管理を扱えない（画面で項目を外す判定に使う can_manage_hr はこれまでどおり）', me.can_manage_hr === false, me.can_manage_hr)
}

// ---------- #9303 #9304 クライアントの会社基本情報 ----------
{
  const cid = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-会社基本情報` }), 'create').client_id
  // 以前の画面で入れた代表者役職・フリガナ
  must(await admin.put(`/api/admin/clients/${cid}`, { representative_title: '代表取締役', representative_kana: 'ヤマダ タロウ', branch_name: '旧支店', department_name: '旧部門' }), 'seed old')
  // 新しい画面の「会社基本情報」の保存と同じ内容（支店・部門を一緒に送り、代表者役職・フリガナは送らない）
  const body = {
    client_name: `${PFX}-会社基本情報`, stream_type: 'upstream', representative_name: '山田 太郎', phone: '03-0000-0000', email: 'a@example.com',
    address: '東京都', client_kind: 'corporation', billing_rule: '月末締め', client_rating: 4, memo: 'メモ',
    branch_name: ' 新宿支店 ', department_name: '営業部', invoice_number: 'T1234567890123',
  }
  let r = await admin.put(`/api/admin/clients/${cid}`, body)
  ok('#9303 会社基本情報の保存で、支店・部門も一緒に保存できる', r.status === 200, r)
  let c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail').client
  ok('#9303 保存した支店・部門が詳細に出る（前後の空白は除く）', c.branch_name === '新宿支店' && c.department_name === '営業部' && c.representative_name === '山田 太郎', c)
  ok('#9304 画面から外した代表者役職・代表者フリガナは、会社基本情報を保存しても消えない', c.representative_title === '代表取締役' && c.representative_kana === 'ヤマダ タロウ', c)
  ok('#9304 インボイス番号は保存できる', c.invoice_number === 'T1234567890123', c.invoice_number)
  r = await admin.put(`/api/admin/clients/${cid}`, { ...body, branch_name: '', department_name: '' })
  c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail2').client
  ok('#9303 支店・部門を空欄で保存すると消える（他の項目はそのまま）', r.status === 200 && c.branch_name === null && c.department_name === null && c.client_kind === 'corporation' && c.representative_title === '代表取締役', c)
  r = await admin.put(`/api/admin/clients/${cid}`, { ...body, branch_name: 'あ'.repeat(101) })
  c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail3').client
  ok('#9303 支店が長すぎるときは 400 で、会社基本情報のほかの項目も変えない', r.status === 400 && /支店/.test(r.data && r.data.error) && c.branch_name === null && c.memo === 'メモ', [r.status, c])

  const a = await staticJs('admin.js')
  const basic = a.slice(a.indexOf('function clientBasicHtml'), a.indexOf('function clientOrgHtml'))
  ok('#9303 支店・部門は会社基本情報の中に表示し、編集も会社基本情報と一緒', basic.includes('${clientOrgHtml(c, false)}') && basic.includes('${clientOrgHtml(c, true)}'))
  const org = a.slice(a.indexOf('function clientOrgHtml'), a.indexOf('// 取引の実績（#345）'))
  ok('#9303 支店・部門は項目だけを返す（見出し・編集ボタン・保存ボタンを持たない）',
    org.includes('>支店</dt>') && org.includes('>部門</dt>') && org.includes("inp('cl-branch', '支店'") && org.includes("inp('cl-department', '部門'") && !org.includes('<h3') && !org.includes('data-action'))
  ok('#9303 支店・部門の独立したカードと、その編集・保存の処理をなくす',
    !a.includes('id="client-org-info"') && !a.includes("delegate('editClientOrg'") && !a.includes("delegate('saveClientOrg'") && !a.includes('cl-org-error'))
  const save = a.slice(a.indexOf('window.saveClientBasicInfo'), a.indexOf('// ============ 社員名簿'))
  ok('#9303 会社基本情報の保存で支店・部門を送る', save.includes("branch_name: v('cl-branch'), department_name: v('cl-department')"))
  ok('#9304 保存で代表者役職・代表者フリガナを送らない（送らなければデータは残る）', !save.includes('representative_title') && !save.includes('representative_kana') && save.includes("invoice_number: v('cl-invoice')"))
  ok('#9304 「代表者・インボイス情報」を「インボイス情報」にし、インボイス番号だけを出す',
    !a.includes('代表者・インボイス情報') && (basic.match(/>インボイス情報</g) || []).length === 2 && !basic.includes('代表者役職') && !basic.includes('代表者フリガナ') && !basic.includes('cl-rep-title') && !basic.includes('cl-rep-kana')
    && basic.includes('インボイス番号'))
  ok('#9304 代表者氏名は会社基本情報に残る（表示と編集）', (basic.match(/代表者氏名/g) || []).length === 2 && basic.includes("inp('cl-rep-name'"))
  const detail = a.slice(a.indexOf('async function renderClientDetail'), a.indexOf('// 月を切り替えたら、取引の実績の欄だけを取り直す'))
  ok('#9303 詳細画面は会社基本情報・顧客担当者・取引の実績の順のまま', detail.indexOf('id="client-basic-info"') > 0 && detail.indexOf('client-contacts-list') > detail.indexOf('id="client-basic-info"') && detail.indexOf('id="client-deals"') > detail.indexOf('client-contacts-list'))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
