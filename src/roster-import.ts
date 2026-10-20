// =========================================================
// スタッフマスタ・従業員の CSV 一括登録（#430）
//
// 画面（roster.js）で CSV を読み、見出しと各行のセルをそのまま送る。サーバーで見出しを項目に対応付けて確かめる。
//   GET  /admin/roster/import/template : テンプレート CSV（見出しと記入例）
//   POST /admin/roster/import/preview  : 確かめるだけ（登録しない）。行ごとに エラー / 警告 / 登録できる を返す
//   POST /admin/roster/import/commit   : 登録する。行ごとに作り直して確かめ、エラーの行は登録しない。
//                                         警告（同じ人と思われるスタッフがいる など）の行は accept_warnings のときだけ登録する
// 登録の内容は 1件ずつの登録（POST /admin/roster の ②自社雇用・③取引先・④スキルシートのみ）と同じ。
//   - ②自社雇用はログインを作る。スタッフ番号が空なら空いている番号を使う。③取引先はスタッフ番号があるときだけログインを作る
//   - 初期パスワードは自動で作り、登録の結果でだけ返す（保存はハッシュのみ。初回ログインで変更を求める）
// Workers の CPU 時間の上限があるため、登録は1回に COMMIT_MAX_ROWS 行まで・パスワードのハッシュは COMMIT_MAX_LOGINS 件までにし、
// 画面から何回かに分けて送る。確かめる処理は、既存のスタッフを1回だけ読んで索引にしてから比べる（行数×人数の比較をしない）
// =========================================================
import { Hono } from 'hono'
import { createPerson, getRequiredFields, missingRequired, normalizeRosterValues, nextStaffCode, samePersonRows, inactiveLabelOf, unusablePasswordHash, type AffiliationType } from './roster'
import { hashPassword } from './lib/auth'
import { isISODate } from './lib/validate'
import { genTempPassword } from './accounts'
import { normalizePhone } from './staff-lifecycle'
import { toCsv, csvResponse } from './csv'

type Bindings = { DB: D1Database }
type Variables = { user: any }

const PREVIEW_MAX_ROWS = 500
export const COMMIT_MAX_ROWS = 5
export const COMMIT_MAX_LOGINS = 1
const SYSTEM_CODE_RE = /^(TMP|PT|SS|LK)-/i

// CSV の列（見出し）。aliases は別の書き方の見出し（全角・半角、空白、* は無視して比べる）
const COLUMNS: { key: string; label: string; aliases?: string[]; example: string; note?: string }[] = [
  { key: 'type', label: '区分', aliases: ['affiliation_type'], example: '自社雇用', note: '自社雇用 / 取引先 / スキルシートのみ' },
  { key: 'name', label: '氏名', example: '山田 太郎' },
  { key: 'kana', label: 'フリガナ', example: 'ヤマダ タロウ' },
  { key: 'gender', label: '性別', example: '男性', note: '男性 / 女性 / その他 / 回答しない' },
  { key: 'date_of_birth', label: '生年月日', example: '1995-04-01' },
  { key: 'phone', label: '電話番号', aliases: ['電話'], example: '09012345678' },
  { key: 'email', label: 'メール', aliases: ['メールアドレス'], example: '' },
  { key: 'user_code', label: 'スタッフ番号', example: '', note: '自社雇用で空欄なら空いている番号を使う。取引先は入れたときだけログインを作る' },
  { key: 'partner_name', label: '取引先名', example: '', note: '取引先の人のみ（必須）' },
  { key: 'affiliation_contact', label: '所属先担当者名', example: '' },
  { key: 'affiliation', label: '所属会社名', example: '', note: 'スキルシートのみの人の表示用' },
  { key: 'skills', label: 'スキル', example: 'MNP,接客' },
  { key: 'work_area', label: '稼働可能エリア', example: '東京23区' },
  { key: 'career', label: '経歴', example: '' },
  { key: 'nearest_station_line', label: '最寄駅（路線）', example: 'JR山手線' },
  { key: 'nearest_station', label: '最寄駅（駅）', example: '渋谷' },
  { key: 'commute_minutes', label: '通勤可能時間', aliases: ['通勤可能時間（分）'], example: '60' },
  { key: 'available_from', label: '稼働開始可能日', example: '' },
  { key: 'employee_number', label: '社員番号', example: '', note: '自社雇用のみ' },
  { key: 'hire_date', label: '入社年月日', example: '', note: '自社雇用のみ' },
  { key: 'contract_type', label: '契約形態', example: '', note: '自社雇用のみ' },
]
const TYPE_VALUES: Record<string, AffiliationType> = {
  自社雇用: 'own_employee', 自社: 'own_employee', 従業員: 'own_employee', own_employee: 'own_employee', employee: 'own_employee',
  取引先: 'partner_manual', partner_manual: 'partner_manual', partner: 'partner_manual',
  スキルシートのみ: 'skillsheet_only', スキルシート: 'skillsheet_only', skillsheet_only: 'skillsheet_only', skillsheet: 'skillsheet_only',
}
const IMPORT_TYPE_LABEL: Record<string, string> = { own_employee: '自社雇用', partner_manual: '取引先', skillsheet_only: 'スキルシートのみ' }
const GENDER_VALUES: Record<string, string> = {
  男性: 'male', 男: 'male', male: 'male', m: 'male', 女性: 'female', 女: 'female', female: 'female', f: 'female',
  その他: 'other', other: 'other', 回答しない: 'unspecified', 無回答: 'unspecified', unspecified: 'unspecified',
}

function normHeader(h: unknown): string {
  return String(h ?? '').normalize('NFKC').replace(/^﻿/, '').replace(/[\s*＊]/g, '').toLowerCase()
}
const HEADER_INDEX = new Map<string, string>()
for (const col of COLUMNS) for (const h of [col.label, col.key, ...(col.aliases || [])]) HEADER_INDEX.set(normHeader(h), col.key)

/** 見出しの各列を項目に対応付ける。知らない見出しは unknown に入れる（その列は読まない） */
function mapHeader(header: unknown[]): { keys: (string | null)[]; unknown: string[]; missing: string[]; duplicated: string[] } {
  const seen = new Set<string>(); const duplicated: string[] = []
  const keys = header.map(h => {
    const k = HEADER_INDEX.get(normHeader(h)) || null
    if (k && seen.has(k)) { duplicated.push(String(h)); return null }
    if (k) seen.add(k)
    return k
  })
  const unknown = header.filter((h, i) => !keys[i] && String(h ?? '').trim() && !duplicated.includes(String(h))).map(h => String(h))
  const missing = ['type', 'name', 'gender'].filter(k => !seen.has(k)).map(k => COLUMNS.find(c => c.key === k)!.label)
  return { keys, unknown, missing, duplicated }
}

function cell(v: unknown): string { return String(v ?? '').normalize('NFKC').trim() }
// 2000/1/31・2000.1.31・2000-1-31 を 2000-01-31 にする（形が合わなければそのまま返し、後の確認でエラーにする）
function normDate(s: string): string {
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : s
}
const nameKey = (n: unknown) => String(n || '').replace(/[\s　]/g, '')

type ImportCtx = {
  companyId: number
  ownName: string
  required: Set<string>
  byPhone: Map<string, any[]>
  byNameDob: Map<string, any[]>
  usedCodes: Set<string>
  empNos: Set<string>
  partners: Set<string>
  otherCompanyNames: Set<string>
  today: string
}
type FileSeen = { codes: Map<string, number>; empNos: Map<string, number>; phones: Map<string, number>; nameDob: Map<string, number> }
export type RowResult = {
  line: number; type: string | null; type_label: string; name: string; user_code: string | null; login: boolean
  errors: string[]; warnings: string[]; notes: string[]; data?: Record<string, any>
}

async function loadCtx(db: D1Database, companyId: number, partnerNames: string[]): Promise<ImportCtx> {
  const [required, co, people, users, emps, partners] = await Promise.all([
    getRequiredFields(db, companyId),
    db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(companyId).first() as Promise<any>,
    samePersonRows(db, companyId),
    db.prepare('SELECT user_code FROM users WHERE company_id = ?').bind(companyId).all(),
    db.prepare('SELECT employee_number FROM employee_records WHERE company_id = ? AND employee_number IS NOT NULL').bind(companyId).all(),
    db.prepare('SELECT affiliation_name FROM staff_affiliations WHERE company_id = ?').bind(companyId).all(),
  ])
  const byPhone = new Map<string, any[]>(), byNameDob = new Map<string, any[]>()
  const push = (m: Map<string, any[]>, k: string, r: any) => { const a = m.get(k); if (a) a.push(r); else m.set(k, [r]) }
  for (const r of people) {
    const p = normalizePhone(r.phone)
    if (p.length >= 10) push(byPhone, p, r)
    if (r.dob && nameKey(r.name)) push(byNameDob, `${nameKey(r.name)}|${r.dob}`, r)
    // 他社連携の行は生年月日を持たない（所属元だけの項目。#9001）ので、氏名だけで照らす
    else if (r.linked && nameKey(r.name)) push(byNameDob, `${nameKey(r.name)}|linked`, r)
  }
  // 取引先名が他の導入企業の会社名と同じか（partnerNameConflict と同じ確認を、名前の一覧でまとめて行う）
  const names = [...new Set(partnerNames.filter(Boolean))]
  const other = names.length
    ? (await db.prepare('SELECT company_name FROM companies WHERE company_id != ? AND company_name IN (SELECT value FROM json_each(?))')
      .bind(companyId, JSON.stringify(names)).all()).results as any[]
    : []
  return {
    companyId, ownName: co?.company_name || '', required, byPhone, byNameDob,
    usedCodes: new Set((users.results as any[]).map(r => String(r.user_code || '').toLowerCase())),
    empNos: new Set((emps.results as any[]).map(r => String(r.employee_number))),
    partners: new Set((partners.results as any[]).map(r => String(r.affiliation_name))),
    otherCompanyNames: new Set(other.map(r => String(r.company_name))),
    today: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
  }
}

/** 1行を確かめ、登録する値（data）を作る。seen はファイルの中の重複の確認用（前の行の値） */
function checkRow(ctx: ImportCtx, seen: FileSeen, line: number, keys: (string | null)[], cells: unknown[]): RowResult {
  const raw: Record<string, string> = {}
  keys.forEach((k, i) => { if (k) raw[k] = cell(cells[i]) })
  const errors: string[] = [], warnings: string[] = [], notes: string[] = []
  const type = TYPE_VALUES[raw.type] || TYPE_VALUES[(raw.type || '').toLowerCase()] || null
  const name = raw.name || ''
  const out: RowResult = { line, type, type_label: type ? IMPORT_TYPE_LABEL[type] : (raw.type || ''), name, user_code: null, login: false, errors, warnings, notes }
  if (!type) errors.push(raw.type ? `区分「${raw.type}」は使えません（自社雇用 / 取引先 / スキルシートのみ）` : '区分を入れてください')
  if (!name) errors.push('氏名を入れてください')
  const gender = GENDER_VALUES[raw.gender] || GENDER_VALUES[(raw.gender || '').toLowerCase()] || null
  if (!raw.gender) errors.push('性別を入れてください')
  else if (!gender) errors.push(`性別「${raw.gender}」は使えません（男性 / 女性 / その他 / 回答しない）`)
  if (!type) return out

  const data: Record<string, any> = {
    name, gender, kana: raw.kana || null, date_of_birth: raw.date_of_birth ? normDate(raw.date_of_birth) : null,
    phone: raw.phone || null, email: raw.email || null, skills: raw.skills || '', work_area: raw.work_area || '', career: raw.career || '',
    nearest_station_line: raw.nearest_station_line || null, nearest_station: raw.nearest_station || null,
    commute_minutes: raw.commute_minutes || null, available_from: raw.available_from ? normDate(raw.available_from) : null,
    affiliation_contact: type === 'partner_manual' ? (raw.affiliation_contact || null) : null,
    affiliation: type === 'skillsheet_only' ? (raw.affiliation || null) : null,
  }
  const valueErr = normalizeRosterValues(data)
  if (valueErr) errors.push(valueErr)
  // Excel で開いて保存すると、電話番号の先頭の 0 が消えることがある
  const phone = data.phone ? normalizePhone(data.phone) : ''
  if (phone && !phone.startsWith('0')) errors.push('電話番号は0から始まる番号で入れてください（Excel で先頭の0が消えていないか確かめてください）')
  data.phone = phone || null

  // ログイン: ②自社雇用は必ず作る。③取引先はスタッフ番号を入れたときだけ。④は作らない
  const code = raw.user_code || ''
  const login = type === 'own_employee' || (type === 'partner_manual' && !!code)
  out.login = login
  if (type === 'skillsheet_only' && code) warnings.push('スキルシートのみの人はログインを作らないため、スタッフ番号は使いません')
  if (login) {
    if (code) {
      out.user_code = code
      if (SYSTEM_CODE_RE.test(code)) errors.push(`スタッフ番号「${code}」は使えません（TMP- PT- SS- LK- で始まる番号はシステムが使います）`)
      else if (ctx.usedCodes.has(code.toLowerCase())) errors.push(`スタッフ番号「${code}」は登録済みです`)
      else if (seen.codes.has(code.toLowerCase())) errors.push(`スタッフ番号「${code}」が ${seen.codes.get(code.toLowerCase())} 行目と同じです`)
      else seen.codes.set(code.toLowerCase(), line)
    } else notes.push('スタッフ番号は空いている番号を使います')
  }
  if (!login && data.email) { warnings.push('ログインを作らない人のメールアドレスは保存しません'); data.email = null }
  const missing = missingRequired(ctx.required, data, 'create', type, login)
  if (missing.length) errors.push(`次の項目は必須です: ${missing.join('・')}`)

  // 所属会社（取引先）
  if (type === 'partner_manual') {
    const pname = raw.partner_name || ''
    if (!pname) errors.push('取引先の人は取引先名を入れてください')
    else if (pname === ctx.ownName) errors.push('自社名は取引先として登録できません（区分を「自社雇用」にしてください）')
    else if (ctx.otherCompanyNames.has(pname)) errors.push(`「${pname}」はField OSの導入企業のため、取引先として登録できません（①QR/ID連携で登録してください）`)
    else if (!ctx.partners.has(pname)) notes.push(`取引先「${pname}」を新しく登録します`)
    data.partner_name = pname
  } else if (raw.partner_name) warnings.push('取引先名は、区分が取引先の人だけに使います')

  // 自社雇用の従業員管理の項目
  if (type === 'own_employee') {
    const empNo = raw.employee_number || ''
    if (empNo) {
      if (ctx.empNos.has(empNo)) errors.push(`社員番号「${empNo}」は使用されています`)
      else if (seen.empNos.has(empNo)) errors.push(`社員番号「${empNo}」が ${seen.empNos.get(empNo)} 行目と同じです`)
      else seen.empNos.set(empNo, line)
    }
    const hire = raw.hire_date ? normDate(raw.hire_date) : ''
    if (hire && !isISODate(hire)) errors.push('入社年月日は「2000-01-31」の形式で入れてください')
    data.employee_number = empNo || null; data.hire_date = hire || null; data.contract_type = raw.contract_type || null
  } else if (raw.employee_number || raw.hire_date || raw.contract_type) warnings.push('社員番号・入社年月日・契約形態は、自社雇用の人だけに使います')

  // 同じ人の確認（#223）: 登録済みのスタッフと、ファイルの前の行
  const same = new Map<number, { r: any; reasons: string[] }>()
  const addSame = (r: any, reason: string) => { const x = same.get(r.staff_id) || { r, reasons: [] }; x.reasons.push(reason); same.set(r.staff_id, x) }
  if (phone.length >= 10) for (const r of ctx.byPhone.get(phone) || []) addSame(r, '電話番号が同じ')
  const nd = name && data.date_of_birth ? `${nameKey(name)}|${data.date_of_birth}` : ''
  if (nd) for (const r of ctx.byNameDob.get(nd) || []) addSame(r, '氏名と生年月日が同じ')
  if (nd) for (const r of ctx.byNameDob.get(`${nameKey(name)}|linked`) || []) addSame(r, '氏名が同じ（他社連携のスタッフ）')
  for (const { r, reasons } of [...same.values()].slice(0, 5)) {
    const inactive = inactiveLabelOf(r, ctx.today)
    warnings.push(`同じ人と思われるスタッフが登録済みです: ${r.name}（${reasons.join('・')}${inactive ? `・${inactive}` : ''}）`)
  }
  if (phone.length >= 10) {
    if (seen.phones.has(phone)) warnings.push(`電話番号が ${seen.phones.get(phone)} 行目と同じです`)
    else seen.phones.set(phone, line)
  }
  if (nd) {
    if (seen.nameDob.has(nd)) warnings.push(`氏名と生年月日が ${seen.nameDob.get(nd)} 行目と同じです`)
    else seen.nameDob.set(nd, line)
  }
  out.data = data
  return out
}

type ImportBody = { header?: unknown; rows?: unknown; accept_warnings?: unknown; reserved_codes?: unknown }
type InputRow = { line: number; cells: unknown[] }
function parseBody(b: ImportBody, max: number): { header: unknown[]; rows: InputRow[] } | { error: string } {
  if (!Array.isArray(b.header) || !b.header.length || b.header.length > 100) return { error: 'CSV の見出しの行を読めませんでした' }
  if (!Array.isArray(b.rows)) return { error: 'CSV の行を読めませんでした' }
  if (!b.rows.length) return { error: '登録する行がありません' }
  if (b.rows.length > max) return { error: `1回に送れるのは ${max} 行までです` }
  const rows: InputRow[] = []
  for (const r of b.rows as any[]) {
    if (!r || !Array.isArray(r.cells) || r.cells.length > 100 || !Number.isInteger(r.line)) return { error: 'CSV の行の形式が正しくありません' }
    rows.push({ line: r.line, cells: r.cells.map((v: unknown) => String(v ?? '').slice(0, 2000)) })
  }
  return { header: b.header as unknown[], rows }
}
function partnerNamesOf(keys: (string | null)[], rows: InputRow[]): string[] {
  const i = keys.indexOf('partner_name')
  return i < 0 ? [] : rows.map(r => cell(r.cells[i])).filter(Boolean)
}

/** 1人を登録する。persons を先に作り、ユーザー・スタッフマスタ・取引先・従業員管理は1つの batch で入れる（途中で失敗したら persons を消す） */
async function insertRow(db: D1Database, u: any, ctx: ImportCtx, row: RowResult, reserved: Set<string>): Promise<{ staff_id: number; user_code: string; password: string | null } | { error: string }> {
  const d = row.data!; const type = row.type as AffiliationType
  const person = await createPerson(db, u.company_id)
  let userCode = row.user_code
  let password: string | null = null
  if (row.login && !userCode) userCode = (await nextStaffCode(db, u.company_id, reserved)).code
  if (!row.login) userCode = (type === 'skillsheet_only' ? 'SS-' : 'PT-') + person.global_staff_code
  if (row.login) password = genTempPassword(10)
  const pwHash = password ? await hashPassword(password) : await unusablePasswordHash()
  const affiliation = type === 'own_employee' ? ctx.ownName : type === 'partner_manual' ? d.partner_name : (d.affiliation || null)
  const userOf = `(SELECT user_id FROM users WHERE company_id = ? AND user_code = ?)`
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone, person_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, userCode, d.name, row.login ? 'staff' : 'roster_only', pwHash, row.login ? (d.email || null) : null, d.phone || null, person.person_id, row.login ? 1 : 0),
  ]
  if (type === 'partner_manual') stmts.push(db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(u.company_id, d.partner_name))
  stmts.push(db.prepare(`INSERT INTO staff_profiles
      (user_id, company_id, person_id, owner_company_id, affiliation_type, partner_affiliation_id, affiliation, affiliation_contact,
       kana, gender, date_of_birth, skills, career, work_area, nearest_station_line, nearest_station, commute_minutes, available_from, employment_status)
      VALUES (${userOf}, ?, ?, ?, ?, ${type === 'partner_manual' ? '(SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?)' : 'NULL'},
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working')`)
    .bind(u.company_id, userCode, u.company_id, person.person_id, u.company_id, type,
      ...(type === 'partner_manual' ? [u.company_id, d.partner_name] : []),
      affiliation, d.affiliation_contact || null,
      d.kana || null, d.gender, d.date_of_birth || null, d.skills || '', d.career || '', d.work_area || '',
      d.nearest_station_line || null, d.nearest_station || null, d.commute_minutes ?? null, d.available_from || null))
  // ②では従業員管理の最小レコードも作る（1件ずつの登録と同じ。電話番号は従業員管理の電話番号にも入れる）
  if (type === 'own_employee' && (d.employee_number || d.hire_date || d.contract_type || d.phone)) {
    stmts.push(db.prepare(`INSERT INTO employee_records (staff_id, company_id, employee_number, hire_date, contract_type, phone_main, updated_at)
      VALUES ((SELECT staff_id FROM staff_profiles WHERE company_id = ? AND person_id = ?), ?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, person.person_id, u.company_id, d.employee_number || null, d.hire_date || null, d.contract_type || null, d.phone || null,
        new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')))
  }
  try {
    const res = await db.batch(stmts)
    const staffId = res[type === 'partner_manual' ? 2 : 1].meta.last_row_id as number
    return { staff_id: staffId, user_code: userCode!, password }
  } catch (e) {
    await db.prepare('DELETE FROM persons WHERE person_id = ?').bind(person.person_id).run().catch(() => {})
    const msg = String(e)
    if (/UNIQUE/i.test(msg) && /user_code/i.test(msg)) return { error: `スタッフ番号「${userCode}」は登録済みです` }
    if (/UNIQUE/i.test(msg) && /employee_number/i.test(msg)) return { error: '社員番号は使用されています' }
    console.log(`roster import failed: ${msg}`)
    return { error: '登録に失敗しました' }
  }
}

const importApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

importApi.get('/template', (c) => {
  const header = COLUMNS.map(col => col.label)
  const rows = [
    COLUMNS.map(col => col.example),
    COLUMNS.map(col => ({ type: '取引先', name: '佐藤 花子', kana: 'サトウ ハナコ', gender: '女性', partner_name: '株式会社サンプル', affiliation_contact: '鈴木' } as Record<string, string>)[col.key] || ''),
  ]
  return csvResponse('スタッフ一括登録テンプレート.csv', toCsv(header, rows, { textCols: ['電話番号', 'スタッフ番号', '社員番号'] }))
})

importApi.post('/preview', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as ImportBody))
  const parsed = parseBody(b, PREVIEW_MAX_ROWS)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const head = mapHeader(parsed.header)
  if (head.missing.length) return c.json({ error: `見出しに次の列がありません: ${head.missing.join('・')}（テンプレートの見出しを使ってください）`, unknown_columns: head.unknown }, 400)
  const ctx = await loadCtx(db, u.company_id, partnerNamesOf(head.keys, parsed.rows))
  const seen: FileSeen = { codes: new Map(), empNos: new Map(), phones: new Map(), nameDob: new Map() }
  const rows = parsed.rows.map(r => { const x = checkRow(ctx, seen, r.line, head.keys, r.cells); delete x.data; return x })
  return c.json({
    rows,
    unknown_columns: head.unknown,
    duplicated_columns: head.duplicated,
    summary: {
      total: rows.length,
      ok: rows.filter(r => !r.errors.length && !r.warnings.length).length,
      warning: rows.filter(r => !r.errors.length && r.warnings.length).length,
      error: rows.filter(r => r.errors.length).length,
      logins: rows.filter(r => !r.errors.length && r.login).length,
    },
    limits: { commit_rows: COMMIT_MAX_ROWS, commit_logins: COMMIT_MAX_LOGINS },
  })
})

importApi.post('/commit', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as ImportBody))
  const parsed = parseBody(b, COMMIT_MAX_ROWS)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const head = mapHeader(parsed.header)
  if (head.missing.length) return c.json({ error: `見出しに次の列がありません: ${head.missing.join('・')}` }, 400)
  const ctx = await loadCtx(db, u.company_id, partnerNamesOf(head.keys, parsed.rows))
  const seen: FileSeen = { codes: new Map(), empNos: new Map(), phones: new Map(), nameDob: new Map() }
  const checked = parsed.rows.map(r => checkRow(ctx, seen, r.line, head.keys, r.cells))
  if (checked.filter(r => !r.errors.length && r.login).length > COMMIT_MAX_LOGINS) {
    return c.json({ error: `ログインを作る行は、1回に ${COMMIT_MAX_LOGINS} 行までにしてください` }, 400)
  }
  const accept = b.accept_warnings === true
  // 空欄の行に自動で付ける番号は、ファイルの中で指定されている番号（後で送る行の分を含む）と重ならないようにする
  const reserved = new Set<string>(checked.map(r => r.user_code).filter((x): x is string => !!x))
  if (Array.isArray(b.reserved_codes)) {
    for (const x of b.reserved_codes.slice(0, PREVIEW_MAX_ROWS)) if (typeof x === 'string' && x.trim()) reserved.add(x.normalize('NFKC').trim().slice(0, 64))
  }
  const results: any[] = []
  for (const r of checked) {
    const base = { line: r.line, name: r.name, type_label: r.type_label, errors: r.errors, warnings: r.warnings }
    if (r.errors.length) { results.push({ ...base, status: 'error' }); continue }
    if (r.warnings.length && !accept) { results.push({ ...base, status: 'skipped' }); continue }
    const ins = await insertRow(db, u, ctx, r, reserved)
    if ('error' in ins) { results.push({ ...base, status: 'error', errors: [ins.error] }); continue }
    results.push({ ...base, status: 'created', staff_id: ins.staff_id, user_code: ins.user_code, login: r.login, password: ins.password })
  }
  return c.json({ results })
})

export default importApi
