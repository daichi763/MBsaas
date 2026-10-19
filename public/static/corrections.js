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
  // 承認待ちの申請から何日たったか（2日以上は赤）
  const waitLabel = (c) => {
    if (c.status !== 'pending' || !c.created_at) return ''
    const days = Math.max(0, dayjs().diff(dayjs(c.created_at.replace(' ', 'T')), 'day'))
    return `<span class="block text-[11px] ${days >= 2 ? 'text-red-600 font-bold' : 'text-gray-400'}">申請から${days ? days + '日' : '1日未満'}</span>`
  }
  const MANUAL_NOTE = '実績が手入力のシフトのため、実績・金額は手入力のままです（精算の「実績・金額」で「報告の時刻に戻す」と反映されます）'

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
    // 件数は状態以外の絞り込みを反映した数（すべて = 各状態の合計）
    const total = Object.values(n).reduce((a, x) => a + Number(x || 0), 0)
    const tab = (k, l) => { const cnt = k ? n[k] : total; return `<button class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${S.status === k ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}" onclick="corrSet('status', '${k}')">${l}${cnt ? ` <span class="text-xs opacity-80">${Number(cnt)}</span>` : ''}</button>` }
    const rows = data.corrections
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-user-clock text-blue-600 mr-1"></i>打刻修正承認</h2>
          <p class="text-xs text-gray-500 mt-1">スタッフ・管理者からの打刻の修正と打刻漏れの追加の申請です。承認すると勤怠の記録と実績に反映します</p></div>
        <div class="flex gap-2 flex-wrap"><a href="/api/admin/corrections/export?${new URLSearchParams(params).toString()}" class="btn btn-outline text-sm"><i class="fas fa-file-csv"></i>CSV 出力</a>
          <a href="#corrections/emails" class="btn btn-outline text-sm"><i class="fas fa-envelope"></i>メール送信状況</a>
          <button class="btn btn-primary text-sm" data-action="corrNew"><i class="fas fa-plus"></i>管理者として申請</button></div>
      </div>
      <div class="flex gap-2 overflow-x-auto pb-1 mb-3">${tab('pending', '承認待ち')}${tab('approved', '承認済み')}${tab('rejected', '却下')}${tab('cancelled', '取り消し済み')}${tab('', 'すべて')}</div>
      ${data.truncated ? `<p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 mb-3"><i class="fas fa-circle-info mr-1"></i>該当が多いため、先頭の${Number(data.limit)}件を表示しています（承認待ちは申請の古い順）。絞り込みで件数を減らしてください</p>` : ''}
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
          <tbody>${rows.map(c => `<tr class="cursor-pointer" data-action="corrOpen" data-id="${Number(c.correction_id)}">
            <td>${statusBadge(c.status)}${c.order_warnings.length ? ' <i class="fas fa-triangle-exclamation text-amber-500" title="順序の矛盾あり"></i>' : ''}${waitLabel(c)}</td>
            <td class="whitespace-nowrap">${esc(c.work_date ? dayjs(c.work_date).format('M/D') : '')}</td>
            <td class="text-xs">${esc(c.project_name || '')}${c.project_status && c.project_status !== 'active' ? ' <span class="badge badge-gray text-[10px]">終了</span>' : ''}</td>
            <td class="whitespace-nowrap">${esc(c.staff_name || '')}</td><td class="whitespace-nowrap">${LABEL[c.report_type] || ''}</td><td class="text-xs whitespace-nowrap">${KIND[c.kind]}</td>
            <td class="text-xs whitespace-nowrap">${c.before_at ? esc(showAt(c.before_at, c.work_date)) : '－'} → <b>${esc(showAt(c.requested_at, c.work_date))}</b></td>
            <td class="text-xs whitespace-nowrap">${esc(c.requested_by_name || '')}<br><span class="text-gray-400">${esc(fmtAt(c.created_at))}</span></td>
            <td><i class="fas fa-chevron-right text-gray-300"></i></td></tr>`).join('') || '<tr><td colspan="9" class="text-center text-gray-400 py-6">申請はありません</td></tr>'}</tbody></table>
      </div>
      <div class="md:hidden space-y-2">${rows.map(c => `<a href="#corrections/${Number(c.correction_id)}" class="card p-3 block" data-action="corrOpen" data-id="${Number(c.correction_id)}">
          <div class="flex items-center justify-between gap-2"><span>${statusBadge(c.status)}${waitLabel(c)}</span><span class="text-[11px] text-gray-400">${esc(fmtAt(c.created_at))}</span></div>
          <p class="font-bold text-gray-800 mt-1">${esc(c.staff_name || '')} ・${LABEL[c.report_type] || ''}</p>
          <p class="text-xs text-gray-500">${esc(c.work_date ? dayjs(c.work_date).format('M/D') : '')} ${esc(c.project_name || '')} ・${KIND[c.kind]}</p>
          <p class="text-sm mt-1">${c.before_at ? esc(showAt(c.before_at, c.work_date)) + ' → ' : ''}<b>${esc(showAt(c.requested_at, c.work_date))}</b>${c.order_warnings.length ? ' <span class="badge badge-yellow text-[10px]">順序の矛盾</span>' : ''}</p></a>`).join('') || '<p class="text-center text-gray-400 py-6">申請はありません</p>'}</div>`
    window.refreshCorrectionsBadge()
    // #corrections/new?shift_id=…&staff_id=…&date=… は「管理者として申請」を開く（シフト・スタッフの画面からの入口。#393）
    if (id && /^new(\?|$)/.test(id)) {
      const q = new URLSearchParams(id.slice(4))
      corrNew({ shift_id: q.get('shift_id'), staff_id: q.get('staff_id'), staff_name: q.get('staff_name'), date: q.get('date') })
    } else if (id && /^\d+$/.test(id)) openDetail(Number(id))
  }
  window.corrSet = function (k, v) { S[k] = v; location.hash === '#corrections' ? renderCorrections() : (location.hash = 'corrections') }
  window.corrClear = function () { Object.assign(S, { project_id: '', staff_name: '', from: '', to: '', work_from: '', work_to: '', report_type: '', kind: '' }); renderCorrections() }
  // 一覧の行・カード。背景をタップして閉じた後などで URL が同じままでも、詳細を開き直す（#266）
  delegate('corrOpen', (el, ev) => {
    const id = Number(el.dataset.id)
    if (location.hash === '#corrections/' + id) { if (ev) ev.preventDefault(); openDetail(id) }
    else if (el.tagName !== 'A') location.hash = 'corrections/' + id
  })

  // ---------- 詳細・操作 ----------
  let CUR = null
  const METHOD = { app: 'アプリ', link: '報告用URL', proxy: '代理入力', correction: '打刻修正で追加' }
  const LATE_TYPES = ['check_in', 'work_start'], EARLY_TYPES = ['work_end', 'check_out']
  const yenOrDash = (n) => (n == null ? '－' : '¥' + Number(n).toLocaleString())
  // 報告の入力方法（代理入力・打刻修正は入力した人も）
  const methodLabel = (r) => `${esc(METHOD[r.entry_method || 'app'] || r.entry_method || '')}${r.entered_by_name && (r.entry_method === 'proxy' || r.entry_method === 'correction') ? `（${esc(r.entered_by_name)}）` : ''}`
  // 遅刻・早退・位置の判定（保存された値）
  const judgeBadges = (r) => {
    if (!r) return ''
    const out = []
    if (r.status === 'late') out.push(`<span class="badge badge-red text-[10px]">遅刻${r.late_minutes != null ? ' ' + Number(r.late_minutes) + '分' : ''}</span>`)
    if (r.status === 'no_location') out.push('<span class="badge badge-yellow text-[10px]">位置なし</span>')
    if (Number(r.early_leave_minutes) > 0) out.push(`<span class="badge badge-yellow text-[10px]">早退 ${Number(r.early_leave_minutes)}分</span>`)
    if (r.corrected_by_correction_id) out.push(`<span class="badge badge-gray text-[10px]" title="打刻修正で変わった記録です">修正済み${r.original_reported_at ? '（元 ' + esc(fmtAt(r.original_reported_at)) + '）' : ''}</span>`)
    return out.join(' ')
  }
  const mapLink = (r) => (r.latitude != null && r.longitude != null
    ? `<a class="text-blue-600 underline" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${encodeURIComponent(Number(r.latitude) + ',' + Number(r.longitude))}"><i class="fas fa-location-dot mr-0.5"></i>地図</a>` : '')
  const photoLink = (r) => (r.has_photo ? `<a class="text-blue-600 underline" target="_blank" rel="noopener" href="/api/admin/attendance-photo/${Number(r.attendance_id)}"><i class="fas fa-camera mr-0.5"></i>写真</a>` : '')
  // 修正の対象になっている元の打刻（根拠。#443）
  function evidenceHtml(r, c) {
    if (!r) return `<p class="text-xs text-gray-500">${c.kind === 'add' ? 'この報告はまだ記録されていません（打刻漏れの追加）' : '対象の記録が見つかりません'}</p>`
    return `<div class="text-xs space-y-1">
        <p><b>${esc(showAt(r.reported_at, c.work_date))}</b> ・${methodLabel(r)} ${judgeBadges(r)}</p>
        <p class="text-gray-600">${r.address ? esc(r.address) + ' ' : r.latitude != null ? '' : '<span class="text-gray-400">位置の記録なし</span> '}${mapLink(r)}</p>
        ${r.has_photo ? `<a href="/api/admin/attendance-photo/${Number(r.attendance_id)}" target="_blank" rel="noopener" class="inline-block border rounded-lg overflow-hidden hover:ring-2 ring-blue-300"><img src="/api/admin/attendance-photo/${Number(r.attendance_id)}" alt="${esc(LABEL[r.report_type] || '')}の写真" loading="lazy" class="w-32 h-24 object-cover bg-gray-100"></a>` : ''}
      </div>`
  }
  // 承認した場合の遅刻の判定と実績・金額（変更前 → 変更後。#69 #443）
  function previewHtml(p, c) {
    if (!p) return ''
    const lt = (x) => !x ? '<span class="text-gray-400">記録なし</span>'
      : x.status === 'late' ? `<span class="text-red-600 font-bold">遅刻 ${Number(x.late_minutes || 0)}分</span>`
      : Number(x.early_leave_minutes) > 0 ? `<span class="text-amber-700">早退 ${Number(x.early_leave_minutes)}分</span>`
      : x.status === 'no_location' ? '位置なし（遅刻なし）' : (LATE_TYPES.includes(c.report_type) ? '遅刻なし' : '早退なし')
    const act = (x) => x.actual_start && x.actual_end
      ? `${esc(x.actual_start)}〜${esc(x.actual_end)}${x.actual_break_minutes != null ? `（休憩${Number(x.actual_break_minutes)}分）` : ''} ${Number(x.hours)}h`
      : `予定どおり ${Number(x.hours)}h`
    const a = p.actual, changed = (k) => a.before[k] !== a.after[k]
    const arrow = (b, af, k) => changed(k) ? `${b} → <b>${af}</b>` : `${af}<span class="text-gray-400">（変わりません）</span>`
    const rows = []
    if (LATE_TYPES.includes(c.report_type) || EARLY_TYPES.includes(c.report_type)) rows.push(['遅刻・早退', `${lt(p.lateness.before)} → <b>${lt(p.lateness.after)}</b>`])
    if (a.fixed) rows.push(['実績・金額', `<span class="text-amber-700">${a.fixed === 'settled' ? '確定済みのため、実績・金額は変わりません' : MANUAL_NOTE}</span>`])
    else {
      rows.push(['実働', changed('actual_start') || changed('actual_end') || changed('actual_break_minutes') || changed('hours') ? `${act(a.before)} → <b>${act(a.after)}</b>` : `${act(a.after)}<span class="text-gray-400">（変わりません）</span>`])
      rows.push(['請求', arrow(yenOrDash(a.before.bill_total), yenOrDash(a.after.bill_total), 'bill_total')])
      rows.push(['支払', arrow(yenOrDash(a.before.pay_total), yenOrDash(a.after.pay_total), 'pay_total')])
    }
    return `<p class="text-xs font-bold text-gray-500 mb-1">承認した場合（${esc(fmtAt(p.requested_at))}で反映）</p>
      <dl class="text-xs">${rows.map(([k, v]) => `<div class="flex gap-2 py-0.5"><dt class="w-20 shrink-0 text-gray-500">${k}</dt><dd class="flex-1 min-w-0">${v}</dd></div>`).join('')}</dl>`
  }

  async function openDetail(id) {
    let d; try { d = (await axios.get(`/api/admin/corrections/${id}`)).data } catch (e) { toast(errMsg(e)); return }
    CUR = d
    const c = d.correction
    const mine = ME && c.requested_by === ME.user_id
    const warns = c.status === 'pending' ? d.current_conflicts : c.order_warnings
    // 実績が手入力のシフト（承認しても実績・金額は変わらない）。承認済みは承認時の記録、承認待ちは今のシフトの状態で判断する
    const approvedEv = d.events.find(e => (e.event === 'approved' || e.event === 'approved_exception') && e.detail)
    const appliedWhileManual = !!(approvedEv && approvedEv.detail.applied_while_manual)
    const manualNow = d.shift_actual_source === 'manual' && c.settle_status !== 'confirmed'
    const target = d.reports.find(x => x.report_type === c.report_type)
    // 申請の後に打刻が変わった（時刻修正の変更前と今の記録が違う）
    const changedNow = c.status === 'pending' && c.kind === 'modify' && target && target.reported_at !== c.before_at
    const dl = (k, v) => `<div class="flex gap-2 py-1 border-b border-gray-50"><dt class="w-28 shrink-0 text-gray-500">${k}</dt><dd class="flex-1 min-w-0 break-words">${v}</dd></div>`
    modal(`<div class="flex items-start justify-between gap-2 mb-2"><h3 class="font-bold text-gray-800">${LABEL[c.report_type]}（${KIND[c.kind]}） #${Number(c.correction_id)}</h3>${statusBadge(c.status)}</div>
      <dl class="text-sm">
        ${dl('案件', esc(c.project_name || '') + (c.project_status && c.project_status !== 'active' ? ' <span class="badge badge-gray text-[10px]">終了</span>' : ''))}
        ${dl('スタッフ', esc(c.staff_name || ''))}
        ${dl('勤務', `${esc(c.work_date ? dayjs(c.work_date).format('YYYY/M/D') : '')} ${esc(c.start_time || '')}〜${esc(c.end_time || '')}${c.settle_status === 'confirmed' ? ' <span class="badge badge-blue text-[10px]">確定済み</span>' : ''}`)}
        ${dl('変更前', esc(fmtAt(c.before_at)))}
        ${dl(c.status === 'approved' ? '変更後（承認）' : '変更後', `<b>${esc(fmtAt(c.requested_at))}</b>${approvedEv && approvedEv.detail.adjusted ? ` <span class="badge badge-yellow text-[10px]">修正して承認</span><span class="block text-xs text-gray-500">申請の日時: ${esc(fmtAt(approvedEv.detail.requested_at_original))}</span>` : ''}${approvedEv && approvedEv.detail.rebased ? `<span class="block text-xs text-gray-500">申請の後に変わった記録（申請時の変更前: ${esc(fmtAt(approvedEv.detail.before_at_original))}）をもとに承認</span>` : ''}`)}
        ${dl('修正理由', `<span class="whitespace-pre-wrap">${esc(c.reason)}</span>`)}
        ${dl('申請者', `${esc(c.requested_by_name || '')}（${ROLE[c.requested_by_role] || esc(c.requested_by_role || '')}） ${esc(fmtAt(c.created_at))}`)}
        ${c.resubmitted_from ? dl('再申請', `元の申請 <a class="text-blue-600 underline" href="#corrections/${Number(c.resubmitted_from)}">#${Number(c.resubmitted_from)}</a>`) : ''}
        ${c.decided_at && c.status !== 'cancelled' ? dl(c.status === 'rejected' ? '却下' : '承認', `${esc(c.decided_by_name || '')} ${esc(fmtAt(c.decided_at))}${c.is_exception ? ' <span class="badge badge-yellow text-[10px]">例外承認</span>' : ''}`) : ''}
        ${c.decision_comment ? dl('承認者コメント', `<span class="whitespace-pre-wrap">${esc(c.decision_comment)}</span>`) : ''}
        ${c.reject_reason ? dl('却下理由', `<span class="whitespace-pre-wrap">${esc(c.reject_reason)}</span>`) : ''}
        ${c.cancelled_at ? dl('取り消し', esc(fmtAt(c.cancelled_at))) : ''}
        ${c.applied_while_settled ? dl('反映', '<span class="text-amber-700">確定済みのシフトのため、実績・金額は確定時のままです（精算で確定を取り消すと、報告の時刻が実績・金額に反映されます）</span>') : ''}
        ${appliedWhileManual ? dl('反映', `<span class="text-amber-700">${MANUAL_NOTE}</span>`) : ''}
      </dl>
      ${c.status === 'pending' && manualNow ? `<div class="mt-3 p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800"><i class="fas fa-pen-to-square mr-1"></i>このシフトは実績が手入力です。承認しても勤怠の記録だけが変わり、実績・金額は変わりません（精算の「実績・金額」で「報告の時刻に戻す」と反映されます）</div>` : ''}
      ${changedNow ? `<div class="mt-3 p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800"><i class="fas fa-clock-rotate-left mr-1"></i>申請の後に打刻が変わりました（申請時の変更前: ${esc(fmtAt(c.before_at))} → 今の記録: ${esc(fmtAt(target.reported_at))}）。「日時を修正して承認」で今の記録をもとに承認するか、却下してください</div>` : ''}
      ${warns && warns.length ? `<div class="mt-3 p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>報告の順序の矛盾</p><ul class="list-disc pl-4">${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${c.status === 'pending' ? `<div class="mt-3 p-2.5 rounded-lg bg-gray-50"><p class="text-xs font-bold text-gray-500 mb-1">今の${LABEL[c.report_type]}の記録（根拠）</p>${evidenceHtml(target, c)}</div>
        <div id="corr-preview" class="mt-3 p-2.5 rounded-lg bg-blue-50">${previewHtml(d.preview, c) || '<p class="text-xs text-gray-400">承認した場合の実績・金額を計算できませんでした</p>'}</div>` : ''}
      <div class="mt-3"><p class="text-xs font-bold text-gray-500 mb-1">このシフトの今の記録</p>
        ${d.reports.length ? `<ul class="text-xs divide-y divide-gray-50">${TYPES.map(t => { const r = d.reports.find(x => x.report_type === t); return r ? `<li class="py-1 flex flex-wrap items-center gap-1 ${t === c.report_type ? 'font-bold' : ''}">
          <span class="w-16 shrink-0">${LABEL[t]}</span><span>${esc(showAt(r.reported_at, c.work_date))}</span><span class="text-gray-500">・${methodLabel(r)}</span>${judgeBadges(r)} ${mapLink(r)} ${photoLink(r)}</li>` : '' }).join('')}</ul>` : '<span class="text-xs text-gray-400">記録はありません</span>'}</div>
      <details class="mt-3"><summary class="text-xs font-bold text-gray-500 cursor-pointer">操作の履歴・同じ報告の申請（${d.history.length}件）</summary>
        <ol class="mt-2 space-y-1 text-xs">${d.events.map(e => `<li><span class="text-gray-400">${esc(fmtAt(e.created_at))}</span> ${EVENT[e.event] || esc(e.event)} ・${esc(e.actor_name || '')}${e.detail && e.detail.adjusted ? ` ・申請 ${esc(fmtAt(e.detail.requested_at_original))} を ${esc(fmtAt(e.detail.requested_at))} に修正して承認` : ''}${e.detail && e.detail.report_status === 'late' ? ` ・遅刻${e.detail.late_minutes != null ? ' ' + Number(e.detail.late_minutes) + '分' : ''}` : e.detail && e.detail.before_status === 'late' && e.detail.report_status ? ' ・遅刻を解消' : ''}${e.detail && e.detail.comment ? ' ・' + esc(e.detail.comment) : ''}${e.detail && e.detail.reason && e.event === 'rejected' ? ' ・' + esc(e.detail.reason) : ''}</li>`).join('')}</ol>
        <ul class="mt-2 space-y-1 text-xs">${d.history.map(h => `<li class="${h.correction_id === c.correction_id ? 'font-bold' : ''}"><a class="text-blue-600" href="#corrections/${Number(h.correction_id)}">#${Number(h.correction_id)}</a> ${(STATUS[h.status] || [h.status])[0]} ・${KIND[h.kind]} ・${esc(showAt(h.requested_at, c.work_date))} ・${esc(h.requested_by_name || '')}${h.reject_reason ? ' ・却下の理由: ' + esc(h.reject_reason) : ''}</li>`).join('')}</ul></details>
      <div id="corr-actions" class="mt-4 space-y-2">
        ${c.status === 'pending' ? `
          <textarea id="corr-comment" rows="2" maxlength="500" class="inp text-sm" placeholder="承認者コメント（任意。日時を修正して承認するときは修正の理由として必須）・却下理由（却下するときは必須）"></textarea>
          ${c.kind === 'add' && warns && warns.length ? '<label class="flex items-start gap-2 text-xs text-amber-800"><input type="checkbox" id="corr-exception" class="mt-0.5 w-4 h-4">順序の矛盾を確認しました。例外として承認します</label>' : ''}
          <div id="corr-adjust" class="hidden p-2.5 rounded-lg border border-blue-200 space-y-2">
            <label class="block text-sm">承認する日時<input type="datetime-local" id="corr-adjust-at" class="inp"></label>
            <p id="corr-adjust-base" class="text-xs text-gray-500"></p>
            <p class="text-xs text-gray-500">申請の日時は操作の履歴に残り、申請者には修正した日時で知らせます。修正の理由を上のコメントに入力してください</p>
            <button type="button" class="btn btn-primary w-full" data-action="corrApproveAdjusted"><i class="fas fa-check"></i>この日時で承認</button>
          </div>
          <div class="flex gap-2"><button class="btn btn-danger flex-1" onclick="corrReject(this)"><i class="fas fa-xmark"></i>却下</button>
            <button class="btn btn-outline flex-1" id="corr-adjust-open" data-action="corrAdjustForm"><i class="fas fa-pen"></i>日時を修正して承認</button>
            <button class="btn btn-primary flex-1" onclick="corrApprove(this)" ${changedNow ? 'disabled title="申請の後に打刻が変わったため、日時を修正して承認するか、却下してください"' : ''}><i class="fas fa-check"></i>承認</button></div>` : ''}
        ${c.status === 'pending' && mine ? '<button class="btn btn-outline w-full text-sm" onclick="corrCancel(this)">自分の申請を取り消す</button>' : ''}
        ${c.status === 'rejected' && mine && !d.history.some(h => h.resubmitted_from === c.correction_id) ? '<button class="btn btn-outline w-full text-sm" onclick="corrResubmitForm()">修正して再申請</button>' : ''}
        <button class="btn btn-outline w-full text-sm" onclick="closeModal()">閉じる</button>
      </div>
      <p id="corr-msg" class="text-xs text-red-600 mt-2"></p>`, {
      // 背景をタップして閉じたときも URL を一覧に戻し、同じ申請を開き直せるようにする（#266）
      onClose: () => { if (location.hash === '#corrections/' + c.correction_id) history.replaceState(null, '', '#corrections') },
    })
    if (changedNow) corrAdjustForm(target.reported_at)
  }
  const done = (msg) => { toast(msg); closeModal(); if (window.refreshNotifBadge) refreshNotifBadge(); location.hash === '#corrections' ? renderCorrections() : (location.hash = 'corrections') }
  const fail = (e, btn) => { document.getElementById('corr-msg').textContent = errMsg(e); if (btn) btn.disabled = false }
  const approvedMsg = (data) => (data.applied_while_settled ? '承認しました（確定済みのため実績・金額は変えていません）'
    : data.applied_while_manual ? '承認しました（実績が手入力のため実績・金額は変えていません。精算で「報告の時刻に戻す」と反映されます）' : '承認しました')
  // 承認の送信（body に requested_at・base_at を付けると、日時を修正して承認する）
  async function sendApprove(btn, extra) {
    if (busy) return
    const c = CUR.correction
    const exEl = document.getElementById('corr-exception')
    if (exEl && !exEl.checked) { document.getElementById('corr-msg').textContent = '順序の矛盾を確認し、チェックを入れてから承認してください'; return }
    busy = true; btn.disabled = true
    try {
      const { data } = await axios.post(`/api/admin/corrections/${c.correction_id}/approve`, { comment: document.getElementById('corr-comment').value, exception: !!(exEl && exEl.checked), ...extra })
      done(data.adjusted ? '日時を修正して承認しました' : approvedMsg(data))
    } catch (e) {
      fail(e, btn)
      // 申請の後に打刻が変わった: 今の記録をもとに日時を修正して承認できるようにする（#548）
      const d = e.response && e.response.data
      if (d && d.changed && d.current_at) corrAdjustForm(d.current_at)
    } finally { busy = false }
  }
  window.corrApprove = function (btn) { return sendApprove(btn, {}) }
  // 日時を修正して承認する欄を開く。baseAt は申請の後に変わった今の記録（その記録をもとに承認する）
  function corrAdjustForm(baseAt) {
    const c = CUR.correction, box = document.getElementById('corr-adjust'); if (!box) return
    box.classList.remove('hidden')
    const open = document.getElementById('corr-adjust-open'); if (open) open.classList.add('hidden')
    const inp = document.getElementById('corr-adjust-at')
    if (!inp.value) inp.value = String(c.requested_at).slice(0, 16).replace(' ', 'T')
    box.dataset.baseAt = baseAt || ''
    document.getElementById('corr-adjust-base').textContent = baseAt ? `今の記録（${fmtAt(baseAt)}）をもとに承認します` : ''
    inp.onchange = () => adjustPreview()
    adjustPreview()
  }
  delegate('corrAdjustForm', () => corrAdjustForm(''))
  // 修正した日時で、承認した場合の遅刻の判定と実績・金額を計算し直す（書き込まない）
  let previewSeq = 0
  async function adjustPreview() {
    const c = CUR.correction, box = document.getElementById('corr-adjust'), host = document.getElementById('corr-preview')
    const at = (document.getElementById('corr-adjust-at').value || '').replace('T', ' ')
    if (!at || !host) return
    const seq = ++previewSeq
    try {
      const { data } = await axios.post(`/api/admin/corrections/${c.correction_id}/approve`, { requested_at: at, base_at: box.dataset.baseAt || undefined, dry_run: true })
      if (seq !== previewSeq) return
      host.innerHTML = previewHtml(data.preview, c) + (data.conflicts && data.conflicts.length ? `<p class="text-xs text-amber-800 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>${data.conflicts.map(esc).join(' / ')}</p>` : '')
      document.getElementById('corr-msg').textContent = ''
    } catch (e) { if (seq === previewSeq) document.getElementById('corr-msg').textContent = errMsg(e) }
  }
  delegate('corrApproveAdjusted', (el) => {
    const at = (document.getElementById('corr-adjust-at').value || '').replace('T', ' ')
    if (!at) { document.getElementById('corr-msg').textContent = '承認する日時を入力してください'; return }
    if (!document.getElementById('corr-comment').value.trim()) { document.getElementById('corr-msg').textContent = '日時を修正した理由をコメントに入力してください'; return }
    const baseAt = document.getElementById('corr-adjust').dataset.baseAt
    return sendApprove(el, baseAt ? { requested_at: at, base_at: baseAt } : { requested_at: at })
  })
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
      <button class="btn btn-primary w-full" onclick="corrSubmit(this, '/api/admin/corrections/${Number(c.correction_id)}/resubmit', {})">再申請する</button>`
  }

  // ---------- 管理者による申請（#393） ----------
  // 勤務日の範囲・スタッフ・氏名／案件名で絞ったシフトの候補から選ぶ。opts.shift_id を渡すと、そのシフトを選んだ状態で開く。
  // ほかの画面からは <button data-action="corrNew" data-shift-id="…"> か data-staff-id・data-staff-name・data-date で開ける
  const NQ = { from: '', to: '', q: '', staff_id: '', staff_name: '' }
  window.corrNew = function (opts) {
    opts = opts || {}
    const today = dayjs().format('YYYY-MM-DD')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(opts.date || '') ? opts.date : today
    Object.assign(NQ, { from: date, to: date, q: '', staff_id: /^\d+$/.test(String(opts.staff_id || '')) ? String(opts.staff_id) : '', staff_name: opts.staff_name || '' })
    modal(`<h3 class="font-bold text-gray-800 mb-1">管理者として申請</h3>
      <p class="text-xs text-gray-500 mb-2">打刻の修正・打刻漏れの追加を、スタッフに代わって申請します。欠勤・希望（仮）のシフトには申請できません</p>
      <div id="cn-search">
        <div class="grid grid-cols-2 gap-2">
          <label class="block text-xs">勤務日（から）<input type="date" id="cn-from" class="inp text-sm" value="${esc(NQ.from)}"></label>
          <label class="block text-xs">勤務日（まで）<input type="date" id="cn-to" class="inp text-sm" value="${esc(NQ.to)}"></label>
        </div>
        <label class="block text-xs mt-2">スタッフ名・案件名・社員番号<input id="cn-q" class="inp text-sm" placeholder="一部でも可" autocomplete="off"></label>
        <p id="cn-staff" class="text-xs mt-1 ${NQ.staff_id ? '' : 'hidden'}">スタッフ: <b>${esc(NQ.staff_name || '#' + NQ.staff_id)}</b> <button type="button" class="text-blue-600 underline ml-1" data-action="corrClearStaff">すべてのスタッフ</button></p>
        <div id="cn-shifts" class="mt-2"></div>
      </div>
      <div id="cn-form" class="mt-2"></div>`, {
      onClose: () => { if (/^#corrections\/new/.test(location.hash)) history.replaceState(null, '', '#corrections') },
    })
    const reload = () => { NQ.from = document.getElementById('cn-from').value; NQ.to = document.getElementById('cn-to').value || NQ.from; corrLoadShifts() }
    document.getElementById('cn-from').onchange = () => { const t = document.getElementById('cn-to'); if (!t.value || t.value < document.getElementById('cn-from').value) t.value = document.getElementById('cn-from').value; reload() }
    document.getElementById('cn-to').onchange = reload
    let timer = null
    document.getElementById('cn-q').oninput = (ev) => { clearTimeout(timer); timer = setTimeout(() => { NQ.q = ev.target.value.trim(); corrLoadShifts() }, 300) }
    if (/^\d+$/.test(String(opts.shift_id || ''))) corrLoadShift(Number(opts.shift_id))
    else corrLoadShifts()
  }
  delegate('corrNew', (el) => corrNew({ shift_id: el.dataset.shiftId, staff_id: el.dataset.staffId, staff_name: el.dataset.staffName, date: el.dataset.date }))
  delegate('corrClearStaff', () => { NQ.staff_id = ''; NQ.staff_name = ''; document.getElementById('cn-staff').classList.add('hidden'); corrLoadShifts() })
  let shiftSeq = 0
  window.corrLoadShifts = async function () {
    const host = document.getElementById('cn-shifts'); if (!host) return
    document.getElementById('cn-search').classList.remove('hidden')
    document.getElementById('cn-form').innerHTML = ''
    const seq = ++shiftSeq
    host.innerHTML = '<p class="text-xs text-gray-400">読み込み中…</p>'
    const params = { from: NQ.from, to: NQ.to }
    if (NQ.q) params.q = NQ.q
    if (NQ.staff_id) params.staff_id = NQ.staff_id
    let data
    try { data = (await axios.get('/api/admin/corrections/shift-candidates', { params })).data } catch (e) { if (seq === shiftSeq) host.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e))}</p>`; return }
    if (seq !== shiftSeq) return
    const list = data.shifts || []
    const multiDay = NQ.from !== NQ.to
    host.innerHTML = list.length ? `<div class="max-h-72 overflow-y-auto space-y-1">${list.map(s => `
        <button type="button" class="w-full text-left px-2 py-1.5 rounded-lg border border-gray-200 hover:bg-blue-50 text-xs" data-action="corrPickShift" data-id="${Number(s.shift_id)}">
          <span class="font-bold text-gray-800">${esc(s.staff_name)}</span>${s.employee_number ? ` <span class="text-gray-400">${esc(s.employee_number)}</span>` : ''}
          <span class="block text-gray-500">${multiDay ? esc(dayjs(s.work_date).format('M/D')) + ' ' : ''}${esc(s.start_time)}〜${esc(s.end_time)} ・${esc(s.project_name)}
            ${Number(s.report_count) ? ` ・報告${Number(s.report_count)}件` : ' ・報告なし'}${Number(s.pending_count) ? ` <span class="badge badge-yellow text-[10px]">承認待ち${Number(s.pending_count)}</span>` : ''}${s.settle_status === 'confirmed' ? ' <span class="badge badge-blue text-[10px]">確定済み</span>' : ''}</span>
        </button>`).join('')}</div>${data.truncated ? `<p class="text-xs text-amber-700 mt-1">該当が多いため、先頭の${Number(data.limit)}件を表示しています。名前や期間で絞り込んでください</p>` : ''}`
      : '<p class="text-xs text-gray-400">条件に合うシフトはありません（欠勤・希望（仮）のシフトは出ません）</p>'
  }
  delegate('corrPickShift', (el) => corrLoadShift(Number(el.dataset.id)))
  delegate('corrBackToShifts', () => corrLoadShifts())
  let NEWCTX = null
  window.corrLoadShift = async function (id) {
    const host = document.getElementById('cn-form'); if (!id) { host.innerHTML = ''; return }
    try { NEWCTX = (await axios.get(`/api/admin/corrections/shift/${Number(id)}`)).data } catch (e) { host.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e))}</p>`; return }
    const s = NEWCTX.shift
    // 選んだシフトを示し、候補の一覧は畳む（別のシフトを選び直せる）
    document.getElementById('cn-search').classList.add('hidden')
    host.innerHTML = `<div class="p-2 rounded-lg bg-gray-50 text-sm flex items-start justify-between gap-2">
        <div><b>${esc(s.staff_name)}</b><span class="block text-xs text-gray-500">${esc(dayjs(s.work_date).format('YYYY/M/D'))} ${esc(s.start_time)}〜${esc(s.end_time)} ・${esc(s.project_name)}${s.settled ? ' <span class="badge badge-blue text-[10px]">確定済み</span>' : ''}</span></div>
        <button type="button" class="text-xs text-blue-600 underline whitespace-nowrap" data-action="corrBackToShifts">別のシフトを選ぶ</button></div>
      ${!['confirmed', 'substitute'].includes(s.status) ? `<p class="text-xs text-red-600 mt-2">${s.status === 'absent' ? '欠勤' : '未確定（希望（仮））'}のシフトには申請できません</p>` : `
      <label class="block text-sm mt-2">報告<select id="cn-type" class="inp" onchange="corrTypeChanged()">${TYPES.map(t => { const r = NEWCTX.reports.find(x => x.report_type === t); const p = NEWCTX.pending.find(x => x.report_type === t); return `<option value="${t}" ${p ? 'disabled' : ''}>${LABEL[t]}（${p ? '承認待ちあり' : r ? '記録 ' + esc(showAt(r.reported_at, s.work_date)) : '未報告'}${NEWCTX.enabled.includes(t) ? '' : '・設定OFF'}）</option>` }).join('')}</select></label>
      <p id="cn-kind" class="text-xs text-gray-500 mt-1"></p>
      <label class="block text-sm mt-2">日時<input type="datetime-local" id="corr-at" class="inp"></label>
      <label class="block text-sm mt-2">修正理由（必須）<textarea id="corr-reason" rows="3" maxlength="500" class="inp"></textarea></label>
      <div id="cn-warn" class="mt-2"></div>
      <button class="btn btn-primary w-full mt-2" id="cn-submit" onclick="corrSubmitNew(this)">申請する</button>
      <p id="corr-msg" class="text-xs text-red-600 mt-2"></p>`}`
    if (document.getElementById('cn-type')) corrTypeChanged()
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
