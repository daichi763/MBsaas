// 時刻に依存するテストの安定化と資料（w14-test-docs: Sprint 14 #9641 #9642）の確認
//   1) サーバーの「今日」が、テストで作る日本時間の「今日」（Date.now() + 9 時間）と同じ
//   2) テストが UTC の日付・端末のタイムゾーンの日付で「今日」を作っていない
//   3) npm test（scripts/run-tests.mjs）が、日本時間の 0 時の直前は日付が変わるまで待つ
//   4) 0 時の直後・早朝に落ちていたテストの直し（決まった時刻・逆算したシフト）が入っている
//   5) 資料: decisions.md の D-41〜D-44、backup.md の復元の練習の記録と 4-3、operations.md のローンチ当日のチェックリスト
//   6) backup.md に書いた表ごとの行数の数え方（1つの SELECT に (SELECT COUNT(*) FROM 表) を並べる）が D1 で動く（PERSIST があるとき）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること（追加の起動オプションはない）
// 実行: BASE=http://127.0.0.1:8813 PERSIST=<保存先> node scripts/test-w14-test-docs.mjs
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8813'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const DAY_MS = 24 * 3600 * 1000
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}

// ============ 1. サーバーの「今日」とテストの「今日」 ============
{
  const cookie = await login('sample', 'admin')
  const before = jstToday()
  const r = await fetch(`${BASE}/api/admin/follow-logs`, { headers: { Cookie: cookie } })
  const data = await r.json().catch(() => null)
  const after = jstToday()
  // 問い合わせの間に日付が変わったときは、どちらかと合えばよい
  ok('#9641 サーバーの「今日」（GET /api/admin/follow-logs の today）が、テストの日本時間の「今日」と同じ', r.status === 200 && data && (data.today === before || data.today === after), [r.status, data && data.today, before, after])
}

// ============ 2. テストの「今日」の作り方 ============
const testFiles = readdirSync(join(ROOT, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f)).sort()
{
  // UTC の日付をそのまま「今日」にする書き方（日本時間の 0〜9 時に前日になる）と、端末のタイムゾーンに頼る書き方
  const BAD = [
    /new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/,
    /new Date\(Date\.now\(\)\)\.toISOString\(\)\.slice\(0, ?10\)/,
    /new Date\(\)\.toISOString\(\)\.split\('T'\)/,
    /toLocaleDateString\((?![^)]*timeZone)/,
  ]
  const hits = []
  for (const f of testFiles) {
    if (f === 'test-w14-test-docs.mjs') continue
    read(`scripts/${f}`).split('\n').forEach((line, i) => { if (!line.trim().startsWith('//') && BAD.some(re => re.test(line))) hits.push(`${f}:${i + 1}`) })
  }
  ok(`#9641 テスト（${testFiles.length} 本）が UTC の日付・端末のタイムゾーンの日付で「今日」を作っていない`, !hits.length, hits)
}

// ============ 3. npm test は 0 時の直前に待つ ============
{
  const rt = read('scripts/run-tests.mjs')
  const m = rt.match(/const MIDNIGHT_WAIT_MIN = (\d+)/)
  const loop = rt.slice(rt.indexOf('for (const file of tests) {'))
  ok('#9641 run-tests.mjs: 日本時間の 0 時の直前は日付が変わるまで待つ（テストのファイルごとに、サーバーを起動する前に確かめる）',
    m && Number(m[1]) >= 10 && /async function waitPastJstMidnight\(\)/.test(rt) && /\(Date\.now\(\) \+ 9 \* 3600 \* 1000\) % DAY_MS/.test(rt)
    && loop.indexOf('await waitPastJstMidnight()') >= 0 && loop.indexOf('await waitPastJstMidnight()') < loop.indexOf('spawn('), m && m[1])
  // 待つ時間の計算（run-tests.mjs と同じ式）: 23:50 なら 10分、0:05 なら待たない
  const left = (jstMs) => DAY_MS - jstMs % DAY_MS
  const at = (hm) => Date.parse(`2026-11-03T${hm}:00Z`) // 日本時間の時刻をそのまま UTC として置いた値（式は日本時間に直した後の値を使う）
  const wait = Number(m && m[1]) * 60000
  ok('#9641 待つ時間の計算: 23:50 は 0 時まで10分（待つ）、23:30 と 0:05 は待たない',
    left(at('23:50')) === 10 * 60000 && left(at('23:50')) <= wait && left(at('23:30')) > wait && left(at('00:05')) > wait, [left(at('23:50')), left(at('23:30')), left(at('00:05'))])
  ok('#9641 結果の一覧にテストのファイルごとの秒数を出す（待つ時間の目安を決めるため）', /sec: Math\.round\(\(Date\.now\(\) - started\) \/ 1000\)/.test(rt) && /\$\{r\.sec\}秒/.test(rt))
}

// ============ 4. 0 時の直後・早朝に落ちていたテストの直し ============
{
  const cr = read('scripts/test-corrections.mjs')
  ok('#9641 test-corrections: 日をまたぐ夜勤（翌日 05:30 の追加）は4日前の日付で作る（早朝に流すと 05:30 がまだ来ていない）', /const dB = addDays\(today, -4\)/.test(cr) && !/const dB = addDays\(today, -1\)/.test(cr))
  const rs = read('scripts/test-report-settings.mjs')
  const dt = read('scripts/test-w4-dashboard-todo.mjs')
  ok('#9641 test-w4-dashboard-todo: #449 の同じ人の2シフトは、200分前が今日のときだけ確かめる（0 時の直後は SKIP）', /if \(at\(-200\)\.date === today\) \{[\s\S]{0,300}W4DT-p1/.test(dt) && /skip\('#449 同じ人の2シフト'/.test(dt))
  for (const [f, m] of [['test-w8-staff-ui.mjs', 8], ['test-w7-followup-staff-ui.mjs', 6]]) {
    const s = read(`scripts/${f}`)
    ok(`#9641 ${f}: 日本時間の 0:0${m} までは待ってから今日のシフトを作る`, s.includes(`if (sinceMidnight < ${m} * 60000)`) && s.indexOf('sinceMidnight') < s.indexOf('const today ='))
  }
  const rf = read('scripts/test-w5-report-features.mjs')
  ok('#9641 test-w5-report-features: #496 の前日の日報の mnp は、月の1日（前日が先月）なら今月の値に入らない', /const s9Mnp = addDays\(today, -1\)\.slice\(0, 7\) === today\.slice\(0, 7\) \? 1 : 0/.test(rf) && /mnp\.value === s9Mnp/.test(rf))
  ok('#9641 test-report-settings: 移行の記録の日時は「今より前で6時間以内」を見る（テスト用の DB を作ってから時間がたっても通る）', /migAge > -5 \* 60000 && migAge < 6 \* 3600000/.test(rs))
  // 今の時刻から逆算するシフト（at(-分)）を作るダッシュボードのテストは、日付が今日でないときに確かめ方を変える（SKIP か別の日付）。
  // test-w5-reminders はサーバーが前後1日のシフトを見るので、日付が変わっても同じに確かめられる（日本時間 0:05・23:58 で確認済み）
  const rel = testFiles.filter(f => !['test-w14-test-docs.mjs', 'test-w5-reminders.mjs'].includes(f) && /const at = \(offset\)/.test(read(`scripts/${f}`)))
  const unguarded = rel.filter(f => !/\.date (!==|===) today/.test(read(`scripts/${f}`)))
  ok(`#9641 今の時刻から逆算するシフトを作るテスト（${rel.length} 本）は、日付が今日かどうかを見ている`, rel.length > 0 && !unguarded.length, unguarded)
}

// ============ 5. 資料 ============
{
  const dec = read('docs/decisions.md')
  const heads = [...dec.matchAll(/^### (D-\d+) /gm)].map(m => m[1])
  const rows = [...dec.matchAll(/^\| (D-\d+) \|/gm)].map(m => m[1])
  const num = (id) => Number(id.slice(2))
  ok('#9642 decisions.md: D-41〜D-44 の見出しと一覧の行がある', ['D-41', 'D-42', 'D-43', 'D-44'].every(id => heads.includes(id) && rows.includes(id)), { heads, rows })
  ok('#9642 decisions.md: 決定の番号が重ならず、一覧と見出しが同じ', new Set(heads).size === heads.length && new Set(rows).size === rows.length && heads.length === rows.length && heads.every(h => rows.includes(h)), { heads, rows })
  ok('#9642 decisions.md: Sprint 14 の番号は既存の続き（D-40 の次から）', Math.min(...['D-41', 'D-42', 'D-43', 'D-44'].map(num)) === Math.max(...heads.filter(h => !['D-41', 'D-42', 'D-43', 'D-44'].includes(h)).map(num)) + 1)
  const sec = (id) => { const i = dec.indexOf(`### ${id} `); const j = dec.indexOf('\n### ', i + 1); return dec.slice(i, j < 0 ? undefined : j) }
  ok('#9642 D-41（#167）: 週40時間を超えた分・国民の祝日は計算せず、手で調整・設定画面に注記', /#167/.test(sec('D-41')) && /週40時間/.test(sec('D-41')) && /祝日/.test(sec('D-41')) && /手で調整/.test(sec('D-41')) && /注記/.test(sec('D-41')))
  ok('#9642 D-42（#277）: 送った後の知らせと開催場所の位置の登録で完了（送る前の警告・案件ごとの位置は作らない）', /#277/.test(sec('D-42')) && /送った後/.test(sec('D-42')) && /開催場所/.test(sec('D-42')) && /送る前の警告/.test(sec('D-42')) && /location_lat/.test(sec('D-42')))
  ok('#9642 D-43（#552）: 会社管理者にアプリ内の通知とプッシュ通知、同じ ID は1時間に1回、本部には送らない', /#552/.test(sec('D-43')) && /会社管理者/.test(sec('D-43')) && /プッシュ通知/.test(sec('D-43')) && /1時間に1回/.test(sec('D-43')) && /本部には送らない/.test(sec('D-43')))
  ok('#9642 D-44（#184）: 一覧の「成約」はテンプレートの成約の項目を合計し、ない案件は「—」', /#184/.test(sec('D-44')) && /seiyaku/.test(sec('D-44')) && /「—」/.test(sec('D-44')))

  const bk = read('docs/backup.md')
  const rec = bk.slice(bk.indexOf('## 6. 復元の練習の記録'), bk.indexOf('## 7. 関連'))
  ok('#9642 backup.md: 「復元の練習の記録」の節がある（関連は 7 に）', bk.includes('## 6. 復元の練習の記録') && bk.includes('## 7. 関連') && rec.length > 100)
  ok('#9642 backup.md: 2026-11-03 の練習の記録（ファイル・SHA-256・表 129・トリガー 14・d1_migrations 93件・最後 0093・58 の表・合計 5,532）',
    ['2026-11-03', 'd1/mbsaas-production-20261103-1731.sql.gz', 'SHA-256', '129', '14', '93件', '0093', '58', '5,532', '5xx'].every(s => rec.includes(s)), rec.slice(0, 300))
  const s43 = bk.slice(bk.indexOf('### 4-3'), bk.indexOf('4. 復元に使った'))
  ok('#9642 backup.md 4-3: SHA-256 は gzip のファイルで比べる（gunzip の前に sha256sum。.sql では合わない）',
    s43.indexOf('sha256sum restore.sql.gz') >= 0 && s43.indexOf('sha256sum restore.sql.gz') < s43.indexOf('gunzip') && /gzip のファイル（\.sql\.gz）の値/.test(s43) && /合いません/.test(s43))
  ok('#9642 backup.md 4-3: 表ごとの行数は1つの SELECT に (SELECT COUNT(*) FROM 表) を並べて数える（UNION ALL は上限に当たる・列は100まで）',
    s43.includes('(SELECT COUNT(*) FROM "&") AS "&"') && /UNION ALL/.test(s43) && s43.includes("grep -o '^INSERT INTO \"[a-z_0-9]*\"' restore.sql") && s43.includes('split -l 50') && /列は100まで/.test(s43))

  const ops = read('docs/operations.md')
  const ten = ops.slice(ops.indexOf('## 10. ローンチ当日のチェックリスト'))
  ok('#9642 operations.md: 目次と「ローンチ当日のチェックリスト」の節がある', ops.includes('| 10 | ローンチ当日のチェックリスト |') && ten.length > 100)
  ok('#9642 operations.md 10: デモ用の会社・ユーザー（pass1234・約26件）の停止かパスワードの変更（#62）', /#62/.test(ten) && /pass1234/.test(ten) && /約26件/.test(ten) && /この企業を停止する/.test(ten) && /パスワード/.test(ten))
  ok('#9642 operations.md 10: Workers Builds のビルドのログで DEMO_MODE=false を確かめる', /Workers Builds/.test(ten) && /DEMO_MODE=false/.test(ten) && ten.includes('scripts/ci-wrangler-config.mjs:31'))
  ok('#9642 operations.md 10: メールを始めるなら Resend の独自ドメイン・MAIL_FROM・RESEND_API_KEY（#36・D-31）', /#36/.test(ten) && /D-31/.test(ten) && /独自ドメイン/.test(ten) && /MAIL_FROM/.test(ten) && /RESEND_API_KEY/.test(ten))
  ok('#9642 operations.md 10: バックアップの毎日の成功・通知の受け取り、本部画面のプッシュ通知（monitoring.md）', /D1 backup/.test(ten) && /通知/.test(ten) && /この端末でプッシュ通知を受け取る/.test(ten) && ten.includes('(monitoring.md)'))
  // チェックリストに書いた本部画面のボタンの文言が、画面にある
  const hq = read('public/static/hq.js')
  ok('#9642 チェックリストに書いた本部画面のボタンが画面にある（「この企業を停止する」「この端末でプッシュ通知を受け取る」「テスト通知を送る」）',
    ['この企業を停止する', 'この端末でプッシュ通知を受け取る', 'テスト通知を送る'].every(s => hq.includes(s)))
  const wr = read('wrangler.jsonc').split('\n')
  ok('#9642 チェックリストの `wrangler.jsonc:78` は本番の MAIL_FROM の行', /"MAIL_FROM"/.test(wr[77] || '') && wr.slice(46, 77).some(l => /"production"/.test(l)), wr[77])
  ok('#9642 operations.md 2.5: 時刻に依存するテストの書き方（日本時間の今日・逆算・決まった時刻・0 時の直前の待ち）', /### 2\.5 時刻に依存するテスト/.test(ops) && /Date\.now\(\) \+ 9 \* 3600 \* 1000/.test(ops) && /23:45/.test(ops))
}

// ============ 6. 表ごとの行数の数え方が D1 で動く ============
if (!PERSIST) skip('#9642 1つの SELECT に (SELECT COUNT(*) FROM 表) を並べて数えられる', 'PERSIST がないため')
else {
  const dir = mkdtempSync(join(tmpdir(), 'w14td-'))
  const run = (sql) => {
    const file = join(dir, 'q.sql'); writeFileSync(file, sql)
    return JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }))
  }
  const tryRun = (sql) => { try { return run(sql) } catch (e) { return { error: String(e.stdout || e.message) } } }
  const tables = run(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`)[0].results.map(r => r.name)
  const col = (t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`
  // backup.md 4-3 のとおり 50 の表ずつに分けて数える
  const one = {}
  for (let i = 0; i < tables.length; i += 50) Object.assign(one, run(`SELECT ${tables.slice(i, i + 50).map(col).join(', ')}`)[0].results[0])
  ok(`#9642 1つの SELECT に (SELECT COUNT(*) FROM 表) を 50 ずつ並べて、${tables.length} の表の行数を数えられる`, tables.length > 100 && tables.every(t => Number.isInteger(one[t])), tables.length)
  // backup.md に書いた D1 の上限（列は100まで・UNION ALL は5つまで）
  const c100 = tryRun(`SELECT ${tables.slice(0, 100).map(col).join(', ')}`), c101 = tryRun(`SELECT ${tables.slice(0, 101).map(col).join(', ')}`)
  ok('#9642 D1 の上限: 1つの SELECT の列は100まで（101 は too many columns）', !c100.error && /too many columns/.test(c101.error || ''), [c100.error, c101.error])
  const u = (n) => tryRun(Array.from({ length: n }, () => 'SELECT COUNT(*) FROM users').join(' UNION ALL '))
  const u5 = u(5), u6 = u(6)
  ok('#9642 D1 の上限: UNION ALL でつなげるのは5つまで（6 は too many terms）', !u5.error && /too many terms/.test(u6.error || ''), [u5.error, u6.error])
  const sample = ['users', 'shifts', 'projects']
  const each = sample.map(t => run(`SELECT COUNT(*) AS n FROM "${t}"`)[0].results[0].n)
  ok('#9642 並べて数えた行数が、表ごとに数えた行数と同じ', sample.every((t, i) => one[t] === each[i]), [sample.map(t => one[t]), each])
}

const fail = results.filter(r => !r.pass).length
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
