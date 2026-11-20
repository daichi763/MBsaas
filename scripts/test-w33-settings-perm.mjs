// w33-sec-authz（セキュリティの点検 M2 #9999）: 緊急連絡先と位置ずれの距離の設定に権限の確認 の統合テスト
//   (1) PUT /api/admin/settings/site-contact: 事務担当・営業管理者は 403（role_forbidden）で値が変わらない。会社管理者・現場管理者は保存できる
//   (2) GET /api/admin/settings/site-contact の can_edit がロールで分かれる（画面は can_edit が false なら見るだけにする）
//   (3) 権限の表（src/lib/permissions.ts）で絞っている設定の書き込みを、表にないロールで呼ぶと 403、表にあるロールは 403 にならない
//       （書き込まないように、空の本文・ない ID で呼ぶ）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9022 --persist-to <保存先> で起動していること（本番には接続しない）。
// 実行: BASE=http://127.0.0.1:9022 node --import ./scripts/fetch-origin.mjs scripts/test-w33-settings-perm.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:9022'
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const PFX = 'SP' + Date.now().toString(36).slice(-4).toUpperCase()

const admin = client(await login('sample', 'admin'))
// 4ロールの利用者（会社管理者はシードの admin）
const roles = { company_admin: admin }
for (const role of ['office_staff', 'sales_manager', 'field_manager']) {
  const code = `${PFX.toLowerCase()}_${role.split('_')[0]}`
  must(await admin.post('/api/admin/users', { user_code: code, name: `${PFX} ${role}`, email: `${code}@example.com`, role, password: 'w33pass1234' }), 'user ' + role)
  roles[role] = client(await login('sample', code, 'w33pass1234'))
}
const ALLOWED = ['company_admin', 'field_manager'], DENIED = ['office_staff', 'sales_manager']

// ---------- (1)(2) 緊急連絡先・位置ずれ ----------
const orig = must(await admin.get('/api/admin/settings/site-contact'), 'site-contact get')
const restore = { emergency_phone: orig.emergency_phone || '', emergency_note: orig.emergency_note || '', far_threshold_m: orig.far_threshold_m }
for (const [role, api] of Object.entries(roles)) {
  const g = await api.get('/api/admin/settings/site-contact')
  ok(`M2 GET site-contact: ${role} は見られて、can_edit は ${ALLOWED.includes(role)}`, g.status === 200 && g.data.can_edit === ALLOWED.includes(role) && 'emergency_phone' in g.data, g)
}
for (const role of DENIED) {
  const before = must(await admin.get('/api/admin/settings/site-contact'), 'before')
  const r = await roles[role].put('/api/admin/settings/site-contact', { emergency_phone: '03-9999-0000', emergency_note: `${role} が変更`, far_threshold_m: 0 })
  const after = must(await admin.get('/api/admin/settings/site-contact'), 'after')
  ok(`M2 PUT site-contact: ${role} は 403 role_forbidden`, r.status === 403 && r.data?.code === 'role_forbidden' && /会社管理者と現場管理者だけ/.test(r.data?.error || ''), r)
  ok(`M2 PUT site-contact: ${role} の送信で値（電話・補足・距離）が変わらない`, after.emergency_phone === before.emergency_phone && after.emergency_note === before.emergency_note && after.far_threshold_m === before.far_threshold_m, { before, after })
}
for (const [i, role] of ALLOWED.entries()) {
  const v = { emergency_phone: `03-1111-000${i}`, emergency_note: `${PFX} ${role}`, far_threshold_m: 300 + i * 100 }
  const r = await roles[role].put('/api/admin/settings/site-contact', v)
  const after = must(await admin.get('/api/admin/settings/site-contact'), 'after allowed')
  ok(`M2 PUT site-contact: ${role} は保存できる`, r.status === 200 && after.emergency_phone === v.emergency_phone && after.emergency_note === v.emergency_note && after.far_threshold_m === v.far_threshold_m, { r, after })
}
ok('M2 PUT site-contact: 値の確かめは今までどおり（会社管理者でも距離が範囲外なら 400）', (await admin.put('/api/admin/settings/site-contact', { ...restore, far_threshold_m: 1 })).status === 400)
must(await admin.put('/api/admin/settings/site-contact', restore), 'restore')

// ---------- (3) 権限の表で絞っている設定の書き込み（表のとおりのロールだけが通る） ----------
// [方法, パス, 許すロール, 本文]。空の本文（{}）・ない ID・形の正しくない値で呼ぶので、通ったロールも 400・404 などで止まり、データは変わらない
// （問い合わせ先は空の本文だと「空欄に戻す」になるので、形の正しくないメールを送る）
const CA = ['company_admin'], ATT = ALLOWED, HR = ['company_admin', 'office_staff']
const WRITES = [
  ['PUT', '/api/admin/settings/site-contact', ATT],
  ['PUT', '/api/admin/settings/lateness', ATT],
  ['POST', '/api/admin/settings/photo-required', ATT],
  ['POST', '/api/admin/settings/photo-skip', ATT],
  ['PUT', '/api/admin/projects/99999999/photo-required', ATT],
  ['PUT', '/api/admin/projects/99999999/lateness', ATT],
  ['PUT', '/api/admin/settings/corrections', ATT],
  ['PUT', '/api/admin/settings/staff-view', CA],
  ['PUT', '/api/admin/settings/shift-notify', CA],
  ['PUT', '/api/admin/settings/mail-contact', CA, { reply_to: 'not-an-email' }],
  ['PUT', '/api/admin/settings/reminders', CA],
  ['POST', '/api/admin/email-suppressions/release', CA],
  ['PUT', '/api/admin/roster/field-settings', CA],
  ['PUT', '/api/admin/hq-access', CA],
  ['PUT', '/api/admin/staff-pay/settings', CA],
  ['PUT', '/api/admin/security/settings', CA],
  ['PUT', '/api/admin/settlement/premium-settings', HR],
  ['PUT', '/api/admin/settlement/payout/settings', HR],
]
for (const [method, path, allowed, body = {}] of WRITES) {
  const got = {}
  for (const [role, api] of Object.entries(roles)) got[role] = (await (method === 'PUT' ? api.put(path, body) : api.post(path, body))).status
  const good = Object.entries(got).every(([role, s]) => allowed.includes(role) ? s !== 403 : s === 403)
  ok(`M2 ${method} ${path}: 権限の表のロール（${allowed.join('・')}）だけが 403 にならない`, good, got)
}
// 上の空の本文で、許されたロールの呼び出しが値を変えていない（site-contact は 400 で止まる）
const end = must(await admin.get('/api/admin/settings/site-contact'), 'end')
ok('M2 空の本文の呼び出しで site-contact の値は変わらない', end.emergency_phone === restore.emergency_phone && end.far_threshold_m === restore.far_threshold_m, end)

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
