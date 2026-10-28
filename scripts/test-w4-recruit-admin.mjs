// 公開応募フォームと管理の応募一覧（w4-recruit-admin: #211 #242 #302 #303 #309 #317 #339 #351 #395 #416 #512 #515、持ち越し #87）の統合テスト
// 起動に --var STAFF_APP_RECRUIT:1 を付ける（スタッフアプリの募集は Sprint 11 で止めた。#9411。この試験はスタッフアプリからの応募も使う。npm test は自動で付ける）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> node scripts/test-w4-recruit-admin.mjs
//   PERSIST を付けると、ローカルの D1 を直接書き換える確認（勤務日を過ぎた未対応の応募の期限切れ #302）も行う
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
let sqlSeq = 0, SQL_DIR = ''
function sql(command) {
  SQL_DIR = SQL_DIR || mkdtempSync(join(tmpdir(), 'w4ra-'))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'RA' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '070' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')
const toWide = (s) => s.replace(/[0-9]/g, d => String.fromCharCode(d.charCodeAt(0) + 0xFEE0))

const admin = client(await login('sample', 'admin'))
const pub = client(null)

async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k, phone, extra = {}) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone, ...extra }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newRoles(pid, date, start = '10:00', end = '18:00', roles = [{ role_name: '販売', headcount: 2 }]) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  const slots = b.slots.filter(s => s.project_id === pid && s.start_time === start)
  return slots[slots.length - 1]
}
async function newPage(pids, from, to, extra = {}) {
  return must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: pids, date_from: from, date_to: to, allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '', ...extra }), 'recruit page')
}
const publicApply = (token, phone, roleIds, name = `${PFX} 応募`, extra = {}) =>
  pub.post(`/api/public/recruit/${token}/apply`, { name, phone, agree: true, slot_role_ids: roleIds, issued_at: Date.now() - 10000, ...extra })
const listApps = async (params) => must(await admin.get('/api/admin/recruit-applications?' + new URLSearchParams(params)), 'apps')

const pid = await newProject(`${PFX}-案件`)
const other = await newProject(`${PFX}-対象外`)
const D = addDays(today, 5)
const page = await newPage([pid], today, addDays(today, 30), { contact_note: '採用担当 03-0000-0000' })

// ---------- #351 同意文に使う保存期間・塩の設定状態 ----------
{
  const g = must(await pub.get(`/api/public/recruit/${page.token}`), 'public get')
  ok('#351 公開ページ: 同意文に書く保存期間（180日）と会社名を返す', g.retention_days === 180 && !!g.company_name, { r: g.retention_days, c: g.company_name })
  const l = await listApps({ status: 'pending', page_id: page.page_id })
  ok('#351 応募一覧: 送信回数の制限の塩の設定状態を返す', ['set', 'turnstile', 'none'].includes(l.ip_salt), l.ip_salt)
}

// ---------- #512 全角の電話番号 / #416 入力の誤りの欄 ----------
{
  const s = await newRoles(pid, D, '09:00', '12:00')
  const phone = newPhone()
  const r = await publicApply(page.token, toWide(phone.slice(0, 3)) + '－' + toWide(phone.slice(3, 7)) + '－' + toWide(phone.slice(7)), [s.roles[0].slot_role_id], `${PFX} 全角`)
  ok('#512 全角の数字・ハイフンの電話番号で応募できる', r.status === 200 && r.data.count === 1, r)
  const app = (await listApps({ status: 'pending', page_id: page.page_id })).applications.find(a => a.name === `${PFX} 全角`)
  ok('#512 電話番号は半角の数字にそろえて保存する', app && app.phone === phone, app?.phone)
  const n1 = await publicApply(page.token, phone, [s.roles[0].slot_role_id], '')
  ok('#416 お名前がないときは field=name', n1.status === 400 && n1.data.field === 'name', n1)
  const n2 = await publicApply(page.token, '0901234', [s.roles[0].slot_role_id])
  ok('#416 #512 電話番号の桁が足りないときは field=phone と桁数の条件を返す', n2.status === 400 && n2.data.field === 'phone' && /10〜11桁/.test(n2.data.error), n2)
  const n3 = await publicApply(page.token, newPhone(), [s.roles[0].slot_role_id], `${PFX} x`, { agree: false })
  ok('#416 同意がないときは field=agree', n3.status === 400 && n3.data.field === 'agree', n3)
  const n4 = await publicApply(page.token, newPhone(), [s.roles[0].slot_role_id], `${PFX} x`, { email: 'ｂａｄ＠ｅｘａｍｐｌｅ．ｃｏｍ' })
  ok('#512 全角のメールアドレスは半角にそろえて受け付ける', n4.status === 200, n4)
}

// ---------- #242 #515 選んだ日時の一部が締め切られていたら、全体を選び直しに戻す / #317 完了画面の控え ----------
{
  const s = await newRoles(pid, addDays(D, 1), '10:00', '12:00', [{ role_name: '受付', headcount: 1 }, { role_name: '誘導', headcount: 1 }])
  const closed = await newRoles(other, addDays(D, 1), '13:00', '14:00') // 募集ページの対象外の枠（締め切られた枠の代わり）
  const phone = newPhone()
  const r = await publicApply(page.token, phone, [s.roles[0].slot_role_id, closed.roles[0].slot_role_id], `${PFX} 一部締切`)
  ok('#242 一部が締め切られていたら 409 と締め切られた日時を返す', r.status === 409 && r.data.need_reselect && r.data.closed_role_ids.includes(closed.roles[0].slot_role_id) && r.data.closed_role_ids.length === 1, r)
  ok('#515 メッセージに「再読み込み」を含めない', r.status === 409 && !/再読み込み/.test(r.data.error), r.data?.error)
  const none = (await listApps({ status: 'all', q: phone })).applications
  ok('#242 締め切りがあったときは、残りの日時だけで応募を成立させない', none.length === 0, none.length)
  const all = await publicApply(page.token, phone, [closed.roles[0].slot_role_id])
  ok('#242 すべて締め切られていても 409（選び直し）', all.status === 409 && all.data.need_reselect, all)
  // 選び直して応募する
  const ok1 = await publicApply(page.token, phone, [s.roles[0].slot_role_id], `${PFX} 一部締切`)
  const acc = ok1.data?.accepted || []
  ok('#317 受け付けた日時の控え（日付・時間・役割）と受付日時を返す', ok1.status === 200 && acc.length === 1 && acc[0].work_date === addDays(D, 1) && acc[0].start_time === '10:00' && acc[0].role_name === '受付' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ok1.data.applied_at), ok1.data)
  ok('#317 控えに金額・案件名は含めない', acc.length && !('project_name' in acc[0]) && !('unit_price' in acc[0]), acc[0])
  const again = await publicApply(page.token, phone, [s.roles[0].slot_role_id, s.roles[1].slot_role_id], `${PFX} 一部締切`)
  ok('#242 応募済みの日時は already_applied、新しい日時だけを accepted で返す', again.status === 200 && again.data.accepted.length === 1 && again.data.accepted[0].slot_role_id === s.roles[1].slot_role_id
    && again.data.already_applied.length === 1 && again.data.already_applied[0].slot_role_id === s.roles[0].slot_role_id, again.data)
}

// ---------- #339 氏名・電話番号の検索、件数とページ送り / #309 電話番号の一致をまとめて照合 ----------
{
  const s = await newRoles(pid, addDays(D, 2), '10:00', '12:00', [{ role_name: '販売', headcount: 10 }])
  const phones = [newPhone(), newPhone(), newPhone()]
  const staff = await newStaff('M309', phones[0])
  for (let i = 0; i < 3; i++) must(await publicApply(page.token, phones[i], [s.roles[0].slot_role_id], `${PFX} 検索 太郎${i}`), 'apply ' + i)
  const byName = await listApps({ status: 'pending', q: `${PFX}検索太郎1` })
  ok('#339 氏名で探せる（空白を無視）', byName.total === 1 && byName.applications[0].name === `${PFX} 検索 太郎1`, byName.applications.map(a => a.name))
  const byPhone = await listApps({ status: 'all', q: phones[2].slice(3, 9) })
  ok('#339 電話番号の一部で探せる', byPhone.applications.some(a => a.phone === phones[2]) && byPhone.applications.every(a => a.phone.includes(phones[2].slice(3, 9))), byPhone.applications.map(a => a.phone))
  const byWide = await listApps({ status: 'all', q: toWide(phones[2].slice(3, 9)) })
  ok('#339 #512 全角の数字でも電話番号で探せる', byWide.applications.some(a => a.phone === phones[2]), byWide.total)
  const p1 = await listApps({ status: 'pending', q: `${PFX} 検索` })
  ok('#339 件数（total）を返す', p1.total === 3 && p1.applications.length === 3 && p1.next_offset === null, { t: p1.total, n: p1.applications.length })
  const p2 = await listApps({ status: 'pending', q: `${PFX} 検索`, offset: 2 })
  ok('#339 offset で続きを取得できる', p2.applications.length === 1 && p2.offset === 2 && p2.applications[0].application_id === p1.applications[2].application_id, p2.applications.map(a => a.application_id))
  ok('#339 絞り込みの選択肢に募集ページを返す', Array.isArray(p1.pages) && p1.pages.some(p => p.page_id === page.page_id))
  const m = p1.applications.find(a => a.phone === phones[0])
  ok('#309 電話番号が一致するスタッフをまとめて照合しても正しく返す', m && m.phone_matches.length === 1 && m.phone_matches[0].staff_id === staff.staff_id && p1.applications.filter(a => a.phone !== phones[0]).every(a => a.phone_matches.length === 0), p1.applications.map(a => a.phone_matches))
  const dated = await listApps({ status: 'pending', q: `${PFX} 検索`, from: addDays(D, 3), to: addDays(D, 9) })
  ok('#339 勤務日で絞り込める', dated.total === 0, dated.total)
}

// ---------- #303 枠で絞り込んだ一覧、定員に達した枠の残りをまとめて見送る ----------
let fullSlot = null
{
  const s = await newRoles(pid, addDays(D, 3), '10:00', '12:00', [{ role_name: '案内', headcount: 1 }])
  const rid = s.roles[0].slot_role_id
  fullSlot = rid
  const ph = [newPhone(), newPhone(), newPhone()]
  for (let i = 0; i < 3; i++) must(await publicApply(page.token, ph[i], [rid], `${PFX} 枠${i}`), 'apply slot ' + i)
  const other1 = await newRoles(pid, addDays(D, 3), '13:00', '15:00')
  must(await publicApply(page.token, newPhone(), [other1.roles[0].slot_role_id], `${PFX} 別の枠`), 'apply other')
  const l = await listApps({ status: 'pending', slot_role_id: rid })
  ok('#303 枠で絞り込むと、その枠の応募だけを返す', l.total === 3 && l.applications.every(a => a.items.some(i => i.slot_role_id === rid)), l.applications.map(a => a.name))
  ok('#303 絞り込んだ枠の充足と未対応の件数を返す', l.slot && l.slot.slot_role_id === rid && l.slot.pending === 3 && l.slot.headcount === 1 && l.slot.full === false, l.slot)
  const first = l.applications[0]
  const dec = must(await admin.post(`/api/admin/recruit-applications/${first.application_id}/decide`, { approve: first.items.map(i => i.item_id), new_staff_type: 'daily_worker', force_new: true, force: true }), 'decide')
  ok('#303 承認で定員に達した枠に残りの未対応があれば filled_slots で知らせる', dec.filled_slots && dec.filled_slots.length === 1 && dec.filled_slots[0].slot_role_id === rid && dec.filled_slots[0].pending === 2, dec)
  const rj = must(await admin.post(`/api/admin/recruit-slots/${rid}/reject-pending`), 'reject pending')
  ok('#303 枠の残りの未対応をまとめて見送る', rj.rejected === 2, rj)
  const after = await listApps({ status: 'pending', slot_role_id: rid })
  ok('#303 まとめて見送ると、その枠の未対応はなくなる', after.total === 0 && after.slot.pending === 0, after.total)
  const otherStill = await listApps({ status: 'pending', q: `${PFX} 別の枠` })
  ok('#303 ほかの枠の応募はそのまま', otherStill.total === 1, otherStill.total)
  const forbidden = await admin.post('/api/admin/recruit-slots/99999999/reject-pending')
  ok('#303 存在しない枠は 404', forbidden.status === 404, forbidden)
}

// ---------- #211 見送りにした応募を繰り上げて承認 ----------
{
  const w = await listApps({ status: 'waitlist', slot_role_id: fullSlot })
  ok('#211 キャンセル待ち（見送り済み・勤務日前）で絞り込める', w.total === 2 && w.applications.every(a => a.items.some(i => i.status === 'rejected')), w.applications.map(a => a.items.map(i => i.status)))
  // 確定したシフトを欠勤にして枠を空ける → 見送った人を繰り上げる
  const shifts = must(await admin.get(`/api/admin/shifts?from=${addDays(D, 3)}&to=${addDays(D, 3)}`), 'shifts').shifts.filter(x => x.slot_role_id === fullSlot)
  must(await admin.del(`/api/admin/shifts/${shifts[0].shift_id}`), 'delete shift')
  const target = w.applications[0]
  const item = target.items.find(i => i.status === 'rejected')
  const pr = await admin.post(`/api/admin/recruit-applications/${target.application_id}/decide`, { approve: [item.item_id], new_staff_type: 'daily_worker', force_new: true, force: true })
  ok('#211 見送りにした日時を繰り上げて承認できる', pr.status === 200 && pr.data.created_shifts === 1 && pr.data.promoted === 1, pr)
  const after = (await listApps({ status: 'all', q: target.phone })).applications[0]
  ok('#211 繰り上げた日時は承認になり、スタッフに紐づく', after.items.find(i => i.item_id === item.item_id)?.status === 'approved' && !!after.staff_id, after.items)
  const second = await admin.post(`/api/admin/recruit-applications/${target.application_id}/decide`, { approve: [item.item_id], force: true })
  ok('#211 承認済みの日時をもう一度承認すると 409', second.status === 409, second)
  const rej = await admin.post(`/api/admin/recruit-applications/${target.application_id}/decide`, { reject: [item.item_id] })
  ok('#211 承認済みの日時は見送りにできない（409）', rej.status === 409, rej)
  // 定員を超える繰り上げは、今までどおり警告を出す
  const other = w.applications[1]
  const it2 = other.items.find(i => i.status === 'rejected')
  const warn = await admin.post(`/api/admin/recruit-applications/${other.application_id}/decide`, { approve: [it2.item_id], new_staff_type: 'daily_worker', force_new: true })
  ok('#211 定員を超える繰り上げは警告（need_force）', warn.status === 409 && warn.data.need_force && warn.data.warnings.some(x => /定員/.test(x)), warn)
}

// ---------- #395 電話番号が一致しない既存スタッフを探して紐づける ----------
{
  const st = await newStaff('K395', newPhone())
  const s = await newRoles(pid, addDays(D, 4), '10:00', '12:00')
  must(await publicApply(page.token, newPhone(), [s.roles[0].slot_role_id], `${PFX} K395`), 'apply 395')
  const app = (await listApps({ status: 'pending', q: `${PFX} K395` })).applications[0]
  ok('#395 電話番号が違うので phone_matches は空', app && app.phone_matches.length === 0, app?.phone_matches)
  const c0 = must(await admin.get(`/api/admin/recruit-applications/${app.application_id}/staff-candidates`), 'cands')
  ok('#395 検索語なしでも、氏名が一致するスタッフを候補に出す', c0.candidates.some(m => m.staff_id === st.staff_id && m.name_match), c0.candidates)
  const c1 = must(await admin.get(`/api/admin/recruit-applications/${app.application_id}/staff-candidates?q=${encodeURIComponent(`${PFX}K395`)}`), 'cands q')
  ok('#395 スタッフ番号で探せる', c1.candidates.some(m => m.staff_id === st.staff_id), c1.candidates)
  const dec = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), staff_id: st.staff_id, force: true }), 'decide link')
  ok('#395 選んだ既存スタッフに紐づけて承認できる（仮登録を作らない）', dec.staff_id === st.staff_id && !dec.created_staff && dec.created_shifts === 1, dec)
  const other = await client(await login('sample', 'admin')).get('/api/admin/recruit-applications/99999999/staff-candidates')
  ok('#395 ほかの応募IDは 404', other.status === 404, other.status)
}

// ---------- 持ち越し #87 退職したスタッフの未対応の応募は件数に数えない ----------
{
  const st = await newStaff('R87')
  const sc = client(await login('sample', `${PFX}R87`))
  const s = await newRoles(pid, addDays(D, 6), '10:00', '12:00')
  must(await sc.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [s.roles[0].slot_role_id] }), 'staff apply')
  const before = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary')
  must(await admin.put(`/api/admin/employees/${st.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } }), 'retire')
  const after = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary 2')
  // w7-followup-server-a（#87 の残り）: 退職したスタッフの未対応の応募は、取り下げ（cancelled）にする
  ok('#87 退職したスタッフの応募は未対応の件数から外す', after.pending === before.pending - 1 && after.pending_inactive === (before.pending_inactive || 0), { before, after })
  const l = (await listApps({ status: 'cancelled', q: `${PFX} R87` })).applications
  ok('#87 退職したスタッフの未対応の応募は取り下げ（cancelled）になる', l.length === 1 && l[0].items.every(i => i.status === 'cancelled'), l)
}

// ---------- #302 勤務日を過ぎた未対応は期限切れにして件数から外す ----------
if (PERSIST) {
  const s = await newRoles(pid, addDays(D, 7), '10:00', '12:00')
  const s2 = await newRoles(pid, addDays(D, 7), '13:00', '14:00')
  const phone = newPhone(), phone2 = newPhone()
  must(await publicApply(page.token, phone, [s.roles[0].slot_role_id], `${PFX} 期限切れ`), 'apply past')
  must(await publicApply(page.token, phone2, [s.roles[0].slot_role_id, s2.roles[0].slot_role_id], `${PFX} 一部期限切れ`), 'apply past 2')
  const before = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary').pending
  sql(`UPDATE shift_slots SET work_date = '${addDays(today, -1)}' WHERE slot_id = ${s.slot_id}`)
  const after = must(await admin.get('/api/admin/recruit-applications/summary'), 'summary 2').pending
  ok('#302 勤務日を過ぎた未対応の日時だけの応募は、未対応の件数から外れる', after === before - 1, { before, after })
  const a1 = (await listApps({ status: 'done', q: phone })).applications[0]
  ok('#302 その応募は対応済みになり、日時は期限切れ（expired）', a1 && a1.items[0].status === 'expired', a1?.items)
  const a2 = (await listApps({ status: 'pending', q: phone2 })).applications[0]
  ok('#302 ほかの日時が残っている応募は未対応のまま（過ぎた日時だけ期限切れ）', a2 && a2.items.find(i => i.slot_role_id === s.roles[0].slot_role_id)?.status === 'expired'
    && a2.items.find(i => i.slot_role_id === s2.roles[0].slot_role_id)?.status === 'pending', a2?.items)
  const st = must(await admin.get(`/api/admin/shift-board?from=${addDays(today, -1)}&to=${addDays(today, -1)}`), 'board')
  const role = st.slots.find(x => x.slot_id === s.slot_id)?.roles?.[0]
  ok('#302 シフトボードの「応募n」からも外れる', role && !role.applicants, role?.applicants)
} else console.log('SKIP  #302 勤務日を過ぎた未対応の期限切れ（PERSIST 未指定）')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
