// Sprint 23・24 の残り（作業単位 w25-leftovers: #9966 #9975）の統合テスト
//   #9975 (1) 報告用URLの古いトークン（0105 より前の平文）を、毎日 3:30 の cron（report_token_hash）でまとめてハッシュへ移す。
//            1回の起動で移すのは500件まで（残りは次の日）。移した後も古いURLで開ける。移す行がなければ idle。書き込みの行数を数える
//   #9975 (2) src/services/email.ts のコメントが今の規則（MAIL_ENABLED が 'true' のときだけ送る）
//   #9975 (3) 書いた人の記録がない古い日報コメントは、同じ会社の管理者なら編集・削除できる（作者のあるコメントは今までどおり本人だけ。403）
//   #9966 (1) スタッフアプリの renderMore・notifOpenStaff に包み直し（_orig）が残っていない
//   #9966 (2) スタッフ本人の書類のアップロードも lib/documents.ts の storeUploads を通す（応答・文言・状態コード・保存の形は今までどおり）
//   #9966 (3) str・safeJson・base64url の randToken を src/lib の1つにまとめた（トークンの形は今までどおり）
//   #9966 (4) test-w13-docs-arch-ops.mjs が、基準のコミットに無いファイルへの参照を「ずれた」と扱わない（--fix-refs で壊さない）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `npx wrangler dev --local --test-scheduled --port 9031 --persist-to <保存先>` で起動していること（本番には接続しない）
// 実行: BASE=http://127.0.0.1:9031 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w25-leftovers.mjs
//   PERSIST はローカルの D1 を直接読み書きするのに使う（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9031'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 700) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）。戻り値は文ごとの結果（results・meta）
const CLI = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w25lo-'))
let sqlSeq = 0
async function sqlAll(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }); break } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '')
      if (i >= 3 || !/internal error|SQLITE_BUSY|database is locked|bad_alloc|write EOF/i.test(msg)) throw new Error(msg.slice(0, 600))
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
async function fetchRetry(url, opts) { try { return await fetch(url, opts) } catch { await waitServer(); return fetch(url, opts) } }
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetchRetry(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const isForm = body instanceof FormData
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie, ...(isForm ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) })
    const buf = new Uint8Array(await r.arrayBuffer())
    let data = null; try { data = JSON.parse(new TextDecoder().decode(buf)) } catch { }
    return { status: r.status, data, buf }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const pub = { get: async (token) => { const r = await fetchRetry(`${BASE}/api/public/report/${token}`); await r.text(); return r.status } }
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`); return r.data }
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const cron = async (expr) => { const r = await fetchRetry(`${BASE}/__scheduled?cron=${encodeURIComponent(expr)}`); await r.text(); return r.status }
const REPORTS = '30 18 * * *'

const PFX = 'LO' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const sales = client(await login('sample', 'sales01'))
const CO = Number((await sql(`SELECT company_id FROM companies WHERE company_code = 'sample'`))[0].company_id)

// ---------- 準備: 案件・スタッフ2人・今日のシフトと日報 ----------
const tpl = must(await admin.post('/api/admin/templates', { template_name: `w25日報${PFX}`, fields: [{ key: 'w25memo', label: 'ひとこと', type: 'text' }] }), 'template')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, report_template_id: tpl.template_id }), 'project')
const PID = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const mkStaff = async (k) => {
  const phone = '080' + String((Date.now() + k.charCodeAt(0) * 7919) % 100000000).padStart(8, '0')
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}さん`, password: 'pass1234', phone }), 'staff ' + k)
  const row = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}${k}`)
  return { ...row, api: client(await login('sample', `${PFX}${k}`)) }
}
const A = await mkStaff('A'), B = await mkStaff('B')
const shiftA = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: PID, work_date: today, start_time: '00:00', end_time: '23:59' }), 'shift A')
const shiftB = must(await admin.post('/api/admin/shifts', { staff_id: B.staff_id, project_id: PID, work_date: today, start_time: '00:00', end_time: '23:59' }), 'shift B')

// ---------- #9966 (3) 重複の関数を lib にまとめた（形は今までどおり） ----------
{
  const hash = await import(pathToFileURL(join(ROOT, 'src/lib/hash.ts')).href).catch(() => null)
  if (!hash) skip('#9966 src/lib/hash.ts の b64url・randomB64url', 'この Node では .ts を読み込めない')
  else {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63, 64])
    ok('#9966 b64url は base64url（+ / = を使わない）で、Node の base64url と同じ', hash.b64url(bytes) === Buffer.from(bytes).toString('base64url') && hash.b64url(bytes.buffer) === hash.b64url(bytes))
    const t = hash.randomB64url(24)
    ok('#9966 randomB64url(24) は32文字の base64url（今までの報告用URL・仮パスワードのトークンと同じ長さ）', /^[A-Za-z0-9_-]{32}$/.test(t) && hash.randomB64url(18).length === 24, t)
  }
  const v = await import(pathToFileURL(join(ROOT, 'src/lib/validate.ts')).href).catch(() => null)
  if (!v) skip('#9966 src/lib/validate.ts の clipText・parseJsonOr', 'この Node では .ts を読み込めない')
  else {
    ok('#9966 clipText は前後の空白を除いて max 文字まで（null・undefined は空文字）', v.clipText('  あいうえお  ', 3) === 'あいう' && v.clipText(null, 5) === '' && v.clipText(undefined, 5) === '' && v.clipText(12345, 3) === '123')
    ok('#9966 parseJsonOr は読めれば中身、読めなければ fallback（roster の safeJson は元の値、本人の手続きは {}）',
      v.parseJsonOr('{"a":1}', {}).a === 1 && v.parseJsonOr('壊れた', '壊れた') === '壊れた' && JSON.stringify(v.parseJsonOr('{', {})) === '{}' && v.parseJsonOr(null, 'x') === null)
  }
  const dupSrc = ['src/recruit.ts', 'src/staff-lifecycle.ts', 'src/lib/web-push.ts', 'src/board.ts', 'src/hq-support.ts', 'src/roster.ts', 'src/staff-self-service.ts'].map(f => [f, read(f)])
  ok('#9966 base64url の乱数・変換は src/lib/hash.ts だけに書く（recruit・staff-lifecycle・web-push に btoa の変換が無い）',
    dupSrc.every(([, s]) => !/btoa\(/.test(s)) && read('src/lib/web-push.ts').includes("import { b64url } from './hash'"), dupSrc.filter(([, s]) => /btoa\(/.test(s)).map(x => x[0]))
  ok('#9966 str(v, max) は clipText、safeJson は parseJsonOr を使う（同じ中身の定義が残っていない）',
    dupSrc.every(([, s]) => !s.includes("String(v ?? '').trim().slice(0, max)") && !/function safeJson|safeJson = \(s: any\) => \{ try/.test(s)), dupSrc.filter(([, s]) => s.includes("String(v ?? '').trim().slice(0, max)")).map(x => x[0]))
  const issued = await admin.post(`/api/admin/shifts/${shiftB.shift_id}/report-link`, {})
  ok('#9966 報告用URLのトークンは今までどおり32文字の base64url（発行できて開ける）', issued.status === 200 && /^[A-Za-z0-9_-]{32}$/.test(issued.data.token || '') && await pub.get(issued.data.token) === 200, issued.data)
}

// ---------- #9966 (1) スタッフアプリの包み直し ----------
{
  const att = read('public/static/staff-attendance.js'), prof = read('public/static/staff-profile.js'), staff = read('public/static/staff.js')
  ok('#9966 staff-attendance.js・staff-profile.js に _orig の包みが無く、renderMore・notifOpenStaff を差し替えていない',
    !/_orig|orig[A-Z]\w*\s*=/.test(att + prof) && !/window\.renderMore\s*=/.test(att + prof + staff) && (att.match(/window\.notifOpenStaff\s*=/g) || []).length === 1)
  ok('#9966 その他の画面は staffScreen の登録で作る（renderMore は staff.js に1つ）', /staffScreen\('more', \{[^}]*render: renderMore/.test(staff) && (staff.match(/function renderMore\(/g) || []).length === 1 && !/function renderMore\(/.test(att + prof))
}

// ---------- #9975 (2) メールのコメント ----------
{
  const em = read('src/services/email.ts')
  ok("#9975 email.ts のコメントに古い規則（'false' の場合だけ送らない）が残っていない", !/'false' の場合は実送信せず/.test(em) && !/MAIL_ENABLED='false' のため送らなかった/.test(em) && /MAIL_ENABLED\?: string \/\/ 'true' のときだけ実際に送る/.test(em))
}

// ---------- #9966 (2) スタッフ本人の書類のアップロード（storeUploads を通す） ----------
{
  const sa = A.api
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n% w25 test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
  const pdf = new Blob([pdfBytes], { type: 'application/pdf' })
  const form = (blob, name, type, valid) => { const f = new FormData(); if (blob) f.append('file', blob, name); if (type) f.append('doc_type', type); if (valid) f.append('valid_until', valid); return f }
  const up = await sa.post('/api/staff/self/documents', form(pdf, '資格証.pdf', 'qualification', '2027-03-31'))
  ok('#9966 写真・PDF を提出できる（応答は今までどおり { ok, document_id } だけ）', up.status === 200 && up.data.ok === true && Number.isInteger(up.data.document_id) && Object.keys(up.data).sort().join(',') === 'document_id,ok', up.data)
  const DID = up.data.document_id
  const row = (await sql(`SELECT company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, valid_until, submitted_by_staff, confirmed_at FROM staff_documents WHERE document_id = ${Number(DID)}`))[0]
  ok('#9966 保存の形は今までどおり（キーは staff-documents/会社/スタッフ/UUID/名前・種類は拡張子から・提出した本人の印）',
    row && row.company_id === CO && row.staff_id === A.staff_id && row.original_file_name === '資格証.pdf' && row.mime_type === 'application/pdf' && row.file_size === pdfBytes.length
    && new RegExp(`^staff-documents/${CO}/${A.staff_id}/[0-9a-f-]{36}/資格証\\.pdf$`).test(row.storage_key) && row.doc_type === 'qualification' && row.valid_until === '2027-03-31' && row.submitted_by_staff === 1 && row.uploaded_by != null && row.confirmed_at == null, row)
  const dl = await sa.get(`/api/staff/self/documents/${DID}/download`)
  ok('#9966 出した書類を開ける（中身が同じ）', dl.status === 200 && Buffer.from(dl.buf).equals(Buffer.from(pdfBytes)))
  const mine = must(await sa.get('/api/staff/self/documents'), 'my docs').documents
  ok('#9966 本人の一覧に出る', mine.some(d => d.document_id === DID && d.original_file_name === '資格証.pdf'), mine.slice(0, 2))
  const inbox = must(await admin.get('/api/admin/notifications'), 'admin inbox').notifications
  ok('#9966 管理者に提出の知らせが届く（種類・ファイル名・有効期限）', inbox.some(n => n.kind === 'staff_document_submitted' && n.related_id === A.staff_id && String(n.body).includes('資格証: 資格証.pdf（有効期限 2027-03-31）')), inbox.slice(0, 3))

  const cases = [
    ['ファイルが無い', form(null, '', 'other'), 400, 'ファイルが選択されていません'],
    ['書類の種類が無い', form(pdf, 'a.pdf'), 400, '書類の種類を選んでください'],
    ['書類の種類が正しくない', form(pdf, 'a.pdf', 'contract_basic'), 400, '書類の種類が正しくありません'],
    ['有効期限の形が正しくない', form(pdf, 'a.pdf', 'other', '2027/03/31'), 400, '有効期限は「2026-03-31」の形式で入力してください'],
    ['写真・PDF でない', form(new Blob(['MZ'], { type: 'application/octet-stream' }), 'tool.exe', 'other'), 400, '写真（JPEG・PNG・WebP）か PDF を選んでください'],
    ['中身が形式と合わない', form(new Blob(['not an image'], { type: 'image/jpeg' }), 'photo.jpg', 'id_card'), 400, 'ファイルの中身が形式と合いません。写真か PDF を選び直してください'],
    ['空のファイル', form(new Blob([]), 'empty.pdf', 'other'), 400, 'ファイルは10MB以下にしてください'],
    ['10MB を超える', form(new Blob([pdfBytes, new Uint8Array(10 * 1024 * 1024)], { type: 'application/pdf' }), 'big.pdf', 'other'), 400, 'ファイルは10MB以下にしてください'],
  ]
  for (const [what, f, status, error] of cases) {
    const r = await sa.post('/api/staff/self/documents', f)
    ok(`#9966 ${what}は ${status}（文言は今までどおり）`, r.status === status && r.data && r.data.error === error, { status: r.status, data: r.data })
  }
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
  const upPng = await sa.post('/api/staff/self/documents', form(new Blob([png], { type: 'image/png' }), 'card.PNG', 'id_card'))
  const pngRow = upPng.status === 200 ? (await sql(`SELECT mime_type FROM staff_documents WHERE document_id = ${Number(upPng.data.document_id)}`))[0] : null
  ok('#9966 PNG（拡張子は大文字でもよい）も出せて、種類は image/png', upPng.status === 200 && pngRow && pngRow.mime_type === 'image/png', { upPng: upPng.data, pngRow })

  // 確認待ちの上限（30件）: 上限に達したら 429（登録しない）。担当者が1件確認すると、また出せる
  const pendingNow = Number((await sql(`SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id = ${A.staff_id} AND company_id = ${CO} AND submitted_by_staff = 1 AND confirmed_at IS NULL`))[0].n)
  const fill = 30 - pendingNow
  await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${fill})
    INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, submitted_by_staff)
    SELECT ${CO}, ${A.staff_id}, 'w25-fill-' || i || '.pdf', 'staff-documents/w25-fill/' || i, 'application/pdf', 10, NULL, 'other', 1 FROM n`)
  const over = await sa.post('/api/staff/self/documents', form(pdf, 'over.pdf', 'other'))
  const cnt = async () => Number((await sql(`SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id = ${A.staff_id} AND submitted_by_staff = 1 AND confirmed_at IS NULL`))[0].n)
  ok('#9966 確認待ちが30件あると 429（文言は今までどおり）で、登録しない', over.status === 429 && over.data.error === '確認待ちの書類が30件あります。担当者の確認を待ってから提出してください' && await cnt() === 30, { status: over.status, data: over.data })
  ok('#9966 上限で断った書類は一覧にも DB にも残らない', !(await sql(`SELECT 1 FROM staff_documents WHERE original_file_name = 'over.pdf' AND staff_id = ${A.staff_id}`)).length)
  await sql(`UPDATE staff_documents SET confirmed_at = '${jstNow()}' WHERE original_file_name = 'w25-fill-1.pdf' AND staff_id = ${A.staff_id}`)
  const again = await sa.post('/api/staff/self/documents', form(pdf, 'again.pdf', 'other'))
  ok('#9966 担当者が1件確認すると、また出せる', again.status === 200 && again.data.ok === true && await cnt() === 30, again.data)
  ok('#9966 ほかのスタッフは開けない（404）', (await B.api.get(`/api/staff/self/documents/${DID}/download`)).status === 404)
  await sql(`DELETE FROM staff_documents WHERE staff_id = ${A.staff_id} AND storage_key LIKE 'staff-documents/w25-fill/%'`)
}

// ---------- #9975 (3) 書いた人の記録がない古い日報コメント ----------
{
  must(await A.api.post('/api/staff/daily-report', { shift_id: shiftA.shift_id, values: { w25memo: 'A1' } }), 'report A')
  const listOf = async (who) => must(await who.get(`/api/admin/daily-reports?from=${today}&to=${today}&staff_id=${A.staff_id}&limit=50`), 'list').reports
  const RID = (await listOf(admin)).find(r => r.shift_id === shiftA.shift_id).daily_report_id
  const rowOf = async (who = admin) => (await listOf(who)).find(r => r.daily_report_id === RID)
  // 0107 で写した古いコメント（manager_comment_by が無い）と同じ形の行を入れる
  await sql(`INSERT INTO daily_report_comments (company_id, daily_report_id, body, author_user_id, created_at) VALUES (${CO}, ${RID}, '書いた人の記録がない古いコメント', NULL, '${jstNow()}')`)
  const OID = Number((await sql(`SELECT comment_id FROM daily_report_comments WHERE daily_report_id = ${RID} AND author_user_id IS NULL`))[0].comment_id)
  let row = await rowOf()
  let oc = row.comments.find(c => c.comment_id === OID)
  ok('#9975 古いコメントは一覧で「自分のもの」ではないが、編集できる（editable）', oc && oc.mine === false && oc.editable === true && oc.author_name == null, row.comments)
  const added = must(await admin.post(`/api/admin/daily-reports/${RID}/comments`, { body: '代表のコメント' }), 'admin comment')
  const AID = added.comment_id
  const ac = added.comments.find(c => c.comment_id === AID)
  ok('#9975 自分のコメントは今までどおり mine・editable', ac && ac.mine === true && ac.editable === true, added.comments)
  const srow = await rowOf(sales)
  ok('#9975 ほかの管理者には、作者のあるコメントは編集できない・古いコメントは編集できると返す',
    srow.comments.find(c => c.comment_id === AID).editable === false && srow.comments.find(c => c.comment_id === AID).mine === false && srow.comments.find(c => c.comment_id === OID).editable === true, srow.comments)

  const e403 = await sales.put(`/api/admin/daily-reports/${RID}/comments/${AID}`, { body: '書き換え' })
  const d403 = await sales.del(`/api/admin/daily-reports/${RID}/comments/${AID}`)
  ok('#9975 作者のあるコメントは、ほかの管理者は編集・削除できない（403。今までどおり）', e403.status === 403 && d403.status === 403 && /書いた人だけが編集・削除できます/.test(e403.data.error || ''), { e403, d403 })
  const ed = await sales.put(`/api/admin/daily-reports/${RID}/comments/${OID}`, { body: '営業が直した古いコメント' })
  const dbo = (await sql(`SELECT body, author_user_id, updated_at, read_at FROM daily_report_comments WHERE comment_id = ${OID}`))[0]
  ok('#9975 古いコメントは、ほかの管理者（営業）でも直せる（書いた人は空のまま・直した日時が入る）', ed.status === 200 && dbo.body === '営業が直した古いコメント' && dbo.author_user_id == null && !!dbo.updated_at && dbo.read_at == null, { ed: ed.data, dbo })
  ok('#9975 直した応答のコメント一覧にも出る', ed.data.comments.some(c => c.comment_id === OID && c.body === '営業が直した古いコメント' && c.editable === true))
  const empty = await sales.put(`/api/admin/daily-reports/${RID}/comments/${OID}`, { body: '  ' })
  ok('#9975 古いコメントを空欄で保存すると 400（消すときは DELETE。今までどおり）', empty.status === 400)
  const del = await admin.del(`/api/admin/daily-reports/${RID}/comments/${OID}`)
  ok('#9975 古いコメントは、管理者が削除できる', del.status === 200 && !del.data.comments.some(c => c.comment_id === OID) && !(await sql(`SELECT 1 FROM daily_report_comments WHERE comment_id = ${OID}`)).length, del.data)
  row = await rowOf()
  ok('#9975 消した後も、日報の旧列には最新のコメントを写す', row.manager_comment === '代表のコメント' && row.comments.length === 1, row)
  ok('#9975 消したコメントをもう一度消すと 404', (await admin.del(`/api/admin/daily-reports/${RID}/comments/${OID}`)).status === 404)
  // ほかの会社の日報の古いコメントは見つからない（404）
  const otherCo = (await sql(`SELECT dr.daily_report_id, dr.company_id FROM daily_reports dr WHERE dr.company_id <> ${CO} LIMIT 1`))[0]
  if (!otherCo) skip('#9975 ほかの会社の古いコメント', 'ほかの会社の日報が無い')
  else {
    await sql(`INSERT INTO daily_report_comments (company_id, daily_report_id, body, author_user_id, created_at) VALUES (${otherCo.company_id}, ${otherCo.daily_report_id}, '他社の古いコメント', NULL, '${jstNow()}')`)
    const XID = Number((await sql(`SELECT MAX(comment_id) AS id FROM daily_report_comments WHERE daily_report_id = ${otherCo.daily_report_id}`))[0].id)
    const xr = await admin.put(`/api/admin/daily-reports/${otherCo.daily_report_id}/comments/${XID}`, { body: '他社を直す' })
    ok('#9975 ほかの会社の古いコメントは直せない（404）', xr.status === 404 && (await sql(`SELECT body FROM daily_report_comments WHERE comment_id = ${XID}`))[0].body === '他社の古いコメント', xr)
  }
  const ui = read('public/static/admin.js')
  ok('#9975 画面は、自分のコメントと編集できる古いコメントに「編集」「削除」を出す', /\$\{cm\.mine \|\| cm\.editable \? `<button[^`]*data-action="commentReport"/.test(ui))
}

// ---------- #9975 (1) 古いトークンを cron でまとめてハッシュへ ----------
{
  const N = 600
  const S = shiftA.shift_id
  // 0105 より前に発行した行（token が平文、token_hash は NULL）を N 件と、開いて確かめる1件を入れる
  const known = `w25known${PFX}xxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 32)
  await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${N})
    INSERT INTO shift_report_tokens (token, shift_id, company_id, staff_id, expires_at, created_by)
    SELECT substr('w25lg${PFX}' || printf('%05d', i) || 'xxxxxxxxxxxxxxxxxxxxxxxx', 1, 32), ${S}, ${CO}, ${A.staff_id}, '${today} 23:59:59', 1 FROM n;
    INSERT INTO shift_report_tokens (token, shift_id, company_id, staff_id, expires_at, created_by) VALUES (${q(known)}, ${S}, ${CO}, ${A.staff_id}, '${today} 23:59:59', 1)`)
  const nulls = async () => Number((await sql('SELECT COUNT(*) AS n FROM shift_report_tokens WHERE token_hash IS NULL'))[0].n)
  const before = await nulls()
  ok('（前提）平文の行を入れた', before >= N + 1, before)

  const firstPlain = (await sql(`SELECT token FROM shift_report_tokens WHERE token LIKE 'w25lg${PFX}%' ORDER BY token LIMIT 1`))[0].token
  const left0 = before
  const runsBefore = Number((await sql('SELECT COALESCE(MAX(run_id), 0) AS m FROM cron_runs'))[0].m)
  ok('（前提）3:30 の cron を実行（1回目）', await cron(REPORTS) === 200)
  const run1 = (await sql(`SELECT status, cron, result_json FROM cron_runs WHERE job = 'report_token_hash' AND run_id > ${runsBefore} ORDER BY run_id DESC LIMIT 1`))[0]
  const r1 = run1 ? JSON.parse(run1.result_json) : {}
  const left1 = await nulls()
  ok('#9975 1回の起動で移すのは500件まで（残りの件数を記録する）', run1 && run1.status === 'ok' && run1.cron === REPORTS && r1.hashed === 500 && r1.remaining === left0 - 500 && left1 === left0 - 500, { run1, left0, left1 })
  // D1 の読み書きの行数（ローカルの D1 の meta.rows_read・rows_written を cron の結果に残す）
  console.log(`      読み書きの行数（ローカルの D1）: ${r1.hashed} 件のハッシュ化で rows_read=${r1.rows_read}・rows_written=${r1.rows_written}（1件あたり書き込み ${(r1.rows_written / r1.hashed).toFixed(1)} 行・読み取り ${(r1.rows_read / r1.hashed).toFixed(1)} 行）`)
  ok('#9975 1件あたりの書き込みは数行（表と索引）で、500件/日でも無料枠（10万行/日）の数%', r1.rows_written > 0 && r1.rows_written / r1.hashed <= 8, r1)
  ok('#9975 読み取りは、選んだ行と移す行の数程度（表全体を読まない）', r1.rows_read > 0 && r1.rows_read / r1.hashed <= 6, r1)
  ok('#9975 3:00 の起動では動かない（3:30 の起動だけ）', !(await sql(`SELECT 1 FROM cron_runs WHERE job = 'report_token_hash' AND cron <> '${REPORTS}'`)).length)
  const r2s = await cron(REPORTS)
  const run2 = (await sql(`SELECT status, result_json FROM cron_runs WHERE job = 'report_token_hash' ORDER BY run_id DESC LIMIT 1`))[0]
  const r2 = run2 ? JSON.parse(run2.result_json) : {}
  ok('#9975 次の起動で残りを移し、平文の行が無くなる', r2s === 200 && run2.status === 'ok' && r2.hashed === left1 && r2.remaining === 0 && await nulls() === 0, { run2, left1 })
  const mineRows = await sql(`SELECT token, token_hash FROM shift_report_tokens WHERE shift_id = ${S} AND created_by = 1`)
  ok('#9975 すべての行が token = token_hash = SHA-256（平文が残らない）', mineRows.length >= N + 1 && mineRows.every(r => r.token_hash && r.token === r.token_hash && /^[0-9a-f]{64}$/.test(r.token)) && !mineRows.some(r => r.token.startsWith('w25')), mineRows.slice(0, 3))
  ok('#9975 移した行は元の平文のハッシュ', mineRows.some(r => r.token_hash === sha256(known)) && mineRows.some(r => r.token_hash === sha256(firstPlain)))
  ok('#9975 移した後も、配った古いURLで開ける', await pub.get(known) === 200)
  ok('#9975 ハッシュの値そのものをURLにしても開けない', await pub.get(sha256(known)) === 404)
  await cron(REPORTS)
  const run3 = (await sql(`SELECT status, result_json FROM cron_runs WHERE job = 'report_token_hash' ORDER BY run_id DESC LIMIT 1`))[0]
  ok('#9975 移す行が無ければ何もしない（idle）', run3 && run3.status === 'ok' && JSON.parse(run3.result_json).idle === true && JSON.parse(run3.result_json).hashed === 0, run3)
  const st = must(await client(await login('sample', 'hq')).get('/api/hq/cron/status'), 'cron status')
  ok('#9975 本部画面の定期処理の一覧に出る（毎日の処理の目安25時間）', (st.stale_hours_by_job || {}).report_token_hash === 25, st.stale_hours_by_job)
}

// ---------- #9966 (4) --fix-refs: 基準のコミットに無いファイルの参照 ----------
{
  // 今のリポジトリを一時フォルダに写し（git clone --shared。元のリポジトリは変えない）、基準のコミットに無いファイルを足して参照を書き、
  // test-w13-docs-arch-ops.mjs（作業中のもの）を流して、その参照を「ずれた」と出さないことを確かめる
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let tmp = ''
  try {
    const head = git(ROOT, ['rev-parse', 'HEAD']).trim()
    tmp = mkdtempSync(join(tmpdir(), 'w25ref-'))
    git(tmp, ['clone', '-q', '--shared', '--no-checkout', ROOT, 'r'])
    const R = join(tmp, 'r')
    git(R, ['-c', 'core.autocrlf=false', 'checkout', '-q', head])
    copyFileSync(join(ROOT, 'scripts/test-w13-docs-arch-ops.mjs'), join(R, 'scripts/test-w13-docs-arch-ops.mjs'))
    const NEW = 'scripts/w25-new-file.txt'
    writeFileSync(join(R, NEW), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    git(R, ['add', '-N', NEW]) // 追跡するが、基準のコミットには無いファイル
    appendFileSync(join(R, 'docs/architecture.md'), `\n- w25 の確かめ: \`${NEW}:5\`\n`)
    let out = ''
    try { out = execFileSync(process.execPath, [join(R, 'scripts/test-w13-docs-arch-ops.mjs')], { cwd: R, encoding: 'utf8', env: { ...process.env, BASE }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }) } catch (e) { out = String(e.stdout || '') }
    const moved = out.split('\n').filter(l => l.includes(NEW))
    ok('#9966 基準のコミットに無いファイルへの参照は「ずれた」と出さない（--fix-refs で行番号を壊さない）', out.includes('資料の ファイル:行 の参照') && !moved.length, moved)
  } catch (e) {
    skip('#9966 --fix-refs の確かめ', `git が使えない: ${String(e.message || e).slice(0, 120)}`)
  } finally {
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
