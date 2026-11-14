// 書き込みを減らす・CPU の残り（作業単位 w26-writes: #9976 #9970）の統合テスト
//  (1) 0110: 値がほとんど NULL の列の索引を部分索引（WHERE 列 IS NOT NULL）に置き換え、セッションの期限の索引を消す。
//      今のコードの問い合わせ（写真の参照・枠・枠の役割・開催場所・セッション）の計画が、置き換えの前と同じ（名前だけが変わる）ことを EXPLAIN QUERY PLAN で確かめる
//  (2) 第2段のコード側: 本部の週次アクティブは idx_attendance_location_photo で、総勤怠報告と解約企業の打刻・写真は shift_id / staff_id で引く。
//      idx_attendance_reported_at・idx_attendance_company を手元の DB で消しても全件読みにならず、結果は今までの式と同じ
//  (3) スタッフのセッションの延長は6時間ごと（管理者は10分のまま）、最終利用（last_seen_at）の更新は6時間ごと
//  (4) cron の何もしなかった記録は、消して入れ直さずに上書きする。本部画面の直近の一覧は開始の日時の順
//  (5) 既読の通知を開き直しても書き込まない
//  (6) スタッフのホームは読む列を絞っても応答の形が同じ。精算は報告用URLの端末の数え方が同じ
// 読み書きの行数は応答のヘッダー X-Test-D1-Rows（「読み取り/書き込み」。TEST_HOOKS のときだけ付く）で数える
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --test-scheduled --var TEST_HOOKS:true --port 9021 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w26-writes.mjs
//   本番には接続しない。手元の DB の索引を一時的に消して作り直すので、テストのたびに DB を作り直すこと（npm test -- w26-writes なら自動）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED'].includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500)); return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 900) : ''}`) }
const info = (name, v) => console.log(`INFO  ${name}: ${JSON.stringify(v)}`)

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w26w-'))
let sqlSeq = 0
async function sqlAll(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); break } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '')
      if (i >= 3 || !/internal error|SQLITE_BUSY|database is locked|bad_alloc|write EOF/i.test(msg)) throw new Error(msg.slice(0, 600))
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  await waitServer()
  return JSON.parse(out.slice(out.indexOf('[')))
}
const sql = async (command) => (await sqlAll(command)).at(-1).results
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await rawFetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const rowsOf = (h) => { const [a, b] = String(h || '').split('/').map(Number); return { read: Number.isFinite(a) ? a : null, written: Number.isFinite(b) ? b : null } }
async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], ...rowsOf(r.headers.get('x-test-d1-rows')) }
}
async function login(company_code, user_code) {
  const r = await rawLogin(company_code, user_code)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data, ...rowsOf(r.headers.get('x-test-d1-rows')), expires: r.headers.get('x-session-expires') }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`); return r.data }
const jst = (ms = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const q = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
async function plan(stmt) { return (await sql(`EXPLAIN QUERY PLAN ${stmt}`)).map(r => r.detail) }
// 複数の文の計画を1回の wrangler の起動で取る（文ごとに起動すると遅いため）。{ 名前: 文 } → { 名前: [detail…] }
async function plans(map) {
  const keys = Object.keys(map)
  const res = await sqlAll(keys.map(k => `EXPLAIN QUERY PLAN ${map[k]};`).join('\n'))
  if (res.length !== keys.length) throw new Error(`plans: ${res.length} != ${keys.length}`)
  return Object.fromEntries(keys.map((k, i) => [k, res[i].results.map(r => r.detail)]))
}

const PFX = 'W26W' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('', 'hq'))
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function createShift(staff_id, project_id, work_date, start_time = '00:00', end_time = '23:59') {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
const P1 = await newProject(`${PFX}-案件`)

// ---------- (1) 0110 の索引の入れ替え ----------
const PARTIAL = { idx_attendance_photo_key: 'idx_attendance_photo_key_nn', idx_shifts_slot: 'idx_shifts_slot_nn', idx_shifts_slot_role: 'idx_shifts_slot_role_nn', idx_shifts_site: 'idx_shifts_site_nn' }
{
  const idx = new Map((await sql(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (${[...Object.keys(PARTIAL), ...Object.values(PARTIAL), 'idx_sessions_expires', 'idx_sessions_user'].map(q).join(',')})`)).map(r => [r.name, r.sql]))
  ok('0110: 部分索引ができている（WHERE 列 IS NOT NULL）', Object.values(PARTIAL).every(n => /WHERE \w+ IS NOT NULL\s*$/i.test(idx.get(n) || '')), [...idx])
  ok('0110: 置き換えた古い索引と idx_sessions_expires は無い（idx_sessions_user は残る）', Object.keys(PARTIAL).every(n => !idx.has(n)) && !idx.has('idx_sessions_expires') && idx.has('idx_sessions_user'), [...idx.keys()])
  // 今のコードの問い合わせ（src の文と同じ形）。置き換えの前（古い索引）と後で、計画が名前の違いだけであること
  const Q = {
    '孤立した写真の確かめ（retention.ts）': `SELECT j.value AS k FROM json_each('["a.jpg","b.jpg"]') j WHERE NOT EXISTS (SELECT 1 FROM attendance_reports a WHERE a.photo_key = j.value) AND NOT EXISTS (SELECT 1 FROM retention_pending_r2 p WHERE p.photo_key = j.value)`,
    '枠の役割のスタッフ（staff-eligibility.ts）': `SELECT staff_id FROM shifts WHERE slot_role_id = 1 AND status != 'absent' AND staff_id IN (SELECT value FROM json_each('[1,2,3]')) AND shift_id != 5`,
    '枠の役割の割り当て数（recruit.ts の ASSIGNED_SQL）': `SELECT r.slot_role_id, (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = r.slot_role_id AND s.status != 'absent') AS assigned FROM shift_slot_roles r WHERE r.slot_role_id IN (SELECT value FROM json_each('[1,2]'))`,
    '役割の割り当て済み（shift-board.ts）': `SELECT staff_id FROM shifts WHERE slot_role_id = 1 AND status != 'absent'`,
    '役割ごとの件数（shift-board.ts）': `SELECT slot_role_id, COUNT(*) AS n FROM shifts WHERE slot_role_id IN (SELECT value FROM json_each('[1,2]')) AND status IN ('confirmed','substitute') GROUP BY slot_role_id`,
    '枠のシフト（shift-board.ts）': `SELECT s.shift_id FROM shifts s WHERE s.slot_id = 1 AND s.company_id = 1 ORDER BY s.shift_id`,
    '応募の状態（recruit.ts の ITEM_STATE_SQL）': `SELECT i.item_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id WHERE a.company_id = 1 AND NOT EXISTS (SELECT 1 FROM shifts xs WHERE xs.shift_id = i.shift_id AND xs.status != 'absent' AND xs.staff_id = a.staff_id AND (xs.slot_role_id IS NULL OR xs.slot_role_id = i.slot_role_id))`,
    '枠なしの帯（shift-board.ts）': `SELECT shift_id, work_date FROM shifts WHERE company_id = 1 AND staff_id = 1 AND project_id = 1 AND site_id IS NULL AND COALESCE(location,'') = '' AND start_time = '09:00' AND end_time = '18:00' AND COALESCE(role,'') = '' AND slot_id IS NULL ORDER BY work_date, shift_id LIMIT 41`,
    '枠なしのシフト（shift-board.ts のコピー）': `SELECT * FROM shifts WHERE company_id = 1 AND work_date BETWEEN '2026-01-01' AND '2026-12-31' AND slot_id IS NULL AND status IN ('confirmed','substitute')`,
    '開催場所の担当回数（shift-board.ts）': `SELECT sp.staff_id, (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.site_id = 1 AND s.site_id IS NOT NULL AND s.status IN ('confirmed','substitute')) AS site_count FROM staff_profiles sp WHERE sp.company_id = 1`,
    '開催場所の使用数（shift-board.ts）': `SELECT (SELECT COUNT(*) FROM shifts WHERE site_id = 1) + (SELECT COUNT(*) FROM shift_slots WHERE site_id = 1) AS n`,
    '開催場所ごとのシフト数（shift-board.ts）': `SELECT s.site_id, COUNT(*) AS n FROM shifts s WHERE s.company_id = 1 AND s.site_id IN (SELECT site_id FROM sites WHERE company_id = 1) GROUP BY s.site_id`,
    '開催場所の名前の変更（shift-board.ts）': `UPDATE shifts SET location = 'x' WHERE site_id = 1 AND company_id = 1 AND location = 'y' AND work_date >= '2026-01-01'`,
    'スタッフのホームの場所の結合（api.ts）': `SELECT s.shift_id, si.site_name, sl.memo FROM shifts s LEFT JOIN sites si ON si.site_id = s.site_id AND si.company_id = s.company_id LEFT JOIN shift_slots sl ON sl.slot_id = s.slot_id AND sl.company_id = s.company_id WHERE s.staff_id IN (1, 2) AND s.work_date IN ('2026-11-01', '2026-11-02')`,
    'ログインの期限切れの削除（api.ts の issueSession）': `DELETE FROM sessions WHERE user_id = 1 AND expires_at < '2026-11-01T00:00:00.000Z'`,
    'セッションの照合（auth.ts）': `SELECT u.user_id FROM sessions s JOIN users u ON s.user_id = u.user_id WHERE s.token = 'x' AND s.expires_at > '2026-11-01'`,
    'セッションの延長（api.ts）': `UPDATE sessions SET expires_at = '2026-12-01' WHERE token = 'x' AND expires_at < '2026-12-01'`,
    '企業の停止のセッションの削除（auth.ts）': `DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE company_id = 1 AND role != 'system_admin')`,
  }
  const after = await plans(Q)
  // 古い索引に戻して同じ問い合わせの計画を取り、最後に 0110 の形に戻す
  await sql(`DROP INDEX idx_attendance_photo_key_nn; CREATE INDEX idx_attendance_photo_key ON attendance_reports(photo_key);
    DROP INDEX idx_shifts_slot_nn; CREATE INDEX idx_shifts_slot ON shifts(slot_id);
    DROP INDEX idx_shifts_slot_role_nn; CREATE INDEX idx_shifts_slot_role ON shifts(slot_role_id);
    DROP INDEX idx_shifts_site_nn; CREATE INDEX idx_shifts_site ON shifts(site_id);
    CREATE INDEX idx_sessions_expires ON sessions(expires_at)`)
  const before = await plans(Q)
  await sql(`DROP INDEX idx_attendance_photo_key; DROP INDEX idx_shifts_slot; DROP INDEX idx_shifts_slot_role; DROP INDEX idx_shifts_site; DROP INDEX idx_sessions_expires;
    CREATE INDEX idx_attendance_photo_key_nn ON attendance_reports(photo_key) WHERE photo_key IS NOT NULL;
    CREATE INDEX idx_shifts_slot_nn ON shifts(slot_id) WHERE slot_id IS NOT NULL;
    CREATE INDEX idx_shifts_slot_role_nn ON shifts(slot_role_id) WHERE slot_role_id IS NOT NULL;
    CREATE INDEX idx_shifts_site_nn ON shifts(site_id) WHERE site_id IS NOT NULL`)
  const rename = (d) => Object.entries(PARTIAL).reduce((x, [o, n]) => x.replace(new RegExp(`\\b${o}\\b`, 'g'), n), d)
  let usedPartial = 0
  for (const k of Object.keys(Q)) {
    const b = before[k].map(rename), a = after[k]
    usedPartial += a.filter(d => /_nn\b/.test(d)).length
    ok(`0110: 計画が置き換えの前と同じ（${k}）`, JSON.stringify(a) === JSON.stringify(b), { before: before[k], after: a })
  }
  ok('0110: 部分索引が実際に使われている（等号・IN・結合の条件）', usedPartial >= 8, usedPartial)
  // 期限切れのセッションの削除（1日1回）は全件読みになる（それでよい。調査で確認済み）
  info('0110: 毎日の期限切れのセッションの削除の計画（索引を消した後）', await plan(`DELETE FROM sessions WHERE expires_at < '2026-11-01'`))
}

// ---------- (2) 第2段のコード側（週次アクティブ・総勤怠報告・解約企業） ----------
const BILL = "u.status = 'active' AND u.role NOT IN ('roster_only', 'system_admin')"
const LOC = (a) => '(' + ['latitude', 'longitude', 'address', 'device_info', 'device_id', 'photo_key'].map(c => `${a}.${c} IS NOT NULL`).join(' OR ') + ')'
const d7 = addDays(today, -6), d30 = addDays(today, -29)
const weekly = (withLoc) => `SELECT company_id, SUM(CASE WHEN last_at >= ${q(d7)} THEN 1 ELSE 0 END) AS active_users, COUNT(*) AS active_users_30d
  FROM (SELECT company_id, user_id, MAX(t) AS last_at FROM (
      SELECT u.company_id, u.user_id, MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) AS t FROM users u
        WHERE ${BILL} AND MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) >= ${q(d30)}
      UNION ALL
      SELECT u.company_id, u.user_id, ar.reported_at AS t FROM attendance_reports ar
        JOIN staff_profiles sp ON sp.staff_id = ar.staff_id JOIN users u ON u.user_id = sp.user_id
        WHERE ar.reported_at >= ${q(d30)}${withLoc ? ' AND ' + LOC('ar') : ''} AND COALESCE(ar.entry_method, 'app') = 'app' AND ${BILL}
    ) GROUP BY company_id, user_id)
  GROUP BY company_id ORDER BY company_id`
// 解約企業の打刻の条件（retention.ts の OB_ATTENDANCE と同じ）
const OB_ATT = (c) => `company_id = ${c} AND (shift_id IN (SELECT shift_id FROM shifts WHERE company_id = ${c}) OR staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = ${c}))`
const S = { W1: await newStaff('W1'), W2: await newStaff('W2'), W3: await newStaff('W3'), W4: await newStaff('W4') }
{
  // W1: アプリの報告が10日前（ログインは60日前）→ 30日のアクティブ。W2: 代理入力だけ（数えない）。W3: 報告用URLだけ（数えない）。W4: 今日アプリで打刻
  const old = jst(Date.now() - 60 * 86400e3)
  await sql(`UPDATE users SET last_login_at = ${q(old)}, last_seen_at = NULL WHERE user_id IN (${Object.values(S).map(s => s.user_id).join(',')})`)
  const sh = {}
  for (const [k, days] of [['W1', 10], ['W2', 3], ['W3', 2], ['W4', 0]]) sh[k] = await createShift(S[k].staff_id, P1, addDays(today, -days))
  await sql(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info) VALUES
      (1, ${S.W1.staff_id}, ${sh.W1}, 'check_in', ${q(addDays(today, -10) + ' 09:00:00')}, 'normal', 'Mozilla/5.0 test');
    INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, entry_method, entered_by) VALUES
      (1, ${S.W2.staff_id}, ${sh.W2}, 'check_in', ${q(addDays(today, -3) + ' 09:00:00')}, 'normal', 'admin', 'proxy', 1);
    INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, device_id, entry_method) VALUES
      (1, ${S.W3.staff_id}, ${sh.W3}, 'check_in', ${q(addDays(today, -2) + ' 09:00:00')}, 'normal', 'ua', 'dev-1', 'link');
    UPDATE users SET last_login_at = ${q(old)}, last_seen_at = NULL WHERE user_id IN (${Object.values(S).map(s => s.user_id).join(',')})`)
  const st4 = client(await login('sample', `${PFX}W4`))
  must(await st4.post('/api/staff/attendance', { shift_id: sh.W4, report_type: 'wake_up', client_request_id: PFX + 'w4', pressed_at: Date.now(), device_now: Date.now() }), 'W4 punch')
  await sql(`UPDATE users SET last_login_at = ${q(old)}, last_seen_at = NULL WHERE user_id = ${S.W4.user_id}`)

  // アプリの報告には必ず端末の情報が入る（30日の範囲で、端末・位置・写真のどれも無いアプリの報告は無い）
  const bare = await sql(`SELECT COUNT(*) AS n FROM attendance_reports ar WHERE ar.reported_at >= ${q(d30)} AND COALESCE(ar.entry_method, 'app') = 'app' AND NOT ${LOC('ar')}`)
  ok('週次アクティブ: 30日以内のアプリの報告は、どれも位置情報・端末の条件を満たす', bare[0].n === 0, bare)
  const [wOld, wNew] = [await sql(weekly(false)), await sql(weekly(true))]
  ok('週次アクティブ: 条件を足した式と今までの式の結果が同じ（全企業）', JSON.stringify(wOld) === JSON.stringify(wNew) && wOld.length > 0, { wOld, wNew })
  const api = must(await hq.get('/api/hq/companies'), 'hq companies').companies
  const byCo = new Map(wOld.map(r => [r.company_id, r]))
  ok('週次アクティブ: 本部の企業一覧の値が今までの式と同じ', api.every(c => (c.active_users || 0) === (byCo.get(c.company_id)?.active_users || 0) && (c.active_users_30d || 0) === (byCo.get(c.company_id)?.active_users_30d || 0)),
    api.map(c => [c.company_id, c.active_users, c.active_users_30d, byCo.get(c.company_id)]))
  // W1（10日前のアプリの報告）・W4（今日のアプリの打刻）は数え、W2（代理入力）・W3（報告用URL）は数えない
  const who = await sql(`SELECT DISTINCT u.user_id FROM attendance_reports ar JOIN staff_profiles sp ON sp.staff_id = ar.staff_id JOIN users u ON u.user_id = sp.user_id
    WHERE ar.reported_at >= ${q(d30)} AND ${LOC('ar')} AND COALESCE(ar.entry_method, 'app') = 'app' AND u.user_id IN (${Object.values(S).map(s => s.user_id).join(',')})`)
  const ids = who.map(r => r.user_id).sort((a, b) => a - b)
  ok('週次アクティブ: アプリの報告の人だけを数える（代理入力・報告用URLは数えない）', JSON.stringify(ids) === JSON.stringify([S.W1.user_id, S.W4.user_id].sort((a, b) => a - b)), ids)

  // 総勤怠報告（本部の企業の詳細）
  const companies = (await sql(`SELECT company_id FROM companies ORDER BY company_id`)).map(r => r.company_id)
  const detail = must(await hq.get('/api/hq/companies/1'), 'hq company 1')
  const [byCompany] = await sql(`SELECT COUNT(*) AS n FROM attendance_reports WHERE company_id = 1`)
  ok('総勤怠報告: 本部の企業の詳細の値が今までの式（company_id）と同じ', detail.stats.total_attendance === byCompany.n && byCompany.n > 0, [detail.stats.total_attendance, byCompany.n])
  // 打刻の会社とスタッフ・シフトの会社がずれた行は無い（書き換えの前提）
  const [mis] = await sql(`SELECT
      (SELECT COUNT(*) FROM attendance_reports a JOIN staff_profiles sp ON sp.staff_id = a.staff_id WHERE sp.company_id != a.company_id) AS staff_mis,
      (SELECT COUNT(*) FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id WHERE s.company_id != a.company_id) AS shift_mis`)
  ok('前提: 打刻の company_id はスタッフ・シフトの会社と同じ', mis.staff_mis === 0 && mis.shift_mis === 0, mis)
  // 解約企業: 打刻と写真の件数が、どの企業でも今までの式（company_id）と同じ
  const cmp = []
  const per = await sqlAll(companies.map(c => `SELECT (SELECT COUNT(*) FROM attendance_reports WHERE company_id = ${c}) AS old_rows, (SELECT COUNT(*) FROM attendance_reports WHERE ${OB_ATT(c)}) AS new_rows,
      (SELECT COUNT(*) FROM attendance_reports WHERE company_id = ${c} AND photo_key IS NOT NULL) AS old_files, (SELECT COUNT(*) FROM attendance_reports WHERE (${OB_ATT(c)}) AND photo_key IS NOT NULL) AS new_files,
      (SELECT COUNT(*) FROM attendance_reports WHERE staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = ${c})) AS total_new;`).join('\n'))
  companies.forEach((c, i) => cmp.push({ c, ...per[i].results[0] }))
  ok('解約企業・総勤怠報告: どの企業でも件数が今までの式と同じ', cmp.every(r => r.old_rows === r.new_rows && r.old_files === r.new_files && r.old_rows === r.total_new), cmp)
  const ob = must(await hq.get('/api/hq/offboarding/1'), 'offboarding 1')
  const [o1] = await sql(`SELECT COUNT(*) AS n, SUM(CASE WHEN photo_key IS NOT NULL THEN 1 ELSE 0 END) AS f FROM attendance_reports WHERE company_id = 1`)
  ok('解約企業: 本部の解約の画面の件数（出退勤記録・写真）が今までの式と同じ', ob.tables.find(t => t.target === 'attendance_reports').count === o1.n && (ob.files.attendance_reports || 0) === (o1.f || 0), [ob.tables.find(t => t.target === 'attendance_reports'), ob.files, o1])

  // 2つの索引を手元の DB で消しても、新しい文は全件読みにならない（今までの文は全件読みになる）
  await sql(`DROP INDEX IF EXISTS idx_attendance_reported_at; DROP INDEX IF EXISTS idx_attendance_company`)
  const newStmts = {
    '週次アクティブ': weekly(true),
    '総勤怠報告': `SELECT COUNT(*) FROM attendance_reports WHERE staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = 1)`,
    '解約: 件数': `SELECT COUNT(*) FROM attendance_reports WHERE (${OB_ATT(1)})`,
    '解約: 写真の件数': `SELECT COUNT(*) FROM attendance_reports WHERE (${OB_ATT(1)}) AND photo_key IS NOT NULL`,
    '解約: 写真の一覧': `SELECT attendance_id, photo_key FROM attendance_reports WHERE (${OB_ATT(1)}) AND photo_key IS NOT NULL ORDER BY attendance_id LIMIT 100 OFFSET 0`,
    '解約: 写真のキーを控える': `INSERT OR IGNORE INTO offboarding_pending_r2 (bucket, r2_key, offboarding_id) SELECT 'photos', photo_key, 0 FROM attendance_reports WHERE (${OB_ATT(1)}) AND photo_key IS NOT NULL`,
    '解約: 削除': `DELETE FROM attendance_reports WHERE rowid IN (SELECT rowid FROM attendance_reports WHERE (${OB_ATT(1)}) LIMIT 500) RETURNING 1`,
    // 会社で打刻を絞るほかの文（ダッシュボードの遅刻の集計）は、遅刻の部分索引 idx_attendance_late で引く（今のまま）
    'ダッシュボードの遅刻（api.ts・変更なし）': `SELECT s.staff_id, us.name, COUNT(DISTINCT a.shift_id) AS n FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id
      JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
      WHERE a.company_id = 1 AND a.report_type IN ('check_in', 'work_start') AND a.status = 'late' AND s.work_date >= '2026-11-01' AND s.work_date < '2026-12-01' AND s.status IN ('confirmed','substitute')
      GROUP BY s.staff_id HAVING n >= 2`,
  }
  const oldStmts = {
    '週次アクティブ（今までの式）': weekly(false),
    '総勤怠報告（今までの式）': `SELECT COUNT(*) FROM attendance_reports WHERE company_id = 1`,
    '解約: 件数（今までの式）': `SELECT COUNT(*) FROM attendance_reports WHERE company_id = 1`,
  }
  const np = await plans(newStmts), op = await plans(oldStmts)
  for (const [k, p] of Object.entries(np)) {
    ok(`索引なしでも全件読みにならない（${k}）`, !p.some(d => /^SCAN (attendance_reports|ar)( |$)/.test(d) && !/USING (COVERING )?INDEX/.test(d)), p)
  }
  for (const [k, p] of Object.entries(op)) info(`索引なしの計画（${k}）`, p)
  const wp = np['週次アクティブ']
  ok('週次アクティブ: 部分索引 idx_attendance_location_photo（reported_at）で引く', wp.some(d => /idx_attendance_location_photo/.test(d)), wp)
  // 索引なしでも結果は同じ
  const [wNo] = [await sql(weekly(true))]
  ok('週次アクティブ: 索引なしでも結果が同じ', JSON.stringify(wNo) === JSON.stringify(wOld), wNo)
  const detail2 = must(await hq.get('/api/hq/companies/1'), 'hq company 1 (no index)')
  ok('総勤怠報告: 索引なしでも同じ値', detail2.stats.total_attendance === byCompany.n, detail2.stats.total_attendance)
  const ob2 = must(await hq.get('/api/hq/offboarding/1'), 'offboarding 1 (no index)')
  ok('解約企業: 索引なしでも件数が同じ', ob2.tables.find(t => t.target === 'attendance_reports').count === o1.n && (ob2.files.attendance_reports || 0) === (o1.f || 0), [ob2.tables.find(t => t.target === 'attendance_reports'), ob2.files])
  // 2つの索引は migrations/0112 で消した（Sprint 27 #9982）ので、作り直さない（0112 の後の形のまま。scripts/test-w27-index.mjs も参照）
}

// ---------- (3) セッションの延長・最終利用の更新の間隔 ----------
{
  const L = await rawLogin('sample', `${PFX}W1`)
  const st = client(L.cookie)
  must(await st.get('/api/auth/me'), 'me')
  const sess = async (uid) => (await sql(`SELECT expires_at FROM sessions WHERE user_id = ${uid} ORDER BY rowid DESC LIMIT 1`))[0].expires_at
  const near = (iso, hours) => Math.abs(Date.parse(iso) - (Date.now() + hours * 3600e3)) < 5 * 60e3
  ok('スタッフ: ログイン後の最初の操作で、期限は今から72時間（今までどおり）', near(await sess(S.W1.user_id), 72), await sess(S.W1.user_id))
  // 前回の延長から4時間（期限は今から68時間）: 延ばさない・書かない
  const e68 = new Date(Date.now() + 68 * 3600e3).toISOString()
  await sql(`UPDATE sessions SET expires_at = ${q(e68)} WHERE user_id = ${S.W1.user_id}; UPDATE users SET last_seen_at = ${q(jst(Date.now() - 4 * 3600e3))} WHERE user_id = ${S.W1.user_id}`)
  const r1 = await st.get('/api/staff/tours')
  ok('スタッフ: 前回の延長・最終利用から4時間では書き込まない（今までは延長と最終利用を書いていた）', r1.status === 200 && r1.written === 0 && (await sess(S.W1.user_id)) === e68 && r1.expires === e68, { r1: [r1.status, r1.written, r1.expires], db: await sess(S.W1.user_id) })
  const [u1] = await sql(`SELECT last_seen_at FROM users WHERE user_id = ${S.W1.user_id}`)
  ok('スタッフ: 4時間前の最終利用は更新しない', u1.last_seen_at < jst(Date.now() - 3 * 3600e3), u1)
  // 前回の延長から7時間（期限は今から65時間）: 72時間に延ばす。最終利用も更新する
  await sql(`UPDATE sessions SET expires_at = ${q(new Date(Date.now() + 65 * 3600e3).toISOString())} WHERE user_id = ${S.W1.user_id}; UPDATE users SET last_seen_at = ${q(jst(Date.now() - 7 * 3600e3))} WHERE user_id = ${S.W1.user_id}`)
  const r2 = await st.get('/api/staff/tours')
  const e2 = await sess(S.W1.user_id)
  ok('スタッフ: 前回の延長から6時間を過ぎたら、期限を今から72時間に延ばす', r2.status === 200 && near(e2, 72) && r2.expires === e2, { r2: [r2.status, r2.written, r2.expires], db: e2 })
  const [u2] = await sql(`SELECT last_seen_at FROM users WHERE user_id = ${S.W1.user_id}`)
  ok('スタッフ: 6時間を過ぎた最終利用は更新する', u2.last_seen_at > jst(Date.now() - 5 * 60e3), u2)
  // 定期の取得（X-Background: 1）では今までどおり延ばさない
  await sql(`UPDATE sessions SET expires_at = ${q(new Date(Date.now() + 60 * 3600e3).toISOString())} WHERE user_id = ${S.W1.user_id}`)
  const bg = await fetch(`${BASE}/api/staff/badges`, { headers: { Cookie: L.cookie, 'X-Background': '1' } })
  ok('スタッフ: 定期の取得では延ばさない（今までどおり）', bg.status === 200 && near(await sess(S.W1.user_id), 60), await sess(S.W1.user_id))
  // 管理者は10分ごとのまま（操作のない時間の上限12時間）
  const AL = await rawLogin('sample', 'mgr01')
  const ad = client(AL.cookie)
  const mgrId = (await sql(`SELECT user_id FROM users WHERE company_id = 1 AND user_code = 'mgr01'`))[0].user_id
  await sql(`UPDATE sessions SET expires_at = ${q(new Date(Date.now() + (12 * 60 - 20) * 60e3).toISOString())} WHERE user_id = ${mgrId}`)
  must(await ad.get('/api/auth/me'), 'mgr me')
  ok('管理者: 前回の延長から20分で、期限を今から12時間に延ばす（今までどおり10分ごと）', near(await sess(mgrId), 12), await sess(mgrId))
  await sql(`UPDATE sessions SET expires_at = ${q(new Date(Date.now() + (12 * 60 - 5) * 60e3).toISOString())} WHERE user_id = ${mgrId}`)
  const before5 = await sess(mgrId)
  must(await ad.get('/api/auth/me'), 'mgr me 2')
  ok('管理者: 前回の延長から5分では延ばさない（今までどおり）', (await sess(mgrId)) === before5, await sess(mgrId))
  // 最長30日は今までどおり（ログインから30日を超えて延ばさない）
  await sql(`UPDATE sessions SET created_at = datetime('now', '-29 days', '-23 hours'), expires_at = ${q(new Date(Date.now() + 30 * 60e3).toISOString())} WHERE user_id = ${S.W1.user_id}`)
  must(await st.get('/api/staff/tours'), 'tours max')
  ok('スタッフ: ログインから30日を超えては延ばさない（今までどおり。期限はログインから30日まで）', near(await sess(S.W1.user_id), 1), await sess(S.W1.user_id))
}

// ---------- (4) cron の何もしなかった記録の上書き ----------
{
  const cron = async () => { const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *').replace(/%20/g, '+')}`); await r.text(); await waitServer() }
  await cron(); await cron()
  const idleJobs = (await sql(`SELECT r.job, r.run_id, r.started_at FROM cron_runs r JOIN (SELECT job, MAX(run_id) AS m FROM cron_runs GROUP BY job) x ON x.m = r.run_id
    WHERE r.cron = '*/15 * * * *' AND r.status = 'ok' AND json_extract(r.result_json, '$.idle') = 1`))
  const [c1] = await sql(`SELECT COUNT(*) AS n, MAX(run_id) AS m FROM cron_runs`)
  await new Promise(r => setTimeout(r, 1100))
  await cron()
  const [c2] = await sql(`SELECT COUNT(*) AS n, MAX(run_id) AS m FROM cron_runs`)
  const now = new Map((await sql(`SELECT r.job, r.run_id, r.started_at FROM cron_runs r JOIN (SELECT job, MAX(run_id) AS m FROM cron_runs GROUP BY job) x ON x.m = r.run_id`)).map(r => [r.job, r]))
  ok('cron: 何もしなかった処理がある（15分おきの起動）', idleJobs.length >= 2, idleJobs)
  ok('cron: 続けて何もしなかった実行は、前の行を上書きする（行も run_id も増えない）', c2.n === c1.n && c2.m === c1.m, { c1, c2 })
  ok('cron: 上書きした行は最後の実行の日時になる', idleJobs.every(j => now.get(j.job)?.run_id === j.run_id && now.get(j.job).started_at > j.started_at), { idleJobs, now: [...now.values()] })
  const st = must(await hq.get('/api/hq/cron/status'), 'cron status')
  const times = st.recent.map(r => r.started_at)
  ok('cron: 本部画面の直近の一覧は開始の日時の新しい順', times.length > 0 && times.every((t, i) => i === 0 || times[i - 1] >= t), times.slice(0, 10))
  ok('cron: 本部画面の処理ごとの最終実行は上書きした行', idleJobs.every(j => st.latest.find(l => l.job === j.job)?.started_at === now.get(j.job).started_at), st.latest.map(l => [l.job, l.started_at]))
  const recentPlan = await plan(`SELECT * FROM cron_runs ORDER BY started_at DESC, run_id DESC LIMIT 50`)
  ok('cron: 直近の一覧は索引（idx_cron_runs_started）で引く（並べ替えのための全件読みをしない）', recentPlan.some(d => /idx_cron_runs_started/.test(d)) && !recentPlan.some(d => /TEMP B-TREE/.test(d)), recentPlan)
}

// ---------- (5) 既読の通知を開き直しても書かない ----------
{
  const st = client(await login('sample', `${PFX}W2`))
  await sql(`INSERT INTO user_notifications (user_id, company_id, kind, title, body, link, created_at) VALUES (${S.W2.user_id}, 1, 'notice', '${PFX}通知', '', '#home', ${q(jst())})`)
  const [n] = await sql(`SELECT notification_id FROM user_notifications WHERE title = '${PFX}通知'`)
  const r1 = await st.post(`/api/staff/notifications/${n.notification_id}/read`)
  const [a1] = await sql(`SELECT read_at FROM user_notifications WHERE notification_id = ${n.notification_id}`)
  await new Promise(r => setTimeout(r, 1100))
  const r2 = await st.post(`/api/staff/notifications/${n.notification_id}/read`)
  const [a2] = await sql(`SELECT read_at FROM user_notifications WHERE notification_id = ${n.notification_id}`)
  ok('既読: 1回目は既読にする', r1.status === 200 && !!a1.read_at && r1.written >= 1, [r1.status, r1.written, a1])
  ok('既読: 既読の通知を開き直しても 200 で、書き込まない（既読の日時は最初のまま）', r2.status === 200 && r2.written === 0 && a2.read_at === a1.read_at, [r2.status, r2.written, a2])
  const other = client(await login('sample', `${PFX}W3`))
  ok('既読: ほかの人の通知は 404（今までどおり）', (await other.post(`/api/staff/notifications/${n.notification_id}/read`)).status === 404)
  ok('既読: 無い通知は 404（今までどおり）', (await st.post('/api/staff/notifications/999999999/read')).status === 404)
}

// ---------- (6) スタッフのホームの応答の形・精算の端末の数え方 ----------
{
  const st = client(await login('sample', `${PFX}W4`))
  const h = must(await st.get('/api/staff/home'), 'home')
  const TOP = ['today', 'shift', 'carryover', 'reports', 'daily_report_done', 'daily_report_checked_at', 'report_window_open', 'pending_corrections', 'tentative', 'required_attendance',
    'daily_report_required', 'notices', 'notice_unread_count', 'notice_other_companies', 'replied_consultations', 'photo_required_attendance', 'today_shifts', 'multi_company', 'missed_reports', 'next_shifts']
  ok('ホーム: 応答の項目は今までどおり', JSON.stringify(Object.keys(h).sort()) === JSON.stringify([...TOP].sort()), Object.keys(h))
  const SHIFT = ['shift_id', 'company_id', 'staff_id', 'project_id', 'work_date', 'start_time', 'end_time', 'location', 'role', 'status', 'break_minutes', 'site_id', 'slot_id',
    'staff_reply', 'staff_reply_note', 'staff_reply_at', 'project_name', 'site_name', 'site_address', 'site_lat', 'site_lng', 'slot_memo', 'slot_break_minutes', 'project_break_minutes',
    'staff_changed_at', 'site_contact_name', 'site_contact_phone']
  ok('ホーム: 今日のシフトの項目は今までどおり（許可リストの列がそろう）', h.shift && JSON.stringify(Object.keys(h.shift).sort()) === JSON.stringify([...SHIFT].sort()), h.shift && Object.keys(h.shift))
  ok('ホーム: 今日のシフトの一覧・報告の受付は今までどおり', h.today_shifts.length >= 1 && h.today_shifts[0].project_name === `${PFX}-案件` && h.reports.wake_up && h.report_window_open.check_in === true, [h.today_shifts, Object.keys(h.reports)])
  // お知らせを1件出して、ホームのお知らせの項目を確かめる（本文は返さない）
  must(await admin.post('/api/admin/notices', { title: `${PFX}お知らせ`, body: '本文'.repeat(200), target_type: 'all', importance: 'important' }), 'notice')
  const h2 = must(await st.get('/api/staff/home'), 'home 2')
  const nn = h2.notices.find(n => n.title === `${PFX}お知らせ`)
  ok('ホーム: お知らせの項目は今までどおり（本文は返さない）', nn && JSON.stringify(Object.keys(nn).sort()) === JSON.stringify(['importance', 'is_read', 'no_confirm', 'notice_id', 'pinned', 'project_names', 'published_at', 'read_required', 'target_type', 'title'].sort())
    && nn.pinned === 1 && nn.is_read === 0 && h2.notice_unread_count >= 1, nn)
  const full = must(await st.get('/api/staff/notices'), 'notices')
  ok('お知らせ一覧（ホーム以外）は今までどおり本文を返す', full.notices.some(n => n.title === `${PFX}お知らせ` && n.body && 'attachment_count' in n && 'my_response' in n), full.notices.map(n => n.title))

  // 精算: 報告用URLの端末が2台なら確認事項、アプリの報告の user-agent が違っても確認事項にしない（端末の情報は報告用URLの報告だけで読む）
  const A1 = await createShift(S.W1.staff_id, P1, addDays(today, -1), '09:00', '18:00')
  const A2 = await createShift(S.W2.staff_id, P1, addDays(today, -1), '09:00', '18:00')
  await sql(`UPDATE shifts SET status = 'confirmed' WHERE shift_id IN (${A1}, ${A2});
    INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, device_id, entry_method) VALUES
      (1, ${S.W1.staff_id}, ${A1}, 'check_in', ${q(addDays(today, -1) + ' 08:55:00')}, 'normal', 'ua-a', 'dev-a', 'link'),
      (1, ${S.W1.staff_id}, ${A1}, 'check_out', ${q(addDays(today, -1) + ' 18:05:00')}, 'normal', 'ua-b', 'dev-b', 'link');
    INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info) VALUES
      (1, ${S.W2.staff_id}, ${A2}, 'check_in', ${q(addDays(today, -1) + ' 08:55:00')}, 'normal', 'Mozilla/5.0 (iPhone)'),
      (1, ${S.W2.staff_id}, ${A2}, 'check_out', ${q(addDays(today, -1) + ' 18:05:00')}, 'normal', 'Mozilla/5.0 (Android)')`)
  const setRes = await admin.get(`/api/admin/settlement?from=${addDays(today, -1)}&to=${addDays(today, -1)}`)
  const set = must(setRes, 'settlement')
  const r1 = set.rows.find(r => r.shift_id === A1), r2 = set.rows.find(r => r.shift_id === A2)
  ok('精算: 報告用URLで2台の端末から報告したシフトは確認事項になる（今までどおり）', r1 && r1.issues.includes('報告用URLで2台以上の端末から報告あり'), r1 && r1.issues)
  ok('精算: アプリの報告（user-agent が違う）は端末の確認事項にしない（今までどおり）', r2 && !r2.issues.includes('報告用URLで2台以上の端末から報告あり') && r2.has_check_in && r2.has_check_out, r2 && r2.issues)
  ok('精算: 行の項目（金額・実績・報告の有無）がそろう', r1 && ['bill_total', 'pay_total', 'actual_start', 'actual_end', 'has_check_in', 'has_check_out', 'payee_name', 'site_name', 'staff_name', 'employee_number', 'closed'].every(k => k in r1), r1 && Object.keys(r1))
  info('精算（前日1日）の読み取り・書き込み', [setRes.read, setRes.written])
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
