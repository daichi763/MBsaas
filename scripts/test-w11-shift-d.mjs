// シフト管理の D 案（w11-shift-d: Sprint 11 #9401 #9402 #9403）の統合テスト
//   #9401 候補に出勤可能日・前回この案件・連勤数・スキルを返し、出勤可能日を出した人を先に並べる。常勤の「この人で毎週」は同じ枠に割り当てる
//   #9402 まとめて保存（POST /api/admin/shift-slots/assign-batch）: 問題のある行だけ理由付きで返し、ほかは1回で登録する
//   #9403 枠の削除: 割り当て・応募があるときは件数を返して確かめる。エラーは分かる言葉で返す
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w11-shift-d.mjs
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

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
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${(r.text || '').slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

const PFX = 'W11D' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(k, extra = {}) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', ...extra }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
async function newProject(tag, engagement = 'regular', extra = {}) {
  const r = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-${tag}`, client_id: cl.client_id, unit_price: 10000, allow_duplicate: true, ...extra }), 'project')
  must(await admin.put(`/api/admin/projects/${r.project_id}/pricing`, { engagement_type: engagement, unit_price_type: 'daily', unit_price: 10000, pay_unit_type: 'daily', pay_rate: 8000 }), 'pricing')
  return r.project_id
}
async function newSlot(pid, date, start = '10:00', end = '18:00', roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}&project_ids=${pid}`), 'board')
  const s = b.slots.filter(x => x.start_time === start && x.end_time === end).pop()
  return { slot_id: s.slot_id, roles: s.roles.map(r => r.slot_role_id) }
}
const board = async (pid, from, to = from) => must(await admin.get(`/api/admin/shift-board?from=${from}&to=${to}&project_ids=${pid}`), 'board')
const batch = (items) => admin.post('/api/admin/shift-slots/assign-batch', { items })

// 30日以上先の月曜日（出勤可能日は今月〜3か月先まで提出できる）
let MON = addDays(today, 30); while (weekday(MON) !== 1) MON = addDays(MON, 1)
const TUE = addDays(MON, 1), WED = addDays(MON, 2)

const S = {}
for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) S[k] = await newStaff(k)
const P = await newProject('常勤', 'regular', { required_skills: 'MNP' })
const SP = await newProject('スポット', 'spot')

// ---------- #9401 候補: 出勤可能日・前回この案件・連勤数・スキル ----------
{
  must(await admin.put(`/api/admin/staff/${S.C.staff_id}`, { skills: 'MNP、光回線' }), 'skills')
  // B は出勤可能日を提出（この日は ○）。D は × を付ける
  const stB = client(await login('sample', `${PFX}B`)), stD = client(await login('sample', `${PFX}D`))
  const month = TUE.slice(0, 7)
  const pB = await stB.put('/api/staff/availability', { month, days: [{ date: TUE, status: 'ok' }] })
  const pD = await stD.put('/api/staff/availability', { month, days: [{ date: TUE, status: 'ng', note: '通院' }] })
  ok('（前提）出勤可能日を提出', pB.status === 200 && pD.status === 200, { pB: pB.data, pD: pD.data })
  // A は前日にこの案件で働いている（前回この案件・連勤 2）
  const prev = await newSlot(P, MON)
  must(await admin.post(`/api/admin/shift-slots/roles/${prev.roles[0]}/assign`, { staff_ids: [S.A.staff_id], force: true }), 'assign A')
  const t = await newSlot(P, TUE)
  const d = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${t.roles[0]}`), 'candidates')
  const c = (s) => d.candidates.find(x => x.staff_id === s.staff_id)
  const idx = (s) => d.candidates.findIndex(x => x.staff_id === s.staff_id)
  ok('#9401 出勤可能日（○）を返す', c(S.B)?.availability?.status === 'ok', c(S.B))
  ok('#9401 出勤可能日（×）とメモを返す', c(S.D)?.availability?.status === 'ng' && c(S.D)?.availability?.note === '通院', c(S.D))
  ok('#9401 未提出は availability: null', c(S.E) && c(S.E).availability === null, c(S.E))
  ok('#9401 前回この案件の日付を返す', c(S.A)?.last_project_date === MON, c(S.A))
  ok('#9401 この日に入ったときの連勤数を返す（前日に稼働 → 2）', c(S.A)?.run_days === 2 && c(S.E)?.run_days === 1, { A: c(S.A), E: c(S.E) })
  ok('#9401 スタッフのスキル（読点区切りも分ける）を返す', JSON.stringify(c(S.C)?.skills) === JSON.stringify(['MNP', '光回線']) && c(S.C)?.skill_match === 1, c(S.C))
  ok('#9401 並び: 出勤可能日を出した人（○）が最優先、次に前回この案件', idx(S.B) >= 0 && idx(S.B) < idx(S.A) && idx(S.A) < idx(S.E), { B: idx(S.B), A: idx(S.A), E: idx(S.E) })
  ok('#9401 並び: 出勤可能日で × の人は未提出の人より後ろ', idx(S.E) < idx(S.D), { E: idx(S.E), D: idx(S.D) })
}

// ---------- #9402 まとめて保存 ----------
{
  const s1 = await newSlot(P, WED, '10:00', '18:00', [{ role_name: '販売', headcount: 1 }, { role_name: 'リーダー', headcount: 1 }])
  const sp = await newSlot(SP, WED, '12:00', '15:00', [{ role_name: '販売', headcount: 3 }])
  const [rSale, rLead] = s1.roles
  // 退職者・休職中・NG を用意
  must(await admin.put(`/api/admin/employees/${S.F.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } }), 'retire F')
  must(await admin.put(`/api/admin/employees/${S.G.staff_id}`, { profile: { employment_status: 'leave' } }), 'leave G')
  must(await admin.put(`/api/admin/clients/${cl.client_id}/ng-staff`, { staff: [{ staff_id: S.E.staff_id, reason: 'テスト' }] }), 'ng E')

  const r0 = await batch([])
  ok('#9402 空の保存は 400', r0.status === 400 && /保存する割り当て/.test(r0.data?.error || ''), r0.data)
  const rBad = await batch([{ slot_role_id: 'x', staff_id: 1 }])
  ok('#9402 枠・スタッフの指定が正しくないと 400', rBad.status === 400, rBad.data)

  const items = [
    { slot_role_id: rSale, staff_id: S.A.staff_id },                 // 登録できる
    { slot_role_id: rLead, staff_id: S.B.staff_id },                 // 登録できる
    { slot_role_id: sp.roles[0], staff_id: S.A.staff_id },           // A は同じ時間帯に販売（先の行）→ 重複の警告
    { slot_role_id: sp.roles[0], staff_id: S.F.staff_id },           // 退職 → 登録できない
    { slot_role_id: sp.roles[0], staff_id: S.E.staff_id },           // NG → 警告
    { slot_role_id: sp.roles[0], staff_id: S.G.staff_id },           // 休職中 → 警告
    { slot_role_id: rSale, staff_id: S.C.staff_id },                 // 定員1に2人目 → 警告
    { slot_role_id: rLead, staff_id: S.B.staff_id },                 // 同じ下書きが2件 → 登録できない
    { slot_role_id: 99999999, staff_id: S.C.staff_id },              // 枠がない → 登録できない
  ]
  const r1 = await batch(items)
  ok('#9402 問題があっても 200 で、登録できた行と問題の行を返す', r1.status === 200 && Array.isArray(r1.data?.created) && Array.isArray(r1.data?.problems), r1.data)
  const created = r1.data.created || [], problems = r1.data.problems || []
  const pr = (rid, sid) => problems.find(x => x.slot_role_id === rid && x.staff_id === sid)
  ok('#9402 問題のない2件を登録する', created.length === 2 && created.some(x => x.slot_role_id === rSale && x.staff_id === S.A.staff_id) && created.some(x => x.slot_role_id === rLead && x.staff_id === S.B.staff_id), created)
  ok('#9402 同じ保存の中で先に通した行と時間が重なる → 重複の警告（確認すれば登録できる）', pr(sp.roles[0], S.A.staff_id)?.can_force === true && /同じ時間帯/.test(pr(sp.roles[0], S.A.staff_id)?.reasons.join('')), pr(sp.roles[0], S.A.staff_id))
  ok('#9402 退職者は登録できない（can_force: false）', pr(sp.roles[0], S.F.staff_id)?.can_force === false && /退職/.test(pr(sp.roles[0], S.F.staff_id)?.reasons.join('')), pr(sp.roles[0], S.F.staff_id))
  ok('#9402 NG は警告', pr(sp.roles[0], S.E.staff_id)?.can_force === true && /NG/.test(pr(sp.roles[0], S.E.staff_id)?.reasons.join('')), pr(sp.roles[0], S.E.staff_id))
  ok('#9402 休職中は警告', pr(sp.roles[0], S.G.staff_id)?.can_force === true && /休職中/.test(pr(sp.roles[0], S.G.staff_id)?.reasons.join('')), pr(sp.roles[0], S.G.staff_id))
  ok('#9402 定員を超える行は警告（同じ保存で先に入れた人も数える）', pr(rSale, S.C.staff_id)?.can_force === true && /定員（1名）/.test(pr(rSale, S.C.staff_id)?.reasons.join('')), pr(rSale, S.C.staff_id))
  ok('#9402 同じ枠に同じ人の下書きが2件 → 2件目は登録できない', problems.filter(x => x.slot_role_id === rLead && x.staff_id === S.B.staff_id).length === 1 && /2件/.test(pr(rLead, S.B.staff_id)?.reasons.join('')), problems)
  ok('#9402 枠がない行は理由を返す', /枠が見つかりません/.test(pr(99999999, S.C.staff_id)?.reasons.join('') || ''), pr(99999999, S.C.staff_id))
  ok('#9402 問題の行にはスタッフ名を付ける', pr(sp.roles[0], S.E.staff_id)?.staff_name === `${PFX} E`, pr(sp.roles[0], S.E.staff_id))
  const b1 = await board(P, WED)
  const sale = b1.slots.find(s => s.slot_id === s1.slot_id).roles.find(r => r.slot_role_id === rSale)
  ok('#9402 登録したシフトは確定で、単価を計算している', sale.assigned.length === 1 && sale.assigned[0].status === 'confirmed' && sale.assigned[0].bill_rate === 10000 && sale.assigned[0].pay_rate === 8000, sale.assigned)

  // もう一度送る: 割当済みは登録できない。警告の行は force で登録できる
  const r2 = await batch([{ slot_role_id: rSale, staff_id: S.A.staff_id }, { slot_role_id: sp.roles[0], staff_id: S.E.staff_id, force: true }, { slot_role_id: sp.roles[0], staff_id: S.G.staff_id, force: true, status: 'requested' }])
  const p2 = r2.data?.problems || []
  ok('#9402 すでに割り当て済みの人は登録できない', p2.some(x => x.slot_role_id === rSale && x.staff_id === S.A.staff_id && !x.can_force && /割り当て済み/.test(x.reasons.join(''))), r2.data)
  ok('#9402 確認した警告の行（force）は登録する。状態（希望（仮））も送れる', (r2.data?.created || []).length === 2, r2.data)
  const b2 = await board(SP, WED)
  const spr = b2.slots.find(s => s.slot_id === sp.slot_id).roles[0]
  ok('#9402 希望（仮）で登録した行は requested', spr.assigned.find(a => a.staff_id === S.G.staff_id)?.status === 'requested', spr.assigned)

  // 定員の警告: 希望（仮）は定員に数えない
  const sp2 = await newSlot(SP, addDays(WED, 1), '10:00', '12:00', [{ role_name: '販売', headcount: 1 }])
  const r3 = await batch([{ slot_role_id: sp2.roles[0], staff_id: S.A.staff_id }, { slot_role_id: sp2.roles[0], staff_id: S.B.staff_id, status: 'requested' }])
  ok('#9402 希望（仮）は定員の確認に数えない', (r3.data?.created || []).length === 2 && !(r3.data?.problems || []).length, r3.data)

  // 単価の引き継ぎ（スポット: この案件の前回のシフトの単価）
  // 引き継ぎ元は、この案件のいちばん新しいシフト（WED の翌日の枠）
  const spIds = must(await admin.get(`/api/admin/shift-board?from=${addDays(WED, 1)}&to=${addDays(WED, 1)}&project_ids=${SP}`), 'board').slots[0].roles[0].assigned.map(a => a.shift_id)
  for (const sid of spIds) must(await admin.put(`/api/admin/shifts/${sid}/price`, { bill_rate: 15000, pay_rate: 11000 }), 'manual price')
  const sp3 = await newSlot(SP, addDays(WED, 7), '12:00', '15:00', [{ role_name: '販売', headcount: 2 }])
  const r4 = await batch([{ slot_role_id: sp3.roles[0], staff_id: S.C.staff_id }])
  const r5 = await batch([{ slot_role_id: sp3.roles[0], staff_id: S.B.staff_id, inherit: false }])
  const b4 = (await board(SP, addDays(WED, 7))).slots[0].roles[0].assigned
  ok('#9402 スポット: 前回のシフトの単価を引き継ぐ（inherited の件数を返す）', r4.data?.inherited === 1 && b4.find(a => a.staff_id === S.C.staff_id)?.bill_rate === 15000, { r4: r4.data, b4 })
  ok('#9402 inherit: false なら単価の設定のまま', r5.data?.inherited === 0 && b4.find(a => a.staff_id === S.B.staff_id)?.bill_rate === 10000, { r5: r5.data, b4 })

  // 案件 × 役割の種類が多すぎるときは 400（画面は分けて送る）
  const many = []
  for (let i = 0; i < 9; i++) { const pp = await newProject('多' + i); const s = await newSlot(pp, addDays(WED, 14)); many.push({ slot_role_id: s.roles[0], staff_id: S.C.staff_id }) }
  const r6 = await batch(many)
  ok('#9402 案件・役割が9種類以上なら 400（分けて保存するよう案内）', r6.status === 400 && /8種類/.test(r6.data?.error || ''), r6.data)
  const r7 = await batch(many.slice(0, 8).map((x, i) => ({ ...x, staff_id: [S.A, S.B, S.C, S.D][i % 4].staff_id, force: true })))
  ok('#9402 8種類までなら1回で保存できる', r7.status === 200 && (r7.data?.created || []).length === 8, r7.data)
  const r8 = await batch(Array.from({ length: 201 }, () => ({ slot_role_id: rSale, staff_id: S.A.staff_id })))
  ok('#9402 201件以上は 400', r8.status === 400, r8.data)
}

// ---------- #9401 常勤: この人で毎週（/shifts/bulk の slot_match） ----------
{
  const W1 = addDays(MON, 14), W2 = addDays(MON, 21), W3 = addDays(MON, 28)
  const a = await newSlot(P, W1, '09:00', '17:00', [{ role_name: '販売', headcount: 1 }])
  const b = await newSlot(P, W2, '09:00', '17:00', [{ role_name: '販売', headcount: 1 }])
  must(await admin.post(`/api/admin/shift-slots/roles/${b.roles[0]}/assign`, { staff_ids: [S.B.staff_id], force: true }), 'fill W2')
  const r = await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [S.C.staff_id], weekdays: [1], date_from: W1, date_to: W3, start_time: '09:00', end_time: '17:00', role: '販売', slot_match: true })
  ok('#9401 毎週の繰り返し登録: 同じ曜日・時間・役割の枠に1件割り当てる', r.status === 200 && r.data.created === 1, r.data)
  const sk = r.data?.skipped || []
  ok('#9401 定員に達した枠の日はスキップ（定員）', sk.some(x => x.date === W2 && x.reason === '定員'), sk)
  ok('#9401 枠のない日はスキップ（枠なし）', sk.some(x => x.date === W3 && x.reason === '枠なし'), sk)
  const bb = await board(P, W1)
  const role = bb.slots.find(s => s.slot_id === a.slot_id).roles[0]
  ok('#9401 割り当てたシフトは枠に入り、「枠なし」にならない', role.assigned.some(x => x.staff_id === S.C.staff_id) && !bb.unslotted.some(x => x.staff_id === S.C.staff_id), { role, unslotted: bb.unslotted })
  const again = await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [S.C.staff_id], weekdays: [1], date_from: W1, date_to: W1, start_time: '09:00', end_time: '17:00', role: '販売', slot_match: true })
  ok('#9401 もう一度実行しても二重にしない（割当済み）', again.status === 200 && again.data.created === 0 && again.data.skipped.some(x => x.reason === '割当済み'), again.data)
  const plain = await admin.post('/api/admin/shifts/bulk', { project_id: P, staff_ids: [S.D.staff_id], weekdays: [1], date_from: W3, date_to: W3, start_time: '09:00', end_time: '17:00', role: '販売' })
  ok('#9401 slot_match なしは今までどおり（枠なしで登録）', plain.status === 200 && plain.data.created === 1, plain.data)
}

// ---------- #9403 枠の削除 ----------
{
  const D = addDays(MON, 35)
  const s = await newSlot(P, D)
  const empty = await admin.del(`/api/admin/shift-slots/${s.slot_id}`)
  ok('#9403 割り当てのない枠は削除できる', empty.status === 200, empty.data)
  const gone = await admin.del(`/api/admin/shift-slots/${s.slot_id}`)
  ok('#9403 もうない枠の削除は 404 で、理由（ほかの画面で削除された可能性）を返す', gone.status === 404 && /削除された可能性/.test(gone.data?.error || ''), gone.data)
  const s2 = await newSlot(P, D)
  must(await admin.post(`/api/admin/shift-slots/roles/${s2.roles[0]}/assign`, { staff_ids: [S.A.staff_id], force: true }), 'assign')
  const d1 = await admin.del(`/api/admin/shift-slots/${s2.slot_id}`)
  ok('#9403 割り当て済みの人がいる枠は件数を返して確かめる（need_force）', d1.status === 409 && d1.data?.need_force && d1.data.assigned === 1 && /割り当て済み/.test(d1.data.error), d1.data)
  const d2 = await admin.del(`/api/admin/shift-slots/${s2.slot_id}?force=1`)
  const bd = await board(P, D)
  ok('#9403 force で枠を削除し、シフトは枠なしで残す', d2.status === 200 && !bd.slots.some(x => x.slot_id === s2.slot_id) && bd.unslotted.some(x => x.staff_id === S.A.staff_id), { d2: d2.data, bd })
}

// ---------- 画面（静的な確認） ----------
{
  const sb = readFileSync(new URL('../public/static/shift-board.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/input.css', import.meta.url), 'utf8')
  ok('#9401 期間の切り替え（週・2週間・月）と絞り込み（常勤のみ・スポットのみ・不足のみ）', sb.includes("seg('range', 'week', '週')") && sb.includes("seg('range', '2w', '2週間')") && sb.includes("seg('range', 'month', '月（カレンダー）')")
    && sb.includes("seg('engagement', 'regular', '常勤のみ')") && sb.includes("seg('engagement', 'spot', 'スポットのみ')") && sb.includes('data-action="boardToggleShort"'))
  ok('#9401 月はカレンダー表示で、日付を押すとその週に切り替える', sb.includes('function monthGrid(days)') && sb.includes("delegate('boardCalDay'") && sb.includes("BS.range = 'week'; BS.from = weekStart(el.dataset.date)"))
  ok('#9401 右の欄に単価の引き継ぎ・この枠だけ単価を変える・候補の絞り込み・毎週の繰り返し登録', sb.includes('function sidePriceHtml(x)') && sb.includes('この枠だけ単価を変える') && sb.includes("tg('free', '空いている人'") && sb.includes("tg('prev', '前回この案件'") && sb.includes('この人で毎週の繰り返し登録を作る') && sb.includes('slot_match: true'))
  ok('#9402 候補を押すと下書きにし、まとめて保存で1回の API に送る', sb.includes("delegate('boardDraftAdd'") && sb.includes("axios.post('/api/admin/shift-slots/assign-batch'") && sb.includes('まとめて保存（'))
  ok('#9402 保存していない下書きがあるときは、期間の切り替え・画面の移動・ページを閉じる前に確かめる', sb.includes('function confirmDiscardDrafts(what)') && sb.includes("window.addEventListener('beforeunload'") && sb.includes("window.removeEventListener('hashchange', route0)") && sb.includes('if (leaveGuard(ev)) route0()'))
  ok('#9403 表のマスと右の欄に「枠を削除」、件数を出して確かめる', (sb.match(/data-action="boardDeleteSlot"/g) || []).length >= 2 && sb.includes('function openDeleteSlot(slotId)') && /未対応の応募が\$\{applicants\}件あります/.test(sb))
  ok('画面: イベント属性に値を埋め込まない（新しい表・右の欄）', !/onclick="[^"]*\$\{/.test(sb.slice(sb.indexOf('// シフト管理（D 案'), sb.indexOf('// 重複の表示。'))) && !sb.includes('onclick="openShiftDetail(${a.shift_id})" title="${esc(title)}"'))
  ok('画面: D 案の CSS（表と右の欄・下書き・カレンダー）', ['.board-d ', '.board-side', '.chip-draft', '.board-savebar', '.board-cal ', '.cand-item'].every(k => css.includes(k)))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
