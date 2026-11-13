// w18-staff-reports（利用者の依頼 11/8。#9918 #9919）の統合テスト
//  - #9918 出勤可能日の提出（する／しない）を、スタッフマスタの新規登録（POST /admin/roster・POST /admin/staff）と
//          基本情報の編集（PUT /admin/staff/:id の availability_target）でも設定できる。既定は する。
//          設定は staff_profiles.availability_exempt（Sprint 17 #9907 の列）に入り、一覧・出勤可能日の画面・提出のお願いの通知に効く。
//          画面の呼び方は「出勤可能日の提出（する／しない）」にそろえる
//  - #9919 日報一覧の「未提出」をカードにし、提出済みの日報のカードと同じ見出し（日付・スタッフ・案件・開催場所・時間）にする。
//          そのため一覧・未提出の API が開催場所（site_name）とシフトの時間を返す
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8920 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8920 node scripts/test-w18-staff-reports.mjs
import { readFileSync } from 'fs'
const BASE = process.env.BASE || 'http://127.0.0.1:8920'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
async function login(company_code, user_code, password = 'pass1234') {
  const send = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await send().catch(async () => { await new Promise(res => setTimeout(res, 1000)); return send() })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const addMonths = (m, n) => { const [y, mm] = m.split('-').map(Number); const t = y * 12 + mm - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}` }
const thisMonth = today.slice(0, 7)
const PFX = 'W18' + Date.now().toString(36).slice(-5).toUpperCase()

const admin = client(await login('sample', 'admin'))
const exemptOf = async (sid) => Number(must(await admin.get('/api/admin/staff/' + sid), 'staff ' + sid).profile.availability_exempt)
const nextCode = async () => must(await admin.get('/api/admin/roster/next-code'), 'next-code').code

// ---------- #9918 新規登録（スタッフマスタ: POST /admin/roster） ----------
const gender = 'male'
const r1 = await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} しない`, gender, user_code: await nextCode(), password: 'Passw0rd!' + PFX, availability_target: false, force: true })
ok('#9918 自社雇用を「出勤可能日の提出 しない」で登録できる', r1.status === 200 && r1.data.staff_id, r1)
const S_OFF = r1.data && r1.data.staff_id
ok('#9918 「しない」で登録した人は availability_exempt = 1', await exemptOf(S_OFF) === 1)
const r2 = await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 既定`, gender, new_partner_name: `${PFX}協力会社`, force: true })
ok('#9918 送らなければ既定の「する」（availability_exempt = 0）', r2.status === 200 && await exemptOf(r2.data.staff_id) === 0, r2)
const r3 = await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} する`, gender, new_partner_name: `${PFX}協力会社2`, availability_target: true, force: true })
ok('#9918 「する」で登録できる', r3.status === 200 && await exemptOf(r3.data.staff_id) === 0, r3)
const r4 = await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 不正`, gender, new_partner_name: `${PFX}協力会社3`, availability_target: 'no', force: true })
ok('#9918 する／しない以外の値は 400（登録しない）', r4.status === 400 && /出勤可能日の提出/.test(r4.data.error || ''), r4)
const r5 = await admin.post('/api/admin/roster', { route: 'skillsheet', name: `${PFX} スキル`, gender, availability_target: false, force: true })
ok('#9918 ④スキルシートのみは出勤可能日を集めないので「しない」を送っても保存しない', r5.status === 200 && await exemptOf(r5.data.staff_id) === 0, r5)
// 旧来の登録（POST /admin/staff）
const r6 = await admin.post('/api/admin/staff', { user_code: await nextCode(), name: `${PFX} 旧登録`, password: 'Passw0rd!' + PFX, availability_target: false, force: true })
ok('#9918 POST /admin/staff でも「しない」で登録できる', r6.status === 200, r6)
const list0 = must(await admin.get('/api/admin/staff'), 'staff list').staff
const old = list0.find(s => s.name === `${PFX} 旧登録`)
ok('#9918 スタッフ一覧に「しない」の印（availability_exempt = 1）が出る', old && Number(old.availability_exempt) === 1 && Number(list0.find(s => s.staff_id === S_OFF).availability_exempt) === 1, old)
const r7 = await admin.post('/api/admin/staff', { user_code: await nextCode(), name: `${PFX} 旧不正`, password: 'Passw0rd!' + PFX, availability_target: 1, force: true })
ok('#9918 POST /admin/staff でも、する／しない以外の値は 400', r7.status === 400, r7)

// ---------- #9918 基本情報の編集（PUT /admin/staff/:id） ----------
const S_EX = 3, S_IN = 4 // st003・st004（自社雇用）
await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX, S_IN], target: true }) // 前回の実行の残りを戻す
const p1 = await admin.put('/api/admin/staff/' + S_EX, { availability_target: false })
ok('#9918 自社雇用の人も基本情報の保存で「しない」にできる（従業員管理に回されない）', p1.status === 200 && await exemptOf(S_EX) === 1, p1)
const p2 = await admin.put('/api/admin/staff/' + S_EX, { memo: `${PFX} メモ` })
ok('#9918 availability_target を送らない保存では変わらない', p2.status === 200 && await exemptOf(S_EX) === 1, p2)
const p3 = await admin.put('/api/admin/staff/' + S_EX, { availability_target: 'x' })
ok('#9918 基本情報の保存でも、する／しない以外の値は 400', p3.status === 400 && await exemptOf(S_EX) === 1, p3)
const p4 = await admin.put('/api/admin/staff/' + S_OFF, { availability_target: true, memo: `${PFX} 戻す` })
ok('#9918 ほかの項目と一緒に「する」に戻せる', p4.status === 200 && await exemptOf(S_OFF) === 0, p4)
// 他社連携の行（所属元が基本項目を持つ）でも、自社の行の設定として変えられる
const linked = list0.find(s => s.affiliation_type === 'linked_external' && !s.merged_into_staff_id)
if (linked) {
  const pl = await admin.put('/api/admin/staff/' + linked.staff_id, { availability_target: false })
  ok('#9918 他社連携のスタッフも「しない」にできる', pl.status === 200 && await exemptOf(linked.staff_id) === 1, pl)
  await admin.put('/api/admin/staff/' + linked.staff_id, { availability_target: true })
} else console.log('SKIP  他社連携のスタッフがいないため、他社連携の行の確認は省きます')
// まとめての切り替え（PUT /admin/availability/targets）のメッセージ
const tb = await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX] })
ok('#9918 まとめての切り替えのエラーも「出勤可能日の提出」の呼び方', tb.status === 400 && /出勤可能日の提出/.test(tb.data.error || '') && !/対象外/.test(tb.data.error || ''), tb)

// ---------- #9918 出勤可能日の画面・スタッフアプリ・提出のお願いの通知に効く ----------
// 同じ DB で流し直せるよう、まだ通知していない月を後ろから選ぶ（w17-shift-collect は前から選ぶ）
let month = null
for (const m of [3, 2, 1].map(n => addMonths(thisMonth, n))) {
  const a = (await admin.get('/api/admin/availability?month=' + m)).data
  if (a.staff && !a.last_reminded_at && [S_EX, S_IN].every(id => a.staff.some(x => x.staff_id === id && !x.submitted_at))) { month = m; break }
}
if (!month) ok('通知の確認に使える月がある（DB を作り直してください）', false)
else {
  const a1 = must(await admin.get('/api/admin/availability?month=' + month), 'availability')
  ok('#9918 基本情報で「しない」にした人は、出勤可能日の一覧で exempt: true', a1.staff.find(s => s.staff_id === S_EX)?.exempt === true && a1.staff.find(s => s.staff_id === S_IN)?.exempt === false)
  const nw = a1.staff.find(s => s.staff_id === S_OFF)
  ok('#9918 新規登録で決めた設定が出勤可能日の一覧に出る（「する」に戻した人は exempt: false）', nw && nw.exempt === false, nw)
  const st3 = client(await login('sample', 'st003'))
  const st4 = client(await login('sample', 'st004'))
  const g3 = must(await st3.get('/api/staff/availability?month=' + month), 'st003 availability')
  ok('#9918 「しない」の人のアプリには target: false（未提出の案内を出さない）', g3.target === false)
  const rm = await admin.post('/api/admin/availability/remind', { month })
  ok('#9918 提出のお願いを送れる', rm.status === 200, rm)
  const n3 = (await st3.get('/api/staff/notifications')).data
  const n4 = (await st4.get('/api/staff/notifications')).data
  const has = (n) => ((n && (n.notifications || n.items)) || (Array.isArray(n) ? n : [])).some(x => x.kind === 'availability_request' && x.link === '#availability/' + month)
  ok('#9918 「しない」の人には提出のお願いの通知が届かない', !has(n3), n3)
  ok('#9918 「する」の人には届く', has(n4), n4)
}
await admin.put('/api/admin/staff/' + S_EX, { availability_target: true })
ok('#9918 基本情報で「する」に戻せる', await exemptOf(S_EX) === 0)
// 後片付け: このテストで「しない」にした人を「する」に戻す（w17-shift-collect は全員が既定の「する」であることを確かめるため）
const madeOff = [S_OFF, old && old.staff_id].filter(Boolean)
await admin.put('/api/admin/availability/targets', { staff_ids: madeOff, target: true })

// ---------- #9919 日報一覧の未提出のカード（開催場所・時間） ----------
const projects = must(await admin.get('/api/admin/daily-reports?limit=1&options=1'), 'options').options.projects
const proj = projects.find(p => p.status === 'active') || projects[0]
// 昨日より前の、ほかのテストと重ならない日（30〜59日前）に、開催場所（自由入力の場所）付きの確定シフトを作る
const day = addDays(today, -(30 + (Date.now() % 30)))
const place = `${PFX} 会場`
const sh = await admin.post('/api/admin/shifts', { staff_id: S_IN, project_id: proj.project_id, work_date: day, start_time: '10:00', end_time: '18:30', status: 'confirmed', location: place, notify: false })
ok('#9919 準備: 過去の日に確定シフトを作れる', sh.status === 200, sh)
const miss = must(await admin.get(`/api/admin/daily-reports/missing?from=${day}&to=${day}&staff_id=${S_IN}&project_id=${proj.project_id}`), 'missing')
const mrow = (miss.missing || []).find(r => r.start_time && String(r.start_time).startsWith('10:00'))
if (!mrow) console.log('SKIP  この案件は日報が「不要」のため、未提出に出ません（開催場所の確認を省きます）', miss.missing)
else ok('#9919 未提出の API が開催場所（site_name）と時間を返す', mrow.site_name === place && String(mrow.end_time).startsWith('18:30'), mrow)
const dr = must(await admin.get('/api/admin/daily-reports?limit=100'), 'daily reports').reports
ok('#9919 日報の一覧が site_name・shift_start_time・shift_end_time を返す（カードの見出しに出す）', dr.length > 0 && dr.every(r => 'site_name' in r && 'shift_start_time' in r && 'shift_end_time' in r), dr[0])
const withShift = dr.find(r => r.shift_id)
if (withShift) ok('#9919 シフトのある日報はシフトの時間を返す', !!withShift.shift_start_time && !!withShift.shift_end_time, withShift)
const noShift = dr.find(r => !r.shift_id)
if (noShift) ok('#9919 シフトの無い日報は時間・開催場所が空（null）', noShift.shift_start_time == null && noShift.site_name == null, noShift)

// ---------- 画面のコード（文言・つなぎ込み） ----------
const adminJs = readFileSync(new URL('../public/static/admin.js', import.meta.url), 'utf8')
const lifeJs = readFileSync(new URL('../public/static/staff-lifecycle.js', import.meta.url), 'utf8')
const rosterJs = readFileSync(new URL('../public/static/roster.js', import.meta.url), 'utf8')
// コメントを除いた画面の文言だけを見る（行の // 以降を落とす。URL の // は対象の文言に無い）
const code = (s) => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')
ok('#9918 画面の文言に「シフト希望の回収」「回収の対象」が残っていない（admin.js・staff-lifecycle.js）', !/シフト希望の回収|回収の対象|シフト希望（出勤可能日）の回収/.test(code(adminJs) + code(lifeJs)))
ok('#9918 スタッフ詳細の行・一覧の印・絞り込みが「出勤可能日の提出」', lifeJs.includes('>出勤可能日の提出</dt>') && adminJs.includes('出勤可能日 提出しない') && adminJs.includes("['avexempt', '出勤可能日の提出 しない']"))
ok('#9918 基本情報の欄（表示・編集）と保存（変えたときだけ availability_target を送る）', adminJs.includes('function staffAvTargetFieldHtml') && adminJs.includes('${staffAvTargetFieldHtml(p, editing)}') && /avIn\.value !== avIn\.dataset\.orig\) body\.availability_target/.test(adminJs))
ok('#9918 新規登録のフォームに「する／しない」（既定は する）があり、送信に入る', rosterJs.includes('name="rf-av-target" value="1" class="w-4 h-4" checked') && rosterJs.includes('body.availability_target = avTarget.value === \'1\''))
ok('#9918 スタッフ詳細の行と基本情報の表示を、どちらで変えても合わせる', lifeJs.includes('staffAvTargetChanged(el.dataset.id, !target)') && adminJs.includes('redrawStaffAvTargetRow(sid, !body.availability_target)'))
ok('#9919 未提出は表ではなくカードで、提出済みと同じ見出しの部品を使う', !adminJs.includes('missing-report-table') && /function missingReportCardHtml[\s\S]{0,900}reportCardHeadHtml\(/.test(adminJs) && /function reportCardHtml[\s\S]{0,1600}reportCardHeadHtml\(/.test(adminJs))
ok('#9919 未提出のカードの代理入力は「実績を修正」と同じ位置・見た目（日報の内容の行の右）', /日報の内容<\/span>\s*<button type="button" class="btn btn-outline text-xs py-1 px-2\.5 ml-auto text-primary-700 border-primary-200" data-action="missingReportOpen"/.test(adminJs))

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
