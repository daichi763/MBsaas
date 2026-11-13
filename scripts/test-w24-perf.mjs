// 性能・上限の仕上げ（作業単位 w24-perf: #9968）の統合テスト
//  (1) 役割への割り当て（POST /api/admin/shift-slots/roles/:id/assign）と応募の承認（POST /api/admin/recruit-applications/:id/decide）は、
//      人数・明細の数で D1 の呼び出しの回数が増えない（応答のヘッダー X-Test-D1-Calls。TEST_HOOKS のときだけ付く）。上限を超えると 400。
//      登録したシフトの単価・金額・支払先・画面で変えた単価は、今までと同じ（まとめて保存 assign-batch と同じ計算）
//  (2) 毎日 3:00 の cron: 所属区分の予約は問い合わせの予算の内だけ適用し、残りは pending のまま deferred で返す。
//      処理が途中で失敗しても、後ろの処理（お知らせの既読の削除・掲示板の知らせ）は動き、error_logs に残る。前月の請求の記録は先頭で動く
//  (3) マイグレーション 0104: 重複した索引が消え、足した索引がある。一意の制約（勤怠の報告・既読率の年度）は効いたまま
//  (4) 古い記録の削除: 予定確認URLのトークン（期限・取り消しから30日）・retention_logs と hq_view_logs（1年）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --test-scheduled --var RETENTION_ENABLED:true --var TEST_HOOKS:true --port 9025 --persist-to <保存先>` で起動していること
//   （ローカルの D1 に直接書き込み、表の名前を一時的に変える。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9025 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w24-perf.mjs
//   本番には接続しない
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:9025'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 700) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w24pf-'))
let sqlSeq = 0
async function sqlAll(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); break } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '')
      if (i >= 3 || !/internal error|SQLITE_BUSY|database is locked|bad_alloc|write EOF/i.test(msg)) { const err = new Error(msg.slice(0, 600)); err.output = msg; throw err }
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  await waitServer()
  return JSON.parse(out.slice(out.indexOf('[')))
}
const sql = async (command) => (await sqlAll(command)).at(-1).results
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
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
    let data = null; try { data = await r.json() } catch { }
    // X-Test-D1-Calls: 「呼び出しの回数/文の数」
    const [calls, statements] = String(r.headers.get('x-test-d1-calls') || '').split('/').map(Number)
    return { status: r.status, data, calls: Number.isFinite(calls) ? calls : null, statements: Number.isFinite(statements) ? statements : null }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`); return r.data }
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const jstHour = Number(jstNow().slice(11, 13))
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i))

const PFX = 'PF' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = Math.floor(Math.random() * 1e6)
const newPhone = () => '080' + String(10000000 + (phoneSeq++ % 89999999)).padStart(8, '0')
const admin = client(await login('sample', 'admin'))
const ME = must(await admin.get('/api/auth/me'), 'me')
const CID = Number(ME.user?.company_id ?? ME.company_id)
const newStaff = async (n) => must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ${n}`, phone: newPhone(), affiliation_type: 'daily_worker', force: true }), 'staff-quick').staff_id
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name, unit_price_type: 'daily', unit_price: 15000 }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
const P = await newProject(`${PFX}-案件`)
// 1日ずつの枠（役割は1つ・定員は多め）を作って、役割の ID を返す
async function newRoles(dates, role = { role_name: '販売', headcount: 50 }) {
  const r = must(await admin.post('/api/admin/shift-slots', { project_id: P, dates, start_time: '10:00', end_time: '19:00', break_minutes: 60, location: `${PFX}会場`, roles: [role] }), 'slots')
  const ids = []
  for (const sid of r.slot_ids) ids.push(must(await admin.get('/api/admin/shift-slots/' + sid), 'slot').roles[0].slot_role_id)
  return ids
}
const PRICE_COLS = ['bill_unit_type', 'bill_rate', 'bill_qty', 'unit_price', 'pay_unit_type', 'pay_rate', 'pay_qty', 'pay_amount', 'payee_type', 'price_locked', 'transportation_fee', 'bill_adjust', 'pay_adjust']
const shiftRows = (where) => sql(`SELECT shift_id, staff_id, slot_role_id, status, memo, registered_by, ${PRICE_COLS.join(', ')}, price_source FROM shifts WHERE company_id = ${CID} AND ${where} ORDER BY shift_id`)

// =========================================================
// (1) 役割への割り当て
// =========================================================
const staff = []
for (let i = 0; i < 12; i++) staff.push(await newStaff(i))
{
  const [rA, rB, rC, rD] = await newRoles(range(addDays(today, 20), 4))
  const two = await admin.post(`/api/admin/shift-slots/roles/${rA}/assign`, { staff_ids: staff.slice(0, 2), force: true })
  const ten = await admin.post(`/api/admin/shift-slots/roles/${rB}/assign`, { staff_ids: staff.slice(2, 12), force: true })
  ok('割り当て: 2人・10人とも登録できる', two.status === 200 && two.data.shift_ids.length === 2 && ten.status === 200 && ten.data.shift_ids.length === 10, { two: two.data, ten: ten.data })
  ok('割り当て: X-Test-D1-Calls が付く（TEST_HOOKS）', two.calls > 0 && ten.calls > 0, { two: two.calls, ten: ten.calls })
  ok('割り当て: D1 の呼び出しの回数が人数で増えない（2人と10人で同じ）', two.calls === ten.calls, { two: `${two.calls}/${two.statements}`, ten: `${ten.calls}/${ten.statements}` })
  console.log(`      割り当ての D1: 2人 ${two.calls}回/${two.statements}文、10人 ${ten.calls}回/${ten.statements}文`)

  // 単価・金額・支払先は、まとめて保存（assign-batch）と同じ
  const batch = must(await admin.post('/api/admin/shift-slots/assign-batch', { items: staff.slice(0, 3).map(s => ({ slot_role_id: rC, staff_id: s, force: true })) }), 'assign-batch')
  ok('割り当て: 比べる assign-batch の登録', batch.created.length === 3, batch)
  const viaRole = await shiftRows(`slot_role_id = ${rA}`), viaBatch = await shiftRows(`slot_role_id = ${rC}`)
  const pick = (r) => Object.fromEntries(PRICE_COLS.map(k => [k, r[k]]))
  const same = viaRole.length === 2 && viaRole.every(r => JSON.stringify(pick(r)) === JSON.stringify(pick(viaBatch.find(x => x.staff_id === r.staff_id) || {})))
  ok('割り当て: 単価・数量・金額・支払先・交通費・調整が assign-batch と同じ', same, { viaRole: viaRole.map(pick), viaBatch: viaBatch.map(pick) })
  ok('割り当て: 請求の金額が入っている（日額 15,000円）', viaRole.every(r => r.unit_price === 15000 && r.payee_type === 'payroll_daily' && r.price_locked === 0), viaRole.map(pick))

  // 画面で変えた単価（price）とメモ
  const ov = must(await admin.post(`/api/admin/shift-slots/roles/${rD}/assign`, { staff_ids: staff.slice(0, 3), force: true, memo: `${PFX}メモ`, price: { bill_rate: 18000, bill_unit_type: 'daily' } }), 'assign override')
  const ovRows = await shiftRows(`slot_role_id = ${rD}`)
  ok('割り当て: 画面で変えた単価は手動変更（price_locked）として入り、金額も計算し直す', ovRows.length === 3 && ovRows.every(r => r.bill_rate === 18000 && r.unit_price === 18000 && r.price_locked === 1 && JSON.parse(r.price_source).manual), ovRows.map(pick))
  ok('割り当て: メモ・登録者・状態が入る', ovRows.every(r => r.memo === `${PFX}メモ` && r.status === 'confirmed' && r.registered_by), ovRows.map(r => [r.memo, r.status, r.registered_by]))
  ok('割り当て: 応答の shift_ids が登録したシフト', JSON.stringify(ov.shift_ids.slice().sort()) === JSON.stringify(ovRows.map(r => r.shift_id).sort()), { ov, ovRows: ovRows.map(r => r.shift_id) })

  // すでに割り当て済みの人は飛ばす（確認の 409 → force で残りを登録）
  const again = await admin.post(`/api/admin/shift-slots/roles/${rA}/assign`, { staff_ids: staff.slice(0, 3) })
  ok('割り当て: 割当済みの人を含むと確認の 409（need_force）', again.status === 409 && again.data.need_force && again.data.warnings.some(w => /すでにこの枠に割り当て済み/.test(w)), again.data)
  const forced = must(await admin.post(`/api/admin/shift-slots/roles/${rA}/assign`, { staff_ids: staff.slice(0, 3), force: true }), 'assign force')
  ok('割り当て: force で割当済みでない人だけを登録する', forced.shift_ids.length === 1 && (await shiftRows(`slot_role_id = ${rA}`)).length === 3, forced)
  // 操作履歴（#159）
  const logs = await sql(`SELECT COUNT(*) AS n FROM operation_logs WHERE company_id = ${CID} AND entity = 'shift' AND action = 'assign' AND entity_id IN (${ten.data.shift_ids.join(',')})`)
  ok('割り当て: 操作履歴が人数分残る', logs[0].n === 10, logs)

  const many = await admin.post(`/api/admin/shift-slots/roles/${rA}/assign`, { staff_ids: Array.from({ length: 201 }, (_, i) => 900000 + i) })
  ok('割り当て: 201人は 400（一度に割り当てられるのは200人まで）', many.status === 400 && /200人まで/.test(many.data?.error || ''), many)
}

// =========================================================
// (1) 応募の承認
// =========================================================
async function newApplication(staffId, roleIds) {
  const name = `${PFX}-応募${roleIds[0]}`
  await sql(`INSERT INTO recruit_applications (company_id, name, phone, staff_id, status, created_at) VALUES (${CID}, ${q(name)}, ${q(newPhone())}, ${staffId}, 'pending', datetime('now'));
${roleIds.map(r => `INSERT INTO recruit_application_items (application_id, slot_role_id, status, staff_id) VALUES ((SELECT MAX(application_id) FROM recruit_applications WHERE name = ${q(name)}), ${r}, 'pending', ${staffId});`).join('\n')}`)
  const app = (await sql(`SELECT application_id FROM recruit_applications WHERE name = ${q(name)} ORDER BY application_id DESC LIMIT 1`))[0].application_id
  const items = await sql(`SELECT item_id, slot_role_id FROM recruit_application_items WHERE application_id = ${app} ORDER BY item_id`)
  return { app, items }
}
{
  const s3 = staff[3], s4 = staff[4]
  const roles3 = await newRoles(range(addDays(today, 40), 3)), roles9 = await newRoles(range(addDays(today, 50), 9))
  const a3 = await newApplication(s3, roles3), a9 = await newApplication(s4, roles9)
  const d3 = await admin.post(`/api/admin/recruit-applications/${a3.app}/decide`, { approve: a3.items.map(i => i.item_id), notify_applicant: false, force: true })
  const d9 = await admin.post(`/api/admin/recruit-applications/${a9.app}/decide`, { approve: a9.items.slice(0, 7).map(i => i.item_id), reject: a9.items.slice(7).map(i => i.item_id), notify_applicant: false, force: true })
  ok('承認: 3件の承認・9件（承認7・見送り2）とも処理できる', d3.status === 200 && d3.data.created_shifts === 3 && d9.status === 200 && d9.data.created_shifts === 7 && d9.data.rejected === 2, { d3: d3.data, d9: d9.data })
  ok('承認: D1 の呼び出しの回数が明細の数で増えない（3件と9件で同じ）', d3.calls > 0 && d3.calls === d9.calls, { d3: `${d3.calls}/${d3.statements}`, d9: `${d9.calls}/${d9.statements}` })
  console.log(`      承認の D1: 3件 ${d3.calls}回/${d3.statements}文、9件 ${d9.calls}回/${d9.statements}文`)
  const items = await sql(`SELECT i.item_id, i.status, i.shift_id, i.decided_at, s.slot_role_id AS s_role, s.staff_id AS s_staff, s.memo, s.status AS s_status, s.unit_price, s.pay_amount, s.payee_type, s.price_source
    FROM recruit_application_items i LEFT JOIN shifts s ON s.shift_id = i.shift_id WHERE i.application_id = ${a9.app} ORDER BY i.item_id`)
  const ap = items.slice(0, 7), rj = items.slice(7)
  ok('承認: 承認した明細は approved・自分の枠のシフトに結び付く', ap.every((i, k) => i.status === 'approved' && i.shift_id && i.s_role === a9.items[k].slot_role_id && i.s_staff === s4 && i.decided_at), ap)
  ok('承認: 作ったシフトは確定・「募集から承認」・単価と支払先が入る', ap.every(i => i.s_status === 'confirmed' && i.memo === '募集から承認' && i.unit_price === 15000 && i.payee_type === 'payroll_daily' && i.price_source), ap)
  ok('承認: 見送った明細は rejected', rj.every(i => i.status === 'rejected' && !i.shift_id && i.decided_at), rj)
  const app9 = (await sql(`SELECT status FROM recruit_applications WHERE application_id = ${a9.app}`))[0]
  ok('承認: すべて対応した応募は閉じる', app9.status !== 'pending', app9)
  // 承認と assign-batch の単価が同じ
  const [rX] = await newRoles([addDays(today, 70)])
  must(await admin.post('/api/admin/shift-slots/assign-batch', { items: [{ slot_role_id: rX, staff_id: s4, force: true, inherit: false }] }), 'batch for compare')
  const viaBatch = (await shiftRows(`slot_role_id = ${rX}`))[0], viaDecide = (await shiftRows(`shift_id = ${ap[0].shift_id}`))[0]
  const cols = ['bill_unit_type', 'bill_rate', 'bill_qty', 'unit_price', 'pay_unit_type', 'pay_rate', 'pay_qty', 'pay_amount', 'payee_type', 'price_locked']
  ok('承認: 単価・数量・金額・支払先が assign-batch と同じ', cols.every(k => viaBatch[k] === viaDecide[k]), { viaBatch, viaDecide })
  // 同じ明細をもう一度は 409（押さえられない）
  const twice = await admin.post(`/api/admin/recruit-applications/${a3.app}/decide`, { approve: [a3.items[0].item_id], notify_applicant: false, force: true })
  ok('承認: 対応済みの明細をもう一度承認すると 409', twice.status === 409, twice)
  // 処理中（ほかの操作が押さえている）の明細があると、押さえた分を戻して 409
  const roles2 = await newRoles(range(addDays(today, 80), 2))
  const a2 = await newApplication(staff[5], roles2)
  await sql(`UPDATE recruit_application_items SET status = 'processing', decided_at = '${jstNow().slice(0, 19).replace('T', ' ')}' WHERE item_id = ${a2.items[1].item_id}`)
  const busy = await admin.post(`/api/admin/recruit-applications/${a2.app}/decide`, { approve: [a2.items[0].item_id], reject: [a2.items[1].item_id], notify_applicant: false, force: true })
  const after2 = await sql(`SELECT item_id, status, decided_at FROM recruit_application_items WHERE application_id = ${a2.app} ORDER BY item_id`)
  ok('承認: 処理中の明細を含むと 409 で、もう一方は未対応に戻る', busy.status === 409 && after2[0].status === 'pending' && after2[0].decided_at == null && after2[1].status === 'processing', { busy: busy.data, after2 })
  const big = await admin.post(`/api/admin/recruit-applications/${a2.app}/decide`, { approve: Array.from({ length: 101 }, (_, i) => 800000 + i) })
  ok('承認: 101件は 400（一度に承認・見送りできるのは100件まで）', big.status === 400 && /100件まで/.test(big.data?.error || ''), big)
}

// =========================================================
// (3) マイグレーション 0104
// =========================================================
{
  const idx = await sql(`SELECT m.tbl_name AS t, il.name, il."unique" AS u, (SELECT group_concat(name, ',') FROM pragma_index_info(il.name)) AS cols
    FROM sqlite_master m JOIN pragma_index_list(m.name) il WHERE m.type = 'table' AND m.name IN ('attendance_reports', 'notice_read_reports', 'notice_read_staff_reports', 'shifts', 'daily_reports', 'notices', 'users',
      'staff_profiles', 'employee_records', 'staff_affiliations', 'staff_documents', 'employee_documents', 'client_documents', 'projects', 'recruit_application_items') ORDER BY 1, 2`)
  const has = (n) => idx.some(x => x.name === n)
  const dropped = ['uq_attendance_shift_type', 'idx_attendance_shift', 'idx_notice_read_reports_company_fy', 'idx_notice_read_staff_reports_company_fy', 'idx_shifts_company_date', 'idx_shifts_project',
    'idx_daily_reports_staff', 'idx_notices_company', 'idx_users_company', 'idx_staff_profiles_company', 'idx_employee_records_company', 'idx_staff_affiliations_company',
    'idx_staff_documents_company', 'idx_employee_documents_company', 'idx_client_documents_company']
  ok('0104: 重複した索引が消えている', dropped.every(n => !has(n)), dropped.filter(has))
  ok('0104: projects(client_id, company_id) と recruit_application_items の処理中の部分索引がある', idx.some(x => x.name === 'idx_projects_client' && x.cols === 'client_id,company_id') && has('idx_recruit_items_processing'), idx.filter(x => x.t === 'projects' || x.t === 'recruit_application_items'))
  const uq = (t, cols) => idx.some(x => x.t === t && x.u === 1 && x.cols === cols)
  ok('0104: 一意の制約（表の定義の UNIQUE）は残っている', uq('attendance_reports', 'shift_id,report_type') && uq('notice_read_reports', 'company_id,fiscal_year') && uq('users', 'company_id,user_code')
    && uq('employee_records', 'company_id,employee_number') && uq('staff_affiliations', 'company_id,affiliation_name') && uq('notice_read_staff_reports', 'company_id,fiscal_year,staff_id'), idx.filter(x => x.u === 1).map(x => `${x.t}(${x.cols})`))
  // 一意の制約が効く（同じシフト・同じ種類の報告は2件にならない）
  const sh = (await sql(`SELECT shift_id, staff_id FROM shifts WHERE company_id = ${CID} AND slot_role_id IS NOT NULL ORDER BY shift_id DESC LIMIT 1`))[0]
  await sql(`INSERT INTO attendance_reports (shift_id, staff_id, company_id, report_type, reported_at, status) VALUES (${sh.shift_id}, ${sh.staff_id}, ${CID}, 'wake_up', datetime('now'), 'normal')`)
  let dupErr = null
  try { await sql(`INSERT INTO attendance_reports (shift_id, staff_id, company_id, report_type, reported_at, status) VALUES (${sh.shift_id}, ${sh.staff_id}, ${CID}, 'wake_up', datetime('now'), 'normal')`) } catch (e) { dupErr = String(e.output || e.message) }
  ok('0104: 勤怠の報告の一意の制約が効く（同じシフト・同じ種類の2件目は UNIQUE で失敗）', dupErr && /UNIQUE/i.test(dupErr), dupErr)
  const upsert = await sql(`INSERT INTO attendance_reports (shift_id, staff_id, company_id, report_type, reported_at, status) VALUES (${sh.shift_id}, ${sh.staff_id}, ${CID}, 'wake_up', datetime('now'), 'late')
    ON CONFLICT(shift_id, report_type) DO UPDATE SET status = excluded.status; SELECT COUNT(*) AS n, MAX(status) AS st FROM attendance_reports WHERE shift_id = ${sh.shift_id} AND report_type = 'wake_up'`)
  ok('0104: ON CONFLICT(shift_id, report_type) は残った制約で働く', upsert[0].n === 1 && upsert[0].st === 'late', upsert)
  await sql(`DELETE FROM attendance_reports WHERE shift_id = ${sh.shift_id} AND report_type = 'wake_up'`)
  let dupNr = null
  try { await sql(`INSERT INTO notice_read_reports (company_id, fiscal_year) VALUES (${CID}, 1999); INSERT INTO notice_read_reports (company_id, fiscal_year) VALUES (${CID}, 1999);`) } catch (e) { dupNr = String(e.output || e.message) }
  ok('0104: 既読率の年度の一意の制約が効く', dupNr && /UNIQUE/i.test(dupNr), dupNr)
  await sql(`DELETE FROM notice_read_reports WHERE company_id = ${CID} AND fiscal_year = 1999`)
  const plan = await sql(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM projects p WHERE p.client_id = 1 AND p.status = 'active'`)
  ok('0104: クライアントごとの案件の数え上げが client_id の索引を使う', plan.some(r => /idx_projects_client/.test(r.detail)), plan)
}

// =========================================================
// (4) 古い記録の削除（毎日 3:00 の cron の token_purge・retention）
// (2) 所属区分の予約の予算・後ろの処理
// =========================================================
const daily = async () => { const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('0 18 * * *')}`); await r.text(); return r.status }
// 何もしなかった実行は直前の idle の行を上書きする（run_id は前のまま。#9976）ので、新しい行と、この時刻より後に始まった行を合わせて読む
const runsSince = async (m) => sql(`SELECT run_id, job, status, result_json, error_message FROM cron_runs WHERE run_id > ${m.id} OR started_at >= '${m.at}' ORDER BY run_id`)
const lastRun = async () => ({ id: (await sql('SELECT COALESCE(MAX(run_id), 0) AS n FROM cron_runs'))[0].n, at: new Date().toISOString() })
{
  const old = addDays(today, -40), recent = addDays(today, -5)
  const sid = staff[6]
  await sql(`INSERT INTO staff_schedule_tokens (token_hash, company_id, staff_id, expires_at, revoked_at, created_at) VALUES
    ('${PFX}-expired', ${CID}, ${sid}, '${old} 23:59:59', NULL, '${addDays(today, -60)} 10:00:00'),
    ('${PFX}-revoked', ${CID}, ${sid}, '${addDays(today, 30)} 23:59:59', '${old} 10:00:00', '${addDays(today, -50)} 10:00:00'),
    ('${PFX}-revoked-recent', ${CID}, ${sid}, '${addDays(today, 30)} 23:59:59', '${recent} 10:00:00', '${addDays(today, -10)} 10:00:00'),
    ('${PFX}-live', ${CID}, ${sid}, '${addDays(today, 10)} 23:59:59', NULL, '${today} 09:00:00');
  INSERT INTO retention_logs (target, dry_run, started_at, finished_at, created_at) VALUES ('${PFX}-old', 0, '2020-01-01T00:00:00Z', '2020-01-01T00:00:01Z', '${addDays(today, -400)} 00:00:00'),
    ('${PFX}-new', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '${addDays(today, -100)} 00:00:00');
  INSERT INTO hq_view_sessions (token_hash, hq_user_id, company_id, reason, started_at, expires_at) VALUES ('${PFX}-view', 1, ${CID}, 'test', '${addDays(today, -400)}T00:00:00Z', '${addDays(today, -400)}T01:00:00Z');
  INSERT INTO hq_view_logs (view_id, method, path, created_at) VALUES ((SELECT view_id FROM hq_view_sessions WHERE token_hash = '${PFX}-view'), 'GET', '/api/admin/${PFX}-old', '${addDays(today, -400)}T00:10:00Z'),
    ((SELECT view_id FROM hq_view_sessions WHERE token_hash = '${PFX}-view'), 'GET', '/api/admin/${PFX}-new', '${addDays(today, -30)}T00:10:00Z');`)

  // 所属区分の予約（日雇い → 個人事業主・今日から）を6人分。予算の内の分だけ適用し、残りは pending のまま
  const sched = staff.slice(6, 12)
  await sql(sched.map(s => `INSERT INTO staff_affiliation_schedules (company_id, staff_id, from_type, to_type, effective_date, to_affiliation, request_json, created_by) VALUES (${CID}, ${s}, 'daily_worker', 'freelance', '${today}', '個人事業主', '{}', 1);`).join('\n'))
  const before = await lastRun()
  ok('cron: 毎日 3:00 の起動', (await daily()) === 200)
  const runs = await runsSince(before)
  const job = (n) => runs.find(r => r.job === n)
  const order = runs.map(r => r.job)
  ok('cron: 前月の請求の記録（billing_close）が 3:00 の起動の先頭で動く', order[0] === 'billing_close', order)
  const aff = job('affiliation_schedules'), affRes = aff ? JSON.parse(aff.result_json || '{}') : {}
  console.log(`      所属区分の予約: ${aff?.result_json}`)
  ok('cron: 所属区分の予約は予算の内だけ適用し、残りは deferred（失敗にしない）', aff?.status === 'ok' && affRes.due >= 6 && affRes.applied >= 1 && affRes.deferred >= 1 && affRes.applied + affRes.deferred + (affRes.not_applied || 0) === affRes.due && affRes.statements <= 25, affRes)
  const st = await sql(`SELECT staff_id, status FROM staff_affiliation_schedules WHERE staff_id IN (${sched.join(',')}) ORDER BY schedule_id`)
  const prof = await sql(`SELECT staff_id, affiliation_type FROM staff_profiles WHERE staff_id IN (${sched.join(',')}) ORDER BY staff_id`)
  const appliedIds = st.filter(x => x.status === 'applied').map(x => x.staff_id)
  ok('cron: 適用した予約は applied・区分が変わる。回した予約は pending・区分はそのまま', appliedIds.length === affRes.applied && st.filter(x => x.status === 'pending').length >= affRes.deferred - (affRes.due - 6)
    && prof.every(p => (p.affiliation_type === 'freelance') === appliedIds.includes(p.staff_id)), { st, prof })
  ok('cron: 後ろの処理（お知らせの既読の削除・掲示板の知らせ）も動く', job('notice_reads_purge')?.status === 'ok' && job('board_saved_search')?.status === 'ok', order)

  // (4) 古い記録
  const tok = await sql(`SELECT token_hash FROM staff_schedule_tokens WHERE token_hash LIKE '${PFX}-%' ORDER BY token_hash`)
  ok('削除: 予定確認URLは期限・取り消しから30日たった行だけ消える', JSON.stringify(tok.map(t => t.token_hash)) === JSON.stringify([`${PFX}-live`, `${PFX}-revoked-recent`]), tok)
  const tp = job('token_purge')
  ok('削除: token_purge の記録に予定確認URLの件数が入る', tp?.status === 'ok' && JSON.parse(tp.result_json).deleted >= 2, tp)
  const tlog = await sql(`SELECT target, deleted_count FROM retention_logs WHERE target = 'expired_schedule_tokens' ORDER BY log_id DESC LIMIT 1`)
  ok('削除: retention_logs に expired_schedule_tokens が残る', tlog[0]?.deleted_count >= 2, tlog)
  const rl = await sql(`SELECT target FROM retention_logs WHERE target LIKE '${PFX}-%' ORDER BY target`)
  ok('削除: retention_logs は作成から1年たった行だけ消える', JSON.stringify(rl.map(r => r.target)) === JSON.stringify([`${PFX}-new`]), rl)
  const vl = await sql(`SELECT path FROM hq_view_logs WHERE path LIKE '%${PFX}-%' ORDER BY path`)
  ok('削除: hq_view_logs は作成から1年たった行だけ消える', JSON.stringify(vl.map(r => r.path)) === JSON.stringify([`/api/admin/${PFX}-new`]), vl)
  const ret = job('retention')
  ok('削除: データ保持の定期削除は成功', ret?.status === 'ok', ret)

  // 3:00 の残り（4:00 以降の15分おきの起動）
  if (jstHour < 4) skip('cron: 3:00 の残りを15分おきの起動で適用する', '日本時間の 0:00〜3:59 は動かない決まりのため')
  else {
    let pending = (await sql(`SELECT COUNT(*) AS n FROM staff_affiliation_schedules WHERE staff_id IN (${sched.join(',')}) AND status = 'pending'`))[0].n
    for (let i = 0; i < 8 && pending > 0; i++) {
      const b0 = await lastRun()
      const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`); await r.text()
      const rest = (await runsSince(b0)).find(x => x.job === 'affiliation_schedules_rest')
      if (i === 0) ok('cron: 15分おきの起動の affiliation_schedules_rest が残りを適用する', rest?.status === 'ok' && JSON.parse(rest.result_json).applied >= 1, rest)
      pending = (await sql(`SELECT COUNT(*) AS n FROM staff_affiliation_schedules WHERE staff_id IN (${sched.join(',')}) AND status = 'pending'`))[0].n
    }
    ok('cron: 何回かの15分おきの起動で、予約がすべて適用される', pending === 0, pending)
    const b1 = await lastRun()
    const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`); await r.text()
    const rest = (await runsSince(b1)).find(x => x.job === 'affiliation_schedules_rest')
    ok('cron: 予約がなければ idle（問い合わせ1回）', rest?.status === 'ok' && JSON.parse(rest.result_json).idle === true, rest)
  }

  // (2) 処理の途中の失敗: 予約の表の名前を一時的に変えて affiliation_schedules を失敗させる
  await sql('ALTER TABLE staff_affiliation_schedules RENAME TO staff_affiliation_schedules_w24')
  let runs2
  try {
    const b2 = await lastRun()
    await daily()
    runs2 = await runsSince(b2)
  } finally { await sql('ALTER TABLE staff_affiliation_schedules_w24 RENAME TO staff_affiliation_schedules') }
  const j2 = (n) => runs2.find(r => r.job === n)
  ok('cron: 途中の処理（affiliation_schedules）が失敗すると、その記録は failed', j2('affiliation_schedules')?.status === 'failed' && /no such table/i.test(j2('affiliation_schedules').error_message || ''), j2('affiliation_schedules'))
  ok('cron: 失敗の後ろの処理（notice_reads_purge・board_saved_search）は動いて ok', j2('notice_reads_purge')?.status === 'ok' && j2('board_saved_search')?.status === 'ok', runs2.map(r => [r.job, r.status]))
  const el = await sql(`SELECT COUNT(*) AS n FROM error_logs WHERE source = 'cron' AND path = 'affiliation_schedules'`)
  ok('cron: 失敗は error_logs にも残る', el[0].n >= 1, el)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
