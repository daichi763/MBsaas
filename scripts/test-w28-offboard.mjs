// 解約企業の書き出し・ファイルの一覧を、続きの位置（キーセット）で区切る（Sprint 28 作業単位 w28-offboard）の統合テスト
//  (1) 書き出し: offset で区切る取得（今までの取得。古い画面のため残す）と cursor で区切る取得で、すべてのページを合わせた行が同じ
//      （打刻は行の集まりが同じ。ほかの表は CSV が1文字まで同じ）。ページの境目で重なり・抜けが無い。1ページは 500 行まで
//      企業: 打刻の多い企業（同じ日に多くのシフト・精算の状態の NULL・打刻の無いシフト・ほかの企業のシフトに付く打刻を含む）、
//      シフトが少なく打刻の多い企業（1人のスタッフに 992 行。ちょうど 1000 行で2ページ）、データの無い企業
//  (2) ファイルの一覧: offset と cursor で、すべてのページを合わせたファイルが同じ（打刻の写真のほかは順も同じ）
//  (3) cursor が正しくないと 400。cursor=start の最初の取得だけ書き出しの記録が残る
//  (4) EXPLAIN QUERY PLAN: 打刻を引く文が全件読み（SCAN）にならない。シフトの窓は索引の順に読み、並べ替えない。
//      ほかの表の cursor の文は、offset の文より悪い計画（その表の SCAN）にならない
//  (5) 読み取りの行数（X-Test-D1-Rows）: 打刻の多い企業の書き出しで、ページごとの最大・合計が offset より少ない（ページごとの値を INFO に出す）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --var TEST_HOOKS:true --port 9021 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w28-offboard.mjs
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと（npm test -- w28-offboard なら自動）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w28o-'))
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
// 複数の文の計画を少ない wrangler の起動で取る（test-w27-index と同じ。6文ずつ、通らなければ半分に分けてやり直す）。{ 名前: 文 } → { 名前: [detail…] }
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 400)}`); return r.data }

const hq = client(await login('', 'hq'))
const SUF = Date.now().toString(36).slice(-5)
const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
const TYPES_CTE = `t(i, ty) AS (VALUES ${TYPES.map((t, i) => `(${i + 1}, '${t}')`).join(', ')})`

// ---------- テスト用の企業とデータ ----------
async function newCompany(k) {
  const code = `w28${k}${SUF}`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `w28 ${k}`, admin_code: 'admin', admin_password: 'Passw0rd!Long' }), 'company ' + k)
  const [{ company_id }] = await sql(`SELECT company_id FROM companies WHERE company_code = '${code}'`)
  return Number(company_id)
}
const A = await newCompany('a'), B = await newCompany('b'), C = await newCompany('c'), D = await newCompany('d')
const staffSql = (cid, n, k) => `
WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < ${n})
  INSERT INTO users (company_id, user_code, name, role, password_hash, email) SELECT ${cid}, 's' || v, '${k}' || v, 'staff', 'x', '${k}' || v || '-${SUF}@example.com' FROM n;
INSERT INTO staff_profiles (user_id, company_id) SELECT user_id, ${cid} FROM users WHERE company_id = ${cid} AND role = 'staff';
INSERT INTO projects (company_id, project_name) VALUES (${cid}, 'w28 ${k}');`
const nth = (cid, expr, n) => `(SELECT x.staff_id FROM (SELECT staff_id, ROW_NUMBER() OVER (ORDER BY staff_id) - 1 AS k FROM staff_profiles WHERE company_id = ${cid}) x WHERE x.k = (${expr}) % ${n})`
const proj = (cid) => `(SELECT project_id FROM projects WHERE company_id = ${cid} LIMIT 1)`
await sql(`${staffSql(A, 30, 'a')}${staffSql(B, 5, 'b')}${staffSql(C, 3, 'c')}`)
// A: 900 シフト。1〜200 は同じ日（ページの境目が日の途中に来る）、801〜900 は先の日付で打刻なし。精算の状態は NULL・planned・confirmed を混ぜる
await sql(`
WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 900)
  INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, settle_status)
  SELECT ${A}, ${nth(A, 'v', 30)}, ${proj(A)},
    CASE WHEN v <= 200 THEN '2025-06-01' WHEN v > 800 THEN date('2027-01-01', '+' || (v % 50) || ' days') ELSE date('2025-01-01', '+' || ((v * 7) % 120) || ' days') END,
    '10:00', '19:00', 'confirmed', CASE v % 3 WHEN 0 THEN NULL WHEN 1 THEN 'planned' ELSE 'confirmed' END FROM n;
WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 200)
  INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status)
  SELECT ${B}, ${nth(B, 'v', 5)}, ${proj(B)}, date('2025-03-01', '+' || (v % 30) || ' days'), '10:00', '19:00', 'confirmed' FROM n;
INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status) SELECT ${C}, ${nth(C, 0, 3)}, ${proj(C)}, '2025-05-05', '10:00', '19:00', 'confirmed';`)
const bShifts = (await sql(`SELECT shift_id FROM shifts WHERE company_id = ${B} ORDER BY shift_id`)).map(r => r.shift_id)
const inList = (a) => `(${a.join(',')})`
// 打刻: rowid の順がシフトの順と違うよう、種類の順に入れる。写真は入店の一部。ほかの企業の打刻を間に挟む
await sql(`
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, photo_key)
  SELECT s.company_id, s.staff_id, s.shift_id, t.ty, s.work_date || ' 09:00:00', CASE WHEN t.i IN (3, 8) AND s.shift_id % 2 = 0 THEN 'w28/a/' || s.shift_id || '-' || t.i || '.jpg' END
  FROM shifts s JOIN t ON t.i <= s.shift_id % 9 WHERE s.company_id = ${A} AND s.work_date < '2027-01-01' AND t.i <= 4 ORDER BY t.i, s.shift_id DESC;
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at)
  SELECT s.company_id, s.staff_id, s.shift_id, t.ty, s.work_date || ' 09:00:00' FROM shifts s JOIN t ON t.i <= 8 WHERE s.shift_id IN ${inList(bShifts.slice(0, 40))};
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, photo_key)
  SELECT s.company_id, s.staff_id, s.shift_id, t.ty, s.work_date || ' 09:00:00', CASE WHEN t.i = 8 AND s.shift_id % 2 = 0 THEN 'w28/a/' || s.shift_id || '-' || t.i || '.jpg' END
  FROM shifts s JOIN t ON t.i <= s.shift_id % 9 WHERE s.company_id = ${A} AND s.work_date < '2027-01-01' AND t.i > 4 ORDER BY s.shift_id;
-- A のスタッフの打刻で、B のシフトに付くもの（2段目。A の行）
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, photo_key)
  SELECT ${A}, ${nth(A, 's.shift_id', 30)}, s.shift_id, t.ty, s.work_date || ' 08:00:00', CASE WHEN t.i = 3 THEN 'w28/at/' || s.shift_id || '.jpg' END FROM shifts s, t WHERE s.shift_id IN ${inList(bShifts.slice(40, 60))};
-- B の行で A のスタッフのもの（A には入らない）
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at) SELECT ${B}, ${nth(A, 1, 30)}, s.shift_id, t.ty, s.work_date || ' 08:00:00' FROM shifts s, t WHERE s.shift_id IN ${inList(bShifts.slice(60, 62))};
-- C: シフト1つに 8 行と、1人のスタッフの B のシフトに付く 992 行（合わせてちょうど 1000 行）
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, photo_key)
  SELECT s.company_id, s.staff_id, s.shift_id, t.ty, '2025-05-05 09:00:00', CASE WHEN t.i = 3 THEN 'w28/c.jpg' END FROM shifts s, t WHERE s.company_id = ${C};
WITH ${TYPES_CTE}
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, photo_key)
  SELECT ${C}, ${nth(C, 1, 3)}, s.shift_id, t.ty, s.work_date || ' 07:00:00', CASE WHEN t.i = 3 AND s.shift_id % 3 = 0 THEN 'w28/ct/' || s.shift_id || '.jpg' END FROM shifts s, t WHERE s.shift_id IN ${inList(bShifts.slice(62, 186))};
-- A の打刻のうち1シフト分は B のスタッフ（1段目。シフトが A なら A の行）
UPDATE attendance_reports SET staff_id = ${nth(B, 0, 5)} WHERE shift_id = (SELECT MIN(shift_id) FROM shifts WHERE company_id = ${A} AND shift_id % 9 = 8);`)
for (const cid of [A, B, C, D]) must(await hq.put(`/api/hq/companies/${cid}`, { active_status: 'inactive' }), 'inactive ' + cid)
const counts = Object.fromEntries(await Promise.all([A, C, D].map(async cid => [cid, (await sql(`SELECT COUNT(*) AS n FROM attendance_reports WHERE company_id = ${cid}
  AND (shift_id IN (SELECT shift_id FROM shifts WHERE company_id = ${cid}) OR staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = ${cid}))`))[0].n])))
info('打刻の数（A・C・D）', counts)
ok('前提: A の打刻は数ページ分、C はちょうど 1000 行、D は 0 行', counts[A] > 2000 && counts[C] === 1000 && counts[D] === 0, counts)

// ---------- (1) 書き出し ----------
async function exportAll(cid, target, mode) {
  const pages = []
  let pos = mode === 'offset' ? '0' : 'start'
  for (let i = 0; i < 200; i++) {
    const r = await hq.get(`/api/hq/offboarding/${cid}/export/${target}?${mode}=${encodeURIComponent(pos)}`)
    const text = r.text.replace(/^﻿/, '')
    const lines = text.split('\r\n'); lines.pop()
    pages.push({ status: r.status, rows: Number(r.headers.get('x-export-rows')), head: lines[0] ?? '', lines: lines.slice(1), next: r.headers.get('x-export-next'), read: r.read })
    if (r.status !== 200 || !r.headers.get('x-export-next')) break
    pos = r.headers.get('x-export-next')
  }
  const head = pages.find(p => p.rows > 0)?.head ?? ''
  return { pages, head, lines: pages.flatMap(p => p.lines), ok: pages.every(p => p.status === 200 && p.rows === p.lines.length) }
}
const sortStr = (a) => [...a].sort()
const sumRead = (pages) => pages.reduce((s, p) => s + (p.read || 0), 0)
const maxRead = (pages) => Math.max(...pages.map(p => p.read || 0))
const readStats = {}
for (const [k, cid] of [['A', A], ['C', C], ['D', D]]) {
  const before = await exportAll(cid, 'attendance_reports', 'offset')
  const after = await exportAll(cid, 'attendance_reports', 'cursor')
  readStats[k] = { before: before.pages.map(p => p.read), after: after.pages.map(p => p.read) }
  ok(`書き出し（${k}・打刻）: すべての要求が 200、行数のヘッダーと行が合う`, before.ok && after.ok, { b: before.pages.map(p => [p.status, p.rows]), a: after.pages.map(p => [p.status, p.rows]) })
  ok(`書き出し（${k}・打刻）: 行の数が企業の打刻の数と同じ（offset・cursor）`, before.lines.length === counts[cid] && after.lines.length === counts[cid], [before.lines.length, after.lines.length, counts[cid]])
  ok(`書き出し（${k}・打刻）: 見出しが同じ`, before.head === after.head, [before.head, after.head])
  ok(`書き出し（${k}・打刻）: すべてのページを合わせた行の集まりが同じ`, JSON.stringify(sortStr(before.lines)) === JSON.stringify(sortStr(after.lines)))
  ok(`書き出し（${k}・打刻）: cursor のページの境目で重なりが無い（attendance_id が重ならない）`, new Set(after.lines.map(l => l.split(',')[0])).size === after.lines.length)
  ok(`書き出し（${k}・打刻）: 1ページは 500 行まで、最後のページだけ次が空`, after.pages.every(p => p.rows <= 500) && after.pages.slice(0, -1).every(p => p.next) && after.pages.at(-1).next === '',
    after.pages.map(p => [p.rows, !!p.next]))
  if (k === 'C') ok('書き出し（C・打刻）: ちょうど 1000 行は 500 行の2ページ（空のページを足さない。1人のスタッフの途中で区切る）', after.pages.length === 2 && after.pages.every(p => p.rows === 500), after.pages.map(p => p.rows))
  if (k === 'D') ok('書き出し（D・打刻）: 打刻の無い企業は1ページ・0行・次は空', after.pages.length === 1 && after.pages[0].rows === 0 && after.pages[0].next === '', after.pages)
}
// ほかの表: CSV が offset と同じ（rowid の順）
for (const [k, cid] of [['A', A], ['C', C], ['D', D]]) {
  const d = must(await hq.get(`/api/hq/offboarding/${cid}`), 'detail')
  const targets = d.tables.filter(t => t.export && t.target !== 'attendance_reports').map(t => t.target)
  const diff = [], multi = []
  for (const t of targets) {
    const b = await exportAll(cid, t, 'offset'), a = await exportAll(cid, t, 'cursor')
    if (!(b.ok && a.ok && b.head === a.head && JSON.stringify(b.lines) === JSON.stringify(a.lines))) diff.push({ t, b: b.lines.length, a: a.lines.length })
    if (a.pages.length > 1) multi.push(`${t}:${a.pages.length}`)
  }
  ok(`書き出し（${k}・ほかの ${targets.length} 表）: cursor の CSV が offset と同じ（行の順も同じ）`, diff.length === 0 && targets.length > 40, diff)
  if (k === 'A') ok('書き出し（A）: 500 行を超える表（シフト）も cursor で区切って同じ', multi.some(x => x.startsWith('shifts:')), multi)
}

// ---------- (2) ファイルの一覧 ----------
async function filesAll(cid, mode) {
  const pages = []
  let pos = mode === 'offset' ? '0' : 'start'
  for (let i = 0; i < 200; i++) {
    const r = await hq.get(`/api/hq/offboarding/${cid}/files?${mode}=${encodeURIComponent(pos)}`)
    pages.push({ status: r.status, n: r.data?.files?.length, read: r.read })
    if (r.status !== 200) break
    pages.at(-1).files = r.data.files
    const next = mode === 'offset' ? r.data.next : r.data.next_cursor
    if (next == null) break
    pos = String(next)
  }
  return { pages, files: pages.flatMap(p => p.files || []), ok: pages.every(p => p.status === 200 && p.n <= 100) }
}
for (const [k, cid] of [['A', A], ['C', C], ['D', D]]) {
  const b = await filesAll(cid, 'offset'), a = await filesAll(cid, 'cursor')
  const key = (f) => JSON.stringify(f)
  ok(`ファイル（${k}）: すべての要求が 200、1ページ 100 件まで`, b.ok && a.ok, { b: b.pages.map(p => [p.status, p.n]), a: a.pages.map(p => [p.status, p.n]) })
  ok(`ファイル（${k}）: すべてのページを合わせたファイルが同じ（${a.files.length} 件）`, JSON.stringify(sortStr(b.files.map(key))) === JSON.stringify(sortStr(a.files.map(key))), [b.files.length, a.files.length])
  ok(`ファイル（${k}）: 重なりが無い`, new Set(a.files.map(f => `${f.source}:${f.id}`)).size === a.files.length)
  ok(`ファイル（${k}）: 打刻の写真のほかは順も同じ`, JSON.stringify(b.files.filter(f => f.source !== 'attendance_reports')) === JSON.stringify(a.files.filter(f => f.source !== 'attendance_reports')))
  if (k === 'A') {
    ok('ファイル（A）: 数ページにまたがる', a.pages.length >= 3, a.pages.map(p => p.n))
    readStats.filesA = { before: b.pages.map(p => p.read), after: a.pages.map(p => p.read) }
  }
  if (k === 'D') ok('ファイル（D）: ファイルの無い企業は空の一覧で次が無い', a.pages.length === 1 && a.pages[0].n === 0)
}

// ---------- (3) cursor の確かめ・記録 ----------
{
  for (const bad of ['xyz!', 'eyJ6Ijox', encodeURIComponent('{"p":"s"}'), 'eyJwIjoicyIsImlkIjoiMSJ9'])
    ok(`cursor が正しくないと 400（${bad}）`, (await hq.get(`/api/hq/offboarding/${A}/export/attendance_reports?cursor=${bad}`)).status === 400)
  ok('ファイルの一覧の cursor が正しくないと 400', (await hq.get(`/api/hq/offboarding/${A}/files?cursor=xyz!`)).status === 400)
  const [{ n: e1 }] = await sql(`SELECT COUNT(*) AS n FROM company_offboarding_events WHERE company_id = ${C} AND action = 'export'`)
  await exportAll(C, 'attendance_reports', 'cursor')
  const [{ n: e2 }] = await sql(`SELECT COUNT(*) AS n FROM company_offboarding_events WHERE company_id = ${C} AND action = 'export'`)
  ok('書き出しの記録は cursor=start の最初の取得だけ（2ページで1件）', e2 - e1 === 1, [e1, e2])
  ok('書き出せない表は cursor でも 404', (await hq.get(`/api/hq/offboarding/${A}/export/sessions?cursor=start`)).status === 404)
  // 利用中の企業は書き出せない（cursor でも同じ）
  ok('利用中の企業は cursor でも書き出せない（409）', (await hq.get(`/api/hq/offboarding/1/export/attendance_reports?cursor=start`)).status === 409)
}

// ---------- (4) EXPLAIN QUERY PLAN ----------
const SRC = readFileSync(join(ROOT, 'src/services/retention.ts'), 'utf8').split('\r\n').join('\n')
{
  const at = [
    'SELECT shift_id, work_date, settle_status FROM shifts WHERE company_id = ?${after.sql} ORDER BY work_date, settle_status, shift_id LIMIT ?',
    'SELECT ${cols} FROM attendance_reports a WHERE a.shift_id IN (${win}) AND a.company_id = ?${extra}',
    'const win = `SELECT staff_id FROM staff_profiles WHERE company_id = ? AND staff_id >= ? ORDER BY staff_id LIMIT ?`',
    'SELECT ${cols} FROM attendance_reports a WHERE a.staff_id IN (${win}) AND a.company_id = ?',
    'AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.shift_id = a.shift_id AND s.company_id = ?)${extra}',
    ' AND a.photo_key IS NOT NULL',
    'SELECT rowid AS __ob_rowid, * FROM ${t.table} WHERE ${w.sql} AND rowid > ? ORDER BY rowid LIMIT ?',
    'FROM ${f.source} WHERE ${w.sql} AND ${f.keyCol} IS NOT NULL AND ${f.idCol} > ? ORDER BY ${f.idCol} LIMIT ?',
  ]
  const missing = at.filter(s => !SRC.includes(s))
  ok('src: 調べる文が retention.ts にそのまま残っている', missing.length === 0, missing)
  const AFTER_NULL = ` AND work_date >= '2025-06-01' AND (work_date > '2025-06-01' OR (settle_status IS NOT NULL OR shift_id >= 100))`
  const AFTER_SS = ` AND work_date >= '2025-06-01' AND (work_date > '2025-06-01' OR (settle_status > 'planned' OR (settle_status = 'planned' AND shift_id > 100)))`
  const win = (after) => `SELECT shift_id FROM shifts WHERE company_id = ${A}${after} ORDER BY work_date, settle_status, shift_id LIMIT 63`
  const swin = `SELECT staff_id FROM staff_profiles WHERE company_id = ${C} AND staff_id >= 0 ORDER BY staff_id LIMIT 20`
  const Q = {
    'シフトの窓（最初）': `SELECT shift_id, work_date, settle_status FROM shifts WHERE company_id = ${A} ORDER BY work_date, settle_status, shift_id LIMIT 63`,
    'シフトの窓（精算の状態が NULL の位置から）': `SELECT shift_id, work_date, settle_status FROM shifts WHERE company_id = ${A}${AFTER_NULL} ORDER BY work_date, settle_status, shift_id LIMIT 63`,
    'シフトの窓（精算の状態のある位置の次から）': `SELECT shift_id, work_date, settle_status FROM shifts WHERE company_id = ${A}${AFTER_SS} ORDER BY work_date, settle_status, shift_id LIMIT 63`,
    '1段目の打刻': `SELECT a.* FROM attendance_reports a WHERE a.shift_id IN (${win(AFTER_SS)}) AND a.company_id = ${A}`,
    '1段目の写真': `SELECT a.attendance_id, a.shift_id, a.staff_id, a.photo_key, a.reported_at FROM attendance_reports a WHERE a.shift_id IN (${win(AFTER_NULL)}) AND a.company_id = ${A} AND a.photo_key IS NOT NULL`,
    'スタッフの窓': swin,
    '2段目の打刻': `SELECT a.* FROM attendance_reports a WHERE a.staff_id IN (${swin}) AND a.company_id = ${C}
          AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.shift_id = a.shift_id AND s.company_id = ${C})`,
    '2段目の写真': `SELECT a.attendance_id, a.shift_id, a.staff_id, a.photo_key, a.reported_at FROM attendance_reports a WHERE a.staff_id IN (${swin}) AND a.company_id = ${C}
          AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.shift_id = a.shift_id AND s.company_id = ${C}) AND a.photo_key IS NOT NULL`,
  }
  const OLD = {
    '（前）書き出しの offset': `SELECT * FROM attendance_reports WHERE (company_id = ${A} AND (shift_id IN (SELECT shift_id FROM shifts WHERE company_id = ${A}) OR staff_id IN (SELECT staff_id FROM staff_profiles WHERE company_id = ${A}))) ORDER BY rowid LIMIT 500 OFFSET 500`,
  }
  const P = await plans({ ...Q, ...OLD })
  const ATT_SCAN = /^SCAN (attendance_reports|a)( |$)/
  for (const k of Object.keys(Q)) ok(`EXPLAIN: 打刻・シフトを全件読みにしない（${k}）`, !P[k].some(d => ATT_SCAN.test(d) || /^SCAN shifts( |$)/.test(d)), P[k])
  for (const k of Object.keys(Q).filter(k => k.startsWith('シフトの窓')))
    ok(`EXPLAIN: シフトの窓は索引 idx_shifts_company_date_settle の順に読み、並べ替えない（${k}）`, P[k].some(d => d.includes('idx_shifts_company_date_settle')) && !P[k].some(d => /TEMP B-TREE/.test(d)), P[k])
  for (const k of ['1段目の打刻', '1段目の写真']) ok(`EXPLAIN: 1段目は一意制約（shift_id, report_type）で引く（${k}）`, P[k].some(d => /SEARCH a USING INDEX sqlite_autoindex_attendance_reports_1 \(shift_id=\?\)/.test(d)), P[k])
  for (const k of ['2段目の打刻', '2段目の写真']) ok(`EXPLAIN: 2段目は idx_attendance_staff で引く（${k}）`, P[k].some(d => /SEARCH a USING INDEX idx_attendance_staff \(staff_id=\?\)/.test(d)), P[k])
  info('EXPLAIN: 今まで（offset）の計画', P['（前）書き出しの offset'])
  info('EXPLAIN: cursor の計画', Object.fromEntries(Object.keys(Q).map(k => [k, P[k].join(' | ')])))

  // ほかの表: cursor の文が offset の文より悪い計画（その表の SCAN）にならない
  const consts = {}
  for (const m of SRC.matchAll(/^const (OB_\w+) = (['`])(.*)\2$/gm)) consts[m[1]] = m[3]
  const expand = (s) => s.replace(/\$\{(OB_\w+)\}/g, (_, n) => expand(consts[n]))
  for (const k of Object.keys(consts)) consts[k] = expand(consts[k])
  const tables = []
  for (const m of SRC.matchAll(/\{ target: '(\w+)', label: '[^']*', table: '(\w+)', where: (OB_\w+|`[^`]*`)( ?, ?noExport: true)?[^}]*\}/g)) {
    if (m[4] || m[2] === 'attendance_reports') continue
    tables.push({ table: m[2], where: (m[3].startsWith('`') ? expand(m[3].slice(1, -1)) : consts[m[3]]).split('$C').join(String(A)) })
  }
  const worse = []
  const TP = await plans(Object.fromEntries(tables.flatMap((t, i) => [
    [`o${i}`, `SELECT * FROM ${t.table} WHERE (${t.where}) ORDER BY rowid LIMIT 500 OFFSET 500`],
    [`c${i}`, `SELECT rowid AS __ob_rowid, * FROM ${t.table} WHERE (${t.where}) AND rowid > 100 ORDER BY rowid LIMIT 501`]])))
  for (const [i, t] of tables.entries()) {
    const off = TP[`o${i}`], cur = TP[`c${i}`]
    const scan = (p) => p.some(d => new RegExp(`^SCAN ${t.table}( |$)`).test(d))
    if (scan(cur) && !scan(off)) worse.push({ t: t.table, off, cur })
  }
  ok(`EXPLAIN: ほかの表（${tables.length} 表）の cursor の文は、offset の文になかった全件読みをしない`, tables.length > 40 && worse.length === 0, worse)
}

// ---------- (5) 読み取りの行数 ----------
{
  const a = readStats.A
  info('読み取りの行数（A・打刻の書き出し。ページごと。offset）', a.before)
  info('読み取りの行数（A・打刻の書き出し。ページごと。cursor）', a.after)
  info('読み取りの行数（C・打刻の書き出し。offset / cursor）', [readStats.C.before, readStats.C.after])
  info('読み取りの行数（D・打刻の書き出し。offset / cursor）', [readStats.D.before, readStats.D.after])
  info('読み取りの行数（A・ファイルの一覧。offset / cursor）', [readStats.filesA.before, readStats.filesA.after])
  ok('読み取りの行数: A の書き出しのページごとの最大が offset より少ない', a.after.every(x => x != null) && maxRead(a.after.map(read => ({ read }))) < maxRead(a.before.map(read => ({ read }))),
    { before: a.before, after: a.after })
  ok('読み取りの行数: A の書き出しの合計が offset より少ない', sumRead(a.after.map(read => ({ read }))) < sumRead(a.before.map(read => ({ read }))))
  // 2段目（企業のシフトに付かない打刻）はスタッフの打刻を全部読むが、1回の要求で読む量に上限（OB_ATT_READ_BUDGET 2000 行＋窓1つ分）がある
  ok('読み取りの行数: A の書き出しの cursor のページは、どれも offset のいちばん少ないページの半分より少ない', a.after.every(x => x != null && x < Math.min(...a.before) / 2), { after: a.after, before: a.before })
  const f = readStats.filesA
  ok('読み取りの行数: A のファイルの一覧の合計が offset より少ない', sumRead(f.after.map(read => ({ read }))) < sumRead(f.before.map(read => ({ read }))), f)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
