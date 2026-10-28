// Field OS スタッフ用SPA
// axios・dayjs を読み込めなかったときはここで止める（理由は head の LIB_FALLBACK が画面に出す。#409）
if (!window.axios || !window.dayjs) throw new Error('axios / dayjs を読み込めませんでした')
const $app = document.getElementById('app')
let ME = null
let HOME = null

const REPORT_LABELS = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
const REPORT_ICONS = { wake_up: 'fa-sun', departure: 'fa-person-walking-luggage', check_in: 'fa-store', work_start: 'fa-briefcase', break_start: 'fa-mug-hot', break_end: 'fa-person-walking', work_end: 'fa-flag-checkered', check_out: 'fa-door-open' }
// 写真添付が必須の報告種別
const PHOTO_REQUIRED_TYPES = ['check_in', 'check_out']
const PHOTO_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 選択可能な元画像の上限 (50MB)。端末の中で縮小してから送るので、高画素の写真も受け付ける（#536）
const PHOTO_TARGET_BYTES = 500 * 1024           // 圧縮後の目標上限 (500KB)
const PHOTO_MAX_EDGE = 1600                     // 長辺の最大px
let pendingPhoto = { blob: null, previewUrl: null, type: null, shiftId: null }
const CAT_LABELS = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }

// ms: 表示する時間（長い文の知らせは長めに出す。既定 2.5 秒）
function toast(msg, ms) {
  let root = document.getElementById('toast')
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
  const el = document.createElement('div')
  el.className = 'toast-msg'; el.textContent = msg
  root.appendChild(el)
  setTimeout(() => el.remove(), ms || 2500)
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) }
function fmtDate(d) { return d ? dayjs(d).format('M/D(ddd)').replace('Sun','日').replace('Mon','月').replace('Tue','火').replace('Wed','水').replace('Thu','木').replace('Fri','金').replace('Sat','土') : '' }
function loading() { $app.innerHTML = '<div class="flex justify-center py-16"><span class="spin"></span></div>' }
function modal(html) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-box p-5">${html}</div></div>`
}
window.closeModal = () => {
  document.getElementById('modal-root').innerHTML = ''
  if (pendingPhoto.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
  pendingPhoto = { blob: null, previewUrl: null, type: null, shiftId: null }
}

// ---------- API 呼び出しの共通処理（#180 #230 #346） ----------
// ログインは使うたびに延びる（サーバー側）。それでも切れたときは、理由を伝えてから元の画面に戻れるようにログインへ移る
let SESSION_ENDED = false
axios.interceptors.request.use(cfg => {
  // 起動時に読んだ自分と違う人のセッションで報告が記録されないよう、サーバーで照合する
  if (ME) cfg.headers['X-Expected-User-Id'] = String(ME.user_id)
  return cfg
})
axios.interceptors.response.use(r => r, e => {
  const r = e.response
  if (r && !SESSION_ENDED && r.status === 409 && r.data && r.data.code === 'account_switched') {
    SESSION_ENDED = true
    alert('このブラウザで別のアカウントにログインされました。画面を読み直します。')
    location.reload()
  } else if (r && !SESSION_ENDED && r.status === 401) {
    SESSION_ENDED = true
    if (ME) alert('ログインの期限が切れました。ログインし直すと、この画面に戻ります。')
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash)
  }
  return Promise.reject(e)
})
// 画面の処理で受け止められなかった API のエラー（500 など）を表示する。サーバーの文言には参照番号が入る
window.addEventListener('unhandledrejection', ev => {
  const e = ev.reason
  if (!e || !e.isAxiosError || SESSION_ENDED) return
  const st = e.response && e.response.status
  showApiError(e, st ? '処理に失敗しました' : '通信できませんでした。電波の状況を確かめて、もう一度お試しください')
})

// ログアウト（『その他』のメニューから。確認してから行う #336）。
// 通信できずサーバーのログアウトが済まなかったときは、ログイン画面へ移らずにそのことを表示する（#562。
// ログインの Cookie は画面から消せないため、移るとログインしたままになる）。端末に残した下書きはどちらの場合も消す
delegate('staffLogout', (el) => {
  if (!confirm('ログアウトしますか？\n次に使うときは、会社コード・スタッフ番号・パスワードの入力が必要です')) return
  withSubmitLock(el, async () => {
    const msg = document.getElementById('logout-msg')
    if (msg) msg.classList.add('hidden')
    let ok = true
    try { await axios.post('/api/auth/logout') } catch (e) { ok = !!e.response && e.response.status < 500 } // 4xx（ログインの期限切れなど）ならログアウト済み。5xx ではセッションが残っているかもしれない
    draftClearAll()
    if (ok) { SESSION_ENDED = true; location.href = '/login'; return }
    const text = '通信できないため、ログアウトできませんでした。この端末はログインしたままです。電波の良い場所で、もう一度「ログアウト」を押してください'
    if (msg) { msg.textContent = text; msg.classList.remove('hidden') }
    toast('ログアウトできませんでした')
  })
})

// ---------- 入力途中の下書き（日報・相談。#421） ----------
// 下のタブを押したり、電話・カメラから戻って画面が読み直されたりしても消えないよう、入力のたびに端末に保存する。
// ユーザーごとのキーにし、送信に成功したら消す。ログアウトでは全部消す。端末に保存できないとき（プライベートモードなど）は何もしない
const DRAFT_PREFIX = 'fos-draft:'
const DRAFT_KEEP_DAYS = 7
function draftKey(name) { return DRAFT_PREFIX + (ME ? ME.user_id : 0) + ':' + name }
function draftLoad(name) {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(name)) || 'null')
    if (!d || !d.saved_at || Date.now() - d.saved_at > DRAFT_KEEP_DAYS * 86400000) return null
    return d.data
  } catch (e) { return null }
}
function draftSave(name, data) { try { localStorage.setItem(draftKey(name), JSON.stringify({ saved_at: Date.now(), data })) } catch (e) { } }
function draftClear(name) { try { localStorage.removeItem(draftKey(name)) } catch (e) { } }
function draftClearAll() {
  try { Object.keys(localStorage).filter(k => k.startsWith(DRAFT_PREFIX)).forEach(k => localStorage.removeItem(k)) } catch (e) { }
}

// ---------- URL・電話番号のリンク（#375） ----------
// esc() した後の文字列に使う。http(s) の URL は新しいタブで開き、電話番号はタップで発信できるようにする。
// エスケープした引用符（&quot; など）や記号はリンクに含めない。後読みの正規表現は古い iOS で読み込みが止まるので使わない
const LINKIFY_RE = /(https?:\/\/(?:(?!&quot;|&#39;|&#96;|&lt;|&gt;)[^\s<>"'`])+)|(^|[^\d\w\/.=+-])(0\d{1,4}-\d{1,4}-\d{3,4}|0[5789]0\d{8}|0\d{9})(?![\d-])/g
function linkify(escaped) {
  return String(escaped == null ? '' : escaped).replace(LINKIFY_RE, (m, url, pre, tel) => {
    if (url) {
      // 文末の句読点・閉じかっこはリンクに含めない
      const t = url.match(/^(.*?)([).,;:!?、。）」』]+)?$/)
      const href = t[1], tail = t[2] || ''
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline break-all">${href}</a>${tail}`
    }
    return `${pre}<a href="tel:${tel.replace(/-/g, '')}" class="text-blue-600 underline whitespace-nowrap">${tel}</a>`
  })
}

// 読み込みに失敗したときの表示（#182 #465）。再読み込みのボタンで、起動からやり直すか今の画面を読み直す
function loadErrorHtml(e) {
  const serverMsg = e && e.response && e.response.data && e.response.data.error
  return `<div class="card p-6 text-center mt-4" role="alert">
      <i class="fas fa-wifi text-3xl text-gray-300 mb-2 block"></i>
      <p class="font-bold text-gray-700">${serverMsg ? esc(serverMsg) : '通信できませんでした'}</p>
      <p class="text-xs text-gray-500 mt-1">${serverMsg ? '時間をおいて再読み込みしてください' : '電波の良い場所で再読み込みしてください'}</p>
      <button class="btn btn-primary mt-4" data-action="retryLoad"><i class="fas fa-rotate-right"></i>再読み込み</button>
    </div>`
}
function showLoadError(e) {
  if (e && e.response && e.response.status === 401) return // ログイン画面へ移る（axios の共通処理）
  $app.innerHTML = loadErrorHtml(e)
}
delegate('retryLoad', () => { ME ? route() : boot() })

// ============ ホーム ============
// 描画は部分ごとの関数（シフトカード・報告ボタン・お知らせ・相談バナー・メニュー）を並べるだけにする
let HOME_SHIFT_ID = null   // ホームで選んだシフト（未選択ならサーバーが選ぶ）
let HOME_LOADED_DAY = null // ホームを読んだ日（端末の日付）

const HOME_TIMEOUT_MS = 25000
async function renderHome() {
  loading()
  let data, offline = false
  // 通信に失敗したら、読み込み中のまま止めずに再読み込みのボタンを出す（#182）。
  // 電波がない場所では、同じ日に読んだホームを出す（押した報告は端末に保存し、通信が戻ってから送る。#427）
  try { data = (await axios.get('/api/staff/home' + (HOME_SHIFT_ID ? '?shift_id=' + encodeURIComponent(HOME_SHIFT_ID) : ''), { timeout: HOME_TIMEOUT_MS })).data }
  catch (e) {
    if (e && !e.response && HOME && HOME_LOADED_DAY === dayjs().format('YYYY-MM-DD')) { data = HOME; offline = true }
    else { showLoadError(e); return }
  }
  HOME = data
  if (!offline) HOME_LOADED_DAY = dayjs().format('YYYY-MM-DD')
  await outboxLoad()
  drawHome(data, offline)
  if (!offline && outboxQueued().length) outboxFlush()
}
// offline: 通信できず、前に読んだホームを出している
function drawHome(data, offline) {
  $app.innerHTML = `
    ${offline ? homeOfflineHtml() : ''}
    <div id="home-outbox">${homeOutboxHtml()}</div>
    ${homeNoticeBannerHtml(data)}
    ${homeConsultBannerHtml(data)}
    ${homeMissedHtml(data)}
    ${data.shift ? homeShiftCardHtml(data) + homeReportButtonsHtml(data) + homeNextShiftHtml(data) : homeNoShiftHtml() + homeNextShiftHtml(data)}
    ${homeNoticesHtml(data)}
    ${homeMenuHtml()}`
  applyBadges() // 先に取れていた通知の件数を案内に足す
}
function homeOfflineHtml() {
  return `<div class="bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 mb-4 text-xs text-gray-700" role="status">
      <i class="fas fa-plane mr-1"></i>通信できないため、前に読み込んだ内容を表示しています。報告を押すと、押した時刻で端末に保存し、電波が戻ってから送ります
      <button type="button" class="underline font-bold ml-1" data-action="retryLoad">読み直す</button></div>`
}

// ---------- 次回の稼働（#278）と前日確認（#176） ----------
// 今日より後の最初の稼働日のシフト（同じ日に複数あればすべて）。明日のシフトで、会社が前日確認を使っていれば確認のボタンを出す。
// 『行けなくなった』は相談・連絡を、遅刻・欠勤相談・そのシフト・緊急度『高』を選んだ状態で開く（下書きに入れて開く）
function homeNextShiftHtml(data) {
  const list = data.next_shifts || []
  if (!list.length) return ''
  const d = list[0].work_date
  const days = dayjs(d).diff(dayjs(data.today), 'day')
  const rel = days === 1 ? '明日' : days === 2 ? 'あさって' : days > 0 ? days + '日後' : ''
  const checks = list.filter(x => x.day_before)
  const un = checks.filter(x => !x.day_before.confirmed_at)
  const changed = un.some(x => x.day_before.changed)
  const lastAt = checks.map(x => x.day_before.confirmed_at).filter(Boolean).sort().pop()
  const check = !checks.length ? ''
    : un.length ? `<div class="mt-3 pt-3 border-t border-gray-100" id="day-before-check">
        <p class="text-sm font-bold text-gray-800"><i class="fas fa-user-check text-blue-600 mr-1"></i>明日の稼働を確認してください</p>
        <p class="text-xs text-gray-500 mt-0.5">日時・場所を確かめて、${esc(un[0].day_before.deadline)}までに「確認しました」を押してください</p>
        ${changed ? '<p class="text-xs text-amber-800 bg-amber-50 rounded-lg px-2 py-1 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>確認の後にシフトが変わりました。もう一度確認してください</p>' : ''}
        <div class="grid grid-cols-2 gap-2 mt-2">
          <button type="button" class="btn btn-primary" data-action="homeDayBeforeConfirm" data-ids="${un.map(x => Number(x.shift_id)).join(',')}"><i class="fas fa-check"></i>確認しました</button>
          <button type="button" class="btn btn-outline" data-action="homeDayBeforeCannot" data-id="${Number(un[0].shift_id)}">行けなくなった</button>
        </div></div>`
    : `<p class="text-xs mt-3 text-emerald-700 bg-emerald-50 rounded-lg px-2 py-1.5"><i class="fas fa-check mr-1"></i>明日の稼働を確認済みです${lastAt ? '（' + esc(dayjs(String(lastAt).replace(' ', 'T')).format('M/D HH:mm')) + '）' : ''}
        <button type="button" class="underline ml-1" data-action="homeDayBeforeCannot" data-id="${Number(checks[0].shift_id)}">行けなくなった場合</button></p>`
  return `
    <section class="card p-4 mb-4" id="next-shift">
      <div class="flex items-center justify-between mb-1">
        <h2 class="font-bold text-gray-800"><i class="fas fa-calendar-day text-blue-600 mr-1"></i>次回の稼働</h2>
        <span class="badge badge-blue">${esc(rel ? rel + ' ' : '')}${esc(fmtDate(d))}</span>
      </div>
      ${list.map((x, i) => `<div class="${i ? 'mt-2 pt-2 border-t border-gray-100' : ''}">
        <p class="font-bold text-gray-900">${esc(formatShiftTime(x.start_time, x.end_time))} ${esc(x.project_name)}</p>
        ${data.multi_company ? `<p class="text-xs ${x.other_company ? 'text-blue-700' : 'text-gray-500'}"><i class="fas fa-building mr-1"></i>${esc(x.company_name)} のシフト</p>` : ''}
        ${shiftPlaceHtml(x, true)}
      </div>`).join('')}
      ${check}
    </section>`
}
delegate('homeDayBeforeConfirm', (el) => withSubmitLock(el, async () => {
  const ids = String(el.dataset.ids || '').split(',').map(Number).filter(n => n > 0)
  try {
    await axios.post('/api/staff/day-before-confirm', { shift_ids: ids })
    toast('明日の稼働を確認しました。当日は気をつけてお越しください', 3500)
  } catch (e) {
    showApiError(e, e && e.response ? '確認できませんでした' : '通信できませんでした。電波の良い場所で、もう一度押してください')
    if (!e || !e.response) return
  }
  renderHome()
}))
delegate('homeDayBeforeCannot', (el) => {
  // 書きかけの相談の本文は残す
  const old = draftLoad('consult') || {}
  draftSave('consult', { category: 'absence', shift_id: String(Number(el.dataset.id)), body: typeof old.body === 'string' ? old.body : '', urgency: 'high' })
  location.hash = 'consult'
  toast('遅刻・欠勤相談として、明日のシフトを選びました。理由を書いて送信してください', 5000)
})

// ホームのシフトを切り替える（本日のシフトの一覧から）
window.selectHomeShift = function (shiftId) {
  HOME_SHIFT_ID = Number(shiftId) || null
  renderHome()
}
delegate('selectHomeShift', (el) => selectHomeShift(el.dataset.id))

// 画面を開いたまま日付が変わったら、ホームを読み直す（前日のシフトに今の時刻で報告しないように）。読み直したら true
function homeIsStale() {
  if (!HOME_LOADED_DAY || HOME_LOADED_DAY === dayjs().format('YYYY-MM-DD')) return false
  HOME = null; HOME_SHIFT_ID = null; HOME_LOADED_DAY = null
  const tab = (location.hash || '#home').slice(1).split('/')[0]
  if (!tab || tab === 'home') renderHome()
  return true
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') homeIsStale() })
window.addEventListener('pageshow', () => homeIsStale())
setInterval(() => homeIsStale(), 60 * 1000)

// シフトの開催場所・住所（地図）・休憩・役割・枠のメモ（#188）。ホームのカードとシフト一覧で使う
function shiftBreakMinutes(s) {
  const b = s.break_minutes != null ? s.break_minutes : s.slot_break_minutes != null ? s.slot_break_minutes : s.project_break_minutes
  return b != null && Number(b) > 0 ? Number(b) : null
}
function shiftMapUrl(s) {
  const lat = Number(s.site_lat), lng = Number(s.site_lng)
  const q = s.site_lat != null && s.site_lng != null && Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : s.site_address
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : ''
}
function shiftPlaceHtml(s, compact) {
  const place = s.site_name || s.location
  const map = shiftMapUrl(s)
  const brk = shiftBreakMinutes(s)
  const tx = compact ? 'text-xs text-gray-500' : 'text-sm text-gray-600'
  return `
    ${place ? `<p class="${tx} mt-0.5"><i class="fas fa-location-dot text-gray-400 mr-1"></i>${esc(place)}</p>` : ''}
    ${s.site_address || map ? `<p class="text-xs text-gray-500 ${compact ? '' : 'ml-4'}">${esc(s.site_address || '')}${map ? ` <a href="${esc(map)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline whitespace-nowrap"><i class="fas fa-map-location-dot mr-0.5"></i>地図を開く</a>` : ''}</p>` : ''}
    ${compact ? '' : `<p class="${tx}"><i class="far fa-clock text-gray-400 mr-1"></i>${esc(formatShiftTime(s.start_time, s.end_time, ' 〜 '))}${brk ? `<span class="text-xs text-gray-500 ml-1">（休憩 ${brk}分）</span>` : ''}</p>`}
    ${s.role ? `<p class="${tx}"><i class="fas fa-user-tag text-gray-400 mr-1"></i>役割: ${esc(s.role)}${compact && brk ? `・休憩 ${brk}分` : ''}</p>` : compact && brk ? `<p class="${tx}">休憩 ${brk}分</p>` : ''}
    ${s.slot_memo ? `<p class="text-xs text-gray-700 bg-gray-50 rounded-lg px-2 py-1.5 mt-1 whitespace-pre-wrap"><i class="fas fa-note-sticky text-gray-400 mr-1"></i>${esc(s.slot_memo)}</p>` : ''}`
}

// シフトカード
function homeShiftCardHtml(data) {
  const s = data.shift
  const list = data.today_shifts || []
  const cur = list.find(x => x.shift_id === s.shift_id)
  // どの会社のシフトか（2社以上に所属している人だけ。他社のシフトは報告の送り先も出す。#503）
  const company = cur && cur.other_company
    ? `<p class="text-xs mt-2 text-blue-700 bg-blue-50 rounded-lg px-2 py-1"><i class="fas fa-building mr-1"></i>${esc(cur.company_name)} のシフトです。報告は自動的に ${esc(cur.company_name)} に送られます。</p>`
    : data.multi_company && cur ? `<p class="text-xs text-gray-500 mt-0.5"><i class="fas fa-building text-gray-400 mr-1"></i>${esc(cur.company_name)} のシフト</p>` : ''
  return `
    <section class="card p-4 mb-4" id="today-shift">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-bold text-gray-800"><i class="fas fa-calendar-check text-blue-600 mr-1"></i>${data.carryover ? '昨日からの勤務' : '今日の稼働'}</h2>
        <span class="flex items-center gap-1">${data.tentative ? '<span class="badge badge-yellow">未確定</span>' : ''}<span class="badge ${data.carryover ? 'badge-yellow' : 'badge-blue'}">${esc(fmtDate(s.work_date || data.today))}</span></span>
      </div>
      ${data.tentative ? '<p class="text-xs mb-2 text-amber-800 bg-amber-50 rounded-lg px-2 py-1"><i class="fas fa-hourglass-half mr-1"></i>管理者の確定待ちのシフト（希望（仮））です。確定されるまでは支払いの対象になりません。勤務する場合は管理者に確認してください。</p>' : ''}
      <p class="text-lg font-bold text-gray-900">${esc(s.project_name)}</p>
      ${shiftPlaceHtml(s, false)}
      ${company}
      ${data.carryover ? '<p class="text-xs mt-2 text-amber-800 bg-amber-50 rounded-lg px-2 py-1"><i class="fas fa-moon mr-1"></i>日付をまたぐ勤務です。勤務終了・退店などは、このまま報告できます。</p>' : ''}
      ${homeLateButtonHtml(data)}
      ${homeDayShiftsHtml(data, cur)}
    </section>`
}

// 『遅れます』の連絡（#498）。今日のシフトで、入店・勤務開始をまだ報告していない間だけ出す。
// 到着見込みの時刻と理由を、そのシフトの遅刻・欠勤相談（緊急度『高』）として送る。管理者のダッシュボードの未入店の一覧に『連絡あり』と出る
const LATE_REASONS = ['電車・バスの遅延', '道路の渋滞', '体調不良', '寝坊', 'その他']
function homeLateButtonHtml(data) {
  const s = data.shift
  if (!s || data.carryover || s.work_date !== data.today || data.tentative) return ''
  const r = homeReportsWithQueued(data)
  if (r.check_in || r.work_start) return ''
  return `<button type="button" class="btn btn-outline w-full mt-3 text-sm" data-action="homeLateOpen" data-shift-id="${Number(s.shift_id)}" data-start="${esc(String(s.start_time || '').slice(0, 5))}">
      <i class="fas fa-person-running text-amber-500"></i>遅れそうなとき（到着の見込みを連絡）</button>`
}
delegate('homeLateOpen', (el) => {
  const start = /^\d{2}:\d{2}$/.test(el.dataset.start || '') ? el.dataset.start : ''
  // 到着見込みの初期値: 今から15分後（開始より前なら開始の時刻）を5分単位に切り上げる
  let eta = dayjs().add(15, 'minute')
  eta = eta.minute(Math.ceil(eta.minute() / 5) * 5)
  const etaStr = start && eta.format('HH:mm') < start && dayjs().format('HH:mm') < start ? start : eta.format('HH:mm')
  modal(`<h3 class="font-bold text-gray-800 mb-1"><i class="fas fa-person-running text-amber-500 mr-1"></i>遅れることを連絡する</h3>
    <p class="text-sm text-gray-600 mb-3">管理者に「遅刻・欠勤相談」として届きます。${start ? `開始は ${esc(start)} です。` : ''}</p>
    <label class="text-sm text-gray-600 block mb-1" for="late-eta">到着の見込み</label>
    <input type="time" id="late-eta" class="inp mb-3" value="${esc(etaStr)}">
    <p class="text-sm text-gray-600 mb-1">理由</p>
    <div class="grid grid-cols-2 gap-2 mb-2">${LATE_REASONS.map((x, i) => `<label class="flex items-center gap-2 rounded-lg border p-2 text-sm"><input type="radio" name="late-reason" value="${esc(x)}" ${i === 0 ? 'checked' : ''}>${esc(x)}</label>`).join('')}</div>
    <textarea id="late-note" class="inp" rows="2" maxlength="300" placeholder="補足（任意。「その他」のときは必須）"></textarea>
    <p class="text-[11px] text-gray-500 mt-2">行けなくなった場合は、「相談・連絡」から欠勤の連絡をしてください。急ぎの場合は電話でも連絡してください</p>
    <div id="late-msg" class="text-sm text-red-600 mt-2" role="alert"></div>
    <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="homeLateSend" data-shift-id="${Number(el.dataset.shiftId)}"><i class="fas fa-paper-plane"></i>送信する</button></div>`)
})
delegate('homeLateSend', (el) => withSubmitLock(el, async () => {
  const msg = document.getElementById('late-msg')
  const eta = (document.getElementById('late-eta') || {}).value || ''
  const reason = (document.querySelector('input[name="late-reason"]:checked') || {}).value || ''
  const note = ((document.getElementById('late-note') || {}).value || '').trim()
  if (!/^\d{2}:\d{2}$/.test(eta)) { msg.textContent = '到着の見込みの時刻を入力してください'; return }
  if (reason === 'その他' && !note) { msg.textContent = '「その他」の場合は、理由を入力してください'; return }
  const body = `【遅れます】到着の見込み ${eta}\n理由: ${reason}${note ? '\n' + note : ''}`
  try {
    await axios.post('/api/staff/consultations', { category: 'absence', urgency: 'high', shift_id: Number(el.dataset.shiftId), body })
  } catch (e) {
    msg.textContent = (e && e.response && e.response.data && e.response.data.error) || (e && e.response ? '送信できませんでした' : CONSULT_NET_ERROR)
    return
  }
  closeModal()
  toast(`到着の見込み（${eta}）を管理者に連絡しました。着いたら入店報告をしてください`, 5000)
}))

// 本日の予定（同じ日に複数のシフトがある場合。#504）。時刻順に並べ、タップでそのシフトの報告に切り替える
function homeDayShiftsHtml(data, cur) {
  const list = data.today_shifts || []
  if (list.length < 2) return ''
  return `<div class="mt-3 pt-2 border-t border-gray-100" id="home-day-shifts">
      <p class="text-xs font-bold text-gray-600 mb-1">本日の予定（${list.length}件）</p>
      ${list.map(x => {
        const isCur = !!cur && x.shift_id === cur.shift_id
        const st = x.tentative ? '<span class="badge badge-yellow">未確定</span>'
          : x.attendance_done ? `<span class="badge badge-green">報告済み</span>${x.daily_report_required && !x.daily_report_done ? '<span class="badge badge-yellow">日報未提出</span>' : ''}` : ''
        return `<button type="button" class="w-full text-left mt-1 px-2 py-1.5 rounded-lg border ${isCur ? 'border-blue-300 bg-blue-50' : 'border-gray-100'}" ${isCur ? 'aria-current="true"' : ''} data-action="selectHomeShift" data-id="${Number(x.shift_id)}">
          <span class="flex items-center justify-between gap-2">
            <span class="text-sm ${isCur ? 'font-bold text-blue-800' : 'text-gray-700'}">${x.carryover ? '昨日 ' : ''}${esc(formatShiftTime(x.start_time, x.end_time))} ${esc(x.project_name)}</span>
            <span class="flex items-center gap-1 shrink-0">${st}</span>
          </span>
          ${x.location || data.multi_company ? `<span class="block text-[11px] text-gray-500">${esc(x.location || '')}${data.multi_company ? `${x.location ? '・' : ''}${esc(x.company_name)}` : ''}</span>` : ''}
        </button>`
      }).join('')}
      <p class="text-[11px] text-gray-400 mt-1">報告がすべて済むと、次のシフトに切り替わります。シフトをタップすると、そのシフトの報告に切り替えられます。</p>
    </div>`
}

// 前日以前の報告漏れ（#483）。項目をタップすると、打刻履歴の打刻漏れの追加の申請を開く
function homeMissedHtml(data) {
  const m = data.missed_reports
  if (!m || !m.total) return ''
  return `<section class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-sm text-red-800" role="alert" id="missed-reports">
      <p class="font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>前日までの報告漏れがあります（${Number(m.total)}件のシフト）</p>
      <p class="text-xs mt-0.5">項目をタップすると、打刻漏れの追加を申請できます。管理者が承認すると記録されます</p>
      ${m.shifts.map(x => `<div class="mt-2 pt-2 border-t border-red-100">
        <p class="text-xs font-bold">${esc(fmtDate(x.work_date))} ${esc(formatShiftTime(x.start_time, x.end_time))} ${esc(x.project_name)}${data.multi_company ? `（${esc(x.company_name)}）` : ''}</p>
        <div class="flex flex-wrap gap-1.5 mt-1">${x.missing.map(t => `<button type="button" class="text-xs bg-white border border-red-200 text-red-700 rounded-full px-2.5 py-1" data-action="openMissedReport" data-shift-id="${Number(x.shift_id)}" data-type="${esc(t)}">${esc(REPORT_LABELS[t] || t)}<i class="fas fa-chevron-right text-[10px] ml-1"></i></button>`).join('')}</div>
      </div>`).join('')}
      ${m.total > m.shifts.length ? `<a href="#attendance" class="block text-xs underline mt-2">ほか ${Number(m.total) - m.shifts.length}件は打刻履歴から申請してください</a>` : ''}
    </section>`
}
delegate('openMissedReport', (el) => {
  const shiftId = Number(el.dataset.shiftId), type = el.dataset.type
  if (window.attOpenMissed) attOpenMissed(shiftId, type)
  else location.hash = 'attendance'
})

// ---------- 電波がない場所での報告（#427） ----------
// 通信できずに送れなかった報告は、押した時刻・位置・写真を端末（IndexedDB）に保存し、通信が戻ったら押した順に送る。
// 送るときは押した時刻（pressed_at）と押したときに作った一意キー（client_request_id）を付ける。サーバーは時刻の範囲を確かめ、
// 押した時刻で記録したことを管理者に示す。同じキーの再送は記録済みとして受け付けられる（応答だけが届かなかった場合も二重にならない）。
// 断られた報告（受付の時間帯を過ぎた・管理者が記録済みなど）は『送れなかった報告』としてホームに出し、打刻履歴からの申請を案内する。
// 端末に保存できない（プライベートモードなど）ときは、これまでどおりエラーを出す
const OUTBOX_DB = 'fos-outbox', OUTBOX_STORE = 'reports'
const OUTBOX_KEEP_DAYS = 7
const ATTENDANCE_TIMEOUT_MS = 20000, ATTENDANCE_PHOTO_TIMEOUT_MS = 60000
let OUTBOX = [] // この人の保存中の報告（画面の表示用。outboxLoad で読み直す）
function newRequestId() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch (e) { }
  const a = new Uint8Array(16); crypto.getRandomValues(a)
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
}
function outboxOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('indexedDB なし')); return }
    const req = indexedDB.open(OUTBOX_DB, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(OUTBOX_STORE)) req.result.createObjectStore(OUTBOX_STORE, { keyPath: 'id' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function outboxTx(mode, fn) {
  const db = await outboxOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, mode)
    const r = fn(tx.objectStore(OUTBOX_STORE))
    tx.oncomplete = () => { db.close(); resolve(r ? r.result : undefined) }
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
  })
}
// この人の保存中の報告（押した順）。古いもの（ほかの人の分を含む）は消す
async function outboxAll() {
  let all = []
  try { all = (await outboxTx('readonly', st => st.getAll())) || [] } catch (e) { return [] }
  const old = all.filter(x => !x.pressed_at || Date.now() - x.pressed_at > OUTBOX_KEEP_DAYS * 86400000)
  for (const x of old) await outboxDelete(x.id)
  return all.filter(x => !old.includes(x) && ME && x.user_id === ME.user_id).sort((a, b) => a.pressed_at - b.pressed_at)
}
async function outboxLoad() { OUTBOX = await outboxAll(); return OUTBOX }
async function outboxDelete(id) { try { await outboxTx('readwrite', st => st.delete(id)) } catch (e) { } }
// 保存できたら true
async function outboxAdd(item) {
  if (!ME) return false
  const s = HOME && HOME.shift && HOME.shift.shift_id === item.shift_id ? HOME.shift : null
  try {
    await outboxTx('readwrite', st => st.put({ ...item, user_id: ME.user_id, state: 'queued', work_date: s ? s.work_date : null, project_name: s ? s.project_name : '' }))
  } catch (e) { return false }
  await outboxLoad()
  return true
}
const outboxQueued = () => OUTBOX.filter(x => x.state === 'queued')
const outboxLabel = (x) => `${REPORT_LABELS[x.report_type] || x.report_type}（${dayjs(x.pressed_at).format('M/D HH:mm')} に押した${x.project_name ? '・' + x.project_name : ''}）`
function outboxQueuedNotice(type, pressedAt) {
  toast(`電波がないため、${REPORT_LABELS[type]}を押した時刻（${dayjs(pressedAt).format('HH:mm')}）で端末に保存しました。電波が戻ると自動で送ります`, 6000)
}
function outboxSend(it) {
  if (it.photo) {
    const form = new FormData()
    form.append('shift_id', String(it.shift_id))
    form.append('report_type', it.report_type)
    if (it.latitude != null) { form.append('latitude', String(it.latitude)); form.append('longitude', String(it.longitude)) }
    form.append('photo', new Blob([it.photo.buf], { type: it.photo.type || 'image/jpeg' }), 'attendance.jpg')
    if (it.photo.taken_at) form.append('photo_taken_at', String(it.photo.taken_at))
    if (it.photo.source) form.append('photo_source', it.photo.source)
    form.append('client_request_id', it.id)
    form.append('pressed_at', String(it.pressed_at))
    return axios.post('/api/staff/attendance-photo', form, { timeout: ATTENDANCE_PHOTO_TIMEOUT_MS })
  }
  // 写真なしの入店・退店（理由つき。#535）も同じ API で送る
  return axios.post('/api/staff/attendance', { shift_id: it.shift_id, report_type: it.report_type, latitude: it.latitude, longitude: it.longitude, address: null,
    client_request_id: it.id, pressed_at: it.pressed_at, ...(it.no_photo_reason ? { no_photo_reason: it.no_photo_reason, no_photo_note: it.no_photo_note || '' } : {}) }, { timeout: ATTENDANCE_TIMEOUT_MS })
}
const homeTabActive = () => { const t = (location.hash || '#home').slice(1).split('/')[0]; return !t || t === 'home' }
// 保存中の報告を押した順に送る。通信できない・サーバーの障害の間は、順序を保つため後の報告も送らない。
// noRedraw: 新しい報告を送る前に呼ぶとき（送った後にホームを読み直すので、ここでは読み直さない）
let OUTBOX_FLUSHING = null
function outboxFlush(manual, noRedraw) {
  if (OUTBOX_FLUSHING) return OUTBOX_FLUSHING
  if (!ME) return Promise.resolve()
  OUTBOX_FLUSHING = (async () => {
    const sent = [], failed = []
    let waiting = false
    for (const it of (await outboxAll()).filter(x => x.state === 'queued')) {
      try { await outboxSend(it); await outboxDelete(it.id); sent.push(it) }
      catch (e) {
        const st = e && e.response && e.response.status
        if (!st || st >= 500 || st === 401) { waiting = true; break }
        try { await outboxTx('readwrite', x => x.put({ ...it, state: 'failed', error: attendanceErrorMessage(e, it.report_type), photo: null })) } catch (e2) { }
        failed.push(it)
      }
    }
    await outboxLoad()
    if (sent.length) toast(`通信が戻ったので、端末に保存した報告を送信しました（${sent.map(x => REPORT_LABELS[x.report_type]).join('・')}）`, 5000)
    if (failed.length) toast('端末に保存した報告のうち、送れなかったものがあります。ホームで理由を確かめてください', 6000)
    else if (manual && waiting) toast('まだ通信できません。電波の良い場所で、もう一度お試しください')
    if ((sent.length || failed.length) && homeTabActive() && !noRedraw) renderHome()
    else { const box = document.getElementById('home-outbox'); if (box) box.innerHTML = homeOutboxHtml() }
  })().finally(() => { OUTBOX_FLUSHING = null })
  return OUTBOX_FLUSHING
}
window.addEventListener('online', () => { if (ME) outboxFlush() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && outboxQueued().length) outboxFlush() })
setInterval(() => { if (ME && !OUTBOX_FLUSHING) outboxLoad().then(() => { if (outboxQueued().length && navigator.onLine !== false) outboxFlush() }) }, 60 * 1000)
// 保存中・送れなかった報告の案内（ホームの先頭）
function homeOutboxHtml() {
  const q = outboxQueued(), f = OUTBOX.filter(x => x.state === 'failed')
  if (!q.length && !f.length) return ''
  return `
    ${q.length ? `<section class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800" role="status">
      <p class="font-bold"><i class="fas fa-cloud-arrow-up mr-1"></i>まだ送れていない報告が${q.length}件あります</p>
      <p class="text-xs mt-0.5">押した時刻で端末に保存しています。電波が戻ると自動で送ります（アプリを閉じても、次に開いたときに送ります）</p>
      <ul class="text-xs mt-1 list-disc ml-5">${q.map(x => `<li>${esc(outboxLabel(x))}</li>`).join('')}</ul>
      <button type="button" class="btn btn-outline text-xs mt-2" data-action="outboxSendNow"><i class="fas fa-rotate-right"></i>今すぐ送る</button>
    </section>` : ''}
    ${f.length ? `<section class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-sm text-red-800" role="alert">
      <p class="font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>端末に保存した報告を送れませんでした</p>
      ${f.map(x => `<div class="mt-2 pt-2 border-t border-red-100">
        <p class="text-xs font-bold">${esc(outboxLabel(x))}</p>
        <p class="text-xs">${esc(x.error || '')}</p>
        <div class="flex gap-3 mt-1"><a href="#attendance" class="text-xs underline">打刻履歴から申請する</a>
          <button type="button" class="text-xs underline" data-action="outboxDismiss" data-id="${esc(x.id)}">閉じる</button></div>
      </div>`).join('')}
    </section>` : ''}`
}
delegate('outboxSendNow', (el) => withSubmitLock(el, () => outboxFlush(true)))
delegate('outboxDismiss', async (el) => {
  await outboxDelete(el.dataset.id)
  await outboxLoad()
  const box = document.getElementById('home-outbox'); if (box) box.innerHTML = homeOutboxHtml()
})
// ホームの報告に、保存中（未送信）の報告を足す（押した報告は押せないようにし、後の報告を押せるようにする）
function homeReportsWithQueued(data) {
  const r = { ...((data && data.reports) || {}) }
  if (!data || !data.shift) return r
  for (const x of outboxQueued()) {
    if (x.shift_id === data.shift.shift_id && !r[x.report_type]) r[x.report_type] = { report_type: x.report_type, reported_at: dayjs(x.pressed_at).format('YYYY-MM-DD HH:mm:ss'), queued: true }
  }
  return r
}

// 報告の状態（サーバーの checkReportable と同じ考え方）
//   done: 報告済み / pending: 打刻修正を申請中（承認待ち。押せない）/ skipped: 後の報告が済んでいて押せない（打刻修正の申請で追加する）
//   open: 押せる（前の報告を飛ばして押すこともできる）。open の先頭が『次の報告』
const REPORT_ORDER = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
//   今受け付けていない報告（サーバーの reportableWindow。ホームの report_window_open）は押せない。
//   日をまたいだ後の入店・勤務開始も、予定の終了までは押せる（#134）。report_window_open が無いときは、前日からのシフト（carryover）は
//   翌日も受け付ける報告（休憩・勤務終了・退店）だけを押せる
const NEXT_DAY_REPORTS = ['break_start', 'break_end', 'work_end', 'check_out']
function homeReportStates(order, reports, pending, carryover, windowOpen) {
  const lastDone = REPORT_ORDER.reduce((m, t, i) => reports[t] ? i : m, -1)
  const closed = (t) => windowOpen && t in windowOpen ? !windowOpen[t] : carryover && !NEXT_DAY_REPORTS.includes(t)
  const out = {}
  for (const t of order) {
    out[t] = reports[t] ? 'done' : pending[t] ? 'pending'
      : REPORT_ORDER.indexOf(t) < lastDone || closed(t) ? 'skipped' : 'open'
  }
  return out
}

// 押し間違いの取消（#323）: 最後に済んだ報告が、本人がアプリで送ったもの（修正されていない）で、送ってから WITHDRAW_MINUTES 分以内なら取り消せる。
// 休憩なし（休憩入・休憩出が同じ時刻）は2つまとめて取り消す。最終的な可否はサーバーが判定する。
// 押した時刻（端末時刻）で記録した報告は、サーバーと同じく受け取った時刻から数える（#427。後から送った直後でも取り消せる）
const WITHDRAW_MINUTES = 5
const isNoBreak = (r) => !!(r.break_start && r.break_end && r.break_start.reported_at === r.break_end.reported_at)
const withdrawFrom = (x) => (x.device_time && x.received_at ? x.received_at : x.reported_at)
function homeWithdrawable(r) {
  const last = REPORT_ORDER.slice().reverse().find(t => r[t])
  const x = last && r[last]
  if (!x || x.entry_method !== 'app' || x.corrected) return null
  if (dayjs().diff(dayjs(withdrawFrom(x)), 'minute', true) >= WITHDRAW_MINUTES) return null
  const noBreak = last === 'break_end' && isNoBreak(r) && r.break_start.entry_method === 'app' && !r.break_start.corrected
  return { type: last, noBreak }
}

// 報告済みの行の説明と印（遅延・位置情報なし・早い終了・管理者の代理入力・修正済み。#347 #327）。HTML を返す
function homeDoneSubHtml(x, workDate, noBreak) {
  if (noBreak) return `休憩なし（${esc(formatReportedTime(x.reported_at, workDate))} に記録）`
  const marks = []
  if (x.status === 'late') marks.push(`<span class="badge badge-red">遅延${x.late_minutes ? ' ' + Number(x.late_minutes) + '分' : ''}</span>`)
  if (x.status === 'no_location') marks.push('<span class="badge badge-yellow">位置情報なし</span>')
  if (Number(x.early_leave_minutes) > 0) marks.push(`<span class="badge badge-yellow">予定より${Number(x.early_leave_minutes)}分早い</span>`)
  if (x.entry_method === 'proxy') marks.push('<span class="badge badge-purple">管理者が入力</span>')
  if (x.corrected) marks.push('<span class="badge badge-gray">修正済み</span>')
  // 電波がない場所で押して、後から送った報告（#427）
  if (x.device_time) marks.push(`<span class="badge badge-gray">押した時刻で記録${x.received_at ? '（送信 ' + esc(formatReportedTime(x.received_at, workDate)) + '）' : ''}</span>`)
  return `報告済み ${esc(formatReportedTime(x.reported_at, workDate))}${marks.length ? ' ' + marks.join(' ') : ''}`
}

// 報告ボタン（勤怠報告と日報）
function homeReportButtonsHtml(data) {
  const s = data.shift
  // 端末に保存中（未送信）の報告も、押した報告として扱う（#427）
  const r = homeReportsWithQueued(data)
  const queuedAny = Object.values(r).some(x => x && x.queued)
  const pend = data.pending_corrections || {}
  // 提出設定（案件・スタッフ・シフトごと）で必要な報告だけを表示する
  const order = (data.required_attendance || ['wake_up', 'departure', 'check_in', 'check_out'])
  const dailyRequired = data.daily_report_required !== false
  const states = homeReportStates(order, r, pend, data.carryover, data.report_window_open)
  const nextType = order.find(t => states[t] === 'open')
  const nextIdx = nextType ? order.indexOf(nextType) : -1
  const skipped = order.filter(t => states[t] === 'skipped')
  const allDone = nextIdx === -1 && !skipped.length && !queuedAny && !order.some(t => states[t] === 'pending') && (!dailyRequired || data.daily_report_done)
  // ほかのシフトで、報告は済んだが日報が未提出のもの（1日に複数のシフトがある場合）
  const pendingDaily = (data.today_shifts || []).filter(x => x.shift_id !== s.shift_id && x.attendance_done && x.daily_report_required && !x.daily_report_done)
  const noBreak = isNoBreak(r)
  // 休憩を取らなかった日は、休憩入・休憩出を押さずに『休憩なし』で記録できる（#324）
  const canNoBreak = states.break_start === 'open' && states.break_end === 'open'
  const wd = homeWithdrawable(r)
  const checkedAt = data.daily_report_checked_at
  return `
    <section class="mb-4" id="attendance-section">
      <h2 class="font-bold text-gray-800 mb-2 px-1 flex items-center">${data.carryover ? '勤務の報告' : '本日の報告'} ${allDone ? '<span class="badge badge-green ml-1">すべて完了</span>' : ''}
        <a href="#attendance" class="ml-auto text-xs font-normal text-blue-600"><i class="fas fa-user-clock mr-0.5"></i>打刻の修正・追加</a></h2>
      ${!order.length && !dailyRequired ? '<p class="card p-4 text-sm text-gray-500">このシフトは勤怠報告・日報の提出は不要です</p>' : ''}
      ${pendingDaily.map(x => `<button class="w-full text-left bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mb-2.5 text-sm text-amber-800" onclick="location.hash='report/${Number(x.shift_id)}'">
        <i class="fas fa-pen-to-square mr-1"></i>${esc(x.start_time)}〜 ${esc(x.project_name)} の日報が未提出です<span class="underline font-bold ml-1">入力する</span></button>`).join('')}
      ${skipped.length ? `<a href="#attendance" class="block bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mb-2.5 text-sm text-amber-800">
        <i class="fas fa-triangle-exclamation mr-1"></i>${esc(skipped.map(t => REPORT_LABELS[t]).join('・'))} が未報告です。打刻履歴から打刻漏れの追加を申請してください<span class="underline font-bold ml-1">申請する</span></a>` : ''}
      <div class="space-y-2.5">
        ${order.map((t, i) => {
          const st = states[t]
          const queued = st === 'done' && !!r[t].queued
          const done = st === 'done' && !queued
          const isNext = i === nextIdx
          const open = st === 'open'
          const photoOn = data.photo_required_attendance !== false
          const sub = queued ? esc(`未送信（${formatReportedTime(r[t].reported_at, s.work_date)} に押した報告を端末に保存しています。電波が戻ると自動で送ります）`)
            : done ? homeDoneSubHtml(r[t], s.work_date, noBreak && (t === 'break_start' || t === 'break_end'))
            : esc(st === 'pending' ? `打刻修正を申請中 ${formatReportedTime(pend[t], s.work_date)}（承認待ち）`
              : st === 'skipped' ? '未報告（打刻履歴から追加を申請してください）'
              : isNext ? 'タップして報告' : 'タップして報告（前の報告を飛ばします）')
          return `<button class="report-btn ${done ? 'done' : isNext ? 'next' : ''}" ${open ? '' : 'disabled'} data-action="homeReport" data-type="${esc(t)}" data-shift-id="${Number(s.shift_id)}">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${done ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : st === 'pending' || queued ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-400'}">
              <i class="fas ${done ? 'fa-check' : queued ? 'fa-cloud-arrow-up' : st === 'pending' ? 'fa-hourglass-half' : REPORT_ICONS[t]}"></i>
            </span>
            <span class="flex-1">
              <span class="block font-bold ${done ? 'text-emerald-700' : queued ? 'text-amber-700' : isNext ? 'text-blue-700' : 'text-gray-500'}">${REPORT_LABELS[t]}</span>
              <span class="block text-xs ${done ? 'text-emerald-600' : st === 'pending' || queued ? 'text-amber-700' : 'text-gray-400'}">
                ${sub}
                ${t === 'check_in' && open ? (photoOn ? ' (位置情報・写真が必要です)' : ' (位置情報を取得します)') : ''}
                ${t === 'check_out' && open && photoOn ? ' (写真が必要です)' : ''}
              </span>
            </span>
            ${isNext ? '<i class="fas fa-chevron-right text-blue-400"></i>' : ''}
          </button>${t === 'break_start' && canNoBreak ? `
          <div class="flex justify-end -mt-1 px-1"><button type="button" class="text-xs text-gray-600 underline" data-action="homeNoBreak" data-shift-id="${Number(s.shift_id)}"><i class="fas fa-mug-hot mr-1"></i>休憩を取らなかった（休憩なしで記録する）</button></div>` : ''}${wd && wd.type === t ? `
          <div class="flex justify-end -mt-1 px-1"><button type="button" class="text-xs text-red-600 underline" data-action="homeWithdraw" data-type="${esc(t)}" data-no-break="${wd.noBreak ? '1' : ''}" data-shift-id="${Number(s.shift_id)}"><i class="fas fa-rotate-left mr-1"></i>押し間違いを取り消す（送信から${WITHDRAW_MINUTES}分以内）</button></div>` : ''}`
        }).join('')}
        ${order.some(t => states[t] === 'pending') ? '<a href="#attendance" class="block text-xs text-blue-600 px-1">申請中の報告を今の時刻で報告する場合は、打刻履歴の「修正申請」から申請を取り消してください</a>' : ''}
        ${dailyRequired ? `<button class="report-btn ${data.daily_report_done ? 'done' : (r.check_out || nextIdx === -1) ? 'next' : ''}" onclick="location.hash='report/${Number(s.shift_id)}'">
          <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${data.daily_report_done ? 'bg-emerald-500 text-white' : r.check_out ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}">
            <i class="fas ${data.daily_report_done ? 'fa-check' : 'fa-pen-to-square'}"></i>
          </span>
          <span class="flex-1">
            <span class="block font-bold ${data.daily_report_done ? 'text-emerald-700' : 'text-gray-700'}">日報・実績入力</span>
            <span class="block text-xs text-gray-400">${!data.daily_report_done ? '稼働終了後に入力してください'
              : checkedAt != null ? `管理者が確認済み${checkedAt ? '（' + esc(dayjs(checkedAt).format('M/D HH:mm')) + '）' : ''}・修正可` : '提出済み・管理者の確認待ち（修正可）'}</span>
          </span>
          <i class="fas fa-chevron-right text-gray-300"></i>
        </button>` : ''}
      </div>
    </section>`
}

// シフトがない日
function homeNoShiftHtml() {
  return `<section class="card p-6 mb-4 text-center text-gray-500">
      <i class="fas fa-mug-hot text-3xl text-gray-300 mb-2"></i>
      <p class="font-bold">今日の稼働予定はありません</p>
      <p class="text-xs mt-1">シフトタブから予定を確認できます</p>
      <a href="#attendance" class="inline-block text-xs text-blue-600 underline mt-3"><i class="fas fa-user-clock mr-0.5"></i>打刻履歴・修正申請</a>
    </section>`
}

// お知らせと通知の未読の案内（1本にまとめる #383）。お知らせの未読はすべてのお知らせで数える（#325）。
// 通知の件数は /api/staff/badges で取ってから足す（refreshBadges）
function homeNoticeBannerHtml(data) {
  const n = data.notice_unread_count != null ? Number(data.notice_unread_count) || 0 : (data.notices || []).filter(x => !x.is_read).length
  const other = (data.notice_other_companies || []).reduce((s, o) => s + (Number(o.unread) || 0), 0)
  return `<div id="home-unread-banner">${homeUnreadBannerInner(n, null, other)}</div>`
}
function homeUnreadBannerInner(notices, notifications, other) {
  const parts = []
  if (notices) parts.push(`<a href="#notices" class="underline font-bold">未読のお知らせ ${Number(notices)}件</a>`)
  if (notifications) parts.push(`<a href="#notifications" class="underline font-bold">未読の通知 ${Number(notifications)}件</a>`)
  if (!parts.length && !other) return ''
  return `<div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800" role="alert">
      ${parts.length ? `<p><i class="fas fa-bell mr-1"></i>${parts.join('・')} があります</p>` : ''}
      ${other ? `<p class="${parts.length ? 'mt-1 text-xs' : ''}"><i class="fas fa-building mr-1"></i>ほかの所属企業に未読のお知らせが ${Number(other)}件 あります <a href="#notices" class="underline font-bold ml-1">確認する</a></p>` : ''}
    </div>`
}

// お知らせ: 未読の緊急・重要・確認必須を上に固定し（#384）、残りは新しい順（サーバーで並べたもの）
function homeNoticesHtml(data) {
  return `
    <section class="card p-4 mb-4" id="notice-preview">
      <h2 class="font-bold text-gray-800 mb-2 flex items-center"><i class="fas fa-bullhorn text-blue-600 mr-1"></i>お知らせ
        <a href="#notices" class="ml-auto text-xs font-normal text-blue-600">すべて見る<i class="fas fa-chevron-right text-[10px] ml-0.5"></i></a></h2>
      ${(data.notices || []).map(n => `
        <a class="block py-2 border-b border-gray-50 last:border-0 ${n.pinned ? 'bg-red-50/40 -mx-2 px-2 rounded' : ''}" href="#notices/${Number(n.notice_id)}">
          <div class="flex items-center gap-2">
            ${n.pinned ? '<i class="fas fa-thumbtack text-red-400 text-xs shrink-0" title="未読の重要なお知らせ"></i>' : ''}
            ${noticeImportanceBadge(n)}
            ${n.read_required && !n.is_read ? '<span class="badge badge-purple">確認必須</span>' : ''}
            ${!n.is_read ? '<span class="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>' : ''}
            <span class="text-sm ${n.is_read ? 'text-gray-500' : 'font-bold text-gray-800'} truncate">${esc(n.title)}</span>
          </div>
          <span class="text-xs text-gray-400">${esc(dayjs(String(n.published_at).replace(' ', 'T')).format('M/D'))}</span>
        </a>`).join('') || '<p class="text-sm text-gray-400">お知らせはありません</p>'}
    </section>`
}

// 相談バナー（管理者からの返信をまだ読んでいない場合）。相談・連絡の画面を開くと既読になって消える（#320）
function homeConsultBannerHtml(data) {
  const n = Number(data.replied_consultations) || 0
  return n ? `<a href="#consult" class="block bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800" role="alert">
      <i class="fas fa-reply mr-1"></i>管理者から相談への返信があります（${n}件） <span class="underline font-bold ml-1">確認する</span></a>` : ''
}

// メニュー
function homeMenuHtml() {
  return `
    <div class="grid grid-cols-2 gap-3">
      <a href="#shift" class="card p-4 text-center"><i class="fas fa-calendar-days text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">シフト確認</span></a>
      <a href="#consult" class="card p-4 text-center"><i class="fas fa-comments text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">相談・連絡</span></a>
    </div>`
}

// 報告ボタン: 未確定のシフト・前の報告を飛ばす場合は確認してから、写真が必要なら写真の画面、それ以外はそのまま送信する。
// 勤務終了・退店（写真の画面を通らない場合）と、休憩入からすぐの休憩出は、押し間違いを防ぐため確認してから送る（#323 #324）
const TENTATIVE_CONFIRM = 'このシフトはまだ確定していません（希望（仮））。確定されるまでは支払いの対象になりません。\n管理者に勤務を確認したうえで報告しますか？'
const SHORT_BREAK_MINUTES = 5
delegate('homeReport', (el) => {
  if (!HOME || !HOME.shift) return
  const type = el.dataset.type, shiftId = Number(el.dataset.shiftId)
  if (HOME.tentative && !confirm(TENTATIVE_CONFIRM)) return
  const order = HOME.required_attendance || []
  const reports = homeReportsWithQueued(HOME)
  const states = homeReportStates(order, reports, HOME.pending_corrections || {}, HOME.carryover, HOME.report_window_open)
  const skipping = order.filter(t => states[t] === 'open' && REPORT_ORDER.indexOf(t) < REPORT_ORDER.indexOf(type))
  if (skipping.length && !confirm(`${skipping.map(t => REPORT_LABELS[t]).join('・')} が未報告です。\n飛ばして${REPORT_LABELS[type]}を報告すると、飛ばした報告はこの画面から押せなくなります（打刻履歴から打刻漏れの追加を申請してください）。\n報告しますか？`)) return
  const photoOn = HOME.photo_required_attendance !== false
  const now = dayjs().format('HH:mm')
  if (type === 'break_end' && reports.break_start) {
    const mins = Math.floor(dayjs().diff(dayjs(reports.break_start.reported_at), 'minute', true))
    if (mins < SHORT_BREAK_MINUTES && !confirm(`休憩入（${formatReportedTime(reports.break_start.reported_at, HOME.shift.work_date)}）から${Math.max(0, mins)}分しかたっていません。\n休憩出を今の時刻（${now}）で報告しますか？`)) return
  }
  if (photoOn && PHOTO_REQUIRED_TYPES.includes(type)) { openPhotoAttendance(type, shiftId); return }
  if (!skipping.length && (type === 'work_end' || type === 'check_out') && !confirm(`${REPORT_LABELS[type]}を今の時刻（${now}）で報告します。よろしいですか？`)) return
  submitAttendance(type, shiftId, el)
})

// 休憩なし（#324）: 休憩入・休憩出を今の時刻で記録し、休憩0分にする。理由は管理者に伝わる
const NO_BREAK_REASONS = ['忙しく休憩を取れなかった', '休憩のない短いシフトだった', '管理者・現場の指示で休憩なしになった']
delegate('homeNoBreak', (el) => {
  if (!HOME || !HOME.shift) return
  if (homeIsStale()) { toast('日付が変わったため、画面を更新しました'); return }
  if (HOME.tentative && !confirm(TENTATIVE_CONFIRM)) return
  modal(`<h3 class="font-bold text-gray-800 mb-1"><i class="fas fa-mug-hot text-blue-600 mr-1"></i>休憩なしで記録する</h3>
    <p class="text-sm text-gray-600 mb-3">休憩入・休憩出を今の時刻（${esc(dayjs().format('HH:mm'))}）で記録し、休憩は0分になります。理由を選んでください（管理者に伝わります）</p>
    <div class="space-y-2">${NO_BREAK_REASONS.map((x, i) => `<label class="flex items-center gap-2 text-sm"><input type="radio" name="nb-reason" class="w-4 h-4" value="${esc(x)}" ${i === 0 ? 'checked' : ''}>${esc(x)}</label>`).join('')}
      <label class="flex items-center gap-2 text-sm"><input type="radio" name="nb-reason" class="w-4 h-4" value="">その他</label></div>
    <textarea id="nb-note" class="inp mt-2" rows="2" maxlength="150" placeholder="その他の理由・補足（任意）"></textarea>
    <p class="text-[11px] text-gray-500 mt-2">休憩を取ったのに押し忘れた場合は、ここではなく打刻履歴から休憩の時刻を申請してください</p>
    <div id="nb-msg" class="text-sm text-red-600 mt-2" role="alert"></div>
    <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="submitNoBreak" data-shift-id="${Number(el.dataset.shiftId)}">休憩なしで記録する</button></div>`)
})
delegate('submitNoBreak', (el) => withSubmitLock(el, async () => {
  const picked = document.querySelector('input[name="nb-reason"]:checked')
  const note = (document.getElementById('nb-note').value || '').trim()
  const reason = [picked ? picked.value : '', note].filter(Boolean).join('：')
  const msg = document.getElementById('nb-msg')
  if (!reason) { msg.textContent = '理由を選ぶか、入力してください'; return }
  try {
    await axios.post('/api/staff/attendance/no-break', { shift_id: Number(el.dataset.shiftId), reason })
    closeModal(); toast('休憩なし（休憩0分）で記録しました')
  } catch (e) {
    if (!attendanceNeedsReload(e)) { msg.textContent = attendanceErrorMessage(e, 'break_start'); return }
    closeModal(); toast(attendanceErrorMessage(e, 'break_start'), 5000)
  }
  renderHome()
}))

// 押し間違いの取消（#323）。取り消すと、もう一度報告できる。取り消したことは管理者が見られる記録に残る
delegate('homeWithdraw', (el) => {
  const type = el.dataset.type, noBreak = el.dataset.noBreak === '1'
  const label = noBreak ? '休憩なし（休憩入・休憩出）' : REPORT_LABELS[type]
  if (!confirm(`${label}の報告を取り消しますか？\n取り消すと、もう一度報告できます。取り消したことは記録に残ります。`)) return
  withSubmitLock(el, async () => {
    try {
      await axios.post('/api/staff/attendance/withdraw', { shift_id: Number(el.dataset.shiftId), report_type: type, no_break: noBreak })
      toast(`${label}の報告を取り消しました。もう一度報告できます`, 4000)
    } catch (e) { toast(attendanceErrorMessage(e, type), 5000) }
    renderHome()
  })
})

// 位置情報（取れなければ null）。端末が応答しない場合も 10 秒で諦める
function getPositionOrNull() {
  if (!navigator.geolocation) return Promise.resolve(null)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 10000)
    navigator.geolocation.getCurrentPosition(
      pos => { clearTimeout(timer); resolve(pos) },
      () => { clearTimeout(timer); toast('位置情報が取得できませんでした（位置なしで送信します）'); resolve(null) },
      { timeout: 8000 })
  })
}

// 位置情報（取れなければ null）。知らせは出さない（写真の画面の中で、取れたかどうかを表示する。#347）
function getPositionQuiet() {
  if (!navigator.geolocation) return Promise.resolve(null)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 10000)
    navigator.geolocation.getCurrentPosition(pos => { clearTimeout(timer); resolve(pos) }, () => { clearTimeout(timer); resolve(null) }, { timeout: 8000 })
  })
}

// 勤怠報告の失敗の文言。すでに報告済み（前の送信が届いていた・別の端末で報告した・管理者が記録した）なら、エラーではなく報告済みと伝える（#182 #426）
function attendanceErrorMessage(e, type) {
  const msg = e && e.response && e.response.data && e.response.data.error
  if (e && e.response && e.response.status === 409 && msg === 'すでに報告済みです') return REPORT_LABELS[type] + 'は報告済みです（別の端末や管理者が記録した場合もあります）。画面を更新しました'
  if (!e || !e.response) return '通信できませんでした。電波の良い場所で、報告済みになっていないか確かめてから再度お試しください'
  return msg || '送信に失敗しました'
}
// 断られた報告のうち、ホームを読み直すべきもの（報告済み・申請中・不要な報告・順序・受付の時間帯・写真必須への変更など。#426）。
// 写真そのものの問題（未添付・形式・大きさ）と通信の失敗・サーバーの障害は、画面を保ったまま送り直せるようにする
function attendanceNeedsReload(e) {
  const st = e && e.response && e.response.status
  if (!st || st >= 500) return false
  if (st === 409 || st === 404) return true
  const msg = (e.response.data && e.response.data.error) || ''
  return st === 400 && !/写真が添付されていません|画像|送信データ|シフト情報が不正/.test(msg)
}
// 報告の結果の知らせ（#347）。遅延・位置情報なし・予定より早い終了で記録されたら、その旨と連絡の方法を長めに出す。
// noPos: 入店で位置情報を送れなかった（遅延のときは status が late になり no_location が付かないため、画面側で分かる値も使う）
// sent: 『送信しました』の文言（写真なしの報告など。省略で『を送信しました』）
function showAttendanceResult(type, d, noPos, sent) {
  const notes = []
  if (d && d.status === 'late') notes.push(`開始時刻を過ぎていたため「遅延」${Number(d.late_minutes) > 0 ? `（${Number(d.late_minutes)}分）` : ''}として記録しました。遅れた理由は「相談・連絡」から管理者に伝えてください`)
  if ((d && d.status === 'no_location') || (type === 'check_in' && noPos)) notes.push('位置情報が取れなかったため「位置情報なし」として記録しました。端末の設定で、このサイトの位置情報を許可してください')
  if (d && Number(d.early_leave_minutes) > 0) notes.push(`予定の終了より${Number(d.early_leave_minutes)}分早い報告として記録しました`)
  // 入店の位置が現場から離れていた（#277）
  if (d && d.far) notes.push(`現場から約${Number(d.distance_m) >= 1000 ? (Number(d.distance_m) / 1000).toFixed(1) + 'km' : Number(d.distance_m) + 'm'}離れた位置で記録されました。現場に着いていない場合は、着いてから管理者に連絡してください`)
  toast(REPORT_LABELS[type] + (sent || 'を送信しました') + (notes.length ? '。' + notes.join('。') : ''), notes.length ? 7000 : 2500)
}

// 勤怠報告送信（送信中は押せない。位置情報を待つ間も含む）。成功しても失敗しても、ホームを読み直して今の状態を出す（#426）
let ATTENDANCE_SENDING = false
window.submitAttendance = async function (type, shiftId, button) {
  if (homeIsStale()) { toast('日付が変わったため、画面を更新しました'); return }
  if (ATTENDANCE_SENDING) return
  ATTENDANCE_SENDING = true
  // 送信中はボタンに『送信中』を出す（#182）
  const sub = button && button.querySelector('.flex-1 .text-xs')
  if (sub) sub.textContent = '送信中...'
  // 押した時刻と一意キー。通信できずに送れなかったら、押した時刻で端末に保存して、通信が戻ってから送る（#427）
  const pressedAt = Date.now(), reqId = newRequestId()
  let queued = false
  try {
    await withSubmitLock(button, async () => {
      let pos = null
      if (type === 'check_in') { toast('位置情報を取得しています...'); pos = await getPositionOrNull() }
      // 前に保存した報告があれば先に送る（後の報告が先に記録されて、前の報告が順序の確認で断られないように）
      if (outboxQueued().length) await outboxFlush(false, true)
      const body = { shift_id: shiftId, report_type: type, latitude: pos ? pos.coords.latitude : null, longitude: pos ? pos.coords.longitude : null, address: null, client_request_id: reqId }
      try {
        const res = await axios.post('/api/staff/attendance', body, { timeout: ATTENDANCE_TIMEOUT_MS })
        showAttendanceResult(type, res.data, !pos)
      } catch (e) {
        if (e && !e.response && await outboxAdd({ id: reqId, shift_id: shiftId, report_type: type, pressed_at: pressedAt, latitude: body.latitude, longitude: body.longitude, photo: null })) {
          queued = true; outboxQueuedNotice(type, pressedAt); return
        }
        toast(attendanceErrorMessage(e, type), 5000)
      }
    })
  } finally {
    ATTENDANCE_SENDING = false
  }
  if (queued && HOME) { drawHome(HOME, true); return }
  renderHome()
}

// ============ 入店/退店報告（写真添付） ============
window.openPhotoAttendance = function (type, shiftId) {
  if (homeIsStale()) { toast('日付が変わったため、画面を更新しました'); return }
  // takenAt・source: 写真のファイルの日時と選び方（カメラ・アルバム）。報告の日時とずれていれば管理画面で知らせる（#418）
  pendingPhoto = { blob: null, previewUrl: null, type, shiftId, takenAt: null, source: null, pos: null, posState: null, posPromise: null }
  modal(photoModalHtml())
  // 入店は、写真を選んでいる間に位置情報を取っておき、取れたかどうかを画面に出す（取れなければ『もう一度取得する』。#347）
  if (type === 'check_in') photoFetchPosition()
}

// ---------- 写真の画面の位置情報（入店。#347） ----------
// posState: 'loading' 取得中 / 'ok' 取得済み / 'fail' 取れなかった
function photoFetchPosition() {
  const cur = pendingPhoto
  cur.posState = 'loading'; cur.pos = null
  photoPosRefresh()
  cur.posPromise = getPositionQuiet().then(pos => {
    cur.pos = pos; cur.posState = pos ? 'ok' : 'fail'; cur.posPromise = null
    if (pendingPhoto === cur) photoPosRefresh()
    return pos
  })
  return cur.posPromise
}
function photoPosHtml() {
  const st = pendingPhoto.posState
  if (pendingPhoto.type !== 'check_in' || !st) return ''
  if (st === 'loading') return '<p class="text-xs text-gray-500 mt-2"><span class="spin" style="width:12px;height:12px;border-width:2px;vertical-align:-1px"></span> 位置情報を取得しています...</p>'
  if (st === 'ok') return '<p class="text-xs text-emerald-700 mt-2"><i class="fas fa-location-dot mr-1"></i>位置情報を取得しました</p>'
  return `<div class="text-xs text-amber-800 bg-amber-50 rounded-lg px-2.5 py-2 mt-2" role="alert">
      <p><i class="fas fa-location-crosshairs mr-1"></i>位置情報を取得できませんでした。このまま送ると「位置情報なし」として記録されます。端末の設定でこのサイトの位置情報を許可してから、もう一度取得してください</p>
      <button type="button" class="btn btn-outline text-xs mt-2" data-action="photoRetryPosition"><i class="fas fa-rotate-right"></i>もう一度取得する</button></div>`
}
function photoPosRefresh() { const el = document.getElementById('photo-pos'); if (el) el.innerHTML = photoPosHtml() }
delegate('photoRetryPosition', () => { if (pendingPhoto.type === 'check_in' && pendingPhoto.posState !== 'loading') photoFetchPosition() })
// 送るときの位置: 取得済み（2分以内）ならそれ、取得中なら待つ、取れていない・古ければもう一度だけ試す
// （現場に着く前に写真の画面を開いた場合に、離れた位置で記録しないように）
const PHOTO_POS_MAX_AGE_MS = 2 * 60 * 1000
function photoPosition() {
  if (pendingPhoto.type !== 'check_in') return Promise.resolve(null)
  if (pendingPhoto.posState === 'ok' && pendingPhoto.pos && Date.now() - Number(pendingPhoto.pos.timestamp || 0) < PHOTO_POS_MAX_AGE_MS) return Promise.resolve(pendingPhoto.pos)
  if (pendingPhoto.posState === 'loading' && pendingPhoto.posPromise) return pendingPhoto.posPromise
  return photoFetchPosition()
}

function photoModalHtml() {
  const label = REPORT_LABELS[pendingPhoto.type]
  return `
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-bold text-gray-800"><i class="fas ${REPORT_ICONS[pendingPhoto.type]} text-blue-600 mr-1"></i>${label}</h3>
      <button class="text-gray-400" onclick="closeModal()"><i class="fas fa-xmark"></i></button>
    </div>
    <p class="text-sm text-gray-500 mb-3">店舗の様子が分かる写真を1枚添付してください（必須）</p>
    <div id="photo-area">${photoAreaHtml()}</div>
    <div id="photo-pos">${photoPosHtml()}</div>
    <input type="file" id="photo-input-camera" accept="image/*" capture="environment" class="hidden" onchange="onPhotoSelected(this.files[0], 'camera'); this.value = ''">
    <input type="file" id="photo-input-album" accept="image/*" class="hidden" onchange="onPhotoSelected(this.files[0], 'album'); this.value = ''">
    <div id="photo-error" class="text-sm text-red-600 mt-2"></div>
    <div id="photo-retry"></div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button id="photo-submit-btn" class="btn btn-primary flex-1" disabled onclick="submitPhotoAttendance()">
        <i class="fas fa-paper-plane"></i>送信する
      </button>
    </div>
    <div id="photo-skip-area" class="mt-4 pt-3 border-t">
      <button type="button" class="text-sm text-gray-600 underline" data-action="photoSkipOpen">写真を送れない場合</button>
    </div>`
}

function photoAreaHtml() {
  if (pendingPhoto.previewUrl) {
    return `
      <div class="relative">
        <img src="${pendingPhoto.previewUrl}" class="w-full rounded-xl border border-gray-200 max-h-64 object-cover" alt="プレビュー">
        <button class="absolute top-2 right-2 bg-white/90 text-gray-700 rounded-full px-3 h-8 flex items-center gap-1 shadow text-xs font-bold" onclick="removePendingPhoto()">
          <i class="fas fa-rotate-left"></i>撮り直す
        </button>
      </div>`
  }
  return `
    <div class="grid grid-cols-2 gap-2">
      <button type="button" class="btn btn-outline" onclick="document.getElementById('photo-input-camera').click()">
        <i class="fas fa-camera"></i>カメラで撮影
      </button>
      <button type="button" class="btn btn-outline" onclick="document.getElementById('photo-input-album').click()">
        <i class="fas fa-images"></i>アルバムから選択
      </button>
    </div>`
}

// 写真のエラー。撮り直しで直るものは、カメラのボタンをエラーの近くに出す（#536）
function setPhotoError(msg, withCamera) {
  const el = document.getElementById('photo-error')
  if (el) el.textContent = msg || ''
  const r = document.getElementById('photo-retry')
  if (r) r.innerHTML = msg && withCamera ? `<button type="button" class="btn btn-outline w-full mt-2" onclick="document.getElementById('photo-input-camera').click()"><i class="fas fa-camera"></i>カメラで撮り直す</button>` : ''
}
function refreshPhotoModal() {
  const area = document.getElementById('photo-area')
  if (area) area.innerHTML = photoAreaHtml()
  const btn = document.getElementById('photo-submit-btn')
  if (btn) btn.disabled = !pendingPhoto.blob
}

window.removePendingPhoto = function () {
  if (pendingPhoto.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
  pendingPhoto.blob = null
  pendingPhoto.previewUrl = null
  pendingPhoto.takenAt = null
  pendingPhoto.source = null
  setPhotoError('')
  refreshPhotoModal()
}

window.onPhotoSelected = async function (file, source) {
  setPhotoError('')
  if (!file) return
  if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name || '')) {
    setPhotoError('画像ファイルを選択してください', true)
    return
  }
  if (file.size > PHOTO_MAX_UPLOAD_BYTES) {
    setPhotoError('写真のファイルが大きすぎます（50MBまで）。「カメラで撮影」から撮り直してください', true)
    return
  }

  const area = document.getElementById('photo-area')
  if (area) area.innerHTML = '<div class="flex flex-col items-center justify-center py-8 gap-2"><span class="spin"></span><span class="text-xs text-gray-400">画像を処理しています...</span></div>'

  try {
    const blob = await compressImage(file)
    if (pendingPhoto.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
    pendingPhoto.blob = blob
    pendingPhoto.previewUrl = URL.createObjectURL(blob)
    pendingPhoto.takenAt = file.lastModified || null
    pendingPhoto.source = source === 'camera' ? 'camera' : 'album'
    refreshPhotoModal()
  } catch (err) {
    setPhotoError(err && err.message ? err.message : '画像の処理に失敗しました。「カメラで撮影」から撮り直してください', true)
    refreshPhotoModal()
  }
}

// 写真を送れないとき（#535）: 会社が許可していれば理由を選んで写真なしで報告できる。許可していなければ代わりの手段を案内する
delegate('photoSkipOpen', async (el) => {
  const box = document.getElementById('photo-skip-area'); if (!box) return
  const { type, shiftId } = pendingPhoto
  let opt = null
  await withSubmitLock(el, async () => {
    try { opt = (await axios.get('/api/staff/photo-options', { params: { shift_id: shiftId } })).data } catch (e) { opt = null }
  })
  if (!document.getElementById('photo-skip-area') || pendingPhoto.shiftId !== shiftId) return
  // 打刻の追加の申請には、後から撮った写真や店舗の入退館の記録を添付できる（#485）
  const guide = `写真を送れない場合は、<a href="#attendance" class="text-blue-600 underline" onclick="closeModal()">打刻履歴</a>から打刻の追加を申請するか（写真・画像も添付できます）、管理者に連絡してください`
  box.innerHTML = opt && opt.skip_allowed ? `<div class="space-y-2 text-sm">
      <p class="font-bold text-gray-700">写真なしで報告する</p>
      <select id="photo-skip-reason" class="inp text-sm">${Object.entries(opt.reasons || {}).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select>
      <input id="photo-skip-note" class="inp text-sm" maxlength="100" placeholder="補足（「その他」のときは必須）">
      <button type="button" class="btn btn-outline w-full" data-action="photoSkipSubmit"><i class="fas fa-ban"></i>写真なしで${esc(REPORT_LABELS[type])}する</button>
      <p class="text-xs text-gray-400">写真なしで報告したことと理由は、管理者に表示されます。${guide}</p></div>`
    : `<p class="text-xs text-gray-500">${guide}</p>`
})
let PHOTO_SKIP_SENDING = false
delegate('photoSkipSubmit', async (el) => {
  if (PHOTO_SKIP_SENDING) return
  const { type, shiftId } = pendingPhoto
  const reason = (document.getElementById('photo-skip-reason') || {}).value
  const note = ((document.getElementById('photo-skip-note') || {}).value || '').trim()
  if (reason === 'other' && !note) { setPhotoError('「その他」の場合は理由を入力してください'); return }
  PHOTO_SKIP_SENDING = true
  // 押した時刻と一意キー。通信できなければ、写真なしの報告も押した時刻で端末に保存して、通信が戻ってから送る（#427）
  const pressedAt = Date.now(), reqId = newRequestId()
  try {
    await withSubmitLock(el, async () => {
      const pos = await photoPosition()
      if (outboxQueued().length) await outboxFlush(false, true) // 前に保存した報告を先に送る（submitAttendance と同じ）
      const body = { shift_id: shiftId, report_type: type, latitude: pos ? pos.coords.latitude : null, longitude: pos ? pos.coords.longitude : null, address: null, no_photo_reason: reason, no_photo_note: note, client_request_id: reqId }
      try {
        const res = await axios.post('/api/staff/attendance', body, { timeout: ATTENDANCE_TIMEOUT_MS })
        closeModal(); showAttendanceResult(type, res.data, type === 'check_in' && !pos, 'を写真なしで送信しました'); renderHome()
      } catch (e) {
        if (e && !e.response && await outboxAdd({ id: reqId, shift_id: shiftId, report_type: type, pressed_at: pressedAt, latitude: body.latitude, longitude: body.longitude, photo: null, no_photo_reason: reason, no_photo_note: note })) {
          closeModal(); outboxQueuedNotice(type, pressedAt)
          if (HOME) drawHome(HOME, true)
          return
        }
        if (e.response && e.response.status === 409 && e.response.data && e.response.data.error === 'すでに報告済みです') { closeModal(); toast(attendanceErrorMessage(e, type)); renderHome(); return }
        setPhotoError(attendanceErrorMessage(e, type))
      }
    })
  } finally { PHOTO_SKIP_SENDING = false }
})

// EXIF補正・リサイズ・JPEG圧縮（500KB以下 / 長辺1600px以下 / 画質70%基準）
async function compressImage(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new Error('この画像は読み込めませんでした（HEIC など）。「カメラで撮影」から撮り直すか、JPEG・PNG の写真を選んでください')
    }
  }

  let { width, height } = bitmap
  if (Math.max(width, height) > PHOTO_MAX_EDGE) {
    const scale = PHOTO_MAX_EDGE / Math.max(width, height)
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }

  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close && bitmap.close()

  const toBlob = (quality) => new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('画像の変換に失敗しました')), 'image/jpeg', quality)
  })

  let quality = 0.7
  let blob = await toBlob(quality)
  while (blob.size > PHOTO_TARGET_BYTES && quality > 0.35) {
    quality -= 0.1
    blob = await toBlob(quality)
  }
  if (blob.size > PHOTO_TARGET_BYTES) {
    throw new Error('画像を十分に小さくできませんでした。「カメラで撮影」から撮り直してください')
  }
  return blob
}

window.submitPhotoAttendance = async function () {
  if (!pendingPhoto.blob) { setPhotoError('写真を選択してください'); return }
  const { type, shiftId, blob, takenAt, source } = pendingPhoto
  // 押した時刻と一意キー（#427。通信できなければ写真ごと端末に保存して、通信が戻ってから送る）
  const pressedAt = Date.now(), reqId = newRequestId()
  const btn = document.getElementById('photo-submit-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin" style="width:1rem;height:1rem;border-width:2px"></span> 送信中...' }

  const send = async (pos) => {
    if (outboxQueued().length) await outboxFlush(false, true) // 前に保存した報告を先に送る（submitAttendance と同じ）
    const form = new FormData()
    form.append('shift_id', String(shiftId))
    form.append('report_type', type)
    if (pos) { form.append('latitude', String(pos.coords.latitude)); form.append('longitude', String(pos.coords.longitude)) }
    form.append('photo', blob, 'attendance.jpg')
    // 写真のファイルの日時・選び方（#418）
    if (takenAt) form.append('photo_taken_at', String(takenAt))
    if (source) form.append('photo_source', source)
    form.append('client_request_id', reqId)
    try {
      const res = await axios.post('/api/staff/attendance-photo', form, { timeout: ATTENDANCE_PHOTO_TIMEOUT_MS })
      closeModal()
      showAttendanceResult(type, res.data, !pos)
      renderHome()
    } catch (e) {
      if (e && !e.response) {
        let buf = null
        try { buf = await blob.arrayBuffer() } catch (e2) { buf = null }
        if (buf && await outboxAdd({ id: reqId, shift_id: shiftId, report_type: type, pressed_at: pressedAt, latitude: pos ? pos.coords.latitude : null, longitude: pos ? pos.coords.longitude : null,
          photo: { buf, type: blob.type || 'image/jpeg', taken_at: takenAt || null, source: source || null } })) {
          closeModal(); outboxQueuedNotice(type, pressedAt)
          if (HOME) drawHome(HOME, true)
          return
        }
      }
      // すでに報告済み（前の送信が届いていた・管理者が記録した）・設定の変更などで断られたら、閉じて最新の状態を出す（#182 #426）
      if (attendanceNeedsReload(e)) {
        closeModal(); toast(attendanceErrorMessage(e, type), 5000); renderHome(); return
      }
      setPhotoError((e.response && e.response.data && e.response.data.error) || '通信に失敗しました。電波の良い場所で再度お試しください')
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i>送信する' }
    }
  }

  // 入店は写真の画面を開いたときに取った位置を使う（取れていなければもう一度試す。端末が応答しなくても10秒で諦める）
  if (type === 'check_in') {
    photoPosition().then(send)
  } else {
    send(null)
  }
}

// ============ シフト ============
// shifts: 確定・代打・欠勤と、会社が仮で押さえた枠（status='requested'。本人が可否を返事する）
// requests: 以前に本人が出したシフト希望（表示だけ）。シフトの希望は出勤可能日（#availability）に一本化した（#9412）。
//   スタッフアプリの募集・応募の画面も外した（#9411。募集は公開ページから応募する）
// 表示は今日から2週間（月をまたいで続けて出す）で、週ごとに前後へ送る（#428）
let SHIFTS_FROM = null // 表示中の期間の初日（YYYY-MM-DD）
const SHIFT_VIEW_DAYS = 14
const SHIFT_REQ_BADGE = {
  pending: '<span class="badge badge-yellow">希望を提出済み</span>',
  accepted: '<span class="badge badge-green">採用</span>',
  declined: '<span class="badge badge-gray">見送り</span>',
}
const SHIFT_STATUS_BADGE = { requested: '<span class="badge bg-orange-100 text-orange-700">仮押さえ（確定前）</span>', confirmed: '<span class="badge badge-green">確定</span>', absent: '<span class="badge badge-red">欠勤</span>', substitute: '<span class="badge badge-purple">代打</span>' }
const SHIFT_REPLY_LABEL = { ok: '「入れます」と返事済み', ng: '「入れません」と返事済み' }
const shiftViewTo = (from) => dayjs(from).add(SHIFT_VIEW_DAYS - 1, 'day').format('YYYY-MM-DD')

// from: 期間の初日（省略で今日）。'YYYY-MM'（月）を渡したときは、その月の初日（今月なら今日）から
async function renderShifts(from) {
  loading()
  const today = dayjs().format('YYYY-MM-DD')
  if (/^\d{4}-\d{2}$/.test(from || '')) from = from === today.slice(0, 7) ? today : from + '-01'
  from = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : today
  SHIFTS_FROM = from
  const to = shiftViewTo(from)
  let data
  try { data = (await axios.get('/api/staff/shifts', { params: { from, to } })).data } catch (e) { showLoadError(e); return }
  // 読み込み中にほかの期間・ほかの画面へ移った
  if (SHIFTS_FROM !== from || (location.hash || '#home').slice(1).split('/')[0] !== 'shift') return
  const day = (n) => dayjs(from).add(n, 'day').format('YYYY-MM-DD')
  $app.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-1">
      <button class="btn btn-outline" data-action="shiftWeek" data-from="${esc(day(-7))}" aria-label="前の週"><i class="fas fa-chevron-left"></i></button>
      <h2 class="font-bold text-gray-800 text-center">${esc(fmtDate(from))}〜${esc(fmtDate(to))}</h2>
      <button class="btn btn-outline" data-action="shiftWeek" data-from="${esc(day(7))}" aria-label="次の週"><i class="fas fa-chevron-right"></i></button>
    </div>
    <div class="flex items-center justify-center gap-3 mb-3 text-xs">
      ${from !== today ? `<button class="text-blue-600 underline" data-action="shiftWeek" data-from="${esc(today)}">今日から表示</button>` : '<span class="text-gray-400">今日から2週間の予定</span>'}
      <label class="flex items-center gap-1 text-gray-500">開始日<input type="date" id="shift-from" class="inp py-1 text-xs w-36" value="${esc(from)}"></label>
    </div>
    <div id="av-banner"></div>
    <a href="#availability" class="btn btn-primary w-full" id="shift-availability-btn"><i class="fas fa-calendar-check"></i>出勤可能日を提出する</a>
    <p class="text-[11px] text-gray-500 text-center mt-1 mb-2">シフトの希望は、出勤可能日（○△×）で出してください。管理者がそれを見てシフトを組みます</p>
    <a href="#calendar" class="btn btn-outline w-full text-xs mb-4"><i class="fas fa-calendar-plus"></i>カレンダーに追加</a>
    <div class="space-y-2" id="shift-list">${shiftListHtml(data, today)}</div>`
  const picker = document.getElementById('shift-from')
  if (picker) picker.addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(picker.value)) renderShifts(picker.value) })
  availabilityBanner()
}
delegate('shiftWeek', (el) => renderShifts(el.dataset.from))

// 日付ごとのカード（確定・仮押さえのシフトと、以前に出したシフト希望）
function shiftListHtml(data, today) {
  const byDate = {}
  const day = (d) => (byDate[d] = byDate[d] || { shifts: [], requests: [] })
  for (const s of data.shifts || []) day(s.work_date).shifts.push(s)
  // 以前に出したシフト希望（提出・取り下げの入口は外した。#9412）。返事待ちと採用だけを出す
  for (const r of data.requests || []) if (r.status === 'pending' || r.status === 'accepted') day(r.work_date).requests.push(r)
  // 会社の仮押さえへの返事（入れます／入れません）。過ぎた日は返事できない
  const replyBox = (s) => {
    if (s.status !== 'requested') return ''
    const canReply = s.work_date >= today
    return `<div class="mt-1 rounded-lg bg-orange-50 px-2.5 py-2 text-xs text-gray-600">
      <p>会社が仮で押さえた枠です。まだ確定していません。${canReply ? '入れるかどうか返事をしてください' : ''}</p>
      ${s.staff_reply ? `<p class="mt-1 font-bold ${s.staff_reply === 'ok' ? 'text-emerald-700' : 'text-red-600'}">${SHIFT_REPLY_LABEL[s.staff_reply] || ''}${s.staff_reply_note ? '：' + esc(s.staff_reply_note) : ''}</p>` : ''}
      ${canReply ? `<div class="flex gap-2 mt-2">
        <button class="btn ${s.staff_reply === 'ok' ? 'btn-primary' : 'btn-outline'} flex-1 text-xs" data-action="replyShift" data-id="${Number(s.shift_id)}" data-answer="ok">入れます</button>
        <button class="btn ${s.staff_reply === 'ng' ? 'btn-danger' : 'btn-outline'} flex-1 text-xs" data-action="replyShift" data-id="${Number(s.shift_id)}" data-answer="ng">入れません</button>
      </div>` : ''}
    </div>`
  }
  // 今日までのシフトは、その日の打刻履歴（打刻の確認・修正の申請）へ進める（#376）
  const attLink = (s) => s.status === 'requested' || s.work_date > today ? ''
    : `<a href="#attendance/timeline/${esc(s.work_date)}/${Number(s.shift_id)}" class="inline-block text-xs text-blue-600 mt-1"><i class="fas fa-user-clock mr-0.5"></i>打刻の確認・修正<i class="fas fa-chevron-right text-[10px] ml-0.5"></i></a>`
  const requestRow = (r) => `
    <div class="mt-2 pt-2 border-t border-dashed border-gray-200 text-sm shift-request-row" data-request-id="${Number(r.request_id)}">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium text-gray-700"><i class="fas fa-hand text-amber-500 mr-1"></i>以前に出したシフト希望・${r.project_name ? esc(r.project_name) : '案件の指定なし'}</p>
          <p class="text-xs text-gray-400">${esc(formatShiftTime(r.start_time, r.end_time))}${r.memo ? ' ' + esc(r.memo) : ''}</p>
        </div>
        <div class="text-right shrink-0">${SHIFT_REQ_BADGE[r.status] || ''}</div>
      </div>
      ${r.status === 'pending' ? '<p class="text-[11px] text-gray-400 mt-0.5">管理者の返事を待っています。取り下げるときは、相談・連絡からお知らせください</p>' : ''}
      ${r.status === 'accepted' ? '<p class="text-[11px] text-gray-500 mt-0.5">シフトが登録されると、この日に「確定」のシフトとして表示されます</p>' : ''}
      ${r.status !== 'pending' && r.response_note ? `<p class="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1 mt-1">管理者より：${esc(r.response_note)}</p>` : ''}
    </div>`
  // どの会社のシフトか（2社以上に所属している人だけ。他社のシフトは目立たせる。#503）
  const companyTag = (s) => !data.multi_company ? ''
    : s.other_company ? ` <span class="badge badge-purple">${esc(s.company_name)}のシフト</span>` : ` <span class="text-[11px] text-gray-400">${esc(s.company_name)}</span>`
  return Object.keys(byDate).sort().map(d => `
    <div class="card p-3.5 ${d === today ? 'ring-2 ring-blue-400' : ''}" data-date="${esc(d)}">
      <div class="flex items-center justify-between">
        <span class="font-bold ${d === today ? 'text-blue-700' : d < today ? 'text-gray-500' : 'text-gray-800'}">${esc(fmtDate(d))} ${d === today ? '<span class="badge badge-blue">今日</span>' : d < today ? '<span class="badge badge-gray">過去</span>' : ''}</span>
      </div>
      ${byDate[d].shifts.map(s => `
        <div class="mt-1.5 flex items-start justify-between gap-2 text-sm shift-row" data-shift-id="${Number(s.shift_id)}">
          <div class="min-w-0">
            <p class="font-medium text-gray-700">${esc(s.project_name)}${companyTag(s)}${shiftChangedBadge(s, today)}</p>
            <p class="text-xs text-gray-400">${esc(formatShiftTime(s.start_time, s.end_time))}</p>
            ${shiftPlaceHtml(s, true)}
            ${attLink(s)}
            ${shiftTeamLinkHtml(s, today)}
          </div>
          <span class="shrink-0">${SHIFT_STATUS_BADGE[s.status] || ''}</span>
        </div>${replyBox(s)}`).join('')}
      ${byDate[d].requests.map(requestRow).join('')}
    </div>`).join('') || '<p class="text-center text-gray-400 py-10">この期間のシフトはありません</p>'
}

// 直近に内容が変わったシフトの印（#155）。staff_changed_at はトリガーで、本人の申請の承認（終了時刻の変更など）も含めて記録されるため、文言は「管理者が変えた」とせず「変わった」にする。
// サーバーが返す changed_at・staff_changed_at（時刻・場所・状態などが変わった日時。日本時間）か、
// 作った日時（created_at）より後の updated_at が、SHIFT_CHANGED_DAYS 日以内なら『変更あり』を出す。今日より前のシフトには出さない
const SHIFT_CHANGED_DAYS = 3
function shiftChangedBadge(s, today) {
  if (s.work_date < today) return ''
  const at = s.changed_at || s.staff_changed_at || (s.updated_at && s.created_at && String(s.updated_at) > String(s.created_at) ? s.updated_at : null)
  if (!at) return ''
  const t = dayjs(String(at).replace(' ', 'T'))
  if (!t.isValid() || dayjs().diff(t, 'day', true) > SHIFT_CHANGED_DAYS) return ''
  return ` <span class="badge badge-yellow" title="このシフトの日時・場所・状態などが変わりました。内容を確かめてください"><i class="fas fa-pen mr-0.5"></i>変更あり ${esc(t.format('M/D HH:mm'))}</span>`
}

// 一緒に入る人（#523。会社の設定で出すときだけ）と、この現場の申し送り（#522）。確定・代打のシフトで、1週間前より後のものに出す。
// どちらも無いときは、どこから出る情報か（同じ日・同じ案件のシフト／前のシフトの日報の共有事項）を案内する（#9413）
function shiftTeamLinkHtml(s, today) {
  if (!['confirmed', 'substitute'].includes(s.status) || s.work_date < dayjs(today).subtract(7, 'day').format('YYYY-MM-DD')) return ''
  return `<button type="button" class="block text-xs text-blue-600 mt-1" data-action="openShiftTeam" data-id="${Number(s.shift_id)}"><i class="fas fa-users mr-0.5"></i>一緒に入る人・申し送り<i class="fas fa-chevron-right text-[10px] ml-0.5"></i></button>`
}
delegate('openShiftTeam', async (el) => {
  const id = Number(el.dataset.id)
  let team, ho
  try {
    [team, ho] = await Promise.all([axios.get(`/api/staff/shifts/${id}/coworkers`), axios.get('/api/staff/handover/' + id)]).then(r => r.map(x => x.data))
  } catch (e) { showApiError(e, '読み込めませんでした'); return }
  const people = team.coworkers || []
  const notes = ho.notes || []
  // 申し送りに使う日報の項目の名前（無ければ『共有事項』と案内する）
  const fieldNames = (ho.fields || []).map(f => `『${f.label}』`).join('・') || '『共有事項』'
  const emptyNote = (text) => `<p class="text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-2">${esc(text)}</p>`
  modal(`
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-bold text-gray-800">一緒に入る人・申し送り</h3>
      <button class="text-gray-400" data-action="closeShiftTeam" aria-label="閉じる"><i class="fas fa-xmark"></i></button>
    </div>
    <h4 class="text-sm font-bold text-gray-700 mt-2 mb-1"><i class="fas fa-users text-blue-500 mr-1"></i>同じ日・同じ案件に入る人</h4>
    ${!team.enabled ? emptyNote('一緒に入る人は、所属の会社の設定で表示しないことになっています')
      : people.length ? `<ul class="text-sm text-gray-700 space-y-1" id="shift-team-people">${people.map(p => `<li>${esc(p.name)}さん <span class="text-xs text-gray-400">${esc(formatShiftTime(p.start_time, p.end_time))}</span>${p.same_slot ? ' <span class="badge badge-blue">同じ枠</span>' : ''}</li>`).join('')}</ul>`
      : emptyNote('同じ日・同じ案件にほかの人のシフトがないため表示がありません')}
    <h4 class="text-sm font-bold text-gray-700 mt-4 mb-1"><i class="fas fa-clipboard-list text-blue-500 mr-1"></i>この現場の申し送り${notes.length ? `（直近${Number(ho.days)}日）` : ''}</h4>
    ${notes.length ? `<p class="text-[11px] text-gray-400 mb-1">同じ案件の前のシフトで、ほかの人が日報の${esc(fieldNames)}に書いた内容です</p>${handoverNotesHtml(ho)}`
      : ho.reason === 'no_share_field' ? emptyNote('この案件の日報には共有事項の項目がないため表示がありません（日報の項目に共有事項があると、前のシフトの人が書いた内容がここに出ます）')
      : emptyNote(`前のシフトの日報に共有事項が書かれていないため表示がありません（日報の${fieldNames}に書くとここに出ます。直近${Number(ho.days) || 14}日分）`)}
    <button class="btn btn-outline w-full mt-4" data-action="closeShiftTeam">閉じる</button>`)
})
delegate('closeShiftTeam', () => closeModal())

// 会社の仮押さえへの返事
delegate('replyShift', async (el) => {
  const answer = el.dataset.answer
  let note = ''
  if (answer === 'ng') {
    note = prompt('入れない理由など、ひとことあれば入力してください（任意）', '')
    if (note === null) return
  }
  await withSubmitLock(el, async () => {
    try { await axios.post(`/api/staff/shifts/${Number(el.dataset.id)}/reply`, { answer, note }) }
    catch (e) { showApiError(e, '返事を送れませんでした'); return }
    toast(answer === 'ok' ? '「入れます」と返事しました' : '「入れません」と返事しました')
    renderShifts(SHIFTS_FROM)
  })
})

// ============ 日報入力 ============
// 対象のシフトは #report/<shift_id> で指定する。指定がなければ、報告が済んで日報が未提出のシフト → ホームのシフト →
// 前日以前の未提出の日報（直近7日。/api/staff/pending-daily-reports）の順に選ぶ（#185）
const REPORT_TEXT_MAX = 2000 // src/lib/validate.ts の REPORT_TEXT_MAX と同じ
const reportFieldRequired = (f) => !!f && (f.required === true || f.required === 1 || f.required === 'true')
const reportShiftLabel = (x) => `${fmtDate(x.work_date)} ${formatShiftTime(x.start_time, x.end_time)} ${x.project_name || ''}${x.other_company && x.company_name ? '（' + x.company_name + '）' : ''}`

function reportLoadError(e) {
  if (typeof showLoadError === 'function') return showLoadError(e)
  if (e && e.response && e.response.status === 401) return
  $app.innerHTML = `<div class="card p-6 text-center text-sm text-gray-500 mt-4">
    <p>${esc(showApiError(e, '日報の画面を読み込めませんでした'))}</p>
    <button class="btn btn-outline mt-3" data-action="reportReload"><i class="fas fa-rotate-right"></i>再読み込み</button></div>`
}
delegate('reportReload', () => renderReport())

async function renderReport() {
  loading()
  const wanted = Number((location.hash || '').slice(1).split('/')[1]) || 0
  let home, pendingAll
  try {
    // 開いたまま日付が変わっても前日の内容で送らないよう、毎回読み直す
    const [h, p] = await Promise.all([axios.get('/api/staff/home'), axios.get('/api/staff/pending-daily-reports')])
    home = h.data; pendingAll = p.data.shifts || []
  } catch (e) { reportLoadError(e); return }
  HOME = home
  HOME_LOADED_DAY = dayjs().format('YYYY-MM-DD')
  const list = home.today_shifts || []
  // 前日からの日をまたぐシフトは本日の一覧にもあるので、未提出の一覧からは外す
  const pending = pendingAll.filter(x => !list.some(t => t.shift_id === x.shift_id))
  const s = list.find(x => x.shift_id === wanted) || pending.find(x => x.shift_id === wanted) || (wanted ? { shift_id: wanted } : null)
    || list.find(x => x.attendance_done && x.daily_report_required && !x.daily_report_done)
    || list.find(x => home.shift && x.shift_id === home.shift.shift_id) || list[0] || pending[0] || null
  if (!s) {
    $app.innerHTML = `<div class="card p-6 text-center text-gray-500 mt-4">
      <i class="fas fa-circle-info text-2xl text-gray-300 mb-2 block"></i>
      本日の稼働予定と、未提出の日報はありません。</div>
      <h3 class="font-bold text-gray-700 mt-6 mb-2 px-1">過去の日報</h3><div id="past-reports"></div>`
    loadPastReports()
    return
  }
  // 提出済みなら前回の内容を初期値にする（修正して再提出しても、ほかの項目が0や空欄で上書きされないように）
  let data
  try { data = (await axios.get('/api/staff/daily-report/' + Number(s.shift_id))).data } catch (e) {
    // 指定したシフトが見つからない（担当の変更など）ときは、既定のシフトで開き直す
    if (wanted && e.response && e.response.status === 404) { toast('指定したシフトが見つかりません'); location.hash = 'report'; return }
    reportLoadError(e); return
  }
  const sh = Object.assign({}, s, data.shift || {})
  const prev = data.report
  const pv = (k) => (prev && prev.values && prev.values[k] != null ? prev.values[k] : '')
  const tplFields = (data.template && data.template.fields) || []
  // テンプレートの無い案件は「報告内容」の欄だけ（報告用URLの画面・サーバーの検証と同じ）
  const fields = tplFields.length ? tplFields : [{ key: 'free', label: '報告内容', type: 'textarea' }]
  const numFields = fields.filter(f => f.type === 'number')
  const textFields = fields.filter(f => f.type !== 'number')
  const isPast = sh.work_date < home.today
  const otherPending = pending.filter(x => x.shift_id !== sh.shift_id)
  const reqMark = (f) => reportFieldRequired(f) ? '<span class="text-red-500 ml-0.5">*</span>' : ''
  // 選べるシフト: 本日のシフト・前日以前の未提出・開いているシフト（過去の日報から開いた場合）
  const extra = !list.some(x => x.shift_id === sh.shift_id) && !pending.some(x => x.shift_id === sh.shift_id) ? [sh] : []
  const opt = (x, note) => `<option value="${Number(x.shift_id)}" ${x.shift_id === sh.shift_id ? 'selected' : ''}>${esc(reportShiftLabel(x))}${note}</option>`
  const optCount = list.length + pending.length + extra.length
  // インシデント・クレームの内容（印を付けたら必須。#232）
  const flagBox = (kind, label, checked) => `
    <label class="flex items-center gap-3 py-1"><input id="${kind}-flag" type="checkbox" class="w-5 h-5 rounded rpt-flag" data-kind="${kind}" ${checked ? 'checked' : ''}><span class="text-sm font-medium text-gray-700">${label}があった</span></label>
    <div id="${kind}-note-box" class="${checked ? '' : 'hidden'} mb-2">
      <label class="text-xs text-gray-500 block mb-1" for="${kind}-note">${label}の内容<span class="text-red-500 ml-0.5">*</span></label>
      <textarea id="${kind}-note" rows="3" maxlength="${REPORT_TEXT_MAX}" class="inp rpt-autogrow" placeholder="何が・いつ・どう対応したか（例: 14時ごろ、料金の説明についてお客様から苦情。店長に報告し、説明し直して納得いただいた）">${esc(pv(kind + '_note'))}</textarea>
    </div>`

  $app.innerHTML = `
    ${otherPending.length ? `<section class="card p-3 mb-3 bg-amber-50 text-amber-800 text-sm">
      <p class="font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>前日以前の未提出の日報が${otherPending.length}件あります</p>
      <div class="flex flex-wrap gap-1.5 mt-2">${otherPending.slice(0, 5).map(x => `<a href="#report/${Number(x.shift_id)}" class="badge badge-yellow">${esc(fmtDate(x.work_date))} ${esc(x.project_name)}</a>`).join('')}${otherPending.length > 5 ? `<span class="text-xs">ほか${otherPending.length - 5}件</span>` : ''}</div>
    </section>` : ''}
    <section class="card p-4 mb-4">
      <h2 class="font-bold text-gray-800">${esc(sh.project_name)}${sh.other_company && sh.company_name ? ` <span class="badge badge-purple">${esc(sh.company_name)}</span>` : ''}</h2>
      <p class="text-xs text-gray-400">${fmtDate(sh.work_date)} ${esc(formatShiftTime(sh.start_time, sh.end_time))} の日報 ${data.template ? '｜' + esc(data.template.template_name) : ''}</p>
      ${optCount > 1 ? `<select id="report-shift" class="inp text-sm mt-2" aria-label="日報を入力するシフト">
        ${list.length ? `<optgroup label="本日">${list.map(x => opt(x, x.daily_report_done ? '（提出済み）' : x.daily_report_required ? '' : '（日報不要）')).join('')}</optgroup>` : ''}
        ${pending.length ? `<optgroup label="前日以前の未提出">${pending.map(x => opt(x, '（未提出）')).join('')}</optgroup>` : ''}
        ${extra.length ? `<optgroup label="表示中">${extra.map(x => opt(x, prev ? '（提出済み）' : '')).join('')}</optgroup>` : ''}
      </select>` : ''}
      ${isPast && !prev ? `<p class="text-xs text-amber-800 bg-amber-50 rounded p-2 mt-2"><i class="fas fa-clock-rotate-left mr-1"></i>${esc(fmtDate(sh.work_date))}の日報が未提出です。思い出せる範囲で入力してください</p>` : ''}
      ${sh.daily_report_required === false ? '<p class="text-xs text-gray-500 bg-gray-50 rounded p-2 mt-2"><i class="fas fa-circle-info mr-1"></i>このシフトは日報の提出は不要です（任意で提出できます）</p>' : ''}
      ${sh.blocked ? `<p class="text-xs text-red-700 bg-red-50 rounded p-2 mt-2"><i class="fas fa-ban mr-1"></i>${esc(sh.blocked)}</p>` : ''}
      ${!tplFields.length ? '<p class="text-xs text-gray-600 bg-gray-50 rounded p-2 mt-2" id="report-no-template"><i class="fas fa-circle-info mr-1"></i>この案件には日報の項目（件数など）が設定されていません。下の「報告内容」に、その日の実績・報告をまとめて書いてください。項目があるはずの場合は、管理者に連絡してください</p>' : ''}
      ${prev ? `<p class="text-xs text-emerald-700 bg-emerald-50 rounded p-2 mt-2"><i class="fas fa-check mr-1"></i>提出済み（${esc(dayjs(prev.submitted_at).format('M/D HH:mm'))}）。内容を直して再提出できます${prev.manager_checked ? '<br>管理者が確認済みです。再提出すると、もう一度確認してもらうことになります' : ''}</p>` : ''}
      ${prev && prev.manager_comment ? `<p class="text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-2 whitespace-pre-wrap break-words"><i class="fas fa-comment-dots mr-1"></i>${linkify(esc(prev.manager_comment))}</p>` : ''}
    </section>
    <div id="report-handover"></div>
    <form id="report-form" class="space-y-4 pb-8" novalidate>
      ${numFields.length ? `<section class="card p-4">
        <div class="flex items-center justify-between mb-3 gap-2">
          <h3 class="font-bold text-gray-700 text-sm"><i class="fas fa-hashtag text-blue-500 mr-1"></i>実績件数</h3>
          <button type="button" class="btn btn-outline text-xs" data-action="reportFillZero">空欄を0にする</button>
        </div>
        <p class="text-xs text-gray-400 mb-2">0件の項目も「0」を入力してください。稼働中も −／＋ で数えられます（数えた件数はこの端末に残り、提出するまで消えません）</p>
        <div class="grid grid-cols-2 gap-3">
          ${numFields.map(f => `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}${reqMark(f)}</label>
              <div class="flex items-stretch gap-1">
                <button type="button" class="btn btn-outline px-0 w-10 shrink-0 text-lg" data-action="reportCount" data-step="-1" aria-label="${esc(f.label)}を1減らす">−</button>
                <input type="number" inputmode="numeric" min="0" max="99999" step="1" data-key="${esc(f.key)}" data-label="${esc(f.label)}" class="inp rpt-field rpt-num text-center text-lg font-bold min-w-0 px-1" value="${esc(pv(f.key))}" placeholder="未入力">
                <button type="button" class="btn btn-outline px-0 w-10 shrink-0 text-lg" data-action="reportCount" data-step="1" aria-label="${esc(f.label)}を1増やす">＋</button>
              </div>
            </div>`).join('')}
        </div>
      </section>` : ''}
      ${textFields.length ? `<section class="card p-4">
        <h3 class="font-bold text-gray-700 mb-3 text-sm"><i class="fas fa-message text-blue-500 mr-1"></i>報告事項</h3>
        <div class="space-y-3">
          ${textFields.map(f => {
            // テキストの項目は、スマホで書いた内容を見返せるよう、すべて複数行の欄にする（#525）
            // 文字数の上限はサーバー（reportFieldRulesError）と同じく 1〜REPORT_TEXT_MAX の整数だけを使う
            const ml = Number(f.maxLength ?? f.max_length)
            const max = Number.isInteger(ml) && ml >= 1 && ml <= REPORT_TEXT_MAX ? ml : REPORT_TEXT_MAX
            const v = String(pv(f.key))
            return `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}${reqMark(f)}</label>
              <textarea data-key="${esc(f.key)}" data-label="${esc(f.label)}" data-required="${reportFieldRequired(f) ? '1' : ''}" rows="${f.type === 'textarea' ? 3 : 2}" maxlength="${max}" class="inp rpt-field rpt-autogrow" placeholder="${esc(f.placeholder || f.label + 'を入力')}">${esc(v)}</textarea>
              <p class="text-[11px] text-gray-400 text-right mt-0.5" data-counter data-max="${max}">残り ${max - v.length} 文字</p>
            </div>`
          }).join('')}
        </div>
      </section>` : ''}
      <section class="card p-4">
        ${flagBox('incident', 'インシデント', prev && prev.incident_flag)}
        ${flagBox('complaint', 'クレーム', prev && prev.complaint_flag)}
      </section>
      <button type="submit" id="report-submit" class="btn btn-primary w-full py-3.5 text-base" ${sh.blocked ? 'disabled' : ''}>${prev ? '日報を修正して再提出' : '日報を提出する'}</button>
    </form>`

  const sel = document.getElementById('report-shift')
  if (sel) sel.addEventListener('change', () => { location.hash = 'report/' + Number(sel.value) })
  loadReportHandover(sh.shift_id)
  const form = document.getElementById('report-form')
  // 複数行の欄は入力に合わせて高さを伸ばし、残りの文字数を出す
  // 非表示の欄（インシデントの内容など）は高さを測れないので、表示したときに測る
  const grow = (el) => { if (!el.offsetParent) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 480) + 'px' }
  form.querySelectorAll('.rpt-autogrow').forEach(el => {
    if (el.value) grow(el)
    el.addEventListener('input', () => {
      grow(el)
      const c = el.nextElementSibling
      if (c && c.hasAttribute('data-counter')) c.textContent = `残り ${Number(c.dataset.max) - el.value.length} 文字`
    })
  })
  form.querySelectorAll('.rpt-flag').forEach(el => el.addEventListener('change', () => {
    const box = document.getElementById(el.dataset.kind + '-note-box')
    box.classList.toggle('hidden', !el.checked)
    if (el.checked) { const note = document.getElementById(el.dataset.kind + '-note'); grow(note); note.focus() }
  }))
  // 下書き（#421）: 送っていない入力があれば戻し、入力のたびに保存する
  const draftName = 'report:' + Number(sh.shift_id)
  const draft = draftLoad(draftName)
  if (draft) {
    form.querySelectorAll('.rpt-field').forEach(el => { if (draft.values && draft.values[el.dataset.key] != null) el.value = draft.values[el.dataset.key] })
    for (const kind of ['incident', 'complaint']) {
      const flag = document.getElementById(kind + '-flag'), note = document.getElementById(kind + '-note')
      if (draft[kind] != null) { flag.checked = !!draft[kind]; document.getElementById(kind + '-note-box').classList.toggle('hidden', !flag.checked) }
      if (draft[kind + '_note'] != null) note.value = draft[kind + '_note']
    }
    form.querySelectorAll('.rpt-autogrow').forEach(el => el.dispatchEvent(new Event('input')))
    toast('入力途中の内容を戻しました（まだ提出していません）')
  }
  const saveReportDraft = () => {
    const values = {}
    form.querySelectorAll('.rpt-field').forEach(el => { values[el.dataset.key] = el.value })
    draftSave(draftName, { values,
      incident: document.getElementById('incident-flag').checked, complaint: document.getElementById('complaint-flag').checked,
      incident_note: document.getElementById('incident-note').value, complaint_note: document.getElementById('complaint-note').value })
  }
  form.addEventListener('input', saveReportDraft)
  form.addEventListener('change', saveReportDraft)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    // 入力の確認（空のまま提出して「提出済み」にならないように。#349）。サーバーでもテンプレートの必須を確かめる
    const stop = (el, msg) => { toast(msg); if (el) el.focus(); return true }
    const blankNum = [...form.querySelectorAll('.rpt-num')].find(el => el.value.trim() === '')
    if (blankNum && stop(blankNum, `「${blankNum.dataset.label}」が未入力です。0件の場合は0を入力してください`)) return
    const blankText = [...form.querySelectorAll('textarea.rpt-field')].find(el => el.dataset.required && !el.value.trim())
    if (blankText && stop(blankText, `「${blankText.dataset.label}」を入力してください`)) return
    for (const [kind, label] of [['incident', 'インシデント'], ['complaint', 'クレーム']]) {
      const note = document.getElementById(kind + '-note')
      if (document.getElementById(kind + '-flag').checked && !note.value.trim() && stop(note, `${label}の内容（何が・いつ・どう対応したか）を入力してください`)) return
    }
    const values = {}
    form.querySelectorAll('.rpt-field').forEach(el => {
      const k = el.dataset.key
      values[k] = el.type === 'number' ? Number(el.value) : el.value
    })
    // 送信中はボタンを押せないようにする（二度押しで同じ日報を送らない）
    withSubmitLock(document.getElementById('report-submit'), async () => {
      try {
        // 案件・稼働日はシフトの値（サーバーでもシフトと一致するかを確かめる）。
        // インシデント・クレームは前回の値を表示したうえで送るので flags_explicit を付ける（外したときだけ印を下げる）
        await axios.post('/api/staff/daily-report', {
          project_id: sh.project_id, shift_id: sh.shift_id, work_date: sh.work_date, values,
          incident_flag: document.getElementById('incident-flag').checked,
          complaint_flag: document.getElementById('complaint-flag').checked,
          incident_note: document.getElementById('incident-note').value,
          complaint_note: document.getElementById('complaint-note').value,
          flags_explicit: true
        })
      } catch (err) {
        // 通信できなかったときは電波の案内を出す。入力した内容はそのまま残す（#194）
        showApiError(err, err && err.response ? '日報の送信に失敗しました' : '通信に失敗しました。電波の良い場所で再度お試しください（入力した内容は残っています）')
        return
      }
      draftClear(draftName)
      toast('日報を提出しました。お疲れさまでした！')
      HOME = null
      // 前日以前の未提出が残っていれば、続けて次の日報を開く
      const next = otherPending[0]
      location.hash = next ? 'report/' + Number(next.shift_id) : 'home'
    })
  })
}
// 実績件数の空欄を0で埋める（0件をまとめて入力する）
delegate('reportFillZero', () => {
  document.querySelectorAll('#report-form .rpt-num').forEach(el => { if (el.value.trim() === '') el.value = '0' })
  const form = document.getElementById('report-form'); if (form) form.dispatchEvent(new Event('input'))
})
// 稼働中のカウント（#279）。−／＋ で1件ずつ増減し、入力のイベントで下書き（端末）に保存する
delegate('reportCount', (el) => {
  const inp = el.parentElement && el.parentElement.querySelector('.rpt-num')
  if (!inp) return
  const v = Math.min(99999, Math.max(0, (Math.floor(Number(inp.value)) || 0) + Number(el.dataset.step || 0)))
  inp.value = String(v)
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})

// 店舗の申し送り（#522）。同じ案件のほかのスタッフの直近の日報から、共有の項目（店舗共有事項・好事例など）を出す
function handoverNotesHtml(d) {
  const labelOf = Object.fromEntries((d.fields || []).map(f => [f.key, f.label]))
  return (d.notes || []).map(n => `
    <div class="border-t first:border-t-0 border-gray-100 pt-2 first:pt-0 mt-2 first:mt-0">
      <p class="text-[11px] text-gray-400">${esc(fmtDate(n.work_date))}${n.name ? ` ${esc(n.name)}さん` : ''}</p>
      ${Object.entries(n.values).map(([k, v]) => `<p class="text-xs mt-0.5"><span class="font-bold text-gray-600">${esc(labelOf[k] || k)}：</span><span class="text-gray-800 whitespace-pre-wrap break-words">${linkify(esc(v))}</span></p>`).join('')}
    </div>`).join('')
}
async function loadReportHandover(shiftId) {
  const box = document.getElementById('report-handover')
  if (!box) return
  let d
  try { d = (await axios.get('/api/staff/handover/' + Number(shiftId))).data } catch (e) { return }
  // 読み込み中にほかのシフトの日報へ移った
  if (document.getElementById('report-handover') !== box || !(d.notes || []).length) return
  box.innerHTML = `<details class="card p-4 mb-4">
    <summary class="font-bold text-gray-700 text-sm cursor-pointer"><i class="fas fa-clipboard-list text-blue-500 mr-1"></i>この現場の申し送り（直近${Number(d.days)}日・${d.notes.length}件）</summary>
    <div class="mt-2">${handoverNotesHtml(d)}</div>
  </details>`
}

// 過去の日報（#319 #371）。同一人物の全所属の分。タップすると、提出した内容・確認済みかどうか・コメントを開く
let PAST_REPORTS = null
async function loadPastReports() {
  const el = document.getElementById('past-reports')
  if (!el) return
  el.innerHTML = '<div class="flex justify-center py-6"><span class="spin"></span></div>'
  try { PAST_REPORTS = (await axios.get('/api/staff/my-reports')).data } catch (e) {
    el.innerHTML = '<p class="text-sm text-gray-500">過去の日報を読み込めませんでした <button class="text-blue-600 underline ml-1" data-action="reloadPastReports">再読み込み</button></p>'
    return
  }
  el.innerHTML = PAST_REPORTS.reports.map((r, i) => `
    <button type="button" class="card p-3.5 mb-2 w-full text-left block" data-action="openPastReport" data-index="${i}">
      <span class="flex justify-between items-center gap-2">
        <span class="font-bold text-sm text-gray-800">${esc(fmtDate(r.work_date))}${r.start_time ? ` <span class="text-xs font-normal text-gray-400">${esc(formatShiftTime(r.start_time, r.end_time))}</span>` : ''}</span>
        ${pastReportCheckBadge(r)}
      </span>
      <span class="block text-xs text-gray-500 mt-0.5">${esc(r.project_name)}${r.other_company ? ` <span class="badge badge-purple">${esc(r.company_name)}</span>` : ''}
        ${r.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}${r.complaint_flag ? '<span class="badge badge-red">クレーム</span>' : ''}</span>
      ${r.manager_comment ? `<span class="block text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-1.5 whitespace-pre-wrap"><i class="fas fa-comment-dots mr-1"></i>${esc(r.manager_comment)}</span>` : ''}
    </button>`).join('') || '<p class="text-sm text-gray-400">日報履歴はありません</p>'
  // 日報のコメントの通知から来たときは、その日報を開く（#158）
  const openId = OPEN_PAST_REPORT_ID; OPEN_PAST_REPORT_ID = null
  if (openId) openPastReportById(el, openId)
}
// 一覧（新しい30件）にない古い日報は、その1件を取り直して一覧の後ろに足してから開く。
// サーバーが daily_report_id の指定に応えない・見つからないときは、そのことを知らせる
async function openPastReportById(el, id) {
  let idx = PAST_REPORTS.reports.findIndex(r => Number(r.daily_report_id) === id)
  if (idx < 0) {
    // 1件の API（GET /api/staff/my-reports/:id → { report, templates }）を先に使い、無ければ一覧の API に daily_report_id を付けて取り直す
    let one = null, tpl = {}
    for (const get of [() => axios.get('/api/staff/my-reports/' + id), () => axios.get('/api/staff/my-reports', { params: { daily_report_id: id } })]) {
      try {
        const d = (await get()).data || {}
        one = [d.report, ...(d.reports || [])].find(r => r && Number(r.daily_report_id) === id) || null
        tpl = d.templates || {}
      } catch (e) { one = null }
      if (one) break
    }
    if (one) Object.assign(PAST_REPORTS.templates = PAST_REPORTS.templates || {}, tpl)
    if (!document.getElementById('past-reports') || !PAST_REPORTS) return
    if (!one) { toast('コメントの付いた日報は、過去の日報の一覧（新しい30件）にないため開けませんでした。管理者に内容を確かめてください', 6000); return }
    PAST_REPORTS.reports.push(one)
    idx = PAST_REPORTS.reports.length - 1
  }
  const btn = el.querySelector(`[data-action="openPastReport"][data-index="${idx}"]`)
  if (btn) btn.scrollIntoView({ block: 'center' })
  delegate.handlers.openPastReport({ dataset: { index: String(idx) } })
}
let OPEN_PAST_REPORT_ID = null
delegate('reloadPastReports', () => loadPastReports())
// 管理者の確認（確認済み／未確認。確認の後に直した日報は、もう一度確認してもらう）
function pastReportCheckBadge(r) {
  // 確認した日時も出す（#371。確認の日時の列より前に確認したものは日時なし）
  return r.manager_checked ? `<span class="badge badge-green"><i class="fas fa-check"></i>確認済み${r.manager_checked_at ? ' ' + esc(dayjs(String(r.manager_checked_at).replace(' ', 'T')).format('M/D HH:mm')) : ''}</span>`
    : r.revised_after_check_at ? '<span class="badge badge-yellow">修正後の確認待ち</span>' : '<span class="badge badge-gray">未確認</span>'
}
delegate('openPastReport', (el) => {
  const r = PAST_REPORTS && PAST_REPORTS.reports[Number(el.dataset.index)]
  if (!r) return
  // 未読の管理者のコメントを開いたら既読にする（#158。サーバーが unread_comment を返すときだけ。失敗しても表示はそのまま）
  if (r.unread_comment) { r.unread_comment = false; axios.post('/api/staff/my-reports/' + Number(r.daily_report_id) + '/comment-read').catch(() => { }) }
  // 項目はテンプレートの並び・表示名で出す。テンプレートに無い値（項目を変える前の日報）はキーを表示名にして後ろに出す
  const fields = ((PAST_REPORTS.templates || {})[r.template_id] || []).slice()
  for (const k of Object.keys(r.values || {})) if (!fields.some(f => f.key === k)) fields.push({ key: k, label: k === 'free' ? '報告内容' : k, type: typeof r.values[k] === 'number' ? 'number' : 'text' })
  const shown = fields.filter(f => r.values[f.key] != null && r.values[f.key] !== '')
  const nums = shown.filter(f => f.type === 'number'), texts = shown.filter(f => f.type !== 'number')
  modal(`
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-bold text-gray-800">${esc(fmtDate(r.work_date))} の日報</h3>
      <button class="text-gray-400" onclick="closeModal()" aria-label="閉じる"><i class="fas fa-xmark"></i></button>
    </div>
    <p class="text-sm text-gray-600">${esc(r.project_name)}${r.start_time ? ` ${esc(formatShiftTime(r.start_time, r.end_time))}` : ''}${r.other_company ? ` <span class="badge badge-purple">${esc(r.company_name)}</span>` : ''}</p>
    <p class="text-xs text-gray-500 mt-1">提出 ${esc(r.submitted_at ? dayjs(String(r.submitted_at).replace(' ', 'T')).format('M/D HH:mm') : '')} ${pastReportCheckBadge(r)}</p>
    ${nums.length ? `<div class="grid grid-cols-3 gap-2 mt-3">${nums.map(f => `<div class="bg-gray-50 rounded-lg p-2 text-center"><p class="text-lg font-bold text-blue-600">${esc(r.values[f.key])}</p><p class="text-[11px] text-gray-500">${esc(f.label)}</p></div>`).join('')}</div>` : ''}
    ${texts.map(f => `<div class="mt-3"><p class="text-xs font-bold text-gray-500">${esc(f.label)}</p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(r.values[f.key])}</p></div>`).join('')}
    ${!shown.length ? '<p class="text-sm text-gray-400 mt-3">入力された項目はありません</p>' : ''}
    ${r.incident_flag || r.complaint_flag ? `<p class="mt-3">${r.incident_flag ? '<span class="badge badge-red">インシデントあり</span> ' : ''}${r.complaint_flag ? '<span class="badge badge-red">クレームあり</span>' : ''}</p>` : ''}
    ${r.manager_comment ? `<div class="mt-3 bg-blue-50 rounded-lg px-3 py-2"><p class="text-xs font-bold text-blue-700 mb-0.5"><i class="fas fa-comment-dots mr-1"></i>管理者のコメント</p><p class="text-sm text-blue-900 whitespace-pre-wrap break-words">${linkify(esc(r.manager_comment))}</p></div>` : ''}
    ${r.shift_id ? `<button class="btn btn-primary w-full mt-4" data-action="editPastReport" data-id="${Number(r.shift_id)}"><i class="fas fa-pen-to-square"></i>内容を直して再提出する</button>` : ''}
    <button class="btn btn-outline w-full ${r.shift_id ? 'mt-2' : 'mt-4'}" onclick="closeModal()">閉じる</button>`)
})
// 過去の日報を開き直して、直して再提出する（#16。日報の画面はシフトの保存済みの内容を読み込む）
delegate('editPastReport', (el) => { closeModal(); location.hash = 'report/' + Number(el.dataset.id) })

// 日報タブ: 本日の入力欄（renderReport）の下に、勤務がある日も過去の日報を出す（#319）
async function renderReportWithHistory() {
  await renderReport()
  if ((location.hash || '').slice(1).split('/')[0] !== 'report') return // 読み込み中にほかのタブへ移った
  if (document.getElementById('past-reports') || $app.querySelector('[data-action="retryLoad"]')) return
  $app.insertAdjacentHTML('beforeend', '<h3 class="font-bold text-gray-700 mt-2 mb-2 px-1">過去の日報</h3><div id="past-reports" class="pb-4"></div>')
  loadPastReports()
}

// ============ 実績 ============
delegate('perfMonth', (el) => renderPerf(el.dataset.month))
// 案件の月間目標（#292）。目標・実績・あと何件と、月の経過に合わせた今日までの目安を出す
function perfGoalsHtml(p, period) {
  if (!(p.goals || []).length) return ''
  const dim = Number(period && period.days_in_month) || 0, elapsed = Number(period && period.days_elapsed) || 0
  return `<div class="mt-3 pt-3 border-t border-gray-100">
    <p class="text-xs font-bold text-gray-600 mb-1.5"><i class="fas fa-bullseye text-emerald-500 mr-1"></i>今月の目標（1人あたり）</p>
    ${p.goals.map(g => {
      const pct = g.target ? Math.min(100, Math.round(g.actual / g.target * 100)) : 0
      const left = Math.max(0, g.target - g.actual)
      const pace = dim && elapsed > 0 && elapsed < dim ? Math.ceil(g.target * elapsed / dim) : null
      return `<div class="mb-2">
        <div class="flex justify-between text-xs"><span class="text-gray-700">${esc(g.label)}</span>
          <span class="${left ? 'text-gray-500' : 'text-emerald-700 font-bold'}">${Number(g.actual)} / ${Number(g.target)}件${left ? `（あと${left}件）` : '（達成）'}</span></div>
        <div class="h-2 bg-gray-100 rounded-full mt-1 overflow-hidden"><div class="h-2 rounded-full ${left ? 'bg-blue-500' : 'bg-emerald-500'}" style="width:${pct}%"></div></div>
        ${pace != null && left ? `<p class="text-[11px] mt-0.5 ${g.actual >= pace ? 'text-emerald-700' : 'text-amber-700'}">今日までの目安 ${pace}件${g.actual >= pace ? '（順調です）' : `（目安まであと${pace - g.actual}件）`}</p>` : ''}
      </div>`
    }).join('')}
  </div>`
}
// 案件の中での順位（#496。会社の設定で出すときだけ）。匿名のときは、ほかの人の名前を出さない
function perfRankingHtml(p) {
  const r = p.ranking
  if (!r || !r.members) return ''
  const rows = p.fields.filter(f => r.by_key[f.key] && r.by_key[f.key].top.length && r.by_key[f.key].top[0].value > 0)
  if (!rows.length) return ''
  return `<details class="mt-3 pt-3 border-t border-gray-100">
    <summary class="text-xs font-bold text-gray-600 cursor-pointer"><i class="fas fa-ranking-star text-amber-500 mr-1"></i>案件の中での順位（今月・${Number(r.members)}人中）</summary>
    <div class="mt-2 space-y-2">${rows.map(f => {
      const k = r.by_key[f.key]
      const diff = Math.round((k.value - k.average) * 10) / 10
      return `<div class="text-xs">
        <p><span class="font-bold text-gray-700">${esc(f.label)}</span> <span class="text-blue-700 font-bold">${Number(k.rank)}位</span> / ${Number(r.members)}人
          <span class="text-gray-500">（平均 ${esc(k.average)}件、平均との差 ${diff >= 0 ? '+' : ''}${esc(diff)}件）</span></p>
        <p class="text-[11px] text-gray-400 mt-0.5">上位: ${k.top.map(t => `${Number(t.rank)}位 ${t.me ? 'あなた' : t.name ? esc(t.name) + 'さん' : ''} ${Number(t.value)}件`).join('、')}</p>
      </div>`
    }).join('')}</div>
  </details>`
}
// 案件ごとに、日報テンプレートの数値項目（表示名・並び順）で集計して出す（#76）。連携先の案件も含む（#75）
async function renderPerf(month) {
  loading()
  month = /^\d{4}-\d{2}$/.test(month || '') ? month : dayjs().format('YYYY-MM')
  let data
  try { data = (await axios.get('/api/staff/performance?month=' + month)).data } catch (e) { showLoadError(e); return }
  const projects = data.projects || []
  const labelOf = {}
  for (const p of projects) labelOf[p.project_id] = Object.fromEntries(p.fields.map(f => [f.key, f.label]))
  const card = (p) => {
    const shown = p.fields.filter(f => Number(p.totals[f.key] || 0) !== 0)
    return `<section class="card p-4 mb-3">
      <h3 class="text-sm font-bold text-gray-700 mb-2">${esc(p.project_name)}${p.other_company ? ` <span class="badge badge-purple">${esc(p.company_name)}</span>` : ''}<span class="text-xs font-normal text-gray-400 ml-1">${Number(p.days)}日分</span></h3>
      ${shown.length ? `<div class="grid grid-cols-3 gap-2">${shown.map(f => `
        <div class="bg-gray-50 rounded-xl p-2.5 text-center">
          <p class="text-xl font-bold text-blue-600">${esc(p.totals[f.key])}</p>
          <p class="text-[11px] text-gray-500 mt-0.5 break-words">${esc(f.label)}</p>
        </div>`).join('')}</div>` : '<p class="text-xs text-gray-400">数値の実績はありません</p>'}
      ${perfGoalsHtml(p, data.goal_period)}
      ${perfRankingHtml(p)}
    </section>`
  }
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button class="btn btn-outline" data-action="perfMonth" data-month="${esc(dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM'))}" aria-label="前の月"><i class="fas fa-chevron-left"></i></button>
      <h2 class="font-bold text-gray-800">${dayjs(month + '-01').format('YYYY年M月')}の実績</h2>
      <button class="btn btn-outline" data-action="perfMonth" data-month="${esc(dayjs(month + '-01').add(1, 'month').format('YYYY-MM'))}" aria-label="次の月"><i class="fas fa-chevron-right"></i></button>
    </div>
    ${data.daily.length ? projects.map(card).join('') : '<p class="text-center text-gray-400 py-8">この月の実績データはありません</p>'}
    ${data.daily.length ? `<h3 class="font-bold text-gray-700 mb-2 px-1">日別実績</h3>
    <div class="space-y-2">
      ${data.daily.slice().reverse().map(d => {
        const labels = labelOf[d.project_id] || {}
        const p = projects.find(x => x.project_id === d.project_id)
        const keys = (p ? p.fields.map(f => f.key) : Object.keys(d.values)).filter(k => Number(d.values[k] || 0) > 0)
        return `<div class="card p-3.5">
          <div class="flex justify-between items-center gap-2">
            <span class="font-bold text-sm text-gray-800">${esc(fmtDate(d.date))}</span>
            <span class="text-xs text-gray-400 truncate">${esc(d.project)}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-1.5">
            ${keys.map(k => `<span class="badge badge-blue">${esc(labels[k] || k)} ${esc(d.values[k])}</span>`).join('') || '<span class="text-xs text-gray-400">実績なし</span>'}
          </div>
          ${d.comment ? `<p class="text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-2 whitespace-pre-wrap"><i class="fas fa-comment-dots mr-1"></i>${linkify(esc(d.comment))}</p>` : ''}
        </div>`
      }).join('')}
    </div>` : ''}`
}

// ============ その他 (お知らせ / 相談) ============
// 『その他』のメニュー。中の画面はそれぞれ URL（#notices・#consult・#manual など）で開き、戻る・下のタブで戻れるようにする（#374）。
// ほかの画面の『戻る』から呼ばれたときは、URL を #more に変えて描き直す（false を返す）
function renderMore() {
  if ((location.hash || '') !== '#more') { location.hash = 'more'; return false }
  const item = (hash, icon, title, sub, badgeId) => `
      <a href="#${hash}" class="report-btn">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas ${icon}"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">${title}${badgeId ? ` <span id="${badgeId}" class="badge badge-red hidden"></span>` : ''}</span><span class="block text-xs text-gray-400">${sub}</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </a>`
  $app.innerHTML = `
    <div id="more-emergency"></div>
    <div class="space-y-3">
      ${item('notices', 'fa-bullhorn', 'お知らせ', '会社からのお知らせを確認', 'more-notice-count')}
      ${item('consult', 'fa-comments', '相談・連絡', '管理者への相談・連絡')}
      ${item('notifications', 'fa-bell', '通知', '打刻修正申請の受付・承認・却下、お知らせの確認のお願い', 'more-notif-count')}
      ${item('notify-settings', 'fa-sliders', '通知の設定', 'プッシュ通知・メールの受け取り')}
      ${item('attendance', 'fa-user-clock', '打刻履歴・修正申請', '打刻の確認・時刻の修正・打刻漏れの追加')}
      ${item('manual', 'fa-book-open', '研修・マニュアル', '案件マニュアル・研修資料')}
    </div>
    <section class="mt-8 pt-4 border-t border-gray-200">
      <button class="btn btn-outline w-full text-red-600" data-action="staffLogout"><i class="fas fa-right-from-bracket"></i>ログアウト</button>
      <p id="logout-msg" class="hidden text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mt-2" role="alert"></p>
      <p class="text-[11px] text-gray-400 mt-2 text-center">共用の端末では、使い終わったらログアウトしてください</p>
    </section>`
  applyBadges()
  loadEmergencyContacts()
}

// 会社の緊急連絡先（#173）。所属・連携している会社のうち、登録のある会社の電話をタップで発信できるボタンにする。取れなければ何も出さない
async function loadEmergencyContacts() {
  let d
  try { d = (await axios.get('/api/staff/emergency-contacts')).data } catch (e) { return }
  const box = document.getElementById('more-emergency')
  if (!box || !d.contacts || !d.contacts.length) return
  const many = d.contacts.length > 1
  box.innerHTML = `<section class="card p-4 mb-3 border-red-100">
      <p class="text-sm font-bold text-gray-800 mb-1"><i class="fas fa-phone text-red-500 mr-1"></i>緊急連絡先</p>
      <p class="text-[11px] text-gray-500 mb-2">当日の欠勤・遅刻・体調不良・現場のトラブルは、こちらに電話してください${many ? '（シフトの会社の番号にかけてください）' : ''}</p>
      <div class="space-y-2">${d.contacts.map(x => `
        <a href="tel:${esc(String(x.phone).replace(/[^0-9+]/g, ''))}" class="btn btn-outline w-full justify-start">
          <i class="fas fa-phone text-red-500"></i><span class="flex-1 text-left">${many ? `<span class="block text-[11px] text-gray-500">${esc(x.company_name)}</span>` : ''}<span class="font-bold">${esc(x.phone)}</span>${x.note ? `<span class="block text-[11px] text-gray-400">${esc(x.note)}</span>` : ''}</span>
        </a>`).join('')}</div>
    </section>`
}

// 『その他』の中の画面の上に出す戻るボタン
const MORE_BACK = '<a href="#more" class="text-sm text-blue-600 mb-3 inline-block"><i class="fas fa-chevron-left mr-1"></i>その他へ戻る</a>'

// ============ お知らせ（一覧 #notices・個別 #notices/:id #333） ============
// 一覧は未読（緊急・確認必須を先）→ 既読の順。既読の本文は3行に折りたたむ（#553）。
// 「確認しました」は、そのカードだけを既読の表示に変える（一覧を読み直さない #334）
// moved: 読み込んだ後に既読にした件数（並び順が変わるので、続きはその分だけ戻って取り、重複は除く）
let NOTICES = { list: [], offset: 0, has_more: false, filter: 'all', unread_count: 0, other: [], moved: 0, seq: 0 }
let NOTICE_DETAIL = null
const NOTICE_SEND_ERROR = '送信できませんでした。通信状況を確認して、もう一度押してください'

// 重要度（緊急と重要を分ける #191）と配信先（全体／案件名 #455）の印
function noticeImportanceBadge(n) {
  return n.importance === 'urgent' ? '<span class="badge badge-red"><i class="fas fa-triangle-exclamation"></i>緊急</span>'
    : n.importance === 'important' ? '<span class="badge badge-yellow">重要</span>' : ''
}
function noticeBadgesHtml(n) {
  return noticeImportanceBadge(n)
    + (n.read_required && !n.is_read ? '<span class="badge badge-purple">確認必須</span>' : '')
    + (n.updated_at ? '<span class="badge badge-yellow">更新</span>' : '')
    + (n.expired ? '<span class="badge badge-gray">掲載終了</span>' : '')
    + (n.target_type === 'project' ? `<span class="badge badge-gray">案件: ${esc(n.project_names || '-')}</span>`
      : n.target_type === 'staff' ? '<span class="badge badge-gray">あなたあて</span>' : '<span class="badge badge-gray">全体</span>')
}
// まとめて確認できるお知らせ（緊急・確認必須は1件ずつ開いて確認してもらう）
function noticeBulkReadable(n) { return !n.is_read && !n.read_required && n.importance !== 'urgent' }

function noticeCardHtml(n, detail) {
  // 既読の本文は折りたたむ（この画面で確認したばかりのものは開いたままにする）
  const collapsed = n.is_read && !detail && !n._open
  const body = String(n.body || '')
  const long = body.length > 120 || body.split('\n').length > 3
  const strong = !n.is_read && (n.read_required || n.importance === 'urgent')
  return `
    <div class="card p-4 ${n.is_read ? '' : strong ? 'ring-2 ring-red-300' : 'ring-1 ring-blue-200'}" id="notice-${Number(n.notice_id)}">
      <div class="flex items-center gap-1.5 mb-1 flex-wrap">
        ${noticeBadgesHtml(n)}
        ${n.no_confirm ? '<span class="badge badge-gray">確認不要</span>' : !n.is_read ? '<span class="badge badge-blue">未読</span>' : '<span class="badge badge-gray">既読</span>'}
        <span class="text-xs text-gray-400 ml-auto">${esc(dayjs(String(n.published_at).replace(' ', 'T')).format('M/D HH:mm'))}</span>
      </div>
      <h3 class="font-bold text-gray-800">${detail ? esc(n.title) : `<a href="#notices/${Number(n.notice_id)}" class="hover:underline">${esc(n.title)}</a>`}</h3>
      <p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap ${collapsed && long ? 'line-clamp-3' : ''}" id="notice-body-${Number(n.notice_id)}">${linkify(esc(body))}</p>
      ${collapsed && long ? `<button class="text-xs text-blue-600 mt-1" data-action="noticeExpand" data-id="${Number(n.notice_id)}">続きを読む</button>` : ''}
      ${noticeAttachmentsHtml(n)}
      ${n.updated_at || n.expires_at ? `<p class="text-[11px] text-gray-400 mt-2">${n.updated_at ? `${esc(dayjs(String(n.updated_at).replace(' ', 'T')).format('M/D HH:mm'))} に内容が更新されました` : ''}${n.updated_at && n.expires_at ? '・' : ''}${n.expires_at ? `掲載は ${esc(dayjs(String(n.expires_at).slice(0, 10)).format('M/D'))} まで` : ''}</p>` : ''}
      ${n.no_confirm ? '<p class="text-[11px] text-gray-400 mt-2">公開から2年以上たったお知らせのため、確認は不要です</p>' : ''}
      ${noticeResponseHtml(n)}
      ${!n.is_read ? `<button class="btn btn-primary w-full mt-3" data-action="noticeMarkRead" data-id="${Number(n.notice_id)}"><i class="fas fa-check"></i>確認しました</button>` : ''}
    </div>`
}

// 添付（#555）。画像は小さく並べ、押すと別のタブで大きく開く。PDF はリンク
function noticeAttachmentsHtml(n) {
  const files = n.attachments || []
  if (!files.length) return n.attachment_count ? `<p class="text-xs text-gray-500 mt-2"><i class="fas fa-paperclip mr-1"></i>添付 ${Number(n.attachment_count)}件（開いて確認してください）</p>` : ''
  const url = (a) => `/api/staff/notices/${Number(n.notice_id)}/attachments/${Number(a.attachment_id)}`
  const imgs = files.filter(a => a.content_type !== 'application/pdf'), pdfs = files.filter(a => a.content_type === 'application/pdf')
  return `
    ${imgs.length ? `<div class="flex flex-wrap gap-2 mt-2">${imgs.map(a => `<a href="${url(a)}" target="_blank" rel="noopener" class="block w-20 h-20 rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
      <img src="${url(a)}" alt="${esc(a.file_name)}" loading="lazy" class="w-full h-full object-cover"></a>`).join('')}</div>` : ''}
    ${pdfs.map(a => `<a href="${url(a)}" target="_blank" rel="noopener" class="flex items-center gap-2 text-sm text-blue-600 mt-2"><i class="fas fa-file-pdf text-red-500"></i><span class="underline truncate">${esc(a.file_name)}</span></a>`).join('')}`
}

// 回答（#554）。選択肢だけなら押すとすぐ送る。自由記入欄があるときは、選んで書いてから「回答を送る」。答え直せる
function noticeResponseHtml(n) {
  const options = n.response_options || []
  if (!options.length && !n.response_comment) return ''
  const id = Number(n.notice_id)
  const mine = n.my_response
  const picked = n._choice != null ? n._choice : mine ? mine.choice : null
  const closed = n.expired || n.no_confirm
  const answered = mine ? `<p class="text-xs text-emerald-700 mb-2"><i class="fas fa-circle-check mr-1"></i>回答済み${mine.choice != null ? `: <b>${esc(mine.choice)}</b>` : ''}${mine.comment ? `（${esc(mine.comment)}）` : ''}</p>` : ''
  if (closed) return `<div class="mt-3 border-t border-gray-100 pt-3">${answered}<p class="text-xs text-gray-400">回答の受付は終わりました</p></div>`
  return `
    <div class="mt-3 border-t border-gray-100 pt-3" id="notice-response-${id}">
      <p class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-reply text-blue-600 mr-1"></i>回答してください</p>
      ${answered}
      ${options.length ? `<div class="flex flex-wrap gap-2">${options.map((o, i) => `<button class="px-3 py-2 rounded-lg text-sm font-bold border ${picked === o ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}"
        data-action="${n.response_comment ? 'noticeChoose' : 'noticeRespond'}" data-id="${id}" data-i="${i}">${esc(o)}</button>`).join('')}</div>` : ''}
      ${n.response_comment ? `<textarea id="notice-comment-${id}" rows="2" maxlength="500" class="inp mt-2 text-sm" placeholder="コメント・回答を入力">${esc(n._comment != null ? n._comment : mine && mine.comment ? mine.comment : '')}</textarea>
        <button class="btn btn-primary w-full mt-2" data-action="noticeRespond" data-id="${id}">${mine ? '回答を送り直す' : '回答を送る'}</button>` : ''}
    </div>`
}

function noticeToolbarHtml() {
  const bulk = NOTICES.list.filter(noticeBulkReadable).length
  const tab = (f, label) => `<button class="px-3 py-1.5 rounded-lg text-xs font-bold ${NOTICES.filter === f ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}" data-action="noticeFilter" data-filter="${f}">${label}</button>`
  return `
    ${tab('all', 'すべて')}${tab('unread', `未読のみ（${Number(NOTICES.unread_count) || 0}）`)}${tab('past', '掲載終了')}
    ${bulk >= 2 ? `<button class="text-xs text-blue-600 font-bold ml-auto" data-action="noticeReadAll"><i class="fas fa-check-double mr-1"></i>すべて確認しました（${bulk}件）</button>` : ''}`
}

function drawNotices() {
  const other = NOTICES.other.map(o => `
    <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3 text-sm text-amber-800" role="alert">
      <i class="fas fa-building mr-1"></i>${esc(o.company_name)} に未読のお知らせが <b>${Number(o.unread)}件</b> あります
      <button class="underline font-bold ml-1" data-action="noticeSwitchCompany" data-id="${Number(o.company_id)}">切り替えて見る</button>
    </div>`).join('')
  $app.innerHTML = `
    ${MORE_BACK}
    <h2 class="font-bold text-gray-800 mb-3 px-1"><i class="fas fa-bullhorn text-blue-600 mr-1"></i>お知らせ</h2>
    ${other}
    <div class="flex items-center gap-2 mb-3 px-1" id="notice-toolbar">${noticeToolbarHtml()}</div>
    <div class="space-y-2">
      ${NOTICES.filter === 'past' ? '<p class="text-xs text-gray-500 px-1">掲載期限を過ぎたお知らせです（新しい順）</p>' : ''}
      ${NOTICES.list.map(n => noticeCardHtml(n, false)).join('') || `<p class="text-center text-gray-400 py-10">${NOTICES.filter === 'unread' ? '未読のお知らせはありません' : NOTICES.filter === 'past' ? '掲載が終わったお知らせはありません' : 'お知らせはありません'}</p>`}
    </div>
    ${NOTICES.has_more ? '<button class="btn btn-outline w-full mt-3" data-action="noticeMore">もっと見る</button>' : ''}`
}

window.renderNotices = async function (more) {
  if (more !== true) { NOTICES.list = []; NOTICES.offset = 0; NOTICES.moved = 0; loading() }
  const seq = ++NOTICES.seq
  let d
  try {
    d = (await axios.get('/api/staff/notices', { params: { offset: Math.max(0, NOTICES.offset - NOTICES.moved), filter: NOTICES.filter } })).data
  } catch (e) {
    if (seq !== NOTICES.seq) return
    if (more === true) { showApiError(e, 'お知らせを読み込めませんでした。もう一度お試しください'); return }
    $app.innerHTML = `<div class="card p-4 text-center text-sm text-gray-600">お知らせを読み込めませんでした。通信状況を確認してください
      <button class="btn btn-outline w-full mt-3" data-action="noticeRetry">再読み込み</button></div>`
    return
  }
  if (seq !== NOTICES.seq) return // 後から始めた読み込み（絞り込みの切替など）を優先する
  const seen = new Set(NOTICES.list.map(n => n.notice_id))
  NOTICES.list.push(...d.notices.filter(n => !seen.has(n.notice_id)))
  NOTICES.offset = Number(d.offset || 0) + d.notices.length
  NOTICES.moved = 0
  NOTICES.has_more = !!d.has_more
  if (d.unread_count != null) NOTICES.unread_count = d.unread_count
  if (d.other_companies) NOTICES.other = d.other_companies
  drawNotices()
}

async function renderNoticeDetail(id) {
  loading()
  NOTICE_DETAIL = null
  const back = '<a href="#notices" class="text-sm text-blue-600 mb-3 inline-block"><i class="fas fa-chevron-left mr-1"></i>お知らせ一覧へ</a>'
  let d
  try { d = (await axios.get(`/api/staff/notices/${Number(id)}`)).data } catch (e) {
    const r = e.response && e.response.data
    $app.innerHTML = `${back}<div class="card p-4 text-sm text-gray-600">
      ${r && r.withdrawn ? '<i class="fas fa-ban text-gray-400 mr-1"></i>' : ''}${esc(e.response ? (r && r.error) || 'お知らせが見つかりません' : 'お知らせを読み込めませんでした。通信状況を確認してください')}
      ${r && r.other_company ? `<button class="btn btn-primary w-full mt-3" data-action="noticeSwitchCompany" data-id="${Number(r.other_company.company_id)}">${esc(r.other_company.company_name)} に切り替えて開く</button>`
        : !e.response ? '<button class="btn btn-outline w-full mt-3" data-action="noticeRetry">再読み込み</button>' : ''}</div>`
    return
  }
  NOTICE_DETAIL = d.notice
  $app.innerHTML = back + noticeCardHtml(d.notice, true)
}

delegate('noticeMarkRead', el => withSubmitLock(el, async () => {
  const id = Number(el.dataset.id)
  try { await axios.post(`/api/staff/notices/${id}/read`) } catch (e) { showApiError(e, NOTICE_SEND_ERROR); return }
  const inDetail = /^#notices\/\d+/.test(location.hash) && NOTICE_DETAIL && NOTICE_DETAIL.notice_id === id
  const rows = [NOTICES.list.find(x => x.notice_id === id), inDetail ? NOTICE_DETAIL : null].filter(Boolean)
  if (rows.some(n => !n.is_read)) NOTICES.unread_count = Math.max(0, (Number(NOTICES.unread_count) || 0) - 1)
  if (rows[0] && rows[0] !== NOTICE_DETAIL && !rows[0].is_read) NOTICES.moved++
  rows.forEach(n => { n.is_read = 1; n._open = true })
  const card = document.getElementById('notice-' + id)
  if (card && rows.length) card.outerHTML = noticeCardHtml(inDetail ? NOTICE_DETAIL : rows[0], !!inDetail)
  const bar = document.getElementById('notice-toolbar')
  if (bar) bar.innerHTML = noticeToolbarHtml()
  toast('確認しました')
  refreshBadges()
}))
delegate('noticeReadAll', el => withSubmitLock(el, async () => {
  const ids = NOTICES.list.filter(noticeBulkReadable).map(n => n.notice_id)
  if (!ids.length || !confirm(`未読のお知らせ ${ids.length}件を確認済みにしますか？\n（緊急・確認必須のお知らせは、1件ずつ開いて確認してください）`)) return
  let d
  try { d = (await axios.post('/api/staff/notices/read-all', { ids })).data } catch (e) { showApiError(e, NOTICE_SEND_ERROR); return }
  const done = new Set(d.read || [])
  for (const n of NOTICES.list) if (done.has(n.notice_id) && !n.is_read) { n.is_read = 1; NOTICES.moved++ }
  NOTICES.unread_count = Math.max(0, (Number(NOTICES.unread_count) || 0) - done.size)
  drawNotices()
  toast(`${done.size}件を確認しました`)
  refreshBadges()
}))
delegate('noticeExpand', el => {
  const p = document.getElementById('notice-body-' + Number(el.dataset.id))
  if (p) p.classList.remove('line-clamp-3')
  el.remove()
})
delegate('noticeFilter', el => { NOTICES.filter = ['unread', 'past'].includes(el.dataset.filter) ? el.dataset.filter : 'all'; renderNotices() })
// 回答（#554）。一覧と個別画面の両方の行を更新して、そのカードだけを描き直す
function noticeRowsById(id) {
  const inDetail = /^#notices\/\d+/.test(location.hash) && NOTICE_DETAIL && NOTICE_DETAIL.notice_id === id
  return { inDetail, rows: [NOTICES.list.find(x => x.notice_id === id), inDetail ? NOTICE_DETAIL : null].filter(Boolean) }
}
function redrawNoticeCard(id) {
  const { inDetail, rows } = noticeRowsById(id)
  const card = document.getElementById('notice-' + id)
  if (card && rows.length) card.outerHTML = noticeCardHtml(inDetail ? NOTICE_DETAIL : rows[0], !!inDetail)
}
delegate('noticeChoose', el => {
  const id = Number(el.dataset.id)
  const { rows } = noticeRowsById(id)
  if (!rows.length) return
  const t = document.getElementById('notice-comment-' + id)
  rows.forEach(n => { n._choice = (n.response_options || [])[Number(el.dataset.i)]; if (t) n._comment = t.value })
  redrawNoticeCard(id)
})
delegate('noticeRespond', el => withSubmitLock(el, async () => {
  const id = Number(el.dataset.id)
  const { rows } = noticeRowsById(id)
  const n = rows[0]
  if (!n) return
  const options = n.response_options || []
  const choice = el.dataset.i != null ? options[Number(el.dataset.i)] : (n._choice != null ? n._choice : n.my_response ? n.my_response.choice : null)
  const t = document.getElementById('notice-comment-' + id)
  const comment = t ? t.value.trim() : ''
  if (options.length && choice == null) { toast('回答を選んでください'); return }
  if (!options.length && !comment) { toast('回答を入力してください'); return }
  let d
  try { d = (await axios.post(`/api/staff/notices/${id}/response`, { choice, comment })).data } catch (e) { showApiError(e, NOTICE_SEND_ERROR); return }
  if (rows.some(x => !x.is_read)) NOTICES.unread_count = Math.max(0, (Number(NOTICES.unread_count) || 0) - 1)
  if (rows[0] !== NOTICE_DETAIL && !rows[0].is_read) NOTICES.moved++
  rows.forEach(x => { x.my_response = d.my_response; x._choice = null; x._comment = null; x.is_read = 1; x._open = true })
  redrawNoticeCard(id)
  const bar = document.getElementById('notice-toolbar')
  if (bar) bar.innerHTML = noticeToolbarHtml()
  toast('回答しました')
  refreshBadges()
}))
delegate('noticeMore', el => withSubmitLock(el, () => renderNotices(true)))
delegate('noticeRetry', () => route())
delegate('noticeSwitchCompany', el => withSubmitLock(el, async () => {
  if (!window.switchStaffCompany) return
  try { await switchStaffCompany(Number(el.dataset.id)) } catch (e) { showApiError(e, '切り替えに失敗しました') }
}))

// ============ 相談・連絡 ============
// 送り先の会社と対象のシフトを選べる（#222 #195）。カテゴリは未選択から始める（#235）。
// 送信中はボタンを押せず、失敗したら入力を残したままエラーを出す（#194）。開いたら管理者の返信を既読にする（#320）
const CONSULT_NET_ERROR = '通信に失敗しました。電波の良い場所で再度お試しください'
function consultApiError(e, fallback) { return showApiError(e, e && e.response ? fallback : CONSULT_NET_ERROR) }
const CONSULT_ST_BADGE = { open: '<span class="badge badge-yellow">未対応</span>', in_progress: '<span class="badge badge-blue">対応中</span>', done: '<span class="badge badge-green">対応済</span>' }
// 対象のシフトを選ばないと送れないカテゴリ（選べるシフトがある場合だけ）
const CONSULT_SHIFT_REQUIRED = ['absence']

// 相談に付ける写真（#429）。端末で縮小（compressImage）してから送る。1回の送信に3枚まで
const CONSULT_PHOTO_LIMIT = 3
const CONSULT_PICKS = { form: [], follow: [] }
function consultPicksHtml(which) {
  const list = CONSULT_PICKS[which]
  return list.map((p, i) => `<div class="relative"><img src="${esc(p.url)}" alt="選んだ写真" class="w-16 h-16 object-cover rounded-lg border border-gray-200">
    <button type="button" class="absolute -top-2 -right-2 bg-white rounded-full w-6 h-6 text-xs text-gray-600 border border-gray-300" data-action="consultPhotoRemove" data-which="${which}" data-idx="${i}" aria-label="写真を外す"><i class="fas fa-xmark"></i></button></div>`).join('')
}
function consultPhotoInputHtml(which) {
  return `<div>
    <label class="text-sm text-gray-600 block mb-1">写真（任意・${CONSULT_PHOTO_LIMIT}枚まで）</label>
    <div class="flex gap-3 flex-wrap items-center" id="c-picks-${which}">${consultPicksHtml(which)}</div>
    <label class="btn btn-outline text-xs mt-2 inline-flex"><i class="fas fa-camera"></i>写真を選ぶ<input type="file" accept="image/*" multiple class="hidden" data-consult-photo="${which}"></label>
    <p class="text-xs text-gray-400 mt-1">店舗の状況や受け取った書面などを送れます。管理者だけが見られます</p>
  </div>`
}
function consultPicksClear(which) { CONSULT_PICKS[which].forEach(p => URL.revokeObjectURL(p.url)); CONSULT_PICKS[which] = [] }
function consultPicksRefresh(which) { const box = document.getElementById('c-picks-' + which); if (box) box.innerHTML = consultPicksHtml(which) }
document.addEventListener('change', async (e) => {
  const input = e.target
  const which = input && input.dataset && input.dataset.consultPhoto
  if (!which) return
  const files = [...(input.files || [])]
  input.value = ''
  for (const f of files) {
    if (CONSULT_PICKS[which].length >= CONSULT_PHOTO_LIMIT) { toast(`写真は${CONSULT_PHOTO_LIMIT}枚までです`); break }
    if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name || '')) { toast('画像ファイルを選んでください'); continue }
    if (f.size > PHOTO_MAX_UPLOAD_BYTES) { toast('写真のファイルが大きすぎます（50MBまで）'); continue }
    try {
      const blob = await compressImage(f)
      CONSULT_PICKS[which].push({ blob, url: URL.createObjectURL(blob) })
    } catch (err) { toast(err && err.message ? err.message : '画像の処理に失敗しました') }
  }
  consultPicksRefresh(which)
})
delegate('consultPhotoRemove', el => {
  const list = CONSULT_PICKS[el.dataset.which]; if (!list) return
  const [p] = list.splice(Number(el.dataset.idx), 1)
  if (p) URL.revokeObjectURL(p.url)
  consultPicksRefresh(el.dataset.which)
})
// 写真を順に送る。送れなかった枚数を返す（相談・追加の連絡そのものは送信済み）
async function consultUploadPhotos(consultationId, messageId, picks) {
  let failed = 0
  for (const p of picks) {
    const fd = new FormData()
    fd.append('photo', p.blob, 'photo.jpg')
    if (messageId) fd.append('message_id', String(messageId))
    try { await axios.post(`/api/staff/consultations/${Number(consultationId)}/photos`, fd) } catch (e) { failed++ }
  }
  return failed
}
function consultPhotosView(co, messageId) {
  const list = (co.photos || []).filter(p => (p.message_id || null) === (messageId || null))
  return list.length ? `<div class="flex gap-2 flex-wrap mt-2">${list.map(p => `<a href="/api/staff/consultation-photo/${Number(p.attachment_id)}" target="_blank" rel="noopener">
    <img src="/api/staff/consultation-photo/${Number(p.attachment_id)}" alt="添付の写真" loading="lazy" class="w-16 h-16 object-cover rounded-lg border border-gray-200"></a>`).join('')}</div>` : ''
}
// 管理者の返信と自分の追加の連絡を時系列で出す（#154）
function consultThreadView(co) {
  const msgs = co.messages || []
  if (!msgs.length && co.manager_reply) return `<div class="mt-2 bg-blue-50 rounded-lg px-3 py-2"><p class="text-xs font-bold text-blue-700 mb-0.5"><i class="fas fa-reply mr-1"></i>管理者からの返信</p><p class="text-sm text-blue-900 whitespace-pre-wrap break-words">${linkify(esc(co.manager_reply))}</p></div>`
  const at = (x) => esc(dayjs(String(x || '').replace(' ', 'T')).format('M/D HH:mm'))
  return msgs.map(m => m.author_side === 'admin'
    ? `<div class="mt-2 bg-blue-50 rounded-lg px-3 py-2"><p class="text-xs font-bold text-blue-700 mb-0.5"><i class="fas fa-reply mr-1"></i>管理者からの返信<span class="font-normal text-blue-500 ml-1">${at(m.created_at)}</span></p><p class="text-sm text-blue-900 whitespace-pre-wrap break-words">${linkify(esc(m.body))}</p></div>`
    : `<div class="mt-2 bg-gray-50 rounded-lg px-3 py-2"><p class="text-xs text-gray-500 mb-0.5"><i class="fas fa-user mr-1"></i>追加の連絡<span class="ml-1">${at(m.created_at)}</span></p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(m.body)}</p>${consultPhotosView(co, m.message_id)}</div>`).join('')
}

function consultShiftLabel(s, multi) {
  return `${fmtDate(s.work_date)} ${formatShiftTime(s.start_time, s.end_time)} ${s.project_name || ''}${multi ? `（${s.company_name}）` : ''}${s.status === 'requested' ? '［希望（仮）］' : ''}`
}

window.renderConsult = async function () {
  loading()
  // ヘッダーと下のメニューは『その他』の扱い（#consult から開いた場合も）
  document.getElementById('header-title').textContent = '相談・連絡'
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === 'more'))
  let data, loadError = ''
  try { data = (await axios.get('/api/staff/consultations')).data } catch (e) {
    if (e && e.response && e.response.status === 401) return
    // 一覧・対象のシフトを読めなくても、今の会社あての相談は送れるようにする（送り先はサーバーが今の会社にする）
    loadError = `<section class="card p-3 mb-3 text-center bg-red-50"><p class="text-sm text-red-700 mb-2">${esc((e && e.response && e.response.data && e.response.data.error) || (e && e.response ? '相談の履歴を読み込めませんでした' : CONSULT_NET_ERROR))}</p>
      <p class="text-xs text-gray-600 mb-2">下のフォームから、今の会社の管理者に送ることはできます（対象のシフトは選べません）</p>
      <button class="btn btn-outline text-xs" data-action="consultReload"><i class="fas fa-rotate-right"></i>再読み込み</button></section>`
    data = { companies: [], targets: [], consultations: [], current_company_id: null, today: dayjs().format('YYYY-MM-DD'), load_failed: true }
  }
  if (location.hash.slice(1).split('/')[0] !== 'consult') return // 読み込み中にほかの画面へ移った
  const companies = data.companies || []
  const targets = data.targets || []
  const multi = companies.length > 1
  const coName = (cid) => (companies.find(c => c.company_id === cid) || {}).company_name || ''
  // 既定の対象: 今日のシフト（複数あれば最初のもの）。既定の送り先: そのシフトの会社、なければ今の会社
  const todayShift = targets.find(s => s.work_date === data.today)
  $app.innerHTML = `
    ${MORE_BACK}
    <h2 class="font-bold text-gray-800 mb-3 px-1"><i class="fas fa-comments text-blue-600 mr-1"></i>相談・連絡</h2>
    ${loadError}
    <section class="card p-4 mb-4">
      <form id="consult-form" class="space-y-3">
        <div>
          <label class="text-sm text-gray-600 block mb-1" for="c-cat">カテゴリ</label>
          <select id="c-cat" class="inp" required>
            <option value="">選択してください</option>
            ${Object.entries(CAT_LABELS).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-sm text-gray-600 block mb-1" for="c-shift">対象のシフト</label>
          <select id="c-shift" class="inp">
            <option value="">シフトを選ばない（シフト以外の相談）</option>
            ${targets.map(s => `<option value="${esc(s.shift_id)}" ${todayShift && todayShift.shift_id === s.shift_id ? 'selected' : ''}>${esc(consultShiftLabel(s, multi))}</option>`).join('')}
          </select>
          <p class="text-xs text-gray-400 mt-1">${targets.length ? '遅刻・欠勤の連絡は、対象のシフトを選んでください（前日〜7日後のシフトを表示）' : '前日〜7日後のシフトはありません'}</p>
        </div>
        <div>
          <label class="text-sm text-gray-600 block mb-1" for="c-company">送り先</label>
          ${multi ? `<select id="c-company" class="inp">
              ${companies.map(c => `<option value="${esc(c.company_id)}" ${c.company_id === data.current_company_id ? 'selected' : ''}>${esc(c.company_name)}</option>`).join('')}
            </select>` : `<p class="text-sm font-bold text-gray-800">${esc(companies[0] ? companies[0].company_name : data.load_failed ? '今の所属企業' : '')}</p>`}
          <p id="c-company-note" class="text-xs text-gray-400 mt-1">${multi ? '選んだ会社の管理者に届きます。シフトを選ぶと、そのシフトの会社に届きます' : 'この会社の管理者に届きます'}</p>
        </div>
        <div>
          <label class="text-sm text-gray-600 block mb-1" for="c-body">内容</label>
          <textarea id="c-body" rows="4" class="inp" maxlength="2000" placeholder="相談内容を入力してください" required></textarea>
        </div>
        ${consultPhotoInputHtml('form')}
        <div>
          <label class="text-sm text-gray-600 block mb-1">緊急度</label>
          <div class="grid grid-cols-3 gap-2">
            <label class="flex items-center justify-center gap-1 border border-gray-200 rounded-lg py-2 text-sm has-[:checked]:bg-blue-50 has-[:checked]:border-blue-400"><input type="radio" name="urgency" value="low" class="hidden">低</label>
            <label class="flex items-center justify-center gap-1 border border-gray-200 rounded-lg py-2 text-sm has-[:checked]:bg-blue-50 has-[:checked]:border-blue-400"><input type="radio" name="urgency" value="normal" checked class="hidden">中</label>
            <label class="flex items-center justify-center gap-1 border border-gray-200 rounded-lg py-2 text-sm has-[:checked]:bg-red-50 has-[:checked]:border-red-400"><input type="radio" name="urgency" value="high" class="hidden">高</label>
          </div>
        </div>
        <button type="submit" id="consult-submit" class="btn btn-primary w-full">送信する</button>
      </form>
    </section>
    <h3 class="font-bold text-gray-700 mb-2 px-1">相談履歴</h3>
    <div class="space-y-2">
      ${data.load_failed ? '' : (data.consultations || []).map(co => `
        <div class="card p-4 ${co.reply_unread ? 'ring-2 ring-blue-300' : ''}">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="badge badge-gray">${esc(CAT_LABELS[co.category] || co.category)}</span>
            ${co.urgency === 'high' ? '<span class="badge badge-red">緊急</span>' : ''}
            ${CONSULT_ST_BADGE[co.status] || ''}
            ${co.reply_unread ? '<span class="badge badge-blue">新しい返信</span>' : ''}
            <span class="text-xs text-gray-400 ml-auto">${dayjs(String(co.created_at || '').replace(' ', 'T')).format('M/D HH:mm')}</span>
          </div>
          ${multi || co.target_date ? `<p class="text-xs text-gray-500 mb-1">${multi ? `<i class="fas fa-building mr-1"></i>${esc(co.company_name)}` : ''}${multi && co.target_date ? '・' : ''}${co.target_date ? `対象: ${esc(fmtDate(co.target_date))} ${esc(co.target_project_name || '')}` : ''}</p>` : ''}
          <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">${esc(co.body)}</p>
          ${consultPhotosView(co, null)}
          ${consultThreadView(co)}
          <button type="button" class="btn btn-outline text-xs mt-3" data-action="consultFollowOpen" data-id="${Number(co.consultation_id)}"><i class="fas fa-comment-dots"></i>この相談に追加で連絡する</button>
        </div>`).join('') || '<p class="text-center text-gray-400 py-6">相談履歴はありません</p>'}
    </div>`

  // シフトを選んだら、送り先はそのシフトの会社に固定する
  const shiftSel = document.getElementById('c-shift')
  const companySel = document.getElementById('c-company')
  const syncCompany = () => {
    const s = targets.find(x => String(x.shift_id) === shiftSel.value)
    if (companySel) {
      if (s && s.company_id != null) companySel.value = String(s.company_id)
      companySel.disabled = !!s
    }
    const note = document.getElementById('c-company-note')
    if (note && multi) note.textContent = s ? (s.company_name ? `このシフトの会社（${s.company_name}）の管理者に届きます` : 'このシフトの会社の管理者に届きます') : '選んだ会社の管理者に届きます。シフトを選ぶと、そのシフトの会社に届きます'
  }
  shiftSel.addEventListener('change', syncCompany)
  syncCompany()

  // 下書き（#421）: 送っていない入力があれば戻し、入力のたびに保存する
  const cform = document.getElementById('consult-form')
  const cdraft = draftLoad('consult')
  if (cdraft) {
    if (cdraft.category && CAT_LABELS[cdraft.category]) document.getElementById('c-cat').value = cdraft.category
    if (cdraft.shift_id && targets.some(x => String(x.shift_id) === String(cdraft.shift_id))) { shiftSel.value = String(cdraft.shift_id); syncCompany() }
    else if (Number(cdraft.shift_id) > 0 && cdraft.shift_label) {
      // 一覧の期間（前日〜7日後）にない自分のシフト（打刻修正の申請から開いた場合など。#486）。送り先はサーバーがそのシフトの会社にする
      targets.push({ shift_id: Number(cdraft.shift_id), company_id: null, company_name: '' })
      const o = document.createElement('option'); o.value = String(Number(cdraft.shift_id)); o.textContent = String(cdraft.shift_label)
      shiftSel.appendChild(o); shiftSel.value = o.value; syncCompany()
    }
    if (cdraft.body) document.getElementById('c-body').value = cdraft.body
    const ur = ['low', 'normal', 'high'].includes(cdraft.urgency) && cform.querySelector(`input[name=urgency][value="${esc(cdraft.urgency)}"]`)
    if (ur) ur.checked = true
    if (cdraft.body) toast('入力途中の内容を戻しました（まだ送信していません）')
  }
  const saveConsultDraft = () => {
    const body = document.getElementById('c-body').value
    if (!body.trim()) { draftClear('consult'); return }
    const opt = shiftSel.selectedIndex > 0 ? shiftSel.options[shiftSel.selectedIndex] : null
    draftSave('consult', { category: document.getElementById('c-cat').value, shift_id: shiftSel.value, shift_label: opt ? opt.textContent : '', body,
      urgency: (cform.querySelector('input[name=urgency]:checked') || {}).value || 'normal' })
  }
  cform.addEventListener('input', saveConsultDraft)
  cform.addEventListener('change', saveConsultDraft)

  // 返信を表示したので既読にする（失敗しても表示はそのまま。次に開いたときにもう一度既読にする）
  if ((data.consultations || []).some(co => co.reply_unread)) axios.post('/api/staff/consultations/read-replies').catch(() => { })

  document.getElementById('consult-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const category = document.getElementById('c-cat').value
    const body = document.getElementById('c-body').value.trim()
    if (!category) { toast('カテゴリを選んでください'); return }
    if (!body) { toast('内容を入力してください'); return }
    const shiftId = shiftSel.value
    if (!shiftId && targets.length && CONSULT_SHIFT_REQUIRED.includes(category)) { toast('対象のシフトを選んでください'); shiftSel.focus(); return }
    const payload = { category, body, urgency: (document.querySelector('input[name=urgency]:checked') || {}).value || 'normal' }
    if (shiftId) payload.shift_id = Number(shiftId)
    else payload.company_id = companySel ? Number(companySel.value) : data.current_company_id
    const btn = document.getElementById('consult-submit')
    withSubmitLock(btn, async () => {
      btn.textContent = '送信中…'
      let res
      try { res = (await axios.post('/api/staff/consultations', payload)).data } catch (err) {
        btn.textContent = '送信する'
        consultApiError(err, '送信に失敗しました。時間をおいてもう一度お試しください')
        return
      }
      draftClear('consult')
      const to = res.company_name || coName(payload.company_id)
      // 写真は相談を登録した後に1枚ずつ送る（#429）
      const picks = CONSULT_PICKS.form.slice()
      let failed = 0
      if (picks.length) { btn.textContent = '写真を送信中…'; failed = await consultUploadPhotos(res.consultation_id, null, picks) }
      consultPicksClear('form')
      toast(failed ? `${to ? to + 'に' : ''}相談は送信しましたが、写真${failed}枚を送れませんでした。追加の連絡から送り直してください` : `${to ? to + 'に' : ''}送信しました。管理者からの返信をお待ちください`)
      renderConsult()
    })
  })
}
delegate('consultReload', () => renderConsult())

// 追加の連絡（#154）。管理者に知らせ、対応済みの相談なら未対応に戻る。写真も付けられる（#429）
delegate('consultFollowOpen', el => {
  consultPicksClear('follow')
  modal(`<h3 class="font-bold text-lg mb-3">この相談に追加で連絡する</h3>
    <form id="consult-follow-form" class="space-y-3">
      <textarea id="c-follow-body" rows="4" class="inp" maxlength="2000" placeholder="追加で伝えたいことを入力してください" required></textarea>
      ${consultPhotoInputHtml('follow')}
      <div class="flex gap-2"><button type="button" class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button type="submit" id="c-follow-submit" class="btn btn-primary flex-1" data-id="${Number(el.dataset.id)}">送信する</button></div>
    </form>`)
  document.getElementById('consult-follow-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const btn = document.getElementById('c-follow-submit')
    const body = document.getElementById('c-follow-body').value.trim()
    if (!body) { toast('内容を入力してください'); return }
    const id = Number(btn.dataset.id)
    withSubmitLock(btn, async () => {
      let res
      try { res = (await axios.post(`/api/staff/consultations/${id}/messages`, { body })).data } catch (err) {
        consultApiError(err, '送信に失敗しました。時間をおいてもう一度お試しください'); return
      }
      const picks = CONSULT_PICKS.follow.slice()
      const failed = picks.length ? await consultUploadPhotos(id, res.message_id, picks) : 0
      consultPicksClear('follow')
      closeModal()
      toast(failed ? `送信しましたが、写真${failed}枚を送れませんでした` : '送信しました。管理者に通知されます')
      renderConsult()
    })
  })
})

// 研修・マニュアル（#74）: シフトに入っている案件の『案件マニュアル・注意事項』と『求められる内容』（管理画面の案件に登録したもの）
window.renderManual = async function () {
  loading()
  let data
  try { data = (await axios.get('/api/staff/manuals')).data } catch (e) { showLoadError(e); return }
  const list = data.projects || []
  $app.innerHTML = `
    ${MORE_BACK}
    <h2 class="font-bold text-gray-800 mb-1 px-1"><i class="fas fa-book-open text-blue-600 mr-1"></i>研修・マニュアル</h2>
    <p class="text-xs text-gray-500 mb-3 px-1">シフトに入っている案件（直近30日と今後）のマニュアル・注意事項です</p>
    <div class="space-y-2" id="manual-list">
      ${list.map((m, i) => {
        const has = m.manual_text || m.requirements
        return `<details class="card p-4" ${i === 0 && has ? 'open' : ''}>
          <summary class="flex items-center gap-3 cursor-pointer list-none">
            <span class="w-10 h-10 rounded-lg ${has ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-400'} flex items-center justify-center shrink-0"><i class="fas fa-file-lines"></i></span>
            <span class="flex-1 min-w-0">
              <span class="block font-bold text-sm text-gray-800">${esc(m.project_name)}${m.other_company ? ` <span class="badge badge-purple">${esc(m.company_name)}</span>` : ''}</span>
              <span class="block text-xs text-gray-400">${m.next_date ? '次の稼働 ' + esc(fmtDate(m.next_date)) : '最後の稼働 ' + esc(fmtDate(m.last_date))}${has ? '' : '・マニュアルは登録されていません'}</span>
            </span>
            <i class="fas fa-chevron-down text-gray-300"></i>
          </summary>
          ${m.requirements ? `<div class="mt-3"><p class="text-xs font-bold text-gray-500 mb-1">求められる内容</p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${linkify(esc(m.requirements))}</p></div>` : ''}
          ${m.manual_text ? `<div class="mt-3"><p class="text-xs font-bold text-gray-500 mb-1">案件マニュアル・注意事項</p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${linkify(esc(m.manual_text))}</p></div>` : ''}
          ${has ? '' : '<p class="text-xs text-gray-400 mt-3">この案件のマニュアルはまだ登録されていません。分からないことは相談・連絡から管理者に確認してください</p>'}
        </details>`
      }).join('') || '<p class="text-center text-gray-400 py-10">表示できるマニュアルはありません（シフトに入っている案件のマニュアルが表示されます）</p>'}
    </div>`
}

// ============ ルーティング ============
// #shift/YYYY-MM-DD は、その日から表示する（シフトの変更の通知から開く。#155）
const routes = { home: renderHome, shift: () => renderShifts(location.hash.split('/')[1]), report: renderReportWithHistory, perf: () => renderPerf(), more: renderMore,
  attendance: () => (window.renderStaffAttendance ? renderStaffAttendance() : renderHome()),
  notifications: () => (window.renderStaffNotifications ? renderStaffNotifications() : renderHome()),
  notices: () => { const id = Number((location.hash.split('/')[1]) || 0); return id ? renderNoticeDetail(id) : renderNotices() },
  // 相談・連絡（ホームの返信バナー・メニューから開く。#320）と研修・マニュアル。マイプロフィール・パスワードの変更は staff-profile.js が足す
  consult: () => renderConsult(), manual: () => renderManual() }
const titles = { home: 'ホーム', shift: 'シフト', report: '日報入力', perf: '実績', more: 'その他', attendance: '打刻履歴・修正申請', notifications: '通知', notices: 'お知らせ',
  consult: '相談・連絡', manual: '研修・マニュアル', profile: 'マイプロフィール', password: 'パスワードの変更' }
// 『その他』の中の画面（下のタブは『その他』を選んだ表示にする）
const MORE_SUB_TABS = ['attendance', 'notifications', 'notices', 'consult', 'manual', 'profile', 'password']

// 画面を描く。読み込みに失敗したら、読み込み中のまま止めずに再読み込みのボタンを出す（#182）。描き終わるまで待てる Promise を返す
let LAST_TAB = null
function route() {
  const tab = (location.hash || '#home').slice(1).split('/')[0]
  const fn = routes[tab] || renderHome
  // 打刻履歴の画面のタブと期間は、画面を離れたら初期に戻す（次に開くと今日までの打刻履歴になる #400）。
  // 開く直前に通知などが決めたタブ（修正申請）は、離れるまで保つ
  if (LAST_TAB === 'attendance' && tab !== 'attendance' && window.__attState) { window.__attState.tab = 'timeline'; window.__attState.to = null }
  LAST_TAB = tab
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === (MORE_SUB_TABS.includes(tab) ? 'more' : tab)))
  document.getElementById('header-title').textContent = titles[tab] || 'ホーム'
  refreshBadges()
  return Promise.resolve().then(fn).catch(showLoadError)
}

window.addEventListener('hashchange', route)
// 今の画面と同じ下のタブを押したら、描き直す（hash が変わらないと hashchange が起きないため。#374）
document.addEventListener('click', (ev) => {
  const a = ev.target && ev.target.closest ? ev.target.closest('a.nav-item, a[href="#more"]') : null
  if (!a || a.getAttribute('href') !== (location.hash || '#home')) return
  ev.preventDefault()
  route()
})

// ---------- スタッフあての通知の行き先（#155 #151 #156 #158） ----------
// 通知の一覧（staff-attendance.js の notifOpenStaff）を開いたとき、シフト・募集・日報コメントの通知だけは、ここで行き先を決める。
// それ以外の通知（打刻修正・お知らせ・相談）は元の処理に渡す。staff-attendance.js は staff.js の後に読み込むので、読み込みが済んでから差し替える
const STAFF_NOTIFY_KINDS = ['shift_assigned', 'shift_changed', 'shift_cancelled', 'recruit_result', 'recruit_new', 'daily_report_comment']
function openStaffNotification(n) {
  const go = (hash) => { if ((location.hash || '').slice(1) === hash) route(); else location.hash = hash }
  if (n.kind === 'daily_report_comment') { OPEN_PAST_REPORT_ID = Number(n.related_id) || null; return go('report') }
  const link = String(n.link || '')
  go(/^#shift(\/\d{4}-\d{2}-\d{2})?$/.test(link) ? link.slice(1) : 'shift')
}
document.addEventListener('DOMContentLoaded', () => {
  const orig = window.notifOpenStaff
  if (typeof orig !== 'function') return
  window.notifOpenStaff = async function (id) {
    let n = null
    // 一覧の中身は staff-attendance.js が持っているので、その1件だけを取り直す（before は「この ID より前」）
    try { n = ((await axios.get('/api/staff/notifications', { params: { before: Number(id) + 1, limit: 1 } })).data.notifications || [])[0] } catch (e) { }
    if (!n || n.notification_id !== Number(id) || !STAFF_NOTIFY_KINDS.includes(n.kind)) return orig(id)
    try { await axios.post(`/api/staff/notifications/${Number(id)}/read`) } catch (e) { }
    openStaffNotification(n)
  }
})
// ============ 出勤可能日の提出（#171 #availability）と、シフトのカレンダー追加（#301 #calendar） ============
// どちらもシフト画面のボタンから開く。API は src/staff-schedule.ts
routes.availability = () => renderAvailability()
routes.calendar = () => renderShiftCalendar()
titles.availability = '出勤可能日の提出'
titles.calendar = 'カレンダーに追加'
const SCHEDULE_BACK = '<a href="#shift" class="text-sm text-blue-600 mb-3 inline-block"><i class="fas fa-chevron-left mr-1"></i>シフトへ戻る</a>'
const AV_MARK = { ok: '○', partial: '△', ng: '×' }
const AV_CELL = { ok: 'bg-emerald-50 border-emerald-300 text-emerald-700', partial: 'bg-amber-50 border-amber-300 text-amber-700', ng: 'bg-gray-100 border-gray-300 text-gray-500' }
const AV_TOOLS = [['ok', '○ 終日OK'], ['partial', '△ 時間帯'], ['ng', '× 不可'], ['clear', '消す'], ['note', 'メモ']]
const AV_WEEK = ['日', '月', '火', '水', '木', '金', '土']
// AV: 表示中の月の入力。days は日付 → { status, start_time, end_time, note }。tool は日付を押したときに付けるもの
let AV = null
const avMonthLabel = (m) => `${Number(String(m).slice(0, 4))}年${Number(String(m).slice(5, 7))}月`
const avFmtAt = (at) => at ? dayjs(String(at).replace(' ', 'T')).format('M/D HH:mm') : ''
const avEditable = (d) => !!(AV && AV.data.editable && d >= AV.data.editable_from)

async function renderAvailability(month) {
  const hashMonth = (location.hash.split('/')[1] || '')
  month = month || (/^\d{4}-\d{2}$/.test(hashMonth) ? hashMonth : '')
  loading()
  let data
  try { data = (await axios.get('/api/staff/availability', { params: month ? { month } : {} })).data } catch (e) { showLoadError(e); return }
  if ((location.hash || '').slice(1).split('/')[0] !== 'availability') return
  const days = {}
  for (const d of data.days || []) days[d.work_date] = { status: d.status, start_time: d.start_time, end_time: d.end_time, note: d.note }
  AV = { data, month: data.month, days, tool: (AV && AV.tool) || 'ok', st: (AV && AV.st) || '10:00', et: (AV && AV.et) || '19:00', dirty: false }
  drawAvailability()
}

function drawAvailability() {
  const d = AV.data
  const overdue = !d.submitted_at && d.deadline && d.today > d.deadline
  const status = d.submitted_at
    ? `<span class="badge badge-green">提出済み</span><span class="text-xs text-gray-500">${esc(avFmtAt(d.updated_at || d.submitted_at))}${d.late ? '（締切後に提出）' : ''}</span>`
    : '<span class="badge badge-yellow">未提出</span>'
  $app.innerHTML = `
    ${SCHEDULE_BACK}
    <div class="flex gap-1.5 mb-3 overflow-x-auto">${d.months.map(m => `<button class="btn ${m === AV.month ? 'btn-primary' : 'btn-outline'} text-xs shrink-0" data-action="avMonth" data-month="${esc(m)}">${esc(avMonthLabel(m))}</button>`).join('')}</div>
    <section class="card p-4 mb-3">
      <div class="flex items-center gap-2 flex-wrap"><h2 class="font-bold text-gray-800">${esc(avMonthLabel(AV.month))}の出勤可能日</h2>${status}</div>
      ${d.deadline ? `<p class="text-sm mt-1 ${overdue ? 'text-red-600 font-bold' : 'text-gray-600'}"><i class="far fa-clock mr-1"></i>締切: ${esc(fmtDate(d.deadline))}${overdue ? '（締切を過ぎています。できるだけ早く提出してください）' : ''}</p>` : ''}
      ${d.note ? `<p class="text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-2 mt-2 whitespace-pre-wrap">${linkify(esc(d.note))}</p>` : ''}
      <p class="text-xs text-gray-500 mt-2">シフトの希望は、ここで出してください（○ 終日入れる・△ 入れる時間帯・× 入れない）。管理者がこれを見てシフトを組みます</p>
      <p class="text-xs text-gray-400 mt-1">下の記号を選んでから日付を押すと付きます。提出した後も出し直せます。シフトの確定は管理者が行います</p>
    </section>
    ${d.editable ? `<section class="card p-3 mb-3">
      <div class="grid grid-cols-5 gap-1">${AV_TOOLS.map(([k, l]) => `<button class="btn ${AV.tool === k ? 'btn-primary' : 'btn-outline'} text-xs px-1" data-action="avTool" data-tool="${k}">${l}</button>`).join('')}</div>
      <div id="av-time" class="${AV.tool === 'partial' ? '' : 'hidden'} flex items-center gap-2 mt-2 text-sm">
        <span class="text-gray-500 text-xs">△の時間帯</span><input type="time" id="av-st" class="inp py-1 w-28" value="${esc(AV.st)}"><span>〜</span><input type="time" id="av-et" class="inp py-1 w-28" value="${esc(AV.et)}">
      </div>
      <div class="flex gap-3 flex-wrap mt-2 text-xs">
        <button class="text-blue-600 underline" data-action="avFill" data-fill="ok">未入力の日をすべて○</button>
        <button class="text-blue-600 underline" data-action="avFill" data-fill="weekend">土日を×</button>
        <button class="text-gray-500 underline" data-action="avFill" data-fill="clear">すべて消す</button>
      </div>
    </section>` : '<p class="text-sm text-gray-500 mb-3">この月は提出の受付が終わっています（表示のみ）</p>'}
    <div id="av-grid">${avGridHtml()}</div>
    <p id="av-summary" class="text-xs text-gray-500 text-center my-3">${esc(avSummaryText())}</p>
    ${d.editable ? `<button class="btn btn-primary w-full mb-6" data-action="avSubmit"><i class="fas fa-paper-plane"></i>${d.submitted_at ? '出し直す' : '提出する'}</button>` : ''}`
  const st = document.getElementById('av-st'), et = document.getElementById('av-et')
  if (st) st.addEventListener('change', () => { AV.st = st.value })
  if (et) et.addEventListener('change', () => { AV.et = et.value })
}

// 月のカレンダー（日曜はじまり）。過ぎた日は押せない。シフトの入っている日は印を出す
function avGridHtml() {
  const first = dayjs(AV.month + '-01')
  const n = first.daysInMonth()
  const shiftsOf = {}
  for (const s of AV.data.shifts || []) (shiftsOf[s.work_date] = shiftsOf[s.work_date] || []).push(s)
  const cells = []
  for (let i = 0; i < first.day(); i++) cells.push('<div></div>')
  for (let i = 1; i <= n; i++) {
    const day = first.date(i), date = day.format('YYYY-MM-DD'), wd = day.day()
    const v = AV.days[date]
    const sh = shiftsOf[date] || []
    const can = avEditable(date)
    cells.push(`<button type="button" class="border rounded-lg min-h-[3.6rem] p-1 flex flex-col items-center ${v ? AV_CELL[v.status] : 'bg-white border-gray-200'} ${can ? '' : 'opacity-50'}"
        data-action="avDay" data-date="${esc(date)}" ${can ? '' : 'disabled'} aria-label="${esc(fmtDate(date))}">
      <span class="text-[11px] self-start ${wd === 0 ? 'text-red-500' : wd === 6 ? 'text-blue-500' : 'text-gray-500'}">${i}</span>
      <span class="text-base font-bold leading-none">${v ? AV_MARK[v.status] : ''}</span>
      ${v && v.status === 'partial' ? `<span class="text-[9px] leading-tight">${esc(String(v.start_time).slice(0, 5))}-${esc(String(v.end_time).slice(0, 5))}</span>` : ''}
      ${v && v.note ? '<span class="text-[9px] leading-tight"><i class="fas fa-note-sticky"></i></span>' : ''}
      ${sh.length ? `<span class="text-[9px] leading-tight text-blue-600 font-bold">${sh.some(s => s.status !== 'requested') ? 'シフト' : '仮'}</span>` : ''}
    </button>`)
  }
  return `<div class="grid grid-cols-7 gap-1 text-center text-[11px] text-gray-500 mb-1">${AV_WEEK.map(w => `<div>${w}</div>`).join('')}</div>
    <div class="grid grid-cols-7 gap-1">${cells.join('')}</div>
    <p class="text-[11px] text-gray-400 mt-2"><span class="text-blue-600 font-bold">シフト</span>: すでに入っているシフト（<span class="text-blue-600 font-bold">仮</span>は確定前）。<i class="fas fa-note-sticky"></i>: メモあり</p>`
}
function avSummaryText() {
  const c = { ok: 0, partial: 0, ng: 0 }
  for (const v of Object.values(AV.days)) c[v.status] = (c[v.status] || 0) + 1
  const n = dayjs(AV.month + '-01').daysInMonth()
  return `○ ${c.ok}日・△ ${c.partial}日・× ${c.ng}日・未入力 ${n - c.ok - c.partial - c.ng}日`
}
function avRedraw() {
  const g = document.getElementById('av-grid'); if (g) g.innerHTML = avGridHtml()
  const s = document.getElementById('av-summary'); if (s) s.textContent = avSummaryText()
}
function avPartialTimes() {
  const st = (document.getElementById('av-st') || {}).value || AV.st, et = (document.getElementById('av-et') || {}).value || AV.et
  if (!st || !et) { toast('△の時間帯の開始と終了を入力してください'); return null }
  if (st === et) { toast('△の時間帯の開始と終了が同じです'); return null }
  AV.st = st; AV.et = et
  return { start_time: st, end_time: et }
}

delegate('avMonth', (el) => {
  if (AV && AV.dirty && !confirm('提出していない変更があります。破棄してほかの月を開きますか？')) return
  if (AV) AV.dirty = false
  history.replaceState(null, '', '#availability/' + el.dataset.month)
  renderAvailability(el.dataset.month)
})
delegate('avTool', (el) => {
  AV.tool = el.dataset.tool
  document.querySelectorAll('[data-action="avTool"]').forEach(b => { b.classList.toggle('btn-primary', b.dataset.tool === AV.tool); b.classList.toggle('btn-outline', b.dataset.tool !== AV.tool) })
  const t = document.getElementById('av-time'); if (t) t.classList.toggle('hidden', AV.tool !== 'partial')
})
delegate('avDay', (el) => {
  const date = el.dataset.date
  if (!avEditable(date)) return
  const cur = AV.days[date]
  if (AV.tool === 'clear') delete AV.days[date]
  else if (AV.tool === 'note') {
    if (!cur) { toast('先に ○△× を付けてからメモを入れてください'); return }
    const note = prompt(`${fmtDate(date)} のメモ（100文字まで。空欄で消す）`, cur.note || '')
    if (note === null) return
    cur.note = note.trim().slice(0, 100) || null
  } else if (AV.tool === 'partial') {
    const t = avPartialTimes(); if (!t) return
    AV.days[date] = { status: 'partial', ...t, note: cur ? cur.note : null }
  } else AV.days[date] = { status: AV.tool, start_time: null, end_time: null, note: cur ? cur.note : null }
  AV.dirty = true
  avRedraw()
})
delegate('avFill', (el) => {
  const first = dayjs(AV.month + '-01')
  for (let i = 1; i <= first.daysInMonth(); i++) {
    const day = first.date(i), date = day.format('YYYY-MM-DD')
    if (!avEditable(date)) continue
    if (el.dataset.fill === 'clear') delete AV.days[date]
    else if (el.dataset.fill === 'ok' && !AV.days[date]) AV.days[date] = { status: 'ok', start_time: null, end_time: null, note: null }
    else if (el.dataset.fill === 'weekend' && (day.day() === 0 || day.day() === 6)) AV.days[date] = { status: 'ng', start_time: null, end_time: null, note: AV.days[date] ? AV.days[date].note : null }
  }
  AV.dirty = true
  avRedraw()
})
delegate('avSubmit', (el) => withSubmitLock(el, async () => {
  const days = Object.keys(AV.days).filter(avEditable).sort().map(date => ({ date, ...AV.days[date] }))
  if (!days.length) { toast('1日以上、○△×を付けてください'); return }
  let r
  try { r = (await axios.put('/api/staff/availability', { month: AV.month, days })).data } catch (e) { showApiError(e, '提出できませんでした。電波の良い場所で再度お試しください'); return }
  AV.dirty = false
  toast(`${avMonthLabel(AV.month)}の出勤可能日を提出しました${r.late ? '（締切後の提出です）' : ''}`)
  renderAvailability(AV.month)
}))

// シフト画面の案内: 翌月の出勤可能日が未提出なら知らせる
async function availabilityBanner() {
  if (!document.getElementById('av-banner')) return
  let d
  try { d = (await axios.get('/api/staff/availability/summary')).data } catch (e) { return }
  const box = document.getElementById('av-banner')
  if (!box || !d.month || d.submitted) return
  box.innerHTML = `<a href="#availability/${esc(d.month)}" class="block bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3 text-sm text-amber-800">
    <i class="fas fa-calendar-check mr-1"></i>${esc(avMonthLabel(d.month))}の出勤可能日がまだ提出されていません${d.deadline ? `（締切 ${esc(fmtDate(d.deadline))}）` : ''}
    <span class="underline font-bold ml-1">提出する</span></a>`
}

// ---------- カレンダーに追加（#301） ----------
const CAL_WORKING = ['confirmed', 'substitute']
// Google カレンダーの予定の作成画面（1件）。時刻は日本時間で渡す
function googleCalendarUrl(s) {
  const st = String(s.start_time).slice(0, 5), et = String(s.end_time).slice(0, 5)
  const start = dayjs(`${s.work_date}T${st}`)
  let end = dayjs(`${s.work_date}T${et}`)
  if (et <= st) end = end.add(1, 'day')
  const f = (x) => x.format('YYYYMMDDTHHmmss')
  const place = s.site_name || s.location || ''
  const brk = shiftBreakMinutes(s)
  const details = [s.other_company ? `会社: ${s.company_name}` : '', `時間: ${formatShiftTime(s.start_time, s.end_time)}${brk ? `（休憩 ${brk}分）` : ''}`,
    s.role ? `役割: ${s.role}` : '', s.slot_memo ? `メモ: ${s.slot_memo}` : '', `シフトの確認・報告: ${location.origin}/staff#shift`].filter(Boolean).join('\n')
  const q = new URLSearchParams({ action: 'TEMPLATE', text: s.project_name + (s.other_company ? `（${s.company_name}）` : ''), dates: `${f(start)}/${f(end)}`, ctz: 'Asia/Tokyo', details, location: [place, s.site_address].filter(Boolean).join(' ') })
  return 'https://calendar.google.com/calendar/render?' + q.toString()
}
let CAL_URL = null // 発行した直後の購読 URL（サーバーはハッシュしか持たないため、この画面を離れると表示できない）
async function renderShiftCalendar() {
  loading()
  const today = dayjs().format('YYYY-MM-DD')
  let tk, sh
  try {
    [tk, sh] = await Promise.all([axios.get('/api/staff/calendar-token'), axios.get('/api/staff/shifts', { params: { from: today, to: dayjs().add(41, 'day').format('YYYY-MM-DD') } })])
  } catch (e) { showLoadError(e); return }
  if ((location.hash || '').slice(1).split('/')[0] !== 'calendar') return
  const t = tk.data
  const shifts = (sh.data.shifts || []).filter(s => CAL_WORKING.includes(s.status))
  const webcal = CAL_URL ? CAL_URL.replace(/^https?:/, 'webcal:') : ''
  $app.innerHTML = `
    ${SCHEDULE_BACK}
    <section class="card p-4 mb-4">
      <h2 class="font-bold text-gray-800 mb-1"><i class="fas fa-rotate text-blue-600 mr-1"></i>カレンダーで購読する（おすすめ）</h2>
      <p class="text-xs text-gray-500">確定したシフトが、スマホのカレンダー（iPhone・Google カレンダーなど）に自動で入ります。時間の変更や欠勤・取り消しも反映されます（反映まで数時間かかることがあります）。金額は入りません。</p>
      ${CAL_URL ? `
        <div class="mt-3 rounded-lg bg-blue-50 p-3">
          <p class="text-xs text-blue-800 font-bold mb-1">購読用の URL を発行しました。この画面を離れると再表示できません</p>
          <div class="flex gap-1"><input id="cal-url" class="inp text-xs flex-1" readonly value="${esc(CAL_URL)}"><button class="btn btn-outline text-xs" data-action="calCopy"><i class="fas fa-copy"></i>コピー</button></div>
          <div class="grid grid-cols-2 gap-2 mt-2">
            <a class="btn btn-primary text-xs" href="${esc(webcal)}"><i class="fab fa-apple"></i>iPhone のカレンダーに登録</a>
            <a class="btn btn-outline text-xs" href="${esc('https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal))}" target="_blank" rel="noopener noreferrer"><i class="fab fa-google"></i>Google カレンダーに登録</a>
          </div>
          <p class="text-[11px] text-gray-500 mt-2">URL を知っている人は、あなたのシフト（日時・場所）を見られます。ほかの人に教えないでください</p>
        </div>` : t.active
        ? `<p class="text-sm text-gray-700 mt-3"><span class="badge badge-green">購読中</span> <span class="text-xs text-gray-500">発行 ${esc(avFmtAt(t.created_at))}${t.last_accessed_at ? `・最後の読み込み ${esc(avFmtAt(t.last_accessed_at))}` : '・まだ読み込まれていません'}</span></p>
           <p class="text-[11px] text-gray-500 mt-1">別の端末で登録するときや URL が分からなくなったときは、発行し直してください（前の URL は使えなくなります）</p>`
        : ''}
      <div class="flex gap-2 mt-3">
        <button class="btn ${t.active ? 'btn-outline' : 'btn-primary'} flex-1 text-sm" data-action="calIssue" data-reissue="${t.active ? '1' : ''}"><i class="fas fa-link"></i>${t.active ? 'URL を発行し直す' : '購読用の URL を発行する'}</button>
        ${t.active ? '<button class="btn btn-outline text-sm text-red-600" data-action="calRevoke">購読を止める</button>' : ''}
      </div>
    </section>
    <section class="card p-4 mb-6">
      <h2 class="font-bold text-gray-800 mb-1"><i class="fas fa-calendar-plus text-blue-600 mr-1"></i>1件ずつ追加する</h2>
      <p class="text-xs text-gray-500 mb-2">今日から6週間の確定したシフトです。1件ずつ追加した予定は、シフトが変わっても自動では変わりません</p>
      <div class="divide-y divide-gray-100">${shifts.map(s => `
        <div class="py-2.5">
          <p class="text-sm font-medium text-gray-800">${esc(fmtDate(s.work_date))} ${esc(formatShiftTime(s.start_time, s.end_time))} ${s.status === 'substitute' ? '<span class="badge badge-purple">代打</span>' : ''}</p>
          <p class="text-xs text-gray-500">${esc(s.project_name)}${s.other_company ? `（${esc(s.company_name)}）` : ''}${s.site_name || s.location ? '・' + esc(s.site_name || s.location) : ''}</p>
          <div class="flex gap-2 mt-1.5">
            <a class="btn btn-outline text-xs" href="/api/staff/shifts/${Number(s.shift_id)}/ics" download><i class="fas fa-file-arrow-down"></i>iPhone など（.ics）</a>
            <a class="btn btn-outline text-xs" href="${esc(googleCalendarUrl(s))}" target="_blank" rel="noopener noreferrer"><i class="fab fa-google"></i>Google カレンダー</a>
          </div>
        </div>`).join('') || '<p class="text-center text-gray-400 py-6 text-sm">この期間の確定したシフトはありません</p>'}</div>
    </section>`
}
delegate('calIssue', (el) => {
  if (el.dataset.reissue && !confirm('URL を発行し直します。今の URL で登録したカレンダーには、シフトが入らなくなります。よろしいですか？')) return
  withSubmitLock(el, async () => {
    try { CAL_URL = (await axios.post('/api/staff/calendar-token')).data.url } catch (e) { showApiError(e, '発行できませんでした'); return }
    toast('購読用の URL を発行しました')
    await renderShiftCalendar()
  })
})
delegate('calRevoke', (el) => {
  if (!confirm('購読を止めます。登録したカレンダーには、シフトが入らなくなります。よろしいですか？')) return
  withSubmitLock(el, async () => {
    try { await axios.delete('/api/staff/calendar-token') } catch (e) { showApiError(e, '止められませんでした'); return }
    CAL_URL = null
    toast('購読を止めました')
    await renderShiftCalendar()
  })
})
delegate('calCopy', async () => {
  const el = document.getElementById('cal-url'); if (!el) return
  try { await navigator.clipboard.writeText(el.value) } catch { el.select(); document.execCommand && document.execCommand('copy') }
  toast('URL をコピーしました')
})
// 画面を離れたら、発行した URL の表示を消す
window.addEventListener('hashchange', () => { if ((location.hash || '').slice(1).split('/')[0] !== 'calendar') CAL_URL = null })

// ---------- 未読の印（下のタブの『その他』・メニュー・ホームの案内。#383） ----------
// 画面を切り替えるたびに件数だけを取り直す（同時に1本だけ）。取れなかったときは前の表示のままにする
let BADGES = null
let BADGES_LOADING = null
function refreshBadges() {
  if (!ME || BADGES_LOADING) return BADGES_LOADING
  BADGES_LOADING = axios.get('/api/staff/badges').then(r => { BADGES = r.data; applyBadges() }).catch(() => { }).finally(() => { BADGES_LOADING = null })
  return BADGES_LOADING
}
function applyBadges() {
  if (!BADGES) return
  const set = (id, n) => { const el = document.getElementById(id); if (el) { el.textContent = n > 99 ? '99+' : String(n); el.classList.toggle('hidden', !n) } }
  const notices = Number(BADGES.notices) || 0, notifs = Number(BADGES.notifications) || 0
  set('nav-more-badge', notices + notifs)
  set('more-notice-count', notices)
  set('more-notif-count', notifs)
  const nav = document.getElementById('nav-more-badge')
  if (nav) nav.setAttribute('aria-label', `未読のお知らせ ${notices}件・通知 ${notifs}件`)
  const banner = document.getElementById('home-unread-banner')
  if (banner) banner.innerHTML = homeUnreadBannerInner(notices, notifs, Number(BADGES.notices_other) || 0)
}

// ============ 通知の設定（プッシュ通知 #178・受け取り設定 #284）。『その他』の #notify-settings ============
// プッシュ通知: この端末（ブラウザ）で受け取るかを選ぶ。Service Worker（/sw.js）は、プッシュを受けたら最新の未読を取りに来て表示する。
// 受け取り設定: 通知のまとまりごとに、プッシュとメールの ON/OFF（アプリ内の通知は必ず届く）。同じ人のすべての会社に同じ設定を保存する
routes['notify-settings'] = () => renderNotifySettings()
titles['notify-settings'] = '通知の設定'
MORE_SUB_TABS.push('notify-settings')
const PUSH_SUPPORTED = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const PUSH_SCOPE = '/staff'
function b64urlToBytes(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - t.length % 4) % 4))
  return Uint8Array.from(bin, ch => ch.charCodeAt(0))
}
function bytesToB64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function currentPushSubscription() {
  if (!PUSH_SUPPORTED) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration(PUSH_SCOPE)
    return reg ? await reg.pushManager.getSubscription() : null
  } catch (e) { return null }
}
async function renderNotifySettings() {
  loading()
  const sub = await currentPushSubscription()
  const [cfg, prefs] = await Promise.all([
    axios.get('/api/staff/push/config', { params: sub ? { endpoint: sub.endpoint } : {} }).then(r => r.data),
    axios.get('/api/staff/notification-prefs').then(r => r.data),
  ])
  if (location.hash.slice(1).split('/')[0] !== 'notify-settings') return // 読み込み中にほかの画面へ移った
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true
  const note = (cls, icon, text) => `<p class="text-sm ${cls} rounded-lg px-3 py-2"><i class="fas ${icon} mr-1"></i>${text}</p>`
  let pushBox
  if (!PUSH_SUPPORTED) {
    pushBox = note('text-gray-600 bg-gray-50', 'fa-circle-info', ios && !standalone
      ? 'iPhone・iPad では、Safari の共有ボタンから「ホーム画面に追加」したアプリで開くと、プッシュ通知を受け取れます（iOS 16.4 以降）。'
      : 'このブラウザはプッシュ通知に対応していません。通知はアプリを開いたときに「通知」で確認できます。')
  } else if (!cfg.available) {
    pushBox = note('text-amber-800 bg-amber-50', 'fa-triangle-exclamation', esc(cfg.error || 'プッシュ通知の準備ができていません'))
  } else if (Notification.permission === 'denied') {
    pushBox = note('text-red-700 bg-red-50', 'fa-ban', '通知がブロックされています。端末の設定（またはブラウザのサイトの設定）で、このアプリの通知を許可してから開き直してください。')
  } else if (sub && cfg.subscribed) {
    pushBox = `${note('text-green-700 bg-green-50', 'fa-circle-check', 'この端末でプッシュ通知を受け取ります')}
      ${cfg.last_error ? `<p class="text-xs text-amber-700 mt-1">前回の送信に失敗しました（${esc(cfg.last_error)}）。届かないときは「受け取らない」にしてから、もう一度「受け取る」を押してください</p>` : ''}
      <div class="flex gap-2 mt-2">
        <button class="btn btn-outline flex-1 text-sm" data-action="pushTest"><i class="fas fa-paper-plane"></i>テスト通知を送る</button>
        <button class="btn btn-outline flex-1 text-sm" data-action="pushDisable"><i class="fas fa-bell-slash"></i>受け取らない</button>
      </div>`
  } else {
    pushBox = `<p class="text-xs text-gray-500 mb-2">シフトの変更・リマインド・申請の結果などを、アプリを開いていなくても端末の通知で知らせます。${cfg.devices ? `（ほかの端末 ${Number(cfg.devices)}台で受け取り中）` : ''}</p>
      <button class="btn btn-primary w-full" data-action="pushEnable"><i class="fas fa-bell"></i>この端末でプッシュ通知を受け取る</button>`
  }
  const groups = prefs.groups || []
  const toggle = (g, field, label) => `<label class="flex items-center gap-1 text-xs text-gray-600 whitespace-nowrap">
      <input type="checkbox" class="w-5 h-5 rounded notify-pref" data-key="${esc(g.key)}" data-field="${field}" ${g[field] ? 'checked' : ''}>${label}</label>`
  $app.innerHTML = `
    ${MORE_BACK}
    <section class="card p-4 mb-3">
      <h2 class="font-bold text-gray-800 mb-2"><i class="fas fa-mobile-screen text-blue-600 mr-1"></i>プッシュ通知（この端末）</h2>
      ${pushBox}
    </section>
    <section class="card p-4">
      <h2 class="font-bold text-gray-800 mb-1"><i class="fas fa-sliders text-blue-600 mr-1"></i>受け取る通知</h2>
      <p class="text-xs text-gray-500 mb-3">アプリ内の「通知」には、設定によらずすべて届きます。${prefs.has_email ? '' : 'メールアドレスが登録されていないため、メールは届きません。'}</p>
      <div class="divide-y divide-gray-100">${groups.map(g => `
        <div class="py-2.5 flex items-start gap-3">
          <div class="flex-1 min-w-0"><p class="text-sm font-bold text-gray-800">${esc(g.label)}</p><p class="text-[11px] text-gray-400">${esc(g.desc)}</p></div>
          <div class="flex flex-col gap-1.5">${g.push_supported ? toggle(g, 'push', 'プッシュ') : ''}${g.email_supported && prefs.has_email ? toggle(g, 'email', 'メール') : ''}</div>
        </div>`).join('')}</div>
      <button class="btn btn-primary w-full mt-3" data-action="notifyPrefsSave"><i class="fas fa-check"></i>保存する</button>
    </section>`
}
delegate('pushEnable', (el) => withSubmitLock(el, async () => {
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') { toast('通知が許可されませんでした。端末の設定で許可できます', 4000); return renderNotifySettings() }
    await navigator.serviceWorker.register('/sw.js', { scope: PUSH_SCOPE })
    const reg = await navigator.serviceWorker.ready
    const cfg = (await axios.get('/api/staff/push/config')).data
    if (!cfg.available) { toast(cfg.error || 'プッシュ通知の準備ができていません'); return }
    let sub = await reg.pushManager.getSubscription()
    // サーバーの鍵が変わっていたら購読し直す
    const key = sub && sub.options && sub.options.applicationServerKey
    if (sub && key && bytesToB64url(key) !== cfg.public_key) { await sub.unsubscribe(); sub = null }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(cfg.public_key) })
    const j = sub.toJSON()
    await axios.post('/api/staff/push/subscribe', { endpoint: j.endpoint, keys: j.keys })
    toast('この端末でプッシュ通知を受け取ります')
  } catch (e) {
    if (e && e.isAxiosError) showApiError(e, '登録できませんでした')
    else toast('この端末ではプッシュ通知を登録できませんでした', 4000)
  }
  renderNotifySettings()
}))
delegate('pushDisable', (el) => withSubmitLock(el, async () => {
  const sub = await currentPushSubscription()
  if (sub) {
    try { await axios.post('/api/staff/push/unsubscribe', { endpoint: sub.endpoint }) } catch (e) { showApiError(e, '解除できませんでした'); return }
    try { await sub.unsubscribe() } catch (e) { }
  }
  toast('この端末ではプッシュ通知を受け取りません')
  renderNotifySettings()
}))
delegate('pushTest', (el) => withSubmitLock(el, async () => {
  const sub = await currentPushSubscription()
  if (!sub) return renderNotifySettings()
  try { await axios.post('/api/staff/push/test', { endpoint: sub.endpoint }); toast('テスト通知を送りました。数秒で届きます') } catch (e) { showApiError(e, 'テスト通知を送れませんでした'); renderNotifySettings() }
}))
delegate('notifyPrefsSave', (el) => withSubmitLock(el, async () => {
  const prefs = {}
  document.querySelectorAll('.notify-pref').forEach(cb => { (prefs[cb.dataset.key] = prefs[cb.dataset.key] || {})[cb.dataset.field] = cb.checked })
  try { await axios.put('/api/staff/notification-prefs', { prefs }); toast('保存しました') } catch (e) { showApiError(e, '保存できませんでした') }
}))
// 通知を押したときに、開いているスタッフ画面を通知の行き先へ移す（Service Worker からの知らせ。#178）
if (PUSH_SUPPORTED) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data || {}
    if (d.type === 'fos-open' && /^#[A-Za-z0-9_\-/=&.]{1,200}$/.test(String(d.hash || ''))) location.hash = String(d.hash).slice(1)
  })
}

// 起動: ログインを確かめてから画面を描く。401 以外の失敗（電波が弱いなど）では、白い画面のままにせず再試行を出す（#465）
async function boot() {
  loading()
  try {
    ME = (await axios.get('/api/auth/me')).data
  } catch (e) { showLoadError(e); return }
  document.getElementById('user-name').textContent = ME.name
  return route()
}
boot()
