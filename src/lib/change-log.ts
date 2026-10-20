// 従業員データとスタッフ基本情報の変更履歴（#464 #205。表は migrations/0075_audit_import.sql の employee_change_logs）。
//  - 保存の前の値と保存する値を比べ、変わった項目だけを1項目1行で残す（空欄と NULL は同じとみなす）
//  - 口座番号・雇用保険番号・社会保険番号は下4桁だけを残す（履歴から番号そのものを持ち出せないように）
//  - 口座・給与の変更は、変更した人以外の会社管理者にアプリ内通知で知らせる（振込先の書き換えに早く気づけるように）
import { chunk } from './d1-chunk'

export type ChangeSource = 'employee' | 'profile'
export type FieldChange = { field: string; old_value: string | null; new_value: string | null }

// 画面に出す項目名（履歴の一覧で使う。ここに無い列は列名のまま出す）
export const CHANGE_FIELD_LABELS: Record<string, string> = {
  // スタッフ基本情報
  name: '氏名', kana: 'フリガナ', gender: '性別', date_of_birth: '生年月日', affiliation: '所属会社名', affiliation_contact: '所属先担当者名',
  nearest_station_line: '最寄駅（路線）', nearest_station: '最寄駅（駅）', employment_status: '在籍状況', retired_at: '退職日',
  commute_minutes: '通勤可能時間', available_from: '稼働開始可能日', work_area: '稼働可能エリア', skills: 'スキル',
  // 従業員管理
  employee_number: '社員番号', hire_date: '入社年月日', base_location: '拠点', department: '所属', job_title: '役職', contract_type: '契約形態',
  work_style: '勤務形態', scheduled_hours: '所定労働時間', scheduled_days_week: '所定労働日数(週)', scheduled_days_month: '所定労働日数(月)',
  hr_staff_user_id: '人材担当者', postal_code: '郵便番号', prefecture: '都道府県', city: '市区町村', town: '町名', address_detail: '住所',
  personal_email: 'メアド（個人）', phone_main: '電話番号（メイン）', phone_work: '電話番号（業務）', dependents_info: '扶養情報', dependents_count: '扶養人数',
  emergency_name: '緊急連絡先（名前）', emergency_kana: '緊急連絡先（フリガナ）', emergency_relationship: '緊急連絡先（続柄）', emergency_phone: '緊急連絡先（電話番号）',
  emergency_postal_code: '緊急連絡先（郵便番号）', emergency_prefecture: '緊急連絡先（都道府県）', emergency_city: '緊急連絡先（市区町村）',
  emergency_town: '緊急連絡先（町名）', emergency_address: '緊急連絡先（住所）',
  bank_code: '銀行コード', bank_name: '銀行名', branch_name: '支店名', branch_code: '支店番号', account_type: '口座種別', account_number: '口座番号',
  contract_start: '契約開始', contract_end: '契約終了', base_salary_type: '基本給種別', base_salary: '基本給', fixed_overtime_hours: '固定残業時間',
  fixed_overtime_pay: '固定残業代', gross_pay: '総支給額', position_allowance_note: '役職手当（摘要）', position_allowance: '役職手当',
  sales_allowance_note: '営業手当（摘要）', sales_allowance: '営業手当', other_deduction_note: 'その他控除（摘要）', other_deduction: 'その他控除',
  employment_insurance_no: '雇用保険被保険者番号', social_insurance_no: '社会保険番号', paid_leave_granted_at: '有給付与日',
  paid_leave_remaining: '有給残数', telework_remaining_this_month: '今月テレワーク残数',
}
// スタッフ基本情報のうち履歴に残す項目（経歴・PRポイント・備考などの長い文章と、管理者メモ・フォローは対象外）
export const PROFILE_LOG_FIELDS = ['name', 'kana', 'gender', 'date_of_birth', 'affiliation', 'affiliation_contact', 'nearest_station_line', 'nearest_station',
  'employment_status', 'retired_at', 'commute_minutes', 'available_from', 'work_area', 'skills'] as const
// 下4桁だけを残す項目
export const MASKED_FIELDS = ['account_number', 'employment_insurance_no', 'social_insurance_no']
// 変わったら会社管理者に知らせる項目（振込先の口座と給与）
export const PAYROLL_ALERT_FIELDS = ['bank_code', 'bank_name', 'branch_name', 'branch_code', 'account_type', 'account_number',
  'base_salary_type', 'base_salary', 'fixed_overtime_hours', 'fixed_overtime_pay', 'gross_pay', 'position_allowance', 'sales_allowance', 'other_deduction']
export const PAYROLL_CHANGED_KIND = 'employee_payroll_changed'

function asText(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
/** 下4桁だけを残す（4桁以下なら全部を伏せる） */
export function maskTail(v: string | null): string | null {
  if (v == null) return null
  const s = v.replace(/\s/g, '')
  return s.length > 4 ? '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-4) : '*'.repeat(s.length || 1)
}
function same(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  // 数値の列は 200000 と '200000.0' などを同じとみなす
  const na = Number(a), nb = Number(b)
  return Number.isFinite(na) && Number.isFinite(nb) && /^-?[\d.]+$/.test(a) && /^-?[\d.]+$/.test(b) && na === nb
}

/** before（保存前の行。無ければ null）と after（保存する値。送られてきたキーだけ）を比べ、変わった項目を返す */
export function diffFields(before: Record<string, any> | null, after: Record<string, any>, fields: readonly string[]): FieldChange[] {
  const out: FieldChange[] = []
  for (const f of fields) {
    if (after[f] === undefined) continue
    const o = asText(before ? before[f] : null), n = asText(after[f])
    if (same(o, n)) continue
    const masked = MASKED_FIELDS.includes(f)
    out.push({ field: f, old_value: masked ? maskTail(o) : o, new_value: masked ? maskTail(n) : n })
  }
  return out
}

/** 変更履歴を入れる文（db.batch に入れて、保存と同じトランザクションで残す） */
export function changeLogStmts(db: D1Database, o: { companyId: number; staffId: number | string; source: ChangeSource; changedBy: number | null; at: string; changes: FieldChange[] }): D1PreparedStatement[] {
  // 1行 8 個のバインド。D1 の上限（100）に収まるよう 12 行ずつ
  return chunk(o.changes, 12).map(part => db.prepare(`INSERT INTO employee_change_logs (company_id, staff_id, source, field, old_value, new_value, changed_by, changed_at)
    VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
    .bind(...part.flatMap(ch => [o.companyId, Number(o.staffId), o.source, ch.field, ch.old_value, ch.new_value, o.changedBy, o.at])))
}

/**
 * 口座・給与の変更を、変更した人以外の会社管理者（在籍中）にアプリ内通知で知らせる文。変更が無ければ空。
 * 本文には項目名だけを書き、値（口座番号・金額）は書かない（通知の一覧から値が見えないように）
 */
export function payrollAlertStmts(db: D1Database, o: { companyId: number; staffId: number | string; actorId: number; actorName: string; at: string; changes: FieldChange[] }): D1PreparedStatement[] {
  const hit = o.changes.filter(ch => PAYROLL_ALERT_FIELDS.includes(ch.field))
  if (!hit.length) return []
  const labels = [...new Set(hit.map(ch => CHANGE_FIELD_LABELS[ch.field] || ch.field))]
  const body = `変更した項目: ${labels.join('・')}\n変更した人: ${o.actorName || '-'}\n心当たりがない場合は、従業員管理の変更履歴を確認してください`
  return [db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
    SELECT ?, user_id, ?, '従業員の口座・給与が変更されました: ' || COALESCE((SELECT us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?), ''), ?, ?, ?, ?
    FROM users WHERE company_id = ? AND role = 'company_admin' AND status = 'active' AND user_id != ?`)
    .bind(o.companyId, PAYROLL_CHANGED_KIND, Number(o.staffId), body, `/admin#employees/${Number(o.staffId)}`, Number(o.staffId), o.at, o.companyId, o.actorId)]
}
