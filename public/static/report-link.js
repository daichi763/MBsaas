// =========================================================
// シフト専用の報告用URL（/r/:token）。ログイン不要で、そのシフトの勤怠報告・日報だけを行う
// docs/spec_spot_shift.md 第2段階。API: /api/public/report/:token
// =========================================================
(function () {
  const $app = document.getElementById('app')
  const TOKEN = location.pathname.split('/').pop()
  const API = '/api/public/report/' + encodeURIComponent(TOKEN)
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', check_out: '退店報告' }
  const ICON = { wake_up: 'fa-sun', departure: 'fa-person-walking-luggage', check_in: 'fa-store', check_out: 'fa-door-open' }
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const TARGET_BYTES = 480 * 1024, MAX_EDGE = 1600
  let DATA = null, pending = null

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d
  const fmt = (d) => { const x = dayjs(d); return `${x.format('M/D')}(${WD[x.day()]})` }
  function toast(msg) {
    let root = document.getElementById('toast'); if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
    const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg; root.appendChild(el); setTimeout(() => el.remove(), 2500)
  }
  function modal(html) { document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-box p-5">${html}</div></div>` }
  window.closeModal = () => { document.getElementById('modal-root').innerHTML = ''; pending = null }

  async function load() {
    $app.innerHTML = '<div class="flex justify-center py-16"><span class="spin"></span></div>'
    try { DATA = (await axios.get(API)).data } catch (e) {
      $app.innerHTML = `<section class="card p-6 text-center mt-6"><i class="fas fa-link-slash text-3xl text-gray-300 mb-2 block"></i>
        <p class="font-bold text-gray-700">${esc(errMsg(e, 'このURLは利用できません'))}</p><p class="text-xs text-gray-400 mt-2">担当者に新しいURLを依頼してください</p></section>`
      return
    }
    render()
  }

  function render() {
    const d = DATA, s = d.shift
    const done = new Set(d.reports.map(r => r.report_type))
    const order = d.modes.required_attendance
    const nextIdx = order.findIndex(t => !done.has(t))
    const isToday = s.work_date === d.today
    $app.innerHTML = `
      <section class="card p-4 mb-4" id="report-link-shift">
        <p class="text-xs text-gray-400">${esc(d.company_name)}</p>
        <p class="text-sm text-gray-600 mt-1">${esc(d.staff_name)} さん</p>
        <p class="text-lg font-bold text-gray-900 mt-1">${esc(d.project_name)}</p>
        <p class="text-sm text-gray-600 mt-0.5"><i class="fas fa-location-dot text-gray-400 mr-1"></i>${esc(s.location || '')}</p>
        <p class="text-sm text-gray-600"><i class="far fa-calendar text-gray-400 mr-1"></i>${fmt(s.work_date)} <i class="far fa-clock text-gray-400 ml-2 mr-1"></i>${esc(s.start_time)} 〜 ${esc(s.end_time)}</p>
        ${!isToday && d.today < s.work_date ? `<p class="text-xs text-amber-700 bg-amber-50 rounded p-2 mt-2">報告は稼働日当日に行えます</p>` : ''}
      </section>
      ${order.length ? `<section class="mb-4 space-y-2.5" id="report-link-attendance">
        <h2 class="font-bold text-gray-800 px-1">勤怠報告</h2>
        ${order.map((t, i) => {
          const r = d.reports.find(x => x.report_type === t); const isNext = i === nextIdx
          return `<button class="report-btn ${r ? 'done' : isNext ? 'next' : ''}" ${r || !isNext ? 'disabled' : ''} onclick="linkReport('${t}')">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${r ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}"><i class="fas ${r ? 'fa-check' : ICON[t]}"></i></span>
            <span class="flex-1 text-left"><span class="block font-bold ${r ? 'text-emerald-700' : isNext ? 'text-blue-700' : 'text-gray-500'}">${LABEL[t]}</span>
              <span class="block text-xs ${r ? 'text-emerald-600' : 'text-gray-400'}">${r ? '報告済み ' + dayjs(r.reported_at).format('HH:mm') : isNext ? 'タップして報告' : '前の報告を先に行ってください'}${!r && d.photo_required && ['check_in', 'check_out'].includes(t) ? '（写真が必要です）' : ''}</span></span>
          </button>`
        }).join('')}
      </section>` : ''}
      ${d.modes.daily_report_required ? `<section class="card p-4 mb-4" id="report-link-daily">
        <h2 class="font-bold text-gray-800 mb-1">日報 ${d.daily_report ? '<span class="badge badge-green ml-1">提出済み</span>' : ''}</h2>
        <p class="text-xs text-gray-400 mb-3">${d.daily_report ? '提出済み（' + dayjs(d.daily_report.submitted_at).format('M/D HH:mm') + '）。修正して再提出できます' : '稼働終了後に入力してください'}</p>
        <form id="link-daily-form" class="space-y-3">
          ${(d.template ? d.template.fields : []).map(f => {
            const v = d.daily_report && d.daily_report.values ? d.daily_report.values[f.key] : ''
            if (f.type === 'number') return `<div class="flex items-center gap-3"><label class="text-sm text-gray-600 flex-1 min-w-0">${esc(f.label)}</label><input type="number" inputmode="numeric" min="0" data-key="${esc(f.key)}" class="inp link-field text-center font-bold shrink-0" style="width:6rem" value="${esc(v === '' || v == null ? 0 : v)}"></div>`
            if (f.type === 'textarea') return `<div><label class="text-sm text-gray-600 block mb-1">${esc(f.label)}</label><textarea data-key="${esc(f.key)}" rows="3" class="inp link-field">${esc(v || '')}</textarea></div>`
            return `<div><label class="text-sm text-gray-600 block mb-1">${esc(f.label)}</label><input data-key="${esc(f.key)}" class="inp link-field" value="${esc(v || '')}"></div>`
          }).join('') || `<div><label class="text-sm text-gray-600 block mb-1">報告内容</label><textarea data-key="free" rows="4" class="inp link-field">${esc((d.daily_report && d.daily_report.values && d.daily_report.values.free) || '')}</textarea></div>`}
          <label class="flex items-center gap-3"><input id="link-incident" type="checkbox" class="w-5 h-5">インシデントがあった</label>
          <label class="flex items-center gap-3"><input id="link-complaint" type="checkbox" class="w-5 h-5">クレームがあった</label>
          <button class="btn btn-primary w-full py-3">${d.daily_report ? '日報を修正して再提出' : '日報を提出する'}</button>
        </form>
      </section>` : ''}
      ${!order.length && !d.modes.daily_report_required ? '<section class="card p-6 text-center text-sm text-gray-500">このシフトは報告の提出は不要です</section>' : ''}
      <p class="text-[11px] text-gray-400 text-center mt-6">このURLは ${dayjs(d.expires_at).format('M/D HH:mm')} まで有効です。他の人に共有しないでください</p>`
    const form = document.getElementById('link-daily-form')
    if (form) form.addEventListener('submit', submitDaily)
  }

  window.linkReport = function (type) {
    const needsPhoto = DATA.photo_required && ['check_in', 'check_out'].includes(type)
    if (!needsPhoto) return sendAttendance(type, null)
    pending = { type, blob: null, url: null }
    modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas ${ICON[type]} text-blue-600 mr-1"></i>${LABEL[type]}</h3>
      <p class="text-sm text-gray-500 mb-3">現場の様子が分かる写真を1枚添付してください</p>
      <div id="link-photo-area"></div>
      <input type="file" id="link-photo-camera" accept="image/*" capture="environment" class="hidden" onchange="linkPhoto(this.files[0])">
      <input type="file" id="link-photo-album" accept="image/*" class="hidden" onchange="linkPhoto(this.files[0])">
      <p id="link-photo-err" class="text-sm text-red-600 mt-2"></p>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button id="link-photo-send" class="btn btn-primary flex-1" disabled onclick="linkSendPhoto()"><i class="fas fa-paper-plane"></i>送信する</button></div>`)
    drawPhoto()
  }
  function drawPhoto() {
    const a = document.getElementById('link-photo-area'); if (!a) return
    a.innerHTML = pending.url ? `<img src="${pending.url}" class="w-full rounded-xl border max-h-64 object-cover" alt="プレビュー">`
      : `<div class="grid grid-cols-2 gap-2"><button class="btn btn-outline" onclick="document.getElementById('link-photo-camera').click()"><i class="fas fa-camera"></i>カメラで撮影</button>
         <button class="btn btn-outline" onclick="document.getElementById('link-photo-album').click()"><i class="fas fa-images"></i>アルバムから選択</button></div>`
    const b = document.getElementById('link-photo-send'); if (b) b.disabled = !pending.blob
  }
  async function compress(file) {
    let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch { bmp = await createImageBitmap(file) }
    let { width, height } = bmp
    if (Math.max(width, height) > MAX_EDGE) { const k = MAX_EDGE / Math.max(width, height); width = Math.round(width * k); height = Math.round(height * k) }
    const cv = document.createElement('canvas'); cv.width = width; cv.height = height; cv.getContext('2d').drawImage(bmp, 0, 0, width, height)
    const toBlob = (q) => new Promise((ok, ng) => cv.toBlob(b => b ? ok(b) : ng(new Error('画像の変換に失敗しました')), 'image/jpeg', q))
    let q = 0.7, blob = await toBlob(q)
    while (blob.size > TARGET_BYTES && q > 0.35) { q -= 0.1; blob = await toBlob(q) }
    if (blob.size > TARGET_BYTES) throw new Error('画像を十分に圧縮できませんでした')
    return blob
  }
  window.linkPhoto = async function (file) {
    const err = document.getElementById('link-photo-err'); err.textContent = ''
    if (!file) return
    try { pending.blob = await compress(file); pending.url = URL.createObjectURL(pending.blob); drawPhoto() } catch (e) { err.textContent = e.message || '画像の処理に失敗しました' }
  }
  window.linkSendPhoto = function () { if (pending && pending.blob) sendAttendance(pending.type, pending.blob) }

  function sendAttendance(type, blob) {
    const post = async (pos) => {
      try {
        if (blob) {
          const f = new FormData(); f.append('report_type', type); f.append('photo', blob, 'attendance.jpg')
          if (pos) { f.append('latitude', String(pos.coords.latitude)); f.append('longitude', String(pos.coords.longitude)) }
          await axios.post(API + '/attendance', f)
        } else {
          await axios.post(API + '/attendance', { report_type: type, latitude: pos ? pos.coords.latitude : null, longitude: pos ? pos.coords.longitude : null })
        }
        closeModal(); toast(LABEL[type] + 'を送信しました'); load()
      } catch (e) {
        const el = document.getElementById('link-photo-err')
        if (el) el.textContent = errMsg(e, '送信に失敗しました'); else toast(errMsg(e, '送信に失敗しました'))
      }
    }
    if (type === 'check_in' && navigator.geolocation) navigator.geolocation.getCurrentPosition(p => post(p), () => post(null), { timeout: 8000 })
    else post(null)
  }

  async function submitDaily(e) {
    e.preventDefault()
    const values = {}
    document.querySelectorAll('.link-field').forEach(el => { values[el.dataset.key] = el.type === 'number' ? Number(el.value || 0) : el.value })
    try {
      await axios.post(API + '/daily-report', { values, incident_flag: document.getElementById('link-incident').checked, complaint_flag: document.getElementById('link-complaint').checked })
      toast('日報を提出しました。お疲れさまでした！'); load()
    } catch (err) { toast(errMsg(err, '送信に失敗しました')) }
  }

  load()
})()
