// 案内（チュートリアル）の進み具合と、ダッシュボードの「はじめにやること」（利用者の決定 Sprint 15。#9711 #9712。w15-tour）
// 画面の仕組みは public/static/tour.js。進み具合は人（users の行）ごとに user_tour_progress（migrations/0094）に残す。
//   GET  /api/admin/tours・/api/staff/tours           … 自分の進み具合（{ progress: { tour_key: { status, step, updated_at } } }）
//   PUT  /api/admin/tours・/api/staff/tours           … 進み具合を残す（{ items: [{ key, status, step }] }。まとめて最大20件）
//   GET  /api/admin/tours/checklist                    … 「はじめにやること」の各項目が済んだか（実データから判定）と、出すかどうか
// /api/admin/* と /api/staff/* の権限のミドルウェア（api.ts）を通ってから呼ばれる。本部の閲覧中（読み取り専用）は書き込まない
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type Variables = { user: any }

// 本部の閲覧中（#293。ロールは閲覧用に置き換わり、hq_view が付く）
const isHqView = (u: any) => u?.role === 'system_admin' || !!u?.hq_view
function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }

// 案内を出す画面（管理画面）。tour.js の SCREEN_TOURS と同じ名前にする
export const ADMIN_TOUR_SCREENS = ['dashboard', 'clients', 'projects', 'staff', 'shifts', 'reports', 'corrections', 'settlement'] as const
export const TOUR_KEYS: Record<'admin' | 'staff', string[]> = {
  admin: ['admin-welcome', 'admin-checklist', ...ADMIN_TOUR_SCREENS.map(s => `admin-screen-${s}`)],
  staff: ['staff-welcome'],
}
export const TOUR_STATUSES = ['in_progress', 'done', 'skipped'] as const
const STEP_MAX = 99
const PUT_MAX = 20

// 「はじめにやること」の項目（表示の文言は tour.js）。会社のデータがあれば済んだとみなす
export const CHECKLIST_ITEMS = ['clients', 'projects', 'staff', 'shifts', 'logins'] as const

/**
 * 「はじめにやること」（会社管理者だけ）。
 * - 項目がすべて済んでいれば出さない（済んだときに 'done' を残し、後でデータが減っても出し直さない）
 * - 自分が閉じた（skipped）・済んだ（done）なら出さない。「？」から出し直したとき（in_progress）は出す
 * - 自分の記録がなく、同じ会社のほかの管理者が閉じた・済ませたなら出さない（2人目以降の管理者には出さない）
 */
export async function loadChecklist(db: D1Database, u: any) {
  if (u.role !== 'company_admin') return { show: false, items: null, completed_now: false }
  const cid = Number(u.company_id), uid = Number(u.user_id)
  const r = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM clients WHERE company_id = ?) AS clients,
      EXISTS(SELECT 1 FROM projects WHERE company_id = ?) AS projects,
      EXISTS(SELECT 1 FROM staff_profiles WHERE company_id = ?) AS staff,
      EXISTS(SELECT 1 FROM shifts WHERE company_id = ?) AS shifts,
      EXISTS(SELECT 1 FROM users WHERE company_id = ? AND role = 'staff' AND (last_login_at IS NOT NULL OR last_seen_at IS NOT NULL)) AS logins,
      (SELECT status FROM user_tour_progress WHERE user_id = ? AND tour_key = 'admin-checklist') AS mine,
      EXISTS(SELECT 1 FROM user_tour_progress WHERE company_id = ? AND tour_key = 'admin-checklist' AND user_id != ? AND status IN ('done', 'skipped')) AS others_closed`)
    .bind(cid, cid, cid, cid, cid, uid, cid, uid).first() as any
  const items: Record<string, boolean> = {}
  for (const k of CHECKLIST_ITEMS) items[k] = !!Number(r?.[k])
  const allDone = CHECKLIST_ITEMS.every(k => items[k])
  const mine = r?.mine as string | null
  if (allDone) {
    let completedNow = false
    if (mine !== 'done' && mine !== 'skipped') {
      await saveProgress(db, u, [{ key: 'admin-checklist', status: 'done', step: 0 }])
      completedNow = mine === 'in_progress' || !Number(r?.others_closed)
    }
    return { show: false, items, completed_now: completedNow }
  }
  const show = mine === 'in_progress' ? true : mine ? false : !Number(r?.others_closed)
  return { show, items, completed_now: false }
}

type ProgressItem = { key: string; status: string; step: number }
async function saveProgress(db: D1Database, u: any, items: ProgressItem[]) {
  const now = nowJST()
  await db.batch(items.map(it => db.prepare(`INSERT INTO user_tour_progress (user_id, company_id, tour_key, status, step, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, tour_key) DO UPDATE SET company_id = excluded.company_id, status = excluded.status, step = excluded.step, updated_at = excluded.updated_at`)
    .bind(Number(u.user_id), Number(u.company_id), it.key, it.status, it.step, now)))
}

/** 送られた進み具合を確かめる。誤りがあればその文言を返す */
export function parseProgressItems(app: 'admin' | 'staff', body: any): { items: ProgressItem[] } | { error: string } {
  const list = body && Array.isArray(body.items) ? body.items : null
  if (!list || !list.length) return { error: '保存する内容がありません' }
  if (list.length > PUT_MAX) return { error: `一度に保存できるのは${PUT_MAX}件までです` }
  const items: ProgressItem[] = []
  for (const x of list) {
    const key = String(x?.key ?? '')
    if (!TOUR_KEYS[app].includes(key)) return { error: '案内の種類が正しくありません' }
    const status = String(x?.status ?? '')
    if (!(TOUR_STATUSES as readonly string[]).includes(status)) return { error: '案内の状態が正しくありません' }
    const step = x?.step == null ? 0 : Number(x.step)
    if (!Number.isInteger(step) || step < 0 || step > STEP_MAX) return { error: '案内のステップが正しくありません' }
    // 同じ案内が2回あれば後のものを使う
    const i = items.findIndex(y => y.key === key)
    if (i >= 0) items.splice(i, 1)
    items.push({ key, status, step })
  }
  return { items }
}

function toursApi(app: 'admin' | 'staff') {
  const r = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  r.get('/tours', async (c) => {
    const u = c.get('user')
    // 本部の閲覧中（#293）は本部ユーザー自身の記録を持たない。画面は案内を見られるが、進み具合は残さない
    if (isHqView(u)) return c.json({ progress: {}, readonly: true })
    const rows = (await c.env.DB.prepare('SELECT tour_key, status, step, updated_at FROM user_tour_progress WHERE user_id = ?')
      .bind(Number(u.user_id)).all()).results as any[]
    const progress: Record<string, { status: string; step: number; updated_at: string }> = {}
    for (const x of rows) if (TOUR_KEYS[app].includes(x.tour_key)) progress[x.tour_key] = { status: x.status, step: Number(x.step) || 0, updated_at: x.updated_at }
    return c.json({ progress, readonly: false })
  })
  r.put('/tours', async (c) => {
    const u = c.get('user')
    if (isHqView(u)) return c.json({ error: '本部の閲覧中は保存できません' }, 403)
    const p = parseProgressItems(app, await c.req.json().catch(() => null))
    if ('error' in p) return c.json({ error: p.error }, 400)
    await saveProgress(c.env.DB, u, p.items)
    return c.json({ ok: true })
  })
  if (app === 'admin') {
    r.get('/tours/checklist', async (c) => {
      const u = c.get('user')
      if (isHqView(u)) return c.json({ show: false, items: null, completed_now: false })
      return c.json(await loadChecklist(c.env.DB, u))
    })
  }
  return r
}

export const toursAdminApi = toursApi('admin')
export const toursStaffApi = toursApi('staff')
