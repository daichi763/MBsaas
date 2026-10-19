// =========================================================
// 勤怠管理: 履歴の検索・CSV 出力（打刻修正の操作履歴 / 報告設定の変更履歴）
// docs/spec_attendance_correction.md 10章。admin.js の後に読み込む（#attendance-history）
// 申請の一覧の CSV は「打刻修正承認」、メールの送信状況の CSV は「メール送信状況」から出力する
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const EVENT = { submitted: '申請', resubmitted: '再申請', approved: '承認', approved_exception: '例外承認', rejected: '却下', cancelled: '取り消し' }
  // shift_override = シフト単位の例外（#313）/ default_apply = 標準設定を今の所属スタッフに適用（#329）/ staff_reset = 案件の標準設定に戻す（#413）
  const ACTION = { project_default: '標準設定', default_apply: '標準設定の適用', individual: '個別変更', bulk: '一括変更', staff_reset: '標準に戻す', shift_override: 'シフト単位の例外', migration: '導入時の移行', merge: 'スタッフ統合' }
  const KIND = { modify: '時刻修正', add: '打刻漏れの追加' }
  const S = window.__histState = window.__histState || { tab: 'events', from: '', to: '', project_id: '', staff_name: '', report_type: '', event: '', action: '', exclude_migration: '1' }
  let projects = null
  const fmtAt = (at) => at ? dayjs(at.replace(' ', 'T')).format('YYYY/M/D HH:mm') : ''
  const params = () => {
    const p = { from: S.from, to: S.to, project_id: S.project_id, staff_name: S.staff_name, report_type: S.report_type }
    if (S.tab === 'events') p.event = S.event; else { p.action = S.action; p.exclude_migration = S.exclude_migration }
    return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null))
  }

  window.renderAttendanceHistory = async function () {
    loading()
    if (!projects) { try { projects = (await axios.get('/api/admin/projects')).data.projects || [] } catch { projects = [] } }
    const isEv = S.tab === 'events'
    let rows, total = 0, csvLimit = 10000
    try {
      const d = isEv ? (await axios.get('/api/admin/corrections/events', { params: params() })).data
        : (await axios.get('/api/admin/report-settings/logs', { params: { ...params(), limit: 300 } })).data
      rows = isEv ? d.events : d.logs
      total = d.total ?? rows.length; csvLimit = d.csv_limit || csvLimit
    } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const csvUrl = (isEv ? '/api/admin/corrections/events/export?' : '/api/admin/report-settings/logs/export?') + new URLSearchParams(params()).toString()
    const tab = (k, l) => `<button class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${S.tab === k ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}" onclick="histSet('tab', '${k}')">${l}</button>`
    const onoff = (v) => v == null ? '－' : v ? 'ON' : 'OFF'
    // 同じ氏名のスタッフが一覧にいるときは、社員番号（なければスタッフID）を添える（#474）
    const ids = new Map()
    for (const x of rows) if (x.staff_id) { const set = ids.get(x.staff_name) || new Set(); set.add(x.staff_id); ids.set(x.staff_name, set) }
    const who = (x) => esc(x.staff_name || '') + ((ids.get(x.staff_name) || new Set()).size > 1 ? ` <span class="text-gray-400">（${x.employee_number ? '社員番号 ' + esc(x.employee_number) : 'ID ' + Number(x.staff_id)}）</span>` : '')
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-clock-rotate-left text-blue-600 mr-1"></i>履歴・CSV</h2>
          <p class="text-xs text-gray-500 mt-1">打刻修正の操作（申請・再申請・承認・却下・取り消し）と、報告設定の変更の履歴です。終了した案件の履歴も表示します</p></div>
        <a class="btn btn-primary text-sm" href="${esc(csvUrl)}"><i class="fas fa-file-csv"></i>表示中の条件で CSV 出力</a>
      </div>
      <div class="flex gap-2 mb-3">${tab('events', '打刻修正の操作履歴')}${tab('settings', '報告設定の変更履歴')}</div>
      <details class="card p-3 mb-3" ${window.innerWidth >= 768 || Object.keys(params()).length ? 'open' : ''}>
      <summary class="text-sm font-bold text-gray-700 cursor-pointer"><i class="fas fa-filter text-gray-400 mr-1"></i>絞り込み</summary>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 text-xs mt-2">
        <label>期間（から）<input type="date" class="inp text-sm" value="${S.from}" onchange="histSet('from', this.value)"></label>
        <label>期間（まで）<input type="date" class="inp text-sm" value="${S.to}" onchange="histSet('to', this.value)"></label>
        <label>案件<select class="inp text-sm" onchange="histSet('project_id', this.value)"><option value="">すべて</option>${projects.map(p => `<option value="${p.project_id}" ${String(S.project_id) === String(p.project_id) ? 'selected' : ''}>${esc(p.project_name)}${p.status && p.status !== 'active' ? '（終了）' : ''}</option>`).join('')}</select></label>
        <label>スタッフ名<input class="inp text-sm" value="${esc(S.staff_name)}" placeholder="氏名の一部・社員番号" onchange="histSet('staff_name', this.value.trim())"></label>
        <label>報告の種類<select class="inp text-sm" onchange="histSet('report_type', this.value)"><option value="">すべて</option>${TYPES.map(t => `<option value="${t}" ${S.report_type === t ? 'selected' : ''}>${LABEL[t]}</option>`).join('')}</select></label>
        ${isEv ? `<label>操作<select class="inp text-sm" onchange="histSet('event', this.value)"><option value="">すべて</option><option value="submitted,resubmitted" ${S.event === 'submitted,resubmitted' ? 'selected' : ''}>申請・再申請</option><option value="approved,approved_exception" ${S.event === 'approved,approved_exception' ? 'selected' : ''}>承認（例外承認を含む）</option><option value="approved_exception" ${S.event === 'approved_exception' ? 'selected' : ''}>例外承認のみ</option><option value="rejected" ${S.event === 'rejected' ? 'selected' : ''}>却下</option><option value="cancelled,resubmitted" ${S.event === 'cancelled,resubmitted' ? 'selected' : ''}>取り消し・再申請</option></select></label>`
        : `<label>操作<select class="inp text-sm" onchange="histSet('action', this.value)"><option value="">すべて</option>${Object.entries(ACTION).map(([k, l]) => `<option value="${k}" ${S.action === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="flex items-center gap-1 self-end pb-2"><input type="checkbox" ${S.exclude_migration === '1' ? 'checked' : ''} onchange="histSet('exclude_migration', this.checked ? '1' : '')">導入時の移行を除く</label>`}
      </div></details>
      <p class="text-[11px] text-gray-400 mb-2">条件に合う履歴は ${total.toLocaleString()} 件です。画面には新しい順に最大 300 件を表示します（CSV は新しい順に最大 ${csvLimit.toLocaleString()} 件を、古い順に並べて出力します）</p>
      ${total > csvLimit ? `<p class="text-xs text-red-600 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>CSV に入るのは新しい ${csvLimit.toLocaleString()} 件だけです。期間を区切って、複数回に分けて出力してください</p>` : ''}
      ${isEv ? `
      <div class="hidden md:block card overflow-x-auto"><table class="tbl"><thead><tr><th>日時</th><th>操作</th><th>操作した人</th><th>申請</th><th>案件</th><th>スタッフ</th><th>報告</th><th>内容</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td class="text-xs whitespace-nowrap">${esc(fmtAt(r.created_at))}</td><td class="whitespace-nowrap">${EVENT[r.event] || esc(r.event)}</td><td class="text-xs whitespace-nowrap">${esc(r.actor_name || '')}</td>
          <td class="text-xs whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#corrections/${r.correction_id}">#${r.correction_id}</a> ${KIND[r.kind] || ''}</td><td class="text-xs">${esc(r.project_name || '')}</td>
          <td class="text-xs whitespace-nowrap">${who(r)}</td><td class="text-xs whitespace-nowrap">${r.work_date ? dayjs(r.work_date).format('M/D') : ''} ${LABEL[r.report_type] || ''}</td><td class="text-xs">${esc(r.summary || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="text-center text-gray-400 py-6">履歴はありません</td></tr>'}</tbody></table></div>
      <div class="md:hidden space-y-2">${rows.map(r => `<div class="card p-3 text-xs"><p><b>${EVENT[r.event] || esc(r.event)}</b> ・${esc(r.actor_name || '')} <span class="text-gray-400">${esc(fmtAt(r.created_at))}</span></p>
        <p class="mt-0.5"><a class="text-blue-600" href="#corrections/${r.correction_id}">#${r.correction_id}</a> ${who(r)} ${r.work_date ? dayjs(r.work_date).format('M/D') : ''} ${LABEL[r.report_type] || ''}</p>
        <p class="text-gray-500 mt-0.5 break-words">${esc(r.summary || '')}</p></div>`).join('') || '<p class="text-center text-gray-400 py-6">履歴はありません</p>'}</div>`
      : `
      <div class="hidden md:block card overflow-x-auto"><table class="tbl"><thead><tr><th>日時</th><th>案件</th><th>対象</th><th>報告</th><th>変更</th><th>操作</th><th>変更者</th></tr></thead>
        <tbody>${rows.map(l => `<tr><td class="text-xs whitespace-nowrap">${esc(fmtAt(l.created_at))}</td><td class="text-xs">${esc(l.project_name || '')}${l.project_status && l.project_status !== 'active' ? ' <span class="badge badge-gray text-[10px]">終了</span>' : ''}</td>
          <td class="text-xs">${l.staff_id ? who(l) : '<span class="badge badge-blue text-[10px]">標準設定</span>'}</td><td class="text-xs whitespace-nowrap">${LABEL[l.report_type] || esc(l.report_type)}</td>
          <td class="text-xs whitespace-nowrap">${onoff(l.old_enabled)} → <b>${onoff(l.new_enabled)}</b></td><td class="text-xs">${ACTION[l.action] || esc(l.action)}${l.detail ? `<span class="block text-[11px] text-gray-500">${esc(l.detail)}</span>` : ''}</td>
          <td class="text-xs whitespace-nowrap">${esc(l.changed_by_name || (l.action === 'migration' ? 'システム' : ''))}</td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400 py-6">履歴はありません</td></tr>'}</tbody></table></div>
      <div class="md:hidden space-y-2">${rows.map(l => `<div class="card p-3 text-xs"><p><b>${l.staff_id ? who(l) : '標準設定'}</b> ・${LABEL[l.report_type] || ''} ${onoff(l.old_enabled)} → <b>${onoff(l.new_enabled)}</b></p>
        <p class="text-gray-500 mt-0.5">${esc(l.project_name || '')} ・${ACTION[l.action] || ''} ・${esc(l.changed_by_name || (l.action === 'migration' ? 'システム' : ''))} ・${esc(fmtAt(l.created_at))}</p>${l.detail ? `<p class="text-gray-500 mt-0.5">${esc(l.detail)}</p>` : ''}</div>`).join('') || '<p class="text-center text-gray-400 py-6">履歴はありません</p>'}</div>`}`
  }
  window.histSet = function (k, v) { S[k] = v; renderAttendanceHistory() }
})()
