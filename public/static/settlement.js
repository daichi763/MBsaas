// =========================================================
// 精算（実績の確定 / 請求・支払の集計 / CSV出力）管理画面
// docs/spec_spot_shift.md 第3段階。admin.js の後に読み込む（#settlement）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const PAYEE_LABEL = { payroll: '自社給与', payroll_daily: '日雇い給与', freelance: '個人事業主', partner: '取引先', linked: '他社（連携元）' }
  const UNIT = { daily: '日', hourly: '時' }
  const S = window.__settleState = window.__settleState || {
    from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'),
    client_id: '', project_id: '', payee_type: '', settle: '', issues_only: false, tab: 'detail', selected: new Set(),
  }
  let master = null
  const hrs = (h) => (h == null ? '-' : (Math.round(h * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + 'h')
  const qs = () => new URLSearchParams(Object.fromEntries(Object.entries({
    from: S.from, to: S.to, client_id: S.client_id, project_id: S.project_id, payee_type: S.payee_type, settle: S.settle, issues_only: S.issues_only ? '1' : '',
  }).filter(([, v]) => v !== '' && v != null))).toString()
  const filterBody = () => ({ from: S.from, to: S.to, client_id: S.client_id || null, project_id: S.project_id || null, payee_type: S.payee_type || '', settle: S.settle || '' })

  window.renderSettlement = async function () {
    loading()
    if (!master) {
      const [cl, pj] = await Promise.all([axios.get('/api/admin/clients'), axios.get('/api/admin/projects')])
      master = { clients: cl.data.clients || [], projects: pj.data.projects || [] }
    }
    let data
    try { data = (await axios.get('/api/admin/settlement?' + qs())).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    window.__settleData = data
    S.selected = new Set([...S.selected].filter(id => data.rows.some(r => r.shift_id === id)))
    const t = data.totals
    const gross = t.bill - t.pay
    const projects = master.projects.filter(p => !S.client_id || String(p.client_id) === String(S.client_id))
    $app.innerHTML = `
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 class="text-xl font-bold text-gray-900"><i class="fas fa-scale-balanced text-blue-600 mr-1"></i>精算（実績の確定・請求・支払）</h2>
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-outline text-sm" onclick="settleSync()"><i class="fas fa-rotate"></i>入店・退店報告から実績を反映</button>
          <div class="relative" id="settle-export">
            <button class="btn btn-primary text-sm" onclick="document.getElementById('settle-export-menu').classList.toggle('hidden')"><i class="fas fa-file-csv"></i>CSV出力 <i class="fas fa-caret-down"></i></button>
            <div id="settle-export-menu" class="hidden absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 w-56 text-sm">
              <a class="block px-3 py-2 hover:bg-gray-50" href="/api/admin/settlement/export?kind=detail&${qs()}">シフト明細（1シフト1行）</a>
              <a class="block px-3 py-2 hover:bg-gray-50" href="/api/admin/settlement/export?kind=billing&${qs()}">請求集計（クライアント・案件別）</a>
              <a class="block px-3 py-2 hover:bg-gray-50" href="/api/admin/settlement/export?kind=payment&${qs()}">支払集計（支払先・スタッフ別）</a>
            </div>
          </div>
        </div>
      </div>

      <section class="card p-3 mb-4" id="settle-filters">
        <div class="flex flex-wrap items-end gap-2 text-xs">
          <label>期間<div class="flex items-center gap-1">
            <input type="date" id="st-from" class="inp w-auto text-sm" value="${S.from}"> 〜 <input type="date" id="st-to" class="inp w-auto text-sm" value="${S.to}"></div></label>
          <div class="flex gap-1 pb-0.5">
            <button class="btn btn-outline text-xs" onclick="settleMonth(-1)">前月</button>
            <button class="btn btn-outline text-xs" onclick="settleMonth(0)">今月</button>
            <button class="btn btn-outline text-xs" onclick="settleMonth(1)">翌月</button>
          </div>
          <label>クライアント<select id="st-client" class="inp w-auto text-sm" onchange="window.__settleState.project_id='';settleApply()">
            <option value="">すべて</option>${master.clients.map(c => `<option value="${c.client_id}" ${String(S.client_id) === String(c.client_id) ? 'selected' : ''}>${esc(c.client_name)}</option>`).join('')}</select></label>
          <label>案件<select id="st-project" class="inp w-auto text-sm" onchange="settleApply()">
            <option value="">すべて</option>${projects.map(p => `<option value="${p.project_id}" ${String(S.project_id) === String(p.project_id) ? 'selected' : ''}>${esc(p.project_name)}</option>`).join('')}</select></label>
          <label>支払区分<select id="st-payee" class="inp w-auto text-sm" onchange="settleApply()">
            <option value="">すべて</option>${Object.entries(PAYEE_LABEL).map(([k, l]) => `<option value="${k}" ${S.payee_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>確定<select id="st-settle" class="inp w-auto text-sm" onchange="settleApply()">
            ${[['', 'すべて'], ['planned', '未確定'], ['confirmed', '確定済み']].map(([k, l]) => `<option value="${k}" ${S.settle === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="flex items-center gap-1 pb-2"><input type="checkbox" id="st-issues" ${S.issues_only ? 'checked' : ''} onchange="settleApply()">確認が必要なもののみ</label>
          <button class="btn btn-primary text-xs" onclick="settleApply()"><i class="fas fa-magnifying-glass"></i>表示</button>
        </div>
      </section>

      <section class="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4" id="settle-totals">
        ${[['シフト', t.shifts + '件'], ['確定済み', `${t.confirmed} / ${t.shifts}`], ['請求合計', yen(t.bill)], ['支払合計', yen(t.pay) + (t.pay_unset ? `<span class="text-[10px] text-amber-600 block">単価未設定 ${t.pay_unset}件</span>` : '')],
          ['粗利', yen(gross) + `<span class="text-[10px] text-gray-400 block">${t.bill ? Math.round(gross / t.bill * 1000) / 10 + '%' : '-'}</span>`],
          ['確認が必要', `<span class="${t.issues ? 'text-red-600' : 'text-emerald-600'}">${t.issues}件</span>`]]
          .map(([l, v]) => `<div class="card p-3"><p class="text-[11px] text-gray-500">${l}</p><p class="text-lg font-bold">${v}</p></div>`).join('')}
      </section>

      <div class="flex gap-1 mb-2" id="settle-tabs">
        ${[['detail', 'シフト明細'], ['billing', '請求（クライアント別）'], ['payment', '支払（支払先別）']].map(([k, l]) =>
          `<button class="btn ${S.tab === k ? 'btn-primary' : 'btn-outline'} text-xs" onclick="window.__settleState.tab='${k}';renderSettlementBody()">${l}</button>`).join('')}
      </div>
      <section class="card p-3" id="settle-body"></section>
      ${data.truncated ? '<p class="text-xs text-amber-600 mt-2">件数が多いため先頭5000件のみ表示しています。期間を短くしてください</p>' : ''}`
    document.getElementById('st-from').addEventListener('change', settleApply)
    document.getElementById('st-to').addEventListener('change', settleApply)
    renderSettlementBody()
  }

  window.settleApply = function () {
    S.from = document.getElementById('st-from').value; S.to = document.getElementById('st-to').value
    S.client_id = document.getElementById('st-client').value; S.project_id = document.getElementById('st-project').value
    S.payee_type = document.getElementById('st-payee').value; S.settle = document.getElementById('st-settle').value
    S.issues_only = document.getElementById('st-issues').checked
    if (S.client_id && S.project_id && !master.projects.some(p => String(p.project_id) === S.project_id && String(p.client_id) === S.client_id)) S.project_id = ''
    renderSettlement()
  }
  window.settleMonth = function (d) {
    const base = d === 0 ? dayjs() : dayjs(S.from).add(d, 'month')
    S.from = base.startOf('month').format('YYYY-MM-DD'); S.to = base.endOf('month').format('YYYY-MM-DD')
    renderSettlement()
  }

  window.renderSettlementBody = function () {
    const data = window.__settleData; const host = document.getElementById('settle-body'); if (!host || !data) return
    document.querySelectorAll('#settle-tabs button').forEach((b, i) => { const k = ['detail', 'billing', 'payment'][i]; b.className = `btn ${S.tab === k ? 'btn-primary' : 'btn-outline'} text-xs` })
    if (S.tab === 'billing') {
      host.innerHTML = `<div class="overflow-x-auto"><table class="tbl" id="settle-billing-table"><thead><tr><th>クライアント</th><th>案件</th><th class="text-right">シフト</th><th class="text-right">人数</th><th class="text-right">時間</th>
        <th class="text-right">請求基本額</th><th class="text-right">交通費</th><th class="text-right">調整</th><th class="text-right">請求合計</th><th class="text-right">支払合計</th><th class="text-right">粗利</th><th>確定</th></tr></thead><tbody>
        ${data.by_client.map(g => `<tr><td>${esc(g.client_name || '-')}</td><td class="font-medium">${esc(g.project_name)}</td><td class="text-right">${g.shifts}</td><td class="text-right">${g.staff}</td><td class="text-right">${hrs(g.hours)}</td>
          <td class="text-right">${yen(g.bill_base)}</td><td class="text-right">${yen(g.bill_transport)}</td><td class="text-right">${g.bill_adjust ? yen(g.bill_adjust) : '-'}</td><td class="text-right font-bold">${yen(g.bill_total)}</td>
          <td class="text-right">${yen(g.pay_total)}</td><td class="text-right">${yen(g.bill_total - g.pay_total)}</td>
          <td>${g.confirmed === g.shifts ? '<span class="badge badge-green">確定</span>' : `<span class="badge badge-gray">${g.confirmed}/${g.shifts}</span>`}</td></tr>`).join('') || '<tr><td colspan="12" class="text-center text-gray-400">対象のシフトはありません</td></tr>'}
        </tbody></table></div>`
      return
    }
    if (S.tab === 'payment') {
      host.innerHTML = `<div class="overflow-x-auto"><table class="tbl" id="settle-payment-table"><thead><tr><th>支払区分</th><th>支払先</th><th>スタッフ</th><th>社員番号</th><th class="text-right">日数</th><th class="text-right">シフト</th><th class="text-right">時間</th>
        <th class="text-right">支払基本額</th><th class="text-right">交通費</th><th class="text-right">調整</th><th class="text-right">支払合計</th><th>確定</th></tr></thead><tbody>
        ${data.by_payee.map(g => `<tr><td><span class="badge badge-gray">${esc(g.payee_label)}</span></td><td class="font-medium">${esc(g.payee_name)}</td>
          <td class="text-xs">${g.staff_id ? `<a class="text-blue-600 hover:underline" href="#staff/${g.staff_id}">${esc(g.staff_name)}</a>` : esc(g.staff_name)}</td><td class="text-xs">${esc(g.employee_number || '')}</td>
          <td class="text-right">${g.days}</td><td class="text-right">${g.shifts}</td><td class="text-right">${hrs(g.hours)}</td>
          <td class="text-right">${yen(g.pay_base)}</td><td class="text-right">${yen(g.pay_transport)}</td><td class="text-right">${g.pay_adjust ? yen(g.pay_adjust) : '-'}</td>
          <td class="text-right font-bold">${yen(g.pay_total)}${g.pay_unset ? `<span class="block text-[10px] text-amber-600">単価未設定 ${g.pay_unset}件</span>` : ''}</td>
          <td>${g.confirmed === g.shifts ? '<span class="badge badge-green">確定</span>' : `<span class="badge badge-gray">${g.confirmed}/${g.shifts}</span>`}</td></tr>`).join('') || '<tr><td colspan="12" class="text-center text-gray-400">対象のシフトはありません</td></tr>'}
        </tbody></table></div>
        <p class="text-[11px] text-gray-400 mt-2">自社給与・日雇い給与はスタッフごと、取引先・他社はその会社ごとにまとめています。給与ソフトへの取り込みは「支払集計」のCSVを使ってください</p>`
      return
    }
    const sel = S.selected
    const allIds = data.rows.map(r => r.shift_id)
    host.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2 text-xs">
        <p class="text-gray-500">${data.rows.length}件${sel.size ? `・<b>${sel.size}件を選択中</b>` : ''}</p>
        <div class="flex gap-1.5">
          <button class="btn btn-primary text-xs" onclick="settleConfirm(true)"><i class="fas fa-check-double"></i>${sel.size ? '選択したシフトを確定' : '表示中のシフトをすべて確定'}</button>
          <button class="btn btn-outline text-xs" onclick="settleConfirm(false)"><i class="fas fa-rotate-left"></i>${sel.size ? '選択の確定を取り消す' : '表示中の確定を取り消す'}</button>
        </div>
      </div>
      <div class="overflow-x-auto"><table class="tbl text-xs" id="settle-detail-table"><thead><tr>
        <th><input type="checkbox" ${allIds.length && allIds.every(id => sel.has(id)) ? 'checked' : ''} onchange="settleSelectAll(this.checked)"></th>
        <th>日付</th><th>案件 / 場所</th><th>スタッフ</th><th>予定</th><th>実績</th><th class="text-right">計算時間</th>
        <th class="text-right">請求</th><th class="text-right">支払</th><th>支払先</th><th>確認</th><th>確定</th><th></th></tr></thead><tbody>
        ${data.rows.map(r => `<tr class="${r.settle_status === 'confirmed' ? 'bg-emerald-50/40' : ''}" data-shift-id="${r.shift_id}">
          <td><input type="checkbox" ${sel.has(r.shift_id) ? 'checked' : ''} onchange="settleSelect(${r.shift_id}, this.checked)"></td>
          <td class="whitespace-nowrap">${dayjs(r.work_date).format('M/D(dd)')}</td>
          <td class="min-w-[220px]"><p class="font-medium">${esc(r.project_name)}</p><p class="text-gray-400">${esc(r.client_name)}${r.site_name ? '・' + esc(r.site_name) : ''}${r.role ? '・' + esc(r.role) : ''}</p></td>
          <td class="whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#staff/${r.staff_id}">${esc(r.staff_name)}</a></td>
          <td class="whitespace-nowrap">${r.start_time}〜${r.end_time}<span class="text-gray-400 block">休憩${r.break_minutes}分・${hrs(r.planned_hours)}</span></td>
          <td class="whitespace-nowrap">${r.actual_start ? `${r.actual_start}〜${r.actual_end}<span class="text-gray-400 block">${r.actual_source === 'manual' ? '手入力' : '報告'}・${hrs(r.actual_hours)}</span>` : '<span class="text-gray-400">-</span>'}</td>
          <td class="text-right whitespace-nowrap">${r.bill_unit_type === 'hourly' || r.pay_unit_type === 'hourly' ? hrs(r.hours) : '<span class="text-gray-400">日額</span>'}</td>
          <td class="text-right whitespace-nowrap">${yen(r.bill_total)}<span class="text-gray-400 block">${r.bill_rate != null ? yen(r.bill_rate) + '/' + UNIT[r.bill_unit_type] : ''}</span></td>
          <td class="text-right whitespace-nowrap">${r.pay_total == null ? '<span class="text-amber-600">未設定</span>' : yen(r.pay_total)}<span class="text-gray-400 block">${r.pay_rate != null ? yen(r.pay_rate) + '/' + UNIT[r.pay_unit_type] : ''}</span></td>
          <td class="whitespace-nowrap">${esc(PAYEE_LABEL[r.payee_type] || r.payee_type)}${r.payee_type === 'partner' || r.payee_type === 'linked' ? `<span class="text-gray-400 block">${esc(r.payee_name)}</span>` : ''}</td>
          <td>${r.issues.map(i => `<span class="badge badge-red block mb-0.5 whitespace-nowrap">${esc(i)}</span>`).join('') || '<i class="fas fa-check text-emerald-500"></i>'}</td>
          <td class="whitespace-nowrap">${r.settle_status === 'confirmed' ? '<span class="badge badge-green">確定</span>' : '<span class="badge badge-gray">未確定</span>'}</td>
          <td><button class="text-blue-600 hover:underline whitespace-nowrap" onclick="openSettleEdit(${r.shift_id})">${r.settle_status === 'confirmed' ? '詳細' : '実績・金額'}</button></td>
        </tr>`).join('') || '<tr><td colspan="13" class="text-center text-gray-400">対象のシフトはありません（確定・代打のシフトが対象です）</td></tr>'}
      </tbody></table></div>`
  }
  window.settleSelect = function (id, on) { on ? S.selected.add(id) : S.selected.delete(id); renderSettlementBody() }
  window.settleSelectAll = function (on) { const ids = window.__settleData.rows.map(r => r.shift_id); S.selected = on ? new Set(ids) : new Set(); renderSettlementBody() }

  window.settleSync = async function () {
    try {
      const { data } = await axios.post('/api/admin/settlement/sync-actuals', filterBody())
      toast(`入店・退店報告を確認しました（${data.checked}件中 ${data.updated}件を更新）`); renderSettlement()
    } catch (e) { toast(errMsg(e)) }
  }

  window.settleConfirm = async function (confirm) {
    const body = S.selected.size ? { shift_ids: [...S.selected] } : filterBody()
    if (!confirm) {
      if (!window.confirm(`${S.selected.size ? '選択した' : '表示中の'}シフトの確定を取り消します。よろしいですか？`)) return
      try { const { data } = await axios.post('/api/admin/settlement/unconfirm', body); toast(`${data.unconfirmed}件の確定を取り消しました`); S.selected.clear(); renderSettlement() } catch (e) { toast(errMsg(e)) }
      return
    }
    let pre
    try { pre = (await axios.post('/api/admin/settlement/confirm', { ...body, dry_run: true })).data } catch (e) { return toast(errMsg(e)) }
    modal(`
      <h3 class="font-bold text-lg mb-2"><i class="fas fa-check-double text-blue-600 mr-1"></i>実績を確定する</h3>
      <div class="text-sm space-y-1 mb-3" id="settle-confirm-summary">
        <p>確定するシフト: <b>${pre.count}件</b>（請求 ${yen(pre.bill)} / 支払 ${yen(pre.pay)}）</p>
        ${pre.with_issues ? `<p class="text-red-600"><i class="fas fa-triangle-exclamation mr-1"></i>確認が必要なシフトが ${pre.with_issues}件 含まれています</p>` : ''}
        ${pre.pay_unset ? `<p class="text-amber-600">支払単価が未設定のシフトが ${pre.pay_unset}件 あります（支払0円として集計されます）</p>` : ''}
        ${pre.future ? `<p class="text-gray-500">今日より後のシフト ${pre.future}件 は確定しません</p>` : ''}
        ${pre.already ? `<p class="text-gray-500">確定済みの ${pre.already}件 はそのままです</p>` : ''}
      </div>
      <p class="text-xs text-gray-500 mb-3">確定したシフトは、時間・スタッフ・金額を変更できなくなります（シフトボードや単価ルールの再適用、区分変更の対象外になります）。取り消せば再び変更できます</p>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-primary flex-1" ${pre.count ? '' : 'disabled'} onclick="settleConfirmRun(${pre.with_issues ? 'true' : 'false'})">${pre.with_issues ? '確認済みとして確定する' : '確定する'}</button>
      </div>`)
    window.__settleConfirmBody = body
  }
  window.settleConfirmRun = async function (force) {
    try {
      const { data } = await axios.post('/api/admin/settlement/confirm', { ...window.__settleConfirmBody, force })
      closeModal(); toast(`${data.confirmed}件を確定しました`); S.selected.clear(); renderSettlement()
    } catch (e) { toast(errMsg(e)) }
  }

  // ---------- 実績・金額の編集 ----------
  window.openSettleEdit = function (id) {
    const r = window.__settleData.rows.find(x => x.shift_id === id); if (!r) return
    const locked = r.settle_status === 'confirmed'
    const dis = locked ? 'disabled' : ''
    modal(`
      <h3 class="font-bold text-lg mb-1">${esc(r.staff_name)}・${dayjs(r.work_date).format('M/D(dd)')}</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(r.client_name)} ${esc(r.project_name)}${r.site_name ? '・' + esc(r.site_name) : ''}${r.role ? '・' + esc(r.role) : ''}</p>
      ${locked ? `<div class="p-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs mb-3" id="settle-locked-notice"><i class="fas fa-lock mr-1"></i>確定済み（${esc(r.settled_at || '')}）。変更するには確定を取り消してください</div>` : ''}
      <section class="rounded-lg border border-gray-100 p-3 mb-3 text-sm" id="settle-actual-form">
        <p class="font-bold text-gray-700 text-xs mb-2"><i class="fas fa-clock mr-1"></i>実績（予定 ${r.start_time}〜${r.end_time}・休憩${r.break_minutes}分）</p>
        <div class="grid grid-cols-3 gap-2 text-xs">
          <label>開始<input type="time" id="se-start" class="inp text-sm" value="${r.actual_start || ''}" ${dis}></label>
          <label>終了<input type="time" id="se-end" class="inp text-sm" value="${r.actual_end || ''}" ${dis}></label>
          <label>休憩（分）<input type="number" id="se-break" class="inp text-sm" value="${r.actual_break_minutes ?? ''}" placeholder="${r.break_minutes}" ${dis}></label>
          <label class="col-span-3">メモ<input id="se-note" class="inp text-sm" value="${esc(r.actual_note || '')}" placeholder="例: 30分残業（店長了承）" ${dis}></label>
        </div>
        <p class="text-[11px] text-gray-400 mt-1">${r.actual_source === 'manual' ? '手入力の実績です（入店・退店報告では上書きしません）' : r.actual_source === 'report' ? '入店・退店報告から反映した実績です' : '実績はまだありません'}。
          実働 ${hrs(r.actual_hours)}・計算に使う時間 ${hrs(r.hours)}</p>
        ${locked ? '' : `<div class="flex gap-2 mt-2">
          <button class="btn btn-primary text-xs flex-1" onclick="saveSettleActual(${r.shift_id})">実績を保存して再計算</button>
          ${r.actual_source === 'manual' ? `<button class="btn btn-outline text-xs" onclick="resetSettleActual(${r.shift_id})">報告の時刻に戻す</button>` : ''}</div>`}
      </section>
      <section class="rounded-lg border border-gray-100 p-3 mb-3 text-xs" id="settle-money-box">
        <div class="grid grid-cols-2 gap-3">
          <div><p class="font-bold text-gray-700 mb-1">請求</p>
            <p>基本 ${yen(r.bill_base)}（${r.bill_rate != null ? yen(r.bill_rate) : '-'} × ${r.bill_qty ?? '-'}${UNIT[r.bill_unit_type]}）</p>
            <p>交通費 ${yen(r.bill_transport)}${r.bill_adjust ? `・調整 ${yen(r.bill_adjust)}` : ''}</p><p class="font-bold">合計 ${yen(r.bill_total)}</p></div>
          <div><p class="font-bold text-gray-700 mb-1">支払（${esc(PAYEE_LABEL[r.payee_type] || r.payee_type)}${r.payee_type === 'partner' || r.payee_type === 'linked' ? '・' + esc(r.payee_name) : ''}）</p>
            <p>基本 ${r.pay_base == null ? '未設定' : yen(r.pay_base)}（${r.pay_rate != null ? yen(r.pay_rate) : '-'} × ${r.pay_qty ?? '-'}${UNIT[r.pay_unit_type]}）</p>
            <p>交通費 ${yen(r.pay_transport)}（実費 ${yen(r.transportation_fee)}）${r.pay_adjust ? `・調整 ${yen(r.pay_adjust)}` : ''}</p><p class="font-bold">合計 ${r.pay_total == null ? '-' : yen(r.pay_total)}</p></div>
        </div>
        ${r.adjust_note ? `<p class="text-gray-500 mt-1">調整メモ: ${esc(r.adjust_note)}</p>` : ''}
        ${r.price_locked ? '<p class="text-amber-600 mt-1">手動で金額を変更したシフトです（単価はそのまま、時給の数量だけ実働に合わせます）</p>' : ''}
        ${locked ? '' : `<button class="btn btn-outline text-xs w-full mt-2" onclick="closeModal();openShiftPriceFromSettle(${r.shift_id})"><i class="fas fa-pen"></i>単価・交通費・調整を変更</button>`}
      </section>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">閉じる</button>
        ${locked ? `<button class="btn btn-outline flex-1" onclick="settleToggleOne(${r.shift_id}, false)"><i class="fas fa-rotate-left"></i>確定を取り消す</button>`
        : `<button class="btn btn-primary flex-1" onclick="settleToggleOne(${r.shift_id}, true)"><i class="fas fa-check"></i>このシフトを確定</button>`}
      </div>`)
  }
  window.saveSettleActual = async function (id) {
    const v = (k) => document.getElementById(k).value
    try {
      await axios.put(`/api/admin/shifts/${id}/actual`, { actual_start: v('se-start'), actual_end: v('se-end'), actual_break_minutes: v('se-break'), actual_note: v('se-note') })
      toast('実績を保存しました'); await renderSettlement(); openSettleEdit(id)
    } catch (e) { toast(errMsg(e)) }
  }
  window.resetSettleActual = async function (id) {
    try { await axios.put(`/api/admin/shifts/${id}/actual`, { reset: true }); toast('報告の時刻に戻しました'); await renderSettlement(); openSettleEdit(id) } catch (e) { toast(errMsg(e)) }
  }
  window.settleToggleOne = async function (id, confirm) {
    try {
      if (confirm) {
        const r = window.__settleData.rows.find(x => x.shift_id === id)
        if (r && r.issues.length && !window.confirm(`確認事項があります（${r.issues.join('、')}）。確定しますか？`)) return
        const { data } = await axios.post('/api/admin/settlement/confirm', { shift_ids: [id], force: true })
        if (!data.confirmed) return toast(data.skipped_future ? '今日より後のシフトは確定できません' : '確定できませんでした')
        toast('確定しました')
      } else { await axios.post('/api/admin/settlement/unconfirm', { shift_ids: [id] }); toast('確定を取り消しました') }
      closeModal(); renderSettlement()
    } catch (e) { toast(errMsg(e)) }
  }
  // 単価・交通費・調整の手動変更（このシフトだけ。PUT /api/admin/shifts/:id/price）
  const UNIT_LABEL = { daily: '日額', hourly: '時給' }
  const BT_LABEL = { actual: '実費', fixed: '定額', included: '単価に込み' }
  const PT_LABEL = { actual: '実費', capped: '実費（上限あり）', fixed: '定額', none: '支払なし' }
  const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')
  window.openShiftPriceFromSettle = function (id) {
    const r = window.__settleData.rows.find(x => x.shift_id === id); if (!r) return
    modal(`
      <h3 class="font-bold text-lg mb-1">金額の変更</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(r.staff_name)}・${dayjs(r.work_date).format('M/D(dd)')}・${esc(r.project_name)}。時給の数量を空欄にすると計算時間（${hrs(r.hours)}）を使います</p>
      <div class="grid grid-cols-3 gap-2 text-xs" id="settle-price-form">
        <label>請求<select id="spx-bill-unit" class="inp text-xs">${opt(UNIT_LABEL, r.bill_unit_type)}</select></label>
        <label>請求単価<input id="spx-bill-rate" type="number" class="inp text-xs" value="${r.bill_rate ?? ''}"></label>
        <label>数量<input id="spx-bill-qty" type="number" step="0.25" class="inp text-xs" value="" placeholder="${r.bill_qty ?? ''}"></label>
        <label>支払<select id="spx-pay-unit" class="inp text-xs">${opt(UNIT_LABEL, r.pay_unit_type)}</select></label>
        <label>支払単価<input id="spx-pay-rate" type="number" class="inp text-xs" value="${r.pay_rate ?? ''}" placeholder="未設定"></label>
        <label>数量<input id="spx-pay-qty" type="number" step="0.25" class="inp text-xs" value="" placeholder="${r.pay_qty ?? ''}"></label>
        <label>交通費の実費<input id="spx-fee" type="number" class="inp text-xs" value="${r.transportation_fee}"></label>
        <label>交通費の請求<select id="spx-bt" class="inp text-xs">${opt(BT_LABEL, r.bill_transport_type)}</select></label>
        <label>請求額（定額時）<input id="spx-bt-amt" type="number" class="inp text-xs" value="${r.bill_transport_amount}"></label>
        <label class="col-start-2">交通費の支払<select id="spx-pt" class="inp text-xs">${opt(PT_LABEL, r.pay_transport_type)}</select></label>
        <label>上限/定額<input id="spx-pt-amt" type="number" class="inp text-xs" value="${r.pay_transport_amount}"></label>
        <label>請求の調整<input id="spx-bill-adj" type="number" class="inp text-xs" value="${r.bill_adjust}"></label>
        <label>支払の調整<input id="spx-pay-adj" type="number" class="inp text-xs" value="${r.pay_adjust}"></label>
        <label>調整の内容<input id="spx-adj-note" class="inp text-xs" value="${esc(r.adjust_note)}" placeholder="残業・手当など"></label>
      </div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-outline flex-1" onclick="openSettleEdit(${id})">戻る</button>
        ${r.price_locked ? `<button class="btn btn-outline flex-1" onclick="settleResetPrice(${id})">単価ルールに戻す</button>` : ''}
        <button class="btn btn-primary flex-1" onclick="settleSavePrice(${id})">保存（このシフトだけ）</button>
      </div>`)
  }
  window.settleSavePrice = async function (id) {
    const v = (k) => document.getElementById(k).value
    try {
      await axios.put(`/api/admin/shifts/${id}/price`, {
        bill_unit_type: v('spx-bill-unit'), bill_rate: v('spx-bill-rate'), bill_qty: v('spx-bill-qty'),
        pay_unit_type: v('spx-pay-unit'), pay_rate: v('spx-pay-rate'), pay_qty: v('spx-pay-qty'),
        transportation_fee: v('spx-fee'), bill_transport_type: v('spx-bt'), bill_transport_amount: v('spx-bt-amt'),
        pay_transport_type: v('spx-pt'), pay_transport_amount: v('spx-pt-amt'),
        bill_adjust: v('spx-bill-adj'), pay_adjust: v('spx-pay-adj'), adjust_note: v('spx-adj-note'),
      })
      toast('金額を保存しました'); await renderSettlement(); openSettleEdit(id)
    } catch (e) { toast(errMsg(e)) }
  }
  window.settleResetPrice = async function (id) {
    try { await axios.put(`/api/admin/shifts/${id}/price`, { reset: true }); toast('単価ルールに戻しました'); await renderSettlement(); openSettleEdit(id) } catch (e) { toast(errMsg(e)) }
  }
})()
