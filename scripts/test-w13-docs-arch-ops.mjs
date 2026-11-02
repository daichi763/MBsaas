// 設計資料（w13-docs-arch-ops: Sprint 13 #9601）の確認
//   docs/architecture.md・operations.md・decisions.md・glossary.md と README の案内について:
//   1) 資料の中の `ファイル:行` の参照が、今のコードにある行を指しているか。主な関数・定数は、書いた行にあるか
//   2) 定期処理の表が src/index.tsx の CRON_JOBS・wrangler.jsonc の triggers.crons と合っているか
//   3) 環境変数（vars）とシークレットの表が、wrangler.jsonc とコードの env の参照と合っているか
//   4) 資料の間のリンクの先があるか（db.md・api.md・screens.md・backup.md・monitoring.md は別の作業単位が作るので、無ければ SKIP）
//   5) 資料に書いた動き（認証・権限・Webhook・セキュリティヘッダー・Service Worker）を API で確かめる
// 行番号がずれて落ちたときは、メッセージの「今は n 行目」に合わせて docs の参照を直す。
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、wrangler dev --local で起動していること（追加の起動オプションはない）
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w13-docs-arch-ops.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 800) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const lines = (p) => read(p).split('\n')

const DOCS = ['docs/architecture.md', 'docs/operations.md', 'docs/decisions.md', 'docs/glossary.md']
// 別の作業単位（Sprint 13 の w13-docs-ref・w13-ops-safety）が作る資料。統合の前は無いことがある
const PENDING_DOCS = new Set(['db.md', 'api.md', 'screens.md', 'backup.md', 'monitoring.md'])

// ============ 0. 資料がある ============
for (const d of DOCS) ok(`資料がある: ${d}`, existsSync(join(ROOT, d)))
const docText = Object.fromEntries(DOCS.filter(d => existsSync(join(ROOT, d))).map(d => [d, read(d)]))
const readme = read('README.md')
for (const d of DOCS) ok(`README から ${d} へ案内している`, readme.includes(`](${d})`))

// ============ 1. `ファイル:行` の参照 ============
// `path:N`、続けて書いた `〜`M`（範囲の終わり）・`、`M` / `・`M`（同じファイルの別の行）を読む
const PATH_RE = /^(?:(?:src|public|scripts|migrations|docs)\/[\w.\-/]+|wrangler\.jsonc|package\.json|seed\.sql|tsconfig\.json|vite\.config\.ts)$/
const SEPS = ['〜', '、', '・']
function collectRefs(text) {
  const refs = [] // { file, start, end, line }
  const paths = [] // 行番号のないパスの参照
  text.split('\n').forEach((ln, idx) => {
    const seg = ln.split('`')
    let last = null
    for (let i = 1; i < seg.length; i += 2) {
      const code = seg[i], before = seg[i - 1].trim()
      const m = code.match(/^(.+):(\d+)$/)
      if (m && PATH_RE.test(m[1])) { last = { file: m[1], start: +m[2], end: +m[2], line: idx + 1 }; refs.push(last); continue }
      if (/^\d+$/.test(code) && last && SEPS.includes(before)) {
        if (before === '〜') last.end = +code
        else { last = { file: last.file, start: +code, end: +code, line: idx + 1 }; refs.push(last) }
        continue
      }
      if (before !== '' && !SEPS.includes(before)) last = null
      if (PATH_RE.test(code.replace(/\/$/, '')) && !/[*<]/.test(code)) paths.push({ file: code, line: idx + 1 })
    }
  })
  return { refs, paths }
}
const allRefs = []
for (const [d, text] of Object.entries(docText)) {
  const { refs, paths } = collectRefs(text)
  allRefs.push(...refs.map(r => ({ ...r, doc: d })))
  const bad = []
  for (const r of refs) {
    if (!existsSync(join(ROOT, r.file))) { bad.push(`${d}:${r.line} ${r.file} がない`); continue }
    const n = lines(r.file).length
    if (r.start < 1 || r.end < r.start || r.end > n) bad.push(`${d}:${r.line} ${r.file}:${r.start}${r.end !== r.start ? '〜' + r.end : ''}（ファイルは ${n} 行）`)
  }
  ok(`${d}: ファイル:行 の参照（${refs.length} 件）がすべて今のファイルの中を指している`, refs.length > 0 && !bad.length, bad)
  const missing = paths.filter(p => !existsSync(join(ROOT, p.file))).map(p => `${d}:${p.line} ${p.file}`)
  ok(`${d}: パスの参照（${paths.length} 件）の先がある`, !missing.length, missing)
}

// 主な関数・定数: 資料に書いた行（または20行以内の範囲）に、その定義がある
const ANCHORS = [
  ['src/index.tsx', "app.onError("], ['src/index.tsx', "app.route('/api', api)"], ['src/index.tsx', "app.post('/webhooks/resend'"],
  ['src/index.tsx', "async function currentUser"], ['src/index.tsx', "app.get('/staff'"], ['src/index.tsx', "app.get('/admin'"],
  ['src/index.tsx', "app.get('/hq'"], ['src/index.tsx', 'const CRON_JOBS = defineCronJobs'], ['src/index.tsx', 'export default {'],
  ['src/index.tsx', "c.env.DEMO_MODE === 'true'"], ['src/index.tsx', 'const dryRun = env.RETENTION_ENABLED'],
  ['src/api.ts', 'const ADMIN_ROLES ='], ['src/api.ts', "api.post('/auth/login', "], ['src/api.ts', "api.use('/*', async"],
  ['src/api.ts', "api.use('/staff/*'"], ['src/api.ts', 'async function resolvePersonShift'], ['src/api.ts', 'export async function autoCloseBillingMonth'],
  ['src/lib/auth.ts', 'const PBKDF2_ITERATIONS ='], ['src/lib/auth.ts', 'export async function loadSessionUser'], ['src/lib/auth.ts', 'export async function purgeExpiredAuthRows'],
  ['src/services/cron.ts', 'console.log(`cron ${job.name}'], ['src/services/cron.ts', 'export async function cronStatus'],
  ['src/services/email.ts', 'export function mailMode'], ['src/services/email.ts', 'export async function handleResendWebhook'],
  ['src/services/retention.ts', 'export const RETENTION_SETTING_DEFS'], ['src/services/retention.ts', 'export async function runRetentionCleanup'],
  ['src/services/retention.ts', 'export async function runInServiceRetentionJob'], ['src/services/retention.ts', 'export async function purgeExpiredTokens'],
  ['src/services/retention.ts', 'export async function applyDueRetirements'],
  ['src/recruit.ts', 'function turnstileEnabled'], ['src/recruit.ts', 'async function verifyTurnstile'], ['src/recruit.ts', 'export async function purgeOldApplications'],
  ['src/roster.ts', 'export const CONSENT_VERSION'], ['src/roster.ts', "const userCode = 'LK-'"],
  ['src/staff-lifecycle.ts', 'export const MATCH_PHONE_SQL'], ['src/notifications.ts', 'export const staffAppRecruitEnabled'],
  ['src/lib/web-push.ts', 'export async function loadVapid'], ['src/shift-board.ts', "app.post('/shift-slots/bulk-delete'"],
  ['src/shift-board.ts', "app.post('/shift-slots/assign-batch'"], ['src/accounts.ts', "adminUsersApi.post('/users/:id/reset-password'"],
  ['scripts/ci-wrangler-config.mjs', 'wrangler.json を本番の設定で作成しました'],
  ['wrangler.jsonc', '"triggers": {'], ['wrangler.jsonc', '"observability"'], ['wrangler.jsonc', '"RETENTION_ENABLED": "true"'], ['package.json', '"build":'],
]
for (const [file, needle] of ANCHORS) {
  const at = lines(file).findIndex(l => l.includes(needle)) + 1
  if (!at) { ok(`${file} に「${needle}」がある`, false); continue }
  const mine = allRefs.filter(r => r.file === file)
  const hit = mine.some(r => r.start <= at && at <= r.end && r.end - r.start <= 20)
  const near = mine.filter(r => Math.abs(r.start - at) <= 40).map(r => `${r.doc}:${r.line} → ${r.start}${r.end !== r.start ? '〜' + r.end : ''}`)
  ok(`資料の ${file} の「${needle}」の行番号が今の行（${at}）と合う`, hit, near.length ? `今は ${at} 行目。近い参照: ${near.join(' / ')}` : `今は ${at} 行目。資料に参照がない`)
}

// ============ 2. 定期処理の表 ============
const idx = read('src/index.tsx')
const cronConst = Object.fromEntries([...idx.matchAll(/const (CRON_[A-Z_]+) = '([^']+)'/g)].map(m => [m[1], m[2]]))
const jobs = [...idx.matchAll(/\{ name: '([a-z_]+)', label: '[^']*', cron: (CRON_[A-Z_]+)/g)].map(m => ({ name: m[1], cron: cronConst[m[2]] }))
ok('CRON_JOBS を読めた', jobs.length >= 10 && jobs.every(j => j.cron), jobs)
const arch = docText['docs/architecture.md'] || ''
const cronSec = arch.split('## 5. 定期処理')[1]?.split('\n## ')[0] || ''
const docJobs = Object.fromEntries([...cronSec.matchAll(/^\| `([^`]+)` \| [^|]+ \| `([a-z_]+)` \|/gm)].map(m => [m[2], m[1]]))
const missingJobs = jobs.filter(j => !docJobs[j.name]).map(j => j.name)
const extraJobs = Object.keys(docJobs).filter(n => !jobs.some(j => j.name === n))
const wrongExpr = jobs.filter(j => docJobs[j.name] && docJobs[j.name] !== j.cron).map(j => `${j.name}: 資料 ${docJobs[j.name]} / コード ${j.cron}`)
ok('architecture.md の定期処理の表に CRON_JOBS の処理がすべてある', !missingJobs.length, missingJobs)
ok('architecture.md の定期処理の表に、CRON_JOBS にない処理がない', !extraJobs.length, extraJobs)
ok('architecture.md の定期処理の表の起動の式が CRON_JOBS と合う', !wrongExpr.length, wrongExpr)
const wr = read('wrangler.jsonc')
const cronLists = [...wr.matchAll(/"crons":\s*\[([^\]]*)\]/g)].map(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]).sort())
const usedExprs = [...new Set(jobs.map(j => j.cron))].sort()
ok('wrangler.jsonc の triggers.crons（ローカル・本番）が CRON_JOBS の式と合う', cronLists.length === 2 && cronLists.every(l => JSON.stringify(l) === JSON.stringify(usedExprs)), { cronLists, usedExprs })
ok('README の定期処理の表に3つの起動の式がある', usedExprs.every(e => readme.includes('| `' + e + '` |')))

// ============ 3. 環境変数・シークレット ============
const varBlocks = [...wr.matchAll(/"vars":\s*\{([^}]*)\}/g)].map(m => [...m[1].matchAll(/"([A-Z_]+)":/g)].map(x => x[1]))
const varNames = [...new Set(varBlocks.flat())]
ok('wrangler.jsonc の vars はローカルと本番で同じ名前', varBlocks.length === 2 && JSON.stringify([...varBlocks[0]].sort()) === JSON.stringify([...varBlocks[1]].sort()), varBlocks)
const sec121 = arch.split('### 12.1')[1]?.split('### 12.2')[0] || ''
const sec122 = arch.split('### 12.2')[1]?.split('### 12.3')[0] || ''
const tableNames = (sec) => new Set([...sec.matchAll(/^\| ((?:`[A-Z_]+`(?: \/ )?)+) \|/gm)].flatMap(m => [...m[1].matchAll(/`([A-Z_]+)`/g)].map(x => x[1])))
const docVars = tableNames(sec121), docSecrets = tableNames(sec122)
ok('architecture.md の vars の表が wrangler.jsonc の vars と合う', varNames.length > 0 && varNames.every(v => docVars.has(v)) && [...docVars].every(v => varNames.includes(v)), { varNames, docVars: [...docVars] })
function srcFiles(dir) {
  return readdirSync(join(ROOT, dir)).flatMap(f => { const p = `${dir}/${f}`; return statSync(join(ROOT, p)).isDirectory() ? srcFiles(p) : /\.(ts|tsx)$/.test(f) ? [p] : [] })
}
const BINDINGS = new Set(['DB', 'PHOTOS', 'DOCUMENTS', 'CONTRACTS'])
const envNames = new Set(srcFiles('src').flatMap(f => [...read(f).matchAll(/env\??\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1])))
const secretNames = [...envNames].filter(n => !BINDINGS.has(n) && !varNames.includes(n)).sort()
const undocumented = secretNames.filter(n => !docSecrets.has(n))
const stale = [...docSecrets].filter(n => !envNames.has(n))
ok(`コードが読むシークレット（${secretNames.length} 件）が、すべて architecture.md の 12.2 にある`, secretNames.length > 0 && !undocumented.length, undocumented)
ok('architecture.md の 12.2 に、コードが読まないシークレットがない', !stale.length, stale)
ok('architecture.md のバインディングの表に D1・R2 がそろっている', [...BINDINGS].every(b => (arch.split('### 12.3')[1] || '').includes('`' + b + '`')))

// ============ 4. リンク・決定事項の番号 ============
const allDocs = { ...docText, 'README.md': readme }
for (const [d, text] of Object.entries(allDocs)) {
  const base = dirname(d)
  const bad = [], pending = []
  for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
    const target = join(base, m[1]).replace(/\\/g, '/')
    if (existsSync(join(ROOT, target))) continue
    if (PENDING_DOCS.has(m[1].split('/').pop())) pending.push(m[1]); else bad.push(m[1])
  }
  ok(`${d}: リンクの先の資料がある`, !bad.length, bad)
  if (pending.length) skip(`${d}: 別の作業単位が作る資料へのリンク ${[...new Set(pending)].join(', ')}`, 'この作業単位のブランチにはまだない。統合の後は PASS になる')
}
const dec = docText['docs/decisions.md'] || ''
const decIds = new Set([...dec.matchAll(/^### (D-\d+) /gm)].map(m => m[1]))
const tableIds = new Set([...dec.matchAll(/^\| (D-\d+) \|/gm)].map(m => m[1]))
ok('decisions.md の一覧の表と本文の見出しの ID が一致する', decIds.size > 0 && decIds.size === tableIds.size && [...decIds].every(i => tableIds.has(i)), { heading: [...decIds], table: [...tableIds] })
const usedIds = new Set(Object.values(allDocs).flatMap(t => [...t.matchAll(/\b(D-\d{2})\b/g)].map(m => m[1])))
const unknownIds = [...usedIds].filter(i => !decIds.has(i))
ok('資料が参照する決定事項（D-xx）が decisions.md にある', !unknownIds.length, unknownIds)
for (const no of ['#501', '#382', '#123', '#544', '#290', '#427', '#532', '#281', '#9001', '#9301', '#9302', '#9306', '#9402', '#9411', '#9412', '#9422', '#9425', '#9501', '#9511', '#9512']) {
  ok(`decisions.md に ${no} の決定がある`, dec.includes(no))
}
const mermaid = [...arch.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1].trim().split('\n')[0])
ok('architecture.md に構成図（mermaid）がある', mermaid.length >= 1 && mermaid.every(h => /^(flowchart|sequenceDiagram|erDiagram|graph)\b/.test(h)), mermaid)
// 資料に秘密の値を書いていない（Resend の API キー・Webhook の秘密・秘密鍵）
const leaks = Object.entries(allDocs).filter(([, t]) => /\bre_[A-Za-z0-9_]{20,}|whsec_[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(t)).map(([d]) => d)
ok('資料に API キー・秘密鍵の値が書かれていない', !leaks.length, leaks)

// ============ 5. 資料に書いた動きを API で確かめる ============
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return { cookie, data: await r.json().catch(() => null) }
}
const get = (path, cookie, headers = {}) => fetch(`${BASE}${path}`, { headers: { Cookie: cookie || '', ...headers }, redirect: 'manual' })
let serverUp = false
try { serverUp = (await fetch(`${BASE}/login`)).status < 500 } catch { }
if (!serverUp) {
  ok(`サーバー（${BASE}）に接続できる（API の確認の前提）`, false)
} else {
  // 4.1 セキュリティヘッダー
  const lg = await fetch(`${BASE}/login`)
  const lgHtml = await lg.text()
  ok('画面の HTML に CSP と X-Content-Type-Options: nosniff を付ける', /default-src 'self'/.test(lg.headers.get('content-security-policy') || '') && lg.headers.get('x-content-type-options') === 'nosniff')
  // 12.1 DEMO_MODE（ローカルの既定は true。本番は false）
  ok('ローカル（DEMO_MODE=true）のログイン画面にはデモアカウントの案内が出る', lgHtml.includes('demo-account-aside'))
  ok('画面は CDN のライブラリを SRI 付きで読む', /cdn\.jsdelivr\.net\/npm\/axios@[\d.]+\/dist\/axios\.min\.js" integrity="sha384-/.test(lgHtml))
  // 4.1 未ログインで画面を開くとログインへ（next 付き）
  const adm = await get('/admin')
  ok('未ログインで /admin を開くと /login?next=%2Fadmin へ移す', adm.status === 302 && (adm.headers.get('location') || '').includes('/login?next=%2Fadmin'), adm.status)
  // 4.1 /sw.js
  const sw = await fetch(`${BASE}/sw.js`)
  ok('/sw.js は JavaScript を no-cache で返す', sw.status === 200 && /javascript/.test(sw.headers.get('content-type') || '') && /no-cache/.test(sw.headers.get('cache-control') || ''))
  // 6.1 Webhook（RESEND_WEBHOOK_SECRET が未設定なら 503）
  const wh = await fetch(`${BASE}/webhooks/resend`, { method: 'POST', body: '{}' })
  const whBody = await wh.json().catch(() => null)
  if (whBody?.error === 'invalid_signature') skip('RESEND_WEBHOOK_SECRET が未設定なら /webhooks/resend は 503', 'このサーバーには秘密が設定されている')
  else ok('RESEND_WEBHOOK_SECRET が未設定なら /webhooks/resend は 503（webhook_not_configured）', wh.status === 503 && whBody?.error === 'webhook_not_configured', { status: wh.status, whBody })
  // 4.2 認証ミドルウェア
  const me = await get('/api/auth/me')
  ok('セッションなしの API は 401', me.status === 401)
  // 10章 ロール
  const admin = await login('sample', 'admin')
  const staff = await login('sample', 'st001')
  const field = await login('sample', 'mgr01')
  const hq = await login('', 'hq')
  ok('ログインの応答の移り先がロールごとの画面（/admin・/staff・/hq）', admin.data?.redirect === '/admin' && staff.data?.redirect === '/staff' && hq.data?.redirect === '/hq', [admin.data?.redirect, staff.data?.redirect, hq.data?.redirect])
  ok('セッションの Cookie の名前は session', admin.cookie.startsWith('session='))
  ok('スタッフは /api/admin/* を使えない（403）', (await get('/api/admin/projects', staff.cookie)).status === 403)
  ok('管理者は /api/staff/* を使えない（403）', (await get('/api/staff/home', admin.cookie)).status === 403)
  ok('管理者は /api/hq/* を使えない（403）', (await get('/api/hq/cron/status', admin.cookie)).status === 403)
  const fm = await get('/api/admin/employees', field.cookie)
  const fmBody = await fm.json().catch(() => null)
  ok('現場管理者は従業員管理を使えない（403 hr_forbidden）', fm.status === 403 && fmBody?.code === 'hr_forbidden', { status: fm.status, fmBody })
  ok('会社管理者は従業員管理を使える', (await get('/api/admin/employees', admin.cookie)).status === 200)
  // 5章 定期処理の状態（本部画面）
  const cs = await get('/api/hq/cron/status', hq.cookie)
  const csBody = await cs.json().catch(() => null)
  ok('本部は定期処理の状態（latest・recent・warnings・stale_hours=25）を取れる', cs.status === 200 && Array.isArray(csBody?.latest) && Array.isArray(csBody?.warnings) && csBody?.stale_hours === 25, csBody && Object.keys(csBody))
  // 9章 同じブラウザでの別アカウント（X-Expected-User-Id が違えば 409）
  const sw409 = await get('/api/auth/me', admin.cookie, { 'X-Expected-User-Id': '999999' })
  const swBody = await sw409.json().catch(() => null)
  ok('X-Expected-User-Id が違えば 409（account_switched）', sw409.status === 409 && swBody?.code === 'account_switched', { status: sw409.status, swBody })
  // 9章 操作のたびにセッションを延ばし、期限を X-Session-Expires で返す
  ok('API の応答に X-Session-Expires（セッションの期限）を付ける', !!(await get('/api/auth/me', admin.cookie)).headers.get('x-session-expires'))
  // 4.3 予期しないエラーは参照番号付き（ここでは起こせないので、形だけをコードで確かめる）
  ok('予期しないエラーの応答は { error, ref } と 500（src/index.tsx）', /c\.json\(\{ error: msg, ref \}, 500\)/.test(idx))
}

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
