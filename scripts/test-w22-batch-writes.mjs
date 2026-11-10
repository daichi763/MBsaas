// スタッフの作成を1つの batch に・シフトを消すときに関係する行も消す（作業単位 w22-batch-writes: #9951 #9952）の統合テスト
//  - #9951 スタッフの作成（POST /api/admin/staff・POST /api/admin/roster・仮登録 POST /api/admin/staff-quick・掲示板の取り込み）を
//          1つの batch にした。途中で失敗しても persons・users・staff_profiles が孤立して残らず、エラーの文言が原因に合う。応答の形は変えない
//  - #9952 シフトを消す3か所（1件の削除・まとめて削除・今後のシフトを外す）と退職後の削除で、
//          settlement_issue_acks・affiliation_excluded_shifts（退職後の削除では shift_cancellations も）の行も消す
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --test-scheduled --var RETENTION_ENABLED:true --persist-to <保存先>` で起動していること
//   （途中で失敗させるために、ローカルの D1 に一時的なトリガーを作って消す。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8811 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w22-batch-writes.mjs
//   本番には接続しない
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:8811'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）。トリガーを含む SQL はファイルで渡す
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w22bw-'))
let sqlSeq = 0
async function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  // サーバーが同じ D1 を使っている間は、まれに internal error になるので、少し待って2回までやり直す
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); break } catch (e) {
      if (i >= 2 || !/internal error/.test(String(e.stdout || ''))) throw e
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  await waitServer()
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // sql() の後に待ち受け側が閉じた接続を使い回すと ECONNRESET になるため、通信の失敗は1回だけやり直す
    const r = await send().catch(() => send())
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = String(Date.now()).slice(-6)
const PFX = 'w22bw' + SUF
let phoneSeq = 0
const newPhone = () => '080' + String((Number(SUF) * 100 + phoneSeq++) % 100000000).padStart(8, '0')

const admin = client(await login('sample', 'admin'))
// どの users・staff_profiles にも使われていない persons（孤立した人物）の件数
const orphanPersons = async () => (await sql(`SELECT COUNT(*) AS n FROM persons p
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.person_id = p.person_id) AND NOT EXISTS (SELECT 1 FROM staff_profiles s WHERE s.person_id = p.person_id)`))[0].n
// staff_profiles のない users（ログインできる孤立したアカウントなど）の件数
const orphanUsers = async () => (await sql(`SELECT COUNT(*) AS n FROM users u WHERE u.role IN ('staff', 'roster_only')
  AND NOT EXISTS (SELECT 1 FROM staff_profiles s WHERE s.user_id = u.user_id)`))[0].n
const usersWithCode = async (code) => (await sql(`SELECT COUNT(*) AS n FROM users WHERE company_id = 1 AND user_code = '${code}'`))[0].n
const persons0 = await orphanPersons(), users0 = await orphanUsers()

// =========================================================
// #9951 POST /api/admin/staff（テスト・内部用のスタッフ登録）
// =========================================================
{
  const code = `${PFX}a`
  const r = await admin.post('/api/admin/staff', { user_code: code, name: `${PFX} 登録A`, password: 'pass1234', phone: newPhone(), skills: '接客', force: true })
  ok('#9951 /admin/staff: 登録できる（応答は { ok: true } のまま）', r.status === 200 && JSON.stringify(r.data) === '{"ok":true}', r)
  const row = (await sql(`SELECT u.user_id, u.person_id AS up, u.must_change_password, s.user_id AS su, s.person_id AS sp, s.affiliation_type, s.skills, p.global_staff_code
    FROM users u JOIN staff_profiles s ON s.user_id = u.user_id LEFT JOIN persons p ON p.person_id = u.person_id WHERE u.company_id = 1 AND u.user_code = '${code}'`))[0]
  ok('#9951 /admin/staff: users・staff_profiles・persons が同じ人物でつながる（user_id はスタッフ番号で引く）',
    row && row.up && row.up === row.sp && row.su === row.user_id && /^FS[0-9A-F]{10}$/.test(row.global_staff_code) && row.affiliation_type === 'own_employee' && row.skills === '接客' && row.must_change_password === 1, row)
  const login1 = await rawLogin('sample', code)
  ok('#9951 /admin/staff: 作ったスタッフでログインできる', login1.status === 200, login1.status)

  const dup = await admin.post('/api/admin/staff', { user_code: code, name: `${PFX} 重複`, password: 'pass1234', force: true })
  ok('#9951 /admin/staff: スタッフ番号の重複は 409「スタッフ番号が重複しています」と空いている番号', dup.status === 409 && dup.data?.error === 'スタッフ番号が重複しています' && !!dup.data?.suggested_code, dup)

  // staff_profiles の INSERT で失敗させる（作った persons・users が残らないこと）
  await sql(`CREATE TRIGGER w22bw_fail_sp BEFORE INSERT ON staff_profiles WHEN NEW.skills = 'W22FAIL' BEGIN SELECT RAISE(ABORT, 'w22bw test failure'); END;`)
  const fcode = `${PFX}f`
  const bad = await admin.post('/api/admin/staff', { user_code: fcode, name: `${PFX} 失敗`, password: 'pass1234', skills: 'W22FAIL', force: true })
  ok('#9951 /admin/staff: 重複以外の失敗は 500「登録に失敗しました」（重複とは言わない）', bad.status === 500 && /^登録に失敗しました/.test(bad.data?.error || '') && !bad.data?.suggested_code, bad)
  ok('#9951 /admin/staff: 途中で失敗しても users が残らない', await usersWithCode(fcode) === 0)
  const again = await admin.post('/api/admin/staff', { user_code: fcode, name: `${PFX} 失敗後`, password: 'pass1234', force: true })
  ok('#9951 /admin/staff: 失敗した番号でそのまま登録し直せる', again.status === 200, again)
}

// =========================================================
// #9951 POST /api/admin/roster（スタッフマスタの新規登録）
// =========================================================
{
  const code = `${PFX}r`
  const emp = 'E' + SUF
  const r = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 名簿A`, gender: 'female', user_code: code, password: 'pass1234', phone: newPhone(), employee_number: emp, hire_date: '2026-04-01', force: true })
  ok('#9951 roster: ②従業員管理から登録でき、staff_id・global_staff_code を返す', r.status === 200 && r.data.ok && Number.isInteger(r.data.staff_id) && /^FS[0-9A-F]{10}$/.test(r.data.global_staff_code || ''), r)
  const row = (await sql(`SELECT s.staff_id, s.person_id, u.user_code, u.person_id AS up, p.global_staff_code, e.staff_id AS es, e.employee_number, e.hire_date
    FROM staff_profiles s JOIN users u ON u.user_id = s.user_id LEFT JOIN persons p ON p.person_id = s.person_id LEFT JOIN employee_records e ON e.staff_id = s.staff_id
    WHERE s.staff_id = ${Number(r.data?.staff_id) || 0}`))[0]
  ok('#9951 roster: 返した staff_id の行が users・persons・従業員管理とつながる', row && row.user_code === code && row.up === row.person_id && row.global_staff_code === r.data.global_staff_code
    && row.es === row.staff_id && row.employee_number === emp && row.hire_date === '2026-04-01', row)

  const pt = await admin.post('/api/admin/roster', { route: 'skillsheet', name: `${PFX} 名簿SS`, gender: 'male', force: true })
  const ptRow = pt.status === 200 ? (await sql(`SELECT u.user_code, u.role FROM staff_profiles s JOIN users u ON u.user_id = s.user_id WHERE s.staff_id = ${pt.data.staff_id}`))[0] : null
  ok('#9951 roster: ④スキルシートのみ（ログインなし）は SS- と人物のコードの番号で作る', pt.status === 200 && ptRow && ptRow.user_code === 'SS-' + pt.data.global_staff_code && ptRow.role === 'roster_only', { pt, ptRow })

  const dup = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 名簿重複`, gender: 'female', user_code: code, password: 'pass1234', force: true })
  ok('#9951 roster: スタッフ番号の重複は 409「スタッフ番号が重複しています」と空いている番号', dup.status === 409 && dup.data?.error === 'スタッフ番号が重複しています' && !!dup.data?.suggested_code, dup)
  const dupEmp = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 社員番号重複`, gender: 'female', user_code: `${PFX}r2`, password: 'pass1234', employee_number: emp, force: true })
  ok('#9951 roster: 社員番号の重複（登録前の確認）は 409', dupEmp.status === 409 && dupEmp.data?.error === 'この社員番号は既に使用されています', dupEmp)

  // 確認の後に別の登録で同じ社員番号が使われた（employee_records の UNIQUE で失敗）ときを、トリガーで同じエラーにして試す
  await sql(`CREATE TRIGGER w22bw_fail_er BEFORE INSERT ON employee_records WHEN NEW.employee_number = 'W22RACE'
    BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: employee_records.company_id, employee_records.employee_number'); END;`)
  const race = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 社員番号競合`, gender: 'female', user_code: `${PFX}r3`, password: 'pass1234', employee_number: 'W22RACE', force: true })
  ok('#9951 roster: 確認の後に社員番号が使われたときは 409「この社員番号は既に使用されています」（500 にしない）', race.status === 409 && race.data?.error === 'この社員番号は既に使用されています', race)
  ok('#9951 roster: 従業員管理の行で失敗しても users・staff_profiles が残らない', await usersWithCode(`${PFX}r3`) === 0)

  const bad = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 名簿失敗`, gender: 'female', user_code: `${PFX}r4`, password: 'pass1234', skills: 'W22FAIL', force: true })
  ok('#9951 roster: 重複以外の失敗は 500「登録に失敗しました」', bad.status === 500 && /^登録に失敗しました/.test(bad.data?.error || ''), bad)
  ok('#9951 roster: staff_profiles で失敗しても users が残らない', await usersWithCode(`${PFX}r4`) === 0)
  await sql('DROP TRIGGER IF EXISTS w22bw_fail_er;')
}

// =========================================================
// #9951 仮登録（POST /api/admin/staff-quick。募集の承認と同じ insertProvisionalStaff）
// =========================================================
{
  const phone = newPhone()
  const r = await admin.post('/api/admin/staff-quick', { name: `${PFX} 仮A`, phone, affiliation_type: 'daily_worker', force: true })
  ok('#9951 仮登録: 登録でき、staff_id・global_staff_code を返す', r.status === 200 && Number.isInteger(r.data?.staff_id) && /^FS/.test(r.data?.global_staff_code || ''), r)
  const row = (await sql(`SELECT u.user_code, u.role, s.is_provisional, s.person_id, u.person_id AS up,
      (SELECT COUNT(*) FROM staff_affiliation_history h WHERE h.staff_id = s.staff_id AND h.from_type = 'new' AND h.note = '仮登録') AS hist
    FROM staff_profiles s JOIN users u ON u.user_id = s.user_id WHERE s.staff_id = ${Number(r.data?.staff_id) || 0}`))[0]
  ok('#9951 仮登録: TMP- の番号・仮登録の印・所属区分の履歴が同じ batch で入る', row && row.user_code === 'TMP-' + r.data.global_staff_code && row.role === 'roster_only' && row.is_provisional === 1 && row.up === row.person_id && row.hist === 1, row)

  await sql(`CREATE TRIGGER w22bw_fail_hist BEFORE INSERT ON staff_affiliation_history WHEN NEW.note = '仮登録' AND NEW.to_type = 'freelance'
    BEGIN SELECT RAISE(ABORT, 'w22bw test failure'); END;`)
  const name = `${PFX} 仮失敗`
  const bad = await admin.post('/api/admin/staff-quick', { name, phone: newPhone(), affiliation_type: 'freelance', force: true })
  ok('#9951 仮登録: 所属区分の履歴で失敗すると 500（参照番号付きの「処理に失敗しました」）', bad.status === 500 && /処理に失敗しました/.test(bad.data?.error || ''), bad)
  const left = (await sql(`SELECT COUNT(*) AS n FROM users WHERE company_id = 1 AND name = '${name}'`))[0].n
  ok('#9951 仮登録: 途中で失敗しても users・staff_profiles が残らない', left === 0, left)
  await sql('DROP TRIGGER IF EXISTS w22bw_fail_hist;')
}

// =========================================================
// #9951 掲示板の提案の取り込み（POST /api/admin/board/proposals/:id/import）
// =========================================================
{
  const hq = client((await rawLogin('', 'hq')).cookie)
  const coCode = `w22bw${SUF}`
  const created = must(await hq.post('/api/hq/companies', { company_code: coCode, company_name: `W22BW 提案社${SUF}`, admin_code: 'boss', admin_name: '提案 太郎', admin_email: `w22bw${SUF}@example.com` }), 'company')
  const tmpB = client(await login(coCode, 'boss', created.admin_temp_password))
  must(await tmpB.post('/api/auth/change-password', { current_password: created.admin_temp_password, new_password: 'boss-pass-1' }), 'change password')
  const B = client(await login(coCode, 'boss', 'boss-pass-1'))
  const staffB = must(await B.post('/api/admin/staff-quick', { name: `提案 花子${SUF}`, phone: newPhone(), affiliation_type: 'own_employee', force: true }), 'staff-quick B').staff_id
  const post = must(await admin.post('/api/admin/board/posts', { status: 'open', engagement_type: 'spot', title: `W22BW 掲載${SUF}`, prefecture: '東京都', date_from: addDays(today, 20),
    time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 2 }), 'post').post_id
  const th = must(await B.post(`/api/admin/board/posts/${post}/threads`, { body: '人材を紹介できます' }), 'thread').thread_id
  const prop = must(await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: staffB, consent_method: 'written', consent_obtained_on: today }), 'proposal').proposal_id
  must(await admin.post(`/api/admin/board/proposals/${prop}/status`, { status: 'adopted' }), 'adopt')

  await sql(`CREATE TRIGGER w22bw_fail_bd BEFORE INSERT ON staff_profiles WHEN NEW.board_proposal_id = ${prop} BEGIN SELECT RAISE(ABORT, 'w22bw test failure'); END;`)
  const bad = await admin.post(`/api/admin/board/proposals/${prop}/import`, {})
  ok('#9951 取り込み: 途中で失敗すると 500「取り込みに失敗しました」', bad.status === 500 && /^取り込みに失敗しました/.test(bad.data?.error || ''), bad)
  const left = (await sql(`SELECT (SELECT COUNT(*) FROM users WHERE company_id = 1 AND user_code LIKE 'BD-%' AND NOT EXISTS (SELECT 1 FROM staff_profiles s WHERE s.user_id = users.user_id)) AS u,
      (SELECT imported_staff_id FROM board_proposals WHERE proposal_id = ${prop}) AS imp`))[0]
  ok('#9951 取り込み: 失敗しても BD- の users が残らず、提案は取り込み前のまま', left.u === 0 && left.imp === null, left)
  await sql('DROP TRIGGER IF EXISTS w22bw_fail_bd;')

  const imp = await admin.post(`/api/admin/board/proposals/${prop}/import`, {})
  ok('#9951 取り込み: 取り込める（応答は ok・staff_id・shift・provisional のまま）', imp.status === 200 && imp.data.ok && Number.isInteger(imp.data.staff_id) && 'shift' in imp.data && imp.data.provisional === false, imp)
  const row = (await sql(`SELECT s.board_proposal_id, s.affiliation_type, u.user_code, u.person_id AS up, s.person_id, p.global_staff_code,
      (SELECT imported_staff_id FROM board_proposals WHERE proposal_id = ${prop}) AS imp
    FROM staff_profiles s JOIN users u ON u.user_id = s.user_id LEFT JOIN persons p ON p.person_id = s.person_id WHERE s.staff_id = ${Number(imp.data?.staff_id) || 0}`))[0]
  ok('#9951 取り込み: 提案の取り込み先（imported_staff_id）が作った行になり、users・persons とつながる', row && row.imp === imp.data.staff_id && row.board_proposal_id === prop
    && row.affiliation_type === 'partner_manual' && row.user_code === 'BD-' + row.global_staff_code && row.up === row.person_id, row)
  const twice = await admin.post(`/api/admin/board/proposals/${prop}/import`, {})
  ok('#9951 取り込み: 二度目は 409「すでに取り込み済み」', twice.status === 409 && /取り込み済み/.test(twice.data?.error || ''), twice)
}
await sql('DROP TRIGGER IF EXISTS w22bw_fail_sp;')
ok('#9951 ここまでの登録・失敗で、孤立した persons が増えていない', await orphanPersons() === persons0, { before: persons0, after: await orphanPersons() })
ok('#9951 ここまでの登録・失敗で、staff_profiles のない users が増えていない', await orphanUsers() === users0, { before: users0, after: await orphanUsers() })

// =========================================================
// #9952 シフトを消すときに関係する行も消す
// =========================================================
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: newPhone(), force: true }), 'staff ' + k)
  return (await sql(`SELECT s.staff_id FROM staff_profiles s JOIN users u ON u.user_id = s.user_id WHERE u.company_id = 1 AND u.user_code = '${PFX}${k}'`))[0].staff_id
}
async function newShift(staffId, date) {
  return must(await admin.post('/api/admin/shifts', { staff_id: staffId, project_id: pid, work_date: date, start_time: '10:00', end_time: '18:00', status: 'confirmed', notify: false, force: true }), 'shift').shift_id
}
// シフトに精算の確認済みの印・区分変更で対象外にした記録・キャンセルの記録を付ける
let hist = 990000
const attach = (ids) => sql(ids.map(id => `INSERT INTO settlement_issue_acks (company_id, shift_id, issue, acked_by, acked_at) VALUES (1, ${id}, 'w22bw', 1, '${today} 10:00:00');
  INSERT INTO affiliation_excluded_shifts (history_id, company_id, staff_id, shift_id, to_payee_type) SELECT ${++hist}, 1, staff_id, ${id}, 'payroll' FROM shifts WHERE shift_id = ${id};
  INSERT INTO shift_cancellations (shift_id, company_id, reason, updated_at) VALUES (${id}, 1, 'client', '${today} 10:00:00');`).join('\n'))
const related = async (ids) => (await sql(`SELECT
    (SELECT COUNT(*) FROM settlement_issue_acks WHERE shift_id IN (${ids.join(',')})) AS acks,
    (SELECT COUNT(*) FROM affiliation_excluded_shifts WHERE shift_id IN (${ids.join(',')})) AS excl,
    (SELECT COUNT(*) FROM shift_cancellations WHERE shift_id IN (${ids.join(',')})) AS canc,
    (SELECT COUNT(*) FROM shifts WHERE shift_id IN (${ids.join(',')})) AS shifts`))[0]

const S = await newStaff('s')
const keep = await newShift(S, addDays(today, 30)) // 消さないシフト（記録が残ること）
{
  const one = await newShift(S, addDays(today, 10))
  await attach([one, keep])
  const r = await admin.del(`/api/admin/shifts/${one}?notify=0`)
  const rel = await related([one])
  ok('#9952 1件の削除: シフトと、精算の確認済みの印・対象外の記録・キャンセルの記録が消える', r.status === 200 && rel.shifts === 0 && rel.acks === 0 && rel.excl === 0 && rel.canc === 0, { r, rel })
}
{
  const ids = [await newShift(S, addDays(today, 11)), await newShift(S, addDays(today, 12))]
  await attach(ids)
  const r = await admin.post('/api/admin/shifts/bulk-delete', { shift_ids: ids, notify: false })
  const rel = await related(ids)
  ok('#9952 まとめて削除: シフトと、精算の確認済みの印・対象外の記録・キャンセルの記録が消える', r.status === 200 && r.data.deleted === 2 && rel.shifts === 0 && rel.acks === 0 && rel.excl === 0 && rel.canc === 0, { r, rel })
}
{
  // 今後のシフトを外す: 記録のないシフトは削除、記録（打刻修正など）のあるシフトは欠勤にして残す
  const R = await newStaff('rel')
  const ids = [await newShift(R, addDays(today, 13)), await newShift(R, addDays(today, 14))]
  const kept = await newShift(R, addDays(today, 15))
  await attach([...ids, kept])
  await sql(`INSERT INTO attendance_corrections (company_id, project_id, shift_id, staff_id, kind, report_type, requested_at, reason, status, requested_by)
    VALUES (1, ${pid}, ${kept}, ${R}, 'add', 'clock_in', '${addDays(today, 15)} 10:00:00', 'w22bw', 'rejected', 1);`)
  const r = await admin.post(`/api/admin/staff/${R}/release-future-shifts`, { from: addDays(today, 1), notify: false })
  const rel = await related(ids)
  ok('#9952 今後のシフトを外す: 削除したシフトの精算の確認済みの印・対象外の記録・キャンセルの記録が消える', r.status === 200 && r.data.removed === 2 && rel.shifts === 0 && rel.acks === 0 && rel.excl === 0 && rel.canc === 0, { r: r.data, rel })
  const relKept = await related([kept])
  ok('#9952 今後のシフトを外す: 記録があり欠勤にして残したシフトの記録は消さない', r.data?.absent === 1 && relKept.shifts === 1 && relKept.acks === 1 && relKept.excl === 1 && relKept.canc === 1, { r: r.data, relKept })
}
{
  const rel = await related([keep])
  ok('#9952 消していないシフトの記録は残る', rel.shifts === 1 && rel.acks === 1 && rel.excl === 1 && rel.canc === 1, rel)
}

// ---------- 退職後の削除（毎日の cron。retention.ts） ----------
{
  const X = await newStaff('ret')
  const past = [await newShift(X, addDays(today, -20)), await newShift(X, addDays(today, -21))]
  await attach(past)
  await sql(`UPDATE users SET retired_at = '2018-01-01', status = 'suspended' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ${X});
    UPDATE staff_profiles SET employment_status = 'retired', retention_flagged_at = '${addDays(today, -8)}' WHERE staff_id = ${X};
    UPDATE shifts SET work_date = date(work_date, '-9 years') WHERE staff_id = ${X};`)
  const before = await related([keep])
  const cron = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('0 18 * * *').replace(/%20/g, '+')}`)
  await waitServer()
  const rel = await related(past)
  const anon = (await sql(`SELECT anonymized_at FROM staff_profiles WHERE staff_id = ${X}`))[0]
  ok('#9952 退職後の削除: シフトとあわせて、取消の記録・精算の確認済みの印・対象外の記録も消える', cron.status === 200 && !!anon?.anonymized_at && rel.shifts === 0 && rel.acks === 0 && rel.excl === 0 && rel.canc === 0, { cron: cron.status, anon, rel })
  const after = await related([keep])
  ok('#9952 退職後の削除: ほかのスタッフのシフトの記録は消さない', JSON.stringify(before) === JSON.stringify(after), { before, after })
}

// ---------- ソース: 作成の4か所が last_row_id に頼らない ----------
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  // 関数の始まりから、行頭の閉じかっこ（「}」または「})」だけの行）まで
  const between = (s, a) => { const i = s.indexOf(a); if (i < 0) return ''; const m = /\n\}\)?\n/.exec(s.slice(i)); return m ? s.slice(i, i + m.index) : '' }
  const parts = [
    between(src('src/api.ts'), "api.post('/admin/staff', async"),
    between(src('src/roster.ts'), "rosterApi.post('/', async"),
    between(src('src/staff-lifecycle.ts'), 'export async function insertProvisionalStaff'),
    between(src('src/board.ts'), "boardApi.post('/proposals/:id/import', async"),
  ]
  ok('#9951 ソース: 作成の4か所は batchWithNewPerson を使い、last_row_id・createPerson を使わない', parts.every(p => p && p.includes('batchWithNewPerson') && !p.includes('last_row_id') && !p.includes('createPerson(')), parts.map(p => p.length))
}

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
