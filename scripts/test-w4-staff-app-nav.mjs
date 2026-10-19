// スタッフアプリの画面遷移・シフト画面・ホームのお知らせの統合テスト（w4-staff-app-nav: #325 #383 #384 #428 #520 ほか）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8820 node scripts/test-w4-staff-app-nav.mjs
// 画面だけの修正（#374 URL と戻る、#336 #562 ログアウト、#421 下書き、#375 リンク、#400 #376 打刻履歴の状態、#409 読み込めないときの表示）は、
// ここではページと静的ファイルの中身だけを確かめる
const BASE = process.env.BASE || 'http://127.0.0.1:8820'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), cookie }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const PFX = 'NV' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(api, k) {
  must(await api.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await api.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function createShift(api, staff_id, project_id, work_date, start_time = '10:00', end_time = '18:00') {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await api.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  const s = must(await api.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
let seq = 0
async function publish(title, extra = {}) {
  must(await admin.post('/api/admin/notices', { title, body: 'テスト本文', target_type: 'all', target_ids: '', client_request_id: `${title}-${++seq}-${Math.random()}`, ...extra }), 'notice ' + title)
  return (await admin.get('/api/admin/notices')).data.notices.find(n => n.title === title)
}

const S1 = await newStaff(admin, 'A')
const st = client(await login('sample', `${PFX}A`))

// ---------- #520 スタッフ向けのシフトは許可リストの列だけを返す ----------
{
  const sid = await createShift(admin, S1.staff_id, 1, today, '09:00', '17:00')
  const act = await admin.put(`/api/admin/shifts/${sid}/actual`, { actual_start: '09:00', actual_end: '17:30', actual_note: `${PFX}残業30分（店長了承）` })
  ok('（前提）精算の実績メモを保存できる', act.status === 200, act)
  const h = must(await st.get('/api/staff/home'), 'home')
  const hs = h.shift || {}
  const banned = ['actual_note', 'actual_start', 'actual_end', 'actual_source', 'settle_status', 'settled_by', 'settled_at', 'registered_by', 'memo', 'unit_price', 'transportation_fee', 'pay_rate', 'bill_rate', 'pay_amount', 'adjust_note', 'price_source', 'payee_type']
  ok('#520 ホームのシフトに精算のメモ・確定の状況・登録者・金額の列が無い', hs.shift_id === sid && banned.every(k => !(k in hs)), Object.keys(hs))
  ok('#520 ホームのシフトに画面で使う列（案件名・時刻・状態）はある', hs.project_name && hs.start_time === '09:00' && hs.end_time === '17:00' && hs.status === 'confirmed', hs)
  ok('#520 ホームのシフトの JSON に実績メモの文字列が含まれない', !JSON.stringify(h).includes(`${PFX}残業30分`))
  const sh = must(await st.get(`/api/staff/shifts?month=${today.slice(0, 7)}`), 'shifts')
  const row = sh.shifts.find(s => s.shift_id === sid) || {}
  ok('#520 シフト一覧も許可リストの列だけ（精算のメモ・登録者・金額が無い）', row.shift_id === sid && banned.every(k => !(k in row)), Object.keys(row))
  ok('#520 シフト一覧の tentative・other_company・company_name は返す', 'tentative' in row && 'other_company' in row && row.company_name, row)
}

// ---------- #428 シフトの期間指定（月をまたぐ・上限） ----------
{
  const d1 = addDays(today, 3), d2 = addDays(today, 20), d3 = addDays(today, 40)
  const a = await createShift(admin, S1.staff_id, 1, d1)
  const b = await createShift(admin, S1.staff_id, 1, d2)
  const c = await createShift(admin, S1.staff_id, 1, d3)
  const r = must(await st.get(`/api/staff/shifts?from=${today}&to=${addDays(today, 13)}`), 'range')
  ok('#428 from/to の期間のシフトだけを返す', r.shifts.some(s => s.shift_id === a) && !r.shifts.some(s => s.shift_id === b) && r.from === today && r.to === addDays(today, 13), { ids: r.shifts.map(s => s.shift_id), from: r.from, to: r.to })
  const r2 = must(await st.get(`/api/staff/shifts?from=${today}&to=${addDays(today, 30)}`), 'range2')
  ok('#428 月をまたいだ期間でも続けて返す', r2.shifts.some(s => s.shift_id === a) && r2.shifts.some(s => s.shift_id === b), r2.shifts.map(s => s.work_date))
  const r3 = must(await st.get(`/api/staff/shifts?from=${today}`), 'range3')
  ok('#428 to を省くと14日分', r3.to === addDays(today, 13), r3.to)
  const r4 = must(await st.get(`/api/staff/shifts?from=${today}&to=${addDays(today, 400)}`), 'range4')
  ok('#428 期間は最大62日に切り詰める', r4.to === addDays(today, 61) && r4.shifts.some(s => s.shift_id === c), r4.to)
  const r5 = must(await st.get(`/api/staff/shifts?month=${today.slice(0, 7)}`), 'month')
  ok('#428 これまでの month の指定も使える', r5.month === today.slice(0, 7) && r5.from === today.slice(0, 7) + '-01', { m: r5.month, f: r5.from })
  // シフト希望も期間で絞る
  must(await st.post('/api/staff/shifts/request', { work_date: d2, start_time: '09:00', end_time: '12:00' }), 'request')
  const r6 = must(await st.get(`/api/staff/shifts?from=${today}&to=${addDays(today, 13)}`), 'range6')
  const r7 = must(await st.get(`/api/staff/shifts?from=${addDays(today, 14)}&to=${addDays(today, 27)}`), 'range7')
  ok('#428 シフト希望も期間で絞る', !r6.requests.some(x => x.work_date === d2) && r7.requests.some(x => x.work_date === d2), { a: r6.requests.length, b: r7.requests.length })
}

// ---------- #325 #384 #383 ホームのお知らせと未読の件数 ----------
{
  const S2 = await newStaff(admin, 'B')
  const st2 = client(await login('sample', `${PFX}B`))
  // 登録より後に公開したお知らせだけが対象（#227）。少し待ってから出す
  await new Promise(r => setTimeout(r, 1100))
  const imp = await publish(`${PFX}重要`, { importance: 'important' })
  const n = []
  for (let i = 0; i < 6; i++) n.push(await publish(`${PFX}通常${i}`))
  const h = must(await st2.get('/api/staff/home'), 'home')
  const before = must(await st2.get('/api/staff/notices?filter=unread'), 'notices').unread_count
  ok('#325 未読の件数はすべてのお知らせで数える（最新5件に限らない）', h.notice_unread_count === before && before >= 7, { home: h.notice_unread_count, list: before })
  ok('#384 新しい通常のお知らせが続いても、未読の重要なお知らせがホームの先頭に固定される', h.notices[0] && h.notices[0].notice_id === imp.notice_id && h.notices[0].pinned === 1, h.notices.map(x => [x.title, x.pinned]))
  ok('#384 固定のほかに新しい順のお知らせも出す', h.notices.length >= 3 && h.notices.slice(1).every(x => !x.pinned), h.notices.map(x => x.title))
  ok('#520 ホームのお知らせに配信先・作成者・本文を返さない', h.notices.every(x => !('target_ids' in x) && !('created_by' in x) && !('body' in x)), h.notices[0])
  const b = must(await st2.get('/api/staff/badges'), 'badges')
  ok('#383 未読の印の API がお知らせと通知の件数を返す', b.notices === before && typeof b.notifications === 'number' && typeof b.notices_other === 'number', b)
  must(await st2.post(`/api/staff/notices/${imp.notice_id}/read`), 'read')
  const h2 = must(await st2.get('/api/staff/home'), 'home2')
  const b2 = must(await st2.get('/api/staff/badges'), 'badges2')
  ok('#384 確認した重要なお知らせは固定から外れる', !h2.notices.some(x => x.pinned), h2.notices.map(x => [x.title, x.pinned]))
  ok('#383 確認すると未読の件数が減る', b2.notices === before - 1 && h2.notice_unread_count === before - 1, { b2, h: h2.notice_unread_count })
  const anon = await fetch(`${BASE}/api/staff/badges`)
  ok('#383 未読の印の API はログインが必要', anon.status === 401, anon.status)
  const adm = await admin.get('/api/staff/badges')
  ok('#383 未読の印の API はスタッフ以外は使えない', adm.status === 403 || adm.status === 401, adm.status)
}

// ---------- 画面（#374 #336 #409 #421 #375） ----------
{
  const page = await fetch(`${BASE}/staff`, { headers: { Cookie: st.cookie } })
  const html = await page.text()
  ok('#336 ヘッダーにログアウトのアイコンを置かない', page.status === 200 && !html.includes('id="logout-btn"'), page.status)
  ok('#383 下のタブの『その他』に未読の印の場所がある', html.includes('id="nav-more-badge"'))
  ok('#409 axios・dayjs を読み込めないときの表示がある', html.includes('__LIB_MISSING'))
  const js = await (await fetch(`${BASE}/static/staff.js`)).text()
  ok('#336 #562 ログアウトはメニューから確認付きで行い、失敗したら表示する', js.includes("delegate('staffLogout'") && js.includes('ログアウトできませんでした'))
  ok('#374 その他の中の画面に URL がある（consult・manual）', /consult: \(\) => renderConsult\(\)/.test(js) && /manual: \(\) => renderManual\(\)/.test(js))
  ok('#421 日報・相談の下書きを保存する', js.includes("draftSave('consult'") && js.includes("'report:' + Number(sh.shift_id)"))
  const prof = await (await fetch(`${BASE}/static/staff-profile.js`)).text()
  ok('#374 マイプロフィール・パスワードの変更も URL で開く', prof.includes('routes.profile') && prof.includes('href="#password"'))
  const att = await (await fetch(`${BASE}/static/staff-attendance.js`)).text()
  ok('#376 #400 打刻履歴は URL で期間とタブを受け、日付を選べる', att.includes("parts[1] === 'timeline'") && att.includes('id="att-to"') && att.includes("parts[1] === 'request'"))
  // linkify を取り出して確かめる（esc 済みの文字列を渡す）
  const esc = (s) => String(s).replace(/[&<>"'`]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[m]))
  const src = js.slice(js.indexOf('const LINKIFY_RE'), js.indexOf('// 読み込みに失敗したときの表示'))
  const linkify = new Function(src + '; return linkify')()
  const a = linkify(esc('詳細は https://example.com/a?b=1&c=2 を見てください。電話 03-1234-5678 / 09012345678'))
  ok('#375 URL をリンクにする（& は実体参照のまま href に入る）', a.includes('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"'), a)
  ok('#375 電話番号を tel: のリンクにする', a.includes('href="tel:0312345678"') && a.includes('href="tel:09012345678"'), a)
  const b = linkify(esc('"https://x.example/"><script>alert(1)</script>'))
  ok('#375 引用符や < を含む文字列でもリンクの外へ抜けない', !b.includes('<script>') && b.includes('href="https://x.example/"'), b)
  const c = linkify(esc('2026-10-19 の 10:00〜 javascript:alert(1)'))
  ok('#375 日付や javascript: はリンクにしない', !c.includes('<a'), c)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
