// =========================================================
// 案件掲示板 第1段階: 掲載・一覧・詳細（docs/spec_board.md）
// - /api/admin/board/* 配下のみ（/admin/* の ADMIN_ROLES ミドルウェアの後に登録）。スタッフ本人には公開しない
// - 掲載企業名は公開。公開範囲は全利用企業。単価は必須（備考で「応相談」等を付けられる）
// - 他社に返すのは掲載内容と掲載企業名のみ（コピー元の自社案件・作成者などの社内情報は返さない）
// =========================================================
import { Hono } from 'hono'
import { loadRoster, createPerson, unusablePasswordHash } from './roster'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { isCompanyActive } from './lib/auth'
import { isISODate } from './lib/validate'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const boardApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

export const ENGAGEMENT_TYPES = ['regular', 'spot'] as const
export const PRICE_UNITS = ['hourly', 'daily', 'monthly'] as const
export const POST_STATUSES = ['draft', 'open', 'closed', 'filled'] as const
const MAX_LIST = 200

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const isTime = (s: any) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
const str = (v: any, max: number) => String(v ?? '').trim().slice(0, max)

// 締切日を過ぎた掲載と、実施日（終了日があれば終了日）を過ぎたスポット・終了予定日を過ぎた常勤の掲載を「締切」にする
// （cron を使わない遅延処理。一覧・詳細・編集・問い合わせ・提案のときに実行。#88）。やり取り中の企業にも知らせる（#476）
const EXPIRED_SQL = `status = 'open' AND ((deadline IS NOT NULL AND deadline < ?)
  OR COALESCE(date_to, CASE WHEN engagement_type = 'spot' THEN date_from END) < ?)`
async function closeExpired(db: D1Database) {
  const today = todayJST(); const now = nowJST()
  // 件数に関係なく決まった数の文で処理する（期限切れが溜まっていても、1回の呼び出しのクエリ数が増えないように）。
  // batch は1つのトランザクションなので、同時に開かれても知らせるのは締切にした1回だけ
  await db.batch([
    ...threadNoticeStmts(db, `SELECT post_id FROM board_posts WHERE ${EXPIRED_SQL}`, [today, today],
      '締切日（実施日）を過ぎたため、この掲載は締切になりました。新しい人材の提案は受け付けていません', now),
    db.prepare(`UPDATE board_posts SET status = 'closed', updated_at = ? WHERE ${EXPIRED_SQL}`).bind(now, today, today),
  ])
}

/** postsSql（post_id を返す SELECT）の掲載のやり取り（終了していないもの）すべてに、相手企業の未読に数えるシステムメッセージを入れる文（#476）。
 *  書き手は掲載企業。システムメッセージなので既読位置は動かさない（addMessage と同じ扱い） */
function threadNoticeStmts(db: D1Database, postsSql: string, binds: any[], body: string, now: string): D1PreparedStatement[] {
  const target = `status = 'open' AND post_id IN (${postsSql})`
  return [
    db.prepare(`INSERT INTO board_messages (thread_id, author_company_id, author_user_id, kind, body, notify, created_at)
      SELECT thread_id, poster_company_id, NULL, 'system', ?, 1, ? FROM board_threads WHERE ${target}`).bind(body, now, ...binds),
    db.prepare(`UPDATE board_threads SET last_message_id = (SELECT MAX(m.message_id) FROM board_messages m WHERE m.thread_id = board_threads.thread_id), last_message_at = ?
      WHERE ${target}`).bind(now, ...binds),
  ]
}

// 他社にも返してよい項目（社内情報 source_project_id / created_by / updated_by は自社のときだけ付ける）
const PUBLIC_COLS = `bp.post_id, bp.company_id, bp.engagement_type, bp.title, bp.description, bp.prefecture, bp.area, bp.nearest_station,
  bp.date_from, bp.date_to, bp.time_from, bp.time_to, bp.schedule_note, bp.headcount, bp.required_skills,
  bp.price_amount, bp.price_unit, bp.price_note, bp.deadline, bp.status, bp.published_at, bp.created_at, bp.updated_at,
  co.company_name`
function shape(row: any, companyId: number) {
  const mine = row.company_id === companyId
  const out: any = { ...row, is_mine: mine }
  if (!mine) { delete out.source_project_id; delete out.created_by; delete out.updated_by; delete out.source_project_name }
  return out
}

/** 入力の検証・正規化。publish=true のときは掲載に必要な項目をすべて求める */
function validatePost(b: any, publish: boolean): { v?: any; error?: string } {
  const v: any = {
    engagement_type: b.engagement_type,
    title: str(b.title, 100),
    description: str(b.description, 4000),
    prefecture: str(b.prefecture, 10),
    area: str(b.area, 100),
    nearest_station: str(b.nearest_station, 100),
    date_from: b.date_from || null, date_to: b.date_to || null,
    time_from: b.time_from || null, time_to: b.time_to || null,
    schedule_note: str(b.schedule_note, 200),
    headcount: Number(b.headcount ?? 1),
    required_skills: String(b.required_skills ?? '').split(/[,、，]/).map(s => s.trim()).filter(Boolean).slice(0, 30).join(','),
    price_amount: b.price_amount === '' || b.price_amount == null ? null : Number(b.price_amount),
    price_unit: b.price_unit,
    price_note: str(b.price_note, 100),
    deadline: b.deadline || null,
    source_project_id: b.source_project_id ? Number(b.source_project_id) : null,
  }
  if (!ENGAGEMENT_TYPES.includes(v.engagement_type)) return { error: '常勤・スポットを選択してください' }
  if (!v.title) return { error: '案件名を入力してください' }
  if (!PRICE_UNITS.includes(v.price_unit)) return { error: '単価の単位（時給・日給・月給）を選択してください' }
  if (v.price_amount == null || !Number.isInteger(v.price_amount) || v.price_amount <= 0 || v.price_amount > 10000000) return { error: '単価は1円以上の整数で入力してください（応相談などは「単価の備考」に記入してください）' }
  if (!Number.isInteger(v.headcount) || v.headcount < 1 || v.headcount > 999) return { error: '募集人数は1〜999で入力してください' }
  for (const k of ['date_from', 'date_to', 'deadline']) if (v[k] && !isDate(v[k])) return { error: '日付の形式が正しくありません' }
  for (const k of ['time_from', 'time_to']) if (v[k] && !isTime(v[k])) return { error: '時刻の形式が正しくありません' }
  if (v.date_from && v.date_to && v.date_from > v.date_to) return { error: '終了日が開始日より前になっています' }
  if (publish) {
    if (!v.prefecture && !v.area) return { error: '掲載するには勤務地（都道府県またはエリア）を入力してください' }
    if (!v.date_from) return { error: v.engagement_type === 'spot' ? '掲載するには実施日を入力してください' : '掲載するには開始日を入力してください' }
    if (v.engagement_type === 'spot' && (!v.time_from || !v.time_to)) return { error: 'スポットの掲載には時間帯（開始・終了）を入力してください' }
    if (v.deadline && v.deadline < todayJST()) return { error: '締切日が過去の日付です' }
    // 実施日（終了日があれば終了日）・終了予定日が過去の掲載は出さない（#88）
    if (v.engagement_type === 'spot' && (v.date_to || v.date_from) < todayJST()) return { error: v.date_to ? '実施日（終了）が過去の日付です' : '実施日が過去の日付です' }
    if (v.engagement_type === 'regular' && v.date_to && v.date_to < todayJST()) return { error: '終了予定日が過去の日付です' }
  }
  return { v }
}

// 掲載企業が利用中か（本部で停止にした企業は false。#66）
async function posterActive(db: D1Database, companyId: number): Promise<boolean> {
  const co = await db.prepare('SELECT active_status FROM companies WHERE company_id = ?').bind(companyId).first() as any
  return !!co && isCompanyActive(co.active_status)
}

/** 掲載ごとの採用人数（採用にした提案の数。#304） */
async function adoptedCounts(db: D1Database, postIds: number[]): Promise<Record<number, number>> {
  if (!postIds.length) return {}
  const rows = (await db.prepare(`SELECT post_id, COUNT(*) AS n FROM board_proposals WHERE post_id IN ${JSON_IN} AND status = 'adopted' GROUP BY post_id`)
    .bind(bindJsonArray(postIds)).all()).results as any[]
  return Object.fromEntries(rows.map(x => [x.post_id, x.n]))
}

// ---------- 一覧 ----------
// scope: open（全企業の掲載中）/ mine（自社の掲載すべて）
boardApi.get('/posts', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await closeExpired(db)
  const q = c.req.query()
  const scope = q.scope === 'mine' ? 'mine' : 'open'
  const w: string[] = []; const bind: any[] = []
  if (scope === 'mine') { w.push('bp.company_id = ?'); bind.push(u.company_id) }
  // 本部で停止にした企業の掲載は、他社の一覧に出さない（#66）
  else w.push(`bp.status = 'open' AND COALESCE(co.active_status, 'active') != 'inactive'`)
  if (ENGAGEMENT_TYPES.includes(q.engagement_type as any)) { w.push('bp.engagement_type = ?'); bind.push(q.engagement_type) }
  if (q.prefecture) { w.push('bp.prefecture = ?'); bind.push(q.prefecture) }
  if (q.area) { w.push('(bp.area LIKE ? OR bp.nearest_station LIKE ?)'); bind.push(`%${q.area}%`, `%${q.area}%`) }
  // 稼働日: その日を含む掲載。スポットで終了日が空なら実施日当日のみ、常勤で終了日が空なら長期（開始日以降すべて）
  if (isDate(q.date)) {
    w.push(`(bp.date_from IS NULL OR bp.date_from <= ?) AND (CASE WHEN bp.date_to IS NOT NULL THEN bp.date_to >= ? WHEN bp.engagement_type = 'spot' THEN bp.date_from >= ? ELSE 1 END)`)
    bind.push(q.date, q.date, q.date)
  }
  if (q.skill) { w.push(`(',' || COALESCE(bp.required_skills,'') || ',') LIKE ?`); bind.push(`%,${q.skill.trim()},%`) }
  if (q.q) {
    const kw = `%${String(q.q).trim()}%`
    w.push('(bp.title LIKE ? OR bp.description LIKE ? OR co.company_name LIKE ? OR bp.required_skills LIKE ?)'); bind.push(kw, kw, kw, kw)
  }
  if (q.hide_mine === '1' && scope === 'open') { w.push('bp.company_id != ?'); bind.push(u.company_id) }
  const rows = (await db.prepare(`SELECT ${PUBLIC_COLS}, bp.source_project_id
    FROM board_posts bp JOIN companies co ON co.company_id = bp.company_id
    WHERE ${w.join(' AND ')}
    ORDER BY ${scope === 'mine' ? "CASE bp.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, bp.updated_at DESC" : 'bp.published_at DESC, bp.post_id DESC'}
    LIMIT ${MAX_LIST}`).bind(...bind).all()).results as any[]
  const counts = (await db.prepare(`SELECT engagement_type, COUNT(*) AS n FROM board_posts WHERE status = 'open'
    AND company_id NOT IN (SELECT company_id FROM companies WHERE active_status = 'inactive') GROUP BY engagement_type`).all()).results as any[]
  // 一覧にやり取りの有無・未読を付ける（自社が参加しているスレッドのみ）
  const ids = rows.map(r => r.post_id)
  const tmap: Record<number, { threads: number; unread: number }> = {}
  if (ids.length) {
    const ts = (await db.prepare(`SELECT t.post_id, COUNT(*) AS threads, SUM(${UNREAD_SQL}) AS unread FROM board_threads t
      WHERE t.post_id IN ${JSON_IN} AND (t.poster_company_id = ? OR t.inquirer_company_id = ?) GROUP BY t.post_id`)
      .bind(...unreadBinds(u), bindJsonArray(ids), u.company_id, u.company_id).all()).results as any[]
    for (const x of ts) tmap[x.post_id] = { threads: x.threads, unread: x.unread || 0 }
  }
  // 自社の掲載には採用人数を付ける（#304）
  const adopted = scope === 'mine' ? await adoptedCounts(db, ids) : {}
  return c.json({ posts: rows.map(r => ({ ...shape(r, u.company_id), thread_count: tmap[r.post_id]?.threads || 0, unread: tmap[r.post_id]?.unread || 0,
    ...(r.company_id === u.company_id ? { adopted_count: adopted[r.post_id] || 0 } : {}) })), open_counts: Object.fromEntries(counts.map(x => [x.engagement_type, x.n])) })
})

// ---------- 詳細 ----------
boardApi.get('/posts/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await closeExpired(db)
  const row = await db.prepare(`SELECT ${PUBLIC_COLS}, bp.source_project_id, pr.project_name AS source_project_name
    FROM board_posts bp JOIN companies co ON co.company_id = bp.company_id
    LEFT JOIN projects pr ON pr.project_id = bp.source_project_id AND pr.company_id = bp.company_id
    WHERE bp.post_id = ?`).bind(c.req.param('id')).first() as any
  // 他社の下書きは存在自体を返さない
  if (!row || (row.company_id !== u.company_id && row.status === 'draft')) return c.json({ error: '掲載が見つかりません' }, 404)
  // 本部で停止にした企業の掲載は、他社には見せない（#66）
  if (row.company_id !== u.company_id && !(await posterActive(db, row.company_id))) return c.json({ error: '掲載が見つかりません' }, 404)
  const post = shape(row, u.company_id)
  if (post.is_mine) {
    // 掲載企業: 問い合わせ件数と未読
    const r = await db.prepare(`SELECT COUNT(*) AS n, SUM(${UNREAD_SQL}) AS unread FROM board_threads t WHERE t.post_id = ?`).bind(...unreadBinds(u), row.post_id).first() as any
    post.thread_count = r?.n || 0; post.unread = r?.unread || 0
    post.adopted_count = (await adoptedCounts(db, [row.post_id]))[row.post_id] || 0
  } else {
    // 問い合わせ企業: 自社のスレッド
    const t = await db.prepare(`SELECT t.thread_id, t.status, ${UNREAD_SQL} AS unread FROM board_threads t WHERE t.post_id = ? AND t.inquirer_company_id = ?`)
      .bind(...unreadBinds(u), row.post_id, u.company_id).first() as any
    post.my_thread = t || null
  }
  return c.json({ post })
})

// ---------- 自社案件からのコピー用 ----------
boardApi.get('/project-template/:projectId', async (c) => {
  const u = c.get('user')
  const p = await c.env.DB.prepare(`SELECT project_id, project_name, COALESCE(engagement_type,'regular') AS engagement_type, location, required_skills, requirements,
      pay_rate, pay_unit_type FROM projects WHERE project_id = ? AND company_id = ?`).bind(c.req.param('projectId'), u.company_id).first() as any
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  // 掲示板に出す単価は「支払単価（pay_rate）」とその単位（pay_unit_type）。請求単価・請求の単位は使わない（#540）。
  // 支払単価が未設定、または単位が時給・日給・月給以外なら、単価・単位とも空にして掲載する人に選ばせる
  const unit = (PRICE_UNITS as readonly string[]).includes(p.pay_unit_type || 'daily') ? (p.pay_unit_type || 'daily') : ''
  const hasPay = p.pay_rate != null && Number(p.pay_rate) > 0 && !!unit
  return c.json({ template: {
    engagement_type: p.engagement_type, title: p.project_name, area: p.location || '', required_skills: p.required_skills || '',
    description: p.requirements || '', price_amount: hasPay ? p.pay_rate : '', price_unit: hasPay ? unit : '', source_project_id: p.project_id,
  } })
})

// ---------- 作成・更新 ----------
boardApi.post('/posts', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const publish = b.status === 'open'
  const { v, error } = validatePost(b, publish)
  if (error) return c.json({ error }, 400)
  if (v.source_project_id) {
    const own = await db.prepare('SELECT 1 FROM projects WHERE project_id = ? AND company_id = ?').bind(v.source_project_id, u.company_id).first()
    if (!own) v.source_project_id = null
  }
  const now = nowJST()
  const r = await db.prepare(`INSERT INTO board_posts (company_id, engagement_type, title, description, prefecture, area, nearest_station,
      date_from, date_to, time_from, time_to, schedule_note, headcount, required_skills, price_amount, price_unit, price_note, deadline,
      status, source_project_id, published_at, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, v.engagement_type, v.title, v.description, v.prefecture, v.area, v.nearest_station,
      v.date_from, v.date_to, v.time_from, v.time_to, v.schedule_note, v.headcount, v.required_skills, v.price_amount, v.price_unit, v.price_note, v.deadline,
      publish ? 'open' : 'draft', v.source_project_id, publish ? now : null, u.user_id, u.user_id, now, now).run()
  return c.json({ ok: true, post_id: r.meta.last_row_id })
})

boardApi.put('/posts/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await closeExpired(db)
  const cur = await db.prepare('SELECT * FROM board_posts WHERE post_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '自社の掲載のみ編集できます' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  // status を送らなければ今の状態のまま保存する。締切・充足の掲載を掲載中に戻すのは、republish を付けたときだけ（#125）
  const nextStatus = POST_STATUSES.includes(b.status) ? b.status : cur.status
  if ((cur.status === 'closed' || cur.status === 'filled') && nextStatus === 'open' && b.republish !== true) {
    return c.json({ error: `この掲載は${cur.status === 'closed' ? '締切' : '充足'}です。再掲載する場合は「保存して再掲載」を使ってください`, need_republish: true }, 409)
  }
  const { v, error } = validatePost({ ...cur, ...b }, nextStatus === 'open')
  if (error) return c.json({ error }, 400)
  if (v.source_project_id && v.source_project_id !== cur.source_project_id) {
    const own = await db.prepare('SELECT 1 FROM projects WHERE project_id = ? AND company_id = ?').bind(v.source_project_id, u.company_id).first()
    if (!own) v.source_project_id = cur.source_project_id
  }
  const now = nowJST()
  await db.prepare(`UPDATE board_posts SET engagement_type = ?, title = ?, description = ?, prefecture = ?, area = ?, nearest_station = ?,
      date_from = ?, date_to = ?, time_from = ?, time_to = ?, schedule_note = ?, headcount = ?, required_skills = ?,
      price_amount = ?, price_unit = ?, price_note = ?, deadline = ?, status = ?, source_project_id = ?,
      published_at = CASE WHEN ? = 'open' AND published_at IS NULL THEN ? ELSE published_at END, updated_by = ?, updated_at = ?
    WHERE post_id = ? AND company_id = ?`)
    .bind(v.engagement_type, v.title, v.description, v.prefecture, v.area, v.nearest_station,
      v.date_from, v.date_to, v.time_from, v.time_to, v.schedule_note, v.headcount, v.required_skills,
      v.price_amount, v.price_unit, v.price_note, v.deadline, nextStatus, v.source_project_id,
      nextStatus, now, u.user_id, now, cur.post_id, u.company_id).run()
  // 条件（単価・日程・時間帯・人数）の変更と状態の変更を、やり取り中の企業に知らせる（#476）
  const changes = postChanges(cur, v)
  if (changes.length) await notifyPostThreads(db, cur.post_id, `掲載内容が変更されました（${changes.join('、')}）`)
  if (nextStatus !== cur.status && STATUS_NOTICE[nextStatus]) await notifyPostThreads(db, cur.post_id, STATUS_NOTICE[nextStatus])
  return c.json({ ok: true })
})

// やり取り中の企業に知らせる状態の変更
const STATUS_NOTICE: Record<string, string> = {
  open: 'この掲載の募集が再開されました',
  closed: 'この掲載は締め切られました。新しい人材の提案は受け付けていません',
  filled: 'この掲載は充足（募集終了）になりました。新しい人材の提案は受け付けていません',
  draft: 'この掲載は非公開（下書き）になりました。新しい人材の提案は受け付けていません',
}
const UNIT_LABEL: Record<string, string> = { hourly: '時給', daily: '日給', monthly: '月給' }
/** 問い合わせ中の企業に知らせる条件の変更（単価・日程・時間帯・人数）。変更がなければ空 */
function postChanges(cur: any, v: any): string[] {
  const out: string[] = []
  const price = (x: any) => `${UNIT_LABEL[x.price_unit] || ''}${Number(x.price_amount || 0).toLocaleString('ja-JP')}円`
  if (Number(cur.price_amount) !== Number(v.price_amount) || cur.price_unit !== v.price_unit) out.push(`単価: ${price(cur)}→${price(v)}`)
  const days = (x: any) => x.date_from ? `${x.date_from}${x.date_to && x.date_to !== x.date_from ? '〜' + x.date_to : ''}` : '未定'
  if ((cur.date_from || null) !== (v.date_from || null) || (cur.date_to || null) !== (v.date_to || null)) out.push(`日程: ${days(cur)}→${days(v)}`)
  const times = (x: any) => x.time_from || x.time_to ? `${x.time_from || ''}〜${x.time_to || ''}` : '未定'
  if ((cur.time_from || null) !== (v.time_from || null) || (cur.time_to || null) !== (v.time_to || null)) out.push(`時間帯: ${times(cur)}→${times(v)}`)
  if (Number(cur.headcount) !== Number(v.headcount)) out.push(`募集人数: ${cur.headcount}名→${v.headcount}名`)
  return out
}

/** 掲載のやり取り（終了していないもの）すべてに、相手企業の未読に数えるシステムメッセージを入れる（#476） */
async function notifyPostThreads(db: D1Database, postId: number, body: string) {
  await db.batch(threadNoticeStmts(db, 'SELECT ?', [postId], body, nowJST()))
}

// 状態だけの変更（掲載する / 締め切る / 充足 / 下書きに戻す）
boardApi.post('/posts/:id/status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const cur = await db.prepare('SELECT * FROM board_posts WHERE post_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '自社の掲載のみ変更できます' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  if (!POST_STATUSES.includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
  if (b.status === 'open') {
    const { error } = validatePost(cur, true)
    if (error) return c.json({ error }, 400)
  }
  if (b.status === cur.status) return c.json({ ok: true })
  const now = nowJST()
  // 今の状態を条件にして更新し、変えた1回だけ知らせる（二度押し・同時操作で通知が重ならないように）
  const upd = await db.prepare(`UPDATE board_posts SET status = ?, published_at = CASE WHEN ? = 'open' AND published_at IS NULL THEN ? ELSE published_at END,
    updated_by = ?, updated_at = ? WHERE post_id = ? AND status = ?`).bind(b.status, b.status, now, u.user_id, now, cur.post_id, cur.status).run()
  if (upd.meta.changes && STATUS_NOTICE[b.status]) await notifyPostThreads(db, cur.post_id, STATUS_NOTICE[b.status])
  return c.json({ ok: true })
})

// 削除は下書きのみ（掲載したものは履歴として残し、締切・充足で閉じる）
boardApi.delete('/posts/:id', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`DELETE FROM board_posts WHERE post_id = ? AND company_id = ? AND status = 'draft'`).bind(c.req.param('id'), u.company_id).run()
  if (!r.meta.changes) return c.json({ error: '削除できるのは自社の下書きのみです（掲載後は「締め切る」を使ってください）' }, 400)
  return c.json({ ok: true })
})

// =========================================================
// 第2段階: 案件チャット（掲載1件 × 問い合わせ企業1社の1対1スレッド）
// - 参加できるのは掲載企業と問い合わせ企業のみ。他社どうしのやり取りは見えない
// - 既読は企業単位。履歴は削除しない
// =========================================================
const MAX_BODY = 2000

/** 自社が参加しているスレッドを返す（参加していなければ null） */
async function loadThread(db: D1Database, threadId: any, companyId: number) {
  const t = await db.prepare(`SELECT t.*, bp.title AS post_title, bp.engagement_type, bp.status AS post_status,
      pc.company_name AS poster_company_name, ic.company_name AS inquirer_company_name
    FROM board_threads t JOIN board_posts bp ON bp.post_id = t.post_id
    JOIN companies pc ON pc.company_id = t.poster_company_id JOIN companies ic ON ic.company_id = t.inquirer_company_id
    WHERE t.thread_id = ?`).bind(threadId).first() as any
  if (!t || (t.poster_company_id !== companyId && t.inquirer_company_id !== companyId)) return null
  return {
    ...t,
    my_side: t.poster_company_id === companyId ? 'poster' : 'inquirer',
    partner_company_name: t.poster_company_id === companyId ? t.inquirer_company_name : t.poster_company_name,
  }
}

/** notify = true のシステムメッセージは、相手企業の未読に数える（提案の結果・やり取りの終了・掲載の変更など。#124） */
async function addMessage(db: D1Database, threadId: number, companyId: number, userId: number | null, kind: string, body: string, notify = false) {
  const now = nowJST()
  const r = await db.prepare(`INSERT INTO board_messages (thread_id, author_company_id, author_user_id, kind, body, notify, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(threadId, companyId, userId, kind, body, notify ? 1 : 0, now).run()
  const id = r.meta.last_row_id as number
  const stmts = [db.prepare('UPDATE board_threads SET last_message_id = ?, last_message_at = ? WHERE thread_id = ?').bind(id, now, threadId)]
  // 自社の投稿は自社既読として扱う。システムメッセージ（自動の締切など、画面を見ていない間にも入るもの）では既読位置を動かさない
  if (kind !== 'system') stmts.push(db.prepare(`INSERT INTO board_thread_reads (thread_id, company_id, last_read_message_id, read_by, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, company_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), read_by = excluded.read_by, read_at = excluded.read_at`)
      .bind(threadId, companyId, id, userId, now))
  await db.batch(stmts)
  return id
}

// 未読は本文・提案と、相手企業に知らせるシステムメッセージ（notify = 1）を数える
// （「問い合わせが開始されました」のように直後に本文が続くシステムメッセージは数えない。#124）
const UNREAD_KIND = `(m.kind != 'system' OR m.notify = 1)`
// 既読位置は、自分の既読（board_thread_user_reads）と、自社が最後に返信した位置（board_thread_reads。自社の投稿でだけ進む）の大きい方。
// 画面を開いているだけで自社全員の未読が消えないように、閲覧による既読はユーザー単位にする（#250）
const READ_POS = `MAX(COALESCE((SELECT r.last_read_message_id FROM board_thread_reads r WHERE r.thread_id = t.thread_id AND r.company_id = ?), 0),
   COALESCE((SELECT ur.last_read_message_id FROM board_thread_user_reads ur WHERE ur.thread_id = t.thread_id AND ur.user_id = ?), 0))`
// バインドは unreadBinds（自社の会社ID・自社の会社ID・ユーザーID）
const UNREAD_SQL = `(SELECT COUNT(*) FROM board_messages m WHERE m.thread_id = t.thread_id AND m.author_company_id != ? AND ${UNREAD_KIND}
   AND m.message_id > ${READ_POS})`
const unreadBinds = (u: any) => [u.company_id, u.company_id, u.user_id]

// 問い合わせを開始する（既にあれば既存スレッドを返す）。自社の掲載・掲載中でない掲載には問い合わせできない
boardApi.post('/posts/:id/threads', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await closeExpired(db)
  const post = await db.prepare('SELECT post_id, company_id, status FROM board_posts WHERE post_id = ?').bind(c.req.param('id')).first() as any
  if (!post || post.status === 'draft') return c.json({ error: '掲載が見つかりません' }, 404)
  if (post.company_id === u.company_id) return c.json({ error: '自社の掲載には問い合わせできません' }, 400)
  const b = await c.req.json().catch(() => ({} as any))
  const body = String(b.body || '').trim()
  if (body.length > MAX_BODY) return c.json({ error: `メッセージは${MAX_BODY}文字以内で入力してください` }, 400)
  // 自社のやり取りがすでにある（同じ会社の別の担当者が先に問い合わせた）ときは、本文をそのやり取りに足す（#435）
  const exist = await db.prepare('SELECT thread_id, status FROM board_threads WHERE post_id = ? AND inquirer_company_id = ?').bind(post.post_id, u.company_id).first() as any
  if (exist) {
    if (!body) return c.json({ ok: true, thread_id: exist.thread_id, existed: true, appended: false })
    if (exist.status === 'closed') return c.json({ error: 'この掲載とのやり取りはすでにあり、終了しています。やり取りを開いて再開してから送ってください（本文は送信していません）', thread_id: exist.thread_id, existed: true }, 409)
    await addMessage(db, exist.thread_id, u.company_id, u.user_id, 'text', body)
    return c.json({ ok: true, thread_id: exist.thread_id, existed: true, appended: true })
  }
  if (post.status !== 'open' || !(await posterActive(db, post.company_id))) return c.json({ error: 'この掲載は募集を終了しています' }, 409)
  if (!body) return c.json({ error: '最初のメッセージを入力してください' }, 400)
  const r = await db.prepare(`INSERT INTO board_threads (post_id, poster_company_id, inquirer_company_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(post_id, inquirer_company_id) DO NOTHING`).bind(post.post_id, post.company_id, u.company_id, u.user_id, nowJST()).run()
  const t = await db.prepare('SELECT thread_id FROM board_threads WHERE post_id = ? AND inquirer_company_id = ?').bind(post.post_id, u.company_id).first() as any
  if (r.meta.changes) await addMessage(db, t.thread_id, u.company_id, null, 'system', 'この案件への問い合わせが開始されました')
  await addMessage(db, t.thread_id, u.company_id, u.user_id, 'text', body)
  return c.json({ ok: true, thread_id: t.thread_id })
})

// スレッド一覧（自社が参加する全スレッド）。post_id を指定するとその掲載のスレッドのみ
boardApi.get('/threads', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const postId = c.req.query('post_id')
  const w = ['(t.poster_company_id = ? OR t.inquirer_company_id = ?)']; const bind: any[] = [u.company_id, u.company_id]
  if (postId) { w.push('t.post_id = ?'); bind.push(postId) }
  const rows = (await db.prepare(`SELECT t.thread_id, t.post_id, t.poster_company_id, t.inquirer_company_id, t.status, t.last_message_at, t.created_at,
      bp.title AS post_title, bp.engagement_type, bp.status AS post_status,
      pc.company_name AS poster_company_name, ic.company_name AS inquirer_company_name,
      (SELECT m.body FROM board_messages m WHERE m.thread_id = t.thread_id ORDER BY m.message_id DESC LIMIT 1) AS last_body,
      ${UNREAD_SQL} AS unread
    FROM board_threads t JOIN board_posts bp ON bp.post_id = t.post_id
    JOIN companies pc ON pc.company_id = t.poster_company_id JOIN companies ic ON ic.company_id = t.inquirer_company_id
    WHERE ${w.join(' AND ')}
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 300`).bind(...unreadBinds(u), ...bind).all()).results as any[]
  const threads = rows.map(t => ({
    ...t,
    my_side: t.poster_company_id === u.company_id ? 'poster' : 'inquirer',
    partner_company_name: t.poster_company_id === u.company_id ? t.inquirer_company_name : t.poster_company_name,
  }))
  return c.json({ threads, unread_total: threads.reduce((a, t) => a + (t.unread || 0), 0) })
})

// 未読件数のみ（サイドバーのバッジ用・軽量）
boardApi.get('/unread-count', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM board_messages m JOIN board_threads t ON t.thread_id = m.thread_id
    WHERE (t.poster_company_id = ? OR t.inquirer_company_id = ?) AND m.author_company_id != ? AND ${UNREAD_KIND}
      AND m.message_id > ${READ_POS}`)
    .bind(u.company_id, u.company_id, u.company_id, u.company_id, u.user_id).first()
  return c.json({ unread: (r?.n as number) || 0 })
})

// メッセージ取得（全履歴）。取得しただけでは既読にしない（既読は POST /threads/:id/read。#250）
boardApi.get('/threads/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  await withdrawUnavailable(db, 'p.thread_id = ?', [t.thread_id])
  const rows = (await db.prepare(`SELECT m.message_id, m.kind, m.body, m.proposal_id, m.created_at, m.author_company_id, um.name AS author_name, co.company_name AS author_company_name
    FROM board_messages m LEFT JOIN users um ON um.user_id = m.author_user_id LEFT JOIN companies co ON co.company_id = m.author_company_id
    WHERE m.thread_id = ? ORDER BY m.message_id`).bind(t.thread_id).all()).results as any[]
  const msgs = rows.map(m => ({ ...m, mine: m.author_company_id === u.company_id, author_name: m.kind === 'system' ? null : m.author_name }))
  const { created_by: _cb, ...thread } = t
  return c.json({ thread, messages: msgs })
})

// 既読にする（ユーザー単位）。画面が表示されていて、やり取りの一番下まで見えているときに画面から呼ぶ（#250）
// message_id: 画面に表示した最後のメッセージ。省略したら最新まで
boardApi.post('/threads/:id/read', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const upto = Number(b.message_id)
  const r = await db.prepare(`SELECT MAX(message_id) AS id FROM board_messages WHERE thread_id = ?${Number.isInteger(upto) && upto > 0 ? ' AND message_id <= ?' : ''}`)
    .bind(t.thread_id, ...(Number.isInteger(upto) && upto > 0 ? [upto] : [])).first() as any
  const last = Number(r?.id || 0)
  if (last) {
    await db.prepare(`INSERT INTO board_thread_user_reads (thread_id, user_id, last_read_message_id, read_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), read_at = excluded.read_at`)
      .bind(t.thread_id, u.user_id, last, nowJST()).run()
  }
  return c.json({ ok: true, last_read_message_id: last })
})

// 投稿
boardApi.post('/threads/:id/messages', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  if (t.status === 'closed') return c.json({ error: 'このやり取りは終了しています' }, 409)
  const b = await c.req.json().catch(() => ({} as any))
  const body = String(b.body || '').trim()
  if (!body) return c.json({ error: 'メッセージを入力してください' }, 400)
  if (body.length > MAX_BODY) return c.json({ error: `メッセージは${MAX_BODY}文字以内で入力してください` }, 400)
  const id = await addMessage(db, t.thread_id, u.company_id, u.user_id, 'text', body)
  return c.json({ ok: true, message_id: id })
})

// やり取りの終了 / 再開（どちらの企業からでも可。履歴は残る）
boardApi.post('/threads/:id/status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  if (!['open', 'closed'].includes(b.status)) return c.json({ error: '状態が正しくありません' }, 400)
  if (b.status === t.status) return c.json({ ok: true })
  const upd = await db.prepare('UPDATE board_threads SET status = ? WHERE thread_id = ? AND status = ?').bind(b.status, t.thread_id, t.status).run()
  if (!upd.meta.changes) return c.json({ ok: true })
  // 終了したら、未決の提案（提案中・面談希望）を取り下げにする。再開しても戻さない（終了後に採用・氏名の開示ができないように。#141）
  let withdrawn = 0
  if (b.status === 'closed') {
    const now = nowJST()
    const w = await db.prepare(`UPDATE board_proposals SET status = 'withdrawn', updated_at = ?, decided_at = ? WHERE thread_id = ? AND status IN ('proposed','interview')`)
      .bind(now, now, t.thread_id).run()
    withdrawn = w.meta.changes || 0
  }
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first()
  await addMessage(db, t.thread_id, u.company_id, null, 'system',
    `${own?.company_name || ''}がやり取りを${b.status === 'closed' ? '終了' : '再開'}しました` + (withdrawn ? `（未決の提案 ${withdrawn}件は取り下げになりました）` : ''), true)
  return c.json({ ok: true, withdrawn })
})

// =========================================================
// 第3段階: 人材提案（docs/spec_board.md 4・5章）
// - チャット内で、自社スタッフマスタから選んだ人材の匿名スキルシート（スナップショット）を送る
// - 提案相手からの見え方は区分にかかわらず「所属: 提案元企業」。区分・経路（連携元・取引先）は出さない
// - 採用で氏名を開示。upstream_chain（上流の経路）は DB のみに保持し、API・画面には出さない
// =========================================================
export const PROPOSAL_STATUSES = ['proposed', 'interview', 'adopted', 'declined', 'withdrawn'] as const
const PROPOSAL_LABEL: Record<string, string> = { proposed: '提案中', interview: '面談希望', adopted: '採用', declined: '見送り', withdrawn: '取り下げ' }
const PROPOSABLE_KINDS = ['own_employee', 'daily_worker', 'freelance', 'skillsheet_only', 'partner_manual', 'linked_external']
// 提案者への注意文（区分ごと）
const PROPOSAL_WARNINGS: Record<string, string> = {
  partner_manual: '取引先から預かっている人材です。再提案が可能か取引先との契約をご確認ください。',
  linked_external: '他社から連携されている人材です。所属元との契約上、再提案が可能かご確認ください。',
}
const MAX_PROPOSALS_PER_THREAD = 50

function ageGroup(dob: string | null | undefined, fallback?: string | null): string {
  if (dob && /^\d{4}-\d{2}-\d{2}/.test(dob)) {
    const t = todayJST(); const [ty, tm, td] = t.split('-').map(Number); const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number)
    let age = ty - by; if (tm < bm || (tm === bm && td < bd)) age--
    if (age >= 10 && age < 100) return `${Math.floor(age / 10) * 10}代`
  }
  return fallback || ''
}
// イニシャル: フリガナ（カタカナ/ひらがな）の各語の先頭をローマ字化。取れなければ空（表示側で「候補者No.○」）
const KANA_ROMA: Record<string, string> = {}
;('ア,A イ,I ウ,U エ,E オ,O カ,K キ,K ク,K ケ,K コ,K サ,S シ,S ス,S セ,S ソ,S タ,T チ,C ツ,T テ,T ト,T ナ,N ニ,N ヌ,N ネ,N ノ,N ハ,H ヒ,H フ,F ヘ,H ホ,H マ,M ミ,M ム,M メ,M モ,M ヤ,Y ユ,Y ヨ,Y ラ,R リ,R ル,R レ,R ロ,R ワ,W ヲ,W ン,N ガ,G ギ,G グ,G ゲ,G ゴ,G ザ,Z ジ,J ズ,Z ゼ,Z ゾ,Z ダ,D ヂ,J ヅ,Z デ,D ド,D バ,B ビ,B ブ,B ベ,B ボ,B パ,P ピ,P プ,P ペ,P ポ,P ヴ,V')
  .split(' ').forEach(x => { const [k, r] = x.split(','); KANA_ROMA[k] = r })
function initials(kana: string | null | undefined): string {
  const words = String(kana || '').trim().replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)).split(/[\s\u3000]+/).filter(Boolean)
  const out = words.map(w => KANA_ROMA[w[0]] || (/[A-Za-z]/.test(w[0]) ? w[0].toUpperCase() : '')).filter(Boolean)
  return out.length ? out.map(c => c + '.').join(' ') : ''
}
/** 匿名時の呼び名: イニシャルが無ければ提案番号 */
function anonLabel(sn: any, pid: number) { const i = sn?.initials && sn.initials !== '—' ? sn.initials : ''; return i || `候補者No.${pid}` }
function parseRows(v: any): any[] { try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch { return [] } }

/** 提案用の匿名スナップショット。所属は常に提案元企業名（区分・取引先・連携元は入れない） */
function buildSnapshot(r: any, proposerName: string) {
  return {
    initials: initials(r.kana),
    age_group: ageGroup(r.date_of_birth, r.age_group),
    gender: r.gender || '',
    affiliation: proposerName,
    nearest_station: [r.nearest_station_line, r.nearest_station].filter(Boolean).join(' '),
    commute_minutes: r.commute_minutes ?? null,
    available_from: r.available_from || '',
    work_area: r.work_area || '',
    skills: r.skills || '',
    career_rows: parseRows(r.career_rows).map((x: any) => ({ from: x.from || '', to: x.to || '', company: x.company || '', work: [x.work, x.note].filter(Boolean).join('\n') })),
    career: parseRows(r.career_rows).length ? '' : (r.career || ''),
    pr_points: r.pr_points || '',
  }
}

/** 上流の経路（非公開）。連携元・取引先・掲示板の取り込み元などを記録する */
async function upstreamChain(db: D1Database, r: any) {
  const chain: any = { kind: r.affiliation_type }
  if (r.affiliation_type === 'linked_external') {
    chain.linked_from_company_id = r.owner_company_id ?? null
    const root = await db.prepare('SELECT COALESCE(root_staff_id, source_staff_id) AS root FROM staff_profiles WHERE staff_id = ?').bind(r.staff_id).first() as any
    if (root?.root) chain.root_company_id = ((await db.prepare('SELECT company_id FROM staff_profiles WHERE staff_id = ?').bind(root.root).first()) as any)?.company_id ?? null
  }
  if (r.affiliation_type === 'partner_manual') { chain.partner_affiliation_id = r.partner_affiliation_id ?? null; chain.partner_name = r.affiliation || '' }
  const via = await db.prepare('SELECT upstream_chain, proposer_company_id FROM board_proposals WHERE imported_staff_id = ? LIMIT 1').bind(r.staff_id).first() as any
  if (via) chain.via_board = { proposer_company_id: via.proposer_company_id, upstream: (() => { try { return JSON.parse(via.upstream_chain || 'null') } catch { return null } })() }
  return chain
}

// 取り込み先の行（統合したら統合先の行）。行が削除されていれば NULL
const IMPORTED_ALIVE = `(SELECT COALESCE(x.merged_into_staff_id, x.staff_id) FROM staff_profiles x WHERE x.staff_id = p.imported_staff_id AND x.company_id = p.receiver_company_id) AS imported_alive`

/** 受け手に返してよい形に整える（採用前は disclosed を出さない。提案元の内部情報は提案元にだけ返す） */
function shapeProposal(p: any, companyId: number) {
  const mine = p.proposer_company_id === companyId
  const out: any = {
    proposal_id: p.proposal_id, thread_id: p.thread_id, post_id: p.post_id, status: p.status, status_label: PROPOSAL_LABEL[p.status] || p.status,
    snapshot: (() => { try { return JSON.parse(p.snapshot) } catch { return {} } })(),
    proposed_price: p.proposed_price, price_unit: p.price_unit, comment: p.comment, created_at: p.created_at, decided_at: p.decided_at,
    proposer_company_name: p.proposer_company_name, is_mine: mine,
  }
  if (mine || p.status === 'adopted') out.disclosed = (() => { try { return JSON.parse(p.disclosed || 'null') } catch { return null } })()
  if (mine) { out.staff_id = p.staff_id; out.staff_kind = p.staff_kind }
  // 本人同意の記録（取得方法・日付）は双方に返す。所属元（取引先）の承諾は上流の経路にあたるため提案元にだけ返す（#502）
  out.consent = p.consent_method ? { method: p.consent_method, method_label: CONSENT_METHODS[p.consent_method] || p.consent_method, obtained_on: p.consent_obtained_on } : null
  if (mine && p.consent_method) Object.assign(out.consent, { note: p.consent_note, upstream_on: p.upstream_consent_on, upstream_note: p.upstream_consent_note })
  // 取り込み先の行は受け手（自社）のものなので受け手にだけ返す
  if (!mine && p.receiver_company_id === companyId) out.imported_staff_id = p.imported_alive ?? null
  return out
}

// 提案できる自社スタッフの候補（統合済みは除外。区分ごとの注意文付き）
boardApi.get('/threads/:id/proposal-candidates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  if (t.my_side !== 'inquirer') return c.json({ error: '人材の提案は問い合わせた企業から掲載企業へ行います' }, 403)
  const q = String(c.req.query('q') || '').trim()
  const w = ['sp.company_id = ?', 'sp.merged_into_staff_id IS NULL', `COALESCE(sp.affiliation_type,'own_employee') IN (${PROPOSABLE_KINDS.map(() => '?').join(',')})`, `COALESCE(sp.employment_status,'working') != 'retired'`]
  const bind: any[] = [u.company_id, ...PROPOSABLE_KINDS]
  if (q) { w.push(`(us.name LIKE ? OR COALESCE(CASE WHEN sp.affiliation_type='linked_external' THEN src.skills ELSE sp.skills END,'') LIKE ? OR COALESCE(CASE WHEN sp.affiliation_type='linked_external' THEN src.kana ELSE sp.kana END,'') LIKE ?)`); bind.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const rows = (await db.prepare(`SELECT sp.staff_id, us.name, COALESCE(sp.affiliation_type,'own_employee') AS kind, sp.affiliation,
      CASE WHEN sp.affiliation_type='linked_external' THEN src.skills ELSE sp.skills END AS skills,
      CASE WHEN sp.affiliation_type='linked_external' THEN src.work_area ELSE sp.work_area END AS work_area,
      (SELECT COUNT(*) FROM board_proposals bp WHERE bp.staff_id = sp.staff_id AND bp.thread_id = ? AND bp.status NOT IN ('withdrawn','declined')) AS already,
      ${ELSEWHERE_COLS}
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    WHERE ${w.join(' AND ')} ORDER BY us.name LIMIT 200`).bind(t.thread_id, t.thread_id, t.thread_id, t.thread_id, ...bind).all()).results as any[]
  return c.json({ candidates: rows.map(r => ({ ...r, warning: PROPOSAL_WARNINGS[r.kind] || null })) })
})

// ほかのやり取り（ほかの掲載・ほかの企業）で、同じスタッフを提案中・採用済みか（#477）。
// sp.staff_id は自社の行なので、数えるのは自社が送った提案だけ。バインドは今のやり取りの thread_id を3つ
const ELSEWHERE_COLS = `(SELECT COUNT(*) FROM board_proposals o WHERE o.staff_id = sp.staff_id AND o.thread_id != ? AND o.status IN ('proposed','interview')) AS other_pending,
      (SELECT COUNT(*) FROM board_proposals o WHERE o.staff_id = sp.staff_id AND o.thread_id != ? AND o.status = 'adopted') AS other_adopted,
      (SELECT oc.company_name || '・' || ob.title FROM board_proposals o JOIN companies oc ON oc.company_id = o.receiver_company_id JOIN board_posts ob ON ob.post_id = o.post_id
        WHERE o.staff_id = sp.staff_id AND o.thread_id != ? AND o.status = 'adopted' ORDER BY o.decided_at DESC, o.proposal_id DESC LIMIT 1) AS adopted_label`

// 送信前のプレビュー（相手に見える内容そのもの）
boardApi.get('/threads/:id/proposal-preview', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  if (t.my_side !== 'inquirer') return c.json({ error: '人材の提案は問い合わせた企業から掲載企業へ行います' }, 403)
  const r = await loadRoster(db, c.req.query('staff_id') || '', u.company_id)
  if (!r) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (r.merged_into_staff_id) return c.json({ error: '統合済みのスタッフは提案できません（統合先のスタッフで提案してください）' }, 400)
  if (!PROPOSABLE_KINDS.includes(r.affiliation_type)) return c.json({ error: 'このスタッフは提案できません' }, 400)
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  // 他社連携の人材は、連携のときに本人が同意した範囲（自社への共有）を示し、所属元の承諾を求める（#502。roster_consents は参照のみ）
  const link = r.affiliation_type === 'linked_external'
    ? await db.prepare('SELECT consent_version, created_at FROM roster_consents WHERE staff_id = ? ORDER BY created_at DESC LIMIT 1').bind(r.staff_id).first() as any
    : null
  // ほかの掲載で提案中・採用済みなら、送る前に知らせる（#477）
  const elsewhere = await db.prepare(`SELECT ${ELSEWHERE_COLS} FROM staff_profiles sp WHERE sp.staff_id = ?`).bind(t.thread_id, t.thread_id, t.thread_id, r.staff_id).first() as any
  return c.json({ snapshot: buildSnapshot(r, own?.company_name || ''), name: r.name, warning: PROPOSAL_WARNINGS[r.affiliation_type] || null,
    elsewhere: elsewhere ? { pending: elsewhere.other_pending || 0, adopted: elsewhere.other_adopted || 0, adopted_label: elsewhere.adopted_label || null } : null,
    need_upstream_consent: !!PROPOSAL_WARNINGS[r.affiliation_type], upstream_label: r.affiliation_type === 'linked_external' ? '所属元' : '取引先', link_consent: link ? { version: link.consent_version, created_at: link.created_at } : null,
    consent_methods: CONSENT_METHODS })
})

// 人材提案の本人同意の取得方法（#502）
const CONSENT_METHODS: Record<string, string> = { written: '書面', electronic: 'メール・チャット等の記録', verbal: '口頭（記録を残している）' }
/** 提案に必要な同意の記録を検証する。他社連携・取引先所属の人材は所属元（取引先）の承諾も求める */
function validateConsent(b: any, kind: string): { v?: any; error?: string } {
  const today = todayJST()
  if (!CONSENT_METHODS[b.consent_method]) return { error: '本人の同意の取得方法を選択してください（提案には本人の同意が必要です）' }
  if (!isISODate(b.consent_obtained_on) || b.consent_obtained_on > today) return { error: '本人の同意を得た日を入力してください（今日以前）' }
  const v: any = { consent_method: b.consent_method, consent_obtained_on: b.consent_obtained_on, consent_note: str(b.consent_note, 200) || null,
    upstream_consent_on: null, upstream_consent_note: null }
  if (PROPOSAL_WARNINGS[kind]) {
    if (!isISODate(b.upstream_consent_on) || b.upstream_consent_on > today) return { error: `${kind === 'linked_external' ? '所属元' : '取引先'}から再提案の承諾を得た日を入力してください（今日以前）` }
    v.upstream_consent_on = b.upstream_consent_on; v.upstream_consent_note = str(b.upstream_consent_note, 200) || null
  }
  return { v }
}

// 提案の送信
boardApi.post('/threads/:id/proposals', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  await closeExpired(db)
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  if (t.my_side !== 'inquirer') return c.json({ error: '人材の提案は問い合わせた企業から掲載企業へ行います' }, 403)
  if (t.status === 'closed') return c.json({ error: 'このやり取りは終了しています' }, 409)
  // 締切・充足・非公開の掲載には提案しない（#476）
  if (t.post_status !== 'open') return c.json({ error: 'この掲載は募集を終了しているため、人材を提案できません' }, 409)
  if (!(await posterActive(db, t.poster_company_id))) return c.json({ error: '掲載企業が現在ご利用を停止しているため、提案できません' }, 409)
  const b = await c.req.json().catch(() => ({} as any))
  const r = await loadRoster(db, b.staff_id, u.company_id)
  if (!r) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (r.merged_into_staff_id) return c.json({ error: '統合済みのスタッフは提案できません（統合先のスタッフで提案してください）' }, 400)
  if (!PROPOSABLE_KINDS.includes(r.affiliation_type)) return c.json({ error: 'このスタッフは提案できません' }, 400)
  if (r.employment_status === 'retired') return c.json({ error: '退職したスタッフは提案できません' }, 400)
  // 本人の同意（と所属元・取引先の承諾）の記録がなければ提案しない（#502）
  const consent = validateConsent(b, r.affiliation_type)
  if (consent.error) return c.json({ error: consent.error, warning: PROPOSAL_WARNINGS[r.affiliation_type] || null }, 400)
  const cv = consent.v
  const dup = await db.prepare(`SELECT 1 FROM board_proposals WHERE thread_id = ? AND staff_id = ? AND status NOT IN ('withdrawn','declined')`).bind(t.thread_id, r.staff_id).first()
  if (dup) return c.json({ error: 'このスタッフはこのやり取りで提案済みです' }, 409)
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM board_proposals WHERE thread_id = ?').bind(t.thread_id).first() as any
  if ((cnt?.n || 0) >= MAX_PROPOSALS_PER_THREAD) return c.json({ error: `1つのやり取りで提案できるのは${MAX_PROPOSALS_PER_THREAD}件までです` }, 400)
  const price = b.proposed_price === '' || b.proposed_price == null ? null : Number(b.proposed_price)
  if (price != null && (!Number.isInteger(price) || price <= 0 || price > 10000000)) return c.json({ error: '提示単価は1円以上の整数で入力してください' }, 400)
  const unit = PRICE_UNITS.includes(b.price_unit) ? b.price_unit : null
  if (price != null && !unit) return c.json({ error: '提示単価の単位を選択してください' }, 400)
  const comment = str(b.comment, 1000)
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const snapshot = buildSnapshot(r, own?.company_name || '')
  const disclosed = { name: r.name, kana: r.kana || '' }
  const chain = await upstreamChain(db, r)
  const now = nowJST()
  const receiver = t.poster_company_id
  // 二度押し・同時の送信でも1件だけ登録する（確認と登録を1文で行い、未決の提案は一意インデックスでも防ぐ。#243）
  let ins: D1Result
  try {
    ins = await db.prepare(`INSERT INTO board_proposals (thread_id, post_id, proposer_company_id, receiver_company_id, staff_id, staff_kind, snapshot, disclosed,
        proposed_price, price_unit, comment, status, upstream_chain, consent_method, consent_obtained_on, consent_note, upstream_consent_on, upstream_consent_note,
        created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM board_proposals WHERE thread_id = ? AND staff_id = ? AND status NOT IN ('withdrawn','declined'))`)
      .bind(t.thread_id, t.post_id, u.company_id, receiver, r.staff_id, r.affiliation_type, JSON.stringify(snapshot), JSON.stringify(disclosed),
        price, price != null ? unit : null, comment, JSON.stringify(chain), cv.consent_method, cv.consent_obtained_on, cv.consent_note, cv.upstream_consent_on, cv.upstream_consent_note,
        u.user_id, now, now, t.thread_id, r.staff_id).run()
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message || e))) return c.json({ error: 'このスタッフはこのやり取りで提案済みです' }, 409)
    throw e
  }
  if (!ins.meta.changes) return c.json({ error: 'このスタッフはこのやり取りで提案済みです' }, 409)
  const pid = ins.meta.last_row_id as number
  const mid = await addMessage(db, t.thread_id, u.company_id, u.user_id, 'proposal', `人材を提案しました（${anonLabel(snapshot, pid)}・${snapshot.age_group || '年代不明'}）`)
  await db.prepare('UPDATE board_messages SET proposal_id = ? WHERE message_id = ?').bind(pid, mid).run()
  return c.json({ ok: true, proposal_id: pid })
})

// 提案一覧（スレッド内）
boardApi.get('/threads/:id/proposals', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  await withdrawUnavailable(db, 'p.thread_id = ?', [t.thread_id])
  const rows = (await db.prepare(`SELECT p.*, co.company_name AS proposer_company_name, ${IMPORTED_ALIVE} FROM board_proposals p JOIN companies co ON co.company_id = p.proposer_company_id
    WHERE p.thread_id = ? ORDER BY p.proposal_id`).bind(t.thread_id).all()).results as any[]
  return c.json({ proposals: rows.map(p => shapeProposal(p, u.company_id)) })
})

// 状態変更: 受け手 = 面談希望 / 採用 / 見送り、提案者 = 取り下げ（採用前のみ）
boardApi.post('/proposals/:id/status', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await db.prepare(`SELECT p.*, co.company_name AS proposer_company_name, ${IMPORTED_ALIVE} FROM board_proposals p JOIN companies co ON co.company_id = p.proposer_company_id WHERE p.proposal_id = ?`)
    .bind(c.req.param('id')).first() as any
  if (!p || (p.proposer_company_id !== u.company_id && p.receiver_company_id !== u.company_id)) return c.json({ error: '提案が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const to = String(b.status || '')
  const isReceiver = p.receiver_company_id === u.company_id
  const allowed: Record<string, string[]> = isReceiver
    ? { proposed: ['interview', 'adopted', 'declined'], interview: ['adopted', 'declined', 'proposed'] }
    : { proposed: ['withdrawn'], interview: ['withdrawn'] }
  if (!(allowed[p.status] || []).includes(to)) {
    if (p.status === 'adopted') return c.json({ error: '採用済みの提案は変更できません' }, 409)
    return c.json({ error: isReceiver ? 'この状態には変更できません' : '提案した側ができるのは採用前の取り下げのみです' }, 400)
  }
  // 終了したやり取りでは、面談希望・採用・見送りにしない（採用で氏名が開示されるため。#141）
  const th = await db.prepare('SELECT status FROM board_threads WHERE thread_id = ?').bind(p.thread_id).first() as any
  if (to !== 'withdrawn' && th?.status !== 'open') return c.json({ error: 'このやり取りは終了しています。提案の状態は変更できません' }, 409)
  // 提案元のスタッフが退職・統合したら、面談希望・採用にはできない（採用で氏名が開示されるため）。未決の提案は取り下げにする（#352）
  if (to !== 'withdrawn' && to !== 'declined' && await withdrawUnavailable(db, 'p.proposal_id = ?', [p.proposal_id])) {
    return c.json({ error: '提案元の人材が利用できなくなったため、この提案は取り下げになりました' }, 409)
  }
  const now = nowJST()
  // 状態とやり取りの状態を条件にして更新する（二度押しや、終了と同時の採用を防ぐ）
  const upd = await db.prepare(`UPDATE board_proposals SET status = ?, updated_at = ?, decided_at = CASE WHEN ? IN ('adopted','declined','withdrawn') THEN ? ELSE decided_at END
    WHERE proposal_id = ? AND status = ? AND (? = 'withdrawn' OR EXISTS (SELECT 1 FROM board_threads t WHERE t.thread_id = board_proposals.thread_id AND t.status = 'open'))`)
    .bind(to, now, to, now, p.proposal_id, p.status, to).run()
  if (!upd.meta.changes) return c.json({ error: '提案の状態が変わりました。画面を読み直してください' }, 409)
  const snap = (() => { try { return JSON.parse(p.snapshot) } catch { return {} } })()
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const note = str(b.note, 300)
  const msg = `${own?.company_name || ''}が提案（${anonLabel(snap, p.proposal_id)}${snap.age_group ? '・' + snap.age_group : ''}）を「${PROPOSAL_LABEL[to]}」にしました` + (to === 'adopted' ? '。氏名が開示されました' : '') + (note ? `\n${note}` : '')
  const mid = await addMessage(db, p.thread_id, u.company_id, null, 'system', msg, true)
  await db.prepare('UPDATE board_messages SET proposal_id = ? WHERE message_id = ?').bind(p.proposal_id, mid).run()
  // 採用で募集人数に達したら、掲載を充足にするかを画面で確認する（#304）
  if (to === 'adopted') {
    const post = await db.prepare('SELECT status, headcount FROM board_posts WHERE post_id = ? AND company_id = ?').bind(p.post_id, u.company_id).first() as any
    if (post) {
      const n = (await adoptedCounts(db, [p.post_id]))[p.post_id] || 0
      return c.json({ ok: true, adopted_count: n, headcount: post.headcount, should_fill: post.status === 'open' && n >= Number(post.headcount || 0) })
    }
  }
  return c.json({ ok: true })
})

// 自社が関わる提案の一覧（提案した / 受けた）
boardApi.get('/proposals', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const side = c.req.query('side') === 'received' ? 'received' : 'sent'
  const col = side === 'sent' ? 'p.proposer_company_id' : 'p.receiver_company_id'
  await withdrawUnavailable(db, `${col} = ?`, [u.company_id])
  // 状態の絞り込み（#394）。pending = 返事待ち（提案中・面談希望）、not_imported = 採用したがスタッフマスタに取り込んでいない（受けた提案のみ）
  const st = String(c.req.query('status') || '')
  const w = [`${col} = ?`]; const bind: any[] = [u.company_id]
  if ((PROPOSAL_STATUSES as readonly string[]).includes(st)) { w.push('p.status = ?'); bind.push(st) }
  else if (st === 'pending') w.push(`p.status IN ('proposed','interview')`)
  else if (st === 'not_imported' && side === 'received') w.push(`p.status = 'adopted' AND NOT EXISTS (SELECT 1 FROM staff_profiles x WHERE x.staff_id = p.imported_staff_id AND x.company_id = p.receiver_company_id)`)
  const rows = (await db.prepare(`SELECT p.*, co.company_name AS proposer_company_name, ${IMPORTED_ALIVE}, rc.company_name AS receiver_company_name, bp.title AS post_title, bp.engagement_type,
      ${side === 'sent' ? 'us.name AS staff_name' : 'NULL AS staff_name'}
    FROM board_proposals p JOIN companies co ON co.company_id = p.proposer_company_id JOIN companies rc ON rc.company_id = p.receiver_company_id
    JOIN board_posts bp ON bp.post_id = p.post_id
    ${side === 'sent' ? 'LEFT JOIN staff_profiles sp ON sp.staff_id = p.staff_id LEFT JOIN users us ON us.user_id = sp.user_id' : ''}
    WHERE ${w.join(' AND ')} ORDER BY p.updated_at DESC LIMIT 300`).bind(...bind).all()).results as any[]
  return c.json({ side, proposals: rows.map(p => ({ ...shapeProposal(p, u.company_id), post_title: p.post_title, engagement_type: p.engagement_type,
    receiver_company_name: p.receiver_company_name, staff_name: side === 'sent' ? p.staff_name : undefined,
    not_imported: side === 'received' && p.status === 'adopted' && !p.imported_alive })) })
})

/**
 * 提案元のスタッフが退職・統合した（または行が消えた）未決の提案（提案中・面談希望）を取り下げにし、やり取りに知らせる（#352）。
 * 退職・統合の処理は掲示板の外にあるため、提案を読むとき・状態を変えるときに遅延して行う（closeExpired と同じ考え方）。
 * 受け手には退職・統合とは書かず「利用できなくなった」とだけ知らせる。取り下げた件数を返す
 */
async function withdrawUnavailable(db: D1Database, scopeSql: string, binds: any[]): Promise<number> {
  const target = `SELECT p.proposal_id FROM board_proposals p WHERE p.status IN ('proposed','interview') AND (${scopeSql})
    AND NOT EXISTS (SELECT 1 FROM staff_profiles s WHERE s.staff_id = p.staff_id AND s.company_id = p.proposer_company_id
      AND s.merged_into_staff_id IS NULL AND COALESCE(s.employment_status,'working') != 'retired')`
  const hit = await db.prepare(`SELECT COUNT(*) AS n FROM (${target})`).bind(...binds).first() as any
  if (!hit?.n) return 0
  const now = nowJST()
  const label = `CASE WHEN COALESCE(json_extract(p.snapshot, '$.initials'), '') NOT IN ('', '—') THEN json_extract(p.snapshot, '$.initials') ELSE '候補者No.' || p.proposal_id END`
  // batch は1つのトランザクション。同時に呼ばれても、知らせるのは取り下げにした1回だけ
  const res = await db.batch([
    db.prepare(`INSERT INTO board_messages (thread_id, author_company_id, author_user_id, kind, body, notify, created_at, proposal_id)
      SELECT p.thread_id, p.proposer_company_id, NULL, 'system', '提案元の人材が利用できなくなったため、提案（' || ${label} || '）は取り下げになりました', 1, ?, p.proposal_id
      FROM board_proposals p WHERE p.proposal_id IN (${target})`).bind(now, ...binds),
    db.prepare(`UPDATE board_threads SET last_message_id = (SELECT MAX(m.message_id) FROM board_messages m WHERE m.thread_id = board_threads.thread_id), last_message_at = ?
      WHERE thread_id IN (SELECT p.thread_id FROM board_proposals p WHERE p.proposal_id IN (${target}))`).bind(now, ...binds),
    db.prepare(`UPDATE board_proposals SET status = 'withdrawn', updated_at = ?, decided_at = ? WHERE proposal_id IN (${target})`).bind(now, now, ...binds),
  ])
  return res[2].meta.changes || 0
}

// ---------- 第4段階: 採用した人材を自社スタッフマスタへ取り込む ----------
// 取り込んだ行は partner_manual（取引先所属）、所属会社名 = 提案企業名（取引先マスタにも登録）。
// 基本項目・業務側項目は採用時点の開示内容（氏名 + スナップショット）をコピーし、以後は自社で編集（提案元とは同期しない）。
// 経路は board_proposals.upstream_chain にだけ残り、取り込んだ行には提案IDだけを記録する（頭超え防止）
boardApi.post('/proposals/:id/import', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const p = await db.prepare(`SELECT p.*, co.company_name AS proposer_company_name, ${IMPORTED_ALIVE}, bp.engagement_type, bp.source_project_id, bp.date_from, bp.company_id AS post_company_id
    FROM board_proposals p JOIN companies co ON co.company_id = p.proposer_company_id JOIN board_posts bp ON bp.post_id = p.post_id WHERE p.proposal_id = ?`)
    .bind(c.req.param('id')).first() as any
  if (!p || p.receiver_company_id !== u.company_id) return c.json({ error: '提案が見つかりません' }, 404)
  if (p.status !== 'adopted') return c.json({ error: '採用した提案だけ取り込めます' }, 400)
  if (p.imported_staff_id) {
    if (p.imported_alive) return c.json({ error: 'この提案はすでにスタッフマスタに取り込み済みです', staff_id: p.imported_alive }, 409)
    // 取り込んだ行が削除されている場合は取り込み直せる
    await db.prepare('UPDATE board_proposals SET imported_staff_id = NULL WHERE proposal_id = ? AND imported_staff_id = ?').bind(p.proposal_id, p.imported_staff_id).run()
  }
  const b = await c.req.json().catch(() => ({} as any))
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  // スポット掲載で自社案件と紐づいている場合はシフト割当への導線を返す
  const shift = p.engagement_type === 'spot' && p.source_project_id && p.post_company_id === u.company_id
    ? { project_id: p.source_project_id, date_from: p.date_from || null } : null

  // 同じ人がすでに自社のスタッフマスタにいるか（同じ提案元の同じスタッフを以前に取り込んだ行・同じ人物の連携行など。#135）
  const existing = await sameProposedPerson(db, p, u.company_id)
  if (existing.length && b.mode !== 'link' && b.mode !== 'new') {
    return c.json({ error: '同じ人がすでにスタッフマスタに登録されています。登録済みのスタッフに紐づけるか、別の行として登録するかを選んでください', need_choice: true,
      existing: existing.map(x => ({ staff_id: x.staff_id, name: x.name, via_board: !!x.via_board })) }, 409)
  }
  if (b.mode === 'link') {
    const target = existing.find(x => x.staff_id === Number(b.staff_id))
    if (!target) return c.json({ error: '紐づけるスタッフが見つかりません' }, 400)
    // 新しい行は作らず、この提案の取り込み先として登録済みのスタッフを記録する（提案の履歴は board_proposals に残る）
    const upd = await db.prepare('UPDATE board_proposals SET imported_staff_id = ?, updated_at = ? WHERE proposal_id = ? AND imported_staff_id IS NULL')
      .bind(target.staff_id, nowJST(), p.proposal_id).run()
    if (!upd.meta.changes) return c.json({ error: 'この提案はすでにスタッフマスタに取り込み済みです' }, 409)
    await addMessage(db, p.thread_id, u.company_id, null, 'system', `${own?.company_name || ''}が採用した人材をスタッフマスタに登録しました`, true)
    return c.json({ ok: true, staff_id: target.staff_id, linked: true, shift })
  }
  // 同じ人の行があるのに別の行として登録するときは仮登録にし、あとから「既存のスタッフに統合」でまとめられるようにする
  const provisional = existing.length ? 1 : 0
  const sn = (() => { try { return JSON.parse(p.snapshot) } catch { return {} } })()
  const dis = (() => { try { return JSON.parse(p.disclosed || '{}') } catch { return {} } })()
  const name = String(dis.name || '').trim() || `候補者No.${p.proposal_id}`
  const partnerName = String(p.proposer_company_name || '').trim()
  // 取引先マスタ（提案企業名）
  await db.prepare('INSERT OR IGNORE INTO staff_affiliations (company_id, affiliation_name) VALUES (?, ?)').bind(u.company_id, partnerName).run()
  const pa = await db.prepare('SELECT affiliation_id FROM staff_affiliations WHERE company_id = ? AND affiliation_name = ?').bind(u.company_id, partnerName).first() as any
  const person = await createPerson(db, u.company_id)
  let userId: number
  try {
    const r = await db.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, person_id) VALUES (?, ?, ?, 'roster_only', ?, ?)`)
      .bind(u.company_id, 'BD-' + person.global_staff_code, name, await unusablePasswordHash(), person.person_id).run()
    userId = r.meta.last_row_id as number
  } catch {
    await db.prepare('DELETE FROM persons WHERE person_id = ?').bind(person.person_id).run()
    return c.json({ error: '取り込みに失敗しました。もう一度お試しください' }, 500)
  }
  const careerRows = Array.isArray(sn.career_rows) ? sn.career_rows.map((x: any) => ({ from: x.from || '', to: x.to || '', company: x.company || '', work: x.work || '', note: '' })) : []
  // 提案元が記録した本人同意（取得方法・日付）も引き継ぐ（#502）
  const consentLine = p.consent_method ? `本人の同意: ${CONSENT_METHODS[p.consent_method] || p.consent_method}（${p.consent_obtained_on || '日付なし'}・提案元の記録）` : ''
  const remarks = [`掲示板経由（提案: ${partnerName}）`, p.proposed_price ? `提示単価: ${({ hourly: '時給', daily: '日給', monthly: '月給' } as any)[p.price_unit] || ''}${Number(p.proposed_price).toLocaleString()}円` : '', p.comment ? `提案コメント: ${p.comment}` : '', consentLine].filter(Boolean).join('\n')
  const sr = await db.prepare(`INSERT INTO staff_profiles
      (user_id, company_id, person_id, owner_company_id, affiliation_type, partner_affiliation_id, affiliation,
       kana, gender, age_group, skills, career, career_rows, pr_points, remarks, work_area, nearest_station, commute_minutes, available_from, employment_status, board_proposal_id, is_provisional)
      VALUES (?, ?, ?, ?, 'partner_manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)`)
    .bind(userId, u.company_id, person.person_id, u.company_id, pa?.affiliation_id ?? null, partnerName,
      dis.kana || null, sn.gender || 'unspecified', sn.age_group || null, sn.skills || '', sn.career || '', JSON.stringify(careerRows), sn.pr_points || '', remarks,
      sn.work_area || '', sn.nearest_station || null, sn.commute_minutes ?? null, sn.available_from || null, p.proposal_id, provisional).run()
  const staffId = sr.meta.last_row_id as number
  // 二重取り込み防止（同時押下でも1件だけ有効にする）
  const upd = await db.prepare('UPDATE board_proposals SET imported_staff_id = ?, updated_at = ? WHERE proposal_id = ? AND imported_staff_id IS NULL')
    .bind(staffId, nowJST(), p.proposal_id).run()
  if (!upd.meta.changes) {
    await db.prepare('DELETE FROM staff_profiles WHERE staff_id = ?').bind(staffId).run()
    await db.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run()
    await db.prepare('DELETE FROM persons WHERE person_id = ?').bind(person.person_id).run()
    return c.json({ error: 'この提案はすでにスタッフマスタに取り込み済みです' }, 409)
  }
  await addMessage(db, p.thread_id, u.company_id, null, 'system', `${own?.company_name || ''}が採用した人材をスタッフマスタに登録しました`, true)
  return c.json({ ok: true, staff_id: staffId, shift, provisional: !!provisional })
})

/**
 * 取り込もうとしている人材と同じ人の、自社のスタッフ行（統合済みは統合先に読み替える）。
 * - 同じ提案元の同じスタッフ（または同じ人物）を、以前の提案で取り込んだ行
 * - 提案元のスタッフと同じ人物の、自社の行（QR/ID 連携の行や、自社が所属元の行）
 */
async function sameProposedPerson(db: D1Database, p: any, companyId: number): Promise<{ staff_id: number; name: string; via_board: boolean }[]> {
  const src = await db.prepare('SELECT person_id FROM staff_profiles WHERE staff_id = ?').bind(p.staff_id).first() as any
  const person = src?.person_id || null
  const rows = (await db.prepare(`SELECT DISTINCT COALESCE(sp.merged_into_staff_id, sp.staff_id) AS sid, 1 AS via_board
      FROM board_proposals q JOIN staff_profiles sp ON sp.staff_id = q.imported_staff_id AND sp.company_id = q.receiver_company_id
      LEFT JOIN staff_profiles ps ON ps.staff_id = q.staff_id
      WHERE q.receiver_company_id = ? AND q.proposal_id != ? AND ((q.proposer_company_id = ? AND q.staff_id = ?) OR (? IS NOT NULL AND ps.person_id = ?))
    UNION SELECT COALESCE(sp.merged_into_staff_id, sp.staff_id) AS sid, 0 AS via_board FROM staff_profiles sp WHERE sp.company_id = ? AND ? IS NOT NULL AND sp.person_id = ?`)
    .bind(companyId, p.proposal_id, p.proposer_company_id, p.staff_id, person, person, companyId, person, person).all()).results as any[]
  const ids = [...new Set(rows.map(r => Number(r.sid)))]
  if (!ids.length) return []
  const viaBoard = new Set(rows.filter(r => r.via_board).map(r => Number(r.sid)))
  const list = (await db.prepare(`SELECT sp.staff_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    WHERE sp.company_id = ? AND sp.merged_into_staff_id IS NULL AND sp.staff_id IN ${JSON_IN} ORDER BY sp.staff_id`).bind(companyId, bindJsonArray(ids)).all()).results as any[]
  return list.map(r => ({ staff_id: r.staff_id, name: r.name, via_board: viaBoard.has(r.staff_id) }))
}

export default boardApi
