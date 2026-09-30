// =========================================================
// スタッフマスタ（staff_rosters = staff_profiles）/ 企業間スタッフ連携
// docs/spec_multi_company_staff.md フェーズA〜C
//
// api.ts とのコンフリクトを避けるため、新規APIはこのファイルにまとめ、
// api.ts からは api.route('/admin/roster', rosterApi) で認証・権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// ---------- 定数 ----------
// daily_worker（自社日雇い）/ freelance（個人事業主）は第2段階で追加（docs/spec_spot_shift.md）
export const AFFILIATION_TYPES = ['own_employee', 'linked_external', 'partner_manual', 'skillsheet_only', 'daily_worker', 'freelance'] as const
export type AffiliationType = typeof AFFILIATION_TYPES[number]

// 所属元のみが編集できる「基本項目」（稼働先=linked_external 行では編集不可・所属元の値を参照表示）
export const ROSTER_BASE_FIELDS = [
  'kana', 'gender', 'date_of_birth', 'affiliation', 'affiliation_contact',
  'skills', 'career', 'work_area', 'age_group',
  'nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from',
] as const
// 稼働先でも編集できる「追記項目」（各社のスタッフマスタ行ごとに独立して保持）
export const ROSTER_APPEND_FIELDS = ['memo', 'follow_flag', 'retention_risk', 'evaluation_score', 'employment_status', 'site_evaluation', 'work_memo'] as const
// 追記項目のうち、所属元企業にも共有される項目（それ以外の memo 等は各社の社内情報）
export const ROSTER_SHARED_HOST_FIELDS = ['site_evaluation', 'work_memo'] as const

// ---------- フェーズD: 必須項目の企業別設定 ----------
// 絶対必須（全企業共通・設定不可）
export const ROSTER_ABSOLUTE_REQUIRED = [
  { code: 'name', label: '氏名' },
  { code: 'gender', label: '性別' },
]
// 企業ごとに必須/任意を切り替えられる項目（既定: 任意）
// skillsheet: ④スキルシートのみ作成でも入力を求めるか（false の項目は④では必須判定しない）
export const ROSTER_CONFIGURABLE_FIELDS: { code: string; label: string; skillsheet: boolean }[] = [
  { code: 'kana', label: 'フリガナ', skillsheet: true },
  { code: 'date_of_birth', label: '生年月日', skillsheet: true },
  { code: 'affiliation_contact', label: '所属先担当者名', skillsheet: false },
  { code: 'skills', label: 'スキル', skillsheet: true },
  { code: 'career', label: '経歴', skillsheet: true },
  { code: 'work_area', label: '稼働可能エリア', skillsheet: true },
  { code: 'nearest_station_line', label: '最寄駅（路線）', skillsheet: false },
  { code: 'nearest_station', label: '最寄駅（駅）', skillsheet: false },
  { code: 'commute_minutes', label: '通勤可能時間', skillsheet: false },
  { code: 'available_from', label: '稼働開始可能日', skillsheet: false },
]

export async function getRequiredFields(db: D1Database, companyId: number): Promise<Set<string>> {
  const rows = await db.prepare('SELECT field_code FROM roster_field_requirements WHERE company_id = ? AND is_required = 1').bind(companyId).all()
  const valid = new Set(ROSTER_CONFIGURABLE_FIELDS.map(f => f.code))
  return new Set((rows.results as any[]).map(r => r.field_code as string).filter(c => valid.has(c)))
}
function isBlank(v: any) { return v === undefined || v === null || String(v).trim() === '' }
/**
 * 企業の必須設定に対する不足項目のラベルを返す。
 * mode='create': body に無い/空の必須項目をすべて不足とする
 * mode='update': body に含まれていて空にしようとしている必須項目のみ不足とする（部分更新を妨げない）
 */
export function missingRequired(required: Set<string>, body: any, mode: 'create' | 'update', type?: string): string[] {
  return ROSTER_CONFIGURABLE_FIELDS
    .filter(f => required.has(f.code))
    .filter(f => !(type === 'skillsheet_only' && !f.skillsheet))
    .filter(f => mode === 'create' ? isBlank(body[f.code]) : (body[f.code] !== undefined && isBlank(body[f.code])))
    .map(f => f.label)
}

// 連携時の同意ポップアップで明示する共有範囲（フロント表示と同意履歴の双方で同じ文言を使う）
export const CONSENT_VERSION = 'v1'
export const SHARED_SCOPE = [
  '氏名', 'フリガナ', '性別', '生年月日・年齢', '年代', '所属会社名・所属先担当者名',
  '最寄駅', '通勤可能時間', '稼働開始可能日', '稼働可能エリア', 'スキル', '経歴',
]
export const NOT_SHARED_SCOPE = [
  '従業員管理の情報（雇用形態・給与・手当・口座・社会保険/雇用保険番号・緊急連絡先 等）',
  '連絡先（電話・メール）', '履歴書・入社時書類ファイル', '所属元の社内メモ・評価・フォロー履歴',
]

// ---------- ユーティリティ ----------
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
function randHex(bytes: number): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}
function nowJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}
// ログイン不可のユーザー行用。ランダム値のハッシュなので、どのパスワードとも一致しない
async function unusablePasswordHash(): Promise<string> { return sha256('!nologin!' + randHex(32)) }
function normalizeCode(code: string): string { return String(code || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '') }

/** 人物IDと恒久固定コード（QR/ID連携用）を採番する */
export async function createPerson(db: D1Database, companyId: number): Promise<{ person_id: string; global_staff_code: string }> {
  for (let i = 0; i < 5; i++) {
    const person_id = randHex(16)
    const global_staff_code = 'FS' + randHex(5).toUpperCase()
    try {
      await db.prepare('INSERT INTO persons (person_id, global_staff_code, created_company_id) VALUES (?, ?, ?)')
        .bind(person_id, global_staff_code, companyId).run()
      return { person_id, global_staff_code }
    } catch { /* コード衝突時は再採番 */ }
  }
  throw new Error('person id generation failed')
}

/**
 * 取引先（Field OS未契約の所属元）として登録しようとしている名前が、他の導入企業の会社名と一致するかを確認する。
 * 導入企業のスタッフは取引先ではなく ①QR/ID連携（linked_external）で扱うため、一致した場合はエラーメッセージを返す。
 */
export async function partnerNameConflict(db: D1Database, companyId: number, name: string | null | undefined): Promise<string | null> {
  const n = String(name || '').trim()
  if (!n) return null
  const hit = await db.prepare('SELECT 1 FROM companies WHERE company_name = ? AND company_id != ? LIMIT 1').bind(n, companyId).first()
  return hit ? `「${n}」はField OSの導入企業のため、取引先として登録できません（①QR/ID連携で登録してください）` : null
}

/**
 * スタッフマスタの基本項目を、linked_external 行なら所属元（source）の値で解決する SELECT 句を返す。
 * local = 自社の staff_profiles エイリアス / src = 所属元 staff_profiles エイリアス
 */
export function rosterBaseSelect(local = 'sp', src = 'src'): string {
  return ROSTER_BASE_FIELDS.map(f =>
    `CASE WHEN ${local}.affiliation_type = 'linked_external' THEN ${src}.${f} ELSE ${local}.${f} END AS ${f}`
  ).join(', ')
}

/**
 * 0012 以降に person_id を付けずに作られた staff_profiles（seed.sql の後投入、他経路の INSERT 等）を補完する。
 * 所属区分は 0012 の移行と同じルール（所属会社名=自社名/未設定 → own_employee、それ以外 → partner_manual）。
 * 冪等。person_id が NULL の行が無ければ何もしない。
 */
export async function ensureRosterIdentity(db: D1Database, companyId: number): Promise<void> {
  const missing = await db.prepare(`SELECT sp.staff_id, sp.user_id, sp.affiliation, sp.affiliation_type, co.company_name
    FROM staff_profiles sp JOIN companies co ON co.company_id = sp.company_id
    WHERE sp.company_id = ? AND sp.person_id IS NULL LIMIT 500`).bind(companyId).all()
  for (const r of missing.results as any[]) {
    const person = await createPerson(db, companyId)
    const type = r.affiliation && r.affiliation !== r.company_name ? 'partner_manual' : 'own_employee'
    await db.batch([
      db.prepare(`UPDATE staff_profiles SET person_id = ?, owner_company_id = COALESCE(owner_company_id, company_id),
        affiliation_type = CASE WHEN source_staff_id IS NULL THEN ? ELSE affiliation_type END WHERE staff_id = ? AND person_id IS NULL`).bind(person.person_id, type, r.staff_id),
      db.prepare('UPDATE users SET person_id = ? WHERE user_id = ? AND person_id IS NULL').bind(person.person_id, r.user_id),
    ])
    if (type === 'partner_manual' && r.affiliation) {
      await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(companyId, r.affiliation).run()
      await db.prepare(`UPDATE staff_profiles SET partner_affiliation_id = (SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?) WHERE staff_id = ?`)
        .bind(companyId, r.affiliation, r.staff_id).run()
    }
  }
}

/** スタッフマスタ1件を取得（基本項目は所属元の値で解決済み）。自社の行でなければ null */
export async function loadRoster(db: D1Database, staffId: string | number, companyId: number): Promise<any | null> {
  const row = await db.prepare(`
    SELECT sp.*, ${rosterBaseSelect()},
           us.user_code, us.name, us.email, us.phone, us.status, us.last_login_at, us.retired_at, us.role AS user_role,
           oc.company_name AS owner_company_name, pe.global_staff_code,
           pa.affiliation_name AS partner_name
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = sp.source_staff_id
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    LEFT JOIN staff_affiliations pa ON pa.affiliation_id = sp.partner_affiliation_id
    WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(staffId, companyId).first()
  if (!row) return null
  const type = (row.affiliation_type as string) || 'own_employee'
  return {
    ...row,
    affiliation_type: type,
    // 基本項目を編集できるのは所属元企業のみ（linked_external は稼働先なので不可）
    can_edit_base: type !== 'linked_external' && (row.owner_company_id == null || row.owner_company_id === companyId),
    // QR/ID で他社に連携できるのは自社雇用の元データのみ
    linkable: type === 'own_employee',
  }
}

/** 所属元（自社）で基本項目の名前が変わったとき、連携先各社のユーザー表示名も揃える */
export async function propagateNameToLinked(db: D1Database, sourceStaffId: number | string, name: string) {
  await db.prepare(`UPDATE users SET name = ? WHERE user_id IN (SELECT user_id FROM staff_profiles WHERE source_staff_id = ?)`)
    .bind(name, sourceStaffId).run()
}

// ---------- ルーティング ----------
const rosterApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()
rosterApi.use('/*', async (c, next) => { await ensureRosterIdentity(c.env.DB, c.get('user').company_id); return next() })

// 同意文面（共有範囲）— フロントのポップアップ表示用
rosterApi.get('/consent-terms', (c) => c.json({ version: CONSENT_VERSION, shared: SHARED_SCOPE, not_shared: NOT_SHARED_SCOPE }))

// 必須項目設定の取得
rosterApi.get('/field-settings', async (c) => {
  const u = c.get('user')
  const required = await getRequiredFields(c.env.DB, u.company_id)
  return c.json({
    absolute: ROSTER_ABSOLUTE_REQUIRED,
    fields: ROSTER_CONFIGURABLE_FIELDS.map(f => ({ ...f, is_required: required.has(f.code) })),
  })
})
// 必須項目設定の更新（会社管理者のみ）
rosterApi.put('/field-settings', async (c) => {
  const u = c.get('user')
  if (u.role !== 'company_admin') return c.json({ error: '必須項目の設定は会社管理者のみ変更できます' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const req: Record<string, boolean> = b.required || {}
  const valid = new Set(ROSTER_CONFIGURABLE_FIELDS.map(f => f.code))
  const stmts = Object.entries(req).filter(([k]) => valid.has(k)).map(([k, v]) =>
    c.env.DB.prepare(`INSERT INTO roster_field_requirements (company_id, field_code, is_required, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company_id, field_code) DO UPDATE SET is_required = excluded.is_required, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(u.company_id, k, v ? 1 : 0, u.user_id, nowJST()))
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

// ---------- フェーズE: QR（恒久固定のスタッフID） ----------
// 自社雇用スタッフの連携用ID（QRの中身）。再発行・有効期限なし。
rosterApi.get('/:id/share-code', async (c) => {
  const u = c.get('user')
  const r = await loadRoster(c.env.DB, c.req.param('id'), u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  if (!r.linkable) return c.json({ error: '連携用IDを共有できるのは自社雇用スタッフのみです' }, 400)
  return c.json({ global_staff_code: r.global_staff_code, name: r.name, company_name: r.owner_company_name })
})

// ---------- フェーズF: 所属元⇔稼働先の連携状況 ----------
// 所属元: 自社スタッフの連携先企業一覧 + 稼働先が記入した共有追記項目（閲覧のみ）
// 稼働先: 自社の連携レコードの同意履歴
rosterApi.get('/:id/links', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const sid = c.req.param('id')
  const r = await loadRoster(db, sid, u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  if (r.affiliation_type === 'linked_external') {
    const consents = await db.prepare(`
      SELECT rc.consent_id, rc.consent_version, rc.shared_scope, rc.created_at, um.name AS agreed_by
      FROM roster_consents rc LEFT JOIN users um ON um.user_id = rc.user_id
      WHERE rc.company_id = ? AND rc.staff_id = ? ORDER BY rc.created_at DESC`).bind(u.company_id, sid).all()
    return c.json({ role: 'host', owner_company_name: r.owner_company_name,
      consents: (consents.results as any[]).map(x => ({ ...x, shared_scope: safeJson(x.shared_scope) })) })
  }
  // 所属元が閲覧できるのは: 連携先企業名・連携日・共有追記項目（現場評価/稼働メモ）・稼働実績の件数のみ
  // （稼働先の社内メモ・フォロー履歴・日報本文等は返さない）
  const month = nowJST().slice(0, 7)
  const links = await db.prepare(`
    SELECT sp.staff_id AS linked_staff_id, co.company_name AS host_company_name, sp.created_at AS linked_at,
      sp.site_evaluation, sp.work_memo, sp.host_note_updated_at,
      (SELECT MIN(rc.created_at) FROM roster_consents rc WHERE rc.staff_id = sp.staff_id) AS consented_at,
      (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_days,
      (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.status IN ('confirmed','substitute')) AS last_work_date
    FROM staff_profiles sp JOIN companies co ON co.company_id = sp.company_id
    WHERE sp.source_staff_id = ? AND sp.affiliation_type = 'linked_external' ORDER BY sp.created_at`).bind(month + '%', sid).all()
  return c.json({ role: 'owner', links: links.results })
})

// 取引先（Field OS未契約の所属元）一覧: 自社名を除いた staff_affiliations
rosterApi.get('/partners', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT sa.affiliation_id, sa.affiliation_name, sa.contact_name, sa.phone, sa.email, sa.memo,
      (SELECT COUNT(*) FROM staff_profiles sp WHERE sp.partner_affiliation_id = sa.affiliation_id AND sp.company_id = sa.company_id) AS staff_count
    FROM staff_affiliations sa
    WHERE sa.company_id = ? AND sa.affiliation_name != (SELECT company_name FROM companies WHERE company_id = ?)
    ORDER BY sa.affiliation_name`).bind(u.company_id, u.company_id).all()
  return c.json({ partners: rows.results })
})

// ①QR/ID連携: コードから連携候補をプレビュー（同意前なので識別に必要な最小限のみ返す）
rosterApi.get('/lookup', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const code = normalizeCode(c.req.query('code') || '')
  if (!code) return c.json({ error: 'スタッフIDを入力してください' }, 400)
  const src = await findLinkSource(db, code)
  if (!src) return c.json({ error: '該当するスタッフが見つかりません（連携できるのは他社で自社雇用として登録されたスタッフのみです）' }, 404)
  if (src.company_id === u.company_id) return c.json({ error: '自社に登録済みのスタッフです' }, 409)
  const already = await db.prepare('SELECT staff_id FROM staff_profiles WHERE company_id = ? AND person_id = ?').bind(u.company_id, src.person_id).first()
  return c.json({
    candidate: {
      global_staff_code: src.global_staff_code, name: src.name, kana: src.kana, gender: src.gender,
      owner_company_name: src.owner_company_name,
    },
    already_linked_staff_id: already ? already.staff_id : null,
    consent: { version: CONSENT_VERSION, shared: SHARED_SCOPE, not_shared: NOT_SHARED_SCOPE },
  })
})

async function findLinkSource(db: D1Database, code: string): Promise<any | null> {
  return db.prepare(`
    SELECT sp.staff_id, sp.company_id, sp.person_id, sp.kana, sp.gender, us.name, us.role AS source_role, pe.global_staff_code, co.company_name AS owner_company_name
    FROM persons pe
    JOIN staff_profiles sp ON sp.person_id = pe.person_id AND sp.source_staff_id IS NULL AND sp.affiliation_type = 'own_employee'
    JOIN users us ON us.user_id = sp.user_id
    JOIN companies co ON co.company_id = sp.company_id
    WHERE pe.global_staff_code = ? ORDER BY sp.staff_id LIMIT 1`).bind(code).first()
}

// ①QR/ID連携: 同意の上で稼働先のスタッフマスタに連携登録する
rosterApi.post('/link', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const code = normalizeCode(b.code || '')
  if (b.agreed !== true) return c.json({ error: '共有される情報範囲への同意が必要です' }, 400)
  if (b.consent_version !== CONSENT_VERSION) return c.json({ error: '同意文面が更新されています。画面を再読み込みしてください' }, 409)
  const src = await findLinkSource(db, code)
  if (!src) return c.json({ error: '該当するスタッフが見つかりません' }, 404)
  if (src.company_id === u.company_id) return c.json({ error: '自社に登録済みのスタッフです' }, 409)
  const already = await db.prepare('SELECT staff_id FROM staff_profiles WHERE company_id = ? AND person_id = ?').bind(u.company_id, src.person_id).first()
  if (already) return c.json({ error: 'このスタッフは既に連携済みです', staff_id: already.staff_id }, 409)

  // 稼働先側のユーザー行（シフト・勤怠等の既存機能との互換用）。パスワードは照合不能＝稼働先の会社コードでは直接ログインできない。
  // 所属元でログインを持つスタッフは role='staff'（統合ログインの企業切替で稼働先の画面を利用可・フェーズH）、
  // ログインを持たない場合は role='roster_only'（お知らせ対象外）
  const userCode = 'LK-' + src.global_staff_code
  const linkedRole = src.source_role === 'staff' ? 'staff' : 'roster_only'
  const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, person_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, userCode, src.name, linkedRole, await unusablePasswordHash(), src.person_id).run()
  const sr = await db.prepare(`INSERT INTO staff_profiles (user_id, company_id, person_id, owner_company_id, affiliation_type, source_staff_id, affiliation)
    VALUES (?, ?, ?, ?, 'linked_external', ?, ?)`)
    .bind(r.meta.last_row_id, u.company_id, src.person_id, src.company_id, src.staff_id, src.owner_company_name).run()
  const staffId = sr.meta.last_row_id
  await db.prepare(`INSERT INTO roster_consents (company_id, user_id, person_id, source_staff_id, source_company_id, staff_id, consent_version, shared_scope, agreed, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(u.company_id, u.user_id, src.person_id, src.staff_id, src.company_id, staffId, CONSENT_VERSION, JSON.stringify(SHARED_SCOPE),
      c.req.header('cf-connecting-ip') || null, (c.req.header('user-agent') || '').slice(0, 300)).run()
  return c.json({ ok: true, staff_id: staffId })
})

// 同意履歴（自社が行った連携の同意記録）
rosterApi.get('/consents', async (c) => {
  const u = c.get('user')
  const sid = c.req.query('staff_id')
  const rows = await c.env.DB.prepare(`
    SELECT rc.consent_id, rc.staff_id, rc.consent_version, rc.shared_scope, rc.created_at,
           um.name AS agreed_by, co.company_name AS source_company_name, us.name AS staff_name
    FROM roster_consents rc
    LEFT JOIN users um ON um.user_id = rc.user_id
    LEFT JOIN companies co ON co.company_id = rc.source_company_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = rc.staff_id
    LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE rc.company_id = ? ${sid ? 'AND rc.staff_id = ?' : ''}
    ORDER BY rc.created_at DESC LIMIT 200`).bind(...(sid ? [u.company_id, sid] : [u.company_id])).all()
  return c.json({ consents: (rows.results as any[]).map(r => ({ ...r, shared_scope: safeJson(r.shared_scope) })) })
})
function safeJson(s: any) { try { return JSON.parse(s) } catch { return s } }

// ②従業員管理から作成 / ③取引先から作成 / ④スキルシートのみ作成
rosterApi.post('/', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const route = b.route as string
  const typeByRoute: Record<string, AffiliationType> = { employee: 'own_employee', partner: 'partner_manual', skillsheet: 'skillsheet_only' }
  const type = typeByRoute[route]
  if (!type) return c.json({ error: '作成方法が不正です' }, 400)

  const name = String(b.name || '').trim()
  // 絶対必須項目（企業ごとの必須設定の対象外）: 氏名・性別
  if (!name) return c.json({ error: '氏名は必須です' }, 400)
  if (!b.gender) return c.json({ error: '性別は必須です' }, 400)
  const missing = missingRequired(await getRequiredFields(db, u.company_id), b, 'create', type)
  if (missing.length) return c.json({ error: `次の項目は必須です: ${missing.join('・')}`, missing }, 400)

  // ログイン: ②は必須（自社スタッフとして勤怠報告等を行うため）、③は任意、④は作らない
  const wantsLogin = type === 'own_employee' || (type === 'partner_manual' && b.user_code && b.password)
  if (type === 'own_employee' && (!b.user_code || !b.password)) return c.json({ error: 'スタッフ番号・初期パスワードは必須です' }, 400)
  if (wantsLogin && String(b.password).length < 4) return c.json({ error: 'パスワードが短すぎます' }, 400)

  // 所属会社（取引先）の解決
  const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first())?.company_name as string) || ''
  let affiliation: string | null = null
  let partnerId: number | null = null
  if (type === 'own_employee') affiliation = ownName
  if (type === 'partner_manual') {
    if (b.partner_affiliation_id) {
      const p = await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?')
        .bind(b.partner_affiliation_id, u.company_id).first()
      if (!p) return c.json({ error: '取引先が見つかりません' }, 404)
      partnerId = p.affiliation_id as number; affiliation = p.affiliation_name as string
    } else if (b.new_partner_name && String(b.new_partner_name).trim()) {
      const pname = String(b.new_partner_name).trim()
      if (pname === ownName) return c.json({ error: '自社名は取引先として登録できません（②従業員管理から作成を選択してください）' }, 400)
      const conflict = await partnerNameConflict(db, u.company_id, pname)
      if (conflict) return c.json({ error: conflict }, 400)
      await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name, contact_name, phone, email) VALUES (?, ?, ?, ?, ?)')
        .bind(u.company_id, pname, b.new_partner_contact ?? null, b.new_partner_phone ?? null, b.new_partner_email ?? null).run()
      const p = await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(u.company_id, pname).first()
      partnerId = p?.affiliation_id as number; affiliation = pname
    } else {
      return c.json({ error: '取引先を選択または新規登録してください' }, 400)
    }
  }
  if (type === 'skillsheet_only') affiliation = b.affiliation ? String(b.affiliation) : null

  if (type === 'own_employee' && b.employee_number) {
    const dup = await db.prepare('SELECT 1 FROM employee_records WHERE company_id = ? AND employee_number = ?').bind(u.company_id, b.employee_number).first()
    if (dup) return c.json({ error: 'この社員番号は既に使用されています' }, 409)
  }

  const person = await createPerson(db, u.company_id)
  const userCode = wantsLogin ? String(b.user_code).trim() : (type === 'skillsheet_only' ? 'SS-' : 'PT-') + person.global_staff_code
  // ログインしない人物は role='roster_only'（お知らせ対象・スタッフ数集計・ログインの対象外）
  const role = wantsLogin ? 'staff' : 'roster_only'
  const pwHash = wantsLogin ? await sha256(String(b.password)) : await unusablePasswordHash()

  let userId: number
  try {
    const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, userCode, name, role, pwHash, wantsLogin ? (b.email || null) : null, b.phone || null, person.person_id).run()
    userId = r.meta.last_row_id as number
  } catch {
    await db.prepare('DELETE FROM persons WHERE person_id = ?').bind(person.person_id).run()
    return c.json({ error: 'スタッフ番号が重複しています' }, 409)
  }

  const sr = await db.prepare(`INSERT INTO staff_profiles
      (user_id, company_id, person_id, owner_company_id, affiliation_type, partner_affiliation_id, affiliation, affiliation_contact,
       kana, gender, date_of_birth, skills, career, work_area, nearest_station_line, nearest_station, commute_minutes, available_from, employment_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, u.company_id, person.person_id, u.company_id, type, partnerId, affiliation, b.affiliation_contact || null,
      b.kana || null, b.gender, b.date_of_birth || null, b.skills || '', b.career || '', b.work_area || '',
      b.nearest_station_line || null, b.nearest_station || null, b.commute_minutes ?? null, b.available_from || null,
      type === 'own_employee' ? (b.employment_status || 'working') : 'working').run()
  const staffId = sr.meta.last_row_id as number

  // ②では従業員管理（社員名簿）の最小レコードも同時に作成する
  if (type === 'own_employee' && (b.employee_number || b.hire_date || b.contract_type)) {
    await db.prepare('INSERT INTO employee_records (staff_id, company_id, employee_number, hire_date, contract_type, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(staffId, u.company_id, b.employee_number || null, b.hire_date || null, b.contract_type || null, nowJST()).run()
  }
  return c.json({ ok: true, staff_id: staffId, global_staff_code: person.global_staff_code })
})

// ---------- フェーズH: 同一人物の所属企業（統合ログイン・勤怠の自動振り分け） ----------
export type PersonStaffRow = { staff_id: number; company_id: number; user_id: number; company_name: string; settings_json: string }
/**
 * ログイン中ユーザーと同一人物（person_id）の、稼働管理対象のスタッフマスタ行を全企業分返す。
 * 対象: users.status='active' かつ role='staff'、skillsheet_only 以外。person_id が無い場合は自分の行のみ。
 */
export async function personStaffRows(db: D1Database, u: any): Promise<PersonStaffRow[]> {
  const self: PersonStaffRow[] = u.staff_id ? [{ staff_id: u.staff_id, company_id: u.company_id, user_id: u.user_id, company_name: u.company_name, settings_json: u.settings_json }] : []
  if (!u.person_id) return self
  const rows = await db.prepare(`
    SELECT sp.staff_id, sp.company_id, us.user_id, co.company_name, co.settings_json
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id JOIN companies co ON co.company_id = sp.company_id
    WHERE sp.person_id = ? AND us.person_id = ? AND us.status = 'active' AND us.role = 'staff' AND COALESCE(sp.affiliation_type, 'own_employee') != 'skillsheet_only'
    ORDER BY (sp.company_id != ?), sp.staff_id`).bind(u.person_id, u.person_id, u.company_id).all()
  const list = rows.results as PersonStaffRow[]
  if (u.staff_id && !list.some(r => r.staff_id === u.staff_id)) list.unshift(...self)
  return list
}

// ---------- スタッフ本人向け（/api/staff/me/*） ----------
// 本人は自分のスタッフマスタ基本項目と連携用IDのみ閲覧可。追記項目（評価・メモ）や企業間チャットは一切返さない。
export const staffSelfApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()
staffSelfApi.get('/profile', async (c) => {
  const u = c.get('user')
  if (!u.staff_id) return c.json({ error: 'not found' }, 404)
  const r = await loadRoster(c.env.DB, u.staff_id, u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  const pick: Record<string, any> = { name: r.name, affiliation_type: r.affiliation_type, company_name: u.company_name }
  for (const f of ROSTER_BASE_FIELDS) pick[f] = r[f]
  // 連携用ID（QR）は自社雇用の元データを持つ本人のみ表示
  pick.global_staff_code = r.linkable ? r.global_staff_code : null
  return c.json({ profile: pick })
})

// 所属企業の一覧（統合ログインの企業切替用）
staffSelfApi.get('/companies', async (c) => {
  const u = c.get('user')
  const rows = await personStaffRows(c.env.DB, u)
  return c.json({ current_company_id: u.company_id, companies: rows.map(r => ({ company_id: r.company_id, company_name: r.company_name, current: r.company_id === u.company_id })) })
})
// 企業切替: セッションを同一人物の別企業ユーザー行に付け替える（ログインは1つのまま。再ログイン不要）
staffSelfApi.post('/switch-company', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const target = (await personStaffRows(db, u)).find(r => r.company_id === Number(b.company_id))
  if (!target) return c.json({ error: '切り替え先の企業が見つかりません' }, 404)
  const token = getCookie(c, 'session')
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  await db.prepare('UPDATE sessions SET user_id = ?, company_id = ? WHERE token = ?').bind(target.user_id, target.company_id, token).run()
  return c.json({ ok: true, company_name: target.company_name })
})

export default rosterApi
