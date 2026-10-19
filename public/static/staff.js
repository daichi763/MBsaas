// Field OS スタッフ用SPA
const $app = document.getElementById('app')
let ME = null
let HOME = null

const REPORT_LABELS = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
const REPORT_ICONS = { wake_up: 'fa-sun', departure: 'fa-person-walking-luggage', check_in: 'fa-store', work_start: 'fa-briefcase', break_start: 'fa-mug-hot', break_end: 'fa-person-walking', work_end: 'fa-flag-checkered', check_out: 'fa-door-open' }
// 写真添付が必須の報告種別
const PHOTO_REQUIRED_TYPES = ['check_in', 'check_out']
const PHOTO_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 選択可能な元画像の上限 (10MB)
const PHOTO_TARGET_BYTES = 500 * 1024           // 圧縮後の目標上限 (500KB)
const PHOTO_MAX_EDGE = 1600                     // 長辺の最大px
let pendingPhoto = { blob: null, previewUrl: null, type: null, shiftId: null }
const CAT_LABELS = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }

function toast(msg) {
  let root = document.getElementById('toast')
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
  const el = document.createElement('div')
  el.className = 'toast-msg'; el.textContent = msg
  root.appendChild(el)
  setTimeout(() => el.remove(), 2500)
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

// ログアウト: 通信に失敗してもログイン画面へ移る（#465）
document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await axios.post('/api/auth/logout') } catch (e) { /* 移動を優先する */ } finally { location.href = '/login' }
})

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

async function renderHome() {
  loading()
  let data
  // 通信に失敗したら、読み込み中のまま止めずに再読み込みのボタンを出す（#182）
  try { data = (await axios.get('/api/staff/home' + (HOME_SHIFT_ID ? '?shift_id=' + encodeURIComponent(HOME_SHIFT_ID) : ''))).data }
  catch (e) { showLoadError(e); return }
  HOME = data
  HOME_LOADED_DAY = dayjs().format('YYYY-MM-DD')
  $app.innerHTML = `
    <div id="notif-banner"></div>
    ${homeNoticeBannerHtml(data)}
    ${homeConsultBannerHtml(data)}
    ${homeMissedHtml(data)}
    ${data.shift ? homeShiftCardHtml(data) + homeReportButtonsHtml(data) : homeNoShiftHtml()}
    ${homeNoticesHtml(data)}
    ${homeMenuHtml()}`
  if (window.loadNotifBanner) loadNotifBanner()
}

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
    ${compact ? '' : `<p class="${tx}"><i class="far fa-clock text-gray-400 mr-1"></i>${esc(s.start_time)} 〜 ${esc(s.end_time)}${brk ? `<span class="text-xs text-gray-500 ml-1">（休憩 ${brk}分）</span>` : ''}</p>`}
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
      ${homeDayShiftsHtml(data, cur)}
    </section>`
}

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
            <span class="text-sm ${isCur ? 'font-bold text-blue-800' : 'text-gray-700'}">${x.carryover ? '昨日 ' : ''}${esc(x.start_time)}〜${esc(x.end_time)} ${esc(x.project_name)}</span>
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
        <p class="text-xs font-bold">${esc(fmtDate(x.work_date))} ${esc(x.start_time)}〜${esc(x.end_time)} ${esc(x.project_name)}${data.multi_company ? `（${esc(x.company_name)}）` : ''}</p>
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

// 報告の状態（サーバーの checkReportable と同じ考え方）
//   done: 報告済み / pending: 打刻修正を申請中（承認待ち。押せない）/ skipped: 後の報告が済んでいて押せない（打刻修正の申請で追加する）
//   open: 押せる（前の報告を飛ばして押すこともできる）。open の先頭が『次の報告』
const REPORT_ORDER = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
//   前日からのシフト（carryover）は、翌日も受け付ける報告（休憩・勤務終了・退店）だけを押せる（サーバーの reportableWindow）
const NEXT_DAY_REPORTS = ['break_start', 'break_end', 'work_end', 'check_out']
function homeReportStates(order, reports, pending, carryover) {
  const lastDone = REPORT_ORDER.reduce((m, t, i) => reports[t] ? i : m, -1)
  const out = {}
  for (const t of order) {
    out[t] = reports[t] ? 'done' : pending[t] ? 'pending'
      : REPORT_ORDER.indexOf(t) < lastDone || (carryover && !NEXT_DAY_REPORTS.includes(t)) ? 'skipped' : 'open'
  }
  return out
}

// 報告ボタン（勤怠報告と日報）
function homeReportButtonsHtml(data) {
  const s = data.shift
  const r = data.reports
  const pend = data.pending_corrections || {}
  // 提出設定（案件・スタッフ・シフトごと）で必要な報告だけを表示する
  const order = (data.required_attendance || ['wake_up', 'departure', 'check_in', 'check_out'])
  const dailyRequired = data.daily_report_required !== false
  const states = homeReportStates(order, r, pend, data.carryover)
  const nextType = order.find(t => states[t] === 'open')
  const nextIdx = nextType ? order.indexOf(nextType) : -1
  const skipped = order.filter(t => states[t] === 'skipped')
  const allDone = nextIdx === -1 && !skipped.length && !order.some(t => states[t] === 'pending') && (!dailyRequired || data.daily_report_done)
  // ほかのシフトで、報告は済んだが日報が未提出のもの（1日に複数のシフトがある場合）
  const pendingDaily = (data.today_shifts || []).filter(x => x.shift_id !== s.shift_id && x.attendance_done && x.daily_report_required && !x.daily_report_done)
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
          const done = st === 'done'
          const isNext = i === nextIdx
          const open = st === 'open'
          const photoOn = data.photo_required_attendance !== false
          const sub = done ? '報告済み ' + dayjs(r[t].reported_at).format('HH:mm')
            : st === 'pending' ? `打刻修正を申請中 ${dayjs(String(pend[t]).replace(' ', 'T')).format('HH:mm')}（承認待ち）`
            : st === 'skipped' ? '未報告（打刻履歴から追加を申請してください）'
            : isNext ? 'タップして報告' : 'タップして報告（前の報告を飛ばします）'
          return `<button class="report-btn ${done ? 'done' : isNext ? 'next' : ''}" ${open ? '' : 'disabled'} data-action="homeReport" data-type="${esc(t)}" data-shift-id="${Number(s.shift_id)}">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${done ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : st === 'pending' ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-400'}">
              <i class="fas ${done ? 'fa-check' : st === 'pending' ? 'fa-hourglass-half' : REPORT_ICONS[t]}"></i>
            </span>
            <span class="flex-1">
              <span class="block font-bold ${done ? 'text-emerald-700' : isNext ? 'text-blue-700' : 'text-gray-500'}">${REPORT_LABELS[t]}</span>
              <span class="block text-xs ${done ? 'text-emerald-600' : st === 'pending' ? 'text-amber-700' : 'text-gray-400'}">
                ${esc(sub)}
                ${t === 'check_in' && open ? (photoOn ? ' (位置情報・写真が必要です)' : ' (位置情報を取得します)') : ''}
                ${t === 'check_out' && open && photoOn ? ' (写真が必要です)' : ''}
              </span>
            </span>
            ${isNext ? '<i class="fas fa-chevron-right text-blue-400"></i>' : ''}
          </button>`
        }).join('')}
        ${order.some(t => states[t] === 'pending') ? '<a href="#attendance" class="block text-xs text-blue-600 px-1">申請中の報告を今の時刻で報告する場合は、打刻履歴の「修正申請」から申請を取り消してください</a>' : ''}
        ${dailyRequired ? `<button class="report-btn ${data.daily_report_done ? 'done' : (r.check_out || nextIdx === -1) ? 'next' : ''}" onclick="location.hash='report/${Number(s.shift_id)}'">
          <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${data.daily_report_done ? 'bg-emerald-500 text-white' : r.check_out ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}">
            <i class="fas ${data.daily_report_done ? 'fa-check' : 'fa-pen-to-square'}"></i>
          </span>
          <span class="flex-1">
            <span class="block font-bold ${data.daily_report_done ? 'text-emerald-700' : 'text-gray-700'}">日報・実績入力</span>
            <span class="block text-xs text-gray-400">${data.daily_report_done ? '提出済み（修正可）' : '稼働終了後に入力してください'}</span>
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

// お知らせ: 未読の案内
function homeNoticeBannerHtml(data) {
  const unread = (data.notices || []).filter(n => !n.is_read)
  return unread.length ? `<div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800" role="alert">
      <i class="fas fa-bell mr-1"></i>未読のお知らせが <b>${unread.length}件</b> あります
      <a href="#more" onclick="setTimeout(()=>renderNotices(),50)" class="underline font-bold ml-1">確認する</a></div>` : ''
}

// お知らせ: 新しい順に3件
function homeNoticesHtml(data) {
  return `
    <section class="card p-4 mb-4" id="notice-preview">
      <h2 class="font-bold text-gray-800 mb-2"><i class="fas fa-bullhorn text-blue-600 mr-1"></i>お知らせ</h2>
      ${(data.notices || []).slice(0, 3).map(n => `
        <a class="block py-2 border-b border-gray-50 last:border-0" href="#more" onclick="setTimeout(()=>renderNotices(),50)">
          <div class="flex items-center gap-2">
            ${n.importance !== 'normal' ? '<span class="badge badge-red">重要</span>' : ''}
            ${!n.is_read ? '<span class="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>' : ''}
            <span class="text-sm ${n.is_read ? 'text-gray-500' : 'font-bold text-gray-800'} truncate">${esc(n.title)}</span>
          </div>
          <span class="text-xs text-gray-400">${dayjs(n.published_at).format('M/D')}</span>
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
      <a href="#more" onclick="setTimeout(()=>renderConsult(),50)" class="card p-4 text-center"><i class="fas fa-comments text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">相談・連絡</span></a>
    </div>`
}

// 報告ボタン: 未確定のシフト・前の報告を飛ばす場合は確認してから、写真が必要なら写真の画面、それ以外はそのまま送信する
delegate('homeReport', (el) => {
  if (!HOME || !HOME.shift) return
  const type = el.dataset.type, shiftId = Number(el.dataset.shiftId)
  if (HOME.tentative && !confirm('このシフトはまだ確定していません（希望（仮））。確定されるまでは支払いの対象になりません。\n管理者に勤務を確認したうえで報告しますか？')) return
  const order = HOME.required_attendance || []
  const states = homeReportStates(order, HOME.reports || {}, HOME.pending_corrections || {}, HOME.carryover)
  const skipping = order.filter(t => states[t] === 'open' && REPORT_ORDER.indexOf(t) < REPORT_ORDER.indexOf(type))
  if (skipping.length && !confirm(`${skipping.map(t => REPORT_LABELS[t]).join('・')} が未報告です。\n飛ばして${REPORT_LABELS[type]}を報告すると、飛ばした報告はこの画面から押せなくなります（打刻履歴から打刻漏れの追加を申請してください）。\n報告しますか？`)) return
  const photoOn = HOME.photo_required_attendance !== false
  if (photoOn && PHOTO_REQUIRED_TYPES.includes(type)) openPhotoAttendance(type, shiftId)
  else submitAttendance(type, shiftId, el)
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

// 勤怠報告の失敗の文言。すでに報告済み（前の送信が届いていた・別の端末で報告した）なら、エラーではなく報告済みと伝える（#182）
function attendanceErrorMessage(e, type) {
  const msg = e && e.response && e.response.data && e.response.data.error
  if (e && e.response && e.response.status === 409 && msg === 'すでに報告済みです') return REPORT_LABELS[type] + 'は報告済みです'
  if (!e || !e.response) return '通信できませんでした。電波の良い場所で、報告済みになっていないか確かめてから再度お試しください'
  return msg || '送信に失敗しました'
}

// 勤怠報告送信（送信中は押せない。位置情報を待つ間も含む）
let ATTENDANCE_SENDING = false
window.submitAttendance = async function (type, shiftId, button) {
  if (homeIsStale()) { toast('日付が変わったため、画面を更新しました'); return }
  if (ATTENDANCE_SENDING) return
  ATTENDANCE_SENDING = true
  // 送信中はボタンに『送信中』を出す（#182）
  const sub = button && button.querySelector('.flex-1 .text-xs')
  if (sub) sub.textContent = '送信中...'
  try {
    await withSubmitLock(button, async () => {
      let pos = null
      if (type === 'check_in') { toast('位置情報を取得しています...'); pos = await getPositionOrNull() }
      try {
        await axios.post('/api/staff/attendance', {
          shift_id: shiftId, report_type: type,
          latitude: pos ? pos.coords.latitude : null,
          longitude: pos ? pos.coords.longitude : null,
          address: null
        })
        toast(REPORT_LABELS[type] + 'を送信しました')
      } catch (e) {
        toast(attendanceErrorMessage(e, type))
      }
    })
  } finally {
    ATTENDANCE_SENDING = false
  }
  renderHome()
}

// ============ 入店/退店報告（写真添付） ============
window.openPhotoAttendance = function (type, shiftId) {
  if (homeIsStale()) { toast('日付が変わったため、画面を更新しました'); return }
  pendingPhoto = { blob: null, previewUrl: null, type, shiftId }
  modal(photoModalHtml())
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
    <input type="file" id="photo-input-camera" accept="image/*" capture="environment" class="hidden" onchange="onPhotoSelected(this.files[0])">
    <input type="file" id="photo-input-album" accept="image/*" class="hidden" onchange="onPhotoSelected(this.files[0])">
    <div id="photo-error" class="text-sm text-red-600 mt-2"></div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button id="photo-submit-btn" class="btn btn-primary flex-1" disabled onclick="submitPhotoAttendance()">
        <i class="fas fa-paper-plane"></i>送信する
      </button>
    </div>`
}

function photoAreaHtml() {
  if (pendingPhoto.previewUrl) {
    return `
      <div class="relative">
        <img src="${pendingPhoto.previewUrl}" class="w-full rounded-xl border border-gray-200 max-h-64 object-cover" alt="プレビュー">
        <button class="absolute top-2 right-2 bg-white/90 text-gray-600 rounded-full w-8 h-8 flex items-center justify-center shadow" onclick="removePendingPhoto()">
          <i class="fas fa-rotate-left"></i>
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

function setPhotoError(msg) {
  const el = document.getElementById('photo-error')
  if (el) el.textContent = msg || ''
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
  setPhotoError('')
  refreshPhotoModal()
}

window.onPhotoSelected = async function (file) {
  setPhotoError('')
  if (!file) return
  if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name || '')) {
    setPhotoError('画像ファイルを選択してください')
    return
  }
  if (file.size > PHOTO_MAX_UPLOAD_BYTES) {
    setPhotoError('ファイルサイズが大きすぎます（10MBまで）')
    return
  }

  const area = document.getElementById('photo-area')
  if (area) area.innerHTML = '<div class="flex flex-col items-center justify-center py-8 gap-2"><span class="spin"></span><span class="text-xs text-gray-400">画像を処理しています...</span></div>'

  try {
    const blob = await compressImage(file)
    if (pendingPhoto.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
    pendingPhoto.blob = blob
    pendingPhoto.previewUrl = URL.createObjectURL(blob)
    refreshPhotoModal()
  } catch (err) {
    setPhotoError(err && err.message ? err.message : '画像の処理に失敗しました。別の写真をお試しください')
    refreshPhotoModal()
  }
}

// EXIF補正・リサイズ・JPEG圧縮（500KB以下 / 長辺1600px以下 / 画質70%基準）
async function compressImage(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new Error('この画像形式は読み込めませんでした。JPEGまたはPNGをお試しください')
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
    throw new Error('画像を十分に圧縮できませんでした。別の写真をお試しください')
  }
  return blob
}

window.submitPhotoAttendance = async function () {
  if (!pendingPhoto.blob) { setPhotoError('写真を選択してください'); return }
  const { type, shiftId, blob } = pendingPhoto
  const btn = document.getElementById('photo-submit-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin" style="width:1rem;height:1rem;border-width:2px"></span> 送信中...' }

  const send = async (pos) => {
    const form = new FormData()
    form.append('shift_id', String(shiftId))
    form.append('report_type', type)
    if (pos) { form.append('latitude', String(pos.coords.latitude)); form.append('longitude', String(pos.coords.longitude)) }
    form.append('photo', blob, 'attendance.jpg')
    try {
      await axios.post('/api/staff/attendance-photo', form)
      closeModal()
      toast(REPORT_LABELS[type] + 'を送信しました')
      renderHome()
    } catch (e) {
      // すでに報告済み（前の送信が届いていた）なら閉じて最新の状態を出す（#182）
      if (e.response && e.response.status === 409 && e.response.data && e.response.data.error === 'すでに報告済みです') {
        closeModal(); toast(attendanceErrorMessage(e, type)); renderHome(); return
      }
      setPhotoError((e.response && e.response.data && e.response.data.error) || '通信に失敗しました。電波の良い場所で再度お試しください')
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i>送信する' }
    }
  }

  // 端末が位置情報に応答しないときも送信中のまま止まらないよう、getPositionOrNull（10秒で諦める）を使う
  if (type === 'check_in') {
    getPositionOrNull().then(send)
  } else {
    send(null)
  }
}

// ============ シフト ============
// shifts: 確定・代打・欠勤と、会社が仮で押さえた枠（status='requested'。本人が可否を返事する）
// requests: 本人が出したシフト希望（返事待ち・採用・見送り。返事待ちは取り下げできる）
let SHIFT_REQ_PROJECTS = []
let SHIFTS_MONTH = null
const SHIFT_REQ_BADGE = {
  pending: '<span class="badge badge-yellow">希望を提出済み</span>',
  accepted: '<span class="badge badge-green">採用</span>',
  declined: '<span class="badge badge-gray">見送り</span>',
}
async function renderShifts(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  SHIFTS_MONTH = month
  let data
  try { data = (await axios.get('/api/staff/shifts?month=' + month)).data } catch (e) { showLoadError(e); return }
  SHIFT_REQ_PROJECTS = data.request_projects || []
  const byDate = {}
  const day = (d) => (byDate[d] = byDate[d] || { shifts: [], requests: [] })
  for (const s of data.shifts) day(s.work_date).shifts.push(s)
  for (const r of data.requests || []) day(r.work_date).requests.push(r)
  const today = dayjs().format('YYYY-MM-DD')
  const statusBadge = { requested: '<span class="badge bg-orange-100 text-orange-700">仮押さえ（確定前）</span>', confirmed: '<span class="badge badge-green">確定</span>', absent: '<span class="badge badge-red">欠勤</span>', substitute: '<span class="badge badge-purple">代打</span>' }
  const replyLabel = { ok: '「入れます」と返事済み', ng: '「入れません」と返事済み' }
  // 会社の仮押さえへの返事（入れます／入れません）。過ぎた日は返事できない
  const replyBox = (s) => {
    if (s.status !== 'requested') return ''
    const canReply = s.work_date >= today
    return `<div class="mt-1 rounded-lg bg-orange-50 px-2.5 py-2 text-xs text-gray-600">
      <p>会社が仮で押さえた枠です。まだ確定していません。${canReply ? '入れるかどうか返事をしてください' : ''}</p>
      ${s.staff_reply ? `<p class="mt-1 font-bold ${s.staff_reply === 'ok' ? 'text-emerald-700' : 'text-red-600'}">${replyLabel[s.staff_reply] || ''}${s.staff_reply_note ? '：' + esc(s.staff_reply_note) : ''}</p>` : ''}
      ${canReply ? `<div class="flex gap-2 mt-2">
        <button class="btn ${s.staff_reply === 'ok' ? 'btn-primary' : 'btn-outline'} flex-1 text-xs" data-action="replyShift" data-id="${s.shift_id}" data-answer="ok">入れます</button>
        <button class="btn ${s.staff_reply === 'ng' ? 'btn-danger' : 'btn-outline'} flex-1 text-xs" data-action="replyShift" data-id="${s.shift_id}" data-answer="ng">入れません</button>
      </div>` : ''}
    </div>`
  }
  const requestRow = (r) => `
    <div class="mt-2 pt-2 border-t border-dashed border-gray-200 text-sm shift-request-row" data-request-id="${r.request_id}">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium text-gray-700"><i class="fas fa-hand text-amber-500 mr-1"></i>シフト希望・${r.project_name ? esc(r.project_name) : '案件の指定なし'}</p>
          <p class="text-xs text-gray-400">${esc(r.start_time)}〜${esc(r.end_time)}${r.memo ? ' ' + esc(r.memo) : ''}</p>
        </div>
        <div class="text-right shrink-0">${SHIFT_REQ_BADGE[r.status] || ''}
          ${r.status === 'pending' ? `<button class="block text-[11px] text-gray-500 underline mt-1 ml-auto" data-action="withdrawShiftRequest" data-id="${r.request_id}">取り下げ</button>` : ''}</div>
      </div>
      ${r.status === 'pending' ? '<p class="text-[11px] text-gray-400 mt-0.5">管理者の返事を待っています</p>' : ''}
      ${r.status === 'accepted' ? '<p class="text-[11px] text-gray-500 mt-0.5">シフトが登録されると、この日に「確定」のシフトとして表示されます</p>' : ''}
      ${r.status !== 'pending' && r.response_note ? `<p class="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1 mt-1">管理者より：${esc(r.response_note)}</p>` : ''}
    </div>`

  // どの会社のシフトか（2社以上に所属している人だけ。他社のシフトは目立たせる。#503）
  const companyTag = (s) => !data.multi_company ? ''
    : s.other_company ? ` <span class="badge badge-purple">${esc(s.company_name)}のシフト</span>` : ` <span class="text-[11px] text-gray-400">${esc(s.company_name)}</span>`
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <button class="btn btn-outline" onclick="renderShifts('${dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-left"></i></button>
      <h2 class="font-bold text-gray-800">${dayjs(month + '-01').format('YYYY年M月')}</h2>
      <button class="btn btn-outline" onclick="renderShifts('${dayjs(month + '-01').add(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-right"></i></button>
    </div>
    <div id="recruit-open" class="mb-3"></div>
    <button class="btn btn-primary w-full mb-4" onclick="showShiftRequest()"><i class="fas fa-plus"></i>シフト希望を提出する</button>
    <div class="space-y-2" id="shift-list">
      ${Object.keys(byDate).sort().map(d => `
        <div class="card p-3.5 ${d === today ? 'ring-2 ring-blue-400' : ''}">
          <div class="flex items-center justify-between">
            <span class="font-bold ${d === today ? 'text-blue-700' : 'text-gray-800'}">${fmtDate(d)} ${d === today ? '<span class="badge badge-blue">今日</span>' : ''}</span>
          </div>
          ${byDate[d].shifts.map(s => `
            <div class="mt-1.5 flex items-start justify-between gap-2 text-sm shift-row" data-shift-id="${Number(s.shift_id)}">
              <div class="min-w-0">
                <p class="font-medium text-gray-700">${esc(s.project_name)}${companyTag(s)}</p>
                <p class="text-xs text-gray-400">${esc(s.start_time)}〜${esc(s.end_time)}</p>
                ${shiftPlaceHtml(s, true)}
              </div>
              <span class="shrink-0">${statusBadge[s.status] || ''}</span>
            </div>${replyBox(s)}`).join('')}
          ${byDate[d].requests.map(requestRow).join('')}
        </div>`).join('') || '<p class="text-center text-gray-400 py-10">この月のシフトはありません</p>'}
    </div>
    <div id="shift-modal"></div>`
  loadRecruitOpen()
}

// ============ 募集中のお仕事（管理者の承認で確定。/api/staff/recruit） ============
let RECRUIT = null
async function loadRecruitOpen() {
  const host = document.getElementById('recruit-open'); if (!host) return
  try { RECRUIT = (await axios.get('/api/staff/recruit')).data } catch (e) { host.innerHTML = ''; return }
  const open = RECRUIT.pages.reduce((n, p) => n + p.roles.filter(r => !r.my_status && !r.full).length, 0)
  const pending = RECRUIT.applications.filter(a => a.status === 'pending').length
  if (!RECRUIT.pages.length && !RECRUIT.applications.length) { host.innerHTML = ''; return }
  host.innerHTML = `<button class="report-btn" onclick="renderRecruitList()" id="recruit-open-btn">
    <span class="w-11 h-11 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center text-lg"><i class="fas fa-bullhorn"></i></span>
    <span class="flex-1"><span class="block font-bold text-gray-800">募集中のお仕事</span>
      <span class="block text-xs text-gray-500">${open ? `応募できる日時 ${open}件` : '応募できる日時はありません'}${pending ? `・承認待ち ${pending}件` : ''}</span></span>
    <i class="fas fa-chevron-right text-gray-300"></i></button>`
}
const RC_STATUS = { pending: '<span class="badge badge-yellow">承認待ち</span>', approved: '<span class="badge badge-green">確定</span>', rejected: '<span class="badge badge-gray">見送り</span>', cancelled: '<span class="badge badge-gray">取り下げ</span>' }
window.renderRecruitList = function () {
  const d = RECRUIT; if (!d) return
  const picked = new Set()
  window.__rcPicked = picked
  $app.innerHTML = `
    <button class="text-sm text-blue-600 mb-3" onclick="renderShifts()"><i class="fas fa-chevron-left mr-1"></i>シフトに戻る</button>
    ${d.applications.length ? `<section class="card p-3 mb-3" id="recruit-my-apps"><h3 class="text-sm font-bold text-gray-700 mb-2">応募した日時</h3>
      ${d.applications.map(a => `<div class="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
        <div><p class="font-medium">${fmtDate(a.work_date)} ${esc(a.start_time)}〜${esc(a.end_time)}</p><p class="text-xs text-gray-400">${esc(a.place)}${a.role_name ? '・' + esc(a.role_name) : ''}</p></div>
        <div class="text-right">${RC_STATUS[a.status] || ''}${a.status === 'pending' ? `<button class="block text-[11px] text-gray-500 underline mt-1" onclick="cancelRecruitItem(${a.item_id})">取り下げ</button>` : ''}</div></div>`).join('')}</section>` : ''}
    ${d.pages.map(p => `<section class="card p-3 mb-3" data-page-id="${p.page_id}">
      <h3 class="font-bold text-gray-800">${esc(p.title)}</h3>
      <p class="text-xs text-gray-500 mb-1">${fmtDate(p.date_from)}〜${fmtDate(p.date_to)}</p>
      ${p.description ? `<p class="text-xs text-gray-600 mb-1 whitespace-pre-wrap">${esc(p.description)}</p>` : ''}
      ${p.pay_note ? `<p class="text-xs mb-2"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>${esc(p.pay_note)}</p>` : ''}
      <div class="space-y-1.5">${p.roles.map(r => `<label class="flex items-center gap-3 p-2.5 rounded-lg border border-gray-200 ${r.my_status || r.full ? 'opacity-60' : ''}">
        ${r.my_status ? '<span class="w-5"></span>' : `<input type="checkbox" class="w-5 h-5" onchange="this.checked ? window.__rcPicked.add('${p.page_id}:${r.slot_role_id}') : window.__rcPicked.delete('${p.page_id}:${r.slot_role_id}')">`}
        <span class="flex-1 min-w-0"><span class="block text-sm font-medium">${fmtDate(r.work_date)} ${esc(r.start_time)}〜${esc(r.end_time)}</span>
          <span class="block text-xs text-gray-500 truncate">${esc(r.place)}${r.role_name ? '・' + esc(r.role_name) : ''}</span></span>
        <span class="text-xs whitespace-nowrap">${r.my_status === 'assigned' ? '<span class="badge badge-green">シフトあり</span>' : r.my_status ? RC_STATUS[r.my_status] : r.full ? '<span class="text-gray-500">定員</span>' : r.remaining != null ? `<span class="text-emerald-600">残り${r.remaining}名</span>` : ''}</span></label>`).join('') || '<p class="text-xs text-gray-400">募集中の日時はありません</p>'}</div>
    </section>`).join('')}
    ${d.pages.length ? `<textarea id="rc-note" class="inp mb-3" rows="2" maxlength="500" placeholder="メモ（任意）"></textarea>
      <button class="btn btn-primary w-full py-3" onclick="submitRecruitApply()">選んだ日時に応募する</button>
      <p class="text-[11px] text-gray-400 text-center mt-2">管理者が承認するとシフトが確定します</p>` : ''}`
}
window.submitRecruitApply = async function () {
  const picked = [...window.__rcPicked]
  if (!picked.length) return toast('日時を選択してください')
  const byPage = {}
  for (const k of picked) { const [pid, rid] = k.split(':'); (byPage[pid] = byPage[pid] || []).push(Number(rid)) }
  let n = 0
  try {
    for (const [pid, ids] of Object.entries(byPage)) {
      const { data } = await axios.post('/api/staff/recruit/apply', { page_id: Number(pid), slot_role_ids: ids, note: document.getElementById('rc-note').value })
      n += data.count || 0
    }
    toast(n ? `${n}件応募しました。承認をお待ちください` : 'すでに応募済みです')
    RECRUIT = (await axios.get('/api/staff/recruit')).data; renderRecruitList()
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '応募に失敗しました') }
}
window.cancelRecruitItem = async function (id) {
  if (!confirm('この応募を取り下げますか？')) return
  try { await axios.post(`/api/staff/recruit/items/${id}/cancel`); toast('取り下げました'); RECRUIT = (await axios.get('/api/staff/recruit')).data; renderRecruitList() }
  catch (e) { toast((e.response && e.response.data && e.response.data.error) || '取り下げに失敗しました') }
}

window.showShiftRequest = function () {
  const projects = SHIFT_REQ_PROJECTS || []
  document.getElementById('shift-modal').innerHTML = `
    <div class="modal-bg" onclick="if(event.target===this)this.remove()">
      <div class="modal-box p-5">
        <h3 class="font-bold text-lg mb-1">シフト希望提出</h3>
        <p class="text-xs text-gray-500 mb-4">管理者が確認して返事をします。返事があるまでは取り下げできます</p>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-600 block mb-1">日付</label><input id="req-date" type="date" class="inp" min="${dayjs().format('YYYY-MM-DD')}"></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-sm text-gray-600 block mb-1">開始</label><input id="req-start" type="time" value="09:30" class="inp"></div>
            <div><label class="text-sm text-gray-600 block mb-1">終了</label><input id="req-end" type="time" value="19:00" class="inp"></div>
          </div>
          ${projects.length ? `<div><label class="text-sm text-gray-600 block mb-1">案件（任意）</label><select id="req-project" class="inp">
            <option value="">指定しない</option>${projects.map(p => `<option value="${p.project_id}">${esc(p.project_name)}</option>`).join('')}</select></div>` : ''}
          <div><label class="text-sm text-gray-600 block mb-1">備考</label><input id="req-memo" type="text" class="inp" maxlength="500" placeholder="希望条件など"></div>
          <p id="req-error" class="text-sm text-red-600 hidden"></p>
          <button class="btn btn-primary w-full" onclick="submitShiftRequest(this)">提出する</button>
        </div>
      </div>
    </div>`
}

window.submitShiftRequest = async function (btn) {
  const errEl = document.getElementById('req-error')
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.remove('hidden') }
  const date = document.getElementById('req-date').value
  const start = document.getElementById('req-start').value
  const end = document.getElementById('req-end').value
  if (!date) return showErr('日付を選択してください')
  if (date < dayjs().format('YYYY-MM-DD')) return showErr('過去の日付には希望を出せません')
  if (!start || !end) return showErr('開始・終了の時刻を入力してください')
  if (start === end) return showErr('開始と終了に同じ時刻は指定できません')
  const proj = document.getElementById('req-project')
  await withSubmitLock(btn, async () => {
    try {
      await axios.post('/api/staff/shifts/request', {
        work_date: date, start_time: start, end_time: end,
        project_id: proj && proj.value ? Number(proj.value) : null,
        memo: document.getElementById('req-memo').value,
      })
    } catch (e) {
      showErr((e.response && e.response.data && e.response.data.error) || '提出に失敗しました。電波の良い場所で再度お試しください')
      return
    }
    toast('シフト希望を提出しました')
    renderShifts(date.slice(0, 7))
  })
}

// シフト希望の取り下げ（返事待ちのものだけ）
delegate('withdrawShiftRequest', async (el) => {
  if (!confirm('このシフト希望を取り下げますか？')) return
  await withSubmitLock(el, async () => {
    try { await axios.post(`/api/staff/shift-requests/${Number(el.dataset.id)}/cancel`) }
    catch (e) { showApiError(e, '取り下げに失敗しました'); return }
    toast('取り下げました')
    renderShifts(SHIFTS_MONTH)
  })
})

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
    renderShifts(SHIFTS_MONTH)
  })
})

// ============ 日報入力 ============
// 対象のシフトは #report/<shift_id> で指定する。指定がなければ、報告が済んで日報が未提出のシフト → ホームのシフトの順に選ぶ
async function renderReport() {
  loading()
  // 開いたまま日付が変わっても前日の内容で送らないよう、毎回読み直す
  const { data: home } = await axios.get('/api/staff/home')
  HOME = home
  HOME_LOADED_DAY = dayjs().format('YYYY-MM-DD')
  const list = home.today_shifts || []
  const wanted = Number((location.hash || '').slice(1).split('/')[1]) || 0
  const s = list.find(x => x.shift_id === wanted)
    || list.find(x => x.attendance_done && x.daily_report_required && !x.daily_report_done)
    || list.find(x => home.shift && x.shift_id === home.shift.shift_id) || list[0] || null
  if (!s) {
    $app.innerHTML = `<div class="card p-6 text-center text-gray-500 mt-4">
      <i class="fas fa-circle-info text-2xl text-gray-300 mb-2 block"></i>
      本日の稼働予定がないため、日報を入力できません。</div>
      <h3 class="font-bold text-gray-700 mt-6 mb-2 px-1">過去の日報</h3><div id="past-reports"></div>`
    loadPastReports()
    return
  }
  // 提出済みなら前回の内容を初期値にする（修正して再提出しても、ほかの項目が0や空欄で上書きされないように）
  const { data } = await axios.get('/api/staff/daily-report/' + Number(s.shift_id))
  const prev = data.report
  const pv = (k) => (prev && prev.values && prev.values[k] != null ? prev.values[k] : '')
  const tplFields = (data.template && data.template.fields) || []
  // テンプレートの無い案件は「報告内容」の欄だけ（報告用URLの画面・サーバーの検証と同じ）
  const fields = tplFields.length ? tplFields : [{ key: 'free', label: '報告内容', type: 'textarea' }]
  const numFields = fields.filter(f => f.type === 'number')
  const textFields = fields.filter(f => f.type !== 'number')

  $app.innerHTML = `
    <section class="card p-4 mb-4">
      <h2 class="font-bold text-gray-800">${esc(s.project_name)}</h2>
      <p class="text-xs text-gray-400">${fmtDate(s.work_date)} ${esc(s.start_time)}〜${esc(s.end_time)} の日報 ${data.template ? '｜' + esc(data.template.template_name) : ''}</p>
      ${list.length > 1 ? `<select id="report-shift" class="inp text-sm mt-2" aria-label="日報を入力するシフト">
        ${list.map(x => `<option value="${Number(x.shift_id)}" ${x.shift_id === s.shift_id ? 'selected' : ''}>${esc(fmtDate(x.work_date))} ${esc(x.start_time)}〜${esc(x.end_time)} ${esc(x.project_name)}${x.daily_report_done ? '（提出済み）' : x.daily_report_required ? '' : '（日報不要）'}</option>`).join('')}
      </select>` : ''}
      ${s.daily_report_required === false ? '<p class="text-xs text-gray-500 bg-gray-50 rounded p-2 mt-2"><i class="fas fa-circle-info mr-1"></i>このシフトは日報の提出は不要です（任意で提出できます）</p>' : ''}
      ${prev ? `<p class="text-xs text-emerald-700 bg-emerald-50 rounded p-2 mt-2"><i class="fas fa-check mr-1"></i>提出済み（${esc(dayjs(prev.submitted_at).format('M/D HH:mm'))}）。内容を直して再提出できます${prev.manager_checked ? '<br>管理者が確認済みです。再提出すると、もう一度確認してもらうことになります' : ''}</p>` : ''}
      ${prev && prev.manager_comment ? `<p class="text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-2"><i class="fas fa-comment-dots mr-1"></i>${esc(prev.manager_comment)}</p>` : ''}
    </section>
    <form id="report-form" class="space-y-4 pb-8">
      ${numFields.length ? `<section class="card p-4">
        <h3 class="font-bold text-gray-700 mb-3 text-sm"><i class="fas fa-hashtag text-blue-500 mr-1"></i>実績件数</h3>
        <div class="grid grid-cols-2 gap-3">
          ${numFields.map(f => `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}</label>
              <input type="number" inputmode="numeric" min="0" max="99999" step="1" data-key="${esc(f.key)}" class="inp rpt-field text-center text-lg font-bold" value="${esc(pv(f.key))}" placeholder="0">
            </div>`).join('')}
        </div>
      </section>` : ''}
      ${textFields.length ? `<section class="card p-4">
        <h3 class="font-bold text-gray-700 mb-3 text-sm"><i class="fas fa-message text-blue-500 mr-1"></i>報告事項</h3>
        <div class="space-y-3">
          ${textFields.map(f => `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}</label>
              ${f.type === 'textarea'
                ? `<textarea data-key="${esc(f.key)}" rows="3" maxlength="2000" class="inp rpt-field" placeholder="${esc(f.label)}を入力">${esc(pv(f.key))}</textarea>`
                : `<input type="text" data-key="${esc(f.key)}" maxlength="2000" class="inp rpt-field" placeholder="${esc(f.label)}を入力" value="${esc(pv(f.key))}">`}
            </div>`).join('')}
        </div>
      </section>` : ''}
      <section class="card p-4">
        <label class="flex items-center gap-3 py-1"><input id="incident-flag" type="checkbox" class="w-5 h-5 rounded" ${prev && prev.incident_flag ? 'checked' : ''}><span class="text-sm font-medium text-gray-700">インシデントがあった</span></label>
        <label class="flex items-center gap-3 py-1"><input id="complaint-flag" type="checkbox" class="w-5 h-5 rounded" ${prev && prev.complaint_flag ? 'checked' : ''}><span class="text-sm font-medium text-gray-700">クレームがあった</span></label>
      </section>
      <button type="submit" id="report-submit" class="btn btn-primary w-full py-3.5 text-base">${prev ? '日報を修正して再提出' : '日報を提出する'}</button>
    </form>`

  const sel = document.getElementById('report-shift')
  if (sel) sel.addEventListener('change', () => { location.hash = 'report/' + Number(sel.value) })
  document.getElementById('report-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const values = {}
    document.querySelectorAll('.rpt-field').forEach(el => {
      const k = el.dataset.key
      values[k] = el.type === 'number' ? Number(el.value || 0) : el.value
    })
    // 送信中はボタンを押せないようにする（二度押しで同じ日報を送らない）
    withSubmitLock(document.getElementById('report-submit'), async () => {
      try {
        // 案件・稼働日はシフトの値（サーバーでもシフトと一致するかを確かめる）。
        // インシデント・クレームは前回の値を表示したうえで送るので flags_explicit を付ける（外したときだけ印を下げる）
        await axios.post('/api/staff/daily-report', {
          project_id: s.project_id, shift_id: s.shift_id, work_date: s.work_date, values,
          incident_flag: document.getElementById('incident-flag').checked,
          complaint_flag: document.getElementById('complaint-flag').checked,
          flags_explicit: true
        })
      } catch (err) {
        // 通信できなかったときは電波の案内を出す。入力した内容はそのまま残す（#194）
        showApiError(err, err && err.response ? '日報の送信に失敗しました' : '通信に失敗しました。電波の良い場所で再度お試しください（入力した内容は残っています）')
        return
      }
      toast('日報を提出しました。お疲れさまでした！')
      HOME = null
      location.hash = 'home'
    })
  })
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
        <span class="font-bold text-sm text-gray-800">${esc(fmtDate(r.work_date))}${r.start_time ? ` <span class="text-xs font-normal text-gray-400">${esc(r.start_time)}〜${esc(r.end_time)}</span>` : ''}</span>
        ${pastReportCheckBadge(r)}
      </span>
      <span class="block text-xs text-gray-500 mt-0.5">${esc(r.project_name)}${r.other_company ? ` <span class="badge badge-purple">${esc(r.company_name)}</span>` : ''}
        ${r.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}${r.complaint_flag ? '<span class="badge badge-red">クレーム</span>' : ''}</span>
      ${r.manager_comment ? `<span class="block text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-1.5 whitespace-pre-wrap"><i class="fas fa-comment-dots mr-1"></i>${esc(r.manager_comment)}</span>` : ''}
    </button>`).join('') || '<p class="text-sm text-gray-400">日報履歴はありません</p>'
}
delegate('reloadPastReports', () => loadPastReports())
// 管理者の確認（確認済み／未確認。確認の後に直した日報は、もう一度確認してもらう）
function pastReportCheckBadge(r) {
  return r.manager_checked ? '<span class="badge badge-green"><i class="fas fa-check"></i>確認済み</span>'
    : r.revised_after_check_at ? '<span class="badge badge-yellow">修正後の確認待ち</span>' : '<span class="badge badge-gray">未確認</span>'
}
delegate('openPastReport', (el) => {
  const r = PAST_REPORTS && PAST_REPORTS.reports[Number(el.dataset.index)]
  if (!r) return
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
    <p class="text-sm text-gray-600">${esc(r.project_name)}${r.start_time ? ` ${esc(r.start_time)}〜${esc(r.end_time)}` : ''}${r.other_company ? ` <span class="badge badge-purple">${esc(r.company_name)}</span>` : ''}</p>
    <p class="text-xs text-gray-500 mt-1">提出 ${esc(r.submitted_at ? dayjs(String(r.submitted_at).replace(' ', 'T')).format('M/D HH:mm') : '')} ${pastReportCheckBadge(r)}</p>
    ${nums.length ? `<div class="grid grid-cols-3 gap-2 mt-3">${nums.map(f => `<div class="bg-gray-50 rounded-lg p-2 text-center"><p class="text-lg font-bold text-blue-600">${esc(r.values[f.key])}</p><p class="text-[11px] text-gray-500">${esc(f.label)}</p></div>`).join('')}</div>` : ''}
    ${texts.map(f => `<div class="mt-3"><p class="text-xs font-bold text-gray-500">${esc(f.label)}</p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(r.values[f.key])}</p></div>`).join('')}
    ${!shown.length ? '<p class="text-sm text-gray-400 mt-3">入力された項目はありません</p>' : ''}
    ${r.incident_flag || r.complaint_flag ? `<p class="mt-3">${r.incident_flag ? '<span class="badge badge-red">インシデントあり</span> ' : ''}${r.complaint_flag ? '<span class="badge badge-red">クレームあり</span>' : ''}</p>` : ''}
    ${r.manager_comment ? `<div class="mt-3 bg-blue-50 rounded-lg px-3 py-2"><p class="text-xs font-bold text-blue-700 mb-0.5"><i class="fas fa-comment-dots mr-1"></i>管理者のコメント</p><p class="text-sm text-blue-900 whitespace-pre-wrap">${esc(r.manager_comment)}</p></div>` : ''}
    <button class="btn btn-outline w-full mt-4" onclick="closeModal()">閉じる</button>`)
})

// 日報タブ: 本日の入力欄（renderReport）の下に、勤務がある日も過去の日報を出す（#319）
async function renderReportWithHistory() {
  await renderReport()
  if ((location.hash || '').slice(1).split('/')[0] !== 'report') return // 読み込み中にほかのタブへ移った
  if (document.getElementById('past-reports') || $app.querySelector('[data-action="retryLoad"]')) return
  $app.insertAdjacentHTML('beforeend', '<h3 class="font-bold text-gray-700 mt-2 mb-2 px-1">過去の日報</h3><div id="past-reports" class="pb-4"></div>')
  loadPastReports()
}

// ============ 実績 ============
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
    </section>`
  }
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button class="btn btn-outline" onclick="renderPerf('${dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM')}')" aria-label="前の月"><i class="fas fa-chevron-left"></i></button>
      <h2 class="font-bold text-gray-800">${dayjs(month + '-01').format('YYYY年M月')}の実績</h2>
      <button class="btn btn-outline" onclick="renderPerf('${dayjs(month + '-01').add(1, 'month').format('YYYY-MM')}')" aria-label="次の月"><i class="fas fa-chevron-right"></i></button>
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
          ${d.comment ? `<p class="text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-2 whitespace-pre-wrap"><i class="fas fa-comment-dots mr-1"></i>${esc(d.comment)}</p>` : ''}
        </div>`
      }).join('')}
    </div>` : ''}`
}

// ============ その他 (お知らせ / 相談) ============
function renderMore() {
  setTimeout(() => window.loadNotifBanner && loadNotifBanner(), 0)
  $app.innerHTML = `
    <div class="space-y-3">
      <button class="report-btn" onclick="renderNotices()">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-bullhorn"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">お知らせ</span><span class="block text-xs text-gray-400">会社からのお知らせを確認</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>
      <button class="report-btn" onclick="renderConsult()">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-comments"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">相談・連絡</span><span class="block text-xs text-gray-400">管理者への相談・連絡</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>
      <button class="report-btn" onclick="location.hash='notifications'">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-bell"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">通知 <span id="more-notif-count" class="badge badge-red hidden"></span></span><span class="block text-xs text-gray-400">打刻修正申請の受付・承認・却下</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>
      <button class="report-btn" onclick="location.hash='attendance'">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-user-clock"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">打刻履歴・修正申請</span><span class="block text-xs text-gray-400">打刻の確認・時刻の修正・打刻漏れの追加</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>
      <button class="report-btn" onclick="renderManual()">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-book-open"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">研修・マニュアル</span><span class="block text-xs text-gray-400">案件マニュアル・研修資料</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>
    </div>`
}

window.renderNotices = async function () {
  loading()
  const { data } = await axios.get('/api/staff/notices')
  $app.innerHTML = `
    <h2 class="font-bold text-gray-800 mb-3 px-1"><i class="fas fa-bullhorn text-blue-600 mr-1"></i>お知らせ</h2>
    <div class="space-y-2">
      ${data.notices.map(n => `
        <div class="card p-4 ${!n.is_read ? 'ring-1 ring-blue-200' : ''}" id="notice-${n.notice_id}">
          <div class="flex items-center gap-2 mb-1">
            ${n.importance !== 'normal' ? '<span class="badge badge-red">重要</span>' : ''}
            ${!n.is_read ? '<span class="badge badge-blue">未読</span>' : '<span class="badge badge-gray">既読</span>'}
            <span class="text-xs text-gray-400 ml-auto">${dayjs(n.published_at).format('M/D HH:mm')}</span>
          </div>
          <h3 class="font-bold text-gray-800">${esc(n.title)}</h3>
          <p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap">${esc(n.body)}</p>
          ${!n.is_read ? `<button class="btn btn-primary w-full mt-3" onclick="markRead(${n.notice_id})"><i class="fas fa-check"></i>確認しました</button>` : ''}
        </div>`).join('') || '<p class="text-center text-gray-400 py-10">お知らせはありません</p>'}
    </div>`
}

window.markRead = async function (id) {
  await axios.post('/api/staff/notices/' + id + '/read')
  toast('既読にしました')
  renderNotices()
}

// ============ 相談・連絡 ============
// 送り先の会社と対象のシフトを選べる（#222 #195）。カテゴリは未選択から始める（#235）。
// 送信中はボタンを押せず、失敗したら入力を残したままエラーを出す（#194）。開いたら管理者の返信を既読にする（#320）
const CONSULT_NET_ERROR = '通信に失敗しました。電波の良い場所で再度お試しください'
function consultApiError(e, fallback) { return showApiError(e, e && e.response ? fallback : CONSULT_NET_ERROR) }
const CONSULT_ST_BADGE = { open: '<span class="badge badge-yellow">未対応</span>', in_progress: '<span class="badge badge-blue">対応中</span>', done: '<span class="badge badge-green">対応済</span>' }
// 対象のシフトを選ばないと送れないカテゴリ（選べるシフトがある場合だけ）
const CONSULT_SHIFT_REQUIRED = ['absence']

function consultShiftLabel(s, multi) {
  return `${fmtDate(s.work_date)} ${s.start_time}〜${s.end_time} ${s.project_name || ''}${multi ? `（${s.company_name}）` : ''}${s.status === 'requested' ? '［希望（仮）］' : ''}`
}

window.renderConsult = async function () {
  loading()
  // ヘッダーと下のメニューは『その他』の扱い（#consult から開いた場合も）
  document.getElementById('header-title').textContent = '相談・連絡'
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === 'more'))
  let data
  try { data = (await axios.get('/api/staff/consultations')).data } catch (e) {
    $app.innerHTML = `<section class="card p-4 text-center"><p class="text-sm text-red-600 mb-3">${esc((e && e.response && e.response.data && e.response.data.error) || (e && e.response ? '相談・連絡を読み込めませんでした' : CONSULT_NET_ERROR))}</p>
      <button class="btn btn-outline" data-action="consultReload"><i class="fas fa-rotate-right"></i>再読み込み</button></section>`
    return
  }
  const companies = data.companies || []
  const targets = data.targets || []
  const multi = companies.length > 1
  const coName = (cid) => (companies.find(c => c.company_id === cid) || {}).company_name || ''
  // 既定の対象: 今日のシフト（複数あれば最初のもの）。既定の送り先: そのシフトの会社、なければ今の会社
  const todayShift = targets.find(s => s.work_date === data.today)
  $app.innerHTML = `
    <h2 class="font-bold text-gray-800 mb-3 px-1"><i class="fas fa-comments text-blue-600 mr-1"></i>相談・連絡</h2>
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
            </select>` : `<p class="text-sm font-bold text-gray-800">${esc(companies[0] ? companies[0].company_name : '')}</p>`}
          <p id="c-company-note" class="text-xs text-gray-400 mt-1">${multi ? '選んだ会社の管理者に届きます。シフトを選ぶと、そのシフトの会社に届きます' : 'この会社の管理者に届きます'}</p>
        </div>
        <div>
          <label class="text-sm text-gray-600 block mb-1" for="c-body">内容</label>
          <textarea id="c-body" rows="4" class="inp" maxlength="2000" placeholder="相談内容を入力してください" required></textarea>
        </div>
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
      ${(data.consultations || []).map(co => `
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
          ${co.manager_reply ? `<div class="mt-2 bg-blue-50 rounded-lg px-3 py-2"><p class="text-xs font-bold text-blue-700 mb-0.5"><i class="fas fa-reply mr-1"></i>管理者からの返信</p><p class="text-sm text-blue-900 whitespace-pre-wrap break-words">${esc(co.manager_reply)}</p></div>` : ''}
        </div>`).join('') || '<p class="text-center text-gray-400 py-6">相談履歴はありません</p>'}
    </div>`

  // シフトを選んだら、送り先はそのシフトの会社に固定する
  const shiftSel = document.getElementById('c-shift')
  const companySel = document.getElementById('c-company')
  const syncCompany = () => {
    const s = targets.find(x => String(x.shift_id) === shiftSel.value)
    if (companySel) {
      if (s) companySel.value = String(s.company_id)
      companySel.disabled = !!s
    }
    const note = document.getElementById('c-company-note')
    if (note && multi) note.textContent = s ? `このシフトの会社（${s.company_name}）の管理者に届きます` : '選んだ会社の管理者に届きます。シフトを選ぶと、そのシフトの会社に届きます'
  }
  shiftSel.addEventListener('change', syncCompany)
  syncCompany()

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
      const to = res.company_name || coName(payload.company_id)
      toast(`${to ? to + 'に' : ''}送信しました。管理者からの返信をお待ちください`)
      renderConsult()
    })
  })
}
delegate('consultReload', () => renderConsult())

// 研修・マニュアル（#74）: シフトに入っている案件の『案件マニュアル・注意事項』と『求められる内容』（管理画面の案件に登録したもの）
window.renderManual = async function () {
  loading()
  let data
  try { data = (await axios.get('/api/staff/manuals')).data } catch (e) { showLoadError(e); return }
  const list = data.projects || []
  $app.innerHTML = `
    <button class="text-sm text-blue-600 mb-3" onclick="renderMore()"><i class="fas fa-chevron-left mr-1"></i>戻る</button>
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
          ${m.requirements ? `<div class="mt-3"><p class="text-xs font-bold text-gray-500 mb-1">求められる内容</p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(m.requirements)}</p></div>` : ''}
          ${m.manual_text ? `<div class="mt-3"><p class="text-xs font-bold text-gray-500 mb-1">案件マニュアル・注意事項</p><p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(m.manual_text)}</p></div>` : ''}
          ${has ? '' : '<p class="text-xs text-gray-400 mt-3">この案件のマニュアルはまだ登録されていません。分からないことは相談・連絡から管理者に確認してください</p>'}
        </details>`
      }).join('') || '<p class="text-center text-gray-400 py-10">表示できるマニュアルはありません（シフトに入っている案件のマニュアルが表示されます）</p>'}
    </div>`
}

// ============ ルーティング ============
const routes = { home: renderHome, shift: () => renderShifts(), report: renderReportWithHistory, perf: () => renderPerf(), more: renderMore,
  attendance: () => (window.renderStaffAttendance ? renderStaffAttendance() : renderHome()),
  notifications: () => (window.renderStaffNotifications ? renderStaffNotifications() : renderHome()) }
const titles = { home: 'ホーム', shift: 'シフト', report: '日報入力', perf: '実績', more: 'その他', attendance: '打刻履歴・修正申請', notifications: '通知' }

// 画面を描く。読み込みに失敗したら、読み込み中のまま止めずに再読み込みのボタンを出す（#182）。描き終わるまで待てる Promise を返す
function route() {
  const tab = (location.hash || '#home').slice(1).split('/')[0]
  const fn = routes[tab] || renderHome
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === (tab === 'attendance' || tab === 'notifications' ? 'more' : tab)))
  document.getElementById('header-title').textContent = titles[tab] || 'ホーム'
  return Promise.resolve().then(fn).catch(showLoadError)
}

// 相談・連絡（ホームの返信バナーから開く。#320）
routes.consult = () => renderConsult()

window.addEventListener('hashchange', route)

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
