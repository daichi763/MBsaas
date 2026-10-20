// =========================================================
// スタッフマスタ（staff_rosters = staff_profiles）/ 企業間スタッフ連携
// docs/spec_multi_company_staff.md フェーズA〜C
//
// api.ts とのコンフリクトを避けるため、新規APIはこのファイルにまとめ、
// api.ts からは api.route('/admin/roster', rosterApi) で認証・権限ミドルウェアの後に登録する。
// =========================================================
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { hashPassword, validatePassword, hashToken, isCompanyActive } from './lib/auth'
import { isISODate } from './lib/validate'
import { countUnreadNotices } from './lib/notices'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// ---------- 定数 ----------
// daily_worker（自社日雇い）/ freelance（個人事業主）は第2段階で追加（docs/spec_spot_shift.md）
export const AFFILIATION_TYPES = ['own_employee', 'linked_external', 'partner_manual', 'skillsheet_only', 'daily_worker', 'freelance'] as const
export type AffiliationType = typeof AFFILIATION_TYPES[number]

// 所属元のみが編集できる「基本項目」（稼働先=linked_external 行では編集不可・所属元の値を参照表示）
export const ROSTER_BASE_FIELDS = [
  'kana', 'gender', 'date_of_birth', 'affiliation', 'affiliation_contact',
  'skills', 'career', 'career_rows', 'work_area', 'age_group',
  'nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from',
  'pr_points', 'remarks',
] as const
// スタッフマスタ画面で扱う「業務側」の項目（社員名簿=労務側 / スタッフマスタ=業務側）。
// linked_external（他社連携）以外の全区分（自社雇用を含む）でスタッフマスタ画面から編集できる。
// pr_points / remarks も基本項目として連携先に共有する（その会社独自の情報は「管理者メモ」に書く運用）
export const ROSTER_BUSINESS_FIELDS = ['commute_minutes', 'available_from', 'work_area', 'skills', 'career', 'career_rows', 'pr_points', 'remarks'] as const
export type CareerRow = { from: string; to: string; company: string; work: string; note: string }
const CAREER_MAX_ROWS = 50
function normYm(v: any): string | null {
  const t = String(v ?? '').trim()
  if (!t) return ''
  const m = t.match(/^(\d{4})[-/.年](\d{1,2})月?$/)
  if (!m) return null
  const mo = Number(m[2]); if (mo < 1 || mo > 12) return null
  return `${m[1]}-${String(mo).padStart(2, '0')}`
}
/** 経歴テーブルの入力を検証・正規化する。空行は捨てる。エラー時は { error } */
export function normalizeCareerRows(input: any): { rows: CareerRow[] } | { error: string } {
  if (input === null || input === '') return { rows: [] }
  let arr = input
  if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { return { error: '経歴の形式が不正です' } } }
  if (!Array.isArray(arr)) return { error: '経歴の形式が不正です' }
  const rows: CareerRow[] = []
  for (const [i, r] of arr.entries()) {
    if (!r || typeof r !== 'object') return { error: '経歴の形式が不正です' }
    const s = (v: any) => String(v ?? '').trim()
    const row = { from: normYm(r.from), to: normYm(r.to), company: s(r.company), work: s(r.work), note: s(r.note) }
    if (row.from === null || row.to === null) return { error: `経歴 ${i + 1}行目: 開始・終了は「2024-04」の形式（年月）で入力してください` }
    if (!row.from && !row.to && !row.company && !row.work && !row.note) continue
    if (row.from && row.to && row.from > row.to) return { error: `経歴 ${i + 1}行目: 終了年月が開始年月より前になっています` }
    if (row.company.length > 200 || row.work.length > 1000 || row.note.length > 1000) return { error: `経歴 ${i + 1}行目: 入力が長すぎます` }
    rows.push(row as CareerRow)
  }
  if (rows.length > CAREER_MAX_ROWS) return { error: `経歴は${CAREER_MAX_ROWS}行までです` }
  return { rows }
}
/** 経歴テーブルからテキスト要約を作る（career 列に保存し、一覧・連携先・必須判定などで使う） */
export function careerSummary(rows: CareerRow[]): string {
  return rows.map(r => {
    const period = r.from || r.to ? `${r.from || ''}〜${r.to || ''}` : ''
    return [period, r.company, r.work, r.note ? `（${r.note}）` : ''].filter(Boolean).join(' ')
  }).join('\n')
}
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
// only: この区分のスタッフだけに求める（所属先担当者名は取引先所属だけ。自社雇用では所属先＝自社のため意味がない）
// login_only: ログインを持つスタッフだけに求める（メールはログインのある人にだけ保存するため）
// note: 設定画面に出す対象の説明
export type RosterConfigurableField = { code: string; label: string; skillsheet: boolean; only?: string[]; login_only?: boolean; note?: string }
export const ROSTER_CONFIGURABLE_FIELDS: RosterConfigurableField[] = [
  { code: 'kana', label: 'フリガナ', skillsheet: true },
  { code: 'date_of_birth', label: '生年月日', skillsheet: true },
  { code: 'affiliation_contact', label: '所属先担当者名', skillsheet: false, only: ['partner_manual'], note: '③取引先のみ' },
  { code: 'phone', label: '電話番号', skillsheet: false },
  { code: 'email', label: 'メール', skillsheet: false, login_only: true, note: 'ログインのある人のみ' },
  { code: 'skills', label: 'スキル', skillsheet: true },
  { code: 'career', label: '経歴', skillsheet: true }, // 経歴テーブル（career_rows）入力時は要約テキストで判定
  { code: 'work_area', label: '稼働可能エリア', skillsheet: true },
  { code: 'nearest_station_line', label: '最寄駅（路線）', skillsheet: false },
  { code: 'nearest_station', label: '最寄駅（駅）', skillsheet: false },
  { code: 'commute_minutes', label: '通勤可能時間', skillsheet: false },
  { code: 'available_from', label: '稼働開始可能日', skillsheet: false },
]
/** その区分（とログインの有無）のスタッフに、この項目の必須設定を当てはめるか。hasLogin が未指定なら login_only は当てはめる */
export function requirementApplies(f: RosterConfigurableField, type?: string, hasLogin?: boolean): boolean {
  if (type === 'linked_external') return false // 基本項目は所属元が管理する
  if (type === 'skillsheet_only' && !f.skillsheet) return false
  if (f.only && type && !f.only.includes(type)) return false
  if (f.login_only && hasLogin === false) return false
  return true
}

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
export function missingRequired(required: Set<string>, body: any, mode: 'create' | 'update', type?: string, hasLogin?: boolean): string[] {
  return ROSTER_CONFIGURABLE_FIELDS
    .filter(f => required.has(f.code))
    .filter(f => requirementApplies(f, type, hasLogin))
    .filter(f => mode === 'create' ? isBlank(body[f.code]) : (body[f.code] !== undefined && isBlank(body[f.code])))
    .map(f => f.label)
}

/**
 * スタッフマスタの値の形式を確かめて正規化する（作成・更新で共通。送られてきた項目だけを見る）。エラー時はメッセージを返す。
 * 通勤可能時間は 0〜1440 の整数、生年月日・稼働開始可能日は実在する YYYY-MM-DD、電話番号は数字10〜11桁。
 * 空欄は null にする。
 */
export function normalizeRosterValues(body: any): string | null {
  const cm = body.commute_minutes
  if (cm !== undefined && cm !== null && String(cm).trim() !== '') {
    const n = typeof cm === 'boolean' ? NaN : Number(String(cm).trim())
    if (!Number.isFinite(n) || n < 0 || n > 1440) return '通勤可能時間は0〜1440分で入力してください'
    body.commute_minutes = Math.round(n)
  } else if (cm !== undefined) body.commute_minutes = null
  const today = nowJST().slice(0, 10)
  for (const [k, label] of [['date_of_birth', '生年月日'], ['available_from', '稼働開始可能日']] as const) {
    if (body[k] === undefined) continue
    const s = String(body[k] ?? '').trim()
    if (!s) { body[k] = null; continue }
    if (!isISODate(s)) return `${label}は「2000-01-31」の形式で入力してください`
    if (k === 'date_of_birth' && (s < '1900-01-01' || s > today)) return '生年月日が正しくありません'
    body[k] = s
  }
  if (body.phone !== undefined) {
    const s = String(body.phone ?? '').trim()
    if (s && !/^\d{10,11}$/.test(phoneDigits(s))) return '電話番号は10〜11桁の数字で入力してください'
    body.phone = s || null
  }
  if (body.email !== undefined) {
    const s = String(body.email ?? '').trim()
    if (s && (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) return 'メールアドレスの形式が正しくありません'
    body.email = s || null
  }
  return null
}
// 電話番号の数字だけ（+81 は 0 に）。staff-lifecycle.ts の normalizePhone と同じ規則（循環 import を避けるためここに置く）
function phoneDigits(p: string): string {
  let s = p.replace(/[^\d+]/g, '')
  if (s.startsWith('+81')) s = '0' + s.slice(3)
  return s.replace(/\D/g, '')
}

// 連携時の同意ポップアップで明示する共有範囲（フロント表示と同意履歴の双方で同じ文言を使う）
export const CONSENT_VERSION = 'v2' // v2: 共有範囲に「経験・スキル・人柄・PRポイント等」「備考」を追加
export const SHARED_SCOPE = [
  '氏名', 'フリガナ', '性別', '生年月日・年齢', '年代', '所属会社名・所属先担当者名',
  '最寄駅', '通勤可能時間', '稼働開始可能日', '稼働可能エリア', 'スキル', '経歴',
  '経験・スキル・人柄・PRポイント等', '備考',
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
export async function unusablePasswordHash(): Promise<string> { return sha256('!nologin!' + randHex(32)) }
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

// ---------- スタッフ番号の自動採番（#424） ----------
// システムが付ける番号（仮登録・ログインなしの人物・他社連携）は採番の参考にしない
const SYSTEM_CODE_RE = /^(TMP|PT|SS|LK)-/i
/**
 * 次に使えるスタッフ番号を返す。今のスタッフ番号のうち「接頭辞＋数字」の形で最も多い接頭辞を使い、
 * その最大の番号の次（桁数は既存に合わせる）から、会社の中でまだ使われていない番号を探す。
 * 該当する番号がなければ st001 から。last_code はその接頭辞で最後の番号（画面の案内用）
 */
export async function nextStaffCode(db: D1Database, companyId: number): Promise<{ code: string; last_code: string | null }> {
  const rows = (await db.prepare('SELECT user_code, role FROM users WHERE company_id = ?').bind(companyId).all()).results as any[]
  const used = new Set(rows.map(r => String(r.user_code || '').toLowerCase()))
  const groups = new Map<string, { n: number; max: number; width: number; last: string }>()
  for (const r of rows) {
    if (r.role !== 'staff') continue
    const code = String(r.user_code || '')
    if (SYSTEM_CODE_RE.test(code)) continue
    const m = code.match(/^(.*?)(\d+)$/)
    if (!m) continue
    const num = Number(m[2])
    if (!Number.isSafeInteger(num)) continue
    const g = groups.get(m[1]) || { n: 0, max: -1, width: 0, last: '' }
    g.n++
    if (num > g.max) { g.max = num; g.last = code }
    g.width = Math.max(g.width, m[2].length)
    groups.set(m[1], g)
  }
  let prefix = 'st', g = { n: 0, max: 0, width: 3, last: '' }
  for (const [p, x] of groups) if (x.n > g.n || (x.n === g.n && x.max > g.max)) { prefix = p; g = x }
  for (let n = g.max + 1, i = 0; i < 10000; n++, i++) {
    const code = prefix + String(n).padStart(g.width, '0')
    if (!used.has(code.toLowerCase())) return { code, last_code: g.last || null }
  }
  return { code: prefix + Date.now().toString(36), last_code: g.last || null }
}

// ---------- 同じ人の確認（#223 #356） ----------
// 退職・停止中・休職中なら画面に出す印（在籍中は null）。退職日の当日までは在籍
export function inactiveLabelOf(r: any, today: string): string | null {
  if (r.employment_status === 'retired' || (r.retired_at && String(r.retired_at).slice(0, 10) < today)) return '退職'
  if (r.user_status && r.user_status !== 'active') return '停止'
  if (r.employment_status === 'leave') return '休職'
  return null
}
/**
 * 自社のスタッフマスタから、同じ人と思われる行を探す（統合済みは除く）。
 * 電話番号（数字のみで比較）が同じ、または氏名（空白を除いて比較）と生年月日が同じ行。
 * 他社連携の行は、生年月日を所属元の値で比べる。電話番号は返さない
 */
export async function findSamePersonCandidates(db: D1Database, companyId: number, o: { name?: any; phone?: any; date_of_birth?: any }) {
  const phone = phoneDigits(String(o.phone || ''))
  const name = String(o.name || '').replace(/[\s　]/g, '')
  const dob = String(o.date_of_birth || '').trim()
  if (phone.length < 10 && !(name && dob)) return []
  const rows = (await db.prepare(`SELECT sp.staff_id, us.name, us.phone, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.is_provisional,
      sp.employment_status, us.status AS user_status, us.retired_at,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.date_of_birth ELSE sp.date_of_birth END AS dob
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    WHERE sp.company_id = ? AND sp.merged_into_staff_id IS NULL`).bind(companyId).all()).results as any[]
  const today = nowJST().slice(0, 10)
  const out: any[] = []
  for (const r of rows) {
    const reasons: string[] = []
    if (phone.length >= 10 && r.phone && phoneDigits(String(r.phone)) === phone) reasons.push('電話番号が同じ')
    if (name && dob && r.dob === dob && String(r.name || '').replace(/[\s　]/g, '') === name) reasons.push('氏名と生年月日が同じ')
    if (!reasons.length) continue
    out.push({ staff_id: r.staff_id, name: r.name, affiliation_type: r.affiliation_type, is_provisional: r.is_provisional ? 1 : 0,
      employment_status: r.employment_status || 'working', inactive: inactiveLabelOf(r, today), reasons })
  }
  return out.slice(0, 20)
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
// 所属会社名・所属先担当者名は「直接連携した1つ前の企業」を表す自社の行の値を使う（多段連携で雇用元の企業名・担当者が見えないように）
const ROSTER_LOCAL_FIELDS = ['affiliation', 'affiliation_contact']
export function rosterBaseSelect(local = 'sp', src = 'src'): string {
  return ROSTER_BASE_FIELDS.map(f => ROSTER_LOCAL_FIELDS.includes(f) ? `${local}.${f} AS ${f}` :
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
      await db.prepare(`UPDATE staff_profiles SET partner_affiliation_id = (SELECT COALESCE(merged_into_id, affiliation_id) FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?) WHERE staff_id = ?`)
        .bind(companyId, r.affiliation, r.staff_id).run()
    }
  }
}

// 連携の元として使える在籍状況（#41）: ログインが有効（退職が効力を持つと suspended になる）、在籍状況が退職でない、
// 統合済みでない、退職日を過ぎていない（退職日の当日までは在籍）。バインド: 今日の日付 1個
function inServiceSql(sp: string, us: string): string {
  return `(${us}.status = 'active' AND COALESCE(${sp}.employment_status, 'working') != 'retired' AND ${sp}.merged_into_staff_id IS NULL
    AND (${us}.retired_at IS NULL OR ${us}.retired_at >= ?))`
}

/**
 * 連携用IDに、本人の恒久ID（FS…）ではなく自社専用の再連携コード（RL…）を使う行か。
 * 他社から連携で受け入れた行と、恒久IDを採番した企業以外の行（他社連携から自社管理に切り替えた行など。#63）。
 * 採番した企業以外が恒久IDを渡すと、受け取った企業が雇用元と直接つながってしまう（頭超え）
 */
export function usesRelinkCode(type: string | null | undefined, personCompanyId: any, rowCompanyId: any): boolean {
  if ((type || 'own_employee') === 'linked_external') return true
  return personCompanyId != null && Number(personCompanyId) !== Number(rowCompanyId)
}

/** スタッフマスタ1件を取得（基本項目は所属元の値で解決済み）。自社の行でなければ null */
export async function loadRoster(db: D1Database, staffId: string | number, companyId: number): Promise<any | null> {
  const today = nowJST().slice(0, 10)
  const row = await db.prepare(`
    SELECT sp.*, ${rosterBaseSelect()},
           us.user_code, us.name, us.email, us.phone, us.status, us.last_login_at, us.retired_at, us.role AS user_role,
           oc.company_name AS owner_company_name, pe.global_staff_code, pe.created_company_id AS person_created_company_id,
           pa.affiliation_name AS partner_name,
           -- 他社連携の行: 所属元（雇用元）で退職・ログイン停止になっているか（日付は出さない #187）
           CASE WHEN sp.affiliation_type = 'linked_external' AND src.staff_id IS NOT NULL
             AND (COALESCE(src.employment_status,'working') = 'retired' OR srcu.status != 'active') THEN 1 ELSE 0 END AS source_retired,
           CASE WHEN ${inServiceSql('sp', 'us')} AND (COALESCE(sp.affiliation_type, 'own_employee') != 'linked_external'
             OR (srcu.user_id IS NOT NULL AND ${inServiceSql('src', 'srcu')})) THEN 1 ELSE 0 END AS link_in_service
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    -- 所属元が連携を終了した行（#162）は、所属元の行を参照しない（基本項目は空になり、連携用IDも共有できない）
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    LEFT JOIN users srcu ON srcu.user_id = src.user_id
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    LEFT JOIN staff_affiliations pa ON pa.affiliation_id = sp.partner_affiliation_id
    WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(today, today, staffId, companyId).first()
  if (!row) return null
  const type = (row.affiliation_type as string) || 'own_employee'
  // 経路（雇用元の行）は画面・APIに出さない（頭超え防止）
  // 連携を終了した所属元のユーザー（link_revoked_by）は他社のユーザーなので出さない
  const { root_staff_id: _root, relink_code: _rc, person_created_company_id: _pc, link_in_service: _ls, link_revoked_by: _rb, ...rest } = row as any
  const relink = usesRelinkCode(type, row.person_created_company_id, row.company_id)
  const linkable = (type === 'own_employee' || type === 'linked_external') && !row.merged_into_staff_id
  return {
    ...rest,
    affiliation_type: type,
    // 基本項目を編集できるのは所属元企業のみ（linked_external は稼働先なので不可）
    can_edit_base: type !== 'linked_external' && (row.owner_company_id == null || row.owner_company_id === companyId),
    // QR/ID で他社に連携できるのは、自社雇用の元データと、他社から連携で受け入れた行（さらに次の企業へ＝多段連携）。
    // 自社雇用は本人の恒久ID（persons.global_staff_code）、連携で受け入れた行は自社専用の relink_code を使う
    // （恒久IDを渡すと次の企業が雇用元と直接つながってしまうため。頭超え防止）
    // linkable は区分による可否（企業間チャットの連携先スレッドの表示にも使うため、在籍状況では変えない）
    linkable,
    // 連携用QR/IDを今共有できるか。退職・停止中の人は連携させない（#41。他社連携の行は雇用元の行も在籍中であること）
    link_shareable: linkable && !!row.link_in_service,
    // 画面に出すスタッフID（他社の恒久IDは見せない。他社連携から切り替えた行も自社専用のコードのみ: #63）
    global_staff_code: relink ? (row.relink_code || null) : row.global_staff_code,
    // 連携用IDが自社専用の再連携コードか（QR画面の説明の出し分け用）
    link_code_relink: relink,
  }
}

/**
 * 所属元（自社）で基本項目の名前が変わったとき、連携先各社のユーザー表示名も揃える。
 * 多段連携の先（2次・3次…）も含め、雇用元の行を参照している全ての連携行。
 * 列をそのまま比べ、root_staff_id・source_staff_id の索引で対象の人の行だけを引く（#482。COALESCE の式では全件を走査していた）。
 * root_staff_id が NULL の連携行（他社連携から切り替えた行の先など）は source_staff_id で探す
 */
export async function propagateNameToLinked(db: D1Database, sourceStaffId: number | string, name: string) {
  const sid = Number(sourceStaffId)
  await db.prepare(`UPDATE users SET name = ? WHERE name IS NOT ? AND user_id IN (SELECT user_id FROM staff_profiles
      WHERE (root_staff_id = ? OR (root_staff_id IS NULL AND source_staff_id = ?)) AND affiliation_type = 'linked_external' AND link_revoked_at IS NULL)`)
    .bind(name, name, sid, sid).run()
}

/**
 * 稼働先が現場評価・稼働メモ（所属元と共有する追記項目）を保存する文（#538）。
 * 内容が変わったときだけ保存し、他社連携の行なら履歴（roster_host_note_history）に追記して、
 * 所属元の管理者に受信箱の通知を作る（同じスタッフの未読の通知が残っていれば重ねて作らない）。
 * 値が undefined / null の項目は今の値のまま。変わっていなければ空の配列を返す
 */
export function hostNoteStmts(db: D1Database, roster: any, siteEvaluation: any, workMemo: any, userId: number): D1PreparedStatement[] {
  const norm = (v: any) => (v == null ? '' : String(v))
  const nextEval = siteEvaluation == null ? norm(roster.site_evaluation) : String(siteEvaluation)
  const nextMemo = workMemo == null ? norm(roster.work_memo) : String(workMemo)
  if (nextEval === norm(roster.site_evaluation) && nextMemo === norm(roster.work_memo)) return []
  const now = nowJST()
  const stmts = [db.prepare('UPDATE staff_profiles SET site_evaluation = ?, work_memo = ?, host_note_updated_at = ? WHERE staff_id = ? AND company_id = ?')
    .bind(nextEval, nextMemo, now, roster.staff_id, roster.company_id)]
  // 所属元が連携を終了した行（#162）は、所属元に共有しない（自社の行の値だけを変える）
  if (roster.affiliation_type !== 'linked_external' || !roster.source_staff_id || !roster.owner_company_id || roster.link_revoked_at) return stmts
  stmts.push(db.prepare(`INSERT INTO roster_host_note_history (staff_id, company_id, source_staff_id, owner_company_id, site_evaluation, work_memo, written_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(roster.staff_id, roster.company_id, roster.source_staff_id, roster.owner_company_id, nextEval, nextMemo, userId, now))
  // 通知の本文には評価の内容を入れない（受信箱に評価の写しを残さない）。リンク先の一覧で確かめる
  stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
    SELECT ou.company_id, ou.user_id, 'roster_host_note',
      '連携先からの追記: ' || COALESCE((SELECT su.name FROM staff_profiles s JOIN users su ON su.user_id = s.user_id WHERE s.staff_id = ?), '') || '（' || COALESCE((SELECT company_name FROM companies WHERE company_id = ?), '') || '）',
      '連携先の企業が、現場評価・稼働メモを更新しました。「連携先からの追記」で内容と前の内容を確認できます。', '/admin#roster-notes', ?, ?
    FROM users ou WHERE ou.company_id = ? AND ou.status = 'active' AND ou.role IN ('company_admin', 'sales_manager', 'field_manager', 'office_staff')
      AND NOT EXISTS (SELECT 1 FROM user_notifications n WHERE n.user_id = ou.user_id AND n.kind = 'roster_host_note' AND n.related_id = ? AND n.read_at IS NULL)`)
    .bind(roster.source_staff_id, roster.company_id, roster.source_staff_id, now, roster.owner_company_id, roster.source_staff_id))
  return stmts
}

/**
 * 所属元（雇用元の行）で退職日を設定・変更・解除したとき、連携先各社の連携行（多段連携の先を含む）にも伝える（#127）。
 * 連携行の users.retired_at は定期削除（退職後7年）と割当候補の判定に使われる。
 * 書き換えるのは、前の退職日と同じ値を持っている連携行だけ（連携先が別に止めた行を勝手に戻さない）。
 * 在籍状況・ログインは、退職が効力を持つときは退職に、効力のあった退職日を外したときだけ在籍に戻す。
 * applyRetirement の db.batch に加えて使う。
 */
export function propagateRetirementStmts(db: D1Database, rootStaffId: number | string, oldRetired: string | null, newRetired: string | null, effective: boolean): D1PreparedStatement[] {
  const today = nowJST().slice(0, 10)
  const wasEffective = !!oldRetired && oldRetired < today
  // 式（COALESCE）との比較では型が変換されないため、数値で渡す（画面からの ID は文字列）
  const root = Number(rootStaffId)
  const linked = `SELECT l.user_id FROM staff_profiles l JOIN users lu ON lu.user_id = l.user_id
    WHERE COALESCE(l.root_staff_id, l.source_staff_id) = ? AND l.affiliation_type = 'linked_external' AND lu.retired_at IS ?`
  // users の退職日を書き換える前に staff_profiles を更新する（対象を前の退職日で選ぶため）
  return [
    db.prepare(`UPDATE staff_profiles SET retention_flagged_at = NULL,
        employment_status = CASE WHEN ? = 1 THEN 'retired' WHEN ? = 1 AND employment_status = 'retired' THEN 'working' ELSE employment_status END
      WHERE user_id IN (${linked})`).bind(effective ? 1 : 0, wasEffective ? 1 : 0, root, oldRetired),
    db.prepare(`UPDATE users SET retired_at = ?, status = CASE WHEN ? = 1 THEN 'suspended' WHEN ? = 1 THEN 'active' ELSE status END
      WHERE user_id IN (${linked})`).bind(newRetired, effective ? 1 : 0, wasEffective ? 1 : 0, root, oldRetired),
  ]
}

/**
 * 他社から連携で受け入れたスタッフ（連携行）の通知先メールアドレス（staff_id → email）。
 * 連携行の users は email を持たない（ログイン・パスワード再設定の照合に使わせないため、コピーもしない）ので、
 * 雇用元の行の本人のアドレスを使う。雇用元で role='staff'・在籍中の人に限る。アドレスは画面・APIに出さないこと。
 */
export async function linkedStaffEmails(db: D1Database, staffIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!staffIds.length) return out
  // json_each で1つのバインドにまとめる（D1 のバインド上限を避ける）
  const rows = (await db.prepare(`
    SELECT l.staff_id, ou.email FROM staff_profiles l
    JOIN staff_profiles o ON o.staff_id = COALESCE(l.root_staff_id, l.source_staff_id)
    JOIN users ou ON ou.user_id = o.user_id
    WHERE l.staff_id IN (SELECT value FROM json_each(?)) AND l.affiliation_type = 'linked_external' AND l.link_revoked_at IS NULL
      AND o.merged_into_staff_id IS NULL AND ou.role = 'staff' AND ou.status = 'active' AND ou.email IS NOT NULL AND ou.email != ''`)
    .bind(JSON.stringify(staffIds.map(Number))).all()).results as any[]
  for (const r of rows) out.set(Number(r.staff_id), String(r.email))
  return out
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
// 必須項目が未入力の既存スタッフ（必須を後から ON にしたときの確認用）。
// 他社連携（所属元が管理）・統合済み・退職者は対象外。④スキルシートのみはスキルシート対象の項目だけを見る
const MISSING_LIST_MAX = 500
rosterApi.get('/field-settings/missing', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const required = await getRequiredFields(db, u.company_id)
  const fields = ROSTER_CONFIGURABLE_FIELDS.filter(f => required.has(f.code))
  if (!fields.length) return c.json({ count: 0, staff: [], truncated: false })
  const rows = (await db.prepare(`
    SELECT sp.staff_id, us.name, us.role, us.email, us.phone, COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type,
      sp.kana, sp.date_of_birth, sp.affiliation_contact, sp.skills, sp.career, sp.work_area,
      sp.nearest_station_line, sp.nearest_station, sp.commute_minutes, sp.available_from
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND COALESCE(sp.affiliation_type, 'own_employee') != 'linked_external'
      AND sp.merged_into_staff_id IS NULL AND us.status = 'active' AND COALESCE(sp.employment_status, 'working') != 'retired'
    ORDER BY sp.staff_id`).bind(u.company_id).all()).results as any[]
  const out: { staff_id: number; name: string; affiliation_type: string; missing: string[] }[] = []
  let count = 0
  for (const r of rows) {
    const missing = fields.filter(f => requirementApplies(f, r.affiliation_type, r.role === 'staff') && isBlank(r[f.code])).map(f => f.label)
    if (!missing.length) continue
    count++
    if (out.length < MISSING_LIST_MAX) out.push({ staff_id: r.staff_id, name: r.name, affiliation_type: r.affiliation_type, missing })
  }
  return c.json({ count, staff: out, truncated: count > out.length })
})

// ---------- フェーズE: QR（恒久固定のスタッフID） ----------
// 自社雇用スタッフの連携用ID（QRの中身）。再発行・有効期限なし。
rosterApi.get('/:id/share-code', async (c) => {
  const u = c.get('user')
  const r = await loadRoster(c.env.DB, c.req.param('id'), u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  if (r.link_revoked_at) return c.json({ error: '所属元の企業が連携を終了したため、連携用IDを共有できません' }, 400)
  if (!r.link_shareable) {
    return c.json({ error: r.linkable ? '退職・停止中のスタッフ（他社連携の場合は所属元で退職済みの人を含む）は連携用IDを共有できません'
      : '連携用IDを共有できるのは自社雇用スタッフと、他社から連携したスタッフのみです' }, 400)
  }
  let code = r.global_staff_code
  // 他社から連携した行と、他社連携から自社管理に切り替えた行は、自社専用のコードを使う（#63）
  if (r.link_code_relink && !code) code = await issueRelinkCode(c.env.DB, r.staff_id)
  const own = await c.env.DB.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first()
  // 連携相手に見える所属元は、コードを発行した自社（多段連携でも直前の企業名のみ）
  return c.json({ global_staff_code: code, name: r.name, company_name: own?.company_name || '', relink: !!r.link_code_relink })
})

// ---------- 稼働先での取引状況（#249） ----------
// 他社連携の行（稼働先の自社の行）について、稼働先が「稼働中・休止中・取引終了」を設定する。
// 在籍状況（employment_status）は追記項目なので連携行ごとに持てる（ROSTER_APPEND_FIELDS）。取引終了は link_ended_at に持つ。
// 所属元のユーザー状態・退職日・在籍状況は変えない。取引終了・所属元で退職の人は、シフトの割当候補から外れる（staff-eligibility）
export const HOST_STATUSES = ['working', 'leave', 'ended'] as const
rosterApi.put('/:id/host-status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const r = await loadRoster(db, c.req.param('id'), u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  if (r.affiliation_type !== 'linked_external') return c.json({ error: '取引状況を設定できるのは、他社から連携したスタッフのみです（自社のスタッフは在籍状況で管理します）' }, 400)
  if (r.merged_into_staff_id) return c.json({ error: '統合済みのスタッフは変更できません' }, 409)
  if (!(HOST_STATUSES as readonly string[]).includes(b.status)) return c.json({ error: '取引状況の値が正しくありません' }, 400)
  // 所属元が連携を終了した行は、稼働先では戻せない（#162。所属元が再開したら戻せる）
  if (r.link_revoked_at && b.status !== 'ended') return c.json({ error: '所属元の企業が連携を終了したため、取引状況を戻せません（再開は所属元の企業が行います）' }, 409)
  if (b.status === 'ended') {
    await db.prepare('UPDATE staff_profiles SET link_ended_at = COALESCE(link_ended_at, ?) WHERE staff_id = ? AND company_id = ?').bind(nowJST(), r.staff_id, u.company_id).run()
  } else {
    await db.prepare('UPDATE staff_profiles SET link_ended_at = NULL, employment_status = ? WHERE staff_id = ? AND company_id = ?').bind(b.status, r.staff_id, u.company_id).run()
  }
  return c.json({ ok: true })
})

// ---------- 連携先からの追記（現場評価・稼働メモ）の一覧（#538） ----------
// 所属元として、自社から直接連携した稼働先が書いた現場評価・稼働メモの変更を新しい順に返す。
// 連携が続いている行（linked_external）の分だけ。unseen=1 なら、自分がまだ確認していない分だけ
const HOST_NOTE_HISTORY_PER_LINK = 10
const HOST_NOTE_PAGE = 50
async function hostNoteSeenId(db: D1Database, userId: number): Promise<number> {
  const r = await db.prepare('SELECT last_seen_history_id FROM roster_host_note_seen WHERE user_id = ?').bind(userId).first() as any
  return r ? Number(r.last_seen_history_id) || 0 : 0
}
// 自分のユーザーができる前の追記は未確認に数えない（後から加わった担当者に、過去の分が一斉に未確認で出ないように）
const HOST_NOTE_FLOOR = `h.created_at >= COALESCE((SELECT datetime(created_at, '+9 hours') FROM users WHERE user_id = ?), '')`
const HOST_NOTE_FROM = `FROM roster_host_note_history h
  JOIN staff_profiles l ON l.staff_id = h.staff_id AND l.affiliation_type = 'linked_external' AND l.owner_company_id = h.owner_company_id
  JOIN staff_profiles o ON o.staff_id = l.source_staff_id AND o.company_id = h.owner_company_id
  JOIN users ou ON ou.user_id = o.user_id
  JOIN companies hc ON hc.company_id = h.company_id
  WHERE h.owner_company_id = ?`
rosterApi.get('/host-notes', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const seen = await hostNoteSeenId(db, u.user_id)
  const unseenOnly = c.req.query('unseen') === '1'
  const offset = Math.max(0, Math.min(10000, Number(c.req.query('offset')) || 0))
  const cond = unseenOnly ? ` AND h.history_id > ? AND ${HOST_NOTE_FLOOR}` : ''
  const condBinds = unseenOnly ? [seen, u.user_id] : []
  const [rows, cnt] = await db.batch([
    db.prepare(`SELECT h.history_id, h.site_evaluation, h.work_memo, h.created_at, o.staff_id, ou.name AS staff_name, hc.company_name AS host_company_name,
        CASE WHEN h.history_id > ? AND ${HOST_NOTE_FLOOR} THEN 1 ELSE 0 END AS unseen,
        (SELECT p.site_evaluation FROM roster_host_note_history p WHERE p.staff_id = h.staff_id AND p.history_id < h.history_id ORDER BY p.history_id DESC LIMIT 1) AS prev_site_evaluation,
        (SELECT p.work_memo FROM roster_host_note_history p WHERE p.staff_id = h.staff_id AND p.history_id < h.history_id ORDER BY p.history_id DESC LIMIT 1) AS prev_work_memo
      ${HOST_NOTE_FROM}${cond} ORDER BY h.history_id DESC LIMIT ? OFFSET ?`).bind(seen, u.user_id, u.company_id, ...condBinds, HOST_NOTE_PAGE + 1, offset),
    db.prepare(`SELECT COUNT(*) AS n ${HOST_NOTE_FROM} AND h.history_id > ? AND ${HOST_NOTE_FLOOR}`).bind(u.company_id, seen, u.user_id),
  ])
  const list = rows.results as any[]
  return c.json({
    notes: list.slice(0, HOST_NOTE_PAGE).map(r => ({ ...r, unseen: !!r.unseen })),
    has_more: list.length > HOST_NOTE_PAGE, offset, unseen_count: Number((cnt.results as any[])[0]?.n) || 0,
  })
})
// 確認済みにする（指定した history_id まで。省略時は今ある分すべて）
rosterApi.post('/host-notes/seen', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const max = Number((await db.prepare('SELECT MAX(history_id) AS m FROM roster_host_note_history WHERE owner_company_id = ?').bind(u.company_id).first() as any)?.m) || 0
  const want = Number(b.history_id)
  const upTo = Number.isInteger(want) && want > 0 ? Math.min(want, max) : max
  await db.prepare(`INSERT INTO roster_host_note_seen (user_id, last_seen_history_id, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_seen_history_id = MAX(last_seen_history_id, excluded.last_seen_history_id), seen_at = excluded.seen_at`)
    .bind(u.user_id, upTo, nowJST()).run()
  return c.json({ ok: true, last_seen_history_id: upTo })
})

// ---------- フェーズF: 所属元⇔稼働先の連携状況 ----------
// 所属元: 自社スタッフの連携先企業一覧 + 稼働先が記入した共有追記項目（閲覧のみ）
// 稼働先: 自社の連携レコードの同意履歴
rosterApi.get('/:id/links', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const sid = c.req.param('id')
  const r = await loadRoster(db, sid, u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  let consents: any[] | null = null
  if (r.affiliation_type === 'linked_external') {
    consents = ((await db.prepare(`
      SELECT rc.consent_id, rc.consent_version, rc.shared_scope, rc.created_at, um.name AS agreed_by
      FROM roster_consents rc LEFT JOIN users um ON um.user_id = rc.user_id
      WHERE rc.company_id = ? AND rc.staff_id = ? ORDER BY rc.created_at DESC`).bind(u.company_id, sid).all()).results as any[])
      .map(x => ({ ...x, shared_scope: safeJson(x.shared_scope) }))
  }
  // 所属元が閲覧できるのは: 連携先企業名・連携日・共有追記項目（現場評価/稼働メモ）・稼働実績の件数のみ
  // （稼働先の社内メモ・フォロー履歴・日報本文等は返さない）
  const today = nowJST().slice(0, 10); const month = today.slice(0, 7)
  // 稼働日数・最終稼働は今日以前の分。今後の予定は month_planned_days（予定を含む今月の日数）で分けて返す（#85）
  // link_revoked_at: 所属元（自社）が連携を終了した日時（#162）。終了した操作者は自社のユーザーなので名前を返す
  const links = await db.prepare(`
    SELECT sp.staff_id AS linked_staff_id, co.company_name AS host_company_name, sp.created_at AS linked_at,
      sp.site_evaluation, sp.work_memo, sp.host_note_updated_at, sp.link_revoked_at,
      (SELECT ru.name FROM users ru WHERE ru.user_id = sp.link_revoked_by AND ru.company_id = ?) AS revoked_by_name,
      (SELECT MIN(rc.created_at) FROM roster_consents rc WHERE rc.staff_id = sp.staff_id) AS consented_at,
      (SELECT COUNT(DISTINCT s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date LIKE ? AND s.work_date <= ? AND s.status IN ('confirmed','substitute')) AS month_days,
      (SELECT COUNT(DISTINCT s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_planned_days,
      (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date <= ? AND s.status IN ('confirmed','substitute')) AS last_work_date
    FROM staff_profiles sp JOIN companies co ON co.company_id = sp.company_id
    WHERE sp.source_staff_id = ? AND sp.affiliation_type = 'linked_external' ORDER BY sp.created_at`).bind(u.company_id, month + '%', today, month + '%', today, sid).all()
  // 連携先が書いた現場評価・稼働メモの変更履歴（新しい順に各10件。#538）
  const linkRows = links.results as any[]
  if (linkRows.length) {
    const hist = (await db.prepare(`SELECT * FROM (
        SELECT h.history_id, h.staff_id, h.site_evaluation, h.work_memo, h.created_at,
          ROW_NUMBER() OVER (PARTITION BY h.staff_id ORDER BY h.history_id DESC) AS rn
        FROM roster_host_note_history h WHERE h.staff_id IN (SELECT value FROM json_each(?)) AND h.owner_company_id = ?
      ) WHERE rn <= ${HOST_NOTE_HISTORY_PER_LINK} ORDER BY history_id DESC`)
      .bind(JSON.stringify(linkRows.map(l => Number(l.linked_staff_id))), u.company_id).all()).results as any[]
    for (const l of linkRows) l.history = hist.filter(h => h.staff_id === l.linked_staff_id).map(({ rn: _rn, staff_id: _s, ...h }) => h)
  }
  // 連携先は「自社から直接連携した企業」のみ（その先の企業は出さない）
  if (consents) return c.json({ role: 'host', owner_company_name: r.owner_company_name, consents, links: linkRows, link_revoked_at: r.link_revoked_at || null })
  return c.json({ role: 'owner', links: linkRows })
})

// ---------- 所属元による連携の終了・再開（#162） ----------
// 所属元（自社の行から直接連携された稼働先がある企業）が、稼働先への共有を止める。
// 終了した連携行は所属元の基本項目を参照しなくなり（loadRoster ほか）、取引終了（link_ended_at）にしてシフトの候補から外す。
// 終了した連携行からさらに連携した先の行（多段連携）も同時に終了する。稼働先の管理者には通知し、記録を roster_link_events に残す
const NOTIFY_ADMIN_ROLES_SQL = `('company_admin', 'sales_manager', 'field_manager', 'office_staff')`
// 連携行（staff_id の一覧）ごとに、その稼働先の企業の管理者全員へ通知する文
function hostAdminNotifyStmt(db: D1Database, ids: number[], kind: string, titlePrefix: string, body: string, now: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
    SELECT ou.company_id, ou.user_id, ?, ? || COALESCE(lu.name, ''), ?, '/admin#staff/' || l.staff_id, l.staff_id, ?
    FROM staff_profiles l JOIN users lu ON lu.user_id = l.user_id
    JOIN users ou ON ou.company_id = l.company_id AND ou.status = 'active' AND ou.role IN ${NOTIFY_ADMIN_ROLES_SQL}
    WHERE l.staff_id IN ${JSON_IN}`).bind(kind, titlePrefix, body, now, bindJsonArray(ids))
}
function linkEventStmt(db: D1Database, ids: number[], event: string, topId: number, u: any, now: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO roster_link_events (staff_id, company_id, source_staff_id, owner_company_id, event, via_staff_id, actor_user_id, actor_company_id, created_at)
    SELECT staff_id, company_id, source_staff_id, owner_company_id, ?, CASE WHEN staff_id = ? THEN NULL ELSE source_staff_id END, ?, ?, ?
    FROM staff_profiles WHERE staff_id IN ${JSON_IN}`).bind(event, topId, u.user_id, u.company_id, now, bindJsonArray(ids))
}
rosterApi.post('/:id/links/:linkedId/end', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const r = await loadRoster(db, c.req.param('id'), u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  const linkedId = Number(c.req.param('linkedId'))
  if (!Number.isInteger(linkedId) || linkedId <= 0) return c.json({ error: '連携が見つかりません' }, 404)
  // 自社の行から直接連携した稼働先の行と、そこからさらに連携した先の行（多段連携。深さは10段まで）
  const rows = (await db.prepare(`WITH RECURSIVE down(id, depth) AS (
      SELECT staff_id, 0 FROM staff_profiles WHERE staff_id = ? AND source_staff_id = ? AND affiliation_type = 'linked_external'
      UNION SELECT sp.staff_id, down.depth + 1 FROM staff_profiles sp JOIN down ON sp.source_staff_id = down.id
        WHERE sp.affiliation_type = 'linked_external' AND down.depth < 10)
    SELECT sp.staff_id, sp.link_revoked_at, down.depth FROM down JOIN staff_profiles sp ON sp.staff_id = down.id`).bind(linkedId, r.staff_id).all()).results as any[]
  const top = rows.find(x => Number(x.depth) === 0)
  if (!top) return c.json({ error: '連携が見つかりません' }, 404)
  if (top.link_revoked_at) return c.json({ error: 'この連携はすでに終了しています' }, 409)
  const ids = rows.filter(x => !x.link_revoked_at).map(x => Number(x.staff_id))
  const now = nowJST()
  const upd = await db.prepare(`UPDATE staff_profiles SET link_revoked_at = ?, link_revoked_by = ?, link_ended_at = COALESCE(link_ended_at, ?)
    WHERE staff_id IN ${JSON_IN} AND link_revoked_at IS NULL`).bind(now, u.user_id, now, bindJsonArray(ids)).run()
  if (!upd.meta.changes) return c.json({ error: 'この連携はすでに終了しています' }, 409)
  // 同時に押されたときに重ねて記録しないよう、この操作で終了にした行だけを記録・通知する
  const done = ((await db.prepare(`SELECT staff_id FROM staff_profiles WHERE staff_id IN ${JSON_IN} AND link_revoked_at = ? AND link_revoked_by = ?`)
    .bind(bindJsonArray(ids), now, u.user_id).all()).results as any[]).map(x => Number(x.staff_id))
  await db.batch([
    linkEventStmt(db, done, 'ended', linkedId, u, now),
    hostAdminNotifyStmt(db, done, 'roster_link_ended', '連携の終了: ',
      '所属元の企業が、このスタッフの情報の共有（企業間連携）を終了しました。基本項目は表示されなくなり、新しいシフトには割り当てられません。今後のシフトが入っている場合は、担当を見直してください。', now),
  ])
  return c.json({ ok: true, ended: done.length })
})
// 終了した連携を再開する（直接連携した行だけ。多段連携の先の行は、その行の所属元が再開する）
rosterApi.post('/:id/links/:linkedId/resume', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const r = await loadRoster(db, c.req.param('id'), u.company_id)
  if (!r) return c.json({ error: 'not found' }, 404)
  if (r.link_revoked_at) return c.json({ error: '自社の連携が所属元の企業で終了しているため、再開できません' }, 409)
  if (!r.link_shareable) return c.json({ error: '退職・停止中のスタッフの連携は再開できません' }, 400)
  const linkedId = Number(c.req.param('linkedId'))
  const now = nowJST()
  const upd = await db.prepare(`UPDATE staff_profiles SET link_revoked_at = NULL, link_revoked_by = NULL
    WHERE staff_id = ? AND source_staff_id = ? AND affiliation_type = 'linked_external' AND link_revoked_at IS NOT NULL`).bind(linkedId, r.staff_id).run()
  if (!upd.meta.changes) return c.json({ error: '終了した連携が見つかりません' }, 404)
  await db.batch([
    linkEventStmt(db, [linkedId], 'resumed', linkedId, u, now),
    hostAdminNotifyStmt(db, [linkedId], 'roster_link_resumed', '連携の再開: ',
      '所属元の企業が、このスタッフの企業間連携を再開しました。基本項目がふたたび表示されます。取引状況は「取引終了」のままなので、シフトに割り当てるときはスタッフ詳細の「取引状況」を戻してください。', now),
  ])
  return c.json({ ok: true })
})

// ---------- 連携用IDの一覧（#539 所属元: 複数のスタッフのIDをまとめて出す） ----------
// 連携用IDを今共有できる人（loadRoster の link_shareable と同じ条件）。ids を渡すとその人だけ。バインド: 会社・今日2個（・ids）
function shareCodeListSql(withIds: boolean): string {
  const relink = `(sp.affiliation_type = 'linked_external' OR (pe.created_company_id IS NOT NULL AND pe.created_company_id != sp.company_id))`
  return `SELECT sp.staff_id, us.name, us.user_code, COALESCE(sp.affiliation_type, 'own_employee') AS affiliation_type,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana,
      CASE WHEN ${relink} THEN 1 ELSE 0 END AS relink,
      CASE WHEN ${relink} THEN sp.relink_code ELSE pe.global_staff_code END AS code
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id) AND sp.link_revoked_at IS NULL
    LEFT JOIN users srcu ON srcu.user_id = src.user_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ? AND COALESCE(sp.affiliation_type, 'own_employee') IN ('own_employee', 'linked_external')
      AND sp.merged_into_staff_id IS NULL AND sp.link_revoked_at IS NULL AND ${inServiceSql('sp', 'us')}
      AND (COALESCE(sp.affiliation_type, 'own_employee') != 'linked_external' OR (srcu.user_id IS NOT NULL AND ${inServiceSql('src', 'srcu')}))
      ${withIds ? `AND sp.staff_id IN ${JSON_IN}` : ''}
    ORDER BY us.name, sp.staff_id LIMIT 3000`
}
// 一覧（自社専用コードをまだ発行していない人は code が null）
rosterApi.get('/share-codes', async (c) => {
  const u = c.get('user'); const today = nowJST().slice(0, 10)
  const rows = (await c.env.DB.prepare(shareCodeListSql(false)).bind(u.company_id, today, today).all()).results as any[]
  return c.json({ staff: rows.map(r => ({ ...r, relink: !!r.relink })) })
})
// 選んだ人のIDを返す。自社専用コード（RL…）が未発行の人には、ここでまとめて発行する（1文で発行し、コードが重なったときだけやり直す）
const SHARE_CODES_MAX = 300
rosterApi.post('/share-codes', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const ids = JSON.parse(bindJsonArray(Array.isArray(b.staff_ids) ? b.staff_ids : [])) as number[]
  if (!ids.length) return c.json({ error: 'スタッフを選んでください' }, 400)
  if (ids.length > SHARE_CODES_MAX) return c.json({ error: `一度に出力できるのは${SHARE_CODES_MAX}人までです` }, 400)
  const today = nowJST().slice(0, 10)
  const list = async () => (await db.prepare(shareCodeListSql(true)).bind(u.company_id, today, today, JSON.stringify(ids)).all()).results as any[]
  let rows = await list()
  const missing = rows.filter(r => r.relink && !r.code).map(r => Number(r.staff_id))
  for (let i = 0; missing.length && i < 3; i++) {
    try {
      await db.prepare(`UPDATE staff_profiles SET relink_code = 'RL' || upper(hex(randomblob(5))) WHERE staff_id IN ${JSON_IN} AND company_id = ? AND relink_code IS NULL`)
        .bind(JSON.stringify(missing), u.company_id).run()
      break
    } catch { /* コード衝突時は再採番 */ }
  }
  if (missing.length) rows = await list()
  const found = new Set(rows.map(r => Number(r.staff_id)))
  return c.json({
    staff: rows.filter(r => r.code).map(r => ({ staff_id: r.staff_id, name: r.name, kana: r.kana, code: r.code, relink: !!r.relink })),
    // 退職・停止中・連携の対象外などで出せなかった人の数
    skipped: ids.filter(id => !found.has(id)).length + rows.filter(r => !r.code).length,
  })
})

// 次に使えるスタッフ番号（#424。登録画面の番号欄の既定値）
rosterApi.get('/next-code', async (c) => c.json(await nextStaffCode(c.env.DB, c.get('user').company_id)))

// 取引先（Field OS未契約の所属元）一覧: 自社名を除いた staff_affiliations。
// 以前のスタッフ詳細の保存で、個人事業主の屋号やスキルシートのみの人の所属会社名が取引先マスタに入っていたため（#262）、
// 所属スタッフ・支払先のシフト・連絡先がなく、取引先以外の区分のスタッフの所属会社名と同じ名前の行は出さない
// 統合済み（#161）の取引先は出さない。取引先の画面用に、在籍中の所属スタッフ数・今月の稼働（支払先がこの取引先のシフト）・
// 削除できるか（所属スタッフ・支払先のシフト・予約中の区分変更がない）も返す
rosterApi.get('/partners', async (c) => {
  const u = c.get('user')
  const month = nowJST().slice(0, 7)
  const rows = await c.env.DB.prepare(`
    SELECT * FROM (
      SELECT sa.affiliation_id, sa.affiliation_name, sa.contact_name, sa.phone, sa.email, sa.memo, sa.updated_at,
        (SELECT COUNT(*) FROM staff_profiles sp WHERE sp.partner_affiliation_id = sa.affiliation_id AND sp.company_id = sa.company_id) AS staff_count,
        (SELECT COUNT(*) FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.partner_affiliation_id = sa.affiliation_id AND sp.company_id = sa.company_id
          AND sp.merged_into_staff_id IS NULL AND COALESCE(sp.employment_status, 'working') != 'retired' AND us.status = 'active') AS active_staff_count,
        (SELECT COUNT(*) FROM shifts s WHERE s.company_id = sa.company_id AND s.payee_affiliation_id = sa.affiliation_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_shifts,
        (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.company_id = sa.company_id AND s.payee_affiliation_id = sa.affiliation_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_staff,
        CASE WHEN ${PARTNER_IN_USE_SQL} THEN 1 ELSE 0 END AS in_use,
        CASE WHEN COALESCE(sa.contact_name, '') = '' AND COALESCE(sa.phone, '') = '' AND COALESCE(sa.email, '') = '' AND COALESCE(sa.memo, '') = ''
          AND EXISTS (SELECT 1 FROM staff_profiles np WHERE np.company_id = sa.company_id AND np.affiliation = sa.affiliation_name
            AND COALESCE(np.affiliation_type, 'own_employee') IN ('freelance', 'skillsheet_only', 'daily_worker', 'own_employee'))
          AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.company_id = sa.company_id AND s.payee_affiliation_id = sa.affiliation_id)
        THEN 1 ELSE 0 END AS not_partner
      FROM staff_affiliations sa
      WHERE sa.company_id = ? AND sa.merged_into_id IS NULL AND sa.affiliation_name != (SELECT company_name FROM companies WHERE company_id = ?)
    ) WHERE NOT (staff_count = 0 AND not_partner = 1)
    ORDER BY affiliation_name`).bind(month + '%', month + '%', u.company_id, u.company_id).all()
  return c.json({ partners: (rows.results as any[]).map(({ not_partner: _n, in_use, ...r }) => ({ ...r, can_delete: !in_use })) })
})

// ---------- 取引先の登録・編集・統合・削除（#161） ----------
// 取引先がどこかで使われているか（sa = staff_affiliations）。所属スタッフ・支払先のシフト・予約中の区分変更・精算の対象外の記録
const PARTNER_IN_USE_SQL = `(EXISTS (SELECT 1 FROM staff_profiles x WHERE x.company_id = sa.company_id AND x.partner_affiliation_id = sa.affiliation_id)
  OR EXISTS (SELECT 1 FROM shifts x WHERE x.company_id = sa.company_id AND x.payee_affiliation_id = sa.affiliation_id)
  OR EXISTS (SELECT 1 FROM staff_affiliation_schedules x WHERE x.company_id = sa.company_id AND x.partner_affiliation_id = sa.affiliation_id AND x.status = 'pending')
  OR EXISTS (SELECT 1 FROM affiliation_excluded_shifts x WHERE x.company_id = sa.company_id AND x.to_payee_affiliation_id = sa.affiliation_id))`
const PARTNER_FIELD_MAX: Record<string, number> = { affiliation_name: 100, contact_name: 100, phone: 30, email: 254, memo: 2000 }
/** 取引先の入力を確かめて正規化する。送られた項目だけを返す（空欄は null。名前は空にできない） */
function partnerValues(b: any): { values?: Record<string, string | null>; error?: string } {
  const out: Record<string, string | null> = {}
  for (const [k, max] of Object.entries(PARTNER_FIELD_MAX)) {
    if (b[k] === undefined) continue
    const v = String(b[k] ?? '').trim()
    if (v.length > max) return { error: '入力が長すぎます' }
    out[k] = v || null
  }
  if ('affiliation_name' in out && !out.affiliation_name) return { error: '取引先名を入力してください' }
  if (out.phone && !/^\d{10,11}$/.test(phoneDigits(out.phone))) return { error: '電話番号は10〜11桁の数字で入力してください' }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: 'メールアドレスの形式が正しくありません' }
  return { values: out }
}
async function partnerNameError(db: D1Database, companyId: number, name: string): Promise<string | null> {
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(companyId).first() as any
  if (own && own.company_name === name) return '自社名は取引先として登録できません'
  return partnerNameConflict(db, companyId, name)
}
async function loadPartner(db: D1Database, companyId: number, id: any): Promise<any | null> {
  return db.prepare('SELECT * FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ? AND merged_into_id IS NULL').bind(Number(id) || 0, companyId).first()
}
rosterApi.post('/partners', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const { values, error } = partnerValues(await c.req.json().catch(() => ({})))
  if (error || !values) return c.json({ error }, 400)
  if (!values.affiliation_name) return c.json({ error: '取引先名を入力してください' }, 400)
  const nameErr = await partnerNameError(db, u.company_id, values.affiliation_name)
  if (nameErr) return c.json({ error: nameErr }, 400)
  const r = await db.prepare(`INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name, contact_name, phone, email, memo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, values.affiliation_name, values.contact_name ?? null, values.phone ?? null, values.email ?? null, values.memo ?? null, nowJST()).run()
  if (!r.meta.changes) return c.json({ error: '同じ名前の取引先が登録済みです（統合済みの取引先を含む）' }, 409)
  return c.json({ ok: true, affiliation_id: r.meta.last_row_id })
})
// 編集。名前を変えたら、所属スタッフの所属会社名もそろえる
rosterApi.put('/partners/:pid', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await loadPartner(db, u.company_id, c.req.param('pid'))
  if (!p) return c.json({ error: '取引先が見つかりません' }, 404)
  const { values, error } = partnerValues(await c.req.json().catch(() => ({})))
  if (error || !values) return c.json({ error }, 400)
  const keys = Object.keys(values)
  if (!keys.length) return c.json({ ok: true })
  const renamed = !!values.affiliation_name && values.affiliation_name !== p.affiliation_name
  if (renamed) {
    const nameErr = await partnerNameError(db, u.company_id, values.affiliation_name!)
    if (nameErr) return c.json({ error: nameErr }, 400)
  }
  const stmts = [db.prepare(`UPDATE staff_affiliations SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE affiliation_id = ? AND company_id = ?`)
    .bind(...keys.map(k => values[k]), nowJST(), p.affiliation_id, u.company_id)]
  if (renamed) stmts.push(db.prepare('UPDATE staff_profiles SET affiliation = ? WHERE company_id = ? AND partner_affiliation_id = ?').bind(values.affiliation_name, u.company_id, p.affiliation_id))
  try { await db.batch(stmts) } catch {
    return c.json({ error: '同じ名前の取引先が登録済みです（統合済みの取引先を含む）。同じ会社なら「統合」を使ってください' }, 409)
  }
  return c.json({ ok: true })
})
// 統合: 表記ゆれなどで分かれた取引先（pid）を、統合先（into_id）にまとめる。
// 所属スタッフ・未確定のシフトの支払先・予約中の区分変更を統合先に付け替え、統合先の空欄の連絡先は統合元の値で埋める。
// 確定済みの精算のシフトは支払先を変えない（統合元の行は、使われていなければ削除し、使われていれば統合済みとして残す）
rosterApi.post('/partners/:pid/merge', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const from = await loadPartner(db, u.company_id, c.req.param('pid'))
  const into = await loadPartner(db, u.company_id, b.into_id)
  if (!from || !into) return c.json({ error: '取引先が見つかりません' }, 404)
  if (from.affiliation_id === into.affiliation_id) return c.json({ error: '同じ取引先には統合できません' }, 400)
  const now = nowJST(); const cid = u.company_id; const f = from.affiliation_id, t = into.affiliation_id
  const res = await db.batch([
    db.prepare('UPDATE staff_profiles SET partner_affiliation_id = ?, affiliation = ? WHERE company_id = ? AND partner_affiliation_id = ?').bind(t, into.affiliation_name, cid, f),
    db.prepare(`UPDATE shifts SET payee_affiliation_id = ? WHERE company_id = ? AND payee_affiliation_id = ? AND COALESCE(settle_status, 'planned') != 'confirmed'`).bind(t, cid, f),
    db.prepare(`UPDATE staff_affiliation_schedules SET partner_affiliation_id = ?, to_affiliation = ? WHERE company_id = ? AND partner_affiliation_id = ? AND status = 'pending'`).bind(t, into.affiliation_name, cid, f),
    db.prepare(`UPDATE staff_affiliations SET contact_name = COALESCE(NULLIF(contact_name, ''), ?), phone = COALESCE(NULLIF(phone, ''), ?), email = COALESCE(NULLIF(email, ''), ?),
        memo = CASE WHEN COALESCE(?, '') = '' THEN memo WHEN COALESCE(memo, '') = '' THEN ? ELSE memo || char(10) || ? END, updated_at = ?
      WHERE affiliation_id = ? AND company_id = ?`).bind(from.contact_name, from.phone, from.email, from.memo, from.memo, from.memo, now, t, cid),
    // 統合元に以前統合した取引先も、統合先を付け替える
    db.prepare(`UPDATE staff_affiliations SET merged_into_id = ?, updated_at = ? WHERE company_id = ? AND (affiliation_id = ? OR merged_into_id = ?)`).bind(t, now, cid, f, f),
    db.prepare(`DELETE FROM staff_affiliations AS sa WHERE sa.affiliation_id = ? AND sa.company_id = ? AND NOT ${PARTNER_IN_USE_SQL}`).bind(f, cid),
  ])
  return c.json({ ok: true, moved_staff: res[0].meta.changes || 0, moved_shifts: res[1].meta.changes || 0, removed: !!res[5].meta.changes })
})
// 削除: 所属スタッフ・支払先のシフト・予約中の区分変更がない取引先だけ
rosterApi.delete('/partners/:pid', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await loadPartner(db, u.company_id, c.req.param('pid'))
  if (!p) return c.json({ error: '取引先が見つかりません' }, 404)
  const r = await db.prepare(`DELETE FROM staff_affiliations AS sa WHERE sa.affiliation_id = ? AND sa.company_id = ? AND NOT ${PARTNER_IN_USE_SQL}`).bind(p.affiliation_id, u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '所属スタッフ・支払先のシフト（精算済みを含む）・予約中の区分変更がある取引先は削除できません。表記ゆれなら「統合」を使ってください' }, 409)
  return c.json({ ok: true })
})

// 連携元が退職・停止中のときの文言（#41）
const SOURCE_RETIRED_MESSAGE = '所属元で退職済み、または利用停止中のため連携できません'

// ①QR/ID連携: コードから連携候補をプレビュー（同意前なので識別に必要な最小限のみ返す）
rosterApi.get('/lookup', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const code = normalizeCode(c.req.query('code') || '')
  if (!code) return c.json({ error: 'スタッフIDを入力してください' }, 400)
  const src = await findLinkSource(db, code)
  if (!src) {
    // 書き写しの誤りに気づけるよう、IDの形を案内する（#475）
    const shape = /^(FS|RL)[0-9A-F]{10}$/.test(code) ? '' : '（スタッフIDは「FS」または「RL」で始まる12文字です。入力した ' + code.length + '文字を確認してください）'
    return c.json({ error: '該当するスタッフが見つかりません' + (shape || '（連携できるのは他社で自社雇用として登録されたスタッフのみです。1文字ずつ確認してください）') }, 404)
  }
  if (src.company_id === u.company_id) return c.json({ error: '自社に登録済みのスタッフです' }, 409)
  const already = await db.prepare('SELECT staff_id FROM staff_profiles WHERE company_id = ? AND person_id = ? ORDER BY staff_id LIMIT 1').bind(u.company_id, src.person_id).first()
  // 既に自社に登録済みの人なら、コードの持ち主（雇用元など）の企業名は返さない（多段連携の経路が分からないように）
  if (already) return c.json({ candidate: { name: src.name }, already_linked_staff_id: already.staff_id })
  if (!src.in_service) return c.json({ error: SOURCE_RETIRED_MESSAGE }, 409)
  return c.json({
    candidate: {
      global_staff_code: src.global_staff_code, name: src.name, kana: src.kana, gender: src.gender,
      owner_company_name: src.owner_company_name,
    },
    already_linked_staff_id: null,
    consent: { version: CONSENT_VERSION, shared: SHARED_SCOPE, not_shared: NOT_SHARED_SCOPE },
  })
})

/**
 * 連携元を解決する。
 *  - 恒久ID（FS…）: 恒久IDを採番した企業（persons.created_company_id）の自社雇用行。
 *    他社連携から自社管理に切り替えた別の企業の行は同じ person_id を持つが、そちらには解決しない（#63 頭超え防止）
 *  - 再連携コード（RL…）: 他社から連携で受け入れた行（多段連携）と、他社連携から自社管理に切り替えた行。
 *    所属元として見えるのはこの行の企業のみ
 * root_staff_id は雇用元の行（基本項目の参照先）。画面・APIには出さない。
 * in_service: コードの行と雇用元の行がともに在籍中で、どちらの企業も停止していない（#41）
 */
async function findLinkSource(db: D1Database, code: string): Promise<any | null> {
  const today = nowJST().slice(0, 10)
  const active = `${inServiceSql('sp', 'us')} AND ${inServiceSql('src', 'rus')}
    AND COALESCE(co.active_status, 'active') != 'inactive' AND COALESCE(rco.active_status, 'active') != 'inactive'`
  if (code.startsWith('RL')) {
    return db.prepare(`
      SELECT sp.staff_id, sp.company_id, sp.person_id, src.kana, src.gender, us.name, rus.role AS source_role, sp.relink_code AS global_staff_code,
             co.company_name AS owner_company_name, src.staff_id AS root_staff_id, rus.retired_at AS root_retired_at,
             CASE WHEN ${active} THEN 1 ELSE 0 END AS in_service
      FROM staff_profiles sp
      JOIN users us ON us.user_id = sp.user_id
      JOIN companies co ON co.company_id = sp.company_id
      JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id, sp.staff_id)
      JOIN users rus ON rus.user_id = src.user_id
      LEFT JOIN companies rco ON rco.company_id = src.company_id
      WHERE sp.relink_code = ? AND sp.affiliation_type IN ('linked_external', 'own_employee') AND sp.merged_into_staff_id IS NULL AND sp.link_revoked_at IS NULL LIMIT 1`)
      .bind(today, today, code).first()
  }
  return db.prepare(`
    SELECT sp.staff_id, sp.company_id, sp.person_id, sp.kana, sp.gender, us.name, us.role AS source_role, pe.global_staff_code,
           co.company_name AS owner_company_name, sp.staff_id AS root_staff_id, us.retired_at AS root_retired_at,
           CASE WHEN ${active} THEN 1 ELSE 0 END AS in_service
    FROM persons pe
    JOIN staff_profiles sp ON sp.person_id = pe.person_id AND sp.source_staff_id IS NULL AND sp.affiliation_type = 'own_employee'
      AND sp.company_id = COALESCE(pe.created_company_id, sp.company_id)
    JOIN users us ON us.user_id = sp.user_id
    JOIN companies co ON co.company_id = sp.company_id
    JOIN staff_profiles src ON src.staff_id = sp.staff_id
    JOIN users rus ON rus.user_id = src.user_id
    LEFT JOIN companies rco ON rco.company_id = src.company_id
    WHERE pe.global_staff_code = ? AND sp.merged_into_staff_id IS NULL ORDER BY sp.staff_id LIMIT 1`).bind(today, today, code).first()
}

/** 連携で受け入れた行（と他社連携から切り替えた行）に、次の企業へ連携するための自社専用コードを発行する（一度発行したら固定） */
async function issueRelinkCode(db: D1Database, staffId: number): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = 'RL' + randHex(5).toUpperCase()
    try {
      const r = await db.prepare('UPDATE staff_profiles SET relink_code = ? WHERE staff_id = ? AND relink_code IS NULL').bind(code, staffId).run()
      if (r.meta.changes) return code
      const cur = await db.prepare('SELECT relink_code FROM staff_profiles WHERE staff_id = ?').bind(staffId).first()
      if (cur?.relink_code) return cur.relink_code as string
    } catch { /* コード衝突時は再採番 */ }
  }
  throw new Error('relink code generation failed')
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
  const findLinked = () => db.prepare('SELECT staff_id FROM staff_profiles WHERE company_id = ? AND person_id = ? ORDER BY staff_id LIMIT 1').bind(u.company_id, src.person_id).first()
  const already = await findLinked()
  if (already) return c.json({ error: 'このスタッフは既に連携済みです', staff_id: already.staff_id }, 409)
  if (!src.in_service) return c.json({ error: SOURCE_RETIRED_MESSAGE }, 409)

  // 稼働先側のユーザー行（シフト・勤怠等の既存機能との互換用）。パスワードは照合不能＝稼働先の会社コードでは直接ログインできない。
  // 所属元でログインを持つスタッフは role='staff'（統合ログインの企業切替で稼働先の画面を利用可・フェーズH）、
  // ログインを持たない場合は role='roster_only'（お知らせ対象外）
  // 連携の経路（雇用元・途中の企業）がたどれないよう、ユーザーコードは自社内で新規に採番する
  // email はコピーしない（お知らせメールの宛先は送信時に linkedStaffEmails で雇用元の行から取る）
  // 退職日は雇用元の行の値（退職予定）を引き継ぐ。以後の変更は propagateRetirementStmts で伝える（#127）
  const userCode = 'LK-' + randHex(5).toUpperCase()
  const linkedRole = src.source_role === 'staff' ? 'staff' : 'roster_only'
  const now = nowJST()
  // 二度押し・同時送信で同じ人が二重に登録されないよう（#238）、ユーザー行・スタッフマスタ行・同意記録を1つの batch で作り、
  // 自社にその人の行がまだないときだけ作る。link_key の一意インデックス（0041）でも重複を防ぐ
  const notYet = 'NOT EXISTS (SELECT 1 FROM staff_profiles x WHERE x.company_id = ? AND x.person_id = ?)'
  const newUser = 'SELECT user_id FROM users WHERE company_id = ? AND user_code = ?'
  const linkKey = `${u.company_id}:${src.person_id}`
  let res: D1Result[]
  try {
    res = await db.batch([
      // 統合（staff-merge）で人物IDが付け替わった行に残る古い link_key は外す（別の人の連携が一意インデックスに当たらないように）
      db.prepare('UPDATE staff_profiles SET link_key = NULL WHERE link_key = ? AND person_id IS NOT ?').bind(linkKey, src.person_id),
      db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, person_id, retired_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${notYet}`)
        .bind(u.company_id, userCode, src.name, linkedRole, await unusablePasswordHash(), src.person_id, src.root_retired_at || null, u.company_id, src.person_id),
      db.prepare(`INSERT INTO staff_profiles (user_id, company_id, person_id, owner_company_id, affiliation_type, source_staff_id, root_staff_id, affiliation, link_key, created_at)
        SELECT user_id, ?, ?, ?, 'linked_external', ?, ?, ?, ?, ? FROM users WHERE user_id = (${newUser}) AND ${notYet}`)
        .bind(u.company_id, src.person_id, src.company_id, src.staff_id, src.root_staff_id, src.owner_company_name, linkKey, now,
          u.company_id, userCode, u.company_id, src.person_id),
      // 同意の日時は日本時間で保存する（#255。既定値の CURRENT_TIMESTAMP は UTC）
      db.prepare(`INSERT INTO roster_consents (company_id, user_id, person_id, source_staff_id, source_company_id, staff_id, consent_version, shared_scope, agreed, ip_address, user_agent, created_at)
        SELECT ?, ?, ?, ?, ?, sp.staff_id, ?, ?, 1, ?, ?, ? FROM staff_profiles sp WHERE sp.user_id = (${newUser})`)
        .bind(u.company_id, u.user_id, src.person_id, src.staff_id, src.company_id, CONSENT_VERSION, JSON.stringify(SHARED_SCOPE),
          c.req.header('cf-connecting-ip') || null, (c.req.header('user-agent') || '').slice(0, 300), now, u.company_id, userCode),
    ])
  } catch (e) {
    // 一意インデックスに当たった（別の送信が先に連携した）
    const dup = await findLinked()
    if (dup) return c.json({ error: 'このスタッフは既に連携済みです', staff_id: dup.staff_id }, 409)
    throw e
  }
  if (!res[2].meta.changes) {
    const dup = await findLinked()
    return c.json({ error: 'このスタッフは既に連携済みです', staff_id: dup?.staff_id ?? null }, 409)
  }
  const created = await db.prepare(`SELECT staff_id FROM staff_profiles WHERE user_id = (${newUser})`).bind(u.company_id, userCode).first()
  // 連携の記録と、所属元の管理者（#162）・スタッフ本人（#285）への通知。通知に失敗しても連携は取り消さない
  if (created?.staff_id) {
    try { await db.batch(linkedNoticeStmts(db, u, src, Number(created.staff_id), now)) } catch (e) { console.log(`roster link notice failed: staff=${created.staff_id}`) }
  }
  return c.json({ ok: true, staff_id: created?.staff_id })
})
// 連携が成立したときの記録と通知の文。所属元（コードの行の企業。多段連携では直前の企業）の管理者と、雇用元の行の本人（ログインのある人）に知らせる。
// 所属元の管理者には連携先の企業名を、本人には共有した先と連携元の企業名を出す（本人の情報なので、多段連携の先も本人には見せる）
function linkedNoticeStmts(db: D1Database, u: any, src: any, newStaffId: number, now: string): D1PreparedStatement[] {
  const host = String(u.company_name || '')
  const name = String(src.name || '')
  return [
    linkEventStmt(db, [newStaffId], 'linked', newStaffId, u, now),
    db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT ou.company_id, ou.user_id, 'roster_linked', ?, ?, ?, ?, ? FROM users ou
      WHERE ou.company_id = ? AND ou.status = 'active' AND ou.role IN ${NOTIFY_ADMIN_ROLES_SQL}`)
      .bind(`自社スタッフの連携: ${name}（${host}）`,
        `「${host}」が、自社のスタッフ ${name} さんを企業間連携で登録しました。連携先は基本項目（氏名・生年月日・最寄駅・スキル・経歴など）を参照できます。心当たりがない場合は、スタッフ詳細の「連携先企業」から連携を終了できます。`,
        `/admin#staff/${Number(src.staff_id)}`, src.staff_id, now, src.company_id),
    db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT ru.company_id, ru.user_id, 'roster_linked_staff', ?, ?, '#profile', r.staff_id, ? FROM staff_profiles r JOIN users ru ON ru.user_id = r.user_id
      WHERE r.staff_id = ? AND ru.role = 'staff' AND ru.status = 'active'`)
      .bind(`あなたの情報が「${host}」と共有されました`,
        `「${host}」が、あなたのスタッフ情報（氏名・生年月日・最寄駅・スキル・経歴など）を企業間連携で登録しました（連携元: ${src.owner_company_name || ''}）。共有中の会社は「その他 → プロフィール」で確認できます。心当たりがない場合は、所属会社の担当者に連絡してください。`,
        now, src.root_staff_id),
  ]
}

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
  // 自社雇用・④では所属先担当者名を保存しない（入力欄もない）
  if (type !== 'partner_manual') b.affiliation_contact = null
  const valueErr = normalizeRosterValues(b)
  if (valueErr) return c.json({ error: valueErr }, 400)

  // ログイン: ②は必須（自社スタッフとして勤怠報告等を行うため）、③は任意、④は作らない
  const wantsLogin = type === 'own_employee' || (type === 'partner_manual' && !!b.user_code && !!b.password)
  const missing = missingRequired(await getRequiredFields(db, u.company_id), b, 'create', type, wantsLogin)
  if (missing.length) return c.json({ error: `次の項目は必須です: ${missing.join('・')}`, missing }, 400)
  if (type === 'own_employee' && (!b.user_code || !b.password)) return c.json({ error: 'スタッフ番号・初期パスワードは必須です' }, 400)
  if (wantsLogin) {
    const pwErr = validatePassword(String(b.password))
    if (pwErr) return c.json({ error: pwErr }, 400)
  }
  // 同じ人の確認（#223）: 電話番号、または氏名と生年月日が同じスタッフがいれば確認を求める（force で登録を続ける）
  if (!b.force) {
    const matches = await findSamePersonCandidates(db, u.company_id, { name, phone: b.phone, date_of_birth: b.date_of_birth })
    if (matches.length) return c.json({ error: '同じ人と思われるスタッフが登録済みです', matches, need_force: true }, 409)
  }

  // 所属会社（取引先）の解決
  const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first())?.company_name as string) || ''
  let affiliation: string | null = null
  let partnerId: number | null = null
  if (type === 'own_employee') affiliation = ownName
  if (type === 'partner_manual') {
    if (b.partner_affiliation_id) {
      const p = await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ? AND merged_into_id IS NULL')
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
      // 統合済み（#161）の取引先と同じ名前なら、統合先を使う
      const p = await db.prepare(`SELECT t.affiliation_id, t.affiliation_name FROM staff_affiliations sa
        JOIN staff_affiliations t ON t.affiliation_id = COALESCE(sa.merged_into_id, sa.affiliation_id) WHERE sa.company_id = ? AND sa.affiliation_name = ?`).bind(u.company_id, pname).first()
      partnerId = p?.affiliation_id as number; affiliation = (p?.affiliation_name as string) || pname
    } else {
      return c.json({ error: '取引先を選択または新規登録してください' }, 400)
    }
  }
  if (type === 'skillsheet_only') affiliation = b.affiliation ? String(b.affiliation) : null

  if (type === 'own_employee' && b.hire_date && !isISODate(String(b.hire_date))) return c.json({ error: '入社年月日は「2000-01-31」の形式で入力してください' }, 400)
  if (type === 'own_employee' && b.employee_number) {
    const dup = await db.prepare('SELECT 1 FROM employee_records WHERE company_id = ? AND employee_number = ?').bind(u.company_id, b.employee_number).first()
    if (dup) return c.json({ error: 'この社員番号は既に使用されています' }, 409)
  }

  const person = await createPerson(db, u.company_id)
  // スタッフ番号はログイン画面と同じく全角を半角にそろえて保存する（#387）
  const userCode = wantsLogin ? String(b.user_code).normalize('NFKC').trim() : (type === 'skillsheet_only' ? 'SS-' : 'PT-') + person.global_staff_code
  // ログインしない人物は role='roster_only'（お知らせ対象・スタッフ数集計・ログインの対象外）
  const role = wantsLogin ? 'staff' : 'roster_only'
  const pwHash = wantsLogin ? await hashPassword(String(b.password)) : await unusablePasswordHash()

  let userId: number
  try {
    // 初期パスワードは管理者が決めたものなので、初回ログインで本人に変更を求める（#43）
    const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone, person_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, userCode, name, role, pwHash, wantsLogin ? (b.email || null) : null, b.phone || null, person.person_id, wantsLogin ? 1 : 0).run()
    userId = r.meta.last_row_id as number
  } catch {
    await db.prepare('DELETE FROM persons WHERE person_id = ?').bind(person.person_id).run()
    // 空いている番号を返し、画面の番号欄に入れ直せるようにする（#424）
    return c.json({ error: 'スタッフ番号が重複しています', suggested_code: wantsLogin ? (await nextStaffCode(db, u.company_id)).code : null }, 409)
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

  // ②では従業員管理（社員名簿）の最小レコードも同時に作成する。電話番号は従業員管理の電話番号にも入れる（従業員管理で直したら users.phone にそろえる。#123）
  if (type === 'own_employee' && (b.employee_number || b.hire_date || b.contract_type || b.phone)) {
    await db.prepare('INSERT INTO employee_records (staff_id, company_id, employee_number, hire_date, contract_type, phone_main, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(staffId, u.company_id, b.employee_number || null, b.hire_date || null, b.contract_type || null, b.phone || null, nowJST()).run()
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
  const db = c.env.DB
  const pick: Record<string, any> = { name: r.name, affiliation_type: r.affiliation_type, company_name: u.company_name }
  // PRポイント・備考は企業間で共有する業務情報のため、スタッフ本人向けには返さない
  for (const f of ROSTER_BASE_FIELDS) if (f !== 'pr_points' && f !== 'remarks') pick[f] = r[f]
  // 連携用ID（QR）は自社雇用の元データを持つ本人のみ表示。連携先の企業に切り替えていても、
  // 同じ人の自社雇用の行（今の企業の行 → 恒久IDを採番した企業の行の順）から探して表示する（#337）
  pick.global_staff_code = null
  pick.qr_company_name = null
  const ownRows = r.affiliation_type === 'own_employee' ? [{ staff_id: r.staff_id, company_id: u.company_id, company_name: u.company_name }]
    : u.person_id ? ((await db.prepare(`SELECT sp.staff_id, sp.company_id, co.company_name FROM staff_profiles sp
        JOIN users us ON us.user_id = sp.user_id AND us.person_id = sp.person_id JOIN companies co ON co.company_id = sp.company_id
        LEFT JOIN persons pe ON pe.person_id = sp.person_id
        WHERE sp.person_id = ? AND sp.affiliation_type = 'own_employee' AND sp.merged_into_staff_id IS NULL AND us.status = 'active'
        ORDER BY (sp.company_id != COALESCE(pe.created_company_id, sp.company_id)), sp.staff_id LIMIT 3`).bind(u.person_id).all()).results as any[]) : []
  for (const o of ownRows) {
    const own = o.staff_id === r.staff_id ? r : await loadRoster(db, o.staff_id, o.company_id)
    if (own && own.affiliation_type === 'own_employee' && own.link_shareable && own.global_staff_code) {
      pick.global_staff_code = own.global_staff_code
      pick.qr_company_name = o.company_name
      break
    }
  }
  // 共有範囲（連携の同意画面と同じ定数）。QR の画面で、IDを見せると何が共有されるかを示す（#229）
  pick.share_terms = { version: CONSENT_VERSION, shared: SHARED_SCOPE, not_shared: NOT_SHARED_SCOPE }
  // 共有中の会社（#285）: 本人のスタッフ情報を企業間連携で参照している会社と連携日（多段連携の先も含む。本人の情報なので本人には出す）。
  // 所属元が連携を終了した会社は ended で返す
  pick.shared_with = u.person_id ? ((await db.prepare(`SELECT co.company_name, sp.created_at AS linked_at, sp.link_revoked_at
      FROM staff_profiles sp JOIN companies co ON co.company_id = sp.company_id
      WHERE sp.person_id = ? AND sp.affiliation_type = 'linked_external' AND sp.merged_into_staff_id IS NULL AND sp.anonymized_at IS NULL
      ORDER BY sp.created_at, sp.staff_id LIMIT 100`).bind(u.person_id).all()).results as any[])
    .map(x => ({ company_name: x.company_name, linked_at: x.linked_at, ended: !!x.link_revoked_at, ended_at: x.link_revoked_at || null })) : []
  // ログイン情報（#337）。同じ人のログイン（他社連携の行 LK-… は除く）の会社コード・スタッフ番号と、登録済みの電話・メールを伏せ字で返す
  const logins = (await db.prepare(`SELECT us.user_code, us.phone, us.email, co.company_code, co.company_name FROM users us
      JOIN companies co ON co.company_id = us.company_id
      WHERE ${u.person_id ? 'us.person_id = ?' : 'us.user_id = ?'} AND us.role = 'staff' AND us.status = 'active' AND us.user_code NOT LIKE 'LK-%' AND us.user_code NOT LIKE 'TMP-%'
      ORDER BY (us.company_id != ?), us.user_id LIMIT 5`).bind(u.person_id || u.user_id, u.company_id).all()).results as any[]
  pick.logins = logins.map(l => ({ company_name: l.company_name, company_code: l.company_code, user_code: l.user_code,
    phone_masked: maskPhone(l.phone), email_masked: maskEmail(l.email) }))
  return c.json({ profile: pick })
})
// 電話番号は下4桁だけ、メールは先頭1文字とドメインだけを見せる（未登録なら null）
function maskPhone(v: any): string | null {
  const d = phoneDigits(String(v ?? ''))
  if (!d) return null
  return d.length <= 4 ? '****' : '*'.repeat(d.length - 4) + d.slice(-4)
}
function maskEmail(v: any): string | null {
  const s = String(v ?? '').trim()
  const at = s.lastIndexOf('@')
  if (!s || at < 1) return s ? '****' : null
  return s[0] + '***' + s.slice(at)
}

// 所属企業の一覧（統合ログインの企業切替用）。企業ごとの未読のお知らせの件数も返す（#203。切り替えていない企業の未読に気づけるように）
staffSelfApi.get('/companies', async (c) => {
  const u = c.get('user')
  const rows = await personStaffRows(c.env.DB, u)
  const unread = rows.length > 1 ? await countUnreadNotices(c.env.DB, rows.map(r => r.user_id)) : new Map<number, number>()
  return c.json({ current_company_id: u.company_id, companies: rows.map(r => ({ company_id: r.company_id, company_name: r.company_name, current: r.company_id === u.company_id, unread_notices: unread.get(r.user_id) || 0 })) })
})
// 企業切替: セッションを同一人物の別企業ユーザー行に付け替える（ログインは1つのまま。再ログイン不要）
staffSelfApi.post('/switch-company', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const target = (await personStaffRows(db, u)).find(r => r.company_id === Number(b.company_id))
  if (!target) return c.json({ error: '切り替え先の企業が見つかりません' }, 404)
  // 本部で停止にした企業へは切り替えない
  const co = await db.prepare('SELECT active_status FROM companies WHERE company_id = ?').bind(target.company_id).first()
  if (!co || !isCompanyActive(co.active_status)) return c.json({ error: 'この企業は現在ご利用いただけません' }, 403)
  const token = getCookie(c, 'session')
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  // sessions.token にはトークンのハッシュを保存している（src/lib/auth.ts）
  await db.prepare('UPDATE sessions SET user_id = ?, company_id = ? WHERE token = ?').bind(target.user_id, target.company_id, await hashToken(token)).run()
  return c.json({ ok: true, company_name: target.company_name })
})

export default rosterApi
