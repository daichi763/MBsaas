// Field OS スタッフ用SPA
const $app = document.getElementById('app')
let ME = null
let HOME = null

const REPORT_LABELS = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', check_out: '退店報告' }
const REPORT_ICONS = { wake_up: 'fa-sun', departure: 'fa-person-walking-luggage', check_in: 'fa-store', check_out: 'fa-door-open' }
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
async function renderHome() {
  loading()
  const { data } = await axios.get('/api/staff/home')
  HOME = data
  const s = data.shift
  const r = data.reports
  const order = ['wake_up', 'departure', 'check_in', 'check_out']
  const nextIdx = order.findIndex(t => !r[t])

  let shiftCard
  if (s) {
    shiftCard = `
    <section class="card p-4 mb-4" id="today-shift">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-bold text-gray-800"><i class="fas fa-calendar-check text-blue-600 mr-1"></i>今日の稼働</h2>
        <span class="badge badge-blue">${esc(fmtDate(data.today))}</span>
      </div>
      <p class="text-lg font-bold text-gray-900">${esc(s.project_name)}</p>
      <p class="text-sm text-gray-600 mt-0.5"><i class="fas fa-location-dot text-gray-400 mr-1"></i>${esc(s.location)}</p>
      <p class="text-sm text-gray-600"><i class="far fa-clock text-gray-400 mr-1"></i>${esc(s.start_time)} 〜 ${esc(s.end_time)}</p>
    </section>
    <section class="mb-4" id="attendance-section">
      <h2 class="font-bold text-gray-800 mb-2 px-1">本日の報告 ${nextIdx === -1 && data.daily_report_done ? '<span class="badge badge-green ml-1">すべて完了</span>' : ''}</h2>
      <div class="space-y-2.5">
        ${order.map((t, i) => {
          const done = !!r[t]
          const isNext = i === nextIdx
          const needsPhoto = PHOTO_REQUIRED_TYPES.includes(t)
          const onclick = needsPhoto ? `openPhotoAttendance('${t}', ${s.shift_id})` : `submitAttendance('${t}', ${s.shift_id})`
          return `<button class="report-btn ${done ? 'done' : isNext ? 'next' : ''}" ${done || !isNext ? 'disabled' : ''} onclick="${onclick}">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${done ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}">
              <i class="fas ${done ? 'fa-check' : REPORT_ICONS[t]}"></i>
            </span>
            <span class="flex-1">
              <span class="block font-bold ${done ? 'text-emerald-700' : isNext ? 'text-blue-700' : 'text-gray-500'}">${REPORT_LABELS[t]}</span>
              <span class="block text-xs ${done ? 'text-emerald-600' : 'text-gray-400'}">
                ${done ? '報告済み ' + dayjs(r[t].reported_at).format('HH:mm') : isNext ? 'タップして報告' : '前の報告を先に行ってください'}
                ${t === 'check_in' && !done ? ' (位置情報・写真が必要です)' : ''}
                ${t === 'check_out' && !done ? ' (写真が必要です)' : ''}
              </span>
            </span>
            ${isNext ? '<i class="fas fa-chevron-right text-blue-400"></i>' : ''}
          </button>`
        }).join('')}
        <button class="report-btn ${data.daily_report_done ? 'done' : r.check_out ? 'next' : ''}" onclick="location.hash='report'">
          <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${data.daily_report_done ? 'bg-emerald-500 text-white' : r.check_out ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}">
            <i class="fas ${data.daily_report_done ? 'fa-check' : 'fa-pen-to-square'}"></i>
          </span>
          <span class="flex-1">
            <span class="block font-bold ${data.daily_report_done ? 'text-emerald-700' : 'text-gray-700'}">日報・実績入力</span>
            <span class="block text-xs text-gray-400">${data.daily_report_done ? '提出済み（修正可）' : '稼働終了後に入力してください'}</span>
          </span>
          <i class="fas fa-chevron-right text-gray-300"></i>
        </button>
      </div>
    </section>`
  } else {
    shiftCard = `<section class="card p-6 mb-4 text-center text-gray-500">
      <i class="fas fa-mug-hot text-3xl text-gray-300 mb-2"></i>
      <p class="font-bold">今日の稼働予定はありません</p>
      <p class="text-xs mt-1">シフトタブから予定を確認できます</p>
    </section>`
  }

  const unread = (data.notices || []).filter(n => !n.is_read)
  $app.innerHTML = `
    ${unread.length ? `<div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800" role="alert">
      <i class="fas fa-bell mr-1"></i>未読のお知らせが <b>${unread.length}件</b> あります
      <a href="#more" onclick="setTimeout(()=>renderNotices(),50)" class="underline font-bold ml-1">確認する</a></div>` : ''}
    ${data.replied_consultations ? `<div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800" role="alert">
      <i class="fas fa-reply mr-1"></i>管理者から相談への返信があります</div>` : ''}
    ${shiftCard}
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
    </section>
    <div class="grid grid-cols-2 gap-3">
      <a href="#shift" class="card p-4 text-center"><i class="fas fa-calendar-days text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">シフト確認</span></a>
      <a href="#more" onclick="setTimeout(()=>renderConsult(),50)" class="card p-4 text-center"><i class="fas fa-comments text-blue-500 text-xl mb-1 block"></i><span class="text-sm font-bold text-gray-700">相談・連絡</span></a>
    </div>`
}

// 勤怠報告送信
window.submitAttendance = async function (type, shiftId) {
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
async function renderShifts(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  const { data } = await axios.get('/api/staff/shifts?month=' + month)
  const byDate = {}
  for (const s of data.shifts) { (byDate[s.work_date] = byDate[s.work_date] || []).push(s) }
  const today = dayjs().format('YYYY-MM-DD')
  const statusBadge = { requested: '<span class="badge badge-yellow">希望</span>', confirmed: '<span class="badge badge-green">確定</span>', absent: '<span class="badge badge-red">欠勤</span>', substitute: '<span class="badge badge-purple">代打</span>' }

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <button class="btn btn-outline" onclick="renderShifts('${dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-left"></i></button>
      <h2 class="font-bold text-gray-800">${dayjs(month + '-01').format('YYYY年M月')}</h2>
      <button class="btn btn-outline" onclick="renderShifts('${dayjs(month + '-01').add(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-right"></i></button>
    </div>
    <button class="btn btn-primary w-full mb-4" onclick="showShiftRequest()"><i class="fas fa-plus"></i>シフト希望を提出する</button>
    <div class="space-y-2" id="shift-list">
      ${Object.keys(byDate).sort().map(d => `
        <div class="card p-3.5 ${d === today ? 'ring-2 ring-blue-400' : ''}">
          <div class="flex items-center justify-between">
            <span class="font-bold ${d === today ? 'text-blue-700' : 'text-gray-800'}">${fmtDate(d)} ${d === today ? '<span class="badge badge-blue">今日</span>' : ''}</span>
          </div>
          ${byDate[d].map(s => `
            <div class="mt-1.5 flex items-center justify-between text-sm">
              <div>
                <p class="font-medium text-gray-700">${esc(s.project_name)}</p>
                <p class="text-xs text-gray-400">${esc(s.start_time)}〜${esc(s.end_time)} ${esc(s.location || '')}</p>
              </div>
              ${statusBadge[s.status] || ''}
            </div>`).join('')}
        </div>`).join('') || '<p class="text-center text-gray-400 py-10">この月のシフトはありません</p>'}
    </div>
    <div id="shift-modal"></div>`
}

window.showShiftRequest = function () {
  document.getElementById('shift-modal').innerHTML = `
    <div class="modal-bg" onclick="if(event.target===this)this.remove()">
      <div class="modal-box p-5">
        <h3 class="font-bold text-lg mb-4">シフト希望提出</h3>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-600 block mb-1">日付</label><input id="req-date" type="date" class="inp" min="${dayjs().format('YYYY-MM-DD')}"></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-sm text-gray-600 block mb-1">開始</label><input id="req-start" type="time" value="09:30" class="inp"></div>
            <div><label class="text-sm text-gray-600 block mb-1">終了</label><input id="req-end" type="time" value="19:00" class="inp"></div>
          </div>
          <div><label class="text-sm text-gray-600 block mb-1">備考</label><input id="req-memo" type="text" class="inp" placeholder="希望条件など"></div>
          <button class="btn btn-primary w-full" onclick="submitShiftRequest()">提出する</button>
        </div>
      </div>
    </div>`
}

window.submitShiftRequest = async function () {
  const date = document.getElementById('req-date').value
  if (!date) { toast('日付を選択してください'); return }
  await axios.post('/api/staff/shifts/request', {
    work_date: date,
    start_time: document.getElementById('req-start').value,
    end_time: document.getElementById('req-end').value,
    memo: document.getElementById('req-memo').value
  })
  toast('シフト希望を提出しました')
  renderShifts(date.slice(0, 7))
}

// ============ 日報入力 ============
async function renderReport() {
  loading()
  if (!HOME) { const { data } = await axios.get('/api/staff/home'); HOME = data }
  const s = HOME.shift
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
      <p class="text-xs text-gray-400">${fmtDate(HOME.today)} の日報 ${data.template ? '｜' + esc(data.template.template_name) : ''}</p>
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
      <button type="submit" class="btn btn-primary w-full py-3.5 text-base">${HOME.daily_report_done ? '日報を修正して再提出' : '日報を提出する'}</button>
    </form>`

  document.getElementById('report-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const values = {}
    document.querySelectorAll('.rpt-field').forEach(el => {
      const k = el.dataset.key
      values[k] = el.type === 'number' ? Number(el.value || 0) : el.value
    })
    await axios.post('/api/staff/daily-report', {
      project_id: s.project_id, shift_id: s.shift_id, work_date: HOME.today, values,
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
const routes = { home: renderHome, shift: () => renderShifts(), report: renderReport, perf: () => renderPerf(), more: renderMore }
const titles = { home: 'ホーム', shift: 'シフト', report: '日報入力', perf: '実績', more: 'その他' }

function route() {
  const tab = (location.hash || '#home').slice(1).split('/')[0]
  const fn = routes[tab] || renderHome
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab))
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
