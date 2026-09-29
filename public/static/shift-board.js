// =========================================================
// シフトボード（常勤・スポット）/ 募集枠 / 単価（請求・支払）
// docs/spec_spot_shift.md 第1段階。admin.js の後に読み込む（esc / yen / toast / modal / closeModal / loading / $app を利用）
// =========================================================
(function () {
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const ST_LABEL = { requested: '希望', confirmed: '確定', absent: '欠勤', substitute: '代打' }
  const UNIT_LABEL = { daily: '日額', hourly: '時給' }
  const BT_LABEL = { actual: '実費を請求', fixed: '定額を請求', included: '単価に込み（請求なし）' }
  const PT_LABEL = { actual: '実費を支払', capped: '実費（上限あり）', fixed: '定額を支払', none: '支払なし' }
  const AFF_SHORT = { own_employee: '自社', linked_external: '他社', partner_manual: '取引先', skillsheet_only: 'シート' }
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const d0 = (d) => dayjs(d).format('YYYY-MM-DD')

  // ボードの表示状態（画面遷移しても保持）
  const BS = window.__boardState = window.__boardState || {
    from: dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD'), days: 7, clientId: '', projectIds: [], engagement: '',
    view: 'slot', onlyShort: false, showMoney: true,
  }
  let BOARD = null, MASTER = null

  async function loadMaster() {
    if (MASTER) return MASTER
    const [{ data: pj }, { data: cl }, { data: si }, { data: st }] = await Promise.all([
      axios.get('/api/admin/projects'), axios.get('/api/admin/clients'), axios.get('/api/admin/sites'), axios.get('/api/admin/staff')])
    MASTER = { projects: pj.projects, clients: cl.clients, sites: si.sites, staff: st.staff.filter(s => s.affiliation_type !== 'skillsheet_only' && !s.merged_into_staff_id) }
    return MASTER
  }
  function invalidateMaster() { MASTER = null }
  window.invalidateBoardMaster = invalidateMaster

  // =========================================================
  // シフトボード
  // =========================================================
  window.renderShiftBoard = async function () {
    loading()
    const m = await loadMaster()
    const to = dayjs(BS.from).add(BS.days - 1, 'day').format('YYYY-MM-DD')
    const q = new URLSearchParams({ from: BS.from, to })
    if (BS.clientId) q.set('client_id', BS.clientId)
    if (BS.projectIds.length) q.set('project_ids', BS.projectIds.join(','))
    if (BS.engagement) q.set('engagement', BS.engagement)
    const { data } = await axios.get('/api/admin/shift-board?' + q)
    BOARD = data
    const days = []; for (let i = 0; i < BS.days; i++) days.push(dayjs(BS.from).add(i, 'day').format('YYYY-MM-DD'))
    const t = data.totals
    const fillRate = t.required ? Math.round(t.filled / t.required * 100) : null
    const projOpts = m.projects.filter(p => !BS.clientId || String(p.client_id) === String(BS.clientId))

    $app.innerHTML = `
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 class="text-xl font-bold text-gray-900">シフトボード</h2>
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-outline" onclick="boardShift(-1)"><i class="fas fa-chevron-left"></i></button>
          <button class="btn btn-outline" onclick="boardToday()">今週</button>
          <button class="btn btn-outline" onclick="boardShift(1)"><i class="fas fa-chevron-right"></i></button>
          <select class="inp text-sm w-auto" onchange="boardSet('days', Number(this.value))">
            ${[[7, '1週'], [14, '2週'], [31, '1か月']].map(([v, l]) => `<option value="${v}" ${BS.days === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn btn-primary" onclick="openSlotModal()"><i class="fas fa-plus"></i>枠を作成</button>
          <button class="btn btn-outline" onclick="openPatternModal()"><i class="fas fa-repeat"></i>繰り返し登録</button>
          <button class="btn btn-outline" onclick="openBulkModal()"><i class="fas fa-calendar-week"></i>常勤の一括登録</button>
          <button class="btn btn-outline" onclick="openCopyModal()"><i class="fas fa-copy"></i>コピー</button>
          <a class="btn btn-outline" href="#shifts/week"><i class="fas fa-table-columns"></i>週表示（従来）</a>
        </div>
      </div>

      <section class="card p-3 mb-3 flex flex-wrap gap-2 items-center text-sm" id="board-filters">
        <input type="date" class="inp w-auto text-sm" value="${BS.from}" onchange="boardSet('from', this.value)">
        <select class="inp w-auto text-sm" onchange="boardSet('clientId', this.value); window.__boardState.projectIds = []">
          <option value="">すべてのクライアント</option>
          ${m.clients.map(c => `<option value="${c.client_id}" ${String(BS.clientId) === String(c.client_id) ? 'selected' : ''}>${esc(c.client_name)}</option>`).join('')}
        </select>
        <select class="inp w-auto text-sm" onchange="boardSet('engagement', this.value)">
          <option value="">常勤・スポット</option>
          <option value="regular" ${BS.engagement === 'regular' ? 'selected' : ''}>常勤のみ</option>
          <option value="spot" ${BS.engagement === 'spot' ? 'selected' : ''}>スポットのみ</option>
        </select>
        <details class="relative">
          <summary class="inp w-auto text-sm cursor-pointer select-none">案件 ${BS.projectIds.length ? `（${BS.projectIds.length}件選択）` : '（すべて）'}</summary>
          <div class="absolute z-20 bg-white border border-gray-200 rounded-lg shadow-lg p-2 mt-1 max-h-72 overflow-y-auto w-72">
            ${projOpts.map(p => `<label class="flex items-center gap-2 py-1 text-xs"><input type="checkbox" value="${p.project_id}" ${BS.projectIds.includes(p.project_id) ? 'checked' : ''} onchange="boardToggleProject(${p.project_id}, this.checked)">
              <span class="badge ${p.engagement_type === 'spot' ? 'badge-purple' : 'badge-blue'}">${p.engagement_type === 'spot' ? 'スポット' : '常勤'}</span>${esc(p.project_name)}</label>`).join('') || '<p class="text-xs text-gray-400">案件がありません</p>'}
            <button class="btn btn-primary w-full text-xs mt-2" onclick="renderShiftBoard()">絞り込む</button>
          </div>
        </details>
        <label class="flex items-center gap-1 text-xs"><input type="checkbox" ${BS.onlyShort ? 'checked' : ''} onchange="boardSet('onlyShort', this.checked)">不足のみ</label>
        <div class="flex rounded-lg border border-gray-200 overflow-hidden text-xs ml-auto">
          <button class="px-3 py-1.5 ${BS.view === 'slot' ? 'bg-blue-600 text-white' : 'bg-white'}" onclick="boardSet('view','slot')">枠ごと</button>
          <button class="px-3 py-1.5 ${BS.view === 'person' ? 'bg-blue-600 text-white' : 'bg-white'}" onclick="boardSet('view','person')">人ごと</button>
        </div>
        <label class="flex items-center gap-1 text-xs"><input type="checkbox" ${BS.showMoney ? 'checked' : ''} onchange="boardSet('showMoney', this.checked)">金額を表示</label>
      </section>

      <section class="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3" id="board-totals">
        <div class="card p-3"><p class="text-xs text-gray-500">充足</p><p class="text-lg font-bold ${fillRate != null && fillRate < 100 ? 'text-red-600' : ''}">${t.filled}/${t.required}${fillRate != null ? `<span class="text-xs font-normal text-gray-400 ml-1">${fillRate}%</span>` : ''}</p></div>
        <div class="card p-3"><p class="text-xs text-gray-500">請求合計</p><p class="text-lg font-bold">${yen(t.bill)}</p></div>
        <div class="card p-3"><p class="text-xs text-gray-500">支払合計</p><p class="text-lg font-bold">${yen(t.pay)}${t.pay_missing ? `<span class="text-xs text-amber-600 ml-1" title="支払単価が未設定のシフト">未設定${t.pay_missing}件</span>` : ''}</p></div>
        <div class="card p-3"><p class="text-xs text-gray-500">粗利</p><p class="text-lg font-bold ${t.profit < 0 ? 'text-red-600' : 'text-emerald-700'}">${yen(t.profit)}</p></div>
        <div class="card p-3"><p class="text-xs text-gray-500">粗利率</p><p class="text-lg font-bold">${t.bill ? Math.round(t.profit / t.bill * 1000) / 10 + '%' : '-'}</p></div>
      </section>

      <div class="flex gap-3 items-start">
        <section class="card p-0 overflow-auto flex-1 min-w-0" id="board-grid" style="max-height: calc(100vh - 290px)">
          ${BS.view === 'person' ? personGrid(days) : slotGrid(days)}
        </section>
        <aside class="card p-3 w-56 shrink-0 hidden xl:block sticky top-4" id="board-staff-panel" style="max-height: calc(100vh - 290px); overflow-y:auto">
          <p class="text-xs font-bold text-gray-700 mb-1"><i class="fas fa-user-plus text-blue-500 mr-1"></i>スタッフ</p>
          <p class="text-[11px] text-gray-400 mb-2">枠へドラッグして割り当て。枠の「＋」から候補（空き・経験・スキル）を表示できます</p>
          <input class="inp text-xs mb-2" placeholder="名前で絞り込み" oninput="boardFilterStaff(this.value)">
          <div id="board-staff-list" class="space-y-1">
            ${m.staff.map(s => `<div class="board-chip staff-src" data-staff-id="${s.staff_id}" data-name="${esc(s.name)}">
              <span class="truncate">${esc(s.name)}</span><span class="text-[10px] text-gray-400">${AFF_SHORT[s.affiliation_type] || ''}</span></div>`).join('')}
          </div>
        </aside>
      </div>`
    enableDnD()
  }

  function slotGrid(days) {
    const b = BOARD
    const today = dayjs().format('YYYY-MM-DD')
    // 行 = 案件 × 開催場所 × 時間帯 × 役割
    const rows = new Map()
    for (const s of b.slots) for (const r of s.roles) {
      const key = [s.project_id, s.site_id || s.location || '', s.start_time, s.end_time, r.role_name].join('|')
      if (!rows.has(key)) rows.set(key, { project_id: s.project_id, site: s.site_name || s.location || '', start: s.start_time, end: s.end_time, role: r.role_name, cells: {} })
      const row = rows.get(key); (row.cells[s.work_date] = row.cells[s.work_date] || []).push({ slot: s, role: r })
    }
    const proj = new Map(b.projects.map(p => [p.project_id, p]))
    let list = [...rows.values()].sort((a, c) => {
      const pa = proj.get(a.project_id) || {}, pc = proj.get(c.project_id) || {}
      return String(pa.client_name || '').localeCompare(pc.client_name || '') || String(pa.project_name).localeCompare(pc.project_name) || a.site.localeCompare(c.site) || a.start.localeCompare(c.start) || a.role.localeCompare(c.role)
    })
    if (BS.onlyShort) list = list.filter(r => Object.values(r.cells).some(cs => cs.some(c => c.role.filled < c.role.headcount)))
    // 枠なし（常勤の従来登録）: 案件ごとに1行
    const plain = new Map()
    for (const s of b.unslotted) {
      const k = s.project_id + '|' + (s.site_name || s.location || '')
      if (!plain.has(k)) plain.set(k, { project_id: s.project_id, site: s.site_name || s.location || '', cells: {} })
      const r = plain.get(k); (r.cells[s.work_date] = r.cells[s.work_date] || []).push(s)
    }
    const head = `<thead class="sticky top-0 z-10 bg-white"><tr>
      <th class="board-th text-left sticky left-0 z-20 bg-white" style="min-width:190px">案件 / 開催場所 / 役割</th>
      ${days.map(d => { const w = dayjs(d).day(); return `<th class="board-th ${d === today ? 'bg-blue-50' : ''} ${w === 0 ? 'text-red-500' : w === 6 ? 'text-blue-500' : ''}" style="min-width:${BS.days > 14 ? 88 : 108}px;width:${BS.days > 14 ? 88 : 108}px">
        <button class="hover:underline" onclick="openSlotModal({work_date:'${d}'})" title="この日に枠を作成">${dayjs(d).format('M/D')}(${WD[w]})</button></th>` }).join('')}
    </tr></thead>`
    let lastProject = null
    const body = list.map(r => {
      const p = proj.get(r.project_id) || {}
      const header = lastProject !== r.project_id ? `<tr><td colspan="${days.length + 1}" class="board-group sticky left-0">
        <span class="badge ${p.engagement_type === 'spot' ? 'badge-purple' : 'badge-blue'}">${p.engagement_type === 'spot' ? 'スポット' : '常勤'}</span>
        <a href="#projects/${p.project_id}" class="font-bold hover:underline ml-1">${esc(p.project_name)}</a><span class="text-gray-400 ml-2">${esc(p.client_name || '')}</span></td></tr>` : ''
      lastProject = r.project_id
      return header + `<tr>
        <td class="board-rowhead sticky left-0 bg-white z-10"><p class="font-bold text-xs truncate">${esc(r.site || '（場所未設定）')}</p>
          <p class="text-[11px] text-gray-500">${r.start}〜${r.end}・<span class="font-bold text-gray-700">${esc(r.role)}</span></p></td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${BS.days > 14 ? 88 : 108}px">${(r.cells[d] || []).map(c => slotCell(c.slot, c.role)).join('')}</td>`).join('')}
      </tr>`
    }).join('')
    const plainRows = [...plain.values()].map(r => {
      const p = proj.get(r.project_id) || {}
      return `<tr><td class="board-rowhead sticky left-0 bg-white z-10"><p class="font-bold text-xs truncate"><span class="badge badge-gray mr-1">枠なし</span>${esc(p.project_name || '')}</p>
        <p class="text-[11px] text-gray-500 truncate">${esc(r.site)}</p></td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${BS.days > 14 ? 88 : 108}px">${(r.cells[d] || []).map(s => staffChip(s)).join('')}</td>`).join('')}</tr>`
    }).join('')
    if (!list.length && !plainRows) return `<div class="p-10 text-center text-sm text-gray-400">
      この期間の枠・シフトはありません<br><button class="btn btn-primary mt-3" onclick="openSlotModal()"><i class="fas fa-plus"></i>枠を作成</button></div>`
    return `<table class="board-table">${head}<tbody>${body}${plainRows ? `<tr><td colspan="${days.length + 1}" class="board-group sticky left-0 text-gray-500">枠を使わないシフト（従来の登録）</td></tr>` + plainRows : ''}</tbody></table>`
  }

  function slotCell(slot, role) {
    const short = role.filled < role.headcount
    const over = role.filled > role.headcount
    const money = BS.showMoney ? role.assigned.filter(a => ['confirmed', 'substitute'].includes(a.status)).reduce((x, a) => x + (a.bill_total || 0), 0) : 0
    return `<div class="board-cell ${short ? 'board-short' : over ? 'board-over' : 'board-ok'}" data-slot-role-id="${role.slot_role_id}">
      <div class="flex items-center justify-between gap-1 mb-1">
        <button class="text-[11px] font-bold ${short ? 'text-red-600' : 'text-emerald-700'}" onclick="openSlotModal(null, ${slot.slot_id})" title="枠を編集">${role.filled}/${role.headcount}${role.requested ? `<span class="text-amber-600 ml-1">希望${role.requested}</span>` : ''}</button>${role.applicants ? `<a href="#recruit" class="text-[10px] ml-1 px-1 rounded bg-red-100 text-red-700" title="未対応の応募">応募${role.applicants}</a>` : ''}
        <span class="flex items-center gap-1">
          ${BS.showMoney && money ? `<span class="text-[10px] text-gray-400">${yen(money)}</span>` : ''}
          <button class="board-add" onclick="openCandidates(${role.slot_role_id})" title="候補から割り当て"><i class="fas fa-plus"></i></button>
        </span>
      </div>
      <div class="board-drop space-y-0.5" data-slot-role-id="${role.slot_role_id}">${role.assigned.map(a => staffChip(a)).join('')}</div>
    </div>`
  }

  function staffChip(a) {
    const warn = (a.conflicts && a.conflicts.length) || a.ng
    const title = [
      a.conflicts && a.conflicts.length ? '重複: ' + a.conflicts.map(x => (x.other_company ? x.company_name + '（他社）' : x.project_name) + ' ' + x.start_time + '〜' + x.end_time).join(' / ') : '',
      a.ng ? 'NGスタッフに指定されています' : '',
      BS.showMoney ? `請求 ${yen(a.bill_total)} / 支払 ${a.pay_total == null ? '未設定' : yen(a.pay_total)}` : '',
    ].filter(Boolean).join('\n')
    return `<div class="board-chip shift-chip st-${a.status} ${warn ? 'chip-warn' : ''}" data-shift-id="${a.shift_id}" title="${esc(title)}" onclick="openShiftDetail(${a.shift_id})">
      <span class="truncate">${warn ? '<i class="fas fa-triangle-exclamation text-red-500 mr-0.5"></i>' : ''}${esc(a.staff_name)}</span>
      <span class="text-[10px] shrink-0">${a.status !== 'confirmed' ? ST_LABEL[a.status] || '' : ''}${a.price_locked ? '<i class="fas fa-pen text-gray-400 ml-0.5" title="金額を手動変更"></i>' : ''}${BS.showMoney && a.pay_total == null && ['confirmed', 'substitute'].includes(a.status) ? '<i class="fas fa-yen-sign text-amber-500 ml-0.5" title="支払単価未設定"></i>' : ''}</span>
    </div>`
  }

  function personGrid(days) {
    const all = [...BOARD.slots.flatMap(s => s.roles.flatMap(r => r.assigned.map(a => ({ ...a, _site: s.site_name || s.location })))), ...BOARD.unslotted.map(a => ({ ...a, _site: a.site_name || a.location }))]
    const byStaff = new Map()
    for (const a of all) { if (!byStaff.has(a.staff_id)) byStaff.set(a.staff_id, { name: a.staff_name, aff: a.affiliation_type, cells: {} }); const r = byStaff.get(a.staff_id); (r.cells[a.work_date] = r.cells[a.work_date] || []).push(a) }
    const proj = new Map(BOARD.projects.map(p => [p.project_id, p]))
    const rows = [...byStaff.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))
    if (!rows.length) return '<div class="p-10 text-center text-sm text-gray-400">この期間のシフトはありません</div>'
    const today = dayjs().format('YYYY-MM-DD')
    return `<table class="board-table"><thead class="sticky top-0 z-10 bg-white"><tr>
      <th class="board-th text-left sticky left-0 z-20 bg-white" style="min-width:170px">スタッフ</th><th class="board-th">稼働</th>
      ${days.map(d => { const w = dayjs(d).day(); return `<th class="board-th ${d === today ? 'bg-blue-50' : ''} ${w === 0 ? 'text-red-500' : w === 6 ? 'text-blue-500' : ''}" style="min-width:${BS.days > 14 ? 86 : 118}px;max-width:${BS.days > 14 ? 86 : 118}px;width:${BS.days > 14 ? 86 : 118}px">${dayjs(d).format('M/D')}(${WD[w]})</th>` }).join('')}
    </tr></thead><tbody>${rows.map(([sid, r]) => {
      const n = Object.values(r.cells).flat().filter(a => ['confirmed', 'substitute'].includes(a.status)).length
      return `<tr><td class="board-rowhead sticky left-0 bg-white z-10"><a href="#staff/${sid}" class="text-xs font-bold hover:underline">${esc(r.name)}</a> <span class="text-[10px] text-gray-400">${AFF_SHORT[r.aff] || ''}</span></td>
        <td class="board-td text-center text-xs font-bold">${n}日</td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${BS.days > 14 ? 86 : 118}px">${(r.cells[d] || []).map(a => {
          const p = proj.get(a.project_id) || {}
          const warn = (a.conflicts && a.conflicts.length) || a.ng
          return `<div class="board-chip st-${a.status} ${warn ? 'chip-warn' : ''} flex-col items-start" onclick="openShiftDetail(${a.shift_id})" title="${esc(p.project_name + ' / ' + (a._site || ''))}">
            <span class="truncate w-full text-[11px] font-bold">${warn ? '<i class="fas fa-triangle-exclamation text-red-500 mr-0.5"></i>' : ''}${esc(p.project_name || '')}</span>
            <span class="truncate w-full text-[10px] text-gray-500">${esc(a._site || '')} ${a.start_time}〜${a.end_time}</span></div>` }).join('')}</td>`).join('')}</tr>`
    }).join('')}</tbody></table>`
  }

  // ---------- ボード操作 ----------
  window.boardSet = function (k, v) { BS[k] = v; renderShiftBoard() }
  window.boardShift = function (dir) { BS.from = dayjs(BS.from).add(dir * (BS.days >= 28 ? 28 : BS.days), 'day').format('YYYY-MM-DD'); renderShiftBoard() }
  window.boardToday = function () { BS.from = dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD'); if (dayjs().day() === 0) BS.from = dayjs().subtract(6, 'day').format('YYYY-MM-DD'); renderShiftBoard() }
  window.boardToggleProject = function (id, on) { BS.projectIds = on ? [...new Set([...BS.projectIds, id])] : BS.projectIds.filter(x => x !== id) }
  window.boardFilterStaff = function (q) {
    document.querySelectorAll('#board-staff-list .staff-src').forEach(el => { el.style.display = !q || el.dataset.name.includes(q) ? '' : 'none' })
  }

  // ドラッグ＆ドロップ（SortableJS）: 右パネル → 枠（割り当て）/ 枠 → 枠（移動）
  function enableDnD() {
    if (!window.Sortable) return
    const list = document.getElementById('board-staff-list')
    if (list) Sortable.create(list, { group: { name: 'board', pull: 'clone', put: false }, sort: false, animation: 120 })
    document.querySelectorAll('.board-drop').forEach(el => {
      Sortable.create(el, {
        group: { name: 'board', pull: true, put: true }, sort: false, animation: 120, emptyInsertThreshold: 20,
        onAdd: async (evt) => {
          const item = evt.item, toRole = Number(evt.to.dataset.slotRoleId)
          const shiftId = item.dataset.shiftId, staffId = item.dataset.staffId
          item.remove()
          if (shiftId) await moveShift(Number(shiftId), toRole)
          else if (staffId) await assignStaff(toRole, [Number(staffId)])
        },
      })
    })
  }

  async function assignStaff(slotRoleId, staffIds, force, extra) {
    try {
      const { data } = await axios.post(`/api/admin/shift-slots/roles/${slotRoleId}/assign`, { staff_ids: staffIds, force: !!force, ...(extra || {}) })
      toast(data.warnings && data.warnings.length ? '警告を確認のうえ割り当てました' : '割り当てました')
      closeModal(); renderShiftBoard()
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) { if (confirm(d.warnings.join('\n') + '\n\nこのまま割り当てますか？')) return assignStaff(slotRoleId, staffIds, true, extra); return renderShiftBoard() }
      toast(errMsg(e)); renderShiftBoard()
    }
  }
  async function moveShift(shiftId, slotRoleId, force) {
    try {
      await axios.post(`/api/admin/shifts/${shiftId}/move`, { slot_role_id: slotRoleId, force: !!force })
      toast('移動しました（単価は移動先に合わせて再計算）'); renderShiftBoard()
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) { if (confirm(d.warnings.join('\n') + '\n\nこのまま移動しますか？')) return moveShift(shiftId, slotRoleId, true); return renderShiftBoard() }
      toast(errMsg(e)); renderShiftBoard()
    }
  }
  window.boardAssign = assignStaff

  // ---------- 候補から割り当て ----------
  window.openCandidates = async function (slotRoleId) {
    const { data } = await axios.get('/api/admin/shift-board/candidates?slot_role_id=' + slotRoleId)
    const r = data.slot_role
    modal(`
      <h3 class="font-bold text-lg mb-1">スタッフを割り当て</h3>
      <p class="text-xs text-gray-500 mb-3">${dayjs(r.work_date).format('M/D')}(${WD[dayjs(r.work_date).day()]}) ${r.start_time}〜${r.end_time}・${esc(r.location || '')}・<b>${esc(r.role_name)}</b>（必要 ${r.headcount}名）</p>
      <input class="inp text-sm mb-2" placeholder="名前で絞り込み" oninput="document.querySelectorAll('.cand-row').forEach(el=>el.style.display=!this.value||el.dataset.name.includes(this.value)?'':'none')">
      <div class="max-h-96 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
        ${data.candidates.map(c => `<label class="cand-row flex items-center gap-2 px-2 py-1.5 text-sm ${c.busy || c.ng ? 'bg-red-50' : ''}" data-name="${esc(c.name)}">
          <input type="checkbox" class="cand-check" value="${c.staff_id}">
          <span class="flex-1 min-w-0"><span class="font-bold">${esc(c.name)}</span> <span class="text-[11px] text-gray-400">${AFF_SHORT[c.affiliation_type] || ''}</span>
            <span class="block text-[11px] text-gray-500">
              ${c.busy ? `<span class="text-red-600"><i class="fas fa-clock mr-0.5"></i>${esc(c.busy_detail.join('、'))}</span>` : '<span class="text-emerald-600">空き</span>'}
              ${c.ng ? '<span class="text-red-600 ml-1">NG</span>' : ''}${c.on_leave ? '<span class="text-amber-600 ml-1">休職中</span>' : ''}
              ・この場所 ${c.site_count}回・この案件 ${c.project_count}回${c.skill_required ? `・スキル ${c.skill_match}/${c.skill_required}` : ''}・今週 ${c.week_days}日</span></span>
        </label>`).join('') || '<p class="p-3 text-sm text-gray-400">候補がいません</p>'}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-3">
        <select id="cand-status" class="inp text-sm"><option value="confirmed">確定で登録</option><option value="requested">希望（仮）で登録</option></select>
        <input id="cand-fee" type="number" class="inp text-sm" placeholder="交通費の実費（任意）">
      </div>
      <button class="btn btn-primary w-full mt-3" onclick="assignFromCandidates(${slotRoleId})">選択したスタッフを割り当て</button>
      <button class="btn btn-outline w-full mt-2 text-sm" onclick="showQuickRegister && showQuickRegister({ slot_role_id: ${slotRoleId} })"><i class="fas fa-bolt"></i>一覧にいない人を仮登録して割り当て（氏名・電話のみ）</button>`)
  }
  window.assignFromCandidates = function (slotRoleId) {
    const ids = [...document.querySelectorAll('.cand-check:checked')].map(el => Number(el.value))
    if (!ids.length) { toast('スタッフを選択してください'); return }
    const fee = document.getElementById('cand-fee').value
    assignStaff(slotRoleId, ids, false, { status: document.getElementById('cand-status').value, ...(fee !== '' ? { transportation_fee: Number(fee) } : {}) })
  }

  // ---------- シフト詳細（状態・金額） ----------
  function findShift(id) {
    for (const s of BOARD.slots) for (const r of s.roles) { const a = r.assigned.find(x => x.shift_id === id); if (a) return a }
    return BOARD.unslotted.find(x => x.shift_id === id)
  }
  window.openShiftDetail = function (id) {
    const a = findShift(id); if (!a) return
    let src = {}; try { src = JSON.parse(a.price_source || '{}') } catch (e) { }
    const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')
    modal(`
      <h3 class="font-bold text-lg mb-1">${esc(a.staff_name)}</h3>
      <p class="text-xs text-gray-500 mb-3">${dayjs(a.work_date).format('M/D')}(${WD[dayjs(a.work_date).day()]}) ${a.start_time}〜${a.end_time}・${esc(a.site_name || a.location || '')}・${esc(a.role || '')}
        <span class="badge badge-gray ml-1">${ST_LABEL[a.status]}</span></p>
      ${a.conflicts && a.conflicts.length ? `<p class="text-xs text-red-600 bg-red-50 rounded p-2 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>同じ時間帯に別のシフト: ${esc(a.conflicts.map(x => (x.other_company ? x.company_name + '（他社）' : x.project_name) + ' ' + x.start_time + '〜' + x.end_time).join(' / '))}</p>` : ''}
      ${a.ng ? '<p class="text-xs text-red-600 bg-red-50 rounded p-2 mb-2">クライアントのNGスタッフに指定されています</p>' : ''}
      ${a.settle_status === 'confirmed' ? '<p class="text-xs text-emerald-700 bg-emerald-50 rounded p-2 mb-2" id="shift-settled-notice"><i class="fas fa-lock mr-1"></i>実績が確定済みのため、状態・時間・金額は変更できません（<a class="underline" href="#settlement">精算</a>で取り消せます）</p>' : ''}
      ${a.actual_start ? `<p class="text-xs text-gray-600 mb-2"><i class="fas fa-clock mr-1"></i>実績 ${a.actual_start}〜${a.actual_end}（${a.actual_source === 'manual' ? '手入力' : '報告'}）</p>` : ''}
      <div class="grid grid-cols-4 gap-1.5 mb-4">
        ${['confirmed', 'requested', 'substitute', 'absent'].map(st => `<button class="btn btn-outline text-xs ${a.status === st ? 'ring-2 ring-blue-400' : ''}" onclick="boardShiftStatus(${id}, '${st}')">${ST_LABEL[st]}</button>`).join('')}
      </div>
      <div class="rounded-lg border border-gray-100 p-3 mb-3 text-xs space-y-2" id="shift-price-form">
        <div class="flex items-center justify-between"><p class="font-bold text-gray-700"><i class="fas fa-yen-sign mr-1"></i>金額（管理画面のみ表示）</p>
          ${a.price_locked ? `<button class="text-blue-600 hover:underline" onclick="boardResetPrice(${id})">単価ルールに戻す</button>` : '<span class="text-gray-400">単価ルールから自動計算</span>'}</div>
        <div class="grid grid-cols-3 gap-2 items-end">
          <label>請求<select id="sp-bill-unit" class="inp text-xs">${opt(UNIT_LABEL, a.bill_unit_type || 'daily')}</select></label>
          <label>請求単価<input id="sp-bill-rate" type="number" class="inp text-xs" value="${a.bill_rate ?? ''}"></label>
          <label>数量<input id="sp-bill-qty" type="number" step="0.25" class="inp text-xs" value="${a.bill_qty ?? ''}"></label>
          <label>支払<select id="sp-pay-unit" class="inp text-xs">${opt(UNIT_LABEL, a.pay_unit_type || 'daily')}</select></label>
          <label>支払単価<input id="sp-pay-rate" type="number" class="inp text-xs" value="${a.pay_rate ?? ''}" placeholder="未設定"></label>
          <label>数量<input id="sp-pay-qty" type="number" step="0.25" class="inp text-xs" value="${a.pay_qty ?? ''}"></label>
          <label>交通費の実費<input id="sp-fee" type="number" class="inp text-xs" value="${a.transportation_fee ?? 0}"></label>
          <label>交通費の請求<select id="sp-bt" class="inp text-xs">${opt(BT_LABEL, a.bill_transport_type || 'actual')}</select></label>
          <label>請求額（定額時）<input id="sp-bt-amt" type="number" class="inp text-xs" value="${a.bill_transport_amount ?? 0}"></label>
          <label>休憩（分）<input id="sp-break" type="number" class="inp text-xs" value="${a.break_minutes ?? ''}"></label>
          <label>交通費の支払<select id="sp-pt" class="inp text-xs">${opt(PT_LABEL, a.pay_transport_type || 'actual')}</select></label>
          <label>上限/定額<input id="sp-pt-amt" type="number" class="inp text-xs" value="${a.pay_transport_amount ?? 0}"></label>
          <label>請求の調整<input id="sp-bill-adj" type="number" class="inp text-xs" value="${a.bill_adjust || 0}"></label>
          <label>支払の調整<input id="sp-pay-adj" type="number" class="inp text-xs" value="${a.pay_adjust || 0}"></label>
          <label>調整の内容<input id="sp-adj-note" class="inp text-xs" value="${esc(a.adjust_note || '')}" placeholder="残業・手当など"></label>
        </div>
        <div class="grid grid-cols-3 gap-2 bg-gray-50 rounded p-2">
          <p>請求 <b>${yen(a.bill_total)}</b><span class="block text-gray-400">基本${yen(a.unit_price)}＋交通費${yen(a.bill_transport)}</span></p>
          <p>支払 <b>${a.pay_total == null ? '未設定' : yen(a.pay_total)}</b><span class="block text-gray-400">基本${a.pay_amount == null ? '-' : yen(a.pay_amount)}＋交通費${yen(a.pay_transport)}</span></p>
          <p>粗利 <b>${a.pay_total == null ? '-' : yen(a.bill_total - a.pay_total)}</b><span class="block text-gray-400">${esc(src.manual || src.bill || '')}${src.pay && !src.manual ? ' / 支払: ' + esc(src.pay) : ''}</span></p>
        </div>
        <button class="btn btn-primary w-full text-xs" onclick="boardSavePrice(${id})">金額を保存（このシフトだけ手動で変更）</button>
      </div>
      <div id="shift-report-panel" class="mb-3"></div>
      <div class="flex gap-2">
        <a class="btn btn-outline flex-1 text-xs" href="#staff/${a.staff_id}">スタッフ詳細</a>
        <button class="btn btn-danger flex-1 text-xs" onclick="boardDeleteShift(${id})"><i class="fas fa-trash"></i>シフトを削除</button>
      </div>`)
    // 勤怠・日報の報告状況 / 報告用URL / 代理入力（public/static/staff-lifecycle.js）
    if (window.renderShiftReportPanel) renderShiftReportPanel(id)
  }
  window.boardShiftStatus = async function (id, status) {
    try { await axios.put('/api/admin/shifts/' + id, { status }); closeModal(); toast('更新しました'); renderShiftBoard() } catch (e) { toast(errMsg(e)) }
  }
  window.boardDeleteShift = async function (id) {
    if (!confirm('このシフトを削除しますか？')) return
    try { await axios.delete('/api/admin/shifts/' + id); closeModal(); toast('削除しました'); renderShiftBoard() } catch (e) { toast(errMsg(e)) }
  }
  window.boardResetPrice = async function (id) {
    try { await axios.put(`/api/admin/shifts/${id}/price`, { reset: true }); closeModal(); toast('単価ルールに戻しました'); renderShiftBoard() } catch (e) { toast(errMsg(e)) }
  }
  window.boardSavePrice = async function (id) {
    const v = (k) => document.getElementById(k).value
    try {
      await axios.put(`/api/admin/shifts/${id}/price`, {
        bill_unit_type: v('sp-bill-unit'), bill_rate: v('sp-bill-rate'), bill_qty: v('sp-bill-qty'),
        pay_unit_type: v('sp-pay-unit'), pay_rate: v('sp-pay-rate'), pay_qty: v('sp-pay-qty'),
        transportation_fee: v('sp-fee'), bill_transport_type: v('sp-bt'), bill_transport_amount: v('sp-bt-amt'),
        pay_transport_type: v('sp-pt'), pay_transport_amount: v('sp-pt-amt'), break_minutes: v('sp-break'),
        bill_adjust: v('sp-bill-adj'), pay_adjust: v('sp-pay-adj'), adjust_note: v('sp-adj-note'),
      })
      closeModal(); toast('金額を保存しました'); renderShiftBoard()
    } catch (e) { toast(errMsg(e)) }
  }

  // =========================================================
  // 枠の作成・編集
  // =========================================================
  function roleRowsHtml(roles) {
    return roles.map((r, i) => `<div class="grid grid-cols-12 gap-1.5 items-center role-row" data-id="${r.slot_role_id || ''}">
      <input class="inp text-xs col-span-4 rr-name" placeholder="役割（販売・リーダー等）" value="${esc(r.role_name || '')}" list="role-suggest">
      <input class="inp text-xs col-span-2 rr-count" type="number" min="1" value="${r.headcount || 1}" title="必要人数">
      <input class="inp text-xs col-span-3 rr-bill" type="number" placeholder="請求単価（任意）" value="${r.bill_rate ?? ''}" title="この枠だけ請求単価を変える場合">
      <input class="inp text-xs col-span-2 rr-pay" type="number" placeholder="支払（任意）" value="${r.pay_rate ?? ''}" title="この枠だけ支払単価を変える場合">
      <button class="text-gray-400 hover:text-red-500 col-span-1" onclick="this.closest('.role-row').classList.toggle('opacity-40'); this.closest('.role-row').dataset.del = this.closest('.role-row').dataset.del ? '' : '1'" title="削除"><i class="fas fa-xmark"></i></button>
    </div>`).join('')
  }
  function collectRoles() {
    return [...document.querySelectorAll('.role-row')].map(el => ({
      slot_role_id: el.dataset.id ? Number(el.dataset.id) : undefined, _delete: !!el.dataset.del,
      role_name: el.querySelector('.rr-name').value.trim(), headcount: Number(el.querySelector('.rr-count').value || 1),
      bill_rate: el.querySelector('.rr-bill').value, pay_rate: el.querySelector('.rr-pay').value,
    })).filter(r => r.slot_role_id || (!r._delete && r.role_name))
  }
  window.addRoleRow = function () {
    const box = document.getElementById('slot-roles'); box.insertAdjacentHTML('beforeend', roleRowsHtml([{ role_name: '', headcount: 1 }]))
  }
  function siteOptions(m, projectId, selected) {
    const p = m.projects.find(x => String(x.project_id) === String(projectId))
    const list = m.sites.filter(s => s.status !== 'inactive' && (!p || !p.client_id || !s.client_id || String(s.client_id) === String(p.client_id)))
    return `<option value="">（開催場所を選択 / 直接入力）</option>` + list.map(s => `<option value="${s.site_id}" ${String(selected) === String(s.site_id) ? 'selected' : ''}>${esc(s.site_name)}</option>`).join('')
  }
  window.slotProjectChanged = function () {
    const m = MASTER; const pid = document.getElementById('slot-project').value
    document.getElementById('slot-site').innerHTML = siteOptions(m, pid, '')
  }
  function slotFormHtml(m, s, roles) {
    return `
      <div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">案件 *
            <select id="slot-project" class="inp" onchange="slotProjectChanged()" ${s.slot_id ? 'disabled' : ''}>
              ${m.projects.filter(p => p.status === 'active' || String(p.project_id) === String(s.project_id)).map(p => `<option value="${p.project_id}" ${String(p.project_id) === String(s.project_id) ? 'selected' : ''}>${p.engagement_type === 'spot' ? '[スポット] ' : '[常勤] '}${esc(p.project_name)}</option>`).join('')}
            </select></label>
          <label class="text-sm text-gray-600">開催場所
            <select id="slot-site" class="inp">${siteOptions(m, s.project_id || (m.projects[0] || {}).project_id, s.site_id)}</select></label>
        </div>
        <input id="slot-location" class="inp text-sm" placeholder="場所の補足（開催場所マスタにない場合はここに入力）" value="${esc(s.location && !s.site_id ? s.location : '')}">
        <div class="grid grid-cols-3 gap-3">
          <label class="text-sm text-gray-600">開始<input id="slot-start" type="time" class="inp" value="${s.start_time || '10:00'}"></label>
          <label class="text-sm text-gray-600">終了<input id="slot-end" type="time" class="inp" value="${s.end_time || '19:00'}"></label>
          <label class="text-sm text-gray-600">休憩（分）<input id="slot-break" type="number" class="inp" value="${s.break_minutes ?? ''}" placeholder="案件の設定"></label>
        </div>
        <div>
          <div class="flex items-center justify-between mb-1"><p class="text-sm text-gray-600">役割と必要人数 *</p>
            <button class="text-xs text-blue-600 hover:underline" onclick="addRoleRow()"><i class="fas fa-plus mr-0.5"></i>役割を追加</button></div>
          <div id="slot-roles" class="space-y-1.5">${roleRowsHtml(roles)}</div>
          <datalist id="role-suggest"><option value="販売"><option value="リーダー"><option value="MC"><option value="設営"><option value="サポート"></datalist>
          <p class="text-[11px] text-gray-400 mt-1">単価を空欄にすると、案件の単価ルール（役割・開催場所・スタッフ別）に従います</p>
        </div>
        <input id="slot-memo" class="inp text-sm" placeholder="メモ（任意）" value="${esc(s.memo || '')}">
      </div>`
  }
  window.openSlotModal = async function (preset, slotId) {
    const m = await loadMaster()
    let s = { ...(preset || {}) }, roles = [{ role_name: '販売', headcount: 1 }]
    if (slotId) { const { data } = await axios.get('/api/admin/shift-slots/' + slotId); s = data.slot; roles = data.roles }
    if (!s.project_id && BS.projectIds.length === 1) s.project_id = BS.projectIds[0]
    modal(`
      <h3 class="font-bold text-lg mb-3">${slotId ? '枠を編集' : '枠を作成'}</h3>
      ${slotFormHtml(m, s, roles)}
      ${slotId ? `<label class="text-sm text-gray-600 block mt-3">日付<input id="slot-date" type="date" class="inp" value="${s.work_date}"></label>
        <p class="text-[11px] text-gray-400 mt-1">日付・時間・場所を変えると、割り当て済みのシフトにも反映し、単価を再計算します</p>` :
        `<div class="mt-3"><p class="text-sm text-gray-600 mb-1">日付 *（複数選択できます）</p>
          <div class="flex gap-2"><input id="slot-date-input" type="date" class="inp" value="${s.work_date || BS.from}" onchange="addSlotDate()"><button id="slot-date-add" class="btn btn-outline shrink-0 whitespace-nowrap" onclick="addSlotDate()">日付を追加</button></div>
          <p class="text-[11px] text-gray-400 mt-1">日付を選ぶと追加されます。同じ内容の枠を選んだ日付すべてに作成します</p>
          <div id="slot-dates" class="flex flex-wrap gap-1 mt-2"></div></div>`}
      <div class="flex gap-2 mt-4">
        ${slotId ? `<button class="btn btn-danger" onclick="deleteSlot(${slotId})"><i class="fas fa-trash"></i></button>` : ''}
        <button class="btn btn-primary flex-1" onclick="saveSlot(${slotId || 0})">${slotId ? '保存する' : '作成する'}</button>
      </div>`)
    if (!slotId) { window.__slotDates = new Set([s.work_date || BS.from]); drawSlotDates() }
  }
  function drawSlotDates() {
    const box = document.getElementById('slot-dates'); if (!box) return
    box.innerHTML = [...window.__slotDates].sort().map(d => `<span class="badge badge-blue">${dayjs(d).format('M/D')}(${WD[dayjs(d).day()]})<button class="ml-1" data-d="${d}"><i class="fas fa-xmark"></i></button></span>`).join('')
    box.querySelectorAll('button').forEach(b => b.onclick = () => { window.__slotDates.delete(b.dataset.d); drawSlotDates() })
  }
  window.addSlotDate = function () { const v = document.getElementById('slot-date-input').value; if (v) { window.__slotDates.add(v); drawSlotDates() } }
  function slotBody() {
    const siteId = document.getElementById('slot-site').value
    const site = MASTER.sites.find(x => String(x.site_id) === String(siteId))
    return {
      project_id: Number(document.getElementById('slot-project').value), site_id: siteId ? Number(siteId) : null,
      location: document.getElementById('slot-location').value.trim() || (site ? site.site_name : ''),
      start_time: document.getElementById('slot-start').value, end_time: document.getElementById('slot-end').value,
      break_minutes: document.getElementById('slot-break').value, memo: document.getElementById('slot-memo').value, roles: collectRoles(),
    }
  }
  window.saveSlot = async function (slotId) {
    const b = slotBody()
    try {
      if (slotId) await axios.put('/api/admin/shift-slots/' + slotId, { ...b, work_date: document.getElementById('slot-date').value })
      else {
        if (!window.__slotDates.size) { toast('日付を追加してください'); return }
        await axios.post('/api/admin/shift-slots', { ...b, roles: b.roles.filter(r => !r._delete), dates: [...window.__slotDates] })
      }
      closeModal(); toast(slotId ? '枠を保存しました' : '枠を作成しました'); renderShiftBoard()
    } catch (e) { toast(errMsg(e)) }
  }
  window.deleteSlot = async function (slotId, force) {
    if (!force && !confirm('この枠を削除しますか？')) return
    try { await axios.delete('/api/admin/shift-slots/' + slotId + (force ? '?force=1' : '')); closeModal(); toast('枠を削除しました'); renderShiftBoard() } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) { if (confirm(`この枠には ${d.assigned} 件のシフトがあります。\n枠だけを削除し、シフトは「枠なし」として残しますか？`)) return deleteSlot(slotId, true); return }
      toast(errMsg(e))
    }
  }

  // ---------- 繰り返し登録 ----------
  window.openPatternModal = async function (preset) {
    const m = await loadMaster()
    const s = { ...(preset || {}) }
    if (!s.project_id && BS.projectIds.length === 1) s.project_id = BS.projectIds[0]
    modal(`
      <h3 class="font-bold text-lg mb-1">繰り返し登録</h3>
      <p class="text-xs text-gray-500 mb-3">例: 毎週土日・10:00〜19:00・販売3名＋リーダー1名・10月〜12月。作成後は日ごとに変更・削除できます</p>
      ${slotFormHtml(m, s, [{ role_name: '販売', headcount: 3 }, { role_name: 'リーダー', headcount: 1 }])}
      <div class="mt-3"><p class="text-sm text-gray-600 mb-1">曜日 *</p>
        <div class="flex gap-1">${WD.map((w, i) => `<label class="flex-1 text-center border rounded-lg py-1.5 text-sm cursor-pointer has-[:checked]:bg-blue-600 has-[:checked]:text-white"><input type="checkbox" class="hidden pt-wd" value="${i}" ${[0, 6].includes(i) ? 'checked' : ''}>${w}</label>`).join('')}</div></div>
      <div class="grid grid-cols-2 gap-3 mt-3">
        <label class="text-sm text-gray-600">開始日<input id="pt-from" type="date" class="inp" value="${BS.from}"></label>
        <label class="text-sm text-gray-600">終了日<input id="pt-to" type="date" class="inp" value="${dayjs(BS.from).add(2, 'month').endOf('month').format('YYYY-MM-DD')}"></label>
      </div>
      <button class="btn btn-primary w-full mt-4" onclick="savePattern()">枠をまとめて作成</button>`)
  }
  window.savePattern = async function () {
    const b = slotBody()
    const weekdays = [...document.querySelectorAll('.pt-wd:checked')].map(el => Number(el.value))
    try {
      const { data } = await axios.post('/api/admin/slot-patterns', { ...b, roles: b.roles.filter(r => !r._delete), weekdays, date_from: document.getElementById('pt-from').value, date_to: document.getElementById('pt-to').value })
      closeModal(); toast(`${data.slots}件の枠を作成しました`); renderShiftBoard()
    } catch (e) { toast(errMsg(e)) }
  }

  // ---------- 常勤の一括登録 ----------
  window.openBulkModal = async function () {
    const m = await loadMaster()
    modal(`
      <h3 class="font-bold text-lg mb-1">常勤の一括登録</h3>
      <p class="text-xs text-gray-500 mb-3">スタッフ × 曜日 × 期間でシフトをまとめて登録します（同じ時間帯に別のシフトがある日はスキップ）</p>
      <div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">案件 *<select id="bk-project" class="inp">${m.projects.filter(p => p.status === 'active').map(p => `<option value="${p.project_id}">${p.engagement_type === 'spot' ? '[スポット] ' : '[常勤] '}${esc(p.project_name)}</option>`).join('')}</select></label>
          <label class="text-sm text-gray-600">役割<input id="bk-role" class="inp" value="販売スタッフ" list="role-suggest"></label>
        </div>
        <div><p class="text-sm text-gray-600 mb-1">スタッフ *</p>
          <div class="max-h-40 overflow-y-auto border border-gray-100 rounded-lg p-2 grid grid-cols-2 gap-1">${m.staff.map(s => `<label class="text-xs flex items-center gap-1"><input type="checkbox" class="bk-staff" value="${s.staff_id}">${esc(s.name)}</label>`).join('')}</div></div>
        <div class="flex gap-1">${WD.map((w, i) => `<label class="flex-1 text-center border rounded-lg py-1.5 text-sm cursor-pointer has-[:checked]:bg-blue-600 has-[:checked]:text-white"><input type="checkbox" class="hidden bk-wd" value="${i}" ${i >= 1 && i <= 5 ? 'checked' : ''}>${w}</label>`).join('')}</div>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">開始日<input id="bk-from" type="date" class="inp" value="${BS.from}"></label>
          <label class="text-sm text-gray-600">終了日<input id="bk-to" type="date" class="inp" value="${dayjs(BS.from).endOf('month').format('YYYY-MM-DD')}"></label>
          <label class="text-sm text-gray-600">開始<input id="bk-start" type="time" class="inp" value="09:30"></label>
          <label class="text-sm text-gray-600">終了<input id="bk-end" type="time" class="inp" value="19:00"></label>
          <label class="text-sm text-gray-600">交通費の実費<input id="bk-fee" type="number" class="inp" value="0"></label>
        </div>
        <datalist id="role-suggest"><option value="販売スタッフ"><option value="リーダー"></datalist>
        <button class="btn btn-primary w-full" onclick="saveBulk()">登録する</button>
      </div>`)
  }
  window.saveBulk = async function () {
    const v = (k) => document.getElementById(k).value
    try {
      const { data } = await axios.post('/api/admin/shifts/bulk', {
        project_id: Number(v('bk-project')), role: v('bk-role'), staff_ids: [...document.querySelectorAll('.bk-staff:checked')].map(el => Number(el.value)),
        weekdays: [...document.querySelectorAll('.bk-wd:checked')].map(el => Number(el.value)), date_from: v('bk-from'), date_to: v('bk-to'),
        start_time: v('bk-start'), end_time: v('bk-end'), transportation_fee: v('bk-fee'),
      })
      closeModal(); toast(`${data.created}件登録しました${data.skipped.length ? `（重複のため${data.skipped.length}件スキップ）` : ''}`); renderShiftBoard()
    } catch (e) { toast(errMsg(e)) }
  }

  // ---------- コピー ----------
  window.openCopyModal = function () {
    modal(`
      <h3 class="font-bold text-lg mb-1">枠とシフトをコピー</h3>
      <p class="text-xs text-gray-500 mb-3">表示中の期間（${dayjs(BS.from).format('M/D')}〜${BS.days}日間${BS.projectIds.length ? '・選択中の案件' : '・すべての案件'}）を、指定した日から始まる期間へコピーします</p>
      <label class="text-sm text-gray-600 block">コピー先の開始日<input id="cp-to" type="date" class="inp" value="${dayjs(BS.from).add(BS.days, 'day').format('YYYY-MM-DD')}"></label>
      <label class="flex items-center gap-2 text-sm mt-3"><input type="checkbox" id="cp-assign" checked>割り当て（確定・代打）もコピーする</label>
      <p class="text-[11px] text-gray-400 mt-1">同じ時間帯に別のシフトがあるスタッフはスキップします。希望・欠勤はコピーしません</p>
      <button class="btn btn-primary w-full mt-4" onclick="saveCopy()">コピーする</button>`)
  }
  window.saveCopy = async function () {
    try {
      const { data } = await axios.post('/api/admin/shifts/copy-week', { source_from: BS.from, target_from: document.getElementById('cp-to').value, days: BS.days, project_ids: BS.projectIds.join(','), include_assignments: document.getElementById('cp-assign').checked })
      closeModal(); toast(`枠${data.slots}件・シフト${data.shifts}件をコピーしました${data.skipped.length ? `（${data.skipped.length}件スキップ）` : ''}`)
      renderShiftBoard()
    } catch (e) { toast(errMsg(e)) }
  }

  // =========================================================
  // 案件詳細: 区分・単価・単価ルール・繰り返し登録
  // =========================================================
  function ruleSummary(r) {
    const parts = []
    if (r.bill_rate != null) parts.push(`請求 ${UNIT_LABEL[r.bill_unit_type] || ''}${yen(r.bill_rate)}`)
    if (r.pay_rate != null) parts.push(`支払 ${UNIT_LABEL[r.pay_unit_type] || ''}${yen(r.pay_rate)}`)
    if (r.bill_transport_type) parts.push('交通費請求: ' + BT_LABEL[r.bill_transport_type] + (r.bill_transport_type === 'fixed' ? ' ' + yen(r.bill_transport_amount) : ''))
    if (r.pay_transport_type) parts.push('交通費支払: ' + PT_LABEL[r.pay_transport_type] + (['fixed', 'capped'].includes(r.pay_transport_type) ? ' ' + yen(r.pay_transport_amount) : ''))
    return parts.join(' / ')
  }
  function ruleScope(r) {
    return [r.project_name ? esc(r.project_name) : (r.project_id ? '' : '全案件'), r.site_name ? '📍' + esc(r.site_name) : '', r.role_name ? '役割: ' + esc(r.role_name) : '', r.staff_name ? '👤' + esc(r.staff_name) : ''].filter(Boolean).join(' × ')
  }
  window.renderProjectPricingPanel = async function (p) {
    const host = document.getElementById('project-pricing-panel'); if (!host) return
    const [{ data: rr }, { data: pt }, { data: si }] = await Promise.all([
      axios.get('/api/admin/rate-rules?project_id=' + p.project_id), axios.get('/api/admin/slot-patterns?project_id=' + p.project_id),
      axios.get('/api/admin/sites' + (p.client_id ? '?client_id=' + p.client_id : ''))])
    const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')
    const eng = p.engagement_type || 'regular'
    host.innerHTML = `
      <div class="grid lg:grid-cols-2 gap-4">
        <section class="card p-4" id="project-pricing">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>区分・標準単価<span class="text-[11px] font-normal text-gray-400 ml-1">（管理画面のみ）</span></h3>
            <a class="text-xs text-blue-600 hover:underline" href="#shifts" onclick="window.__boardState.projectIds=[${p.project_id}]">シフトボードで開く</a>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <label class="col-span-2">区分<select id="pp-eng" class="inp text-sm"><option value="regular" ${eng === 'regular' ? 'selected' : ''}>常勤案件</option><option value="spot" ${eng === 'spot' ? 'selected' : ''}>スポット案件（イベント・週末のみ等）</option></select></label>
            <label>請求の単位<select id="pp-bill-unit" class="inp text-sm">${opt(UNIT_LABEL, p.unit_price_type === 'hourly' ? 'hourly' : 'daily')}</select></label>
            <label>請求単価<input id="pp-bill" type="number" class="inp text-sm" value="${p.unit_price ?? 0}"></label>
            <label>支払の単位<select id="pp-pay-unit" class="inp text-sm">${opt(UNIT_LABEL, p.pay_unit_type || 'daily')}</select></label>
            <label>支払単価<input id="pp-pay" type="number" class="inp text-sm" value="${p.pay_rate ?? ''}" placeholder="未設定"></label>
            <label>交通費の請求<select id="pp-bt" class="inp text-sm">${opt(BT_LABEL, p.bill_transport_type || 'actual')}</select></label>
            <label>定額の場合の金額<input id="pp-bt-amt" type="number" class="inp text-sm" value="${p.bill_transport_amount || 0}"></label>
            <label>交通費の支払<select id="pp-pt" class="inp text-sm">${opt(PT_LABEL, p.pay_transport_type || 'actual')}</select></label>
            <label>上限 / 定額の金額<input id="pp-pt-amt" type="number" class="inp text-sm" value="${p.pay_transport_amount || 0}"></label>
            <label>休憩（時給計算用・分）<input id="pp-break" type="number" class="inp text-sm" value="${p.default_break_minutes ?? 60}"></label>
            <label>時給の時間の数え方<select id="pp-hours-basis" class="inp text-sm">${opt({ clipped: '実働（予定の範囲内）', actual: '実働どおり', scheduled: '予定どおり' }, p.hours_basis || 'clipped')}</select></label>
            <label>時刻の丸め<select id="pp-round" class="inp text-sm">${opt({ 0: '丸めない', 5: '5分', 10: '10分', 15: '15分', 30: '30分' }, String(p.time_round_minutes || 0))}</select></label>
          </div>
          <p class="text-[11px] text-gray-400 mt-1">時給は入店・退店の実績から計算します。「予定の範囲内」は早く来た・遅く残った分を含めません。丸めは開始を切り上げ、終了を切り捨てます</p>
          <button class="btn btn-primary w-full mt-3 text-sm" onclick="saveProjectPricing(${p.project_id})">保存する</button>
          <p class="text-[11px] text-gray-400 mt-2">保存しても、登録済みのシフトの金額は変わりません。変更を反映するには「単価ルールを再適用」を使ってください</p>
          <button class="btn btn-outline w-full mt-2 text-xs" onclick="repriceProject(${p.project_id})"><i class="fas fa-rotate"></i>今後のシフトに単価ルールを再適用</button>
        </section>

        <section class="card p-4" id="project-rate-rules">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-list-check text-blue-500 mr-1"></i>単価ルール（開催場所・役割・スタッフ別）</h3>
            <button class="btn btn-outline text-xs" onclick="openRuleModal({project_id:${p.project_id}, client_id:${p.client_id || 'null'}})"><i class="fas fa-plus"></i>追加</button>
          </div>
          <p class="text-[11px] text-gray-400 mb-2">優先順: スタッフ ＞ 役割 ＞ 開催場所 ＞ 案件の標準。項目ごとに最も具体的なルールを使います</p>
          <div class="space-y-1.5 max-h-72 overflow-y-auto">
            ${rr.rules.map(r => `<div class="flex items-start gap-2 p-2 rounded-lg bg-gray-50 text-xs">
              <div class="flex-1 min-w-0"><p class="font-bold">${ruleScope(r)}</p><p class="text-gray-600">${ruleSummary(r)}</p></div>
              <button class="text-gray-400 hover:text-red-500" onclick="deleteRule(${r.rule_id}, ${p.project_id})"><i class="fas fa-trash"></i></button></div>`).join('') || '<p class="text-xs text-gray-400">ルールはありません（案件の標準単価を使います）</p>'}
          </div>
        </section>

        <section class="card p-4 lg:col-span-2" id="project-report-settings"></section>
        <section class="card p-4 lg:col-span-2" id="project-patterns">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-repeat text-blue-500 mr-1"></i>繰り返し登録</h3>
            <button class="btn btn-outline text-xs" onclick="openPatternModal({project_id:${p.project_id}})"><i class="fas fa-plus"></i>追加</button>
          </div>
          <div class="overflow-x-auto"><table class="tbl"><thead><tr><th>曜日</th><th>期間</th><th>時間</th><th>開催場所</th><th>役割</th><th>枠</th><th></th></tr></thead><tbody>
            ${pt.patterns.map(x => `<tr><td>${x.weekdays.split(',').map(i => WD[i]).join('・')}</td><td>${x.date_from}〜${x.date_to}</td><td>${x.start_time}〜${x.end_time}</td>
              <td>${esc(x.site_name || x.location || '-')}</td><td>${x.roles.map(r => esc(r.role_name) + r.headcount + '名').join('・')}</td><td>${x.slot_count}件</td>
              <td><button class="text-xs text-red-600 hover:underline" onclick="deletePattern(${x.pattern_id}, ${p.project_id})">削除</button></td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400">繰り返し登録はありません</td></tr>'}
          </tbody></table></div>
        </section>
      </div>`
    window.__projectForPanel = p
    // 勤怠・日報の提出設定（案件の初期値。public/static/staff-lifecycle.js）
    if (window.renderProjectReportSettings) renderProjectReportSettings(p)
  }
  window.saveProjectPricing = async function (pid) {
    const v = (k) => document.getElementById(k).value
    try {
      await axios.put(`/api/admin/projects/${pid}/pricing`, {
        engagement_type: v('pp-eng'), unit_price_type: v('pp-bill-unit'), unit_price: v('pp-bill'), pay_unit_type: v('pp-pay-unit'), pay_rate: v('pp-pay'),
        bill_transport_type: v('pp-bt'), bill_transport_amount: v('pp-bt-amt'), pay_transport_type: v('pp-pt'), pay_transport_amount: v('pp-pt-amt'), default_break_minutes: v('pp-break'),
        hours_basis: v('pp-hours-basis'), time_round_minutes: v('pp-round'),
      })
      invalidateMaster(); toast('保存しました'); renderProjectDetail(pid)
    } catch (e) { toast(errMsg(e)) }
  }
  window.repriceProject = async function (pid, staffId) {
    const from = dayjs().format('YYYY-MM-DD'), to = dayjs().add(1, 'year').format('YYYY-MM-DD')
    const body = { from, to, ...(pid ? { project_id: pid } : {}), ...(staffId ? { staff_id: staffId } : {}) }
    const { data } = await axios.post('/api/admin/shifts/reprice', { ...body, dry_run: true })
    if (!data.count) { toast('対象のシフトはありません'); return }
    if (!confirm(`今日以降の ${data.count} 件のシフトに、現在の単価ルールを適用します（金額を手動で変更したシフトは除きます）。よろしいですか？`)) return
    const r = await axios.post('/api/admin/shifts/reprice', body)
    toast(`${r.data.count}件のシフトを再計算しました`)
  }
  window.deletePattern = async function (id, pid) {
    const future = confirm('この繰り返し登録を削除します。\n\n[OK] 今日以降の、割り当てのない枠も削除する\n[キャンセル] 次の確認へ')
    if (!future && !confirm('作成済みの枠は残し、繰り返し登録だけを削除しますか？')) return
    try { const { data } = await axios.delete(`/api/admin/slot-patterns/${id}?remove_future=${future ? 1 : 0}&today=${dayjs().format('YYYY-MM-DD')}`); toast(`削除しました${data.removed ? `（枠${data.removed}件を削除）` : ''}`); renderProjectDetail(pid) } catch (e) { toast(errMsg(e)) }
  }

  // ---------- 単価ルールの追加 ----------
  window.openRuleModal = async function (ctx) {
    const m = await loadMaster()
    const sites = m.sites.filter(s => s.status !== 'inactive' && (!ctx.client_id || !s.client_id || String(s.client_id) === String(ctx.client_id)))
    const opt = (map) => `<option value="">（変更しない）</option>` + Object.entries(map).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')
    modal(`
      <h3 class="font-bold text-lg mb-1">単価ルールを追加</h3>
      <p class="text-xs text-gray-500 mb-3">条件に合うシフトで、入力した項目だけを上書きします（空欄の項目は上書きしません）</p>
      <div class="grid grid-cols-2 gap-2 text-xs">
        ${ctx.staff_id ? `<label class="col-span-2">案件<select id="rl-project" class="inp text-sm"><option value="">すべての案件</option>${m.projects.map(p => `<option value="${p.project_id}">${esc(p.project_name)}</option>`).join('')}</select></label>` : ''}
        ${ctx.project_id ? `<label>開催場所<select id="rl-site" class="inp text-sm"><option value="">すべて</option>${sites.map(s => `<option value="${s.site_id}">${esc(s.site_name)}</option>`).join('')}</select></label>
        <label>役割<input id="rl-role" class="inp text-sm" placeholder="すべて" list="role-suggest"></label>
        <label class="col-span-2">スタッフ<select id="rl-staff" class="inp text-sm"><option value="">すべて</option>${m.staff.map(s => `<option value="${s.staff_id}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        <label>請求の単位<select id="rl-bill-unit" class="inp text-sm"><option value="daily">日額</option><option value="hourly">時給</option></select></label>
        <label>請求単価<input id="rl-bill" type="number" class="inp text-sm" placeholder="変更しない"></label>
        <label>支払の単位<select id="rl-pay-unit" class="inp text-sm"><option value="daily">日額</option><option value="hourly">時給</option></select></label>
        <label>支払単価<input id="rl-pay" type="number" class="inp text-sm" placeholder="変更しない"></label>
        <label>交通費の請求<select id="rl-bt" class="inp text-sm">${opt(BT_LABEL)}</select></label>
        <label>定額の金額<input id="rl-bt-amt" type="number" class="inp text-sm"></label>
        <label>交通費の支払<select id="rl-pt" class="inp text-sm">${opt(PT_LABEL)}</select></label>
        <label>上限 / 定額の金額<input id="rl-pt-amt" type="number" class="inp text-sm"></label>
        <label class="col-span-2">メモ<input id="rl-memo" class="inp text-sm" placeholder="例: 経験者加算"></label>
      </div>
      <datalist id="role-suggest"><option value="販売"><option value="リーダー"><option value="MC"><option value="設営"></datalist>
      <button class="btn btn-primary w-full mt-4" onclick='saveRule(${JSON.stringify(ctx)})'>追加する</button>`)
  }
  window.saveRule = async function (ctx) {
    const v = (k) => { const el = document.getElementById(k); return el ? el.value : '' }
    const body = {
      project_id: ctx.project_id || (v('rl-project') ? Number(v('rl-project')) : null), site_id: v('rl-site') ? Number(v('rl-site')) : null,
      role_name: v('rl-role'), staff_id: ctx.staff_id || (v('rl-staff') ? Number(v('rl-staff')) : null),
      bill_unit_type: v('rl-bill-unit'), bill_rate: v('rl-bill'), pay_unit_type: v('rl-pay-unit'), pay_rate: v('rl-pay'),
      bill_transport_type: v('rl-bt') || null, bill_transport_amount: v('rl-bt-amt'), pay_transport_type: v('rl-pt') || null, pay_transport_amount: v('rl-pt-amt'), memo: v('rl-memo'),
    }
    try {
      await axios.post('/api/admin/rate-rules', body); closeModal(); toast('単価ルールを追加しました')
      if (ctx.staff_id) renderStaffRatePanel(ctx.staff_id); else renderProjectDetail(ctx.project_id)
    } catch (e) { toast(errMsg(e)) }
  }
  window.deleteRule = async function (id, pid, sid) {
    if (!confirm('この単価ルールを削除しますか？（登録済みのシフトの金額は変わりません）')) return
    try { await axios.delete('/api/admin/rate-rules/' + id); toast('削除しました'); if (sid) renderStaffRatePanel(sid); else renderProjectDetail(pid) } catch (e) { toast(errMsg(e)) }
  }

  // =========================================================
  // スタッフ詳細: スタッフ別の単価ルール
  // =========================================================
  window.renderStaffRatePanel = async function (sid, p) {
    const host = document.getElementById('staff-rate-panel'); if (!host) return
    if (p && p.affiliation_type === 'skillsheet_only') { host.innerHTML = ''; return }
    const { data } = await axios.get('/api/admin/rate-rules?staff_id=' + sid)
    host.innerHTML = `<section class="card p-4" id="staff-rate-rules">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>スタッフ別の単価<span class="text-[11px] font-normal text-gray-400 ml-1">（管理画面のみ・経験者加算など）</span></h3>
        <div class="flex gap-2">
          <button class="btn btn-outline text-xs" onclick="repriceProject(null, ${sid})"><i class="fas fa-rotate"></i>今後のシフトに再適用</button>
          <button class="btn btn-outline text-xs" onclick="openRuleModal({staff_id:${sid}})"><i class="fas fa-plus"></i>追加</button>
        </div>
      </div>
      <div class="space-y-1.5">${data.rules.map(r => `<div class="flex items-start gap-2 p-2 rounded-lg bg-gray-50 text-xs">
        <div class="flex-1 min-w-0"><p class="font-bold">${ruleScope(r)}</p><p class="text-gray-600">${ruleSummary(r)}${r.memo ? `<span class="text-gray-400 ml-1">（${esc(r.memo)}）</span>` : ''}</p></div>
        <button class="text-gray-400 hover:text-red-500" onclick="deleteRule(${r.rule_id}, null, ${sid})"><i class="fas fa-trash"></i></button></div>`).join('') || '<p class="text-xs text-gray-400">スタッフ別の単価はありません（案件・枠の単価を使います）</p>'}</div>
    </section>`
  }

  // =========================================================
  // クライアント詳細: 開催場所
  // =========================================================
  window.renderClientSitesPanel = async function (cid) {
    const host = document.getElementById('client-sites-panel'); if (!host) return
    const { data } = await axios.get('/api/admin/sites?client_id=' + cid)
    host.innerHTML = `<section class="card p-4" id="client-sites">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-location-dot text-blue-500 mr-1"></i>開催場所<span class="text-[11px] font-normal text-gray-400 ml-1">（シフト枠・単価ルールで選択できます）</span></h3>
      </div>
      <div class="flex gap-2 mb-3"><input id="site-new-name" class="inp text-sm" placeholder="開催場所名（例: ○○店 1F 催事場）"><input id="site-new-addr" class="inp text-sm" placeholder="住所（任意）">
        <button class="btn btn-primary text-sm shrink-0" onclick="addSite(${cid})"><i class="fas fa-plus"></i>追加</button></div>
      <div class="overflow-x-auto"><table class="tbl"><thead><tr><th>開催場所</th><th>住所</th><th>シフト</th><th>状態</th><th></th></tr></thead><tbody>
        ${data.sites.map(s => `<tr><td class="font-bold">${esc(s.site_name)}</td><td class="text-xs text-gray-500">${esc(s.address || '-')}</td><td>${s.shift_count}件</td>
          <td>${s.status === 'inactive' ? '<span class="badge badge-gray">無効</span>' : '<span class="badge badge-green">有効</span>'}</td>
          <td class="text-right whitespace-nowrap"><button class="text-xs text-blue-600 hover:underline mr-2" onclick="renameSite(${s.site_id}, ${cid}, '${esc(s.site_name).replace(/'/g, '&#39;')}')">名前を変更</button>
            ${s.status === 'inactive' ? `<button class="text-xs text-blue-600 hover:underline" onclick="toggleSite(${s.site_id}, ${cid}, 'active')">有効にする</button>` : `<button class="text-xs text-red-600 hover:underline" onclick="removeSite(${s.site_id}, ${cid})">削除</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400">開催場所はありません</td></tr>'}
      </tbody></table></div>
    </section>`
  }
  window.addSite = async function (cid) {
    const name = document.getElementById('site-new-name').value.trim()
    if (!name) { toast('開催場所名を入力してください'); return }
    try { await axios.post('/api/admin/sites', { client_id: cid, site_name: name, address: document.getElementById('site-new-addr').value }); invalidateMaster(); toast('追加しました'); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
  window.renameSite = async function (id, cid, name) {
    const v = prompt('開催場所名', name); if (!v) return
    try { await axios.put('/api/admin/sites/' + id, { site_name: v }); invalidateMaster(); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
  window.toggleSite = async function (id, cid, status) {
    try { await axios.put('/api/admin/sites/' + id, { status }); invalidateMaster(); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
  window.removeSite = async function (id, cid) {
    if (!confirm('この開催場所を削除しますか？（シフトで使用中の場合は「無効」にします）')) return
    try { const { data } = await axios.delete('/api/admin/sites/' + id); invalidateMaster(); toast(data.deactivated ? '使用中のため無効にしました' : '削除しました'); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
})()
