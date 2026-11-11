// w24-security（#9969 セキュリティの仕上げ）の統合テスト
//   (1) 報告用URLのトークンはハッシュで保存して照合する。0105 より前の平文の行も、古いリンクのまま開ける（開いた後・API で扱った後は DB に平文がない）
//       発行済みのURLは返さない（発行し直す）。まとめての発行・予定確認URLのページの報告用URLも平文を保存しない
//   (2) プッシュ購読: 同じ endpoint が他社の利用者の購読なら、付け替えずに消してから新しく登録する
//   (3) 同じ人の確認: 他社連携のスタッフの電話番号（共有しない項目）は照合に使わない
//   (4) 繰り返し登録の削除: 「今日」はサーバーの日付（?today= は使わない）
//   (5) 使わない API（スタッフの写真の取得・スタッフの read-related・本部の企業の利用者一覧）は 404。打刻の応答に写真のキーを入れない
//   (6) 静的ファイル（/static/*・manifest）にも nosniff と CSP。axios は 1.21.0（SRI 付き）、CSP の jsDelivr は読むファイルのパスだけ
//   (7) 従業員管理の人材担当者（hr_staff_user_id）は自社の利用者だけ
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9031 --persist-to <保存先> で起動していること（本番には接続しない）。
//   (1) の「API で扱った後に平文がない」は、起動し直したサーバーで最初に流したときだけ確かめられる（移し終えたかを Worker が覚えるため）
// 実行: BASE=http://127.0.0.1:9031 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w24-security.mjs
//   PERSIST はローカルの D1 を直接読み書きするのに使う（wrangler d1 execute は --local のみ）
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:9031'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST がないため）`)
// ローカルの D1 を wrangler d1 execute で直接読んだ直後は、開発サーバーの接続が切れることがあるので1回だけ送り直す
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts) } catch (e) { return fetch(url, opts) }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetchRetry(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const pub = {
  get: async (token, sub = '') => { const r = await fetchRetry(`${BASE}/api/public/report/${token}${sub}`); return { status: r.status, data: await r.json().catch(() => null) } },
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1)
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w24sec-'))
let sqlSeq = 0
// ローカルの D1 で SQL を実行し、最後の文の結果の行を返す
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const j = JSON.parse(out)
      return j[j.length - 1].results
    } catch (e) { if (i >= 3) throw e }
  }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const PFX = 'W24S' + Date.now().toString(36).slice(-4).toUpperCase()
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}案件`, location: '新宿店', allow_duplicate: true }), 'project').project_id
const quick = async (name) => must(await admin.post('/api/admin/staff-quick', { name, phone: phoneOf(), affiliation_type: 'daily_worker', force: true }), 'staff-quick').staff_id
async function createShift(staff_id, work_date, start_time = '09:00', end_time = '18:00') {
  const memo = `${PFX}-${++seq}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id: P, work_date, start_time, end_time, memo, force: true }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}

// ---------- (1) 報告用URLのトークンのハッシュ化 ----------
const NA = await quick(`仮 一郎${PFX}`)
const NB = await quick(`仮 二郎${PFX}`)
const L1 = await createShift(NA, today), L2 = await createShift(NB, today)
const legacy1 = `w24legacy${PFX}aaaaaaaaaaaaaaaaaaaa`.slice(0, 32), legacy2 = `w24legacy${PFX}bbbbbbbbbbbbbbbbbbbb`.slice(0, 32)
if (PERSIST) {
  // 0105 より前に発行した行（token が平文、token_hash は NULL）を入れる
  sql(`INSERT INTO shift_report_tokens (token, shift_id, company_id, staff_id, expires_at, created_by) VALUES
    (${q(legacy1)}, ${L1}, 1, ${NA}, '${addDays(today, 1)} 23:59:59', 1), (${q(legacy2)}, ${L2}, 1, ${NB}, '${addDays(today, 1)} 23:59:59', 1)`)
  // 報告用URLを扱う API（報告パネル）を使うと、平文の行をハッシュへ移す
  const st = must(await admin.get(`/api/admin/shifts/${L1}/report-status`), 'report-status L1')
  ok('#9969 報告パネルは発行済みと分かるが、トークンそのものは返さない', st.token && st.token.ref === sha256(legacy1).slice(0, 12) && !('token' in st.token), st.token)
  const rows = sql(`SELECT token, token_hash FROM shift_report_tokens WHERE shift_id IN (${L1}, ${L2})`)
  ok('#9969 報告用URLを扱う API の後は、古い行も平文が残らず、ハッシュで持つ（起動し直したサーバーで最初に流したとき）',
    rows.length === 2 && rows.every(r => r.token_hash && r.token === r.token_hash) && !rows.some(r => r.token === legacy1 || r.token === legacy2), rows)
  const v1 = await pub.get(legacy1)
  ok('#9969 0105 より前に配った報告用URL（古いリンク）をそのまま開ける', v1.status === 200 && v1.data.kind === 'shift', v1)
  const c1 = await pub.get(legacy1, '/contact')
  ok('#9969 古いリンクの連絡先も返す', c1.status === 200 && c1.data.company_name, c1)
  // API を通らずに残った平文の行（移す前に開いたとき）も、開いたときにハッシュへ移す
  sql(`UPDATE shift_report_tokens SET token = ${q(legacy2)}, token_hash = NULL WHERE shift_id = ${L2}`)
  const v2 = await pub.get(legacy2)
  const r2 = sql(`SELECT token, token_hash FROM shift_report_tokens WHERE shift_id = ${L2}`)
  ok('#9969 平文の行は、開いたときにハッシュへ移す（開ける・平文が残らない）', v2.status === 200 && r2.length === 1 && r2[0].token === sha256(legacy2) && r2[0].token_hash === sha256(legacy2), { v2: v2.status, r2 })
  ok('#9969 移した後も同じURLで開ける', (await pub.get(legacy2)).status === 200)
  ok('#9969 ハッシュの値そのものをURLにしても開けない', (await pub.get(sha256(legacy2))).status === 404)
} else { skip('#9969 古いリンク（平文の行）') }

{
  const S = await createShift(NA, yesterday)
  const r = await admin.post(`/api/admin/shifts/${S}/report-link`, {})
  ok('#9969 発行した応答で URL を返す', r.status === 200 && typeof r.data.token === 'string' && r.data.token.length >= 20 && r.data.ref === sha256(r.data.token).slice(0, 12), r)
  const tok = r.data.token
  ok('#9969 発行した報告用URLで開ける', (await pub.get(tok)).status === 200)
  if (PERSIST) {
    const rows = sql(`SELECT token, token_hash FROM shift_report_tokens WHERE shift_id = ${S}`)
    ok('#9969 DB にはハッシュだけを保存する（平文がない）', rows.length === 1 && rows[0].token_hash === sha256(tok) && rows[0].token === sha256(tok), rows)
  } else skip('#9969 DB の値')
  const again = await admin.post(`/api/admin/shifts/${S}/report-link`, {})
  ok('#9969 発行済みのときは URL を返さず 409（発行し直しを案内する）', again.status === 409 && again.data.code === 'already_issued' && !again.data.token && !again.text.includes(tok) && /発行し直す/.test(again.data.error), again)
  const st = must(await admin.get(`/api/admin/shifts/${S}/report-status`), 'status')
  ok('#9969 報告パネルの ref は発行した応答の ref と同じ（画面で覚えたURLを見分ける）', st.token && st.token.ref === r.data.ref && !JSON.stringify(st).includes(tok), st.token)
  const re = await admin.post(`/api/admin/shifts/${S}/report-link`, { regenerate: true })
  ok('#9969 発行し直すと新しい URL を返し、前の URL は使えない', re.status === 200 && re.data.token && re.data.token !== tok && (await pub.get(re.data.token)).status === 200 && (await pub.get(tok)).status === 404, re)
  const inv = await pub.get(tok)
  ok('#163 無効にした URL の画面にも会社名を返す（ハッシュで照合）', inv.status === 404 && inv.data && inv.data.company_name, inv)
  const ct = await pub.get(re.data.token, '/contact')
  ok('#173 新しい URL の連絡先を返す', ct.status === 200 && ct.data.company_name, ct)
}

// まとめての発行
{
  const D = addDays(today, 1)
  const SA = await createShift(NA, D), SB = await createShift(NB, D)
  const g = must(await admin.get(`/api/admin/report-links/bulk?date=${D}&project_id=${P}`), 'bulk get')
  ok('（前提）まとめての画面に対象のシフトが出る（未発行）', [SA, SB].every(id => g.rows.some(r => r.shift_id === id && !r.issued && !r.token)), g.rows)
  const p = must(await admin.post('/api/admin/report-links/bulk', { date: D, project_id: P }), 'bulk post')
  const ra = p.rows.find(r => r.shift_id === SA)
  ok('#9969 まとめて発行した応答でだけ URL を返す', p.issued === 2 && ra && ra.issued && ra.token && ra.ref === sha256(ra.token).slice(0, 12), p.rows)
  ok('#9969 まとめて発行した URL で開ける', (await pub.get(ra.token)).status === 200)
  const g2 = must(await admin.get(`/api/admin/report-links/bulk?date=${D}&project_id=${P}`), 'bulk get 2')
  ok('#9969 一覧を開き直すと発行済みと分かるが、URL は返さない', g2.rows.filter(r => [SA, SB].includes(r.shift_id)).every(r => r.issued && !r.token && r.ref) && !JSON.stringify(g2).includes(ra.token), g2.rows)
  if (PERSIST) {
    const rows = sql(`SELECT token, token_hash FROM shift_report_tokens WHERE shift_id IN (${SA}, ${SB})`)
    ok('#9969 まとめての発行も DB に平文を保存しない', rows.length === 2 && rows.every(r => r.token_hash && r.token === r.token_hash) && rows.some(r => r.token_hash === sha256(ra.token)), rows)
  } else skip('#9969 まとめての発行の DB の値')
}

// 予定確認URLのページの報告用URL
{
  const NC = await quick(`仮 三郎${PFX}`)
  const SN = await createShift(NC, today, '10:00', '19:00')
  const issued = must(await admin.post(`/api/admin/shifts/${SN}/report-link`, {}), 'issue SN').token
  const link = must(await admin.post(`/api/admin/staff/${NC}/schedule-link`, {}), 'schedule link').token
  const v = await pub.get(link)
  const row = v.data && v.data.shifts ? v.data.shifts.find(s => s.shift_id === SN) : null
  ok('#442 予定確認URLのページに、今日のシフトの報告用URLの入口を付ける', v.status === 200 && v.data.kind === 'schedule' && row && row.report_token, v.data)
  const t1 = row && row.report_token
  ok('#9969 入口の報告用URLは、管理者が発行した URL とは別（平文を持たないため）で、開ける', t1 && t1 !== issued && (await pub.get(t1)).status === 200)
  ok('#9969 管理者が発行した URL も引き続き使える', (await pub.get(issued)).status === 200)
  const v2 = await pub.get(link)
  ok('#9969 予定確認URLのページを開き直しても同じ入口の URL（行を増やさない）', v2.data.shifts.find(s => s.shift_id === SN).report_token === t1, v2.data.shifts)
  const st = must(await admin.get(`/api/admin/shifts/${SN}/report-status`), 'status SN')
  ok('#9969 報告パネルは管理者が発行した URL の ref を出す（ページ用の URL で上書きしない）', st.token && st.token.ref === sha256(issued).slice(0, 12), st.token)
  if (PERSIST) {
    const rows = sql(`SELECT token, token_hash, created_by FROM shift_report_tokens WHERE shift_id = ${SN}`)
    ok('#9969 ページ用の URL も DB にハッシュだけを保存する（2行: 管理者の発行・ページ用）', rows.length === 2 && rows.every(r => r.token === r.token_hash) && rows.some(r => r.token_hash === sha256(t1) && r.created_by === null), rows)
  } else skip('#9969 ページ用の URL の DB の値')
  must(await admin.del(`/api/admin/shifts/${SN}/report-link`), 'revoke SN')
  const v3 = await pub.get(link)
  const t3 = v3.data.shifts.find(s => s.shift_id === SN).report_token
  ok('#9969 報告用URLを無効にすると、ページ用の URL も使えなくなり、ページには新しい URL を出す', t3 && t3 !== t1 && (await pub.get(t1)).status === 404 && (await pub.get(t3)).status === 200, { t1, t3 })
}

// ---------- (2) プッシュ購読の付け替えをしない ----------
const coCode = `${PFX.toLowerCase()}a`
must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: coCode, company_name: `${PFX}連携先株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company A')
const A = client(await login(coCode, 'admin'))
{
  const EP = `http://127.0.0.1:9/push/${PFX}-${Date.now()}`
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
  must(await admin.post('/api/admin/push/subscribe', { endpoint: EP, keys }), 'subscribe sample')
  let before = null
  if (PERSIST) before = sql(`SELECT subscription_id, company_id, user_id FROM push_subscriptions WHERE endpoint = ${q(EP)}`)
  must(await admin.post('/api/admin/push/subscribe', { endpoint: EP, keys }), 'subscribe sample again')
  if (PERSIST) {
    const same = sql(`SELECT subscription_id, company_id, user_id FROM push_subscriptions WHERE endpoint = ${q(EP)}`)
    ok('（前提）同じ人が登録し直したときは、同じ購読の行を更新する', same.length === 1 && before.length === 1 && same[0].subscription_id === before[0].subscription_id && same[0].company_id === 1, { before, same })
  }
  must(await A.post('/api/admin/push/subscribe', { endpoint: EP, keys }), 'subscribe other company')
  if (PERSIST) {
    const after = sql(`SELECT subscription_id, company_id, user_id FROM push_subscriptions WHERE endpoint = ${q(EP)}`)
    ok('#9969 他社の利用者が同じ endpoint を登録すると、前の購読は消して新しい行で登録する（付け替えない）',
      after.length === 1 && after[0].company_id !== 1 && after[0].subscription_id !== before[0].subscription_id, { before, after })
  } else skip('#9969 プッシュ購読の行')
  const un = await admin.post('/api/admin/push/unsubscribe', { endpoint: EP })
  if (PERSIST) {
    const left = sql(`SELECT company_id FROM push_subscriptions WHERE endpoint = ${q(EP)}`)
    ok('#9969 前の利用者は、もうその endpoint の購読を消せない（他社の行はそのまま）', un.status !== 500 && left.length === 1 && left[0].company_id !== 1, { un: un.status, left })
  }
}

// ---------- (3) 同じ人の確認に他社連携のスタッフの電話番号を使わない ----------
{
  const ph = phoneOf()
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}X`, name: `${PFX} 連携`, password: 'pass1234', phone: ph }), 'staff X')
  const xRow = must(await admin.get('/api/admin/staff'), 'list').staff.find(s => s.user_code === `${PFX}X`)
  const terms = must(await A.get('/api/admin/roster/lookup?code=' + encodeURIComponent(xRow.global_staff_code)), 'lookup').consent
  const inA = must(await A.post('/api/admin/roster/link', { code: xRow.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
  const m = must(await A.get(`/api/admin/staff-lookup?phone=${ph}`), 'staff-lookup').matches
  ok('#9969 仮登録・応募の照合で、所属元の電話番号では他社連携のスタッフを見つけない', !m.some(x => x.staff_id === inA), m)
  const add = await A.post('/api/admin/staff', { user_code: `${PFX}Y`, name: `${PFX} 別人`, password: 'pass1234', phone: ph })
  ok('#9969 スタッフの登録で、他社連携のスタッフと電話番号が同じでも「同じ人」の確認にしない', add.status === 200 && !(add.data && add.data.need_confirm), add)
  const mc = must(await A.get(`/api/admin/staff/${must(await A.get('/api/admin/staff'), 'list A').staff.find(s => s.user_code === `${PFX}Y`).staff_id}/merge-candidates`), 'merge candidates')
  const cand = (mc.candidates || mc.rows || []).find(x => x.staff_id === inA)
  ok('#9969 統合候補でも、他社連携のスタッフの電話番号を比べない', !cand || !(cand.reasons || []).includes('電話番号が同じ'), cand)
  const name = must(await A.get(`/api/admin/staff-lookup?phone=${phoneOf()}`), 'lookup none').matches
  ok('（前提）照合の API は動く', Array.isArray(name))
}

// ---------- (4) 繰り返し登録の削除は、サーバーの「今日」で決める ----------
{
  const from = addDays(today, 20), to = addDays(from, 2)
  const pt = must(await admin.post('/api/admin/slot-patterns', { project_id: P, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: to, start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 1 }] }), 'pattern')
  if (PERSIST) {
    // 1件を過去の日付の枠にする（ブラウザの日付が昔にずれていたときに、過去の空き枠まで消えないか）
    sql(`UPDATE shift_slots SET work_date = '${addDays(today, -3)}' WHERE slot_id = (SELECT MIN(slot_id) FROM shift_slots WHERE pattern_id = ${Number(pt.pattern_id)})`)
  }
  const del = must(await admin.del(`/api/admin/slot-patterns/${pt.pattern_id}?remove_future=1&today=2000-01-01`), 'delete pattern')
  ok('#9969 ?today= を送っても使わず、サーバーの今日以降の空き枠だけを消す', PERSIST ? del.removed === 2 : del.removed === 3, del)
  if (PERSIST) {
    const left = sql(`SELECT COUNT(*) AS n FROM shift_slots WHERE work_date = '${addDays(today, -3)}' AND project_id = ${P}`)
    ok('#9969 過去の空き枠は消さない', Number(left[0].n) === 1, left)
  }
}

// ---------- (5) 使わない API ----------
{
  const st = client(await login('sample', 'st009'))
  const photo = await st.get('/api/staff/attendance-photo/attendance/1/9/0/x.jpg')
  ok('#9969 スタッフの写真の取得（GET /api/staff/attendance-photo/*）は 404', photo.status === 404, photo.status)
  const rr = await st.post('/api/staff/notifications/read-related', { kind: 'recruit_new' })
  ok('#9969 スタッフの POST /notifications/read-related は 404', rr.status === 404, rr.status)
  const ra = await admin.post('/api/admin/notifications/read-related', { kind: 'recruit_applied' })
  ok('管理者の POST /notifications/read-related は今までどおり使える', ra.status === 200, ra)
  const hu = await hq.get('/api/hq/companies/1/users')
  ok('#9969 本部の GET /api/hq/companies/:id/users は 404（企業詳細の users を使う。#9925 で済み）', hu.status === 404, hu.status)
  const detail = await hq.get('/api/hq/companies/1')
  ok('（前提）企業詳細は users を返す', detail.status === 200 && Array.isArray(detail.data.users), detail.status)
  // 打刻の応答に写真の R2 のキーを入れない
  const S = await createShift(9, today, '00:00', '23:59')
  const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))
  await admin.post('/api/admin/settings/photo-required', { enabled: true })
  const fd = new FormData(); fd.append('shift_id', String(S)); fd.append('report_type', 'check_in'); fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png')
  const stCookie = await login('sample', 'st009')
  const up = await fetchRetry(`${BASE}/api/staff/attendance-photo`, { method: 'POST', headers: { Cookie: stCookie }, body: fd })
  const upd = await up.json().catch(() => null)
  ok('#9969 打刻（写真つき）の応答に写真の R2 のキーを入れない', up.status === 200 && upd && upd.has_photo === true && !('photo_key' in upd) && !/attendance\//.test(JSON.stringify(upd)), { status: up.status, upd })
}

// ---------- (6) 静的ファイルのヘッダー・CSP・axios ----------
{
  for (const p of ['/static/common.js', '/static/style.css', '/static/icon-192.png', '/manifest.webmanifest']) {
    const r = await fetchRetry(`${BASE}${p}`)
    const csp = r.headers.get('content-security-policy') || ''
    ok(`#9969 静的ファイル ${p} に nosniff と CSP を付ける`, r.status === 200 && r.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp), { status: r.status, nosniff: r.headers.get('x-content-type-options'), csp })
    await r.arrayBuffer().catch(() => null)
  }
  const h = await fetchRetry(`${BASE}/_headers`)
  const ht = await h.text()
  ok('#9969 _headers そのものは配らない', !/X-Content-Type-Options/i.test(ht), { status: h.status })
  const lp = await fetchRetry(`${BASE}/login`)
  const csp = lp.headers.get('content-security-policy') || ''
  const html = await lp.text()
  ok('#9969 axios は 1.21.0 を SRI 付きで読む', /cdn\.jsdelivr\.net\/npm\/axios@1\.21\.0\/dist\/axios\.min\.js" integrity="sha384-p5EwRuz37ylAY9QrjGGIs9ngKVaIwppUFSourks9EIRp1CzoIDWoQkXrHxaAUhEB"/.test(html) && !/axios@1\.6\.0/.test(html))
  const cdnSrcs = csp.split(/[;\s]+/).filter(x => x.includes('cdn.jsdelivr.net'))
  ok('#9969 CSP の jsDelivr は、読み込むファイルのパスだけを許す（ホスト全体を許さない）', cdnSrcs.length > 0 && cdnSrcs.every(x => /^https:\/\/cdn\.jsdelivr\.net\/npm\/[^/]+@[\d.]+\/|^https:\/\/cdn\.jsdelivr\.net\/npm\/@[^/]+\/[^/]+@[\d.]+\//.test(x)), cdnSrcs)
  ok('#9969 CSP の script-src に axios・dayjs のファイルを入れる', /script-src [^;]*https:\/\/cdn\.jsdelivr\.net\/npm\/axios@1\.21\.0\/dist\/axios\.min\.js/.test(csp) && /script-src [^;]*dayjs@1\.11\.10\/dayjs\.min\.js/.test(csp), csp)
  ok('#9969 CSP の font-src は Font Awesome のフォントのフォルダだけ', /font-src 'self' https:\/\/cdn\.jsdelivr\.net\/npm\/@fortawesome\/fontawesome-free@6\.4\.0\/webfonts\/ data:/.test(csp), csp)
  // 画面で読む jsDelivr のファイルは、どれも CSP で許したパスに入っている
  const tags = [...html.matchAll(/(?:src|href)="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"/g)].map(m => m[1])
  ok('#9969 ログイン画面で読む jsDelivr のファイルはすべて CSP で許している', tags.length > 0 && tags.every(u => cdnSrcs.includes(u)), { tags, cdnSrcs })
  const ad = await fetchRetry(`${BASE}/admin`, { headers: { Cookie: await login('sample', 'admin') } })
  const adCsp = (ad.headers.get('content-security-policy') || '').split(/[;\s]+/)
  const adTags = [...(await ad.text()).matchAll(/(?:src|href)="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"/g)].map(m => m[1])
  ok('#9969 管理画面で読む jsDelivr のファイル（Chart.js・flatpickr など）もすべて CSP で許している', ad.status === 200 && adTags.length > 3 && adTags.every(u => adCsp.includes(u)), { adTags })
}

// ---------- (7) 人材担当者は自社の利用者だけ ----------
{
  const other = PERSIST ? sql(`SELECT user_id FROM users WHERE company_id != 1 ORDER BY user_id LIMIT 1`)[0]?.user_id : null
  const bad = await admin.put('/api/admin/employees/1', { hr_staff_user_id: other || 999999 })
  ok('#9969 他社の利用者を人材担当者に保存できない（400）', bad.status === 400 && /人材担当者/.test(bad.data?.error || ''), bad)
  const none = await admin.put('/api/admin/employees/1', { hr_staff_user_id: 99999999 })
  ok('#9969 存在しない利用者も 400（500 にしない）', none.status === 400, none)
  const good = await admin.put('/api/admin/employees/1', { hr_staff_user_id: 2 })
  ok('#9969 自社の利用者なら保存できる', good.status === 200, good)
  const clear = await admin.put('/api/admin/employees/1', { hr_staff_user_id: '' })
  ok('#9969 空欄で消せる', clear.status === 200, clear)
  if (PERSIST) {
    const r = sql(`SELECT hr_staff_user_id FROM employee_records WHERE staff_id = 1`)
    ok('#9969 消した値が保存されている', r.length === 1 && r[0].hr_staff_user_id === null, r)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
