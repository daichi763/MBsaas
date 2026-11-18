// アカウントの使い回しの疑い（Sprint 31 #9989。作業単位 w31-share-detect）の統合テスト
//   - ログインの記録に、接続元のおおよその場所（国・都道府県・市）と、別の種類の端末で使っている間のログインかを残す（ログインは止めない）
//   - 本部の「使い回しの疑い」: 手がかり（同時の利用・端末の数・離れた場所・打刻の場所・打刻の端末）を点数にして一覧に出す。企業詳細にも出す
//   - 決まりの値は本部の画面で変えられる。確認の結果（問題なし・会社に連絡した）とメモを残し、次の集計でも前回の結果を出す
//   - 会社の画面・API には出さない（/api/hq/* だけ）。週に1回の定期処理（3:30 の起動）で集計する
//   - 集計の読み取り行数: 期間の外の古いログイン・打刻をいくら足しても、読んだ行数（meta.rows_read）がほとんど増えない
//   - 1年で消す（データ保持）・解約した会社の削除の対象（書き出さない）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --test-scheduled --port 9021 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node scripts/test-w31-share.mjs
//   PERSIST は必須（ログインの履歴・シフト・打刻をローカルの D1 に直接書き込む。テスト用の DB 専用。wrangler d1 execute は --local のみ）。
//   本番には接続しない。テストのたびに DB を作り直すこと（npm test -- w31-share なら自動で行う）。
// run-tests: --test-scheduled
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
if (!PERSIST) { console.log('FAIL  PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphone2: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.5.0',
}

async function tryLogin(company_code, user_code, ua) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ua ? { 'User-Agent': ua } : {}) }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, ua) {
  const r = await tryLogin(company_code, user_code, ua)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 2) throw e }
  }
}
async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await rawFetch(`${BASE}/api/health`); if (r.status < 500) return } catch { }
    await sleep(500)
  }
}
async function sql(q) { const r = d1(q); await waitServer(); return r[r.length - 1] || [] }
const iso = (ms) => new Date(ms).toISOString()
const jst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const jstDay = (ms) => jst(ms).slice(0, 10)
const NOW = Date.now(), H = 3600e3, D = 86400e3
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
// ログインの成功の行（直接入れる）
const ev = (uid, ms, o = {}) => `(1, ${uid}, 'sample', 'x', 'login', 'success', 'password', '203.0.113.9', ${q(o.ua || UA.iphone)}, NULL, ${q(iso(ms))},
  ${o.country ? q(o.country) : 'NULL'}, ${o.region ? q(o.region) : 'NULL'}, ${o.cdev ? q(o.cdev) : 'NULL'}, ${o.cmin ?? 'NULL'})`
const EV_COLS = 'company_id, user_id, company_code, user_code, event_type, result, method, ip, user_agent, actor_user_id, created_at, country, region_code, concurrent_device, concurrent_minutes'

// ============ 0. 本部だけ ============
const hq = client(await login('', 'hq'))
const admin = client(await login('sample', 'admin'))
const staff = client(await login('sample', 'st010'))
{
  const a = await admin.get('/api/hq/share-detect'), s = await staff.get('/api/hq/share-detect'), a2 = await admin.get('/api/hq/share-detect/summary')
  ok('#9989 会社の管理者・スタッフは「使い回しの疑い」の API を使えない（403）', a.status === 403 && s.status === 403 && a2.status === 403, [a.status, s.status, a2.status])
  const h = await hq.get('/api/hq/share-detect')
  ok('#9989 本部は一覧を開ける（まだ集計していなければ集計なし）', h.status === 200 && h.data.run === null && Array.isArray(h.data.items) && h.data.items.length === 0 && h.data.defs && h.data.settings.device_threshold === 4, h.text.slice(0, 300))
  const page = await fetch(`${BASE}/admin`, { headers: { Cookie: (await login('sample', 'admin')) } }).then(r => r.text())
  ok('#9989 会社の管理画面には「使い回し」の文言を出さない', !page.includes('使い回し'))
  const hqPage = await fetch(`${BASE}/hq`, { headers: { Cookie: (await login('', 'hq')) } }).then(r => r.text())
  ok('#9989 本部の画面に「使い回しの疑い」のタブ', hqPage.includes('data-tab="sharing"') && hqPage.includes('使い回しの疑い'))
}

// ============ 1. ログインの記録 ============
{
  await login('sample', 'st005', UA.iphone)           // 1台目（iPhone）
  await login('sample', 'st005', UA.win)              // 別の Cookie（別の端末）から Windows でログイン
  await login('sample', 'st006', UA.android)
  await login('sample', 'st006', UA.android)          // 同じ種類の端末からもう一度（数えない）
  const r = await sql(`SELECT user_id, user_agent, country, region_code, region, city, concurrent_device, concurrent_minutes FROM login_events
    WHERE user_id IN (8, 9) AND event_type = 'login' AND result = 'success' ORDER BY event_id`)
  const st5 = r.filter(x => x.user_id === 8), st6 = r.filter(x => x.user_id === 9)
  ok('#9989 ログインの記録に国・都道府県・市の列がある（手元では Cloudflare の値が無いことがある）', r.length >= 4 && ['country', 'region_code', 'region', 'city'].every(k => k in r[0]), r[0])
  ok('#9989 別の種類の端末のセッションを使っている間のログインは、その端末と経過の分を残す', st5.length === 2 && st5[0].concurrent_device === null
    && st5[1].concurrent_device === 'iPhone / Safari' && st5[1].concurrent_minutes >= 0 && st5[1].concurrent_minutes <= 2, st5)
  ok('#9989 同じ種類の端末からのログインは、同時の利用として残さない', st6.length === 2 && st6.every(x => x.concurrent_device === null), st6)
  const s5 = await sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 8 AND expires_at > '${iso(NOW)}'`)
  ok('#9989 同時にログインしても、前の端末のセッションは消さない（止めない・締め出さない）', s5[0].n === 2, s5)
}

// ============ 2. 手がかりのデータ（直近の7日・30日のログイン、打刻） ============
const T = NOW - 2 * D // 2日前
const day2 = jstDay(T)
await sql(`INSERT INTO login_events (${EV_COLS}) VALUES
  ${[
    // mgr01（user 2・現場管理者）: iPhone を使っている間に Windows から3回（30分以内）＋ 100分前のもの（管理者の決まりの外）
    ev(2, T, { ua: UA.win, cdev: 'iPhone / Safari', cmin: 5 }), ev(2, T + H, { ua: UA.win, cdev: 'iPhone / Safari', cmin: 0 }), ev(2, T + 3 * H, { ua: UA.win, cdev: 'iPhone / Safari', cmin: 12 }),
    ev(2, T + 5 * H, { ua: UA.win, cdev: 'iPhone / Safari', cmin: 100 }),
    // st001（user 4）: 30日で5種類の端末（iPhone の版違いは同じ種類）
    ev(4, NOW - 20 * D, { ua: UA.iphone }), ev(4, NOW - 15 * D, { ua: UA.iphone2 }), ev(4, NOW - 10 * D, { ua: UA.android }), ev(4, NOW - 8 * D, { ua: UA.win }),
    ev(4, NOW - 5 * D, { ua: UA.mac }), ev(4, NOW - 3 * D, { ua: UA.ipad }),
    // st002（user 5）: 東京 → 30分後に大阪（約400km）。東京 → 神奈川は近いので数えない
    ev(5, T, { country: 'JP', region: '13' }), ev(5, T + 30 * 60e3, { country: 'JP', region: '27' }), ev(5, T + 10 * H, { country: 'JP', region: '13' }), ev(5, T + 10.3 * H, { country: 'JP', region: '14' }),
    // st003（user 6）: 東京 → 20分後に神奈川だけ（数えない）
    ev(6, T, { country: 'JP', region: '13' }), ev(6, T + 20 * 60e3, { country: 'JP', region: '14' }),
    // st008（user 11）: 40日前に6種類（期間の外）
    ...[UA.iphone, UA.android, UA.win, UA.mac, UA.ipad, UA.line].map((ua, i) => ev(11, NOW - 40 * D + i * H, { ua })),
    // 本部のアカウント（user 100）: 端末が多くても出さない
    ...[UA.iphone, UA.android, UA.win, UA.mac, UA.ipad].map((ua, i) => ev(100, NOW - 3 * D + i * H, { ua })),
  ].join(',\n')}`)
// st004（staff 4）: 同じ日に2つのシフトで、10分の間に新宿と名古屋（約260km）から、別の種類の端末で打刻
// st007（staff 7）: 出発（さいたま）→ 50分後に入店（新宿。約20km）は移動できるので数えない
await sql(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, memo) VALUES
  (1, 4, 1, '${day2}', '10:00', '18:00', 'confirmed', 'w31-share-a'), (1, 4, 1, '${day2}', '10:00', '18:00', 'confirmed', 'w31-share-b'), (1, 7, 1, '${day2}', '09:00', '18:00', 'confirmed', 'w31-share-c')`)
await sql(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, device_info, status, entry_method) VALUES
  (1, 4, (SELECT shift_id FROM shifts WHERE memo = 'w31-share-a'), 'check_in', '${day2} 10:00:00', 35.6896, 139.6983, ${q(UA.iphone)}, 'normal', 'app'),
  (1, 4, (SELECT shift_id FROM shifts WHERE memo = 'w31-share-b'), 'check_in', '${day2} 10:10:00', 35.1709, 136.8815, ${q(UA.android)}, 'normal', 'app'),
  (1, 7, (SELECT shift_id FROM shifts WHERE memo = 'w31-share-c'), 'departure', '${day2} 08:00:00', 35.8617, 139.6455, ${q(UA.iphone)}, 'normal', 'app'),
  (1, 7, (SELECT shift_id FROM shifts WHERE memo = 'w31-share-c'), 'check_in', '${day2} 08:50:00', 35.6896, 139.6983, ${q(UA.iphone)}, 'normal', 'app')`)

// ============ 3. 集計 ============
const byUser = (items) => Object.fromEntries((items || []).map(i => [i.user_id, i]))
const codes = (it) => (it?.reasons || []).map(r => r.code).sort().join(',')
let run1
{
  const r = await hq.post('/api/hq/share-detect/run')
  run1 = r.data?.run
  ok('#9989 本部の「今すぐ集計する」で集計できる', r.status === 200 && run1 && run1.status === 'ok' && run1.run_id > 0 && run1.rows_read > 0, r.text.slice(0, 300))
  const again = await hq.post('/api/hq/share-detect/run')
  ok('#9989 集計は5分に1回まで（429）', again.status === 429, again.status)
  const l = await hq.get('/api/hq/share-detect')
  const u = byUser(l.data.items)
  ok('#9989 管理者: 別の端末を使っている間のログイン3回（決まりの30分以内だけ数える）で「同時の利用」', codes(u[2]) === 'concurrent' && u[2].reasons[0].count === 3 && u[2].score === 40 && /iPhone \/ Safari/.test(u[2].reasons[0].detail), u[2])
  ok('#9989 30日で5種類の端末（iPhone の版違いは同じ種類）で「端末の種類が多い」', codes(u[4]) === 'many_devices' && u[4].reasons[0].count === 5 && u[4].score === 50, u[4])
  ok('#9989 30分のうちに東京と大阪からログインで「離れた場所」（東京と神奈川は数えない）', codes(u[5]) === 'far_apart' && u[5].reasons[0].count === 1 && /東京都→大阪府/.test(u[5].reasons[0].detail), u[5])
  ok('#9989 10分で新宿と名古屋から打刻・同じ日に別の端末で打刻で、打刻の2つの手がかり（50+30点）', codes(u[7]) === 'punch_devices,punch_far' && u[7].score === 80 && u[7].first_at && u[7].first_at.startsWith(day2), u[7])
  ok('#9989 疑いのない人は出さない（神奈川の隣・移動できる打刻・期間の外・同じ種類の端末・本部のアカウント）', [6, 9, 10, 11, 100].every(id => !u[id]), Object.keys(u))
  ok('#9989 同時の利用1回＋集計の時点で2つの端末（2回）は、既定の決まり（3回）では出さない', !u[8], u[8])
  ok('#9989 一覧は点数の高い順で、会社名・アカウントを付ける', l.data.items[0].user_id === 7 && l.data.items[0].company_name && l.data.items[0].user_code === 'st004' && l.data.items.every(i => i.review_status === 'open'), l.data.items.map(i => [i.user_id, i.score]))
  const c = await hq.get('/api/hq/share-detect?company_id=1')
  ok('#9989 企業詳細の欄（company_id）でも同じ行を出す', c.status === 200 && c.data.items.length === l.data.items.length && c.data.items.every(i => i.company_id === 1), c.data?.items?.length)
  const sm = await hq.get('/api/hq/share-detect/summary')
  ok('#9989 上のタブの数字（未確認の件数）', sm.status === 200 && sm.data.open === l.data.items.length && sm.data.run_id === run1.run_id, sm.data)
  ok('#9989 次の定期の集計の目安を返す', /^\d{4}-\d{2}-\d{2} 03:30$/.test(l.data.next_run_at || ''), l.data.next_run_at)
}

// ============ 4. 確認の結果 ============
{
  const l = (await hq.get('/api/hq/share-detect')).data
  const it = l.items.find(i => i.user_id === 2)
  const bad = await hq.put(`/api/hq/share-detect/items/${it.suspicion_id}/review`, { status: 'stop' })
  const long = await hq.put(`/api/hq/share-detect/items/${it.suspicion_id}/review`, { status: 'ok', note: 'あ'.repeat(501) })
  const none = await hq.put('/api/hq/share-detect/items/999999/review', { status: 'ok' })
  ok('#9989 確認の結果の入力の誤りは 400・ない行は 404', bad.status === 400 && long.status === 400 && none.status === 404, [bad.status, long.status, none.status])
  const r = await hq.put(`/api/hq/share-detect/items/${it.suspicion_id}/review`, { status: 'ok', note: '同じ人のスマホとパソコンと確認した' })
  const after = byUser((await hq.get('/api/hq/share-detect')).data.items)[2]
  ok('#9989 確認の結果（問題なし）とメモ・確認した人を残す', r.status === 200 && after.review_status === 'ok' && after.review_note === '同じ人のスマホとパソコンと確認した' && after.reviewer_name && after.reviewed_at, after)
  const au = await sql(`SELECT action, company_id, before_json, after_json FROM hq_audit_logs WHERE action LIKE 'share.%' ORDER BY log_id`)
  ok('#9989 本部の操作の履歴に、集計と確認の結果（前後の値）を残す', au.some(a => a.action === 'share.run') && au.some(a => a.action === 'share.review' && a.company_id === 1 && /"review_status":"open"/.test(a.before_json) && /"review_status":"ok"/.test(a.after_json)), au)
  const sm = (await hq.get('/api/hq/share-detect/summary')).data
  ok('#9989 確認した分は未確認の件数から外れる', sm.open === l.items.length - 1, sm)
}

// ============ 5. 決まりの値 ============
{
  const bad = await hq.put('/api/hq/share-detect/settings', { device_threshold: 1 })
  const bad2 = await hq.put('/api/hq/share-detect/settings', { device_group: 3 })
  ok('#9989 決まりの値の範囲の外は 400', bad.status === 400 && bad.data.field === 'device_threshold' && bad2.status === 400, [bad.status, bad.data, bad2.status])
  const r = await hq.put('/api/hq/share-detect/settings', { concurrent_min_count: 2, device_threshold: 4 })
  ok('#9989 決まりの値を変えられる（変わった項目だけ記録する）', r.status === 200 && r.data.changed === 1 && r.data.settings.concurrent_min_count === 2, r.data)
  const au = await sql(`SELECT before_json, after_json FROM hq_audit_logs WHERE action = 'share.settings' ORDER BY log_id DESC LIMIT 1`)
  ok('#9989 決まりの変更を本部の操作の履歴に残す', au[0] && JSON.parse(au[0].before_json).concurrent_min_count === 3 && JSON.parse(au[0].after_json).concurrent_min_count === 2 && !('device_threshold' in JSON.parse(au[0].after_json)), au)
}

// ============ 6. 読み取りの行数（期間の外の古いデータを足しても増えない） ============
let run2
{
  // 前の集計を6分前にして、続けて集計できるようにする（テスト用の DB だけ）
  await sql(`UPDATE share_detect_runs SET created_at = '${jst(NOW - 6 * 60e3)}'`)
  const r = await hq.post('/api/hq/share-detect/run')
  run2 = r.data?.run
  const u = byUser((await hq.get('/api/hq/share-detect')).data.items)
  ok('#9989 決まりを変えた後の集計で、同時の利用2回（ログインの時点1回＋集計の時点で2つの端末）が出る', r.status === 200 && codes(u[8]) === 'concurrent' && u[8].reasons[0].count === 2
    && /集計の時点で別の種類の端末がログイン中/.test(u[8].reasons[0].detail), u[8])
  ok('#9989 新しい集計でも、前回の確認の結果（問題なし）を出す', u[2] && u[2].review_status === 'open' && u[2].previous_review && u[2].previous_review.review_status === 'ok', u[2])
  // 期間の外: 60日前のログイン3000行、200日前のシフト400件と打刻3200行
  const old = NOW - 60 * D
  await sql(`INSERT INTO login_events (${EV_COLS})
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
    SELECT 1, 4 + (i % 15), 'sample', 'x', 'login', 'success', 'password', '203.0.113.' || (i % 200), CASE i % 3 WHEN 0 THEN ${q(UA.win)} WHEN 1 THEN ${q(UA.mac)} ELSE ${q(UA.android)} END, NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ', '${iso(old)}', '-' || i || ' minutes'), 'JP', CASE i % 2 WHEN 0 THEN '13' ELSE '27' END, 'iPhone / Safari', 1 FROM n`)
  const oldDay = jstDay(NOW - 200 * D)
  await sql(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, memo)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
    SELECT 1, 1 + (i % 20), 1, date('${oldDay}', '-' || (i % 30) || ' days'), '09:00', '18:00', 'confirmed', 'w31-old' FROM n`)
  await sql(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, device_info, status, entry_method)
    SELECT s.company_id, s.staff_id, s.shift_id, t.type, s.work_date || ' 0' || t.h || ':00:00', 35 + (s.shift_id % 7), 135 + (s.shift_id % 5), CASE s.shift_id % 2 WHEN 0 THEN ${q(UA.win)} ELSE ${q(UA.iphone)} END, 'normal', 'app'
    FROM shifts s, (WITH RECURSIVE k(h) AS (SELECT 1 UNION ALL SELECT h + 1 FROM k WHERE h < 8)
      SELECT h, CASE h WHEN 1 THEN 'wake_up' WHEN 2 THEN 'departure' WHEN 3 THEN 'check_in' WHEN 4 THEN 'break_start' WHEN 5 THEN 'break_end'
        WHEN 6 THEN 'check_out' WHEN 7 THEN 'leave' ELSE 'arrive_home' END AS type FROM k) t WHERE s.memo = 'w31-old'`)
  const cnt = await sql(`SELECT (SELECT COUNT(*) FROM login_events) AS le, (SELECT COUNT(*) FROM attendance_reports) AS ar, (SELECT COUNT(*) FROM shifts) AS sh`)
  await sql(`UPDATE share_detect_runs SET created_at = '${jst(NOW - 6 * 60e3)}'`)
  const r3 = await hq.post('/api/hq/share-detect/run')
  const run3 = r3.data?.run
  const total = cnt[0].le + cnt[0].ar + cnt[0].sh
  ok('#9989 集計の読み取り: 期間の外のログイン3000行・打刻3200行を足しても、読んだ行数がほとんど増えない（300行未満の増え）',
    r3.status === 200 && run3.rows_read - run2.rows_read < 300, { before: run2.rows_read, after: run3.rows_read })
  ok('#9989 集計の読み取り: 表を全部読まない（ログインの履歴・打刻・シフトの全行数の1/5より少ない）', run3.rows_read * 5 < total, { rows_read: run3.rows_read, total })
  ok('#9989 集計の結果は古いデータで変わらない', run3.flagged === run2.flagged, [run2.flagged, run3.flagged])
  const rr = await sql(`SELECT rows_read, settings_json FROM share_detect_runs WHERE run_id = ${run3.run_id}`)
  ok('#9989 実行の記録に読んだ行数と使った決まりを残す', rr[0].rows_read === run3.rows_read && JSON.parse(rr[0].settings_json).concurrent_min_count === 2, rr[0])
}

// ============ 7. 週に1回の定期処理（3:30 の起動） ============
{
  const before = await sql(`SELECT COUNT(*) AS n FROM share_detect_runs WHERE trigger_type = 'cron'`)
  const s1 = await fetch(`${BASE}/__scheduled?cron=30+18+*+*+*`)
  await waitServer()
  const c1 = await sql(`SELECT run_id, status, flagged FROM share_detect_runs WHERE trigger_type = 'cron' ORDER BY run_id`)
  const cr1 = await sql(`SELECT status, result_json FROM cron_runs WHERE job = 'share_detect' ORDER BY run_id DESC LIMIT 1`)
  ok('#9989 定期処理（3:30）: その週にまだ集計していなければ集計する', s1.status === 200 && before[0].n === 0 && c1.length === 1 && c1[0].status === 'ok' && cr1[0] && cr1[0].status === 'ok' && /"run_id":\d+/.test(cr1[0].result_json), { c1, cr1 })
  await fetch(`${BASE}/__scheduled?cron=30+18+*+*+*`)
  await waitServer()
  const c2 = await sql(`SELECT COUNT(*) AS n FROM share_detect_runs WHERE trigger_type = 'cron'`)
  const cr2 = await sql(`SELECT status, result_json FROM cron_runs WHERE job = 'share_detect' ORDER BY run_id DESC LIMIT 1`)
  ok('#9989 定期処理: その週の集計が済んでいれば何もしない（idle）', c2[0].n === 1 && /"idle":true/.test(cr2[0].result_json), { c2, cr2 })
  const st = await hq.get('/api/hq/cron/status')
  ok('#9989 本部の定期処理の一覧に「使い回しの疑いの集計」', st.status === 200 && JSON.stringify(st.data).includes('share_detect'), st.text.slice(0, 200))
}

// ============ 8. データ保持（1年）・解約した会社の削除 ============
{
  await sql(`INSERT INTO share_suspicions (run_id, company_id, user_id, score, reasons_json, period_from, period_to, review_status, created_at)
    VALUES (1, 1, 4, 40, '[]', '2024-01-01', '2024-01-08', 'open', '${jst(NOW - 400 * D)}')`)
  const dr = await hq.post('/api/hq/retention/dry-run')
  const t = (dr.data?.results || []).find(x => x.target === 'share_suspicions')
  const t2 = (dr.data?.results || []).find(x => x.target === 'share_detect_runs')
  ok('#9989 データ保持: 1年を過ぎた使い回しの疑いを消す対象に数える（dry-run）', dr.status === 200 && t && t.targetCount === 1 && t2, { t, t2 })
  const ob = await hq.get('/api/hq/offboarding/1')
  const row = (ob.data?.tables || []).find(x => x.target === 'share_suspicions')
  ok('#9989 解約した会社の削除の対象（会社には書き出さない）で、未対応の表にならない', ob.status === 200 && row && row.export === false && row.delete === true && row.count > 0
    && !(ob.data.unknown_tables || []).includes('share_suspicions'), { row, unknown: ob.data?.unknown_tables })
}

// ============ 9. 画面（ヘッドレスの Chrome） ============
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w31s-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await sleep(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200) } return false }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const ck = await login('', 'hq')
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })

    await send('Page.navigate', { url: `${BASE}/hq#sharing` })
    const drawn = await until(`!!document.querySelector('[data-action=hqShareReview]')`)
    const info = await ev(`(() => ({ rows: document.querySelectorAll('[data-action=hqShareReview]').length, text: document.getElementById('app').innerText, badge: document.getElementById('hq-sharing-badge').innerText,
      active: (document.querySelector('.hq-nav.active') || {}).dataset?.tab }))()`)
    ok('#9989 画面: 「使い回しの疑い」のタブに一覧（会社・アカウント・点数・理由・確認）を出す', drawn && info.rows >= 5 && /同じ時刻に別の端末から操作（管理者）/.test(info.text) && /離れた場所で続けて打刻/.test(info.text) && /株式会社サンプルモバイル人材/.test(info.text) && info.active === 'sharing', info)
    ok('#9989 画面: 止めないこと・会社の画面に出ないことを説明する', /ログインを止めたり締め出したりはしません/.test(info.text) && /会社の画面には出ません/.test(info.text))
    // 確認の画面（モーダル）を開いて保存する
    await ev(`document.querySelector('[data-action=hqShareReview]').click()`)
    await until(`!!document.getElementById('sr-status')`)
    await ev(`document.getElementById('sr-status').value = 'contacted'; document.getElementById('sr-note').value = '画面から連絡した'; document.querySelector('[data-action=hqShareReviewSave]').click()`)
    const saved = await until(`document.getElementById('app').innerText.includes('画面から連絡した')`)
    ok('#9989 画面: 確認の結果を保存すると一覧に出る', saved)
    // 判定の決まり（モーダル）
    await ev(`document.querySelector('[data-action=hqShareSettings]').click()`)
    const setOpen = await until(`!!document.getElementById('ss-device_threshold')`)
    const fields = await ev(`document.querySelectorAll('#modal-root [id^=ss-]').length`)
    ok('#9989 画面: 判定の決まりを開ける（すべての項目）', setOpen && fields === 12, fields)
    await ev(`closeModal(true)`)
    // 狭い画面: ページが横に広がらない
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await send('Page.reload'); await until(`!!document.querySelector('[data-action=hqShareReview]')`)
    const wide = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`)
    ok('#9989 画面: 390px の幅でもページが横に広がらない（表は枠の中だけ横に動く）', wide, await ev(`[document.documentElement.scrollWidth, window.innerWidth]`))
    await send('Emulation.clearDeviceMetricsOverride')
    // 企業詳細の欄
    await ev(`location.hash = 'companies/1'`)
    const cd = await until(`(() => { const b = document.getElementById('hq-share-company'); return b && b.querySelector('[data-action=hqShareReview]') })()`)
    const cdText = await ev(`document.getElementById('hq-share-company').innerText`)
    ok('#9989 画面: 企業詳細に「アカウントの使い回しの疑い」（本部だけ）の欄', cd && /アカウントの使い回しの疑い/.test(cdText) && /本部だけに出ます/.test(cdText), cdText && cdText.slice(0, 200))
    ok('#9989 画面: スクリプトのエラーがない', !errors.length, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await sleep(500)
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
