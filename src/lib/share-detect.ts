// アカウントの使い回しの疑いを見つける（Sprint 31 #9989。作業単位 w31-share-detect。表は migrations/0116_share_detect.sql）
//
// 払い出したアカウントの数で課金するため、1つのアカウントを複数の人で使い回している会社に本部が気づけるようにする。
// 見つけて本部の画面（「使い回しの疑い」と企業詳細）に出すだけで、ログインを止めたり締め出したりはしない
// （利用者の決定 11/18: 同時にログインできる端末の数に上限は付けない）。会社の画面には出さない（API は /api/hq/* だけ。src/hq-share.ts）。
//
// 手がかり（どれも今あるデータと、ログインの記録に足した列だけを使う）:
//   concurrent    … 同じアカウントが、別の種類の端末で同時に使われている。
//                   ログインの時点で別の端末のセッションが決まりの分以内に使われていた回数（login_events.concurrent_*）と、
//                   集計の時点で別の種類の端末のセッションが2つ以上有効なこと。管理者は「同じ時刻に別の端末から操作」として出す
//   many_devices  … 決まりの日数のあいだにログインした端末の種類（OS・ブラウザ。設定で OS だけにもできる）が多い
//   far_apart     … 短い時間のあいだに、遠く離れた都道府県（か別の国）からログインした（Cloudflare の request.cf の都道府県）
//   punch_far     … スタッフの打刻: 続けて打刻した2回の場所が、移動できない速さで離れている
//   punch_devices … スタッフの打刻: 同じ日に別の種類の端末から打刻した
//   日報は送った端末を記録していないので、手がかりに使わない（打刻の端末で見る）。
//
// 誤検知（同じ人のスマホとパソコン、携帯の回線で IP や場所が変わる）を考えて、決まりの値は本部の画面で変えられる（share_detect_settings）。
// 端末は User-Agent の種類（login-security.ts の deviceLabel と同じ OS・ブラウザ）でまとめ、版の違いでは数を増やさない。
//
// 集計は週に1回の定期処理（3:30 の起動。その週にまだ集計していなければ動く）と、本部の画面の「今すぐ集計する」。
// 無料プランの CPU 時間（10ms）と読み取りの枠に収めるため、絞り込み・数え上げはすべて D1 の SQL の中で行い、Worker は疑いのある行だけを受け取る。
//   ログインの履歴は created_at の索引で期間の分だけ（1回だけ）読み、打刻は日付の索引（shifts の company_id, work_date）から引く
//   （attendance_reports の日時の索引は 0112 で消したため、打刻の表を日時で探さない）。読んだ行数（meta.rows_read）は実行の記録に残す。
import { deviceLabel } from './login-security'
import { ADMIN_ROLES } from './permissions'
import { addDays, jstOf, nowJST, todayJST } from './time'

// ---------- 都道府県（ISO 3166-2:JP のコード、名前、県庁所在地のおおよその緯度・経度） ----------
export const PREFECTURES: Record<string, [string, number, number]> = {
  '01': ['北海道', 43.064, 141.347], '02': ['青森県', 40.824, 140.740], '03': ['岩手県', 39.704, 141.153], '04': ['宮城県', 38.269, 140.872],
  '05': ['秋田県', 39.719, 140.102], '06': ['山形県', 38.240, 140.363], '07': ['福島県', 37.750, 140.468], '08': ['茨城県', 36.342, 140.447],
  '09': ['栃木県', 36.566, 139.884], '10': ['群馬県', 36.391, 139.061], '11': ['埼玉県', 35.857, 139.649], '12': ['千葉県', 35.605, 140.123],
  '13': ['東京都', 35.690, 139.692], '14': ['神奈川県', 35.448, 139.642], '15': ['新潟県', 37.902, 139.023], '16': ['富山県', 36.695, 137.211],
  '17': ['石川県', 36.594, 136.626], '18': ['福井県', 36.065, 136.222], '19': ['山梨県', 35.664, 138.568], '20': ['長野県', 36.651, 138.181],
  '21': ['岐阜県', 35.391, 136.722], '22': ['静岡県', 34.977, 138.383], '23': ['愛知県', 35.180, 136.907], '24': ['三重県', 34.730, 136.509],
  '25': ['滋賀県', 35.004, 135.869], '26': ['京都府', 35.021, 135.756], '27': ['大阪府', 34.686, 135.520], '28': ['兵庫県', 34.691, 135.183],
  '29': ['奈良県', 34.685, 135.833], '30': ['和歌山県', 34.226, 135.168], '31': ['鳥取県', 35.504, 134.238], '32': ['島根県', 35.472, 133.051],
  '33': ['岡山県', 34.662, 133.935], '34': ['広島県', 34.397, 132.460], '35': ['山口県', 34.186, 131.471], '36': ['徳島県', 34.066, 134.559],
  '37': ['香川県', 34.340, 134.043], '38': ['愛媛県', 33.842, 132.766], '39': ['高知県', 33.560, 133.531], '40': ['福岡県', 33.607, 130.418],
  '41': ['佐賀県', 33.249, 130.299], '42': ['長崎県', 32.745, 129.874], '43': ['熊本県', 32.790, 130.742], '44': ['大分県', 33.238, 131.613],
  '45': ['宮崎県', 31.911, 131.424], '46': ['鹿児島県', 31.560, 130.558], '47': ['沖縄県', 26.212, 127.681],
}
// 距離はおおよそでよいので、緯度1度 = 111km、経度1度 = 91km（北緯35度）として平方で比べる（SQL で平方根を使わない）
const KM_PER_LAT = 111.0
const KM_PER_LON = 91.0

/** 都道府県の表示（日本のコードなら日本語の名前。ほかの国は「国コード 地域」） */
export function placeLabel(country: unknown, regionCode: unknown, region?: unknown): string {
  const c = String(country || ''), r = String(regionCode || '')
  if (c === 'JP' && PREFECTURES[r]) return PREFECTURES[r][0]
  if (!c) return '不明'
  return [c, String(region || r || '')].filter(Boolean).join(' ')
}

// ---------- ログインの記録に足す値 ----------
export type RequestGeo = { country: string | null; region_code: string | null; region: string | null; city: string | null }
/** Cloudflare が付ける接続元のおおよその場所（request.cf）。手元の開発サーバーでは無いか、仮の値のことがある */
export function requestGeo(c: { req: { raw: Request } }): RequestGeo {
  const cf = ((c.req.raw as any)?.cf || {}) as Record<string, unknown>
  const s = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
  return { country: s(cf.country, 2), region_code: s(cf.regionCode, 10), region: s(cf.region, 60), city: s(cf.city, 60) }
}

export type LoginConcurrency = { device: string; minutes: number }
/**
 * ログインの成功の時点で、同じアカウントの別の種類の端末のセッションが使われていたか（最近使われたもの1つ）。
 * セッションは使うたびに期限を「今から idleHours 時間」に延ばす（延ばす間隔は管理者10分・スタッフ6時間）ので、
 * 最後に延ばした時刻 = 期限 − idleHours を「最後に使った時刻」とみなす（本当の最後の利用はそれより後なので、分は多めに出る）。
 * 同じブラウザの前のセッション（Cookie の分）は、呼ぶ前に消しておく（issueSession）
 */
export async function loginConcurrency(db: D1Database, userId: number, userAgent: string | null, idleHours: number, now = Date.now()): Promise<LoginConcurrency | null> {
  const mine = deviceLabel(userAgent)
  const rows = (await db.prepare(`SELECT created_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? AND user_agent IS NOT NULL AND user_agent != ''
    ORDER BY expires_at DESC LIMIT 20`).bind(userId, new Date(now).toISOString()).all()).results as any[]
  let best: LoginConcurrency | null = null
  for (const r of rows) {
    const kind = deviceLabel(r.user_agent)
    if (kind === mine) continue
    // created_at は CURRENT_TIMESTAMP（UTC の 'YYYY-MM-DD HH:MM:SS'）
    const created = Date.parse(String(r.created_at || '').replace(' ', 'T') + (/Z$|[+-]\d\d:?\d\d$/.test(String(r.created_at || '')) ? '' : 'Z')) || 0
    const lastUsed = Math.max(created, Date.parse(String(r.expires_at)) - idleHours * 3600 * 1000)
    const minutes = Math.max(0, Math.round((now - lastUsed) / 60000))
    if (!best || minutes < best.minutes) best = { device: kind, minutes }
  }
  return best
}

// ---------- 端末の種類（SQL） ----------
// login-security.ts の deviceLabel と同じ判定を SQL で作る（大文字・小文字を区別する GLOB を使う）。mode: 1 = OS とブラウザ、2 = OS だけ
const OS_CASES: [string[], string][] = [[['*iPhone*'], 'iPhone'], [['*iPad*'], 'iPad'], [['*Android*'], 'Android'], [['*Windows*'], 'Windows'],
  [['*Mac OS X*', '*Macintosh*'], 'Mac'], [['*Linux*'], 'Linux']]
const BROWSER_CASES: [string[], string][] = [[['*Edg/*'], 'Edge'], [['*Line/*'], 'LINE'], [['*CriOS*', '*Chrome/*'], 'Chrome'],
  [['*FxiOS*', '*Firefox/*'], 'Firefox'], [['*Safari/*'], 'Safari']]
function caseSql(col: string, cases: [string[], string][]): string {
  return `(CASE ${cases.map(([pats, v]) => `WHEN ${pats.map(p => `${col} GLOB '${p}'`).join(' OR ')} THEN '${v}'`).join(' ')} ELSE '' END)`
}
export function deviceKindSql(col: string, mode: number): string {
  const os = caseSql(col, OS_CASES)
  const br = caseSql(col, BROWSER_CASES)
  if (mode === 2) return `(CASE WHEN COALESCE(${col}, '') = '' THEN '不明な端末' WHEN ${os} != '' THEN ${os} ELSE substr(${col}, 1, 40) END)`
  return `(CASE WHEN COALESCE(${col}, '') = '' THEN '不明な端末' WHEN ${os} != '' AND ${br} != '' THEN ${os} || ' / ' || ${br}
    WHEN ${os} || ${br} != '' THEN ${os} || ${br} ELSE substr(${col}, 1, 40) END)`
}
// 端末の表示（deviceLabel の結果）の OS の部分
const osOfLabelSql = (col: string) => `(CASE WHEN instr(${col}, ' / ') > 0 THEN substr(${col}, 1, instr(${col}, ' / ') - 1) ELSE ${col} END)`

// ---------- 決まりの値 ----------
export type ShareSettingDef = { label: string; help: string; def: number; min: number; max: number; options?: Record<number, string> }
export const SHARE_SETTING_DEFS: Record<string, ShareSettingDef> = {
  concurrent_admin_minutes: { label: '管理者: 同時の利用とみなす間隔（分）', help: 'ログインしたとき、別の種類の端末のセッションがこの分以内に使われていたら「同時」と数えます', def: 30, min: 5, max: 720 },
  concurrent_staff_minutes: { label: 'スタッフ: 同時の利用とみなす間隔（分）', help: 'スタッフのセッションは6時間ごとにしか利用の時刻が分からないため、管理者より長くしています', def: 360, min: 30, max: 4320 },
  concurrent_min_count: { label: '同時の利用の回数（7日間。この回数から疑う）', help: '集計の時点で別の種類の端末が2つ以上ログイン中なら、1回として足します', def: 3, min: 1, max: 50 },
  device_days: { label: '端末を数える期間（日）', help: 'この日数のあいだにログインした端末の種類を数えます', def: 30, min: 7, max: 90 },
  device_threshold: { label: '端末の数（この数から疑う）', help: '同じ人のスマホとパソコン（2〜3種類）は多くあります', def: 4, min: 2, max: 20 },
  device_group: { label: '端末の数え方', help: 'OS だけにすると、同じスマホの別のブラウザ（Safari と LINE など）を1つと数えます', def: 1, min: 1, max: 2,
    options: { 1: 'OS とブラウザの組み合わせ', 2: 'OS だけ' } },
  far_km: { label: '離れた場所とみなす距離（km）', help: '都道府県（県庁所在地）どうしの距離です。携帯の回線は、実際と違う都道府県になることがあります', def: 300, min: 30, max: 3000 },
  far_hours: { label: '離れた場所からのログインの間隔（時間以内）', help: 'この時間のうちに離れた場所（か別の国）からログインしたら数えます', def: 2, min: 1, max: 48 },
  punch_minutes: { label: '打刻: 続けて打刻した間隔（分以内）', help: 'アプリからの打刻（位置情報があるもの）だけを見ます', def: 60, min: 5, max: 720 },
  punch_km: { label: '打刻: 離れた場所とみなす距離（km）', help: '位置情報のずれで数えないよう、この距離より近い打刻は見ません', def: 10, min: 1, max: 1000 },
  punch_speed_kmh: { label: '打刻: 移動できない速さ（時速 km）', help: '2回の打刻の距離と間隔から出した速さがこれ以上なら数えます', def: 150, min: 30, max: 1000 },
  min_score: { label: '一覧に出す点数（この点から）', help: '手がかり1つで40〜50点、回数が多いと最大20点を足します', def: 40, min: 10, max: 300 },
}
export type ShareSettings = Record<keyof typeof SHARE_SETTING_DEFS, number>
export async function getShareSettings(db: D1Database): Promise<ShareSettings> {
  const rows = (await db.prepare('SELECT key, value FROM share_detect_settings').all()).results as { key: string; value: number }[]
  return shareSettingsFrom(rows)
}
function shareSettingsFrom(rows: { key: string; value: number }[]): ShareSettings {
  const out: Record<string, number> = {}
  for (const [k, d] of Object.entries(SHARE_SETTING_DEFS)) out[k] = d.def
  for (const r of rows) {
    const d = SHARE_SETTING_DEFS[r.key]
    const v = Number(r.value)
    if (d && Number.isInteger(v) && v >= d.min && v <= d.max) out[r.key] = v
  }
  return out as ShareSettings
}

// ---------- 点数 ----------
export const SHARE_REASON_POINTS: Record<string, number> = { concurrent: 40, many_devices: 40, far_apart: 40, punch_far: 50, punch_devices: 30 }
export const SHARE_REASON_LABEL: Record<string, string> = {
  concurrent: '別の端末で同時に利用', many_devices: '端末の種類が多い', far_apart: '離れた場所からのログイン',
  punch_far: '離れた場所で続けて打刻', punch_devices: '同じ日に別の端末で打刻',
}
/** 回数が決まりの数を超えた分だけ、1回につき10点（最大20点）を足す */
const points = (code: string, count: number, base: number) => SHARE_REASON_POINTS[code] + Math.min(20, Math.max(0, count - base) * 10)

export type ShareReason = { code: string; count: number; points: number; detail: string }
type Hit = { code: string; uid: number; n: number; first_at: string | null; last_at: string | null; info: string | null; extra: number | null }

const MAX_FLAGGED = 500 // 1回の集計で残すアカウントの上限（点数の高い順）
const LIST_INFO = 3     // 理由の説明に出す端末・場所の数
export const SHARE_PERIOD_DAYS = 7

const isoToJst = (v: string | null) => v && /T/.test(v) ? jstOf(Date.parse(v)) : v
const joinList = (s: string | null, sep = ',') => {
  const a = [...new Set(String(s || '').split(sep).map(x => x.trim()).filter(Boolean))]
  return a.slice(0, LIST_INFO).join('、') + (a.length > LIST_INFO ? ` ほか${a.length - LIST_INFO}` : '')
}
function farInfo(s: string | null): string {
  const pairs = [...new Set(String(s || '').split(',').filter(Boolean))].slice(0, LIST_INFO).map(p => {
    const [a, b] = p.split('>')
    const pl = (x: string) => { const [c, r] = String(x || '').split('-'); return placeLabel(c, r) }
    return `${pl(a)}→${pl(b)}`
  })
  return pairs.join('、')
}

export type ShareRunResult = { run_id: number | null; status: 'ok' | 'failed'; flagged: number; rows_read: number; period_from: string; period_to: string; error?: string }

/**
 * 集計して、疑いのあるアカウントを share_suspicions に残す（実行の記録は share_detect_runs）。
 * 書き込みは最後に1回の batch（実行の記録1行と、疑いの行を JSON から1文で入れる）
 */
export async function runShareDetection(db: D1Database, opts: { trigger: 'cron' | 'manual'; by?: number | null; now?: number } = { trigger: 'cron' }): Promise<ShareRunResult> {
  const now = opts.now ?? Date.now()
  const today = todayJST()
  const periodFrom = addDays(today, -SHARE_PERIOD_DAYS), periodTo = today
  const startedAt = nowJST()
  let rowsRead = 0
  const read = (r: any) => { rowsRead += Number(r?.meta?.rows_read) || 0; return (r?.results || []) as any[] }
  let st: ShareSettings | null = null
  try {
    const sRes = await db.prepare('SELECT key, value FROM share_detect_settings').all()
    st = shareSettingsFrom(read(sRes))
    const s = st
    const nowIso = new Date(now).toISOString()
    const since7 = new Date(now - SHARE_PERIOD_DAYS * 86400000).toISOString()
    const sinceDev = new Date(now - s.device_days * 86400000).toISOString()
    const sinceAll = sinceDev < since7 ? sinceDev : since7
    const kindUa = deviceKindSql('user_agent', s.device_group)
    const success = `event_type = 'login' AND result = 'success' AND user_id IS NOT NULL AND actor_user_id IS NULL`
    // 同時の利用: OS だけで数えるときは、OS が同じ端末を数えない
    const concurrentDiff = s.device_group === 2 ? `AND ${osOfLabelSql('concurrent_device')} != ${deviceKindSql('user_agent', 2)}` : ''
    const prefValues = Object.entries(PREFECTURES).map(([k, [, la, lo]]) => `('${k}', ${la}, ${lo})`).join(', ')
    const sq = (a: string, b: string, f: number) => `((${a} - ${b}) * ${f}) * ((${a} - ${b}) * ${f})`
    const farKm2 = s.far_km * s.far_km

    // 1. ログインの履歴（期間の分を1回だけ読む）: 同時の利用・端末の数・離れた場所
    const loginSql = `WITH ev AS MATERIALIZED (
        SELECT user_id, created_at, user_agent, country, region_code, concurrent_device, concurrent_minutes FROM login_events
        WHERE created_at >= ?1 AND ${success}),
      pref(code, lat, lon) AS (VALUES ${prefValues}),
      seq AS (SELECT user_id, created_at, country, region_code,
          LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS p_at,
          LAG(country) OVER (PARTITION BY user_id ORDER BY created_at) AS p_country,
          LAG(region_code) OVER (PARTITION BY user_id ORDER BY created_at) AS p_region
        FROM ev WHERE created_at >= ?2 AND country IS NOT NULL),
      far AS (SELECT seq.* FROM seq
          LEFT JOIN pref a ON seq.country = 'JP' AND a.code = seq.region_code
          LEFT JOIN pref b ON seq.p_country = 'JP' AND b.code = seq.p_region
        WHERE seq.p_at IS NOT NULL AND (julianday(seq.created_at) - julianday(seq.p_at)) * 24 <= ?4
          AND (seq.country != seq.p_country OR (a.lat IS NOT NULL AND b.lat IS NOT NULL
            AND ${sq('a.lat', 'b.lat', KM_PER_LAT)} + ${sq('a.lon', 'b.lon', KM_PER_LON)} >= ?5)))
      SELECT 'concurrent' AS code, user_id AS uid, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
          group_concat(DISTINCT concurrent_device) AS info, MIN(concurrent_minutes) AS extra,
          SUM(CASE WHEN concurrent_minutes <= ?6 THEN 1 ELSE 0 END) AS n_admin, SUM(CASE WHEN concurrent_minutes <= ?7 THEN 1 ELSE 0 END) AS n_staff
        FROM ev WHERE created_at >= ?2 AND concurrent_device IS NOT NULL AND concurrent_minutes <= MAX(?6, ?7) ${concurrentDiff}
        GROUP BY user_id
      UNION ALL
      SELECT 'many_devices', user_id, COUNT(*), MIN(f), MAX(l), group_concat(kind), NULL, NULL, NULL FROM (
          SELECT user_id, ${kindUa} AS kind, MIN(created_at) AS f, MAX(created_at) AS l FROM ev WHERE created_at >= ?3 GROUP BY user_id, kind)
        GROUP BY user_id HAVING COUNT(*) >= ?8
      UNION ALL
      SELECT 'far_apart', user_id, COUNT(*), MIN(p_at), MAX(created_at), group_concat(DISTINCT p_country || '-' || COALESCE(p_region, '') || '>' || country || '-' || COALESCE(region_code, '')), NULL, NULL, NULL
        FROM far GROUP BY user_id`
    // 2. 集計の時点のセッション（有効な分だけ。expires_at の索引）: 別の種類の端末が2つ以上
    const kindSess = deviceKindSql('user_agent', s.device_group)
    const sessionSql = `SELECT 'concurrent_now' AS code, user_id AS uid, COUNT(*) AS n, NULL AS first_at, NULL AS last_at, group_concat(kind, ',') AS info, NULL AS extra FROM (
        SELECT user_id, ${kindSess} AS kind FROM sessions WHERE expires_at > ? AND user_agent IS NOT NULL AND user_agent != '' GROUP BY user_id, kind)
      GROUP BY user_id HAVING COUNT(*) >= 2`
    // 3. 打刻（期間のシフトから引く。アプリからの打刻だけ）: 離れた場所で続けて打刻・同じ日に別の端末
    const kindDev = deviceKindSql('device_info', s.device_group)
    const punchSql = `WITH p AS MATERIALIZED (
        SELECT a.staff_id, s.work_date, a.reported_at, a.latitude AS lat, a.longitude AS lon, a.device_info
        FROM shifts s JOIN attendance_reports a ON a.shift_id = s.shift_id
        WHERE s.company_id IN (SELECT company_id FROM companies WHERE active_status != 'internal') AND s.work_date >= ?1 AND s.work_date <= ?2
          AND COALESCE(a.entry_method, 'app') = 'app'),
      seq AS (SELECT staff_id, reported_at, lat, lon,
          LAG(reported_at) OVER (PARTITION BY staff_id ORDER BY reported_at) AS p_at,
          LAG(lat) OVER (PARTITION BY staff_id ORDER BY reported_at) AS p_lat,
          LAG(lon) OVER (PARTITION BY staff_id ORDER BY reported_at) AS p_lon
        FROM p WHERE lat IS NOT NULL AND lon IS NOT NULL),
      hit AS (SELECT staff_id, reported_at, p_at, ${sq('lat', 'p_lat', KM_PER_LAT)} + ${sq('lon', 'p_lon', KM_PER_LON)} AS d2,
          MAX((julianday(reported_at) - julianday(p_at)) * 1440, 1) AS gap
        FROM seq WHERE p_at IS NOT NULL AND (julianday(reported_at) - julianday(p_at)) * 1440 <= ?3),
      g AS (SELECT 'punch_far' AS code, staff_id, COUNT(*) AS n, MIN(p_at) AS first_at, MAX(reported_at) AS last_at, NULL AS info, MAX(d2) AS extra
          FROM hit WHERE d2 >= ?4 AND d2 * 3600 >= (?5 * gap) * (?5 * gap) GROUP BY staff_id
        UNION ALL
        SELECT 'punch_devices', staff_id, COUNT(*), MIN(work_date), MAX(work_date), group_concat(kinds, ','), NULL FROM (
            SELECT staff_id, work_date, group_concat(DISTINCT kind) AS kinds FROM (
              SELECT staff_id, work_date, ${kindDev} AS kind FROM p WHERE device_info IS NOT NULL AND device_info != '' AND device_info != 'proxy')
            GROUP BY staff_id, work_date HAVING COUNT(DISTINCT kind) >= 2)
          GROUP BY staff_id)
      SELECT g.code, sp.user_id AS uid, g.n, g.first_at, g.last_at, g.info, g.extra FROM g JOIN staff_profiles sp ON sp.staff_id = g.staff_id WHERE sp.user_id IS NOT NULL`
    const [loginRes, sessRes, punchRes] = await db.batch([
      db.prepare(loginSql).bind(sinceAll, since7, sinceDev, s.far_hours, farKm2, s.concurrent_admin_minutes, s.concurrent_staff_minutes, s.device_threshold),
      db.prepare(sessionSql).bind(nowIso),
      db.prepare(punchSql).bind(periodFrom, periodTo, s.punch_minutes, s.punch_km * s.punch_km, s.punch_speed_kmh),
    ])
    const loginRows = read(loginRes), sessRows = read(sessRes), punchRows = read(punchRes)
    const hits: (Hit & { n_admin?: number; n_staff?: number })[] = [...loginRows, ...sessRows, ...punchRows].map(r => ({ ...r, uid: Number(r.uid), n: Number(r.n) || 0 }))
    const ids = [...new Set(hits.map(h => h.uid))]
    if (!ids.length) return await finish([], s)

    // 4. 疑いのある人だけの利用者の情報（本部のアカウントと本部専用の企業は除く）
    const uRes = await db.prepare(`SELECT u.user_id, u.company_id, u.role FROM users u JOIN companies co ON co.company_id = u.company_id
      WHERE u.user_id IN (SELECT value FROM json_each(?)) AND u.role != 'system_admin' AND co.active_status != 'internal'`).bind(JSON.stringify(ids)).all()
    const users = new Map(read(uRes).map((u: any) => [Number(u.user_id), u]))

    const acc = new Map<number, { reasons: ShareReason[]; first: string | null; last: string | null; nowDevices?: string; concurrentN: number; concurrentHit?: Hit & { n_admin?: number; n_staff?: number } }>()
    const get = (uid: number) => { let a = acc.get(uid); if (!a) { a = { reasons: [], first: null, last: null, concurrentN: 0 }; acc.set(uid, a) } return a }
    const span = (a: { first: string | null; last: string | null }, f: string | null, l: string | null) => {
      const ff = isoToJst(f), ll = isoToJst(l)
      if (ff && (!a.first || ff < a.first)) a.first = ff
      if (ll && (!a.last || ll > a.last)) a.last = ll
    }
    for (const h of hits) {
      const u = users.get(h.uid)
      if (!u) continue
      const a = get(h.uid)
      if (h.code === 'concurrent') {
        const n = ADMIN_ROLES.includes(String(u.role)) ? Number(h.n_admin) || 0 : Number(h.n_staff) || 0
        if (!n) continue
        a.concurrentN += n; a.concurrentHit = h; span(a, h.first_at, h.last_at)
      } else if (h.code === 'concurrent_now') {
        a.concurrentN += 1; a.nowDevices = joinList(h.info)
      } else if (h.code === 'many_devices') {
        a.reasons.push({ code: h.code, count: h.n, points: points(h.code, h.n, s.device_threshold), detail: `${s.device_days}日で${h.n}種類の端末からログイン（${joinList(h.info)}）` })
        span(a, h.first_at, h.last_at)
      } else if (h.code === 'far_apart') {
        a.reasons.push({ code: h.code, count: h.n, points: points(h.code, h.n, 1), detail: `${s.far_hours}時間以内に約${s.far_km}km 以上離れた場所からログイン ${h.n}回（${farInfo(h.info)}）` })
        span(a, h.first_at, h.last_at)
      } else if (h.code === 'punch_far') {
        const km = Math.round(Math.sqrt(Number(h.extra) || 0))
        a.reasons.push({ code: h.code, count: h.n, points: points(h.code, h.n, 1), detail: `${s.punch_minutes}分以内に離れた場所（最大 約${km}km）で続けて打刻 ${h.n}回` })
        span(a, h.first_at, h.last_at)
      } else if (h.code === 'punch_devices') {
        a.reasons.push({ code: h.code, count: h.n, points: points(h.code, h.n, 1), detail: `同じ日に別の種類の端末で打刻 ${h.n}日（${joinList(h.info)}）` })
        span(a, h.first_at, h.last_at)
      }
    }
    const out: { uid: number; company_id: number; score: number; reasons: ShareReason[]; first: string | null; last: string | null }[] = []
    for (const [uid, a] of acc) {
      const u = users.get(uid)
      if (a.concurrentN >= s.concurrent_min_count && a.concurrentN > 0) {
        const parts: string[] = []
        const h = a.concurrentHit
        const loginN = a.concurrentN - (a.nowDevices ? 1 : 0)
        if (h && loginN > 0) parts.push(`別の端末（${joinList(h.info)}）を使っている間のログイン ${loginN}回`)
        if (a.nowDevices) parts.push(`集計の時点で別の種類の端末がログイン中（${a.nowDevices}）`)
        a.reasons.unshift({ code: 'concurrent', count: a.concurrentN, points: points('concurrent', a.concurrentN, s.concurrent_min_count), detail: parts.join('。') })
      }
      if (!a.reasons.length) continue
      const score = a.reasons.reduce((t, r) => t + r.points, 0)
      if (score < s.min_score) continue
      out.push({ uid, company_id: Number(u.company_id), score, reasons: a.reasons, first: a.first, last: a.last })
    }
    out.sort((x, y) => y.score - x.score || x.uid - y.uid)
    return await finish(out.slice(0, MAX_FLAGGED), s)
  } catch (e) {
    const msg = String(e).slice(0, 1000)
    console.log(`share_detect failed: ${msg}`)
    try {
      await db.prepare(`INSERT INTO share_detect_runs (trigger_type, status, period_from, period_to, flagged, rows_read, settings_json, error_message, triggered_by, created_at, finished_at)
        VALUES (?, 'failed', ?, ?, 0, ?, ?, ?, ?, ?, ?)`).bind(opts.trigger, periodFrom, periodTo, rowsRead, st ? JSON.stringify(st) : null, msg, opts.by ?? null, startedAt, nowJST()).run()
    } catch (e2) { console.log(`share_detect_runs insert failed: ${e2}`) }
    return { run_id: null, status: 'failed', flagged: 0, rows_read: rowsRead, period_from: periodFrom, period_to: periodTo, error: msg }
  }

  async function finish(rows: { uid: number; company_id: number; score: number; reasons: ShareReason[]; first: string | null; last: string | null }[], s: ShareSettings): Promise<ShareRunResult> {
    const at = nowJST()
    const payload = JSON.stringify(rows.map(r => ({ c: r.company_id, u: r.uid, s: r.score, r: JSON.stringify(r.reasons), f: r.first, l: r.last })))
    const stmts = [
      db.prepare(`INSERT INTO share_detect_runs (trigger_type, status, period_from, period_to, flagged, rows_read, settings_json, triggered_by, created_at, finished_at)
        VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(opts.trigger, periodFrom, periodTo, rows.length, rowsRead, JSON.stringify(s), opts.by ?? null, startedAt, at),
    ]
    if (rows.length) {
      stmts.push(db.prepare(`INSERT INTO share_suspicions (run_id, company_id, user_id, score, reasons_json, period_from, period_to, first_at, last_at, review_status, created_at)
        SELECT (SELECT MAX(run_id) FROM share_detect_runs), json_extract(value, '$.c'), json_extract(value, '$.u'), json_extract(value, '$.s'), json_extract(value, '$.r'),
          ?, ?, json_extract(value, '$.f'), json_extract(value, '$.l'), 'open', ? FROM json_each(?)`).bind(periodFrom, periodTo, at, payload))
    }
    const res = await db.batch(stmts)
    return { run_id: Number(res[0]?.meta?.last_row_id) || null, status: 'ok', flagged: rows.length, rows_read: rowsRead, period_from: periodFrom, period_to: periodTo }
  }
}

/** その週（月曜はじまり・日本時間）の最初の日 */
export function weekStartJST(today = todayJST()): string {
  const wd = new Date(today + 'T00:00:00Z').getUTCDay()
  return addDays(today, -((wd + 6) % 7))
}

/**
 * 定期処理（3:30 の起動で毎日呼ぶ）: その週にまだ定期処理の集計が成功していなければ集計する（ふだんは月曜。失敗した週は翌日にやり直す）。
 * 集計しない日は問い合わせ1回で終わる（idle）
 */
export async function runShareDetectJob(db: D1Database): Promise<Record<string, unknown> & { idle?: boolean; failed?: number; error?: string | null }> {
  const weekStart = weekStartJST()
  const done = await db.prepare(`SELECT 1 AS x FROM share_detect_runs WHERE created_at >= ? AND trigger_type = 'cron' AND status = 'ok' LIMIT 1`).bind(weekStart).first()
  if (done) return { idle: true, week: weekStart }
  const r = await runShareDetection(db, { trigger: 'cron' })
  return { run_id: r.run_id, flagged: r.flagged, rows_read: r.rows_read, failed: r.status === 'failed' ? 1 : 0, error: r.error || null }
}

/** 次の定期の集計の目安（日本時間）。今週の分が済んでいれば来週の月曜 3:30、まだなら次の 3:30 */
export function nextShareRunAt(doneThisWeek: boolean, now = nowJST()): string {
  const today = now.slice(0, 10)
  if (doneThisWeek) return addDays(weekStartJST(today), 7) + ' 03:30'
  return (now.slice(11, 16) < '03:30' ? today : addDays(today, 1)) + ' 03:30'
}
