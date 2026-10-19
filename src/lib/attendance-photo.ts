// =========================================================
// 入店・退店の写真と端末の記録（アプリ・報告用URL・管理画面で共用。w4-report-link-proxy）
//   #418 写真のファイルの日時と選び方（カメラ・アルバム）を残し、報告の日時とずれていれば知らせる
//   #535 写真が送れないときに、理由を選んで写真なしで報告する（会社設定 photo_skip_allowed で許可したときだけ）
//   #532 報告した端末の要約（OS・ブラウザ）
// =========================================================

// 写真なしで報告するときの理由（画面の選択肢と同じキー。保存するのは文言）
export const NO_PHOTO_REASONS: Record<string, string> = {
  prohibited: '店舗が撮影禁止',
  camera: 'カメラが使えない',
  failed: '写真の処理・送信に失敗',
  other: 'その他',
}
const NO_PHOTO_NOTE_MAX = 100

// 会社設定（companies.settings_json）の photo_skip_allowed。既定は許可しない
export function photoSkipAllowed(settingsJson: any): boolean {
  try { return JSON.parse(settingsJson || '{}').photo_skip_allowed === true } catch { return false }
}

// 写真なしの理由（コードと補足）を保存する文言にする。送られていなければ null、不正なら error
export function noPhotoReasonText(code: any, note: any): string | null | { error: string } {
  if (code === undefined || code === null || code === '') return null
  if (typeof code !== 'string' || !NO_PHOTO_REASONS[code]) return { error: '写真なしの理由を選択してください' }
  const n = typeof note === 'string' ? note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
  if (n.length > NO_PHOTO_NOTE_MAX) return { error: `写真なしの理由の補足は${NO_PHOTO_NOTE_MAX}文字以内で入力してください` }
  if (code === 'other' && !n) return { error: '「その他」の場合は理由を入力してください' }
  return n ? `${NO_PHOTO_REASONS[code]}（${n}）` : NO_PHOTO_REASONS[code]
}

// 写真なしで報告できないときの案内（写真が必須の案件で写真が届かなかったとき）
export const PHOTO_REQUIRED_ERROR = 'この案件は写真の添付が必須です。写真を送れない場合は、担当者に連絡してください'

// 端末が付けたファイルの日時（ミリ秒）を JST の 'YYYY-MM-DD HH:MM:SS' にする。範囲外・不正なら null
export function photoTakenAt(v: any): string | null {
  const ms = Number(v)
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > Date.now() + 24 * 3600 * 1000) return null
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}
export function photoSource(v: any): 'camera' | 'album' | null {
  return v === 'camera' || v === 'album' ? v : null
}
// 写真の日時が報告の日時から何分以上ずれていたら知らせるか
export const PHOTO_STALE_MINUTES = 30
export function isPhotoStale(takenAt: any, reportedAt: any): boolean {
  if (!takenAt || !reportedAt) return false
  const a = Date.parse(String(takenAt).replace(' ', 'T') + 'Z'), b = Date.parse(String(reportedAt).replace(' ', 'T') + 'Z')
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= PHOTO_STALE_MINUTES * 60000
}

// 報告用URLの端末ID（画面がブラウザに保存した乱数）。形式が違えば null
export function deviceIdOf(v: any): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null
}

// user-agent の要約（例: 'iPhone・Safari'）。分からなければ空文字
export function deviceSummary(ua: any): string {
  const s = String(ua || '')
  if (!s || s === 'proxy') return ''
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'その他'
  // Edge・Samsung・LINE の UA にも Chrome・Safari が入るため、先に見る
  const br = /\bLine\//i.test(s) ? 'LINE' : /EdgA?\/|EdgiOS/.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung'
    : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : ''
  return br ? `${os}・${br}` : os
}
