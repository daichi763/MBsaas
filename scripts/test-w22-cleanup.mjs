// w22-cleanup（#9953 #9954）の統合テスト
// #9953 案件の位置（projects.location_lat・location_lng）は書く経路がないので、入店の位置ずれの判定で読まない（D-42）
//   - 開催場所の位置がある・ない・入店の位置がない・報告用URLの入店で、距離と位置ずれの結果が今までどおり
//   - 案件の行に位置が入っていても使わない（PERSIST があるときだけ、ローカルの D1 に直接書いて確かめる）
// #9954 person_id の後埋め（ensureRosterIdentity）を /api/admin/roster/* のリクエストのたびに動かさない
//   - seed.sql のスタッフに person_id・人物（persons）が入っている（スタッフ一覧を開く前に、連携用IDが取れる）
//   - 名簿・連携（連携用ID・照会・連携・連携先の一覧）と、スタッフの追加（名簿・スタッフ管理）が今どおり動く
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8812 --persist-to <保存先> で起動していること（本番には接続しない）
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w22-cleanup.mjs
//   PERSIST はローカルの D1 を直接読み書きするのに使う（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8812'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
// ローカルの D1 を wrangler d1 execute で直接読んだ直後は、開発サーバーの接続が切れることがあるので1回だけ送り直す
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
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const pub = {
  post: async (token, body) => {
    const r = await fetchRetry(`${BASE}/api/public/report/${token}/attendance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => null) }
  },
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w22cl-'))
let sqlSeq = 0
// ローカルの D1 で SQL を実行し、最後の文の結果の行を返す
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const j = JSON.parse(out)
      return j[j.length - 1].results
    } catch (e) { if (i >= 3) throw e }
  }
}

const PFX = 'CL' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))

// ---------- #9954 コード: 名簿のミドルウェアで後埋めをしない ----------
{
  const roster = src('src/roster.ts')
  ok('#9954 /api/admin/roster/* のミドルウェアで ensureRosterIdentity を呼ばない', !/rosterApi\.use\([^)]*\)?[^\n]*ensureRosterIdentity/.test(roster) && !/rosterApi\.use\('\/\*'/.test(roster))
  ok('#9954 seed.sql と gen_seed.cjs は person_id を入れる', /UPDATE staff_profiles SET person_id = lower\(hex\(randomblob\(16\)\)\)/.test(src('seed.sql')) && /INSERT OR IGNORE INTO persons/.test(src('seed.sql'))
    && /UPDATE staff_profiles SET person_id = lower\(hex\(randomblob\(16\)\)\)/.test(src('scripts/gen_seed.cjs')) && /INSERT OR IGNORE INTO persons/.test(src('scripts/gen_seed.cjs')))
}

// ---------- #9954 seed のスタッフの人物ID（スタッフ一覧 /api/admin/staff を開く前に確かめる） ----------
if (PERSIST) {
  const [r] = sql(`SELECT (SELECT COUNT(*) FROM staff_profiles WHERE person_id IS NULL) AS sp_null,
    (SELECT COUNT(*) FROM users u WHERE u.person_id IS NULL AND EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = u.user_id)) AS us_null,
    (SELECT COUNT(*) FROM staff_profiles sp WHERE NOT EXISTS (SELECT 1 FROM persons p WHERE p.person_id = sp.person_id)) AS no_person,
    (SELECT COUNT(*) FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.person_id != sp.person_id) AS mismatch,
    (SELECT COUNT(*) FROM staff_profiles WHERE owner_company_id IS NULL) AS no_owner,
    (SELECT COUNT(*) FROM staff_profiles WHERE company_id = 1 AND staff_id BETWEEN 1 AND 20 AND affiliation_type = 'own_employee') AS own,
    (SELECT COUNT(DISTINCT person_id) FROM staff_profiles WHERE company_id = 1 AND staff_id BETWEEN 1 AND 20) AS distinct_person`)
  ok('#9954 seed のスタッフに person_id・人物・所属元が入っている（NULL の行がない）', r.sp_null === 0 && r.us_null === 0 && r.no_person === 0 && r.mismatch === 0 && r.no_owner === 0, r)
  ok('#9954 seed のスタッフ20人は自社雇用で、人物は1人ずつ別', r.own === 20 && r.distinct_person === 20, r)
} else console.log('SKIP  #9954 seed の人物IDを D1 で確かめる（PERSIST が無いため）')
const sc1 = await admin.get('/api/admin/roster/1/share-code')
ok('#9954 スタッフ一覧を開く前でも、seed のスタッフの連携用ID（FS…）が取れる', sc1.status === 200 && /^FS[0-9A-F]{10}$/.test(sc1.data?.global_staff_code || ''), sc1)
const sc20 = await admin.get('/api/admin/roster/20/share-code')
ok('#9954 seed の最後のスタッフも連携用IDが取れ、人ごとに違う', sc20.status === 200 && /^FS[0-9A-F]{10}$/.test(sc20.data?.global_staff_code || '') && sc20.data.global_staff_code !== sc1.data?.global_staff_code, sc20)

// ---------- #9954 名簿・連携が今どおり動く ----------
{
  const code = `${PFX.toLowerCase()}a`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `${PFX}連携先株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const B = client(await login(code, 'admin'))
  const lk = await B.get('/api/admin/roster/lookup?code=' + encodeURIComponent(sc1.data.global_staff_code))
  ok('#9954 連携先の照会（lookup）で seed のスタッフが見つかる', lk.status === 200 && lk.data.consent && lk.data.consent.version, lk)
  const link = await B.post('/api/admin/roster/link', { code: sc1.data.global_staff_code, agreed: true, consent_version: lk.data?.consent?.version })
  ok('#9954 連携できる', link.status === 200 && link.data.staff_id > 0, link)
  const links = await admin.get('/api/admin/roster/1/links')
  ok('#9954 所属元の連携先の一覧に、連携した会社が出る', links.status === 200 && JSON.stringify(links.data).includes(`${PFX}連携先株式会社`), links)
  if (PERSIST && link.data?.staff_id) {
    const [r] = sql(`SELECT l.person_id = o.person_id AS same, l.affiliation_type, l.person_id IS NOT NULL AS has FROM staff_profiles l JOIN staff_profiles o ON o.staff_id = 1 WHERE l.staff_id = ${Number(link.data.staff_id)}`)
    ok('#9954 連携した行は所属元と同じ person_id を持つ', r && r.same === 1 && r.has === 1 && r.affiliation_type === 'linked_external', r)
  }
  const bStaff = await B.get(`/api/admin/roster/${link.data?.staff_id}/share-code`)
  ok('#9954 連携先の行は自社専用の再連携コード（RL…）を使う', bStaff.status === 200 && bStaff.data.relink === true, bStaff)
}
{
  // 名簿から自社雇用を追加 → すぐに連携用IDが取れる（作成のときに person_id を入れる）
  const r = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 名簿 太郎`, gender: 'male', user_code: `${PFX}r1`, password: 'pass1234', force: true })
  ok('（前提）名簿から自社雇用を追加', r.status === 200 && r.data.staff_id > 0, r)
  const sc = await admin.get(`/api/admin/roster/${r.data?.staff_id}/share-code`)
  ok('#9954 名簿から追加したスタッフは、すぐに連携用IDが取れる', sc.status === 200 && /^FS[0-9A-F]{10}$/.test(sc.data?.global_staff_code || ''), sc)
  // スタッフ管理から追加（/admin/staff の POST）
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}s1`, name: `${PFX} 管理 花子`, password: 'pass1234', force: true }), 'staff add')
  if (PERSIST) {
    const [x] = sql(`SELECT sp.staff_id, sp.person_id IS NOT NULL AS has, u.person_id = sp.person_id AS same, EXISTS (SELECT 1 FROM persons p WHERE p.person_id = sp.person_id) AS person
      FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.company_id = 1 AND u.user_code = '${PFX}s1'`)
    ok('#9954 スタッフ管理から追加したスタッフも、作成のときに person_id・人物が入る', x && x.has === 1 && x.same === 1 && x.person === 1, x)
    const sc2 = await admin.get(`/api/admin/roster/${x?.staff_id}/share-code`)
    ok('#9954 スタッフ管理から追加したスタッフも連携用IDが取れる', sc2.status === 200 && /^FS[0-9A-F]{10}$/.test(sc2.data?.global_staff_code || ''), sc2)
  }
  const fs = await admin.get('/api/admin/roster/field-settings')
  ok('#9954 名簿のほかの API（必須項目の設定）も今どおり', fs.status === 200, fs)
  const partners = await admin.get('/api/admin/roster/partners')
  ok('#9954 名簿のほかの API（協力会社の一覧）も今どおり', partners.status === 200 && Array.isArray(partners.data?.partners), partners)
}

// ---------- #9953 コード: 案件の位置を読まない ----------
{
  // コメントの行は除く
  const code = ['src/lib/site-location.ts', 'src/attendance-punch.ts', 'src/api.ts'].map(src).join('\n').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  ok('#9953 入店の位置の判定のコードが projects.location_lat・location_lng を読まない', !/(location_lat|location_lng|p_lat|p_lng)/.test(code))
  ok("#9953 site-location.ts に案件の位置の分岐（source: 'project'）がない", !/'project'/.test(src('src/lib/site-location.ts')))
  ok('#9953 シフト操作の画面に「案件の位置と比べています」の分岐がない', !/案件の位置と比べています/.test(src('public/static/admin.js')))
  ok('#9953 docs/db.md に2つの列を「使っていない」と書いている', /### 2\.7 使っていない列[\s\S]*projects\.location_lat`・`projects\.location_lng/.test(src('docs/db.md')))
}

// ---------- #9953 入店の位置ずれの判定は今までどおり ----------
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで入店できるようにする（テストのみ）
must(await admin.put('/api/admin/settings/site-contact', { emergency_phone: '', emergency_note: '', far_threshold_m: 300 }), 'threshold')
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: cl.client_id }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const SITE = { lat: 35.681236, lng: 139.767125 } // 東京駅付近
const PROJ = { lat: 35.658034, lng: 139.701636 } // 渋谷駅付近（案件の行にだけ入れる。使わないことを確かめる）
const site = must(await admin.post('/api/admin/sites', { client_id: cl.client_id, site_name: `${PFX}-会場`, lat: SITE.lat, lng: SITE.lng }), 'site')
if (PERSIST) sql(`UPDATE projects SET location_lat = ${PROJ.lat}, location_lng = ${PROJ.lng} WHERE project_id = ${Number(pid)}`)
must(await admin.post('/api/admin/staff', { user_code: `${PFX}A`, name: `${PFX} A`, password: 'pass1234', force: true }), 'staff A')
const A = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}A`)
const st = client(await login('sample', `${PFX}A`))
let slotSeq = 0
async function siteShift(staffId, siteId) {
  const start = `00:${String(++slotSeq).padStart(2, '0')}`
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, site_id: siteId, dates: [today], start_time: start, end_time: '23:30', roles: [{ role_name: '販売', headcount: 1 }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${today}&to=${today}&project_ids=${pid}`), 'board')
  const role = b.slots.filter(s => s.start_time === start).pop().roles[0].slot_role_id
  must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [staffId], force: true }), 'assign')
  const s = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.staff_id === staffId && x.start_time === start)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
{
  // 開催場所から北へ約1km（案件の位置＝渋谷とは約6km）
  const s1 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s1, report_type: 'check_in', latitude: SITE.lat + 0.009, longitude: SITE.lng })
  ok('#9953 開催場所のあるシフトは開催場所との距離で判定する（約1km・位置ずれ）', r.status === 200 && r.data.far === true && r.data.distance_m > 900 && r.data.distance_m < 1100, r)
  const loc = must(await admin.get(`/api/admin/shifts/${s1}/check-in-location`), 'loc1')
  ok('#9953 管理画面の距離・位置ずれも同じ（site_position は site）', loc.site_position === 'site' && loc.check_in && loc.check_in.distance_m === r.data.distance_m && loc.check_in.far === true && loc.threshold_m === 300, loc)
}
{
  const s2 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s2, report_type: 'check_in', latitude: SITE.lat + 0.0002, longitude: SITE.lng })
  ok('#9953 開催場所の近く（約20m）は位置ずれにしない', r.status === 200 && r.data.far === false && r.data.distance_m < 50, r)
}
{
  // 開催場所のないシフト。案件の行に位置があっても判定しない（今までも書く経路がなく、判定しなかった）
  const s3 = await siteShift(A.staff_id, null)
  const r = await st.post('/api/staff/attendance', { shift_id: s3, report_type: 'check_in', latitude: PROJ.lat + 0.05, longitude: PROJ.lng })
  ok('#9953 開催場所のないシフトは距離を判定しない（案件の位置は使わない）', r.status === 200 && r.data.distance_m === null && r.data.far === false, r)
  const loc = must(await admin.get(`/api/admin/shifts/${s3}/check-in-location`), 'loc3')
  ok('#9953 開催場所のないシフトは管理画面でも判定なし（site_position は null）', loc.site_position === null && loc.check_in && loc.check_in.distance_m === null && loc.check_in.far === false, loc)
}
{
  const s4 = await siteShift(A.staff_id, site.site_id)
  const r = await st.post('/api/staff/attendance', { shift_id: s4, report_type: 'check_in', latitude: null, longitude: null })
  ok('#9953 位置のない入店は距離なし', r.status === 200 && r.data.distance_m === null && r.data.far === false, r)
}
{
  // 報告用URLの入店（距離を保存しない）は、管理画面で開催場所との距離を計算する
  const s5 = await siteShift(A.staff_id, site.site_id)
  const before = must(await admin.get(`/api/admin/shifts/${s5}/check-in-location`), 'loc5a')
  ok('#9953 入店の報告がなければ check_in は null（site_position は site）', before.check_in === null && before.site_position === 'site', before)
  const tok = must(await admin.post(`/api/admin/shifts/${s5}/report-link`, {}), 'issue').token
  const p = await pub.post(tok, { report_type: 'check_in', latitude: SITE.lat + 0.009, longitude: SITE.lng })
  ok('（前提）報告用URLから入店', p.status === 200, p)
  const loc = must(await admin.get(`/api/admin/shifts/${s5}/check-in-location`), 'loc5b')
  ok('#9953 報告用URLの入店も開催場所との距離で位置ずれを出す', loc.check_in && loc.check_in.entry_method === 'link' && loc.check_in.far === true && loc.check_in.distance_m > 900 && loc.check_in.distance_m < 1100, loc)
  // 開催場所のない報告用URLの入店
  const s6 = await siteShift(A.staff_id, null)
  const tok2 = must(await admin.post(`/api/admin/shifts/${s6}/report-link`, {}), 'issue2').token
  must(await pub.post(tok2, { report_type: 'check_in', latitude: PROJ.lat, longitude: PROJ.lng }), 'link check_in 2')
  const loc2 = must(await admin.get(`/api/admin/shifts/${s6}/check-in-location`), 'loc6')
  ok('#9953 開催場所のない報告用URLの入店は判定なし（案件の位置は使わない）', loc2.site_position === null && loc2.check_in && loc2.check_in.distance_m === null && loc2.check_in.far === false, loc2)
}
await admin.put('/api/admin/settings/site-contact', { emergency_phone: '', emergency_note: '', far_threshold_m: 500 })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
