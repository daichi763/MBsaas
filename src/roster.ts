// =========================================================
// スタッフマスタ（staff_rosters = staff_profiles）/ 企業間スタッフ連携
// docs/spec_multi_company_staff.md フェーズA〜C
//
// api.ts とのコンフリクトを避けるため、新規APIはこのファイルにまとめ、
// api.ts からは api.route('/admin/roster', rosterApi) で認証・権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// ---------- 定数 ----------
export const AFFILIATION_TYPES = ['own_employee', 'linked_external', 'partner_manual', 'skillsheet_only'] as const
export type AffiliationType = typeof AFFILIATION_TYPES[number]

// 所属元のみが編集できる「基本項目」（稼働先=linked_external 行では編集不可・所属元の値を参照表示）
export const ROSTER_BASE_FIELDS = [
  'kana', 'gender', 'date_of_birth', 'affiliation', 'affiliation_contact',
  'skills', 'career', 'work_area', 'age_group',
  'nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from',
] as const
// 稼働先でも編集できる「追記項目」（各社のスタッフマスタ行ごとに独立して保持）
export const ROSTER_APPEND_FIELDS = ['memo', 'follow_flag', 'retention_risk', 'evaluation_score', 'employment_status'] as const

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
 * スタッフマスタの基本項目を、linked_external 行なら所属元（source）の値で解決する SELECT 句を返す。
 * local = 自社の staff_profiles エイリアス / src = 所属元 staff_profiles エイリアス
 */
export function rosterBaseSelect(local = 'sp', src = 'src'): string {
  return ROSTER_BASE_FIELDS.map(f =>
    `CASE WHEN ${local}.affiliation_type = 'linked_external' THEN ${src}.${f} ELSE ${local}.${f} END AS ${f}`
  ).join(', ')
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

// 同意文面（共有範囲）— フロントのポップアップ表示用
rosterApi.get('/consent-terms', (c) => c.json({ version: CONSENT_VERSION, shared: SHARED_SCOPE, not_shared: NOT_SHARED_SCOPE }))

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
    SELECT sp.staff_id, sp.company_id, sp.person_id, sp.kana, sp.gender, us.name, pe.global_staff_code, co.company_name AS owner_company_name
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

  // 稼働先側のユーザー行（シフト・勤怠等の既存機能との互換用）。
  // 本人のログインはフェーズHの統合ログイン（同一person_idの企業切替）で対応するため、現時点では role='roster_only'（ログイン不可・お知らせ対象外）
  const userCode = 'LK-' + src.global_staff_code
  const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, person_id) VALUES (?, ?, ?, 'roster_only', ?, ?)`)
    .bind(u.company_id, userCode, src.name, await unusablePasswordHash(), src.person_id).run()
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

export default rosterApi
