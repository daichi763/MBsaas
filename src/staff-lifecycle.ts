// =========================================================
// スタッフの所属区分の移行 / 仮登録 / 勤怠・日報の提出設定 / 報告用URL / 代理入力
// docs/spec_spot_shift.md 第2段階
//
// 管理者向け（/api/admin/*）は adminLifecycleApi、ログイン不要の報告用URL（/api/public/report/*）は publicReportApi。
// api.ts から認証ミドルウェアの前後に分けて登録する。金額は返さない（報告用URLはスタッフ本人向け）。
// =========================================================
import { Hono } from 'hono'
import { createPerson, partnerNameConflict } from './roster'
import { isSettled, loadPricingData, stripMoney, computeShiftPricing } from './shift-board'
import { JSON_IN, bindJsonArray, chunk } from './lib/d1-chunk'
import { syncActualFromReports } from './settlement'
import { isHHMM, pickReportValues, reportFieldRulesError } from './lib/validate'
import { findDailyReport, dailyReportView, dailyReportBlocked, saveDailyReport, mergeIncidentNotes } from './lib/daily-report'
import { notifyDailyReportIncident } from './notifications'
import { hashPassword, validatePassword, isCompanyActive } from './lib/auth'
import { issueTempPassword } from './accounts'
import { REPORT_TYPES, REPORT_LABEL, NEXT_DAY_TYPES, ACTUAL_SYNC_TYPES, attendanceTypesForShifts, checkReportable, flagsFromLegacyMode, applyLegacyStaffMode, setProjectDefaults } from './report-settings'
import { checkStaffReport, lateness, latenessSettings, loadReportState, reportStatus, shiftOverrideLogStatements } from './report-settings'
import { addMinutes, shiftWindow, type ShiftTimes } from './lib/shift-time'

type Bindings = { DB: D1Database; PHOTOS: R2Bucket }
type Variables = { user: any }

// ---------- 所属区分 ----------
// own_employee: 自社雇用（正社員・契約・アルバイト・パート）/ daily_worker: 自社日雇い（従業員管理なし）
// freelance: 個人事業主 / partner_manual: 取引先所属 / linked_external: 他社連携 / skillsheet_only: スキルシートのみ
export const WORKING_TYPES = ['own_employee', 'daily_worker', 'freelance', 'partner_manual'] as const
export const TYPE_LABEL: Record<string, string> = {
  own_employee: '自社雇用', daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属',
  linked_external: '他社連携', skillsheet_only: 'スキルシートのみ',
}
// 区分ごとの支払の種類（シフトの payee_type）
export function payeeTypeFor(type: string): string {
  if (type === 'linked_external') return 'linked'
  if (type === 'partner_manual') return 'partner'
  if (type === 'freelance') return 'freelance'
  if (type === 'daily_worker') return 'payroll_daily'
  return 'payroll'
}

// ---------- 仮登録の作成（仮登録API・募集の承認で共用）。ログインは発行しない ----------
// email は users.email（ログイン・再設定・お知らせの宛先）に入る。応募フォームなど本人確認をしていないメールは unverified_email に渡す（#38 #148）
export async function insertProvisionalStaff(db: D1Database, companyId: number, byUserId: number | null, o: {
  name: string; phone: string; type: string; affiliation: string | null; partnerId: number | null; kana?: any; gender?: any
  attendance_mode?: any; daily_report_mode?: any; memo?: any; email?: string | null; unverified_email?: string | null; note: string
}) {
  const person = await createPerson(db, companyId)
  const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, phone, email, person_id) VALUES (?, ?, ?, 'roster_only', ?, ?, ?, ?)`)
    .bind(companyId, 'TMP-' + person.global_staff_code, o.name, await unusablePasswordHash(), o.phone || null, o.email || null, person.person_id).run()
  const sr = await db.prepare(`INSERT INTO staff_profiles (user_id, company_id, person_id, owner_company_id, affiliation_type, partner_affiliation_id, affiliation,
      kana, gender, skills, career, work_area, employment_status, is_provisional, attendance_mode, daily_report_mode, memo, unverified_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'working', 1, ?, ?, ?, ?)`)
    .bind(r.meta.last_row_id, companyId, person.person_id, companyId, o.type, o.partnerId, o.affiliation,
      o.kana || null, o.gender || null,
      ['none', 'in_out', 'full'].includes(o.attendance_mode) ? o.attendance_mode : null,
      ['none', 'required'].includes(o.daily_report_mode) ? o.daily_report_mode : null, o.memo || null, String(o.unverified_email || '').trim() || null).run()
  const staffId = sr.meta.last_row_id as number
  await db.prepare(`INSERT INTO staff_affiliation_history (company_id, staff_id, from_type, to_type, effective_date, to_affiliation, partner_affiliation_id, note, changed_by)
    VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?)`).bind(companyId, staffId, o.type, nowJST().slice(0, 10), o.affiliation, o.partnerId, o.note, byUserId).run()
  return { staff_id: staffId, global_staff_code: person.global_staff_code }
}
export async function findStaffByPhone(db: D1Database, companyId: number, phone: string) {
  const p = normalizePhone(phone); if (p.length < 10) return []
  return ((await db.prepare(`SELECT sp.staff_id, us.name, us.phone, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.is_provisional
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND us.phone IS NOT NULL AND sp.merged_into_staff_id IS NULL`)
    .bind(companyId).all()).results as any[]).filter(r => normalizePhone(r.phone) === p)
}

// ---------- 提出設定（案件 → スタッフ → シフト の順に上書き） ----------
export const ATTENDANCE_MODES = ['none', 'in_out', 'full'] as const
export const DAILY_REPORT_MODES = ['none', 'required'] as const
// シフト単位の例外（shifts.attendance_mode）の意味。full は「案件 × スタッフの報告設定どおり」
// 案件・スタッフ単位の勤怠の提出設定は 0027 で 8 種類の設定（report-settings.ts）に移した。ここでは日報の提出設定のみを解決する
export const ATTENDANCE_TYPES_BY_MODE: Record<string, string[]> = {
  none: [], in_out: ['check_in', 'check_out'], full: [...REPORT_TYPES],
}
export function resolveModes(project: any, staff: any, shift: any) {
  const pick = (vals: any[], allowed: readonly string[], d: string) => vals.find(v => v && allowed.includes(v)) || d
  const attendance = pick([shift?.attendance_mode, staff?.attendance_mode, project?.attendance_mode], ATTENDANCE_MODES, 'full')
  const daily = pick([shift?.daily_report_mode, staff?.daily_report_mode, project?.daily_report_mode], DAILY_REPORT_MODES, 'required')
  const source = (k: 'attendance_mode' | 'daily_report_mode') => shift?.[k] ? 'shift' : staff?.[k] ? 'staff' : 'project'
  return {
    attendance_mode: attendance, daily_report_mode: daily,
    required_attendance: ATTENDANCE_TYPES_BY_MODE[attendance] as string[], daily_report_required: daily === 'required',
    attendance_source: source('attendance_mode') as string, daily_report_source: source('daily_report_mode'),
  }
}
// シフトID群に対して、提出設定を解決する（スタッフのホーム・報告API・報告URL・ダッシュボード・シフト詳細）
// 勤怠: 8 種類の報告設定（シフトの例外 → 案件 × スタッフ → 案件の標準設定）。日報: 従来どおり（シフト → スタッフ → 案件）
export async function modesForShifts(db: D1Database, shiftIds: number[]) {
  const map = new Map<number, ReturnType<typeof resolveModes>>()
  if (!shiftIds.length) return map
  const ids = [...new Set(shiftIds)]
  const att = await attendanceTypesForShifts(db, ids)
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const rows = (await db.prepare(`SELECT s.shift_id, s.attendance_mode AS s_att, s.daily_report_mode AS s_dr,
        sp.daily_report_mode AS sp_dr, p.daily_report_mode AS p_dr
      FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id
      WHERE s.shift_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results as any[]
    for (const r of rows) {
      const m = resolveModes({ daily_report_mode: r.p_dr }, { daily_report_mode: r.sp_dr }, { attendance_mode: r.s_att, daily_report_mode: r.s_dr })
      const a = att.get(r.shift_id)
      m.required_attendance = a ? a.types : [...REPORT_TYPES]
      m.attendance_source = a ? a.source : 'default'
      map.set(r.shift_id, m)
    }
  }
  return map
}

// ---------- ユーティリティ ----------
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
function addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
function randToken(bytes = 24): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function unusablePasswordHash(): Promise<string> { return sha256('!nologin!' + randToken(24)) }
// 電話番号の正規化（数字のみ。+81 は 0 に）
export function normalizePhone(p: any): string {
  let s = String(p || '').replace(/[^\d+]/g, '')
  if (s.startsWith('+81')) s = '0' + s.slice(3)
  return s.replace(/\D/g, '')
}

async function loadStaffRow(db: D1Database, companyId: number, staffId: any) {
  return db.prepare(`SELECT sp.*, us.name, us.phone, us.email, us.role AS user_role, us.user_code, us.status AS user_status, us.retired_at
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(staffId, companyId).first() as Promise<any>
}

// =========================================================
// 管理者向けAPI（/api/admin/*）
// =========================================================
export const adminLifecycleApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ---------- 仮登録（氏名・電話だけで登録し、すぐシフトに入れられる） ----------
// 電話番号で既存スタッフと照合し、一致した場合は既存のスタッフを返す（重複登録を防ぐ）
adminLifecycleApi.get('/staff-lookup', async (c) => {
  const u = c.get('user'); const phone = normalizePhone(c.req.query('phone'))
  if (phone.length < 10) return c.json({ matches: [] })
  const rows = (await c.env.DB.prepare(`SELECT sp.staff_id, us.name, us.phone, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.is_provisional, sp.employment_status
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND us.phone IS NOT NULL AND sp.merged_into_staff_id IS NULL`).bind(u.company_id).all()).results as any[]
  return c.json({ matches: rows.filter(r => normalizePhone(r.phone) === phone) })
})

adminLifecycleApi.post('/staff-quick', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const name = String(b.name || '').trim()
  const phone = normalizePhone(b.phone)
  const type = String(b.affiliation_type || 'daily_worker')
  if (!name) return c.json({ error: '氏名を入力してください' }, 400)
  if (phone.length < 10 || phone.length > 11) return c.json({ error: '電話番号を正しく入力してください' }, 400)
  if (!['daily_worker', 'freelance', 'partner_manual', 'own_employee'].includes(type)) return c.json({ error: '区分が正しくありません' }, 400)
  // 同じ画面からの再送（先の送信で作成済み）は、作成済みのスタッフを返す（#568）
  const key = String(b.request_key || '').slice(0, 64) || null
  if (key) {
    const prev = await db.prepare(`SELECT sp.staff_id, pe.global_staff_code FROM staff_quick_locks lk
      JOIN staff_profiles sp ON sp.staff_id = lk.staff_id AND sp.company_id = lk.company_id LEFT JOIN persons pe ON pe.person_id = sp.person_id
      WHERE lk.company_id = ? AND lk.phone_norm = ? AND lk.request_key = ?`).bind(u.company_id, phone, key).first() as any
    if (prev) return c.json({ ok: true, staff_id: prev.staff_id, global_staff_code: prev.global_staff_code, reused: true })
  }
  // 電話番号の重複確認（force で登録を続行できる）
  const dup = ((await db.prepare(`SELECT sp.staff_id, us.name, us.phone FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND us.phone IS NOT NULL AND sp.merged_into_staff_id IS NULL`)
    .bind(u.company_id).all()).results as any[]).filter(r => normalizePhone(r.phone) === phone)
  if (dup.length && !b.force) return c.json({ error: 'この電話番号のスタッフが登録済みです', matches: dup, need_force: true }, 409)

  let affiliation: string | null = null, partnerId: number | null = null
  const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first())?.company_name as string) || ''
  if (type === 'own_employee' || type === 'daily_worker') affiliation = ownName
  if (type === 'freelance') affiliation = String(b.trade_name || '').trim() || '個人事業主'
  if (type === 'partner_manual') {
    if (b.partner_affiliation_id) {
      const p = await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?').bind(b.partner_affiliation_id, u.company_id).first() as any
      if (!p) return c.json({ error: '取引先が見つかりません' }, 404)
      partnerId = p.affiliation_id; affiliation = p.affiliation_name
    } else if (String(b.new_partner_name || '').trim()) {
      const pname = String(b.new_partner_name).trim()
      if (pname === ownName) return c.json({ error: '自社名は取引先として登録できません' }, 400)
      const conflict = await partnerNameConflict(db, u.company_id, pname)
      if (conflict) return c.json({ error: conflict }, 400)
      await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(u.company_id, pname).run()
      const p = await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(u.company_id, pname).first() as any
      partnerId = p?.affiliation_id ?? null; affiliation = pname
    } else return c.json({ error: '取引先を選択または入力してください' }, 400)
  }

  // 二度押し・同時送信の防止（#568）: 同じ電話番号の仮登録は、処理中と直後 QUICK_LOCK_MS の間は1件だけにする。
  // 同じ画面からの再送（request_key が同じ）には、作成済みのスタッフを返す。
  // 直後でも、別の画面から force で「別の人として登録」したときは新しく作る
  const now = Date.now()
  const claim = await db.prepare(`INSERT INTO staff_quick_locks (company_id, phone_norm, request_key, staff_id, created_at) VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(company_id, phone_norm) DO UPDATE SET request_key = excluded.request_key, staff_id = NULL, created_at = excluded.created_at
    WHERE staff_quick_locks.created_at < ?
      OR (? = 1 AND staff_quick_locks.staff_id IS NOT NULL AND COALESCE(staff_quick_locks.request_key, '') != COALESCE(excluded.request_key, ''))`)
    .bind(u.company_id, phone, key, now, now - QUICK_LOCK_MS, b.force ? 1 : 0).run()
  if (!claim.meta.changes) {
    const lk = await db.prepare('SELECT request_key, staff_id FROM staff_quick_locks WHERE company_id = ? AND phone_norm = ?').bind(u.company_id, phone).first() as any
    if (lk?.staff_id && (lk.request_key || null) === key) {
      const prev = await db.prepare(`SELECT sp.staff_id, pe.global_staff_code FROM staff_profiles sp LEFT JOIN persons pe ON pe.person_id = sp.person_id
        WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(lk.staff_id, u.company_id).first() as any
      if (prev) return c.json({ ok: true, staff_id: prev.staff_id, global_staff_code: prev.global_staff_code, reused: true })
    }
    return c.json({ error: 'この電話番号の仮登録を処理中です。少し待ってから一覧を確認してください' }, 409)
  }
  let created: { staff_id: number; global_staff_code: string }
  try {
    created = await insertProvisionalStaff(db, u.company_id, u.user_id, { name, phone, type, affiliation, partnerId, kana: b.kana, gender: b.gender,
      attendance_mode: b.attendance_mode, daily_report_mode: b.daily_report_mode, memo: b.memo, email: null, note: '仮登録' })
  } catch (e) {
    await db.prepare('DELETE FROM staff_quick_locks WHERE company_id = ? AND phone_norm = ? AND staff_id IS NULL').bind(u.company_id, phone).run().catch(() => {})
    throw e
  }
  await db.prepare('UPDATE staff_quick_locks SET staff_id = ? WHERE company_id = ? AND phone_norm = ?').bind(created.staff_id, u.company_id, phone).run()
  return c.json({ ok: true, ...created })
})
// 仮登録の重複防止の時間（ミリ秒）
const QUICK_LOCK_MS = 60 * 1000

// ---------- 本登録（仮登録を解除。ログイン発行は任意） ----------
adminLifecycleApi.post('/staff/:id/finalize', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (sp.merged_into_staff_id) return c.json({ error: '統合済みのスタッフです' }, 409)
  if (!sp.is_provisional) return c.json({ error: 'このスタッフは本登録済みです' }, 400)
  if (!sp.gender && !b.gender) return c.json({ error: '本登録には性別の入力が必要です' }, 400)
  const stmts: D1PreparedStatement[] = []
  if (b.gender) stmts.push(db.prepare('UPDATE staff_profiles SET gender = ? WHERE staff_id = ?').bind(b.gender, sp.staff_id))
  // フリガナは空欄なら今の値を残す（応募時に入力されたフリガナを消さない。#505）
  const kana = typeof b.kana === 'string' ? b.kana.trim() : ''
  if (kana) stmts.push(db.prepare('UPDATE staff_profiles SET kana = ? WHERE staff_id = ?').bind(kana.slice(0, 60), sp.staff_id))
  if (b.user_code || b.password) {
    const login = await loginStatements(db, u.company_id, sp, b)
    if ('error' in login) return c.json({ error: login.error }, login.status as any)
    stmts.push(...login.stmts)
  }
  stmts.push(db.prepare('UPDATE staff_profiles SET is_provisional = 0 WHERE staff_id = ?').bind(sp.staff_id))
  // まとめて実行する（スタッフ番号の重複で失敗したら、性別・フリガナ・本登録もやり直せるように取り消す）
  try { await db.batch(stmts) } catch { return c.json({ error: 'スタッフ番号が重複しています' }, 409) }
  return c.json({ ok: true, ...(b.user_code || b.password ? { login: loginGuide(c, b) } : {}) })
})

// ---------- ログインの発行（本登録・後からの発行で共用。#89 #103 #148） ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// ログイン用のメール: use_unverified_email なら応募時の未確認のメールを、管理者が確認したものとして使う。
// email キーがあればその値（空欄は NULL）で上書きする。どちらもなければ今の値のまま
function loginEmail(sp: any, b: any): { set: boolean; email: string | null; clearUnverified: boolean } | { error: string } {
  if (b.use_unverified_email === true) {
    const v = String(sp.unverified_email || '').trim()
    if (!v) return { error: '未確認のメールアドレスがありません' }
    return { set: true, email: v, clearUnverified: true }
  }
  if (b.email === undefined || b.email === null) return { set: false, email: null, clearUnverified: false }
  const v = String(b.email).trim()
  if (v && (v.length > 254 || !EMAIL_RE.test(v))) return { error: 'メールアドレスの形式が正しくありません' }
  return { set: true, email: v || null, clearUnverified: !!v && v.toLowerCase() === String(sp.unverified_email || '').trim().toLowerCase() }
}
// 他社へ連携した先の行（多段連携の先を含む）。本人がログインを持ったら、連携先でもアプリでシフトを見て報告できるようにする（#103）。
// 連携した時点で所属元にログインがなかった行は roster_only で作られているため、ここで staff に変える（roster.ts の /link と同じ扱い）
export function promoteLinkedLoginsStmt(db: D1Database, staffId: number) {
  return db.prepare(`WITH RECURSIVE down(id) AS (
      SELECT staff_id FROM staff_profiles WHERE source_staff_id = ? AND affiliation_type = 'linked_external'
      UNION SELECT sp.staff_id FROM staff_profiles sp JOIN down ON sp.source_staff_id = down.id WHERE sp.affiliation_type = 'linked_external')
    UPDATE users SET role = 'staff' WHERE role = 'roster_only' AND status = 'active'
      AND user_id IN (SELECT sp.user_id FROM staff_profiles sp WHERE sp.staff_id IN (SELECT id FROM down) AND sp.merged_into_staff_id IS NULL)`).bind(staffId)
}
// 入力を確かめて、ログインを発行する文を返す（実行は呼び出し側で db.batch。スタッフ番号の重複は batch の失敗になる）
// 初期パスワードは管理者が決めたものなので、初回ログインで本人に変更を求める（must_change_password。#43）。
// スタッフ番号はログイン画面と同じく全角を半角にそろえて保存する（#387）
async function loginStatements(db: D1Database, companyId: number, sp: any, b: any): Promise<{ stmts: D1PreparedStatement[] } | { error: string; status: number }> {
  const code = String(b.user_code || '').normalize('NFKC').trim()
  b.user_code = code
  if (!code || !b.password) return { error: 'ログインを発行する場合は、スタッフ番号とパスワードを入力してください', status: 400 }
  if (code.length > 50) return { error: 'スタッフ番号は50文字以内で入力してください', status: 400 }
  const pwErr = validatePassword(b.password)
  if (pwErr) return { error: pwErr, status: 400 }
  const em = loginEmail(sp, b)
  if ('error' in em) return { error: em.error, status: 400 }
  const stmts = [
    db.prepare(`UPDATE users SET user_code = ?, password_hash = ?, role = 'staff', must_change_password = 1, email = CASE WHEN ? = 1 THEN ? ELSE email END WHERE user_id = ? AND company_id = ?`)
      .bind(code, await hashPassword(String(b.password)), em.set ? 1 : 0, em.email, sp.user_id, companyId),
  ]
  if (em.clearUnverified) stmts.push(db.prepare('UPDATE staff_profiles SET unverified_email = NULL WHERE staff_id = ?').bind(sp.staff_id))
  stmts.push(promoteLinkedLoginsStmt(db, sp.staff_id))
  return { stmts }
}
// 本人に渡すログイン案内（#328）。ログインURLは会社コードを入れた状態で開く（/login?c=）。初期パスワードは管理者が入力した値をそのまま返す（保存はしない）
function loginGuide(c: any, b: any) {
  const u = c.get('user')
  const origin = new URL(c.req.url).origin
  return { login_url: `${origin}/login?c=${encodeURIComponent(u.company_code || '')}`, company_code: u.company_code || '', company_name: u.company_name || '',
    user_code: String(b.user_code || ''), password: String(b.password || '') }
}
// 自社で発行したログインか（他社連携の行は、連携時に照合できないパスワードで作った LK- の行。区分を変えても自社のログインはない）
function hasOwnLogin(sp: any) { return sp.user_role === 'staff' && !String(sp.user_code || '').startsWith('LK-') }
function canIssueLogin(sp: any) {
  const t = sp.affiliation_type || 'own_employee'
  return !sp.merged_into_staff_id && !sp.is_provisional && !hasOwnLogin(sp) && t !== 'linked_external' && t !== 'skillsheet_only'
    && sp.user_status === 'active' && sp.employment_status !== 'retired' && !(sp.retired_at && sp.retired_at < todayJST())
}

// 仮登録ではない、ログインのないスタッフ（ログインなしで登録した人・本登録でログインを発行しなかった人・他社連携から自社管理に切り替えた人）に、後からログインを発行する（#89）
adminLifecycleApi.post('/staff/:id/issue-login', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (sp.merged_into_staff_id) return c.json({ error: '統合済みのスタッフです' }, 409)
  const t = sp.affiliation_type || 'own_employee'
  if (t === 'linked_external') return c.json({ error: '他社から連携したスタッフのログインは、所属元の会社で発行します（所属元のログインから企業を切り替えて使えます）' }, 400)
  if (t === 'skillsheet_only') return c.json({ error: 'スキルシートのみのスタッフにはログインを発行できません' }, 400)
  if (sp.is_provisional) return c.json({ error: '仮登録のスタッフは「本登録する」からログインを発行してください' }, 400)
  if (hasOwnLogin(sp)) return c.json({ error: 'このスタッフにはすでにログインがあります' }, 409)
  if (!canIssueLogin(sp)) return c.json({ error: '退職・停止中のスタッフにはログインを発行できません' }, 409)
  const login = await loginStatements(db, u.company_id, sp, b)
  if ('error' in login) return c.json({ error: login.error }, login.status as any)
  try { await db.batch(login.stmts) } catch { return c.json({ error: 'スタッフ番号が重複しています' }, 409) }
  return c.json({ ok: true, login: loginGuide(c, b) })
})

// 未確認のメール（応募フォーム・統合元から引き継いだもの）を、本人に確認できたらログイン・再設定用に設定する／不要なら消す（#38 #148）
adminLifecycleApi.post('/staff/:id/unverified-email', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (sp.merged_into_staff_id) return c.json({ error: '統合済みのスタッフです' }, 409)
  const v = String(sp.unverified_email || '').trim()
  if (!v) return c.json({ error: '未確認のメールアドレスはありません' }, 404)
  if (b.action === 'discard') {
    await db.prepare('UPDATE staff_profiles SET unverified_email = NULL WHERE staff_id = ?').bind(sp.staff_id).run()
    return c.json({ ok: true })
  }
  if (b.action !== 'confirm') return c.json({ error: '操作が正しくありません' }, 400)
  if ((sp.affiliation_type || 'own_employee') === 'linked_external') return c.json({ error: '他社から連携したスタッフのメールアドレスは、所属元の会社で設定します' }, 400)
  await db.batch([
    db.prepare('UPDATE users SET email = ? WHERE user_id = ? AND company_id = ?').bind(v, sp.user_id, u.company_id),
    db.prepare('UPDATE staff_profiles SET unverified_email = NULL WHERE staff_id = ?').bind(sp.staff_id),
  ])
  return c.json({ ok: true })
})

// ---------- 所属区分の変更（dry_run で影響範囲を確認 → 実行） ----------
// - 確認（dry_run）が返す preview_token を実行のときに送る。区分・適用日・取引先・入社日・置き換えるシフトが
//   確認したときと変わっていれば 409 を返し、確認し直してもらう（#100）
// - 適用日が明日以降なら予約（staff_affiliation_schedules）として保存し、適用日の早朝に cron が切り替える（#82）
// - 実行は 1 回の db.batch（トランザクション）にまとめ、途中で失敗しても区分だけが変わることがないようにする（#121）
// - 勤怠報告・実績の入力・日報のどれかがあるシフト（勤務済み）は置き換えない（#149）
// - 区分がすでに変更先と同じでも、支払先が前の区分のままの予定シフトが残っていれば、支払先の付け直しとして実行できる（#121）
type PayeeRow = { payee_type: string; payee_affiliation_id: number | null; payee_company_id: number | null }
function payeeOfProfile(sp: any): PayeeRow {
  const t = sp.affiliation_type || 'own_employee'
  return { payee_type: payeeTypeFor(t), payee_affiliation_id: t === 'partner_manual' ? sp.partner_affiliation_id ?? null : null, payee_company_id: t === 'linked_external' ? sp.owner_company_id ?? null : null }
}
type AffPlan = {
  from: string; to: string; effective: string; affiliation: string | null; partnerId: number | null; newPartnerName: string | null
  tradeName: string | null; hire: string | null; contractType: string | null; er: any; repair: boolean; scheduled: boolean
  targets: any[]; excluded: number; effects: string[]; warnings: string[]; token: string
  // 勤務済みのため置き換えないシフト（実行時に affiliation_excluded_shifts へ記録し、支払先が変更後と違うものを精算の確認事項に出す。#233）。
  // differs = 今の支払先が変更後と違う。同じものも記録し、精算では最後の区分変更の支払先で判定する（元の区分に戻したときに前の記録で確認事項が残らないように）
  excludedShifts?: { shift_id: number; work_date: string; differs: boolean }[]
}
type PlanResult = { ok: true; plan: AffPlan } | { ok: false; error: string; status: 400 | 404 | 409 }
async function planAffiliationChange(db: D1Database, companyId: number, sp: any, b: any, opts: { today: string; fromSchedule?: boolean }): Promise<PlanResult> {
  const fail = (error: string, status: 400 | 404 | 409 = 400): PlanResult => ({ ok: false, error, status })
  if (sp.merged_into_staff_id) return fail('統合済みのスタッフの区分は変更できません', 409)
  const from = sp.affiliation_type || 'own_employee'
  const to = String(b.to_type || '')
  if (b.effective_date && !isDate(b.effective_date)) return fail('適用日を正しく入力してください')
  if (b.hire_date && !isDate(b.hire_date)) return fail('入社日を正しく入力してください')
  const effective: string = isDate(b.effective_date) ? b.effective_date : opts.today
  if (from === 'skillsheet_only') return fail('スキルシートのみのスタッフは区分を変更できません（新規に登録してください）')
  if (!WORKING_TYPES.includes(to as any)) return fail('変更先の区分が正しくありません')
  // 予約中の変更がある間は、新しい変更を受け付けない（取り消してから）
  if (!opts.fromSchedule) {
    const pending = await db.prepare(`SELECT effective_date, to_type FROM staff_affiliation_schedules WHERE staff_id = ? AND company_id = ? AND status = 'pending'`).bind(sp.staff_id, companyId).first() as any
    if (pending) return fail(`予約中の区分変更があります（${pending.effective_date} から「${TYPE_LABEL[pending.to_type] || pending.to_type}」）。取り消してから変更してください`, 409)
  }

  // 変更先の所属会社
  const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(companyId).first())?.company_name as string) || ''
  let affiliation: string | null = null, partnerId: number | null = null, newPartnerName: string | null = null
  const tradeName = to === 'freelance' ? String(b.trade_name || '').trim() || null : null
  if (to === 'own_employee' || to === 'daily_worker') affiliation = ownName
  if (to === 'freelance') affiliation = tradeName || '個人事業主'
  if (to === 'partner_manual') {
    if (b.partner_affiliation_id) {
      const p = await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?').bind(b.partner_affiliation_id, companyId).first() as any
      if (!p) return fail('取引先が見つかりません', 404)
      partnerId = p.affiliation_id; affiliation = p.affiliation_name
    } else if (String(b.new_partner_name || '').trim()) {
      affiliation = String(b.new_partner_name).trim()
      if (affiliation === ownName) return fail('自社名は取引先として登録できません')
      const conflict = await partnerNameConflict(db, companyId, affiliation)
      if (conflict) return fail(conflict)
      // 同じ名前の取引先が登録済みならそれを使う
      const p = await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(companyId, affiliation).first() as any
      if (p) partnerId = p.affiliation_id
      else newPartnerName = affiliation
    } else return fail('取引先を選択または入力してください')
  }
  const newPayee: PayeeRow = { payee_type: payeeTypeFor(to), payee_affiliation_id: to === 'partner_manual' ? partnerId : null, payee_company_id: null }
  const repair = to === from && (to !== 'partner_manual' || (partnerId != null && partnerId === sp.partner_affiliation_id))
  const scheduled = !opts.fromSchedule && !repair && effective > opts.today
  const hire = to === 'own_employee' && !repair ? (isDate(b.hire_date) ? b.hire_date : effective) : null
  const contractType = to === 'own_employee' ? String(b.contract_type || '').trim() || null : null

  // 影響範囲: 適用日以降の未確定・欠勤以外のシフトのうち、勤務済みでないもの
  const shifts = (await db.prepare(`SELECT s.shift_id, s.work_date, s.price_locked, s.payee_type, s.payee_affiliation_id, s.payee_company_id,
      EXISTS (SELECT 1 FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS reported,
      (s.actual_start IS NOT NULL OR s.actual_end IS NOT NULL OR s.actual_source = 'manual') AS has_actual,
      EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.shift_id = s.shift_id) AS has_daily
    FROM shifts s WHERE s.staff_id = ? AND s.company_id = ? AND s.work_date >= ? AND s.status != 'absent' AND COALESCE(s.settle_status,'planned') != 'confirmed'
    ORDER BY s.work_date, s.shift_id`).bind(sp.staff_id, companyId, effective).all()).results as any[]
  const unworked = shifts.filter(s => !s.reported && !s.has_actual && !s.has_daily)
  const excluded = shifts.length - unworked.length
  const samePayee = (s: any) => (s.payee_type || 'payroll') === newPayee.payee_type && (newPayee.payee_type !== 'partner' || s.payee_affiliation_id === newPayee.payee_affiliation_id)
  const targets = repair ? unworked.filter(s => !samePayee(s)) : unworked
  if (repair && !targets.length) return fail(to === 'partner_manual' ? '現在と同じ取引先です' : '現在と同じ区分です')

  const er = await db.prepare('SELECT * FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sp.staff_id, companyId).first() as any
  const linksOut = ((await db.prepare(`SELECT COUNT(*) AS n FROM staff_profiles WHERE source_staff_id = ? AND affiliation_type = 'linked_external'`).bind(sp.staff_id).first()) as any)?.n || 0
  const effects: string[] = [], warnings: string[] = []
  if (scheduled) effects.push(`適用日が明日以降のため、予約として保存します。${effective} の早朝に自動で切り替わり、それまでは「${TYPE_LABEL[from]}」のままです（予約は取り消せます）`)
  if (repair) effects.push(`区分はすでに「${TYPE_LABEL[to]}${to === 'partner_manual' && affiliation ? '（' + affiliation + '）' : ''}」です。支払先が前の区分のままになっている予定シフトを置き換えます`)
  if (to === 'own_employee' && !repair) {
    if (er && (er.hire_date || er.employment_ended_at)) effects.push(`従業員管理のデータを再開します（入社日 ${hire}）。前の雇用期間（入社 ${er.hire_date || '未登録'}〜雇用終了 ${er.employment_ended_at || '未登録'}）は雇用期間の履歴に残します`)
    else effects.push(er ? `従業員管理のデータを再開します（入社日 ${hire}）` : `従業員管理のデータを作成します（入社日 ${hire}）`)
  }
  if (from === 'own_employee' && to !== 'own_employee') effects.push(`従業員管理のデータを「雇用終了（${addDays(effective, -1)}）」として保持します（削除しません・7年保存）`)
  if (from === 'linked_external' && !repair) {
    effects.push('他社との連携を終了し、基本情報をコピーして自社で管理します（元の企業への通知はしません）')
    effects.push('所属元との企業間チャットは終了します。これまでのやり取りは「企業間チャット」の一覧から閲覧できます')
  }
  if (linksOut && !repair) effects.push(`自社から他社への連携 ${linksOut} 件は継続します（企業間チャットもそのまま使えます）`)
  effects.push(`適用日以降の予定シフト ${targets.length} 件の支払先・単価を置き換えます${scheduled ? '（件数は今の時点のものです。適用日に数え直します）' : ''}`)
  // 置き換えないシフトは実行したときに記録し、支払先が変更後と違うものを精算の確認事項『区分変更の対象外』に出す（#233）
  const excludedShifts = scheduled ? [] : shifts.filter(s => s.reported || s.has_actual || s.has_daily)
    .map(s => ({ shift_id: s.shift_id as number, work_date: s.work_date as string, differs: !samePayee(s) }))
  if (excluded) {
    const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
    const differ = excludedShifts.filter(s => s.differs)
    const dates = [...new Set(differ.map(s => md(s.work_date)))]
    effects.push(`勤務済み（勤怠報告・実績の入力・日報のどれかがある）の ${excluded} 件は置き換えません`
      + (dates.length ? `。うち支払先が変わる ${differ.length} 件（${dates.slice(0, 10).join('、')}${dates.length > 10 ? ' ほか' : ''}）は精算の確認事項に出します（精算の画面から今の区分の支払先・単価に置き換えられます）` : ''))
  }
  if (targets.some(s => s.price_locked)) effects.push(`うち手動で金額を変更した ${targets.filter(s => s.price_locked).length} 件は、支払先のみ置き換えます`)
  if (!repair) {
    if (from === 'linked_external') effects.push(sp.user_role === 'staff' ? 'ログインは所属元のアカウントのままです（自社で発行する場合は、変更の後に「区分・登録状態」の「ログインを発行」から）' : 'ログインはありません（報告用URLまたは代理入力で記録します）')
    else if (sp.user_role === 'staff') effects.push('ログインはそのまま使えます')
  }
  if (effective < opts.today) {
    const past = targets.filter(s => s.work_date < opts.today)
    warnings.push(`適用日（${effective}）が今日より前です。${past.length ? `過去の未確定シフト ${past.length} 件（${past[0].work_date}〜${past[past.length - 1].work_date}）も置き換えの対象です。` : ''}日付に誤りがないか確認してください`)
  }
  const token = await sha256(JSON.stringify([sp.staff_id, from, to, effective, affiliation, partnerId, newPartnerName, tradeName, hire, contractType, repair, scheduled, targets.map(s => s.shift_id)]))
  return { ok: true, plan: { from, to, effective, affiliation, partnerId, newPartnerName, tradeName, hire, contractType, er, repair, scheduled, targets, excluded, effects, warnings, token, excludedShifts } }
}

// 取引先の新規登録（区分変更の実行・予約のとき）。同じ名前があればそれを使う
async function ensurePartner(db: D1Database, companyId: number, name: string): Promise<number | null> {
  await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(companyId, name).run()
  return ((await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(companyId, name).first()) as any)?.affiliation_id ?? null
}

// シフトの更新を JSON 1 つにまとめた UPDATE 文（1 文あたり 100 件）。確定済みのシフトは書き換えない
const PRICE_COLUMNS = ['bill_unit_type', 'bill_rate', 'bill_qty', 'unit_price', 'pay_unit_type', 'pay_rate', 'pay_qty', 'pay_amount',
  'bill_transport_type', 'bill_transport_amount', 'pay_transport_type', 'pay_transport_amount', 'payee_type', 'payee_affiliation_id', 'payee_company_id', 'price_source', 'price_locked']
const PAYEE_COLUMNS = ['payee_type', 'payee_affiliation_id', 'payee_company_id']
function shiftUpdateStmts(db: D1Database, companyId: number, cols: string[], rows: Record<string, any>[]): D1PreparedStatement[] {
  const sql = `UPDATE shifts SET ${cols.map((c, i) => `${c} = j.v${i}`).join(', ')}
    FROM (SELECT json_extract(value, '$.shift_id') AS k, ${cols.map((c, i) => `json_extract(value, '$.${c}') AS v${i}`).join(', ')} FROM json_each(?)) AS j
    WHERE shifts.shift_id = j.k AND shifts.company_id = ? AND COALESCE(shifts.settle_status,'planned') != 'confirmed'`
  return chunk(rows, 100).map(part => db.prepare(sql).bind(JSON.stringify(part.map(r => Object.fromEntries(['shift_id', ...cols].map(c => [c, r[c] ?? null])))), companyId))
}

// 区分変更の実行。すべての更新を 1 回の db.batch にまとめる（scheduleId: cron から予約を適用するとき）
async function executeAffiliationChange(db: D1Database, companyId: number, actorId: number | null, sp: any, p: AffPlan, note: string | null, scheduleId?: number) {
  const { from, to, effective, affiliation } = p
  let partnerId = p.partnerId
  if (to === 'partner_manual' && !partnerId && p.newPartnerName) partnerId = await ensurePartner(db, companyId, p.newPartnerName)
  const now = nowJST()
  const stmts: D1PreparedStatement[] = []

  if (!p.repair) {
    // 他社連携 → 自社で管理: 所属元の基本項目をコピーし、連携を外す
    if (from === 'linked_external' && sp.source_staff_id) {
      // 基本項目は雇用元の行（多段連携なら root_staff_id）からコピーする。
      // 所属先担当者名は雇用元の値をコピーしない（多段連携で隠している雇用元の担当者が見えるため。roster.ts の ROSTER_LOCAL_FIELDS）。
      // 取引先所属に切り替える場合は自社の行の値を残し、自社雇用・日雇い・個人事業主では前の会社の担当者なので空にする
      const src = await db.prepare('SELECT * FROM staff_profiles WHERE staff_id = ?').bind(sp.root_staff_id || sp.source_staff_id).first() as any
      if (src) {
        stmts.push(db.prepare(`UPDATE staff_profiles SET kana = ?, gender = ?, date_of_birth = ?, skills = ?, career = ?, career_rows = ?, pr_points = ?, remarks = ?, work_area = ?, age_group = ?,
            nearest_station_line = ?, nearest_station = ?, commute_minutes = ?, available_from = ?,
            affiliation_contact = CASE WHEN ? = 'partner_manual' THEN affiliation_contact ELSE NULL END WHERE staff_id = ?`)
          .bind(src.kana, src.gender, src.date_of_birth, src.skills, src.career, src.career_rows, src.pr_points, src.remarks, src.work_area, src.age_group, src.nearest_station_line, src.nearest_station,
            src.commute_minutes, src.available_from, to, sp.staff_id))
      }
      // 稼働先側のユーザー行は照合不能パスワードのままなので、ログインは所属元のまま。自社で使う場合は本登録でログインを発行する
    }
    stmts.push(db.prepare(`UPDATE staff_profiles SET affiliation_type = ?, affiliation = ?, partner_affiliation_id = ?, owner_company_id = ?,
        source_staff_id = CASE WHEN ? = 'linked_external' THEN NULL ELSE source_staff_id END,
        root_staff_id = CASE WHEN ? = 'linked_external' THEN NULL ELSE root_staff_id END, relink_code = NULL WHERE staff_id = ? AND company_id = ?`)
      .bind(to, affiliation, to === 'partner_manual' ? partnerId : null, companyId, from, from, sp.staff_id, companyId))
    // 多段連携の中間企業が自社管理に切り替えた場合、その先（自社から連携した企業・さらにその先）の基本項目の参照先を自社の行に付け替える
    if (from === 'linked_external') {
      stmts.push(db.prepare(`WITH RECURSIVE down(id) AS (
          SELECT staff_id FROM staff_profiles WHERE source_staff_id = ? AND affiliation_type = 'linked_external'
          UNION SELECT sp.staff_id FROM staff_profiles sp JOIN down ON sp.source_staff_id = down.id WHERE sp.affiliation_type = 'linked_external')
        UPDATE staff_profiles SET root_staff_id = ? WHERE staff_id IN (SELECT id FROM down)`).bind(sp.staff_id, sp.staff_id))
    }
    // 従業員管理
    const er = p.er
    if (to === 'own_employee') {
      if (er) {
        // 再雇用: 前の雇用期間（入社日・雇用終了日）を上書きする前に履歴に残す（#99）
        if (er.hire_date || er.employment_ended_at) stmts.push(db.prepare(`INSERT INTO employment_periods (company_id, staff_id, hire_date, employment_ended_at, ended_reason, contract_type, recorded_by, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(companyId, sp.staff_id, er.hire_date || null, er.employment_ended_at || null, er.ended_reason || null, er.contract_type || null, actorId, now))
        stmts.push(db.prepare('UPDATE employee_records SET employment_ended_at = NULL, ended_reason = NULL, hire_date = ?, contract_type = COALESCE(?, contract_type), updated_at = ? WHERE staff_id = ?')
          .bind(p.hire, p.contractType, now, sp.staff_id))
      } else stmts.push(db.prepare('INSERT INTO employee_records (staff_id, company_id, hire_date, contract_type, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(sp.staff_id, companyId, p.hire, p.contractType, now))
    } else if (from === 'own_employee') {
      if (er) stmts.push(db.prepare('UPDATE employee_records SET employment_ended_at = ?, ended_reason = ?, updated_at = ? WHERE staff_id = ?')
        .bind(addDays(effective, -1), `区分変更（${TYPE_LABEL[to]}）`, now, sp.staff_id))
      else stmts.push(db.prepare('INSERT INTO employee_records (staff_id, company_id, employment_ended_at, ended_reason, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(sp.staff_id, companyId, addDays(effective, -1), `区分変更（${TYPE_LABEL[to]}）`, now))
    }
  }

  // 予定シフトの支払先・単価の置き換え（手動変更の金額は保持し、支払先のみ）。必要な行をまとめて読み、メモリ上で計算する
  const payee: PayeeRow = { payee_type: payeeTypeFor(to), payee_affiliation_id: to === 'partner_manual' ? partnerId : null, payee_company_id: null }
  const ids = bindJsonArray(p.targets.map(s => s.shift_id))
  const rows = ids === '[]' ? [] : (await db.prepare(`SELECT * FROM shifts WHERE company_id = ? AND shift_id IN ${JSON_IN}`).bind(companyId, ids).all()).results as any[]
  const roleIds = bindJsonArray(rows.map(s => s.slot_role_id))
  const roles = new Map((roleIds === '[]' ? [] : (await db.prepare(`SELECT * FROM shift_slot_roles WHERE slot_role_id IN ${JSON_IN}`).bind(roleIds).all()).results as any[]).map(r => [r.slot_role_id, r]))
  const data = await loadPricingData(db, companyId, rows.map(s => s.project_id))
  const priced: Record<string, any>[] = [], locked: Record<string, any>[] = []
  for (const s of rows) {
    if (s.price_locked) { locked.push({ shift_id: s.shift_id, ...payee }); continue }
    // applyPricingToShift と同じ計算（支払先は変更後の区分）
    priced.push({ shift_id: s.shift_id, ...computeShiftPricing(companyId, s, s.slot_role_id ? roles.get(s.slot_role_id) || null : null, payee, data) })
  }
  stmts.push(...shiftUpdateStmts(db, companyId, PRICE_COLUMNS, priced), ...shiftUpdateStmts(db, companyId, PAYEE_COLUMNS, locked))

  // 変更履歴。変更前の支払先を残し、適用日より前のシフトを計算し直したときに使う（shift-board.ts の resolvePayee）。付け直しでは残さない
  const fromPayee = p.repair ? null : payeeOfProfile(sp)
  const histNote = [p.repair ? '支払先の付け直し' : '', scheduleId ? '予約を適用' : '', note || ''].filter(Boolean).join('・') || null
  stmts.push(db.prepare(`INSERT INTO staff_affiliation_history (company_id, staff_id, from_type, to_type, effective_date, from_affiliation, to_affiliation, partner_affiliation_id, affected_shifts, excluded_shifts,
      from_payee_type, from_payee_affiliation_id, from_payee_company_id, note, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(companyId, sp.staff_id, from, to, effective, sp.affiliation ?? null, affiliation, partnerId, rows.length, p.excluded,
      fromPayee?.payee_type ?? null, fromPayee?.payee_affiliation_id ?? null, fromPayee?.payee_company_id ?? null, histNote, actorId))
  // 勤務済みのため置き換えなかったシフトと変更後の支払先を、この履歴に結び付けて記録する（精算の確認事項。#233）
  const excludedIds = bindJsonArray((p.excludedShifts || []).map(s => s.shift_id))
  if (excludedIds !== '[]') stmts.push(db.prepare(`INSERT OR IGNORE INTO affiliation_excluded_shifts (history_id, company_id, staff_id, shift_id, to_payee_type, to_payee_affiliation_id)
      SELECT (SELECT MAX(history_id) FROM staff_affiliation_history WHERE staff_id = ? AND company_id = ?), ?, ?, value, ?, ? FROM json_each(?)`)
    .bind(sp.staff_id, companyId, companyId, sp.staff_id, payee.payee_type, payee.payee_affiliation_id, excludedIds))
  if (scheduleId) stmts.push(db.prepare(`UPDATE staff_affiliation_schedules SET status = 'applied', applied_at = ?, error = NULL,
      history_id = (SELECT MAX(history_id) FROM staff_affiliation_history WHERE staff_id = ? AND company_id = ?) WHERE schedule_id = ? AND status = 'pending'`)
    .bind(now, sp.staff_id, companyId, scheduleId))
  await db.batch(stmts)
  return { affected_shifts: rows.length, excluded_shifts: p.excluded }
}

adminLifecycleApi.post('/staff/:id/affiliation-change', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const r = await planAffiliationChange(db, u.company_id, sp, b, { today: todayJST() })
  if (!r.ok) return c.json({ error: r.error }, r.status)
  const p = r.plan
  if (b.dry_run) return c.json({
    from_type: p.from, to_type: p.to, from_label: TYPE_LABEL[p.from], to_label: TYPE_LABEL[p.to], effective_date: p.effective, affiliation: p.affiliation,
    hire_date: p.hire, scheduled: p.scheduled, repair: p.repair, affected_shifts: p.targets.length, excluded_shifts: p.excluded,
    effects: p.effects, warnings: p.warnings, preview_token: p.token,
  })
  // 確認した内容と違えば実行しない（#100）
  if (!b.preview_token) return c.json({ error: '「影響を確認する」で内容を確認してから実行してください' }, 400)
  if (b.preview_token !== p.token) return c.json({ error: '確認したときから内容が変わりました。もう一度「影響を確認する」を押してください', preview_changed: true }, 409)
  const note = String(b.note || '').trim().slice(0, 300) || null

  if (p.scheduled) {
    // 予約: 区分・従業員管理・シフトは適用日まで変えない。新しい取引先は今のうちに取引先マスタへ登録しておく
    const partnerId = p.to === 'partner_manual' && !p.partnerId && p.newPartnerName ? await ensurePartner(db, u.company_id, p.newPartnerName) : p.partnerId
    try {
      const res = await db.prepare(`INSERT INTO staff_affiliation_schedules (company_id, staff_id, from_type, to_type, effective_date, to_affiliation, partner_affiliation_id, request_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, sp.staff_id, p.from, p.to, p.effective, p.affiliation, partnerId,
        JSON.stringify({ trade_name: p.tradeName, hire_date: p.hire, contract_type: p.contractType, note }), u.user_id).run()
      return c.json({ ok: true, scheduled: true, schedule_id: res.meta.last_row_id, effective_date: p.effective, affected_shifts: 0 })
    } catch { return c.json({ error: '予約中の区分変更があります。取り消してから変更してください' }, 409) }
  }
  const done = await executeAffiliationChange(db, u.company_id, u.user_id, sp, p, note)
  return c.json({ ok: true, ...done })
})

// 区分変更の予約の取消（適用できなかった予約は、確認したら表示を消せるように同じく取消にする）
adminLifecycleApi.delete('/staff/:id/affiliation-schedules/:scheduleId', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`UPDATE staff_affiliation_schedules SET status = 'canceled', canceled_by = ?, canceled_at = ?
    WHERE schedule_id = ? AND staff_id = ? AND company_id = ? AND status IN ('pending', 'failed')`).bind(u.user_id, nowJST(), c.req.param('scheduleId'), c.req.param('id'), u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '取り消せる予約が見つかりません（適用済み・取消済みの可能性があります）' }, 404)
  return c.json({ ok: true })
})

// 適用日になった区分変更の予約を適用する（毎日の cron。index.tsx の scheduled）。
// 予約したときと状況が変わって適用できない場合（統合・退職・同じ区分になった等）は failed にして理由を残す
export async function applyDueAffiliationSchedules(db: D1Database) {
  const today = todayJST()
  const due = (await db.prepare(`SELECT * FROM staff_affiliation_schedules WHERE status = 'pending' AND effective_date <= ? ORDER BY effective_date, schedule_id LIMIT 100`).bind(today).all()).results as any[]
  let applied = 0, failed = 0
  const markFailed = async (id: number, msg: string) => {
    failed++
    await db.prepare(`UPDATE staff_affiliation_schedules SET status = 'failed', error = ? WHERE schedule_id = ? AND status = 'pending'`).bind(msg.slice(0, 300), id).run()
  }
  for (const s of due) {
    try {
      const sp = await loadStaffRow(db, s.company_id, s.staff_id)
      if (!sp) { await markFailed(s.schedule_id, 'スタッフが見つかりません'); continue }
      if (sp.employment_status === 'retired' || sp.user_status !== 'active') { await markFailed(s.schedule_id, '退職・停止中のため適用しませんでした'); continue }
      let req: any = {}; try { req = JSON.parse(s.request_json || '{}') } catch { }
      const body = { to_type: s.to_type, effective_date: s.effective_date, partner_affiliation_id: s.partner_affiliation_id, trade_name: req.trade_name, hire_date: req.hire_date, contract_type: req.contract_type }
      const r = await planAffiliationChange(db, s.company_id, sp, body, { today, fromSchedule: true })
      if (!r.ok) { await markFailed(s.schedule_id, r.error); continue }
      if (r.plan.repair) { await markFailed(s.schedule_id, `すでに「${TYPE_LABEL[s.to_type] || s.to_type}」に変更されています`); continue }
      await executeAffiliationChange(db, s.company_id, s.created_by ?? null, sp, r.plan, req.note || null, s.schedule_id)
      applied++
    } catch (e) {
      try { await markFailed(s.schedule_id, '適用に失敗しました: ' + String(e)) } catch { }
    }
  }
  return { due: due.length, applied, failed }
}

adminLifecycleApi.get('/staff/:id/lifecycle', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const history = (await db.prepare(`SELECT h.*, um.name AS changed_by_name FROM staff_affiliation_history h LEFT JOIN users um ON um.user_id = h.changed_by
    WHERE h.staff_id = ? AND h.company_id = ? ORDER BY h.effective_date DESC, h.history_id DESC`).bind(sp.staff_id, u.company_id).all()).results
  const er = await db.prepare('SELECT employment_ended_at, ended_reason, hire_date FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sp.staff_id, u.company_id).first()
  // 区分変更の予約（予約中と、適用できなかったもの）と、過去の雇用期間（再雇用の前の期間）
  const schedules = (await db.prepare(`SELECT schedule_id, to_type, effective_date, to_affiliation, status, error, created_at FROM staff_affiliation_schedules
    WHERE staff_id = ? AND company_id = ? AND status IN ('pending', 'failed') ORDER BY schedule_id DESC LIMIT 5`).bind(sp.staff_id, u.company_id).all()).results
  const employment_periods = (await db.prepare(`SELECT hire_date, employment_ended_at, ended_reason, contract_type, recorded_at FROM employment_periods
    WHERE staff_id = ? AND company_id = ? ORDER BY period_id DESC`).bind(sp.staff_id, u.company_id).all()).results
  return c.json({
    staff_id: sp.staff_id, affiliation_type: sp.affiliation_type || 'own_employee', is_provisional: !!sp.is_provisional,
    // 他社連携の行の LK- コードは自社ではログインに使えないため、スタッフ番号として返さない（#569）
    has_login: sp.user_role === 'staff', user_code: hasOwnLogin(sp) ? sp.user_code : null, phone: sp.phone,
    // 本登録・ログインの発行の画面に今の値を出す（#148 #505）。unverified_email は応募フォームなどで入力された未確認のメール
    has_own_login: hasOwnLogin(sp), can_issue_login: canIssueLogin(sp), email: sp.email || null, unverified_email: sp.unverified_email || null,
    kana: sp.kana || null, gender: sp.gender || null,
    attendance_mode: sp.attendance_mode, daily_report_mode: sp.daily_report_mode, employee_record: er, history, schedules, employment_periods,
    partner_affiliation_id: sp.partner_affiliation_id,
    merged_into_staff_id: sp.merged_into_staff_id, merged_at: sp.merged_at,
    merged_into_name: sp.merged_into_staff_id ? ((await db.prepare('SELECT us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(sp.merged_into_staff_id).first()) as any)?.name : null,
  })
})

// ---------- パスワードの再発行（#45。メールのないスタッフも、管理者が仮パスワードを発行してログインできる状態に戻す） ----------
// 自社でログインを発行したスタッフだけが対象。他社から連携したスタッフは所属元の会社で再発行する（稼働先の行ではログインできない）。
// 仮パスワードはこの応答で一度だけ返し、次回ログインで本人に変更を求める。今のセッションと未使用の再設定リンクは無効にする
adminLifecycleApi.post('/staff/:id/reset-password', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (sp.merged_into_staff_id) return c.json({ error: '統合済みのスタッフです。統合先のスタッフで再発行してください' }, 409)
  if (sp.affiliation_type === 'linked_external') return c.json({ error: '他社から連携したスタッフのパスワードは、所属元の会社で再発行してください' }, 400)
  if (sp.user_role !== 'staff') return c.json({ error: 'このスタッフにはログインが発行されていません' }, 400)
  if (sp.user_status !== 'active') return c.json({ error: '退職・停止中のスタッフのパスワードは再発行できません' }, 409)
  const owner = await db.prepare('SELECT company_id FROM users WHERE user_id = ?').bind(sp.user_id).first() as any
  if (!owner || owner.company_id !== u.company_id) return c.json({ error: 'このスタッフのパスワードは、所属元の会社で再発行してください' }, 400)
  const tempPassword = await issueTempPassword(db, sp.user_id)
  return c.json({
    ok: true, temp_password: tempPassword, name: sp.name, user_code: sp.user_code, company_code: u.company_code,
    login_url: new URL(c.req.url).origin + '/login', has_email: !!(sp.email && String(sp.email).trim()),
  })
})

// ---------- 提出設定 ----------
function modeVal(v: any, allowed: readonly string[]) { return v === '' || v === null ? null : allowed.includes(v) ? v : undefined }
adminLifecycleApi.put('/staff/:id/report-settings', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(c.env.DB, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const a = b.attendance_mode === undefined ? undefined : modeVal(b.attendance_mode, ATTENDANCE_MODES)
  const d = modeVal(b.daily_report_mode, DAILY_REPORT_MODES)
  if ((b.attendance_mode !== undefined && a === undefined) || d === undefined) return c.json({ error: '設定値が正しくありません' }, 400)
  await c.env.DB.prepare('UPDATE staff_profiles SET daily_report_mode = ? WHERE staff_id = ?').bind(d, sp.staff_id).run()
  // 勤怠は案件 × スタッフの報告設定に書き込む（所属する全案件。空は案件の標準設定に戻す）
  if (b.attendance_mode !== undefined) await applyLegacyStaffMode(c.env.DB, u.company_id, sp.staff_id, a, u)
  return c.json({ ok: true })
})
adminLifecycleApi.put('/projects/:id/report-settings', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const p = await c.env.DB.prepare('SELECT project_id FROM projects WHERE project_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first()
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const a = ATTENDANCE_MODES.includes(b.attendance_mode) ? b.attendance_mode : null, d = DAILY_REPORT_MODES.includes(b.daily_report_mode) ? b.daily_report_mode : null
  if ((b.attendance_mode !== undefined && !a) || !d) return c.json({ error: '設定値が正しくありません' }, 400)
  await c.env.DB.prepare('UPDATE projects SET daily_report_mode = ? WHERE project_id = ?').bind(d, c.req.param('id')).run()
  // 勤怠は案件の標準設定（8 種類）に書き込む
  if (a) await setProjectDefaults(c.env.DB, u.company_id, Number(c.req.param('id')), flagsFromLegacyMode(a), u)
  return c.json({ ok: true })
})

// シフトの報告状況（提出設定・報告済み・報告用URL）
async function ownShift(db: D1Database, companyId: number, shiftId: any) {
  return db.prepare(`SELECT s.*, us.name AS staff_name, p.project_name, p.attendance_mode AS p_att, p.daily_report_mode AS p_dr,
      sp.attendance_mode AS sp_att, sp.daily_report_mode AS sp_dr, sp.is_provisional, us.role AS user_role,
      p.default_break_minutes AS p_break_minutes, sp.merged_into_staff_id, sp.employment_status, us.retired_at
    FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id JOIN projects p ON p.project_id = s.project_id
    WHERE s.shift_id = ? AND s.company_id = ?`).bind(shiftId, companyId).first() as Promise<any>
}
adminLifecycleApi.get('/shifts/:id/report-status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await ownShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const modes = (await modesForShifts(db, [s.shift_id])).get(s.shift_id)!
  const reports = (await db.prepare(`SELECT a.report_type, a.reported_at, a.status, a.late_minutes, a.early_leave_minutes, a.entry_method, a.corrected_by_correction_id, a.original_reported_at, um.name AS entered_by_name FROM attendance_reports a
    LEFT JOIN users um ON um.user_id = a.entered_by WHERE a.shift_id = ?`).bind(s.shift_id).all()).results
  const dr = await findDailyReport(db, s)
  const daily = dr ? { daily_report_id: dr.daily_report_id, submitted_at: dr.submitted_at, entry_method: dr.entry_method } : null
  const token = await currentReportToken(db, s)
  // 代理入力: 受け付けない理由（確定済み・欠勤・稼働日より前）と、時刻が空欄のときの既定値
  const proxyBlocked = isSettled(s) ? '確定済み' : s.status === 'absent' ? '欠勤' : s.work_date > todayJST() ? '稼働日より前' : null
  const proxy_defaults = proxyDefaultTimes(s, Number(s.break_minutes ?? s.p_break_minutes ?? 0) || 0)
  // 他社連携のスタッフ（他社連携から区分を変えた LK- の行も）は、所属元のアカウントから企業を切り替えて報告する（自社のログインではない。#569）
  const aff = await db.prepare('SELECT sp.affiliation_type, us.user_code FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(s.staff_id).first() as any
  const viaOwner = s.user_role === 'staff' && (aff?.affiliation_type === 'linked_external' || String(aff?.user_code || '').startsWith('LK-'))
  return c.json({ shift_id: s.shift_id, staff_name: s.staff_name, has_login: s.user_role === 'staff', login_via_owner: viaOwner,shift_attendance_mode: s.attendance_mode, shift_daily_report_mode: s.daily_report_mode, modes, reports, daily_report: daily, token,
    work_date: s.work_date, start_time: s.start_time, end_time: s.end_time, now: nowJST(), proxy_blocked: proxyBlocked, proxy_defaults })
})
adminLifecycleApi.put('/shifts/:id/report-settings', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const a = modeVal(b.attendance_mode, ATTENDANCE_MODES), d = modeVal(b.daily_report_mode, DAILY_REPORT_MODES)
  if (a === undefined || d === undefined) return c.json({ error: '設定値が正しくありません' }, 400)
  // シフト単位の例外の変更は、報告設定の変更履歴にも残す（#313。同じ batch で書く）
  const logs = await shiftOverrideLogStatements(c.env.DB, u.company_id, s, a, u)
  await c.env.DB.batch([c.env.DB.prepare('UPDATE shifts SET attendance_mode = ?, daily_report_mode = ? WHERE shift_id = ?').bind(a, d, s.shift_id), ...logs])
  return c.json({ ok: true })
})

// ---------- 代理入力（管理者が勤怠を記録。entry_method='proxy'） ----------
// 時刻は種類ごとに times: { check_in: 'HH:MM', ... } で受け取る（1つの時刻を全種類に使わない）。
// 日付は受け取らない。稼働日の前日・当日・翌日のうち、その種類の予定の日時（shiftWindow から決める）に近い日付で記録する（夜勤の翌日分）。
// 空欄の種類は予定から既定の時刻を決める（proxyDefaultTimes）。押した日時は使わない。決められない種類は入力を必須にする。
const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b.replace(' ', 'T') + 'Z') - Date.parse(a.replace(' ', 'T') + 'Z')) / 60000)
const fmtAt = (at: string) => `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))} ${at.slice(11, 16)}`
// 時刻（HH:MM）を日時にする。目安: 勤務終了・退店 = 予定の終了、休憩 = 勤務時間の中ほど、それ以外 = 予定の開始。
// 稼働日の前日・当日・翌日のうち、目安に最も近い日付を選ぶ（同じ近さなら稼働日）。
// ただし起床・出発は翌日に、休憩・勤務終了・退店は前日にしない（夜勤の日中の起床を翌日にしないなど）
function proxyDateTime(s: ShiftTimes, type: string, hhmm: string): string {
  const w = shiftWindow(s.work_date, s.start_time, s.end_time)
  const anchor = ['work_end', 'check_out'].includes(type) ? w.end
    : ['break_start', 'break_end'].includes(type) ? addMinutes(w.start, Math.floor(minutesBetween(w.start, w.end) / 2)) : w.start
  const offsets = ['wake_up', 'departure'].includes(type) ? [-1] : ['check_in', 'work_start'].includes(type) ? [-1, 1] : [1]
  let best = `${s.work_date} ${hhmm}:00`
  for (const d of offsets.map(n => addDays(s.work_date, n))) {
    const at = `${d} ${hhmm}:00`
    if (Math.abs(minutesBetween(anchor, at)) < Math.abs(minutesBetween(anchor, best))) best = at
  }
  return best
}
// 時刻が空欄のときの既定値。入店・勤務開始 = 予定の開始、勤務終了・退店 = 予定の終了、
// 休憩 = 予定の休憩を勤務時間の中ほどに置いた時刻（予定の休憩がなければ決められない）。起床・出発は決められない（null）
function proxyDefaultTimes(s: ShiftTimes, breakMinutes: number): Record<string, string | null> {
  const w = shiftWindow(s.work_date, s.start_time, s.end_time)
  const span = minutesBetween(w.start, w.end)
  const out: Record<string, string | null> = { wake_up: null, departure: null, check_in: w.start, work_start: w.start, break_start: null, break_end: null, work_end: w.end, check_out: w.end }
  if (breakMinutes > 0 && breakMinutes < span) {
    const bs = addMinutes(w.start, Math.floor((span - breakMinutes) / 2 / 15) * 15)
    out.break_start = bs; out.break_end = addMinutes(bs, breakMinutes)
  }
  return out
}
// 同じ時刻を許さない組（後の種類 → 前の種類）。実働・休憩が0分になるのを防ぐ
const PROXY_STRICT_AFTER: Record<string, string[]> = { break_end: ['break_start'], work_end: ['check_in', 'work_start'], check_out: ['check_in', 'work_start'] }

adminLifecycleApi.post('/shifts/:id/proxy-attendance', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const s = await ownShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  // 取り消し（DELETE）・報告用URLの発行と同じ条件
  if (isSettled(s)) return c.json({ error: '確定済みのシフトです。精算画面で確定を取り消してください' }, 409)
  if (s.status === 'absent') return c.json({ error: '欠勤のシフトには代理入力できません' }, 400)
  const now = nowJST()
  if (s.work_date > now.slice(0, 10)) return c.json({ error: '稼働日より前のシフトには代理入力できません' }, 400)
  const raw: any[] = Array.isArray(b.report_types) ? b.report_types : [b.report_type]
  const types = REPORT_TYPES.filter(t => raw.includes(t)) as string[] // 報告の順に並べる
  if (!types.length) return c.json({ error: '報告の種類を選択してください' }, 400)
  // 時刻（種類ごと）。旧形式の time（1つ）は、種類が1つのときだけ受け付ける
  let times: Record<string, any> = b.times && typeof b.times === 'object' ? b.times : {}
  if (!b.times && b.time) {
    if (types.length > 1) return c.json({ error: '時刻は報告の種類ごとに入力してください' }, 400)
    times = { [types[0]]: b.time }
  }
  const modes = (await modesForShifts(db, [s.shift_id])).get(s.shift_id)!
  const existing = (await db.prepare('SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ?').bind(s.shift_id).all()).results as any[]
  // 必要な種類か・報告済みでないか（checkReportable と同じ文言）。順序は下で時刻の前後関係として確かめる。
  // 前の報告が欠けていても記録できる（起床・出発などを管理者が知らないことがあるため。欠けた報告も後から代理入力できる）
  const done = new Set(existing.map(r => r.report_type as string))
  for (const t of types) {
    if (!modes.required_attendance.includes(t)) return c.json({ error: `${REPORT_LABEL[t]}: このシフトでは不要な報告です` }, 400)
    if (done.has(t)) return c.json({ error: `${REPORT_LABEL[t]}: すでに報告済みです` }, 409)
  }
  // 記録する日時
  const defaults = proxyDefaultTimes(s, Number(s.break_minutes ?? s.p_break_minutes ?? 0) || 0)
  const atOf = new Map<string, string>()
  for (const t of types) {
    const v = times[t]
    if (v !== undefined && v !== null && v !== '' && !isHHMM(v)) return c.json({ error: `${REPORT_LABEL[t]}の時刻が正しくありません` }, 400)
    const at = v ? proxyDateTime(s, t, v) : defaults[t]
    if (!at) return c.json({ error: `${REPORT_LABEL[t]}の時刻を入力してください（予定から決められません）` }, 400)
    if (at > now) return c.json({ error: `${REPORT_LABEL[t]}（${fmtAt(at)}）はまだ先の日時です。実際の時刻を入力してください` }, 400)
    atOf.set(t, at)
  }
  // 時刻の前後関係（すでにある報告も含めて、報告の順に並んでいるか）
  const all = new Map<string, string>(existing.map(r => [r.report_type, r.reported_at]))
  for (const [t, at] of atOf) all.set(t, at)
  const ordered = REPORT_TYPES.filter(t => all.has(t)) as string[]
  for (let j = 0; j < ordered.length; j++) for (let i = 0; i < j; i++) {
    const ti = ordered[i], tj = ordered[j]
    if (!atOf.has(ti) && !atOf.has(tj)) continue
    const ai = all.get(ti)!, aj = all.get(tj)!
    if (aj < ai) return c.json({ error: `${REPORT_LABEL[tj]}（${fmtAt(aj)}）が${REPORT_LABEL[ti]}（${fmtAt(ai)}）より前になっています` }, 400)
    if (aj === ai && PROXY_STRICT_AFTER[tj]?.includes(ti)) return c.json({ error: `${REPORT_LABEL[tj]}と${REPORT_LABEL[ti]}が同じ時刻（${fmtAt(aj)}）です` }, 400)
  }
  // 遅刻・早退は、アプリ・報告用URLと同じ判定（report-settings.ts の lateness。入店・勤務開始の遅刻と猶予、勤務終了・退店の早退）
  const judged = lateness(s, types.map(t => ({ report_type: t, reported_at: atOf.get(t)! })), latenessSettings(u.settings_json))
  const rows = judged.map(j => ({ report_type: j.report_type, reported_at: atOf.get(j.report_type)!, status: j.late ? 'late' : 'normal',
    late_minutes: j.late_minutes, early_leave_minutes: j.early_leave_minutes }))
  try {
    await db.batch(rows.map(r => db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, entry_method, entered_by, late_minutes, early_leave_minutes)
      VALUES (?, ?, ?, ?, ?, ?, 'proxy', 'proxy', ?, ?, ?)`).bind(u.company_id, s.staff_id, s.shift_id, r.report_type, r.reported_at, r.status, u.user_id, r.late_minutes, r.early_leave_minutes)))
  } catch (e: any) {
    // 本人の報告と同時になった場合（attendance_reports の一意制約）
    if (/UNIQUE constraint/i.test(String(e?.message || e))) return c.json({ error: 'すでに報告済みです（画面を開き直してください）' }, 409)
    throw e
  }
  if (types.some(t => ACTUAL_SYNC_TYPES.includes(t))) await syncActualFromReports(db, u.company_id, s.shift_id).catch(() => {})
  return c.json({ ok: true, created: rows.length, reports: rows })
})
adminLifecycleApi.delete('/shifts/:id/proxy-attendance/:type', async (c) => {
  const u = c.get('user')
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  // 取り消せるのは代理入力のみ（本人の報告は取り消せない）
  if (s.settle_status === 'confirmed') return c.json({ error: '確定済みのシフトです。精算画面で確定を取り消してください' }, 409)
  // 承認済みの打刻修正で直した報告は取り消さない（承認の記録と食い違うため。#252）
  const corrected = await c.env.DB.prepare("SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ? AND entry_method = 'proxy' AND corrected_by_correction_id IS NOT NULL")
    .bind(s.shift_id, c.req.param('type')).first()
  if (corrected) return c.json({ error: '承認済みの打刻修正で直した報告は取り消せません。打刻修正の申請で時刻を直してください' }, 409)
  const r = await c.env.DB.prepare("DELETE FROM attendance_reports WHERE shift_id = ? AND report_type = ? AND entry_method = 'proxy' AND corrected_by_correction_id IS NULL").bind(s.shift_id, c.req.param('type')).run()
  await syncActualFromReports(c.env.DB, u.company_id, s.shift_id).catch(() => {})
  return c.json({ ok: true, deleted: r.meta.changes || 0 })
})

// ---------- 報告用URL（シフト専用。稼働日の翌日 23:59 まで有効） ----------
// 有効期限は、確認するときのシフトの稼働日から決める（発行後にシフトの日付を変えても、新しい稼働日の翌日まで使える。#68）。
// shift_report_tokens.expires_at は発行時の値の記録として残す
function reportTokenExpiry(workDate: string): string { return `${addDays(workDate, 1)} 23:59:59` }
// シフトの今の担当者に発行した、使える報告用URL（差し替え前の担当者のURLは使えないので出さない。#81）
async function currentReportToken(db: D1Database, s: { shift_id: number; staff_id: number; work_date: string }) {
  if (reportTokenExpiry(s.work_date) <= nowJST()) return null
  const t = await db.prepare('SELECT token, last_used_at FROM shift_report_tokens WHERE shift_id = ? AND staff_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1')
    .bind(s.shift_id, s.staff_id).first() as any
  return t ? { ...t, expires_at: reportTokenExpiry(s.work_date) } : null
}
adminLifecycleApi.post('/shifts/:id/report-link', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await ownShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (s.status === 'absent') return c.json({ error: '欠勤のシフトには発行できません' }, 400)
  const gone = staffGoneForShift(s)
  if (gone) return c.json({ error: `${gone}。報告用URLは発行できません` }, 400)
  const expires = reportTokenExpiry(s.work_date)
  if (expires <= nowJST()) return c.json({ error: '稼働日の翌日を過ぎたシフトには発行できません' }, 400)
  const existing = await currentReportToken(db, s)
  if (existing && !(await c.req.json().catch(() => ({} as any))).regenerate) return c.json({ ok: true, token: existing.token, expires_at: existing.expires_at })
  await db.prepare('UPDATE shift_report_tokens SET revoked = 1 WHERE shift_id = ?').bind(s.shift_id).run()
  const token = randToken(24)
  await db.prepare('INSERT INTO shift_report_tokens (token, shift_id, company_id, staff_id, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(token, s.shift_id, u.company_id, s.staff_id, expires, u.user_id).run()
  return c.json({ ok: true, token, expires_at: expires })
})
adminLifecycleApi.delete('/shifts/:id/report-link', async (c) => {
  const u = c.get('user')
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  await c.env.DB.prepare('UPDATE shift_report_tokens SET revoked = 1 WHERE shift_id = ?').bind(s.shift_id).run()
  return c.json({ ok: true })
})

// =========================================================
// ログイン不要の報告用URL（/api/public/report/:token）
// 対象はトークンに紐づく1シフトのみ。金額・他のシフト・スタッフ情報は返さない
// =========================================================
export const publicReportApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const PUBLIC_PHOTO_MAX = 500 * 1024

// 退職・統合で、このシフトの報告を受け付けない理由（なければ null）。退職日当日までのシフトは受け付ける
function staffGoneForShift(r: { merged_into_staff_id?: any; employment_status?: any; retired_at?: any; work_date: string }): string | null {
  if (r.merged_into_staff_id) return '統合済みのスタッフです'
  if (r.retired_at && r.work_date > r.retired_at) return '退職日より後のシフトです'
  if (r.employment_status === 'retired' && !r.retired_at) return '退職したスタッフです'
  return null
}
async function loadToken(db: D1Database, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) return null
  const t = await db.prepare(`SELECT t.*, s.work_date, s.start_time, s.end_time, s.location, s.status AS shift_status, s.project_id, s.role,
      s.attendance_mode AS s_att, s.daily_report_mode AS s_dr, p.project_name, p.report_template_id, p.attendance_mode AS p_att, p.daily_report_mode AS p_dr,
      sp.attendance_mode AS sp_att, sp.daily_report_mode AS sp_dr, us.name AS staff_name, co.company_name, co.settings_json, p.photo_required_override,
      co.active_status AS company_active_status, sp.merged_into_staff_id, sp.employment_status, us.retired_at
    FROM shift_report_tokens t JOIN shifts s ON s.shift_id = t.shift_id JOIN projects p ON p.project_id = s.project_id
    JOIN staff_profiles sp ON sp.staff_id = t.staff_id JOIN users us ON us.user_id = sp.user_id JOIN companies co ON co.company_id = t.company_id
    WHERE t.token = ? AND s.staff_id = t.staff_id AND s.company_id = t.company_id`).bind(token).first() as any
  if (!t || t.revoked || reportTokenExpiry(t.work_date) <= nowJST() || t.shift_status === 'absent') return null
  // 本部で停止にした企業の報告用URLは使えない（ログインの停止と同じ判定。src/lib/auth.ts）
  if (!isCompanyActive(t.company_active_status)) return null
  // 退職日より後のシフト・統合済みのスタッフの報告用URLは使えない（退職日当日までは使える）
  if (staffGoneForShift(t)) return null
  return t
}
function firstName(n: string) { return String(n || '').split(/\s+/)[0] || n }
// 入店・退店報告の写真必須（会社設定 → 案件の上書き。api.ts の resolvePhotoRequired と同じ判定）
function photoRequired(t: any): boolean {
  let def = true
  try { const v = JSON.parse(t.settings_json || '{}').photo_required_attendance; if (typeof v === 'boolean') def = v } catch { }
  return t.photo_required_override === null || t.photo_required_override === undefined ? def : !!t.photo_required_override
}

publicReportApi.get('/:token', async (c) => {
  const db = c.env.DB
  const t = await loadToken(db, c.req.param('token'))
  if (!t) return c.json({ error: 'このURLは無効か、有効期限が切れています' }, 404)
  const modes = (await modesForShifts(db, [t.shift_id])).get(t.shift_id)!
  const reports = (await db.prepare('SELECT report_type, reported_at FROM attendance_reports WHERE shift_id = ?').bind(t.shift_id).all()).results
  const daily = dailyReportView(await findDailyReport(db, t))
  const tpl = modes.daily_report_required ? await db.prepare('SELECT template_name, fields_json FROM report_templates WHERE template_id = ?').bind(t.report_template_id).first() as any : null
  await db.prepare('UPDATE shift_report_tokens SET last_used_at = ? WHERE token = ?').bind(nowJST(), t.token).run()
  return c.json({
    company_name: t.company_name, staff_name: firstName(t.staff_name), project_name: t.project_name,
    shift: { work_date: t.work_date, start_time: t.start_time, end_time: t.end_time, location: t.location, role: t.role },
    today: todayJST(), expires_at: reportTokenExpiry(t.work_date), modes, reports, photo_required: photoRequired(t),
    daily_report: daily ? { submitted_at: daily.submitted_at, values: daily.values, incident_flag: daily.incident_flag, complaint_flag: daily.complaint_flag } : null,
    template: tpl ? { name: tpl.template_name, fields: JSON.parse(tpl.fields_json || '[]') } : null,
  })
})

publicReportApi.post('/:token/attendance', async (c) => {
  const db = c.env.DB
  const t = await loadToken(db, c.req.param('token'))
  if (!t) return c.json({ error: 'このURLは無効か、有効期限が切れています' }, 404)
  const modes = (await modesForShifts(db, [t.shift_id])).get(t.shift_id)!
  let reportType = '', lat: number | null = null, lng: number | null = null, photo: File | null = null
  const ct = c.req.header('content-type') || ''
  if (ct.includes('multipart/form-data')) {
    const f = await c.req.formData()
    reportType = String(f.get('report_type') || ''); lat = f.get('latitude') ? Number(f.get('latitude')) : null; lng = f.get('longitude') ? Number(f.get('longitude')) : null
    const p = f.get('photo'); if (p instanceof File && p.size > 0) photo = p
  } else {
    const b = await c.req.json().catch(() => ({} as any)); reportType = b.report_type; lat = b.latitude ?? null; lng = b.longitude ?? null
  }
  // アプリと同じ判定（欠勤・確定済み・受付の時間帯・有効・報告済み・申請中・順序。report-settings.ts の checkStaffReport）
  const now = nowJST()
  const cur = await db.prepare('SELECT status, settle_status FROM shifts WHERE shift_id = ?').bind(t.shift_id).first() as any
  const ng = checkStaffReport({ ...t, status: cur?.status, settle_status: cur?.settle_status }, reportType, now, modes.required_attendance, await loadReportState(db, t.shift_id))
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  // 遅刻・早退の判定（アプリと同じ。23時台に始まる勤務で 0時を過ぎた入店・勤務開始も、日付を含めて比べる。#134 #219 #497）
  const judged = lateness(t, [{ report_type: reportType, reported_at: now }], latenessSettings(t.settings_json))[0]
  const status = reportStatus(judged, lat)
  if (['check_in', 'check_out'].includes(reportType) && photoRequired(t) && !photo) return c.json({ error: 'この案件は写真の添付が必須です' }, 400)
  let key: string | null = null
  if (photo) {
    if (!['image/jpeg', 'image/png'].includes(photo.type) || photo.size > PUBLIC_PHOTO_MAX) return c.json({ error: '画像はJPEG/PNG・500KB以内にしてください' }, 400)
    key = `attendance/${t.company_id}/${t.staff_id}/${t.shift_id}/${reportType}_${Date.now()}.${photo.type === 'image/png' ? 'png' : 'jpg'}`
    try { await c.env.PHOTOS.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } }) } catch { return c.json({ error: '写真のアップロードに失敗しました' }, 502) }
  }
  await db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, device_info, status, photo_key, entry_method, late_minutes, early_leave_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'link', ?, ?)`).bind(t.company_id, t.staff_id, t.shift_id, reportType, now, lat, lng, (c.req.header('user-agent') || '').slice(0, 300), status, key,
    judged.late_minutes, judged.early_leave_minutes).run()
  if (ACTUAL_SYNC_TYPES.includes(reportType)) await syncActualFromReports(db, t.company_id, t.shift_id).catch(() => {})
  return c.json({ ok: true, status, late_minutes: judged.late_minutes, early_leave_minutes: judged.early_leave_minutes })
})

publicReportApi.post('/:token/daily-report', async (c) => {
  const db = c.env.DB
  const t = await loadToken(db, c.req.param('token'))
  if (!t) return c.json({ error: 'このURLは無効か、有効期限が切れています' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  // 日報「不要」のシフトと、稼働日の前は受け付けない（画面もフォームを出さない・ボタンを押せない）
  const modes = (await modesForShifts(db, [t.shift_id])).get(t.shift_id)!
  if (!modes.daily_report_required) return c.json({ error: 'このシフトは日報の提出は不要です' }, 400)
  const blocked = dailyReportBlocked({ work_date: t.work_date, status: t.shift_status }, todayJST())
  if (blocked) return c.json({ error: blocked }, 400)
  // values のキーは案件の日報テンプレートの項目に限る（キーは管理画面に表示されるため）。数値・長さはアプリと同じ検証
  const tpl = await db.prepare('SELECT fields_json FROM report_templates WHERE template_id = ?').bind(t.report_template_id ?? null).first() as any
  // テンプレートの必須項目・文字数の上限（アプリと同じ検証。#349）
  const rulesError = reportFieldRulesError(tpl?.fields_json, b.values)
  if (rulesError) return c.json({ error: rulesError }, 400)
  const picked = pickReportValues(tpl?.fields_json, b.values)
  if ('error' in picked) return c.json({ error: picked.error }, 400)
  // インシデント・クレームの内容は、送られていれば保存し、送られなければ前回の内容を保つ（この画面には内容の欄がまだ無いので必須にはしない）。
  // 新しく付いた印は管理者に知らせる（#232）
  const prev = dailyReportView(await findDailyReport(db, t))
  const merged = mergeIncidentNotes(picked.values, b, prev, { requireNote: false })
  if ('error' in merged) return c.json({ error: merged.error }, 400)
  const r = await saveDailyReport(db, {
    company_id: t.company_id, staff_id: t.staff_id, project_id: t.project_id, shift_id: t.shift_id, work_date: t.work_date,
    values_json: JSON.stringify(merged.values), incident: !!b.incident_flag, complaint: !!b.complaint_flag,
    flags_explicit: b.flags_explicit === true, entry_method: 'link', now: nowJST(),
  })
  await notifyDailyReportIncident(c, t.shift_id, merged.raised)
  return c.json({ ok: true, updated: r.updated })
})

export { stripMoney }
