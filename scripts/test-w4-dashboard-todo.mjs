// ダッシュボードの ToDo・相談・フォロー記録の統合テスト（w4-dashboard-todo: #314 #385 #402 #403 #412 #449 #487 #498 #510、持ち越し #497 #183 #184 #456）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w4-dashboard-todo.mjs
//   PERSIST を指定すると、返信の日時を過去にずらす確認（#403 対応中のまま日数がたった相談）も行う。
// テストのたびに DB を作り直すこと（シフト・相談を追加するため）。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const req = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // ローカルの D1 を直接書き換えた直後は、接続が切られることがあるので1回だけやり直す
    const r = await req().catch(() => new Promise(res => setTimeout(res, 1000)).then(req))
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w4dt-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const jstNowMs = () => Date.now() + 9 * 3600 * 1000
const today = new Date(jstNowMs()).toISOString().slice(0, 10)
const month = today.slice(0, 7)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const at = (offset) => { const iso = new Date(jstNowMs() + offset * 60000).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) } }
const tag = Date.now().toString(36).slice(-5)

const admin = client(await login('sample', 'admin'))
const dash = async () => { const r = await admin.get('/api/admin/dashboard'); if (r.status !== 200) throw new Error('dashboard ' + r.status + JSON.stringify(r.data)); return r.data }
async function createShift(staff_id, work_date, start_time, end_time, memo) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id: 1, work_date, start_time, end_time, memo: memo + tag, force: true })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  return r.data.shift_id
}
const relShift = (staff_id, memo, startOff, endOff) => { const s = at(startOff), e = at(endOff); return createShift(staff_id, s.date, s.time, e.time, memo) }
const todoBy = (d, key) => (d.todos || []).find(t => t.key === key)
const hiddenBy = (d, key) => (d.hidden_todos || []).find(t => t.key === key)

// ---------- #510 ダッシュボードが相談の本文を返さない・本文の長さと回数の上限 ----------
{
  const st3 = client(await login('sample', 'st003'))
  const long = await st3.post('/api/staff/consultations', { category: 'question', body: 'あ'.repeat(2001) })
  ok('#510 2000文字を超える相談は 400', long.status === 400, long)
  const r = await st3.post('/api/staff/consultations', { category: 'question', body: `質問です${tag}`, urgency: 'high' })
  ok('相談を送る（st003）', r.status === 200 && r.data.consultation_id, r)
  const cid3 = r.data.consultation_id
  const d = await dash()
  ok('#510 ダッシュボードは open_consultations（本文つき）を返さない', !('open_consultations' in d), Object.keys(d))
  ok('#510 未完了の相談の件数を返す', d.consultation_counts && d.consultation_counts.open >= 1, d.consultation_counts)
  // #402 相談の ToDo は相談対応のその相談へ
  const t = todoBy(d, `consult:${cid3}`)
  ok('#402 相談の ToDo のリンクは #consult/{id}', t && t.href === `#consult/${cid3}` && t.level === 'high', t)
  ok('#510 ToDo に本文は入らない', t && !JSON.stringify(t).includes(`質問です${tag}`), t)
  ok('#487 相談の ToDo は『あとで』だけ（対応済みは相談対応で）', t && t.actions.join() === 'snooze', t)
  const one = await admin.get(`/api/admin/consultations?id=${cid3}`)
  ok('#402 相談一覧 API の ?id= でその相談だけを返す', one.status === 200 && one.data.consultations.length === 1 && one.data.consultations[0].consultation_id === cid3 && one.data.focus_id === cid3, one.data)
  const bad = await admin.get('/api/admin/consultations?id=abc')
  ok('#402 ?id= が数字でなければ 404', bad.status === 404, bad)

  // #403 返信して対応中にすると、その場では ToDo から外れ、日数がたつと『対応中のまま』で出る
  const rp = await admin.put(`/api/admin/consultations/${cid3}`, { manager_reply: '確認して折り返します', status: 'in_progress' })
  ok('一次返信して対応中にする', rp.status === 200, rp)
  const d2 = await dash()
  ok('#403 返信した直後は ToDo に出ない', !todoBy(d2, `consult:${cid3}`) && !todoBy(d2, `consult_wait:${cid3}`), d2.todos.map(x => x.key))
  if (PERSIST) {
    sql(`UPDATE user_notifications SET created_at = datetime('now', '+9 hours', '-3 days') WHERE kind = 'consult_reply' AND related_id = ${Number(cid3)};`)
    const d3 = await dash()
    const w = todoBy(d3, `consult_wait:${cid3}`)
    ok('#403 返信から2日以上たって対応中のままの相談が ToDo に出る', w && /対応中のまま/.test(w.text) && w.href === `#consult/${cid3}`, d3.todos.map(x => [x.key, x.text]))
  } else skip('#403 返信から日数がたった相談', 'PERSIST 未指定')

  // 回数の上限（st009 が24時間に20件まで）
  const st9 = client(await login('sample', 'st009'))
  let lastOk = 0
  for (let i = 0; i < 20; i++) { const x = await st9.post('/api/staff/consultations', { category: 'other', body: `連絡${i}-${tag}` }); if (x.status === 200) lastOk++ }
  const over = await st9.post('/api/staff/consultations', { category: 'other', body: `21件目${tag}` })
  ok('#510 24時間に20件までは送れる', lastOk === 20, lastOk)
  ok('#510 21件目は 429', over.status === 429, over)
}

// ---------- #487 ToDo の『対応済み』『あとで』 ----------
{
  // 欠勤が月2回（ルール3）。月初で今日より前の日がなくても数えられるよう、今日のシフトを2つ欠勤にする
  const a1 = await createShift(6, today, '00:00', '00:30', 'W4DT-ab1')
  const a2 = await createShift(6, today, '00:40', '01:00', 'W4DT-ab2')
  for (const id of [a1, a2]) { const r = await admin.put(`/api/admin/shifts/${id}`, { status: 'absent' }); if (r.status !== 200) console.log('absent', r) }
  let d = await dash()
  const key = `absent:6:${month}`
  let t = todoBy(d, key)
  ok('#487 ToDo に安定したキーと mark が付く（欠勤 月2回）', t && t.mark === 2 && t.actions.includes('done') && t.actions.includes('snooze'), d.todos.map(x => [x.key, x.mark]))
  const badKey = await admin.post('/api/admin/dashboard/todos', { key: 'x y', action: 'done' })
  const badAct = await admin.post('/api/admin/dashboard/todos', { key, action: 'evil' })
  const badDays = await admin.post('/api/admin/dashboard/todos', { key, action: 'snooze', days: 99 })
  ok('#487 キー・操作・日数が正しくなければ 400', badKey.status === 400 && badAct.status === 400 && badDays.status === 400, [badKey, badAct, badDays])
  const dn = await admin.post('/api/admin/dashboard/todos', { key, mark: t.mark, action: 'done' })
  ok('#487 対応済みにする', dn.status === 200 && dn.data.user_name, dn)
  d = await dash()
  const h = hiddenBy(d, key)
  ok('#487 対応済みの ToDo は todos から外れ、hidden_todos に誰がいつ対応したかが付く', !todoBy(d, key) && h && h.dismissed.action === 'done' && h.dismissed.user_name, h)
  // 件数が増えたらもう一度出す
  const a3 = await createShift(6, today, '01:10', '01:30', 'W4DT-ab3')
  await admin.put(`/api/admin/shifts/${a3}`, { status: 'absent' })
  d = await dash()
  t = todoBy(d, key)
  ok('#487 欠勤が増えたら（mark が増えたら）もう一度出る', t && t.mark === 3, d.todos.map(x => [x.key, x.mark]))
  // あとで → 元に戻す
  const sn = await admin.post('/api/admin/dashboard/todos', { key, mark: t.mark, action: 'snooze' })
  ok('#487 あとで（明日の 0:00 まで）', sn.status === 200 && sn.data.until_at === `${addDays(today, 1)} 00:00:00`, sn)
  d = await dash()
  ok('#487 あとでにした ToDo は出ない', !todoBy(d, key) && hiddenBy(d, key)?.dismissed.action === 'snooze', hiddenBy(d, key))
  const rs = await admin.del('/api/admin/dashboard/todos?key=' + encodeURIComponent(key))
  d = await dash()
  ok('#487 元に戻すとまた出る', rs.status === 200 && todoBy(d, key), rs)
}

// ---------- #498 遅刻・欠勤の相談を未入店の一覧に結び付ける / #449 人で数える ----------
{
  const s7 = await relShift(7, 'W4DT-c7', -90, 60)    // 連絡あり
  const s10 = await relShift(10, 'W4DT-c10', -60, 60) // 連絡なし（経過は短い）
  const st7b = client(await login('sample', 'st007'))
  const co = await st7b.post('/api/staff/consultations', { category: 'absence', body: `電車遅延で20分遅れます${tag}。到着は10時ごろの見込みです`, shift_id: s7 })
  ok('st007 が対象のシフトを選んで遅刻の連絡を送る', co.status === 200, co)
  const d = await dash()
  const ci = d.unreported.check_in
  // 一覧は人ごとに1行（同じ人のほかのシフトがあれば、最も遅れているシフトの行にまとまる）ので、人で探す
  const i7 = ci.find(x => x.staff_id === 7), i10 = ci.find(x => x.staff_id === 10)
  ok('#498 未入店の一覧に連絡ありの相談（ID・種類・本文の先頭）が付く', i7 && i7.contact && i7.contact.consultation_id === co.data.consultation_id && i7.contact.category === 'absence' && i7.contact.excerpt.startsWith('電車遅延'), i7)
  ok('#498 本文は先頭だけ（40文字まで）', i7 && i7.contact && i7.contact.excerpt.replace('…', '').length <= 40, i7 && i7.contact)
  ok('#498 連絡のない人が上に並ぶ', i7 && i10 && ci.indexOf(i10) < ci.indexOf(i7), ci.map(x => [x.name, !!x.contact]))
  const sh = d.shifts.find(x => x.shift_id === s7)
  ok('#498 本日のシフトの行にも連絡ありが付く', sh && sh.contact && sh.contact.consultation_id === co.data.consultation_id, sh)

  // #449 同じ人の2シフト
  const p1 = await relShift(11, 'W4DT-p1', -200, -150)
  const p2 = await relShift(11, 'W4DT-p2', -120, 30)
  const px = await admin.post(`/api/admin/shifts/${p1}/proxy-attendance`, { report_types: ['wake_up'], times: { wake_up: at(-330).time } })
  ok('1つ目のシフトに起床を代理入力', px.status === 200, px)
  const d2 = await dash()
  const rows11 = d2.unreported.check_in.filter(x => x.staff_id === 11)
  ok('#449 未入店の一覧で同じ人は1行（ほかのシフトの数を添える）', rows11.length === 1 && rows11[0].other_shifts === 1, rows11)
  ok('#449 同じ日の別のシフトで起床済みなら、起床の未報告に出さない', !d2.unreported.wake_up.some(x => x.staff_id === 11), d2.unreported.wake_up.filter(x => x.staff_id === 11))
  const todayShifts = d2.shifts.filter(x => !x.carried_over)
  ok('#449 稼働予定は人数（同じ人の複数シフトは1名）とシフト数を分けて返す',
    d2.working_count === new Set(todayShifts.map(x => x.staff_id)).size && d2.working_shift_count === todayShifts.length && d2.working_shift_count > d2.working_count,
    [d2.working_count, d2.working_shift_count])
}

// ---------- #497 遅刻は入店・勤務開始のどちらかが遅れたシフトの数 ----------
{
  // 2つのシフト（それぞれ開始の30分後に入店・勤務開始を代理入力）→ 遅刻2回
  const ids = [await relShift(13, 'W4DT-l1', -300, -250), await relShift(13, 'W4DT-l2', -200, -150)]
  for (const id of ids) {
    const s = at(id === ids[0] ? -270 : -170)
    await admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: ['check_in', 'work_start'], times: { check_in: s.time, work_start: s.time } })
  }
  const d = await dash()
  const t = todoBy(d, `late:13:${month}`)
  if (at(-300).date === today) ok('#497 入店と勤務開始の両方が遅れても1シフト1回と数える（2シフトで2回）', t && t.mark === 2 && /2回遅刻/.test(t.text), d.todos.filter(x => x.key.startsWith('late:')))
  else skip('#497 遅刻の数え方', '5時間前が前日のため')
}

// ---------- #385 フォロー記録の状態・期日・ページ送り ----------
{
  const f1 = await admin.post('/api/admin/follow-logs', { staff_id: 3, follow_type: 'praise', content: `称賛${tag}` })
  ok('#385 次回対応がなければ完了で記録される', f1.status === 200 && f1.data.status === 'done', f1)
  const f2 = await admin.post('/api/admin/follow-logs', { staff_id: 3, follow_type: 'phone', content: `電話${tag}`, next_action: '体調の再確認', next_action_date: today })
  ok('#385 次回対応があれば対応中で記録される', f2.status === 200 && f2.data.status === 'open', f2)
  const bad = await admin.post('/api/admin/follow-logs', { staff_id: 3, follow_type: 'phone', content: 'x', next_action_date: '2026/01/01' })
  ok('#385 次回対応日の形式が正しくなければ 400', bad.status === 400, bad)
  const d = await dash()
  const t = todoBy(d, `follow:${f2.data.follow_id}`)
  ok('#385 期日が今日の対応中のフォローが ToDo に担当者名と出る', t && /体調の再確認/.test(t.text) && /担当: /.test(t.text) && t.follow_id === f2.data.follow_id, d.todos.filter(x => x.key.startsWith('follow:')))
  const due = await admin.get('/api/admin/follow-logs?status=open&due=1')
  ok('#385 期日が来たものの絞り込み', due.status === 200 && due.data.logs.some(f => f.follow_id === f2.data.follow_id) && due.data.logs.every(f => f.status === 'open' && f.next_action_date <= today), due.data)
  ok('#385 件数（対応中・完了・期日）とページ送りの情報を返す', due.data.counts && due.data.counts.due >= 1 && due.data.per_page === 50 && due.data.page === 1, due.data.counts)
  const q = await admin.get('/api/admin/follow-logs?q=' + encodeURIComponent('高橋'))
  ok('#385 スタッフ名で探せる', q.status === 200 && q.data.logs.length >= 2 && q.data.logs.every(f => f.staff_name.includes('高橋')), q.data.logs.map(f => f.staff_name))
  const q2 = await admin.get('/api/admin/follow-logs?q=' + encodeURIComponent('%'))
  ok('#385 検索の % は文字として扱う', q2.status === 200 && q2.data.total === 0, q2.data.total)
  const pd = await admin.put(`/api/admin/follow-logs/${f2.data.follow_id}`, { next_action_date: 'x' })
  ok('#385 PUT でも日付を確かめる', pd.status === 400, pd)
  const done = await admin.put(`/api/admin/follow-logs/${f2.data.follow_id}`, { status: 'done' })
  const d2 = await dash()
  const after = (await admin.get('/api/admin/follow-logs?status=done')).data.logs.find(f => f.follow_id === f2.data.follow_id)
  ok('#385 完了にすると ToDo から消え、完了日時が残る', done.status === 200 && !todoBy(d2, `follow:${f2.data.follow_id}`) && after && after.done_at, after)
  const nf = await admin.put('/api/admin/follow-logs/999999', { status: 'done' })
  ok('#385 ないフォロー記録は 404', nf.status === 404, nf)
}

// ---------- #412 仮登録のまま稼働している人 ----------
{
  const qk = await admin.post('/api/admin/staff-quick', { name: `仮登録${tag}`, phone: '090' + String(Date.now()).slice(-8), affiliation_type: 'daily_worker' })
  ok('仮登録を作る', qk.status === 200 && qk.data.staff_id, qk)
  const sid = qk.data.staff_id
  let d = await dash()
  ok('#412 登録したばかりで稼働のない仮登録は ToDo に出ない', !todoBy(d, `provisional:${sid}`))
  await createShift(sid, today, '00:00', '00:20', 'W4DT-pv1')
  await createShift(sid, today, '00:30', '00:50', 'W4DT-pv2')
  d = await dash()
  const t = todoBy(d, `provisional:${sid}`)
  ok('#412 仮登録のまま2回稼働したら ToDo に出る（スタッフ詳細へ）', t && /仮登録のまま/.test(t.text) && t.staff_id === sid && t.link_label === '本登録→', d.todos.filter(x => x.key.startsWith('provisional')))
}

// ---------- #314 要フォローから退職・統合済みを外す ----------
{
  const r1 = await admin.put('/api/admin/staff/12', { retention_risk: 'high' })
  let d = await dash()
  ok('（前提）離職リスク高のスタッフは要フォローに出る', r1.status === 200 && d.follow_staff.some(s => s.staff_id === 12), r1)
  if (PERSIST) {
    // 自社雇用の在籍状況は従業員管理から変えるため、ここでは D1 を直接書き換える
    sql("UPDATE staff_profiles SET employment_status = 'retired' WHERE staff_id = 12; UPDATE staff_profiles SET retention_risk = 'mid', merged_into_staff_id = 1 WHERE staff_id = 14;")
    d = await dash()
    ok('#314 退職・統合済みのスタッフは要フォローに出ない', !d.follow_staff.some(s => s.staff_id === 12 || s.staff_id === 14), d.follow_staff.map(s => s.staff_id))
  } else skip('#314 退職・統合済みのスタッフ', 'PERSIST 未指定')
}

// ---------- #456 終了日が近い繰り返し登録 / #402 #404 インシデントのリンク / #183 #184 ----------
{
  const from = addDays(today, 1), to = addDays(today, 6)
  const wd = [...new Set([0, 1, 2, 3, 4, 5, 6])]
  const pt = await admin.post('/api/admin/slot-patterns', { project_id: 1, weekdays: wd, date_from: from, date_to: to, start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売W4DT', headcount: 1 }] })
  ok('（前提）繰り返し登録を作る', pt.status === 200 && pt.data.pattern_id, pt)
  const d = await dash()
  const t = todoBy(d, `pattern_end:${pt.data.pattern_id}:${to}`)
  ok('#456 終了日が14日以内の繰り返し登録が ToDo に出る（案件詳細へ）', t && t.href === '#projects/1' && /あと6日/.test(t.text), d.todos.filter(x => x.key.startsWith('pattern_end')))
  const inc = d.todos.filter(x => x.key.startsWith('incident:'))
  if (inc.length) ok('#402 #404 インシデントの ToDo は日報一覧（案件・直近7日・インシデント）へ', inc.every(x => /^#reports\/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&project=\d+&flagged=1$/.test(x.href)), inc)
  else skip('#402 インシデントの ToDo のリンク', '直近7日のインシデントがない')
  ok('#183 未確認の日報の件数を返す', Number.isInteger(d.unchecked_daily_reports), d.unchecked_daily_reports)
  ok('#184 案件別実績は日報テンプレートの数値項目で返す', Array.isArray(d.performance_fields) && d.project_performance.every(p => p.values && typeof p.values === 'object')
    && d.performance_fields.every(f => f.key && f.label), d.performance_fields)
  if (PERSIST) {
    // 案件1の今月の日報の合計が、項目ごとの SQL の合計と一致する
    const f = d.performance_fields[0]
    if (f) {
      const row = sql(`SELECT COALESCE(SUM(json_extract(report_values, '$.${f.key.replace(/[^\w]/g, '')}')), 0) AS v FROM daily_reports WHERE company_id = 1 AND project_id = 1 AND work_date LIKE '${month}%';`)[0]
      const p1 = d.project_performance.find(p => p.project_id === 1)
      ok('#184 項目の合計が日報の値と一致する', p1 && Number(p1.values[f.key]) === Number(row.v), [p1 && p1.values, row])
    }
  }
}

const fail = results.filter(r => !r.pass).length
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
