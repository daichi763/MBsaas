// 確かめずに本番に出せる経路をなくす・ローンチの前のチェックリスト（作業単位 w21-release-guard: #9944 #9945）の統合テスト
//   1) PR の CI（.github/workflows/ci.yml）: main あての PR・push で、npm ci → 型チェック → ビルド → docs:check → test:ci を流す。シークレットを使わない
//   2) package.json: build（Workers Builds が使う）の最初に型チェックがある。test:ci のテストがあり、既知の失敗の2本を含まない
//   3) scripts/ci-wrangler-config.mjs: CI なのに本番の設定の wrangler.json を作れない・本番の値でないときは exit 1。CI でなければ何もしない
//      （一時フォルダに wrangler.jsonc を作って、そこで実行する。repo の wrangler.json は作らない）
//   4) 資料: operations.md の CI・ブランチの保護・ローンチの前に決めること、decisions.md の決定（D-番号が重ならない）
//   5) API: テストのサーバーがローカルの設定（wrangler.jsonc のトップレベル）で動いている（CI で wrangler.json を消し忘れていない）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --port 8712 --persist-to <保存先> で起動していること（追加の起動オプションはない）。
// 実行: BASE=http://127.0.0.1:8712 node scripts/test-w21-release-guard.mjs
//   本番には接続しない。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8712'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// ============ 1. PR の CI ============
const ciPath = '.github/workflows/ci.yml'
ok('.github/workflows/ci.yml がある', existsSync(join(ROOT, ciPath)))
const ci = existsSync(join(ROOT, ciPath)) ? read(ciPath) : ''
const onBlock = ci.split(/^on:\s*$/m)[1]?.split(/^\S/m)[0] || ''
ok('CI: main あての pull_request で動く', /pull_request:\s*\n\s+branches:\s*\[\s*main\s*\]/.test(onBlock), onBlock)
ok('CI: main への push で動く', /push:\s*\n\s+branches:\s*\[\s*main\s*\]/.test(onBlock), onBlock)
// 手順の順番: npm ci → 型チェック → ビルド → docs:check → wrangler.json を消す → test:ci
const steps = ['npm ci', 'npx tsc --noEmit -p .', 'npm run build', 'npm run docs:check', 'rm -f wrangler.json', 'npm run test:ci']
const at = steps.map(s => ci.indexOf(`run: ${s}`))
ok('CI: npm ci → 型チェック → ビルド → docs:check → wrangler.json を消す → test:ci の順に流す', at.every(i => i >= 0) && at.every((v, i) => !i || at[i - 1] < v), Object.fromEntries(steps.map((s, i) => [s, at[i]])))
ok('CI: シークレットを使わない', !/secrets\./.test(ci))
ok('CI: 本番に接続するコマンドがない（--remote・--env production・wrangler deploy・db:migrations:check・predeploy）', !/--remote|--env production|wrangler deploy|db:migrations:check|predeploy|npm run deploy/.test(ci))
ok('CI: 権限は読むだけ（permissions: contents: read）', /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(ci))
ok('CI: 資料の行番号の確かめのために履歴をすべて取る（fetch-depth: 0）', /fetch-depth:\s*0/.test(ci))
ok('CI: Node.js 22 以上', /node-version:\s*(2[2-9]|[3-9]\d)/.test(ci))
ok('既存の d1-backup.yml は残っている', existsSync(join(ROOT, '.github/workflows/d1-backup.yml')))

// ============ 2. package.json ============
const pkg = JSON.parse(read('package.json'))
const build = pkg.scripts.build || ''
ok('build の最初に型チェックがある（型のエラーで vite build の前に止まる）', /^npm run typecheck && /.test(build) && build.indexOf('typecheck') < build.indexOf('vite build'), build)
ok('build の最後に scripts/ci-wrangler-config.mjs がある', /&& node scripts\/ci-wrangler-config\.mjs$/.test(build), build)
ok('typecheck は tsc --noEmit -p .', pkg.scripts.typecheck === 'tsc --noEmit -p .', pkg.scripts.typecheck)
const testCi = pkg.scripts['test:ci'] || ''
ok('test:ci は scripts/run-tests.mjs を使う', /^node scripts\/run-tests\.mjs /.test(testCi), testCi)
const filters = testCi.split(/\s+/).slice(2).filter(a => !a.startsWith('--'))
const testFiles = readdirSync(join(ROOT, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f))
const picked = testFiles.filter(f => filters.some(q => f.includes(q)))
ok('test:ci の絞り込みの文字は、それぞれ1本のテストにだけ当たる', filters.length >= 3 && filters.every(q => testFiles.filter(f => f.includes(q)).length === 1), Object.fromEntries(filters.map(q => [q, testFiles.filter(f => f.includes(q))])))
ok('test:ci に既知の失敗の2本（D-33）を含まない', !picked.some(f => /test-history|w4-notifications-mail/.test(f)), picked)
ok('test:ci にこのテストを含む', picked.includes('test-w21-release-guard.mjs'), picked)
// 外に接続するテスト（127.0.0.1・localhost 以外の URL を fetch する）を入れない
const external = picked.filter(f => /fetch\(\s*['"`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(readFileSync(join(ROOT, 'scripts', f), 'utf8')))
ok('test:ci のテストは外に接続しない', !external.length, external)

// ============ 3. scripts/ci-wrangler-config.mjs ============
const SCRIPT = join(ROOT, 'scripts', 'ci-wrangler-config.mjs')
const baseConf = read('wrangler.jsonc')
// CI の環境変数を外した環境（GitHub Actions の中で流しても「CI でない」を試せるように）
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CI' && !k.startsWith('WORKERS_CI')))
function runConfig({ conf = baseConf, env = {}, staleJson = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w21rg-'))
  try {
    if (conf !== null) writeFileSync(join(dir, 'wrangler.jsonc'), conf)
    if (staleJson) writeFileSync(join(dir, 'wrangler.json'), '{"name":"stale"}\n')
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: { ...cleanEnv, ...env }, encoding: 'utf8' })
    const jsonPath = join(dir, 'wrangler.json')
    const json = existsSync(jsonPath) ? readFileSync(jsonPath, 'utf8') : null
    return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), json }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
// wrangler.jsonc の env.production の中だけを書き換える
const prodStart = baseConf.indexOf('"production": {')
const editProd = (from, to) => {
  const i = baseConf.indexOf(from, prodStart)
  if (prodStart < 0 || i < 0) throw new Error(`wrangler.jsonc の env.production に ${from} がない`)
  return baseConf.slice(0, i) + to + baseConf.slice(i + from.length)
}

{
  const r = runConfig()
  ok('CI でないときは何もしない（exit 0・wrangler.json を作らない）', r.status === 0 && r.json === null, r)
}
{
  const r = runConfig({ staleJson: true })
  ok('CI でないのに wrangler.json が残っていると注意を出す（ビルドは止めない）', r.status === 0 && /wrangler\.json（本番の設定）が残っています/.test(r.out), r)
}
for (const env of [{ CI: 'true' }, { CI: '1' }, { WORKERS_CI: '1' }, { WORKERS_CI_BUILD_UUID: 'x' }]) {
  const r = runConfig({ env })
  let j = null
  try { j = JSON.parse(r.json) } catch { }
  ok(`CI（${JSON.stringify(env)}）では本番の設定の wrangler.json を作る`, r.status === 0 && j && j.vars.DEMO_MODE === 'false' && j.vars.RETENTION_ENABLED === 'true' && j.vars.MAIL_ENABLED === 'true'
    && /^https:\/\//.test(j.vars.APP_BASE_URL) && j.preview_urls === false && j.observability?.enabled === true && /wrangler\.json を本番の設定で作成しました/.test(r.out), { status: r.status, out: r.out, vars: j?.vars })
}
{
  const r = runConfig({ env: { CI: 'false' } })
  ok('CI=false は CI とみなさない', r.status === 0 && r.json === null, r)
}
const failCases = [
  ['wrangler.jsonc がない', null],
  ['wrangler.jsonc が壊れている', baseConf.replace('"env": {', '"env": {{')],
  ['env.production がない', baseConf.replace('"production": {', '"production_old": {')],
  ['本番の DEMO_MODE が "true"', editProd('"DEMO_MODE": "false"', '"DEMO_MODE": "true"')],
  ['本番の RETENTION_ENABLED が "false"', editProd('"RETENTION_ENABLED": "true"', '"RETENTION_ENABLED": "false"')],
  ['本番の MAIL_ENABLED がない', editProd('"MAIL_ENABLED": "true",', '')],
  ['本番の APP_BASE_URL が localhost', editProd('"APP_BASE_URL": "https://app.mobital.jp"', '"APP_BASE_URL": "http://localhost:8787"')],
  ['本番の APP_BASE_URL が http', editProd('"APP_BASE_URL": "https://', '"APP_BASE_URL": "http://')],
  ['本番の preview_urls が true', editProd('"preview_urls": false', '"preview_urls": true')],
  ['本番の observability がない', editProd('"observability": {', '"observability_old": {')],
]
for (const [name, conf] of failCases) {
  let r
  try { r = runConfig({ conf, env: { CI: 'true' } }) } catch (e) { ok(`CI で${name}ときはビルドを止める`, false, String(e)); continue }
  ok(`CI で${name}ときはビルドを止める（exit 1・wrangler.json を残さない）`, r.status === 1 && r.json === null && /ビルドを止めます/.test(r.out), r)
}

// ============ 4. 資料 ============
const ops = read('docs/operations.md')
const dec = read('docs/decisions.md')
ok('operations.md: PR の CI の説明（2.6）がある', /### 2\.6 PR の CI/.test(ops) && ops.includes('test:ci'))
ok('operations.md: ブランチの保護の手順（3.5）があり、利用者の判断の後に設定すると書いている', /### 3\.5 ブランチの保護/.test(ops) && /利用者が判断してから設定します/.test(ops) && /Require status checks to pass before merging/.test(ops))
const launch = ops.split('### 10.6 ')[1] || ''
const items = ['VAPID', 'RATE_LIMIT_SALT', 'Turnstile', '独自ドメイン', '有料プラン', 'Resend', '4ロール', 'pass1234', 'API トークン', 'ブランチの保護']
ok('operations.md: ローンチの前に決めること（10.6）に必要な項目がある', items.every(k => launch.includes(k)), items.filter(k => !launch.includes(k)))
ok('operations.md: ローンチのチェックリストの表から 10.6 へ案内している', /\| 0 \| ローンチの前に決めることを決め、設定を済ませている \| 下の 10\.6 \|/.test(ops))
ok('operations.md: 3.2 の 5 に、ビルドが型のエラー・本番の設定で止まることを書いている', /型のエラーがあるとき、または本番の設定の `wrangler\.json` を作れなかったとき/.test(ops))
// D-番号: 一覧の表と本文の見出しが1対1で、重ならない
const tableIds = [...dec.matchAll(/^\| (D-\d+) \|/gm)].map(m => m[1])
const headIds = [...dec.matchAll(/^### (D-\d+) /gm)].map(m => m[1])
const dup = (a) => a.filter((x, i) => a.indexOf(x) !== i)
ok('decisions.md: D-番号が一覧の表で重ならない', !dup(tableIds).length, dup(tableIds))
ok('decisions.md: D-番号が見出しで重ならない', !dup(headIds).length, dup(headIds))
ok('decisions.md: 一覧の表と見出しの D-番号が合う', JSON.stringify([...tableIds].sort()) === JSON.stringify([...headIds].sort()), { onlyTable: tableIds.filter(x => !headIds.includes(x)), onlyHead: headIds.filter(x => !tableIds.includes(x)) })
// 見出し（### D-xx ...）の1行目に title がある節（一覧の表の行は対象にしない）
const sectionOf = (title) => dec.split(/^### /m).find(s => /^D-\d+ /.test(s) && s.split('\n')[0].includes(title)) || ''
const roles = sectionOf('会社全体の設定の一部は、今は管理者の4ロールのまま')
ok('decisions.md: site-contact・day-before-check を4ロールのままにし、Sprint 24 で決める決定がある', /site-contact/.test(roles) && /day-before-check/.test(roles) && /Sprint 24/.test(roles) && /2026-11-09/.test(roles))
const forgot = sectionOf('「パスワードを忘れた」は、メールを送れない間も今のまま出す')
ok('decisions.md:「パスワードを忘れた」を今のまま出す決定がある', /D-31/.test(forgot) && /feat-other-02/.test(forgot))
ok('decisions.md: 既存の決定（D-30・D-31・D-32・D-49・D-50）を消していない', ['### D-30 ', '### D-31 ', '### D-32 ', '### D-49 ', '### D-50 '].every(h => dec.includes(h)))

// ============ 5. API: テストのサーバーはローカルの設定で動いている ============
// CI はビルドで本番の設定の wrangler.json を作るので、テストの前に消す。消し忘れると wrangler dev が本番の vars（DEMO_MODE=false など）で動く
try {
  const r = await fetch(`${BASE}/login`)
  const html = await r.text()
  ok('GET /login が 200', r.status === 200, r.status)
  ok('テストのサーバーはローカルの設定（DEMO_MODE=true）で動いている（本番の設定の wrangler.json を読んでいない）', html.includes('id="demo-account-aside"'))
} catch (e) {
  ok('テストのサーバーにつながる', false, String(e))
}
ok('repo に wrangler.json が残っていない（テストの前に消している）', !existsSync(join(ROOT, 'wrangler.json')))

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
