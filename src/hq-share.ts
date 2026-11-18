// 本部画面「使い回しの疑い」の API（Sprint 31 #9989。/api/hq/share-detect。system_admin だけ。会社の画面には出さない）
//   GET  /share-detect                      … 集計の一覧（直近）と、選んだ集計（既定は最後に成功した集計）の疑いのあるアカウント。
//                                             company_id を付けると、その企業の分を集計をまたいで新しい順に（企業詳細）
//   GET  /share-detect/summary              … 最後の集計の未確認の件数（上のタブの数字）
//   POST /share-detect/run                  … 今すぐ集計する（5分に1回まで）
//   PUT  /share-detect/items/:id/review     … 確認の結果（未確認・問題なし・会社に連絡した）とメモ
//   PUT  /share-detect/settings             … 判定の決まりの値
// 見つけるだけで、ログインを止めたり締め出したりはしない（利用者の決定 11/18）。集計の仕組みは src/lib/share-detect.ts
import { Hono } from 'hono'
import { SHARE_SETTING_DEFS, SHARE_REASON_LABEL, SHARE_REASON_POINTS, SHARE_PERIOD_DAYS, getShareSettings, runShareDetection, weekStartJST, nextShareRunAt } from './lib/share-detect'
import { nowJST } from './lib/time'

type Env = { Bindings: { DB: D1Database }; Variables: { user: any; hqAudited?: boolean } }
export const hqShareApi = new Hono<Env>()

const RUNS_LIMIT = 12
const ITEMS_LIMIT = 500
const COMPANY_ITEMS_LIMIT = 50
const RUN_COOLDOWN_MINUTES = 5
const NOTE_MAX = 500
export const SHARE_REVIEW_STATUS: Record<string, string> = { open: '未確認', ok: '問題なし', contacted: '会社に連絡した' }

// 本部の操作の履歴（hq_audit_logs。api.ts の hqAuditStmt と同じ形）
function auditStmt(c: any, e: { action: string; company_id?: number | null; target?: string | null; before?: unknown; after?: unknown }) {
  c.set('hqAudited', true)
  const j = (v: unknown) => v === undefined || v === null ? null : JSON.stringify(v)
  return (c.env.DB as D1Database).prepare(`INSERT INTO hq_audit_logs (actor_user_id, action, company_id, target, before_json, after_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).bind(c.get('user')?.user_id ?? null, e.action, e.company_id ?? null, e.target ?? null, j(e.before), j(e.after), nowJST())
}
const posInt = (v: unknown) => /^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null

const ITEM_SELECT = `SELECT ss.suspicion_id, ss.run_id, ss.company_id, ss.user_id, ss.score, ss.reasons_json, ss.period_from, ss.period_to, ss.first_at, ss.last_at,
    ss.review_status, ss.review_note, ss.reviewed_at, ss.created_at, rv.name AS reviewer_name,
    u.user_code, u.name, u.role, u.status AS user_status, co.company_name, co.company_code
  FROM share_suspicions ss LEFT JOIN users u ON u.user_id = ss.user_id LEFT JOIN companies co ON co.company_id = ss.company_id
  LEFT JOIN users rv ON rv.user_id = ss.reviewed_by`
function itemView(r: any) {
  let reasons: any[] = []
  try { reasons = JSON.parse(r.reasons_json || '[]') } catch { reasons = [] }
  const { reasons_json, ...rest } = r
  return { ...rest, reasons }
}

hqShareApi.get('/share-detect', async (c) => {
  const db = c.env.DB
  const companyId = posInt(c.req.query('company_id'))
  const runIdQ = posInt(c.req.query('run_id'))
  const runs = (await db.prepare(`SELECT run_id, trigger_type, status, period_from, period_to, flagged, rows_read, error_message, created_at, finished_at
    FROM share_detect_runs ORDER BY run_id DESC LIMIT ?`).bind(RUNS_LIMIT).all()).results as any[]
  let run: any = null
  let items: any[] = []
  if (companyId) {
    items = (await db.prepare(`${ITEM_SELECT} WHERE ss.company_id = ? ORDER BY ss.created_at DESC, ss.score DESC LIMIT ?`).bind(companyId, COMPANY_ITEMS_LIMIT).all()).results as any[]
  } else {
    run = runIdQ ? runs.find(r => r.run_id === runIdQ) || await db.prepare('SELECT * FROM share_detect_runs WHERE run_id = ?').bind(runIdQ).first()
      : runs.find(r => r.status === 'ok') || null
    if (runIdQ && !run) return c.json({ error: '集計が見つかりません' }, 404)
    if (run) items = (await db.prepare(`${ITEM_SELECT} WHERE ss.run_id = ? ORDER BY ss.score DESC, ss.suspicion_id LIMIT ?`).bind(run.run_id, ITEMS_LIMIT).all()).results as any[]
  }
  // 前に確認した結果（同じアカウントのほかの集計の行で、未確認でないもの。新しいもの1つ）
  const prev = new Map<number, any>()
  const uids = [...new Set(items.map(i => i.user_id))]
  if (uids.length) {
    const rows = (await db.prepare(`SELECT ss.user_id, ss.suspicion_id, ss.review_status, ss.review_note, ss.reviewed_at, ss.period_to, rv.name AS reviewer_name
      FROM share_suspicions ss LEFT JOIN users rv ON rv.user_id = ss.reviewed_by
      WHERE ss.user_id IN (SELECT value FROM json_each(?)) AND ss.review_status != 'open' ORDER BY ss.reviewed_at DESC LIMIT 1000`).bind(JSON.stringify(uids)).all()).results as any[]
    // アカウントごとにまとめてから引く（行が多いときに CPU 時間を使いすぎない）。
    // 前の集計の行（suspicion_id が小さい行）だけを見る（同じ日の手動と定期の集計は period_to が同じため、日付では比べない）
    const byUser = new Map<number, any[]>()
    for (const p of rows) { const a = byUser.get(p.user_id); if (a) a.push(p); else byUser.set(p.user_id, [p]) }
    for (const i of items) {
      const p = (byUser.get(i.user_id) || []).find(p => p.suspicion_id < i.suspicion_id)
      if (p) prev.set(i.suspicion_id, p)
    }
  }
  const latestOk = runs.find(r => r.status === 'ok' && r.trigger_type === 'cron')
  const doneThisWeek = !!latestOk && String(latestOk.created_at) >= weekStartJST()
  return c.json({
    runs, run, company_id: companyId,
    items: items.map(i => ({ ...itemView(i), previous_review: prev.get(i.suspicion_id) || null })),
    settings: await getShareSettings(db), defs: SHARE_SETTING_DEFS, reason_labels: SHARE_REASON_LABEL, reason_points: SHARE_REASON_POINTS,
    review_labels: SHARE_REVIEW_STATUS, period_days: SHARE_PERIOD_DAYS, next_run_at: nextShareRunAt(doneThisWeek),
  })
})

hqShareApi.get('/share-detect/summary', async (c) => {
  const r = await c.env.DB.prepare(`SELECT r.run_id, r.created_at, (SELECT COUNT(*) FROM share_suspicions ss WHERE ss.run_id = r.run_id AND ss.review_status = 'open') AS open_count
    FROM share_detect_runs r WHERE r.status = 'ok' ORDER BY r.run_id DESC LIMIT 1`).first() as any
  return c.json({ run_id: r?.run_id ?? null, run_at: r?.created_at ?? null, open: Number(r?.open_count) || 0 })
})

hqShareApi.post('/share-detect/run', async (c) => {
  const db = c.env.DB
  const recent = await db.prepare('SELECT run_id FROM share_detect_runs WHERE created_at >= ? LIMIT 1').bind(nowJST(-RUN_COOLDOWN_MINUTES * 60000)).first()
  if (recent) return c.json({ error: `集計は${RUN_COOLDOWN_MINUTES}分に1回までです。少し待ってからお試しください` }, 429)
  const r = await runShareDetection(db, { trigger: 'manual', by: c.get('user')?.user_id ?? null })
  await auditStmt(c, { action: 'share.run', after: { run_id: r.run_id, flagged: r.flagged, rows_read: r.rows_read } }).run()
  if (r.status !== 'ok') return c.json({ error: '集計に失敗しました。時間をおいてもう一度お試しください', run: r }, 500)
  return c.json({ ok: true, run: r })
})

hqShareApi.put('/share-detect/items/:id/review', async (c) => {
  const db = c.env.DB
  const id = posInt(c.req.param('id'))
  const b = await c.req.json().catch(() => ({} as any))
  const status = String(b?.status ?? '')
  if (!SHARE_REVIEW_STATUS[status]) return c.json({ error: '確認の結果を選んでください' }, 400)
  const note = String(b?.note ?? '').trim()
  if (note.length > NOTE_MAX) return c.json({ error: `メモは${NOTE_MAX}文字までにしてください` }, 400)
  const cur = id ? await db.prepare(`SELECT ss.suspicion_id, ss.company_id, ss.review_status, ss.review_note, u.user_code, u.name FROM share_suspicions ss
    LEFT JOIN users u ON u.user_id = ss.user_id WHERE ss.suspicion_id = ?`).bind(id).first() as any : null
  if (!cur) return c.json({ error: '見つかりません' }, 404)
  const open = status === 'open'
  await db.batch([
    db.prepare('UPDATE share_suspicions SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE suspicion_id = ?')
      .bind(status, note || null, open ? null : c.get('user')?.user_id ?? null, open ? null : nowJST(), id),
    auditStmt(c, { action: 'share.review', company_id: cur.company_id, target: `${cur.user_code || ''} ${cur.name || ''}`.trim(),
      before: { review_status: cur.review_status, review_note: cur.review_note || null }, after: { review_status: status, review_note: note || null } }),
  ])
  return c.json({ ok: true })
})

hqShareApi.put('/share-detect/settings', async (c) => {
  const db = c.env.DB
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return c.json({ error: '入力が正しくありません' }, 400)
  const before = await getShareSettings(db)
  const stmts: D1PreparedStatement[] = []
  const changed: Record<string, number> = {}, was: Record<string, number> = {}
  for (const [k, d] of Object.entries(SHARE_SETTING_DEFS)) {
    if (b[k] === undefined) continue
    const v = Number(b[k])
    if (!Number.isInteger(v) || v < d.min || v > d.max || (d.options && !d.options[v])) {
      return c.json({ error: `${d.label}は ${d.min}〜${d.max} の整数で入力してください`, field: k }, 400)
    }
    if (v === (before as any)[k]) continue
    changed[k] = v; was[k] = (before as any)[k]
    stmts.push(db.prepare(`INSERT INTO share_detect_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(k, v, c.get('user')?.user_id ?? null, nowJST()))
  }
  if (!stmts.length) return c.json({ ok: true, changed: 0, settings: before })
  stmts.push(auditStmt(c, { action: 'share.settings', before: was, after: changed }))
  await db.batch(stmts)
  return c.json({ ok: true, changed: Object.keys(changed).length, settings: await getShareSettings(db) })
})
