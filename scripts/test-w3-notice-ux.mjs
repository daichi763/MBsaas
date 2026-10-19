// w3-notice-ux（#191 #203 #333 #334 #368 #370 #455 #553 と、w2-notice-read からの持ち越し #227 #245 #335）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8828 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定すると、notice_targets の展開と、公開から2年たったお知らせ（#245）も確かめる（テスト用の DB 専用）。
// 実行: BASE=http://127.0.0.1:8828 PERSIST=<保存先> node scripts/test-w3-notice-ux.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8828'
const PERSIST = process.env.PERSIST || ''
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
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nowJst = () => new Date(Date.now() + 9 * 3600 * 1000)
const today = nowJst().toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tag = Date.now().toString(36).slice(-5)
const PW = 'Nu-Passw0rd-' + tag
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }

const admin = client(await login('sample', 'admin'))
const adminList = async (q = '') => (await admin.get('/api/admin/notices' + q)).data
const noticeByTitle = async (title) => (await adminList(`?q=${encodeURIComponent(title)}`)).notices.find(n => n.title === title)
async function publish(title, extra = {}) {
  must(await admin.post('/api/admin/notices', { title, body: 'テスト本文', target_type: 'all', target_ids: '', client_request_id: `${title}-${Math.random()}`, ...extra }), 'notice ' + title)
  return noticeByTitle(title)
}
async function newStaff(suffix) {
  const code = `nu${tag}${suffix}`
  must(await admin.post('/api/admin/staff', { user_code: code, name: `お知らせUX${tag}${suffix}`, password: PW }), 'staff ' + suffix)
  const list = (await admin.get('/api/admin/staff')).data
  const row = (list.staff || list).find(s => s.name === `お知らせUX${tag}${suffix}`)
  return { ...row, code, api: client(await login('sample', code, PW)) }
}
const staffNotices = async (s, q = '') => (await s.api.get('/api/staff/notices' + q)).data

// ---------- 前提: スタッフ2人と、新しい案件 ----------
const a = await newStaff('a'), b = await newStaff('b')
const cl = (await admin.get('/api/admin/clients')).data.clients[0]
must(await admin.post('/api/admin/projects', { project_name: `お知らせUX案件${tag}`, client_id: cl.client_id, location: '店舗', unit_price: 10000 }), 'project')
const proj = (await admin.get('/api/admin/projects')).data.projects.find(p => p.project_name === `お知らせUX案件${tag}`)
must(await admin.post('/api/admin/shifts', { staff_id: a.staff_id, project_id: proj.project_id, work_date: addDays(today, 2), start_time: '10:00', end_time: '19:00', status: 'confirmed', memo: 'NU' }), 'shift a')
must(await admin.post('/api/admin/shifts', { staff_id: b.staff_id, project_id: proj.project_id, work_date: addDays(today, 2), start_time: '10:00', end_time: '19:00', status: 'requested', memo: 'NU' }), 'shift b')

// ---------- 配信の検証（POST /admin/notices の項目） ----------
{
  const bad1 = await admin.post('/api/admin/notices', { title: `不正${tag}`, target_type: 'everyone' })
  const bad2 = await admin.post('/api/admin/notices', { title: `不正${tag}`, importance: 'top' })
  const bad3 = await admin.post('/api/admin/notices', { title: `不正${tag}`, target_type: 'project', target_ids: '999999' })
  const bad4 = await admin.post('/api/admin/notices', { title: `不正${tag}`, target_type: 'project', target_ids: '' })
  ok('配信対象・重要度の値と、自社でない案件・空の案件指定を拒否する（400）', [bad1, bad2, bad3, bad4].every(r => r.status === 400), [bad1, bad2, bad3, bad4].map(r => r.status))
}

// ---------- #370 #335 #455 案件あて: notice_targets で判定し、本人の案件名を返す ----------
const pn = await publish(`案件あて${tag}`, { target_type: 'project', target_ids: ` ${proj.project_id} ` })
ok('#370 案件あての配信先は「1,2,3」の形にそろえて保存する', pn && pn.target_ids === String(proj.project_id), pn && pn.target_ids)
if (PERSIST) {
  const [rows] = d1(`SELECT target_type, target_id FROM notice_targets WHERE notice_id = ${pn.notice_id}`)
  ok('#370 notices の追加で notice_targets に配信先が展開される（トリガー）', rows.length === 1 && rows[0].target_type === 'project' && rows[0].target_id === proj.project_id, rows)
  await waitServer()
}
ok('#335 案件あての対象は確定シフトのある人だけ（1名）', pn.staff_total === 1, pn)
{
  const la = await staffNotices(a), lb = await staffNotices(b)
  const na = la.notices.find(n => n.notice_id === pn.notice_id)
  ok('#335 確定シフトのある人の一覧には出る（希望（仮）だけの人には出ない）', na && !lb.notices.some(n => n.notice_id === pn.notice_id), [!!na, lb.notices.map(n => n.notice_id)])
  ok('#455 案件あてのお知らせに案件名を返す', na && na.project_names === proj.project_name && na.target_type === 'project', na)
  ok('スタッフには配信先の ID・作成者を返さない', na && !('target_ids' in na) && !('created_by' in na), na && Object.keys(na))
  const home = (await a.api.get('/api/staff/home')).data
  ok('#370 ホームのお知らせも同じ判定で出る（案件名つき）', (home.notices || []).some(n => n.notice_id === pn.notice_id && n.project_names === proj.project_name), home.notices)
}

// ---------- #368 管理画面の一覧: 配信先の案件名・配信した人・絞り込み・ページ送り ----------
{
  ok('#368 一覧に配信先の案件名と配信した人を返す', pn.target_names === proj.project_name && !!pn.created_by_name, [pn.target_names, pn.created_by_name])
  const byProject = await adminList(`?project_id=${proj.project_id}`)
  ok('#368 配信先の案件で絞り込める', byProject.notices.length >= 1 && byProject.notices.every(n => n.target_type === 'project' && String(n.target_ids).split(',').includes(String(proj.project_id))), byProject.notices.map(n => n.notice_id))
  const byWord = await adminList(`?q=${encodeURIComponent('案件あて' + tag)}`)
  ok('#368 キーワードで絞り込める', byWord.notices.length === 1 && byWord.notices[0].notice_id === pn.notice_id, byWord.notices.map(n => n.title))
  const p0 = await adminList(''), p1 = await adminList('?offset=1')
  ok('#368 ページ送り（offset）と has_more を返す', typeof p0.has_more === 'boolean' && p1.offset === 1 && p1.notices[0] && p1.notices[0].notice_id === p0.notices[1].notice_id, [p0.notices.slice(0, 2).map(n => n.notice_id), p1.notices.slice(0, 1).map(n => n.notice_id)])
  const pct = await adminList(`?q=${encodeURIComponent('100%')}`)
  ok('#368 キーワードの % は文字として扱う（全件に一致しない）', pct.notices.every(n => (n.title + n.body).includes('100%')), pct.notices.length)
}

// ---------- #553 #191 一覧の並び（未読の緊急・必須が先）とまとめて確認 ----------
const n1 = await publish(`通常${tag}`)
const n2 = await publish(`通常2${tag}`)
const urgent = await publish(`緊急${tag}`, { importance: 'urgent' })
const required = await publish(`必須${tag}`, { read_required: true })
{
  const l = await staffNotices(a)
  const ids = l.notices.map(n => n.notice_id)
  const firstTwo = ids.slice(0, 2)
  ok('#191 #553 未読の緊急・既読確認必須のお知らせが一覧の先頭に来る', firstTwo.includes(urgent.notice_id) && firstTwo.includes(required.notice_id), ids.slice(0, 5))
  ok('#553 未読の件数を返す', l.unread_count >= 5, l.unread_count)
  const rq = l.notices.find(n => n.notice_id === required.notice_id), ur = l.notices.find(n => n.notice_id === urgent.notice_id)
  ok('#191 既読確認必須・緊急の値を返す', rq && rq.read_required === 1 && ur && ur.importance === 'urgent', [rq, ur])
  const r = await a.api.post('/api/staff/notices/read-all', { ids: [n1.notice_id, n2.notice_id, urgent.notice_id, required.notice_id] })
  ok('#553 まとめて確認は、緊急・必須を除いて既読にする', r.status === 200 && r.data.read.length === 2 && r.data.read.includes(n1.notice_id) && r.data.read.includes(n2.notice_id) && r.data.skipped === 2, r.data)
  const unread = await staffNotices(a, '?filter=unread')
  ok('#553 未読のみの表示: 緊急・必須は未読のまま、まとめて確認したものは出ない', unread.notices.some(n => n.notice_id === urgent.notice_id) && !unread.notices.some(n => n.notice_id === n1.notice_id) && unread.notices.every(n => !n.is_read), unread.notices.map(n => n.notice_id))
  const other = await b.api.post('/api/staff/notices/read-all', { ids: [pn.notice_id] })
  ok('#553 まとめて確認でも、配信対象でないお知らせは既読にしない', other.status === 200 && other.data.read.length === 0, other.data)
}

// ---------- #333 #334 個別画面と「確認しました」 ----------
{
  const d = await a.api.get(`/api/staff/notices/${required.notice_id}`)
  ok('#333 個別のお知らせを取得できる', d.status === 200 && d.data.notice.notice_id === required.notice_id && d.data.notice.is_read === 0, d)
  const nd = await b.api.get(`/api/staff/notices/${pn.notice_id}`)
  ok('#333 配信対象でないお知らせは 404', nd.status === 404, nd)
  const r = await a.api.post(`/api/staff/notices/${required.notice_id}/read`)
  const d2 = await a.api.get(`/api/staff/notices/${required.notice_id}`)
  ok('#334 「確認しました」で既読になり、既読の時刻を返す', r.status === 200 && d2.data.notice.is_read === 1 && /^\d{4}-\d{2}-\d{2} /.test(d2.data.notice.read_at || ''), [r, d2.data])
  const r404 = await b.api.post(`/api/staff/notices/${pn.notice_id}/read`)
  ok('#334 配信対象でないお知らせは既読にできない（404）', r404.status === 404, r404)
}

// ---------- #227 登録前のお知らせは一覧に出ず、既読にもできない ----------
{
  const before = await publish(`登録前${tag}`)
  await sleep(1500)
  const c = await newStaff('c')
  const l = await staffNotices(c)
  ok('#227 登録前に公開されたお知らせは一覧に出ない', !l.notices.some(n => n.notice_id === before.notice_id), l.notices.map(n => n.notice_id))
  const r = await c.api.post(`/api/staff/notices/${before.notice_id}/read`)
  ok('#227 登録前のお知らせは既読にできない（404）', r.status === 404, r)
}

// ---------- #191 未読者への再通知 ----------
{
  const target = await publish(`再通知${tag}`, { read_required: true })
  must(await b.api.post(`/api/staff/notices/${target.notice_id}/read`), 'b read')
  const r = await admin.post(`/api/admin/notices/${target.notice_id}/remind`, { send_email: false })
  ok('#191 未読者に再通知できる（既読の人には送らない）', r.status === 200 && r.data.notified >= 1 && r.data.remind_count === 1, r)
  const na = (await a.api.get('/api/staff/notifications')).data.notifications.find(x => x.kind === 'notice_reminder' && x.related_id === target.notice_id)
  const nb = (await b.api.get('/api/staff/notifications')).data.notifications.find(x => x.kind === 'notice_reminder' && x.related_id === target.notice_id)
  ok('#191 未読の人にアプリ内通知が届き、そのお知らせを開くリンクを持つ', na && na.link === `#notices/${target.notice_id}` && !nb, [na, nb])
  const again = await admin.post(`/api/admin/notices/${target.notice_id}/remind`, {})
  ok('#191 続けての再通知は受け付けない（409）', again.status === 409, again)
  const listed = await noticeByTitle(`再通知${tag}`)
  ok('#191 一覧に再通知の回数と日時を返す', listed.remind_count === 1 && !!listed.reminded_at && listed.read_required === 1, listed)
  const other = await admin.post('/api/admin/notices/999999/remind', {})
  ok('#191 自社にないお知らせは 404', other.status === 404, other)
}

// ---------- #245 公開から2年たって既読の記録を削除したお知らせは「確認不要」 ----------
if (PERSIST) {
  const old = await publish(`保存期間外${tag}`)
  d1(`UPDATE notices SET reads_purged_at = datetime('now', '+9 hours'), final_read_count = 0, final_target_count = 1 WHERE notice_id = ${old.notice_id}`)
  await waitServer()
  const l = await staffNotices(a)
  const n = l.notices.find(x => x.notice_id === old.notice_id)
  ok('#245 既読の記録を削除したお知らせは未読に戻らない（確認不要）', n && n.is_read === 1 && n.no_confirm === 1, n)
  const after = await staffNotices(a, '?filter=unread')
  ok('#245 未読のみの表示・未読の件数に入らない', !after.notices.some(x => x.notice_id === old.notice_id), after.notices.map(x => x.notice_id))
} else {
  console.log('SKIP  #245（PERSIST を指定すると確かめる）')
}

// ---------- #203 切り替えていない企業の未読 ----------
{
  const hq = client(await login('sample', 'hq'))
  const code = `nu${tag}co`
  const coName = `お知らせUX連携先${tag}株式会社`
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: coName, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const coAdmin = client(await login(code, 'admin'))
  const terms = must(await coAdmin.get('/api/admin/roster/consent-terms'), 'terms')
  const aRow = (await admin.get('/api/admin/staff')).data.staff.find(s => s.staff_id === a.staff_id)
  const lk = await coAdmin.post('/api/admin/roster/link', { code: aRow.global_staff_code, agreed: true, consent_version: terms.version })
  ok('（前提）連携先の企業に a を連携する', lk.status === 200, lk)
  await sleep(1200)
  must(await coAdmin.post('/api/admin/notices', { title: `連携先から${tag}`, body: 'x', target_type: 'all', client_request_id: `co-${tag}` }), 'co notice')
  const coNotice = (await coAdmin.get('/api/admin/notices')).data.notices.find(n => n.title === `連携先から${tag}`)
  const comp = (await a.api.get('/api/staff/me/companies')).data
  const other = comp.companies.find(x => x.company_name === coName)
  ok('#203 企業切替の一覧に、切り替えていない企業の未読件数を返す', other && other.unread_notices === 1 && !other.current, comp)
  const l = await staffNotices(a)
  ok('#203 お知らせ一覧に、ほかの所属企業の未読を返す', (l.other_companies || []).some(x => x.company_name === coName && x.unread === 1), l.other_companies)
  const d = await a.api.get(`/api/staff/notices/${coNotice.notice_id}`)
  ok('#333 #203 ほかの所属企業のお知らせを開くと、切り替え先を返す', d.status === 404 && d.data.other_company && d.data.other_company.company_name === coName, d)
  const sw = await a.api.post('/api/staff/me/switch-company', { company_id: d.data.other_company.company_id })
  const d2 = await a.api.get(`/api/staff/notices/${coNotice.notice_id}`)
  ok('#333 #203 切り替えると、そのお知らせを開ける', sw.status === 200 && d2.status === 200 && d2.data.notice.notice_id === coNotice.notice_id, [sw, d2])
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
