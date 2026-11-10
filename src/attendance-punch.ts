// =========================================================
// 打刻（スタッフ本人のアプリからの勤怠報告）の記録。POST /api/staff/attendance・/attendance-photo の本体（#9939）
//   混雑（D1 の過負荷）で打刻が失敗しないように:
//   ・読み込みは1往復（シフト・案件・開催場所・締め・報告・申請中・有効な報告の設定を db.batch でまとめて読む）、
//     書き込みも1往復（報告の追加と実績・金額の反映を同じ db.batch にする。途中で止まっても半端に残らない）
//   ・D1 の過負荷のエラーのときだけ、その場で短くやり直す（src/lib/d1-retry.ts）。それでも失敗したら 503 を返し、画面が間をあけて送り直す
//   ・画面は1回の打刻ごとに一意キー（client_request_id）を作り、送り直しても同じキーを送る。同じキーの打刻は2回記録せず、
//     1回目の結果をそのまま返す。写真の R2 のキーも一意キーから決める（送り直しで写真が増えない）
//   記録する時刻（利用者の決定）: 最初にボタンを押した時刻（端末の時計。pressed_at）を記録の時刻にする。ただし、
//     ・端末の今の時刻（device_now。送るたびに付ける）とサーバーの時刻が5分以上ずれている
//     ・押してから受け付けるまでが30分を超えた
//     ・押した時刻がサーバーの時刻より後（未来）
//   のときは、受け付けた時刻で記録する。押した時刻と受け付けた時刻が1分以上違えば「再送」の印（time_source）を付け、管理画面に出す。
//     time_source: 'device' = 押した時刻で記録（再送）、'resent' = 押した時刻は使わず受け付けた時刻で記録（再送）、NULL = 印なし
//   受付の時間帯・前の報告との順序は記録の時刻で確かめる。位置・写真必須などの判定はこれまでと同じ
// =========================================================
import { personStaffRows } from './roster'
import { REPORT_TYPES, ACTUAL_SYNC_TYPES, attendanceTypesBatch, checkStaffReport, clientRequestId, lateness, latenessSettings, reportStatus, reportedAtMinute } from './report-settings'
import { actualFromReports, amountsForActual } from './settlement'
import { isSettled } from './shift-board'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { distanceFromSite, distanceResult, sitePositionOf } from './lib/site-location'
import { PHOTO_REQUIRED_ERROR, noPhotoReasonText, photoSkipAllowed } from './lib/attendance-photo'
import { isD1Overloaded, withD1Retry } from './lib/d1-retry'
import { jstOf } from './lib/time'

export const PUNCH_CLOCK_SKEW_MAX_MS = 5 * 60000 // 端末の時計のずれがこれ以上なら、押した時刻を使わない
export const PUNCH_DELAY_MAX_MS = 30 * 60000     // 押してから受け付けるまでがこれを超えたら、押した時刻を使わない
export const PUNCH_RESENT_MIN_MS = 60000         // 押した時刻と受け付けた時刻がこれ以上違えば「再送」の印を付ける
export const PUNCH_BUSY_ERROR = '混み合っているため、記録できませんでした。自動で送り直します'
const PHOTO_REQUIRED_TYPES = ['check_in', 'check_out']


// 押した時刻の扱い。pressed: 押した時刻（JST。送られていなければ null）、adopt: 記録の時刻に使うか、mark: 「再送」の印を付けるか
export function punchTime(pressedRaw: any, deviceNowRaw: any, nowMs: number): { pressed: string | null; pressedMs: number | null; adopt: boolean; mark: boolean } | { error: string } {
  if (pressedRaw == null || pressedRaw === '') return { pressed: null, pressedMs: null, adopt: false, mark: false }
  const ms = Number(pressedRaw)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return { error: '押した時刻が正しくありません' }
  const pressedMs = Math.floor(ms / 1000) * 1000
  // 端末の今の時刻が送られていなければ、ずれは確かめられないので、押した時刻の範囲（未来・30分）だけで決める。形が違えば、ずれているとみなす
  const hasNow = deviceNowRaw != null && deviceNowRaw !== ''
  const dn = Number(deviceNowRaw)
  const skewed = hasNow && (!Number.isFinite(dn) || Math.abs(dn - nowMs) >= PUNCH_CLOCK_SKEW_MAX_MS)
  const adopt = !skewed && pressedMs <= nowMs && nowMs - pressedMs <= PUNCH_DELAY_MAX_MS
  return { pressed: jstOf(pressedMs), pressedMs, adopt, mark: Math.abs(nowMs - pressedMs) >= PUNCH_RESENT_MIN_MS }
}

// 案件の photo_required_override（NULL = 会社設定 / 1 = 必須 / 0 = 不要）と会社設定 photo_required_attendance（既定は必須）。api.ts の resolvePhotoRequired と同じ
function photoRequired(settingsJson: any, override: any): boolean {
  if (override !== null && override !== undefined) return !!override
  try { const v = JSON.parse(settingsJson || '{}').photo_required_attendance; return typeof v === 'boolean' ? v : true } catch { return true }
}

export type PunchInput = {
  shiftId: any; reportType: string; latitude: any; longitude: any; address?: any
  noPhotoReason?: any; noPhotoNote?: any
  clientRequestId: any; pressedAt: any; deviceNow: any
  // 写真付きの API のときだけ（形式・大きさは呼び出し元で確かめる）
  photo?: { file: File; takenAt: string | null; source: string | null } | null
  userAgent: string
}
type Res = { body: any; status: number }

// 記録済みの報告をそのまま返す（同じキーの送り直し）
function duplicateResult(r: any, settingsJson: any): Res {
  return { status: 200, body: { ok: true, duplicate: true, status: r.status, reported_at: r.reported_at, device_time: r.time_source === 'device', resent: !!r.time_source,
    late_minutes: r.late_minutes, early_leave_minutes: r.early_leave_minutes, ...(r.photo_key ? { photo_key: r.photo_key } : {}), ...distanceResult(r.distance_m ?? null, settingsJson) } }
}
const sameActual = (a: { start: string | null; end: string | null; brk: number | null }, s: any) =>
  a.start === (s.actual_start || null) && a.end === (s.actual_end || null) && a.brk === (s.actual_break_minutes ?? null)

export async function recordPunch(c: any, input: PunchInput): Promise<Res> {
  try { return await recordPunchInner(c, input) } catch (e) {
    // 過負荷が続いたときは 503（画面が間をあけて送り直す）。ほかのエラーはこれまでどおり 500（参照番号つき）にする
    if (isD1Overloaded(e)) { console.log(`attendance busy: ${String((e as any)?.message || e).slice(0, 200)}`); return { status: 503, body: { error: PUNCH_BUSY_ERROR, code: 'busy' } } }
    throw e
  }
}

async function recordPunchInner(c: any, input: PunchInput): Promise<Res> {
  const u = c.get('user'), db: D1Database = c.env.DB, type = input.reportType
  const failWrite: (() => boolean) | undefined = c.get('d1FailWrite')
  const notFound: Res = { status: 404, body: { error: 'シフトが見つかりません' } }
  const shiftId = Number(input.shiftId)
  if (!Number.isInteger(shiftId) || shiftId <= 0) return notFound
  // 同一人物の所属企業のスタッフ行（勤怠の自動振り分け。シフトの所有企業のスタッフ行に記録する）
  const rows = await withD1Retry(() => personStaffRows(db, u))
  if (!rows.length) return notFound
  // 読み込みは1往復にまとめる。報告・申請中・設定はシフトが本人のものと分かってから使う
  const att = attendanceTypesBatch(db, '?', [shiftId])
  const read = await withD1Retry(() => db.batch([
    db.prepare(`SELECT s.*, p.photo_required_override AS p_photo_required_override, p.late_grace_minutes AS p_late_grace_minutes,
        p.hours_basis AS p_hours_basis, p.time_round_minutes AS p_time_round_minutes, p.pay_time_round AS p_pay_time_round, p.default_break_minutes AS p_default_break_minutes,
        si.lat AS s_lat, si.lng AS s_lng,
        EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = s.company_id AND k.reopened_at IS NULL AND k.period_from <= s.work_date AND k.period_to >= s.work_date) AS p_closed
      FROM shifts s LEFT JOIN projects p ON p.project_id = s.project_id AND p.company_id = s.company_id LEFT JOIN sites si ON si.site_id = s.site_id AND si.company_id = s.company_id
      WHERE s.shift_id = ? AND s.staff_id IN ${JSON_IN}`).bind(shiftId, bindJsonArray(rows.map(r => r.staff_id))),
    db.prepare(`SELECT report_type, reported_at, status, late_minutes, early_leave_minutes, distance_m, photo_key, time_source, client_request_id FROM attendance_reports WHERE shift_id = ?`).bind(shiftId),
    db.prepare("SELECT report_type FROM attendance_corrections WHERE shift_id = ? AND status = 'pending'").bind(shiftId),
    ...att.statements,
  ]))
  const shift = (read[0].results as any[])[0]
  if (!shift) return notFound
  const owner = rows.find(r => r.staff_id === shift.staff_id)
  if (!owner || shift.company_id !== owner.company_id) return notFound
  const reports = read[1].results as any[]
  // 同じ送信の送り直し（#427 #9939）。記録済みなら、時間帯などを確かめずにそのまま返す
  const reqId = clientRequestId(input.clientRequestId)
  const dup = reqId ? reports.find(r => r.report_type === type && r.client_request_id === reqId) : null
  if (dup) return duplicateResult(dup, owner.settings_json)

  const nowMs = Date.now(), now = jstOf(nowMs)
  const t = punchTime(input.pressedAt, input.deviceNow, nowMs)
  if ('error' in t) return { status: 400, body: { error: t.error, code: 'device_time' } }
  let adopt = t.adopt
  // 押した時刻で記録すると、記録済みの前の報告より前になるときは、受け付けた時刻で記録する（順序が逆の記録を作らない）
  if (adopt) {
    const earlier = REPORT_TYPES.slice(0, REPORT_TYPES.indexOf(type as any))
    if (reports.some(r => earlier.includes(r.report_type) && String(r.reported_at) > reportedAtMinute(t.pressed!))) adopt = false
  }
  const at = reportedAtMinute(adopt ? t.pressed! : now)
  const timeSource = t.mark ? (adopt ? 'device' : 'resent') : null
  // 欠勤・確定済みでないか・受付の時間帯か（記録の時刻で確かめる）・有効か・報告済みや申請中でないか・順序（#116 #84 #122 #47）
  const state = { done: new Set(reports.map(r => r.report_type as string)), pending: new Set((read[2].results as any[]).map(r => r.report_type as string)) }
  const required = att.resolve(read.slice(3)).get(shiftId)
  const ng = checkStaffReport(shift, type, adopt ? t.pressed! : now, required ? required.types : [...REPORT_TYPES], state)
  if (ng) return { status: ng.status, body: { error: ng.error } }
  // 写真が必須の入店・退店は写真付きの API で送る。写真を送れないときは、会社が許可していれば理由つきで写真なしで受け付ける（#535）
  let noPhotoReason: string | null = null
  if (!input.photo && PHOTO_REQUIRED_TYPES.includes(type) && photoRequired(owner.settings_json, shift.p_photo_required_override)) {
    const reason = noPhotoReasonText(input.noPhotoReason, input.noPhotoNote)
    if (reason && typeof reason === 'object') return { status: 400, body: { error: reason.error } }
    if (!reason || !photoSkipAllowed(owner.settings_json)) return { status: 400, body: { error: PHOTO_REQUIRED_ERROR } }
    noPhotoReason = reason
  }
  // 遅刻・早退の判定（記録の時刻で。#134 #219 #497）と、入店の位置と現場の距離（#277）
  const num = (v: any) => v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
  const lat = num(input.latitude), lng = num(input.longitude)
  const judged = lateness(shift, [{ report_type: type, reported_at: at }], latenessSettings(owner.settings_json, shift.p_late_grace_minutes))[0]
  const status = reportStatus(judged, lat)
  const distance = type === 'check_in' ? distanceFromSite(sitePositionOf(shift), lat, lng) : null

  // 写真は記録の前に R2 に置く。キーは一意キーから決める（送り直しても同じキーに上書きし、写真が増えない）
  let key: string | null = null
  if (input.photo) {
    const ext = input.photo.file.type === 'image/png' ? 'png' : 'jpg'
    key = `attendance/${owner.company_id}/${owner.staff_id}/${shiftId}/${type}_${reqId || Date.now()}.${ext}`
    try {
      await c.env.PHOTOS.put(key, await input.photo.file.arrayBuffer(), { httpMetadata: { contentType: input.photo.file.type } })
    } catch {
      return { status: 502, body: { error: '写真のアップロードに失敗しました。通信環境を確認して再度お試しください' } }
    }
  }
  const later = (p: Promise<any>) => { try { c.executionCtx.waitUntil(p.catch(() => {})) } catch { p.catch(() => {}) } }
  const dropPhoto = () => { if (key) later(c.env.PHOTOS.delete(key)) }

  // 書き込みは1つの batch。同時に届いた2回目は一意制約（shift_id, report_type）で登録されない。秒は 00 にそろえる（#95 #133）
  // 住所・user-agent は長さを切って保存する（報告用URLと同じ。#521）
  const stmts: D1PreparedStatement[] = [db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status, photo_key,
      late_minutes, early_leave_minutes, no_photo_reason, photo_taken_at, photo_source, distance_m, client_request_id, pressed_at, received_at, time_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shift_id, report_type) DO NOTHING`)
    .bind(owner.company_id, owner.staff_id, shiftId, type, at, lat, lng, typeof input.address === 'string' && input.address ? input.address.slice(0, 200) : null,
      String(input.userAgent || '').slice(0, 300), status, key, judged.late_minutes, judged.early_leave_minutes, noPhotoReason,
      input.photo ? input.photo.takenAt : null, input.photo ? input.photo.source : null, distance, reqId, t.pressed, now, timeSource)]
  // 勤務開始・終了（なければ入店・退店）と休憩を実績（実働時間）と時給の金額に反映する（settlement.ts の syncActualFromReports と同じ規則。
  // 管理者の手入力・確定済み・締めた期間は対象外）。この報告が記録されたときだけ反映する
  if (ACTUAL_SYNC_TYPES.includes(type) && !isSettled(shift) && shift.actual_source !== 'manual' && !shift.p_closed) {
    const a = actualFromReports(x => x === type ? at : reports.find(r => r.report_type === x)?.reported_at)
    if (!sameActual(a, shift)) {
      const amt = amountsForActual({ ...shift, actual_start: a.start, actual_end: a.end, actual_break_minutes: a.brk },
        { hours_basis: shift.p_hours_basis, time_round_minutes: shift.p_time_round_minutes, pay_time_round: shift.p_pay_time_round, default_break_minutes: shift.p_default_break_minutes })
      stmts.push(db.prepare(`UPDATE shifts SET actual_start = ?, actual_end = ?, actual_break_minutes = ?, actual_source = ?, bill_qty = ?, unit_price = ?, pay_qty = ?, pay_amount = ?
        WHERE shift_id = ? AND COALESCE(settle_status, 'planned') != 'confirmed' AND COALESCE(actual_source, '') != 'manual'
          AND EXISTS (SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ? AND reported_at = ? AND received_at = ?)`)
        .bind(a.start, a.end, a.brk, a.start || a.brk != null ? 'report' : null,
          amt ? amt.bill_qty : shift.bill_qty, amt ? amt.unit_price : shift.unit_price, amt ? amt.pay_qty : shift.pay_qty, amt ? amt.pay_amount : shift.pay_amount,
          shiftId, shiftId, type, at, now))
    }
  }
  let res: D1Result[]
  try {
    res = await withD1Retry(() => db.batch(stmts), failWrite)
  } catch (e) {
    // 一意キーのない古い画面の送信は、置いた写真を消す（一意キーがあれば、送り直しで同じキーに置き直すので残す。残った写真は孤立写真の点検で見つかる）
    if (!reqId) dropPhoto()
    throw e
  }
  if (!res[0].meta.changes) {
    // 同じキーの送信が同時に届いて先に記録された場合は、記録済みの内容を返す（写真のキーも同じなので消さない）
    const again = reqId ? await withD1Retry(() => db.prepare(`SELECT report_type, reported_at, status, late_minutes, early_leave_minutes, distance_m, photo_key, time_source FROM attendance_reports
      WHERE shift_id = ? AND report_type = ? AND client_request_id = ?`).bind(shiftId, type, reqId).first() as Promise<any>) : null
    if (!again || again.photo_key !== key) dropPhoto()
    if (again) return duplicateResult(again, owner.settings_json)
    return { status: 409, body: { error: 'すでに報告済みです' } }
  }
  return { status: 200, body: { ok: true, status, reported_at: at, device_time: timeSource === 'device', resent: !!timeSource, late_minutes: judged.late_minutes, early_leave_minutes: judged.early_leave_minutes,
    ...(key ? { photo_key: key } : {}), ...distanceResult(distance, owner.settings_json) } }
}

