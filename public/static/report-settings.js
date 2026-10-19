// =========================================================
// 案件報告管理（勤怠報告 8 種類の ON/OFF・一括変更・変更履歴）管理画面
// docs/spec_attendance_correction.md 2章・3章。admin.js の後に読み込む
//   #report-settings            案件一覧
//   #report-settings/:projectId 案件詳細（標準設定・スタッフ別・一括変更・履歴）
//   #report-settings/off        案件をまたいだ OFF の設定一覧とシフト単位の例外（#446 #313）
//   #report-settings/staff/:id  スタッフ 1 人の全案件の設定（#413）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const SHORT = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '開始', break_start: '休入', break_end: '休出', work_end: '終了', check_out: '退店' }
  const ACTION = { project_default: '標準設定', default_apply: '標準設定の適用', individual: '個別変更', bulk: '一括変更', staff_reset: '標準に戻す', shift_override: 'シフト単位の例外', migration: '導入時の移行', merge: 'スタッフ統合' }
  const AFF = { own_employee: '自社雇用', daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属', linked_external: '他社連携', skillsheet_only: 'スキルシートのみ' }
  const STATUS = { leave: ['休職', 'badge-yellow'], retired: ['退職', 'badge-gray'], merged: ['統合済み', 'badge-gray'], ended: ['取引終了', 'badge-gray'] }
  const SOURCE = { individual: '個別変更', bulk: '一括変更', default: '標準設定から引き継ぎ', migration: '導入時の移行' }
  const EXC = { none: '勤怠報告なし', in_out: '入店・退店のみ' }
  const INACTIVE = ['retired', 'merged', 'ended']
  const S = window.__rsState = window.__rsState || { includeClosed: false, logType: '', logStaff: '', logProject: null, showAll: false, q: '', off: { project_id: '', report_type: '', include_closed: '', include_inactive: '', include_default: '' } }
  let current = null   // 表示中の案件詳細
  let staffPage = null // 表示中のスタッフの全案件の設定
  let busy = false

  window.renderReportSettings = function (id) {
    const parts = (location.hash || '').slice(1).split('/')
    if (id === 'off') return renderOffList()
    if (id === 'staff') return /^\d+$/.test(parts[2] || '') ? renderStaffPage(Number(parts[2])) : renderList()
    return id && /^\d+$/.test(String(id)) ? renderDetail(Number(id)) : renderList()
  }
  const onStaffPage = () => (location.hash || '').startsWith('#report-settings/staff/')
  // change・input は delegate（click のみ）で受けられないため、data-rs-change / data-rs-input で受ける
  const ON_CHANGE = {}, ON_INPUT = {}
  document.addEventListener('change', (ev) => { const el = ev.target && ev.target.closest ? ev.target.closest('[data-rs-change]') : null; if (el && ON_CHANGE[el.dataset.rsChange]) ON_CHANGE[el.dataset.rsChange](el, ev) })
  document.addEventListener('input', (ev) => { const el = ev.target && ev.target.closest ? ev.target.closest('[data-rs-input]') : null; if (el && ON_INPUT[el.dataset.rsInput]) ON_INPUT[el.dataset.rsInput](el, ev) })

  const statusBadge = (s) => (s || 'active') === 'active' ? '<span class="badge badge-blue">稼働中</span>' : '<span class="badge badge-gray">終了</span>'
  const memberBadge = (st) => STATUS[st] ? `<span class="badge ${STATUS[st][1]} text-[10px]">${STATUS[st][0]}</span>` : ''
  // 設定の種類（#268）: 個別 / 個別（旧設定）/ 標準（引き継ぎ）/ 標準
  const kindBadge = (s) => s.kind === 'individual' ? '<span class="badge badge-purple text-[10px]">個別</span>'
    : s.kind === 'legacy' ? '<span class="badge badge-purple text-[10px]" title="0027 より前のスタッフ単位の提出設定">個別（旧設定）</span>'
      : s.kind === 'inherited' ? '<span class="badge badge-gray text-[10px]" title="標準設定を変える前の値で固定しています">標準（引き継ぎ）</span>'
        : '<span class="badge badge-gray text-[10px]">標準</span>'
  const tabs = (active) => `<div class="flex gap-2 mb-4">
      <a href="#report-settings" class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${active === 'list' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}">案件ごとの設定</a>
      <a href="#report-settings/off" class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${active === 'off' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}">OFF の設定一覧</a></div>`

  // ---------- 案件一覧 ----------
  async function renderList() {
    loading()
    let data
    try { data = (await axios.get('/api/admin/report-settings/projects', { params: S.includeClosed ? { include_closed: 1 } : {} })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const rows = data.projects || []
    const offLabel = (p) => p.default_off ? `<span class="badge badge-yellow">${Number(p.default_off)}種類 OFF</span>` : '<span class="badge badge-green">すべて ON</span>'
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-list-check text-blue-600 mr-1"></i>案件報告管理</h2>
          <p class="text-xs text-gray-500 mt-1">案件ごと・スタッフごとに、勤怠報告 8 種類（起床〜退店）の ON/OFF を設定します。案件を選んでください</p></div>
        <label class="flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" ${S.includeClosed ? 'checked' : ''} data-rs-change="toggleClosed">終了した案件も表示</label>
      </div>
      ${tabs('list')}
      <div class="hidden md:block card overflow-x-auto">
        <table class="tbl"><thead><tr><th>案件</th><th>クライアント</th><th>状態</th><th class="text-right">所属スタッフ</th><th>標準設定</th><th class="text-right">個別設定</th><th class="text-right">OFF のある人</th><th></th></tr></thead>
          <tbody>${rows.map(p => `<tr class="cursor-pointer" data-action="rsOpenProject" data-id="${Number(p.project_id)}">
            <td class="font-medium text-blue-700">${esc(p.project_name)}</td><td class="text-xs">${esc(p.client_name || '-')}</td>
            <td>${statusBadge(p.status)}</td><td class="text-right">${Number(p.member_count)}名</td>
            <td class="text-xs">${offLabel(p)}</td>
            <td class="text-right text-xs">${p.custom_count ? `<span class="badge badge-purple">${Number(p.custom_count)}名</span>` : '-'}</td>
            <td class="text-right text-xs">${p.off_staff_count ? `<span class="badge badge-yellow">${Number(p.off_staff_count)}名</span>` : '-'}</td>
            <td class="text-right"><i class="fas fa-chevron-right text-gray-300"></i></td></tr>`).join('') || '<tr><td colspan="8" class="text-center text-gray-400 py-6">案件がありません</td></tr>'}</tbody></table>
      </div>
      <div class="md:hidden space-y-2">${rows.map(p => `<a href="#report-settings/${Number(p.project_id)}" class="card p-3 block">
          <div class="flex items-center justify-between gap-2"><p class="font-bold text-gray-800 truncate">${esc(p.project_name)}</p>${statusBadge(p.status)}</div>
          <p class="text-xs text-gray-500 mt-1">${esc(p.client_name || '')} ・所属 ${Number(p.member_count)}名 ・${p.default_off ? Number(p.default_off) + '種類 OFF' : 'すべて ON'}${p.custom_count ? ` ・個別 ${Number(p.custom_count)}名` : ''}${p.off_staff_count ? ` ・OFF のある人 ${Number(p.off_staff_count)}名` : ''}</p></a>`).join('') || '<p class="text-center text-gray-400 py-6">案件がありません</p>'}</div>
      <p class="text-[11px] text-gray-400 mt-2">個別設定 = 個別変更・一括変更をしたスタッフの人数。OFF のある人 = 在籍中の所属スタッフのうち、OFF の報告がある人数（案件の標準設定どおりの OFF を含む）</p>`
  }
  ON_CHANGE.toggleClosed = (el) => { S.includeClosed = el.checked; renderList() }
  delegate('rsOpenProject', (el) => { location.hash = 'report-settings/' + Number(el.dataset.id) })

  // ---------- 案件詳細 ----------
  // 既定では、在籍中の人と今後のシフトがある人を表示する（#379）
  const isVisible = (s) => S.showAll || s.member_status === 'active' || s.upcoming > 0
  const matchQ = (s) => !S.q || String(s.name || '').includes(S.q)
  async function renderDetail(id) {
    loading()
    try { current = (await axios.get(`/api/admin/report-settings/projects/${id}`)).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p><a href="#report-settings" class="text-blue-600 text-sm">← 案件一覧</a>`; return }
    const d = current, p = d.project
    // 履歴の絞り込みは案件ごと。案件が変わったら、または選んだスタッフがこの案件にいなければ戻す（#267）
    if (S.logProject !== p.project_id) { S.logStaff = ''; S.logProject = p.project_id; S.q = '' }
    if (S.logStaff && S.logStaff !== 'default' && !d.staff.some(s => String(s.staff_id) === String(S.logStaff))) S.logStaff = ''
    const hidden = d.staff.filter(s => !isVisible(s)).length
    $app.innerHTML = `
      <a href="#report-settings" class="text-sm text-blue-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>案件一覧</a>
      <div class="flex items-center justify-between flex-wrap gap-2 mt-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800">${esc(p.project_name)} ${statusBadge(p.status)}</h2>
          <p class="text-xs text-gray-500 mt-1">${esc(p.client_name || '')} ・所属スタッフ ${d.staff.length}名（この案件にシフトがあるスタッフ）</p></div>
        <div class="flex gap-2">
          <a class="btn btn-outline text-sm" href="#report-settings/off" data-action="rsOffForProject" data-id="${Number(p.project_id)}"><i class="fas fa-filter"></i>OFF の一覧</a>
          <button class="btn btn-primary text-sm" data-action="rsOpenBulk" ${d.staff.some(s => !INACTIVE.includes(s.member_status)) ? '' : 'disabled'}><i class="fas fa-layer-group"></i>一括変更</button>
        </div>
      </div>

      <section class="card p-4 mb-4" id="rs-default">
        <h3 class="font-bold text-gray-800 text-sm"><i class="fas fa-sliders text-blue-600 mr-1"></i>案件の標準設定</h3>
        <p class="text-[11px] text-gray-500 mb-3">これから所属する（初めてシフトが入る）スタッフに引き継ぐ値です。保存するときに、今の所属スタッフにも当てるかを選べます</p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${TYPES.map(t => `<label class="flex items-center gap-2 p-2.5 rounded-lg border border-gray-200 cursor-pointer">
          <input type="checkbox" class="rs-def w-5 h-5" data-type="${t}" ${d.defaults[t] ? 'checked' : ''}><span class="text-sm">${LABEL[t]}</span></label>`).join('')}</div>
        <button class="btn btn-outline w-full sm:w-auto text-sm mt-3" data-action="rsSaveDefault">標準設定を保存</button>
      </section>

      <section class="card p-4 mb-4" id="rs-staff">
        <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h3 class="font-bold text-gray-800 text-sm"><i class="fas fa-users text-blue-600 mr-1"></i>スタッフ別の設定</h3>
          <div class="flex items-center gap-2 flex-wrap">
            <input class="inp text-xs w-40" placeholder="氏名で探す" value="${esc(S.q)}" data-rs-input="staffQ">
            <label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" ${S.showAll ? 'checked' : ''} data-rs-change="showAll">退職・休職の人も表示${hidden ? `（${hidden}名）` : ''}</label>
          </div>
        </div>
        <p class="text-[11px] text-gray-500 mb-3">チェックを切り替えるとすぐ保存します。OFF の報告はスタッフの画面に表示されず、報告の順番からも外れます（登録済みの報告は消えません）。
          色の付いたマスは案件の標準設定と違う値です。既定では、在籍中の人と今後のシフトがある人を表示します</p>
        <div id="rs-staff-body">${staffBody(d)}</div>
      </section>

      <section class="card p-4" id="rs-logs">
        <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
          <h3 class="font-bold text-gray-800 text-sm"><i class="fas fa-clock-rotate-left text-blue-600 mr-1"></i>設定変更の履歴</h3>
          <div class="flex gap-2 flex-wrap">
            <select class="inp text-xs w-auto" data-rs-change="logType"><option value="">すべての報告</option>${TYPES.map(t => `<option value="${t}" ${S.logType === t ? 'selected' : ''}>${LABEL[t]}</option>`).join('')}</select>
            <select class="inp text-xs w-auto" data-rs-change="logStaff"><option value="">すべて</option><option value="default" ${S.logStaff === 'default' ? 'selected' : ''}>標準設定のみ</option>${d.staff.map(s => `<option value="${Number(s.staff_id)}" ${String(S.logStaff) === String(s.staff_id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          </div>
        </div>
        <div id="rs-log-body"><div class="flex justify-center py-6"><span class="spin"></span></div></div>
      </section>`
    loadLogs()
  }
  function staffBody(d) {
    if (!d.staff.length) return '<p class="text-sm text-gray-400 py-4 text-center">この案件にシフトがあるスタッフはいません</p>'
    const list = d.staff.filter(s => isVisible(s) && matchQ(s))
    if (!list.length) return '<p class="text-sm text-gray-400 py-4 text-center">条件に合うスタッフはいません</p>'
    return staffTable(d, list) + staffCards(d, list)
  }
  const redrawStaff = () => { const host = document.getElementById('rs-staff-body'); if (host && current) host.innerHTML = staffBody(current) }
  ON_INPUT.staffQ = (el) => { S.q = el.value.trim(); redrawStaff() }
  ON_CHANGE.showAll = (el) => { S.showAll = el.checked; redrawStaff() }
  ON_CHANGE.logType = (el) => { S.logType = el.value; loadLogs() }
  ON_CHANGE.logStaff = (el) => { S.logStaff = el.value; loadLogs() }
  delegate('rsOffForProject', (el, ev) => { ev.preventDefault(); S.off = { ...S.off, project_id: String(Number(el.dataset.id)) }; location.hash = 'report-settings/off' })

  // 案件の標準設定と違う値のマスは色を付ける（#268）
  const diffCls = (s, t, defaults) => s.settings[t] !== defaults[t] ? 'bg-amber-50' : ''
  const cell = (s, t, pid) => `<input type="checkbox" class="w-5 h-5" ${s.settings[t] ? 'checked' : ''} data-action="rsToggleStaff" data-project="${Number(pid)}" data-staff="${Number(s.staff_id)}" data-type="${t}" aria-label="${esc(s.name)} ${LABEL[t]}">`
  const excBtn = (s, pid) => s.upcoming_exceptions ? `<button class="badge badge-yellow text-[10px]" data-action="rsShowExceptions" data-project="${Number(pid)}" data-staff="${Number(s.staff_id)}" title="今後のシフトのうち、シフト単位の例外（勤怠報告なし・入店・退店のみ）があるもの">例外 ${Number(s.upcoming_exceptions)}件</button>` : ''
  const resetBtn = (s, pid) => s.kind !== 'none' ? `<button class="text-[11px] text-blue-600 hover:underline ml-1" data-action="rsResetStaff" data-project="${Number(pid)}" data-staff="${Number(s.staff_id)}" data-name="${esc(s.name)}">標準に戻す</button>` : ''
  function staffTable(d, list) {
    const pid = d.project.project_id
    return `<div class="hidden md:block overflow-x-auto"><table class="tbl">
      <thead><tr><th>スタッフ</th><th>区分</th>${TYPES.map(t => `<th class="text-center" title="${LABEL[t]}">${SHORT[t]}</th>`).join('')}<th>設定</th><th>今後のシフト</th></tr></thead>
      <tbody>${list.map(s => `<tr><td class="font-medium whitespace-nowrap"><a href="#report-settings/staff/${Number(s.staff_id)}" class="text-blue-600 hover:underline" title="このスタッフの全案件の設定">${esc(s.name)}</a> ${memberBadge(s.member_status)}</td>
        <td class="text-xs whitespace-nowrap">${esc(AFF[s.affiliation_type] || '')}</td>
        ${TYPES.map(t => `<td class="text-center ${diffCls(s, t, d.defaults)}">${cell(s, t, pid)}</td>`).join('')}
        <td class="whitespace-nowrap">${kindBadge(s)}${resetBtn(s, pid)}</td><td class="text-xs whitespace-nowrap">${s.upcoming ? Number(s.upcoming) + '件' : '-'} ${excBtn(s, pid)}</td></tr>`).join('')}</tbody></table></div>`
  }
  function staffCards(d, list) {
    const pid = d.project.project_id
    return `<div class="md:hidden space-y-2">${list.map(s => `<details class="rounded-lg border border-gray-200">
      <summary class="p-3 flex items-center justify-between gap-2 cursor-pointer"><span class="font-medium truncate">${esc(s.name)} ${memberBadge(s.member_status)}</span>
        <span class="flex items-center gap-1 shrink-0">${kindBadge(s)}<span class="text-[11px] text-gray-500">${TYPES.filter(t => s.settings[t]).length}/8 ON</span></span></summary>
      <div class="px-3 pb-3 grid grid-cols-2 gap-2">${TYPES.map(t => `<label class="flex items-center gap-2 p-2 rounded bg-gray-50 text-sm ${diffCls(s, t, d.defaults)}">${cell(s, t, pid)}${LABEL[t]}</label>`).join('')}
        <p class="col-span-2 text-[11px] text-gray-400">${esc(AFF[s.affiliation_type] || '')} ・今後のシフト ${Number(s.upcoming || 0)}件 ${excBtn(s, pid)}${resetBtn(s, pid)}
          <a class="text-blue-600 ml-1" href="#report-settings/staff/${Number(s.staff_id)}">全案件の設定</a></p></div></details>`).join('')}</div>`
  }

  // 標準設定の保存。変えた項目だけを送り、画面を開いた時点の版番号を付ける（#509）。今の所属スタッフに当てる範囲を選ぶ（#329）
  let pendingDefault = null
  delegate('rsSaveDefault', () => {
    const settings = {}
    document.querySelectorAll('.rs-def').forEach(el => { const t = el.dataset.type; if ((el.checked ? 1 : 0) !== current.defaults[t]) settings[t] = el.checked })
    const changed = Object.keys(settings)
    if (!changed.length) { toast('変更はありません'); return }
    const active = current.staff.filter(s => !INACTIVE.includes(s.member_status))
    const std = active.filter(s => s.kind === 'none' || s.kind === 'inherited')
    // 当てたときに値が変わり、今後のシフトがある人（影響を受ける人数）
    const affected = (list) => list.filter(s => s.upcoming > 0 && changed.some(t => s.settings[t] !== (settings[t] ? 1 : 0))).length
    const ons = changed.filter(t => settings[t]), offs = changed.filter(t => !settings[t])
    pendingDefault = settings
    modal(`<h3 class="font-bold text-gray-800 mb-2">標準設定の保存</h3>
      <div class="text-sm text-gray-700 space-y-1 mb-3">
        ${ons.length ? `<p>ON にする: <b>${ons.map(t => LABEL[t]).join('・')}</b></p>` : ''}
        ${offs.length ? `<p>OFF にする: <b class="text-amber-700">${offs.map(t => LABEL[t]).join('・')}</b></p>` : ''}
      </div>
      <p class="text-sm font-bold text-gray-700 mb-1">今の所属スタッフへの適用</p>
      <div class="space-y-1.5 mb-3 text-sm">
        <label class="flex items-start gap-2 p-2 rounded border border-gray-200"><input type="radio" name="rs-apply" value="none" checked class="mt-1"><span>これから所属するスタッフにだけ適用する<span class="block text-[11px] text-gray-500">今の所属スタッフ（${current.staff.length}名）の設定は変わりません</span></span></label>
        <label class="flex items-start gap-2 p-2 rounded border border-gray-200"><input type="radio" name="rs-apply" value="standard" class="mt-1"><span>個別に変えていない在籍中のスタッフにも適用する（${std.length}名）<span class="block text-[11px] text-gray-500">今後のシフトに影響 ${affected(std)}名。個別設定の人・退職者などは今の値のまま</span></span></label>
        <label class="flex items-start gap-2 p-2 rounded border border-gray-200"><input type="radio" name="rs-apply" value="all" class="mt-1"><span>在籍中のスタッフ全員に適用する（${active.length}名。個別設定 ${active.length - std.length}名を含む）<span class="block text-[11px] text-gray-500">今後のシフトに影響 ${affected(active)}名。個別設定の人は、変えた報告だけを上書きします</span></span></label>
      </div>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" data-action="rsSaveDefaultGo">保存する</button></div>`)
  })
  delegate('rsSaveDefaultGo', (btn) => withSubmitLock(btn, async () => {
    const apply = (document.querySelector('input[name="rs-apply"]:checked') || {}).value || 'none'
    const pid = current.project.project_id
    try {
      const { data } = await axios.put(`/api/admin/report-settings/projects/${pid}/default`, { settings: pendingDefault, version: current.defaults_version, apply })
      closeModal()
      toast(!data.changed ? '変更はありません' : data.applied_staff ? `標準設定を保存し、${data.applied_staff}名に適用しました` : '標準設定を保存しました')
      renderDetail(pid)
    } catch (e) {
      toast(errMsg(e))
      // ほかの人が先に変えていたら、最新の値で表示し直す
      if (e.response && e.response.status === 409) { closeModal(); renderDetail(pid) }
    }
  }))

  // スタッフ別の切り替え（案件詳細とスタッフの全案件の画面で共用）
  function toggleTarget(pid, staffId) {
    if (onStaffPage()) {
      const p = staffPage && staffPage.staff.staff_id === staffId ? staffPage.projects.find(x => x.project_id === pid) : null
      return p ? { name: staffPage.staff.name, upcoming: p.upcoming, row: p } : null
    }
    const s = current && current.project.project_id === pid ? current.staff.find(x => x.staff_id === staffId) : null
    return s ? { name: s.name, upcoming: s.upcoming, row: s } : null
  }
  delegate('rsToggleStaff', async (el) => {
    const pid = Number(el.dataset.project), staffId = Number(el.dataset.staff), type = el.dataset.type
    const s = toggleTarget(pid, staffId)
    if (!s) return
    if (busy) { el.checked = !el.checked; return }
    // OFF にするときは影響を確認する
    if (!el.checked && !confirm(`${s.name}さんの「${LABEL[type]}」を OFF にします。\n影響を受けるスタッフ: 1名${s.upcoming ? `（今後のシフト ${s.upcoming}件）` : ''}\nスタッフの画面からこの報告ボタンが消えます。登録済みの報告は消えません。保存しますか？`)) { el.checked = true; return }
    busy = true
    try {
      await axios.put(`/api/admin/report-settings/projects/${pid}/staff/${staffId}`, { settings: { [type]: el.checked } })
      s.row.settings[type] = el.checked ? 1 : 0; s.row.kind = 'individual'
      toast(`${s.name}さんの${LABEL[type]}を${el.checked ? 'ON' : 'OFF'}にしました`)
      if (onStaffPage()) { busy = false; return renderStaffPage(staffId) }
      redrawStaff(); loadLogs()
    } catch (e) { el.checked = !el.checked; toast(errMsg(e)) } finally { busy = false }
  })

  // 標準に戻す（案件 × スタッフ別の行を消す。#413）
  delegate('rsResetStaff', (el) => withSubmitLock(el, async () => {
    const pid = Number(el.dataset.project), staffId = Number(el.dataset.staff)
    if (!confirm(`${el.dataset.name}さんのこの案件の設定を、案件の標準設定に戻しますか？\n個別に変えた値はなくなり、これからは標準設定の変更に従います`)) return
    try {
      await axios.post(`/api/admin/report-settings/staff/${staffId}/reset`, { project_ids: [pid] })
      toast('標準設定に戻しました')
      if (onStaffPage()) renderStaffPage(staffId); else renderDetail(pid)
    } catch (e) { toast(errMsg(e)) }
  }))

  // シフト単位の例外のあるシフト（#313）。行からシフトの報告設定を開ける
  delegate('rsShowExceptions', async (el) => {
    const params = {}
    if (el.dataset.project) params.project_id = Number(el.dataset.project)
    if (el.dataset.staff) params.staff_id = Number(el.dataset.staff)
    let d; try { d = (await axios.get('/api/admin/report-settings/exceptions', { params })).data } catch (e) { toast(errMsg(e)); return }
    modal(`<h3 class="font-bold text-gray-800 mb-1">シフト単位の例外（今日以降）</h3>
      <p class="text-xs text-gray-500 mb-3">シフトごとの設定は、案件・スタッフ別の設定より優先します。シフトを選ぶと、そのシフトの設定を変えられます</p>
      ${exceptionList(d.exceptions)}
      <button class="btn btn-outline w-full mt-3" onclick="closeModal()">閉じる</button>`)
  })
  const fmtDate = (d) => d ? dayjs(d).format('M/D(dd)') : ''
  function exceptionList(rows) {
    return rows.length ? `<div class="divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-80 overflow-y-auto">${rows.map(r => `<button class="w-full text-left p-2 text-sm hover:bg-gray-50 flex items-center gap-2" data-action="rsOpenShift" data-id="${Number(r.shift_id)}" data-title="${esc(r.staff_name || '')}" data-sub="${esc(fmtDate(r.work_date) + ' ' + (r.start_time || '') + '〜' + (r.end_time || '') + '・' + (r.project_name || ''))}">
        <span class="whitespace-nowrap text-xs text-gray-500">${esc(fmtDate(r.work_date))} ${esc(r.start_time || '')}〜${esc(r.end_time || '')}</span>
        <span class="flex-1 truncate">${esc(r.staff_name || '')} <span class="text-xs text-gray-400">${esc(r.project_name || '')}</span></span>
        <span class="badge badge-yellow text-[10px]">${esc(EXC[r.attendance_mode] || r.attendance_mode)}</span></button>`).join('')}</div>`
      : '<p class="text-sm text-gray-400 py-4 text-center">例外のあるシフトはありません</p>'
  }
  delegate('rsOpenShift', (el) => {
    modal(`<h3 class="font-bold text-lg mb-1">${esc(el.dataset.title || '')}</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(el.dataset.sub || '')}</p>
      <div id="shift-report-panel" class="mb-3"><p class="text-xs text-gray-400">読み込み中…</p></div>
      <button type="button" class="btn btn-outline w-full text-xs" data-action="rsCloseShift">閉じて更新</button>`)
    if (window.renderShiftReportPanel) renderShiftReportPanel(Number(el.dataset.id))
  })
  delegate('rsCloseShift', () => { closeModal(); window.renderReportSettings((location.hash || '').slice(1).split('/')[1]) })

  // ---------- 一括変更（選択 → 確認 → 保存 → 結果） ----------
  // 対象は在籍中・休職中の所属スタッフ（退職・統合済み・取引終了は選べない）。初期選択は在籍中の人（#247 #379）
  let bulk = null
  const bulkCandidates = () => current.staff.filter(s => !INACTIVE.includes(s.member_status))
  delegate('rsOpenBulk', () => {
    bulk = { types: [], enabled: false, staff: new Set(bulkCandidates().filter(s => s.member_status === 'active').map(s => s.staff_id)) }
    renderBulkSelect()
  })
  function renderBulkSelect() {
    const list = bulkCandidates()
    modal(`<h3 class="font-bold text-gray-800 mb-1"><i class="fas fa-layer-group text-blue-600 mr-1"></i>一括変更</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(current.project.project_name)} ・選んだスタッフの設定を上書きします（個別に変えた値も上書きされます）</p>
      <p class="text-sm font-bold text-gray-700 mb-1">1. 変更する報告</p>
      <div class="grid grid-cols-2 gap-2 mb-3">${TYPES.map(t => `<label class="flex items-center gap-2 p-2 rounded border border-gray-200 text-sm"><input type="checkbox" class="rsb-type w-5 h-5" value="${t}" ${bulk.types.includes(t) ? 'checked' : ''}>${LABEL[t]}</label>`).join('')}</div>
      <p class="text-sm font-bold text-gray-700 mb-1">2. 変更後</p>
      <div class="flex gap-2 mb-3">
        <label class="flex-1 flex items-center justify-center gap-2 p-2.5 rounded border border-gray-200 text-sm"><input type="radio" name="rsb-on" value="1" ${bulk.enabled ? 'checked' : ''}>ON にする</label>
        <label class="flex-1 flex items-center justify-center gap-2 p-2.5 rounded border border-gray-200 text-sm"><input type="radio" name="rsb-on" value="0" ${!bulk.enabled ? 'checked' : ''}>OFF にする</label>
      </div>
      <div class="flex items-center justify-between flex-wrap gap-1 mb-1"><p class="text-sm font-bold text-gray-700">3. 対象のスタッフ</p>
        <span class="flex gap-2 text-xs">
          <button class="text-blue-600 hover:underline" data-action="rsBulkSelect" data-mode="active">在籍中の人</button>
          <button class="text-blue-600 hover:underline" data-action="rsBulkSelect" data-mode="upcoming">今後のシフトがある人</button>
          <button class="text-blue-600 hover:underline" data-action="rsBulkSelect" data-mode="all">全員</button>
          <button class="text-gray-500 hover:underline" data-action="rsBulkSelect" data-mode="none">選択を外す</button></span></div>
      <div class="max-h-56 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100 mb-1">${list.map(s => `<label class="flex items-center gap-2 p-2 text-sm"><input type="checkbox" class="rsb-staff w-5 h-5" value="${Number(s.staff_id)}" data-status="${esc(s.member_status)}" data-upcoming="${Number(s.upcoming || 0)}" ${bulk.staff.has(s.staff_id) ? 'checked' : ''}>
        <span class="flex-1 truncate">${esc(s.name)} ${memberBadge(s.member_status)}</span>${s.upcoming ? `<span class="text-[11px] text-gray-400">今後${Number(s.upcoming)}件</span>` : ''}</label>`).join('') || '<p class="text-xs text-gray-400 p-3 text-center">対象にできるスタッフはいません</p>'}</div>
      <p class="text-[11px] text-gray-400 mb-4">退職・統合済み・取引終了のスタッフは対象にできません</p>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" data-action="rsBulkPreview">確認する</button></div>`)
  }
  delegate('rsBulkSelect', (el) => {
    const m = el.dataset.mode
    document.querySelectorAll('.rsb-staff').forEach(x => { x.checked = m === 'all' || (m === 'active' && x.dataset.status === 'active') || (m === 'upcoming' && Number(x.dataset.upcoming) > 0) })
  })
  function readBulkForm() {
    bulk.types = [...document.querySelectorAll('.rsb-type:checked')].map(x => x.value)
    bulk.enabled = (document.querySelector('input[name="rsb-on"]:checked') || {}).value === '1'
    bulk.staff = new Set([...document.querySelectorAll('.rsb-staff:checked')].map(x => Number(x.value)))
  }
  const bulkBody = (extra) => ({ report_types: TYPES.filter(t => bulk.types.includes(t)), enabled: bulk.enabled, staff_ids: [...bulk.staff], ...extra })
  delegate('rsBulkPreview', (btn) => bulkPreview(btn, false))
  async function bulkPreview(btn, keepForm) {
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
        <div class="rounded-lg bg-gray-50 p-2"><p class="text-[11px] text-gray-500">対象</p><p class="font-bold">${Number(d.target_count)}名</p></div>
        <div class="rounded-lg bg-blue-50 p-2"><p class="text-[11px] text-gray-500">変更あり</p><p class="font-bold text-blue-700">${Number(d.changed_count)}名</p></div>
        <div class="rounded-lg ${d.affected_upcoming ? 'bg-amber-50' : 'bg-gray-50'} p-2"><p class="text-[11px] text-gray-500">今後のシフトに影響</p><p class="font-bold ${d.affected_upcoming ? 'text-amber-700' : ''}">${Number(d.affected_upcoming)}名</p></div>
      </div>
      ${!d.enabled && d.affected_upcoming ? '<p class="text-xs text-amber-700 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>OFF にした報告は、今後のシフトでスタッフの画面に表示されなくなります（登録済みの報告は消えません）</p>' : ''}
      <div class="max-h-64 overflow-y-auto border border-gray-100 rounded-lg mb-4">
        <table class="tbl"><thead><tr><th>スタッフ</th>${types.map(t => `<th class="text-center">${SHORT[t]}</th>`).join('')}</tr></thead>
          <tbody>${d.rows.map(r => `<tr class="${r.changed ? '' : 'text-gray-400'}"><td class="whitespace-nowrap">${esc(r.name)}${r.changed ? '' : ' <span class="text-[10px]">（変更なし）</span>'}</td>
            ${types.map(t => `<td class="text-center text-xs whitespace-nowrap">${r.before[t] === r.after[t] ? mark(r.after[t]) : mark(r.before[t]) + ' → ' + mark(r.after[t])}</td>`).join('')}</tr>`).join('')}</tbody></table>
      </div>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" data-action="rsBackToBulk">戻る</button>
        <button class="btn btn-primary flex-1" id="rsb-save" data-action="rsBulkSave" ${d.changed_count ? '' : 'disabled'}>${d.changed_count ? Number(d.changed_count) + '名を保存する' : '変更はありません'}</button></div>`)
  }
  delegate('rsBackToBulk', () => renderBulkSelect())
  delegate('rsBulkSave', async (btn) => {
    if (busy) return
    busy = true; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'
    try {
      const { data } = await axios.post(`/api/admin/report-settings/projects/${current.project.project_id}/bulk`, bulkBody({ confirm_token: bulk.preview.confirm_token }))
      modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas fa-circle-check text-emerald-500 mr-1"></i>保存しました</h3>
        <p class="text-sm text-gray-700">${Number(data.staff_changed)}名の設定を変更しました（対象 ${Number(data.target_count)}名・変更した項目 ${Number(data.cells)}件）</p>
        <button class="btn btn-primary w-full mt-4" onclick="closeModal()">閉じる</button>`)
      renderDetail(current.project.project_id)
    } catch (e) {
      if (e.response && e.response.data && e.response.data.need_confirm) { toast(errMsg(e)); busy = false; return bulkPreview(null, true) }
      toast(errMsg(e)); btn.disabled = false; btn.textContent = '保存する'
    } finally { busy = false }
  })

  // ---------- 変更履歴 ----------
  const onoff = (v) => v == null ? '－' : v ? 'ON' : 'OFF'
  const who = (l) => l.changed_by_name || (l.action === 'migration' ? 'システム' : '')
  function logRowsHtml(rows, showProject) {
    return rows.length ? `<div class="hidden md:block overflow-x-auto max-h-96"><table class="tbl"><thead><tr><th>日時</th>${showProject ? '<th>案件</th>' : ''}<th>対象</th><th>報告</th><th>変更</th><th>操作</th><th>変更者</th></tr></thead>
      <tbody>${rows.map(l => `<tr><td class="text-xs whitespace-nowrap">${esc(dayjs(l.created_at).format('YYYY/M/D HH:mm'))}</td>
        ${showProject ? `<td class="text-xs">${esc(l.project_name || '')}</td>` : ''}
        <td class="text-xs">${l.staff_id ? esc(l.staff_name || 'ID ' + l.staff_id) : '<span class="badge badge-blue text-[10px]">標準設定</span>'}</td>
        <td class="text-xs">${LABEL[l.report_type] || esc(l.report_type)}</td><td class="text-xs whitespace-nowrap">${onoff(l.old_enabled)} → <b>${onoff(l.new_enabled)}</b></td>
        <td class="text-xs">${ACTION[l.action] || esc(l.action)}${l.detail ? `<span class="block text-[11px] text-gray-500">${esc(l.detail)}</span>` : ''}</td><td class="text-xs">${esc(who(l))}</td></tr>`).join('')}</tbody></table></div>
      <div class="md:hidden space-y-1.5 max-h-96 overflow-y-auto">${rows.map(l => `<div class="text-xs bg-gray-50 rounded p-2">
        <p><b>${l.staff_id ? esc(l.staff_name || '') : '標準設定'}</b> ・${LABEL[l.report_type] || esc(l.report_type)} ${onoff(l.old_enabled)} → <b>${onoff(l.new_enabled)}</b></p>
        <p class="text-gray-500">${esc(dayjs(l.created_at).format('YYYY/M/D HH:mm'))} ・${showProject ? esc(l.project_name || '') + ' ・' : ''}${ACTION[l.action] || esc(l.action)} ・${esc(who(l))}</p>
        ${l.detail ? `<p class="text-gray-500">${esc(l.detail)}</p>` : ''}</div>`).join('')}</div>`
      : '<p class="text-sm text-gray-400 py-4 text-center">履歴はありません</p>'
  }
  async function loadLogs() {
    const host = document.getElementById('rs-log-body'); if (!host || !current) return
    const params = { project_id: current.project.project_id, limit: 200 }
    if (S.logType) params.report_type = S.logType
    if (S.logStaff === 'default') params.scope = 'default'; else if (S.logStaff) params.staff_id = S.logStaff
    let d; try { d = (await axios.get('/api/admin/report-settings/logs', { params })).data } catch (e) { host.innerHTML = `<p class="text-sm text-red-600">${esc(errMsg(e))}</p>`; return }
    host.innerHTML = logRowsHtml(d.logs || [], false)
  }

  // ---------- スタッフ 1 人の全案件の設定（#413） ----------
  async function renderStaffPage(staffId) {
    loading()
    try { staffPage = (await axios.get(`/api/admin/report-settings/staff/${staffId}`)).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p><a href="#report-settings" class="text-blue-600 text-sm">← 案件一覧</a>`; return }
    const d = staffPage, st = d.staff
    const inactive = INACTIVE.includes(st.member_status)
    const rows = d.projects.map(p => Object.assign(p, { staff_id: st.staff_id, name: st.name }))
    $app.innerHTML = `
      <a href="#staff/${Number(st.staff_id)}" class="text-sm text-blue-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>スタッフ詳細</a>
      <div class="flex items-center justify-between flex-wrap gap-2 mt-2 mb-4">
        <div><h2 class="text-xl font-bold text-gray-800">${esc(st.name)} ${memberBadge(st.member_status)}</h2>
          <p class="text-xs text-gray-500 mt-1">案件ごとの勤怠報告の設定（このスタッフにシフトがある案件 ${d.projects.length}件）${st.legacy_mode ? ' ・スタッフ単位の旧設定: ' + esc(EXC[st.legacy_mode] || st.legacy_mode) : ''}</p></div>
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-outline text-sm" data-action="rsStaffReset" ${d.projects.length ? '' : 'disabled'}><i class="fas fa-rotate-left"></i>すべて標準に戻す</button>
          <button class="btn btn-primary text-sm" data-action="rsStaffApplyOpen" ${d.projects.length && !inactive ? '' : 'disabled'}><i class="fas fa-layer-group"></i>すべての案件に同じ設定</button>
        </div>
      </div>
      <section class="card p-4 mb-4">
        <p class="text-[11px] text-gray-500 mb-3">チェックを切り替えるとすぐ保存します（その案件の個別変更）。色の付いたマスは案件の標準設定と違う値です</p>
        ${rows.length ? `<div class="hidden md:block overflow-x-auto"><table class="tbl">
          <thead><tr><th>案件</th>${TYPES.map(t => `<th class="text-center" title="${LABEL[t]}">${SHORT[t]}</th>`).join('')}<th>設定</th><th>今後のシフト</th></tr></thead>
          <tbody>${rows.map(s => `<tr><td class="whitespace-nowrap"><a class="text-blue-600 hover:underline font-medium" href="#report-settings/${Number(s.project_id)}">${esc(s.project_name)}</a> ${s.status === 'active' ? '' : statusBadge(s.status)}</td>
            ${TYPES.map(t => `<td class="text-center ${diffCls(s, t, s.defaults)}">${cell(s, t, s.project_id)}</td>`).join('')}
            <td class="whitespace-nowrap">${kindBadge(s)}${resetBtn(s, s.project_id)}</td><td class="text-xs whitespace-nowrap">${s.upcoming ? Number(s.upcoming) + '件' : '-'} ${excBtn(s, s.project_id)}</td></tr>`).join('')}</tbody></table></div>
        <div class="md:hidden space-y-2">${rows.map(s => `<details class="rounded-lg border border-gray-200">
          <summary class="p-3 flex items-center justify-between gap-2 cursor-pointer"><span class="font-medium truncate">${esc(s.project_name)}</span>
            <span class="flex items-center gap-1 shrink-0">${kindBadge(s)}<span class="text-[11px] text-gray-500">${TYPES.filter(t => s.settings[t]).length}/8 ON</span></span></summary>
          <div class="px-3 pb-3 grid grid-cols-2 gap-2">${TYPES.map(t => `<label class="flex items-center gap-2 p-2 rounded bg-gray-50 text-sm ${diffCls(s, t, s.defaults)}">${cell(s, t, s.project_id)}${LABEL[t]}</label>`).join('')}
            <p class="col-span-2 text-[11px] text-gray-400">今後のシフト ${Number(s.upcoming || 0)}件 ${excBtn(s, s.project_id)}${resetBtn(s, s.project_id)}</p></div></details>`).join('')}</div>`
        : '<p class="text-sm text-gray-400 py-4 text-center">このスタッフにシフトがある案件はありません</p>'}
      </section>
      <section class="card p-4"><h3 class="font-bold text-gray-800 text-sm mb-2"><i class="fas fa-clock-rotate-left text-blue-600 mr-1"></i>設定変更の履歴（このスタッフ）</h3>
        <div id="rs-staff-logs"><div class="flex justify-center py-6"><span class="spin"></span></div></div></section>`
    let logs = []
    try { logs = (await axios.get('/api/admin/report-settings/logs', { params: { staff_id: st.staff_id, limit: 200 } })).data.logs || [] } catch { }
    const host = document.getElementById('rs-staff-logs'); if (host) host.innerHTML = logRowsHtml(logs, true)
  }
  delegate('rsStaffReset', (el) => withSubmitLock(el, async () => {
    const st = staffPage.staff
    if (!confirm(`${st.name}さんの、すべての案件の勤怠報告の設定を、各案件の標準設定に戻しますか？\n個別に変えた値はなくなり、これからは各案件の標準設定の変更に従います${st.legacy_mode ? '\nスタッフ単位の旧設定（' + (EXC[st.legacy_mode] || st.legacy_mode) + '）も消します' : ''}`)) return
    try {
      const { data } = await axios.post(`/api/admin/report-settings/staff/${st.staff_id}/reset`, {})
      toast(data.projects ? `${data.projects}件の案件を標準設定に戻しました` : '戻す設定はありませんでした'); renderStaffPage(st.staff_id)
    } catch (e) { toast(errMsg(e)) }
  }))
  // すべての案件に同じ設定を当てる（選択 → 確認 → 保存）
  let staffApply = null
  delegate('rsStaffApplyOpen', () => {
    staffApply = { types: Object.fromEntries(TYPES.map(t => [t, true])), projects: new Set(staffPage.projects.filter(p => p.status === 'active').map(p => p.project_id)) }
    renderStaffApply()
  })
  function renderStaffApply() {
    modal(`<h3 class="font-bold text-gray-800 mb-1"><i class="fas fa-layer-group text-blue-600 mr-1"></i>すべての案件に同じ設定</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(staffPage.staff.name)}さんの、選んだ案件の設定を 8 種類まとめて上書きします（個別変更として記録します）</p>
      <p class="text-sm font-bold text-gray-700 mb-1">1. 設定（チェック = ON）</p>
      <div class="grid grid-cols-2 gap-2 mb-1">${TYPES.map(t => `<label class="flex items-center gap-2 p-2 rounded border border-gray-200 text-sm"><input type="checkbox" class="rsa-type w-5 h-5" value="${t}" ${staffApply.types[t] ? 'checked' : ''}>${LABEL[t]}</label>`).join('')}</div>
      <div class="flex gap-3 text-xs mb-3"><button class="text-blue-600 hover:underline" data-action="rsStaffApplyPreset" data-mode="all">すべて ON</button>
        <button class="text-blue-600 hover:underline" data-action="rsStaffApplyPreset" data-mode="in_out">入店・退店のみ</button>
        <button class="text-blue-600 hover:underline" data-action="rsStaffApplyPreset" data-mode="none">すべて OFF</button></div>
      <p class="text-sm font-bold text-gray-700 mb-1">2. 対象の案件</p>
      <div class="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100 mb-4">${staffPage.projects.map(p => `<label class="flex items-center gap-2 p-2 text-sm"><input type="checkbox" class="rsa-project w-5 h-5" value="${Number(p.project_id)}" ${staffApply.projects.has(p.project_id) ? 'checked' : ''}>
        <span class="flex-1 truncate">${esc(p.project_name)} ${p.status === 'active' ? '' : statusBadge(p.status)}</span>${p.upcoming ? `<span class="text-[11px] text-gray-400">今後${Number(p.upcoming)}件</span>` : ''}</label>`).join('')}</div>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" data-action="rsStaffApplyPreview">確認する</button></div>`)
  }
  delegate('rsStaffApplyPreset', (el) => {
    const m = el.dataset.mode
    document.querySelectorAll('.rsa-type').forEach(x => { x.checked = m === 'all' || (m === 'in_out' && (x.value === 'check_in' || x.value === 'check_out')) })
  })
  const staffApplyBody = (extra) => ({ settings: { ...staffApply.types }, project_ids: [...staffApply.projects], ...extra })
  delegate('rsStaffApplyPreview', (btn) => withSubmitLock(btn, async () => {
    document.querySelectorAll('.rsa-type').forEach(x => { staffApply.types[x.value] = x.checked })
    staffApply.projects = new Set([...document.querySelectorAll('.rsa-project:checked')].map(x => Number(x.value)))
    if (!staffApply.projects.size) { toast('対象の案件を選択してください'); return }
    let d; try { d = (await axios.post(`/api/admin/report-settings/staff/${staffPage.staff.staff_id}/apply`, staffApplyBody({ dry_run: true }))).data } catch (e) { toast(errMsg(e)); return }
    staffApply.preview = d
    const mark = (v) => v ? '<span class="text-emerald-600 font-bold">ON</span>' : '<span class="text-gray-400">OFF</span>'
    modal(`<h3 class="font-bold text-gray-800 mb-1">設定の確認</h3>
      <p class="text-sm text-gray-700 mb-2">${Number(d.target_count)}件の案件のうち、<b>${Number(d.changed_count)}件</b>の設定が変わります</p>
      <div class="max-h-64 overflow-y-auto border border-gray-100 rounded-lg mb-4">
        <table class="tbl"><thead><tr><th>案件</th>${TYPES.map(t => `<th class="text-center">${SHORT[t]}</th>`).join('')}</tr></thead>
          <tbody>${d.rows.map(r => `<tr class="${r.changed ? '' : 'text-gray-400'}"><td class="whitespace-nowrap">${esc(r.project_name)}${r.changed ? '' : ' <span class="text-[10px]">（変更なし）</span>'}${r.upcoming ? ` <span class="text-[10px] text-gray-400">今後${Number(r.upcoming)}件</span>` : ''}</td>
            ${TYPES.map(t => `<td class="text-center text-xs whitespace-nowrap">${r.before[t] === r.after[t] ? mark(r.after[t]) : mark(r.before[t]) + '→' + mark(r.after[t])}</td>`).join('')}</tr>`).join('')}</tbody></table>
      </div>
      <div class="flex gap-2"><button class="btn btn-outline flex-1" data-action="rsStaffApplyBack">戻る</button>
        <button class="btn btn-primary flex-1" data-action="rsStaffApplySave" ${d.changed_count ? '' : 'disabled'}>${d.changed_count ? Number(d.changed_count) + '件を保存する' : '変更はありません'}</button></div>`)
  }))
  delegate('rsStaffApplyBack', () => renderStaffApply())
  delegate('rsStaffApplySave', (btn) => withSubmitLock(btn, async () => {
    const sid = staffPage.staff.staff_id
    try {
      const { data } = await axios.post(`/api/admin/report-settings/staff/${sid}/apply`, staffApplyBody({ confirm_token: staffApply.preview.confirm_token }))
      closeModal(); toast(`${data.projects_changed}件の案件の設定を変更しました`); renderStaffPage(sid)
    } catch (e) {
      toast(errMsg(e))
      if (e.response && e.response.data && e.response.data.need_confirm) { closeModal(); renderStaffPage(sid) }
    }
  }))

  // スタッフ詳細の提出設定の欄に、案件ごとの勤怠報告の要約を出す（staff-lifecycle.js から呼ぶ。#413）
  window.renderStaffReportSummary = async function (sid) {
    const host = document.getElementById('staff-attendance-report-summary'); if (!host) return
    let d; try { d = (await axios.get(`/api/admin/report-settings/staff/${Number(sid)}`)).data } catch { host.innerHTML = ''; return }
    const list = d.projects.filter(p => p.status === 'active')
    host.innerHTML = `<p class="text-xs font-bold text-gray-600 mb-1">勤怠報告（案件ごと）</p>
      <div class="space-y-1 max-h-40 overflow-y-auto">${list.map(p => `<div class="flex items-center justify-between gap-2 text-[11px] bg-gray-50 rounded p-1.5">
        <span class="truncate">${esc(p.project_name)}</span><span class="flex items-center gap-1 shrink-0">${kindBadge(p)}<span class="text-gray-500">${TYPES.filter(t => p.settings[t]).length}/8 ON</span>${p.upcoming_exceptions ? `<span class="badge badge-yellow text-[10px]">例外 ${Number(p.upcoming_exceptions)}件</span>` : ''}</span></div>`).join('')
        || '<p class="text-[11px] text-gray-400">稼働中の案件のシフトはありません</p>'}</div>
      <a class="btn btn-outline w-full text-xs mt-2" href="#report-settings/staff/${Number(sid)}"><i class="fas fa-list-check"></i>案件ごとの勤怠報告を設定する</a>`
  }

  // ---------- 案件をまたいだ OFF の設定一覧（#446）とシフト単位の例外（#313） ----------
  let offProjects = null
  const offParams = () => Object.fromEntries(Object.entries(S.off).filter(([, v]) => v !== '' && v != null))
  async function renderOffList() {
    loading()
    if (!offProjects) { try { offProjects = (await axios.get('/api/admin/report-settings/projects', { params: { include_closed: 1 } })).data.projects || [] } catch { offProjects = [] } }
    let d
    try { d = (await axios.get('/api/admin/report-settings/off-list', { params: offParams() })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    // 案件 × スタッフでまとめて、OFF の報告を並べる
    const groups = [], byKey = new Map()
    for (const r of d.rows) {
      const k = r.project_id + ':' + r.staff_id
      if (!byKey.has(k)) { const g = { ...r, types: [], last: r }; byKey.set(k, g); groups.push(g) }
      const g = byKey.get(k); g.types.push(r)
      if (String(r.updated_at || '') > String(g.last.updated_at || '')) g.last = r
    }
    const typeBadges = (g) => g.types.map(r => `<span class="badge ${r.default_enabled ? 'badge-yellow' : 'badge-gray'} text-[10px]" title="${esc(SOURCE[r.source] || r.source)}${r.default_enabled ? '' : '（案件の標準設定も OFF）'}">${SHORT[r.report_type] || esc(r.report_type)}</span>`).join(' ')
    const csvUrl = '/api/admin/report-settings/off-list/export?' + new URLSearchParams(offParams()).toString()
    const chk = (k, label) => `<label class="flex items-center gap-1"><input type="checkbox" ${S.off[k] === '1' ? 'checked' : ''} data-rs-change="offFlag" data-key="${k}">${label}</label>`
    const when = (g) => esc(g.last.updated_at ? dayjs(g.last.updated_at).format('YYYY/M/D HH:mm') : '') + ' ' + esc(g.last.updated_by_name || '')
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-list-check text-blue-600 mr-1"></i>案件報告管理</h2>
          <p class="text-xs text-gray-500 mt-1">案件をまたいで、誰のどの報告を OFF にしているかを確かめます。OFF の報告は遅刻の判定・未報告の確認の対象から外れます</p></div>
        <a class="btn btn-primary text-sm" href="${esc(csvUrl)}"><i class="fas fa-file-csv"></i>表示中の条件で CSV 出力</a>
      </div>
      ${tabs('off')}
      <div class="card p-3 mb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
        <label>案件<select class="inp text-sm" data-rs-change="offSel" data-key="project_id"><option value="">すべて</option>${offProjects.map(p => `<option value="${Number(p.project_id)}" ${String(S.off.project_id) === String(p.project_id) ? 'selected' : ''}>${esc(p.project_name)}${(p.status || 'active') !== 'active' ? '（終了）' : ''}</option>`).join('')}</select></label>
        <label>報告の種類<select class="inp text-sm" data-rs-change="offSel" data-key="report_type"><option value="">すべて</option>${TYPES.map(t => `<option value="${t}" ${S.off.report_type === t ? 'selected' : ''}>${LABEL[t]}</option>`).join('')}</select></label>
        <div class="flex flex-col gap-1 justify-end lg:col-span-2 text-gray-600">
          ${chk('include_default', '案件の標準設定どおりの OFF も表示')}${chk('include_inactive', '退職・統合済み・取引終了の人も表示')}${chk('include_closed', '終了した案件も表示')}</div>
      </div>
      <p class="text-[11px] text-gray-400 mb-2">${Number(d.total).toLocaleString()} 件（報告の種類ごと）。画面には ${Number(d.limit).toLocaleString()} 件まで表示します。黄色 = 案件の標準設定は ON（個別に OFF）、灰色 = 標準設定も OFF</p>
      <div class="hidden md:block card overflow-x-auto mb-4"><table class="tbl"><thead><tr><th>案件</th><th>スタッフ</th><th>OFF の報告</th><th>由来</th><th>最終変更</th></tr></thead>
        <tbody>${groups.map(g => `<tr><td class="text-xs"><a class="text-blue-600 hover:underline" href="#report-settings/${Number(g.project_id)}">${esc(g.project_name)}</a>${g.project_status !== 'active' ? ' ' + statusBadge(g.project_status) : ''}</td>
          <td class="text-xs whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#report-settings/staff/${Number(g.staff_id)}">${esc(g.staff_name || '')}</a> ${memberBadge(g.member_status)}</td>
          <td>${typeBadges(g)}</td><td class="text-xs whitespace-nowrap">${[...new Set(g.types.map(r => SOURCE[r.source] || r.source))].map(esc).join('・')}</td>
          <td class="text-xs whitespace-nowrap">${when(g)}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400 py-6">OFF の設定はありません</td></tr>'}</tbody></table></div>
      <div class="md:hidden space-y-2 mb-4">${groups.map(g => `<div class="card p-3 text-xs">
          <p class="font-bold"><a class="text-blue-600" href="#report-settings/staff/${Number(g.staff_id)}">${esc(g.staff_name || '')}</a> ${memberBadge(g.member_status)} <span class="font-normal text-gray-500">${esc(g.project_name)}</span></p>
          <p class="mt-1">${typeBadges(g)}</p><p class="text-gray-400 mt-0.5">${when(g)}</p></div>`).join('') || '<p class="text-center text-gray-400 py-6">OFF の設定はありません</p>'}</div>
      <section class="card p-4"><h3 class="font-bold text-gray-800 text-sm mb-1"><i class="fas fa-calendar-xmark text-amber-500 mr-1"></i>シフト単位の例外（今日以降）</h3>
        <p class="text-[11px] text-gray-500 mb-2">シフトごとに「勤怠報告なし」「入店・退店のみ」にしているシフトです。案件・スタッフ別の設定より優先します</p>
        ${exceptionList(d.exceptions || [])}</section>`
  }
  ON_CHANGE.offSel = (el) => { S.off = { ...S.off, [el.dataset.key]: el.value }; renderOffList() }
  ON_CHANGE.offFlag = (el) => { S.off = { ...S.off, [el.dataset.key]: el.checked ? '1' : '' }; renderOffList() }
})()
