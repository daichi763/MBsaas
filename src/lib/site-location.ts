// =========================================================
// 会社の緊急連絡先と、入店の位置と現場の距離（作業単位 w5-site-contact）
//   #173 会社の緊急連絡先（companies.emergency_phone・emergency_note）。スタッフアプリと報告用URLに出す
//   #277 入店の位置と、シフトの開催場所（なければ案件）の位置との距離。基準は会社設定 settings_json.check_in_far_meters
// =========================================================

// 離れているとみなす距離の既定（m）。0 は判定しない
export const CHECK_IN_FAR_DEFAULT_METERS = 500
export const CHECK_IN_FAR_MIN_METERS = 100
export const CHECK_IN_FAR_MAX_METERS = 50000
export const EMERGENCY_PHONE_MAX = 20
export const EMERGENCY_NOTE_MAX = 100

// 2点間の距離（m）。ハバーサイン式
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, rad = (d: number) => d * Math.PI / 180
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function coord(v: any, max: number): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null
}

// 会社設定の基準（m）。未設定は既定、0 は判定しない
export function farThresholdMeters(settingsJson: any): number {
  try {
    const v = JSON.parse(settingsJson || '{}').check_in_far_meters
    if (Number.isInteger(v) && (v === 0 || (v >= CHECK_IN_FAR_MIN_METERS && v <= CHECK_IN_FAR_MAX_METERS))) return v
  } catch { }
  return CHECK_IN_FAR_DEFAULT_METERS
}

// 現場の位置: シフトの開催場所の位置、なければ案件の位置。どちらもなければ null
export async function sitePosition(db: D1Database, shift: { company_id: any; site_id?: any; project_id?: any }): Promise<{ lat: number; lng: number; source: 'site' | 'project' } | null> {
  const row = await db.prepare(`SELECT si.lat AS s_lat, si.lng AS s_lng, p.location_lat AS p_lat, p.location_lng AS p_lng
    FROM (SELECT 1) LEFT JOIN sites si ON si.site_id = ? AND si.company_id = ? LEFT JOIN projects p ON p.project_id = ? AND p.company_id = ?`)
    .bind(shift.site_id ?? null, shift.company_id, shift.project_id ?? null, shift.company_id).first() as any
  if (!row) return null
  const sLat = coord(row.s_lat, 90), sLng = coord(row.s_lng, 180)
  if (sLat != null && sLng != null) return { lat: sLat, lng: sLng, source: 'site' }
  const pLat = coord(row.p_lat, 90), pLng = coord(row.p_lng, 180)
  if (pLat != null && pLng != null) return { lat: pLat, lng: pLng, source: 'project' }
  return null
}

// 入店の位置と現場の距離（m、整数）。位置が取れていない・現場の位置が未登録なら null
export async function checkInDistance(db: D1Database, shift: { company_id: any; site_id?: any; project_id?: any }, latitude: any, longitude: any): Promise<number | null> {
  const lat = coord(latitude, 90), lng = coord(longitude, 180)
  if (lat == null || lng == null) return null
  const pos = await sitePosition(db, shift)
  return pos ? Math.round(haversineMeters(lat, lng, pos.lat, pos.lng)) : null
}

// 入店の報告の結果に添える距離の情報（スタッフに知らせる）
export function distanceResult(distance: number | null, settingsJson: any): { distance_m: number | null; far: boolean } {
  const th = farThresholdMeters(settingsJson)
  return { distance_m: distance, far: distance != null && th > 0 && distance > th }
}

// 緊急連絡先の電話番号。空は null、使えない文字・長すぎは error
export function emergencyPhone(v: any): string | null | { error: string } {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return { error: '緊急連絡先の電話番号を正しく入力してください' }
  const s = v.normalize('NFKC').replace(/[ー－‐−]/g, '-').trim()
  if (!s) return null
  if (s.length > EMERGENCY_PHONE_MAX || !/^\+?[0-9][0-9\-() ]*$/.test(s) || s.replace(/\D/g, '').length < 3) {
    return { error: `緊急連絡先の電話番号は、数字とハイフンで${EMERGENCY_PHONE_MAX}文字以内で入力してください` }
  }
  return s
}

// 受付時間などの補足。空は null、長すぎは error
export function emergencyNote(v: any): string | null | { error: string } {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return { error: '受付時間などの補足を正しく入力してください' }
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!s) return null
  if (s.length > EMERGENCY_NOTE_MAX) return { error: `受付時間などの補足は${EMERGENCY_NOTE_MAX}文字以内で入力してください` }
  return s
}
