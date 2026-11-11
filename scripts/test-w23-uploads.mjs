// w23-uploads-mail（#9956 書類のアップロードを共通の関数に）の統合テスト
//  スタッフの書類・従業員の書類・クライアントの契約書・お知らせの添付の4か所で、上げる・落とす・消す・大きすぎる・種類が違う、
//  D1 で失敗したら R2 に残らないこと（お知らせの添付は件数の上限で断ったときも）。応答の形・文言・R2 のキーの形が変わらないこと。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8925 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（D1 の失敗を作るトリガーを一時的に足し、R2 の中身をローカルの保存先から読む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8925 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w23-uploads.mjs
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const BASE = process.env.BASE || 'http://127.0.0.1:8925'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
// d1() で待つ間に開発サーバーが閉じた接続を使い回すと ECONNRESET・ECONNABORTED になるので、そのときは1回だけ送り直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...a) => { try { return await rawFetch(...a) } catch (e) { if (e && e.cause && ['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(e.cause.code)) return rawFetch(...a); throw e } }
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
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data }
  }
  // files: [{ name, bytes, type }]、fields: ほかの項目
  const upload = async (path, files, fields = {}) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', new Blob([f.bytes], f.type ? { type: f.type } : {}), f.name)
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  const raw = async (path) => { const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } }); return { status: r.status, headers: r.headers, bytes: new Uint8Array(await r.arrayBuffer()) } }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), del: (p) => call('DELETE', p), upload, raw }
}
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
}
// ローカルの R2（miniflare）にある、prefix で始まるキー。保存先の SQLite を複製して読む
const { DatabaseSync } = await import('node:sqlite')
function r2Keys(prefix) {
  const dir = join(PERSIST, 'v3', 'r2', 'miniflare-R2BucketObject')
  if (!existsSync(dir)) return []
  const work = mkdtempSync(join(tmpdir(), 'w23up-r2-'))
  const keys = []
  try {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite')) {
      for (const ext of ['', '-wal', '-shm']) if (existsSync(join(dir, f + ext))) copyFileSync(join(dir, f + ext), join(work, f + ext))
      const db = new DatabaseSync(join(work, f))
      try { for (const r of db.prepare('SELECT key FROM _mf_objects WHERE key LIKE ?').all(prefix + '%')) keys.push(String(r.key)) } catch { }
      db.close()
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
  return keys
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const tag = Date.now().toString(36).slice(-5)

const PDF = new TextEncoder().encode('%PDF-1.4\n% w23 test\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
const BIG_DOC = new Uint8Array(20 * 1024 * 1024 + 1)
const BIG_NOTICE = new Uint8Array(10 * 1024 * 1024 + 1); BIG_NOTICE.set(PNG)
// ヘッダーの値は fetch では Latin-1 として読まれる（filename= には今までどおり UTF-8 のまま入れている）
const latin1 = (str) => Buffer.from(str, 'utf8').toString('latin1')
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const admin = client(await login('sample', 'admin'))
const [[me]] = d1(`SELECT company_id FROM users WHERE user_code = 'admin' AND company_id = (SELECT company_id FROM companies WHERE company_code = 'sample')`)
const CID = me.company_id

// ---------- 書類（スタッフ・従業員・クライアント）: 共通の確かめ方 ----------
async function documentSuite(label, { uploadPath, listPath, docBase, table, keyPrefix, docType }) {
  // 上げる（2つ同時。日本語のファイル名・種類と有効期限つき）
  const up = await admin.upload(uploadPath, [{ name: `契約書_${tag}.pdf`, bytes: PDF, type: 'application/pdf' }, { name: `memo${tag}.txt`, bytes: new TextEncoder().encode('メモ'), type: '' }],
    { doc_type: docType, valid_until: '2030-03-31' })
  ok(`${label}: 2つ上げると、ファイルごとに ok と document_id を返す`, up.status === 200 && up.data.results.length === 2 && up.data.results.every(r => r.ok === true && Number.isInteger(r.document_id))
    && JSON.stringify(Object.keys(up.data.results[0])) === JSON.stringify(['filename', 'ok', 'document_id']) && up.data.results[0].filename === `契約書_${tag}.pdf`, up)
  const id = up.data?.results?.[0]?.document_id
  const [[row]] = d1(`SELECT * FROM ${table} WHERE document_id = ${Number(id)}`)
  ok(`${label}: D1 に元のファイル名・形式・大きさ・種類・期限・登録者を残す`, row && row.original_file_name === `契約書_${tag}.pdf` && row.mime_type === 'application/pdf' && row.file_size === PDF.length
    && row.doc_type === docType && row.valid_until === '2030-03-31' && row.company_id === CID, row)
  ok(`${label}: R2 のキーは「${keyPrefix}/UUID/ファイル名」`, row && new RegExp(`^${keyPrefix}/${UUID}/契約書_${tag}\\.pdf$`).test(row.storage_key), row?.storage_key)
  ok(`${label}: R2 に置いてある`, row && r2Keys(row.storage_key).length === 1)
  const txtRow = d1(`SELECT mime_type FROM ${table} WHERE document_id = ${Number(up.data?.results?.[1]?.document_id)}`)[0][0]
  ok(`${label}: 形式の無いファイルは application/octet-stream で残す`, txtRow?.mime_type === 'application/octet-stream', txtRow)
  const list = await admin.get(listPath)
  ok(`${label}: 一覧に出る`, list.status === 200 && list.data.documents.some(d => d.document_id === id && d.original_file_name === `契約書_${tag}.pdf`), list.data)
  // 落とす
  const dl = await admin.raw(`${docBase}/${id}/download`)
  ok(`${label}: 落とすと、中身・形式・保存する形（attachment と日本語のファイル名）が合う`, dl.status === 200 && same(dl.bytes, PDF) && dl.headers.get('content-type') === 'application/pdf'
    && dl.headers.get('content-disposition') === `attachment; filename="${latin1(`契約書_${tag}.pdf`)}"; filename*=UTF-8''${encodeURIComponent(`契約書_${tag}.pdf`)}`
    && dl.headers.get('x-content-type-options') === 'nosniff' && dl.headers.get('cache-control') === 'private, max-age=0', [dl.status, Object.fromEntries(dl.headers)])
  ok(`${label}: 無い書類は 404（ファイルを取得できませんでした）`, (await admin.get(`${docBase}/99999999/download`)).data?.error === 'ファイルを取得できませんでした')
  // 消す
  const del = await admin.del(`${docBase}/${id}`)
  ok(`${label}: 消すと ok、D1 と R2 から消える`, del.status === 200 && del.data.ok === true && !d1(`SELECT 1 FROM ${table} WHERE document_id = ${Number(id)}`)[0].length && r2Keys(row.storage_key).length === 0, del)
  ok(`${label}: 消した後は落とせない（404）`, (await admin.raw(`${docBase}/${id}/download`)).status === 404)
  const del2 = await admin.del(`${docBase}/${id}`)
  ok(`${label}: もう無い書類を消すと 404（ファイルの削除に失敗しました）`, del2.status === 404 && del2.data.error === 'ファイルの削除に失敗しました', del2)
  // 大きすぎる・種類が違う（ほかのファイルは保存する）
  const bad = await admin.upload(uploadPath, [
    { name: `big${tag}.pdf`, bytes: BIG_DOC, type: 'application/pdf' },
    { name: `run${tag}.exe`, bytes: PDF, type: 'application/octet-stream' },
    { name: `fake${tag}.pdf`, bytes: PDF, type: 'text/html' },
    { name: `ok${tag}.csv`, bytes: new TextEncoder().encode('a,b\n1,2\n'), type: 'text/csv' },
  ])
  const r = bad.data?.results || []
  ok(`${label}: 20MB を超えるファイルは「ファイルサイズは20MB以下にしてください。」`, r[0]?.ok === false && r[0]?.error === 'ファイルサイズは20MB以下にしてください。', r[0])
  ok(`${label}: 対応していない拡張子は「このファイル形式には対応していません。」`, r[1]?.ok === false && r[1]?.error === 'このファイル形式には対応していません。', r[1])
  ok(`${label}: 拡張子と形式が合わないものも断る`, r[2]?.ok === false && r[2]?.error === 'このファイル形式には対応していません。', r[2])
  ok(`${label}: 同じ送信のほかのファイルは保存する`, r[3]?.ok === true && Number.isInteger(r[3]?.document_id), r[3])
  ok(`${label}: 断ったファイルは D1・R2 に残らない`, !d1(`SELECT 1 FROM ${table} WHERE original_file_name IN ('big${tag}.pdf','run${tag}.exe','fake${tag}.pdf')`)[0].length
    && !r2Keys(keyPrefix + '/').some(k => /\/(big|run|fake)[a-z0-9]+\.(pdf|exe)$/.test(k) && k.includes(tag)))
  // 送信データの誤り
  ok(`${label}: ファイルが無ければ 400（ファイルが選択されていません）`, (await admin.upload(uploadPath, [], { doc_type: docType })).data?.error === 'ファイルが選択されていません')
  const badType = await admin.upload(uploadPath, [{ name: 'x.pdf', bytes: PDF, type: 'application/pdf' }], { doc_type: 'nope-type' })
  ok(`${label}: 書類の種類が正しくなければ 400`, badType.status === 400 && badType.data.error === '書類の種類が正しくありません', badType)
  const badDate = await admin.upload(uploadPath, [{ name: 'x.pdf', bytes: PDF, type: 'application/pdf' }], { valid_until: '2030/3/31' })
  ok(`${label}: 有効期限の形が正しくなければ 400`, badDate.status === 400 && /2026-03-31/.test(badDate.data.error), badDate)
  const notForm = await fetch(`${BASE}${uploadPath}`, { method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: '{}' })
  ok(`${label}: フォームでなければ 400（送信データの形式が不正です）`, notForm.status === 400 && (await notForm.json()).error === '送信データの形式が不正です')
  // D1 で失敗したら R2 に残らない（トリガーで INSERT を失敗させる）
  const before = r2Keys(keyPrefix + '/').length
  d1(`CREATE TRIGGER w23_fail_ins BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'w23 test'); END`)
  try {
    await sleep(300)
    const f = await admin.upload(uploadPath, [{ name: `d1fail${tag}.pdf`, bytes: PDF, type: 'application/pdf' }])
    ok(`${label}: D1 の登録に失敗すると「ファイルの登録に失敗しました。」`, f.status === 200 && f.data.results[0].ok === false && f.data.results[0].error === 'ファイルの登録に失敗しました。', f)
    ok(`${label}: D1 の登録に失敗したファイルは R2 から消す`, r2Keys(keyPrefix + '/').length === before && !r2Keys(keyPrefix + '/').some(k => k.endsWith(`d1fail${tag}.pdf`)), r2Keys(keyPrefix + '/'))
  } finally { d1('DROP TRIGGER IF EXISTS w23_fail_ins') }
  // 削除で D1 が失敗したら 500 で、R2 は消さない
  const keep = r[3]?.document_id
  const [[keepRow]] = d1(`SELECT storage_key FROM ${table} WHERE document_id = ${Number(keep)}`)
  d1(`CREATE TRIGGER w23_fail_del BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'w23 test'); END`)
  try {
    await sleep(300)
    const f = await admin.del(`${docBase}/${keep}`)
    ok(`${label}: 削除で D1 が失敗すると 500 で、R2 は残す`, f.status === 500 && f.data.error === 'ファイルの削除に失敗しました' && r2Keys(keepRow.storage_key).length === 1, f)
  } finally { d1('DROP TRIGGER IF EXISTS w23_fail_del') }
  must(await admin.del(`${docBase}/${keep}`), 'cleanup')
}

// スタッフ
const staffList = must(await admin.get('/api/admin/staff'), 'staff').staff
const SID = staffList[0].staff_id
await documentSuite('スタッフの書類', { uploadPath: `/api/admin/staff/${SID}/documents`, listPath: `/api/admin/staff/${SID}/documents`, docBase: '/api/admin/staff/documents',
  table: 'staff_documents', keyPrefix: `staff-documents/${CID}/${SID}`, docType: 'resume' })
// 従業員
const emps = must(await admin.get('/api/admin/employees'), 'employees').employees
const EID = emps[0]?.staff_id
await documentSuite('従業員の書類', { uploadPath: `/api/admin/employees/${EID}/documents`, listPath: `/api/admin/employees/${EID}/documents`, docBase: '/api/admin/employees/documents',
  table: 'employee_documents', keyPrefix: `employee-documents/${CID}/${EID}`, docType: 'onboarding' })
// クライアント（R2 は CONTRACTS）
const clients = must(await admin.get('/api/admin/clients'), 'clients').clients
const CLID = clients[0].client_id
await documentSuite('クライアントの契約書', { uploadPath: `/api/admin/clients/${CLID}/documents`, listPath: `/api/admin/clients/${CLID}/documents`, docBase: '/api/admin/clients/documents',
  table: 'client_documents', keyPrefix: `client-documents/${CID}/${CLID}`, docType: 'contract_basic' })

// 他社の書類は落とせない・消せない
{
  const up = must(await admin.upload(`/api/admin/staff/${SID}/documents`, [{ name: `tenant${tag}.pdf`, bytes: PDF, type: 'application/pdf' }]), 'tenant up')
  const id = up.results[0].document_id
  const hq = client(await login('sample', 'hq'))
  const code = 'w23u' + tag
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `w23書類${tag}`, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const other = client(await login(code, 'admin'))
  ok('他社の管理者は書類を落とせない（404）', (await other.raw(`/api/admin/staff/documents/${id}/download`)).status === 404)
  ok('他社の管理者は書類を消せない（404）', (await other.del(`/api/admin/staff/documents/${id}`)).status === 404 && d1(`SELECT 1 FROM staff_documents WHERE document_id = ${id}`)[0].length === 1)
  ok('他社のスタッフには上げられない（404）', (await other.upload(`/api/admin/staff/${SID}/documents`, [{ name: 'x.pdf', bytes: PDF, type: 'application/pdf' }])).status === 404)
  must(await admin.del(`/api/admin/staff/documents/${id}`), 'tenant cleanup')
}

// ---------- お知らせの添付 ----------
{
  const n = must(await admin.post('/api/admin/notices', { title: `w23添付${tag}`, body: '本文', target_type: 'all', target_ids: '', mode: 'draft', client_request_id: `w23-${tag}-${Math.random()}` }), 'notice')
  const NID = n.notice_id
  const path = `/api/admin/notices/${NID}/attachments`
  const prefix = `notice-attachments/${CID}/${NID}/`
  const up = await admin.upload(path, [{ name: `売場図${tag}.png`, bytes: PNG, type: 'application/octet-stream' }, { name: `案内${tag}.pdf`, bytes: PDF, type: '' }])
  ok('お知らせの添付: 上げると、ファイルごとに ok と attachment_id を返す', up.status === 200 && up.data.results.length === 2 && up.data.results.every(r => r.ok && Number.isInteger(r.attachment_id))
    && JSON.stringify(Object.keys(up.data.results[0])) === JSON.stringify(['filename', 'ok', 'attachment_id']), up)
  const aid = up.data.results[0].attachment_id
  const [[row]] = d1(`SELECT * FROM notice_attachments WHERE attachment_id = ${aid}`)
  ok('お知らせの添付: 形式は拡張子から決める（送られた type は使わない）', row.content_type === 'image/png' && row.file_name === `売場図${tag}.png` && row.file_size === PNG.length, row)
  ok('お知らせの添付: R2 のキーは「notice-attachments/会社/お知らせ/UUID/ファイル名」', new RegExp(`^${prefix}${UUID}/売場図${tag}\\.png$`).test(row.storage_key) && r2Keys(row.storage_key).length === 1, row.storage_key)
  const g = await admin.raw(`${path}/${aid}`)
  ok('お知らせの添付: 落とすと中身が合い、画面に出す形（inline）', g.status === 200 && same(g.bytes, PNG) && g.headers.get('content-type') === 'image/png' && /^inline;/.test(g.headers.get('content-disposition') || '')
    && g.headers.get('cache-control') === 'private, max-age=300', [g.status, Object.fromEntries(g.headers)])
  const gd = await admin.raw(`${path}/${aid}?download=1`)
  ok('お知らせの添付: download=1 で保存する形（attachment）', gd.status === 200 && /^attachment;/.test(gd.headers.get('content-disposition') || ''), gd.headers.get('content-disposition'))
  const del = await admin.del(`${path}/${aid}`)
  ok('お知らせの添付: 消すと D1 と R2 から消える', del.status === 200 && del.data.ok && !d1(`SELECT 1 FROM notice_attachments WHERE attachment_id = ${aid}`)[0].length && r2Keys(row.storage_key).length === 0, del)
  ok('お知らせの添付: 消した後は 404', (await admin.raw(`${path}/${aid}`)).status === 404)
  const bad = await admin.upload(path, [
    { name: `big${tag}.png`, bytes: BIG_NOTICE, type: 'image/png' },
    { name: `doc${tag}.txt`, bytes: PDF, type: 'text/plain' },
    { name: `fake${tag}.png`, bytes: new TextEncoder().encode('<html>x</html>'), type: 'image/png' },
    { name: `empty${tag}.pdf`, bytes: new Uint8Array(0), type: 'application/pdf' },
  ])
  const r = bad.data?.results || []
  ok('お知らせの添付: 10MB を超えると「1つ10MB以下にしてください」', r[0]?.ok === false && r[0]?.error === '1つ10MB以下にしてください', r[0])
  ok('お知らせの添付: PDF・画像以外は「PDF か画像（JPEG・PNG・GIF・WebP）を選んでください」', r[1]?.ok === false && r[1]?.error === 'PDF か画像（JPEG・PNG・GIF・WebP）を選んでください', r[1])
  ok('お知らせの添付: 中身が拡張子と合わなければ断る', r[2]?.ok === false && r[2]?.error === 'ファイルの中身が拡張子の形式と合いません', r[2])
  ok('お知らせの添付: 空のファイルは「空のファイルです」', r[3]?.ok === false && r[3]?.error === '空のファイルです', r[3])
  ok('お知らせの添付: 断ったファイルは R2 に残らない', r2Keys(prefix).length === 1, r2Keys(prefix))
  ok('お知らせの添付: ファイルが無ければ 400', (await admin.upload(path, [])).data?.error === 'ファイルが選択されていません')
  // 件数の上限（5件）: 6件目は断り、R2 からも消す
  const many = await admin.upload(path, [1, 2, 3, 4, 5].map(i => ({ name: `p${i}.png`, bytes: PNG, type: 'image/png' })))
  const mr = many.data?.results || []
  ok('お知らせの添付: 上限を超えた分は「添付は1つのお知らせに5件までです」', mr.filter(x => x.ok).length === 4 && mr[4]?.ok === false && mr[4]?.error === '添付は1つのお知らせに5件までです', mr)
  ok('お知らせの添付: 上限で断ったファイルは R2 に残らない（5件だけ）', r2Keys(prefix).length === 5, r2Keys(prefix).length)
  // D1 で失敗したら R2 に残らない
  const one = mr.find(x => x.ok).attachment_id
  must(await admin.del(`${path}/${one}`), 'make room')
  d1(`CREATE TRIGGER w23_fail_na BEFORE INSERT ON notice_attachments BEGIN SELECT RAISE(ABORT, 'w23 test'); END`)
  try {
    await sleep(300)
    const f = await admin.upload(path, [{ name: `d1fail${tag}.png`, bytes: PNG, type: 'image/png' }])
    ok('お知らせの添付: D1 の登録に失敗すると「ファイルの登録に失敗しました」', f.data?.results?.[0]?.ok === false && f.data.results[0].error === 'ファイルの登録に失敗しました', f)
    ok('お知らせの添付: D1 の登録に失敗したファイルは R2 から消す', r2Keys(prefix).length === 4 && !r2Keys(prefix).some(k => k.endsWith(`d1fail${tag}.png`)), r2Keys(prefix))
  } finally { d1('DROP TRIGGER IF EXISTS w23_fail_na') }
  // 取り消したお知らせには添付できない（流れの前の確かめは変えない）
  const pub = must(await admin.post('/api/admin/notices', { title: `w23取消${tag}`, body: '本文', target_type: 'all', target_ids: '', client_request_id: `w23w-${tag}-${Math.random()}` }), 'notice2')
  must(await admin.post(`/api/admin/notices/${pub.notice_id}/withdraw`, { reason: 'テスト' }), 'withdraw')
  const w = await admin.upload(`/api/admin/notices/${pub.notice_id}/attachments`, [{ name: 'p.png', bytes: PNG, type: 'image/png' }])
  ok('お知らせの添付: 取り消したお知らせには添付できない（400）', w.status === 400 && w.data.error === '取り消したお知らせには添付できません', w)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
