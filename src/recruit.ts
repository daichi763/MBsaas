// =========================================================
// 募集ページ（公開URL・QR）/ 応募 / 承認でシフト確定・仮登録の自動作成 / 既存スタッフの応募
// docs/spec_spot_shift.md 第4段階
//
// - 管理者向け: recruitAdminApi（/api/admin/*。権限ミドルウェアの後に登録）
// - ログイン不要の公開ページ: recruitPublicApi（/api/public/recruit/*。認証ミドルウェアの前に登録）
// - スタッフアプリ: recruitStaffApi（/api/staff/recruit/*）
// 応募はすべて管理者の承認で確定する。公開ページには金額・案件名・クライアント名を出さない（表示文言は管理者が入力する）。
// =========================================================
import { Hono } from 'hono'
import { applyPricingToShift, conflictFor, findConflicts, loadPricingData, ngStaffIds } from './shift-board'
import { findStaffByPhone, findStaffByPhones, insertProvisionalStaff, normalizePhone } from './staff-lifecycle'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { loadTransportDefaults, transportDefaultFor } from './lib/transport-defaults'
import { assertAssignable, conflictLabel, isUniqueViolation } from './lib/staff-eligibility'
import { personStaffRows } from './roster'
import { shiftWindow } from './lib/shift-time'
import { isCompanyActive } from './lib/auth'
import { notifyRecruitApplied } from './notifications'
import { notifyRecruitNew, notifyRecruitResult, notifyRecruitResults, staffAppRecruitEnabled } from './notifications'
import { opLog, logShifts, finishLog } from './lib/operation-log'
import { mailMode } from './services/email'
import { isHHMM, isISODate, toInt } from './lib/validate'

// RATE_LIMIT_SALT: 送信回数の制限に使う接続元IPのハッシュの塩（秘密の値。wrangler secret put で登録する。#351）
type Bindings = { DB: D1Database; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string; RATE_LIMIT_SALT?: string
  RESEND_API_KEY?: string; MAIL_FROM?: string; APP_BASE_URL?: string; MAIL_ENABLED?: string; STAFF_APP_RECRUIT?: string }
type Variables = { user: any }

// ---------- 定数 ----------
const MAX_PAGE_DAYS = 62
const MAX_SLOTS_PER_APPLY = 31
const MAX_PAGES_PER_STAFF_APPLY = 10 // スタッフアプリで一度に応募できる募集ページの数（#239）
const MAX_PAGE_PROJECTS = 50      // 1つの募集ページで対象にできる案件の数
const MAX_APPLICATIONS_LIST = 200 // 応募一覧で一度に返す件数（続きは offset で取得する。#339）
const ROLES_PER_PAGE = 300        // 公開ページ・スタッフアプリで一度に返す枠の数（続きは next_from の日付から取得する。#126）
const RATE_PER_IP_HOUR = 30       // 同じ接続元からの送信は、募集ページごとに1時間に30件まで（会場の共用回線を考えてページ単位にする。#225）
const RATE_PER_PHONE_DAY = 3      // 同じ電話番号からの送信は1日に3件まで（募集ページごと）
const MIN_FILL_MS = 3000          // 表示から3秒未満の送信は機械的な送信とみなす
const PROCESSING_STALE_MIN = 10   // 承認の処理中（processing）のまま止まった明細を未対応に戻すまでの分数
const RETENTION_DAYS = 180        // 採用に至らなかった公開ページの応募を保存する日数（purgeOldApplications）
const NEW_STAFF_TYPES = ['daily_worker', 'freelance', 'partner_manual', 'own_employee']

// ---------- ユーティリティ ----------
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
function addMinutesJST(m: number): string { return new Date(Date.now() + (9 * 60 + m) * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
function dayDiff(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) }
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
function randToken(bytes = 18): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const str = (v: any, max: number) => String(v ?? '').trim().slice(0, max)
function parseIds(v: any): number[] {
  const arr = Array.isArray(v) ? v : String(v || '').split(',')
  return [...new Set(arr.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
}
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

// ---------- 募集ページの独自の質問（#300） ----------
const MAX_QUESTIONS = 5
const MAX_QUESTION_OPTIONS = 10
const MAX_ANSWER_LEN = 200
const QUESTION_TYPES = ['text', 'select', 'yesno']
const YESNO: Record<string, string> = { yes: 'はい', no: 'いいえ' }
type Question = { key: string; label: string; type: string; required: boolean; options: string[] }
function parseJsonArray(v: any): any[] { try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch { return [] } }
const parseQuestions = (v: any): Question[] => parseJsonArray(v)
const parseAnswers = (v: any): { key: string; label: string; type: string; value: string }[] => parseJsonArray(v)
// 管理画面から受け取った質問を検証して保存の形にする。key（q1, q2 …）は既存の質問のものを保ち、新しい質問には
// 今の質問（prevKeys）・送られた質問のどれとも重ならない番号を振る（入力中の応募フォームの回答が別の質問に付かないように）
function normalizeQuestions(input: any, prevKeys: string[] = []): { questions?: Question[]; error?: string } {
  if (input == null || input === '') return { questions: [] }
  if (!Array.isArray(input)) return { error: '質問の形式が正しくありません' }
  const list = input.filter((q: any) => q && str(q.label, 100))
  if (list.length > MAX_QUESTIONS) return { error: `質問は${MAX_QUESTIONS}問までです` }
  const used = new Set<string>()
  for (const q of list) if (/^q\d{1,3}$/.test(q.key) && !used.has(q.key)) used.add(q.key); else q.key = ''
  let n = Math.max(0, ...[...used, ...prevKeys.filter(k => /^q\d{1,3}$/.test(k))].map(k => Number(k.slice(1))))
  const out: Question[] = []
  for (const q of list) {
    const label = str(q.label, 100)
    const type = QUESTION_TYPES.includes(q.type) ? q.type : 'text'
    const raw = Array.isArray(q.options) ? q.options : String(q.options ?? '').split(/[\n,、，]/)
    const options = type === 'select' ? [...new Set(raw.map((x: any) => str(x, 40)).filter(Boolean))] as string[] : []
    if (type === 'select' && options.length < 2) return { error: `「${label}」の選択肢を2つ以上入力してください` }
    if (options.length > MAX_QUESTION_OPTIONS) return { error: `「${label}」の選択肢は${MAX_QUESTION_OPTIONS}個までです` }
    out.push({ key: q.key || `q${++n}`, label, type, required: !!q.required, options })
  }
  return { questions: out }
}
// 応募の回答を検証し、質問の文言と合わせて控えにする。誤りは field（q_ + key）で返す
function readAnswers(questions: Question[], input: any): { answers: any[]; error?: string; field?: string } {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const answers: any[] = []
  for (const q of questions) {
    let value = str(src[q.key], MAX_ANSWER_LEN)
    if (q.type === 'select' && value && !q.options.includes(value)) return { answers, error: `「${q.label}」は選択肢から選んでください`, field: `q_${q.key}` }
    if (q.type === 'yesno') value = YESNO[value] || (Object.values(YESNO).includes(value) ? value : '')
    if (q.required && !value) return { answers, error: `「${q.label}」に回答してください`, field: `q_${q.key}` }
    if (value) answers.push({ key: q.key, label: q.label, type: q.type, value })
  }
  return { answers }
}
// 仮登録のスタッフのメモに引き継ぐ内容（応募時のメモと質問への回答）
function applicantMemo(a: any): string | null {
  const parts: string[] = []
  if (a.note) parts.push(`応募時のメモ: ${a.note}`)
  const ans = parseAnswers(a.answers)
  if (ans.length) parts.push('応募時の回答:\n' + ans.map(x => `・${x.label}: ${x.value}`).join('\n'))
  return parts.join('\n') || null
}

// 募集ページの対象となる枠（役割）の条件。開始時刻を過ぎた当日の枠は締め切る（#190）
function openRolesWhere(page: any, opts: { fromDate?: string; roleIds?: number[] } = {}): { sql: string; bind: any[] } | null {
  const pids = parseIds(page.project_ids)
  if (!pids.length) return null
  if (opts.roleIds && !opts.roleIds.length) return null
  const now = nowJST(), today = now.slice(0, 10)
  const from = [page.date_from, isDate(opts.fromDate) && opts.fromDate! > today ? opts.fromDate! : today].sort().pop()!
  // 案件・枠のIDは json_each で1つにまとめてバインドする（D1 のバインド上限 100）
  const w = [`sl.company_id = ?`, `sl.project_id IN ${JSON_IN}`, `sl.work_date BETWEEN ? AND ?`, `COALESCE(sl.status,'open') = 'open'`, `(sl.work_date > ? OR sl.start_time > ?)`]
  const bind: any[] = [page.company_id, bindJsonArray(pids), from, page.date_to, today, now.slice(11, 16)]
  if (opts.roleIds) { w.push(`r.slot_role_id IN ${JSON_IN}`); bind.push(bindJsonArray(opts.roleIds)) }
  return { sql: w.join(' AND '), bind }
}
const ASSIGNED_SQL = `(SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = r.slot_role_id AND s.status != 'absent')`

// 募集ページの対象となる枠（役割）と残り人数。limit を付けないときは、条件に合う枠をすべて返す
async function openRoles(db: D1Database, page: any, opts: { fromDate?: string; roleIds?: number[]; limit?: number } = {}) {
  const q = openRolesWhere(page, opts)
  if (!q) return []
  const rows = (await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes,
      COALESCE(si.site_name, sl.location, p.location, '') AS place, si.address AS site_address,
      ${ASSIGNED_SQL} AS assigned,
      (SELECT COUNT(*) FROM recruit_application_items i WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending') AS pending
    FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id JOIN projects p ON p.project_id = sl.project_id
    LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE ${q.sql} ORDER BY sl.work_date, sl.start_time, r.sort_order, r.slot_role_id${opts.limit ? ` LIMIT ${Number(opts.limit)}` : ''}`).bind(...q.bind).all()).results as any[]
  return rows.map(r => ({ ...r, remaining: Math.max(0, Number(r.headcount) - Number(r.assigned)) }))
}

// 公開ページ・スタッフアプリ向けに、fromDate の日から ROLES_PER_PAGE 件ずつ返す（#126）。
// 日付の途中では切らず、最後の日付は次の取得に回す（next_from）。1日だけで上限を超えるときは、その日の上限までを返して翌日から続ける
async function openRolesPage(db: D1Database, page: any, fromDate?: string) {
  return cutRolesPage(await openRoles(db, page, { fromDate, limit: ROLES_PER_PAGE + 1 }))
}
function cutRolesPage(rows: any[]) {
  if (rows.length <= ROLES_PER_PAGE) return { roles: rows, next_from: null as string | null }
  const lastDate = rows[ROLES_PER_PAGE].work_date
  const before = rows.slice(0, ROLES_PER_PAGE).filter(r => r.work_date < lastDate)
  if (before.length) return { roles: before, next_from: lastDate as string }
  return { roles: rows.slice(0, ROLES_PER_PAGE), next_from: addDays(lastDate, 1) }
}

// 複数の募集ページの対象の枠を、ページごとに問い合わせずに1回で取るための WITH 句（#410）。
// pageWhere で選んだ募集ページ（rp）ごとに、openRolesWhere と同じ条件（案件・期間・枠が募集中・開始前）の枠を pr として返す。
// bind は [今日, ...pageBind, 今日, 今の時刻] の順
function pagesRolesCte(pageWhere: string, pageBind: any[]) {
  const now = nowJST(), today = now.slice(0, 10)
  const sql = `WITH pg AS (
      SELECT rp.page_id, rp.company_id, rp.project_ids, MAX(rp.date_from, ?) AS dfrom, rp.date_to FROM recruit_pages rp WHERE ${pageWhere}
    ), pp AS (
      SELECT DISTINCT pg.page_id, pg.company_id, CAST(j.value AS INTEGER) AS project_id, pg.dfrom, pg.date_to
      FROM pg, json_each(CASE WHEN json_valid('[' || COALESCE(pg.project_ids, '') || ']') THEN '[' || COALESCE(pg.project_ids, '') || ']' ELSE '[]' END) j
    ), pr AS (
      SELECT pp.page_id, r.slot_role_id, r.role_name, r.headcount, r.sort_order, sl.slot_id, sl.project_id, sl.site_id, sl.location, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes
      FROM pp JOIN shift_slots sl ON sl.project_id = pp.project_id AND sl.company_id = pp.company_id AND sl.work_date BETWEEN pp.dfrom AND pp.date_to
      JOIN shift_slot_roles r ON r.slot_id = sl.slot_id
      WHERE COALESCE(sl.status,'open') = 'open' AND (sl.work_date > ? OR sl.start_time > ?)
    )`
  return { sql, bind: [today, ...pageBind, today, now.slice(11, 16)] }
}
const PR_ASSIGNED_SQL = `(SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = pr.slot_role_id AND s.status != 'absent')`

// 管理画面の「募集中の枠 n件（残りm名）」。公開中のページをまとめて、件数で打ち切らずに数える（#126 #410）
async function openRolesSummaries(db: D1Database, companyId: number) {
  const cte = pagesRolesCte(`rp.company_id = ? AND rp.status = 'open' AND rp.date_to >= ?`, [companyId, todayJST()])
  const rows = (await db.prepare(`${cte.sql}
    SELECT page_id, COUNT(*) AS roles, COALESCE(SUM(MAX(0, headcount - assigned)), 0) AS remaining
    FROM (SELECT pr.page_id, pr.headcount, ${PR_ASSIGNED_SQL} AS assigned FROM pr) GROUP BY page_id`).bind(...cte.bind).all()).results as any[]
  return new Map(rows.map(r => [r.page_id, { roles: Number(r.roles || 0), remaining: Number(r.remaining || 0) }]))
}

// 応募の日時の状態。承認済みでも、作ったシフトが削除・欠勤・別のスタッフへの差し替え・別の枠への移動になったものは
// 「シフト解除」（released）とみなす（#64。シフトを変える側では応募の行を書き換えないため、読むときに判定する）。
// 枠の削除で「枠なし」になったシフトは、本人のシフトとして残っているので承認済みのまま。recruit_applications を a として JOIN して使う
const ITEM_STATE_SQL = `CASE WHEN i.status = 'approved' AND NOT EXISTS (SELECT 1 FROM shifts xs WHERE xs.shift_id = i.shift_id AND xs.status != 'absent'
    AND xs.staff_id = a.staff_id AND (xs.slot_role_id IS NULL OR xs.slot_role_id = i.slot_role_id)) THEN 'released' ELSE i.status END`
// 応募済みとみなす（同じ枠に重ねて応募させない）状態: 未対応・処理中と、シフトが残っている承認済み
const ACTIVE_ITEM_SQL = `(i.status IN ('pending','processing') OR (i.status = 'approved' AND ${ITEM_STATE_SQL} = 'approved'))`

// 枠・役割が削除されて残った未対応の応募を「枠の削除」で処理済みにする（#65）。
// 枠の削除・繰り返し登録の削除（shift-board.ts）の後と、応募一覧・件数の取得のときに呼ぶ（枠の編集で役割を消した分もここで片づく）
export async function settleRemovedSlotItems(db: D1Database, companyId: number) {
  // 承認の途中で処理が止まった（通信が切れて打ち切られたなど）明細は、一定時間たったら未対応に戻す（#86。processing の間の decided_at は押さえた時刻）
  await db.prepare(`UPDATE recruit_application_items SET status = 'pending', decided_at = NULL WHERE status = 'processing' AND (decided_at IS NULL OR decided_at < ?)
    AND application_id IN (SELECT application_id FROM recruit_applications WHERE company_id = ?)`).bind(addMinutesJST(-PROCESSING_STALE_MIN), companyId).run()
  await expirePastItems(db, companyId)
  await cancelRetiredStaffItems(db, companyId)
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.status = 'pending' AND i.status = 'pending' AND NOT EXISTS (SELECT 1 FROM shift_slot_roles r WHERE r.slot_role_id = i.slot_role_id)`)
    .bind(companyId).all()).results as any[]
  if (!rows.length) return 0
  await db.prepare(`UPDATE recruit_application_items SET status = 'slot_removed', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(r => r.item_id))).run()
  for (const id of new Set(rows.map(r => r.application_id as number))) await closeIfDone(db, id)
  return rows.length
}
// 勤務日を過ぎても未対応のままの日時は「期限切れ」（expired）にする（#302）。未対応の件数・一覧の先頭に残り続けないようにする。
// 当日の分は、開始時刻を過ぎても管理者が承認できるよう（警告付き）、翌日になってから片づける
async function expirePastItems(db: D1Database, companyId: number) {
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE a.company_id = ? AND a.status = 'pending' AND i.status = 'pending' AND sl.work_date < ?`).bind(companyId, todayJST()).all()).results as any[]
  if (!rows.length) return
  await db.prepare(`UPDATE recruit_application_items SET status = 'expired', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(r => r.item_id))).run()
  for (const id of new Set(rows.map(r => r.application_id as number))) await closeIfDone(db, id)
}
// 退職したスタッフ（在籍状況が退職）の未対応の応募は「取り下げ」（cancelled）にする（#87）。
// 退職の処理（手での退職・退職日の翌日の定期処理）のどちらの後でも、応募一覧・件数を開いたときに片づく。休職・ログイン停止だけの人は残す（印を付けて承認で止める）
async function cancelRetiredStaffItems(db: D1Database, companyId: number) {
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN staff_profiles sp ON sp.staff_id = COALESCE(i.staff_id, a.staff_id)
    WHERE a.company_id = ? AND a.status = 'pending' AND i.status = 'pending' AND sp.employment_status = 'retired'`).bind(companyId).all()).results as any[]
  if (!rows.length) return
  await db.prepare(`UPDATE recruit_application_items SET status = 'cancelled', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(r => r.item_id))).run()
  for (const id of new Set(rows.map(r => r.application_id as number))) await closeIfDone(db, id)
}
async function loadPageByToken(db: D1Database, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return null
  return db.prepare(`SELECT rp.*, co.company_name FROM recruit_pages rp JOIN companies co ON co.company_id = rp.company_id WHERE rp.token = ?`).bind(token).first() as Promise<any>
}
function pageIsOpen(p: any) { return p && p.status === 'open' && p.date_to >= todayJST() }

// 公開・スタッフ向けの枠の表示（金額・案件名・クライアント名は出さない）
function publicRole(r: any, showRemaining: boolean) {
  return {
    slot_role_id: r.slot_role_id, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time, break_minutes: r.break_minutes,
    place: r.place, role_name: r.role_name, full: r.remaining <= 0, ...(showRemaining ? { remaining: r.remaining, headcount: r.headcount } : {}),
  }
}

// =========================================================
// 公開ページ（ログイン不要）
// =========================================================
export const recruitPublicApi = new Hono<{ Bindings: Bindings }>()

// 本部で停止にした企業の募集ページは、表示も応募の受け付けも止める（#66。ログインの要らない公開URLのため、ログインの停止とは別に確かめる）
recruitPublicApi.use('/:token/*', async (c, next) => {
  const token = c.req.param('token')
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return next()
  const co = await c.env.DB.prepare(`SELECT co.active_status FROM recruit_pages rp JOIN companies co ON co.company_id = rp.company_id WHERE rp.token = ?`).bind(token).first() as any
  if (co && !isCompanyActive(co.active_status)) return c.json({ error: 'この募集は終了しました', closed: true }, 410)
  return next()
})

recruitPublicApi.get('/:token', async (c) => {
  const page = await loadPageByToken(c.env.DB, c.req.param('token'))
  if (!page) return c.json({ error: 'この募集ページは見つかりません' }, 404)
  // 終了した募集でも、応募した人が連絡できるよう問い合わせ先を返す（#513）
  if (!pageIsOpen(page)) return c.json({ error: 'この募集は終了しました', closed: true, title: page.title, company_name: page.company_name, contact_note: page.contact_note || '' }, 410)
  // ?from=日付 で続きの日時を取得する（#126）
  const { roles, next_from } = await openRolesPage(c.env.DB, page, c.req.query('from'))
  return c.json({
    title: page.title, company_name: page.company_name, description: page.description || '', pay_note: page.pay_note || '', contact_note: page.contact_note || '',
    date_from: page.date_from, date_to: page.date_to, roles: roles.map(r => publicRole(r, !!page.show_remaining)), next_from,
    turnstile_site_key: turnstileEnabled(c.env) ? c.env.TURNSTILE_SITE_KEY : null, issued_at: Date.now(),
    retention_days: RETENTION_DAYS, // 同意文に書く保存期間（#351）
    result_mail: mailMode(c.env as any) === 'enabled', // 結果をメールで送れる設定か（false なら画面はメールで届くと案内しない。#151）
    questions: parseQuestions(page.questions).map(q => ({ key: q.key, label: q.label, type: q.type, required: !!q.required, options: q.options || [] })), // #300
  })
})

// Turnstile はサイトキーと秘密鍵の両方があるときだけ使う。片方だけのときは、画面に確認欄が出ないのにサーバーで確認して
// すべての応募が失敗するため、確認しない（管理画面に「片方だけ設定」と警告を出す。#501）
function turnstileEnabled(env: Bindings) { return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) }
function turnstileState(env: Bindings): 'enabled' | 'off' | 'site_key_only' | 'secret_key_only' {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) return 'enabled'
  if (env.TURNSTILE_SITE_KEY) return 'site_key_only'
  if (env.TURNSTILE_SECRET_KEY) return 'secret_key_only'
  return 'off'
}

const TURNSTILE_TIMEOUT_MS = 5000
// 'ok' / 'fail'（確認できなかった） / 'error'（Cloudflare に問い合わせできなかった）
async function verifyTurnstile(secret: string, token: string, ip: string | undefined): Promise<'ok' | 'fail' | 'error'> {
  try {
    const fd = new FormData(); fd.append('secret', secret); fd.append('response', token || ''); if (ip) fd.append('remoteip', ip)
    // 応答が遅いとき（タイムアウト）も接続できなかったものとして扱う（#501）
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd, signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS) })
    if (!r.ok) return 'error'
    const j = await r.json() as any
    return j.success ? 'ok' : 'fail'
  } catch (e) {
    console.error('turnstile siteverify failed', e)
    return 'error'
  }
}

recruitPublicApi.post('/:token/apply', async (c) => {
  const db = c.env.DB
  const page = await loadPageByToken(db, c.req.param('token'))
  if (!page) return c.json({ error: 'この募集ページは見つかりません' }, 404)
  if (!pageIsOpen(page)) return c.json({ error: 'この募集は終了しました' }, 410)
  const b = await c.req.json().catch(() => ({} as any))
  // 機械的な送信の対策: 入力欄に見えない項目（website）に値がある / 表示から送信までが短すぎる → 受け付けたように見せて保存しない
  const issued = Number(b.issued_at || 0)
  if (str(b.website, 200) || !issued || Date.now() - issued < MIN_FILL_MS) return c.json({ ok: true })
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || ''
  // 確認サービス（siteverify）に接続できなかったとき（障害・タイムアウト）は、応募を止めずに「要確認」の印を付けて受け付ける（#501。利用者の判断）。
  // 判定に落ちた（success=false）応募はこれまでどおり受け付けない。IP ごと・電話番号ごとの回数の制限は、印の有無にかかわらず効かせる
  let turnstileUnverified = false
  if (turnstileEnabled(c.env)) {
    const v = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY!, str(b.turnstile_token, 2048), ip)
    if (v === 'error') turnstileUnverified = true
    // 入力した内容は画面に残したまま、確認だけをやり直してもらう（#515）
    else if (v !== 'ok') return c.json({ error: '「人間であることの確認」をもう一度行ってから、送信してください', field: 'turnstile' }, 400)
  }
  // 入力の誤りは、どの欄かを field で返す（画面でその欄へ移動して強調する。#416）
  const name = str(b.name, 60), kana = str(b.kana, 60), email = str(b.email, 120).normalize('NFKC'), note = str(b.note, 500)
  const phone = normalizePhone(b.phone)
  if (!name) return c.json({ error: 'お名前を入力してください', field: 'name' }, 400)
  if (phone.length < 10 || phone.length > 11) return c.json({ error: '電話番号は10〜11桁の数字で入力してください（ハイフンはあってもなくても構いません）', field: 'phone' }, 400)
  if (email && !isEmail(email)) return c.json({ error: 'メールアドレスの形式が正しくありません', field: 'email' }, 400)
  // 募集ページの独自の質問への回答（#300）
  const qa = readAnswers(parseQuestions(page.questions), b.answers)
  if (qa.error) return c.json({ error: qa.error, field: qa.field }, 400)
  if (!b.agree) return c.json({ error: '個人情報の取り扱いに同意してください', field: 'agree' }, 400)
  const roleIds = parseIds(b.slot_role_ids)
  if (!roleIds.length) return c.json({ error: '希望する日時を選択してください', field: 'slots' }, 400)
  if (roleIds.length > MAX_SLOTS_PER_APPLY) return c.json({ error: `一度に選べるのは${MAX_SLOTS_PER_APPLY}件までです`, field: 'slots' }, 400)

  // 送信回数の制限（IPはそのまま保存せず、ハッシュのみ）。止めた件数はページごとに数えて管理画面に出す（#225）
  const blocked = async (error: string) => {
    await db.prepare('UPDATE recruit_pages SET blocked_count = COALESCE(blocked_count, 0) + 1, blocked_last_at = ? WHERE page_id = ?').bind(nowJST(), page.page_id).run().catch(() => null)
    return c.json({ error }, 429)
  }
  const ipHash = ip ? await ipHashFor(c.env, ip) : null
  if (ipHash) {
    // 募集ページごとに数える（説明会・イベント会場の共用回線や、他社の募集ページへの応募と合算しない。#225）
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE ip_hash = ? AND page_id = ? AND created_at >= ?`).bind(ipHash, page.page_id, addHourJST(-1)).first() as any
    if (n?.n >= RATE_PER_IP_HOUR) return blocked('送信回数が多すぎます。しばらくしてからお試しいただくか、お問い合わせ先へご連絡ください')
  }
  const pn = await db.prepare(`SELECT COUNT(*) AS n FROM recruit_applications WHERE page_id = ? AND phone = ? AND created_at >= ?`).bind(page.page_id, phone, todayJST() + ' 00:00:00').first() as any
  if (pn?.n >= RATE_PER_PHONE_DAY) return blocked('本日の応募回数の上限に達しました。お問い合わせ先へご連絡ください')

  const roles = await openRoles(db, page, { roleIds })
  // 選んだ日時の一部でも締め切られていたら、残りだけで応募を成立させず、選び直してもらう（#242）。
  // 画面は入力を保ったまま日時の一覧を取り直し、締め切られた日時を選択から外して知らせる（#515）
  const openIds = new Set(roles.map(r => r.slot_role_id))
  const closedIds = roleIds.filter(id => !openIds.has(id))
  if (closedIds.length) {
    return c.json({ error: roles.length ? `選んだ日時のうち${closedIds.length}件は募集が終了しました。選び直してから、もう一度送信してください` : '選んだ日時は募集が終了しました。ほかの日時を選んでください',
      closed_role_ids: closedIds, need_reselect: true, field: 'slots' }, 409)
  }
  // 同じ電話番号で同じ枠にすでに未対応（またはシフトが残っている承認済み）の応募がある場合は重複させない
  const dupRows = (await db.prepare(`SELECT i.slot_role_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE a.company_id = ? AND a.phone = ? AND ${ACTIVE_ITEM_SQL} AND i.slot_role_id IN ${JSON_IN}`)
    .bind(page.company_id, phone, bindJsonArray(roles.map(r => r.slot_role_id))).all()).results as any[]
  const dup = new Set(dupRows.map(r => r.slot_role_id))
  const targets = roles.filter(r => !dup.has(r.slot_role_id))
  // 完了画面の控え: 受け付けた日時と、応募済みのため除いた日時を分けて返す（#242 #317）
  const receipt = (list: any[]) => list.map(r => publicRole(r, false))
  const already = receipt(roles.filter(r => dup.has(r.slot_role_id)))
  const appliedAt = nowJST()
  if (!targets.length) return c.json({ ok: true, count: 0, message: '選択した日時はすでに応募済みです', accepted: [], already_applied: already, applied_at: appliedAt })

  const app = await db.prepare(`INSERT INTO recruit_applications (company_id, page_id, source, name, kana, phone, email, note, ip_hash, created_at, answers, turnstile_unverified)
    VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(page.company_id, page.page_id, name, kana || null, phone, email || null, note || null, ipHash, appliedAt,
    qa.answers.length ? JSON.stringify(qa.answers) : null, turnstileUnverified ? 1 : null).run()
  const appId = app.meta.last_row_id
  await db.batch(targets.map(r => db.prepare('INSERT OR IGNORE INTO recruit_application_items (application_id, slot_role_id) VALUES (?, ?)').bind(appId, r.slot_role_id)))
  // 管理者に新しい応募を知らせる（#150。失敗しても応募は受け付ける）
  await notifyRecruitApplied(c, { company_id: page.company_id, page_id: page.page_id, applicant: name, count: targets.length, source: 'public' })
  return c.json({ ok: true, count: targets.length, full_count: targets.filter(r => r.remaining <= 0).length, accepted: receipt(targets), already_applied: already, applied_at: appliedAt })
})
function addHourJST(h: number) { return new Date(Date.now() + (9 + h) * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }

// 送信回数の制限に使う接続元IPのハッシュ（#351）。塩は秘密の値（RATE_LIMIT_SALT、無ければ TURNSTILE_SECRET_KEY）を使う。
// どちらも無いときは、ソースから分かる固定の塩で全数を試すとIPに戻せてしまうため、ハッシュを4桁（65,536通り）に縮めて保存する
// （1つのハッシュに多数のIPが当たるので元のIPは特定できない。ページごと1時間の件数の制限には足りる）。管理画面で設定を促す
function ipSaltState(env: Bindings): 'set' | 'turnstile' | 'none' { return env.RATE_LIMIT_SALT ? 'set' : env.TURNSTILE_SECRET_KEY ? 'turnstile' : 'none' }
let warnedNoSalt = false
async function ipHashFor(env: Bindings, ip: string) {
  const secret = env.RATE_LIMIT_SALT || env.TURNSTILE_SECRET_KEY
  if (secret) return sha256(`recruit|${ip}|${secret}`)
  if (!warnedNoSalt) { warnedNoSalt = true; console.warn('RATE_LIMIT_SALT が未設定のため、応募の送信回数の制限は接続元IPの短いハッシュで行います（wrangler secret put RATE_LIMIT_SALT で設定してください）') }
  return 'w:' + (await sha256(`recruit|${ip}`)).slice(0, 4)
}

// =========================================================
// スタッフアプリ（登録済みスタッフの応募）
// =========================================================
export const recruitStaffApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()
// スタッフ（ログインできるスタッフ）のみ。管理者アカウントなどは応募できない。
// スタッフアプリの募集は止めている（#9411。STAFF_APP_RECRUIT=1 のときだけ動かす）。募集は公開ページからの応募と管理者の募集ページで扱う
recruitStaffApi.use('/*', async (c, next) => {
  const u = c.get('user')
  if (!u || u.role !== 'staff' || !u.staff_id) return c.json({ error: 'forbidden' }, 403)
  if (!staffAppRecruitEnabled(c.env)) return c.json({ error: 'スタッフアプリでは募集を扱っていません' }, 404)
  return next()
})

// 自分の応募とみなす範囲。アプリからの応募（a.staff_id = 自分）に加えて、登録済みのスタッフが公開URLから出した応募も、
// 電話番号（正規化済み）が自分と一致し、自社でその番号のスタッフが自分だけのときは本人の応募として扱う（#114）。
// 公開URLでは本人確認をしていないため staff_id は書き込まない（管理者が承認するときに紐づける）
async function myAppScope(db: D1Database, u: any): Promise<{ sql: string; bind: any[] }> {
  const base = { sql: 'a.company_id = ? AND a.staff_id = ?', bind: [u.company_id, u.staff_id] }
  const me = await db.prepare('SELECT us.phone FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(u.staff_id).first() as any
  const phone = normalizePhone(me?.phone)
  if (phone.length < 10) return base
  const has = await db.prepare(`SELECT 1 FROM recruit_applications WHERE company_id = ? AND staff_id IS NULL AND source = 'public' AND phone = ? LIMIT 1`).bind(u.company_id, phone).first()
  if (!has) return base
  const matches = await findStaffByPhone(db, u.company_id, phone)
  if (matches.length !== 1 || Number(matches[0].staff_id) !== Number(u.staff_id)) return base
  return { sql: `a.company_id = ? AND (a.staff_id = ? OR (a.staff_id IS NULL AND a.source = 'public' AND a.phone = ?))`, bind: [u.company_id, u.staff_id, phone] }
}
// 自分の応募の状態（未対応・シフトが残っている承認済みと、見送り）の枠と、割り当て済みの枠。
// 見送りの枠は一覧で『見送り』と出し、同じ枠に応募し直させない（#316。見送りの取り消しは管理者が行う）
async function myRoleStates(db: D1Database, u: any, scope: { sql: string; bind: any[] }) {
  const mine = ((await db.prepare(`SELECT i.slot_role_id, CASE WHEN i.status = 'processing' THEN 'pending' ELSE i.status END AS status
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE ${scope.sql} AND (${ACTIVE_ITEM_SQL} OR i.status = 'rejected')`).bind(...scope.bind).all()).results as any[])
  // 応募中・確定の状態を見送りより優先する
  const mineMap = new Map<number, string>()
  for (const r of mine) if (!mineMap.has(r.slot_role_id) || mineMap.get(r.slot_role_id) === 'rejected') mineMap.set(r.slot_role_id, r.status)
  const assigned = new Set(((await db.prepare(`SELECT slot_role_id FROM shifts WHERE staff_id = ? AND slot_role_id IS NOT NULL AND status != 'absent' AND work_date >= ?`)
    .bind(u.staff_id, todayJST()).all()).results as any[]).map(r => r.slot_role_id))
  return { mineMap, assigned, conflicts: new Map<number, string[]>() }
}
// 自分のほかのシフト（他社・連携先を含む。shift-board.ts の findConflicts）と時間が重なる枠（#310）。slot_role_id → 重なるシフトの表示
async function roleConflicts(db: D1Database, u: any, roles: any[]) {
  const out = new Map<number, string[]>()
  if (!roles.length) return out
  const dates = roles.map(r => r.work_date).sort()
  const from = dates[0], to = dates[dates.length - 1]
  const cf: any[] = [...((await findConflicts(db, u.company_id, [u.staff_id], from, to)).get(u.staff_id) || [])]
  // 連携していないほかの所属企業（同じ人物）のシフトも見る（本人のシフト一覧には出ている）
  const others = (await personStaffRows(db, u)).map(r => Number(r.staff_id)).filter(id => id && id !== Number(u.staff_id))
  if (others.length) {
    const rows = (await db.prepare(`SELECT shift_id, slot_role_id, staff_id, company_id, work_date, start_time, end_time, status FROM shifts
      WHERE staff_id IN ${JSON_IN} AND work_date BETWEEN ? AND ? AND status IN ('requested','confirmed','substitute')`)
      .bind(bindJsonArray(others), addDays(from, -1), addDays(to, 1)).all()).results as any[]
    for (const r of rows) if (!cf.some(x => x.shift_id === r.shift_id)) cf.push({ ...r, project_name: null })
  }
  if (!cf.length) return out
  for (const r of roles) {
    const list = conflictFor(cf, r.work_date, r.start_time, r.end_time).filter((x: any) => x.slot_role_id !== r.slot_role_id)
    if (list.length) out.set(r.slot_role_id, list.map((x: any) => conflictLabel(x, u.company_id)))
  }
  return out
}
// スタッフアプリでは、会場の住所（地図）と重なるシフトも返す（#310 #362。公開ページには住所を出さない）
function staffRole(r: any, p: any, st: { mineMap: Map<any, any>; assigned: Set<any>; conflicts: Map<number, string[]> }) {
  const my_status = st.assigned.has(r.slot_role_id) ? 'assigned' : st.mineMap.get(r.slot_role_id) || null
  return { ...publicRole(r, !!p.show_remaining), site_address: r.site_address || null, my_status, conflicts: my_status ? [] : st.conflicts.get(r.slot_role_id) || [] }
}

// スタッフアプリから応募できる公開中の募集ページ
const STAFF_PAGE_WHERE = `rp.company_id = ? AND rp.status = 'open' AND rp.allow_staff = 1 AND rp.date_to >= ?`
// 公開中の全ページの枠を1回で取り、ページごとに振り分ける（#410）。各ページは先頭から ROLES_PER_PAGE + 1 件まで（cutRolesPage で切る）
async function staffPagesRoles(db: D1Database, companyId: number) {
  const cte = pagesRolesCte(STAFF_PAGE_WHERE, [companyId, todayJST()])
  const rows = (await db.prepare(`${cte.sql}
    SELECT x.page_id, x.slot_role_id, x.role_name, x.headcount, x.slot_id, x.project_id, x.work_date, x.start_time, x.end_time, x.break_minutes,
      COALESCE(si.site_name, x.location, p.location, '') AS place, si.address AS site_address,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = x.slot_role_id AND s.status != 'absent') AS assigned
    FROM (SELECT pr.*, ROW_NUMBER() OVER (PARTITION BY pr.page_id ORDER BY pr.work_date, pr.start_time, pr.sort_order, pr.slot_role_id) AS rn FROM pr) x
    JOIN projects p ON p.project_id = x.project_id LEFT JOIN sites si ON si.site_id = x.site_id
    WHERE x.rn <= ? ORDER BY x.page_id, x.rn`).bind(...cte.bind, ROLES_PER_PAGE + 1).all()).results as any[]
  const map = new Map<number, any[]>()
  for (const r of rows) {
    const a = map.get(r.page_id) || []
    a.push({ ...r, remaining: Math.max(0, Number(r.headcount) - Number(r.assigned)) }); map.set(r.page_id, a)
  }
  return map
}
// 募集の入口に出す件数: 応募できる日時（定員に達していない・応募していない・見送りでない・自分のシフトでない）、承認待ち、表示する応募
async function staffRecruitCounts(db: D1Database, companyId: number, staffId: number, scope: { sql: string; bind: any[] }) {
  const cte = pagesRolesCte(STAFF_PAGE_WHERE, [companyId, todayJST()])
  const r = await db.prepare(`${cte.sql}
    SELECT (SELECT COUNT(*) FROM pg) AS pages,
      (SELECT COUNT(DISTINCT pr.slot_role_id) FROM pr WHERE pr.headcount > ${PR_ASSIGNED_SQL}
        AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.slot_role_id = pr.slot_role_id AND s.staff_id = ? AND s.status != 'absent')
        AND NOT EXISTS (SELECT 1 FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
          WHERE i.slot_role_id = pr.slot_role_id AND ${scope.sql} AND (${ACTIVE_ITEM_SQL} OR i.status = 'rejected'))) AS open`)
    .bind(...cte.bind, staffId, ...scope.bind).first() as any
  const today = todayJST()
  const a = await db.prepare(`SELECT COUNT(*) AS apps, SUM(CASE WHEN i.status IN ('pending','processing') AND sl.work_date >= ? THEN 1 ELSE 0 END) AS pending
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE ${scope.sql} AND sl.work_date >= ?`).bind(today, ...scope.bind, addDays(today, -7)).first() as any
  return { pages: Number(r?.pages || 0), open: Number(r?.open || 0), pending: Number(a?.pending || 0), applications: Number(a?.apps || 0) }
}
// 切り替えていない所属企業の募集（#364）。応募できる日時か承認待ちがある企業だけを返す（切り替えるとその企業の一覧を開ける）
async function otherCompaniesRecruit(db: D1Database, u: any) {
  const rows = (await personStaffRows(db, u)).filter(r => r.company_id !== u.company_id && r.staff_id)
  if (!rows.length) return []
  const cos = (await db.prepare(`SELECT company_id, active_status FROM companies WHERE company_id IN ${JSON_IN}`).bind(bindJsonArray(rows.map(r => r.company_id))).all()).results as any[]
  const active = new Set(cos.filter(x => isCompanyActive(x.active_status)).map(x => x.company_id))
  const out = []
  for (const r of rows) {
    if (!active.has(r.company_id)) continue
    const n = await staffRecruitCounts(db, r.company_id, r.staff_id, { sql: 'a.company_id = ? AND a.staff_id = ?', bind: [r.company_id, r.staff_id] })
    if (n.open || n.pending) out.push({ company_id: r.company_id, company_name: r.company_name, open: n.open, pending: n.pending })
  }
  return out
}

// 募集の入口（シフト画面のボタン）用の件数だけを返す（#410。枠の一覧は『募集中のお仕事』を開いたときに GET / で取る）
// pending_items: 今日以降の承認待ちの日時（シフト一覧に『承認待ち』として出すときに使う）
recruitStaffApi.get('/summary', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ pages: 0, open: 0, pending: 0, applications: 0, pending_items: [], other_companies: [] })
  const scope = await myAppScope(db, u)
  const n = await staffRecruitCounts(db, u.company_id, u.staff_id, scope)
  // counts=1: 件数だけ（ホームの『募集中のお仕事』のカード。#156）
  if (c.req.query('counts') === '1') return c.json(n)
  const pending = n.pending ? ((await db.prepare(`SELECT i.item_id, i.slot_role_id, a.page_id, rp.title AS page_title, sl.work_date, sl.start_time, sl.end_time, r.role_name,
      COALESCE(si.site_name, sl.location, p.location, '') AS place
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id LEFT JOIN sites si ON si.site_id = sl.site_id
    LEFT JOIN projects p ON p.project_id = sl.project_id LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id
    WHERE ${scope.sql} AND i.status IN ('pending','processing') AND sl.work_date >= ? ORDER BY sl.work_date, sl.start_time LIMIT 100`).bind(...scope.bind, todayJST()).all()).results as any[]) : []
  return c.json({ ...n, pending_items: pending, other_companies: await otherCompaniesRecruit(db, u) })
})

recruitStaffApi.get('/', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  if (!u.staff_id) return c.json({ pages: [], applications: [], other_companies: [] })
  await settleRemovedSlotItems(db, u.company_id)
  const pages = ((await db.prepare(`SELECT rp.* FROM recruit_pages rp WHERE ${STAFF_PAGE_WHERE} ORDER BY rp.date_from`)
    .bind(u.company_id, todayJST()).all()).results as any[])
  // 自分の応募状況と、自分のほかのシフトとの重なり
  const scope = await myAppScope(db, u)
  const st = await myRoleStates(db, u, scope)
  const rolesByPage = pages.length ? await staffPagesRoles(db, u.company_id) : new Map<number, any[]>()
  const cut = pages.map(p => ({ p, ...cutRolesPage(rolesByPage.get(p.page_id) || []) }))
  st.conflicts = await roleConflicts(db, u, cut.flatMap(x => x.roles))
  // questions: 募集ページの独自の質問（#300。スタッフアプリの応募でも同じ質問に答えてもらう）
  const out = cut.map(({ p, roles, next_from }) => ({ page_id: p.page_id, title: p.title, description: p.description || '', pay_note: p.pay_note || '', contact_note: p.contact_note || '',
    date_from: p.date_from, date_to: p.date_to, roles: roles.map(r => staffRole(r, p, st)), next_from,
    questions: parseQuestions(p.questions).map(q => ({ key: q.key, label: q.label, type: q.type, required: !!q.required, options: q.options || [] })) }))
  // 応募した日時。承認後にシフトが外れたものは released（シフト解除）で返す（#64）。
  // どの募集への応募かが分かるように募集名と問い合わせ先を付け、場所は募集中の枠と同じく案件の所在地まで補う（#513 #514）
  const apps = ((await db.prepare(`SELECT i.item_id, CASE WHEN i.status = 'processing' THEN 'pending' ELSE ${ITEM_STATE_SQL} END AS status, i.slot_role_id, a.application_id, a.page_id, a.source, a.created_at,
      sl.work_date, sl.start_time, sl.end_time, sl.break_minutes, r.role_name, COALESCE(si.site_name, sl.location, p.location, '') AS place,
      rp.title AS page_title, rp.contact_note
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id LEFT JOIN sites si ON si.site_id = sl.site_id
    LEFT JOIN projects p ON p.project_id = sl.project_id LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id
    WHERE ${scope.sql} AND sl.work_date >= ? ORDER BY sl.work_date, sl.start_time LIMIT 100`).bind(...scope.bind, addDays(todayJST(), -7)).all()).results as any[])
  return c.json({ pages: out, applications: apps, other_companies: await otherCompaniesRecruit(db, u) })
})

// 募集ページの続きの日時（next_from の日から。#126）
recruitStaffApi.get('/pages/:id/roles', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await db.prepare(`SELECT * FROM recruit_pages WHERE page_id = ? AND company_id = ? AND allow_staff = 1`).bind(c.req.param('id'), u.company_id).first() as any
  if (!pageIsOpen(p)) return c.json({ error: 'この募集は終了しました' }, 410)
  const st = await myRoleStates(db, u, await myAppScope(db, u))
  const { roles, next_from } = await openRolesPage(db, p, c.req.query('from'))
  st.conflicts = await roleConflicts(db, u, roles)
  return c.json({ roles: roles.map(r => staffRole(r, p, st)), next_from })
})

// 応募。複数の募集ページへの応募を1回で受け、すべて登録するか、どれも登録しないかにする（#239）。
// body: { pages: [{ page_id, slot_role_ids, answers? }], note?, force?, answers_supported? }（以前の形 { page_id, slot_role_ids } も受ける）
// - 選んだ日時が1件でも締め切られていたら、どれも登録せずに 409（closed_role_ids）を返す
// - 応募済み・確定・見送りの日時は登録しない（二度押しで同時に届いた分は、一意インデックスで止める。#270 #316）
// - 自分のほかのシフトと重なる日時があれば、force がない限り 409（need_force・conflicts）を返す（#310）
recruitStaffApi.post('/apply', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  if (!u.staff_id) return c.json({ error: 'スタッフ情報が見つかりません' }, 400)
  const reqs = new Map<number, number[]>()
  const answersIn = new Map<number, any>() // 募集ページごとの質問への回答（#300。{ q1: '…' } の形）
  for (const x of (Array.isArray(b.pages) ? b.pages : [{ page_id: b.page_id, slot_role_ids: b.slot_role_ids, answers: b.answers }])) {
    const pid = Number(x && x.page_id)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const ids = [...new Set([...(reqs.get(pid) || []), ...parseIds(x.slot_role_ids)])]
    if (ids.length) reqs.set(pid, ids)
    if (x.answers && !answersIn.has(pid)) answersIn.set(pid, x.answers)
  }
  if (!reqs.size) return c.json({ error: '希望する日時を選択してください' }, 400)
  if (reqs.size > MAX_PAGES_PER_STAFF_APPLY) return c.json({ error: `一度に応募できる募集は${MAX_PAGES_PER_STAFF_APPLY}件までです` }, 400)
  if ([...reqs.values()].some(ids => ids.length > MAX_SLOTS_PER_APPLY)) return c.json({ error: `1つの募集で一度に選べるのは${MAX_SLOTS_PER_APPLY}件までです` }, 400)
  const pageRows = (await db.prepare(`SELECT * FROM recruit_pages WHERE company_id = ? AND allow_staff = 1 AND page_id IN ${JSON_IN}`)
    .bind(u.company_id, bindJsonArray([...reqs.keys()])).all()).results as any[]
  const pmap = new Map(pageRows.map(p => [p.page_id, p]))
  const closedPages = [...reqs.keys()].filter(id => !pageIsOpen(pmap.get(id)))
  if (closedPages.length) {
    const names = closedPages.map(id => pmap.get(id)?.title).filter(Boolean).map(t => `「${t}」`).join('')
    return c.json({ error: `${names || '選んだ'}募集は終了しました。応募は送られていません。画面を読み直してください`, closed_page_ids: closedPages }, 410)
  }
  // 選んだ日時がまだ募集中か（1件でも締め切られていたら、どれも登録しない）
  const roles: any[] = []; const closedRoles: number[] = []
  for (const [pid, ids] of reqs) {
    const rs = await openRoles(db, pmap.get(pid), { roleIds: ids })
    const open = new Set(rs.map(r => r.slot_role_id))
    closedRoles.push(...ids.filter(id => !open.has(id)))
    roles.push(...rs.map(r => ({ ...r, page_id: pid })))
  }
  if (closedRoles.length) return c.json({ error: `選んだ日時のうち${closedRoles.length}件は募集が終了しました。応募は送られていません。選び直してください`, closed_role_ids: closedRoles }, 409)
  // 募集ページの独自の質問（#300）。必須の質問に答えていない募集があれば、どれも登録しない（公開ページと同じ readAnswers で確かめる）。
  // 質問の欄を出す前の画面（answers_supported を送らない）からの応募は、必須を確かめずに受ける（応募できなくならないように）
  const strict = b.answers_supported === true
  const answersBy = new Map<number, any[]>()
  for (const pid of reqs.keys()) {
    const qs = parseQuestions(pmap.get(pid)?.questions).map(q => strict ? q : { ...q, required: false })
    const qa = readAnswers(qs, answersIn.get(pid))
    if (qa.error) return c.json({ error: `「${pmap.get(pid)?.title || ''}」: ${qa.error}`, page_id: pid, field: qa.field }, 400)
    answersBy.set(pid, qa.answers)
  }
  // 応募済み（公開URLから出した自分の応募を含む）・見送り・割り当て済みの枠には重ねて応募しない。シフトが外れた承認済みの枠には応募し直せる（#64 #114 #316）
  const st = await myRoleStates(db, u, await myAppScope(db, u))
  const seen = new Set<number>()
  const targets = roles.filter(r => {
    if (seen.has(r.slot_role_id) || st.mineMap.has(r.slot_role_id) || st.assigned.has(r.slot_role_id)) return false
    seen.add(r.slot_role_id); return true
  })
  const rejectedCount = new Set(roles.filter(r => st.mineMap.get(r.slot_role_id) === 'rejected').map(r => r.slot_role_id)).size
  if (!targets.length) return c.json({ ok: true, count: 0, rejected_count: rejectedCount, message: rejectedCount ? '選んだ日時は見送りになっているため、応募できません' : '選択した日時はすでに応募済みです' })
  if (!b.force) {
    const cf = await roleConflicts(db, u, targets)
    const list = targets.filter(r => cf.has(r.slot_role_id)).map(r => ({ slot_role_id: r.slot_role_id, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time, conflicts: cf.get(r.slot_role_id) }))
    if (list.length) return c.json({ error: '同じ時間帯にほかのシフトがある日時が含まれています', need_force: true, conflicts: list }, 409)
  }
  const me = await db.prepare('SELECT us.name, us.phone, us.email, sp.kana FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(u.staff_id).first() as any
  const now = nowJST(), note = str(b.note, 500) || null
  const stmts: D1PreparedStatement[] = []
  const perPage: { page_id: number; count: number }[] = []
  for (const pid of reqs.keys()) {
    const ids = targets.filter(r => r.page_id === pid).map(r => r.slot_role_id)
    if (!ids.length) continue
    perPage.push({ page_id: pid, count: ids.length })
    const ans = answersBy.get(pid) || []
    stmts.push(db.prepare(`INSERT INTO recruit_applications (company_id, page_id, source, staff_id, name, kana, phone, email, note, created_at, answers)
      VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, pid, u.staff_id, me?.name || u.name, me?.kana || null, normalizePhone(me?.phone) || null, me?.email || null, note, now,
      ans.length ? JSON.stringify(ans) : null))
    // 直前に登録した応募（batch は1つのトランザクションで順に実行される）に明細を付ける
    stmts.push(db.prepare(`INSERT INTO recruit_application_items (application_id, slot_role_id, staff_id)
      SELECT (SELECT MAX(application_id) FROM recruit_applications WHERE company_id = ? AND page_id = ? AND staff_id = ? AND source = 'staff'), CAST(j.value AS INTEGER), ?
      FROM json_each(?) j`).bind(u.company_id, pid, u.staff_id, u.staff_id, bindJsonArray(ids)))
  }
  try {
    await db.batch(stmts)
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: '選んだ日時はすでに応募済みです。画面を読み直してください', duplicate: true }, 409)
    throw e
  }
  // 管理者に新しい応募を知らせる（#150。募集ページごと）
  for (const pp of perPage) await notifyRecruitApplied(c, { company_id: u.company_id, page_id: pp.page_id, applicant: me?.name || u.name, count: pp.count, source: 'staff' })
  // full_count: 定員に達していた日時（キャンセル待ちとして受け付けた件数。#315）
  return c.json({ ok: true, count: targets.length, full_count: targets.filter(r => r.remaining <= 0).length, rejected_count: rejectedCount, pages: perPage })
})

recruitStaffApi.post('/items/:id/cancel', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const scope = await myAppScope(db, u)
  const it = await db.prepare(`SELECT i.*, a.application_id AS aid, rp.contact_note FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id WHERE i.item_id = ? AND ${scope.sql}`).bind(c.req.param('id'), ...scope.bind).first() as any
  if (!it) return c.json({ error: '応募が見つかりません' }, 404)
  // 取り下げできないときは、募集の問い合わせ先を返す（#513）
  const denied = () => c.json({ error: '承認済み・対応済みの応募は取り下げできません。募集の問い合わせ先か管理者に連絡してください', contact_note: it.contact_note || '' }, 409)
  if (it.status !== 'pending') return denied()
  // 管理者が同時に承認しているとき（processing）は取り下げにしない
  const r = await db.prepare("UPDATE recruit_application_items SET status = 'cancelled', decided_at = ? WHERE item_id = ? AND status = 'pending'").bind(nowJST(), it.item_id).run()
  if (!r.meta.changes) return denied()
  await closeIfDone(db, it.aid)
  return c.json({ ok: true })
})

async function closeIfDone(db: D1Database, applicationId: number, byUserId?: number | null) {
  const left = await db.prepare("SELECT COUNT(*) AS n FROM recruit_application_items WHERE application_id = ? AND status IN ('pending','processing')").bind(applicationId).first() as any
  if (left?.n) return
  const all = await db.prepare("SELECT COUNT(*) AS t, SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS c FROM recruit_application_items WHERE application_id = ?").bind(applicationId).first() as any
  const status = all?.t && all.t === all.c ? 'cancelled' : 'done'
  await db.prepare('UPDATE recruit_applications SET status = ?, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?) WHERE application_id = ?')
    .bind(status, nowJST(), byUserId ?? null, applicationId).run()
}

// =========================================================
// 管理者
// =========================================================
export const recruitAdminApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function pageValues(b: any, cur: any = {}) {
  const v = {
    title: b.title !== undefined ? str(b.title, 80) : cur.title,
    description: b.description !== undefined ? str(b.description, 2000) || null : cur.description ?? null,
    pay_note: b.pay_note !== undefined ? str(b.pay_note, 200) || null : cur.pay_note ?? null,
    contact_note: b.contact_note !== undefined ? str(b.contact_note, 200) || null : cur.contact_note ?? null,
    project_ids: b.project_ids !== undefined ? parseIds(b.project_ids).join(',') : cur.project_ids,
    date_from: b.date_from !== undefined ? b.date_from : cur.date_from,
    date_to: b.date_to !== undefined ? b.date_to : cur.date_to,
    show_remaining: b.show_remaining !== undefined ? (b.show_remaining ? 1 : 0) : (cur.show_remaining ?? 1),
    allow_staff: b.allow_staff !== undefined ? (b.allow_staff ? 1 : 0) : (cur.allow_staff ?? 1),
    status: b.status === 'closed' || b.status === 'open' ? b.status : (cur.status || 'open'),
  }
  let error: string | null = null
  if (!v.title) error = '募集のタイトルを入力してください'
  else if (!v.project_ids) error = '対象の案件を選択してください'
  // 件数の上限は案件を送ってきたときだけ確認する（既存のページの終了・再開は妨げない）
  else if (b.project_ids !== undefined && parseIds(b.project_ids).length > MAX_PAGE_PROJECTS) error = `対象の案件は${MAX_PAGE_PROJECTS}件までです`
  else if (!isDate(v.date_from) || !isDate(v.date_to) || dayDiff(v.date_from, v.date_to) < 0) error = '期間を正しく入力してください'
  else if (dayDiff(v.date_from, v.date_to) > MAX_PAGE_DAYS - 1) error = `期間は${MAX_PAGE_DAYS}日以内で指定してください`
  return { v, error }
}
async function checkProjects(db: D1Database, companyId: number, ids: string) {
  const list = parseIds(ids)
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(companyId, bindJsonArray(list)).first() as any
  return n?.n === list.length
}

// ---------- 募集ページの画面で作る枠と、枠の人数の変更（#9421） ----------
// 行（日付・開始・終了・役割・募集人数）は、そのままシフトボードの募集枠（shift_slots）と役割（shift_slot_roles）になる。
// 同じ案件・日付・時刻の行は1つの枠の役割にまとめる。検証をすべて済ませてから、募集ページの保存と同じ batch で書く
const MAX_PAGE_SLOT_ROWS = 100 // 一度に追加できる行の数
const SLOT_HEADCOUNT_MAX = 200 // シフトボードの必要人数の上限と同じ
const SLOT_ROLE_NAME_MAX = 40
const PAGE_SLOT_LIST_LIMIT = 500 // 募集ページの画面に出す既存の枠（役割）の数
const slotDateLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
type SlotPlan = { error?: string; stmts: D1PreparedStatement[]; created: number; updated: number }
async function planPageSlots(db: D1Database, u: any, page: { project_ids: string; date_from: string; date_to: string }, b: any): Promise<SlotPlan> {
  const none: SlotPlan = { stmts: [], created: 0, updated: 0 }
  const fail = (error: string): SlotPlan => ({ ...none, error })
  const rows = b.new_slots == null ? [] : b.new_slots
  const hcs = b.slot_headcounts == null ? [] : b.slot_headcounts
  if (!Array.isArray(rows) || !Array.isArray(hcs)) return fail('枠の内容が正しくありません')
  if (!rows.length && !hcs.length) return none
  if (rows.length > MAX_PAGE_SLOT_ROWS) return fail(`一度に追加できる枠は${MAX_PAGE_SLOT_ROWS}行までです`)
  const pids = parseIds(page.project_ids)
  const today = todayJST()
  // ---- 追加する行 ----
  type SlotGroup = { project_id: number; work_date: string; start_time: string; end_time: string; roles: { role_name: string; headcount: number }[] }
  const groups = new Map<string, SlotGroup>()
  if (rows.length) {
    const projs = new Map(((await db.prepare(`SELECT project_id, project_name, COALESCE(status, 'active') AS status FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`)
      .bind(u.company_id, bindJsonArray(pids)).all()).results as any[]).map(p => [Number(p.project_id), p]))
    for (const [i, r] of rows.entries()) {
      const at = `${i + 1}行目の枠: `
      if (!r || typeof r !== 'object') return fail(at + '内容が正しくありません')
      // 対象の案件が1つなら、案件を省略できる
      const pid = pids.length === 1 && (r.project_id == null || r.project_id === '') ? pids[0] : Number(r.project_id)
      const proj = pids.includes(pid) ? projs.get(pid) : null
      if (!proj) return fail(at + '案件は、この募集ページの対象の案件から選んでください')
      if (proj.status !== 'active') return fail(at + `案件「${proj.project_name}」は終了しているため、枠を作れません`)
      if (!isISODate(r.work_date)) return fail(at + '日付を入力してください')
      if (r.work_date < page.date_from || r.work_date > page.date_to) return fail(at + '日付は募集の期間内にしてください')
      if (r.work_date < today) return fail(at + '過ぎた日には枠を作れません')
      if (!isHHMM(r.start_time) || !isHHMM(r.end_time)) return fail(at + '開始・終了の時刻を入力してください')
      if (r.start_time === r.end_time) return fail(at + '開始と終了が同じ時刻です')
      const role = String(r.role_name ?? '').normalize('NFKC').trim()
      if (!role) return fail(at + '役割を入力してください')
      if (role.length > SLOT_ROLE_NAME_MAX) return fail(at + `役割は${SLOT_ROLE_NAME_MAX}文字以内にしてください`)
      const n = toInt(r.headcount, 1, SLOT_HEADCOUNT_MAX)
      if (n === null) return fail(at + `募集人数は1〜${SLOT_HEADCOUNT_MAX}の整数で入力してください`)
      const key = [pid, r.work_date, r.start_time, r.end_time].join('|')
      const g: SlotGroup = groups.get(key) || { project_id: pid, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time, roles: [] }
      if (g.roles.some(x => x.role_name === role)) return fail(at + `同じ日時に役割「${role}」の行が2つあります。1行にまとめて人数を入れてください`)
      g.roles.push({ role_name: role, headcount: n })
      groups.set(key, g)
    }
  }
  // ---- 既存の枠の人数の変更（割り当て済みの人数より少なくはできない） ----
  const updates: { id: number; headcount: number }[] = []
  if (hcs.length) {
    const want = new Map<number, number>()
    for (const h of hcs) {
      const id = toInt(h && h.slot_role_id, 1)
      if (id === null) return fail('人数を変える枠が正しくありません')
      const n = toInt(h.headcount, 1, SLOT_HEADCOUNT_MAX)
      if (n === null) return fail(`募集人数は1〜${SLOT_HEADCOUNT_MAX}の整数で入力してください`)
      want.set(id, n)
    }
    if (want.size > PAGE_SLOT_LIST_LIMIT) return fail(`一度に人数を変えられる枠は${PAGE_SLOT_LIST_LIMIT}件までです`)
    const cur = (await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.project_id, sl.work_date, ${ASSIGNED_SQL} AS assigned
      FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id
      WHERE sl.company_id = ? AND r.slot_role_id IN ${JSON_IN}`).bind(u.company_id, bindJsonArray([...want.keys()])).all()).results as any[]
    if (cur.length !== want.size) return fail('人数を変える枠が見つかりません（シフトボードで削除された可能性があります。画面を開き直してください）')
    for (const r of cur) {
      const n = want.get(Number(r.slot_role_id))!
      if (!pids.includes(Number(r.project_id))) return fail('対象の案件から外した案件の枠の人数は変えられません')
      if (n < Number(r.assigned)) return fail(`${slotDateLabel(r.work_date)} の「${r.role_name}」は割り当て済みが${Number(r.assigned)}名のため、${Number(r.assigned)}名より少なくできません（シフトボードで割り当てを外してから変えてください）`)
      if (n !== Number(r.headcount)) updates.push({ id: Number(r.slot_role_id), headcount: n })
    }
  }
  const stmts: D1PreparedStatement[] = []
  let created = 0
  for (const g of groups.values()) {
    stmts.push(db.prepare(`INSERT INTO shift_slots (company_id, project_id, work_date, start_time, end_time, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, g.project_id, g.work_date, g.start_time, g.end_time, u.user_id))
    // batch は1つのトランザクションで順に動くので、直前に作った枠は最も新しい枠（slot_id は AUTOINCREMENT）になる。
    // 念のため会社も確かめ、違えば slot_id が NULL になって batch ごと失敗する
    for (const [i, r] of g.roles.entries()) {
      stmts.push(db.prepare(`INSERT INTO shift_slot_roles (slot_id, role_name, headcount, sort_order)
        VALUES ((SELECT slot_id FROM shift_slots WHERE slot_id = (SELECT MAX(slot_id) FROM shift_slots) AND company_id = ?), ?, ?, ?)`)
        .bind(u.company_id, r.role_name, r.headcount, i))
      created++
    }
  }
  for (const x of updates) {
    stmts.push(db.prepare(`UPDATE shift_slot_roles SET headcount = ? WHERE slot_role_id = ? AND slot_id IN (SELECT slot_id FROM shift_slots WHERE company_id = ?)`)
      .bind(x.headcount, x.id, u.company_id))
  }
  return { stmts, created, updated: updates.length }
}
const slotResult = (p: SlotPlan) => (p.created || p.updated ? { slots_created: p.created, headcounts_updated: p.updated } : {})

// 募集ページの画面に出す、対象の案件・期間の既存の枠（役割ごと）。人数をこの画面で直せるようにする（#9421）
recruitAdminApi.get('/recruit-slots', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const pids = parseIds(c.req.query('project_ids'))
  const from = c.req.query('from'), to = c.req.query('to')
  if (!pids.length) return c.json({ roles: [], truncated: false, today: todayJST() })
  if (!isISODate(from) || !isISODate(to) || to < from) return c.json({ error: '期間を正しく入力してください' }, 400)
  if (dayDiff(from, to) > MAX_PAGE_DAYS - 1) return c.json({ error: `期間は${MAX_PAGE_DAYS}日以内で指定してください` }, 400)
  if (pids.length > MAX_PAGE_PROJECTS) return c.json({ error: `対象の案件は${MAX_PAGE_PROJECTS}件までです` }, 400)
  const rows = (await db.prepare(`SELECT r.slot_role_id, r.slot_id, r.role_name, r.headcount, sl.project_id, p.project_name, sl.work_date, sl.start_time, sl.end_time,
      COALESCE(sl.status, 'open') AS slot_status, COALESCE(si.site_name, sl.location, p.location, '') AS place, ${ASSIGNED_SQL} AS assigned
    FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id JOIN projects p ON p.project_id = sl.project_id
    LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE sl.company_id = ? AND sl.project_id IN ${JSON_IN} AND sl.work_date BETWEEN ? AND ?
    ORDER BY sl.work_date, sl.start_time, sl.slot_id, r.sort_order, r.slot_role_id LIMIT ${PAGE_SLOT_LIST_LIMIT + 1}`)
    .bind(u.company_id, bindJsonArray(pids), from, to).all()).results as any[]
  return c.json({ roles: rows.slice(0, PAGE_SLOT_LIST_LIMIT), truncated: rows.length > PAGE_SLOT_LIST_LIMIT, today: todayJST() })
})

recruitAdminApi.get('/recruit-pages', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  // 応募の件数はページごとの副問い合わせにせず、会社の応募をページでまとめて数える（#410）
  const rows = ((await db.prepare(`SELECT rp.*, COALESCE(ac.pending_count, 0) AS pending_count, COALESCE(ac.application_count, 0) AS application_count
    FROM recruit_pages rp LEFT JOIN (
      SELECT page_id, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count, COUNT(*) AS application_count
      FROM recruit_applications WHERE company_id = ? AND page_id IS NOT NULL GROUP BY page_id
    ) ac ON ac.page_id = rp.page_id
    WHERE rp.company_id = ? ORDER BY rp.status = 'open' DESC, rp.date_from DESC, rp.page_id DESC LIMIT 200`).bind(u.company_id, u.company_id).all()).results as any[])
  const projects = ((await db.prepare('SELECT project_id, project_name FROM projects WHERE company_id = ?').bind(u.company_id).all()).results as any[])
  const pname = new Map(projects.map(p => [p.project_id, p.project_name]))
  const sums = rows.some(pageIsOpen) ? await openRolesSummaries(db, u.company_id) : new Map()
  const out = []
  for (const r of rows) {
    const sum = (pageIsOpen(r) && sums.get(r.page_id)) || { roles: 0, remaining: 0 }
    // expired: 期間の終了日を過ぎている（再開するには期間の延長が必要。#136）
    out.push({ ...r, questions: parseQuestions(r.questions), project_names: parseIds(r.project_ids).map(id => pname.get(id) || `#${id}`), open_roles: sum.roles,
      open_remaining: sum.remaining, is_open: pageIsOpen(r), expired: r.date_to < todayJST() })
  }
  const turnstile = turnstileState(c.env)
  // staff_app_recruit: スタッフアプリの募集が動いているか（#9411 で既定は止めている。止めているときは画面でアプリ向けの設定を出さない）
  return c.json({ pages: out, turnstile, turnstile_enabled: turnstile === 'enabled', staff_app_recruit: staffAppRecruitEnabled(c.env) })
})

recruitAdminApi.post('/recruit-pages', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const { v, error } = pageValues(b)
  if (error) return c.json({ error }, 400)
  if (v.date_to < todayJST()) return c.json({ error: '期間の終了日が過ぎています。今日以降の日付を指定してください' }, 400)
  const qs = normalizeQuestions(b.questions)
  if (qs.error) return c.json({ error: qs.error }, 400)
  if (!(await checkProjects(db, u.company_id, v.project_ids))) return c.json({ error: '案件が見つかりません' }, 404)
  // この画面で追加した枠（#9421）は、ページの作成と同じ batch で作る
  const slots = await planPageSlots(db, u, v, b)
  if (slots.error) return c.json({ error: slots.error }, 400)
  const token = randToken(18)
  const [r] = await db.batch([db.prepare(`INSERT INTO recruit_pages (company_id, token, title, description, pay_note, contact_note, project_ids, date_from, date_to, show_remaining, allow_staff, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`).bind(u.company_id, token, v.title, v.description, v.pay_note, v.contact_note, v.project_ids, v.date_from, v.date_to, v.show_remaining, v.allow_staff, u.user_id),
    ...slots.stmts])
  const pageId = Number(r.meta.last_row_id)
  await saveQuestions(db, pageId, qs.questions!)
  // スタッフアプリから応募できる募集は、スタッフに知らせる（#156。notify_staff: false で知らせない。notify_staff_email: true でメールも送る）
  const staffNotice = staffAppRecruitEnabled(c.env) && v.allow_staff && b.notify_staff !== false ? await notifyRecruitNew(c, u.company_id, pageId, { email: b.notify_staff_email === true }) : null
  return c.json({ ok: true, page_id: pageId, token, ...slotResult(slots), ...(staffNotice ? { staff_notified: staffNotice.notified, staff_emailed: staffNotice.emailed } : {}) })
})
// 独自の質問（#300）は、ページの作成・更新の後に別の文で保存する（質問を送らない更新では変えない）
async function saveQuestions(db: D1Database, pageId: number, questions: Question[]) {
  await db.prepare('UPDATE recruit_pages SET questions = ? WHERE page_id = ?').bind(questions.length ? JSON.stringify(questions) : null, pageId).run()
}
// 募集がスタッフアプリに出ている（公開中・アプリから応募できる・期間内）か
const visibleToStaff = (p: any) => p.status === 'open' && !!Number(p.allow_staff) && p.date_to >= todayJST()

recruitAdminApi.put('/recruit-pages/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const cur = await db.prepare('SELECT * FROM recruit_pages WHERE page_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '募集ページが見つかりません' }, 404)
  const { v, error } = pageValues(b, cur)
  if (error) return c.json({ error }, 400)
  // 期間を過ぎたまま再開しても公開されないため、終了日を延ばすよう求める（#136）
  if (b.status === 'open' && v.date_to < todayJST()) return c.json({ error: '期間の終了日が過ぎています。期間を延ばしてから再開してください', need_extend: true }, 400)
  const qs = b.questions !== undefined ? normalizeQuestions(b.questions, parseQuestions(cur.questions).map(q => q.key)) : null
  if (qs?.error) return c.json({ error: qs.error }, 400)
  if (!(await checkProjects(db, u.company_id, v.project_ids))) return c.json({ error: '案件が見つかりません' }, 404)
  // この画面で追加した枠と、直した人数（#9421）は、ページの更新と同じ batch で書く
  const slots = await planPageSlots(db, u, v, b)
  if (slots.error) return c.json({ error: slots.error }, 400)
  const token = b.regenerate_token ? randToken(18) : cur.token // URLを再発行すると、以前のURL・QRは使えなくなる
  await db.batch([db.prepare(`UPDATE recruit_pages SET title = ?, description = ?, pay_note = ?, contact_note = ?, project_ids = ?, date_from = ?, date_to = ?, show_remaining = ?, allow_staff = ?,
      status = ?, token = ?, closed_at = CASE WHEN ? = 'closed' AND status != 'closed' THEN ? WHEN ? = 'open' THEN NULL ELSE closed_at END WHERE page_id = ?`)
    .bind(v.title, v.description, v.pay_note, v.contact_note, v.project_ids, v.date_from, v.date_to, v.show_remaining, v.allow_staff, v.status, token, v.status, nowJST(), v.status, cur.page_id),
    ...slots.stmts])
  if (qs) await saveQuestions(db, cur.page_id, qs.questions!)
  // 再開・延長・アプリからの応募の許可で、スタッフアプリに出るようになったら知らせる（#156。同じ募集は1日1回まで）
  const staffNotice = staffAppRecruitEnabled(c.env) && !visibleToStaff(cur) && visibleToStaff(v) && b.notify_staff !== false
    ? await notifyRecruitNew(c, u.company_id, cur.page_id, { email: b.notify_staff_email === true }) : null
  return c.json({ ok: true, token, ...slotResult(slots), ...(staffNotice ? { staff_notified: staffNotice.notified, staff_emailed: staffNotice.emailed, staff_notice_skipped: !!staffNotice.skipped_recent } : {}) })
})

recruitAdminApi.delete('/recruit-pages/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const cur = await db.prepare('SELECT page_id FROM recruit_pages WHERE page_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '募集ページが見つかりません' }, 404)
  const n = await db.prepare('SELECT COUNT(*) AS n FROM recruit_applications WHERE page_id = ?').bind(cur.page_id).first() as any
  if (n?.n) return c.json({ error: '応募がある募集ページは削除できません。「募集を終了」を使ってください' }, 409)
  await db.prepare('DELETE FROM recruit_pages WHERE page_id = ?').bind(cur.page_id).run()
  return c.json({ ok: true })
})

// 応募の紐づけ先のスタッフが割り当てられない（退職・ログイン停止・統合済み）。recruit_applications a と staff_profiles sp・users us を LEFT JOIN して使う
const STAFF_INACTIVE_SQL = `(a.staff_id IS NOT NULL AND (COALESCE(sp.employment_status,'working') = 'retired' OR COALESCE(us.status,'active') != 'active' OR sp.merged_into_staff_id IS NOT NULL))`
const likeEsc = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m)
// 空白（全角を含む）を除いて比べる列の式
const squashSql = (col: string) => `REPLACE(REPLACE(COALESCE(${col},''),' ',''),'　','')`
const squash = (s: any) => String(s || '').normalize('NFKC').replace(/\s/g, '')

// 応募一覧（枠の情報・残り人数・重複の警告・電話番号が一致する登録済みスタッフ）
// 絞り込み: status（pending / done / cancelled / waitlist: 見送りにした勤務日前の日時がある / all）、page_id、slot_role_id（シフトボードの「応募n」から。#303）、
// q（氏名・フリガナ・電話番号）、from・to（勤務日）。offset で続きを取得する（#339）
recruitAdminApi.get('/recruit-applications', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await settleRemovedSlotItems(db, u.company_id)
  const status = c.req.query('status') || 'pending'
  const w = ['a.company_id = ?']; const bind: any[] = [u.company_id]
  if (['pending', 'done', 'cancelled'].includes(status)) { w.push('a.status = ?'); bind.push(status) }
  // キャンセル待ち: 見送りにした日時のうち、勤務日が今日以降のもの（繰り上げて承認できる。#211）
  if (status === 'waitlist') {
    w.push(`EXISTS (SELECT 1 FROM recruit_application_items wi JOIN shift_slot_roles wr ON wr.slot_role_id = wi.slot_role_id JOIN shift_slots ws ON ws.slot_id = wr.slot_id
      WHERE wi.application_id = a.application_id AND wi.status = 'rejected' AND ws.work_date >= ?)`); bind.push(todayJST())
  }
  if (c.req.query('page_id')) { w.push('a.page_id = ?'); bind.push(Number(c.req.query('page_id'))) }
  // 対応メモのない応募だけ（#478。だれも連絡していない応募を見つける）
  if (c.req.query('no_note') === '1') w.push('NOT EXISTS (SELECT 1 FROM recruit_application_notes nn WHERE nn.application_id = a.application_id)')
  // ロボット判定をできずに受け付けた応募だけ（#501。turnstile_unverified = 1 は一覧の各行にも入る）
  if (c.req.query('unverified') === '1') w.push('a.turnstile_unverified = 1')
  const slotRoleId = Number(c.req.query('slot_role_id')) || 0
  if (slotRoleId) { w.push('EXISTS (SELECT 1 FROM recruit_application_items fi WHERE fi.application_id = a.application_id AND fi.slot_role_id = ?)'); bind.push(slotRoleId) }
  const from = c.req.query('from'), to = c.req.query('to')
  if (isDate(from) || isDate(to)) {
    w.push(`EXISTS (SELECT 1 FROM recruit_application_items di JOIN shift_slot_roles dr ON dr.slot_role_id = di.slot_role_id JOIN shift_slots ds ON ds.slot_id = dr.slot_id
      WHERE di.application_id = a.application_id AND ds.work_date BETWEEN ? AND ?)`); bind.push(isDate(from) ? from : '0000-01-01', isDate(to) ? to : '9999-12-31')
  }
  // 氏名・フリガナ（空白は無視）・電話番号（数字だけで部分一致）で探す
  const q = str(c.req.query('q'), 60).normalize('NFKC')
  if (q) {
    const digits = q.replace(/[\s()\-‐－]/g, '')
    if (/^\+?\d{3,}$/.test(digits)) { w.push(`a.phone LIKE ? ESCAPE '\\'`); bind.push(`%${likeEsc(normalizePhone(digits))}%`) }
    else {
      const k = `%${likeEsc(squash(q))}%`
      w.push(`(${squashSql('a.name')} LIKE ? ESCAPE '\\' OR ${squashSql('a.kana')} LIKE ? ESCAPE '\\' OR ${squashSql('us.name')} LIKE ? ESCAPE '\\')`); bind.push(k, k, k)
    }
  }
  const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0))
  const FROM = `FROM recruit_applications a LEFT JOIN recruit_pages rp ON rp.page_id = a.page_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = a.staff_id LEFT JOIN users us ON us.user_id = sp.user_id WHERE ${w.join(' AND ')}`
  const total = Number(((await db.prepare(`SELECT COUNT(*) AS n ${FROM}`).bind(...bind).first()) as any)?.n || 0)
  const apps = ((await db.prepare(`SELECT a.*, rp.title AS page_title, us.name AS staff_name, sp.is_provisional, COALESCE(sp.affiliation_type,'own_employee') AS staff_affiliation_type,
      CASE WHEN ${STAFF_INACTIVE_SQL} THEN 1 ELSE 0 END AS staff_inactive, (SELECT du.name FROM users du WHERE du.user_id = a.decided_by) AS decided_by_name
    ${FROM} ORDER BY a.created_at ${status === 'pending' ? 'ASC' : 'DESC'}, a.application_id LIMIT ${MAX_APPLICATIONS_LIST} OFFSET ${offset}`).bind(...bind).all()).results as any[])
  const nextOffset = offset + apps.length < total ? offset + apps.length : null
  // 絞り込みの選択肢（募集ページ）と、枠で絞り込んだときの枠の情報（まとめて見送るボタンに使う）
  const pages = ((await db.prepare(`SELECT page_id, title, status FROM recruit_pages WHERE company_id = ? ORDER BY status = 'open' DESC, date_from DESC, page_id DESC LIMIT 200`).bind(u.company_id).all()).results as any[])
  const slot = slotRoleId ? await slotSummary(db, u.company_id, slotRoleId) : null
  const meta = { counts: await counts(db, u.company_id, true), total, offset, next_offset: nextOffset, truncated: nextOffset !== null, pages, slot, ip_salt: ipSaltState(c.env) }
  if (!apps.length) return c.json({ applications: [], ...meta })
  // 応募IDは json_each で1つにまとめてバインドする（D1 のバインド上限 100）
  // 枠が削除された日時（slot_removed）も出すため、枠・役割は LEFT JOIN にする（#65）。状態は承認後のシフトの有無で判定する（#64）
  const items = ((await db.prepare(`SELECT i.item_id, i.application_id, i.slot_role_id, i.shift_id, i.decided_at, ${ITEM_STATE_SQL} AS status,
      r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.work_date, sl.start_time, sl.end_time, p.project_name,
      COALESCE(si.site_name, sl.location, '') AS place,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = i.slot_role_id AND s.status != 'absent') AS assigned
    FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    LEFT JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id LEFT JOIN shift_slots sl ON sl.slot_id = r.slot_id
    LEFT JOIN projects p ON p.project_id = sl.project_id LEFT JOIN sites si ON si.site_id = sl.site_id
    WHERE i.application_id IN ${JSON_IN} ORDER BY sl.work_date IS NULL, sl.work_date, sl.start_time`).bind(bindJsonArray(apps.map(a => a.application_id))).all()).results as any[])
  // 登録済みスタッフの重複（同じ時間帯のシフト）
  const staffIds = [...new Set(apps.map(a => a.staff_id).filter(Boolean))] as number[]
  const dates = items.map(i => i.work_date).filter(Boolean).sort()
  const conflicts = staffIds.length && dates.length ? await findConflicts(db, u.company_id, staffIds, dates[0], dates[dates.length - 1]) : new Map()
  // 電話番号が一致するスタッフは、未登録の応募の分をまとめて1回で照合する（#309）
  const byPhone = await findStaffByPhones(db, u.company_id, apps.filter(a => !a.staff_id && a.phone).map(a => a.phone))
  const inactive = await inactiveStaffIds(db, [...byPhone.values()].flat().map(m => m.staff_id))
  const now = nowJST()
  const itemsByApp = new Map<number, any[]>()
  for (const i of items) itemsByApp.set(i.application_id, [...(itemsByApp.get(i.application_id) || []), i])
  const notesByApp = await loadAppNotes(db, apps.map(a => a.application_id), u.user_id)
  const out = apps.map(a => {
    const its = (itemsByApp.get(a.application_id) || []).map(i => ({
      ...i, remaining: Math.max(0, Number(i.headcount || 0) - Number(i.assigned || 0)), past: !!i.work_date && hasStarted(i, now),
      conflicts: a.staff_id && ['pending', 'rejected'].includes(i.status) && i.work_date ? conflictFor(conflicts.get(a.staff_id), i.work_date, i.start_time, i.end_time).map((x: any) => conflictLabel(x, u.company_id)) : [],
    }))
    const matches = !a.staff_id && a.phone ? (byPhone.get(normalizePhone(a.phone)) || []).map(m => ({ ...m, inactive: inactive.has(Number(m.staff_id)) })) : []
    return { ...a, ip_hash: undefined, items: its, phone_matches: matches, answers: parseAnswers(a.answers), notes: notesByApp.get(a.application_id) || [] }
  })
  return c.json({ applications: out, ...meta })
})

// ---------- 応募の対応メモ（#478）。電話済み・不在・面談予定などを、書いた人・日時と一緒に残して管理者どうしで共有する ----------
const MAX_NOTE_LEN = 500
const MAX_NOTES_PER_APP = 50
async function loadAppNotes(db: D1Database, appIds: number[], userId: number) {
  const map = new Map<number, any[]>()
  if (!appIds.length) return map
  const rows = (await db.prepare(`SELECT n.note_id, n.application_id, n.body, n.created_by, n.created_at, us.name AS author_name
    FROM recruit_application_notes n LEFT JOIN users us ON us.user_id = n.created_by
    WHERE n.application_id IN ${JSON_IN} ORDER BY n.note_id`).bind(bindJsonArray(appIds)).all()).results as any[]
  for (const r of rows) map.set(r.application_id, [...(map.get(r.application_id) || []), { ...r, mine: Number(r.created_by) === Number(userId) }])
  return map
}
recruitAdminApi.post('/recruit-applications/:id/notes', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const a = await db.prepare('SELECT application_id FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const body = str(b.body, MAX_NOTE_LEN)
  if (!body) return c.json({ error: 'メモを入力してください' }, 400)
  const n = await db.prepare('SELECT COUNT(*) AS n FROM recruit_application_notes WHERE application_id = ?').bind(a.application_id).first() as any
  if (Number(n?.n || 0) >= MAX_NOTES_PER_APP) return c.json({ error: `1件の応募に残せるメモは${MAX_NOTES_PER_APP}件までです` }, 409)
  await db.prepare('INSERT INTO recruit_application_notes (company_id, application_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(u.company_id, a.application_id, body, u.user_id, nowJST()).run()
  return c.json({ ok: true, notes: (await loadAppNotes(db, [a.application_id], u.user_id)).get(a.application_id) || [] })
})
// 自分が書いたメモだけ消せる（書き間違いの訂正用）
recruitAdminApi.delete('/recruit-applications/:id/notes/:noteId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const r = await db.prepare('DELETE FROM recruit_application_notes WHERE note_id = ? AND application_id = ? AND company_id = ? AND created_by = ?')
    .bind(c.req.param('noteId'), c.req.param('id'), u.company_id, u.user_id).run()
  if (!r.meta.changes) return c.json({ error: 'メモが見つかりません（消せるのは自分が書いたメモだけです）' }, 404)
  return c.json({ ok: true, notes: (await loadAppNotes(db, [Number(c.req.param('id'))], u.user_id)).get(Number(c.req.param('id'))) || [] })
})
// 枠の開始時刻を過ぎているか（日付だけでなく開始時刻で判定する。#190）
function hasStarted(i: { work_date: string; start_time: string; end_time: string }, now = nowJST()) {
  return shiftWindow(i.work_date, i.start_time, i.end_time).start <= now
}
// 退職・停止中（割り当てられない）のスタッフID（#87）
async function inactiveStaffIds(db: D1Database, ids: any[]) {
  const list = [...new Set(ids.map(Number).filter(Boolean))]
  if (!list.length) return new Set<number>()
  const rows = (await db.prepare(`SELECT sp.staff_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.staff_id IN ${JSON_IN} AND (COALESCE(sp.employment_status,'working') = 'retired' OR us.status != 'active')`).bind(bindJsonArray(list)).all()).results as any[]
  return new Set(rows.map(r => Number(r.staff_id)))
}
// 電話番号が一致するスタッフに、退職・停止・統合済み（割り当てられない）の印を付ける（#87）
async function withInactiveFlag(db: D1Database, matches: any[]) {
  if (!matches.length) return matches
  const inactive = await inactiveStaffIds(db, matches.map(m => m.staff_id))
  return matches.map(m => ({ ...m, inactive: inactive.has(Number(m.staff_id)) }))
}
// 未対応の件数（サイドメニューのバッジ）。退職・停止中のスタッフの応募は承認できず見送るだけなので数えない（#87。一覧には印を付けて出す）。
// 勤務日を過ぎた日時は settleRemovedSlotItems で期限切れにするため、ここには残らない（#302）
async function counts(db: D1Database, companyId: number, settled = false) {
  if (!settled) await settleRemovedSlotItems(db, companyId)
  const r = await db.prepare(`SELECT COUNT(*) AS pending, SUM(CASE WHEN a.source = 'public' THEN 1 ELSE 0 END) AS pending_public, SUM(CASE WHEN ${STAFF_INACTIVE_SQL} THEN 1 ELSE 0 END) AS inactive
    FROM recruit_applications a LEFT JOIN staff_profiles sp ON sp.staff_id = a.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    WHERE a.company_id = ? AND a.status = 'pending'`).bind(companyId).first() as any
  const inactive = Number(r?.inactive || 0)
  return { pending: Number(r?.pending || 0) - inactive, pending_public: Number(r?.pending_public || 0), pending_inactive: inactive }
}
recruitAdminApi.get('/recruit-applications/summary', async (c) => c.json(await counts(c.env.DB, c.get('user').company_id)))

// 枠（役割）の充足と、残っている未対応の応募の件数
async function slotSummary(db: D1Database, companyId: number, slotRoleId: number) {
  const r = await db.prepare(`SELECT r.slot_role_id, r.role_name, r.headcount, sl.work_date, sl.start_time, sl.end_time, p.project_name,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = r.slot_role_id AND s.status != 'absent') AS assigned,
      (SELECT COUNT(*) FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
        WHERE i.slot_role_id = r.slot_role_id AND i.status = 'pending' AND a.company_id = ?) AS pending
    FROM shift_slot_roles r JOIN shift_slots sl ON sl.slot_id = r.slot_id JOIN projects p ON p.project_id = sl.project_id
    WHERE r.slot_role_id = ? AND sl.company_id = ?`).bind(companyId, slotRoleId, companyId).first() as any
  if (!r) return null
  return { ...r, assigned: Number(r.assigned), headcount: Number(r.headcount), pending: Number(r.pending), full: Number(r.assigned) >= Number(r.headcount) }
}

// 枠（役割）に残っている未対応の応募をまとめて見送る（定員に達した枠の残り。#303）。承認の処理中（processing）の明細は対象にしない
recruitAdminApi.post('/recruit-slots/:id/reject-pending', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const slot = await slotSummary(db, u.company_id, Number(c.req.param('id')))
  if (!slot) return c.json({ error: '枠が見つかりません' }, 404)
  const rows = (await db.prepare(`SELECT i.item_id, i.application_id FROM recruit_application_items i JOIN recruit_applications a ON a.application_id = i.application_id
    WHERE i.slot_role_id = ? AND i.status = 'pending' AND a.company_id = ?`).bind(slot.slot_role_id, u.company_id).all()).results as any[]
  if (!rows.length) return c.json({ ok: true, rejected: 0 })
  const r = await db.prepare(`UPDATE recruit_application_items SET status = 'rejected', decided_at = ? WHERE status = 'pending' AND item_id IN ${JSON_IN}`)
    .bind(nowJST(), bindJsonArray(rows.map(x => x.item_id))).run()
  for (const id of new Set(rows.map(x => x.application_id as number))) await closeIfDone(db, id, u.user_id)
  // 見送った応募者に知らせる（#151。notify_applicant: false で知らせない）。人数が多くなり得るので、メールは応答の後に送る
  let notified = 0
  if (b.notify_applicant !== false) {
    const byApp = new Map<number, number[]>()
    for (const x of rows) byApp.set(x.application_id, [...(byApp.get(x.application_id) || []), x.item_id])
    const res = await notifyRecruitResults(c, u.company_id, [...byApp].map(([applicationId, rejected]) => ({ applicationId, approved: [], rejected })))
    for (const n of res.values()) if (n.app || n.email !== 'none') notified++
  }
  return c.json({ ok: true, rejected: Number(r.meta.changes || 0), applicants_notified: notified })
})

// 応募の結果のメールを送り直す（#151。メールが届かなかった・送らずに処理したとき）。承認・見送りにした日時をまとめて1通で送る
recruitAdminApi.post('/recruit-applications/:id/notify-result', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const a = await db.prepare('SELECT application_id FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const items = (await db.prepare(`SELECT item_id, status FROM recruit_application_items WHERE application_id = ? AND status IN ('approved', 'rejected')`).bind(a.application_id).all()).results as any[]
  if (!items.length) return c.json({ error: '承認・見送りにした日時がありません' }, 409)
  const r = await notifyRecruitResult(c, u.company_id, a.application_id, { approved: items.filter(i => i.status === 'approved').map(i => i.item_id), rejected: items.filter(i => i.status === 'rejected').map(i => i.item_id) }, { wait: true })
  if (!r.app && r.email === 'none') return c.json({ error: '応募者のメールアドレスがなく、アプリにもログインしていないため、知らせられません。電話などで連絡してください' }, 409)
  return c.json({ ok: true, applicant_notice: r })
})

// 未登録の応募者を紐づける既存スタッフの候補（#395）。電話番号が一致しなくても、氏名・フリガナ・スタッフ番号・電話番号で探せる。
// q を省くと、応募の電話番号・氏名・フリガナが一致するスタッフを返す。一致の強い順（電話番号 → 氏名 → フリガナ）に並べる
recruitAdminApi.get('/recruit-applications/:id/staff-candidates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const a = await db.prepare('SELECT application_id, name, kana, phone FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const q = str(c.req.query('q'), 60).normalize('NFKC')
  const cond: string[] = []; const bind: any[] = [u.company_id]
  if (q) {
    const k = `%${likeEsc(squash(q))}%`
    cond.push(`${squashSql('us.name')} LIKE ? ESCAPE '\\'`, `${squashSql('sp.kana')} LIKE ? ESCAPE '\\'`, `us.user_code LIKE ? ESCAPE '\\'`); bind.push(k, k, `%${likeEsc(q.trim())}%`)
  } else {
    if (squash(a.name)) { cond.push(`${squashSql('us.name')} = ?`); bind.push(squash(a.name)) }
    if (squash(a.kana)) { cond.push(`${squashSql('sp.kana')} = ?`); bind.push(squash(a.kana)) }
  }
  const rows = cond.length ? ((await db.prepare(`SELECT sp.staff_id, us.name, us.phone, us.user_code, sp.kana, sp.is_provisional, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND sp.merged_into_staff_id IS NULL AND (${cond.join(' OR ')}) ORDER BY us.name LIMIT 30`).bind(...bind).all()).results as any[]) : []
  // 電話番号（数字だけ）で探したときと、q を省いたときの応募の電話番号の一致
  const phoneQ = q && /^\+?[\d\s()\-‐－]{10,}$/.test(q) ? q : ''
  const byPhone = await findStaffByPhone(db, u.company_id, q ? phoneQ : (a.phone || ''))
  const seen = new Set(rows.map(r => r.staff_id))
  const all = [...byPhone.filter(m => !seen.has(m.staff_id)), ...rows]
  const inactive = await inactiveStaffIds(db, all.map(m => m.staff_id))
  const phone = normalizePhone(a.phone)
  // 他社連携の行は所属元の番号で照合し、番号を返さない（#123）ため、応募の番号で見つかった行は一致として扱う
  const phoneHit = new Set(q ? [] : byPhone.map(m => Number(m.staff_id)))
  const phoneMatch = (m: any) => phoneHit.has(Number(m.staff_id)) || (phone.length >= 10 && normalizePhone(m.phone) === phone)
  const nameMatch = (m: any) => !!squash(a.name) && squash(m.name) === squash(a.name)
  const kanaMatch = (m: any) => !!squash(a.kana) && squash(m.kana) === squash(a.kana)
  const score = (m: any) => (phoneMatch(m) ? 4 : 0) + (nameMatch(m) ? 2 : 0) + (kanaMatch(m) ? 1 : 0)
  const out = all.map(m => ({ staff_id: m.staff_id, name: m.name, phone: m.phone, user_code: m.user_code ?? null, kana: m.kana ?? null, is_provisional: m.is_provisional,
    inactive: inactive.has(Number(m.staff_id)), phone_match: phoneMatch(m), name_match: nameMatch(m) }))
    .sort((x, y) => score(y) - score(x)).slice(0, 30)
  return c.json({ candidates: out })
})

// 承認・見送り
// body: { approve: [item_id], reject: [item_id], staff_id?: 既存スタッフに紐づけ, new_staff_type?: 仮登録の区分, partner_affiliation_id?, force? }
// 確認をすべて済ませてから、対象の明細を「処理中」（processing）にして押さえ、仮登録・シフトを作る。
// 二度押しなどで同じ明細を同時に処理しようとしたときは、押さえられなかった側を 409 にする（#86）
recruitAdminApi.post('/recruit-applications/:id/decide', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const a = await db.prepare('SELECT * FROM recruit_applications WHERE application_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!a) return c.json({ error: '応募が見つかりません' }, 404)
  const approveIds = parseIds(b.approve), rejectIds = parseIds(b.reject)
  if (!approveIds.length && !rejectIds.length) return c.json({ error: '承認または見送りする日時を選択してください' }, 400)
  if (approveIds.some(id => rejectIds.includes(id))) return c.json({ error: '同じ日時を承認と見送りの両方に指定しています' }, 400)
  await settleRemovedSlotItems(db, u.company_id)
  const items = ((await db.prepare(`SELECT i.*, r.role_name, r.headcount, sl.slot_id, sl.project_id, sl.site_id, sl.location, sl.work_date, sl.start_time, sl.end_time, sl.break_minutes,
      (SELECT COUNT(*) FROM shifts s WHERE s.slot_role_id = i.slot_role_id AND s.status != 'absent') AS assigned
    FROM recruit_application_items i JOIN shift_slot_roles r ON r.slot_role_id = i.slot_role_id JOIN shift_slots sl ON sl.slot_id = r.slot_id
    WHERE i.application_id = ? AND sl.company_id = ?`).bind(a.application_id, u.company_id).all()).results as any[])
  const byId = new Map(items.map(i => [i.item_id, i]))
  const nowAt = nowJST()
  for (const id of [...approveIds, ...rejectIds]) {
    const it = byId.get(id)
    if (!it) return c.json({ error: '応募の日時が見つかりません（枠が削除された可能性があります。画面を読み直してください）' }, 404)
    // 見送りにした日時は、開始前なら繰り上げて承認できる（キャンセルが出たときなど。#211）。見送りに戻す操作はない
    const promotable = it.status === 'rejected' && approveIds.includes(id) && !hasStarted(it, nowAt)
    if (it.status !== 'pending' && !promotable) {
      return c.json({ error: it.status === 'rejected' && approveIds.includes(id) ? `${it.work_date} ${it.start_time} の枠は開始時刻を過ぎているため、繰り上げて承認できません` : `${it.work_date} ${it.start_time} の応募はすでに対応済みです` }, 409)
    }
  }
  const toApprove = approveIds.map(id => byId.get(id)!)

  // ---- スタッフの決定と確認（承認がある場合のみ。ここでは書き込まない）: 応募者のスタッフ / 指定した既存スタッフ / 仮登録の作成 ----
  let staffId: number | null = a.staff_id || null
  let newStaff: { type: string; affiliation: string | null; partnerId: number | null } | null = null
  if (toApprove.length && !staffId) {
    if (b.staff_id) {
      const st = await db.prepare(`SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?`).bind(b.staff_id, u.company_id).first() as any
      if (!st) return c.json({ error: 'スタッフが見つかりません' }, 404)
      staffId = st.staff_id
    } else {
      const type = NEW_STAFF_TYPES.includes(b.new_staff_type) ? b.new_staff_type : 'daily_worker'
      if (!b.force_new) {
        const matches = await withInactiveFlag(db, await findStaffByPhone(db, u.company_id, a.phone || ''))
        if (matches.length) return c.json({ error: 'この電話番号のスタッフが登録済みです。既存のスタッフに紐づけるか、別の人として仮登録してください', phone_matches: matches, need_staff: true }, 409)
      }
      let affiliation: string | null = null, partnerId: number | null = null
      const ownName = ((await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first())?.company_name as string) || ''
      if (type === 'own_employee' || type === 'daily_worker') affiliation = ownName
      if (type === 'freelance') affiliation = '個人事業主'
      if (type === 'partner_manual') {
        const p = b.partner_affiliation_id ? await db.prepare('SELECT affiliation_id, affiliation_name FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?').bind(b.partner_affiliation_id, u.company_id).first() as any : null
        if (!p) return c.json({ error: '協力会社を選択してください' }, 400)
        partnerId = p.affiliation_id; affiliation = p.affiliation_name
      }
      newStaff = { type, affiliation, partnerId }
    }
  }
  if (toApprove.length) {
    const warnings: string[] = []
    if (staffId) {
      // 退職・ログイン停止・統合済み・スキルシートのみなど、割り当てられないスタッフには承認しない（#87。割当の共通の確認を使う）
      const last = toApprove.reduce((m, i) => (i.work_date > m.work_date ? i : m), toApprove[0])
      const chk = await assertAssignable(db, { companyId: u.company_id, project: last.project_id, slot: null, staffId, workDate: last.work_date, start: last.start_time, end: last.end_time })
      if (chk.error) return c.json({ error: chk.error }, chk.status)
      if (chk.staff[0]?.employment_status === 'leave') warnings.push(`${chk.staff[0].name}: 休職中です`)
    }
    // 仮登録を作る場合も、作る前に定員・重複を確認する
    warnings.push(...await approvalWarnings(db, u.company_id, staffId, toApprove))
    if (warnings.length && !b.force) return c.json({ warnings, need_force: true }, 409)
  }

  // ---- 対象の明細を押さえる（ほかの操作で対応済み・処理中のものがあれば何もしない） ----
  // 繰り上げ（見送り → 承認）の明細は、見送りのままであることを条件に押さえ、失敗したときは見送りに戻す（#211）
  const allIds = [...approveIds, ...rejectIds]
  const from = (id: number) => byId.get(id)!
  let claimed: D1Result[]
  try {
    claimed = await db.batch(allIds.map(id => db.prepare("UPDATE recruit_application_items SET status = 'processing', decided_at = ? WHERE item_id = ? AND application_id = ? AND status = ?").bind(nowJST(), id, a.application_id, from(id).status)))
  } catch (e) {
    // 繰り上げる日時と同じ枠に、同じスタッフの未対応の応募（応募し直し）があると、未対応・処理中の一意インデックスに当たる（batch なので何も変わらない）
    if (!toApprove.some(i => i.status === 'rejected') || !/UNIQUE/i.test(String((e as any)?.message || e))) throw e
    return c.json({ error: '同じ日時に、このスタッフの未対応の応募がほかにあります。そちらの応募を承認してください' }, 409)
  }
  const mine = allIds.filter((_, k) => Number(claimed[k].meta.changes || 0) > 0)
  const release = async () => {
    if (mine.length) await db.batch(mine.map(id => db.prepare("UPDATE recruit_application_items SET status = ?, decided_at = ? WHERE item_id = ? AND status = 'processing'")
      .bind(from(id).status, from(id).status === 'pending' ? null : from(id).decided_at, id)))
  }
  if (mine.length !== allIds.length) {
    await release()
    return c.json({ error: 'この応募は、ほかの操作で対応中または対応済みです。画面を読み直してください' }, 409)
  }

  let createdStaff = false
  const now = nowJST(); const createdShifts: number[] = []
  try {
    if (toApprove.length && newStaff) {
      // 応募フォームのメールは本人確認をしていないため、ログイン・再設定の宛先（users.email）には入れず未確認のメールとして持つ（#38 #148）
      const created = await insertProvisionalStaff(db, u.company_id, u.user_id, { name: a.name, phone: a.phone || '', type: newStaff.type, affiliation: newStaff.affiliation, partnerId: newStaff.partnerId, kana: a.kana, unverified_email: a.email, memo: applicantMemo(a), note: '募集から仮登録' })
      staffId = created.staff_id; createdStaff = true
    }
    // シフトの作成（確定）
    const pdata = toApprove.length ? await loadPricingData(db, u.company_id, toApprove.map(i => i.project_id)) : null
    // 交通費はスタッフの標準（開催場所 → スタッフ。#564）。標準がなければ 0（仮登録で作った人には標準がない）
    const tdefs = toApprove.length && staffId && !createdStaff ? await loadTransportDefaults(db, u.company_id, [staffId]) : null
    for (const it of toApprove) {
      const already = await db.prepare("SELECT shift_id FROM shifts WHERE slot_role_id = ? AND staff_id = ? AND status != 'absent'").bind(it.slot_role_id, staffId).first() as any
      let shiftId = already?.shift_id
      if (!shiftId) {
        const res = await db.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo, slot_id, slot_role_id, site_id, break_minutes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`)
          .bind(u.company_id, staffId, it.project_id, it.work_date, it.start_time, it.end_time, it.location || '', it.role_name, transportDefaultFor(tdefs, staffId, it.site_id) ?? 0, u.user_id, '募集から承認', it.slot_id, it.slot_role_id, it.site_id ?? null, it.break_minutes ?? null).run()
        shiftId = res.meta.last_row_id
        await applyPricingToShift(db, u.company_id, shiftId, { data: pdata })
        createdShifts.push(shiftId)
      }
      await db.prepare("UPDATE recruit_application_items SET status = 'approved', shift_id = ?, decided_at = ? WHERE item_id = ? AND status = 'processing'").bind(shiftId, now, it.item_id).run()
    }
    for (const id of rejectIds) await db.prepare("UPDATE recruit_application_items SET status = 'rejected', decided_at = ? WHERE item_id = ? AND status = 'processing'").bind(now, id).run()
    if (staffId && !a.staff_id) await db.prepare('UPDATE recruit_applications SET staff_id = ? WHERE application_id = ? AND staff_id IS NULL').bind(staffId, a.application_id).run()
  } catch (e) {
    // 途中で失敗したときは、まだ承認・見送りにしていない明細を未対応に戻す（作ったシフト・仮登録は残るので、画面で確認する）
    await release()
    throw e
  }
  // 承認で作ったシフトの操作履歴（#159）。承認は済んでいるので、記録に失敗しても応募者への連絡などは続ける
  if (createdShifts.length) {
    try {
      const op = opLog(db, u, 'recruit_approve')
      await db.batch(logShifts(op, createdShifts, { created: true }))
      await finishLog(op)
    } catch (e) { console.error('recruit_approve operation log failed', e) }
  }
  await closeIfDone(db, a.application_id, u.user_id)
  // 承認で定員に達した枠に、ほかの人の未対応の応募が残っていれば知らせる（画面からまとめて見送れる。#303）
  const filled = []
  for (const rid of new Set(toApprove.map(i => i.slot_role_id as number))) {
    const s = await slotSummary(db, u.company_id, rid)
    if (s && s.full && s.pending) filled.push(s)
  }
  // 結果を応募者に知らせる（#151。notify_applicant: false で知らせない）。メールは送れたかを画面に出すため、送り終わるまで待つ
  const applicant = b.notify_applicant === false ? null : await notifyRecruitResult(c, u.company_id, a.application_id, { approved: approveIds, rejected: rejectIds }, { wait: true })
  return c.json({ ok: true, staff_id: staffId, created_staff: createdStaff, created_shifts: createdShifts.length, rejected: rejectIds.length,
    promoted: toApprove.filter(i => i.status === 'rejected').length, filled_slots: filled, ...(applicant ? { applicant_notice: applicant } : {}) })
})

async function approvalWarnings(db: D1Database, companyId: number, staffId: number | null, items: any[]) {
  const w: string[] = []
  const label = (i: any) => `${i.work_date.slice(5).replace('-', '/')} ${i.start_time}〜${i.end_time} ${i.role_name}`
  // 同じ枠を同時に承認する分も数える
  const plan = new Map<number, number>()
  const now = nowJST()
  for (const i of items) {
    const extra = (plan.get(i.slot_role_id) || 0) + 1; plan.set(i.slot_role_id, extra)
    if (Number(i.assigned) + extra > Number(i.headcount)) w.push(`${label(i)}: 定員（${i.headcount}名）を超えます`)
    if (hasStarted(i, now)) w.push(`${label(i)}: ${i.work_date < now.slice(0, 10) ? '過去の日付です' : '開始時刻を過ぎています'}`)
  }
  // 同時に承認する日時どうしの重複（同じ人を同じ時間帯の別の役割に入れる）
  for (let x = 0; x < items.length; x++) for (let y = x + 1; y < items.length; y++) {
    const A = items[x], B = items[y]
    if (A.work_date === B.work_date && A.start_time < B.end_time && B.start_time < A.end_time) w.push(`${label(A)} と ${label(B)}: 同じ時間帯です`)
  }
  if (staffId && items.length) {
    const dates = items.map(i => i.work_date).sort()
    const cf = await findConflicts(db, companyId, [staffId], dates[0], dates[dates.length - 1])
    for (const i of items) {
      const list = conflictFor(cf.get(staffId), i.work_date, i.start_time, i.end_time).filter((x: any) => x.slot_role_id !== i.slot_role_id)
      if (list.length) w.push(`${label(i)}: 同じ時間帯に別のシフトがあります（${list.map((x: any) => conflictLabel(x, companyId)).join('、')}）`)
    }
    const projects = [...new Set(items.map(i => i.project_id))]
    for (const pid of projects) if ((await ngStaffIds(db, pid)).includes(staffId)) w.push(`クライアントのNGスタッフに指定されています（${items.find(i => i.project_id === pid)!.work_date}〜）`)
  }
  return w
}

// 個人情報の保存期間: 公開ページからの応募で、スタッフに紐づかず対応が終わったもの（または放置されたもの）は180日で削除する（Cron）
export async function purgeOldApplications(db: D1Database) {
  const cutoff = addDays(todayJST(), -RETENTION_DAYS) + ' 00:00:00'
  const olds = ((await db.prepare(`SELECT application_id FROM recruit_applications WHERE staff_id IS NULL AND created_at < ? LIMIT 500`).bind(cutoff).all()).results as any[]).map(r => r.application_id)
  for (let i = 0; i < olds.length; i += 90) {
    const chunk = olds.slice(i, i + 90); const q = chunk.map(() => '?').join(',')
    await db.batch([
      db.prepare(`DELETE FROM recruit_application_items WHERE application_id IN (${q})`).bind(...chunk),
      db.prepare(`DELETE FROM recruit_application_notes WHERE application_id IN (${q})`).bind(...chunk),
      db.prepare(`DELETE FROM recruit_applications WHERE application_id IN (${q})`).bind(...chunk),
    ])
  }
  // 送信回数の制限用のハッシュは7日で消す
  await db.prepare('UPDATE recruit_applications SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?').bind(addDays(todayJST(), -7) + ' 00:00:00').run()
  return olds.length
}
