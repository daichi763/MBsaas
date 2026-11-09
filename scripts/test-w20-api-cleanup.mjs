// 呼び出し元のない API を片付ける（代わりのあるもの。Sprint 20。w20-api-cleanup。#9925）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   消した API は 404 になり、代わりの API（画面が使っているもの）が同じ情報を返すことを確かめる。
//   消したもの: GET roster/consent-terms・GET clients/:id/contacts・GET hq-announcements・GET rate-rules/resolve・GET availability/day・
//   GET hq/companies/:id/users・POST staff-affiliations・GET staff/report-template/:projectId・PUT staff/:id/report-settings の attendance_mode
// 実行: BASE=http://127.0.0.1:8711 node scripts/test-w20-api-cleanup.mjs
import { readFileSync } from 'node:fs'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addMonth = (m, n) => { const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7) }
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const PFX = 'AC' + Date.now().toString(36).slice(-4).toUpperCase()

const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const st1 = client(await login('sample', 'st001'))

// ---------- コード: 消したルートが残っていない ----------
{
  const code = ['src/api.ts', 'src/roster.ts', 'src/hq-support.ts', 'src/shift-board.ts', 'src/staff-schedule.ts', 'src/accounts.ts', 'src/staff-lifecycle.ts', 'src/report-settings.ts'].map(src).join('\n')
  const gone = [
    "rosterApi.get('/consent-terms'", "api.get('/admin/clients/:id/contacts'", "hqSupportAdminApi.get('/hq-announcements'", "app.get('/rate-rules/resolve'",
    "scheduleAdminApi.get('/availability/day'", "hqUsersApi.get('/companies/:id/users'", "api.post('/admin/staff-affiliations'", "api.get('/staff/report-template/:projectId'",
    'applyLegacyStaffMode',
  ]
  const left = gone.filter(g => code.includes(g))
  ok('#9925 消したルート・関数がコードに残っていない', left.length === 0, left)
  // 画面・テストからも呼んでいない
  const callers = ['public/static/admin.js', 'public/static/roster.js', 'public/static/hq-support.js', 'public/static/hq.js', 'public/static/shift-board.js', 'public/static/staff.js', 'public/static/staff-lifecycle.js'].map(src).join('\n')
  const called = ['roster/consent-terms', 'rate-rules/resolve', 'availability/day', 'staff/report-template'].filter(p => callers.includes(p))
  ok('#9925 画面のコードに消した API の呼び出しがない', called.length === 0, called)
  const sl = src('public/static/staff-lifecycle.js')
  ok('#9925 スタッフの提出設定の画面は日報だけを送る（attendance_mode を送らない）', /staff\/\$\{sid\}\/report-settings`, \{ daily_report_mode:/.test(sl) && !/staff\/\$\{sid\}\/report-settings`, \{[^}]*attendance_mode/.test(sl))
}

// ---------- 同意文面: consent-terms → roster/lookup の consent ----------
{
  const code = `${PFX.toLowerCase()}a`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `${PFX}連携先株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const A = client(await login(code, 'admin'))
  const old = await A.get('/api/admin/roster/consent-terms')
  ok('#9925 GET roster/consent-terms は 404', old.status === 404, old)
  await admin.get('/api/admin/staff') // 人物IDの補完（ensureRosterIdentity）
  const sc = must(await admin.get('/api/admin/roster/1/share-code'), 'share-code')
  const lk = must(await A.get('/api/admin/roster/lookup?code=' + encodeURIComponent(sc.global_staff_code)), 'lookup')
  ok('#9925 連携の前の照会（lookup）が同意文面（版・共有する範囲・共有しない範囲）を返す', lk.consent && lk.consent.version === 'v3' && Array.isArray(lk.consent.shared) && lk.consent.shared.length > 0 && Array.isArray(lk.consent.not_shared), lk.consent)
  const link = await A.post('/api/admin/roster/link', { code: sc.global_staff_code, agreed: true, consent_version: lk.consent.version })
  ok('#9925 lookup の版で連携できる', link.status === 200 && link.data.staff_id > 0, link)
}

// ---------- 顧客担当者: GET clients/:id/contacts → GET clients/:id の contacts ----------
{
  const cid = must(await admin.post('/api/admin/clients', { client_name: `${PFX} 担当者確認` }), 'client').client_id
    ?? must(await admin.get('/api/admin/clients'), 'clients').clients.find(x => x.client_name === `${PFX} 担当者確認`).client_id
  must(await admin.post(`/api/admin/clients/${cid}/contacts`, { contact_name: `${PFX} 担当`, phone: '03-1111-2222' }), 'contact')
  const old = await admin.get(`/api/admin/clients/${cid}/contacts`)
  ok('#9925 GET clients/:id/contacts は 404', old.status === 404, old)
  const d = must(await admin.get(`/api/admin/clients/${cid}`), 'client detail')
  ok('#9925 クライアントの詳細が担当者を返す（登録・編集・削除の API は残る）', d.contacts.some(x => x.contact_name === `${PFX} 担当` && x.phone === '03-1111-2222'), d.contacts)
}

// ---------- 本部のお知らせ: GET hq-announcements → hq-support/status ----------
{
  const old = await admin.get('/api/admin/hq-announcements')
  ok('#9925 GET hq-announcements は 404', old.status === 404, old)
  const s = await admin.get('/api/admin/hq-support/status')
  ok('#9925 管理画面の上部は hq-support/status の announcements を使う', s.status === 200 && Array.isArray(s.data.announcements), s)
  const read = await admin.post('/api/admin/hq-announcements/99999999/read')
  ok('#9925 確認済みにする API（POST hq-announcements/:id/read）は残る（存在しないお知らせは 404 の JSON）', read.status === 404 && /お知らせ/.test(read.data?.error || ''), read)
}

// ---------- 単価: rate-rules/resolve → shifts/price-preview ----------
{
  const pid = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-単価`, allow_duplicate: true }), 'project').project_id
  must(await admin.put(`/api/admin/projects/${pid}/pricing`, { engagement_type: 'regular', unit_price_type: 'daily', unit_price: 18000, pay_unit_type: 'daily', pay_rate: 12000 }), 'pricing')
  const sid = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 単価`, phone: phone(1), affiliation_type: 'daily_worker', force: true }), 'staff').staff_id
  must(await admin.post('/api/admin/rate-rules', { project_id: pid, staff_id: sid, pay_unit_type: 'daily', pay_rate: 14000 }), 'rule')
  const old = await admin.get(`/api/admin/rate-rules/resolve?project_id=${pid}&staff_id=${sid}&work_date=${today}`)
  ok('#9925 GET rate-rules/resolve は 404', old.status === 404, old)
  const pv = must(await admin.get(`/api/admin/shifts/price-preview?project_id=${pid}&staff_ids=${sid}&work_date=${today}`), 'price-preview')
  const it = pv.items.find(x => x.staff_id === sid)
  ok('#9925 shifts/price-preview の settings が単価の設定の適用結果（スタッフ別のルール 14,000・請求は案件の標準 18,000）を返す',
    it && it.settings.pay_rate === 14000 && it.settings.bill_rate === 18000 && it.settings.amounts.pay_amount === 14000, it)
}

// ---------- 出勤可能日: availability/day → 月の一覧の marks ----------
{
  const old = await admin.get('/api/admin/availability/day?date=' + today)
  ok('#9925 GET availability/day は 404', old.status === 404, old)
  const m = await admin.get('/api/admin/availability?month=' + addMonth(today.slice(0, 7), 1))
  ok('#9925 出勤可能日は月の一覧（staff ごとの marks）で見る', m.status === 200 && Array.isArray(m.data.staff) && m.data.staff.every(s => typeof s.marks === 'string' && s.marks.length === m.data.days), m.data && m.data.staff && m.data.staff[0])
}

// ---------- 本部の管理者一覧: GET hq/companies/:id/users → GET hq/companies/:id の users ----------
{
  const old = await hq.get('/api/hq/companies/1/users')
  ok('#9925 GET hq/companies/:id/users は 404', old.status === 404, old)
  const d = must(await hq.get('/api/hq/companies/1'), 'hq company')
  ok('#9925 本部の会社の詳細が管理者の一覧（users）を返す', Array.isArray(d.users) && d.users.some(x => x.user_code === 'admin' && x.role === 'company_admin'), (d.users || []).slice(0, 3))
}

// ---------- 協力会社: POST staff-affiliations → POST roster/partners ----------
{
  const name = `${PFX}協力会社`
  const old = await admin.post('/api/admin/staff-affiliations', { affiliation_name: name })
  ok('#9925 POST staff-affiliations は 404', old.status === 404, old)
  const own = await admin.post('/api/admin/roster/partners', { affiliation_name: '株式会社サンプルモバイル人材' })
  ok('#9925 roster/partners でも自社名は登録できない（400）', own.status === 400, own)
  const p = await admin.post('/api/admin/roster/partners', { affiliation_name: name, contact_name: '担当 一郎' })
  const opts = must(await admin.get('/api/admin/staff-affiliations'), 'affiliations').affiliations
  ok('#9925 roster/partners で作った協力会社が、所属会社名の選択肢（GET staff-affiliations。残す）に出る', p.status === 200 && opts.some(x => x.affiliation_name === name), [p, opts.length])
}

// ---------- 日報テンプレート: staff/report-template/:projectId は消す ----------
{
  const old = await st1.get('/api/staff/report-template/1')
  ok('#9925 GET staff/report-template/:projectId は 404（日報の画面は staff/daily-report/:shiftId のテンプレートを使う）', old.status === 404, old)
}

// ---------- 提出設定: PUT staff/:id/report-settings の attendance_mode は受け付けない ----------
{
  const before = must(await admin.get('/api/admin/report-settings/staff/1'), 'staff settings before')
  const bad = await admin.put('/api/admin/staff/1/report-settings', { attendance_mode: 'none', daily_report_mode: 'none' })
  ok('#9925 attendance_mode を送ると 400（勤怠報告は案件報告管理で変える）', bad.status === 400 && /案件報告管理/.test(bad.data?.error || ''), bad)
  const after = must(await admin.get('/api/admin/report-settings/staff/1'), 'staff settings after')
  ok('#9925 400 のときは勤怠の設定も日報の設定も変えない', JSON.stringify(before.projects.map(p => p.settings)) === JSON.stringify(after.projects.map(p => p.settings)) && before.staff.legacy_mode === after.staff.legacy_mode, [before.staff, after.staff])
  const lc0 = must(await admin.get('/api/admin/staff/1/lifecycle'), 'lifecycle')
  const dr = await admin.put('/api/admin/staff/1/report-settings', { daily_report_mode: 'required' })
  const lc1 = must(await admin.get('/api/admin/staff/1/lifecycle'), 'lifecycle')
  ok('#9925 日報だけ（画面が送る形）は今までどおり保存できる', dr.status === 200 && lc1.daily_report_mode === 'required', [dr, lc0.daily_report_mode, lc1.daily_report_mode])
  must(await admin.put('/api/admin/staff/1/report-settings', { daily_report_mode: lc0.daily_report_mode ?? '' }), 'restore')
  const wrong = await admin.put('/api/admin/staff/1/report-settings', { daily_report_mode: 'bogus' })
  ok('#9925 日報の設定値が正しくなければ 400', wrong.status === 400, wrong)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
