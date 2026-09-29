// =========================================================
// スタッフの所属区分の移行 / 仮登録 / 勤怠・日報の提出設定 / 報告用URL / 代理入力
// docs/spec_spot_shift.md 第2段階
//
// 管理者向け（/api/admin/*）は adminLifecycleApi、ログイン不要の報告用URL（/api/public/report/*）は publicReportApi。
// api.ts から認証ミドルウェアの前後に分けて登録する。金額は返さない（報告用URLはスタッフ本人向け）。
// =========================================================
import { Hono } from 'hono'
import { createPerson } from './roster'
import { applyPricingToShift, loadPricingData, stripMoney } from './shift-board'

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

// ---------- 提出設定（案件 → スタッフ → シフト の順に上書き） ----------
export const ATTENDANCE_MODES = ['none', 'in_out', 'full'] as const
export const DAILY_REPORT_MODES = ['none', 'required'] as const
export const ATTENDANCE_TYPES_BY_MODE: Record<string, string[]> = {
  none: [], in_out: ['check_in', 'check_out'], full: ['wake_up', 'departure', 'check_in', 'check_out'],
}
export function resolveModes(project: any, staff: any, shift: any) {
  const pick = (vals: any[], allowed: readonly string[], d: string) => vals.find(v => v && allowed.includes(v)) || d
  const attendance = pick([shift?.attendance_mode, staff?.attendance_mode, project?.attendance_mode], ATTENDANCE_MODES, 'full')
  const daily = pick([shift?.daily_report_mode, staff?.daily_report_mode, project?.daily_report_mode], DAILY_REPORT_MODES, 'required')
  const source = (k: 'attendance_mode' | 'daily_report_mode') => shift?.[k] ? 'shift' : staff?.[k] ? 'staff' : 'project'
  return {
    attendance_mode: attendance, daily_report_mode: daily,
    required_attendance: ATTENDANCE_TYPES_BY_MODE[attendance], daily_report_required: daily === 'required',
    attendance_source: source('attendance_mode'), daily_report_source: source('daily_report_mode'),
  }
}
// シフトID群に対して、提出設定を解決する（ダッシュボード・未報告アラート用）
export async function modesForShifts(db: D1Database, shiftIds: number[]) {
  const map = new Map<number, ReturnType<typeof resolveModes>>()
  if (!shiftIds.length) return map
  const ids = [...new Set(shiftIds)]
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const rows = (await db.prepare(`SELECT s.shift_id, s.attendance_mode AS s_att, s.daily_report_mode AS s_dr,
        sp.attendance_mode AS sp_att, sp.daily_report_mode AS sp_dr, p.attendance_mode AS p_att, p.daily_report_mode AS p_dr
      FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id
      WHERE s.shift_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results as any[]
    for (const r of rows) map.set(r.shift_id, resolveModes({ attendance_mode: r.p_att, daily_report_mode: r.p_dr }, { attendance_mode: r.sp_att, daily_report_mode: r.sp_dr }, { attendance_mode: r.s_att, daily_report_mode: r.s_dr }))
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
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND us.phone IS NOT NULL`).bind(u.company_id).all()).results as any[]
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
  const dup = ((await db.prepare(`SELECT sp.staff_id, us.name, us.phone FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND us.phone IS NOT NULL`)
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
      await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(u.company_id, pname).run()
      const p = await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(u.company_id, pname).first() as any
      partnerId = p?.affiliation_id ?? null; affiliation = pname
    } else return c.json({ error: '取引先を選択または入力してください' }, 400)
  }

  const person = await createPerson(db, u.company_id)
  const userCode = 'TMP-' + person.global_staff_code
  const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, phone, person_id) VALUES (?, ?, ?, 'roster_only', ?, ?, ?)`)
    .bind(u.company_id, userCode, name, await unusablePasswordHash(), phone, person.person_id).run()
  const sr = await db.prepare(`INSERT INTO staff_profiles (user_id, company_id, person_id, owner_company_id, affiliation_type, partner_affiliation_id, affiliation,
      kana, gender, skills, career, work_area, employment_status, is_provisional, attendance_mode, daily_report_mode, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'working', 1, ?, ?, ?)`)
    .bind(r.meta.last_row_id, u.company_id, person.person_id, u.company_id, type, partnerId, affiliation,
      b.kana || null, b.gender || null,
      ['none', 'in_out', 'full'].includes(b.attendance_mode) ? b.attendance_mode : null,
      ['none', 'required'].includes(b.daily_report_mode) ? b.daily_report_mode : null, b.memo || null).run()
  const staffId = sr.meta.last_row_id as number
  await db.prepare(`INSERT INTO staff_affiliation_history (company_id, staff_id, from_type, to_type, effective_date, to_affiliation, partner_affiliation_id, note, changed_by)
    VALUES (?, ?, 'new', ?, ?, ?, ?, '仮登録', ?)`).bind(u.company_id, staffId, type, todayJST(), affiliation, partnerId, u.user_id).run()
  return c.json({ ok: true, staff_id: staffId, global_staff_code: person.global_staff_code })
})

// ---------- 本登録（仮登録を解除。ログイン発行は任意） ----------
adminLifecycleApi.post('/staff/:id/finalize', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (!sp.is_provisional) return c.json({ error: 'このスタッフは本登録済みです' }, 400)
  if (!sp.gender && !b.gender) return c.json({ error: '本登録には性別の入力が必要です' }, 400)
  if (b.gender) await db.prepare('UPDATE staff_profiles SET gender = ? WHERE staff_id = ?').bind(b.gender, sp.staff_id).run()
  if (b.kana !== undefined) await db.prepare('UPDATE staff_profiles SET kana = ? WHERE staff_id = ?').bind(b.kana || null, sp.staff_id).run()
  if (b.user_code || b.password) {
    if (!b.user_code || !b.password || String(b.password).length < 4) return c.json({ error: 'ログインを発行する場合は、スタッフ番号と4文字以上のパスワードを入力してください' }, 400)
    try {
      await db.prepare(`UPDATE users SET user_code = ?, password_hash = ?, role = 'staff', email = COALESCE(?, email) WHERE user_id = ? AND company_id = ?`)
        .bind(String(b.user_code).trim(), await sha256(String(b.password)), b.email || null, sp.user_id, u.company_id).run()
    } catch { return c.json({ error: 'スタッフ番号が重複しています' }, 409) }
  }
  await db.prepare('UPDATE staff_profiles SET is_provisional = 0 WHERE staff_id = ?').bind(sp.staff_id).run()
  return c.json({ ok: true })
})

// ---------- 所属区分の変更（dry_run で影響範囲を確認 → 実行） ----------
adminLifecycleApi.post('/staff/:id/affiliation-change', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const from = sp.affiliation_type || 'own_employee'
  const to = String(b.to_type || '')
  const effective = isDate(b.effective_date) ? b.effective_date : todayJST()
  if (from === 'skillsheet_only') return c.json({ error: 'スキルシートのみのスタッフは区分を変更できません（新規に登録してください）' }, 400)
  if (!WORKING_TYPES.includes(to as any)) return c.json({ error: '変更先の区分が正しくありません' }, 400)
  if (to === from && to !== 'partner_manual') return c.json({ error: '現在と同じ区分です' }, 400)
  if (from === 'linked_external' && to !== 'own_employee' && to !== 'partner_manual' && to !== 'daily_worker' && to !== 'freelance') return c.json({ error: '変更できない区分です' }, 400)

  // 変更先の所属会社
  const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first())?.company_name as string) || ''
  let affiliation: string | null = null, partnerId: number | null = null
  if (to === 'own_employee' || to === 'daily_worker') affiliation = ownName
  if (to === 'freelance') affiliation = String(b.trade_name || '').trim() || '個人事業主'
  if (to === 'partner_manual') {
    if (b.partner_affiliation_id) {
      const p = await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?').bind(b.partner_affiliation_id, u.company_id).first() as any
      if (!p) return c.json({ error: '取引先が見つかりません' }, 404)
      partnerId = p.affiliation_id; affiliation = p.affiliation_name
    } else if (String(b.new_partner_name || '').trim()) {
      affiliation = String(b.new_partner_name).trim()
      if (affiliation === ownName) return c.json({ error: '自社名は取引先として登録できません' }, 400)
    } else return c.json({ error: '取引先を選択または入力してください' }, 400)
    if (to === from && partnerId === sp.partner_affiliation_id) return c.json({ error: '現在と同じ取引先です' }, 400)
  }
  if (to === 'own_employee' && !b.dry_run && !isDate(b.hire_date || effective)) return c.json({ error: '入社日を入力してください' }, 400)

  // 影響範囲: 適用日以降の予定シフト（勤怠報告のないもの）
  const shifts = (await db.prepare(`SELECT s.shift_id, s.project_id, s.work_date, s.price_locked,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS reported
    FROM shifts s WHERE s.staff_id = ? AND s.company_id = ? AND s.work_date >= ? AND s.status != 'absent'`).bind(sp.staff_id, u.company_id, effective).all()).results as any[]
  const targets = shifts.filter(s => !s.reported)
  const er = await db.prepare('SELECT * FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sp.staff_id, u.company_id).first() as any
  const effects: string[] = []
  if (to === 'own_employee') effects.push(er ? '従業員管理のデータを再開します（雇用終了日を解除）' : '従業員管理のデータを作成します')
  if (from === 'own_employee' && to !== 'own_employee') effects.push(`従業員管理のデータを「雇用終了（${addDays(effective, -1)}）」として保持します（削除しません・7年保存）`)
  if (from === 'linked_external') effects.push('他社との連携を終了し、基本情報をコピーして自社で管理します（元の企業への通知はしません）')
  effects.push(`適用日以降の予定シフト ${targets.length} 件の支払先・単価を置き換えます${shifts.length - targets.length ? `（勤怠報告済みの ${shifts.length - targets.length} 件は対象外）` : ''}`)
  if (targets.some(s => s.price_locked)) effects.push(`うち手動で金額を変更した ${targets.filter(s => s.price_locked).length} 件は、支払先のみ置き換えます`)
  if (from === 'linked_external') effects.push(sp.user_role === 'staff' ? 'ログインは所属元のアカウントのままです（自社で発行する場合は本登録から）' : 'ログインはありません（報告用URLまたは代理入力で記録します）')
  else if (sp.user_role === 'staff') effects.push('ログインはそのまま使えます')
  if (b.dry_run) return c.json({ from_type: from, to_type: to, from_label: TYPE_LABEL[from], to_label: TYPE_LABEL[to], effective_date: effective, affiliation, affected_shifts: targets.length, effects })

  // ---- 実行 ----
  if (to === 'partner_manual' && !partnerId && affiliation) {
    await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(u.company_id, affiliation).run()
    partnerId = ((await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(u.company_id, affiliation).first()) as any)?.affiliation_id ?? null
  }
  // 他社連携 → 自社で管理: 所属元の基本項目をコピーし、連携を外す
  if (from === 'linked_external' && sp.source_staff_id) {
    const src = await db.prepare('SELECT * FROM staff_profiles WHERE staff_id = ?').bind(sp.source_staff_id).first() as any
    if (src) {
      await db.prepare(`UPDATE staff_profiles SET kana = ?, gender = ?, date_of_birth = ?, skills = ?, career = ?, work_area = ?, age_group = ?,
          nearest_station_line = ?, nearest_station = ?, commute_minutes = ?, available_from = ?, affiliation_contact = ? WHERE staff_id = ?`)
        .bind(src.kana, src.gender, src.date_of_birth, src.skills, src.career, src.work_area, src.age_group, src.nearest_station_line, src.nearest_station,
          src.commute_minutes, src.available_from, src.affiliation_contact, sp.staff_id).run()
    }
    // 稼働先側のユーザー行は照合不能パスワードのままなので、ログインは所属元のまま。自社で使う場合は本登録でログインを発行する
  }
  await db.prepare(`UPDATE staff_profiles SET affiliation_type = ?, affiliation = ?, partner_affiliation_id = ?, owner_company_id = ?,
      source_staff_id = CASE WHEN ? = 'linked_external' THEN NULL ELSE source_staff_id END WHERE staff_id = ? AND company_id = ?`)
    .bind(to, affiliation, to === 'partner_manual' ? partnerId : null, u.company_id, from, sp.staff_id, u.company_id).run()

  // 従業員管理
  if (to === 'own_employee') {
    const hire = isDate(b.hire_date) ? b.hire_date : effective
    if (er) await db.prepare('UPDATE employee_records SET employment_ended_at = NULL, ended_reason = NULL, hire_date = COALESCE(?, hire_date), contract_type = COALESCE(?, contract_type), updated_at = ? WHERE staff_id = ?')
      .bind(hire, b.contract_type || null, nowJST(), sp.staff_id).run()
    else await db.prepare('INSERT INTO employee_records (staff_id, company_id, hire_date, contract_type, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(sp.staff_id, u.company_id, hire, b.contract_type || null, nowJST()).run()
  } else if (from === 'own_employee') {
    if (er) await db.prepare('UPDATE employee_records SET employment_ended_at = ?, ended_reason = ?, updated_at = ? WHERE staff_id = ?')
      .bind(addDays(effective, -1), `区分変更（${TYPE_LABEL[to]}）`, nowJST(), sp.staff_id).run()
    else await db.prepare('INSERT INTO employee_records (staff_id, company_id, employment_ended_at, ended_reason, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(sp.staff_id, u.company_id, addDays(effective, -1), `区分変更（${TYPE_LABEL[to]}）`, nowJST()).run()
  }

  // 予定シフトの支払先・単価の置き換え（手動変更の金額は保持し、支払先のみ）
  const data = await loadPricingData(db, u.company_id, targets.map(s => s.project_id))
  for (const s of targets) {
    if (s.price_locked) {
      await db.prepare('UPDATE shifts SET payee_type = ?, payee_affiliation_id = ?, payee_company_id = NULL WHERE shift_id = ?')
        .bind(payeeTypeFor(to), to === 'partner_manual' ? partnerId : null, s.shift_id).run()
    } else await applyPricingToShift(db, u.company_id, s.shift_id, { data })
  }
  await db.prepare(`INSERT INTO staff_affiliation_history (company_id, staff_id, from_type, to_type, effective_date, from_affiliation, to_affiliation, partner_affiliation_id, affected_shifts, note, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, sp.staff_id, from, to, effective, sp.affiliation, affiliation, partnerId, targets.length, b.note || null, u.user_id).run()
  return c.json({ ok: true, affected_shifts: targets.length })
})

adminLifecycleApi.get('/staff/:id/lifecycle', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const sp = await loadStaffRow(db, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const history = (await db.prepare(`SELECT h.*, um.name AS changed_by_name FROM staff_affiliation_history h LEFT JOIN users um ON um.user_id = h.changed_by
    WHERE h.staff_id = ? AND h.company_id = ? ORDER BY h.effective_date DESC, h.history_id DESC`).bind(sp.staff_id, u.company_id).all()).results
  const er = await db.prepare('SELECT employment_ended_at, ended_reason, hire_date FROM employee_records WHERE staff_id = ? AND company_id = ?').bind(sp.staff_id, u.company_id).first()
  return c.json({
    staff_id: sp.staff_id, affiliation_type: sp.affiliation_type || 'own_employee', is_provisional: !!sp.is_provisional,
    has_login: sp.user_role === 'staff', user_code: sp.user_role === 'staff' ? sp.user_code : null, phone: sp.phone,
    attendance_mode: sp.attendance_mode, daily_report_mode: sp.daily_report_mode, employee_record: er, history,
    partner_affiliation_id: sp.partner_affiliation_id,
  })
})

// ---------- 提出設定 ----------
function modeVal(v: any, allowed: readonly string[]) { return v === '' || v === null ? null : allowed.includes(v) ? v : undefined }
adminLifecycleApi.put('/staff/:id/report-settings', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const sp = await loadStaffRow(c.env.DB, u.company_id, c.req.param('id'))
  if (!sp) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const a = modeVal(b.attendance_mode, ATTENDANCE_MODES), d = modeVal(b.daily_report_mode, DAILY_REPORT_MODES)
  if (a === undefined || d === undefined) return c.json({ error: '設定値が正しくありません' }, 400)
  await c.env.DB.prepare('UPDATE staff_profiles SET attendance_mode = ?, daily_report_mode = ? WHERE staff_id = ?').bind(a, d, sp.staff_id).run()
  return c.json({ ok: true })
})
adminLifecycleApi.put('/projects/:id/report-settings', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const p = await c.env.DB.prepare('SELECT project_id FROM projects WHERE project_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first()
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  const a = ATTENDANCE_MODES.includes(b.attendance_mode) ? b.attendance_mode : null, d = DAILY_REPORT_MODES.includes(b.daily_report_mode) ? b.daily_report_mode : null
  if (!a || !d) return c.json({ error: '設定値が正しくありません' }, 400)
  await c.env.DB.prepare('UPDATE projects SET attendance_mode = ?, daily_report_mode = ? WHERE project_id = ?').bind(a, d, c.req.param('id')).run()
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
  const modes = resolveModes({ attendance_mode: s.p_att, daily_report_mode: s.p_dr }, { attendance_mode: s.sp_att, daily_report_mode: s.sp_dr }, s)
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
  const types: string[] = (Array.isArray(b.report_types) ? b.report_types : [b.report_type]).filter((t: any) => ['wake_up', 'departure', 'check_in', 'check_out'].includes(t))
  if (!types.length) return c.json({ error: '報告の種類を選択してください' }, 400)
  const time = /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : null
  let created = 0
  for (const t of types) {
    const dup = await db.prepare('SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?').bind(s.shift_id, t).first()
    if (dup) continue
    const at = time ? `${s.work_date} ${time}:00` : (t === 'check_in' ? `${s.work_date} ${s.start_time}:00` : t === 'check_out' ? `${s.work_date} ${s.end_time}:00` : nowJST())
    await db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, entry_method, entered_by)
      VALUES (?, ?, ?, ?, ?, 'normal', 'proxy', 'proxy', ?)`).bind(u.company_id, s.staff_id, s.shift_id, t, at, u.user_id).run()
    created++
  }
  return c.json({ ok: true, created })
})
adminLifecycleApi.delete('/shifts/:id/proxy-attendance/:type', async (c) => {
  const u = c.get('user')
  const s = await ownShift(c.env.DB, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  // 取り消せるのは代理入力のみ（本人の報告は取り消せない）
  const r = await c.env.DB.prepare("DELETE FROM attendance_reports WHERE shift_id = ? AND report_type = ? AND entry_method = 'proxy'").bind(s.shift_id, c.req.param('type')).run()
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
      sp.attendance_mode AS sp_att, sp.daily_report_mode AS sp_dr, us.name AS staff_name, co.company_name, co.settings_json, p.photo_required_override
    FROM shift_report_tokens t JOIN shifts s ON s.shift_id = t.shift_id JOIN projects p ON p.project_id = s.project_id
    JOIN staff_profiles sp ON sp.staff_id = t.staff_id JOIN users us ON us.user_id = sp.user_id JOIN companies co ON co.company_id = t.company_id
    WHERE t.token = ? AND s.staff_id = t.staff_id AND s.company_id = t.company_id`).bind(token).first() as any
  if (!t || t.revoked || t.expires_at <= nowJST() || t.shift_status === 'absent') return null
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
  const modes = resolveModes({ attendance_mode: t.p_att, daily_report_mode: t.p_dr }, { attendance_mode: t.sp_att, daily_report_mode: t.sp_dr }, { attendance_mode: t.s_att, daily_report_mode: t.s_dr })
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
  const modes = resolveModes({ attendance_mode: t.p_att, daily_report_mode: t.p_dr }, { attendance_mode: t.sp_att, daily_report_mode: t.sp_dr }, { attendance_mode: t.s_att, daily_report_mode: t.s_dr })
  let reportType = '', lat: number | null = null, lng: number | null = null, photo: File | null = null
  const ct = c.req.header('content-type') || ''
  if (ct.includes('multipart/form-data')) {
    const f = await c.req.formData()
    reportType = String(f.get('report_type') || ''); lat = f.get('latitude') ? Number(f.get('latitude')) : null; lng = f.get('longitude') ? Number(f.get('longitude')) : null
    const p = f.get('photo'); if (p instanceof File && p.size > 0) photo = p
  } else {
    const b = await c.req.json().catch(() => ({} as any)); reportType = b.report_type; lat = b.latitude ?? null; lng = b.longitude ?? null
  }
  if (!modes.required_attendance.includes(reportType)) return c.json({ error: 'このシフトでは不要な報告です' }, 400)
  const order = modes.required_attendance
  const done = new Set(((await db.prepare('SELECT report_type FROM attendance_reports WHERE shift_id = ?').bind(t.shift_id).all()).results as any[]).map(r => r.report_type))
  if (done.has(reportType)) return c.json({ error: 'すでに報告済みです' }, 409)
  const idx = order.indexOf(reportType)
  if (order.slice(0, idx).some(x => !done.has(x))) return c.json({ error: '前の報告を先に行ってください' }, 400)
  if (t.work_date !== todayJST() && !(reportType === 'check_out' && addDays(t.work_date, 1) === todayJST())) return c.json({ error: '稼働日当日に報告してください' }, 400)
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
  return c.json({ ok: true, status })
})

publicReportApi.post('/:token/daily-report', async (c) => {
  const db = c.env.DB
  const t = await loadToken(db, c.req.param('token'))
  if (!t) return c.json({ error: 'このURLは無効か、有効期限が切れています' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const values = typeof b.values === 'object' && b.values ? b.values : {}
  const json = JSON.stringify(values)
  if (json.length > 20000) return c.json({ error: '入力内容が長すぎます' }, 400)
  const exists = await db.prepare('SELECT daily_report_id FROM daily_reports WHERE staff_id = ? AND work_date = ? AND project_id = ?').bind(t.staff_id, t.work_date, t.project_id).first() as any
  if (exists) await db.prepare("UPDATE daily_reports SET report_values = ?, incident_flag = ?, complaint_flag = ?, submitted_at = ?, entry_method = 'link' WHERE daily_report_id = ?")
    .bind(json, b.incident_flag ? 1 : 0, b.complaint_flag ? 1 : 0, nowJST(), exists.daily_report_id).run()
  else await db.prepare(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at, entry_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'link')`).bind(t.company_id, t.staff_id, t.project_id, t.shift_id, t.work_date, json, b.incident_flag ? 1 : 0, b.complaint_flag ? 1 : 0, nowJST()).run()
  return c.json({ ok: true, updated: !!exists })
})

export { stripMoney }
