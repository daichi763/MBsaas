// =========================================================
// スタッフの所属区分の移行 / 仮登録 / 勤怠・日報の提出設定 / 報告用URL / 代理入力
// docs/spec_spot_shift.md 第2段階
//
// 管理者向け（/api/admin/*）は adminLifecycleApi、ログイン不要の報告用URL（/api/public/report/*）は publicReportApi。
// api.ts から認証ミドルウェアの前後に分けて登録する。金額は返さない（報告用URLはスタッフ本人向け）。
// =========================================================
import { Hono } from 'hono'
import { createPerson, partnerNameConflict } from './roster'
import { loadPricingData, stripMoney, resolvePrice, calcAmounts, workHours } from './shift-board'
import { JSON_IN, bindJsonArray, chunk } from './lib/d1-chunk'
import { syncActualFromReports } from './settlement'
import { pickReportValues } from './lib/validate'
import { hashPassword, validatePassword, isCompanyActive } from './lib/auth'
import { REPORT_TYPES, NEXT_DAY_TYPES, ACTUAL_SYNC_TYPES, attendanceTypesForShifts, checkReportable, flagsFromLegacyMode, applyLegacyStaffMode, setProjectDefaults } from './report-settings'
import { checkReportTime } from './report-settings'

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
export async function insertProvisionalStaff(db: D1Database, companyId: number, byUserId: number | null, o: {
  name: string; phone: string; type: string; affiliation: string | null; partnerId: number | null; kana?: any; gender?: any
  attendance_mode?: any; daily_report_mode?: any; memo?: any; email?: string | null; note: string
}) {
  const person = await createPerson(db, companyId)
  const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, phone, email, person_id) VALUES (?, ?, ?, 'roster_only', ?, ?, ?, ?)`)
    .bind(companyId, 'TMP-' + person.global_staff_code, o.name, await unusablePasswordHash(), o.phone || null, o.email || null, person.person_id).run()
  const sr = await db.prepare(`INSERT INTO staff_profiles (user_id, company_id, person_id, owner_company_id, affiliation_type, partner_affiliation_id, affiliation,
      kana, gender, skills, career, work_area, employment_status, is_provisional, attendance_mode, daily_report_mode, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'working', 1, ?, ?, ?)`)
    .bind(r.meta.last_row_id, companyId, person.person_id, companyId, o.type, o.partnerId, o.affiliation,
      o.kana || null, o.gender || null,
      ['none', 'in_out', 'full'].includes(o.attendance_mode) ? o.attendance_mode : null,
      ['none', 'required'].includes(o.daily_report_mode) ? o.daily_report_mode : null, o.memo || null).run()
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

  const created = await insertProvisionalStaff(db, u.company_id, u.user_id, { name, phone, type, affiliation, partnerId, kana: b.kana, gender: b.gender,
    attendance_mode: b.attendance_mode, daily_report_mode: b.daily_report_mode, memo: b.memo, email: null, note: '仮登録' })
  return c.json({ ok: true, ...created })
})

// ---------- 本登録（仮登録を解除。ログイン発行は任意） ----------
adminLifecycleApi.post('/staff/:id/finalize', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (sp.merged_into_staff_id) return c.json({ error: '統合済みのスタッフです' }, 409)
  if (!sp.is_provisional) return c.json({ error: 'このスタッフは本登録済みです' }, 400)
  if (!sp.gender && !b.gender) return c.json({ error: '本登録には性別の入力が必要です' }, 400)
  if (b.gender) await db.prepare('UPDATE staff_profiles SET gender = ? WHERE staff_id = ?').bind(b.gender, sp.staff_id).run()
  if (b.kana !== undefined) await db.prepare('UPDATE staff_profiles SET kana = ? WHERE staff_id = ?').bind(b.kana || null, sp.staff_id).run()
  if (b.user_code || b.password) {
    if (!b.user_code || !String(b.user_code).trim() || !b.password) return c.json({ error: 'ログインを発行する場合は、スタッフ番号とパスワードを入力してください' }, 400)
    const pwErr = validatePassword(String(b.password))
    if (pwErr) return c.json({ error: pwErr }, 400)
    try {
      await db.prepare(`UPDATE users SET user_code = ?, password_hash = ?, role = 'staff', email = COALESCE(?, email) WHERE user_id = ? AND company_id = ?`)
        .bind(String(b.user_code).trim(), await hashPassword(String(b.password)), b.email || null, sp.user_id, u.company_id).run()
    } catch { return c.json({ error: 'スタッフ番号が重複しています' }, 409) }
  }
  await db.prepare('UPDATE staff_profiles SET is_provisional = 0 WHERE staff_id = ?').bind(sp.staff_id).run()
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
  if (excluded) effects.push(`勤務済み（勤怠報告・実績の入力・日報のどれかがある）の ${excluded} 件は置き換えません`)
  if (targets.some(s => s.price_locked)) effects.push(`うち手動で金額を変更した ${targets.filter(s => s.price_locked).length} 件は、支払先のみ置き換えます`)
  if (!repair) {
    if (from === 'linked_external') effects.push(sp.user_role === 'staff' ? 'ログインは所属元のアカウントのままです（自社で発行する場合は本登録から）' : 'ログインはありません（報告用URLまたは代理入力で記録します）')
    else if (sp.user_role === 'staff') effects.push('ログインはそのまま使えます')
  }
  if (effective < opts.today) {
    const past = targets.filter(s => s.work_date < opts.today)
    warnings.push(`適用日（${effective}）が今日より前です。${past.length ? `過去の未確定シフト ${past.length} 件（${past[0].work_date}〜${past[past.length - 1].work_date}）も置き換えの対象です。` : ''}日付に誤りがないか確認してください`)
  }
  const token = await sha256(JSON.stringify([sp.staff_id, from, to, effective, affiliation, partnerId, newPartnerName, tradeName, hire, contractType, repair, scheduled, targets.map(s => s.shift_id)]))
  return { ok: true, plan: { from, to, effective, affiliation, partnerId, newPartnerName, tradeName, hire, contractType, er, repair, scheduled, targets, excluded, effects, warnings, token } }
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
    const price = resolvePrice({ company_id: companyId, project_id: s.project_id, site_id: s.site_id, role_name: s.role, staff_id: s.staff_id, slot_role: s.slot_role_id ? roles.get(s.slot_role_id) || null : null }, data)
    const proj = data.projects.get(Number(s.project_id)) || {}
    const brk = s.break_minutes ?? proj.default_break_minutes ?? 0
    const amt = calcAmounts(price, s.start_time, s.end_time, brk, workHours({ ...s, break_minutes: brk }, proj).hours)
    priced.push({
      shift_id: s.shift_id, bill_unit_type: price.bill_unit_type, bill_rate: price.bill_rate, bill_qty: amt.bill_qty, unit_price: amt.unit_price,
      pay_unit_type: price.pay_unit_type, pay_rate: price.pay_rate, pay_qty: amt.pay_qty, pay_amount: amt.pay_amount,
      bill_transport_type: price.bill_transport_type, bill_transport_amount: price.bill_transport_amount, pay_transport_type: price.pay_transport_type, pay_transport_amount: price.pay_transport_amount,
      ...payee, price_source: JSON.stringify(price.sources), price_locked: 0,
    })
  }
  stmts.push(...shiftUpdateStmts(db, companyId, PRICE_COLUMNS, priced), ...shiftUpdateStmts(db, companyId, PAYEE_COLUMNS, locked))

  // 変更履歴。変更前の支払先を残し、適用日より前のシフトを計算し直したときに使う（shift-board.ts の resolvePayee）。付け直しでは残さない
  const fromPayee = p.repair ? null : payeeOfProfile(sp)
  const histNote = [p.repair ? '支払先の付け直し' : '', scheduleId ? '予約を適用' : '', note || ''].filter(Boolean).join('・') || null
  stmts.push(db.prepare(`INSERT INTO staff_affiliation_history (company_id, staff_id, from_type, to_type, effective_date, from_affiliation, to_affiliation, partner_affiliation_id, affected_shifts, excluded_shifts,
      from_payee_type, from_payee_affiliation_id, from_payee_company_id, note, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(companyId, sp.staff_id, from, to, effective, sp.affiliation ?? null, affiliation, partnerId, rows.length, p.excluded,
      fromPayee?.payee_type ?? null, fromPayee?.payee_affiliation_id ?? null, fromPayee?.payee_company_id ?? null, histNote, actorId))
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

// 区分変更の予約の取消
adminLifecycleApi.delete('/staff/:id/affiliation-schedules/:scheduleId', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`UPDATE staff_affiliation_schedules SET status = 'canceled', canceled_by = ?, canceled_at = ?
    WHERE schedule_id = ? AND staff_id = ? AND company_id = ? AND status = 'pending'`).bind(u.user_id, nowJST(), c.req.param('scheduleId'), c.req.param('id'), u.company_id).run()
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
    has_login: sp.user_role === 'staff', user_code: sp.user_role === 'staff' ? sp.user_code : null, phone: sp.phone,
    attendance_mode: sp.attendance_mode, daily_report_mode: sp.daily_report_mode, employee_record: er, history, schedules, employment_periods,
    partner_affiliation_id: sp.partner_affiliation_id,
    merged_into_staff_id: sp.merged_into_staff_id, merged_at: sp.merged_at,
    merged_into_name: sp.merged_into_staff_id ? ((await db.prepare('SELECT us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(sp.merged_into_staff_id).first()) as any)?.name : null,
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
      sp.attendance_mode AS sp_att, sp.daily_report_mode AS sp_dr, sp.is_provisional, us.role AS user_role
    FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id JOIN projects p ON p.project_id = s.project_id
    WHERE s.shift_id = ? AND s.company_id = ?`).bind(shiftId, companyId).first() as Promise<any>
}
adminLifecycleApi.get('/shifts/:id/report-status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await ownShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const modes = (await modesForShifts(db, [s.shift_id])).get(s.shift_id)!
  const reports = (await db.prepare(`SELECT a.report_type, a.reported_at, a.status, a.entry_method, um.name AS entered_by_name FROM attendance_reports a
    LEFT JOIN users um ON um.user_id = a.entered_by WHERE a.shift_id = ?`).bind(s.shift_id).all()).results
  const daily = await db.prepare('SELECT daily_report_id, submitted_at, entry_method FROM daily_reports WHERE staff_id = ? AND work_date = ? AND project_id = ?').bind(s.staff_id, s.work_date, s.project_id).first()
  const token = await db.prepare('SELECT token, expires_at, last_used_at FROM shift_report_tokens WHERE shift_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(s.shift_id, nowJST()).first()
  return c.json({ shift_id: s.shift_id, staff_name: s.staff_name, has_login: s.user_role === 'staff', shift_attendance_mode: s.attendance_mode, shift_daily_report_mode: s.daily_report_mode, modes, reports, daily_report: daily, token })
})
adminLifecycleApi.put('/shifts/:id/report-settings', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const a = modeVal(b.attendance_mode, ATTENDANCE_MODES), d = modeVal(b.daily_report_mode, DAILY_REPORT_MODES)
  if (a === undefined || d === undefined) return c.json({ error: '設定値が正しくありません' }, 400)
  await c.env.DB.prepare('UPDATE shifts SET attendance_mode = ?, daily_report_mode = ? WHERE shift_id = ?').bind(a, d, s.shift_id).run()
  return c.json({ ok: true })
})

// ---------- 代理入力（管理者が勤怠を記録。entry_method='proxy'） ----------
adminLifecycleApi.post('/shifts/:id/proxy-attendance', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const s = await ownShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const types: string[] = (Array.isArray(b.report_types) ? b.report_types : [b.report_type]).filter((t: any) => (REPORT_TYPES as readonly string[]).includes(t))
  if (!types.length) return c.json({ error: '報告の種類を選択してください' }, 400)
  const time = /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : null
  let created = 0
  for (const t of types) {
    const dup = await db.prepare('SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?').bind(s.shift_id, t).first()
    if (dup) continue
    // 時刻の指定がなければ: 入店・勤務開始 = 予定の開始、勤務終了・退店 = 予定の終了、それ以外 = 現在時刻
    const at = time ? `${s.work_date} ${time}:00` : (t === 'check_in' || t === 'work_start') ? `${s.work_date} ${s.start_time}:00` : (t === 'check_out' || t === 'work_end') ? `${s.work_date} ${s.end_time}:00` : nowJST()
    await db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, entry_method, entered_by)
      VALUES (?, ?, ?, ?, ?, 'normal', 'proxy', 'proxy', ?)`).bind(u.company_id, s.staff_id, s.shift_id, t, at, u.user_id).run()
    created++
  }
  if (types.some(t => ACTUAL_SYNC_TYPES.includes(t))) await syncActualFromReports(db, u.company_id, s.shift_id).catch(() => {})
  return c.json({ ok: true, created })
})
adminLifecycleApi.delete('/shifts/:id/proxy-attendance/:type', async (c) => {
  const u = c.get('user')
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  // 取り消せるのは代理入力のみ（本人の報告は取り消せない）
  if (s.settle_status === 'confirmed') return c.json({ error: '確定済みのシフトです。精算画面で確定を取り消してください' }, 409)
  const r = await c.env.DB.prepare("DELETE FROM attendance_reports WHERE shift_id = ? AND report_type = ? AND entry_method = 'proxy'").bind(s.shift_id, c.req.param('type')).run()
  await syncActualFromReports(c.env.DB, u.company_id, s.shift_id).catch(() => {})
  return c.json({ ok: true, deleted: r.meta.changes || 0 })
})

// ---------- 報告用URL（シフト専用。稼働日の翌日 23:59 まで有効） ----------
adminLifecycleApi.post('/shifts/:id/report-link', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await ownShift(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (s.status === 'absent') return c.json({ error: '欠勤のシフトには発行できません' }, 400)
  const expires = `${addDays(s.work_date, 1)} 23:59:59`
  if (expires <= nowJST()) return c.json({ error: '稼働日の翌日を過ぎたシフトには発行できません' }, 400)
  const existing = await db.prepare('SELECT token, expires_at FROM shift_report_tokens WHERE shift_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(s.shift_id, nowJST()).first() as any
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

async function loadToken(db: D1Database, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) return null
  const t = await db.prepare(`SELECT t.*, s.work_date, s.start_time, s.end_time, s.location, s.status AS shift_status, s.project_id, s.role,
      s.attendance_mode AS s_att, s.daily_report_mode AS s_dr, p.project_name, p.report_template_id, p.attendance_mode AS p_att, p.daily_report_mode AS p_dr,
      sp.attendance_mode AS sp_att, sp.daily_report_mode AS sp_dr, us.name AS staff_name, co.company_name, co.settings_json, p.photo_required_override,
      co.active_status AS company_active_status
    FROM shift_report_tokens t JOIN shifts s ON s.shift_id = t.shift_id JOIN projects p ON p.project_id = s.project_id
    JOIN staff_profiles sp ON sp.staff_id = t.staff_id JOIN users us ON us.user_id = sp.user_id JOIN companies co ON co.company_id = t.company_id
    WHERE t.token = ? AND s.staff_id = t.staff_id AND s.company_id = t.company_id`).bind(token).first() as any
  if (!t || t.revoked || t.expires_at <= nowJST() || t.shift_status === 'absent') return null
  // 本部で停止にした企業の報告用URLは使えない（ログインの停止と同じ判定。src/lib/auth.ts）
  if (!isCompanyActive(t.company_active_status)) return null
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
  const daily = await db.prepare('SELECT report_values, submitted_at FROM daily_reports WHERE staff_id = ? AND work_date = ? AND project_id = ?').bind(t.staff_id, t.work_date, t.project_id).first() as any
  const tpl = modes.daily_report_required ? await db.prepare('SELECT template_name, fields_json FROM report_templates WHERE template_id = ?').bind(t.report_template_id).first() as any : null
  await db.prepare('UPDATE shift_report_tokens SET last_used_at = ? WHERE token = ?').bind(nowJST(), t.token).run()
  return c.json({
    company_name: t.company_name, staff_name: firstName(t.staff_name), project_name: t.project_name,
    shift: { work_date: t.work_date, start_time: t.start_time, end_time: t.end_time, location: t.location, role: t.role },
    today: todayJST(), expires_at: t.expires_at, modes, reports, photo_required: photoRequired(t),
    daily_report: daily ? { submitted_at: daily.submitted_at, values: JSON.parse(daily.report_values || '{}') } : null,
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
  const done = new Set(((await db.prepare('SELECT report_type FROM attendance_reports WHERE shift_id = ?').bind(t.shift_id).all()).results as any[]).map(r => r.report_type))
  const ng = checkReportable(modes.required_attendance, done, reportType)
  if (ng) return c.json({ error: ng.error }, ng.status as 400)
  // 受付の時間帯（稼働日。休憩・勤務終了・退店は翌日も。lib/shift-time.ts の reportableWindow）。アプリと同じ判定
  const late = checkReportTime(t, reportType, nowJST())
  if (late) return c.json({ error: late.error }, late.status as 400)
  let status = 'normal'
  if (reportType === 'check_in') {
    if (nowJST().slice(11, 16) > t.start_time) status = 'late'
    if (lat == null && status !== 'late') status = 'no_location'
  }
  if (['check_in', 'check_out'].includes(reportType) && photoRequired(t) && !photo) return c.json({ error: 'この案件は写真の添付が必須です' }, 400)
  let key: string | null = null
  if (photo) {
    if (!['image/jpeg', 'image/png'].includes(photo.type) || photo.size > PUBLIC_PHOTO_MAX) return c.json({ error: '画像はJPEG/PNG・500KB以内にしてください' }, 400)
    key = `attendance/${t.company_id}/${t.staff_id}/${t.shift_id}/${reportType}_${Date.now()}.${photo.type === 'image/png' ? 'png' : 'jpg'}`
    try { await c.env.PHOTOS.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } }) } catch { return c.json({ error: '写真のアップロードに失敗しました' }, 502) }
  }
  await db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, device_info, status, photo_key, entry_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'link')`).bind(t.company_id, t.staff_id, t.shift_id, reportType, nowJST(), lat, lng, (c.req.header('user-agent') || '').slice(0, 300), status, key).run()
  if (ACTUAL_SYNC_TYPES.includes(reportType)) await syncActualFromReports(db, t.company_id, t.shift_id).catch(() => {})
  return c.json({ ok: true, status })
})

publicReportApi.post('/:token/daily-report', async (c) => {
  const db = c.env.DB
  const t = await loadToken(db, c.req.param('token'))
  if (!t) return c.json({ error: 'このURLは無効か、有効期限が切れています' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  // values のキーは案件の日報テンプレートの項目に限る（キーは管理画面に表示されるため）
  const tpl = await db.prepare('SELECT fields_json FROM report_templates WHERE template_id = ?').bind(t.report_template_id ?? null).first() as any
  const picked = pickReportValues(tpl?.fields_json, b.values)
  if ('error' in picked) return c.json({ error: picked.error }, 400)
  const json = JSON.stringify(picked.values)
  if (json.length > 20000) return c.json({ error: '入力内容が長すぎます' }, 400)
  const exists = await db.prepare('SELECT daily_report_id FROM daily_reports WHERE staff_id = ? AND work_date = ? AND project_id = ?').bind(t.staff_id, t.work_date, t.project_id).first() as any
  if (exists) await db.prepare("UPDATE daily_reports SET report_values = ?, incident_flag = ?, complaint_flag = ?, submitted_at = ?, entry_method = 'link' WHERE daily_report_id = ?")
    .bind(json, b.incident_flag ? 1 : 0, b.complaint_flag ? 1 : 0, nowJST(), exists.daily_report_id).run()
  else await db.prepare(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at, entry_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'link')`).bind(t.company_id, t.staff_id, t.project_id, t.shift_id, t.work_date, json, b.incident_flag ? 1 : 0, b.complaint_flag ? 1 : 0, nowJST()).run()
  return c.json({ ok: true, updated: !!exists })
})

export { stripMoney }
