// =========================================================
// 日報はシフト（shift_id）単位で1件（migrations/0035_daily_report.sql の ux_daily_reports_shift）。
// アプリ（POST /api/staff/daily-report）と報告用URL（POST /api/public/report/:token/daily-report）で共用する。
// shift_id の無い古い日報だけは、同じスタッフ・稼働日・案件で照合する。
// その照合の `+shift_id IS NULL` の + は、shift_id の一意索引で全社の古い日報を走査させず、稼働日などの索引を使わせるため（api.ts の同じ照合も同じ）。
// =========================================================

export type DailyReportShift = { shift_id: number; staff_id: number; work_date: string; project_id: number }

/** シフトの日報（shift_id の一致を優先し、無ければ shift_id の無い古い日報） */
export async function findDailyReport(db: D1Database, s: DailyReportShift): Promise<any | null> {
  return (await db.prepare(`SELECT * FROM daily_reports
    WHERE shift_id = ? OR (+shift_id IS NULL AND staff_id = ? AND work_date = ? AND project_id = ?)
    ORDER BY shift_id IS NULL, submitted_at DESC, daily_report_id DESC LIMIT 1`)
    .bind(s.shift_id, s.staff_id, s.work_date, s.project_id).first()) ?? null
}

/** 画面に返す形（入力欄の初期値に使う） */
export function dailyReportView(r: any | null) {
  if (!r) return null
  let values: Record<string, unknown> = {}
  try { const v = JSON.parse(r.report_values || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) values = v } catch { values = {} }
  return {
    submitted_at: r.submitted_at, values,
    // 管理者が値を直した日時（#9707。直した後に出し直すと消える）
    admin_edited_at: r.admin_edited_at ?? null,
    incident_flag: !!r.incident_flag, complaint_flag: !!r.complaint_flag,
    manager_checked: !!r.manager_checked, manager_comment: r.manager_comment ?? null,
  }
}

/**
 * インシデント・クレームの内容（#232）。report_values の incident_note / complaint_note に保存する
 * （管理画面の日報一覧は incident_ / complaint_ で始まるキーを赤枠に出す）。
 * - 本文の incident_note / complaint_note（無ければ values の同じキー）を使う。送られていなければ前回の内容を保つ
 * - 印が付いたままなら内容を残し、requireNote のとき内容が空なら受け付けない。印を外したら内容も消す
 * - raised: 今回新しく付いた印（管理者へ知らせる）。flags_explicit でない送信は一度付いた印を下げない（saveDailyReport と同じ）
 */
export const INCIDENT_NOTE_MAX = 2000
const INCIDENT_NOTE_KINDS = [
  { kind: 'incident', flag: 'incident_flag', key: 'incident_note', label: 'インシデント' },
  { kind: 'complaint', flag: 'complaint_flag', key: 'complaint_note', label: 'クレーム' },
] as const
export function mergeIncidentNotes(values: Record<string, number | string>, body: any, prev: ReturnType<typeof dailyReportView>, opts: { requireNote: boolean }):
  { values: Record<string, number | string>; raised: ('incident' | 'complaint')[] } | { error: string } {
  const out = { ...values }
  const raised: ('incident' | 'complaint')[] = []
  const explicit = !!body && body.flags_explicit === true
  for (const k of INCIDENT_NOTE_KINDS) {
    const newFlag = !!(body && body[k.flag])
    const prevFlag = !!(prev && prev[k.flag])
    const effective = explicit ? newFlag : (newFlag || prevFlag)
    if (newFlag && !prevFlag) raised.push(k.kind)
    let sent: unknown = body ? body[k.key] : undefined
    if (sent === undefined && body && body.values && typeof body.values === 'object') sent = body.values[k.key]
    if (sent !== undefined && sent !== null && typeof sent === 'object') return { error: `${k.label}の内容の形式が正しくありません` }
    const note = (sent !== undefined && sent !== null ? String(sent) : String((prev && prev.values && prev.values[k.key]) ?? '')).trim()
    if (note.length > INCIDENT_NOTE_MAX) return { error: `${k.label}の内容は${INCIDENT_NOTE_MAX}文字以内で入力してください` }
    delete out[k.key]
    if (!effective) continue
    if (note) out[k.key] = note
    else if (opts.requireNote) return { error: `${k.label}の内容（何が・いつ・どう対応したか）を入力してください` }
  }
  return { values: out, raised }
}

/** 日報を受け付けないシフト（欠勤・稼働日の前） */
export function dailyReportBlocked(shift: { work_date: string; status?: string | null }, today: string): string | null {
  if (shift.status === 'absent') return '欠勤のシフトには日報を提出できません'
  if (today < shift.work_date) return '日報は稼働日以降に提出してください'
  return null
}

/**
 * 日報の登録（同じシフトの日報があれば上書き）。1文の UPSERT なので、二度押しでも行は1つ。
 * - 上書きのときは管理者の確認済みを外し、確認済みだった場合は revised_after_check_at に日時を残す。
 * - インシデント・クレームの印は、画面で前回の値を表示して送った（flagsExplicit）ときだけ下げられる。
 *   そうでなければ一度立てた印を保つ。
 */
export async function saveDailyReport(db: D1Database, r: DailyReportShift & {
  company_id: number; values_json: string; incident: boolean; complaint: boolean; flags_explicit: boolean; entry_method: 'app' | 'link' | 'proxy'; now: string
  // 代理入力（#276）で記録した管理者。本人が出し直したときは NULL に戻す
  entered_by?: number | null
}): Promise<{ updated: boolean }> {
  let existed = !!(await db.prepare('SELECT 1 FROM daily_reports WHERE shift_id = ?').bind(r.shift_id).first())
  if (!existed) {
    // shift_id の無い古い日報（マイグレーションで1つのシフトに決められなかったもの）は、このシフトの日報として引き取って上書きする。
    // 新しい行を足すと、古い行と二重に集計されるため
    const claimed = await db.prepare(`UPDATE daily_reports SET shift_id = ?
      WHERE daily_report_id = (SELECT daily_report_id FROM daily_reports
          WHERE +shift_id IS NULL AND company_id = ? AND staff_id = ? AND work_date = ? AND project_id = ?
          ORDER BY submitted_at DESC, daily_report_id DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daily_reports WHERE shift_id = ?)`)
      .bind(r.shift_id, r.company_id, r.staff_id, r.work_date, r.project_id, r.shift_id).run()
    existed = (claimed.meta?.changes ?? 0) > 0
  }
  const explicit = r.flags_explicit ? 1 : 0
  // 管理者が値を直した日報（#9707）を、値を変えて出し直したときは、再提出の値を正にする（「管理者が修正」の印を外す）。
  // 直した値を失わないよう、出し直す前の値を履歴（daily_report_edits）に残す。同じ値のままの出し直しは、印も履歴もそのまま
  const cur = existed ? await db.prepare('SELECT report_values, admin_edited_at FROM daily_reports WHERE shift_id = ?').bind(r.shift_id).first() as any : null
  const stmts: D1PreparedStatement[] = []
  // キーの並びだけが違う同じ値は、同じ値の出し直しとして扱う（保存してある文字列のままにして、印を外さない）
  if (cur && cur.admin_edited_at && typeof cur.report_values === 'string' && cur.report_values !== r.values_json
    && !changedReportKeys(parseReportValuesJson(cur.report_values), parseReportValuesJson(r.values_json)).length) r = { ...r, values_json: cur.report_values }
  if (cur && cur.admin_edited_at && cur.report_values !== r.values_json) {
    const changed = changedReportKeys(parseReportValuesJson(cur.report_values), parseReportValuesJson(r.values_json))
    stmts.push(db.prepare(`INSERT INTO daily_report_edits (company_id, daily_report_id, kind, entry_method, before_values, after_values, changed_keys, edited_by, edited_at)
      SELECT company_id, daily_report_id, 'resubmit', ?, report_values, ?, ?, ?, ? FROM daily_reports
      WHERE shift_id = ? AND admin_edited_at IS NOT NULL AND report_values IS ?`)
      .bind(r.entry_method, r.values_json, JSON.stringify(changed), r.entry_method === 'proxy' ? (r.entered_by ?? null) : null, r.now, r.shift_id, cur.report_values ?? null))
  }
  stmts.push(db.prepare(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at, entry_method, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shift_id) DO UPDATE SET
      project_id = excluded.project_id, work_date = excluded.work_date, report_values = excluded.report_values,
      incident_flag = CASE WHEN ? = 1 THEN excluded.incident_flag ELSE MAX(COALESCE(daily_reports.incident_flag, 0), excluded.incident_flag) END,
      complaint_flag = CASE WHEN ? = 1 THEN excluded.complaint_flag ELSE MAX(COALESCE(daily_reports.complaint_flag, 0), excluded.complaint_flag) END,
      submitted_at = excluded.submitted_at, entry_method = excluded.entry_method, entered_by = excluded.entered_by,
      revised_after_check_at = CASE WHEN daily_reports.manager_checked = 1 THEN excluded.submitted_at ELSE daily_reports.revised_after_check_at END,
      admin_edited_at = CASE WHEN daily_reports.report_values IS excluded.report_values THEN daily_reports.admin_edited_at ELSE NULL END,
      admin_edited_by = CASE WHEN daily_reports.report_values IS excluded.report_values THEN daily_reports.admin_edited_by ELSE NULL END,
      manager_checked = 0`)
    .bind(r.company_id, r.staff_id, r.project_id, r.shift_id, r.work_date, r.values_json, r.incident ? 1 : 0, r.complaint ? 1 : 0, r.now, r.entry_method,
      r.entered_by ?? null, explicit, explicit))
  await db.batch(stmts)
  return { updated: existed }
}

// =========================================================
// 管理者による日報の実績の修正（利用者の決定 Sprint 15。#9707。migrations/0097）。
// 日報の値（report_values）をその場で上書きし、もとの値・直した人・日時・理由を daily_report_edits に残す。
// 実績分析・案件詳細の実績・日報の一覧と CSV・スタッフの画面は report_values を読むので、直した値がそのまま使われる。
// - 直せるのは、案件の今のテンプレートの項目（無ければ「報告内容」）と、その日報に値のある古い項目（テンプレートを差し替える前の項目など）。
//   インシデント・クレームの内容（incident_note など）は対応状況の画面で扱うので、ここでは変えずに残す
// - テンプレートの検証（必須・文字数・数値）はスタッフの提出と同じ関数（validate.ts）で行う。
//   ただし、もとの日報に値の無かった必須の項目（後からテンプレートに足した項目など）は、空のままでも直せる
// - 数値の全角の数字は半角にしてから確かめる
// =========================================================
export const REPORT_EDIT_REASON_MAX = 500
export type ReportEditField = ReportFieldDef & { required?: true; maxLength?: number; placeholder?: string }

export function parseReportValuesJson(json: unknown): Record<string, unknown> {
  try { const v = JSON.parse(typeof json === 'string' && json ? json : '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
/** 値の変わったキー（前後のどちらかにあるキーを、前・後の順に） */
export function changedReportKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys.filter(k => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
}
const isIncidentKey = (k: string) => /^(incident|complaint)_/.test(k)

/**
 * 修正の画面に出す項目。今のテンプレートの項目（必須・文字数の上限も）の後ろに、日報に値のある古い項目を足す。
 * templateFieldsJson は案件の今のテンプレートの fields_json、noTemplateFields はテンプレートの無い案件の項目（validate.ts の NO_TEMPLATE_FIELDS）、
 * guessed は表示名のわからないキーの補い（guessReportFieldLabels）
 */
export function reportEditFields(templateFieldsJson: unknown, noTemplateFields: { key: string; label: string; type: string }[], pastJson: unknown,
  values: Record<string, unknown>, guessed: Map<string, ReportFieldDef> = new Map()): ReportEditField[] {
  let raw: any[] = []
  try { const v = typeof templateFieldsJson === 'string' ? JSON.parse(templateFieldsJson) : []; if (Array.isArray(v)) raw = v } catch { raw = [] }
  const cur: ReportEditField[] = []
  for (const x of raw) {
    if (!x || typeof x.key !== 'string' || !x.key) continue
    const f: ReportEditField = { key: x.key, label: String(x.label || x.key), type: String(x.type || 'text') }
    if (typeof x.unit === 'string' && x.unit) f.unit = x.unit
    if (x.required === true || x.required === 1 || x.required === 'true') f.required = true
    const ml = Number(x.maxLength ?? x.max_length)
    if (f.type !== 'number' && Number.isInteger(ml) && ml > 0) f.maxLength = ml
    if (typeof x.placeholder === 'string' && x.placeholder) f.placeholder = x.placeholder
    cur.push(f)
  }
  const base: ReportEditField[] = cur.length ? cur : noTemplateFields.map(f => ({ ...f }))
  const seen = new Set(base.map(f => f.key))
  const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k)
  const out = [...base]
  for (const f of pastReportFields(pastJson)) if (!seen.has(f.key) && has(f.key)) { seen.add(f.key); out.push(f) }
  for (const k of Object.keys(values)) {
    // 形の違う値（配列など）は直す対象にせず、そのまま残す
    if (seen.has(k) || isIncidentKey(k) || (values[k] !== null && typeof values[k] === 'object')) continue
    seen.add(k)
    const g = guessed.get(k)
    out.push(g ? { ...g, past: true } : { key: k, label: k, type: typeof values[k] === 'number' ? 'number' : 'text', past: true })
  }
  return out
}

// 全角の数字・符号を半角にする（数値の項目だけ）
function toHalfWidthNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return v.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[－ー−]/g, '-').replace(/[，,]/g, '').trim()
}

/**
 * 管理者の修正の値を作る。sent は画面から送られた値（送らなかった項目は今の値のまま）。
 * rules（必須・文字数）と pick（数値・長さ）は validate.ts の reportFieldRulesError / pickReportValues を渡す
 */
export function buildAdminReportEdit(fields: ReportEditField[], before: Record<string, unknown>, sent: unknown, fns: {
  rules: (fieldsJson: string, values: unknown) => string | null
  pick: (fieldsJson: string, values: unknown) => { values: Record<string, number | string> } | { error: string }
}): { values: Record<string, unknown>; changed: string[] } | { error: string } {
  if (sent === undefined || sent === null || typeof sent !== 'object' || Array.isArray(sent)) return { error: '日報の形式が正しくありません' }
  const body = sent as Record<string, unknown>
  const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
  const src: Record<string, unknown> = {}
  for (const f of fields) {
    let v = has(body, f.key) ? body[f.key] : before[f.key]
    if (f.type === 'number') v = toHalfWidthNumber(v)
    // もとの日報に無い項目は、空のままなら足さない（数値の空欄が 0 として集計に入らないように）
    if (!has(before, f.key) && (v === undefined || v === null || v === '')) continue
    if (v === undefined) continue
    src[f.key] = v
  }
  // 必須は、もとの日報に値のあった項目だけに当てる（文字数の上限はすべての項目に当てる）
  const ruleFields = fields.filter(f => !f.past).map(f => ({ ...f, required: f.required && has(before, f.key) ? true : undefined }))
  const ruleError = fns.rules(JSON.stringify(ruleFields), src)
  if (ruleError) return { error: ruleError }
  const picked = fns.pick(JSON.stringify(fields.map(f => ({ key: f.key, label: f.label, type: f.type }))), src)
  if ('error' in picked) return { error: picked.error }
  const after: Record<string, unknown> = { ...picked.values }
  // 修正の対象でない値（インシデント・クレームの内容など）は、もとの順のまま後ろに残す
  const editable = new Set(fields.map(f => f.key))
  for (const k of Object.keys(before)) if (!editable.has(k)) after[k] = before[k]
  return { values: after, changed: changedReportKeys(before, after) }
}

// =========================================================
// 日報テンプレートを差し替えた後も、古い項目を元の表示名で出す（#9511）。
// 案件の日報テンプレートを差し替えるとき、それまでのテンプレートの項目を projects.past_report_fields_json に写して残す
// （migrations/0092）。実績分析・案件詳細の実績・日報の一覧と CSV は、今のテンプレートの項目を先に、残した項目を後ろに並べる。
// =========================================================
export type ReportFieldDef = { key: string; label: string; type: string; unit?: string; past?: true }
export const PAST_REPORT_FIELDS_MAX = 300

/** テンプレートの項目（fields_json の文字列か配列）を key・label・type（・unit）にそろえる。壊れていれば空 */
export function parseReportFields(json: unknown): ReportFieldDef[] {
  let f: unknown = json
  if (typeof json === 'string') { try { f = JSON.parse(json) } catch { f = [] } }
  if (!Array.isArray(f)) return []
  const out: ReportFieldDef[] = []
  for (const x of f as any[]) {
    if (!x || typeof x.key !== 'string' || !x.key) continue
    const d: ReportFieldDef = { key: x.key, label: String(x.label || x.key), type: String(x.type || 'text') }
    if (typeof x.unit === 'string' && x.unit) d.unit = x.unit
    out.push(d)
  }
  return out
}

/**
 * 差し替える前のテンプレートの項目を、案件に残した項目に足す（同じ key は今回の表示名で上書きし、位置は保つ）。
 * 戻り値は projects.past_report_fields_json に入れる文字列（項目がなければ今の値のまま）
 */
export function mergePastReportFields(pastJson: unknown, oldFieldsJson: unknown, meta: { template_id: number | null; template_name: string | null; replaced_at: string }): string | null {
  const past = parsePastEntries(pastJson)
  const old = parseReportFields(oldFieldsJson)
  if (!old.length) return past.length ? JSON.stringify(past) : null
  const at = new Map(past.map((p, i) => [p.key, i]))
  for (const f of old) {
    const e: any = { ...f, template_id: meta.template_id, template_name: meta.template_name, replaced_at: meta.replaced_at }
    const i = at.get(f.key)
    if (i === undefined) { at.set(f.key, past.length); past.push(e) } else past[i] = e
  }
  // 何度も差し替えても行が大きくなりすぎないよう、古いものから捨てる
  return JSON.stringify(past.slice(-PAST_REPORT_FIELDS_MAX))
}
function parsePastEntries(json: unknown): any[] {
  let v: unknown = []
  if (typeof json === 'string' && json) { try { v = JSON.parse(json) } catch { v = [] } }
  return Array.isArray(v) ? (v as any[]).filter(x => x && typeof x.key === 'string' && x.key) : []
}

/** 案件に残した古い項目（画面・API に返す形。past: true を付ける） */
export function pastReportFields(pastJson: unknown): ReportFieldDef[] {
  return parseReportFields(parsePastEntries(pastJson)).map(f => ({ ...f, past: true as const }))
}

/** 今のテンプレートの項目の後ろに、残した古い項目のうち今のテンプレートに無いものを足す */
export function withPastFields(current: ReportFieldDef[], pastJson: unknown): ReportFieldDef[] {
  const seen = new Set(current.map(f => f.key))
  return [...current, ...pastReportFields(pastJson).filter(f => !seen.has(f.key) && (seen.add(f.key), true))]
}

/**
 * 表示名のわからないキー（0092 の前にテンプレートを差し替えた案件など）を、自社・本部のテンプレートの同じキーの表示名で補う。
 * 自社のテンプレートを先に、同じ会社の中は番号の小さい順で最初に見つかったもの。keys が空なら DB を読まない
 */
export async function guessReportFieldLabels(db: D1Database, companyId: number, keys: Iterable<string>): Promise<Map<string, ReportFieldDef>> {
  const want = new Set(keys)
  const out = new Map<string, ReportFieldDef>()
  if (!want.size) return out
  const rows = (await db.prepare(`SELECT fields_json FROM report_templates WHERE company_id = ? OR company_id IS NULL
    ORDER BY company_id IS NULL, template_id`).bind(companyId).all()).results as any[]
  for (const r of rows) {
    for (const f of parseReportFields(r.fields_json)) {
      if (want.has(f.key) && !out.has(f.key)) out.set(f.key, { ...f, past: true })
    }
    if (out.size === want.size) break
  }
  return out
}
