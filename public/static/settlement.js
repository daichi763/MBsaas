// =========================================================
// 精算（実績の確定 / 請求・支払の集計 / CSV出力）管理画面
// docs/spec_spot_shift.md 第3段階。admin.js の後に読み込む（#settlement）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const PAYEE_LABEL = { payroll: '自社給与', payroll_daily: '日雇い給与', freelance: '個人事業主', partner: '取引先', linked: '他社（連携元）' }
  const UNIT = { daily: '日', hourly: '時' }
  // src/settlement.ts の確認事項と同じ文言
  const PENDING_ISSUE = '承認待ちの打刻修正あり'
  const PAY_REQUEST_ISSUE = '承認待ちの交通費・延長の申請あり'
  // 承認・却下で片づける確認事項（確認済みにはできない）
  const ackable = (i) => i !== PENDING_ISSUE && i !== PAY_REQUEST_ISSUE
  const RECALC_ISSUE = '数量・金額が今の計算と違う'
  const PAYEE_EXCLUDED_ISSUE = '区分変更の対象外（支払先が変更前のまま）'
  // 欠勤・中止の理由（src/settlement.ts の CANCEL_REASON_LABEL と同じ）
  const CANCEL_REASON_LABEL = { staff: 'スタッフ都合の欠勤', client: 'クライアント都合の中止' }
  const S = window.__settleState = window.__settleState || {
    from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'),
    client_id: '', project_id: '', staff_id: '', payee_type: '', settle: '', issues_only: false, tab: 'detail', selected: new Set(),
  }
  if (S.staff_id == null) S.staff_id = ''
  // クライアント・案件の選択肢（GET /settlement/options）。画面を開くたびに取り直す（#494）
  let master = null
  // 範囲選択（Shift キー）の起点にする、最後にチェックを変えた行
  let lastPicked = null
  const hrs = (h) => (h == null ? '-' : (Math.round(h * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + 'h')
  const qs = () => new URLSearchParams(Object.fromEntries(Object.entries({
    from: S.from, to: S.to, client_id: S.client_id, project_id: S.project_id, staff_id: S.staff_id, payee_type: S.payee_type, settle: S.settle, issues_only: S.issues_only ? '1' : '',
  }).filter(([, v]) => v !== '' && v != null))).toString()
  const filterBody = () => ({ from: S.from, to: S.to, client_id: S.client_id || null, project_id: S.project_id || null, staff_id: S.staff_id || null, payee_type: S.payee_type || '', settle: S.settle || '' })
  const period = () => `from=${encodeURIComponent(S.from)}&to=${encodeURIComponent(S.to)}`
  const staffLabel = (o) => `${o.staff_name}${o.employee_number ? `（${o.employee_number}）` : `（ID ${o.staff_id}）`}`
  // 選んだスタッフが今の期間の候補にいないとき（期間を変えたとき）の表示
  const missingStaffLabel = () => `（スタッフID ${S.staff_id}）`
  // 操作の後の読み直し（選択肢は取り直さない）
  const reload = () => window.renderSettlement({ keepMaster: true })

  async function loadMaster() {
    const { data } = await axios.get('/api/admin/settlement/options')
    master = { clients: data.clients || [], projects: data.projects || [] }
  }
  const failHtml = (msg) => `<div class="card p-6 text-center" id="settle-load-error"><p class="text-red-600 mb-3"><i class="fas fa-triangle-exclamation mr-1"></i>${esc(msg)}</p>
    <button class="btn btn-primary text-sm" data-action="settleRetry"><i class="fas fa-rotate"></i>再読み込み</button></div>`
  delegate('settleRetry', () => window.renderSettlement())

  window.renderSettlement = async function (opts) {
    loading()
    // 一覧の取得に失敗しても、読み込み中のまま止めずに理由と再試行を出す（#494）
    try { if (!master || !(opts && opts.keepMaster)) await loadMaster() } catch (e) { $app.innerHTML = failHtml(errMsg(e, 'クライアント・案件の一覧を読み込めませんでした')); return }
    let data
    try { data = (await axios.get('/api/admin/settlement?' + qs())).data } catch (e) { $app.innerHTML = failHtml(errMsg(e, '精算の一覧を読み込めませんでした')); return }
    window.__settleData = data
    S.selected = new Set([...S.selected].filter(id => data.rows.some(r => r.shift_id === id)))
    lastPicked = null
    const t = data.totals
    // 粗利は支払が決まっているシフトだけで計算する（サーバーの profit / profit_bill）。支払単価が未設定のシフトの請求額は除く
    const gross = t.profit
    const projects = master.projects.filter(p => !S.client_id || String(p.client_id) === String(S.client_id))
    const client = selectedClient()
    const staffSel = (data.staff_options || []).find(o => String(o.staff_id) === String(S.staff_id))
    $app.innerHTML = `
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 class="text-xl font-bold text-gray-900"><i class="fas fa-scale-balanced text-blue-600 mr-1"></i>精算（実績の確定・請求・支払）</h2>
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-outline text-sm" data-action="settleSync"><i class="fas fa-rotate"></i>入店・退店報告から実績を反映</button>
          <button class="btn btn-outline text-sm" data-action="settleClosings" id="settle-closings-btn"><i class="fas fa-lock"></i>締め・出力の記録</button>
          <div class="relative" id="settle-export">
            <button class="btn btn-primary text-sm" data-action="settleExportMenu"><i class="fas fa-file-csv"></i>CSV出力 <i class="fas fa-caret-down"></i></button>
            <div id="settle-export-menu" class="hidden absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 w-64 text-sm">
              ${data.truncated ? `<p class="px-3 py-2 text-xs text-amber-700">${data.max_rows}件を超えるため出力できません。期間や条件を絞ってください</p>` : `
              <a class="block px-3 py-2 hover:bg-gray-50" href="/api/admin/settlement/export?kind=detail&${qs()}">シフト明細（1シフト1行）${S.issues_only ? '<span class="block text-[11px] text-gray-400">確認が必要なもののみ</span>' : ''}</a>
              <a class="block px-3 py-2 hover:bg-gray-50" href="/api/admin/settlement/export?kind=billing&${qs()}">請求集計（クライアント・案件別）</a>
              <a class="block px-3 py-2 hover:bg-gray-50" href="/api/admin/settlement/export?kind=payment&${qs()}">支払集計（支払先・スタッフ別）</a>
              <p class="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-100" id="settle-export-note">UTF-8（BOM付き）の CSV です。Excel でそのまま開けます。社員番号は先頭の0が消えないよう ="000123" の形の文字として出力しています（給与ソフトに取り込むときは、文字として読み込んでください）。支払先・クライアントあての明細書は「請求」「支払」のタブから出せます</p>`}
            </div>
          </div>
        </div>
      </div>

      <section class="card p-3 mb-4" id="settle-filters">
        <div class="flex flex-wrap items-end gap-2 text-xs">
          <label>期間<div class="flex items-center gap-1">
            <input type="date" id="st-from" class="inp w-auto text-sm" value="${esc(S.from)}"> 〜 <input type="date" id="st-to" class="inp w-auto text-sm" value="${esc(S.to)}"></div></label>
          <div class="flex gap-1 pb-0.5">
            <button class="btn btn-outline text-xs" data-action="settleMonth" data-d="-1">前月</button>
            <button class="btn btn-outline text-xs" data-action="settleMonth" data-d="0">今月</button>
            <button class="btn btn-outline text-xs" data-action="settleMonth" data-d="1">翌月</button>
          </div>
          <label>クライアント<select id="st-client" class="inp w-auto text-sm">
            <option value="">すべて</option>${master.clients.map(c => `<option value="${esc(c.client_id)}" ${String(S.client_id) === String(c.client_id) ? 'selected' : ''}>${esc(c.client_name)}</option>`).join('')}</select></label>
          <label>案件<select id="st-project" class="inp w-auto text-sm">
            <option value="">すべて</option>${projects.map(p => `<option value="${esc(p.project_id)}" ${String(S.project_id) === String(p.project_id) ? 'selected' : ''}>${esc(p.project_name)}${p.status && p.status !== 'active' ? '（終了）' : ''}</option>`).join('')}</select></label>
          <label>スタッフ<input id="st-staff" class="inp w-auto text-sm" list="st-staff-list" placeholder="名前で検索（空欄ですべて）" value="${esc(staffSel ? staffLabel(staffSel) : S.staff_id ? missingStaffLabel() : '')}" autocomplete="off">
            <datalist id="st-staff-list">${(data.staff_options || []).map(o => `<option value="${esc(staffLabel(o))}"></option>`).join('')}</datalist></label>
          <label>支払区分<select id="st-payee" class="inp w-auto text-sm">
            <option value="">すべて</option>${Object.entries(PAYEE_LABEL).map(([k, l]) => `<option value="${k}" ${S.payee_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>確定<select id="st-settle" class="inp w-auto text-sm">
            ${[['', 'すべて'], ['planned', '未確定'], ['confirmed', '確定済み']].map(([k, l]) => `<option value="${k}" ${S.settle === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="flex items-center gap-1 pb-2"><input type="checkbox" id="st-issues" ${S.issues_only ? 'checked' : ''}>確認が必要なもののみ</label>
          <button class="btn btn-primary text-xs" data-action="settleApply"><i class="fas fa-magnifying-glass"></i>表示</button>
        </div>
        ${client ? `<p class="text-[11px] text-gray-500 mt-2" id="settle-closing-day">${esc(client.client_name)} の締め日: <b>${client.billing_closing_day ? (client.billing_closing_day >= 31 ? '月末' : client.billing_closing_day + '日') : '未設定（暦月）'}</b>
          ${client.billing_closing_day ? '（前月・今月・翌月のボタンは、この締め日で期間を設定します）' : ''}${client.billing_rule ? `・請求条件: ${esc(client.billing_rule)}` : ''}
          <button type="button" class="text-blue-600 hover:underline ml-1" data-action="settleClosingDay" data-id="${esc(client.client_id)}">締め日を設定</button></p>` : ''}
      </section>
      ${closingBannerHtml(data.closings || [])}
      <div id="settle-payreq"></div>

      <section class="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4" id="settle-totals">
        ${[['シフト', t.shifts + '件' + (t.cancel_shifts ? `<span class="text-[10px] text-gray-400 block">うち欠勤・中止 ${t.cancel_shifts}件</span>` : '')], ['確定済み', `${t.confirmed} / ${t.shifts}`],
          ['請求合計', yen(t.bill) + (t.cancel_bill ? `<span class="text-[10px] text-gray-400 block">うちキャンセル料 ${yen(t.cancel_bill)}</span>` : '')],
          ['支払合計', yen(t.pay) + (t.cancel_pay ? `<span class="text-[10px] text-gray-400 block">うち補償・控除 ${yen(t.cancel_pay)}</span>` : '') + (t.pay_unset ? `<span class="text-[10px] text-amber-600 block">単価未設定 ${t.pay_unset}件</span>` : '')],
          ['粗利', (gross == null ? '-' : yen(gross)) + `<span class="text-[10px] text-gray-400 block">${t.profit_bill && gross != null ? Math.round(gross / t.profit_bill * 1000) / 10 + '%' : '-'}</span>`
            + (t.pay_unset ? `<span class="text-[10px] text-amber-600 block">支払未設定 ${t.pay_unset}件・請求 ${yen(t.pay_unset_bill)} を除外</span>` : '')],
          ['確認が必要（未確定）', `<span class="${t.issues ? 'text-red-600' : 'text-emerald-600'}">${t.issues}件</span>`
            + (t.settled_issues ? `<span class="text-[10px] text-red-600 block" id="settle-settled-issues">確定後の要対応 ${t.settled_issues}件</span>` : '')]]
          .map(([l, v]) => `<div class="card p-3"><p class="text-[11px] text-gray-500">${l}</p><p class="text-lg font-bold">${v}</p></div>`).join('')}
      </section>

      <div class="flex gap-1 mb-2" id="settle-tabs">
        ${[['detail', 'シフト明細'], ['billing', '請求（クライアント別）'], ['payment', '支払（支払先別）']].map(([k, l]) =>
          `<button class="btn ${S.tab === k ? 'btn-primary' : 'btn-outline'} text-xs" data-action="settleTab" data-tab="${k}">${l}</button>`).join('')}
      </div>
      ${tentativeHtml(data.tentative_reported || [])}
      ${absentHtml(data.absent_shifts || [])}
      <section class="card p-3" id="settle-body"></section>
      ${data.truncated ? `<p class="text-xs text-amber-600 mt-2" id="settle-truncated">対象が${data.max_rows}件を超えるため、先頭の${data.max_rows}件だけを表示しています（集計もこの件数分です）。CSV出力と正しい集計には、期間や条件を絞ってください</p>` : ''}`
    document.getElementById('st-from').addEventListener('change', settleApply)
    document.getElementById('st-to').addEventListener('change', settleApply)
    document.getElementById('st-client').addEventListener('change', () => { S.project_id = ''; document.getElementById('st-project').value = ''; settleApply() })
    for (const id of ['st-project', 'st-payee', 'st-settle', 'st-issues']) document.getElementById(id).addEventListener('change', settleApply)
    document.getElementById('st-staff').addEventListener('change', settleApply)
    renderSettlementBody()
    loadPayRequests()
  }

  const selectedClient = () => (S.client_id && master ? master.clients.find(c => String(c.client_id) === String(S.client_id)) : null)
  // スタッフの入力欄の文字から staff_id を決める。候補にない文字なら null（空欄は ''）
  function staffIdFromInput() {
    const v = (document.getElementById('st-staff').value || '').trim()
    if (!v) return ''
    if (S.staff_id && v === missingStaffLabel()) return String(S.staff_id)
    const o = ((window.__settleData && window.__settleData.staff_options) || []).find(x => staffLabel(x) === v)
    return o ? String(o.staff_id) : null
  }
  window.settleApply = function () {
    const staffId = staffIdFromInput()
    if (staffId === null) return toast('スタッフは候補から選んでください（期間内に精算の対象のシフトがある人が出ます）')
    S.from = document.getElementById('st-from').value; S.to = document.getElementById('st-to').value
    S.client_id = document.getElementById('st-client').value; S.project_id = document.getElementById('st-project').value
    S.staff_id = staffId
    S.payee_type = document.getElementById('st-payee').value; S.settle = document.getElementById('st-settle').value
    S.issues_only = document.getElementById('st-issues').checked
    if (S.client_id && S.project_id && !master.projects.some(p => String(p.project_id) === S.project_id && String(p.client_id) === S.client_id)) S.project_id = ''
    reload()
  }
  delegate('settleApply', () => settleApply())
  delegate('settleTab', el => { S.tab = el.dataset.tab; renderSettlementBody() })
  delegate('settleExportMenu', () => document.getElementById('settle-export-menu').classList.toggle('hidden'))

  // ---------- 期間（暦月、またはクライアントの締め日。#168） ----------
  // 締め日 day（31 = 月末）の、month（dayjs の月初）の締めの日
  const closingDate = (month, day) => month.date(Math.min(day, month.daysInMonth()))
  // 締め日で区切った期間: 前月の締めの翌日〜その月の締めの日
  const cutoffPeriod = (month, day) => ({ from: closingDate(month.subtract(1, 'month').startOf('month'), day).add(1, 'day'), to: closingDate(month, day) })
  window.settleMonth = function (d) {
    const client = selectedClient(), day = client && Number(client.billing_closing_day)
    if (day) {
      // 今の期間（終了日）を含む締めの月から数える。「今月」は今日を含む期間
      const ref = d === 0 ? dayjs() : dayjs(S.to)
      let m = ref.startOf('month')
      if (ref.isAfter(closingDate(m, day), 'day')) m = m.add(1, 'month')
      const p = cutoffPeriod(m.add(d === 0 ? 0 : d, 'month'), day)
      S.from = p.from.format('YYYY-MM-DD'); S.to = p.to.format('YYYY-MM-DD')
    } else {
      const base = d === 0 ? dayjs() : dayjs(S.from).add(d, 'month')
      S.from = base.startOf('month').format('YYYY-MM-DD'); S.to = base.endOf('month').format('YYYY-MM-DD')
    }
    reload()
  }
  delegate('settleMonth', el => settleMonth(Number(el.dataset.d)))
  delegate('settleClosingDay', el => {
    const c = master.clients.find(x => String(x.client_id) === el.dataset.id); if (!c) return
    modal(`
      <h3 class="font-bold text-lg mb-1">締め日の設定</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(c.client_name)}${c.billing_rule ? `（請求条件: ${esc(c.billing_rule)}）` : ''}。精算の前月・今月・翌月のボタンで、この締め日の期間を選べるようになります</p>
      <label class="text-sm">締め日<select id="scd-day" class="inp text-sm"><option value="">未設定（暦月）</option>
        ${Array.from({ length: 30 }, (_, i) => i + 1).map(n => `<option value="${n}" ${Number(c.billing_closing_day) === n ? 'selected' : ''}>${n}日</option>`).join('')}
        <option value="31" ${Number(c.billing_closing_day) >= 31 ? 'selected' : ''}>月末</option></select></label>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" data-action="settleCloseModal">やめる</button>
        <button class="btn btn-primary flex-1" data-action="settleClosingDaySave" data-id="${esc(c.client_id)}">保存</button></div>`)
  })
  delegate('settleClosingDaySave', el => withSubmitLock(el, async () => {
    try {
      await axios.put(`/api/admin/settlement/clients/${encodeURIComponent(el.dataset.id)}/closing-day`, { day: document.getElementById('scd-day').value })
      closeModal(); toast('締め日を保存しました'); await loadMaster(); settleMonth(0)
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleCloseModal', () => closeModal())

  window.renderSettlementBody = function () {
    const data = window.__settleData; const host = document.getElementById('settle-body'); if (!host || !data) return
    document.querySelectorAll('#settle-tabs button').forEach(b => { b.className = `btn ${S.tab === b.dataset.tab ? 'btn-primary' : 'btn-outline'} text-xs` })
    if (S.tab === 'billing') {
      // 請求明細書はクライアントごと（同じクライアントの最初の行にだけリンクを出す）
      const seen = new Set()
      host.innerHTML = `<div class="overflow-x-auto"><table class="tbl" id="settle-billing-table"><thead><tr><th>クライアント</th><th>案件</th><th class="text-right">シフト</th><th class="text-right">人数</th><th class="text-right">時間</th>
        <th class="text-right">請求基本額</th><th class="text-right">交通費</th><th class="text-right">調整</th><th class="text-right">請求合計</th><th class="text-right">支払合計</th><th class="text-right">粗利</th><th>確定</th><th></th></tr></thead><tbody>
        ${data.by_client.map(g => {
          const cid = Number(g.client_id || 0), first = !seen.has(cid); seen.add(cid)
          return `<tr><td>${esc(g.client_name || '-')}</td><td class="font-medium">${esc(g.project_name)}</td><td class="text-right">${g.shifts}</td><td class="text-right">${g.staff}</td><td class="text-right">${hrs(g.hours)}</td>
          <td class="text-right">${yen(g.bill_base)}</td><td class="text-right">${yen(g.bill_transport)}</td><td class="text-right">${g.bill_adjust ? yen(g.bill_adjust) : '-'}</td><td class="text-right font-bold">${yen(g.bill_total)}</td>
          <td class="text-right">${yen(g.pay_total)}${g.pay_unset ? `<span class="block text-[10px] text-amber-600">単価未設定 ${g.pay_unset}件</span>` : ''}</td>
          <td class="text-right">${g.profit == null ? '<span class="text-gray-400" title="支払単価が未設定のため計算できません">—</span>' : yen(g.profit)}${g.pay_unset && g.profit != null ? `<span class="block text-[10px] text-amber-600">請求 ${yen(g.pay_unset_bill)} を除外</span>` : ''}</td>
          <td>${g.confirmed === g.shifts ? '<span class="badge badge-green">確定</span>' : `<span class="badge badge-gray">${g.confirmed}/${g.shifts}</span>`}</td>
          <td class="whitespace-nowrap">${first ? `<a class="text-blue-600 hover:underline text-xs" target="_blank" rel="noopener" href="/api/admin/settlement/statement?kind=billing&client_id=${cid}&${period()}" title="このクライアントの確定済みのシフトの請求明細書（印刷・PDF保存）"><i class="fas fa-file-invoice"></i> 請求明細書</a>` : ''}</td></tr>`
        }).join('') || '<tr><td colspan="13" class="text-center text-gray-400">対象のシフトはありません</td></tr>'}
        </tbody></table></div>
        <p class="text-[11px] text-gray-400 mt-2">請求明細書は、表示中の期間のそのクライアントの確定済みのシフトを載せます（案件・スタッフ・支払区分の絞り込みは使いません）</p>`
      return
    }
    if (S.tab === 'payment') {
      host.innerHTML = `<div class="overflow-x-auto"><table class="tbl" id="settle-payment-table"><thead><tr><th>支払区分</th><th>支払先</th><th>スタッフ</th><th>社員番号</th><th class="text-right">日数</th><th class="text-right">シフト</th><th class="text-right">時間</th>
        <th class="text-right">支払基本額</th><th class="text-right">交通費</th><th class="text-right">調整</th><th class="text-right">支払合計</th><th>確定</th><th></th></tr></thead><tbody>
        ${data.by_payee.map(g => `<tr><td><span class="badge badge-gray">${esc(g.payee_label)}</span></td><td class="font-medium">${esc(g.payee_name)}</td>
          <td class="text-xs">${g.staff_id ? `<a class="text-blue-600 hover:underline" href="#staff/${Number(g.staff_id)}">${esc(g.staff_name)}</a>` : esc(g.staff_name)}</td><td class="text-xs">${esc(g.employee_number || '')}</td>
          <td class="text-right">${g.days}</td><td class="text-right">${g.shifts}</td><td class="text-right">${hrs(g.hours)}</td>
          <td class="text-right">${yen(g.pay_base)}</td><td class="text-right">${yen(g.pay_transport)}</td><td class="text-right">${g.pay_adjust ? yen(g.pay_adjust) : '-'}</td>
          <td class="text-right font-bold">${yen(g.pay_total)}${g.pay_unset ? `<span class="block text-[10px] text-amber-600">単価未設定 ${g.pay_unset}件</span>` : ''}</td>
          <td>${g.confirmed === g.shifts ? '<span class="badge badge-green">確定</span>' : `<span class="badge badge-gray">${g.confirmed}/${g.shifts}</span>`}</td>
          <td class="whitespace-nowrap"><a class="text-blue-600 hover:underline text-xs" target="_blank" rel="noopener" href="/api/admin/settlement/statement?kind=payment&group=${encodeURIComponent(g.group_key)}&${period()}" title="この支払先の確定済みのシフトの支払明細書（印刷・PDF保存）"><i class="fas fa-file-invoice"></i> 支払明細書</a></td></tr>`).join('') || '<tr><td colspan="13" class="text-center text-gray-400">対象のシフトはありません</td></tr>'}
        </tbody></table></div>
        <p class="text-[11px] text-gray-400 mt-2">自社給与・日雇い給与はスタッフごと、取引先・他社はその会社ごとにまとめています。給与ソフトへの取り込みは「支払集計」のCSVを使ってください。支払明細書は、表示中の期間のその支払先の確定済みのシフトを載せます</p>`
      return
    }
    const sel = S.selected
    const allIds = data.rows.map(r => r.shift_id)
    host.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2 text-xs">
        <p class="text-gray-500"><span id="settle-sel-count">${selCountText()}</span><span class="text-gray-400 ml-1">（Shift キーを押しながらチェックすると、前にチェックした行からまとめて選べます）</span></p>
        <div class="flex gap-1.5 flex-wrap">
          <button class="btn btn-primary text-xs" data-action="settleConfirm" data-mode="confirm"><i class="fas fa-check-double"></i><span data-sel-label="選択したシフトを確定|表示中のシフトをすべて確定">${sel.size ? '選択したシフトを確定' : '表示中のシフトをすべて確定'}</span></button>
          <button class="btn btn-outline text-xs" data-action="settleConfirm" data-mode="unconfirm"><i class="fas fa-rotate-left"></i><span data-sel-label="選択の確定を取り消す|表示中の確定を取り消す">${sel.size ? '選択の確定を取り消す' : '表示中の確定を取り消す'}</span></button>
          <button class="btn btn-outline text-xs" data-action="settleAck" id="settle-ack-btn"><i class="fas fa-check"></i><span data-sel-label="選択の確認事項を確認済みにする|表示中の確認事項を確認済みにする">${sel.size ? '選択の確認事項を確認済みにする' : '表示中の確認事項を確認済みにする'}</span></button>
          ${data.rows.some(r => r.issues.includes(RECALC_ISSUE)) ? `<button class="btn btn-outline text-xs" data-action="settleRecalc" id="settle-recalc-btn" title="${esc(RECALC_ISSUE)}のシフトの数量・金額を、今の案件の時間の設定で計算し直します"><i class="fas fa-calculator"></i>金額を再計算（${data.rows.filter(r => r.issues.includes(RECALC_ISSUE)).length}件）</button>` : ''}
        </div>
      </div>
      <div class="overflow-x-auto"><table class="tbl text-xs" id="settle-detail-table"><thead><tr>
        <th><input type="checkbox" id="settle-select-all" data-action="settleSelectAll" ${allIds.length && allIds.every(id => sel.has(id)) ? 'checked' : ''} aria-label="表示中をすべて選択"></th>
        <th>日付</th><th>案件 / 場所</th><th>スタッフ</th><th>予定</th><th>実績</th><th class="text-right">計算時間</th>
        <th class="text-right">請求</th><th class="text-right">支払</th><th>支払先</th><th>確認</th><th>確定</th><th></th></tr></thead><tbody>
        ${data.rows.map(r => detailRowHtml(r, sel)).join('') || '<tr><td colspan="13" class="text-center text-gray-400">対象のシフトはありません（確定・代打のシフトと、キャンセル料・補償を入れた欠勤のシフトが対象です）</td></tr>'}
      </tbody></table></div>`
    syncSelectionUi()
  }
  function detailRowHtml(r, sel) {
    const cancel = r.kind === 'cancel'
    const lock = r.closed ? ' <i class="fas fa-lock text-gray-400" title="締めた期間のシフトです"></i>' : ''
    return `<tr class="${r.settle_status === 'confirmed' ? 'bg-emerald-50/40' : ''}" data-shift-id="${r.shift_id}">
          <td><input type="checkbox" class="settle-pick" data-action="settleSelect" data-id="${r.shift_id}" ${sel.has(r.shift_id) ? 'checked' : ''} aria-label="選択"></td>
          <td class="whitespace-nowrap">${dayjs(r.work_date).format('M/D(dd)')}</td>
          <td class="min-w-[220px]"><p class="font-medium">${esc(r.project_name)}</p><p class="text-gray-400">${esc(r.client_name)}${r.site_name ? '・' + esc(r.site_name) : ''}${r.role ? '・' + esc(r.role) : ''}</p></td>
          <td class="whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#staff/${Number(r.staff_id)}">${esc(r.staff_name)}</a></td>
          <td class="whitespace-nowrap">${esc(r.start_time)}〜${esc(r.end_time)}<span class="text-gray-400 block">休憩${r.break_minutes}分・${hrs(r.planned_hours)}</span></td>
          <td class="whitespace-nowrap">${cancel ? `<span class="badge badge-red">${esc(CANCEL_REASON_LABEL[r.cancel_reason] || '欠勤')}</span>${r.adjust_note ? `<span class="text-gray-400 block">${esc(r.adjust_note)}</span>` : ''}`
            : r.actual_start ? `${esc(r.actual_start)}〜${esc(r.actual_end)}<span class="text-gray-400 block">${r.actual_source === 'manual' ? '手入力' : '報告'}・休憩${r.used_break_minutes}分・${hrs(r.actual_hours)}</span>` : '<span class="text-gray-400">-</span>'}</td>
          <td class="text-right whitespace-nowrap">${cancel ? '<span class="text-gray-400">-</span>' : r.bill_unit_type === 'hourly' || r.pay_unit_type === 'hourly' ? hrs(r.hours) : '<span class="text-gray-400">日額</span>'}</td>
          <td class="text-right whitespace-nowrap">${yen(r.bill_total)}<span class="text-gray-400 block">${cancel ? 'キャンセル料' : r.bill_rate != null ? yen(r.bill_rate) + '/' + UNIT[r.bill_unit_type] : ''}</span></td>
          <td class="text-right whitespace-nowrap">${r.pay_total == null ? '<span class="text-amber-600">未設定</span>' : yen(r.pay_total)}<span class="text-gray-400 block">${cancel ? '補償・控除' : r.pay_rate != null ? yen(r.pay_rate) + '/' + UNIT[r.pay_unit_type] : ''}</span></td>
          <td class="whitespace-nowrap">${esc(PAYEE_LABEL[r.payee_type] || r.payee_type)}${r.payee_type === 'partner' || r.payee_type === 'linked' ? `<span class="text-gray-400 block">${esc(r.payee_name)}</span>` : ''}</td>
          <td>${issuesCellHtml(r)}</td>
          <td class="whitespace-nowrap">${r.settle_status === 'confirmed' ? '<span class="badge badge-green">確定</span>' : '<span class="badge badge-gray">未確定</span>'}${lock}</td>
          <td><button class="text-blue-600 hover:underline whitespace-nowrap" data-action="${cancel ? 'settleCancelEdit' : 'settleEdit'}" data-id="${r.shift_id}">${cancel ? 'キャンセル料・補償' : r.settle_status === 'confirmed' || r.closed ? '詳細' : '実績・金額'}</button></td>
        </tr>`
  }

  // ---------- 選択（#391）。チェックの変更では表を描き直さず、件数・ボタンの文言・全選択の印だけを更新する ----------
  const selCountText = () => `${window.__settleData.rows.length}件${S.selected.size ? `・<b>${S.selected.size}件を選択中</b>` : ''}`
  function syncSelectionUi() {
    const rows = window.__settleData.rows
    const cnt = document.getElementById('settle-sel-count'); if (cnt) cnt.innerHTML = selCountText()
    document.querySelectorAll('#settle-body [data-sel-label]').forEach(el => { const [on, off] = el.dataset.selLabel.split('|'); el.textContent = S.selected.size ? on : off })
    const all = document.getElementById('settle-select-all')
    if (all) {
      const n = rows.filter(r => S.selected.has(r.shift_id)).length
      all.checked = rows.length > 0 && n === rows.length; all.indeterminate = n > 0 && n < rows.length
    }
  }
  const pickBoxes = () => [...document.querySelectorAll('#settle-detail-table input.settle-pick')]
  delegate('settleSelect', (el, ev) => {
    const id = Number(el.dataset.id), on = el.checked
    const boxes = pickBoxes()
    // Shift キー: 前にチェックを変えた行から、この行までを同じ状態にする
    if (ev && ev.shiftKey && lastPicked != null) {
      const a = boxes.findIndex(b => Number(b.dataset.id) === lastPicked), b = boxes.indexOf(el)
      if (a >= 0 && b >= 0) {
        for (const box of boxes.slice(Math.min(a, b), Math.max(a, b) + 1)) { box.checked = on; on ? S.selected.add(Number(box.dataset.id)) : S.selected.delete(Number(box.dataset.id)) }
      }
    }
    on ? S.selected.add(id) : S.selected.delete(id)
    lastPicked = id
    syncSelectionUi()
  })
  delegate('settleSelectAll', el => {
    const on = el.checked
    S.selected = on ? new Set(window.__settleData.rows.map(r => r.shift_id)) : new Set()
    for (const box of pickBoxes()) box.checked = on
    lastPicked = null
    syncSelectionUi()
  })
  // 互換のため残す（ほかの画面から呼ばれていないが、古い画面の HTML が残っていても動くように）
  window.settleSelect = function (id, on) { on ? S.selected.add(id) : S.selected.delete(id); syncSelectionUi() }
  window.settleSelectAll = function (on) { S.selected = on ? new Set(window.__settleData.rows.map(r => r.shift_id)) : new Set(); for (const box of pickBoxes()) box.checked = on; syncSelectionUi() }

  delegate('settleSync', el => withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post('/api/admin/settlement/sync-actuals', filterBody())
      toast(`入店・退店報告を確認しました（${data.checked}件中 ${data.updated}件を更新）`); reload()
    } catch (e) { toast(errMsg(e)) }
  }))

  // 確定・取り消しの対象は、画面に表示中（選択があれば選択中）のシフトの ID を送る。条件で送ると、表示していないシフトまで処理されるため
  const targetIds = () => (S.selected.size ? [...S.selected] : window.__settleData.rows.map(r => r.shift_id))
  const syncedNote = (n) => (n ? `（${n}件は報告の時刻を実績に反映しました）` : '')
  delegate('settleConfirm', el => settleConfirm(el.dataset.mode === 'confirm', el))
  window.settleConfirm = async function (confirm, btn) {
    const ids = targetIds(), label = S.selected.size ? '選択中' : '表示中'
    if (!ids.length) return toast('対象のシフトはありません')
    if (!confirm) {
      const idSet = new Set(ids)
      const target = window.__settleData.rows.filter(r => idSet.has(r.shift_id) && r.settle_status === 'confirmed')
      if (!target.length) return toast(`${label}のシフトに確定済みのものはありません`)
      const closed = target.filter(r => r.closed).length
      if (closed) return toast(`締めた期間のシフトが ${closed}件 含まれているため、確定を取り消せません。取り消すには、先に締めを解除してください`)
      if (!window.confirm(`${label}のシフト ${ids.length}件のうち、確定済みの ${target.length}件 の確定を取り消します。\n確定の後に承認した打刻修正や報告は、取り消しと同時に実績・金額に反映します（手入力の実績は変えません）。よろしいですか？`)) return
      return withSubmitLock(btn, async () => {
        try {
          const { data } = await axios.post('/api/admin/settlement/unconfirm', { shift_ids: ids })
          toast(`${data.unconfirmed}件の確定を取り消しました${syncedNote(data.synced)}`); S.selected.clear(); reload()
        } catch (e) { toast(errMsg(e)) }
      })
    }
    let pre
    try { pre = await withSubmitLock(btn, async () => (await axios.post('/api/admin/settlement/confirm', { shift_ids: ids, dry_run: true })).data) } catch (e) { return toast(errMsg(e)) }
    if (!pre) return
    window.__settleConfirmBody = { shift_ids: ids }
    modal(`
      <h3 class="font-bold text-lg mb-2"><i class="fas fa-check-double text-blue-600 mr-1"></i>実績を確定する</h3>
      <div class="text-sm space-y-1 mb-3" id="settle-confirm-summary">
        <p>${label}のシフト: <b>${ids.length}件</b> ／ 確定するシフト: <b>${pre.count}件</b>（請求 ${yen(pre.bill)} / 支払 ${yen(pre.pay)}）</p>
        ${pre.with_issues ? `<p class="text-red-600"><i class="fas fa-triangle-exclamation mr-1"></i>確認が必要なシフトが ${pre.with_issues}件 含まれています</p>` : ''}
        ${pre.pay_unset ? `<p class="text-amber-600">支払単価が未設定のシフトが ${pre.pay_unset}件 あります（支払の金額には含まれません）</p>` : ''}
        ${pre.in_progress ? `<p class="text-gray-500">勤務が終わっていないシフト ${pre.in_progress}件 は確定しません（退店・勤務終了の報告の後か、翌日以降に確定できます）</p>` : ''}
        ${pre.future ? `<p class="text-gray-500">今日より後のシフト ${pre.future}件 は確定しません</p>` : ''}
        ${pre.closed ? `<p class="text-gray-500">締めた期間のシフト ${pre.closed}件 は確定しません（締めを解除すると確定できます）</p>` : ''}
        ${pre.already ? `<p class="text-gray-500">確定済みの ${pre.already}件 はそのままです</p>` : ''}
      </div>
      <p class="text-xs text-gray-500 mb-3">確定したシフトは、時間・スタッフ・金額を変更できなくなります（シフトボードや単価ルールの再適用、区分変更の対象外になります）。取り消せば再び変更できます</p>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" data-action="settleCloseModal">やめる</button>
        <button class="btn btn-primary flex-1" ${pre.count ? '' : 'disabled'} data-action="settleConfirmRun" data-force="${pre.with_issues ? '1' : ''}">${pre.with_issues ? '確認済みとして確定する' : '確定する'}</button>
      </div>`)
  }
  delegate('settleConfirmRun', el => withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post('/api/admin/settlement/confirm', { ...window.__settleConfirmBody, force: el.dataset.force === '1' })
      closeModal(); toast(`${data.confirmed}件を確定しました`); S.selected.clear(); reload()
    } catch (e) { toast(errMsg(e)) }
  }))
  // 承認待ちの打刻修正の確認事項から、その勤務日の承認待ちの申請一覧を開く
  delegate('settleOpenCorrections', el => {
    // 打刻修正の画面をまだ開いていないときも絞り込みが効くよう、状態を作っておく（corrections.js は既存の状態を使う）
    window.__corrState = Object.assign(window.__corrState || {}, { status: 'pending', project_id: '', staff_name: '', from: '', to: '', report_type: '', kind: '', work_from: el.dataset.date, work_to: el.dataset.date })
    location.hash = 'corrections'
  })

  // ---------- 確認事項の表示と確認済み（#563）・再計算（#79）・区分変更の対象外（#233） ----------
  // 確認が必要な事項は赤、確認済みの事項（確認済みにしたもの・確定したときに確認したもの）は折りたたんで灰色で出す
  function issuesCellHtml(r) {
    const confirmed = r.settle_status === 'confirmed'
    const open = r.issues.map(i => {
      if (i === PENDING_ISSUE) return `<button type="button" class="badge badge-red block mb-0.5 whitespace-nowrap" data-action="settleOpenCorrections" data-date="${esc(r.work_date)}" title="この勤務日の承認待ちの申請を開く">${esc(i)} <i class="fas fa-arrow-up-right-from-square text-[9px]"></i></button>`
      if (i === PAY_REQUEST_ISSUE) return `<button type="button" class="badge badge-red block mb-0.5 whitespace-nowrap" data-action="settlePayReqJump" title="スタッフからの申請の一覧へ">${esc(i)} <i class="fas fa-arrow-up text-[9px]"></i></button>`
      if (i === RECALC_ISSUE && !confirmed) return `<button type="button" class="badge badge-red block mb-0.5 whitespace-nowrap" data-action="settleRecalcOne" data-id="${r.shift_id}" title="今の案件の時間の設定で数量・金額を計算し直す">${esc(i)} <i class="fas fa-calculator text-[9px]"></i></button>`
      if (i === PAYEE_EXCLUDED_ISSUE && !confirmed) return `<button type="button" class="badge badge-red block mb-0.5 whitespace-nowrap" data-action="settleResetPayee" data-id="${r.shift_id}" title="単価ルールを再適用し、今の所属区分の支払先・単価に置き換える">${esc(i)} <i class="fas fa-rotate text-[9px]"></i></button>`
      return `<span class="badge badge-red block mb-0.5 whitespace-nowrap">${esc(i)}</span>`
    }).join('')
    const acked = r.acked_issues || []
    const ackedHtml = acked.length ? `<details class="text-[11px] text-gray-400 mt-0.5" data-acked="${r.shift_id}"><summary class="cursor-pointer whitespace-nowrap">確認済み ${acked.length}件</summary>
      ${acked.map(i => `<span class="badge badge-gray block mb-0.5 whitespace-nowrap">${esc(i)}</span>`).join('')}
      ${r.acked_at ? `<p class="whitespace-nowrap">${esc(r.acked_by_name || '')} ${esc(dayjs(r.acked_at).format('M/D HH:mm'))}</p>` : ''}</details>` : ''
    const actions = [
      r.issues.some(ackable) ? `<button type="button" class="text-[11px] text-blue-600 hover:underline mr-2" data-action="settleAckOne" data-id="${r.shift_id}">確認済みにする</button>` : '',
      r.acked_at ? `<button type="button" class="text-[11px] text-gray-500 hover:underline" data-action="settleUnackOne" data-id="${r.shift_id}">確認済みを取り消す</button>` : '',
    ].join('')
    return (open || '<i class="fas fa-check text-emerald-500"></i>') + ackedHtml + (actions ? `<div class="mt-0.5 whitespace-nowrap">${actions}</div>` : '')
  }

  // 勤怠報告のある希望（仮）のシフト（精算の対象外。確定・欠勤にするよう知らせる）
  function tentativeHtml(list) {
    if (!list.length) return ''
    return `<section class="card p-3 mb-4 border border-amber-200 bg-amber-50/40" id="settle-tentative">
      <p class="text-sm font-bold text-amber-700 mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>勤怠報告のある希望（仮）のシフト ${list.length}件${list.length >= 200 ? '（先頭の200件）' : ''}</p>
      <p class="text-[11px] text-gray-500 mb-2">希望（仮）のシフトは精算の対象外です（請求・支払に入りません）。働いた分はシフトボードで確定に、働いていなければ欠勤にしてください</p>
      <div class="overflow-x-auto"><table class="tbl text-xs"><thead><tr><th>日付</th><th>案件</th><th>スタッフ</th><th>予定</th><th class="text-right">報告</th></tr></thead><tbody>
        ${list.map(s => `<tr data-shift-id="${s.shift_id}"><td class="whitespace-nowrap">${esc(dayjs(s.work_date).format('M/D(dd)'))}</td><td>${esc(s.project_name)}<span class="text-gray-400">${s.client_name ? '・' + esc(s.client_name) : ''}</span></td>
          <td class="whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#staff/${Number(s.staff_id)}">${esc(s.staff_name)}</a></td><td class="whitespace-nowrap">${esc(s.start_time)}〜${esc(s.end_time)}</td><td class="text-right">${Number(s.report_count)}件</td></tr>`).join('')}
      </tbody></table></div>
      <a class="text-xs text-blue-600 hover:underline mt-1 inline-block" href="#shifts">シフトボードを開く</a>
    </section>`
  }
  // キャンセル料・補償をまだ入れていない欠勤のシフト（#283。精算の対象外。金額を入れると対象になる）
  function absentHtml(list) {
    if (!list.length) return ''
    return `<details class="card p-3 mb-4" id="settle-absent"><summary class="cursor-pointer text-sm font-bold text-gray-700"><i class="fas fa-user-xmark text-red-500 mr-1"></i>欠勤・中止のシフト ${list.length}件${list.length >= 200 ? '（先頭の200件）' : ''}（キャンセル料・補償の入力）</summary>
      <p class="text-[11px] text-gray-500 my-2">欠勤のシフトは精算の対象外です。クライアントへのキャンセル料や、スタッフへの補償・控除があるときは、金額を入れると精算の対象になり、確定・集計・CSV・明細書に入ります</p>
      <div class="overflow-x-auto"><table class="tbl text-xs"><thead><tr><th>日付</th><th>案件</th><th>スタッフ</th><th>予定</th><th>欠勤にした日時</th><th></th></tr></thead><tbody>
        ${list.map(s => `<tr data-shift-id="${s.shift_id}"><td class="whitespace-nowrap">${esc(dayjs(s.work_date).format('M/D(dd)'))}</td><td>${esc(s.project_name)}<span class="text-gray-400">${s.client_name ? '・' + esc(s.client_name) : ''}</span></td>
          <td class="whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#staff/${Number(s.staff_id)}">${esc(s.staff_name)}</a></td><td class="whitespace-nowrap">${esc(s.start_time)}〜${esc(s.end_time)}</td>
          <td class="whitespace-nowrap text-gray-400">${s.absent_at ? esc(dayjs(s.absent_at).format('M/D HH:mm')) : '-'}</td>
          <td><button type="button" class="text-blue-600 hover:underline whitespace-nowrap" data-action="settleCancelEdit" data-id="${s.shift_id}">キャンセル料・補償を入力</button></td></tr>`).join('')}
      </tbody></table></div>
    </details>`
  }
  // 表示中の期間と重なる締め（#170）
  function closingBannerHtml(list) {
    if (!list.length) return ''
    return `<div class="p-3 rounded-lg bg-gray-100 text-gray-700 text-xs mb-4" id="settle-closed-banner"><i class="fas fa-lock mr-1"></i>
      締め済みの期間: ${list.map(k => `<b>${esc(k.period_from)}〜${esc(k.period_to)}</b>（${esc(k.closed_by_name || '')} ${esc(dayjs(k.closed_at).format('M/D HH:mm'))}）`).join('、')}。
      この期間のシフトは、確定・取り消し・実績と金額の変更・シフトの変更ができません。変更するには『締め・出力の記録』から締めを解除してください（会社管理者のみ）</div>`
  }

  const rowsOf = (ids) => { const set = new Set(ids); return window.__settleData.rows.filter(r => set.has(r.shift_id)) }
  const ackRun = (ids, undo, btn) => withSubmitLock(btn, async () => {
    try {
      const { data } = await axios.post('/api/admin/settlement/acks', { shift_ids: ids, undo: !!undo })
      toast(undo ? '確認済みを取り消しました' : `${data.shifts}件のシフトの確認事項を確認済みにしました`); reload()
    } catch (e) { toast(errMsg(e)) }
  })
  delegate('settleAck', el => {
    const label = S.selected.size ? '選択中' : '表示中'
    const ids = rowsOf(targetIds()).filter(r => r.issues.some(ackable)).map(r => r.shift_id)
    if (!ids.length) return toast(`${label}のシフトに、確認済みにできる確認事項はありません（承認待ちの打刻修正・交通費と延長の申請は、承認か却下をしてください）`)
    if (!window.confirm(`${label}のシフトのうち、確認事項のある ${ids.length}件 を確認済みにします。\n確認済みの事項は『確認が必要』の件数と確定前の警告に数えません（内容が変わったときや、確定後に新しい修正・報告があったときは、再び確認が必要になります）。よろしいですか？`)) return
    ackRun(ids, false, el)
  })
  delegate('settleAckOne', el => {
    const r = rowsOf([Number(el.dataset.id)])[0]; if (!r) return
    if (!window.confirm(`次の確認事項を確認済みにします。\n・${r.issues.filter(ackable).join('\n・')}`)) return
    ackRun([r.shift_id], false, el)
  })
  delegate('settleUnackOne', el => ackRun([Number(el.dataset.id)], true, el))

  const recalcRun = (ids, btn) => withSubmitLock(btn, async () => {
    try {
      const { data } = await axios.post('/api/admin/settlement/recalc', { shift_ids: ids })
      toast(`${data.updated}件の数量・金額を計算し直しました`); reload()
    } catch (e) { toast(errMsg(e)) }
  })
  delegate('settleRecalc', el => {
    const ids = rowsOf(targetIds()).filter(r => r.issues.includes(RECALC_ISSUE)).map(r => r.shift_id)
    if (!ids.length) return toast('計算し直すシフトはありません')
    if (!window.confirm(`『${RECALC_ISSUE}』のシフト ${ids.length}件 の時給の数量・金額を、今の案件の時間の設定（数え方・丸め・休憩）で計算し直します。\n単価はそのままです。確定済み・手動で金額を変更したシフト・締めた期間のシフトは変えません。よろしいですか？`)) return
    recalcRun(ids, el)
  })
  delegate('settleRecalcOne', el => {
    if (!window.confirm('このシフトの時給の数量・金額を、今の案件の時間の設定で計算し直します（単価はそのまま）。よろしいですか？')) return
    recalcRun([Number(el.dataset.id)], el)
  })
  delegate('settleResetPayee', el => {
    if (!window.confirm('このシフトに単価ルールを再適用し、今の所属区分の支払先・単価に置き換えます（手動で変更した金額も単価ルールの値に戻ります）。よろしいですか？')) return
    withSubmitLock(el, async () => {
      try { await axios.put(`/api/admin/shifts/${Number(el.dataset.id)}/price`, { reset: true }); toast('今の区分の支払先・単価に置き換えました'); reload() } catch (e) { toast(errMsg(e)) }
    })
  })

  // ---------- 実績・金額の編集 ----------
  // 報告・代理入力・日報（実績の根拠。#389）の表示に使う
  const RT_LABEL = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店' }
  const RT_ORDER = Object.keys(RT_LABEL)
  const ENTRY_LABEL = { app: 'アプリ', link: '報告用URL', proxy: '代理入力', correction: '修正申請の承認' }
  delegate('settleEdit', el => openSettleEdit(Number(el.dataset.id)))
  window.openSettleEdit = function (id) {
    const r = window.__settleData.rows.find(x => x.shift_id === id); if (!r) return
    if (r.kind === 'cancel') return openCancelEdit(id)
    const locked = r.settle_status === 'confirmed' || r.closed
    const dis = locked ? 'disabled' : ''
    modal(`
      <h3 class="font-bold text-lg mb-1">${esc(r.staff_name)}・${dayjs(r.work_date).format('M/D(dd)')}</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(r.client_name)} ${esc(r.project_name)}${r.site_name ? '・' + esc(r.site_name) : ''}${r.role ? '・' + esc(r.role) : ''}</p>
      ${r.closed ? `<div class="p-2 rounded-lg bg-gray-100 text-gray-700 text-xs mb-3" id="settle-closed-notice"><i class="fas fa-lock mr-1"></i>締めた期間のシフトです。変更するには締めを解除してください</div>`
        : r.settle_status === 'confirmed' ? `<div class="p-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs mb-3" id="settle-locked-notice"><i class="fas fa-lock mr-1"></i>確定済み（${esc(r.settled_at || '')}）。変更するには確定を取り消してください</div>` : ''}
      <section class="rounded-lg border border-gray-100 p-3 mb-3 text-xs" id="settle-evidence"><p class="text-gray-400"><span class="spin"></span> 報告を読み込み中…</p></section>
      <section class="rounded-lg border border-gray-100 p-3 mb-3 text-sm" id="settle-actual-form">
        <p class="font-bold text-gray-700 text-xs mb-2"><i class="fas fa-clock mr-1"></i>実績（予定 ${esc(r.start_time)}〜${esc(r.end_time)}・休憩${r.break_minutes}分）</p>
        <div class="grid grid-cols-3 gap-2 text-xs">
          <label>開始<input type="time" id="se-start" class="inp text-sm" value="${esc(r.actual_start || '')}" ${dis}></label>
          <label>終了<input type="time" id="se-end" class="inp text-sm" value="${esc(r.actual_end || '')}" ${dis}></label>
          <label>休憩（分）<input type="number" id="se-break" class="inp text-sm" value="${r.actual_break_minutes ?? ''}" placeholder="${r.break_minutes}" ${dis}></label>
          <label class="col-span-3">メモ<input id="se-note" class="inp text-sm" value="${esc(r.actual_note || '')}" placeholder="例: 30分残業（店長了承）" ${dis}></label>
        </div>
        <p class="text-[11px] text-gray-400 mt-1">${r.actual_source === 'manual' ? '手入力の実績です（入店・退店報告では上書きしません）' : r.actual_source === 'report' ? '入店・退店報告から反映した実績です' : '実績はまだありません'}。
          実働 ${hrs(r.actual_hours)}・計算に使う時間 ${hrs(r.hours)}${r.pay_hours != null && r.pay_hours !== r.hours ? `（支払は丸めずに ${hrs(r.pay_hours)}）` : ''}</p>
        ${locked ? '' : `<div class="flex gap-2 mt-2">
          <button class="btn btn-primary text-xs flex-1" data-action="settleSaveActual" data-id="${r.shift_id}">実績を保存して再計算</button>
          ${r.actual_source === 'manual' ? `<button class="btn btn-outline text-xs" data-action="settleResetActual" data-id="${r.shift_id}">報告の時刻に戻す</button>` : ''}</div>`}
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
        ${r.price_locked ? `<p class="text-amber-600 mt-1">${r.qty_locked ? '手動で金額を変更したシフトです（単価・数量とも固定。実働が変わっても金額は変わりません）' : '手動で単価を変更したシフトです（単価はそのまま、時給の数量は実働に合わせます）'}</p>` : ''}
        ${locked ? '' : `<button class="btn btn-outline text-xs w-full mt-2" data-action="settleOpenPrice" data-id="${r.shift_id}"><i class="fas fa-pen"></i>単価・交通費・調整を変更</button>`}
      </section>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" data-action="settleCloseModal">閉じる</button>
        ${r.closed ? '' : r.settle_status === 'confirmed' ? `<button class="btn btn-outline flex-1" data-action="settleToggleOne" data-id="${r.shift_id}" data-mode="unconfirm"><i class="fas fa-rotate-left"></i>確定を取り消す</button>`
        : `<button class="btn btn-primary flex-1" data-action="settleToggleOne" data-id="${r.shift_id}" data-mode="confirm"><i class="fas fa-check"></i>このシフトを確定</button>`}
      </div>`)
    loadEvidence(r)
  }
  // 実績の元になった報告（時刻・入力の方法・遅刻・打刻修正）と日報の提出状況を、読み取り専用で出す（#389）。
  // 代理入力・報告用URLの発行はシフトボードの報告状況から行う
  async function loadEvidence(r) {
    let d
    try { d = (await axios.get(`/api/admin/shifts/${r.shift_id}/report-status`)).data } catch (e) {
      const host = document.getElementById('settle-evidence'); if (host) host.innerHTML = `<p class="text-red-600">${esc(errMsg(e, '報告を読み込めませんでした'))}</p>`; return
    }
    const host = document.getElementById('settle-evidence'); if (!host || d.shift_id !== r.shift_id) return
    const at = (v) => (v ? (String(v).slice(0, 10) !== d.work_date ? dayjs(v).format('M/D HH:mm') : dayjs(v).format('HH:mm')) : '')
    const reports = [...(d.reports || [])].sort((a, b) => String(a.reported_at).localeCompare(String(b.reported_at)) || RT_ORDER.indexOf(a.report_type) - RT_ORDER.indexOf(b.report_type))
    const required = (d.modes && d.modes.required_attendance) || []
    const missing = required.filter(t => !reports.some(x => x.report_type === t))
    const dr = d.modes && d.modes.daily_report_required
    host.innerHTML = `<p class="font-bold text-gray-700 mb-1"><i class="fas fa-clipboard-check mr-1"></i>報告（実績の根拠）</p>
      ${reports.length ? `<table class="tbl text-xs"><thead><tr><th>種類</th><th>時刻</th><th>入力</th><th>メモ</th></tr></thead><tbody>
        ${reports.map(x => `<tr><td class="whitespace-nowrap">${esc(RT_LABEL[x.report_type] || x.report_type)}</td><td class="whitespace-nowrap">${esc(at(x.reported_at))}</td>
          <td class="whitespace-nowrap">${esc(ENTRY_LABEL[x.entry_method] || 'アプリ')}${x.entered_by_name ? `（${esc(x.entered_by_name)}）` : ''}</td>
          <td class="text-gray-500">${[x.late_minutes ? `遅刻${Number(x.late_minutes)}分` : '', x.early_leave_minutes ? `早退${Number(x.early_leave_minutes)}分` : '', x.original_reported_at ? `打刻修正で変更（元: ${esc(at(x.original_reported_at))}）` : x.corrected_by_correction_id ? '打刻修正で追加' : ''].filter(Boolean).join('・')}</td></tr>`).join('')}
      </tbody></table>` : '<p class="text-gray-400">勤怠報告はありません</p>'}
      ${missing.length ? `<p class="text-amber-600 mt-1">未報告: ${missing.map(t => esc(RT_LABEL[t] || t)).join('・')}</p>` : ''}
      <p class="mt-1">${dr ? (d.daily_report ? `<span class="badge badge-green">日報 提出済み</span> <span class="text-gray-400">${esc(dayjs(d.daily_report.submitted_at).format('M/D HH:mm'))}${d.daily_report.entry_method === 'proxy' ? '・代理入力' : ''}</span>` : '<span class="badge badge-gray">日報 未提出</span>') : '<span class="text-gray-400">日報なし（提出不要の設定）</span>'}</p>
      <p class="text-[11px] text-gray-400 mt-1">代理入力・報告用URLの発行は、シフトボードのシフト詳細の『勤怠・日報』から行えます</p>`
  }
  delegate('settleSaveActual', el => withSubmitLock(el, async () => {
    const id = Number(el.dataset.id), v = (k) => document.getElementById(k).value
    try {
      await axios.put(`/api/admin/shifts/${id}/actual`, { actual_start: v('se-start'), actual_end: v('se-end'), actual_break_minutes: v('se-break'), actual_note: v('se-note') })
      toast('実績を保存しました'); await reload(); openSettleEdit(id)
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleResetActual', el => withSubmitLock(el, async () => {
    const id = Number(el.dataset.id)
    try { await axios.put(`/api/admin/shifts/${id}/actual`, { reset: true }); toast('報告の時刻に戻しました'); await reload(); openSettleEdit(id) } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleToggleOne', el => withSubmitLock(el, () => settleToggleOne(Number(el.dataset.id), el.dataset.mode === 'confirm')))
  window.settleToggleOne = async function (id, confirm) {
    try {
      if (confirm) {
        const r = window.__settleData.rows.find(x => x.shift_id === id)
        if (r && r.issues.length && !window.confirm(`確認事項があります（${r.issues.join('、')}）。確定しますか？`)) return
        const { data } = await axios.post('/api/admin/settlement/confirm', { shift_ids: [id], force: true })
        if (!data.confirmed) return toast(data.skipped_closed ? '締めた期間のシフトは確定できません' : data.skipped_future ? '今日より後のシフトは確定できません'
          : data.skipped_in_progress ? '勤務が終わっていないため確定できません（退店・勤務終了の報告の後か、翌日以降に確定できます）' : '確定できませんでした')
        toast('確定しました')
      } else { const { data } = await axios.post('/api/admin/settlement/unconfirm', { shift_ids: [id] }); toast(`確定を取り消しました${syncedNote(data.synced)}`) }
      closeModal(); reload()
    } catch (e) { toast(errMsg(e)) }
  }
  // 単価・交通費・調整の手動変更（このシフトだけ。PUT /api/admin/shifts/:id/price）
  const UNIT_LABEL = { daily: '日額', hourly: '時給' }
  const BT_LABEL = { actual: '実費', fixed: '定額', included: '単価に込み' }
  const PT_LABEL = { actual: '実費', capped: '実費（上限あり）', fixed: '定額', none: '支払なし' }
  const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')
  delegate('settleOpenPrice', el => { closeModal(); openShiftPriceFromSettle(Number(el.dataset.id)) })
  window.openShiftPriceFromSettle = function (id) {
    const r = window.__settleData.rows.find(x => x.shift_id === id); if (!r) return
    modal(`
      <h3 class="font-bold text-lg mb-1">金額の変更</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(r.staff_name)}・${dayjs(r.work_date).format('M/D(dd)')}・${esc(r.project_name)}。時給の数量を空欄にすると計算時間（${hrs(r.hours)}${r.pay_hours != null && r.pay_hours !== r.hours ? `・支払 ${hrs(r.pay_hours)}` : ''}）を使い、実績が変われば数量も変わります。数量を入れると固定します</p>
      <div class="grid grid-cols-3 gap-2 text-xs" id="settle-price-form">
        <label>請求<select id="spx-bill-unit" class="inp text-xs">${opt(UNIT_LABEL, r.bill_unit_type)}</select></label>
        <label>請求単価<input id="spx-bill-rate" type="number" class="inp text-xs" value="${r.bill_rate ?? ''}"></label>
        <label>数量<input id="spx-bill-qty" type="number" step="0.25" min="0" max="24" class="inp text-xs" value="${r.qty_locked ? (r.bill_qty ?? '') : ''}" placeholder="${r.bill_qty ?? ''}"></label>
        <label>支払<select id="spx-pay-unit" class="inp text-xs">${opt(UNIT_LABEL, r.pay_unit_type)}</select></label>
        <label>支払単価<input id="spx-pay-rate" type="number" class="inp text-xs" value="${r.pay_rate ?? ''}" placeholder="未設定"></label>
        <label>数量<input id="spx-pay-qty" type="number" step="0.25" min="0" max="24" class="inp text-xs" value="${r.qty_locked ? (r.pay_qty ?? '') : ''}" placeholder="${r.pay_qty ?? ''}"></label>
        <label>交通費の実費<input id="spx-fee" type="number" class="inp text-xs" value="${r.transportation_fee}"></label>
        <label>交通費の請求<select id="spx-bt" class="inp text-xs">${opt(BT_LABEL, r.bill_transport_type)}</select></label>
        <label>請求額（定額時）<input id="spx-bt-amt" type="number" class="inp text-xs" value="${r.bill_transport_amount}"></label>
        <label class="col-start-2">交通費の支払<select id="spx-pt" class="inp text-xs">${opt(PT_LABEL, r.pay_transport_type)}</select></label>
        <label>上限/定額<input id="spx-pt-amt" type="number" class="inp text-xs" value="${r.pay_transport_amount}"></label>
        <label>請求の調整<input id="spx-bill-adj" type="number" class="inp text-xs" value="${r.bill_adjust || ''}" placeholder="0"></label>
        <label>支払の調整<input id="spx-pay-adj" type="number" class="inp text-xs" value="${r.pay_adjust || ''}" placeholder="0"></label>
        <label>調整の内容<input id="spx-adj-note" class="inp text-xs" value="${esc(r.adjust_note)}" placeholder="残業・手当など"></label>
      </div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-outline flex-1" data-action="settleEdit" data-id="${r.shift_id}">戻る</button>
        ${r.price_locked ? `<button class="btn btn-outline flex-1" data-action="settleResetPrice" data-id="${r.shift_id}">単価ルールに戻す</button>` : ''}
        <button class="btn btn-primary flex-1" data-action="settleSavePrice" data-id="${r.shift_id}">保存（このシフトだけ）</button>
      </div>`)
  }
  delegate('settleSavePrice', el => withSubmitLock(el, async () => {
    const id = Number(el.dataset.id), v = (k) => document.getElementById(k).value
    try {
      await axios.put(`/api/admin/shifts/${id}/price`, {
        bill_unit_type: v('spx-bill-unit'), bill_rate: v('spx-bill-rate'), bill_qty: v('spx-bill-qty'),
        pay_unit_type: v('spx-pay-unit'), pay_rate: v('spx-pay-rate'), pay_qty: v('spx-pay-qty'),
        transportation_fee: v('spx-fee'), bill_transport_type: v('spx-bt'), bill_transport_amount: v('spx-bt-amt'),
        pay_transport_type: v('spx-pt'), pay_transport_amount: v('spx-pt-amt'),
        bill_adjust: v('spx-bill-adj'), pay_adjust: v('spx-pay-adj'), adjust_note: v('spx-adj-note'),
      })
      toast('金額を保存しました'); await reload(); openSettleEdit(id)
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleResetPrice', el => withSubmitLock(el, async () => {
    const id = Number(el.dataset.id)
    try { await axios.put(`/api/admin/shifts/${id}/price`, { reset: true }); toast('単価ルールに戻しました'); await reload(); openSettleEdit(id) } catch (e) { toast(errMsg(e)) }
  }))

  // ---------- 欠勤・中止のキャンセル料・補償（#283） ----------
  delegate('settleCancelEdit', el => openCancelEdit(Number(el.dataset.id)))
  let cancelCtx = null
  async function openCancelEdit(id) {
    let d
    try { d = (await axios.get(`/api/admin/settlement/cancellations/${id}`)).data } catch (e) { return toast(errMsg(e)) }
    cancelCtx = d
    const s = d.shift, cx = d.cancellation || {}, p = d.policy || {}
    const locked = s.settle_status === 'confirmed' || !!d.closed
    const dis = locked ? 'disabled' : ''
    const notified = cx.notified_on || (s.absent_at ? String(s.absent_at).slice(0, 10) : s.work_date)
    const row = (window.__settleData.rows || []).find(x => x.shift_id === id)
    modal(`
      <h3 class="font-bold text-lg mb-1">キャンセル料・補償</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(s.staff_name)}・${dayjs(s.work_date).format('M/D(dd)')} ${esc(s.start_time)}〜${esc(s.end_time)}・${esc(s.client_name)} ${esc(s.project_name)}${s.status !== 'absent' ? '<span class="text-red-600">（欠勤ではありません）</span>' : ''}</p>
      ${d.closed ? `<div class="p-2 rounded-lg bg-gray-100 text-gray-700 text-xs mb-3"><i class="fas fa-lock mr-1"></i>${esc(d.closed)}</div>`
        : s.settle_status === 'confirmed' ? '<div class="p-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs mb-3"><i class="fas fa-lock mr-1"></i>確定済みです。変更するには確定を取り消してください</div>' : ''}
      <div class="grid grid-cols-2 gap-2 text-xs" id="settle-cancel-form">
        <label>理由<select id="scx-reason" class="inp text-sm" ${dis}><option value="">選んでください</option>${Object.entries(CANCEL_REASON_LABEL).map(([k, l]) => `<option value="${k}" ${cx.reason === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>連絡を受けた日<input type="date" id="scx-notified" class="inp text-sm" value="${esc(notified)}" ${dis}></label>
        <label>キャンセル料（請求）<input type="number" id="scx-bill" class="inp text-sm" value="${cx.bill_amount ?? ''}" placeholder="0" ${dis}></label>
        <label>補償・控除（支払。控除は負の値）<input type="number" id="scx-pay" class="inp text-sm" value="${cx.pay_amount ?? ''}" placeholder="0" ${dis}></label>
        <label class="col-span-2">メモ<input id="scx-note" class="inp text-sm" value="${esc(cx.note || '')}" placeholder="例: 前日夜に店舗都合で中止の連絡" ${dis}></label>
      </div>
      <p class="text-[11px] text-gray-400 mt-1">予定の金額: 請求 ${yen(s.planned_bill)}・支払 ${s.planned_pay == null ? '未設定' : yen(s.planned_pay)}</p>
      <section class="rounded-lg border border-gray-100 p-3 mt-3 text-xs" id="settle-cancel-policy">
        <p class="font-bold text-gray-700 mb-1">この案件のキャンセル料の規定（クライアント都合の中止）</p>
        <div class="grid grid-cols-3 gap-2">
          <label>前日の連絡（%）<input type="number" id="scp-prev" class="inp text-xs" min="0" max="100" value="${p.bill_rate_prev_day ?? ''}" placeholder="規定なし"></label>
          <label>当日の連絡（%）<input type="number" id="scp-same" class="inp text-xs" min="0" max="100" value="${p.bill_rate_same_day ?? ''}" placeholder="規定なし"></label>
          <label>スタッフへの補償（%）<input type="number" id="scp-pay" class="inp text-xs" min="0" max="100" value="${p.pay_rate ?? ''}" placeholder="規定なし"></label>
        </div>
        <div class="flex gap-2 mt-2">
          <button type="button" class="btn btn-outline text-xs" data-action="settleCancelPolicySave" data-id="${esc(s.project_id)}">規定を保存</button>
          ${locked ? '' : '<button type="button" class="btn btn-outline text-xs" data-action="settleCancelSuggest">規定から金額を入れる</button>'}
        </div>
        <p class="text-[11px] text-gray-400 mt-1">請求 = 予定の請求基本額 × 前日（または当日）の率、支払 = 予定の支払基本額 × 補償率。2日前より前の連絡は 0 円です。スタッフ都合の欠勤は、規定から入れると 0 円になります（必要なら手で入れてください）</p>
      </section>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-outline flex-1" data-action="settleCloseModal">閉じる</button>
        ${!locked && d.cancellation ? `<button class="btn btn-outline flex-1" data-action="settleCancelRemove" data-id="${s.shift_id}">精算の対象から外す</button>` : ''}
        ${locked ? '' : `<button class="btn btn-primary flex-1" data-action="settleCancelSave" data-id="${s.shift_id}">保存</button>`}
        ${!d.closed && row && row.settle_status === 'confirmed' ? `<button class="btn btn-outline flex-1" data-action="settleToggleOne" data-id="${s.shift_id}" data-mode="unconfirm"><i class="fas fa-rotate-left"></i>確定を取り消す</button>` : ''}
        ${!locked && row ? `<button class="btn btn-primary flex-1" data-action="settleToggleOne" data-id="${s.shift_id}" data-mode="confirm"><i class="fas fa-check"></i>確定</button>` : ''}
      </div>`)
  }
  delegate('settleCancelSuggest', () => {
    const d = cancelCtx; if (!d) return
    const reason = document.getElementById('scx-reason').value
    if (!reason) return toast('先に理由を選んでください')
    if (reason === 'staff') { document.getElementById('scx-bill').value = 0; document.getElementById('scx-pay').value = 0; return }
    const rate = (id) => { const v = document.getElementById(id).value; return v === '' ? null : Number(v) }
    const notified = document.getElementById('scx-notified').value || d.shift.work_date
    const days = dayjs(d.shift.work_date).diff(dayjs(notified), 'day')
    const billRate = days <= 0 ? rate('scp-same') : days === 1 ? rate('scp-prev') : 0
    const payRate = rate('scp-pay')
    if (billRate == null && payRate == null) return toast('この案件の規定がありません。率を入れてください')
    document.getElementById('scx-bill').value = Math.round(d.shift.planned_bill * (billRate || 0) / 100)
    document.getElementById('scx-pay').value = Math.round((d.shift.planned_pay || 0) * (payRate || 0) / 100)
  })
  delegate('settleCancelPolicySave', el => withSubmitLock(el, async () => {
    const v = (id) => document.getElementById(id).value
    try { await axios.put(`/api/admin/settlement/projects/${encodeURIComponent(el.dataset.id)}/cancel-policy`, { bill_rate_prev_day: v('scp-prev'), bill_rate_same_day: v('scp-same'), pay_rate: v('scp-pay') }); toast('この案件の規定を保存しました') } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleCancelSave', el => withSubmitLock(el, async () => {
    const id = Number(el.dataset.id), v = (k) => document.getElementById(k).value
    if (!v('scx-reason')) return toast('理由を選んでください')
    try {
      await axios.put(`/api/admin/settlement/cancellations/${id}`, { reason: v('scx-reason'), notified_on: v('scx-notified'), bill_amount: v('scx-bill'), pay_amount: v('scx-pay'), note: v('scx-note') })
      toast('キャンセル料・補償を保存しました'); await reload(); openCancelEdit(id)
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleCancelRemove', el => {
    if (!window.confirm('このシフトのキャンセル料・補償を消し、精算の対象から外します。よろしいですか？')) return
    withSubmitLock(el, async () => {
      try { await axios.put(`/api/admin/settlement/cancellations/${Number(el.dataset.id)}`, { remove: true }); closeModal(); toast('精算の対象から外しました'); reload() } catch (e) { toast(errMsg(e)) }
    })
  })

  // ---------- 締めと出力の記録（#170） ----------
  const EXPORT_LABEL = { detail: 'シフト明細CSV', billing: '請求集計CSV', payment: '支払集計CSV', statement_billing: '請求明細書', statement_payment: '支払明細書' }
  delegate('settleClosings', el => withSubmitLock(el, openClosings))
  async function openClosings() {
    let d
    try { d = (await axios.get('/api/admin/settlement/closings')).data } catch (e) { return toast(errMsg(e)) }
    modal(`
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-lock text-blue-600 mr-1"></i>精算の締め</h3>
      <p class="text-xs text-gray-500 mb-3">締めた期間のシフトは、確定・取り消し、実績と金額の変更、打刻修正・報告の実績への反映、シフトの追加・変更・削除ができなくなります。給与・請求に使った金額を固定するために、月末の処理の後に締めてください。解除は会社管理者だけができ、理由を記録します</p>
      <section class="rounded-lg border border-gray-100 p-3 mb-3 text-sm">
        <p class="text-xs mb-2">表示中の期間 <b>${esc(S.from)}〜${esc(S.to)}</b> を締めます。期間内の精算の対象（確定・代打・キャンセル料を入れた欠勤）が、すべて確定済みである必要があります</p>
        <input id="scl-note" class="inp text-sm mb-2" placeholder="メモ（例: 9月分 給与・請求処理済み）">
        <button class="btn btn-primary text-sm w-full" data-action="settleCloseRun"><i class="fas fa-lock"></i>この期間を締める</button>
      </section>
      <p class="font-bold text-sm text-gray-700 mb-1">締めの記録</p>
      <div class="overflow-x-auto mb-3"><table class="tbl text-xs" id="settle-closings-table"><thead><tr><th>期間</th><th class="text-right">件数</th><th class="text-right">請求</th><th class="text-right">支払</th><th>締めた人</th><th>状態</th><th></th></tr></thead><tbody>
        ${(d.closings || []).map(k => `<tr><td class="whitespace-nowrap">${esc(k.period_from)}〜${esc(k.period_to)}${k.note ? `<span class="block text-gray-400">${esc(k.note)}</span>` : ''}</td>
          <td class="text-right">${Number(k.shift_count)}</td><td class="text-right">${yen(k.bill_total)}</td><td class="text-right">${yen(k.pay_total)}</td>
          <td class="whitespace-nowrap">${esc(k.closed_by_name || '')}<span class="block text-gray-400">${esc(dayjs(k.closed_at).format('YYYY/M/D HH:mm'))}</span></td>
          <td>${k.reopened_at ? `<span class="badge badge-gray">解除済み</span><span class="block text-gray-400">${esc(k.reopened_by_name || '')} ${esc(dayjs(k.reopened_at).format('M/D HH:mm'))}・${esc(k.reopen_reason || '')}</span>` : '<span class="badge badge-green">締め済み</span>'}</td>
          <td>${!k.reopened_at && d.can_reopen ? `<button type="button" class="text-blue-600 hover:underline whitespace-nowrap" data-action="settleReopen" data-id="${Number(k.closing_id)}" data-period="${esc(k.period_from + '〜' + k.period_to)}">解除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400">締めた期間はありません</td></tr>'}
      </tbody></table></div>
      <p class="font-bold text-sm text-gray-700 mb-1">出力の記録（最近30件）</p>
      <div class="overflow-x-auto mb-3"><table class="tbl text-xs" id="settle-exports-table"><thead><tr><th>日時</th><th>種類</th><th>期間</th><th class="text-right">行数</th><th>出力した人</th></tr></thead><tbody>
        ${(d.exports || []).map(x => `<tr><td class="whitespace-nowrap">${esc(dayjs(x.exported_at).format('YYYY/M/D HH:mm'))}</td><td>${esc(EXPORT_LABEL[x.kind] || x.kind)}</td>
          <td class="whitespace-nowrap">${esc(x.period_from || '')}〜${esc(x.period_to || '')}</td><td class="text-right">${x.row_count == null ? '-' : Number(x.row_count)}</td><td>${esc(x.exported_by_name || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400">出力の記録はありません</td></tr>'}
      </tbody></table></div>
      <button class="btn btn-outline w-full" data-action="settleCloseModal">閉じる</button>`)
  }
  async function closeOnce(force) {
    try {
      const { data } = await axios.post('/api/admin/settlement/closings', { from: S.from, to: S.to, note: (document.getElementById('scl-note') || {}).value || '', force })
      closeModal(); toast(`${S.from}〜${S.to} を締めました（${data.shifts}件・請求 ${yen(data.bill)}・支払 ${yen(data.pay)}）`); reload()
    } catch (e) {
      const r = e && e.response && e.response.data
      if (!force && r && r.need_force && window.confirm(`${r.error}。\nこのまま締めますか？（締めた後は、解除するまで確定を取り消せません）`)) return closeOnce(true)
      toast(errMsg(e))
    }
  }
  const closeRun = (force, btn) => withSubmitLock(btn, () => closeOnce(force))
  delegate('settleCloseRun', el => {
    if (!window.confirm(`${S.from}〜${S.to} を締めます。締めた後は、この期間のシフトの確定の取り消し・金額の変更・シフトの変更ができなくなります。よろしいですか？`)) return
    closeRun(false, el)
  })
  delegate('settleReopen', el => {
    const reason = window.prompt(`${el.dataset.period} の締めを解除します。解除の理由を入力してください（記録に残ります）`)
    if (reason == null) return
    if (!reason.trim()) return toast('解除の理由を入力してください')
    withSubmitLock(el, async () => {
      try { await axios.post(`/api/admin/settlement/closings/${Number(el.dataset.id)}/reopen`, { reason }); toast('締めを解除しました'); await openClosings(); reload() } catch (e) { toast(errMsg(e)) }
    })
  })
  // ---------- スタッフからの交通費・延長の申請（#172 #273）と、スタッフアプリでの支払額の表示（#290）。w5-staff-pay-features ----------
  // 承認待ちの申請は、期間の絞り込みに関係なくすべて出す（確定・締めの前に片づけられるように）
  const PAY_KIND = { transport: '交通費（実費）', overtime: '延長' }
  let PAYREQ = []
  const spanMin = (s, e) => { const m = (t) => { const [h, mm] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (mm || 0) }; let x = m(e) - m(s); if (x <= 0) x += 1440; return x }
  function payReqContent(q) {
    if (q.kind === 'transport') {
      return `<b>${esc(yen(q.amount))}</b>（${q.round_trip ? '往復' : '片道'}）${esc(q.route || '')}
        <span class="block text-[11px] text-gray-500">今の実費 ${esc(yen(q.transportation_fee))}・支払の交通費: ${esc(PT_LABEL[q.pay_transport_type] || q.pay_transport_type)}${q.pay_transport_type === 'capped' || q.pay_transport_type === 'fixed' ? ' ' + esc(yen(q.pay_transport_amount)) : ''}</span>`
    }
    const plus = q.start_time && q.end_time && q.new_end_time ? spanMin(q.start_time, q.new_end_time) - spanMin(q.start_time, q.end_time) : null
    return `終了 ${esc(q.end_time || q.before_end_time || '')} → <b>${esc(q.new_end_time)}</b>${plus != null && plus > 0 ? `（+${plus}分）` : ''}
      <span class="block text-[11px] text-gray-500">${q.instructed_by ? '指示: ' + esc(q.instructed_by) + '・' : ''}${q.pay_unit_type === 'hourly' ? '時給（承認すると延びた分も支払に入ります）' : '日給（承認しても金額は変わりません。必要なら調整額を入れてください）'}</span>`
  }
  async function loadPayRequests() {
    const host = document.getElementById('settle-payreq'); if (!host) return
    let d, st
    try {
      const rs = await Promise.all([axios.get('/api/admin/pay-requests'), axios.get('/api/admin/staff-pay/settings')])
      d = rs[0].data; st = rs[1].data
    } catch (e) {
      if (host.isConnected) host.innerHTML = `<p class="text-xs text-red-600 mb-4">スタッフからの交通費・延長の申請を読み込めませんでした: ${esc(errMsg(e))}</p>`
      return
    }
    if (!host.isConnected) return
    PAYREQ = d.requests || []
    const rows = PAYREQ.map(q => `<tr data-request-id="${Number(q.request_id)}">
        <td class="whitespace-nowrap">${q.work_date ? esc(dayjs(q.work_date).format('M/D(dd)')) : '-'}</td>
        <td class="whitespace-nowrap"><a class="text-blue-600 hover:underline" href="#staff/${Number(q.staff_id)}">${esc(q.staff_name)}</a></td>
        <td>${esc(q.project_name)}</td>
        <td class="whitespace-nowrap">${esc(PAY_KIND[q.kind] || q.kind)}</td>
        <td>${payReqContent(q)}</td>
        <td class="max-w-xs">${esc(q.reason || '')}</td>
        <td class="whitespace-nowrap text-gray-400">${esc(dayjs(q.created_at).format('M/D HH:mm'))}</td>
        <td class="whitespace-nowrap">${q.shift_issue ? `<p class="text-[11px] text-amber-700 mb-1 whitespace-normal">${esc(q.shift_issue)}</p>` : ''}
          <button type="button" class="btn btn-primary text-xs py-1" data-action="settlePayReqApprove" data-id="${Number(q.request_id)}" ${q.shift_issue ? 'disabled' : ''}>承認</button>
          <button type="button" class="btn btn-outline text-xs py-1" data-action="settlePayReqReject" data-id="${Number(q.request_id)}">却下</button></td></tr>`).join('')
    const visible = `<p class="text-[11px] text-gray-500 mt-2">スタッフアプリでの支払額の表示: <b>${st.staff_pay_visible ? '表示する' : '表示しない'}</b>
      ${st.can_edit ? `<button type="button" class="text-blue-600 hover:underline ml-1" data-action="settleStaffPayToggle" data-on="${st.staff_pay_visible ? '0' : '1'}">${st.staff_pay_visible ? '表示をやめる' : '表示する'}</button>` : '（変更は会社管理者のみ）'}
      <span class="block text-gray-400">表示すると、支払先が本人（自社給与・日雇い給与・個人事業主）のシフトの支払額（単価・交通費・調整・合計）と、月の見込み・確定の合計を本人が見られます。請求額・取引先や他社への支払・調整のメモは見せません</span></p>`
    host.innerHTML = `<section class="card p-3 mb-4 ${PAYREQ.length ? 'border border-amber-200 bg-amber-50/40' : ''}" id="settle-payreq-card">
      <p class="text-sm font-bold ${PAYREQ.length ? 'text-amber-700' : 'text-gray-700'}"><i class="fas fa-train-subway mr-1"></i>スタッフからの交通費・延長の申請（承認待ち ${PAYREQ.length}件）</p>
      ${PAYREQ.length ? `<p class="text-[11px] text-gray-500 my-1">承認すると、交通費はシフトの交通費（実費）に、延長はシフトの予定の終了時刻に反映します。確定済み・締めた期間のシフトは承認できません</p>
      <div class="overflow-x-auto"><table class="tbl text-xs"><thead><tr><th>日付</th><th>スタッフ</th><th>案件</th><th>種類</th><th>内容</th><th>理由・メモ</th><th>申請</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="text-xs text-gray-400 mt-1">承認待ちの申請はありません</p>'}
      ${visible}</section>`
  }
  delegate('settlePayReqJump', () => { const el = document.getElementById('settle-payreq'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }) })
  delegate('settlePayReqApprove', el => {
    const q = PAYREQ.find(x => x.request_id === Number(el.dataset.id)); if (!q) return
    const field = q.kind === 'transport'
      ? `<label class="text-sm text-gray-600 block mb-1">承認する金額（円。交通費の実費として記録します）</label><input id="pr-amount" type="number" min="0" class="inp mb-2" value="${esc(q.amount)}">`
      : `<label class="text-sm text-gray-600 block mb-1">延長後の終了時刻（シフトの予定の終了時刻を変えます）</label><input id="pr-end" type="time" class="inp mb-2" value="${esc(q.new_end_time)}">`
    modal(`<h3 class="font-bold text-gray-800 mb-1">${esc(PAY_KIND[q.kind] || q.kind)}の申請を承認</h3>
      <p class="text-sm text-gray-600 mb-3">${esc(q.staff_name)}・${q.work_date ? esc(dayjs(q.work_date).format('M/D(dd)')) : ''} ${esc(q.project_name)}</p>
      ${field}
      <label class="text-sm text-gray-600 block mb-1">スタッフへのコメント（任意）</label><textarea id="pr-note" class="inp" rows="2" maxlength="500"></textarea>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-primary flex-1" data-action="settlePayReqApproveRun" data-id="${Number(q.request_id)}">承認する</button></div>`)
  })
  delegate('settlePayReqApproveRun', el => withSubmitLock(el, async () => {
    const v = (id) => { const x = document.getElementById(id); return x ? x.value.trim() : undefined }
    try {
      await axios.post(`/api/admin/pay-requests/${Number(el.dataset.id)}/approve`, { amount: v('pr-amount'), end_time: v('pr-end'), note: v('pr-note') })
      closeModal(); toast('承認しました'); reload()
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settlePayReqReject', el => {
    const q = PAYREQ.find(x => x.request_id === Number(el.dataset.id)); if (!q) return
    modal(`<h3 class="font-bold text-gray-800 mb-1">${esc(PAY_KIND[q.kind] || q.kind)}の申請を却下</h3>
      <p class="text-sm text-gray-600 mb-3">${esc(q.staff_name)}・${q.work_date ? esc(dayjs(q.work_date).format('M/D(dd)')) : ''} ${esc(q.project_name)}</p>
      <label class="text-sm text-gray-600 block mb-1">却下の理由（スタッフに伝わります）</label><textarea id="pr-reject-note" class="inp" rows="3" maxlength="500"></textarea>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-danger flex-1" data-action="settlePayReqRejectRun" data-id="${Number(q.request_id)}">却下する</button></div>`)
  })
  delegate('settlePayReqRejectRun', el => withSubmitLock(el, async () => {
    const note = (document.getElementById('pr-reject-note') || {}).value || ''
    if (!note.trim()) return toast('却下の理由を入力してください')
    try {
      await axios.post(`/api/admin/pay-requests/${Number(el.dataset.id)}/reject`, { note })
      closeModal(); toast('却下しました'); reload()
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('settleStaffPayToggle', el => {
    const on = el.dataset.on === '1'
    if (!window.confirm(on ? 'スタッフアプリに、本人あての支払額（単価・交通費・調整・合計と、月の見込み・確定額）を表示します。よろしいですか？' : 'スタッフアプリでの支払額の表示をやめます。よろしいですか？')) return
    withSubmitLock(el, async () => {
      try { await axios.put('/api/admin/staff-pay/settings', { staff_pay_visible: on }); toast(on ? '支払額を表示するようにしました' : '支払額の表示をやめました'); loadPayRequests() } catch (e) { toast(errMsg(e)) }
    })
  })
})()
