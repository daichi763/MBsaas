// 募集枠の作成・削除をまとめて書く（#9933）・応募の片付けを1文にする（#9934。作業単位 w19-slots-recruit）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --port 8612 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8612 PERSIST=<保存先> node scripts/test-w19-slots-recruit.mjs
//   PERSIST（ローカルの D1 の保存先）がないと、D1 に直接データを作る確認と、D1 の回数の確認は飛ばす（wrangler d1 execute は --local のみ）。
//   D1 の回数は、src/shift-board.ts・src/recruit.ts を esbuild でまとめ、PERSIST の D1 の複製（node:sqlite）に向けて、1回の要求で
//   prepare().run/all/first と batch が何回呼ばれたかを数える（本番には接続しない）。テストのたびに DB を作り直すこと（npm test -- w19-slots-recruit なら自動で行う）。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8612'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)

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
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w19sr-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out).at(-1).results
    } catch (e) { if (i >= 3) throw e }
  }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i))

const PFX = 'SR' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
const P = await newProject(`${PFX}-案件`)
const ROLES = [{ role_name: '販売', headcount: 3 }, { role_name: 'リーダー', headcount: 1, bill_rate: 20000, bill_unit_type: 'daily', pay_rate: 1500, pay_unit_type: 'hourly' }]
// 作った枠と役割が、今までの作り方（1日ずつ INSERT と役割の batch）と同じ内容か
function sameSlots(rows, dates, extra) {
  const bad = []
  const bySlot = new Map()
  for (const r of rows) { if (!bySlot.has(r.slot_id)) bySlot.set(r.slot_id, { ...r, roles: [] }); if (r.role_name) bySlot.get(r.slot_id).roles.push(r) }
  const slots = [...bySlot.values()].sort((a, b) => a.slot_id - b.slot_id)
  if (slots.map(s => s.work_date).join() !== dates.join()) bad.push({ dates: slots.map(s => s.work_date).slice(0, 5), n: slots.length })
  for (const s of slots) {
    for (const [k, v] of Object.entries(extra)) if ((s[k] ?? null) !== v) bad.push({ slot: s.slot_id, k, v: s[k] })
    const roles = s.roles.sort((a, b) => a.slot_role_id - b.slot_role_id)
    const want = extra.roles || ROLES
    if (roles.length !== want.length) { bad.push({ slot: s.slot_id, roles: roles.length }); continue }
    roles.forEach((r, i) => {
      const w = want[i]
      const exp = { role_name: w.role_name, headcount: w.headcount, sort_order: i, bill_rate: w.bill_rate ?? null, pay_rate: w.pay_rate ?? null,
        bill_unit_type: w.bill_rate == null ? null : w.bill_unit_type || 'daily', pay_unit_type: w.pay_rate == null ? null : w.pay_unit_type || 'daily' }
      for (const [k, v] of Object.entries(exp)) if ((r[k] ?? null) !== v) bad.push({ slot: s.slot_id, role: r.role_name, k, want: v, got: r[k] })
    })
  }
  return bad
}
const slotRowsSql = (where) => `SELECT s.slot_id, s.company_id, s.project_id, s.site_id, s.location, s.work_date, s.start_time, s.end_time, s.break_minutes, s.pattern_id, s.memo, s.created_by,
  r.slot_role_id, r.role_name, r.headcount, r.bill_unit_type, r.bill_rate, r.pay_unit_type, r.pay_rate, r.sort_order
  FROM shift_slots s LEFT JOIN shift_slot_roles r ON r.slot_id = s.slot_id WHERE ${where} ORDER BY s.slot_id, r.slot_role_id`

const ME = must(await admin.get('/api/auth/me'), 'me')
const CID = Number(ME.user?.company_id ?? ME.company_id)
const UID = Number(ME.user?.user_id ?? ME.user_id)

// ---------- #9933 募集枠: 92日をまとめて作る ----------
const D0 = addDays(today, 5)
const dates92 = range(D0, 92)
{
  const r = await admin.post('/api/admin/shift-slots', { project_id: P, dates: [...dates92].reverse(), start_time: '10:00', end_time: '19:00', break_minutes: 60, location: '会場A', memo: `${PFX}-92`, roles: ROLES })
  ok('#9933 92日分の枠の作成は 200・slot_ids は92件で日付の順', r.status === 200 && r.data.slot_ids.length === 92 && r.data.slot_ids.every((id, i, a) => !i || a[i - 1] < id), r)
  if (PERSIST) {
    const rows = sql(slotRowsSql(`s.memo = ${q(`${PFX}-92`)}`))
    const bad = sameSlots(rows, dates92, { company_id: CID, project_id: P, site_id: null, location: '会場A', start_time: '10:00', end_time: '19:00', break_minutes: 60, pattern_id: null, created_by: UID })
    ok('#9933 92日分の枠と役割（名前・人数・単価・単位・並び）が、今までの作り方と同じ', !bad.length, bad.slice(0, 5))
    ok('#9933 応答の slot_ids と作った枠が一致する', [...new Set(rows.map(x => x.slot_id))].join() === r.data.slot_ids.join(), { ids: r.data.slot_ids.slice(0, 3) })
  } else {
    const g = must(await admin.get('/api/admin/shift-slots/' + r.data.slot_ids[91]), 'slot get')
    ok('#9933 最後の日の枠に役割が2つ（並び順どおり）', g.slot.work_date === dates92[91] && g.roles.map(x => x.role_name).join() === '販売,リーダー', g)
  }
  // 1日だけ（今までどおり）
  const one = must(await admin.post('/api/admin/shift-slots', { project_id: P, work_date: addDays(today, 3), start_time: '09:00', end_time: '12:00', roles: [{ role_name: '受付', headcount: 2 }] }), 'one slot')
  const g1 = must(await admin.get('/api/admin/shift-slots/' + one.slot_ids[0]), 'one get')
  ok('#9933 work_date だけの1日の枠も作れる', one.slot_ids.length === 1 && g1.roles.length === 1 && g1.roles[0].role_name === '受付' && g1.roles[0].headcount === 2 && g1.slot.break_minutes == null, g1)
  const e1 = await admin.post('/api/admin/shift-slots', { project_id: P, dates: range(D0, 93), start_time: '10:00', end_time: '19:00', roles: ROLES })
  ok('#9933 93日は今までどおり 400', e1.status === 400, e1)
}

// ---------- #9933 繰り返し登録: 160件をまとめて作る・延長・削除 ----------
const PF = addDays(today, 200)
const dates160 = range(PF, 160)
let pattern = null
{
  const r = await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: PF, date_to: dates160[159], start_time: '08:00', end_time: '17:00', break_minutes: 45, memo: `${PFX}-160`, roles: ROLES })
  ok('#9933 160件の繰り返し登録は 200・slots=160', r.status === 200 && r.data.slots === 160 && r.data.pattern_id > 0, r)
  pattern = r.data
  const list = must(await admin.get(`/api/admin/slot-patterns?project_id=${P}`), 'patterns').patterns
  const pt = list.find(x => x.pattern_id === pattern.pattern_id)
  ok('#9933 繰り返し登録の一覧に枠の件数160', pt && pt.slot_count === 160 && pt.roles.length === 2, pt)
  if (PERSIST) {
    const rows = sql(slotRowsSql(`s.pattern_id = ${Number(pattern.pattern_id)}`))
    const bad = sameSlots(rows, dates160, { company_id: CID, project_id: P, start_time: '08:00', end_time: '17:00', break_minutes: 45, pattern_id: pattern.pattern_id, memo: `${PFX}-160` })
    ok('#9933 160件の枠と役割が、今までの作り方と同じ（100件を超える2文目の分も）', !bad.length, bad.slice(0, 5))
  }
  const e2 = await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: PF, date_to: addDays(PF, 160), start_time: '08:00', end_time: '17:00', roles: ROLES })
  ok('#9933 161件は今までどおり 400（何も作らない）', e2.status === 400, e2)
}
{
  // 延長: 30日。役割は繰り返し登録の今の役割
  const to2 = addDays(dates160[159], 30)
  const r = await admin.put(`/api/admin/slot-patterns/${pattern.pattern_id}`, { date_to: to2 })
  ok('#9933 繰り返し登録の延長で30日分の枠を作る（extend_slots=30）', r.status === 200 && r.data.extend_slots === 30 && r.data.date_to === to2, r)
  if (PERSIST) {
    const rows = sql(slotRowsSql(`s.pattern_id = ${Number(pattern.pattern_id)} AND s.work_date > ${q(dates160[159])}`))
    const bad = sameSlots(rows, range(addDays(dates160[159], 1), 30), { pattern_id: pattern.pattern_id, start_time: '08:00', end_time: '17:00', break_minutes: 45, memo: `${PFX}-160` })
    ok('#9933 延長で作った枠と役割が、今までの作り方と同じ', !bad.length, bad.slice(0, 5))
    // やり直し: 終了日を前の値に戻して（延長を送り直した状態）同じ延長を送っても、同じ日の枠を二重に作らない
    sql(`UPDATE slot_patterns SET date_to = ${q(dates160[159])} WHERE pattern_id = ${Number(pattern.pattern_id)}`)
    const again = await admin.put(`/api/admin/slot-patterns/${pattern.pattern_id}`, { date_to: to2 })
    const n = sql(`SELECT COUNT(*) AS n, COUNT(DISTINCT work_date) AS d FROM shift_slots WHERE pattern_id = ${Number(pattern.pattern_id)}`)[0]
    ok('#9933 延長のやり直しで枠が二重にならない（extend_slots=0・190件・日付の重複なし）', again.status === 200 && again.data.extend_slots === 0 && n.n === 190 && n.d === 190, { again: again.data, n })
  } else skip('#9933 延長のやり直し', 'PERSIST なし')
}

// ---------- #9933 途中で失敗したら何も作らない（ローカルの D1 に、失敗させるトリガーを一時的に作る） ----------
if (PERSIST) {
  const F = addDays(today, 700) // この日の、メモが W19FAIL の枠の登録で失敗させる
  const memo = `${PFX}-W19FAIL`
  sql(`CREATE TRIGGER IF NOT EXISTS w19_fail BEFORE INSERT ON shift_slots WHEN NEW.memo = ${q(memo)} AND NEW.work_date = ${q(F)} BEGIN SELECT RAISE(ABORT, 'w19 test'); END;`)
  try {
    const r1 = await admin.post('/api/admin/shift-slots', { project_id: P, dates: range(addDays(F, -91), 92), start_time: '10:00', end_time: '19:00', memo, roles: ROLES })
    const r2 = await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: addDays(F, -159), date_to: F, start_time: '10:00', end_time: '19:00', memo, roles: ROLES })
    const c1 = sql(`SELECT (SELECT COUNT(*) FROM shift_slots WHERE memo = ${q(memo)}) AS slots, (SELECT COUNT(*) FROM slot_patterns WHERE memo = ${q(memo)}) AS patterns,
      (SELECT COUNT(*) FROM shift_slot_roles r JOIN shift_slots s ON s.slot_id = r.slot_id WHERE s.memo = ${q(memo)}) AS roles`)[0]
    ok('#9933 92日の枠の作成が最後の日で失敗すると、ほかの日の枠も作られない', r1.status >= 500 && c1.slots === 0, { status: r1.status, c1 })
    ok('#9933 160件の繰り返し登録が2文目（101件目以降）で失敗すると、繰り返し登録も1文目の枠・役割も残らない', r2.status >= 500 && c1.patterns === 0 && c1.roles === 0, { status: r2.status, c1 })
    // 延長の途中の失敗: 役割の追加・終了日の変更もまとめて取り消される
    const p3 = must(await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: addDays(F, -50), date_to: addDays(F, -1), start_time: '10:00', end_time: '19:00', memo, roles: ROLES }), 'pattern 3')
    const r3 = await admin.put(`/api/admin/slot-patterns/${p3.pattern_id}`, { date_to: addDays(F, 10), roles: [{ role_name: '追加役割', headcount: 1 }] })
    const c3 = sql(`SELECT (SELECT date_to FROM slot_patterns WHERE pattern_id = ${Number(p3.pattern_id)}) AS date_to, (SELECT COUNT(*) FROM shift_slots WHERE pattern_id = ${Number(p3.pattern_id)}) AS slots,
      (SELECT COUNT(*) FROM shift_slot_roles r JOIN shift_slots s ON s.slot_id = r.slot_id WHERE s.pattern_id = ${Number(p3.pattern_id)} AND r.role_name = '追加役割') AS added`)[0]
    ok('#9933 延長が途中で失敗すると、終了日・延長の枠・役割の追加のどれも残らない', r3.status >= 500 && c3.date_to === addDays(F, -1) && c3.slots === 50 && c3.added === 0, { status: r3.status, c3 })
  } finally {
    sql('DROP TRIGGER IF EXISTS w19_fail;')
  }
} else skip('#9933 途中で失敗したら何も作らない', 'PERSIST なし')

// ---------- #9933 繰り返し登録の削除（remove_future=1）を1つの batch で ----------
{
  const pf = addDays(today, 400)
  const pt = must(await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: pf, date_to: addDays(pf, 119), start_time: '10:00', end_time: '18:00', roles: ROLES }), 'pattern del')
  // 1枠に人を割り当てておく（その枠は消さずに残す）
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}S1`, name: `${PFX} S1`, password: 'pass1234' }), 'staff')
  const st = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}S1`)
  const firstSlot = PERSIST ? sql(`SELECT slot_id FROM shift_slots WHERE pattern_id = ${Number(pt.pattern_id)} AND work_date = ${q(pf)}`)[0] : null
  let assigned = null
  if (firstSlot) {
    const g = must(await admin.get('/api/admin/shift-slots/' + firstSlot.slot_id), 'slot')
    must(await admin.post(`/api/admin/shift-slots/roles/${g.roles[0].slot_role_id}/assign`, { staff_ids: [st.staff_id], force: true }), 'assign')
    assigned = g.slot.slot_id
  }
  const del = must(await admin.del(`/api/admin/slot-patterns/${pt.pattern_id}?remove_future=1&today=${today}`), 'delete pattern')
  ok('#9933 繰り返し登録の削除: 割り当てのない今日以降の枠を消す（removed=119）', assigned ? del.removed === 119 : del.removed === 120, { del, assigned })
  const left = must(await admin.get(`/api/admin/slot-patterns?project_id=${P}`), 'patterns').patterns.find(x => x.pattern_id === pt.pattern_id)
  ok('#9933 繰り返し登録そのものも削除される', !left, left)
  if (assigned) {
    const g = await admin.get('/api/admin/shift-slots/' + assigned)
    ok('#9933 割り当てのある枠は残り、繰り返し登録から外れる（pattern_id=NULL・役割も残る）', g.status === 200 && g.data.slot.pattern_id == null && g.data.roles.length === 2, g)
  }
  if (PERSIST) {
    const n = sql(`SELECT COUNT(*) AS slots, (SELECT COUNT(*) FROM shift_slot_roles r WHERE NOT EXISTS (SELECT 1 FROM shift_slots s WHERE s.slot_id = r.slot_id)) AS orphan_roles
      FROM shift_slots WHERE project_id = ${P} AND work_date BETWEEN ${q(pf)} AND ${q(addDays(pf, 119))}`)[0]
    ok('#9933 消した枠の役割も残らない（枠のない役割が0件）', n.slots === (assigned ? 1 : 0) && n.orphan_roles === 0, n)
  }
}

// ---------- #9934 応募の片付け（settleRemovedSlotItems）を1つの batch で ----------
if (PERSIST) {
  const mk = async (date) => {
    const r = must(await admin.post('/api/admin/shift-slots', { project_id: P, dates: [date], start_time: '13:00', end_time: '15:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'slot ' + date)
    const g = must(await admin.get('/api/admin/shift-slots/' + r.slot_ids[0]), 'slot get')
    return { slot_id: g.slot.slot_id, role: g.roles[0].slot_role_id }
  }
  const X = await mk(addDays(today, 20)), Y = await mk(addDays(today, 21)), Z = await mk(addDays(today, -3))
  const other = sql(`SELECT company_id FROM companies WHERE company_id != ${CID} ORDER BY company_id LIMIT 1`)[0]?.company_id
  const stale = new Date(Date.now() + 9 * 3600 * 1000 - 60 * 60000).toISOString().slice(0, 19).replace('T', ' ')
  const fresh = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  // name → [company, [ [role, status, decided_at] ... ]]
  const apps = {
    stuck_cancel: [CID, [[Y.role, 'cancelled'], [X.role, 'cancelled']]],  // 明細はすべて取り下げ済み・応募は未処理のまま（途中で止まった）
    stuck_removed: [CID, [[Y.role, 'slot_removed']]],                     // 明細は「枠の削除」済み・応募は未処理のまま
    empty: [CID, []],                                                     // 明細がまだない（登録の途中）
    processing: [CID, [[Y.role, 'processing', fresh]]],                   // 承認の処理中
    stale: [CID, [[Y.role, 'processing', stale]]],                        // 処理中のまま止まった → 未対応に戻る
    past: [CID, [[Z.role, 'pending']]],                                   // 勤務日を過ぎた → 期限切れ
    still: [CID, [[Y.role, 'pending']]],                                  // 未対応のまま
    other: [other, [[Y.role, 'cancelled']]],                              // ほかの会社（触らない）
  }
  const ins = Object.entries(apps).map(([k, [co, items]]) => `INSERT INTO recruit_applications (company_id, source, name, phone, status, created_at) VALUES (${co}, 'public', ${q(`${PFX}-${k}`)}, '09000000000', 'pending', ${q(fresh)});
${items.map(([role, status, at]) => `INSERT INTO recruit_application_items (application_id, slot_role_id, status, decided_at) VALUES ((SELECT MAX(application_id) FROM recruit_applications WHERE name = ${q(`${PFX}-${k}`)}), ${role}, ${q(status)}, ${at ? q(at) : 'NULL'});`).join('\n')}`).join('\n')
  sql(ins)
  const state = () => Object.fromEntries(sql(`SELECT a.name, a.status, a.decided_at, a.decided_by, (SELECT GROUP_CONCAT(i.status, ',') FROM (SELECT status FROM recruit_application_items WHERE application_id = a.application_id ORDER BY item_id) i) AS items
    FROM recruit_applications a WHERE a.name LIKE ${q(PFX + '-%')}`).map(r => [r.name.slice(PFX.length + 1), r]))
  const sm = await admin.get('/api/admin/recruit-applications/summary')
  ok('#9934 件数の取得（片付けを含む）は 200', sm.status === 200 && typeof sm.data.pending === 'number', sm)
  let s = state()
  ok('#9934 途中で止まった応募（明細はすべて取り下げ）が、次の呼び出しで「取り下げ」に閉じる', s.stuck_cancel?.status === 'cancelled' && s.stuck_cancel.decided_at && s.stuck_cancel.decided_by == null, s.stuck_cancel)
  ok('#9934 途中で止まった応募（明細は枠の削除）が、次の呼び出しで「対応済み」に閉じる', s.stuck_removed?.status === 'done' && s.stuck_removed.decided_at, s.stuck_removed)
  ok('#9934 明細がまだない応募は閉じない', s.empty?.status === 'pending' && !s.empty.decided_at, s.empty)
  ok('#9934 処理中の明細がある応募は閉じない', s.processing?.status === 'pending' && s.processing.items === 'processing', s.processing)
  ok('#9934 処理中のまま止まった明細は未対応に戻り、応募は閉じない（#86）', s.stale?.status === 'pending' && s.stale.items === 'pending', s.stale)
  ok('#9934 勤務日を過ぎた明細は期限切れになり、応募は「対応済み」に閉じる（#302）', s.past?.status === 'done' && s.past.items === 'expired', s.past)
  ok('#9934 未対応の明細が残る応募はそのまま', s.still?.status === 'pending' && s.still.items === 'pending', s.still)
  ok('#9934 ほかの会社の応募は触らない', s.other?.status === 'pending', s.other)

  // 枠の削除: X の未対応の明細は「枠の削除」、応募は明細が残っていなければ閉じる
  const more = {
    only_x: [CID, [[X.role, 'pending']]],
    x_and_y: [CID, [[X.role, 'pending'], [Y.role, 'pending']]],
    x_and_cancel: [CID, [[X.role, 'pending'], [Y.role, 'cancelled']]],
  }
  sql(Object.entries(more).map(([k, [co, items]]) => `INSERT INTO recruit_applications (company_id, source, name, phone, status, created_at) VALUES (${co}, 'public', ${q(`${PFX}-${k}`)}, '09000000000', 'pending', ${q(fresh)});
${items.map(([role, status]) => `INSERT INTO recruit_application_items (application_id, slot_role_id, status) VALUES ((SELECT MAX(application_id) FROM recruit_applications WHERE name = ${q(`${PFX}-${k}`)}), ${role}, ${q(status)});`).join('\n')}`).join('\n'))
  const d = await admin.del('/api/admin/shift-slots/' + X.slot_id)
  s = state()
  ok('#9934 枠の削除は 200', d.status === 200, d)
  ok('#9934 枠を消すと、その枠だけの応募は「枠の削除」で「対応済み」に閉じる', s.only_x?.status === 'done' && s.only_x.items === 'slot_removed' && s.only_x.decided_at, s.only_x)
  ok('#9934 ほかの枠の未対応が残る応募は閉じない', s.x_and_y?.status === 'pending' && s.x_and_y.items === 'slot_removed,pending', s.x_and_y)
  ok('#9934 取り下げと枠の削除がまざった応募は「対応済み」（すべて取り下げのときだけ「取り下げ」）', s.x_and_cancel?.status === 'done' && s.x_and_cancel.items === 'slot_removed,cancelled', s.x_and_cancel)
} else skip('#9934 応募の片付け', 'PERSIST なし')

// ---------- D1 の回数（件数に比例しないこと） ----------
async function d1Counts() {
  const dir = join(PERSIST, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const name = existsSync(dir) && readdirSync(dir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  if (!name) return skip('D1 の回数', 'ローカルの D1 のファイルが見つかりません')
  const work = mkdtempSync(join(tmpdir(), 'w19sr-db-'))
  for (const ext of ['', '-wal', '-shm']) if (existsSync(join(dir, name + ext))) copyFileSync(join(dir, name + ext), join(work, 'db.sqlite' + ext))
  const { DatabaseSync } = await import('node:sqlite')
  const sq = new DatabaseSync(join(work, 'db.sqlite'))
  const esbuild = (await import('esbuild')).default
  const out = join(work, 'app.mjs')
  await esbuild.build({
    stdin: { contents: `import { Hono } from 'hono'; import sb from './src/shift-board.ts'; export { settleRemovedSlotItems } from './src/recruit.ts';
      export function makeApp(user) { const a = new Hono(); a.use('*', async (c, next) => { c.set('user', user); await next() }); a.route('/', sb); return a }`,
      resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  })
  const mod = await import(pathToFileURL(out).href)
  // D1 の代わり（node:sqlite）。prepare().run/all/first/raw と batch の呼び出しを数える
  const cnt = { calls: 0, batches: 0 }
  const exec = (s, args) => {
    const rows = sq.prepare(s).all(...args.map(v => typeof v === 'boolean' ? Number(v) : v))
    const m = sq.prepare('SELECT changes() AS c, last_insert_rowid() AS id').get()
    return { success: true, results: rows.map(r => ({ ...r })), meta: { changes: Number(m.c), last_row_id: Number(m.id) } }
  }
  const stmt = (s, args = []) => ({
    __sql: s, __args: args, bind: (...a) => stmt(s, a),
    all: async () => { cnt.calls++; return exec(s, args) }, run: async () => { cnt.calls++; return exec(s, args) },
    first: async (col) => { cnt.calls++; const r = exec(s, args).results[0]; return r == null ? null : col ? r[col] : r },
    raw: async () => { cnt.calls++; return exec(s, args).results.map(r => Object.values(r)) },
  })
  const db = {
    prepare: (s) => stmt(s),
    batch: async (list) => {
      cnt.calls++; cnt.batches++
      sq.exec('BEGIN')
      try { const res = list.map(x => exec(x.__sql, x.__args)); sq.exec('COMMIT'); return res } catch (e) { sq.exec('ROLLBACK'); throw e }
    },
  }
  const app = mod.makeApp({ company_id: CID, user_id: UID, role: 'admin', name: '管理者' })
  const ctx = { waitUntil() { }, passThroughOnException() { } }
  const call = async (method, path, body) => {
    cnt.calls = 0; cnt.batches = 0
    const r = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: db }, ctx)
    return { status: r.status, data: await r.json().catch(() => null), calls: cnt.calls, batches: cnt.batches }
  }
  const base = addDays(today, 900)
  const s10 = await call('POST', '/shift-slots', { project_id: P, dates: range(base, 10), start_time: '10:00', end_time: '19:00', roles: ROLES })
  const s92 = await call('POST', '/shift-slots', { project_id: P, dates: range(addDays(base, 100), 92), start_time: '10:00', end_time: '19:00', roles: ROLES })
  console.log(`INFO  D1 の回数: 枠の作成 10日=${s10.calls} 92日=${s92.calls}（batch ${s92.batches}）`)
  ok('D1 の回数: 枠の作成は日数に比例しない（10日と92日で同じ・batch 1回）', s10.status === 200 && s92.status === 200 && s92.data.slot_ids.length === 92 && s10.calls === s92.calls && s92.batches === 1, { s10: s10.calls, s92: s92.calls, b: s92.batches })
  const p20 = await call('POST', '/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: addDays(base, 300), date_to: addDays(base, 319), start_time: '10:00', end_time: '19:00', roles: ROLES })
  const p160 = await call('POST', '/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: addDays(base, 400), date_to: addDays(base, 559), start_time: '10:00', end_time: '19:00', roles: ROLES })
  console.log(`INFO  D1 の回数: 繰り返し登録の作成 20件=${p20.calls} 160件=${p160.calls}`)
  ok('D1 の回数: 繰り返し登録の作成は件数に比例しない（20件と160件で同じ・batch 1回）', p20.status === 200 && p160.status === 200 && p160.data.slots === 160 && p20.calls === p160.calls && p160.batches === 1, { p20: p20.calls, p160: p160.calls })
  const e10 = await call('PUT', `/slot-patterns/${p20.data.pattern_id}`, { date_to: addDays(base, 329) })
  const e160 = await call('PUT', `/slot-patterns/${p160.data.pattern_id}`, { date_to: addDays(base, 719) })
  console.log(`INFO  D1 の回数: 延長 10日=${e10.calls} 160日=${e160.calls}`)
  ok('D1 の回数: 延長は日数に比例しない（10日と160日で同じ）', e10.status === 200 && e160.status === 200 && e10.data.extend_slots === 10 && e160.data.extend_slots === 160 && e10.calls === e160.calls, { e10: [e10.calls, e10.data?.extend_slots], e160: [e160.calls, e160.data?.extend_slots] })
  const d30 = await call('DELETE', `/slot-patterns/${p20.data.pattern_id}?remove_future=1`)
  const d320 = await call('DELETE', `/slot-patterns/${p160.data.pattern_id}?remove_future=1`)
  console.log(`INFO  D1 の回数: 繰り返し登録の削除 30件=${d30.calls} 320件=${d320.calls}`)
  ok('D1 の回数: 繰り返し登録の削除は枠の数に比例しない（30件と320件で同じ）', d30.data?.removed === 30 && d320.data?.removed === 320 && d30.calls === d320.calls, { d30: [d30.calls, d30.data], d320: [d320.calls, d320.data] })
  // 応募の片付け: 応募が1件でも50件でも batch 1回
  const sl = s10.data.slot_ids
  // 役割を消した枠への応募（slot_role_id は消した役割の ID）
  const goneRoles = sq.prepare(`SELECT slot_role_id FROM shift_slot_roles WHERE slot_id IN (SELECT value FROM json_each(?)) ORDER BY slot_role_id`).all(JSON.stringify(sl)).map(r => r.slot_role_id)
  const addApps = (n, k) => {
    for (let i = 0; i < n; i++) {
      const a = sq.prepare(`INSERT INTO recruit_applications (company_id, source, name, status) VALUES (?, 'public', ?, 'pending') RETURNING application_id`).get(CID, `${PFX}-cnt${k}-${i}`).application_id
      sq.prepare(`INSERT INTO recruit_application_items (application_id, slot_role_id, status) VALUES (?, ?, 'pending')`).run(a, goneRoles[i % goneRoles.length])
    }
  }
  const settle = async () => { cnt.calls = 0; cnt.batches = 0; await mod.settleRemovedSlotItems(db, CID); return { calls: cnt.calls, batches: cnt.batches } }
  await settle()
  addApps(1, 'a'); sq.prepare(`DELETE FROM shift_slot_roles WHERE slot_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(sl))
  const c1 = await settle()
  const closed1 = sq.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE name LIKE ? AND status = 'done'`).get(`${PFX}-cnta-%`).n
  addApps(50, 'b') // すべて「枠の削除」になる
  const c50 = await settle()
  const closed50 = sq.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE name LIKE ? AND status = 'done'`).get(`${PFX}-cntb-%`).n
  ok('D1 の回数: 応募の片付けは応募の数に比例しない（1件でも50件でも batch 1回だけ）', c1.calls === 1 && c1.batches === 1 && c50.calls === 1 && c50.batches === 1, { c1, c50 })
  ok('D1 の回数の確認で、片付けた応募はすべて閉じる（1件・50件）', closed1 === 1 && closed50 === 50, { closed1, closed50 })
  sq.close()
  try { rmSync(work, { recursive: true, force: true }) } catch { } // D1 の複製・まとめたコードを一時フォルダに残さない
}
if (PERSIST) await d1Counts()
else skip('D1 の回数', 'PERSIST なし')

try { rmSync(SQL_DIR, { recursive: true, force: true }) } catch { }
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
