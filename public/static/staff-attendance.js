// =========================================================
// スタッフ: 打刻履歴（日付ごとのタイムライン）と打刻修正申請
// docs/spec_attendance_correction.md 4章・6.2。staff.js の後に読み込む（#attendance）
// =========================================================
(function () {
  const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const STATUS = { pending: ['承認待ち', 'badge-yellow'], approved: ['承認済み', 'badge-green'], rejected: ['却下', 'badge-red'], cancelled: ['取り消し済み', 'badge-gray'] }
  const KIND = { modify: '時刻修正', add: '打刻漏れの追加' }
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const S = window.__attState = window.__attState || { tab: 'timeline', to: null }
  let TL = null
  let busy = false
  const today = () => dayjs().format('YYYY-MM-DD')
  // 'YYYY-MM-DD HH:MM:SS' → 表示（稼働日と違う日は日付も出す）
  const showAt = (at, workDate) => at ? (at.slice(0, 10) === workDate ? at.slice(11, 16) : dayjs(at.slice(0, 10)).format('M/D') + ' ' + at.slice(11, 16)) : ''
  const toInput = (at) => at ? at.slice(0, 16).replace(' ', 'T') : ''
  const statusBadge = (s) => `<span class="badge ${(STATUS[s] || [])[1] || 'badge-gray'}">${(STATUS[s] || [s])[0]}</span>`

  window.renderStaffAttendance = function () {
    $app.innerHTML = `
      <div class="grid grid-cols-2 gap-2 mb-4" role="tablist">
        <button class="btn ${S.tab === 'timeline' ? 'btn-primary' : 'btn-outline'}" onclick="attTab('timeline')"><i class="fas fa-clock"></i>打刻履歴</button>
        <button class="btn ${S.tab === 'requests' ? 'btn-primary' : 'btn-outline'}" onclick="attTab('requests')"><i class="fas fa-file-pen"></i>修正申請</button>
      </div>
      <div id="att-body"><div class="flex justify-center py-12"><span class="spin"></span></div></div>`
    return S.tab === 'requests' ? renderRequests() : renderTimeline()
  }
  window.attTab = function (t) { S.tab = t; renderStaffAttendance() }

  // ---------- 打刻履歴（タイムライン） ----------
  async function renderTimeline() {
    const host = document.getElementById('att-body')
    const to = S.to || today()
    try { TL = (await axios.get('/api/staff/attendance/timeline', { params: { to, from: dayjs(to).subtract(13, 'day').format('YYYY-MM-DD') } })).data } catch (e) { host.innerHTML = `<p class="text-red-600 text-sm">${esc(errMsg(e))}</p>`; return }
    const byDate = {}
    for (const s of TL.shifts) (byDate[s.work_date] = byDate[s.work_date] || []).push(s)
    host.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <button class="btn btn-outline text-xs" onclick="attMove(-14)"><i class="fas fa-chevron-left"></i>前の2週間</button>
        <span class="text-xs text-gray-500">${dayjs(TL.from).format('M/D')}〜${dayjs(TL.to).format('M/D')}</span>
        <button class="btn btn-outline text-xs" onclick="attMove(14)" ${TL.to >= today() ? 'disabled' : ''}>次の2週間<i class="fas fa-chevron-right"></i></button>
      </div>
      <p class="text-[11px] text-gray-500 mb-3 px-1">報告をタップすると時刻の修正、未報告の項目は打刻漏れの追加を申請できます。承認されるまで記録は変わりません</p>
      <div class="space-y-3">${Object.keys(byDate).map(d => `
        <section>
          <h3 class="text-sm font-bold text-gray-700 mb-1.5 px-1">${esc(fmtDate(d))}</h3>
          ${byDate[d].map(shiftCard).join('')}
        </section>`).join('') || '<p class="text-center text-gray-400 py-10">この期間のシフトはありません</p>'}</div>`
  }
  window.attMove = function (n) { S.to = dayjs(S.to || today()).add(n, 'day').format('YYYY-MM-DD'); if (S.to > today()) S.to = today(); renderTimeline() }

  function shiftCard(s) {
    const rep = Object.fromEntries(s.reports.map(r => [r.report_type, r]))
    const pend = Object.fromEntries(s.pending.map(p => [p.report_type, p]))
    const absent = s.status === 'absent'
    // 未確定（希望（仮））のシフトは、報告してしまったものだけが返る。打刻の修正・追加は申請できない
    const locked = absent || s.tentative
    const shown = TYPES.filter(t => s.enabled.includes(t) || rep[t] || pend[t])
    const hidden = TYPES.filter(t => !shown.includes(t))
    const row = (t) => {
      const r = rep[t], p = pend[t]
      const action = locked ? '' : p ? `<span class="badge badge-yellow">申請中 ${esc(showAt(p.requested_at, s.work_date))}</span>`
        : `<button class="btn btn-outline text-xs py-1.5" onclick="attOpen(${s.shift_id}, '${t}')">${r ? '修正' : '追加申請'}</button>`
      return `<li class="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
        <span class="w-20 text-sm text-gray-700 shrink-0">${LABEL[t]}</span>
        <span class="flex-1 text-sm ${r ? 'font-bold text-gray-900' : 'text-gray-400'}">${r ? esc(showAt(r.reported_at, s.work_date)) : '未報告'}${r && r.entry_method === 'correction' ? ' <span class="text-[10px] text-gray-400">（修正済み）</span>' : ''}</span>
        ${action}</li>`
    }
    return `<div class="card p-3 mb-2">
      <div class="flex items-center justify-between gap-2"><p class="font-bold text-gray-800 truncate">${esc(s.project_name)}</p>${absent ? '<span class="badge badge-gray">欠勤</span>' : s.tentative ? '<span class="badge badge-yellow">未確定</span>' : ''}</div>
      <p class="text-xs text-gray-500">${esc(s.start_time)}〜${esc(s.end_time)}${s.company_name ? ' ・' + esc(s.company_name) : ''}</p>
      ${s.tentative ? '<p class="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 mt-1">管理者の確定待ちのシフトです。確定されるまで打刻の修正・追加は申請できません。勤務した場合は管理者に連絡してください</p>' : ''}
      <ul class="mt-1">${(s.tentative ? shown.filter(t => rep[t]) : shown).map(row).join('')}</ul>
      ${!locked && hidden.length ? `<details class="mt-1"><summary class="text-xs text-gray-500 py-1 cursor-pointer">この案件で使っていない報告を追加申請する</summary><ul>${hidden.map(row).join('')}</ul></details>` : ''}
    </div>`
  }

  // ---------- 申請（時刻修正・打刻漏れの追加） ----------
  let form = null
  window.attOpen = function (shiftId, type) {
    const s = TL.shifts.find(x => x.shift_id === shiftId); if (!s) return
    const r = s.reports.find(x => x.report_type === type)
    const def = r ? toInput(r.reported_at) : `${s.work_date}T${(type === 'work_end' || type === 'check_out') ? s.end_time : s.start_time}`
    form = { mode: 'new', shift_id: shiftId, report_type: type, kind: r ? 'modify' : 'add', before: r ? r.reported_at : null, work_date: s.work_date, title: s.project_name }
    showForm(def, '')
  }
  function showForm(value, reason, warnings) {
    modal(`<h3 class="font-bold text-gray-800 mb-1">${form.mode === 'resubmit' ? '再申請' : KIND[form.kind]}の申請</h3>
      <p class="text-sm text-gray-600">${esc(fmtDate(form.work_date))} ${esc(form.title)} ・<b>${LABEL[form.report_type]}</b></p>
      ${form.before ? `<p class="text-xs text-gray-500 mt-1">今の記録: ${esc(showAt(form.before, form.work_date))}</p>` : '<p class="text-xs text-gray-500 mt-1">未報告の打刻を追加します</p>'}
      <label class="block text-sm text-gray-700 mt-3">${form.kind === 'modify' ? '正しい日時' : '日時'}<input type="datetime-local" id="att-at" class="inp mt-1" value="${esc(value)}"></label>
      <label class="block text-sm text-gray-700 mt-3">修正理由（必須）<textarea id="att-reason" rows="3" maxlength="500" class="inp mt-1" placeholder="例: 店舗の電波が悪く、入店報告を送れなかったため">${esc(reason)}</textarea></label>
      <div id="att-msg" class="mt-2">${warnings ? warnBox(warnings) : ''}</div>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" id="att-submit" onclick="attSubmit(${warnings ? 'true' : 'false'})">${warnings ? '警告を確認して申請する' : '申請する'}</button></div>`)
  }
  const warnBox = (ws) => `<div class="p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>報告の順序に矛盾があります</p>
    <ul class="list-disc pl-4 space-y-0.5">${ws.map(w => `<li>${esc(w)}</li>`).join('')}</ul><p class="mt-1">打刻漏れの追加は、このまま申請できます（管理者が確認して承認します）</p></div>`
  window.attSubmit = async function (confirmed) {
    if (busy) return
    const at = (document.getElementById('att-at').value || '').replace('T', ' ')
    const reason = document.getElementById('att-reason').value.trim()
    const msg = document.getElementById('att-msg')
    if (!at) { msg.innerHTML = '<p class="text-xs text-red-600">日時を入力してください</p>'; return }
    if (!reason) { msg.innerHTML = '<p class="text-xs text-red-600">修正理由を入力してください</p>'; return }
    const url = form.mode === 'resubmit' ? `/api/staff/corrections/${form.from_id}/resubmit` : '/api/staff/corrections'
    const body = { shift_id: form.shift_id, report_type: form.report_type, kind: form.kind, requested_at: at, reason }
    const btn = document.getElementById('att-submit')
    busy = true; btn.disabled = true
    try {
      if (!confirmed) {
        const { data } = await axios.post(url, { ...body, dry_run: true })
        if (data.warnings && data.warnings.length) { busy = false; return showForm(at.replace(' ', 'T'), reason, data.warnings) }
      }
      await axios.post(url, body)
      closeModal(); toast('申請しました。承認されると記録が変わります')
      S.tab === 'requests' ? renderRequests() : renderTimeline()
    } catch (e) {
      msg.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e))}</p>`; btn.disabled = false
    } finally { busy = false }
  }

  // ---------- 自分の申請 ----------
  let LIST = []
  async function renderRequests() {
    const host = document.getElementById('att-body')
    try { LIST = (await axios.get('/api/staff/corrections')).data.corrections } catch (e) { host.innerHTML = `<p class="text-red-600 text-sm">${esc(errMsg(e))}</p>`; return }
    host.innerHTML = `<div class="space-y-2">${LIST.map(c => `
      <div class="card p-3">
        <div class="flex items-center justify-between gap-2">${statusBadge(c.status)}<span class="text-[11px] text-gray-400">申請 ${esc(dayjs(c.created_at).format('M/D HH:mm'))}</span></div>
        <p class="font-bold text-gray-800 mt-1.5">${esc(fmtDate(c.work_date))} ${LABEL[c.report_type] || ''} <span class="text-xs font-normal text-gray-500">${KIND[c.kind]}</span></p>
        <p class="text-xs text-gray-500 truncate">${esc(c.project_name || '')}</p>
        <p class="text-sm mt-1">${c.before_at ? esc(showAt(c.before_at, c.work_date)) + ' → ' : ''}<b>${esc(showAt(c.requested_at, c.work_date))}</b></p>
        <p class="text-xs text-gray-600 mt-1 whitespace-pre-wrap">理由: ${esc(c.reason)}</p>
        ${c.order_warnings.length ? `<p class="text-[11px] text-amber-700 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>${c.order_warnings.map(esc).join(' / ')}</p>` : ''}
        ${c.status === 'approved' ? `<p class="text-xs text-emerald-700 mt-1.5">承認: ${esc(c.decided_by_name || '')} ${esc(dayjs(c.decided_at).format('M/D HH:mm'))}${c.decision_comment ? '<br>コメント: ' + esc(c.decision_comment) : ''}</p>` : ''}
        ${c.status === 'rejected' ? `<div class="mt-1.5 p-2 rounded bg-red-50 text-xs text-red-800">却下の理由: ${esc(c.reject_reason || '')}${c.decision_comment ? '<br>コメント: ' + esc(c.decision_comment) : ''}<br><span class="text-red-500">${esc(c.decided_by_name || '')} ${esc(dayjs(c.decided_at).format('M/D HH:mm'))}</span></div>` : ''}
        ${c.resubmitted_from ? `<p class="text-[11px] text-gray-400 mt-1">再申請（元の申請 #${c.resubmitted_from}）</p>` : ''}
        <div class="flex gap-2 mt-2">
          <button class="btn btn-outline text-xs flex-1" onclick="attDetail(${c.correction_id})">経緯を見る</button>
          ${c.status === 'pending' && c.mine ? `<button class="btn btn-danger text-xs flex-1" onclick="attCancel(${c.correction_id})">取り消す</button>` : ''}
          ${c.status === 'rejected' && c.mine && !c.resubmitted_count ? `<button class="btn btn-primary text-xs flex-1" onclick="attResubmit(${c.correction_id})">修正して再申請</button>` : ''}
        </div>
      </div>`).join('') || '<p class="text-center text-gray-400 py-10">申請はありません</p>'}</div>`
  }
  window.attCancel = async function (id) {
    if (busy || !confirm('この申請を取り消しますか？')) return
    busy = true
    try { await axios.post(`/api/staff/corrections/${id}/cancel`); toast('取り消しました') } catch (e) { toast(errMsg(e)) } finally { busy = false; renderRequests() }
  }
  window.attResubmit = function (id) {
    const c = LIST.find(x => x.correction_id === id); if (!c) return
    form = { mode: 'resubmit', from_id: id, shift_id: c.shift_id, report_type: c.report_type, kind: c.kind, before: c.before_at, work_date: c.work_date, title: c.project_name }
    showForm(toInput(c.requested_at), c.reason)
  }
  const EVENT = { submitted: '申請', resubmitted: '再申請', approved: '承認', approved_exception: '承認（順序の矛盾を確認済み）', rejected: '却下', cancelled: '取り消し' }
  // ---------- 通知（打刻修正申請の受付・承認・却下）----------
  // ホーム・その他を開いたときに未読件数を表示する（staff.js の renderHome / renderMore から呼ぶ）
  window.loadNotifBanner = async function () {
    let n = 0
    try { n = (await axios.get('/api/staff/notifications/unread-count')).data.count } catch (e) { return }
    const banner = document.getElementById('notif-banner')
    if (banner) banner.innerHTML = n ? `<a href="#notifications" class="block bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800" role="alert"><i class="fas fa-bell mr-1"></i>未読の通知が <b>${n}件</b> あります <span class="underline font-bold ml-1">確認する</span></a>` : ''
    const more = document.getElementById('more-notif-count')
    if (more) { more.textContent = n; more.classList.toggle('hidden', !n) }
  }
  let NOTIF_LIST = []
  window.renderStaffNotifications = async function () {
    loading()
    let d; try { d = (await axios.get('/api/staff/notifications')).data } catch (e) { $app.innerHTML = `<p class="text-red-600 text-sm">${esc(errMsg(e))}</p>`; return }
    NOTIF_LIST = d.notifications
    $app.innerHTML = `
      <div class="flex items-center justify-between mb-3 px-1"><h2 class="font-bold text-gray-800"><i class="fas fa-bell text-blue-600 mr-1"></i>通知</h2>
        ${d.unread ? '<button class="text-xs text-blue-600" onclick="notifReadAllStaff()">すべて既読にする</button>' : ''}</div>
      <div class="space-y-2">${d.notifications.map(n => `
        <button class="card p-3 w-full text-left block ${n.read_at ? '' : 'ring-1 ring-blue-200'}" onclick="notifOpenStaff(${n.notification_id})">
          <div class="flex items-center gap-2">${n.read_at ? '<span class="badge badge-gray">既読</span>' : '<span class="badge badge-blue">未読</span>'}<span class="text-[11px] text-gray-400 ml-auto">${esc(dayjs(n.created_at.replace(' ', 'T')).format('M/D HH:mm'))}</span></div>
          <p class="font-bold text-gray-800 mt-1 text-sm">${esc(n.title)}</p>
          <p class="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">${esc(n.body || '')}</p>
        </button>`).join('') || '<p class="text-center text-gray-400 py-10">通知はありません</p>'}</div>`
  }
  // お知らせの確認のお願い（再通知 #191）は、そのお知らせを開く。それ以外は打刻修正申請の一覧を開く
  window.notifOpenStaff = async function (id) {
    try { await axios.post(`/api/staff/notifications/${id}/read`) } catch (e) { }
    const n = NOTIF_LIST.find(x => x.notification_id === id)
    if (n && /^#notices\/\d+$/.test(n.link || '')) { location.hash = n.link.slice(1); return }
    S.tab = 'requests'; location.hash = 'attendance'
  }
  window.notifReadAllStaff = async function () {
    try { await axios.post('/api/staff/notifications/read-all') } catch (e) { toast(errMsg(e)) }
    renderStaffNotifications()
  }

  window.attDetail = async function (id) {
    let d; try { d = (await axios.get(`/api/staff/corrections/${id}`)).data } catch (e) { toast(errMsg(e)); return }
    const c = d.correction
    modal(`<h3 class="font-bold text-gray-800 mb-1">${LABEL[c.report_type]}（${KIND[c.kind]}）</h3>
      <p class="text-sm text-gray-600 mb-3">${esc(fmtDate(c.work_date))} ${esc(c.project_name || '')} ${statusBadge(c.status)}</p>
      <h4 class="text-xs font-bold text-gray-500 mb-1">この申請の経緯</h4>
      <ol class="space-y-1.5 mb-3">${d.events.map(e => `<li class="text-xs"><span class="text-gray-400">${esc(dayjs(e.created_at).format('M/D HH:mm'))}</span> ${EVENT[e.event] || esc(e.event)} ・${esc(e.actor_name || '')}</li>`).join('')}</ol>
      <h4 class="text-xs font-bold text-gray-500 mb-1">同じ報告の申請</h4>
      <ul class="space-y-1 mb-4">${d.history.map(h => `<li class="text-xs ${h.correction_id === c.correction_id ? 'font-bold' : ''}">#${h.correction_id} ${(STATUS[h.status] || [h.status])[0]} ・${esc(showAt(h.requested_at, c.work_date))}${h.reject_reason ? ' ・却下の理由: ' + esc(h.reject_reason) : ''}</li>`).join('')}</ul>
      <button class="btn btn-outline w-full" onclick="closeModal()">閉じる</button>`)
  }
})()
