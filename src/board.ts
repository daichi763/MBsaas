// =========================================================
// 案件掲示板 第1段階: 掲載・一覧・詳細（docs/spec_board.md）
// - /api/admin/board/* 配下のみ（/admin/* の ADMIN_ROLES ミドルウェアの後に登録）。スタッフ本人には公開しない
// - 掲載企業名は公開。公開範囲は全利用企業。単価は必須（備考で「応相談」等を付けられる）
// - 他社に返すのは掲載内容と掲載企業名のみ（コピー元の自社案件・作成者などの社内情報は返さない）
// =========================================================
import { Hono } from 'hono'

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

// 締切日を過ぎた掲載を「締切」にする（cron を使わない遅延処理。一覧・詳細を開いたときに実行）
async function closeExpired(db: D1Database) {
  await db.prepare(`UPDATE board_posts SET status = 'closed', updated_at = ? WHERE status = 'open' AND deadline IS NOT NULL AND deadline < ?`)
    .bind(nowJST(), todayJST()).run()
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
  }
  return { v }
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
  else w.push(`bp.status = 'open'`)
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
  const counts = (await db.prepare(`SELECT engagement_type, COUNT(*) AS n FROM board_posts WHERE status = 'open' GROUP BY engagement_type`).all()).results as any[]
  // 一覧にやり取りの有無・未読を付ける（自社が参加しているスレッドのみ）
  const ids = rows.map(r => r.post_id)
  const tmap: Record<number, { threads: number; unread: number }> = {}
  if (ids.length) {
    const ts = (await db.prepare(`SELECT t.post_id, COUNT(*) AS threads, SUM(${UNREAD_SQL}) AS unread FROM board_threads t
      WHERE t.post_id IN (${ids.map(() => '?').join(',')}) AND (t.poster_company_id = ? OR t.inquirer_company_id = ?) GROUP BY t.post_id`)
      .bind(u.company_id, u.company_id, ...ids, u.company_id, u.company_id).all()).results as any[]
    for (const x of ts) tmap[x.post_id] = { threads: x.threads, unread: x.unread || 0 }
  }
  return c.json({ posts: rows.map(r => ({ ...shape(r, u.company_id), thread_count: tmap[r.post_id]?.threads || 0, unread: tmap[r.post_id]?.unread || 0 })), open_counts: Object.fromEntries(counts.map(x => [x.engagement_type, x.n])) })
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
  const post = shape(row, u.company_id)
  if (post.is_mine) {
    // 掲載企業: 問い合わせ件数と未読
    const r = await db.prepare(`SELECT COUNT(*) AS n, SUM(${UNREAD_SQL}) AS unread FROM board_threads t WHERE t.post_id = ?`).bind(u.company_id, u.company_id, row.post_id).first() as any
    post.thread_count = r?.n || 0; post.unread = r?.unread || 0
  } else {
    // 問い合わせ企業: 自社のスレッド
    const t = await db.prepare(`SELECT t.thread_id, t.status, ${UNREAD_SQL} AS unread FROM board_threads t WHERE t.post_id = ? AND t.inquirer_company_id = ?`)
      .bind(u.company_id, u.company_id, row.post_id, u.company_id).first() as any
    post.my_thread = t || null
  }
  return c.json({ post })
})

// ---------- 自社案件からのコピー用 ----------
boardApi.get('/project-template/:projectId', async (c) => {
  const u = c.get('user')
  const p = await c.env.DB.prepare(`SELECT project_id, project_name, COALESCE(engagement_type,'regular') AS engagement_type, location, required_skills, requirements,
      unit_price, unit_price_type, pay_rate FROM projects WHERE project_id = ? AND company_id = ?`).bind(c.req.param('projectId'), u.company_id).first() as any
  if (!p) return c.json({ error: '案件が見つかりません' }, 404)
  // 掲示板に出す単価は「支払単価（pay_rate）」を優先し、なければ空欄（請求単価はそのまま出さない）
  const unitMap: any = { hourly: 'hourly', daily: 'daily', monthly: 'monthly' }
  return c.json({ template: {
    engagement_type: p.engagement_type, title: p.project_name, area: p.location || '', required_skills: p.required_skills || '',
    description: p.requirements || '', price_amount: p.pay_rate || '', price_unit: unitMap[p.unit_price_type] || 'daily', source_project_id: p.project_id,
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
  const cur = await db.prepare('SELECT * FROM board_posts WHERE post_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).first() as any
  if (!cur) return c.json({ error: '自社の掲載のみ編集できます' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const nextStatus = POST_STATUSES.includes(b.status) ? b.status : cur.status
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
  return c.json({ ok: true })
})

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
  const now = nowJST()
  await db.prepare(`UPDATE board_posts SET status = ?, published_at = CASE WHEN ? = 'open' AND published_at IS NULL THEN ? ELSE published_at END,
    updated_by = ?, updated_at = ? WHERE post_id = ?`).bind(b.status, b.status, now, u.user_id, now, cur.post_id).run()
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

async function addMessage(db: D1Database, threadId: number, companyId: number, userId: number | null, kind: string, body: string) {
  const now = nowJST()
  const r = await db.prepare(`INSERT INTO board_messages (thread_id, author_company_id, author_user_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(threadId, companyId, userId, kind, body, now).run()
  const id = r.meta.last_row_id as number
  await db.batch([
    db.prepare('UPDATE board_threads SET last_message_id = ?, last_message_at = ? WHERE thread_id = ?').bind(id, now, threadId),
    // 自社の投稿は自社既読として扱う
    db.prepare(`INSERT INTO board_thread_reads (thread_id, company_id, last_read_message_id, read_by, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, company_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), read_by = excluded.read_by, read_at = excluded.read_at`)
      .bind(threadId, companyId, id, userId, now),
  ])
  return id
}

// 未読はテキストのみ数える（「問い合わせが開始されました」等のシステムメッセージは数えない）
const UNREAD_SQL = `(SELECT COUNT(*) FROM board_messages m WHERE m.thread_id = t.thread_id AND m.author_company_id != ? AND m.kind != 'system'
   AND m.message_id > COALESCE((SELECT r.last_read_message_id FROM board_thread_reads r WHERE r.thread_id = t.thread_id AND r.company_id = ?), 0))`

// 問い合わせを開始する（既にあれば既存スレッドを返す）。自社の掲載・掲載中でない掲載には問い合わせできない
boardApi.post('/posts/:id/threads', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const post = await db.prepare('SELECT post_id, company_id, status FROM board_posts WHERE post_id = ?').bind(c.req.param('id')).first() as any
  if (!post || post.status === 'draft') return c.json({ error: '掲載が見つかりません' }, 404)
  if (post.company_id === u.company_id) return c.json({ error: '自社の掲載には問い合わせできません' }, 400)
  const exist = await db.prepare('SELECT thread_id FROM board_threads WHERE post_id = ? AND inquirer_company_id = ?').bind(post.post_id, u.company_id).first() as any
  if (exist) return c.json({ ok: true, thread_id: exist.thread_id, existed: true })
  if (post.status !== 'open') return c.json({ error: 'この掲載は募集を終了しています' }, 409)
  const b = await c.req.json().catch(() => ({} as any))
  const body = String(b.body || '').trim()
  if (!body) return c.json({ error: '最初のメッセージを入力してください' }, 400)
  if (body.length > MAX_BODY) return c.json({ error: `メッセージは${MAX_BODY}文字以内で入力してください` }, 400)
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
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 300`).bind(u.company_id, u.company_id, ...bind).all()).results as any[]
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
    WHERE (t.poster_company_id = ? OR t.inquirer_company_id = ?) AND m.author_company_id != ? AND m.kind != 'system'
      AND m.message_id > COALESCE((SELECT r.last_read_message_id FROM board_thread_reads r WHERE r.thread_id = t.thread_id AND r.company_id = ?), 0)`)
    .bind(u.company_id, u.company_id, u.company_id, u.company_id).first()
  return c.json({ unread: (r?.n as number) || 0 })
})

// メッセージ取得（全履歴）。取得時に自社として既読化する
boardApi.get('/threads/:id', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await loadThread(db, c.req.param('id'), u.company_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const rows = (await db.prepare(`SELECT m.message_id, m.kind, m.body, m.created_at, m.author_company_id, um.name AS author_name, co.company_name AS author_company_name
    FROM board_messages m LEFT JOIN users um ON um.user_id = m.author_user_id LEFT JOIN companies co ON co.company_id = m.author_company_id
    WHERE m.thread_id = ? ORDER BY m.message_id`).bind(t.thread_id).all()).results as any[]
  const msgs = rows.map(m => ({ ...m, mine: m.author_company_id === u.company_id, author_name: m.kind === 'system' ? null : m.author_name }))
  const last = msgs.length ? msgs[msgs.length - 1].message_id : 0
  if (last) {
    await db.prepare(`INSERT INTO board_thread_reads (thread_id, company_id, last_read_message_id, read_by, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, company_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), read_by = excluded.read_by, read_at = excluded.read_at`)
      .bind(t.thread_id, u.company_id, last, u.user_id, nowJST()).run()
  }
  const { created_by: _cb, ...thread } = t
  return c.json({ thread, messages: msgs })
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
  await db.prepare('UPDATE board_threads SET status = ? WHERE thread_id = ?').bind(b.status, t.thread_id).run()
  const own = await db.prepare('SELECT company_name FROM companies WHERE company_id = ?').bind(u.company_id).first()
  await addMessage(db, t.thread_id, u.company_id, null, 'system', `${own?.company_name || ''}がやり取りを${b.status === 'closed' ? '終了' : '再開'}しました`)
  return c.json({ ok: true })
})

export default boardApi
