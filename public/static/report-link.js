// =========================================================
// シフト専用の報告用URL（/r/:token）。ログイン不要で、そのシフトの勤怠報告・日報だけを行う
// docs/spec_spot_shift.md 第2段階。API: /api/public/report/:token
// =========================================================
(function () {
  // axios・dayjs を読み込めなかったときは何もしない（理由は head の LIB_FALLBACK が画面に出す。#409）
  if (!window.axios || !window.dayjs) return
  const $app = document.getElementById('app')
  const TOKEN = location.pathname.split('/').pop()
  const API = '/api/public/report/' + encodeURIComponent(TOKEN)
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const ICON = { wake_up: 'fa-sun', departure: 'fa-person-walking-luggage', check_in: 'fa-store', work_start: 'fa-briefcase', break_start: 'fa-mug-hot', break_end: 'fa-person-walking', work_end: 'fa-flag-checkered', check_out: 'fa-door-open' }
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const TARGET_BYTES = 480 * 1024, MAX_EDGE = 1600
  // 電波の弱い現場で待ち続けないよう、通信に上限を設ける（写真は長め）
  const GET_TIMEOUT = 20000, POST_TIMEOUT = 30000, PHOTO_TIMEOUT = 60000
  // DATA: 最後に取得した状態。staleNote: 送信後に最新の状態を取れなかったときの注記。sending: 勤怠報告の送信中
  let DATA = null, pending = null, staleNote = '', sending = false

  // esc は common.js のものを使う
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d
  const fmt = (d) => { const x = dayjs(d); return `${x.format('M/D')}(${WD[x.day()]})` }
  const nowStr = () => dayjs().format('YYYY-MM-DD HH:mm:ss')
  function toast(msg) {
    let root = document.getElementById('toast'); if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
    const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg; root.appendChild(el); setTimeout(() => el.remove(), 2500)
  }
  function modal(html) { document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-box p-5">${html}</div></div>` }
  // 送信中は閉じない（送信の結果を写真の画面に出すため）。送信の後に閉じるときは force を付ける
  window.closeModal = (force) => { if (sending && force !== true) return; document.getElementById('modal-root').innerHTML = ''; pending = null }

  // ---------- 日報の下書き（勤怠報告の後の描き直しや再読み込みで、送っていない入力を消さない #440） ----------
  // タブを閉じるまで sessionStorage にトークン単位で保存する。使えない端末でも、画面を開いている間はメモリに保つ
  const DRAFT_KEY = 'report-link-draft:' + TOKEN
  let draft = null
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') } catch { draft = null }
  function saveDraft() {
    const form = document.getElementById('link-daily-form'); if (!form) return
    const values = {}
    form.querySelectorAll('.link-field').forEach(el => { values[el.dataset.key] = el.value })
    draft = { values, incident: document.getElementById('link-incident').checked, complaint: document.getElementById('link-complaint').checked }
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { }
  }
  function clearDraft() { draft = null; try { sessionStorage.removeItem(DRAFT_KEY) } catch { } }
  function applyDraft() {
    const form = document.getElementById('link-daily-form'); if (!form || !draft) return
    form.querySelectorAll('.link-field').forEach(el => { if (draft.values && Object.prototype.hasOwnProperty.call(draft.values, el.dataset.key)) el.value = draft.values[el.dataset.key] })
    document.getElementById('link-incident').checked = !!draft.incident
    document.getElementById('link-complaint').checked = !!draft.complaint
  }

  // ---------- 読み込み ----------
  // 404 は URL が無効・期限切れのときだけ（staff-lifecycle.ts loadToken）。通信できない・サーバーの一時的な失敗は、再読み込みを出す（#129）
  function showLoadError(e) {
    if (e && e.response && e.response.status === 404) {
      $app.innerHTML = `<section class="card p-6 text-center mt-6"><i class="fas fa-link-slash text-3xl text-gray-300 mb-2 block"></i>
        <p class="font-bold text-gray-700">${esc(errMsg(e, 'このURLは利用できません'))}</p><p class="text-xs text-gray-400 mt-2">担当者に新しいURLを依頼してください</p></section>`
      return
    }
    $app.innerHTML = `<section class="card p-6 text-center mt-6"><i class="fas fa-wifi text-3xl text-gray-300 mb-2 block"></i>
      <p class="font-bold text-gray-700">${esc(e && e.response ? errMsg(e, '読み込みに失敗しました') : '通信できませんでした')}</p>
      <p class="text-xs text-gray-500 mt-2">電波の良い場所で、もう一度読み込んでください。このURLはそのまま使えます（新しいURLの依頼は不要です）</p>
      <button class="btn btn-primary w-full mt-4" data-action="linkReload"><i class="fas fa-rotate-right"></i>再読み込み</button></section>`
  }
  async function load() {
    $app.innerHTML = '<div class="flex justify-center py-16"><span class="spin"></span></div>'
    try { DATA = (await axios.get(API, { timeout: GET_TIMEOUT })).data } catch (e) { showLoadError(e); return }
    staleNote = ''
    render()
  }
  // 送信の後に最新の状態を取り直す。画面全体を読み込み中に置き換えない（取れなければ今の表示のまま）。
  // 戻り値: 'ok' | 'invalid'（URL が無効になった） | 'fail'（通信できない）
  async function refresh() {
    try { DATA = (await axios.get(API, { timeout: GET_TIMEOUT })).data } catch (e) { return e && e.response && e.response.status === 404 ? 'invalid' : 'fail' }
    staleNote = ''
    render()
    return 'ok'
  }
  delegate('linkReload', () => load())
  delegate('linkRefresh', (el) => withSubmitLock(el, async () => { if ((await refresh()) !== 'ok') toast('最新の状態を取得できませんでした') }))

  function render() {
    const d = DATA, s = d.shift
    const done = new Set(d.reports.map(r => r.report_type))
    const order = d.modes.required_attendance
    const nextIdx = order.findIndex(t => !done.has(t))
    const isToday = s.work_date === d.today
    // 稼働日の前は日報を提出できない（サーバーも受け付けない）
    const beforeDay = d.today < s.work_date
    $app.innerHTML = `
      ${staleNote ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3"><i class="fas fa-circle-info mr-1"></i>${esc(staleNote)}
        <button class="underline font-bold ml-1" data-action="linkRefresh">再読み込み</button></p>` : ''}
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
          return `<button class="report-btn ${r ? 'done' : isNext ? 'next' : ''}" ${r || !isNext ? 'disabled' : ''} data-action="linkReport" data-type="${esc(t)}">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${r ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}"><i class="fas ${r ? 'fa-check' : ICON[t]}"></i></span>
            <span class="flex-1 text-left"><span class="block font-bold ${r ? 'text-emerald-700' : isNext ? 'text-blue-700' : 'text-gray-500'}">${LABEL[t]}</span>
              <span class="rl-sub block text-xs ${r ? 'text-emerald-600' : 'text-gray-400'}">${r ? '報告済み ' + dayjs(r.reported_at).format('HH:mm') : isNext ? 'タップして報告' : '前の報告を先に行ってください'}${!r && d.photo_required && ['check_in', 'check_out'].includes(t) ? '（写真が必要です）' : ''}</span></span>
          </button>`
        }).join('')}
      </section>` : ''}
      ${d.modes.daily_report_required ? `<section class="card p-4 mb-4" id="report-link-daily">
        <h2 class="font-bold text-gray-800 mb-1">日報 ${d.daily_report ? '<span class="badge badge-green ml-1">提出済み</span>' : ''}</h2>
        <p class="text-xs text-gray-400 mb-3">${d.daily_report ? '提出済み（' + dayjs(d.daily_report.submitted_at).format('M/D HH:mm') + '）。修正して再提出できます' : beforeDay ? '日報は稼働日以降に提出できます' : '稼働終了後に入力してください'}</p>
        <form id="link-daily-form" class="space-y-3">
          ${(d.template ? d.template.fields : []).map(f => {
            const v = d.daily_report && d.daily_report.values ? d.daily_report.values[f.key] : ''
            if (f.type === 'number') return `<div class="flex items-center gap-3"><label class="text-sm text-gray-600 flex-1 min-w-0">${esc(f.label)}</label><input type="number" inputmode="numeric" min="0" max="99999" step="1" data-key="${esc(f.key)}" class="inp link-field text-center font-bold shrink-0" style="width:6rem" value="${esc(v == null ? '' : v)}" placeholder="0"></div>`
            if (f.type === 'textarea') return `<div><label class="text-sm text-gray-600 block mb-1">${esc(f.label)}</label><textarea data-key="${esc(f.key)}" rows="3" class="inp link-field">${esc(v || '')}</textarea></div>`
            return `<div><label class="text-sm text-gray-600 block mb-1">${esc(f.label)}</label><input data-key="${esc(f.key)}" class="inp link-field" value="${esc(v || '')}"></div>`
          }).join('') || `<div><label class="text-sm text-gray-600 block mb-1">報告内容</label><textarea data-key="free" rows="4" class="inp link-field">${esc((d.daily_report && d.daily_report.values && d.daily_report.values.free) || '')}</textarea></div>`}
          <label class="flex items-center gap-3"><input id="link-incident" type="checkbox" class="w-5 h-5" ${d.daily_report && d.daily_report.incident_flag ? 'checked' : ''}>インシデントがあった</label>
          <label class="flex items-center gap-3"><input id="link-complaint" type="checkbox" class="w-5 h-5" ${d.daily_report && d.daily_report.complaint_flag ? 'checked' : ''}>クレームがあった</label>
          <button id="link-daily-submit" class="btn btn-primary w-full py-3" ${beforeDay ? 'disabled' : ''}>${d.daily_report ? '日報を修正して再提出' : '日報を提出する'}</button>
        </form>
      </section>` : ''}
      ${!order.length && !d.modes.daily_report_required ? '<section class="card p-6 text-center text-sm text-gray-500">このシフトは報告の提出は不要です</section>' : ''}
      <p class="text-[11px] text-gray-400 text-center mt-6">このURLは ${dayjs(d.expires_at).format('M/D HH:mm')} まで有効です。他の人に共有しないでください</p>`
    const form = document.getElementById('link-daily-form')
    if (form) {
      form.addEventListener('submit', submitDaily)
      // 送っていない入力を描き直しの後に戻し、入力のたびに控える
      applyDraft()
      form.addEventListener('input', saveDraft)
      form.addEventListener('change', saveDraft)
    }
  }

  // ---------- 勤怠報告 ----------
  delegate('linkReport', (el) => {
    if (sending) return
    const type = el.dataset.type
    const needsPhoto = DATA.photo_required && ['check_in', 'check_out'].includes(type)
    if (!needsPhoto) return sendAttendance(type, null, el)
    pending = { type, blob: null, url: null }
    modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas ${ICON[type]} text-blue-600 mr-1"></i>${LABEL[type]}</h3>
      <p class="text-sm text-gray-500 mb-3">現場の様子が分かる写真を1枚添付してください</p>
      <div id="link-photo-area"></div>
      <input type="file" id="link-photo-camera" accept="image/*" capture="environment" class="hidden" onchange="linkPhoto(this.files[0])">
      <input type="file" id="link-photo-album" accept="image/*" class="hidden" onchange="linkPhoto(this.files[0])">
      <p id="link-photo-status" class="text-sm text-blue-700 mt-2"></p>
      <p id="link-photo-err" class="text-sm text-red-600 mt-2"></p>
      <div class="flex gap-2 mt-4"><button id="link-photo-cancel" class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button id="link-photo-send" class="btn btn-primary flex-1" disabled data-action="linkSendPhoto"><i class="fas fa-paper-plane"></i>送信する</button></div>`)
    drawPhoto()
  })
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
    if (!file || sending) return
    try { pending.blob = await compress(file); pending.url = URL.createObjectURL(pending.blob); drawPhoto() } catch (e) { err.textContent = e.message || '画像の処理に失敗しました' }
  }
  delegate('linkSendPhoto', (el) => { if (pending && pending.blob) sendAttendance(pending.type, pending.blob, el) })

  // 位置情報（取れなければ null）。端末が応答しない場合も 10 秒で諦める（アプリの getPositionOrNull と同じ）
  function positionOrNull() {
    if (!navigator.geolocation) return Promise.resolve(null)
    return new Promise(resolve => {
      let settled = false
      const fail = () => { if (settled) return; settled = true; toast('位置情報が取得できませんでした（位置なしで送信します）'); resolve(null) }
      const timer = setTimeout(fail, 10000)
      navigator.geolocation.getCurrentPosition(p => { if (settled) return; settled = true; clearTimeout(timer); resolve(p) }, () => { clearTimeout(timer); fail() }, { timeout: 8000 })
    })
  }

  // 送信中の表示（#199）: 勤怠ボタンをすべて押せなくし、押したボタンと写真の画面に進み具合を出す。終わったら元に戻す
  function lockAttendance(type) {
    document.querySelectorAll('#report-link-attendance .report-btn').forEach(b => {
      b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true
      const sub = b.querySelector('.rl-sub'); if (sub && b.dataset.type === type) b.dataset.sub = sub.innerHTML
    })
    const cancel = document.getElementById('link-photo-cancel'); if (cancel) cancel.disabled = true
  }
  function unlockAttendance() {
    document.querySelectorAll('#report-link-attendance .report-btn').forEach(b => {
      if (b.dataset.wasDisabled !== undefined) { b.disabled = b.dataset.wasDisabled === '1'; delete b.dataset.wasDisabled }
      const sub = b.querySelector('.rl-sub'); if (sub && b.dataset.sub !== undefined) { sub.innerHTML = b.dataset.sub; delete b.dataset.sub }
    })
    const cancel = document.getElementById('link-photo-cancel'); if (cancel) cancel.disabled = false
  }
  function showProgress(type, msg) {
    const html = `<span class="spin" style="width:12px;height:12px;border-width:2px;vertical-align:-1px"></span> ${esc(msg)}`
    const b = document.querySelector(`#report-link-attendance .report-btn[data-type="${type}"] .rl-sub`); if (b) b.innerHTML = html
    const st = document.getElementById('link-photo-status'); if (st) st.innerHTML = html
  }
  function showSendError(msg) {
    const st = document.getElementById('link-photo-status'); if (st) st.innerHTML = ''
    const el = document.getElementById('link-photo-err')
    if (el) el.textContent = msg; else toast(msg)
  }

  async function sendAttendance(type, blob, button) {
    if (sending) return
    sending = true
    lockAttendance(type)
    let sent = false
    try {
      await withSubmitLock(button, async () => {
        const err = document.getElementById('link-photo-err'); if (err) err.textContent = ''
        let pos = null
        if (type === 'check_in') { showProgress(type, '位置情報を取得しています...'); pos = await positionOrNull() }
        showProgress(type, blob ? '写真を送信しています...' : '送信しています...')
        try {
          if (blob) {
            const f = new FormData(); f.append('report_type', type); f.append('photo', blob, 'attendance.jpg')
            if (pos) { f.append('latitude', String(pos.coords.latitude)); f.append('longitude', String(pos.coords.longitude)) }
            await axios.post(API + '/attendance', f, { timeout: PHOTO_TIMEOUT })
          } else {
            await axios.post(API + '/attendance', { report_type: type, latitude: pos ? pos.coords.latitude : null, longitude: pos ? pos.coords.longitude : null }, { timeout: POST_TIMEOUT })
          }
          sent = true
        } catch (e) {
          const status = e && e.response ? e.response.status : 0
          // 応答がない・サーバーの一時的な失敗のときは、届いているかを最新の状態で確かめる（届いていれば送信済みとして扱う）
          if ((!status || status >= 500 || status === 409) && (await refresh()) === 'ok' && DATA.reports.some(r => r.report_type === type)) { sent = true; return }
          if (status === 404) { showSendError(errMsg(e, 'このURLは無効か、有効期限が切れています')); return }
          showSendError(status ? errMsg(e, '送信に失敗しました') : '通信できませんでした。電波の良い場所で、もう一度お試しください')
        }
      })
    } finally {
      sending = false
      unlockAttendance()
    }
    if (!sent) return
    closeModal(true); toast(LABEL[type] + 'を送信しました')
    if (DATA.reports.some(r => r.report_type === type)) return  // 確認のときに最新の状態を描き直し済み
    // 送信後の取り直しが失敗しても「URLが使えない」画面にせず、送った報告を反映して表示を続ける（#129）
    if ((await refresh()) !== 'ok') {
      DATA.reports.push({ report_type: type, reported_at: nowStr() })
      staleNote = LABEL[type] + 'は送信済みです（最新の状態を取得できませんでした）'
      render()
    }
  }

  // ---------- 日報 ----------
  function submitDaily(e) {
    e.preventDefault()
    const values = {}
    document.querySelectorAll('.link-field').forEach(el => { values[el.dataset.key] = el.type === 'number' ? Number(el.value || 0) : el.value })
    const incident = document.getElementById('link-incident').checked, complaint = document.getElementById('link-complaint').checked
    const btn = document.getElementById('link-daily-submit')
    // 送信中はボタンを押せないようにする（二度押しで同じ日報を送らない）。
    // インシデント・クレームは前回の値を表示したうえで送るので flags_explicit を付ける（外したときだけ印を下げる）
    return withSubmitLock(btn, async () => {
      const label = btn.innerHTML
      btn.innerHTML = '<span class="spin" style="width:14px;height:14px;border-width:2px"></span> 送信しています...'
      try {
        await axios.post(API + '/daily-report', { values, incident_flag: incident, complaint_flag: complaint, flags_explicit: true }, { timeout: POST_TIMEOUT })
      } catch (err) {
        btn.innerHTML = label
        // 失敗しても入力は残す（下書きにも控えてある）
        toast(err && err.response ? errMsg(err, '送信に失敗しました') : '通信できませんでした。入力内容は残っています。電波の良い場所で、もう一度送信してください')
        return
      }
      clearDraft()
      toast('日報を提出しました。お疲れさまでした！')
      if ((await refresh()) !== 'ok') {
        DATA.daily_report = { submitted_at: nowStr(), values, incident_flag: incident ? 1 : 0, complaint_flag: complaint ? 1 : 0 }
        staleNote = '日報は送信済みです（最新の状態を取得できませんでした）'
        render()
      }
    })
  }

  load()
})()
