// =========================================================
// 打刻修正承認（申請の一覧・詳細・承認・却下・取り消し・再申請・管理者による申請）管理画面
// docs/spec_attendance_correction.md 4章・6.1。admin.js の後に読み込む（#corrections / #corrections/:id）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const STATUS = { pending: ['承認待ち', 'badge-yellow'], approved: ['承認済み', 'badge-green'], rejected: ['却下', 'badge-red'], cancelled: ['取り消し済み', 'badge-gray'] }
  const KIND = { modify: '時刻修正', add: '打刻漏れの追加' }
  const EVENT = { submitted: '申請', resubmitted: '再申請', approved: '承認', approved_exception: '例外として承認', rejected: '却下', cancelled: '取り消し' }
  const ROLE = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', staff: 'スタッフ', system_admin: '本部' }
  const S = window.__corrState = window.__corrState || { status: 'pending', project_id: '', staff_name: '', from: '', to: '', work_from: '', work_to: '', report_type: '', kind: '' }
  let projects = null, ME = null, busy = false
  const statusBadge = (s) => `<span class="badge ${(STATUS[s] || [])[1] || 'badge-gray'}">${(STATUS[s] || [s])[0]}</span>`
  const showAt = (at, wd) => at ? (wd && at.slice(0, 10) === wd ? at.slice(11, 16) : dayjs(at.slice(0, 10)).format('M/D') + ' ' + at.slice(11, 16)) : '－'
  const fmtAt = (at) => at ? dayjs(at.replace(' ', 'T')).format('YYYY/M/D HH:mm') : '－'

  window.refreshCorrectionsBadge = async function () {
    try {
      const { data } = await axios.get('/api/admin/corrections/pending-count')
      const el = document.getElementById('corrections-badge'); if (!el) return
      el.textContent = data.count; el.classList.toggle('hidden', !data.count)
    } catch (e) { }
  }
  setTimeout(() => window.refreshCorrectionsBadge(), 900)

  window.renderCorrections = async function (id) {
    loading()
    if (!projects) { try { projects = (await axios.get('/api/admin/projects')).data.projects || [] } catch { projects = [] } }
    if (!ME) { try { ME = (await axios.get('/api/auth/me')).data } catch { ME = {} } }
    const params = Object.fromEntries(Object.entries(S).filter(([, v]) => v !== '' && v != null))
    let data
    try { data = (await axios.get('/api/admin/corrections', { params })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const n = data.counts || {}
    const tab = (k, l) => `<button class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${S.status === k ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}" onclick="corrSet('status', '${k}')">${l}${k && n[k] ? ` <span class="text-xs opacity-80">${n[k]}</span>` : ''}</button>`
    const rows = data.corrections
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-user-clock text-blue-600 mr-1"></i>打刻修正承認</h2>
          <p class="text-xs text-gray-500 mt-1">スタッフ・管理者からの打刻の修正と打刻漏れの追加の申請です。承認すると勤怠の記録と実績に反映します</p></div>
        <div class="flex gap-2 flex-wrap"><a href="#corrections/emails" class="btn btn-outline text-sm"><i class="fas fa-envelope"></i>メール送信状況</a>
          <button class="btn btn-primary text-sm" onclick="corrNew()"><i class="fas fa-plus"></i>管理者として申請</button></div>
      </div>
      <div class="flex gap-2 overflow-x-auto pb-1 mb-3">${tab('pending', '承認待ち')}${tab('approved', '承認済み')}${tab('rejected', '却下')}${tab('cancelled', '取り消し済み')}${tab('', 'すべて')}</div>
      <details class="card p-3 mb-3" ${['project_id', 'staff_name', 'from', 'to', 'work_from', 'work_to', 'report_type', 'kind'].some(k => S[k]) ? 'open' : ''}>
        <summary class="text-sm font-bold text-gray-700 cursor-pointer"><i class="fas fa-filter text-gray-400 mr-1"></i>絞り込み</summary>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 text-xs">
          <label>案件<select class="inp text-sm" onchange="corrSet('project_id', this.value)"><option value="">すべて</option>${projects.map(p => `<option value="${p.project_id}" ${String(S.project_id) === String(p.project_id) ? 'selected' : ''}>${esc(p.project_name)}</option>`).join('')}</select></label>
          <label>スタッフ名<input class="inp text-sm" value="${esc(S.staff_name)}" placeholder="一部でも可" onchange="corrSet('staff_name', this.value.trim())"></label>
          <label>報告の種類<select class="inp text-sm" onchange="corrSet('report_type', this.value)"><option value="">すべて</option>${TYPES.map(t => `<option value="${t}" ${S.report_type === t ? 'selected' : ''}>${LABEL[t]}</option>`).join('')}</select></label>
          <label>申請の種類<select class="inp text-sm" onchange="corrSet('kind', this.value)"><option value="">すべて</option><option value="modify" ${S.kind === 'modify' ? 'selected' : ''}>時刻修正</option><option value="add" ${S.kind === 'add' ? 'selected' : ''}>打刻漏れの追加</option></select></label>
          <label>申請日（から）<input type="date" class="inp text-sm" value="${S.from}" onchange="corrSet('from', this.value)"></label>
          <label>申請日（まで）<input type="date" class="inp text-sm" value="${S.to}" onchange="corrSet('to', this.value)"></label>
          <label>対象の勤務日（から）<input type="date" class="inp text-sm" value="${S.work_from}" onchange="corrSet('work_from', this.value)"></label>
          <label>対象の勤務日（まで）<input type="date" class="inp text-sm" value="${S.work_to}" onchange="corrSet('work_to', this.value)"></label>
        </div>
        <button class="btn btn-outline text-xs mt-2" onclick="corrClear()">条件をクリア</button>
      </details>
      <div class="hidden md:block card overflow-x-auto">
        <table class="tbl"><thead><tr><th>状態</th><th>勤務日</th><th>案件</th><th>スタッフ</th><th>報告</th><th>種類</th><th>変更前 → 変更後</th><th>申請者・申請日時</th><th></th></tr></thead>
          <tbody>${rows.map(c => `<tr class="cursor-pointer" onclick="location.hash='corrections/${c.correction_id}'">
            <td>${statusBadge(c.status)}${c.order_warnings.length ? ' <i class="fas fa-triangle-exclamation text-amber-500" title="順序の矛盾あり"></i>' : ''}</td>
            <td class="whitespace-nowrap">${esc(c.work_date ? dayjs(c.work_date).format('M/D') : '')}</td>
            <td class="text-xs">${esc(c.project_name || '')}${c.project_status && c.project_status !== 'active' ? ' <span class="badge badge-gray text-[10px]">終了</span>' : ''}</td>
            <td class="whitespace-nowrap">${esc(c.staff_name || '')}</td><td class="whitespace-nowrap">${LABEL[c.report_type] || ''}</td><td class="text-xs whitespace-nowrap">${KIND[c.kind]}</td>
            <td class="text-xs whitespace-nowrap">${c.before_at ? esc(showAt(c.before_at, c.work_date)) : '－'} → <b>${esc(showAt(c.requested_at, c.work_date))}</b></td>
            <td class="text-xs whitespace-nowrap">${esc(c.requested_by_name || '')}<br><span class="text-gray-400">${esc(fmtAt(c.created_at))}</span></td>
            <td><i class="fas fa-chevron-right text-gray-300"></i></td></tr>`).join('') || '<tr><td colspan="9" class="text-center text-gray-400 py-6">申請はありません</td></tr>'}</tbody></table>
      </div>
      <div class="md:hidden space-y-2">${rows.map(c => `<a href="#corrections/${c.correction_id}" class="card p-3 block">
          <div class="flex items-center justify-between gap-2">${statusBadge(c.status)}<span class="text-[11px] text-gray-400">${esc(fmtAt(c.created_at))}</span></div>
          <p class="font-bold text-gray-800 mt-1">${esc(c.staff_name || '')} ・${LABEL[c.report_type] || ''}</p>
          <p class="text-xs text-gray-500">${esc(c.work_date ? dayjs(c.work_date).format('M/D') : '')} ${esc(c.project_name || '')} ・${KIND[c.kind]}</p>
          <p class="text-sm mt-1">${c.before_at ? esc(showAt(c.before_at, c.work_date)) + ' → ' : ''}<b>${esc(showAt(c.requested_at, c.work_date))}</b>${c.order_warnings.length ? ' <span class="badge badge-yellow text-[10px]">順序の矛盾</span>' : ''}</p></a>`).join('') || '<p class="text-center text-gray-400 py-6">申請はありません</p>'}</div>`
    window.refreshCorrectionsBadge()
    if (id) openDetail(id)
  }
  window.corrSet = function (k, v) { S[k] = v; location.hash === '#corrections' ? renderCorrections() : (location.hash = 'corrections') }
  window.corrClear = function () { Object.assign(S, { project_id: '', staff_name: '', from: '', to: '', work_from: '', work_to: '', report_type: '', kind: '' }); renderCorrections() }

  // ---------- 詳細・操作 ----------
  let CUR = null
  async function openDetail(id) {
    let d; try { d = (await axios.get(`/api/admin/corrections/${id}`)).data } catch (e) { toast(errMsg(e)); return }
    CUR = d
    const c = d.correction
    const mine = ME && c.requested_by === ME.user_id
    const warns = c.status === 'pending' ? d.current_conflicts : c.order_warnings
    const dl = (k, v) => `<div class="flex gap-2 py-1 border-b border-gray-50"><dt class="w-28 shrink-0 text-gray-500">${k}</dt><dd class="flex-1 min-w-0 break-words">${v}</dd></div>`
    modal(`<div class="flex items-start justify-between gap-2 mb-2"><h3 class="font-bold text-gray-800">${LABEL[c.report_type]}（${KIND[c.kind]}） #${c.correction_id}</h3>${statusBadge(c.status)}</div>
      <dl class="text-sm">
        ${dl('案件', esc(c.project_name || '') + (c.project_status && c.project_status !== 'active' ? ' <span class="badge badge-gray text-[10px]">終了</span>' : ''))}
        ${dl('スタッフ', esc(c.staff_name || ''))}
        ${dl('勤務', `${esc(c.work_date ? dayjs(c.work_date).format('YYYY/M/D') : '')} ${esc(c.start_time || '')}〜${esc(c.end_time || '')}${c.settle_status === 'confirmed' ? ' <span class="badge badge-blue text-[10px]">確定済み</span>' : ''}`)}
        ${dl('変更前', esc(fmtAt(c.before_at)))}
        ${dl('変更後', `<b>${esc(fmtAt(c.requested_at))}</b>`)}
        ${dl('修正理由', `<span class="whitespace-pre-wrap">${esc(c.reason)}</span>`)}
        ${dl('申請者', `${esc(c.requested_by_name || '')}（${ROLE[c.requested_by_role] || esc(c.requested_by_role || '')}） ${esc(fmtAt(c.created_at))}`)}
        ${c.resubmitted_from ? dl('再申請', `元の申請 <a class="text-blue-600 underline" href="#corrections/${c.resubmitted_from}">#${c.resubmitted_from}</a>`) : ''}
        ${c.decided_at && c.status !== 'cancelled' ? dl(c.status === 'rejected' ? '却下' : '承認', `${esc(c.decided_by_name || '')} ${esc(fmtAt(c.decided_at))}${c.is_exception ? ' <span class="badge badge-yellow text-[10px]">例外承認</span>' : ''}`) : ''}
        ${c.decision_comment ? dl('承認者コメント', `<span class="whitespace-pre-wrap">${esc(c.decision_comment)}</span>`) : ''}
        ${c.reject_reason ? dl('却下理由', `<span class="whitespace-pre-wrap">${esc(c.reject_reason)}</span>`) : ''}
        ${c.cancelled_at ? dl('取り消し', esc(fmtAt(c.cancelled_at))) : ''}
        ${c.applied_while_settled ? dl('反映', '<span class="text-amber-700">確定済みのシフトのため、実績・金額は確定時のままです（確定を取り消して「実績を反映」すると反映されます）</span>') : ''}
      </dl>
      ${warns && warns.length ? `<div class="mt-3 p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>報告の順序の矛盾</p><ul class="list-disc pl-4">${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="mt-3"><p class="text-xs font-bold text-gray-500 mb-1">このシフトの今の記録</p>
        <div class="flex flex-wrap gap-1">${TYPES.map(t => { const r = d.reports.find(x => x.report_type === t); return r ? `<span class="badge ${t === c.report_type ? 'badge-blue' : 'badge-gray'} text-[10px]">${LABEL[t]} ${esc(showAt(r.reported_at, c.work_date))}</span>` : '' }).join('') || '<span class="text-xs text-gray-400">記録はありません</span>'}</div></div>
      <details class="mt-3"><summary class="text-xs font-bold text-gray-500 cursor-pointer">操作の履歴・同じ報告の申請（${d.history.length}件）</summary>
        <ol class="mt-2 space-y-1 text-xs">${d.events.map(e => `<li><span class="text-gray-400">${esc(fmtAt(e.created_at))}</span> ${EVENT[e.event] || esc(e.event)} ・${esc(e.actor_name || '')}${e.detail && e.detail.comment ? ' ・' + esc(e.detail.comment) : ''}${e.detail && e.detail.reason && e.event === 'rejected' ? ' ・' + esc(e.detail.reason) : ''}</li>`).join('')}</ol>
        <ul class="mt-2 space-y-1 text-xs">${d.history.map(h => `<li class="${h.correction_id === c.correction_id ? 'font-bold' : ''}"><a class="text-blue-600" href="#corrections/${h.correction_id}">#${h.correction_id}</a> ${(STATUS[h.status] || [h.status])[0]} ・${KIND[h.kind]} ・${esc(showAt(h.requested_at, c.work_date))} ・${esc(h.requested_by_name || '')}${h.reject_reason ? ' ・却下の理由: ' + esc(h.reject_reason) : ''}</li>`).join('')}</ul></details>
      <div id="corr-actions" class="mt-4 space-y-2">
        ${c.status === 'pending' ? `
          <textarea id="corr-comment" rows="2" maxlength="500" class="inp text-sm" placeholder="承認者コメント（任意）・却下理由（却下するときは必須）"></textarea>
          ${c.kind === 'add' && warns && warns.length ? '<label class="flex items-start gap-2 text-xs text-amber-800"><input type="checkbox" id="corr-exception" class="mt-0.5 w-4 h-4">順序の矛盾を確認しました。例外として承認します</label>' : ''}
          <div class="flex gap-2"><button class="btn btn-danger flex-1" onclick="corrReject(this)"><i class="fas fa-xmark"></i>却下</button>
            <button class="btn btn-primary flex-1" onclick="corrApprove(this)"><i class="fas fa-check"></i>承認</button></div>` : ''}
        ${c.status === 'pending' && mine ? '<button class="btn btn-outline w-full text-sm" onclick="corrCancel(this)">自分の申請を取り消す</button>' : ''}
        ${c.status === 'rejected' && mine && !d.history.some(h => h.resubmitted_from === c.correction_id) ? '<button class="btn btn-outline w-full text-sm" onclick="corrResubmitForm()">修正して再申請</button>' : ''}
        <button class="btn btn-outline w-full text-sm" onclick="closeModal(); if (location.hash !== \'#corrections\') location.hash = \'corrections\'">閉じる</button>
      </div>
      <p id="corr-msg" class="text-xs text-red-600 mt-2"></p>`)
  }
  const done = (msg) => { toast(msg); closeModal(); if (window.refreshNotifBadge) refreshNotifBadge(); location.hash === '#corrections' ? renderCorrections() : (location.hash = 'corrections') }
  const fail = (e, btn) => { document.getElementById('corr-msg').textContent = errMsg(e); if (btn) btn.disabled = false }
  window.corrApprove = async function (btn) {
    if (busy) return
    const c = CUR.correction
    const exEl = document.getElementById('corr-exception')
    if (exEl && !exEl.checked) { document.getElementById('corr-msg').textContent = '順序の矛盾を確認し、チェックを入れてから承認してください'; return }
    busy = true; btn.disabled = true
    try {
      const { data } = await axios.post(`/api/admin/corrections/${c.correction_id}/approve`, { comment: document.getElementById('corr-comment').value, exception: !!(exEl && exEl.checked) })
      done(data.applied_while_settled ? '承認しました（確定済みのため実績・金額は変えていません）' : '承認しました')
    } catch (e) { fail(e, btn) } finally { busy = false }
  }
  window.corrReject = async function (btn) {
    if (busy) return
    const reason = document.getElementById('corr-comment').value.trim()
    if (!reason) { document.getElementById('corr-msg').textContent = '却下理由を入力してください'; return }
    busy = true; btn.disabled = true
    try { await axios.post(`/api/admin/corrections/${CUR.correction.correction_id}/reject`, { reason }); done('却下しました') } catch (e) { fail(e, btn) } finally { busy = false }
  }
  window.corrCancel = async function (btn) {
    if (busy || !confirm('この申請を取り消しますか？')) return
    busy = true; btn.disabled = true
    try { await axios.post(`/api/admin/corrections/${CUR.correction.correction_id}/cancel`); done('取り消しました') } catch (e) { fail(e, btn) } finally { busy = false }
  }
  window.corrResubmitForm = function () {
    const c = CUR.correction
    document.getElementById('corr-actions').innerHTML = `
      <label class="block text-sm">日時<input type="datetime-local" id="corr-at" class="inp" value="${esc(c.requested_at.slice(0, 16).replace(' ', 'T'))}"></label>
      <label class="block text-sm">修正理由<textarea id="corr-reason" rows="3" maxlength="500" class="inp">${esc(c.reason)}</textarea></label>
      <button class="btn btn-primary w-full" onclick="corrSubmit(this, '/api/admin/corrections/${c.correction_id}/resubmit', {})">再申請する</button>`
  }

  // ---------- 管理者による申請 ----------
  window.corrNew = function () {
    modal(`<h3 class="font-bold text-gray-800 mb-2">管理者として申請</h3>
      <label class="block text-sm">勤務日<input type="date" id="cn-date" class="inp" value="${dayjs().format('YYYY-MM-DD')}" onchange="corrLoadShifts()"></label>
      <div id="cn-shifts" class="mt-2"></div><div id="cn-form" class="mt-2"></div>`)
    corrLoadShifts()
  }
  window.corrLoadShifts = async function () {
    const d = document.getElementById('cn-date').value; const host = document.getElementById('cn-shifts')
    let list = []; try { list = (await axios.get('/api/admin/shifts', { params: { from: d, to: d } })).data.shifts || [] } catch (e) { host.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e))}</p>`; return }
    document.getElementById('cn-form').innerHTML = ''
    host.innerHTML = list.length ? `<label class="block text-sm">シフト<select id="cn-shift" class="inp" onchange="corrLoadShift(this.value)"><option value="">選択してください</option>${list.map(s => `<option value="${s.shift_id}">${esc(s.staff_name)} ・${esc(s.project_name)} ${esc(s.start_time)}〜${esc(s.end_time)}${s.status === 'absent' ? '（欠勤）' : ''}</option>`).join('')}</select></label>` : '<p class="text-xs text-gray-400">この日のシフトはありません</p>'
  }
  let NEWCTX = null
  window.corrLoadShift = async function (id) {
    const host = document.getElementById('cn-form'); if (!id) { host.innerHTML = ''; return }
    try { NEWCTX = (await axios.get(`/api/admin/corrections/shift/${id}`)).data } catch (e) { host.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e))}</p>`; return }
    host.innerHTML = `<label class="block text-sm">報告<select id="cn-type" class="inp" onchange="corrTypeChanged()">${TYPES.map(t => { const r = NEWCTX.reports.find(x => x.report_type === t); const p = NEWCTX.pending.find(x => x.report_type === t); return `<option value="${t}" ${p ? 'disabled' : ''}>${LABEL[t]}（${p ? '承認待ちあり' : r ? '記録 ' + showAt(r.reported_at, NEWCTX.shift.work_date) : '未報告'}${NEWCTX.enabled.includes(t) ? '' : '・設定OFF'}）</option>` }).join('')}</select></label>
      <p id="cn-kind" class="text-xs text-gray-500 mt-1"></p>
      <label class="block text-sm mt-2">日時<input type="datetime-local" id="corr-at" class="inp"></label>
      <label class="block text-sm mt-2">修正理由（必須）<textarea id="corr-reason" rows="3" maxlength="500" class="inp"></textarea></label>
      <div id="cn-warn" class="mt-2"></div>
      <button class="btn btn-primary w-full mt-2" id="cn-submit" onclick="corrSubmitNew(this)">申請する</button>
      <p id="corr-msg" class="text-xs text-red-600 mt-2"></p>`
    corrTypeChanged()
  }
  window.corrTypeChanged = function () {
    const t = document.getElementById('cn-type').value
    const r = NEWCTX.reports.find(x => x.report_type === t), s = NEWCTX.shift
    document.getElementById('cn-kind').textContent = r ? `時刻修正（今の記録: ${showAt(r.reported_at, s.work_date)}）` : '打刻漏れの追加'
    document.getElementById('corr-at').value = r ? r.reported_at.slice(0, 16).replace(' ', 'T') : `${s.work_date}T${(t === 'work_end' || t === 'check_out') ? s.end_time : s.start_time}`
    document.getElementById('cn-warn').innerHTML = ''; document.getElementById('cn-submit').dataset.confirmed = ''
  }
  window.corrSubmitNew = async function (btn) {
    const t = document.getElementById('cn-type').value
    const kind = NEWCTX.reports.some(x => x.report_type === t) ? 'modify' : 'add'
    return corrSubmit(btn, '/api/admin/corrections', { shift_id: NEWCTX.shift.shift_id, report_type: t, kind })
  }
  // 申請・再申請の送信（先に dry_run で確認し、順序の矛盾があれば警告を見せてからもう一度押してもらう）
  window.corrSubmit = async function (btn, url, base) {
    if (busy) return
    const at = (document.getElementById('corr-at').value || '').replace('T', ' ')
    const reason = document.getElementById('corr-reason').value.trim()
    const msg = document.getElementById('corr-msg')
    if (!at || !reason) { msg.textContent = '日時と修正理由を入力してください'; return }
    busy = true; btn.disabled = true
    try {
      if (!btn.dataset.confirmed) {
        const { data } = await axios.post(url, { ...base, requested_at: at, reason, dry_run: true })
        if (data.warnings && data.warnings.length) {
          const w = document.getElementById('cn-warn') || msg
          w.innerHTML = `<div class="p-2 rounded bg-amber-50 text-xs text-amber-800"><b>報告の順序に矛盾があります</b><ul class="list-disc pl-4">${data.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>このまま申請できます（承認時に例外として扱います）</div>`
          btn.dataset.confirmed = '1'; btn.textContent = '警告を確認して申請する'; btn.disabled = false; busy = false; return
        }
      }
      await axios.post(url, { ...base, requested_at: at, reason })
      done('申請しました')
    } catch (e) { msg.textContent = errMsg(e); btn.disabled = false } finally { busy = false }
  }
})()
