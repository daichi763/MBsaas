// 索引を消す第2段（作業単位 w27-index: #9982。#9976 の続き）の統合テスト。migrations/0112 で idx_attendance_reported_at・idx_attendance_company を消す
//  (1) 0112: 2つの索引が無く、attendance_reports に残る索引は一意制約・スタッフ・位置情報と写真・遅刻・写真のキーの5つ。0112 は DROP INDEX の2行だけ
//  (2) src: INDEXED BY で索引の名前を指す文が無い。attendance_reports を引く文（FROM・JOIN・UPDATE・INSERT・DELETE）が、どれも下の (3) の一覧か、
//      shift_id・attendance_id・staff_id で引く形（一意制約・主キー・idx_attendance_staff を使う）のどれかに当たる（文が増えたらこのテストに足す）
//  (3) EXPLAIN QUERY PLAN: 本部の週次アクティブ・企業の詳細・解約企業の処理（件数・一覧・書き出し・削除）・打刻の一覧・精算・ダッシュボード・
//      スタッフのホーム・打刻修正・定期削除（retention.ts）など、attendance_reports を引く主な文が、索引なしでも全件読み（SCAN）にならない。
//      消す前（2つの索引を作り直した状態）の計画との違いを INFO に出す
//  (4) API: 本部の企業一覧・詳細・解約企業の件数・ファイル・書き出し、定期削除の dry-run、打刻の一覧・精算・ダッシュボード・スタッフ詳細の応答が、
//      索引の有無で同じ。打刻の無い企業（demo3）では、索引なしでも打刻の表を全部は読まない（読み取りの行数）
//  (5) 打刻1回の書き込みの行数が、索引を消す前より2行少ない（同じ種類の打刻を、索引なし→索引あり→索引なしの順に測る）
// 読み書きの行数は応答のヘッダー X-Test-D1-Rows（「読み取り/書き込み」。TEST_HOOKS のときだけ付く）で数える
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --var TEST_HOOKS:true --port 9021 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w27-index.mjs
//   本番には接続しない。手元の DB の索引を一時的に作り直して消すので、テストのたびに DB を作り直すこと（npm test -- w27-index なら自動）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED'].includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500)); return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 1200) : ''}`) }
const info = (name, v) => console.log(`INFO  ${name}: ${JSON.stringify(v)}`)

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w27i-'))
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
// 複数の文の計画を少ない wrangler の起動で取る。{ 名前: 文 } → { 名前: [detail…] }
// 1回に多くの文（8文ほど）を渡すとローカルの D1 が internal error を返すので、6文ずつにし、それでも通らなければ半分に分けてやり直す
async function planChunk(map, keys) {
  try {
    const res = await sqlAll(keys.map(k => `EXPLAIN QUERY PLAN ${map[k]};`).join('\n'))
    if (res.length !== keys.length) throw new Error(`plans: ${res.length} != ${keys.length}`)
    return res.map(r => r.results.map(x => x.detail))
  } catch (e) {
    if (keys.length === 1) throw new Error(`EXPLAIN が通らない文: ${keys[0]}\n${e.message}`)
    const h = Math.ceil(keys.length / 2)
    return [...await planChunk(map, keys.slice(0, h)), ...await planChunk(map, keys.slice(h))]
  }
}
async function plans(map) {
  const keys = Object.keys(map), out = []
  for (let i = 0; i < keys.length; i += 6) out.push(...await planChunk(map, keys.slice(i, i + 6)))
  return Object.fromEntries(keys.map((k, i) => [k, out[i]]))
}
const rowsOf = (h) => { const [a, b] = String(h || '').split('/').map(Number); return { read: Number.isFinite(a) ? a : null, written: Number.isFinite(b) ? b : null } }
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (r.status !== 200 || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, headers: r.headers, ...rowsOf(r.headers.get('x-test-d1-rows')) }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 400)}`); return r.data }
const jst = (ms = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const q = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`

const DROPPED = ['idx_attendance_reported_at', 'idx_attendance_company']
const RECREATE = 'CREATE INDEX IF NOT EXISTS idx_attendance_reported_at ON attendance_reports(reported_at); CREATE INDEX IF NOT EXISTS idx_attendance_company ON attendance_reports(company_id)'
const DROP = 'DROP INDEX IF EXISTS idx_attendance_reported_at; DROP INDEX IF EXISTS idx_attendance_company'
const attIndexes = async () => (await sql(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attendance_reports' ORDER BY name`)).map(r => r.name)

// ---------- (1) 0112 ----------
{
  const file = readdirSync(join(ROOT, 'migrations')).find(f => f.startsWith('0112_'))
  ok('0112: マイグレーションのファイルがある', !!file, readdirSync(join(ROOT, 'migrations')).slice(-3))
  const body = file ? readFileSync(join(ROOT, 'migrations', file), 'utf8').replace(/--[^\n]*/g, '').trim() : ''
  const stmts = body.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  ok('0112: DROP INDEX IF EXISTS の2文だけ（表・列は消さない）', JSON.stringify(stmts) === JSON.stringify(DROPPED.map(n => `DROP INDEX IF EXISTS ${n}`)), stmts)
  const idx = await attIndexes()
  ok('0112: 2つの索引が無い', DROPPED.every(n => !idx.includes(n)), idx)
  ok('0112: 残る索引は、一意制約（shift_id, report_type）・スタッフ・位置情報と写真・遅刻・写真のキーの5つ',
    JSON.stringify(idx) === JSON.stringify(['idx_attendance_late', 'idx_attendance_location_photo', 'idx_attendance_photo_key_nn', 'idx_attendance_staff', 'sqlite_autoindex_attendance_reports_1']), idx)
}

// ---------- (3) で調べる文（src の文と同じ形。? は値に置き換え。at は src のファイルとその行に含まれる文字列） ----------
const BILL = "u.status = 'active' AND u.role NOT IN ('roster_only', 'system_admin')"
const LOC = (a) => '(' + ['latitude', 'longitude', 'address', 'device_info', 'device_id', 'photo_key'].map(c => `${a ? a + '.' : ''}${c} IS NOT NULL`).join(' OR ') + ')'
const NOT_HELD = 'staff_id NOT IN (SELECT staff_id FROM staff_profiles WHERE retention_hold_at IS NOT NULL) AND company_id NOT IN (SELECT company_id FROM companies WHERE retention_hold_at IS NOT NULL)'
const OB = (c) => `company_id = ${c} AND (shift_id IN (SELECT shift_id FROM shifts WHERE company_id = ${c}) OR staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = ${c}))`
const OBK = OB('(SELECT cid FROM k)')
const ELIGIBLE = `SELECT x.staff_id FROM (SELECT sp.staff_id, sp.company_id, sp.retention_hold_at AS hold_at, COALESCE(u.retired_at, CASE WHEN sp.affiliation_type = 'linked_external' THEN (SELECT ru.retired_at FROM staff_profiles r
    JOIN users ru ON ru.user_id = r.user_id WHERE r.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)) END) AS retired_at
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id) x
  WHERE x.retired_at IS NOT NULL AND length(x.retired_at) >= 10 AND x.retired_at <= '2019-11-14'
    AND x.hold_at IS NULL AND NOT EXISTS (SELECT 1 FROM companies hc WHERE hc.company_id = x.company_id AND hc.retention_hold_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = x.staff_id AND s.work_date > x.retired_at)`
const IDS = `(SELECT value FROM json_each('[1,2,3]'))`
const PUNCH_COLS = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'].map(t => `
    MAX(CASE WHEN a.report_type = '${t}' THEN a.reported_at END) AS ${t}_at,
    MAX(CASE WHEN a.report_type = '${t}' THEN COALESCE(a.entry_method, 'app') END) AS ${t}_m,
    MAX(CASE WHEN a.report_type = '${t}' THEN (CASE WHEN a.corrected_by_correction_id IS NOT NULL OR a.entry_method = 'correction' THEN 1 ELSE 0 END)
      + (CASE WHEN a.photo_key IS NOT NULL THEN 2 ELSE 0 END) END) AS ${t}_f`).join(',')
const PUNCH_FROM = `FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = s.staff_id AND er.company_id = s.company_id LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id`
const PUNCH_WHERE = `s.company_id = 1 AND s.work_date BETWEEN '2026-10-15' AND '2026-11-14' AND (s.status IN ('confirmed','substitute') OR s.status = 'absent')`
const PUNCH_SELECT = `SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.staff_id, p.project_name, cl.client_name, us.name AS staff_name, er.employee_number, ${PUNCH_COLS},
    (SELECT COUNT(*) FROM attendance_corrections x WHERE x.shift_id = s.shift_id AND x.status = 'pending') AS pending_corrections
  ${PUNCH_FROM} LEFT JOIN attendance_reports a ON a.shift_id = s.shift_id`
const REPORT_JSON_COL = `(SELECT json_group_array(json_array(a.report_type, a.reported_at, a.entry_method, CASE WHEN a.entry_method = 'link' THEN a.device_id END))
        FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS reports_json`
const REPORT_COLS = ['check_in', 'check_out', 'work_start', 'work_end', 'break_start', 'break_end'].map(t => `(SELECT a.reported_at FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = '${t}') AS r_${t}`).join(', ')
const d7 = addDays(today, -6), d30 = addDays(today, -29)
const WEEKLY = `SELECT company_id, SUM(CASE WHEN last_at >= ${q(d7)} THEN 1 ELSE 0 END) AS active_users, COUNT(*) AS active_users_30d
  FROM (SELECT company_id, user_id, MAX(t) AS last_at FROM (
      SELECT u.company_id, u.user_id, MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) AS t FROM users u
        WHERE ${BILL} AND MAX(COALESCE(u.last_login_at, ''), COALESCE(u.last_seen_at, '')) >= ${q(d30)}
      UNION ALL
      SELECT u.company_id, u.user_id, ar.reported_at AS t FROM attendance_reports ar
        JOIN staff_profiles sp ON sp.staff_id = ar.staff_id JOIN users u ON u.user_id = sp.user_id
        WHERE ar.reported_at >= ${q(d30)} AND ${LOC('ar')} AND COALESCE(ar.entry_method, 'app') = 'app' AND ${BILL}
    ) GROUP BY company_id, user_id)
  GROUP BY company_id`

const Q = [
  // 本部
  { name: '本部: 週次アクティブ（api.ts）', at: ['src/api.ts', 'ar.reported_at AS t FROM attendance_reports ar'], sql: WEEKLY, mustUse: 'idx_attendance_location_photo' },
  { name: '本部: 企業の詳細の総勤怠報告（api.ts）', at: ['src/api.ts', 'AS total_attendance'], sql: `SELECT (SELECT COUNT(*) FROM daily_reports WHERE company_id = 1) AS total_reports, (SELECT COUNT(*) FROM shifts WHERE company_id = 1) AS total_shifts,
      (SELECT COUNT(*) FROM attendance_reports WHERE staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = 1)) AS total_attendance,
      (SELECT COUNT(*) FROM projects WHERE company_id = 1 AND status = 'active') AS active_projects`, mustUse: 'idx_attendance_staff' },
  // 解約企業（retention.ts の OB_ATTENDANCE を使う文）
  { name: '解約: 表ごとの件数（countOffboardingData。WITH k）', at: ['src/services/retention.ts', "{ target: 'attendance_reports', label: '出退勤記録', table: 'attendance_reports', where: OB_ATTENDANCE }"],
    sql: `WITH k(cid) AS (SELECT 1) SELECT (SELECT COUNT(*) FROM attendance_reports WHERE (${OBK})) AS t0, (SELECT COUNT(*) FROM attendance_reports WHERE (${OBK}) AND photo_key IS NOT NULL) AS f0` },
  { name: '解約: 書き出し（exportOffboardingTablePage。rowid の順）', at: ['src/services/retention.ts', 'SELECT * FROM ${t.table} WHERE ${w.sql} ORDER BY rowid LIMIT ? OFFSET ?'],
    sql: `SELECT * FROM attendance_reports WHERE (${OB(1)}) ORDER BY rowid LIMIT 500 OFFSET 500` },
  { name: '解約: ファイルの件数（listOffboardingFiles。WITH k）', at: ['src/services/retention.ts', "{ source: 'attendance_reports', bucket: 'photos'"],
    sql: `WITH k(cid) AS (SELECT 1) SELECT (SELECT COUNT(*) FROM attendance_reports WHERE (${OBK}) AND photo_key IS NOT NULL) AS c0` },
  { name: '解約: ファイルの一覧（listOffboardingFiles）', at: ['src/services/retention.ts', 'FROM ${f.source} WHERE ${w.sql} AND ${f.keyCol} IS NOT NULL ORDER BY ${f.idCol} LIMIT ? OFFSET ?'],
    sql: `SELECT 'attendance_reports' AS source, 'photos' AS bucket, attendance_id AS id, photo_key AS r2_key, NULL AS file_name, reported_at AS created_at, staff_id AS ref_id
      FROM attendance_reports WHERE (${OB(1)}) AND photo_key IS NOT NULL ORDER BY attendance_id LIMIT 101 OFFSET 0` },
  { name: '解約: ファイル1件（findOffboardingFile）', at: ['src/services/retention.ts', 'FROM ${f.source} WHERE company_id = ? AND ${f.idCol} = ? AND ${f.keyCol} IS NOT NULL'],
    sql: `SELECT attendance_id, photo_key FROM attendance_reports WHERE company_id = 1 AND attendance_id = 5 AND photo_key IS NOT NULL` },
  { name: '解約: R2 のキーを控える', at: ['src/services/retention.ts', "SELECT '${f.bucket}', ${f.keyCol}, ? FROM ${f.source} WHERE ${w.sql} AND ${f.keyCol} IS NOT NULL"],
    sql: `INSERT OR IGNORE INTO offboarding_pending_r2 (bucket, r2_key, offboarding_id) SELECT 'photos', photo_key, 0 FROM attendance_reports WHERE (${OB(1)}) AND photo_key IS NOT NULL` },
  { name: '解約: 削除', at: ['src/services/retention.ts', 'DELETE FROM ${t.table} WHERE rowid IN (SELECT rowid FROM ${t.table} WHERE ${w.sql} LIMIT ${OFFBOARDING_DELETE_LIMIT}) RETURNING 1'],
    sql: `DELETE FROM attendance_reports WHERE rowid IN (SELECT rowid FROM attendance_reports WHERE (${OB(1)}) LIMIT 500) RETURNING 1` },
  // 定期削除（retention.ts）
  { name: '定期削除: 位置情報・写真の件数', at: ['src/services/retention.ts', 'count: `SELECT COUNT(*) AS n FROM attendance_reports WHERE ${LOCATION_PHOTO_SQL} AND reported_at < ? AND ${notHeld}`'],
    sql: `SELECT COUNT(*) AS n FROM attendance_reports WHERE ${LOC('')} AND reported_at < '2025-11-14' AND ${NOT_HELD}`, mustUse: 'idx_attendance_location_photo' },
  { name: '定期削除: 位置情報・写真の対象', at: ['src/services/retention.ts', 'select: `SELECT attendance_id AS id FROM attendance_reports WHERE ${LOCATION_PHOTO_SQL}'],
    sql: `SELECT attendance_id AS id FROM attendance_reports WHERE ${LOC('')} AND reported_at < '2025-11-14' AND ${NOT_HELD} LIMIT 200`, mustUse: 'idx_attendance_location_photo' },
  { name: '定期削除: 写真の件数', at: ['src/services/retention.ts', 'AND reported_at < ? AND ${notHeld} AND photo_key IS NOT NULL'],
    sql: `SELECT COUNT(*) AS n FROM attendance_reports WHERE ${LOC('')} AND reported_at < '2025-11-14' AND ${NOT_HELD} AND photo_key IS NOT NULL` },
  { name: '定期削除: 位置情報・写真を消す', at: ['src/services/retention.ts', 'UPDATE attendance_reports SET latitude = NULL, longitude = NULL'],
    sql: `UPDATE attendance_reports SET latitude = NULL, longitude = NULL, address = NULL, device_info = NULL, device_id = NULL, photo_key = NULL WHERE attendance_id IN (SELECT value FROM json_each('[1,2]'))` },
  { name: '定期削除: 写真のキーを控える', at: ['src/services/retention.ts', "SELECT photo_key, staff_id, 'photos' FROM attendance_reports WHERE attendance_id IN (SELECT value FROM json_each(?))"],
    sql: `INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket) SELECT photo_key, staff_id, 'photos' FROM attendance_reports WHERE attendance_id IN (SELECT value FROM json_each('[1,2]')) AND photo_key IS NOT NULL
      AND photo_key NOT IN (SELECT photo_key FROM attendance_correction_attachments)` },
  { name: '定期削除: 孤立した写真', at: ['src/services/retention.ts', 'WHERE NOT EXISTS (SELECT 1 FROM attendance_reports a WHERE a.photo_key = j.value)'],
    sql: `SELECT j.value AS k FROM json_each('["a.jpg"]') j WHERE NOT EXISTS (SELECT 1 FROM attendance_reports a WHERE a.photo_key = j.value) AND NOT EXISTS (SELECT 1 FROM retention_pending_r2 p WHERE p.photo_key = j.value)` },
  { name: '定期削除: 退職者の打刻の件数', at: ['src/services/retention.ts', 'attendance_reports: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${retired})`'],
    sql: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${ELIGIBLE})` },
  { name: '定期削除: 退職者の写真の件数', at: ['src/services/retention.ts', 'r2_photos: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${retired}) AND photo_key IS NOT NULL`'],
    sql: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${ELIGIBLE}) AND photo_key IS NOT NULL` },
  { name: '定期削除: 退職者ごとの件数・最後の報告', at: ['src/services/retention.ts', '(SELECT MAX(substr(reported_at, 1, 10)) FROM attendance_reports WHERE staff_id = sp.staff_id) AS last_report_date'],
    sql: `SELECT sp.staff_id, (SELECT COUNT(*) FROM attendance_reports WHERE staff_id = sp.staff_id) AS a, (SELECT MAX(substr(reported_at, 1, 10)) FROM attendance_reports WHERE staff_id = sp.staff_id) AS last_report_date,
      EXISTS (SELECT 1 FROM attendance_reports WHERE staff_id = sp.staff_id) AS has FROM staff_profiles sp WHERE sp.company_id = 1` },
  { name: '定期削除: 退職者1人の写真', at: ['src/services/retention.ts', "SELECT photo_key AS k, 'photos' AS b FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts})"],
    sql: `SELECT photo_key AS k FROM attendance_reports WHERE (staff_id = 1 OR shift_id IN (SELECT shift_id FROM shifts WHERE staff_id = 1)) AND photo_key IS NOT NULL` },
  { name: '定期削除: 退職者1人の打刻の削除', at: ['src/services/retention.ts', 'DELETE FROM attendance_reports WHERE staff_id = ? OR ${ofShifts}'],
    sql: `DELETE FROM attendance_reports WHERE staff_id = 1 OR shift_id IN (SELECT shift_id FROM shifts WHERE staff_id = 1)` },
  // 管理画面
  { name: 'ダッシュボード: 遅刻（api.ts）', at: ['src/api.ts', 'SELECT s.staff_id, us.name, COUNT(DISTINCT a.shift_id) AS n FROM attendance_reports a'],
    sql: `SELECT s.staff_id, us.name, COUNT(DISTINCT a.shift_id) AS n FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id
      JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
      WHERE a.company_id = 1 AND a.report_type IN ('check_in', 'work_start') AND a.status = 'late' AND s.work_date >= '2026-11-01' AND s.work_date < '2026-12-01' AND s.status IN ('confirmed','substitute')
      GROUP BY s.staff_id HAVING n >= 2`, mustUse: 'idx_attendance_late' },
  { name: 'ダッシュボード: 昨日・今日の報告（api.ts）', at: ['src/api.ts', 'FROM attendance_reports WHERE shift_id IN (SELECT r.shift_id FROM shifts r WHERE r.company_id = ?'],
    sql: `SELECT shift_id, report_type, reported_at, status FROM attendance_reports WHERE shift_id IN (SELECT r.shift_id FROM shifts r WHERE r.company_id = 1 AND r.work_date IN ('2026-11-13', '2026-11-14') AND r.status IN ('confirmed','substitute','absent'))` },
  { name: 'スタッフ一覧: 本日の入店（api.ts）', at: ['src/api.ts', 'FROM shifts s2 JOIN attendance_reports a ON a.shift_id = s2.shift_id'],
    sql: `SELECT a.staff_id, COUNT(*) AS n FROM shifts s2 JOIN attendance_reports a ON a.shift_id = s2.shift_id
      WHERE s2.company_id = 1 AND s2.work_date = '2026-11-14' AND s2.status IN ('confirmed','substitute') AND a.report_type IN ('check_in','work_start') GROUP BY a.staff_id` },
  { name: 'スタッフ詳細: 直近の勤怠（api.ts）', at: ['src/api.ts', 'WHERE a.staff_id = ? ORDER BY a.reported_at DESC LIMIT 40'],
    sql: `SELECT a.*, s.work_date FROM attendance_reports a JOIN shifts s ON a.shift_id = s.shift_id WHERE a.staff_id = 1 ORDER BY a.reported_at DESC LIMIT 40` },
  { name: 'シフト管理: 写真の数（api.ts）', at: ['src/api.ts', 'ar.shift_id = s.shift_id AND ar.photo_key IS NOT NULL) AS photo_count'],
    sql: `SELECT s.*, (SELECT COUNT(*) FROM attendance_reports ar WHERE ar.shift_id = s.shift_id AND ar.photo_key IS NOT NULL) AS photo_count FROM shifts s JOIN projects p ON s.project_id = p.project_id
      JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id WHERE s.company_id = 1 AND s.work_date BETWEEN '2026-11-01' AND '2026-11-30' ORDER BY s.work_date, s.start_time` },
  { name: 'シフトの報告の一覧（api.ts）', at: ['src/api.ts', 'FROM attendance_reports WHERE shift_id = ? ORDER BY reported_at, attendance_id'],
    sql: `SELECT attendance_id, report_type, reported_at FROM attendance_reports WHERE shift_id = 1 ORDER BY reported_at, attendance_id` },
  { name: '欠勤にする前の確認（api.ts）', at: ['src/api.ts', 'const started = await c.env.DB.prepare(`SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ?'],
    sql: `SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = 1 AND report_type IN ('check_in','work_start','break_start','break_end','work_end','check_out') ORDER BY reported_at LIMIT 1` },
  { name: '入店の位置（api.ts）', at: ['src/api.ts', "report_type = 'check_in' AND company_id = ?"],
    sql: `SELECT reported_at, latitude, longitude FROM attendance_reports WHERE shift_id = 1 AND report_type = 'check_in' AND company_id = 1` },
  { name: '打刻の写真（api.ts）', at: ['src/api.ts', 'SELECT ar.photo_key FROM attendance_reports ar JOIN shifts s ON s.shift_id = ar.shift_id'],
    sql: `SELECT ar.photo_key FROM attendance_reports ar JOIN shifts s ON s.shift_id = ar.shift_id WHERE ar.attendance_id = 1 AND s.company_id = 1 AND ar.photo_key IS NOT NULL` },
  { name: 'シフトの担当の変更（api.ts）', at: ['src/api.ts', "UPDATE attendance_reports SET staff_id = ? WHERE shift_id = ?"],
    sql: `UPDATE attendance_reports SET staff_id = 2 WHERE shift_id = 1` },
  { name: 'スタッフの統合（staff-merge.ts）', at: ['src/staff-merge.ts', 'UPDATE attendance_reports SET staff_id = ? WHERE staff_id = ? AND company_id = ?'],
    sql: `UPDATE attendance_reports SET staff_id = 2 WHERE staff_id = 1 AND company_id = 1`, mustUse: 'idx_attendance_staff' },
  // 打刻の一覧・打刻修正（corrections.ts）
  { name: '打刻の一覧（corrections.ts）', at: ['src/corrections.ts', '${PUNCH_FROM} LEFT JOIN attendance_reports a ON a.shift_id = s.shift_id'],
    sql: `${PUNCH_SELECT} WHERE ${PUNCH_WHERE} GROUP BY s.shift_id ORDER BY s.work_date, s.start_time, us.name, s.shift_id LIMIT 501` },
  { name: '打刻の一覧: 記録方法で絞る（corrections.ts）', at: ['src/corrections.ts', 'EXISTS (SELECT 1 FROM attendance_reports y WHERE y.shift_id = s.shift_id AND y.entry_method = ?)'],
    sql: `${PUNCH_SELECT} WHERE ${PUNCH_WHERE} AND EXISTS (SELECT 1 FROM attendance_reports y WHERE y.shift_id = s.shift_id AND y.entry_method = 'proxy') GROUP BY s.shift_id ORDER BY s.work_date, s.start_time, us.name, s.shift_id LIMIT 501` },
  { name: '打刻修正: 承認の根拠（corrections.ts）', at: ['src/corrections.ts', 'FROM attendance_reports a LEFT JOIN users um ON um.user_id = a.entered_by`'],
    sql: `SELECT a.shift_id, a.attendance_id, a.report_type, um.name FROM attendance_reports a LEFT JOIN users um ON um.user_id = a.entered_by WHERE a.shift_id = 1` },
  { name: '打刻修正: 承認で報告を直す（corrections.ts）', at: ['src/corrections.ts', 'UPDATE attendance_reports SET reported_at = ?, status = ?'],
    sql: `UPDATE attendance_reports SET reported_at = '2026-11-14 09:00:00', original_reported_at = COALESCE(original_reported_at, reported_at) WHERE attendance_id = 1 AND EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id = 1 AND decision_token = 'x')` },
  { name: '打刻修正: 承認で写真を付ける（corrections.ts）', at: ['src/corrections.ts', 'UPDATE attendance_reports SET photo_key = (SELECT photo_key FROM attendance_correction_attachments'],
    sql: `UPDATE attendance_reports SET photo_key = (SELECT photo_key FROM attendance_correction_attachments WHERE correction_id = 1 ORDER BY attachment_id LIMIT 1) WHERE shift_id = 1 AND report_type = 'check_in' AND photo_key IS NULL` },
  { name: '打刻修正: 実績に関わる報告が同じか（corrections.ts）', at: ['src/corrections.ts', 'const SAME_REPORTS_SQL'],
    sql: `SELECT (SELECT reported_at FROM attendance_reports WHERE shift_id = 1 AND report_type = 'check_in') IS NULL AND (SELECT reported_at FROM attendance_reports WHERE shift_id = 1 AND report_type = 'check_out') IS NULL AS same` },
  // 打刻（attendance-punch.ts）
  { name: '打刻: 同じシフトの報告（attendance-punch.ts）', at: ['src/attendance-punch.ts', 'client_request_id FROM attendance_reports WHERE shift_id = ?'],
    sql: `SELECT report_type, reported_at, client_request_id FROM attendance_reports WHERE shift_id = 1` },
  { name: '打刻: 実績の反映の条件（attendance-punch.ts）', at: ['src/attendance-punch.ts', 'AND EXISTS (SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ? AND reported_at = ? AND received_at = ?)'],
    sql: `UPDATE shifts SET actual_start = '09:00' WHERE shift_id = 1 AND COALESCE(settle_status, 'planned') != 'confirmed' AND EXISTS (SELECT 1 FROM attendance_reports WHERE shift_id = 1 AND report_type = 'check_in' AND reported_at = '2026-11-14 09:00:00' AND received_at = '2026-11-14 09:00:00')` },
  { name: '打刻: 同時の送信の記録済みの内容（attendance-punch.ts）', at: ['src/attendance-punch.ts', 'const again = reqId'],
    sql: `SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = 1 AND report_type = 'check_in' AND client_request_id = 'x'` },
  { name: '打刻の取消（api.ts）', at: ['src/api.ts', 'DELETE FROM attendance_reports WHERE attendance_id = ? AND reported_at = ?'],
    sql: `DELETE FROM attendance_reports WHERE attendance_id = 1 AND reported_at = '2026-11-14 09:00:00' AND COALESCE(entry_method, 'app') = 'app' AND corrected_by_correction_id IS NULL` },
  // スタッフのホーム・代理入力・リマインド
  { name: 'スタッフのホーム: 報告（api.ts）', at: ['src/api.ts', 'FROM attendance_reports WHERE shift_id IN ${JSON_IN}`).bind(bindJsonArray(dIds))'],
    sql: `SELECT shift_id, report_type, reported_at FROM attendance_reports WHERE shift_id IN ${IDS}` },
  { name: '代理入力: 報告の一覧（staff-lifecycle.ts）', at: ['src/staff-lifecycle.ts', 'FROM attendance_reports a LEFT JOIN users um ON um.user_id = a.entered_by WHERE a.shift_id = ?'],
    sql: `SELECT a.report_type, um.name FROM attendance_reports a LEFT JOIN users um ON um.user_id = a.entered_by WHERE a.shift_id = 1` },
  { name: '代理入力: 記録した報告（staff-lifecycle.ts）', at: ['src/staff-lifecycle.ts', "AND entry_method = 'proxy' AND entered_by = ?"],
    sql: `SELECT shift_id, report_type FROM attendance_reports WHERE shift_id IN ${IDS} AND entry_method = 'proxy' AND entered_by = 1` },
  { name: 'リマインド: 起床の報告（reminders.ts）', at: ['src/services/reminders.ts', 'SELECT DISTINCT s.staff_id, s.work_date FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id'],
    sql: `SELECT DISTINCT s.staff_id, s.work_date FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id WHERE a.report_type = 'wake_up' AND s.staff_id IN ${IDS} AND s.work_date BETWEEN '2026-11-13' AND '2026-11-15'` },
  // 精算（settlement.ts）
  { name: '精算: 一覧の報告（settlement.ts の REPORT_JSON_COL）', at: ['src/settlement.ts', 'FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS reports_json'],
    sql: `SELECT s.shift_id, ${REPORT_JSON_COL} FROM shifts s WHERE s.company_id = 1 AND s.work_date BETWEEN '2026-10-01' AND '2026-10-31' AND s.status IN ('confirmed','substitute') ORDER BY s.work_date, s.shift_id` },
  { name: '精算: 報告の時刻の列（settlement.ts の REPORT_COLS）', at: ['src/settlement.ts', 'const REPORT_COLS'],
    sql: `SELECT s.shift_id, ${REPORT_COLS} FROM shifts s WHERE s.company_id = 1 AND s.work_date BETWEEN '2026-10-01' AND '2026-10-31'` },
  { name: '精算: 仮の報告あり（settlement.ts）', at: ['src/settlement.ts', "'EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id)'"],
    sql: `SELECT s.shift_id, (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS report_count FROM shifts s JOIN projects p ON p.project_id = s.project_id
      WHERE s.company_id = 1 AND s.status != 'absent' AND s.work_date BETWEEN '2026-10-01' AND '2026-10-31' AND EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id) LIMIT 201` },
  { name: '精算: 実績の同期（settlement.ts）', at: ['src/settlement.ts', 'const reps = (await db.prepare(`SELECT shift_id, report_type, reported_at FROM attendance_reports'],
    sql: `SELECT shift_id, report_type, reported_at FROM attendance_reports WHERE shift_id IN ${IDS} AND report_type IN (SELECT value FROM json_each('["check_in","check_out"]')) ORDER BY shift_id, attendance_id` },
]

// ---------- (2) src の確かめ ----------
const SRC_FILES = []
;(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) SRC_FILES.push(p) } })(join(ROOT, 'src'))
const srcText = Object.fromEntries(SRC_FILES.map(p => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]))
{
  const indexedBy = Object.entries(srcText).filter(([, t]) => /INDEXED\s+BY/i.test(t)).map(([f]) => f)
  ok('src: INDEXED BY で索引の名前を指す文が無い', indexedBy.length === 0, indexedBy)
  // 消した索引の名前は、コメントの中にしか出てこない
  const named = []
  for (const [f, t] of Object.entries(srcText)) t.split('\n').forEach((line, i) => {
    for (const n of DROPPED) { const at = line.indexOf(n); if (at >= 0 && !line.slice(0, at).includes('//')) named.push(`${f}:${i + 1}`) }
  })
  ok('src: 消した2つの索引の名前はコメントの中だけ', named.length === 0, named)
  // 一覧の文が今の src にある（src の文が変わったら、このテストの文も合わせる）
  const missing = Q.filter(x => !(srcText[x.at[0]] || '').includes(x.at[1])).map(x => x.name)
  ok('src: 調べる文が、今の src にそのまま残っている（at の文字列）', missing.length === 0, missing)
  const obDef = "const OB_ATTENDANCE = `${OB_CO} AND (shift_id IN (SELECT shift_id FROM shifts WHERE company_id = $C) OR staff_id IN ${OB_STAFF})`"
  ok('src: 解約企業の打刻の条件（OB_ATTENDANCE）がテストの式と同じ', srcText['src/services/retention.ts'].includes(obDef) && srcText['src/services/retention.ts'].includes("const OB_STAFF = '(SELECT staff_id FROM staff_profiles WHERE company_id = $C)'"))
  ok('src: 週次アクティブ・定期削除の位置情報の条件（locationPhotoSql）がテストの式と同じ',
    srcText['src/services/retention.ts'].includes("'(' + ['latitude', 'longitude', 'address', 'device_info', 'device_id', 'photo_key'].map(c => `${alias ? alias + '.' : ''}${c} IS NOT NULL`).join(' OR ') + ')'")
    && srcText['src/api.ts'].includes("WHERE ar.reported_at >= ? AND ${locationPhotoSql('ar')} AND COALESCE(ar.entry_method, 'app') = 'app' AND ${HQ_BILLABLE_SQL}"))
  // attendance_reports を引く文の行が、どれも一覧の文か、shift_id・attendance_id・staff_id で引く形・INSERT の行
  const HIT = /\b(FROM|JOIN|UPDATE|INTO) attendance_reports\b/
  const KEYED = /attendance_reports(?: (?!WHERE\b|ON\b)\w+)? (?:WHERE|ON) \(?(?:\w+\.)?(shift_id|attendance_id|staff_id) (?:=|IN\b)/
  const INSERT = /INSERT INTO attendance_reports \(/
  const uncovered = [], counts = { listed: 0, keyed: 0, insert: 0 }
  for (const [f, t] of Object.entries(srcText)) t.split('\n').forEach((line, i) => {
    const m = HIT.exec(line)
    if (!m || line.slice(0, m.index).includes('//') || /^\s*(\/\/|\*|--)/.test(line)) return
    if (Q.some(x => x.at[0] === f && line.includes(x.at[1]))) counts.listed++
    else if (KEYED.test(line)) counts.keyed++
    else if (INSERT.test(line)) counts.insert++
    else uncovered.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
  // 解約の表・ファイルの元の表の一覧（動的に文を作る）も一覧の文で調べる
  for (const [f, t] of Object.entries(srcText)) t.split('\n').forEach((line, i) => {
    if (/'attendance_reports'/.test(line) && /where: /.test(line) && !Q.some(x => x.at[0] === f && line.includes(x.at[1]))) uncovered.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
  info('src: attendance_reports を引く行（一覧の文・キーで引く形・INSERT）', counts)
  ok('src: attendance_reports を引く行は、どれも一覧の文か、shift_id・attendance_id・staff_id で引く形か INSERT', uncovered.length === 0 && counts.listed + counts.keyed >= 60, uncovered)
}

// ---------- (3) EXPLAIN QUERY PLAN ----------
// キーで引く形の代表（一意制約（shift_id, report_type）・主キー・idx_attendance_staff）も調べる
const KEYED_SAMPLES = {
  'キーで引く形: shift_id = ?': `SELECT report_type FROM attendance_reports WHERE shift_id = 1`,
  'キーで引く形: shift_id IN (json_each)': `SELECT shift_id, report_type FROM attendance_reports WHERE shift_id IN ${IDS}`,
  'キーで引く形: attendance_id IN (json_each)': `SELECT 1 FROM attendance_reports WHERE attendance_id IN ${IDS}`,
  'キーで引く形: staff_id = ?': `SELECT COUNT(*) FROM attendance_reports WHERE staff_id = 1`,
  'キーで引く形: シフトごとの相関（EXISTS・COUNT）': `SELECT s.shift_id, EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS r, (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS n FROM shifts s WHERE s.company_id = 1 AND s.work_date = '2026-11-14'`,
  'キーで引く形: リマインドの対象（reminders.ts）': `SELECT s.shift_id FROM shifts s WHERE s.work_date BETWEEN '2026-11-13' AND '2026-11-15' AND NOT EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type NOT IN ('wake_up', 'departure'))`,
}
const ALL = { ...Object.fromEntries(Q.map(x => [x.name, x.sql])), ...KEYED_SAMPLES }
const ATT_SCAN = /^SCAN (attendance_reports|a|ar|y)( |$)/
{
  ok('(3) 前提: 2つの索引が無い状態で調べる', (await attIndexes()).every(n => !DROPPED.includes(n)))
  const after = await plans(ALL)
  await sql(RECREATE)
  const before = await plans(ALL)
  await sql(DROP)
  ok('(3) 調べ終わったら2つの索引は無い状態に戻っている', (await attIndexes()).every(n => !DROPPED.includes(n)))
  const changed = []
  for (const k of Object.keys(ALL)) {
    const p = after[k]
    ok(`索引なしで全件読みにならない（${k}）`, !p.some(d => ATT_SCAN.test(d)) && !p.some(d => DROPPED.some(n => d.includes(n))), p)
    const must = Q.find(x => x.name === k)?.mustUse
    if (must) ok(`索引なしで ${must} を使う（${k}）`, p.some(d => d.includes(must)), p)
    if (JSON.stringify(p) !== JSON.stringify(before[k])) changed.push(k)
  }
  // 消す前に2つの索引を使っていた文（今のコードでは無い想定。あれば計画の違いを出す）
  const usedBefore = Object.keys(ALL).filter(k => before[k].some(d => DROPPED.some(n => d.includes(n))))
  const attLines = (p) => p.filter(d => /attendance_reports|^(SCAN|SEARCH) (a|ar|y) |TEMP B-TREE/.test(d)).join(' | ')
  info('(3) 2つの索引があると、それを使う文（打刻の表の行だけ）', usedBefore.map(k => ({ k, before: attLines(before[k]), after: attLines(after[k]) })))
  info('(3) 索引の有無で計画が変わる文', changed)
  info('(3) 調べた文の数', Object.keys(ALL).length)
}

// ---------- (4) API の応答が索引の有無で同じ ----------
const hq = client(await login('', 'hq'))
const admin = client(await login('sample', 'admin'))
const PFX = 'W27I' + Date.now().toString(36).slice(-4).toUpperCase()
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
{
  const from = addDays(today, -30)
  const anyStaff = (await sql(`SELECT staff_id FROM attendance_reports WHERE company_id = 1 GROUP BY staff_id ORDER BY COUNT(*) DESC LIMIT 1`))[0].staff_id
  // 応答から、呼ぶたびに変わる値（日時・ID）を除く
  const strip = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => /(^|_)(at|now|id)$|generated|elapsed|duration|log/i.test(k) && typeof x !== 'object' ? undefined : x))
  const CALLS = {
    '本部: 企業一覧（週次アクティブ）': () => hq.get('/api/hq/companies'),
    '本部: 企業の詳細（総勤怠報告。sample）': () => hq.get('/api/hq/companies/1'),
    '本部: 企業の詳細（総勤怠報告。打刻なしの demo3）': () => hq.get('/api/hq/companies/3'),
    '解約: 件数（sample）': () => hq.get('/api/hq/offboarding/1'),
    '解約: 件数（打刻なしの demo3）': () => hq.get('/api/hq/offboarding/3'),
    '定期削除: dry-run': () => hq.post('/api/hq/retention/dry-run'),
    '打刻の一覧（31日）': () => admin.get(`/api/admin/attendance-punches?from=${from}&to=${today}`),
    '精算（31日）': () => admin.get(`/api/admin/settlement?from=${from}&to=${today}`),
    'ダッシュボード': () => admin.get('/api/admin/dashboard'),
    'スタッフ詳細（打刻の多い人）': () => admin.get(`/api/admin/staff/${anyStaff}`),
  }
  const pick = {
    '本部: 企業一覧（週次アクティブ）': d => d.companies.map(c => [c.company_id, c.active_users, c.active_users_30d]),
    '本部: 企業の詳細（総勤怠報告。sample）': d => d.stats,
    '本部: 企業の詳細（総勤怠報告。打刻なしの demo3）': d => d.stats,
    '定期削除: dry-run': d => d.results.map(t => [t.target, t.targetCount]),
  }
  const run = async () => {
    const out = {}
    for (const [k, f] of Object.entries(CALLS)) { const r = await f(); out[k] = { status: r.status, body: strip((pick[k] || (d => d))(r.data)), read: r.read } }
    return out
  }
  const a1 = await run()
  await sql(RECREATE)
  const b1 = await run()
  await sql(DROP)
  for (const k of Object.keys(CALLS)) {
    ok(`API: 索引の有無で応答が同じ（${k}）`, a1[k].status === 200 && b1[k].status === 200 && JSON.stringify(a1[k].body) === JSON.stringify(b1[k].body),
      { after: [a1[k].status, JSON.stringify(a1[k].body).slice(0, 300)], before: [b1[k].status, JSON.stringify(b1[k].body).slice(0, 300)] })
  }
  info('API: 読み取りの行数（索引なし / 索引あり）', Object.fromEntries(Object.keys(CALLS).map(k => [k, `${a1[k].read} / ${b1[k].read}`])))
  const [{ n: attTotal }] = await sql(`SELECT COUNT(*) AS n FROM attendance_reports`)
  // 打刻の無い企業で打刻の表を全部読むと、索引があるときより attTotal 行ほど多く読む（ほかの表も読むので、索引ありとの差で見る）
  for (const k of ['本部: 企業の詳細（総勤怠報告。打刻なしの demo3）', '解約: 件数（打刻なしの demo3）'])
    ok(`API: 打刻の無い企業では、索引なしでも打刻の表を全部は読まない（${k}）`, a1[k].read != null && b1[k].read != null && a1[k].read - b1[k].read < attTotal / 2, { after: a1[k].read, before: b1[k].read, attTotal })
  // 企業の詳細・週次アクティブは、索引があってもなくても同じ計画（読み取りの行数も同じ）
  for (const k of ['本部: 企業一覧（週次アクティブ）', '本部: 企業の詳細（総勤怠報告。sample）'])
    ok(`API: 索引なしでも読み取りの行数が増えない（${k}）`, a1[k].read != null && a1[k].read <= b1[k].read, { after: a1[k].read, before: b1[k].read })

  // 書き出し・ファイルの一覧（利用状態が「停止」の企業だけ。sample を一時的に停止にして、最後に戻す）
  const [co] = await sql(`SELECT active_status FROM companies WHERE company_id = 1`)
  await sql(`UPDATE companies SET active_status = 'inactive' WHERE company_id = 1`)
  try {
    const exp = async () => {
      const pages = []
      for (let off = 0, i = 0; i < 20; i++) {
        const r = await hq.get(`/api/hq/offboarding/1/export/attendance_reports?offset=${off}`)
        pages.push({ status: r.status, text: r.text, rows: r.headers.get('x-export-rows'), read: r.read })
        const next = r.headers.get('x-export-next')
        if (r.status !== 200 || !next) break
        off = Number(next)
      }
      const files = await hq.get('/api/hq/offboarding/1/files?offset=0')
      return { pages, files: { status: files.status, body: files.data, read: files.read } }
    }
    const ea = await exp()
    await sql(RECREATE)
    const eb = await exp()
    await sql(DROP)
    const total = ea.pages.reduce((s, p) => s + Number(p.rows || 0), 0)
    const [{ n }] = await sql(`SELECT COUNT(*) AS n FROM attendance_reports WHERE company_id = 1`)
    ok('API: 解約の書き出し（出退勤記録）の行数が企業の打刻の数と同じ（索引なし）', ea.pages.every(p => p.status === 200) && total === n, { total, n, pages: ea.pages.map(p => [p.status, p.rows]) })
    ok('API: 解約の書き出しの CSV が索引の有無で同じ（行の順も同じ）', ea.pages.length === eb.pages.length && ea.pages.every((p, i) => p.text === eb.pages[i].text), ea.pages.map((p, i) => [p.rows, eb.pages[i]?.rows]))
    ok('API: 解約のファイルの一覧が索引の有無で同じ', ea.files.status === 200 && JSON.stringify(ea.files.body) === JSON.stringify(eb.files.body), [ea.files.status, eb.files.status])
    info('API: 解約の書き出しの読み取りの行数（ページごと。索引なし / 索引あり）', ea.pages.map((p, i) => `${p.read} / ${eb.pages[i]?.read}`))
  } finally {
    await sql(`UPDATE companies SET active_status = ${q(co.active_status)} WHERE company_id = 1`)
  }
  ok('(4) 終わったら2つの索引は無い状態に戻っている', (await attIndexes()).every(n => !DROPPED.includes(n)))
}

// ---------- (5) 打刻1回の書き込みの行数 ----------
{
  const P1 = await newProject(`${PFX}-案件`)
  // 同じ種類の打刻（起床）を、新しいスタッフ・新しいシフトで1回ずつ。セッションの延長・最終利用の更新が混ざらないように、先に1回読んでから打刻する
  const punch = async (k) => {
    const s = await newStaff(k)
    const shiftId = await createShift(s.staff_id, P1, today)
    const st = client(await login('sample', `${PFX}${k}`))
    must(await st.get('/api/auth/me'), 'me')
    must(await st.get('/api/staff/home'), 'home')
    const r = await st.post('/api/staff/attendance', { shift_id: shiftId, report_type: 'wake_up', client_request_id: `${PFX}${k}`, pressed_at: Date.now(), device_now: Date.now() })
    must(r, 'punch ' + k)
    const [row] = await sql(`SELECT COUNT(*) AS n FROM attendance_reports WHERE shift_id = ${shiftId} AND report_type = 'wake_up'`)
    return { written: r.written, read: r.read, saved: row.n }
  }
  const a1 = await punch('A1')
  await sql(RECREATE)
  const b1 = await punch('B1')
  await sql(DROP)
  const a2 = await punch('A2')
  info('打刻1回（起床）の書き込みの行数（索引なし1回目 / 索引あり / 索引なし2回目）', [a1.written, b1.written, a2.written])
  ok('打刻: どの回も1件記録された', a1.saved === 1 && b1.saved === 1 && a2.saved === 1, [a1, b1, a2])
  ok('打刻: 書き込みの行数が、索引を消す前より2行少ない（2回とも）', b1.written - a1.written === 2 && b1.written - a2.written === 2, [a1.written, b1.written, a2.written])
  ok('(5) 終わったら2つの索引は無い状態に戻っている', (await attIndexes()).every(n => !DROPPED.includes(n)))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
