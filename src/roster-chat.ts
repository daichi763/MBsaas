// =========================================================
// 企業間チャット（所属元 ⇔ 稼働先 担当者）フェーズG
// ・/api/admin/roster-chat 配下のみ（/admin/* の ADMIN_ROLES ミドルウェアで role='staff' は 403）
// ・スタッフ本人向けAPI（/api/staff/*）には一切ルートを持たない
// =========================================================
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type Variables = { user: any }
const chatApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const CHAT_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff', 'system_admin']
const MAX_BODY = 2000

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
  const rows = await db.prepare(`
    SELECT sp.staff_id AS thread_staff_id, sp.company_id AS host_company_id, sp.owner_company_id,
           hc.company_name AS host_company_name, oc.company_name AS owner_company_name, us.name AS staff_name,
           sp.source_staff_id,
           (SELECT MAX(rc.comment_id) FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id) AS last_comment_id,
           (SELECT rc.body FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id ORDER BY rc.comment_id DESC LIMIT 1) AS last_body,
           (SELECT rc.created_at FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id ORDER BY rc.comment_id DESC LIMIT 1) AS last_at,
           (SELECT COUNT(*) FROM roster_comments rc WHERE rc.thread_staff_id = sp.staff_id AND rc.author_company_id != ?
              AND rc.comment_id > COALESCE((SELECT r.last_read_comment_id FROM roster_comment_reads r WHERE r.thread_staff_id = sp.staff_id AND r.company_id = ?), 0)) AS unread
    FROM staff_profiles sp
    JOIN companies hc ON hc.company_id = sp.company_id JOIN companies oc ON oc.company_id = sp.owner_company_id
    JOIN users us ON us.user_id = sp.user_id
    WHERE sp.affiliation_type = 'linked_external' AND (sp.company_id = ? OR sp.owner_company_id = ?)
    ORDER BY (last_comment_id IS NULL), last_comment_id DESC LIMIT 200`).bind(u.company_id, u.company_id, u.company_id, u.company_id).all()
  const threads = (rows.results as any[]).map(t => ({
    ...t,
    my_side: t.host_company_id === u.company_id ? 'host' : 'owner',
    partner_company_name: t.host_company_id === u.company_id ? t.owner_company_name : t.host_company_name,
    // 自社画面で開くべき staff_id（稼働先=連携行 / 所属元=元スタッフ行）
    open_staff_id: t.host_company_id === u.company_id ? t.thread_staff_id : t.source_staff_id,
  }))
  const unread_total = threads.reduce((a, t) => a + (t.unread || 0), 0)
  return c.json({ threads, unread_total })
})

// 未読件数のみ（ダッシュボード/サイドバーのバッジ用・軽量）
chatApi.get('/unread-count', async (c) => {
  const u = c.get('user')
  const r = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n FROM roster_comments rc
    WHERE (rc.owner_company_id = ? OR rc.host_company_id = ?) AND rc.author_company_id != ?
      AND rc.comment_id > COALESCE((SELECT r.last_read_comment_id FROM roster_comment_reads r WHERE r.thread_staff_id = rc.thread_staff_id AND r.company_id = ?), 0)`)
    .bind(u.company_id, u.company_id, u.company_id, u.company_id).first()
  return c.json({ unread: (r?.n as number) || 0 })
})

// メッセージ取得（全履歴）。取得時に自社として既読化する
chatApi.get('/:staffId', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const t = await resolveThread(db, u.company_id, c.req.param('staffId'), c.req.query('host_staff_id'))
  if (!t) return c.json({ error: 'スレッドが見つかりません' }, 404)
  const rows = await db.prepare(`
    SELECT rc.comment_id, rc.body, rc.created_at, rc.author_company_id, um.name AS author_name, co.company_name AS author_company_name
    FROM roster_comments rc LEFT JOIN users um ON um.user_id = rc.author_user_id LEFT JOIN companies co ON co.company_id = rc.author_company_id
    WHERE rc.thread_staff_id = ? ORDER BY rc.comment_id`).bind(t.thread_staff_id).all()
  const msgs = (rows.results as any[]).map(m => ({ ...m, mine: m.author_company_id === u.company_id }))
  const last = msgs.length ? msgs[msgs.length - 1].comment_id : 0
  if (last) {
    await db.prepare(`INSERT INTO roster_comment_reads (thread_staff_id, company_id, last_read_comment_id, read_by, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_staff_id, company_id) DO UPDATE SET last_read_comment_id = MAX(last_read_comment_id, excluded.last_read_comment_id), read_by = excluded.read_by, read_at = excluded.read_at`)
      .bind(t.thread_staff_id, u.company_id, last, u.user_id, nowJST()).run()
  }
  return c.json({ thread: { ...t, my_side: t.host_company_id === u.company_id ? 'host' : 'owner' }, messages: msgs })
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
  const r = await db.prepare(`INSERT INTO roster_comments (thread_staff_id, owner_company_id, host_company_id, author_company_id, author_user_id, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(t.thread_staff_id, t.owner_company_id, t.host_company_id, u.company_id, u.user_id, body, nowJST()).run()
  const id = r.meta.last_row_id as number
  // 自分の投稿は自社既読として扱う
  await db.prepare(`INSERT INTO roster_comment_reads (thread_staff_id, company_id, last_read_comment_id, read_by, read_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(thread_staff_id, company_id) DO UPDATE SET last_read_comment_id = MAX(last_read_comment_id, excluded.last_read_comment_id), read_by = excluded.read_by, read_at = excluded.read_at`)
    .bind(t.thread_staff_id, u.company_id, id, u.user_id, nowJST()).run()
  return c.json({ ok: true, comment_id: id })
})

export default chatApi
