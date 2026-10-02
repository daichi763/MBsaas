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
  return c.json({ posts: rows.map(r => shape(r, u.company_id)), open_counts: Object.fromEntries(counts.map(x => [x.engagement_type, x.n])) })
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
  return c.json({ post: shape(row, u.company_id) })
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

export default boardApi
