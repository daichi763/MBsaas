// =========================================================
// シフトボード（常勤・スポット）/ 募集枠 / 単価（請求・支払）
// docs/spec_spot_shift.md 第1段階。admin.js の後に読み込む（esc / yen / toast / modal / closeModal / loading / $app を利用）
// =========================================================
(function () {
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const ST_LABEL = { requested: '希望（仮）', confirmed: '確定', absent: '欠勤', substitute: '代打' }
  const UNIT_LABEL = { daily: '日額', hourly: '時給' }
  const BT_LABEL = { actual: '実費を請求', fixed: '定額を請求', included: '単価に込み（請求なし）' }
  const PT_LABEL = { actual: '実費を支払', capped: '実費（上限あり）', fixed: '定額を支払', none: '支払なし' }
  const AFF_SHORT = { own_employee: '自社', linked_external: '他社', partner_manual: '取引先', skillsheet_only: 'シート' }
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const d0 = (d) => dayjs(d).format('YYYY-MM-DD')

  // その日を含む週の月曜日（ボードの週は月曜始まり。日曜は前の月曜からの週に入れる #528）
  function weekStart(d) { const x = dayjs(d); return x.subtract((x.day() + 6) % 7, 'day').format('YYYY-MM-DD') }
  window.boardWeekStart = weekStart

  // ボードの表示状態（画面遷移しても保持）
  const BS = window.__boardState = window.__boardState || {
    from: weekStart(dayjs()), days: 7, clientId: '', projectIds: [], engagement: '',
    view: 'slot', onlyShort: false, showMoney: true,
  }
  let BOARD = null, MASTER = null, MASTER_AT = 0

  // 案件・クライアント・開催場所・スタッフの選択肢。登録・変更の後（下の axios の処理）と、一定時間ごとに取り直す（#529）
  const MASTER_TTL_MS = 5 * 60 * 1000
  async function loadMaster() {
    if (MASTER && Date.now() - MASTER_AT < MASTER_TTL_MS) return MASTER
    const [{ data: pj }, { data: cl }, { data: si }, { data: st }] = await Promise.all([
      axios.get('/api/admin/projects'), axios.get('/api/admin/clients'), axios.get('/api/admin/sites?counts=0'), axios.get('/api/admin/staff/options')])
    // 割り当てられる人だけを出す（退職・停止・統合・スキルシートのみ・取引終了・所属元で退職は assignable=0）。スタッフは選択肢用の軽いAPI（#463）
    MASTER = { projects: pj.projects, clients: cl.clients, sites: si.sites, staff: st.staff.filter(s => s.affiliation_type !== 'skillsheet_only' && !s.merged_into_staff_id && s.assignable !== 0) }
    MASTER_AT = Date.now()
    return MASTER
  }
  function invalidateMaster() { MASTER = null }
  window.invalidateBoardMaster = invalidateMaster
  // 案件・クライアント・開催場所・スタッフ（連携・統合・従業員管理を含む）を登録・変更・削除したら、選択肢を取り直す。
  // 画面ごとに呼び忘れないよう、成功した書き込みの URL で判定する（管理画面のどこから登録しても反映される）
  const MASTER_WRITE_URL = /^\/api\/admin\/(projects|clients|sites|staff|staff-quick|employees|roster)(\/|\?|$)/
  if (window.axios && axios.interceptors) axios.interceptors.response.use((res) => {
    const cfg = res && res.config
    if (cfg && cfg.method && cfg.method.toLowerCase() !== 'get' && MASTER_WRITE_URL.test(String(cfg.url || ''))) invalidateMaster()
    return res
  })
  window.boardReloadMaster = function () { invalidateMaster(); renderShiftBoard() }

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
          <button class="btn btn-outline" data-action="openShiftRequests"><i class="fas fa-hand"></i>シフト希望<span id="board-req-count"></span></button>
          <a class="btn btn-outline" href="#shifts/week"><i class="fas fa-table-columns"></i>週表示（従来）</a>
          <button class="btn btn-outline" onclick="boardReloadMaster()" title="案件・スタッフ・開催場所の一覧を読み直します"><i class="fas fa-rotate"></i>一覧を更新</button>
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
        <div class="card p-3"><p class="text-xs text-gray-500">粗利</p><p class="text-lg font-bold ${t.profit < 0 ? 'text-red-600' : 'text-emerald-700'}">${yen(t.profit)}</p>${t.pay_missing ? `<p class="text-[10px] text-amber-600" title="支払単価が未設定のシフトは粗利に含めていません">支払未設定 ${Number(t.pay_missing)}件・請求 ${yen(t.pay_missing_bill)} を除外</p>` : ''}</div>
        <div class="card p-3"><p class="text-xs text-gray-500">粗利率</p><p class="text-lg font-bold">${t.profit_bill ? Math.round(t.profit / t.profit_bill * 1000) / 10 + '%' : '-'}</p>${t.pay_missing ? '<p class="text-[10px] text-gray-400">支払が決まっているシフトだけで計算</p>' : ''}</div>
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
              <span class="truncate">${esc(s.name)}</span>${s.employment_status === 'leave' ? '<span class="text-[10px] text-amber-600">休職中</span>' : s.employment_status === 'preboarding' ? '<span class="text-[10px] text-amber-600">入社予定</span>' : ''}<span class="text-[10px] text-gray-400">${AFF_SHORT[s.affiliation_type] || ''}</span></div>`).join('')}
          </div>
        </aside>
      </div>`
    enableDnD()
    loadRequestCount()
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
        <button class="hover:underline" onclick="openSlotModal({work_date:'${d}'})" title="この日に枠を作成">${dayjs(d).format('M/D')}(${WD[w]})</button>${daySummary(d)}</th>` }).join('')}
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

  // 列の見出しの下に出す、その日の充足（#566）。不足のある日は赤くし、押すとその日の不足の枠を一覧で開く
  function daySummary(d) {
    const x = (BOARD.totals.by_date || {})[d]
    if (!x || !x.required) return ''
    const short = x.required - x.filled
    return short > 0
      ? `<button class="block w-full text-[10px] font-bold text-red-600 bg-red-50 rounded mt-0.5 hover:underline" data-action="boardDayShort" data-date="${esc(d)}" title="この日の不足の枠を表示">${Number(x.filled)}/${Number(x.required)} 不足${short}</button>`
      : `<span class="block text-[10px] font-normal text-emerald-700 mt-0.5">${Number(x.filled)}/${Number(x.required)} 充足</span>`
  }
  function openDayShort(d) {
    const rows = []
    for (const s of BOARD.slots) if (s.work_date === d) for (const r of s.roles) if (r.filled < r.headcount) rows.push({ s, r })
    const proj = new Map(BOARD.projects.map(p => [p.project_id, p]))
    rows.sort((a, b) => String(a.s.start_time).localeCompare(b.s.start_time))
    modal(`
      <h3 class="font-bold text-lg mb-1">${dayjs(d).format('M/D')}(${WD[dayjs(d).day()]}) の不足</h3>
      <p class="text-xs text-gray-500 mb-2">必要人数に足りない枠です（表示中の絞り込みの範囲）。「候補」から割り当てられます</p>
      <div class="max-h-[60vh] overflow-y-auto divide-y divide-gray-100">
        ${rows.map(({ s, r }) => `<div class="flex items-center gap-2 py-2 text-sm">
          <div class="flex-1 min-w-0"><p class="font-bold truncate">${esc((proj.get(s.project_id) || {}).project_name || '')}</p>
            <p class="text-xs text-gray-500">${esc(s.start_time)}〜${esc(s.end_time)}・${esc(s.site_name || s.location || '')}・${esc(r.role_name)}</p></div>
          <span class="text-xs font-bold text-red-600 whitespace-nowrap">${Number(r.filled)}/${Number(r.headcount)}${r.requested ? `<span class="text-amber-600 ml-1">希望${Number(r.requested)}</span>` : ''}</span>
          <button class="btn btn-outline text-xs" data-action="bulkSkipCandidates" data-id="${Number(r.slot_role_id)}">候補</button></div>`).join('') || '<p class="p-3 text-sm text-gray-400">不足の枠はありません</p>'}
      </div>`)
  }
  delegate('boardDayShort', el => openDayShort(el.dataset.date))

  function slotCell(slot, role) {
    const short = role.filled < role.headcount
    const over = role.filled > role.headcount
    const money = BS.showMoney ? role.assigned.filter(a => ['confirmed', 'substitute'].includes(a.status)).reduce((x, a) => x + (a.bill_total || 0), 0) : 0
    // 『不足のみ』では、同じ行の不足していない日のセルを薄く出す
    return `<div class="board-cell ${short ? 'board-short' : over ? 'board-over' : 'board-ok'} ${BS.onlyShort && !short ? 'opacity-40' : ''}" data-slot-role-id="${role.slot_role_id}">
      <div class="flex items-center justify-between gap-1 mb-1">
        <button class="text-[11px] font-bold ${short ? 'text-red-600' : 'text-emerald-700'}" onclick="openSlotModal(null, ${slot.slot_id})" title="枠を編集">${role.filled}/${role.headcount}${role.requested ? `<span class="text-amber-600 ml-1">希望${role.requested}</span>` : ''}</button>${role.applicants ? `<a href="#recruit/slot-${Number(role.slot_role_id)}" class="text-[10px] ml-1 px-1 rounded bg-red-100 text-red-700" title="この枠の未対応の応募を開く">応募${role.applicants}</a>` : ''}
        <span class="flex items-center gap-1">
          ${BS.showMoney && money ? `<span class="text-[10px] text-gray-400">${yen(money)}</span>` : ''}
          <button class="board-add" onclick="openCandidates(${role.slot_role_id})" title="候補から割り当て"><i class="fas fa-plus"></i></button>
        </span>
      </div>
      <div class="board-drop space-y-0.5" data-slot-role-id="${role.slot_role_id}">${role.assigned.map(a => staffChip(a)).join('')}</div>
    </div>`
  }

  // 重複の表示。他社のシフトは会社名・案件名を出さず「他社の予定あり」と時間帯だけにする（呼び出し側で esc する）
  function conflictText(x) {
    return (x.other_company ? '他社の予定あり' : (x.project_name || '自社のシフト')) + ' ' + (x.start_time || '') + '〜' + (x.end_time || '')
  }

  // 退職などで稼働日に働けない人のシフト（#500。充足には数えない）
  function unavailableMark(a) {
    return a.unavailable && a.status !== 'absent' ? `<span class="badge badge-red ml-0.5" title="${esc(a.unavailable)}のため、この日は稼働できません。シフトを外すか代わりの人を入れてください">${esc(a.unavailable)}</span>` : ''
  }
  function staffChip(a) {
    const warn = (a.conflicts && a.conflicts.length) || a.ng || (a.unavailable && a.status !== 'absent')
    const title = [
      a.unavailable && a.status !== 'absent' ? a.unavailable + 'のため、この日は稼働できません（充足に数えていません）' : '',
      a.conflicts && a.conflicts.length ? '重複: ' + a.conflicts.map(conflictText).join(' / ') : '',
      a.ng ? 'NGスタッフに指定されています' : '',
      replyText(a),
      BS.showMoney ? `請求 ${yen(a.bill_total)} / 支払 ${a.pay_total == null ? '未設定' : yen(a.pay_total)}` : '',
    ].filter(Boolean).join('\n')
    return `<div class="board-chip shift-chip st-${a.status} ${warn ? 'chip-warn' : ''}" data-shift-id="${a.shift_id}" title="${esc(title)}" onclick="openShiftDetail(${a.shift_id})">
      <span class="truncate">${warn ? '<i class="fas fa-triangle-exclamation text-red-500 mr-0.5"></i>' : ''}${esc(a.staff_name)}</span>
      <span class="text-[10px] shrink-0">${unavailableMark(a)}${a.status !== 'confirmed' ? ST_LABEL[a.status] || '' : ''}${replyMark(a)}${a.price_locked ? '<i class="fas fa-pen text-gray-400 ml-0.5" title="金額を手動変更"></i>' : ''}${BS.showMoney && a.pay_total == null && ['confirmed', 'substitute'].includes(a.status) ? '<i class="fas fa-yen-sign text-amber-500 ml-0.5" title="支払単価未設定"></i>' : ''}</span>
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
      ${days.map(d => { const w = dayjs(d).day(); return `<th class="board-th ${d === today ? 'bg-blue-50' : ''} ${w === 0 ? 'text-red-500' : w === 6 ? 'text-blue-500' : ''}" style="min-width:${BS.days > 14 ? 86 : 118}px;max-width:${BS.days > 14 ? 86 : 118}px;width:${BS.days > 14 ? 86 : 118}px">${dayjs(d).format('M/D')}(${WD[w]})${daySummary(d)}</th>` }).join('')}
    </tr></thead><tbody>${rows.map(([sid, r]) => {
      const n = Object.values(r.cells).flat().filter(a => ['confirmed', 'substitute'].includes(a.status)).length
      return `<tr><td class="board-rowhead sticky left-0 bg-white z-10"><a href="#staff/${sid}" class="text-xs font-bold hover:underline">${esc(r.name)}</a> <span class="text-[10px] text-gray-400">${AFF_SHORT[r.aff] || ''}</span></td>
        <td class="board-td text-center text-xs font-bold">${n}日</td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${BS.days > 14 ? 86 : 118}px">${(r.cells[d] || []).map(a => {
          const p = proj.get(a.project_id) || {}
          const warn = (a.conflicts && a.conflicts.length) || a.ng || (a.unavailable && a.status !== 'absent')
          return `<div class="board-chip st-${a.status} ${warn ? 'chip-warn' : ''} flex-col items-start" onclick="openShiftDetail(${a.shift_id})" title="${esc(p.project_name + ' / ' + (a._site || ''))}">
            <span class="truncate w-full text-[11px] font-bold">${warn ? '<i class="fas fa-triangle-exclamation text-red-500 mr-0.5"></i>' : ''}${unavailableMark(a)}${esc(p.project_name || '')}${replyMark(a)}</span>
            <span class="truncate w-full text-[10px] text-gray-500">${esc(a._site || '')} ${esc(a.start_time)}〜${esc(a.end_time)}</span></div>` }).join('')}</td>`).join('')}</tr>`
    }).join('')}</tbody></table>`
  }

  // ---------- ボード操作 ----------
  window.boardSet = function (k, v) { BS[k] = v; renderShiftBoard() }
  window.boardShift = function (dir) { BS.from = dayjs(BS.from).add(dir * (BS.days >= 28 ? 28 : BS.days), 'day').format('YYYY-MM-DD'); renderShiftBoard() }
  window.boardToday = function () { BS.from = weekStart(dayjs()); renderShiftBoard() }
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
          if (assigning) { toast('処理中です。終わってからもう一度操作してください'); return }
          if (shiftId) await moveShift(Number(shiftId), toRole)
          else if (staffId) await assignStaff(toRole, [Number(staffId)])
        },
      })
    })
  }

  // 割当の送信中（二度押し・ドラッグの連続で同じ人を二重に割り当てないように #530）
  let assigning = false
  async function assignStaff(slotRoleId, staffIds, force, extra) {
    if (assigning && !force) return
    assigning = true
    try {
      return await assignStaffOnce(slotRoleId, staffIds, force, extra)
    } finally { assigning = false }
  }
  async function assignStaffOnce(slotRoleId, staffIds, force, extra) {
    try {
      const { data } = await axios.post(`/api/admin/shift-slots/roles/${slotRoleId}/assign`, { staff_ids: staffIds, force: !!force, ...(extra || {}) })
      toast(data.warnings && data.warnings.length ? '警告を確認のうえ割り当てました' : '割り当てました')
      closeModal(); renderShiftBoard()
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) { if (confirm(d.warnings.join('\n') + '\n\nこのまま割り当てますか？')) return assignStaffOnce(slotRoleId, staffIds, true, extra); return renderShiftBoard() }
      toast(errMsg(e)); renderShiftBoard()
    }
  }
  async function moveShift(shiftId, slotRoleId, force) {
    if (assigning && !force) return
    assigning = true
    try {
      return await moveShiftOnce(shiftId, slotRoleId, force)
    } finally { assigning = false }
  }
  async function moveShiftOnce(shiftId, slotRoleId, force) {
    try {
      await axios.post(`/api/admin/shifts/${shiftId}/move`, { slot_role_id: slotRoleId, force: !!force })
      toast('移動しました（単価は移動先に合わせて再計算）'); renderShiftBoard()
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) { if (confirm(d.warnings.join('\n') + '\n\nこのまま移動しますか？')) return moveShiftOnce(shiftId, slotRoleId, true); return renderShiftBoard() }
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
      <p class="text-xs text-gray-500 mb-3">${dayjs(r.work_date).format('M/D')}(${WD[dayjs(r.work_date).day()]}) ${esc(r.start_time)}〜${esc(r.end_time)}・${esc(r.location || '')}・<b>${esc(r.role_name)}</b>（必要 ${r.headcount}名）</p>
      <input class="inp text-sm mb-2" placeholder="名前・稼働エリアで絞り込み" id="cand-filter">
      <div class="max-h-96 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
        ${data.candidates.map(c => `<label class="cand-row flex items-center gap-2 px-2 py-1.5 text-sm ${c.busy || c.ng ? 'bg-red-50' : ''}" data-key="${esc(c.name + ' ' + (c.work_area || ''))}">
          <input type="checkbox" class="cand-check" value="${c.staff_id}">
          <span class="flex-1 min-w-0"><span class="font-bold">${esc(c.name)}</span> <span class="text-[11px] text-gray-400">${AFF_SHORT[c.affiliation_type] || ''}</span>
            ${c.work_area ? `<span class="text-[11px] text-gray-500 ml-1"><i class="fas fa-location-dot text-gray-400 mr-0.5"></i>${esc(c.work_area)}</span>` : ''}
            <span class="block text-[11px] text-gray-500">
              ${c.busy ? `<span class="text-red-600"><i class="fas fa-clock mr-0.5"></i>${esc(c.busy_detail.join('、'))}</span>` : '<span class="text-emerald-600">空き</span>'}
              ${c.ng ? '<span class="text-red-600 ml-1">NG</span>' : ''}${c.on_leave ? '<span class="text-amber-600 ml-1">休職中</span>' : ''}${c.preboarding ? '<span class="text-amber-600 ml-1">入社予定</span>' : ''}${c.not_yet_available ? `<span class="text-amber-600 ml-1">稼働開始 ${esc(dayjs(c.available_from).format('M/D'))}〜</span>` : ''}
              ・この場所 ${c.site_count}回・この案件 ${c.project_count}回${c.skill_required ? `・スキル ${c.skill_match}/${c.skill_required}` : ''}・今週（月〜日）${c.week_days}日</span></span>
        </label>`).join('') || '<p class="p-3 text-sm text-gray-400">候補がいません</p>'}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-3">
        <select id="cand-status" class="inp text-sm"><option value="confirmed">確定で登録</option><option value="requested">希望（仮）で登録（本人が可否を返事）</option></select>
        <input id="cand-fee" type="number" class="inp text-sm" placeholder="交通費の実費（任意）">
      </div>
      <button class="btn btn-primary w-full mt-3" data-action="assignFromCandidates" data-slot-role-id="${Number(slotRoleId)}">選択したスタッフを割り当て</button>
      <button class="btn btn-outline w-full mt-2 text-sm" data-action="openQuickRegister" data-slot-role-id="${Number(slotRoleId)}"><i class="fas fa-bolt"></i>一覧にいない人を仮登録して割り当て（氏名・電話のみ）</button>`)
    document.getElementById('cand-filter').addEventListener('input', (ev) => {
      const q = ev.target.value.trim()
      document.querySelectorAll('.cand-row').forEach(el => { el.style.display = !q || el.dataset.key.includes(q) ? '' : 'none' })
    })
  }
  window.assignFromCandidates = function (slotRoleId) {
    const ids = [...document.querySelectorAll('.cand-check:checked')].map(el => Number(el.value))
    if (!ids.length) { toast('スタッフを選択してください'); return }
    const fee = document.getElementById('cand-fee').value
    return assignStaff(slotRoleId, ids, false, { status: document.getElementById('cand-status').value, ...(fee !== '' ? { transportation_fee: Number(fee) } : {}) })
  }
  delegate('assignFromCandidates', (el) => withSubmitLock(el, () => assignFromCandidates(Number(el.dataset.slotRoleId))))
  delegate('openQuickRegister', (el) => { if (window.showQuickRegister) showQuickRegister({ slot_role_id: Number(el.dataset.slotRoleId) }) })

  // ---------- シフト詳細（状態・金額） ----------
  // 時給の数量を手動で固定したシフトか（qty_locked。従来の手動変更は数量も固定）。固定していなければ、金額フォームの数量は空欄で開く（#196）
  const qtyFixed = (a) => !!a.price_locked && a.qty_locked !== 0
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
      <p class="text-xs text-gray-500 mb-3">${dayjs(a.work_date).format('M/D')}(${WD[dayjs(a.work_date).day()]}) ${esc(a.start_time)}〜${esc(a.end_time)}・${esc(a.site_name || a.location || '')}・${esc(a.role || '')}
        <span class="badge badge-gray ml-1">${ST_LABEL[a.status]}</span></p>
      ${a.status === 'requested' ? `<p class="text-xs ${a.staff_reply === 'ng' ? 'text-red-600 bg-red-50' : 'text-gray-600 bg-amber-50'} rounded p-2 mb-2">${replyMark(a)} ${esc(replyText(a))}${a.staff_reply_at ? `<span class="text-gray-400 ml-1">${esc(a.staff_reply_at)}</span>` : ''}</p>` : ''}
      ${a.conflicts && a.conflicts.length ? `<p class="text-xs text-red-600 bg-red-50 rounded p-2 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>同じ時間帯に別のシフト: ${esc(a.conflicts.map(conflictText).join(' / '))}</p>` : ''}
      ${a.ng ? '<p class="text-xs text-red-600 bg-red-50 rounded p-2 mb-2">クライアントのNGスタッフに指定されています</p>' : ''}
      ${a.settle_status === 'confirmed' ? '<p class="text-xs text-emerald-700 bg-emerald-50 rounded p-2 mb-2" id="shift-settled-notice"><i class="fas fa-lock mr-1"></i>実績が確定済みのため、状態・時間・金額は変更できません（<a class="underline" href="#settlement">精算</a>で取り消せます）</p>' : ''}
      ${a.actual_start ? `<p class="text-xs text-gray-600 mb-2"><i class="fas fa-clock mr-1"></i>実績 ${esc(a.actual_start)}〜${esc(a.actual_end)}（${a.actual_source === 'manual' ? '手入力' : '報告'}）</p>` : ''}
      <div class="grid grid-cols-4 gap-1.5 mb-4">
        ${['confirmed', 'requested', 'substitute', 'absent'].map(st => `<button class="btn btn-outline text-xs ${a.status === st ? 'ring-2 ring-blue-400' : ''}" data-action="boardShiftStatus" data-id="${id}" data-status="${st}">${ST_LABEL[st]}</button>`).join('')}
      </div>
      <div class="rounded-lg border border-gray-100 p-3 mb-3 text-xs space-y-2" id="shift-price-form">
        <div class="flex items-center justify-between"><p class="font-bold text-gray-700"><i class="fas fa-yen-sign mr-1"></i>金額（管理画面のみ表示）</p>
          ${a.price_locked ? `<button class="text-blue-600 hover:underline" data-action="boardResetPrice" data-id="${id}">単価ルールに戻す</button>` : '<span class="text-gray-400">単価ルールから自動計算</span>'}</div>
        <div class="grid grid-cols-3 gap-2 items-end">
          <label>請求<select id="sp-bill-unit" class="inp text-xs">${opt(UNIT_LABEL, a.bill_unit_type || 'daily')}</select></label>
          <label>請求単価<input id="sp-bill-rate" type="number" class="inp text-xs" value="${a.bill_rate ?? ''}"></label>
          <label>数量<input id="sp-bill-qty" type="number" step="0.25" min="0" max="24" class="inp text-xs" value="${qtyFixed(a) ? (a.bill_qty ?? '') : ''}" placeholder="${a.bill_qty ?? ''}" title="空欄なら計算時間（実績が入れば実働）を使います"></label>
          <label>支払<select id="sp-pay-unit" class="inp text-xs">${opt(UNIT_LABEL, a.pay_unit_type || 'daily')}</select></label>
          <label>支払単価<input id="sp-pay-rate" type="number" class="inp text-xs" value="${a.pay_rate ?? ''}" placeholder="未設定"></label>
          <label>数量<input id="sp-pay-qty" type="number" step="0.25" min="0" max="24" class="inp text-xs" value="${qtyFixed(a) ? (a.pay_qty ?? '') : ''}" placeholder="${a.pay_qty ?? ''}" title="空欄なら計算時間（実績が入れば実働）を使います"></label>
          <label>交通費の実費<input id="sp-fee" type="number" class="inp text-xs" value="${a.transportation_fee ?? 0}"></label>
          <label>交通費の請求<select id="sp-bt" class="inp text-xs">${opt(BT_LABEL, a.bill_transport_type || 'actual')}</select></label>
          <label>請求額（定額時）<input id="sp-bt-amt" type="number" class="inp text-xs" value="${a.bill_transport_amount ?? 0}"></label>
          <label>休憩（分）<input id="sp-break" type="number" class="inp text-xs" value="${a.break_minutes ?? ''}"></label>
          <label>交通費の支払<select id="sp-pt" class="inp text-xs">${opt(PT_LABEL, a.pay_transport_type || 'actual')}</select></label>
          <label>上限/定額<input id="sp-pt-amt" type="number" class="inp text-xs" value="${a.pay_transport_amount ?? 0}"></label>
          <label>請求の調整<input id="sp-bill-adj" type="number" class="inp text-xs" value="${a.bill_adjust || ''}" placeholder="0"></label>
          <label>支払の調整<input id="sp-pay-adj" type="number" class="inp text-xs" value="${a.pay_adjust || ''}" placeholder="0"></label>
          <label>調整の内容<input id="sp-adj-note" class="inp text-xs" value="${esc(a.adjust_note || '')}" placeholder="残業・手当など"></label>
        </div>
        <div class="grid grid-cols-3 gap-2 bg-gray-50 rounded p-2">
          <p>請求 <b>${yen(a.bill_total)}</b><span class="block text-gray-400">基本${yen(a.unit_price)}＋交通費${yen(a.bill_transport)}</span></p>
          <p>支払 <b>${a.pay_total == null ? '未設定' : yen(a.pay_total)}</b><span class="block text-gray-400">基本${a.pay_amount == null ? '-' : yen(a.pay_amount)}＋交通費${yen(a.pay_transport)}</span></p>
          <p>粗利 <b>${a.pay_total == null ? '-' : yen(a.bill_total - a.pay_total)}</b><span class="block text-gray-400">${esc(src.manual || src.bill || '')}${src.pay && !src.manual ? ' / 支払: ' + esc(src.pay) : ''}</span></p>
        </div>
        <button class="btn btn-primary w-full text-xs" data-action="boardSavePrice" data-id="${id}">金額を保存（このシフトだけ手動で変更）</button>
      </div>
      <div id="shift-report-panel" class="mb-3"></div>
      <div class="flex gap-2">
        <a class="btn btn-outline flex-1 text-xs" href="#staff/${a.staff_id}">スタッフ詳細</a>
        <button class="btn btn-danger flex-1 text-xs" data-action="boardDeleteShift" data-id="${id}"><i class="fas fa-trash"></i>シフトを削除</button>
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
  delegate('boardShiftStatus', el => withSubmitLock(el, () => boardShiftStatus(Number(el.dataset.id), el.dataset.status)))
  delegate('boardResetPrice', el => withSubmitLock(el, () => boardResetPrice(Number(el.dataset.id))))
  delegate('boardSavePrice', el => withSubmitLock(el, () => boardSavePrice(Number(el.dataset.id))))
  delegate('boardDeleteShift', el => withSubmitLock(el, () => boardDeleteShift(Number(el.dataset.id))))

  // =========================================================
  // スタッフのシフト希望（#12 #353）
  // 採用・見送りの返事だけを記録する（本人の画面に出る）。シフトは枠への割り当てなど通常の経路で登録する
  // =========================================================
  const REQ_ST = { pending: ['返事待ち', 'badge-yellow'], accepted: ['採用', 'badge-green'], declined: ['見送り', 'badge-gray'], withdrawn: ['本人が取り下げ', 'badge-gray'] }
  let REQ_ALL = false
  function boardRange() { return { from: BS.from, to: dayjs(BS.from).add(BS.days - 1, 'day').format('YYYY-MM-DD') } }
  async function loadRequestCount() {
    const el = document.getElementById('board-req-count'); if (!el) return
    try {
      const { data } = await axios.get('/api/admin/shift-requests?' + new URLSearchParams({ ...boardRange(), status: 'pending' }))
      el.innerHTML = data.pending ? `<span class="badge badge-red ml-1">${Number(data.pending)}</span>` : ''
    } catch (e) { /* 件数の表示のみ */ }
  }
  async function openShiftRequests() {
    const r = boardRange()
    let data
    try { data = (await axios.get('/api/admin/shift-requests?' + new URLSearchParams({ ...r, status: REQ_ALL ? 'all' : 'pending' }))).data }
    catch (e) { toast(errMsg(e)); return }
    const row = (q) => {
      const st = REQ_ST[q.status] || [q.status, 'badge-gray']
      return `<div class="py-2 text-sm" data-request-id="${q.request_id}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p><span class="font-bold">${dayjs(q.work_date).format('M/D')}(${WD[dayjs(q.work_date).day()]}) ${esc(q.start_time)}〜${esc(q.end_time)}</span>
              <a href="#staff/${q.staff_id}" class="ml-1 font-bold text-blue-700 hover:underline">${esc(q.staff_name)}</a></p>
            <p class="text-xs text-gray-500">${q.project_name ? esc(q.project_name) : '案件の指定なし'}${q.memo ? '・' + esc(q.memo) : ''}</p>
            <p class="text-[11px] ${q.shifts_on_date ? 'text-emerald-700' : 'text-gray-400'}">${q.shifts_on_date ? `この日のシフト ${q.shifts_on_date}件あり` : 'この日のシフトはまだありません'}</p>
            ${q.status !== 'pending' && q.response_note ? `<p class="text-[11px] text-gray-500">返事: ${esc(q.response_note)}</p>` : ''}
            ${q.responded_by_name ? `<p class="text-[11px] text-gray-400">${esc(q.responded_by_name)} ${esc(q.responded_at || '')}</p>` : ''}
          </div>
          <span class="badge ${st[1]} shrink-0">${esc(st[0])}</span>
        </div>
        ${q.status === 'pending' ? `<div class="flex gap-2 mt-1.5 items-center">
          <input class="inp text-xs flex-1" maxlength="500" placeholder="本人への返事（任意）" data-note-for="${q.request_id}">
          <button class="btn btn-primary text-xs" data-action="respondShiftRequest" data-id="${q.request_id}" data-decision="accept">採用</button>
          <button class="btn btn-outline text-xs" data-action="respondShiftRequest" data-id="${q.request_id}" data-decision="decline">見送り</button>
        </div>` : ''}
      </div>`
    }
    modal(`
      <h3 class="font-bold text-lg mb-1">シフト希望</h3>
      <p class="text-xs text-gray-500 mb-2">${dayjs(data.from).format('M/D')}〜${dayjs(data.to).format('M/D')}（ボードの表示期間）・返事待ち ${data.pending}件。
        採用・見送りは本人のシフト画面に表示されます。採用したら、枠への割り当てでシフトを登録してください</p>
      <label class="flex items-center gap-1 text-xs mb-2"><input type="checkbox" data-action="toggleShiftRequestsAll" ${REQ_ALL ? 'checked' : ''}>返事済み・取り下げも表示</label>
      <div class="max-h-[60vh] overflow-y-auto divide-y divide-gray-100" id="shift-request-list">
        ${data.requests.map(row).join('') || '<p class="p-3 text-sm text-gray-400">シフト希望はありません</p>'}
      </div>`)
  }
  delegate('openShiftRequests', () => openShiftRequests())
  delegate('toggleShiftRequestsAll', (el) => { REQ_ALL = !!el.checked; openShiftRequests() })
  delegate('respondShiftRequest', async (el) => {
    const id = Number(el.dataset.id)
    const decision = el.dataset.decision
    const input = document.querySelector(`[data-note-for="${id}"]`)
    if (decision === 'decline' && !confirm('この希望を見送りにしますか？（本人の画面に「見送り」と表示されます）')) return
    await withSubmitLock(el, async () => {
      try { await axios.post(`/api/admin/shift-requests/${id}/respond`, { decision, note: input ? input.value : '' }) }
      catch (e) { toast(errMsg(e)); return openShiftRequests() }
      toast(decision === 'accept' ? '採用にしました' : '見送りにしました')
      openShiftRequests(); loadRequestCount()
    })
  })

  // 管理者が『希望（仮）』で入れたシフトへの本人の返事（#411）
  function replyMark(a) {
    if (a.status !== 'requested') return ''
    if (a.staff_reply === 'ok') return '<i class="fas fa-circle-check text-emerald-600 ml-0.5" title="本人: 入れます"></i>'
    if (a.staff_reply === 'ng') return '<i class="fas fa-circle-xmark text-red-500 ml-0.5" title="本人: 入れません"></i>'
    return '<i class="fas fa-hourglass-half text-gray-400 ml-0.5" title="本人の返事待ち"></i>'
  }
  function replyText(a) {
    if (a.status !== 'requested') return ''
    if (!a.staff_reply) return '本人の返事待ち'
    return '本人: ' + (a.staff_reply === 'ok' ? '入れます' : '入れません') + (a.staff_reply_note ? '（' + a.staff_reply_note + '）' : '')
  }

  // =========================================================
  // 枠の作成・編集
  // =========================================================
  // 役割の単価には単位（日額・時給）を付ける（#145）。単価ルールを変更前の役割名で当てている役割はその旨を出す（#144）
  const unitSelect = (cls, v) => `<select class="inp text-xs w-20 shrink-0 ${cls}" title="単位">${Object.entries(UNIT_LABEL).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`
  function roleRowsHtml(roles) {
    return roles.map((r, i) => `<div class="grid grid-cols-12 gap-1.5 items-center role-row" data-id="${r.slot_role_id || ''}">
      <input class="inp text-xs col-span-8 rr-name" placeholder="役割（販売・リーダー等）" value="${esc(r.role_name || '')}" list="role-suggest">
      <input class="inp text-xs col-span-3 rr-count" type="number" min="1" max="200" value="${r.headcount || 1}" title="必要人数">
      <button class="text-gray-400 hover:text-red-500 col-span-1" onclick="this.closest('.role-row').classList.toggle('opacity-40'); this.closest('.role-row').dataset.del = this.closest('.role-row').dataset.del ? '' : '1'" title="削除"><i class="fas fa-xmark"></i></button>
      <div class="col-span-6 flex gap-1">${unitSelect('rr-bill-unit', r.bill_unit_type || 'daily')}<input class="inp text-xs flex-1 min-w-0 rr-bill" type="number" min="0" placeholder="請求単価（任意）" value="${r.bill_rate ?? ''}" title="この枠だけ請求単価を変える場合"></div>
      <div class="col-span-6 flex gap-1">${unitSelect('rr-pay-unit', r.pay_unit_type || 'daily')}<input class="inp text-xs flex-1 min-w-0 rr-pay" type="number" min="0" placeholder="支払単価（任意）" value="${r.pay_rate ?? ''}" title="この枠だけ支払単価を変える場合"></div>
      ${r.rate_role_name && r.rate_role_name !== r.role_name ? `<p class="col-span-12 text-[11px] text-amber-600">単価ルールは「${esc(r.rate_role_name)}」の役割のものを使います</p>` : ''}
    </div>`).join('')
  }
  function collectRoles() {
    return [...document.querySelectorAll('.role-row')].map(el => ({
      slot_role_id: el.dataset.id ? Number(el.dataset.id) : undefined, _delete: !!el.dataset.del,
      role_name: el.querySelector('.rr-name').value.trim(), headcount: Number(el.querySelector('.rr-count').value || 1),
      bill_rate: el.querySelector('.rr-bill').value, pay_rate: el.querySelector('.rr-pay').value,
      bill_unit_type: el.querySelector('.rr-bill-unit').value, pay_unit_type: el.querySelector('.rr-pay-unit').value,
    })).filter(r => r.slot_role_id || (!r._delete && r.role_name))
  }
  // 枠の保存（PUT）。役割名を変えると当たる単価ルールが変わるときは、どちらの単価にするかを確かめて送り直す（#144）
  async function putSlot(slotId, body) {
    try { return await axios.put('/api/admin/shift-slots/' + slotId, body) } catch (e) {
      const d = e.response && e.response.data
      if (!(e.response && e.response.status === 409 && d && d.need_role_rate)) throw e
      const follow = confirm(`${d.error}\n\n[OK] 単価も新しい役割名の単価ルールに切り替える\n[キャンセル] 単価は今の単価ルールのまま（名前だけ変える）`)
      // 選んだ扱いは body に残す（続けて need_force の確認になったときも同じ扱いで送り直すため）
      body.role_rate = follow ? 'follow' : 'keep'
      return axios.put('/api/admin/shift-slots/' + slotId, body)
    }
  }
  window.addRoleRow = function () {
    const box = document.getElementById('slot-roles'); box.insertAdjacentHTML('beforeend', roleRowsHtml([{ role_name: '', headcount: 1 }]))
  }
  // 無効の開催場所は選択肢に出さない。ただし今選ばれている場所は、無効でも「（無効）」を付けて残す（保存で場所が外れないように。#492）
  function siteOptions(m, projectId, selected) {
    const p = m.projects.find(x => String(x.project_id) === String(projectId))
    const isSel = (s) => selected != null && selected !== '' && String(selected) === String(s.site_id)
    const list = m.sites.filter(s => isSel(s) || (s.status !== 'inactive' && (!p || !p.client_id || !s.client_id || String(s.client_id) === String(p.client_id))))
    return `<option value="">（開催場所を選択 / 直接入力）</option>` + list.map(s => `<option value="${s.site_id}" ${isSel(s) ? 'selected' : ''}>${esc(s.site_name)}${s.status === 'inactive' ? '（無効）' : ''}</option>`).join('')
  }
  window.slotProjectChanged = function () {
    const m = MASTER; const pid = document.getElementById('slot-project').value
    document.getElementById('slot-site').innerHTML = siteOptions(m, pid, '')
  }
  function slotFormHtml(m, s, roles) {
    // 場所の補足: 開催場所の名前と違う場所名（補足を入力した枠）は、編集画面でもそのまま出す
    const site = s.site_id ? m.sites.find(x => String(x.site_id) === String(s.site_id)) : null
    const extra = s.location && (!s.site_id || !site || s.location !== site.site_name) ? s.location : ''
    return `
      <div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">案件 *
            <select id="slot-project" class="inp" onchange="slotProjectChanged()" ${s.slot_id ? 'disabled' : ''}>
              ${m.projects.filter(p => p.status === 'active' || String(p.project_id) === String(s.project_id)).map(p => `<option value="${p.project_id}" ${String(p.project_id) === String(s.project_id) ? 'selected' : ''}>${p.engagement_type === 'spot' ? '[スポット] ' : '[常勤] '}${esc(p.project_name)}</option>`).join('')}
            </select></label>
          <label class="text-sm text-gray-600">開催場所
            <select id="slot-site" class="inp" data-orig="${esc(s.site_id || '')}">${siteOptions(m, s.project_id || (m.projects[0] || {}).project_id, s.site_id)}</select></label>
        </div>
        <input id="slot-location" class="inp text-sm" placeholder="場所の補足（開催場所マスタにない場合はここに入力）" value="${esc(extra)}">
        <div class="grid grid-cols-3 gap-3">
          <label class="text-sm text-gray-600">開始<input id="slot-start" type="time" class="inp" value="${esc(s.start_time || '10:00')}"></label>
          <label class="text-sm text-gray-600">終了<input id="slot-end" type="time" class="inp" value="${esc(s.end_time || '19:00')}"></label>
          <label class="text-sm text-gray-600">休憩（分）<input id="slot-break" type="number" class="inp" value="${s.break_minutes ?? ''}" placeholder="案件の設定"></label>
        </div>
        <div>
          <div class="flex items-center justify-between mb-1"><p class="text-sm text-gray-600">役割と必要人数 *</p>
            <button class="text-xs text-blue-600 hover:underline" onclick="addRoleRow()"><i class="fas fa-plus mr-0.5"></i>役割を追加</button></div>
          <div id="slot-roles" class="space-y-1.5">${roleRowsHtml(roles)}</div>
          <datalist id="role-suggest"><option value="販売"><option value="リーダー"><option value="MC"><option value="設営"><option value="サポート"></datalist>
          <p class="text-[11px] text-gray-400 mt-1">単価を空欄にすると、案件の単価ルール（役割・開催場所・スタッフ別）に従います。単価を入れるときは日額・時給を選んでください</p>
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
      ${slotId ? `<label class="text-sm text-gray-600 block mt-3">日付<input id="slot-date" type="date" class="inp" value="${esc(s.work_date)}"></label>
        <p class="text-[11px] text-gray-400 mt-1">日付・時間・場所・休憩を変えると、割り当て済みのシフトにも反映し、単価を再計算します（休憩をシフトごとに直したもの、手動で変えた金額はそのまま。勤怠・日報の報告があるシフトと確定済みのシフトは日時を動かしません）</p>` :
        `<div class="mt-3"><p class="text-sm text-gray-600 mb-1">日付 *（複数選択できます）</p>
          <div class="flex gap-2"><input id="slot-date-input" type="date" class="inp" value="${esc(s.work_date || BS.from)}" onchange="addSlotDate()"><button id="slot-date-add" class="btn btn-outline shrink-0 whitespace-nowrap" onclick="addSlotDate()">日付を追加</button></div>
          <p class="text-[11px] text-gray-400 mt-1">日付を選ぶと追加されます。同じ内容の枠を選んだ日付すべてに作成します</p>
          <div id="slot-dates" class="flex flex-wrap gap-1 mt-2"></div></div>`}
      <div class="flex gap-2 mt-4">
        ${slotId ? `<button class="btn btn-danger" data-action="deleteSlot" data-id="${slotId}"><i class="fas fa-trash"></i></button>` : ''}
        <button class="btn btn-primary flex-1" data-action="saveSlot" data-id="${slotId || 0}">${slotId ? '保存する' : '作成する'}</button>
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
    if (!slotId) {
      if (!window.__slotDates.size) { toast('日付を追加してください'); return }
      try {
        await axios.post('/api/admin/shift-slots', { ...b, roles: b.roles.filter(r => !r._delete), dates: [...window.__slotDates] })
        closeModal(); toast('枠を作成しました'); renderShiftBoard()
      } catch (e) { toast(errMsg(e)) }
      return
    }
    const orig = document.getElementById('slot-site').dataset.orig
    if (orig && !b.site_id && !confirm('開催場所を外します。開催場所の単価ルール（交通費の定額・場所手当など）が当たらなくなり、割り当て済みのシフトの金額が変わることがあります。保存しますか？')) return
    const body = { ...b, work_date: document.getElementById('slot-date').value }
    try {
      let res
      try { res = await putSlot(slotId, body) } catch (e) {
        const d = e.response && e.response.data
        if (!(d && d.need_force)) throw e
        // 報告済み・確定済みのシフトの扱いと、割り当て済みスタッフの重複・NG などを確認してから続ける（#57 #117）
        const lines = []
        if (d.detach && d.detach.length) lines.push(`次の ${d.detach.length} 件は元の日時のまま残し、枠から外します（${d.detach.map(x => x.staff_name + '：' + x.reason).join('、')}）`)
        if (d.warnings && d.warnings.length) lines.push('確認してください:\n' + d.warnings.join('\n'))
        if (!confirm(lines.join('\n\n') + '\n\nこのまま保存しますか？')) return
        res = await axios.put('/api/admin/shift-slots/' + slotId, { ...body, force: true })
      }
      const r = res.data || {}
      const notes = []
      if (r.detached) notes.push(`${r.detached}件を枠なしにしました`)
      if (r.locked_kept) notes.push(`手動で数量を変えた${r.locked_kept}件は金額を変えていません`)
      closeModal(); toast('枠を保存しました' + (notes.length ? '（' + notes.join('、') + '）' : '')); renderShiftBoard()
    } catch (e) { toast(errMsg(e)) }
  }
  delegate('saveSlot', el => withSubmitLock(el, () => saveSlot(Number(el.dataset.id) || 0)))
  delegate('deleteSlot', el => withSubmitLock(el, () => deleteSlot(Number(el.dataset.id))))
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
      <p class="text-xs text-gray-500 mb-3">例: 毎週土日・10:00〜19:00・販売3名＋リーダー1名・10月〜12月。作成後も、案件詳細の「繰り返し登録」から時間・人数の変更と期間の延長ができます（日ごとの変更は各枠で行えます）</p>
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

  // ---------- 一括処理（一括登録・コピー・単価の再適用）の共通部分 ----------
  // サーバーは1回に処理する件数に上限があり、残りがあると next_cursor を返す。続きを自動で呼び、結果を合計する。
  // 途中で失敗したら、それまでの結果と「続きから実行」を出す（最後に受け取った next_cursor から再開する）
  let BULK_JOB = null
  const fmtDay = (d) => `${dayjs(d).format('M/D')}(${WD[dayjs(d).day()]})`
  function newJob(o) { return { ...o, counts: Object.fromEntries(o.keys.map(k => [k, 0])), skipped: [], cursor: null, running: false } }
  async function runJob(job) {
    if (job.running || (BULK_JOB && BULK_JOB.running)) { toast('ほかの一括処理を実行中です'); return }
    BULK_JOB = job; job.running = true
    let error = null
    try {
      for (;;) {
        const { data } = await axios.post(job.url, { ...job.body, ...(job.cursor != null ? { cursor: job.cursor } : {}) })
        for (const k of job.keys) job.counts[k] += Number(data[k] || 0)
        if (Array.isArray(data.skipped)) job.skipped.push(...data.skipped)
        job.cursor = data.next_cursor ?? null
        if (job.cursor == null) break
        toast(`${job.summary(job.counts)}（続きを処理しています）`)
      }
    } catch (e) { error = errMsg(e) }
    job.running = false
    if (!error) BULK_JOB = null
    showJobResult(job, error)
    if (job.done) job.done()
  }
  function showJobResult(job, error) {
    if (!error && !job.skipped.length) { closeModal(); toast(job.summary(job.counts)); return }
    modal(`
      <h3 class="font-bold text-lg mb-1">${esc(job.title)}</h3>
      ${error ? `<p class="text-sm text-red-600 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>途中で止まりました（${esc(error)}）。ここまでの結果を表示しています。「続きから実行」で残りを処理できます（処理済みの分は二重に作りません）</p>` : ''}
      <p class="text-sm text-gray-700">${esc(job.summary(job.counts))}</p>
      ${skippedTable(job.skipped)}
      ${error ? '<button class="btn btn-primary w-full mt-4" data-action="bulkResume"><i class="fas fa-play"></i>続きから実行</button>' : ''}
      <button class="btn btn-outline w-full mt-2" onclick="closeModal()">閉じる</button>`)
  }
  delegate('bulkResume', el => withSubmitLock(el, () => (BULK_JOB ? runJob(BULK_JOB) : null)))
  delegate('bulkSkipCandidates', el => openCandidates(Number(el.dataset.id)))

  // スキップしたシフトの一覧（理由ごとの件数と、日付・スタッフ・理由・内容）。コピー先の枠が分かるものは候補を開ける
  const REASON_BADGE = { '重複': 'badge-yellow', '割当済み': 'badge-gray', 'NG': 'badge-red', '退職': 'badge-red', '統合済み': 'badge-gray', '停止中': 'badge-gray' }
  function skippedTable(skipped) {
    if (!skipped.length) return ''
    const byReason = {}
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1
    return `<div class="mt-3">
      <p class="text-sm font-bold text-gray-700 mb-1">スキップ ${skipped.length}件 ${Object.entries(byReason).map(([r, n]) => `<span class="badge ${REASON_BADGE[r] || 'badge-gray'}">${esc(r)} ${n}</span>`).join(' ')}</p>
      <div class="max-h-72 overflow-y-auto border border-gray-100 rounded-lg"><table class="tbl text-xs"><thead><tr><th>日付</th><th>スタッフ</th><th>理由</th><th>内容</th><th></th></tr></thead><tbody>
        ${skipped.map(s => `<tr><td class="whitespace-nowrap">${esc(fmtDay(s.date))}</td><td>${esc(s.staff_name || 'ID ' + s.staff_id)}</td>
          <td><span class="badge ${REASON_BADGE[s.reason] || 'badge-gray'}">${esc(s.reason)}</span></td>
          <td>${esc([s.project_name, s.start_time ? s.start_time + '〜' + s.end_time : '', s.detail].filter(Boolean).join(' / '))}</td>
          <td>${s.slot_role_id ? `<button class="text-blue-600 hover:underline whitespace-nowrap" data-action="bulkSkipCandidates" data-id="${Number(s.slot_role_id)}">候補</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div></div>`
  }

  // ---------- 常勤の一括登録 ----------
  window.openBulkModal = async function () {
    const m = await loadMaster()
    modal(`
      <h3 class="font-bold text-lg mb-1">常勤の一括登録</h3>
      <p class="text-xs text-gray-500 mb-3">スタッフ × 曜日 × 期間でシフトをまとめて登録します（退職・NG のスタッフと、同じ時間帯に別のシフトがある日はスキップし、一覧で表示します）</p>
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
        <button class="btn btn-primary w-full" data-action="saveBulk">登録する</button>
      </div>`)
  }
  async function saveBulk() {
    const v = (k) => document.getElementById(k).value
    const body = {
      project_id: Number(v('bk-project')), role: v('bk-role'), staff_ids: [...document.querySelectorAll('.bk-staff:checked')].map(el => Number(el.value)),
      weekdays: [...document.querySelectorAll('.bk-wd:checked')].map(el => Number(el.value)), date_from: v('bk-from'), date_to: v('bk-to'),
      start_time: v('bk-start'), end_time: v('bk-end'), transportation_fee: v('bk-fee'),
    }
    await runJob(newJob({
      title: '常勤の一括登録', url: '/api/admin/shifts/bulk', body, keys: ['created'],
      summary: (n) => `${n.created}件登録しました`, done: () => renderShiftBoard(),
    }))
  }
  delegate('saveBulk', el => withSubmitLock(el, saveBulk))

  // ---------- コピー ----------
  // 曜日がずれないよう、コピーする期間は週単位（表示中の期間に収まる週数まで）にする
  function copyScopeText(m) {
    const parts = []
    const cl = BS.clientId ? m.clients.find(c => String(c.client_id) === String(BS.clientId)) : null
    parts.push(cl ? cl.client_name : 'すべてのクライアント')
    if (BS.engagement) parts.push(BS.engagement === 'spot' ? 'スポットのみ' : '常勤のみ')
    if (BS.projectIds.length) parts.push('案件: ' + BS.projectIds.map(id => (m.projects.find(p => p.project_id === id) || {}).project_name || ('ID ' + id)).join('、'))
    else parts.push('案件: 絞り込みに合うすべての案件')
    return parts.join(' / ')
  }
  function copyBody() {
    return {
      source_from: BS.from, target_from: document.getElementById('cp-to').value, days: Number(document.getElementById('cp-days').value),
      client_id: BS.clientId || null, engagement: BS.engagement || '', project_ids: BS.projectIds.join(','),
      include_assignments: document.getElementById('cp-assign').checked,
    }
  }
  // コピー元・コピー先の期間と、重なり・曜日のずれ
  function copyRange() {
    const body = copyBody()
    if (!body.target_from) return null
    const off = dayjs(body.target_from).diff(dayjs(body.source_from), 'day')
    return {
      body, overlap: Math.abs(off) < body.days, shift: ((off % 7) + 7) % 7,
      srcTo: dayjs(body.source_from).add(body.days - 1, 'day').format('YYYY-MM-DD'), tgtTo: dayjs(body.target_from).add(body.days - 1, 'day').format('YYYY-MM-DD'),
    }
  }
  // 期間を曜日付きで出す。重なる指定は確認・実行できなくし、曜日がずれる指定は警告する。条件を変えたら確認をやり直す
  function copyRangeCheck() {
    const r = copyRange(); const el = document.getElementById('cp-range')
    document.getElementById('cp-preview').innerHTML = ''; document.getElementById('cp-run').disabled = true
    document.getElementById('cp-check').disabled = !r || r.overlap
    if (!r) { el.innerHTML = ''; return }
    const b = r.body
    el.innerHTML = `<span class="font-bold">${fmtDay(b.source_from)}〜${fmtDay(r.srcTo)}</span> → <span class="font-bold">${fmtDay(b.target_from)}〜${fmtDay(r.tgtTo)}</span>
      ${r.overlap ? '<span class="block text-xs text-red-600 mt-1">コピー元とコピー先の期間が重なっています。コピー先の開始日を後ろにしてください</span>'
        : r.shift ? `<span class="block text-xs text-amber-600 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>コピー先の曜日が${r.shift}日ずれます（例: ${fmtDay(b.source_from)} → ${fmtDay(b.target_from)}）</span>` : ''}`
  }
  window.openCopyModal = async function () {
    const m = await loadMaster()
    const weeks = Math.max(1, Math.floor(BS.days / 7))
    modal(`
      <h3 class="font-bold text-lg mb-1">枠とシフトをコピー</h3>
      <p class="text-xs text-gray-500 mb-3">対象: ${esc(copyScopeText(m))}（シフトボードの絞り込みと同じ条件）</p>
      <div class="grid grid-cols-2 gap-3">
        <label class="text-sm text-gray-600">コピーする期間<select id="cp-days" class="inp">${Array.from({ length: weeks }, (_, i) => `<option value="${(i + 1) * 7}" ${i + 1 === weeks ? 'selected' : ''}>${i + 1}週間（${(i + 1) * 7}日）</option>`).join('')}</select></label>
        <label class="text-sm text-gray-600">コピー先の開始日<input id="cp-to" type="date" class="inp" value="${dayjs(BS.from).add(weeks * 7, 'day').format('YYYY-MM-DD')}"></label>
      </div>
      <p id="cp-range" class="text-sm text-gray-700 mt-2"></p>
      <label class="flex items-center gap-2 text-sm mt-3"><input type="checkbox" id="cp-assign" checked>割り当て（確定・代打）もコピーする</label>
      <p class="text-[11px] text-gray-400 mt-1">退職・NG のスタッフと、同じ時間帯に別のシフトがあるスタッフはスキップします。希望・欠勤はコピーしません。コピー済みの枠・シフトは二重に作りません</p>
      <div id="cp-preview" class="mt-3"></div>
      <button id="cp-check" class="btn btn-outline w-full mt-3" data-action="copyPreview">コピーする内容を確認</button>
      <button id="cp-run" class="btn btn-primary w-full mt-2" data-action="copyRun" disabled>コピーする</button>`)
    document.getElementById('cp-days').addEventListener('change', () => {
      document.getElementById('cp-to').value = dayjs(BS.from).add(Number(document.getElementById('cp-days').value), 'day').format('YYYY-MM-DD')
      copyRangeCheck()
    })
    document.getElementById('cp-to').addEventListener('change', copyRangeCheck)
    document.getElementById('cp-assign').addEventListener('change', copyRangeCheck)
    copyRangeCheck()
  }
  async function copyPreview() {
    const r = copyRange(); if (!r || r.overlap) return
    try {
      const { data } = await axios.post('/api/admin/shifts/copy-week', { ...r.body, dry_run: true })
      const names = data.projects.map(p => (p.client_name ? p.client_name + ' / ' : '') + p.project_name)
      const empty = !data.slots && !data.slots_reused && !data.shifts
      document.getElementById('cp-preview').innerHTML = `<div class="rounded-lg bg-gray-50 p-3 text-sm">
        ${empty && !data.already && !data.skipped.length ? '<p class="text-gray-500">コピーする枠・シフトはありません</p>' : `
        <p class="text-xs text-gray-500 mb-1">対象の案件 ${names.length}件: ${esc(names.slice(0, 8).join('、'))}${names.length > 8 ? ` ほか${names.length - 8}件` : ''}</p>
        <p>枠: 作成 <b>${data.slots}</b>件${data.slots_reused ? `・コピー先の既存の枠を使う ${data.slots_reused}件` : ''}</p>
        <p>シフト: 作成 <b>${data.shifts}</b>件${data.already ? `・コピー済み ${data.already}件（作りません）` : ''}</p>`}
        ${skippedTable(data.skipped)}</div>`
      document.getElementById('cp-run').disabled = empty
    } catch (e) { toast(errMsg(e)) }
  }
  async function copyRun() {
    const r = copyRange(); if (!r || r.overlap) return
    if (r.shift && !confirm(`コピー先の曜日が${r.shift}日ずれます。このままコピーしますか？`)) return
    await runJob(newJob({
      title: '枠とシフトのコピー', url: '/api/admin/shifts/copy-week', body: { ...r.body, force: !!r.shift }, keys: ['slots', 'slots_reused', 'shifts', 'already'],
      summary: (n) => `枠${n.slots}件を作成${n.slots_reused ? `（既存の枠を使用 ${n.slots_reused}件）` : ''}・シフト${n.shifts}件をコピーしました${n.already ? `（コピー済み ${n.already}件は作成していません）` : ''}`,
      done: () => renderShiftBoard(),
    }))
  }
  delegate('copyPreview', el => withSubmitLock(el, copyPreview))
  delegate('copyRun', el => withSubmitLock(el, copyRun))

  // =========================================================
  // 案件詳細: 区分・単価・単価ルール・繰り返し登録
  // =========================================================
  function ruleSummary(r) {
    const parts = []
    // 適用期間（#210）
    if (r.valid_from || r.valid_to) parts.push(`期間 ${r.valid_from ? esc(r.valid_from) : ''}〜${r.valid_to ? esc(r.valid_to) : ''}`)
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
    const [{ data: rr }, { data: pt }, { data: si }, ph] = await Promise.all([
      axios.get('/api/admin/rate-rules?project_id=' + p.project_id), axios.get('/api/admin/slot-patterns?project_id=' + p.project_id),
      axios.get('/api/admin/sites' + (p.client_id ? '?client_id=' + p.client_id : '')),
      axios.get(`/api/admin/projects/${p.project_id}/price-history`).then(r => r.data).catch(() => null)])
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
            <label>請求単価<input id="pp-bill" type="number" min="0" class="inp text-sm" value="${p.unit_price ?? 0}"></label>
            <label>支払の単位<select id="pp-pay-unit" class="inp text-sm">${opt(UNIT_LABEL, p.pay_unit_type || 'daily')}</select></label>
            <label>支払単価<input id="pp-pay" type="number" min="0" class="inp text-sm" value="${p.pay_rate ?? ''}" placeholder="未設定"></label>
            <label>交通費の請求<select id="pp-bt" class="inp text-sm">${opt(BT_LABEL, p.bill_transport_type || 'actual')}</select></label>
            <label>定額の場合の金額<input id="pp-bt-amt" type="number" min="0" class="inp text-sm" value="${p.bill_transport_amount || 0}"></label>
            <label>交通費の支払<select id="pp-pt" class="inp text-sm">${opt(PT_LABEL, p.pay_transport_type || 'actual')}</select></label>
            <label>上限 / 定額の金額<input id="pp-pt-amt" type="number" min="0" class="inp text-sm" value="${p.pay_transport_amount || 0}"></label>
            <label class="col-span-2">単価を変えるときの適用開始日<input id="pp-valid-from" type="date" class="inp text-sm" value="">
              <span class="block text-[11px] text-gray-400">入れると、その前日までの稼働日は今の単価のまま計算します。空欄なら今の単価${p.price_valid_from ? `（${esc(p.price_valid_from)}〜）` : ''}を直します</span></label>
            <label>休憩（時給計算用・分）<input id="pp-break" type="number" min="0" max="600" class="inp text-sm" value="${p.default_break_minutes ?? 60}"></label>
            <label>時給の時間の数え方<select id="pp-hours-basis" class="inp text-sm">${opt({ clipped: '実働（予定の範囲内）', actual: '実働どおり', scheduled: '予定どおり' }, p.hours_basis || 'clipped')}</select></label>
            <label>時刻の丸め<select id="pp-round" class="inp text-sm">${opt({ 0: '丸めない', 5: '5分', 10: '10分', 15: '15分', 30: '30分' }, String(p.time_round_minutes || 0))}</select></label>
            <label>支払の丸め<select id="pp-pay-round" class="inp text-sm">${opt({ none: '支払は丸めない（1分単位）', same: '支払も同じく丸める' }, p.pay_time_round === 'same' ? 'same' : 'none')}</select></label>
          </div>
          <p class="text-[11px] text-gray-400 mt-1">時給は入店・退店の実績から計算します。「予定の範囲内」は早く来た・遅く残った分を含めません。丸めは開始を切り上げ、終了を切り捨てます</p>
          ${p.pay_time_round === 'same' && Number(p.time_round_minutes || 0) > 0 ? '<p class="text-[11px] text-amber-600 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>支払も丸めています。自社給与・日雇い給与のスタッフの労働時間を日ごとに切り捨てると、賃金の未払いになるおそれがあります（給与は1分単位で計算してください）</p>' : ''}
          ${priceHistoryHtml(ph)}
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
              <button class="text-blue-600 hover:underline whitespace-nowrap" data-action="ruleSetEnd" data-id="${Number(r.rule_id)}" data-to="${esc(r.valid_to || '')}" data-pid="${Number(p.project_id)}" title="単価の改定: 旧ルールに終了日を付けて残します">終了日</button>
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
            ${pt.patterns.map(x => `<tr><td>${x.weekdays.split(',').map(i => WD[i]).join('・')}</td><td class="whitespace-nowrap">${esc(x.date_from)}〜${esc(x.date_to)}${patternEndBadge(x)}</td><td>${esc(x.start_time)}〜${esc(x.end_time)}</td>
              <td>${esc(x.site_name || x.location || '-')}</td><td>${x.roles.map(r => esc(r.role_name) + Number(r.headcount) + '名').join('・')}</td><td class="whitespace-nowrap">${Number(x.slot_count)}件<span class="block text-[11px] text-gray-400">今日以降 ${Number(x.future_slot_count || 0)}件</span></td>
              <td class="text-right whitespace-nowrap"><button class="text-xs text-blue-600 hover:underline mr-2" data-action="editPattern" data-id="${Number(x.pattern_id)}">編集・延長</button><button class="text-xs text-red-600 hover:underline" data-action="deletePattern" data-id="${Number(x.pattern_id)}">削除</button></td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400">繰り返し登録はありません</td></tr>'}
          </tbody></table></div>
        </section>
      </div>`
    window.__projectForPanel = p
    PATTERNS = new Map(pt.patterns.map(x => [x.pattern_id, { ...x, project: p }]))
    // 勤怠・日報の提出設定（案件の初期値。public/static/staff-lifecycle.js）
    if (window.renderProjectReportSettings) renderProjectReportSettings(p)
  }
  // 案件の標準単価の改定履歴（#210）
  const unitShort = (u) => (u === 'hourly' ? '/時' : '/日')
  function priceHistoryHtml(ph) {
    if (!ph || (!ph.price_valid_from && !(ph.history || []).length)) return ''
    return `<div class="mt-2 text-[11px] text-gray-500 bg-gray-50 rounded p-2">
      <p class="font-bold text-gray-600">標準単価の適用期間</p>
      ${ph.price_valid_from ? `<p>今の単価: ${esc(ph.price_valid_from)}〜</p>` : ''}
      ${(ph.history || []).map(h => `<p>${h.valid_from ? esc(h.valid_from) : ''}〜${esc(h.valid_to)}: 請求 ${yen(h.unit_price)}${unitShort(h.unit_price_type)} / 支払 ${h.pay_rate == null ? '未設定' : yen(h.pay_rate) + unitShort(h.pay_unit_type)}</p>`).join('')}
    </div>`
  }
  window.saveProjectPricing = async function (pid) {
    const v = (k) => document.getElementById(k).value
    try {
      const { data } = await axios.put(`/api/admin/projects/${pid}/pricing`, {
        engagement_type: v('pp-eng'), unit_price_type: v('pp-bill-unit'), unit_price: v('pp-bill'), pay_unit_type: v('pp-pay-unit'), pay_rate: v('pp-pay'),
        bill_transport_type: v('pp-bt'), bill_transport_amount: v('pp-bt-amt'), pay_transport_type: v('pp-pt'), pay_transport_amount: v('pp-pt-amt'), default_break_minutes: v('pp-break'),
        hours_basis: v('pp-hours-basis'), time_round_minutes: v('pp-round'), pay_time_round: v('pp-pay-round'), price_valid_from: v('pp-valid-from'),
      })
      invalidateMaster()
      toast(v('pp-valid-from') && data.price_changed ? `保存しました（${v('pp-valid-from')}以降の稼働日から新しい単価を使います）` : '保存しました')
      renderProjectDetail(pid)
    } catch (e) { toast(errMsg(e)) }
  }
  // 単価ルールの再適用（#469）: 期間を選び、金額・支払先が変わるシフトと増減の合計を確かめてから実行する
  window.repriceProject = function (pid, staffId) {
    if (BULK_JOB && BULK_JOB.running) { toast('ほかの一括処理を実行中です'); return }
    window.__repriceCtx = { pid: pid || null, staffId: staffId || null }
    modal(`
      <h3 class="font-bold text-lg mb-1">単価ルールの再適用</h3>
      <p class="text-xs text-gray-500 mb-3">期間内のシフトに、今の単価ルールと案件の標準単価を当て直します（金額を手動で変更したシフト・確定済みのシフトは除きます）。単価ルールの適用期間は、シフトの稼働日で選びます</p>
      <div class="grid grid-cols-2 gap-2 text-sm">
        <label>開始日<input id="rp-from" type="date" class="inp" value="${dayjs().startOf('month').format('YYYY-MM-DD')}"></label>
        <label>終了日<input id="rp-to" type="date" class="inp" value="${dayjs().add(1, 'year').format('YYYY-MM-DD')}"></label>
      </div>
      <button class="btn btn-outline w-full mt-3" data-action="repricePreview"><i class="fas fa-magnifying-glass"></i>変わる金額を確認</button>
      <div id="rp-result" class="mt-3"></div>`)
  }
  function repriceBody() {
    const c = window.__repriceCtx || {}
    return { from: document.getElementById('rp-from').value, to: document.getElementById('rp-to').value, ...(c.pid ? { project_id: c.pid } : {}), ...(c.staffId ? { staff_id: c.staffId } : {}) }
  }
  const PAYEE_SHORT = { payroll: '自社給与', payroll_daily: '日雇い給与', freelance: '個人事業主', partner: '取引先', linked: '他社（連携元）' }
  const signedYen = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + yen(Math.abs(n))
  delegate('repricePreview', el => withSubmitLock(el, async () => {
    const box = document.getElementById('rp-result'); const body = repriceBody()
    if (!body.from || !body.to) { toast('期間を入力してください'); return }
    try {
      const { data } = await axios.post('/api/admin/shifts/reprice', { ...body, dry_run: true })
      window.__repriceBody = body
      if (!data.count) { box.innerHTML = '<p class="text-sm text-gray-500">対象のシフトはありません</p>'; return }
      box.innerHTML = `
        <p class="text-sm">対象 ${data.count}件のうち、金額・支払先が変わるのは <b>${data.changed}件</b>${data.truncated ? `（先頭の${data.checked}件で確認しました）` : ''}</p>
        <p class="text-sm">請求 <b>${signedYen(data.bill_diff)}</b>・支払 <b>${signedYen(data.pay_diff)}</b>${data.pay_set_changed ? `・支払単価の設定が変わる ${data.pay_set_changed}件` : ''}${data.payee_changed ? `・支払先が変わる ${data.payee_changed}件` : ''}</p>
        ${data.changes.length ? `<div class="max-h-72 overflow-y-auto border border-gray-100 rounded-lg mt-2"><table class="tbl text-xs"><thead><tr><th>日付</th><th>スタッフ</th><th>案件</th><th>請求</th><th>支払</th><th>支払先</th></tr></thead><tbody>
          ${data.changes.map(x => `<tr><td class="whitespace-nowrap">${esc(fmtDay(x.work_date))}</td><td>${esc(x.staff_name)}</td><td>${esc(x.project_name)}</td>
            <td class="whitespace-nowrap">${yen(x.bill_before)} → <b>${yen(x.bill_after)}</b></td>
            <td class="whitespace-nowrap">${x.pay_before == null ? '未設定' : yen(x.pay_before)} → <b>${x.pay_after == null ? '未設定' : yen(x.pay_after)}</b></td>
            <td class="whitespace-nowrap">${x.payee_changed ? `${esc(PAYEE_SHORT[x.payee_before] || x.payee_before || '-')} → <b>${esc(PAYEE_SHORT[x.payee_after] || x.payee_after || '-')}</b>` : ''}</td></tr>`).join('')}
        </tbody></table></div>${data.changed > data.changes.length ? `<p class="text-[11px] text-gray-400 mt-1">先頭の${data.changes.length}件を表示しています</p>` : ''}` : ''}
        <button class="btn btn-primary w-full mt-3" data-action="repriceRun"><i class="fas fa-rotate"></i>${data.count}件に再適用する</button>`
    } catch (e) { box.innerHTML = ''; toast(errMsg(e)) }
  }))
  delegate('repriceRun', el => withSubmitLock(el, async () => {
    const body = window.__repriceBody; if (!body) return
    // 件数が多いときは何回かに分けて処理する（runJob が続きを自動で呼ぶ）
    await runJob(newJob({
      title: '単価ルールの再適用', url: '/api/admin/shifts/reprice', body, keys: ['count', 'updated'],
      summary: (n) => `${n.count}件のシフトを確認し、${n.updated}件を再計算しました`,
    }))
  }))
  // ---------- 繰り返し登録の編集・延長・削除（#456） ----------
  let PATTERNS = new Map()
  function patternEndBadge(x) {
    if (x.days_left < 0) return '<span class="badge badge-gray ml-1">終了</span>'
    if (x.days_left <= 14) return `<span class="badge badge-red ml-1" title="終了日が近づいています。続ける場合は「編集・延長」で終了日を延ばしてください">あと${Number(x.days_left)}日で終了</span>`
    return ''
  }
  function patternRoleRows(roles) {
    return roles.map(r => `<div class="grid grid-cols-12 gap-1.5 items-center pe-role" data-orig="${r.orig ? esc(r.role_name) : ''}">
      <input class="inp text-xs col-span-6 pe-name" value="${esc(r.role_name || '')}" ${r.orig ? 'readonly title="役割名の変更は枠の編集で行います"' : 'placeholder="役割（追加）" list="role-suggest"'}>
      <input class="inp text-xs col-span-4 pe-count" type="number" min="1" max="200" value="${Number(r.headcount) || 1}" title="必要人数">
      <label class="col-span-2 text-[11px] text-gray-500 flex items-center gap-1"><input type="checkbox" class="pe-del">外す</label>
    </div>`).join('')
  }
  function openPatternEdit(id) {
    const x = PATTERNS.get(id); if (!x) return
    const today = dayjs().format('YYYY-MM-DD')
    modal(`
      <h3 class="font-bold text-lg mb-1">繰り返し登録の編集・延長</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(x.weekdays.split(',').map(i => WD[i]).join('・'))}・${esc(x.date_from)}〜${esc(x.date_to)}・${esc(x.site_name || x.location || '')}。
        変えた項目だけを、反映を始める日以降のこの登録の枠に反映します（勤怠・日報の報告があるシフト、実績が確定済みのシフトがある枠は変えません。枠ごと・シフトごとに直した時刻・休憩はそのまま残します）</p>
      <div class="space-y-3">
        <div class="grid grid-cols-3 gap-3">
          <label class="text-sm text-gray-600">開始<input id="pe-start" type="time" class="inp" value="${esc(x.start_time)}"></label>
          <label class="text-sm text-gray-600">終了<input id="pe-end" type="time" class="inp" value="${esc(x.end_time)}"></label>
          <label class="text-sm text-gray-600">休憩（分）<input id="pe-break" type="number" min="0" class="inp" value="${x.break_minutes ?? ''}" placeholder="案件の設定"></label>
        </div>
        <div><div class="flex items-center justify-between mb-1"><p class="text-sm text-gray-600">役割と必要人数</p>
          <button class="text-xs text-blue-600 hover:underline" data-action="patternAddRole"><i class="fas fa-plus mr-0.5"></i>役割を追加</button></div>
          <div id="pe-roles" class="space-y-1.5">${patternRoleRows(x.roles.map(r => ({ ...r, orig: true })))}</div>
          <datalist id="role-suggest"><option value="販売"><option value="リーダー"><option value="MC"><option value="設営"><option value="サポート"></datalist>
          <p class="text-[11px] text-gray-400 mt-1">割り当て・未対応の応募がある枠の役割は外しません</p></div>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">反映を始める日<input id="pe-from" type="date" class="inp" min="${today}" value="${esc(x.date_from > today ? x.date_from : today)}"></label>
          <label class="text-sm text-gray-600">終了日（延ばすと枠を追加）<input id="pe-to" type="date" class="inp" min="${esc(x.date_to)}" value="${esc(x.date_to)}"></label>
        </div>
        <div id="pe-preview"></div>
        <button class="btn btn-outline w-full" data-action="patternPreview" data-id="${Number(id)}">反映する内容を確認</button>
        <button id="pe-run" class="btn btn-primary w-full" data-action="patternSave" data-id="${Number(id)}" disabled>反映する</button>
      </div>`)
    document.querySelectorAll('#pe-start,#pe-end,#pe-break,#pe-from,#pe-to').forEach(el => el.addEventListener('change', patternDirty))
    document.getElementById('pe-roles').addEventListener('input', patternDirty)
  }
  function patternDirty() { const b = document.getElementById('pe-run'); if (b) b.disabled = true; const p = document.getElementById('pe-preview'); if (p) p.innerHTML = '' }
  function patternBody() {
    const v = (k) => document.getElementById(k).value
    return {
      start_time: v('pe-start'), end_time: v('pe-end'), break_minutes: v('pe-break'), apply_from: v('pe-from'), date_to: v('pe-to'),
      roles: [...document.querySelectorAll('.pe-role')].map(el => ({
        ...(el.dataset.orig ? { orig_name: el.dataset.orig } : { role_name: el.querySelector('.pe-name').value.trim() }),
        headcount: Number(el.querySelector('.pe-count').value), _delete: el.querySelector('.pe-del').checked,
      })).filter(r => r.orig_name != null || (r.role_name && !r._delete)),
    }
  }
  function patternSummary(d) {
    const parts = [`対象の枠 ${d.slots}件`]
    if (d.skipped_slots) parts.push(`報告済み・確定済みのため変えない枠 ${d.skipped_slots}件`)
    if (d.custom_slots) parts.push(`枠ごとに時刻・休憩を直しているため、その項目を変えない枠 ${d.custom_slots}件`)
    if (d.shifts) parts.push(`時刻を合わせるシフト ${d.shifts}件`)
    if (d.headcount_changed) parts.push('人数を変更')
    if (d.roles_added) parts.push(`役割を追加 ${d.roles_added}件`)
    if (d.roles_removed) parts.push(`役割を外す ${d.roles_removed}件`)
    if (d.roles_kept) parts.push(`割り当て・応募があるため残す役割 ${d.roles_kept}件`)
    if (d.extend_slots) parts.push(`延長で追加する枠 ${d.extend_slots}件（〜${d.date_to}）`)
    return parts.join('・')
  }
  delegate('patternAddRole', () => document.getElementById('pe-roles').insertAdjacentHTML('beforeend', patternRoleRows([{ role_name: '', headcount: 1 }])))
  delegate('editPattern', el => openPatternEdit(Number(el.dataset.id)))
  delegate('patternPreview', el => withSubmitLock(el, async () => {
    let d
    try { d = (await axios.put(`/api/admin/slot-patterns/${Number(el.dataset.id)}`, { ...patternBody(), dry_run: true })).data } catch (e) { toast(errMsg(e)); return }
    document.getElementById('pe-preview').innerHTML = `<div class="rounded-lg bg-gray-50 p-3 text-sm">
      <p>${esc(patternSummary(d))}</p>
      ${d.warnings.length ? `<div class="text-xs text-red-600 mt-2"><p class="font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>割り当て済みの人の時間が、別のシフトと重なります</p>${d.warnings.slice(0, 10).map(w => `<p>${esc(w)}</p>`).join('')}${d.warnings.length > 10 ? `<p>ほか${d.warnings.length - 10}件</p>` : ''}</div>` : ''}</div>`
    const run = document.getElementById('pe-run'); run.disabled = false; run.dataset.force = d.warnings.length ? '1' : ''
  }))
  delegate('patternSave', el => withSubmitLock(el, async () => {
    const x = PATTERNS.get(Number(el.dataset.id)); if (!x) return
    if (el.dataset.force && !confirm('重なりがあります。このまま反映しますか？')) return
    let d
    try { d = (await axios.put(`/api/admin/slot-patterns/${Number(el.dataset.id)}`, { ...patternBody(), force: !!el.dataset.force })).data } catch (e) { toast(errMsg(e)); return }
    closeModal(); toast('反映しました（' + patternSummary(d) + '）'); renderProjectDetail(x.project.project_id)
  }))
  // 削除: 作成済みの枠を残すか、今日以降の割り当てのない枠も消すかを選ぶ
  delegate('deletePattern', (el) => {
    const x = PATTERNS.get(Number(el.dataset.id)); if (!x) return
    modal(`
      <h3 class="font-bold text-lg mb-1">繰り返し登録を削除</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(x.weekdays.split(',').map(i => WD[i]).join('・'))}・${esc(x.date_from)}〜${esc(x.date_to)}・${esc(x.start_time)}〜${esc(x.end_time)}（作成済みの枠 ${Number(x.slot_count)}件・今日以降 ${Number(x.future_slot_count || 0)}件）</p>
      <label class="flex items-start gap-2 text-sm p-2 rounded border border-gray-200 mb-2"><input type="radio" name="pd-mode" value="keep" checked><span>作成済みの枠は残し、繰り返し登録だけを削除する</span></label>
      <label class="flex items-start gap-2 text-sm p-2 rounded border border-gray-200"><input type="radio" name="pd-mode" value="future"><span>今日以降の、割り当てのない枠も削除する<span class="block text-[11px] text-gray-400">割り当てのある枠は残ります</span></span></label>
      <button class="btn btn-danger w-full mt-4" data-action="deletePatternRun" data-id="${Number(x.pattern_id)}"><i class="fas fa-trash"></i>削除する</button>`)
  })
  delegate('deletePatternRun', el => withSubmitLock(el, async () => {
    const x = PATTERNS.get(Number(el.dataset.id)); if (!x) return
    const future = (document.querySelector('input[name="pd-mode"]:checked') || {}).value === 'future'
    let data
    try { data = (await axios.delete(`/api/admin/slot-patterns/${Number(x.pattern_id)}?remove_future=${future ? 1 : 0}&today=${dayjs().format('YYYY-MM-DD')}`)).data } catch (e) { toast(errMsg(e)); return }
    closeModal(); toast(`削除しました${data.removed ? `（枠${data.removed}件を削除）` : ''}`); renderProjectDetail(x.project.project_id)
  }))

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
        <label>請求単価<input id="rl-bill" type="number" min="0" class="inp text-sm" placeholder="変更しない"></label>
        <label>支払の単位<select id="rl-pay-unit" class="inp text-sm"><option value="daily">日額</option><option value="hourly">時給</option></select></label>
        <label>支払単価<input id="rl-pay" type="number" min="0" class="inp text-sm" placeholder="変更しない"></label>
        <label>交通費の請求<select id="rl-bt" class="inp text-sm">${opt(BT_LABEL)}</select></label>
        <label>定額の金額<input id="rl-bt-amt" type="number" class="inp text-sm"></label>
        <label>交通費の支払<select id="rl-pt" class="inp text-sm">${opt(PT_LABEL)}</select></label>
        <label>上限 / 定額の金額<input id="rl-pt-amt" type="number" class="inp text-sm"></label>
        <label>適用開始日<input id="rl-from" type="date" class="inp text-sm"></label>
        <label>適用終了日<input id="rl-to" type="date" class="inp text-sm"></label>
        <p class="col-span-2 text-[11px] text-gray-400">空欄は期限なし。単価を改定するときは、旧ルールに終了日を付けて残し、新しいルールに開始日を入れます（シフトの稼働日で選びます）</p>
        <label class="col-span-2">メモ<input id="rl-memo" class="inp text-sm" placeholder="例: 経験者加算"></label>
      </div>
      <datalist id="role-suggest"><option value="販売"><option value="リーダー"><option value="MC"><option value="設営"></datalist>
      <button class="btn btn-primary w-full mt-4" data-action="saveRule">追加する</button>`)
    window.__ruleCtx = ctx
  }
  delegate('saveRule', el => withSubmitLock(el, () => saveRule(window.__ruleCtx || {})))
  // 単価ルールに終了日を付ける（単価の改定で旧ルールを残すとき。#210）
  delegate('ruleSetEnd', async (el) => {
    const to = prompt('このルールの適用終了日（YYYY-MM-DD。空欄にすると期限なし）', el.dataset.to || dayjs().endOf('month').format('YYYY-MM-DD'))
    if (to === null) return
    try {
      await axios.put('/api/admin/rate-rules/' + Number(el.dataset.id), { valid_to: to.trim() })
      toast('終了日を保存しました')
      if (el.dataset.sid) renderStaffRatePanel(Number(el.dataset.sid)); else renderProjectDetail(Number(el.dataset.pid))
    } catch (e) { toast(errMsg(e)) }
  })
  window.saveRule = async function (ctx) {
    const v = (k) => { const el = document.getElementById(k); return el ? el.value : '' }
    const body = {
      project_id: ctx.project_id || (v('rl-project') ? Number(v('rl-project')) : null), site_id: v('rl-site') ? Number(v('rl-site')) : null,
      role_name: v('rl-role'), staff_id: ctx.staff_id || (v('rl-staff') ? Number(v('rl-staff')) : null),
      bill_unit_type: v('rl-bill-unit'), bill_rate: v('rl-bill'), pay_unit_type: v('rl-pay-unit'), pay_rate: v('rl-pay'),
      bill_transport_type: v('rl-bt') || null, bill_transport_amount: v('rl-bt-amt'), pay_transport_type: v('rl-pt') || null, pay_transport_amount: v('rl-pt-amt'), memo: v('rl-memo'),
      valid_from: v('rl-from'), valid_to: v('rl-to'),
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
        <button class="text-blue-600 hover:underline whitespace-nowrap" data-action="ruleSetEnd" data-id="${Number(r.rule_id)}" data-to="${esc(r.valid_to || '')}" data-sid="${Number(sid)}" title="単価の改定: 旧ルールに終了日を付けて残します">終了日</button>
        <button class="text-gray-400 hover:text-red-500" onclick="deleteRule(${r.rule_id}, null, ${sid})"><i class="fas fa-trash"></i></button></div>`).join('') || '<p class="text-xs text-gray-400">スタッフ別の単価はありません（案件・枠の単価を使います）</p>'}</div>
    </section>`
  }

  // =========================================================
  // スタッフ詳細: 今後のシフト・過去の稼働・NG指定（#224 #204）。data は GET /api/admin/staff/:id の結果
  // =========================================================
  const ST_BADGE = { requested: 'badge-yellow', confirmed: 'badge-blue', absent: 'badge-red', substitute: 'badge-purple' }
  window.renderStaffShiftPanel = function (sid, data) {
    const host = document.getElementById('staff-shift-panel'); if (!host) return
    if (data.profile && data.profile.affiliation_type === 'skillsheet_only') { host.innerHTML = ''; return }
    const up = data.upcoming_shifts || [], past = data.past_shifts || [], ng = data.ng_clients || []
    const rows = (list) => list.map(s => `<tr>
      <td class="whitespace-nowrap">${esc(dayjs(s.work_date).format('M/D'))}(${WD[dayjs(s.work_date).day()]})</td>
      <td><span class="font-bold">${esc(s.project_name || '')}</span>${s.client_name ? `<span class="block text-[11px] text-gray-400">${esc(s.client_name)}</span>` : ''}</td>
      <td class="whitespace-nowrap">${esc(s.start_time)}〜${esc(s.end_time)}</td>
      <td class="text-xs text-gray-500">${esc([s.site_name || s.location, s.role].filter(Boolean).join('・') || '-')}</td>
      <td class="whitespace-nowrap"><span class="badge ${ST_BADGE[s.status] || 'badge-gray'}">${esc(ST_LABEL[s.status] || s.status)}</span>${s.settle_status === 'confirmed' ? '<span class="badge badge-green ml-1">実績確定</span>' : ''}</td>
      <td class="text-right"><button class="text-xs text-blue-600 hover:underline whitespace-nowrap" data-action="boardOpenDate" data-date="${esc(s.work_date)}">ボードで開く</button></td></tr>`).join('')
    const table = (list, empty) => `<div class="overflow-x-auto max-h-80 overflow-y-auto"><table class="tbl"><thead><tr><th>日付</th><th>案件</th><th>時間</th><th>開催場所・役割</th><th>状態</th><th></th></tr></thead>
      <tbody>${rows(list) || `<tr><td colspan="6" class="text-center text-gray-400">${empty}</td></tr>`}</tbody></table></div>`
    const absent = past.filter(s => s.status === 'absent').length
    host.innerHTML = `<section class="card p-4" id="staff-shifts">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-calendar-days text-blue-500 mr-1"></i>シフト</h3>
        <div class="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          <button class="px-3 py-1.5 bg-blue-600 text-white" data-action="staffShiftTab" data-tab="up">今後（${up.length}${up.length >= 20 ? '件〜' : '件'}）</button>
          <button class="px-3 py-1.5 bg-white" data-action="staffShiftTab" data-tab="past">過去の稼働（直近${past.length}件${absent ? `・欠勤${absent}` : ''}）</button>
        </div>
      </div>
      ${ng.length ? `<p class="text-xs text-red-600 bg-red-50 rounded p-2 mb-2"><i class="fas fa-ban mr-1"></i>NGに指定しているクライアント: ${ng.map(c => `<a href="#clients/${Number(c.client_id)}" class="underline">${esc(c.client_name)}</a>${c.reason ? `（${esc(c.reason)}）` : ''}`).join('、')}</p>` : ''}
      <div data-shift-tab="up">${table(up, '今日以降のシフトはありません')}${up.length >= 20 ? '<p class="text-[11px] text-gray-400 mt-1">先頭の20件を表示しています。続きはシフトボードの「人ごと」で確認できます</p>' : ''}</div>
      <div data-shift-tab="past" class="hidden">${table(past, '過去の稼働はありません')}</div>
    </section>`
  }
  delegate('staffShiftTab', (el) => {
    const box = el.closest('#staff-shifts'); if (!box) return
    box.querySelectorAll('[data-action="staffShiftTab"]').forEach(b => { const on = b === el; b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on); b.classList.toggle('bg-white', !on) })
    box.querySelectorAll('[data-shift-tab]').forEach(t => t.classList.toggle('hidden', t.dataset.shiftTab !== el.dataset.tab))
  })
  // シフトボードをその日の週で開く（絞り込みは外す）
  delegate('boardOpenDate', (el) => {
    Object.assign(BS, { from: weekStart(el.dataset.date), clientId: '', projectIds: [], engagement: '', onlyShort: false })
    location.hash = '#shifts'
  })

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
        <button class="btn btn-primary text-sm shrink-0" data-action="addSite" data-cid="${esc(cid)}"><i class="fas fa-plus"></i>追加</button></div>
      <div class="overflow-x-auto"><table class="tbl"><thead><tr><th>開催場所</th><th>住所</th><th>シフト</th><th>状態</th><th></th></tr></thead><tbody>
        ${data.sites.map(s => `<tr><td class="font-bold">${esc(s.site_name)}</td><td class="text-xs text-gray-500">${esc(s.address || '-')}</td><td>${s.shift_count}件</td>
          <td>${s.status === 'inactive' ? '<span class="badge badge-gray">無効</span>' : '<span class="badge badge-green">有効</span>'}</td>
          <td class="text-right whitespace-nowrap"><button class="text-xs text-blue-600 hover:underline mr-2" data-action="renameSite" data-id="${s.site_id}" data-cid="${esc(cid)}" data-name="${esc(s.site_name)}">名前を変更</button>
            ${s.status === 'inactive' ? `<button class="text-xs text-blue-600 hover:underline" data-action="toggleSite" data-id="${s.site_id}" data-cid="${esc(cid)}" data-status="active">有効にする</button>` : `<button class="text-xs text-red-600 hover:underline" data-action="removeSite" data-id="${s.site_id}" data-cid="${esc(cid)}">削除</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400">開催場所はありません</td></tr>'}
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
  delegate('addSite', el => withSubmitLock(el, () => addSite(Number(el.dataset.cid))))
  delegate('renameSite', el => renameSite(Number(el.dataset.id), Number(el.dataset.cid), el.dataset.name))
  delegate('toggleSite', el => withSubmitLock(el, () => toggleSite(Number(el.dataset.id), Number(el.dataset.cid), el.dataset.status)))
  delegate('removeSite', el => withSubmitLock(el, () => removeSite(Number(el.dataset.id), Number(el.dataset.cid))))
  window.toggleSite = async function (id, cid, status) {
    try { await axios.put('/api/admin/sites/' + id, { status }); invalidateMaster(); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
  window.removeSite = async function (id, cid) {
    if (!confirm('この開催場所を削除しますか？（シフトで使用中の場合は「無効」にします）')) return
    try { const { data } = await axios.delete('/api/admin/sites/' + id); invalidateMaster(); toast(data.deactivated ? '使用中のため無効にしました' : '削除しました'); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
})()
