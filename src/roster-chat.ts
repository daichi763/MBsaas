// =========================================================
// 企業間チャット（所属元 ⇔ 稼働先 担当者）フェーズG
// ・/api/admin/roster-chat 配下のみ（/admin/* の ADMIN_ROLES ミドルウェアで role='staff' は 403）
// ・スタッフ本人向けAPI（/api/staff/*）には一切ルートを持たない
// =========================================================
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const chatApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const CHAT_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
const MAX_BODY = 2000
const DUPLICATE_WINDOW_SEC = 60 // 同じ本文の再送を重複とみなす秒数（#263）

function nowJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

// 念のためのロールチェック（/admin/* ミドルウェアと二重）
chatApi.use('/*', async (c, next) => {
  if (!CHAT_ROLES.includes(c.get('user').role)) return c.json({ error: 'forbidden' }, 403)
  return next()
})

/**
 * 画面の staff_id（自社のスタッフマスタ行）からスレッドを解決する。
 * - 稼働先で開いた場合: その行自体（linked_external）がスレッド
 * - 所属元で開いた場合: host_staff_id（その自社スタッフを連携している稼働先行）を指定
 * 自社が owner/host のどちらにも該当しないスレッドは null（=アクセス不可）
 */
async function resolveThread(db: D1Database, companyId: number, staffId: string, hostStaffId?: string | null) {
  const mine = await db.prepare('SELECT staff_id, affiliation_type, source_staff_id FROM staff_profiles WHERE staff_id = ? AND company_id = ?')
    .bind(staffId, companyId).first()
  if (!mine) return null
  let threadId: number | null = null
  // 多段連携: 中間企業は「所属元（1つ前）とのスレッド」と「自社が連携した先とのスレッド」の両方を持つ。
  // host_staff_id を指定したら連携先とのスレッド、指定しなければ（連携行なら）所属元とのスレッド
  if (mine.affiliation_type === 'linked_external' && !hostStaffId) threadId = mine.staff_id as number
  else if (hostStaffId) {
    const t = await db.prepare(`SELECT staff_id FROM staff_profiles WHERE staff_id = ? AND source_staff_id = ? AND affiliation_type = 'linked_external'`)
      .bind(hostStaffId, mine.staff_id).first()
    threadId = t ? (t.staff_id as number) : null
  }
  if (!threadId) return null
  const t = await db.prepare(`
    SELECT sp.staff_id AS thread_staff_id, sp.company_id AS host_company_id, sp.owner_company_id,
           hc.company_name AS host_company_name, oc.company_name AS owner_company_name, us.name AS staff_name
    FROM staff_profiles sp JOIN companies hc ON hc.company_id = sp.company_id JOIN companies oc ON oc.company_id = sp.owner_company_id
    JOIN users us ON us.user_id = sp.user_id
    WHERE sp.staff_id = ? AND sp.affiliation_type = 'linked_external'`).bind(threadId).first()
  if (!t) return null
  if (t.host_company_id !== companyId && t.owner_company_id !== companyId) return null
  return t as any
}

// スレッド一覧（自社が参加する全スレッド + 未読数）— ダッシュボード通知・一覧画面用
chatApi.get('/threads', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const floor = await unreadFloor(db, u.user_id)
  const rows = await db.prepare(`
    SELECT sp.staff_id AS thread_staff_id, sp.company_id AS host_company_id, sp.owner_company_id,
           hc.company_name AS host_company_name, oc.company_name AS owner_company_name, us.name AS staff_name,
           sp.source_staff_id,
           (SELECT MAX(rc.comment_id) FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id) AS last_comment_id,
           (SELECT rc.body FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id ORDER BY rc.comment_id DESC LIMIT 1) AS last_body,
           (SELECT rc.created_at FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id ORDER BY rc.comment_id DESC LIMIT 1) AS last_at,
           (SELECT COUNT(*) FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id AND rc.author_company_id != ? AND rc.created_at >= ?
              AND rc.comment_id > ${userReadSql('sp.staff_id')}) AS unread
    FROM staff_profiles sp
    JOIN companies hc ON hc.company_id = sp.company_id JOIN companies oc ON oc.company_id = sp.owner_company_id
    JOIN users us ON us.user_id = sp.user_id
    WHERE sp.affiliation_type = 'linked_external' AND (sp.company_id = ? OR sp.owner_company_id = ?)
    ORDER BY (last_comment_id IS NULL), last_comment_id DESC LIMIT 200`).bind(u.company_id, floor, u.user_id, u.company_id, u.company_id).all()
  const threads = (rows.results as any[]).map(t => ({
    ...t,
    my_side: t.host_company_id === u.company_id ? 'host' : 'owner',
    partner_company_name: t.host_company_id === u.company_id ? t.owner_company_name : t.host_company_name,
    // 自社画面で開くべき staff_id（稼働先=連携行 / 所属元=元スタッフ行）
    open_staff_id: t.host_company_id === u.company_id ? t.thread_staff_id : t.source_staff_id,
    ended: false,
  }))
  // 区分の変更などで連携が終わったスレッド（閲覧のみ）。未読件数（/unread-count）と同じく、やり取りの記録の所属元・稼働先で数える（#237）
  const ended = (await endedThreads(db, u.company_id, u.user_id, floor)).map(t => ({
    ...t,
    my_side: t.host_company_id === u.company_id ? 'host' : 'owner',
    partner_company_name: t.host_company_id === u.company_id ? t.owner_company_name : t.host_company_name,
    open_staff_id: null, ended: true,
  }))
  const all = [...threads, ...ended].sort((a, b) => (b.last_comment_id || 0) - (a.last_comment_id || 0))
  const unread_total = all.reduce((a, t) => a + (t.unread || 0), 0)
  return c.json({ threads: all, unread_total })
})

/**
 * 連携が終わったスレッド: 自社が所属元・稼働先として参加したやり取りがあり、スレッドの行がもう自社の連携行（linked_external）でないもの。
 * 稼働先が「区分を変更」で自社管理に切り替えると、行は残るが連携行ではなくなる（#237）。
 * 未読件数はやり取りの記録（owner_company_id / host_company_id）で数えるため、ここで一覧に出し、開いて既読にできるようにする
 */
async function endedThreads(db: D1Database, companyId: number, userId: number, floor: string) {
  const rows = await db.prepare(`
    WITH t AS (
      SELECT rc.thread_staff_id, MAX(rc.comment_id) AS last_comment_id
      FROM roster_comments rc LEFT JOIN staff_profiles sp ON sp.staff_id = rc.thread_staff_id
      WHERE (rc.owner_company_id = ? OR rc.host_company_id = ?)
        AND NOT (COALESCE(sp.affiliation_type, '') = 'linked_external' AND (sp.company_id = ? OR sp.owner_company_id = ?))
      GROUP BY rc.thread_staff_id
    )
    SELECT t.thread_staff_id, t.last_comment_id, lc.owner_company_id, lc.host_company_id, lc.body AS last_body, lc.created_at AS last_at,
           hc.company_name AS host_company_name, oc.company_name AS owner_company_name, us.name AS staff_name,
           (SELECT COUNT(*) FROM roster_comments rc WHERE rc.thread_staff_id = t.thread_staff_id AND rc.author_company_id != ?
              AND (rc.owner_company_id = ? OR rc.host_company_id = ?) AND rc.created_at >= ?
              AND rc.comment_id > ${userReadSql('t.thread_staff_id')}) AS unread
    FROM t JOIN roster_comments lc ON lc.comment_id = t.last_comment_id
    LEFT JOIN companies hc ON hc.company_id = lc.host_company_id LEFT JOIN companies oc ON oc.company_id = lc.owner_company_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = t.thread_staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    ORDER BY t.last_comment_id DESC LIMIT 200`)
    .bind(companyId, companyId, companyId, companyId, companyId, companyId, companyId, floor, userId).all()
  return rows.results as any[]
}

/**
 * 既読はユーザー単位で数える（#462）。スタッフ詳細を開いただけでは既読にせず、チャット欄が画面に見えたとき・
 * 一覧から開いたとき・投稿したときに markRead を呼ぶ。会社単位の roster_comment_reads は「自社で最後に読んだ人」の記録として更新する。
 * 自分のユーザーができる前のメッセージは未読に数えない（後から加わった担当者に、過去のやり取りが一斉に未読で出ないように）
 */
function userReadSql(threadExpr: string): string {
  return `COALESCE((SELECT ur.last_read_comment_id FROM roster_comment_user_reads ur WHERE ur.thread_staff_id = ${threadExpr} AND ur.user_id = ?), 0)`
}
async function unreadFloor(db: D1Database, userId: number): Promise<string> {
  // users.created_at は UTC（CURRENT_TIMESTAMP）、roster_comments.created_at は日本時間
  const r = await db.prepare(`SELECT datetime(created_at, '+9 hours') AS f FROM users WHERE user_id = ?`).bind(userId).first() as any
  return (r && r.f) || ''
}
async function markRead(db: D1Database, threadStaffId: number, companyId: number, commentId: number, userId: number) {
  const now = nowJST()
  await db.batch([
    db.prepare(`INSERT INTO roster_comment_user_reads (thread_staff_id, user_id, company_id, last_read_comment_id, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_staff_id, user_id) DO UPDATE SET last_read_comment_id = MAX(last_read_comment_id, excluded.last_read_comment_id), read_at = excluded.read_at`)
      .bind(threadStaffId, userId, companyId, commentId, now),
    db.prepare(`INSERT INTO roster_comment_reads (thread_staff_id, company_id, last_read_comment_id, read_by, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_staff_id, company_id) DO UPDATE SET last_read_comment_id = MAX(last_read_comment_id, excluded.last_read_comment_id), read_by = excluded.read_by, read_at = excluded.read_at`)
      .bind(threadStaffId, companyId, commentId, userId, now),
  ])
}

// 未読件数のみ（ダッシュボード/サイドバーのバッジ用・軽量）。ログイン中のユーザーが読んでいない件数
chatApi.get('/unread-count', async (c) => {
  const u = c.get('user')
  const floor = await unreadFloor(c.env.DB, u.user_id)
  const r = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n FROM roster_comments rc
    WHERE (rc.owner_company_id = ? OR rc.host_company_id = ?) AND rc.author_company_id != ? AND rc.created_at >= ?
      AND rc.comment_id > ${userReadSql('rc.thread_staff_id')}`)
    .bind(u.company_id, u.company_id, u.company_id, floor, u.user_id).first()
  return c.json({ unread: (r?.n as number) || 0 })
})

// 連携が終わったスレッドのメッセージ（閲覧のみ・投稿はできない）。取得時に自社として既読にする（#237）
// 自社が所属元・稼働先として参加したやり取りだけを返す。連携中のスレッドはスタッフ詳細のチャット欄から開く
chatApi.get('/ended/:threadStaffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const tid = Number(c.req.param('threadStaffId'))
  if (!Number.isInteger(tid) || tid <= 0) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const rows = (await db.prepare(`
    SELECT rc.comment_id, rc.body, rc.created_at, rc.author_company_id, rc.owner_company_id, rc.host_company_id,
           um.name AS author_name, co.company_name AS author_company_name
    FROM roster_comments rc LEFT JOIN users um ON um.user_id = rc.author_user_id LEFT JOIN companies co ON co.company_id = rc.author_company_id
    WHERE rc.thread_staff_id = ? AND (rc.owner_company_id = ? OR rc.host_company_id = ?) ORDER BY rc.comment_id`).bind(tid, u.company_id, u.company_id).all()).results as any[]
  if (!rows.length) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const last = rows[rows.length - 1]
  const names = await db.prepare(`SELECT
      (SELECT company_name FROM companies WHERE company_id = ?) AS owner_company_name, (SELECT company_name FROM companies WHERE company_id = ?) AS host_company_name,
      (SELECT us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?) AS staff_name`)
    .bind(last.owner_company_id, last.host_company_id, tid).first() as any
  await markRead(db, tid, u.company_id, last.comment_id, u.user_id)
  const mySide = last.host_company_id === u.company_id ? 'host' : 'owner'
  return c.json({
    thread: { thread_staff_id: tid, my_side: mySide, ended: true, staff_name: names?.staff_name || null,
      partner_company_name: mySide === 'host' ? names?.owner_company_name : names?.host_company_name },
    messages: rows.map(m => ({ comment_id: m.comment_id, body: m.body, created_at: m.created_at, author_name: m.author_name,
      author_company_name: m.author_company_name, mine: m.author_company_id === u.company_id })),
  })
})

// メッセージ取得（全履歴）。取得しただけでは既読にしない（#462。既読は POST /:staffId/read）。
// 自社の担当者それぞれの既読位置（誰がどこまで読んだか）も返す
chatApi.get('/:staffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await resolveThread(db, u.company_id, c.req.param('staffId'), c.req.query('host_staff_id'))
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const [rows, reads, myRead] = await db.batch([
    db.prepare(`
      SELECT rc.comment_id, rc.body, rc.created_at, rc.author_company_id, um.name AS author_name, co.company_name AS author_company_name
      FROM roster_comments rc LEFT JOIN users um ON um.user_id = rc.author_user_id LEFT JOIN companies co ON co.company_id = rc.author_company_id
      WHERE rc.thread_staff_id = ? ORDER BY rc.comment_id`).bind(t.thread_staff_id),
    db.prepare(`SELECT ur.user_id, ur.last_read_comment_id, ur.read_at, us.name FROM roster_comment_user_reads ur JOIN users us ON us.user_id = ur.user_id
      WHERE ur.thread_staff_id = ? AND ur.company_id = ? AND ur.read_at IS NOT NULL ORDER BY ur.read_at DESC LIMIT 20`).bind(t.thread_staff_id, u.company_id),
    // 自分の既読位置は上の一覧（新しい20人）とは別に取る（担当者が多くても未読の印の位置がずれないように）
    db.prepare('SELECT last_read_comment_id FROM roster_comment_user_reads WHERE thread_staff_id = ? AND user_id = ?').bind(t.thread_staff_id, u.user_id),
  ])
  const msgs = (rows.results as any[]).map(m => ({ ...m, mine: m.author_company_id === u.company_id }))
  const readRows = reads.results as any[]
  const mine = (myRead.results as any[])[0]
  return c.json({
    thread: { ...t, my_side: t.host_company_id === u.company_id ? 'host' : 'owner' }, messages: msgs,
    my_last_read_comment_id: mine ? mine.last_read_comment_id : 0,
    reads: readRows.map(r => ({ name: r.name, last_read_comment_id: r.last_read_comment_id, read_at: r.read_at, me: r.user_id === u.user_id })),
  })
})

// 既読にする（チャット欄が画面に見えたとき・一覧から開いたとき）。last_comment_id まで（省略時は最新まで）を既読にする
chatApi.post('/:staffId/read', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const t = await resolveThread(db, u.company_id, c.req.param('staffId'), b.host_staff_id ? String(b.host_staff_id) : null)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const last = await db.prepare('SELECT MAX(comment_id) AS m FROM roster_comments WHERE thread_staff_id = ?').bind(t.thread_staff_id).first() as any
  let upTo = Number(last?.m) || 0
  const want = Number(b.last_comment_id)
  if (Number.isInteger(want) && want > 0) upTo = Math.min(upTo, want)
  if (upTo) await markRead(db, t.thread_staff_id, u.company_id, upTo, u.user_id)
  return c.json({ ok: true, last_read_comment_id: upTo })
})

// 投稿
chatApi.post('/:staffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  const body = String(b.body || '').trim()
  if (!body) return c.json({ error: 'メッセージを入力してください' }, 400)
  if (body.length > MAX_BODY) return c.json({ error: `メッセージは${MAX_BODY}文字以内で入力してください` }, 400)
  const t = await resolveThread(db, u.company_id, c.req.param('staffId'), b.host_staff_id)
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  // 同じ人が同じスレッドに同じ本文を短い間に送ったら、2件目は登録しない（二度押し・別タブ・API の直接呼び出し。持ち越し #263）。
  // 確かめるのと登録するのを1つの文で行い、同時に届いても1件だけにする
  const since = new Date(Date.now() + 9 * 3600 * 1000 - DUPLICATE_WINDOW_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const r = await db.prepare(`INSERT INTO roster_comments (thread_staff_id, owner_company_id, host_company_id, author_company_id, author_user_id, body, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM roster_comments WHERE thread_staff_id = ? AND author_user_id = ? AND body = ? AND created_at >= ?)`)
    .bind(t.thread_staff_id, t.owner_company_id, t.host_company_id, u.company_id, u.user_id, body, nowJST(), t.thread_staff_id, u.user_id, body, since).run()
  if (!r.meta.changes) {
    const dup = await db.prepare('SELECT MAX(comment_id) AS id FROM roster_comments WHERE thread_staff_id = ? AND author_user_id = ? AND body = ?')
      .bind(t.thread_staff_id, u.user_id, body).first() as any
    return c.json({ ok: true, comment_id: dup?.id ?? null, duplicate: true })
  }
  const id = r.meta.last_row_id as number
  // 自分の投稿までは既読として扱う
  await markRead(db, t.thread_staff_id, u.company_id, id, u.user_id)
  return c.json({ ok: true, comment_id: id })
})

export default chatApi
