import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = { DB: D1Database; PHOTOS: R2Bucket }
type Variables = { user: any }

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ============ Utils ============
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
function todayJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}
function monthJST(): string { return todayJST().slice(0, 7) }
function nowJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}
function genToken(): string {
  const a = new Uint8Array(32); crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}

const REPORT_TYPES = ['wake_up', 'departure', 'check_in', 'check_out']
// 写真添付が必須の報告種別（入店報告・退店報告のみ）
const PHOTO_REQUIRED_TYPES = ['check_in', 'check_out']
const PHOTO_MAX_BYTES = 500 * 1024 // 圧縮後の許容上限（500KB）
const PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png']

// companies.settings_json (JSON文字列) から真偽値設定を安全に読み取る
function getCompanySetting(u: any, key: string, defaultValue: boolean): boolean {
  try {
    const s = JSON.parse(u.settings_json || '{}')
    return typeof s[key] === 'boolean' ? s[key] : defaultValue
  } catch {
    return defaultValue
  }
}

// 案件の photo_required_override (NULL=会社設定に従う / 1=必須 / 0=不要) を加味した実効値
function resolvePhotoRequired(u: any, projectOverride: number | null | undefined): boolean {
  const companyDefault = getCompanySetting(u, 'photo_required_attendance', true)
  return projectOverride === null || projectOverride === undefined ? companyDefault : !!projectOverride
}
const ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff', 'system_admin']

// ============ Auth ============
api.post('/auth/login', async (c) => {
  const { company_code, user_code, password } = await c.req.json()
  if (!company_code || !user_code || !password) return c.json({ error: '入力内容が不足しています' }, 400)
  const company = await c.env.DB.prepare('SELECT * FROM companies WHERE company_code = ?').bind(company_code).first()
  if (!company) return c.json({ error: '会社コードが正しくありません' }, 401)
  const hash = await sha256(password)
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE company_id = ? AND user_code = ? AND password_hash = ? AND status = "active"')
    .bind(company.company_id, user_code, hash).first()
  if (!user) return c.json({ error: 'ユーザーIDまたはパスワードが正しくありません' }, 401)

  const token = genToken()
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000)
  // 期限切れセッションの補助的な削除(主軸はCron Trigger、ここは即時性のための保険)
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < CURRENT_TIMESTAMP').bind(user.user_id).run()
  await c.env.DB.prepare('INSERT INTO sessions (token, user_id, company_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, user.user_id, user.company_id, expires.toISOString()).run()
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').bind(nowJST(), user.user_id).run()
  setCookie(c, 'session', token, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 30 * 24 * 3600 })

  const home = user.role === 'staff' ? '/staff' : user.role === 'system_admin' ? '/hq' : '/admin'
  return c.json({ ok: true, user: { user_id: user.user_id, name: user.name, role: user.role, company_name: company.company_name }, redirect: home })
})

api.post('/auth/logout', async (c) => {
  const token = getCookie(c, 'session')
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})

// 認証ミドルウェア
api.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/auth/login') || c.req.path.endsWith('/auth/logout')) return next()
  const token = getCookie(c, 'session')
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  const row = await c.env.DB.prepare(`
    SELECT u.*, s.expires_at, c.company_name, c.company_code, c.settings_json,
           sp.staff_id
    FROM sessions s JOIN users u ON s.user_id = u.user_id
    JOIN companies c ON u.company_id = c.company_id
    LEFT JOIN staff_profiles sp ON sp.user_id = u.user_id
    WHERE s.token = ?`).bind(token).first()
  if (!row || new Date(row.expires_at as string) < new Date()) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', row)
  return next()
})

api.get('/auth/me', (c) => {
  const u = c.get('user')
  return c.json({ user_id: u.user_id, name: u.name, role: u.role, company_name: u.company_name, staff_id: u.staff_id })
})

// 権限チェックミドルウェア
api.use('/admin/*', async (c, next) => {
  if (!ADMIN_ROLES.includes(c.get('user').role)) return c.json({ error: 'forbidden' }, 403)
  return next()
})
api.use('/hq/*', async (c, next) => {
  if (c.get('user').role !== 'system_admin') return c.json({ error: 'forbidden' }, 403)
  return next()
})

// =========================================================
// スタッフ側 API
// =========================================================

// スタッフホーム
api.get('/staff/home', async (c) => {
  const u = c.get('user'); const today = todayJST()
  const shift = await c.env.DB.prepare(`
    SELECT s.*, p.project_name, p.project_type, p.report_template_id, p.photo_required_override
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    WHERE s.staff_id = ? AND s.work_date = ? AND s.status != 'absent' LIMIT 1`)
    .bind(u.staff_id, today).first()

  let reports: Record<string, any> = {}
  let dailyReportDone = false
  if (shift) {
    const rows = await c.env.DB.prepare('SELECT report_type, reported_at, status FROM attendance_reports WHERE shift_id = ?').bind(shift.shift_id).all()
    for (const r of rows.results) reports[r.report_type as string] = r
    const dr = await c.env.DB.prepare('SELECT daily_report_id FROM daily_reports WHERE staff_id = ? AND work_date = ?').bind(u.staff_id, today).first()
    dailyReportDone = !!dr
  }

  // お知らせ (対象: all / 所属案件 / 個人)
  const notices = await c.env.DB.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = ?) AS is_read
    FROM notices n WHERE n.company_id = ?
      AND (n.target_type = 'all'
        OR (n.target_type = 'staff' AND (',' || n.target_ids || ',') LIKE '%,' || ? || ',%')
        OR (n.target_type = 'project' AND EXISTS (
             SELECT 1 FROM shifts sh WHERE sh.staff_id = ? AND (',' || n.target_ids || ',') LIKE '%,' || sh.project_id || ',%')))
    ORDER BY n.published_at DESC LIMIT 5`).bind(u.user_id, u.company_id, u.staff_id, u.staff_id).all()

  const openConsult = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM consultations WHERE staff_id = ? AND status != 'done' AND manager_reply IS NOT NULL`).bind(u.staff_id).first()

  return c.json({
    today, shift, reports, daily_report_done: dailyReportDone, notices: notices.results,
    replied_consultations: openConsult?.n || 0,
    photo_required_attendance: resolvePhotoRequired(u, shift ? (shift.photo_required_override as number | null) : undefined),
  })
})

// 勤怠報告
api.post('/staff/attendance', async (c) => {
  const u = c.get('user')
  const { shift_id, report_type, latitude, longitude, address } = await c.req.json()
  if (!REPORT_TYPES.includes(report_type)) return c.json({ error: '不正な報告種別です' }, 400)
  const shift = await c.env.DB.prepare('SELECT * FROM shifts WHERE shift_id = ? AND staff_id = ?').bind(shift_id, u.staff_id).first()
  if (!shift) return c.json({ error: 'シフトが見つかりません' }, 404)
  if (PHOTO_REQUIRED_TYPES.includes(report_type)) {
    const proj = await c.env.DB.prepare('SELECT photo_required_override FROM projects WHERE project_id = ?').bind(shift.project_id).first()
    if (resolvePhotoRequired(u, proj?.photo_required_override as number | null)) {
      return c.json({ error: 'この案件は写真の添付が必須です' }, 400)
    }
  }
  const dup = await c.env.DB.prepare('SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?').bind(shift_id, report_type).first()
  if (dup) return c.json({ error: 'すでに報告済みです' }, 409)

  // 遅延判定: 入店報告がシフト開始後なら late
  let status = 'normal'
  if (report_type === 'check_in') {
    const nowTime = nowJST().slice(11, 16)
    if (todayJST() === shift.work_date && nowTime > (shift.start_time as string)) status = 'late'
    if (latitude == null) status = status === 'late' ? 'late' : 'no_location'
  }
  await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, u.staff_id, shift_id, report_type, nowJST(), latitude ?? null, longitude ?? null, address ?? null, c.req.header('user-agent') || '', status).run()
  return c.json({ ok: true, status })
})

// 勤怠報告（写真必須：入店報告・退店報告専用）
// フロント側で圧縮済みのJPEG/PNGをmultipart/form-dataで受け取り、R2へ保存する
api.post('/staff/attendance-photo', async (c) => {
  const u = c.get('user')

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: '送信データの形式が不正です' }, 400)
  }

  const shift_id = form.get('shift_id')
  const report_type = form.get('report_type')
  const latitude = form.get('latitude')
  const longitude = form.get('longitude')
  const photo = form.get('photo')

  if (typeof report_type !== 'string' || !PHOTO_REQUIRED_TYPES.includes(report_type)) {
    return c.json({ error: '不正な報告種別です' }, 400)
  }
  if (typeof shift_id !== 'string' || !shift_id) return c.json({ error: 'シフト情報が不正です' }, 400)
  if (!(photo instanceof File) || photo.size === 0) return c.json({ error: '写真が添付されていません' }, 400)
  if (!PHOTO_ALLOWED_TYPES.includes(photo.type)) return c.json({ error: '対応していない画像形式です（JPEG/PNGのみ）' }, 400)
  if (photo.size > PHOTO_MAX_BYTES) return c.json({ error: '画像サイズが大きすぎます。圧縮に失敗している可能性があります' }, 400)

  const shift = await c.env.DB.prepare('SELECT * FROM shifts WHERE shift_id = ? AND staff_id = ?').bind(shift_id, u.staff_id).first()
  if (!shift) return c.json({ error: 'シフトが見つかりません' }, 404)
  const dup = await c.env.DB.prepare('SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?').bind(shift_id, report_type).first()
  if (dup) return c.json({ error: 'すでに報告済みです' }, 409)

  let status = 'normal'
  const lat = latitude != null && latitude !== '' ? Number(latitude) : null
  const lng = longitude != null && longitude !== '' ? Number(longitude) : null
  if (report_type === 'check_in') {
    const nowTime = nowJST().slice(11, 16)
    if (todayJST() === shift.work_date && nowTime > (shift.start_time as string)) status = 'late'
    if (lat == null) status = status === 'late' ? 'late' : 'no_location'
  }

  const ext = photo.type === 'image/png' ? 'png' : 'jpg'
  const key = `attendance/${u.company_id}/${u.staff_id}/${shift_id}/${report_type}_${Date.now()}.${ext}`

  try {
    const buf = await photo.arrayBuffer()
    await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: photo.type } })
  } catch {
    return c.json({ error: '写真のアップロードに失敗しました。通信環境を確認して再度お試しください' }, 502)
  }

  try {
    await c.env.DB.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, photo_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.company_id, u.staff_id, shift_id, report_type, nowJST(), lat, lng, null, c.req.header('user-agent') || '', status, key).run()
  } catch {
    // DB登録に失敗した場合はアップロード済みの写真を掃除する
    await c.env.PHOTOS.delete(key).catch(() => {})
    return c.json({ error: '報告の登録に失敗しました。もう一度お試しください' }, 500)
  }

  return c.json({ ok: true, status, photo_key: key })
})

// 勤怠報告に添付された写真の取得（同一会社のログインユーザーのみ閲覧可）
api.get('/staff/attendance-photo/*', async (c) => {
  const u = c.get('user')
  const key = c.req.path.replace('/api/staff/attendance-photo/', '')
  if (!key.startsWith(`attendance/${u.company_id}/`)) return c.json({ error: 'forbidden' }, 403)

  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.json({ error: 'not found' }, 404)
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
    'Cache-Control': 'private, max-age=3600',
  })
})

// 日報テンプレート取得
api.get('/staff/report-template/:projectId', async (c) => {
  const u = c.get('user')
  const p = await c.env.DB.prepare('SELECT report_template_id FROM projects WHERE project_id = ? AND company_id = ?').bind(c.req.param('projectId'), u.company_id).first()
  if (!p) return c.json({ error: 'not found' }, 404)
  const t = await c.env.DB.prepare('SELECT * FROM report_templates WHERE template_id = ?').bind(p.report_template_id).first()
  return c.json({ template: t ? { ...t, fields: JSON.parse(t.fields_json as string) } : null })
})

// 日報提出
api.post('/staff/daily-report', async (c) => {
  const u = c.get('user')
  const { project_id, shift_id, work_date, values, incident_flag, complaint_flag } = await c.req.json()
  const date = work_date || todayJST()
  const exists = await c.env.DB.prepare('SELECT daily_report_id FROM daily_reports WHERE staff_id = ? AND work_date = ? AND project_id = ?').bind(u.staff_id, date, project_id).first()
  if (exists) {
    await c.env.DB.prepare('UPDATE daily_reports SET report_values = ?, incident_flag = ?, complaint_flag = ?, submitted_at = ? WHERE daily_report_id = ?')
      .bind(JSON.stringify(values || {}), incident_flag ? 1 : 0, complaint_flag ? 1 : 0, nowJST(), exists.daily_report_id).run()
    return c.json({ ok: true, updated: true })
  }
  await c.env.DB.prepare(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, u.staff_id, project_id, shift_id ?? null, date, JSON.stringify(values || {}), incident_flag ? 1 : 0, complaint_flag ? 1 : 0, nowJST()).run()
  return c.json({ ok: true })
})

// 自分の日報一覧
api.get('/staff/my-reports', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT dr.*, p.project_name FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    WHERE dr.staff_id = ? ORDER BY dr.work_date DESC LIMIT 30`).bind(u.staff_id).all()
  return c.json({ reports: rows.results.map((r: any) => ({ ...r, values: JSON.parse(r.report_values) })) })
})

// シフト確認
api.get('/staff/shifts', async (c) => {
  const u = c.get('user')
  const month = c.req.query('month') || monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT s.*, p.project_name FROM shifts s JOIN projects p ON s.project_id = p.project_id
    WHERE s.staff_id = ? AND s.work_date LIKE ? ORDER BY s.work_date`).bind(u.staff_id, month + '%').all()
  return c.json({ shifts: rows.results, month })
})

// シフト希望提出
api.post('/staff/shifts/request', async (c) => {
  const u = c.get('user')
  const { work_date, start_time, end_time, project_id, memo } = await c.req.json()
  if (!work_date) return c.json({ error: '日付は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status, registered_by, memo)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`)
    .bind(u.company_id, u.staff_id, project_id || 0, work_date, start_time || '09:30', end_time || '19:00', u.user_id, memo || '希望提出').run()
  return c.json({ ok: true })
})

// お知らせ
api.get('/staff/notices', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = ?) AS is_read
    FROM notices n WHERE n.company_id = ?
      AND (n.target_type = 'all'
        OR (n.target_type = 'staff' AND (',' || n.target_ids || ',') LIKE '%,' || ? || ',%')
        OR (n.target_type = 'project' AND EXISTS (
             SELECT 1 FROM shifts sh WHERE sh.staff_id = ? AND (',' || n.target_ids || ',') LIKE '%,' || sh.project_id || ',%')))
    ORDER BY n.published_at DESC LIMIT 50`).bind(u.user_id, u.company_id, u.staff_id, u.staff_id).all()
  return c.json({ notices: rows.results })
})

api.post('/staff/notices/:id/read', async (c) => {
  const u = c.get('user')
  await c.env.DB.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?, ?)').bind(c.req.param('id'), u.user_id).run()
  return c.json({ ok: true })
})

// 自分の実績
api.get('/staff/performance', async (c) => {
  const u = c.get('user')
  const month = c.req.query('month') || monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT dr.work_date, dr.report_values, p.project_name, p.show_performance, dr.manager_comment
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    WHERE dr.staff_id = ? AND dr.work_date LIKE ? ORDER BY dr.work_date`).bind(u.staff_id, month + '%').all()
  const visible = rows.results.filter((r: any) => r.show_performance)
  const totals: Record<string, number> = {}
  const daily: any[] = []
  for (const r of visible as any[]) {
    const v = JSON.parse(r.report_values)
    const day: any = { date: r.work_date, project: r.project_name, comment: r.manager_comment }
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number') { totals[k] = (totals[k] || 0) + val; day[k] = val }
    }
    daily.push(day)
  }
  return c.json({ month, totals, daily })
})

// 相談・連絡
api.get('/staff/consultations', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare('SELECT * FROM consultations WHERE staff_id = ? ORDER BY created_at DESC LIMIT 30').bind(u.staff_id).all()
  return c.json({ consultations: rows.results })
})

api.post('/staff/consultations', async (c) => {
  const u = c.get('user')
  const { category, body, urgency, target_project_id, target_date } = await c.req.json()
  if (!category || !body) return c.json({ error: 'カテゴリと内容は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO consultations (company_id, staff_id, category, body, urgency, target_project_id, target_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, u.staff_id, category, body, urgency || 'normal', target_project_id ?? null, target_date ?? null, nowJST()).run()
  return c.json({ ok: true })
})

// =========================================================
// 管理者側 API
// =========================================================

// 管理者ダッシュボード
api.get('/admin/dashboard', async (c) => {
  const u = c.get('user'); const today = todayJST(); const month = monthJST()
  const db = c.env.DB; const cid = u.company_id

  // 本日のシフト + 勤怠状況
  const shifts = await db.prepare(`
    SELECT s.shift_id, s.staff_id, s.start_time, s.end_time, s.status, s.unit_price, s.location,
           p.project_id, p.project_name, us.name AS staff_name,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'wake_up') AS wake_up,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'departure') AS departure,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'check_in') AS check_in,
           (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id AND a.report_type = 'check_out') AS check_out
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id
    JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date = ? AND s.status IN ('confirmed','substitute')`).bind(cid, today).all()

  const active = shifts.results as any[]
  const revenue = active.reduce((a, s) => a + (s.unit_price || 0), 0)

  // 昨日までの日報未提出 (直近3日)
  const missingReports = await db.prepare(`
    SELECT s.work_date, us.name AS staff_name, s.staff_id, p.project_name
    FROM shifts s
    JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status = 'confirmed' AND s.work_date < ? AND s.work_date >= date(?, '-3 days')
      AND NOT EXISTS (SELECT 1 FROM daily_reports dr WHERE dr.staff_id = s.staff_id AND dr.work_date = s.work_date)
    ORDER BY s.work_date DESC`).bind(cid, today, today).all()

  // インシデント (直近7日)
  const incidents = await db.prepare(`
    SELECT dr.work_date, dr.incident_flag, dr.complaint_flag, us.name AS staff_name, dr.staff_id, p.project_name, dr.report_values
    FROM daily_reports dr
    JOIN projects p ON dr.project_id = p.project_id
    JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ? AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date >= date(?, '-7 days')
    ORDER BY dr.work_date DESC`).bind(cid, today).all()

  // 要フォロースタッフ
  const followStaff = await db.prepare(`
    SELECT sp.staff_id, us.name, sp.retention_risk, sp.memo, sp.evaluation_score
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.company_id = ? AND (sp.follow_flag = 1 OR sp.retention_risk != 'low')`).bind(cid).all()

  // 今月の案件別実績
  const projPerf = await db.prepare(`
    SELECT p.project_id, p.project_name,
      COUNT(dr.daily_report_id) AS report_count,
      SUM(COALESCE(json_extract(dr.report_values, '$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(dr.report_values, '$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(dr.report_values, '$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(dr.report_values, '$.kishuhen'),0)) AS kishuhen,
      SUM(COALESCE(json_extract(dr.report_values, '$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(dr.report_values, '$.seiyaku'),0)) AS seiyaku
    FROM projects p LEFT JOIN daily_reports dr ON dr.project_id = p.project_id AND dr.work_date LIKE ?
    WHERE p.company_id = ? AND p.status = 'active' GROUP BY p.project_id`).bind(month + '%', cid).all()

  // 未対応の相談
  const openConsults = await db.prepare(`
    SELECT co.*, us.name AS staff_name FROM consultations co
    JOIN staff_profiles sp ON co.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE co.company_id = ? AND co.status = 'open' ORDER BY co.created_at DESC`).bind(cid).all()

  // ===== 管理者ToDo (ルールベース) =====
  const todos: any[] = []
  // ルール1: 日報未提出3回以上
  const drCounts: Record<string, { name: string; count: number; staff_id: number }> = {}
  for (const m of missingReports.results as any[]) {
    const k = String(m.staff_id)
    drCounts[k] = drCounts[k] || { name: m.staff_name, count: 0, staff_id: m.staff_id }
    drCounts[k].count++
  }
  for (const v of Object.values(drCounts)) {
    if (v.count >= 3) todos.push({ level: 'high', text: `${v.name}さんが${v.count}日連続で日報未提出です。面談してください。`, staff_id: v.staff_id })
    else if (v.count >= 1) todos.push({ level: 'mid', text: `${v.name}さんの日報が${v.count}件未提出です。リマインドしてください。`, staff_id: v.staff_id })
  }
  // ルール2: 入店報告遅れが月2回以上
  const lateRows = await db.prepare(`
    SELECT a.staff_id, us.name, COUNT(*) AS n FROM attendance_reports a
    JOIN staff_profiles sp ON a.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE a.company_id = ? AND a.report_type = 'check_in' AND a.status = 'late' AND a.reported_at LIKE ?
    GROUP BY a.staff_id HAVING n >= 2`).bind(cid, month + '%').all()
  for (const r of lateRows.results as any[]) {
    todos.push({ level: 'mid', text: `${r.name}さんの入店報告が今月${r.n}回遅れています。前日確認を強化してください。`, staff_id: r.staff_id })
  }
  // ルール3: 欠勤が月2回以上
  const absRows = await db.prepare(`
    SELECT s.staff_id, us.name, COUNT(*) AS n FROM shifts s
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.status = 'absent' AND s.work_date LIKE ? GROUP BY s.staff_id HAVING n >= 2`).bind(cid, month + '%').all()
  for (const r of absRows.results as any[]) {
    todos.push({ level: 'high', text: `${r.name}さんの欠勤が今月${r.n}回です。離職リスク中として体調・状況確認をしてください。`, staff_id: r.staff_id })
  }
  // ルール4: インシデント増加案件
  const incByProj: Record<string, number> = {}
  for (const i of incidents.results as any[]) incByProj[i.project_name] = (incByProj[i.project_name] || 0) + 1
  for (const [pname, n] of Object.entries(incByProj)) {
    if (n >= 1) todos.push({ level: n >= 2 ? 'high' : 'mid', text: `${pname}で直近7日にインシデント/クレームが${n}件発生しています。内容を確認しクライアント共有を検討してください。` })
  }
  // ルール5: 未対応相談
  for (const co of openConsults.results as any[]) {
    todos.push({ level: co.urgency === 'high' ? 'high' : 'mid', text: `${co.staff_name}さんから相談（${catLabel(co.category)}）が届いています。返信してください。`, staff_id: co.staff_id })
  }

  return c.json({
    today, month,
    working_count: active.length,
    revenue_forecast: revenue,
    shifts: active,
    unreported: {
      wake_up: active.filter(s => !s.wake_up).map(s => ({ staff_id: s.staff_id, name: s.staff_name, project: s.project_name })),
      departure: active.filter(s => !s.departure).map(s => ({ staff_id: s.staff_id, name: s.staff_name, project: s.project_name })),
      check_in: active.filter(s => !s.check_in).map(s => ({ staff_id: s.staff_id, name: s.staff_name, project: s.project_name })),
    },
    missing_daily_reports: missingReports.results,
    incidents: (incidents.results as any[]).map(i => ({ ...i, values: JSON.parse(i.report_values) })),
    follow_staff: followStaff.results,
    project_performance: projPerf.results,
    open_consultations: openConsults.results,
    todos: todos.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1)),
    photo_required_attendance: getCompanySetting(u, 'photo_required_attendance', true),
  })
})

// 入店/退店報告の写真添付必須設定を切り替え
api.post('/admin/settings/photo-required', async (c) => {
  const u = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return c.json({ error: '不正なパラメータです' }, 400)

  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first()
  let settings: Record<string, any> = {}
  try { settings = JSON.parse((row?.settings_json as string) || '{}') } catch { settings = {} }
  settings.photo_required_attendance = body.enabled

  await c.env.DB.prepare('UPDATE companies SET settings_json = ? WHERE company_id = ?')
    .bind(JSON.stringify(settings), u.company_id).run()

  return c.json({ ok: true, photo_required_attendance: body.enabled })
})

function catLabel(cat: string): string {
  const m: Record<string, string> = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
  return m[cat] || cat
}

// スタッフ一覧
api.get('/admin/staff', async (c) => {
  const u = c.get('user'); const month = monthJST(); const today = todayJST()
  const rows = await c.env.DB.prepare(`
    SELECT sp.staff_id, sp.evaluation_score, sp.retention_risk, sp.follow_flag, sp.skills, sp.work_area,
           us.user_id, us.user_code, us.name, us.status,
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_days,
           (SELECT MAX(s.work_date) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date <= ? AND s.status = 'confirmed') AS last_work_date,
           (SELECT MAX(dr.work_date) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id) AS last_report_date,
           (SELECT COUNT(*) FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date = ?) AS today_shift,
           (SELECT COUNT(*) FROM attendance_reports a JOIN shifts s2 ON a.shift_id = s2.shift_id WHERE a.staff_id = sp.staff_id AND s2.work_date = ? AND a.report_type = 'check_in') AS today_checkin,
           (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.staff_id = sp.staff_id AND dr.work_date LIKE ?) AS month_seiyaku,
           (SELECT GROUP_CONCAT(DISTINCT p.project_name) FROM shifts s3 JOIN projects p ON s3.project_id = p.project_id WHERE s3.staff_id = sp.staff_id AND s3.work_date LIKE ?) AS projects
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.company_id = ? ORDER BY sp.staff_id`).bind(month + '%', today, today, today, month + '%', month + '%', u.company_id).all()
  return c.json({ staff: rows.results })
})

// スタッフ詳細
api.get('/admin/staff/:id', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const db = c.env.DB
  const profile = await db.prepare(`
    SELECT sp.*, us.user_code, us.name, us.email, us.phone, us.status, us.last_login_at
    FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(sid, u.company_id).first()
  if (!profile) return c.json({ error: 'not found' }, 404)

  const [shifts, attendance, reports, evals, follows] = await Promise.all([
    db.prepare(`SELECT s.*, p.project_name FROM shifts s JOIN projects p ON s.project_id = p.project_id WHERE s.staff_id = ? ORDER BY s.work_date DESC LIMIT 30`).bind(sid).all(),
    db.prepare(`SELECT a.*, s.work_date FROM attendance_reports a JOIN shifts s ON a.shift_id = s.shift_id WHERE a.staff_id = ? ORDER BY a.reported_at DESC LIMIT 40`).bind(sid).all(),
    db.prepare(`SELECT dr.*, p.project_name FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id WHERE dr.staff_id = ? ORDER BY dr.work_date DESC LIMIT 20`).bind(sid).all(),
    db.prepare(`SELECT * FROM evaluations WHERE staff_id = ? ORDER BY evaluation_period DESC LIMIT 6`).bind(sid).all(),
    db.prepare(`SELECT f.*, um.name AS manager_name FROM follow_logs f LEFT JOIN users um ON f.manager_id = um.user_id WHERE f.staff_id = ? ORDER BY f.created_at DESC LIMIT 20`).bind(sid).all(),
  ])
  // 月次実績推移 (直近3ヶ月)
  const perf = await db.prepare(`
    SELECT substr(work_date, 1, 7) AS ym,
      SUM(COALESCE(json_extract(report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(report_values,'$.seiyaku'),0)) AS seiyaku,
      COUNT(*) AS days
    FROM daily_reports WHERE staff_id = ? GROUP BY ym ORDER BY ym DESC LIMIT 3`).bind(sid).all()

  return c.json({
    profile,
    shifts: shifts.results,
    attendance: attendance.results,
    reports: (reports.results as any[]).map(r => ({ ...r, values: JSON.parse(r.report_values) })),
    evaluations: evals.results,
    follow_logs: follows.results,
    performance: perf.results,
  })
})

// スタッフ更新 (メモ・フォローフラグ・リスク)
api.put('/admin/staff/:id', async (c) => {
  const u = c.get('user')
  const { memo, follow_flag, retention_risk, skills, career, work_area } = await c.req.json()
  await c.env.DB.prepare(`UPDATE staff_profiles SET
      memo = COALESCE(?, memo), follow_flag = COALESCE(?, follow_flag), retention_risk = COALESCE(?, retention_risk),
      skills = COALESCE(?, skills), career = COALESCE(?, career), work_area = COALESCE(?, work_area)
    WHERE staff_id = ? AND company_id = ?`)
    .bind(memo ?? null, follow_flag ?? null, retention_risk ?? null, skills ?? null, career ?? null, work_area ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// スタッフ登録
api.post('/admin/staff', async (c) => {
  const u = c.get('user')
  const { user_code, name, password, email, phone, skills, career, work_area } = await c.req.json()
  if (!user_code || !name || !password) return c.json({ error: 'スタッフ番号・氏名・パスワードは必須です' }, 400)
  const hash = await sha256(password)
  try {
    const r = await c.env.DB.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone) VALUES (?, ?, ?, 'staff', ?, ?, ?)`)
      .bind(u.company_id, user_code, name, hash, email ?? null, phone ?? null).run()
    await c.env.DB.prepare(`INSERT INTO staff_profiles (user_id, company_id, affiliation, skills, career, work_area) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(r.meta.last_row_id, u.company_id, u.company_name, skills ?? '', career ?? '', work_area ?? '').run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: 'スタッフ番号が重複しています' }, 409)
  }
})

// スキルシート生成
api.get('/admin/staff/:id/skill-sheet', async (c) => {
  const u = c.get('user'); const sid = c.req.param('id')
  const profile = await c.env.DB.prepare(`
    SELECT sp.*, us.name FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(sid, u.company_id).first()
  if (!profile) return c.json({ error: 'not found' }, 404)
  const projects = await c.env.DB.prepare(`
    SELECT DISTINCT p.project_name, p.project_type FROM shifts s JOIN projects p ON s.project_id = p.project_id WHERE s.staff_id = ?`).bind(sid).all()
  const perf = await c.env.DB.prepare(`
    SELECT SUM(COALESCE(json_extract(report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(report_values,'$.seiyaku'),0)) AS seiyaku,
      COUNT(*) AS total_days
    FROM daily_reports WHERE staff_id = ?`).bind(sid).first()
  const latestEval = await c.env.DB.prepare('SELECT * FROM evaluations WHERE staff_id = ? ORDER BY evaluation_period DESC LIMIT 1').bind(sid).first()
  return c.json({ profile, experienced_projects: projects.results, performance: perf, evaluation: latestEval })
})

// クライアント
api.get('/admin/clients', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT cl.*, (SELECT GROUP_CONCAT(p.project_name) FROM projects p WHERE p.client_id = cl.client_id AND p.status = 'active') AS active_projects
    FROM clients cl WHERE cl.company_id = ? ORDER BY cl.client_id`).bind(u.company_id).all()
  return c.json({ clients: rows.results })
})

api.post('/admin/clients', async (c) => {
  const u = c.get('user')
  const b = await c.req.json()
  if (!b.client_name) return c.json({ error: 'クライアント名は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO clients (company_id, client_name, stream_type, contact_name, email, phone, address, contract_type, billing_rule, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.client_name, b.stream_type || 'upstream', b.contact_name ?? null, b.email ?? null, b.phone ?? null, b.address ?? null, b.contract_type ?? null, b.billing_rule ?? null, b.memo ?? null).run()
  return c.json({ ok: true })
})

// 案件一覧
api.get('/admin/projects', async (c) => {
  const u = c.get('user'); const month = monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT p.*, cl.client_name,
      (SELECT COUNT(DISTINCT s.staff_id) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date LIKE ?) AS staff_count,
      (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.project_id AND s.work_date LIKE ? AND s.status IN ('confirmed','substitute')) AS month_shifts,
      (SELECT SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) FROM daily_reports dr WHERE dr.project_id = p.project_id AND dr.work_date LIKE ?) AS month_seiyaku,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) AND dr.work_date LIKE ?) AS incidents
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id
    WHERE p.company_id = ? ORDER BY p.project_id`).bind(month + '%', month + '%', month + '%', month + '%', u.company_id).all()
  return c.json({ projects: rows.results, month })
})

// 案件詳細
api.get('/admin/projects/:id', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id'); const month = monthJST()
  const db = c.env.DB
  const project = await db.prepare(`
    SELECT p.*, cl.client_name, rt.template_name, rt.fields_json
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id
    LEFT JOIN report_templates rt ON p.report_template_id = rt.template_id
    WHERE p.project_id = ? AND p.company_id = ?`).bind(pid, u.company_id).first()
  if (!project) return c.json({ error: 'not found' }, 404)

  const staffPerf = await db.prepare(`
    SELECT dr.staff_id, us.name,
      COUNT(*) AS days,
      SUM(COALESCE(json_extract(dr.report_values,'$.mnp'),0)) AS mnp,
      SUM(COALESCE(json_extract(dr.report_values,'$.pi'),0)) AS pi,
      SUM(COALESCE(json_extract(dr.report_values,'$.shinki'),0)) AS shinki,
      SUM(COALESCE(json_extract(dr.report_values,'$.hikari'),0)) AS hikari,
      SUM(COALESCE(json_extract(dr.report_values,'$.seiyaku'),0)) AS seiyaku
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.project_id = ? AND dr.work_date LIKE ? GROUP BY dr.staff_id ORDER BY seiyaku DESC`).bind(pid, month + '%').all()

  const incidents = await db.prepare(`
    SELECT dr.work_date, dr.incident_flag, dr.complaint_flag, us.name AS staff_name, dr.report_values
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.project_id = ? AND (dr.incident_flag = 1 OR dr.complaint_flag = 1) ORDER BY dr.work_date DESC LIMIT 10`).bind(pid).all()

  const monthShifts = await db.prepare(`SELECT COUNT(*) AS n, SUM(unit_price) AS revenue FROM shifts WHERE project_id = ? AND work_date LIKE ? AND status IN ('confirmed','substitute')`).bind(pid, month + '%').first()

  return c.json({
    project: { ...project, template_fields: project.fields_json ? JSON.parse(project.fields_json as string) : [] },
    staff_performance: staffPerf.results,
    incidents: (incidents.results as any[]).map(i => ({ ...i, values: JSON.parse(i.report_values) })),
    month_summary: monthShifts, month,
    company_photo_default: getCompanySetting(u, 'photo_required_attendance', true),
  })
})

// 案件登録
api.post('/admin/projects', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.project_name) return c.json({ error: '案件名は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO projects (company_id, client_id, project_name, project_type, location, unit_price_type, unit_price, required_skills, report_template_id, requirements, manual_text, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.client_id ?? null, b.project_name, b.project_type || 'mobile_shop', b.location ?? null,
      b.unit_price_type || 'daily', b.unit_price || 0, b.required_skills ?? null, b.report_template_id ?? 1, b.requirements ?? null, b.manual_text ?? null, b.memo ?? null).run()
  return c.json({ ok: true })
})

// 案件ごとの入店/退店報告 写真添付オーバーライド更新
api.put('/admin/projects/:id/photo-required', async (c) => {
  const u = c.get('user'); const pid = c.req.param('id')
  const { override } = await c.req.json().catch(() => ({ override: undefined }))
  if (!['inherit', 'on', 'off'].includes(override)) return c.json({ error: '不正なパラメータです' }, 400)
  const value = override === 'inherit' ? null : override === 'on' ? 1 : 0

  const proj = await c.env.DB.prepare('SELECT project_id FROM projects WHERE project_id = ? AND company_id = ?').bind(pid, u.company_id).first()
  if (!proj) return c.json({ error: '案件が見つかりません' }, 404)

  await c.env.DB.prepare('UPDATE projects SET photo_required_override = ? WHERE project_id = ?').bind(value, pid).run()
  return c.json({ ok: true })
})

// シフト管理
api.get('/admin/shifts', async (c) => {
  const u = c.get('user')
  const from = c.req.query('from') || todayJST()
  const to = c.req.query('to') || from
  const rows = await c.env.DB.prepare(`
    SELECT s.*, p.project_name, us.name AS staff_name
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date BETWEEN ? AND ? ORDER BY s.work_date, s.start_time`).bind(u.company_id, from, to).all()
  return c.json({ shifts: rows.results })
})

api.post('/admin/shifts', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.staff_id || !b.project_id || !b.work_date) return c.json({ error: 'スタッフ・案件・日付は必須です' }, 400)
  const proj = await c.env.DB.prepare('SELECT location, unit_price FROM projects WHERE project_id = ?').bind(b.project_id).first()
  await c.env.DB.prepare(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, b.project_id, b.work_date, b.start_time || '09:30', b.end_time || '19:00',
      b.location || proj?.location || '', b.role || '販売スタッフ', b.unit_price ?? proj?.unit_price ?? 0, b.transportation_fee || 0,
      b.status || 'confirmed', u.user_id, b.memo ?? null).run()
  return c.json({ ok: true })
})

api.put('/admin/shifts/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  await c.env.DB.prepare(`UPDATE shifts SET
      status = COALESCE(?, status), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time),
      staff_id = COALESCE(?, staff_id), memo = COALESCE(?, memo)
    WHERE shift_id = ? AND company_id = ?`)
    .bind(b.status ?? null, b.start_time ?? null, b.end_time ?? null, b.staff_id ?? null, b.memo ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

api.delete('/admin/shifts/:id', async (c) => {
  const u = c.get('user')
  await c.env.DB.prepare('DELETE FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// 日報一覧
api.get('/admin/daily-reports', async (c) => {
  const u = c.get('user')
  const date = c.req.query('date')
  const projectId = c.req.query('project_id')
  let sql = `
    SELECT dr.*, p.project_name, us.name AS staff_name
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ?`
  const binds: any[] = [u.company_id]
  if (date) { sql += ' AND dr.work_date = ?'; binds.push(date) }
  if (projectId) { sql += ' AND dr.project_id = ?'; binds.push(projectId) }
  sql += ' ORDER BY dr.work_date DESC, dr.submitted_at DESC LIMIT 100'
  const rows = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ reports: (rows.results as any[]).map(r => ({ ...r, values: JSON.parse(r.report_values) })) })
})

// 日報コメント・確認
api.put('/admin/daily-reports/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  await c.env.DB.prepare('UPDATE daily_reports SET manager_comment = COALESCE(?, manager_comment), manager_checked = COALESCE(?, manager_checked) WHERE daily_report_id = ? AND company_id = ?')
    .bind(b.manager_comment ?? null, b.manager_checked ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// 実績分析
api.get('/admin/analytics', async (c) => {
  const u = c.get('user'); const month = c.req.query('month') || monthJST()
  const db = c.env.DB; const cid = u.company_id
  const KEYS = ['mnp', 'pi', 'shinki', 'kishuhen', 'hikari', 'wifi', 'denki', 'card', 'koekake', 'shodan', 'seiyaku']
  const sel = KEYS.map(k => `SUM(COALESCE(json_extract(report_values,'$.${k}'),0)) AS ${k}`).join(',')

  const totals = await db.prepare(`SELECT ${sel}, COUNT(*) AS reports FROM daily_reports WHERE company_id = ? AND work_date LIKE ?`).bind(cid, month + '%').first()
  const daily = await db.prepare(`SELECT work_date, ${sel} FROM daily_reports WHERE company_id = ? AND work_date LIKE ? GROUP BY work_date ORDER BY work_date`).bind(cid, month + '%').all()
  const byStaff = await db.prepare(`
    SELECT dr.staff_id, us.name, COUNT(*) AS days, ${sel.replace(/report_values/g, 'dr.report_values')}
    FROM daily_reports dr JOIN staff_profiles sp ON dr.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY dr.staff_id ORDER BY seiyaku DESC`).bind(cid, month + '%').all()
  const byProject = await db.prepare(`
    SELECT dr.project_id, p.project_name, COUNT(*) AS days, ${sel.replace(/report_values/g, 'dr.report_values')}
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id
    WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY dr.project_id`).bind(cid, month + '%').all()
  const byClient = await db.prepare(`
    SELECT cl.client_name, COUNT(*) AS days, ${sel.replace(/report_values/g, 'dr.report_values')}
    FROM daily_reports dr JOIN projects p ON dr.project_id = p.project_id JOIN clients cl ON p.client_id = cl.client_id
    WHERE dr.company_id = ? AND dr.work_date LIKE ? GROUP BY cl.client_id`).bind(cid, month + '%').all()

  return c.json({ month, totals, daily: daily.results, by_staff: byStaff.results, by_project: byProject.results, by_client: byClient.results })
})

// お知らせ配信
api.get('/admin/notices', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM notice_reads r WHERE r.notice_id = n.notice_id) AS read_count,
      (SELECT COUNT(*) FROM users us WHERE us.company_id = n.company_id AND us.role = 'staff' AND us.status = 'active') AS staff_total
    FROM notices n WHERE n.company_id = ? ORDER BY n.published_at DESC LIMIT 50`).bind(u.company_id).all()
  return c.json({ notices: rows.results })
})

api.post('/admin/notices', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.title) return c.json({ error: 'タイトルは必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO notices (company_id, title, body, target_type, target_ids, importance, read_required, published_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.title, b.body ?? '', b.target_type || 'all', b.target_ids ?? '', b.importance || 'normal', b.read_required ? 1 : 0, nowJST(), u.user_id).run()
  return c.json({ ok: true })
})

// お知らせ既読状況
api.get('/admin/notices/:id/reads', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT us.name, r.read_at FROM notice_reads r JOIN users us ON r.user_id = us.user_id WHERE r.notice_id = ?`).bind(c.req.param('id')).all()
  const unread = await c.env.DB.prepare(`
    SELECT us.name FROM users us WHERE us.company_id = ? AND us.role = 'staff' AND us.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = ? AND r.user_id = us.user_id)`).bind(u.company_id, c.req.param('id')).all()
  return c.json({ read: rows.results, unread: unread.results })
})

// 相談対応
api.get('/admin/consultations', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT co.*, us.name AS staff_name FROM consultations co
    JOIN staff_profiles sp ON co.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE co.company_id = ? ORDER BY co.created_at DESC LIMIT 50`).bind(u.company_id).all()
  return c.json({ consultations: rows.results })
})

api.put('/admin/consultations/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  await c.env.DB.prepare('UPDATE consultations SET manager_reply = COALESCE(?, manager_reply), status = COALESCE(?, status) WHERE consultation_id = ? AND company_id = ?')
    .bind(b.manager_reply ?? null, b.status ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// フォロー履歴
api.get('/admin/follow-logs', async (c) => {
  const u = c.get('user')
  const staffId = c.req.query('staff_id')
  let sql = `SELECT f.*, us.name AS staff_name, um.name AS manager_name
    FROM follow_logs f JOIN staff_profiles sp ON f.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    LEFT JOIN users um ON f.manager_id = um.user_id WHERE f.company_id = ?`
  const binds: any[] = [u.company_id]
  if (staffId) { sql += ' AND f.staff_id = ?'; binds.push(staffId) }
  sql += ' ORDER BY f.created_at DESC LIMIT 50'
  const rows = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ logs: rows.results })
})

api.post('/admin/follow-logs', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  if (!b.staff_id || !b.follow_type) return c.json({ error: 'スタッフと種別は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO follow_logs (company_id, staff_id, manager_id, follow_type, content, next_action, status, related_project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.company_id, b.staff_id, u.user_id, b.follow_type, b.content ?? '', b.next_action ?? null, b.status || 'open', b.related_project_id ?? null, nowJST()).run()
  return c.json({ ok: true })
})

api.put('/admin/follow-logs/:id', async (c) => {
  const u = c.get('user'); const b = await c.req.json()
  await c.env.DB.prepare('UPDATE follow_logs SET status = COALESCE(?, status), next_action = COALESCE(?, next_action) WHERE follow_id = ? AND company_id = ?')
    .bind(b.status ?? null, b.next_action ?? null, c.req.param('id'), u.company_id).run()
  return c.json({ ok: true })
})

// 請求前確認
api.get('/admin/billing-check', async (c) => {
  const u = c.get('user'); const month = c.req.query('month') || monthJST()
  const rows = await c.env.DB.prepare(`
    SELECT p.project_id, p.project_name, cl.client_name,
      COUNT(CASE WHEN s.status IN ('confirmed','substitute') THEN 1 END) AS work_days,
      COUNT(CASE WHEN s.status = 'absent' THEN 1 END) AS absent_days,
      COUNT(CASE WHEN s.status = 'substitute' THEN 1 END) AS substitute_days,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.unit_price ELSE 0 END) AS total_amount,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.transportation_fee ELSE 0 END) AS total_transport,
      COUNT(DISTINCT s.staff_id) AS staff_count,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.project_id = p.project_id AND dr.work_date LIKE ?) AS report_count
    FROM projects p LEFT JOIN clients cl ON p.client_id = cl.client_id
    LEFT JOIN shifts s ON s.project_id = p.project_id AND s.work_date LIKE ? AND s.work_date <= ?
    WHERE p.company_id = ? GROUP BY p.project_id`).bind(month + '%', month + '%', todayJST(), u.company_id).all()

  // スタッフ別明細
  const detail = await c.env.DB.prepare(`
    SELECT s.staff_id, us.name, p.project_name,
      COUNT(CASE WHEN s.status IN ('confirmed','substitute') THEN 1 END) AS work_days,
      COUNT(CASE WHEN s.status = 'absent' THEN 1 END) AS absent_days,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.unit_price ELSE 0 END) AS amount,
      SUM(CASE WHEN s.status IN ('confirmed','substitute') THEN s.transportation_fee ELSE 0 END) AS transport
    FROM shifts s JOIN projects p ON s.project_id = p.project_id
    JOIN staff_profiles sp ON s.staff_id = sp.staff_id JOIN users us ON sp.user_id = us.user_id
    WHERE s.company_id = ? AND s.work_date LIKE ? AND s.work_date <= ?
    GROUP BY s.staff_id, s.project_id ORDER BY p.project_id, us.name`).bind(u.company_id, month + '%', todayJST()).all()

  return c.json({ month, by_project: rows.results, detail: detail.results })
})

// テンプレート一覧 (企業側から参照)
api.get('/admin/templates', async (c) => {
  const u = c.get('user')
  const rows = await c.env.DB.prepare('SELECT * FROM report_templates WHERE company_id IS NULL OR company_id = ? ORDER BY template_id').bind(u.company_id).all()
  return c.json({ templates: (rows.results as any[]).map(t => ({ ...t, fields: JSON.parse(t.fields_json) })) })
})

// =========================================================
// SaaS本部 API
// =========================================================
api.get('/hq/companies', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT co.*,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND u.status = 'active') AS user_count,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = co.company_id AND u.last_login_at >= date('now', '-7 days')) AS active_users,
      (SELECT COUNT(*) FROM daily_reports dr WHERE dr.company_id = co.company_id AND dr.work_date >= date('now', '-30 days')) AS reports_30d
    FROM companies co ORDER BY co.company_id`).all()
  // 料金計算: 基本990円(3ユーザー) + 追加1ユーザー300円
  const companies = (rows.results as any[]).map(co => ({
    ...co,
    monthly_fee: 990 + Math.max(0, (co.user_count || 0) - 3) * 300
  }))
  return c.json({ companies })
})

api.get('/hq/companies/:id', async (c) => {
  const cid = c.req.param('id')
  const company = await c.env.DB.prepare('SELECT * FROM companies WHERE company_id = ?').bind(cid).first()
  if (!company) return c.json({ error: 'not found' }, 404)
  const users = await c.env.DB.prepare('SELECT user_id, user_code, name, role, status, last_login_at FROM users WHERE company_id = ? ORDER BY user_id').bind(cid).all()
  const stats = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM daily_reports WHERE company_id = ?) AS total_reports,
      (SELECT COUNT(*) FROM shifts WHERE company_id = ?) AS total_shifts,
      (SELECT COUNT(*) FROM attendance_reports WHERE company_id = ?) AS total_attendance,
      (SELECT COUNT(*) FROM projects WHERE company_id = ? AND status = 'active') AS active_projects`).bind(cid, cid, cid, cid).first()
  return c.json({ company, users: users.results, stats })
})

api.put('/hq/companies/:id', async (c) => {
  const b = await c.req.json()
  await c.env.DB.prepare(`UPDATE companies SET
      plan = COALESCE(?, plan), user_limit = COALESCE(?, user_limit), active_status = COALESCE(?, active_status),
      billing_status = COALESCE(?, billing_status), support_memo = COALESCE(?, support_memo), maturity_level = COALESCE(?, maturity_level)
    WHERE company_id = ?`)
    .bind(b.plan ?? null, b.user_limit ?? null, b.active_status ?? null, b.billing_status ?? null, b.support_memo ?? null, b.maturity_level ?? null, c.req.param('id')).run()
  return c.json({ ok: true })
})

api.post('/hq/companies', async (c) => {
  const b = await c.req.json()
  if (!b.company_code || !b.company_name) return c.json({ error: '会社コードと会社名は必須です' }, 400)
  try {
    const r = await c.env.DB.prepare('INSERT INTO companies (company_code, company_name, plan, user_limit, active_status) VALUES (?, ?, ?, ?, ?)')
      .bind(b.company_code, b.company_name, b.plan || 'basic', b.user_limit || 3, 'trial').run()
    // 初期管理者作成
    if (b.admin_code && b.admin_password) {
      const hash = await sha256(b.admin_password)
      await c.env.DB.prepare(`INSERT INTO users (company_id, user_code, name, role, password_hash) VALUES (?, ?, ?, 'company_admin', ?)`)
        .bind(r.meta.last_row_id, b.admin_code, b.admin_name || '管理者', hash).run()
    }
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: '会社コードが重複しています' }, 409)
  }
})

// テンプレート配信管理
api.get('/hq/templates', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM report_templates ORDER BY template_id').all()
  return c.json({ templates: (rows.results as any[]).map(t => ({ ...t, fields: JSON.parse(t.fields_json) })) })
})

api.post('/hq/templates', async (c) => {
  const b = await c.req.json()
  if (!b.template_name || !b.fields) return c.json({ error: 'テンプレート名と項目は必須です' }, 400)
  await c.env.DB.prepare(`INSERT INTO report_templates (company_id, template_name, template_type, fields_json) VALUES (NULL, ?, 'hq', ?)`)
    .bind(b.template_name, JSON.stringify(b.fields)).run()
  return c.json({ ok: true })
})

export default api
