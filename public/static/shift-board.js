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
  const AFF_SHORT = { own_employee: '自社', linked_external: '他社', partner_manual: '協力会社', skillsheet_only: 'シート' }
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
  // クライアントに出す配置表（#298）。ボードの期間・絞り込みのまま出す（金額は含まない）
  delegate('boardPlacementExport', (el) => {
    const q = new URLSearchParams({ from: BS.from, to: dayjs(BS.from).add(BS.days - 1, 'day').format('YYYY-MM-DD'), format: el.dataset.format === 'print' ? 'print' : 'csv' })
    if (BS.clientId) q.set('client_id', BS.clientId)
    if (BS.projectIds.length) q.set('project_ids', BS.projectIds.join(','))
    if (BS.engagement) q.set('engagement', BS.engagement)
    const url = '/api/admin/shift-board/export?' + q
    if (el.dataset.format === 'print') window.open(url, '_blank', 'noopener')
    else location.href = url
  })

  // =========================================================
  // シフト管理（D 案。Sprint 11 #9401〜#9403）
  // 上: 期間（週・2週間・月）と絞り込み、左: 案件 × 日付の表（月はカレンダー）、右: 選んだマスの案件・単価・候補。
  // 候補を押すと下書きにし（その場では保存しない）、「まとめて保存」で1回で登録する（POST /api/admin/shift-slots/assign-batch）
  // =========================================================
  const RANGE_DAYS = { week: 7, '2w': 14 }
  if (!BS.range) BS.range = BS.days >= 28 ? 'month' : BS.days === 14 ? '2w' : 'week'
  if (!BS.cf) BS.cf = { free: true, skill: '', prev: false, q: '' }
  if (!BS.draftStatus) BS.draftStatus = 'confirmed'
  if (!BS.noInherit) BS.noInherit = {}
  // 期間の初日と日数を、表示の単位（週・2週間は月曜始まり、月は1日から月末）にそろえる
  function normalizeRange() {
    if (BS.range === 'month') { BS.from = dayjs(BS.from).startOf('month').format('YYYY-MM-DD'); BS.days = dayjs(BS.from).daysInMonth() }
    else { BS.from = weekStart(BS.from); BS.days = RANGE_DAYS[BS.range] || 7 }
  }
  const boardDays = () => { const a = []; for (let i = 0; i < BS.days; i++) a.push(dayjs(BS.from).add(i, 'day').format('YYYY-MM-DD')); return a }
  // 枠の役割の索引（slot_role_id → 枠・役割）
  let ROLE_IX = new Map()
  function indexRoles() { ROLE_IX = new Map(); for (const s of BOARD.slots) for (const r of s.roles) ROLE_IX.set(r.slot_role_id, { slot: s, role: r }) }
  const projectOf = (pid) => (BOARD && BOARD.projects.find(p => p.project_id === pid)) || (MASTER && MASTER.projects.find(p => p.project_id === pid)) || {}

  window.renderShiftBoard = async function () {
    loading()
    normalizeRange()
    const m = await loadMaster()
    const to = dayjs(BS.from).add(BS.days - 1, 'day').format('YYYY-MM-DD')
    const q = new URLSearchParams({ from: BS.from, to })
    if (BS.clientId) q.set('client_id', BS.clientId)
    if (BS.projectIds.length) q.set('project_ids', BS.projectIds.join(','))
    if (BS.engagement) q.set('engagement', BS.engagement)
    const { data } = await axios.get('/api/admin/shift-board?' + q)
    BOARD = data
    indexRoles()
    pruneDrafts()
    const days = boardDays()
    const t = data.totals
    const fillRate = t.required ? Math.round(t.filled / t.required * 100) : null
    const projOpts = m.projects.filter(p => !BS.clientId || String(p.client_id) === String(BS.clientId))
    const reqShifts = requestedShifts()
    const seg = (key, val, label) => `<button type="button" class="board-seg ${String(BS[key] || '') === val ? 'on' : ''}" data-action="boardSeg" data-key="${key}" data-val="${esc(val)}" aria-pressed="${String(BS[key] || '') === val}">${label}</button>`
    const periodLabel = BS.range === 'month' ? dayjs(BS.from).format('YYYY年M月') : `${fmtDay(BS.from)}〜${fmtDay(to)}`
    // まとめて削除のチェックは、案件ごとの表（週・2週間）でだけ出す。表に出ていない枠の選択は外す
    const canBulk = BS.view === 'slot' && BS.range !== 'month'
    if (!canBulk) BS.bulkDel = false
    pruneBulk()
    const menuItem = (attrs, icon, label) => `<button type="button" class="board-menu-item" ${attrs}><i class="fas ${icon} w-4 text-gray-400"></i>${label}</button>`

    $app.innerHTML = `
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 class="text-xl font-bold text-gray-900">シフト管理</h2>
        <div class="flex gap-2 flex-wrap items-center">
          <button class="btn btn-outline" data-action="boardNewSlot"><i class="fas fa-plus"></i>枠を作成</button>
          ${canBulk ? bulkBtnHtml() : ''}
          <button class="btn btn-primary" data-action="boardOpenBulk" title="スタッフ × 曜日 × 期間で、常勤のシフトをまとめて登録します"><i class="fas fa-repeat"></i>常勤の繰り返し登録</button>
          <button class="btn board-save-btn" id="board-save-top" data-action="boardSaveDrafts" ${DRAFTS.size ? '' : 'disabled'} title="下書きの割り当てをまとめて登録します"><i class="fas fa-floppy-disk"></i><span>まとめて保存（<span class="board-draft-count">${DRAFTS.size}</span>件）</span></button>
          <details class="relative board-menu">
            <summary class="btn btn-outline cursor-pointer select-none"><i class="fas fa-ellipsis"></i>その他の操作<span id="board-req-count"></span></summary>
            <div class="board-menu-list">
              ${menuItem('data-action="boardOpenPattern"', 'fa-calendar-plus', '枠の繰り返し登録（毎週の枠を作る）')}
              ${menuItem('data-action="boardOpenCopy"', 'fa-copy', '前の週の枠・シフトをコピー')}
              ${menuItem('data-action="openShiftRequests"', 'fa-hand', 'シフト希望')}
              ${reqShifts.length ? menuItem('data-action="boardConfirmRequested" title="表示中の希望（仮）のシフトをまとめて確定にします"', 'fa-check-double', `希望（仮）をまとめて確定<span class="badge badge-yellow ml-1">${reqShifts.length}</span>`) : ''}
              ${menuItem('data-action="boardPlacementExport" data-format="csv" title="表示中の期間・絞り込みの配置表（金額なし・未充足の枠と希望（仮）を含む）を CSV で出します"', 'fa-file-csv', '配置表CSV')}
              ${menuItem('data-action="boardPlacementExport" data-format="print" title="クライアント・現場リーダーに渡す配置表を、案件ごとに改ページして印刷します（金額は載せません）"', 'fa-print', '配置表を印刷')}
              ${menuItem(`data-action="openNologinBulk" data-date="${esc(nologinDefaultDate())}" data-project-id="${BS.projectIds.length === 1 ? Number(BS.projectIds[0]) : ''}" data-tab="links" title="ログインのないスタッフの報告用URLを、日付ごとにまとめて発行・コピーします（未発行・発行済み・未使用の別も出します）"`, 'fa-link', '報告用URL（ログインなし）')}
              ${menuItem('data-action="boardReloadMaster" title="案件・スタッフ・開催場所の一覧を読み直します"', 'fa-rotate', '一覧を更新')}
              <a class="board-menu-item" href="#shifts/week"><i class="fas fa-table-columns w-4 text-gray-400"></i>週表示（従来）</a>
            </div>
          </details>
        </div>
      </div>

      <section class="card p-3 mb-3 flex flex-wrap gap-2 items-center text-sm" id="board-filters">
        <div class="flex items-center gap-1 flex-wrap">
          <button class="btn btn-outline px-2.5" data-action="boardShiftPeriod" data-dir="-1" title="前の期間" aria-label="前の期間"><i class="fas fa-chevron-left"></i></button>
          <button class="btn btn-outline" data-action="boardToday">${BS.range === 'month' ? '今月' : '今週'}</button>
          <button class="btn btn-outline px-2.5" data-action="boardShiftPeriod" data-dir="1" title="次の期間" aria-label="次の期間"><i class="fas fa-chevron-right"></i></button>
          <input type="date" class="inp w-auto text-sm" value="${esc(BS.from)}" data-board-input="from" aria-label="表示する日">
          <span class="font-bold text-gray-700 ml-1 whitespace-nowrap">${esc(periodLabel)}</span>
        </div>
        <div class="board-segs" role="group" aria-label="期間">${seg('range', 'week', '週')}${seg('range', '2w', '2週間')}${seg('range', 'month', '月（カレンダー）')}</div>
        <div class="board-segs" role="group" aria-label="常勤・スポット">${seg('engagement', '', 'すべて')}${seg('engagement', 'regular', '常勤のみ')}${seg('engagement', 'spot', 'スポットのみ')}</div>
        <button type="button" class="board-toggle ${BS.onlyShort ? 'on' : ''}" data-action="boardToggleShort" aria-pressed="${!!BS.onlyShort}"><i class="fas fa-filter mr-1"></i>不足のみ</button>
        <select class="inp w-auto text-sm" data-board-input="clientId" aria-label="クライアント">
          <option value="">すべてのクライアント</option>
          ${m.clients.map(c => `<option value="${Number(c.client_id)}" ${String(BS.clientId) === String(c.client_id) ? 'selected' : ''}>${esc(c.client_name)}</option>`).join('')}
        </select>
        <details class="relative">
          <summary class="inp w-auto text-sm cursor-pointer select-none">案件 ${BS.projectIds.length ? `（${BS.projectIds.length}件選択）` : '（すべて）'}</summary>
          <div class="absolute z-20 bg-white border border-gray-200 rounded-lg shadow-lg p-2 mt-1 max-h-72 overflow-y-auto w-72">
            ${projOpts.map(p => `<label class="flex items-center gap-2 py-1 text-xs"><input type="checkbox" value="${Number(p.project_id)}" data-board-project ${BS.projectIds.includes(p.project_id) ? 'checked' : ''}>
              <span class="badge ${p.engagement_type === 'spot' ? 'badge-purple' : 'badge-blue'}">${p.engagement_type === 'spot' ? 'スポット' : '常勤'}</span>${esc(p.project_name)}</label>`).join('') || '<p class="text-xs text-gray-400">案件がありません</p>'}
            <button class="btn btn-primary w-full text-xs mt-2" data-action="boardApplyProjects">絞り込む</button>
          </div>
        </details>
        <span class="flex-1"></span>
        <div class="board-segs" role="group" aria-label="表示">${seg('view', 'slot', '案件ごと')}${seg('view', 'person', '人ごと')}</div>
        <label class="flex items-center gap-1 text-xs"><input type="checkbox" data-board-input="showMoney" ${BS.showMoney ? 'checked' : ''}>金額を表示</label>
      </section>

      <section class="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3" id="board-totals">
        <div class="card px-3 py-2"><p class="text-xs text-gray-500">充足</p><p class="text-lg font-bold ${fillRate != null && fillRate < 100 ? 'text-red-600' : ''}">${t.filled}/${t.required}${fillRate != null ? `<span class="text-xs font-normal text-gray-400 ml-1">${fillRate}%</span>` : ''}</p></div>
        ${BS.showMoney ? `
        <div class="card px-3 py-2"><p class="text-xs text-gray-500">請求合計</p><p class="text-lg font-bold">${yen(t.bill)}</p></div>
        <div class="card px-3 py-2"><p class="text-xs text-gray-500">支払合計</p><p class="text-lg font-bold">${yen(t.pay)}${t.pay_missing ? `<span class="text-xs text-amber-600 ml-1" title="支払単価が未設定のシフト">未設定${t.pay_missing}件</span>` : ''}</p></div>
        <div class="card px-3 py-2"><p class="text-xs text-gray-500">粗利</p><p class="text-lg font-bold ${t.profit < 0 ? 'text-red-600' : 'text-emerald-700'}">${yen(t.profit)}</p>${t.pay_missing ? `<p class="text-[10px] text-amber-600" title="支払単価が未設定のシフトは粗利に含めていません">支払未設定 ${Number(t.pay_missing)}件・請求 ${yen(t.pay_missing_bill)} を除外</p>` : ''}</div>
        <div class="card px-3 py-2"><p class="text-xs text-gray-500">粗利率</p><p class="text-lg font-bold">${t.profit_bill ? Math.round(t.profit / t.profit_bill * 1000) / 10 + '%' : '-'}</p>${t.pay_missing ? '<p class="text-[10px] text-gray-400">支払が決まっているシフトだけで計算</p>' : ''}</div>` : ''}
      </section>

      <div id="board-bulkbar" class="board-bulkbar" hidden></div>
      <div class="board-d ${BS.view === 'person' || BS.range === 'month' ? 'board-d-full' : ''}">
        <section class="card p-0 overflow-auto min-w-0" id="board-grid" style="max-height: calc(100vh - 250px)">${gridHtml(days)}</section>
        ${BS.view === 'person' || BS.range === 'month' ? '' : '<aside class="card p-3 board-side" id="board-side" aria-label="選んだ枠と候補のスタッフ"></aside>'}
      </div>
      <div id="board-savebar" class="board-savebar" hidden></div>`
    enableDnD()
    loadRequestCount()
    SIDE_PRICE.key = null
    renderSide()
    updateSaveBar()
    updateBulkBar()
    if (BS.sel && ROLE_IX.has(BS.sel)) loadCandidates(BS.sel)
  }
  function gridHtml(days) {
    if (BS.view === 'person') return personGrid(days)
    if (BS.range === 'month') return monthGrid(days)
    return slotGrid(days)
  }
  // 表と右の欄だけを描き直す（下書きの追加・取り消し。スクロールの位置を保つ）
  function redraw() {
    const g = document.getElementById('board-grid'); if (!g || !BOARD) return
    const st = g.scrollTop, sl = g.scrollLeft
    g.innerHTML = gridHtml(boardDays()); g.scrollTop = st; g.scrollLeft = sl
    enableDnD(); renderSide(); updateSaveBar(); updateBulkBar()
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
    // 不足のみ: 下書きを入れても足りない枠のある行だけ
    if (BS.onlyShort) list = list.filter(r => Object.values(r.cells).some(cs => cs.some(c => leftOf(c.role) > 0)))
    // 枠なし（常勤の従来登録）: 案件ごとに1行
    const plain = new Map()
    for (const s of b.unslotted) {
      const k = s.project_id + '|' + (s.site_name || s.location || '')
      if (!plain.has(k)) plain.set(k, { project_id: s.project_id, site: s.site_name || s.location || '', cells: {} })
      const r = plain.get(k); (r.cells[s.work_date] = r.cells[s.work_date] || []).push(s)
    }
    const w = BS.days > 7 ? 104 : 128
    const head = `<thead class="sticky top-0 z-10 bg-white"><tr>
      <th class="board-th text-left sticky left-0 z-20 bg-white" style="min-width:190px">案件 / 開催場所 / 役割</th>
      ${days.map(d => { const wd = dayjs(d).day(); return `<th class="board-th ${d === today ? 'bg-blue-50' : ''} ${wd === 0 ? 'text-red-500' : wd === 6 ? 'text-blue-500' : ''}" style="min-width:${w}px;width:${w}px">
        <button class="hover:underline" data-action="boardSlotOnDate" data-date="${esc(d)}" title="この日に枠を作成">${dayjs(d).format('M/D')}(${WD[wd]})</button>${nologinDayBtn(d)}${daySummary(d)}</th>` }).join('')}
    </tr></thead>`
    let lastProject = null
    const body = list.map(r => {
      const p = proj.get(r.project_id) || {}
      const header = lastProject !== r.project_id ? `<tr><td colspan="${days.length + 1}" class="board-group sticky left-0">
        <span class="badge ${p.engagement_type === 'spot' ? 'badge-purple' : 'badge-blue'}">${p.engagement_type === 'spot' ? 'スポット' : '常勤'}</span>
        <a href="#projects/${Number(p.project_id)}" class="font-bold hover:underline ml-1">${esc(p.project_name)}</a><span class="text-gray-400 ml-2">${esc(p.client_name || '')}</span></td></tr>` : ''
      lastProject = r.project_id
      return header + `<tr>
        <td class="board-rowhead sticky left-0 bg-white z-10"><p class="font-bold text-xs truncate">${esc(r.site || '（場所未設定）')}</p>
          <p class="text-[11px] text-gray-500">${esc(r.start)}〜${esc(r.end)}・<span class="font-bold text-gray-700">${esc(r.role)}</span></p></td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${w}px">${(r.cells[d] || []).map(c => slotCell(c.slot, c.role)).join('')}</td>`).join('')}
      </tr>`
    }).join('')
    const plainRows = BS.onlyShort ? '' : [...plain.values()].map(r => {
      const p = proj.get(r.project_id) || {}
      return `<tr><td class="board-rowhead sticky left-0 bg-white z-10"><p class="font-bold text-xs truncate"><span class="badge badge-gray mr-1">枠なし</span>${esc(p.project_name || '')}</p>
        <p class="text-[11px] text-gray-500 truncate">${esc(r.site)}</p></td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${w}px">${(r.cells[d] || []).map(s => staffChip(s)).join('')}</td>`).join('')}</tr>`
    }).join('')
    if (!list.length && !plainRows) return `<div class="p-10 text-center text-sm text-gray-400">
      ${BS.onlyShort ? 'この期間に不足の枠はありません' : 'この期間の枠・シフトはありません'}<br><button class="btn btn-primary mt-3" data-action="boardNewSlot"><i class="fas fa-plus"></i>枠を作成</button></div>`
    return `<table class="board-table">${head}<tbody>${body}${plainRows ? `<tr><td colspan="${days.length + 1}" class="board-group sticky left-0 text-gray-500">枠を使わないシフト（従来の登録）</td></tr>` + plainRows : ''}</tbody></table>`
  }

  // 月のカレンダー（月曜始まり）。日ごとに案件の充足を出し、不足は赤くする。日付を押すとその週の表に切り替える
  function monthGrid(days) {
    const proj = new Map(BOARD.projects.map(p => [p.project_id, p]))
    const byDate = {}
    for (const s of BOARD.slots) for (const r of s.roles) {
      const m = byDate[s.work_date] = byDate[s.work_date] || new Map()
      const x = m.get(s.project_id) || { req: 0, fill: 0 }
      x.req += Number(r.headcount); x.fill += Math.min(Number(r.filled), Number(r.headcount)); m.set(s.project_id, x)
    }
    const plain = {}
    for (const a of BOARD.unslotted) if (a.status !== 'absent') plain[a.work_date] = (plain[a.work_date] || 0) + 1
    const today = dayjs().format('YYYY-MM-DD')
    let h = ['月', '火', '水', '木', '金', '土', '日'].map((x, i) => `<div class="board-cal-dow ${i === 5 ? 'text-blue-500' : i === 6 ? 'text-red-500' : ''}">${x}</div>`).join('')
    for (let i = 0; i < (dayjs(days[0]).day() + 6) % 7; i++) h += '<div class="board-cal-day out" aria-hidden="true"></div>'
    for (const d of days) {
      let lines = [...(byDate[d] || new Map()).entries()].map(([pid, x]) => ({ p: proj.get(pid) || {}, ...x, short: x.req - x.fill }))
      if (BS.onlyShort) lines = lines.filter(l => l.short > 0)
      lines.sort((a, b) => b.short - a.short || String(a.p.project_name || '').localeCompare(b.p.project_name || ''))
      const tot = (BOARD.totals.by_date || {})[d]
      const wd = dayjs(d).day()
      h += `<div class="board-cal-day ${d === today ? 'is-today' : ''}" data-action="boardCalDay" data-date="${esc(d)}" tabindex="0" role="button" aria-label="${esc(fmtDay(d))}を含む週を表示">
        <div class="flex items-center justify-between gap-1"><span class="text-xs font-bold ${wd === 0 ? 'text-red-500' : wd === 6 ? 'text-blue-500' : 'text-gray-700'}">${dayjs(d).format('M/D')}</span>
          ${tot && tot.required ? `<span class="text-[10px] font-bold ${tot.filled < tot.required ? 'text-red-600' : 'text-emerald-700'}">${Number(tot.filled)}/${Number(tot.required)}</span>` : ''}</div>
        ${lines.slice(0, 4).map(l => `<div class="board-cal-line ${l.short > 0 ? 'short' : ''}" title="${esc(l.p.project_name || '')} ${l.fill}/${l.req}${l.short > 0 ? `（${l.short}人不足）` : ''}"><span class="truncate">${l.p.engagement_type === 'spot' ? 'ス' : '常'} ${esc(l.p.project_name || '')}</span><span class="shrink-0">${l.fill}/${l.req}</span></div>`).join('')}
        ${lines.length > 4 ? `<div class="text-[10px] text-gray-400">ほか${lines.length - 4}件</div>` : ''}
        ${plain[d] && !BS.onlyShort ? `<div class="text-[10px] text-gray-400">枠なしのシフト ${plain[d]}件</div>` : ''}
      </div>`
    }
    return `<div class="board-cal p-2">${h}</div><p class="text-[11px] text-gray-400 px-3 pb-2">日付を押すと、その日を含む週の表に切り替わります（割り当てはそこで行います）。「常」は常勤、「ス」はスポットの案件です</p>`
  }


  delegate('boardSlotOnDate', el => openSlotModal({ work_date: el.dataset.date }))
  // ログインのない人の報告用URLのまとめての発行（#275。画面は staff-lifecycle.js の openNologinBulk）。
  // 既定の日付は、表示中の期間に今日があれば今日、なければ期間の初日。案件を1つだけ選んでいればその案件で開く
  function nologinDefaultDate() {
    const today = dayjs().format('YYYY-MM-DD'); const r = boardRange()
    return today >= r.from && today <= r.to ? today : r.from
  }
  function nologinDayBtn(d) {
    return `<button class="ml-1 text-[10px] text-gray-400 hover:text-blue-600" data-action="openNologinBulk" data-date="${esc(d)}" data-project-id="${BS.projectIds.length === 1 ? Number(BS.projectIds[0]) : ''}" data-tab="links" title="この日のログインのない人の報告用URLをまとめて発行・コピー" aria-label="${esc(dayjs(d).format('M/D'))}の報告用URL（ログインなし）"><i class="fas fa-link"></i></button>`
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
      <p class="text-xs text-gray-500 mb-2">必要人数に足りない枠です（表示中の絞り込みの範囲）。「選ぶ」を押すと、その枠の候補を右の欄に出します</p>
      <div class="max-h-[60vh] overflow-y-auto divide-y divide-gray-100">
        ${rows.map(({ s, r }) => `<div class="flex items-center gap-2 py-2 text-sm">
          <div class="flex-1 min-w-0"><p class="font-bold truncate">${esc((proj.get(s.project_id) || {}).project_name || '')}</p>
            <p class="text-xs text-gray-500">${esc(s.start_time)}〜${esc(s.end_time)}・${esc(s.site_name || s.location || '')}・${esc(r.role_name)}</p></div>
          <span class="text-xs font-bold text-red-600 whitespace-nowrap">${Number(r.filled)}/${Number(r.headcount)}${r.requested ? `<span class="text-amber-600 ml-1">希望${Number(r.requested)}</span>` : ''}</span>
          <button class="btn btn-outline text-xs" data-action="boardPickRole" data-id="${Number(r.slot_role_id)}">選ぶ</button></div>`).join('') || '<p class="p-3 text-sm text-gray-400">不足の枠はありません</p>'}
      </div>`)
  }
  delegate('boardDayShort', el => openDayShort(el.dataset.date))
  // 不足の一覧から枠を選ぶ（表の案件ごとの表示に切り替えて、右の欄に候補を出す）
  delegate('boardPickRole', (el) => {
    const rid = Number(el.dataset.id)
    closeModal()
    if (BS.view !== 'slot') { BS.view = 'slot'; BS.sel = rid; renderShiftBoard(); return }
    selectRole(rid)
    const cell = document.querySelector(`.board-cell[data-id="${rid}"]`)
    if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })

  // 枠の役割のマス。割り当て済みの人・下書き（色を変える）・「n人不足／充足 n/n」を出す。マスを押すと右の欄に候補を出す
  // 下書きは、問題（保存のときの確認で止まったもの）のないものを充足の見込みに数える（希望（仮）は数えない）
  const plannedOf = (rid) => draftsOf(rid).filter(d => d.status !== 'requested' && !d.problem).length
  const leftOf = (role) => Number(role.headcount) - Number(role.filled) - plannedOf(role.slot_role_id)
  function slotCell(slot, role) {
    const drafts = draftsOf(role.slot_role_id)
    const left = leftOf(role)
    const over = left < 0
    const sel = BS.sel === role.slot_role_id
    const bulk = !!BS.bulkDel, checked = bulk && BULK.has(slot.slot_id)
    const money = BS.showMoney ? role.assigned.filter(a => ['confirmed', 'substitute'].includes(a.status)).reduce((x, a) => x + (a.bill_total || 0), 0) : 0
    const need = left > 0 ? `<span class="board-need short">${left}人不足</span>`
      : `<span class="board-need ${over ? 'over' : 'full'}">${over ? '定員超過' : '充足'} ${Number(role.filled) + plannedOf(role.slot_role_id)}/${Number(role.headcount)}</span>`
    // 『不足のみ』では、同じ行の不足していない日のマスを薄く出す
    return `<div class="board-cell ${left > 0 ? 'board-short' : over ? 'board-over' : 'board-ok'} ${sel ? 'is-sel' : ''} ${BS.onlyShort && left <= 0 ? 'opacity-40' : ''} ${checked ? 'is-bulk' : ''}" data-action="boardSelect" data-slot-id="${Number(slot.slot_id)}" data-id="${Number(role.slot_role_id)}" data-slot-role-id="${Number(role.slot_role_id)}"
      tabindex="0" role="button" aria-pressed="${sel}" aria-label="${esc(`${fmtDay(slot.work_date)} ${slot.start_time}〜${slot.end_time} ${role.role_name} ${left > 0 ? left + '人不足' : '充足'}`)}">
      <div class="flex items-center justify-between gap-1 mb-1">
        <span class="text-[11px] font-bold ${left > 0 ? 'text-red-600' : 'text-emerald-700'}">${bulk ? `<input type="checkbox" class="bulk-check" data-action="boardBulkCheck" data-slot-id="${Number(slot.slot_id)}" ${checked ? 'checked' : ''} aria-label="${esc(`${fmtDay(slot.work_date)} ${slot.start_time}〜${slot.end_time} ${projectOf(slot.project_id).project_name || ''} の枠を選ぶ`)}">` : ''}${Number(role.filled)}/${Number(role.headcount)}${role.requested ? `<span class="text-amber-600 ml-1">希望${Number(role.requested)}</span>` : ''}${role.applicants ? `<a href="#recruit/slot-${Number(role.slot_role_id)}" class="text-[10px] ml-1 px-1 rounded bg-red-100 text-red-700" title="この枠の未対応の応募を開く">応募${Number(role.applicants)}</a>` : ''}</span>
        <span class="flex items-center gap-0.5">
          ${BS.showMoney && money ? `<span class="text-[10px] text-gray-400">${yen(money)}</span>` : ''}
          ${bulk ? '' : `<button type="button" class="cell-tool" data-action="boardEditSlot" data-id="${Number(slot.slot_id)}" title="枠を編集" aria-label="枠を編集"><i class="fas fa-pen"></i></button>
          <button type="button" class="cell-tool danger" data-action="boardDeleteSlot" data-id="${Number(slot.slot_id)}" title="枠を削除" aria-label="枠を削除"><i class="fas fa-trash"></i></button>`}
        </span>
      </div>
      <div class="board-drop space-y-0.5" data-slot-role-id="${Number(role.slot_role_id)}">${role.assigned.map(a => staffChip(a)).join('')}</div>
      ${drafts.length ? `<div class="space-y-0.5 mt-0.5">${drafts.map(draftChip).join('')}</div>` : ''}
      <div class="mt-1">${need}</div>
      ${role.requested ? `<button class="block w-full text-[10px] text-amber-700 hover:underline mt-0.5" data-action="boardConfirmRequested" data-slot-role-id="${Number(role.slot_role_id)}" title="この役割の希望（仮）を確定にします">希望${Number(role.requested)}件を確定</button>` : ''}
    </div>`
  }
  // 下書きの人。保存のときに止まった行は赤くし、理由を出す
  function draftChip(d) {
    const bad = d.problem
    return `<div class="board-chip chip-draft ${bad ? 'chip-draft-bad' : ''}" title="${esc(bad ? bad.reasons.join('\n') : '下書き（まだ保存していません）' + (d.status === 'requested' ? '・希望（仮）で登録' : ''))}">
      <span class="truncate">${bad ? '<i class="fas fa-triangle-exclamation mr-0.5"></i>' : '<i class="fas fa-pen-to-square mr-0.5"></i>'}${esc(d.staff_name)}${d.status === 'requested' ? '<span class="text-[10px] text-amber-700 ml-0.5">仮</span>' : ''}</span>
      <button type="button" class="shrink-0 text-[11px] text-gray-500 hover:text-red-600 px-0.5" data-action="boardDraftRemove" data-id="${Number(d.slot_role_id)}" data-staff-id="${Number(d.staff_id)}" title="下書きを取り消す" aria-label="${esc(d.staff_name)}の下書きを取り消す"><i class="fas fa-xmark"></i></button>
    </div>${bad ? `<p class="text-[10px] text-red-600 leading-tight mb-0.5">${esc(bad.reasons[0])}${bad.reasons.length > 1 ? ` ほか${bad.reasons.length - 1}件` : ''}</p>` : ''}`
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
    return `<div class="board-chip shift-chip st-${a.status} ${warn ? 'chip-warn' : ''}" data-shift-id="${a.shift_id}" title="${esc(title)}" data-action="boardShiftDetail" data-id="${Number(a.shift_id)}">
      <span class="truncate">${warn ? '<i class="fas fa-triangle-exclamation text-red-500 mr-0.5"></i>' : ''}${esc(a.staff_name)}</span>
      <span class="text-[10px] shrink-0">${unavailableMark(a)}${a.status !== 'confirmed' ? ST_LABEL[a.status] || '' : ''}${replyMark(a)}${a.price_locked ? '<i class="fas fa-pen text-gray-400 ml-0.5" title="金額を手動変更"></i>' : ''}${BS.showMoney && a.pay_total == null && ['confirmed', 'substitute'].includes(a.status) ? '<i class="fas fa-yen-sign text-amber-500 ml-0.5" title="支払単価未設定"></i>' : ''}</span>
    </div>`
  }

  // 人ごと表示。期間中にシフトのない人も行に出し（割り当てられるスタッフ全員。#468）、稼働は確定・代打のある日数で数える（#258）
  function personGrid(days) {
    const all = [...BOARD.slots.flatMap(s => s.roles.flatMap(r => r.assigned.map(a => ({ ...a, _site: s.site_name || s.location })))), ...BOARD.unslotted.map(a => ({ ...a, _site: a.site_name || a.location }))]
    const byStaff = new Map()
    for (const s of (MASTER && MASTER.staff) || []) byStaff.set(s.staff_id, { name: s.name, aff: s.affiliation_type, emp: s.employment_status, cells: {} })
    for (const a of all) { if (!byStaff.has(a.staff_id)) byStaff.set(a.staff_id, { name: a.staff_name, aff: a.affiliation_type, cells: {} }); const r = byStaff.get(a.staff_id); (r.cells[a.work_date] = r.cells[a.work_date] || []).push(a) }
    const proj = new Map(BOARD.projects.map(p => [p.project_id, p]))
    const isActive = (a) => ['confirmed', 'substitute'].includes(a.status)
    for (const r of byStaff.values()) {
      const cs = Object.values(r.cells)
      r.workDays = cs.filter(list => list.some(isActive)).length
      r.workShifts = cs.flat().filter(isActive).length
      r.total = cs.flat().filter(a => a.status !== 'absent').length
    }
    let rows = [...byStaff.entries()]
    if (BS.personIdleOnly) rows = rows.filter(([, r]) => !r.total)
    rows.sort((a, b) => (BS.personSort === 'fewest' ? a[1].workDays - b[1].workDays || a[1].total - b[1].total : 0) || String(a[1].name).localeCompare(b[1].name))
    const tools = `<div class="flex flex-wrap items-center gap-3 px-3 py-2 text-xs border-b border-gray-100 sticky left-0 bg-white">
      <label class="flex items-center gap-1">並び<select class="inp text-xs w-auto" data-person-opt="personSort">
        <option value="name" ${BS.personSort !== 'fewest' ? 'selected' : ''}>名前順</option><option value="fewest" ${BS.personSort === 'fewest' ? 'selected' : ''}>稼働が少ない順</option></select></label>
      <label class="flex items-center gap-1"><input type="checkbox" data-person-opt="personIdleOnly" ${BS.personIdleOnly ? 'checked' : ''}>期間中にシフトのない人のみ</label>
      <span class="text-gray-400">稼働 = 確定・代打のある日数（表示中の案件の範囲）</span></div>`
    if (!rows.length) return tools + `<div class="p-10 text-center text-sm text-gray-400">${BS.personIdleOnly ? 'シフトのない人はいません' : 'この期間のシフトはありません'}</div>`
    const today = dayjs().format('YYYY-MM-DD')
    return tools + `<table class="board-table"><thead class="sticky top-0 z-10 bg-white"><tr>
      <th class="board-th text-left sticky left-0 z-20 bg-white" style="min-width:170px">スタッフ</th><th class="board-th">稼働</th>
      ${days.map(d => { const w = dayjs(d).day(); return `<th class="board-th ${d === today ? 'bg-blue-50' : ''} ${w === 0 ? 'text-red-500' : w === 6 ? 'text-blue-500' : ''}" style="min-width:${BS.days > 14 ? 86 : 118}px;max-width:${BS.days > 14 ? 86 : 118}px;width:${BS.days > 14 ? 86 : 118}px">${dayjs(d).format('M/D')}(${WD[w]})${nologinDayBtn(d)}${daySummary(d)}</th>` }).join('')}
    </tr></thead><tbody>${rows.map(([sid, r]) => {
      return `<tr><td class="board-rowhead sticky left-0 bg-white z-10"><a href="#staff/${Number(sid)}" class="text-xs font-bold hover:underline">${esc(r.name)}</a> <span class="text-[10px] text-gray-400">${AFF_SHORT[r.aff] || ''}</span>${r.emp === 'leave' ? '<span class="text-[10px] text-amber-600 ml-1">休職中</span>' : ''}</td>
        <td class="board-td text-center text-xs ${r.workDays ? 'font-bold' : 'text-gray-400'}">${r.workDays}日${r.workShifts > r.workDays ? `<span class="block text-[10px] font-normal text-gray-500">${r.workShifts}シフト</span>` : ''}</td>
        ${days.map(d => `<td class="board-td align-top" style="max-width:${BS.days > 14 ? 86 : 118}px">${(r.cells[d] || []).map(a => {
          const p = proj.get(a.project_id) || {}
          const warn = (a.conflicts && a.conflicts.length) || a.ng || (a.unavailable && a.status !== 'absent')
          return `<div class="board-chip st-${a.status} ${warn ? 'chip-warn' : ''} flex-col items-start" onclick="openShiftDetail(${a.shift_id})" title="${esc(p.project_name + ' / ' + (a._site || ''))}">
            <span class="truncate w-full text-[11px] font-bold">${warn ? '<i class="fas fa-triangle-exclamation text-red-500 mr-0.5"></i>' : ''}${unavailableMark(a)}${esc(p.project_name || '')}${replyMark(a)}</span>
            <span class="truncate w-full text-[10px] text-gray-500">${esc(a._site || '')} ${esc(a.start_time)}〜${esc(a.end_time)}</span></div>` }).join('')}</td>`).join('')}</tr>`
    }).join('')}</tbody></table>`
  }

  // ---------- ボード操作 ----------
  const PERIOD_KEYS = ['from', 'days', 'range']
  window.boardSet = function (k, v) {
    if (PERIOD_KEYS.includes(k) && String(BS[k]) !== String(v) && !confirmDiscardDrafts('表示する期間を切り替える')) return
    if (PERIOD_KEYS.includes(k)) BS.sel = null
    BS[k] = v; renderShiftBoard()
  }
  window.boardShift = function (dir) {
    if (!confirmDiscardDrafts('表示する期間を切り替える')) return
    BS.from = BS.range === 'month' ? dayjs(BS.from).add(dir, 'month').startOf('month').format('YYYY-MM-DD') : dayjs(BS.from).add(dir * BS.days, 'day').format('YYYY-MM-DD')
    BS.sel = null; renderShiftBoard()
  }
  window.boardToday = function () {
    if (!confirmDiscardDrafts('表示する期間を切り替える')) return
    BS.from = BS.range === 'month' ? dayjs().startOf('month').format('YYYY-MM-DD') : weekStart(dayjs())
    BS.sel = null; renderShiftBoard()
  }
  window.boardToggleProject = function (id, on) { BS.projectIds = on ? [...new Set([...BS.projectIds, id])] : BS.projectIds.filter(x => x !== id) }
  window.boardFilterStaff = function (q) {
    document.querySelectorAll('#board-staff-list .staff-src').forEach(el => { el.style.display = !q || el.dataset.name.includes(q) ? '' : 'none' })
  }
  // 人ごと表示の並び・絞り込み（#468）
  document.addEventListener('change', (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-person-opt]') : null
    if (el) boardSet(el.dataset.personOpt, el.type === 'checkbox' ? el.checked : el.value)
  })
  const closeBoardMenu = () => document.querySelectorAll('.board-menu[open]').forEach(d => { d.open = false })
  delegate('boardShiftPeriod', el => boardShift(Number(el.dataset.dir) || 1))
  delegate('boardToday', () => boardToday())
  delegate('boardSeg', (el) => {
    const k = el.dataset.key, v = el.dataset.val
    if (!['range', 'engagement', 'view'].includes(k) || String(BS[k] || '') === v) return
    if (k === 'range') return boardSet('range', v)
    BS[k] = v; renderShiftBoard()
  })
  delegate('boardToggleShort', () => { BS.onlyShort = !BS.onlyShort; renderShiftBoard() })
  delegate('boardApplyProjects', () => renderShiftBoard())
  delegate('boardNewSlot', () => openSlotModal())
  delegate('boardOpenBulk', () => openBulkModal())
  delegate('boardOpenPattern', () => { closeBoardMenu(); openPatternModal() })
  delegate('boardOpenCopy', () => { closeBoardMenu(); openCopyModal() })
  delegate('boardReloadMaster', () => { closeBoardMenu(); boardReloadMaster() })
  delegate('boardShiftDetail', el => openShiftDetail(Number(el.dataset.id)))
  delegate('boardEditSlot', async (el) => {
    await openSlotModal(null, Number(el.dataset.id))
    // 右の欄の「この枠だけ単価を変える」から開いたときは、単価の欄へ移る
    if (el.dataset.focus === 'price') { const f = document.querySelector('.rr-bill'); if (f) { f.scrollIntoView({ block: 'center' }); f.focus() } }
  })
  delegate('boardCalDay', (el) => {
    if (!confirmDiscardDrafts('週の表に切り替える')) return
    BS.range = 'week'; BS.from = weekStart(el.dataset.date); BS.sel = null; renderShiftBoard()
  })
  document.addEventListener('change', (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-board-input], [data-board-project]') : null
    if (!el) return
    if (el.hasAttribute('data-board-project')) { boardToggleProject(Number(el.value), el.checked); return }
    const k = el.dataset.boardInput
    if (k === 'from') {
      if (!el.value) return
      if (el.value !== BS.from && !confirmDiscardDrafts('表示する期間を切り替える')) { el.value = BS.from; return }
      BS.from = el.value; BS.sel = null; renderShiftBoard()
    } else if (k === 'clientId') { BS.clientId = el.value; BS.projectIds = []; renderShiftBoard() }
    else if (k === 'showMoney') { BS.showMoney = el.checked; renderShiftBoard() }
    else if (k === 'draftStatus') BS.draftStatus = el.value === 'requested' ? 'requested' : 'confirmed'
    else if (k === 'candSkill') { BS.cf.skill = el.value; drawCand() }
    else if (k === 'inherit') {
      // 前回のシフトの単価を引き継ぐか（この枠の下書きと、これから入れる下書きに当てる）
      const rid = BS.sel; if (!rid) return
      if (el.checked) delete BS.noInherit[rid]; else BS.noInherit[rid] = true
      for (const d of draftsOf(rid)) d.inherit = el.checked
      const x = ROLE_IX.get(rid); const box = document.getElementById('side-price')
      if (x && box) box.innerHTML = sidePriceHtml(x)
    }
  })
  document.addEventListener('input', (ev) => {
    if (!ev.target || ev.target.id !== 'cand-q') return
    BS.cf.q = ev.target.value
    const l = document.getElementById('cand-list'); if (l) l.innerHTML = candListHtml()
  })
  // 表のマス・カレンダーの日は、Enter・スペースでも選べる
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const el = ev.target
    if (!el || !el.matches || !el.matches('.board-cell[data-action], .board-cal-day[data-action]')) return
    ev.preventDefault(); el.click()
  })
  // メニューの項目を押したら閉じる
  document.addEventListener('click', (ev) => {
    const it = ev.target && ev.target.closest ? ev.target.closest('.board-menu-item') : null
    if (it) setTimeout(closeBoardMenu, 0)
  })

  // =========================================================
  // 下書き（#9402）: 候補を押すと、保存せずに表へ下書きとして入れる。「まとめて保存」で1回で登録する
  // =========================================================
  const DRAFTS = window.__boardDrafts = window.__boardDrafts || new Map()
  const dKey = (rid, sid) => `${Number(rid)}:${Number(sid)}`
  function draftsOf(rid) { const out = []; for (const d of DRAFTS.values()) if (d.slot_role_id === Number(rid)) out.push(d); return out }
  // 期間の切り替え・画面の移動の前に、保存していない下書きを確かめる。続けるときは下書きを消す
  function confirmDiscardDrafts(what) {
    if (!DRAFTS.size) return true
    if (!confirm(`保存していない下書きが${DRAFTS.size}件あります。\n${what}と、下書きは消えます。よろしいですか？\n（残すときは「キャンセル」を押し、「まとめて保存」で保存してください）`)) return false
    DRAFTS.clear(); return true
  }
  window.boardHasDrafts = () => DRAFTS.size > 0
  // ページを閉じる・再読み込みするとき
  window.addEventListener('beforeunload', (ev) => { if (DRAFTS.size) { ev.preventDefault(); ev.returnValue = '' } })
  // 画面の移動（メニュー・リンク・戻る）。やめたときは元の URL に戻し、画面を切り替えない（true = 切り替えてよい）
  function leaveGuard(ev) {
    if (!DRAFTS.size) return true
    const tabOf = (u) => { try { return decodeURIComponent((new URL(u).hash || '').slice(1)) } catch (e) { return '' } }
    if (tabOf(ev.oldURL) !== 'shifts' || tabOf(ev.newURL) === 'shifts') return true
    if (confirmDiscardDrafts('この画面を離れる')) return true
    history.replaceState(null, '', ev.oldURL)
    const mob = document.getElementById('mobile-nav'); if (mob) mob.value = 'shifts'
    return false
  }
  // admin.js（先に読み込む）が登録した route の hashchange を、確認を挟んだものに差し替える
  if (typeof window.route === 'function') {
    const route0 = window.route
    window.removeEventListener('hashchange', route0)
    window.addEventListener('hashchange', (ev) => { if (leaveGuard(ev)) route0() })
  } else {
    window.addEventListener('hashchange', (ev) => { if (!leaveGuard(ev)) ev.stopImmediatePropagation() }, true)
  }
  // 読み直したら、ほかの経路ですでに割り当てた人の下書きを外す（同じ人を二重に送らない）
  function pruneDrafts() {
    for (const [k, d] of DRAFTS) {
      const x = ROLE_IX.get(d.slot_role_id)
      if (x && x.role.assigned.some(a => a.staff_id === d.staff_id && a.status !== 'absent')) DRAFTS.delete(k)
    }
  }
  const toMin = (t) => { const [h, mm] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (mm || 0) }
  const spanOf = (s, e) => { const a = toMin(s); let b = toMin(e); if (b <= a) b += 1440; return [a, b] }
  // 同じ日の、時間が重なるほかの枠の下書き（スタッフ → 案件名）
  function draftsOverlapping(slot, rid) {
    const out = new Map(); const [a, b] = spanOf(slot.start_time, slot.end_time)
    for (const d of DRAFTS.values()) {
      if (d.slot_role_id === rid || d.work_date !== slot.work_date) continue
      const [c, e] = spanOf(d.start_time, d.end_time)
      if (c < b && a < e) out.set(d.staff_id, (projectOf(d.project_id).project_name || '') + ' ' + d.start_time + '〜' + d.end_time)
    }
    return out
  }
  delegate('boardDraftAdd', (el) => {
    const x = ROLE_IX.get(BS.sel); if (!x || !CAND.data || CAND.rid !== BS.sel) return
    const sid = Number(el.dataset.staffId)
    const c = CAND.data.candidates.find(y => y.staff_id === sid); if (!c) return
    const rid = x.role.slot_role_id, k = dKey(rid, sid)
    if (DRAFTS.has(k)) { toast(`${c.name} さんはすでに下書きにあります`); return }
    if (BS.draftStatus !== 'requested' && leftOf(x.role) <= 0 && !confirm('この枠は必要人数に達しています。定員を超えて下書きに入れますか？')) return
    DRAFTS.set(k, {
      slot_role_id: rid, staff_id: sid, staff_name: c.name, project_id: x.slot.project_id, role_name: x.role.role_name,
      work_date: x.slot.work_date, start_time: x.slot.start_time, end_time: x.slot.end_time,
      status: BS.draftStatus, inherit: !BS.noInherit[rid], force: false, problem: null,
    })
    toast(`${c.name} さんを下書きに入れました（まだ保存していません）`)
    redraw()
  })
  delegate('boardDraftRemove', (el) => { DRAFTS.delete(dKey(el.dataset.id, el.dataset.staffId)); redraw() })
  delegate('boardDiscardDrafts', () => {
    if (!DRAFTS.size || !confirm(`保存していない下書き${DRAFTS.size}件をすべて取り消しますか？`)) return
    DRAFTS.clear(); redraw()
  })
  function updateSaveBar() {
    const n = DRAFTS.size
    let bad = 0; for (const d of DRAFTS.values()) if (d.problem) bad++
    document.querySelectorAll('.board-draft-count').forEach(el => { el.textContent = String(n) })
    const top = document.getElementById('board-save-top'); if (top && top.dataset.busy !== '1') top.disabled = !n
    const bar = document.getElementById('board-savebar'); if (!bar) return
    bar.hidden = !n
    bar.innerHTML = n ? `<span class="text-sm"><i class="fas fa-pen-to-square mr-1 text-emerald-600"></i>下書き <b>${n}</b>件（まだ保存していません）${bad ? `<span class="text-red-600 font-bold ml-1">要確認 ${bad}件</span>` : ''}</span>
      <button class="btn btn-outline text-xs py-1.5" data-action="boardDiscardDrafts">下書きを取り消す</button>
      <button class="btn board-save-btn text-xs py-1.5" data-action="boardSaveDrafts"><i class="fas fa-floppy-disk"></i>まとめて保存（${n}件）</button>` : ''
  }

  // ---------- まとめて保存 ----------
  // 案件 × 役割の種類が多いときは分けて送る（サーバーは1回に8種類まで。ここでは余裕をみて6種類・200件ずつ）
  const SAVE_GROUPS = 6, SAVE_ITEMS = 200
  let SAVING = false
  async function saveDrafts(only) {
    if (SAVING) return
    const list = only || [...DRAFTS.values()]
    if (!list.length) { toast('保存する下書きがありません'); return }
    SAVING = true
    const chunks = []; let cur = [], groups = new Set()
    for (const d of list) {
      const g = d.project_id + '|' + d.role_name
      if (cur.length && ((!groups.has(g) && groups.size >= SAVE_GROUPS) || cur.length >= SAVE_ITEMS)) { chunks.push(cur); cur = []; groups = new Set() }
      cur.push(d); groups.add(g)
    }
    if (cur.length) chunks.push(cur)
    let created = 0, inherited = 0, error = null
    const problems = []
    try {
      for (const part of chunks) {
        let data
        try {
          data = (await axios.post('/api/admin/shift-slots/assign-batch', { items: part.map(d => ({ slot_role_id: d.slot_role_id, staff_id: d.staff_id, status: d.status, inherit: d.inherit !== false, force: !!d.force })) })).data
        } catch (e) {
          error = e.response ? errMsg(e) : '通信できませんでした。接続を確かめて、もう一度「まとめて保存」を押してください'
          break
        }
        for (const x of data.created || []) { DRAFTS.delete(dKey(x.slot_role_id, x.staff_id)); created++ }
        inherited += Number(data.inherited || 0)
        for (const pr of data.problems || []) {
          const d = DRAFTS.get(dKey(pr.slot_role_id, pr.staff_id))
          if (d) { d.problem = { reasons: pr.reasons || [], can_force: !!pr.can_force }; d.force = false; problems.push(d) }
        }
      }
    } finally { SAVING = false }
    await renderShiftBoard()
    const okText = `${created}件を登録しました` + (inherited ? `（${inherited}件は前回のシフトの単価を引き継ぎ）` : '')
    if (error) { alert(`${created ? okText + '。' : ''}残りの下書きは保存できませんでした。\n${error}\n\n保存できなかった下書きは表に残っています。`); return }
    if (problems.length) showSaveProblems(problems, created, inherited)
    else toast(okText)
  }
  let LAST_SAVE = { created: 0, inherited: 0 }
  function showSaveProblems(problems, created, inherited) {
    LAST_SAVE = { created, inherited }
    const forceable = problems.filter(d => d.problem.can_force)
    modal(`
      <h3 class="font-bold text-lg mb-1">まとめて保存</h3>
      <p class="text-sm text-gray-700 mb-2">${created ? `${Number(created)}件を登録しました${inherited ? `（${Number(inherited)}件は前回のシフトの単価を引き継ぎ）` : ''}。` : ''}次の${problems.length}件は登録していません（表に<span class="text-red-600 font-bold">赤い下書き</span>として残しています）</p>
      <div class="max-h-72 overflow-y-auto border border-gray-100 rounded-lg"><table class="tbl text-xs"><thead><tr><th>日付</th><th>枠</th><th>スタッフ</th><th>理由</th></tr></thead><tbody>
        ${problems.map(d => `<tr class="${d.problem.can_force ? '' : 'bg-red-50'}"><td class="whitespace-nowrap">${esc(fmtDay(d.work_date))}</td>
          <td>${esc(projectOf(d.project_id).project_name || '')}<span class="block text-gray-400">${esc(d.start_time)}〜${esc(d.end_time)}・${esc(d.role_name)}</span></td>
          <td class="whitespace-nowrap">${esc(d.staff_name)}</td><td>${d.problem.reasons.map(r => `<span class="block">${esc(r)}</span>`).join('')}${d.problem.can_force ? '<span class="badge badge-yellow mt-0.5">確認すれば登録できます</span>' : '<span class="badge badge-red mt-0.5">登録できません</span>'}
            <button type="button" class="block text-[11px] text-gray-500 hover:text-red-600 underline mt-0.5" data-action="boardProblemRemove" data-id="${Number(d.slot_role_id)}" data-staff-id="${Number(d.staff_id)}">この下書きを取り消す</button></td></tr>`).join('')}
      </tbody></table></div>
      <p class="text-[11px] text-gray-400 mt-2">登録できない下書きは、ここの「この下書きを取り消す」か表の下書きの「×」で取り消し、ほかの人を選んでください（表に出ていない枠の下書きも、ここで取り消せます）</p>
      ${forceable.length ? `<button class="btn btn-primary w-full mt-3" data-action="boardSaveForce"><i class="fas fa-check"></i>警告を確認しました。このまま登録する（${forceable.length}件）</button>` : ''}
      <button class="btn btn-outline w-full mt-2" onclick="closeModal()">閉じる</button>`)
  }
  // 保存の結果の一覧から下書きを取り消す（削除された枠・絞り込みで表に出ていない枠の下書きは、表の「×」が出ないため）
  delegate('boardProblemRemove', (el) => {
    DRAFTS.delete(dKey(el.dataset.id, el.dataset.staffId)); redraw()
    const rest = [...DRAFTS.values()].filter(d => d.problem)
    if (rest.length) showSaveProblems(rest, LAST_SAVE.created, LAST_SAVE.inherited); else closeModal()
  })
  delegate('boardSaveDrafts', el => withSubmitLock(el, () => saveDrafts()))
  delegate('boardSaveForce', el => withSubmitLock(el, async () => {
    const list = [...DRAFTS.values()].filter(d => d.problem && d.problem.can_force)
    for (const d of list) d.force = true
    closeModal()
    await saveDrafts(list)
  }))

  // =========================================================
  // 右の欄（#9401）: 選んだマスの案件・日付・常勤/スポット・残り人数、引き継ぐ単価、候補のスタッフ
  // =========================================================
  let CAND = { rid: null, data: null, error: null, seq: 0 }
  let SIDE_PRICE = { key: null, data: null, error: null }
  const CAND_MAX = 60
  delegate('boardSelect', (el) => {
    if (BS.bulkDel) { toggleBulk(Number(el.dataset.slotId), !BULK.has(Number(el.dataset.slotId))); return }
    selectRole(Number(el.dataset.id))
  })
  function selectRole(rid) {
    if (!ROLE_IX.has(rid)) return
    BS.sel = rid
    document.querySelectorAll('.board-cell.is-sel').forEach(x => { x.classList.remove('is-sel'); x.setAttribute('aria-pressed', 'false') })
    document.querySelectorAll(`.board-cell[data-id="${Number(rid)}"]`).forEach(x => { x.classList.add('is-sel'); x.setAttribute('aria-pressed', 'true') })
    renderSide()
    loadCandidates(rid)
  }
  async function loadCandidates(rid) {
    const seq = ++CAND.seq
    CAND.rid = rid; CAND.data = null; CAND.error = null
    drawCand()
    try {
      const { data } = await axios.get('/api/admin/shift-board/candidates?slot_role_id=' + Number(rid))
      if (seq !== CAND.seq) return
      CAND.data = data
    } catch (e) {
      if (seq !== CAND.seq) return
      CAND.error = errMsg(e, '候補を読み込めませんでした')
    }
    drawCand()
  }
  function renderSide() {
    const el = document.getElementById('board-side'); if (!el) return
    const x = BS.sel ? ROLE_IX.get(BS.sel) : null
    if (!x || BS.range === 'month') {
      el.innerHTML = `<p class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-user-plus text-blue-500 mr-1"></i>候補のスタッフ</p>
        <p class="text-xs text-gray-500">${BS.range === 'month' ? '月の表示です。日付を押すと、その日を含む週の表に切り替わります。' : '左の表で、赤い「不足」のマスを押してください。その日に空いている人が、ここに出ます。'}</p>
        <p class="text-[11px] text-gray-400 mt-2">候補を押すと<b class="text-emerald-700">下書き</b>として表に入ります（まだ保存しません）。組み終わったら「まとめて保存」を押すと、まとめて登録します。</p>`
      return
    }
    const { slot, role } = x
    const p = projectOf(slot.project_id)
    const spot = p.engagement_type === 'spot'
    const drafts = draftsOf(role.slot_role_id)
    const left = leftOf(role)
    const assigned = role.assigned.filter(a => a.status !== 'absent')
    el.innerHTML = `
      <div class="mb-2">
        <p class="font-bold text-gray-900 leading-snug"><a href="#projects/${Number(slot.project_id)}" class="hover:underline">${esc(p.project_name || '')}</a>${p.client_name ? `<span class="block text-[11px] font-normal text-gray-400">${esc(p.client_name)}</span>` : ''}</p>
        <p class="text-xs text-gray-600 mt-0.5">${esc(fmtDay(slot.work_date))} ${esc(slot.start_time)}〜${esc(slot.end_time)}・${esc(slot.site_name || slot.location || '場所未設定')}・<b>${esc(role.role_name)}</b></p>
        <p class="text-xs mt-1 flex items-center gap-1 flex-wrap"><span class="badge ${spot ? 'badge-purple' : 'badge-blue'}">${spot ? 'スポット' : '常勤'}</span>
          ${left > 0 ? `<span class="font-bold text-red-600">あと${left}人</span>` : `<span class="font-bold text-emerald-700">${left < 0 ? '定員を超えています' : '充足しています'}</span>`}
          <span class="text-gray-400">必要 ${Number(role.headcount)}名・確定 ${Number(role.filled)}名${drafts.length ? `・下書き ${drafts.length}名` : ''}</span></p>
        <div class="flex gap-1.5 mt-2 flex-wrap">
          <button class="btn btn-outline text-xs py-1 px-2" data-action="boardEditSlot" data-id="${Number(slot.slot_id)}"><i class="fas fa-pen"></i>枠を編集</button>
          <button class="btn btn-danger text-xs py-1 px-2" data-action="boardDeleteSlot" data-id="${Number(slot.slot_id)}"><i class="fas fa-trash"></i>枠を削除</button>
        </div>
      </div>
      ${assigned.length ? `<div class="mb-2"><p class="text-[11px] font-bold text-gray-500 mb-0.5">割り当て済み ${assigned.length}人（押すと確定・欠勤・金額）</p><div class="space-y-0.5">${assigned.map(a => staffChip(a)).join('')}</div></div>` : ''}
      ${drafts.length ? `<div class="mb-2"><p class="text-[11px] font-bold text-emerald-700 mb-0.5">下書き ${drafts.length}人（まだ保存していません）</p><div class="space-y-0.5">${drafts.map(draftChip).join('')}</div></div>` : ''}
      <div id="side-price" class="board-inherit mb-2">${sidePriceHtml(x)}</div>
      <label class="flex items-center gap-1 text-xs text-gray-600 mb-2">下書きにするときの状態
        <select class="inp text-xs w-auto py-1" data-board-input="draftStatus"><option value="confirmed" ${BS.draftStatus !== 'requested' ? 'selected' : ''}>確定</option><option value="requested" ${BS.draftStatus === 'requested' ? 'selected' : ''}>希望（仮）（本人が可否を返事）</option></select></label>
      <p class="text-xs font-bold text-gray-700 mb-1"><i class="fas fa-user-plus text-blue-500 mr-1"></i>候補のスタッフ<span class="font-normal text-gray-400 ml-1">押すと下書きに入ります</span></p>
      <input class="inp text-xs mb-1.5" id="cand-q" placeholder="名前で検索" value="${esc(BS.cf.q)}" aria-label="候補を名前で検索" autocomplete="off">
      <div id="cand-box">${candBoxHtml()}</div>
      <div class="mt-2 space-y-1.5">
        ${spot ? '' : `<button class="btn btn-outline w-full text-xs" data-action="boardRepeat" data-id="${Number(role.slot_role_id)}"><i class="fas fa-repeat"></i>この人で毎週の繰り返し登録を作る</button>`}
        <button class="btn btn-outline w-full text-xs" data-action="boardCandModal" data-id="${Number(role.slot_role_id)}" title="候補の一覧から複数人を選び、交通費を入れてすぐに登録します。一覧にいない人の仮登録もここから"><i class="fas fa-list-check"></i>一覧から選んですぐ登録・一覧にいない人</button>
      </div>`
  }
  function drawCand() {
    const box = document.getElementById('cand-box'); if (box) box.innerHTML = candBoxHtml()
  }
  function candBoxHtml() {
    const all = CAND.data && CAND.rid === BS.sel ? CAND.data.candidates : []
    const req = CAND.data && CAND.rid === BS.sel && all.length ? Number(all[0].skill_required || 0) : 0
    const skills = [...new Set(all.flatMap(c => c.skills || []))].sort()
    const tg = (key, label, title) => `<button type="button" class="board-toggle sm ${BS.cf[key] ? 'on' : ''}" data-action="boardCandFilter" data-key="${key}" aria-pressed="${!!BS.cf[key]}" title="${esc(title)}">${label}</button>`
    return `<div class="flex flex-wrap gap-1 mb-1.5 items-center">
        ${tg('free', '空いている人', 'この日の同じ時間に別のシフト・下書きがなく、出勤可能日で×を付けていない人')}
        ${tg('prev', '前回この案件', 'この案件で前に働いたことがある人')}
        <select class="inp text-xs w-auto py-1" data-board-input="candSkill" aria-label="スキルで絞り込み">
          <option value="">スキル: すべて</option>
          ${req ? `<option value="__req" ${BS.cf.skill === '__req' ? 'selected' : ''}>必要なスキルを満たす人</option>` : ''}
          ${skills.map(s => `<option value="${esc(s)}" ${BS.cf.skill === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </div>
      <div id="cand-list" class="board-cand">${candListHtml()}</div>`
  }
  delegate('boardCandFilter', (el) => { const k = el.dataset.key; if (k !== 'free' && k !== 'prev') return; BS.cf[k] = !BS.cf[k]; drawCand() })
  const AV_LABEL = { ok: '○ 出勤可', partial: '△ 時間帯なら可', ng: '× 出勤不可' }
  function availText(av) {
    if (!av) return ''
    return (AV_LABEL[av.status] || '') + (av.status === 'partial' && av.start_time ? ` ${av.start_time}〜${av.end_time || ''}` : '')
  }
  function candListHtml() {
    const x = ROLE_IX.get(BS.sel)
    if (!x) return ''
    if (CAND.error && CAND.rid === BS.sel) return `<p class="text-xs text-red-600 p-2">${esc(CAND.error)}</p>`
    if (!CAND.data || CAND.rid !== BS.sel) return '<p class="text-xs text-gray-400 p-2"><i class="fas fa-spinner fa-spin mr-1"></i>候補を読み込んでいます…</p>'
    const all = CAND.data.candidates
    const other = draftsOverlapping(x.slot, x.role.slot_role_id)
    const mine = new Set(draftsOf(x.role.slot_role_id).map(d => d.staff_id))
    const q = String(BS.cf.q || '').trim()
    const list = all.filter(c => {
      if (q && !String(c.name).includes(q)) return false
      if (BS.cf.free && (c.busy || other.has(c.staff_id) || (c.availability && c.availability.status === 'ng'))) return false
      if (BS.cf.prev && !c.last_project_date) return false
      if (BS.cf.skill === '__req' && !(c.skill_required && c.skill_match === c.skill_required)) return false
      if (BS.cf.skill && BS.cf.skill !== '__req' && !(c.skills || []).includes(BS.cf.skill)) return false
      return true
    })
    const head = `<p class="text-[11px] text-gray-400 mb-1">候補 ${list.length}人（割り当てられる ${all.length}人中）・出勤可能日を出している人 → 前回この案件の人の順</p>`
    if (!list.length) return head + '<p class="text-xs text-gray-400 p-2">条件に合う人がいません。上の絞り込みを外してください</p>'
    return head + list.slice(0, CAND_MAX).map(c => candItem(c, mine.has(c.staff_id), other.get(c.staff_id))).join('')
      + (list.length > CAND_MAX ? `<p class="text-[11px] text-gray-400 p-1">ほか ${list.length - CAND_MAX}人（名前で検索してください）</p>` : '')
  }
  function candItem(c, drafted, otherDraft) {
    const av = c.availability
    const badge = c.busy ? '<span class="cand-badge bad">重複</span>'
      : drafted ? '<span class="cand-badge draft">下書き済み</span>'
      : otherDraft ? '<span class="cand-badge warn">下書きと重複</span>'
      : av ? `<span class="cand-badge av-${esc(av.status)}">${esc(availText(av))}</span>` : '<span class="cand-badge ok">空き</span>'
    const why = [
      av && (c.busy || drafted || otherDraft) ? esc(availText(av)) : '',
      !av ? '出勤可能日 未提出' : '',
      av && av.note ? esc('メモ: ' + av.note) : '',
      c.last_project_date ? `前回この案件 ${esc(dayjs(c.last_project_date).format('M/D'))}` : '',
      Number(c.run_days) >= 2 ? `<span class="${Number(c.run_days) >= 6 ? 'text-amber-700 font-bold' : ''}">入ると${Number(c.run_days)}連勤</span>` : '',
      `今週 ${Number(c.week_days)}日`,
      c.skill_required ? `スキル ${Number(c.skill_match)}/${Number(c.skill_required)}` : (c.skills && c.skills.length ? esc(c.skills.slice(0, 3).join('・')) : ''),
      c.ng ? '<span class="text-red-600 font-bold">NG</span>' : '',
      c.on_leave ? '<span class="text-amber-700">休職中</span>' : '',
      c.preboarding ? '<span class="text-amber-700">入社予定</span>' : '',
      c.not_yet_available ? `<span class="text-amber-700">稼働開始 ${esc(dayjs(c.available_from).format('M/D'))}〜</span>` : '',
      c.busy ? `<span class="text-red-600">${esc(c.busy_detail.join('、'))}</span>` : '',
      otherDraft ? `<span class="text-amber-700">下書き: ${esc(otherDraft)}</span>` : '',
    ].filter(Boolean)
    return `<button type="button" class="cand-item ${c.busy || c.ng ? 'is-warn' : ''} ${drafted ? 'is-drafted' : ''}" data-action="boardDraftAdd" data-staff-id="${Number(c.staff_id)}" title="押すと下書きに入れます">
      <span class="font-bold truncate">${esc(c.name)} <span class="text-[10px] font-normal text-gray-400">${AFF_SHORT[c.affiliation_type] || ''}</span></span>${badge}
      <span class="cand-why">${why.join('・')}</span></button>`
  }

  // ---------- 引き継ぐ単価（Sprint 10 の 9306 をこの画面に出す） ----------
  const priceKey = (x) => x.role.slot_role_id + ':' + draftsOf(x.role.slot_role_id).map(d => d.staff_id).sort((a, b) => a - b).join(',')
  async function loadSidePrice(x, key) {
    SIDE_PRICE = { key, data: null, error: null }
    const ids = draftsOf(x.role.slot_role_id).map(d => d.staff_id)
    try {
      const { data } = await axios.get('/api/admin/shifts/price-preview?' + new URLSearchParams({ slot_role_id: String(x.role.slot_role_id), staff_ids: ids.join(',') }))
      if (SIDE_PRICE.key !== key) return
      SIDE_PRICE.data = data
    } catch (e) {
      if (SIDE_PRICE.key !== key) return
      SIDE_PRICE.error = errMsg(e, '単価を確認できませんでした')
    }
    const el = document.getElementById('side-price'); const cur = BS.sel ? ROLE_IX.get(BS.sel) : null
    if (el && cur && priceKey(cur) === key) el.innerHTML = sidePriceHtml(cur)
  }
  function sidePriceHtml(x) {
    const key = priceKey(x)
    if (SIDE_PRICE.key !== key) { loadSidePrice(x, key); return '<p class="text-gray-400"><i class="fas fa-yen-sign mr-1"></i>単価を確認しています…</p>' }
    const spot = projectOf(x.slot.project_id).engagement_type === 'spot'
    const use = !BS.noInherit[x.role.slot_role_id]
    const rate = (u, r) => (r == null ? '未設定' : `${UNIT_LABEL[u] || ''} ${yen(r)}`)
    const names = new Map(draftsOf(x.role.slot_role_id).map(d => [d.staff_id, d.staff_name]))
    let body
    if (SIDE_PRICE.error) body = `<p class="text-gray-500">${esc(SIDE_PRICE.error)}</p>`
    else if (!SIDE_PRICE.data) body = '<p class="text-gray-400">単価を確認しています…</p>'
    else {
      const items = SIDE_PRICE.data.items || []
      body = items.length ? items.slice(0, 5).map(it => {
        const ih = use ? it.inherited : null
        const pr = ih ? it.price : it.settings
        const who = it.staff_id == null ? '' : `<b class="text-gray-700">${esc(names.get(Number(it.staff_id)) || '')}</b> `
        return `<p class="mt-0.5">${who}請求 <b>${rate(pr.bill_unit_type, pr.bill_rate)}</b> ／ 支払 <b>${rate(pr.pay_unit_type, pr.pay_rate)}</b><span class="block text-[11px] ${ih ? 'text-blue-700' : 'text-gray-500'}">${ih ? `${esc(ih.label)}の単価を引き継ぎ` : it.inherited ? '単価の設定（前回の単価は引き継がない）' : '単価の設定（案件の標準・単価ルール）'}</span></p>`
      }).join('') + (items.length > 5 ? `<p class="text-[11px] text-gray-400">ほか ${items.length - 5}人</p>` : '')
        : '<p class="text-gray-500">常勤は、同じスタッフのこの案件の前回のシフトの単価を引き継ぎます。候補を下書きに入れると、その人の単価をここに出します。</p>'
    }
    const own = x.role.bill_rate != null || x.role.pay_rate != null
    return `<div class="flex items-center justify-between gap-2"><p class="font-bold text-gray-700"><i class="fas fa-yen-sign mr-1"></i>単価</p><span class="text-[10px] text-gray-500">${spot ? 'この案件の前回のシフトから' : '同じスタッフのこの案件の前回から'}</span></div>
      ${body}
      ${own ? `<p class="text-[11px] text-amber-700 mt-1">この枠だけの単価: 請求 ${rate(x.role.bill_unit_type || 'daily', x.role.bill_rate)} ／ 支払 ${rate(x.role.pay_unit_type || 'daily', x.role.pay_rate)}</p>` : ''}
      <div class="flex items-center justify-between gap-2 mt-1.5 flex-wrap">
        <label class="flex items-center gap-1 text-[11px] text-gray-600"><input type="checkbox" data-board-input="inherit" ${use ? 'checked' : ''}>前回のシフトの単価を引き継ぐ</label>
        <button type="button" class="text-[11px] text-blue-700 hover:underline" data-action="boardEditSlot" data-id="${Number(x.slot.slot_id)}" data-focus="price">この枠だけ単価を変える</button>
      </div>`
  }
  delegate('boardCandModal', el => openCandidates(Number(el.dataset.id)))

  // ---------- 常勤: この人で毎週の繰り返し登録（#9401） ----------
  // 同じ曜日の、同じ案件・開催場所・時間・役割の枠に、選んだ人を割り当てる（POST /shifts/bulk の slot_match）
  delegate('boardRepeat', (el) => {
    const x = ROLE_IX.get(Number(el.dataset.id)); if (!x) return
    const { slot, role } = x
    const people = new Map()
    for (const d of draftsOf(role.slot_role_id).reverse()) people.set(d.staff_id, d.staff_name + '（下書き）')
    for (const a of role.assigned) if (a.status !== 'absent' && !people.has(a.staff_id)) people.set(a.staff_id, a.staff_name)
    const others = ((MASTER && MASTER.staff) || []).filter(s => !people.has(s.staff_id))
    const wd = dayjs(slot.work_date).day()
    modal(`
      <h3 class="font-bold text-lg mb-1">毎週の繰り返し登録</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(projectOf(slot.project_id).project_name || '')}・${esc(slot.site_name || slot.location || '場所未設定')}・${esc(slot.start_time)}〜${esc(slot.end_time)}・<b>${esc(role.role_name)}</b></p>
      <div class="space-y-3">
        <label class="text-sm text-gray-600 block">スタッフ
          <select id="rp-staff" class="inp">${[...people].map(([id, n]) => `<option value="${Number(id)}">${esc(n)}</option>`).join('')}
            ${others.length ? `<optgroup label="ほかのスタッフ">${others.map(s => `<option value="${Number(s.staff_id)}">${esc(s.name)}</option>`).join('')}</optgroup>` : ''}</select></label>
        <div><p class="text-sm text-gray-600 mb-1">曜日</p>
          <div class="flex gap-1">${WD.map((w, i) => `<label class="flex-1 text-center border rounded-lg py-1.5 text-sm cursor-pointer has-[:checked]:bg-blue-600 has-[:checked]:text-white"><input type="checkbox" class="hidden rp-wd" value="${i}" ${i === wd ? 'checked' : ''}>${w}</label>`).join('')}</div></div>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">開始日<input id="rp-from" type="date" class="inp" value="${esc(slot.work_date)}"></label>
          <label class="text-sm text-gray-600">終了日<input id="rp-to" type="date" class="inp" value="${esc(dayjs(slot.work_date).add(1, 'month').endOf('month').format('YYYY-MM-DD'))}"></label>
        </div>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="rp-inherit" ${BS.noInherit[role.slot_role_id] ? '' : 'checked'}>前回のシフトの単価を引き継ぐ</label>
        <p class="text-[11px] text-gray-500 bg-gray-50 rounded p-2">選んだ曜日の、同じ時間・役割・開催場所の枠に<b>確定</b>で割り当てます（すぐに登録します）。枠のない日・定員に達した日・割り当て済みの日・重複・NG・退職などの日はスキップし、一覧で表示します。枠がまだない期間は、先に「その他の操作」→「枠の繰り返し登録」で枠を作ってください。</p>
        <button class="btn btn-primary w-full" data-action="boardRepeatRun" data-id="${Number(role.slot_role_id)}"><i class="fas fa-repeat"></i>毎週の割り当てを登録する</button>
      </div>`)
  })
  delegate('boardRepeatRun', el => withSubmitLock(el, async () => {
    const x = ROLE_IX.get(Number(el.dataset.id)); if (!x) return
    const { slot, role } = x
    const sid = Number(document.getElementById('rp-staff').value)
    const weekdays = [...document.querySelectorAll('.rp-wd:checked')].map(c => Number(c.value))
    const from = document.getElementById('rp-from').value, to = document.getElementById('rp-to').value
    if (!sid) { toast('スタッフを選んでください'); return }
    if (!weekdays.length) { toast('曜日を選んでください'); return }
    if (!from || !to || to < from) { toast('期間を正しく入力してください'); return }
    // この人のこの枠の行の下書きは、繰り返し登録で入るので外す
    for (const [k, d] of DRAFTS) if (d.staff_id === sid && d.project_id === slot.project_id && d.role_name === role.role_name && d.start_time === slot.start_time && d.end_time === slot.end_time && d.work_date >= from && d.work_date <= to) DRAFTS.delete(k)
    await runJob(newJob({
      title: '毎週の繰り返し登録', url: '/api/admin/shifts/bulk',
      body: { project_id: slot.project_id, staff_ids: [sid], weekdays, date_from: from, date_to: to, start_time: slot.start_time, end_time: slot.end_time,
        role: role.role_name, site_id: slot.site_id || null, location: slot.location || '', slot_match: true, inherit: document.getElementById('rp-inherit').checked },
      keys: ['created', 'inherited'],
      summary: (n) => `${n.created}件を枠に割り当てました${n.inherited ? `（${n.inherited}件は前回のシフトの単価を引き継ぎ）` : ''}`, done: () => renderShiftBoard(),
    }))
  }))

  // ---------- 枠の削除（#9403） ----------
  // 表のマス・右の欄・枠の編集から開く。割り当て済みの人・未対応の応募・下書きの件数を出して確かめる
  delegate('boardDeleteSlot', el => openDeleteSlot(Number(el.dataset.id)))
  function slotDeleteError(e) {
    if (!e.response) return '通信できなかったため、枠を削除できませんでした。接続を確かめて、もう一度お試しください'
    if (e.response.status === 403) return errMsg(e, '枠を削除する権限がありません（会社の管理者に依頼してください）')
    return errMsg(e, '枠を削除できませんでした。時間をおいてもう一度お試しください')
  }
  async function openDeleteSlot(slotId) {
    const slot = BOARD && BOARD.slots.find(s => s.slot_id === slotId)
    if (!slot) {
      // 表に出ていない枠（ほかの画面から開いたときなど）は、件数をサーバーに確かめてもらう
      if (!confirm('この枠を削除しますか？')) return
      return deleteSlotRun(slotId, false)
    }
    const people = slot.roles.flatMap(r => r.assigned.filter(a => a.status !== 'absent'))
    const anyShift = slot.roles.some(r => r.assigned.length)
    const applicants = slot.roles.reduce((n, r) => n + Number(r.applicants || 0), 0)
    const drafts = [...DRAFTS.values()].filter(d => slot.roles.some(r => r.slot_role_id === d.slot_role_id))
    const names = people.slice(0, 8).map(a => a.staff_name).join('、') + (people.length > 8 ? ` ほか${people.length - 8}人` : '')
    modal(`
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-trash text-red-500 mr-1"></i>枠を削除</h3>
      <p class="text-sm text-gray-800 font-bold">${esc(fmtDay(slot.work_date))} ${esc(slot.start_time)}〜${esc(slot.end_time)}・${esc(projectOf(slot.project_id).project_name || '')}</p>
      <p class="text-xs text-gray-500 mb-3">${esc(slot.site_name || slot.location || '場所未設定')}・役割: ${esc(slot.roles.map(r => `${r.role_name} ${r.headcount}名`).join('、'))}（この日の枠を役割ごとまとめて削除します）</p>
      <ul class="text-sm space-y-1.5 mb-3">
        ${people.length ? `<li class="bg-amber-50 text-amber-900 rounded p-2"><b>割り当て済みの人が${people.length}人います</b>（${esc(names)}）。シフトは削除せず、「枠を使わないシフト」として残します（勤怠・日報が付いていることがあるため）。シフトも要らないときは、残ったシフトを開いて削除してください。</li>`
          : anyShift ? '<li class="text-gray-600">欠勤のシフトは「枠を使わないシフト」として残します。</li>' : '<li class="text-gray-600">割り当て済みの人はいません。</li>'}
        ${applicants ? `<li class="bg-red-50 text-red-800 rounded p-2">未対応の応募が${applicants}件あります。削除すると、これらの応募は「枠の削除」として処理済みになります。</li>` : ''}
        ${drafts.length ? `<li class="bg-emerald-50 text-emerald-800 rounded p-2">この枠の保存していない下書き${drafts.length}件も消えます。</li>` : ''}
      </ul>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-danger flex-1" data-action="deleteSlotRun" data-id="${Number(slotId)}" data-force="${anyShift ? 1 : 0}"><i class="fas fa-trash"></i>枠を削除する</button>
      </div>`)
  }
  async function deleteSlotRun(slotId, force) {
    try { await axios.delete('/api/admin/shift-slots/' + Number(slotId) + (force ? '?force=1' : '')) } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) {
        // 確かめた後に割り当てが入った（または表に出ていない枠）。件数を出して、もう一度確かめる
        if (!confirm(`この枠には ${Number(d.assigned)} 件のシフトがあります。\n枠だけを削除し、シフトは「枠を使わないシフト」として残しますか？`)) return
        return deleteSlotRun(slotId, true)
      }
      toast(slotDeleteError(e))
      if (e.response && e.response.status === 404) { closeModal(); renderShiftBoard() }
      return
    }
    const slot = BOARD && BOARD.slots.find(s => s.slot_id === slotId)
    const rids = new Set(slot ? slot.roles.map(r => r.slot_role_id) : [])
    let kept = 0
    if (slot) for (const r of slot.roles) kept += r.assigned.length
    for (const [k, d] of DRAFTS) if (rids.has(d.slot_role_id)) DRAFTS.delete(k)
    if (rids.has(BS.sel)) BS.sel = null
    closeModal(); toast('枠を削除しました' + (kept ? `（シフト${kept}件は「枠を使わないシフト」として残しています）` : '')); renderShiftBoard()
  }
  delegate('deleteSlotRun', el => withSubmitLock(el, () => deleteSlotRun(Number(el.dataset.id), el.dataset.force === '1')))

  // ---------- 枠のまとめて削除（Sprint 12 #9501） ----------
  // 「選択して削除」で表のマスにチェックを出し、選んだ枠をまとめて削除する。役割が複数ある枠は、どのマスで選んでも枠ごと選ぶ
  const BULK = window.__boardBulk = window.__boardBulk || new Set()
  const BULK_MAX = 200
  function pruneBulk() {
    if (!BS.bulkDel || !BOARD) { BULK.clear(); return }
    const ids = new Set(BOARD.slots.map(s => s.slot_id))
    for (const id of [...BULK]) if (!ids.has(id)) BULK.delete(id)
  }
  function toggleBulk(slotId, on) {
    if (!slotId) return
    if (on) BULK.add(slotId); else BULK.delete(slotId)
    document.querySelectorAll(`.board-cell[data-slot-id="${Number(slotId)}"]`).forEach(c => {
      c.classList.toggle('is-bulk', on)
      const cb = c.querySelector('.bulk-check'); if (cb) cb.checked = on
    })
    updateBulkBar()
  }
  function updateBulkBar() {
    const bar = document.getElementById('board-bulkbar'); if (!bar) return
    bar.hidden = !BS.bulkDel
    if (!BS.bulkDel) { bar.innerHTML = ''; return }
    const n = BULK.size
    bar.innerHTML = `<span class="text-sm"><i class="fas fa-list-check mr-1 text-red-500"></i>削除する枠を選んでください（マスを押すとチェックが付きます）。選択中 <b>${n}</b>件${n > BULK_MAX ? `<span class="text-red-600 font-bold ml-1">一度に削除できるのは${BULK_MAX}件までです</span>` : ''}</span>
      <span class="flex-1"></span>
      <button class="btn btn-outline text-xs py-1.5" data-action="boardBulkAll">表示中の枠をすべて選ぶ</button>
      <button class="btn btn-outline text-xs py-1.5" data-action="boardBulkClear" ${n ? '' : 'disabled'}>選択を外す</button>
      <button class="btn btn-danger text-xs py-1.5" data-action="boardBulkDelete" ${n ? '' : 'disabled'}><i class="fas fa-trash"></i>選んだ枠を削除（${n}件）</button>
      <button class="btn btn-outline text-xs py-1.5" data-action="boardBulkDelToggle">やめる</button>`
  }
  function bulkBtnHtml() {
    return `<button id="board-bulk-btn" class="btn ${BS.bulkDel ? 'btn-danger' : 'btn-outline'}" data-action="boardBulkDelToggle" aria-pressed="${!!BS.bulkDel}" title="表のマスにチェックを出し、選んだ枠をまとめて削除します"><i class="fas ${BS.bulkDel ? 'fa-xmark' : 'fa-list-check'}"></i>${BS.bulkDel ? '選択をやめる' : '選択して削除'}</button>`
  }
  delegate('boardBulkDelToggle', () => {
    BS.bulkDel = !BS.bulkDel; BULK.clear()
    const b = document.getElementById('board-bulk-btn'); if (b) b.outerHTML = bulkBtnHtml()
    redraw()
  })
  delegate('boardBulkCheck', el => toggleBulk(Number(el.dataset.slotId), !!el.checked))
  delegate('boardBulkAll', () => {
    // 表に出ているマス（「不足のみ」で外した行は含めない）の枠
    document.querySelectorAll('#board-grid .board-cell[data-slot-id]').forEach(c => BULK.add(Number(c.dataset.slotId)))
    redraw()
  })
  delegate('boardBulkClear', () => { BULK.clear(); redraw() })
  delegate('boardBulkDelete', () => openBulkDelete())
  function openBulkDelete() {
    const slots = BOARD ? BOARD.slots.filter(s => BULK.has(s.slot_id)) : []
    if (!slots.length) { toast('削除する枠を選んでください'); return }
    if (slots.length > BULK_MAX) { toast(`一度に削除できる枠は${BULK_MAX}件までです（${slots.length}件選ばれています）`); return }
    // 1枠の削除（openDeleteSlot）と同じ内容を、選んだ枠の合計で出す
    const roles = slots.flatMap(s => s.roles)
    const people = roles.flatMap(r => r.assigned.filter(a => a.status !== 'absent'))
    const anyShift = roles.some(r => r.assigned.length)
    const applicants = roles.reduce((n, r) => n + Number(r.applicants || 0), 0)
    const rids = new Set(roles.map(r => r.slot_role_id))
    const drafts = [...DRAFTS.values()].filter(d => rids.has(d.slot_role_id))
    const names = people.slice(0, 8).map(a => a.staff_name).join('、') + (people.length > 8 ? ` ほか${people.length - 8}人` : '')
    const sorted = [...slots].sort((a, b) => String(a.work_date + a.start_time).localeCompare(b.work_date + b.start_time))
    modal(`
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-trash text-red-500 mr-1"></i>選んだ枠を削除</h3>
      <p class="text-sm text-gray-800 font-bold mb-1">${slots.length}件の枠を、役割ごとまとめて削除します</p>
      <div class="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100 mb-3">
        ${sorted.map(s => `<div class="px-2 py-1.5 text-xs"><span class="font-bold">${esc(fmtDay(s.work_date))} ${esc(s.start_time)}〜${esc(s.end_time)}</span>・${esc(projectOf(s.project_id).project_name || '')}
          <span class="block text-gray-500">${esc(s.site_name || s.location || '場所未設定')}・${esc(s.roles.map(r => `${r.role_name} ${r.headcount}名`).join('、'))}</span></div>`).join('')}
      </div>
      <ul class="text-sm space-y-1.5 mb-3">
        ${people.length ? `<li class="bg-amber-50 text-amber-900 rounded p-2"><b>割り当て済みの人が${people.length}人います</b>（${esc(names)}）。シフトは削除せず、「枠を使わないシフト」として残します（勤怠・日報が付いていることがあるため）。シフトも要らないときは、残ったシフトを開いて削除してください。</li>`
          : anyShift ? '<li class="text-gray-600">欠勤のシフトは「枠を使わないシフト」として残します。</li>' : '<li class="text-gray-600">割り当て済みの人はいません。</li>'}
        ${applicants ? `<li class="bg-red-50 text-red-800 rounded p-2">未対応の応募が${applicants}件あります。削除すると、これらの応募は「枠の削除」として処理済みになります。</li>` : ''}
        ${drafts.length ? `<li class="bg-emerald-50 text-emerald-800 rounded p-2">これらの枠の保存していない下書き${drafts.length}件も消えます。</li>` : ''}
      </ul>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-danger flex-1" data-action="bulkDeleteRun" data-force="${anyShift ? 1 : 0}"><i class="fas fa-trash"></i>${slots.length}件の枠を削除する</button>
      </div>`)
  }
  async function bulkDeleteRun(force) {
    const ids = [...BULK]
    if (!ids.length) { closeModal(); return }
    let data
    try { data = (await axios.post('/api/admin/shift-slots/bulk-delete', { slot_ids: ids, force: !!force })).data } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) {
        // 確かめた後に割り当てが入った。件数を出して、もう一度確かめる
        if (!confirm(`選んだ枠には ${Number(d.assigned)} 件のシフトがあります。\n枠だけを削除し、シフトは「枠を使わないシフト」として残しますか？`)) return
        return bulkDeleteRun(true)
      }
      toast(slotDeleteError(e))
      if (e.response && e.response.status === 404) { closeModal(); BULK.clear(); renderShiftBoard() }
      return
    }
    // 削除した枠の下書き・選択を片づける
    const done = new Set((data.deleted_ids || ids).map(Number))
    const rids = new Set()
    if (BOARD) for (const s of BOARD.slots) if (done.has(s.slot_id)) for (const r of s.roles) rids.add(r.slot_role_id)
    for (const [k, d] of DRAFTS) if (rids.has(d.slot_role_id)) DRAFTS.delete(k)
    if (rids.has(BS.sel)) BS.sel = null
    BULK.clear(); BS.bulkDel = false
    const notes = []
    if (data.kept_shifts) notes.push(`シフト${Number(data.kept_shifts)}件は「枠を使わないシフト」として残しています`)
    if (data.missing) notes.push(`${Number(data.missing)}件はすでに削除されていました`)
    closeModal(); toast(`${Number(data.deleted)}件の枠を削除しました` + (notes.length ? `（${notes.join('。')}）` : '')); renderShiftBoard()
  }
  delegate('bulkDeleteRun', el => withSubmitLock(el, () => bulkDeleteRun(el.dataset.force === '1')))

  // ---------- 希望（仮）のまとめて確定（#390） ----------
  // 表示中のボードの希望（仮）のシフト。slotRoleId を渡すとその役割だけ
  function requestedShifts(slotRoleId) {
    if (!BOARD) return []
    const out = []
    for (const s of BOARD.slots) for (const r of s.roles) {
      if (slotRoleId && r.slot_role_id !== slotRoleId) continue
      for (const a of r.assigned) if (a.status === 'requested') out.push({ ...a, _role: r.role_name, _site: s.site_name || s.location || '' })
    }
    if (!slotRoleId) for (const a of BOARD.unslotted) if (a.status === 'requested') out.push({ ...a, _role: a.role || '', _site: a.site_name || a.location || '' })
    return out.sort((a, b) => String(a.work_date + a.start_time).localeCompare(b.work_date + b.start_time) || String(a.staff_name).localeCompare(b.staff_name))
  }
  function openConfirmRequested(slotRoleId) {
    const list = requestedShifts(slotRoleId)
    if (!list.length) { toast('確定にする希望（仮）のシフトはありません'); return }
    const proj = new Map(BOARD.projects.map(p => [p.project_id, p]))
    // 本人が「入れません」と返事した人・稼働できない人は、初めはチェックを外しておく
    const off = (a) => a.staff_reply === 'ng' || (a.unavailable && a.status !== 'absent')
    modal(`
      <h3 class="font-bold text-lg mb-1">希望（仮）をまとめて確定</h3>
      <p class="text-xs text-gray-500 mb-2">チェックしたシフトを確定にします（${slotRoleId ? 'この役割' : '表示中の期間・絞り込みの範囲'}）。重複・NG・必要人数の超過があるときは、確認してから確定します</p>
      <label class="flex items-center gap-1 text-xs mb-1"><input type="checkbox" id="cr-all" checked>すべて選択</label>
      <div class="max-h-[60vh] overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg">
        ${list.map(a => `<label class="flex items-start gap-2 px-2 py-1.5 text-sm ${off(a) ? 'bg-red-50' : ''}">
          <input type="checkbox" class="cr-check mt-1" value="${Number(a.shift_id)}" ${off(a) ? '' : 'checked'}>
          <span class="flex-1 min-w-0"><span class="font-bold">${esc(a.staff_name)}</span>${replyMark(a)}${unavailableMark(a)}
            <span class="block text-xs text-gray-500">${esc(fmtDay(a.work_date))} ${esc(a.start_time)}〜${esc(a.end_time)}・${esc((proj.get(a.project_id) || {}).project_name || '')}${a._site ? '・' + esc(a._site) : ''}${a._role ? '・' + esc(a._role) : ''}</span>
            ${a.staff_reply ? `<span class="block text-[11px] ${a.staff_reply === 'ng' ? 'text-red-600' : 'text-gray-500'}">${esc(replyText(a))}</span>` : ''}</span>
        </label>`).join('')}
      </div>
      <button class="btn btn-primary w-full mt-3" data-action="confirmRequestedRun"><i class="fas fa-check-double"></i>選択したシフトを確定にする</button>`)
    document.getElementById('cr-all').addEventListener('change', (ev) => document.querySelectorAll('.cr-check').forEach(el => { el.checked = ev.target.checked }))
  }
  async function confirmRequestedRun() {
    const ids = [...document.querySelectorAll('.cr-check:checked')].map(el => Number(el.value))
    if (!ids.length) { toast('確定にするシフトを選んでください'); return }
    let data
    try { data = (await axios.post('/api/admin/shifts/confirm-requested', { shift_ids: ids })).data } catch (e) {
      const d = e.response && e.response.data
      if (!(d && d.need_force)) { toast(errMsg(e)); return }
      const w = d.warnings.slice(0, 15).join('\n') + (d.warnings.length > 15 ? `\nほか${d.warnings.length - 15}件` : '')
      if (!confirm(`確認してください:\n${w}\n\nこのまま確定にしますか？`)) return
      try { data = (await axios.post('/api/admin/shifts/confirm-requested', { shift_ids: ids, force: true })).data } catch (e2) { toast(errMsg(e2)); return }
    }
    const skipped = data.skipped || []
    if (skipped.length) {
      modal(`<h3 class="font-bold text-lg mb-1">希望（仮）をまとめて確定</h3>
        <p class="text-sm text-gray-700 mb-2">${Number(data.confirmed)}件を確定にしました。次の${skipped.length}件は確定にしていません</p>
        <div class="max-h-72 overflow-y-auto border border-gray-100 rounded-lg"><table class="tbl text-xs"><thead><tr><th>日付</th><th>スタッフ</th><th>理由</th></tr></thead><tbody>
          ${skipped.map(x => `<tr><td class="whitespace-nowrap">${esc(fmtDay(x.work_date))}</td><td>${esc(x.staff_name)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>
        <button class="btn btn-outline w-full mt-3" onclick="closeModal()">閉じる</button>`)
    } else { closeModal(); toast(`${Number(data.confirmed)}件を確定にしました`) }
    renderShiftBoard()
  }
  delegate('boardConfirmRequested', el => openConfirmRequested(Number(el.dataset.slotRoleId) || null))
  delegate('confirmRequestedRun', el => withSubmitLock(el, confirmRequestedRun))

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
      const nIh = (data.inherited || []).length // 直近のシフトの単価を引き継いだ人数（9306）
      toast((data.warnings && data.warnings.length ? '警告を確認のうえ割り当てました' : '割り当てました') + (nIh ? `（${nIh}人は前回のシフトの単価を引き継ぎ）` : ''))
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
              ・この場所 ${c.site_count}回・この案件 ${c.project_count}回${c.skill_required ? `・スキル ${c.skill_match}/${c.skill_required}` : ''}・今週（月〜日）${c.week_days}日${c.transport_default != null ? `・交通費の標準 ¥${Number(c.transport_default).toLocaleString()}` : ''}</span></span>
        </label>`).join('') || '<p class="p-3 text-sm text-gray-400">候補がいません</p>'}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-3">
        <select id="cand-status" class="inp text-sm"><option value="confirmed">確定で登録</option><option value="requested">希望（仮）で登録（本人が可否を返事）</option></select>
        <input id="cand-fee" type="number" class="inp text-sm" placeholder="交通費の実費（空欄でスタッフの標準）" title="空欄のときは、スタッフごとの交通費の標準（精算の画面で登録）を入れます。入力すると選んだ全員に同じ金額を入れます">
      </div>
      ${priceBoxHtml('cand', false)}
      <button class="btn btn-primary w-full mt-3" data-action="assignFromCandidates" data-slot-role-id="${Number(slotRoleId)}">選択したスタッフを割り当て</button>
      <button class="btn btn-outline w-full mt-2 text-sm" data-action="openQuickRegister" data-slot-role-id="${Number(slotRoleId)}"><i class="fas fa-bolt"></i>一覧にいない人を仮登録して割り当て（氏名・電話のみ）</button>`)
    document.getElementById('cand-filter').addEventListener('input', (ev) => {
      const q = ev.target.value.trim()
      document.querySelectorAll('.cand-row').forEach(el => { el.style.display = !q || el.dataset.key.includes(q) ? '' : 'none' })
    })
    // 選んだスタッフの単価の見込み（直近のシフトからの引き継ぎ。9306）
    const names = new Map(data.candidates.map(c => [c.staff_id, c.name]))
    const reload = () => loadPriceBox('cand', { slot_role_id: slotRoleId, staff_ids: [...document.querySelectorAll('.cand-check:checked')].map(el => el.value).join(',') }, names)
    document.querySelectorAll('.cand-check').forEach(el => el.addEventListener('change', reload))
    document.getElementById('cand-inherit').addEventListener('change', () => renderPriceBox('cand'))
    reload()
  }
  window.assignFromCandidates = function (slotRoleId) {
    const ids = [...document.querySelectorAll('.cand-check:checked')].map(el => Number(el.value))
    if (!ids.length) { toast('スタッフを選択してください'); return }
    const fee = document.getElementById('cand-fee').value
    const px = priceExtra('cand'); if (px.error) { toast(px.error); return }
    return assignStaff(slotRoleId, ids, false, { status: document.getElementById('cand-status').value, ...(fee !== '' ? { transportation_fee: Number(fee) } : {}), ...px.body })
  }

  // ---------- 割り当て・一括登録の単価（9306） ----------
  // 直近のシフト（常勤: 同じスタッフ×同じ案件、スポット: 同じ案件）から引き継ぐ単価の見込みを出し、引き継ぐか・単価を変えるかをその場で選べるようにする
  const PRICE_BOX = {}
  const PRICE_LIST_MAX = 30
  function priceBoxHtml(prefix, bulk) {
    return `<div class="rounded-lg border border-gray-100 p-2 mt-3 text-xs space-y-1.5" id="${prefix}-price">
      <div class="flex items-center justify-between gap-2 flex-wrap"><p class="font-bold text-gray-700"><i class="fas fa-yen-sign mr-1"></i>単価</p>
        <label class="flex items-center gap-1 text-gray-600"><input type="checkbox" id="${prefix}-inherit" checked>前回のシフトの単価を引き継ぐ</label></div>
      <div id="${prefix}-price-list" class="text-gray-400">スタッフを選ぶと、単価を表示します</div>
      <div class="grid grid-cols-2 gap-2">
        <label class="text-gray-600">請求単価を変える<input id="${prefix}-bill-rate" type="number" min="0" class="inp text-xs" placeholder="空欄ならそのまま"></label>
        <label class="text-gray-600">支払単価を変える<input id="${prefix}-pay-rate" type="number" min="0" class="inp text-xs" placeholder="空欄ならそのまま"></label>
      </div>
      <p class="text-[11px] text-gray-400">単価を入れると、選んだ全員${bulk ? '・全日' : ''}に同じ単価を入れ、金額は手動変更になります${bulk ? '。表示は開始日の時点の見込みです' : ''}</p>
    </div>`
  }
  async function loadPriceBox(prefix, params, names) {
    const st = PRICE_BOX[prefix] = { ...(PRICE_BOX[prefix] || {}), names, seq: ((PRICE_BOX[prefix] || {}).seq || 0) + 1 }
    const seq = st.seq
    if ('project_id' in params && !params.project_id) { st.data = null; st.error = '案件を選ぶと、単価を表示します'; renderPriceBox(prefix); return }
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))
    try {
      const { data } = await axios.get('/api/admin/shifts/price-preview?' + qs.toString())
      if (seq !== PRICE_BOX[prefix].seq) return // 後から読み直したものを優先する
      st.data = data
    } catch (e) {
      if (seq !== PRICE_BOX[prefix].seq) return
      st.data = null; st.error = errMsg(e)
    }
    renderPriceBox(prefix)
  }
  function renderPriceBox(prefix) {
    const el = document.getElementById(prefix + '-price-list'); if (!el) return
    const st = PRICE_BOX[prefix] || {}
    if (!st.data) { el.innerHTML = `<span class="text-gray-400">${esc(st.error || 'スタッフを選ぶと、単価を表示します')}</span>`; return }
    const items = st.data.items || []
    if (!items.length) { el.innerHTML = '<span class="text-gray-400">スタッフを選ぶと、単価を表示します</span>'; return }
    const use = document.getElementById(prefix + '-inherit').checked
    const rate = (u, r) => (r == null ? '未設定' : `${UNIT_LABEL[u] || ''} ${yen(r)}`)
    const rows = items.slice(0, PRICE_LIST_MAX).map(it => {
      const ih = use ? it.inherited : null
      const p = ih ? it.price : it.settings
      const who = it.staff_id == null ? 'この案件' : (st.names.get(Number(it.staff_id)) || 'ID ' + it.staff_id)
      const from = ih ? `<span class="badge badge-blue whitespace-nowrap">${esc(ih.label)}から引き継ぎ</span>`
        : it.inherited ? '<span class="text-gray-400 whitespace-nowrap">単価の設定（引き継がない）</span>' : '<span class="text-gray-400 whitespace-nowrap">単価の設定</span>'
      return `<div class="flex items-center justify-between gap-2 py-0.5"><span class="font-bold text-gray-700 truncate">${esc(who)}</span>
        <span class="text-right text-gray-600">請求 ${rate(p.bill_unit_type, p.bill_rate)} ／ 支払 ${rate(p.pay_unit_type, p.pay_rate)} ${from}</span></div>`
    }).join('')
    el.innerHTML = `<div class="max-h-40 overflow-y-auto divide-y divide-gray-50">${rows}</div>${items.length > PRICE_LIST_MAX ? `<p class="text-gray-400">ほか ${items.length - PRICE_LIST_MAX}人</p>` : ''}`
  }
  // 送信に足す値（引き継ぐか、変えた単価）。マイナスの単価は送らない
  function priceExtra(prefix) {
    const num = (id) => { const v = document.getElementById(id).value; return v === '' ? null : Number(v) }
    const bill = num(prefix + '-bill-rate'), pay = num(prefix + '-pay-rate')
    if ((bill != null && bill < 0) || (pay != null && pay < 0)) return { error: '単価にマイナスの値は入力できません' }
    const price = {}
    if (bill != null) price.bill_rate = bill
    if (pay != null) price.pay_rate = pay
    return { body: { inherit: document.getElementById(prefix + '-inherit').checked, ...(Object.keys(price).length ? { price } : {}) } }
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
          <label>調整の内容<input id="sp-adj-note" class="inp text-xs" value="${esc(a.adjust_note || '')}" placeholder="手当・控除など"></label>
        </div>
        <p class="text-[11px] text-gray-400">深夜（22〜5時）・時間外（1日8時間超）・休日の割増は、精算の画面の「割増の設定」を ON にすると自動で計算します（調整に入れる必要はありません。下の支払には、確定するまで含みません）</p>
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
  // 状態の変更は admin.js の putShiftStatus を使う（入店などの報告があるシフトを欠勤にするときは、報告の時刻を示して確認する。#221）
  window.boardShiftStatus = async function (id, status) {
    let res
    try {
      res = window.putShiftStatus ? await window.putShiftStatus(id, status) : (await axios.put('/api/admin/shifts/' + id, { status })).data
      if (!res) return // 確認でやめた
    } catch (e) { toast(errMsg(e)); return }
    closeModal(); toast('更新しました'); renderShiftBoard()
    // 欠勤のシフトの承認待ちの打刻修正は承認できないので、却下が必要なことを知らせる（ダッシュボードの欠勤と同じ）
    if (res.pending_corrections) alert(`このシフトには承認待ちの打刻修正が${Number(res.pending_corrections)}件あります。\n欠勤のシフトの申請は承認できないため、打刻修正の画面で却下してください。`)
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
  // 案件を選んでいないときは、開催場所の選択肢を出さない（#9503。初めの案件の場所が出て、違う案件の場所を選ばないように）
  function siteOptions(m, projectId, selected) {
    if (!projectId) return '<option value="">（先に案件を選んでください）</option>'
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
            <select id="slot-project" class="inp" onchange="slotProjectChanged()" required ${s.slot_id ? 'disabled' : ''}>
              <option value="" ${s.project_id ? '' : 'selected'}>選択してください</option>
              ${m.projects.filter(p => p.status === 'active' || String(p.project_id) === String(s.project_id)).map(p => `<option value="${p.project_id}" ${String(p.project_id) === String(s.project_id) ? 'selected' : ''}>${p.engagement_type === 'spot' ? '[スポット] ' : '[常勤] '}${esc(p.project_name)}</option>`).join('')}
            </select></label>
          <label class="text-sm text-gray-600">開催場所
            <select id="slot-site" class="inp" data-orig="${esc(s.site_id || '')}">${siteOptions(m, s.project_id || '', s.site_id)}</select></label>
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
  // 案件を選んでいないときは、案件の欄に移って知らせる（#9503）
  function requireProject(id) {
    const el = document.getElementById(id)
    if (el && el.value) return true
    toast('案件を選択してください（「選択してください」のままでは登録できません）')
    if (el) { el.focus(); el.classList.add('ring-2', 'ring-red-300'); el.addEventListener('change', () => el.classList.remove('ring-2', 'ring-red-300'), { once: true }) }
    return false
  }
  window.saveSlot = async function (slotId) {
    if (!slotId && !requireProject('slot-project')) return
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
  // 枠の編集のモーダルの削除ボタンからも、件数を出して確かめる（#9403）
  window.deleteSlot = function (slotId) { return openDeleteSlot(Number(slotId)) }

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
    if (!requireProject('slot-project')) return
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
    const active = m.projects.filter(p => p.status === 'active')
    // 絞り込みで案件を1つに決めているときだけ、その案件を選んでおく（#9503）
    const preset = BS.projectIds.length === 1 && active.some(p => p.project_id === BS.projectIds[0]) ? BS.projectIds[0] : null
    modal(`
      <h3 class="font-bold text-lg mb-1">常勤の一括登録</h3>
      <p class="text-xs text-gray-500 mb-3">スタッフ × 曜日 × 期間でシフトをまとめて登録します（退職・NG のスタッフと、同じ時間帯に別のシフトがある日はスキップし、一覧で表示します）</p>
      <div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">案件 *<select id="bk-project" class="inp" required><option value="" ${preset ? '' : 'selected'}>選択してください</option>${active.map(p => `<option value="${p.project_id}" ${p.project_id === preset ? 'selected' : ''}>${p.engagement_type === 'spot' ? '[スポット] ' : '[常勤] '}${esc(p.project_name)}</option>`).join('')}</select></label>
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
          <label class="text-sm text-gray-600">交通費の実費<input id="bk-fee" type="number" class="inp" placeholder="空欄でスタッフの標準"></label>
        </div>
        <datalist id="role-suggest"><option value="販売スタッフ"><option value="リーダー"></datalist>
        ${priceBoxHtml('bk', true)}
        <button class="btn btn-primary w-full" data-action="saveBulk">登録する</button>
      </div>`)
    // 選んだスタッフの単価の見込み（開始日の時点。直近のシフトからの引き継ぎ。9306）
    const names = new Map(m.staff.map(s => [s.staff_id, s.name]))
    const v = (k) => document.getElementById(k).value
    const reload = () => loadPriceBox('bk', { project_id: v('bk-project'), work_date: v('bk-from'), role: v('bk-role'), start_time: v('bk-start'), end_time: v('bk-end'),
      staff_ids: [...document.querySelectorAll('.bk-staff:checked')].map(el => el.value).join(',') }, names)
    for (const id of ['bk-project', 'bk-from', 'bk-role', 'bk-start', 'bk-end']) document.getElementById(id).addEventListener('change', reload)
    document.querySelectorAll('.bk-staff').forEach(el => el.addEventListener('change', reload))
    document.getElementById('bk-inherit').addEventListener('change', () => renderPriceBox('bk'))
    reload()
  }
  async function saveBulk() {
    if (!requireProject('bk-project')) return
    const v = (k) => document.getElementById(k).value
    const px = priceExtra('bk'); if (px.error) { toast(px.error); return }
    const body = {
      project_id: Number(v('bk-project')), role: v('bk-role'), staff_ids: [...document.querySelectorAll('.bk-staff:checked')].map(el => Number(el.value)),
      weekdays: [...document.querySelectorAll('.bk-wd:checked')].map(el => Number(el.value)), date_from: v('bk-from'), date_to: v('bk-to'),
      start_time: v('bk-start'), end_time: v('bk-end'), transportation_fee: v('bk-fee'), ...px.body,
    }
    await runJob(newJob({
      title: '常勤の一括登録', url: '/api/admin/shifts/bulk', body, keys: ['created', 'inherited'],
      summary: (n) => `${n.created}件登録しました${n.inherited ? `（${n.inherited}件は前回のシフトの単価を引き継ぎ）` : ''}`, done: () => renderShiftBoard(),
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
  // 単価の設定（区分・標準単価・単価ルール）は精算画面の「単価の設定」に置く（利用者の要望 9201・9203）。
  // 案件詳細には基本単価を表示だけし、繰り返し登録と提出設定を出す
  // =========================================================
  function ruleSummary(r) {
    const parts = []
    // 適用期間（#210）
    if (r.valid_from || r.valid_to) parts.push(`期間 ${r.valid_from ? esc(r.valid_from) : ''}〜${r.valid_to ? esc(r.valid_to) : ''}`)
    if (r.bill_rate != null) parts.push(`請求 ${UNIT_LABEL[r.bill_unit_type] || ''}${yen(r.bill_rate)}`)
    // インセンティブ（加算額。9203）は支払単価に含まれている
    if (r.pay_rate != null) parts.push(`支払 ${UNIT_LABEL[r.pay_unit_type] || ''}${yen(r.pay_rate)}${Number(r.pay_incentive) > 0 ? `（うちインセンティブ ${yen(r.pay_incentive)}）` : ''}`)
    if (r.bill_transport_type) parts.push('交通費請求: ' + BT_LABEL[r.bill_transport_type] + (r.bill_transport_type === 'fixed' ? ' ' + yen(r.bill_transport_amount) : ''))
    if (r.pay_transport_type) parts.push('交通費支払: ' + PT_LABEL[r.pay_transport_type] + (['fixed', 'capped'].includes(r.pay_transport_type) ? ' ' + yen(r.pay_transport_amount) : ''))
    return parts.join(' / ')
  }
  // 単価ルールの備考（経験者加算など。同じ条件のルールを見分けるため、一覧にも出す #388）
  const ruleMemo = (r) => (r.memo ? `<span class="text-gray-400 ml-1">（${esc(r.memo)}）</span>` : '')
  // 一覧に出した単価ルール（編集のモーダルで今の値を入れるため）
  const RULES = new Map()
  function ruleScope(r) {
    return [r.project_name ? esc(r.project_name) : r.project_id ? '' : r.client_id ? 'クライアント全体' + (r.client_name ? '（' + esc(r.client_name) + '）' : '') : '全案件', r.site_name ? '📍' + esc(r.site_name) : '', r.role_name ? '役割: ' + esc(r.role_name) : '', r.staff_name ? '👤' + esc(r.staff_name) : ''].filter(Boolean).join(' × ')
  }
  // 交通費の扱い（基本単価の表示用）
  function transportText(p) {
    const bt = p.bill_transport_type || 'actual', pt = p.pay_transport_type || 'actual'
    return `請求: ${esc(BT_LABEL[bt] || bt)}${bt === 'fixed' ? ' ' + yen(p.bill_transport_amount) : ''}　支払: ${esc(PT_LABEL[pt] || pt)}${['fixed', 'capped'].includes(pt) ? ' ' + yen(p.pay_transport_amount) : ''}`
  }
  // 案件詳細の「基本単価」（表示だけ。9201）。変更は精算画面の「単価の設定」で行う
  window.projectBasePriceHtml = function (p) {
    const payUnit = UNIT_LABEL[p.pay_unit_type || 'daily'] || ''
    const billUnit = UNIT_LABEL[p.unit_price_type === 'hourly' ? 'hourly' : 'daily'] || ''
    return `<section class="card p-4" id="project-base-price">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>基本単価<span class="text-[11px] font-normal text-gray-400 ml-1">（管理画面のみ）</span></h3>
        <button type="button" class="btn btn-outline text-xs" data-action="projectOpenPricing" data-id="${Number(p.project_id)}"><i class="fas fa-scale-balanced"></i>精算画面の「単価の設定」で変更</button>
      </div>
      <dl class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
        <div class="rounded-lg bg-gray-50 p-2"><dt class="text-[11px] text-gray-500">請求</dt><dd class="font-bold">${esc(billUnit)} ${yen(p.unit_price)}</dd></div>
        <div class="rounded-lg bg-gray-50 p-2"><dt class="text-[11px] text-gray-500">支払</dt><dd class="font-bold">${p.pay_rate == null ? '<span class="text-amber-600">未設定</span>' : `${esc(payUnit)} ${yen(p.pay_rate)}`}</dd></div>
        <div class="rounded-lg bg-gray-50 p-2"><dt class="text-[11px] text-gray-500">交通費</dt><dd class="text-xs">${transportText(p)}</dd></div>
      </dl>
      <p class="text-[11px] text-gray-400 mt-2">案件の標準の単価です${p.price_valid_from ? `（${esc(p.price_valid_from)}〜）` : ''}。開催場所・役割・スタッフ別の単価やインセンティブは、精算画面の「単価の設定」で決めます</p>
    </section>`
  }
  delegate('projectOpenPricing', el => { if (window.openSettlePricing) openSettlePricing(Number(el.dataset.id)) })

  // 案件詳細: 提出設定・繰り返し登録
  window.renderProjectPatternsPanel = async function (p) {
    const host = document.getElementById('project-patterns-panel'); if (!host) return
    let pt
    try { pt = (await axios.get('/api/admin/slot-patterns?project_id=' + p.project_id)).data } catch (e) { host.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e, '繰り返し登録を読み込めませんでした'))}</p>`; return }
    host.innerHTML = `
      <div class="grid lg:grid-cols-2 gap-4">
        <section class="card p-4 lg:col-span-2" id="project-report-settings"></section>
        <section class="card p-4 lg:col-span-2" id="project-patterns">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-repeat text-blue-500 mr-1"></i>繰り返し登録</h3>
            <button class="btn btn-outline text-xs" data-action="projectPatternAdd" data-id="${Number(p.project_id)}"><i class="fas fa-plus"></i>追加</button>
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
  delegate('projectPatternAdd', el => openPatternModal({ project_id: Number(el.dataset.id) }))

  // 精算画面の「単価の設定」（9203）: 区分・標準単価と単価ルール（開催場所・役割・スタッフ別、インセンティブ、備考）。
  // 計算（ルールの優先順・改定履歴・再適用）は今までと同じ API を使う
  window.renderSettlePricingPanel = async function (pid) {
    const host = document.getElementById('settle-pricing-panel'); if (!host) return
    host.dataset.pid = String(Number(pid) || '')
    if (!pid) { host.innerHTML = '<p class="text-sm text-gray-400 py-6 text-center">案件を選ぶと、その案件の単価の設定が出ます</p>'; return }
    host.innerHTML = '<p class="text-sm text-gray-400 py-6 text-center"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中…</p>'
    let m, rr, ph
    try {
      m = await loadMaster()
      // 登録したばかりの案件などで選択肢が古いときは取り直す
      if (!m.projects.some(x => Number(x.project_id) === Number(pid))) { invalidateMaster(); m = await loadMaster() }
      ;[{ data: rr }, ph] = await Promise.all([axios.get('/api/admin/rate-rules?project_id=' + Number(pid)),
        axios.get(`/api/admin/projects/${Number(pid)}/price-history`).then(r => r.data).catch(() => null)])
    } catch (e) { host.innerHTML = `<p class="text-sm text-red-600">${esc(errMsg(e, '単価の設定を読み込めませんでした'))}</p>`; return }
    // 別の案件に切り替えた後に古い応答が届いたら描かない
    if (Number(host.dataset.pid || 0) !== Number(pid)) return
    const p = m.projects.find(x => Number(x.project_id) === Number(pid))
    if (!p) { host.innerHTML = '<p class="text-sm text-red-600">案件が見つかりません</p>'; return }
    const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')
    const eng = p.engagement_type || 'regular'
    const id = Number(p.project_id), cid = Number(p.client_id) || ''
    host.innerHTML = `
      <div class="flex items-center gap-2 mb-3 flex-wrap text-sm">
        <span class="font-bold text-gray-800">${esc(p.project_name)}</span>${p.client_name ? `<span class="text-gray-500">${esc(p.client_name)}</span>` : ''}
        ${p.status && p.status !== 'active' ? '<span class="badge badge-gray">終了</span>' : ''}
        <a class="text-xs text-blue-600 hover:underline ml-auto" href="#projects/${id}">案件詳細を開く</a>
        <a class="text-xs text-blue-600 hover:underline" href="#shifts" data-action="pricingOpenBoard" data-id="${id}">シフトボードで開く</a>
      </div>
      <div class="grid lg:grid-cols-2 gap-4">
        <section class="card p-4" id="project-pricing">
          <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>区分・標準単価<span class="text-[11px] font-normal text-gray-400 ml-1">（管理画面のみ）</span></h3>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <label class="col-span-2">区分<select id="pp-eng" class="inp text-sm"><option value="regular" ${eng === 'regular' ? 'selected' : ''}>常勤案件</option><option value="spot" ${eng === 'spot' ? 'selected' : ''}>スポット案件（イベント・週末のみ等）</option></select></label>
            <label>請求の単位<select id="pp-bill-unit" class="inp text-sm">${opt(UNIT_LABEL, p.unit_price_type === 'hourly' ? 'hourly' : 'daily')}</select></label>
            <label>請求単価<input id="pp-bill" type="number" min="0" class="inp text-sm" value="${Number(p.unit_price ?? 0)}"></label>
            <label>支払の単位<select id="pp-pay-unit" class="inp text-sm">${opt(UNIT_LABEL, p.pay_unit_type || 'daily')}</select></label>
            <label>支払単価<input id="pp-pay" type="number" min="0" class="inp text-sm" value="${p.pay_rate == null ? '' : Number(p.pay_rate)}" placeholder="未設定"></label>
            <label>交通費の請求<select id="pp-bt" class="inp text-sm">${opt(BT_LABEL, p.bill_transport_type || 'actual')}</select></label>
            <label>定額の場合の金額<input id="pp-bt-amt" type="number" min="0" class="inp text-sm" value="${Number(p.bill_transport_amount || 0)}"></label>
            <label>交通費の支払<select id="pp-pt" class="inp text-sm">${opt(PT_LABEL, p.pay_transport_type || 'actual')}</select></label>
            <label>上限 / 定額の金額<input id="pp-pt-amt" type="number" min="0" class="inp text-sm" value="${Number(p.pay_transport_amount || 0)}"></label>
            <label class="col-span-2">単価を変えるときの適用開始日<input id="pp-valid-from" type="date" class="inp text-sm" value="">
              <span class="block text-[11px] text-gray-400">入れると、その前日までの稼働日は今の単価のまま計算します。空欄なら今の単価${p.price_valid_from ? `（${esc(p.price_valid_from)}〜）` : ''}を直します</span></label>
            <label>休憩（時給計算用・分）<input id="pp-break" type="number" min="0" max="600" class="inp text-sm" value="${Number(p.default_break_minutes ?? 60)}"></label>
            <label>時給の時間の数え方<select id="pp-hours-basis" class="inp text-sm">${opt({ clipped: '実働（予定の範囲内）', actual: '実働どおり', scheduled: '予定どおり' }, p.hours_basis || 'clipped')}</select></label>
            <label>時刻の丸め<select id="pp-round" class="inp text-sm">${opt({ 0: '丸めない', 5: '5分', 10: '10分', 15: '15分', 30: '30分' }, String(p.time_round_minutes || 0))}</select></label>
            <label>支払の丸め<select id="pp-pay-round" class="inp text-sm">${opt({ none: '支払は丸めない（1分単位）', same: '支払も同じく丸める' }, p.pay_time_round === 'same' ? 'same' : 'none')}</select></label>
          </div>
          <p class="text-[11px] text-gray-400 mt-1">時給は入店・退店の実績から計算します。「予定の範囲内」は早く来た・遅く残った分を含めません。丸めは開始を切り上げ、終了を切り捨てます</p>
          ${p.pay_time_round === 'same' && Number(p.time_round_minutes || 0) > 0 ? '<p class="text-[11px] text-amber-600 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>支払も丸めています。自社給与・日雇い給与のスタッフの労働時間を日ごとに切り捨てると、賃金の未払いになるおそれがあります（給与は1分単位で計算してください）</p>' : ''}
          ${priceHistoryHtml(ph)}
          <button class="btn btn-primary w-full mt-3 text-sm" data-action="pricingSave" data-id="${id}">保存する</button>
          <p class="text-[11px] text-gray-400 mt-2">保存しても、登録済みのシフトの金額は変わりません。変更を反映するには「単価ルールを再適用」を使ってください</p>
          <button class="btn btn-outline w-full mt-2 text-xs" data-action="pricingReprice" data-id="${id}"><i class="fas fa-rotate"></i>今後のシフトに単価ルールを再適用</button>
        </section>

        <section class="card p-4" id="project-rate-rules">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-list-check text-blue-500 mr-1"></i>単価ルール（開催場所・役割・スタッフ別）</h3>
            <button class="btn btn-outline text-xs" data-action="ruleAdd" data-pid="${id}" data-cid="${cid}"><i class="fas fa-plus"></i>追加</button>
          </div>
          <p class="text-[11px] text-gray-400 mb-2">人によって単価を変えるときはスタッフを選び、インセンティブ（加算額）・備考も入れられます。優先順: スタッフ ＞ 役割 ＞ 開催場所 ＞ 案件の標準。項目ごとに最も具体的なルールを使います。クライアントの全案件に共通のルールは、クライアント詳細の「単価ルール（クライアント共通）」で設定します（同じ条件なら案件のルールが優先）</p>
          <div class="space-y-1.5 max-h-96 overflow-y-auto">
            ${rr.rules.map(r => `<div class="flex items-start gap-2 p-2 rounded-lg bg-gray-50 text-xs">
              <div class="flex-1 min-w-0"><p class="font-bold">${ruleScope(r)}</p><p class="text-gray-600">${ruleSummary(r)}${ruleMemo(r)}</p></div>
              <button class="text-blue-600 hover:underline whitespace-nowrap" data-action="editRule" data-id="${Number(r.rule_id)}" data-pid="${id}" data-cid="${cid}">編集</button>
              <button class="text-blue-600 hover:underline whitespace-nowrap" data-action="ruleSetEnd" data-id="${Number(r.rule_id)}" data-to="${esc(r.valid_to || '')}" data-pid="${id}" title="単価の改定: 旧ルールに終了日を付けて残します">終了日</button>
              <button class="text-gray-400 hover:text-red-500" data-action="ruleDelete" data-id="${Number(r.rule_id)}" data-pid="${id}" title="削除"><i class="fas fa-trash"></i></button></div>`).join('') || '<p class="text-xs text-gray-400">ルールはありません（案件の標準単価を使います）</p>'}
          </div>
        </section>
      </div>`
    for (const r of rr.rules) RULES.set(r.rule_id, r)
  }
  // 単価の設定を変えた後の描き直し（精算画面の単価の設定を開いていればそこを、そうでなければ案件詳細を描き直す）
  function refreshPricing(pid) {
    const host = document.getElementById('settle-pricing-panel')
    if (host) return window.renderSettlePricingPanel(Number(pid))
    if (window.renderProjectDetail) return renderProjectDetail(Number(pid))
  }
  delegate('pricingSave', el => withSubmitLock(el, () => saveProjectPricing(Number(el.dataset.id))))
  delegate('pricingReprice', el => repriceProject(Number(el.dataset.id)))
  delegate('pricingOpenBoard', el => { BS.projectIds = [Number(el.dataset.id)] })
  delegate('ruleAdd', el => openRuleModal({ project_id: Number(el.dataset.pid), client_id: Number(el.dataset.cid) || null }))
  delegate('ruleDelete', el => withSubmitLock(el, () => deleteRule(Number(el.dataset.id), Number(el.dataset.pid))))
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
      await refreshPricing(pid)
    } catch (e) { toast(errMsg(e)) }
  }
  // 単価ルールの再適用（#469）: 期間を選び、金額・支払先が変わるシフトと増減の合計を確かめてから実行する
  window.repriceProject = function (pid, staffId, clientId) {
    if (BULK_JOB && BULK_JOB.running) { toast('ほかの一括処理を実行中です'); return }
    window.__repriceCtx = { pid: pid || null, staffId: staffId || null, clientId: clientId || null }
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
    return { from: document.getElementById('rp-from').value, to: document.getElementById('rp-to').value, ...(c.pid ? { project_id: c.pid } : {}), ...(c.staffId ? { staff_id: c.staffId } : {}), ...(c.clientId ? { client_id: c.clientId } : {}) }
  }
  const PAYEE_SHORT = { payroll: '自社給与', payroll_daily: '日雇い給与', freelance: '個人事業主', partner: '協力会社', linked: '他社（連携元）' }
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
      <label class="flex items-start gap-2 text-sm p-2 rounded border border-gray-200"><input type="radio" name="pd-mode" value="future"><span>今日以降の、割り当てのない枠も削除する<span class="block text-[11px] text-gray-400">割り当てのある枠は残ります</span>
        <span class="block text-[11px] text-amber-700">${x.future_pending_applications != null ? `削除する枠への未対応の応募 ${Number(x.future_pending_applications)}件` : '削除する枠に未対応の応募があれば、その応募'}は「枠の削除」で処理済みになり、承認できなくなります（#65）</span></span></label>
      <button class="btn btn-danger w-full mt-4" data-action="deletePatternRun" data-id="${Number(x.pattern_id)}"><i class="fas fa-trash"></i>削除する</button>`)
  })
  delegate('deletePatternRun', el => withSubmitLock(el, async () => {
    const x = PATTERNS.get(Number(el.dataset.id)); if (!x) return
    const future = (document.querySelector('input[name="pd-mode"]:checked') || {}).value === 'future'
    let data
    try { data = (await axios.delete(`/api/admin/slot-patterns/${Number(x.pattern_id)}?remove_future=${future ? 1 : 0}&today=${dayjs().format('YYYY-MM-DD')}`)).data } catch (e) { toast(errMsg(e)); return }
    closeModal(); toast(`削除しました${data.removed ? `（枠${data.removed}件を削除）` : ''}`); renderProjectDetail(x.project.project_id)
  }))

  // ---------- 単価ルールの追加・編集（#388） ----------
  // rule を渡すと、その値を入れて編集として開く（保存は PUT /rate-rules/:id）。
  // 案件から開いたとき（精算画面の単価の設定）は、スタッフ別の単価（人によって単価を変える）を入れられ、
  // スタッフを選ぶとスタッフマスタの支払の参考単価（9204）を目安として出す。インセンティブ（加算額）・備考はどこから開いても入れられる（9203）
  let REF_PAY = new Map()
  const REF_UNIT = { daily: '日給', hourly: '時給' }
  async function loadReferencePay() {
    try { REF_PAY = new Map((await axios.get('/api/admin/staff-reference-pay')).data.staff.map(s => [Number(s.staff_id), s])) } catch { REF_PAY = new Map() }
  }
  function refPayHint() {
    const box = document.getElementById('rl-staff-ref'); if (!box) return
    const sid = Number((document.getElementById('rl-staff') || {}).value || 0)
    const ref = sid ? REF_PAY.get(sid) : null
    // 他社連携の人の参考単価は所属元だけが持つ（自社では入力できない）
    const linked = sid && ((MASTER && MASTER.staff) || []).some(s => Number(s.staff_id) === sid && s.affiliation_type === 'linked_external')
    box.innerHTML = !sid ? '' : linked ? '<i class="fas fa-circle-info mr-1"></i>他社から連携したスタッフのため、参考単価は出ません（所属元の会社が管理します）' : ref
      ? `<i class="fas fa-circle-info mr-1"></i>参考単価: ${esc(REF_UNIT[ref.reference_pay_unit] || '')} ${yen(ref.reference_pay_amount)}（スタッフマスタで入力した目安。計算には使いません）
         <button type="button" class="text-blue-600 hover:underline ml-1" data-action="ruleUseReference">支払単価（基本）に入れる</button>`
      : '<i class="fas fa-circle-info mr-1"></i>この人の参考単価は入力されていません（スタッフマスタのスタッフ詳細で入力できます）'
    const wrap = document.getElementById('rl-staff-scope-wrap'); if (wrap) wrap.classList.toggle('hidden', !sid)
  }
  // 支払単価（基本）＋インセンティブ（加算額）＝ 計算に使う支払単価
  function payTotalHint() {
    const box = document.getElementById('rl-pay-total'); if (!box) return
    const base = document.getElementById('rl-pay').value, inc = document.getElementById('rl-inc').value
    box.textContent = inc !== '' && Number(inc) > 0
      ? (base === '' ? 'インセンティブを入れるときは、支払単価（基本）も入力してください' : `計算に使う支払単価: ${yen(Number(base) + Number(inc))}（基本 ${yen(base)} ＋ インセンティブ ${yen(inc)}）`)
      : ''
  }
  delegate('ruleUseReference', () => {
    const ref = REF_PAY.get(Number((document.getElementById('rl-staff') || {}).value || 0)); if (!ref) return
    document.getElementById('rl-pay').value = String(Number(ref.reference_pay_amount))
    document.getElementById('rl-pay-unit').value = ref.reference_pay_unit === 'hourly' ? 'hourly' : 'daily'
    payTotalHint()
  })
  window.openRuleModal = async function (ctx, rule) {
    const [m] = await Promise.all([loadMaster(), ctx.project_id ? loadReferencePay() : null])
    const r = rule || {}
    const same = (a, b) => a != null && b != null && String(a) === String(b)
    const sel = (a, b) => (same(a, b) ? 'selected' : '')
    // 無効の開催場所・選択肢にない人でも、編集中のルールが使っているものは残す（保存で条件が外れないように）
    const sites = m.sites.filter(s => same(s.site_id, r.site_id) || (s.status !== 'inactive' && (ctx.client_scope ? String(s.client_id) === String(ctx.client_id)
      : (!ctx.client_id || !s.client_id || String(s.client_id) === String(ctx.client_id)))))
    const staff = r.staff_id && !m.staff.some(s => same(s.staff_id, r.staff_id)) ? [...m.staff, { staff_id: r.staff_id, name: r.staff_name || ('ID ' + r.staff_id) }] : m.staff
    const opt = (map, v) => `<option value="">（変更しない）</option>` + Object.entries(map).map(([k, l]) => `<option value="${k}" ${sel(k, v)}>${l}</option>`).join('')
    const unitOpt = (v) => `<option value="daily">日額</option><option value="hourly" ${v === 'hourly' ? 'selected' : ''}>時給</option>`
    const val = (v) => (v == null ? '' : esc(v))
    // インセンティブは支払単価に含めて保存しているので、入力欄には基本の単価（支払単価 − 加算額）を出す
    const inc = Number(r.pay_incentive) > 0 && r.pay_rate != null ? Number(r.pay_incentive) : null
    const payBase = r.pay_rate == null ? null : Number(r.pay_rate) - (inc || 0)
    modal(`
      <h3 class="font-bold text-lg mb-1">${rule ? '単価ルールを編集' : '単価ルールを追加'}</h3>
      <p class="text-xs text-gray-500 mb-3">条件に合うシフトで、入力した項目だけを上書きします（空欄の項目は上書きしません）${rule ? '。保存しても、登録済みのシフトの金額は再適用するまで変わりません' : ''}</p>
      <div class="grid grid-cols-2 gap-2 text-xs">
        ${ctx.project_id || ctx.client_scope ? `<label>開催場所<select id="rl-site" class="inp text-sm"><option value="">すべて</option>${sites.map(s => `<option value="${Number(s.site_id)}" ${sel(s.site_id, r.site_id)}>${esc(s.site_name)}${s.status === 'inactive' ? '（無効）' : ''}</option>`).join('')}</select></label>
        <label>役割<input id="rl-role" class="inp text-sm" placeholder="すべて" list="role-suggest" value="${val(r.role_name)}"></label>` : ''}
        ${ctx.project_id ? `<label class="col-span-2">スタッフ（人によって単価を変えるとき）<select id="rl-staff" class="inp text-sm"><option value="">すべて</option>${staff.map(s => `<option value="${Number(s.staff_id)}" ${sel(s.staff_id, r.staff_id)}>${esc(s.name)}</option>`).join('')}</select></label>
        <p class="col-span-2 text-[11px] text-gray-500 -mt-1" id="rl-staff-ref"></p>
        <label class="col-span-2 ${r.staff_id ? '' : 'hidden'}" id="rl-staff-scope-wrap">このスタッフの単価を使う案件<select id="rl-staff-scope" class="inp text-sm">
          <option value="project">この案件だけ</option><option value="all" ${r.staff_id && !r.project_id ? 'selected' : ''}>すべての案件（このスタッフの全案件に共通）</option></select></label>` : ''}
        <label>請求の単位<select id="rl-bill-unit" class="inp text-sm">${unitOpt(r.bill_unit_type)}</select></label>
        <label>請求単価<input id="rl-bill" type="number" min="0" class="inp text-sm" placeholder="変更しない" value="${val(r.bill_rate)}"></label>
        <label>支払の単位<select id="rl-pay-unit" class="inp text-sm">${unitOpt(r.pay_unit_type)}</select></label>
        <label>支払単価（基本）<input id="rl-pay" type="number" min="0" class="inp text-sm" placeholder="変更しない" value="${val(payBase)}"></label>
        <label class="col-span-2">インセンティブ（加算額・任意）<input id="rl-inc" type="number" min="0" class="inp text-sm" placeholder="例: 2000" value="${val(inc)}">
          <span class="block text-[11px] text-gray-400">支払単価（基本）に足した金額で計算します（時給なら1時間あたりの加算）</span>
          <span class="block text-[11px] text-blue-700" id="rl-pay-total"></span></label>
        <label>交通費の請求<select id="rl-bt" class="inp text-sm">${opt(BT_LABEL, r.bill_transport_type)}</select></label>
        <label>定額の金額<input id="rl-bt-amt" type="number" class="inp text-sm" value="${val(r.bill_transport_amount)}"></label>
        <label>交通費の支払<select id="rl-pt" class="inp text-sm">${opt(PT_LABEL, r.pay_transport_type)}</select></label>
        <label>上限 / 定額の金額<input id="rl-pt-amt" type="number" class="inp text-sm" value="${val(r.pay_transport_amount)}"></label>
        <label>適用開始日<input id="rl-from" type="date" class="inp text-sm" value="${val(r.valid_from)}"></label>
        <label>適用終了日<input id="rl-to" type="date" class="inp text-sm" value="${val(r.valid_to)}"></label>
        <p class="col-span-2 text-[11px] text-gray-400">空欄は期限なし。単価を改定するときは、旧ルールに終了日を付けて残し、新しいルールに開始日を入れます（シフトの稼働日で選びます）</p>
        <label class="col-span-2">備考<input id="rl-memo" class="inp text-sm" maxlength="200" placeholder="例: 経験者加算・リーダー手当" value="${val(r.memo)}"></label>
      </div>
      <datalist id="role-suggest"><option value="販売"><option value="リーダー"><option value="MC"><option value="設営"></datalist>
      <button class="btn btn-primary w-full mt-4" data-action="saveRule">${rule ? '保存する' : '追加する'}</button>`)
    window.__ruleCtx = { ...ctx, ...(rule ? { rule_id: rule.rule_id } : {}) }
    const st = document.getElementById('rl-staff'); if (st) st.addEventListener('change', refPayHint)
    for (const k of ['rl-pay', 'rl-inc']) document.getElementById(k).addEventListener('input', payTotalHint)
    refPayHint(); payTotalHint()
  }
  delegate('saveRule', el => withSubmitLock(el, () => saveRule(window.__ruleCtx || {})))
  delegate('editRule', (el) => {
    const r = RULES.get(Number(el.dataset.id)); if (!r) return
    if (el.dataset.client) openRuleModal({ client_id: Number(el.dataset.client), client_scope: true }, r)
    else openRuleModal({ project_id: Number(el.dataset.pid), client_id: Number(el.dataset.cid) || null }, r)
  })
  // 単価ルールに終了日を付ける（単価の改定で旧ルールを残すとき。#210）
  delegate('ruleSetEnd', async (el) => {
    const to = prompt('このルールの適用終了日（YYYY-MM-DD。空欄にすると期限なし）', el.dataset.to || dayjs().endOf('month').format('YYYY-MM-DD'))
    if (to === null) return
    try {
      await axios.put('/api/admin/rate-rules/' + Number(el.dataset.id), { valid_to: to.trim() })
      toast('終了日を保存しました')
      if (el.dataset.client) renderClientRatePanel(Number(el.dataset.client)); else refreshPricing(Number(el.dataset.pid))
    } catch (e) { toast(errMsg(e)) }
  })
  window.saveRule = async function (ctx) {
    const v = (k) => { const el = document.getElementById(k); return el ? el.value : '' }
    // インセンティブ（加算額）は支払単価に足して送る（計算は加算後の支払単価で行う。pay_incentive は記録と表示のため）
    const base = v('rl-pay'), inc = v('rl-inc')
    const hasInc = inc !== '' && Number(inc) !== 0
    if (hasInc && base === '') { toast('インセンティブを入れるときは、支払単価（基本）も入力してください'); return }
    const body = {
      site_id: v('rl-site') ? Number(v('rl-site')) : null,
      role_name: v('rl-role'), staff_id: v('rl-staff') ? Number(v('rl-staff')) : null,
      // クライアント単位のルール（#470）
      ...(ctx.client_scope ? { client_id: ctx.client_id } : {}),
      bill_unit_type: v('rl-bill-unit'), bill_rate: v('rl-bill'), pay_unit_type: v('rl-pay-unit'),
      pay_rate: hasInc && Number(inc) > 0 ? String(Number(base) + Number(inc)) : base, pay_incentive: hasInc ? inc : null,
      bill_transport_type: v('rl-bt') || null, bill_transport_amount: v('rl-bt-amt'), pay_transport_type: v('rl-pt') || null, pay_transport_amount: v('rl-pt-amt'), memo: v('rl-memo'),
      valid_from: v('rl-from'), valid_to: v('rl-to'),
    }
    // 案件から開いたとき: スタッフ別の単価を「すべての案件」にしたら案件を持たないルールにする
    if (ctx.project_id) body.project_id = body.staff_id && v('rl-staff-scope') === 'all' ? null : ctx.project_id
    else if (!ctx.rule_id) body.project_id = null
    // 編集では、画面に入力欄のない条件は送らず、今の値のままにする
    if (ctx.rule_id) {
      const has = (k) => !!document.getElementById(k)
      if (!has('rl-site')) delete body.site_id
      if (!has('rl-role')) delete body.role_name
      if (!has('rl-staff')) delete body.staff_id
    }
    try {
      if (ctx.rule_id) await axios.put('/api/admin/rate-rules/' + Number(ctx.rule_id), body)
      else await axios.post('/api/admin/rate-rules', body)
    } catch (e) { toast(errMsg(e)); return }
    closeModal(); toast(ctx.rule_id ? '単価ルールを保存しました' : '単価ルールを追加しました')
    if (ctx.client_scope) {
      await renderClientRatePanel(ctx.client_id)
      if (confirm('登録済みのシフトの金額は、まだ変わっていません。このクライアントの今後のシフトに単価ルールを再適用しますか？（次の画面で、変わる件数と金額を確認できます）'))
        repriceProject(null, null, ctx.client_id)
      return
    }
    await refreshPricing(ctx.project_id)
    // 登録済みのシフトは再適用するまで変わらないので、続けて再適用するかを確かめる（変わる件数と金額は次の画面で確認できる）
    if (confirm('登録済みのシフトの金額は、まだ変わっていません。今後のシフトに単価ルールを再適用しますか？（次の画面で、変わる件数と金額を確認できます）')) {
      // すべての案件に当てるスタッフ別の単価は、そのスタッフのシフトを再適用する
      if (body.staff_id && body.project_id === null) repriceProject(null, body.staff_id); else repriceProject(ctx.project_id)
    }
  }
  window.deleteRule = async function (id, pid) {
    if (!confirm('この単価ルールを削除しますか？（登録済みのシフトの金額は変わりません）')) return
    try { await axios.delete('/api/admin/rate-rules/' + Number(id)); toast('削除しました'); await refreshPricing(pid) } catch (e) { toast(errMsg(e)) }
  }

  // =========================================================
  // スタッフ詳細: 支払の参考単価（9204）。スタッフ別の単価ルールは精算画面の「単価の設定」で管理する
  // =========================================================
  window.renderStaffReferencePayPanel = function (sid, p) {
    const host = document.getElementById('staff-reference-pay-panel'); if (!host) return
    // 他社連携の行（参考単価は所属元だけが見る）・スキルシートのみ・統合済みの人には出さない
    if (!p || ['linked_external', 'skillsheet_only'].includes(p.affiliation_type) || p.merged_into_staff_id) { host.innerHTML = ''; return }
    const amount = p.reference_pay_amount == null ? '' : Number(p.reference_pay_amount)
    host.innerHTML = `<section class="card p-4" id="staff-reference-pay">
      <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>支払の参考単価<span class="text-[11px] font-normal text-gray-400 ml-1">（管理画面のみ・連携先には共有されません）</span></h3>
      <p class="text-xs text-gray-500 mb-2">参考価格を入力してください。計算には使いません（精算画面で人ごとの単価を決めるときの目安として表示します）</p>
      <div class="flex gap-2 items-center flex-wrap">
        <select id="staff-ref-unit" class="inp text-sm w-28" aria-label="参考単価の単位"><option value="daily">日給</option><option value="hourly" ${p.reference_pay_unit === 'hourly' ? 'selected' : ''}>時給</option></select>
        <input id="staff-ref-amount" type="number" min="0" step="1" class="inp text-sm w-40" value="${amount}" placeholder="例: 12000" aria-label="参考単価（円）">
        <span class="text-xs text-gray-500">円</span>
        <button type="button" class="btn btn-primary text-xs" data-action="staffRefPaySave" data-id="${Number(sid)}"><i class="fas fa-floppy-disk"></i>保存</button>
      </div>
      <p class="text-[11px] text-gray-400 mt-1">空欄で保存すると消します。実際の単価は、精算画面の「単価の設定」で案件を選び、スタッフ別の単価ルールとして決めます</p>
    </section>`
  }
  delegate('staffRefPaySave', el => withSubmitLock(el, async () => {
    const amount = document.getElementById('staff-ref-amount').value.trim()
    if (amount !== '' && !/^[0-9]+$/.test(amount)) { toast('参考単価は0以上の整数（円）で入力してください'); return }
    try {
      await axios.put(`/api/admin/staff/${Number(el.dataset.id)}/reference-pay`, { unit: document.getElementById('staff-ref-unit').value, amount: amount === '' ? null : Number(amount) })
      toast(amount === '' ? '参考単価を消しました' : '参考単価を保存しました')
    } catch (e) { toast(errMsg(e, '参考単価を保存できませんでした')) }
  }))

  // =========================================================
  // スタッフ詳細: 今後のシフト・過去の稼働・NG指定（#224 #204）。data は GET /api/admin/staff/:id の結果
  // =========================================================
  const ST_BADGE = { requested: 'badge-yellow', confirmed: 'badge-blue', absent: 'badge-red', substitute: 'badge-purple' }
  window.renderStaffShiftPanel = function (sid, data) {
    const host = document.getElementById('staff-shift-panel'); if (!host) return
    if (data.profile && data.profile.affiliation_type === 'skillsheet_only') { host.innerHTML = ''; return }
    const up = data.upcoming_shifts || [], past = data.past_shifts || [], ng = data.ng_clients || []
    const today = data.today || dayjs().format('YYYY-MM-DD')
    const rows = (list) => list.map(s => `<tr>
      <td class="whitespace-nowrap">${esc(dayjs(s.work_date).format('M/D'))}(${WD[dayjs(s.work_date).day()]})</td>
      <td><span class="font-bold">${esc(s.project_name || '')}</span>${s.client_name ? `<span class="block text-[11px] text-gray-400">${esc(s.client_name)}</span>` : ''}</td>
      <td class="whitespace-nowrap">${esc(s.start_time)}〜${esc(s.end_time)}</td>
      <td class="text-xs text-gray-500">${esc([s.site_name || s.location, s.role].filter(Boolean).join('・') || '-')}</td>
      <td class="whitespace-nowrap"><span class="badge ${ST_BADGE[s.status] || 'badge-gray'}">${esc(ST_LABEL[s.status] || s.status)}</span>${s.settle_status === 'confirmed' ? '<span class="badge badge-green ml-1">実績確定</span>' : ''}</td>
      <td class="text-right whitespace-nowrap"><button class="text-xs text-blue-600 hover:underline" data-action="boardOpenDate" data-date="${esc(s.work_date)}">ボードで開く</button>
        ${s.status !== 'absent' && s.status !== 'requested' && s.work_date <= today ? `<button class="text-xs text-blue-600 hover:underline ml-2" data-action="corrNew" data-shift-id="${Number(s.shift_id)}" title="打刻の修正・打刻漏れの追加を、管理者として申請します（#393）">打刻を修正</button>` : ''}
        <button class="text-xs text-gray-500 hover:underline ml-2" data-action="opLogShow" data-entity="shift" data-id="${Number(s.shift_id)}" data-title="変更履歴（${esc(dayjs(s.work_date).format('M/D'))} ${esc(s.project_name || '')}）" title="このシフトの変更を、誰がいつ行ったか（#159）">履歴</button></td></tr>`).join('')
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
    Object.assign(BS, { from: weekStart(el.dataset.date), range: BS.range === 'month' ? 'week' : BS.range, clientId: '', projectIds: [], engagement: '', onlyShort: false, sel: null })
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
        ${data.sites.map(s => `<tr><td><span class="font-bold">${esc(s.site_name)}</span>${s.memo ? `<span class="block text-[11px] text-gray-400 whitespace-pre-wrap">${esc(s.memo)}</span>` : ''}</td>
          <td class="text-xs text-gray-500">${esc(s.address || '-')}${s.lat != null && s.lng != null ? `<a class="block text-blue-600 hover:underline" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.lat + ',' + s.lng)}"><i class="fas fa-location-dot mr-0.5"></i>位置を登録済み</a>` : ''}</td><td>${s.shift_count}件</td>
          <td>${s.status === 'inactive' ? '<span class="badge badge-gray">無効</span>' : '<span class="badge badge-green">有効</span>'}</td>
          <td class="text-right whitespace-nowrap"><button class="text-xs text-blue-600 hover:underline mr-2" data-action="editSite" data-id="${Number(s.site_id)}" data-cid="${esc(cid)}">編集</button>
            ${s.status === 'inactive' ? `<button class="text-xs text-blue-600 hover:underline" data-action="toggleSite" data-id="${s.site_id}" data-cid="${esc(cid)}" data-status="active">有効にする</button>` : `<button class="text-xs text-red-600 hover:underline" data-action="removeSite" data-id="${s.site_id}" data-cid="${esc(cid)}">削除</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400">開催場所はありません</td></tr>'}
      </tbody></table></div>
    </section>`
    SITES = new Map(data.sites.map(s => [s.site_id, s]))
    renderClientRatePanel(cid)
  }

  // =========================================================
  // クライアント詳細: クライアント共通の単価ルール（#470）。そのクライアントの全案件に当てる（案件のルールより弱い）
  // =========================================================
  window.renderClientRatePanel = async function (cid) {
    let host = document.getElementById('client-rate-panel')
    if (!host) {
      const sites = document.getElementById('client-sites-panel'); if (!sites) return
      host = document.createElement('div'); host.id = 'client-rate-panel'; host.className = 'mt-4'; sites.after(host)
    }
    let data
    try { data = (await axios.get('/api/admin/rate-rules?client_id=' + Number(cid))).data } catch (e) { host.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e, '単価ルールを読み込めませんでした'))}</p>`; return }
    for (const r of data.rules) RULES.set(r.rule_id, r)
    const id = Number(cid)
    host.innerHTML = `<section class="card p-4" id="client-rate-rules">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>単価ルール（クライアント共通）<span class="text-[11px] font-normal text-gray-400 ml-1">（管理画面のみ）</span></h3>
        <div class="flex gap-2">
          <button class="btn btn-outline text-xs" data-action="clientRuleReprice" data-client="${id}"><i class="fas fa-rotate"></i>今後のシフトに再適用</button>
          <button class="btn btn-outline text-xs" data-action="clientRuleAdd" data-client="${id}"><i class="fas fa-plus"></i>追加</button>
        </div>
      </div>
      <p class="text-[11px] text-gray-400 mb-2">このクライアントの全案件に当てる単価・交通費です（例: リーダー役割は +2,000円、○○店は交通費定額）。開催場所・役割で条件を付けられます。同じ条件なら案件・スタッフのルールが優先します</p>
      <div class="space-y-1.5">${data.rules.map(r => `<div class="flex items-start gap-2 p-2 rounded-lg bg-gray-50 text-xs">
        <div class="flex-1 min-w-0"><p class="font-bold">${ruleScope(r)}</p><p class="text-gray-600">${ruleSummary(r) + ruleMemo(r)}</p></div>
        <button class="text-blue-600 hover:underline whitespace-nowrap" data-action="editRule" data-id="${Number(r.rule_id)}" data-client="${id}">編集</button>
        <button class="text-blue-600 hover:underline whitespace-nowrap" data-action="ruleSetEnd" data-id="${Number(r.rule_id)}" data-to="${esc(r.valid_to || '')}" data-client="${id}" title="単価の改定: 旧ルールに終了日を付けて残します">終了日</button>
        <button class="text-gray-400 hover:text-red-500" data-action="clientRuleDelete" data-id="${Number(r.rule_id)}" data-client="${id}" title="削除"><i class="fas fa-trash"></i></button></div>`).join('') || '<p class="text-xs text-gray-400">クライアント共通のルールはありません（案件ごとの単価を使います）</p>'}</div>
    </section>`
  }
  delegate('clientRuleAdd', el => openRuleModal({ client_id: Number(el.dataset.client), client_scope: true }))
  delegate('clientRuleReprice', el => repriceProject(null, null, Number(el.dataset.client)))
  delegate('clientRuleDelete', el => withSubmitLock(el, async () => {
    if (!confirm('この単価ルールを削除しますか？（登録済みのシフトの金額は変わりません）')) return
    try { await axios.delete('/api/admin/rate-rules/' + Number(el.dataset.id)); toast('削除しました'); renderClientRatePanel(Number(el.dataset.client)) } catch (e) { toast(errMsg(e)) }
  }))
  // 開催場所の編集（名前・住所・メモ・位置。#406）。名前を変えると、今日以降の枠・シフトの場所名も変わる（#142）
  let SITES = new Map()
  function openSiteEdit(id, cid) {
    const s = SITES.get(id); if (!s) return
    modal(`
      <h3 class="font-bold text-lg mb-3">開催場所を編集</h3>
      <div class="space-y-3">
        <label class="text-sm text-gray-600 block">開催場所名 *<input id="se-name" class="inp" maxlength="100" value="${esc(s.site_name)}"></label>
        <label class="text-sm text-gray-600 block">住所<input id="se-addr" class="inp" maxlength="200" value="${esc(s.address || '')}"></label>
        <label class="text-sm text-gray-600 block">位置（緯度, 経度）<input id="se-latlng" class="inp" placeholder="例: 35.681236, 139.767125" value="${s.lat != null && s.lng != null ? esc(s.lat + ', ' + s.lng) : ''}">
          <span class="block text-[11px] text-gray-400">地図アプリで場所を長押し（右クリック）すると表示される数値を貼り付けます。空欄にすると消します</span></label>
        <label class="text-sm text-gray-600 block">メモ<textarea id="se-memo" class="inp" rows="3" maxlength="500" placeholder="入口・搬入口・集合場所など">${esc(s.memo || '')}</textarea></label>
        <p class="text-[11px] text-gray-400">名前を変えると、今日以降の枠・シフト（実績が確定済みのものを除く）と繰り返し登録の場所名も新しい名前になります</p>
        <button class="btn btn-primary w-full" data-action="saveSite" data-id="${Number(id)}" data-cid="${esc(cid)}">保存する</button>
      </div>`)
  }
  async function saveSite(id, cid) {
    const name = document.getElementById('se-name').value.trim()
    if (!name) { toast('開催場所名を入力してください'); return }
    const ll = document.getElementById('se-latlng').value.trim()
    let lat = '', lng = ''
    if (ll) {
      const m = ll.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，、\s]\s*(-?\d+(?:\.\d+)?)\s*$/)
      if (!m) { toast('位置は「緯度, 経度」の形で入力してください（例: 35.681236, 139.767125）'); return }
      lat = Number(m[1]); lng = Number(m[2])
    }
    try {
      await axios.put('/api/admin/sites/' + id, { site_name: name, address: document.getElementById('se-addr').value, memo: document.getElementById('se-memo').value, lat, lng })
    } catch (e) { toast(errMsg(e)); return }
    invalidateMaster(); closeModal(); toast('保存しました'); renderClientSitesPanel(cid)
  }
  delegate('editSite', el => openSiteEdit(Number(el.dataset.id), Number(el.dataset.cid)))
  delegate('saveSite', el => withSubmitLock(el, () => saveSite(Number(el.dataset.id), Number(el.dataset.cid))))
  window.addSite = async function (cid) {
    const name = document.getElementById('site-new-name').value.trim()
    if (!name) { toast('開催場所名を入力してください'); return }
    try { await axios.post('/api/admin/sites', { client_id: cid, site_name: name, address: document.getElementById('site-new-addr').value }); invalidateMaster(); toast('追加しました'); renderClientSitesPanel(cid) } catch (e) { toast(errMsg(e)) }
  }
  delegate('addSite', el => withSubmitLock(el, () => addSite(Number(el.dataset.cid))))
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
