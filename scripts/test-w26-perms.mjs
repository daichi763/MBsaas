// w26-perms（#9978 権限の表）の統合テスト
//   今の権限を1つも変えずに、API の確かめと画面のメニュー・ボタンの出し分けが1つの表（src/lib/permissions.ts）を見るようにした。
//   (1) すべての API（src/api.ts の Hono のルートの一覧を esbuild で読んで取る）× すべてのロールを実際に呼び、
//       止められたか（401・403 とその code）・応答の can_* の値・ロールで違う項目を、変更前のコードで測った表
//       （scripts/w26-perms-baseline.json）と突き合わせる
//   (2) 画面: /admin・/staff・/hq・/ の行き先、管理画面の左のメニューの項目がロールごとに前と同じ
//   (3) /api/auth/me の permissions が表（src/lib/permissions.ts）と同じで、can_manage_hr も前と同じ
//   (4) 表の中身: 4ロールの操作の一覧、表にない操作は会社管理者だけ、docs/permissions.md に全部の操作がある
//   ロール: ログインなし・staff・company_admin・office_staff・field_manager・sales_manager・system_admin・本部の閲覧（system_admin が企業の許可で管理画面を見る）。
//   roster_only はログインできない（名簿のみ）、client_viewer は最初の DB のコメントにだけある名前で、使っている行はない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9035 --persist-to <保存先> で起動していること（本番には接続しない）。
//   書き込みの API は、ない ID と空の本文（{}）で呼ぶ（データを変えにくいように）。それでも DB は変わるので、流すたびに DB を作り直す
// 実行: BASE=http://127.0.0.1:9035 node --import ./scripts/fetch-origin.mjs scripts/test-w26-perms.mjs
//   RECORD=1 … 測った表を scripts/w26-perms-baseline.json に書く（権限を変えるときだけ。変えた所を docs/permissions.md にも書く）
//   STRICT=1 … 止められなかった API の状態コード（200・400・404 など）も前と同じことを確かめる（既定は、止められたかどうかと code・can_*）
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9035'
const RECORD = process.env.RECORD === '1'
const STRICT = process.env.STRICT === '1'
const BASELINE = join(ROOT, 'scripts', 'w26-perms-baseline.json')
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 1500) : ''}`) }

// ---------- TypeScript のモジュールを esbuild で読む（scripts/gen-docs.mjs と同じやり方） ----------
async function loadTs(entry, name) {
  const esbuild = await import('esbuild')
  const dir = join(tmpdir(), 'mbsaas-w26-perms'); mkdirSync(dir, { recursive: true })
  const out = join(dir, `${name}-${process.pid}.mjs`)
  await esbuild.build({ entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' })
  try { return await import(pathToFileURL(out).href) } finally { rmSync(out, { force: true }) }
}

// ---------- 利用者ごとの Cookie ----------
function jar() {
  const m = new Map()
  return {
    m,
    take(res) { for (const sc of res.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1); if (v === '' || /max-age=0/i.test(sc)) m.delete(k); else m.set(k, v) } },
    header() { return [...m].map(([k, v]) => `${k}=${v}`).join('; ') },
  }
}
function client(extraHeaders = {}) {
  const j = jar()
  const call = async (method, path, body, opt = {}) => {
    const headers = { ...extraHeaders }
    if (j.m.size) headers.Cookie = j.header()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let r
    for (let i = 0; ; i++) {
      try { r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }); break } catch (e) { if (i >= 2) throw e; await new Promise(x => setTimeout(x, 300)) }
    }
    if (!opt.keepCookies) j.take(r)
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, location: r.headers.get('location'), type: r.headers.get('content-type') || '' }
  }
  return { jar: j, call, get: (p, o) => call('GET', p, undefined, o), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
async function login(cl, company_code, user_code, password = 'pass1234') {
  const r = await cl.post('/api/auth/login', { company_code, user_code, password })
  if (r.status !== 200) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${r.text.slice(0, 200)}`)
  return cl
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }

// ---------- ロールごとの利用者 ----------
const admin = await login(client(), 'sample', 'admin')
// 事務担当（office_staff）はシードにないので、会社管理者が作る（同じ DB なら2回目はログインだけ）
const OFFICE_CODE = 'w26perm_of'
{
  const r = await admin.post('/api/admin/users', { user_code: OFFICE_CODE, name: 'W26 事務', email: `${OFFICE_CODE}@example.com`, role: 'office_staff', password: 'w26pass1234' })
  if (r.status !== 200 && !/使われて|既に|すでに/.test(r.text)) throw new Error(`事務担当の作成: ${r.status} ${r.text.slice(0, 200)}`)
}
const office = await login(client(), 'sample', OFFICE_CODE, 'w26pass1234')
const field = await login(client(), 'sample', 'mgr01')
const sales = await login(client(), 'sample', 'sales01')
const staff = await login(client(), 'sample', 'st001')
const hq = await login(client(), '', 'hq')
// 本部の閲覧: 会社管理者が許可し、本部が閲覧を始める（Cookie hq_view）。閲覧の画面は X-HQ-View: 1 を付けて呼ぶ
must(await admin.put('/api/admin/hq-access', { allowed: true }), '本部の閲覧の許可')
const hqView = await login(client({ 'X-HQ-View': '1' }), '', 'hq')
{
  const r = await hqView.call('POST', '/api/hq/view-sessions', { company_id: 1, reason: '権限の表の確認', minutes: 60 })
  if (r.status !== 200 || !hqView.jar.m.has('hq_view')) throw new Error(`本部の閲覧の開始: ${r.status} ${r.text.slice(0, 200)}`)
}
const anon = client()
const CLIENTS = { anon, staff, company_admin: admin, office_staff: office, field_manager: field, sales_manager: sales, system_admin: hq, hq_view: hqView }
const ROLE_KEYS = Object.keys(CLIENTS)

// ---------- API の一覧 ----------
const apiMod = await loadTs('src/api.ts', 'api')
const seen = new Set(); const routes = []
for (const r of apiMod.default.routes) {
  if (r.method === 'ALL') continue
  const k = `${r.method} ${r.path}`
  if (!seen.has(k)) { seen.add(k); routes.push({ method: r.method, path: r.path, key: k }) }
}
// 呼ぶと、この後の確かめができなくなるもの（自分のセッション・二段階認証・本部の閲覧を終える）は呼ばない
const SKIP = new Set(['POST /api/auth/logout', 'POST /api/auth/logout-all', 'POST /api/auth/change-password', 'POST /api/auth/mfa/setup', 'POST /api/auth/mfa/enable',
  'POST /api/auth/mfa/disable', 'POST /api/auth/mfa/recovery-codes', 'DELETE /api/hq/view-sessions/current', 'PUT /api/admin/hq-access', 'POST /api/staff/me/switch-company'])
// パスの値: GET はシードにある ID（中身まで見る）、書き込みはない ID（データを変えにくいように）
const TOKEN = 'w26permsNotARealToken0000'
const GET_PARAM = { token: TOKEN, file: `${TOKEN}.ics`, fiscalYear: '2026', month: '2026-11', kind: 'staff', type: 'check_in', key: 'x', target: 'x', source: 'x' }
const WRITE_PARAM = { token: TOKEN, file: `${TOKEN}.ics`, fiscalYear: '2026', month: '2026-01', kind: 'x', type: 'x', key: 'x', target: 'x', source: 'x' }
const fill = (path, write) => path.replace(/:(\w+)/g, (_, n) => (write ? WRITE_PARAM : GET_PARAM)[n] ?? (write ? '999999' : '1'))

// 応答の要点: 止められたか（状態コード・code）、can_* の値、上の階層の項目と空の配列
function digest(r) {
  const d = { s: r.status }
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    if (r.data.code && r.status >= 400) d.c = String(r.data.code)
    if (r.status === 200) {
      const flags = {}
      const walk = (x, p, depth) => {
        if (depth > 4 || !x || typeof x !== 'object') return
        if (Array.isArray(x)) { if (x.length) walk(x[0], `${p}[0]`, depth + 1); return }
        for (const [k, v] of Object.entries(x)) {
          if (/^can_/.test(k) && (typeof v === 'boolean' || v === null)) flags[`${p}${k}`] = v
          else if (v && typeof v === 'object') walk(v, `${p}${k}.`, depth + 1)
        }
      }
      walk(r.data, '', 0)
      if (Object.keys(flags).length) d.f = flags
      d.k = Object.keys(r.data).sort()
      d.e = Object.entries(r.data).filter(([, v]) => Array.isArray(v) && !v.length).map(([k]) => k).sort()
    }
  }
  return d
}
const denied = (d) => d.s === 401 || d.s === 403

const t0 = Date.now()
const table = {}
const ordered = [...routes.filter(r => r.method === 'GET'), ...routes.filter(r => r.method !== 'GET')]
for (const r of ordered) {
  const full = `${r.method} ${r.path.startsWith('/api') ? r.path : '/api' + r.path}`
  if (SKIP.has(full)) { table[full] = 'skip'; continue }
  const write = r.method !== 'GET'
  const url = '/api' + fill(r.path, write)
  const row = {}
  for (const role of ROLE_KEYS) {
    const res = await CLIENTS[role].call(r.method, url, write ? {} : undefined, { keepCookies: true })
    row[role] = digest(res)
  }
  table[full] = row
}
// 上の呼び方では届かない、ハンドラーの中の確かめ（クエリ・パスの値・本文で分かれるもの）。v は応答の値も比べる項目
const EXTRA = [
  { method: 'GET', path: '/api/admin/employees/export?include_pay=1' },        // roster_export.pay
  { method: 'GET', path: '/api/admin/employees/export' },
  { method: 'PUT', path: '/api/admin/staff-requests/documents/employee/999999', body: {} }, // hr.manage（入社時書類）
  { method: 'PUT', path: '/api/admin/staff-requests/documents/staff/999999', body: {} },
  { method: 'PUT', path: '/api/admin/hq-access', body: { allowed: true } },   // hq_view.allow（上では呼ばない）
  { method: 'GET', path: '/api/admin/tours/checklist', pick: ['show', 'items', 'setup'] },      // tour.setup
  { method: 'GET', path: '/api/admin/staff-requests/summary', pick: ['leave_pending'] }, // hr.manage（休暇の件数）
  { method: 'GET', path: '/api/admin/dashboard', pick: [] },
]
for (const x of EXTRA) {
  const row = {}
  for (const role of ROLE_KEYS) {
    const res = await CLIENTS[role].call(x.method, x.path, x.body, { keepCookies: true })
    const d = digest(res)
    if (x.pick && res.status === 200 && res.data) d.v = Object.fromEntries(x.pick.map(k => [k, typeof res.data[k] === 'boolean' || res.data[k] === null ? res.data[k] : typeof res.data[k]]))
    row[role] = d
  }
  table[`EXTRA ${x.method} ${x.path}`] = row
}
const apiMs = Date.now() - t0

// ---------- 画面の行き先と、管理画面のメニュー ----------
const pages = {}
for (const role of ROLE_KEYS) {
  const p = {}
  for (const path of ['/', '/admin', '/staff', '/hq']) {
    const res = await CLIENTS[role].call('GET', path, undefined, { keepCookies: true })
    const e = { s: res.status }
    if (res.location) e.l = new URL(res.location, BASE).pathname
    if (path === '/admin' && res.status === 200) {
      const a = res.text.indexOf('id="side-nav"')
      e.menu = a < 0 ? [] : [...res.text.slice(a, res.text.indexOf('</nav>', a)).matchAll(/class="side-link[^"]*" data-tab="([\w-]+)"/g)].map(m => m[1])
      const b = res.text.indexOf('<select id="mobile-nav"')
      e.mobile = b < 0 ? [] : [...res.text.slice(b, res.text.indexOf('</select>', b)).matchAll(/<option value="([\w-]+)">/g)].map(m => m[1])
    }
    p[path] = e
  }
  pages[role] = p
}
// /api/auth/me（画面はこれでボタンを出し分ける）
const me = {}
for (const role of ROLE_KEYS) {
  const res = await CLIENTS[role].get('/api/auth/me', { keepCookies: true })
  me[role] = res.status === 200 ? { s: 200, role: res.data.role, can_manage_hr: res.data.can_manage_hr, permissions: res.data.permissions } : { s: res.status }
}
// 最後まで各ロールのセッションが生きていた（途中の API で切れていたら、その後の結果は比べられない）
ok('各ロールのセッションが最後まで使えた', ROLE_KEYS.filter(k => k !== 'anon').every(k => me[k].s === 200), me)

const measured = { routes: table, pages, me: Object.fromEntries(Object.entries(me).map(([k, v]) => [k, { s: v.s, role: v.role, can_manage_hr: v.can_manage_hr }])) }
console.log(`API ${ordered.length} 本 × ${ROLE_KEYS.length} ロールを ${Math.round(apiMs / 1000)} 秒で測った`)

if (RECORD) {
  writeFileSync(BASELINE, JSON.stringify({ note: '権限の表（#9978）の実測。scripts/test-w26-perms.mjs が RECORD=1 で書く。手で直さない', recorded_at: new Date().toISOString().slice(0, 10), roles: ROLE_KEYS, ...measured }, null, 0).replace(/\],"/g, '],\n"').replace(/\},"(GET|POST|PUT|DELETE|PATCH) /g, '},\n"$1 ') + '\n')
  console.log(`書きました: ${BASELINE}`)
  process.exit(results.some(r => !r.pass) ? 1 : 0)
}

// ---------- (1) API × ロールを、変更前の表と突き合わせる ----------
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
{
  const diffs = [], strictDiffs = [], added = [], removed = []
  // ロールで違う項目: 200 のロールの間で、ある・ないが分かれる項目と、空かどうかが分かれる配列
  const roleSpecific = (row, field) => {
    const okRoles = ROLE_KEYS.filter(k => row[k] && row[k].s === 200 && row[k][field])
    if (!okRoles.length) return {}
    const all = new Set(okRoles.flatMap(k => row[k][field]))
    const common = [...all].filter(x => okRoles.every(k => row[k][field].includes(x)))
    return Object.fromEntries(okRoles.map(k => [k, row[k][field].filter(x => !common.includes(x)).join(',')]))
  }
  for (const [key, row] of Object.entries(table)) {
    const b = base.routes[key]
    if (!b) { added.push(key); continue }
    if (row === 'skip' || b === 'skip') continue
    for (const role of ROLE_KEYS) {
      const x = row[role], y = b[role]
      if (!y) continue
      if (denied(x) !== denied(y) || (denied(x) && (x.s !== y.s || (x.c || '') !== (y.c || '')))) diffs.push(`${key} ${role}: ${y.s}${y.c ? '/' + y.c : ''} → ${x.s}${x.c ? '/' + x.c : ''}`)
      else if (x.s !== y.s) strictDiffs.push(`${key} ${role}: ${y.s} → ${x.s}`)
      if (x.s === 200 && y.s === 200) {
        for (const [f, v] of Object.entries(y.f || {})) if (x.f?.[f] !== v) diffs.push(`${key} ${role}: ${f} ${v} → ${x.f?.[f]}`)
        if (JSON.stringify(x.v) !== JSON.stringify(y.v)) diffs.push(`${key} ${role}: ${JSON.stringify(y.v)} → ${JSON.stringify(x.v)}`)
      }
    }
    for (const field of ['k', 'e']) {
      const now = roleSpecific(row, field), before = roleSpecific(b, field)
      for (const role of Object.keys(before)) if (role in now && now[role] !== before[role]) diffs.push(`${key} ${role}: ロールで違う${field === 'k' ? '項目' : '空の配列'} ${before[role] || '（なし）'} → ${now[role] || '（なし）'}`)
    }
  }
  for (const key of Object.keys(base.routes)) if (!(key in table)) removed.push(key)
  const n = Object.values(table).filter(r => r !== 'skip').length
  ok(`(1) API ${n} 本 × ${ROLE_KEYS.length} ロール: 止められた・通った（401・403 と code）と can_* とロールで違う項目が、変更前の表と同じ`, !diffs.length, diffs.slice(0, 40))
  if (STRICT) ok('(1) STRICT: 止められなかった API の状態コードも変更前と同じ', !strictDiffs.length, strictDiffs.slice(0, 40))
  else if (strictDiffs.length) console.log(`INFO  止められなかった API で状態コードが変わったもの ${strictDiffs.length} 件（権限の違いではない）: ${strictDiffs.slice(0, 10).join(' / ')}`)
  if (added.length) console.log(`INFO  変更前の表にない API ${added.length} 本（新しい API。RECORD=1 で表に足す）: ${added.slice(0, 10).join(' / ')}`)
  if (removed.length) console.log(`INFO  変更前の表にあって、今はない API ${removed.length} 本: ${removed.slice(0, 10).join(' / ')}`)
  // 4ロールで結果が分かれる API の数（表の確かめが効いている所）
  const split = Object.entries(table).filter(([, row]) => row !== 'skip' && new Set(['company_admin', 'office_staff', 'field_manager', 'sales_manager'].map(k => denied(row[k]))).size > 1)
  console.log(`INFO  4ロールで止める・通すが分かれる API: ${split.length} 本`)
}

// ---------- (2) 画面の行き先とメニュー ----------
ok('(2) /・/admin・/staff・/hq の行き先と、管理画面の左のメニュー・スマホのメニューが、ロールごとに変更前と同じ', JSON.stringify(pages) === JSON.stringify(base.pages),
  ROLE_KEYS.filter(k => JSON.stringify(pages[k]) !== JSON.stringify(base.pages[k])).map(k => ({ role: k, before: base.pages[k], now: pages[k] })))

// ---------- (3) /api/auth/me ----------
const perms = await loadTs('src/lib/permissions.ts', 'permissions')
ok('(3) /api/auth/me の role・can_manage_hr が変更前と同じ', ROLE_KEYS.every(k => me[k].s === base.me[k].s && me[k].role === base.me[k].role && me[k].can_manage_hr === base.me[k].can_manage_hr),
  ROLE_KEYS.map(k => ({ k, now: me[k], before: base.me[k] })))
ok('(3) /api/auth/me の permissions が、表（permissionsFor）と同じ。本部の閲覧は閲覧用のロールの一覧',
  ROLE_KEYS.filter(k => me[k].s === 200).every(k => JSON.stringify(me[k].permissions) === JSON.stringify(perms.permissionsFor(me[k].role))),
  ROLE_KEYS.map(k => [k, me[k].permissions]))

// ---------- (4) 表の中身（今の権限のまま） ----------
{
  const P = perms.PERMISSIONS
  const roles4 = ['company_admin', 'office_staff', 'field_manager', 'sales_manager']
  const who = (a) => roles4.filter(r => perms.can(r, a)).join(',')
  const expect = {
    'admin.access': 'company_admin,office_staff,field_manager,sales_manager',
    'hr.manage': 'company_admin,office_staff',
    'payout.manage': 'company_admin,office_staff',
    'attendance_settings.edit': 'company_admin,field_manager',
    'admin_users.manage': 'company_admin',
    'security.manage': 'company_admin',
    'roster_export.pay': 'company_admin',
    'closing.reopen': 'company_admin',
  }
  ok('(4) 表の主な行が今の権限のまま（労務・振込は会社管理者＋事務担当、勤怠の設定は会社管理者＋現場管理者、管理者アカウント・セキュリティ・締めの解除は会社管理者だけ）',
    Object.entries(expect).every(([a, v]) => who(a) === v), Object.keys(expect).map(a => [a, who(a)]))
  ok('(4) 表にない操作の名前は、だれにも許さない（書き間違いで通さない）', !perms.can('company_admin', 'no.such.action') && !perms.can('office_staff', 'no.such.action'))
  ok('(4) スタッフ・本部は管理画面の操作を持たない（スタッフアプリ・本部画面はそれぞれ1行）',
    perms.permissionsFor('staff').join(',') === 'staff_app.access' && perms.permissionsFor('system_admin').join(',') === 'hq.access' && perms.permissionsFor('roster_only').length === 0)
  const doc = readFileSync(join(ROOT, 'docs', 'permissions.md'), 'utf8')
  ok('(4) docs/permissions.md に表のすべての操作がある', Object.keys(P).every(a => doc.includes(`\`${a}\``)), Object.keys(P).filter(a => !doc.includes(`\`${a}\``)))
  // コードに、表を通さないロールの判定が残っていない（ロールの名前の一覧は src/lib/permissions.ts だけに書く）
  const files = ['src/api.ts', 'src/accounts.ts', 'src/settlement.ts', 'src/notifications.ts', 'src/staff-pay.ts', 'src/roster.ts', 'src/hq-support.ts', 'src/report-settings.ts',
    'src/staff-self-service.ts', 'src/roster-chat.ts', 'src/tours.ts', 'src/admin-menu.ts']
  const left = []
  for (const f of files) {
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return
      // 自分（u・c.get('user')）のロールを直に比べる所と、ロールの一覧の直書き（通知の宛先の既定・最後の会社管理者の確かめなど、相手のロールを見る所は対象外）
      if (/(\bu|\bself|c\.get\('user'\))\??\.role\s*[!=]==\s*'company_admin'|\['company_admin',\s*'(office_staff|field_manager)'\]|(HR_ROLES|PAYOUT_ROLES|ATTENDANCE_SETTING_ROLES)\s*=\s*\[/.test(l)) left.push(`${f}:${i + 1}`)
    })
  }
  ok('(4) API の権限の判定は表（can・requirePerm）を通す（会社管理者・労務・振込・勤怠の設定のロールの直書きが残っていない）', !left.length, left)
  const js = ['admin.js', 'settlement.js', 'security.js', 'notifications.js', 'roster.js', 'tour.js'].map(f => [f, readFileSync(join(ROOT, 'public', 'static', f), 'utf8')])
  const leftJs = js.flatMap(([f, s]) => s.split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => /\.role\s*===\s*'company_admin'|\.role\s*!==\s*'company_admin'|\['company_admin',\s*'system_admin'\]\.includes|can_manage_hr/.test(l)).map(([f, n]) => `${f}:${n}`))
  ok('(4) 画面のボタンの出し分けは hasPerm（/api/auth/me の permissions）で決める（ロール名・can_manage_hr の直書きが残っていない）', !leftJs.length, leftJs)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
