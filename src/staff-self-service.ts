// =========================================================
// スタッフ本人の手続き（作業単位 w5-staff-self-service）
//   #272 登録情報の変更申請（本人が申請 → 管理者が承認したときだけ反映）
//   #288 入社書類・資格証・身分証などをスマホから提出（R2 の DOCUMENTS。保存先は既存の staff_documents）
//   #297 書類の種類と有効期限（3つの書類の表）と、期限切れ・期限の近い書類の一覧
//   #289 有給の残日数の表示と休暇の申請（自社雇用の社員だけ）
// api.ts とのコンフリクトを避けるため、新しい API はこのファイルにまとめ、api.ts からは
//   api.route('/staff/self', staffSelfServiceApi)（スタッフ本人。/staff/* のロール確認の後）
//   api.route('/admin/staff-requests', staffRequestsAdminApi(...))（管理者。/admin/* の権限確認の後）
// で登録する。承認した登録情報の反映は、スタッフマスタの保存と同じ確認・保存（api.ts の applyProfileUpdate など）を通すため、
// api.ts から関数を受け取る（循環 import を避ける）。
// 結果・依頼の知らせは既存のアプリ内通知（user_notifications）に1行ずつ入れる（メールは送らない）。
// =========================================================
import { Hono } from 'hono'
import { loadRoster } from './roster'
import { isISODate } from './lib/validate'

type Bindings = { DB: D1Database; DOCUMENTS: R2Bucket }
type Variables = { user: any }

// 通知を受け取る管理ロール（notifications.ts の NOTIFY_ADMIN_ROLES と同じ）と、労務情報を扱えるロール（api.ts の HR_ROLES と同じ）
const ADMIN_NOTIFY_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
const HR_ROLES = ['company_admin', 'office_staff']
const isHr = (u: any) => HR_ROLES.includes(u?.role)

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
const idParam = (v: string | undefined) => /^\d{1,12}$/.test(String(v || '')) ? Number(v) : null

// ---------- 書類の種類と有効期限（#297） ----------
export const DOC_TYPE_LABEL: Record<string, string> = {
  resume: '履歴書', qualification: '資格証', id_card: '身分証', residence_card: '在留カード', bank: '口座の確認書類',
  onboarding: '入社書類', contract_basic: '基本契約書', contract_individual: '個別契約書', other: 'その他',
}
// 書類の置き場所ごとに選べる種類（スタッフ・入社時書類 / クライアントの契約書）
export const DOC_TYPES_BY_KIND: Record<'staff' | 'employee' | 'client', string[]> = {
  staff: ['resume', 'qualification', 'id_card', 'residence_card', 'bank', 'onboarding', 'other'],
  employee: ['resume', 'qualification', 'id_card', 'residence_card', 'bank', 'onboarding', 'other'],
  client: ['contract_basic', 'contract_individual', 'other'],
}
// 期限が近いとみなす日数（一覧・バッジ）
export const DOC_EXPIRY_WARN_DAYS = 30
/** アップロード・編集で受け取った種類と有効期限を確かめる（空欄は NULL） */
export function parseDocMeta(kind: 'staff' | 'employee' | 'client', docType: unknown, validUntil: unknown): { doc_type: string | null; valid_until: string | null } | { error: string } {
  const t = String(docType ?? '').trim()
  if (t && !DOC_TYPES_BY_KIND[kind].includes(t)) return { error: '書類の種類が正しくありません' }
  const v = String(validUntil ?? '').trim()
  if (v && !isISODate(v)) return { error: '有効期限は「2026-03-31」の形式で入力してください' }
  return { doc_type: t || null, valid_until: v || null }
}

// ---------- アプリ内通知 ----------
// 管理者全員（roles）あて。dedupeId を渡すと、同じ種類・同じ対象の未読の通知がある人には重ねて入れない（書類の連続提出など）
async function notifyAdmins(db: D1Database, companyId: number, roles: string[], kind: string, title: string, body: string, link: string, relatedId: number, dedupe = false) {
  try {
    await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT ?, us.user_id, ?, ?, ?, ?, ?, ? FROM users us
      WHERE us.company_id = ? AND us.status = 'active' AND us.role IN (${roles.map(() => '?').join(',')})
      ${dedupe ? 'AND NOT EXISTS (SELECT 1 FROM user_notifications n WHERE n.user_id = us.user_id AND n.kind = ? AND n.related_id = ? AND n.read_at IS NULL)' : ''}`)
      .bind(companyId, kind, title, body, link, relatedId, nowJST(), companyId, ...roles, ...(dedupe ? [kind, relatedId] : [])).run()
  } catch (e) {
    console.log(`self-service notify failed: kind=${kind} related=${relatedId}`)
  }
}
async function notifyUser(db: D1Database, companyId: number, userId: number, kind: string, title: string, body: string, link: string, relatedId: number | null) {
  try {
    await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(companyId, userId, kind, title, body, link, relatedId, nowJST()).run()
  } catch (e) {
    console.log(`self-service notify failed: kind=${kind} related=${relatedId}`)
  }
}

// =========================================================
// #272 登録情報の変更申請
// =========================================================
// 本人が申請できる項目。最寄駅は基本項目（ROSTER_BASE_FIELDS）、通勤可能時間・稼働開始可能日・稼働エリア・スキルは業務側の項目、
// ログイン用メール（users.email）は承認後に確認用のリンクを送り、本人が確かめたときに有効になる（管理画面からの変更と同じ）。
// ログインには使わず、通知とパスワード再設定に使うため、表示の名前はそれが分かるものにする（#9414）
export const PROFILE_REQUEST_FIELDS = ['nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from', 'work_area', 'skills', 'login_email'] as const
export const PROFILE_REQUEST_LABEL: Record<string, string> = {
  nearest_station_line: '最寄駅（路線）', nearest_station: '最寄駅（駅）', commute_minutes: '通勤可能時間（分）', available_from: '稼働開始可能日',
  work_area: '稼働エリア', skills: 'スキル', login_email: 'メールアドレス（通知・パスワード再設定）',
}
const TEXT_MAX: Record<string, number> = { nearest_station_line: 100, nearest_station: 100, work_area: 200, skills: 1000 }
const NOTE_MAX = 500

/** 申請の値を確かめて正規化する（空欄は null。メール・数値・日付の形） */
function normalizeChanges(input: any): { changes: Record<string, any> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '変更の内容が正しくありません' }
  const out: Record<string, any> = {}
  for (const k of PROFILE_REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue
    const raw = input[k]
    if (raw !== null && typeof raw === 'object') return { error: `${PROFILE_REQUEST_LABEL[k]}の値が正しくありません` }
    const s = String(raw ?? '').trim()
    if (k === 'commute_minutes') {
      if (!s) { out[k] = null; continue }
      const n = Number(s)
      if (!Number.isInteger(n) || n < 0 || n > 1440) return { error: '通勤可能時間は0〜1440の整数（分）で入力してください' }
      out[k] = n
    } else if (k === 'available_from') {
      if (s && !isISODate(s)) return { error: '稼働開始可能日は「2026-04-01」の形式で入力してください' }
      out[k] = s || null
    } else if (k === 'login_email') {
      // メールは消す申請を受け付けない（パスワードを忘れたときの再設定に使うため。消すときは担当者に連絡する）
      if (!s) continue
      if (s.length > 254 || !/^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/.test(s)) return { error: 'メールアドレスの形式が正しくありません' }
      out[k] = s
    } else {
      if (s.length > TEXT_MAX[k]) return { error: `${PROFILE_REQUEST_LABEL[k]}は${TEXT_MAX[k]}文字以内で入力してください` }
      out[k] = s || null
    }
  }
  return { changes: out }
}
const sameValue = (a: any, b: any) => String(a ?? '').trim() === String(b ?? '').trim()

/**
 * 申請先（反映するスタッフマスタの行と会社）を決める。他社から連携された行は、基本項目を持つ雇用元の行と会社。
 * 申請を受け付けない行（統合済み・編集権のない行）はエラー
 */
async function resolveProfileTarget(db: D1Database, u: any): Promise<{ roster: any; company_id: number; company_name: string } | { error: string; status: 403 | 404 }> {
  if (!u.staff_id) return { error: 'スタッフの登録が見つかりません', status: 404 }
  const own = await loadRoster(db, u.staff_id, u.company_id)
  if (!own) return { error: 'スタッフの登録が見つかりません', status: 404 }
  if (own.merged_into_staff_id) return { error: 'この登録は統合済みのため、変更を申請できません', status: 403 }
  let roster = own, companyId = Number(u.company_id)
  if (own.affiliation_type === 'linked_external') {
    const src = await db.prepare(`SELECT s.staff_id, s.company_id FROM staff_profiles sp JOIN staff_profiles s ON s.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
      WHERE sp.staff_id = ?`).bind(u.staff_id).first() as any
    if (!src) return { error: '所属元の登録が見つからないため、変更を申請できません。所属会社の担当者に連絡してください', status: 404 }
    roster = await loadRoster(db, src.staff_id, src.company_id)
    companyId = Number(src.company_id)
    if (!roster || roster.merged_into_staff_id) return { error: '所属元の登録が見つからないため、変更を申請できません。所属会社の担当者に連絡してください', status: 404 }
  }
  if (roster.affiliation_type === 'linked_external' || !roster.can_edit_base) return { error: 'この登録の変更は受け付けていません。所属会社の担当者に連絡してください', status: 403 }
  const co = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(companyId).first() as any
  return { roster, company_id: companyId, company_name: co?.company_name || '' }
}
// 申請できる項目の今の値（ログイン用メールは伏せる）
function currentValues(roster: any, maskMail: boolean): Record<string, any> {
  const v: Record<string, any> = {}
  for (const k of PROFILE_REQUEST_FIELDS) v[k] = k === 'login_email' ? (maskMail ? maskEmail(roster.email) : (roster.email || null)) : (roster[k] ?? null)
  return v
}
function maskEmail(v: any): string | null {
  const s = String(v ?? '').trim()
  const at = s.lastIndexOf('@')
  if (!s || at < 1) return s ? '****' : null
  return s[0] + '***' + s.slice(at)
}
// ログイン用メールを申請できる行か（自社で発行したログインのある行。他社連携の LK- 行・ログインのない人は不可）
const canRequestEmail = (roster: any) => roster.user_role === 'staff' && !/^(LK|TMP)-/i.test(String(roster.user_code || ''))
const safeJson = (s: any) => { try { return JSON.parse(String(s || '{}')) } catch { return {} } }
function requestView(r: any, maskMail: boolean) {
  const ch = safeJson(r.changes_json), before = safeJson(r.before_json)
  if (maskMail) {
    if (ch.login_email) ch.login_email = maskEmail(ch.login_email)
    if (before.login_email) before.login_email = maskEmail(before.login_email)
  }
  return { request_id: r.request_id, status: r.status, changes: ch, before, note: r.note, review_comment: r.review_comment, reviewed_by_name: r.reviewed_by_name,
    reviewed_at: r.reviewed_at, created_at: r.created_at, company_name: r.company_name ?? undefined }
}

// =========================================================
// スタッフ本人の API（/api/staff/self/*）
// =========================================================
export const staffSelfServiceApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 『その他』のメニューの出し分け（有給・休暇は自社雇用の社員だけ）
staffSelfServiceApi.get('/summary', async (c) => {
  const u = c.get('user')
  return c.json({ leave_eligible: !!(await leaveEligibility(c.env.DB, u)) })
})

staffSelfServiceApi.get('/profile-requests', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await resolveProfileTarget(db, u)
  const rows = (await db.prepare(`SELECT r.*, co.company_name FROM profile_change_requests r LEFT JOIN companies co ON co.company_id = r.company_id
    WHERE r.requester_user_id = ? ${u.person_id ? 'OR r.person_id = ?' : ''} ORDER BY r.request_id DESC LIMIT 20`)
    .bind(u.user_id, ...(u.person_id ? [u.person_id] : [])).all()).results as any[]
  const requests = rows.map(r => requestView(r, true))
  if ('error' in t) return c.json({ available: false, reason: t.error, fields: PROFILE_REQUEST_FIELDS, labels: PROFILE_REQUEST_LABEL, requests })
  return c.json({ available: true, target_company_name: t.company_name, email_allowed: canRequestEmail(t.roster), current: currentValues(t.roster, true),
    fields: PROFILE_REQUEST_FIELDS, labels: PROFILE_REQUEST_LABEL, pending: requests.some(r => r.status === 'pending'), requests })
})

staffSelfServiceApi.post('/profile-requests', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => null) as any
  if (!b) return c.json({ error: '送信データの形式が不正です' }, 400)
  const t = await resolveProfileTarget(db, u)
  if ('error' in t) return c.json({ error: t.error }, t.status)
  const n = normalizeChanges(b.changes)
  if ('error' in n) return c.json({ error: n.error }, 400)
  if (n.changes.login_email !== undefined && !canRequestEmail(t.roster)) return c.json({ error: 'ログインのない登録のため、メールアドレス（通知・パスワード再設定）の変更は申請できません' }, 400)
  const current = currentValues(t.roster, false)
  // 今の値と同じ項目は申請に含めない
  const changes: Record<string, any> = {}, before: Record<string, any> = {}
  for (const [k, v] of Object.entries(n.changes)) {
    if (k === 'login_email' ? String(v).toLowerCase() === String(current[k] || '').trim().toLowerCase() : sameValue(v, current[k])) continue
    changes[k] = v; before[k] = current[k]
  }
  if (!Object.keys(changes).length) return c.json({ error: '変更する項目がありません（今の登録と同じです）' }, 400)
  const note = String(b.note ?? '').trim()
  if (note.length > NOTE_MAX) return c.json({ error: `補足は${NOTE_MAX}文字以内で入力してください` }, 400)
  // 承認待ちの申請は1件まで（取り消してから出し直す）
  const pending = await db.prepare(`SELECT 1 FROM profile_change_requests WHERE staff_id = ? AND company_id = ? AND status = 'pending' LIMIT 1`).bind(t.roster.staff_id, t.company_id).first()
  if (pending) return c.json({ error: '承認待ちの変更申請があります。内容を変えるときは、その申請を取り消してから出し直してください' }, 409)
  const r = await db.prepare(`INSERT INTO profile_change_requests (company_id, staff_id, requester_user_id, requester_company_id, person_id, changes_json, before_json, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(t.company_id, t.roster.staff_id, u.user_id, u.company_id, u.person_id || null, JSON.stringify(changes), JSON.stringify(before), note || null, nowJST()).run()
  const id = Number(r.meta.last_row_id)
  await notifyAdmins(db, t.company_id, ADMIN_NOTIFY_ROLES, 'profile_change_submitted', `登録情報の変更申請: ${t.roster.name || ''}`,
    Object.keys(changes).map(k => `${PROFILE_REQUEST_LABEL[k]}: ${k === 'login_email' ? '（変更あり）' : (changes[k] ?? '（空欄）')}`).join('\n'), '#staff-requests/profile', id)
  return c.json({ ok: true, request_id: id, target_company_name: t.company_name })
})

staffSelfServiceApi.post('/profile-requests/:id/cancel', async (c) => {
  const u = c.get('user'); const id = idParam(c.req.param('id'))
  if (!id) return c.json({ error: '申請が見つかりません' }, 404)
  const r = await c.env.DB.prepare(`UPDATE profile_change_requests SET status = 'cancelled', reviewed_at = ?
    WHERE request_id = ? AND status = 'pending' AND (requester_user_id = ? ${u.person_id ? 'OR person_id = ?' : ''})`)
    .bind(nowJST(), id, u.user_id, ...(u.person_id ? [u.person_id] : [])).run()
  if (!r.meta.changes) return c.json({ error: '取り消せる申請が見つかりません（すでに処理された可能性があります）' }, 409)
  return c.json({ ok: true })
})

// ---------- #288 書類の提出 ----------
// スマホから出す書類は写真（JPEG・PNG・WebP）と PDF に限る。1ファイル10MBまで。未確認のまま出せるのは30件まで
const STAFF_DOC_EXT: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const STAFF_DOC_MAX_BYTES = 10 * 1024 * 1024
const STAFF_DOC_PENDING_MAX = 30
// 拡張子と中身の先頭が合っているか（画像に見せかけた別の形式を受け付けない）
function magicMatches(ext: string, head: Uint8Array): boolean {
  const s = (from: number, len: number) => String.fromCharCode(...head.slice(from, from + len))
  if (ext === 'pdf') return s(0, 5) === '%PDF-'
  if (ext === 'jpg' || ext === 'jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  if (ext === 'png') return head[0] === 0x89 && s(1, 3) === 'PNG'
  if (ext === 'webp') return s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP'
  return false
}
const STAFF_DOC_COLS = `document_id, original_file_name, mime_type, file_size, doc_type, valid_until, confirmed_at, datetime(uploaded_at, '+9 hours') AS uploaded_at`

staffSelfServiceApi.get('/documents', async (c) => {
  const u = c.get('user')
  if (!u.staff_id) return c.json({ documents: [] })
  const rows = await c.env.DB.prepare(`SELECT ${STAFF_DOC_COLS} FROM staff_documents WHERE staff_id = ? AND company_id = ? AND submitted_by_staff = 1 ORDER BY document_id DESC LIMIT 100`)
    .bind(u.staff_id, u.company_id).all()
  return c.json({ company_name: u.company_name, documents: rows.results, types: DOC_TYPES_BY_KIND.staff, labels: DOC_TYPE_LABEL, warn_days: DOC_EXPIRY_WARN_DAYS })
})

staffSelfServiceApi.post('/documents', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ error: 'スタッフの登録が見つかりません' }, 404)
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: '送信データの形式が不正です' }, 400) }
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ error: 'ファイルが選択されていません' }, 400)
  const meta = parseDocMeta('staff', form.get('doc_type'), form.get('valid_until'))
  if ('error' in meta) return c.json({ error: meta.error }, 400)
  if (!meta.doc_type) return c.json({ error: '書類の種類を選んでください' }, 400)
  const m = /\.([a-zA-Z0-9]+)$/.exec(file.name || '')
  const ext = m ? m[1].toLowerCase() : ''
  if (!STAFF_DOC_EXT[ext]) return c.json({ error: '写真（JPEG・PNG・WebP）か PDF を選んでください' }, 400)
  if (file.size <= 0 || file.size > STAFF_DOC_MAX_BYTES) return c.json({ error: 'ファイルは10MB以下にしてください' }, 400)
  if (!magicMatches(ext, new Uint8Array(await file.slice(0, 12).arrayBuffer()))) return c.json({ error: 'ファイルの中身が形式と合いません。写真か PDF を選び直してください' }, 400)
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id = ? AND company_id = ? AND submitted_by_staff = 1 AND confirmed_at IS NULL')
    .bind(u.staff_id, u.company_id).first() as any
  if (Number(cnt?.n || 0) >= STAFF_DOC_PENDING_MAX) return c.json({ error: `確認待ちの書類が${STAFF_DOC_PENDING_MAX}件あります。担当者の確認を待ってから提出してください` }, 429)
  const name = String(file.name).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || `document.${ext}`
  const key = `staff-documents/${u.company_id}/${u.staff_id}/${crypto.randomUUID()}/${name.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 150)}`
  try {
    await c.env.DOCUMENTS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: STAFF_DOC_EXT[ext] } })
  } catch { return c.json({ error: 'ファイルのアップロードに失敗しました。もう一度お試しください' }, 500) }
  let id: number
  try {
    const r = await db.prepare(`INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, doc_type, valid_until, submitted_by_staff)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).bind(u.company_id, u.staff_id, name, key, STAFF_DOC_EXT[ext], file.size, u.user_id, meta.doc_type, meta.valid_until).run()
    id = Number(r.meta.last_row_id)
  } catch {
    await c.env.DOCUMENTS.delete(key).catch(() => {})
    return c.json({ error: 'ファイルの登録に失敗しました。もう一度お試しください' }, 500)
  }
  // 管理者へ（同じスタッフの未読の知らせがあれば重ねない）。リンクはスタッフ詳細の書類の欄
  await notifyAdmins(db, u.company_id, ADMIN_NOTIFY_ROLES, 'staff_document_submitted', `書類が提出されました: ${u.name || ''}`,
    `${DOC_TYPE_LABEL[meta.doc_type] || ''}: ${name}${meta.valid_until ? `（有効期限 ${meta.valid_until}）` : ''}`, `#staff/${u.staff_id}`, Number(u.staff_id), true)
  return c.json({ ok: true, document_id: id })
})

// 本人が出した書類だけを開ける（管理者が登録した書類・ほかの人の書類は開けない）
staffSelfServiceApi.get('/documents/:id/download', async (c) => {
  const u = c.get('user'); const id = idParam(c.req.param('id'))
  const doc = id && u.staff_id ? await c.env.DB.prepare('SELECT * FROM staff_documents WHERE document_id = ? AND staff_id = ? AND company_id = ? AND submitted_by_staff = 1')
    .bind(id, u.staff_id, u.company_id).first() as any : null
  if (!doc) return c.json({ error: 'ファイルを取得できませんでした' }, 404)
  const obj = await c.env.DOCUMENTS.get(doc.storage_key)
  if (!obj) return c.json({ error: 'ファイルを取得できませんでした' }, 404)
  const fname = String(doc.original_file_name).replace(/["\\]/g, '_')
  return c.body(obj.body, 200, {
    'Content-Type': doc.mime_type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(doc.original_file_name)}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=0',
  })
})

// 本人が削除できるのは、担当者がまだ確認していない書類だけ（D1 を先に消し、R2 は後で消す）
staffSelfServiceApi.delete('/documents/:id', async (c) => {
  const u = c.get('user'); const id = idParam(c.req.param('id'))
  const doc = id && u.staff_id ? await c.env.DB.prepare('SELECT storage_key FROM staff_documents WHERE document_id = ? AND staff_id = ? AND company_id = ? AND submitted_by_staff = 1')
    .bind(id, u.staff_id, u.company_id).first() as any : null
  if (!doc) return c.json({ error: '書類が見つかりません' }, 404)
  const r = await c.env.DB.prepare('DELETE FROM staff_documents WHERE document_id = ? AND confirmed_at IS NULL').bind(id).run()
  if (!r.meta.changes) return c.json({ error: '担当者が確認済みの書類は削除できません。差し替えるときは新しい書類を提出してください' }, 409)
  await c.env.DOCUMENTS.delete(doc.storage_key).catch(() => {})
  return c.json({ ok: true })
})

// ---------- #289 有給の残日数と休暇の申請 ----------
export const LEAVE_TYPE_LABEL: Record<string, string> = { paid: '有給休暇', other: 'その他の休暇（無給・特別休暇など）' }
export const LEAVE_UNIT_LABEL: Record<string, string> = { full: '全日', am: '午前半休', pm: '午後半休' }
const LEAVE_DAYS: Record<string, number> = { full: 1, am: 0.5, pm: 0.5 }
const LEAVE_PAST_DAYS = 31, LEAVE_FUTURE_DAYS = 366, LEAVE_REASON_MAX = 500
// 自社雇用の社員（従業員管理の対象で、雇用終了していない）か。従業員データがあればその行も返す
async function leaveEligibility(db: D1Database, u: any): Promise<any | null> {
  if (!u.staff_id) return null
  return await db.prepare(`SELECT sp.staff_id, er.employee_record_id, er.paid_leave_remaining, er.paid_leave_granted_at, er.telework_remaining_this_month, er.employment_ended_at
    FROM staff_profiles sp LEFT JOIN employee_records er ON er.staff_id = sp.staff_id AND er.company_id = sp.company_id
    WHERE sp.staff_id = ? AND sp.company_id = ? AND COALESCE(sp.affiliation_type, 'own_employee') = 'own_employee'
      AND COALESCE(sp.owner_company_id, sp.company_id) = sp.company_id AND sp.merged_into_staff_id IS NULL AND er.employment_ended_at IS NULL`)
    .bind(u.staff_id, u.company_id).first() as any
}
const LEAVE_COLS = `leave_id, leave_date, leave_type, leave_unit, days, reason, status, deducted_days, review_comment, reviewed_by_name, reviewed_at, created_at`
async function pendingPaidDays(db: D1Database, staffId: number, companyId: number): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(SUM(days), 0) AS d FROM leave_requests WHERE staff_id = ? AND company_id = ? AND status = 'pending' AND leave_type = 'paid'`)
    .bind(staffId, companyId).first() as any
  return Number(r?.d || 0)
}

staffSelfServiceApi.get('/leave', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const er = await leaveEligibility(db, u)
  if (!er) return c.json({ eligible: false })
  const rows = await db.prepare(`SELECT ${LEAVE_COLS} FROM leave_requests WHERE staff_id = ? AND company_id = ? ORDER BY leave_date DESC, leave_id DESC LIMIT 50`).bind(u.staff_id, u.company_id).all()
  return c.json({ eligible: true, company_name: u.company_name,
    balance: { paid_leave_remaining: er.paid_leave_remaining ?? null, paid_leave_granted_at: er.paid_leave_granted_at ?? null, telework_remaining_this_month: er.telework_remaining_this_month ?? null,
      pending_paid_days: await pendingPaidDays(db, u.staff_id, u.company_id) },
    requests: rows.results, type_labels: LEAVE_TYPE_LABEL, unit_labels: LEAVE_UNIT_LABEL })
})

staffSelfServiceApi.post('/leave', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const er = await leaveEligibility(db, u)
  if (!er) return c.json({ error: '休暇の申請は、自社雇用の社員のみ利用できます' }, 403)
  const b = await c.req.json().catch(() => null) as any
  if (!b) return c.json({ error: '送信データの形式が不正です' }, 400)
  const date = String(b.leave_date ?? '').trim(), type = String(b.leave_type ?? 'paid'), unit = String(b.leave_unit ?? 'full')
  const reason = String(b.reason ?? '').trim()
  if (!isISODate(date)) return c.json({ error: '日付を選んでください' }, 400)
  const today = todayJST()
  if (date < addDays(today, -LEAVE_PAST_DAYS) || date > addDays(today, LEAVE_FUTURE_DAYS)) return c.json({ error: `申請できるのは${LEAVE_PAST_DAYS}日前から1年先までの日付です` }, 400)
  if (!LEAVE_TYPE_LABEL[type]) return c.json({ error: '休暇の種類が正しくありません' }, 400)
  if (!LEAVE_UNIT_LABEL[unit]) return c.json({ error: '全日・半休の指定が正しくありません' }, 400)
  if (reason.length > LEAVE_REASON_MAX) return c.json({ error: `理由は${LEAVE_REASON_MAX}文字以内で入力してください` }, 400)
  const days = LEAVE_DAYS[unit]
  // 同じ日に重なる申請（全日どうし・全日と半休・同じ半休）は受け付けない
  const dup = await db.prepare(`SELECT 1 FROM leave_requests WHERE staff_id = ? AND company_id = ? AND leave_date = ? AND status IN ('pending', 'approved')
    AND (leave_unit = 'full' OR ? = 'full' OR leave_unit = ?) LIMIT 1`).bind(u.staff_id, u.company_id, date, unit, unit).first()
  if (dup) return c.json({ error: 'この日にはすでに休暇の申請があります' }, 409)
  if (type === 'paid' && er.paid_leave_remaining != null) {
    const left = Number(er.paid_leave_remaining) - await pendingPaidDays(db, u.staff_id, u.company_id)
    if (left < days) return c.json({ error: `有給の残日数が足りません（残り ${Number(er.paid_leave_remaining)}日、承認待ちを除くと ${Math.max(0, left)}日）` }, 400)
  }
  const r = await db.prepare(`INSERT INTO leave_requests (company_id, staff_id, requester_user_id, leave_date, leave_type, leave_unit, days, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(u.company_id, u.staff_id, u.user_id, date, type, unit, days, reason || null, nowJST()).run()
  const id = Number(r.meta.last_row_id)
  // 有給の承認は労務情報を扱えるロール（会社管理者・事務担当）だけが行うので、その人たちに知らせる
  await notifyAdmins(db, u.company_id, HR_ROLES, 'leave_submitted', `休暇の申請: ${u.name || ''} ${date}`,
    `${LEAVE_TYPE_LABEL[type]}（${LEAVE_UNIT_LABEL[unit]}）${reason ? '\n理由: ' + reason : ''}`, '#staff-requests/leave', id)
  return c.json({ ok: true, leave_id: id })
})

staffSelfServiceApi.post('/leave/:id/cancel', async (c) => {
  const u = c.get('user'); const id = idParam(c.req.param('id'))
  if (!id || !u.staff_id) return c.json({ error: '申請が見つかりません' }, 404)
  const r = await c.env.DB.prepare(`UPDATE leave_requests SET status = 'cancelled', reviewed_at = ? WHERE leave_id = ? AND staff_id = ? AND company_id = ? AND status = 'pending'`)
    .bind(nowJST(), id, u.staff_id, u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '取り消せる申請が見つかりません（すでに処理された可能性があります。承認後の取り消しは担当者に連絡してください）' }, 409)
  return c.json({ ok: true })
})

// =========================================================
// 管理者の API（/api/admin/staff-requests/*）
// =========================================================
export type ApplyProfileChange = (c: any, staffId: number, changes: Record<string, any>) => Promise<{ error: string; status: 400 | 403 | 404 | 409 } | { ok: true; login_email?: any }>

export function staffRequestsAdminApi(applyProfileChange: ApplyProfileChange) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

  // 画面の件数（メニューのバッジ・タブ）。休暇と入社時書類の期限は労務情報を扱えるロールだけ
  app.get('/summary', async (c) => {
    const u = c.get('user'); const db = c.env.DB
    const limit = addDays(todayJST(), DOC_EXPIRY_WARN_DAYS)
    const one = async (sql: string, ...binds: any[]) => Number(((await db.prepare(sql).bind(...binds).first()) as any)?.n || 0)
    const profile = await one(`SELECT COUNT(*) AS n FROM profile_change_requests WHERE company_id = ? AND status = 'pending'`, u.company_id)
    const unconfirmed = await one(`SELECT COUNT(*) AS n FROM staff_documents WHERE company_id = ? AND submitted_by_staff = 1 AND confirmed_at IS NULL`, u.company_id)
    const expiring = (await expiringDocuments(db, u, limit)).length
    const leave = isHr(u) ? await one(`SELECT COUNT(*) AS n FROM leave_requests WHERE company_id = ? AND status = 'pending'`, u.company_id) : null
    return c.json({ profile_pending: profile, documents_unconfirmed: unconfirmed, documents_expiring: expiring, leave_pending: leave, can_manage_leave: isHr(u),
      total: profile + unconfirmed + expiring + (leave || 0) })
  })

  // ---------- 登録情報の変更申請 ----------
  app.get('/profile', async (c) => {
    const u = c.get('user'); const db = c.env.DB
    const status = c.req.query('status') === 'all' ? 'all' : 'pending'
    const rows = (await db.prepare(`SELECT r.*, us.name AS staff_name, us.user_code, us.email AS cur_email,
        sp.nearest_station_line AS cur_nearest_station_line, sp.nearest_station AS cur_nearest_station, sp.commute_minutes AS cur_commute_minutes,
        sp.available_from AS cur_available_from, sp.work_area AS cur_work_area, sp.skills AS cur_skills, sp.affiliation_type,
        rq.company_id AS req_company_id, rco.company_name AS requester_company_name,
        CASE WHEN rsp.source_staff_id = r.staff_id THEN 1 ELSE 0 END AS direct_link
      FROM profile_change_requests r JOIN staff_profiles sp ON sp.staff_id = r.staff_id AND sp.company_id = r.company_id JOIN users us ON us.user_id = sp.user_id
      LEFT JOIN users rq ON rq.user_id = r.requester_user_id LEFT JOIN companies rco ON rco.company_id = r.requester_company_id
      LEFT JOIN staff_profiles rsp ON rsp.user_id = r.requester_user_id AND rsp.company_id = r.requester_company_id
      WHERE r.company_id = ? ${status === 'pending' ? `AND r.status = 'pending'` : ''} ORDER BY (r.status = 'pending') DESC, r.request_id DESC LIMIT 100`).bind(u.company_id).all()).results as any[]
    return c.json({ labels: PROFILE_REQUEST_LABEL, requests: rows.map(r => ({
      ...requestView(r, false), staff_id: r.staff_id, staff_name: r.staff_name, user_code: r.user_code,
      // 他社の稼働先に切り替えて出した申請。会社名は自社が直接連携した会社のときだけ出す
      // （多段連携の先の会社名を雇用元に見せると頭超えにつながるため、名前を伏せる）
      via_company_name: r.requester_company_id !== r.company_id ? (r.direct_link ? r.requester_company_name : '連携先の会社') : null,
      current: Object.fromEntries(PROFILE_REQUEST_FIELDS.map(k => [k, k === 'login_email' ? r.cur_email : r['cur_' + k]])),
    })) })
  })

  app.post('/profile/:id/approve', async (c) => {
    const u = c.get('user'); const db = c.env.DB; const id = idParam(c.req.param('id'))
    const b = await c.req.json().catch(() => ({} as any))
    const req = id ? await db.prepare(`SELECT * FROM profile_change_requests WHERE request_id = ? AND company_id = ?`).bind(id, u.company_id).first() as any : null
    if (!req) return c.json({ error: '申請が見つかりません' }, 404)
    const comment = String(b.comment ?? '').trim().slice(0, NOTE_MAX)
    // 先に承認済みにして二重の反映を防ぎ、反映できなかったら承認待ちに戻す
    const claim = await db.prepare(`UPDATE profile_change_requests SET status = 'approved', reviewed_by = ?, reviewed_by_name = ?, review_comment = ?, reviewed_at = ?
      WHERE request_id = ? AND company_id = ? AND status = 'pending'`).bind(u.user_id, u.name || '', comment || null, nowJST(), id, u.company_id).run()
    if (!claim.meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
    let res: Awaited<ReturnType<ApplyProfileChange>>
    try { res = await applyProfileChange(c, Number(req.staff_id), safeJson(req.changes_json)) } catch (e) { res = { error: '反映に失敗しました', status: 409 } }
    if ('error' in res) {
      await db.prepare(`UPDATE profile_change_requests SET status = 'pending', reviewed_by = NULL, reviewed_by_name = NULL, review_comment = NULL, reviewed_at = NULL WHERE request_id = ?`).bind(id).run()
      return c.json({ error: res.error }, res.status)
    }
    const ch = safeJson(req.changes_json)
    await notifyUser(db, req.requester_company_id, req.requester_user_id, 'profile_change_approved', '登録情報の変更が承認されました',
      [...Object.keys(ch).map(k => `${PROFILE_REQUEST_LABEL[k] || k}: ${k === 'login_email' ? '確認用のメールを送りました。メールのリンクを開くと切り替わります' : (ch[k] ?? '（空欄）')}`),
        ...(comment ? [`コメント: ${comment}`] : [])].join('\n'), '#profile-request', id)
    return c.json({ ok: true, login_email: (res as any).login_email })
  })

  app.post('/profile/:id/reject', async (c) => {
    const u = c.get('user'); const db = c.env.DB; const id = idParam(c.req.param('id'))
    const b = await c.req.json().catch(() => ({} as any))
    const comment = String(b.comment ?? '').trim()
    if (!comment) return c.json({ error: '見送る理由を入力してください（本人に伝わります）' }, 400)
    if (comment.length > NOTE_MAX) return c.json({ error: `理由は${NOTE_MAX}文字以内で入力してください` }, 400)
    const req = id ? await db.prepare(`SELECT * FROM profile_change_requests WHERE request_id = ? AND company_id = ?`).bind(id, u.company_id).first() as any : null
    if (!req) return c.json({ error: '申請が見つかりません' }, 404)
    const r = await db.prepare(`UPDATE profile_change_requests SET status = 'rejected', reviewed_by = ?, reviewed_by_name = ?, review_comment = ?, reviewed_at = ?
      WHERE request_id = ? AND company_id = ? AND status = 'pending'`).bind(u.user_id, u.name || '', comment, nowJST(), id, u.company_id).run()
    if (!r.meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
    await notifyUser(db, req.requester_company_id, req.requester_user_id, 'profile_change_rejected', '登録情報の変更申請が見送られました', `理由: ${comment}`, '#profile-request', id)
    return c.json({ ok: true })
  })

  // ---------- 書類（本人提出の確認・種類と期限の編集・期限の一覧） ----------
  app.get('/documents', async (c) => {
    const u = c.get('user'); const db = c.env.DB
    const unconfirmed = (await db.prepare(`SELECT d.document_id, d.staff_id, d.original_file_name, d.file_size, d.doc_type, d.valid_until, datetime(d.uploaded_at, '+9 hours') AS uploaded_at, us.name AS staff_name
      FROM staff_documents d JOIN staff_profiles sp ON sp.staff_id = d.staff_id JOIN users us ON us.user_id = sp.user_id
      WHERE d.company_id = ? AND d.submitted_by_staff = 1 AND d.confirmed_at IS NULL ORDER BY d.document_id LIMIT 200`).bind(u.company_id).all()).results
    const expiring = await expiringDocuments(db, u, addDays(todayJST(), DOC_EXPIRY_WARN_DAYS))
    return c.json({ today: todayJST(), warn_days: DOC_EXPIRY_WARN_DAYS, labels: DOC_TYPE_LABEL, unconfirmed, expiring })
  })

  // 種類・有効期限の変更と、本人提出の書類の確認（kind: staff / employee / client）
  app.put('/documents/:kind/:docId', async (c) => {
    const u = c.get('user'); const db = c.env.DB
    const kind = c.req.param('kind') as 'staff' | 'employee' | 'client'
    const id = idParam(c.req.param('docId'))
    const table = ({ staff: 'staff_documents', employee: 'employee_documents', client: 'client_documents' } as Record<string, string>)[kind]
    if (!table || !id) return c.json({ error: '書類が見つかりません' }, 404)
    if (kind === 'employee' && !isHr(u)) return c.json({ error: '入社時書類は、会社管理者と事務担当のみ編集できます', code: 'hr_forbidden' }, 403)
    const doc = await db.prepare(`SELECT document_id${kind === 'staff' ? ', submitted_by_staff, confirmed_at' : ''} FROM ${table} WHERE document_id = ? AND company_id = ?`).bind(id, u.company_id).first() as any
    if (!doc) return c.json({ error: '書類が見つかりません' }, 404)
    const b = await c.req.json().catch(() => ({} as any))
    const sets: string[] = [], binds: any[] = []
    if (b.doc_type !== undefined || b.valid_until !== undefined) {
      const meta = parseDocMeta(kind, b.doc_type, b.valid_until)
      if ('error' in meta) return c.json({ error: meta.error }, 400)
      if (b.doc_type !== undefined) { sets.push('doc_type = ?'); binds.push(meta.doc_type) }
      if (b.valid_until !== undefined) { sets.push('valid_until = ?'); binds.push(meta.valid_until) }
    }
    if (b.confirmed === true) {
      if (kind !== 'staff' || !doc.submitted_by_staff) return c.json({ error: '本人が提出した書類だけを確認済みにできます' }, 400)
      if (!doc.confirmed_at) { sets.push('confirmed_at = ?', 'confirmed_by = ?'); binds.push(nowJST(), u.user_id) }
    }
    if (!sets.length) return c.json({ ok: true })
    await db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE document_id = ? AND company_id = ?`).bind(...binds, id, u.company_id).run()
    return c.json({ ok: true })
  })

  // ---------- 休暇（会社管理者・事務担当のみ） ----------
  app.use('/leave', async (c, next) => isHr(c.get('user')) ? next() : c.json({ error: '休暇の申請は、会社管理者と事務担当のみ扱えます', code: 'hr_forbidden' }, 403))
  app.use('/leave/*', async (c, next) => isHr(c.get('user')) ? next() : c.json({ error: '休暇の申請は、会社管理者と事務担当のみ扱えます', code: 'hr_forbidden' }, 403))

  app.get('/leave', async (c) => {
    const u = c.get('user'); const db = c.env.DB
    const staffId = idParam(c.req.query('staff_id'))
    const all = c.req.query('status') === 'all'
    const where = ['l.company_id = ?']; const binds: any[] = [u.company_id]
    if (staffId) { where.push('l.staff_id = ?'); binds.push(staffId) }
    if (!all) where.push(`l.status = 'pending'`)
    const rows = await db.prepare(`SELECT ${LEAVE_COLS.split(', ').map(k => 'l.' + k).join(', ')}, l.staff_id, us.name AS staff_name, er.paid_leave_remaining,
        (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = l.staff_id AND s.company_id = l.company_id AND s.work_date = l.leave_date AND s.status IN ('confirmed', 'substitute', 'requested')) AS shift_count
      FROM leave_requests l JOIN staff_profiles sp ON sp.staff_id = l.staff_id JOIN users us ON us.user_id = sp.user_id
      LEFT JOIN employee_records er ON er.staff_id = l.staff_id AND er.company_id = l.company_id
      WHERE ${where.join(' AND ')} ORDER BY (l.status = 'pending') DESC, l.leave_date DESC, l.leave_id DESC LIMIT 200`).bind(...binds).all()
    return c.json({ requests: rows.results, type_labels: LEAVE_TYPE_LABEL, unit_labels: LEAVE_UNIT_LABEL })
  })

  // 承認: 有給は従業員データの有給残数から引く（残数が未入力・足りないときは承認しない）。その日のシフトは自動では変えない（画面で欠勤の処理を案内する）
  app.post('/leave/:id/approve', async (c) => {
    const u = c.get('user'); const db = c.env.DB; const id = idParam(c.req.param('id'))
    const b = await c.req.json().catch(() => ({} as any))
    const comment = String(b.comment ?? '').trim().slice(0, LEAVE_REASON_MAX)
    const l = id ? await db.prepare('SELECT * FROM leave_requests WHERE leave_id = ? AND company_id = ?').bind(id, u.company_id).first() as any : null
    if (!l) return c.json({ error: '申請が見つかりません' }, 404)
    if (l.status !== 'pending') return c.json({ error: 'この申請はすでに処理されています' }, 409)
    if (l.leave_type === 'paid') {
      const er = await db.prepare('SELECT paid_leave_remaining FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(l.staff_id, u.company_id).first() as any
      if (!er || er.paid_leave_remaining == null) return c.json({ error: '有給残数が未入力です。従業員管理で有給残数を入力してから承認してください' }, 400)
      if (Number(er.paid_leave_remaining) < Number(l.days)) return c.json({ error: `有給の残日数が足りません（残り ${Number(er.paid_leave_remaining)}日）` }, 409)
    }
    const at = nowJST()
    const claim = await db.prepare(`UPDATE leave_requests SET status = 'approved', deducted_days = ?, reviewed_by = ?, reviewed_by_name = ?, review_comment = ?, reviewed_at = ?
      WHERE leave_id = ? AND company_id = ? AND status = 'pending'`).bind(l.leave_type === 'paid' ? Number(l.days) : 0, u.user_id, u.name || '', comment || null, at, id, u.company_id).run()
    if (!claim.meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
    if (l.leave_type === 'paid') {
      // 残数が足りるときだけ引く（同時に別の申請を承認して足りなくなったら、承認待ちに戻す）
      const d = await db.prepare(`UPDATE employee_records SET paid_leave_remaining = paid_leave_remaining - ?, updated_at = ?
        WHERE staff_id = ? AND company_id = ? AND paid_leave_remaining >= ?`).bind(Number(l.days), at, l.staff_id, u.company_id, Number(l.days)).run()
      if (!d.meta.changes) {
        await db.prepare(`UPDATE leave_requests SET status = 'pending', deducted_days = 0, reviewed_by = NULL, reviewed_by_name = NULL, review_comment = NULL, reviewed_at = NULL WHERE leave_id = ?`).bind(id).run()
        return c.json({ error: '有給の残日数が足りません' }, 409)
      }
    }
    const sc = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ? AND company_id = ? AND work_date = ? AND status IN ('confirmed', 'substitute', 'requested')`)
      .bind(l.staff_id, u.company_id, l.leave_date).first() as any
    await notifyUser(db, u.company_id, l.requester_user_id, 'leave_approved', `休暇が承認されました: ${l.leave_date}`,
      [`${LEAVE_TYPE_LABEL[l.leave_type] || ''}（${LEAVE_UNIT_LABEL[l.leave_unit] || ''}）`, ...(comment ? [`コメント: ${comment}`] : [])].join('\n'), '#my-leave', id)
    return c.json({ ok: true, shift_count: Number(sc?.n || 0) })
  })

  app.post('/leave/:id/reject', async (c) => {
    const u = c.get('user'); const db = c.env.DB; const id = idParam(c.req.param('id'))
    const b = await c.req.json().catch(() => ({} as any))
    const comment = String(b.comment ?? '').trim()
    if (!comment) return c.json({ error: '見送る理由を入力してください（本人に伝わります）' }, 400)
    if (comment.length > LEAVE_REASON_MAX) return c.json({ error: `理由は${LEAVE_REASON_MAX}文字以内で入力してください` }, 400)
    const l = id ? await db.prepare('SELECT * FROM leave_requests WHERE leave_id = ? AND company_id = ?').bind(id, u.company_id).first() as any : null
    if (!l) return c.json({ error: '申請が見つかりません' }, 404)
    const r = await db.prepare(`UPDATE leave_requests SET status = 'rejected', reviewed_by = ?, reviewed_by_name = ?, review_comment = ?, reviewed_at = ?
      WHERE leave_id = ? AND company_id = ? AND status = 'pending'`).bind(u.user_id, u.name || '', comment, nowJST(), id, u.company_id).run()
    if (!r.meta.changes) return c.json({ error: 'この申請はすでに処理されています' }, 409)
    await notifyUser(db, u.company_id, l.requester_user_id, 'leave_rejected', `休暇の申請が見送られました: ${l.leave_date}`, `理由: ${comment}`, '#my-leave', id)
    return c.json({ ok: true })
  })

  // 承認の取り消し（予定の変更など）。引いた有給を戻す
  app.post('/leave/:id/revoke', async (c) => {
    const u = c.get('user'); const db = c.env.DB; const id = idParam(c.req.param('id'))
    const b = await c.req.json().catch(() => ({} as any))
    const comment = String(b.comment ?? '').trim()
    if (!comment) return c.json({ error: '取り消す理由を入力してください（本人に伝わります）' }, 400)
    const l = id ? await db.prepare('SELECT * FROM leave_requests WHERE leave_id = ? AND company_id = ?').bind(id, u.company_id).first() as any : null
    if (!l) return c.json({ error: '申請が見つかりません' }, 404)
    const at = nowJST()
    const r = await db.prepare(`UPDATE leave_requests SET status = 'cancelled', reviewed_by = ?, reviewed_by_name = ?, review_comment = ?, reviewed_at = ?
      WHERE leave_id = ? AND company_id = ? AND status = 'approved'`).bind(u.user_id, u.name || '', comment.slice(0, LEAVE_REASON_MAX), at, id, u.company_id).run()
    if (!r.meta.changes) return c.json({ error: '承認済みの申請だけを取り消せます' }, 409)
    if (Number(l.deducted_days) > 0) {
      await db.prepare(`UPDATE employee_records SET paid_leave_remaining = COALESCE(paid_leave_remaining, 0) + ?, updated_at = ? WHERE staff_id = ? AND company_id = ?`)
        .bind(Number(l.deducted_days), at, l.staff_id, u.company_id).run()
    }
    await notifyUser(db, u.company_id, l.requester_user_id, 'leave_revoked', `休暇の承認が取り消されました: ${l.leave_date}`, `理由: ${comment}`, '#my-leave', id)
    return c.json({ ok: true, restored_days: Number(l.deducted_days) || 0 })
  })

  return app
}

/**
 * 有効期限が limit 以前（期限切れを含む）の書類。スタッフの書類（在籍中の人）・クライアントの契約書、
 * 労務情報を扱えるロールには入社時書類（雇用終了していない社員）も含める
 */
async function expiringDocuments(db: D1Database, u: any, limit: string): Promise<any[]> {
  const staff = (await db.prepare(`SELECT 'staff' AS kind, d.document_id, d.staff_id AS owner_id, us.name AS owner_name, d.original_file_name, d.doc_type, d.valid_until
    FROM staff_documents d JOIN staff_profiles sp ON sp.staff_id = d.staff_id JOIN users us ON us.user_id = sp.user_id
    WHERE d.company_id = ? AND d.valid_until IS NOT NULL AND d.valid_until <= ? AND us.status = 'active' AND COALESCE(sp.employment_status, 'working') != 'retired' AND sp.merged_into_staff_id IS NULL
    ORDER BY d.valid_until LIMIT 200`).bind(u.company_id, limit).all()).results as any[]
  const client = (await db.prepare(`SELECT 'client' AS kind, d.document_id, d.client_id AS owner_id, cl.client_name AS owner_name, d.original_file_name, d.doc_type, d.valid_until
    FROM client_documents d JOIN clients cl ON cl.client_id = d.client_id AND cl.company_id = d.company_id
    WHERE d.company_id = ? AND d.valid_until IS NOT NULL AND d.valid_until <= ? ORDER BY d.valid_until LIMIT 200`).bind(u.company_id, limit).all()).results as any[]
  const employee = isHr(u) ? (await db.prepare(`SELECT 'employee' AS kind, d.document_id, d.staff_id AS owner_id, us.name AS owner_name, d.original_file_name, d.doc_type, d.valid_until
    FROM employee_documents d JOIN staff_profiles sp ON sp.staff_id = d.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = d.staff_id AND er.company_id = d.company_id
    WHERE d.company_id = ? AND d.valid_until IS NOT NULL AND d.valid_until <= ? AND er.employment_ended_at IS NULL AND COALESCE(sp.employment_status, 'working') != 'retired'
    ORDER BY d.valid_until LIMIT 200`).bind(u.company_id, limit).all()).results as any[] : []
  return [...staff, ...client, ...employee].sort((a, b) => String(a.valid_until).localeCompare(String(b.valid_until)))
}
