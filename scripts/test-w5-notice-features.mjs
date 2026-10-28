// w5-notice-features（#157 #291 #294 #554 #555）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8815 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定すると、予約の時刻・掲載期限を過ぎた状態（DB を直接書き換える）も確かめる（テスト用の DB 専用）。
// 実行: BASE=http://127.0.0.1:8815 PERSIST=<保存先> node scripts/test-w5-notice-features.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8815'
const PERSIST = process.env.PERSIST || ''
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data, headers: r.headers }
  }
  const upload = async (path, files) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type || 'application/octet-stream' }), f.name)
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  const raw = (path) => fetch(`${BASE}${path}`, { headers: { Cookie: cookie } })
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p), upload, raw }
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
// d1 を外から書き換えると開発サーバーがつなぎ直すため、応答するまで待つ
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error("server did not respond")
}
async function d1w(sql) { const r = d1(sql); await waitServer(); return r }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nowJst = () => new Date(Date.now() + 9 * 3600 * 1000)
const today = nowJst().toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const jstLocal = (minutes) => new Date(Date.now() + 9 * 3600 * 1000 + minutes * 60000).toISOString().slice(0, 16) // 'YYYY-MM-DDTHH:MM'
const tag = Date.now().toString(36).slice(-5)
const PW = 'Nf-Passw0rd-' + tag
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }

const admin = client(await login('sample', 'admin'))
const adminList = async (q = '') => (await admin.get('/api/admin/notices' + q)).data
const byId = async (id, q = '') => (await adminList(q)).notices.find(n => n.notice_id === id)
const create = async (title, extra = {}) => {
  const r = await admin.post('/api/admin/notices', { title, body: '本文' + tag, target_type: 'all', target_ids: '', client_request_id: `${title}-${Math.random()}`, ...extra })
  return r
}
async function newStaff(suffix) {
  const code = `nf${tag}${suffix}`
  must(await admin.post('/api/admin/staff', { user_code: code, name: `お知らせ機能${tag}${suffix}`, password: PW }), 'staff ' + suffix)
  const list = (await admin.get('/api/admin/staff')).data
  const row = (list.staff || list).find(s => s.name === `お知らせ機能${tag}${suffix}`)
  return { ...row, code, api: client(await login('sample', code, PW)) }
}
const staffList = async (s, q = '') => (await s.api.get('/api/staff/notices' + q)).data
const sees = async (s, id, q = '') => (await staffList(s, q)).notices.some(n => n.notice_id === id)

const a = await newStaff('a'), b = await newStaff('b')
const cl = (await admin.get('/api/admin/clients')).data.clients[0]
for (const k of ['1', '2']) must(await admin.post('/api/admin/projects', { project_name: `お知らせ機能案件${tag}${k}`, client_id: cl.client_id, location: '店舗', unit_price: 10000 }), 'project')
const projs = (await admin.get('/api/admin/projects')).data.projects.filter(p => p.project_name.startsWith(`お知らせ機能案件${tag}`))
must(await admin.post('/api/admin/shifts', { staff_id: a.staff_id, project_id: projs[0].project_id, work_date: addDays(today, 2), start_time: '10:00', end_time: '19:00', status: 'confirmed', memo: 'NF' }), 'shift a')

// ---------- #157 個人あて（複数）・複数の案件あて ----------
{
  const rc = await admin.get('/api/admin/notices/recipients')
  ok('#157 個人あての候補（ログインのある在籍中のスタッフ）を返す', rc.status === 200 && rc.data.staff.some(s => s.staff_id === a.staff_id) && rc.data.staff.some(s => s.staff_id === b.staff_id), rc.status)
  const ps = must(await create(`個人あて${tag}`, { target_type: 'staff', target_ids: `${a.staff_id},${b.staff_id}` }), 'staff notice')
  ok('#157 複数のスタッフあてに配信でき、2人とも見られる', await sees(a, ps.notice_id) && await sees(b, ps.notice_id))
  const pp = must(await create(`複数案件${tag}`, { target_type: 'project', target_ids: projs.map(p => p.project_id).join(',') }), 'project notice')
  const row = await byId(pp.notice_id)
  ok('#157 複数の案件あてに配信できる（案件名を並べて返す）', row && row.target_ids.split(',').length === 2 && projs.every(p => row.target_names.includes(p.project_name)), row)
  ok('#157 複数の案件あて: シフトのある人だけに届く', await sees(a, pp.notice_id) && !(await sees(b, pp.notice_id)))

  // 修正: 配信先を b だけにし、タイトルも直す
  const e1 = await admin.put(`/api/admin/notices/${ps.notice_id}`, { target_type: 'staff', target_ids: `${b.staff_id}`, title: `個人あて（訂正）${tag}`, notify: true })
  ok('#157 配信したお知らせを修正できる', e1.status === 200 && e1.data.notified === 1, e1.data)
  ok('#157 配信先を直すと、外した人の画面から消える', !(await sees(a, ps.notice_id)) && await sees(b, ps.notice_id))
  const nb = (await staffList(b)).notices.find(n => n.notice_id === ps.notice_id)
  ok('#157 タイトル・本文を直すと、スタッフの画面に更新の印（updated_at）が出る', nb && nb.updated_at && nb.title === `個人あて（訂正）${tag}`, nb)
  const notif = (await b.api.get('/api/staff/notifications?kind=notice_updated')).data
  ok('#157 修正を知らせるにすると、配信先にアプリ内通知が届く', (notif.notifications || []).some(x => x.related_id === ps.notice_id), notif)
  const rv = (await admin.get(`/api/admin/notices/${ps.notice_id}/revisions`)).data
  ok('#157 修正の前の内容を履歴に残す', rv.revisions && rv.revisions.length === 1 && rv.revisions[0].title === `個人あて${tag}` && rv.revisions[0].action === 'edit', rv)
  const e2 = await admin.put(`/api/admin/notices/${pp.notice_id}`, { importance: 'important' })
  const r2 = await byId(pp.notice_id)
  ok('#157 タイトル・本文以外の修正では更新の印を付けない', e2.status === 200 && r2.importance === 'important' && !r2.updated_at, r2)
  const bad = await admin.put(`/api/admin/notices/${pp.notice_id}`, { target_type: 'staff', target_ids: '99999999' })
  ok('#157 修正でも自社でない配信先は拒否する（400）', bad.status === 400, bad)

  // 取消
  const w = await admin.post(`/api/admin/notices/${ps.notice_id}/withdraw`, { reason: '日時の誤り', notify: true })
  ok('#157 配信したお知らせを取り消せる', w.status === 200 && w.data.notified === 1, w.data)
  ok('#157 取り消したお知らせはスタッフの一覧から消える', !(await sees(b, ps.notice_id)))
  const d = await b.api.get(`/api/staff/notices/${ps.notice_id}`)
  ok('#157 取り消したお知らせを開くと「取り消されました」と返す（内容は返さない）', d.status === 404 && d.data.withdrawn === true && !d.data.notice, d)
  const r3 = await byId(ps.notice_id)
  ok('#157 管理画面では取消として残る（理由・取消した人）', r3 && r3.state === 'withdrawn' && r3.withdraw_reason === '日時の誤り' && !!r3.withdrawn_by_name, r3)
  const again = await admin.post(`/api/admin/notices/${ps.notice_id}/withdraw`, {})
  const editW = await admin.put(`/api/admin/notices/${ps.notice_id}`, { title: 'x' })
  const remW = await admin.post(`/api/admin/notices/${ps.notice_id}/remind`, {})
  ok('#157 取り消したものは、取消・修正・再通知できない（400）', again.status === 400 && editW.status === 400 && remW.status === 400, [again.status, editW.status, remW.status])
  const delP = await admin.del(`/api/admin/notices/${pp.notice_id}`)
  ok('#157 配信したお知らせは削除できない（取消を使う）', delP.status === 400, delP)
  const filt = await adminList('?status=withdrawn')
  ok('#157 状態で絞り込める（取消）', filt.notices.length >= 1 && filt.notices.every(n => n.state === 'withdrawn'), filt.notices.map(n => n.state))
}

// ---------- #291 下書き・予約 ----------
{
  const dr = await create(`下書き${tag}`, { mode: 'draft', send_email: true })
  ok('#291 下書きとして保存できる', dr.status === 200 && dr.data.status === 'draft', dr.data)
  ok('#291 下書きはスタッフに出ない', !(await sees(a, dr.data.notice_id)))
  const row = await byId(dr.data.notice_id, '?status=pending')
  ok('#291 下書きは一覧の「下書き・予約」に出る', row && row.state === 'draft' && row.send_email === 1, row)
  const remD = await admin.post(`/api/admin/notices/${dr.data.notice_id}/remind`, {})
  ok('#291 下書きは再通知できない', remD.status === 400, remD)
  const resp = await a.api.post(`/api/staff/notices/${dr.data.notice_id}/read`)
  ok('#291 下書きは既読にもできない（404）', resp.status === 404, resp.status)
  const ed = await admin.put(`/api/admin/notices/${dr.data.notice_id}`, { body: '直した本文', mode: 'draft' })
  ok('#291 下書きを編集できる（更新の印は付けない）', ed.status === 200 && !(await byId(dr.data.notice_id)).updated_at, ed.data)
  const pub = await admin.post(`/api/admin/notices/${dr.data.notice_id}/publish`, {})
  ok('#291 下書きを配信すると、スタッフに出る（メールの設定も引き継ぐ）', pub.status === 200 && pub.data.state === 'published' && pub.data.email && await sees(a, dr.data.notice_id), pub.data)
  const pub2 = await admin.post(`/api/admin/notices/${dr.data.notice_id}/publish`, {})
  ok('#291 配信済みのものはもう一度配信できない', pub2.status === 400, pub2)

  const past = await create(`予約過去${tag}`, { mode: 'schedule', scheduled_at: jstLocal(-5) })
  const far = await create(`予約遠い${tag}`, { mode: 'schedule', scheduled_at: `${addDays(today, 400)}T09:00` })
  const badFmt = await create(`予約形式${tag}`, { mode: 'schedule', scheduled_at: 'あした' })
  ok('#291 予約の日時は今より後・180日以内で、形式を確かめる（400）', [past, far, badFmt].every(r => r.status === 400), [past.status, far.status, badFmt.status])
  const sc = await create(`予約${tag}`, { mode: 'schedule', scheduled_at: jstLocal(60) })
  ok('#291 日時を指定して予約できる', sc.status === 200 && sc.data.status === 'scheduled', sc.data)
  ok('#291 予約の時刻の前はスタッフに出ない', !(await sees(a, sc.data.notice_id)))
  const r = await byId(sc.data.notice_id)
  ok('#291 予約は一覧で予約の状態と配信予定の人数を返す', r && r.state === 'scheduled' && r.staff_total >= 1, r)
  const res2 = await admin.put(`/api/admin/notices/${sc.data.notice_id}`, { mode: 'schedule', scheduled_at: jstLocal(120) })
  ok('#291 予約の日時を変えられる', res2.status === 200 && res2.data.state === 'scheduled', res2.data)
  if (PERSIST) {
    // 登録より前に公開されたものは対象外（#227）なので、過ぎたばかりの時刻にする
    await d1w(`UPDATE notices SET published_at = datetime('now', '+9 hours', '-2 seconds') WHERE notice_id = ${sc.data.notice_id}`)
    ok('#291 予約の時刻を過ぎると、定期処理の前でもスタッフに出る', await sees(a, sc.data.notice_id))
    await adminList('') // 管理画面を開くと、その会社の予約を配信済みにする（waitUntil）
    await sleep(1500)
    const [st] = await d1w(`SELECT status FROM notices WHERE notice_id = ${sc.data.notice_id}`)
    ok('#291 予約の時刻を過ぎたものは published になる（予約配信の処理）', st[0] && st[0].status === 'published', st)
    const delPub = await admin.del(`/api/admin/notices/${sc.data.notice_id}`)
    ok('#291 時刻を過ぎた予約は削除できない', delPub.status === 400, delPub)
  }
  const dr2 = must(await create(`削除する下書き${tag}`, { mode: 'draft' }), 'draft2')
  const del = await admin.del(`/api/admin/notices/${dr2.notice_id}`)
  ok('#291 下書きは削除できる', del.status === 200 && !(await byId(dr2.notice_id)), del)
}

// ---------- #294 掲載期限 ----------
{
  const bad = await create(`期限誤り${tag}`, { expires_at: addDays(today, -1) })
  ok('#294 掲載期限が配信日より前なら拒否する（400）', bad.status === 400, bad)
  const ex = must(await create(`期限つき${tag}`, { expires_at: today }), 'expiring')
  const n = (await staffList(a)).notices.find(x => x.notice_id === ex.notice_id)
  ok('#294 期限の日まではスタッフに出る（期限を返す）', n && String(n.expires_at).startsWith(today) && n.expired === 0, n)
  if (PERSIST) {
    const before = (await staffList(a)).unread_count
    await d1w(`UPDATE notices SET expires_at = datetime('now', '+9 hours', '-1 minutes') WHERE notice_id = ${ex.notice_id}`)
    ok('#294 期限を過ぎると一覧から外れる', !(await sees(a, ex.notice_id)))
    const pastL = await staffList(a, '?filter=past')
    ok('#294 期限を過ぎたものは「掲載終了」に出る', pastL.notices.some(x => x.notice_id === ex.notice_id && x.expired === 1), pastL.notices.map(x => x.notice_id))
    const after = (await staffList(a)).unread_count
    ok('#294 期限を過ぎたものは未読の数に入れない', after === before - 1, [before, after])
    const home = (await a.api.get('/api/staff/home')).data
    ok('#294 ホームにも出ない', !(home.notices || []).some(x => x.notice_id === ex.notice_id), home.notices)
    const one = await a.api.get(`/api/staff/notices/${ex.notice_id}`)
    ok('#294 個別画面では開ける（掲載終了の印）', one.status === 200 && one.data.notice.expired === 1, one.status)
    const adm = await adminList('?status=expired')
    ok('#294 管理画面で掲載終了を絞り込める', adm.notices.some(x => x.notice_id === ex.notice_id), adm.notices.map(x => x.notice_id))
  }
}

// ---------- #554 回答 ----------
{
  const q = must(await create(`出欠${tag}`, { response_options: ['参加する', '参加しない', '参加する', ' '], response_comment: true }), 'response notice')
  const row = await byId(q.notice_id)
  ok('#554 回答の選択肢を保存する（空・重複は除く）', row && JSON.stringify(row.response_options) === JSON.stringify(['参加する', '参加しない']) && row.response_comment === 1, row)
  const tooMany = await create(`選択肢多い${tag}`, { response_options: Array.from({ length: 9 }, (_, i) => `案${i}`) })
  ok('#554 選択肢は8個まで（400）', tooMany.status === 400, tooMany)
  const n = (await staffList(a)).notices.find(x => x.notice_id === q.notice_id)
  ok('#554 スタッフに選択肢と自分の回答（未回答）を返す', n && n.response_options.length === 2 && n.response_comment === 1 && n.my_response === null, n)
  const badC = await a.api.post(`/api/staff/notices/${q.notice_id}/response`, { choice: 'たぶん' })
  ok('#554 選択肢にない回答は拒否する（400）', badC.status === 400, badC)
  const ans = await a.api.post(`/api/staff/notices/${q.notice_id}/response`, { choice: '参加する', comment: 'Mサイズ' })
  ok('#554 回答できる', ans.status === 200 && ans.data.my_response.choice === '参加する', ans.data)
  const n2 = (await staffList(a)).notices.find(x => x.notice_id === q.notice_id)
  ok('#554 回答すると既読にもなり、自分の回答を返す', n2 && n2.is_read === 1 && n2.my_response && n2.my_response.comment === 'Mサイズ', n2)
  const re = await a.api.post(`/api/staff/notices/${q.notice_id}/response`, { choice: '参加しない', comment: '' })
  ok('#554 答え直せる', re.status === 200 && re.data.my_response.choice === '参加しない', re.data)
  const reads = (await admin.get(`/api/admin/notices/${q.notice_id}/reads`)).data
  ok('#554 既読状況に、選択肢ごとの人数と回答した人・未回答の人を返す', reads.responses && reads.responses.counts['参加しない'] === 1 && reads.responses.counts['参加する'] === 0
    && reads.responses.answered.some(x => x.name === a.name) && reads.responses.unanswered.some(x => x.name === b.name), reads.responses)
  const csv = await admin.raw(`/api/admin/notices/${q.notice_id}/responses.csv`)
  const text = await csv.text()
  ok('#554 回答を CSV で出せる', csv.status === 200 && text.includes(a.name) && text.includes('参加しない') && text.includes('未回答'), text.slice(0, 200))
  const lose = await admin.put(`/api/admin/notices/${q.notice_id}`, { response_options: ['参加する'] })
  ok('#554 回答が届いた選択肢は修正で消せない（400）', lose.status === 400, lose)
  const add = await admin.put(`/api/admin/notices/${q.notice_id}`, { response_options: ['参加する', '参加しない', '未定'] })
  ok('#554 選択肢を足すことはできる', add.status === 200, add)
  const plain = must(await create(`回答なし${tag}`), 'plain')
  const noR = await a.api.post(`/api/staff/notices/${plain.notice_id}/response`, { choice: 'x' })
  ok('#554 回答を求めていないお知らせには回答できない（400）', noR.status === 400, noR)
  const other = must(await create(`b だけ${tag}`, { target_type: 'staff', target_ids: `${b.staff_id}`, response_options: ['はい', 'いいえ'] }), 'b only')
  const notMine = await a.api.post(`/api/staff/notices/${other.notice_id}/response`, { choice: 'はい' })
  ok('#554 配信対象でないお知らせには回答できない（404）', notMine.status === 404, notMine)
}

// ---------- #555 添付 ----------
{
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3])
  const PDF = new TextEncoder().encode('%PDF-1.4\n%test\n')
  const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>')
  const n = must(await create(`添付${tag}`, { mode: 'draft', target_type: 'staff', target_ids: `${a.staff_id}` }), 'attach notice')
  const up = await admin.upload(`/api/admin/notices/${n.notice_id}/attachments`, [
    { name: '売場図.png', bytes: PNG, type: 'image/png' }, { name: '資料.pdf', bytes: PDF, type: 'application/pdf' },
    { name: 'fake.png', bytes: HTML, type: 'image/png' }, { name: 'tool.exe', bytes: PDF },
  ])
  const okNames = (up.data.results || []).filter(r => r.ok).map(r => r.filename)
  ok('#555 画像・PDF を添付できる', up.status === 200 && okNames.includes('売場図.png') && okNames.includes('資料.pdf'), up.data)
  ok('#555 中身が形式と合わないファイル・対応していない形式は断る', (up.data.results || []).filter(r => !r.ok).map(r => r.filename).sort().join(',') === 'fake.png,tool.exe', up.data)
  const more = await admin.upload(`/api/admin/notices/${n.notice_id}/attachments`, [1, 2, 3, 4].map(i => ({ name: `p${i}.png`, bytes: PNG, type: 'image/png' })))
  ok('#555 添付は1つのお知らせに5件まで', (more.data.results || []).filter(r => r.ok).length === 3 && (more.data.results || []).filter(r => !r.ok).length === 1, more.data)
  must(await admin.post(`/api/admin/notices/${n.notice_id}/publish`, {}), 'publish attach')
  const sn = (await staffList(a)).notices.find(x => x.notice_id === n.notice_id)
  ok('#555 スタッフの一覧に添付の一覧を返す（保存場所のキーは返さない）', sn && sn.attachments.length === 5 && !('storage_key' in sn.attachments[0]), sn && sn.attachments)
  const img = sn.attachments.find(x => x.file_name === '売場図.png')
  const g = await a.api.raw(`/api/staff/notices/${n.notice_id}/attachments/${img.attachment_id}`)
  const body = new Uint8Array(await g.arrayBuffer())
  ok('#555 配信先の本人は添付を取得できる（種類は拡張子から決め、nosniff）', g.status === 200 && g.headers.get('content-type') === 'image/png' && g.headers.get('x-content-type-options') === 'nosniff' && body[0] === 0x89, [g.status, g.headers.get('content-type')])
  const gb = await b.api.raw(`/api/staff/notices/${n.notice_id}/attachments/${img.attachment_id}`)
  ok('#555 配信対象でない人は添付を取得できない（404）', gb.status === 404, gb.status)
  const ga = await admin.raw(`/api/admin/notices/${n.notice_id}/attachments/${img.attachment_id}?download=1`)
  ok('#555 管理者は添付を取得できる（download=1 で保存）', ga.status === 200 && /^attachment;/.test(ga.headers.get('content-disposition') || ''), [ga.status, ga.headers.get('content-disposition')])
  const del = await admin.del(`/api/admin/notices/${n.notice_id}/attachments/${img.attachment_id}`)
  const after = await byId(n.notice_id)
  ok('#555 添付を削除できる（配信済みなら更新の印を付ける）', del.status === 200 && after.attachments.length === 4 && !!after.updated_at, after && after.attachments)
}

// ---------- 他社の管理者からは操作できない ----------
{
  const hq = client(await login('sample', 'hq'))
  const coCode = `nf${tag}co`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: coCode, company_name: `お知らせ他社${tag}`, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const other = client(await login(coCode, 'admin'))
  const mine = must(await create(`他社確認${tag}`, { mode: 'draft' }), 'draft for tenant')
  const r = await Promise.all([
    other.put(`/api/admin/notices/${mine.notice_id}`, { title: 'x' }), other.post(`/api/admin/notices/${mine.notice_id}/publish`, {}),
    other.post(`/api/admin/notices/${mine.notice_id}/withdraw`, {}), other.del(`/api/admin/notices/${mine.notice_id}`),
    other.get(`/api/admin/notices/${mine.notice_id}/revisions`), other.raw(`/api/admin/notices/${mine.notice_id}/responses.csv`),
  ])
  ok('他社のお知らせは修正・配信・取消・削除・履歴・CSV のどれも 404', r.every(x => x.status === 404), r.map(x => x.status))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
