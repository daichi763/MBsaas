// =========================================================
// 案件報告管理（勤怠報告 8 種類の ON/OFF・一括変更・変更履歴）管理画面
// docs/spec_attendance_correction.md 2章・3章。admin.js の後に読み込む（#report-settings / #report-settings/:projectId）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const SHORT = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '開始', break_start: '休入', break_end: '休出', work_end: '終了', check_out: '退店' }
  const ACTION = { project_default: '標準設定', individual: '個別変更', bulk: '一括変更', migration: '導入時の移行' }
  const AFF = { own_employee: '自社雇用', daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属', linked_external: '他社連携', skillsheet_only: 'スキルシートのみ' }
  const S = window.__rsState = window.__rsState || { includeClosed: false, logType: '', logStaff: '' }
  let current = null // 表示中の案件詳細
  let busy = false

  window.renderReportSettings = function (id) { return id ? renderDetail(id) : renderList() }

  // ---------- 案件一覧 ----------
  async function renderList() {
    loading()
    let data
    try { data = (await axios.get('/api/admin/report-settings/projects', { params: S.includeClosed ? { include_closed: 1 } : {} })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const rows = data.projects || []
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-list-check text-blue-600 mr-1"></i>案件報告管理</h2>
          <p class="text-xs text-gray-500 mt-1">案件ごと・スタッフごとに、勤怠報告 8 種類（起床〜退店）の ON/OFF を設定します。案件を選んでください</p></div>
        <label class="flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" ${S.includeClosed ? 'checked' : ''} onchange="rsToggleClosed(this.checked)">終了した案件も表示</label>
      </div>
      <div class="hidden md:block card overflow-x-auto">
        <table class="tbl"><thead><tr><th>案件</th><th>クライアント</th><th>状態</th><th class="text-right">所属スタッフ</th><th>標準設定</th><th></th></tr></thead>
          <tbody>${rows.map(p => `<tr class="cursor-pointer" onclick="location.hash='report-settings/${p.project_id}'">
            <td class="font-medium text-blue-700">${esc(p.project_name)}</td><td class="text-xs">${esc(p.client_name || '-')}</td>
            <td>${statusBadge(p.status)}</td><td class="text-right">${p.member_count}名</td>
            <td class="text-xs">${p.default_off ? `<span class="badge badge-yellow">${p.default_off}種類 OFF</span>` : '<span class="badge badge-green">すべて ON</span>'}</td>
            <td class="text-right"><i class="fas fa-chevron-right text-gray-300"></i></td></tr>`).join('') || '<tr><td colspan="6" class="text-center text-gray-400 py-6">案件がありません</td></tr>'}</tbody></table>
      </div>
      <div class="md:hidden space-y-2">${rows.map(p => `<a href="#report-settings/${p.project_id}" class="card p-3 block">
          <div class="flex items-center justify-between gap-2"><p class="font-bold text-gray-800 truncate">${esc(p.project_name)}</p>${statusBadge(p.status)}</div>
          <p class="text-xs text-gray-500 mt-1">${esc(p.client_name || '')} ・所属 ${p.member_count}名 ・${p.default_off ? p.default_off + '種類 OFF' : 'すべて ON'}</p></a>`).join('') || '<p class="text-center text-gray-400 py-6">案件がありません</p>'}</div>`
  }
  const statusBadge = (s) => (s || 'active') === 'active' ? '<span class="badge badge-blue">稼働中</span>' : '<span class="badge badge-gray">終了</span>'
  window.rsToggleClosed = function (v) { S.includeClosed = v; renderList() }

  // ---------- 案件詳細 ----------
  async function renderDetail(id) {
    loading()
    try { current = (await axios.get(`/api/admin/report-settings/projects/${id}`)).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p><a href="#report-settings" class="text-blue-600 text-sm">← 案件一覧</a>`; return }
    const d = current, p = d.project
    $app.innerHTML = `
      <a href="#report-settings" class="text-sm text-blue-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>案件一覧</a>
      <div class="flex items-center justify-between flex-wrap gap-2 mt-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800">${esc(p.project_name)} ${statusBadge(p.status)}</h2>
          <p class="text-xs text-gray-500 mt-1">${esc(p.client_name || '')} ・所属スタッフ ${d.staff.length}名（この案件にシフトがあるスタッフ）</p></div>
        <button class="btn btn-primary text-sm" onclick="rsOpenBulk()" ${d.staff.length ? '' : 'disabled'}><i class="fas fa-layer-group"></i>一括変更</button>
      </div>

      <section class="card p-4 mb-4" id="rs-default">
        <h3 class="font-bold text-gray-800 text-sm"><i class="fas fa-sliders text-blue-600 mr-1"></i>案件の標準設定</h3>
        <p class="text-[11px] text-gray-500 mb-3">これから所属する（初めてシフトが入る）スタッフに引き継ぐ値です。今の所属スタッフの設定は変わりません</p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${TYPES.map(t => `<label class="flex items-center gap-2 p-2.5 rounded-lg border border-gray-200 cursor-pointer">
          <input type="checkbox" class="rs-def w-5 h-5" data-type="${t}" ${d.defaults[t] ? 'checked' : ''}><span class="text-sm">${LABEL[t]}</span></label>`).join('')}</div>
        <button class="btn btn-outline w-full sm:w-auto text-sm mt-3" onclick="rsSaveDefault(this)">標準設定を保存</button>
      </section>

      <section class="card p-4 mb-4" id="rs-staff">
        <h3 class="font-bold text-gray-800 text-sm"><i class="fas fa-users text-blue-600 mr-1"></i>スタッフ別の設定</h3>
        <p class="text-[11px] text-gray-500 mb-3">チェックを切り替えるとすぐ保存します。OFF の報告はスタッフの画面に表示されず、報告の順番からも外れます（登録済みの報告は消えません）</p>
        ${d.staff.length ? staffTable(d) + staffCards(d) : '<p class="text-sm text-gray-400 py-4 text-center">この案件にシフトがあるスタッフはいません</p>'}
      </section>

      <section class="card p-4" id="rs-logs">
        <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
          <h3 class="font-bold text-gray-800 text-sm"><i class="fas fa-clock-rotate-left text-blue-600 mr-1"></i>設定変更の履歴</h3>
          <div class="flex gap-2 flex-wrap">
            <select class="inp text-xs w-auto" onchange="rsLogFilter('logType', this.value)"><option value="">すべての報告</option>${TYPES.map(t => `<option value="${t}" ${S.logType === t ? 'selected' : ''}>${LABEL[t]}</option>`).join('')}</select>
            <select class="inp text-xs w-auto" onchange="rsLogFilter('logStaff', this.value)"><option value="">すべて</option><option value="default" ${S.logStaff === 'default' ? 'selected' : ''}>標準設定のみ</option>${d.staff.map(s => `<option value="${s.staff_id}" ${String(S.logStaff) === String(s.staff_id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          </div>
        </div>
        <div id="rs-log-body"><div class="flex justify-center py-6"><span class="spin"></span></div></div>
      </section>`
    loadLogs()
  }
  const sourceBadge = (s) => s.individual ? '<span class="badge badge-purple text-[10px]">個別</span>' : '<span class="badge badge-gray text-[10px]">標準</span>'
  const cell = (s, t) => `<input type="checkbox" class="w-5 h-5" ${s.settings[t] ? 'checked' : ''} onchange="rsToggleStaff(${s.staff_id}, '${t}', this)" aria-label="${esc(s.name)} ${LABEL[t]}">`
  function staffTable(d) {
    return `<div class="hidden md:block overflow-x-auto"><table class="tbl">
      <thead><tr><th>スタッフ</th><th>区分</th>${TYPES.map(t => `<th class="text-center" title="${LABEL[t]}">${SHORT[t]}</th>`).join('')}<th>設定</th><th>今後のシフト</th></tr></thead>
      <tbody>${d.staff.map(s => `<tr><td class="font-medium whitespace-nowrap"><a href="#staff/${s.staff_id}" class="text-blue-600 hover:underline">${esc(s.name)}</a></td>
        <td class="text-xs whitespace-nowrap">${esc(AFF[s.affiliation_type] || '')}</td>
        ${TYPES.map(t => `<td class="text-center">${cell(s, t)}</td>`).join('')}
        <td>${sourceBadge(s)}</td><td class="text-xs">${s.upcoming ? s.upcoming + '件' : '-'}</td></tr>`).join('')}</tbody></table></div>`
  }
  function staffCards(d) {
    return `<div class="md:hidden space-y-2">${d.staff.map(s => `<details class="rounded-lg border border-gray-200">
      <summary class="p-3 flex items-center justify-between gap-2 cursor-pointer"><span class="font-medium truncate">${esc(s.name)}</span>
        <span class="flex items-center gap-1 shrink-0">${sourceBadge(s)}<span class="text-[11px] text-gray-500">${TYPES.filter(t => s.settings[t]).length}/8 ON</span></span></summary>
      <div class="px-3 pb-3 grid grid-cols-2 gap-2">${TYPES.map(t => `<label class="flex items-center gap-2 p-2 rounded bg-gray-50 text-sm">${cell(s, t)}${LABEL[t]}</label>`).join('')}
        <p class="col-span-2 text-[11px] text-gray-400">${esc(AFF[s.affiliation_type] || '')} ・今後のシフト ${s.upcoming || 0}件</p></div></details>`).join('')}</div>`
  }

  window.rsSaveDefault = async function (btn) {
    if (busy) return
    const settings = {}
    document.querySelectorAll('.rs-def').forEach(el => { settings[el.dataset.type] = el.checked })
    const offs = TYPES.filter(t => current.defaults[t] && !settings[t])
    if (offs.length && !confirm(`標準設定で ${offs.map(t => LABEL[t]).join('・')} を OFF にします。\n今の所属スタッフ（${current.staff.length}名）の設定は変わらず、これから所属するスタッフにだけ適用されます。保存しますか？`)) return
    busy = true; btn.disabled = true
    try {
      const { data } = await axios.put(`/api/admin/report-settings/projects/${current.project.project_id}/default`, { settings })
      toast(data.changed ? '標準設定を保存しました' : '変更はありません'); renderDetail(current.project.project_id)
    } catch (e) { toast(errMsg(e)); btn.disabled = false } finally { busy = false }
  }

  window.rsToggleStaff = async function (staffId, type, el) {
    const s = current.staff.find(x => x.staff_id === staffId)
    if (busy) { el.checked = !el.checked; return }
    // OFF にするときは影響を確認する
    if (!el.checked && !confirm(`${s.name}さんの「${LABEL[type]}」を OFF にします。\n影響を受けるスタッフ: 1名${s.upcoming ? `（今後のシフト ${s.upcoming}件）` : ''}\nスタッフの画面からこの報告ボタンが消えます。登録済みの報告は消えません。保存しますか？`)) { el.checked = true; return }
    busy = true
    try {
      await axios.put(`/api/admin/report-settings/projects/${current.project.project_id}/staff/${staffId}`, { settings: { [type]: el.checked } })
      s.settings[type] = el.checked ? 1 : 0; s.individual = true
      toast(`${s.name}さんの${LABEL[type]}を${el.checked ? 'ON' : 'OFF'}にしました`)
      document.querySelectorAll(`input[onchange^="rsToggleStaff(${staffId}, '${type}'"]`).forEach(x => { x.checked = el.checked })
      loadLogs()
    } catch (e) { el.checked = !el.checked; toast(errMsg(e)) } finally { busy = false }
  }

  // ---------- 一括変更（選択 → 確認 → 保存 → 結果） ----------
  let bulk = null
  window.rsOpenBulk = function () {
    bulk = { types: [], enabled: false, staff: new Set(current.staff.map(s => s.staff_id)) }
    renderBulkSelect()
  }
  function renderBulkSelect() {
    modal(`<h3 class="font-bold text-gray-800 mb-1"><i class="fas fa-layer-group text-blue-600 mr-1"></i>一括変更</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(current.project.project_name)} ・選んだスタッフの設定を上書きします（個別に変えた値も上書きされます）</p>
      <p class="text-sm font-bold text-gray-700 mb-1">1. 変更する報告</p>
      <div class="grid grid-cols-2 gap-2 mb-3">${TYPES.map(t => `<label class="flex items-center gap-2 p-2 rounded border border-gray-200 text-sm"><input type="checkbox" class="rsb-type w-5 h-5" value="${t}" ${bulk.types.includes(t) ? 'checked' : ''}>${LABEL[t]}</label>`).join('')}</div>
      <p class="text-sm font-bold text-gray-700 mb-1">2. 変更後</p>
      <div class="flex gap-2 mb-3">
        <label class="flex-1 flex items-center justify-center gap-2 p-2.5 rounded border border-gray-200 text-sm"><input type="radio" name="rsb-on" value="1" ${bulk.enabled ? 'checked' : ''}>ON にする</label>
        <label class="flex-1 flex items-center justify-center gap-2 p-2.5 rounded border border-gray-200 text-sm"><input type="radio" name="rsb-on" value="0" ${!bulk.enabled ? 'checked' : ''}>OFF にする</label>
      </div>
      <div class="flex items-center justify-between mb-1"><p class="text-sm font-bold text-gray-700">3. 対象のスタッフ</p>
        <label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" id="rsb-all" ${bulk.staff.size === current.staff.length ? 'checked' : ''} onchange="document.querySelectorAll('.rsb-staff').forEach(x => x.checked = this.checked)">すべて選択</label></div>
      <div class="max-h-56 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100 mb-4">${current.staff.map(s => `<label class="flex items-center gap-2 p-2 text-sm"><input type="checkbox" class="rsb-staff w-5 h-5" value="${s.staff_id}" ${bulk.staff.has(s.staff_id) ? 'checked' : ''}>
        <span class="flex-1 truncate">${esc(s.name)}</span>${s.upcoming ? `<span class="text-[11px] text-gray-400">今後${s.upcoming}件</span>` : ''}</label>`).join('')}</div>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" onclick="rsBulkPreview(this)">確認する</button></div>`)
  }
  function readBulkForm() {
    bulk.types = [...document.querySelectorAll('.rsb-type:checked')].map(x => x.value)
    bulk.enabled = (document.querySelector('input[name="rsb-on"]:checked') || {}).value === '1'
    bulk.staff = new Set([...document.querySelectorAll('.rsb-staff:checked')].map(x => Number(x.value)))
  }
  const bulkBody = (extra) => ({ report_types: TYPES.filter(t => bulk.types.includes(t)), enabled: bulk.enabled, staff_ids: [...bulk.staff], ...extra })
  window.rsBulkPreview = async function (btn, keepForm) {
    if (!keepForm) readBulkForm()
    if (!bulk.types.length) { toast('変更する報告を選択してください'); return }
    if (!bulk.staff.size) { toast('対象のスタッフを選択してください'); return }
    if (btn) btn.disabled = true
    let d
    try { d = (await axios.post(`/api/admin/report-settings/projects/${current.project.project_id}/bulk`, bulkBody({ dry_run: true }))).data } catch (e) { toast(errMsg(e)); if (btn) btn.disabled = false; return }
    bulk.preview = d
    const types = d.report_types
    const mark = (v) => v ? '<span class="text-emerald-600 font-bold">ON</span>' : '<span class="text-gray-400">OFF</span>'
    modal(`<h3 class="font-bold text-gray-800 mb-1">一括変更の確認</h3>
      <p class="text-sm text-gray-700">${types.map(t => LABEL[t]).join('・')} を <b>${d.enabled ? 'ON' : 'OFF'}</b> にします</p>
      <div class="grid grid-cols-3 gap-2 my-3 text-center">
        <div class="rounded-lg bg-gray-50 p-2"><p class="text-[11px] text-gray-500">対象</p><p class="font-bold">${d.target_count}名</p></div>
        <div class="rounded-lg bg-blue-50 p-2"><p class="text-[11px] text-gray-500">変更あり</p><p class="font-bold text-blue-700">${d.changed_count}名</p></div>
        <div class="rounded-lg ${d.affected_upcoming ? 'bg-amber-50' : 'bg-gray-50'} p-2"><p class="text-[11px] text-gray-500">今後のシフトに影響</p><p class="font-bold ${d.affected_upcoming ? 'text-amber-700' : ''}">${d.affected_upcoming}名</p></div>
      </div>
      ${!d.enabled && d.affected_upcoming ? '<p class="text-xs text-amber-700 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>OFF にした報告は、今後のシフトでスタッフの画面に表示されなくなります（登録済みの報告は消えません）</p>' : ''}
      <div class="max-h-64 overflow-y-auto border border-gray-100 rounded-lg mb-4">
        <table class="tbl"><thead><tr><th>スタッフ</th>${types.map(t => `<th class="text-center">${SHORT[t]}</th>`).join('')}</tr></thead>
          <tbody>${d.rows.map(r => `<tr class="${r.changed ? '' : 'text-gray-400'}"><td class="whitespace-nowrap">${esc(r.name)}${r.changed ? '' : ' <span class="text-[10px]">（変更なし）</span>'}</td>
            ${types.map(t => `<td class="text-center text-xs whitespace-nowrap">${r.before[t] === r.after[t] ? mark(r.after[t]) : mark(r.before[t]) + ' → ' + mark(r.after[t])}</td>`).join('')}</tr>`).join('')}</tbody></table>
      </div>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" onclick="rsBackToBulk()">戻る</button>
        <button class="btn btn-primary flex-1" id="rsb-save" onclick="rsBulkSave(this)" ${d.changed_count ? '' : 'disabled'}>${d.changed_count ? d.changed_count + '名を保存する' : '変更はありません'}</button></div>`)
  }
  window.rsBackToBulk = function () { renderBulkSelect() }
  window.rsBulkSave = async function (btn) {
    if (busy) return
    busy = true; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'
    try {
      const { data } = await axios.post(`/api/admin/report-settings/projects/${current.project.project_id}/bulk`, bulkBody({ confirm_token: bulk.preview.confirm_token }))
      modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas fa-circle-check text-emerald-500 mr-1"></i>保存しました</h3>
        <p class="text-sm text-gray-700">${data.staff_changed}名の設定を変更しました（対象 ${data.target_count}名・変更した項目 ${data.cells}件）</p>
        <button class="btn btn-primary w-full mt-4" onclick="closeModal()">閉じる</button>`)
      renderDetail(current.project.project_id)
    } catch (e) {
      if (e.response && e.response.data && e.response.data.need_confirm) { toast(errMsg(e)); busy = false; return rsBulkPreview(null, true) }
      toast(errMsg(e)); btn.disabled = false; btn.textContent = '保存する'
    } finally { busy = false }
  }

  // ---------- 変更履歴 ----------
  window.rsLogFilter = function (k, v) { S[k] = v; loadLogs() }
  async function loadLogs() {
    const host = document.getElementById('rs-log-body'); if (!host || !current) return
    const params = { project_id: current.project.project_id, limit: 200 }
    if (S.logType) params.report_type = S.logType
    if (S.logStaff === 'default') params.scope = 'default'; else if (S.logStaff) params.staff_id = S.logStaff
    let d; try { d = (await axios.get('/api/admin/report-settings/logs', { params })).data } catch (e) { host.innerHTML = `<p class="text-sm text-red-600">${esc(errMsg(e))}</p>`; return }
    const onoff = (v) => v == null ? '－' : v ? 'ON' : 'OFF'
    const rows = d.logs || []
    host.innerHTML = rows.length ? `<div class="hidden md:block overflow-x-auto max-h-96"><table class="tbl"><thead><tr><th>日時</th><th>対象</th><th>報告</th><th>変更</th><th>操作</th><th>変更者</th></tr></thead>
      <tbody>${rows.map(l => `<tr><td class="text-xs whitespace-nowrap">${esc(dayjs(l.created_at).format('YYYY/M/D HH:mm'))}</td>
        <td class="text-xs">${l.staff_id ? esc(l.staff_name || 'ID ' + l.staff_id) : '<span class="badge badge-blue text-[10px]">標準設定</span>'}</td>
        <td class="text-xs">${LABEL[l.report_type] || esc(l.report_type)}</td><td class="text-xs whitespace-nowrap">${onoff(l.old_enabled)} → <b>${onoff(l.new_enabled)}</b></td>
        <td class="text-xs">${ACTION[l.action] || esc(l.action)}</td><td class="text-xs">${esc(l.changed_by_name || (l.action === 'migration' ? 'システム' : ''))}</td></tr>`).join('')}</tbody></table></div>
      <div class="md:hidden space-y-1.5 max-h-96 overflow-y-auto">${rows.map(l => `<div class="text-xs bg-gray-50 rounded p-2">
        <p><b>${l.staff_id ? esc(l.staff_name || '') : '標準設定'}</b> ・${LABEL[l.report_type] || esc(l.report_type)} ${onoff(l.old_enabled)} → <b>${onoff(l.new_enabled)}</b></p>
        <p class="text-gray-500">${esc(dayjs(l.created_at).format('YYYY/M/D HH:mm'))} ・${ACTION[l.action] || esc(l.action)} ・${esc(l.changed_by_name || (l.action === 'migration' ? 'システム' : ''))}</p></div>`).join('')}</div>`
      : '<p class="text-sm text-gray-400 py-4 text-center">履歴はありません</p>'
  }
})()
