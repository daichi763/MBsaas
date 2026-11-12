// w13-docs-ref（利用者の決定 Sprint 13。#9611）の統合テスト: 設計資料（docs/db.md・api.md・screens.md）の生成
//  1. scripts/gen-docs.mjs が、注意もエラーもなく終わる（一時フォルダに書き出す。docs/ は書き換えない）
//  2. 主要な表・列・API・画面のルートが資料に入っている。表の数はマイグレーションを当てた結果と同じ
//  3. API の「定義（ファイル:行）」の行に、本当にそのメソッドとパスの定義がある。実行して取ったルートがすべてソースと対応している
//  4. API の「通すロール」が、ローカルのサーバーの実際の応答と合う（GET だけを、未ログイン・スタッフ・現場責任者・会社管理者・本部で呼ぶ）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8811 --persist-to <保存先> で起動していること（本番には接続しない）。
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w13-docs-ref.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8811'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

// ---------- 1. 生成 ----------
const out = mkdtempSync(join(tmpdir(), 'w13-docs-'))
const jsonPath = join(out, 'model.json')
const before = Object.fromEntries(['db.md', 'api.md', 'screens.md'].map(n => [n, readFileSync(join(ROOT, 'docs', n), 'utf8')]))
const gen = spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'scripts/gen-docs.mjs'), '--out', out, '--json', jsonPath], { cwd: ROOT, encoding: 'utf8' })
ok('生成がエラーなく終わる', gen.status === 0, (gen.stderr || '').slice(-600))
ok('生成のときに注意が出ない（説明のないミドルウェア・対応のないルートなど）', !/注意:/.test(gen.stderr || ''), (gen.stderr || '').slice(-600))
ok('--out のときは docs/ を書き換えない', ['db.md', 'api.md', 'screens.md'].every(n => readFileSync(join(ROOT, 'docs', n), 'utf8') === before[n]))
if (gen.status !== 0 || !existsSync(jsonPath)) { console.log('生成に失敗したので、ここで止めます'); process.exit(1) }
const model = JSON.parse(readFileSync(jsonPath, 'utf8'))
const doc = (n) => readFileSync(join(out, n), 'utf8')
const db = doc('db.md'), api = doc('api.md'), screens = doc('screens.md')
ok('人が書いた説明のリンク・表.列がすべて今のコードにある', model.refErrors.length === 0, model.refErrors)
ok('生成の区切りが空のまま残っていない', ![db, api, screens].some(t => /<!-- BEGIN GENERATED: [\w-]+ -->\n<!-- END GENERATED/.test(t)))

// ---------- 2. 主要な表・ルート・画面 ----------
const migrations = model.migrations
ok('マイグレーションをすべて当てている', migrations.length >= 92 && migrations[0].startsWith('0001_'), migrations.length)
const TABLES = ['companies', 'users', 'staff_profiles', 'persons', 'employee_records', 'clients', 'projects', 'sites', 'shift_slots', 'shift_slot_roles', 'shifts',
  'attendance_reports', 'daily_reports', 'attendance_corrections', 'notices', 'recruit_pages', 'recruit_applications', 'board_posts', 'board_proposals', 'roster_comments', 'sessions']
for (const t of TABLES) ok(`db.md に表 ${t} の定義がある`, db.includes(`<a id="${t}"></a>`) && model.tables.some(x => x.name === t))
ok('db.md の表の定義の数が、マイグレーションを当てた表の数と同じ', (db.match(/^#### /gm) || []).length - model.triggers.length === model.tables.length, [(db.match(/^#### /gm) || []).length, model.tables.length, model.triggers.length])
ok('db.md に shifts の列（slot_role_id・settle_status）が出ている', /\| `slot_role_id` \|/.test(db) && /\| `settle_status` \|/.test(db))
ok('db.md に ER 図（mermaid の erDiagram）がある', (db.match(/```mermaid\nerDiagram/g) || []).length >= 5)
ok('db.md にトリガー（shifts のトリガーを含む）が出ている', db.includes('trg_shifts_staff_changed_at') && model.triggers.length >= 10)
ok('db.md に解約の対象・退職後の削除の対象が出ている', db.includes('OFFBOARDING_TABLES') && db.includes('RETIRED_TARGETS') && db.includes('解約時: 書き出して削除'))
ok('db.md に company_id のある表で、retention.ts の解約の対象に入っていない表がない', db.includes('company_id の列がある表は、すべてどちらかに入っています'))

const ROUTES = [['POST', '/api/auth/login'], ['GET', '/api/auth/me'], ['GET', '/api/staff/home'], ['POST', '/api/staff/daily-report'], ['GET', '/api/admin/staff/:id'],
  ['GET', '/api/admin/shift-board'], ['GET', '/api/admin/settlement'], ['GET', '/api/admin/employees'], ['GET', '/api/hq/companies'], ['GET', '/api/public/recruit/:token']]
for (const [m, p] of ROUTES) ok(`api.md に ${m} ${p} がある`, new RegExp(`\\| ${m} \\| \`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \\|`).test(api) && model.endpoints.some(e => e.method === m && e.path === p))
ok('api.md のエンドポイントの数が、Hono のルートの数と同じ', ((api.split('<!-- BEGIN GENERATED: api-endpoints -->')[1] || '').split('<!-- END GENERATED: api-endpoints -->')[0].match(/^\| (GET|POST|PUT|PATCH|DELETE) \| `\/api\//gm) || []).length === model.endpoints.length, model.endpoints.length) // api.ts のルートの区切りの中だけを数える（src/index.tsx の /api/health は「画面などのルート」に出る。#9973）
ok('実行して取ったルートが、すべてソースの定義の行と対応している', model.unmatched.length === 0 && model.endpoints.every(e => e.file && e.line), model.unmatched)
ok('ミドルウェアにすべて説明がある', model.middlewares.every(m => m.label), model.middlewares.filter(m => !m.label))

// 定義の行に、本当にそのメソッドとパスの定義がある
const srcCache = {}
const lineOf = (file, n) => (srcCache[file] = srcCache[file] || readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/))[n - 1] || ''
const badLines = model.endpoints.filter(e => {
  const l = lineOf(e.file, e.line)
  const last = e.path.split('/').filter(Boolean).pop() || ''
  return !new RegExp(`\\.${e.method.toLowerCase()}\\(\\s*['"\`]`).test(l) || (last && !l.includes(last.replace(/\{.*$/, '')) && !/\.\w+\(\s*['"`]\/['"`]/.test(l))
})
ok('api.md の「定義（ファイル:行）」の行に、そのメソッドとパスの定義がある', badLines.length === 0, badLines.slice(0, 5).map(e => `${e.method} ${e.path} ${e.file}:${e.line}`))

const HASHES = { '/admin': ['dashboard', 'shifts', 'staff', 'staff/<ID>', 'projects/<ID>', 'employees', 'settlement', 'recruit', 'board', 'security'], '/staff': ['home', 'shift', 'report', 'perf', 'more', 'attendance'], '/hq': ['companies', 'companies/<ID>', 'retention', 'support', 'offboarding'] }
for (const [page, hs] of Object.entries(HASHES)) {
  const spa = model.spas.find(s => s.page === page)
  for (const h of hs) {
    const r = spa && spa.routes.find(x => x.hash === h)
    ok(`screens.md に ${page} #${h} があり、描画する関数の定義が見つかる`, r && r.defs.length > 0 && screens.includes('`#' + h + '`'), r)
  }
}
{
  const missing = []
  for (const [page, nav] of [['/admin', model.nav], ['/hq', model.hqNav], ['/staff', model.staffNav]]) {
    const spa = model.spas.find(s => s.page === page)
    for (const n of nav) if (!spa || !spa.routes.some(r => r.hash === n.tab && r.defs.length)) missing.push(`${page}#${n.tab}`)
  }
  ok('メニューのすべての項目に、ハッシュのルートと描画する関数がある', missing.length === 0, missing)
}
ok('screens.md に左のメニューの分類（シフト・勤怠・人材・お金・設定）がある', ['**シフト・勤怠**', '**人材**', '**お金**', '**設定**'].every(s => screens.includes(s)))
ok('screens.md に画面遷移の図（mermaid）がある', screens.includes('```mermaid\nflowchart'))
ok('screens.md のスタッフマスタの詳細で、スタッフ詳細の API を使う', (model.spas.find(s => s.page === '/admin')?.routes.find(r => r.hash === 'staff/<ID>')?.apis || []).includes('GET /api/admin/staff/:id'))
ok('画面の JS から呼んでいる API が見つかる割合が 9 割以上', model.endpoints.filter(e => e.callers > 0).length / model.endpoints.length >= 0.9, model.endpoints.filter(e => e.callers > 0).length)

// ---------- 3. 通すロールが、ローカルのサーバーの応答と合う ----------
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
await waitServer()
const who = {
  none: null,
  staff: await login('sample', 'st001'),
  field_manager: await login('sample', 'mgr01'),
  company_admin: await login('sample', 'admin'),
  system_admin: await login('', 'hq'),
}
// パラメーターは 1 にする（* は 1）。CSV・ファイルのダウンロードも GET で呼ぶ（ローカルのテスト用の DB だけ）
const urlOf = (p) => p.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, '1').replace(/\*$/, '1')
const gets = model.endpoints.filter(e => e.method === 'GET')
const mismatch = []
let calls = 0
for (const e of gets) {
  for (const [role, cookie] of Object.entries(who)) {
    const r = await fetch(BASE + urlOf(e.path), { headers: cookie ? { Cookie: cookie, 'X-Background': '1' } : { 'X-Background': '1' }, redirect: 'manual' })
    await r.arrayBuffer().catch(() => null)
    calls++
    const denied = r.status === 401 || r.status === 403
    // 公開の API はトークンで判断するので、ここでは確かめない。本部は閲覧を始めていないので /api/admin/* では止まる（roles に入っていない）
    const expectDenied = e.access.public ? null : role === 'none' ? true : !e.access.roles.includes(role)
    if (expectDenied === true && !denied) mismatch.push(`${role} ${e.path} → ${r.status}（止まるはず）`)
    // 許可されているのに 403 になってよいのは、本文で追加の確認（会社管理者だけ・労務情報など）をしているときだけ
    if (expectDenied === false && denied && !(r.status === 403 && e.extraChecks.length)) mismatch.push(`${role} ${e.path} → ${r.status}（通るはず）`)
  }
}
ok(`api.md の「通すロール」が、実際の応答と合う（GET ${gets.length} 本 × 5 通り = ${calls} 回）`, mismatch.length === 0, mismatch.slice(0, 15))

rmSync(out, { recursive: true, force: true })
const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
