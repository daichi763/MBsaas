// 管理画面の重い読み取りを軽くする（Sprint 33 #9996。作業単位 w33-perf）の統合テスト
//   11/20 の1日の流れの試験で、読み取りの多かった管理画面の問い合わせを、結果（返す値・並び・件数）を変えずに軽くした。
//   (1) スタッフ一覧（GET /api/admin/staff）: 今月の稼働日数・本日のシフト・今月の案件を、今月のシフトを1回だけ読んで出す。今月成約はスタッフごとに今月の日報だけを読む
//   (2) 日報の CSV（GET /api/admin/daily-reports-csv）: 日報の表だけを索引（0119）の順に 2,001 件まで読み、名前は後から引く。全件数は日報一覧と同じ控えで数える
//   (3) シフトボードなどの案件の選択肢（GET /api/admin/projects?counts=0）: 月の数を数えない。案件一覧の成約は案件ごとに足す（並べ替えで読み直さない）
//   (4) ダッシュボードの「遅刻が月2回以上」: 遅刻の報告の日時の部分索引（0119）で、今月の分だけを読む
//   ほかに、スタッフ一覧のたびの人物の ID の補完（roster.ts）は、補完の済んでいない行だけの部分索引（0119）で引く
//
//   確かめること: 過去のデータ（数か月分のシフト・打刻・日報）を入れたローカルの D1 で、
//     ・各 API の結果が、直す前の SQL（このファイルに写した文）の結果と同じ
//     ・D1 の読み取りの行数（応答のヘッダー X-Test-D1-Rows。TEST_HOOKS のときだけ付く）が、直す前の SQL の行数（DB の複製で測る）より少ない
//       （日報の CSV・シフトボードの案件は 1/5 以下、スタッフ一覧は 1/2 以下）。さらに古い過去のデータを足しても、ほとんど増えない
//     ・問い合わせの計画（EXPLAIN QUERY PLAN）が、足した索引を使い、ほかの文が CSV の索引を使わない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --var TEST_HOOKS:true --port 9020 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9020 PERSIST=<保存先> node scripts/test-w33-perf.mjs
//   PERSIST は必須（スタッフ・シフト・打刻・日報をローカルの D1 に直接書き込む。テスト用の DB 専用。wrangler d1 execute は --local のみ）。
//   直す前の SQL の読み取りの行数は、PERSIST の複製（一時フォルダ）を wrangler の getPlatformProxy で開いて測る。本番には接続しない。
//   テストのたびに DB を作り直すこと（npm test -- w33-perf なら自動で行う）。
//   画面の確認（スタッフ一覧・シフトボードが描けること）は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）
// run-tests: --var TEST_HOOKS:true
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9020'
const PERSIST = process.env.PERSIST || ''
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 700) : ''}`) }
const info = (name, v) => console.log(`INFO  ${name}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
if (!PERSIST) { console.log('FAIL  PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }

// ---------- 道具 ----------
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w33pf-'))
let sqlSeq = 0
// ローカルの D1 に SQL を流す（ファイルで渡す。シェルを通さない）。最後の文の結果を返す
function d1(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const r = JSON.parse(out.slice(out.indexOf('[')))
      return r[r.length - 1]?.results || []
    } catch (e) { if (i >= 3) throw e; execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']) }
  }
}
const q = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await rawFetch(`${BASE}/api/health`); if (r.status < 500) return } catch { }
    await sleep(500)
  }
}
async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (r.status !== 200 || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
let COOKIE = ''
// GET して、本文と D1 の読み取りの行数（X-Test-D1-Rows の「読み取り/書き込み」の前の数）を返す
async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: COOKIE } })
  const text = await r.text()
  let data = null; try { data = JSON.parse(text) } catch { }
  const rows = r.headers.get('x-test-d1-rows')
  return { status: r.status, text, data, headers: r.headers, read: rows ? Number(rows.split('/')[0]) : null }
}
// 同じ API を2回読み、2回目の行数を使う（1回目は控えの作り直し・人物の ID の補完などの書き込みを含むことがあるため）
async function measure(path) { await get(path); return get(path) }

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000)
const today = jstNow().toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const month = today.slice(0, 7)
const mFrom = month + '-01'
const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}` }
const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` }
const mTo = nextMonth(month) + '-01'
const pm = prevMonth(month), pmFrom = pm + '-01', pmLast = addDays(mFrom, -1)
const dayOfMonth = Number(today.slice(8, 10))
const CID = 1

// ---------- 準備: 過去のデータ（今日から 110 日前〜6日後。スタッフを 150 人足す） ----------
// シフトは1人1日1本（7日に1日は休み）、確定（53日に1日ほど欠勤）。過去の確定のシフトには入店・勤務開始の打刻（7本に1本は遅刻）と日報を付ける。
// 今日のシフトは半分だけ入店済み。日報は7日より前を確認済みにする。インシデント・クレームは少しだけ
function historySql(fromK, toK, memo) {
  const T = q(today)
  return `
INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, unit_price, memo, created_at)
  WITH RECURSIVE d(k) AS (SELECT ${fromK} UNION ALL SELECT k + 1 FROM d WHERE k < ${toK})
  SELECT ${CID}, sp.staff_id, 1 + ((sp.staff_id + k + 7000) % 5), date(${T}, k || ' days'), '10:00', '18:00',
    CASE WHEN (sp.staff_id * 7 + k + 7000) % 53 = 0 THEN 'absent' ELSE 'confirmed' END, 12000, ${q(memo)}, '2026-01-01 09:00:00'
  FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id, d
  WHERE sp.company_id = ${CID} AND us.role = 'staff' AND sp.merged_into_staff_id IS NULL AND COALESCE(sp.affiliation_type, 'own_employee') != 'skillsheet_only'
    AND (sp.staff_id + k + 7000) % 7 != 0
    AND NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = sp.staff_id AND x.work_date = date(${T}, k || ' days'));
INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, entry_method)
  SELECT s.company_id, s.staff_id, s.shift_id, t.rt, s.work_date || ' 10:' || CASE WHEN s.shift_id % 7 = 0 THEN '20' ELSE '00' END || ':00',
    CASE WHEN s.shift_id % 7 = 0 THEN 'late' ELSE 'normal' END, 'app'
  FROM shifts s, (SELECT 'check_in' AS rt UNION ALL SELECT 'work_start') t
  WHERE s.memo = ${q(memo)} AND s.status = 'confirmed' AND (s.work_date < ${T} OR (s.work_date = ${T} AND s.shift_id % 2 = 0));
INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, manager_checked, submitted_at, entry_method)
  SELECT s.company_id, s.staff_id, s.project_id, s.shift_id, s.work_date,
    json_object('mnp', s.shift_id % 3, 'pi', s.shift_id % 2, 'shinki', 1, 'hikari', 0, 'seiyaku', s.shift_id % 4, 'shodan', 2, 'koekake', 20, 'free', ${q(memo)}),
    CASE WHEN s.shift_id % 41 = 0 THEN 1 ELSE 0 END, CASE WHEN s.shift_id % 97 = 0 THEN 1 ELSE 0 END,
    CASE WHEN s.work_date < date(${T}, '-7 days') THEN 1 ELSE 0 END,
    s.work_date || CASE WHEN s.shift_id % 3 = 0 THEN ' 18:30:00' ELSE ' 18:45:00' END, 'app'
  FROM shifts s WHERE s.memo = ${q(memo)} AND s.status = 'confirmed' AND s.work_date < ${T};`
}
d1(`INSERT INTO users (company_id, user_code, name, role, password_hash, status, created_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
  SELECT ${CID}, printf('w33p%03d', i), printf('W33性能 %03d', i), 'staff', (SELECT password_hash FROM users WHERE company_id = ${CID} AND user_code = 'st001'), 'active', '2026-01-01 09:00:00' FROM n;
INSERT INTO staff_profiles (user_id, company_id, affiliation_type, employment_status, owner_company_id, created_at)
  SELECT user_id, ${CID}, 'own_employee', 'working', ${CID}, '2026-01-01 09:00:00' FROM users WHERE company_id = ${CID} AND user_code LIKE 'w33p%';
${historySql(-110, 6, 'W33P')}
-- 今月のシフト・日報の無いスタッフ（今月成約が null になる人）
INSERT INTO users (company_id, user_code, name, role, password_hash, status, created_at)
  SELECT ${CID}, 'w33pz01', 'W33性能 今月なし', 'staff', password_hash, 'active', '2026-01-01 09:00:00' FROM users WHERE company_id = ${CID} AND user_code = 'st001';
INSERT INTO staff_profiles (user_id, company_id, affiliation_type, employment_status, owner_company_id, created_at)
  SELECT user_id, ${CID}, 'own_employee', 'working', ${CID}, '2026-01-01 09:00:00' FROM users WHERE company_id = ${CID} AND user_code = 'w33pz01';`)
await waitServer()
const counts = d1(`SELECT (SELECT COUNT(*) FROM staff_profiles WHERE company_id = ${CID}) AS staff,
  (SELECT COUNT(*) FROM shifts WHERE company_id = ${CID} AND work_date >= ${q(mFrom)} AND work_date < ${q(mTo)}) AS month_shifts,
  (SELECT COUNT(*) FROM daily_reports WHERE company_id = ${CID} AND work_date >= ${q(pmFrom)} AND work_date <= ${q(pmLast)}) AS prev_reports,
  (SELECT COUNT(*) FROM shifts WHERE memo = 'W33P') AS shifts, (SELECT COUNT(*) FROM attendance_reports) AS att, (SELECT COUNT(*) FROM daily_reports) AS reports`)[0]
info('準備したデータ', counts)
ok('準備: スタッフ 150 人と、110 日分のシフト・打刻・日報（前月の日報は CSV の上限 2,000 件を超える）', counts.staff >= 160 && counts.shifts > 15000 && counts.prev_reports > 2001, counts)

COOKIE = await login('sample', 'admin')
// 人物の ID の補完（足したスタッフ）と、日報一覧の件数の控え（前月）を先に作っておく（画面を開いたときと同じ）
await get('/api/admin/staff')
await get(`/api/admin/daily-reports?from=${pmFrom}&to=${pmLast}&limit=1`)

// ---------- 直す前の SQL（src にあった文を写したもの。値は埋め込む） ----------
const DOC_LIMIT = addDays(today, 30)
const OLD = {
  staff: `SELECT sp.staff_id, sp.evaluation_score, sp.retention_risk, sp.follow_flag,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.skills ELSE sp.skills END AS skills,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.work_area ELSE sp.work_area END AS work_area,
           CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana,
           COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type, sp.affiliation, sp.employment_status, sp.is_provisional, sp.merged_into_staff_id, sp.board_proposal_id, us.phone,
           COALESCE(sp.availability_exempt, 0) AS availability_exempt,
           oc.company_name AS owner_company_name,
           CASE WHEN sp.affiliation_type = 'linked_external' OR pe.created_company_id != sp.company_id THEN sp.relink_code ELSE pe.global_staff_code END AS global_staff_code,
           us.user_id, us.user_code, us.name, us.status, us.role AS user_role, sp.link_ended_at,
           us.last_login_at,
           NULLIF(MAX(COALESCE(us.last_login_at, ''), COALESCE(us.last_seen_at, ''),
             CASE WHEN sp.affiliation_type = 'linked_external' THEN MAX(COALESCE(srcu.last_login_at, ''), COALESCE(srcu.last_seen_at, '')) ELSE '' END), '') AS app_last_used_at,
           CASE WHEN COALESCE(sp.affiliation_type,'own_employee') != 'skillsheet_only' AND sp.merged_into_staff_id IS NULL AND COALESCE(sp.employment_status,'working') != 'retired' AND us.status = 'active' AND sp.link_ended_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM staff_profiles emp_sp JOIN users emp_us ON emp_us.user_id = emp_sp.user_id
               WHERE sp.affiliation_type = 'linked_external' AND emp_sp.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
                 AND (COALESCE(emp_sp.employment_status,'working') = 'retired' OR emp_us.status != 'active')) THEN 1 ELSE 0 END AS assignable,
           (SELECT COUNT(DISTINCT s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date >= ${q(mFrom)} AND s.work_date < ${q(mTo)} AND s.status IN ('confirmed','substitute')) AS month_days,
           (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date <= ${q(today)} AND s.status IN ('confirmed','substitute')) AS last_work_date,
           (SELECT MAX(dr.work_date) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id) AS last_report_date,
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date = ${q(today)} AND s.status IN ('confirmed','substitute')) AS today_shift,
           COALESCE(tc.n, 0) AS today_checkin,
           (SELECT GROUP_CONCAT(DISTINCT p.project_name) FROM shifts s3 JOIN projects p ON s3.project_id = p.project_id WHERE s3.staff_id = sp.staff_id AND s3.work_date >= ${q(mFrom)} AND s3.work_date < ${q(mTo)}) AS projects,
           (SELECT COUNT(*) FROM staff_documents d WHERE d.staff_id = sp.staff_id AND +d.company_id = sp.company_id AND d.valid_until IS NOT NULL AND d.valid_until <= ${q(DOC_LIMIT)}) AS doc_expiring
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN (SELECT a.staff_id, COUNT(*) AS n FROM shifts s2 JOIN attendance_reports a ON a.shift_id = s2.shift_id
      WHERE s2.company_id = ${CID} AND s2.work_date = ${q(today)} AND s2.status IN ('confirmed','substitute') AND a.report_type IN ('check_in','work_start') GROUP BY a.staff_id) tc ON tc.staff_id = sp.staff_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    LEFT JOIN users srcu ON srcu.user_id = src.user_id
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ${CID} ORDER BY sp.staff_id`,
  seiProjects: `SELECT project_id, report_template_id FROM projects WHERE company_id = ${CID} AND report_template_id IS NOT NULL`,
  seiTemplates: `SELECT template_id, fields_json FROM report_templates WHERE template_id IN (SELECT report_template_id FROM projects WHERE company_id = ${CID})`,
  ensureRoster: `SELECT sp.staff_id, sp.user_id, sp.affiliation, sp.affiliation_type, co.company_name FROM staff_profiles sp JOIN companies co ON co.company_id = sp.company_id
    WHERE sp.company_id = ${CID} AND sp.person_id IS NULL LIMIT 500`,
  csv: (from, to, extra = '') => `SELECT dr.work_date, dr.submitted_at, dr.report_values, dr.incident_flag, dr.complaint_flag,
      dr.manager_checked, dr.manager_comment, dr.admin_edited_at, dr.staff_id, dr.project_id, p.project_name, p.report_template_id, p.past_report_fields_json, us.name AS staff_name,
      dr.daily_report_id
    FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id
    JOIN staff_profiles sp ON sp.staff_id = dr.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE dr.company_id = ${CID} AND dr.work_date >= ${q(from)} AND dr.work_date <= ${q(to)}${extra} ORDER BY dr.work_date DESC, dr.submitted_at DESC, dr.daily_report_id DESC LIMIT 2001`,
  csvCount: (from, to, extra = '') => `SELECT COUNT(*) AS n FROM daily_reports dr WHERE dr.company_id = ${CID} AND dr.work_date >= ${q(from)} AND dr.work_date <= ${q(to)}${extra}`,
  projects: `SELECT p.*, cl.client_name,
      COALESCE(ms.staff_count, 0) AS staff_count, COALESCE(ms.month_shifts, 0) AS month_shifts,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date >= ${q(mFrom)} AND dr.work_date < ${q(mTo)}) AS incidents,
      (SELECT mr.amount FROM monthly_bill_rules mr WHERE mr.company_id = p.company_id AND mr.project_id = p.project_id AND mr.staff_id IS NULL
        AND (mr.valid_from IS NULL OR mr.valid_from <= ${q(month)}) AND (mr.valid_to IS NULL OR mr.valid_to >= ${q(month)}) AND (mr.migrated_from IS NULL OR mr.migrated_from > ${q(month)}) ORDER BY COALESCE(mr.valid_from, '') DESC LIMIT 1) AS monthly_amount
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id AND cl.company_id = p.company_id
    LEFT JOIN (SELECT s.project_id, COUNT(DISTINCT s.staff_id) AS staff_count, COUNT(*) AS month_shifts FROM shifts s
      WHERE s.project_id IN (SELECT x.project_id FROM projects x WHERE x.company_id = ${CID}) AND s.work_date >= ${q(mFrom)} AND s.work_date < ${q(mTo)} AND s.status IN ('confirmed','substitute')
      GROUP BY s.project_id) ms ON ms.project_id = p.project_id
    WHERE p.company_id = ${CID} ORDER BY p.project_id`,
  late: `SELECT s.staff_id, us.name, COUNT(DISTINCT a.shift_id) AS n FROM attendance_reports a
    JOIN shifts s ON s.shift_id = a.shift_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE a.company_id = ${CID} AND a.report_type IN ('check_in', 'work_start') AND a.status = 'late' AND s.work_date >= ${q(mFrom)} AND s.work_date < ${q(mTo)} AND s.status IN ('confirmed','substitute')
    GROUP BY s.staff_id HAVING n >= 2`,
}
// 成約の項目のキー（src の seiyakuFieldKey と同じ: 数値の項目で、キーが seiyaku のもの、無ければ表示名に「成約」を含む最初のもの）
function seiyakuKeysOf(projects, templates) {
  const keyOf = new Map()
  for (const t of templates) {
    let f = []; try { const v = JSON.parse(t.fields_json || '[]'); if (Array.isArray(v)) f = v } catch { f = [] }
    const nums = f.filter(x => x && typeof x.key === 'string' && x.type === 'number')
    keyOf.set(Number(t.template_id), (nums.find(x => x.key === 'seiyaku') || nums.find(x => String(x.label || '').includes('成約')))?.key ?? null)
  }
  const keys = {}
  for (const p of projects) { const k = keyOf.get(Number(p.report_template_id)); if (k) keys[String(p.project_id)] = k }
  return keys
}
const RV = `CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END`
const seiPathMap = (keys) => JSON.stringify(Object.fromEntries(Object.entries(keys).map(([pid, k]) => [pid, `$."${k}"`])))
const OLD_SEI = {
  sums: (keys, g) => `SELECT ${g} AS g, SUM(CASE WHEN json_type(${RV}, m.value) IN ('integer','real') THEN json_extract(${RV}, m.value) ELSE 0 END) AS v
      FROM json_each(${q(seiPathMap(keys))}) m JOIN daily_reports dr ON dr.project_id = CAST(m.key AS INTEGER) AND dr.work_date >= ${q(mFrom)} AND dr.work_date < ${q(mTo)}
      GROUP BY ${g}`,
  worked: (keys) => `SELECT DISTINCT s.staff_id AS g FROM json_each(${q(JSON.stringify(keys))}) m
      JOIN shifts s ON s.project_id = CAST(m.key AS INTEGER) AND s.work_date >= ${q(mFrom)} AND s.work_date < ${q(mTo)} AND s.status IN ('confirmed','substitute')
      WHERE s.staff_id IS NOT NULL`,
}

// ---------- 直す前の SQL を、DB の複製で流す（結果と読み取りの行数） ----------
// 開発サーバーが使っている D1 のファイルを一時フォルダに写し、wrangler の getPlatformProxy で開く（開発サーバーの DB には書かない）
let proxy = null
async function openProxy() {
  const dir = mkdtempSync(join(tmpdir(), 'w33pf-db-'))
  cpSync(join(PERSIST, 'v3', 'd1'), join(dir, 'v3', 'd1'), { recursive: true })
  const require = createRequire(join(ROOT, 'package.json'))
  const { getPlatformProxy } = require('wrangler')
  const p = await getPlatformProxy({ configPath: join(ROOT, 'wrangler.jsonc'), persist: { path: join(dir, 'v3') } })
  return { env: p.env, dispose: async () => { await p.dispose(); try { rmSync(dir, { recursive: true, force: true }) } catch { } } }
}
async function oldRun(sql) {
  const r = await proxy.env.DB.prepare(sql).all()
  return { rows: r.results, read: Number(r.meta?.rows_read) || 0 }
}
// CSV を読む（先頭の BOM・見出しの前の注記を除き、見出しと行を返す）
function parseCsv(text) {
  const s = text.replace(/^﻿/, '')
  const rows = []; let row = [], cell = '', inQ = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else inQ = false } else cell += ch; continue }
    if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const at = rows.findIndex(r => r[0] === '稼働日')
  return { note: at > 0 ? rows[0][0] : null, header: rows[at], body: rows.slice(at + 1) }
}

// ---------- 新しいコードの結果と行数（1回目: 110 日分の過去データ） ----------
const PATHS = {
  staff: '/api/admin/staff',
  csvPrev: `/api/admin/daily-reports-csv?from=${pmFrom}&to=${pmLast}`,
  csvPrevProject: `/api/admin/daily-reports-csv?from=${pmFrom}&to=${pmLast}&project_id=2`,
  csvShort: `/api/admin/daily-reports-csv?from=${addDays(today, -3)}&to=${today}`,
  projectsLight: '/api/admin/projects?counts=0',
  projects: '/api/admin/projects',
  dashboard: '/api/admin/dashboard',
}
const A = {}
for (const [k, p] of Object.entries(PATHS)) {
  A[k] = await measure(p)
  ok(`API が 200 を返す（${k}）`, A[k].status === 200 && A[k].read != null, { status: A[k].status, read: A[k].read, text: A[k].text.slice(0, 200) })
}
info('新しいコードの読み取りの行数（110 日分）', Object.fromEntries(Object.entries(A).map(([k, v]) => [k, v.read])))

proxy = await openProxy()
try {
  // ---------- (1) スタッフ一覧 ----------
  {
    const old = await oldRun(OLD.staff)
    const keys = seiyakuKeysOf((await oldRun(OLD.seiProjects)).rows, (await oldRun(OLD.seiTemplates)).rows)
    ok('準備: 成約の項目のある案件がある（sample の案件のテンプレート）', Object.keys(keys).length > 0, keys)
    const sums = await oldRun(OLD_SEI.sums(keys, 'dr.staff_id')), worked = await oldRun(OLD_SEI.worked(keys))
    const sei = new Map()
    for (const r of worked.rows) sei.set(Number(r.g), 0)
    for (const r of sums.rows) if (r.g != null) sei.set(Number(r.g), Number(r.v) || 0)
    const got = A.staff.data.staff
    const VOLATILE = new Set(['last_login_at', 'app_last_used_at'])
    const strip = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.has(k) && k !== 'month_seiyaku')))
    ok('(1) スタッフ一覧: 人数と並び（スタッフの ID の順）が直す前と同じ', got.length === old.rows.length && got.every((r, i) => r.staff_id === old.rows[i].staff_id), { got: got.length, old: old.rows.length })
    const diff = got.filter((r, i) => strip(r) !== strip(old.rows[i] || {}))
    ok('(1) スタッフ一覧: すべての列（今月の稼働日数・本日のシフト・今月の案件・最終稼働・最終日報・本日の入店など）が直す前と同じ',
      diff.length === 0, diff.slice(0, 2).map(r => ({ got: r, old: old.rows.find(o => o.staff_id === r.staff_id) })))
    ok('(1) スタッフ一覧: 列の並びも同じ（今月成約は最後）', JSON.stringify(Object.keys(got[0])) === JSON.stringify([...Object.keys(old.rows[0]), 'month_seiyaku']), Object.keys(got[0]))
    const seiDiff = got.filter(r => (sei.has(Number(r.staff_id)) ? sei.get(Number(r.staff_id)) : null) !== r.month_seiyaku)
    ok('(1) スタッフ一覧: 今月成約（該当の案件が無い人は null）が直す前と同じ', seiDiff.length === 0 && got.some(r => r.month_seiyaku > 0) && got.some(r => r.month_seiyaku === null),
      seiDiff.slice(0, 3).map(r => ({ id: r.staff_id, got: r.month_seiyaku, old: sei.get(Number(r.staff_id)) })))
    ok('(1) スタッフ一覧: 今月の案件が2つ以上の人・今日のシフトがある人・本日入店済みの人がいる（確かめる値が空でない）',
      got.some(r => String(r.projects || '').includes(',')) && got.some(r => r.today_shift > 0) && got.some(r => r.today_checkin > 0) && got.some(r => r.month_days > 5))
    const ensure = await oldRun(OLD.ensureRoster)
    const oldRead = old.read + sums.read + worked.read + ensure.read + 18
    info('(1) スタッフ一覧の読み取りの行数', { before: oldRead, after: A.staff.read, ratio: +(A.staff.read / oldRead).toFixed(3) })
    if (dayOfMonth >= 5) ok('(1) スタッフ一覧: 読み取りの行数が直す前の 1/2 以下', A.staff.read * 2 <= oldRead, { before: oldRead, after: A.staff.read })
    else info('(1) スタッフ一覧の 1/2 の確認', `月の初め（${dayOfMonth}日）は今月のシフトが少なく、差が出にくいので確かめない`)
  }

  // ---------- (2) 日報の CSV ----------
  for (const [k, from, to, extra] of [['csvPrev', pmFrom, pmLast, ''], ['csvPrevProject', pmFrom, pmLast, ' AND dr.project_id = 2'], ['csvShort', addDays(today, -3), today, '']]) {
    const old = await oldRun(OLD.csv(from, to, extra))
    const cnt = await oldRun(OLD.csvCount(from, to, extra))
    const total = old.rows.length > 2000 ? Number(cnt.rows[0].n) : old.rows.length
    const expect = old.rows.slice(0, 2000).reverse()
    const csv = parseCsv(A[k].text)
    const r = A[k]
    ok(`(2) 日報の CSV（${k}）: 件数（X-Csv-Total）と打ち切りの印が直す前と同じ`, Number(r.headers.get('x-csv-total')) === total && r.headers.get('x-csv-truncated') === (total > 2000 ? '1' : '0'),
      { total: r.headers.get('x-csv-total'), truncated: r.headers.get('x-csv-truncated'), expect: total })
    const rowDiff = csv.body.findIndex((row, i) => {
      const e = expect[i]
      return !e || row[0] !== e.work_date || row[1] !== e.project_name || row[2] !== e.staff_name || row[3] !== String(e.staff_id) || row[4] !== (e.submitted_at || '')
    })
    ok(`(2) 日報の CSV（${k}）: 行の数・並び（稼働日・案件・スタッフ・提出日時）が直す前と同じ`, csv.body.length === expect.length && rowDiff === -1,
      { rows: csv.body.length, expect: expect.length, at: rowDiff, got: csv.body[rowDiff]?.slice(0, 5), want: expect[rowDiff] && [expect[rowDiff].work_date, expect[rowDiff].project_name, expect[rowDiff].staff_name, expect[rowDiff].staff_id, expect[rowDiff].submitted_at] })
    if (total > 2000) ok(`(2) 日報の CSV（${k}）: 見出しの前に、上限を超えた注記がある`, csv.note && csv.note.includes(`全${total.toLocaleString('ja-JP')}件のうち`), csv.note)
    // 項目の列（テンプレートの項目）も同じ: 成約の列の値を直す前の日報の値と比べる
    const si = csv.header.indexOf('成約数') >= 0 ? csv.header.indexOf('成約数') : csv.header.findIndex(h => h.includes('成約'))
    if (si >= 0) ok(`(2) 日報の CSV（${k}）: 項目の列（成約）の値が日報の値と同じ`, csv.body.every((row, i) => row[si] === String(JSON.parse(expect[i].report_values).seiyaku ?? '')), { col: csv.header[si] })
    if (k === 'csvPrev') {
      const oldRead = old.read + (old.rows.length > 2000 ? cnt.read : 0) + 20
      info('(2) 日報の CSV（前月）の読み取りの行数', { before: oldRead, after: r.read, ratio: +(r.read / oldRead).toFixed(3) })
      ok('(2) 日報の CSV（前月・上限を超える）: 読み取りの行数が直す前の 1/5 以下', r.read * 5 <= oldRead, { before: oldRead, after: r.read })
    }
  }

  // ---------- (3) 案件の一覧 ----------
  {
    const old = await oldRun(OLD.projects)
    const keys = seiyakuKeysOf((await oldRun(OLD.seiProjects)).rows, (await oldRun(OLD.seiTemplates)).rows)
    const sums = await oldRun(OLD_SEI.sums(keys, 'dr.project_id'))
    const sei = new Map(Object.keys(keys).map(pid => [Number(pid), 0]))
    for (const r of sums.rows) if (r.g != null) sei.set(Number(r.g), Number(r.v) || 0)
    const full = A.projects.data.projects, light = A.projectsLight.data.projects
    ok('(3) 案件一覧（数を数える）: 稼働人数・シフト数・インシデント・月額・成約が直す前と同じ',
      full.length === old.rows.length && full.every((p, i) => p.project_id === old.rows[i].project_id && p.staff_count === old.rows[i].staff_count && p.month_shifts === old.rows[i].month_shifts
        && p.incidents === old.rows[i].incidents && p.monthly_amount === old.rows[i].monthly_amount && p.month_seiyaku === (sei.has(p.project_id) ? sei.get(p.project_id) : null)),
      full.map(p => [p.project_id, p.month_seiyaku, sei.get(p.project_id)]))
    ok('(3) 案件一覧（数を数える）: 今月の成約・シフトのある案件がある', full.some(p => p.month_seiyaku > 0 && p.month_shifts > 0))
    const NUM = new Set(['staff_count', 'month_shifts', 'incidents', 'monthly_amount', 'month_seiyaku'])
    ok('(3) 案件の選択肢（counts=0）: 案件・並び・案件の列・クライアント名が、数を数える一覧と同じ（数の列だけが無い）',
      light.length === full.length && light.every((p, i) => {
        const f = full[i]
        return JSON.stringify(Object.keys(p)) === JSON.stringify(Object.keys(f).filter(k => !NUM.has(k))) && Object.keys(p).every(k => JSON.stringify(p[k]) === JSON.stringify(f[k]))
      }) && A.projectsLight.data.month === month, { light: light[0], full: full[0] })
    const oldRead = old.read + sums.read + 18
    info('(3) 案件の一覧の読み取りの行数', { before: oldRead, after_full: A.projects.read, after_counts0: A.projectsLight.read })
    ok('(3) 案件の選択肢（counts=0）: 読み取りの行数が直す前の 1/5 以下（シフト・日報を読まない）', A.projectsLight.read * 5 <= oldRead && A.projectsLight.read <= full.length * 3 + 20, { before: oldRead, after: A.projectsLight.read })
    ok('(3) 案件一覧（数を数える）: 読み取りの行数が直す前より少ない', A.projects.read < oldRead, { before: oldRead, after: A.projects.read })
  }

  // ---------- (4) ダッシュボードの遅刻 ----------
  {
    const old = await oldRun(OLD.late)
    const todos = [...(A.dashboard.data.todos || []), ...(A.dashboard.data.hidden_todos || [])].filter(t => String(t.key).startsWith('late:'))
    const want = old.rows.map(r => `${r.staff_id}:${r.n}:${r.name}`).sort()
    const gotL = todos.map(t => `${t.staff_id}:${t.mark}:${String(t.text).split('さんが')[0]}`).sort()
    ok('(4) ダッシュボード: 遅刻が月2回以上の人・回数・名前が直す前と同じ', JSON.stringify(gotL) === JSON.stringify(want) && want.length > 0, { got: gotL.slice(0, 5), want: want.slice(0, 5), n: [gotL.length, want.length] })
    info('(4) 直す前の遅刻の文の読み取りの行数', old.read)
  }
} finally { await proxy.dispose() }

// ---------- 古い過去のデータを足しても、読む行数がほとんど増えない（2回目: さらに 120 日前まで） ----------
d1(historySql(-230, -111, 'W33P2'))
await waitServer()
const added = d1(`SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM attendance_reports WHERE status = 'late') AS late FROM shifts WHERE memo = 'W33P2'`)[0]
ok('準備: 古い過去のデータ（120 日分）を足した', added.n > 15000, added)
for (const k of ['staff', 'csvPrev', 'projectsLight', 'projects', 'dashboard']) {
  const b = await measure(PATHS[k])
  const same = k === 'dashboard'
    ? JSON.stringify(b.data.todos.filter(t => String(t.key).startsWith('late:'))) === JSON.stringify(A[k].data.todos.filter(t => String(t.key).startsWith('late:')))
    : k === 'staff' ? b.data.staff.every((r, i) => r.month_days === A[k].data.staff[i].month_days && r.projects === A[k].data.staff[i].projects && r.month_seiyaku === A[k].data.staff[i].month_seiyaku)
      : k.startsWith('csv') ? parseCsv(b.text).body.length === parseCsv(A[k].text).body.length : b.data.projects.length === A[k].data.projects.length
  ok(`古い過去のデータを足しても、${k} の読み取りの行数はほとんど増えない（2% と 30 行まで）・今月の結果は同じ`, same && b.read <= A[k].read * 1.02 + 30, { before: A[k].read, after: b.read })
}

// ---------- 問い合わせの計画（EXPLAIN QUERY PLAN） ----------
{
  const plan = (sql) => d1(`EXPLAIN QUERY PLAN ${sql}`).map(r => r.detail)
  const csvPlan = plan(`SELECT dr.work_date, dr.submitted_at, dr.daily_report_id FROM daily_reports dr WHERE dr.company_id = ${CID} AND dr.work_date >= ${q(pmFrom)} AND dr.work_date <= ${q(pmLast)} AND dr.company_id > 0
    ORDER BY dr.work_date DESC, dr.submitted_at DESC, dr.daily_report_id DESC LIMIT 2001`)
  ok('計画: 日報の CSV は idx_daily_reports_csv_order を使い、並べ替えの一時的な表を作らない', csvPlan.some(d => d.includes('idx_daily_reports_csv_order')) && !csvPlan.some(d => /TEMP B-TREE/.test(d)), csvPlan)
  const others = {
    '日報のあるスタッフ（日報一覧の絞り込みの候補）': `SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id WHERE sp.company_id = ${CID} AND EXISTS (SELECT 1 FROM daily_reports d WHERE d.staff_id = sp.staff_id AND d.company_id = ${CID}) ORDER BY us.name, sp.staff_id`,
    '未確認の日報の数（ダッシュボード）': `SELECT dr.project_id, COUNT(*) AS n FROM daily_reports dr WHERE dr.company_id = ${CID} AND COALESCE(dr.manager_checked, 0) = 0 GROUP BY dr.project_id`,
    '日報一覧の件数（今月）': `SELECT COUNT(*) FROM daily_reports dr WHERE dr.company_id = ${CID} AND dr.work_date >= ${q(mFrom)}`,
    '日報一覧の行': `SELECT dr.daily_report_id FROM daily_reports dr WHERE dr.company_id = ${CID} AND dr.work_date >= ${q(pmFrom)} AND dr.work_date <= ${q(pmLast)} ORDER BY dr.work_date DESC, dr.submitted_at DESC, dr.daily_report_id DESC LIMIT 50`,
  }
  for (const [name, sql] of Object.entries(others)) {
    const p = plan(sql)
    ok(`計画: ほかの文は CSV の部分索引を使わない（${name}）`, !p.some(d => d.includes('idx_daily_reports_csv_order')), p)
  }
  const late = plan(`SELECT g.staff_id, us.name, g.n FROM (SELECT s.staff_id, COUNT(DISTINCT a.shift_id) AS n FROM attendance_reports a JOIN shifts s ON s.shift_id = a.shift_id
      WHERE a.company_id = ${CID} AND a.status = 'late' AND a.reported_at >= ${q(addDays(mFrom, -1))} AND +a.report_type IN ('check_in', 'work_start')
        AND s.work_date >= ${q(mFrom)} AND s.work_date < ${q(mTo)} AND s.status IN ('confirmed','substitute')
      GROUP BY s.staff_id HAVING n >= 2) g JOIN staff_profiles sp ON g.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id ORDER BY g.staff_id`)
  ok('計画: ダッシュボードの遅刻は idx_attendance_late_at（報告の日時の範囲）を使う', late.some(d => d.includes('idx_attendance_late_at') && d.includes('reported_at>')), late)
  const ens = plan(OLD.ensureRoster)
  ok('計画: 人物の ID の補完は idx_staff_profiles_no_person を使う（会社のすべてのスタッフを読まない）', ens.some(d => d.includes('idx_staff_profiles_no_person')), ens)
  const idx = d1(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_daily_reports_csv_order', 'idx_attendance_late_at', 'idx_staff_profiles_no_person') ORDER BY name`)
  ok('0119: 3つの索引がある（部分索引の条件つき）', idx.length === 3 && /WHERE company_id > 0/.test(idx.find(r => r.name === 'idx_daily_reports_csv_order')?.sql || '')
    && /WHERE status = 'late'/.test(idx.find(r => r.name === 'idx_attendance_late_at')?.sql || '') && /WHERE person_id IS NULL/.test(idx.find(r => r.name === 'idx_staff_profiles_no_person')?.sql || ''), idx)
}

// ---------- 画面の JS: 数を使わない画面は counts=0 で読む ----------
{
  const js = async (n) => (await fetch(`${BASE}/static/${n}`)).text()
  const sb = await js('shift-board.js')
  ok('シフトボードの選択肢は、案件を counts=0 で読む', sb.includes("axios.get('/api/admin/projects', { params: { counts: 0 } })"))
  for (const n of ['attendance-history.js', 'corrections.js', 'recruit.js', 'board.js']) {
    const t = await js(n)
    ok(`${n}: 案件の選択肢は counts=0 で読む（数の列を使わない）`, !t.includes("axios.get('/api/admin/projects')") && t.includes("axios.get('/api/admin/projects', { params: { counts: 0 } })")
      && !/staff_count|month_shifts|monthly_amount|month_seiyaku/.test(t))
  }
}

// ---------- 画面（ヘッドレスの Chrome）: スタッフ一覧・シフトボードが描ける ----------
// 同じ管理者にログインし直すので、最後に行う
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w33pf-ui-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1400,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
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
    const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250) } return false }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    await send('Network.clearBrowserCookies')
    const ck = await login('sample', 'admin')
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    const staff = A.staff.data.staff.find(s => String(s.projects || '').includes(',') && s.month_days > 0)
    // スタッフ一覧: 今月の案件・稼働日数がその人の行に出る（スタッフの名前で絞る）
    await send('Page.navigate', { url: `${BASE}/admin#staff` })
    const drawn = await until(`document.querySelectorAll('tr[data-action=openStaffDetail]').length > 100`)
    const row = await ev(`(() => { const tr = document.querySelector('tr[data-action=openStaffDetail][data-id="${staff.staff_id}"]'); return tr ? tr.innerText : '' })()`)
    ok('画面: スタッフ一覧に全員の行が出て、今月の案件・今月稼働の日数がその人の行に出る', drawn && row.includes(staff.projects.split(',')[0]) && row.includes(`${staff.month_days}日`), { drawn, row: String(row).slice(0, 300) })
    // シフトボード: 案件の選択肢（counts=0）で描ける
    await send('Page.navigate', { url: `${BASE}/admin#shifts` })
    const board = await until(`document.querySelectorAll('[data-board-project]').length > 0`)
    const opts = await ev(`[...document.querySelectorAll('[data-board-project]')].map(i => i.closest('label').textContent.trim())`)
    const pj = A.projectsLight.data.projects
    ok('画面: シフトボードが描け、案件の絞り込みに、すべての案件の名前が出る（counts=0 の一覧）', board && Array.isArray(opts) && opts.length === pj.length && pj.every(p => opts.some(o => o.includes(p.project_name))), { opts, n: pj.length })
    ok('画面: スクリプトのエラーがない', !errors.length, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await sleep(500)
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

try { rmSync(SQL_DIR, { recursive: true, force: true }) } catch { }
const fail = results.filter(r => !r.pass)
console.log(`\n${results.length - fail.length}/${results.length} passed`)
process.exit(fail.length ? 1 : 0)
