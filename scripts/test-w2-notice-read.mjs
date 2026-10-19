// w2-notice-read（#7 #48 #49 #104 #227 #245 #335 #481）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8822 --persist-to <保存先> --test-scheduled で起動していること。
//   PERSIST に --persist-to の保存先を指定すると、ローカルの D1 を直接書き換える確認（確定済みの年度、退職、
//   公開から2年たったお知らせの既読の記録の削除）も行う。テスト用の DB 専用。
// 実行: BASE=http://127.0.0.1:8822 PERSIST=<保存先> node scripts/test-w2-notice-read.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8822'
const PERSIST = process.env.PERSIST || ''
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
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
// 別プロセスから D1 に書き込むと、ローカルの開発サーバーの接続がいったん切れるため、応答が戻るまで待つ
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nowJst = () => new Date(Date.now() + 9 * 3600 * 1000)
const today = nowJst().toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const fy = (() => { const d = nowJst(); return d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1 })()
const tag = Date.now().toString(36).slice(-5)
const PW = 'Nr-Passw0rd-' + tag
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }

const admin = client(await login('sample', 'admin'))
const notices = async () => (await admin.get('/api/admin/notices')).data.notices
const noticeByTitle = async (title) => (await notices()).find(n => n.title === title)
async function publish(title, target_type = 'all', target_ids = '') {
  must(await admin.post('/api/admin/notices', { title, body: 'テスト', target_type, target_ids, client_request_id: `${title}-${Math.random()}` }), 'notice ' + title)
  return noticeByTitle(title)
}
async function newStaff(suffix) {
  const code = `nr${tag}${suffix}`
  must(await admin.post('/api/admin/staff', { user_code: code, name: `既読テスト${tag}${suffix}`, password: PW }), 'staff ' + suffix)
  const list = (await admin.get('/api/admin/staff')).data
  const row = (list.staff || list).find(s => s.name === `既読テスト${tag}${suffix}`)
  return { staff_id: row.staff_id, code, name: row.name, api: client(await login('sample', code, PW)) }
}

// ---------- 前提: スタッフ4人と、新しい案件 ----------
const a = await newStaff('a'), b = await newStaff('b'), c = await newStaff('c'), d = await newStaff('d')
const cl = (await admin.get('/api/admin/clients')).data.clients[0]
must(await admin.post('/api/admin/projects', { project_name: `既読テスト案件${tag}`, client_id: cl.client_id, location: '店舗', unit_price: 10000 }), 'project')
const proj = (await admin.get('/api/admin/projects')).data.projects.find(p => p.project_name === `既読テスト案件${tag}`)
const shift = (s, work_date, status) => admin.post('/api/admin/shifts', { staff_id: s.staff_id, project_id: proj.project_id, work_date, start_time: '10:00', end_time: '19:00', status, memo: 'NR' })
must(await shift(a, addDays(today, 2), 'confirmed'), 'shift a')
must(await shift(b, addDays(today, -60), 'confirmed'), 'shift b')
must(await shift(c, addDays(today, 2), 'absent'), 'shift c')
must(await shift(d, addDays(today, 2), 'requested'), 'shift d')

// ---------- #335 案件あては、最近〜今後に確定・代打のシフトがある人だけ ----------
const pn = await publish(`案件あて${tag}`, 'project', String(proj.project_id))
const pr = await admin.get(`/api/admin/notices/${pn.notice_id}/reads`)
ok('#335 案件あての対象: 確定シフトのある人だけ（60日前だけの人・欠勤だけ・希望（仮）だけの人は外す）',
  pr.status === 200 && pr.data.target_count === 1 && pr.data.unread.length === 1 && pr.data.unread[0].name === a.name, pr.data)
ok('#7 一覧の分母も配信対象の人数', pn.staff_total === 1 && pn.read_count === 0, pn)

// ---------- #7 個人あて・全員あての既読数は配信対象から数える ----------
const sn = await publish(`個人あて${tag}`, 'staff', String(b.staff_id))
ok('#7 個人あての分母は1名（在籍スタッフ全員ではない）', sn.staff_total === 1, sn)
must(await b.api.post(`/api/staff/notices/${sn.notice_id}/read`), 'read b')
const sn2 = await noticeByTitle(`個人あて${tag}`)
const sr = (await admin.get(`/api/admin/notices/${sn.notice_id}/reads`)).data
ok('#7 対象の1名が読めば 1/1名、未読者に対象外の人が並ばない', sn2.read_count === 1 && sn2.staff_total === 1 && sr.read.length === 1 && sr.unread.length === 0, [sn2, sr])
// 対象外の人の既読は数えない（一覧に出ているものは既読にできるが、数には入らない）
const otherRead = await a.api.post(`/api/staff/notices/${sn.notice_id}/read`)
ok('#7 対象外の人は個人あてのお知らせを既読にできない（404）', otherRead.status === 404, otherRead)

// ---------- #104 既読時刻は日本時間で返す ----------
must(await a.api.post(`/api/staff/notices/${pn.notice_id}/read`), 'read a')
const pr2 = (await admin.get(`/api/admin/notices/${pn.notice_id}/reads`)).data
const readAt = pr2.read[0] && new Date(pr2.read[0].read_at.replace(' ', 'T') + 'Z') // JST の文字列を UTC として読み、JST の現在と比べる
ok('#104 既読状況の時刻が日本時間（今の日本時間と5分以内）', readAt && Math.abs(readAt.getTime() - nowJst().getTime()) < 5 * 60 * 1000, [pr2.read, nowJst().toISOString()])

// ---------- #227 入社前に公開されたお知らせは対象外 ----------
const all1 = await publish(`全員あて1${tag}`)
await sleep(1500)
const e = await newStaff('e')
const all1b = await noticeByTitle(`全員あて1${tag}`)
ok('#227 後から登録した人は、登録前のお知らせの対象に入らない', all1b.staff_total === all1.staff_total, [all1.staff_total, all1b.staff_total])
const all2 = await publish(`全員あて2${tag}`)
ok('#227 登録後のお知らせには入る', all2.staff_total === all1.staff_total + 1, [all1.staff_total, all2.staff_total])
const eRead = await e.api.post(`/api/staff/notices/${all1.notice_id}/read`)
const all1c = await noticeByTitle(`全員あて1${tag}`)
ok('#227 一覧に出ている登録前のお知らせも「確認しました」は失敗しない（数には入らない）', eRead.status === 200 && all1c.read_count === all1b.read_count, [eRead, all1b.read_count, all1c.read_count])
const eReads = (await admin.get(`/api/admin/notices/${all1.notice_id}/reads`)).data
ok('#227 既読状況にも登録前の人は出ない', ![...eReads.read, ...eReads.unread].some(r => r.name === e.name), eReads)

// ---------- #481 #48 既読率レポート: 今年度の再集計・集計日時・行の整合 ----------
const rc = await admin.post(`/api/admin/notice-reports/${fy}/recalculate`)
ok('#481 今年度を再集計でき、集計日時を返す', rc.status === 200 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rc.data.calculated_at || ''), rc)
const rep = (await admin.get(`/api/admin/notice-reports/${fy}`)).data
ok('#481 年度の途中・再集計できる・集計日時が保存される', rep.in_progress === true && rep.recalculable === true && rep.finalized === false && rep.summary && rep.summary.calculated_at === rc.data.calculated_at, rep.summary)
const sumTarget = rep.staff_reports.reduce((s, r) => s + r.target_count, 0), sumRead = rep.staff_reports.reduce((s, r) => s + r.read_count, 0)
ok('#481 スタッフ別の合計が年度全体と一致し、対象0件の行がない', sumTarget === rep.summary.target_user_count && sumRead === rep.summary.read_count && rep.staff_reports.every(r => r.target_count > 0), [sumTarget, sumRead, rep.summary])
const rowB = rep.staff_reports.find(r => r.staff_id === b.staff_id)
ok('#7 #49 レポートの対象も配信対象どおり（b は全員あて2件・個人あて1件で既読1）', rowB && rowB.read_count === 1 && rowB.target_count === 3, rowB)
const det = (await admin.get(`/api/admin/notice-reports/${fy}/staff/${b.staff_id}`)).data
ok('#481 スタッフ別の詳細とレポートの対象が同じ', det.notices.length === rowB.target_count && det.notices.filter(n => n.is_read).length === rowB.read_count, det.notices)
const old = await admin.post(`/api/admin/notice-reports/${fy - 3}/recalculate`)
ok('#48 保存期間（2年）を過ぎた年度は再集計できない（409）', old.status === 409 && /保存期間/.test(old.data.error || ''), old)
const oldRep = (await admin.get(`/api/admin/notice-reports/${fy - 3}`)).data
ok('#48 画面にも再集計できない理由を返す', oldRep.recalculable === false && !!oldRep.recalc_block_reason, oldRep)
const future = await admin.post(`/api/admin/notice-reports/${fy + 1}/recalculate`)
ok('#48 まだ始まっていない年度は再集計できない（409）', future.status === 409, future)
// 前年度は確定前なら再集計できる（同じ DB で2回目に流したときは、下で確定済みにしているので 409）
const prevFinalized = (await admin.get(`/api/admin/notice-reports/${fy - 1}`)).data.finalized
const prev = await admin.post(`/api/admin/notice-reports/${fy - 1}/recalculate`)
ok('#48 前年度（確定前）は再集計できる', prev.status === (prevFinalized ? 409 : 200), prev)

if (!PERSIST) {
  console.log('SKIP  確定済みの年度・退職・既読の記録の削除の確認（PERSIST が未指定）')
} else {
  // ---------- #49 公開した時点の対象者で数える（後で退職した人も残る）----------
  // c を今日付けで退職させる（公開日以降の退職なので、今日のお知らせの対象には残る）
  d1(`UPDATE users SET status = 'suspended', retired_at = '${today}' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ${c.staff_id})`)
  await waitServer()
  const all2b = await noticeByTitle(`全員あて2${tag}`)
  ok('#7 一覧の分母は今の在籍者（退職した人は外れる）', all2b.staff_total === all2.staff_total - 1, [all2.staff_total, all2b.staff_total])
  must(await admin.post(`/api/admin/notice-reports/${fy}/recalculate`), 'recalc after retire')
  const rep2 = (await admin.get(`/api/admin/notice-reports/${fy}`)).data
  ok('#49 公開した後に退職した人も、レポートの対象に残る', rep2.staff_reports.some(r => r.staff_id === c.staff_id) && rep2.summary.target_user_count === rep.summary.target_user_count, [rep.summary.target_user_count, rep2.summary.target_user_count])
  // 退職日の無い停止中の人（退職日の列ができる前の退職者など）は、在籍の期間が分からないのでレポートの対象に入れない
  d1(`UPDATE users SET status = 'suspended', retired_at = NULL WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ${d.staff_id})`)
  await waitServer()
  must(await admin.post(`/api/admin/notice-reports/${fy}/recalculate`), 'recalc after suspend')
  const rep3 = (await admin.get(`/api/admin/notice-reports/${fy}`)).data
  ok('#49 退職日の無い停止中の人はレポートの対象に入らない', rep2.staff_reports.some(r => r.staff_id === d.staff_id) && !rep3.staff_reports.some(r => r.staff_id === d.staff_id), rep3.staff_reports.map(r => r.staff_id))

  // ---------- #49 #48 確定済みの年度は作り直さない ----------
  d1(`UPDATE notice_read_reports SET finalized_at = '2026-05-01 03:00:00', read_rate = 12.3 WHERE company_id = 1 AND fiscal_year = ${fy - 1}`)
  await waitServer()
  const fin = await admin.post(`/api/admin/notice-reports/${fy - 1}/recalculate`)
  const finRep = (await admin.get(`/api/admin/notice-reports/${fy - 1}`)).data
  ok('#49 確定済みの年度は再集計できない（409）・値も変わらない', fin.status === 409 && finRep.finalized === true && finRep.recalculable === false && finRep.summary.read_rate === 12.3, [fin, finRep.summary])

  // ---------- #245 公開から2年たったお知らせの既読の記録を削除しても、一覧の既読数は変わらない ----------
  // 3年前に公開した全員あてのお知らせを入れ、a・b をそれより前に登録したことにして、a だけが既読
  const oldPub = `${addDays(today, -365 * 3)} 10:00:00`
  d1(`UPDATE users SET created_at = '2020-01-01 00:00:00' WHERE user_id IN (SELECT user_id FROM staff_profiles WHERE staff_id IN (${a.staff_id}, ${b.staff_id}));
      INSERT INTO notices (company_id, title, body, target_type, target_ids, published_at, created_by) VALUES (1, '古いお知らせ${tag}', 'x', 'all', '', '${oldPub}', 2);
      INSERT INTO notice_reads (notice_id, user_id, read_at) SELECT notice_id, (SELECT user_id FROM staff_profiles WHERE staff_id = ${a.staff_id}), '${oldPub}' FROM notices WHERE title = '古いお知らせ${tag}';`)
  await waitServer()
  const before = await noticeByTitle(`古いお知らせ${tag}`)
  const sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  ok('（前提）毎日の cron を実行', sc.status === 200, sc.status)
  const after = await noticeByTitle(`古いお知らせ${tag}`)
  const left = d1(`SELECT COUNT(*) AS n FROM notice_reads WHERE notice_id = ${before.notice_id}`)[0][0].n
  await waitServer()
  ok('#245 公開から2年たったお知らせの既読の記録は削除される', left === 0 && !!after.reads_purged_at, [left, after.reads_purged_at])
  ok('#245 削除の後も一覧の既読数は削除の直前のまま（0名に戻らない）', before.read_count === 1 && before.staff_total >= 2 && after.read_count === before.read_count && after.staff_total === before.staff_total, [before.read_count, before.staff_total, after.read_count, after.staff_total])
  const pr3 = (await admin.get(`/api/admin/notices/${before.notice_id}/reads`)).data
  ok('#245 既読状況は「保存期間外」として削除の直前の人数を返す', pr3.purged === true && pr3.read_count === 1 && pr3.target_count === before.staff_total, pr3)
  // 今年度・前年度のレポートは cron で作られる（今年度は毎日更新 #481）
  // 既読率レポートの集計は 3:30 の別の起動で行う（w3-retention-a #198）
  const sc2 = await fetch(`${BASE}/__scheduled?cron=30+18+*+*+*`)
  ok('（前提）既読率レポートの cron（3:30）を実行', sc2.status === 200, sc2.status)
  await waitServer()
  const cronRep = (await admin.get(`/api/admin/notice-reports/${fy}`)).data
  ok('#481 cron が今年度のレポートを作り直す', cronRep.summary && cronRep.summary.calculated_at >= rep.summary.calculated_at, cronRep.summary)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
