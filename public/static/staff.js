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

axios.interceptors.response.use(r => r, e => {
  if (e.response && e.response.status === 401) location.href = '/login'
  return Promise.reject(e)
})

document.getElementById('logout-btn').addEventListener('click', async () => {
  await axios.post('/api/auth/logout'); location.href = '/login'
})

// ============ ホーム ============
// 描画は部分ごとの関数（シフトカード・報告ボタン・お知らせ・相談バナー・メニュー）を並べるだけにする
let HOME_SHIFT_ID = null   // ホームで選んだシフト（未選択ならサーバーが選ぶ）
let HOME_LOADED_DAY = null // ホームを読んだ日（端末の日付）

async function renderHome() {
  loading()
  const { data } = await axios.get('/api/staff/home' + (HOME_SHIFT_ID ? '?shift_id=' + encodeURIComponent(HOME_SHIFT_ID) : ''))
  HOME = data
  HOME_LOADED_DAY = dayjs().format('YYYY-MM-DD')
  $app.innerHTML = `
    <div id="notif-banner"></div>
    ${homeNoticeBannerHtml(data)}
    ${homeConsultBannerHtml(data)}
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

// シフトカード
function homeShiftCardHtml(data) {
  const s = data.shift
  return `
    <section class="card p-4 mb-4" id="today-shift">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-bold text-gray-800"><i class="fas fa-calendar-check text-blue-600 mr-1"></i>${data.carryover ? '昨日からの勤務' : '今日の稼働'}</h2>
        <span class="badge ${data.carryover ? 'badge-yellow' : 'badge-blue'}">${esc(fmtDate(s.work_date || data.today))}</span>
      </div>
      <p class="text-lg font-bold text-gray-900">${esc(s.project_name)}</p>
      <p class="text-sm text-gray-600 mt-0.5"><i class="fas fa-location-dot text-gray-400 mr-1"></i>${esc(s.location)}</p>
      <p class="text-sm text-gray-600"><i class="far fa-clock text-gray-400 mr-1"></i>${esc(s.start_time)} 〜 ${esc(s.end_time)}</p>
      ${data.carryover ? '<p class="text-xs mt-2 text-amber-800 bg-amber-50 rounded-lg px-2 py-1"><i class="fas fa-moon mr-1"></i>日付をまたぐ勤務です。勤務終了・退店などは、このまま報告できます。</p>' : ''}
    </section>`
}

// 報告ボタン（勤怠報告と日報）
function homeReportButtonsHtml(data) {
  const s = data.shift
  const r = data.reports
  // 提出設定（案件・スタッフ・シフトごと）で必要な報告だけを表示する
  const order = (data.required_attendance || ['wake_up', 'departure', 'check_in', 'check_out'])
  const dailyRequired = data.daily_report_required !== false
  const nextIdx = order.findIndex(t => !r[t])
  const allDone = nextIdx === -1 && (!dailyRequired || data.daily_report_done)
  // ほかのシフトで、報告は済んだが日報が未提出のもの（1日に複数のシフトがある場合）
  const pendingDaily = (data.today_shifts || []).filter(x => x.shift_id !== s.shift_id && x.attendance_done && x.daily_report_required && !x.daily_report_done)
  return `
    <section class="mb-4" id="attendance-section">
      <h2 class="font-bold text-gray-800 mb-2 px-1 flex items-center">${data.carryover ? '勤務の報告' : '本日の報告'} ${allDone ? '<span class="badge badge-green ml-1">すべて完了</span>' : ''}
        <a href="#attendance" class="ml-auto text-xs font-normal text-blue-600"><i class="fas fa-user-clock mr-0.5"></i>打刻の修正・追加</a></h2>
      ${!order.length && !dailyRequired ? '<p class="card p-4 text-sm text-gray-500">このシフトは勤怠報告・日報の提出は不要です</p>' : ''}
      ${pendingDaily.map(x => `<button class="w-full text-left bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mb-2.5 text-sm text-amber-800" onclick="location.hash='report/${Number(x.shift_id)}'">
        <i class="fas fa-pen-to-square mr-1"></i>${esc(x.start_time)}〜 ${esc(x.project_name)} の日報が未提出です<span class="underline font-bold ml-1">入力する</span></button>`).join('')}
      <div class="space-y-2.5">
        ${order.map((t, i) => {
          const done = !!r[t]
          const isNext = i === nextIdx
          const photoOn = data.photo_required_attendance !== false
          const needsPhoto = photoOn && PHOTO_REQUIRED_TYPES.includes(t)
          const onclick = needsPhoto ? `openPhotoAttendance('${t}', ${s.shift_id})` : `submitAttendance('${t}', ${s.shift_id})`
          return `<button class="report-btn ${done ? 'done' : isNext ? 'next' : ''}" ${done || !isNext ? 'disabled' : ''} onclick="${onclick}">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${done ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}">
              <i class="fas ${done ? 'fa-check' : REPORT_ICONS[t]}"></i>
            </span>
            <span class="flex-1">
              <span class="block font-bold ${done ? 'text-emerald-700' : isNext ? 'text-blue-700' : 'text-gray-500'}">${REPORT_LABELS[t]}</span>
              <span class="block text-xs ${done ? 'text-emerald-600' : 'text-gray-400'}">
                ${done ? '報告済み ' + dayjs(r[t].reported_at).format('HH:mm') : isNext ? 'タップして報告' : '前の報告を先に行ってください'}
                ${t === 'check_in' && !done ? (photoOn ? ' (位置情報・写真が必要です)' : ' (位置情報を取得します)') : ''}
                ${t === 'check_out' && !done && photoOn ? ' (写真が必要です)' : ''}
              </span>
            </span>
            ${isNext ? '<i class="fas fa-chevron-right text-blue-400"></i>' : ''}
          </button>`
        }).join('')}
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

// 相談バナー（管理者から返信がある場合）
function homeConsultBannerHtml(data) {
  return data.replied_consultations ? `<div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800" role="alert">
      <i class="fas fa-reply mr-1"></i>管理者から相談への返信があります</div>` : ''
}

// メニュー
function homeMenuHtml() {
  return `
    <div class="grid grid-cols-2 gap-3">
      <a href="#shift" class="card p-4 text-center"><i class="fas fa-calendar-days text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">シフト確認</span></a>
      <a href="#more" onclick="setTimeout(()=>renderConsult(),50)" class="card p-4 text-center"><i class="fas fa-comments text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">相談・連絡</span></a>
    </div>`
}

// 勤怠報告送信
window.submitAttendance = async function (type, shiftId) {
  if (homeIsStale()) { toast('日付が変わったため、画面を更新しました'); return }
  const doPost = async (pos) => {
    try {
      await axios.post('/api/staff/attendance', {
        shift_id: shiftId, report_type: type,
        latitude: pos ? pos.coords.latitude : null,
        longitude: pos ? pos.coords.longitude : null,
        address: null
      })
      toast(REPORT_LABELS[type] + 'を送信しました')
      renderHome()
    } catch (e) {
      toast((e.response && e.response.data && e.response.data.error) || '送信に失敗しました')
    }
  }
  if (type === 'check_in' && navigator.geolocation) {
    toast('位置情報を取得しています...')
    navigator.geolocation.getCurrentPosition(
      pos => doPost(pos),
      () => { toast('位置情報が取得できませんでした（位置なしで送信します）'); doPost(null) },
      { timeout: 8000 }
    )
  } else {
    doPost(null)
  }
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
      setPhotoError((e.response && e.response.data && e.response.data.error) || '通信に失敗しました。電波の良い場所で再度お試しください')
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i>送信する' }
    }
  }

  if (type === 'check_in' && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => send(pos), () => send(null), { timeout: 8000 })
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
  const { data } = await axios.get('/api/staff/shifts?month=' + month)
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
      ${canReply ? `<div class="flex gap-2 mt-1.5">
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

  // 1つのシフトにつき .mt-1.5 の行を1つだけ出す（staff-profile.js が他社シフトの会社名を行の順番で付けるため）
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
            <div class="mt-1.5 flex items-center justify-between text-sm">
              <div>
                <p class="font-medium text-gray-700">${esc(s.project_name)}</p>
                <p class="text-xs text-gray-400">${esc(s.start_time)}〜${esc(s.end_time)} ${esc(s.location || '')}</p>
              </div>
              ${statusBadge[s.status] || ''}
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
  const { data } = await axios.get('/api/staff/report-template/' + s.project_id)
  const fields = (data.template && data.template.fields) || []
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
    </section>
    <form id="report-form" class="space-y-4 pb-8">
      <section class="card p-4">
        <h3 class="font-bold text-gray-700 mb-3 text-sm"><i class="fas fa-hashtag text-blue-500 mr-1"></i>実績件数</h3>
        <div class="grid grid-cols-2 gap-3">
          ${numFields.map(f => `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}</label>
              <input type="number" inputmode="numeric" min="0" data-key="${esc(f.key)}" class="inp rpt-field text-center text-lg font-bold" value="0">
            </div>`).join('')}
        </div>
      </section>
      <section class="card p-4">
        <h3 class="font-bold text-gray-700 mb-3 text-sm"><i class="fas fa-message text-blue-500 mr-1"></i>報告事項</h3>
        <div class="space-y-3">
          ${textFields.map(f => `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}</label>
              ${f.type === 'textarea'
                ? `<textarea data-key="${esc(f.key)}" rows="3" class="inp rpt-field" placeholder="${esc(f.label)}を入力"></textarea>`
                : `<input type="text" data-key="${esc(f.key)}" class="inp rpt-field" placeholder="${esc(f.label)}を入力">`}
            </div>`).join('')}
        </div>
      </section>
      <section class="card p-4">
        <label class="flex items-center gap-3 py-1"><input id="incident-flag" type="checkbox" class="w-5 h-5 rounded"><span class="text-sm font-medium text-gray-700">インシデントがあった</span></label>
        <label class="flex items-center gap-3 py-1"><input id="complaint-flag" type="checkbox" class="w-5 h-5 rounded"><span class="text-sm font-medium text-gray-700">クレームがあった</span></label>
      </section>
      <button type="submit" class="btn btn-primary w-full py-3.5 text-base">${s.daily_report_done ? '日報を修正して再提出' : '日報を提出する'}</button>
    </form>`

  const sel = document.getElementById('report-shift')
  if (sel) sel.addEventListener('change', () => { location.hash = 'report/' + Number(sel.value) })
  document.getElementById('report-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const values = {}
    document.querySelectorAll('.rpt-field').forEach(el => {
      const k = el.dataset.key
      values[k] = el.type === 'number' ? Number(el.value || 0) : el.value
    })
    // 稼働日はシフトの稼働日（日をまたぐ勤務や、開いたまま日付が変わった場合も前日の日付で送る）
    await axios.post('/api/staff/daily-report', {
      project_id: s.project_id, shift_id: s.shift_id, work_date: s.work_date, values,
      incident_flag: document.getElementById('incident-flag').checked,
      complaint_flag: document.getElementById('complaint-flag').checked
    })
    toast('日報を提出しました。お疲れさまでした！')
    HOME = null
    location.hash = 'home'
  })
}

async function loadPastReports() {
  const { data } = await axios.get('/api/staff/my-reports')
  const el = document.getElementById('past-reports')
  if (!el) return
  el.innerHTML = data.reports.map(r => `
    <div class="card p-3.5 mb-2">
      <div class="flex justify-between items-center">
        <span class="font-bold text-sm text-gray-800">${fmtDate(r.work_date)}</span>
        <span class="text-xs text-gray-400">${esc(r.project_name)}</span>
      </div>
      ${r.manager_comment ? `<p class="text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-1.5"><i class="fas fa-comment-dots mr-1"></i>${esc(r.manager_comment)}</p>` : ''}
    </div>`).join('') || '<p class="text-sm text-gray-400">日報履歴はありません</p>'
}

// ============ 実績 ============
async function renderPerf(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  const { data } = await axios.get('/api/staff/performance?month=' + month)
  const LABELS = { mnp: 'MNP', pi: 'PI', shinki: '新規', kishuhen: '機種変更', hikari: '光回線', wifi: '置き型Wi-Fi', denki: 'でんき', card: 'クレカ', koekake: '声かけ', shodan: '商談', seiyaku: '成約' }
  const mainKeys = ['mnp', 'pi', 'shinki', 'kishuhen', 'hikari', 'seiyaku'].filter(k => data.totals[k] != null)
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button class="btn btn-outline" onclick="renderPerf('${dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-left"></i></button>
      <h2 class="font-bold text-gray-800">${dayjs(month + '-01').format('YYYY年M月')}の実績</h2>
      <button class="btn btn-outline" onclick="renderPerf('${dayjs(month + '-01').add(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-right"></i></button>
    </div>
    <div class="grid grid-cols-3 gap-3 mb-4">
      ${mainKeys.map(k => `
        <div class="card p-3 text-center">
          <p class="text-2xl font-bold text-blue-600">${data.totals[k] || 0}</p>
          <p class="text-xs text-gray-500 mt-0.5">${LABELS[k] || k}</p>
        </div>`).join('') || '<p class="col-span-3 text-center text-gray-400 py-8">この月の実績データはありません</p>'}
    </div>
    ${Object.keys(data.totals).filter(k => !mainKeys.includes(k)).length ? `
    <div class="card p-4 mb-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">その他の実績</h3>
      <div class="flex flex-wrap gap-2">
        ${Object.entries(data.totals).filter(([k]) => !mainKeys.includes(k)).map(([k, v]) => `<span class="badge badge-gray">${LABELS[k] || k}: <b class="ml-0.5">${v}</b></span>`).join('')}
      </div>
    </div>` : ''}
    <h3 class="font-bold text-gray-700 mb-2 px-1">日別実績</h3>
    <div class="space-y-2">
      ${data.daily.slice().reverse().map(d => `
        <div class="card p-3.5">
          <div class="flex justify-between items-center">
            <span class="font-bold text-sm text-gray-800">${fmtDate(d.date)}</span>
            <span class="text-xs text-gray-400">${esc(d.project)}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-1.5">
            ${Object.entries(d).filter(([k, v]) => !['date', 'project', 'comment'].includes(k) && v > 0).map(([k, v]) => `<span class="badge badge-blue">${LABELS[k] || k} ${v}</span>`).join('') || '<span class="text-xs text-gray-400">実績なし</span>'}
          </div>
          ${d.comment ? `<p class="text-xs bg-blue-50 text-blue-800 rounded-lg px-2.5 py-1.5 mt-2"><i class="fas fa-comment-dots mr-1"></i>${esc(d.comment)}</p>` : ''}
        </div>`).join('') || '<p class="text-center text-gray-400 py-6">データがありません</p>'}
    </div>`
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

window.renderConsult = async function () {
  loading()
  const { data } = await axios.get('/api/staff/consultations')
  const stBadge = { open: '<span class="badge badge-yellow">未対応</span>', in_progress: '<span class="badge badge-blue">対応中</span>', done: '<span class="badge badge-green">対応済</span>' }
  $app.innerHTML = `
    <h2 class="font-bold text-gray-800 mb-3 px-1"><i class="fas fa-comments text-blue-600 mr-1"></i>相談・連絡</h2>
    <section class="card p-4 mb-4">
      <form id="consult-form" class="space-y-3">
        <div>
          <label class="text-sm text-gray-600 block mb-1">カテゴリ</label>
          <select id="c-cat" class="inp">
            ${Object.entries(CAT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-sm text-gray-600 block mb-1">内容</label>
          <textarea id="c-body" rows="3" class="inp" placeholder="相談内容を入力してください" required></textarea>
        </div>
        <div>
          <label class="text-sm text-gray-600 block mb-1">緊急度</label>
          <div class="grid grid-cols-3 gap-2">
            <label class="flex items-center justify-center gap-1 border border-gray-200 rounded-lg py-2 text-sm has-[:checked]:bg-blue-50 has-[:checked]:border-blue-400"><input type="radio" name="urgency" value="low" class="hidden">低</label>
            <label class="flex items-center justify-center gap-1 border border-gray-200 rounded-lg py-2 text-sm has-[:checked]:bg-blue-50 has-[:checked]:border-blue-400"><input type="radio" name="urgency" value="normal" checked class="hidden">中</label>
            <label class="flex items-center justify-center gap-1 border border-gray-200 rounded-lg py-2 text-sm has-[:checked]:bg-red-50 has-[:checked]:border-red-400"><input type="radio" name="urgency" value="high" class="hidden">高</label>
          </div>
        </div>
        <button type="submit" class="btn btn-primary w-full">送信する</button>
      </form>
    </section>
    <h3 class="font-bold text-gray-700 mb-2 px-1">相談履歴</h3>
    <div class="space-y-2">
      ${data.consultations.map(co => `
        <div class="card p-4">
          <div class="flex items-center gap-2 mb-1">
            <span class="badge badge-gray">${CAT_LABELS[co.category] || co.category}</span>
            ${co.urgency === 'high' ? '<span class="badge badge-red">緊急</span>' : ''}
            ${stBadge[co.status] || ''}
            <span class="text-xs text-gray-400 ml-auto">${dayjs(co.created_at).format('M/D HH:mm')}</span>
          </div>
          <p class="text-sm text-gray-700 whitespace-pre-wrap">${esc(co.body)}</p>
          ${co.manager_reply ? `<div class="mt-2 bg-blue-50 rounded-lg px-3 py-2"><p class="text-xs font-bold text-blue-700 mb-0.5"><i class="fas fa-reply mr-1"></i>管理者からの返信</p><p class="text-sm text-blue-900">${esc(co.manager_reply)}</p></div>` : ''}
        </div>`).join('') || '<p class="text-center text-gray-400 py-6">相談履歴はありません</p>'}
    </div>`
  document.getElementById('consult-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = document.getElementById('c-body').value.trim()
    if (!body) return
    await axios.post('/api/staff/consultations', {
      category: document.getElementById('c-cat').value,
      body,
      urgency: (document.querySelector('input[name=urgency]:checked') || {}).value || 'normal'
    })
    toast('送信しました。管理者からの返信をお待ちください')
    renderConsult()
  })
}

window.renderManual = function () {
  $app.innerHTML = `
    <h2 class="font-bold text-gray-800 mb-3 px-1"><i class="fas fa-book-open text-blue-600 mr-1"></i>研修・マニュアル</h2>
    <div class="space-y-2">
      ${[
        { t: '携帯ショップ稼働 基本マニュアル', d: '入店〜退店までの基本フロー', done: true },
        { t: 'MNP獲得トークスクリプト', d: '声かけ〜クロージングまで', done: true },
        { t: '光回線+でんきセット訴求資料（7月版）', d: '今月のキャンペーン内容', done: false },
        { t: 'クレーム初期対応マニュアル', d: 'エスカレーションルール', done: false },
      ].map(m => `
        <div class="card p-4 flex items-center gap-3">
          <span class="w-10 h-10 rounded-lg ${m.done ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-100 text-gray-400'} flex items-center justify-center"><i class="fas ${m.done ? 'fa-circle-check' : 'fa-file-lines'}"></i></span>
          <div class="flex-1">
            <p class="font-bold text-sm text-gray-800">${m.t}</p>
            <p class="text-xs text-gray-400">${m.d}</p>
          </div>
          ${m.done ? '<span class="badge badge-green">受講済</span>' : '<span class="badge badge-yellow">未受講</span>'}
        </div>`).join('')}
    </div>
    <p class="text-xs text-gray-400 text-center mt-4">※ 教育管理機能はPhase 4で拡張予定です</p>`
}

// ============ ルーティング ============
const routes = { home: renderHome, shift: () => renderShifts(), report: renderReport, perf: () => renderPerf(), more: renderMore,
  attendance: () => (window.renderStaffAttendance ? renderStaffAttendance() : renderHome()),
  notifications: () => (window.renderStaffNotifications ? renderStaffNotifications() : renderHome()) }
const titles = { home: 'ホーム', shift: 'シフト', report: '日報入力', perf: '実績', more: 'その他', attendance: '打刻履歴・修正申請', notifications: '通知' }

function route() {
  const tab = (location.hash || '#home').slice(1).split('/')[0]
  const fn = routes[tab] || renderHome
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === (tab === 'attendance' || tab === 'notifications' ? 'more' : tab)))
  document.getElementById('header-title').textContent = titles[tab] || 'ホーム'
  fn()
}

window.addEventListener('hashchange', route)

;(async () => {
  try {
    const { data } = await axios.get('/api/auth/me')
    ME = data
    document.getElementById('user-name').textContent = data.name
  } catch (e) { return }
  route()
})()
