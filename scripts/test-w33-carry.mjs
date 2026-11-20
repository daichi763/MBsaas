// w33-carry（持ち越しの残り: #9997 #22 #570 #69 #87 #447 #13 #548 #393 #10002）の統合テスト
//  - #13: 本部で停止にした企業は、定期処理のお知らせの予約配信・既読率レポートの集計の対象から外す。契約ユーザー数の超過は本部の一覧に出す
//  - #447: スキルシートの推薦コメントを保存・読み出しできる（長文も切れない・空欄で消える）
//  - #22: clients を JOIN するところには、すべて会社の条件がある（src の静的な確認）
//  - #393: 「打刻を修正」のボタンが、スタッフ詳細のシフト・精算の要確認の行・シフトの詳細にある（画面のコードの静的な確認）
//  - #10002: 持ち主のいないドメインのメールアドレスが、リポジトリに残っていない（seed の管理者は予約済みのドメイン）
//  #9997 は scripts/test-w26-summary.mjs の側の直し、#570 #69 #87 #548 は既存のテスト（test-w7-followup-server-a/b・test-w4-corrections-admin など）で確かめる
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `npx wrangler dev --local --test-scheduled --port 9023 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9023 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w33-carry.mjs
//   本番には接続しない
// run-tests: --test-scheduled
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:9023'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

// d1() で待つ間に開発サーバーが閉じた接続を使い回すと ECONNRESET になるので、そのときは1回だけ送り直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e && e.cause && e.cause.code === 'ECONNRESET') return rawFetch(...args); throw e } }
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
function d1(sql) {
  const out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
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
const jst = (ms = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst().slice(0, 10)
const tag = Date.now().toString(36).slice(-5)
const src = (p) => readFileSync(join(ROOT, p), 'utf8')
function walk(dir, out = []) {
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = `${dir}/${f}`
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

const admin = client(await login('sample', 'admin'))
const hq = client(await login('', 'hq'))

// ---------- #22: clients の JOIN には会社の条件を付ける ----------
{
  const missing = []
  for (const f of walk('src')) {
    src(f).split('\n').forEach((line, i) => {
      // JOIN clients <別名> ON … の行に company_id の条件があるか（条件は同じ行に書いている）
      if (/JOIN\s+clients\s+\w+\s+ON\b/i.test(line) && !/company_id/.test(line.slice(line.search(/JOIN\s+clients/i)))) missing.push(`${f}:${i + 1}`)
    })
  }
  ok('#22 clients を JOIN するところには、すべて会社の条件（company_id）がある', missing.length === 0, missing)
}

// ---------- #393: 「打刻を修正」のボタン ----------
{
  const has = (file, from) => { const s = src(file); const at = s.indexOf(from); return at >= 0 && s.slice(at, at + 6000).includes('data-action="corrNew"') }
  ok('#393 スタッフ詳細のシフト（renderStaffShiftPanel）に「打刻を修正」がある', has('public/static/shift-board.js', 'window.renderStaffShiftPanel'))
  ok('#393 精算の要確認の行に「打刻を修正」がある', /data-action="corrNew"[^\n]*打刻を修正/.test(src('public/static/settlement.js')))
  ok('#393 シフトの詳細（staff-lifecycle.js）に「打刻を修正」がある', /data-action="corrNew"[^\n]*打刻を修正/.test(src('public/static/staff-lifecycle.js')))
}

// ---------- #10002: 持ち主のいないドメインのメールアドレスを残さない ----------
{
  // このファイル自身が当たらないよう、探す文字は分けて組み立てる
  const pattern = ['dissectra', 'co', 'jp'].join('\\.') + '|' + ['sample-mobile', 'jp'].join('\\.')
  let hits = ''
  try { hits = execFileSync('git', ['-C', ROOT, 'grep', '-n', '-i', '-E', pattern], { encoding: 'utf8' }) } catch (e) { hits = e.status === 1 ? '' : String(e.stdout || e.message) }
  ok('#10002 リポジトリに持ち主のいないドメイン（dissectra・sample-mobile の .jp）のメールアドレスが無い', hits.trim() === '', hits.slice(0, 400))
  const [rows] = d1(`SELECT user_id, email FROM users WHERE user_id IN (1, 2, 3, 100) ORDER BY user_id`)
  ok('#10002 seed の管理者・本部のメールアドレスは予約済みのドメイン（example.jp）', rows.length === 4 && rows.every(r => /@([a-z0-9-]+\.)*example\.jp$/.test(r.email)), rows)
  const seedSrc = src('seed.sql'), genSrc = src('scripts/gen_seed.cjs')
  ok('#10002 seed.sql と gen_seed.cjs のアドレスがそろっている', ['admin@sample-mobile.example.jp', 'fujita@sample-mobile.example.jp', 'okamoto@sample-mobile.example.jp', 'hq@hq.example.jp']
    .every(a => seedSrc.includes(a) && genSrc.includes(a)))
}

// ---------- #447: スキルシートの推薦コメントを保存する ----------
{
  const staff = (await admin.get('/api/admin/staff')).data.staff.find(s => s.affiliation_type !== 'linked_external' && !s.merged_into_staff_id)
  const sid = staff.staff_id
  const long = `${tag} 推薦コメントの1行目\n` + 'とても丁寧な接客で、成約率が高いスタッフです。'.repeat(30) + '\n最後の行'
  const put = await admin.put(`/api/admin/staff/${sid}/skill-sheet-comment`, { comment: long })
  const got = await admin.get(`/api/admin/staff/${sid}/skill-sheet`)
  ok('#447 推薦コメントを保存すると、スキルシートに同じ内容（長文・改行のまま）が返る', put.status === 200 && got.status === 200 && got.data.skill_sheet_comment === long.trim(),
    { put: put.status, len: String(got.data?.skill_sheet_comment || '').length })
  const tooLong = await admin.put(`/api/admin/staff/${sid}/skill-sheet-comment`, { comment: 'あ'.repeat(1001) })
  const bad = await admin.put(`/api/admin/staff/${sid}/skill-sheet-comment`, { comment: 123 })
  ok('#447 1000文字を超える・文字でないコメントは 400（保存した値は変わらない）', tooLong.status === 400 && bad.status === 400
    && (await admin.get(`/api/admin/staff/${sid}/skill-sheet`)).data.skill_sheet_comment === long.trim(), [tooLong.status, bad.status])
  const clear = await admin.put(`/api/admin/staff/${sid}/skill-sheet-comment`, { comment: '  ' })
  ok('#447 空欄で保存すると、コメントが消える', clear.status === 200 && (await admin.get(`/api/admin/staff/${sid}/skill-sheet`)).data.skill_sheet_comment === '')
  const memo = await admin.get(`/api/admin/staff/${sid}/skill-sheet`)
  ok('#447 スキルシートに管理者メモ（社内用）は返さない', memo.status === 200 && memo.data.profile && !('memo' in memo.data.profile), Object.keys(memo.data.profile || {}).filter(k => /memo/.test(k)))
}

// ---------- #13: 停止中の企業を定期処理の対象から外す・契約ユーザー数の超過の警告 ----------
{
  const [[co1]] = d1(`SELECT user_limit FROM companies WHERE company_id = 1`)
  const [[co2]] = d1(`SELECT company_id, active_status FROM companies WHERE company_id = 2`)
  const pastAt = jst(Date.now() - 30 * 60 * 1000)
  try {
    d1(`UPDATE companies SET active_status = 'inactive' WHERE company_id = 2; UPDATE companies SET user_limit = 1 WHERE company_id = 1`)
    // 予約配信のお知らせ（予約の時刻を過ぎたもの）を、稼働中の企業（1）と停止中の企業（2）に1件ずつ入れる。メールは送らない
    d1(`INSERT INTO notices (company_id, title, body, status, published_at, send_email) VALUES (1, 'W33C 予約 稼働中 ${tag}', '本文', 'scheduled', '${pastAt}', 0), (2, 'W33C 予約 停止中 ${tag}', '本文', 'scheduled', '${pastAt}', 0)`)
    // 既読率レポートの集計が、企業1・2を最初に処理するように、両社の集計の行を消しておく（テスト用の DB のみ）
    d1(`DELETE FROM notice_read_reports WHERE company_id IN (1, 2)`)
    const r15 = await fetch(`${BASE}/__scheduled?cron=*/15+*+*+*+*`)
    const r330 = await fetch(`${BASE}/__scheduled?cron=30+18+*+*+*`)
    ok('#13 定期処理（15分おき・3:30）を起動できる', r15.status === 200 && r330.status === 200, [r15.status, r330.status])
    const [ns] = d1(`SELECT company_id, status FROM notices WHERE title LIKE 'W33C 予約 %${tag}' ORDER BY company_id`)
    ok('#13 稼働中の企業の予約のお知らせは、定期処理で配信する', ns.find(n => n.company_id === 1)?.status === 'published', ns)
    ok('#13 停止中の企業の予約のお知らせは、定期処理では配信しない（予約のまま残す）', ns.find(n => n.company_id === 2)?.status === 'scheduled', ns)
    const [rp] = d1(`SELECT company_id, COUNT(*) AS n FROM notice_read_reports WHERE company_id IN (1, 2) AND calculated_at >= '${today}' GROUP BY company_id`)
    ok('#13 既読率レポートの集計は、稼働中の企業だけ（停止中の企業は集計しない）', rp.some(r => r.company_id === 1) && !rp.some(r => r.company_id === 2), rp)
    const [[run]] = d1(`SELECT status FROM cron_runs WHERE job = 'notice_scheduled_publish' ORDER BY run_id DESC LIMIT 1`)
    ok('#13 お知らせの予約配信の定期処理は失敗にならない', run && run.status !== 'failed', run)
    // 本部の一覧: 契約ユーザー数を超えた企業に over_limit が付く（警告のみ。ブロックはしない）
    const list = await hq.get('/api/hq/companies')
    const c1 = (list.data.companies || []).find(c => c.company_id === 1)
    ok('#13 本部の企業一覧で、契約ユーザー数を超えた企業に超過の印（over_limit）が付く', list.status === 200 && c1 && c1.over_limit === true, c1 && { user_count: c1.user_count, user_limit: c1.user_limit, over_limit: c1.over_limit })
  } finally {
    d1(`UPDATE companies SET active_status = ${co2.active_status == null ? 'NULL' : `'${co2.active_status}'`} WHERE company_id = 2; UPDATE companies SET user_limit = ${co1.user_limit == null ? 'NULL' : Number(co1.user_limit)} WHERE company_id = 1`)
    d1(`DELETE FROM notices WHERE title LIKE 'W33C 予約 %${tag}'`)
  }
  // 再開した後は、次の定期処理で配信する
  d1(`INSERT INTO notices (company_id, title, body, status, published_at, send_email) VALUES (2, 'W33C 再開後 ${tag}', '本文', 'scheduled', '${pastAt}', 0)`)
  await fetch(`${BASE}/__scheduled?cron=*/15+*+*+*+*`)
  const [[after]] = d1(`SELECT status FROM notices WHERE title = 'W33C 再開後 ${tag}'`)
  ok('#13 停止を解いた企業の予約のお知らせは、次の定期処理で配信する', after?.status === 'published', after)
  d1(`DELETE FROM notices WHERE title = 'W33C 再開後 ${tag}'`)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
