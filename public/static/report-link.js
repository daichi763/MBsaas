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
  // 選べる元の画像の上限。端末の中で縮小してから送るので、高画素のスマホの写真も受け付ける（#536。アプリの staff.js と同じ）
  const SOURCE_MAX_BYTES = 50 * 1024 * 1024
  // 報告の順（report-settings.ts の REPORT_TYPES と同じ）
  const ORDER_ALL = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  // 電波の弱い現場で待ち続けないよう、通信に上限を設ける（写真は長め）
  const GET_TIMEOUT = 20000, POST_TIMEOUT = 30000, PHOTO_TIMEOUT = 60000
  // DATA: 最後に取得した状態。staleNote: 送信後に最新の状態を取れなかったときの注記。sending: 勤怠報告の送信中
  // dailyOpen: すべて済んだ後に、提出済みの日報を開いて直しているか（#546）
  let DATA = null, pending = null, staleNote = '', sending = false, dailyOpen = false

  // 端末ID（このブラウザで初めて開いたときに作る乱数）。1つのURLで別の端末から報告されたら管理画面で知らせる（#532）
  const DEVICE_KEY = 'report-link-device'
  let DEVICE_ID = ''
  try { DEVICE_ID = localStorage.getItem(DEVICE_KEY) || '' } catch { }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(DEVICE_ID)) {
    try { DEVICE_ID = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('') } catch { DEVICE_ID = (Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, '') }
    try { localStorage.setItem(DEVICE_KEY, DEVICE_ID) } catch { }
  }

  // 今のサーバーの日時（'YYYY-MM-DD HH:MM:SS'。JST）。読み込んだときのサーバーの時刻に経過時間を足す（端末の時計のずれに左右されない）
  let clock = null
  function setClock() { const s = Date.parse(String(DATA.now || '').replace(' ', 'T') + 'Z'); clock = Number.isFinite(s) ? { server: s, client: Date.now() } : null }
  function serverNow() { return clock ? new Date(clock.server + Date.now() - clock.client).toISOString().slice(0, 19).replace('T', ' ') : null }
  const atLabel = (at) => { const x = dayjs(at); return `${x.format('M/D')}(${WD[x.day()]}) ${x.format('HH:mm')}` }

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
      // 発行されたことのあるURLなら、会社名と電話番号が返る（#163。遅刻・欠勤などは電話で連絡してもらう）
      const d = e.response.data || {}
      const tel = telHref(d.contact_phone)
      $app.innerHTML = `<section class="card p-6 text-center mt-6"><i class="fas fa-link-slash text-3xl text-gray-300 mb-2 block"></i>
        <p class="font-bold text-gray-700">${esc(errMsg(e, 'このURLは利用できません'))}</p><p class="text-xs text-gray-400 mt-2">担当者に新しいURLを依頼してください</p>
        ${d.company_name ? `<div class="mt-4 pt-3 border-t text-sm text-gray-600" id="link-invalid-contact"><p>${esc(d.company_name)}</p>
          ${tel ? `<a href="${esc(tel)}" class="btn btn-outline w-full mt-2"><i class="fas fa-phone"></i>${esc(d.contact_phone)} に電話する</a>
            <p class="text-xs text-gray-400 mt-1">遅刻・欠勤・現場のトラブルは、こちらに電話で連絡してください</p>` : '<p class="text-xs text-gray-400 mt-1">遅刻・欠勤・現場のトラブルは、担当者に電話で連絡してください</p>'}</div>` : ''}</section>`
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
    setClock()
    render()
  }
  // 送信の後に最新の状態を取り直す。画面全体を読み込み中に置き換えない（取れなければ今の表示のまま）。
  // 戻り値: 'ok' | 'invalid'（URL が無効になった） | 'fail'（通信できない）
  async function refresh() {
    try { DATA = (await axios.get(API, { timeout: GET_TIMEOUT })).data } catch (e) { return e && e.response && e.response.status === 404 ? 'invalid' : 'fail' }
    staleNote = ''
    setClock()
    render()
    return 'ok'
  }
  delegate('linkReload', () => load())
  delegate('linkRefresh', (el) => withSubmitLock(el, async () => { if ((await refresh()) !== 'ok') toast('最新の状態を取得できませんでした') }))

  // 報告ごとの今の状態（サーバーの checkStaffReport と同じ考え方。#134 #256 #439）
  //   done 報告済み / pending 打刻修正を申請中 / blocked 後の報告が済んでいる / before 受付の前 / after 受付期間の後 / open 押せる
  //   前の報告を飛ばしても後の報告は押せる（飛ばした報告は担当者が打刻修正・代理入力で追加する）
  function typeStates(d) {
    const done = new Set(d.reports.map(r => r.report_type)), pend = new Set(d.pending_types || [])
    const now = serverNow(), out = {}
    for (const t of d.modes.required_attendance) {
      const w = d.windows && d.windows[t]
      const laterDone = ORDER_ALL.slice(ORDER_ALL.indexOf(t) + 1).some(x => done.has(x))
      out[t] = done.has(t) ? 'done' : pend.has(t) ? 'pending' : laterDone ? 'blocked' : !w || !now ? 'open' : now < w.start ? 'before' : now > w.end ? 'after' : 'open'
    }
    return out
  }
  // 勤怠がすべて済んだか（押せる・これから押せる報告が残っていない）と、日報が済んだか（#546）
  function progressOf(d, st) {
    const attDone = d.modes.required_attendance.every(t => ['done', 'pending', 'blocked'].includes(st[t]))
    const dailyDone = !d.modes.daily_report_required || !!d.daily_report
    return { attDone, dailyDone, allDone: attDone && dailyDone }
  }
  const mapUrl = (s) => {
    const lat = Number(s.site_lat), lng = Number(s.site_lng)
    const q = s.site_lat != null && s.site_lng != null && Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : (s.site_address || s.location || '')
    return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : ''
  }
  // ボタンの下の説明
  function subText(d, t, st, isNext) {
    const r = d.reports.find(x => x.report_type === t)
    const w = d.windows && d.windows[t]
    switch (st) {
      case 'done': return '報告済み ' + formatReportedTime(r.reported_at, d.shift.work_date)
      case 'pending': return '打刻の修正を申請中です'
      case 'blocked': return '後の報告が済んでいるため押せません。必要なら担当者に連絡してください'
      case 'before': return w ? atLabel(w.start) + ' から報告できます' : 'まだ報告できません'
      case 'after': return '受付期間を過ぎました。担当者に連絡してください'
      default: return isNext ? 'タップして報告' : 'タップして報告（前の報告を飛ばします）'
    }
  }
  let lastSig = ''
  // 受付の時間帯が切り替わったら描き直す（開いたままでも、時刻になればボタンが押せるようになる）
  setInterval(() => {
    if (!DATA || DATA.kind === 'schedule' || sending || document.getElementById('modal-root').innerHTML) return
    if (JSON.stringify(typeStates(DATA)) !== lastSig) render()
  }, 30000)

  function render() {
    if (DATA.kind === 'schedule') return renderSchedule()
    const d = DATA, s = d.shift
    const order = d.modes.required_attendance
    const st = typeStates(d)
    lastSig = JSON.stringify(st)
    const nextType = order.find(t => st[t] === 'open')
    const prog = progressOf(d, st)
    // 稼働日の前は日報を提出できない（サーバーも受け付けない）
    const beforeDay = d.today < s.work_date
    const map = mapUrl(s)
    const firstStart = order.filter(t => st[t] === 'before').map(t => d.windows[t].start).sort()[0]
    // すべて済んだ後の日報は、開いたときだけフォームを出す
    const dailyCollapsed = prog.allDone && !!d.daily_report && !dailyOpen
    $app.innerHTML = `
      ${staleNote ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3"><i class="fas fa-circle-info mr-1"></i>${esc(staleNote)}
        <button class="underline font-bold ml-1" data-action="linkRefresh">再読み込み</button></p>` : ''}
      ${noticesHtml(d)}
      ${prog.allDone && (order.length || d.modes.daily_report_required) ? `<section class="card p-4 mb-4 bg-emerald-50 border border-emerald-200 text-center" id="report-link-complete">
        <i class="fas fa-circle-check text-3xl text-emerald-500 mb-1 block"></i>
        <p class="font-bold text-emerald-800">本日の報告はすべて完了しました</p><p class="text-sm text-emerald-700 mt-0.5">お疲れさまでした</p></section>`
      : prog.attDone && !prog.dailyDone && !beforeDay && order.length ? `<section class="card p-4 mb-4 bg-amber-50 border border-amber-200" id="report-link-remaining">
        <p class="font-bold text-amber-800"><i class="fas fa-file-pen mr-1"></i>あと日報の提出が残っています</p>
        <button class="btn btn-primary w-full mt-2" data-action="linkGoDaily">日報を入力する</button></section>` : ''}
      <section class="card p-4 mb-4" id="report-link-shift">
        <p class="text-xs text-gray-400">${esc(d.company_name)}</p>
        <p class="text-sm text-gray-600 mt-1">${esc(d.staff_name)} さん</p>
        <p class="text-lg font-bold text-gray-900 mt-1">${esc(d.project_name)}</p>
        <p class="text-sm text-gray-600 mt-0.5"><i class="fas fa-location-dot text-gray-400 mr-1"></i>${esc(s.location || '')}</p>
        <p class="text-sm text-gray-600"><i class="far fa-calendar text-gray-400 mr-1"></i>${fmt(s.work_date)} <i class="far fa-clock text-gray-400 ml-2 mr-1"></i>${esc(formatShiftTime(s.start_time, s.end_time, ' 〜 '))}</p>
        ${s.role ? `<p class="text-sm text-gray-600"><i class="fas fa-user-tag text-gray-400 mr-1"></i>役割: ${esc(s.role)}</p>` : ''}
        ${(s.site_name && s.site_name !== s.location) || s.site_address || map ? `<p class="text-xs text-gray-500 mt-0.5">${esc(s.site_name && s.site_name !== s.location ? s.site_name + ' ' : '')}${esc(s.site_address || '')}${map ? ` <a href="${esc(map)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline whitespace-nowrap"><i class="fas fa-map-location-dot mr-0.5"></i>地図を開く</a>` : ''}</p>` : ''}
        ${d.manual_text ? `<details class="mt-2 rounded-lg bg-gray-50 p-2"><summary class="text-sm font-bold text-blue-700 cursor-pointer"><i class="fas fa-book mr-1"></i>注意事項・マニュアル</summary>
          <p class="text-sm text-gray-700 whitespace-pre-wrap break-words mt-2">${esc(d.manual_text)}</p></details>` : ''}
        ${firstStart && !order.some(t => ['done', 'open'].includes(st[t])) ? `<p class="text-xs text-amber-700 bg-amber-50 rounded p-2 mt-2">報告は ${esc(atLabel(firstStart))} から行えます</p>` : ''}
      </section>
      ${order.length ? `<section class="mb-4 space-y-2.5" id="report-link-attendance">
        <h2 class="font-bold text-gray-800 px-1">勤怠報告</h2>
        ${order.map(t => {
          const state = st[t], isDone = state === 'done', isNext = t === nextType, canPress = state === 'open'
          return `<button class="report-btn ${isDone ? 'done' : isNext ? 'next' : ''}" ${canPress ? '' : 'disabled'} data-action="linkReport" data-type="${esc(t)}">
            <span class="w-11 h-11 rounded-xl flex items-center justify-center text-lg ${isDone ? 'bg-emerald-500 text-white' : isNext ? 'bg-blue-600 text-white' : canPress ? 'bg-blue-50 text-blue-500' : 'bg-gray-100 text-gray-400'}"><i class="fas ${isDone ? 'fa-check' : ICON[t]}"></i></span>
            <span class="flex-1 text-left"><span class="block font-bold ${isDone ? 'text-emerald-700' : isNext ? 'text-blue-700' : canPress ? 'text-gray-700' : 'text-gray-500'}">${LABEL[t]}</span>
              <span class="rl-sub block text-xs ${isDone ? 'text-emerald-600' : state === 'after' ? 'text-amber-700' : 'text-gray-400'}">${esc(subText(d, t, state, isNext))}${!isDone && canPress && d.photo_required && ['check_in', 'check_out'].includes(t) ? '（写真が必要です）' : ''}</span></span>
          </button>`
        }).join('')}
      </section>` : ''}
      ${d.modes.daily_report_required ? `<section class="card p-4 mb-4" id="report-link-daily">
        <h2 class="font-bold text-gray-800 mb-1">日報 ${d.daily_report ? '<span class="badge badge-green ml-1">提出済み</span>' : ''}</h2>
        <p class="text-xs text-gray-400 mb-3">${d.daily_report ? '提出済み（' + dayjs(d.daily_report.submitted_at).format('M/D HH:mm') + '）。修正して再提出できます' : beforeDay ? '日報は稼働日以降に提出できます' : prog.attDone ? '勤怠報告は済んでいます。日報を入力して提出してください' : '稼働終了後に入力してください'}</p>
        ${dailyCollapsed ? `<button class="btn btn-outline w-full" data-action="linkEditDaily"><i class="fas fa-pen"></i>日報を修正する</button>` : `<form id="link-daily-form" class="space-y-3">
          ${(d.template ? d.template.fields : []).map(f => {
            const v = d.daily_report && d.daily_report.values ? d.daily_report.values[f.key] : ''
            if (f.type === 'number') return `<div class="flex items-center gap-3"><label class="text-sm text-gray-600 flex-1 min-w-0">${esc(f.label)}</label><input type="number" inputmode="numeric" min="0" max="99999" step="1" data-key="${esc(f.key)}" class="inp link-field text-center font-bold shrink-0" style="width:6rem" value="${esc(v == null ? '' : v)}" placeholder="0"></div>`
            if (f.type === 'textarea') return `<div><label class="text-sm text-gray-600 block mb-1">${esc(f.label)}</label><textarea data-key="${esc(f.key)}" rows="3" class="inp link-field">${esc(v || '')}</textarea></div>`
            return `<div><label class="text-sm text-gray-600 block mb-1">${esc(f.label)}</label><input data-key="${esc(f.key)}" class="inp link-field" value="${esc(v || '')}"></div>`
          }).join('') || `<div><label class="text-sm text-gray-600 block mb-1">報告内容</label><textarea data-key="free" rows="4" class="inp link-field">${esc((d.daily_report && d.daily_report.values && d.daily_report.values.free) || '')}</textarea></div>`}
          <label class="flex items-center gap-3"><input id="link-incident" type="checkbox" class="w-5 h-5" ${d.daily_report && d.daily_report.incident_flag ? 'checked' : ''}>インシデントがあった</label>
          <label class="flex items-center gap-3"><input id="link-complaint" type="checkbox" class="w-5 h-5" ${d.daily_report && d.daily_report.complaint_flag ? 'checked' : ''}>クレームがあった</label>
          <button id="link-daily-submit" class="btn btn-primary w-full py-3" ${beforeDay ? 'disabled' : ''}>${d.daily_report ? '日報を修正して再提出' : '日報を提出する'}</button>
        </form>`}
      </section>` : ''}
      ${!order.length && !d.modes.daily_report_required ? '<section class="card p-6 text-center text-sm text-gray-500">このシフトは報告の提出は不要です</section>' : ''}
      ${contactHtml(d)}
      <p class="text-[11px] text-gray-400 text-center mt-6">このURLは ${dayjs(d.expires_at).format('M/D HH:mm')} まで有効です。${esc(d.staff_name)} さん専用のURLです。他の人に送ったり、代わりに押してもらったりしないでください（報告した端末は記録されます）</p>`
    const form = document.getElementById('link-daily-form')
    if (form) {
      form.addEventListener('submit', submitDaily)
      // 送っていない入力を描き直しの後に戻し、入力のたびに控える
      applyDraft()
      form.addEventListener('input', saveDraft)
      form.addEventListener('change', saveDraft)
    }
  }

  // ---------- お知らせ（#281）・連絡（#163）・予定確認の画面（#442） ----------
  // 電話番号を tel: のリンクにする（数字と + 以外を除く）
  function telHref(p) { const n = String(p || '').replace(/[^\d+]/g, ''); return n.length >= 6 ? 'tel:' + n : '' }
  const IMPORTANCE_BADGE = { urgent: '<span class="badge badge-red">緊急</span>', important: '<span class="badge badge-yellow">重要</span>' }
  // 本人あての重要・緊急のお知らせ（直近のもの。ログインのない人はアプリのお知らせを見られないため、ここに出す）
  function noticesHtml(d) {
    const list = d.notices || []
    if (!list.length) return ''
    return `<section class="card p-4 mb-4 border border-amber-200" id="report-link-notices">
      <h2 class="font-bold text-gray-800 mb-2"><i class="fas fa-bullhorn text-amber-500 mr-1"></i>会社からのお知らせ</h2>
      <div class="space-y-2">${list.map(n => `<details class="rounded-lg bg-gray-50 p-2" ${n.importance === 'urgent' ? 'open' : ''}>
        <summary class="text-sm font-bold text-gray-800 cursor-pointer">${IMPORTANCE_BADGE[n.importance] || ''} ${esc(n.title)}
          <span class="text-[11px] font-normal text-gray-400 ml-1">${esc(dayjs(n.published_at).format('M/D'))}</span></summary>
        <p class="text-sm text-gray-700 whitespace-pre-wrap break-words mt-2">${esc(n.body || '')}</p></details>`).join('')}</div></section>`
  }
  // 遅刻・欠勤・トラブルの連絡（#163）。ボタンからフォームを開いて送る。会社の電話番号があれば発信のリンクも出す
  function contactHtml(d) {
    const tel = telHref(d.contact_phone)
    return `<section class="card p-4 mb-4" id="report-link-contact">
      <h2 class="font-bold text-gray-800 mb-1"><i class="fas fa-headset text-blue-500 mr-1"></i>遅刻・欠勤・トラブルの連絡</h2>
      <p class="text-xs text-gray-400 mb-2">遅れそう・行けない・現場で困ったときは、担当者に連絡してください</p>
      <button class="btn btn-outline w-full" data-action="linkOpenContact"><i class="fas fa-paper-plane"></i>担当者に連絡する</button>
      ${tel ? `<a href="${esc(tel)}" class="btn btn-outline w-full mt-2"><i class="fas fa-phone"></i>${esc(d.contact_phone)} に電話する</a>
        <p class="text-[11px] text-gray-400 mt-1">急ぎの場合（出勤の直前など）は電話してください</p>` : ''}
    </section>`
  }
  const CONTACT_KINDS = [['late', '遅刻しそう'], ['absent', '欠勤したい'], ['health', '体調が悪い'], ['trouble', '現場でトラブル'], ['other', 'その他']]
  delegate('linkOpenContact', (el) => {
    const shifts = DATA.kind === 'schedule' ? (DATA.shifts || []) : []
    modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas fa-headset text-blue-600 mr-1"></i>担当者に連絡する</h3>
      <div class="grid grid-cols-2 gap-2 mb-3" id="link-contact-kinds">${CONTACT_KINDS.map(([k, l]) => `<label class="flex items-center gap-2 rounded-lg border p-2 text-sm">
        <input type="radio" name="link-contact-kind" value="${esc(k)}">${esc(l)}</label>`).join('')}</div>
      ${shifts.length ? `<label class="text-sm text-gray-600 block mb-1">どのシフトについて（任意）</label>
        <select id="link-contact-shift" class="inp text-sm mb-3"><option value="">選ばない</option>${shifts.map(s => `<option value="${Number(s.shift_id)}" ${String(el.dataset.shiftId || '') === String(s.shift_id) ? 'selected' : ''}>${esc(fmt(s.work_date) + ' ' + formatShiftTime(s.start_time, s.end_time) + ' ' + s.project_name)}</option>`).join('')}</select>` : ''}
      <label class="text-sm text-gray-600 block mb-1">内容（遅れる時間・理由など）</label>
      <textarea id="link-contact-body" rows="4" maxlength="1000" class="inp" placeholder="例: 電車の遅延で10分ほど遅れます"></textarea>
      <p id="link-contact-err" class="text-sm text-red-600 mt-2"></p>
      <div class="flex gap-2 mt-3"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" data-action="linkSendContact"><i class="fas fa-paper-plane"></i>送信する</button></div>`)
    if (el.dataset.kind) { const r = document.querySelector(`input[name="link-contact-kind"][value="${el.dataset.kind}"]`); if (r) r.checked = true }
  })
  delegate('linkSendContact', (el) => withSubmitLock(el, async () => {
    const err = document.getElementById('link-contact-err')
    const kind = (document.querySelector('input[name="link-contact-kind"]:checked') || {}).value
    const body = (document.getElementById('link-contact-body').value || '').trim()
    const shiftSel = document.getElementById('link-contact-shift')
    if (!kind) { err.textContent = '連絡の種類を選んでください'; return }
    if (['trouble', 'other'].includes(kind) && !body) { err.textContent = '内容を入力してください'; return }
    try {
      const { data } = await axios.post(API + '/consultation', { kind, body, shift_id: shiftSel && shiftSel.value ? Number(shiftSel.value) : undefined }, { timeout: POST_TIMEOUT })
      const tel = telHref(data.contact_phone || DATA.contact_phone)
      modal(`<div class="text-center"><i class="fas fa-circle-check text-3xl text-emerald-500 mb-2 block"></i>
        <p class="font-bold text-gray-800">担当者に送信しました</p>
        <p class="text-sm text-gray-500 mt-1">担当者が確認します。急ぎの場合は電話でも連絡してください</p>
        ${tel ? `<a href="${esc(tel)}" class="btn btn-outline w-full mt-3"><i class="fas fa-phone"></i>${esc(data.contact_phone || DATA.contact_phone)} に電話する</a>` : ''}
        <button class="btn btn-primary w-full mt-2" onclick="closeModal()">閉じる</button></div>`)
    } catch (e) {
      err.textContent = e && e.response ? errMsg(e, '送信に失敗しました') : '通信できませんでした。電波の良い場所で、もう一度お試しください'
    }
  }))

  // 予定確認の画面（#442）: 前日〜2週間先の確定シフト。前日・当日・翌日のシフトには報告の画面への入口を出す
  function renderSchedule() {
    const d = DATA
    document.title = '予定の確認'
    const h1 = document.querySelector('header h1'); if (h1) h1.innerHTML = '<i class="fas fa-calendar-days text-blue-600"></i>予定の確認'
    const byDate = {}
    for (const s of d.shifts) (byDate[s.work_date] = byDate[s.work_date] || []).push(s)
    const dates = Object.keys(byDate).sort()
    const dayLabel = (x) => x === d.today ? '今日' : x === dayjs(d.today).add(1, 'day').format('YYYY-MM-DD') ? '明日' : x < d.today ? '昨日' : ''
    $app.innerHTML = `
      ${noticesHtml(d)}
      <section class="card p-4 mb-4" id="schedule-head">
        <p class="text-xs text-gray-400">${esc(d.company_name)}</p>
        <p class="text-sm text-gray-600 mt-1">${esc(d.staff_name)} さんの予定</p>
        <p class="text-xs text-gray-400 mt-1">今日から${Number(d.days_ahead)}日先までの確定したシフトです。変更があればこのページに反映されます</p>
      </section>
      <section class="space-y-3 mb-4" id="schedule-list">
        ${dates.length ? dates.map(x => `<div><p class="text-sm font-bold text-gray-700 px-1 mb-1">${esc(fmt(x))}${dayLabel(x) ? ` <span class="badge ${x === d.today ? 'badge-blue' : 'badge-gray'}">${dayLabel(x)}</span>` : ''}</p>
          ${byDate[x].map(s => { const map = mapUrl(s); return `<div class="card p-3 mb-2" data-shift-id="${Number(s.shift_id)}">
            <p class="font-bold text-gray-900">${esc(s.project_name)}</p>
            <p class="text-sm text-gray-600"><i class="far fa-clock text-gray-400 mr-1"></i>${esc(formatShiftTime(s.start_time, s.end_time, ' 〜 '))}${s.role ? ` <span class="text-gray-400 ml-1">役割: ${esc(s.role)}</span>` : ''}</p>
            ${s.location || s.site_name ? `<p class="text-sm text-gray-600"><i class="fas fa-location-dot text-gray-400 mr-1"></i>${esc(s.site_name || s.location)}</p>` : ''}
            ${s.site_address || map ? `<p class="text-xs text-gray-500">${esc(s.site_address || '')}${map ? ` <a href="${esc(map)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline whitespace-nowrap"><i class="fas fa-map-location-dot mr-0.5"></i>地図を開く</a>` : ''}</p>` : ''}
            ${s.report_token ? `<a href="/r/${encodeURIComponent(s.report_token)}" class="btn btn-primary w-full mt-2"><i class="fas fa-clipboard-check"></i>このシフトの勤怠・日報を報告する</a>` : ''}
          </div>` }).join('')}</div>`).join('')
        : '<div class="card p-6 text-center text-sm text-gray-500">この期間の確定したシフトはありません</div>'}
      </section>
      ${contactHtml(d)}
      <p class="text-[11px] text-gray-400 text-center mt-6">このURLは ${esc(dayjs(d.expires_at).format('M/D'))} まで使えます。${esc(d.staff_name)} さん専用のURLです。他の人に送らないでください</p>`
  }

  // ---------- 勤怠報告 ----------
  delegate('linkReport', (el) => {
    if (sending) return
    const type = el.dataset.type
    // 前の報告を飛ばすときは確かめる（飛ばした報告はこの画面から押せなくなる。アプリと同じ）
    const st = typeStates(DATA)
    const skipping = DATA.modes.required_attendance.filter(t => st[t] === 'open' && ORDER_ALL.indexOf(t) < ORDER_ALL.indexOf(type))
    if (skipping.length && !confirm(`${skipping.map(t => LABEL[t]).join('・')} がまだです。\n飛ばして${LABEL[type]}を報告すると、飛ばした報告はこの画面から押せなくなります（必要なら担当者に連絡してください）。\n報告しますか？`)) return
    const needsPhoto = DATA.photo_required && ['check_in', 'check_out'].includes(type)
    if (!needsPhoto) return sendAttendance(type, null, el)
    // takenAt・source: 写真のファイルの日時と選び方（#418）。processing: 画像の処理中（#545）
    pending = { type, blob: null, url: null, takenAt: null, source: null, processing: false }
    const reasons = DATA.no_photo_reasons || {}
    modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas ${ICON[type]} text-blue-600 mr-1"></i>${LABEL[type]}</h3>
      <p class="text-sm text-gray-500 mb-3">現場の様子が分かる写真を1枚添付してください</p>
      <div id="link-photo-area"></div>
      <input type="file" id="link-photo-camera" accept="image/*" capture="environment" class="hidden" onchange="linkPhoto(this.files[0], 'camera'); this.value = ''">
      <input type="file" id="link-photo-album" accept="image/*" class="hidden" onchange="linkPhoto(this.files[0], 'album'); this.value = ''">
      <p id="link-photo-status" class="text-sm text-blue-700 mt-2"></p>
      <p id="link-photo-err" class="text-sm text-red-600 mt-2"></p>
      <div id="link-photo-retry"></div>
      <div class="flex gap-2 mt-4"><button id="link-photo-cancel" class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button id="link-photo-send" class="btn btn-primary flex-1" disabled data-action="linkSendPhoto"><i class="fas fa-paper-plane"></i>送信する</button></div>
      ${DATA.photo_skip_allowed ? `<details class="mt-4 pt-3 border-t text-sm" id="link-nophoto">
        <summary class="text-gray-600 cursor-pointer">写真を送れない場合</summary>
        <div class="mt-2 space-y-2">
          <select id="link-nophoto-reason" class="inp text-sm">${Object.entries(reasons).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select>
          <input id="link-nophoto-note" class="inp text-sm" maxlength="100" placeholder="補足（「その他」のときは必須）">
          <button class="btn btn-outline w-full" data-action="linkSendNoPhoto"><i class="fas fa-ban"></i>写真なしで${esc(LABEL[type])}する</button>
          <p class="text-xs text-gray-400">写真なしで報告したことと理由は、担当者に表示されます</p>
        </div></details>`
      : '<p class="text-xs text-gray-500 mt-4 pt-3 border-t">写真を送れない場合（撮影禁止・カメラが使えないなど）は、担当者に連絡してください。担当者が代わりに記録できます</p>'}`)
    drawPhoto()
  })
  // 写真の欄: 選んだ写真のプレビュー（撮り直しのボタン付き）・処理中・撮影の選択（#545）
  function drawPhoto() {
    const a = document.getElementById('link-photo-area'); if (!a || !pending) return
    a.innerHTML = pending.processing ? '<div class="flex flex-col items-center justify-center py-8 gap-2"><span class="spin"></span><span class="text-xs text-gray-400">画像を処理しています...</span></div>'
      : pending.url ? `<div class="relative"><img src="${pending.url}" class="w-full rounded-xl border max-h-64 object-cover" alt="プレビュー">
          <button type="button" class="absolute top-2 right-2 bg-white/90 text-gray-700 rounded-full px-3 h-8 flex items-center gap-1 shadow text-xs font-bold" data-action="linkRetakePhoto"><i class="fas fa-rotate-left"></i>撮り直す</button></div>`
      : `<div class="grid grid-cols-2 gap-2"><button class="btn btn-outline" onclick="document.getElementById('link-photo-camera').click()"><i class="fas fa-camera"></i>カメラで撮影</button>
         <button class="btn btn-outline" onclick="document.getElementById('link-photo-album').click()"><i class="fas fa-images"></i>アルバムから選択</button></div>`
    const b = document.getElementById('link-photo-send'); if (b) b.disabled = !pending.blob || pending.processing
  }
  // 写真のエラー。撮り直しで直るものは、カメラのボタンをエラーの近くに出す（#536）
  function setPhotoError(msg, withCamera) {
    const err = document.getElementById('link-photo-err'); if (err) err.textContent = msg || ''
    const r = document.getElementById('link-photo-retry')
    if (r) r.innerHTML = msg && withCamera ? `<button class="btn btn-outline w-full mt-2" onclick="document.getElementById('link-photo-camera').click()"><i class="fas fa-camera"></i>カメラで撮り直す</button>` : ''
  }
  delegate('linkRetakePhoto', () => {
    if (!pending || sending) return
    if (pending.url) URL.revokeObjectURL(pending.url)
    Object.assign(pending, { blob: null, url: null, takenAt: null, source: null })
    setPhotoError('')
    drawPhoto()
  })
  const DECODE_ERROR = 'この画像は読み込めませんでした（HEIC など）。「カメラで撮影」から撮り直すか、JPEG・PNG の写真を選んでください'
  async function compress(file) {
    let bmp
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch {
      try { bmp = await createImageBitmap(file) } catch { throw new Error(DECODE_ERROR) }
    }
    let { width, height } = bmp
    if (Math.max(width, height) > MAX_EDGE) { const k = MAX_EDGE / Math.max(width, height); width = Math.round(width * k); height = Math.round(height * k) }
    const cv = document.createElement('canvas'); cv.width = width; cv.height = height; cv.getContext('2d').drawImage(bmp, 0, 0, width, height)
    if (bmp.close) bmp.close()
    const toBlob = (q) => new Promise((ok, ng) => cv.toBlob(b => b ? ok(b) : ng(new Error('画像の変換に失敗しました。「カメラで撮影」から撮り直してください')), 'image/jpeg', q))
    let q = 0.7, blob = await toBlob(q)
    while (blob.size > TARGET_BYTES && q > 0.35) { q -= 0.1; blob = await toBlob(q) }
    if (blob.size > TARGET_BYTES) throw new Error('画像を十分に小さくできませんでした。「カメラで撮影」から撮り直してください')
    return blob
  }
  window.linkPhoto = async function (file, source) {
    setPhotoError('')
    if (!file || sending || !pending || pending.processing) return
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name || '')) { setPhotoError('画像ファイルを選択してください', true); return }
    if (file.size > SOURCE_MAX_BYTES) { setPhotoError('写真のファイルが大きすぎます（50MBまで）。「カメラで撮影」から撮り直してください', true); return }
    const cur = pending
    cur.processing = true; drawPhoto()
    try {
      const blob = await compress(file)
      if (pending !== cur) return // 処理中に閉じた
      if (cur.url) URL.revokeObjectURL(cur.url)
      Object.assign(cur, { blob, url: URL.createObjectURL(blob), takenAt: file.lastModified || null, source: source === 'camera' ? 'camera' : 'album' })
    } catch (e) {
      // 英語の例外文はそのまま出さない
      const msg = e && e.message && /[ぁ-んァ-ヶ一-龠]/.test(e.message) ? e.message : DECODE_ERROR
      setPhotoError(msg, true)
    } finally {
      cur.processing = false
      if (pending === cur) drawPhoto()
    }
  }
  delegate('linkSendPhoto', (el) => { if (pending && pending.blob && !pending.processing) sendAttendance(pending.type, pending.blob, el) })
  // 写真なしで報告する（会社が許可しているときだけ。理由は担当者に表示される。#535）
  delegate('linkSendNoPhoto', (el) => {
    if (!pending || sending) return
    const reason = (document.getElementById('link-nophoto-reason') || {}).value
    const note = ((document.getElementById('link-nophoto-note') || {}).value || '').trim()
    if (reason === 'other' && !note) { setPhotoError('「その他」の場合は理由を入力してください'); return }
    sendAttendance(pending.type, null, el, { reason, note })
  })
  delegate('linkGoDaily', () => { const el = document.getElementById('report-link-daily'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) })
  delegate('linkEditDaily', () => { dailyOpen = true; render(); const el = document.getElementById('report-link-daily'); if (el) el.scrollIntoView({ block: 'start' }) })

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

  // noPhoto: 写真なしで報告するときの理由 { reason, note }（#535）
  async function sendAttendance(type, blob, button, noPhoto) {
    if (sending) return
    sending = true
    lockAttendance(type)
    let sent = false
    try {
      await withSubmitLock(button, async () => {
        setPhotoError('')
        let pos = null
        if (type === 'check_in') { showProgress(type, '位置情報を取得しています...'); pos = await positionOrNull() }
        showProgress(type, blob ? '写真を送信しています...' : '送信しています...')
        try {
          if (blob) {
            const f = new FormData(); f.append('report_type', type); f.append('photo', blob, 'attendance.jpg')
            if (pos) { f.append('latitude', String(pos.coords.latitude)); f.append('longitude', String(pos.coords.longitude)) }
            // 写真のファイルの日時・選び方（#418）と端末ID（#532）
            if (pending && pending.takenAt) f.append('photo_taken_at', String(pending.takenAt))
            if (pending && pending.source) f.append('photo_source', pending.source)
            f.append('device_id', DEVICE_ID)
            await axios.post(API + '/attendance', f, { timeout: PHOTO_TIMEOUT })
          } else {
            await axios.post(API + '/attendance', { report_type: type, latitude: pos ? pos.coords.latitude : null, longitude: pos ? pos.coords.longitude : null, device_id: DEVICE_ID,
              no_photo_reason: noPhoto ? noPhoto.reason : undefined, no_photo_note: noPhoto ? noPhoto.note : undefined }, { timeout: POST_TIMEOUT })
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
    closeModal(true); toast(LABEL[type] + (noPhoto ? 'を写真なしで送信しました' : 'を送信しました'))
    // 送信後の取り直しが失敗しても「URLが使えない」画面にせず、送った報告を反映して表示を続ける（#129）
    // （届いたかの確認のときに最新の状態を描き直し済みなら、取り直さない）
    if (!DATA.reports.some(r => r.report_type === type) && (await refresh()) !== 'ok') {
      DATA.reports.push({ report_type: type, reported_at: nowStr() })
      staleNote = LABEL[type] + 'は送信済みです（最新の状態を取得できませんでした）'
      render()
    }
    // 勤怠がすべて済んで日報だけが残ったら、日報の欄へ移る（#546）
    const prog = progressOf(DATA, typeStates(DATA))
    if (prog.attDone && !prog.dailyDone && DATA.today >= DATA.shift.work_date) { const el = document.getElementById('report-link-daily'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
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
      dailyOpen = false // すべて済んでいれば、日報の欄はたたんで完了の表示にする（#546）
      toast('日報を提出しました。お疲れさまでした！')
      if ((await refresh()) !== 'ok') {
        DATA.daily_report = { submitted_at: nowStr(), values, incident_flag: incident ? 1 : 0, complaint_flag: complaint ? 1 : 0 }
        staleNote = '日報は送信済みです（最新の状態を取得できませんでした）'
        render()
      }
    })
  }

  // ---------- 会社の緊急連絡先（#173） ----------
  // 画面（#app）の下に別の部分として出す。URL の期限切れ・読み込みの失敗の画面でも出す。登録がなければ何も出さない
  async function loadEmergencyContact() {
    let d
    try { d = (await axios.get(API + '/contact', { timeout: GET_TIMEOUT })).data } catch (e) { return }
    if (!d || !d.phone) return
    // #app と同じ幅にそろえる
    const box = document.createElement('div')
    box.className = 'max-w-lg mx-auto px-4 pb-6'
    box.innerHTML = `<section class="card p-4"><p class="text-sm font-bold text-gray-800 mb-1"><i class="fas fa-phone text-red-500 mr-1"></i>緊急連絡先（${esc(d.company_name)}）</p>
      <p class="text-[11px] text-gray-500 mb-2">当日の欠勤・遅刻・体調不良・現場のトラブルは、こちらに電話してください</p>
      <a href="tel:${esc(String(d.phone).replace(/[^0-9+]/g, ''))}" class="btn btn-outline w-full"><i class="fas fa-phone text-red-500"></i><span class="font-bold">${esc(d.phone)}</span></a>
      ${d.note ? `<p class="text-[11px] text-gray-400 mt-1">${esc(d.note)}</p>` : ''}</section>`
    $app.insertAdjacentElement('afterend', box)
  }

  load()
  loadEmergencyContact()
})()
